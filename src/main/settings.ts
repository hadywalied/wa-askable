import { app, safeStorage } from 'electron';
import type { ProviderKind } from '../shared/providers.js';
import { DEFAULT_CAPTURE, type CaptureFilter } from '../shared/capture.js';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Small persisted settings store.
 *
 * Phase 3 extends this with the AI provider config and moves the API key into
 * safeStorage. Deliberately plain JSON for now — nothing in here is a secret,
 * and a key must never be written to it. See PLAN.md §4 Phase 3.
 */
export interface Settings {
  /** Launch when the user logs in. Capture only happens while we are running. */
  openAtLogin: boolean;
  /** Last workspace, reopened automatically so capture resumes without a click. */
  lastWorkspace: string | null;
  /** Model used for glossing and answering. Not a secret. */
  model: string;
  /** Which preset the user picked. Presentation only — kind/baseUrl decide behaviour. */
  providerId: string;
  /** Which wire protocol the endpoint speaks. */
  providerKind: ProviderKind;
  /**
   * Base URL of the API. Empty means the SDK's own default.
   * Point it at a local agent (openclaw, a proxy, an offline gateway) to keep
   * message text on this machine while still getting glosses and answers.
   */
  baseUrl: string;
  /** Which chats and which media types are worth archiving. */
  capture: CaptureFilter;
}

const DEFAULTS: Settings = {
  openAtLogin: true,
  lastWorkspace: null,
  model: 'claude-sonnet-5',
  providerId: 'anthropic',
  providerKind: 'anthropic',
  baseUrl: '',
  capture: DEFAULT_CAPTURE,
};

let cache: Settings | null = null;

const file = (): string => path.join(app.getPath('userData'), 'settings.json');

export function getSettings(): Settings {
  if (cache) return cache;
  try {
    if (existsSync(file())) {
      const stored = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Settings>;
      cache = {
        ...DEFAULTS,
        ...stored,
        // Merge rather than replace: a filter written by an older version is
        // missing any newly added source or media key, and a missing key must
        // not silently mean "do not capture".
        capture: {
          sources: { ...DEFAULTS.capture.sources, ...(stored.capture?.sources ?? {}) },
          media: { ...DEFAULTS.capture.media, ...(stored.capture?.media ?? {}) },
        },
      };
      return cache;
    }
  } catch {
    // A corrupt settings file must not stop the app from capturing.
  }
  cache = { ...DEFAULTS };
  return cache;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  cache = { ...getSettings(), ...patch };
  try {
    writeFileSync(file(), JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch {
    /* non-fatal */
  }
  return cache;
}

/**
 * Apply the autostart preference to the OS.
 *
 * setLoginItemSettings is macOS and Windows only. Linux has no equivalent API,
 * so we write an XDG autostart desktop entry by hand. Returns whether autostart
 * is actually in effect, because silently failing here means the user believes
 * the archive is capturing when it is not.
 */
export function applyAutostart(enabled: boolean): boolean {
  if (process.platform === 'linux') {
    return applyLinuxAutostart(enabled);
  }
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
    return app.getLoginItemSettings().openAtLogin === enabled;
  } catch {
    return false;
  }
}

function applyLinuxAutostart(enabled: boolean): boolean {
  try {
    const dir = path.join(app.getPath('home'), '.config', 'autostart');
    const entry = path.join(dir, 'wa-askable.desktop');
    if (!enabled) {
      if (existsSync(entry)) writeFileSync(entry, '');
      return false;
    }
    const { mkdirSync, rmSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(dir, { recursive: true });
    if (existsSync(entry)) rmSync(entry);
    writeFileSync(
      entry,
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=wa-askable',
        'Comment=Keeps the WhatsApp archive capturing in the background',
        `Exec=${process.execPath} --hidden`,
        'X-GNOME-Autostart-enabled=true',
        'Terminal=false',
        '',
      ].join('\n'),
      { mode: 0o644 },
    );
    return true;
  } catch {
    return false;
  }
}


// --- the API key ------------------------------------------------------------

/**
 * The key is a secret and never goes in settings.json. It is encrypted with the
 * OS keystore (Keychain / DPAPI / libsecret) and written as opaque bytes.
 *
 * Electron 46 removes the synchronous safeStorage API, so this uses the async
 * one throughout: isAsyncEncryptionAvailable / encryptStringAsync /
 * decryptStringAsync (which resolves to { result }).
 */
/**
 * Where the AI configuration lives.
 *
 * In the WORKSPACE, not app settings, and encrypted. The workspace is already
 * the one directory holding everything — database, media, session keys — so the
 * provider that reads those messages belongs with them: move the workspace to
 * another machine and its configuration comes along; point the app at a
 * different archive and you are not silently still talking to the last one's
 * provider.
 *
 * Falls back to userData when no workspace is open, so the key survives being
 * set before an archive exists.
 */
let workspaceDir: string | null = null;

export function setSecretLocation(dir: string | null): void {
  if (workspaceDir === dir) return;
  workspaceDir = dir;
  cachedProvider = null;
}

const secretFile = (): string =>
  path.join(workspaceDir ?? app.getPath('userData'), 'ai-config.bin');

/** Pre-workspace location, migrated on first open. */
const legacySecretFile = (): string => path.join(app.getPath('userData'), 'secret.bin');

/**
 * Session-only fallback. If the OS has no keystore available — a Linux box with
 * no libsecret provider, typically — we hold the key in memory for this run
 * rather than writing a secret to disk in plaintext. The UI is told, so the user
 * finds out now instead of discovering it after a restart.
 */
let memoryKey: string | undefined;
/** Provider settings decrypted from the workspace blob. */
let cachedProvider: ProviderConfigBlob | null = null;

export interface ProviderConfigBlob {
  apiKey?: string;
  providerId?: string;
  providerKind?: ProviderKind;
  baseUrl?: string;
  model?: string;
}

async function readBlob(): Promise<ProviderConfigBlob> {
  if (cachedProvider) return cachedProvider;
  for (const file of [secretFile(), legacySecretFile()]) {
    try {
      if (!existsSync(file)) continue;
      if (!(await encryptionAvailable())) continue;
      const { result } = await safeStorage.decryptStringAsync(readFileSync(file));
      const parsed = JSON.parse(result) as ProviderConfigBlob | string;
      // The pre-0.5 file held the bare key rather than a config object.
      cachedProvider = typeof parsed === 'string' ? { apiKey: parsed } : parsed;
      return cachedProvider;
    } catch {
      // A blob encrypted under another OS user cannot be read back. Behaving as
      // unconfigured is better than refusing to start.
    }
  }
  cachedProvider = {};
  return cachedProvider;
}

async function writeBlob(patch: ProviderConfigBlob): Promise<boolean> {
  const next = { ...(await readBlob()), ...patch };
  cachedProvider = next;
  if (!(await encryptionAvailable())) return false;
  try {
    const blob = await safeStorage.encryptStringAsync(JSON.stringify(next));
    writeFileSync(secretFile(), blob, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Provider settings stored with the archive, if any. */
export async function getProviderConfig(): Promise<ProviderConfigBlob> {
  return readBlob();
}

export async function setProviderConfig(patch: ProviderConfigBlob): Promise<boolean> {
  return writeBlob(patch);
}

export async function encryptionAvailable(): Promise<boolean> {
  try {
    return await safeStorage.isAsyncEncryptionAvailable();
  } catch {
    return false;
  }
}

export async function getApiKey(): Promise<string | undefined> {
  if (memoryKey) return memoryKey;
  // An env var still wins, so a dev shell keeps working exactly as before.
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  return (await readBlob()).apiKey?.trim() || undefined;
}

export interface KeySaveResult {
  ok: boolean;
  /** False when the key is only held for this session. */
  persisted: boolean;
  message?: string;
}

export async function setApiKey(key: string | null): Promise<KeySaveResult> {
  if (key === null || key.trim() === '') {
    memoryKey = undefined;
    await writeBlob({ apiKey: undefined });
    try {
      // Clear the pre-0.5 file too, or it would be picked up again on restart.
      if (existsSync(legacySecretFile())) rmSync(legacySecretFile());
    } catch {
      /* non-fatal */
    }
    return { ok: true, persisted: false };
  }

  const trimmed = key.trim();
  memoryKey = trimmed;

  if (!(await encryptionAvailable())) {
    return {
      ok: true,
      persisted: false,
      message:
        'No OS keystore is available, so the key is kept for this session only and will be ' +
        'forgotten when you quit. It was not written to disk in plaintext.',
    };
  }
  const ok = await writeBlob({ apiKey: trimmed });
  return ok
    ? { ok: true, persisted: true }
    : {
        ok: true,
        persisted: false,
        message: 'Key kept for this session only — it could not be written securely.',
      };
}

export async function hasApiKey(): Promise<boolean> {
  return (await getApiKey()) !== undefined;
}
