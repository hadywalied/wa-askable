import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * Post-install: fetch Electron's binary, then rebuild native modules.
 *
 * Why this is a script and not a one-line `&&` chain in package.json:
 *
 *  - Bun does not reliably run Electron's own postinstall (the one that
 *    downloads the ~100MB binary) even with "electron" in trustedDependencies,
 *    so it has to be invoked explicitly.
 *  - But Bun may also run THIS root script before it has finished linking
 *    node_modules/electron, in which case the explicit invocation cannot find
 *    install.js and the whole install aborts with a confusing MODULE_NOT_FOUND —
 *    leaving a half-populated tree. So every step is guarded, and a missing
 *    piece is a warning telling you to run `bun run setup`, never a hard fail.
 *
 * `bun run setup` runs the same steps and DOES fail loudly, which is what you
 * want when fixing an install rather than performing one.
 */
const strict = process.argv.includes('--strict');
const root = process.cwd();

function step(label, fn) {
  try {
    fn();
    console.log(`[setup] ${label}: ok`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (strict) {
      console.error(`[setup] ${label}: FAILED — ${msg}`);
      process.exit(1);
    }
    console.warn(`[setup] ${label}: skipped — ${msg}`);
    console.warn('[setup] run `bun run setup` once install finishes.');
  }
}

step('electron binary', () => {
  const installer = path.join(root, 'node_modules', 'electron', 'install.js');
  if (!existsSync(installer)) throw new Error('node_modules/electron not linked yet');
  if (existsSync(path.join(root, 'node_modules', 'electron', 'dist', 'electron'))) {
    return; // already downloaded
  }
  execFileSync(process.execPath, [installer], { stdio: 'inherit', cwd: root });
});

step('native modules', () => {
  // Resolve the package's own CLI entry rather than node_modules/.bin. The .bin
  // shim is extensionless on POSIX but .cmd/.ps1 on Windows, so existsSync on
  // the bare name is false there and the Windows CI job failed with
  // "@electron/rebuild not linked yet" while the package was sitting right
  // there. Running the JS through node works identically on all three.
  const pkgDir = path.join(root, 'node_modules', '@electron', 'rebuild');
  if (!existsSync(pkgDir)) throw new Error('@electron/rebuild not linked yet');
  if (!existsSync(path.join(root, 'node_modules', 'better-sqlite3'))) {
    throw new Error('better-sqlite3 not linked yet');
  }
  const binField = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).bin;
  const rel = typeof binField === 'string' ? binField : binField['electron-rebuild'];
  execFileSync(process.execPath, [path.join(pkgDir, rel), '-f', '-m', '.', '-w', 'better-sqlite3'], {
    stdio: 'inherit',
    cwd: root,
  });
});
