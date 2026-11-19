// Progressive learning for in-conversation "quick checks".
//
// When a person's reply is unclear, the AI shows them a few one-tap choices
// ("I was being sarcastic 🙄", "I meant it 😊", ...). Every tap is remembered.
// The next time someone says something similar, the choices are re-ranked by
// what earlier people picked, and once enough people agree the AI stops asking
// and simply acts on what it has learned. If acting silently starts going
// wrong (people react "still missed the point"), it goes back to asking.

import { similarity } from './analyzer.js';
import { INTENT_PHRASES, EMOTION_EMOJI } from './taxonomy.js';

export const LEARNING = {
  minSimilarity: 0.35,  // how alike two situations must be to share lessons
  minEvidence: 5,       // people who must have answered before the AI may skip asking
  minShare: 0.8,        // share of them who must agree
  maxSilentMissRate: 0.2, // if silent guesses miss more than this, ask again
  maxOptions: 3,
};

const DEFAULT_EMOTION = {
  sincere: 'neutral', sarcastic: 'annoyed', ironic: 'amused', joking: 'amused',
  passive_aggressive: 'annoyed', rhetorical: 'frustrated', understatement: 'anxious',
  exaggeration: 'excited', polite_refusal: 'neutral', unclear: 'confused',
};
const FALLBACK_INTENTS = ['sincere', 'sarcastic', 'joking'];

const lastHuman = (context = []) => [...context].reverse().find((t) => t.speaker === 'human')?.text || '';

// How alike two situations are: mostly the message itself, partly what came before it.
export function situationSimilarity(a, b) {
  const s = similarity(a.utterance, b.utterance);
  const ca = lastHuman(a.context), cb = lastHuman(b.context);
  if (!ca || !cb) return s;
  return 0.75 * s + 0.25 * similarity(ca, cb);
}

export function optionLabel(intent, emotion) {
  return `${INTENT_PHRASES[intent] || intent} ${EMOTION_EMOJI[emotion] || ''}`.trim();
}

// memory: { checks: [...answered checks], resolved: [...community-resolved queries] }
export function recall(situation, memory, opts = LEARNING) {
  const votes = new Map(); // "intent|emotion" -> weight
  let people = 0;
  let totalWeight = 0;
  const neighbours = [];
  const vote = (intent, emotion, w) => {
    const k = `${intent}|${emotion}`;
    votes.set(k, (votes.get(k) || 0) + w);
    totalWeight += w;
  };

  for (const c of memory.checks) {
    const s = situationSimilarity(situation, c);
    if (s < opts.minSimilarity) continue;
    neighbours.push({ c, s });
    if (c.choice) { vote(c.choice.intent, c.choice.emotion, s); people++; }
    // Acting without asking and hearing "that helped" quietly confirms the guess.
    else if (!c.asked && c.reaction === 'helpful' && c.suggested) { vote(c.suggested.intent, c.suggested.emotion, s * 0.5); people++; }
  }
  for (const q of memory.resolved) {
    const s = situationSimilarity(situation, q);
    if (s < opts.minSimilarity) continue;
    const n = Math.min(q.consensus.labelCount, 3);
    vote(q.consensus.intent, q.consensus.emotion, s * n);
    people += n;
  }

  const ranked = [...votes.entries()]
    .map(([k, w]) => { const [intent, emotion] = k.split('|'); return { intent, emotion, share: totalWeight ? w / totalWeight : 0 }; })
    .sort((a, b) => b.share - a.share);

  // Collapse to one emotion per intent: one tap should mean one thing.
  const byIntent = new Map();
  for (const r of ranked) {
    const cur = byIntent.get(r.intent);
    if (!cur) byIntent.set(r.intent, { ...r });
    else cur.share += r.share;
  }
  const intents = [...byIntent.values()].sort((a, b) => b.share - a.share);

  const silent = neighbours.filter(({ c }) => !c.asked && c.reaction);
  const silentMissRate = silent.length ? silent.filter(({ c }) => c.reaction !== 'helpful').length / silent.length : 0;

  // What the AI said afterwards that people rated, in similar situations.
  const replies = (reaction) => neighbours
    .filter(({ c }) => c.reaction === reaction && c.aiFollowUp)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map(({ c }) => ({ response: c.aiFollowUp, meaning: c.choice || c.suggested }));

  return { intents, people, silentMissRate, whatWorked: replies('helpful'), whatMissed: replies('missed') };
}

// Builds the quick check the AI shows (or decides it doesn't need to show).
export function buildQuickCheck(situation, appAnswer, memory, opts = LEARNING) {
  const learned = recall(situation, memory, opts);
  const top = learned.intents[0];

  const options = [];
  const add = (intent, emotion, share, basis) => {
    if (options.length >= opts.maxOptions || options.some((o) => o.intent === intent) || intent === 'unclear') return;
    options.push({ id: `o${options.length + 1}`, label: optionLabel(intent, emotion), intent, emotion, learnedShare: share === null ? null : +share.toFixed(2), basis });
  };
  for (const i of learned.intents) add(i.intent, i.emotion, i.share, 'learned');
  add(appAnswer.intent, appAnswer.emotion, null, appAnswer.source);
  for (const intent of FALLBACK_INTENTS) add(intent, intent === 'sincere' && appAnswer.intent === 'sincere' ? appAnswer.emotion : DEFAULT_EMOTION[intent], null, 'default');

  const confident = top && learned.people >= opts.minEvidence && top.share >= opts.minShare;
  const shouldAsk = !(confident && learned.silentMissRate <= opts.maxSilentMissRate);

  const suggested = confident
    ? { intent: top.intent, emotion: top.emotion, confidence: +top.share.toFixed(2), basis: `${learned.people} people in similar situations` }
    : { intent: options[0].intent, emotion: options[0].emotion, confidence: top ? +top.share.toFixed(2) : appAnswer.confidence, basis: top ? `${learned.people} similar answers so far` : appAnswer.source };

  let reason;
  if (!shouldAsk) reason = `${Math.round(top.share * 100)}% of ${learned.people} people in similar situations meant this.`;
  else if (confident) reason = 'People usually mean this here, but acting on it without asking has recently gone wrong, so asking again.';
  else if (learned.people && top.share >= opts.minShare) {
    const n = learned.people;
    reason = `${n} ${n === 1 ? 'person' : 'people'} in similar situations agreed so far. Asking until ${opts.minEvidence} have, to be sure.`;
  } else if (learned.people) {
    const n = learned.people;
    reason = `${n} similar ${n === 1 ? 'answer' : 'answers'} so far, but they don't agree yet. Asking helps the next person.`;
  }
  else reason = 'First time seeing a situation like this. Asking teaches every connected AI.';

  return {
    shouldAsk,
    reason,
    prompt: 'Quick check so I get this right. Did you mean…',
    options,
    otherOption: { id: 'other', label: 'Something else' },
    suggested,
    evidence: { similarAnswers: learned.people, silentMissRate: +learned.silentMissRate.toFixed(2) },
    whatWorked: learned.whatWorked,
    whatMissed: learned.whatMissed,
  };
}
