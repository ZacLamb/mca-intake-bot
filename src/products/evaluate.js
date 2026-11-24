// COPIED UNCHANGED from ZacLamb/afe-product-tagger src/evaluate.js — keep the two in sync.
// Scores an applicant against every product in criteria.js.
//
// Each answer is a range { min, max } because the form uses buckets.
// For a minimum (e.g. 650+ credit):
//   whole bucket at/above the floor  -> pass
//   whole bucket below the floor     -> fail
//   bucket straddles the floor       -> "borderline"
// A missing answer the product needs  -> "missing" (not tagged)
//
// Products whose worst result is pass get tagged. Borderline also gets tagged
// unless BORDERLINE_COUNTS=false.

const P = require('./parse');
const PRODUCTS = require('./criteria');

const RANK = { pass: 0, borderline: 1, missing: 2, fail: 3 };
const worst = rs => rs.reduce((w, r) => (RANK[r.result] > RANK[w] ? r.result : w), 'pass');
const fmt = n => (n === P.INF ? '∞' : Math.round(n).toLocaleString('en-US'));
const showRange = r => (r.min === r.max ? fmt(r.min) : `${fmt(r.min)}–${fmt(r.max)}`);

function floor(name, r, min) {
  if (!r) return { check: name, result: 'missing', detail: `need ${fmt(min)}+` };
  if (r.min >= min) return { check: name, result: 'pass', detail: `${showRange(r)} ≥ ${fmt(min)}` };
  if (r.max < min) return { check: name, result: 'fail', detail: `${showRange(r)} < ${fmt(min)}` };
  return { check: name, result: 'borderline', detail: `${showRange(r)} straddles ${fmt(min)}` };
}
function ceiling(name, r, max) {
  if (!r) return { check: name, result: 'missing', detail: `need ≤ ${fmt(max)}` };
  if (r.max <= max) return { check: name, result: 'pass', detail: `${showRange(r)} ≤ ${fmt(max)}` };
  if (r.min > max) return { check: name, result: 'fail', detail: `${showRange(r)} > ${fmt(max)}` };
  return { check: name, result: 'borderline', detail: `${showRange(r)} straddles ${fmt(max)}` };
}
function flag(name, v) {
  if (v === true) return { check: name, result: 'pass', detail: 'yes' };
  if (v === false) return { check: name, result: 'fail', detail: 'no' };
  return { check: name, result: 'missing', detail: 'not answered' };
}

// Raw extracted answers -> normalized applicant profile
function profile(found, now = new Date()) {
  const v = k => (found[k] ? found[k].value : undefined);

  let amount = P.moneyRange(v('amount'));
  if ((!amount || /custom/i.test(P.clean(v('amount')))) && v('custom_amount')) amount = P.moneyRange(v('custom_amount'));

  let revenue = P.monthlyRevenue(v('monthly_revenue'));
  if (!revenue && v('annual_revenue')) revenue = P.monthlyRevenue(v('annual_revenue'), { annual: true });

  const useText = [v('use_of_funds'), v('industry')].map(P.clean).join(' ');
  const purposes = P.purposes(P.clean(v('use_of_funds')));

  let ecommerce = P.bool(v('ecommerce'));
  if (ecommerce === null && P.ECOM.test(useText)) ecommerce = true;
  if (ecommerce === null && P.ECOM.test(P.clean(v('ecommerce')))) ecommerce = true;

  return {
    amount,
    monthlyRevenue: revenue,
    months: P.months(v('time_in_business'), now),
    credit: P.scoreRange(v('credit_score')),
    negativeDays: P.moneyRange(v('negative_days')),
    positions: P.positions(v('open_positions')),
    purposes,
    useOfFunds: P.clean(v('use_of_funds')),
    homeowner: P.bool(v('homeowner')),
    b2bInvoices: P.bool(v('b2b_invoices')),
    w2Income: P.bool(v('w2_income')),
    ecommerce,
  };
}

function checkRequires(req, a) {
  const out = [];
  for (const [k, want] of Object.entries(req)) {
    if (k === 'purpose') {
      out.push(a.purposes.size
        ? { check: 'purpose', result: a.purposes.has(want) ? 'pass' : 'fail', detail: [...a.purposes].join(', ') }
        : a.useOfFunds
          ? { check: 'purpose', result: 'fail', detail: a.useOfFunds } // answered, just not this purpose
          : { check: 'purpose', result: 'missing', detail: `needs use of funds = ${want}` });
    } else if (k === 'minPositions') {
      out.push(floor('positions', a.positions, want));
    } else {
      out.push(flag(k, a[k] === null || a[k] === undefined ? null : a[k] === want));
    }
  }
  return out;
}

function evaluateProduct(p, a) {
  const checks = [];
  if (p.amount) {
    const [lo, hi] = p.amount;
    if (!a.amount) checks.push({ check: 'amount', result: 'missing', detail: `${fmt(lo)}–${fmt(hi)}` });
    // Buckets share edges ("$25K – $50K", "$50K – $100K"), so a bucket that only
    // touches a product's limit doesn't count; an exact amount on the limit does.
    else if (a.amount.min === a.amount.max
      ? (a.amount.min < lo || a.amount.min > hi)
      : (a.amount.max <= lo || a.amount.min >= hi))
      checks.push({ check: 'amount', result: 'fail', detail: `${showRange(a.amount)} outside ${fmt(lo)}–${fmt(hi)}` });
    else checks.push({ check: 'amount', result: 'pass', detail: `${showRange(a.amount)} within ${fmt(lo)}–${fmt(hi)}` });
  }
  if (p.minMonthlyRevenue) checks.push(floor('monthly revenue', a.monthlyRevenue, p.minMonthlyRevenue));
  if (p.minAnnualRevenue) checks.push(floor('monthly revenue (annual/12)', a.monthlyRevenue, p.minAnnualRevenue / 12));
  if (p.minMonths) checks.push(floor('months in business', a.months, p.minMonths));
  if (p.minCredit) checks.push(floor('credit', a.credit, p.minCredit));
  if (p.maxCredit) checks.push(ceiling('credit', a.credit, p.maxCredit));
  if (p.maxNegativeDays && a.negativeDays) checks.push(ceiling('negative days', a.negativeDays, p.maxNegativeDays));
  if (p.minPositions) checks.push(floor('open positions', a.positions, p.minPositions));
  if (p.requires) checks.push(...checkRequires(p.requires, a));
  if (p.requiresAny) {
    const alts = p.requiresAny.map(alt => checkRequires(alt, a));
    const best = alts.reduce((b, c) => (RANK[worst(c)] < RANK[worst(b)] ? c : b));
    checks.push(...best);
  }
  return { id: p.id, tag: p.tag, result: worst(checks), checks };
}

function evaluate(found, { now = new Date(), borderlineCounts = process.env.BORDERLINE_COUNTS !== 'false' } = {}) {
  const applicant = profile(found, now);
  const results = PRODUCTS.map(p => evaluateProduct(p, applicant));
  const qualified = results.filter(r => r.result === 'pass' || (borderlineCounts && r.result === 'borderline'));
  return { applicant, results, qualified };
}

module.exports = { evaluate, profile, PRODUCTS };
