const { Pool } = require('pg');
const cfg = require('./config');

const pool = new Pool({
  connectionString: cfg.databaseUrl,
  ssl: cfg.databaseUrl && !/localhost|railway\.internal/.test(cfg.databaseUrl) ? { rejectUnauthorized: false } : false,
});

const q = (text, params) => pool.query(text, params);

async function init() {
  await q(`
    create table if not exists conversations (
      id text primary key, contact_id text, channel text, last_message_at timestamptz,
      is_win boolean default false, bot_involved boolean default false, mined_at timestamptz,
      message_count int default 0, updated_at timestamptz default now());
    create table if not exists messages (
      id text primary key, conversation_id text, contact_id text, direction text, type text,
      body text, attachments jsonb default '[]', user_id text, created_at timestamptz);
    create index if not exists messages_conv_idx on messages(conversation_id, created_at);
    create table if not exists playbooks (
      id serial primary key, version int, content text, stats jsonb, created_at timestamptz default now());
    create table if not exists leads (
      contact_id text primary key, conversation_id text, stage text default 'new', path text default 'undecided',
      fields jsonb default '{}', statements jsonb default '[]', app_complete boolean default false,
      statements_complete boolean default false, handed_off boolean default false, handoff_reason text,
      updated_at timestamptz default now());
    create table if not exists drafts (
      id serial primary key, contact_id text, conversation_id text, channel text, reply text,
      edited_reply text, status text default 'pending', reasoning text, context text,
      created_at timestamptz default now(), decided_at timestamptz);
    create table if not exists corrections (
      id serial primary key, draft_id int, original text, corrected text, context text,
      used boolean default false, created_at timestamptz default now());
    create table if not exists bot_messages (id text primary key, contact_id text, created_at timestamptz default now());
    create table if not exists settings (key text primary key, value text);
    create table if not exists events (
      id serial primary key, contact_id text, kind text, detail text, created_at timestamptz default now());
  `);
}

async function getSetting(key, fallback = null) {
  const r = await q('select value from settings where key=$1', [key]);
  return r.rows[0] ? r.rows[0].value : fallback;
}
async function setSetting(key, value) {
  await q('insert into settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value', [key, String(value)]);
}
async function logEvent(contactId, kind, detail = '') {
  await q('insert into events(contact_id,kind,detail) values($1,$2,$3)', [contactId, kind, String(detail).slice(0, 2000)]);
}

async function getLead(contactId) {
  const r = await q('select * from leads where contact_id=$1', [contactId]);
  if (r.rows[0]) return r.rows[0];
  await q('insert into leads(contact_id) values($1) on conflict do nothing', [contactId]);
  return (await q('select * from leads where contact_id=$1', [contactId])).rows[0];
}
async function saveLead(l) {
  await q(
    `update leads set conversation_id=$2, stage=$3, path=$4, fields=$5, statements=$6, app_complete=$7,
     statements_complete=$8, handed_off=$9, handoff_reason=$10, updated_at=now() where contact_id=$1`,
    [l.contact_id, l.conversation_id, l.stage, l.path, JSON.stringify(l.fields || {}), JSON.stringify(l.statements || []),
      !!l.app_complete, !!l.statements_complete, !!l.handed_off, l.handoff_reason || null]
  );
}

async function latestPlaybook() {
  const r = await q('select * from playbooks order by version desc limit 1');
  return r.rows[0] || null;
}

module.exports = { pool, q, init, getSetting, setSetting, logEvent, getLead, saveLead, latestPlaybook };
