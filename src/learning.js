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
import { analyzeTyping, styleAffinity } from './style.js';
import { interpretOwnWords, normalize } from './interpret.js';

export const LEARNING = {
  minSimilarity: 0.35,  // how alike two situations must be to share lessons
  minEvidence: 5,       // people who must have answered before the AI may skip asking
  minShare: 0.8,        // share of them who must agree
  maxSilentMissRate: 0.2, // if silent guesses miss more than this, ask again
  maxOptions: 3,
  maxFeelings: 4,
  sameStyle: 0.85,
  minPhrasePeople: 2,     // people who must use the same own words before they become a tap option
  maxPhrases: 2,        // style affinity needed for someone to count toward "no need to ask"
};

const pretty = (s) => s.replace(/_/g, ' ');
const EMOTION_LABEL = { smug: 'cocky' };
export const feelingLabel = (e) => `${EMOTION_EMOJI[e] || ''} ${EMOTION_LABEL[e] || pretty(e)}`.trim();

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

// Emoji first, short words after: easy to recognise even for people who don't read much.
export function optionLabel(intent, emotion) {
  return `${EMOTION_EMOJI[emotion] || ''} ${INTENT_PHRASES[intent] || intent}`.trim();
}

const intentsIn = (m) => m?.intents?.length ? m.intents : [m?.intent].filter(Boolean);
const emotionsIn = (m) => m?.emotions?.length ? m.emotions : [m?.emotion].filter(Boolean);

// memory: { checks: [...answered checks], resolved: [...community-resolved queries] }
export function recall(situation, memory, opts = LEARNING) {
  const typing = situation.typing || analyzeTyping(situation.utterance);
  const intentVotes = new Map();
  const emotionVotes = new Map();
  const pairVotes = new Map(); // intent -> Map(emotion -> weight): each meaning's usual feeling
  let intentTotal = 0;
  let emotionTotal = 0;
  let people = 0;
  const phrases = { meaning: new Map(), feeling: new Map() }; // normalized own words -> { text, people }
  let sameStylePeople = 0;
  const neighbours = [];

  const add = (map, k, w) => map.set(k, (map.get(k) || 0) + w);
  const learnFrom = (meaning, w, count, affinity) => {
    const intents = intentsIn(meaning), emotions = emotionsIn(meaning);
    if (!intents.length && !emotions.length) return;
    if (intents.length) intentTotal += w;
    if (emotions.length) emotionTotal += w;
    for (const i of new Set(intents)) {
      add(intentVotes, i, w);
      if (!pairVotes.has(i)) pairVotes.set(i, new Map());
      for (const e of emotions) add(pairVotes.get(i), e, w);
    }
    for (const e of new Set(emotions)) add(emotionVotes, e, w);
    people += count;
    if (affinity >= opts.sameStyle) sameStylePeople += count;
  };

  for (const c of memory.checks) {
    const s = situationSimilarity(situation, c);
    if (s < opts.minSimilarity) continue;
    const affinity = styleAffinity(typing, c.typing || analyzeTyping(c.utterance));
    neighbours.push({ c, s, affinity });
    // People's own words, so phrases many people use can become options for the next person.
    for (const kind of ['meaning', 'feeling']) {
      const text = c.ownWords?.[kind];
      if (!text) continue;
      const k = normalize(text);
      if (!k) continue;
      const cur = phrases[kind].get(k) || { text, people: 0 };
      cur.people++;
      phrases[kind].set(k, cur);
    }
    if (c.choice) learnFrom(c.choice, s * affinity, 1, affinity);
    // Acting without asking and hearing "that helped" quietly confirms the guess.
    else if (!c.asked && c.reaction === 'helpful' && c.suggested) learnFrom(c.suggested, s * affinity * 0.5, 1, affinity);
  }
  for (const q of memory.resolved) {
    const s = situationSimilarity(situation, q);
    if (s < opts.minSimilarity) continue;
    const affinity = styleAffinity(typing, q.typing || analyzeTyping(q.utterance));
    const n = Math.min(q.consensus.labelCount, 3);
    learnFrom(q.consensus, s * affinity * n, n, affinity);
  }

  const ranked = (map, total) => [...map.entries()]
    .map(([k, w]) => ({ key: k, share: total ? Math.min(1, w / total) : 0 }))
    .sort((a, b) => b.share - a.share);
  const usualFeeling = (intent) => [...(pairVotes.get(intent) || new Map()).entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const intents = ranked(intentVotes, intentTotal).map(({ key, share }) => ({ intent: key, emotion: usualFeeling(key), share }));
  const emotions = ranked(emotionVotes, emotionTotal).map(({ key, share }) => ({ emotion: key, share }));
  const popular = (kind) => [...phrases[kind].values()]
    .filter((p) => p.people >= opts.minPhrasePeople)
    .sort((a, b) => b.people - a.people)
    .slice(0, opts.maxPhrases);

  const silent = neighbours.filter(({ c, affinity }) => !c.asked && c.reaction && affinity >= opts.sameStyle);
  const silentMissRate = silent.length ? silent.filter(({ c }) => c.reaction !== 'helpful').length / silent.length : 0;

  // What the AI said afterwards that people rated, in similar situations (same typing style first).
  const replies = (reaction) => neighbours
    .filter(({ c }) => c.reaction === reaction && c.aiFollowUp)
    .sort((a, b) => b.s * b.affinity - a.s * a.affinity)
    .slice(0, 3)
    .map(({ c }) => ({ response: c.aiFollowUp, meaning: c.choice || c.suggested, typedAs: c.typing?.style }));

  return {
    typing, intents, emotions, people, sameStylePeople, silentMissRate,
    peopleSaid: { meaning: popular('meaning'), feeling: popular('feeling') },
    whatWorked: replies('helpful'), whatMissed: replies('missed'),
  };
}

// Feelings people tend to have when they type a certain way.
function styleFeelings(typing) {
  if (typing.style === 'all_caps' || typing.emphasis >= 2) return ['angry', 'frustrated', 'excited'];
  if (typing.style === 'stressed_words') return ['frustrated', 'annoyed'];
  if (typing.style === 'mocking_case') return ['annoyed', 'smug', 'amused'];
  return [];
}

// Builds the quick check the AI shows (or decides it doesn't need to show).
export function buildQuickCheck(situation, appAnswer, memory, opts = LEARNING) {
  const learned = recall(situation, memory, opts);
  const { typing } = learned;
  const top = learned.intents[0];

  const options = [];
  const add = (intent, emotion, share, basis) => {
    if (!intent || options.length >= opts.maxOptions || options.some((o) => o.intent === intent) || intent === 'unclear') return;
    // The label's emoji stays the meaning's own (sarcastic 🙄, joking 😄), so choices look the same every time;
    // feelings are picked separately.
    options.push({ id: `o${options.length + 1}`, label: optionLabel(intent, DEFAULT_EMOTION[intent] || emotion), intent, emotion, learnedShare: share === null ? null : +share.toFixed(2), basis });
  };
  for (const i of learned.intents) add(i.intent, i.emotion || DEFAULT_EMOTION[i.intent], i.share, 'learned');
  add(appAnswer.intent, appAnswer.emotion, null, appAnswer.source);
  if (typing.style === 'mocking_case') add('sarcastic', 'annoyed', null, 'typing');
  for (const intent of FALLBACK_INTENTS) add(intent, intent === 'sincere' && appAnswer.intent === 'sincere' ? appAnswer.emotion : DEFAULT_EMOTION[intent], null, 'default');

  // Optional second row: how they felt. Several can be tapped.
  const feelingOptions = [];
  const addFeeling = (emotion, share, basis) => {
    if (!emotion || feelingOptions.length >= opts.maxFeelings || feelingOptions.some((f) => f.emotion === emotion)) return;
    feelingOptions.push({ id: `f${feelingOptions.length + 1}`, label: feelingLabel(emotion), emotion, learnedShare: share === null ? null : +share.toFixed(2), basis });
  };
  for (const e of learned.emotions) addFeeling(e.emotion, e.share, 'learned');
  for (const e of styleFeelings(typing)) addFeeling(e, null, 'typing');
  addFeeling(appAnswer.emotion, null, appAnswer.source);
  for (const o of options) addFeeling(o.emotion, null, 'default');
  for (const e of ['amused', 'neutral']) addFeeling(e, null, 'default');

  // Words other people typed themselves in this situation, offered as one more tap.
  learned.peopleSaid.meaning.forEach((p, i) => {
    const read = interpretOwnWords(p.text);
    options.push({ id: `p${i + 1}`, label: `💬 ${p.text}`, text: p.text, intent: read.intents[0] || null, intents: read.intents, emotions: read.emotions, people: p.people, basis: 'people_said' });
  });
  learned.peopleSaid.feeling.forEach((p, i) => {
    const read = interpretOwnWords(p.text);
    feelingOptions.push({ id: `pf${i + 1}`, label: `💬 ${p.text}`, text: p.text, emotion: read.emotions[0] || null, emotions: read.emotions, people: p.people, basis: 'people_said' });
  });

  // Only people who typed it a similar way count toward skipping the question:
  // "fantastic, late again" and "FANTASTIC, LATE AGAIN!!" are learned separately.
  const confident = top && learned.sameStylePeople >= opts.minEvidence && top.share >= opts.minShare;
  const shouldAsk = !(confident && learned.silentMissRate <= opts.maxSilentMissRate);

  const tagsOver = (list, key, fallback) => {
    const tags = list.filter((x) => x.share >= 0.5).map((x) => x[key]);
    return tags.length ? tags : [fallback];
  };
  const intensity = Math.min(5, 2 + typing.emphasis + (typing.style === 'mocking_case' ? 1 : 0));
  const suggested = top
    ? {
        intent: top.intent,
        emotion: learned.emotions[0]?.emotion || top.emotion,
        intents: tagsOver(learned.intents, 'intent', top.intent),
        emotions: tagsOver(learned.emotions, 'emotion', top.emotion),
        intensity,
        confidence: +top.share.toFixed(2),
        basis: `${learned.people} similar answers (${learned.sameStylePeople} typed the same way)`,
      }
    : { intent: options[0].intent, emotion: options[0].emotion, intents: [options[0].intent], emotions: [options[0].emotion], intensity, confidence: appAnswer.confidence, basis: appAnswer.source };

  const n = learned.sameStylePeople;
  const typedNote = !['plain', 'all_lower'].includes(typing.style) ? ` typed ${typing.style === 'all_caps' ? 'in ALL CAPS' : typing.style === 'stressed_words' ? 'with words in CAPITALS' : typing.style === 'mocking_case' ? 'in mOcKiNg case' : 'in lowercase'}` : '';
  let reason;
  if (!shouldAsk) reason = `${Math.round(top.share * 100)}% of ${n} people who wrote something similar${typedNote} meant this.`;
  else if (confident) reason = 'People usually mean this here, but acting on it without asking has recently gone wrong, so asking again.';
  else if (top && learned.people > n && learned.people >= opts.minEvidence) {
    reason = `${learned.people} people answered for similar words, but ${n === 0 ? 'none of them' : `only ${n} of them`}${typedNote || ' typed it this way'}. The way it's typed can change the meaning, so asking.`;
  } else if (top && top.share >= opts.minShare) {
    reason = `${n} ${n === 1 ? 'person' : 'people'} who wrote something similar, typed a similar way, agreed so far. Asking until ${opts.minEvidence} have, to be sure.`;
  } else if (top) {
    reason = `${learned.people} similar ${learned.people === 1 ? 'answer' : 'answers'} so far, but they don't agree yet. Asking helps the next person.`;
  } else reason = 'First time seeing a situation like this. Asking teaches every connected AI.';

  return {
    shouldAsk,
    reason,
    prompt: 'Quick check so I get this right. Did you mean… (tap all that fit)',
    feelingPrompt: 'And how did you feel? (optional)',
    ownMeaningPrompt: 'Or say it your way',
    ownFeelingPrompt: 'Or your own feeling',
    options,
    feelingOptions,
    otherOption: { id: 'other', label: 'Something else' },
    suggested,
    typing,
    evidence: { similarAnswers: learned.people, sameTypingStyle: n, silentMissRate: +learned.silentMissRate.toFixed(2) },
    whatWorked: learned.whatWorked,
    whatMissed: learned.whatMissed,
  };
}
