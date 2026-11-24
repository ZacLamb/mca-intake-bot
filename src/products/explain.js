// COPIED UNCHANGED from ZacLamb/afe-product-tagger src/explain.js — keep the two in sync.
// Turns a screening result into a plain-English note a rep can read on the
// GHL contact: what answers were used, and for every product why it does /
// doesn't fit.

const INF = Infinity;
const money = n => (n === INF ? 'no max' : '$' + Math.round(n).toLocaleString('en-US'));
const num = n => (n === INF ? '∞' : Math.round(n).toLocaleString('en-US'));
const range = (r, f) => (!r ? 'not answered' : r.min === r.max ? f(r.min) : r.max === INF ? `${f(r.min)}+` : `${f(r.min)}–${f(r.max)}`);
const yn = v => (v === true ? 'yes' : v === false ? 'no' : 'not answered');

const LABELS = {
  'amount': ['Amount', 'money'],
  'monthly revenue': ['Revenue/mo', 'money'],
  'monthly revenue (annual/12)': ['Revenue/mo (annual ÷ 12)', 'money'],
  'months in business': ['Time in business (months)', 'num'],
  'credit': ['Credit', 'num'],
  'negative days': ['Negative days', 'num'],
  'open positions': ['Open advances', 'num'],
  'positions': ['Open advances', 'num'],
  'purpose': ['Use of funds', 'text'],
  'homeowner': ['Owns home', 'text'],
  'b2bInvoices': ['B2B invoices', 'text'],
  'w2Income': ['W-2 income', 'text'],
  'ecommerce': ['Sells online', 'text'],
};

// "75,000–100,000 within 1,000–10,000,000" etc. -> human phrase
function phrase(c) {
  const [label, kind] = LABELS[c.check] || [c.check, 'text'];
  const fmt = s => (kind === 'money' ? s.replace(/(\d[\d,]*)/g, '$$$1').replace(/∞/g, 'no max') : s);
  const d = c.detail || '';
  if (c.result === 'missing') return `${label}: not answered`;
  if (kind === 'text') {
    if (c.check === 'purpose') return c.result === 'pass' ? `${label}: ${d.replace(/_/g, ' ')}` : `${label}: ${d.replace(/_/g, ' ')} (doesn't match)`;
    return `${label}: ${d}`;
  }
  let m;
  if ((m = d.match(/^(.+) within (.+)$/))) return `${label} ${fmt(m[1])} (fits ${fmt(m[2])})`;
  if ((m = d.match(/^(.+) outside (.+)$/))) return `${label} ${fmt(m[1])} — outside ${fmt(m[2])}`;
  if ((m = d.match(/^(.+) ≥ (.+)$/))) return `${label} ${fmt(m[1])} (min ${fmt(m[2])})`;
  if ((m = d.match(/^(.+) ≤ (.+)$/))) return `${label} ${fmt(m[1])} (max ${fmt(m[2])})`;
  if ((m = d.match(/^(.+) < (.+)$/))) return `${label} ${fmt(m[1])} — below the ${fmt(m[2])} minimum`;
  if ((m = d.match(/^(.+) > (.+)$/))) return `${label} ${fmt(m[1])} — above the ${fmt(m[2])} maximum`;
  if ((m = d.match(/^(.+) straddles (.+)$/))) return `${label} ${fmt(m[1])} — answer range crosses ${fmt(m[2])}, confirm exact figure`;
  return `${label}: ${fmt(d)}`;
}

function explain(result, { source, when = new Date() } = {}) {
  const a = result.applicant || {};
  const purposes = a.purposes instanceof Set ? [...a.purposes] : a.purposes || [];
  const L = [];
  L.push(`PRODUCT SCREENING — ${when.toISOString().slice(0, 10)}${source ? ` (${source})` : ''}`);
  L.push('');
  L.push('Answers used:');
  L.push(`• Amount: ${range(a.amount, money)}`);
  L.push(`• Revenue/mo: ${range(a.monthlyRevenue, money)}`);
  L.push(`• Time in business: ${range(a.months, n => `${num(n)} mo`)}`);
  L.push(`• Credit: ${range(a.credit, num)}`);
  L.push(`• Open advances: ${range(a.positions, num)}`);
  L.push(`• Use of funds: ${a.useOfFunds || (purposes.length ? purposes.join(', ').replace(/_/g, ' ') : 'not answered')}`);
  L.push(`• Owns home: ${yn(a.homeowner)} · B2B invoices: ${yn(a.b2bInvoices)} · W-2: ${yn(a.w2Income)} · Sells online: ${yn(a.ecommerce)}`);

  const groups = [
    ['✅ QUALIFIES', 'pass', c => true],
    ['🟡 POSSIBLE — confirm with client', 'borderline', c => c.result !== 'pass'],
    ['❌ NOT A FIT', 'fail', c => c.result === 'fail'],
    ['❔ NOT ENOUGH INFO', 'missing', c => c.result === 'missing'],
  ];
  for (const [title, status, show] of groups) {
    const rows = result.results.filter(r => r.result === status);
    if (!rows.length) continue;
    L.push('');
    L.push(`${title} (${rows.length})`);
    for (const r of rows) {
      const reasons = r.checks.filter(show).map(phrase);
      L.push(`• ${r.tag}${reasons.length ? ' — ' + reasons.join(' · ') : ''}`);
    }
  }
  L.push('');
  L.push('Based on the AFE product guide minimums. Not an approval — lenders make the final call.');
  return L.join('\n');
}

module.exports = { explain, phrase };
