import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { LIMITS } from '../src/guard.js';

delete process.env.ANTHROPIC_API_KEY;

let server, base;
before(async () => {
  server = createApp({
    dataFile: null,
    adminToken: 'admin-secret',
    googleClientId: 'my-app.apps.googleusercontent.com',
    // Real rules, with smaller numbers so tests stay quick.
    limits: { ...LIMITS, registerAgent: { per: 'ip', max: 3, windowSec: 3600 }, agentDailyTrial: { per: 'agent', max: 4, windowSec: 86400 }, labelGuest: { per: 'guide', max: 2, windowSec: 86400 } },
    fetchImpl: async (url) => {
      const token = new URL(url).searchParams.get('id_token');
      const good = { iss: 'https://accounts.google.com', aud: 'my-app.apps.googleusercontent.com', sub: 'g-123', email_verified: 'true', given_name: 'Priya' };
      const bodies = { good, wrongApp: { ...good, aud: 'someone-else' }, unverified: { ...good, email_verified: 'false' } };
      return bodies[token] ? { ok: true, status: 200, json: async () => bodies[token] } : { ok: false, status: 400, json: async () => ({}) };
    },
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function call(path, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json(), headers: res.headers };
}
const admin = { 'x-admin-token': 'admin-secret' };

test('registration is limited per address and catches bots', async () => {
  const ip = { 'x-real-ip': '203.0.113.7' };
  assert.equal((await call('/api/agents/register', { method: 'POST', headers: ip, body: { name: 'bot', website: 'spam.example' } })).status, 400);
  for (let i = 0; i < 3; i++) assert.equal((await call("/api/agents/register", { method: "POST", headers: ip, body: { name: `a${i}` } })).status, 201);
  const blocked = await call('/api/agents/register', { method: 'POST', headers: ip, body: { name: 'too-many' } });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  // A different address is unaffected.
  assert.equal((await call('/api/agents/register', { method: 'POST', headers: { 'x-real-ip': '198.51.100.1' }, body: { name: 'other' } })).status, 201);
});

test('new agents are on a trial allowance until approved; admins can block them', async () => {
  const { data: reg } = await call('/api/agents/register', { method: 'POST', headers: { 'x-real-ip': '192.0.2.10' }, body: { name: 'trial-bot' } });
  assert.equal(reg.status, 'trial');
  const ask = () => call('/api/v1/checks', { method: 'POST', token: reg.apiKey, body: { utterance: 'great, again', consent: true } });
  for (let i = 0; i < 4; i++) assert.equal((await ask()).status, 201);
  const over = await ask();
  assert.equal(over.status, 429);
  assert.match(over.data.error, /approve/);

  assert.equal((await call(`/api/admin/agents/${reg.id}`, { method: 'POST', body: { status: 'approved' } })).status, 403, 'needs the admin password');
  assert.equal((await call(`/api/admin/agents/${reg.id}`, { method: 'POST', headers: { 'x-admin-token': 'wrong' }, body: { status: 'approved' } })).status, 403);
  assert.equal((await call(`/api/admin/agents/${reg.id}`, { method: 'POST', headers: admin, body: { status: 'approved' } })).status, 200);
  assert.equal((await ask()).status, 201, 'approved agents get the larger allowance');

  await call(`/api/admin/agents/${reg.id}`, { method: 'POST', headers: admin, body: { status: 'blocked' } });
  assert.equal((await ask()).status, 403);
  const mcp = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${reg.apiKey}` }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  assert.equal(mcp.status, 403);

  const { data: overview } = await call('/api/admin/overview', { headers: admin });
  assert.equal(overview.agents.find((a) => a.id === reg.id).status, 'blocked');
});

test('Google sign-in is verified, keeps no email, and lifts guest limits', async () => {
  assert.equal((await call('/api/config')).data.googleClientId, 'my-app.apps.googleusercontent.com');
  for (const bad of ['forged', 'wrongApp', 'unverified']) {
    assert.equal((await call('/api/labelers/google', { method: 'POST', headers: { 'x-real-ip': '192.0.2.50' }, body: { credential: bad } })).status, 401, bad);
  }
  const g = await call('/api/labelers/google', { method: 'POST', headers: { 'x-real-ip': '192.0.2.51' }, body: { credential: 'good' } });
  assert.equal(g.status, 201);
  assert.equal(g.data.displayName, 'Priya');
  const again = await call('/api/labelers/google', { method: 'POST', headers: { 'x-real-ip': '192.0.2.51' }, body: { credential: 'good' } });
  assert.equal(again.data.id, g.data.id, 'same Google account, same guide');
  const me = await call('/api/me', { token: g.data.token });
  assert.equal(me.data.verified, true);
  assert.equal(me.data.verifiedBy, 'google');
  assert.equal(JSON.stringify(server.db.data.labelers).includes('@'), false, 'no email stored');
});

test('guests have smaller limits and half-weight votes; blocked guides are signed out', async () => {
  const { data: reg } = await call('/api/agents/register', { method: 'POST', headers: { 'x-real-ip': '192.0.2.60' }, body: { name: 'asker' } });
  await call(`/api/admin/agents/${reg.id}`, { method: 'POST', headers: admin, body: { status: 'approved' } });
  const q = [];
  for (let i = 0; i < 3; i++) q.push((await call('/api/v1/queries', { method: 'POST', token: reg.apiKey, body: { utterance: `message number ${i}`, consent: true } })).data.id);

  const { data: guest } = await call('/api/labelers', { method: 'POST', headers: { 'x-real-ip': '192.0.2.61' }, body: { displayName: 'guest' } });
  const label = (id, token) => call(`/api/queries/${id}/labels`, { method: 'POST', token, body: { intents: ['sarcastic'], emotions: ['annoyed'] } });
  assert.equal((await label(q[0], guest.token)).status, 201);
  assert.equal((await label(q[1], guest.token)).status, 201);
  const third = await label(q[2], guest.token);
  assert.equal(third.status, 429);
  assert.match(third.data.error, /Sign in with Google or Pi/);

  // Guest says sarcastic; a signed-in guide says sincere. The signed-in vote counts double.
  const { data: verifiedGuide } = await call('/api/labelers/google', { method: 'POST', headers: { 'x-real-ip': '192.0.2.62' }, body: { credential: 'good' } });
  const r = await call(`/api/queries/${q[0]}/labels`, { method: 'POST', token: verifiedGuide.token, body: { intents: ['sincere'], emotions: ['calm'] } });
  assert.equal(r.data.consensus.intent, 'sincere');
  assert.ok(r.data.consensus.intentDistribution.sincere > r.data.consensus.intentDistribution.sarcastic);

  await call(`/api/admin/guides/${guest.id}`, { method: 'POST', headers: admin, body: { blocked: true } });
  assert.equal((await call('/api/me', { token: guest.token })).status, 401, 'blocking signs them out');
});

test('admin is off unless a password is set', async () => {
  const noAdmin = createApp({ dataFile: null, limits: false });
  await new Promise((r) => noAdmin.listen(0, r));
  const res = await fetch(`http://127.0.0.1:${noAdmin.address().port}/api/admin/overview`, { headers: { 'x-admin-token': '' } });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /NUANCE_ADMIN_TOKEN/);
  noAdmin.close();
});
