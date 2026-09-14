import { mountLink } from './link.js';
import { SOURCE_LABELS, MEDIA_LABELS, toggleCapture } from '../shared/capture.js';

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
  totalChats: 0,
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

// Sidebar collapse. Remembered per machine — a layout preference is exactly the
// kind of small per-viewer convenience localStorage is for.
function setCollapsed(on) {
  $('shell').classList.toggle('collapsed', on);
  $('sbToggle').title = on ? 'Expand sidebar' : 'Collapse sidebar';
  try { localStorage.setItem('sidebarCollapsed', on ? '1' : '0'); } catch { /* private window */ }
}
$('sbToggle').onclick = () => setCollapsed(!$('shell').classList.contains('collapsed'));
try { setCollapsed(localStorage.getItem('sidebarCollapsed') === '1'); } catch { /* ignore */ }

function openPane(name) {
  for (const p of document.querySelectorAll('.pane')) p.hidden = p.dataset.pane !== name;
  for (const b of $('settingsNav').children) b.classList.toggle('active', b.dataset.pane === name);
}
$('settingsNav').addEventListener('click', (e) => {
  const pane = e.target.closest('[data-pane]')?.dataset.pane;
  if (pane) openPane(pane);
  if (pane === 'workspace') void paintUsage();
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
  paintSyncBar(c);
  links.settings?.render(c);
  links.onboarding?.render(c);
}

let lastCaptureAt = 0;
let lastCaptureCount = 0;

/**
 * Capture is otherwise invisible: messages land in bursts and nothing says
 * whether it is working, finished, or wedged. Treat "the count moved in the
 * last 8 seconds" as actively importing.
 */
function paintSyncBar(c) {
  const n = c.capturedThisSession || 0;
  if (n > lastCaptureCount) {
    lastCaptureCount = n;
    lastCaptureAt = Date.now();
  }
  const active = c.state === 'open' && n > 0 && Date.now() - lastCaptureAt < 8000;
  $('syncBar').hidden = !(active || (c.state === 'open' && n > 0 && Date.now() - lastCaptureAt < 30000));
  const pct = typeof c.historyProgress === 'number' ? ` · history ${Math.round(c.historyProgress)}%` : '';
  $('syncText').textContent = active
    ? `Importing…${pct} · ${fmt(n)} messages captured this session`
    : `${fmt(n)} messages captured this session · ${c.historyComplete ? 'history complete' : 'up to date'}`;
  $('syncBar').querySelector('.syncdot').style.animationPlayState = active ? 'running' : 'paused';
}

$('syncStop').onclick = async () => {
  await wa.disconnect();
  $('syncBar').hidden = true;
};

function paintStats(s) {
  if (!s) return;
  state.stats = s;
  $('sMsgs').textContent = fmt(s.messages);
  $('sPending').textContent = fmt(s.pending);
  $('iPending').textContent = fmt(s.pending);
  if (s.failed !== undefined) $('iFailed').textContent = fmt(s.failed);
  if (s.contacts !== undefined) $('iContacts').textContent = fmt(s.contacts);
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
  // Deliberately NOT disabled when local-only: a dead button teaches nothing.
  // send() explains what is missing instead.
  $('send').disabled = false;

  const notes = [];
  if (s.message) notes.push(s.message);
  if (s.keyFromEnv) notes.push('ANTHROPIC_API_KEY in the environment overrides this field.');
  if (s.hasKey && !s.encryptionAvailable) notes.push('No OS keystore here — the key is kept for this session only.');
  $('settingsNote').textContent = notes.join(' ');
  paintCapture(s);
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
  clearThread();
  if (!turns.length) {
    $('askEmpty').hidden = false;
  } else {
    for (const t of turns) {
      addTurn(t.role === 'user' ? 'You' : 'Archive', t.content, t.toolCalls, t.citations);
    }
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
  clearThread();
  $('askEmpty').hidden = false;
  await loadConversations();
};

/**
 * Remove the turns but keep the empty-state element attached.
 *
 * replaceChildren() used to detach #askEmpty permanently, so the next call that
 * tried to restore it passed null — and the DOM stringifies that, printing the
 * word "null" on screen.
 */
function clearThread() {
  for (const child of [...$('thread').children]) {
    if (child.id !== 'askEmpty') child.remove();
  }
}

function addTurn(who, text, tools, citations) {
  $('askEmpty').hidden = true;
  const el = document.createElement('div');
  el.className = 'turn ' + (who === 'You' ? 'you' : 'bot');
  el.innerHTML = `<div class="who">${who}</div>`;

  if (citations?.length) {
    // Turn each verified [n] into something clickable. Built by walking the
    // text rather than with innerHTML, so message content can never inject
    // markup — every string here was written by someone else.
    const byN = new Map(citations.map((c) => [String(c.n), c]));
    let last = 0;
    for (const m of text.matchAll(/\[(\d{1,3})\]/g)) {
      const c = byN.get(m[1]);
      if (!c) continue;
      el.appendChild(document.createTextNode(text.slice(last, m.index)));
      const sup = document.createElement('span');
      sup.className = 'cite';
      sup.textContent = `[${c.n}]`;
      sup.title = `${c.senderName || 'unknown'} · ${new Date(c.ts).toLocaleString()}`;
      sup.onclick = () => jumpToMessage(c);
      el.appendChild(sup);
      last = m.index + m[0].length;
    }
    el.appendChild(document.createTextNode(text.slice(last)));

    const box = document.createElement('div');
    box.className = 'sources';
    box.innerHTML = '<div class="sources-head">Sources</div>';
    for (const c of citations) {
      const b = document.createElement('button');
      b.className = 'src';
      b.innerHTML =
        `<b>[${c.n}]</b> <span class="who">${escapeHtml(c.senderName || 'unknown')}</span>` +
        ` · ${escapeHtml(c.chatName || c.chatJid.split('@')[0])}` +
        ` · ${new Date(c.ts).toLocaleString()}` +
        `<span class="snip">${escapeHtml(c.snippet)}</span>`;
      b.onclick = () => jumpToMessage(c);
      box.appendChild(b);
    }
    el.appendChild(box);
  } else {
    el.appendChild(document.createTextNode(text));
  }

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

  if (state.settings?.localOnly) {
    // Previously the button was just disabled, so pressing it did nothing and
    // explained nothing. Say what is missing and where to fix it.
    $('askEmpty').hidden = true;
    addTurn('Archive', 'No AI provider is configured yet, so I cannot answer questions. Open Settings → AI provider to set one up. Searching the archive works without one.');
    return;
  }

  // Asking without having picked a conversation starts one, so the first
  // question is never lost. Wrapped: if this throws, the old code rejected
  // out of send() before rendering anything at all — the input was not even
  // cleared, which looked exactly like the button being dead.
  if (!state.activeConv) {
    try {
      const conv = await wa.newConversation();
      state.activeConv = conv.id;
      $('deleteConv').hidden = false;
    } catch (e) {
      $('askEmpty').hidden = true;
      addTurn('Archive', `Could not start a conversation: ${e.message}`);
      return;
    }
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
    addTurn('Archive', r.answer, r.toolCalls, r.citations);
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
  const { chats, totalChats } = await wa.listChats($('showEmpty').checked);
  state.chats = chats;
  state.totalChats = totalChats;
  renderChatList();
}
$('showEmpty').onchange = loadChats;

/**
 * A JID is not a name. Until contacts arrive, show the best thing available:
 * a readable phone number, or an honest label for the LID form, which carries
 * no number at all.
 */
function chatLabel(c) {
  if (c.name) return c.name;
  const id = c.jid.split('@')[0];
  if (c.jid.endsWith('@lid')) return 'Unknown contact';
  if (c.jid.endsWith('@g.us')) return 'Group';
  if (c.jid.endsWith('@newsletter')) return 'Channel';
  const digits = id.replace(/[^0-9]/g, '');
  if (digits.length < 8) return id;
  // +20 122 469 8687 — grouped from the right, which works for any country code.
  const tail = digits.slice(-10);
  return `+${digits.slice(0, digits.length - 10)} ${tail.slice(0, 3)} ${tail.slice(3, 6)} ${tail.slice(6)}`.trim();
}

function relTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const days = (Date.now() - ts) / 86400000;
  if (days < 1) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString();
}

function renderChatList() {
  const filter = $('chatFilter').value.trim().toLowerCase();
  const rows = state.chats.filter((c) => !filter || (c.name || c.jid).toLowerCase().includes(filter));
  $('chatCount').textContent = state.totalChats
    ? `${fmt(rows.length)} shown · ${fmt(state.totalChats)} known to WhatsApp`
    : '';
  $('chatList').innerHTML = rows.length
    ? rows.map((c) => `
        <div class="chat-row${c.jid === state.activeChat ? ' active' : ''}" data-jid="${c.jid}">
          <b><span class="when">${relTime(c.lastTs || c.lastMessageAt)}</span>${escapeHtml(chatLabel(c))}</b>
          <span class="preview">${c.preview ? escapeHtml(c.preview.slice(0, 80)) : `${fmt(c.messageCount)} messages`}</span>
        </div>`).join('')
    : `<div class="empty" style="padding:22px"><p class="tiny">${
        state.totalChats ? 'No messages captured in these chats yet.' : 'Nothing captured yet.'
      }</p></div>`;
}
$('chatFilter').addEventListener('input', renderChatList);

$('chatList').addEventListener('click', (e) => {
  const jid = e.target.closest('[data-jid]')?.dataset.jid;
  if (jid) void openChat(jid);
});

/** Open the cited message in its conversation and highlight it. */
async function jumpToMessage(c) {
  go('chats');
  await openChat(c.chatJid);
  const el = document.querySelector(`[data-mid="${CSS.escape(c.id)}"]`);
  if (el) {
    el.scrollIntoView({ block: 'center' });
    el.classList.add('hit');
    setTimeout(() => el.classList.remove('hit'), 2500);
  }
}

async function openChat(jid) {
  state.activeChat = jid;
  renderChatList();
  const chat = state.chats.find((c) => c.jid === jid);
  $('chatTitle').textContent = chat ? chatLabel(chat) : jid.split('@')[0];
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
    <div class="msg${m.fromMe ? ' mine' : ''}" data-mid="${escapeHtml(m.id || '')}">
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

async function runIndex(opts) {
  $('refresh').disabled = true;
  $('retryFailed').disabled = true;
  $('stopIndex').hidden = false;
  $('refreshOut').textContent = 'Working through the backlog…';
  try {
    const r = await wa.refresh(opts);
    paintStats(r.stats);
    const bits = [];
    if (r.retried) bits.push(`${fmt(r.retried)} failed rows requeued`);
    if (r.backfilled) bits.push(`${fmt(r.backfilled)} sender names filled in`);
    bits.push(`${fmt(r.processed)} glossed`);
    bits.push(`${fmt(r.skipped)} needed no model call`);
    if (r.failed) bits.push(`${fmt(r.failed)} still failing`);
    if (r.cancelled) bits.push('stopped early');
    $('refreshOut').textContent = bits.join(' · ') + '.';
  } catch (e) {
    $('refreshOut').textContent = e.message;
  }
  $('refresh').disabled = false;
  $('retryFailed').disabled = false;
  $('stopIndex').hidden = true;
}
$('refresh').onclick = () => runIndex();
$('retryFailed').onclick = () => runIndex({ retryFailed: true });
$('stopIndex').onclick = () => wa.stopIndexing();

// A long pass is otherwise a frozen button; report each batch.
wa.onIndexProgress((p) => {
  $('refreshOut').textContent = `Indexing… ${fmt(p.done)} of ${fmt(p.total)}`;
});

// --- workspace maintenance ----------------------------------------------

const mb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

async function paintUsage() {
  try {
    const u = await wa.usage();
    state.usage = u;
    $('usageRow').innerHTML = [
      [mb(u.dbBytes), 'database'],
      [mb(u.mediaBytes), `media (${fmt(u.mediaFiles)} files)`],
      [fmt(u.messages), 'messages'],
      [fmt(u.contacts), 'people'],
      [fmt(u.conversations), 'saved chats'],
    ].map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('');
  } catch { /* no workspace open yet */ }
}

/** Every destructive action confirms, reports what it removed, then refreshes. */
async function maintain(label, confirmText, fn) {
  if (confirmText && !confirm(confirmText)) return;
  $('wsMaintOut').textContent = `${label}…`;
  try {
    const r = await fn();
    $('wsMaintOut').textContent = typeof r === 'string' ? r : `${label}: done.`;
    await paintUsage();
    await loadChats();
    await loadConversations();
  } catch (e) {
    $('wsMaintOut').textContent = e.message;
  }
}

$('wsRefreshUsage').onclick = paintUsage;
$('wsCompact').onclick = () =>
  maintain('Compacting', null, async () => { await wa.compact(); return 'Database compacted.'; });

$('wsClearMedia').onclick = () =>
  maintain('Deleting media',
    'Delete all downloaded media?\n\nMessages are kept and stay searchable. The files cannot be recovered.',
    async () => `Deleted ${fmt((await wa.clearMedia()).files)} media files.`);

$('wsClearConvs').onclick = () =>
  maintain('Clearing conversations',
    'Delete every saved Ask conversation?\n\nYour archive of messages is not touched.',
    async () => `Deleted ${fmt((await wa.clearConversations()).conversations)} conversations.`);

$('wsReindex').onclick = () =>
  maintain('Queueing',
    'Re-index every message?\n\nThis re-runs transliteration and glossing for the whole archive and will use your AI provider.',
    async () => `${fmt((await wa.reindexAll()).queued)} messages queued. Run Refresh index to process them.`);

$('wsDeleteOlder').onclick = () => {
  const days = Number($('olderThan').value);
  const cutoff = Date.now() - days * 86400000;
  return maintain('Deleting',
    `Delete every message older than ${days} days?\n\nThis cannot be undone.`,
    async () => {
      const r = await wa.deleteOlderThan(cutoff);
      return `Deleted ${fmt(r.messages)} messages and ${fmt(r.chats)} empty chats.`;
    });
};

$('wsReset').onclick = () =>
  maintain('Emptying archive',
    'Delete EVERYTHING in this archive?\n\nEvery message, chat, contact and media file is removed. Your WhatsApp link is kept. This cannot be undone.',
    async () => `Archive emptied — ${fmt((await wa.resetArchive()).messages)} messages removed.`);

/**
 * Shared by Settings -> Connection and Settings -> Workspace. One implementation
 * so the wording cannot drift: this is a request to the phone, and a silent no
 * is a normal outcome, not a failure.
 */
/**
 * Pull whatever the phone will give: address book, group metadata, and older
 * messages. Reported piece by piece, because these succeed independently and
 * "nothing captured yet to reach back from" is a true statement about message
 * history that says nothing about the contacts we just recovered.
 */
async function requestOlder(btn, out) {
  btn.disabled = true;
  out.textContent = 'Asking your phone…';
  try {
    const r = await wa.syncNow(50);
    const parts = [];
    if (r.appState) parts.push('address book resynced');
    if (r.groups) parts.push(`${fmt(r.groups)} groups refreshed`);
    if (typeof r.contacts === 'number') parts.push(`${fmt(r.contacts)} people known`);
    if (r.historyRequested) {
      parts.push('older messages requested — they arrive over the next few moments');
    } else if (r.reason) {
      parts.push(
        r.reason.startsWith('Nothing captured')
          ? 'no older messages to request yet: WhatsApp needs an existing message to reach back from, so this fills in once some arrive'
          : r.reason,
      );
    }
    out.textContent = parts.length ? parts.join(' · ') + '.' : 'Nothing to sync.';
    await loadChats();
  } catch (e) {
    out.textContent = e.message;
  }
  btn.disabled = false;
}
$('fetchOlder').onclick = () => requestOlder($('fetchOlder'), $('fetchOlderOut'));
$('ctlFetch').onclick = () => requestOlder($('ctlFetch'), $('ctlNote'));

$('exportSettings').onclick = async () => {
  try {
    const r = await wa.exportSettings();
    $('portNote').textContent = r.saved
      ? `Exported to ${r.path}. The API key was not included — set it again after importing.`
      : '';
  } catch (e) { $('portNote').textContent = e.message; }
};

$('importSettings').onclick = async () => {
  try {
    const r = await wa.importSettings();
    if (!r.imported) return;
    paintSettings(await wa.getSettings());
    $('portNote').textContent =
      `Imported: ${r.applied.join(', ')}.` +
      (r.needsKey ? ' Add your API key in Settings → AI provider.' : '');
  } catch (e) { $('portNote').textContent = e.message; }
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
  if (n === 4) paintObProvider();
  if (n === 3 && !links.onboarding) {
    links.onboarding = mountLink($('obLinkHost'), wa, {
      // Do NOT jump straight into the app. Linking is the moment the archive
      // starts existing and the history import begins; yanking the screen away
      // hides both. Swap the actions and let them move on when ready.
      onLinked: () => {
        $('obLinkActions').hidden = true;
        $('obDoneActions').hidden = false;
      },
    });
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

// --- capture settings ---------------------------------------------------

function paintCapture(s) {
  const cap = s.capture;
  if (!cap) return;
  const box = (group, key, label, on) =>
    `<label><input type="checkbox" data-cap="${group}" data-key="${key}"${on ? ' checked' : ''}> ${label}</label>`;
  $('captureSources').innerHTML = Object.entries(SOURCE_LABELS)
    .map(([k, label]) => box('sources', k, label, cap.sources[k])).join('');
  $('captureMedia').innerHTML = Object.entries(MEDIA_LABELS)
    .map(([k, label]) => box('media', k, label, cap.media[k])).join('');
}

async function onCaptureToggle(e) {
  const el = e.target.closest('[data-cap]');
  if (!el) return;
  const { filter, ok, reason } = toggleCapture(
    state.settings.capture,
    el.dataset.cap,
    el.dataset.key,
    el.checked,
  );
  if (!ok) {
    el.checked = !el.checked;
    $('captureNote').textContent = reason;
    return;
  }
  $('captureNote').textContent = 'Saved. Applies to messages arriving from now on.';
  paintSettings(await wa.saveSettings({ capture: filter }));
}
$('captureSources').addEventListener('change', onCaptureToggle);
$('captureMedia').addEventListener('change', onCaptureToggle);

// --- connection controls ------------------------------------------------

async function control(fn, note) {
  $('ctlNote').textContent = note;
  try {
    paintStatus(await fn());
  } catch (e) {
    $('ctlNote').textContent = e.message;
  }
}
$('ctlPause').onclick = () => control(() => wa.pauseCapture(), 'Capture paused. Nothing is being archived.');
$('ctlRefresh').onclick = () => control(() => wa.refreshConnection(), 'Reconnecting…');
$('ctlUnlink').onclick = async () => {
  // Destructive and not obviously so from the button alone: it ends the session
  // and forces a fresh QR scan.
  if (!confirm('Unlink this device?\n\nThe session ends and you will need to scan a new QR code. Your archive is not deleted.')) return;
  await control(() => wa.unlinkDevice(), 'Unlinked. Scan a new QR code to start capturing again.');
};

// --- onboarding step 4: AI provider ---------------------------------------
// Placed after linking on purpose. Capture is the part that cannot be recovered
// later; a provider can be added any time, so it must never gate recording.

function paintObProvider() {
  const s = state.settings;
  if (!s) return;
  const sel = $('obProvider');
  if (sel.options.length !== (s.presets || []).length) {
    sel.innerHTML = (s.presets || []).map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
    sel.value = s.providerId;
  }
  const preset = (s.presets || []).find((p) => p.id === sel.value);
  $('obCustomFields').hidden = sel.value !== 'custom';
  if (preset && sel.value !== 'custom') {
    $('obModel').placeholder = preset.suggestedModel || 'model name';
    if (preset.suggestedModel) $('obModel').value = preset.suggestedModel;
    $('obBaseUrl').value = preset.baseUrl;
    $('obKind').value = preset.kind;
  }
  $('obProviderNote').textContent = [
    preset?.note,
    preset && !preset.needsKey ? 'Runs on this machine — no API key needed.' : '',
  ].filter(Boolean).join(' ');
}
$('obProvider').onchange = paintObProvider;

$('obSkipAi').onclick = finishOnboarding;

$('obSaveAi').onclick = async () => {
  $('obSaveAi').disabled = true;
  $('obProviderMsg').textContent = 'Saving…';
  try {
    const id = $('obProvider').value;
    const key = $('obKey').value.trim();
    const updated = await wa.saveSettings({
      providerId: id,
      ...(id === 'custom' ? { baseUrl: $('obBaseUrl').value.trim(), providerKind: $('obKind').value } : {}),
      model: $('obModel').value.trim(),
      ...(key ? { apiKey: key } : {}),
    });
    paintSettings(updated);
    // Say plainly whether it actually took, rather than assuming.
    if (updated.localOnly) {
      $('obProviderMsg').textContent =
        'Saved, but still local-only — that provider needs an API key or a base URL.';
      $('obSaveAi').disabled = false;
      return;
    }
    finishOnboarding();
  } catch (e) {
    $('obProviderMsg').textContent = e.message;
    $('obSaveAi').disabled = false;
  }
};

let onboardingDone = false;
function finishOnboarding() {
  // Idempotent by effect, not by early return. The guard used to skip the whole
  // body on a second call, so any later "finish" — the AI step, Skip — left the
  // overlay on screen because boot had already consumed the one allowed run.
  $('onboarding').hidden = true;
  $('shell').hidden = false;
  if (!onboardingDone) {
    onboardingDone = true;
    go('ask');
  }
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
