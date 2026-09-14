import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as baileys from '@whiskeysockets/baileys';

/**
 * Regression guard for the bug that made connecting hang forever.
 *
 * Baileys is CommonJS with no real default export. Under `tsx` (how the old
 * server ran) the interop produced a callable default, so
 * `import makeWASocket from '@whiskeysockets/baileys'` worked. Under Electron's
 * real ESM loader the same import yields the module NAMESPACE OBJECT, and
 * calling it throws "makeWASocket is not a function" — after the status had
 * already been set to 'connecting', so the UI span forever with an empty auth/
 * directory and no error shown.
 *
 * typecheck cannot catch this: the types declare a default export.
 */

test('makeWASocket is available as a named export and is callable', () => {
  assert.equal(typeof baileys.makeWASocket, 'function');
});

test('whatsapp.ts does not default-import Baileys', () => {
  // Asserted against the SOURCE, not the loaded module, because CJS interop is
  // runtime-dependent: under Bun `baileys.default` IS callable, under Electron's
  // ESM loader it is not. Checking the module at runtime would therefore pass
  // here in `bun test` and still ship the bug — which is exactly what happened.
  const raw = readFileSync(new URL('../src/core/whatsapp.ts', import.meta.url), 'utf8');
  // Strip comments first — the file explains this very bug in prose, and the
  // naive check matched its own warning.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(
    src,
    /import\s+makeWASocket\s*(,|from)/,
    'default-importing Baileys works under bun/tsx but throws "makeWASocket is not a ' +
      'function" under Electron. Use the named import.',
  );
  assert.match(src, /import\s*\{[^}]*\bmakeWASocket\b/s, 'expected a named makeWASocket import');
});

test('the other named imports connect() relies on still exist', () => {
  for (const name of [
    'DisconnectReason',
    'downloadMediaMessage',
    'isJidGroup',
    'jidNormalizedUser',
    'useMultiFileAuthState',
    'Browsers',
    'fetchLatestBaileysVersion',
  ] as const) {
    assert.ok(name in baileys, `missing Baileys export: ${name}`);
  }
});
