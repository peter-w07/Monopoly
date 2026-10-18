// public/r3d/characters.js — the eight life-size characters + the pawn (city design §7.1–7.2).
//
// Every character is ONE SkinnedMesh with rigid skinning (each part 100 % on one bone, 8–20 bones): one draw
// call, correct shadows, no skinning library. Parts are procedural (lathes, extruded side profiles, rounded
// boxes, tori) merged into one geometry with:
//   color      vertex colour (linear)
//   aTint      0..1: mix toward the player colour (1 = the player colour; a dark vertex colour with tint 0.55 =
//              a darker shade of it, e.g. the stripes of the Scottie's tartan coat)
//   aFx        (glow, blur, metalness, roughness): glow 1 = a lamp lit at dusk (bus uLights), 2 / 3 = beacon
//              phases (uFlash.x / .y, light bars), 4 = always lit; blur +1 = a wheel blur disc shown only
//              above 6 rev/s (uBlur), −1 = spokes hidden while it shows
//   skinIndex  the part's bone (skinWeight = 1, 0, 0, 0)
// Models are built facing +Z (heading 0), standing on y = 0, at true size; the dog (×1.6) and the cat (×1.8)
// get a hero scale on their model group. ≤ 6k triangles each.

import * as THREE from './three.js';
import { creaseNormals } from './token-models.js';

/** World-scale sizes (metres, after hero scale), kind for restSlots, display name, real speed. */
export const CHARACTER_INFO = Object.freeze({
  car: { kind: 'vehicle', length: 4.1, width: 1.7, height: 1.35, name: 'Roadster', heroScale: 1, vReal: 14 },
  dog: { kind: 'walker', length: 1.44, width: 0.56, height: 0.96, name: 'Scottie', heroScale: 1.6, vReal: 7 },
  hat: { kind: 'vehicle', length: 1.8, width: 0.6, height: 2.75, name: 'Magician', heroScale: 1, vReal: 6 },
  ship: { kind: 'vehicle', length: 9.45, width: 2.44, height: 2.7, top: 3.4, name: 'Duck Boat', heroScale: 1, vReal: 9 },
  boot: { kind: 'vehicle', length: 4.6, width: 1.8, height: 2.6, name: 'Boot Car', heroScale: 1, vReal: 12 },
  cat: { kind: 'walker', length: 1.53, width: 0.54, height: 0.99, name: 'Ginger Tabby', heroScale: 1.8, vReal: 8 },
  thimble: { kind: 'vehicle', length: 2.3, width: 1.4, height: 1.35, name: 'Thimble Car', heroScale: 1, vReal: 10 },
  wheelbarrow: { kind: 'walker', length: 2.4, width: 0.8, height: 1.78, name: 'Gardener', heroScale: 1, vReal: 3.5 },
  pawn: { kind: 'walker', length: 0.5, width: 0.5, height: 1.8, name: 'Pedestrian', heroScale: 1, vReal: 3 },
});

export const infoOf = (tokenId) => CHARACTER_INFO[tokenId] ?? CHARACTER_INFO.pawn;
export const knownToken = (tokenId) => (Object.hasOwn(CHARACTER_INFO, tokenId) ? tokenId : 'pawn');

/**
 * Rig facts the motion layer needs (model space, true size before hero scale). Wheels: [bone, radius];
 * steer: front-wheel steer bones; wheelbase for the bicycle model; legs: IK chains [upper, lower, hip(x, y, z),
 * l1, l2, bend, foot y]; gait type and hip height (world) for gait.js.
 */
export const RIGS = Object.freeze({
  car: { wheels: [['wheelFL', 0.33], ['wheelFR', 0.33], ['wheelRL', 0.33], ['wheelRR', 0.33]], steer: ['steerFL', 'steerFR'], wheelbase: 2.5, spring: [1.3, 0.45] },
  ship: { wheels: [['wheelFL', 0.55], ['wheelFR', 0.55], ['wheelML', 0.55], ['wheelMR', 0.55], ['wheelRL', 0.55], ['wheelRR', 0.55]], steer: ['steerFL', 'steerFR'], wheelbase: 4.85, spring: [0.9, 0.35] },
  boot: { wheels: [['wheelFL', 0.36], ['wheelFR', 0.36], ['wheelRL', 0.36], ['wheelRR', 0.36]], steer: ['steerFL', 'steerFR'], wheelbase: 3.0, spring: [1.1, 0.4] },
  thimble: { wheels: [['wheelFL', 0.25], ['wheelFR', 0.25], ['wheelR', 0.25]], steer: ['steerFL', 'steerFR'], wheelbase: 1.45, spring: [3.0, 0.3] },
  hat: { wheels: [['wheelF', 0.75], ['wheelR', 0.2]], steer: ['steer'], wheelbase: 0.85, spring: [1.6, 0.5] },
  dog: { gait: 'quad', hip: 0.25 * 1.6, legs: [['legFL1', 'legFL2', [0.065, 0.245, 0.15], 0.11, 0.115, 1, 0.025], ['legFR1', 'legFR2', [-0.065, 0.245, 0.15], 0.11, 0.115, 1, 0.025], ['legHL1', 'legHL2', [0.065, 0.245, -0.16], 0.11, 0.115, -1, 0.025], ['legHR1', 'legHR2', [-0.065, 0.245, -0.16], 0.11, 0.115, -1, 0.025]] },
  cat: { gait: 'cat', hip: 0.24 * 1.8, legs: [['legFL1', 'legFL2', [0.045, 0.235, 0.13], 0.105, 0.115, 1, 0.018], ['legFR1', 'legFR2', [-0.045, 0.235, 0.13], 0.105, 0.115, 1, 0.018], ['legHL1', 'legHL2', [0.05, 0.24, -0.14], 0.105, 0.12, -1, 0.018], ['legHR1', 'legHR2', [-0.05, 0.24, -0.14], 0.105, 0.12, -1, 0.018]] },
  wheelbarrow: { gait: 'biped', hip: 0.92, strideScale: 0.92, legs: [['thL', 'shL', [0.1, 0.92, -0.98], 0.44, 0.44, 1, 0.08], ['thR', 'shR', [-0.1, 0.92, -0.98], 0.44, 0.44, 1, 0.08]], arms: [['uaL', 'faL', [0.2, 1.42, -0.95], 0.3, 0.32], ['uaR', 'faR', [-0.2, 1.42, -0.95], 0.3, 0.32]], wheels: [['bwheel', 0.2]], grips: [[0.3, 0.5, -0.72], [-0.3, 0.5, -0.72]], axle: [0, 0.2, 1.0] },
  pawn: { gait: 'biped', hip: 0.93, legs: [['thL', 'shL', [0.1, 0.93, 0], 0.44, 0.45, 1, 0.08], ['thR', 'shR', [-0.1, 0.93, 0], 0.44, 0.45, 1, 0.08]], arms: [['uaL', 'faL', [0.21, 1.44, 0], 0.3, 0.3], ['uaR', 'faR', [-0.21, 1.44, 0], 0.3, 0.3]] },
});

// ---- colours / PBR ---------------------------------------------------------------------------------
const C = {
  tyre: '#1b1c1f', chrome: '#dfe3e8', glass: '#27384a', black: '#1f2023', cream: '#efe6cf', white: '#f4f4f0',
  leather: '#6b3a26', skin: '#e5b48f', skinTan: '#c98e6b', hair: '#3b2a20', lamp: '#fff1c2', tail: '#d81e1e',
  denim: '#3f5f8f', straw: '#dcc27a', gold: '#d8ad4c', brass: '#c9a14a', rubber: '#2b2420',
};
const CHROME = { color: C.chrome, metal: 1, rough: 0.22 };
const GLASS = { color: C.glass, metal: 0.3, rough: 0.06 };
const TYRE = { color: C.tyre, rough: 0.92 };
const PAINT = { tint: 1, metal: 0.35, rough: 0.32 };
const HALF_PI = Math.PI / 2;
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---- geometry helpers -------------------------------------------------------------------------------
const BOX = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const RBOX = (w, h, d, r = 0.02, s = 1) => new THREE.RoundedBoxGeometry(w, h, d, s, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4));
const CYL = (rt, rb, h, s = 12, open = false) => new THREE.CylinderGeometry(rt, rb, h, s, 1, open);
const SPH = (r, ws = 12, hs = 8, ...rest) => new THREE.SphereGeometry(r, ws, hs, ...rest);
const CAP = (r, len, cs = 3, rs = 8) => new THREE.CapsuleGeometry(r, len, cs, rs);
const TOR = (R, r, rs = 6, ts = 16, arc = Math.PI * 2) => new THREE.TorusGeometry(R, r, rs, ts, arc);
const CONE = (r, h, s = 8) => new THREE.ConeGeometry(r, h, s);
/** Cylinder whose axis is X (wheels, axles). */
const cylX = (r, h, s = 16) => CYL(r, r, h, s).rotateZ(HALF_PI);
const lathe = (pts, segs = 24) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), segs);

function shape(cmds) {
  const s = new THREE.Shape();
  for (const [op, ...a] of cmds) {
    if (op === 'm') s.moveTo(a[0], a[1]);
    else if (op === 'l') s.lineTo(a[0], a[1]);
    else if (op === 'q') s.quadraticCurveTo(a[0], a[1], a[2], a[3]);
    else if (op === 'c') s.bezierCurveTo(a[0], a[1], a[2], a[3], a[4], a[5]);
  }
  return s;
}

/** A side profile in the (z forward, y up) plane extruded symmetrically across X (width), bevelled. */
function profileX(cmds, width, { bevel = 0.04, seg = 2, curve = 6 } = {}) {
  const geo = new THREE.ExtrudeGeometry(shape(cmds), { depth: width, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.9, bevelSegments: seg, curveSegments: curve });
  geo.translate(0, 0, -width / 2);
  geo.rotateY(-HALF_PI); // shape x → +Z (forward), extrusion → X
  return geo;
}

function deform(geo, fn) {
  const a = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < a.count; i++) {
    v.fromBufferAttribute(a, i);
    fn(v);
    a.setXYZ(i, v.x, v.y, v.z);
  }
  a.needsUpdate = true;
  return geo;
}

function flipWinding(g) {
  for (const name of Object.keys(g.attributes)) {
    const a = g.attributes[name];
    const s = a.itemSize;
    const arr = a.array;
    for (let t = 0; t < a.count; t += 3) {
      for (let c = 0; c < s; c++) {
        const i1 = (t + 1) * s + c;
        const i2 = (t + 2) * s + c;
        const tmp = arr[i1];
        arr[i1] = arr[i2];
        arr[i2] = tmp;
      }
    }
  }
}

/** Keeps only the triangles whose centroid / face normal pass `keep(c, n)`. Non-indexed in, non-indexed out. */
function filterFaces(g, keep) {
  const p = g.attributes.position.array;
  const nrm = g.attributes.normal.array;
  const tris = p.length / 9;
  const P = [];
  const N = [];
  const c = { x: 0, y: 0, z: 0 };
  const n = { x: 0, y: 0, z: 0 };
  for (let t = 0; t < tris; t++) {
    const o = t * 9;
    c.x = (p[o] + p[o + 3] + p[o + 6]) / 3; c.y = (p[o + 1] + p[o + 4] + p[o + 7]) / 3; c.z = (p[o + 2] + p[o + 5] + p[o + 8]) / 3;
    n.x = (nrm[o] + nrm[o + 3] + nrm[o + 6]) / 3; n.y = (nrm[o + 1] + nrm[o + 4] + nrm[o + 7]) / 3; n.z = (nrm[o + 2] + nrm[o + 5] + nrm[o + 8]) / 3;
    if (!keep(c, n)) continue;
    for (let k = 0; k < 9; k++) { P.push(p[o + k]); N.push(nrm[o + k]); }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.dispose();
  return out;
}

const colorCache = new Map();
function col(hex) {
  if (hex?.isColor) return hex;
  let c = colorCache.get(hex);
  if (!c) { c = new THREE.Color(hex); colorCache.set(hex, c); }
  return c;
}

/**
 * Collects parts on bones and merges them into one skinned geometry.
 *   bone(name, parent, [x, y, z])     rest position in model space (no rest rotations)
 *   add(geo, { at, rot, scale, order, bone, color, tint, glow, blur, metal, rough, smooth, faceFn })
 *     faceFn(c, n) → { color, tint, glow, metal, rough } | null — per-triangle overrides (crisp bands, dimples)
 */
class CharKit {
  constructor() {
    this.bones = [];
    this.index = new Map();
    this.parts = [];
  }

  bone(name, parent, pos) {
    const p = parent == null ? -1 : this.index.get(parent);
    if (p === undefined) throw new Error(`characters: unknown bone ${parent}`);
    this.index.set(name, this.bones.length);
    this.bones.push({ name, parent: p, pos: [...pos] });
    return this.bones.length - 1;
  }

  boneIndex(name) {
    if (typeof name === 'number') return name;
    const i = this.index.get(name ?? 'body') ?? (name == null ? 0 : undefined);
    if (i === undefined) throw new Error(`characters: unknown bone ${name}`);
    return i;
  }

  add(geo, o = {}) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...(o.at ?? [0, 0, 0])),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.rot ?? [0, 0, 0]), o.order ?? 'XYZ')),
      Array.isArray(o.scale) ? new THREE.Vector3(...o.scale) : new THREE.Vector3(o.scale ?? 1, o.scale ?? 1, o.scale ?? 1),
    );
    g.applyMatrix4(m);
    if (m.determinant() < 0) flipWinding(g);
    if (o.smooth) creaseNormals(g, o.smooth);
    if (o.keep) g = filterFaces(g, o.keep);
    this.parts.push({
      geo: g, bone: this.boneIndex(o.bone), color: col(o.color ?? '#8a8a8a'), tint: o.tint ?? 0, glow: o.glow ?? 0, blur: o.blur ?? 0,
      metal: o.metal ?? 0, rough: o.rough ?? 0.62, faceFn: o.faceFn ?? null,
    });
    return g;
  }

  /** Mirrors the last n parts across x = 0; boneMap renames bones (left ↔ right limbs). */
  mirrorX(n = 1, boneMap = null) {
    const src = this.parts.slice(-n);
    for (const p of src) {
      const g = p.geo.clone();
      g.scale(-1, 1, 1);
      flipWinding(g);
      const bname = this.bones[p.bone].name;
      const bone = boneMap?.[bname] !== undefined ? this.boneIndex(boneMap[bname]) : p.bone;
      this.parts.push({ ...p, geo: g, bone });
    }
  }

  /** A rod (cylinder) from a to b. */
  rod(a, b, r, o = {}) {
    const A = new THREE.Vector3(...a);
    const B = new THREE.Vector3(...b);
    const geo = CYL(r, o.r2 ?? r, Math.max(1e-3, A.distanceTo(B)), o.segs ?? 6, o.open ?? false);
    geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize()));
    geo.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
    return this.add(geo, o);
  }

  get triangles() {
    return this.parts.reduce((s, p) => s + p.geo.attributes.position.count / 3, 0);
  }

  build() {
    const count = this.parts.reduce((s, p) => s + p.geo.attributes.position.count, 0);
    const pos = new Float32Array(count * 3);
    const nor = new Float32Array(count * 3);
    const color = new Float32Array(count * 3);
    const tint = new Float32Array(count);
    const fx = new Float32Array(count * 4);
    const skinIndex = new Uint8Array(count * 4);
    const skinWeight = new Float32Array(count * 4);
    let at = 0;
    const c = { x: 0, y: 0, z: 0 };
    const n = { x: 0, y: 0, z: 0 };
    for (const p of this.parts) {
      const a = p.geo.attributes;
      const cnt = a.position.count;
      pos.set(a.position.array, at * 3);
      nor.set(a.normal.array, at * 3);
      const P = a.position.array;
      const N = a.normal.array;
      for (let t = 0; t < cnt; t += 3) {
        let o = null;
        if (p.faceFn) {
          const k = t * 3;
          c.x = (P[k] + P[k + 3] + P[k + 6]) / 3; c.y = (P[k + 1] + P[k + 4] + P[k + 7]) / 3; c.z = (P[k + 2] + P[k + 5] + P[k + 8]) / 3;
          n.x = N[k] + N[k + 3] + N[k + 6]; n.y = N[k + 1] + N[k + 4] + N[k + 7]; n.z = N[k + 2] + N[k + 5] + N[k + 8];
          const l = Math.hypot(n.x, n.y, n.z) || 1;
          n.x /= l; n.y /= l; n.z /= l;
          o = p.faceFn(c, n);
        }
        const cc = o?.color !== undefined ? col(o.color) : p.color;
        const tt = o?.tint ?? p.tint;
        const gl = o?.glow ?? p.glow;
        const me = o?.metal ?? p.metal;
        const ro = o?.rough ?? p.rough;
        for (let v = 0; v < 3; v++) {
          const i = at + t + v;
          color[i * 3] = cc.r; color[i * 3 + 1] = cc.g; color[i * 3 + 2] = cc.b;
          tint[i] = tt;
          fx[i * 4] = gl; fx[i * 4 + 1] = p.blur; fx[i * 4 + 2] = me; fx[i * 4 + 3] = ro;
          skinIndex[i * 4] = p.bone;
          skinWeight[i * 4] = 1;
        }
      }
      at += cnt;
      p.geo.dispose();
    }
    this.parts = [];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(color, 3));
    g.setAttribute('aTint', new THREE.BufferAttribute(tint, 1));
    g.setAttribute('aFx', new THREE.BufferAttribute(fx, 4));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return { geometry: g, bones: this.bones.map((b) => ({ ...b })), triangles: count / 3 };
  }
}

// ---- shared parts -----------------------------------------------------------------------------------

/**
 * A wheel on `bone` centred at `at`, axle along X: tyre, rim, hub, spokes (hidden while blurred) and a blur
 * disc (shown above 6 rev/s). opts: r, width, spokes, rim colour, hub colour, wall (white-wall colour).
 */
function wheel(kit, bone, at, { r, width, spokes = 8, rim = C.chrome, hub = C.chrome, wall = null, tube = null, tyreSegs = 16, spokeR = null } = {}) {
  const tr = tube ?? Math.min(r * 0.28, width / 2);
  const tyre = TOR(r - tr, tr, 6, tyreSegs);
  tyre.scale(1, 1, width / 2 / tr);
  tyre.rotateY(HALF_PI);
  kit.add(tyre, { at, bone, ...TYRE });
  if (wall) {
    const w = TOR(r - tr * 1.55, tr * 0.32, 3, tyreSegs);
    w.scale(1, 1, (width * 0.47) / (tr * 0.32));
    w.rotateY(HALF_PI);
    kit.add(w, { at, bone, color: wall, rough: 0.7 });
  }
  const inner = r - tr * 1.75;
  const rimG = TOR(inner, Math.max(0.006, tr * 0.18), 3, tyreSegs);
  rimG.rotateY(HALF_PI);
  kit.add(rimG, { at, bone, color: rim, metal: 1, rough: 0.28 });
  kit.add(cylX(Math.max(0.03, r * 0.17), width * 0.92, 8), { at, bone, color: hub, metal: 1, rough: 0.25 });
  const sr = spokeR ?? Math.max(0.006, r * 0.022);
  for (let k = 0; k < spokes; k++) {
    kit.add(BOX(sr * 1.6, inner * 2, sr * 1.6), { at, rot: [(k * Math.PI) / spokes, 0, 0], bone, color: rim, metal: 1, rough: 0.3, blur: -1 });
  }
  const disc = cylX(inner * 1.02, width * 0.5, 14);
  kit.add(disc, {
    at, bone, blur: 1, metal: 0.6, rough: 0.45,
    faceFn: (c) => {
      const d = Math.hypot(c.y - at[1], c.z - at[2]) / inner;
      return { color: d < 0.3 ? '#c9ced6' : d < 0.75 ? '#8d939b' : '#5d6168' };
    },
  });
}

/** A simple driver bust (torso + head with optional cap) on `torsoBone` / `headBone`. */
function driver(kit, { at, torsoBone = 'body', headBone = 'head', jacket = C.leather, cap = '#6e6a5a', goggles = true, scale = 1 }) {
  const [x, y, z] = at;
  const s = scale;
  kit.add(CAP(0.17 * s, 0.22 * s, 3, 10), { at: [x, y + 0.2 * s, z], scale: [1, 1, 0.75], bone: torsoBone, color: jacket, rough: 0.8 });
  kit.add(TOR(0.11 * s, 0.035 * s, 5, 12), { at: [x, y + 0.43 * s, z], rot: [HALF_PI, 0, 0], bone: torsoBone, color: C.cream, rough: 0.9 }); // scarf
  kit.add(SPH(0.11 * s, 12, 9), { at: [x, y + 0.56 * s, z], bone: headBone, color: C.skin, rough: 0.7 });
  if (cap) {
    kit.add(CYL(0.118 * s, 0.112 * s, 0.07 * s, 14), { at: [x, y + 0.64 * s, z - 0.005], bone: headBone, color: cap, rough: 0.9 });
    kit.add(CYL(0.1 * s, 0.1 * s, 0.015 * s, 12), { at: [x, y + 0.6 * s, z + 0.1 * s], scale: [1, 1, 0.7], bone: headBone, color: cap, rough: 0.9 }); // peak
  }
  if (goggles) {
    for (const dx of [0.045, -0.045]) kit.add(cylX(0.032 * s, 0.03 * s, 10).rotateY(HALF_PI), { at: [x + dx * s, y + 0.6 * s, z + 0.1 * s], bone: headBone, color: '#3a4a55', metal: 0.8, rough: 0.15 });
  }
  for (const dx of [0.045, -0.045]) kit.add(SPH(0.014 * s, 6, 4), { at: [x + dx * s, y + 0.55 * s, z + 0.1 * s], bone: headBone, color: '#1a1a1a' }); // eyes
}

/** A biped (pawn / gardener / magician share it): returns nothing; adds parts on the standard limb bones. */
function bipedLimbs(kit, { hip, shoulder, leg = [0.44, 0.45], arm = [0.3, 0.3], trousers, shoe = C.rubber, sleeve, sleeveTint = 0, skin = C.skin, glove = null, bulk = 1 }) {
  for (const side of [1, -1]) {
    const L = side > 0 ? 'L' : 'R';
    const hx = hip[0] * side;
    // thigh, shin + shoe
    kit.add(CAP(0.075 * bulk, leg[0] - 0.12, 3, 8), { at: [hx, hip[1] - leg[0] / 2, hip[2]], bone: `th${L}`, color: trousers, rough: 0.85 });
    kit.add(CAP(0.062 * bulk, leg[1] - 0.12, 3, 8), { at: [hx, hip[1] - leg[0] - leg[1] / 2 + 0.03, hip[2]], bone: `sh${L}`, color: trousers, rough: 0.85 });
    kit.add(RBOX(0.1, 0.08, 0.25, 0.035), { at: [hx, hip[1] - leg[0] - leg[1] - 0.035, hip[2] + 0.05], bone: `sh${L}`, color: shoe, rough: 0.6 });
    // upper arm, forearm + hand
    const sx = shoulder[0] * side;
    kit.add(CAP(0.055 * bulk, arm[0] - 0.08, 3, 8), { at: [sx, shoulder[1] - arm[0] / 2, shoulder[2]], bone: `ua${L}`, color: sleeve, tint: sleeveTint, rough: 0.85 });
    kit.add(CAP(0.045 * bulk, arm[1] - 0.1, 3, 8), { at: [sx, shoulder[1] - arm[0] - arm[1] / 2 + 0.04, shoulder[2]], bone: `fa${L}`, color: sleeve, tint: sleeveTint, rough: 0.85 });
    kit.add(SPH(0.05, 8, 6), { at: [sx, shoulder[1] - arm[0] - arm[1], shoulder[2]], scale: [0.8, 1, 0.9], bone: `fa${L}`, color: glove ?? skin, rough: 0.8 });
  }
}

/** Standard biped bones (pelvis / torso / head + arms + legs). */
function bipedBones(kit, parent, { hip, shoulder, neck, leg = [0.44, 0.45], arm = [0.3, 0.3] }) {
  kit.bone('pelvis', parent, hip);
  kit.bone('torso', 'pelvis', [hip[0] * 0, hip[1] + 0.05, hip[2]]);
  kit.bone('head', 'torso', neck);
  for (const side of [1, -1]) {
    const L = side > 0 ? 'L' : 'R';
    kit.bone(`ua${L}`, 'torso', [shoulder[0] * side, shoulder[1], shoulder[2]]);
    kit.bone(`fa${L}`, `ua${L}`, [shoulder[0] * side, shoulder[1] - arm[0], shoulder[2]]);
    kit.bone(`th${L}`, 'pelvis', [0.1 * side, hip[1], hip[2]]);
    kit.bone(`sh${L}`, `th${L}`, [0.1 * side, hip[1] - leg[0], hip[2]]);
  }
}

// ---- the characters --------------------------------------------------------------------------------

const BUILDERS = {
  /** The Roadster: a 1930s rounded convertible, wire wheels, cycle wings, a driver in cap and goggles. */
  car(kit) {
    kit.bone('base', null, [0, 0, 0]);
    kit.bone('body', 'base', [0, 0.55, 0]);
    kit.bone('head', 'body', [0.3, 1.21, -0.4]);
    kit.bone('steerFL', 'base', [0.76, 0.33, 1.3]);
    kit.bone('wheelFL', 'steerFL', [0.76, 0.33, 1.3]);
    kit.bone('steerFR', 'base', [-0.76, 0.33, 1.3]);
    kit.bone('wheelFR', 'steerFR', [-0.76, 0.33, 1.3]);
    kit.bone('wheelRL', 'base', [0.76, 0.33, -1.2]);
    kit.bone('wheelRR', 'base', [-0.76, 0.33, -1.2]);
    const body = profileX([
      ['m', -1.9, 0.42], ['l', 1.75, 0.4], ['q', 1.98, 0.4, 2.0, 0.6], ['l', 2.0, 0.84], ['q', 1.98, 0.97, 1.8, 0.97],
      ['l', 0.42, 1.0], ['q', 0.34, 1.0, 0.3, 0.9], ['l', 0.22, 0.84], ['l', -0.92, 0.84],
      ['q', -1.0, 0.95, -1.2, 0.96], ['q', -1.75, 0.96, -2.02, 0.62], ['q', -2.04, 0.44, -1.9, 0.42],
    ], 1.1, { bevel: 0.09, seg: 2, curve: 7 });
    deform(body, (v) => {
      v.x *= 1 - 0.24 * smoothstep(0.4, 2.05, v.z) - 0.32 * smoothstep(-1.15, -2.1, v.z);
    });
    kit.add(body, { bone: 'body', ...PAINT, smooth: 48 });
    // Cockpit tub (dark leather inside the opening) and the bench seat.
    kit.add(RBOX(1.02, 0.12, 1.08, 0.05), { at: [0, 0.82, -0.36], bone: 'body', color: '#3a2219', rough: 0.9 });
    kit.add(RBOX(1.0, 0.22, 0.32, 0.08), { at: [0, 0.98, -0.82], bone: 'body', color: C.leather, rough: 0.7 }); // seat back
    // Cycle wings (fenders) and running boards.
    for (const [x, z] of [[0.76, 1.3], [-0.76, 1.3], [0.76, -1.2], [-0.76, -1.2]]) {
      const arc = Math.PI * 0.95;
      const w = TOR(0.42, 0.055, 4, 12, arc);
      w.rotateZ((Math.PI - arc) / 2);
      w.scale(1, 1, 2.6);
      w.rotateY(HALF_PI);
      kit.add(w, { at: [x, 0.33, z], bone: 'body', color: C.black, metal: 0.4, rough: 0.35 });
    }
    for (const x of [0.74, -0.74]) kit.add(RBOX(0.22, 0.05, 1.6, 0.02), { at: [x, 0.42, 0.05], bone: 'body', color: C.black, rough: 0.5 });
    // Grille, radiator cap, bumpers, headlamps on a bar, tail lamps, exhaust, spare wheel.
    kit.add(RBOX(0.12, 0.44, 0.5, 0.04), { at: [0, 0.68, 2.0], rot: [0, HALF_PI, 0], bone: 'body', ...CHROME });
    for (let k = -2; k <= 2; k++) kit.add(BOX(0.025, 0.36, 0.03), { at: [k * 0.075, 0.68, 2.06], bone: 'body', color: '#2a2b2e', metal: 0.6, rough: 0.4 });
    kit.add(CYL(0.035, 0.04, 0.06, 8), { at: [0, 0.97, 1.92], bone: 'body', ...CHROME });
    kit.rod([-0.85, 0.42, 2.12], [0.85, 0.42, 2.12], 0.035, { bone: 'body', ...CHROME, segs: 8 });
    kit.rod([-0.8, 0.45, -2.08], [0.8, 0.45, -2.08], 0.035, { bone: 'body', ...CHROME, segs: 8 });
    kit.rod([-0.5, 0.86, 2.08], [0.5, 0.86, 2.08], 0.022, { bone: 'body', ...CHROME });
    for (const x of [0.46, -0.46]) {
      kit.add(lathe([[0, -0.13], [0.09, -0.1], [0.13, -0.02], [0.135, 0.01]], 14).rotateX(HALF_PI), { at: [x, 0.9, 2.1], bone: 'body', ...CHROME });
      kit.add(CYL(0.12, 0.12, 0.02, 14).rotateX(HALF_PI), { at: [x, 0.9, 2.115], bone: 'body', color: C.lamp, glow: 1, rough: 0.1 });
      kit.add(RBOX(0.1, 0.07, 0.04, 0.015), { at: [x * 1.1, 0.62, -2.04], bone: 'body', color: C.tail, glow: 1, rough: 0.3 });
    }
    kit.rod([-0.42, 0.4, -1.4], [-0.45, 0.38, -2.2], 0.04, { bone: 'body', ...CHROME, segs: 8 });
    const spare = TOR(0.27, 0.075, 5, 14);
    kit.add(spare, { at: [0, 0.78, -2.1], bone: 'body', ...TYRE });
    kit.add(CYL(0.12, 0.12, 0.06, 12).rotateX(HALF_PI), { at: [0, 0.78, -2.12], bone: 'body', ...CHROME });
    // Windscreen in a chrome frame, steering wheel.
    kit.add(BOX(1.0, 0.32, 0.02), { at: [0, 1.17, 0.36], rot: [-0.32, 0, 0], bone: 'body', ...GLASS });
    kit.rod([-0.52, 1.0, 0.32], [-0.52, 1.33, 0.42], 0.018, { bone: 'body', ...CHROME });
    kit.rod([0.52, 1.0, 0.32], [0.52, 1.33, 0.42], 0.018, { bone: 'body', ...CHROME });
    kit.rod([-0.52, 1.33, 0.42], [0.52, 1.33, 0.42], 0.018, { bone: 'body', ...CHROME });
    kit.add(TOR(0.16, 0.018, 5, 18), { at: [0.3, 1.05, 0.02], rot: [0.9, 0, 0], bone: 'body', color: C.black, rough: 0.4 });
    kit.rod([0.3, 1.05, 0.02], [0.3, 0.86, 0.32], 0.02, { bone: 'body', color: C.black });
    // The driver: leather jacket, scarf, cap and goggles; arms on the wheel.
    driver(kit, { at: [0.3, 0.78, -0.4], torsoBone: 'body', headBone: 'head' });
    for (const dx of [0.12, -0.12]) {
      kit.rod([0.3 + dx * 1.6, 1.12, -0.38], [0.3 + dx, 1.07, -0.05], 0.045, { bone: 'body', color: C.leather, rough: 0.8 });
      kit.add(SPH(0.045, 8, 6), { at: [0.3 + dx, 1.07, -0.03], bone: 'body', color: '#5b4632', rough: 0.8 });
    }
    // Wire wheels with white walls.
    for (const b of ['FL', 'FR', 'RL', 'RR']) {
      const B = kit.bones[kit.index.get(`wheel${b}`)].pos;
      wheel(kit, `wheel${b}`, B, { r: 0.33, width: 0.19, spokes: 8, wall: C.cream, rim: '#c8ccd2' });
    }
  },

  /** The Scottie in a tartan coat (true size; hero scale ×1.6). */
  dog(kit) {
    const FUR = '#2a2a2f';
    const FUR2 = '#3a3a40';
    kit.bone('base', null, [0, 0, 0]);
    kit.bone('body', 'base', [0, 0.3, -0.06]);
    kit.bone('chest', 'body', [0, 0.32, 0.1]);
    kit.bone('head', 'chest', [0, 0.4, 0.21]);
    kit.bone('earL', 'head', [0.045, 0.5, 0.27]);
    kit.bone('earR', 'head', [-0.045, 0.5, 0.27]);
    kit.bone('tail1', 'body', [0, 0.37, -0.23]);
    kit.bone('tail2', 'tail1', [0, 0.44, -0.26]);
    for (const [n, x, z, parent] of [['FL', 0.065, 0.15, 'chest'], ['FR', -0.065, 0.15, 'chest'], ['HL', 0.065, -0.16, 'body'], ['HR', -0.065, -0.16, 'body']]) {
      kit.bone(`leg${n}1`, parent, [x, 0.245, z]);
      kit.bone(`leg${n}2`, `leg${n}1`, [x, 0.135, z]);
    }
    // Body: hind and front halves overlap so the spine can flex. Long skirt of fur underneath.
    kit.add(RBOX(0.2, 0.2, 0.3, 0.07, 2), { at: [0, 0.33, -0.08], bone: 'body', color: FUR, rough: 0.95 });
    kit.add(RBOX(0.2, 0.21, 0.26, 0.07, 2), { at: [0, 0.335, 0.1], bone: 'chest', color: FUR, rough: 0.95 });
    kit.add(RBOX(0.17, 0.08, 0.44, 0.03), { at: [0, 0.225, 0.0], bone: 'body', color: FUR2, rough: 1 });
    // Tartan coat: player colour with dark hoops and longitudinal lines (darker shades) and a light pin stripe.
    kit.add(RBOX(0.225, 0.13, 0.27, 0.05, 2), { at: [0, 0.385, -0.06], bone: 'body', tint: 1, rough: 0.85 });
    kit.add(RBOX(0.228, 0.13, 0.17, 0.05, 2), { at: [0, 0.39, 0.13], bone: 'chest', tint: 1, rough: 0.85 });
    for (const [z, bone] of [[-0.15, 'body'], [-0.04, 'body'], [0.08, 'chest'], [0.17, 'chest']]) {
      kit.add(BOX(0.232, 0.128, 0.018), { at: [0, 0.388, z], bone, color: '#000000', tint: 0.5, rough: 0.85 });
    }
    for (const x of [0.055, -0.055]) {
      kit.add(BOX(0.016, 0.134, 0.27), { at: [x, 0.386, -0.06], bone: 'body', color: '#000000', tint: 0.55, rough: 0.85 });
      kit.add(BOX(0.016, 0.134, 0.17), { at: [x, 0.391, 0.13], bone: 'chest', color: '#000000', tint: 0.55, rough: 0.85 });
    }
    kit.add(BOX(0.008, 0.136, 0.27), { at: [0, 0.386, -0.06], bone: 'body', color: '#ffffff', tint: 0.6, rough: 0.85 });
    kit.add(BOX(0.008, 0.138, 0.17), { at: [0, 0.391, 0.13], bone: 'chest', color: '#ffffff', tint: 0.6, rough: 0.85 });
    // Collar (player colour) + gold tag.
    kit.add(TOR(0.07, 0.016, 6, 16), { at: [0, 0.4, 0.22], rot: [1.2, 0, 0], scale: [1, 1.1, 1], bone: 'chest', tint: 1, rough: 0.4 });
    kit.add(SPH(0.018, 8, 6), { at: [0, 0.33, 0.27], scale: [1, 1, 0.4], bone: 'chest', color: C.gold, metal: 1, rough: 0.25 });
    // Head: long, square, with a beard, bushy brows, erect ears, black nose.
    kit.add(RBOX(0.13, 0.13, 0.16, 0.045, 2), { at: [0, 0.46, 0.28], bone: 'head', color: FUR, rough: 0.95 });
    kit.add(RBOX(0.1, 0.09, 0.15, 0.035, 2), { at: [0, 0.45, 0.39], bone: 'head', color: FUR, rough: 0.95 });
    kit.add(RBOX(0.105, 0.08, 0.13, 0.03), { at: [0, 0.39, 0.39], bone: 'head', color: '#4a4a52', rough: 1 }); // beard
    for (const x of [0.035, -0.035]) {
      kit.add(RBOX(0.05, 0.022, 0.05, 0.01), { at: [x, 0.515, 0.35], rot: [0.35, 0, 0], bone: 'head', color: '#7a7a82', rough: 1 }); // brows
      kit.add(SPH(0.012, 8, 6), { at: [x, 0.49, 0.36], bone: 'head', color: '#0c0c0e', rough: 0.2 });
    }
    kit.add(SPH(0.022, 10, 8), { at: [0, 0.47, 0.47], scale: [1.2, 0.9, 0.8], bone: 'head', color: '#0b0b0c', rough: 0.25 });
    for (const [x, b] of [[0.045, 'earL'], [-0.045, 'earR']]) {
      kit.add(CONE(0.035, 0.1, 4), { at: [x, 0.55, 0.27], rot: [0, Math.PI / 4, 0], scale: [1, 1, 0.45], bone: b, color: FUR, rough: 0.95 });
    }
    // Tail: an upright carrot.
    kit.add(CONE(0.03, 0.09, 7), { at: [0, 0.41, -0.245], rot: [-0.35, 0, 0], bone: 'tail1', color: FUR, rough: 0.95 });
    kit.add(CONE(0.022, 0.08, 7), { at: [0, 0.49, -0.27], rot: [-0.2, 0, 0], bone: 'tail2', color: FUR, rough: 0.95 });
    // Legs (short, sturdy), paws.
    for (const n of ['FL', 'FR', 'HL', 'HR']) {
      const [x, , z] = kit.bones[kit.index.get(`leg${n}1`)].pos;
      kit.add(CAP(0.035, 0.06, 3, 8), { at: [x, 0.19, z], bone: `leg${n}1`, color: FUR, rough: 0.95 });
      kit.add(CAP(0.03, 0.06, 3, 8), { at: [x, 0.08, z], bone: `leg${n}2`, color: FUR, rough: 0.95 });
      kit.add(SPH(0.034, 8, 6), { at: [x, 0.025, z + 0.012], scale: [1, 0.6, 1.25], bone: `leg${n}2`, color: '#1d1d21', rough: 0.9 });
    }
  },

  /** The Magician: a young street performer in an oversized top hat on a penny-farthing. */
  hat(kit) {
    const TROUSERS = '#2b2d42';
    const SHIRT = '#f4f1e8';
    kit.bone('base', null, [0, 0, 0]);
    kit.bone('frame', 'base', [0, 0, 0]);
    kit.bone('steer', 'frame', [0, 1.55, 0.2]);
    kit.bone('wheelF', 'steer', [0, 0.75, 0.3]);
    kit.bone('wheelR', 'frame', [0, 0.2, -0.6]);
    bipedBones(kit, 'frame', { hip: [0, 1.56, -0.02], shoulder: [0.19, 2.02, 0.02], neck: [0, 2.12, 0.03], leg: [0.5, 0.5], arm: [0.3, 0.3] });
    kit.bone('hat', 'head', [0, 2.3, 0.03]);
    kit.bone('dove', 'hat', [0, 2.45, 0.03]);
    // Big wheel (r 0.75) with many spokes; small rear wheel; fork, backbone, saddle, handlebar.
    wheel(kit, 'wheelF', [0, 0.75, 0.3], { r: 0.75, width: 0.06, spokes: 16, tube: 0.026, rim: '#9aa0a8', hub: C.chrome, tyreSegs: 36, spokeR: 0.006 });
    wheel(kit, 'wheelR', [0, 0.2, -0.6], { r: 0.2, width: 0.045, spokes: 6, tube: 0.02, rim: '#9aa0a8', tyreSegs: 16, spokeR: 0.005 });
    // Cranks + pedals on the front hub (they turn with the wheel).
    for (const s of [1, -1]) {
      kit.add(BOX(0.025, 0.15, 0.03), { at: [0.08 * s, 0.75 - 0.065 * s, 0.3], bone: 'wheelF', ...CHROME });
      kit.add(BOX(0.09, 0.025, 0.05), { at: [0.12 * s, 0.75 - 0.13 * s, 0.3], bone: 'wheelF', color: C.black, rough: 0.6 });
    }
    for (const s of [1, -1]) kit.rod([0.055 * s, 0.75, 0.3], [0.03 * s, 1.56, 0.19], 0.018, { bone: 'steer', color: C.black, metal: 0.6, rough: 0.35 });
    kit.rod([-0.3, 1.66, 0.27], [0.3, 1.66, 0.27], 0.016, { bone: 'steer', ...CHROME });
    for (const s of [1, -1]) kit.add(CAP(0.022, 0.07, 2, 8), { at: [0.33 * s, 1.66, 0.27], rot: [0, 0, HALF_PI], bone: 'steer', color: C.rubber });
    kit.rod([0, 1.56, 0.19], [0, 1.66, 0.27], 0.02, { bone: 'steer', color: C.black, metal: 0.6, rough: 0.35 });
    const spine = new THREE.CatmullRomCurve3([[0, 1.55, 0.16], [0, 1.52, -0.08], [0, 1.32, -0.42], [0, 0.85, -0.6], [0, 0.32, -0.6]].map((p) => new THREE.Vector3(...p)));
    kit.add(new THREE.TubeGeometry(spine, 18, 0.028, 7, false), { bone: 'frame', color: C.black, metal: 0.6, rough: 0.35 });
    for (const s of [1, -1]) kit.rod([0.03 * s, 0.85, -0.6], [0.03 * s, 0.2, -0.6], 0.012, { bone: 'frame', color: C.black, metal: 0.6, rough: 0.35 });
    kit.add(RBOX(0.17, 0.06, 0.26, 0.03), { at: [0, 1.555, -0.03], bone: 'frame', color: C.leather, rough: 0.6 }); // saddle
    // The rider: waistcoat (player colour) over a white shirt, dark trousers, young face, oversized top hat.
    bipedLimbs(kit, { hip: [0.1, 1.56, -0.02], shoulder: [0.19, 2.02, 0.02], leg: [0.5, 0.5], arm: [0.3, 0.3], trousers: TROUSERS, sleeve: SHIRT, shoe: '#151515' });
    kit.add(RBOX(0.3, 0.16, 0.22, 0.07), { at: [0, 1.6, -0.02], bone: 'pelvis', color: TROUSERS, rough: 0.85 });
    kit.add(CAP(0.15, 0.24, 3, 10), { at: [0, 1.84, 0.02], scale: [1.1, 1, 0.78], bone: 'torso', color: SHIRT, rough: 0.85 });
    kit.add(RBOX(0.33, 0.33, 0.24, 0.09, 2), { at: [0, 1.81, 0.02], bone: 'torso', tint: 1, rough: 0.55 }); // waistcoat
    for (let k = 0; k < 3; k++) kit.add(SPH(0.012, 6, 4), { at: [0, 1.72 + k * 0.07, 0.145], bone: 'torso', color: C.gold, metal: 1, rough: 0.3 });
    kit.add(RBOX(0.12, 0.05, 0.03, 0.012), { at: [0, 2.0, 0.12], bone: 'torso', color: '#141414', rough: 0.5 }); // bow tie
    kit.add(CYL(0.05, 0.055, 0.08, 10), { at: [0, 2.07, 0.03], bone: 'torso', color: C.skin, rough: 0.7 }); // neck
    kit.add(SPH(0.105, 16, 12), { at: [0, 2.2, 0.03], scale: [1, 1.08, 1], bone: 'head', color: C.skin, rough: 0.7 });
    kit.add(SPH(0.11, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), { at: [0, 2.21, 0.015], bone: 'head', color: '#7a4a2a', rough: 0.9 }); // hair (auburn)
    for (const x of [0.038, -0.038]) {
      kit.add(SPH(0.014, 8, 6), { at: [x, 2.22, 0.125], bone: 'head', color: '#20160f', rough: 0.3 });
      kit.add(SPH(0.022, 6, 4), { at: [x * 2.75, 2.2, 0.03], scale: [0.5, 1, 0.8], bone: 'head', color: C.skin, rough: 0.7 }); // ears
    }
    kit.add(TOR(0.03, 0.007, 4, 10, Math.PI), { at: [0, 2.165, 0.11], rot: [0, 0, Math.PI], bone: 'head', color: '#8a3b30', rough: 0.6 }); // smile
    kit.add(CYL(0.21, 0.21, 0.02, 24), { at: [0, 2.3, 0.03], bone: 'hat', color: '#141416', rough: 0.55 }); // brim
    kit.add(CYL(0.14, 0.128, 0.38, 22), { at: [0, 2.5, 0.03], bone: 'hat', color: '#141416', rough: 0.55 }); // crown
    kit.add(CYL(0.133, 0.131, 0.075, 22), { at: [0, 2.35, 0.03], bone: 'hat', tint: 1, rough: 0.45 }); // band
    // The dove (hidden in the hat until it pops out).
    kit.add(SPH(0.05, 10, 8), { at: [0, 2.47, 0.03], scale: [0.85, 0.85, 1.3], bone: 'dove', color: C.white, rough: 0.8 });
    kit.add(SPH(0.03, 8, 6), { at: [0, 2.52, 0.09], bone: 'dove', color: C.white, rough: 0.8 });
    kit.add(CONE(0.01, 0.025, 5), { at: [0, 2.52, 0.125], rot: [HALF_PI, 0, 0], bone: 'dove', color: '#e0a030' });
    for (const s of [1, -1]) kit.add(SPH(0.045, 8, 6), { at: [0.05 * s, 2.49, 0.02], scale: [1.4, 0.35, 0.9], rot: [0, 0, 0.5 * s], bone: 'dove', color: '#eeeeea', rough: 0.8 });
  },

  /** The Duck Boat: an amphibious tour boat with six wheels, a canopy, a funnel and pennants. */
  ship(kit) {
    const OLIVE = '#56603a';
    kit.bone('base', null, [0, 0, 0]);
    kit.bone('body', 'base', [0, 1.0, 0]);
    kit.bone('head', 'body', [0.62, 1.91, 2.45]);
    kit.bone('pennant', 'body', [0, 2.7, -2.0]);
    kit.bone('steerFL', 'base', [1.02, 0.55, 2.55]);
    kit.bone('wheelFL', 'steerFL', [1.02, 0.55, 2.55]);
    kit.bone('steerFR', 'base', [-1.02, 0.55, 2.55]);
    kit.bone('wheelFR', 'steerFR', [-1.02, 0.55, 2.55]);
    kit.bone('wheelML', 'base', [1.02, 0.55, -1.7]);
    kit.bone('wheelMR', 'base', [-1.02, 0.55, -1.7]);
    kit.bone('wheelRL', 'base', [1.02, 0.55, -2.95]);
    kit.bone('wheelRR', 'base', [-1.02, 0.55, -2.95]);
    // Hull: boat profile (raked bow), crisp bands: olive bottom, cream topsides, player-colour stripe.
    const hull = profileX([
      ['m', -4.62, 0.82], ['l', 2.7, 0.82], ['q', 4.1, 0.86, 4.7, 1.55], ['l', 4.72, 1.62], ['l', -4.7, 1.55], ['l', -4.62, 0.82],
    ], 2.3, { bevel: 0.07, seg: 2, curve: 8 });
    deform(hull, (v) => {
      const b = smoothstep(2.2, 4.75, v.z);
      v.x *= 1 - 0.62 * b * b;
      v.y += 0.12 * smoothstep(1.5, 4.7, v.z) * smoothstep(1.2, 1.6, v.y); // sheer
    });
    kit.add(hull, {
      bone: 'body', rough: 0.45, metal: 0.15, smooth: 40,
      faceFn: (c, n) => (n.y > 0.7 ? { color: '#b9a98a', rough: 0.8 } : c.y < 1.02 ? { color: OLIVE } : c.y < 1.24 ? { tint: 1, color: '#000000', rough: 0.35, metal: 0.25 } : { color: '#f1ead2' }),
    });
    // Life rings, bow fender.
    for (const s of [1, -1]) kit.add(TOR(0.22, 0.06, 6, 14), { at: [1.17 * s, 1.3, -0.4], rot: [0, HALF_PI, 0], bone: 'body', color: '#f26b21', rough: 0.6, faceFn: (c) => ({ color: Math.floor((Math.atan2(c.y - 1.3, c.z + 0.4) / Math.PI) * 4 + 8) % 2 ? '#f26b21' : C.white }) });
    kit.add(SPH(0.22, 10, 8), { at: [0, 1.48, 4.72], scale: [1, 0.8, 0.7], bone: 'body', color: '#c9b28a', rough: 0.9 });
    // Deck: benches, windscreen, canopy on posts with player-colour trim.
    for (let k = 0; k < 5; k++) {
      const z = 1.2 - k * 1.05;
      for (const s of [1, -1]) {
        kit.add(BOX(0.82, 0.12, 0.42), { at: [0.5 * s, 2.05, z], bone: 'body', color: '#4b6a8a', rough: 0.6 });
        kit.add(BOX(0.82, 0.38, 0.08), { at: [0.5 * s, 2.27, z - 0.22], bone: 'body', color: '#4b6a8a', rough: 0.6 });
      }
    }
    kit.add(BOX(2.1, 0.5, 0.04), { at: [0, 2.0, 2.15], rot: [-0.25, 0, 0], bone: 'body', ...GLASS });
    kit.add(BOX(2.15, 0.06, 0.08), { at: [0, 2.26, 2.21], bone: 'body', color: C.white, rough: 0.5 });
    for (const z of [1.9, -0.7, -3.4]) {
      for (const s of [1, -1]) kit.rod([1.05 * s, 1.62, z], [1.05 * s, 2.62, z], 0.035, { bone: 'body', color: C.white, rough: 0.4 });
    }
    kit.add(RBOX(2.36, 0.08, 5.6, 0.03), { at: [0, 2.68, -0.75], bone: 'body', color: '#f6f2e6', rough: 0.85 });
    kit.add(BOX(2.4, 0.18, 5.64), { at: [0, 2.59, -0.75], bone: 'body', tint: 1, rough: 0.6, keep: (c, n) => Math.abs(n.y) < 0.5 });
    const scallop = new THREE.BufferGeometry();
    scallop.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.2, 0, 0, 0.2, 0, -0.14, 0, 0, 0, 0.2, 0, 0, -0.2, 0, -0.14, 0], 3));
    scallop.computeVertexNormals();
    for (let k = 0; k < 14; k++) for (const s of [1, -1]) kit.add(scallop.clone(), { at: [1.205 * s, 2.5, 1.85 - k * 0.4], bone: 'body', tint: 1, rough: 0.6 }); // scallops
    scallop.dispose();
    // Funnel (cream with a player-colour band and a black top) and pennants on a line to the canopy.
    kit.add(CYL(0.22, 0.25, 1.75, 16), { at: [0, 2.48, -4.1], bone: 'body', color: C.cream, rough: 0.5 });
    kit.add(CYL(0.235, 0.235, 0.22, 16), { at: [0, 2.85, -4.1], bone: 'body', tint: 1, rough: 0.4 });
    kit.add(CYL(0.235, 0.235, 0.2, 16), { at: [0, 3.3, -4.1], bone: 'body', color: C.black, rough: 0.5 });
    kit.rod([0, 3.38, -4.1], [0, 2.72, 1.9], 0.008, { bone: 'pennant', color: '#555555' });
    for (let k = 0; k < 9; k++) {
      const f = (k + 0.5) / 9;
      const tri = new THREE.BufferGeometry();
      tri.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.13, 0, 0, 0.13, 0, -0.26, 0, 0, 0, 0.13, 0, 0, -0.13, 0, -0.26, 0], 3));
      tri.computeVertexNormals();
      kit.add(tri, { at: [0, 3.38 + (2.72 - 3.38) * f, -4.1 + 6.0 * f], bone: 'pennant', ...(k % 2 ? { color: C.white } : { tint: 1 }), rough: 0.7 });
    }
    // Lamps.
    for (const s of [1, -1]) {
      kit.add(CYL(0.1, 0.1, 0.08, 12).rotateX(HALF_PI), { at: [0.62 * s, 1.5, 4.05], bone: 'body', color: C.lamp, glow: 1, rough: 0.1 });
      kit.add(RBOX(0.14, 0.1, 0.05, 0.02), { at: [0.95 * s, 1.35, -4.72], bone: 'body', color: C.tail, glow: 1, rough: 0.3 });
    }
    // The skipper (captain's cap).
    driver(kit, { at: [0.62, 1.48, 2.45], torsoBone: 'body', headBone: 'head', jacket: '#24324a', cap: '#f4f4f0', goggles: false });
    for (const b of ['FL', 'FR', 'ML', 'MR', 'RL', 'RR']) {
      const B = kit.bones[kit.index.get(`wheel${b}`)].pos;
      wheel(kit, `wheel${b}`, B, { r: 0.55, width: 0.34, spokes: 6, rim: OLIVE, hub: '#3a4128', tyreSegs: 18 });
    }
  },

  /** The Boot Car: a lace-up boot art car with brass eyelets, a thick sole and a hydraulic heel-hop. */
  boot(kit) {
    kit.bone('base', null, [0, 0, 0]);
    kit.bone('body', 'base', [0, 0.6, 0]);
    kit.bone('tongue', 'body', [0, 1.95, -0.32]);
    kit.bone('steerFL', 'base', [0.72, 0.36, 1.45]);
    kit.bone('wheelFL', 'steerFL', [0.72, 0.36, 1.45]);
    kit.bone('steerFR', 'base', [-0.72, 0.36, 1.45]);
    kit.bone('wheelFR', 'steerFR', [-0.72, 0.36, 1.45]);
    kit.bone('wheelRL', 'base', [0.72, 0.36, -1.55]);
    kit.bone('wheelRR', 'base', [-0.72, 0.36, -1.55]);
    // Upper (player-colour leather).
    const upper = profileX([
      ['m', -2.2, 0.62], ['l', 1.95, 0.62], ['q', 2.32, 0.62, 2.32, 0.92], ['q', 2.3, 1.2, 1.78, 1.24],
      ['l', 0.6, 1.38], ['q', -0.12, 1.45, -0.38, 1.95], ['l', -0.52, 2.55], ['l', -2.12, 2.6],
      ['q', -2.28, 1.6, -2.26, 1.0], ['q', -2.26, 0.62, -2.2, 0.62],
    ], 1.5, { bevel: 0.12, seg: 3, curve: 8 });
    deform(upper, (v) => {
      v.x *= 1 - 0.28 * smoothstep(1.1, 2.4, v.z) ** 1.4 - 0.12 * smoothstep(1.5, 2.6, v.y);
    });
    kit.add(upper, { bone: 'body', tint: 1, rough: 0.42, metal: 0.05, smooth: 50, faceFn: (c, n) => (n.y > 0.85 && c.y > 2.4 ? { color: '#1a1410', tint: 0, rough: 1 } : null) });
    // Toe cap seam, rolled collar, pull tab, sole and heel.
    kit.add(TOR(0.62, 0.035, 4, 20, Math.PI), { at: [0, 0.98, 1.72], rot: [-HALF_PI, 0, 0], scale: [1.15, 1, 0.6], bone: 'body', color: '#000000', tint: 0.6, rough: 0.5 });
    kit.add(TOR(0.5, 0.07, 6, 24), { at: [0, 2.6, -1.32], rot: [HALF_PI, 0, 0], scale: [1.35, 1.6, 1], bone: 'body', color: '#000000', tint: 0.65, rough: 0.5 });
    kit.add(TOR(0.16, 0.04, 5, 10, Math.PI), { at: [0, 2.62, -2.18], rot: [0, HALF_PI, 0], bone: 'body', color: '#3b2a20', rough: 0.7 });
    const sole = profileX([['m', -2.3, 0.3], ['l', 2.2, 0.3], ['q', 2.45, 0.3, 2.42, 0.62], ['l', -2.32, 0.66], ['q', -2.34, 0.3, -2.3, 0.3]], 1.62, { bevel: 0.05, seg: 2, curve: 6 });
    deform(sole, (v) => { v.x *= 1 - 0.28 * smoothstep(1.1, 2.4, v.z) ** 1.4; });
    kit.add(sole, { bone: 'body', color: '#2a211b', rough: 0.85 });
    kit.add(RBOX(1.0, 0.3, 1.0, 0.06), { at: [0, 0.3, -1.75], bone: 'body', color: '#2a211b', rough: 0.85 }); // heel block
    for (const s of [1, -1]) kit.add(BOX(0.02, 0.05, 4.3), { at: [0.79 * s, 0.5, 0.05], bone: 'body', color: '#e9e2d0', rough: 0.7 }); // welt stitching
    // Windscreen on the vamp, oval side windows, headlamp "eyes" on the toe, tail lamps, twin exhausts.
    kit.add(BOX(1.0, 0.42, 0.04), { at: [0, 1.6, 0.08], rot: [-1.05, 0, 0], bone: 'body', ...GLASS });
    for (const s of [1, -1]) {
      kit.add(SPH(0.3, 12, 8), { at: [0.74 * s, 1.95, -1.2], scale: [0.12, 0.7, 1.2], bone: 'body', ...GLASS });
      kit.add(TOR(0.3, 0.025, 4, 16), { at: [0.76 * s, 1.95, -1.2], rot: [0, HALF_PI, 0], scale: [1, 0.7, 1.2], bone: 'body', color: C.brass, metal: 1, rough: 0.3 });
      kit.add(CYL(0.11, 0.11, 0.06, 14).rotateX(HALF_PI), { at: [0.36 * s, 1.0, 2.24], rot: [0, 0.35 * s, 0], bone: 'body', color: C.lamp, glow: 1, rough: 0.1 });
      kit.add(TOR(0.11, 0.022, 4, 14), { at: [0.36 * s, 1.0, 2.25], rot: [0, 0.35 * s, 0], bone: 'body', ...CHROME });
      kit.add(RBOX(0.16, 0.1, 0.05, 0.02), { at: [0.5 * s, 0.8, -2.28], bone: 'body', color: C.tail, glow: 1, rough: 0.3 });
      kit.rod([0.3 * s, 0.32, -1.9], [0.3 * s, 0.34, -2.45], 0.05, { bone: 'body', ...CHROME, segs: 10 });
    }
    // Lace opening: brass eyelets up the instep with criss-cross laces; the tongue rises between them.
    const lacePt = (f, s) => [0.26 * s, 1.42 + f * 1.05, 0.25 - f * 0.68];
    kit.add(RBOX(0.42, 1.2, 0.08, 0.04), { at: [0, 2.0, -0.18], rot: [-0.55, 0, 0], bone: 'tongue', color: '#000000', tint: 0.8, rough: 0.5 });
    for (let k = 0; k < 6; k++) {
      const f = k / 5;
      for (const s of [1, -1]) kit.add(TOR(0.035, 0.014, 3, 8), { at: lacePt(f, s), rot: [0.9, 0, 0], bone: 'body', color: C.brass, metal: 1, rough: 0.25 });
      if (k < 5) {
        kit.rod(lacePt(f, 1), lacePt(f + 0.2, -1), 0.016, { bone: 'body', color: '#f2ecdf', rough: 0.8 });
        kit.rod(lacePt(f, -1), lacePt(f + 0.2, 1), 0.016, { bone: 'body', color: '#f2ecdf', rough: 0.8 });
      }
    }
    kit.rod(lacePt(1, 1), [0.18, 2.75, -0.4], 0.016, { bone: 'body', color: '#f2ecdf' }); // bow ends
    kit.rod(lacePt(1, -1), [-0.2, 2.72, -0.35], 0.016, { bone: 'body', color: '#f2ecdf' });
    for (const b of ['FL', 'FR', 'RL', 'RR']) {
      const B = kit.bones[kit.index.get(`wheel${b}`)].pos;
      wheel(kit, `wheel${b}`, B, { r: 0.36, width: 0.24, spokes: 5, rim: C.brass, hub: C.brass });
    }
  },

  /** The ginger tabby with a collar and bell (true size; hero scale ×1.8). */
  cat(kit) {
    const GINGER = '#d9822b';
    const STRIPE = '#a8571a';
    const CREAM = '#f3dcb6';
    const stripes = (axis = 'z', k = 34, off = 0) => (c, n) => {
      if (n.y < -0.35) return { color: CREAM };
      const v = axis === 'z' ? c.z : c.y;
      return Math.sin(v * k + off) > 0.45 ? { color: STRIPE } : null;
    };
    kit.bone('base', null, [0, 0, 0]);
    kit.bone('body', 'base', [0, 0.26, -0.08]);
    kit.bone('chest', 'body', [0, 0.27, 0.09]);
    kit.bone('head', 'chest', [0, 0.33, 0.19]);
    kit.bone('earL', 'head', [0.04, 0.42, 0.22]);
    kit.bone('earR', 'head', [-0.04, 0.42, 0.22]);
    kit.bone('tail1', 'body', [0, 0.29, -0.21]);
    kit.bone('tail2', 'tail1', [0, 0.33, -0.3]);
    kit.bone('tail3', 'tail2', [0, 0.4, -0.36]);
    kit.bone('tail4', 'tail3', [0, 0.48, -0.39]);
    for (const [n, x, z, parent, y] of [['FL', 0.045, 0.13, 'chest', 0.235], ['FR', -0.045, 0.13, 'chest', 0.235], ['HL', 0.05, -0.14, 'body', 0.24], ['HR', -0.05, -0.14, 'body', 0.24]]) {
      kit.bone(`leg${n}1`, parent, [x, y, z]);
      kit.bone(`leg${n}2`, `leg${n}1`, [x, y - 0.105, z]);
    }
    kit.add(SPH(0.1, 16, 12), { at: [0, 0.28, -0.08], scale: [0.85, 0.82, 1.25], bone: 'body', color: GINGER, rough: 0.9, faceFn: stripes('z', 42) });
    kit.add(SPH(0.09, 16, 12), { at: [0, 0.285, 0.08], scale: [0.85, 0.9, 1.15], bone: 'chest', color: GINGER, rough: 0.9, faceFn: stripes('z', 42) });
    kit.add(SPH(0.05, 10, 8), { at: [0, 0.255, 0.165], scale: [1, 1.2, 0.8], bone: 'chest', color: CREAM, rough: 0.95 }); // bib
    // Collar + ribbon bow (player colour) + gold bell.
    kit.add(TOR(0.055, 0.013, 6, 16), { at: [0, 0.32, 0.17], rot: [1.25, 0, 0], bone: 'chest', tint: 1, rough: 0.4 });
    for (const s of [1, -1]) kit.add(SPH(0.02, 6, 5), { at: [0.022 * s, 0.275, 0.215], scale: [1.4, 0.8, 0.5], rot: [0, 0, 0.4 * s], bone: 'chest', tint: 1, rough: 0.5 });
    kit.add(SPH(0.019, 10, 8), { at: [0, 0.255, 0.218], bone: 'chest', color: C.gold, metal: 1, rough: 0.2 });
    // Head: round, cheeks, muzzle, pink nose, green eyes, pointed ears with pink insides.
    kit.add(SPH(0.075, 18, 14), { at: [0, 0.37, 0.235], scale: [1.08, 0.95, 1], bone: 'head', color: GINGER, rough: 0.9, faceFn: (c, n) => (n.z > 0.55 && c.y < 0.36 ? { color: CREAM } : n.y > 0.5 && Math.sin(c.x * 120) > 0.3 ? { color: STRIPE } : null) });
    kit.add(SPH(0.034, 10, 8), { at: [0, 0.345, 0.3], scale: [1.3, 0.85, 0.9], bone: 'head', color: CREAM, rough: 0.95 });
    kit.add(SPH(0.012, 8, 6), { at: [0, 0.362, 0.33], scale: [1.2, 0.8, 0.8], bone: 'head', color: '#e58f9a', rough: 0.5 });
    for (const x of [0.03, -0.03]) {
      kit.add(SPH(0.016, 10, 8), { at: [x, 0.387, 0.296], scale: [1, 1.15, 0.6], bone: 'head', color: '#6fbf3a', rough: 0.15, metal: 0.1 });
      kit.add(SPH(0.007, 6, 4), { at: [x, 0.387, 0.305], scale: [0.5, 1.3, 0.6], bone: 'head', color: '#090909', rough: 0.2 });
    }
    for (const [x, b] of [[0.04, 'earL'], [-0.04, 'earR']]) {
      kit.add(CONE(0.03, 0.06, 4), { at: [x, 0.445, 0.225], rot: [0, Math.PI / 4, 0], scale: [1, 1, 0.5], bone: b, color: GINGER, rough: 0.9 });
      kit.add(CONE(0.018, 0.04, 4), { at: [x, 0.44, 0.235], rot: [0, Math.PI / 4, 0], scale: [1, 1, 0.3], bone: b, color: '#e8a3a8', rough: 0.9 });
    }
    // Tail: four segments, banded.
    const tailSeg = (a, b, r, bone) => kit.rod(a, b, r, { bone, color: GINGER, rough: 0.9, segs: 8, faceFn: (c) => (Math.sin((c.y + c.z) * 70) > 0.3 ? { color: STRIPE } : null) });
    tailSeg([0, 0.29, -0.2], [0, 0.335, -0.305], 0.022, 'tail1');
    tailSeg([0, 0.33, -0.3], [0, 0.405, -0.365], 0.02, 'tail2');
    tailSeg([0, 0.4, -0.36], [0, 0.485, -0.395], 0.019, 'tail3');
    tailSeg([0, 0.48, -0.39], [0, 0.56, -0.39], 0.018, 'tail4');
    kit.add(SPH(0.019, 8, 6), { at: [0, 0.56, -0.39], bone: 'tail4', color: STRIPE, rough: 0.9 });
    // Legs and paws (white socks on the front paws).
    for (const n of ['FL', 'FR', 'HL', 'HR']) {
      const [x, y, z] = kit.bones[kit.index.get(`leg${n}1`)].pos;
      const hind = n[0] === 'H';
      kit.add(CAP(hind ? 0.036 : 0.026, 0.07, 3, 8), { at: [x, y - 0.05, z], bone: `leg${n}1`, color: GINGER, rough: 0.9 });
      kit.add(CAP(0.02, 0.08, 3, 8), { at: [x, y - 0.155, z], bone: `leg${n}2`, color: GINGER, rough: 0.9, faceFn: stripes('y', 90) });
      kit.add(SPH(0.024, 8, 6), { at: [x, 0.018, z + 0.01], scale: [1, 0.65, 1.3], bone: `leg${n}2`, color: hind ? GINGER : CREAM, rough: 0.9 });
    }
  },

  /** The Thimble Car: an Isetta-style bubble car with a dimpled silver dome and a front door. */
  thimble(kit) {
    const SILVER = '#dde1e7';
    const DIMPLE = '#9ea5ae';
    kit.bone('base', null, [0, 0, 0]);
    kit.bone('body', 'base', [0, 0.5, 0]);
    kit.bone('door', 'body', [0.6, 0.55, 0.88]);
    kit.bone('head', 'body', [0.15, 0.81, 0.0]);
    kit.bone('steerFL', 'base', [0.58, 0.25, 0.6]);
    kit.bone('wheelFL', 'steerFL', [0.58, 0.25, 0.6]);
    kit.bone('steerFR', 'base', [-0.58, 0.25, 0.6]);
    kit.bone('wheelFR', 'steerFR', [-0.58, 0.25, 0.6]);
    kit.bone('wheelR', 'base', [0, 0.25, -0.85]);
    const egg = () => {
      const g = SPH(1, 32, 22);
      deform(g, (v) => {
        const front = v.z > 0 ? 1.0 : 1.12;
        v.set(v.x * 0.7, v.y, v.z * 1.12 * front);
        v.y = 0.74 + v.y * (v.y > 0 ? 0.62 : 0.42);
        if (v.y < 0.36) v.y = 0.36;
        v.z -= 0.05;
      });
      return g;
    };
    // Dimples: a staggered grid of darker faces on the dome (rows by height, columns by azimuth).
    const dimpled = (c) => {
      if (c.y < 0.86) return null;
      const row = Math.round((c.y - 0.86) / 0.07);
      const az = Math.atan2(c.x, c.z) / (Math.PI * 2) * 30 + (row % 2) * 0.5;
      return Math.abs(az - Math.round(az)) < 0.2 && Math.abs((c.y - 0.86) / 0.07 - row) < 0.3 ? { color: DIMPLE, rough: 0.35 } : null;
    };
    const glassBand = (c, n) => (c.y > 0.9 && c.y < 1.18 && Math.abs(n.x) > 0.55 && c.z > -0.45 && c.z < 0.55) || (c.y > 0.92 && c.z > 0.86);
    kit.add(egg(), {
      bone: 'body', color: SILVER, metal: 1, rough: 0.2, keep: (c) => c.z <= 0.84,
      faceFn: (c, n) => (glassBand(c, n) ? { color: C.glass, metal: 0.3, rough: 0.06 } : c.y < 0.8 ? { color: '#c3c9d1', rough: 0.3 } : dimpled(c)),
    });
    kit.add(egg(), {
      bone: 'door', color: SILVER, metal: 1, rough: 0.2, keep: (c) => c.z > 0.84,
      faceFn: (c, n) => (glassBand(c, n) ? { color: C.glass, metal: 0.3, rough: 0.06 } : c.y < 0.8 ? { color: '#c3c9d1', rough: 0.3 } : null),
    });
    // The rolled rim band round the dome (player colour), like a thimble's rim.
    kit.add(TOR(1, 0.045, 5, 32), { at: [0, 0.82, -0.115], rot: [HALF_PI, 0, 0], scale: [0.705, 1.185, 1], bone: 'body', ...PAINT, keep: (c) => c.z <= 0.84 });
    kit.add(TOR(1, 0.045, 5, 32), { at: [0, 0.82, -0.115], rot: [HALF_PI, 0, 0], scale: [0.705, 1.185, 1], bone: 'door', ...PAINT, keep: (c) => c.z > 0.84 });
    // Door handle, bumper, headlamp pods, tail lamps.
    kit.rod([-0.25, 0.75, 1.02], [0.25, 0.75, 1.02], 0.015, { bone: 'door', ...CHROME });
    kit.rod([-0.62, 0.33, 1.05], [0.62, 0.33, 1.05], 0.03, { bone: 'body', ...CHROME, segs: 8 });
    for (const s of [1, -1]) {
      kit.add(CYL(0.075, 0.09, 0.16, 12).rotateX(HALF_PI), { at: [0.6 * s, 0.68, 0.72], bone: 'body', color: SILVER, metal: 1, rough: 0.25 });
      kit.add(CYL(0.07, 0.07, 0.02, 12).rotateX(HALF_PI), { at: [0.6 * s, 0.68, 0.81], bone: 'body', color: C.lamp, glow: 1, rough: 0.1 });
      kit.add(RBOX(0.12, 0.06, 0.04, 0.015), { at: [0.42 * s, 0.6, -1.25], bone: 'body', color: C.tail, glow: 1, rough: 0.3 });
    }
    // Wheel arches (dark) and the driver behind the door.
    for (const [x, z] of [[0.58, 0.6], [-0.58, 0.6], [0, -0.85]]) {
      const arc = Math.PI * 0.9;
      const w = TOR(0.32, 0.04, 4, 12, arc);
      w.rotateZ((Math.PI - arc) / 2);
      w.scale(1, 1, x ? 2.2 : 3);
      w.rotateY(HALF_PI);
      kit.add(w, { at: [x * 1.05, 0.25, z], bone: 'body', color: '#3a3d42', metal: 0.3, rough: 0.4 });
    }
    driver(kit, { at: [0.15, 0.42, 0.0], torsoBone: 'body', headBone: 'head', jacket: '#7c2d3a', cap: null, goggles: false, scale: 0.95 });
    kit.add(SPH(0.115, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), { at: [0.15, 0.95, -0.01], bone: 'head', color: '#2e1f16', rough: 0.9 });
    for (const b of ['FL', 'FR', 'R']) {
      const B = kit.bones[kit.index.get(`wheel${b}`)].pos;
      wheel(kit, `wheel${b}`, B, { r: 0.25, width: 0.14, spokes: 4, rim: '#e9ecef', hub: C.chrome });
    }
  },

  /** The Gardener in dungarees and a straw hat pushing a wheelbarrow of flowers. */
  wheelbarrow(kit) {
    kit.bone('base', null, [0, 0, 0]);
    bipedBones(kit, 'base', { hip: [0, 0.92, -0.98], shoulder: [0.2, 1.42, -0.95], neck: [0, 1.5, -0.93], leg: [0.44, 0.44], arm: [0.3, 0.32] });
    kit.bone('barrow', 'base', [0, 0.2, 1.0]);
    kit.bone('bwheel', 'barrow', [0, 0.2, 1.0]);
    kit.bone('flowers', 'barrow', [0, 0.62, 0.35]);
    // Gardener: dungarees over a checked shirt, gloves, boots, straw hat.
    bipedLimbs(kit, { hip: [0.1, 0.92, -0.98], shoulder: [0.2, 1.42, -0.95], leg: [0.44, 0.44], arm: [0.3, 0.32], trousers: C.denim, sleeve: '#b8473f', shoe: '#4a3020', glove: '#4f7a3a', bulk: 1.05 });
    kit.add(RBOX(0.34, 0.2, 0.24, 0.08, 2), { at: [0, 0.94, -0.98], bone: 'pelvis', color: C.denim, rough: 0.85 });
    kit.add(CAP(0.16, 0.24, 3, 10), { at: [0, 1.2, -0.96], scale: [1.1, 1, 0.78], bone: 'torso', color: '#b8473f', rough: 0.85, faceFn: (c) => ((Math.floor(c.y * 18) + Math.floor((c.x + 1) * 18)) % 2 ? { color: '#e8d9c8' } : null) });
    kit.add(RBOX(0.3, 0.3, 0.25, 0.06), { at: [0, 1.12, -0.96], bone: 'torso', color: C.denim, rough: 0.85 }); // bib
    for (const s of [1, -1]) kit.add(BOX(0.04, 0.32, 0.27), { at: [0.09 * s, 1.3, -0.96], bone: 'torso', color: C.denim, rough: 0.85 }); // straps
    for (const s of [1, -1]) kit.add(SPH(0.014, 6, 4), { at: [0.09 * s, 1.2, -0.82], bone: 'torso', color: C.brass, metal: 1, rough: 0.3 });
    kit.add(CYL(0.05, 0.055, 0.08, 10), { at: [0, 1.46, -0.94], bone: 'torso', color: C.skinTan, rough: 0.7 });
    kit.add(SPH(0.105, 16, 12), { at: [0, 1.58, -0.93], scale: [1, 1.08, 1], bone: 'head', color: C.skinTan, rough: 0.7 });
    kit.add(SPH(0.03, 8, 6), { at: [0, 1.56, -0.83], bone: 'head', color: '#b9765a', rough: 0.7 }); // nose
    for (const x of [0.038, -0.038]) kit.add(SPH(0.013, 8, 6), { at: [x, 1.6, -0.835], bone: 'head', color: '#20160f', rough: 0.3 });
    kit.add(CYL(0.27, 0.27, 0.025, 26), { at: [0, 1.665, -0.93], bone: 'head', color: C.straw, rough: 0.95, faceFn: (c) => (Math.sin(Math.hypot(c.x, c.z + 0.93) * 90) > 0.6 ? { color: '#c4a85e' } : null) });
    kit.add(CYL(0.12, 0.125, 0.12, 18), { at: [0, 1.73, -0.93], bone: 'head', color: C.straw, rough: 0.95 });
    kit.add(CYL(0.128, 0.128, 0.04, 18), { at: [0, 1.69, -0.93], bone: 'head', color: '#2f5a2a', rough: 0.7 });
    // Wheelbarrow: player-colour tub full of soil and flowers, wooden handles, legs, front wheel.
    const tub = CYL(0.5, 0.32, 0.36, 4, true);
    tub.rotateY(Math.PI / 4);
    deform(tub, (v) => { v.x *= 1.0; v.z *= 1.35; if (v.z > 0) v.z += 0.12 * (v.y + 0.18) / 0.36; });
    kit.add(tub, { at: [0, 0.6, 0.35], bone: 'barrow', ...PAINT, smooth: 25 });
    const floor = BOX(0.42, 0.03, 0.56);
    kit.add(floor, { at: [0, 0.43, 0.35], bone: 'barrow', ...PAINT });
    kit.add(BOX(0.66, 0.04, 0.9), { at: [0, 0.74, 0.38], bone: 'barrow', color: '#4a3524', rough: 1 }); // soil
    const rim = TOR(0.5, 0.025, 4, 4);
    rim.rotateX(HALF_PI);
    rim.rotateY(Math.PI / 4);
    deform(rim, (v) => { v.z *= 1.35; if (v.z > 0) v.z += 0.12; });
    kit.add(rim, { at: [0, 0.78, 0.35], bone: 'barrow', ...PAINT });
    for (const s of [1, -1]) {
      kit.rod([0.13 * s, 0.24, 0.95], [0.3 * s, 0.5, -0.78], 0.025, { bone: 'barrow', color: '#8a5a32', rough: 0.8 });
      kit.add(CAP(0.03, 0.12, 2, 8), { at: [0.3 * s, 0.5, -0.72], rot: [HALF_PI + 0.15, 0, 0], bone: 'barrow', color: C.rubber });
      kit.rod([0.2 * s, 0.42, -0.1], [0.22 * s, 0.0, -0.16], 0.02, { bone: 'barrow', color: '#3b3b3b', metal: 0.6, rough: 0.4 });
      kit.rod([0.05 * s, 0.2, 1.0], [0.16 * s, 0.38, 0.75], 0.016, { bone: 'barrow', color: '#3b3b3b', metal: 0.6, rough: 0.4 });
    }
    wheel(kit, 'bwheel', [0, 0.2, 1.0], { r: 0.2, width: 0.08, spokes: 4, rim: '#c03a2b', hub: '#c03a2b', tube: 0.05 });
    // Flowers: player-colour blooms (some lighter), white daisies, leaves.
    const rnd = mulberry(7);
    for (let k = 0; k < 16; k++) {
      const x = (rnd() - 0.5) * 0.5;
      const z = 0.02 + rnd() * 0.66;
      const y = 0.8 + rnd() * 0.16;
      kit.add(CONE(0.05, 0.13, 5), { at: [x * 1.05, y - 0.04, z], rot: [rnd() - 0.5, rnd() * 3, rnd() - 0.5], bone: 'flowers', color: '#3f7a35', rough: 0.9 });
      const kind = k % 4;
      kit.add(new THREE.IcosahedronGeometry(0.055, 0), { at: [x, y + 0.03, z], scale: [1, 0.7, 1], bone: 'flowers', ...(kind === 3 ? { color: C.white } : kind === 2 ? { color: '#ffffff', tint: 0.6 } : { tint: 1 }), rough: 0.7 });
      kit.add(SPH(0.018, 6, 4), { at: [x, y + 0.065, z], bone: 'flowers', color: '#f2c230', rough: 0.7 });
    }
  },

  /** The pawn: a pedestrian in a player-colour jacket. */
  pawn(kit) {
    kit.bone('base', null, [0, 0, 0]);
    bipedBones(kit, 'base', { hip: [0, 0.93, 0], shoulder: [0.21, 1.44, 0], neck: [0, 1.52, 0.01], leg: [0.44, 0.45], arm: [0.3, 0.3] });
    bipedLimbs(kit, { hip: [0.1, 0.93, 0], shoulder: [0.21, 1.44, 0], leg: [0.44, 0.45], arm: [0.3, 0.3], trousers: '#4a4f5a', sleeve: '#000000', sleeveTint: 1, shoe: '#1e1e1e' });
    kit.add(RBOX(0.34, 0.2, 0.24, 0.08, 2), { at: [0, 0.95, 0], bone: 'pelvis', color: '#4a4f5a', rough: 0.85 });
    kit.add(CAP(0.17, 0.26, 3, 12), { at: [0, 1.22, 0], scale: [1.1, 1, 0.75], bone: 'torso', tint: 1, rough: 0.6 });
    kit.add(BOX(0.03, 0.4, 0.02), { at: [0, 1.2, 0.13], bone: 'torso', color: '#000000', tint: 0.6, rough: 0.6 }); // zip
    kit.add(CYL(0.05, 0.055, 0.08, 10), { at: [0, 1.48, 0.01], bone: 'torso', color: C.skin, rough: 0.7 });
    kit.add(SPH(0.105, 16, 12), { at: [0, 1.62, 0.01], scale: [1, 1.08, 1], bone: 'head', color: C.skin, rough: 0.7 });
    kit.add(SPH(0.11, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), { at: [0, 1.635, -0.005], bone: 'head', color: C.hair, rough: 0.9 });
    for (const x of [0.038, -0.038]) kit.add(SPH(0.013, 8, 6), { at: [x, 1.64, 0.105], bone: 'head', color: '#20160f', rough: 0.3 });
  },
};
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- geometry cache + material -------------------------------------------------------------------

const GEO_CACHE = new Map();

/** Builds (once per token id) the merged skinned geometry and the bone spec. */
export function characterGeometry(tokenId) {
  const id = knownToken(tokenId);
  let rec = GEO_CACHE.get(id);
  if (rec) return rec;
  const kit = new CharKit();
  BUILDERS[id](kit);
  rec = kit.build();
  rec.tokenId = id;
  // Vehicles are scaled uniformly so their bumper-to-bumper length is exactly the specified one (slots pack
  // by it); walkers keep their true size × hero scale.
  const bb = rec.geometry.boundingBox;
  const info = infoOf(id);
  rec.fit = info.kind === 'vehicle' ? Math.min(1.05, Math.max(0.85, info.length / (bb.max.z - bb.min.z))) : 1;
  rec.users = 0;
  GEO_CACHE.set(id, rec);
  return rec;
}

/** Drops cached geometries no live character uses (dispose path). */
export function releaseGeometry(tokenId) {
  const rec = GEO_CACHE.get(knownToken(tokenId));
  if (!rec) return;
  rec.users = Math.max(0, rec.users - 1);
  if (rec.users === 0) {
    rec.geometry.dispose();
    GEO_CACHE.delete(rec.tokenId);
  }
}

const VERT_HEAD = /* glsl */ `
attribute float aTint;
attribute vec4 aFx;
uniform float uBlur;
varying float vTint;
varying vec4 vFx;
`;
const VERT_BEGIN = /* glsl */ `
#include <begin_vertex>
vTint = aTint;
vFx = aFx;
if ((aFx.y > 0.5 && uBlur < 0.5) || (aFx.y < -0.5 && uBlur > 0.5)) transformed = vec3(0.0);
`;
const FRAG_HEAD = /* glsl */ `
uniform vec3 uPlayer;
uniform float uLights;
uniform vec2 uFlash;
varying float vTint;
varying vec4 vFx;
`;
const FRAG_COLOR = /* glsl */ `
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
  diffuseColor.rgb *= mix( vColor.rgb, uPlayer, vTint );
#endif
`;
const FRAG_ROUGH = /* glsl */ `
#include <roughnessmap_fragment>
if ( vFx.w > 0.0 ) roughnessFactor = vFx.w;
`;
const FRAG_METAL = /* glsl */ `
#include <metalnessmap_fragment>
metalnessFactor = vFx.z;
`;
const FRAG_EMIT = /* glsl */ `
#include <emissivemap_fragment>
{
  #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
  vec3 glowBase = mix( vColor.rgb, uPlayer, vTint );
  #else
  vec3 glowBase = mix( vec3( 1.0 ), uPlayer, vTint );
  #endif
  float g = vFx.x;
  if ( g > 0.5 && g < 1.5 ) totalEmissiveRadiance += glowBase * ( 0.15 + 2.6 * uLights );
  else if ( g > 1.5 && g < 2.5 ) totalEmissiveRadiance += glowBase * 4.0 * uFlash.x;
  else if ( g > 2.5 && g < 3.5 ) totalEmissiveRadiance += glowBase * 4.0 * uFlash.y;
  else if ( g > 3.5 ) totalEmissiveRadiance += glowBase * 1.4;
}
`;

function patchCharacterShader(shader) {
  const u = this.userData;
  shader.uniforms.uPlayer = u.uPlayer;
  shader.uniforms.uBlur = u.uBlur;
  shader.uniforms.uFlash = u.uFlash;
  shader.uniforms.uLights = u.uLights;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${VERT_HEAD}`)
    .replace('#include <begin_vertex>', VERT_BEGIN);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
    .replace('#include <color_fragment>', FRAG_COLOR)
    .replace('#include <roughnessmap_fragment>', FRAG_ROUGH)
    .replace('#include <metalnessmap_fragment>', FRAG_METAL)
    .replace('#include <emissivemap_fragment>', FRAG_EMIT);
}
const programKey = () => 'city-character-v2';

/**
 * The character material: vertex colours, the player colour on aTint, per-vertex PBR, lamps / beacons.
 * lights: a shared { value } uniform (bus.uniforms.uLights) for headlights at dusk.
 */
export function createCharacterMaterial(color = '#888888', { lights = null } = {}) {
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.6, metalness: 0, envMapIntensity: 1 });
  m.name = 'city-character';
  m.userData.uPlayer = { value: new THREE.Color(color) };
  m.userData.uBlur = { value: 0 };
  m.userData.uFlash = { value: new THREE.Vector2(0, 0) };
  m.userData.uLights = lights ?? { value: 0 };
  m.onBeforeCompile = patchCharacterShader;
  m.customProgramCacheKey = programKey;
  return m;
}

/** Changes a character material's player colour. */
export function setCharacterColor(material, color) {
  material?.userData?.uPlayer?.value?.set(color);
}

/**
 * One character: { root (Group, world position / heading), model (Group, hero scale), mesh (SkinnedMesh),
 * bones: { name → Bone }, rest: { name → Vector3 (rest local position) }, info, rig, material, triangles }.
 */
export function buildCharacter(tokenId, { color = '#888888', lights = null, castShadow = true } = {}) {
  const id = knownToken(tokenId);
  const rec = characterGeometry(id);
  rec.users++;
  const material = createCharacterMaterial(color, { lights });
  const mesh = new THREE.SkinnedMesh(rec.geometry, material);
  mesh.name = `character-${id}`;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  const bones = {};
  const rest = {};
  const list = rec.bones.map((b) => {
    const bone = new THREE.Bone();
    bone.name = b.name;
    bones[b.name] = bone;
    return bone;
  });
  rec.bones.forEach((b, i) => {
    const parent = b.parent >= 0 ? rec.bones[b.parent].pos : [0, 0, 0];
    list[i].position.set(b.pos[0] - parent[0], b.pos[1] - parent[1], b.pos[2] - parent[2]);
    rest[b.name] = list[i].position.clone();
    if (b.parent >= 0) list[b.parent].add(list[i]);
    else mesh.add(list[i]);
  });
  mesh.bind(new THREE.Skeleton(list));
  const info = infoOf(id);
  // Generous fixed bounds (the parts animate within them): no per-vertex skinned bounds computation.
  const bs = rec.geometry.boundingSphere;
  mesh.boundingSphere = new THREE.Sphere(bs.center.clone(), bs.radius * 1.15 + 0.6);
  mesh.boundingBox = rec.geometry.boundingBox.clone().expandByScalar(0.6);
  const model = new THREE.Group();
  model.name = `model-${id}`;
  const scale = info.heroScale * rec.fit; // model space → world metres
  model.scale.setScalar(scale);
  model.add(mesh);
  const root = new THREE.Group();
  root.name = `char-${id}`;
  root.add(model);
  return { tokenId: id, root, model, mesh, bones, rest, info, rig: RIGS[id] ?? null, material, scale, triangles: rec.triangles, boneCount: list.length };
}

/** Disposes one built character (its material; the shared geometry when unused). */
export function disposeCharacter(c) {
  if (!c) return;
  c.root.parent?.remove(c.root);
  c.mesh.skeleton?.dispose?.();
  c.material.dispose();
  releaseGeometry(c.tokenId);
}

export { CharKit, wheel as buildWheel, driver as buildDriver, cylX, profileX, deform, TOR, RBOX, CYL, SPH, BOX, CAP, CONE, C as COLORS, CHROME, GLASS, TYRE, PAINT };
