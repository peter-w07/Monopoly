// public/r3d/life-routes.js — pure (no three.js): where Loop City's ambient life goes (lane D).
//
// Every route is a closed loop for the time-sampled path texture (life-paths.js), with what runs on it
// and how many of the tier's cars / pedestrians it gets:
//   traffic   the two one-way clockwise lanes of the avenue ring (§3.1: 125.625 / 128.875)
//   bus       the city bus in the bus & cycle lane along the inner kerb (123.4), dwelling at 8 stops
//   arterial  four 2-lane roads out of the service ring corners, as out-and-back loops
//   walk      inner / outer sidewalks, the park ring, the lake path, City Hall Square, the east–west
//             park path, the promenade, the civic quarter and the gardens
// Corner radii: the traffic lanes turn on 4.1 / 7.4 m (centres ±121.5, inside the lane bands), the bus
// on 4.4 m (it never leaves the road at the apex).
import { RINGS, QUARTER } from './city-layout.js';
import { ringLoop, ringPoint, ringLength, ellipseLoop, rectLoop, outAndBack, nearestIndex } from './life-paths.js';

export const TRAFFIC_LANES = Object.freeze([
  { h: 125.625, c: 121.5, speed: 14 }, // inner lane (the time-lapse reference speed of travel.js)
  { h: 128.875, c: 121.5, speed: 12.5 },
]);
export const BUS_LANE = Object.freeze({ h: 123.4, c: 119, speed: 11, dwell: 9 });
/** Bus stops: on every side, this far (m) before / after the side's middle. */
export const BUS_STOP_OFFSETS = Object.freeze([-70, 70]);

/** Arterial centre lines (from the service-ring corner outward). Ambient traffic only. */
export const ARTERIALS = Object.freeze([
  [{ x: -176, z: 176 }, { x: -330, z: 330 }, { x: -600, z: 560 }], // SW, past the suburbs
  [{ x: -176, z: -176 }, { x: -330, z: -330 }, { x: -560, z: -620 }], // NW, toward the hills
  [{ x: 176, z: -176 }, { x: 209, z: -235 }, { x: 212, z: -420 }, { x: 232, z: -700 }], // NE, along the coast
  [{ x: 176, z: 176 }, { x: 209, z: 235 }, { x: 212, z: 420 }, { x: 240, z: 700 }], // SE, along the coast
]);

/** Pedestrian routes: loop builder, share of the tier's pedestrians, base height, two-way. */
const WALKS = [
  { name: 'walkIn', weight: 60, y: 0.15, twoWay: true, build: () => ringLoop(RINGS.walkIn.h, RINGS.walkIn.c, { step: 2, arcStep: 0.5 }) },
  { name: 'walkOut', weight: 90, y: 0.15, twoWay: true, build: () => ringLoop(RINGS.walkOut.h, RINGS.walkOut.c, { step: 2, arcStep: 0.5 }) },
  { name: 'park', weight: 35, y: 0.15, twoWay: true, build: () => rectLoop(0, 0, 200, 200, 18, { step: 2 }) },
  { name: 'lake', weight: 25, y: 0.15, twoWay: true, build: () => ellipseLoop(-35, -45, 62, 32, { n: 140 }) },
  { name: 'plazaFountain', weight: 20, y: 0.15, twoWay: true, build: () => ellipseLoop(-50, 52, 26, 15, { n: 90 }) },
  { name: 'plazaEdge', weight: 18, y: 0.15, twoWay: true, build: () => rectLoop(-50, 52, 62, 40, 6, { step: 1.5 }) },
  { name: 'eastWest', weight: 16, y: 0.15, twoWay: false, build: () => outAndBack([{ x: -100, z: 0 }, { x: 100, z: 0 }], { offset: 1.0, step: 2 }) },
  { name: 'promenade', weight: 18, y: 0.15, twoWay: false, build: () => outAndBack([{ x: 209, z: -215 }, { x: 209, z: 215 }], { offset: 1.6, step: 2 }) },
  { name: 'civic', weight: 10, y: 0.15, twoWay: true, build: () => rectLoop(61, -61, 70, 70, 10, { step: 2 }) },
  { name: 'gardens', weight: 8, y: 0.15, twoWay: true, build: () => rectLoop(58, 58, 64, 64, 10, { step: 2 }) },
];

/** Arc length (on a ring) of the middle of side q (0 south … 3 east). */
export function sideMiddle(h, c, q) {
  const arc = (Math.PI / 2) * (h - c);
  return q * (2 * c + arc) + arc / 2 + c;
}

/** The bus loop with its stops: { points, stops: [{ at, dwell, x, z }] }. */
export function busRoute() {
  const { h, c, dwell } = BUS_LANE;
  const points = ringLoop(h, c, { step: 1, arcStep: 0.4 });
  const stops = [];
  for (let q = 0; q < 4; q++) {
    for (const off of BUS_STOP_OFFSETS) {
      const p = ringPoint(h, c, sideMiddle(h, c, q) + off, {});
      stops.push({ at: nearestIndex(points, p.x, p.z), dwell, x: p.x, z: p.z, heading: p.heading });
    }
  }
  return { points, stops };
}

/**
 * All the loops, in texture-row order, plus what runs where:
 * { loops, rows: [{ name, kind, speed, y, weight, twoWay }], traffic: [row, row], bus: row,
 *   arterials: [rows], walks: [rows], busStops }
 */
export function buildRoutes() {
  const loops = [];
  const rows = [];
  const add = (loop, meta) => { loops.push(loop); rows.push(meta); return rows.length - 1; };
  const traffic = TRAFFIC_LANES.map((L, k) => add(
    { points: ringLoop(L.h, L.c, { step: 1, arcStep: 0.4 }), speed: L.speed, aLat: 2.5, aLong: 2.5 },
    { name: `traffic${k + 1}`, kind: 'traffic', speed: L.speed, y: 0, weight: 1, twoWay: false },
  ));
  const bus = busRoute();
  const busRow = add(
    { points: bus.points, speed: BUS_LANE.speed, aLat: 1.8, aLong: 1.1, stops: bus.stops },
    { name: 'bus', kind: 'bus', speed: BUS_LANE.speed, y: 0, weight: 1, twoWay: false },
  );
  const arterials = ARTERIALS.map((line, k) => add(
    { points: outAndBack(line, { offset: 1.7, step: 2, radius: 40 }), speed: 15, aLat: 2.5, aLong: 2 },
    { name: `arterial${k + 1}`, kind: 'arterial', speed: 15, y: 0, weight: 1, twoWay: false },
  ));
  const walks = WALKS.map((w) => add(
    { points: w.build(), speed: 1 },
    { name: w.name, kind: 'walk', speed: 1, y: w.y, weight: w.weight, twoWay: w.twoWay },
  ));
  return { loops, rows, traffic, bus: busRow, arterials, walks, busStops: bus.stops };
}

/** Splits `n` items over weights (largest remainders). */
export function apportion(n, weights) {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const raw = weights.map((w) => (n * w) / total);
  const out = raw.map(Math.floor);
  let left = n - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k][1]]++;
  return out;
}

/** How a tier's cars are split: [inner lane, outer lane, arterials total]. */
export function carSplit(cars) {
  const n = Math.max(0, Math.round(cars));
  const art = Math.round(n * 0.27);
  const ring = n - art;
  return [Math.ceil(ring / 2), Math.floor(ring / 2), art];
}

/** Circle Line: the two track rings and the four station stops (head positions, so the train centres on the platform). */
export const RAIL = Object.freeze({
  A: { h: RINGS.railA.h, c: RINGS.railA.c, dir: 1 },
  B: { h: RINGS.railB.h, c: RINGS.railB.c, dir: -1 },
  speed: 14, aLat: 1.2, aLong: 0.9, dwell: 6, cars: 4, carLen: 20.5,
  tunnel: { minX: 186, maxX: 210, minZ: -150, maxZ: 150 },
});

/** A train loop on ring {h, c} in direction dir (±1) with its 4 station stops: { points, stops, length }. */
export function trainRoute({ h, c, dir }, { carLen = RAIL.carLen, cars = RAIL.cars, dwell = RAIL.dwell } = {}) {
  const L = ringLength(h, c);
  const n = Math.round(L / 2);
  const points = [];
  for (let k = 0; k < n; k++) {
    const s = dir * (k / n) * L;
    const p = ringPoint(h, c, s, {});
    points.push({ x: p.x, z: p.z, heading: dir > 0 ? p.heading : p.heading + Math.PI });
  }
  const half = (cars * carLen) / 2;
  const stops = [];
  for (let q = 0; q < 4; q++) {
    const sHead = sideMiddle(h, c, q) + dir * half; // the head stops half a train past the station centre
    const p = ringPoint(h, c, sHead, {});
    stops.push({ at: nearestIndex(points, p.x, p.z), dwell, station: [5, 15, 25, 35][q] });
  }
  return { points, stops, length: L };
}

export { QUARTER };
