import { BrowserWindow, ipcMain } from 'electron';
import Anthropic from '@anthropic-ai/sdk';
import type { Config } from './config.js';
import { auditWorkspace, openWorkspace, type Workspace } from '../core/workspace.js';
import { openDatabase, stats, type DB } from '../core/db.js';
import { WhatsAppArchive } from '../core/whatsapp.js';
import { Enricher, ask } from '../core/enrich.js';
import { listChats, searchMessages } from '../core/search.js';
import { CHANNELS, EVENTS, type SearchArgs, type WhatsAppStatus } from '../shared/ipc.js';
import { getSettings, updateSettings } from './settings.js';

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
  client: Anthropic | null;
}

let rt: Runtime | null = null;

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
  const enricher = new Enricher(db, cfg.anthropicApiKey, cfg.model);
  const client = cfg.anthropicApiKey ? new Anthropic({ apiKey: cfg.anthropicApiKey }) : null;

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

  return { ws, db, wa, enricher, client };
}

export function registerIpc(cfg: Config): void {
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
    const { db, client } = need();
    if (!client) {
      throw new Error(
        'Answering questions needs a model. Set ANTHROPIC_API_KEY and restart, or keep ' +
          'using search, which runs entirely on this machine.',
      );
    }
    return ask(db, client, cfg.model, question);
  });
}

/**
 * Reopen the last workspace and reconnect, with no window involved.
 *
 * This is what makes autostart worth anything: the app launches hidden at
 * login, and capture resumes on its own. Without it, tray residency just means
 * a quiet app that is not recording.
 */
export async function resumeLastWorkspace(cfg: Config): Promise<boolean> {
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
