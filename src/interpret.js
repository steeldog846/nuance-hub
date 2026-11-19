// Reads what a person typed in their own words ("i was just kidding", "gussa",
// "angery", "😡😡", "not seriuos") and finds the meanings and feelings in it.
// Built for everyday typing: misspellings, no punctuation, all lowercase,
// emoji, and common Hinglish words. Anything it can't place is still kept
// word-for-word and learned from.

import { EMOTION_EMOJI, INTENTS, EMOTIONS } from './taxonomy.js';
import { askClaudeJson } from './claude.js';

// [phrase or word stem, tag]. Multi-word phrases match anywhere; single words
// also match with small spelling mistakes.
const INTENT_WORDS = {
  sarcastic: ['sarcastic', 'sarcasm', 'sarcas', 'sarky', 'opposite', 'not serious', 'didnt mean it', 'did not mean', 'taunt', 'taana', 'tana', 'vyang', 'ulta'],
  joking: ['joke', 'joking', 'kidding', 'jk', 'lol', 'lmao', 'haha', 'hehe', 'fun', 'funny', 'mazak', 'mazaak', 'majak', 'masti', 'for fun'],
  teasing: ['mazak uda', 'mazaak uda', 'tease', 'teasing', 'pulling your leg', 'leg pull', 'chidana', 'chida', 'messing with', 'trolling', 'troll'],
  sincere: ['serious', 'seriously', 'meant it', 'mean it', 'honest', 'honestly', 'true', 'truly', 'sach', 'sachi', 'sacchi', 'literally meant'],
  passive_aggressive: ['passive aggressive', 'polite but', 'fake nice', 'pretending'],
  polite_refusal: ['no thanks', 'not interested', 'polite no', 'nahi chahiye', 'dont want'],
  exaggeration: ['exaggerat', 'overreact', 'over react', 'dramatic', 'drama'],
  rhetorical: ['not a question', 'wasnt asking', 'not asking', 'rhetorical'],
  ironic: ['ironic', 'irony'],
  understatement: ['understatement', 'bigger deal', 'more than it sounds'],
};

const EMOTION_WORDS = {
  angry: ['angry', 'anger', 'mad', 'furious', 'rage', 'pissed', 'gussa', 'gusa', 'ghussa', 'krodh'],
  frustrated: ['frustrat', 'fed up', 'tired of', 'sick of', 'pareshan', 'preshan', 'irritat', 'had enough', 'enough'],
  annoyed: ['annoy', 'irritated', 'bugged', 'chid', 'eye roll'],
  sad: ['sad', 'upset', 'dukhi', 'crying', 'cry', 'depressed', 'low', 'udaas', 'udas', 'down'],
  hurt: ['hurt', 'offended', 'bura laga', 'bura lga', 'insulted'],
  happy: ['happy', 'glad', 'khush', 'khushi', 'good mood', 'great mood', 'joy'],
  amused: ['funny', 'amused', 'lol', 'haha', 'hehe', 'laugh', 'mazaa', 'maza'],
  anxious: ['worried', 'worry', 'scared', 'afraid', 'tension', 'tensed', 'nervous', 'anxious', 'dar', 'darr', 'fikar', 'chinta'],
  smug: ['cocky', 'smug', 'show off', 'showing off', 'attitude', 'proud of myself', 'akad', 'ghamand'],
  embarrassed: ['embarrass', 'sharam', 'awkward', 'shy'],
  confused: ['confused', 'confuse', 'didnt understand', 'dont understand', 'samajh nahi', 'samjh nhi', 'lost'],
  grateful: ['thanks', 'thank you', 'thankful', 'grateful', 'shukriya', 'dhanyavad', 'dhanyawad'],
  excited: ['excited', 'cant wait', 'thrilled', 'pumped'],
  disappointed: ['disappoint', 'let down', 'expected better', 'nirash'],
  calm: ['calm', 'relaxed', 'fine', 'chill', 'okay', 'ok', 'theek', 'thik'],
  surprised: ['surprised', 'shocked', 'wow', 'omg'],
};

const EMOJI_EMOTION = Object.fromEntries(Object.entries(EMOTION_EMOJI).map(([e, emoji]) => [emoji, e]));
Object.assign(EMOJI_EMOTION, { '😡': 'angry', '🤬': 'angry', '😭': 'sad', '😂': 'amused', '🤣': 'amused', '😒': 'annoyed', '🥲': 'hurt', '😔': 'disappointed', '❤️': 'happy', '👍': 'calm', '😎': 'smug' });
const EMOJI_INTENT = { '😂': 'joking', '🤣': 'joking', '😜': 'teasing', '😝': 'teasing', '🙃': 'sarcastic', '😏': 'teasing', '🙄': 'sarcastic' };

export function normalize(text = '') {
  return text.toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function wordMatches(word, stem) {
  if (word === stem) return true;
  if (stem.length >= 5 && word.startsWith(stem)) return true;       // frustrat → frustrated
  if (word.length < 5 || stem.length < 5) return false;              // short words must match exactly
  const max = stem.length >= 7 ? 2 : 1;                               // small typos: angery, seriuos
  return editDistance(word, stem, max) <= max;
}

const NEGATORS = new Set(['not', 'no', 'nahi', 'nhi', 'never', 'na', 'dont', 'didnt', 'wasnt', 'isnt']);

const AFTER_NEGATORS = new Set(['nahi', 'nhi', 'na']); // Hindi puts the "not" after: "gussa nahi tha"

// A word counts unless something negates it: "not angry", "wasnt really serious", "gussa nahi".
const negatedAt = (words, i) => NEGATORS.has(words[i - 1]) || NEGATORS.has(words[i - 2]) || AFTER_NEGATORS.has(words[i + 1]);

function findTags(norm, words, table) {
  const found = [];
  for (const [tag, stems] of Object.entries(table)) {
    let hit = false;
    for (const stem of stems) {
      if (stem.includes(' ')) hit = ` ${norm} `.includes(` ${stem} `);
      else hit = words.some((w, i) => wordMatches(w, stem) && !negatedAt(words, i));
      if (hit) break;
    }
    if (hit) found.push(tag);
  }
  return found;
}

export function interpretOwnWords(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return { text: '', intents: [], emotions: [], understood: false };
  const norm = normalize(raw);
  const words = norm.split(' ').filter(Boolean);
  const intents = findTags(norm, words, INTENT_WORDS);
  let emotions = findTags(norm, words, EMOTION_WORDS);

  for (const ch of raw.match(/\p{Extended_Pictographic}️?/gu) || []) {
    const e = EMOJI_EMOTION[ch] || EMOJI_EMOTION[ch.replace('️', '')];
    if (e && !emotions.includes(e)) emotions.push(e);
    const i = EMOJI_INTENT[ch];
    if (i && !intents.includes(i)) intents.push(i);
  }
  // "calm"/"fine" alongside a strong feeling is usually sarcastic ("fine. whatever."), so drop it.
  if (emotions.length > 1) emotions = emotions.filter((e) => e !== 'calm');

  return { text: raw.slice(0, 300), intents: intents.slice(0, 5), emotions: emotions.slice(0, 5), understood: Boolean(intents.length || emotions.length) };
}

// ---------------------------------------------------------------- with Claude

const OWN_WORDS_SCHEMA = {
  type: 'object',
  properties: {
    intents: { type: 'array', items: { type: 'string', enum: INTENTS } },
    emotions: { type: 'array', items: { type: 'string', enum: EMOTIONS } },
    english: { type: 'string' },
    gist: { type: 'string' },
    language: { type: 'string' },
  },
  required: ['intents', 'emotions', 'english', 'gist', 'language'],
  additionalProperties: false,
};

const OWN_WORDS_SYSTEM = `You read short answers people type about what they meant or felt in a chat with an AI.
People type casually: any language or script (Hindi, Telugu, Tamil, Hinglish, Spanish…), spelling mistakes, no punctuation, emoji, slang.
Return:
- intents: the meanings they describe (empty if the answer is only about feelings).
- emotions: the feelings they describe (empty if none). Respect negation: "gussa nahi tha" means NOT angry.
- english: a faithful English translation of their answer.
- gist: the same answer as a short, plain, lowercase English phrase of 2 to 6 words, using the most common wording, so that different spellings and languages of the same answer get the same gist (e.g. "taana mar raha tha", "taana maar rahe the" and "I was taunting" all give "i was taunting").
- language: the language name, e.g. "Hinglish".
Only choose labels the words support; do not guess beyond them.`;

// Reads own words with Claude when it is connected (any language/script, better with slang),
// and falls back to the built-in word lists otherwise.
export async function readOwnWords(text, { kind = 'meaning', utterance, context } = {}) {
  const rules = interpretOwnWords(text);
  if (!rules.text) return { ...rules, source: 'none' };
  const convo = (context || []).slice(-4).map((t) => `${t.speaker}: ${t.text}`).join('\n');
  const prompt = [
    convo ? `The chat:\n${convo}` : '',
    utterance ? `The person had written: "${utterance}"` : '',
    `Asked ${kind === 'feeling' ? 'how they felt' : 'what they meant'}, they answered in their own words:\n"${rules.text}"`,
  ].filter(Boolean).join('\n\n');
  const ai = await askClaudeJson({ system: OWN_WORDS_SYSTEM, prompt, schema: OWN_WORDS_SCHEMA, maxTokens: 1500 });
  if (!ai) return { ...rules, source: 'rules' };
  const intents = [...new Set((ai.intents || []).filter((i) => INTENTS.includes(i)))].slice(0, 5);
  const emotions = [...new Set((ai.emotions || []).filter((e) => EMOTIONS.includes(e)))].slice(0, 5);
  return {
    text: rules.text,
    intents,
    emotions,
    understood: Boolean(intents.length || emotions.length),
    english: String(ai.english || '').slice(0, 300) || null,
    gist: normalize(String(ai.gist || '')).slice(0, 60) || null,
    language: String(ai.language || '').slice(0, 40) || null,
    source: 'claude',
  };
}
