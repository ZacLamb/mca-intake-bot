const assert = require('assert');
const { redactSensitive, anonymize } = require('../src/redact');

const t = (input, mustNotContain, fn = redactSensitive) => {
  const out = fn(input);
  for (const s of mustNotContain) assert(!out.includes(s), `"${s}" leaked in: ${out}`);
};

t('my ssn is 123-45-6789 ok', ['123-45-6789']);
t('ssn 123456789', ['123456789']);
t('EIN 12-3456789', ['12-3456789']);
t('card 4111 1111 1111 1111', ['4111 1111 1111 1111']);
t('acct 000123456789012', ['000123456789012']);
assert(redactSensitive('we do about 85000 a month').includes('85000'), 'revenue numbers must survive');
assert(redactSensitive('call me at 617-555-1234').includes('617-555-1234'), 'phone kept in live chat');
t('email me john@acme.com or 617-555-1234', ['john@acme.com', '617-555-1234'], anonymize);

console.log('redact tests passed');
