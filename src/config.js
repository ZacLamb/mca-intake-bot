// All settings come from environment variables (Railway → Variables).
const list = (v) => (v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
const json = (v, name) => {
  try {
    return JSON.parse(v || '{}');
  } catch (e) {
    console.error(`${name} is not valid JSON — ignoring it.`);
    return {};
  }
};

// GHL accounts. Account 1 uses GHL_API_KEY / GHL_LOCATION_ID.
// Account 2+ add a suffix: GHL_API_KEY_2 / GHL_LOCATION_ID_2, ACCOUNT_NAME_2, APP_LINK_URL_2, FIELD_MAP_2 ...
// Anything not set per-account falls back to the un-suffixed value.
function loadAccounts() {
  const out = [];
  for (let i = 1; i <= 10; i++) {
    const s = i === 1 ? '' : `_${i}`;
    const env = (k) => process.env[`${k}${s}`];
    const token = env('GHL_API_KEY');
    const locationId = env('GHL_LOCATION_ID');
    if (!token || !locationId) continue;
    out.push({
      key: String(i),
      name: env('ACCOUNT_NAME') || `Account ${i}`,
      learnOnly: /^(1|true|yes)$/i.test(env('LEARN_ONLY') || ''), // history is learned from, bot never messages here
      token,
      locationId,
      businessName: env('BUSINESS_NAME') || process.env.BUSINESS_NAME || 'our funding team',
      appLinkUrl: env('APP_LINK_URL') || process.env.APP_LINK_URL || '',
      statementUploadUrl: env('STATEMENT_UPLOAD_URL') || process.env.STATEMENT_UPLOAD_URL || '',
      fieldMap: json(env('FIELD_MAP') || (i === 1 ? '' : process.env.FIELD_MAP), `FIELD_MAP${s}`),
      statementFileFieldId: env('STATEMENT_FILE_FIELD_ID') || '',
      appSubmittedTag: (env('APP_SUBMITTED_TAG') || process.env.APP_SUBMITTED_TAG || '').toLowerCase(),
      winTags: list(env('WIN_TAGS') || process.env.WIN_TAGS),
    });
  }
  return out;
}

const cfg = {
  port: process.env.PORT || 3000,
  accounts: loadAccounts(),

  // Required
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  databaseUrl: process.env.DATABASE_URL,
  webhookSecret: process.env.WEBHOOK_SECRET,
  adminPassword: process.env.ADMIN_PASSWORD,

  // Bot identity
  model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
  botName: process.env.BOT_NAME || 'Alex',
  statementsRequired: int(process.env.STATEMENTS_REQUIRED, 4),

  // Behavior
  defaultMode: (process.env.BOT_MODE || 'draft').toLowerCase(), // draft | auto (can be changed in dashboard)
  replyDelayMs: int(process.env.REPLY_DELAY_SECONDS, 25) * 1000,
  humanPauseHours: int(process.env.HUMAN_PAUSE_HOURS, 24),

  // Tags (shared by all accounts)
  engageTag: (process.env.ENGAGE_TAG || '').toLowerCase(),
  killTag: (process.env.KILL_TAG || 'bot-off').toLowerCase(),
  handoffTag: process.env.HANDOFF_TAG || 'bot-handoff',
  appReceivedTag: process.env.APP_RECEIVED_TAG || 'app-received',
  statementsReceivedTag: process.env.STATEMENTS_RECEIVED_TAG || 'statements-received',

  // Learning
  mineCron: process.env.MINE_CRON || '0 3 * * *',
  mineDaysBack: int(process.env.MINE_DAYS_BACK, 180),
  mineMaxConversations: int(process.env.MINE_MAX_CONVERSATIONS, 6000), // per account
  // Opportunity stages that mean the merchant sent docs / got submitted (marks their conversations as wins)
  winStagePattern: new RegExp(process.env.WIN_STAGE_PATTERN || 'submit|underwrit|approv|offer|contract|fund|closed|won|docs? (in|received)|statements? (in|received)|app(lication)? (in|received)', 'i'),
  timezone: process.env.CRON_TZ || 'America/New_York',
};

cfg.account = (idOrKey) =>
  idOrKey ? cfg.accounts.find((a) => a.locationId === idOrKey || a.key === String(idOrKey)) : undefined;

cfg.missing = () => {
  const m = ['anthropicKey', 'databaseUrl', 'webhookSecret', 'adminPassword'].filter((k) => !cfg[k]);
  if (!cfg.accounts.length) m.unshift('GHL_API_KEY + GHL_LOCATION_ID');
  return m;
};

module.exports = cfg;
