// Strips identifiers before anything is stored or sent to Claude.

// Always removed (live chat and learning)
function redactSensitive(text) {
  if (!text) return '';
  return String(text)
    .replace(/\b\d{3}[- ]\d{2}[- ]\d{4}\b/g, '[SSN REDACTED]')
    .replace(/\b\d{2}-\d{7}\b/g, '[EIN REDACTED]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => (m.replace(/\D/g, '').length >= 13 ? '[NUMBER REDACTED]' : m))
    .replace(/\b\d{9}\b/g, '[ID REDACTED]')
    .replace(/\b\d{12,}\b/g, '[NUMBER REDACTED]');
}

// For learning only: also remove contact details so transcripts are anonymous
function anonymize(text) {
  return redactSensitive(text)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL]')
    .replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[PHONE]')
    .replace(/https?:\/\/\S+/g, '[LINK]');
}

module.exports = { redactSensitive, anonymize };
