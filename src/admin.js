// Dashboard at /admin — approve drafts, flip draft/auto, view the learned playbook, run learning.
const express = require('express');
const cfg = require('./config');
const db = require('./db');
const ghl = require('./ghl');
const agent = require('./agent');
const miner = require('./miner');

const router = express.Router();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

router.use((req, res, next) => {
  const [, b64] = (req.headers.authorization || '').split(' ');
  const [, pass] = Buffer.from(b64 || '', 'base64').toString().split(':');
  if (cfg.adminPassword && pass === cfg.adminPassword) return next();
  res.set('WWW-Authenticate', 'Basic realm="intake-bot"').status(401).send('Login required');
});

const acctOf = (locationId) => cfg.account(locationId) || cfg.accounts[0];
const acctName = (locationId) => (cfg.account(locationId) || {}).name || '—';

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:0;background:#f5f6f8;color:#1b1f24}
header{background:#111827;color:#fff;padding:14px 24px;display:flex;gap:18px;align-items:center}
header a{color:#cbd5e1;text-decoration:none}main{max-width:1100px;margin:24px auto;padding:0 16px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:16px}
.row{display:flex;gap:12px;flex-wrap:wrap}.stat{flex:1;min-width:140px}.stat b{font-size:24px;display:block}
textarea{width:100%;min-height:70px;font:inherit;padding:8px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box}
button{background:#111827;color:#fff;border:0;border-radius:6px;padding:7px 14px;cursor:pointer}
button.alt{background:#e5e7eb;color:#111}pre{white-space:pre-wrap;background:#f9fafb;padding:10px;border-radius:6px;font-size:12px}
table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #eee;padding:6px;text-align:left;vertical-align:top;font-size:13px}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;background:#e0e7ff;font-size:12px}
</style></head><body><header><b>Intake Bot</b><a href="/admin">Dashboard</a><a href="/admin/leads">Leads</a>
<a href="/admin/playbook">Playbook</a><a href="/admin/fields">GHL fields</a></header><main>${body}</main></body></html>`;

router.get('/', async (req, res) => {
  const mode = await db.getSetting('mode', cfg.defaultMode);
  const enabled = (await db.getSetting('bot_enabled', 'true')) !== 'false';
  const s = (await db.q(`select count(*)::int total, count(*) filter (where app_complete)::int apps,
    count(*) filter (where statements_complete)::int stmts, count(*) filter (where stage='complete')::int done,
    count(*) filter (where handed_off)::int handoffs from leads`)).rows[0];
  const pb = await db.latestPlaybook();
  const drafts = (await db.q(`select * from drafts where status='pending' order by created_at desc limit 50`)).rows;
  const events = (await db.q('select * from events order by created_at desc limit 25')).rows;
  const pend = (await db.q(`select count(*)::int n from drafts where status in ('approved','edited')`)).rows[0].n;
  const missing = cfg.missing();

  res.send(page('Intake Bot', `
${missing.length ? `<div class="card" style="border-color:#f87171"><b>Missing variables:</b> ${missing.join(', ')}</div>` : ''}
<div class="card row">
  <div class="stat">Leads<b>${s.total}</b></div><div class="stat">Apps<b>${s.apps}</b></div>
  <div class="stat">Statements<b>${s.stmts}</b></div><div class="stat">Fully complete<b>${s.done}</b></div>
  <div class="stat">Handoffs<b>${s.handoffs}</b></div><div class="stat">Drafts approved<b>${pend}</b></div>
</div>
<div class="card row" style="align-items:center">
  <form method="post" action="/admin/settings"><input type="hidden" name="bot_enabled" value="${enabled ? 'false' : 'true'}">
    <button class="${enabled ? '' : 'alt'}">Bot is ${enabled ? 'ON — turn off' : 'OFF — turn on'}</button></form>
  <form method="post" action="/admin/settings"><input type="hidden" name="mode" value="${mode === 'auto' ? 'draft' : 'auto'}">
    <button class="alt">Mode: <b>${mode.toUpperCase()}</b> — switch to ${mode === 'auto' ? 'draft' : 'auto'}</button></form>
  <form method="post" action="/admin/mine"><button class="alt">${miner.isRunning() ? 'Learning running…' : 'Learn from new conversations'}</button></form>
  <form method="post" action="/admin/mine?full=1" onsubmit="return confirm('Re-read the whole history and rebuild the playbook?')"><button class="alt">Rebuild from full history</button></form>
  <span>Playbook: ${pb ? `v${pb.version} (${new Date(pb.created_at).toLocaleString()})` : 'not built yet'}</span>
</div>
<div class="card"><h3>Connected GHL accounts (${cfg.accounts.length})</h3><table><tr><th>#</th><th>Name</th><th>Location ID</th><th>Business name</th><th>App link</th><th>Bot replies here</th></tr>
${(await Promise.all(cfg.accounts.map(async (a) => {
    const on = (await db.getSetting(`account_enabled_${a.key}`, 'true')) !== 'false';
    return `<tr><td>${a.key}</td><td>${esc(a.name)}</td><td><code>${esc(a.locationId)}</code></td><td>${esc(a.businessName)}</td><td>${esc(a.appLinkUrl || '—')}</td>
<td>${a.learnOnly ? '<span class="pill">Learn only</span>' : `<form method="post" action="/admin/settings"><input type="hidden" name="account_key" value="${a.key}"><input type="hidden" name="account_enabled" value="${on ? 'false' : 'true'}">
<button class="${on ? '' : 'alt'}">${on ? 'ON' : 'OFF'}</button></form>`}</td></tr>`;
  }))).join('')}</table><small>Learning always reads every account; this switch only controls whether the bot replies in that account.</small></div>
<div class="card"><h3>Drafts waiting for approval (${drafts.length})</h3>
${drafts.map((d) => `<div class="card"><div class="pill">${esc(acctName(d.location_id))}</div> <div class="pill">${esc(d.channel)}</div> contact <code>${esc(d.contact_id)}</code> · ${new Date(d.created_at).toLocaleString()}
<pre>${esc(d.context)}</pre><small>Bot note: ${esc(d.reasoning)}</small>
<form method="post" action="/admin/drafts/${d.id}/approve"><textarea name="reply">${esc(d.reply)}</textarea>
<button>Send</button> <button class="alt" formaction="/admin/drafts/${d.id}/reject">Reject</button></form></div>`).join('') || '<p>Nothing waiting.</p>'}
<small>Edit a draft before sending and the bot learns from your change on the next learning run.</small></div>
<div class="card"><h3>Recent activity</h3><table>${events.map((e) => `<tr><td>${new Date(e.created_at).toLocaleString()}</td><td>${esc(e.kind)}</td><td>${esc(e.contact_id || '')}</td><td>${esc(e.detail).slice(0, 300)}</td></tr>`).join('')}</table></div>`));
});

router.post('/settings', async (req, res) => {
  if (req.body.mode) await db.setSetting('mode', req.body.mode === 'auto' ? 'auto' : 'draft');
  if (req.body.bot_enabled) await db.setSetting('bot_enabled', req.body.bot_enabled === 'true' ? 'true' : 'false');
  if (req.body.account_key && cfg.account(req.body.account_key))
    await db.setSetting(`account_enabled_${req.body.account_key}`, req.body.account_enabled === 'true' ? 'true' : 'false');
  res.redirect('/admin');
});

router.post('/drafts/:id/approve', async (req, res) => {
  const d = (await db.q(`select * from drafts where id=$1 and status='pending'`, [req.params.id])).rows[0];
  if (!d) return res.redirect('/admin');
  const text = (req.body.reply || '').trim() || d.reply;
  const edited = text !== d.reply.trim();
  try {
    await agent.send(acctOf(d.location_id), d.contact_id, d.channel, text);
    await db.q(`update drafts set status=$2, edited_reply=$3, decided_at=now() where id=$1`, [d.id, edited ? 'edited' : 'approved', edited ? text : null]);
    if (edited) await db.q('insert into corrections(draft_id,original,corrected,context) values($1,$2,$3,$4)', [d.id, d.reply, text, d.context]);
  } catch (e) {
    await db.logEvent(d.contact_id, 'send_error', e.message);
  }
  res.redirect('/admin');
});

router.post('/drafts/:id/reject', async (req, res) => {
  const d = (await db.q('select * from drafts where id=$1', [req.params.id])).rows[0];
  await db.q(`update drafts set status='rejected', decided_at=now() where id=$1`, [req.params.id]);
  if (d) await db.q('insert into corrections(draft_id,original,corrected,context) values($1,$2,$3,$4)', [d.id, d.reply, '(rejected — should not have sent this)', d.context]);
  res.redirect('/admin');
});

router.post('/mine', (req, res) => {
  miner.run({ full: req.query.full === '1' }).catch((e) => console.error('learning failed', e.message));
  res.redirect('/admin');
});

router.get('/playbook', async (req, res) => {
  const all = (await db.q('select version, stats, created_at from playbooks order by version desc limit 20')).rows;
  const pb = await db.latestPlaybook();
  res.send(page('Playbook', `<div class="card"><h3>Current playbook ${pb ? 'v' + pb.version : ''}</h3><pre>${esc(pb?.content || 'Not built yet — click "Learn from new conversations".')}</pre></div>
<div class="card"><h3>History</h3><table>${all.map((p) => `<tr><td>v${p.version}</td><td>${new Date(p.created_at).toLocaleString()}</td><td>${esc(JSON.stringify(p.stats))}</td></tr>`).join('')}</table></div>`));
});

router.get('/leads', async (req, res) => {
  const leads = (await db.q('select * from leads order by updated_at desc limit 200')).rows;
  res.send(page('Leads', `<div class="card"><table><tr><th>Account</th><th>Contact</th><th>Stage</th><th>Path</th><th>App</th><th>Statements</th><th>Handoff</th><th></th></tr>
${leads.map((l) => `<tr><td>${esc(acctName(l.location_id))}</td><td><code>${esc(l.contact_id)}</code><br><small>${esc(l.fields.business_legal_name || '')}</small></td><td>${esc(l.stage)}</td><td>${esc(l.path)}</td>
<td>${l.app_complete ? '✅' : Object.keys(l.fields).length + ' fields'}</td><td>${l.statements.length}/${cfg.statementsRequired}</td><td>${esc(l.handoff_reason || '')}</td>
<td><form method="post" action="/admin/leads/${encodeURIComponent(l.contact_id)}/reset"><button class="alt">Resume bot</button></form></td></tr>`).join('')}</table></div>`));
});

router.post('/leads/:id/reset', async (req, res) => {
  await db.q(`update leads set handed_off=false, handoff_reason=null, stage=case when stage in ('handoff','complete') then 'engaging' else stage end where contact_id=$1`, [req.params.id]);
  res.redirect('/admin/leads');
});

router.get('/fields', async (req, res) => {
  const keys = require('./appSchema').chatFields.map((f) => `<code>${f.key}</code>`).join(' ');
  const sections = await Promise.all(
    cfg.accounts.filter((a) => !a.learnOnly).map(async (a) => {
      const varName = a.key === '1' ? 'FIELD_MAP' : `FIELD_MAP_${a.key}`;
      const fileVar = a.key === '1' ? 'STATEMENT_FILE_FIELD_ID' : `STATEMENT_FILE_FIELD_ID_${a.key}`;
      try {
        const fields = await ghl.getCustomFields(a);
        return `<div class="card"><h3>${esc(a.name)} → <code>${varName}</code></h3>
<table><tr><th>Name</th><th>ID</th><th>Key</th><th>Type</th><th>Mapped as</th></tr>${fields.map((f) => `<tr><td>${esc(f.name)}</td><td><code>${esc(f.id)}</code></td><td>${esc(f.fieldKey)}</td><td>${esc(f.dataType)}</td>
<td>${esc(Object.entries(a.fieldMap).filter(([, id]) => id === f.id).map(([k]) => k).join(', ') || (f.id === a.statementFileFieldId ? fileVar : ''))}</td></tr>`).join('')}</table></div>`;
      } catch (e) {
        return `<div class="card"><h3>${esc(a.name)}</h3>Couldn't load fields: ${esc(e.message)}</div>`;
      }
    })
  );
  res.send(page('GHL fields', `<div class="card"><p>Each account has its own field IDs. Put them in <code>FIELD_MAP</code> (account 1), <code>FIELD_MAP_2</code> (account 2), e.g. <code>{"monthly_revenue":"abc123"}</code>. Bot keys: ${keys}</p></div>${sections.join('')}`));
});

module.exports = router;
