// public/r3d/life-geo.js — procedural, life-size geometry for the city's ambient life (lane D), in
// metres, every model facing +Z with its feet / wheels on y = 0:
//   personGeometry   a 1.72 m adult: legs, arms (pivoting at hips / shoulders), head and hair, plus an
//                    umbrella, a hard hat and a skirt that the shader shows or collapses per instance
//   vehicleGeometry  sedan, hatchback, SUV, van and taxi in one geometry (per-vertex type; the shader
//                    keeps the instance's type), wheels with their axle as pivot, head / tail lamps
//   busGeometry      a 12 m city bus;   trainGeometry  a 20 m metro car (middle) and a cab car
//   boatGeometry     sailboat, ferry, rowboat (with its rower) and motor launch
//   birdGeometry     a pigeon-sized bird whose wings flap about the body axis
//   blimpGeometry / planeGeometry, glowGeometry (lamp glows + road pools), blobGeometry (contact shadow)
//
// Every vertex carries aCol (colour), aA = (part, colour slot, type, paint) and aB = (pivot xyz,
// emissive class: 1 headlight, 2 tail light, 3 lit window / sign) — see life-shaders.js.
import * as THREE from './three.js';

const tmpObj = new THREE.Object3D();
const tmpColor = new THREE.Color();

/** Collects indexed parts with life attributes and merges them into one indexed BufferGeometry. */
export class LifeGeo {
  constructor() {
    this.parts = [];
  }

  /**
   * @param {THREE.BufferGeometry} geo  consumed
   * @param {{at?:number[], rot?:number[], scale?:number[], color?:string, part?:number, slot?:number,
   *          type?:number, paint?:number, pivot?:number[], emit?:number, matrix?:THREE.Matrix4}} o
   */
  add(geo, o = {}) {
    if (o.matrix) geo.applyMatrix4(o.matrix);
    else {
      const [x, y, z] = o.at ?? [0, 0, 0];
      const [rx, ry, rz] = o.rot ?? [0, 0, 0];
      const [sx, sy, sz] = o.scale ?? [1, 1, 1];
      tmpObj.position.set(x, y, z);
      tmpObj.rotation.set(rx, ry, rz);
      tmpObj.scale.set(sx, sy, sz);
      tmpObj.updateMatrix();
      geo.applyMatrix4(tmpObj.matrix);
    }
    if (!geo.index) {
      const n = geo.attributes.position.count;
      geo.setIndex(Array.from({ length: n }, (_, k) => k));
    }
    if (!geo.attributes.normal) geo.computeVertexNormals();
    this.parts.push({ geo, o });
    return this;
  }

  build() {
    let nv = 0, ni = 0;
    for (const { geo } of this.parts) { nv += geo.attributes.position.count; ni += geo.index.count; }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
    const col = new Float32Array(nv * 3), A = new Float32Array(nv * 4), B = new Float32Array(nv * 4);
    const index = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
    let v = 0, i = 0;
    for (const { geo, o } of this.parts) {
      const n = geo.attributes.position.count;
      pos.set(geo.attributes.position.array, v * 3);
      nor.set(geo.attributes.normal.array, v * 3);
      if (geo.attributes.uv) uv.set(geo.attributes.uv.array.subarray(0, n * 2), v * 2);
      tmpColor.set(o.color ?? '#ffffff');
      const [px, py, pz] = o.pivot ?? [0, 0, 0];
      for (let k = 0; k < n; k++) {
        const j = v + k;
        col[j * 3] = tmpColor.r; col[j * 3 + 1] = tmpColor.g; col[j * 3 + 2] = tmpColor.b;
        A[j * 4] = o.part ?? 0; A[j * 4 + 1] = o.slot ?? 0; A[j * 4 + 2] = o.type ?? 0; A[j * 4 + 3] = o.paint ?? 0;
        B[j * 4] = px; B[j * 4 + 1] = py; B[j * 4 + 2] = pz; B[j * 4 + 3] = o.emit ?? 0;
      }
      const idx = geo.index.array;
      for (let k = 0; k < idx.length; k++) index[i + k] = idx[k] + v;
      v += n;
      i += idx.length;
      geo.dispose();
    }
    this.parts = [];
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    out.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
    out.setAttribute('aA', new THREE.BufferAttribute(A, 4));
    out.setAttribute('aB', new THREE.BufferAttribute(B, 4));
    out.setIndex(new THREE.BufferAttribute(index, 1));
    out.computeBoundingSphere();
    return out;
  }
}

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt, rb, h, seg = 8, open = false) => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);

/** A cylinder from point a to point b (radius r). */
function segment(a, b, r, seg = 5) {
  const g = cyl(r, r, 1, seg);
  const dir = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = dir.length();
  g.scale(1, len, 1);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  g.applyQuaternion(q);
  g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return g;
}

/** A hull: a plan shape (pointed bow at +z) extruded `h` m up, its keel at y = 0. */
function hull(len, beam, h, { bow = 0.32, stern = 0.85 } = {}) {
  const s = new THREE.Shape();
  const L2 = len / 2, B2 = beam / 2;
  s.moveTo(-B2 * stern, -L2);
  s.lineTo(B2 * stern, -L2);
  s.lineTo(B2, -L2 + len * 0.25);
  s.lineTo(B2, L2 - len * bow);
  s.quadraticCurveTo(B2 * 0.9, L2 - len * 0.05, 0, L2);
  s.quadraticCurveTo(-B2 * 0.9, L2 - len * 0.05, -B2, L2 - len * bow);
  s.lineTo(-B2, -L2 + len * 0.25);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: 4 });
  g.rotateX(Math.PI / 2); // shape (x, y) → (x, ·, +z): the bow points to +z; the extrusion goes down
  g.translate(0, h, 0); // keel at y = 0, deck at y = h
  g.computeVertexNormals();
  return g;
}

/** A flat triangle (two-sided) through three points — sails. */
function triangle(a, b, c) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...b], 3));
  g.computeVertexNormals();
  return g;
}

// ---- people -------------------------------------------------------------------------------------------

export const PERSON_PART = { body: 0, legL: 1, legR: 2, armL: 3, armR: 4, head: 5, umbrella: 6, hardhat: 7, skirt: 8 };
/** colour slots: 0 fixed, 1 shirt, 2 trousers, 3 skin, 4 hair, 5 shoes (fixed), 6 umbrella */
export function personGeometry() {
  const g = new LifeGeo();
  const P = PERSON_PART;
  const hipY = 0.92, shY = 1.45, shX = 0.235;
  for (const [side, part] of [[1, P.legL], [-1, P.legR]]) {
    const x = 0.1 * side;
    const pivot = [x, hipY, 0];
    g.add(box(0.135, 0.84, 0.15), { at: [x, 0.5, 0], part, slot: 2, pivot });
    g.add(box(0.12, 0.09, 0.27), { at: [x, 0.045, 0.035], part, slot: 5, color: '#1d1b1a', pivot });
  }
  g.add(box(0.34, 0.16, 0.21), { at: [0, 0.94, 0], slot: 2 });
  g.add(box(0.37, 0.5, 0.22), { at: [0, 1.22, 0], slot: 1 });
  g.add(box(0.43, 0.1, 0.23), { at: [0, 1.43, 0], slot: 1 });
  g.add(box(0.085, 0.07, 0.085), { at: [0, 1.51, 0], slot: 3 });
  const head = new THREE.SphereGeometry(0.11, 8, 6);
  g.add(head, { at: [0, 1.63, 0.005], scale: [0.88, 1.08, 0.98], part: P.head, slot: 3 });
  const hair = new THREE.SphereGeometry(0.117, 8, 4, 0, Math.PI * 2, 0, Math.PI * 0.55);
  g.add(hair, { at: [0, 1.645, -0.012], scale: [0.9, 1.05, 1], part: P.head, slot: 4 });
  for (const [side, part] of [[1, P.armL], [-1, P.armR]]) {
    const x = shX * side;
    const pivot = [x, shY, 0];
    g.add(box(0.095, 0.56, 0.11), { at: [x, shY - 0.29, 0], part, slot: 1, pivot });
    g.add(box(0.08, 0.1, 0.09), { at: [x, shY - 0.62, 0.01], part, slot: 3, pivot });
  }
  // umbrella (held by the raised right hand): pole from the hand up, a cone canopy above the head
  const hand = [-0.24, 0.95, 0.34];
  const top = [-0.07, 2.02, 0.1];
  g.add(segment(hand, top, 0.012, 4), { part: P.umbrella, color: '#222222' });
  g.add(new THREE.ConeGeometry(0.56, 0.24, 9, 1, true), { at: [top[0], top[1] + 0.02, top[2]], part: P.umbrella, slot: 6 });
  g.add(new THREE.ConeGeometry(0.56, 0.24, 9, 1, true), { at: [top[0], top[1] + 0.015, top[2]], rot: [Math.PI, 0, 0], scale: [1, 0.05, 1], part: P.umbrella, slot: 6 });
  // hard hat
  g.add(new THREE.SphereGeometry(0.135, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), { at: [0, 1.66, 0], part: P.hardhat, color: '#f4c20d' });
  g.add(cyl(0.165, 0.165, 0.022, 10), { at: [0, 1.665, 0.02], part: P.hardhat, color: '#f4c20d' });
  // skirt / coat hem (trousers colour)
  g.add(cyl(0.2, 0.27, 0.48, 9), { at: [0, 0.72, 0], part: P.skirt, slot: 2 });
  return g.build();
}

// ---- road vehicles --------------------------------------------------------------------------------------

export const VEHICLE_TYPES = ['sedan', 'hatch', 'suv', 'van', 'taxi'];
export const VEHICLE_SIZE = { // length, width (m)
  sedan: [4.6, 1.8], hatch: [3.95, 1.75], suv: [4.75, 1.9], van: [5.2, 2.0], taxi: [4.6, 1.8], bus: [12, 2.55],
};
const WHEEL_R = 0.33;

function addWheels(g, type, x, zs, r = WHEEL_R, w = 0.24) {
  for (const z of zs) {
    for (const s of [1, -1]) {
      g.add(cyl(r, r, w, 9), { at: [s * x, r, z], rot: [0, 0, Math.PI / 2], part: 1, type, color: '#1b1b1d', pivot: [s * x, r, z] });
      g.add(cyl(r * 0.55, r * 0.55, w + 0.01, 6), { at: [s * x, r, z], rot: [0, 0, Math.PI / 2], part: 1, type, color: '#b9bec4', pivot: [s * x, r, z] });
    }
  }
}

function lamps(g, type, { x, y, zf, zr, w = 0.32, h = 0.12 }) {
  for (const s of [1, -1]) {
    g.add(box(w, h, 0.06), { at: [s * x, y, zf], type, color: '#fff3cf', emit: 1 });
    g.add(box(w, h * 0.9, 0.06), { at: [s * x, y + 0.06, zr], type, color: '#c81e1e', emit: 2 });
  }
}

/** A saloon-style car body (type id) of length L, width W: lower body, glasshouse, roof, bumpers. */
function car(g, type, { L, W, low = 0.62, cabin = 0.5, cabinL, cabinZ = -0.15, lift = 0.3, roofW }) {
  const bodyTop = lift + low;
  g.add(box(W, low, L - 0.06), { at: [0, lift + low / 2, 0], type, paint: 1, color: '#ffffff' });
  g.add(box(W - 0.24, cabin, cabinL), { at: [0, bodyTop + cabin / 2, cabinZ], type, color: '#1e2a33' });
  g.add(box(roofW ?? W - 0.3, 0.07, cabinL - 0.28), { at: [0, bodyTop + cabin + 0.03, cabinZ], type, paint: 1, color: '#ffffff' });
  for (const z of [L / 2 - 0.03, -L / 2 + 0.03]) g.add(box(W + 0.03, 0.2, 0.14), { at: [0, lift + 0.12, z], type, color: '#2a2b2e' });
  g.add(box(W * 0.5, 0.16, 0.05), { at: [0, lift + low * 0.62, L / 2 + 0.01], type, color: '#202124' }); // grille
  lamps(g, type, { x: W / 2 - 0.25, y: lift + low * 0.68, zf: L / 2, zr: -L / 2 });
  addWheels(g, type, W / 2 - 0.08, [L / 2 - 0.95, -L / 2 + 0.85]);
}

export function vehicleGeometry() {
  const g = new LifeGeo();
  car(g, 0, { L: 4.6, W: 1.8, cabinL: 2.3 });
  car(g, 1, { L: 3.95, W: 1.75, cabin: 0.56, cabinL: 2.15, cabinZ: -0.32 });
  car(g, 2, { L: 4.75, W: 1.9, low: 0.78, cabin: 0.6, cabinL: 2.9, cabinZ: -0.35, lift: 0.36 });
  g.add(box(1.2, 0.06, 2.2), { at: [0, 0.36 + 0.78 + 0.6 + 0.1, -0.35], type: 2, color: '#2b2b2b' }); // roof rails
  // van: cargo box + cab
  {
    const t = 3;
    g.add(box(2.0, 1.9, 3.75), { at: [0, 0.32 + 0.95, -0.7], type: t, paint: 1 });
    g.add(box(2.0, 1.05, 1.42), { at: [0, 0.32 + 0.52, 1.88], type: t, paint: 1 });
    g.add(box(1.86, 0.62, 0.9), { at: [0, 1.62, 1.55], rot: [-0.32, 0, 0], type: t, color: '#1e2a33' });
    g.add(box(2.02, 0.42, 0.7), { at: [0, 1.6, 1.0], type: t, color: '#1e2a33' });
    for (const z of [2.6, -2.58]) g.add(box(2.03, 0.22, 0.12), { at: [0, 0.42, z], type: t, color: '#2a2b2e' });
    lamps(g, t, { x: 0.74, y: 0.95, zf: 2.6, zr: -2.58 });
    addWheels(g, t, 0.92, [1.75, -1.65], 0.36);
  }
  car(g, 4, { L: 4.6, W: 1.8, cabinL: 2.3 });
  g.add(box(0.62, 0.17, 0.26), { at: [0, 0.3 + 0.62 + 0.5 + 0.16, -0.15], type: 4, color: '#ffe680', emit: 3 }); // TAXI sign
  return g.build();
}

/** A 12 m city bus (its own instanced mesh; type 0). */
export function busGeometry() {
  const g = new LifeGeo();
  const L = 12, W = 2.55, lift = 0.35;
  g.add(box(W, 2.4, L - 0.1), { at: [0, lift + 1.2, 0], paint: 1 });
  g.add(box(W + 0.02, 0.95, L - 1.4), { at: [0, lift + 1.72, -0.4], color: '#26333d', emit: 3 }); // side windows (lit at night)
  g.add(box(W - 0.2, 1.25, 0.06), { at: [0, lift + 1.62, L / 2 - 0.02], rot: [0.06, 0, 0], color: '#26333d' }); // windscreen
  g.add(box(W - 0.4, 0.25, 0.07), { at: [0, lift + 2.27, L / 2 - 0.01], color: '#ffb000', emit: 3 }); // destination sign
  g.add(box(W - 0.3, 0.22, L - 1.5), { at: [0, lift + 2.5, -0.3], color: '#d9dcdf' }); // roof pod
  g.add(box(W + 0.02, 0.3, L - 0.08), { at: [0, lift + 0.42, 0], color: '#3a3f44' }); // skirt
  for (const z of [3.6, -1.2]) g.add(box(0.05, 2.0, 1.25), { at: [-W / 2 - 0.01, lift + 1.1, z], color: '#2e3a43' }); // doors (kerb side = right = −x)
  lamps(g, 0, { x: 0.95, y: lift + 0.55, zf: L / 2, zr: -L / 2, w: 0.36 });
  addWheels(g, 0, W / 2 - 0.12, [L / 2 - 2.4, -L / 2 + 2.6, -L / 2 + 3.9], 0.5, 0.3);
  return g.build();
}

/** Lamp glows and road light pools for vehicle type t (0..4) and the bus (5). aG: kind, type, size. */
export function glowGeometry() {
  const pos = [], uv = [], aG = [], index = [];
  const quad = (cx, cy, cz, ax, ay, az, bx, by, bz, kind, type) => {
    const v = pos.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      pos.push(cx + ax * su + bx * sv, cy + ay * su + by * sv, cz + az * su + bz * sv);
      uv.push((su + 1) / 2, (sv + 1) / 2);
      aG.push(kind, type, 0, 0);
    }
    index.push(v, v + 1, v + 2, v, v + 2, v + 3);
  };
  const crossed = (x, y, z, r, kind, type) => { // a lamp glow seen from any side: three crossed quads
    quad(x, y, z, r, 0, 0, 0, r, 0, kind, type);
    quad(x, y, z, 0, 0, r, 0, r, 0, kind, type);
    quad(x, y, z, r, 0, 0, 0, 0, r, kind, type);
  };
  const specs = [
    [0, 1.8, 4.6, 0.65], [1, 1.75, 3.95, 0.65], [2, 1.9, 4.75, 0.74], [3, 2.0, 5.2, 0.97], [4, 1.8, 4.6, 0.65], [5, 2.55, 12, 0.9],
  ];
  for (const [type, W, L, y] of specs) {
    const x = W / 2 - 0.25;
    for (const s of [1, -1]) {
      crossed(s * x, y, L / 2 + 0.08, 0.38, 0, type);
      crossed(s * x, y + 0.06, -L / 2 - 0.06, 0.26, 1, type);
    }
    quad(0, 0.05, L / 2 + 5.5, 1.6, 0, 0, 0, 0, 5, 2, type); // the light pool on the road ahead
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aG', new THREE.Float32BufferAttribute(aG, 4));
  geo.setIndex(index);
  return geo;
}

/** A unit quad on the ground (±0.5 in x and z) with uv — contact shadows. */
export function blobGeometry() {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

// ---- trains ---------------------------------------------------------------------------------------------

export const TRAIN_CAR_LEN = 20;
/** Metro car, 20 m: type 0 = middle car, type 1 = cab car (nose toward +z). Wheels on y = 0 (rail top). */
export function trainGeometry() {
  const g = new LifeGeo();
  const W = 2.8;
  for (const type of [0, 1]) {
    const L = TRAIN_CAR_LEN - 0.4;
    const cab = type === 1;
    const bodyL = cab ? L - 1.2 : L;
    const bz = cab ? -0.6 : 0;
    g.add(box(W, 2.75, bodyL), { at: [0, 0.95 + 1.375, bz], type, color: '#d9dde1' });
    g.add(box(W + 0.02, 0.32, bodyL), { at: [0, 1.38, bz], type, paint: 1 }); // livery stripe
    g.add(box(W + 0.03, 0.82, bodyL - 1.4), { at: [0, 2.48, bz], type, color: '#22303a', emit: 3 }); // windows
    g.add(box(W - 0.3, 0.22, bodyL - 0.6), { at: [0, 3.78, bz], type, color: '#9aa1a8' }); // roof
    g.add(box(W - 0.4, 0.5, L - 2), { at: [0, 0.7, 0], type, color: '#2b2f33' }); // underframe
    for (const z of [6.8, -6.8]) {
      g.add(box(2.3, 0.55, 2.8), { at: [0, 0.42, z], type, color: '#1e2124' }); // bogie
      for (const dz of [-0.9, 0.9]) for (const s of [1, -1]) g.add(cyl(0.42, 0.42, 0.14, 8), { at: [s * 0.72, 0.42, z + dz], rot: [0, 0, Math.PI / 2], type, color: '#3a3d40' });
    }
    for (const s of [1, -1]) for (const z of [-5.5, 0, 5.5]) {
      if (cab && z > 5) continue;
      g.add(box(0.04, 2.0, 1.3), { at: [s * (W / 2 + 0.02), 1.98, z + bz * 0], type, color: '#56616b' }); // doors
    }
    if (cab) {
      const zf = L / 2 - 1.2;
      g.add(box(W, 2.0, 1.25), { at: [0, 0.95 + 1.0, zf + 0.6], type, paint: 1 }); // nose
      g.add(box(W - 0.15, 1.05, 0.7), { at: [0, 2.6, zf + 0.15], rot: [-0.55, 0, 0], type, color: '#1b252d' }); // windscreen
      for (const s of [1, -1]) g.add(box(0.36, 0.16, 0.06), { at: [s * 0.95, 1.35, zf + 1.24], type, color: '#fff6dd', emit: 1 });
    } else {
      g.add(box(W - 0.6, 2.6, 0.3), { at: [0, 2.25, L / 2 + 0.05], type, color: '#30363b' }); // gangway
      g.add(box(W - 0.6, 2.6, 0.3), { at: [0, 2.25, -L / 2 - 0.05], type, color: '#30363b' });
    }
  }
  return g.build();
}

// ---- boats ----------------------------------------------------------------------------------------------

export const BOAT_TYPES = { sail: 0, ferry: 1, row: 2, motor: 3 };
/** Boats with their waterline at y = 0 (the hull goes 0.4–1 m below). */
export function boatGeometry() {
  const g = new LifeGeo();
  { // sailboat, 8.5 m
    const t = 0;
    g.add(hull(8.5, 2.7, 1.3), { at: [0, -0.5, 0], type: t, color: '#f4f5f2' });
    g.add(box(2.4, 0.08, 6.0), { at: [0, 0.82, -0.6], type: t, color: '#b48a5a' }); // deck
    g.add(box(1.4, 0.5, 2.2), { at: [0, 1.1, -0.4], type: t, color: '#f4f5f2' }); // cabin
    g.add(segment([0, 0.8, 0.6], [0, 12.2, 0.6], 0.07), { type: t, color: '#cfd3d6' }); // mast
    g.add(segment([0, 1.9, 0.6], [0, 1.9, -3.4], 0.05), { type: t, color: '#cfd3d6' }); // boom
    g.add(triangle([0, 2.0, 0.5], [0, 11.8, 0.5], [0, 2.0, -3.3]), { type: t, color: '#fbfbf6' }); // main sail
    g.add(triangle([0, 1.2, 3.9], [0, 11.0, 0.7], [0, 1.6, 0.9]), { type: t, paint: 1, color: '#ffffff' }); // jib (livery)
  }
  { // ferry, 32 m
    const t = 1;
    g.add(hull(32, 8.6, 3.2, { bow: 0.22, stern: 0.95 }), { at: [0, -1.2, 0], type: t, color: '#1f3a5a' });
    g.add(box(8.4, 0.25, 29), { at: [0, 2.05, -0.6], type: t, color: '#e6e2d8' });
    g.add(box(7.6, 2.4, 20), { at: [0, 3.35, -2.5], type: t, color: '#f5f5f2' });
    g.add(box(7.65, 0.9, 19), { at: [0, 3.6, -2.5], type: t, color: '#2a3946', emit: 3 }); // windows
    g.add(box(6.2, 2.0, 9), { at: [0, 5.55, -1.5], type: t, color: '#f5f5f2' });
    g.add(box(6.25, 0.7, 8.5), { at: [0, 5.75, -1.5], type: t, color: '#2a3946', emit: 3 });
    g.add(box(4.0, 1.6, 2.4), { at: [0, 7.3, 1.6], type: t, color: '#f5f5f2' }); // bridge
    g.add(box(4.05, 0.6, 2.45), { at: [0, 7.5, 1.6], type: t, color: '#20303c' });
    g.add(cyl(0.9, 1.05, 3.0, 10), { at: [0, 8.4, -4.5], type: t, paint: 1, color: '#ffffff' }); // funnel (livery)
    g.add(cyl(0.95, 0.95, 0.4, 10), { at: [0, 10.0, -4.5], type: t, color: '#1b1b1b' });
    g.add(box(8.0, 0.35, 0.3), { at: [0, 2.4, 13.2], type: t, color: '#c9372c' }); // bow rail band
  }
  { // rowboat, 3.6 m, with its rower
    const t = 2;
    g.add(hull(3.6, 1.35, 0.55, { bow: 0.4, stern: 0.7 }), { at: [0, -0.25, 0], type: t, color: '#8a5a33' });
    g.add(box(1.2, 0.06, 0.3), { at: [0, 0.22, 0.1], type: t, color: '#c79a62' }); // thwart
    g.add(box(0.36, 0.5, 0.24), { at: [0, 0.55, 0.1], type: t, paint: 1, color: '#ffffff' }); // rower's jacket
    g.add(new THREE.SphereGeometry(0.11, 7, 5), { at: [0, 0.92, 0.1], type: t, color: '#e0ac7e' });
    for (const s of [1, -1]) g.add(segment([s * 0.25, 0.55, 0.25], [s * 1.6, 0.0, 0.6], 0.025, 4), { type: t, color: '#c79a62' }); // oars
  }
  { // motor launch, 9 m
    const t = 3;
    g.add(hull(9, 2.9, 1.4, { bow: 0.35 }), { at: [0, -0.55, 0], type: t, color: '#f2f2ef' });
    g.add(box(2.7, 0.1, 6.8), { at: [0, 0.86, -0.7], type: t, color: '#c5a073' });
    g.add(box(2.2, 1.0, 2.4), { at: [0, 1.4, 0.3], type: t, color: '#f2f2ef' });
    g.add(box(2.22, 0.45, 2.0), { at: [0, 1.55, 0.35], type: t, color: '#22303a', emit: 3 });
    g.add(box(2.95, 0.22, 8.6), { at: [0, 0.35, 0], type: t, paint: 1, color: '#ffffff' }); // hull band (livery)
  }
  return g.build();
}

// ---- birds and the sky ---------------------------------------------------------------------------------

/** A 0.34 m bird (pigeon; gulls are scaled up): wings are parts 1 (left, +x) and 2 (right). aA.w = body tint. */
export function birdGeometry() {
  const g = new LifeGeo();
  g.add(new THREE.SphereGeometry(0.075, 6, 4), { at: [0, 0, 0], scale: [0.85, 0.8, 2.1], paint: 1 });
  g.add(new THREE.SphereGeometry(0.05, 6, 4), { at: [0, 0.05, 0.16], paint: 1 });
  g.add(new THREE.ConeGeometry(0.014, 0.05, 4), { at: [0, 0.045, 0.22], rot: [Math.PI / 2, 0, 0], color: '#e6b34a' });
  g.add(box(0.1, 0.012, 0.12), { at: [0, 0.0, -0.19], paint: 1 }); // tail
  for (const [side, part] of [[1, 1], [-1, 2]]) {
    const wing = new THREE.BufferGeometry();
    const x0 = 0.05 * side, x1 = 0.3 * side;
    wing.setAttribute('position', new THREE.Float32BufferAttribute([x0, 0.02, 0.07, x1, 0.02, -0.02, x0, 0.02, -0.08, x1, 0.02, -0.02, x1 * 1.1, 0.02, -0.09, x0, 0.02, -0.08], 3));
    wing.computeVertexNormals();
    g.add(wing, { part, paint: 1, pivot: [x0, 0.02, 0] });
  }
  return g.build();
}

/** A 60 m airship (blimp) along +z: envelope, fins, gondola, a livery band (paint). */
export function blimpGeometry() {
  const g = new LifeGeo();
  const prof = [];
  for (let k = 0; k <= 16; k++) {
    const t = k / 16;
    const z = -30 + 60 * t;
    const r = 7.5 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05)), 0.75) * (t < 0.08 ? 0.9 : 1);
    prof.push(new THREE.Vector2(Math.max(0.01, r), z));
  }
  const env = new THREE.LatheGeometry(prof, 16);
  env.rotateX(Math.PI / 2);
  g.add(env, { color: '#e9ecef' });
  const rAt = (z) => { const t = (z + 30) / 60; return 7.5 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05)), 0.75); };
  const rb = Math.max(rAt(4), rAt(8)) + 0.06;
  g.add(cyl(rb, rb, 4, 16, true), { rot: [Math.PI / 2, 0, 0], at: [0, 0, 6], paint: 1, color: '#ffffff' });
  for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    g.add(box(0.4, 7, 6), { at: [Math.sin(a) * 6.5, Math.cos(a) * 6.5, -24], rot: [0, 0, -a], color: '#c0392b' });
  }
  g.add(box(2.4, 2.0, 8), { at: [0, -8.3, 3], color: '#3d4852' });
  g.add(box(2.45, 0.8, 7), { at: [0, -8.0, 3], color: '#d9e3ea', emit: 3 });
  return g.build();
}

/** A 36 m airliner along +z. */
export function planeGeometry() {
  const g = new LifeGeo();
  g.add(cyl(1.9, 1.9, 30, 10), { rot: [Math.PI / 2, 0, 0], color: '#f2f4f6' });
  g.add(new THREE.ConeGeometry(1.9, 4, 10), { at: [0, 0, 17], rot: [Math.PI / 2, 0, 0], color: '#f2f4f6' });
  g.add(new THREE.ConeGeometry(1.9, 5, 10), { at: [0, 0.6, -17.5], rot: [-Math.PI / 2, 0, 0], color: '#f2f4f6' });
  g.add(box(34, 0.5, 5.5), { at: [0, -0.6, 1], color: '#d5d9dd' });
  g.add(box(12, 0.35, 3), { at: [0, 0.6, -17], color: '#d5d9dd' });
  g.add(box(0.4, 6, 4.5), { at: [0, 3.5, -17], color: '#2c5f8a', paint: 1 });
  for (const s of [1, -1]) {
    g.add(cyl(0.9, 0.9, 3.4, 8), { at: [s * 6, -1.6, 2.5], rot: [Math.PI / 2, 0, 0], color: '#b9bec4' });
    g.add(box(0.3, 0.3, 0.3), { at: [s * 17, -0.5, 0.5], color: s > 0 ? '#2ee86b' : '#ff3030', emit: 3 });
  }
  return g.build();
}
