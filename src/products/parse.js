// COPIED UNCHANGED from ZacLamb/afe-product-tagger src/parse.js — keep the two in sync.
// Turns raw form answers (bucket labels like "$25K – $50K", "1-2 years",
// "650-679", dates, plain numbers) into numeric ranges { min, max }.

const INF = Infinity;

function clean(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) v = v.join(', ');
  return String(v).trim();
}

// "$25K" -> 25000, "1.5M" -> 1500000, "75,000" -> 75000
function money(token) {
  const m = String(token).replace(/[$,\s]/g, '').match(/^(\d+(?:\.\d+)?)([kKmMbB])?/);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

function numbersIn(str, parser = money) {
  const re = /\$?\s*\d[\d,]*(?:\.\d+)?\s*[kKmMbB]?(?![a-zA-Z])/g;
  return (str.match(re) || []).map(t => parser(t)).filter(n => n !== null);
}

// Generic range parser for money-ish or score-ish buckets.
function range(raw, parser = money) {
  const s = clean(raw);
  if (!s) return null;
  const lower = s.toLowerCase();
  const nums = numbersIn(s, parser);
  if (!nums.length) return null;
  if (/under|below|less than|up to|<|fewer/.test(lower)) return { min: 0, max: nums[0] - 1 };
  if (/\+|over|above|more than|greater|or more|>/.test(lower) && nums.length === 1) return { min: nums[0], max: INF };
  if (nums.length >= 2) return { min: Math.min(nums[0], nums[1]), max: Math.max(nums[0], nums[1]) };
  return { min: nums[0], max: nums[0] };
}

const moneyRange = raw => range(raw, money);

function plainNumber(t) {
  const n = parseFloat(String(t).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}
const scoreRange = raw => {
  const s = clean(raw).toLowerCase();
  if (!s) return null;
  // Word-only answers some forms use
  if (!/\d/.test(s)) {
    if (/excellent/.test(s)) return { min: 720, max: 850 };
    if (/good/.test(s)) return { min: 680, max: 719 };
    if (/fair/.test(s)) return { min: 580, max: 679 };
    if (/poor|bad/.test(s)) return { min: 300, max: 579 };
    return null;
  }
  const r = range(s, plainNumber);
  if (r && r.max === INF) r.max = 850;
  return r;
};

// Monthly revenue. Detects annual answers ("$600K/year", "annual") and converts.
function monthlyRevenue(raw, { annual = false } = {}) {
  const s = clean(raw);
  if (!s) return null;
  const r = moneyRange(s);
  if (!r) return null;
  const isAnnual = annual || /year|annual|\/\s*yr|per yr|p\.?a\.?/i.test(s);
  if (!isAnnual) return r;
  return { min: r.min / 12, max: r.max === INF ? INF : r.max / 12 };
}

// Time in business in months. Accepts buckets, "2 years", a start date, or a year.
function months(raw, now = new Date()) {
  const s = clean(raw);
  if (!s) return null;
  const lower = s.toLowerCase();

  // Dates: 2021-03-15, 03/15/2021, 3/2021, Mar 2021
  const d = parseDate(s);
  if (d) {
    const m = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
    return { min: Math.max(0, m), max: Math.max(0, m) };
  }
  // A bare 4-digit year = year started
  if (/^(19|20)\d{2}$/.test(s)) {
    const m = (now.getFullYear() - parseInt(s, 10)) * 12;
    return { min: Math.max(0, m - 11), max: m };
  }

  const unitYears = /year|yr/.test(lower);
  const unitMonths = /month|mo\b|mos\b/.test(lower);
  // Mixed buckets like "6 months – 1 year"
  const parts = [...lower.matchAll(/(\d+(?:\.\d+)?)\s*(years?|yrs?|months?|mos?)?/g)]
    .map(m => ({ n: parseFloat(m[1]), u: m[2] || '' }));
  if (!parts.length) {
    if (/start ?up|new business|not yet|pre-?revenue/.test(lower)) return { min: 0, max: 0 };
    return null;
  }
  const defaultUnit = unitMonths && !unitYears ? 'm' : unitYears && !unitMonths ? 'y' : null;
  // When both units appear, each number takes the next unit mentioned after it.
  const toMonths = (p, i) => {
    let u = p.u ? (p.u.startsWith('y') ? 'y' : 'm') : null;
    if (!u) {
      const later = parts.slice(i + 1).find(q => q.u);
      u = later ? (later.u.startsWith('y') ? 'y' : 'm') : (defaultUnit || 'y');
    }
    return u === 'y' ? p.n * 12 : p.n;
  };
  const vals = parts.map(toMonths);

  if (/less than|under|below|<|fewer/.test(lower)) return { min: 0, max: vals[0] - 0.01 };
  if (/\+|over|more than|greater|or more|>/.test(lower) && vals.length === 1) return { min: vals[0], max: INF };
  if (vals.length >= 2) return { min: Math.min(vals[0], vals[1]), max: Math.max(vals[0], vals[1]) };
  return { min: vals[0], max: vals[0] };
}

function parseDate(s) {
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/))) return new Date(+m[1], +m[2] - 1, +(m[3] || 1));
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return new Date(+m[3], +m[1] - 1, +m[2]);
  if ((m = s.match(/^(\d{1,2})\/(\d{4})$/))) return new Date(+m[2], +m[1] - 1, 1);
  const t = Date.parse(s);
  if (!Number.isNaN(t) && /[a-z]{3}/i.test(s) && /\d{4}/.test(s)) return new Date(t);
  return null;
}

// yes / no / unknown
function bool(raw) {
  const s = clean(raw).toLowerCase();
  if (!s) return null;
  if (/^(y|yes|true|1|own|owner|homeowner|i own|we own|checked)\b/.test(s)) return true;
  if (/^(n|no|false|0|rent|none|not)\b/.test(s)) return false;
  return null;
}

// Number of open MCA positions
function positions(raw) {
  const s = clean(raw).toLowerCase();
  if (!s) return null;
  if (/^(no|none|0|zero)\b/.test(s)) return { min: 0, max: 0 };
  const n = s.match(/\d+/);
  if (n) {
    const v = parseInt(n[0], 10);
    return /\+|or more|more than/.test(s) ? { min: v, max: INF } : { min: v, max: v };
  }
  if (/^(yes|y)\b/.test(s)) return { min: 1, max: INF }; // has advances, count unknown
  return null;
}

// Use-of-funds keywords -> set of purposes
const PURPOSES = {
  equipment: /equipment|machine|vehicle|truck|trailer|tool|technolog|computer|hardware/,
  real_estate: /real estate|property|building|commercial space|purchase (a )?(location|space)|construction|mortgage|land\b/,
  debt_consolidation: /debt|consolidat|pay ?off|refinanc|existing (loan|advance|position)|reverse/,
};
function purposes(raw) {
  const s = clean(raw).toLowerCase();
  const set = new Set();
  if (!s) return set;
  for (const [k, re] of Object.entries(PURPOSES)) if (re.test(s)) set.add(k);
  return set;
}

const ECOM = /e-?commerce|amazon|shopify|etsy|ebay|online (store|shop|seller|retail)|walmart marketplace/i;

module.exports = { clean, money, moneyRange, scoreRange, monthlyRevenue, months, bool, positions, purposes, ECOM, INF };
