// What the bot collects in chat. Sensitive items are NEVER collected in chat —
// they go through the secure application link only.
//
// `contact`  = standard GHL contact field to write to. Everything else maps through FIELD_MAP.
// `screen`   = the key the AFE product rules (src/products, copied from afe-product-tagger) read.
// `required` = must be answered before the application counts as complete.
// `unlocks`  = optional yes/no questions that open up extra products (asked once, briefly).
const chatFields = [
  { key: 'business_legal_name', label: 'Business legal name', required: true, contact: 'companyName' },
  { key: 'dba', label: 'DBA (if different)' },
  { key: 'business_address', label: 'Business address', required: true },
  { key: 'business_start_date', label: 'Business start date (month/year)', required: true, screen: 'time_in_business' },
  { key: 'industry', label: 'Industry / what the business does', required: true, screen: 'industry' },
  { key: 'entity_type', label: 'Entity type (LLC, Corp, Sole Prop)' },
  { key: 'owner_first_name', label: 'Owner first name', required: true, contact: 'firstName' },
  { key: 'owner_last_name', label: 'Owner last name', required: true, contact: 'lastName' },
  { key: 'owner_email', label: 'Owner email', required: true, contact: 'email' },
  { key: 'ownership_pct', label: 'Ownership %' },
  { key: 'monthly_revenue', label: 'Average monthly revenue (deposits)', required: true, screen: 'monthly_revenue' },
  { key: 'amount_requested', label: 'Amount requested', required: true, screen: 'amount' },
  { key: 'use_of_funds', label: 'Use of funds', required: true, screen: 'use_of_funds' },
  { key: 'open_positions', label: 'Current advances/loans open (none, or how many + with whom)', required: true, screen: 'open_positions' },
  { key: 'credit_score', label: 'Estimated personal credit score (a range is fine)', required: true, screen: 'credit_score' },
  { key: 'homeowner', label: 'Owns their home? (yes/no)', unlocks: 'HELOC', screen: 'homeowner' },
  { key: 'b2b_invoices', label: 'Invoices business customers on net terms? (yes/no)', unlocks: 'Invoice Factoring', screen: 'b2b_invoices' },
  { key: 'ecommerce', label: 'Sells online (Amazon/Shopify/etc.)? (yes/no)', unlocks: 'E-Commerce Lending', screen: 'ecommerce' },
  { key: 'w2_income', label: 'Owner has W-2 income? (yes/no)', unlocks: 'Personal Loan', screen: 'w2_income' },
];

const linkOnly = ['SSN', 'date of birth', 'EIN / tax ID', 'signature', 'bank account or routing numbers', 'bank logins'];

const keys = new Set(chatFields.map((f) => f.key));
const required = chatFields.filter((f) => f.required).map((f) => f.key);
const unlockers = chatFields.filter((f) => f.unlocks);

module.exports = { chatFields, linkOnly, keys, required, unlockers };
