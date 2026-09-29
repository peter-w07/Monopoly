// public/r3d/stage.js — WebGL renderer, scene, camera, lights, table and the render loop.
//
// The loop renders on demand: a frame is drawn only when something asked for it (invalidate) or
// while animations / camera moves / an ambient effect are running. Idle costs nothing.
// Frame budget: shadows are re-rendered only when something that casts one moved.

import * as THREE from './three.js';
import { SLAB_H } from './layout.js';

const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
// Idle life (the centre city's ferris wheel and cars, the current player's ring) runs at a low
// frame rate; phones get fewer frames.
const AMBIENT_FRAME_MS = 1000 / (COARSE ? 20 : 24);
const RENDER_SOON_MS = 120; // renderSoon(): draw directly if no animation frame came by then
const BACKGROUND = '#1b130e';

/**
 * Creates the stage inside `host` (the .r3d root). Throws if WebGL can't be created.
 * @param {HTMLElement} host
 * @param {object} hooks
 * @param {(dt:number, now:number) => boolean} hooks.onFrame  advance animations; return true to keep animating
 * @param {(now:number) => boolean} [hooks.onAmbient]           idle effects; return true to keep ticking
 * @param {() => void} [hooks.onResize]
 * @param {() => void} [hooks.onContextLost]
 */
export function createStage(host, { onFrame, onAmbient, onResize, onContextLost }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, COARSE ? 1.5 : 2));
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

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  scene.fog = new THREE.Fog(BACKGROUND, 26, 62);

  // Soft studio reflections so metal tokens don't render black (no HDR download needed).
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new THREE.RoomEnvironment();
  const envRT = pmrem.fromScene(room, 0.04);
  room.dispose();
  pmrem.dispose();
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.55;

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 140);
  camera.position.set(0, 16, 12);

  // Lights: warm key from the front-left, fairly low so pieces throw readable contact shadows; cool
  // fill from the other side; sky/ground bounce.
  const hemi = new THREE.HemisphereLight('#fff4e0', '#3a2a20', 0.62);
  const key = new THREE.DirectionalLight('#ffe2b8', 2.6);
  key.position.set(-8, 9.5, 6.5);
  key.castShadow = true;
  const mapSize = COARSE ? 1024 : 2048;
  key.shadow.mapSize.set(mapSize, mapSize);
  Object.assign(key.shadow.camera, { left: -8.5, right: 8.5, top: 8.5, bottom: -8.5, near: 2, far: 40 });
  key.shadow.radius = 3;
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  const fill = new THREE.DirectionalLight('#9ec9ff', 0.35);
  fill.position.set(8, 6, -6);
  scene.add(hemi, key, fill);

  scene.add(buildTable(renderer));

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
  const size = { w: 0, h: 0 };

  controls.addEventListener('start', () => { userDragging = true; invalidate(); });
  controls.addEventListener('end', () => { userDragging = false; invalidate(); });
  controls.addEventListener('change', () => invalidate());

  function invalidate() {
    if (disposed || frame) return;
    if (ambientTimer) { clearTimeout(ambientTimer); ambientTimer = 0; }
    frame = requestAnimationFrame(tick);
  }

  function tick(now) {
    frame = 0;
    if (disposed) return;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60);
    last = now;
    let busy = false;
    try {
      busy = !!onFrame(dt, now);
    } catch (err) {
      console.error('[renderer3d] frame failed:', err);
    }
    const damping = controls.update(dt);
    draw();
    if (busy || damping || userDragging) {
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
    if (ambient) ambientTimer = setTimeout(() => { ambientTimer = 0; invalidate(); }, AMBIENT_FRAME_MS);
  }

  function draw() {
    if (!size.w || !size.h || hold) return;
    lastDrawAt = performance.now();
    if (shadowsDirty) {
      renderer.shadowMap.needsUpdate = true;
      shadowsDirty = false;
    }
    renderer.render(scene, camera);
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
  function measure() {
    if (disposed) return false;
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h || (w === size.w && h === size.h)) return false;
    size.w = w;
    size.h = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    onResize?.();
    return true;
  }

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
    document.removeEventListener('visibilitychange', onVisibility);
    canvas.removeEventListener('webglcontextlost', onLost);
    controls.dispose();
    disposeScene(scene);
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
      m.dispose();
    }
    if (o.isInstancedMesh) o.dispose();
    if (o.isLight && o.shadow?.map) o.shadow.dispose();
  });
}

// ---- table ----------------------------------------------------------------------------------------

/** A big walnut tabletop under the board, fading into the dark background. */
function buildTable(renderer) {
  const tex = new THREE.CanvasTexture(woodCanvas(1024));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(5, 5);
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const table = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.62, metalness: 0 }),
  );
  table.rotation.x = -Math.PI / 2;
  table.position.y = -SLAB_H; // the board's underside rests on it
  table.receiveShadow = true;
  table.name = 'table';
  return table;
}

/** Procedural wood grain: long wavy streaks over a warm base. */
function woodCanvas(size) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, size, 0);
  grad.addColorStop(0, '#5f3a22');
  grad.addColorStop(0.5, '#6b4226');
  grad.addColorStop(1, '#5a3620');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // Planks: subtle vertical seams and tone changes.
  const planks = 4;
  for (let p = 0; p < planks; p++) {
    g.fillStyle = `rgba(${rnd() < 0.5 ? '0,0,0' : '255,220,180'},${0.03 + rnd() * 0.05})`;
    g.fillRect((p * size) / planks, 0, size / planks, size);
    g.fillStyle = 'rgba(20,10,5,0.35)';
    g.fillRect((p * size) / planks, 0, 2, size);
  }
  // Grain streaks.
  for (let k = 0; k < 420; k++) {
    const x0 = rnd() * size;
    const amp = 2 + rnd() * 8;
    const freq = 0.004 + rnd() * 0.01;
    const phase = rnd() * 10;
    g.strokeStyle = rnd() < 0.6 ? `rgba(40,20,8,${0.05 + rnd() * 0.12})` : `rgba(255,210,160,${0.03 + rnd() * 0.06})`;
    g.lineWidth = 0.6 + rnd() * 1.8;
    g.beginPath();
    for (let y = 0; y <= size; y += 16) {
      const x = x0 + Math.sin(y * freq + phase) * amp;
      if (y === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  return cv;
}
