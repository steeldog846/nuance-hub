// Turns many human labels into one answer an AI can learn from.
// Each vote is weighted by the labeler's reputation, which rises when
// they agree with the final consensus and falls when they don't.

export const DEFAULTS = {
  minLabels: 3,        // votes needed before a question can resolve
  minAgreement: 0.6,   // share of weighted votes the winning intent needs
};

function tally(labels, field, weightOf) {
  const counts = {};
  let total = 0;
  for (const l of labels) {
    const w = weightOf(l);
    counts[l[field]] = (counts[l[field]] || 0) + w;
    total += w;
  }
  const dist = {};
  let top = null;
  for (const [k, v] of Object.entries(counts)) {
    dist[k] = total ? +(v / total).toFixed(3) : 0;
    if (!top || v > counts[top]) top = k;
  }
  return { top, share: top ? dist[top] : 0, dist };
}

export function computeConsensus(labels, weightOf = () => 1, opts = DEFAULTS) {
  if (!labels.length) return null;
  const intent = tally(labels, 'intent', weightOf);
  const emotion = tally(labels, 'emotion', weightOf);
  const intensity = labels.reduce((s, l) => s + (l.intensity || 0), 0) / labels.length;
  const verdicts = labels.filter((l) => l.appAnswerVerdict);
  const appAnswerAccuracy = verdicts.length
    ? +(verdicts.filter((l) => l.appAnswerVerdict === 'correct').length / verdicts.length).toFixed(3)
    : null;

  // The most-agreed-with written explanations from people who picked the winning intent.
  const explanations = labels
    .filter((l) => l.intent === intent.top && l.explanation)
    .sort((a, b) => weightOf(b) - weightOf(a))
    .slice(0, 3)
    .map((l) => l.explanation);

  const agreement = +((intent.share + emotion.share) / 2).toFixed(3);
  const resolved = labels.length >= opts.minLabels && intent.share >= opts.minAgreement;

  return {
    intent: intent.top,
    emotion: emotion.top,
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
