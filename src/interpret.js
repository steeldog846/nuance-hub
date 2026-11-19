// Reads what a person typed in their own words ("i was just kidding", "gussa",
// "angery", "😡😡", "not seriuos") and finds the meanings and feelings in it.
// Built for everyday typing: misspellings, no punctuation, all lowercase,
// emoji, and common Hinglish words. Anything it can't place is still kept
// word-for-word and learned from.

import { EMOTION_EMOJI } from './taxonomy.js';

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
