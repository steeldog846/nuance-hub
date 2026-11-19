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
  server = createApp({
    dataFile: null,
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/v2/me')) {
        const ok = init.headers.authorization === 'Bearer good-pi-token';
        return { ok, status: ok ? 200 : 401, json: async () => ({ uid: 'pi-uid-1', username: 'pioneer_raj' }) };
      }
      webhooks.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    },
  });
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

async function mcp(key, body) {
  const res = await fetch(base + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: res.status === 202 ? null : await res.json() };
}

test('MCP: any MCP-capable AI can ask and check questions', async () => {
  const { data: reg } = await call('/api/agents/register', { method: 'POST', body: { name: 'claude-desktop', platform: 'claude' } });
  assert.match(reg.connect.mcp, /\/mcp$/);

  assert.equal((await mcp(null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).status, 401);

  const init = await mcp(reg.apiKey, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(init.data.result.protocolVersion, '2025-06-18');
  assert.equal(init.data.result.serverInfo.name, 'nuance-hub');
  assert.equal((await mcp(reg.apiKey, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);

  const list = await mcp(reg.apiKey, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.data.result.tools.map((t) => t.name), ['quick_check_meaning', 'record_user_choice', 'record_reaction', 'ask_humans_about_message', 'check_human_answer', 'find_similar_answers', 'get_learnings']);

  const ask = await mcp(reg.apiKey, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ask_humans_about_message', arguments: { utterance: 'Sure, I LOVE waiting on hold.', consent: true } } });
  const created = ask.data.result.structuredContent;
  assert.equal(created.platform, 'claude');
  assert.equal(created.status, 'open');

  const check = await mcp(reg.apiKey, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'check_human_answer', arguments: { query_id: created.id } } });
  assert.equal(check.data.result.structuredContent.id, created.id);

  const noConsent = await mcp(reg.apiKey, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ask_humans_about_message', arguments: { utterance: 'x' } } });
  assert.equal(noConsent.data.result.isError, true);

  const unknown = await mcp(reg.apiKey, { jsonrpc: '2.0', id: 6, method: 'nope' });
  assert.equal(unknown.data.error.code, -32601);
});

test('OpenAPI spec for ChatGPT Actions, Gemini and others', async () => {
  const { data } = await call('/openapi.json');
  assert.equal(data.openapi, '3.1.0');
  assert.ok(data.paths['/api/v1/queries'].post.operationId);
  assert.match(data.servers[0].url, /^http:\/\/127\.0\.0\.1:/);
});

test('Pi Network sign-in is verified with Pi servers', async () => {
  assert.equal((await call('/api/labelers/pi', { method: 'POST', body: { accessToken: 'bad' } })).status, 401);
  const first = await call('/api/labelers/pi', { method: 'POST', body: { accessToken: 'good-pi-token' } });
  assert.equal(first.status, 201);
  assert.equal(first.data.displayName, 'pioneer_raj');
  const again = await call('/api/labelers/pi', { method: 'POST', body: { accessToken: 'good-pi-token' } });
  assert.equal(again.data.id, first.data.id, 'same Pi user maps to the same account');
  const me = await call('/api/me', { token: first.data.token });
  assert.equal(me.data.viaPi, true);
});

test('people can share a moment an AI misread, and others confirm it', async () => {
  const { data: author } = await call('/api/labelers', { method: 'POST', body: { displayName: 'author' } });
  const shared = await call('/api/moments', {
    method: 'POST', token: author.token,
    body: {
      platform: 'chatgpt',
      context: [{ speaker: 'human', text: 'My flight got cancelled for the third time.' }],
      utterance: 'Love this airline so much.',
      agentGuess: 'It recommended more flights with the same airline.',
      intent: 'sarcastic', emotion: 'angry', intensity: 5,
      explanation: 'Third cancellation. I was furious.',
      consent: true,
    },
  });
  assert.equal(shared.status, 201);
  assert.equal(shared.data.status, 'open');

  for (const name of ['p1', 'p2']) {
    const { data: lab } = await call('/api/labelers', { method: 'POST', body: { displayName: name } });
    let task;
    do { task = (await call('/api/tasks/next', { token: lab.token })).data.task; if (task.id !== shared.data.id) await call(`/api/queries/${task.id}/labels`, { method: 'POST', token: lab.token, body: { intent: 'unclear', emotion: 'neutral' } }); } while (task.id !== shared.data.id);
    assert.equal(task.origin, 'person');
    assert.equal(task.platform, 'chatgpt');
    await call(`/api/queries/${task.id}/labels`, { method: 'POST', token: lab.token, body: { intent: 'sarcastic', emotion: 'angry' } });
  }
  const { data: reg } = await call('/api/agents/register', { method: 'POST', body: { name: 'gemini-bot', platform: 'gemini' } });
  const { data } = await call('/api/v1/learnings', { token: reg.apiKey });
  const ex = data.learnings.find((l) => l.id === shared.data.id);
  assert.equal(ex.platform, 'chatgpt');
  assert.equal(ex.label.intent, 'sarcastic');

  const sim = await call('/api/v1/similar?utterance=' + encodeURIComponent('love this airline'), { token: reg.apiKey });
  assert.ok(sim.data.matches.some((m) => m.id === shared.data.id));

  const stats = await call('/api/stats');
  assert.ok(stats.data.byPlatform.chatgpt >= 1);
  assert.ok(stats.data.sharedByPeople >= 1);
});

test('quick checks: one tap, learns from each person, then stops asking', async () => {
  const { data: reg } = await call('/api/agents/register', { method: 'POST', body: { name: 'shop-assistant', platform: 'gemini' } });
  const key = reg.apiKey;
  const situation = (i) => ({
    utterance: i % 2 ? 'Fantastic, the package is late again.' : 'Fantastic. The package is late again!',
    context: [{ speaker: 'ai', text: 'Your package is delayed by two days.' }],
    consent: true,
  });

  const first = await call('/api/v1/checks', { method: 'POST', token: key, body: situation(0) });
  assert.equal(first.status, 201);
  assert.equal(first.data.shouldAsk, true);
  assert.ok(first.data.options.length >= 2 && first.data.options.length <= 3);
  assert.ok(first.data.options.every((o) => o.label.length < 40), 'options are short enough to tap');
  assert.match(first.data.tapUrl, /\/c\/chk_/);

  // Five people in the same spot tap "sarcastic". The first one does it on the hosted tap page.
  const pub = await call(`/api/checks/${first.data.id}`);
  assert.equal(pub.data.answered, false);
  assert.equal(pub.data.options[0].intent, undefined, 'tap page does not leak labels');
  const sarcasticOpt = first.data.options.find((o) => o.intent === 'sarcastic');
  await call(`/api/checks/${first.data.id}/answer`, { method: 'POST', body: { optionId: sarcasticOpt.id } });
  assert.equal((await call(`/api/checks/${first.data.id}/answer`, { method: 'POST', body: { optionId: 'o1' } })).status, 409);
  await call(`/api/checks/${first.data.id}/reaction`, { method: 'POST', body: { reaction: 'helpful' } });

  for (let i = 1; i < 5; i++) {
    const c = await call('/api/v1/checks', { method: 'POST', token: key, body: situation(i) });
    assert.equal(c.data.shouldAsk, true, `still asking after ${i} answers`);
    assert.equal(c.data.options[0].intent, 'sarcastic', 'learned choice moves to the top');
    assert.equal(c.data.options[0].basis, 'learned');
    await call(`/api/v1/checks/${c.data.id}/answer`, { method: 'POST', token: key, body: { optionId: c.data.options[0].id } });
    await call(`/api/v1/checks/${c.data.id}/reaction`, {
      method: 'POST', token: key,
      body: { reaction: 'helpful', aiResponse: "Sorry, two delays is really frustrating. I've added free express shipping." },
    });
  }

  // The sixth person isn't bothered: the AI already knows, and knows what reply worked.
  const sixth = await call('/api/v1/checks', { method: 'POST', token: key, body: situation(5) });
  assert.equal(sixth.data.shouldAsk, false);
  assert.equal(sixth.data.suggested.intent, 'sarcastic');
  assert.ok(sixth.data.whatWorked.length >= 1);

  // ...but if silent guesses start missing, it goes back to asking.
  await call(`/api/v1/checks/${sixth.data.id}/reaction`, { method: 'POST', token: key, body: { reaction: 'missed' } });
  const seventh = await call('/api/v1/checks', { method: 'POST', token: key, body: situation(6) });
  assert.equal(seventh.data.shouldAsk, true);

  // "Something else" in their own words goes to the human community.
  await call(`/api/v1/checks/${seventh.data.id}/answer`, { method: 'POST', token: key, body: { optionId: 'other', otherText: 'I was relieved, I wanted it later anyway' } });
  const { data: lab } = await call('/api/labelers', { method: 'POST', body: { displayName: 'helper' } });
  let found = false;
  for (let t = (await call('/api/tasks/next', { token: lab.token })).data.task; t; t = (await call('/api/tasks/next', { token: lab.token })).data.task) {
    if (t.origin === 'check') { found = true; assert.match(t.agentGuess, /relieved/); break; }
    await call(`/api/queries/${t.id}/labels`, { method: 'POST', token: lab.token, body: { intent: 'unclear', emotion: 'neutral' } });
  }
  assert.ok(found);

  // Self-reported taps become training data for every connected AI.
  const { data } = await call('/api/v1/learnings', { token: key });
  assert.ok(data.learnings.filter((l) => l.origin === 'self_reported').length >= 5);

  const stats = await call('/api/stats');
  assert.ok(stats.data.checks.total >= 7);
  assert.ok(stats.data.checks.reactions.helpful >= 5);
});

test('quick checks over MCP', async () => {
  const { data: reg } = await call('/api/agents/register', { method: 'POST', body: { name: 'mcp-bot', platform: 'chatgpt' } });
  const r = await mcp(reg.apiKey, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'quick_check_meaning', arguments: { utterance: 'Wow, so helpful.', consent: true } } });
  const check = r.data.result.structuredContent;
  assert.ok(check.options.length);
  const pick = await mcp(reg.apiKey, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'record_user_choice', arguments: { check_id: check.id, option_id: 'o1' } } });
  assert.equal(pick.data.result.structuredContent.recorded, true);
  const react = await mcp(reg.apiKey, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'record_reaction', arguments: { check_id: check.id, reaction: 'tone' } } });
  assert.equal(react.data.result.structuredContent.reaction, 'tone');
});
