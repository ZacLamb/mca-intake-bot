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

// GHL workflow: trigger "Customer Replied" → Webhook → POST /webhook/inbound?secret=...
app.post('/webhook/inbound', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'bad secret' });
  const contactId = contactIdFrom(req.body || {});
  if (!contactId) return res.status(400).json({ error: 'no contact id in payload' });
  if (req.body.direction === 'outbound') return res.json({ ignored: 'outbound' });
  agent.schedule(contactId);
  res.json({ queued: contactId });
});

// Optional: have the bot send the FIRST message (e.g. new lead workflow) → POST /webhook/start?secret=...
app.post('/webhook/start', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'bad secret' });
  const contactId = contactIdFrom(req.body || {});
  if (!contactId) return res.status(400).json({ error: 'no contact id in payload' });
  agent.schedule(contactId, { initiate: true });
  res.json({ queued: contactId });
});

app.use('/admin', require('./admin'));

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
