const $ = (id) => document.getElementById(id);
const pretty = (s) => (s || '').replace(/_/g, ' ');
const PLATFORM_NAMES = {
  claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini', copilot: 'Copilot', meta_ai: 'Meta AI', grok: 'Grok',
  mistral: 'Mistral', deepseek: 'DeepSeek', perplexity: 'Perplexity', pi_network: 'a Pi Network app',
  open_source: 'an open-source model', custom: 'a custom AI', other: 'another AI',
};
const platformName = (p) => PLATFORM_NAMES[p] || 'an AI';
const parseTurns = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
  const m = l.match(/^(ai|human)\s*:\s*(.*)$/i);
  return m ? { speaker: m[1].toLowerCase(), text: m[2] } : { speaker: 'human', text: l };
});

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let taxonomy = null;
let current = null;
const choice = { intent: null, emotion: null };
const shareChoice = { intent: null, emotion: null };
let labelerToken = store.get('nuance.labeler');

// ------------------------------------------------------------------ tabs
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${tab.dataset.view}`; });
    if (tab.dataset.view === 'community') loadStats();
    if (tab.dataset.view === 'share') $('share-signin-note').hidden = Boolean(labelerToken);
  });
});

// ------------------------------------------------------------------ labeler
function chips(container, values, field, target = choice) {
  container.innerHTML = '';
  for (const v of values) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = pretty(v);
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      target[field] = v;
      container.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
    });
    container.appendChild(b);
  }
}

function show(...ids) {
  for (const id of ['signin', 'me-bar', 'empty', 'task', 'result']) $(id).hidden = !ids.includes(id);
}

async function refreshMe() {
  const me = await api('/api/me', { token: labelerToken });
  $('me-name').textContent = me.displayName;
  $('me-rep').textContent = me.reputation.toFixed(2);
  $('me-count').textContent = me.labeled;
}

async function loadTask() {
  if (!labelerToken) return show('signin');
  try { await refreshMe(); } catch { labelerToken = null; store.set('nuance.labeler', null); return show('signin'); }
  const { task } = await api('/api/tasks/next', { token: labelerToken });
  current = task;
  if (!task) return show('me-bar', 'empty');
  renderTask(task);
  show('me-bar', 'task');
}

function renderTask(t) {
  $('t-difficulty').textContent = `${pretty(t.difficulty)} question`;
  $('t-meta').textContent = `${t.labelCount} ${t.labelCount === 1 ? 'person has' : 'people have'} answered · ${t.locale}`;
  $('t-origin').textContent = t.origin === 'person'
    ? `Shared by a person: ${platformName(t.platform)} misread them. Do you read it the way they did?`
    : `Asked by ${platformName(t.platform)}.`;
  const ctx = $('t-context');
  ctx.innerHTML = '';
  for (const turn of t.context) {
    const d = document.createElement('div');
    d.className = `turn ${turn.speaker}`;
    const who = document.createElement('b');
    who.textContent = turn.speaker === 'ai' ? 'AI' : 'Person';
    d.append(who, document.createTextNode(turn.text));
    ctx.appendChild(d);
  }
  $('t-utterance').textContent = `“${t.utterance}”`;
  $('t-question').textContent = t.question;
  $('t-guess').textContent = t.agentGuess ? `${t.origin === 'person' ? 'What the AI did' : "The AI's own guess"}: ${t.agentGuess}` : '';
  const a = t.appAnswer;
  $('t-source').textContent = { precedent: '(from earlier answers)', llm: '(from Claude)', heuristic: '(from simple rules)' }[a.source] || '';
  $('t-conf').textContent = `${Math.round(a.confidence * 100)}% sure`;
  $('t-app-intent').textContent = pretty(a.intent);
  $('t-app-emotion').textContent = pretty(a.emotion);
  $('t-app-why').textContent = a.explanation;

  $('task').reset();
  $('intensity-out').textContent = '3';
  $('task-error').hidden = true;
  choice.intent = choice.emotion = null;
  chips($('intent-chips'), taxonomy.intents, 'intent');
  chips($('emotion-chips'), taxonomy.emotions, 'emotion');
}

$('intensity').addEventListener('input', (e) => { $('intensity-out').textContent = e.target.value; });

function signedIn(token) {
  labelerToken = token;
  store.set('nuance.labeler', token);
  $('share-signin-note').hidden = true;
  loadTask();
}

$('signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { token } = await api('/api/labelers', { method: 'POST', body: { displayName: $('displayName').value } });
  signedIn(token);
});

// Pi Network: only offered inside the Pi Browser, where the Pi SDK can authenticate.
const inPiBrowser = /PiBrowser/i.test(navigator.userAgent) || new URLSearchParams(location.search).has('pi');
if (inPiBrowser) {
  $('pi-signin').hidden = false;
  $('pi-or').hidden = false;
  const sdk = document.createElement('script');
  sdk.src = 'https://sdk.minepi.com/pi-sdk.js';
  sdk.onload = () => window.Pi.init({ version: '2.0', sandbox: new URLSearchParams(location.search).has('pi_sandbox') });
  document.head.appendChild(sdk);
  $('pi-signin').addEventListener('click', async () => {
    const err = $('signin-error');
    err.hidden = true;
    try {
      const auth = await window.Pi.authenticate(['username'], () => {});
      const { token } = await api('/api/labelers/pi', { method: 'POST', body: { accessToken: auth.accessToken } });
      signedIn(token);
    } catch (ex) {
      err.textContent = ex.message || 'Pi sign-in failed';
      err.hidden = false;
    }
  });
}

$('signout').addEventListener('click', () => { labelerToken = null; store.set('nuance.labeler', null); show('signin'); });

// ------------------------------------------------------------------ share a moment
$('s-intensity').addEventListener('input', (e) => { $('s-intensity-out').textContent = e.target.value; });
$('share').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('share-error'), ok = $('share-ok');
  err.hidden = ok.hidden = true;
  const fail = (m) => { err.textContent = m; err.hidden = false; };
  if (!labelerToken) return fail('Sign in on the “Answer questions” tab first.');
  if (!shareChoice.intent || !shareChoice.emotion) return fail('Pick what you meant and how you felt.');
  if (!$('s-consent').checked) return fail('Please confirm this is your conversation and names are removed.');
  try {
    await api('/api/moments', {
      method: 'POST',
      token: labelerToken,
      body: {
        platform: $('s-platform').value,
        context: parseTurns($('s-context').value),
        utterance: $('s-utterance').value,
        agentGuess: $('s-misread').value,
        intent: shareChoice.intent,
        emotion: shareChoice.emotion,
        intensity: Number($('s-intensity').value),
        explanation: $('s-explanation').value,
        consent: true,
      },
    });
    $('share').reset();
    $('s-intensity-out').textContent = '3';
    shareChoice.intent = shareChoice.emotion = null;
    chips($('s-intent-chips'), taxonomy.intents, 'intent', shareChoice);
    chips($('s-emotion-chips'), taxonomy.emotions, 'emotion', shareChoice);
    ok.textContent = 'Shared, thank you. Once two more people agree with you, every connected AI can learn from it.';
    ok.hidden = false;
  } catch (ex) { fail(ex.message); }
});
$('refresh').addEventListener('click', loadTask);
$('next').addEventListener('click', loadTask);
$('skip').addEventListener('click', loadTask); // skipping just fetches again; a real app would remember skips

$('task').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('task-error');
  if (!choice.intent || !choice.emotion) {
    err.textContent = 'Pick what they meant and how they felt.';
    err.hidden = false;
    return;
  }
  try {
    const out = await api(`/api/queries/${current.id}/labels`, {
      method: 'POST',
      token: labelerToken,
      body: {
        intent: choice.intent,
        emotion: choice.emotion,
        intensity: Number($('intensity').value),
        appAnswerVerdict: document.querySelector('input[name=verdict]:checked')?.value,
        explanation: $('explanation').value,
      },
    });
    renderResult(out);
    await refreshMe();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

function renderResult({ status, consensus: c }) {
  $('r-title').textContent = status === 'resolved' ? 'Settled. The AI has its answer.'
    : status === 'disputed' ? 'People genuinely disagree on this one.'
    : 'Thanks! Your answer is in.';
  $('r-sub').textContent = `${c.labelCount} ${c.labelCount === 1 ? 'answer' : 'answers'} so far · ${Math.round(c.agreement * 100)}% agreement`;
  const bars = $('r-bars');
  bars.innerHTML = '';
  const section = (title, dist) => {
    const h = document.createElement('h3');
    h.textContent = title;
    bars.appendChild(h);
    Object.entries(dist).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
      const row = document.createElement('div');
      row.className = 'bar';
      row.innerHTML = '<span></span><div class="bar-track"><div class="bar-fill"></div></div><span></span>';
      row.children[0].textContent = pretty(k);
      row.querySelector('.bar-fill').style.width = `${v * 100}%`;
      row.children[2].textContent = `${Math.round(v * 100)}%`;
      bars.appendChild(row);
    });
  };
  section('What they meant', c.intentDistribution);
  section('How they felt', c.emotionDistribution);
  show('me-bar', 'result');
}

// ------------------------------------------------------------------ agents demo
let agentKey = store.get('nuance.agentKey');
if (agentKey) $('agent-key-out').textContent = 'A demo agent key is saved in this browser.';

$('register-agent').addEventListener('click', async () => {
  try {
    const platform = $('agent-platform').value;
    const out = await api('/api/agents/register', { method: 'POST', body: { name: $('agent-name').value || 'demo-agent', platform } });
    agentKey = out.apiKey;
    store.set('nuance.agentKey', agentKey);
    $('agent-key-out').textContent = `Registered “${out.name}”. API key: ${out.apiKey} (copy it now)`;
    renderGuide(GUIDE_FOR[platform] || 'other');
  } catch (ex) { $('agent-key-out').textContent = ex.message; }
});

$('send-demo').addEventListener('click', async () => {
  const out = $('demo-out');
  out.hidden = false;
  if (!agentKey) { out.textContent = 'Register an agent first.'; return; }
  const context = parseTurns($('demo-context').value);
  try {
    const res = await api('/api/v1/queries', {
      method: 'POST',
      token: agentKey,
      body: { utterance: $('demo-utterance').value, question: $('demo-question').value, context, consent: $('demo-consent').checked },
    });
    out.textContent = JSON.stringify(res, null, 2);
  } catch (ex) { out.textContent = ex.message; }
});

// ------------------------------------------------------------------ connection guides
const GUIDE_FOR = { claude: 'claude', chatgpt: 'chatgpt', gemini: 'gemini', copilot: 'copilot', pi_network: 'pi' };
const GUIDES = {
  claude: ['Claude', (b, k) => `<ol>
    <li><b>Claude Code</b>: run<pre class="code">claude mcp add --transport http nuance ${b}/mcp --header "Authorization: Bearer ${k}"</pre></li>
    <li><b>Claude desktop or claude.ai</b>: Settings → Connectors → Add custom connector, URL:<pre class="code">${b}/mcp?key=${k}</pre></li>
    <li><b>Your own app on the Claude API</b>: add the same URL as an MCP server, or call the REST API as a tool.</li></ol>`],
  chatgpt: ['ChatGPT', (b, k) => `<ol>
    <li><b>Custom GPT</b>: Create a GPT → Configure → Actions → Import from URL:<pre class="code">${b}/openapi.json</pre>Authentication: API key, Bearer, paste <code>${k}</code>.</li>
    <li><b>ChatGPT connectors / OpenAI Agents SDK</b>: add an MCP server with URL <code>${b}/mcp</code> and header <code>Authorization: Bearer ${k}</code>.</li></ol>`],
  gemini: ['Gemini', (b, k) => `<ol>
    <li><b>Gemini CLI</b>: add to <code>~/.gemini/settings.json</code><pre class="code">{"mcpServers": {"nuance": {
  "httpUrl": "${b}/mcp",
  "headers": {"Authorization": "Bearer ${k}"}}}}</pre></li>
    <li><b>Gemini API / Vertex AI agents</b>: load <code>${b}/openapi.json</code> as an OpenAPI tool, or declare the operations as functions.</li></ol>`],
  copilot: ['Copilot', (b, k) => `<ol>
    <li><b>Copilot Studio</b>: Tools → Add a tool → Model Context Protocol, URL <code>${b}/mcp</code>, API key auth (Bearer <code>${k}</code>). Or add a REST API tool from <code>${b}/openapi.json</code>.</li>
    <li><b>GitHub Copilot in VS Code</b>: add an HTTP MCP server with the same URL and header.</li></ol>`],
  pi: ['Pi Network apps', (b, k) => `<ol>
    <li>Call the REST API from your Pi app's <b>backend</b>, never from the browser, so the key stays secret.</li>
    <li><pre class="code">POST ${b}/api/v1/queries
Authorization: Bearer ${k}
{"utterance": "...", "context": [...], "consent": true}</pre></li>
    <li>Pi users can also join as human guides with “Sign in with Pi” when they open this site in the Pi Browser.</li></ol>`],
  other: ['Any other AI', (b, k) => `<ol>
    <li><b>MCP</b> (most agent tools, Cursor, LangChain, LlamaIndex): <code>${b}/mcp</code> + header <code>Authorization: Bearer ${k}</code>.</li>
    <li><b>OpenAPI</b>: <code>${b}/openapi.json</code>.</li>
    <li><b>Plain HTTP</b>, e.g. Python:<pre class="code">import requests
r = requests.post("${b}/api/v1/queries",
    headers={"Authorization": "Bearer ${k}"},
    json={"utterance": "Oh great, another Monday.", "consent": True})
print(r.json()["appAnswer"])</pre></li></ol>`],
};

function renderGuide(id) {
  const base = location.origin;
  const key = agentKey || 'YOUR_API_KEY';
  $('guide').innerHTML = GUIDES[id][1](base, key);
  $('guide-tabs').querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.id === id)));
}
for (const [id, [label]] of Object.entries(GUIDES)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.dataset.id = id;
  b.textContent = label;
  b.addEventListener('click', () => renderGuide(id));
  $('guide-tabs').appendChild(b);
}
renderGuide('claude');

// ------------------------------------------------------------------ community
async function loadStats() {
  const s = await api('/api/stats');
  const items = [['Questions asked', s.questions], ['Shared by people', s.sharedByPeople], ['Waiting for people', s.open], ['Settled', s.resolved], ['Disputed', s.disputed], ['Human guides', s.labelers], ['AI agents', s.agents]];
  $('stats').innerHTML = '';
  for (const [label, n] of items) {
    const d = document.createElement('div');
    d.className = 'stat';
    d.innerHTML = '<b></b><span></span>';
    d.children[0].textContent = n;
    d.children[1].textContent = label;
    $('stats').appendChild(d);
  }
  const bp = $('by-platform');
  bp.innerHTML = '';
  const total = Object.values(s.byPlatform).reduce((a, b) => a + b, 0);
  if (!total) bp.innerHTML = '<p class="muted small">No questions yet.</p>';
  Object.entries(s.byPlatform).sort((a, b) => b[1] - a[1]).forEach(([p, n]) => {
    const row = document.createElement('div');
    row.className = 'bar';
    row.innerHTML = '<span></span><div class="bar-track"><div class="bar-fill"></div></div><span></span>';
    row.children[0].textContent = (PLATFORM_NAMES[p] || p).replace(/^(a|an) /, '');
    row.querySelector('.bar-fill').style.width = `${(n / total) * 100}%`;
    row.children[2].textContent = n;
    bp.appendChild(row);
  });
  const lb = $('leaderboard');
  lb.innerHTML = '';
  if (!s.leaderboard.length) lb.innerHTML = '<li class="muted">No one yet. Be the first.</li>';
  for (const l of s.leaderboard) {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><span class="muted small"></span>';
    li.children[0].textContent = l.displayName;
    li.children[1].textContent = `trust ${l.reputation.toFixed(2)} · ${l.labeled} answered${l.viaPi ? ' · Pi' : ''}`;
    lb.appendChild(li);
  }
}

// ------------------------------------------------------------------ boot
api('/api/taxonomy').then((t) => {
  taxonomy = t;
  for (const sel of [$('s-platform'), $('agent-platform')]) {
    for (const p of t.platforms) {
      const o = document.createElement('option');
      o.value = p;
      o.textContent = (PLATFORM_NAMES[p] || p).replace(/^(a|an) /, '').replace(/^./, (c) => c.toUpperCase());
      sel.appendChild(o);
    }
  }
  chips($('s-intent-chips'), t.intents, 'intent', shareChoice);
  chips($('s-emotion-chips'), t.emotions, 'emotion', shareChoice);
  loadTask();
});
