// End-to-end flow with GHL and Claude mocked. Needs DATABASE_URL to a scratch Postgres.
process.env.REPLY_DELAY_SECONDS = '0';
process.env.STATEMENTS_REQUIRED = '2';
const assert = require('assert');
const path = require('path');
const stub = (mod, exp) => { const p = require.resolve(path.join(__dirname, '../src', mod)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };

const sent = []; const tagsAdded = []; const updates = []; const notes = [];
let messages = [];
const realGhl = { SEND_TYPE: { TYPE_SMS: 'SMS' }, CHAT_TYPES: new Set(['TYPE_SMS']) };
stub('ghl', {
  ...realGhl,
  getContact: async () => ({ id: 'c1', firstName: 'Joe', tags: [] }),
  searchConversations: async ({ contactId }) => ({ conversations: [{ id: 'conv1', contactId: 'c1', lastMessageDate: Date.now(), tags: [] }] }),
  getAllMessages: async () => messages,
  sendMessage: async (m) => { sent.push(m); return { messageId: 'bot' + sent.length }; },
  updateContact: async (id, p) => updates.push(p),
  addTags: async (id, t) => tagsAdded.push(...t),
  addNote: async (id, n) => notes.push(n),
  uploadFileToField: async () => ({}),
});
const replies = [];
stub('claude', {
  callTool: async ({ system, user }) => {
    assert(system.includes('ONLY JOB'));
    assert(!user.includes('123-45-6789'), 'SSN leaked to Claude');
    return replies.shift();
  },
  callText: async ({ user }) => 'PLAYBOOK: ask for statements early.\n' + user.slice(0, 50),
});

const db = require('../src/db');
const agent = require('../src/agent');
const miner = require('../src/miner');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await db.init();
  await db.q('truncate leads, drafts, corrections, bot_messages, settings, events, messages, conversations, playbooks restart identity');

  // Turn 1 (draft mode default): merchant gives info + accidentally an SSN
  messages = [{ id: 'm1', direction: 'inbound', messageType: 'TYPE_SMS', body: 'hi im Joe Smith, Acme Plumbing LLC, ssn 123-45-6789', dateAdded: new Date().toISOString() }];
  replies.push({ reply: 'Thanks Joe! Quick q: chat or online app?', extracted_fields: { business_legal_name: 'Acme Plumbing LLC', owner_first_name: 'Joe', owner_last_name: 'Smith', ssn: '123-45-6789' }, path_choice: 'undecided', wants_human: false, stage: 'choosing_path', internal_note: 'got name' });
  agent.schedule('c1'); await wait(300);
  let d = (await db.q("select * from drafts where status='pending'")).rows;
  assert.equal(d.length, 1, 'draft created'); assert.equal(sent.length, 0, 'nothing sent in draft mode');
  let lead = (await db.q('select * from leads')).rows[0];
  assert(!lead.fields.ssn, 'unknown key ssn must be dropped');
  assert.equal(updates[0].companyName, 'Acme Plumbing LLC');

  // Turn 2 (auto): sends all required fields + 2 statements → complete
  await db.setSetting('mode', 'auto');
  messages.push({ id: 'm2', direction: 'inbound', messageType: 'TYPE_SMS', body: 'here', attachments: ['https://storage.example/a.pdf', 'https://storage.example/b.pdf'], dateAdded: new Date().toISOString() });
  replies.push({ reply: 'Got both statements and your info — a specialist will reach out!', extracted_fields: { business_address: '1 Main St', business_start_date: '2019-03', industry: 'plumbing', owner_email: 'joe@acme.com', monthly_revenue: '60000', amount_requested: '50000', open_positions: 'none' }, path_choice: 'chat', wants_human: false, stage: 'complete', internal_note: 'done' });
  agent.schedule('c1'); await wait(300);
  lead = (await db.q('select * from leads')).rows[0];
  assert(lead.app_complete && lead.statements_complete && lead.stage === 'complete');
  assert(tagsAdded.includes('app-received') && tagsAdded.includes('statements-received'));
  assert.equal(sent.length, 1);

  // Turn 3: complete → bot stays quiet
  messages.push({ id: 'm3', direction: 'inbound', messageType: 'TYPE_SMS', body: 'so what rate?', dateAdded: new Date().toISOString() });
  agent.schedule('c1'); await wait(300);
  assert.equal(sent.length, 1, 'no more replies after complete');

  // Human takeover pauses bot for a different lead
  await db.q("update leads set stage='engaging', app_complete=false where contact_id='c1'");
  messages.push({ id: 'h1', direction: 'outbound', userId: 'rep1', messageType: 'TYPE_SMS', body: 'Hey Joe its Mike', dateAdded: new Date().toISOString() });
  messages.push({ id: 'm4', direction: 'inbound', messageType: 'TYPE_SMS', body: 'hi mike', dateAdded: new Date().toISOString() });
  agent.schedule('c1'); await wait(300);
  assert.equal(sent.length, 1, 'bot stays out when a human rep is active');

  // Learning: miner syncs + builds playbook
  require.cache[require.resolve('../src/ghl')].exports.searchConversations = async ({ startAfterDate }) =>
    startAfterDate ? { conversations: [] } : { conversations: [{ id: 'old1', contactId: 'z9', lastMessageDate: Date.now(), tags: [] }] };
  require.cache[require.resolve('../src/ghl')].exports.getAllMessages = async () => [
    { id: 'o1', direction: 'outbound', messageType: 'TYPE_SMS', body: 'Can you send 4 months of statements?', dateAdded: new Date().toISOString() },
    { id: 'o2', direction: 'inbound', messageType: 'TYPE_SMS', body: 'sure', attachments: ['https://x/s.pdf'], dateAdded: new Date().toISOString() },
  ];
  const r = await miner.run();
  assert(r.updated && r.wins === 1, JSON.stringify(r));
  assert((await db.latestPlaybook()).content.startsWith('PLAYBOOK'));

  console.log('flow tests passed');
  await db.pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
