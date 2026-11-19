// One place where Nuance Hub talks to Claude.
//
// Claude is optional: with ANTHROPIC_API_KEY set (and `npm install` run) the app
// uses it to make the instant first guess and to read people's own words in
// any language or script. Without it, everything falls back to the built-in
// rules, so the app never stops working because Claude is unreachable.

const MODEL = () => process.env.NUANCE_MODEL || 'claude-opus-5-5';

// Keys pasted into hosting dashboards often pick up spaces, line breaks or quote marks.
const cleanKey = () => (process.env.ANTHROPIC_API_KEY || '').trim().replace(/^["']+|["']+$/g, '').trim();

// What kind of key this looks like, without revealing any of it.
function keyShape() {
  const raw = process.env.ANTHROPIC_API_KEY || '';
  const key = cleanKey();
  if (!key) return null;
  const kind = key.startsWith('sk-ant-api') ? 'Claude API key'
    : key.startsWith('sk-ant-admin') ? 'Claude Admin key (cannot call Claude; create a normal API key)'
    : key.startsWith('sk-ant-oat') || key.startsWith('sk-ant-ort') ? 'Claude login token (not an API key; create one at console.anthropic.com)'
    : key.startsWith('sk-ant-') ? 'other Anthropic key'
    : key.startsWith('sk-') ? 'not an Anthropic key (looks like another provider\'s key)'
    : 'not an Anthropic key';
  return { kind, length: key.length, hadExtraSpacesOrQuotes: raw !== key };
}

let clientPromise = null;
let injected = null;
let lastError = null;

// Tests (or another host) can supply their own client.
export function setClaudeClient(client) {
  injected = client;
  clientPromise = null;
}

async function getClient() {
  if (injected) return injected;
  const apiKey = cleanKey();
  if (!apiKey) return null;
  if (!clientPromise) {
    clientPromise = import('@anthropic-ai/sdk')
      .then(({ default: Anthropic }) => new Anthropic({ apiKey, timeout: 30_000, maxRetries: 1 }))
      .catch(() => { lastError = 'The Claude SDK is not installed (run npm install).'; return null; });
  }
  return clientPromise;
}

export function claudeStatus() {
  const configured = Boolean(injected || cleanKey());
  return { configured, model: configured ? MODEL() : null, key: injected ? null : keyShape(), lastError };
}

// Ask Claude for JSON matching `schema`. Returns the parsed object, or null if Claude
// is off, declines, or fails (the caller then uses the built-in rules).
export async function askClaudeJson({ system, prompt, schema, maxTokens = 2000, effort = 'low' }) {
  const client = await getClient();
  if (!client) return null;
  try {
    const response = await client.beta.messages.create({
      model: MODEL(),
      max_tokens: maxTokens,
      // If Claude declines on safety grounds, the API retries on a suitable fallback model in the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort, format: { type: 'json_schema', schema } },
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
    });
    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') return null;
    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) return null;
    lastError = null;
    return JSON.parse(text);
  } catch (err) {
    lastError = `${err.status ? `${err.status} ` : ''}${err.message}`;
    if (err.status === 401) console.warn('[nuance] Claude rejected the API key (401). Check ANTHROPIC_API_KEY. Using built-in rules.');
    else console.warn('[nuance] Claude call failed, using built-in rules:', lastError);
    return null;
  }
}
