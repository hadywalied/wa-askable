import { BrowserWindow, dialog, ipcMain } from 'electron';
import { makeProvider, type ChatProvider } from '../core/provider.js';
import { loadConfig, type Config } from './config.js';
import { auditWorkspace, openWorkspace, type Workspace } from '../core/workspace.js';
import {
  appendTurn,
  conversationTurns,
  createConversation,
  deleteConversation,
  listConversations,
  contactCount,
  openDatabase,
  stats,
  type DB,
} from '../core/db.js';
import { WhatsAppArchive } from '../core/whatsapp.js';
import {
  clearConversations,
  clearMedia,
  compact,
  deleteChat,
  deleteOlderThan,
  reindexAll,
  resetArchive,
  workspaceUsage,
} from '../core/maintenance.js';
import { Enricher, ask } from '../core/enrich.js';
import { listChats, searchMessages } from '../core/search.js';
import { shell } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { log, logPath } from './log.js';
import { PROVIDER_PRESETS, isLocalEndpoint, presetById } from '../shared/providers.js';
import type { CaptureFilter } from '../shared/capture.js';
import {
  CHANNELS,
  EVENTS,
  type AppSettings,
  type SearchArgs,
  type SettingsPatch,
  type WhatsAppStatus,
} from '../shared/ipc.js';
import {
  applyAutostart,
  encryptionAvailable,
  getApiKey,
  getProviderConfig,
  getSettings,
  setApiKey,
  setProviderConfig,
  setSecretLocation,
  updateSettings,
} from './settings.js';

/**
 * Replaces server/app.ts.
 *
 * The old version had to defend a TCP port that any website in any tab could
 * reach: a per-process token, a Sec-Fetch-Site check, and a refusal to bind to
 * anything but loopback. None of that is needed now — there is no port. What
 * survives is the CSP (in index.ts) and the rule that matters most: the agent's
 * capability surface is three read-only functions with no filesystem, shell or
 * network access. Every string in this database was written by someone else.
 */

interface Runtime {
  ws: Workspace;
  db: DB;
  wa: WhatsAppArchive;
  enricher: Enricher;
  provider: ChatProvider | null;
}

let rt: Runtime | null = null;
/** Mutable so a settings change takes effect without a relaunch. */
let cfg: Config;

/** Listeners outside the renderer that care about connection state (the tray). */
const statusListeners = new Set<(s: WhatsAppStatus) => void>();

export function onStatusChange(cb: (s: WhatsAppStatus) => void): void {
  statusListeners.add(cb);
}

/** Current connection state, or idle when no workspace is open. */
export function currentStatus(): WhatsAppStatus {
  return rt?.wa.getStatus() ?? { state: 'idle', capturedThisSession: 0 };
}

/**
 * Retry immediately, resetting backoff. Called on wake and when the network
 * comes back — waiting out a five-minute backoff when we have evidence the
 * situation changed is five minutes of messages we would never see.
 */
export function reconnectNow(): void {
  rt?.wa.reconnectNow();
}

export function hasWorkspace(): boolean {
  return rt !== null;
}

const need = (): Runtime => {
  if (!rt) throw new Error('No workspace is open.');
  return rt;
};

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

async function boot(cfg: Config, root: string): Promise<Runtime> {
  // Tear down any previous session before swapping workspaces, or the old
  // socket keeps writing into a database nobody is looking at any more.
  if (rt) {
    await rt.wa.disconnect().catch(() => {});
    rt.db.close();
    rt = null;
  }

  const ws = await openWorkspace(root);
  // AI configuration lives with the archive, so it must be pointed at the new
  // workspace before anything reads a key.
  setSecretLocation(ws.root);
  const db = openDatabase(ws.dbPath);
  // The filter is read per message, so changing it takes effect immediately
  // rather than on the next reconnect.
  const wa = new WhatsAppArchive(db, ws.authDir, ws.mediaDir, () => getSettings().capture);
  const provider = currentProvider();
  const enricher = new Enricher(db, provider, cfg.model, (p) =>
    broadcast(EVENTS.indexProgress, p),
  );

  // Push, don't poll. The socket already fires on every captured message; the
  // renderer used to ask every 2.5s for something it could simply be told.
  wa.on('status', (s: WhatsAppStatus) => {
    log('wa', `state=${s.state}`, s.lastError ?? undefined);
    broadcast(EVENTS.status, s);
    for (const cb of statusListeners) cb(s);
  });
  wa.on('log', (m: string) => log('wa', m));
  wa.on('reconnect-scheduled', (d: { delay: number; attempt: number }) =>
    log('wa', `reconnect in ${Math.round(d.delay / 1000)}s (attempt ${d.attempt})`),
  );

  // 'captured' fires once per message and a busy group will flood it, so stats
  // are coalesced onto a timer rather than sent per row.
  let statsTimer: NodeJS.Timeout | null = null;
  wa.on('captured', () => {
    if (statsTimer) return;
    statsTimer = setTimeout(() => {
      statsTimer = null;
      if (rt) broadcast(EVENTS.stats, stats(rt.db));
    }, 1_000);
  });
  wa.on('history-synced', () => {
    if (rt) broadcast(EVENTS.stats, stats(rt.db));
  });

  return { ws, db, wa, enricher, provider };
}

/**
 * Rebuild everything that depends on the API key or model.
 *
 * Enricher and the Anthropic client both capture the key at construction, so a
 * settings change has to replace them. The WhatsApp socket is deliberately left
 * alone — re-linking because someone pasted a key would be absurd, and would
 * drop messages while it reconnected.
 */
function currentProvider(): ChatProvider | null {
  return makeProvider({
    kind: cfg.providerKind,
    apiKey: cfg.anthropicApiKey,
    baseUrl: cfg.baseUrl,
  });
}

function rebuildProvider(): void {
  if (!rt) return;
  const provider = currentProvider();
  rt.provider = provider;
  rt.enricher = new Enricher(rt.db, provider, cfg.model, (p) =>
    broadcast(EVENTS.indexProgress, p),
  );
}

async function describeSettings(message?: string): Promise<AppSettings & { message?: string }> {
  const settings = getSettings();
  const key = await getApiKey();
  return {
    openAtLogin: settings.openAtLogin,
    autostartEffective: settings.openAtLogin,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    providerId: cfg.providerId,
    providerKind: cfg.providerKind,
    presets: PROVIDER_PRESETS,
    localEndpoint: isLocalEndpoint(cfg.baseUrl),
    capture: getSettings().capture,
    hasKey: key !== undefined,
    keyPersisted: keyPersisted,
    encryptionAvailable: await encryptionAvailable(),
    keyFromEnv: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    localOnly: cfg.localOnly,
    workspace: rt?.ws.root ?? null,
    defaultWorkspace: cfg.defaultWorkspace,
    ...(message ? { message } : {}),
  };
}

let keyPersisted = true;

export function registerIpc(initial: Config): void {
  cfg = initial;
  ipcMain.handle(CHANNELS.settingsGet, () => describeSettings());

  ipcMain.handle(CHANNELS.settingsSave, async (_e, patch: SettingsPatch) => {
    let message: string | undefined;

    if (patch.apiKey !== undefined) {
      const res = await setApiKey(patch.apiKey);
      keyPersisted = res.persisted;
      message = res.message;
    }
    if (patch.model !== undefined && patch.model.trim()) {
      updateSettings({ model: patch.model.trim() });
    }
    if (patch.baseUrl !== undefined) {
      updateSettings({ baseUrl: patch.baseUrl.trim() });
    }
    // Provider identity is stored encrypted in the workspace alongside the key.
    if (patch.model !== undefined && patch.model.trim()) {
      await setProviderConfig({ model: patch.model.trim() });
    }
    if (patch.baseUrl !== undefined) {
      await setProviderConfig({ baseUrl: patch.baseUrl.trim() });
    }
    if (patch.providerKind !== undefined) {
      await setProviderConfig({ providerKind: patch.providerKind });
    }
    if (patch.providerId !== undefined) {
      const preset = presetById(patch.providerId);
      await setProviderConfig({
        providerId: patch.providerId,
        ...(preset && patch.providerId !== 'custom'
          ? { providerKind: preset.kind, baseUrl: preset.baseUrl }
          : {}),
      });
    }
    if (patch.capture !== undefined) {
      updateSettings({ capture: patch.capture });
    }
    if (patch.providerKind !== undefined) {
      updateSettings({ providerKind: patch.providerKind });
    }
    // Selecting a preset applies its endpoint and protocol. The model and key
    // are left alone — they are the user's, and a preset must not silently
    // discard a key they just pasted.
    if (patch.providerId !== undefined) {
      const preset = presetById(patch.providerId);
      updateSettings({
        providerId: patch.providerId,
        ...(preset && patch.providerId !== 'custom'
          ? { providerKind: preset.kind, baseUrl: preset.baseUrl }
          : {}),
      });
    }
    if (patch.openAtLogin !== undefined) {
      // Store what actually took effect, not what was asked for.
      updateSettings({ openAtLogin: applyAutostart(patch.openAtLogin) });
    }

    // Re-read rather than patching cfg by hand, so there is exactly one path
    // from stored settings to running configuration.
    cfg = await loadConfig();
    rebuildProvider();
    return describeSettings(message);
  });

  /**
   * Export settings to a file.
   *
   * The API key is deliberately NOT included. An export is a file people mail
   * to themselves and drop in cloud storage; a plaintext credential in it would
   * outlive every protection the encrypted store provides.
   */
  ipcMain.handle(CHANNELS.settingsExport, async (e) => {
    const parent = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const res = await dialog.showSaveDialog(parent!, {
      title: 'Export settings',
      defaultPath: 'wa-askable-settings.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { saved: false };

    const s = getSettings();
    const payload = {
      app: 'wa-askable',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: {
        openAtLogin: s.openAtLogin,
        model: cfg.model,
        providerId: cfg.providerId,
        providerKind: cfg.providerKind,
        baseUrl: cfg.baseUrl,
        capture: s.capture,
      },
      note: 'The API key is intentionally not exported. Set it again after importing.',
    };
    writeFileSync(res.filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    log('settings', `exported to ${res.filePath}`);
    return { saved: true, path: res.filePath };
  });

  ipcMain.handle(CHANNELS.settingsImport, async (e) => {
    const parent = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const res = await dialog.showOpenDialog(parent!, {
      title: 'Import settings',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return { imported: false };

    let parsed: { app?: string; settings?: Record<string, unknown> };
    try {
      parsed = JSON.parse(readFileSync(res.filePaths[0], 'utf8')) as typeof parsed;
    } catch {
      throw new Error('That file is not valid JSON.');
    }
    if (parsed?.app !== 'wa-askable' || !parsed.settings) {
      throw new Error('That does not look like a wa-askable settings export.');
    }

    // Applied field by field. Anything unrecognised is ignored rather than
    // written through, so a file from a future version cannot corrupt state.
    const incoming = parsed.settings as {
      openAtLogin?: boolean; model?: string; providerId?: string;
      providerKind?: 'anthropic' | 'openai'; baseUrl?: string; capture?: CaptureFilter;
    };
    const applied: string[] = [];
    if (typeof incoming.openAtLogin === 'boolean') {
      updateSettings({ openAtLogin: applyAutostart(incoming.openAtLogin) });
      applied.push('start at login');
    }
    if (incoming.capture?.sources && incoming.capture?.media) {
      updateSettings({ capture: incoming.capture });
      applied.push('capture filters');
    }
    if (incoming.providerId) {
      await setProviderConfig({
        providerId: incoming.providerId,
        ...(incoming.providerKind ? { providerKind: incoming.providerKind } : {}),
        ...(incoming.baseUrl !== undefined ? { baseUrl: incoming.baseUrl } : {}),
        ...(incoming.model ? { model: incoming.model } : {}),
      });
      applied.push('AI provider');
    }

    cfg = await loadConfig();
    rebuildProvider();
    log('settings', `imported from ${res.filePaths[0]}: ${applied.join(', ')}`);
    return { imported: true, applied, needsKey: !(await getApiKey()) };
  });

  ipcMain.handle(CHANNELS.workspacePick, async (e) => {
    const parent = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const res = await dialog.showOpenDialog(parent!, {
      title: 'Choose where to keep the archive',
      defaultPath: rt?.ws.root ?? cfg.defaultWorkspace,
      // createDirectory is macOS-only; Windows uses promptToCreate.
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    });
    return { path: res.canceled ? null : (res.filePaths[0] ?? null) };
  });

  ipcMain.handle(CHANNELS.sessionGet, () => ({
    localOnly: cfg.localOnly,
    model: cfg.model,
    workspace: rt?.ws.root ?? null,
    defaultWorkspace: cfg.defaultWorkspace,
  }));

  ipcMain.handle(CHANNELS.workspaceOpen, async (_e, root?: string) => {
    rt = await boot(cfg, root?.trim() || cfg.defaultWorkspace);
    // Remembered so an autostart launch can resume capture without a click.
    updateSettings({ lastWorkspace: rt.ws.root });
    return {
      workspace: rt.ws.root,
      warnings: await auditWorkspace(rt.ws),
      stats: stats(rt.db),
      enrichmentEnabled: rt.enricher.enabled,
    };
  });

  ipcMain.handle(CHANNELS.statusGet, () => {
    if (!rt) return { workspace: null, connection: { state: 'idle' as const }, stats: null };
    return {
      workspace: rt.ws.root,
      connection: rt.wa.getStatus(),
      stats: stats(rt.db),
      enrichmentEnabled: rt.enricher.enabled,
      pending: rt.enricher.pendingCount(),
      failed: rt.enricher.failedCount(),
      contacts: contactCount(rt.db),
    };
  });

  // force: a user pressing the button must always do something, even when a
  // previous attempt is wedged. See the comment on connect().
  ipcMain.handle(CHANNELS.whatsappConnect, async () => {
    log('ipc', 'connect requested by user');
    await need().wa.connect(true);
    return need().wa.getStatus();
  });

  ipcMain.handle(CHANNELS.whatsappPairingCode, async (_e, phone: string) => {
    const code = await need().wa.requestPairingCode(phone);
    return { code };
  });

  ipcMain.handle(CHANNELS.logsOpen, async () => {
    await shell.openPath(logPath());
    return { path: logPath() };
  });

  ipcMain.handle(CHANNELS.logsTail, () => {
    try {
      const all = readFileSync(logPath(), 'utf8').split('\n');
      return { path: logPath(), lines: all.slice(-200).join('\n') };
    } catch {
      return { path: logPath(), lines: '(no log yet)' };
    }
  });

  ipcMain.handle(CHANNELS.whatsappDisconnect, async () => {
    await need().wa.disconnect();
    return need().wa.getStatus();
  });

  // Three distinct actions, deliberately not one button:
  // pause keeps the session, refresh retries now, unlink destroys it.
  ipcMain.handle(CHANNELS.whatsappPause, async () => {
    await need().wa.pause();
    return need().wa.getStatus();
  });
  ipcMain.handle(CHANNELS.whatsappRefresh, async () => {
    await need().wa.refresh();
    return need().wa.getStatus();
  });
  ipcMain.handle(CHANNELS.whatsappUnlink, async () => {
    await need().wa.unlink();
    return need().wa.getStatus();
  });

  /**
   * Note what this does NOT do: it does not fetch messages. The socket already
   * pushed those the moment they arrived. This drains the enrichment backlog
   * those messages created — transliterating Franco, writing English glosses,
   * and (later) transcribing audio.
   */
  ipcMain.handle(CHANNELS.refreshRun, async (_e, opts?: { retryFailed?: boolean }) => {
    const { enricher, db } = need();
    const retried = opts?.retryFailed ? enricher.retryFailed() : 0;
    const result = await enricher.run(25);
    const s = stats(db);
    broadcast(EVENTS.stats, s);
    return { ...result, retried, stats: s };
  });

  // --- workspace maintenance ----------------------------------------------
  // Each one narrow and explicit. A single "clean up" button whose blast radius
  // nobody can predict is the shape to avoid here.

  ipcMain.handle(CHANNELS.wsUsage, async () => {
    const rt2 = need();
    return workspaceUsage(rt2.db, rt2.ws.dbPath, rt2.ws.mediaDir);
  });

  ipcMain.handle(CHANNELS.wsClearMedia, async () => {
    const rt2 = need();
    const r = await clearMedia(rt2.db, rt2.ws.mediaDir);
    log('ws', `cleared media: ${r.files} files`);
    broadcast(EVENTS.stats, stats(rt2.db));
    return r;
  });

  ipcMain.handle(CHANNELS.wsClearConversations, () => {
    const r = clearConversations(need().db);
    log('ws', `cleared ${r.conversations} saved conversations`);
    return r;
  });

  ipcMain.handle(CHANNELS.wsReindex, () => {
    const r = reindexAll(need().db);
    log('ws', `queued ${r.queued} messages for re-enrichment`);
    broadcast(EVENTS.stats, stats(need().db));
    return r;
  });

  ipcMain.handle(CHANNELS.wsDeleteOlder, (_e, cutoffMs: number) => {
    const r = deleteOlderThan(need().db, cutoffMs);
    log('ws', `deleted ${r.messages} messages older than ${new Date(cutoffMs).toISOString()}`);
    broadcast(EVENTS.stats, stats(need().db));
    return r;
  });

  ipcMain.handle(CHANNELS.wsDeleteChat, (_e, chatJid: string) => {
    const r = deleteChat(need().db, chatJid);
    log('ws', `deleted chat ${chatJid} (${r.messages} messages)`);
    broadcast(EVENTS.stats, stats(need().db));
    return r;
  });

  ipcMain.handle(CHANNELS.wsReset, async () => {
    const rt2 = need();
    const r = await resetArchive(rt2.db, rt2.ws.mediaDir);
    log('ws', `archive reset: ${r.messages} messages removed (session kept)`);
    broadcast(EVENTS.stats, stats(rt2.db));
    return r;
  });

  ipcMain.handle(CHANNELS.wsCompact, () => {
    compact(need().db);
    log('ws', 'database compacted');
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.waFetchOlder, async (_e, count?: number, chatJid?: string) =>
    need().wa.fetchOlderMessages(count ?? 50, chatJid),
  );

  ipcMain.handle(CHANNELS.waSyncNow, async (_e, count?: number) => {
    const r = await need().wa.syncNow(count ?? 50);
    broadcast(EVENTS.stats, stats(need().db));
    return { ...r, contacts: contactCount(need().db) };
  });

  ipcMain.handle(CHANNELS.indexStop, () => {
    need().enricher.stop();
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.chatsList, (_e, includeEmpty?: boolean) => ({
    chats: listChats(need().db, 500, !includeEmpty),
    totalChats: stats(need().db).chats,
  }));

  ipcMain.handle(CHANNELS.searchRun, (_e, args: SearchArgs) => ({
    hits: searchMessages(need().db, args),
  }));

  ipcMain.handle(CHANNELS.convList, () => ({ conversations: listConversations(need().db) }));
  ipcMain.handle(CHANNELS.convCreate, () => createConversation(need().db));
  ipcMain.handle(CHANNELS.convGet, (_e, id: string) => ({
    turns: conversationTurns(need().db, id),
  }));
  ipcMain.handle(CHANNELS.convDelete, (_e, id: string) => {
    deleteConversation(need().db, id);
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.askSend, async (_e, question: string, conversationId?: string) => {
    const { db, provider } = need();
    if (!provider) {
      throw new Error(
        'Answering questions needs a provider. Choose one in Settings, or keep using ' +
          'search, which runs entirely on this machine.',
      );
    }
    // Prior turns are replayed so follow-ups work ("and what about last week?").
    // Tool results are deliberately not replayed — the agent can search again,
    // and stuffing old results into context grows without bound.
    const history = conversationId
      ? conversationTurns(db, conversationId).map((t) => ({
          role: t.role,
          content: t.content,
        }))
      : [];

    if (conversationId) appendTurn(db, conversationId, { role: 'user', content: question });
    const reply = await ask(db, provider, cfg.model, question, history as never);
    if (conversationId) {
      appendTurn(db, conversationId, {
        role: 'assistant',
        content: reply.answer,
        toolCalls: reply.toolCalls,
        citations: reply.citations,
      });
    }
    return reply;
  });
}

/**
 * Reopen the last workspace and reconnect, with no window involved.
 *
 * This is what makes autostart worth anything: the app launches hidden at
 * login, and capture resumes on its own. Without it, tray residency just means
 * a quiet app that is not recording.
 */
export async function resumeLastWorkspace(): Promise<boolean> {
  const last = getSettings().lastWorkspace;
  if (!last) return false;
  try {
    rt = await boot(cfg, last);
    await rt.wa.connect();
    return true;
  } catch (err) {
    console.error('[main] could not resume last workspace:', err);
    return false;
  }
}

/** Called on quit so the socket closes and SQLite checkpoints its WAL. */
export async function shutdownRuntime(): Promise<void> {
  if (!rt) return;
  await rt.wa.disconnect().catch(() => {});
  rt.db.close();
  rt = null;
}
