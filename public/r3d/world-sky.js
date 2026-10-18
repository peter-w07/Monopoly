// public/r3d/world-sky.js — Loop City's sky and daylight (city design §13): a cheap gradient dome
// with a sun disc, a moon, stars and a cloud layer; the sun (or moon) directional light and a
// hemisphere light, all driven by the day phase and the weather.
//
// Phase: −0.3 dawn (sun below the eastern horizon) · 0 morning (east, 25°) · 0.35 afternoon (south-
// west, 40°) · 0.7 golden hour (west, 10°) · 1.0 blue hour (−4°) · 1.2 night (the moon lights the
// streets). The light direction moves only in steps of ≥ 0.25° (each step re-renders the shadow map).

import * as THREE from './three.js';
import { GLSL_HASH } from './world-shaders.js';

const KEYS = [-0.3, 0, 0.35, 0.7, 1.0, 1.2];
// sRGB palettes per key phase (THREE.Color converts to linear).
const PAL = {
  top: ['#2c3561', '#5a8fd2', '#4c85d0', '#5874b4', '#232c5a', '#080c1e'],
  horizon: ['#e9a58c', '#cfe2f0', '#d3e6f3', '#ffc895', '#c98a99', '#1c2440'],
  bottom: ['#4b3b48', '#9db0bf', '#a4b6c3', '#a88270', '#3a3048', '#0b0e18'],
  fog: ['#b99895', '#c3d3df', '#c7d8e4', '#e3b994', '#6a5f80', '#141a2c'],
  sun: ['#ff9468', '#fff0d6', '#fff6ea', '#ffb066', '#ff7a5c', '#a8bcff'],
  hemiSky: ['#b8a2bb', '#d2e2f2', '#dce9f6', '#f0d2b6', '#7782b6', '#28345e'],
  hemiGround: ['#4b3c3c', '#6e6553', '#6e6553', '#6c5240', '#2b2838', '#0f121c'],
  cloud: ['#f4c2b2', '#ffffff', '#ffffff', '#ffd2aa', '#b98aa2', '#363c5c'],
  cloudShade: ['#7f6e8e', '#c2cdda', '#c0cbd8', '#c08f84', '#45405f', '#11162a'],
};
const NUM = {
  sunI: [0.25, 2.5, 3.0, 2.1, 0.28, 0.3],
  hemiI: [0.5, 1.0, 1.05, 0.85, 0.55, 0.38],
  env: [0.45, 0.85, 0.95, 0.8, 0.5, 0.32],
  exposure: [0.98, 1.0, 1.0, 1.0, 1.06, 1.12],
  stars: [0.55, 0, 0, 0, 0.25, 1],
  // Sun azimuth (deg, from +x east toward +z south) and elevation (deg).
  az: [-15, 5, 135, 185, 200, 215],
  el: [-8, 25, 42, 10, -4, -16],
};
const OVERCAST = { top: '#8b96a3', horizon: '#bcc3c9', bottom: '#7d858c', fog: '#aeb6bd', cloud: '#d9dee3', cloudShade: '#8c949e' };
const MOON = new THREE.Vector3(0.42, 0.62, -0.66).normalize(); // high in the north-east: lights the streets toward the heli
const STEP = (0.25 * Math.PI) / 180; // the light moves in steps of at least this much

function keyAt(p) {
  const x = Math.min(KEYS[KEYS.length - 1], Math.max(KEYS[0], p));
  let k = 0;
  while (k < KEYS.length - 2 && x > KEYS[k + 1]) k++;
  const t = (x - KEYS[k]) / (KEYS[k + 1] - KEYS[k]);
  return { k, t: t * t * (3 - 2 * t) };
}

/**
 * @param {THREE.Scene} scene
 * @param {{ tier, bus }} opts
 */
export function createSky(scene, { tier, bus }) {
  const group = new THREE.Group();
  group.name = 'sky';
  const pal = {};
  for (const [k, list] of Object.entries(PAL)) pal[k] = list.map((c) => new THREE.Color(c));
  const over = {};
  for (const [k, c] of Object.entries(OVERCAST)) over[k] = new THREE.Color(c);

  const uniforms = {
    uTop: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uBottom: { value: new THREE.Color() },
    uFogCol: { value: new THREE.Color() },
    uSun: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uMoonDir: { value: MOON.clone() },
    uCloud: { value: new THREE.Color() },
    uCloudShade: { value: new THREE.Color() },
    uCover: { value: 0.35 },
    uClouds: { value: tier.clouds ? 1 : 0 },
    uStars: { value: 0 },
    uSunVis: { value: 1 },
    uFlash: { value: 0 },
    uCityTime: bus.uniforms.uCityTime,
  };
  const material = new THREE.ShaderMaterial({
    name: 'sky',
    uniforms,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const geo = new THREE.SphereGeometry(100, 40, 20);
  const dome = new THREE.Mesh(geo, material);
  dome.name = 'sky-dome';
  dome.renderOrder = -20;
  dome.frustumCulled = false;
  group.add(dome);
  // The same dome at the origin for the reflection probe (stage.js PMREM).
  const skyScene = new THREE.Scene();
  const probe = new THREE.Mesh(geo, material);
  probe.frustumCulled = false;
  skyScene.add(probe);

  // ---- lights -----------------------------------------------------------------------------------
  const sun = new THREE.DirectionalLight('#fff6ea', 3);
  sun.name = 'sun';
  sun.position.set(-300, 400, 250);
  const hemi = new THREE.HemisphereLight('#dce9f6', '#6e6553', 1);
  hemi.name = 'sky-light';
  group.add(sun, sun.target, hemi);

  const sunDir = new THREE.Vector3(); // true sun direction (may be below the horizon)
  const lightDir = new THREE.Vector3(-0.5, 0.7, 0.5).normalize(); // applied light direction (stepped)
  const wantDir = new THREE.Vector3();
  const tmp = new THREE.Color();
  const weather = { cloud: 0, rain: 0, snow: 0 };
  let phase = 0.35;
  let flash = 0;
  const base = { sunI: 3, hemiI: 1, env: 1, exposure: 1 };

  const lerpPal = (key, k, t, out) => out.copy(pal[key][k]).lerp(pal[key][k + 1], t);
  const lerpNum = (key, k, t) => NUM[key][k] + (NUM[key][k + 1] - NUM[key][k]) * t;

  /** Applies the phase + weather to the sky and lights. Returns true if the light direction stepped. */
  function apply() {
    const { k, t } = keyAt(phase);
    const cloud = weather.cloud;
    const gloom = Math.min(1, cloud * 0.85 + weather.rain * 0.25);
    const night = smooth(0.95, 1.15, phase) + (1 - smooth(-0.25, -0.05, phase)) * 0.5;
    for (const key of ['top', 'horizon', 'bottom', 'fog', 'cloud', 'cloudShade']) {
      const u = { top: 'uTop', horizon: 'uHorizon', bottom: 'uBottom', fog: 'uFogCol', cloud: 'uCloud', cloudShade: 'uCloudShade' }[key];
      lerpPal(key, k, t, uniforms[u].value);
      // Overcast greys the sky (less at night, when everything is dark anyway).
      tmp.copy(over[key]).multiplyScalar(lerpBright(phase));
      uniforms[u].value.lerp(tmp, gloom * (1 - 0.6 * night));
    }
    if (weather.snow > 0) uniforms.uFogCol.value.lerp(tmp.set('#d8dee6').multiplyScalar(lerpBright(phase)), weather.snow * 0.35);
    lerpPal('sun', k, t, uniforms.uSun.value);
    // Sun direction from azimuth / elevation.
    const az = (lerpNum('az', k, t) * Math.PI) / 180;
    const el = (lerpNum('el', k, t) * Math.PI) / 180;
    sunDir.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
    uniforms.uSunDir.value.copy(sunDir);
    uniforms.uSunVis.value = 1 - gloom * 0.9;
    uniforms.uStars.value = lerpNum('stars', k, t) * (1 - gloom);
    uniforms.uCover.value = 0.32 + 0.6 * cloud;
    // The light: the sun while it is up (never lower than 10°, for readable shadows), then the moon.
    const moonW = smooth(0.98, 1.12, phase);
    wantDir.copy(sunDir);
    if (wantDir.y < Math.sin((10 * Math.PI) / 180)) {
      wantDir.y = 0;
      wantDir.normalize().multiplyScalar(Math.cos((10 * Math.PI) / 180));
      wantDir.y = Math.sin((10 * Math.PI) / 180);
    }
    wantDir.lerp(MOON, moonW).normalize();
    // Dawn (before the sun is up): the moon lights the scene too.
    const dawnMoon = 1 - smooth(-0.22, -0.08, phase);
    if (dawnMoon > 0) wantDir.lerp(MOON, dawnMoon).normalize();
    let stepped = false;
    if (lightDir.angleTo(wantDir) >= STEP) {
      lightDir.copy(wantDir);
      stepped = true;
    }
    const moonCol = pal.sun[5];
    sun.color.copy(uniforms.uSun.value).lerp(moonCol, Math.max(moonW, dawnMoon));
    base.sunI = lerpNum('sunI', k, t) * (1 - 0.72 * gloom);
    base.hemiI = lerpNum('hemiI', k, t) * (1 + 0.25 * gloom);
    base.env = lerpNum('env', k, t) * (1 - 0.25 * gloom);
    base.exposure = lerpNum('exposure', k, t);
    lerpPal('hemiSky', k, t, hemi.color);
    lerpPal('hemiGround', k, t, hemi.groundColor);
    if (weather.snow > 0) hemi.groundColor.lerp(tmp.set('#c9ced8').multiplyScalar(lerpBright(phase)), weather.snow * 0.6);
    applyIntensities();
    return stepped;
  }

  function applyIntensities() {
    sun.intensity = base.sunI;
    hemi.intensity = base.hemiI * (1 + 3 * flash);
    uniforms.uFlash.value = flash;
  }

  function setPhase(p) {
    phase = Math.min(1.2, Math.max(-0.3, Number(p) || 0));
    return apply();
  }

  function setWeather(w) {
    weather.cloud = Math.max(w?.cloud ?? 0, w?.rain ?? 0);
    weather.rain = w?.rain ?? 0;
    weather.snow = w?.snow ?? 0;
    return apply();
  }

  function setTier(t) {
    uniforms.uClouds.value = t?.clouds ? 1 : 0;
  }

  function lightning(k) {
    flash = Math.max(0, Math.min(1, Number(k) || 0));
    applyIntensities();
  }

  setPhase(phase);

  return {
    group,
    sun,
    hemi,
    skyScene,
    uniforms,
    /** Light direction (toward the light, unit, stepped). */
    lightDir,
    get base() { return base; },
    get fogColor() { return uniforms.uFogCol.value; },
    setPhase,
    setWeather,
    setTier,
    lightning,
    follow(camera) { dome.position.copy(camera.position); },
    dispose() {
      geo.dispose();
      material.dispose();
    },
  };
}

function smooth(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Overall brightness of the sky at a phase (for the overcast grey). */
function lerpBright(p) {
  return 0.18 + 0.82 * (1 - smooth(0.85, 1.15, p)) * smooth(-0.3, 0.0, p) + 0.12 * smooth(0.6, 0.9, p) * (1 - smooth(0.95, 1.1, p));
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // on the far plane: behind everything
  gl_Position.z *= 0.99999;
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uBottom;
uniform vec3 uFogCol;
uniform vec3 uSun;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uCloud;
uniform vec3 uCloudShade;
uniform float uCover;
uniform float uClouds;
uniform float uStars;
uniform float uSunVis;
uniform float uFlash;
uniform float uCityTime;
varying vec3 vDir;
${GLSL_HASH}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * cityNoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  // Gradient: the horizon band melts into the fog colour (the far city fades into it).
  vec3 col = h >= 0.0
    ? mix(uHorizon, uTop, pow(smoothstep(0.0, 0.65, h), 0.7))
    : mix(uHorizon, uBottom, smoothstep(0.0, 0.2, -h));
  col = mix(col, uFogCol, (1.0 - smoothstep(0.0, 0.09, abs(h))) * 0.85);
  float s = max(dot(d, normalize(uSunDir)), 0.0);
  // Sun glow (also below the horizon at dawn / blue hour) and the disc.
  col += uSun * (pow(s, 8.0) * 0.32 + pow(s, 64.0) * 0.4) * uSunVis * smoothstep(-0.25, 0.05, uSunDir.y + 0.15);
  col += uSun * smoothstep(0.99955, 0.9997, s) * 6.0 * uSunVis * smoothstep(-0.02, 0.02, h);
  // Moon and stars.
  float m = max(dot(d, uMoonDir), 0.0);
  col += vec3(0.85, 0.9, 1.0) * smoothstep(0.99965, 0.9998, m) * 2.5 * uStars;
  col += vec3(0.35, 0.4, 0.6) * pow(m, 40.0) * 0.25 * uStars;
  if (uStars > 0.01 && h > 0.0) {
    vec2 sp = d.xz / (h + 0.35) * 220.0;
    vec2 id = floor(sp);
    float r = cityHash(id);
    vec2 f = fract(sp) - vec2(cityHash(id + 7.7), cityHash(id + 3.3));
    float star = step(0.985, r) * smoothstep(0.12, 0.0, length(f));
    col += vec3(star) * uStars * smoothstep(0.05, 0.3, h) * (0.5 + 0.5 * sin(uCityTime * 2.0 + r * 40.0));
  }
  if (uClouds > 0.5 && h > 0.0) {
    vec2 uv = d.xz / (h + 0.18) * 1.6 + vec2(uCityTime * 0.0035, uCityTime * 0.0012);
    float n = fbm(uv);
    float c = smoothstep(1.0 - uCover, 1.0 - uCover + 0.28, n);
    c *= smoothstep(0.02, 0.2, h);
    vec3 cc = mix(uCloudShade, uCloud, smoothstep(0.3, 0.85, fbm(uv * 1.7 + 3.1)));
    cc += uSun * pow(s, 4.0) * 0.3 * uSunVis;
    col = mix(col, cc, c * 0.9);
  }
  col += vec3(0.7, 0.75, 1.0) * uFlash * 0.6;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
