// COPIED UNCHANGED from ZacLamb/afe-product-tagger src/criteria.js — keep the two in sync.
// Product rules transcribed from the AFE "Product Suite Team Guide" PDF.
// Edit numbers here — nothing else in the app needs to change.
//
// Rule keys:
//   amount            [min, max]  requested amount must overlap this range
//   minMonthlyRevenue monthly revenue floor
//   minAnnualRevenue  annual revenue floor (compared as monthly x 12)
//   minMonths         time-in-business floor, in months
//   minCredit         credit score floor
//   maxCredit         credit must be at or under this (credit repair)
//   maxNegativeDays   only checked when the application has a negative-days answer
//   minPositions      open MCA positions required
//   requires          flags that must be true: homeowner, b2bInvoices, w2Income,
//                     ecommerce, purpose ('equipment' | 'real_estate' | 'debt_consolidation')
//   requiresAny       list of alternatives — any one passing is enough
//
// Where the PDF contradicts itself, the product slide wins over the cheat sheet:
//   MCA revenue — slide $5K/mo (cheat sheet $10K/mo)
//   Line of credit max — slide $10M (cheat sheet $1M)

const M = 1_000_000;

module.exports = [
  { id: 'mca', tag: 'MCA',
    amount: [1_000, 10 * M], minMonthlyRevenue: 5_000, minMonths: 3, maxNegativeDays: 6 },

  { id: 'mca-reverse', tag: 'MCA Reverse',
    amount: [1_000, 10 * M], minMonthlyRevenue: 10_000, minMonths: 3, maxNegativeDays: 6,
    minPositions: 1 },

  { id: 'reverse-consolidation', tag: 'Reverse Consolidation',
    amount: [1_000, 10 * M], minMonthlyRevenue: 10_000, minMonths: 3, maxNegativeDays: 6,
    minPositions: 2 },

  { id: 'loc', tag: 'Business Line of Credit',
    amount: [5_000, 10 * M], minMonthlyRevenue: 10_000, minMonths: 6, minCredit: 550,
    maxNegativeDays: 3 },

  { id: 'term', tag: 'Term Loan',
    amount: [25_000, 1 * M], minAnnualRevenue: 50_000, minMonths: 12, minCredit: 650 },

  { id: 'sba', tag: 'SBA Loan',
    amount: [50_000, 5 * M], minAnnualRevenue: 100_000, minMonths: 24, minCredit: 650 },

  { id: 'equipment', tag: 'Equipment Financing',
    amount: [25_000, 5 * M], minMonthlyRevenue: 10_000, minMonths: 24, minCredit: 600,
    requires: { purpose: 'equipment' } },

  { id: 'heloc', tag: 'HELOC',
    amount: [25_000, 1 * M], minCredit: 640, requires: { homeowner: true } },

  { id: 'cre', tag: 'Commercial Real Estate',
    amount: [100_000, 50 * M], minMonths: 24, requires: { purpose: 'real_estate' } },

  { id: 'syndicated', tag: 'Syndicated Line of Credit',
    amount: [10_000, 250_000], minCredit: 680 },

  { id: 'factoring', tag: 'Invoice Factoring',
    amount: [100_000, 10 * M], minCredit: 650, requires: { b2bInvoices: true } },

  { id: 'personal', tag: 'Personal Loan',
    minCredit: 680, requires: { w2Income: true } },

  // Miscellaneous programs (slide 11)
  { id: 'ecommerce', tag: 'E-Commerce Lending',
    requires: { ecommerce: true } },

  { id: 'debt-consolidation', tag: 'Debt Consolidation',
    requiresAny: [{ purpose: 'debt_consolidation' }, { minPositions: 2 }] },

  { id: 'credit-repair', tag: 'Credit Repair',
    maxCredit: 549 },
];
