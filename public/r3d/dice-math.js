// public/r3d/dice-math.js — die orientation maths (no DOM; imports only three).
//
// Face layout of a standard die (opposite faces sum to 7): +Y:1  -Y:6  +Z:2  -Z:5  +X:3  -X:4.
// BoxGeometry / RoundedBoxGeometry material groups are ordered [+X, -X, +Y, -Y, +Z, -Z], so the six
// face materials are created in PIP_ORDER.

import { Quaternion, Vector3 } from './three.js';

export const PIP_ORDER = [3, 4, 1, 6, 2, 5];

const NORMAL = {
  1: new Vector3(0, 1, 0),
  6: new Vector3(0, -1, 0),
  2: new Vector3(0, 0, 1),
  5: new Vector3(0, 0, -1),
  3: new Vector3(1, 0, 0),
  4: new Vector3(-1, 0, 0),
};
const UP = new Vector3(0, 1, 0);
const tmpQ = new Quaternion();

/** Rest orientation that shows `value` on top, turned `yaw` radians about world +Y. */
export function faceUpQuaternion(value, yaw = 0, out = new Quaternion()) {
  const n = NORMAL[value];
  if (!n) throw new RangeError(`die value ${value}`);
  out.setFromUnitVectors(n, UP);
  return out.premultiply(tmpQ.setFromAxisAngle(UP, yaw));
}

/** Which value is on top for an orientation (used by tests). */
export function topValue(q) {
  let best = 0;
  let bestDot = -2;
  for (const [v, n] of Object.entries(NORMAL)) {
    const d = n.clone().applyQuaternion(q).y;
    if (d > bestDot) {
      bestDot = d;
      best = Number(v);
    }
  }
  return best;
}

/**
 * Tumble that is guaranteed to land on `final`: q(e) = R(axis, angle·(1−e)) · final, so at e = 1 the
 * die rests exactly on `final`. `axis` is a world-space unit vector, `angle` the total spin.
 */
export function tumbleQuaternion(final, axis, angle, e, out = new Quaternion()) {
  return out.setFromAxisAngle(axis, angle * (1 - e)).multiply(final);
}

/** Small seeded PRNG so every client animates the same throw for the same state (cosmetic only). */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
