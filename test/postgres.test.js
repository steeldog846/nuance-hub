// Runs only when TEST_DATABASE_URL points at a Postgres database it may write to.
// Checks what hosting on Vercel relies on: separate server instances sharing one
// database see each other's writes, and data survives an instance going away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

const url = process.env.TEST_DATABASE_URL;

async function start() {
  const app = createApp({ dataFile: null, databaseUrl: url, fetchImpl: async () => ({ ok: true }) });
  await new Promise((r) => app.listen(0, r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  return { app, call, stop: async () => { app.close(); await app.db.close(); } };
}

test('two server instances share one Postgres database', { skip: !url && 'set TEST_DATABASE_URL to run' }, async () => {
  const a = await start();
  const b = await start();
  try {
    assert.equal((await a.call('/api/health')).data.storage, 'postgres');

    // An agent registers on instance A and asks on instance B.
    const { data: reg } = await a.call('/api/agents/register', { method: 'POST', body: { name: 'pg-agent', platform: 'claude' } });
    const chk = await b.call('/api/v1/checks', { method: 'POST', token: reg.apiKey, body: { utterance: 'Brilliant, the app froze AGAIN', consent: true } });
    assert.equal(chk.status, 201, 'instance B sees the key created on A');

    // The person answers through A; the agent reads the result on B.
    const sarc = chk.data.options.find((o) => o.intent === 'sarcastic');
    await a.call(`/api/checks/${chk.data.id}/answer`, { method: 'POST', body: { optionIds: [sarc.id], ownFeeling: 'fed up' } });
    const seen = await b.call(`/api/v1/checks/${chk.data.id}`, { token: reg.apiKey });
    assert.deepEqual(seen.data.choice.intents, ['sarcastic']);

    // A brand-new instance (like a cold start) loads everything from the database.
    await a.stop();
    const c = await start();
    const again = await c.call(`/api/v1/checks/${chk.data.id}`, { token: reg.apiKey });
    assert.deepEqual(again.data.choice.emotions, ['frustrated']);
    await c.stop();
  } finally {
    await b.stop();
  }
});
