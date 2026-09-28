// Seeded RNG (CONTRACT §2): mulberry32, stateless over { seed, counter }.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng, peekFloat, nextFloat, nextInt, rollDice, shuffle } from '../engine/index.js';

// Reference implementation copied from the contract.
function floatAt(seed, n) {
  let a = (seed + Math.imul(n, 0x6D2B79F5)) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

test('makeRng normalises the seed and starts at counter 0', () => {
  assert.deepEqual(makeRng(42), { seed: 42, counter: 0 });
  assert.deepEqual(makeRng(-1), { seed: 4294967295, counter: 0 });
});

test('nextFloat follows the contract formula and advances the counter', () => {
  const rng = makeRng(123456);
  for (let n = 1; n <= 20; n++) {
    assert.equal(peekFloat(rng, n), floatAt(123456, n));
    const f = nextFloat(rng);
    assert.equal(f, floatAt(123456, n));
    assert.ok(f >= 0 && f < 1);
    assert.equal(rng.counter, n);
  }
});

test('peekFloat is pure', () => {
  const rng = { seed: 7, counter: 3 };
  peekFloat(rng, 4);
  assert.deepEqual(rng, { seed: 7, counter: 3 });
});

test('nextInt and rollDice are built on nextFloat', () => {
  const a = { seed: 99, counter: 10 };
  const b = { seed: 99, counter: 10 };
  const [d1, d2] = rollDice(a);
  assert.equal(a.counter, 12);
  assert.equal(d1, nextInt(b, 1, 6));
  assert.equal(d2, nextInt(b, 1, 6));
  assert.equal(d1, 1 + Math.floor(floatAt(99, 11) * 6));
  assert.equal(d2, 1 + Math.floor(floatAt(99, 12) * 6));
});

test('rollDice covers all faces and stays in range', () => {
  const rng = makeRng(2024);
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    for (const d of rollDice(rng)) {
      assert.ok(Number.isInteger(d) && d >= 1 && d <= 6);
      seen.add(d);
    }
  }
  assert.equal(seen.size, 6);
});

test('shuffle returns a new permutation deterministically', () => {
  const input = [...Array(16).keys()];
  const r1 = makeRng(5);
  const r2 = makeRng(5);
  const s1 = shuffle(r1, input);
  const s2 = shuffle(r2, input);
  assert.deepEqual(s1, s2);
  assert.notEqual(s1, input);
  assert.deepEqual(input, [...Array(16).keys()], 'input untouched');
  assert.deepEqual([...s1].sort((x, y) => x - y), input);
  assert.equal(r1.counter, 15, 'one nextInt per i = len-1..1');

  // Fisher–Yates from the end, exactly as specified.
  const expected = [...input];
  for (let i = expected.length - 1, n = 1; i >= 1; i--, n++) {
    const j = Math.floor(floatAt(5, n) * (i + 1));
    [expected[i], expected[j]] = [expected[j], expected[i]];
  }
  assert.deepEqual(s1, expected);
});
