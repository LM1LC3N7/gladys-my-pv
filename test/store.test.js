import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOUR } from '../src/constants.js';
import { normalizeMemory } from '../src/store.js';

const NOW = Date.UTC(2026, 9, 20);
const FP = Array.from({ length: 32 }, () => 'AB').join(':');

test('the state of /data is repaired and bounded', () => {
  assert.deepEqual(normalizeMemory(null, NOW), {
    pause: null,
    last: null,
    block: null,
    pins: Object.create(null),
    serials: Object.create(null),
  });
  const memory = normalizeMemory(
    {
      pause: { target: 'cloud:2001001234567890', until: NOW + 100 * HOUR },
      last: { target: 'cloud:2001001234567890', at: NOW + HOUR, ok: true },
      block: { kind: 'auth', target: 'local:192.168.1.80:443', until: NOW + 100 * HOUR },
      pins: { 'local:192.168.1.80:443': FP, 'local:x:1': 'nope', __proto__: { a: 1 } },
      serials: { 'local:192.168.1.80:80': '2001001234567890', bad: '1' },
    },
    NOW,
  );
  assert.equal(memory.pause.until, NOW + 6 * HOUR);
  assert.deepEqual(
    memory.last,
    { target: 'cloud:2001001234567890', at: NOW, ok: true },
    'never in the future',
  );
  assert.equal(
    normalizeMemory({ pause: { until: NOW + HOUR } }, NOW).pause,
    null,
    'a pause names its target',
  );
  assert.equal(memory.block.until, NOW + HOUR);
  assert.deepEqual({ ...memory.pins }, { 'local:192.168.1.80:443': FP });
  assert.deepEqual({ ...memory.serials }, { 'local:192.168.1.80:80': '2001001234567890' });
  assert.equal(normalizeMemory({ pause: { until: NOW - 1 } }, NOW).pause, null);
  assert.equal(
    normalizeMemory({ block: { kind: 'other', target: 'cloud:2001001234567890', until: NOW } }, NOW)
      .block,
    null,
  );
  assert.equal({}.a, undefined);
});
