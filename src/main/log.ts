import { app } from 'electron';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * A log file the user can actually find and send back.
 *
 * A packaged Electron app has no console. Every diagnosis in this project so far
 * needed output nobody running the installer could ever see, which is why a
 * total failure to connect looked identical to "still connecting".
 */
const MAX_BYTES = 2_000_000;

let logFile: string | null = null;

export function logPath(): string {
  if (!logFile) {
    const dir = path.join(app.getPath('userData'), 'logs');
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* fall through; write will fail and be swallowed */
    }
    logFile = path.join(dir, 'wa-askable.log');
  }
  return logFile;
}

export function log(scope: string, message: string, extra?: unknown): void {
  const line =
    `${new Date().toISOString()} [${scope}] ${message}` +
    (extra === undefined ? '' : ` ${safe(extra)}`);
  // Keep the terminal behaviour for dev runs.
  console.log(line);
  try {
    const file = logPath();
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`);
    } catch {
      /* no file yet */
    }
    appendFileSync(file, line + '\n');
  } catch {
    // Logging must never be the reason the app fails.
  }
}

function safe(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 600 ? `${s.slice(0, 600)}…` : s;
  } catch {
    return String(v);
  }
}
