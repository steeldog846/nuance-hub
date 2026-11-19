import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { redact } from '../src/redact.js';
import { heuristicAnalyze, similarity } from '../src/analyzer.js';
import { computeConsensus } from '../src/consensus.js';

delete process.env.ANTHROPIC_API_KEY; // keep tests offline

let server, base;
const webhooks = [];

before(async () => {
  server = createApp({ dataFile: null, fetchImpl: async (url, init) => { webhooks.push({ url, body: JSON.parse(init.body) }); } });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

test('redacts personal details', () => {
  assert.equal(redact('mail me at jo@example.com or 555-123-4567'), 'mail me at [email] or [phone]');
});

test('heuristics catch classic sarcasm', () => {
  const r = heuristicAnalyze('Oh great, my laptop crashed again.');
  assert.equal(r.intent, 'sarcastic');
});

test('heuristics use the conversation around the message', () => {
  const r = heuristicAnalyze('Oh perfect.', [{ speaker: 'human', text: 'It restarted in the middle of my presentation.' }]);
  assert.equal(r.intent, 'sarcastic');
  assert.notEqual(heuristicAnalyze('Oh perfect.', [{ speaker: 'human', text: 'I got the job!' }]).intent, 'sarcastic');
});

test('similarity of near-identical messages is high', () => {
  assert.ok(similarity('Oh great, another Monday', 'great, another monday!!') > 0.6);
});

test('consensus needs enough agreeing votes', () => {
  const two = computeConsensus([{ intent: 'sarcastic', emotion: 'annoyed' }, { intent: 'sarcastic', emotion: 'annoyed' }]);
  assert.equal(two.resolved, false);
  const three = computeConsensus([
    { intent: 'sarcastic', emotion: 'annoyed' }, { intent: 'sarcastic', emotion: 'angry' }, { intent: 'joking', emotion: 'amused' },
  ]);
  assert.equal(three.intent, 'sarcastic');
  assert.equal(three.resolved, true);
});

test('full loop: agent asks, people answer, agent learns', async () => {
  const reg = await call('/api/agents/register', { method: 'POST', body: { name: 'support-bot', webhookUrl: 'https://example.test/hook' } });
  assert.equal(reg.status, 201);
  const key = reg.data.apiKey;

  const noConsent = await call('/api/v1/queries', { method: 'POST', token: key, body: { utterance: 'hi' } });
  assert.equal(noConsent.status, 400);

  const asked = await call('/api/v1/queries', {
    method: 'POST', token: key,
    body: {
      utterance: 'Oh great, the update broke my printer again. Call me at 555-123-4567.',
      context: [{ speaker: 'ai', text: 'The update installed successfully!' }],
      question: 'Is the user pleased?',
      consent: true,
    },
  });
  assert.equal(asked.status, 201);
  assert.equal(asked.data.status, 'open');
  assert.equal(asked.data.appAnswer.intent, 'sarcastic');
  assert.match(asked.data.utterance, /\[phone\]/);
  const qid = asked.data.id;

  const votes = [
    ['ann', 'sarcastic', 'frustrated', 'correct'],
    ['bo', 'sarcastic', 'annoyed', 'correct'],
    ['cy', 'sarcastic', 'frustrated', 'partly'],
  ];
  let last;
  for (const [name, intent, emotion, verdict] of votes) {
    const { data: lab } = await call('/api/labelers', { method: 'POST', body: { displayName: name } });
    const next = await call('/api/tasks/next', { token: lab.token });
    assert.equal(next.data.task.id, qid);
    last = await call(`/api/queries/${qid}/labels`, {
      method: 'POST', token: lab.token,
      body: { intent, emotion, intensity: 4, appAnswerVerdict: verdict, explanation: '"Great" with a broken printer means the opposite.' },
    });
    assert.equal(last.status, 201);
    const again = await call(`/api/queries/${qid}/labels`, { method: 'POST', token: lab.token, body: { intent, emotion } });
    assert.equal(again.status, 409);
  }
  assert.equal(last.data.status, 'resolved');

  const fetched = await call(`/api/v1/queries/${qid}`, { token: key });
  assert.equal(fetched.data.consensus.intent, 'sarcastic');
  assert.equal(fetched.data.consensus.emotion, 'frustrated');
  assert.equal(fetched.data.consensus.labelCount, 3);

  assert.equal(webhooks.length, 1);
  assert.equal(webhooks[0].body.event, 'query.resolved');

  const learnings = await call('/api/v1/learnings', { token: key });
  assert.equal(learnings.data.learnings.length, 1);

  const jsonl = await call('/api/v1/dataset.jsonl', { token: key });
  assert.equal(jsonl.data.label.intent, 'sarcastic');

  // A near-identical message is now answered from the community's precedent.
  const repeat = await call('/api/v1/queries', {
    method: 'POST', token: key,
    body: { utterance: 'Oh great, the update broke my printer again!', consent: true },
  });
  assert.equal(repeat.data.appAnswer.source, 'precedent');
});

test('rejects bad auth and bad labels', async () => {
  assert.equal((await call('/api/v1/queries', { token: 'nope' })).status, 401);
  const { data: lab } = await call('/api/labelers', { method: 'POST', body: { displayName: 'x' } });
  const bad = await call('/api/queries/q_missing/labels', { method: 'POST', token: lab.token, body: { intent: 'sarcastic', emotion: 'annoyed' } });
  assert.equal(bad.status, 404);
});

test('serves the web app', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Nuance Hub/);
  assert.equal((await fetch(base + '/../package.json')).status, 404);
});
