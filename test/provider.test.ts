import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_PRESETS, isLocalEndpoint, presetById } from '../src/shared/providers.js';

/**
 * The provider catalogue is data, not code paths — "bring your own" must be the
 * same machinery as a built-in, or it will rot.
 */

test('every preset is internally consistent', () => {
  for (const p of PROVIDER_PRESETS) {
    assert.ok(p.id && p.label, 'id and label required');
    assert.ok(p.kind === 'anthropic' || p.kind === 'openai', `${p.id}: bad kind`);
    if (p.baseUrl) assert.doesNotThrow(() => new URL(p.baseUrl), `${p.id}: bad baseUrl`);
    // A preset with no baseUrl relies on the SDK default, which only exists for
    // the vendor's own protocol.
    if (!p.baseUrl && p.id !== 'custom') assert.equal(p.kind, 'anthropic', `${p.id}`);
  }
});

test('preset ids are unique', () => {
  const ids = PROVIDER_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('Cohere is configured against its OpenAI-compatible endpoint', () => {
  // Its native API is a different shape; pointing the Anthropic client at it
  // returns 404s. This is the exact mistake the preset exists to prevent.
  const cohere = presetById('cohere');
  assert.ok(cohere);
  assert.equal(cohere.kind, 'openai');
  assert.match(cohere.baseUrl, /compatibility\/v1$/);
});

test('local runners are marked local and keyless', () => {
  for (const id of ['ollama', 'lmstudio']) {
    const p = presetById(id);
    assert.ok(p, id);
    assert.equal(p.local, true, `${id} should be marked local`);
    assert.equal(p.needsKey, false, `${id} should not require a key`);
    assert.ok(isLocalEndpoint(p.baseUrl), `${id} baseUrl should be loopback`);
  }
});

test('isLocalEndpoint only trusts loopback', () => {
  assert.equal(isLocalEndpoint('http://127.0.0.1:11434/v1'), true);
  assert.equal(isLocalEndpoint('http://localhost:1234/v1'), true);
  assert.equal(isLocalEndpoint('https://api.openai.com/v1'), false);
  assert.equal(isLocalEndpoint('https://api.cohere.ai/compatibility/v1'), false);
  // Must not be fooled by a hostname that merely contains "localhost".
  assert.equal(isLocalEndpoint('https://localhost.evil.com/v1'), false);
  assert.equal(isLocalEndpoint(''), false);
  assert.equal(isLocalEndpoint('not a url'), false);
});
