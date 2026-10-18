// public/r3d/world-build.js — geometry builders for the world (lane A): a growable non-indexed
// triangle buffer with extra per-vertex attributes, bands that follow the city's rounded-square
// rings (roads, kerbs, sidewalks, the rail bed), and boxes with facade coordinates for windows.
//
// Everything here runs once at world generation; nothing allocates per frame.

import * as THREE from './three.js';
import { M, QUARTER, HALF_ARC, STRAIGHT } from './city-layout.js';

const SIGN = [[1, 1], [-1, 1], [-1, -1], [1, -1]]; // corner quadrant signs (x, z) per side q
const OUT = [[0, 1], [-1, 0], [0, -1], [1, 0]]; // outward normal of side q
const ALONG = [[-1, 0], [0, -1], [1, 0], [0, 1]]; // travel direction of side q
export const LOT_BOUNDS = [117, 91, 65, 39, 13, -13, -39, -65, -91, -117]; // lot boundaries along a side

/** Growable typed array. */
class Grow {
  constructor(n = 4096) {
    this.a = new Float32Array(n);
    this.n = 0;
  }
  push(...v) {
    if (this.n + v.length > this.a.length) {
      const b = new Float32Array(Math.max(this.a.length * 2, this.n + v.length));
      b.set(this.a);
      this.a = b;
    }
    for (let k = 0; k < v.length; k++) this.a[this.n++] = v[k];
  }
  view() { return this.a.subarray(0, this.n); }
}

const tmpCol = new THREE.Color();
const vA = new THREE.Vector3();
const vB = new THREE.Vector3();
const vC = new THREE.Vector3();

/**
 * A non-indexed triangle buffer: position, normal, color (+ an optional extra vec4 attribute, e.g.
 * the street's aG = (s, lat, kind, u) or a facade's aFacade = (u, v, style, seed)).
 */
export class MeshBuf {
  constructor(extra = null) {
    this.extra = extra; // attribute name or null
    this.p = new Grow();
    this.nrm = new Grow();
    this.c = new Grow();
    this.e = extra ? new Grow() : null;
  }

  get count() { return this.p.n / 3; }

  vert(x, y, z, nx, ny, nz, r, g, b, e0 = 0, e1 = 0, e2 = 0, e3 = 0) {
    this.p.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.c.push(r, g, b);
    if (this.e) this.e.push(e0, e1, e2, e3);
  }

  /**
   * A quad A-B-C-D (each [x, y, z]) facing roughly `n` ([nx, ny, nz]; winding fixed to match).
   * col: THREE.Color | [r, g, b]; ex: 4 arrays of 4 extra values (or one shared array).
   */
  quad(A, B, C, D, n, col, ex = null, normals = null) {
    vA.set(B[0] - A[0], B[1] - A[1], B[2] - A[2]);
    vB.set(C[0] - A[0], C[1] - A[1], C[2] - A[2]);
    vC.crossVectors(vA, vB);
    const flip = vC.x * n[0] + vC.y * n[1] + vC.z * n[2] < 0;
    const r = col.r ?? col[0];
    const g = col.g ?? col[1];
    const b = col.b ?? col[2];
    const E = (k) => (ex ? (Array.isArray(ex[0]) ? ex[k] : ex) : [0, 0, 0, 0]);
    const N = (k) => (normals ? normals[k] : n);
    const order = flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
    const P = [A, B, C, D];
    for (const k of order) {
      const p = P[k];
      const e = E(k);
      const nn = N(k);
      this.vert(p[0], p[1], p[2], nn[0], nn[1], nn[2], r, g, b, e[0], e[1], e[2], e[3]);
    }
  }

  /** Appends a THREE geometry (consumed) transformed by `matrix`, in one colour, extra = `ex`. */
  addGeometry(geo, matrix, col, ex = null) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (matrix) g.applyMatrix4(matrix);
    if (!g.attributes.normal) g.computeVertexNormals();
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    const vc = g.attributes.color;
    tmpCol.set(col ?? '#ffffff');
    for (let k = 0; k < pos.count; k++) {
      const r = vc ? vc.getX(k) : tmpCol.r;
      const gg = vc ? vc.getY(k) : tmpCol.g;
      const b = vc ? vc.getZ(k) : tmpCol.b;
      this.vert(pos.getX(k), pos.getY(k), pos.getZ(k), nor.getX(k), nor.getY(k), nor.getZ(k), r, gg, b, ...(ex ?? [0, 0, 0, 0]));
    }
    if (g !== geo) g.dispose();
    geo.dispose();
  }

  build() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.p.view().slice(), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.nrm.view().slice(), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.c.view().slice(), 3));
    if (this.e) geo.setAttribute(this.extra, new THREE.BufferAttribute(this.e.view().slice(), 4));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }
}

// ---- rings (bands parallel to the loop) ----------------------------------------------------------

/** A point on the rounded-square boundary of half-size h with corner centres at ±c (sharp when h ≤ c). */
function boundary(h, c, q, seg, t, along) {
  const rc = Math.max(0, h - c);
  const cc = h - rc;
  const q1 = (q + 1) % 4;
  if (seg === 0) {
    const phi = Math.PI / 4 + (q * Math.PI) / 2 + t * (Math.PI / 4);
    return { x: SIGN[q][0] * cc + rc * Math.cos(phi), z: SIGN[q][1] * cc + rc * Math.sin(phi), nx: Math.cos(phi), nz: Math.sin(phi) };
  }
  if (seg === 2) {
    const phi = (q1 * Math.PI) / 2 + t * (Math.PI / 4);
    return { x: SIGN[q1][0] * cc + rc * Math.cos(phi), z: SIGN[q1][1] * cc + rc * Math.sin(phi), nx: Math.cos(phi), nz: Math.sin(phi) };
  }
  // Straight: `along` runs from +cc to −cc in the side's own coordinate (south: x, west: z, north: −x, east: −z).
  const a = Math.min(cc, Math.max(-cc, along));
  return {
    x: SIGN[q][0] * cc + rc * OUT[q][0] + ALONG[q][0] * (cc - a),
    z: SIGN[q][1] * cc + rc * OUT[q][1] + ALONG[q][1] * (cc - a),
    nx: OUT[q][0],
    nz: OUT[q][1],
  };
}

/** Token-lane arc length of a ring sample (projection; see world-ground.js). */
function sOfSample(q, seg, t, along) {
  if (seg === 0) return q * QUARTER + t * HALF_ARC;
  if (seg === 2) return q * QUARTER + HALF_ARC + STRAIGHT + t * HALF_ARC;
  return q * QUARTER + HALF_ARC + (M.ARC_C - along);
}

/**
 * The samples of one lap of a band between two rings: for every sample the inner and outer points,
 * the token-lane s, the side q and segment. Arcs use `arcN` angle steps per half corner; straights
 * break at `breaks` (along values) and every `step` metres.
 */
export function ringSamples(inner, outer, { arcN = 6, breaks = LOT_BOUNDS, step = 26 } = {}) {
  const out = [];
  for (let q = 0; q < 4; q++) {
    for (let j = 0; j <= arcN; j++) out.push(sample(q, 0, j / arcN, 0));
    const cMax = Math.max(Math.min(inner.h, inner.c), Math.min(outer.h, outer.c));
    const alongs = [cMax, ...breaks.filter((b) => Math.abs(b) < cMax - 0.01)];
    for (let a = cMax - step; a > -cMax; a -= step) if (!alongs.some((b) => Math.abs(b - a) < step * 0.3)) alongs.push(a);
    alongs.push(-cMax);
    alongs.sort((x, y) => y - x);
    for (const a of alongs) out.push(sample(q, 1, 0, a));
    for (let j = 0; j <= arcN; j++) out.push(sample(q, 2, j / arcN, 0));
  }
  return out;
  function sample(q, seg, t, along) {
    const i = boundary(inner.h, inner.c, q, seg, t, along);
    const o = boundary(outer.h, outer.c, q, seg, t, along);
    return { q, seg, t, along, s: sOfSample(q, seg, t, along), inner: i, outer: o };
  }
}

/**
 * Emits a flat (or sloped) band between two rings into a MeshBuf with aG = (s, lat, kind, u):
 * lat = distance from the token-lane centre line (h − 132.25), u = metres along the band's middle.
 * `info(sampleA, sampleB)` → { kind, color, skip } per segment.
 */
export function ringBand(buf, inner, outer, { y0 = 0, y1 = y0, arcN, breaks, step, info = () => ({}) } = {}) {
  const S = ringSamples(inner, outer, { arcN, breaks, step });
  const latI = inner.h - M.LANE;
  const latO = outer.h - M.LANE;
  const up = [0, 1, 0];
  // Sloped bands: an approximate normal (outward tilt).
  const slope = (y1 - y0) / Math.max(0.01, outer.h - inner.h);
  let u = 0;
  for (let k = 0; k + 1 < S.length; k++) {
    const a = S[k];
    const b = S[k + 1];
    const ma = mid(a);
    const mb = mid(b);
    const du = Math.hypot(mb.x - ma.x, mb.z - ma.z);
    if (du < 1e-5 && Math.hypot(a.outer.x - b.outer.x, a.outer.z - b.outer.z) < 1e-5) continue; // collapsed (sharp corner)
    const seg = info(a, b) ?? {};
    if (!seg.skip) {
      const kind = seg.kind ?? 0;
      const col = seg.color ?? [1, 1, 1];
      const n = slope === 0 ? up : [a.inner.nx * -slope, 1, a.inner.nz * -slope];
      const L = Math.hypot(n[0], n[1], n[2]);
      const nn = [n[0] / L, n[1] / L, n[2] / L];
      buf.quad(
        [a.inner.x, y0, a.inner.z], [a.outer.x, y1, a.outer.z], [b.outer.x, y1, b.outer.z], [b.inner.x, y0, b.inner.z],
        nn, col,
        [[a.s, latI, kind, u], [a.s, latO, kind, u], [b.s, latO, kind, u + du], [b.s, latI, kind, u + du]],
      );
    }
    u += du;
  }
}

/** A vertical face along one ring (a kerb, a wall), facing outward (dir +1) or inward (−1). */
export function ringFace(buf, ring, { y0 = 0, y1 = 0.15, dir = 1, arcN, breaks, step, kind = 3, color = [1, 1, 1], info = null } = {}) {
  const S = ringSamples(ring, ring, { arcN, breaks, step });
  const lat = ring.h - M.LANE;
  let u = 0;
  for (let k = 0; k + 1 < S.length; k++) {
    const a = S[k].outer;
    const b = S[k + 1].outer;
    const du = Math.hypot(b.x - a.x, b.z - a.z);
    if (du < 1e-5) continue;
    const seg = info ? info(S[k], S[k + 1]) ?? {} : {};
    if (seg.skip) {
      u += du;
      continue;
    }
    const na = [a.nx * dir, 0, a.nz * dir];
    const nb = [b.nx * dir, 0, b.nz * dir];
    // Straight segments use the side normal; corners interpolate.
    const n = [(na[0] + nb[0]) / 2, 0, (na[2] + nb[2]) / 2];
    buf.quad(
      [a.x, y0, a.z], [b.x, y0, b.z], [b.x, y1, b.z], [a.x, y1, a.z],
      n, seg.color ?? color,
      [[S[k].s, lat, seg.kind ?? kind, u], [S[k + 1].s, lat, seg.kind ?? kind, u + du], [S[k + 1].s, lat + 0.001, seg.kind ?? kind, u + du], [S[k].s, lat + 0.001, seg.kind ?? kind, u]],
      [na, nb, nb, na],
    );
    u += du;
  }
}

function mid(sm) {
  return { x: (sm.inner.x + sm.outer.x) / 2, z: (sm.inner.z + sm.outer.z) / 2 };
}

/** Points along one ring, every `step` m (arcs by angle). For rails, kerbs of other things. */
export function ringPoints(ring, { arcN = 8, step = 20, breaks = [] } = {}) {
  return ringSamples(ring, ring, { arcN, step, breaks }).map((s) => s.outer);
}

// ---- boxes with facade coordinates ------------------------------------------------------------

const FACES = [
  // [normal, corners as (sx, sy, sz) of the unit box, along-axis]
  { n: [0, 0, 1], c: [[-1, 0, 1], [1, 0, 1], [1, 1, 1], [-1, 1, 1]], ax: 0 },
  { n: [0, 0, -1], c: [[1, 0, -1], [-1, 0, -1], [-1, 1, -1], [1, 1, -1]], ax: 0 },
  { n: [1, 0, 0], c: [[1, 0, 1], [1, 0, -1], [1, 1, -1], [1, 1, 1]], ax: 2 },
  { n: [-1, 0, 0], c: [[-1, 0, -1], [-1, 0, 1], [-1, 1, 1], [-1, 1, -1]], ax: 2 },
  { n: [0, 1, 0], c: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]], ax: -1 },
];

/**
 * A box standing on y = base (w along local x, d along local z, h tall), rotated `yaw` about +Y
 * around (x, z). Walls get facade coordinates (u along the wall, v up from the base) and `style`;
 * the roof style 0. `roofColor` (default: col).
 */
export function facadeBox(buf, { x, z, base = 0, w, h, d, yaw = 0, color, roofColor = null, style = 1, seed = 0, top = true, vOffset = 0 }) {
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const col = tmpCol.set(color).toArray();
  const roof = roofColor ? new THREE.Color(roofColor).toArray() : col;
  for (const f of FACES) {
    if (f.ax === -1 && !top) continue;
    const P = f.c.map(([sx, sy, sz]) => {
      const lx = (sx * w) / 2;
      const lz = (sz * d) / 2;
      return [x + lx * cs + lz * sn, base + sy * h, z - lx * sn + lz * cs];
    });
    const n = [f.n[0] * cs + f.n[2] * sn, f.n[1], -f.n[0] * sn + f.n[2] * cs];
    const len = f.ax === 0 ? w : d;
    const ex = f.c.map(([sx, sy, sz]) => (f.ax === -1
      ? [0, 0, 0, seed]
      : [(f.ax === 0 ? sx * f.n[2] : -sz * f.n[0]) * len / 2 + len / 2 + seed * 7.3, sy * h + vOffset, style, seed]));
    buf.quad(P[0], P[1], P[2], P[3], n, f.ax === -1 ? roof : col, ex);
  }
}

/** A gabled roof (ridge along local x) on a w × d footprint at height `base`, rise `rise`. */
export function gableRoof(buf, { x, z, base, w, d, rise, yaw = 0, color, overhang = 0.3 }) {
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const W = w / 2 + overhang;
  const D = d / 2 + overhang;
  const T = (lx, ly, lz) => [x + lx * cs + lz * sn, base + ly, z - lx * sn + lz * cs];
  const R = (nx, ny, nz) => [nx * cs + nz * sn, ny, -nx * sn + nz * cs];
  const col = tmpCol.set(color).toArray();
  const slopeN = (s) => {
    const L = Math.hypot(rise, D);
    return R(0, D / L, (s * rise) / L);
  };
  buf.quad(T(-W, 0, D), T(W, 0, D), T(W, rise, 0), T(-W, rise, 0), slopeN(1), col);
  buf.quad(T(W, 0, -D), T(-W, 0, -D), T(-W, rise, 0), T(W, rise, 0), slopeN(-1), col);
  // Gable ends (triangles as degenerate quads).
  const wall = col.map((v) => v * 0.92);
  buf.quad(T(w / 2, 0, -d / 2), T(w / 2, 0, d / 2), T(w / 2, rise, 0), T(w / 2, rise, 0), R(1, 0, 0), wall);
  buf.quad(T(-w / 2, 0, d / 2), T(-w / 2, 0, -d / 2), T(-w / 2, rise, 0), T(-w / 2, rise, 0), R(-1, 0, 0), wall);
}

export { SIGN, OUT, ALONG };
