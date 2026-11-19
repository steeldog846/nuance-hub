const $ = (id) => document.getElementById(id);
const pretty = (s) => (s || '').replace(/_/g, ' ');

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
let labelerToken = store.get('nuance.labeler');

// ------------------------------------------------------------------ tabs
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${tab.dataset.view}`; });
    if (tab.dataset.view === 'community') loadStats();
  });
});

// ------------------------------------------------------------------ labeler
function chips(container, values, field) {
  container.innerHTML = '';
  for (const v of values) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = pretty(v);
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      choice[field] = v;
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
  $('t-meta').textContent = `${t.labelCount} ${t.labelCount === 1 ? 'person has' : 'people have'} answered · ${t.locale} · ${pretty(t.modality)}`;
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
  $('t-guess').textContent = t.agentGuess ? `The AI's own guess: ${t.agentGuess}` : '';
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

$('signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { token } = await api('/api/labelers', { method: 'POST', body: { displayName: $('displayName').value } });
  labelerToken = token;
  store.set('nuance.labeler', token);
  loadTask();
});

$('signout').addEventListener('click', () => { labelerToken = null; store.set('nuance.labeler', null); show('signin'); });
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
    const out = await api('/api/agents/register', { method: 'POST', body: { name: $('agent-name').value || 'demo-agent' } });
    agentKey = out.apiKey;
    store.set('nuance.agentKey', agentKey);
    $('agent-key-out').textContent = `Registered “${out.name}”. API key: ${out.apiKey}`;
  } catch (ex) { $('agent-key-out').textContent = ex.message; }
});

$('send-demo').addEventListener('click', async () => {
  const out = $('demo-out');
  out.hidden = false;
  if (!agentKey) { out.textContent = 'Register an agent first.'; return; }
  const context = $('demo-context').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^(ai|human)\s*:\s*(.*)$/i);
    return m ? { speaker: m[1].toLowerCase(), text: m[2] } : { speaker: 'human', text: l };
  });
  try {
    const res = await api('/api/v1/queries', {
      method: 'POST',
      token: agentKey,
      body: { utterance: $('demo-utterance').value, question: $('demo-question').value, context, consent: $('demo-consent').checked },
    });
    out.textContent = JSON.stringify(res, null, 2);
  } catch (ex) { out.textContent = ex.message; }
});

// ------------------------------------------------------------------ community
async function loadStats() {
  const s = await api('/api/stats');
  const items = [['Questions asked', s.questions], ['Waiting for people', s.open], ['Settled', s.resolved], ['Disputed', s.disputed], ['Human guides', s.labelers], ['AI agents', s.agents]];
  $('stats').innerHTML = '';
  for (const [label, n] of items) {
    const d = document.createElement('div');
    d.className = 'stat';
    d.innerHTML = '<b></b><span></span>';
    d.children[0].textContent = n;
    d.children[1].textContent = label;
    $('stats').appendChild(d);
  }
  const lb = $('leaderboard');
  lb.innerHTML = '';
  if (!s.leaderboard.length) lb.innerHTML = '<li class="muted">No one yet. Be the first.</li>';
  for (const l of s.leaderboard) {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><span class="muted small"></span>';
    li.children[0].textContent = l.displayName;
    li.children[1].textContent = `trust ${l.reputation.toFixed(2)} · ${l.labeled} answered`;
    lb.appendChild(li);
  }
}

// ------------------------------------------------------------------ boot
api('/api/taxonomy').then((t) => { taxonomy = t; loadTask(); });
