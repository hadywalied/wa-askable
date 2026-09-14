import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Regression guard for the bug that made linking impossible.
 *
 * `Browsers.macOS('Desktop')` together with `syncFullHistory: true` is rejected
 * by WhatsApp during companion registration — the socket is closed with 428
 * after the Noise handshake and before any QR is issued. Reproduced 3/3 with
 * that combination and 3/3 successful without it, on Baileys 6.17 and
 * 7.0.0-rc14, on two network stacks.
 *
 * Asserted against the source because there is no way to check it without a
 * live WhatsApp connection, and by the time a human notices, linking is simply
 * broken with no error that points here.
 */
const src = readFileSync(new URL('../src/core/whatsapp.ts', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('does not use the macOS Desktop browser identity', () => {
  assert.doesNotMatch(
    src,
    /Browsers\.macOS\(/,
    'Browsers.macOS(...) + syncFullHistory is refused by WhatsApp at registration — no QR is ever issued.',
  );
});

test('still asks for history, which is the whole point of the identity choice', () => {
  assert.match(src, /syncFullHistory:\s*true/);
});

test('a browser identity is set explicitly', () => {
  assert.match(src, /browser:\s*Browsers\.\w+\(/);
});

// --- companion_reg_refresh ---------------------------------------------------

import { withCurrentAdvSecret } from '../src/core/whatsapp.js';

/**
 * WhatsApp retires an unpaired companion's registration material mid-flow with
 * <notification type='companion_reg_refresh'>. Baileys reads advSecretKey once
 * when the pairing flow begins, so every QR after a refresh advertises a secret
 * the server already discarded — the phone says "couldn't link" and
 * pair-success never arrives (upstream issue #2737, unfixed everywhere).
 *
 * We substitute the field ourselves. These guard the substitution, since
 * getting it wrong produces a QR that simply never works.
 */
test('replaces only the adv secret, preserving ref and keys', () => {
  const qr = 'REF123,NOISEKEY,IDENTITY,OLDSECRET,49';
  assert.equal(withCurrentAdvSecret(qr, 'NEWSECRET'), 'REF123,NOISEKEY,IDENTITY,NEWSECRET,49');
});

test('keeps the same ref — a refresh must not spend one from the pool', () => {
  const out = withCurrentAdvSecret('REF123,N,I,OLD,49', 'NEW');
  assert.equal(out.split(',')[0], 'REF123');
});

test('handles base64 secrets containing + and / (but never a comma)', () => {
  const secret = 'ab+/cd==';
  const out = withCurrentAdvSecret('R,N,I,OLD,49', secret);
  assert.equal(out.split(',')[3], secret);
  assert.equal(out.split(',').length, 5);
});

test('leaves an unexpected payload untouched rather than corrupting it', () => {
  assert.equal(withCurrentAdvSecret('garbage', 'NEW'), 'garbage');
  assert.equal(withCurrentAdvSecret('a,b,c', 'NEW'), 'a,b,c');
});

test('the refresh notification is actually subscribed to', () => {
  assert.match(src, /CB:notification/);
  assert.match(src, /companion_reg_refresh/);
  assert.match(src, /advSecretKey\s*=/, 'must rotate the secret, not just re-render');
});

test('known-good credentials are snapshotted', () => {
  // A half-completed pairing leaves registered=false; the next launch then
  // re-registers and overwrites creds.json, destroying a working session.
  assert.match(src, /creds\.json\.last-good/);
});
