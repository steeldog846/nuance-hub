import { analyzeTyping } from '/lib/style.js';

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
const shareChoice = { intent: null, emotion: null, platform: null };
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
// multi: tapping toggles, and target[field] is a list (people can pick several meanings and feelings).
function chips(container, values, field, target = choice, { multi = false, label = pretty } = {}) {
  container.innerHTML = '';
  target[field] = multi ? [] : null;
  for (const v of values) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = label(v);
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      if (multi) {
        const on = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', String(on));
        target[field] = on ? [...target[field], v] : target[field].filter((x) => x !== v);
      } else {
        target[field] = v;
        container.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
      }
    });
    container.appendChild(b);
  }
}

const emotionText = (e) => `${taxonomy.emotionEmoji?.[e] || ''} ${taxonomy.emotionLabels?.[e] || pretty(e)}`.trim();
const intentText = (i) => taxonomy.intentPhrases?.[i] || pretty(i);
const STYLE_NOTE = {
  stressed_words: (t) => `Typed with ${t.shoutedWords.map((w) => `“${w}”`).join(', ')} in capitals`,
  all_caps: () => 'Typed in ALL CAPITALS',
  mocking_case: () => 'Typed in mOcKiNg case',
};
function typingNote(t) {
  if (!t) return '';
  const parts = [];
  if (STYLE_NOTE[t.style]) parts.push(STYLE_NOTE[t.style](t));
  if (t.exclamations >= 2) parts.push(`${t.exclamations} exclamation marks`);
  if (t.elongated?.length) parts.push(`stretched: ${t.elongated.join(', ')}`);
  return parts.length ? `✍️ ${parts.join(' · ')}` : '';
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
  $('t-typing').textContent = typingNote(t.typing);
  $('t-typing').hidden = !$('t-typing').textContent;
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
  chips($('intent-chips'), taxonomy.intents, 'intents', choice, { multi: true });
  chips($('emotion-chips'), taxonomy.emotions, 'emotions', choice, { multi: true, label: emotionText });
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
$('share').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('share-error'), ok = $('share-ok');
  err.hidden = ok.hidden = true;
  const fail = (m) => { err.textContent = m; err.hidden = false; };
  if (!labelerToken) return fail('Sign in on the “Answer questions” tab first.');
  const sOwnM = $('s-own-meaning').value.trim(), sOwnF = $('s-own-feeling').value.trim();
  if (!shareChoice.intents?.length && !sOwnM) return fail('Tap what you meant, or say it in your own words.');
  if (!shareChoice.emotions?.length && !sOwnF) return fail('Tap how you felt, or say it in your own words.');
  if (!$('s-consent').checked) return fail('Please confirm this is your conversation and names are removed.');
  try {
    await api('/api/moments', {
      method: 'POST',
      token: labelerToken,
      body: {
        platform: shareChoice.platform || 'other',
        context: parseTurns($('s-context').value),
        utterance: $('s-utterance').value,
        agentGuess: $('s-misread').value,
        intents: shareChoice.intents,
        emotions: shareChoice.emotions,
        ownMeaning: sOwnM,
        ownFeeling: sOwnF,
        explanation: $('s-explanation').value,
        consent: true,
      },
    });
    $('share').reset();
    renderShareChips();
    $('s-typing').textContent = '';
    $('s-own-meaning').value = $('s-own-feeling').value = '';
    ok.textContent = 'Shared, thank you. Once two more people agree, every connected AI learns from it.';
    ok.hidden = false;
  } catch (ex) { fail(ex.message); }
});
$('refresh').addEventListener('click', loadTask);
$('next').addEventListener('click', loadTask);
$('skip').addEventListener('click', loadTask); // skipping just fetches again; a real app would remember skips

$('task').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('task-error');
  const ownM = $('own-meaning').value.trim(), ownF = $('own-feeling').value.trim();
  if ((!choice.intents?.length && !ownM) || (!choice.emotions?.length && !ownF)) {
    err.textContent = 'Tap a meaning and a feeling, or say them in your own words.';
    err.hidden = false;
    return;
  }
  try {
    const out = await api(`/api/queries/${current.id}/labels`, {
      method: 'POST',
      token: labelerToken,
      body: {
        intents: choice.intents,
        emotions: choice.emotions,
        ownMeaning: ownM,
        ownFeeling: ownF,
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
  section('What they meant (share of people who picked each)', c.intentDistribution);
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

// ------------------------------------------------------------------ chat demo
// The person types a reply as usual; the AI only shows taps when it isn't sure.
const DEMO_REPLIES = {
  sarcastic: "Sorry, that's genuinely frustrating. I've upgraded you to express delivery at no cost.",
  passive_aggressive: "I hear you, and I'm sorry. Let me fix this properly.",
  sincere: 'Glad that works for you!',
  joking: "Ha! I'll pass that on. Anything else I can help with?",
};

function bubble(cls, text) {
  const d = document.createElement('div');
  d.className = `bubble ${cls}`;
  if (text) d.textContent = text;
  $('chat').appendChild(d);
  d.scrollIntoView({ block: 'nearest' });
  return d;
}

function tapRow(parent, items, onPick) {
  const row = document.createElement('div');
  row.className = 'tap-row';
  for (const [value, label] of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tap small';
    b.textContent = label;
    b.addEventListener('click', () => { row.querySelectorAll('button').forEach((x) => { x.disabled = true; }); b.classList.add('picked'); onPick(value); });
    row.appendChild(b);
  }
  parent.appendChild(row);
}

// Tap one or several meanings (and optionally feelings), then "Done".
function multiTap(parent, check, onDone) {
  const picked = new Set(), feelings = new Set();
  const row = (items, set, cls = '') => {
    const r = document.createElement('div');
    r.className = `tap-row ${cls}`;
    for (const [id, label] of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tap small';
      b.textContent = label;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => {
        const on = !set.has(id);
        on ? set.add(id) : set.delete(id);
        b.setAttribute('aria-pressed', String(on));
        b.classList.toggle('picked', on);
        done.disabled = !canSend();
      });
      r.appendChild(b);
    }
    parent.appendChild(r);
    return r;
  };
  const ownInput = (placeholder) => {
    const i = document.createElement('input');
    i.className = 'own-words';
    i.maxLength = 300;
    i.placeholder = `✏️ ${placeholder}`;
    i.addEventListener('input', () => { done.disabled = !canSend(); });
    parent.appendChild(i);
    return i;
  };
  const canSend = () => picked.size || feelings.size || ownMeaning.value.trim() || ownFeeling.value.trim();
  const rows = [row(check.options.map((o) => [o.id, o.label]), picked)];
  const ownMeaning = ownInput(check.ownMeaningPrompt || 'Or say it your way');
  const fp = document.createElement('div');
  fp.className = 'small muted feel-prompt';
  fp.textContent = check.feelingPrompt;
  parent.appendChild(fp);
  rows.push(row(check.feelingOptions.map((f) => [f.id, f.label]), feelings, 'feel'));
  const ownFeeling = ownInput(check.ownFeelingPrompt || 'Or your own feeling');
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'primary small done';
  done.textContent = 'Done';
  done.disabled = true;
  done.addEventListener('click', () => {
    done.disabled = true;
    rows.forEach((r) => r.querySelectorAll('button').forEach((b) => { b.disabled = true; }));
    ownMeaning.disabled = ownFeeling.disabled = true;
    onDone({ optionIds: [...picked], feelings: [...feelings], ownMeaning: ownMeaning.value.trim(), ownFeeling: ownFeeling.value.trim() });
  });
  parent.appendChild(done);
}

async function ensureDemoAgent() {
  if (agentKey) return agentKey;
  const out = await api('/api/agents/register', { method: 'POST', body: { name: 'demo-chat', platform: 'custom' } });
  agentKey = out.apiKey;
  store.set('nuance.agentKey', agentKey);
  return agentKey;
}

async function replyAndAskReaction(check, meaning) {
  const said = check.whatWorked?.[0]?.response || DEMO_REPLIES[meaning?.intent] || 'Got it, thanks for telling me.';
  bubble('ai', said);
  const ask = bubble('ai soft', 'How did that land?');
  tapRow(ask, Object.entries(check.reactions), async (reaction) => {
    await api(`/api/v1/checks/${check.id}/reaction`, { method: 'POST', token: agentKey, body: { reaction, aiResponse: said } });
    $('chat-note').textContent = 'Recorded. Send a similar message again to see what the AI learned.';
  });
}

$('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text) return;
  bubble('human', text);
  try {
    await ensureDemoAgent();
    const context = [...$('chat').querySelectorAll('.bubble:not(.soft)')].slice(-6, -1)
      .map((b) => ({ speaker: b.classList.contains('human') ? 'human' : 'ai', text: b.firstChild?.textContent || '' }))
      .filter((t) => t.text);
    const check = await api('/api/v1/checks', { method: 'POST', token: agentKey, body: { utterance: text, context, consent: true } });
    if (!check.shouldAsk) {
      $('chat-note').textContent = [typingNote(check.typing), `Didn't need to ask: ${check.reason}`].filter(Boolean).join(' — ');
      return replyAndAskReaction(check, check.suggested);
    }
    $('chat-note').textContent = [typingNote(check.typing), check.reason].filter(Boolean).join(' — ');
    const ask = bubble('ai soft', check.prompt);
    multiTap(ask, check, async (picks) => {
      const out = await api(`/api/v1/checks/${check.id}/answer`, { method: 'POST', token: agentKey, body: picks });
      const u = out.understoodOwnWords;
      if (u) {
        const read = [...u.intents.map(intentText), ...u.emotions.map(emotionText)];
        $('chat-note').textContent = read.length ? `Understood your words as: ${read.join(', ')}` : 'Kept your words as they are; people will help work out what they mean.';
      }
      replyAndAskReaction(check, out.choice);
    });
  } catch (ex) { $('chat-note').textContent = ex.message; }
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
  const ar = $('ask-rate');
  const c = s.checks;
  ar.innerHTML = '';
  const line = (label, v) => { const p = document.createElement('p'); p.innerHTML = '<span></span> <b></b>'; p.children[0].textContent = label; p.children[1].textContent = v; ar.appendChild(p); };
  if (!c.total) line('No quick checks yet.', '');
  else {
    line('Quick checks so far:', `${c.total} (${c.answered} tapped)`);
    line('How often the AI had to ask, at the start:', `${Math.round(c.earlyAskRate * 100)}%`);
    line('…and lately:', `${Math.round(c.recentAskRate * 100)}%`);
    line('Reactions:', `${c.reactions.helpful} helped · ${c.reactions.missed} missed · ${c.reactions.tone} wrong tone`);
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

function renderShareChips() {
  const name = (p) => (PLATFORM_NAMES[p] || p).replace(/^(a|an) /, '').replace(/^./, (c) => c.toUpperCase());
  chips($('s-platform-chips'), taxonomy.platforms, 'platform', shareChoice);
  $('s-platform-chips').querySelectorAll('.chip').forEach((c, i) => { c.textContent = name(taxonomy.platforms[i]); });
  chips($('s-intent-chips'), taxonomy.intents, 'intents', shareChoice, { multi: true, label: intentText });
  chips($('s-emotion-chips'), taxonomy.emotions, 'emotions', shareChoice, { multi: true, label: emotionText });
}

$('s-utterance').addEventListener('input', (e) => { $('s-typing').textContent = typingNote(analyzeTyping(e.target.value)); });

// ------------------------------------------------------------------ boot
api('/api/taxonomy').then((t) => {
  taxonomy = t;
  for (const sel of [$('agent-platform')]) {
    for (const p of t.platforms) {
      const o = document.createElement('option');
      o.value = p;
      o.textContent = (PLATFORM_NAMES[p] || p).replace(/^(a|an) /, '').replace(/^./, (c) => c.toUpperCase());
      sel.appendChild(o);
    }
  }
  renderShareChips();
  loadTask();
});
