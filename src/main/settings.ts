import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
}

const DEFAULTS: Settings = { openAtLogin: true, lastWorkspace: null };

let cache: Settings | null = null;

const file = (): string => path.join(app.getPath('userData'), 'settings.json');

export function getSettings(): Settings {
  if (cache) return cache;
  try {
    if (existsSync(file())) {
      cache = { ...DEFAULTS, ...(JSON.parse(readFileSync(file(), 'utf8')) as Partial<Settings>) };
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
