import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usedCitations, type Citation } from '../src/core/enrich.js';

/**
 * A fabricated citation is worse than no citation: it manufactures confidence in
 * a message that may not exist, and this archive is the kind of thing people
 * make decisions from ("you said you'd pay on the 3rd"). So the answer may only
 * cite numbers a tool actually returned.
 */
const cite = (n: number, id: string): Citation => ({
  n, id, chatJid: 'c@s.whatsapp.net', chatName: 'C', senderName: 'S', ts: 1, snippet: 's',
});
const registry = new Map<number, Citation>([
  [1, cite(1, 'm1')],
  [2, cite(2, 'm2')],
]);

test('keeps citations the answer actually uses', () => {
  const out = usedCitations('He agreed on Tuesday [1] and paid [2].', registry);
  assert.deepEqual(out.map((c) => c.n), [1, 2]);
});

test('drops numbers no tool returned — the hallucination case', () => {
  const out = usedCitations('He said so [7] and also [99].', registry);
  assert.deepEqual(out, []);
});

test('keeps the real ones while dropping the invented ones', () => {
  const out = usedCitations('Both [1] and [42] agree.', registry);
  assert.deepEqual(out.map((c) => c.n), [1]);
});

test('deduplicates a citation used several times', () => {
  const out = usedCitations('[1] and later [1] again, plus [2].', registry);
  assert.deepEqual(out.map((c) => c.n), [1, 2]);
});

test('returns them in citation order, not order of appearance', () => {
  const out = usedCitations('Later point [2], earlier point [1].', registry);
  assert.deepEqual(out.map((c) => c.n), [1, 2]);
});

test('an uncited answer yields no sources', () => {
  assert.deepEqual(usedCitations('I could not find anything.', registry), []);
});

test('ignores bracketed text that is not a citation', () => {
  assert.deepEqual(usedCitations('He wrote [see attached] about it.', registry), []);
});
