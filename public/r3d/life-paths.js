// public/r3d/life-paths.js — pure (no three.js, no DOM): closed loops for GPU path instancing (§12).
//
// Ambient traffic and pedestrians are drawn by the GPU: each instance samples a float texture of its
// loop with the city time, so nothing is written per frame. A loop is resampled EVENLY IN TIME (not in
// distance) from a speed profile — slow through tight curves (lateral acceleration limit), smooth
// accelerations (longitudinal limit) and optional dwells (bus stops, stations) — so:
//   * vehicles slow down in corners and at stops "for free" (the samples bunch up there);
//   * instances sharing a loop and a lap rate keep a constant spacing IN TIME and never collide.
//
//   buildPathTexture(loops, { samples = 512 }) → { data, width, rows, periods, lengths }
//     data     Float32Array(width × rows × 4), one row per loop, texel j = sample at time j/width of a lap:
//              R = x (m), G = z (m), B = heading (rad, forward = (sin h, cos h)), A = distance from the
//              loop start (m, in [0, length)) — the walk phase / wheel angle comes from it (feet never slide)
//     periods  seconds per lap at the loop's own speed profile
//     lengths  metres per lap
//   A loop is an array of points [{ x, z, heading? }] (closed: the last point joins the first), or
//   { points, speed = 1 (m/s), aLat = ∞ (m/s², curve limit), aLong = ∞ (m/s², accel/brake limit),
//     vMin = 0, stops: [{ at: point index, dwell: s }] }.
//
// Shader side (life-shaders.js): u = fract(phase + uTime · laps / 3600) with an INTEGER lap count per
// 3600 s (`lapsPerHour`), so the 3600 s wrap of uCityTime never makes anything jump.

const TAU = Math.PI * 2;
export const CITY_HOUR = 3600;

const wrapAngle = (a) => {
  let d = a % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};

function normLoop(loop) {
  if (Array.isArray(loop)) return { points: loop, speed: 1, aLat: Infinity, aLong: Infinity, vMin: 0, stops: [] };
  const o = loop ?? {};
  return {
    points: Array.isArray(o.points) ? o.points : [],
    speed: o.speed > 0 ? o.speed : 1,
    aLat: o.aLat > 0 ? o.aLat : Infinity,
    aLong: o.aLong > 0 ? o.aLong : Infinity,
    vMin: Math.max(0, Number(o.vMin) || 0),
    stops: Array.isArray(o.stops) ? o.stops : [],
  };
}

/**
 * Speed profile and timing of one closed loop. Returns per-point arrays plus the lap period:
 * { n, x, z, h, seg, D, v, arrive, depart, period, length }.
 */
export function loopTiming(loop) {
  const L = normLoop(loop);
  const pts = L.points;
  const n = pts.length;
  if (n < 2) return null;
  const x = new Float64Array(n), z = new Float64Array(n), h = new Float64Array(n);
  for (let i = 0; i < n; i++) { x[i] = Number(pts[i].x) || 0; z[i] = Number(pts[i].z) || 0; }
  const seg = new Float64Array(n); // seg[i]: point i → i+1
  const segH = new Float64Array(n);
  let length = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = x[j] - x[i], dz = z[j] - z[i];
    seg[i] = Math.hypot(dx, dz);
    segH[i] = Math.atan2(dx, dz);
    length += seg[i];
  }
  const D = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) D[i + 1] = D[i] + seg[i];
  for (let i = 0; i < n; i++) {
    const given = pts[i].heading;
    if (Number.isFinite(given)) { h[i] = given; continue; }
    const a = segH[(i - 1 + n) % n];
    h[i] = a + wrapAngle(segH[i] - a) / 2;
  }
  // Curve speed limit from the turning rate at each point.
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = (i - 1 + n) % n;
    const turn = Math.abs(wrapAngle(segH[i] - segH[p]));
    const ds = Math.max(1e-6, (seg[p] + seg[i]) / 2);
    const k = turn / ds;
    let vi = L.speed;
    if (Number.isFinite(L.aLat) && k > 1e-9) vi = Math.min(vi, Math.sqrt(L.aLat / k));
    v[i] = Math.max(Math.min(L.vMin, L.speed), vi);
  }
  const dwell = new Float64Array(n);
  for (const st of L.stops) {
    const i = Math.round(Number(st?.at));
    if (i >= 0 && i < n) { v[i] = 0; dwell[i] += Math.max(0, Number(st.dwell) || 0); }
  }
  // Acceleration limits, forward then backward, twice round the loop (closure).
  if (Number.isFinite(L.aLong)) {
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        v[j] = Math.min(v[j], Math.sqrt(v[i] * v[i] + 2 * L.aLong * seg[i]));
      }
    }
    for (let pass = 0; pass < 2; pass++) {
      for (let i = n - 1; i >= 0; i--) {
        const j = (i + 1) % n;
        v[i] = Math.min(v[i], Math.sqrt(v[j] * v[j] + 2 * L.aLong * seg[i]));
      }
    }
  }
  // A segment between two stopped points (or zero speed everywhere) would never end: keep a crawl.
  const floor = Math.max(1e-3, L.speed * 1e-3);
  const arrive = new Float64Array(n + 1), depart = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    depart[i] = arrive[i] + dwell[i];
    const j = (i + 1) % n;
    const vm = Math.max(floor, (v[i] + v[j]) / 2);
    arrive[i + 1] = depart[i] + seg[i] / vm;
  }
  return { n, x, z, h, seg, D, v, arrive, depart, period: arrive[n], length };
}

/**
 * Samples one loop evenly in time into `out` (Float32Array, `samples` × 4 floats from `offset`).
 * Within a segment the speed changes linearly with distance-time (constant acceleration).
 */
export function resampleLoop(loop, samples, out = new Float32Array(samples * 4), offset = 0) {
  const T = loop && loop.arrive ? loop : loopTiming(loop);
  if (!T) return { data: out, period: 1, length: 0 };
  const { n, x, z, h, seg, D, v, arrive, depart, period } = T;
  let i = 0;
  for (let k = 0; k < samples; k++) {
    const t = (k / samples) * period;
    while (i < n - 1 && t >= arrive[i + 1]) i++;
    let px, pz, ph, pd;
    if (t < depart[i]) { // dwelling at point i
      px = x[i]; pz = z[i]; ph = h[i]; pd = D[i];
    } else {
      const j = (i + 1) % n;
      const dt = Math.max(1e-9, arrive[i + 1] - depart[i]);
      const tau = Math.min(dt, t - depart[i]);
      const v0 = v[i], v1 = v[j];
      let s;
      if (Math.max(v0, v1) < 1e-6) s = seg[i] * (tau / dt);
      else s = v0 * tau + 0.5 * ((v1 - v0) / dt) * tau * tau;
      const f = seg[i] > 1e-9 ? Math.min(1, Math.max(0, s / seg[i])) : 0;
      px = x[i] + (x[j] - x[i]) * f;
      pz = z[i] + (z[j] - z[i]) * f;
      ph = wrapAngle(h[i] + wrapAngle(h[j] - h[i]) * f);
      pd = D[i] + seg[i] * f;
    }
    const o = offset + k * 4;
    out[o] = px;
    out[o + 1] = pz;
    out[o + 2] = ph;
    out[o + 3] = pd >= T.length ? pd - T.length : pd;
  }
  return { data: out, period, length: T.length };
}

/** One float texture (rows = loops) of time-evenly resampled loops. */
export function buildPathTexture(loops, { samples = 512 } = {}) {
  const list = Array.isArray(loops) ? loops : [];
  const width = Math.max(2, Math.floor(samples));
  const rows = Math.max(1, list.length);
  const data = new Float32Array(width * rows * 4);
  const periods = [], lengths = [];
  list.forEach((loop, r) => {
    const res = resampleLoop(loop, width, data, r * width * 4);
    periods.push(res.period);
    lengths.push(res.length);
  });
  return { data, width, rows, periods, lengths };
}

/**
 * Integer laps per 3600 s for a loop of `period` seconds at `speedMul` × its own speed (≥ 1). The shader
 * advances u by uCityTime · laps / 3600, so the 3600 s wrap never makes anything jump.
 */
export function lapsPerHour(period, speedMul = 1) {
  return Math.max(1, Math.round((CITY_HOUR / Math.max(1e-6, period)) * Math.max(1e-6, speedMul)));
}

/** CPU mirror of the shader lookup: the sample of `row` at lap fraction u (0..1). */
export function sampleRow(tex, row, u, out = {}) {
  const W = tex.width;
  const f0 = (((u % 1) + 1) % 1) * W;
  const i0 = Math.floor(f0) % W;
  const i1 = (i0 + 1) % W;
  const f = f0 - Math.floor(f0);
  const a = (row * W + i0) * 4, b = (row * W + i1) * 4, d = tex.data;
  out.x = d[a] + (d[b] - d[a]) * f;
  out.z = d[a + 1] + (d[b + 1] - d[a + 1]) * f;
  out.heading = wrapAngle(d[a + 2] + wrapAngle(d[b + 2] - d[a + 2]) * f);
  let db = d[b + 3];
  if (db < d[a + 3]) db += tex.lengths?.[row] ?? 0;
  out.dist = d[a + 3] + (db - d[a + 3]) * f;
  return out;
}

// ---- loop builders ------------------------------------------------------------------------------------
// All loops run CLOCKWISE seen from above (x east, z south) unless built otherwise; the heading of a point
// is the direction of travel.

/** Point at arc length s on a rounded-square ring (half-size h, corner centres ±c), from the SE apex. */
export function ringPoint(h, c, s, out = {}) {
  const r = h - c, straight = 2 * c, arc = (Math.PI / 2) * r, quarter = straight + arc, length = 4 * quarter;
  s = ((s % length) + length) % length;
  const q = Math.min(3, Math.floor(s / quarter));
  let u = s - q * quarter;
  const SIGN = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  const ALONG = [[-1, 0], [0, -1], [1, 0], [0, 1]];
  const OUT = [[0, 1], [-1, 0], [0, -1], [1, 0]];
  const arcAt = (qq, phi) => {
    const [sx, sz] = SIGN[qq];
    out.x = sx * c + r * Math.cos(phi);
    out.z = sz * c + r * Math.sin(phi);
    out.heading = Math.atan2(-Math.sin(phi), Math.cos(phi));
    return out;
  };
  if (u < arc / 2) return arcAt(q, Math.PI / 4 + (q * Math.PI) / 2 + u / Math.max(1e-9, r));
  u -= arc / 2;
  if (u < straight) {
    const [sx, sz] = SIGN[q], [ax, az] = ALONG[q], [nx, nz] = OUT[q];
    out.x = sx * c + r * nx + ax * u;
    out.z = sz * c + r * nz + az * u;
    out.heading = Math.atan2(ax, az);
    return out;
  }
  u -= straight;
  const q1 = (q + 1) % 4;
  return arcAt(q1, Math.PI / 4 + (q1 * Math.PI) / 2 - (arc / 2 - u) / Math.max(1e-9, r));
}

/** Length of that ring. */
export const ringLength = (h, c) => 4 * (2 * c + (Math.PI / 2) * (h - c));

/** A rounded-square ring as points every ~`step` m (dense on the corners), clockwise from the SE apex. */
export function ringLoop(h, c, { step = 1, arcStep = 0.5 } = {}) {
  const r = h - c, straight = 2 * c, arc = (Math.PI / 2) * r, quarter = straight + arc;
  const pts = [];
  const nArc = Math.max(2, Math.ceil(arc / 2 / Math.max(0.05, arcStep)));
  const nStr = Math.max(1, Math.ceil(straight / Math.max(0.1, step)));
  for (let q = 0; q < 4; q++) {
    const base = q * quarter;
    for (let k = 0; k < nArc; k++) pts.push(ringPoint(h, c, base + (k / nArc) * (arc / 2), {}));
    for (let k = 0; k < nStr; k++) pts.push(ringPoint(h, c, base + arc / 2 + (k / nStr) * straight, {}));
    for (let k = 0; k < nArc; k++) pts.push(ringPoint(h, c, base + arc / 2 + straight + (k / nArc) * (arc / 2), {}));
  }
  return pts;
}

/** An ellipse (centre, semi-axes a along x, b along z), clockwise from above when `cw`. */
export function ellipseLoop(cx, cz, a, b, { n = 96, cw = true, phase = 0 } = {}) {
  const pts = [];
  const dir = cw ? 1 : -1;
  for (let k = 0; k < n; k++) {
    const t = phase + dir * (k / n) * TAU;
    const dx = -a * Math.sin(t) * dir, dz = b * Math.cos(t) * dir;
    pts.push({ x: cx + a * Math.cos(t), z: cz + b * Math.sin(t), heading: Math.atan2(dx, dz) });
  }
  return pts;
}

/** A rounded rectangle (centre, width along x, depth along z, corner radius r), clockwise. */
export function rectLoop(cx, cz, w, d, r, { step = 1, cw = true } = {}) {
  const hw = w / 2, hd = d / 2;
  r = Math.max(0.5, Math.min(r, hw - 0.01, hd - 0.01));
  const pts = [];
  // corners clockwise from above starting at the SE corner (as the rings do)
  const corners = [[hw - r, hd - r, 0], [-(hw - r), hd - r, 1], [-(hw - r), -(hd - r), 2], [hw - r, -(hd - r), 3]];
  for (const [ccx, ccz, q] of corners) {
    const a0 = (q * Math.PI) / 2; // arc from angle a0 to a0 + π/2 (increasing angle = clockwise)
    const nA = Math.max(3, Math.ceil(((Math.PI / 2) * r) / (step * 0.5)));
    for (let k = 0; k < nA; k++) {
      const a = a0 + (k / nA) * (Math.PI / 2);
      pts.push({ x: cx + ccx + r * Math.cos(a), z: cz + ccz + r * Math.sin(a) });
    }
    // straight to the next corner
    const next = corners[(q + 1) % 4];
    const a1 = a0 + Math.PI / 2;
    const sx = cx + ccx + r * Math.cos(a1), sz = cz + ccz + r * Math.sin(a1);
    const a2 = ((q + 1) * Math.PI) / 2;
    const ex = cx + next[0] + r * Math.cos(a2), ez = cz + next[1] + r * Math.sin(a2);
    const len = Math.hypot(ex - sx, ez - sz);
    const nS = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < nS; k++) pts.push({ x: sx + ((ex - sx) * k) / nS, z: sz + ((ez - sz) * k) / nS });
  }
  return cw ? pts : pts.reverse();
}

/** Densifies an open polyline with rounded corners (fillet radius `radius`), points every ~`step` m. */
export function smoothPolyline(points, { radius = 20, step = 2 } = {}) {
  const P = points.map((p) => ({ x: p.x, z: p.z }));
  if (P.length < 2) return P;
  const out = [];
  const pushLine = (a, b) => {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  };
  let start = P[0];
  for (let i = 1; i < P.length - 1; i++) {
    const A = P[i - 1], B = P[i], C = P[i + 1];
    const u1x = B.x - A.x, u1z = B.z - A.z, l1 = Math.hypot(u1x, u1z) || 1;
    const u2x = C.x - B.x, u2z = C.z - B.z, l2 = Math.hypot(u2x, u2z) || 1;
    const turn = wrapAngle(Math.atan2(u2x, u2z) - Math.atan2(u1x, u1z));
    const cut = Math.min(radius * Math.tan(Math.abs(turn) / 2), l1 * 0.45, l2 * 0.45);
    const p1 = { x: B.x - (u1x / l1) * cut, z: B.z - (u1z / l1) * cut };
    const p2 = { x: B.x + (u2x / l2) * cut, z: B.z + (u2z / l2) * cut };
    pushLine(start, p1);
    // quadratic Bézier through the corner (close to a circular fillet for moderate turns)
    const n = Math.max(2, Math.ceil((cut * 2) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push({ x: (1 - t) ** 2 * p1.x + 2 * (1 - t) * t * B.x + t * t * p2.x, z: (1 - t) ** 2 * p1.z + 2 * (1 - t) * t * B.z + t * t * p2.z });
    }
    start = p2;
  }
  pushLine(start, P[P.length - 1]);
  out.push({ ...P[P.length - 1] });
  return out;
}

/**
 * An out-and-back loop along an open polyline: out on the right-hand lane (`offset` m right of the
 * centre line), a U-turn round the far end, back on the other lane, a U-turn round the start.
 */
export function outAndBack(polyline, { offset = 1.6, step = 2, radius = 20 } = {}) {
  const P = smoothPolyline(polyline, { radius, step });
  const n = P.length;
  if (n < 2) return [];
  const head = (i) => {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
    return Math.atan2(b.x - a.x, b.z - a.z);
  };
  const right = (hh) => ({ x: -Math.cos(hh), z: Math.sin(hh) }); // right of travel for forward (sin h, cos h)
  const pts = [];
  for (let i = 0; i < n; i++) { const hh = head(i), R = right(hh); pts.push({ x: P[i].x + R.x * offset, z: P[i].z + R.z * offset }); }
  const turn = (C, hh, sign) => { // half circle round C from its right side to its left side, ahead (sign 1) of it
    const R = right(hh), F = { x: Math.sin(hh), z: Math.cos(hh) };
    const m = Math.max(4, Math.ceil((Math.PI * offset) / 0.5));
    for (let k = 1; k < m; k++) {
      const th = (k / m) * Math.PI;
      pts.push({ x: C.x + offset * (R.x * Math.cos(th) + sign * F.x * Math.sin(th)), z: C.z + offset * (R.z * Math.cos(th) + sign * F.z * Math.sin(th)) });
    }
  };
  turn(P[n - 1], head(n - 1), 1);
  for (let i = n - 1; i >= 0; i--) { const hh = head(i), R = right(hh); pts.push({ x: P[i].x - R.x * offset, z: P[i].z - R.z * offset }); }
  // round the start: travelling backwards (heading + π) the "right" side is the outbound lane
  turn(P[0], head(0) + Math.PI, 1);
  return pts;
}

/** Index of the loop point nearest to (x, z). */
export function nearestIndex(points, x, z) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = (points[i].x - x) ** 2 + (points[i].z - z) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
