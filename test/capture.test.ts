import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CAPTURE,
  mediaOf,
  shouldCapture,
  sourceOf,
  toggleCapture,
  type CaptureFilter,
} from '../src/shared/capture.js';

const clone = (): CaptureFilter => structuredClone(DEFAULT_CAPTURE);

test('a toggle changes only the key it names', () => {
  // Reported as: ticking "Direct chats" saved "Broadcast lists" instead.
  const r = toggleCapture(clone(), 'sources', 'direct', false);
  assert.equal(r.ok, true);
  assert.equal(r.filter.sources.direct, false);
  assert.equal(r.filter.sources.group, DEFAULT_CAPTURE.sources.group);
  assert.equal(r.filter.sources.broadcast, DEFAULT_CAPTURE.sources.broadcast);
  assert.deepEqual(r.filter.media, DEFAULT_CAPTURE.media);
});

test('enabling broadcasts leaves the other sources alone', () => {
  const r = toggleCapture(clone(), 'sources', 'broadcast', true);
  assert.equal(r.filter.sources.broadcast, true);
  assert.equal(r.filter.sources.direct, true);
});

test('the input filter is never mutated', () => {
  const original = clone();
  toggleCapture(original, 'sources', 'direct', false);
  assert.deepEqual(original, DEFAULT_CAPTURE, 'toggle must return a new filter, not edit in place');
});

test('turning off the last source is refused', () => {
  // broadcast is already off by default, so after clearing direct and group,
  // community is the only one left and removing it must be refused.
  let f: CaptureFilter = clone();
  f = toggleCapture(f, 'sources', 'direct', false).filter;
  f = toggleCapture(f, 'sources', 'group', false).filter;
  assert.deepEqual(
    Object.entries(f.sources).filter(([, on]) => on).map(([k]) => k),
    ['community'],
    'exactly one source should remain',
  );

  const r = toggleCapture(f, 'sources', 'community', false);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /at least one/i);
  assert.equal(r.filter.sources.community, true, 'the refused change must not be applied');
});

test('turning off the last message type is refused', () => {
  let f: CaptureFilter = clone();
  for (const k of ['image', 'video', 'audio', 'document'] as const) {
    f = toggleCapture(f, 'media', k, false).filter;
  }
  const r = toggleCapture(f, 'media', 'text', false);
  assert.equal(r.ok, false);
  assert.ok(Object.values(r.filter.media).some(Boolean));
});

test('JIDs classify to the right source', () => {
  assert.equal(sourceOf('201224698687@s.whatsapp.net'), 'direct');
  assert.equal(sourceOf('120363429393479322@g.us'), 'group');
  assert.equal(sourceOf('120363152913971803@newsletter'), 'community');
  assert.equal(sourceOf('status@broadcast'), 'broadcast');
  assert.equal(sourceOf('206592221913311@lid'), 'direct');
});

test('kinds without a toggle of their own ride with text', () => {
  for (const k of ['text', 'link', 'location', 'contact', 'other']) {
    assert.equal(mediaOf(k), 'text', k);
  }
  assert.equal(mediaOf('image'), 'image');
  assert.equal(mediaOf('audio'), 'audio');
});

test('shouldCapture honours both axes', () => {
  const f = clone();
  assert.equal(shouldCapture(f, '1@s.whatsapp.net', 'text'), true);
  assert.equal(shouldCapture(f, '1@s.whatsapp.net', 'sticker'), false, 'stickers off by default');
  assert.equal(shouldCapture(f, 'status@broadcast', 'text'), false, 'broadcasts off by default');
  const noGroups = toggleCapture(f, 'sources', 'group', false).filter;
  assert.equal(shouldCapture(noGroups, '1@g.us', 'text'), false);
});
