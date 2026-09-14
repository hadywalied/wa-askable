/**
 * The IPC contract, shared by main, preload and (as documentation) the renderer.
 *
 * Everything crossing IPC is serialised with the Structured Clone Algorithm, so
 * every type here must be a plain cloneable object. No class instances, no
 * Database handles, no EventEmitters, no functions. The sandboxed preload also
 * cannot import from core/* at runtime — these are `import type` only, which is
 * erased at build time. See PLAN.md §11.3.
 */

export const CHANNELS = {
  sessionGet: 'session:get',
  workspaceOpen: 'workspace:open',
  statusGet: 'status:get',
  whatsappConnect: 'whatsapp:connect',
  whatsappDisconnect: 'whatsapp:disconnect',
  refreshRun: 'refresh:run',
  chatsList: 'chats:list',
  searchRun: 'search:run',
  askSend: 'ask:send',
} as const;

/** Pushed from main; the renderer no longer polls. */
export const EVENTS = {
  status: 'wa:status',
  stats: 'wa:stats',
} as const;

export interface WorkspaceWarning {
  level: 'warn' | 'danger';
  message: string;
}

export interface WorkspaceStats {
  chats: number;
  messages: number;
  pending: number;
  mediaUnique: number;
  mediaReferences: number;
  oldest: number | null;
  newest: number | null;
}

export type ConnState = 'idle' | 'connecting' | 'qr' | 'open' | 'closed' | 'logged_out';

export interface WhatsAppStatus {
  state: ConnState;
  qrDataUrl?: string;
  selfJid?: string;
  lastError?: string;
  capturedThisSession: number;
}

export interface SessionInfo {
  localOnly: boolean;
  model: string;
  workspace: string | null;
  defaultWorkspace: string;
}

export interface OpenResult {
  workspace: string;
  warnings: WorkspaceWarning[];
  stats: WorkspaceStats;
  enrichmentEnabled: boolean;
}

export interface StatusResult {
  workspace: string | null;
  connection: WhatsAppStatus | { state: 'idle' };
  stats: WorkspaceStats | null;
  enrichmentEnabled?: boolean;
  pending?: number;
}

export interface RefreshResult {
  processed: number;
  skipped: number;
  stats: WorkspaceStats;
}

export interface SearchArgs {
  query: string;
  chatJid?: string;
  sender?: string;
  after?: number;
  before?: number;
  limit?: number;
}

export interface AskResult {
  answer: string;
  toolCalls: { name: string; input: unknown }[];
}
