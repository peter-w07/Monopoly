// public/r3d/travel.js (city design §8.1) and public/r3d/gait.js (§7.2): the life-size travel planner and the
// pure locomotion maths. Both are pure modules (no three.js, no DOM), so they run under node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { travelPlan, shotTier, V_REAL, TRAFFIC_SPEED } from '../public/r3d/travel.js';
import { pathFor, LOOP } from '../public/r3d/city-layout.js';
import {
  createGait, stepGait, strideFor, froude, gaitName, inStance, ik2, createSpring, stepSpring, createWheel, stepWheel,
  steer, CADENCE_CAP, BLEND, GAITS,
} from '../public/r3d/gait.js';

const DICE = 0.85; // dice press → rest (own, §8.5)
const EARLY = 0.05; // the move sets off at dice rest − 0.05
const LAND = 0.25; // land beat
const TOKENS = Object.keys(V_REAL);
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b}, got ${a} (±${eps})`);

/** Every own dice walk: start 0–39 × roll 2–12. */
function* rolls() {
  for (let start = 0; start < 40; start++) for (let roll = 2; roll <= 12; roll++) yield { start, roll, length: pathFor(start, roll).length };
}

test('own dice walks: T ≤ 1.8, roll→landed ≤ 3.0 s with median ≤ 2.5 s; others ≤ 0.9 s', () => {
  const totals = [];
  for (const { start, roll, length } of rolls()) {
    assert.ok(length > 0, `path ${start}+${roll} has a length`);
    for (const tokenId of TOKENS) {
      const own = travelPlan({ length, tokenId, own: true });
      assert.ok(own.T <= 1.8 + 1e-9, `own T ${own.T} for ${start}+${roll} (${tokenId})`);
      const total = DICE - EARLY + own.T + LAND;
      assert.ok(total <= 3.0 + 1e-9, `roll→landed ${total} for ${start}+${roll} (${tokenId})`);
      if (tokenId === 'car') totals.push(total);
      const others = travelPlan({ length, tokenId, own: false });
      assert.ok(others.T <= 0.9 + 1e-9, `others T ${others.T} for ${start}+${roll}`);
      assert.ok(others.T >= 0.55 - 1e-9);
    }
  }
  totals.sort((a, b) => a - b);
  const median = totals[Math.floor(totals.length / 2)];
  assert.ok(median <= 2.5, `median roll→landed ${median}`);
  assert.ok(totals.at(-1) <= 3.0, `max roll→landed ${totals.at(-1)}`);
});

test('card advances (up to 40 steps) stay within 1.8 s', () => {
  for (let start = 0; start < 40; start++) {
    for (const steps of [1, 6, 13, 25, 39, 40, -3]) {
      const length = pathFor(start, steps).length;
      const p = travelPlan({ length, tokenId: 'pawn', own: true });
      assert.ok(p.T <= 1.8 + 1e-9 && p.T >= 0.9 - 1e-9, `T ${p.T} for ${start}${steps > 0 ? '+' : ''}${steps}`);
      assert.ok(p.clockPeak <= 40 && p.clockPeak >= 1);
    }
  }
  // A full lap ("advance to GO" from GO's neighbour) is the longest: 1.8 s with the clock near ×40.
  const lap = travelPlan({ length: LOOP, tokenId: 'car' });
  near(lap.T, 1.8, 1e-12);
  assert.ok(lap.clockPeak > 30, `lap clock peak ${lap.clockPeak}`);
});

test('sAt runs 0 → length monotonically; vAt starts and ends at rest; timeAt inverts sAt', () => {
  const lengths = [0.5, 5, 26, 26.319, 52, 78, 182.6, 260.6, 313.3, 600, LOOP];
  for (const length of lengths) {
    for (const tokenId of TOKENS) {
      for (const own of [true, false]) {
        const p = travelPlan({ length, tokenId, own });
        near(p.sAt(0), 0, 1e-6, 'sAt(0)');
        near(p.sAt(p.T), length, 1e-6, `sAt(T) ${tokenId} ${length}`);
        near(p.sAt(p.T + 5), length, 1e-6, 'sAt past T clamps');
        near(p.sAt(-1), 0, 1e-6, 'sAt before 0 clamps');
        let prev = -Infinity;
        for (let k = 0; k <= 400; k++) {
          const s = p.sAt((k / 400) * p.T);
          assert.ok(s >= prev - 1e-9, `sAt monotonic (${tokenId} ${length})`);
          prev = s;
        }
        assert.ok(Math.abs(p.vAt(0)) < 1e-9, `vAt(0) = ${p.vAt(0)}`);
        assert.ok(Math.abs(p.vAt(p.T)) < 1e-6 * Math.max(1, p.vCruise), `vAt(T) = ${p.vAt(p.T)}`);
        // Launch reaches the real speed; the cruise is the time-lapse speed.
        if (p.lapse) {
          near(p.vAt(p.launch - 1e-9), p.vReal, 1e-6 * p.vCruise + 1e-6, 'launch ends at vReal');
          assert.ok(p.vCruise >= p.vReal - 1e-9);
        }
        for (let k = 1; k < 50; k++) {
          const s = (k / 50) * length;
          const t = p.timeAt(s);
          assert.ok(t >= 0 && t <= p.T + 1e-12);
          near(p.sAt(t), s, 1e-6 * Math.max(1, length), `timeAt inverts sAt (${tokenId} ${length})`);
        }
        near(p.timeAt(length), p.T, 1e-6, 'timeAt(length) = T');
      }
    }
  }
});

test('clockAt stays in [1, 40] and is 1 without a time-lapse', () => {
  let sawLapse = false;
  let sawNoLapse = false;
  for (const length of [1, 3, 10, 26, 78, 182, 313, 700, LOOP]) {
    for (const tokenId of TOKENS) {
      for (const own of [true, false]) {
        const p = travelPlan({ length, tokenId, own });
        for (let k = 0; k <= 100; k++) {
          const c = p.clockAt((k / 100) * p.T);
          assert.ok(c >= 1 && c <= 40, `clockAt ${c}`);
          if (!p.lapse) assert.equal(c, 1);
        }
        if (p.lapse) {
          sawLapse = true;
          near(p.clockPeak, Math.min(40, Math.max(1, p.vCruise / TRAFFIC_SPEED)), 1e-9);
        } else {
          sawNoLapse = true;
          assert.equal(p.clockPeak, 1);
          near(p.vCruise, p.vReal, 1e-9, 'short hop: one speed');
        }
      }
    }
  }
  assert.ok(sawLapse && sawNoLapse, 'both regimes covered');
});

test('Fast (speed 1.8) divides every time by 1.8 and keeps the path', () => {
  for (const length of [26, 182.6, 313.3, LOOP]) {
    const a = travelPlan({ length, tokenId: 'dog' });
    const b = travelPlan({ length, tokenId: 'dog', speed: 1.8 });
    near(b.T, a.T / 1.8, 1e-12, 'T');
    near(b.launch, a.launch / 1.8, 1e-12, 'launch');
    near(b.arrive, a.arrive / 1.8, 1e-12, 'arrive');
    near(b.cruiseStart, a.cruiseStart / 1.8, 1e-12);
    near(b.cruiseEnd, a.cruiseEnd / 1.8, 1e-12);
    for (let k = 0; k <= 20; k++) {
      const t = (k / 20) * a.T;
      near(b.sAt(t / 1.8), a.sAt(t), 1e-9, 'same distance at the scaled time');
      near(b.vAt(t / 1.8), a.vAt(t) * 1.8, 1e-9, 'speed × 1.8');
      near(b.clockAt(t / 1.8), a.clockAt(t), 1e-9, 'clock rate relative to traffic');
    }
  }
});

test('shotTier boundaries', () => {
  assert.equal(shotTier(0), 'track');
  assert.equal(shotTier(26), 'track');
  assert.equal(shotTier(60), 'track');
  assert.equal(shotTier(60.0001), 'swoop');
  assert.equal(shotTier(182.6), 'swoop');
  assert.equal(shotTier(400), 'swoop');
  assert.equal(shotTier(400.0001), 'maphop');
  assert.equal(shotTier(LOOP), 'maphop');
});

// ---- gait.js ----------------------------------------------------------------------------------------

test('gait phase advances by exactly distance / stride, and a planted foot does not slide', () => {
  for (const [type, hip, v] of [['biped', 0.9, 1.4], ['biped', 0.9, 3.5], ['quad', 0.4, 1.0], ['quad', 0.4, 3], ['quad', 0.4, 7], ['cat', 0.45, 8]]) {
    const g = createGait(type, { hip });
    const dt = 1 / 60;
    const ds = v * dt;
    // Settle into the gait for this speed (blend finished).
    for (let k = 0; k < 60; k++) stepGait(g, ds, dt);
    const stride = strideFor(v, hip);
    near(g.stride, stride, 1e-12);
    let x = 0; // body position along the path
    const planted = new Map(); // leg → world x of its foot while in stance
    for (let k = 0; k < 600; k++) {
      const before = g.cycles;
      const prevStance = Array.from({ length: g.legs }, (_, i) => inStance(g, i));
      stepGait(g, ds, dt);
      x += ds;
      near(g.cycles - before, ds / stride, 1e-12, `${type} Δphase`);
      for (let i = 0; i < g.legs; i++) {
        const world = x + g.feet[i * 2];
        if (prevStance[i] && inStance(g, i) && planted.has(i)) near(world, planted.get(i), 1e-9, `${type} leg ${i} slides`);
        if (inStance(g, i)) { if (!prevStance[i] || !planted.has(i)) planted.set(i, world); } else planted.delete(i);
        if (inStance(g, i)) assert.equal(g.feet[i * 2 + 1], 0, 'stance foot on the ground');
      }
    }
    assert.ok(g.cycles > 2, 'covered several cycles');
  }
});

test('gaits are chosen by Froude number and the phase stays continuous across 0.2 s blends', () => {
  const g = createGait('quad', { hip: 0.4 });
  const dt = 1 / 120;
  const seen = [];
  let v = 0;
  let prevFeet = Float64Array.from(g.feet);
  let maxJump = 0;
  for (let k = 0; k < 1200; k++) {
    v = Math.min(7, v + 6 * dt); // accelerate to a gallop
    const before = g.cycles;
    const ds = v * dt;
    stepGait(g, ds, dt);
    const dPhase = g.cycles - before;
    assert.ok(dPhase >= 0 && dPhase <= ds / strideFor(v, 0.4) + 1e-12, 'phase continuous and by distance');
    if (seen.at(-1) !== gaitName(g)) seen.push(gaitName(g));
    for (let i = 0; i < g.feet.length; i++) maxJump = Math.max(maxJump, Math.abs(g.feet[i] - prevFeet[i]));
    prevFeet = Float64Array.from(g.feet);
  }
  assert.deepEqual(seen, ['walk', 'trot', 'gallop']);
  // A foot never teleports: per 1/120 s frame it moves less than a fifth of a stride, even mid-blend.
  assert.ok(maxJump < 0.2 * strideFor(7, 0.4), `max foot jump ${maxJump}`);
  assert.ok(froude(7, 0.4) > GAITS.quad[1].upTo, 'gallop at the dog’s real speed');
  assert.equal(BLEND, 0.2);
  // Biped walk → jog.
  const b = createGait('biped', { hip: 0.9 });
  stepGait(b, 1.4 / 60, 1 / 60);
  assert.equal(gaitName(b), 'walk');
  for (let k = 0; k < 30; k++) stepGait(b, 3.5 / 60, 1 / 60);
  assert.equal(gaitName(b), 'jog');
});

test('time-lapse caps the visual cadence at 2.5× real; plants are reported', () => {
  const g = createGait('biped', { hip: 0.9 });
  const vReal = 3.5;
  const dt = 1 / 60;
  let plants = 0;
  for (let k = 0; k < 120; k++) {
    const before = g.cycles;
    plants += popcount(stepGait(g, (300 * dt), dt, { vReal, lapse: true }));
    const cadence = (g.cycles - before) / dt;
    assert.ok(cadence <= CADENCE_CAP * vReal / strideFor(vReal, 0.9) + 1e-9, `cadence ${cadence}`);
  }
  // 2 s at 2.5× real cadence: about 2 legs × cycles plants.
  const cycles = (2 * CADENCE_CAP * vReal) / strideFor(vReal, 0.9);
  assert.ok(Math.abs(plants - 2 * cycles) <= 2, `plants ${plants} vs ${2 * cycles}`);
  // Without the lapse flag nothing is capped.
  const h = createGait('biped', { hip: 0.9 });
  stepGait(h, 300 * dt, dt);
  near(h.cycles, (300 * dt) / strideFor(300, 0.9), 1e-12);
});

function popcount(m) {
  let n = 0;
  for (; m; m &= m - 1) n++;
  return n;
}

test('ik2 reaches the target; wheels spin with v/r and blur above 6 rev/s; springs settle; steering', () => {
  const out = {};
  for (const [x, y, bend] of [[0, -0.8, 1], [0.2, -0.7, 1], [-0.3, -0.6, -1], [0.1, -0.5, -1]]) {
    ik2(x, y, 0.45, 0.45, bend, out);
    const ex = 0.45 * Math.sin(out.a) + 0.45 * Math.sin(out.a + out.b);
    const ey = -0.45 * Math.cos(out.a) - 0.45 * Math.cos(out.a + out.b);
    near(ex, x, 1e-9, 'ik x');
    near(ey, y, 1e-9, 'ik y');
    assert.ok(bend > 0 ? out.b <= 0 : out.b >= 0, 'knee / elbow bends the right way');
  }
  ik2(0, -5, 0.45, 0.45, 1, out); // out of reach: straight leg
  assert.ok(Math.abs(out.b) < 0.1 && out.reach < 0.9);

  const w = createWheel(0.33);
  const turns = stepWheel(w, 14 / 60, 1 / 60);
  near(w.angle, 14 / 60 / 0.33, 1e-12, 'ω = v / r');
  near(w.rate, 14 / (2 * Math.PI * 0.33), 1e-9);
  assert.equal(w.blur, true, '14 m/s on r 0.33 m = 6.75 rev/s → blur');
  assert.equal(turns, 0);
  let n = 0;
  for (let k = 0; k < 60; k++) n += stepWheel(w, 1 / 60, 1 / 60);
  assert.equal(w.blur, false);
  near(n, Math.floor(w.angle / (2 * Math.PI)), 1, 'one event per revolution');
  const lap = createWheel(0.33);
  stepWheel(lap, 300 / 60, 1 / 60, { vReal: 14, lapse: true });
  near(lap.angle, (CADENCE_CAP * 14) / 60 / 0.33, 1e-9, 'lapse caps the visual spin');

  const s = createSpring(1.3, 0.45);
  for (let k = 0; k < 600; k++) stepSpring(s, 0.05, 1 / 60);
  near(s.x, 0.05, 1e-6, 'spring settles on its target');
  near(steer(2.5, 1 / 9), Math.atan(2.5 / 9), 1e-12, 'bicycle model on the corner arc');
  assert.equal(steer(2.5, 0), 0);
});
