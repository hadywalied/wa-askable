import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  reconnectDelay,
} from '../src/core/whatsapp.js';

/**
 * The old code retried on a flat 3s timer. A laptop that wakes with no wifi
 * would spin on that forever, burning battery and risking rate-limiting.
 */

test('first retry is prompt', () => {
  assert.ok(reconnectDelay(0, 0) >= RECONNECT_MIN_MS / 2);
  assert.ok(reconnectDelay(0, 1) <= RECONNECT_MIN_MS);
});

test('delay grows exponentially', () => {
  const mid = (a: number) => reconnectDelay(a, 0.5);
  assert.ok(mid(1) > mid(0));
  assert.ok(mid(4) > mid(3));
  assert.ok(mid(3) >= mid(0) * 4);
});

test('delay is capped so it never runs away', () => {
  for (const attempt of [10, 20, 50, 1000]) {
    assert.ok(reconnectDelay(attempt, 1) <= RECONNECT_MAX_MS, `attempt ${attempt}`);
  }
});

test('jitter spreads retries across half the window', () => {
  const low = reconnectDelay(6, 0);
  const high = reconnectDelay(6, 1);
  assert.ok(high > low, 'jitter must vary the delay');
  assert.ok(low >= high / 2 - 1, 'but never below half the base');
});

test('delay is always a positive integer', () => {
  for (let a = 0; a < 12; a++) {
    const d = reconnectDelay(a, Math.random());
    assert.ok(Number.isInteger(d) && d > 0, `attempt ${a} -> ${d}`);
  }
});
