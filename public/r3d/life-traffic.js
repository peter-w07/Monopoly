// public/r3d/life-traffic.js — pure planning for the GPU traffic and pedestrians (lane D): which loop
// every car / bus / pedestrian runs on, its phase, lap rate, lateral offset, type and colours. The
// result is a list of plain descriptors; life.js packs them into instanced attributes once per tier.
//
// Collision-free by construction: every car on a lane shares that lane's lap rate (integer laps per
// 3600 s), so their spacing IN TIME never changes; the spacing in distance is smallest in the corners,
// and the planner keeps each lane's count / jitter so that even there cars stay ≥ 1.5 m apart.
import { lapsPerHour } from './life-paths.js';
import { apportion, carSplit, TRAFFIC_LANES } from './life-routes.js';

/** Deterministic PRNG (mulberry32). */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, list) => list[Math.floor(r() * list.length) % list.length];
export const packColor = (hex) => parseInt(String(hex).replace('#', ''), 16) || 0;

// Real streets are mostly white, black, grey and silver, with a few colours.
const PAINTS = ['#f2f2f0', '#f2f2f0', '#e9eaeb', '#1d1f22', '#1d1f22', '#2a2d31', '#8c9196', '#b7bcc1', '#b7bcc1', '#5b6168',
  '#9b1c1c', '#c0392b', '#1f3a68', '#2e5c8a', '#2f5d3a', '#6b4f2a', '#d9cdb4', '#7b2d42', '#3f7f8f', '#d35400'];
const TAXI = '#f2c414';
export const BUS_LIVERY = '#14806b';
/** [type id, share]: sedan, hatch, suv, van, taxi. */
const TYPE_MIX = [[0, 0.38], [1, 0.2], [2, 0.18], [3, 0.1], [4, 0.14]];
const TYPE_LEN = [4.6, 3.95, 4.75, 5.2, 4.6];
const TYPE_WIDTH = [1.8, 1.75, 1.9, 2.0, 1.8];
const WHEEL_R = [0.33, 0.33, 0.33, 0.36, 0.33];

function vehicleType(r) {
  let u = r();
  for (const [t, share] of TYPE_MIX) { if ((u -= share) <= 0) return t; }
  return 0;
}

/** Cull distance of vehicles per tier name (m). */
export const CAR_CULL = { low: 700, medium: 1300, high: 2500 };
/** Pedestrians are culled beyond 120 / 220 / 300 m (design §12). */
export const PED_CULL = { low: 120, medium: 220, high: 300 };

/**
 * Cars for a tier: [{ row, phase, laps, lat, type, paint, seed, length, width, wheelR, cull, y }].
 * `tex` (buildPathTexture result) gives each row's period.
 */
export function planCars(routes, tex, tier, seed = 11) {
  const r = rng(seed);
  const [n1, n2, nArt] = carSplit(tier?.cars ?? 60);
  const cull = CAR_CULL[tier?.name] ?? 1300;
  const out = [];
  const lane = (row, n, vCorner) => {
    if (n <= 0) return;
    const period = tex.periods[row];
    const laps = lapsPerHour(period);
    const T = 3600 / laps; // the real period after rounding the lap rate
    const dt = T / n; // time gap between consecutive cars
    const gMin = (5.2 + 1.5) / vCorner; // the longest car + 1.5 m, at the slowest corner speed
    const jitter = Math.max(0, Math.min(0.35, (dt - gMin) / (2 * dt)));
    for (let k = 0; k < n; k++) {
      const type = vehicleType(r);
      out.push({
        row, phase: (k + (r() * 2 - 1) * jitter) / n, laps, lat: (r() * 2 - 1) * 0.12,
        type, paint: type === 4 ? TAXI : pick(r, PAINTS), seed: r(),
        length: TYPE_LEN[type], width: TYPE_WIDTH[type], wheelR: WHEEL_R[type], cull, y: 0,
      });
    }
  };
  lane(routes.traffic[0], n1, Math.sqrt(2.5 * (TRAFFIC_LANES[0].h - TRAFFIC_LANES[0].c)));
  lane(routes.traffic[1], n2, Math.sqrt(2.5 * (TRAFFIC_LANES[1].h - TRAFFIC_LANES[1].c)));
  const perArt = apportion(nArt, routes.arterials.map(() => 1));
  routes.arterials.forEach((row, k) => lane(row, perArt[k], Math.sqrt(2.5 * 1.7)));
  return out;
}

/** The city bus (none on low): one descriptor or null. */
export function planBus(routes, tex, tier) {
  if (tier?.name === 'low') return null;
  return {
    row: routes.bus, phase: 0.13, laps: lapsPerHour(tex.periods[routes.bus]), lat: 0, type: 0, paint: BUS_LIVERY, seed: 0.5,
    length: 12, width: 2.55, wheelR: 0.5, cull: CAR_CULL[tier?.name] ?? 1300, y: 0,
  };
}

// ---- pedestrians -----------------------------------------------------------------------------------------

const SHIRTS = ['#b03a2e', '#2c3e50', '#ecf0f1', '#2471a3', '#1e8449', '#7d3c98', '#d68910', '#ba4a00', '#7f8c8d', '#117a65',
  '#f1c40f', '#c0392b', '#34495e', '#bdc3c7', '#a0522d', '#556b2f', '#e8e3d9', '#1b2631', '#943126', '#5d6d7e', '#d98880', '#76448a'];
const TROUSERS = ['#1f2a36', '#2c3e50', '#3b3f44', '#4b4b4b', '#5d4037', '#283593', '#37474f', '#795548', '#212121', '#8d8f91',
  '#3e2723', '#1a3a5c', '#c8bfae', '#4a5a3a'];
const SKIN = ['#f1c9a5', '#e0ac7e', '#c68642', '#8d5524', '#f6d7b8', '#ffdbac', '#a1665e', '#6b4226', '#d1a27c'];
const HAIR = ['#2b1b0e', '#4a2f1b', '#8d5524', '#c9a15b', '#e6cfa0', '#1c1c1c', '#6d6d6d', '#b55239', '#3b2a1d'];
export const HIVIS = ['#ff7a00', '#d8f000', '#ff9e1b'];

/** Colours of one person: [shirt, trousers, skin, hair] packed, plus [height, width, umbrella, style]. */
export function personLook(r, { hardHat = false } = {}) {
  return {
    cols: [packColor(hardHat ? pick(r, HIVIS) : pick(r, SHIRTS)), packColor(pick(r, TROUSERS)), packColor(pick(r, SKIN)), packColor(pick(r, HAIR))],
    vars: [0.92 + r() * 0.16, 0.9 + r() * 0.22, r(), !hardHat && r() < 0.22 ? 1 : 0],
  };
}

/**
 * Pedestrians for a tier: [{ row, phase, laps, lat, stride, cols, vars, cull, y }]. Two-way routes
 * get half their walkers going each way, keeping to their right; one-way routes (out-and-back) are
 * already two lanes.
 */
export function planPeds(routes, tex, tier, seed = 23) {
  const r = rng(seed);
  const n = Math.max(0, Math.round(tier?.peds ?? 300));
  const cull = PED_CULL[tier?.name] ?? 220;
  const walkRows = routes.walks;
  const counts = apportion(n, walkRows.map((row) => routes.rows[row].weight));
  const out = [];
  walkRows.forEach((row, k) => {
    const meta = routes.rows[row];
    const period = tex.periods[row]; // = length (unit speed)
    for (let j = 0; j < counts[k]; j++) {
      const v = 1.05 + r() * 0.55; // m/s
      const dir = meta.twoWay && j % 2 === 1 ? -1 : 1;
      const laps = lapsPerHour(period, v);
      const keepRight = meta.twoWay ? (dir > 0 ? -0.55 : 0.55) : 0;
      const look = personLook(r);
      out.push({
        row, phase: r(), laps: dir * laps, lat: keepRight + (r() * 2 - 1) * 0.35,
        stride: 1.25 + 0.35 * (v - 1.05) / 0.55 + r() * 0.1, // m per full walk cycle (two steps)
        cols: look.cols, vars: look.vars, cull, y: meta.y, length: tex.lengths[row],
      });
    }
  });
  return out;
}
