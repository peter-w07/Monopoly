// public/r3d/stage.js — WebGL renderer, scene, camera, the world around the board (world-env.js),
// quality tiers, time of day, optional postprocessing, and the render loop.
//
// The loop renders on demand: a frame is drawn only when something asked for it (invalidate) or
// while animations / camera moves / an ambient effect are running. Idle costs nothing.
// Frame budget: shadows are re-rendered only when something that casts one moved; nothing in the
// environment or the city's ambient life casts shadows.
//
// Quality (world-quality.js): setQuality('auto'|'low'|'medium'|'high') changes the pixel-ratio cap,
// the shadow-map size, the board texture size (board.js listens), the density of the ambient life
// (city.js listens) and, on 'high', tilt-shift + bloom postprocessing (world-post.js). The initial
// value comes from createStage(host, { quality }) or the saved settings (monopoly.settings.quality).
//
// Time of day: the city asks for a dusk level as it grows (bus 'duskTarget'); the stage eases the
// sky, fog and lights toward it and publishes the current value (bus 'dusk') so windows and street
// lamps light up. setDusk(t, { hold }) overrides it.

import * as THREE from './three.js';
import { createEnvironment } from './world-env.js';
import { createPost } from './world-post.js';
import { resolveTier, savedQuality, worldBus, QUALITY_NAMES } from './world-quality.js';
import { smoothstep } from './world-geo.js';

const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const REDUCED_MOTION = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const RENDER_SOON_MS = 120; // renderSoon(): draw directly if no animation frame came by then
const DUSK_RATE = 0.9; // 1/s: how quickly the time of day eases toward its target
// 'auto' quality steps down a tier when the GPU can't keep up: the median GPU time of sampled
// frames (EXT_disjoint_timer_query_webgl2) above GPU_MAX_MS. Without the extension it falls back to
// the frame rate while animating (below FPS_MIN over FPS_WINDOW frames). GPU time, not frame
// intervals, so a browser capped at 30 Hz (battery saver) isn't mistaken for a slow GPU.
const GPU_MAX_MS = 20;
const GPU_SAMPLES = 7; // one sample every GPU_EVERY animated frames
const GPU_EVERY = 8;
const FPS_MIN = 30;
const FPS_WINDOW = 120;
const FPS_COOLDOWN_MS = 8000;
const TIER_ORDER = ['low', 'medium', 'high'];

/**
 * Creates the stage inside `host` (the .r3d root). Throws if WebGL can't be created.
 * @param {HTMLElement} host
 * @param {object} hooks
 * @param {(dt:number, now:number) => boolean} hooks.onFrame  advance animations; return true to keep animating
 * @param {(now:number) => boolean} [hooks.onAmbient]           idle effects; return true to keep ticking
 * @param {() => void} [hooks.onResize]
 * @param {() => void} [hooks.onContextLost]
 * @param {'auto'|'low'|'medium'|'high'} [hooks.quality]      initial quality (default: the saved setting)
 */
export function createStage(host, { onFrame, onAmbient, onResize, onContextLost, quality } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping; // keeps the colour-group colours true (ACES shifts yellow)
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // soft since r182 (PCFSoftShadowMap was removed in r186)
  renderer.shadowMap.autoUpdate = false; // re-rendered only when pieces move (see markShadows)
  renderer.shadowMap.needsUpdate = true; // REQUIRED before the first frame (else GL sampler warnings)
  const canvas = renderer.domElement;
  canvas.className = 'r3d-canvas';
  canvas.setAttribute('aria-label', '3D game board');
  host.prepend(canvas);

  // Quality: resolved before anything else is built, so the board / city read it at construction.
  const bus = worldBus(renderer);
  let requested = QUALITY_NAMES.includes(quality) ? quality : savedQuality();
  let tier = resolveTier(requested, renderer);
  bus.tier = tier;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier.dpr));

  const scene = new THREE.Scene();

  // Soft studio reflections so metal tokens don't render black (no HDR download needed).
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new THREE.RoomEnvironment();
  const envRT = pmrem.fromScene(room, 0.04);
  room.dispose();
  pmrem.dispose();
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.55;

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 320);
  camera.position.set(0, 16, 12);

  // The terrace, table, props, sky and the lights (world-env.js).
  const env = createEnvironment(renderer, scene, { tier });
  const key = env.key;
  applyShadowTier();

  const controls = new THREE.OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 3.5;
  controls.maxDistance = 32;
  controls.minPolarAngle = 0.12;
  controls.maxPolarAngle = 1.3;
  controls.maxTargetRadius = 7;
  controls.screenSpacePanning = false;
  controls.zoomToCursor = false;
  // Phones: one finger must keep scrolling the page (the board is full width there). Orbiting is
  // switched on explicitly with the overlay's "free look" button (setFreeLook).
  const touchFirst = COARSE;
  setFreeLook(!touchFirst);

  // ---- loop -------------------------------------------------------------------------------------
  let frame = 0;
  let ambientTimer = 0;
  let last = 0;
  let disposed = false;
  let shadowsDirty = true;
  let userDragging = false;
  let lastDrawAt = 0;
  let soonTimer = 0;
  let hold = false; // warming up (shaders compiling in the background): draw nothing yet
  let post = null; // postprocessing (high tier only)
  const size = { w: 0, h: 0 };
  const fps = { sum: 0, n: 0, lastDrop: 0, prevBusy: false, frames: 0, queries: [], samples: [] };
  let timerExt = null;
  try {
    timerExt = renderer.getContext().getExtension('EXT_disjoint_timer_query_webgl2');
  } catch { /* not available */ }
  const dusk = { value: 0, target: 0, held: false };
  const frameStats = { calls: 0, triangles: 0, points: 0 }; // of the last frame the stage drew

  controls.addEventListener('start', () => { userDragging = true; invalidate(); });
  controls.addEventListener('end', () => { userDragging = false; invalidate(); });
  controls.addEventListener('change', () => invalidate());

  const offDusk = bus.on('duskTarget', (v) => {
    if (dusk.held) return;
    const value = typeof v === 'object' && v ? v.value : v;
    if (!Number.isFinite(value)) return;
    dusk.target = Math.min(1, Math.max(0, value));
    if (v?.instant) setDuskNow(dusk.target);
    else invalidate();
  });

  function setDuskNow(t) {
    dusk.value = t;
    env.setDusk(t);
    bus.dusk = t;
    bus.lights = smoothstep(0.28, 0.85, t);
    bus.emit('dusk', t);
  }
  setDuskNow(0);

  /** Eases the time of day toward its target. Returns true while it is still moving. */
  function stepDusk(dt) {
    const d = dusk.target - dusk.value;
    if (Math.abs(d) < 0.002) {
      if (d !== 0) setDuskNow(dusk.target);
      return false;
    }
    setDuskNow(dusk.value + Math.sign(d) * Math.min(Math.abs(d), DUSK_RATE * dt * Math.max(0.15, Math.abs(d))));
    return true;
  }

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
      busy = !!onFrame(dt, now);
    } catch (err) {
      console.error('[renderer3d] frame failed:', err);
    }
    const envBusy = stepDusk(dt);
    try {
      // The world's idle life keeps moving on every frame — also while the game animates (the
      // renderer's onAmbient only runs when nothing else does). City: bus 'frame'.
      if (!REDUCED_MOTION?.matches) {
        env.ambient(now);
        bus.emit('frame', now);
      }
    } catch (err) {
      console.error('[renderer3d] environment failed:', err);
    }
    const damping = controls.update(dt);
    draw();
    watchFps(raw, busy);
    if (busy || damping || userDragging || envBusy) {
      invalidate();
      return;
    }
    last = 0;
    // Idle: keep only the cheap ambient effects going, at a low frame rate.
    let ambient = false;
    try {
      ambient = !!onAmbient?.(now) && !document.hidden && size.w > 0;
    } catch (err) {
      console.error('[renderer3d] ambient failed:', err);
    }
    if (ambient) ambientTimer = setTimeout(() => { ambientTimer = 0; invalidate(); }, 1000 / tier.ambientFps);
  }

  /** 'auto' quality: steps down a tier when the GPU keeps running slowly (see GPU_MAX_MS). */
  function watchFps(raw, busy) {
    const counted = busy && fps.prevBusy && raw < 0.1; // continuous animation, no stall
    fps.prevBusy = busy;
    if (requested !== 'auto') return;
    if (timerExt) {
      readGpuSamples();
      if (fps.samples.length < GPU_SAMPLES) return;
      fps.samples.sort((a, b) => a - b);
      const median = fps.samples[fps.samples.length >> 1];
      fps.samples.length = 0;
      if (median > GPU_MAX_MS) stepDown(`${median.toFixed(1)} ms GPU per frame`);
      return;
    }
    if (!counted) return;
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

  /** Collects finished GPU timer queries (ms) into fps.samples. */
  function readGpuSamples() {
    const gl = renderer.getContext();
    while (fps.queries.length && gl.getQueryParameter(fps.queries[0], gl.QUERY_RESULT_AVAILABLE)) {
      const q = fps.queries.shift();
      if (!gl.getParameter(timerExt.GPU_DISJOINT_EXT)) fps.samples.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
    }
  }

  const focusV = new THREE.Vector3();
  const fwd = new THREE.Vector3();

  function draw() {
    if (!size.w || !size.h || hold) return;
    lastDrawAt = performance.now();
    // Count the whole frame (shadow pass + every postprocessing pass), then restore three's default.
    renderer.info.autoReset = false;
    renderer.info.reset();
    if (shadowsDirty) {
      renderer.shadowMap.needsUpdate = true;
      shadowsDirty = false;
    }
    env.follow(camera);
    // 'auto': time every GPU_EVERY-th animated frame on the GPU (see watchFps).
    let query = null;
    if (timerExt && requested === 'auto' && fps.prevBusy && ++fps.frames % GPU_EVERY === 0 && fps.queries.length < 4) {
      const gl = renderer.getContext();
      query = gl.createQuery();
      gl.beginQuery(timerExt.TIME_ELAPSED_EXT, query);
    }
    try {
      if (post) {
        updateFocus();
        post.render();
      } else {
        renderer.render(scene, camera);
      }
    } finally {
      if (query) {
        renderer.getContext().endQuery(timerExt.TIME_ELAPSED_EXT);
        fps.queries.push(query);
      }
      const r = renderer.info.render;
      frameStats.calls = r.calls;
      frameStats.triangles = r.triangles;
      frameStats.points = r.points;
      renderer.info.autoReset = true;
    }
  }

  /** Tilt-shift focus band: the screen rows of a region around the camera target. */
  function updateFocus() {
    const t = controls.target;
    fwd.subVectors(t, camera.position).setY(0);
    const len = fwd.length() || 1;
    fwd.divideScalar(len);
    const dist = camera.position.distanceTo(t);
    const r = Math.max(3.2, Math.min(7.5, dist * 0.42));
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < 4; k++) {
      const a = k === 0 ? -r : k === 3 ? 0 : r; // near edge, far edge, far rooftops, centre
      focusV.set(t.x + fwd.x * a, k === 2 ? 1.6 : 0, t.z + fwd.z * a).project(camera);
      const row = (focusV.y + 1) / 2;
      lo = Math.min(lo, row);
      hi = Math.max(hi, row);
    }
    post.setFocus(lo - 0.04, hi + 0.04);
  }

  /** Draws one frame right now (render() always ends with this, so the board is correct even
   * when rAF is paused, e.g. in a hidden or occluded view). */
  function renderNow() {
    if (disposed) return;
    measure();
    controls.update(0);
    draw();
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
    key.shadow.mapSize.set(tier.shadowMap, tier.shadowMap);
    key.shadow.radius = tier.shadowRadius;
    if (key.shadow.map) {
      key.shadow.map.dispose();
      key.shadow.map = null; // reallocated at the new size on the next shadow render
    }
    renderer.shadowMap.needsUpdate = true;
  }

  function applyTier(next) {
    tier = next;
    bus.tier = tier;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier.dpr));
    applyShadowTier();
    shadowsDirty = true;
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
    env.setTier(tier);
    bus.emit('tier', tier);
    measure(true);
    invalidate();
  }

  /**
   * Sets the graphics quality: 'auto' | 'low' | 'medium' | 'high'. Returns the tier in use
   * ('auto' resolves by device). Cheap when nothing changes.
   */
  function setQuality(q) {
    const want = QUALITY_NAMES.includes(q) ? q : 'auto';
    const next = resolveTier(want, renderer);
    requested = want;
    if (next.name === tier.name && !!post === !!next.post) {
      tier.requested = want;
      return tier.name;
    }
    applyTier(next);
    return tier.name;
  }
  if (tier.post) applyTier(tier); // create the postprocessing chain for an initial 'high'

  // With postprocessing the scene renders into an HDR target, whose shader variants (linear output,
  // no tone mapping) differ from the screen's. Background warm-ups (renderer3d warmUp calls
  // renderer.compileAsync) must compile those, or the first real frame compiles everything again.
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
    if (measure()) {
      shadowsDirty = true;
      invalidate();
    }
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
      for (const q of fps.queries) renderer.getContext().deleteQuery(q);
    } catch { /* context gone */ }
    fps.queries.length = 0;
    bus.clear();
    document.removeEventListener('visibilitychange', onVisibility);
    canvas.removeEventListener('webglcontextlost', onLost);
    controls.dispose();
    post?.dispose();
    post = null;
    disposeScene(scene);
    scene.fog = null;
    envRT.dispose();
    renderer.dispose();
    // dispose() alone leaks the WebGL context until GC: after ~16 toggles Chrome kills the oldest
    // live context. Losing it explicitly frees it now.
    try {
      if (!renderer.getContext().isContextLost()) renderer.forceContextLoss();
    } catch { /* already gone */ }
    canvas.remove();
  }

  measure();

  return {
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
    markShadows() { shadowsDirty = true; },
    dispose,

    // ---- world (wave 4) ----
    setQuality,
    /** The tier in use: 'low' | 'medium' | 'high'. */
    get quality() { return tier.name; },
    /** The requested quality: 'auto' | 'low' | 'medium' | 'high'. */
    get requestedQuality() { return requested; },
    /** The tier's settings object (dpr, shadowMap, boardTex, density, post, ambientFps, clouds). */
    get tier() { return tier; },
    /**
     * Time of day: 0 = golden afternoon … 1 = blue-hour dusk. By default the city drives it (it
     * darkens as the board develops). setDusk(t, { hold: true }) pins it; setDusk(null) releases.
     * { instant: true } snaps instead of easing (~1–3 s).
     */
    setDusk(t, { hold: pin = false, instant = false } = {}) {
      if (t === null || t === undefined) {
        dusk.held = false;
        return;
      }
      dusk.held = !!pin;
      dusk.target = Math.min(1, Math.max(0, Number(t) || 0));
      if (instant) setDuskNow(dusk.target);
      invalidate();
    },
    get dusk() { return dusk.value; },
    /** The world around the board: { group, key, hemi, fill, setDusk, … } (world-env.js). */
    env,
    /** The postprocessing chain on 'high' ({ target, bloom, passes, setFocus, setBloom }, world-post.js), else null. */
    get post() { return post; },
    /** Renderer statistics of the last frame: { calls, triangles, points, geometries, textures, tier, dpr, post }. */
    stats() {
      const i = renderer.info;
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
      };
    },
  };
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
