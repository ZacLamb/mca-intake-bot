// LEARNING: pulls conversations from the GHL sub-account, finds the ones that ended with
// statements/app received ("wins"), and distills them into a playbook the bot follows.
// Runs nightly (incremental) and on demand from the dashboard.
const cfg = require('./config');
const db = require('./db');
const ghl = require('./ghl');
const { callText } = require('./claude');
const { anonymize } = require('./redact');

let running = false;
const isRunning = () => running;

const DOC_EXT = /\.(pdf|jpe?g|png|heic|tiff?)(\?|$)/i;
const hasDocs = (m) => (m.attachments || []).some((a) => DOC_EXT.test(String(a)) || /storage|msgsndr|leadconnector/i.test(String(a)));

// ---------- Step 1: sync conversations + messages from EVERY account into Postgres ----------
async function sync({ full = false } = {}) {
  const totals = { seen: 0, wins: 0, accounts: {} };
  for (const acct of cfg.accounts) {
    const r = await syncAccount(acct, { full });
    totals.seen += r.seen;
    totals.wins += r.wins;
    totals.accounts[acct.name] = r;
  }
  return totals;
}

async function syncAccount(acct, { full }) {
  const settingKey = `last_sync_at_${acct.locationId}`;
  const lastRun = full ? null : await db.getSetting(settingKey);
  const since = lastRun ? new Date(lastRun).getTime() : Date.now() - cfg.mineDaysBack * 864e5;
  const botContacts = new Set((await db.q('select contact_id from leads')).rows.map((r) => r.contact_id));

  let startAfterDate;
  let seen = 0;
  let wins = 0;
  outer: while (seen < cfg.mineMaxConversations) {
    const r = await ghl.searchConversations(acct, { startAfterDate, limit: 100 });
    const convs = r.conversations || [];
    if (!convs.length) break;

    for (const c of convs) {
      if (c.lastMessageDate && c.lastMessageDate < since) break outer;
      seen++;
      const msgs = (await ghl.getAllMessages(acct, c.id, 300)).filter((m) => ghl.CHAT_TYPES.has(m.messageType));
      if (!msgs.length) continue;

      const tags = (c.tags || []).map((t) => String(t).toLowerCase());
      const inboundDocs = msgs.some((m) => m.direction === 'inbound' && hasDocs(m));
      const isWin = inboundDocs || acct.winTags.some((t) => tags.includes(t));
      if (isWin) wins++;

      for (const m of msgs) {
        await db.q(
          `insert into messages(id,conversation_id,contact_id,direction,type,body,attachments,user_id,created_at,location_id)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(id) do nothing`,
          [m.id, c.id, c.contactId, m.direction, m.messageType, m.body || '', JSON.stringify(m.attachments || []), m.userId || null, m.dateAdded, acct.locationId]
        );
      }
      await db.q(
        `insert into conversations(id,contact_id,channel,last_message_at,is_win,bot_involved,message_count,location_id)
         values($1,$2,$3,to_timestamp($4/1000.0),$5,$6,$7,$8)
         on conflict(id) do update set last_message_at=excluded.last_message_at, is_win=excluded.is_win,
           bot_involved=excluded.bot_involved, message_count=excluded.message_count, mined_at=null, updated_at=now()`,
        [c.id, c.contactId, c.lastMessageType || '', c.lastMessageDate || Date.now(), isWin, botContacts.has(c.contactId), msgs.length, acct.locationId]
      );
    }
    startAfterDate = convs[convs.length - 1].lastMessageDate;
    if (!startAfterDate) break;
  }
  await db.setSetting(settingKey, new Date().toISOString());
  return { seen, wins };
}

// ---------- Step 2: turn transcripts into lessons ----------
async function transcript(convId, maxMsgs = 40) {
  const r = await db.q('select direction, body, attachments from messages where conversation_id=$1 order by created_at', [convId]);
  return r.rows
    .slice(0, maxMsgs)
    .map((m) => {
      const who = m.direction === 'inbound' ? 'MERCHANT' : 'REP';
      const att = (m.attachments || []).length ? ` [sent ${m.attachments.length} file(s)]` : '';
      return `${who}: ${anonymize(m.body).slice(0, 600)}${att}`;
    })
    .filter((l) => l.length > 10)
    .join('\n');
}

const EXTRACT_SYSTEM = `You analyze sales text conversations from a merchant cash advance (MCA) brokerage.
The company's ONLY goal for these chats is getting the merchant to (1) complete a funding application and (2) send their recent business bank statements.
Extract concrete, reusable lessons. Quote short phrasing that worked (anonymized). Be specific, not generic.
Ignore and do NOT repeat anything that quotes rates, factor rates, payback amounts, approval guarantees, or timelines — those are off-limits for the bot.`;

async function extractLessons(transcripts, label) {
  const user = `Here are ${transcripts.length} ${label} conversations, separated by ===.

${transcripts.join('\n===\n')}

Return bullet-point lessons under these headings:
- Openers / first replies that got the merchant engaged
- How reps asked for the application (and what made merchants do it)
- How reps asked for bank statements (and what made merchants send them)
- Objections merchants raised → the response that worked
- Follow-up timing and nudges that revived quiet merchants
- Things that killed the deal or made merchants go silent
- Tone and length of messages`;
  return callText({ system: EXTRACT_SYSTEM, user, maxTokens: 3000 });
}

const MERGE_SYSTEM = `You maintain a playbook that an AI intake assistant for an MCA company follows in SMS/email chats.
The assistant's ONLY job is collecting the funding application and bank statements. Never include rates, pricing, approval promises, timelines, or advice outside that job.
Write in plain markdown, max ~1500 words, practical and specific.`;

async function mergePlaybook(oldPlaybook, lessons, corrections) {
  const user = `CURRENT PLAYBOOK:
${oldPlaybook || '(none yet)'}

NEW LESSONS FROM RECENT CONVERSATIONS:
${lessons.join('\n\n---\n\n') || '(none)'}

CORRECTIONS A HUMAN MADE TO THE BOT'S DRAFTS (highest priority — learn the pattern):
${corrections.map((c) => `Context: ${c.context}\nBot wrote: ${c.original}\nHuman changed to: ${c.corrected}`).join('\n\n') || '(none)'}

Produce the updated playbook with these sections:
1. Voice & tone
2. Openers that get replies
3. Getting the application (offer chat vs. link; phrasing that works)
4. Getting bank statements (phrasing, how to handle "I'll send later")
5. Objection handling (objection → response)
6. Things never to do
7. 3–5 short example exchanges (anonymized)
Keep what still holds, replace what new evidence contradicts, and drop anything off-limits.`;
  return callText({ system: MERGE_SYSTEM, user, maxTokens: 4000 });
}

async function buildPlaybook() {
  const winsQ = await db.q(
    `select id from conversations where is_win and not bot_involved and mined_at is null
     order by last_message_at desc limit 150`
  );
  const lossesQ = await db.q(
    `select c.id from conversations c where not c.is_win and not c.bot_involved and c.mined_at is null
       and exists (select 1 from messages m where m.conversation_id=c.id and m.direction='inbound')
     order by c.last_message_at desc limit 30`
  );
  const correctionsQ = await db.q('select * from corrections where not used order by created_at desc limit 50');

  const lessons = [];
  const winIds = winsQ.rows.map((r) => r.id);
  for (let i = 0; i < winIds.length; i += 25) {
    const ts = (await Promise.all(winIds.slice(i, i + 25).map((id) => transcript(id)))).filter(Boolean);
    if (ts.length) lessons.push(await extractLessons(ts, 'SUCCESSFUL (merchant sent statements / application)'));
  }
  const lossIds = lossesQ.rows.map((r) => r.id);
  if (lossIds.length) {
    const ts = (await Promise.all(lossIds.map((id) => transcript(id, 20)))).filter(Boolean);
    if (ts.length) lessons.push(await extractLessons(ts, 'UNSUCCESSFUL (merchant replied but never sent anything)'));
  }

  if (!lessons.length && !correctionsQ.rows.length) return { updated: false, reason: 'nothing new to learn' };

  const prev = await db.latestPlaybook();
  const content = await mergePlaybook(prev?.content, lessons, correctionsQ.rows);
  const version = (prev?.version || 0) + 1;
  const stats = { wins: winIds.length, losses: lossIds.length, corrections: correctionsQ.rows.length };
  await db.q('insert into playbooks(version,content,stats) values($1,$2,$3)', [version, content, JSON.stringify(stats)]);

  const all = [...winIds, ...lossIds];
  if (all.length) await db.q('update conversations set mined_at=now() where id = any($1)', [all]);
  if (correctionsQ.rows.length) await db.q('update corrections set used=true where id = any($1)', [correctionsQ.rows.map((c) => c.id)]);
  return { updated: true, version, stats };
}

async function run({ full = false } = {}) {
  if (running) return { skipped: 'already running' };
  running = true;
  try {
    if (full) await db.q('update conversations set mined_at=null');
    const s = await sync({ full });
    const p = await buildPlaybook();
    await db.logEvent(null, 'learning', JSON.stringify({ ...s, ...p }));
    return { ...s, ...p };
  } catch (e) {
    await db.logEvent(null, 'learning_error', e.message);
    throw e;
  } finally {
    running = false;
  }
}

module.exports = { run, isRunning };
