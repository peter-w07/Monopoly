// public/r3d/token-models.js — the eight classic tokens, built procedurally (no model files).
//
// Each token is ONE mesh (one draw call): a polished-silver figure on a round plinth whose enamel
// band is the player's colour. Parts come from lathes, extruded side profiles (bevelled, with
// creased normals so curves shade smoothly and hard edges stay crisp) and primitives, and are
// merged into one geometry with three extra per-vertex channels:
//   uv.x   material region (METAL, ENAMEL, DARK, …): an 8×1 colour texture per token + two shared
//          8×1 lookups for roughness / metalness and the emissive mask, so one material shows
//          silver, enamel, rubber and glass at once;
//   rig    vec4(pivot.xyz, kind): parts that move on their own (car / barrow wheels, dog / cat
//          tails, ship turrets) are rotated in the vertex shader by the material's `rig` uniform,
//          so wheels spin and tails wag without extra draw calls;
//   DIMPLED region: the thimble's dimples are a procedural bump in the fragment shader.
//
// Models stand on y = 0, face +X (their direction of travel) and are ~0.3–0.45 units across
// (tokens.js scales them ×1.5). Every model stays under ~3k triangles.
//
// Also exports the generic helpers board.js / city.js / fx.js use: mergeParts (legacy, position +
// normal) and PartKit (regions, rig, vertex colours).

import * as THREE from './three.js';

// ---- materials: regions, rig ------------------------------------------------------------------

/** Material regions (uv.x picks one): colour / roughness / metalness / emissive mask. */
export const REGION = { METAL: 0, ENAMEL: 1, DARK: 2, GLASS: 3, BRUSHED: 4, GOLD: 5, DIMPLED: 6, SATIN: 7 };
const REGIONS = 8;
//                 colour (null = player colour)  roughness metalness glow
const REGION_TABLE = [
  ['#eef0f3', 0.16, 1.0, 0.07], // METAL    polished silver
  [null, 0.22, 0.0, 1.0], //       ENAMEL   the player's colour
  ['#1d1e22', 0.62, 0.15, 0.0], // DARK     tyres, eyes, nose
  ['#a9c7df', 0.06, 0.85, 0.05], // GLASS   windscreen, lamps
  ['#c2c7ce', 0.36, 1.0, 0.05], // BRUSHED  bands, spokes, soles
  ['#e2b958', 0.24, 1.0, 0.08], // GOLD     small accents
  ['#eceef2', 0.2, 1.0, 0.07], //  DIMPLED  thimble body (bumped in the shader)
  ['#d5d9df', 0.28, 1.0, 0.06], // SATIN    large secondary surfaces
];
const regionU = (r) => (r + 0.5) / REGIONS;

/** Rig kinds (rig.w): which uniform rotates the part, and about which model axis. */
export const RIG = { NONE: 0, WHEEL: 1, WAG: 2, TILT: 3 }; // WHEEL: about Z (rig.x) · WAG: about Y (rig.y) · TILT: about X (rig.z)

// Thimble dimple pattern (object units, before the ×1.5 token scale). Only the DIMPLED region uses it.
const DIMPLE = { y0: 0.1, y1: 0.29, row: 0.026, n: 18, r: 0.0105, top: 0.024, depth: 0.0032 };

let SHARED = null;
function shared() {
  if (SHARED) return SHARED;
  const pbr = new Uint8Array(REGIONS * 4);
  const glow = new Uint8Array(REGIONS * 4);
  REGION_TABLE.forEach(([, rough, metal, g], k) => {
    pbr.set([255, Math.round(rough * 255), Math.round(metal * 255), 255], k * 4);
    const v = Math.round(g * 255);
    glow.set([v, v, v, 255], k * 4);
  });
  SHARED = { pbr: lookupTexture(pbr, false), glow: lookupTexture(glow, false) };
  return SHARED;
}

function lookupTexture(data, srgb) {
  const tex = new THREE.DataTexture(data, REGIONS, 1, THREE.RGBAFormat);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const tmpColor = new THREE.Color();
/** Writes the region colours (sRGB bytes) into an 8×1 RGBA texture buffer. */
function writeRegionColours(data, playerColor) {
  REGION_TABLE.forEach(([hex], k) => {
    const c = tmpColor.set(hex ?? playerColor ?? '#888888').getHex(); // sRGB
    data[k * 4] = (c >> 16) & 255;
    data[k * 4 + 1] = (c >> 8) & 255;
    data[k * 4 + 2] = c & 255;
    data[k * 4 + 3] = 255;
  });
}

/**
 * The token material: silver + enamel regions, per-part rig and thimble dimples. One per token
 * (it holds the player colour and the rig angles); all tokens share one shader program.
 * @param {THREE.ColorRepresentation} color player colour (enamel + glow)
 * @param {{envMap?: THREE.Texture|null, envMapIntensity?: number}} [opts]
 */
export function createTokenMaterial(color, { envMap = null, envMapIntensity = 1.25 } = {}) {
  const { pbr, glow } = shared();
  const data = new Uint8Array(REGIONS * 4);
  writeRegionColours(data, color);
  const map = lookupTexture(data, true);
  const m = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    map,
    roughness: 1,
    metalness: 1,
    roughnessMap: pbr,
    metalnessMap: pbr,
    emissive: new THREE.Color(color),
    emissiveMap: glow,
    emissiveIntensity: 0.12,
  });
  if (envMap) {
    m.envMap = envMap; // explicit: scene.environment would force the scene-wide (dimmer) intensity
    m.envMapIntensity = envMapIntensity;
  }
  m.name = 'token';
  m.userData.rig = { value: new THREE.Vector3() }; // (wheel angle, wag angle, tilt angle) radians
  m.userData.regionData = data;
  m.onBeforeCompile = patchTokenShader;
  m.customProgramCacheKey = tokenProgramKey;
  return m;
}

/**
 * Keeps a mesh's material on the scene's environment map at `gain` × scene.environmentIntensity,
 * so metal reads brighter than the scene default yet still follows the time of day (the world
 * dims the environment at dusk). Cheap: one comparison and one assignment per draw.
 */
export function trackEnvironment(mesh, gain = 2.2) {
  mesh.onBeforeRender = (renderer, scene) => {
    const m = mesh.material;
    if (!m || m.envMap === undefined) return;
    const env = scene.environment ?? null;
    if (m.envMap !== env) {
      m.envMap = env;
      m.needsUpdate = true;
    }
    m.envMapIntensity = (scene.environmentIntensity ?? 1) * gain;
  };
  return mesh;
}

/** Changes a token material's player colour (enamel + glow). */
export function setTokenColor(material, color) {
  const data = material.userData.regionData;
  if (!data || !material.map) return;
  writeRegionColours(data, color);
  material.map.needsUpdate = true;
  material.emissive.set(color);
}

function tokenProgramKey() {
  return 'monopoly-token-v1';
}

const RIG_VERTEX_HEAD = /* glsl */ `
attribute vec4 rig;
uniform vec3 uRig;
varying vec3 vRigPos;
varying vec3 vNM0;
varying vec3 vNM1;
varying vec3 vNM2;
`;
const RIG_NORMAL = /* glsl */ `
#include <beginnormal_vertex>
mat3 rigR = mat3(1.0);
if (rig.w > 0.5) {
  float ra = rig.w < 1.5 ? uRig.x : (rig.w < 2.5 ? uRig.y : uRig.z);
  float rc = cos(ra);
  float rs = sin(ra);
  if (rig.w < 1.5) rigR = mat3(rc, rs, 0.0, -rs, rc, 0.0, 0.0, 0.0, 1.0);
  else if (rig.w < 2.5) rigR = mat3(rc, 0.0, -rs, 0.0, 1.0, 0.0, rs, 0.0, rc);
  else rigR = mat3(1.0, 0.0, 0.0, 0.0, rc, rs, 0.0, -rs, rc);
  objectNormal = rigR * objectNormal;
}
`;
const RIG_POSITION = /* glsl */ `
#include <begin_vertex>
if (rig.w > 0.5) transformed = rigR * (transformed - rig.xyz) + rig.xyz;
vRigPos = transformed;
vNM0 = normalMatrix[0];
vNM1 = normalMatrix[1];
vNM2 = normalMatrix[2];
`;
const f = (v) => v.toFixed(5);
// Dimples: h = -depth·s², s = 1 - d²/r² inside each dimple. The fragment shader uses the analytic
// object-space gradient of h (a covector, so it goes to view space with the normal matrix) and
// fades the bumps out once a dimple gets smaller than a few pixels (no shimmering at distance).
const DIMPLE_FRAGMENT_HEAD = /* glsl */ `
varying vec3 vRigPos;
varying vec3 vNM0;
varying vec3 vNM1;
varying vec3 vNM2;
vec3 tokenDimpleGrad(vec3 p) {
  vec3 g = vec3(0.0);
  float k = ${f((4 * DIMPLE.depth) / DIMPLE.r ** 2)};
  float rr = ${f(DIMPLE.r * DIMPLE.r)};
  float r = max(length(p.xz), 1e-4);
  float row = (p.y - ${f(DIMPLE.y0)}) / ${f(DIMPLE.row)};
  float dy = (fract(row) - 0.5) * ${f(DIMPLE.row)};
  float ang = atan(p.z, p.x) * ${f(DIMPLE.n / (Math.PI * 2))} + 0.5 * mod(floor(row), 2.0);
  float dx = (fract(ang) - 0.5) * r * ${f((Math.PI * 2) / DIMPLE.n)};
  float s = 1.0 - (dx * dx + dy * dy) / rr;
  if (s > 0.0 && p.y > ${f(DIMPLE.y0)} && p.y < ${f(DIMPLE.y1)}) g += k * s * (dx * vec3(-p.z, 0.0, p.x) / r + vec3(0.0, dy, 0.0));
  vec2 o = (p.xz / ${f(DIMPLE.top)} - floor(p.xz / ${f(DIMPLE.top)} + 0.5)) * ${f(DIMPLE.top)};
  float s2 = 1.0 - dot(o, o) / rr;
  if (s2 > 0.0 && p.y > ${f(DIMPLE.y1 + 0.004)}) g += k * s2 * vec3(o.x, 0.0, o.y);
  return g;
}
`;
const DIMPLE_FRAGMENT = /* glsl */ `
#include <normal_fragment_maps>
{
  float dimpleFade = 1.0 - smoothstep(${f(DIMPLE.r * 0.3)}, ${f(DIMPLE.r * 0.8)}, length(fwidth(vRigPos)));
  float isDimpled = 1.0 - step(0.5, abs(vMapUv.x * ${f(REGIONS)} - ${f(REGION.DIMPLED + 0.5)}));
  if (isDimpled * dimpleFade > 0.0) {
    vec3 gv = mat3(vNM0, vNM1, vNM2) * tokenDimpleGrad(vRigPos) * dimpleFade;
    normal = normalize(normal - (gv - dot(gv, normal) * normal));
  }
}
`;

/** onBeforeCompile for every token material (one shared function → one shared program). */
function patchTokenShader(shader) {
  shader.uniforms.uRig = this.userData.rig;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${RIG_VERTEX_HEAD}`)
    .replace('#include <beginnormal_vertex>', RIG_NORMAL)
    .replace('#include <begin_vertex>', RIG_POSITION);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${DIMPLE_FRAGMENT_HEAD}`)
    .replace('#include <normal_fragment_maps>', DIMPLE_FRAGMENT);
}

// ---- building blocks ----------------------------------------------------------------------------

/**
 * Collects transformed parts and merges them into one non-indexed geometry.
 *   add(geo, { at, rot, scale, region, rig, pivot, color, smooth })
 *     at / rot / scale  placement ([x,y,z]; rot is an XYZ Euler; scale a number or [x,y,z])
 *     region            REGION.* (→ uv.x)       rig / pivot  RIG.* and its pivot (model space)
 *     color             vertex colour (for build({ color: true }))
 *     smooth            recompute creased normals after placement (degrees; 0 = keep the normals)
 *   build({ uv, rig, color }) → BufferGeometry (position + normal [+ uv] [+ rig] [+ color])
 */
export class PartKit {
  constructor() {
    this.parts = [];
  }

  add(geo, { at = null, rot = null, scale = null, region = REGION.METAL, rig = RIG.NONE, pivot = null, color = null, smooth = 0 } = {}) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    if (!g.attributes.normal) g.computeVertexNormals();
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...(at ?? [0, 0, 0])),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...(rot ?? [0, 0, 0]))),
      Array.isArray(scale) ? new THREE.Vector3(...scale) : new THREE.Vector3(scale ?? 1, scale ?? 1, scale ?? 1),
    );
    g.applyMatrix4(m);
    if (smooth) creaseNormals(g, smooth);
    this.parts.push({ geo: g, region, rig, pivot: pivot ?? [0, 0, 0], color: color ? new THREE.Color(color) : null });
    return g;
  }

  /** Mirrors the last `n` parts across z = 0 (left / right pairs). */
  mirrorZ(n = 1) {
    const src = this.parts.slice(-n);
    for (const p of src) {
      const g = p.geo.clone();
      g.scale(1, 1, -1);
      flipWinding(g);
      this.parts.push({ ...p, geo: g, pivot: [p.pivot[0], p.pivot[1], -p.pivot[2]] });
    }
  }

  get triangles() {
    return this.parts.reduce((s, p) => s + p.geo.attributes.position.count / 3, 0);
  }

  build({ uv = true, rig = true, color = false } = {}) {
    const count = this.parts.reduce((s, p) => s + p.geo.attributes.position.count, 0);
    const pos = new Float32Array(count * 3);
    const nor = new Float32Array(count * 3);
    const uvs = uv ? new Float32Array(count * 2) : null;
    const rigs = rig ? new Float32Array(count * 4) : null;
    const cols = color ? new Float32Array(count * 3) : null;
    let at = 0;
    for (const p of this.parts) {
      const a = p.geo.attributes;
      const n = a.position.count;
      pos.set(a.position.array, at * 3);
      nor.set(a.normal.array, at * 3);
      const u = regionU(p.region);
      for (let k = 0; k < n; k++) {
        const i = at + k;
        if (uvs) { uvs[i * 2] = u; uvs[i * 2 + 1] = 0.5; }
        if (rigs) { rigs[i * 4] = p.pivot[0]; rigs[i * 4 + 1] = p.pivot[1]; rigs[i * 4 + 2] = p.pivot[2]; rigs[i * 4 + 3] = p.rig; }
        if (cols) { const c = p.color ?? WHITE; cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b; }
      }
      at += n;
      p.geo.dispose();
    }
    this.parts = [];
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    if (uvs) out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    if (rigs) out.setAttribute('rig', new THREE.BufferAttribute(rigs, 4));
    if (cols) out.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    out.computeBoundingSphere();
    out.computeBoundingBox();
    return out;
  }
}
const WHITE = new THREE.Color(1, 1, 1);

/** Reverses triangle winding (and normals) of a non-indexed geometry (after a mirror). */
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
    a.needsUpdate = true;
  }
}

/**
 * Smooth normals across faces that meet at less than `angle` degrees, hard edges elsewhere
 * (like three's toCreasedNormals). `g` must be non-indexed.
 */
export function creaseNormals(g, angle = 40) {
  const p = g.attributes.position.array;
  const nv = p.length / 3;
  const nt = nv / 3;
  const fa = new Float32Array(nt * 3); // area-weighted face normals
  const fu = new Float32Array(nt * 3); // unit face normals
  for (let t = 0; t < nt; t++) {
    const a = t * 9;
    const ux = p[a + 3] - p[a], uy = p[a + 4] - p[a + 1], uz = p[a + 5] - p[a + 2];
    const vx = p[a + 6] - p[a], vy = p[a + 7] - p[a + 1], vz = p[a + 8] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    fa[t * 3] = nx; fa[t * 3 + 1] = ny; fa[t * 3 + 2] = nz;
    if (len > 0) { fu[t * 3] = nx / len; fu[t * 3 + 1] = ny / len; fu[t * 3 + 2] = nz / len; }
  }
  const key = (v) => `${Math.round(p[v * 3] * 1e5)},${Math.round(p[v * 3 + 1] * 1e5)},${Math.round(p[v * 3 + 2] * 1e5)}`;
  const groups = new Map();
  for (let v = 0; v < nv; v++) {
    const k = key(v);
    const list = groups.get(k);
    if (list) list.push(v);
    else groups.set(k, [v]);
  }
  const cos = Math.cos((angle * Math.PI) / 180);
  const out = new Float32Array(nv * 3);
  for (let v = 0; v < nv; v++) {
    const t = Math.floor(v / 3);
    let sx = 0, sy = 0, sz = 0;
    for (const u of groups.get(key(v))) {
      const tu = Math.floor(u / 3);
      if (fu[t * 3] * fu[tu * 3] + fu[t * 3 + 1] * fu[tu * 3 + 1] + fu[t * 3 + 2] * fu[tu * 3 + 2] < cos) continue;
      sx += fa[tu * 3]; sy += fa[tu * 3 + 1]; sz += fa[tu * 3 + 2];
    }
    const len = Math.hypot(sx, sy, sz);
    if (len > 0) { out[v * 3] = sx / len; out[v * 3 + 1] = sy / len; out[v * 3 + 2] = sz / len; }
    else { out[v * 3] = fu[t * 3]; out[v * 3 + 1] = fu[t * 3 + 1] || 1; out[v * 3 + 2] = fu[t * 3 + 2]; }
  }
  g.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  return g;
}

/** Moves every vertex through fn(v: Vector3) (in place), then recomputes normals. */
function deform(geo, fn) {
  const a = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < a.count; i++) {
    v.fromBufferAttribute(a, i);
    fn(v);
    a.setXYZ(i, v.x, v.y, v.z);
  }
  a.needsUpdate = true;
  if (geo.index) geo.computeVertexNormals();
  return geo;
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Lathe from [[r, y], …] listed bottom-up (outside first): normals point outward. */
const lathe = (pts, segs = 32) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), segs);

/**
 * Shape from commands: ['m', x, y] · ['l', x, y] · ['q', cx, cy, x, y] · ['c', c1x, c1y, c2x, c2y, x, y].
 */
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

/** A side profile (XY) extruded symmetrically along Z with a rounded bevel. Non-indexed. */
function slab(cmds, depth, { bevel = 0.018, seg = 3, curve = 6 } = {}) {
  const geo = new THREE.ExtrudeGeometry(shape(cmds), {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.9,
    bevelSegments: seg,
    curveSegments: curve,
  });
  geo.translate(0, 0, -depth / 2);
  return geo;
}

const CYL = (rt, rb, h, s = 12, open = false) => new THREE.CylinderGeometry(rt, rb, h, s, 1, open);
const SPH = (r, ws = 12, hs = 8) => new THREE.SphereGeometry(r, ws, hs);
const BOX = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const RBOX = (w, h, d, r = 0.008) => new THREE.RoundedBoxGeometry(w, h, d, 1, r);
const TORUS = (R, r, rs = 6, ts = 16, arc = Math.PI * 2) => new THREE.TorusGeometry(R, r, rs, ts, arc);
const HALF_PI = Math.PI / 2;

/** A cylinder from point a to point b (thin rods: rails, handles, laces). */
function rod(kit, a, b, r, opts = {}) {
  const A = new THREE.Vector3(...a);
  const B = new THREE.Vector3(...b);
  const len = A.distanceTo(B);
  const geo = CYL(r, r, len, opts.segs ?? 6, opts.open ?? true);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  geo.applyQuaternion(q);
  geo.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
  return kit.add(geo, opts);
}

// ---- the tokens ---------------------------------------------------------------------------------

export const BASE_R = 0.15; // plinth radius (×1.5 on the board ≈ the old colour disc)
export const BASE_TOP = 0.033; // figures stand on this
const B = BASE_TOP;

/** Plinth: silver with an enamel band round its side and an enamel ring on top. */
function base(kit) {
  const S = 28;
  kit.add(lathe([[0, 0], [0.144, 0], [0.15, 0.005]], S), { region: REGION.METAL });
  kit.add(lathe([[0.15, 0.005], [0.151, 0.013], [0.15, 0.021]], S), { region: REGION.ENAMEL });
  kit.add(lathe([[0.15, 0.021], [0.147, 0.027], [0.141, 0.029]], S), { region: REGION.METAL });
  kit.add(lathe([[0.141, 0.029], [0.103, 0.029]], S), { region: REGION.ENAMEL });
  kit.add(lathe([[0.103, 0.029], [0.1, 0.032], [0, B]], S), { region: REGION.METAL });
}

/** A spoked wheel with a rubber tyre, axis along Z, rigged to spin about its centre. */
function wheel(kit, x, y, z, R, { tyre = 0.013, spokes = 3 } = {}) {
  const rig = { rig: RIG.WHEEL, pivot: [x, y, z] };
  kit.add(TORUS(R - tyre, tyre, 6, 12), { at: [x, y, z], region: REGION.DARK, ...rig });
  kit.add(CYL(R * 0.34, R * 0.34, 0.026, 8), { at: [x, y, z], rot: [HALF_PI, 0, 0], region: REGION.METAL, ...rig });
  kit.add(CYL(R * 0.16, R * 0.2, 0.012, 8), { at: [x, y, z + Math.sign(z || 1) * 0.017], rot: [HALF_PI, 0, 0], region: REGION.GOLD, ...rig });
  for (let k = 0; k < spokes; k++) {
    kit.add(BOX((R - tyre) * 2, 0.005, 0.005), { at: [x, y, z], rot: [0, 0, (k * Math.PI) / spokes], region: REGION.BRUSHED, ...rig });
  }
}

/** Wheel radius and rig pivots per model (tokens.js spins the wheels by distance travelled). */
export const MODEL_INFO = {
  car: { wheelR: 0.052, height: 0.2 },
  hat: { height: 0.34 },
  ship: { height: 0.26 },
  boot: { height: 0.35 },
  dog: { height: 0.33 },
  cat: { height: 0.36 },
  thimble: { height: 0.34 },
  wheelbarrow: { wheelR: 0.055, height: 0.25 },
  pawn: { height: 0.42 },
};

const BUILDERS = {
  /** 1930s roadster: long bonnet, boat tail, cycle wings, spoked wheels, windscreen, spare. */
  car(kit) {
    const body = slab([
      ['m', 0.195, 0.078], ['l', -0.165, 0.078],
      ['q', -0.228, 0.078, -0.228, 0.118], ['q', -0.226, 0.162, -0.17, 0.166],
      ['l', -0.136, 0.168], ['q', -0.118, 0.17, -0.112, 0.148],
      ['l', -0.02, 0.146], ['q', -0.008, 0.16, 0.012, 0.16],
      ['l', 0.176, 0.155], ['q', 0.205, 0.154, 0.205, 0.128],
      ['l', 0.205, 0.095], ['q', 0.205, 0.078, 0.195, 0.078],
    ], 0.08, { bevel: 0.018, seg: 3, curve: 5 });
    deform(body, (v) => { v.z *= 1 - 0.3 * smoothstep(0.02, 0.21, v.x); }); // the bonnet narrows to the grille
    kit.add(body, { region: REGION.METAL, smooth: 50 });
    const wy = 0.085;
    for (const x of [0.138, -0.14]) {
      for (const z of [0.086, -0.086]) {
        wheel(kit, x, wy, z, 0.052);
        kit.add(TORUS(0.059, 0.009, 4, 9, Math.PI - 0.8), { at: [x, wy, z], rot: [0, 0, 0.4], scale: [1, 1, 2.6], region: REGION.SATIN }); // cycle wing
      }
    }
    for (const z of [0.083, -0.083]) kit.add(BOX(0.16, 0.007, 0.034), { at: [0, 0.101, z], region: REGION.BRUSHED }); // running boards
    // Windscreen (glass in a thin frame), seat, steering wheel.
    kit.add(BOX(0.004, 0.046, 0.088), { at: [0.004, 0.19, 0], rot: [0, 0, 0.32], region: REGION.GLASS });
    rod(kit, [-0.004, 0.213, -0.046], [-0.004, 0.213, 0.046], 0.004, { region: REGION.BRUSHED });
    kit.add(RBOX(0.04, 0.032, 0.09, 0.01), { at: [-0.088, 0.158, 0], region: REGION.DARK });
    kit.add(TORUS(0.021, 0.0035, 4, 12), { at: [-0.03, 0.182, 0.022], rot: [0, HALF_PI, 0.5], region: REGION.DARK });
    // Grille, radiator cap, headlamps on a bar, spare wheel on the tail.
    kit.add(BOX(0.006, 0.056, 0.064), { at: [0.225, 0.12, 0], region: REGION.BRUSHED });
    kit.add(CYL(0.008, 0.009, 0.012, 8), { at: [0.205, 0.178, 0], region: REGION.GOLD });
    rod(kit, [0.228, 0.135, -0.058], [0.228, 0.135, 0.058], 0.004, { region: REGION.BRUSHED });
    for (const z of [0.058, -0.058]) {
      kit.add(SPH(0.018, 10, 6), { at: [0.232, 0.142, z], scale: [0.8, 1, 1], region: REGION.METAL });
      kit.add(CYL(0.013, 0.013, 0.004, 10), { at: [0.246, 0.142, z], rot: [0, 0, HALF_PI], region: REGION.GLASS });
    }
    kit.add(TORUS(0.03, 0.011, 5, 12), { at: [-0.245, 0.135, 0], rot: [0, HALF_PI, 0], region: REGION.DARK });
  },

  /** Top hat: curled brim, band with a bow, slightly flared crown. */
  hat(kit) {
    const brim = lathe([
      [0, B + 0.003], [0.182, B + 0.004], [0.194, B + 0.008], [0.197, B + 0.014], [0.191, B + 0.02],
      [0.16, B + 0.02], [0.125, B + 0.022], [0.108, B + 0.026], [0.104, B + 0.034],
    ], 40);
    deform(brim, (v) => {
      const r = Math.hypot(v.x, v.z);
      if (r < 0.11) return;
      const t = Math.min(1, (r - 0.11) / 0.087);
      const side = (v.z / r) ** 2;
      v.y += 0.05 * t ** 1.6 * side - 0.004 * t * (1 - side); // up at the sides, a dip front and back
    });
    kit.add(brim, { region: REGION.METAL });
    kit.add(lathe([[0.104, B + 0.03], [0.107, B + 0.034], [0.108, B + 0.074], [0.103, B + 0.078]], 40), { region: REGION.BRUSHED }); // band
    kit.add(lathe([
      [0.102, B + 0.078], [0.103, B + 0.14], [0.106, B + 0.22], [0.109, B + 0.284],
      [0.108, B + 0.293], [0.1, B + 0.299], [0.06, B + 0.303], [0, B + 0.305],
    ], 40), { region: REGION.METAL });
    // A bow on the band (left side).
    kit.add(SPH(0.016, 8, 6), { at: [-0.02, B + 0.055, -0.104], scale: [1.5, 0.9, 0.55], rot: [0, 0.3, 0.35], region: REGION.BRUSHED });
    kit.add(SPH(0.016, 8, 6), { at: [0.02, B + 0.055, -0.104], scale: [1.5, 0.9, 0.55], rot: [0, -0.3, -0.35], region: REGION.BRUSHED });
    kit.add(SPH(0.009, 8, 6), { at: [0, B + 0.055, -0.108], region: REGION.BRUSHED });
  },

  /** Battleship: V hull with sheer, deckhouse, bridge, raked funnel, mast, three twin turrets. */
  ship(kit) {
    const hullTop = shape([
      ['m', -0.19, -0.048], ['l', 0.06, -0.056],
      ['q', 0.16, -0.05, 0.218, 0], ['q', 0.16, 0.05, 0.06, 0.056],
      ['l', -0.19, 0.048], ['q', -0.214, 0, -0.19, -0.048],
    ]);
    const hull = new THREE.ExtrudeGeometry(hullTop, { depth: 0.06, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.007, bevelSegments: 2, curveSegments: 8 });
    hull.rotateX(-HALF_PI); // extrude upward: y ∈ [0, 0.06] (+ bevel)
    const H0 = B + 0.012;
    deform(hull, (v) => {
      const k = smoothstep(-0.008, 0.045, v.y);
      v.z *= 0.62 + 0.38 * k; // V-shaped below the waterline
      v.y += H0 + 0.022 * smoothstep(0.04, 0.22, v.x) * smoothstep(0.02, 0.06, v.y); // sheer: the bow rises
    });
    kit.add(hull, { region: REGION.METAL, smooth: 45 });
    const D = H0 + 0.068; // deck height amidships
    kit.add(RBOX(0.16, 0.034, 0.07, 0.008), { at: [-0.02, D + 0.017, 0], region: REGION.SATIN }); // deckhouse
    kit.add(RBOX(0.055, 0.05, 0.052, 0.008), { at: [0.035, D + 0.058, 0], region: REGION.METAL }); // bridge tower
    kit.add(BOX(0.066, 0.008, 0.066), { at: [0.035, D + 0.087, 0], region: REGION.BRUSHED });
    kit.add(BOX(0.012, 0.012, 0.05), { at: [0.063, D + 0.075, 0], region: REGION.GLASS }); // bridge windows
    kit.add(CYL(0.024, 0.028, 0.075, 12), { at: [-0.05, D + 0.07, 0], rot: [0, 0, 0.2], region: REGION.METAL }); // funnel
    kit.add(CYL(0.025, 0.025, 0.012, 12), { at: [-0.057, D + 0.104, 0], rot: [0, 0, 0.2], region: REGION.DARK });
    rod(kit, [0.035, D + 0.09, 0], [0.028, D + 0.19, 0], 0.0045, { region: REGION.BRUSHED }); // mast
    rod(kit, [0.03, D + 0.16, -0.04], [0.03, D + 0.16, 0.04], 0.003, { region: REGION.BRUSHED }); // yard
    // Turrets (rigged: they traverse slowly when idle) with twin barrels.
    const turret = (x, y, dir) => {
      const rig = { rig: RIG.WAG, pivot: [x, y, 0] };
      kit.add(RBOX(0.05, 0.022, 0.044, 0.009), { at: [x, y + 0.011, 0], region: REGION.SATIN, ...rig });
      for (const z of [0.011, -0.011]) rod(kit, [x + dir * 0.015, y + 0.012, z], [x + dir * 0.07, y + 0.014, z], 0.0045, { region: REGION.BRUSHED, open: false, ...rig });
    };
    turret(0.125, H0 + 0.074, 1);
    kit.add(CYL(0.026, 0.028, 0.02, 12), { at: [0.078, D + 0.01, 0], region: REGION.SATIN }); // barbette
    turret(0.078, D + 0.02, 1);
    turret(-0.14, D - 0.004, -1);
    for (const z of [0.05, -0.05]) kit.add(new THREE.CapsuleGeometry(0.008, 0.04, 2, 6), { at: [-0.01, D + 0.03, z], rot: [0, 0, HALF_PI], region: REGION.BRUSHED }); // lifeboats
  },

  /** High-top boot: bevelled side profile, sole and heel, criss-cross laces, pull tab. */
  boot(kit) {
    const body = slab([
      ['m', -0.1, B + 0.02], ['l', 0.13, B + 0.02],
      ['q', 0.182, B + 0.02, 0.18, B + 0.056], ['q', 0.172, B + 0.09, 0.12, B + 0.094],
      ['q', 0.06, B + 0.1, 0.034, B + 0.14], ['l', 0.036, B + 0.29], ['l', 0.046, B + 0.31],
      ['l', -0.086, B + 0.314], ['l', -0.082, B + 0.16],
      ['q', -0.09, B + 0.08, -0.1, B + 0.06], ['l', -0.1, B + 0.02],
    ], 0.07, { bevel: 0.022, seg: 3, curve: 6 });
    deform(body, (v) => {
      if (v.x > 0.06) v.z *= 1 - 0.32 * ((v.x - 0.06) / 0.14) ** 2; // rounded toe
      if (v.y > B + 0.2) v.z *= 1 - 0.1 * ((v.y - B - 0.2) / 0.12); // shaft narrows a little
    });
    kit.add(body, { region: REGION.METAL, smooth: 50 });
    kit.add(RBOX(0.17, 0.014, 0.112, 0.006), { at: [0.1, B + 0.011, 0], region: REGION.BRUSHED }); // sole
    kit.add(RBOX(0.082, 0.024, 0.108, 0.006), { at: [-0.072, B + 0.012, 0], region: REGION.BRUSHED }); // heel
    kit.add(CYL(0.047, 0.047, 0.004, 16), { at: [-0.02, B + 0.33, 0], scale: [1.25, 1, 0.66], rot: [0, 0, -0.04], region: REGION.DARK }); // the opening
    kit.add(TORUS(0.05, 0.008, 5, 18), { at: [-0.02, B + 0.33, 0], rot: [HALF_PI, 0, -0.04, 'ZYX'], scale: [1.3, 0.7, 1], region: REGION.SATIN }); // rolled top
    // Laces up the front of the shaft: eyelets and crossings.
    const lx = (y) => 0.056 + (y - B - 0.14) * 0.03;
    const rows = [0.15, 0.185, 0.22, 0.255];
    for (const r of rows) for (const z of [0.03, -0.03]) kit.add(CYL(0.006, 0.006, 0.006, 6), { at: [lx(B + r), B + r, z], rot: [0, 0, HALF_PI], region: REGION.GOLD });
    for (let k = 0; k + 1 < rows.length; k++) {
      const y0 = B + rows[k];
      const y1 = B + rows[k + 1];
      rod(kit, [lx(y0) + 0.004, y0, -0.03], [lx(y1) + 0.004, y1, 0.03], 0.0035, { region: REGION.DARK });
      rod(kit, [lx(y0) + 0.004, y0, 0.03], [lx(y1) + 0.004, y1, -0.03], 0.0035, { region: REGION.DARK });
    }
    kit.add(TORUS(0.016, 0.004, 4, 8, Math.PI), { at: [-0.108, B + 0.3, 0], rot: [0, HALF_PI, -HALF_PI], region: REGION.BRUSHED }); // pull tab
  },

  /** Scottie dog: boxy body with a hanging skirt, short legs, long bearded head, bushy brows, erect ears and tail, enamel collar. */
  dog(kit) {
    const torso = slab([
      ['m', -0.135, 0.075], ['l', 0.075, 0.07], ['q', 0.1, 0.07, 0.106, 0.09], ['l', 0.115, 0.168],
      ['l', 0.085, 0.2], ['l', -0.125, 0.2], ['q', -0.152, 0.2, -0.152, 0.172], ['l', -0.145, 0.075],
    ], 0.068, { bevel: 0.02, seg: 3, curve: 4 });
    torso.translate(0, B, 0);
    kit.add(torso, { region: REGION.METAL, smooth: 50 });
    for (const x of [0.082, -0.118]) {
      for (const z of [0.036, -0.036]) {
        kit.add(RBOX(0.044, 0.1, 0.038, 0.012), { at: [x, B + 0.05, z], region: REGION.SATIN }); // legs
        kit.add(RBOX(0.05, 0.02, 0.04, 0.008), { at: [x + 0.01, B + 0.01, z], region: REGION.METAL }); // paws
      }
    }
    const head = slab([
      ['m', 0.06, 0.17], ['l', 0.07, 0.27], ['q', 0.075, 0.3, 0.11, 0.3], ['l', 0.15, 0.3],
      ['q', 0.17, 0.3, 0.18, 0.285], ['l', 0.27, 0.27], ['q', 0.286, 0.268, 0.286, 0.25], ['l', 0.281, 0.215],
      ['q', 0.276, 0.178, 0.24, 0.174], ['l', 0.15, 0.184], ['q', 0.11, 0.17, 0.06, 0.17],
    ], 0.05, { bevel: 0.017, seg: 3, curve: 4 });
    deform(head, (v) => { v.z *= 1 - 0.3 * smoothstep(0.16, 0.28, v.x); });
    head.translate(0, B, 0);
    kit.add(head, { region: REGION.METAL, smooth: 50 });
    const ear = slab([['m', -0.026, 0], ['l', 0.026, 0], ['q', 0.014, 0.05, 0.002, 0.088], ['q', -0.014, 0.05, -0.026, 0]], 0.008, { bevel: 0.006, seg: 2, curve: 3 });
    kit.add(ear, { at: [0.1, B + 0.285, 0.03], rot: [-0.22, 0, 0.08], region: REGION.METAL, smooth: 55 });
    kit.mirrorZ(1);
    for (const z of [0.029, -0.029]) {
      kit.add(RBOX(0.036, 0.012, 0.02, 0.005), { at: [0.19, B + 0.29, z], rot: [0, 0, -0.25], region: REGION.SATIN }); // brows
      kit.add(SPH(0.0085, 8, 6), { at: [0.185, B + 0.274, z * 1.2], region: REGION.DARK }); // eyes
    }
    kit.add(SPH(0.014, 10, 6), { at: [0.293, B + 0.256, 0], scale: [0.9, 0.85, 1.15], region: REGION.DARK }); // nose
    kit.add(CYL(0.007, 0.019, 0.09, 7), { at: [-0.148, B + 0.24, 0], rot: [0, 0, 0.18], region: REGION.METAL, rig: RIG.WAG, pivot: [-0.145, B + 0.2, 0] }); // tail
    // Enamel collar round the neck (axis tilted up-forward along the neck) with a gold tag.
    kit.add(TORUS(0.064, 0.01, 6, 20), { at: [0.098, B + 0.2, 0], rot: [0, HALF_PI, 1.0, 'ZYX'], scale: [1, 0.8, 1], region: REGION.ENAMEL });
    kit.add(SPH(0.012, 8, 6), { at: [0.146, B + 0.16, 0], scale: [0.5, 1, 1], region: REGION.GOLD });
  },

  /** Sitting cat: haunches, upright chest, round head, pointed ears, tail curled round the paws, collar and bell. */
  cat(kit) {
    kit.add(SPH(0.1, 16, 10), { at: [-0.03, B + 0.085, 0], scale: [1.05, 0.88, 0.84], region: REGION.METAL }); // hindquarters
    kit.add(SPH(0.07, 14, 10), { at: [0.03, B + 0.15, 0], scale: [0.9, 1.4, 0.84], rot: [0, 0, -0.18], region: REGION.METAL }); // chest
    kit.add(SPH(0.066, 16, 12), { at: [0.05, B + 0.258, 0], scale: [1, 0.92, 1.06], region: REGION.METAL }); // head
    kit.add(SPH(0.028, 10, 6), { at: [0.104, B + 0.24, 0], scale: [0.9, 0.78, 1.3], region: REGION.SATIN }); // muzzle
    for (const z of [0.036, -0.036]) {
      kit.add(new THREE.ConeGeometry(0.026, 0.056, 4), { at: [0.045, B + 0.318, z], rot: [Math.sign(z) * 0.35, Math.PI / 4, 0], region: REGION.METAL }); // ears
      kit.add(SPH(0.009, 8, 6), { at: [0.1, B + 0.268, z * 0.8], scale: [0.6, 1.1, 1], region: REGION.DARK }); // eyes
      kit.add(new THREE.CapsuleGeometry(0.018, 0.09, 3, 8), { at: [0.075, B + 0.062, z * 0.85], rot: [0, 0, 0.08], region: REGION.SATIN }); // front legs
      kit.add(SPH(0.022, 10, 6), { at: [0.09, B + 0.013, z * 0.85], scale: [1.3, 0.6, 1], region: REGION.METAL }); // paws
      kit.add(SPH(0.056, 12, 8), { at: [-0.02, B + 0.066, z * 1.75], scale: [1.15, 0.85, 0.5], region: REGION.METAL }); // thighs
    }
    kit.add(SPH(0.008, 6, 4), { at: [0.127, B + 0.25, 0], region: REGION.DARK }); // nose
    const tail = new THREE.CatmullRomCurve3([
      [-0.115, B + 0.05, 0], [-0.13, B + 0.022, 0.06], [-0.06, B + 0.014, 0.1], [0.03, B + 0.014, 0.095], [0.1, B + 0.02, 0.07], [0.13, B + 0.05, 0.045],
    ].map((p) => new THREE.Vector3(...p)));
    kit.add(new THREE.TubeGeometry(tail, 20, 0.016, 6, false), { region: REGION.METAL, rig: RIG.WAG, pivot: [-0.115, B + 0.05, 0] });
    kit.add(TORUS(0.046, 0.008, 6, 18), { at: [0.045, B + 0.205, 0], rot: [HALF_PI, 0, -0.3, 'ZYX'], region: REGION.ENAMEL }); // collar
    kit.add(SPH(0.012, 10, 6), { at: [0.093, B + 0.182, 0], region: REGION.GOLD }); // bell
  },

  /** Thimble: rolled rim, plain band with a groove, dimpled body and dome (dimples are shader bumps). */
  thimble(kit) {
    kit.add(lathe([[0.118, B], [0.124, B + 0.004], [0.127, B + 0.012], [0.124, B + 0.021], [0.118, B + 0.026]], 40), { region: REGION.BRUSHED });
    kit.add(lathe([[0.117, B + 0.027], [0.116, B + 0.05], [0.112, B + 0.055], [0.115, B + 0.061]], 40), { region: REGION.METAL });
    kit.add(lathe([
      [0.115, B + 0.061], [0.111, B + 0.12], [0.106, B + 0.18], [0.098, B + 0.225], [0.087, B + 0.26],
      [0.07, B + 0.287], [0.047, B + 0.302], [0.022, B + 0.308], [0, B + 0.31],
    ], 40), { region: REGION.DIMPLED });
  },

  /** Wheelbarrow: open flared tray with a rolled rim, spoked front wheel, rails, handles and legs. */
  wheelbarrow(kit) {
    const trayY = B + 0.1; // tray bottom
    const outer = CYL(0.13, 0.085, 0.085, 4, true);
    outer.rotateY(Math.PI / 4);
    const flare = (v) => {
      const k = (v.y + 0.0425) / 0.085; // 0 at the bottom, 1 at the rim
      v.x *= 1.3;
      v.z *= 0.8;
      if (v.x > 0) v.x += 0.045 * k; // sloped front
    };
    deform(outer, flare);
    kit.add(outer, { at: [-0.03, trayY + 0.0425, 0], region: REGION.SATIN, smooth: 30 });
    const inner = CYL(0.124, 0.08, 0.08, 4, true);
    inner.rotateY(Math.PI / 4);
    deform(inner, flare);
    const innerG = inner.toNonIndexed();
    inner.dispose();
    flipWinding(innerG);
    const n = innerG.attributes.normal.array;
    for (let i = 0; i < n.length; i++) n[i] = -n[i];
    kit.add(innerG, { at: [-0.03, trayY + 0.047, 0], region: REGION.METAL, smooth: 30 });
    kit.add(BOX(0.11 * 1.3 + 0.02, 0.006, 0.11 * 0.8), { at: [-0.025, trayY + 0.008, 0], region: REGION.BRUSHED }); // floor
    const rim = TORUS(0.13, 0.007, 5, 4);
    rim.rotateX(HALF_PI);
    rim.rotateY(Math.PI / 4);
    deform(rim, (v) => { v.x *= 1.3; v.z *= 0.8; if (v.x > 0) v.x += 0.045; });
    kit.add(rim, { at: [-0.03, trayY + 0.085, 0], region: REGION.METAL, smooth: 40 });
    // Front wheel on a fork, rails running back into the handles, legs.
    const wx = 0.16;
    const wy = B + 0.055;
    wheel(kit, wx, wy, 0, 0.055, { spokes: 4 });
    for (const z of [0.024, -0.024]) rod(kit, [wx, wy, z], [0.08, trayY + 0.012, z * 2.2], 0.006, { region: REGION.BRUSHED });
    for (const z of [0.052, -0.052]) {
      rod(kit, [0.08, trayY + 0.012, z], [-0.235, trayY + 0.07, z * 1.45], 0.007, { region: REGION.BRUSHED });
      rod(kit, [-0.2, trayY + 0.064, z * 1.4], [-0.262, trayY + 0.075, z * 1.5], 0.011, { region: REGION.DARK, open: false }); // grips
      rod(kit, [-0.095, trayY + 0.02, z * 1.1], [-0.11, B + 0.004, z * 1.2], 0.006, { region: REGION.BRUSHED }); // legs
      kit.add(BOX(0.03, 0.006, 0.016), { at: [-0.11, B + 0.004, z * 1.2], region: REGION.BRUSHED });
    }
    rod(kit, [wx, wy, -0.03], [wx, wy, 0.03], 0.005, { region: REGION.BRUSHED, open: false }); // axle
  },

  /** Fallback for unknown token ids. */
  pawn(kit) {
    kit.add(lathe([[0, B], [0.11, B], [0.1, B + 0.04], [0.05, B + 0.08], [0.04, B + 0.22], [0.08, B + 0.25], [0.045, B + 0.28], [0.075, B + 0.34], [0.05, B + 0.4], [0, B + 0.42]], 28), { region: REGION.METAL });
  },
};

/** Geometry for a token id (with uv regions and rig), and its triangle count. */
export function buildTokenGeometry(tokenId) {
  const kit = new PartKit();
  base(kit);
  (BUILDERS[tokenId] ?? BUILDERS.pawn)(kit);
  const triangles = kit.triangles;
  const geo = kit.build({ uv: true, rig: true });
  geo.userData.triangles = triangles;
  geo.userData.tokenId = BUILDERS[tokenId] ? tokenId : 'pawn';
  return geo;
}

/**
 * The token as one mesh.
 * @param {string} tokenId  board.json token id (unknown ids get a pawn)
 * @param {THREE.Material|{color?: THREE.ColorRepresentation, envMap?: THREE.Texture}} [material]
 *        a material to use as-is (legacy: the shared metal), or options for a new token material
 * @returns {THREE.Mesh}
 */
export function buildTokenModel(tokenId, material) {
  const geo = buildTokenGeometry(tokenId);
  const mat = material?.isMaterial ? material : createTokenMaterial(material?.color ?? '#9aa39e', material ?? {});
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = `token-${tokenId}`;
  mesh.castShadow = true;
  if (!material?.isMaterial) trackEnvironment(mesh);
  return mesh;
}

/** Bakes every child mesh's transform into one non-indexed geometry (position + normal). */
export function mergeParts(group) {
  const parts = [];
  let count = 0;
  for (const m of group.children) {
    m.updateMatrix();
    const src = m.geometry;
    const geo = src.index ? src.toNonIndexed() : src.clone();
    src.dispose();
    geo.applyMatrix4(m.matrix);
    parts.push(geo);
    count += geo.attributes.position.count;
  }
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  let at = 0;
  for (const geo of parts) {
    pos.set(geo.attributes.position.array, at * 3);
    if (geo.attributes.normal) nor.set(geo.attributes.normal.array, at * 3);
    at += geo.attributes.position.count;
    geo.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.computeBoundingSphere();
  return out;
}
