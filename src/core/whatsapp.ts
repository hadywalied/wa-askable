import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  // NAMED import, not default. Baileys is CommonJS with no real default export:
  // under real ESM `import makeWASocket from '...'` resolves to the module
  // namespace OBJECT, and calling it throws "makeWASocket is not a function".
  // The old server ran under tsx, whose interop hid this; Electron's ESM loader
  // does not. This is why connecting hung forever with an empty auth/ dir.
  makeWASocket,
  DisconnectReason,
  downloadMediaMessage,
  isJidGroup,
  jidNormalizedUser,
  useMultiFileAuthState,
  Browsers,
  fetchLatestBaileysVersion,
  type WAMessage,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { toDataURL } from 'qrcode';
import type { DB, MessageKind } from './db.js';
import { insertMessage, rememberMedia, upsertChat } from './db.js';
import { foldForSearch, stemsForSearch } from './normalize.js';
import { DEFAULT_CAPTURE, shouldCapture, type CaptureFilter } from '../shared/capture.js';

/**
 * The archive's connection to WhatsApp.
 *
 * Two things worth understanding before you change anything here:
 *
 * 1. This is a *linked device*, not a scrape. WhatsApp allows four; we occupy
 *    one. Your phone keeps working untouched. Nothing is sent, ever — the
 *    socket is configured to listen and mark nothing as read, so the people
 *    messaging you see no change in behaviour.
 *
 * 2. Messages arrive by push, not by poll. There is no "fetch new messages"
 *    call to make. While connected, messages.upsert fires in real time; on
 *    first link, WhatsApp pushes a history blob through messaging-history.set.
 *    That blob is partial and unreliable and is the only past you will ever
 *    get. Everything else is the future.
 */

export type ConnState = 'idle' | 'connecting' | 'qr' | 'open' | 'closed' | 'logged_out';

export interface WhatsAppStatus {
  state: ConnState;
  qrDataUrl?: string;
  /** Unix ms; the QR is rotated by WhatsApp and the UI counts down to it. */
  qrExpiresAt?: number;
  /** Pairing code, when linking by phone number instead of QR. */
  pairingCode?: string;
  selfJid?: string;
  lastError?: string;
  /** Which attempt we are on, so the UI can say "retrying (3)". */
  attempt?: number;
  capturedThisSession: number;
}

type Sock = ReturnType<typeof makeWASocket>;

function messageKind(msg: WAMessage): MessageKind {
  const m = msg.message;
  if (!m) return 'other';
  if (m.conversation || m.extendedTextMessage) {
    const text = m.conversation ?? m.extendedTextMessage?.text ?? '';
    return /https?:\/\//i.test(text) ? 'link' : 'text';
  }
  if (m.imageMessage) return 'image';
  if (m.videoMessage) return 'video';
  if (m.audioMessage) return 'audio';
  if (m.documentMessage) return 'document';
  if (m.stickerMessage) return 'sticker';
  if (m.locationMessage) return 'location';
  if (m.contactMessage) return 'contact';
  return 'other';
}

/** Whatever readable text the message carries. Media captions count. */
function messageText(msg: WAMessage): string {
  const m = msg.message;
  if (!m) return '';
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    m.documentMessage?.fileName ??
    m.locationMessage?.address ??
    m.contactMessage?.displayName ??
    ''
  );
}

function timestampMs(msg: WAMessage): number {
  const t = msg.messageTimestamp;
  if (typeof t === 'number') return t * 1000;
  if (typeof t === 'bigint') return Number(t) * 1000;
  return Date.now();
}

/** How long a socket may sit with no qr/open/close before we call it stuck. */
export const CONNECT_TIMEOUT_MS = 30_000;
/** WhatsApp rotates the QR roughly every 20s; used only for the countdown. */
const QR_TTL_MS = 20_000;

/**
 * Replace the adv-secret field of a pairing QR payload.
 *
 * Format: ref,noiseKeyB64,identityKeyB64,advSecretB64,platformId — base64 can
 * contain '+' and '/' but never ',', so splitting on commas is safe. Anything
 * unexpected is returned untouched rather than corrupted.
 */
export function withCurrentAdvSecret(qr: string, advSecret: string): string {
  const parts = qr.split(',');
  if (parts.length < 5) return qr;
  parts[3] = advSecret;
  return parts.join(',');
}

/** Turns whatever Baileys threw into something a person can act on. */
export function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? 'unknown error');
  const msg = raw.replace(/^Error:\s*/, '');
  if (/Connection Terminated|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up/i.test(msg)) {
    return `${msg} — WhatsApp closed the connection. Usually a network, VPN or firewall blocking WebSockets.`;
  }
  if (/rate|429/i.test(msg)) return `${msg} — too many attempts; wait a few minutes.`;
  return msg;
}

/** Backoff bounds for reconnection. */
export const RECONNECT_MIN_MS = 2_000;
export const RECONNECT_MAX_MS = 5 * 60_000;

/**
 * Delay before reconnect attempt `attempt` (0-based), exponential with jitter.
 *
 * Exported so the schedule can be tested without a socket. The jitter half is
 * deliberate: every linked device on a machine waking at once would otherwise
 * retry in lockstep and hammer the same endpoint.
 */
export function reconnectDelay(attempt: number, rand = Math.random()): number {
  const base = Math.min(RECONNECT_MIN_MS * 2 ** attempt, RECONNECT_MAX_MS);
  return Math.round(base / 2 + rand * (base / 2));
}

export class WhatsAppArchive extends EventEmitter {
  private sock: Sock | null = null;
  private status: WhatsAppStatus = { state: 'idle', capturedThisSession: 0 };
  private stopping = false;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private connecting = false;
  private watchdog: NodeJS.Timeout | null = null;
  private captureFlush: NodeJS.Timeout | null = null;
  private lastQr: string | null = null;

  constructor(
    private readonly db: DB,
    private readonly authDir: string,
    private readonly mediaDir: string,
    /** Read on every message, so a settings change applies without reconnecting. */
    private readonly filter: () => CaptureFilter = () => DEFAULT_CAPTURE,
  ) {
    super();
  }

  getStatus(): WhatsAppStatus {
    return { ...this.status };
  }

  private setStatus(patch: Partial<WhatsAppStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.getStatus());
  }

  /**
   * Start linking.
   *
   * `force` tears down whatever is in flight first. Without it this used to
   * return silently whenever `connecting` was already true — and `connecting`
   * was only ever cleared by an 'open' or 'close' event, which a stalled
   * handshake never emits. The result was a Connect button that did nothing at
   * all, forever, with nothing on screen and nothing logged. Never return
   * silently from a user-initiated action.
   */
  async connect(force = false): Promise<void> {
    if (this.status.state === 'open' && !force) return;

    if (this.connecting) {
      if (!force) {
        this.emit('log', 'connect ignored: already connecting');
        return;
      }
      this.emit('log', 'connect forced: tearing down the in-flight socket');
      this.teardown();
    }

    this.connecting = true;
    this.stopping = false;
    this.clearRetry();
    this.lastQr = null;
    this.setStatus({
      state: 'connecting',
      lastError: undefined,
      qrDataUrl: undefined,
      pairingCode: undefined,
      attempt: this.attempt,
    });

    // A socket that neither connects nor closes is the worst case, because it
    // looks exactly like progress. Time it out explicitly.
    this.armWatchdog();

    try {
      await this.openSocket();
    } catch (err) {
      this.clearWatchdog();
      this.connecting = false;
      this.setStatus({ state: 'closed', lastError: describeError(err) });
      this.scheduleReconnect();
      throw err;
    }
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.status.state === 'qr' || this.status.state === 'open') return;
      this.emit('log', `no response from WhatsApp in ${CONNECT_TIMEOUT_MS / 1000}s`);
      this.teardown();
      this.setStatus({
        state: 'closed',
        lastError:
          `No response from WhatsApp after ${CONNECT_TIMEOUT_MS / 1000}s. ` +
          'Check the network, a VPN, or a firewall blocking WebSocket traffic.',
      });
      this.scheduleReconnect();
    }, CONNECT_TIMEOUT_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  /** Drop the socket without touching state the UI is showing. */
  private teardown(): void {
    this.clearWatchdog();
    this.connecting = false;
    try {
      this.sock?.end(undefined);
    } catch {
      /* already gone */
    }
    this.sock = null;
  }

  /** Link with an 8-character code typed into the phone instead of a QR scan. */
  async requestPairingCode(phoneNumber: string): Promise<string> {
    const digits = phoneNumber.replace(/[^0-9]/g, '');
    if (digits.length < 8) throw new Error('Enter your number in full international format.');
    if (!this.sock) throw new Error('Not connected yet — press Link device first.');
    if (this.status.state === 'open') throw new Error('Already linked.');
    const code = await this.sock.requestPairingCode(digits);
    this.emit('log', 'pairing code issued');
    this.setStatus({ pairingCode: code });
    return code;
  }

  private async openSocket(): Promise<void> {

    let state, saveCreds, version;
    try {
      ({ state, saveCreds } = await useMultiFileAuthState(this.authDir));
      ({ version } = await fetchLatestBaileysVersion());
    } catch (err) {
      // Offline at wake-up: fetchLatestBaileysVersion needs the network. Back
      // off and try again rather than throwing away the reconnect loop.
      this.connecting = false;
      this.setStatus({ state: 'closed', lastError: String(err) });
      this.scheduleReconnect();
      return;
    }

    const sock = makeWASocket({
      version,
      auth: state,
      // Identifying as a desktop client makes WhatsApp send a larger initial
      // history blob than the default browser identity does.
      // NOT Browsers.macOS('Desktop'). That identity combined with
      // syncFullHistory is rejected by WhatsApp during companion registration:
      // the Noise handshake completes, we send the pairing payload, and the
      // server closes the socket (428) before ever issuing a QR. Reproduced
      // 3/3 with that pair and 3/3 successful with this one, across Baileys
      // 6.17 and 7.0.0-rc14, on two network stacks. The original code chose the
      // macOS identity to coax a larger history blob out of WhatsApp; a bigger
      // blob is worth nothing if the device can never link.
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: true,
      // Two settings that keep this invisible to the people messaging you:
      // no online presence, and no blue ticks from the archive.
      markOnlineOnConnect: false,
      logger: pino({ level: 'silent' }) as never,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    // The other half of the companion_reg_refresh handling: rotate the secret
    // the server just retired, persist it, and re-render the QR already on
    // screen with the new value.
    sock.ws.on('CB:notification', (node: { attrs?: Record<string, string> }) => {
      if (node?.attrs?.type !== 'companion_reg_refresh') return;
      const rotated = randomBytes(32).toString('base64');
      state.creds.advSecretKey = rotated;
      void saveCreds();
      this.emit('log', 'companion_reg_refresh: rotated adv secret, re-rendering QR');
      if (this.lastQr) {
        const refreshed = withCurrentAdvSecret(this.lastQr, rotated);
        this.lastQr = refreshed;
        void toDataURL(refreshed, { margin: 1, width: 320 }).then((qrDataUrl) =>
          this.setStatus({ state: 'qr', qrDataUrl, qrExpiresAt: Date.now() + QR_TTL_MS }),
        );
      }
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      let { qr } = update;

      if (qr) {
        // Always advertise the CURRENT adv secret.
        //
        // WhatsApp retires an unpaired companion's registration material
        // mid-flow with <notification type='companion_reg_refresh'>. Baileys
        // captures advSecretKey once when the pairing flow starts and never
        // re-reads it, so every QR it renders after a refresh advertises a
        // secret the server has already discarded: the phone scans, reports
        // "couldn't link", and pair-success never arrives. That is upstream
        // issue #2737 — unfixed in 6.x, 7.0.0-rc14 and every published fork.
        //
        // The payload is [ref, noiseKey, identityKey, advSecret, platform], so
        // substituting field 3 is enough, and it keeps the same ref rather than
        // spending one from the pool the server allotted.
        qr = withCurrentAdvSecret(qr, state.creds.advSecretKey);
        // printQRInTerminal was removed from Baileys; the QR string is ours to
        // render. Imported statically: a dynamic import() resolved from inside
        // an asar archive is an avoidable risk on a path that only ever runs in
        // a packaged build.
        this.clearWatchdog();
        this.lastQr = qr;
        this.setStatus({
          state: 'qr',
          qrDataUrl: await toDataURL(qr, { margin: 1, width: 320 }),
          qrExpiresAt: Date.now() + QR_TTL_MS,
        });
      }

      if (connection === 'open') {
        this.clearWatchdog();
        this.connecting = false;
        this.attempt = 0; // a good connection resets the backoff
        // Keep a copy of credentials that are known to have worked. A partially
        // completed pairing leaves registered=false, and the next launch then
        // starts a fresh registration and overwrites the file — silently
        // destroying a session that was capturing fine.
        void this.backupCreds();
        this.setStatus({
          state: 'open',
          qrDataUrl: undefined,
          selfJid: sock.user?.id ? jidNormalizedUser(sock.user.id) : undefined,
        });
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
          ?.output?.statusCode;
        this.clearWatchdog();
        this.connecting = false;
        if (code === DisconnectReason.loggedOut) {
          // Revoked from the phone's Linked devices screen. Those credentials
          // are dead: reconnecting with them loops forever, and leaving them on
          // disk means the next launch retries a session WhatsApp has already
          // destroyed. Clear them so the app offers a QR instead of silently
          // failing — the archive itself is untouched.
          this.emit('log', 'unlinked from the phone; clearing dead credentials');
          void this.clearCredentials().then(() =>
            this.setStatus({
              state: 'logged_out',
              lastError:
                'This device was unlinked from your phone, so capture has stopped. ' +
                'Everything already archived is safe. Link again to resume.',
            }),
          );
          return;
        }
        this.setStatus({
          state: 'closed',
          lastError: describeError(lastDisconnect?.error ?? 'closed'),
          attempt: this.attempt,
        });
        this.scheduleReconnect();
      }
    });

    // Live traffic.
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;
      for (const msg of messages) await this.capture(msg);
    });

    // The one-time history blob pushed shortly after linking.
    sock.ev.on('messaging-history.set', async ({ messages, chats }) => {
      for (const c of chats ?? []) {
        upsertChat(this.db, {
          jid: c.id,
          name: c.name ?? null,
          isGroup: isJidGroup(c.id) ?? false,
          ts: Number(c.conversationTimestamp ?? 0) * 1000 || Date.now(),
        });
      }
      for (const msg of messages ?? []) await this.capture(msg);
      this.emit('history-synced', { messages: messages?.length ?? 0 });
    });
  }

  async disconnect(): Promise<void> {
    this.stopping = true;
    this.clearRetry();
    this.teardown();
    this.attempt = 0;
    this.setStatus({
      state: 'idle',
      qrDataUrl: undefined,
      pairingCode: undefined,
      lastError: undefined,
    });
  }

  /**
   * Stop capturing but keep the session, so resuming needs no QR.
   * This is the reversible one; unlink() is not.
   */
  async pause(): Promise<void> {
    this.stopping = true;
    this.clearRetry();
    this.teardown();
    this.emit('log', 'capture paused by user');
    this.setStatus({ state: 'idle', qrDataUrl: undefined, lastError: undefined });
  }

  /** Force a fresh connection attempt now, ignoring any pending backoff. */
  async refresh(): Promise<void> {
    this.emit('log', 'connection refresh requested');
    this.attempt = 0;
    this.teardown();
    await this.connect(true);
  }

  /**
   * Unlink: destroy the session entirely. Requires a new QR afterwards.
   *
   * Deliberately separate from pause(). Conflating them is how a user loses a
   * working link by clicking what they thought was a stop button.
   */
  async unlink(): Promise<void> {
    this.stopping = true;
    this.clearRetry();
    try {
      await this.sock?.logout();
    } catch {
      // Already gone, or offline. The local credentials still have to go.
    }
    this.teardown();
    await this.clearCredentials();
    this.attempt = 0;
    this.emit('log', 'unlinked by user; credentials cleared');
    this.setStatus({
      state: 'idle',
      qrDataUrl: undefined,
      pairingCode: undefined,
      lastError: undefined,
      selfJid: undefined,
    });
  }

  /** Remove session files, keeping the last-good snapshot for recovery. */
  private async clearCredentials(): Promise<void> {
    try {
      for (const name of await readdir(this.authDir)) {
        if (name === 'creds.json.last-good') continue;
        await rm(path.join(this.authDir, name), { force: true });
      }
    } catch {
      /* nothing to clear */
    }
  }

  /** Snapshot creds.json after a connection that actually worked. */
  private async backupCreds(): Promise<void> {
    try {
      await copyFile(
        path.join(this.authDir, 'creds.json'),
        path.join(this.authDir, 'creds.json.last-good'),
      );
      this.emit('log', 'saved a known-good credentials snapshot');
    } catch {
      /* first connection, or nothing to copy yet */
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * Exponential backoff with jitter.
   *
   * The previous flat 3s retry was fine on a desktop and pathological on a
   * laptop: wake with no wifi and it spins every 3 seconds indefinitely, which
   * burns battery and can get the account rate-limited. Jitter matters because
   * every linked device on the machine would otherwise retry in lockstep.
   */
  private scheduleReconnect(): void {
    if (this.stopping) return;
    this.clearRetry();
    const delay = reconnectDelay(this.attempt);
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
    this.emit('reconnect-scheduled', { delay, attempt: this.attempt });
  }

  /**
   * Try again immediately, resetting the backoff.
   *
   * Called when the machine wakes or the network comes back: waiting out a
   * five-minute backoff when we have positive evidence the situation changed is
   * five minutes of messages we would never see.
   */
  reconnectNow(): void {
    if (this.stopping) return;
    if (this.status.state === 'open' || this.status.state === 'logged_out') return;
    this.attempt = 0;
    this.clearRetry();
    void this.connect();
  }

  /** Persist one message. Media is hashed and stored once per unique file. */
  private async capture(msg: WAMessage): Promise<void> {
    const jid = msg.key.remoteJid;
    if (!jid || jid === 'status@broadcast') return;
    if (!msg.message) return;

    const id = `${jid}:${msg.key.id}`;
    const ts = timestampMs(msg);
    const isGroup = isJidGroup(jid) ?? false;

    upsertChat(this.db, { jid, name: msg.pushName ?? null, isGroup, ts });

    const kind = messageKind(msg);

    // Checked BEFORE the download. Excluding a media type has to mean the bytes
    // never arrive, not that they are fetched and then ignored — otherwise the
    // setting saves nothing that matters.
    if (!shouldCapture(this.filter(), jid, kind)) {
      this.emit('filtered', { chatJid: jid, kind });
      return;
    }

    let mediaSha: string | null = null;

    if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'document') {
      try {
        mediaSha = await this.storeMedia(msg, kind);
      } catch {
        // A failed download must never lose the message row. The text and
        // metadata are still worth having; enrichment can retry the file later.
        mediaSha = null;
      }
    }

    const raw = messageText(msg);
    insertMessage(this.db, {
      id,
      chat_jid: jid,
      sender_jid: msg.key.participant ? jidNormalizedUser(msg.key.participant) : jid,
      sender_name: msg.pushName ?? null,
      ts,
      from_me: msg.key.fromMe ? 1 : 0,
      kind,
      body_raw: raw,
      body_ar: foldForSearch(raw),
      body_stem: stemsForSearch(raw),
      body_en: '',
      media_sha256: mediaSha,
      quoted_id: msg.message.extendedTextMessage?.contextInfo?.stanzaId ?? null,
      // Plain text with no Arabic and no media needs nothing further.
      enrich_state: kind === 'text' && !raw ? 'skipped' : 'pending',
    });

    // The initial history blob arrives as thousands of messages in a burst.
    // Emitting a status update per message floods IPC and the renderer for no
    // benefit — the count only has to look live, so coalesce it.
    this.status.capturedThisSession += 1;
    if (!this.captureFlush) {
      this.captureFlush = setTimeout(() => {
        this.captureFlush = null;
        this.setStatus({});
      }, 400);
    }
    this.emit('captured', { id, chatJid: jid, kind });
  }

  /**
   * Download once, keyed by content hash.
   *
   * The same forwarded video reaches you from five groups. Hashing the bytes
   * means it occupies one file and earns one transcription, no matter how many
   * messages point at it.
   */
  private async storeMedia(msg: WAMessage, kind: MessageKind): Promise<string> {
    const buffer = (await downloadMediaMessage(msg, 'buffer', {})) as Buffer;
    const sha = createHash('sha256').update(buffer).digest('hex');

    const { isNew } = rememberMedia(this.db, {
      sha256: sha,
      kind,
      byteSize: buffer.byteLength,
      relPath: path.join(kind, `${sha}.bin`),
    });

    if (isNew) {
      const dir = path.join(this.mediaDir, kind);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${sha}.bin`), buffer, { mode: 0o600 });
    }
    return sha;
  }
}
