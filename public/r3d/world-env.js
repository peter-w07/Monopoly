// public/r3d/world-env.js — everything around the board: a warm terrace at golden hour.
//
//   * The board lies on a big walnut table, with table-top props around it (the bank tray with
//     money stacks and spare houses, a fan of deeds, a mug of cocoa that steams, a notepad and
//     pencil, a bowl of popcorn, a candle lantern, a potted plant, the game box lid).
//   * The table stands on a wooden deck with a rug; a railing with string lights and potted
//     shrubs runs round three sides, the house wall (warm window, door, sconces) is on the fourth.
//   * Beyond the railing: a painted, soft-focus skyline band and a gradient sky dome with a low sun
//     glow and drifting clouds. Fog in the horizon colour melts the far terrace into the haze.
//   * setDusk(t): afternoon (0) → blue-hour dusk (1). Sky, fog, lights and the glow of the string
//     lights / windows / candle follow it; the board stays readable at every value.
//
// Cost: ~14 draw calls, none of them in the shadow pass (only the table top receives shadows).
// Static props are merged per material with vertex colours (Kit); nothing here allocates per frame.

import * as THREE from './three.js';
import { SLAB_H } from './layout.js';
import { Kit, canvas, canvasTexture, softDotTexture, rng, roundedRect, smoothstep, nearFade } from './world-geo.js';

export const TABLE_Y = -SLAB_H; // table top (the board's underside rests on it)
export const TABLE_W = 34; // along x
export const TABLE_D = 26; // along z
const TABLE_T = 0.9;
const TABLE_R = 2.4;
export const FLOOR_Y = TABLE_Y - 11;
const SKY_R = 180;
const TERRACE = { rail: -48, x: 58, house: 44 }; // far railing z, side railings ±x, house wall z
const BAND_R = 150;

// Afternoon → dusk palettes (sRGB hex; THREE.Color converts to linear).
const PAL = {
  skyTop: ['#7aa7dd', '#27305f'],
  skyHorizon: ['#ffdcb6', '#e58f98'],
  skyBottom: ['#c9a58c', '#3d2d42'],
  sun: ['#ffb56c', '#ff6e3c'],
  cloud: ['#fff6ec', '#f3a7a0'],
  cloudShade: ['#d9c3c4', '#5b4a78'],
  fog: ['#efd2b8', '#86607c'],
  key: ['#ffe7c6', '#ffbb8a'],
  hemiSky: ['#fff2e0', '#c4bbef'],
  hemiGround: ['#503a2a', '#30253a'],
  fill: ['#a9cfff', '#8f8dff'],
  bandTint: ['#ffffff', '#7b6f99'],
};
const NUM = {
  keyI: [2.7, 2.15],
  hemiI: [0.72, 0.56],
  fillI: [0.34, 0.5],
  env: [0.55, 0.42],
  exposure: [1.0, 0.97],
  glow: [0.85, 2.6], // string lights / windows / candle (MeshBasic colour multiplier, >1 blooms)
  pool: [0.08, 0.34], // candle light pool on the table
  bandLights: [0.0, 1.35],
};

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {object} opts { tier }
 */
export function createEnvironment(renderer, scene, { tier }) {
  const group = new THREE.Group();
  group.name = 'environment';
  scene.add(group);
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const cols = {};
  for (const [k, [a, b]] of Object.entries(PAL)) cols[k] = [new THREE.Color(a), new THREE.Color(b)];

  // ---- lights ---------------------------------------------------------------------------------
  // Warm low sun from the front-left (the default camera sits on the GO side, +Z), so the city's
  // facades facing the player are lit and shadows fall away to the back-right.
  const hemi = new THREE.HemisphereLight('#fff2e0', '#503a2a', NUM.hemiI[0]);
  const key = new THREE.DirectionalLight('#ffe7c6', NUM.keyI[0]);
  key.position.set(-8.5, 10, 6);
  key.castShadow = true;
  Object.assign(key.shadow.camera, { left: -8.6, right: 8.6, top: 8.6, bottom: -8.6, near: 2, far: 40 });
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  const fill = new THREE.DirectionalLight('#a9cfff', NUM.fillI[0]);
  fill.position.set(8, 6, -6);
  group.add(hemi, key, fill);

  // ---- sky dome ---------------------------------------------------------------------------------
  const skyUniforms = {
    uTop: { value: cols.skyTop[0].clone() },
    uHorizon: { value: cols.skyHorizon[0].clone() },
    uBottom: { value: cols.skyBottom[0].clone() },
    uSun: { value: cols.sun[0].clone() },
    uSunDir: { value: new THREE.Vector3(-0.78, 0.1, 0.62).normalize() },
    uCloud: { value: cols.cloud[0].clone() },
    uCloudShade: { value: cols.cloudShade[0].clone() },
    uClouds: { value: tier.clouds ? 1 : 0 },
    uTime: { value: 0 },
  };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(SKY_R, 32, 16),
    new THREE.ShaderMaterial({
      name: 'sky',
      uniforms: skyUniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    }),
  );
  sky.name = 'sky';
  sky.renderOrder = -20;
  sky.frustumCulled = false;
  group.add(sky);

  // ---- soft-focus skyline band ---------------------------------------------------------------
  const band = buildSkylineBand();
  band.mesh.renderOrder = -19;
  group.add(band.mesh);

  // ---- fog ------------------------------------------------------------------------------------
  scene.fog = new THREE.Fog(cols.fog[0].clone(), 46, 175);
  scene.background = null; // the dome covers everything

  // ---- table ------------------------------------------------------------------------------------
  const woodTex = canvasTexture(woodCanvas(1024), { repeat: [0.085, 0.085], aniso });
  const woodMat = new THREE.MeshStandardMaterial({ name: 'table-wood', map: woodTex, roughness: 0.5, metalness: 0 });
  const top = new THREE.Mesh(tableTopGeometry(), woodMat);
  top.name = 'table';
  top.receiveShadow = true;
  group.add(top);
  const frame = new THREE.Mesh(tableFrameGeometry(), new THREE.MeshStandardMaterial({ name: 'table-frame', color: '#4a2c19', roughness: 0.6 }));
  frame.name = 'table-frame';
  group.add(frame);

  // ---- props (merged) -----------------------------------------------------------------------
  const matte = new Kit();
  const gloss = new Kit();
  const glow = new Kit();
  const blobs = [];
  buildProps({ matte, gloss, glow, blobs });
  buildTerrace({ matte, gloss, glow, blobs });

  // (props that can come close to a low camera dissolve instead of blocking the shot: nearFade)
  const matteMesh = new THREE.Mesh(matte.build(), nearFade(new THREE.MeshStandardMaterial({ name: 'props-matte', vertexColors: true, roughness: 0.78, metalness: 0 })));
  matteMesh.name = 'props-matte';
  const glossMesh = new THREE.Mesh(gloss.build(), nearFade(new THREE.MeshStandardMaterial({ name: 'props-gloss', vertexColors: true, roughness: 0.28, metalness: 0.45 })));
  glossMesh.name = 'props-gloss';
  const glowMat = new THREE.MeshBasicMaterial({ name: 'glow', vertexColors: true, fog: false });
  const glowMesh = new THREE.Mesh(glow.build(), glowMat);
  glowMesh.name = 'glow';
  group.add(matteMesh, glossMesh, glowMesh);

  // Printed textures on props (box lid, notepad) — one small atlas mesh.
  const decals = buildDecals(aniso);
  group.add(decals);

  // Deck floor and rug.
  // The deck ends at the railing (TERRACE); beyond it the skyline band shows.
  const deckW = 2 * TERRACE.x + 2;
  const deckD = TERRACE.house - TERRACE.rail + 2;
  const deckTex = canvasTexture(deckCanvas(512), { repeat: [deckW / 4.8, deckD / 4.8], aniso });
  const deck = new THREE.Mesh(new THREE.PlaneGeometry(deckW, deckD).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ name: 'deck', map: deckTex, roughness: 0.85 }));
  deck.position.set(0, FLOOR_Y, (TERRACE.house + TERRACE.rail) / 2);
  deck.name = 'deck';
  const rugTex = canvasTexture(rugCanvas(1024), { aniso });
  const rug = new THREE.Mesh(new THREE.ShapeGeometry(roundedRect(58, 44, 3), 6).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ name: 'rug', map: rugTex, roughness: 0.95 }));
  // ShapeGeometry UVs are in shape units: remap to 0..1.
  remapUV(rug.geometry, 58, 44);
  rug.position.y = FLOOR_Y + 0.04;
  rug.name = 'rug';
  group.add(deck, rug);

  // Contact shadows: soft dark blobs under the props, the board and the table.
  const blobTex = softDotTexture(128, 1.3);
  const blobMesh = new THREE.Mesh(blobGeometry(blobs), new THREE.MeshBasicMaterial({ name: 'contact-shadows', map: contactTexture(), color: '#1a0f08', transparent: true, depthWrite: false, vertexColors: true, fog: false }));
  blobMesh.name = 'contact-shadows';
  blobMesh.renderOrder = 1;
  group.add(blobMesh);
  // The board's own soft "ambient occlusion" skirt on the table.
  const skirt = new THREE.Mesh(new THREE.PlaneGeometry(15.4, 15.4).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ name: 'board-skirt', map: roundedShadowTexture(), color: '#140b05', transparent: true, opacity: 0.62, depthWrite: false, fog: false }));
  skirt.position.y = TABLE_Y + 0.004;
  skirt.renderOrder = 1;
  skirt.name = 'board-skirt';
  group.add(skirt);

  // Candle light pool on the table (additive).
  const poolMat = new THREE.MeshBasicMaterial({ name: 'candle-pool', map: blobTex, color: '#ffb35c', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: NUM.pool[0] });
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(11, 11).rotateX(-Math.PI / 2), poolMat);
  pool.position.set(CANDLE.x, TABLE_Y + 0.01, CANDLE.z);
  pool.renderOrder = 2;
  group.add(pool);

  // Steam over the mug: a few soft points (one draw call).
  const steam = buildSteam(blobTex);
  group.add(steam.points);

  // ---- dusk -------------------------------------------------------------------------------------
  let dusk = -1;
  const tmp = new THREE.Color();
  function setDusk(t) {
    t = Math.min(1, Math.max(0, Number(t) || 0));
    if (Math.abs(t - dusk) < 1e-4) return;
    dusk = t;
    const e = smoothstep(0, 1, t);
    const L = (k) => tmp.copy(cols[k][0]).lerp(cols[k][1], e);
    const N = (k) => NUM[k][0] + (NUM[k][1] - NUM[k][0]) * e;
    skyUniforms.uTop.value.copy(L('skyTop'));
    skyUniforms.uHorizon.value.copy(L('skyHorizon'));
    skyUniforms.uBottom.value.copy(L('skyBottom'));
    skyUniforms.uSun.value.copy(L('sun'));
    skyUniforms.uCloud.value.copy(L('cloud'));
    skyUniforms.uCloudShade.value.copy(L('cloudShade'));
    skyUniforms.uSunDir.value.set(-0.78, 0.1 - 0.08 * e, 0.62).normalize();
    scene.fog.color.copy(L('fog'));
    key.color.copy(L('key'));
    key.intensity = N('keyI');
    hemi.color.copy(L('hemiSky'));
    hemi.groundColor.copy(L('hemiGround'));
    hemi.intensity = N('hemiI');
    fill.color.copy(L('fill'));
    fill.intensity = N('fillI');
    scene.environmentIntensity = N('env');
    renderer.toneMappingExposure = N('exposure');
    glowMat.color.setScalar(N('glow'));
    poolMat.opacity = N('pool');
    band.uniforms.uTint.value.copy(L('bandTint'));
    band.uniforms.uLights.value = N('bandLights');
    band.uniforms.uHaze.value.copy(scene.fog.color);
  }
  setDusk(0);

  function setTier(t) {
    skyUniforms.uClouds.value = t.clouds ? 1 : 0;
    steam.setCount(t.density >= 0.5 ? steam.max : Math.ceil(steam.max / 2));
  }
  setTier(tier);

  /** Idle motion: steam curls up from the mug, clouds drift. Returns true (always alive). */
  function ambient(now) {
    const t = now / 1000;
    skyUniforms.uTime.value = t;
    steam.update(t);
    // The candle flickers a little.
    const base = NUM.pool[0] + (NUM.pool[1] - NUM.pool[0]) * smoothstep(0, 1, Math.max(0, dusk));
    poolMat.opacity = base * (0.88 + 0.08 * Math.sin(t * 13.1) + 0.05 * Math.sin(t * 29.7 + 1.3));
    return true;
  }

  /** Keeps the sky dome centred on the camera (call before each render). */
  function follow(camera) {
    sky.position.copy(camera.position);
  }

  return {
    group,
    key,
    hemi,
    fill,
    setDusk,
    get dusk() { return dusk; },
    setTier,
    ambient,
    follow,
  };
}

// ---- shaders ------------------------------------------------------------------------------------

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // on the far plane: behind everything
  gl_Position.z *= 0.9999;
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uBottom;
uniform vec3 uSun;
uniform vec3 uSunDir;
uniform vec3 uCloud;
uniform vec3 uCloudShade;
uniform float uClouds;
uniform float uTime;
varying vec3 vDir;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return v;
}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = h >= 0.0
    ? mix(uHorizon, uTop, pow(smoothstep(0.0, 0.62, h), 0.75))
    : mix(uHorizon, uBottom, smoothstep(0.0, 0.18, -h));
  float s = max(dot(d, uSunDir), 0.0);
  col += uSun * (pow(s, 6.0) * 0.38 + pow(s, 90.0) * 0.9);
  col += uSun * 0.1 * exp(-abs(h) * 16.0);
  if (uClouds > 0.5 && h > 0.0) {
    vec2 uv = d.xz / (h + 0.16) * 1.35 + vec2(uTime * 0.0045, uTime * 0.0017);
    float c = smoothstep(0.5, 0.8, fbm(uv));
    c *= smoothstep(0.03, 0.22, h) * (1.0 - smoothstep(0.55, 0.9, h));
    vec3 cc = mix(uCloudShade, uCloud, smoothstep(0.35, 0.85, fbm(uv * 1.7 + 3.1)));
    cc += uSun * pow(s, 3.0) * 0.35;
    col = mix(col, cc, c * 0.8);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const BAND_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const BAND_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform sampler2D uLightsMap;
uniform vec3 uTint;
uniform vec3 uHaze;
uniform float uLights;
varying vec2 vUv;
void main() {
  vec4 t = texture2D(uMap, vUv);
  if (t.a < 0.01) discard;
  vec3 c = t.rgb * uTint;
  // Aerial perspective: the far layers (painted lighter) drift toward the fog colour.
  c = mix(c, uHaze, 0.22);
  c += texture2D(uLightsMap, vUv).rgb * uLights;
  gl_FragColor = vec4(c, t.a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---- skyline band -------------------------------------------------------------------------------

function buildSkylineBand() {
  const W = 3072;
  const H = 512;
  const HORIZON = 0.66; // fraction of the height where the land meets the sky
  const { cv, g } = canvas(W, H);
  const { cv: lcv, g: lg } = canvas(W, H);
  lg.fillStyle = '#000';
  lg.fillRect(0, 0, W, H);
  const rnd = rng(4242);
  const hy = H * HORIZON;
  const layer = document.createElement('canvas');
  layer.width = W;
  layer.height = H;
  const lc = layer.getContext('2d');
  const blurOk = 'filter' in g;
  const paint = (fn, blur) => {
    lc.clearRect(0, 0, W, H);
    fn(lc);
    if (blurOk) g.filter = `blur(${blur}px)`;
    g.drawImage(layer, 0, 0);
    if (blurOk) g.filter = 'none';
  };
  // 1. Far hills.
  paint((c) => {
    c.fillStyle = '#b9a8c6';
    c.beginPath();
    c.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) {
      const y = hy - 26 - 18 * Math.sin(x * 0.0021) - 12 * Math.sin(x * 0.0057 + 1.3) - 6 * Math.sin(x * 0.017);
      c.lineTo(x, y);
    }
    c.lineTo(W, H);
    c.closePath();
    c.fill();
  }, 3);
  // 2. Far city (hazy) and 3. near city (darker, with lit windows).
  const towers = (c, color, n, hMin, hMax, wMin, wMax, base, windows) => {
    for (let k = 0; k < n; k++) {
      const x = rnd() * W;
      const w = wMin + rnd() * (wMax - wMin);
      // Taller towers cluster in the "downtown" part of the panorama (its middle = straight ahead).
      const centre = Math.exp(-(((x / W) - 0.5) ** 2) / 0.05);
      const h = hMin + (hMax - hMin) * rnd() * (0.45 + 0.55 * centre);
      c.fillStyle = color;
      c.fillRect(x, base - h, w, h + H);
      if (rnd() < 0.25) c.fillRect(x + w / 2 - 1, base - h - 14 - rnd() * 16, 2, 30); // antenna
      if (rnd() < 0.2) c.fillRect(x + w * 0.15, base - h - 6, w * 0.7, 6); // setback
      if (windows) {
        for (let wy = base - h + 5; wy < base - 4; wy += 7) {
          for (let wx = x + 3; wx < x + w - 3; wx += 6) {
            if (rnd() < 0.34) {
              lg.fillStyle = rnd() < 0.8 ? '#ffc86e' : '#fff0c8';
              lg.fillRect(wx, wy, 2.5, 3.5);
            }
          }
        }
      }
    }
  };
  paint((c) => towers(c, '#9a8fb0', 150, 20, 95, 14, 42, hy - 8, false), 2.2);
  paint((c) => towers(c, '#6a5f82', 90, 16, 120, 18, 50, hy + 4, true), 1.4);
  // 4. Trees and rooftops in front (below the railing line, mostly hidden).
  paint((c) => {
    c.fillStyle = '#4a4a45';
    c.fillRect(0, hy + 10, W, H);
    c.fillStyle = '#3f5040';
    for (let x = -20; x < W + 20; x += 14 + rnd() * 18) {
      const r = 10 + rnd() * 16;
      c.beginPath();
      c.arc(x, hy + 14 - rnd() * 8, r, 0, Math.PI * 2);
      c.fill();
    }
  }, 1.6);
  if (blurOk) {
    lg.filter = 'blur(1.2px)';
    lg.drawImage(lcv, 0, 0);
    lg.filter = 'none';
  }
  // Fade the ends of the panorama out (the house wall hides the gap behind the camera).
  g.globalCompositeOperation = 'destination-in';
  const fade = g.createLinearGradient(0, 0, W, 0);
  fade.addColorStop(0, 'rgba(0,0,0,0)');
  fade.addColorStop(0.06, 'rgba(0,0,0,1)');
  fade.addColorStop(0.94, 'rgba(0,0,0,1)');
  fade.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = fade;
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'source-over';

  const map = canvasTexture(cv);
  const lightsMap = canvasTexture(lcv);
  const uniforms = {
    uMap: { value: map },
    uLightsMap: { value: lightsMap },
    uTint: { value: new THREE.Color('#ffffff') },
    uHaze: { value: new THREE.Color('#efd2b8') },
    uLights: { value: 0 },
  };
  // 240° of panorama centred on -Z (straight ahead of the default camera). The band's land line
  // sits a little below the railing top as seen from the table.
  const thetaLen = (Math.PI * 4) / 3;
  const bandH = 96;
  const geo = new THREE.CylinderGeometry(BAND_R, BAND_R, bandH, 72, 1, true, Math.PI - thetaLen / 2, thetaLen);
  geo.translate(0, FLOOR_Y + 2 + bandH * (1 - HORIZON) - 16, 0);
  const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
    name: 'skyline',
    uniforms,
    vertexShader: BAND_VERT,
    fragmentShader: BAND_FRAG,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    fog: false,
  }));
  mesh.name = 'skyline';
  mesh.frustumCulled = false;
  return { mesh, uniforms };
}

// ---- table ----------------------------------------------------------------------------------------

function tableTopGeometry() {
  const bevel = 0.12;
  const depth = TABLE_T - 2 * 0.1;
  const geo = new THREE.ExtrudeGeometry(roundedRect(TABLE_W - 2 * bevel, TABLE_D - 2 * bevel, TABLE_R), {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.1,
    bevelSize: bevel,
    bevelSegments: 3,
    curveSegments: 10,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, TABLE_Y - depth - 0.1, 0);
  return geo;
}

/** Apron under the top and four turned legs (one geometry). */
function tableFrameGeometry() {
  const kit = new Kit();
  const y0 = TABLE_Y - TABLE_T;
  const aw = TABLE_W - 5;
  const ad = TABLE_D - 5;
  kit.add(new THREE.BoxGeometry(aw, 1.3, 0.5), { y: y0 - 0.65, z: ad / 2 });
  kit.add(new THREE.BoxGeometry(aw, 1.3, 0.5), { y: y0 - 0.65, z: -ad / 2 });
  kit.add(new THREE.BoxGeometry(0.5, 1.3, ad), { x: aw / 2, y: y0 - 0.65 });
  kit.add(new THREE.BoxGeometry(0.5, 1.3, ad), { x: -aw / 2, y: y0 - 0.65 });
  const legH = y0 - FLOOR_Y;
  const pts = [];
  const prof = [[0.55, 0], [0.62, 0.3], [0.4, 0.9], [0.34, 3.5], [0.5, 4.2], [0.3, 5], [0.42, 7.5], [0.62, 8.2], [0.62, legH - 1.4], [0.72, legH - 1.2], [0.72, legH]];
  for (const [r, y] of prof) pts.push(new THREE.Vector2(r, y));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      kit.add(new THREE.LatheGeometry(pts, 14), { x: sx * (aw / 2 - 0.2), y: FLOOR_Y, z: sz * (ad / 2 - 0.2) });
    }
  }
  return kit.build();
}

// ---- props ----------------------------------------------------------------------------------------

const CANDLE = { x: 11.6, z: -8.4 };
const MUG = { x: -12.2, z: 7.4 };
const NOTE_COLORS = ['#f6f2e6', '#f3c9d3', '#bfe0f5', '#c6e4ab', '#d9c7ee', '#f6e39c', '#f5bd8f'];
const GROUP_BANDS = ['#955436', '#aae0fa', '#d93a96', '#f7941d', '#ed1b24', '#fef200', '#1fb25a', '#0072bb'];

/** Table-top props. Parts go into the matte / gloss / glow kits; `blobs` collects contact shadows. */
function buildProps({ matte, gloss, glow, blobs }) {
  const y = TABLE_Y;
  const rnd = rng(77);

  // Bank tray (left of the board): a wooden tray, two rows of compartments with banknote stacks,
  // spare houses and hotels.
  {
    const cx = -10.6;
    const cz = 0.6;
    const W = 3.3; // along x
    const D = 6.6; // along z
    const wall = 0.14;
    const h = 0.5;
    const wood = '#9a6a42';
    matte.add(new THREE.BoxGeometry(W, 0.14, D), { x: cx, y: y + 0.07, z: cz, color: '#8a5c38' });
    for (const s of [-1, 1]) {
      matte.add(new THREE.BoxGeometry(W, h, wall), { x: cx, y: y + h / 2, z: cz + s * (D / 2 - wall / 2), color: wood });
      matte.add(new THREE.BoxGeometry(wall, h, D), { x: cx + s * (W / 2 - wall / 2), y: y + h / 2, z: cz, color: wood });
    }
    matte.add(new THREE.BoxGeometry(wall * 0.8, h * 0.8, D - wall), { x: cx, y: y + h * 0.4, z: cz, color: wood });
    const rows = 5;
    const cell = (D - wall) / rows;
    for (let r = 1; r < rows; r++) matte.add(new THREE.BoxGeometry(W - wall, h * 0.8, wall * 0.7), { x: cx, y: y + h * 0.4, z: cz - D / 2 + wall / 2 + r * cell, color: wood });
    let note = 0;
    for (let r = 0; r < rows; r++) {
      for (const side of [-1, 1]) {
        const x = cx + side * (W / 4);
        const z = cz - D / 2 + wall / 2 + (r + 0.5) * cell;
        if (r === rows - 1 && side === 1) {
          // Spare hotels.
          for (let k = 0; k < 4; k++) addHouse(matte, x - 0.3 + (k % 2) * 0.55, y + 0.14, z - 0.25 + Math.floor(k / 2) * 0.5, 0.5, 0.34, '#d62b2b', rnd() * 3);
          continue;
        }
        if (r === rows - 1 && side === -1) {
          // Spare houses.
          for (let k = 0; k < 7; k++) addHouse(matte, x - 0.4 + (k % 3) * 0.4, y + 0.14 + (k > 5 ? 0.2 : 0), z - 0.3 + Math.floor(k / 3) * 0.32, 0.26, 0.2, '#2e9e4f', rnd() * 3);
          continue;
        }
        const color = NOTE_COLORS[note++ % NOTE_COLORS.length];
        const stackH = 0.2 + rnd() * 0.18;
        matte.add(new THREE.BoxGeometry(1.25, stackH, cell - 0.34), { x, y: y + 0.14 + stackH / 2, z, color });
        for (let k = 0; k < 3; k++) {
          matte.add(new THREE.BoxGeometry(1.25, 0.02, cell - 0.34), { x: x + (rnd() - 0.5) * 0.12, y: y + 0.15 + stackH + k * 0.021, z: z + (rnd() - 0.5) * 0.1, ry: (rnd() - 0.5) * 0.25, color });
        }
      }
    }
    blobs.push({ x: cx, z: cz, w: W + 1.2, d: D + 1.2, a: 0.55 });
  }

  // A fan of title deeds (back-left).
  {
    const cx = -9.9;
    const cz = -7.2;
    for (let k = 0; k < 7; k++) {
      const a = -0.55 + k * 0.17;
      const m = new THREE.Matrix4().makeRotationY(a).setPosition(cx, y + 0.012 + k * 0.012, cz);
      const band = new THREE.Matrix4().makeTranslation(0, 0.012, -0.72).premultiply(m);
      matte.add(new THREE.BoxGeometry(1.7, 0.02, 2.3).translate(0, 0, -0.35), { matrix: m, color: '#fbf8ef' });
      matte.add(new THREE.BoxGeometry(1.5, 0.006, 0.42), { matrix: band, color: GROUP_BANDS[(k * 3) % GROUP_BANDS.length] });
    }
    blobs.push({ x: cx, z: cz - 0.3, w: 4.2, d: 3.4, a: 0.35 });
  }

  // Mug of cocoa (front-left).
  {
    const { x, z } = MUG;
    const prof = [[0, 0], [0.86, 0], [0.92, 0.06], [0.95, 1.9], [0.99, 2.0], [0.88, 2.0], [0.84, 0.3], [0, 0.3]].map(([r, h]) => new THREE.Vector2(r, h));
    gloss.add(new THREE.LatheGeometry(prof, 28), { x, y, z, color: '#e9e2d4' });
    gloss.add(new THREE.CylinderGeometry(0.957, 0.957, 0.28, 28, 1, true), { x, y: y + 1.35, z, color: '#c0392b' });
    gloss.add(new THREE.TorusGeometry(0.48, 0.12, 10, 20, Math.PI * 1.1), { x: x + 0.9, y: y + 1.05, z, rz: -Math.PI * 0.55, color: '#e9e2d4' });
    gloss.add(new THREE.CircleGeometry(0.84, 24).rotateX(-Math.PI / 2), { x, y: y + 1.72, z, color: '#4a2a18' });
    // Marshmallows.
    for (let k = 0; k < 3; k++) matte.add(new THREE.BoxGeometry(0.26, 0.2, 0.26), { x: x - 0.25 + k * 0.24, y: y + 1.78, z: z + (k - 1) * 0.2, ry: k, rx: 0.2, color: '#fbf6f0' });
    blobs.push({ x: x + 0.1, z, w: 2.6, d: 2.4, a: 0.5 });
  }

  // Notepad and pencil (right, in front).
  {
    const x = 10.6;
    const z = 4.2;
    const m = new THREE.Matrix4().makeRotationY(-0.28).setPosition(x, y, z);
    matte.add(new THREE.BoxGeometry(3, 0.16, 4).translate(0, 0.08, 0), { matrix: m, color: '#f7f5ee' });
    matte.add(new THREE.BoxGeometry(3.04, 0.2, 0.36).translate(0, 0.1, -1.84), { matrix: m, color: '#b73a3a' });
    // (the ruled lines are a decal: buildDecals)
    const p = new THREE.Matrix4().makeRotationY(0.5).setPosition(x + 1.9, y + 0.09, z + 0.3);
    const along = (geo, dx, color) => gloss.add(geo.rotateZ(Math.PI / 2).translate(dx, 0, 0), { matrix: p, color });
    along(new THREE.CylinderGeometry(0.09, 0.09, 3.6, 6), 0, '#f2c230');
    along(new THREE.CylinderGeometry(0.095, 0.095, 0.3, 10), 1.95, '#c8c8c8');
    along(new THREE.CylinderGeometry(0.09, 0.09, 0.3, 10), 2.25, '#ef8fa0');
    along(new THREE.CylinderGeometry(0.02, 0.09, 0.42, 10), -2.01, '#e8c9a0');
    along(new THREE.CylinderGeometry(0.004, 0.024, 0.1, 8), -2.25, '#333333');
    blobs.push({ x, z, w: 4.2, d: 5, a: 0.38 });
  }

  // Bowl of popcorn (right, behind).
  {
    const x = 12.2;
    const z = -2.8;
    const prof = [[0, 0], [0.8, 0], [0.9, 0.08], [1.6, 0.9], [1.75, 1.2], [1.62, 1.2], [1.48, 0.95], [0.8, 0.22], [0, 0.22]].map(([r, h]) => new THREE.Vector2(r, h));
    gloss.add(new THREE.LatheGeometry(prof, 30), { x, y, z, color: '#3d6f9e' });
    const rnd2 = rng(9);
    for (let k = 0; k < 46; k++) {
      const a = rnd2() * Math.PI * 2;
      const r = Math.sqrt(rnd2()) * 1.3;
      const hh = 0.95 + (1.3 - r) * 0.35 + rnd2() * 0.1;
      matte.add(new THREE.IcosahedronGeometry(0.17 + rnd2() * 0.07, 0), { x: x + Math.cos(a) * r, y: y + hh, z: z + Math.sin(a) * r, rx: rnd2() * 3, ry: rnd2() * 3, color: rnd2() < 0.7 ? '#fff4d2' : '#f4dc96' });
    }
    blobs.push({ x, z, w: 4.2, d: 4.2, a: 0.5 });
  }

  // Candle lantern (back-right): brass frame, glass, a glowing candle.
  {
    const { x, z } = CANDLE;
    gloss.add(new THREE.CylinderGeometry(0.8, 0.9, 0.2, 6), { x, y: y + 0.1, z, color: '#b8893a' });
    gloss.add(new THREE.CylinderGeometry(0.62, 0.8, 0.35, 6), { x, y: y + 2.55, z, color: '#b8893a' });
    gloss.add(new THREE.ConeGeometry(0.66, 0.6, 6), { x, y: y + 3.0, z, color: '#b8893a' });
    gloss.add(new THREE.TorusGeometry(0.22, 0.04, 6, 14), { x, y: y + 3.42, z, color: '#b8893a' });
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
      gloss.add(new THREE.BoxGeometry(0.07, 2.2, 0.07), { x: x + Math.cos(a) * 0.72, y: y + 1.3, z: z + Math.sin(a) * 0.72, color: '#9c7430' });
    }
    matte.add(new THREE.CylinderGeometry(0.26, 0.26, 0.9, 14), { x, y: y + 0.65, z, color: '#f4ecd8' });
    glow.add(new THREE.SphereGeometry(0.12, 10, 8).scale(1, 1.8, 1), { x, y: y + 1.3, z, color: '#ffc27a' });
    glow.add(new THREE.CylinderGeometry(0.6, 0.72, 2.1, 6, 1, true), { x, y: y + 1.35, z, color: '#6b4a2a' });
    blobs.push({ x, z, w: 2.6, d: 2.6, a: 0.45 });
  }

  // Potted plant (right, front corner).
  {
    const x = 13.3;
    const z = 9.2;
    const prof = [[0, 0], [0.9, 0], [1.05, 0.15], [1.25, 1.5], [1.38, 1.6], [1.38, 1.85], [1.2, 1.85], [0, 1.7]].map(([r, h]) => new THREE.Vector2(r, h));
    matte.add(new THREE.LatheGeometry(prof, 24), { x, y, z, color: '#c46a3e' });
    matte.add(new THREE.CircleGeometry(1.2, 20).rotateX(-Math.PI / 2), { x, y: y + 1.72, z, color: '#4a3222' });
    const rnd3 = rng(31);
    for (let k = 0; k < 11; k++) {
      const a = (k / 11) * Math.PI * 2 + rnd3() * 0.4;
      const tilt = 0.5 + rnd3() * 0.5;
      const len = 1.4 + rnd3() * 0.9;
      const m = new THREE.Matrix4()
        .makeTranslation(0, 0, len * 0.55)
        .premultiply(new THREE.Matrix4().makeRotationX(-tilt))
        .premultiply(new THREE.Matrix4().makeRotationY(a))
        .premultiply(new THREE.Matrix4().makeTranslation(x, y + 1.9, z));
      const leaf = new THREE.SphereGeometry(1, 10, 6).scale(0.42, 0.05, len * 0.55);
      matte.add(leaf, { matrix: m, color: ['#3f8f4a', '#2f7a3c', '#58a85e'][k % 3] });
    }
    blobs.push({ x, z, w: 3.4, d: 3.4, a: 0.5 });
  }
}

/** A little house / hotel (pentagon prism) for the bank tray. */
function addHouse(kit, x, y, z, w, h, color, ry) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(w / 2, h * 0.62);
  s.lineTo(0, h);
  s.lineTo(-w / 2, h * 0.62);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: Math.min(0.26, w * 0.7), bevelEnabled: false });
  geo.translate(0, 0, -Math.min(0.26, w * 0.7) / 2);
  kit.add(geo, { x, y, z, ry, color });
}

/** Textured decals on props: the game box lid and the notepad's ruled lines (one mesh, one atlas). */
function buildDecals(aniso) {
  const { cv, g } = canvas(1024, 1024);
  // Top half: the box lid (navy, gold pinstripes, a gold skyline medallion).
  g.fillStyle = '#1d3557';
  g.fillRect(0, 0, 1024, 640);
  g.strokeStyle = '#d8b25a';
  g.lineWidth = 10;
  g.strokeRect(26, 26, 972, 588);
  g.lineWidth = 3;
  g.strokeRect(46, 46, 932, 548);
  g.fillStyle = '#d8b25a';
  g.beginPath();
  g.arc(512, 300, 150, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#1d3557';
  const sky = [[-100, 60], [-70, 110], [-40, 80], [-10, 150], [20, 95], [50, 125], [80, 70]];
  for (const [dx, h] of sky) g.fillRect(512 + dx, 390 - h, 26, h);
  g.fillRect(412, 385, 200, 20);
  g.fillStyle = '#d8b25a';
  g.font = '800 58px Georgia, "Times New Roman", serif';
  g.textAlign = 'center';
  g.fillText('BUY  ·  BUILD  ·  TRADE', 512, 540);
  // Bottom part: ruled notepad paper with a few pencilled scores.
  g.fillStyle = '#f9f7f0';
  g.fillRect(0, 640, 1024, 384);
  g.strokeStyle = '#9cc3e6';
  g.lineWidth = 3;
  for (let yy = 690; yy < 1024; yy += 34) {
    g.beginPath();
    g.moveTo(20, yy);
    g.lineTo(1004, yy);
    g.stroke();
  }
  g.strokeStyle = '#e39a9a';
  g.beginPath();
  g.moveTo(150, 650);
  g.lineTo(150, 1024);
  g.stroke();
  g.fillStyle = '#5b5b66';
  g.font = 'italic 600 30px "Segoe Print", "Comic Sans MS", cursive';
  g.textAlign = 'left';
  ['Anna   $1,500', 'Ben    $1,240', 'Cleo   $1,780', 'Dev      $960'].forEach((t, k) => g.fillText(t, 180, 718 + k * 68));
  const tex = canvasTexture(cv, { aniso });
  const pos = [];
  const uv = [];
  const quad = (m, w, d, u0, v0, u1, v1) => {
    const p = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, z]) => new THREE.Vector3(x, 0, z).applyMatrix4(m));
    const t = [[u0, v1], [u1, v1], [u1, v0], [u0, v0]];
    for (const k of [0, 3, 2, 0, 2, 1]) {
      pos.push(p[k].x, p[k].y, p[k].z);
      uv.push(t[k][0], t[k][1]);
    }
  };
  // Box lid on the far table, a bit askew. (v runs bottom → top in three's UV space.)
  const lid = new THREE.Matrix4().makeRotationY(0.14).setPosition(-8.2, TABLE_Y + 0.62, -10.6);
  quad(lid, 7.6, 4.75, 0, 1 - 640 / 1024, 1, 1);
  // Notepad page.
  const pad = new THREE.Matrix4().makeRotationY(-0.28).setPosition(10.6, TABLE_Y + 0.165, 4.35);
  quad(pad, 2.9, 3.4, 0, 0, 1, 384 / 1024);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  const grp = new THREE.Group();
  const mesh = new THREE.Mesh(geo, nearFade(new THREE.MeshStandardMaterial({ name: 'decals', map: tex, roughness: 0.7 })));
  mesh.name = 'decals';
  grp.add(mesh);
  // The lid's body (sides) under the decal.
  const body = new THREE.Mesh(new THREE.BoxGeometry(7.6, 0.6, 4.75), nearFade(new THREE.MeshStandardMaterial({ name: 'box-lid', color: '#1d3557', roughness: 0.6 })));
  body.position.set(-8.2, TABLE_Y + 0.31, -10.6);
  body.rotation.y = 0.14;
  grp.add(body);
  return grp;
}

// ---- terrace --------------------------------------------------------------------------------------

/** Railing with string lights and planters on three sides, the house wall on the fourth. */
function buildTerrace({ matte, glow }) {
  const F = FLOOR_Y;
  const RZ = TERRACE.rail;
  const RX = TERRACE.x;
  const HZ = TERRACE.house;
  const railH = 9;
  const white = '#efe4d2';
  const rnd = rng(1234);
  const posts = [];
  const railRun = (x0, z0, x1, z1) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const ang = Math.atan2(-(z1 - z0), x1 - x0);
    const mx = (x0 + x1) / 2;
    const mz = (z0 + z1) / 2;
    matte.add(new THREE.BoxGeometry(len, 0.5, 0.9), { x: mx, y: F + railH, z: mz, ry: ang, color: white });
    matte.add(new THREE.BoxGeometry(len, 0.35, 0.5), { x: mx, y: F + 1.2, z: mz, ry: ang, color: white });
    const n = Math.floor(len / 1.6);
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      matte.add(new THREE.BoxGeometry(0.28, railH - 1.2, 0.28), { x: x0 + (x1 - x0) * t, y: F + 1.2 + (railH - 1.2) / 2, z: z0 + (z1 - z0) * t, color: white });
    }
    const np = Math.round(len / 9);
    for (let k = 0; k <= np; k++) {
      const t = k / np;
      posts.push([x0 + (x1 - x0) * t, z0 + (z1 - z0) * t]);
    }
  };
  railRun(-RX, RZ, RX, RZ);
  railRun(-RX, RZ, -RX, HZ - 2);
  railRun(RX, RZ, RX, HZ - 2);
  const uniq = [];
  for (const p of posts) if (!uniq.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1)) uniq.push(p);
  for (const [x, z] of uniq) {
    matte.add(new THREE.BoxGeometry(0.8, railH + 4.5, 0.8), { x, y: F + (railH + 4.5) / 2, z, color: '#e6d9c4' });
    matte.add(new THREE.BoxGeometry(1.1, 0.3, 1.1), { x, y: F + railH + 4.6, z, color: '#e6d9c4' });
  }
  // String lights: catenaries between the tall posts, bulbs every ~1.6 units.
  const byLine = (a, b) => (a[0] - b[0]) || (a[1] - b[1]);
  const lines = [
    uniq.filter((p) => Math.abs(p[1] - RZ) < 1).sort(byLine),
    uniq.filter((p) => Math.abs(p[0] + RX) < 1).sort((a, b) => a[1] - b[1]),
    uniq.filter((p) => Math.abs(p[0] - RX) < 1).sort((a, b) => a[1] - b[1]),
  ];
  const topY = F + railH + 4.4;
  for (const line of lines) {
    for (let k = 0; k + 1 < line.length; k++) {
      const [x0, z0] = line[k];
      const [x1, z1] = line[k + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.max(3, Math.round(len / 1.6));
      let px = x0;
      let py = topY;
      let pz = z0;
      for (let j = 1; j <= n; j++) {
        const t = j / n;
        const x = x0 + (x1 - x0) * t;
        const z = z0 + (z1 - z0) * t;
        const yy = topY - Math.sin(Math.PI * t) * 1.6;
        const seg = Math.hypot(x - px, yy - py, z - pz);
        const mid = new THREE.Vector3((x + px) / 2, (yy + py) / 2, (z + pz) / 2);
        const dir = new THREE.Vector3(x - px, yy - py, z - pz).normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        matte.add(new THREE.CylinderGeometry(0.035, 0.035, seg, 4), { matrix: new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1)), color: '#2a2622' });
        if (j < n) glow.add(new THREE.IcosahedronGeometry(0.2, 1), { x, y: yy - 0.26, z, color: rnd() < 0.5 ? '#ffd28a' : '#ffc070' });
        px = x;
        py = yy;
        pz = z;
      }
    }
  }
  // Planters with round shrubs along the railing.
  const planter = (x, z, s = 1) => {
    matte.add(new THREE.BoxGeometry(3.2 * s, 2.6 * s, 3.2 * s), { x, y: F + 1.3 * s, z, color: '#8b5a3c' });
    for (let k = 0; k < 4; k++) {
      matte.add(new THREE.IcosahedronGeometry((1.4 + rnd() * 0.6) * s, 1), { x: x + (rnd() - 0.5) * 1.6 * s, y: F + (3 + rnd() * 1.4) * s, z: z + (rnd() - 0.5) * 1.6 * s, color: rnd() < 0.5 ? '#4f8a45' : '#3e7a3c' });
    }
  };
  for (let x = -48; x <= 48; x += 24) planter(x + 6, RZ + 3);
  for (let z = -36; z <= 30; z += 22) {
    planter(-RX + 3, z);
    planter(RX - 3, z);
  }
  // House wall with a big warm window, a door and two sconces.
  matte.add(new THREE.BoxGeometry(2 * RX + 4, 46, 1), { x: 0, y: F + 23, z: HZ + 0.5, color: '#e8d6bd' });
  matte.add(new THREE.BoxGeometry(2 * RX + 4, 1.2, 1.6), { x: 0, y: F + 0.6, z: HZ, color: '#b99f82' });
  const win = { x: 12, y: F + 13, w: 20, h: 13 };
  glow.add(new THREE.PlaneGeometry(win.w, win.h).rotateY(Math.PI), { x: win.x, y: win.y, z: HZ - 0.05, color: '#ffcf8f' });
  const frameC = '#f4efe6';
  matte.add(new THREE.BoxGeometry(win.w + 1.4, 0.8, 0.9), { x: win.x, y: win.y - win.h / 2 - 0.2, z: HZ - 0.4, color: frameC });
  matte.add(new THREE.BoxGeometry(win.w + 1.4, 0.7, 0.6), { x: win.x, y: win.y + win.h / 2 + 0.2, z: HZ - 0.3, color: frameC });
  for (let k = 0; k <= 4; k++) matte.add(new THREE.BoxGeometry(0.35, win.h, 0.5), { x: win.x - win.w / 2 + (k * win.w) / 4, y: win.y, z: HZ - 0.3, color: frameC });
  matte.add(new THREE.BoxGeometry(win.w, 0.3, 0.5), { x: win.x, y: win.y + 1.5, z: HZ - 0.3, color: frameC });
  matte.add(new THREE.BoxGeometry(7, 15, 0.7), { x: -16, y: F + 7.5, z: HZ - 0.2, color: '#6e4127' });
  matte.add(new THREE.BoxGeometry(8.2, 0.8, 1), { x: -16, y: F + 15.4, z: HZ - 0.4, color: frameC });
  glow.add(new THREE.SphereGeometry(0.25, 8, 6), { x: -13.6, y: F + 7.2, z: HZ - 0.7, color: '#d8b25a' }); // door knob
  for (const sx of [-22, -10]) {
    matte.add(new THREE.BoxGeometry(0.9, 1.6, 0.6), { x: sx, y: F + 12, z: HZ - 0.3, color: '#2c2a28' });
    glow.add(new THREE.SphereGeometry(0.55, 10, 8), { x: sx, y: F + 13.2, z: HZ - 0.9, color: '#ffd9a0' });
  }
  // A bench and a big pot by the door.
  matte.add(new THREE.BoxGeometry(12, 0.6, 3), { x: 34, y: F + 3.4, z: HZ - 3, color: '#8a5a3a' });
  for (const bx of [29, 39]) matte.add(new THREE.BoxGeometry(0.7, 3.2, 2.6), { x: bx, y: F + 1.6, z: HZ - 3, color: '#6d4429' });
  planter(-26, HZ - 4, 1.1);
}

// ---- blobs (contact shadows) --------------------------------------------------------------------

function blobGeometry(blobs) {
  const all = [
    ...blobs,
    // Under the table on the deck, and the table's legs.
    { x: 0, z: 0, w: TABLE_W + 8, d: TABLE_D + 8, a: 0.55, y: FLOOR_Y + 0.08 },
  ];
  const pos = [];
  const uv = [];
  const col = [];
  for (const b of all) {
    const y = (b.y ?? TABLE_Y) + 0.006;
    // Nudged away from the key light (front-left), so the shadows read as cast, not painted.
    const cx = b.x + b.w * 0.07;
    const cz = b.z - b.d * 0.05;
    const p = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => [cx + (sx * b.w) / 2, y, cz + (sz * b.d) / 2]);
    const t = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (const k of [0, 3, 2, 0, 2, 1]) {
      pos.push(...p[k]);
      uv.push(...t[k]);
      col.push(1, 1, 1, b.a);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  return geo;
}

/** A round contact shadow: solid under the object, fading out over its outer half. */
function contactTexture() {
  const S = 128;
  const { cv, g } = canvas(S);
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  for (let k = 0; k <= 10; k++) {
    const t = k / 10;
    grad.addColorStop(t, `rgba(255,255,255,${1 - smoothstep(0.42, 1, t)})`);
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A soft rounded-square shadow (dark in the middle, fading over the outer ~12%). */
function roundedShadowTexture() {
  const S = 256;
  const { cv, g } = canvas(S);
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = Math.abs((x + 0.5) / S - 0.5) * 2;
      const v = Math.abs((y + 0.5) / S - 0.5) * 2;
      const a = 1 - smoothstep(0.35, 1, Math.pow(u ** 8 + v ** 8, 1 / 8)); // squircle distance
      const k = (y * S + x) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = 255;
      img.data[k + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---- steam --------------------------------------------------------------------------------------

function buildSteam(tex) {
  const max = 14;
  const pos = new Float32Array(max * 3);
  const col = new Float32Array(max * 4);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
  const mat = new THREE.PointsMaterial({ name: 'steam', map: tex, size: 1.1, sizeAttenuation: true, transparent: true, depthWrite: false, vertexColors: true });
  const points = new THREE.Points(geo, mat);
  points.name = 'steam';
  points.frustumCulled = false;
  const seeds = Array.from({ length: max }, (_, k) => ({ phase: k / max, sway: 0.6 + (k % 5) * 0.17 }));
  let count = max;
  function update(t) {
    for (let k = 0; k < count; k++) {
      const s = seeds[k];
      const p = (t / 3.2 + s.phase) % 1;
      pos[k * 3] = MUG.x + Math.sin(t * s.sway + k) * 0.25 * p;
      pos[k * 3 + 1] = TABLE_Y + 1.9 + p * 2.6;
      pos[k * 3 + 2] = MUG.z + Math.cos(t * 0.7 * s.sway + k) * 0.2 * p;
      col[k * 4] = col[k * 4 + 1] = col[k * 4 + 2] = 1;
      col[k * 4 + 3] = 0.28 * Math.sin(Math.PI * p) * (1 - p * 0.5);
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }
  update(0);
  return {
    points,
    max,
    update,
    setCount(n) {
      count = Math.max(0, Math.min(max, n));
      geo.setDrawRange(0, count);
    },
  };
}

// ---- canvases ---------------------------------------------------------------------------------------

/** Walnut planks along x with wavy grain. */
function woodCanvas(size) {
  const { cv, g } = canvas(size);
  const grad = g.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, '#6a4124');
  grad.addColorStop(0.5, '#734828');
  grad.addColorStop(1, '#663e22');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const rnd = rng(7);
  const planks = 4;
  for (let p = 0; p < planks; p++) {
    g.fillStyle = `rgba(${rnd() < 0.5 ? '20,10,4' : '255,220,180'},${0.03 + rnd() * 0.05})`;
    g.fillRect(0, (p * size) / planks, size, size / planks);
    g.fillStyle = 'rgba(25,12,5,0.45)';
    g.fillRect(0, (p * size) / planks, size, 2);
  }
  for (let k = 0; k < 520; k++) {
    const y0 = rnd() * size;
    const amp = 2 + rnd() * 7;
    const freq = 0.004 + rnd() * 0.01;
    const phase = rnd() * 10;
    g.strokeStyle = rnd() < 0.6 ? `rgba(40,20,8,${0.05 + rnd() * 0.12})` : `rgba(255,214,168,${0.03 + rnd() * 0.06})`;
    g.lineWidth = 0.6 + rnd() * 1.8;
    g.beginPath();
    for (let x = 0; x <= size; x += 16) {
      const y = y0 + Math.sin(x * freq + phase) * amp;
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  return cv;
}

/** Weathered deck boards. */
function deckCanvas(size) {
  const { cv, g } = canvas(size);
  g.fillStyle = '#9b7a5c';
  g.fillRect(0, 0, size, size);
  const rnd = rng(55);
  const boards = 4;
  const bw = size / boards;
  for (let b = 0; b < boards; b++) {
    const tone = 0.9 + rnd() * 0.2;
    g.fillStyle = `rgb(${Math.round(160 * tone)},${Math.round(126 * tone)},${Math.round(94 * tone)})`;
    g.fillRect(b * bw + 3, 0, bw - 6, size);
    g.fillStyle = 'rgba(40,25,15,0.55)';
    g.fillRect(b * bw, 0, 3, size);
    const cut = rnd() * size;
    g.fillRect(b * bw, cut, bw, 3);
    for (let k = 0; k < 40; k++) {
      g.fillStyle = `rgba(${rnd() < 0.5 ? '60,40,25' : '220,190,150'},${0.05 + rnd() * 0.08})`;
      g.fillRect(b * bw + 4 + rnd() * (bw - 8), rnd() * size, 1 + rnd() * 2, 20 + rnd() * 90);
    }
  }
  return cv;
}

/** A warm woven rug with a patterned border. */
function rugCanvas(size) {
  const { cv, g } = canvas(size, Math.round(size * (44 / 58)));
  const W = cv.width;
  const H = cv.height;
  g.fillStyle = '#a4453a';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#e9d3b0';
  g.fillRect(40, 40, W - 80, H - 80);
  g.fillStyle = '#b8563f';
  g.fillRect(64, 64, W - 128, H - 128);
  g.strokeStyle = '#e9d3b0';
  g.lineWidth = 6;
  for (let x = 90; x < W - 90; x += 44) {
    for (const y of [52, H - 52]) {
      g.beginPath();
      g.moveTo(x, y - 8);
      g.lineTo(x + 12, y);
      g.lineTo(x, y + 8);
      g.stroke();
    }
  }
  g.fillStyle = 'rgba(40,30,60,0.35)';
  g.beginPath();
  g.ellipse(W / 2, H / 2, W * 0.28, H * 0.26, 0, 0, Math.PI * 2);
  g.fill();
  const rnd = rng(3);
  for (let k = 0; k < 9000; k++) {
    g.fillStyle = `rgba(${rnd() < 0.5 ? '0,0,0' : '255,240,220'},${0.04 + rnd() * 0.05})`;
    g.fillRect(rnd() * W, rnd() * H, 2, 2);
  }
  return cv;
}

function remapUV(geo, w, h) {
  const uv = geo.attributes.uv;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) / w + 0.5, uv.getY(k) / h + 0.5);
  uv.needsUpdate = true;
}
