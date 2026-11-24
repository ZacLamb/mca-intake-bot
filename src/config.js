// All settings come from environment variables (Railway → Variables).
const list = (v) => (v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);

let fieldMap = {};
try {
  fieldMap = JSON.parse(process.env.FIELD_MAP || '{}');
} catch (e) {
  console.error('FIELD_MAP is not valid JSON — ignoring it.');
}

const cfg = {
  port: process.env.PORT || 3000,

  // Required
  ghlToken: process.env.GHL_API_KEY,            // Private Integration token for the sub-account
  locationId: process.env.GHL_LOCATION_ID,
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  databaseUrl: process.env.DATABASE_URL,
  webhookSecret: process.env.WEBHOOK_SECRET,
  adminPassword: process.env.ADMIN_PASSWORD,

  // Bot identity
  model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
  botName: process.env.BOT_NAME || 'Alex',
  businessName: process.env.BUSINESS_NAME || 'our funding team',

  // Links (optional but recommended)
  appLinkUrl: process.env.APP_LINK_URL || '',               // your online application / GHL survey
  statementUploadUrl: process.env.STATEMENT_UPLOAD_URL || '', // optional upload page for statements
  statementsRequired: int(process.env.STATEMENTS_REQUIRED, 4),

  // Behavior
  defaultMode: (process.env.BOT_MODE || 'draft').toLowerCase(), // draft | auto (can be changed in dashboard)
  replyDelayMs: int(process.env.REPLY_DELAY_SECONDS, 25) * 1000, // wait for merchant to finish typing
  humanPauseHours: int(process.env.HUMAN_PAUSE_HOURS, 24),

  // Tags
  engageTag: (process.env.ENGAGE_TAG || '').toLowerCase(),   // if set, bot ONLY talks to contacts with this tag
  killTag: (process.env.KILL_TAG || 'bot-off').toLowerCase(),
  handoffTag: process.env.HANDOFF_TAG || 'bot-handoff',
  appReceivedTag: process.env.APP_RECEIVED_TAG || 'app-received',
  statementsReceivedTag: process.env.STATEMENTS_RECEIVED_TAG || 'statements-received',
  appSubmittedTag: (process.env.APP_SUBMITTED_TAG || '').toLowerCase(), // tag your form workflow adds on submit
  winTags: list(process.env.WIN_TAGS), // tags that mean "this past conversation was a win" for learning

  // GHL custom field mapping: {"monthly_revenue":"<customFieldId>", ...}
  fieldMap,
  statementFileFieldId: process.env.STATEMENT_FILE_FIELD_ID || '', // file-upload custom field for statements

  // Learning
  mineCron: process.env.MINE_CRON || '0 3 * * *',
  mineDaysBack: int(process.env.MINE_DAYS_BACK, 180),
  mineMaxConversations: int(process.env.MINE_MAX_CONVERSATIONS, 2000),
  timezone: process.env.CRON_TZ || 'America/New_York',
};

cfg.missing = () =>
  ['ghlToken', 'locationId', 'anthropicKey', 'databaseUrl', 'webhookSecret', 'adminPassword'].filter((k) => !cfg[k]);

module.exports = cfg;
