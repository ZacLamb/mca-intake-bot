// End-to-end flow with GHL and Claude mocked, across TWO accounts. Needs DATABASE_URL to a scratch Postgres.
process.env.REPLY_DELAY_SECONDS = '0';
process.env.STATEMENTS_REQUIRED = '2';
process.env.GHL_API_KEY = 'tokA'; process.env.GHL_LOCATION_ID = 'locA'; process.env.ACCOUNT_NAME = 'Acct A';
process.env.GHL_API_KEY_2 = 'tokB'; process.env.GHL_LOCATION_ID_2 = 'locB'; process.env.ACCOUNT_NAME_2 = 'Acct B';
process.env.BUSINESS_NAME_2 = 'Bravo Capital';
const assert = require('assert');
const path = require('path');
const stub = (mod, exp) => { const p = require.resolve(path.join(__dirname, '../src', mod)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };

const sent = []; const tagsAdded = []; const updates = []; const notes = []; const removed = []; const opps = [];
let messages = [];
const ghlMock = {
  SEND_TYPE: { TYPE_SMS: 'SMS' }, CHAT_TYPES: new Set(['TYPE_SMS']),
  getContact: async (a) => ({ id: 'c1', firstName: 'Joe', tags: [] }),
  searchConversations: async (a, { contactId }) => ({ conversations: [{ id: 'conv-' + a.key, contactId: 'c1', lastMessageDate: Date.now(), tags: [] }] }),
  getAllMessages: async () => messages,
  sendMessage: async (a, m) => { sent.push({ acct: a.key, ...m }); return { messageId: 'bot' + sent.length }; },
  updateContact: async (a, id, p) => updates.push({ acct: a.key, ...p }),
  addTags: async (a, id, t) => tagsAdded.push(...t),
  addNote: async (a, id, n) => notes.push(n),
  uploadFileToField: async () => ({}),
  removeTags: async (a, id, t) => removed.push(...t),
  findStage: async () => ({ pipelineId: 'pipe1', stageId: 'hot' }),
  contactOpportunities: async () => opps,
  createOpportunity: async (a, o) => { opps.push(o); return { opportunity: { id: 'opp' + opps.length } }; },
};
stub('ghl', ghlMock);
const replies = []; const systems = [];
stub('claude', {
  callTool: async ({ system, user }) => {
    systems.push(system);
    assert(system.includes('ONLY JOB'));
    assert(!user.includes('123-45-6789'), 'SSN leaked to Claude');
    return replies.shift();
  },
  callText: async ({ user }) => 'PLAYBOOK: ask for statements early.\n' + user.slice(0, 50),
});

const cfg = require('../src/config');
const db = require('../src/db');
const agent = require('../src/agent');
const miner = require('../src/miner');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  assert.equal(cfg.accounts.length, 2, 'two accounts loaded');
  const A = cfg.account('locA'); const B = cfg.account('2');
  assert.equal(B.businessName, 'Bravo Capital');

  await db.init();
  await db.q('truncate leads, drafts, corrections, bot_messages, settings, events, messages, conversations, playbooks restart identity');

  // Turn 1 in account A (draft mode default)
  messages = [{ id: 'm1', direction: 'inbound', messageType: 'TYPE_SMS', body: 'hi im Joe Smith, Acme Plumbing LLC, ssn 123-45-6789', dateAdded: new Date().toISOString() }];
  replies.push({ reply: 'Thanks Joe! Chat or online app?', extracted_fields: { business_legal_name: 'Acme Plumbing LLC', owner_first_name: 'Joe', owner_last_name: 'Smith', ssn: '123-45-6789' }, path_choice: 'undecided', wants_human: false, stage: 'choosing_path', internal_note: 'got name' });
  agent.schedule(A, 'c1'); await wait(300);
  const d = (await db.q("select * from drafts where status='pending'")).rows;
  assert.equal(d.length, 1); assert.equal(d[0].location_id, 'locA'); assert.equal(sent.length, 0);
  let lead = (await db.q('select * from leads')).rows[0];
  assert(!lead.fields.ssn); assert.equal(lead.location_id, 'locA');

  // Turn 2 in account B (auto) — must use B's name + B's token
  await db.setSetting('mode', 'auto');
  await db.q('truncate leads');
  messages.push({ id: 'm2', direction: 'inbound', messageType: 'TYPE_SMS', body: 'here', attachments: ['https://storage.example/a.pdf', 'https://storage.example/b.pdf'], dateAdded: new Date().toISOString() });
  replies.push({ reply: 'Got both statements — a specialist will reach out!', extracted_fields: { business_legal_name: 'Acme', business_address: '1 Main St', business_start_date: '2019-03', industry: 'plumbing', owner_first_name: 'Joe', owner_last_name: 'Smith', owner_email: 'joe@acme.com', monthly_revenue: '60000', amount_requested: '50000', open_positions: 'none', use_of_funds: 'payroll', credit_score: '680-720', homeowner: 'yes' }, path_choice: 'chat', wants_human: false, stage: 'complete', internal_note: 'done' });
  agent.schedule(B, 'c1'); await wait(300);
  assert(systems[systems.length - 1].includes('Bravo Capital'), 'account B business name used');
  assert.equal(sent[0].acct, '2', 'sent through account B');
  lead = (await db.q('select * from leads')).rows[0];
  assert(lead.app_complete && lead.statements_complete && lead.location_id === 'locB');
  // Product labels — same tags the AFE tagger writes
  for (const t of ['qualifies - mca', 'qualifies - business line of credit', 'qualifies - term loan', 'qualifies - sba loan', 'qualifies - heloc', 'afe screened'])
    assert(tagsAdded.includes(t), 'missing product tag ' + t + ' in ' + tagsAdded.join(','));
  assert(!tagsAdded.includes('qualifies - mca reverse'), 'no open positions → no MCA Reverse');
  assert(!tagsAdded.includes('qualifies - none'));
  assert(notes.some((n) => n.startsWith('PRODUCT SCREENING')), 'screening note posted');
  assert.equal(opps.length, 1); assert(/Acme – Application/.test(opps[0].name)); assert.equal(opps[0].pipelineStageId, 'hot');
  assert(systems[systems.length - 1].includes('E.A.S.Y.') && systems[systems.length - 1].includes('PRODUCT QUESTIONS'), 'sales method + product questions in prompt');
  assert(!/\$\{STATEMENTS\}/.test(systems[systems.length - 1]), 'statement count substituted');

  // Account switch-off stops replies in that account only
  await db.q('truncate leads');
  await db.setSetting('account_enabled_2', 'false');
  replies.push({ reply: 'hi', extracted_fields: {}, path_choice: 'undecided', wants_human: false, stage: 'engaging', internal_note: '' });
  agent.schedule(B, 'c1'); await wait(300);
  assert.equal(sent.length, 1, 'account B disabled → no reply');
  agent.schedule(A, 'c1'); await wait(300);
  assert.equal(sent.length, 2, 'account A still replies'); assert.equal(sent[1].acct, '1');

  // Learning pulls from BOTH accounts into one playbook
  ghlMock.searchConversations = async (a, { startAfterDate }) =>
    startAfterDate ? { conversations: [] } : { conversations: [{ id: 'old-' + a.key, contactId: 'z' + a.key, lastMessageDate: Date.now(), tags: [] }] };
  ghlMock.getAllMessages = async (a) => [
    { id: 'o1-' + a.key, direction: 'outbound', messageType: 'TYPE_SMS', body: 'Can you send 4 months of statements?', dateAdded: new Date().toISOString() },
    { id: 'o2-' + a.key, direction: 'inbound', messageType: 'TYPE_SMS', body: 'sure', attachments: ['https://x/s.pdf'], dateAdded: new Date().toISOString() },
  ];
  // A contact with no files but a Funded opportunity also counts as a win
  ghlMock.pipelines = async () => [{ id: 'p', name: 'Deals', stages: [{ id: 's1', name: 'New' }, { id: 's2', name: 'Funded' }] }];
  ghlMock.allOpportunities = async (a) => (a.key === '1' ? [{ contactId: 'zz', pipelineStageId: 's2' }, { contactId: 'z1', pipelineStageId: 's1' }] : []);
  const r = await miner.run();
  assert(r.updated && r.wins === 2 && r.accounts['Acct A'].wins === 1 && r.accounts['Acct B'].wins === 1, JSON.stringify(r));
  const locs = (await db.q('select distinct location_id from conversations order by 1')).rows.map((x) => x.location_id);
  assert.deepEqual(locs, ['locA', 'locB']);

  // Learn-only account never messages
  B.learnOnly = true;
  await db.setSetting('account_enabled_2', 'true');
  await db.q('truncate leads');
  const before = sent.length;
  agent.schedule(B, 'c1'); await wait(300);
  assert.equal(sent.length, before, 'learn-only account never replies');
  await assert.rejects(() => agent.send(B, 'c1', 'SMS', 'hi'), /learn-only/);

  console.log('flow tests passed (2 accounts)');
  await db.pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
