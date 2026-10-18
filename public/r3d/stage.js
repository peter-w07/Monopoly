// public/r3d/stage.js — WebGL renderer, scene, camera and render loop of Loop City (city design §9,
// §13, §15, §17.4): the world (world-city.js), quality tiers, the world bus, the time of day, the
// weather, the map view, the shot-fitted shadow map, fog, near/far, optional bloom, and a HUD pass
// (the dice on the glass) drawn over every frame.
//
// The loop renders on demand: a frame is drawn only when something asked for it (invalidate) or
// while animations / camera moves / a sky or weather transition are running. Idle costs nothing.
//
// Shadows: ONE directional shadow map fitted to the current shot (setShadowFocus), texel-snapped in
// light space so it never shimmers, re-rendered only when the shot changes, the snapped centre moves
// more than 1/8 of the box, the sun steps, or a caster moved (markShadows). Nothing ambient casts.
//
// Quality (world-quality.js): setQuality('auto'|'low'|'medium'|'high') sets the pixel-ratio cap,
// the shadow map (none on low), the far plane and fog, and bloom on 'high'. 'auto' resolves by device
// and steps down a tier when GPU timer samples (taken only after 2 s of continuous animation) have a
// median above 16 ms.

import * as THREE from './three.js';
import { createWorld } from './world-city.js';
import { createPost } from './world-post.js';
import { resolveTier, savedQuality, worldBus, QUALITY_NAMES, WEATHER_KINDS } from './world-quality.js';
import { smoothstep } from './world-geo.js';

const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const REDUCED_MOTION = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const RENDER_SOON_MS = 120; // renderSoon(): draw directly if no animation frame came by then
const GPU_MAX_MS = 16; // 'auto' steps down when the median GPU frame time is above this…
const GPU_SAMPLES = 7; // …over this many samples…
const GPU_EVERY = 8; // …one every this many drawn frames…
const GPU_WARM_MS = 2000; // …taken only after this much continuous animation (GPU clock ramp-up)
const FPS_MIN = 30; // fallback without the timer extension: average frame rate while animating
const FPS_WINDOW = 120;
const FPS_COOLDOWN_MS = 8000;
const TIER_ORDER = ['low', 'medium', 'high'];
const WEATHER_FADE_S = 20; // weather crossfade
const DAY_RATE = 0.35; // phase units / s when setDayPhase is given no duration
const ENV_STEP = 0.05; // regenerate the sky reflections when the phase moved this much
const DEFAULT_FOCUS = { x: 0, z: 0, radius: 230 }; // heli: the whole lot ring
const WEATHER = {
  clear: { rain: 0, snow: 0, wet: 0, cloud: 0 },
  overcast: { rain: 0, snow: 0, wet: 0, cloud: 1 },
  rain: { rain: 1, snow: 0, wet: 1, cloud: 1 },
  storm: { rain: 1, snow: 0, wet: 1, cloud: 1 },
  snow: { rain: 0, snow: 1, wet: 0, cloud: 0.8 },
};

/**
 * Creates the stage inside `host` (the .r3d root). Throws if WebGL can't be created.
 * @param {HTMLElement} host
 * @param {object} hooks
 * @param {(dt:number, now:number) => boolean} hooks.onFrame  advance animations; return true to keep animating
 * @param {(now:number) => boolean} [hooks.onAmbient]           idle effects; return true to keep ticking
 * @param {() => void} [hooks.onResize]
 * @param {() => void} [hooks.onContextLost]
 * @param {'auto'|'low'|'medium'|'high'} [hooks.quality]      initial quality (default: the saved setting)
 * @param {object} [hooks.BOARD]                                /api/board (street names, group colours)
 */
export function createStage(host, { onFrame, onAmbient, onResize, onContextLost, quality, BOARD = null } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping; // keeps the colour-group colours true
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.type = THREE.PCFShadowMap; // soft since r182
  renderer.shadowMap.autoUpdate = false; // re-rendered only on the §15.2 conditions
  renderer.shadowMap.needsUpdate = true;
  const canvas = renderer.domElement;
  canvas.className = 'r3d-canvas';
  canvas.setAttribute('aria-label', '3D city');
  host.prepend(canvas);

  // Quality: resolved before anything else is built, so every layer reads it at construction.
  const bus = worldBus(renderer);
  let requested = QUALITY_NAMES.includes(quality) ? quality : savedQuality();
  let tier = resolveTier(requested, renderer);
  bus.tier = tier;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier.dpr));
  renderer.shadowMap.enabled = tier.shadowMap > 0;

  const scene = new THREE.Scene();
  scene.name = 'city';
  scene.fog = new THREE.Fog('#c9d6df', 800, 3000);

  const camera = new THREE.PerspectiveCamera(30, 1, 1, tier.far);
  // The helicopter seat: south-west, high, looking north-east (SEAT_YAW, pitch 58°, ~600 m).
  camera.position.set(-225, 509, 225);

  // ---- the world ----------------------------------------------------------------------------------
  let world = null;
  try {
    world = createWorld(renderer, scene, { tier, bus, BOARD });
  } catch (err) {
    console.error('[renderer3d] world failed:', err);
    world = null;
  }
  // The sun / moon (the shadow caster's light) and the sky light: the world's, or a plain pair.
  let sun = world?.sun ?? null;
  if (!sun) {
    sun = new THREE.DirectionalLight('#fff1dc', 2.4);
    sun.position.set(-300, 400, 250);
    scene.add(sun, sun.target, new THREE.HemisphereLight('#dfeaf5', '#5a5040', 0.9));
  }
  sun.castShadow = tier.shadowMap > 0;
  sun.shadow.bias = -0.00025;

  // ---- reflections: PMREM of the world's sky dome (medium/high), a studio room on low -----------
  let pmrem = null;
  let envRT = null;
  let envPhase = NaN;
  let envWeather = '';
  function updateEnvironment(force = false) {
    const sky = tier.name === 'low' ? null : world?.skyScene ?? null;
    if (!sky) {
      if (envRT && envPhase === -99 && !force) return;
      if (envRT && envPhase === -99) return; // the room never changes
      replaceEnv(() => {
        const room = new THREE.RoomEnvironment();
        const rt = pmremGen().fromScene(room, 0.04);
        room.dispose();
        return rt;
      });
      envPhase = -99;
      return;
    }
    const kind = bus.weather.kind;
    if (!force && Math.abs(bus.dayPhase - envPhase) < ENV_STEP && kind === envWeather) return;
    envPhase = bus.dayPhase;
    envWeather = kind;
    replaceEnv(() => pmremGen().fromScene(sky, 0.02, 1, 4000, { size: 128 }));
  }
  function pmremGen() {
    if (!pmrem) pmrem = new THREE.PMREMGenerator(renderer);
    return pmrem;
  }
  function replaceEnv(make) {
    try {
      const rt = make();
      scene.environment = rt.texture;
      envRT?.dispose();
      envRT = rt;
    } catch (err) {
      console.error('[renderer3d] environment failed:', err);
    }
  }

  // ---- controls (metres, §9) ----------------------------------------------------------------------
  const controls = new THREE.OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 3;
  controls.maxDistance = 1500;
  controls.minPolarAngle = 0.05;
  controls.maxPolarAngle = 1.45;
  controls.maxTargetRadius = 600;
  controls.screenSpacePanning = false;
  controls.zoomToCursor = true;
  controls.target.set(0, 0, 0);
  // Phones: one finger must keep scrolling the page (the board is full width there). Orbiting is
  // switched on explicitly with the overlay's "free look" button (setFreeLook).
  const touchFirst = COARSE;
  setFreeLook(!touchFirst);

  // ---- loop state ---------------------------------------------------------------------------------
  let frame = 0;
  let ambientTimer = 0;
  let last = 0;
  let disposed = false;
  let userDragging = false;
  let lastDrawAt = 0;
  let soonTimer = 0;
  let hold = false; // warming up (shaders compiling in the background): draw nothing yet
  let post = null; // bloom (high tier only)
  let hudPass = null;
  let autoClip = true;
  const size = { w: 0, h: 0 };
  const fps = { sum: 0, n: 0, lastDrop: 0, prevBusy: false, frames: 0, queries: [], samples: [], recent: [], busySince: 0 };
  let timerExt = null;
  try {
    timerExt = renderer.getContext().getExtension('EXT_disjoint_timer_query_webgl2');
  } catch { /* not available */ }
  const frameStats = { calls: 0, triangles: 0, points: 0, shadowCalls: 0 };
  const shadow = {
    want: { ...DEFAULT_FOCUS }, // requested focus
    box: null, // applied { x, z, radius }
    frozen: false,
    dirty: true, // re-render on the next frame
    pendingWhileFrozen: false,
    renders: 0, // shadow-map renders so far (debug / tests)
  };
  const day = { value: bus.dayPhase, from: bus.dayPhase, to: bus.dayPhase, t: 0, dur: 0, held: false };
  const mapK = { value: 0, from: 0, to: 0, t: 0, dur: 0 };
  const weather = { kind: null, from: { ...WEATHER.clear }, to: { ...WEATHER.clear }, t: 1, dur: 0, lightningAt: 0, flash: 0 };

  controls.addEventListener('start', () => { userDragging = true; invalidate(); });
  controls.addEventListener('end', () => { userDragging = false; invalidate(); });
  controls.addEventListener('change', () => invalidate());

  // Count the shadow pass separately (stats().shadowCalls) and how often it runs.
  const shadowMapRender = renderer.shadowMap.render;
  if (typeof shadowMapRender === 'function') {
    renderer.shadowMap.render = function render(lights, s, c) {
      const pending = renderer.shadowMap.enabled && renderer.shadowMap.needsUpdate && lights?.length > 0;
      const c0 = renderer.info.render.calls;
      shadowMapRender.call(this, lights, s, c);
      if (pending) {
        shadow.renders += 1;
        frameStats.shadowCalls = renderer.info.render.calls - c0;
      }
    };
  }

  // Legacy: the tabletop city asked for a dusk level (0..1) on 'duskTarget'.
  const offDusk = bus.on('duskTarget', (v) => {
    const value = typeof v === 'object' && v ? v.value : v;
    if (!Number.isFinite(value) || day.held) return;
    setDayPhase(0.35 + 0.65 * Math.min(1, Math.max(0, value)), { instant: !!v?.instant });
  });

  // ---- time of day ------------------------------------------------------------------------------

  function lightsFor(p) {
    return Math.max(smoothstep(0.75, 1.0, p), 1 - smoothstep(-0.22, 0.02, p));
  }

  /** Applies a phase now: world sky + lights, bus, uniforms, reflections. */
  function applyDay(p) {
    day.value = p;
    bus.dayPhase = p;
    bus.uniforms.uDay.value = p;
    const lights = lightsFor(p);
    bus.lights = lights;
    bus.uniforms.uLights.value = lights;
    bus.dusk = Math.min(1, Math.max(0, (p - 0.35) / 0.65));
    let stepped = false;
    try {
      stepped = !!world?.setDayPhase(p);
    } catch (err) {
      console.error('[renderer3d] setDayPhase failed:', err);
    }
    if (stepped) refitShadow(true);
    bus.emit('dayPhase', p);
    bus.emit('dusk', bus.dusk);
    if (tier.name !== 'low') updateEnvironment();
  }

  /**
   * Eases the time of day toward `phase` (−0.3 dawn … 0 morning … 0.35 afternoon … 0.7 golden hour
   * … 1.0 blue hour … 1.2 night). { duration } seconds (default: by distance), { instant } snaps,
   * { hold } pins it (later calls without hold are ignored until setDayPhase(null)).
   */
  function setDayPhase(phase, { duration, instant = false, hold: pin = false } = {}) {
    try {
      if (phase === null || phase === undefined) {
        day.held = false;
        return;
      }
      const p = Number(phase);
      if (!Number.isFinite(p)) return;
      if (day.held && !pin) return;
      day.held = !!pin;
      const target = Math.min(1.2, Math.max(-0.3, p));
      const d = Math.abs(target - day.value);
      const dur = instant ? 0 : Number.isFinite(duration) ? Math.max(0, duration) : Math.min(4, d / DAY_RATE);
      if (dur <= 0 || d < 1e-4) {
        day.dur = 0;
        day.to = target;
        applyDay(target);
        invalidate();
        return;
      }
      day.from = day.value;
      day.to = target;
      day.t = 0;
      day.dur = dur;
      invalidate();
    } catch (err) {
      console.error('[renderer3d] setDayPhase failed:', err);
    }
  }

  // ---- map view -------------------------------------------------------------------------------

  function applyMap(k) {
    mapK.value = k;
    bus.mapMode = k;
    bus.uniforms.uMapMode.value = k;
    try {
      world?.setMapMode(k);
    } catch (err) {
      console.error('[renderer3d] setMapMode failed:', err);
    }
    bus.emit('mapMode', k);
  }

  /** 0 (street) … 1 (map view: bays glow, the city desaturates). Eased over { duration } s. */
  function setMapMode(k, { duration = 0.45 } = {}) {
    try {
      const target = Math.min(1, Math.max(0, Number(k) || 0));
      const dur = Number.isFinite(duration) ? Math.max(0, duration) : 0.45;
      if (dur === 0 || REDUCED_MOTION?.matches) {
        mapK.dur = 0;
        mapK.to = target;
        applyMap(target);
      } else {
        mapK.from = mapK.value;
        mapK.to = target;
        mapK.t = 0;
        mapK.dur = dur;
      }
      invalidate();
    } catch (err) {
      console.error('[renderer3d] setMapMode failed:', err);
    }
  }

  // ---- weather ----------------------------------------------------------------------------------

  function applyWeather(w) {
    bus.weather = w;
    bus.uniforms.uWet.value = w.wet;
    bus.uniforms.uSnow.value = w.snow;
    try {
      world?.setWeather(w);
    } catch (err) {
      console.error('[renderer3d] setWeather failed:', err);
    }
    bus.emit('weather', w);
  }

  /** 'clear' | 'overcast' | 'rain' | 'storm' | 'snow'. Crossfades over 20 s (instant on the first call). */
  function setWeather(kind) {
    try {
      const k = WEATHER_KINDS.includes(kind) ? kind : 'clear';
      const first = weather.kind === null;
      if (k === weather.kind) return;
      weather.kind = k;
      const b = bus.weather;
      weather.from = { rain: b.rain, snow: b.snow, wet: b.wet, cloud: b.cloud ?? 0 };
      weather.to = { ...WEATHER[k] };
      weather.lightningAt = k === 'storm' ? performance.now() + 3000 + Math.random() * 5000 : 0;
      if (first || REDUCED_MOTION?.matches) {
        weather.t = 1;
        applyWeather({ kind: k, ...weather.to });
        if (tier.name !== 'low') updateEnvironment(true);
      } else {
        weather.t = 0;
        weather.dur = WEATHER_FADE_S;
        bus.weather = { ...bus.weather, kind: k };
      }
      invalidate();
    } catch (err) {
      console.error('[renderer3d] setWeather failed:', err);
    }
  }

  /** Eases sky, map view and weather. Returns 'fast' | 'slow' | '' (what still moves). */
  function stepEnvironment(dt) {
    let moving = '';
    if (day.dur > 0) {
      day.t = Math.min(1, day.t + dt / day.dur);
      const e = day.t * day.t * (3 - 2 * day.t);
      applyDay(day.from + (day.to - day.from) * e);
      if (day.t >= 1) day.dur = 0;
      else moving = 'fast';
    }
    if (mapK.dur > 0) {
      mapK.t = Math.min(1, mapK.t + dt / mapK.dur);
      const e = mapK.t * mapK.t * (3 - 2 * mapK.t);
      applyMap(mapK.from + (mapK.to - mapK.from) * e);
      if (mapK.t >= 1) mapK.dur = 0;
      else moving = 'fast';
    }
    if (weather.t < 1) {
      // Real seconds (the idle loop runs at the tier's ambient rate: steps are larger then).
      weather.t = Math.min(1, weather.t + Math.min(0.25, dt) / weather.dur);
      const e = weather.t * weather.t * (3 - 2 * weather.t);
      const w = { kind: weather.kind };
      for (const key of ['rain', 'snow', 'wet', 'cloud']) w[key] = weather.from[key] + (weather.to[key] - weather.from[key]) * e;
      applyWeather(w);
      if (weather.t >= 1 && tier.name !== 'low') updateEnvironment(true);
      if (!moving && weather.t < 1) moving = 'slow';
    }
    // Storm: lightning (the sky light ×4 for 0.12 s; lane D plays the thunder on 'lightning').
    if (weather.kind === 'storm' && weather.lightningAt && performance.now() >= weather.lightningAt) {
      weather.lightningAt = performance.now() + 6000 + Math.random() * 9000;
      weather.flash = 0.12;
      bus.emit('lightning', 1);
      try {
        world?.lightning?.(1);
      } catch { /* cosmetic */ }
    }
    if (weather.flash > 0) {
      weather.flash = Math.max(0, weather.flash - Math.min(dt, 0.05));
      if (weather.flash === 0) {
        try {
          world?.lightning?.(0);
        } catch { /* cosmetic */ }
        bus.emit('lightning', 0);
      }
      moving = 'fast';
    }
    if (weather.kind === 'storm' && !moving) moving = 'slow';
    return moving;
  }

  // ---- shadows fitted to the shot (§9, §15.2) -------------------------------------------------

  const lightDir = new THREE.Vector3();
  const axisX = new THREE.Vector3();
  const axisY = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

  /**
   * The shadow map covers a box of ±radius around (x, z) — the current shot. null = the whole lot
   * ring. { freeze: true } keeps the current box and stops re-rendering (transit shots) until the
   * next call without it.
   */
  function setShadowFocus(focus, { freeze = false } = {}) {
    try {
      const f = focus && Number.isFinite(Number(focus.x)) && Number.isFinite(Number(focus.z))
        ? { x: Number(focus.x), z: Number(focus.z), radius: Math.min(700, Math.max(12, Number(focus.radius) || DEFAULT_FOCUS.radius)) }
        : { ...DEFAULT_FOCUS };
      shadow.want = f;
      if (freeze) {
        shadow.frozen = true;
        return;
      }
      const was = shadow.frozen;
      shadow.frozen = false;
      refitShadow(false);
      if (was && shadow.pendingWhileFrozen) {
        shadow.pendingWhileFrozen = false;
        shadow.dirty = true;
      }
      if (shadow.dirty) invalidate();
    } catch (err) {
      console.error('[renderer3d] setShadowFocus failed:', err);
    }
  }

  /**
   * Fits the shadow camera to shadow.want if the box changed enough (radius, or the centre moved
   * more than 1/8 of the box), or always when `force` (the sun stepped). Texel-snapped.
   */
  function refitShadow(force) {
    if (!sun) return;
    const w = shadow.want;
    const b = shadow.box;
    const changed = !b || Math.abs(b.radius - w.radius) > b.radius * 0.02
      || Math.hypot(b.x - w.x, b.z - w.z) > (2 * b.radius) / 8;
    if (!changed && !force) return;
    const R = w.radius;
    // Light direction (from the scene toward the light), from the world's sun.
    lightDir.copy(world?.sunDirection ?? v1.set(-0.45, 0.75, 0.45)).normalize();
    if (lightDir.y < 0.08) {
      lightDir.y = 0.08;
      lightDir.normalize();
    }
    // The shadow camera's basis (Matrix4.lookAt with up = +Y).
    axisX.crossVectors(UP, lightDir);
    if (axisX.lengthSq() < 1e-8) axisX.set(1, 0, 0);
    axisX.normalize();
    axisY.crossVectors(lightDir, axisX).normalize();
    const mapSize = tier.shadowMap || 2048;
    const texel = (2 * R) / mapSize;
    v1.set(w.x, 0, w.z);
    const cx = Math.round(v1.dot(axisX) / texel) * texel;
    const cy = Math.round(v1.dot(axisY) / texel) * texel;
    const cz = v1.dot(lightDir);
    const centre = v1.set(0, 0, 0).addScaledVector(axisX, cx).addScaledVector(axisY, cy).addScaledVector(lightDir, cz);
    const D = R + 420; // room for the tallest towers (≤ 200 m) inside the box
    sun.target.position.copy(centre);
    sun.position.copy(centre).addScaledVector(lightDir, D);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
    const cam = sun.shadow.camera;
    cam.left = -R;
    cam.right = R;
    cam.top = R;
    cam.bottom = -R;
    cam.near = 1;
    cam.far = D + R + 260;
    cam.updateProjectionMatrix();
    sun.shadow.normalBias = Math.max(0.02, texel * 0.9);
    sun.shadow.bias = -0.00015;
    shadow.box = { x: w.x, z: w.z, radius: R };
    if (shadow.frozen) shadow.pendingWhileFrozen = true;
    else shadow.dirty = true;
  }

  function markShadows() {
    if (shadow.frozen) shadow.pendingWhileFrozen = true;
    else shadow.dirty = true;
  }

  // ---- loop ---------------------------------------------------------------------------------------

  function invalidate() {
    if (disposed || frame) return;
    if (ambientTimer) { clearTimeout(ambientTimer); ambientTimer = 0; }
    frame = requestAnimationFrame(tick);
  }

  function tick(now) {
    frame = 0;
    if (disposed) return;
    const raw = last ? (now - last) / 1000 : 1 / 60;
    const dt = Math.min(0.05, raw);
    last = now;
    let busy = false;
    try {
      busy = !!onFrame?.(dt, now);
    } catch (err) {
      console.error('[renderer3d] frame failed:', err);
    }
    const env = stepEnvironment(Math.min(0.25, raw));
    try {
      // The world's idle life keeps moving on every frame — also while the game animates.
      if (!REDUCED_MOTION?.matches) {
        world?.ambient(now);
        bus.emit('frame', now);
      }
    } catch (err) {
      console.error('[renderer3d] world ambient failed:', err);
    }
    const damping = controls.update(dt);
    draw(busy, now);
    watchFps(raw, busy, now);
    if (busy || damping || userDragging || env === 'fast') {
      invalidate();
      return;
    }
    last = 0;
    // Idle: keep only the cheap ambient effects going, at a low frame rate.
    let ambient = false;
    try {
      ambient = (!!onAmbient?.(now) || env === 'slow') && !document.hidden && size.w > 0;
    } catch (err) {
      console.error('[renderer3d] ambient failed:', err);
    }
    if (ambient) {
      const next = performance.now();
      ambientTimer = setTimeout(() => {
        ambientTimer = 0;
        last = next; // the idle step (weather crossfade) advances by real time
        invalidate();
      }, 1000 / tier.ambientFps);
    }
  }

  /** 'auto' quality: steps down a tier when the GPU keeps running slowly (GPU_MAX_MS). */
  function watchFps(raw, busy, now) {
    const counted = busy && fps.prevBusy && raw < 0.1; // continuous animation, no stall
    if (busy && !fps.prevBusy) fps.busySince = now;
    fps.prevBusy = busy;
    if (requested !== 'auto') return;
    if (timerExt) {
      if (fps.samples.length < GPU_SAMPLES) return;
      const s = fps.samples.slice().sort((a, b) => a - b);
      const median = s[s.length >> 1];
      fps.samples.length = 0;
      if (median > GPU_MAX_MS) stepDown(`${median.toFixed(1)} ms GPU per frame`);
      return;
    }
    if (!counted || now - fps.busySince < GPU_WARM_MS) return;
    fps.sum += raw;
    fps.n += 1;
    if (fps.n < FPS_WINDOW) return;
    const avg = fps.sum / fps.n;
    fps.sum = 0;
    fps.n = 0;
    if (avg > 1 / FPS_MIN) stepDown(`${Math.round(1 / avg)} fps`);
  }

  function stepDown(why) {
    const nowMs = performance.now();
    const k = TIER_ORDER.indexOf(tier.name);
    if (k <= 0 || nowMs - fps.lastDrop < FPS_COOLDOWN_MS) return;
    fps.lastDrop = nowMs;
    console.info(`[renderer3d] ${why} on '${tier.name}': using '${TIER_ORDER[k - 1]}'`);
    applyTier({ ...resolveTier(TIER_ORDER[k - 1], renderer), requested: 'auto' });
  }

  /** Collects finished GPU timer queries (ms): `recent` for stats(), `samples` for auto quality. */
  function readGpuSamples() {
    if (!timerExt) return;
    const gl = renderer.getContext();
    while (fps.queries.length && gl.getQueryParameter(fps.queries[0].q, gl.QUERY_RESULT_AVAILABLE)) {
      const { q, warm } = fps.queries.shift();
      if (!gl.getParameter(timerExt.GPU_DISJOINT_EXT)) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        fps.recent.push(ms);
        if (fps.recent.length > 15) fps.recent.shift();
        if (warm) fps.samples.push(ms);
      }
      gl.deleteQuery(q);
    }
  }

  /** Per-frame near / far (§9) and fog that starts behind the subject. */
  function updateClipAndFog() {
    const dist = camera.position.distanceTo(controls.target);
    let ground = 0;
    try {
      ground = world?.heightAt?.(camera.position.x, camera.position.z) ?? 0;
    } catch { /* flat */ }
    const altitude = Math.max(0.5, camera.position.y - ground);
    if (autoClip) {
      const near = Math.min(1, Math.max(0.1, 0.02 * Math.min(altitude, dist)));
      const far = Math.min(tier.far, Math.max(2000, 6 * dist + 8 * altitude + 1500));
      if (Math.abs(camera.near - near) > 1e-3 || Math.abs(camera.far - far) > 1) {
        camera.near = near;
        camera.far = far;
        camera.updateProjectionMatrix();
      }
    }
    const fog = scene.fog;
    if (fog?.isFog) {
      const w = bus.weather;
      const thick = 1 - 0.45 * (w.cloud ?? 0) - 0.2 * w.rain - 0.15 * w.snow;
      const range = (2.6 / tier.fogDensity) * Math.max(0.25, thick);
      const far = Math.min(150 + dist + range, camera.far * 0.97);
      fog.near = Math.max(10, Math.min(far - 120, 150 + dist * (0.75 + 0.25 * thick)));
      fog.far = far;
    }
  }

  function draw(busy = false, now = performance.now()) {
    if (!size.w || !size.h || hold) return;
    lastDrawAt = performance.now();
    renderer.info.autoReset = false;
    renderer.info.reset();
    frameStats.shadowCalls = 0;
    if (shadow.dirty && renderer.shadowMap.enabled) {
      renderer.shadowMap.needsUpdate = true;
      shadow.dirty = false;
    }
    updateClipAndFog();
    try {
      world?.follow(camera);
    } catch (err) {
      console.error('[renderer3d] world follow failed:', err);
    }
    readGpuSamples();
    let query = null;
    if (timerExt && ++fps.frames % GPU_EVERY === 0 && fps.queries.length < 4) {
      const gl = renderer.getContext();
      query = gl.createQuery();
      gl.beginQuery(timerExt.TIME_ELAPSED_EXT, query);
    }
    try {
      if (post) post.render();
      else renderer.render(scene, camera);
    } finally {
      if (query) {
        renderer.getContext().endQuery(timerExt.TIME_ELAPSED_EXT);
        fps.queries.push({ q: query, warm: requested === 'auto' && busy && now - fps.busySince > GPU_WARM_MS });
      }
      const r = renderer.info.render;
      frameStats.calls = r.calls - frameStats.shadowCalls;
      frameStats.triangles = r.triangles;
      frameStats.points = r.points;
      renderer.info.autoReset = true;
    }
    if (hudPass) {
      try {
        renderer.setRenderTarget(null);
        hudPass(renderer, size);
      } catch (err) {
        console.error('[renderer3d] HUD pass failed:', err);
        hudPass = null;
      }
    }
  }

  /** Draws one frame right now (render() always ends with this, so the board is correct even
   * when rAF is paused, e.g. in a hidden or occluded view). */
  function renderNow() {
    if (disposed) return;
    measure();
    controls.update(0);
    draw(false);
  }

  /**
   * Asks for a frame, and draws one directly if the animation loop doesn't deliver it soon (a
   * hidden / occluded view pauses requestAnimationFrame), so the board is never left stale.
   */
  function renderSoon() {
    if (disposed) return;
    invalidate();
    const asked = performance.now();
    clearTimeout(soonTimer);
    soonTimer = setTimeout(() => {
      soonTimer = 0;
      if (!disposed && lastDrawAt < asked) renderNow();
    }, RENDER_SOON_MS);
  }

  /** Syncs the canvas with its box. Returns true if the size changed. */
  function measure(force = false) {
    if (disposed) return false;
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h || (!force && w === size.w && h === size.h)) return false;
    size.w = w;
    size.h = h;
    renderer.setSize(w, h, false);
    post?.setSize(w, h, renderer.getPixelRatio());
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    onResize?.();
    return true;
  }

  // ---- quality ----------------------------------------------------------------------------------

  function applyShadowTier() {
    const on = tier.shadowMap > 0;
    if (renderer.shadowMap.enabled !== on) {
      renderer.shadowMap.enabled = on;
      // Materials compiled with / without shadow sampling must recompile.
      scene.traverse((o) => {
        for (const m of [].concat(o.material ?? [])) if (m) m.needsUpdate = true;
      });
    }
    sun.castShadow = on;
    if (on) {
      sun.shadow.mapSize.set(tier.shadowMap, tier.shadowMap);
      sun.shadow.radius = tier.shadowRadius;
    }
    if (sun.shadow.map) {
      sun.shadow.map.dispose();
      sun.shadow.map = null; // reallocated at the new size on the next shadow render
    }
    shadow.box = null;
    refitShadow(true);
    shadow.dirty = true;
  }

  function applyTier(next) {
    tier = next;
    bus.tier = tier;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier.dpr));
    applyShadowTier();
    if (tier.post && !post) {
      try {
        post = createPost(renderer, scene, camera);
      } catch (err) {
        console.warn('[renderer3d] postprocessing unavailable:', err);
        post = null;
      }
    } else if (!tier.post && post) {
      post.dispose();
      post = null;
    }
    try {
      world?.setTier(tier);
    } catch (err) {
      console.error('[renderer3d] setTier failed:', err);
    }
    if (camera.far > tier.far) {
      camera.far = tier.far;
      camera.updateProjectionMatrix();
    }
    updateEnvironment(true);
    bus.emit('tier', tier);
    measure(true);
    invalidate();
  }

  /**
   * Sets the graphics quality: 'auto' | 'low' | 'medium' | 'high'. Returns the tier in use
   * ('auto' resolves by device). Cheap when nothing changes.
   */
  function setQuality(q) {
    try {
      const want = QUALITY_NAMES.includes(q) ? q : 'auto';
      const next = resolveTier(want, renderer);
      requested = want;
      if (next.name === tier.name && !!post === !!next.post) {
        tier.requested = want;
        return tier.name;
      }
      applyTier(next);
    } catch (err) {
      console.error('[renderer3d] setQuality failed:', err);
    }
    return tier.name;
  }

  // Initial state: shadows, sky, weather, bloom on 'high'.
  applyShadowTier();
  applyDay(day.value);
  setWeather('clear');
  updateEnvironment(true);
  if (tier.post) {
    try {
      post = createPost(renderer, scene, camera);
    } catch (err) {
      console.warn('[renderer3d] postprocessing unavailable:', err);
    }
  }

  // With postprocessing the scene renders into an HDR target, whose shader variants (linear output,
  // no tone mapping) differ from the screen's. Background warm-ups (renderer.compileAsync) must
  // compile those, or the first real frame compiles everything again.
  const baseCompile = renderer.compile.bind(renderer);
  renderer.compile = (s, c, target = null) => {
    if (!post || renderer.getRenderTarget() !== null) return baseCompile(s, c, target);
    renderer.setRenderTarget(post.target);
    try {
      return baseCompile(s, c, target);
    } finally {
      renderer.setRenderTarget(null);
    }
  };

  const ro = new ResizeObserver(() => {
    if (measure()) invalidate();
  });
  ro.observe(host);

  const onVisibility = () => { if (!document.hidden) invalidate(); };
  document.addEventListener('visibilitychange', onVisibility);

  const onLost = (e) => {
    e.preventDefault();
    if (!disposed) onContextLost?.();
  };
  canvas.addEventListener('webglcontextlost', onLost);

  function setFreeLook(on) {
    controls.enabled = on;
    canvas.style.touchAction = on ? 'none' : 'pan-y';
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    clearTimeout(ambientTimer);
    clearTimeout(soonTimer);
    ro.disconnect();
    offDusk();
    try {
      for (const { q } of fps.queries) renderer.getContext().deleteQuery(q);
    } catch { /* context gone */ }
    fps.queries.length = 0;
    try {
      world?.dispose();
    } catch (err) {
      console.warn('[renderer3d] world dispose failed:', err);
    }
    bus.clear();
    document.removeEventListener('visibilitychange', onVisibility);
    canvas.removeEventListener('webglcontextlost', onLost);
    controls.dispose();
    post?.dispose();
    post = null;
    hudPass = null;
    disposeScene(scene);
    scene.fog = null;
    scene.environment = null;
    envRT?.dispose();
    envRT = null;
    pmrem?.dispose();
    pmrem = null;
    renderer.dispose();
    // dispose() alone leaks the WebGL context until GC: after ~16 toggles Chrome kills the oldest
    // live context. Losing it explicitly frees it now.
    try {
      if (!renderer.getContext().isContextLost()) renderer.forceContextLoss();
    } catch { /* already gone */ }
    canvas.remove();
  }

  measure();

  const stage = {
    renderer,
    scene,
    camera,
    controls,
    canvas,
    size,
    touchFirst,
    invalidate,
    renderNow,
    renderSoon,
    /** Holds drawing while shaders compile in the background (see renderer3d warmUp). */
    setHold(on) {
      hold = !!on;
      if (!hold) invalidate();
    },
    measure,
    setFreeLook,
    get freeLook() { return controls.enabled; },
    markShadows,
    dispose,

    setQuality,
    /** The tier in use: 'low' | 'medium' | 'high'. */
    get quality() { return tier.name; },
    /** The requested quality: 'auto' | 'low' | 'medium' | 'high'. */
    get requestedQuality() { return requested; },
    /** The tier's settings object (§15.1 fields + name + requested). */
    get tier() { return tier; },
    /** The bloom chain on 'high' ({ target, bloom, passes, setBloom }, world-post.js), else null. */
    get post() { return post; },

    // ---- city (§17.4) ----
    bus,
    world,
    /** The sun / moon light (casts the one shadow map). */
    sun,
    setShadowFocus,
    /** fn(renderer, size) runs after the main render (or the bloom chain) every frame; null removes it. */
    setHudPass(fn) {
      hudPass = typeof fn === 'function' ? fn : null;
      invalidate();
    },
    setMapMode,
    get mapMode() { return mapK.value; },
    setWeather,
    get weather() { return weather.kind; },
    setDayPhase,
    get dayPhase() { return day.value; },
    /** Legacy alias: t 0 (afternoon) … 1 (blue-hour dusk) → phase 0.35 + 0.65·t; null releases a hold. */
    setDusk(t, { hold: pin = false, instant = false, duration } = {}) {
      if (t === null || t === undefined) return setDayPhase(null);
      return setDayPhase(0.35 + 0.65 * Math.min(1, Math.max(0, Number(t) || 0)), { hold: pin, instant, duration });
    },
    get dusk() { return bus.dusk; },
    /**
     * Per-frame near / far from the camera's distance to controls.target and its altitude (§9),
     * on by default. A director that manages camera.near / far itself turns it off.
     */
    setAutoClip(on) { autoClip = !!on; },
    /** Renderer statistics of the last frame (main pass) + the shadow pass + GPU time (ms, median). */
    stats() {
      const i = renderer.info;
      const s = fps.recent.slice().sort((a, b) => a - b);
      return {
        calls: frameStats.calls,
        triangles: frameStats.triangles,
        points: frameStats.points,
        geometries: i.memory.geometries,
        textures: i.memory.textures,
        tier: tier.name,
        dpr: renderer.getPixelRatio(),
        post: !!post,
        width: size.w,
        height: size.h,
        gpuMs: s.length ? Math.round(s[s.length >> 1] * 100) / 100 : null,
        shadowCalls: frameStats.shadowCalls,
        shadowRenders: shadow.renders,
      };
    },
    /** §17.11 debug hooks (never used by game code). */
    debug: {
      get shadow() { return { ...shadow, want: { ...shadow.want }, box: shadow.box && { ...shadow.box } }; },
      /** Draws n frames with GPU timer queries and resolves to their median (ms), or null. */
      async gpuTime(n = 12) {
        if (!timerExt) return null;
        const gl = renderer.getContext();
        const qs = [];
        for (let k = 0; k < n; k++) {
          const q = gl.createQuery();
          gl.beginQuery(timerExt.TIME_ELAPSED_EXT, q);
          renderNow();
          gl.endQuery(timerExt.TIME_ELAPSED_EXT);
          qs.push(q);
        }
        const out = [];
        for (let tries = 0; tries < 100 && qs.length; tries++) {
          await new Promise((r) => setTimeout(r, 16));
          while (qs.length && gl.getQueryParameter(qs[0], gl.QUERY_RESULT_AVAILABLE)) {
            const q = qs.shift();
            if (!gl.getParameter(timerExt.GPU_DISJOINT_EXT)) out.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
            gl.deleteQuery(q);
          }
        }
        out.sort((a, b) => a - b);
        return out.length ? out[out.length >> 1] : null;
      },
      /** Places the camera for a named check shot: 'heli' | 'map' | 'kerb' (tile) | 'avenue' (tile). */
      shot(name, tile = 13) {
        return debugShot(stage, name, tile);
      },
    },
  };
  return stage;
}

/** Standard check shots (verification only; the director owns real camera work). */
function debugShot(stage, name, tile) {
  const { camera, controls } = stage;
  const deg = Math.PI / 180;
  const place = (tx, tz, yaw, pitch, dist, fov) => {
    controls.target.set(tx, 0, tz);
    camera.fov = fov;
    camera.position.set(tx + dist * Math.cos(pitch) * Math.sin(yaw), dist * Math.sin(pitch), tz + dist * Math.cos(pitch) * Math.cos(yaw));
  };
  if (name === 'map') {
    place(0, 0, 0, 88 * deg, 1000, 22);
    stage.setShadowFocus(null);
  } else if (name === 'kerb' || name === 'avenue') {
    const i = ((Math.trunc(tile) % 40) + 40) % 40;
    const q = Math.floor(i / 10);
    const out = [[0, 1], [-1, 0], [0, -1], [1, 0]][q];
    const along = [[-1, 0], [0, -1], [1, 0], [0, 1]][q];
    const a = 130 - 26 * (i % 10 || 5);
    const lane = [[a, 132.25], [-132.25, a], [-a, -132.25], [132.25, -a]][q];
    if (name === 'kerb') {
      // Inner sidewalk across the avenue (lane point − 12.5·out + 4·along), eye 1.7 m, looking at the lot front.
      camera.fov = 45;
      camera.position.set(lane[0] - out[0] * 12.5 + along[0] * 4, 1.7, lane[1] - out[1] * 12.5 + along[1] * 4);
      controls.target.set(lane[0] + out[0] * 14, 5, lane[1] + out[1] * 14);
      stage.setShadowFocus({ x: lane[0] + out[0] * 20, z: lane[1] + out[1] * 20, radius: 45 });
    } else {
      // Eye level down the avenue from the inner sidewalk, looking along the travel direction.
      camera.fov = 50;
      camera.position.set(lane[0] - out[0] * 12.5 - along[0] * 40, 1.7, lane[1] - out[1] * 12.5 - along[1] * 40);
      controls.target.set(lane[0] - out[0] * 2 + along[0] * 60, 3, lane[1] - out[1] * 2 + along[1] * 60);
      stage.setShadowFocus({ x: lane[0] + along[0] * 30, z: lane[1] + along[1] * 30, radius: 90 });
    }
  } else {
    // Helicopter: SEAT_YAW, pitch 58°, ~600 m, FOV 30.
    place(0, 0, -Math.PI / 4, 58 * deg, 600, 30);
    stage.setShadowFocus(null);
  }
  camera.lookAt(controls.target);
  camera.updateProjectionMatrix();
  stage.renderNow();
  return stage.stats();
}

/** Frees every geometry, material and texture reachable from `root`. */
export function disposeScene(root) {
  const seen = new Set();
  root.traverse((o) => {
    if (o.geometry && !seen.has(o.geometry)) {
      seen.add(o.geometry);
      o.geometry.dispose();
    }
    for (const m of [].concat(o.material ?? [])) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      for (const v of Object.values(m)) {
        if (v?.isTexture && !seen.has(v)) {
          seen.add(v);
          v.dispose();
        }
      }
      // ShaderMaterial textures live in uniforms.
      for (const u of Object.values(m.uniforms ?? {})) {
        if (u?.value?.isTexture && !seen.has(u.value)) {
          seen.add(u.value);
          u.value.dispose();
        }
      }
      m.dispose();
    }
    if (o.isInstancedMesh) o.dispose();
    if (o.isLight && o.shadow?.map) o.shadow.dispose();
  });
}
