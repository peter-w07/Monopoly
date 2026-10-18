// public/r3d/world-core.js — the civic core inside the loop (city design §3.6): City Hall Square
// (City Hall with a 34 m clock tower, the fountain, the bandstand), formal gardens, a playground and
// a five-a-side pitch, the lake with its boathouse and stone bridge, the civic quarter (museum,
// library, domed courthouse), and Central Park's lawns, paths and trees. Everything stays under the
// §3.6 height caps so it never hides a street from the helicopter seat.

import * as THREE from './three.js';
import { facadeBox, gableRoof } from './world-build.js';
import { K } from './world-ground.js';
import { rng } from './world-geo.js';

export const LAKE = { x: -35, z: -45, a: 55, b: 25, y: -0.4 };
export const SQUARE = { x0: -85, x1: -15, z0: 25, z1: 75 };
export const CITY_HALL = { x: -50, z: 17, w: 50, d: 16, h: 14 };
export const FOUNTAIN = { x: -50, z: 52, r: 7 };
const GARDEN = { x0: 20, x1: 92, z0: 14, z1: 66 };
const PITCH = { x0: 54, x1: 94, z0: 78, z1: 98 };
const PLAY = { x0: 18, x1: 44, z0: 76, z1: 98 };
const CIVIC = { x0: 30, x1: 92, z0: -92, z1: -30 };
const CENTRAL = { x: 0, z: 4, r: 13 };

const col = (hex) => new THREE.Color(hex);
const M4 = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const V = new THREE.Vector3();
const S = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

function put(buf, geo, x, y, z, { yaw = 0, sx = 1, sy = 1, sz = 1, color = '#ffffff', ex = null } = {}) {
  Q.setFromAxisAngle(Y, yaw);
  M4.compose(V.set(x, y, z), Q, S.set(sx, sy, sz));
  buf.addGeometry(geo, M4, col(color), ex);
}

/** A flat strip along a polyline (closed or open) into the street buffer (aG: s 0, lat across, kind, u). */
export function pathStrip(street, pts, width, kind, { y = 0.04, closed = false, color = [1, 1, 1] } = {}) {
  const n = pts.length;
  const segs = closed ? n : n - 1;
  let u = 0;
  const half = width / 2;
  const normalAt = (k) => {
    const a = pts[(k - 1 + n) % n];
    const b = pts[(k + 1) % n];
    const p0 = !closed && k === 0 ? pts[0] : a;
    const p1 = !closed && k === n - 1 ? pts[n - 1] : b;
    let dx = p1[0] - p0[0];
    let dz = p1[1] - p0[1];
    const L = Math.hypot(dx, dz) || 1;
    dx /= L;
    dz /= L;
    return [-dz, dx];
  };
  for (let k = 0; k < segs; k++) {
    const a = pts[k];
    const b = pts[(k + 1) % n];
    const na = normalAt(k);
    const nb = normalAt((k + 1) % n);
    const du = Math.hypot(b[0] - a[0], b[1] - a[1]);
    street.quad(
      [a[0] - na[0] * half, y, a[1] - na[1] * half], [a[0] + na[0] * half, y, a[1] + na[1] * half],
      [b[0] + nb[0] * half, y, b[1] + nb[1] * half], [b[0] - nb[0] * half, y, b[1] - nb[1] * half],
      [0, 1, 0], color,
      [[0, -half, kind, u], [0, half, kind, u], [0, half, kind, u + du], [0, -half, kind, u + du]],
    );
    u += du;
  }
}

/** A flat rectangle (axis aligned) into the street buffer. */
export function rectPatch(street, x0, x1, z0, z1, kind, { y = 0.04, color = [1, 1, 1], latAlongZ = true } = {}) {
  // lat = across (z − centre), u = along x (pattern space)
  const cz = (z0 + z1) / 2;
  street.quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], [0, 1, 0], color,
    [[0, latAlongZ ? z0 - cz : 0, kind, 0], [0, latAlongZ ? z0 - cz : 0, kind, x1 - x0], [0, latAlongZ ? z1 - cz : 0, kind, x1 - x0], [0, latAlongZ ? z1 - cz : 0, kind, 0]]);
}

/** A filled disc (triangle fan) into the street buffer. */
export function discPatch(street, cx, cz, r, kind, { y = 0.04, n = 40, color = [1, 1, 1] } = {}) {
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2;
    const a1 = ((k + 1) / n) * Math.PI * 2;
    const p0 = [cx + r * Math.cos(a0), y, cz + r * Math.sin(a0)];
    const p1 = [cx + r * Math.cos(a1), y, cz + r * Math.sin(a1)];
    street.quad([cx, y, cz], p0, p1, [cx, y, cz], [0, 1, 0], color,
      [[0, 0, kind, 0], [0, r * Math.sin(a0), kind, r * Math.cos(a0)], [0, r * Math.sin(a1), kind, r * Math.cos(a1)], [0, 0, kind, 0]]);
  }
}

function ellipse(cx, cz, a, b, n = 64) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = (k / n) * Math.PI * 2;
    out.push([cx + a * Math.cos(t), cz + b * Math.sin(t)]);
  }
  return out;
}

/**
 * Builds the core. ctx: { street, facade (MeshBuf aFacade, casts shadows), furniture, glow, water, trees }.
 * Returns the obstacles the park trees avoided (for other placements) and anchors.
 */
export function buildCore(ctx) {
  const { street, facade, furniture, glow, water, trees } = ctx;
  const rnd = rng(9173);

  // ---- City Hall Square ------------------------------------------------------------------------
  rectPatch(street, SQUARE.x0, SQUARE.x1, SQUARE.z0, SQUARE.z1, K.PLAZA);
  // Steps up to the portico.
  for (let k = 0; k < 4; k++) {
    put(furniture, new THREE.BoxGeometry(30 - k * 1.2, 0.18, 1.2), CITY_HALL.x, 0.04 + 0.09 + k * 0.18, CITY_HALL.z + CITY_HALL.d / 2 + 5.4 - k * 0.9, { color: '#c9c1b2' });
  }
  // City Hall: limestone block, rusticated base, cornice, a columned portico with a pediment.
  const stone = '#cfc5b3';
  const H = CITY_HALL;
  facadeBox(facade, { x: H.x, z: H.z, base: 0, w: H.w, d: H.d, h: 4.2, color: '#b7ad9b', style: 3, seed: 1 });
  facadeBox(facade, { x: H.x, z: H.z, base: 4.2, w: H.w, d: H.d, h: H.h - 4.2, color: stone, roofColor: '#7f8a8f', style: 1, seed: 2, vOffset: 4.2 });
  facadeBox(facade, { x: H.x, z: H.z, base: H.h, w: H.w + 1, d: H.d + 1, h: 0.8, color: '#e3dccd', style: 0 });
  facadeBox(facade, { x: H.x, z: H.z, base: H.h + 0.8, w: H.w - 6, d: H.d - 4, h: 1.8, color: '#d8cfbe', roofColor: '#6f7c82', style: 0 });
  // Portico (6 columns, entablature, pediment) projecting into the square.
  const pz = H.z + H.d / 2 + 2.6;
  for (let k = 0; k < 6; k++) {
    put(facade, new THREE.CylinderGeometry(0.55, 0.65, 10.5, 12).translate(0, 5.25, 0), H.x - 11 + k * 4.4, 0.75, pz, { color: '#e8e1d2' });
  }
  facadeBox(facade, { x: H.x, z: pz - 0.8, base: 11.2, w: 26, d: 5.4, h: 1.6, color: '#e3dccd', style: 0 });
  const ped = new THREE.Shape();
  ped.moveTo(-13.4, 0);
  ped.lineTo(13.4, 0);
  ped.lineTo(0, 4.2);
  ped.closePath();
  put(facade, new THREE.ExtrudeGeometry(ped, { depth: 5.4, bevelEnabled: false }).translate(0, 0, -2.7), H.x, 12.8, pz - 0.8, { color: '#e8e1d2' });
  // Clock tower: a slender shaft to 34 m with clock faces (lit at night) and a copper cap.
  const T = { x: H.x, z: H.z - 1.5 };
  facadeBox(facade, { x: T.x, z: T.z, base: H.h + 2.6, w: 7, d: 7, h: 9.5, color: stone, style: 3, seed: 5, vOffset: 30 });
  facadeBox(facade, { x: T.x, z: T.z, base: 26.1, w: 7.6, d: 7.6, h: 3.6, color: '#e3dccd', style: 0 });
  facadeBox(facade, { x: T.x, z: T.z, base: 29.7, w: 6.2, d: 6.2, h: 0.6, color: '#d8cfbe', style: 0 });
  put(facade, new THREE.ConeGeometry(4.0, 3.7, 4).rotateY(Math.PI / 4).translate(0, 1.85, 0), T.x, 30.3, T.z, { color: '#4f8f7a' });
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    const fx = Math.sin(a) * 3.83;
    const fz = Math.cos(a) * 3.83;
    put(glow, new THREE.CircleGeometry(1.35, 24), T.x + fx, 27.9, T.z + fz, { yaw: a, color: '#fff3d6' });
    // Hands (dark) a hair in front.
    put(furniture, new THREE.BoxGeometry(0.12, 1.0, 0.04).translate(0, 0.4, 0), T.x + Math.sin(a) * 3.86, 27.9, T.z + Math.cos(a) * 3.86, { yaw: a, color: '#222222' });
    put(furniture, new THREE.BoxGeometry(0.7, 0.12, 0.04).translate(0.3, 0, 0), T.x + Math.sin(a) * 3.87, 27.9, T.z + Math.cos(a) * 3.87, { yaw: a, color: '#222222' });
  }
  // The fountain: basin, rim, a column with two bowls.
  {
    const F = FOUNTAIN;
    put(furniture, new THREE.CylinderGeometry(F.r + 0.5, F.r + 0.6, 0.7, 40, 1, true).translate(0, 0.35, 0), F.x, 0.04, F.z, { color: '#b9b0a0' });
    put(furniture, new THREE.CylinderGeometry(F.r + 0.5, F.r + 0.5, 0.12, 40).translate(0, 0.7, 0), F.x, 0.04, F.z, { color: '#cfc7b6' });
    put(furniture, new THREE.CylinderGeometry(F.r, F.r, 0.2, 40).translate(0, 0.1, 0), F.x, 0.04, F.z, { color: '#6b7a80' });
    put(furniture, new THREE.CylinderGeometry(0.5, 0.7, 3.2, 12).translate(0, 1.6, 0), F.x, 0.04, F.z, { color: '#cfc7b6' });
    put(furniture, new THREE.CylinderGeometry(2.4, 0.6, 0.6, 20).translate(0, 2.4, 0), F.x, 0.04, F.z, { color: '#cfc7b6' });
    put(furniture, new THREE.CylinderGeometry(1.2, 0.35, 0.4, 16).translate(0, 3.4, 0), F.x, 0.04, F.z, { color: '#cfc7b6' });
    water.ice(ellipse(F.x, F.z, F.r - 0.05, F.r - 0.05, 40), 0.55);
  }
  // The bandstand: octagonal platform, eight posts, a striped tent roof.
  {
    const bx = -75;
    const bz = 64;
    put(furniture, new THREE.CylinderGeometry(4.6, 4.8, 0.9, 8).translate(0, 0.45, 0), bx, 0.04, bz, { color: '#a99d8b' });
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      put(furniture, new THREE.CylinderGeometry(0.1, 0.1, 3.0, 6).translate(0, 1.5, 0), bx + Math.cos(a) * 4.1, 0.94, bz + Math.sin(a) * 4.1, { color: '#f0eee8' });
    }
    put(furniture, new THREE.ConeGeometry(5.2, 2.4, 8).translate(0, 1.2, 0), bx, 3.94, bz, { color: '#c84a3a' });
    put(furniture, new THREE.SphereGeometry(0.3, 8, 6), bx, 6.5, bz, { color: '#d9b34a' });
  }
  // Square lamps (glow at night) and benches.
  for (const [lx, lz] of [[-82, 28], [-18, 28], [-82, 72], [-18, 72], [-50, 76], [-62, 40], [-38, 40]]) {
    put(furniture, new THREE.CylinderGeometry(0.07, 0.1, 4.2, 6).translate(0, 2.1, 0), lx, 0.04, lz, { color: '#2c3236' });
    put(glow, new THREE.SphereGeometry(0.28, 10, 8), lx, 4.45, lz, { color: '#ffe2b0' });
  }

  // ---- paths ---------------------------------------------------------------------------------
  // The central round plaza with an obelisk (10 m, under the 12 m park cap).
  discPatch(street, CENTRAL.x, CENTRAL.z, CENTRAL.r, K.PLAZA);
  facadeBox(facade, { x: CENTRAL.x, z: CENTRAL.z, base: 0, w: 2.6, d: 2.6, h: 1.4, color: '#b9b0a0', style: 0 });
  put(facade, new THREE.CylinderGeometry(0.35, 0.95, 8.4, 4).rotateY(Math.PI / 4).translate(0, 4.2, 0), CENTRAL.x, 1.4, CENTRAL.z, { color: '#d6cebd' });
  // Main axes: west–east through the centre; south from the centre to the edge.
  pathStrip(street, [[-117, 4], [-CENTRAL.r, 4]], 5, K.PATH);
  pathStrip(street, [[CENTRAL.r, 4], [117, 4]], 5, K.PATH);
  pathStrip(street, [[0, CENTRAL.z + CENTRAL.r], [0, 117]], 5, K.PATH);
  // North: east of the lake, west of the civic quarter.
  pathStrip(street, [[6, CENTRAL.z - CENTRAL.r + 1], [16, -18], [24, -40], [24, -117]], 4.5, K.PATH);
  // City Hall Square to the centre, and the lake loop.
  pathStrip(street, [[-15, 30], [-9, 13]], 4, K.PATH);
  pathStrip(street, ellipse(LAKE.x, LAKE.z, LAKE.a + 6, LAKE.b + 6, 72), 3.2, K.PATH, { closed: true });
  // Lake coping (a stone edge hides the shoreline).
  pathStrip(street, ellipse(LAKE.x, LAKE.z, LAKE.a + 0.5, LAKE.b + 0.5, 96), 1.2, K.KERB, { closed: true, y: 0.08 });
  water.ice(ellipse(LAKE.x, LAKE.z, LAKE.a + 0.6, LAKE.b + 0.6, 96), LAKE.y);

  // ---- formal gardens, playground, pitch (SE) -----------------------------------------------------
  {
    const g = GARDEN;
    rectPatch(street, g.x0, g.x1, g.z0, g.z1, K.PATH);
    const cx = (g.x0 + g.x1) / 2;
    const cz = (g.z0 + g.z1) / 2;
    // Parterre: four hedge-lined beds around a round pool.
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const bx = cx + sx * 17;
      const bz = cz + sz * 12;
      rectPatch(street, bx - 13, bx + 13, bz - 8.5, bz + 8.5, K.VERGE, { y: 0.1 });
      for (const [w, d, ox, oz] of [[26, 0.8, 0, -8.5], [26, 0.8, 0, 8.5], [0.8, 17, -13, 0], [0.8, 17, 13, 0]]) {
        put(furniture, new THREE.BoxGeometry(w, 0.9, d).translate(0, 0.45, 0), bx + ox, 0.05, bz + oz, { color: '#2f5a2c' });
      }
      put(furniture, new THREE.CylinderGeometry(1.1, 1.3, 2.2, 8).translate(0, 1.1, 0), bx, 0.05, bz, { color: '#356b30' });
      for (let k = 0; k < 6; k++) {
        put(furniture, new THREE.IcosahedronGeometry(0.7, 0), bx - 9 + k * 3.6, 0.6, bz + (k % 2 ? 3.5 : -3.5), { color: ['#c0446a', '#e0a33a', '#9b59b6'][k % 3] });
      }
    }
    put(furniture, new THREE.CylinderGeometry(5.6, 5.8, 0.6, 32, 1, true).translate(0, 0.3, 0), cx, 0.04, cz, { color: '#bdb5a5' });
    water.ice(ellipse(cx, cz, 5.4, 5.4, 32), 0.4);
    put(furniture, new THREE.CylinderGeometry(0.35, 0.5, 2.4, 10).translate(0, 1.2, 0), cx, 0.04, cz, { color: '#cfc7b6' });
  }
  {
    const p = PLAY;
    rectPatch(street, p.x0, p.x1, p.z0, p.z1, K.RUBBER);
    const c = (p.x0 + p.x1) / 2;
    // Climbing frame, slide, swings (≤ 4 m).
    facadeBox(facade, { x: c - 5, z: p.z0 + 7, base: 0.05, w: 4, d: 4, h: 2.4, color: '#2b7bd1', roofColor: '#f2c230', style: 0 });
    put(furniture, new THREE.BoxGeometry(1.2, 0.12, 5).rotateX(-0.45).translate(0, 1.2, 0), c - 5, 0.05, p.z0 + 11.3, { color: '#e2483f' });
    for (const sx of [3, 9]) put(furniture, new THREE.BoxGeometry(0.15, 3.2, 0.15).translate(0, 1.6, 0), c + sx, 0.05, p.z0 + 12, { color: '#3a3a3a' });
    put(furniture, new THREE.BoxGeometry(6.2, 0.15, 0.15), c + 6, 3.25, p.z0 + 12, { color: '#3a3a3a' });
    put(furniture, new THREE.CylinderGeometry(2.2, 2.2, 0.2, 16).translate(0, 0.3, 0), c + 4, 0.05, p.z0 + 4.5, { color: '#f2c230' });
  }
  {
    const p = PITCH;
    street.quad([p.x0, 0.04, p.z0], [p.x1, 0.04, p.z0], [p.x1, 0.04, p.z1], [p.x0, 0.04, p.z1], [0, 1, 0], [1, 1, 1],
      [[0, -10, K.PITCH, 0], [0, -10, K.PITCH, 40], [0, 10, K.PITCH, 40], [0, 10, K.PITCH, 0]]);
    // Goals and a low fence frame.
    for (const gx of [p.x0 + 0.4, p.x1 - 0.4]) {
      for (const dz of [-1.6, 1.6]) put(furniture, new THREE.BoxGeometry(0.1, 2, 0.1).translate(0, 1, 0), gx, 0.04, (p.z0 + p.z1) / 2 + dz, { color: '#f4f4f4' });
      put(furniture, new THREE.BoxGeometry(0.1, 0.1, 3.3), gx, 2.04, (p.z0 + p.z1) / 2, { color: '#f4f4f4' });
    }
    for (const [x0, z0, x1, z1] of [[p.x0 - 1, p.z0 - 1, p.x1 + 1, p.z0 - 1], [p.x0 - 1, p.z1 + 1, p.x1 + 1, p.z1 + 1]]) {
      const len = Math.hypot(x1 - x0, z1 - z0);
      put(furniture, new THREE.BoxGeometry(len, 0.08, 0.08), (x0 + x1) / 2, 3.0, (z0 + z1) / 2, { color: '#3b4a3d' });
      for (let k = 0; k <= len; k += 5) put(furniture, new THREE.BoxGeometry(0.08, 3, 0.08).translate(0, 1.5, 0), x0 + k, 0.04, z0, { color: '#3b4a3d' });
    }
  }

  // ---- the lake: boathouse, jetty, stone bridge (NW) -----------------------------------------------
  {
    const bx = -58;
    const bz = LAKE.z - LAKE.b - 9;
    facadeBox(facade, { x: bx, z: bz, base: 0, w: 15, d: 8, h: 5.2, color: '#8a5a3c', style: 3, seed: 9 });
    gableRoof(facade, { x: bx, z: bz, base: 5.2, w: 15, d: 8, rise: 3.2, color: '#3f4a52' });
    // Jetty into the lake.
    put(furniture, new THREE.BoxGeometry(3, 0.25, 12).translate(0, 0, 6), bx, 0.12, bz + 2, { color: '#7b5a3c' });
    for (let k = 0; k <= 3; k++) {
      for (const sx of [-1.3, 1.3]) put(furniture, new THREE.CylinderGeometry(0.12, 0.12, 1.6, 6), bx + sx, -0.6, bz + 3 + k * 3.6, { color: '#4f3a28' });
    }
  }
  {
    // Stone bridge across the east end of the lake (x = 10): an arched deck with parapets.
    const x = 10;
    const half = LAKE.b * Math.sqrt(1 - ((x - LAKE.x) / LAKE.a) ** 2) + 3;
    const n = 16;
    for (let k = 0; k < n; k++) {
      const t0 = k / n;
      const t1 = (k + 1) / n;
      const z0 = LAKE.z - half + 2 * half * t0;
      const z1 = LAKE.z - half + 2 * half * t1;
      const y0 = 0.15 + Math.sin(Math.PI * t0) * 1.6;
      const y1 = 0.15 + Math.sin(Math.PI * t1) * 1.6;
      const zm = (z0 + z1) / 2;
      const ym = (y0 + y1) / 2;
      const len = Math.hypot(z1 - z0, y1 - y0);
      const tilt = Math.atan2(y1 - y0, z1 - z0);
      for (const [w, h, dx, dy, c] of [[4.4, 0.4, 0, 0, '#a89f8f'], [0.35, 0.9, 2.05, 0.6, '#b8af9f'], [0.35, 0.9, -2.05, 0.6, '#b8af9f']]) {
        const g = new THREE.BoxGeometry(w, h, len + 0.05).rotateX(-tilt);
        put(furniture, g, x + dx, ym + dy, zm, { color: c });
      }
    }
    // Arch faces (dark water shadow under the bridge).
    put(furniture, new THREE.BoxGeometry(4.2, 1.2, 0.3), x, -0.2, LAKE.z, { color: '#6c655a' });
  }

  // ---- the civic quarter (NE): museum, library, domed courthouse ------------------------------------
  rectPatch(street, CIVIC.x0, CIVIC.x1, -64, -54, K.PLAZA);
  {
    // Museum (faces south): 36 × 20, 15 m, a long colonnade.
    const mx = 52;
    const mz = -40;
    facadeBox(facade, { x: mx, z: mz, base: 0, w: 36, d: 18, h: 3.5, color: '#bfb6a5', style: 0 });
    facadeBox(facade, { x: mx, z: mz, base: 3.5, w: 36, d: 18, h: 10.5, color: '#ddd5c6', roofColor: '#8b969b', style: 3, seed: 21, vOffset: 3.5 });
    facadeBox(facade, { x: mx, z: mz, base: 14, w: 37, d: 19, h: 1, color: '#ebe5d8', style: 0 });
    for (let k = 0; k < 10; k++) put(facade, new THREE.CylinderGeometry(0.42, 0.5, 9, 10).translate(0, 4.5, 0), mx - 16 + k * 3.55, 3.5, mz + 10.2, { color: '#efe9dc' });
    facadeBox(facade, { x: mx, z: mz + 10.2, base: 12.5, w: 36.5, d: 2, h: 1.5, color: '#ebe5d8', style: 0 });
  }
  {
    // Library (faces west): brick, tall arched windows (office style), copper roof.
    const lx = 83;
    const lz = -40;
    facadeBox(facade, { x: lx, z: lz, base: 0, w: 16, d: 22, h: 13, color: '#9c5a42', roofColor: '#5b8f7d', style: 2, seed: 33 });
    gableRoof(facade, { x: lx, z: lz, base: 13, w: 22, d: 16, rise: 4, yaw: Math.PI / 2, color: '#5b8f7d' });
  }
  {
    // Courthouse: block + drum + dome (top ≈ 36 m, under the 40 m cap).
    const cx = 61;
    const cz = -78;
    facadeBox(facade, { x: cx, z: cz, base: 0, w: 32, d: 22, h: 16, color: '#d9d1c1', roofColor: '#8b969b', style: 1, seed: 41 });
    facadeBox(facade, { x: cx, z: cz, base: 16, w: 33, d: 23, h: 1, color: '#ebe5d8', style: 0 });
    put(facade, new THREE.CylinderGeometry(7.2, 7.2, 6, 24, 1, true).translate(0, 3, 0), cx, 17, cz, { color: '#e0d8c8' });
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      put(facade, new THREE.CylinderGeometry(0.3, 0.3, 5.6, 6).translate(0, 2.8, 0), cx + Math.cos(a) * 7.6, 17, cz + Math.sin(a) * 7.6, { color: '#f1ebdf' });
    }
    put(facade, new THREE.SphereGeometry(7.6, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2), cx, 23, cz, { color: '#6aa58f' });
    put(facade, new THREE.CylinderGeometry(0.9, 1.2, 3, 8).translate(0, 1.5, 0), cx, 30.5, cz, { color: '#e0d8c8' });
    put(facade, new THREE.SphereGeometry(0.9, 10, 8), cx, 34.3, cz, { color: '#d9b34a' });
    // Steps on the south front.
    for (let k = 0; k < 3; k++) put(furniture, new THREE.BoxGeometry(16 - k, 0.2, 1.2), cx, 0.1 + k * 0.2, cz + 11.8 - k * 0.9, { color: '#cfc7b6' });
  }

  // ---- park trees (Poisson-ish darts, avoiding everything) -------------------------------------------
  const blocked = (x, z) => {
    if (Math.abs(x) > 113 || Math.abs(z) > 113) return true;
    const inRect = (r, m = 3) => x > r.x0 - m && x < r.x1 + m && z > r.z0 - m && z < r.z1 + m;
    if (inRect(SQUARE, 1) || inRect(GARDEN) || inRect(PITCH) || inRect(PLAY) || inRect({ x0: 30, x1: 92, z0: -92, z1: -28 }, 1)) return true;
    if (inRect({ x0: H.x - H.w / 2, x1: H.x + H.w / 2, z0: H.z - H.d / 2, z1: H.z + H.d / 2 }, 4)) return true;
    const e = ((x - LAKE.x) / (LAKE.a + 9)) ** 2 + ((z - LAKE.z) / (LAKE.b + 9)) ** 2;
    if (e < 1) return true;
    if (Math.hypot(x - CENTRAL.x, z - CENTRAL.z) < CENTRAL.r + 5) return true;
    if (Math.abs(z - 4) < 5 || (Math.abs(x) < 5 && z > 0)) return true; // the axes
    if (Math.abs(x - 24) < 5 && z < -40) return true;
    if (Math.hypot(x + 58, z - (LAKE.z - LAKE.b - 9)) < 14) return true;
    return false;
  };
  const placed = [];
  for (let k = 0; k < 2200 && placed.length < 150; k++) {
    const x = -112 + rnd() * 224;
    const z = -112 + rnd() * 224;
    if (blocked(x, z)) continue;
    if (placed.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 10.5 ** 2)) continue;
    placed.push({ x, z });
    trees.push({ x, z, kind: rnd() < 0.18 ? 1 : 0, scale: 0.85 + rnd() * 0.45, prio: 1 });
  }
  // Rows of trees framing City Hall Square.
  for (let z = SQUARE.z0 + 3; z <= SQUARE.z1 - 2; z += 8) {
    trees.push({ x: SQUARE.x0 - 3, z, kind: 0, scale: 0.8, prio: 0 });
    trees.push({ x: SQUARE.x1 + 3, z, kind: 0, scale: 0.8, prio: 0 });
  }

  return {
    anchors: {
      cityhall: { pos: { x: H.x, y: 0, z: H.z + H.d / 2 }, yaw: 0 },
      lake: { pos: { x: LAKE.x, y: LAKE.y, z: LAKE.z }, yaw: 0 },
    },
  };
}
