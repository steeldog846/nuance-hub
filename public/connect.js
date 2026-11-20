// Fills the connection guide with this site's address and, once registered, the new key.
const $ = (id) => document.getElementById(id);
const BASE = location.origin;
let key = 'YOUR_API_KEY';

function fill() {
  for (const el of document.querySelectorAll('[data-tpl]')) {
    el.textContent = el.dataset.tpl.replaceAll('{BASE}', BASE).replaceAll('{KEY}', key);
  }
}
fill();

$('register').addEventListener('click', async () => {
  $('key-error').hidden = true;
  const name = $('agent-name').value.trim();
  if (!name) {
    $('key-error').textContent = 'Give your AI a name first.';
    $('key-error').hidden = false;
    return;
  }
  $('register').disabled = true;
  try {
    const res = await fetch('/api/agents/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, platform: $('agent-platform').value, website: $('agent-website').value }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `Something went wrong (${res.status})`);
    key = out.apiKey;
    $('key-value').textContent = key;
    $('key-out').hidden = false;
    fill();
  } catch (err) {
    $('key-error').textContent = err.message;
    $('key-error').hidden = false;
  } finally {
    $('register').disabled = false;
  }
});

$('copy-instructions').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('instructions-text').textContent);
    $('copy-instructions').textContent = 'Copied';
  } catch {
    $('copy-instructions').textContent = 'Select the text above and copy it';
  }
});
