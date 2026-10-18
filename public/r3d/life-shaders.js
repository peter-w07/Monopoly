// public/r3d/life-shaders.js — GLSL for the city's ambient life (lane D): path-driven instancing for
// traffic and pedestrians, the biped pose (walk / cheer / clap / umbrella / hard hat), and the material
// patches that put them into lit three.js materials (fog, shadows received, the scene's lights).
//
// Instances never move on the CPU: the vertex shader samples the path texture (life-paths.js) with
// the city time — u = fract(phase + uLifeTime · laps / 3600) — and derives the walk phase or the wheel
// angle from the distance travelled, so feet never slide and wheels never skid, at ×1, ×40 or ×−4.
import * as THREE from './three.js';

/** Small helpers shared by every life vertex shader. */
export const LIFE_HELPERS = /* glsl */ `
vec3 lifeRotY(vec3 v, float h) { float c = cos(h), s = sin(h); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }
vec3 lifeRotX(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x, c * v.y - s * v.z, s * v.y + c * v.z); }
vec3 lifeRotZ(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x - s * v.y, s * v.x + c * v.y, v.z); }
vec3 lifeUnpack(float c) { return vec3(floor(c / 65536.0), floor(mod(c, 65536.0) / 256.0), mod(c, 256.0)) / 255.0; }
float lifeHash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
`;

/** Shared vertex code: the path frame of this instance. */
export const PATH_PARS = /* glsl */ `
${LIFE_HELPERS}
uniform highp sampler2D uLifePath;
uniform float uLifeTime;
uniform float uLifeHide;
attribute vec4 aPath;   // row, phase (0..1), laps per 3600 s (signed: < 0 walks the loop backwards), lateral (m, + = outward)
attribute vec4 aInfo;   // loop length (m), stride / wheel radius (m), cull distance (m), base height (m)
// The instance's place on its loop: P (world, y = base), heading H (forward = (sin H, cos H)),
// distance travelled D (m, along its own facing), hide = 1 beyond the cull distance / hidden layer.
void lifeFrame(out vec3 P, out float H, out float D, out float hide) {
  float laps = aPath.z;
  float u = fract(aPath.y + uLifeTime * laps * (1.0 / 3600.0));
  ivec2 sz = textureSize(uLifePath, 0);
  float fx = u * float(sz.x);
  float i0 = floor(fx);
  float f = fx - i0;
  int x0 = int(i0) % sz.x;
  int x1 = (x0 + 1) % sz.x;
  int row = int(aPath.x + 0.5);
  vec4 a = texelFetch(uLifePath, ivec2(x0, row), 0);
  vec4 b = texelFetch(uLifePath, ivec2(x1, row), 0);
  float dh = b.z - a.z;
  dh -= 6.28318530718 * floor((dh + 3.14159265359) / 6.28318530718);
  H = a.z + dh * f;
  float db = b.w;
  if (db < a.w) db += aInfo.x;
  D = mix(a.w, db, f);
  vec2 xz = mix(a.xy, b.xy, f) + vec2(cos(H), -sin(H)) * aPath.w;
  if (laps < 0.0) { H += 3.14159265359; D = -D; }
  P = vec3(xz.x, aInfo.w, xz.y);
  hide = max(uLifeHide, step(aInfo.z, distance(P, cameraPosition)));
}
`;

/** Common geometry attributes of every life mesh (life-geo.js). */
const GEO_PARS = /* glsl */ `
attribute vec3 aCol;    // base colour (linear)
attribute vec4 aA;      // part, colour slot, type, paint flag
attribute vec4 aB;      // pivot xyz, emissive class (1 headlight, 2 tail light, 3 lit window / sign)
varying vec3 vLifeCol;
varying float vLifeEmit;
`;

const FRAG_PARS = /* glsl */ `
uniform float uLights;
varying vec3 vLifeCol;
varying float vLifeEmit;
vec3 lifeEmissive() {
  if (vLifeEmit < 0.5) return vec3(0.0);
  if (vLifeEmit < 1.5) return vec3(1.0, 0.9, 0.7) * (0.1 + 2.6 * uLights);
  if (vLifeEmit < 2.5) return vec3(1.0, 0.08, 0.04) * (0.35 + 1.8 * uLights);
  return vLifeCol * (2.2 * uLights);
}
`;

const VEHICLE_BODY = /* glsl */ `
attribute vec4 aLook;   // paint (packed 0xRRGGBB), vehicle type, unused, seed
`;

/** The biped pose: rotations of the limbs about their pivots, in model space (+Z forward). */
const BIPED_POSE = /* glsl */ `
uniform float uWet;
uniform float uGaitAmp;
uniform float uRealTime;
// part ids: 0 body, 1 left leg, 2 right leg, 3 left arm, 4 right arm, 5 head, 6 umbrella, 7 hard hat, 8 skirt
// mode: 0 walking, 1 cheering (arms up, 2 Hz bounce), 2 clapping, 3 standing
void bipedPose(inout vec3 p, inout vec3 n, float gait, float mode, float t, float umbrella, float hardhat, float skirt, float seed, out float hidden) {
  float part = aA.x;
  hidden = 0.0;
  vec3 pivot = aB.xyz;
  float amp = mode < 0.5 ? uGaitAmp : 0.0;
  float s = sin(gait);
  float ax = 0.0;   // rotation about X (forward / back swing)
  float az = 0.0;   // rotation about Z (sideways)
  if (part > 0.5 && part < 1.5) ax = 0.48 * s * amp;
  else if (part > 1.5 && part < 2.5) ax = -0.48 * s * amp;
  else if (part > 2.5 && part < 3.5) ax = -0.38 * s * amp;
  else if (part > 3.5 && part < 4.5) ax = 0.38 * s * amp;
  float isArm = step(2.5, part) * step(part, 4.5);
  float side = part < 3.5 ? 1.0 : -1.0; // left arm +x
  if (mode > 0.5 && mode < 1.5 && isArm > 0.5) { // cheering: arms up, waving
    ax = -2.75 + 0.22 * sin(t * 12.566 + seed * 6.0 + side);
    az = side * 0.35;
  } else if (mode > 1.5 && mode < 2.5 && isArm > 0.5) { // clapping in front of the chest
    ax = -1.25;
    az = -side * (0.18 + 0.2 * (0.5 + 0.5 * sin(t * 18.85 + seed * 3.0)));
  } else if (mode > 2.5 && isArm > 0.5) {
    ax = 0.05 * sin(t * 1.3 + seed * 5.0 + side);
  }
  if (umbrella > 0.5 && part > 3.5 && part < 4.5 && mode < 0.5) ax = -0.62; // right arm holds the umbrella
  if (part > 5.5 && part < 6.5 && umbrella < 0.5) hidden = 1.0;
  if (part > 6.5 && part < 7.5 && hardhat < 0.5) hidden = 1.0;
  if (part > 7.5 && part < 8.5 && skirt < 0.5) hidden = 1.0;
  if (ax != 0.0 || az != 0.0) {
    p = pivot + lifeRotZ(lifeRotX(p - pivot, ax), az);
    n = lifeRotZ(lifeRotX(n, ax), az);
  }
  // body bob: twice per stride while walking; a 2 Hz bounce while cheering
  float bob = 0.035 * abs(cos(gait)) * amp;
  if (mode > 0.5 && mode < 1.5) bob += 0.13 * abs(sin(t * 6.2832 + seed * 4.0));
  if (mode > 1.5 && mode < 2.5) bob += 0.03 * abs(sin(t * 9.42 + seed * 4.0));
  p.y += bob;
}
`;

/** Colour of a biped vertex from its slot (aA.y) and the instance's packed colours. */
const BIPED_COLOUR = /* glsl */ `
vec3 bipedColour(vec4 cols, float seed) {
  float slot = aA.y;
  if (slot > 0.5 && slot < 1.5) return lifeUnpack(cols.x);
  if (slot > 1.5 && slot < 2.5) return lifeUnpack(cols.y);
  if (slot > 2.5 && slot < 3.5) return lifeUnpack(cols.z);
  if (slot > 3.5 && slot < 4.5) return lifeUnpack(cols.w);
  if (slot > 5.5 && slot < 6.5) return lifeHash(seed * 7.3) < 0.45 ? vec3(0.03, 0.03, 0.035) : lifeUnpack(cols.x) * 0.9;
  return aCol;
}
`;

function linkUniforms(shader, uniforms) {
  for (const [k, v] of Object.entries(uniforms)) shader.uniforms[k] = v;
}

function patchFragment(shader) {
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
    .replace('#include <color_fragment>', 'diffuseColor.rgb *= vLifeCol;')
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += lifeEmissive();');
}

/**
 * A lit material for path-driven vehicles (cars, taxis, vans, the bus): wheels spin from the distance,
 * other vehicle types' vertices collapse, paint comes from the instance.
 */
export function vehicleMaterial(uniforms, { name = 'life-vehicles' } = {}) {
  const mat = new THREE.MeshStandardMaterial({ name, roughness: 0.42, metalness: 0.25 });
  mat.onBeforeCompile = (shader) => {
    linkUniforms(shader, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${PATH_PARS}\n${GEO_PARS}\n${VEHICLE_BODY}`)
      .replace('#include <beginnormal_vertex>', /* glsl */ `
        vec3 lifeP; float lifeH; float lifeD; float lifeHide;
        lifeFrame(lifeP, lifeH, lifeD, lifeHide);
        if (abs(aA.z - aLook.y) > 0.5) lifeHide = 1.0;
        float lifeSpin = (aA.x > 0.5 && aA.x < 1.5) ? lifeD / max(0.05, aInfo.y) : 0.0;
        vec3 objectNormal = lifeRotY(lifeRotX(normal, lifeSpin), lifeH);
        vLifeCol = mix(aCol, lifeUnpack(aLook.x), aA.w);
        vLifeEmit = aB.w;`)
      .replace('#include <begin_vertex>', /* glsl */ `
        vec3 transformed = position;
        if (lifeSpin != 0.0) transformed = aB.xyz + lifeRotX(position - aB.xyz, lifeSpin);
        transformed = lifeRotY(transformed, lifeH) + lifeP;
        if (lifeHide > 0.5) transformed = vec3(0.0, -2000.0, 0.0);`);
    patchFragment(shader);
  };
  mat.customProgramCacheKey = () => 'life-vehicle-v1';
  return mat;
}

/** A lit material for path-driven pedestrians (biped pose from the distance walked). */
export function pedMaterial(uniforms, { name = 'life-peds' } = {}) {
  const mat = new THREE.MeshStandardMaterial({ name, roughness: 0.85, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    linkUniforms(shader, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${PATH_PARS}\n${GEO_PARS}
        uniform float uCheer;
        attribute vec4 aCols;   // shirt, trousers, skin, hair (packed 0xRRGGBB)
        attribute vec4 aVar;    // height scale, width scale, umbrella draw (0..1), style (1 = skirt)
        ${BIPED_POSE}\n${BIPED_COLOUR}`)
      .replace('#include <beginnormal_vertex>', /* glsl */ `
        vec3 lifeP; float lifeH; float lifeD; float lifeHide;
        lifeFrame(lifeP, lifeH, lifeD, lifeHide);
        float lifeSeed = aPath.y * 97.0 + aPath.x;
        float lifeGait = 6.2831853 * lifeD / max(0.3, aInfo.y);
        float lifeUmb = step(0.5, uWet) * step(aVar.z, 0.72);
        vec3 lifePos = position;
        vec3 objectNormal = normal;
        float lifeLocalHide;
        bipedPose(lifePos, objectNormal, lifeGait, uCheer > 0.5 ? 1.0 : 0.0, uRealTime, lifeUmb, 0.0, aVar.w, lifeSeed, lifeLocalHide);
        objectNormal = lifeRotY(objectNormal, lifeH);
        vLifeCol = bipedColour(aCols, lifeSeed);
        vLifeEmit = 0.0;`)
      .replace('#include <begin_vertex>', /* glsl */ `
        vec3 transformed = lifeRotY(lifePos * vec3(aVar.y, aVar.x, aVar.y), lifeH) + lifeP;
        if (lifeHide > 0.5 || lifeLocalHide > 0.5) transformed = vec3(0.0, -2000.0, 0.0);`);
    patchFragment(shader);
  };
  mat.customProgramCacheKey = () => 'life-peds-v1';
  return mat;
}

/** A lit material for the CPU crowd: the same biped, placed by per-instance state the CPU writes. */
export function crowdMaterial(uniforms, { name = 'life-crowd' } = {}) {
  const mat = new THREE.MeshStandardMaterial({ name, roughness: 0.85, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    linkUniforms(shader, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${LIFE_HELPERS}\n${GEO_PARS}
        uniform float uLifeHide;
        attribute vec4 aState;  // x, z, heading, gait phase (rad)
        attribute vec4 aAnim;   // mode, animation time (s), scale (0 = hidden), hard hat
        attribute vec4 aCols;
        attribute vec4 aVar;    // height, width, umbrella draw, style
        uniform float uBaseY;
        ${BIPED_POSE}\n${BIPED_COLOUR}`)
      .replace('#include <beginnormal_vertex>', /* glsl */ `
        float lifeSeed = aVar.z * 31.0 + aState.x * 0.01;
        float lifeUmb = step(0.5, uWet) * step(aVar.z, 0.5) * (aAnim.x < 0.5 ? 1.0 : 0.0);
        vec3 lifePos = position;
        vec3 objectNormal = normal;
        float lifeLocalHide;
        bipedPose(lifePos, objectNormal, aState.w, aAnim.x, aAnim.y, lifeUmb, aAnim.w, aVar.w, lifeSeed, lifeLocalHide);
        objectNormal = lifeRotY(objectNormal, aState.z);
        vLifeCol = bipedColour(aCols, lifeSeed);
        vLifeEmit = 0.0;`)
      .replace('#include <begin_vertex>', /* glsl */ `
        vec3 transformed = lifeRotY(lifePos * vec3(aVar.y, aVar.x, aVar.y) * aAnim.z, aState.z) + vec3(aState.x, uBaseY, aState.y);
        if (aAnim.z < 0.001 || lifeLocalHide > 0.5 || uLifeHide > 0.5) transformed = vec3(0.0, -2000.0, 0.0);`);
    patchFragment(shader);
  };
  mat.customProgramCacheKey = () => 'life-crowd-v1';
  return mat;
}

/**
 * A lit material for CPU-placed instanced meshes (trains, boats, sky): vertex colours, types that
 * collapse (aTypeI per instance), a livery colour on painted vertices, night windows / lamps, and an
 * optional world-space clip box (the east rail tunnel).
 */
export function typedMaterial(uniforms, { name = 'life-typed', roughness = 0.5, metalness = 0.2, clip = null, side = THREE.FrontSide } = {}) {
  const mat = new THREE.MeshStandardMaterial({ name, roughness, metalness, side });
  mat.onBeforeCompile = (shader) => {
    linkUniforms(shader, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${GEO_PARS}
        attribute vec4 aTypeI;   // type, light swap (1 = front lamps show red), unused, unused
        uniform vec3 uLivery;
        uniform float uLifeHide;
        varying vec3 vLifeWorld;`)
      .replace('#include <beginnormal_vertex>', /* glsl */ `
        vec3 objectNormal = normal;
        float lifeTypeHide = abs(aA.z - aTypeI.x) > 0.5 ? 1.0 : 0.0;
        vLifeCol = mix(aCol, uLivery, aA.w);
        vLifeEmit = (aB.w > 0.5 && aB.w < 1.5 && aTypeI.y > 0.5) ? 2.0 : aB.w;`)
      .replace('#include <begin_vertex>', /* glsl */ `
        vec3 transformed = position;
        if (lifeTypeHide > 0.5 || uLifeHide > 0.5) transformed = vec3(0.0, -2000.0, 0.0);`)
      .replace('#include <worldpos_vertex>', /* glsl */ `
        #include <worldpos_vertex>
        vec4 lifeW = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          lifeW = instanceMatrix * lifeW;
        #endif
        vLifeWorld = (modelMatrix * lifeW).xyz;`);
    patchFragment(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLifeWorld;')
      .replace('#include <clipping_planes_fragment>', clip
        ? `#include <clipping_planes_fragment>\nif (vLifeWorld.x > ${clip.minX.toFixed(2)} && vLifeWorld.x < ${clip.maxX.toFixed(2)} && vLifeWorld.z > ${clip.minZ.toFixed(2)} && vLifeWorld.z < ${clip.maxZ.toFixed(2)}) discard;`
        : '#include <clipping_planes_fragment>');
  };
  mat.customProgramCacheKey = () => `life-typed-v1|${clip ? JSON.stringify(clip) : ''}`;
  return mat;
}

/**
 * Additive glows (head / tail lamps, light pools on the road) for path-driven vehicles: unlit, they
 * appear with uLights and collapse in daylight.
 */
export function glowMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    name: 'life-glow',
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...uniforms },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      ${PATH_PARS}
      uniform float uLights;
      attribute vec4 aG;      // kind (0 head glow, 1 tail glow, 2 road pool), vehicle type, size, unused
      attribute vec4 aLook;
      varying vec2 vUv;
      varying vec3 vGlow;
      void main() {
        vec3 P; float H; float D; float hide;
        lifeFrame(P, H, D, hide);
        if (abs(aG.y - aLook.y) > 0.5 || uLights < 0.02) hide = 1.0;
        vec3 transformed = lifeRotY(position, H) + P;
        if (hide > 0.5) transformed = vec3(0.0, -2000.0, 0.0);
        vUv = uv;
        float k = smoothstep(0.02, 0.6, uLights);
        vGlow = aG.x < 0.5 ? vec3(1.0, 0.86, 0.6) * 0.9 * k : aG.x < 1.5 ? vec3(1.0, 0.12, 0.05) * 0.8 * k : vec3(1.0, 0.85, 0.6) * 0.16 * k;
        vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      varying vec2 vUv;
      varying vec3 vGlow;
      void main() {
        vec2 q = vUv * 2.0 - 1.0;
        float a = max(0.0, 1.0 - dot(q, q));
        a *= a;
        gl_FragColor = vec4(vGlow * a, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}

/** Soft contact shadows under path-driven instances (cars, the bus, pedestrians). */
export function blobMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    name: 'life-blobs',
    uniforms,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    vertexShader: /* glsl */ `
      #include <common>
      ${PATH_PARS}
      attribute vec4 aBlob;   // width, length, opacity, lift
      varying vec2 vUv;
      varying float vA;
      void main() {
        vec3 P; float H; float D; float hide;
        lifeFrame(P, H, D, hide);
        vec3 transformed = lifeRotY(vec3(position.x * aBlob.x, 0.0, position.z * aBlob.y), H) + P + vec3(0.0, aBlob.w, 0.0);
        if (hide > 0.5) transformed = vec3(0.0, -2000.0, 0.0);
        vUv = uv;
        vA = aBlob.z;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying float vA;
      void main() {
        vec2 q = vUv * 2.0 - 1.0;
        float a = smoothstep(1.0, 0.25, length(q)) * vA;
        if (a < 0.004) discard;
        gl_FragColor = vec4(0.03, 0.03, 0.04, a);
      }`,
  });
}

/** Birds: CPU instance matrices, wings flapped by the vertex shader (aBird: amplitude, Hz, seed, colour). */
export function birdMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({ name: 'life-birds', roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    linkUniforms(shader, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${GEO_PARS}
        attribute vec4 aBird;   // flap amplitude (rad), flap rate (Hz), seed, body colour (packed)
        uniform float uRealTime;
        uniform float uLifeHide;
        ${LIFE_HELPERS}`)
      .replace('#include <beginnormal_vertex>', /* glsl */ `
        float lifeFlap = aBird.x * sin(uRealTime * aBird.y * 6.2832 + aBird.z * 6.2832);
        float lifeWing = aA.x > 0.5 && aA.x < 1.5 ? 1.0 : aA.x > 1.5 && aA.x < 2.5 ? -1.0 : 0.0;
        vec3 objectNormal = lifeWing != 0.0 ? lifeRotZ(normal, lifeWing * lifeFlap) : normal;
        vLifeCol = aA.w > 0.5 ? lifeUnpack(aBird.w) * mix(1.0, 0.75, abs(lifeWing)) : aCol;
        vLifeEmit = 0.0;`)
      .replace('#include <begin_vertex>', /* glsl */ `
        vec3 transformed = position;
        if (lifeWing != 0.0) transformed = aB.xyz + lifeRotZ(position - aB.xyz, lifeWing * lifeFlap);
        if (uLifeHide > 0.5) transformed = vec3(0.0, -2000.0, 0.0);`);
    patchFragment(shader);
  };
  mat.customProgramCacheKey = () => 'life-birds-v1';
  return mat;
}
