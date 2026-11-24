// TESTING GROUND at /test — chat with the bot as a pretend merchant.
// Same prompt + learned playbook as the live bot, but it never calls GHL: nothing is texted or saved to contacts.
// Corrections typed here feed the next learning run, same as draft edits.
const express = require('express');
const crypto = require('crypto');
const cfg = require('./config');
const db = require('./db');
const schema = require('./appSchema');
const { callTool } = require('./claude');
const { redactSensitive } = require('./redact');
const { systemPrompt, renderTranscript, RESPOND_TOOL } = require('./agent');
const screening = require('./screening');

const router = express.Router();

// Login: TEST_PASSWORD (or ADMIN_PASSWORD), any username
router.use((req, res, next) => {
  const [, b64] = (req.headers.authorization || '').split(' ');
  const [, pass] = Buffer.from(b64 || '', 'base64').toString().split(':');
  const ok = [process.env.TEST_PASSWORD, cfg.adminPassword].filter(Boolean);
  if (pass && ok.includes(pass)) return next();
  res.set('WWW-Authenticate', 'Basic realm="intake-bot-test"').status(401).send('Login required');
});

const liveAccount = () => cfg.accounts.find((a) => !a.learnOnly) || cfg.accounts[0] || { businessName: 'our funding team', appLinkUrl: '', statementUploadUrl: '', name: 'Test' };

async function ensureTable() {
  await db.q(`create table if not exists test_sessions (
    id text primary key, messages jsonb default '[]', lead jsonb default '{}', created_at timestamptz default now(), updated_at timestamptz default now())`);
}
let ready;
router.use((req, res, next) => (ready ||= ensureTable()).then(() => next(), next));

const newLead = () => ({ stage: 'new', path: 'undecided', fields: {}, statements: [], app_complete: false, statements_complete: false, handed_off: false });

async function load(id) {
  const r = await db.q('select * from test_sessions where id=$1', [id]);
  return r.rows[0] || null;
}
async function save(s) {
  await db.q(
    `insert into test_sessions(id,messages,lead) values($1,$2,$3)
     on conflict(id) do update set messages=excluded.messages, lead=excluded.lead, updated_at=now()`,
    [s.id, JSON.stringify(s.messages), JSON.stringify(s.lead)]
  );
}

// One bot turn — mirrors agent.handle() without any GHL calls
async function botTurn(s, { initiate = false, newFiles = 0, channel = 'SMS' } = {}) {
  const acct = liveAccount();
  const lead = s.lead;
  if (lead.handed_off) return { reply: '', note: `Bot is handed off (${lead.handoff_reason}). Reset to test again.` };
  if (lead.stage === 'complete') return { reply: '', note: 'Intake is complete — the live bot stays quiet from here.' };

  const missing = schema.required.filter((k) => !lead.fields[k]);
  const state = {
    merchant_name: lead.fields.owner_first_name || null,
    business: lead.fields.business_legal_name || null,
    application_path: lead.path,
    application_complete: lead.app_complete,
    application_fields_collected: lead.fields,
    application_required_still_missing: lead.app_complete ? [] : missing.map((k) => schema.chatFields.find((f) => f.key === k).label),
    statement_files_received: lead.statements.length,
    statements_needed: cfg.statementsRequired,
    new_files_this_turn: newFiles,
    screening_gaps: screening.enabled() && lead.path !== 'link' ? screening.gaps(lead.fields) : [],
    channel,
  };
  const playbook = (await db.latestPlaybook())?.content;
  const user = `CURRENT STATE:
${JSON.stringify(state, null, 2)}

CONVERSATION SO FAR (oldest first):
${renderTranscript(s.messages) || '(no messages yet)'}

${initiate ? 'Send the first message to start the intake.' : 'Write the next reply to the merchant.'}`;

  const out = await callTool({ system: systemPrompt(acct, { playbook, channel }), user, tool: RESPOND_TOOL });

  for (const [k, v] of Object.entries(out.extracted_fields || {})) {
    if (schema.keys.has(k) && v && String(v).trim()) lead.fields[k] = redactSensitive(String(v).trim()).slice(0, 500);
  }
  if (out.path_choice && out.path_choice !== 'undecided') lead.path = out.path_choice;
  const events = [];
  if (!lead.app_complete && schema.required.every((k) => lead.fields[k])) {
    lead.app_complete = true;
    events.push(`Tag "${cfg.appReceivedTag}" would be added + note with the application answers`);
    if (screening.enabled() && lead.path !== 'link') {
      const L = screening.labels(lead.fields);
      events.push(`Product tags that would be written: ${L.tags.join(', ')} + screening note + "Hot Lead" opportunity`);
    }
  }
  if (!lead.statements_complete && lead.statements.length >= cfg.statementsRequired) {
    lead.statements_complete = true;
    events.push(`Tag "${cfg.statementsReceivedTag}" would be added`);
  }
  lead.stage = lead.app_complete && lead.statements_complete ? 'complete' : out.stage;
  if (out.wants_human) {
    lead.handed_off = true;
    lead.handoff_reason = out.handoff_reason || 'needs a person';
    lead.stage = 'handoff';
    events.push(`Handed off to a human (tag "${cfg.handoffTag}"): ${lead.handoff_reason}`);
  }
  const reply = (out.reply || '').trim();
  if (reply) s.messages.push({ direction: 'outbound', body: reply, at: new Date().toISOString() });
  return { reply, note: out.internal_note || '', events };
}

const view = (s) => {
  const out = { id: s.id, messages: s.messages, lead: s.lead, statementsRequired: cfg.statementsRequired };
  if (screening.enabled()) {
    const L = screening.labels(s.lead.fields || {});
    out.products = { qualifies: L.qualifies, possible: L.possible, notEnoughInfo: L.notEnoughInfo, tags: L.tags, note: L.note };
  }
  return out;
};

router.post('/api/new', async (req, res) => {
  const s = { id: crypto.randomUUID(), messages: [], lead: newLead() };
  let turn = {};
  try {
    if (req.body.botStarts) turn = await botTurn(s, { initiate: true });
  } catch (e) {
    turn = { error: e.message };
  }
  await save(s);
  res.json({ ...view(s), turn });
});

router.post('/api/message', async (req, res) => {
  const s = await load(req.body.id);
  if (!s) return res.status(404).json({ error: 'session not found — start a new one' });
  const text = String(req.body.text || '').slice(0, 2000);
  const files = (Array.isArray(req.body.files) ? req.body.files : []).slice(0, 10).map((f) => String(f).slice(0, 120));
  if (!text && !files.length) return res.status(400).json({ error: 'empty message' });

  s.messages.push({ direction: 'inbound', body: text, attachments: files, at: new Date().toISOString() });
  for (const f of files) s.lead.statements.push({ url: `test://${f}`, receivedAt: new Date().toISOString() });

  let turn;
  try {
    turn = await botTurn(s, { newFiles: files.length });
  } catch (e) {
    turn = { error: e.message };
  }
  await save(s);
  res.json({ ...view(s), turn });
});

// "What the bot should have said" → becomes a correction for the next learning run
router.post('/api/correct', async (req, res) => {
  const s = await load(req.body.id);
  const idx = Number(req.body.index);
  const corrected = String(req.body.corrected || '').trim();
  if (!s || !s.messages[idx] || s.messages[idx].direction !== 'outbound' || !corrected) return res.status(400).json({ error: 'bad request' });
  const context = renderTranscript(s.messages.slice(Math.max(0, idx - 6), idx));
  await db.q('insert into corrections(original,corrected,context) values($1,$2,$3)', [s.messages[idx].body, corrected, `[test ground] ${context}`]);
  s.messages[idx].correctedTo = corrected;
  await save(s);
  res.json(view(s));
});

router.get('/', (req, res) => {
  const acct = liveAccount();
  const labels = Object.fromEntries(schema.chatFields.map((f) => [f.key, f.label]));
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intake Bot — Testing Ground</title><style>
*{box-sizing:border-box}body{margin:0;font:15px/1.45 -apple-system,system-ui,sans-serif;background:#eef1f5;color:#111827}
header{background:#111827;color:#fff;padding:12px 20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
header b{font-size:16px}header small{color:#9ca3af}header .sp{flex:1}
button{font:inherit;border:0;border-radius:8px;padding:8px 14px;cursor:pointer;background:#2563eb;color:#fff}
button.alt{background:#e5e7eb;color:#111827}button:disabled{opacity:.5;cursor:default}
.wrap{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;max-width:1150px;margin:16px auto;padding:0 12px}
@media(max-width:860px){.wrap{grid-template-columns:1fr}}
.phone{background:#fff;border:1px solid #e5e7eb;border-radius:16px;display:flex;flex-direction:column;height:calc(100vh - 110px);min-height:480px}
#log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px}
.msg{max-width:78%;padding:9px 13px;border-radius:16px;white-space:pre-wrap;word-wrap:break-word}
.in{align-self:flex-end;background:#2563eb;color:#fff;border-bottom-right-radius:4px}
.out{align-self:flex-start;background:#f1f5f9;border-bottom-left-radius:4px}
.out .fix{display:block;font-size:12px;color:#2563eb;cursor:pointer;margin-top:4px}
.out .fixed{display:block;font-size:12px;color:#047857;margin-top:4px}
.sys{align-self:center;font-size:12px;color:#6b7280;background:#fff7ed;border:1px solid #fed7aa;padding:4px 10px;border-radius:99px;max-width:90%;text-align:center}
.att{font-size:12px;opacity:.9}
form{display:flex;gap:8px;padding:12px;border-top:1px solid #e5e7eb;align-items:center}
form input[type=text]{flex:1;padding:10px 12px;border:1px solid #d1d5db;border-radius:99px;font:inherit}
label.file{font-size:13px;color:#2563eb;cursor:pointer;white-space:nowrap}
.side{display:flex;flex-direction:column;gap:12px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:14px}
.card h3{margin:0 0 8px;font-size:14px}
.kv{display:flex;justify-content:space-between;gap:8px;font-size:13px;padding:3px 0;border-bottom:1px dashed #eee}
.kv span:first-child{color:#6b7280}.kv span:last-child{text-align:right}
.pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;background:#e0e7ff}
.ok{background:#d1fae5}.warn{background:#fee2e2}
.typing{align-self:flex-start;color:#9ca3af;font-size:13px}
.note{font-size:12px;color:#6b7280}
</style></head><body>
<header><b>Intake Bot — Testing Ground</b><small>You're the merchant. Nothing here is texted or saved to GHL.</small><span class="sp"></span>
<button class="alt" onclick="start(false)">New chat (I text first)</button><button onclick="start(true)">New chat (bot texts first)</button></header>
<div class="wrap">
 <div class="phone"><div id="log"></div>
  <form id="f"><label class="file">📎 Attach statement<input type="file" id="file" multiple hidden accept=".pdf,image/*"></label>
  <input type="text" id="t" placeholder="Text the bot like a merchant would…" autocomplete="off"><button id="send">Send</button></form>
  <div class="note" id="pending" style="padding:0 14px 8px"></div>
 </div>
 <div class="side">
  <div class="card"><h3>Progress</h3><div id="prog"></div></div>
  <div class="card"><h3>Application answers collected</h3><div id="fields"></div></div>
  <div class="card"><h3>Product labels (AFE product guide)</h3><div id="products" class="note">—</div></div>
  <div class="card"><h3>Bot's internal note (last turn)</h3><div id="botnote" class="note">—</div></div>
  <div class="card note">Bot speaks as <b>${(acct.businessName || '').replace(/</g, '&lt;')}</b>${acct.appLinkUrl ? ` · app link ${acct.appLinkUrl.replace(/</g, '&lt;')}` : ''}. Click <b>"Fix this reply"</b> under any bot message to write what it should have said; the bot learns it on the next learning run.</div>
 </div>
</div>
<script>
const LABELS=${JSON.stringify(labels)};
let S=null, pendingFiles=[];
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function api(p,b){const r=await fetch('/test/api/'+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});return r.json();}
function render(turn){
  const log=$('log');log.innerHTML='';
  if(!S){log.innerHTML='<div class="sys">Start a new chat above.</div>';return;}
  S.messages.forEach((m,i)=>{
    const d=document.createElement('div');d.className='msg '+(m.direction==='inbound'?'in':'out');
    let h=esc(m.body);
    if(m.attachments&&m.attachments.length)h+=(h?'\\n':'')+'<span class="att">📎 '+m.attachments.map(esc).join(', ')+'</span>';
    if(m.direction==='outbound')h+=m.correctedTo?'<span class="fixed">✓ Corrected: '+esc(m.correctedTo)+'</span>':'<span class="fix" data-i="'+i+'">Fix this reply</span>';
    d.innerHTML=h;log.appendChild(d);
  });
  (turn&&turn.events||[]).forEach(e=>{const d=document.createElement('div');d.className='sys';d.textContent=e;log.appendChild(d);});
  if(turn&&turn.error){const d=document.createElement('div');d.className='sys';d.textContent='Error: '+turn.error;log.appendChild(d);}
  if(turn&&!turn.reply&&!turn.error&&turn.note&&S.messages.length){const d=document.createElement('div');d.className='sys';d.textContent='(no reply) '+turn.note;log.appendChild(d);}
  log.scrollTop=log.scrollHeight;
  const L=S.lead;
  $('prog').innerHTML=
   '<div class="kv"><span>Stage</span><span class="pill">'+esc(L.stage)+'</span></div>'+
   '<div class="kv"><span>Application path</span><span>'+esc(L.path)+'</span></div>'+
   '<div class="kv"><span>Application</span><span class="pill '+(L.app_complete?'ok':'')+'">'+(L.app_complete?'Complete':'In progress')+'</span></div>'+
   '<div class="kv"><span>Statements</span><span class="pill '+(L.statements_complete?'ok':'')+'">'+L.statements.length+' / '+S.statementsRequired+'</span></div>'+
   (L.handed_off?'<div class="kv"><span>Handed off</span><span class="pill warn">'+esc(L.handoff_reason)+'</span></div>':'');
  const ks=Object.keys(L.fields).filter(k=>k[0]!=='_');
  if(S.products){const P=S.products,row=(t,a,c)=>a.length?'<div class="kv"><span>'+t+'</span><span>'+a.map(x=>'<span class="pill '+c+'">'+esc(x)+'</span>').join(' ')+'</span></div>':'';
    $('products').innerHTML=(row('Qualifies',P.qualifies,'ok')+row('Possible',P.possible,'')+row('Need more info',P.notEnoughInfo,'warn'))+
    '<details style="margin-top:6px"><summary>Full screening note (posted to the contact)</summary><pre style="white-space:pre-wrap;font-size:11px">'+esc(P.note)+'</pre></details>'+
    '<div class="note" style="margin-top:6px">Internal only — the bot never tells the merchant what they qualify for.</div>';}
  $('fields').innerHTML=ks.length?ks.map(k=>'<div class="kv"><span>'+esc(LABELS[k]||k)+'</span><span>'+esc(L.fields[k])+'</span></div>').join(''):'<div class="note">Nothing yet.</div>';
  if(turn&&turn.note!==undefined)$('botnote').textContent=turn.note||'—';
}
function busy(b){$('send').disabled=b;if(b){const d=document.createElement('div');d.className='typing';d.id='typing';d.textContent='Bot is typing…';$('log').appendChild(d);$('log').scrollTop=1e9;}}
async function start(botStarts){busy(true);const r=await api('new',{botStarts});S=r;localStorage.setItem('tg',S.id);render(r.turn);busy(false);$('t').focus();}
$('file').onchange=e=>{pendingFiles=[...e.target.files].map(f=>f.name);$('pending').textContent=pendingFiles.length?'Attached: '+pendingFiles.join(', ')+' (only the file name is used)':'';};
$('f').onsubmit=async e=>{e.preventDefault();if(!S)await start(false);const text=$('t').value.trim();if(!text&&!pendingFiles.length)return;
  S.messages.push({direction:'inbound',body:text,attachments:pendingFiles});render();busy(true);
  const files=pendingFiles;pendingFiles=[];$('pending').textContent='';$('file').value='';$('t').value='';
  const r=await api('message',{id:S.id,text,files});if(r.error&&!r.messages){alert(r.error);busy(false);return;}S=r;render(r.turn);busy(false);$('t').focus();};
$('log').onclick=async e=>{const i=e.target.dataset&&e.target.dataset.i;if(i===undefined)return;
  const c=prompt('What should the bot have said instead?',S.messages[i].body);if(!c||c.trim()===S.messages[i].body)return;
  S=await api('correct',{id:S.id,index:Number(i),corrected:c});render();};
render();
</script></body></html>`);
});

module.exports = router;
