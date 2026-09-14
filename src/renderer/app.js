import { mountLink } from './link.js';

// There is no server, no port and no session token. Everything goes over the
// contextBridge in preload/index.ts — a fixed set of named calls.
const wa = window.wa;
const $ = (id) => document.getElementById(id);
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const fmt = (n) => (n ?? 0).toLocaleString();

const state = {
  session: null,
  settings: null,
  status: null,
  stats: null,
  chats: [],
  activeChat: null,
  conversations: [],
  activeConv: null,
};

let links = { onboarding: null, settings: null };

// ---------------------------------------------------------------- routing

function go(view) {
  for (const s of document.querySelectorAll('.view')) s.hidden = s.dataset.view !== view;
  for (const b of document.querySelectorAll('.nav-item')) {
    b.classList.toggle('active', b.dataset.view === view);
  }
  if (view === 'chats' && state.chats.length === 0) void loadChats();
  if (view === 'ask') { void loadConversations(); $('q').focus(); }
}

document.querySelector('.nav').addEventListener('click', (e) => {
  const view = e.target.closest('[data-view]')?.dataset.view;
  if (view) go(view);
});

$('statusPill').onclick = () => { go('settings'); openPane('connection'); };

function openPane(name) {
  for (const p of document.querySelectorAll('.pane')) p.hidden = p.dataset.pane !== name;
  for (const b of $('settingsNav').children) b.classList.toggle('active', b.dataset.pane === name);
}
$('settingsNav').addEventListener('click', (e) => {
  const pane = e.target.closest('[data-pane]')?.dataset.pane;
  if (pane) openPane(pane);
});

// ---------------------------------------------------------------- painting

function paintStatus(c) {
  if (!c) return;
  state.status = c;
  const map = {
    open: ['on', 'connected'],
    qr: ['wait', 'waiting for scan'],
    connecting: ['wait', 'connecting'],
    closed: ['wait', 'reconnecting'],
    logged_out: ['bad', 'unlinked — not capturing'],
    idle: ['', 'not connected'],
  };
  const [cls, text] = map[c.state] || ['', c.state];
  $('dot').className = 'dot ' + cls;
  $('connText').textContent = text;
  links.settings?.render(c);
  links.onboarding?.render(c);
}

function paintStats(s) {
  if (!s) return;
  state.stats = s;
  $('sMsgs').textContent = fmt(s.messages);
  $('sPending').textContent = fmt(s.pending);
  $('iPending').textContent = fmt(s.pending);
  $('iMsgs').textContent = fmt(s.messages);
  $('ledger').hidden = false;
  $('lChats').textContent = fmt(s.chats);
  $('lMsgs').textContent = fmt(s.messages);
  $('lMedia').textContent = fmt(s.mediaUnique);
  // The number that decides whether media enrichment is cheap or ruinous.
  $('lDedup').textContent = s.mediaUnique ? (s.mediaReferences / s.mediaUnique).toFixed(1) + '×' : '—';
  $('wsRange').textContent = s.newest
    ? `Covering ${new Date(s.oldest).toLocaleDateString()} → ${new Date(s.newest).toLocaleDateString()}.`
    : 'Nothing captured yet. Link your phone and leave this running.';
}

function paintSettings(s) {
  state.settings = s;
  $('model').value = s.model || '';
  $('baseUrl').value = s.baseUrl || '';
  $('openAtLogin').checked = s.openAtLogin;
  $('apiKey').placeholder = s.hasKey ? '•••••••• (set)' : 'sk-…';
  $('apiKey').value = '';

  const sel = $('providerId');
  if (sel.options.length !== (s.presets || []).length) {
    sel.innerHTML = (s.presets || []).map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
  }
  sel.value = s.providerId;
  $('providerKind').value = s.providerKind;
  const preset = (s.presets || []).find((p) => p.id === s.providerId);
  const custom = s.providerId === 'custom';
  // Only "custom" may edit these; a preset whose URL you can change has quietly
  // stopped being that preset.
  $('providerKind').disabled = !custom;
  $('baseUrl').disabled = !custom;
  if (preset?.suggestedModel && !$('model').value) $('model').value = preset.suggestedModel;
  $('providerNote').textContent = [
    preset?.note,
    preset && !preset.needsKey ? 'Usually needs no API key.' : '',
    preset?.suggestedModel ? `Example model: ${preset.suggestedModel}` : '',
  ].filter(Boolean).join(' ');

  // Three materially different privacy positions — name the one in effect.
  let host = '';
  try { host = s.baseUrl ? ` · ${new URL(s.baseUrl).host}` : ''; } catch { host = ''; }
  $('mode').textContent = s.localOnly
    ? 'local only · nothing leaves this machine'
    : s.localEndpoint
      ? `local model${host} · stays on this machine`
      : `${s.model}${host}`;

  $('askNote').textContent = s.localOnly
    ? 'Ask needs an AI provider. Settings → AI provider. Capture and keyword search work without one.'
    : 'Voice notes and images are described automatically and are often wrong — answers point you at the original rather than quote it.';
  $('send').disabled = s.localOnly;

  const notes = [];
  if (s.message) notes.push(s.message);
  if (s.keyFromEnv) notes.push('ANTHROPIC_API_KEY in the environment overrides this field.');
  if (s.hasKey && !s.encryptionAvailable) notes.push('No OS keystore here — the key is kept for this session only.');
  $('settingsNote').textContent = notes.join(' ');
}

// ---------------------------------------------------------------- ask

async function loadConversations() {
  const { conversations } = await wa.listConversations();
  state.conversations = conversations;
  renderConvList();
}

function renderConvList() {
  $('convList').innerHTML = state.conversations.length
    ? state.conversations.map((c) => `
        <div class="conv-row${c.id === state.activeConv ? ' active' : ''}" data-conv="${c.id}">
          <b>${escapeHtml(c.title)}</b>
          <span>${new Date(c.updated_at).toLocaleDateString()} · ${fmt(c.turns)} turns</span>
        </div>`).join('')
    : '<div class="empty" style="padding:20px"><p class="tiny">No conversations yet.</p></div>';
}

$('convList').addEventListener('click', (e) => {
  const id = e.target.closest('[data-conv]')?.dataset.conv;
  if (id) void openConversation(id);
});

async function openConversation(id) {
  state.activeConv = id;
  const conv = state.conversations.find((c) => c.id === id);
  $('convTitle').textContent = conv?.title || 'Chat';
  $('deleteConv').hidden = false;
  renderConvList();

  const { turns } = await wa.getConversation(id);
  $('thread').replaceChildren();
  if (!turns.length) {
    $('thread').appendChild($('askEmpty'));
    $('askEmpty').hidden = false;
  } else {
    for (const t of turns) addTurn(t.role === 'user' ? 'You' : 'Archive', t.content, t.toolCalls);
  }
}

$('newChat').onclick = async () => {
  // Created lazily on first send instead? No — an explicit empty chat is what
  // people expect from the button, and an unused one costs a single row.
  const conv = await wa.newConversation();
  await loadConversations();
  await openConversation(conv.id);
  $('q').focus();
};

$('deleteConv').onclick = async () => {
  if (!state.activeConv) return;
  await wa.deleteConversation(state.activeConv);
  state.activeConv = null;
  $('convTitle').textContent = 'New chat';
  $('deleteConv').hidden = true;
  $('thread').replaceChildren($('askEmpty'));
  $('askEmpty').hidden = false;
  await loadConversations();
};

function addTurn(who, text, tools) {
  $('askEmpty').hidden = true;
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
  return el;
}

async function send() {
  const q = $('q').value.trim();
  if (!q) return;

  // Asking without having picked a conversation starts one, so the first
  // question is never lost.
  if (!state.activeConv) {
    const conv = await wa.newConversation();
    state.activeConv = conv.id;
    $('deleteConv').hidden = false;
  }

  $('q').value = '';
  $('q').style.height = 'auto';
  addTurn('You', q);
  $('send').disabled = true;
  const pending = document.createElement('div');
  pending.className = 'thinking';
  pending.innerHTML = '<div class="spinner" style="margin:0;width:16px;height:16px"></div> searching the archive…';
  $('thread').appendChild(pending);
  pending.scrollIntoView({ block: 'nearest' });
  try {
    const r = await wa.ask(q, state.activeConv);
    pending.remove();
    addTurn('Archive', r.answer, r.toolCalls);
  } catch (e) {
    pending.remove();
    addTurn('Archive', e.message);
  }
  $('send').disabled = false;
  $('q').focus();
  await loadConversations();
  const conv = state.conversations.find((c) => c.id === state.activeConv);
  if (conv) $('convTitle').textContent = conv.title;
}
$('send').onclick = send;
$('q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
});
$('q').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
});

const SUGGESTIONS = [
  'What did I agree to this week?',
  'أي حد بعتلي عنوان؟',
  'Any links shared recently?',
];
$('suggestions').innerHTML = SUGGESTIONS.map((s) => `<button>${escapeHtml(s)}</button>`).join('');
$('suggestions').addEventListener('click', (e) => {
  if (e.target.tagName === 'BUTTON') { $('q').value = e.target.textContent; void send(); }
});

// ---------------------------------------------------------------- chats

async function loadChats() {
  const { chats } = await wa.listChats();
  state.chats = chats;
  renderChatList();
}

function renderChatList() {
  const filter = $('chatFilter').value.trim().toLowerCase();
  const rows = state.chats.filter((c) => !filter || (c.name || c.jid).toLowerCase().includes(filter));
  $('chatList').innerHTML = rows.length
    ? rows.map((c) => `
        <div class="chat-row${c.jid === state.activeChat ? ' active' : ''}" data-jid="${c.jid}">
          <b>${escapeHtml(c.name || c.jid.split('@')[0])}</b>
          <span>${fmt(c.messageCount)} messages${c.isGroup ? ' · group' : ''}</span>
        </div>`).join('')
    : '<div class="empty" style="padding:22px"><p>No conversations yet.</p></div>';
}
$('chatFilter').addEventListener('input', renderChatList);

$('chatList').addEventListener('click', (e) => {
  const jid = e.target.closest('[data-jid]')?.dataset.jid;
  if (jid) void openChat(jid);
});

async function openChat(jid) {
  state.activeChat = jid;
  renderChatList();
  const chat = state.chats.find((c) => c.jid === jid);
  $('chatTitle').textContent = chat?.name || jid.split('@')[0];
  const { hits } = await wa.search({ query: '', chatJid: jid, limit: 100 });
  renderMessages(hits.slice().reverse());
}

async function runSearch() {
  const query = $('msgSearch').value.trim();
  if (!query) { if (state.activeChat) void openChat(state.activeChat); return; }
  $('chatTitle').textContent = `Results for “${query}”`;
  const { hits } = await wa.search({ query, limit: 100 });
  renderMessages(hits, true);
}
let searchTimer;
$('msgSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250);
});

function renderMessages(msgs, showChat = false) {
  if (!msgs.length) {
    $('messages').innerHTML = '<div class="empty"><p>Nothing here.</p></div>';
    return;
  }
  $('messages').innerHTML = msgs.map((m) => `
    <div class="msg${m.fromMe ? ' mine' : ''}">
      <div class="meta">${escapeHtml(m.senderName || '')}${showChat && m.chatName ? ' · ' + escapeHtml(m.chatName) : ''} · ${new Date(m.ts).toLocaleString()}</div>
      ${escapeHtml(m.body || '')}${m.kind && m.kind !== 'text' ? `<div class="meta">[${m.kind}]</div>` : ''}
    </div>`).join('');
  $('messages').scrollTop = $('messages').scrollHeight;
}


// ---------------------------------------------------------------- settings actions

async function saveSettings(patch) {
  $('saveSettings').disabled = true;
  try { paintSettings(await wa.saveSettings(patch)); }
  catch (e) { $('settingsNote').textContent = e.message; }
  $('saveSettings').disabled = false;
}
$('saveSettings').onclick = () => {
  const key = $('apiKey').value;
  saveSettings({ model: $('model').value.trim(), baseUrl: $('baseUrl').value.trim(), ...(key ? { apiKey: key } : {}) });
};
$('clearKey').onclick = () => saveSettings({ apiKey: null });
$('openAtLogin').onchange = (e) => saveSettings({ openAtLogin: e.target.checked });
$('providerId').onchange = (e) => saveSettings({ providerId: e.target.value });
$('providerKind').onchange = (e) => saveSettings({ providerKind: e.target.value });

$('browseWs').onclick = async () => {
  const { path } = await wa.pickWorkspace();
  if (path) $('wsPath').value = path;
};
$('openWs').onclick = () => void openWorkspace($('wsPath').value.trim(), $('wsWarnings'));

$('refresh').onclick = async () => {
  $('refresh').disabled = true;
  $('refreshOut').textContent = 'Working through the backlog…';
  try {
    const r = await wa.refresh();
    paintStats(r.stats);
    $('refreshOut').textContent = `${r.processed} glossed, ${r.skipped} needed no model call.`;
  } catch (e) { $('refreshOut').textContent = e.message; }
  $('refresh').disabled = false;
};

$('openLogs').onclick = () => wa.openLogs();
$('copyDiag').onclick = async () => {
  const { lines, path } = await wa.tailLogs();
  $('logBox').hidden = false;
  $('logBox').textContent = lines;
  try { await navigator.clipboard.writeText(`${path}\n\n${lines}`); } catch { /* shown instead */ }
};

async function openWorkspace(path, warnEl) {
  const r = await wa.openWorkspace(path);
  warnEl.innerHTML = r.warnings.length
    ? r.warnings.map((w) => `<div class="alert">${escapeHtml(w.message)}</div>`).join('')
    : `<div class="alert ok">Archive ready at <code>${escapeHtml(r.workspace)}</code>.</div>`;
  paintStats(r.stats);
  $('wsPath').value = r.workspace;
  await loadChats();
  return r;
}

// ---------------------------------------------------------------- onboarding

function obStep(n) {
  for (const s of document.querySelectorAll('.ob-step')) s.hidden = Number(s.dataset.step) !== n;
  for (const i of document.querySelectorAll('.ob-progress i')) {
    i.classList.toggle('done', Number(i.dataset.step) <= n);
  }
  if (n === 3 && !links.onboarding) {
    links.onboarding = mountLink($('obLinkHost'), wa, { onLinked: finishOnboarding });
    links.onboarding.render(state.status);
  }
}
document.getElementById('onboarding').addEventListener('click', (e) => {
  const to = e.target.closest('[data-goto]')?.dataset.goto;
  if (to) obStep(Number(to));
});
$('obBrowse').onclick = async () => {
  const { path } = await wa.pickWorkspace();
  if (path) $('obPath').value = path;
};
$('obUseFolder').onclick = async () => {
  try {
    await openWorkspace($('obPath').value.trim(), $('obWarnings'));
    obStep(3);
  } catch (e) {
    $('obWarnings').innerHTML = `<div class="alert">${escapeHtml(e.message)}</div>`;
  }
};
$('obSkip').onclick = finishOnboarding;

let onboardingDone = false;
function finishOnboarding() {
  if (onboardingDone) return;
  onboardingDone = true;
  $('onboarding').hidden = true;
  $('shell').hidden = false;
  go('ask');
}

// ---------------------------------------------------------------- boot

wa.onStatus(paintStatus);
wa.onStats(paintStats);

(async () => {
  const s = await wa.getSession();
  state.session = s;
  paintSettings(await wa.getSettings());

  const status = await wa.getStatus();
  paintStatus(status.connection);
  if (status.stats) paintStats(status.stats);

  // Onboarding is for people with no archive yet. Anyone who has linked before
  // goes straight to the app — re-running a setup wizard on every launch is how
  // a helpful flow turns into an obstacle.
  const fresh = !status.workspace || (status.stats && status.stats.messages === 0 && status.connection.state === 'idle');
  $('obPath').value = s.workspace || s.defaultWorkspace;
  $('wsPath').value = s.workspace || s.defaultWorkspace;

  if (fresh) {
    $('onboarding').hidden = false;
    obStep(1);
  } else {
    finishOnboarding();
    if (status.workspace) { await loadChats(); await loadConversations(); }
  }

  links.settings = mountLink($('linkHost'), wa, {});
  links.settings.render(status.connection);
})();
