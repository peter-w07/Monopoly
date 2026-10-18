// public/r3d/world-outskirts.js — everything beyond the lots (city design §3.7): the terrain (flat
// city, hills to the west / south / north, the beach and the seabed), water (sea, lake, basins), the
// covered rail tunnel under the promenade, the beach, the harbour with its piers and the breakwater
// with the lighthouse (rotating beam at night), the four arterials, the southern suburbs, allotments
// and the rail yard, the Old Town to the west, the uptown skyline to the north (instanced towers with
// an anti-aliased window shader), and two layers of hill silhouettes on the horizon.
//
// Background buildings are at ~60 % saturation so the property lots pop (§11.5). Nothing here casts
// shadows; all repeats are InstancedMesh; static pieces are merged.

import * as THREE from './three.js';
import { M } from './city-layout.js';
import { MeshBuf, facadeBox, gableRoof } from './world-build.js';
import { K } from './world-ground.js';
import { pathStrip } from './world-core.js';
import { LAKE } from './world-core.js';
import { rng } from './world-geo.js';
import { GLSL_HASH, chainPatch, facadePatch, weatherPatch } from './world-shaders.js';

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const hash2 = (x, z) => {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
function vnoise(x, z) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const a = hash2(xi, zi);
  const b = hash2(xi + 1, zi);
  const c = hash2(xi, zi + 1);
  const d = hash2(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, z) => vnoise(x, z) * 0.55 + vnoise(x * 2.1 + 5.2, z * 2.1 + 1.3) * 0.3 + vnoise(x * 4.3 + 9.1, z * 4.3 + 3.7) * 0.15;

export const SEA_Y = M.WATER_Y;
export const PROMENADE_Y = 4.5;
const TUNNEL = { x0: 189, x1: 215, z0: -150, z1: 150 };
const HARBOUR = { x0: 236, x1: 262, z0: 140, z1: 300 };
const LIGHTHOUSE = { x: 380, z: -270, h: 28 };
const RAIL_YARD = { x0: -150, x1: -60, z0: 210, z1: 270 };
const ALLOTMENTS = { x0: 60, x1: 166, z0: 212, z1: 280 };
const POWER = { x0: -245, x1: -200, z0: 50, z1: 105 }; // lane B's power station (keep out)

/** Hills (m) outside the flat city: west to ~140 m at 1.2–1.5 km, south ~40 m, north ~90 m. */
export function hillHeight(x, z) {
  const n = fbm(x / 420, z / 420);
  const west = smooth(450, 1350, -x) * (95 + 60 * n);
  const south = smooth(650, 1250, z) * (24 + 22 * n) * (1 - smooth(150, 400, x));
  const north = smooth(900, 1700, -z) * (55 + 45 * n) * (1 - smooth(300, 700, x));
  const roll = smooth(320, 700, Math.max(Math.abs(x), Math.abs(z))) * 7 * fbm(x / 160 + 3, z / 160 + 7) * (1 - smooth(150, 236, x));
  return west + south + north + roll;
}

/** §17.4 heightAt: 0 inside |x|, |z| < 260 (the city), hills beyond, the sea surface off the coast. */
export function heightAt(x, z) {
  x = Number(x) || 0;
  z = Number(z) || 0;
  if (Math.max(Math.abs(x), Math.abs(z)) < 260) return 0;
  if (x > M.SEA_X) return SEA_Y;
  return hillHeight(x, z);
}

/** The terrain mesh's own height (the city's bands sit 0.3 m above it; lake bed; beach; seabed). */
function terrainY(x, z) {
  const ax = Math.abs(x);
  const az = Math.abs(z);
  const m = Math.max(ax, az);
  if (x > 214) {
    // Beach to the waterline at 236, then the seabed.
    const beach = 0.35 - 2.4 * smooth(215, 236, x);
    const bed = SEA_Y - 0.6 - 7 * smooth(236, 320, x);
    return x < 236 ? beach : Math.min(beach, bed);
  }
  if (m < 117.5) {
    const e = ((x - LAKE.x) / LAKE.a) ** 2 + ((z - LAKE.z) / LAKE.b) ** 2;
    if (e < 1.12) return -1.6 * (1 - smooth(0.75, 1.12, e)); // the lake bed
    return 0;
  }
  if (m < 203) return -0.3;
  return hillHeight(x, z);
}

/** Terrain colour (sRGB → linear via THREE.Color) per vertex. */
function terrainColor(x, z, y, out) {
  const ax = Math.abs(x);
  const az = Math.abs(z);
  const m = Math.max(ax, az);
  const n = hash2(Math.round(x * 0.37), Math.round(z * 0.37));
  const f = fbm(x / 60, z / 60);
  if (x > 214) {
    if (x < 236.5) return out.set('#d8c49b').multiplyScalar(0.9 + 0.12 * f);
    return out.set('#5f7a74').lerp(new THREE.Color('#2f4a55'), smooth(236, 300, x));
  }
  if (m < 117.5) {
    const e = ((x - LAKE.x) / LAKE.a) ** 2 + ((z - LAKE.z) / LAKE.b) ** 2;
    if (e < 1.05) return out.set('#4a4a38');
    return out.set('#4d7a33').lerp(new THREE.Color('#5f8c3d'), f).multiplyScalar(0.92 + 0.12 * n);
  }
  if (m < 203) return out.set('#6a655b');
  // Uptown: paved.
  if (z < -215 && z > -680 && ax < 290) return out.set('#5d5f63').multiplyScalar(0.9 + 0.15 * n);
  // Old Town: streets between the blocks.
  if (x < -203 && x > -330 && az < 310) return out.set('#6b655c').multiplyScalar(0.9 + 0.15 * n);
  // Rail yard.
  if (x > RAIL_YARD.x0 - 5 && x < RAIL_YARD.x1 + 5 && z > RAIL_YARD.z0 - 5 && z < RAIL_YARD.z1 + 5) return out.set('#5f5a52');
  // South: fields beyond ~600 m (a patchwork).
  if (z > 600 && x < 200) {
    const cell = hash2(Math.floor(x / 140), Math.floor(z / 110));
    const fields = ['#8f9346', '#6f8f3f', '#a8925a', '#7c6c45', '#7d9a4a'];
    return out.set(fields[Math.floor(cell * fields.length)]).multiplyScalar(0.9 + 0.12 * f);
  }
  // Hills: grass darkening and greening with height, some woodland tone.
  const hill = smooth(5, 120, y);
  out.set('#5d7f3b').lerp(new THREE.Color('#41602f'), hill * 0.8 + 0.2 * f).multiplyScalar(0.9 + 0.14 * n);
  return out;
}

function gridLines() {
  const far = [203, 209, 215, 222, 229, 236, 245, 258, 275, 296, 320, 350, 385, 425, 470, 520, 580, 650, 730, 820, 920, 1030, 1150, 1280, 1420, 1580, 1760, 1980, 2250, 2600, 3000, 3500, 4000];
  const city = [117, 122, 139, 173, 181, 191];
  const lines = new Set();
  for (const v of [...far, ...city]) {
    lines.add(v);
    lines.add(-v);
  }
  for (let v = -116; v <= 116; v += 4) lines.add(v);
  return [...lines].sort((a, b) => a - b);
}

/** The terrain: one non-uniform grid (fine in the park, coarse far out). */
function terrainGeometry() {
  const xs = gridLines();
  const zs = xs;
  const nx = xs.length;
  const nz = zs.length;
  const pos = new Float32Array(nx * nz * 3);
  const colArr = new Float32Array(nx * nz * 3);
  const c = new THREE.Color();
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = xs[i];
      const z = zs[j];
      const y = terrainY(x, z);
      const k = j * nx + i;
      pos[k * 3] = x;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = z;
      terrainColor(x, z, y, c);
      colArr[k * 3] = c.r;
      colArr[k * 3 + 1] = c.g;
      colArr[k * 3 + 2] = c.b;
    }
  }
  const idx = [];
  for (let j = 0; j + 1 < nz; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const d = a + nx;
      const e = d + 1;
      // Up-facing: (a, d, b) then (b, d, e).
      idx.push(a, d, b, b, d, e);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

// ---- water --------------------------------------------------------------------------------------

/** Collects water surfaces: fans for basins / the lake (ice-able), the sea plane. */
export function waterCollector() {
  const buf = new MeshBuf('aW');
  const tint = { lake: new THREE.Color('#2f4d43'), basin: new THREE.Color('#2f6070'), sea: new THREE.Color('#1d4f63') };
  return {
    buf,
    /** A filled polygon of water at height y that freezes in snow. */
    ice(pts, y, kind = y > 0 ? 'basin' : 'lake') {
      let cx = 0;
      let cz = 0;
      for (const [x, z] of pts) {
        cx += x;
        cz += z;
      }
      cx /= pts.length;
      cz /= pts.length;
      for (let k = 0; k < pts.length; k++) {
        const a = pts[k];
        const b = pts[(k + 1) % pts.length];
        buf.quad([cx, y, cz], [a[0], y, a[1]], [b[0], y, b[1]], [cx, y, cz], [0, 1, 0], tint[kind], [1, 0, 0, 0]);
      }
    },
    sea() {
      const y = SEA_Y;
      buf.quad([M.SEA_X - 6, y, -4000], [4000, y, -4000], [4000, y, 4000], [M.SEA_X - 6, y, 4000], [0, 1, 0], tint.sea, [0, 1, 0, 0]);
    },
  };
}

const WATER_PARS = /* glsl */ `
uniform float uCityTime;
uniform float uSnow;
varying vec4 vW;
varying vec2 vWP;
${GLSL_HASH}
`;

/** Water: low roughness (reflects the sky probe), animated ripples, ice in snow (lake / basins). */
export function waterMaterial(uniforms) {
  const m = new THREE.MeshStandardMaterial({ name: 'water', vertexColors: true, roughness: 0.06, metalness: 0.0, envMapIntensity: 1.0 });
  chainPatch(m, 'water-v1', (shader) => {
    shader.uniforms.uCityTime = uniforms.uCityTime;
    shader.uniforms.uSnow = uniforms.uSnow;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'attribute vec4 aW;\nvarying vec4 vW;\nvarying vec2 vWP;\nvoid main() {')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvW = aW;\nvWP = position.xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${WATER_PARS}\nvoid main() {`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        float iceK = vW.x * smoothstep(0.3, 0.8, uSnow);
        roughnessFactor = mix(roughnessFactor, 0.45, iceK);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.78, 0.84, 0.9), iceK);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float t = uCityTime;
          vec2 p = vWP * (vW.y > 0.5 ? 0.08 : 0.35);
          float e = 0.6;
          float h0 = cityNoise(p + vec2(t * 0.06, t * 0.04)) + 0.5 * cityNoise(p * 2.7 - vec2(t * 0.09, -t * 0.05));
          float hx = cityNoise(p + vec2(e, 0.0) + vec2(t * 0.06, t * 0.04)) + 0.5 * cityNoise((p + vec2(e, 0.0)) * 2.7 - vec2(t * 0.09, -t * 0.05));
          float hz = cityNoise(p + vec2(0.0, e) + vec2(t * 0.06, t * 0.04)) + 0.5 * cityNoise((p + vec2(0.0, e)) * 2.7 - vec2(t * 0.09, -t * 0.05));
          vec3 wn = normalize(vec3((h0 - hx) * 0.35, 1.0, (h0 - hz) * 0.35));
          wn = normalize(mix(wn, vec3(0.0, 1.0, 0.0), iceK));
          normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
        }`);
  });
  return m;
}

// ---- horizon hills and the lighthouse beam -------------------------------------------------------

const HILL_VERT = /* glsl */ `
attribute float aLayer;
varying float vLayer;
varying float vH;
void main() {
  vLayer = aLayer;
  vH = position.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const HILL_FRAG = /* glsl */ `
uniform vec3 uHaze;
uniform vec3 uLand;
varying float vLayer;
varying float vH;
void main() {
  // Aerial perspective: the far layer is mostly haze, the near one bluish land fading up into it.
  float k = mix(0.55, 0.78, vLayer);
  vec3 c = mix(uLand, uHaze, k + 0.12 * smoothstep(0.0, 260.0, vH));
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function hillCards() {
  const pos = [];
  const layer = [];
  const idx = [];
  const layers = [{ r: 2150, h0: 50, h1: 170, f: 3.1 }, { r: 2650, h0: 110, h1: 290, f: 2.3 }];
  let base = 0;
  layers.forEach((L, li) => {
    const n = 120;
    const a0 = Math.PI * 0.32;
    const a1 = Math.PI * 1.68; // south → west → north (the sea is to the east)
    for (let k = 0; k <= n; k++) {
      const a = a0 + ((a1 - a0) * k) / n;
      const x = Math.cos(a) * L.r;
      const z = Math.sin(a) * L.r;
      const edge = smooth(a0, a0 + 0.25, a) * (1 - smooth(a1 - 0.25, a1, a));
      const h = (L.h0 + (L.h1 - L.h0) * fbm(a * L.f, li * 7.3)) * (0.2 + 0.8 * edge) + (a > Math.PI * 0.75 && a < Math.PI * 1.25 ? 40 : 0);
      pos.push(x, -60, z, x, h, z);
      layer.push(li, li);
    }
    for (let k = 0; k < n; k++) {
      const a = base + k * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    base += (n + 1) * 2;
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aLayer', new THREE.Float32BufferAttribute(layer, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const uniforms = { uHaze: { value: new THREE.Color('#c7d8e4') }, uLand: { value: new THREE.Color('#4d6b5c') } };
  const mat = new THREE.ShaderMaterial({ name: 'horizon-hills', uniforms, vertexShader: HILL_VERT, fragmentShader: HILL_FRAG, side: THREE.DoubleSide, fog: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'horizon-hills';
  mesh.renderOrder = -10;
  return { mesh, uniforms };
}

const BEAM_VERT = /* glsl */ `
uniform float uCityTime;
varying float vT;
varying float vR;
void main() {
  vT = position.x;            // 0 at the lantern … 1 at the far end (either beam)
  vR = position.z;
  float a = uCityTime * 6.2831853 * 0.25;
  float L = 150.0 * position.x;
  float side = position.y;    // +1 / −1: the two opposite beams
  vec3 p = vec3(L * side, position.z * (1.2 + 13.0 * position.x), 0.0);
  float c = cos(a);
  float s = sin(a);
  vec3 r = vec3(p.x * c - p.z * s, p.y - 4.0 * position.x, p.x * s + p.z * c);
  // A flat fan (two crossed quads) per beam.
  r.y += position.z * 0.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(r, 1.0);
}`;
const BEAM_FRAG = /* glsl */ `
uniform float uLights;
varying float vT;
varying float vR;
void main() {
  float a = pow(1.0 - vT, 1.6) * (1.0 - abs(vR)) * uLights * 0.55;
  gl_FragColor = vec4(vec3(1.0, 0.93, 0.75) * a, 1.0);
}`;

function lighthouseBeam(uniforms) {
  // Two fans, each a pair of crossed quads (horizontal + vertical), parameterised in the shader.
  const pos = [];
  const idx = [];
  let base = 0;
  for (const side of [1, -1]) {
    for (const k of [0, 1]) {
      // (t, side, across) for 4 corners; k = 1 is the vertical fan (across → y).
      pos.push(0, side, -1, 1, side, -1, 1, side, 1, 0, side, 1);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      base += 4;
      void k;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    name: 'lighthouse-beam',
    uniforms: { uCityTime: uniforms.uCityTime, uLights: uniforms.uLights },
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'lighthouse-beam';
  mesh.frustumCulled = false;
  mesh.position.set(LIGHTHOUSE.x, 2 + LIGHTHOUSE.h - 1.5, LIGHTHOUSE.z);
  mesh.renderOrder = 4;
  return mesh;
}

// ---- instanced building sets ------------------------------------------------------------------

/** A unit box (±0.5, base at y = 0 … 1) with vertex colours (white). */
function unitBox() {
  const g = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const n = g.attributes.position.count;
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  return g;
}

/** A unit gable prism: footprint ±0.5 × ±0.5, ridge along x at y = 1. */
function unitGable() {
  const buf = new MeshBuf();
  gableRoof(buf, { x: 0, z: 0, base: 0, w: 1, d: 1, rise: 1, color: '#ffffff', overhang: 0.04 });
  return buf.build();
}

function instanced(geo, material, list, { name, castShadow = false } = {}) {
  const mesh = new THREE.InstancedMesh(geo, material, Math.max(1, list.length));
  mesh.name = name;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const c = new THREE.Color();
  const Y = new THREE.Vector3(0, 1, 0);
  list.forEach((b, k) => {
    q.setFromAxisAngle(Y, b.yaw ?? 0);
    m.compose(p.set(b.x, b.y ?? 0, b.z), q, s.set(b.w, b.h, b.d));
    mesh.setMatrixAt(k, m);
    mesh.setColorAt(k, c.set(b.color));
  });
  mesh.count = list.length;
  mesh.userData.max = list.length;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = false;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

/** Desaturates an sRGB hex to `k` saturation (background buildings at 60 %). */
function desat(hex, k = 0.6) {
  const c = new THREE.Color(hex);
  const hsl = {};
  c.getHSL(hsl);
  return c.setHSL(hsl.h, hsl.s * k, hsl.l);
}

// ---- the builder --------------------------------------------------------------------------------

/**
 * ctx: { uniforms, street, outskirts (MeshBuf aFacade, no shadows), furniture, glow, water, trees, rnd }
 * Returns { meshes: [...], terrain, hills, beam, sets: { suburbs, oldtown, towers… }, anchors }.
 */
export function buildOutskirts(ctx) {
  const { uniforms, street, outskirts, furniture, glow, water, trees } = ctx;
  const rnd = rng(4417);
  const meshes = [];

  // ---- terrain + water ----
  const terrainMat = new THREE.MeshStandardMaterial({ name: 'terrain', vertexColors: true, roughness: 0.96, metalness: 0 });
  weatherPatch(terrainMat, uniforms, { wet: 0.4, snow: 1, desat: 0.3 });
  const terrain = new THREE.Mesh(terrainGeometry(), terrainMat);
  terrain.name = 'terrain';
  terrain.receiveShadow = true;
  meshes.push(terrain);
  water.sea();

  // ---- the east side: tunnel cover + promenade, seawall, beach, harbour, breakwater, lighthouse ----
  {
    const T = TUNNEL;
    const brick = '#8d5f4b';
    // The cut-and-cover box: brick arcade toward the city, stone seawall toward the beach.
    facadeBox(outskirts, { x: (T.x0 + 203) / 2, z: 0, base: 0, w: 203 - T.x0, d: T.z1 - T.z0, h: PROMENADE_Y, color: brick, style: 0, top: false });
    facadeBox(outskirts, { x: (203 + T.x1) / 2, z: 0, base: 0, w: T.x1 - 203, d: T.z1 - T.z0, h: PROMENADE_Y, color: '#a59a88', style: 0, top: false });
    // Deck on top (teak boards), an arcade of dark arches on the city face.
    street.quad([T.x0, PROMENADE_Y, T.z0], [T.x1, PROMENADE_Y, T.z0], [T.x1, PROMENADE_Y, T.z1], [T.x0, PROMENADE_Y, T.z1], [0, 1, 0], [1, 1, 1],
      [[0, 0, K.DECK, T.z0], [0, T.x1 - T.x0, K.DECK, T.z0], [0, T.x1 - T.x0, K.DECK, T.z1], [0, 0, K.DECK, T.z1]]);
    for (let z = T.z0 + 6; z < T.z1 - 4; z += 9) {
      const arch = new THREE.Shape();
      arch.moveTo(-1.8, 0);
      arch.lineTo(1.8, 0);
      arch.lineTo(1.8, 2.2);
      arch.absarc(0, 2.2, 1.8, 0, Math.PI, false);
      arch.closePath();
      const g = new THREE.ShapeGeometry(arch, 6).rotateY(-Math.PI / 2);
      outskirts.addGeometry(g, new THREE.Matrix4().makeTranslation(T.x0 - 0.04, 0, z), new THREE.Color('#2b2220'));
    }
    // Portals (north and south faces): dark openings over the two tracks, stone frames.
    for (const zf of [T.z0 - 0.04, T.z1 + 0.04]) {
      const face = zf < 0 ? Math.PI : 0;
      for (const xc of [195, 199]) {
        const o = new THREE.Shape();
        o.moveTo(-1.9, 0);
        o.lineTo(1.9, 0);
        o.lineTo(1.9, 3.2);
        o.absarc(0, 3.2, 1.9, 0, Math.PI, false);
        o.closePath();
        const g = new THREE.ShapeGeometry(o, 6).rotateY(face);
        outskirts.addGeometry(g, new THREE.Matrix4().makeTranslation(xc, 0.3, zf), new THREE.Color('#0d0c0c'));
      }
      facadeBox(outskirts, { x: 197, z: zf + (zf < 0 ? -0.3 : 0.3), base: PROMENADE_Y - 0.6, w: 12, d: 0.6, h: 0.9, color: '#b3a894', style: 0 });
    }
    // Railings along both deck edges, lamps and benches on the promenade.
    for (const x of [T.x0 + 0.2, T.x1 - 0.2]) {
      furniture.addGeometry(new THREE.BoxGeometry(0.08, 0.08, T.z1 - T.z0), new THREE.Matrix4().makeTranslation(x, PROMENADE_Y + 1.05, 0), new THREE.Color('#e8e4dc'));
      for (let z = T.z0; z <= T.z1; z += 3) furniture.addGeometry(new THREE.BoxGeometry(0.06, 1.05, 0.06), new THREE.Matrix4().makeTranslation(x, PROMENADE_Y + 0.52, z), new THREE.Color('#e8e4dc'));
    }
    for (let z = T.z0 + 12; z < T.z1; z += 24) {
      furniture.addGeometry(new THREE.CylinderGeometry(0.07, 0.1, 4.6, 6), new THREE.Matrix4().makeTranslation(213.6, PROMENADE_Y + 2.3, z), new THREE.Color('#2c3236'));
      glow.addGeometry(new THREE.SphereGeometry(0.3, 10, 8), new THREE.Matrix4().makeTranslation(213.6, PROMENADE_Y + 4.75, z), new THREE.Color('#ffe2b0'));
      furniture.addGeometry(new THREE.BoxGeometry(0.5, 0.5, 1.9), new THREE.Matrix4().makeTranslation(211.8, PROMENADE_Y + 0.45, z + 6), new THREE.Color('#7a5236'));
      trees.push({ x: 207, z: z + 3, y: PROMENADE_Y, kind: 0, scale: 0.75, prio: 2 });
    }
    // Ramps down from the deck at both ends (onto the coast road side).
    for (const dir of [1, -1]) {
      const z0 = dir > 0 ? T.z1 : T.z0;
      const z1 = z0 + dir * 32;
      street.quad([203, PROMENADE_Y, z0], [T.x1, PROMENADE_Y, z0], [T.x1, 0.35, z1], [203, 0.35, z1], [0, 1, 0], [1, 1, 1],
        [[0, 0, K.DECK, z0], [0, 12, K.DECK, z0], [0, 12, K.DECK, z1], [0, 0, K.DECK, z1]]);
      // Side walls under the ramp.
      for (const x of [203, T.x1]) {
        const g = new THREE.BufferGeometry();
        const v = new Float32Array([x, 0, z0, x, PROMENADE_Y, z0, x, 0.35, z1, x, 0, z1, x, 0, z0, x, 0.35, z1]);
        g.setAttribute('position', new THREE.BufferAttribute(v, 3));
        g.computeVertexNormals();
        outskirts.addGeometry(g, null, new THREE.Color('#a59a88'));
        const g2 = g.clone();
        g2.index = null;
        const p = g2.attributes.position.array;
        for (let k = 0; k < p.length; k += 9) { // reverse winding for the other face
          for (let c = 0; c < 3; c++) [p[k + 3 + c], p[k + 6 + c]] = [p[k + 6 + c], p[k + 3 + c]];
        }
        g2.computeVertexNormals();
        outskirts.addGeometry(g2, null, new THREE.Color('#a59a88'));
      }
    }
    // Beach huts and a lifeguard tower on the sand.
    const hut = ['#d64b4b', '#3f86c6', '#f2c230', '#3fa26b', '#f08a3e', '#ffffff'];
    for (let k = 0; k < 14; k++) {
      const z = 160 + k * 7;
      facadeBox(outskirts, { x: 219.5, z, base: 0.2, w: 3, d: 2.6, h: 2.4, color: hut[k % hut.length], style: 0 });
      gableRoof(outskirts, { x: 219.5, z, base: 2.6, w: 2.6, d: 3, rise: 1.1, yaw: Math.PI / 2, color: '#f4f1ea' });
    }
    facadeBox(outskirts, { x: 226, z: -40, base: 0.2, w: 2.4, d: 2.4, h: 4.5, color: '#e8e4dc', roofColor: '#d64b4b', style: 0 });
    // Harbour: the quay, warehouses, piers, pontoons, a basin breakwater, a container crane.
    const H = HARBOUR;
    facadeBox(outskirts, { x: (H.x0 + H.x1) / 2, z: (H.z0 + H.z1) / 2, base: SEA_Y - 1, w: H.x1 - H.x0, d: H.z1 - H.z0, h: 3.2 - SEA_Y, color: '#8e8b84', style: 0, top: false });
    street.quad([H.x0, 1.2, H.z0], [H.x1, 1.2, H.z0], [H.x1, 1.2, H.z1], [H.x0, 1.2, H.z1], [0, 1, 0], [1, 1, 1],
      [[0, 0, K.CONCRETE, H.z0], [0, 26, K.CONCRETE, H.z0], [0, 26, K.CONCRETE, H.z1], [0, 0, K.CONCRETE, H.z1]]);
    facadeBox(outskirts, { x: 246, z: 168, base: 1.2, w: 16, d: 36, h: 9, color: desat('#a8483b'), style: 2, seed: 3 });
    gableRoof(outskirts, { x: 246, z: 168, base: 10.2, w: 36, d: 16, rise: 3, yaw: Math.PI / 2, color: '#596066' });
    facadeBox(outskirts, { x: 246, z: 212, base: 1.2, w: 16, d: 30, h: 8, color: desat('#3f6f9a'), style: 2, seed: 4 });
    gableRoof(outskirts, { x: 246, z: 212, base: 9.2, w: 30, d: 16, rise: 3, yaw: Math.PI / 2, color: '#596066' });
    facadeBox(outskirts, { x: 252, z: 288, base: 1.2, w: 7, d: 7, h: 14, color: '#e8e2d6', roofColor: '#3f4a52', style: 2, seed: 5 });
    const containers = ['#b8442f', '#2f6db8', '#e0a52a', '#3d8b4f', '#6d6d6d'];
    for (let k = 0; k < 18; k++) {
      const row = k % 3;
      const lvl = Math.floor(k / 9);
      facadeBox(outskirts, { x: 252 + row * 2.7, z: 240 + (Math.floor(k / 3) % 3) * 6.4, base: 1.2 + lvl * 2.6, w: 2.5, d: 6.1, h: 2.55, color: desat(containers[k % containers.length], 0.75), style: 0 });
    }
    for (const z of [170, 205, 240, 275]) {
      facadeBox(outskirts, { x: 311, z, base: 0.5, w: 98, d: 6, h: 0.7, color: '#9a968c', style: 0 });
      for (let x = 266; x <= 358; x += 8) furniture.addGeometry(new THREE.CylinderGeometry(0.35, 0.35, 3.2, 6), new THREE.Matrix4().makeTranslation(x, SEA_Y + 1.1, z), new THREE.Color('#4a4740'));
      for (let x = 270; x <= 350; x += 16) furniture.addGeometry(new THREE.BoxGeometry(1.6, 0.25, 14).translate(0, 0, 10), new THREE.Matrix4().makeTranslation(x, SEA_Y + 0.25, z), new THREE.Color('#7b5a3c'));
    }
    for (const [x0, z0, x1, z1] of [[262, 302, 398, 302], [398, 302, 398, 150]]) {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const g = new THREE.BoxGeometry(len, 4.2, 9).translate(0, 0, 0);
      g.rotateY(-Math.atan2(z1 - z0, x1 - x0));
      outskirts.addGeometry(g, new THREE.Matrix4().makeTranslation((x0 + x1) / 2, SEA_Y + 1.6, (z0 + z1) / 2), new THREE.Color('#77736a'));
    }
    // Container crane on the quay (legs, girder, boom).
    {
      const cx = 258;
      const cz = 255;
      const orange = new THREE.Color('#d9762b');
      for (const [dx, dz] of [[-5, -6], [5, -6], [-5, 6], [5, 6]]) furniture.addGeometry(new THREE.BoxGeometry(0.8, 26, 0.8).translate(0, 13, 0), new THREE.Matrix4().makeTranslation(cx + dx, 1.2, cz + dz), orange);
      furniture.addGeometry(new THREE.BoxGeometry(48, 1.6, 2.2), new THREE.Matrix4().makeTranslation(cx + 14, 27.5, cz), orange);
      furniture.addGeometry(new THREE.BoxGeometry(6, 4, 3), new THREE.Matrix4().makeTranslation(cx - 4, 30, cz), new THREE.Color('#e8e4dc'));
    }
    // Breakwater out to the lighthouse (NE).
    const arm = [[232, -212], [270, -232], [320, -250], [372, -266]];
    for (let k = 0; k + 1 < arm.length; k++) {
      const [x0, z0] = arm[k];
      const [x1, z1] = arm[k + 1];
      const len = Math.hypot(x1 - x0, z1 - z0) + 2;
      const g = new THREE.BoxGeometry(len, 4.6, 8);
      g.rotateY(-Math.atan2(z1 - z0, x1 - x0));
      outskirts.addGeometry(g, new THREE.Matrix4().makeTranslation((x0 + x1) / 2, SEA_Y + 1.9, (z0 + z1) / 2), new THREE.Color('#77736a'));
    }
    // The lighthouse: 28 m, red and white bands, gallery, lantern.
    const L = LIGHTHOUSE;
    outskirts.addGeometry(new THREE.CylinderGeometry(7, 7.5, 4.2, 20), new THREE.Matrix4().makeTranslation(L.x, SEA_Y + 2.1, L.z), new THREE.Color('#8a857a'));
    const bands = 6;
    for (let k = 0; k < bands; k++) {
      const y0 = 2 + (k * (L.h - 4)) / bands;
      const y1 = 2 + ((k + 1) * (L.h - 4)) / bands;
      const r0 = 3.3 - (k / bands) * 1.2;
      const r1 = 3.3 - ((k + 1) / bands) * 1.2;
      outskirts.addGeometry(new THREE.CylinderGeometry(r1, r0, y1 - y0, 20, 1, true), new THREE.Matrix4().makeTranslation(L.x, (y0 + y1) / 2, L.z), new THREE.Color(k % 2 ? '#f4f1ea' : '#c8302c'));
    }
    outskirts.addGeometry(new THREE.CylinderGeometry(3.0, 3.0, 0.4, 20), new THREE.Matrix4().makeTranslation(L.x, L.h - 1.8, L.z), new THREE.Color('#2c2c2c'));
    glow.addGeometry(new THREE.CylinderGeometry(1.6, 1.6, 2.4, 14), new THREE.Matrix4().makeTranslation(L.x, L.h - 0.4, L.z), new THREE.Color('#fff1c4'));
    outskirts.addGeometry(new THREE.ConeGeometry(2.1, 1.8, 14), new THREE.Matrix4().makeTranslation(L.x, L.h + 1.7, L.z), new THREE.Color('#c8302c'));
  }
  const beam = lighthouseBeam(uniforms);
  meshes.push(beam);

  // ---- arterials (2 lanes, ambient traffic only) ----
  const arterials = [
    [[-177, 177], [-620, 620]],
    [[-177, -177], [-620, -620]],
    [[177, -177], [210, -210], [210, -660]],
    [[177, 177], [210, 210], [210, 660]],
  ];
  for (const line of arterials) {
    const pts = [];
    for (let k = 0; k + 1 < line.length; k++) {
      const [x0, z0] = line[k];
      const [x1, z1] = line[k + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 20));
      for (let j = 0; j < n; j++) pts.push([x0 + ((x1 - x0) * j) / n, z0 + ((z1 - z0) * j) / n]);
    }
    pts.push(line[line.length - 1]);
    arterialStrip(street, pts);
  }

  // ---- south: suburbs (houses on streets), allotments, the rail yard ----
  const suburbs = [];
  const suburbRoofs = [];
  const houseCols = ['#f1ece2', '#e6d5b8', '#c9a27e', '#b9765a', '#d8c7a3', '#a9b8c2', '#cdb4a0', '#e9e1cc'];
  const roofCols = ['#5b5f66', '#7a4a3a', '#4f5458', '#8a5a44', '#62666b'];
  const nearArterial = (x, z, w = 16) => Math.abs(x + z) < w && x < 0 && z > 0 || Math.abs(x) > 195 || (Math.abs(x - z) < w && x > 0 && z > 0);
  for (let row = 0; row < 7; row++) {
    const zStreet = 236 + row * 56;
    // Street along x.
    pathStrip(street, [[-470, zStreet], [195, zStreet]], 7, K.ARTERIAL, { y: 0.03 + (row % 2) * 0.004 });
    for (const side of [-1, 1]) {
      const zh = zStreet + side * 13;
      for (let x = -460; x <= 190; x += 17) {
        const jx = x + (rnd() - 0.5) * 3;
        if (nearArterial(jx, zh)) continue;
        if (jx > RAIL_YARD.x0 - 8 && jx < RAIL_YARD.x1 + 8 && zh < RAIL_YARD.z1 + 10) continue;
        if (jx > ALLOTMENTS.x0 - 8 && jx < ALLOTMENTS.x1 + 8 && zh < ALLOTMENTS.z1 + 10) continue;
        if (zh < 214) continue;
        const w = 8 + rnd() * 2;
        const d = 8.5 + rnd() * 1.5;
        const h = 5.4 + rnd() * 1.2;
        const yaw = side > 0 ? Math.PI : 0;
        const dist = Math.hypot(jx, zh);
        suburbs.push({ x: jx, z: zh, w, h, d, yaw, color: desat(houseCols[Math.floor(rnd() * houseCols.length)], 0.7), dist });
        suburbRoofs.push({ x: jx, y: h, z: zh, w, h: 2.4 + rnd() * 1.2, d, yaw: yaw + Math.PI / 2, color: roofCols[Math.floor(rnd() * roofCols.length)], dist });
        if (rnd() < 0.55) trees.push({ x: jx + (rnd() - 0.5) * 8, z: zh + side * 9, kind: rnd() < 0.4 ? 1 : 0, scale: 0.6 + rnd() * 0.35, prio: 3 });
      }
    }
  }
  // Houses on the western hill slopes.
  for (let k = 0; k < 140; k++) {
    const x = -420 - rnd() * 620;
    const z = -520 + rnd() * 1040;
    const y = hillHeight(x, z);
    if (Math.abs(z) < 330 && x > -360) continue;
    const w = 8 + rnd() * 2;
    const h = 5.5 + rnd();
    const d = 8.5 + rnd();
    const yaw = rnd() * Math.PI;
    suburbs.push({ x, y, z, w, h, d, yaw, color: desat(houseCols[k % houseCols.length], 0.65), dist: Math.hypot(x, z) + 200 });
    suburbRoofs.push({ x, y: y + h, z, w, h: 2.6, d, yaw: yaw + Math.PI / 2, color: roofCols[k % roofCols.length], dist: Math.hypot(x, z) + 200 });
    if (rnd() < 0.7) trees.push({ x: x + 9, y, z: z + 4, kind: 1, scale: 0.8 + rnd() * 0.4, prio: 4 });
  }
  // Allotments: a patchwork of plots, sheds and two greenhouses.
  {
    const A = ALLOTMENTS;
    for (let x = A.x0; x < A.x1; x += 10.5) {
      for (let z = A.z0; z < A.z1; z += 7) {
        const soil = rnd() < 0.5;
        const c = new THREE.Color(soil ? '#6b4f36' : '#55753a').multiplyScalar(0.85 + rnd() * 0.25).toArray();
        street.quad([x, 0.03, z], [x + 10, 0.03, z], [x + 10, 0.03, z + 6.4], [x, 0.03, z + 6.4], [0, 1, 0], c,
          [[0, 0, K.SOIL, 0], [0, 0, K.SOIL, 10], [0, 6.4, K.SOIL, 10], [0, 6.4, K.SOIL, 0]]);
        if (rnd() < 0.22) facadeBox(outskirts, { x: x + 8.6, z: z + 1.2, base: 0, w: 1.8, d: 1.5, h: 2.1, color: desat(['#6d8a5a', '#8a6a4a', '#5a7a9a'][Math.floor(rnd() * 3)], 0.8), style: 0 });
      }
    }
    for (const [x, z] of [[78, 226], [140, 262]]) facadeBox(outskirts, { x, z, base: 0, w: 8, d: 4, h: 2.6, color: '#b8d0d6', style: 0 });
  }
  // The rail yard: sidings with wagons and an engine shed.
  {
    const Y = RAIL_YARD;
    street.quad([Y.x0, 0.05, Y.z0], [Y.x1, 0.05, Y.z0], [Y.x1, 0.05, Y.z1], [Y.x0, 0.05, Y.z1], [0, 1, 0], [1, 1, 1],
      [[0, 0, K.BALLAST, 0], [0, 0, K.BALLAST, 90], [0, 0, K.BALLAST, 90], [0, 0, K.BALLAST, 0]]);
    const steel = new THREE.Color('#7d8085');
    const wagon = ['#7a3b2e', '#4f5b66', '#7a6a3a', '#3e5a48'];
    for (let k = 0; k < 6; k++) {
      const z = Y.z0 + 6 + k * 8.5;
      street.quad([Y.x0, 0.2, z - 1.5], [Y.x1 - 4, 0.2, z - 1.5], [Y.x1 - 4, 0.2, z + 1.5], [Y.x0, 0.2, z + 1.5], [0, 1, 0], [1, 1, 1],
        [[0, 61.25, K.BALLAST, 0], [0, 61.25, K.BALLAST, 86], [0, 64.25, K.BALLAST, 86], [0, 64.25, K.BALLAST, 0]]);
      for (const dz of [-0.7175, 0.7175]) furniture.addGeometry(new THREE.BoxGeometry(Y.x1 - 4 - Y.x0, 0.15, 0.07), new THREE.Matrix4().makeTranslation((Y.x0 + Y.x1 - 4) / 2, 0.28, z + dz), steel);
      const n = 1 + Math.floor(rnd() * 4);
      for (let j = 0; j < n; j++) {
        const x = Y.x0 + 8 + j * 15.5 + rnd() * 6;
        facadeBox(outskirts, { x, z, base: 0.9, w: 14, d: 2.9, h: 3.4, color: desat(wagon[(k + j) % wagon.length], 0.8), style: 0 });
      }
    }
    facadeBox(outskirts, { x: Y.x1 + 12, z: Y.z0 + 30, base: 0, w: 22, d: 52, h: 9, color: desat('#8a4b3a', 0.7), style: 2, seed: 8 });
    gableRoof(outskirts, { x: Y.x1 + 12, z: Y.z0 + 30, base: 9, w: 52, d: 22, rise: 3.5, yaw: Math.PI / 2, color: '#4a4f55' });
  }

  // ---- west: the Old Town (3–5 storeys, gables), outside the power-station zone ----
  const oldtown = [];
  const oldRoofs = [];
  const oldCols = ['#c98f6f', '#d9b27c', '#b8705a', '#e2cfa8', '#a8b49a', '#c7a6a0', '#d4c09a', '#9fb2bc'];
  for (let bx = -212; bx > -330; bx -= 34) {
    for (let bz = -300; bz < 300; bz += 34) {
      const cx = bx - 13;
      const cz = bz + 13;
      if (cx + 13 > POWER.x0 - 4 && cx - 13 < POWER.x1 + 4 && cz + 13 > POWER.z0 - 4 && cz - 13 < POWER.z1 + 4) continue;
      if (Math.abs(Math.abs(cx) - Math.abs(cz)) < 22) continue; // the diagonal arterials
      // Row houses: 4 per block side facing north and south.
      for (const side of [-1, 1]) {
        for (let k = 0; k < 4; k++) {
          const w = 6.5;
          const d = 11;
          const h = 10 + Math.floor(rnd() * 3) * 3.2;
          const x = cx - 9.75 + k * 6.5;
          const z = cz + side * 6.5;
          const color = desat(oldCols[Math.floor(rnd() * oldCols.length)], 0.62);
          const dist = Math.hypot(x, z);
          oldtown.push({ x, z, w: w - 0.1, h, d, yaw: 0, color, dist });
          oldRoofs.push({ x, y: h, z, w: d, h: 3.4, d: w - 0.1, yaw: Math.PI / 2, color: rnd() < 0.6 ? '#7a4a3a' : '#555b62', dist });
        }
      }
    }
  }
  // Uptown low blocks (podiums between the towers).
  const towers = [];
  {
    const cols = ['#9db8cf', '#c9c2b4', '#8fa3b0', '#b9a58d', '#a7b8c4', '#d2cbbb', '#7f95a8', '#b0b6bd'];
    const cand = [];
    for (let x = -240; x <= 240; x += 40) {
      for (let z = -250; z >= -640; z -= 40) {
        const jx = x + (hash2(x, z) - 0.5) * 12;
        const jz = z + (hash2(z, x) - 0.5) * 12;
        if (Math.abs(jx) < 30 && jz > -320) continue; // keep the view axis north of the park open
        const centre = Math.exp(-((jx / 230) ** 2) - (((jz + 430) / 170) ** 2));
        const h = 60 + 120 * centre * (0.55 + 0.45 * hash2(jx * 0.3, jz * 0.7));
        const w = 18 + 16 * hash2(jz, jx);
        const d = 18 + 16 * hash2(jx + 3, jz - 7);
        cand.push({ x: jx, z: jz, w, h, d, yaw: 0, color: desat(cols[Math.floor(hash2(jx * 7, jz) * cols.length)], 0.6), dist: -h });
      }
    }
    cand.sort((a, b) => a.dist - b.dist); // tallest first: lower tiers keep the skyline's peaks
    for (const t of cand.slice(0, 60)) towers.push(t);
    for (const t of cand.slice(60)) {
      oldtown.push({ x: t.x, z: t.z, w: t.w + 8, h: 14 + 12 * hash2(t.x, t.z), d: t.d + 8, yaw: 0, color: t.color, dist: Math.hypot(t.x, t.z) + 100 });
    }
  }

  // Instanced sets (sorted by priority: tiers keep the first `count`).
  const byDist = (a, b) => a.dist - b.dist;
  suburbs.sort(byDist);
  suburbRoofs.sort(byDist);
  oldtown.sort(byDist);
  oldRoofs.sort(byDist);
  const box = unitBox();
  const gable = unitGable();
  const bodyMat = (style, name) => {
    const m = new THREE.MeshStandardMaterial({ name, vertexColors: true, roughness: 0.82, metalness: 0 });
    facadePatch(m, uniforms, { instanced: true, style, saturation: 1 });
    weatherPatch(m, uniforms, { wet: 0.6, snow: 1, desat: 0.35 });
    return m;
  };
  const roofMat = new THREE.MeshStandardMaterial({ name: 'roofs', vertexColors: true, roughness: 0.8, metalness: 0 });
  weatherPatch(roofMat, uniforms, { wet: 0.6, snow: 1, desat: 0.35 });
  const sets = {
    suburbs: instanced(box, bodyMat(1, 'suburb-houses'), suburbs, { name: 'suburb-houses' }),
    suburbRoofs: instanced(gable, roofMat, suburbRoofs, { name: 'suburb-roofs' }),
    oldtown: instanced(box, bodyMat(3, 'oldtown'), oldtown, { name: 'oldtown' }),
    oldRoofs: instanced(gable, roofMat, oldRoofs, { name: 'oldtown-roofs' }),
    towers: instanced(box, bodyMat(4, 'uptown'), towers, { name: 'uptown-towers' }),
  };
  meshes.push(...Object.values(sets));

  const hills = hillCards();
  meshes.push(hills.mesh);

  return {
    meshes,
    terrain,
    hills,
    beam,
    sets,
    anchors: {
      harbour: { pos: { x: 320, y: 1.2, z: 220 }, yaw: Math.PI / 2 },
      lighthouse: { pos: { x: LIGHTHOUSE.x, y: LIGHTHOUSE.h, z: LIGHTHOUSE.z }, yaw: 0 },
      uptown: { pos: { x: 0, y: 0, z: -420 }, yaw: 0 },
    },
  };
}

/** A 9 m two-lane road following the terrain (raised over the rail bed). */
function arterialStrip(street, pts) {
  const half = 4.5;
  let u = 0;
  const yAt = (x, z) => {
    const m = Math.max(Math.abs(x), Math.abs(z));
    if (m >= 190 && m <= 204) return 0.36;
    if (m < 260) return 0.06;
    return hillHeight(x, z) + 0.12;
  };
  for (let k = 0; k + 1 < pts.length; k++) {
    const [x0, z0] = pts[k];
    const [x1, z1] = pts[k + 1];
    const L = Math.hypot(x1 - x0, z1 - z0);
    if (L < 1e-3) continue;
    const nx = -(z1 - z0) / L;
    const nz = (x1 - x0) / L;
    const y0 = yAt(x0, z0);
    const y1 = yAt(x1, z1);
    street.quad([x0 - nx * half, y0, z0 - nz * half], [x0 + nx * half, y0, z0 + nz * half], [x1 + nx * half, y1, z1 + nz * half], [x1 - nx * half, y1, z1 - nz * half],
      [0, 1, 0], [1, 1, 1], [[0, -half, K.ARTERIAL, u], [0, half, K.ARTERIAL, u], [0, half, K.ARTERIAL, u + L], [0, -half, K.ARTERIAL, u + L]]);
    u += L;
  }
}
