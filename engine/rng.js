// Seeded PRNG (mulberry32), stateless over a plain { seed, counter } object that lives in the
// game state. The n-th float depends only on (seed, n), so any saved state replays identically.

function floatAt(seed, n) {
  let a = (seed + Math.imul(n, 0x6d2b79f5)) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function makeRng(seed) {
  return { seed: seed >>> 0, counter: 0 };
}

/** Pure: the float the n-th call will return (defaults to the next one). */
export function peekFloat(rng, n = rng.counter + 1) {
  return floatAt(rng.seed, n);
}

/** Advances rng.counter (mutates) and returns a float in [0, 1). */
export function nextFloat(rng) {
  rng.counter += 1;
  return floatAt(rng.seed, rng.counter);
}

/** Integer in [min, max], inclusive. */
export function nextInt(rng, min, max) {
  return min + Math.floor(nextFloat(rng) * (max - min + 1));
}

/** Two six-sided dice, d1 drawn first. */
export function rollDice(rng) {
  const d1 = nextInt(rng, 1, 6);
  const d2 = nextInt(rng, 1, 6);
  return [d1, d2];
}

/** Fisher–Yates from the end; returns a new array. */
export function shuffle(rng, array) {
  const out = array.slice();
  for (let i = out.length - 1; i >= 1; i--) {
    const j = nextInt(rng, 0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
