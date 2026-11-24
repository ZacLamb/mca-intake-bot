// What the bot collects in chat. Sensitive items are NEVER collected in chat —
// they go through the secure application link only.
// `contact` = standard GHL contact field to write to. Everything else maps through FIELD_MAP.
const chatFields = [
  { key: 'business_legal_name', label: 'Business legal name', required: true, contact: 'companyName' },
  { key: 'dba', label: 'DBA (if different)' },
  { key: 'business_address', label: 'Business address', required: true },
  { key: 'business_start_date', label: 'Business start date (month/year)', required: true },
  { key: 'industry', label: 'Industry / what the business does', required: true },
  { key: 'entity_type', label: 'Entity type (LLC, Corp, Sole Prop)' },
  { key: 'owner_first_name', label: 'Owner first name', required: true, contact: 'firstName' },
  { key: 'owner_last_name', label: 'Owner last name', required: true, contact: 'lastName' },
  { key: 'owner_email', label: 'Owner email', required: true, contact: 'email' },
  { key: 'ownership_pct', label: 'Ownership %' },
  { key: 'monthly_revenue', label: 'Average monthly revenue (deposits)', required: true },
  { key: 'amount_requested', label: 'Amount requested', required: true },
  { key: 'use_of_funds', label: 'Use of funds' },
  { key: 'open_positions', label: 'Current advances/loans open (none, or how many + with whom)', required: true },
];

const linkOnly = ['SSN', 'date of birth', 'EIN / tax ID', 'signature', 'bank account or routing numbers', 'bank logins'];

const keys = new Set(chatFields.map((f) => f.key));
const required = chatFields.filter((f) => f.required).map((f) => f.key);

module.exports = { chatFields, linkOnly, keys, required };
