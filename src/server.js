import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from './store.js';
import { redact } from './redact.js';
import { analyze, similarity } from './analyzer.js';
import { computeConsensus, updatedReputation, intentsOf, DEFAULTS } from './consensus.js';
import { analyzeTyping, STYLES } from './style.js';
import { readOwnWords } from './interpret.js';
import { claudeStatus } from './claude.js';
import { handleMcpMessage } from './mcp.js';
import { buildQuickCheck } from './learning.js';
import { openApiSpec } from './openapi.js';
import { INTENTS, EMOTIONS, DIFFICULTY_TYPES, MODALITIES, PLATFORMS, REACTIONS, INTENT_PHRASES, EMOTION_EMOJI, isValidIntent, isValidEmotion } from './taxonomy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_LABELS = 7;        // after this many votes without agreement -> "disputed"
const MAX_BODY = 64 * 1024;
const PI_API = process.env.PI_API_URL || 'https://api.minepi.com';

const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const newSecret = (prefix) => `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function str(v, field, { max = 2000, required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `"${field}" is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new HttpError(400, `"${field}" must be a string`);
  if (v.length > max) throw new HttpError(400, `"${field}" is longer than ${max} characters`);
  return v.trim();
}

function oneOf(v, field, allowed, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (!allowed.includes(v)) throw new HttpError(400, `"${field}" must be one of ${allowed.join(', ')}`);
  return v;
}

function parseContext(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(-20).map((t, i) => ({
    speaker: str(t?.speaker, `context[${i}].speaker`, { max: 40 }) === 'ai' ? 'ai' : 'human',
    text: redact(str(t?.text, `context[${i}].text`, { max: 2000 })),
  }));
}

// People may pick several meanings and feelings: "intents": [...], "emotions": [...].
// A single "intent"/"emotion" still works.
function tagList(body, many, one, valid, all, extra = [], allowEmpty = false) {
  const raw = Array.isArray(body[many]) ? body[many] : body[one] !== undefined ? [body[one]] : [];
  const list = [...new Set([...raw, ...extra])];
  if (!list.length && allowEmpty) return list;
  if (!list.length) throw new HttpError(400, `Pick at least one, or say it in your own words: "${many}" (any of ${all.join(', ')})`);
  if (list.length > 5) throw new HttpError(400, `Pick at most 5 for "${many}"`);
  for (const v of list) if (!valid(v)) throw new HttpError(400, `"${v}" is not one of ${all.join(', ')}`);
  return list;
}

// Own words ("ownMeaning", "ownFeeling") can replace or add to the taps. They are read for
// meanings/feelings (misspellings, emoji, Hinglish ok) and always kept word-for-word.
// Claude reads them when connected (any language or script); built-in word lists otherwise.
async function parseOwnWords(body, situation = {}) {
  const meaning = redact(str(body.ownMeaning, 'ownMeaning', { max: 300, required: false }) || '');
  const feeling = redact(str(body.ownFeeling, 'ownFeeling', { max: 300, required: false }) || '');
  const [m, f] = await Promise.all([
    readOwnWords(meaning, { kind: 'meaning', ...situation }),
    readOwnWords(feeling, { kind: 'feeling', ...situation }),
  ]);
  const read = (r) => (r.text ? { intents: r.intents, emotions: r.emotions, english: r.english || null, gist: r.gist || null, language: r.language || null, by: r.source } : null);
  return {
    words: meaning || feeling ? { meaning: meaning || null, feeling: feeling || null, read: { meaning: read(m), feeling: read(f) } } : null,
    intents: m.intents,
    emotions: [...new Set([...f.emotions, ...m.emotions])],
    meaningUnread: Boolean(meaning) && !m.intents.length,
  };
}

async function parseLabel(body, situation) {
  const own = await parseOwnWords(body, situation);
  // Own words that can't be read yet still count: the meaning is recorded as "unclear" plus the words themselves.
  const intents = tagList(body, 'intents', 'intent', isValidIntent, INTENTS, own.intents.length ? own.intents : own.words?.meaning ? ['unclear'] : []);
  const emotions = tagList(body, 'emotions', 'emotion', isValidEmotion, EMOTIONS, own.emotions.length ? own.emotions : own.words?.feeling ? ['neutral'] : []);
  const intensity = Number(body.intensity ?? 3);
  if (!Number.isInteger(intensity) || intensity < 1 || intensity > 5) throw new HttpError(400, '"intensity" must be 1-5');
  return {
    intent: intents[0],
    emotion: emotions[0],
    intents,
    emotions,
    intensity,
    explanation: redact(str(body.explanation, 'explanation', { max: 600, required: false })),
    ownWords: own.words,
  };
}

// ----------------------------------------------------------------- views

// What an AI agent sees about one of its questions.
function queryView(q) {
  return {
    id: q.id,
    status: q.status,
    origin: q.origin,
    platform: q.platform,
    utterance: q.utterance,
    question: q.question,
    difficulty: q.difficulty,
    createdAt: q.createdAt,
    resolvedAt: q.resolvedAt || null,
    appAnswer: q.appAnswer,
    consensus: q.consensus,
  };
}

// What a human labeler sees before voting (no other people's votes, to avoid bias).
function taskView(q) {
  return {
    id: q.id,
    origin: q.origin,
    platform: q.platform,
    utterance: q.utterance,
    typing: q.typing,
    context: q.context,
    question: q.question,
    difficulty: q.difficulty,
    modality: q.modality,
    locale: q.locale,
    agentGuess: q.agentGuess,
    appAnswer: q.appAnswer,
    labelCount: q.labelCount,
  };
}

// One settled question as a training example.
function learningView(q) {
  return {
    id: q.id,
    origin: q.origin,
    platform: q.platform,
    input: { context: q.context, utterance: q.utterance, typing: q.typing || analyzeTyping(q.utterance), locale: q.locale, modality: q.modality },
    ai_misreading: q.agentGuess || null,
    label: {
      intent: q.consensus.intent,
      emotion: q.consensus.emotion,
      intents: q.consensus.intents || [q.consensus.intent],
      emotions: q.consensus.emotions || [q.consensus.emotion],
      intensity: q.consensus.intensity,
      intent_distribution: q.consensus.intentDistribution,
      emotion_distribution: q.consensus.emotionDistribution,
      agreement: q.consensus.agreement,
      human_explanations: q.consensus.explanations,
    },
    status: q.status,
    resolved_at: q.resolvedAt,
  };
}

// What the AI gets back from a quick check.
function checkView(c, base) {
  return {
    id: c.id,
    shouldAsk: c.asked,
    reason: c.reason,
    prompt: c.prompt,
    options: c.options,
    feelingPrompt: c.feelingPrompt,
    feelingOptions: c.feelingOptions,
    ownMeaningPrompt: c.ownMeaningPrompt,
    ownFeelingPrompt: c.ownFeelingPrompt,
    multiSelect: true,
    otherOption: c.otherOption,
    suggested: c.suggested,
    typing: c.typing,
    evidence: c.evidence,
    whatWorked: c.whatWorked,
    whatMissed: c.whatMissed,
    choice: c.choice,
    otherText: c.otherText || null,
    reaction: c.reaction,
    tapUrl: base ? `${base}/c/${c.id}` : undefined,
    reactions: REACTIONS,
  };
}

// What the person sees on the hosted tap page. Nothing about other people.
function publicCheckView(c) {
  return {
    id: c.id, utterance: c.utterance, prompt: c.prompt, options: c.options.map(({ id, label }) => ({ id, label })),
    feelingPrompt: c.feelingPrompt,
    feelingOptions: (c.feelingOptions || []).map(({ id, label }) => ({ id, label })),
    ownMeaningPrompt: c.ownMeaningPrompt,
    ownFeelingPrompt: c.ownFeelingPrompt,
    otherOption: c.otherOption, answered: Boolean(c.answeredAt), reacted: Boolean(c.reaction), reactions: REACTIONS,
  };
}

// The person's own tap is the strongest label there is: they know what they meant.
function checkLearningView(c) {
  const meaning = c.choice || (c.reaction === 'helpful' ? c.suggested : null);
  const intents = meaning.intents?.length ? meaning.intents : [meaning.intent || 'unclear'];
  const emotions = meaning.emotions?.length ? meaning.emotions : [meaning.emotion || 'neutral'];
  return {
    id: c.id,
    origin: c.choice ? 'self_reported' : 'confirmed_by_reaction',
    platform: c.platform,
    input: { context: c.context, utterance: c.utterance, typing: c.typing, locale: c.locale, modality: 'chat' },
    label: { intent: intents[0], emotion: emotions[0], intents, emotions, agreement: 1, human_explanations: [] },
    own_words: c.ownWords || null,
    ai_follow_up: c.aiFollowUp ? { response: c.aiFollowUp, reaction: c.reaction } : null,
    status: 'resolved',
    resolved_at: c.answeredAt || c.reactedAt,
  };
}

const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

// ----------------------------------------------------------------- app

export function createApp({
  dataFile = process.env.NUANCE_DATA_FILE ?? path.join(__dirname, '..', 'data', 'db.json'),
  databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || null,
  consensusOpts = DEFAULTS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const db = new Store({ file: dataFile, databaseUrl });

  const repOf = (labelerId) => db.find('labelers', (l) => l.id === labelerId)?.reputation ?? 1;
  const settled = () => db.filter('queries', (q) => q.status === 'resolved' || q.status === 'disputed');
  const resolvedQueries = () => db.filter('queries', (q) => q.status === 'resolved');
  const learnedChecks = () => db.filter('checks', (c) => c.choice || (c.reaction === 'helpful' && c.suggested));

  function agentForKey(token) {
    return token ? db.find('agents', (a) => a.keyHash === hash(token)) : null;
  }

  function authAgent(req) {
    const agent = agentForKey(bearer(req));
    if (!agent) throw new HttpError(401, 'Missing or invalid agent API key (Authorization: Bearer nk_...)');
    return agent;
  }

  function authLabeler(req) {
    const token = bearer(req);
    const h = token && hash(token);
    const labeler = h && db.find('labelers', (l) => l.tokenHashes?.includes(h));
    if (!labeler) throw new HttpError(401, 'Sign in first');
    return labeler;
  }

  function issueLabelerToken(labeler) {
    const token = newSecret('lt');
    db.update('labelers', labeler.id, { tokenHashes: [...(labeler.tokenHashes || []), hash(token)].slice(-5) });
    return token;
  }

  function newLabeler(displayName, extra = {}) {
    return db.insert('labelers', {
      id: newId('lbl'), displayName, tokenHashes: [], reputation: 1, labeled: 0, agreed: 0, shared: 0, createdAt: now(), ...extra,
    });
  }

  async function notifyAgent(q) {
    const agent = q.agentId && db.find('agents', (a) => a.id === q.agentId);
    if (!agent?.webhookUrl || !fetchImpl) return;
    try {
      await fetchImpl(agent.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-nuance-event': 'query.' + q.status },
        body: JSON.stringify({ event: 'query.' + q.status, query: queryView(q), learning: learningView(q) }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      console.warn(`[nuance] webhook to ${agent.name} failed: ${err.message}`);
    }
  }

  function addLabel(q, labeler, label, extra = {}) {
    db.insert('labels', { id: newId('lab'), queryId: q.id, labelerId: labeler.id, ...label, ...extra, createdAt: now() });
    db.update('labelers', labeler.id, { labeled: labeler.labeled + 1 });
    return settle(q);
  }

  function settle(q) {
    const labels = db.filter('labels', (l) => l.queryId === q.id);
    const consensus = computeConsensus(labels, (l) => repOf(l.labelerId), consensusOpts);
    const patch = { consensus, labelCount: labels.length };
    let closed = false;
    if (consensus.resolved) { patch.status = 'resolved'; closed = true; }
    else if (labels.length >= MAX_LABELS) { patch.status = 'disputed'; closed = true; }
    if (closed) {
      patch.resolvedAt = now();
      for (const l of labels) {
        const labeler = db.find('labelers', (x) => x.id === l.labelerId);
        if (!labeler) continue;
        const agreed = intentsOf(l).includes(consensus.intent);
        db.update('labelers', labeler.id, {
          reputation: updatedReputation(labeler.reputation, agreed),
          agreed: labeler.agreed + (agreed ? 1 : 0),
        });
      }
    }
    db.update('queries', q.id, patch);
    if (closed) notifyAgent(q);
    return q;
  }

  // Shared by the REST API, MCP and the "share a moment" form.
  async function buildQuery(body, { agentId = null, origin, platform, submittedBy = null }) {
    if (body.consent !== true) {
      throw new HttpError(400, '"consent": true is required — confirm the person in the conversation agreed to have it reviewed by humans');
    }
    const q = {
      id: newId('q'),
      agentId,
      submittedBy,
      origin,
      platform,
      status: 'open',
      utterance: redact(str(body.utterance, 'utterance')),
      context: parseContext(body.context),
      question: redact(str(body.question, 'question', { max: 500, required: false }) || 'What did the person really mean, and how did they feel?'),
      agentGuess: redact(str(body.agentGuess, 'agentGuess', { max: 300, required: false })),
      difficulty: oneOf(body.difficulty, 'difficulty', DIFFICULTY_TYPES, 'intent'),
      modality: oneOf(body.modality, 'modality', MODALITIES, 'text'),
      locale: str(body.locale, 'locale', { max: 20, required: false }) || 'en',
      externalRef: str(body.externalRef, 'externalRef', { max: 200, required: false }),
      labelCount: 0,
      consensus: null,
      createdAt: now(),
    };
    q.typing = analyzeTyping(q.utterance);
    q.appAnswer = await analyze(q, resolvedQueries());
    return db.insert('queries', q);
  }

  const service = {
    async createQuery(agent, body) {
      return queryView(await buildQuery(body, { agentId: agent.id, origin: 'agent', platform: agent.platform }));
    },
    getQuery(agent, id) {
      const q = db.find('queries', (x) => x.id === id && x.agentId === agent.id);
      if (!q) throw new HttpError(404, 'Query not found');
      return queryView(q);
    },
    similar(utterance, limit = 5) {
      const text = str(utterance, 'utterance');
      return settled()
        .map((q) => ({ q, score: similarity(text, q.utterance) }))
        .filter((m) => m.score >= 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.min(10, Math.max(1, Number(limit) || 5)))
        .map(({ q, score }) => ({ similarity: +score.toFixed(2), ...learningView(q) }));
    },
    learnings(since, limit = 200) {
      const all = [...settled().map(learningView), ...learnedChecks().map(checkLearningView)]
        .filter((l) => !since || l.resolved_at > since)
        .sort((a, b) => a.resolved_at.localeCompare(b.resolved_at));
      return all.slice(-Math.min(1000, Math.max(1, Number(limit) || 200)));
    },

    // ---- quick checks: one-tap clarification inside the conversation
    async createCheck(agent, body, base) {
      if (body.consent !== true) {
        throw new HttpError(400, '"consent": true is required — the person agreed that their anonymous answers help AIs learn');
      }
      const utterance = redact(str(body.utterance, 'utterance'));
      const situation = {
        utterance,                       // kept exactly as typed: capitals are part of the meaning
        typing: analyzeTyping(utterance),
        context: parseContext(body.context),
        locale: str(body.locale, 'locale', { max: 20, required: false }) || 'en',
      };
      const appAnswer = await analyze(situation, resolvedQueries());
      const memory = { checks: db.filter('checks', (c) => c.choice || c.reaction || c.ownWords), resolved: resolvedQueries() };
      const built = buildQuickCheck(situation, appAnswer, memory);
      const c = db.insert('checks', {
        id: `chk_${crypto.randomBytes(16).toString('hex')}`,
        agentId: agent.id,
        platform: agent.platform,
        ...situation,
        asked: built.shouldAsk,
        ...Object.fromEntries(Object.entries(built).filter(([k]) => k !== 'shouldAsk')),
        appAnswer,
        choice: null,
        reaction: null,
        aiFollowUp: null,
        createdAt: now(),
      });
      return checkView(c, base);
    },

    getCheck(agent, id) {
      const c = db.find('checks', (x) => x.id === id && (!agent || x.agentId === agent.id));
      if (!c) throw new HttpError(404, 'Check not found');
      return c;
    },

    async answerCheck(c, body) {
      if (c.answeredAt) throw new HttpError(409, 'Already answered');
      // Taps: "optionIds": ["o1", "o3"] (several allowed), "feelings": ["f2"].
      // Own words: "ownMeaning" / "ownFeeling" ("otherText" is the older name for ownMeaning).
      const optionIds = [...new Set(Array.isArray(body.optionIds) ? body.optionIds : body.optionId ? [body.optionId] : [])];
      const own = await parseOwnWords({ ownMeaning: body.ownMeaning ?? body.otherText, ownFeeling: body.ownFeeling }, { utterance: c.utterance, context: c.context });
      if (!optionIds.length && !(Array.isArray(body.feelings) && body.feelings.length) && !own.words) {
        throw new HttpError(400, 'Tap at least one option, or say it in your own words');
      }
      const picked = optionIds.filter((id) => id !== 'other').map((id) => {
        const opt = c.options.find((o) => o.id === id);
        if (!opt) throw new HttpError(400, `"${id}" must be one of ${[...c.options.map((o) => o.id), 'other'].join(', ')}`);
        return opt;
      });
      const feelingPicks = (Array.isArray(body.feelings) ? body.feelings : []).map((id) => {
        const f = (c.feelingOptions || []).find((x) => x.id === id);
        if (!f) throw new HttpError(400, `"${id}" is not one of the feeling options`);
        return f;
      });

      // Tapping a phrase other people typed counts as saying those words again.
      const phraseMeaning = picked.find((o) => o.basis === 'people_said');
      const phraseFeeling = feelingPicks.find((f) => f.basis === 'people_said');
      // Tapping a phrase other people typed counts as saying those words again (same gist, so they group).
      const phraseRead = (opt, kind) => opt && { intents: opt.intents || [], emotions: opt.emotions || [], gist: opt.gist || null, by: 'phrase' };
      const ownWords = {
        meaning: own.words?.meaning || phraseMeaning?.text || null,
        feeling: own.words?.feeling || phraseFeeling?.text || null,
        read: {
          meaning: own.words?.read.meaning || phraseRead(phraseMeaning, 'meaning') || null,
          feeling: own.words?.read.feeling || phraseRead(phraseFeeling, 'feeling') || null,
        },
      };

      const intents = [...new Set([...picked.flatMap((o) => o.intents || [o.intent]), ...own.intents].filter(Boolean))];
      const tappedFeelings = feelingPicks.flatMap((f) => f.emotions || [f.emotion]);
      // Feelings the person gave win; otherwise each meaning brings its usual feeling.
      const given = [...tappedFeelings, ...own.emotions].filter(Boolean);
      const emotions = [...new Set(given.length ? given : picked.filter((o) => o.basis !== 'people_said').map((o) => o.emotion))].filter(Boolean);

      const patch = { answeredAt: now(), asked: true };
      if (ownWords.meaning || ownWords.feeling) patch.ownWords = ownWords;
      const understood = (r) => r && { intents: r.intents, emotions: r.emotions, english: r.english || null, by: r.by };
      if (intents.length || emotions.length) {
        patch.choice = { intent: intents[0] || null, emotion: emotions[0] || null, intents, emotions };
      }
      patch.otherText = own.words?.meaning || null;

      // Own words we can't read yet go to the community, who work out what they mean.
      if (own.meaningUnread || (optionIds.includes('other') && !intents.length && own.words?.meaning)) {
        await buildQuery(
          { utterance: c.utterance, context: c.context, consent: true, locale: c.locale,
            question: "None of the usual readings fit. What did the person mean?",
            agentGuess: `In their own words: ${own.words.meaning}` },
          { origin: 'check', platform: c.platform },
        );
      }
      db.update('checks', c.id, patch);
      return {
        recorded: true,
        choice: c.choice || null,
        ownWords: c.ownWords || null,
        understoodOwnWords: own.words
          ? { intents: own.intents, emotions: own.emotions, meaning: understood(own.words.read.meaning), feeling: understood(own.words.read.feeling) }
          : null,
        next: 'Reply to the person with this in mind, then send their reaction to /reaction.',
      };
    },

    reactToCheck(c, body) {
      if (c.reaction) throw new HttpError(409, 'Reaction already recorded');
      const reaction = oneOf(body.reaction, 'reaction', Object.keys(REACTIONS));
      if (!reaction) throw new HttpError(400, '"reaction" is required');
      db.update('checks', c.id, {
        reaction,
        reactedAt: now(),
        aiFollowUp: c.aiFollowUp || redact(str(body.aiResponse, 'aiResponse', { max: 1000, required: false })) || null,
      });
      return { recorded: true, reaction };
    },
  };

  // ------------------------------------------------------------- routes

  const routes = [
    ['GET', /^\/api\/health$/, () => ({ ok: true, claude: claudeStatus(), storage: db.kind })],

    ['GET', /^\/api\/taxonomy$/, () => ({
      intents: INTENTS, emotions: EMOTIONS, difficulties: DIFFICULTY_TYPES, modalities: MODALITIES, platforms: PLATFORMS,
      intentPhrases: INTENT_PHRASES, emotionEmoji: EMOTION_EMOJI, emotionLabels: { smug: 'cocky / smug' }, reactions: REACTIONS,
      typingStyles: STYLES,
    })],

    ['GET', /^\/(openapi\.json|\.well-known\/openapi\.json)$/, (req) => openApiSpec(baseUrl(req))],

    ['GET', /^\/api\/stats$/, () => {
      const qs = db.data.queries;
      const count = (s) => qs.filter((q) => q.status === s).length;
      const byPlatform = {};
      for (const q of qs) byPlatform[q.platform] = (byPlatform[q.platform] || 0) + 1;
      const leaderboard = [...db.data.labelers]
        .sort((a, b) => b.reputation - a.reputation || b.labeled - a.labeled)
        .slice(0, 10)
        .map((l) => ({ displayName: l.displayName, reputation: l.reputation, labeled: l.labeled, viaPi: Boolean(l.piUid) }));
      return {
        agents: db.data.agents.length,
        labelers: db.data.labelers.length,
        questions: qs.length,
        sharedByPeople: qs.filter((q) => q.origin === 'person').length,
        open: count('open'),
        resolved: count('resolved'),
        disputed: count('disputed'),
        labels: db.data.labels.length,
        byPlatform,
        checks: checkStats(db.data.checks),
        leaderboard,
      };
    }],

    // ---- AI agents (any platform)
    ['POST', /^\/api\/agents\/register$/, (req, body) => {
      const admin = process.env.NUANCE_ADMIN_TOKEN;
      if (admin && req.headers['x-admin-token'] !== admin) throw new HttpError(403, 'Agent registration requires the admin token');
      const apiKey = newSecret('nk');
      const webhookUrl = str(body.webhookUrl, 'webhookUrl', { max: 500, required: false });
      if (webhookUrl && !/^https?:\/\//.test(webhookUrl)) throw new HttpError(400, '"webhookUrl" must be an http(s) URL');
      const agent = db.insert('agents', {
        id: newId('agt'),
        name: str(body.name, 'name', { max: 100 }),
        platform: oneOf(body.platform, 'platform', PLATFORMS, 'custom'),
        description: str(body.description, 'description', { max: 500, required: false }),
        webhookUrl,
        keyHash: hash(apiKey),
        createdAt: now(),
      });
      const base = baseUrl(req);
      return {
        status: 201,
        body: {
          id: agent.id, name: agent.name, platform: agent.platform, apiKey,
          note: 'Store this key now; it is not shown again.',
          connect: { rest: `${base}/api/v1`, mcp: `${base}/mcp`, openapi: `${base}/openapi.json` },
        },
      };
    }],

    ['POST', /^\/api\/v1\/queries$/, async (req, body) => ({ status: 201, body: await service.createQuery(authAgent(req), body) })],

    ['GET', /^\/api\/v1\/queries$/, (req, _b, _m, url) => {
      const agent = authAgent(req);
      const status = url.searchParams.get('status');
      return { queries: db.filter('queries', (q) => q.agentId === agent.id && (!status || q.status === status)).map(queryView) };
    }],

    ['GET', /^\/api\/v1\/queries\/([\w]+)$/, (req, _b, [, id]) => service.getQuery(authAgent(req), id)],

    ['GET', /^\/api\/v1\/similar$/, (req, _b, _m, url) => {
      authAgent(req);
      return { matches: service.similar(url.searchParams.get('utterance'), url.searchParams.get('limit')) };
    }],

    // Everything people have settled, from every platform. Any connected agent can learn from all of it.
    ['GET', /^\/api\/v1\/learnings$/, (req, _b, _m, url) => {
      authAgent(req);
      return { learnings: service.learnings(url.searchParams.get('since'), url.searchParams.get('limit')) };
    }],

    ['GET', /^\/api\/v1\/dataset\.jsonl$/, (req) => {
      authAgent(req);
      const lines = [...resolvedQueries().map(learningView), ...learnedChecks().map(checkLearningView)].map((l) => JSON.stringify(l)).join('\n');
      return { raw: lines + (lines ? '\n' : ''), type: 'application/x-ndjson' };
    }],

    // ---- quick checks (agent side)
    ['POST', /^\/api\/v1\/checks$/, async (req, body) => ({ status: 201, body: await service.createCheck(authAgent(req), body, baseUrl(req)) })],
    ['GET', /^\/api\/v1\/checks\/(chk_\w+)$/, (req, _b, [, id]) => checkView(service.getCheck(authAgent(req), id), baseUrl(req))],
    ['POST', /^\/api\/v1\/checks\/(chk_\w+)\/answer$/, async (req, body, [, id]) => service.answerCheck(service.getCheck(authAgent(req), id), body)],
    ['POST', /^\/api\/v1\/checks\/(chk_\w+)\/reaction$/, (req, body, [, id]) => service.reactToCheck(service.getCheck(authAgent(req), id), body)],

    // ---- quick checks (person side, via the hosted tap page; the long random id is the permission)
    ['GET', /^\/api\/checks\/(chk_\w+)$/, (_req, _b, [, id]) => publicCheckView(service.getCheck(null, id))],
    ['POST', /^\/api\/checks\/(chk_\w+)\/answer$/, async (_req, body, [, id]) => service.answerCheck(service.getCheck(null, id), body)],
    ['POST', /^\/api\/checks\/(chk_\w+)\/reaction$/, (_req, body, [, id]) => service.reactToCheck(service.getCheck(null, id), body)],

    // ---- people
    ['POST', /^\/api\/labelers$/, (_req, body) => {
      const labeler = newLabeler(str(body.displayName, 'displayName', { max: 40 }));
      return { status: 201, body: { id: labeler.id, displayName: labeler.displayName, token: issueLabelerToken(labeler) } };
    }],

    // Sign in with Pi Network: the Pi Browser gives the page an access token; we confirm it with Pi's servers.
    ['POST', /^\/api\/labelers\/pi$/, async (_req, body) => {
      const accessToken = str(body.accessToken, 'accessToken', { max: 4000 });
      let me;
      try {
        const res = await fetchImpl(`${PI_API}/v2/me`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`Pi said ${res.status}`);
        me = await res.json();
      } catch (err) {
        throw new HttpError(401, `Could not verify your Pi sign-in (${err.message})`);
      }
      if (!me?.uid) throw new HttpError(401, 'Could not verify your Pi sign-in');
      let labeler = db.find('labelers', (l) => l.piUid === me.uid);
      if (!labeler) labeler = newLabeler(String(me.username || 'Pioneer').slice(0, 40), { piUid: me.uid });
      return { status: 201, body: { id: labeler.id, displayName: labeler.displayName, token: issueLabelerToken(labeler), viaPi: true } };
    }],

    ['GET', /^\/api\/me$/, (req) => {
      const l = authLabeler(req);
      return { id: l.id, displayName: l.displayName, reputation: l.reputation, labeled: l.labeled, agreed: l.agreed, shared: l.shared || 0, viaPi: Boolean(l.piUid) };
    }],

    ['GET', /^\/api\/tasks\/next$/, (req) => {
      const l = authLabeler(req);
      const mine = new Set(db.filter('labels', (x) => x.labelerId === l.id).map((x) => x.queryId));
      const candidates = db.filter('queries', (q) => q.status === 'open' && !mine.has(q.id));
      // Questions closest to resolving first, then oldest.
      candidates.sort((a, b) => b.labelCount - a.labelCount || a.createdAt.localeCompare(b.createdAt));
      return { task: candidates[0] ? taskView(candidates[0]) : null, remaining: candidates.length };
    }],

    ['POST', /^\/api\/queries\/([\w]+)\/labels$/, async (req, body, [, id]) => {
      const l = authLabeler(req);
      const q = db.find('queries', (x) => x.id === id);
      if (!q) throw new HttpError(404, 'Question not found');
      if (q.status !== 'open') throw new HttpError(409, 'This question is already settled');
      if (db.find('labels', (x) => x.queryId === id && x.labelerId === l.id)) throw new HttpError(409, 'You already answered this one');
      const verdict = body.appAnswerVerdict;
      if (verdict && !['correct', 'partly', 'wrong'].includes(verdict)) throw new HttpError(400, '"appAnswerVerdict" must be correct, partly or wrong');
      addLabel(q, l, await parseLabel(body, { utterance: q.utterance, context: q.context }), { appAnswerVerdict: verdict });
      return { status: 201, body: { status: q.status, consensus: q.consensus } };
    }],

    // A person shares a moment where an AI (any platform) misread them, and says what they really meant.
    // Their own answer is the first vote; others confirm it before it becomes training data.
    ['POST', /^\/api\/moments$/, async (req, body) => {
      const l = authLabeler(req);
      const label = await parseLabel(body, { utterance: body.utterance, context: body.context });
      const q = await buildQuery(
        { ...body, question: body.question || 'An AI misread this. What did the person really mean, and how did they feel?' },
        { origin: 'person', platform: oneOf(body.platform, 'platform', PLATFORMS, 'other'), submittedBy: l.id },
      );
      addLabel(q, l, label, { isAuthor: true });
      db.update('labelers', l.id, { shared: (l.shared || 0) + 1 });
      return { status: 201, body: { id: q.id, status: q.status, appAnswer: q.appAnswer } };
    }],
  ];

  async function handleMcp(req, res, url) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      return res.end();
    }
    // Header is preferred; ?key= exists for connector UIs that cannot set headers.
    const agent = agentForKey(bearer(req) || url.searchParams.get('key'));
    if (!agent) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="nuance-hub"' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Agent API key required' } }));
    }
    let payload;
    try { payload = await readJson(req); }
    catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const batch = Array.isArray(payload);
    const svc = { ...service, createCheck: (ag, body) => service.createCheck(ag, body, baseUrl(req)) };
    const replies = (await Promise.all((batch ? payload : [payload]).map((m) => handleMcpMessage(m, agent, svc)))).filter(Boolean);
    await db.commit();
    if (!replies.length) { res.writeHead(202); return res.end(); }
    send(res, 200, batch ? replies : replies[0]);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, x-admin-token',
      });
      return res.end();
    }
    const dynamic = url.pathname === '/mcp' || url.pathname.startsWith('/api/') || url.pathname.endsWith('openapi.json');
    if (!dynamic) return serveStatic(url.pathname, res);
    try {
      // Pick up what other server instances saved since this one last looked.
      await db.sync();
    } catch (err) {
      console.error('[nuance] database unavailable:', err.message);
      return send(res, 503, { error: 'Database unavailable, please try again shortly' });
    }
    try {
      if (url.pathname === '/mcp') return await handleMcp(req, res, url);
      const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
      if (!route) throw new HttpError(404, 'Not found');
      const body = req.method === 'POST' ? await readJson(req) : {};
      const out = await route[2](req, body, url.pathname.match(route[1]), url);
      await db.commit(); // saved before the reply goes out
      if (out?.raw !== undefined) {
        res.writeHead(200, { 'content-type': out.type });
        return res.end(out.raw);
      }
      const wrapped = out?.status && out.body;
      send(res, wrapped ? out.status : 200, wrapped ? out.body : out);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      await db.commit().catch((e) => console.error('[nuance] save failed:', e.message));
      send(res, err.status || 500, { error: err instanceof HttpError ? err.message : 'Internal error' });
    }
  }

  const server = http.createServer(handle);
  server.db = db;
  server.handle = handle;
  return server;
}

// For hosts that call a function per request (Vercel): one app per server instance.
let shared = null;
export function requestHandler(req, res) {
  shared ??= createApp({ dataFile: process.env.NUANCE_DATA_FILE ?? null });
  return shared.handle(req, res);
}

// Is the AI asking less as it learns? Compare the oldest and newest checks.
function checkStats(checks) {
  const rate = (list) => (list.length ? +(list.filter((c) => c.asked).length / list.length).toFixed(2) : null);
  const window = Math.max(1, Math.min(20, Math.floor(checks.length / 2)));
  return {
    total: checks.length,
    answered: checks.filter((c) => c.answeredAt).length,
    askRate: rate(checks),
    earlyAskRate: rate(checks.slice(0, window)),
    recentAskRate: rate(checks.slice(-window)),
    reactions: Object.fromEntries(Object.keys(REACTIONS).map((r) => [r, checks.filter((c) => c.reaction === r).length])),
  };
}

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Body must be valid JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.md': 'text/markdown' };

function serveStatic(pathname, res) {
  // The typing-style detector runs in the browser too (live note on the Share tab).
  if (pathname === '/lib/style.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return fs.createReadStream(path.join(__dirname, 'style.js')).pipe(res);
  }
  const rel = pathname === '/' ? 'index.html' : /^\/c\/chk_\w+$/.test(pathname) ? 'check.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// Run directly: `node src/server.js`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const app = createApp();
  app.listen(port, () => {
    console.log(`Nuance Hub running at http://localhost:${port}`);
    console.log(`  MCP endpoint:  http://localhost:${port}/mcp`);
    console.log(`  OpenAPI spec:  http://localhost:${port}/openapi.json`);
    console.log(process.env.ANTHROPIC_API_KEY ? '  Claude analysis: on' : '  Claude analysis: off (set ANTHROPIC_API_KEY to enable)');
  });
  const shutdown = () => { app.db.flush(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
