// Lane D (city life): the city clock (design §8.3) and the time-evenly sampled path textures that drive
// the GPU traffic and pedestrians (§12). Both modules are pure, so they run in Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCityClock } from '../public/r3d/city-clock.js';
import {
  buildPathTexture, loopTiming, resampleLoop, lapsPerHour, sampleRow, ringPoint, ringLength, ringLoop,
  ellipseLoop, rectLoop, outAndBack, smoothPolyline, nearestIndex, CITY_HOUR,
} from '../public/r3d/life-paths.js';
import { ringPath, RINGS } from '../public/r3d/city-layout.js';

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} ≉ ${b} (±${eps})`);
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ---- city clock ---------------------------------------------------------------------------------------

test('clock: eases toward the target with time constant tau, snaps on request', () => {
  const clock = createCityClock();
  assert.equal(clock.rate, 1);
  assert.equal(clock.step(0.016), false, 'idle at ×1 reports no lapse');
  clock.setTarget(10);
  assert.equal(clock.target, 10);
  assert.equal(clock.rate, 1, 'no jump without snap');
  clock.step(0.05);
  const expected = 1 + 9 * (1 - Math.exp(-0.05 / 0.08));
  close(clock.rate, expected, 1e-12, 'eased rate');
  for (let k = 0; k < 40; k++) clock.step(0.05);
  assert.equal(clock.rate, 10, 'settles exactly on the target');
  clock.setTarget(1, { snap: true });
  assert.equal(clock.rate, 1);
  assert.equal(clock.step(0.016), false);
  clock.setTarget(3, { tau: 0.5 });
  assert.equal(clock.tau, 0.5);
  assert.equal(clock.step(0.016), true, 'lapsing');
});

test('clock: time advances by real dt × rate; dt is clamped to [0, 0.1]', () => {
  const clock = createCityClock();
  clock.setTarget(4, { snap: true });
  clock.step(0.05);
  close(clock.time, 0.2, 1e-12);
  clock.step(5); // a long hitch counts as 0.1 s
  close(clock.time, 0.6, 1e-12);
  for (const bad of [-1, NaN, undefined, 'x']) clock.step(bad);
  close(clock.time, 0.6, 1e-12, 'bad dt advances nothing');
});

test('clock: target clamps to [−8, 60]; non-finite rates mean ×1', () => {
  const clock = createCityClock();
  clock.setTarget(100, { snap: true });
  assert.equal(clock.rate, 60);
  clock.setTarget(-20, { snap: true });
  assert.equal(clock.rate, -8);
  clock.setTarget(NaN, { snap: true });
  assert.equal(clock.rate, 1);
  clock.setTarget(Infinity, { snap: true });
  assert.equal(clock.rate, 1);
});

test('clock: negative rates run time backwards and uCityTime stays wrapped in [0, 3600)', () => {
  const clock = createCityClock();
  clock.setTarget(-4, { snap: true });
  clock.step(0.05);
  close(clock.time, -0.2, 1e-12);
  close(clock.uniforms.uCityTime.value, 3600 - 0.2, 1e-9, 'wrapped below zero');
  for (let k = 0; k < 100; k++) clock.step(0.1);
  assert.ok(clock.uniforms.uCityTime.value >= 0 && clock.uniforms.uCityTime.value < 3600);
  close(clock.uniforms.uCityTime.value, (((clock.time % 3600) + 3600) % 3600), 1e-9);
});

test('clock: uCityTime wraps at 3600 s and is shared through bus.uniforms', () => {
  const uCityTime = { value: 0 };
  const bus = { uniforms: { uCityTime } };
  const clock = createCityClock(bus);
  assert.equal(clock.uniforms.uCityTime, uCityTime, 'the bus uniform object is reused');
  clock.time = 3599.95;
  clock.step(0.1);
  close(uCityTime.value, 0.05, 1e-9, 'wrapped past 3600');
  close(clock.time, 3600.05, 1e-9, 'clock.time itself is unwrapped');
  clock.reset();
  assert.deepEqual([clock.time, clock.rate, clock.target, uCityTime.value], [0, 1, 1, 0]);
  // no bus / a bus without uniforms: the clock owns its uniform
  assert.deepEqual(createCityClock(null).uniforms.uCityTime, { value: 0 });
  assert.deepEqual(createCityClock({}).uniforms.uCityTime, { value: 0 });
});

// ---- path textures ------------------------------------------------------------------------------------

const TRAFFIC = { h: RINGS.traffic1.h, c: 121.5 };

test('ringPoint follows city-layout ringPath exactly (same rounded-square rings)', () => {
  for (const key of ['traffic1', 'walkIn', 'walkOut', 'railA']) {
    const { h, c } = RINGS[key];
    const ring = ringPath(h, { c, step: 2 });
    close(ringLength(h, c), ring.length, 1e-9, `${key} length`);
    ring.points.forEach((p, j) => {
      const q = ringPoint(h, c, (j / ring.points.length) * ring.length, {});
      close(q.x, p.x, 1e-6, `${key} x`);
      close(q.z, p.z, 1e-6, `${key} z`);
      close(wrapA(q.heading - p.heading), 0, 1e-9, `${key} heading`);
    });
  }
});

test('buildPathTexture: row layout, sizes, periods and lengths', () => {
  const a = ringLoop(TRAFFIC.h, TRAFFIC.c, { step: 1, arcStep: 0.4 });
  const b = ellipseLoop(-35, -45, 61, 31, { n: 160 });
  const tex = buildPathTexture([{ points: a, speed: 14 }, { points: b, speed: 1.4 }], { samples: 256 });
  assert.equal(tex.width, 256);
  assert.equal(tex.rows, 2);
  assert.equal(tex.data.length, 256 * 2 * 4);
  assert.ok(tex.data instanceof Float32Array);
  close(tex.lengths[0], ringLength(TRAFFIC.h, TRAFFIC.c), 0.05, 'ring length (polyline of the ring)');
  // no curve limit: period = length / speed
  close(tex.periods[0], tex.lengths[0] / 14, 1e-6, 'constant speed period');
  close(tex.periods[1], tex.lengths[1] / 1.4, 1e-6);
  // texel 0 of each row is that loop's first point
  close(tex.data[0], a[0].x, 1e-3);
  close(tex.data[1], a[0].z, 1e-3);
  close(tex.data[256 * 4], b[0].x, 1e-3);
  close(tex.data[256 * 4 + 1], b[0].z, 1e-3);
  // an empty list still gives a valid 1-row texture
  const empty = buildPathTexture([], { samples: 8 });
  assert.equal(empty.rows, 1);
  assert.equal(empty.data.length, 32);
});

test('loops are closed: every step, including last → first, is small and the distance channel wraps once', () => {
  const loops = [
    { points: ringLoop(TRAFFIC.h, TRAFFIC.c), speed: 14, aLat: 2.5, aLong: 2 },
    { points: rectLoop(-50, 50, 64, 44, 8, { step: 1 }), speed: 1.3 },
    { points: outAndBack([{ x: -180, z: 180 }, { x: -400, z: 400 }, { x: -650, z: 450 }], { offset: 1.6 }), speed: 13, aLat: 2.5, aLong: 2 },
  ];
  const W = 512;
  const tex = buildPathTexture(loops, { samples: W });
  for (let r = 0; r < tex.rows; r++) {
    const maxStep = (14 * tex.periods[r]) / W + 1e-3; // never faster than the cruise speed
    let wraps = 0;
    for (let j = 0; j < W; j++) {
      const a = (r * W + j) * 4, b = (r * W + ((j + 1) % W)) * 4;
      const step = Math.hypot(tex.data[b] - tex.data[a], tex.data[b + 1] - tex.data[a + 1]);
      assert.ok(step <= maxStep, `row ${r} sample ${j}: jump of ${step.toFixed(2)} m`);
      if (tex.data[b + 3] < tex.data[a + 3]) wraps++;
      for (let c = 0; c < 4; c++) assert.ok(Number.isFinite(tex.data[a + c]), 'finite');
      assert.ok(tex.data[a + 3] >= 0 && tex.data[a + 3] < tex.lengths[r], 'distance in [0, length)');
    }
    assert.equal(wraps, 1, `row ${r}: the distance channel wraps exactly once per lap`);
  }
});

test('time sampling is denser on arcs: vehicles slow down in the corners', () => {
  const loop = { points: ringLoop(TRAFFIC.h, TRAFFIC.c), speed: 14, aLat: 2.5, aLong: 2.5 };
  const W = 1024;
  const tex = buildPathTexture([loop], { samples: W });
  const timing = loopTiming(loop);
  assert.ok(tex.periods[0] > tex.lengths[0] / 14 + 5, 'the corners cost time');
  close(tex.periods[0], timing.period, 1e-9);
  let arcSum = 0, arcN = 0, strSum = 0, strN = 0;
  for (let j = 0; j < W; j++) {
    const a = j * 4, b = ((j + 1) % W) * 4;
    const step = Math.hypot(tex.data[b] - tex.data[a], tex.data[b + 1] - tex.data[a + 1]);
    const x = tex.data[a], z = tex.data[a + 1];
    const onArc = Math.abs(x) > TRAFFIC.c + 0.5 && Math.abs(z) > TRAFFIC.c + 0.5;
    const midStraight = Math.min(Math.abs(x), Math.abs(z)) < 60;
    if (onArc) { arcSum += step; arcN++; } else if (midStraight) { strSum += step; strN++; }
  }
  assert.ok(arcN > 0 && strN > 0);
  const arcStep = arcSum / arcN, strStep = strSum / strN;
  close(strStep, (14 * tex.periods[0]) / W, 0.02, 'cruising on the straights');
  assert.ok(arcStep < strStep / 3, `arc samples ${arcStep.toFixed(3)} m apart vs straights ${strStep.toFixed(3)} m`);
  const vArc = arcStep / (tex.periods[0] / W);
  close(vArc, Math.sqrt(2.5 * (TRAFFIC.h - TRAFFIC.c)), 0.6, 'corner speed ≈ √(aLat · r)');
});

test('stops dwell: the period grows by the dwell and the samples hold still there', () => {
  const pts = ringLoop(TRAFFIC.h, TRAFFIC.c);
  const at = nearestIndex(pts, 0, TRAFFIC.h); // middle of the south side
  const base = loopTiming({ points: pts, speed: 12, aLong: 1.5 });
  const stop = loopTiming({ points: pts, speed: 12, aLong: 1.5, stops: [{ at, dwell: 10 }] });
  assert.ok(stop.period > base.period + 10, 'dwell + braking + pulling away');
  const W = 1024;
  const tex = buildPathTexture([{ points: pts, speed: 12, aLong: 1.5, stops: [{ at, dwell: 10 }] }], { samples: W });
  let still = 0;
  for (let j = 0; j < W; j++) {
    const a = j * 4;
    if (Math.hypot(tex.data[a] - pts[at].x, tex.data[a + 1] - pts[at].z) < 1e-4) still++;
  }
  close(still, (10 / tex.periods[0]) * W, 2, 'samples spent at the stop');
});

test('lapsPerHour is a positive integer and keeps sampling continuous across the 3600 s wrap', () => {
  const loop = { points: ringLoop(TRAFFIC.h, TRAFFIC.c), speed: 14, aLat: 2.5, aLong: 2.5 };
  const tex = buildPathTexture([loop]);
  const laps = lapsPerHour(tex.periods[0]);
  assert.ok(Number.isInteger(laps) && laps >= 1);
  close(laps, CITY_HOUR / tex.periods[0], 0.5);
  assert.equal(lapsPerHour(1e9), 1, 'at least one lap');
  assert.ok(Number.isInteger(lapsPerHour(700, 1.37)));
  const phase = 0.37;
  const u = (t) => phase + (t * laps) / CITY_HOUR;
  const before = sampleRow(tex, 0, u(3599.999), {});
  const after = sampleRow(tex, 0, u(0), {});
  assert.ok(Math.hypot(before.x - after.x, before.z - after.z) < 0.05, 'no jump at the wrap');
});

test('sampleRow mirrors the texture (texel centres, interpolation, distance wrap)', () => {
  const pts = ellipseLoop(0, 0, 50, 30, { n: 200 });
  const tex = buildPathTexture([{ points: pts, speed: 2 }], { samples: 64 });
  for (const j of [0, 5, 63]) {
    const s = sampleRow(tex, 0, j / 64, {});
    close(s.x, tex.data[j * 4], 1e-5);
    close(s.z, tex.data[j * 4 + 1], 1e-5);
    close(s.dist, tex.data[j * 4 + 3], 1e-3);
  }
  const mid = sampleRow(tex, 0, 63.5 / 64, {});
  assert.ok(mid.dist > tex.data[63 * 4 + 3], 'interpolates across the seam without going backwards');
  const neg = sampleRow(tex, 0, -0.25, {});
  const pos = sampleRow(tex, 0, 0.75, {});
  close(neg.x, pos.x, 1e-6, 'u wraps');
});

test('loop builders: ellipse / rectangle / out-and-back run clockwise with consistent headings', () => {
  const area = (pts) => { // shoelace in (x, z): clockwise from above (z south) gives a positive sum
    let s = 0;
    for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a.x * b.z - b.x * a.z; }
    return s / 2;
  };
  assert.ok(area(ellipseLoop(0, 0, 10, 5)) > 0, 'ellipse clockwise');
  assert.ok(area(ellipseLoop(0, 0, 10, 5, { cw: false })) < 0);
  assert.ok(area(rectLoop(0, 0, 40, 20, 4)) > 0, 'rectangle clockwise');
  assert.ok(area(ringLoop(130, 120)) > 0, 'ring clockwise');
  for (const p of ellipseLoop(3, 4, 10, 5, { n: 32 })) {
    const t = Math.atan2((p.z - 4) / 5, (p.x - 3) / 10);
    close(wrapA(p.heading - Math.atan2(-10 * Math.sin(t), 5 * Math.cos(t))), 0, 1e-9, 'tangent heading');
  }
  const line = [{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: 80, z: 160 }];
  const smooth = smoothPolyline(line, { radius: 30, step: 2 });
  close(smooth[0].x, 0, 1e-9); close(smooth.at(-1).x, 80, 1e-9);
  const loop = outAndBack(line, { offset: 1.6, step: 2 });
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    assert.ok(Math.hypot(b.x - a.x, b.z - a.z) < 2.6, `out-and-back gap at ${i}`);
  }
  // outbound lane is right of the travel direction (driving south (+z) the right hand points west, −x)
  assert.ok(loop[3].x < 0, 'keeps right on the way out');
});
