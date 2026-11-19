// Turns many human labels into one answer an AI can learn from.
//
// People can pick several meanings and feelings at once ("sarcastic AND
// teasing", "angry AND hurt"), because real messages mix them. Each tag's
// share is the trust-weighted fraction of people who picked it, so shares
// don't add up to 100%. Every tag picked by at least half the people is
// part of the answer.
//
// Votes are weighted by the labeler's reputation, which rises when they
// agree with the final consensus and falls when they don't.

export const DEFAULTS = {
  minLabels: 3,        // votes needed before a question can resolve
  minAgreement: 0.6,   // share of weighted voters who must include the leading meaning
  tagThreshold: 0.5,   // a meaning/feeling is part of the answer if this share picked it
};

// Older single-choice labels keep working.
export const intentsOf = (l) => l.intents?.length ? l.intents : [l.intent].filter(Boolean);
export const emotionsOf = (l) => l.emotions?.length ? l.emotions : [l.emotion].filter(Boolean);

function tally(labels, pick, weightOf) {
  const counts = {};
  let total = 0;
  for (const l of labels) {
    const w = weightOf(l);
    total += w;
    for (const tag of new Set(pick(l))) counts[tag] = (counts[tag] || 0) + w;
  }
  const dist = {};
  for (const [k, v] of Object.entries(counts)) dist[k] = total ? +(v / total).toFixed(3) : 0;
  const ordered = Object.entries(dist).sort((a, b) => b[1] - a[1]);
  return { top: ordered[0]?.[0] ?? null, share: ordered[0]?.[1] ?? 0, dist, ordered };
}

export function computeConsensus(labels, weightOf = () => 1, opts = DEFAULTS) {
  if (!labels.length) return null;
  const intent = tally(labels, intentsOf, weightOf);
  const emotion = tally(labels, emotionsOf, weightOf);
  const intensity = labels.reduce((s, l) => s + (l.intensity || 0), 0) / labels.length;
  const verdicts = labels.filter((l) => l.appAnswerVerdict);
  const appAnswerAccuracy = verdicts.length
    ? +(verdicts.filter((l) => l.appAnswerVerdict === 'correct').length / verdicts.length).toFixed(3)
    : null;

  const chosen = (t) => {
    const tags = t.ordered.filter(([, v]) => v >= (opts.tagThreshold ?? 0.5)).map(([k]) => k);
    return tags.length ? tags : [t.top];
  };

  // The best-trusted written explanations from people who included the leading meaning.
  const explanations = labels
    .filter((l) => intentsOf(l).includes(intent.top) && l.explanation)
    .sort((a, b) => weightOf(b) - weightOf(a))
    .slice(0, 3)
    .map((l) => l.explanation);

  const agreement = +((intent.share + emotion.share) / 2).toFixed(3);
  const resolved = labels.length >= opts.minLabels && intent.share >= opts.minAgreement;

  return {
    intent: intent.top,          // the leading meaning
    emotion: emotion.top,        // the leading feeling
    intents: chosen(intent),     // every meaning at least half the people picked
    emotions: chosen(emotion),
    intensity: +intensity.toFixed(2),
    intentDistribution: intent.dist,
    emotionDistribution: emotion.dist,
    agreement,
    labelCount: labels.length,
    appAnswerAccuracy,
    explanations,
    resolved,
  };
}

// New reputation after a question resolves. Bounded so nobody dominates.
export function updatedReputation(current, agreedWithConsensus) {
  const next = agreedWithConsensus ? current + 0.1 : current - 0.15;
  return +Math.max(0.2, Math.min(3, next)).toFixed(2);
}
