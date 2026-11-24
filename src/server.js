const express = require('express');
const cron = require('node-cron');
const cfg = require('./config');
const db = require('./db');
const agent = require('./agent');
const miner = require('./miner');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.json({ ok: true, service: 'mca-intake-bot', missing: cfg.missing() }));

const authorized = (req) =>
  cfg.webhookSecret && (req.query.secret === cfg.webhookSecret || req.headers['x-webhook-secret'] === cfg.webhookSecret);

// Works with a GHL workflow "Webhook" action (contact_id) or a marketplace InboundMessage event (contactId)
const contactIdFrom = (b) => b.contact_id || b.contactId || b.contact?.id || b.customData?.contact_id;

// Which GHL account sent this? Workflow webhooks include location.id; ?account=2 also works.
const accountFrom = (req) => {
  const b = req.body || {};
  const id = b.location?.id || b.locationId || b.location_id || req.query.account || req.query.locationId;
  const live = cfg.accounts.filter((a) => !a.learnOnly);
  return cfg.account(id) || (live.length === 1 ? live[0] : null);
};

function intake(initiate) {
  return (req, res) => {
    if (!authorized(req)) return res.status(401).json({ error: 'bad secret' });
    const contactId = contactIdFrom(req.body || {});
    if (!contactId) return res.status(400).json({ error: 'no contact id in payload' });
    const acct = accountFrom(req);
    if (!acct) return res.status(400).json({ error: 'unknown GHL account (location id not configured)' });
    if (acct.learnOnly) return res.json({ ignored: `${acct.name} is learn-only` });
    if (!initiate && req.body.direction === 'outbound') return res.json({ ignored: 'outbound' });
    agent.schedule(acct, contactId, { initiate });
    res.json({ queued: contactId, account: acct.name });
  };
}

// GHL workflow: trigger "Customer Replied" → Webhook → POST /webhook/inbound?secret=...
app.post('/webhook/inbound', intake(false));
// Optional: have the bot send the FIRST message (e.g. new lead workflow) → POST /webhook/start?secret=...
app.post('/webhook/start', intake(true));

app.use('/admin', require('./admin'));
app.use('/test', require('./testground'));

(async () => {
  const missing = cfg.missing();
  if (missing.length) console.warn('⚠️  Missing env vars:', missing.join(', '));
  if (cfg.databaseUrl) {
    await db.init();
    cron.schedule(cfg.mineCron, () => miner.run().catch((e) => console.error('nightly learning failed', e.message)), {
      timezone: cfg.timezone,
    });
  }
  app.listen(cfg.port, () => console.log(`Intake bot listening on ${cfg.port}`));
})();
