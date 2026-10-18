// public/r3d/city-layout.js — Loop City's ground plan (city design §2–§4). PURE: no three.js, no DOM,
// so Node tests and every lane can import it read-only.
//
// Units are metres; origin = city centre; +x east, +z south, +y up. The 40 board squares are 40
// addresses on a one-way clockwise "token lane" (a rounded square: straights at ±132.25, corner arcs
// of radius 9). Arc length s runs clockwise from GO (the SE corner apex), LOOP ≈ 1042.549 m a lap.
// The code below is the design's normative reference implementation (§4) — keep it exact.
export const TILE_COUNT = 40;
export const M = Object.freeze({
  CORE: 117, WALK_IN: 122, CYCLE_OUT: 124, TRAFFIC_OUT: 130.5, TRAFFIC_C: [125.625, 128.875],
  LANE: 132.25, LANE_W: 3.5, KERB: 134, POST: 134.8, WALK_OUT_C: 136.5, PROP: 139,
  FORECOURT: 147, DEEP: 153, LOT_BACK: 173, SERVICE: 177, SERVICE_OUT: 181,
  RAIL: [195, 199], RAIL_C: 155, RAIL_OUT: 203, SEA_X: 236,
  LOT_W: 26, LOT_D: 34, STEP: 26, ARC_C: 123.25, ARC_R: 9,
  SIDEWALK_Y: 0.15, WATER_Y: -2,
});
export const STRAIGHT = 2 * M.ARC_C;            // 246.5
export const ARC = (Math.PI / 2) * M.ARC_R;      // 14.137
export const HALF_ARC = ARC / 2;                 // 7.069
export const QUARTER = STRAIGHT + ARC;           // 260.637
export const LOOP = 4 * QUARTER;                 // 1042.549
export const SEAT_YAW = -Math.PI / 4;
export const SIDES = ['south', 'west', 'north', 'east'];
const ALONG = [{ x: -1, z: 0 }, { x: 0, z: -1 }, { x: 1, z: 0 }, { x: 0, z: 1 }];
const OUT = [{ x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }, { x: 1, z: 0 }];
const SIGN = [[1, 1], [-1, 1], [-1, -1], [1, -1]];                 // corner quadrant signs (x, z)
const CC = SIGN.map(([x, z]) => ({ x: x * M.ARC_C, z: z * M.ARC_C })); // lane corner centres

export const wrap = (i) => ((Math.trunc(Number(i) || 0) % TILE_COUNT) + TILE_COUNT) % TILE_COUNT;
export const qOf = (i) => Math.floor(wrap(i) / 10);
export const isCorner = (i) => wrap(i) % 10 === 0;
export const sideOf = (i) => (isCorner(i) ? 'corner' : SIDES[qOf(i)]);
export const rowOf = (i) => SIDES[qOf(i)];
export const alongOf = (k) => 130 - 26 * k;      // edge tile k = 1..9: south x, west z, north −x, east −z
const fwd = (x) => ((x % LOOP) + LOOP) % LOOP;

/** Arc length along the token lane from GO (clockwise) of address i. */
export function sOf(i) {
  i = wrap(i);
  const q = Math.floor(i / 10), k = i % 10;
  return q * QUARTER + (k === 0 ? 0 : HALF_ARC + 26 * k - 6.75);
}

function arcPoint(C, phi, rad, out) {
  out.x = C.x + rad * Math.cos(phi); out.z = C.z + rad * Math.sin(phi);
  out.heading = Math.atan2(-Math.sin(phi), Math.cos(phi)); // travel = increasing phi
  out.nx = Math.cos(phi); out.nz = Math.sin(phi);           // outward normal
  return out;
}

/** Point at arc length s along the token-lane centre line, offset `lateral` m (+ = toward the lots). */
export function pointAt(s, lateral = 0, out = {}) {
  s = fwd(s);
  const q = Math.min(3, Math.floor(s / QUARTER));
  let u = s - q * QUARTER;
  const r = M.ARC_R;
  if (u < HALF_ARC) return arcPoint(CC[q], Math.PI / 4 + q * Math.PI / 2 + u / r, r + lateral, out);
  u -= HALF_ARC;
  if (u < STRAIGHT) {
    const a = ALONG[q], n = OUT[q], C = CC[q];
    out.x = C.x + (r + lateral) * n.x + a.x * u; out.z = C.z + (r + lateral) * n.z + a.z * u;
    out.heading = Math.atan2(a.x, a.z); out.nx = n.x; out.nz = n.z;
    return out;
  }
  u -= STRAIGHT;
  const q1 = (q + 1) % 4;
  return arcPoint(CC[q1], Math.PI / 4 + q1 * Math.PI / 2 - (HALF_ARC - u) / r, r + lateral, out);
}

/** Everything about address i (see §3.3). */
export function address(i) {
  i = wrap(i);
  const q = qOf(i), k = i % 10, corner = k === 0, s = sOf(i);
  const p = pointAt(s);
  const out = corner ? { x: p.nx, z: p.nz } : { ...OUT[q] };
  const along = { x: Math.sin(p.heading), z: Math.cos(p.heading) };
  let lot;
  if (corner) {
    const [sx, sz] = SIGN[q];
    lot = { cx: sx * 156, cz: sz * 156, w: 34, d: 34, yaw: Math.atan2(-out.x, -out.z), front: { x: sx * M.PROP, z: sz * M.PROP } };
  } else {
    const a = alongOf(k);
    const [cx, cz] = [[a, 156], [-156, a], [-a, -156], [156, -a]][q];
    lot = { cx, cz, w: M.LOT_W, d: M.LOT_D, yaw: Math.atan2(-out.x, -out.z), front: { x: cx - out.x * 17, z: cz - out.z * 17 } };
  }
  return { i, q, k, corner, side: sideOf(i), row: rowOf(i), s, x: p.x, z: p.z, heading: p.heading, out, along, lot };
}

/**
 * A walk of `steps` (signed) from tile `from` along the token lane. `s1` is unwrapped (may exceed LOOP or go
 * below 0). tiles: every address reached, in order, with its unwrapped s and its fraction of the path (`at`).
 * goAt: fraction of the path where GO is crossed (forward walks that pass or land on GO), else null.
 */
export function pathFor(from, steps) {
  const a = wrap(from), n = Math.trunc(Number(steps) || 0), to = wrap(a + n), dir = n < 0 ? -1 : 1, s0 = sOf(a);
  let length = n === 0 ? 0 : dir > 0 ? fwd(sOf(to) - s0) : fwd(s0 - sOf(to));
  if (n !== 0 && length === 0) length = LOOP;
  const tiles = [];
  for (let k = 1; k <= Math.min(40, Math.abs(n)); k++) {
    const idx = wrap(a + dir * k);
    const d = (dir > 0 ? fwd(sOf(idx) - s0) : fwd(s0 - sOf(idx))) || LOOP;
    tiles.push({ index: idx, s: s0 + dir * d, at: d / (length || 1) });
  }
  const goS = dir > 0 && a !== 0 && s0 + length >= LOOP - 1e-6 ? LOOP : null;
  return { from: a, to, steps: n, dir, s0, s1: s0 + dir * length, length, goS, goAt: goS === null ? null : (LOOP - s0) / length, tiles };
}

// ---- parking slots -------------------------------------------------------------------------------
export const JAIL_YARD = Object.freeze({ minX: -168, maxX: -144, minZ: 146, maxZ: 166, rows: [151, 161], gate: { x: -146, z: 146 } });
const LANE_BLOCK = 24, GAP_VEH = 1.2, GAP_WALK = 0.8, WALK_BLOCK = 20;
export const DOUBLE_LAT = M.TRAFFIC_C[1] - M.LANE;   // −3.375 (double-parked in the outer traffic lane)
export const WALK_LAT = M.WALK_OUT_C - M.LANE;       // +4.25 (sidewalk walking line)
function pack(list, gap, max) {
  const keep = [], over = []; let used = 0;
  for (const m of list) {
    const need = keep.length ? used + gap + m.length : m.length;
    if (need <= max) { keep.push(m); used = need; } else over.push(m);
  }
  const placed = []; let front = used / 2;           // first member is frontmost (ahead in travel direction)
  for (const m of keep) { placed.push({ m, along: front - m.length / 2 }); front -= m.length + gap; }
  return { placed, over };
}
/**
 * Where characters rest at address i. members: [{ id, kind: 'vehicle'|'walker', length }] in player order
 * (riders such as the penny-farthing count as 'vehicle'). Returns [{ id, x, z, heading, place }] with place
 * 'lane' | 'double' | 'sidewalk' | 'yard'. Never overlaps (≥ 0.8 m gaps), never drops anyone.
 */
export function restSlots(i, members, { jailed = false } = {}) {
  const list = (members ?? []).filter((m) => m && m.id != null)
    .map((m) => ({ id: m.id, kind: m.kind === 'walker' ? 'walker' : 'vehicle', length: Math.max(0.3, Number(m.length) || 1) }));
  const res = [];
  if (jailed && wrap(i) === 10) {
    const rows = [[], []];
    list.forEach((m, k) => rows[k % 2].push(m));
    rows.forEach((row, r) => {
      let x = JAIL_YARD.minX + 2;
      for (const m of row) { res.push({ id: m.id, x: x + m.length / 2, z: JAIL_YARD.rows[r], heading: Math.PI / 2, place: 'yard' }); x += m.length + 1.5; }
    });
    return res;
  }
  const s = sOf(i);
  const lane = pack(list.filter((m) => m.kind === 'vehicle'), GAP_VEH, LANE_BLOCK);
  const dbl = pack(lane.over, GAP_VEH, LANE_BLOCK * 2);
  const walk = pack(list.filter((m) => m.kind === 'walker'), GAP_WALK, WALK_BLOCK);
  const put = (o, lat, shift, place) => { const p = pointAt(s + o.along + shift, lat); res.push({ id: o.m.id, x: p.x, z: p.z, heading: p.heading, place }); };
  lane.placed.forEach((o) => put(o, 0, 0, 'lane'));
  dbl.placed.forEach((o) => put(o, DOUBLE_LAT, 0, 'double'));
  walk.placed.forEach((o) => put(o, WALK_LAT, 3, 'sidewalk'));
  return res;
}

/** Tile under a ground point: the lot, its sidewalk and its token lane (130.5–173); corners: the elbow + L-site. */
export function lotAt(x, z) {
  const ax = Math.abs(x), az = Math.abs(z), m = Math.max(ax, az);
  if (ax >= M.CORE && az >= M.CORE) return m <= M.LOT_BACK ? (x > 0 ? (z > 0 ? 0 : 30) : (z > 0 ? 10 : 20)) : null;
  if (!(m >= M.TRAFFIC_OUT && m <= M.LOT_BACK)) return null;
  let q, along;
  if (az >= ax) { q = z > 0 ? 0 : 2; along = z > 0 ? x : -x; } else { q = x < 0 ? 1 : 3; along = x < 0 ? z : -z; }
  const k = Math.floor((143 - along) / 26);
  return k >= 1 && k <= 9 ? q * 10 + k : null;
}

/** Ground rectangle of lot i (corners: the main 34 × 34 block). */
export function lotRect(i) {
  const { lot } = address(i);
  const horizontal = Math.abs(lot.front.z - lot.cz) > 1;   // south / north lots and corner blocks
  const hw = horizontal ? lot.w / 2 : lot.d / 2, hd = horizontal ? lot.d / 2 : lot.w / 2;
  return { minX: lot.cx - hw, maxX: lot.cx + hw, minZ: lot.cz - hd, maxZ: lot.cz + hd };
}

/** Any closed clockwise ring parallel to the loop: half-size h, corner centres at ±c (radius h − c). From the SE apex. */
export function ringPath(h, { c = Math.min(M.ARC_C, h - 2), step = 2 } = {}) {
  const r = h - c, straight = 2 * c, arc = (Math.PI / 2) * r, quarter = straight + arc, length = 4 * quarter;
  const centres = SIGN.map(([x, z]) => ({ x: x * c, z: z * c }));
  const n = Math.max(16, Math.round(length / step)), points = [];
  for (let j = 0; j < n; j++) {
    let s = (j / n) * length; const q = Math.min(3, Math.floor(s / quarter)); s -= q * quarter; const o = {};
    if (s < arc / 2) arcPoint(centres[q], Math.PI / 4 + q * Math.PI / 2 + s / r, r, o);
    else if (s < arc / 2 + straight) {
      const u = s - arc / 2, a = ALONG[q], nn = OUT[q], C = centres[q];
      o.x = C.x + r * nn.x + a.x * u; o.z = C.z + r * nn.z + a.z * u; o.heading = Math.atan2(a.x, a.z); o.nx = nn.x; o.nz = nn.z;
    } else { const q1 = (q + 1) % 4; arcPoint(centres[q1], Math.PI / 4 + q1 * Math.PI / 2 - (quarter - s) / r, r, o); }
    points.push(o);
  }
  return { h, c, r, length, points };
}
export const RINGS = Object.freeze({
  lane: { h: 132.25, c: 123.25 }, traffic1: { h: 125.625, c: 123.25 }, traffic2: { h: 128.875, c: 123.25 },
  cycle: { h: 123, c: 121 }, walkIn: { h: 119.5, c: 117.5 }, walkOut: { h: 136.5, c: 123.25 },
  service: { h: 177, c: 169 }, railA: { h: 195, c: 155 }, railB: { h: 199, c: 155 },
});

/** §3.10: does a structure on tile i with this street-facing face distance and top height keep the lane visible? */
export function laneClear(i, frontFace, height) {
  i = wrap(i);
  const near = (i % 10 !== 0 && qOf(i) <= 1) || i === 10;
  const cap = [24, 40, 110, 200][qOf(i)];
  if (height > cap + 1e-6 && !(i % 10 === 0)) return false;
  return !near || frontFace >= 135 + 0.5 * height - 1e-6;
}

export const GROUP_TILES = Object.freeze({ brown: [1, 3], lightblue: [6, 8, 9], pink: [11, 13, 14], orange: [16, 18, 19], red: [21, 23, 24], yellow: [26, 27, 29], green: [31, 32, 34], darkblue: [37, 39] });
/** Ground surface for footsteps / tyres: 'asphalt'|'paving'|'cobble'|'grass'|'wood'|'sand'|'gravel'. */
export function surfaceAt(x, z) {
  const ax = Math.abs(x), az = Math.abs(z), m = Math.max(ax, az);
  if (x >= 215 && x < M.SEA_X && az < 400) return 'sand';
  if (x >= M.RAIL_OUT && x < 215 && az < 220) return 'wood';            // promenade deck
  if (m < M.CORE) return x > -80 && x < -20 && z > 25 && z < 75 ? 'paving' : 'grass'; // City Hall Square / park
  if (m < M.WALK_IN) return 'paving';
  if (m < M.KERB) return 'asphalt';                                      // cycle track, traffic and token lanes
  if (m < M.PROP) {                                                      // outer sidewalk
    const oldTown = az >= ax && z > 0 && x < -13, market = ax > az && x < 0 && z > 13;
    return oldTown || market ? 'cobble' : 'paving';
  }
  if (m <= M.LOT_BACK) return 'paving';                                  // forecourts (lane B may refine: lawns → grass)
  if (m <= M.SERVICE_OUT) return 'asphalt';
  if (m <= M.RAIL_OUT) return 'gravel';
  return 'asphalt';
}
/** Ambience zones (lane D's beds): centre, radius, beds. */
export const ZONES = Object.freeze([
  { name: 'brickworks', x: 78, z: 156, r: 70, beds: ['parkBed'] },
  { name: 'oldtown', x: -69, z: 156, r: 70, beds: ['parkBed'] },
  { name: 'market', x: -156, z: 61, r: 70, beds: ['marketBed'] },
  { name: 'midtown', x: -156, z: -69, r: 70, beds: ['trafficBed', 'crowdMurmur'] },
  { name: 'theatre', x: -61, z: -156, r: 70, beds: ['trafficBed', 'crowdMurmur'] },
  { name: 'downtown', x: 61, z: -156, r: 70, beds: ['trafficBed'] },
  { name: 'bank', x: 156, z: -69, r: 70, beds: ['fountainBed', 'windHigh'] },
  { name: 'harbourHeights', x: 156, z: 78, r: 90, beds: ['harbourBed'] },
  { name: 'harbour', x: 320, z: 220, r: 160, beds: ['harbourBed'] },
  { name: 'park', x: 0, z: 0, r: 110, beds: ['parkBed'] },
  { name: 'cityhall', x: -50, z: 50, r: 45, beds: ['fountainBed', 'crowdMurmur'] },
  { name: 'uptown', x: 0, z: -400, r: 250, beds: ['trafficBed'] },
  { name: 'suburbs', x: 0, z: 380, r: 250, beds: ['parkBed'] },
]);
export function angleDelta(a, b) { let d = (b - a) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return d; }
