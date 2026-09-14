// Extracted from index.html so the Content-Security-Policy can stay strict.
//
// The CSP is `default-src 'self'` with no script-src, which blocks inline
// <script> outright — the page's JS silently never ran. The alternative was
// adding 'unsafe-inline', but this app's stated threat model is text written by
// other people, including strangers in group chats, so weakening script-src is
// exactly the wrong trade. An external file costs nothing instead.
// There is no server, no port and no session token any more. Everything goes
// over the contextBridge in preload/index.ts, which exposes exactly nine named
// calls and two event subscriptions — see PLAN.md §3.
const wa = window.wa;

const $ = (id) => document.getElementById(id);

let localOnly = true;

function enable(id, on) { $(id).classList.toggle('disabled-panel', !on); }

function paintStats(s) {
  if (!s) return;
  $('ledger').style.display = 'grid';
  $('sChats').textContent = s.chats.toLocaleString();
  $('sMsgs').textContent = s.messages.toLocaleString();
  $('sPending').textContent = s.pending.toLocaleString();
  $('sMedia').textContent = s.mediaUnique.toLocaleString();
  // The number that decides whether media enrichment is cheap or ruinous.
  $('sDedup').textContent = s.mediaUnique
    ? (s.mediaReferences / s.mediaUnique).toFixed(1) + '×'
    : '—';
  $('wsRange').textContent = s.newest
    ? `Covering ${new Date(s.oldest).toLocaleDateString()} → ${new Date(s.newest).toLocaleDateString()}.`
    : 'Nothing captured yet. Connect WhatsApp and leave it running.';
}

function paintConn(c) {
  const map = {
    open:       ['on',   'connected'],
    qr:         ['wait', 'waiting for scan'],
    connecting: ['wait', 'connecting'],
    closed:     ['wait', 'reconnecting'],
    logged_out: ['',     'unlinked — scan again'],
    idle:       ['',     'not connected'],
  };
  const [cls, text] = map[c.state] || ['', c.state];
  $('dot').className = 'dot ' + cls;
  $('connText').textContent = text + (c.capturedThisSession ? ` · ${c.capturedThisSession} captured` : '');
  $('qr').style.display = c.qrDataUrl ? 'block' : 'none';
  if (c.qrDataUrl) $('qrImg').src = c.qrDataUrl;
}

$('openWs').onclick = async () => {
  $('openWs').disabled = true;
  try {
    const r = await wa.openWorkspace($('wsPath').value.trim());
    $('wsWarnings').innerHTML = r.warnings.length
      ? r.warnings.map((w) => `<div class="alert">${w.message}</div>`).join('')
      : `<div class="alert ok">Workspace ready at <code>${r.workspace}</code>.</div>`;
    paintStats(r.stats);
    ['connPanel', 'refreshPanel'].forEach((p) => enable(p, true));
    enable('askPanel', !localOnly);
    refreshOnce();
  } catch (e) {
    $('wsWarnings').innerHTML = `<div class="alert">Couldn't open that directory: ${e.message}</div>`;
  }
  $('openWs').disabled = false;
};

$('connect').onclick = () => wa.connect().then(paintConn).catch((e) => { $('wsWarnings').innerHTML = `<div class="alert">${e.message}</div>`; });
$('disconnect').onclick = () => wa.disconnect().then(paintConn);

$('refresh').onclick = async () => {
  $('refresh').disabled = true;
  $('refreshOut').textContent = 'Working through the backlog…';
  try {
    const r = await wa.refresh();
    paintStats(r.stats);
    $('refreshOut').textContent =
      `${r.processed} glossed, ${r.skipped} needed no model call.` +
      (localOnly ? ' Character folding only — no key set, so nothing was sent anywhere.' : '');
  } catch (e) { $('refreshOut').textContent = e.message; }
  $('refresh').disabled = false;
};

function addTurn(who, text, tools) {
  const el = document.createElement('div');
  el.className = 'turn ' + (who === 'You' ? 'you' : 'bot');
  el.innerHTML = `<div class="who">${who}</div>`;
  el.appendChild(document.createTextNode(text));
  if (tools?.length) {
    const t = document.createElement('div');
    t.className = 'tools';
    t.textContent = tools.map((c) => c.name).join(' → ');
    el.appendChild(t);
  }
  $('thread').appendChild(el);
  el.scrollIntoView({ block: 'nearest' });
}

async function send() {
  const q = $('q').value.trim();
  if (!q) return;
  $('q').value = '';
  addTurn('You', q);
  $('send').disabled = true;
  try {
    const r = await wa.ask(q);
    addTurn('Archive', r.answer, r.toolCalls);
  } catch (e) { addTurn('Archive', e.message); }
  $('send').disabled = false;
  $('q').focus();
}
$('send').onclick = send;
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

// Main pushes both of these; there is nothing to poll for. Connection changes
// come straight off the Baileys socket, so the QR appears the moment it exists
// rather than up to 2.5s later.
wa.onStatus(paintConn);
wa.onStats(paintStats);

async function refreshOnce() {
  const s = await wa.getStatus();
  if (s.connection) paintConn(s.connection);
  if (s.stats) paintStats(s.stats);
}

(async () => {
  const s = await wa.getSession();
  localOnly = s.localOnly;
  $('wsPath').value = s.workspace || s.defaultWorkspace;
  $('mode').textContent = localOnly
    ? 'local only · nothing leaves this machine'
    : `model-assisted · ${s.model}`;
  paintSettings(await wa.getSettings());
  $('askNote').textContent = localOnly
    ? 'Asking questions needs a model. Set ANTHROPIC_API_KEY in .env and restart. Capture and keyword search keep working without one.'
    : 'Message text is sent to the model to answer. Voice notes and images are described automatically and are often wrong — the answer will point you at the original rather than quote it.';
})();

// --- settings ---------------------------------------------------------------

// The key is write-only from here: settings:get reports whether one is set, and
// never what it is. The field shows a placeholder, not the secret.
function paintSettings(s) {
  $('model').value = s.model || '';
  $('openAtLogin').checked = s.openAtLogin;
  $('apiKey').placeholder = s.hasKey ? '•••••••• (set)' : 'sk-ant-…';
  $('apiKey').value = '';
  localOnly = s.localOnly;
  $('mode').textContent = s.localOnly
    ? 'local only · nothing leaves this machine'
    : `model-assisted · ${s.model}`;
  enable('askPanel', !s.localOnly && Boolean(s.workspace));

  const notes = [];
  if (s.message) notes.push(s.message);
  if (s.keyFromEnv) {
    notes.push('ANTHROPIC_API_KEY is set in the environment and takes precedence over this field.');
  }
  if (s.hasKey && !s.encryptionAvailable) {
    notes.push('No OS keystore here, so the key lives in memory for this session only.');
  }
  if (!s.openAtLogin) {
    notes.push('Not starting at login. Messages that arrive while this app is closed are lost — there is no backfill.');
  }
  $('settingsNote').textContent = notes.join(' ');
}

async function saveSettings(patch) {
  $('saveSettings').disabled = true;
  try {
    paintSettings(await wa.saveSettings(patch));
  } catch (e) {
    $('settingsNote').textContent = e.message;
  }
  $('saveSettings').disabled = false;
}

$('saveSettings').onclick = () => {
  const key = $('apiKey').value;
  saveSettings({
    model: $('model').value.trim(),
    // Undefined leaves the stored key alone; only send it when something was typed.
    ...(key ? { apiKey: key } : {}),
  });
};

$('clearKey').onclick = () => saveSettings({ apiKey: null });
$('openAtLogin').onchange = (e) => saveSettings({ openAtLogin: e.target.checked });

$('browseWs').onclick = async () => {
  const { path } = await wa.pickWorkspace();
  if (path) $('wsPath').value = path;
};
