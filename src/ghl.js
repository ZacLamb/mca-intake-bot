// Minimal GoHighLevel API v2 client. Every call takes the account it runs against.
const crypto = require('crypto');

const BASE = 'https://services.leadconnectorhq.com';
const V_CONV = '2021-04-15';
const V_DEFAULT = '2021-07-28';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ghl(acct, method, path, { query, body, version = V_DEFAULT, raw } = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);

  for (let attempt = 0; attempt < 5; attempt++) {
    const headers = { Authorization: `Bearer ${acct.token}`, Version: version, Accept: 'application/json' };
    if (body && !raw) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { method, headers, body: raw ? body : body ? JSON.stringify(body) : undefined });
    if (res.status === 429 || res.status >= 500) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`GHL [${acct.name}] ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
  throw new Error(`GHL [${acct.name}] ${method} ${path} kept failing (rate limit / server error)`);
}

// ---------- Conversations ----------
function searchConversations(acct, { startAfterDate, limit = 100, contactId } = {}) {
  return ghl(acct, 'GET', '/conversations/search', {
    version: V_CONV,
    query: { locationId: acct.locationId, limit, sortBy: 'last_message_date', sort: 'desc', startAfterDate, contactId },
  });
}

async function getAllMessages(acct, conversationId, max = 300) {
  const out = [];
  let lastMessageId;
  while (out.length < max) {
    const r = await ghl(acct, 'GET', `/conversations/${conversationId}/messages`, {
      version: V_CONV,
      query: { limit: 100, lastMessageId },
    });
    const page = r.messages || {};
    const msgs = page.messages || [];
    out.push(...msgs);
    if (!page.nextPage || !msgs.length) break;
    lastMessageId = page.lastMessageId;
  }
  return out.sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded)); // oldest first
}

// GHL messageType → send type
const SEND_TYPE = {
  TYPE_SMS: 'SMS', TYPE_EMAIL: 'Email', TYPE_FACEBOOK: 'FB', TYPE_INSTAGRAM: 'IG',
  TYPE_WHATSAPP: 'WhatsApp', TYPE_LIVE_CHAT: 'Live_Chat', TYPE_WEBCHAT: 'Live_Chat',
};
const CHAT_TYPES = new Set(Object.keys(SEND_TYPE));

async function sendMessage(acct, { type = 'SMS', contactId, message, subject }) {
  const body = { type, contactId, message };
  if (type === 'Email') {
    body.subject = subject || `Your funding application — ${acct.businessName}`;
    body.html = message.split('\n').map((l) => `<p>${l.replace(/</g, '&lt;')}</p>`).join('');
  }
  return ghl(acct, 'POST', '/conversations/messages', { version: V_CONV, body });
}

// ---------- Contacts ----------
async function getContact(acct, id) {
  const r = await ghl(acct, 'GET', `/contacts/${id}`);
  return r.contact;
}
const updateContact = (acct, id, payload) => ghl(acct, 'PUT', `/contacts/${id}`, { body: payload });
const addTags = (acct, id, tags) => ghl(acct, 'POST', `/contacts/${id}/tags`, { body: { tags } });
const addNote = (acct, id, body) => ghl(acct, 'POST', `/contacts/${id}/notes`, { body: { body } });
const removeTags = (acct, id, tags) => (tags.length ? ghl(acct, 'DELETE', `/contacts/${id}/tags`, { body: { tags } }) : null);

// ---------- Pipelines & opportunities ----------
const pipelineCache = new Map();
async function pipelines(acct) {
  const hit = pipelineCache.get(acct.locationId);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.list;
  const r = await ghl(acct, 'GET', '/opportunities/pipelines', { query: { locationId: acct.locationId } });
  pipelineCache.set(acct.locationId, { at: Date.now(), list: r.pipelines || [] });
  return r.pipelines || [];
}
async function findStage(acct, pipelineName, stageName) {
  const norm = (x) => String(x || '').trim().toLowerCase();
  const p = (await pipelines(acct)).find((x) => norm(x.name) === norm(pipelineName));
  if (!p) throw new Error(`Pipeline "${pipelineName}" not found in ${acct.name}`);
  const st = (stageName && (p.stages || []).find((x) => norm(x.name) === norm(stageName))) || (p.stages || [])[0];
  if (!st) throw new Error(`Pipeline "${pipelineName}" has no stages`);
  return { pipelineId: p.id, stageId: st.id };
}
async function contactOpportunities(acct, contactId, pipelineId) {
  const r = await ghl(acct, 'GET', '/opportunities/search', {
    query: { location_id: acct.locationId, contact_id: contactId, pipeline_id: pipelineId, limit: 100 },
  });
  return r.opportunities || [];
}
// Every opportunity in the account (paged), for learning which contacts became real deals
async function allOpportunities(acct, max = 20000) {
  const out = [];
  for (let page = 1; out.length < max; page++) {
    const r = await ghl(acct, 'GET', '/opportunities/search', { query: { location_id: acct.locationId, limit: 100, page } });
    const list = r.opportunities || [];
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}
const createOpportunity = (acct, o) => ghl(acct, 'POST', '/opportunities/', { body: { status: 'open', ...o } });

async function getCustomFields(acct) {
  const r = await ghl(acct, 'GET', `/locations/${acct.locationId}/customFields`);
  return r.customFields || [];
}

// Upload a file into a contact's file-upload custom field
async function uploadFileToField(acct, contactId, fieldId, buffer, filename, mime) {
  const form = new FormData();
  form.append(`${fieldId}_${crypto.randomUUID()}`, new Blob([buffer], { type: mime }), filename);
  return ghl(acct, 'POST', '/forms/upload-custom-files', {
    query: { contactId, locationId: acct.locationId },
    body: form,
    raw: true,
  });
}

module.exports = {
  searchConversations, getAllMessages, sendMessage, getContact, updateContact, addTags, removeTags, addNote,
  getCustomFields, uploadFileToField, findStage, contactOpportunities, createOpportunity, allOpportunities, pipelines, SEND_TYPE, CHAT_TYPES,
};
