// Recorded conversations are personal. Before anything is stored or shown to
// human labelers we strip the most common identifiers. This is a baseline,
// not a guarantee: agents should also redact on their side.

const PATTERNS = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]'],
  [/\bhttps?:\/\/\S+/gi, '[link]'],
  [/\b(?:\d[ -]?){13,19}\b/g, '[card]'],
  [/(?:\+?\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g, '[phone]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[id-number]'],
  [/@[A-Za-z0-9_]{2,30}\b/g, '[handle]'],
];

export function redact(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}
