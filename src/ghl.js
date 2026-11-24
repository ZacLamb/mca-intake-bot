// Minimal GoHighLevel API v2 client (sub-account / Private Integration token).
const crypto = require('crypto');
const cfg = require('./config');

const BASE = 'https://services.leadconnectorhq.com';
const V_CONV = '2021-04-15';
const V_DEFAULT = '2021-07-28';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ghl(method, path, { query, body, version = V_DEFAULT, raw } = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);

  for (let attempt = 0; attempt < 5; attempt++) {
    const headers = { Authorization: `Bearer ${cfg.ghlToken}`, Version: version, Accept: 'application/json' };
    if (body && !raw) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { method, headers, body: raw ? body : body ? JSON.stringify(body) : undefined });
    if (res.status === 429 || res.status >= 500) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`GHL ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
  throw new Error(`GHL ${method} ${path} kept failing (rate limit / server error)`);
}

// ---------- Conversations ----------
function searchConversations({ startAfterDate, limit = 100, contactId } = {}) {
  return ghl('GET', '/conversations/search', {
    version: V_CONV,
    query: { locationId: cfg.locationId, limit, sortBy: 'last_message_date', sort: 'desc', startAfterDate, contactId },
  });
}

async function getAllMessages(conversationId, max = 300) {
  const out = [];
  let lastMessageId;
  while (out.length < max) {
    const r = await ghl('GET', `/conversations/${conversationId}/messages`, {
      version: V_CONV,
      query: { limit: 100, lastMessageId },
    });
    const page = r.messages || {};
    const msgs = page.messages || [];
    out.push(...msgs);
    if (!page.nextPage || !msgs.length) break;
    lastMessageId = page.lastMessageId;
  }
  // oldest first
  return out.sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
}

// GHL messageType → send type
const SEND_TYPE = {
  TYPE_SMS: 'SMS', TYPE_EMAIL: 'Email', TYPE_FACEBOOK: 'FB', TYPE_INSTAGRAM: 'IG',
  TYPE_WHATSAPP: 'WhatsApp', TYPE_LIVE_CHAT: 'Live_Chat', TYPE_WEBCHAT: 'Live_Chat',
};
const CHAT_TYPES = new Set(Object.keys(SEND_TYPE));

async function sendMessage({ type = 'SMS', contactId, message, subject }) {
  const body = { type, contactId, message };
  if (type === 'Email') {
    body.subject = subject || `Your funding application — ${cfg.businessName}`;
    body.html = message.split('\n').map((l) => `<p>${l.replace(/</g, '&lt;')}</p>`).join('');
  }
  return ghl('POST', '/conversations/messages', { version: V_CONV, body });
}

// ---------- Contacts ----------
async function getContact(id) {
  const r = await ghl('GET', `/contacts/${id}`);
  return r.contact;
}
const updateContact = (id, payload) => ghl('PUT', `/contacts/${id}`, { body: payload });
const addTags = (id, tags) => ghl('POST', `/contacts/${id}/tags`, { body: { tags } });
const addNote = (id, body) => ghl('POST', `/contacts/${id}/notes`, { body: { body } });

async function getCustomFields() {
  const r = await ghl('GET', `/locations/${cfg.locationId}/customFields`);
  return r.customFields || [];
}

// Upload a file into a contact's file-upload custom field
async function uploadFileToField(contactId, fieldId, buffer, filename, mime) {
  const form = new FormData();
  form.append(`${fieldId}_${crypto.randomUUID()}`, new Blob([buffer], { type: mime }), filename);
  return ghl('POST', '/forms/upload-custom-files', {
    query: { contactId, locationId: cfg.locationId },
    body: form,
    raw: true,
  });
}

module.exports = {
  searchConversations, getAllMessages, sendMessage, getContact, updateContact, addTags, addNote,
  getCustomFields, uploadFileToField, SEND_TYPE, CHAT_TYPES,
};
