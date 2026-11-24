// PRODUCT LABELING: runs the bot's collected answers through the AFE product guide rules
// (src/products — copied unchanged from ZacLamb/afe-product-tagger) and writes the SAME
// labels the tagger writes for the other intake paths:
//   tags  "qualifies - <product>", "possible - <product>", "qualifies - none", "afe screened"
//   note  the plain-English "why it qualifies" breakdown
//   opportunity  one applicant card in Pre Submission Pipeline → Hot Lead
// So a merchant who applies by chatting with the bot lands in GHL exactly like a form applicant.
const cfg = require('./config');
const ghl = require('./ghl');
const db = require('./db');
const schema = require('./appSchema');
const { evaluate, PRODUCTS } = require('./products/evaluate');
const { explain } = require('./products/explain');

const TAG_PREFIX = process.env.TAG_PREFIX || 'qualifies - ';
const POSSIBLE_PREFIX = process.env.POSSIBLE_PREFIX || 'possible - ';
const SCREENED_TAG = (process.env.SCREENED_TAG || 'afe screened').toLowerCase();
const NO_MATCH_TAG = (process.env.NO_MATCH_TAG || 'qualifies - none').toLowerCase();
const enabled = () => !/^(false|0|no|off)$/i.test(process.env.PRODUCT_SCREENING || 'true');

const productTag = (p, prefix = TAG_PREFIX) => `${prefix}${p.tag}`.toLowerCase().trim();
const tagFor = (r) => productTag(r, r.result === 'borderline' ? POSSIBLE_PREFIX : TAG_PREFIX);
const ALL_PRODUCT_TAGS = [...PRODUCTS.map((p) => productTag(p)), ...PRODUCTS.map((p) => productTag(p, POSSIBLE_PREFIX)), NO_MATCH_TAG];

// Bot field keys → the answer keys the tagger's rules read
function toFound(fields) {
  const found = {};
  for (const f of schema.chatFields) {
    if (f.screen && fields[f.key]) found[f.screen] = { value: fields[f.key], from: `chat: ${f.label}` };
  }
  return found;
}

function screen(fields) {
  return evaluate(toFound(fields), { borderlineCounts: true });
}

// What the tags would be (no GHL calls) — used by the testing ground and the bot's own state
function labels(fields) {
  const r = screen(fields);
  const qualifies = r.results.filter((x) => x.result === 'pass').map((x) => x.tag);
  const possible = r.results.filter((x) => x.result === 'borderline').map((x) => x.tag);
  const notEnoughInfo = r.results.filter((x) => x.result === 'missing').map((x) => x.tag);
  const tags = r.qualified.map(tagFor);
  tags.push(SCREENED_TAG);
  if (!qualifies.length) tags.push(NO_MATCH_TAG);
  return { result: r, qualifies, possible, notEnoughInfo, tags, note: explain(r, { source: 'intake bot chat' }) };
}

// Unanswered questions that would let the rules screen more products (fed to the bot so it asks)
function gaps(fields) {
  return schema.chatFields
    .filter((f) => f.screen && f.screen !== 'industry' && !fields[f.key])
    .map((f) => (f.unlocks ? `${f.label} — unlocks ${f.unlocks}` : f.label));
}

// Writes tags (removing stale product tags), the note, and the applicant opportunity
async function labelInGhl(acct, contactId, fields, existingTags = []) {
  if (!enabled()) return { skipped: 'PRODUCT_SCREENING is off' };
  const L = labels(fields);
  const have = new Set(existingTags.map((t) => String(t).toLowerCase()));
  const stale = ALL_PRODUCT_TAGS.filter((t) => have.has(t) && !L.tags.includes(t));
  const out = { tags: L.tags, removed: stale, qualifies: L.qualifies, possible: L.possible };

  if (stale.length) await ghl.removeTags(acct, contactId, stale);
  await ghl.addTags(acct, contactId, L.tags);
  try {
    await ghl.addNote(acct, contactId, L.note);
  } catch (e) {
    out.note = `failed: ${e.message}`;
  }
  if (!/^(false|0|no|off)$/i.test(process.env.APPLICANT_OPPORTUNITY || 'true')) {
    try {
      out.opportunity = await ensureApplicantOpportunity(acct, contactId, fields, L);
    } catch (e) {
      out.opportunity = { error: e.message }; // tags already written; don't fail the turn
    }
  }
  await db.logEvent(contactId, 'screened', `${acct.name}: ${L.tags.join(', ')}${out.opportunity?.error ? ` | opportunity error: ${out.opportunity.error}` : ''}`);
  return out;
}

// Same as the tagger: one card per applicant in Pre Submission Pipeline → Hot Lead
async function ensureApplicantOpportunity(acct, contactId, fields, L) {
  const pipelineName = process.env.APPLICANT_PIPELINE || 'Pre Submission Pipeline';
  const stageName = process.env.APPLICANT_STAGE || 'Hot Lead';
  const { pipelineId, stageId } = await ghl.findStage(acct, pipelineName, stageName);
  const existing = await ghl.contactOpportunities(acct, contactId, pipelineId);
  if (existing.length) return { created: false, id: existing[0].id };
  const biz = fields.business_legal_name || [fields.owner_first_name, fields.owner_last_name].filter(Boolean).join(' ') || 'Applicant';
  const amt = L.result.applicant.amount;
  const value = amt && amt.min === amt.max && Number.isFinite(amt.min) ? amt.min : 0;
  const res = await ghl.createOpportunity(acct, {
    locationId: acct.locationId,
    pipelineId,
    pipelineStageId: stageId,
    contactId,
    name: `${biz} – Application${L.qualifies.length ? ` (${L.qualifies.length} products)` : ''}`,
    monetaryValue: value,
  });
  return { created: true, id: (res.opportunity || res).id };
}

module.exports = { enabled, labels, gaps, labelInGhl, screen, toFound, ALL_PRODUCT_TAGS };
