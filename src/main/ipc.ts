import { BrowserWindow, dialog, ipcMain } from 'electron';
import { makeProvider, type ChatProvider } from '../core/provider.js';
import { loadConfig, type Config } from './config.js';
import { auditWorkspace, openWorkspace, type Workspace } from '../core/workspace.js';
import { openDatabase, stats, type DB } from '../core/db.js';
import { WhatsAppArchive } from '../core/whatsapp.js';
import { Enricher, ask } from '../core/enrich.js';
import { listChats, searchMessages } from '../core/search.js';
import { PROVIDER_PRESETS, isLocalEndpoint, presetById } from '../shared/providers.js';
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
  getSettings,
  setApiKey,
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
  const db = openDatabase(ws.dbPath);
  const wa = new WhatsAppArchive(db, ws.authDir, ws.mediaDir);
  const provider = currentProvider();
  const enricher = new Enricher(db, provider, cfg.model);

  // Push, don't poll. The socket already fires on every captured message; the
  // renderer used to ask every 2.5s for something it could simply be told.
  wa.on('status', (s: WhatsAppStatus) => {
    broadcast(EVENTS.status, s);
    for (const cb of statusListeners) cb(s);
  });

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
  rt.enricher = new Enricher(rt.db, provider, cfg.model);
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
    };
  });

  ipcMain.handle(CHANNELS.whatsappConnect, async () => {
    await need().wa.connect();
    return need().wa.getStatus();
  });

  ipcMain.handle(CHANNELS.whatsappDisconnect, async () => {
    await need().wa.disconnect();
    return need().wa.getStatus();
  });

  /**
   * Note what this does NOT do: it does not fetch messages. The socket already
   * pushed those the moment they arrived. This drains the enrichment backlog
   * those messages created — transliterating Franco, writing English glosses,
   * and (later) transcribing audio.
   */
  ipcMain.handle(CHANNELS.refreshRun, async () => {
    const { enricher, db } = need();
    const result = await enricher.run(25);
    const s = stats(db);
    broadcast(EVENTS.stats, s);
    return { ...result, stats: s };
  });

  ipcMain.handle(CHANNELS.chatsList, () => ({ chats: listChats(need().db) }));

  ipcMain.handle(CHANNELS.searchRun, (_e, args: SearchArgs) => ({
    hits: searchMessages(need().db, args),
  }));

  ipcMain.handle(CHANNELS.askSend, async (_e, question: string) => {
    const { db, provider } = need();
    if (!provider) {
      throw new Error(
        'Answering questions needs a provider. Choose one in Settings, or keep using ' +
          'search, which runs entirely on this machine.',
      );
    }
    return ask(db, provider, cfg.model, question);
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
