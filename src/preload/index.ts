import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, EVENTS } from '../shared/ipc.js';
import type {
  AskResult,
  OpenResult,
  RefreshResult,
  SearchArgs,
  SessionInfo,
  StatusResult,
  WhatsAppStatus,
  WorkspaceStats,
} from '../shared/ipc.js';

/**
 * The renderer's entire view of the main process.
 *
 * Three rules here, all of them load-bearing:
 *
 * 1. Never expose ipcRenderer itself, or a generic invoke(channel, ...args).
 *    That would hand the renderer the whole main process instead of these nine
 *    named calls.
 * 2. Event subscriptions must unwrap the IpcRendererEvent and pass only the
 *    payload. Forwarding the raw event leaks `event.sender` — Electron's
 *    security docs call this out explicitly.
 * 3. This file is sandboxed and CommonJS, so it can import `electron`, `events`,
 *    `timers` and `url` and nothing else. The type imports above are erased at
 *    build time; core/* is never loaded here. See PLAN.md §11.3.
 */
/**
 * Electron wraps anything a handler throws as
 *   "Error invoking remote method 'ask:send': Error: <the real message>"
 * and that string would otherwise be shown to the user verbatim. The old HTTP
 * version surfaced a clean message, so unwrap it back to that.
 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''));
  }
}

const api = {
  getSession: (): Promise<SessionInfo> => invoke(CHANNELS.sessionGet),
  openWorkspace: (path: string): Promise<OpenResult> =>
    invoke(CHANNELS.workspaceOpen, path),
  getStatus: (): Promise<StatusResult> => invoke(CHANNELS.statusGet),

  connect: (): Promise<WhatsAppStatus> => invoke(CHANNELS.whatsappConnect),
  disconnect: (): Promise<WhatsAppStatus> => invoke(CHANNELS.whatsappDisconnect),

  refresh: (): Promise<RefreshResult> => invoke(CHANNELS.refreshRun),
  listChats: (): Promise<{ chats: unknown[] }> => invoke(CHANNELS.chatsList),
  search: (args: SearchArgs): Promise<{ hits: unknown[] }> =>
    invoke(CHANNELS.searchRun, args),
  ask: (question: string): Promise<AskResult> => invoke(CHANNELS.askSend, question),

  onStatus: (cb: (s: WhatsAppStatus) => void): void => {
    ipcRenderer.on(EVENTS.status, (_event, payload: WhatsAppStatus) => cb(payload));
  },
  onStats: (cb: (s: WorkspaceStats) => void): void => {
    ipcRenderer.on(EVENTS.stats, (_event, payload: WorkspaceStats) => cb(payload));
  },
};

contextBridge.exposeInMainWorld('wa', api);

export type WaApi = typeof api;
