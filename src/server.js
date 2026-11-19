import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from './store.js';
import { redact } from './redact.js';
import { analyze } from './analyzer.js';
import { computeConsensus, updatedReputation, DEFAULTS } from './consensus.js';
import { INTENTS, EMOTIONS, DIFFICULTY_TYPES, MODALITIES, isValidIntent, isValidEmotion } from './taxonomy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_LABELS = 7;        // after this many votes without agreement -> "disputed"
const MAX_BODY = 64 * 1024;

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

// ----------------------------------------------------------------- views

// What an AI agent sees about one of its questions.
function queryView(q) {
  return {
    id: q.id,
    status: q.status,
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
    utterance: q.utterance,
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

// One resolved question as a training example.
function learningView(q) {
  return {
    id: q.id,
    input: { context: q.context, utterance: q.utterance, locale: q.locale, modality: q.modality },
    label: {
      intent: q.consensus.intent,
      emotion: q.consensus.emotion,
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

// ----------------------------------------------------------------- app

export function createApp({ dataFile = process.env.NUANCE_DATA_FILE ?? path.join(__dirname, '..', 'data', 'db.json'), consensusOpts = DEFAULTS, fetchImpl = globalThis.fetch } = {}) {
  const db = new Store(dataFile);

  const repOf = (labelerId) => db.find('labelers', (l) => l.id === labelerId)?.reputation ?? 1;
  const resolvedQueries = () => db.filter('queries', (q) => q.status === 'resolved');

  function authAgent(req) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const agent = token && db.find('agents', (a) => a.keyHash === hash(token));
    if (!agent) throw new HttpError(401, 'Missing or invalid agent API key (Authorization: Bearer nk_...)');
    return agent;
  }

  function authLabeler(req) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const labeler = token && db.find('labelers', (l) => l.tokenHash === hash(token));
    if (!labeler) throw new HttpError(401, 'Sign in as a labeler first');
    return labeler;
  }

  async function notifyAgent(q) {
    const agent = db.find('agents', (a) => a.id === q.agentId);
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
        const agreed = l.intent === consensus.intent;
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

  // ------------------------------------------------------------- routes

  const routes = [
    ['GET', /^\/api\/health$/, () => ({ ok: true })],

    ['GET', /^\/api\/taxonomy$/, () => ({ intents: INTENTS, emotions: EMOTIONS, difficulties: DIFFICULTY_TYPES, modalities: MODALITIES })],

    ['GET', /^\/api\/stats$/, () => {
      const qs = db.data.queries;
      const count = (s) => qs.filter((q) => q.status === s).length;
      const leaderboard = [...db.data.labelers]
        .sort((a, b) => b.reputation - a.reputation || b.labeled - a.labeled)
        .slice(0, 10)
        .map((l) => ({ displayName: l.displayName, reputation: l.reputation, labeled: l.labeled }));
      return {
        agents: db.data.agents.length,
        labelers: db.data.labelers.length,
        questions: qs.length,
        open: count('open'),
        resolved: count('resolved'),
        disputed: count('disputed'),
        labels: db.data.labels.length,
        leaderboard,
      };
    }],

    // ---- AI agents
    ['POST', /^\/api\/agents\/register$/, (req, body) => {
      const admin = process.env.NUANCE_ADMIN_TOKEN;
      if (admin && req.headers['x-admin-token'] !== admin) throw new HttpError(403, 'Agent registration requires the admin token');
      const apiKey = newSecret('nk');
      const webhookUrl = str(body.webhookUrl, 'webhookUrl', { max: 500, required: false });
      if (webhookUrl && !/^https?:\/\//.test(webhookUrl)) throw new HttpError(400, '"webhookUrl" must be an http(s) URL');
      const agent = db.insert('agents', {
        id: newId('agt'),
        name: str(body.name, 'name', { max: 100 }),
        description: str(body.description, 'description', { max: 500, required: false }),
        webhookUrl,
        keyHash: hash(apiKey),
        createdAt: now(),
      });
      return { status: 201, body: { id: agent.id, name: agent.name, apiKey, note: 'Store this key now; it is not shown again.' } };
    }],

    ['POST', /^\/api\/v1\/queries$/, async (req, body) => {
      const agent = authAgent(req);
      if (body.consent !== true) {
        throw new HttpError(400, '"consent": true is required — confirm the person in the conversation agreed to have it reviewed by humans');
      }
      const context = Array.isArray(body.context) ? body.context.slice(-20).map((t, i) => ({
        speaker: str(t?.speaker, `context[${i}].speaker`, { max: 40 }) === 'ai' ? 'ai' : 'human',
        text: redact(str(t?.text, `context[${i}].text`, { max: 2000 })),
      })) : [];
      const difficulty = body.difficulty ?? 'intent';
      if (!DIFFICULTY_TYPES.includes(difficulty)) throw new HttpError(400, `"difficulty" must be one of ${DIFFICULTY_TYPES.join(', ')}`);
      const modality = body.modality ?? 'text';
      if (!MODALITIES.includes(modality)) throw new HttpError(400, `"modality" must be one of ${MODALITIES.join(', ')}`);

      const q = {
        id: newId('q'),
        agentId: agent.id,
        status: 'open',
        utterance: redact(str(body.utterance, 'utterance')),
        context,
        question: redact(str(body.question, 'question', { max: 500, required: false }) || 'What did the person really mean, and how did they feel?'),
        agentGuess: redact(str(body.agentGuess, 'agentGuess', { max: 300, required: false })),
        difficulty,
        modality,
        locale: str(body.locale, 'locale', { max: 20, required: false }) || 'en',
        externalRef: str(body.externalRef, 'externalRef', { max: 200, required: false }),
        labelCount: 0,
        consensus: null,
        createdAt: now(),
      };
      q.appAnswer = await analyze(q, resolvedQueries());
      db.insert('queries', q);
      return { status: 201, body: queryView(q) };
    }],

    ['GET', /^\/api\/v1\/queries$/, (req, _b, _m, url) => {
      const agent = authAgent(req);
      const status = url.searchParams.get('status');
      return { queries: db.filter('queries', (q) => q.agentId === agent.id && (!status || q.status === status)).map(queryView) };
    }],

    ['GET', /^\/api\/v1\/queries\/([\w]+)$/, (req, _b, [, id]) => {
      const agent = authAgent(req);
      const q = db.find('queries', (x) => x.id === id && x.agentId === agent.id);
      if (!q) throw new HttpError(404, 'Query not found');
      return queryView(q);
    }],

    // Everything the community has resolved, as training examples. Any registered agent can learn from all of it.
    ['GET', /^\/api\/v1\/learnings$/, (req, _b, _m, url) => {
      authAgent(req);
      const since = url.searchParams.get('since');
      const items = db.filter('queries', (q) => (q.status === 'resolved' || q.status === 'disputed') && (!since || q.resolvedAt > since));
      return { learnings: items.map(learningView) };
    }],

    ['GET', /^\/api\/v1\/dataset\.jsonl$/, (req) => {
      authAgent(req);
      const lines = resolvedQueries().map((q) => JSON.stringify(learningView(q))).join('\n');
      return { raw: lines + (lines ? '\n' : ''), type: 'application/x-ndjson' };
    }],

    // ---- human labelers
    ['POST', /^\/api\/labelers$/, (_req, body) => {
      const token = newSecret('lt');
      const labeler = db.insert('labelers', {
        id: newId('lbl'),
        displayName: str(body.displayName, 'displayName', { max: 40 }),
        tokenHash: hash(token),
        reputation: 1,
        labeled: 0,
        agreed: 0,
        createdAt: now(),
      });
      return { status: 201, body: { id: labeler.id, displayName: labeler.displayName, token } };
    }],

    ['GET', /^\/api\/me$/, (req) => {
      const l = authLabeler(req);
      return { id: l.id, displayName: l.displayName, reputation: l.reputation, labeled: l.labeled, agreed: l.agreed };
    }],

    ['GET', /^\/api\/tasks\/next$/, (req) => {
      const l = authLabeler(req);
      const mine = new Set(db.filter('labels', (x) => x.labelerId === l.id).map((x) => x.queryId));
      const candidates = db.filter('queries', (q) => q.status === 'open' && !mine.has(q.id));
      // Questions closest to resolving first, then oldest.
      candidates.sort((a, b) => b.labelCount - a.labelCount || a.createdAt.localeCompare(b.createdAt));
      return { task: candidates[0] ? taskView(candidates[0]) : null, remaining: candidates.length };
    }],

    ['POST', /^\/api\/queries\/([\w]+)\/labels$/, (req, body, [, id]) => {
      const l = authLabeler(req);
      const q = db.find('queries', (x) => x.id === id);
      if (!q) throw new HttpError(404, 'Question not found');
      if (q.status !== 'open') throw new HttpError(409, 'This question is already settled');
      if (db.find('labels', (x) => x.queryId === id && x.labelerId === l.id)) throw new HttpError(409, 'You already answered this one');
      if (!isValidIntent(body.intent)) throw new HttpError(400, `"intent" must be one of ${INTENTS.join(', ')}`);
      if (!isValidEmotion(body.emotion)) throw new HttpError(400, `"emotion" must be one of ${EMOTIONS.join(', ')}`);
      const intensity = Number(body.intensity ?? 3);
      if (!Number.isInteger(intensity) || intensity < 1 || intensity > 5) throw new HttpError(400, '"intensity" must be 1-5');
      const verdict = body.appAnswerVerdict;
      if (verdict && !['correct', 'partly', 'wrong'].includes(verdict)) throw new HttpError(400, '"appAnswerVerdict" must be correct, partly or wrong');

      db.insert('labels', {
        id: newId('lab'),
        queryId: id,
        labelerId: l.id,
        intent: body.intent,
        emotion: body.emotion,
        intensity,
        appAnswerVerdict: verdict,
        explanation: redact(str(body.explanation, 'explanation', { max: 600, required: false })),
        createdAt: now(),
      });
      db.update('labelers', l.id, { labeled: l.labeled + 1 });
      settle(q);
      return { status: 201, body: { status: q.status, consensus: q.consensus } };
    }],
  ];

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
      const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
      if (!route) throw new HttpError(404, 'Not found');
      const body = req.method === 'POST' ? await readJson(req) : {};
      const out = await route[2](req, body, url.pathname.match(route[1]), url);
      if (out?.raw !== undefined) {
        res.writeHead(200, { 'content-type': out.type });
        return res.end(out.raw);
      }
      const status = out?.status && out.body ? out.status : 200;
      send(res, status, out?.status && out.body ? out.body : out);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      send(res, err.status || 500, { error: err instanceof HttpError ? err.message : 'Internal error' });
    }
  }

  const server = http.createServer(handle);
  server.db = db;
  return server;
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
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
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
    console.log(process.env.ANTHROPIC_API_KEY ? 'Claude analysis: on' : 'Claude analysis: off (set ANTHROPIC_API_KEY to enable)');
  });
  const shutdown = () => { app.db.flush(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
