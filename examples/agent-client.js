// Example: how an AI agent plugs into Nuance Hub.
//
//   NUANCE_URL=http://localhost:3000 node examples/agent-client.js
//
// 1. registers itself (in real life: once, then keep the key in a secret store)
// 2. sends a message it could not read
// 3. uses the instant first answer
// 4. later pulls everything the community has settled, to learn from

const BASE = process.env.NUANCE_URL || 'http://localhost:3000';

async function call(path, { method = 'GET', body, key } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body && JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

const key = process.env.NUANCE_API_KEY || (await call('/api/agents/register', {
  method: 'POST',
  body: { name: 'example-agent', description: 'Customer support assistant' },
})).apiKey;

const asked = await call('/api/v1/queries', {
  method: 'POST',
  key,
  body: {
    context: [
      { speaker: 'ai', text: 'Your order will arrive in 3-5 weeks.' },
      { speaker: 'human', text: 'Weeks?' },
    ],
    utterance: 'Wow, thanks a lot, that is super fast.',
    question: 'Is the customer happy with the delivery time?',
    agentGuess: 'happy',
    difficulty: 'intent',
    consent: true,
  },
});

console.log('Question id:', asked.id);
console.log('Instant answer:', asked.appAnswer.intent, '/', asked.appAnswer.emotion, `(${asked.appAnswer.source})`);
console.log('Why:', asked.appAnswer.explanation);

// Later (or on your webhook): fetch the human consensus and learn from it.
const { learnings } = await call('/api/v1/learnings', { key });
console.log(`The community has settled ${learnings.length} examples you can learn from.`);
