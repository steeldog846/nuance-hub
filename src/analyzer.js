// The app's own "first answer" to an agent's question. It combines three
// sources, strongest first:
//   1. precedent  – similar questions the human community already resolved
//   2. llm        – Claude (if ANTHROPIC_API_KEY is set and the SDK installed)
//   3. heuristic  – built-in cue rules, always available offline
// The result is shown to human labelers, who confirm or correct it.

import { INTENTS, EMOTIONS } from './taxonomy.js';
import { analyzeTyping } from './style.js';
import { askClaudeJson } from './claude.js';

// ---------------------------------------------------------------- heuristic

const CUES = [
  { re: /\b(oh )?(great|wonderful|fantastic|perfect|lovely|brilliant)[.!]*\s*(just|another|now|exactly)?\b.*\b(again|another|broke|late|monday|traffic|fail|crash|rain|wait)/i, intent: 'sarcastic', emotion: 'annoyed', why: 'positive word paired with a negative situation' },
  { re: /\b(great|perfect|wonderful|fantastic|lovely|brilliant|nice)\b.*\b(as (always|usual)|of course|just what|my favou?rite)\b/i, intent: 'sarcastic', emotion: 'annoyed', why: 'praise paired with "as always"/"of course"' },
  { re: /\b(yeah|sure|right),? (right|sure)\b/i, intent: 'sarcastic', emotion: 'annoyed', why: '"yeah right"-style dismissal' },
  { re: /\b(thanks a lot|thanks for nothing|just what i needed|how nice of you|wow,? (thanks|great))\b/i, intent: 'sarcastic', emotion: 'frustrated', why: 'stock sarcastic phrase' },
  { re: /\b(as i (already )?said|per my last|fine\.|whatever\.?|no worries,? i'?ll do it myself|must be nice)\b/i, intent: 'passive_aggressive', emotion: 'annoyed', why: 'polite surface with irritation underneath' },
  { re: /\b(lol|lmao|haha+|jk|just kidding|😂|🤣)\b/i, intent: 'joking', emotion: 'amused', why: 'laughter or joke marker' },
  { re: /\b(maybe (some ?time|later|next time)|i'?ll think about it|we'?ll see)\b/i, intent: 'polite_refusal', emotion: 'neutral', why: 'non-committal phrasing often means no' },
  { re: /\b(literally (dying|dead)|million times|forever|worst .* ever|best .* ever)\b/i, intent: 'exaggeration', emotion: 'excited', why: 'hyperbole' },
  { re: /\b(not bad|could be worse|a bit of a)\b/i, intent: 'understatement', emotion: 'calm', why: 'understatement' },
  { re: /\b(who cares|what'?s the point|why even bother)\?/i, intent: 'rhetorical', emotion: 'disappointed', why: 'question not seeking an answer' },
];

const EMOTION_WORDS = {
  happy: /\b(happy|glad|love|yay|awesome|great day|😊|😀|❤️)\b/i,
  grateful: /\b(thank you so much|grateful|appreciate)\b/i,
  angry: /\b(furious|angry|hate|unacceptable|ridiculous|😡|🤬)\b|!!!/i,
  frustrated: /\b(frustrat|again\?|still not|keeps? (failing|breaking))/i,
  sad: /\b(sad|miss|lonely|cry|😢|😭|heartbroken)\b/i,
  anxious: /\b(worried|nervous|anxious|scared|afraid)\b/i,
  confused: /\b(confused|don'?t (get|understand)|what do you mean|huh\?)\b/i,
  excited: /\b(can'?t wait|so excited|omg|!{2})\b/i,
};

const POSITIVE = /\b(great|perfect|wonderful|fantastic|lovely|brilliant|awesome|amazing|love it|nice)\b/i;
const BAD_SITUATION = /\b(crash|broke|broken|fail|failed|late|delay|restart|lost|cancel|error|stuck|again|middle of|weeks?|wrong|down)\b/i;

export function heuristicAnalyze(utterance, context = []) {
  const text = utterance || '';
  const typing = analyzeTyping(text);
  if (typing.style === 'mocking_case') {
    return { source: 'heuristic', intent: 'sarcastic', emotion: 'annoyed', confidence: 0.6, explanation: 'Mixed-up capitals (mOcKiNg case) usually mean mockery.' };
  }
  const loud = typing.emphasis >= 2;
  // Praise right after the person described something going wrong is the most common sarcasm pattern.
  const lastHuman = [...context].reverse().find((t) => t.speaker === 'human')?.text || '';
  if (POSITIVE.test(text) && BAD_SITUATION.test(lastHuman) && !BAD_SITUATION.test(text)) {
    return { source: 'heuristic', intent: 'sarcastic', emotion: loud ? 'angry' : 'frustrated', confidence: 0.5, explanation: `Positive words right after the person described something going wrong${loud ? ', typed loudly' : ''}.` };
  }
  for (const cue of CUES) {
    if (cue.re.test(text)) {
      return {
        source: 'heuristic',
        intent: cue.intent,
        emotion: loud && ['annoyed', 'frustrated'].includes(cue.emotion) ? 'angry' : cue.emotion,
        confidence: 0.45,
        explanation: `Cue detected: ${cue.why}${typing.note ? `; ${typing.note}` : ''}.`,
      };
    }
  }
  for (const [emotion, re] of Object.entries(EMOTION_WORDS)) {
    if (re.test(text)) {
      return { source: 'heuristic', intent: 'sincere', emotion, confidence: 0.35, explanation: `Emotion word suggests "${emotion}". No sarcasm cue found.` };
    }
  }
  return { source: 'heuristic', intent: 'unclear', emotion: 'neutral', confidence: 0.15, explanation: 'No strong cue found; needs human judgement.' };
}

// ---------------------------------------------------------------- precedent

const STOP = new Set('a an the and or but i you he she it we they is are was were be to of in on at for with this that so just my your me oh'.split(' '));

export function tokens(text) {
  return new Set((text || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)));
}

export function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function precedentAnalyze(utterance, resolvedQueries, threshold = 0.6) {
  let best = null;
  for (const q of resolvedQueries) {
    const s = similarity(utterance, q.utterance);
    if (s >= threshold && (!best || s > best.score)) best = { q, score: s };
  }
  if (!best) return null;
  const c = best.q.consensus;
  return {
    source: 'precedent',
    intent: c.intent,
    emotion: c.emotion,
    confidence: Math.min(0.95, c.agreement * best.score),
    explanation: `A very similar message ("${best.q.utterance}") was resolved by ${c.labelCount} people as ${c.intent}/${c.emotion}.`,
    precedentId: best.q.id,
  };
}

// ---------------------------------------------------------------- Claude

const SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: INTENTS },
    emotion: { type: 'string', enum: EMOTIONS },
    confidence: { type: 'number' },
    explanation: { type: 'string' },
  },
  required: ['intent', 'emotion', 'confidence', 'explanation'],
  additionalProperties: false,
};

export async function llmAnalyze(query) {
  const context = (query.context || []).map((t) => `${t.speaker}: ${t.text}`).join('\n');
  const typing = query.typing || analyzeTyping(query.utterance);
  const prompt = [
    'An AI assistant had this conversation with a person and could not tell what the person really meant.',
    context ? `Conversation so far:\n${context}` : '',
    `The message in question, exactly as typed:\n"${query.utterance}"`,
    typing.note ? `How it was typed: ${typing.note}. Capitals and punctuation are part of the meaning.` : '',
    query.agentGuess ? `The assistant's own guess was: ${query.agentGuess}` : '',
    query.question ? `The assistant asks: ${query.question}` : '',
    "Judge the speaker's real intent (e.g. sincere vs sarcastic) and dominant emotion. Explain in one or two plain sentences which cues tell you. Confidence is 0 to 1.",
  ].filter(Boolean).join('\n\n');
  const parsed = await askClaudeJson({ prompt, schema: SCHEMA });
  if (!parsed || !INTENTS.includes(parsed.intent) || !EMOTIONS.includes(parsed.emotion)) return null;
  return { source: 'llm', ...parsed, confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)) };
}

export async function analyze(query, resolvedQueries) {
  return (
    precedentAnalyze(query.utterance, resolvedQueries) ||
    (await llmAnalyze(query)) ||
    heuristicAnalyze(query.utterance, query.context)
  );
}
