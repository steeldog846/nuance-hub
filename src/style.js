// How something was typed, not just what was typed. People stress words with
// CAPITALS, shout in ALL CAPS, mock with aLtErNaTiNg case, stretch words
// ("sooo"), or pile up "!!!". The same words typed differently can mean
// different things, so this is recorded with every message and the app learns
// separately what people mean in each style.

const LETTER = /\p{L}/gu;
const UPPER = /\p{Lu}/gu;

// Common all-caps words that are not emphasis.
const NOT_SHOUTING = new Set(['I', 'OK', 'TV', 'AI', 'USA', 'UK', 'ID', 'PM', 'AM', 'FAQ', 'PDF', 'URL', 'API', 'CEO', 'LOL', 'OMG', 'ASAP', 'FYI']);

export const STYLES = {
  plain: 'Typed normally',
  stressed_words: 'Some words in CAPITALS',
  all_caps: 'ALL CAPITALS',
  all_lower: 'all lowercase',
  mocking_case: 'mOcKiNg CaSe',
};

export function analyzeTyping(text = '') {
  const letters = (text.match(LETTER) || []).length;
  const upper = (text.match(UPPER) || []).length;
  const capsRatio = letters ? upper / letters : 0;
  const words = text.match(/\p{L}[\p{L}']*/gu) || [];

  const shoutedWords = words.filter((w) => w.length >= 2 && w === w.toUpperCase() && w !== w.toLowerCase() && !NOT_SHOUTING.has(w));
  // aLtErNaTiNg case: at least two lower→UPPER switches inside one word
  // (so "JavaScript", "iPhone" and "McDonald" don't count).
  const mockingWords = words.filter((w) => w.length >= 4 && (w.match(/\p{Ll}(?=\p{Lu})/gu) || []).length >= 2);
  const exclamations = (text.match(/!/g) || []).length;
  const questions = (text.match(/\?/g) || []).length;
  const elongated = words.filter((w) => /(\p{L})\1{2,}/u.test(w));
  const ellipsis = /\.{3,}|…/.test(text);
  const emoji = (text.match(/\p{Extended_Pictographic}/gu) || []).length;

  let style = 'plain';
  if (mockingWords.length) style = 'mocking_case';
  else if (letters >= 6 && capsRatio > 0.8 && words.length >= 2) style = 'all_caps';
  else if (shoutedWords.length) style = 'stressed_words';
  else if (letters >= 6 && upper === 0) style = 'all_lower';

  // 0 = calm, 1 = some stress, 2 = strong, 3 = very strong
  let emphasis = 0;
  if (style === 'stressed_words' || exclamations >= 2 || elongated.length) emphasis = 1;
  if (style === 'all_caps' || exclamations >= 3 || (style === 'stressed_words' && exclamations >= 1)) emphasis = 2;
  if (style === 'all_caps' && exclamations >= 2) emphasis = 3;

  const notes = [];
  if (style === 'all_caps') notes.push('whole message in capitals (shouting or strong feeling)');
  if (style === 'stressed_words') notes.push(`${shoutedWords.map((w) => `“${w}”`).join(', ')} in capitals (stressed)`);
  if (style === 'mocking_case') notes.push('mixed-up capitals, often mocking');
  // All lowercase is how most people type, so it isn't called out.
  if (exclamations >= 2) notes.push(`${exclamations} exclamation marks`);
  if (elongated.length) notes.push(`stretched words: ${elongated.join(', ')}`);
  if (ellipsis) notes.push('trailing dots…');

  return {
    style,
    emphasis,
    capsRatio: +capsRatio.toFixed(2),
    shoutedWords,
    exclamations,
    questions,
    elongated,
    ellipsis,
    emoji,
    note: notes.join('; ') || null,
  };
}

// How much two typing styles should share lessons (1 = same style).
export function styleAffinity(a, b) {
  if (!a || !b) return 0.8;
  if (a.style === b.style) return Math.abs(a.emphasis - b.emphasis) >= 2 ? 0.85 : 1;
  const loud = (s) => s.style === 'all_caps' || s.style === 'stressed_words';
  if (loud(a) && loud(b)) return 0.8;
  if ((a.style === 'plain' && b.style === 'all_lower') || (a.style === 'all_lower' && b.style === 'plain')) return 0.9;
  return 0.55;
}
