// public/renderer3d.js — the Three.js board renderer (bare-bones first cut of the "Monopoly Plus"
// feel: a physical board on a table with a living city in the middle, metal tokens that hop, thrown
// dice, buildings that pop up and a camera that directs the action).
//
// Same contract as renderer2d.js (docs/CONTRACT.md §8), plus:
//   * render(state, events, myPlayerId) — draws the public state into <div id="board">. Never throws.
//     State is the truth; events only add animation. First render / reconnect / hidden tab /
//     prefers-reduced-motion / the "instant" speed → no animation. A newer state arriving
//     mid-animation is queued: everything plays faster (×1.5, ×2.25 with three waiting) until the
//     queue drains; with more than four waiting, the oldest land at once.
//   * dispose() — frees the WebGL context and everything else, empties its part of #board.
//   * busyUntil() — Date.now()-based time at which the running animation (and the queue behind it)
//     reaches its landing (0 when idle), so ui.js can hold its dialogs until the token has arrived.
//   * setOptions({ speed, camera, quality }) — speed 'normal' | 'fast' (≈1.8×, camera included) |
//     'instant' (snap; at most one summary sound per state); camera 'cinematic' | 'calm' | 'free';
//     quality 'auto' | 'low' | 'medium' | 'high' (forwarded to the stage).
// Full screen: the board is framed inside the part of #board ui.js leaves uncovered
// (#board.dataset.safeTop/Right/Bottom/Left, re-read on the window event 'monopoly:safearea').
// Sound: animation moments play sfx.js sounds through the choreography's named beats (never twice,
// never while skipping, never for a state seen before). ui.js plays the interface sounds.
// It owns everything inside #board, fetches /api/board itself and injects /r3d/r3d.css.
// Loaded lazily by renderer-switch.js; the pieces live in public/r3d/.

import * as THREE from './r3d/three.js';
import { Animator } from './r3d/tween.js';
import { createStage } from './r3d/stage.js';
import { createBoard } from './r3d/board.js';
import { TokenLayer } from './r3d/tokens.js';
import { Dice } from './r3d/dice.js';
import { Director } from './r3d/director.js';
import { Overlay } from './r3d/overlay.js';
import { City } from './r3d/city.js';
import { Fx } from './r3d/fx.js';
import { CardFlight } from './r3d/cards.js';
import { tileInfo } from './r3d/info.js';
import { HALF, tileAt } from './r3d/layout.js';
import { playBatch, snapTo, settle, aimCamera, estimate, summaryBeat, playBeatNow, celebrateSet, CATCH_UP, CATCH_UP_MAX, MAX_QUEUE } from './r3d/choreo.js';

export { onBeat } from './r3d/choreo.js'; // hook point for effects that ride on the choreography's beats

const PALETTE = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#e84393'];
const CLICK_SLOP = 6; // px a pointer may move and still count as a click rather than a drag
const WARMUP_MAX_MS = 4000; // draw anyway if background shader compilation hasn't finished by then
const AMBIENT_WINDOW_MS = 45_000; // idle life (city, current-player ring) runs this long after activity, then the GPU rests
// Debug handle (#board .r3d.__r3d, beat / sound logs): ?r3d-debug in the URL, or
// sessionStorage["monopoly.r3dDebug"] = "1" (ui.js rewrites the URL before this module loads).
const DEBUG = (() => {
  try {
    return new URLSearchParams(location.search).has('r3d-debug') || sessionStorage.getItem('monopoly.r3dDebug') === '1';
  } catch {
    return false;
  }
})();
const SPEED_RATE = { normal: 1, fast: 1.8 }; // animation time scale per speed setting ('instant' doesn't animate)
const SPEEDS = ['normal', 'fast', 'instant'];
const CAMERAS = ['cinematic', 'calm', 'free'];
const QUALITIES = ['auto', 'low', 'medium', 'high'];
// The same sound is never started twice within this many ms (dense hops, stacked beats).
const SOUND_GAP_MS = { hop: 35, diceBounce: 45, coin: 40 };
const SOUND_GAP_DEFAULT_MS = 80;
const LOG_CAP = 600; // debug logs (beats / sounds) keep this many entries
const TOKEN_WIDE_SCALE = 1.3; // tokens' figures in the overview (1 in close-ups)…
const TOKEN_SCALE_NEAR = 9; // …camera distance at which they are 1…
const TOKEN_SCALE_FAR = 14; // …and TOKEN_WIDE_SCALE

let BOARD = null;
let boardRetry = null;
let root = null; // <div class="r3d"> inside #board
let rootMsg = null; // message shown when there is no 3D view (loading, unsupported, context lost)
let view = null; // everything 3D (see createView)
let failure = null; // null | 'unsupported' | 'lost'
let gameId; // id of the game on screen
let lastSeq = null; // seq whose events have been played
let lastArgs = null; // [state, myPlayerId] of the latest render
// Renderer options (setOptions); kept across views so a re-created view starts with them. Until
// ui.js sends them they start from the saved settings (localStorage "monopoly.settings").
const options = { speed: 'normal', camera: 'cinematic', quality: 'auto' };
let qualityGiven = false; // the stage reads the saved quality itself unless we were told one
seedOptions();

injectStylesheet();
const [loadedBoard, sfx] = await Promise.all([loadBoard(), loadSfx()]);
BOARD = loadedBoard;
window.addEventListener('monopoly:safearea', () => { if (view) applySafeArea(view); });

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/**
 * Draws the public game state (CONTRACT §7) into #board. Cheap and idempotent: call it after every
 * state message. `events` (CONTRACT §6) only add animation; the result always converges on `state`.
 */
export function render(state, events, myPlayerId) {
  try {
    draw(state, Array.isArray(events) ? events : [], myPlayerId ?? null);
  } catch (err) {
    // A rendering bug must never take the rest of the UI down with it.
    console.error('[renderer3d] render failed:', err);
  }
}

/** Frees the GPU context and all resources and removes the 3D board from #board. */
export function dispose() {
  try {
    clearTimeout(boardRetry);
    boardRetry = null;
    teardownView();
    root?.remove();
    root = null;
    rootMsg = null;
    failure = null;
    gameId = undefined;
    lastSeq = null;
    lastArgs = null;
  } catch (err) {
    console.error('[renderer3d] dispose failed:', err);
  }
}

/**
 * When the running animation (and the queue behind it) reaches its landing (Date.now() ms), or 0 if
 * nothing is animating. ui.js: `app.dialogAt = Math.max(app.dialogAt, busyUntil())` after render().
 */
export function busyUntil() {
  try {
    if (!view) return 0;
    let s = view.animator.until(view.settleItem);
    for (const q of view.queue) s += estimate(q.events);
    s /= view.animator.rate;
    return s > 0 ? Date.now() + Math.round(s * 1000) : 0;
  } catch {
    return 0;
  }
}

/**
 * Renderer options (ui.js settings, forwarded by renderer-switch.js). Unknown keys / values are
 * ignored; may be called before the first render.
 * @param {{speed?:'normal'|'fast'|'instant', camera?:'cinematic'|'calm'|'free', quality?:'auto'|'low'|'medium'|'high'}} opts
 */
export function setOptions(opts) {
  try {
    if (!opts || typeof opts !== 'object') return;
    const prev = { ...options };
    if (SPEEDS.includes(opts.speed)) options.speed = opts.speed;
    if (CAMERAS.includes(opts.camera)) options.camera = opts.camera;
    if (QUALITIES.includes(opts.quality)) {
      options.quality = opts.quality;
      qualityGiven = true;
    }
    if (!view) return;
    if (prev.speed !== options.speed) {
      if (options.speed === 'instant') skip(); // anything still animating lands now
      updateRate(view);
    }
    if (prev.camera !== options.camera) applyCamera(view);
    if (prev.quality !== options.quality) applyQuality(view);
    view.stage.invalidate();
  } catch (err) {
    console.error('[renderer3d] setOptions failed:', err);
  }
}

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------

function injectStylesheet() {
  if (document.querySelector('link[href$="r3d/r3d.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/r3d/r3d.css';
  document.head.append(link);
}

/** Starts from the settings ui.js saved (they are forwarded properly by setOptions later). */
function seedOptions() {
  try {
    const saved = JSON.parse(localStorage.getItem('monopoly.settings') ?? 'null');
    if (SPEEDS.includes(saved?.speed)) options.speed = saved.speed;
    if (CAMERAS.includes(saved?.camera)) options.camera = saved.camera;
  } catch { /* no storage / bad JSON: defaults */ }
}

// sfx.js is optional for the board: without it (failed download, old cache) the board is silent.
async function loadSfx() {
  try {
    const mod = await import('./sfx.js');
    return mod?.sfx && typeof mod.sfx.play === 'function' ? mod.sfx : null;
  } catch (err) {
    console.warn('[renderer3d] no sound effects:', err);
    return null;
  }
}

// Never rejects (a failed import would take the switch down): render() retries while BOARD is null.
async function loadBoard() {
  try {
    const res = await fetch('/api/board');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const board = await res.json();
    if (!Array.isArray(board?.tiles) || board.tiles.length !== 40) throw new Error('unexpected board data');
    return board;
  } catch (err) {
    console.warn('[renderer3d] could not load /api/board:', err);
    return null;
  }
}

function retryBoardLoad() {
  if (boardRetry) return;
  boardRetry = setTimeout(async () => {
    BOARD = await loadBoard();
    boardRetry = null;
    if (BOARD && lastArgs && root) render(lastArgs[0], [], lastArgs[1]);
  }, 2000);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * Asks renderer-switch.js to change mode (keeps this module free of a dependency on it).
 * `paused` ('lost' | 'unsupported'): 3D gave up; the switch shows 2D without saving the choice.
 */
function requestMode(mode, { persist = true, paused = null } = {}) {
  window.dispatchEvent(new CustomEvent('monopoly:renderer', { detail: { mode, persist, paused } }));
}

// ---------------------------------------------------------------------------------------------
// The 3D view
// ---------------------------------------------------------------------------------------------

function createView(host) {
  const animator = new Animator({
    onActive: () => v.stage?.invalidate(),
    // Frames stopped arriving (hidden / occluded view): land the camera too, then draw once.
    onBackstop: () => {
      v.director?.snap();
      if (v.tokens) tokenScale(v);
      v.overlay?.update();
      v.stage?.renderNow();
    },
  });
  const v = {
    animator, BOARD, fresh: true, latest: null, ambientUntil: 0, batchSeq: 0,
    running: null, // id of the batch whose timeline is playing
    queue: [], // newer states waiting for it: [{ ctx, events, before? }]
    settleItem: null,
    lastTrade: null,
  };
  const stage = createStage(host, {
    onFrame: (dt) => {
      const a = animator.step(dt);
      const c = v.director.update(dt);
      tokenScale(v);
      const f = v.overlay.update();
      return a || c || f;
    },
    onAmbient: (now) => {
      if (reducedMotion() || now > v.ambientUntil) return false;
      const a = v.tokens.ambient(now);
      const b = v.board.ambient(now);
      const c = v.city.ambient(now);
      return a || b || c;
    },
    onResize: () => {
      if (!v.director) return;
      v.director.onResize();
      v.overlay.setSafeArea(readSafeArea());
      v.overlay.update();
    },
    onContextLost: () => contextLost(),
    quality: qualityGiven ? options.quality : undefined,
  });
  v.stage = stage;
  try {
    const deps = { renderer: stage.renderer, animator, markShadows: stage.markShadows };
    v.fx = new Fx(stage.scene, animator);
    const board = createBoard(BOARD, { ...deps, fx: v.fx });
    stage.scene.add(board.group);
    v.board = board;
    v.city = new City(stage.scene, BOARD, { ...deps, fx: v.fx });
    // A colour set completed: the district celebrates by itself; the choreography adds the cheer.
    v.city.onCelebrate = (group) => celebrateSet(v, group);
    v.tokens = new TokenLayer(stage.scene, animator, stage.markShadows, Number.isInteger(BOARD.jailIndex) ? BOARD.jailIndex : 10);
    v.dice = new Dice(stage.scene, animator, stage.markShadows, stage.renderer.capabilities.getMaxAnisotropy());
    v.cards = new CardFlight(stage.scene, stage.camera, animator, board, stage.size);
    v.overlay = new Overlay(host, {
      camera: stage.camera,
      size: stage.size,
      isQuiet: () => animator.finishing,
      onReset: () => resetCamera(),
      onFreeLook: () => setFreeLook(!v.director.pinned),
    });
    v.director = new Director(stage.camera, stage.controls, {
      size: stage.size,
      onWake: () => stage.invalidate(),
      onChange: (s) => {
        v.overlay?.setFreeCam(s);
        updateTouch(v);
      },
    });
    v.director.instant = reducedMotion() || options.speed === 'instant';
    v.info = makeInfo();
    v.sound = makeSound(v);
    v.onBatchDone = () => nextBatch(v);
    if (DEBUG) {
      v.beatLog = cappedLog();
      v.soundLog = cappedLog();
    }
    applyCamera(v);
    applyQuality(v);
    applySafeArea(v, { snap: true });
    updateRate(v);
    wireInput(v);
  } catch (err) {
    stage.dispose();
    throw err;
  }
  if (DEBUG) host.__r3d = v;
  return v;
}

/**
 * Tokens read in wide shots: their figures grow up to TOKEN_WIDE_SCALE as the camera pulls back
 * (tokens.setDisplayScale, when the layer has it). Quantised, so shadows aren't redrawn every frame.
 */
function tokenScale(v) {
  if (typeof v.tokens.setDisplayScale !== 'function') return;
  const d = v.stage.camera.position.distanceTo(v.stage.controls.target);
  const f = Math.min(1, Math.max(0, (d - TOKEN_SCALE_NEAR) / (TOKEN_SCALE_FAR - TOKEN_SCALE_NEAR)));
  const k = Math.round((1 + (TOKEN_WIDE_SCALE - 1) * f) * 20) / 20;
  if (k !== v.tokenScale) {
    v.tokenScale = k;
    v.tokens.setDisplayScale(k);
  }
}

/** An array that forgets its oldest entries past LOG_CAP (debug logs). */
function cappedLog() {
  const log = [];
  const push = log.push.bind(log);
  log.push = (...items) => {
    push(...items);
    if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
    return log.length;
  };
  return log;
}

// ---- options ------------------------------------------------------------------------------------

/** Animation time scale: the speed setting × catching up on queued states. */
function updateRate(v) {
  const n = v.queue.length;
  const catchUp = n === 0 ? 1 : n >= 3 ? CATCH_UP_MAX : CATCH_UP;
  const rate = (SPEED_RATE[options.speed] ?? 1) * catchUp;
  v.animator.rate = rate;
  v.director.setRate(rate);
  v.director.instant = reducedMotion() || options.speed === 'instant';
}

/** Camera style → the director (and, in free style, orbiting on phones too). */
function applyCamera(v) {
  v.director.setStyle(options.camera);
  v.overlay.setFreeCam({ suspended: v.director.suspended, pinned: v.director.pinned, style: v.director.style });
  updateTouch(v);
  if (options.camera !== 'free' && v.latest && !v.animator.busy) aimCamera(v, v.latest);
}

function applyQuality(v) {
  if (!qualityGiven) return; // the stage started from the saved setting
  try {
    v.stage.setQuality?.(options.quality);
  } catch (err) {
    console.error('[renderer3d] setQuality failed:', err);
  }
}

/**
 * Phones: one finger orbits only when it can't be scrolling the page instead — full-screen 3D
 * (body.board-3d, ui.js), the free camera style, or ✋ pinned.
 */
function updateTouch(v) {
  if (!v.stage?.touchFirst || !v.director) return;
  const fullScreen = document.body?.classList.contains('board-3d');
  v.stage.setFreeLook(!!(fullScreen || v.director.pinned || v.director.style === 'free'));
}

// ---- safe area (full screen: the part of #board ui.js leaves uncovered) ------------------------------

/** #board.dataset.safeTop/Right/Bottom/Left (CSS px covered by ui.js; 0 when absent). */
function readSafeArea() {
  const d = document.getElementById('board')?.dataset ?? {};
  const n = (s) => {
    const x = Number.parseFloat(s);
    return Number.isFinite(x) && x > 0 ? x : 0;
  };
  return { top: n(d.safeTop), right: n(d.safeRight), bottom: n(d.safeBottom), left: n(d.safeLeft) };
}

function applySafeArea(v, { snap = false } = {}) {
  const insets = readSafeArea();
  v.overlay.setSafeArea(insets);
  if (v.director.setSafeArea(insets, { snap })) v.stage.invalidate();
  updateTouch(v);
  v.overlay.update();
}

// ---- sound ------------------------------------------------------------------------------------------

/**
 * view.sound(name, opts): plays an sfx.js sound for an animation moment. Silent when there is no
 * sfx module, while skipping (finishAll), in a hidden tab, at the "instant" speed (except the one
 * summary sound, `summary: true`), and for the same sound started within SOUND_GAP_MS.
 */
function makeSound(v) {
  const last = new Map(); // name → [real ms, animation s] of its last start
  return (name, opts = {}) => {
    const { summary = false, ...play } = opts ?? {};
    if (!sfx || view !== v || v.animator.finishing || document.hidden) return false;
    if (options.speed === 'instant' && !summary) return false;
    const now = performance.now();
    const anim = v.animator.time;
    const gap = SOUND_GAP_MS[name] ?? SOUND_GAP_DEFAULT_MS;
    const prev = last.get(name);
    // A duplicate only if it is close on both clocks (the timeline can be stepped faster than real
    // time, and a still timeline — "instant" summaries — doesn't advance animation time).
    if (prev && now - prev[0] < gap && anim - prev[1] < gap / 1000) return false;
    last.set(name, [now, anim]);
    try {
      sfx.play(name, play);
    } catch (err) {
      console.warn('[renderer3d] sound failed:', err);
    }
    v.soundLog?.push({ name, t: now, at: anim, volume: play.volume ?? 1, rate: play.rate ?? 1 });
    return true;
  };
}

/**
 * Pointer: a click / tap (not a drag) skips the running animation, or — when nothing animates —
 * shows the tile info card. Dragging / the wheel hands the camera to the player (OrbitControls; on
 * phones only where one finger can't mean scrolling the page — see updateTouch).
 */
function wireInput(v) {
  const { canvas, controls } = v.stage;
  let down = null;
  const onDown = (e) => {
    down = { x: e.clientX, y: e.clientY, moved: false };
    v.ambientUntil = performance.now() + AMBIENT_WINDOW_MS;
  };
  const onMove = (e) => {
    if (!down) return;
    if (!down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP) down.moved = true;
    if (down.moved && controls.enabled) v.director.suspend(); // keeps the auto-resume timer fresh
  };
  const onUp = (e) => {
    if (down && !down.moved) click(e);
    down = null;
  };
  const onCancel = () => { down = null; };
  const onStart = () => { if (controls.enabled) v.director.suspend(); }; // drag / wheel began
  const onKey = (e) => {
    if (e.key === 'Escape' && root?.isConnected) {
      skip();
      view?.overlay.hideInfo();
    }
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);
  controls.addEventListener('start', onStart);
  document.addEventListener('keydown', onKey);
  v.unwire = () => {
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onCancel);
    controls.removeEventListener('start', onStart);
    document.removeEventListener('keydown', onKey);
  };
}

const ray = new THREE.Raycaster();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function click(e) {
  if (!view) return;
  if (view.animator.busy) {
    skip();
    return;
  }
  const { overlay, stage } = view;
  if (overlay.infoShown) {
    overlay.hideInfo();
    return;
  }
  const rect = stage.canvas.getBoundingClientRect();
  if (!rect.width || !rect.height || !view.latest) return;
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1));
  ray.setFromCamera(ndc, stage.camera);
  const hit = ray.ray.intersectPlane(plane, new THREE.Vector3());
  const i = hit ? tileAt(hit.x + HALF, hit.z + HALF) : null;
  const data = i === null ? null : tileInfo(BOARD, view.latest, i);
  if (data) overlay.showInfo(data, { x: e.clientX - rect.left, y: e.clientY - rect.top });
}

/**
 * Fast-forwards whatever is animating — and every state queued behind it — to the latest state
 * (silently: beats don't fire while skipping).
 */
function skip() {
  if (!view) return;
  view.animator.finishAll();
  updateRate(view);
  view.overlay.hideCard();
  view.cards.hide();
  view.overlay.update();
  view.stage.invalidate();
}

/** ✋: free camera on / off (pinned: the director keeps out until ✋ again or ⟲). */
function setFreeLook(on) {
  if (!view) return;
  view.director.pin(on);
  updateTouch(view);
  if (!on) resetCamera();
}

/** ⟲: the director takes the camera back (free style: one glide back to the whole board). */
function resetCamera() {
  if (!view) return;
  if (view.latest && view.director.style !== 'free') aimCamera(view, view.latest);
  view.director.recenter();
  updateTouch(view);
  view.stage.invalidate();
}

function teardownView() {
  if (!view) return;
  const v = view;
  view = null;
  v.animator.clear();
  v.unwire?.();
  v.director?.dispose();
  v.cards?.dispose();
  v.overlay?.dispose();
  // Listeners and caches the scene doesn't own (the stage frees the GPU side of everything else).
  for (const part of [v.fx, v.city, v.board]) {
    try {
      part?.dispose?.();
    } catch (err) {
      console.warn('[renderer3d] dispose failed:', err);
    }
  }
  v.stage.dispose();
  if (root) delete root.__r3d;
}

function contextLost() {
  console.warn('[renderer3d] WebGL context lost');
  teardownView();
  failure = 'lost';
  requestMode('2d', { persist: false, paused: 'lost' }); // the switch falls back to 2D (this page only)
  if (lastArgs && root) render(lastArgs[0], [], lastArgs[1]); // no switch listening: show the message
}

function showRootMessage(text, actions) {
  if (!root) return;
  if (!rootMsg) {
    rootMsg = el('div', 'r3d-msg');
    root.append(rootMsg);
  }
  rootMsg.replaceChildren(el('p', null, text));
  for (const a of actions) {
    const b = el('button', 'r3d-msg-btn', a.label);
    b.type = 'button';
    b.addEventListener('click', a.onClick);
    rootMsg.append(b);
  }
}

function clearRootMessage() {
  rootMsg?.remove();
  rootMsg = null;
}

// ---------------------------------------------------------------------------------------------
// Per-render update
// ---------------------------------------------------------------------------------------------

function draw(state, events, me) {
  lastArgs = [state, me];
  const host = document.getElementById('board');
  if (!host) return;
  if (!root) {
    root = el('div', 'r3d');
    root.setAttribute('aria-label', 'Game board (3D)');
  }
  if (root.parentNode !== host) host.replaceChildren(root);

  if (!BOARD) {
    showRootMessage('Loading board…', []);
    retryBoardLoad();
    return;
  }
  if (failure) {
    showFailure();
    return;
  }
  if (!view) {
    try {
      view = createView(root);
    } catch (err) {
      console.warn('[renderer3d] WebGL unavailable:', err);
      failure = 'unsupported';
      requestMode('2d', { persist: false, paused: 'unsupported' }); // the switch falls back to 2D
      showFailure(); // (only visible if nothing took over #board)
      return;
    }
    clearRootMessage();
    gameId = undefined;
    warmUp(view);
  }
  if (!state || typeof state !== 'object') {
    view.stage.renderSoon();
    return;
  }

  if (state.id !== gameId) {
    gameId = state.id;
    lastSeq = null;
    resetGame();
  }
  // Each engine action bumps seq; re-rendering the same seq must not replay its events.
  let newSeq = false;
  if (typeof state.seq === 'number') {
    if (state.seq === lastSeq) events = [];
    else newSeq = true;
    lastSeq = state.seq;
  }

  const ctx = makeCtx(state, me);
  const { animator } = view;
  view.stage.measure(); // the canvas is 0×0 while #board is hidden: nothing to animate then
  const instant = options.speed === 'instant' || reducedMotion();
  const canAnimate = !view.fresh && !document.hidden && !instant && view.stage.size.w > 0;
  const running = view.running !== null && animator.busy;
  const isNew = newSeq || events.length > 0;
  const fresh = view.fresh;
  view.latest = ctx;
  updateTouch(view);

  if (fresh || !canAnimate) {
    view.queue = [];
    animator.finishAll(); // the previous batch lands on its own state first (silently)
    view.running = null;
    updateRate(view);
    snapTo(view, ctx, { resetCamera: fresh, snapCamera: true, events: fresh ? [] : events });
    view.fresh = false;
    // Nothing animates, but a new state still gets its one most important sound.
    if (!fresh && isNew && instant) {
      const name = summaryBeat(events);
      if (name) playBeatNow(view, name, { soundOpts: { summary: true } });
    }
  } else if (!isNew) {
    // The same state re-sent (connection flag, turn timer): a running timeline settles on it anyway.
    if (!running) settle(view, ctx, { animate: true });
  } else if (running) {
    // A newer state mid-animation: it plays after the running one, and everything speeds up until
    // the queue drains. Far behind, the oldest waiting states land at once (in order).
    view.queue.push({ ctx, events });
    while (view.queue.length > MAX_QUEUE) {
      const old = view.queue.shift();
      view.queue[0].before = old.before ?? old.ctx; // land this state (no animation) before playing the next
    }
    updateRate(view);
  } else {
    playBatch(view, ctx, events);
  }
  if (view.overlay.infoShown && isNew) view.overlay.hideInfo();
  tokenScale(view);
  view.overlay.update();
  view.ambientUntil = performance.now() + AMBIENT_WINDOW_MS;
  view.stage.renderSoon(); // a correct frame even if requestAnimationFrame is paused
}

/** The running batch settled: play the next queued state (landing skipped ones first). */
function nextBatch(v) {
  if (view !== v) return;
  const q = v.queue.shift();
  updateRate(v);
  if (!q) return;
  if (q.before) settle(v, q.before, { animate: false });
  playBatch(v, q.ctx, q.events);
}

/**
 * The first frame would compile every shader on the main thread (~0.5–1 s of frozen page). Compile
 * them in the background instead (KHR_parallel_shader_compile where available) behind a small
 * "Loading 3D…" note, then start drawing.
 */
function warmUp(v) {
  const { stage } = v;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (view !== v) return;
    stage.setHold(false);
    clearRootMessage();
    stage.renderSoon();
  };
  const timer = setTimeout(finish, WARMUP_MAX_MS);
  try {
    const p = stage.renderer.compileAsync?.(stage.scene, stage.camera);
    if (!p) return finish();
    stage.setHold(true);
    showRootMessage('Loading 3D…', []);
    rootMsg?.classList.add('is-quiet');
    p.then(finish, finish);
  } catch {
    finish();
  }
}

function showFailure() {
  if (failure === 'lost') {
    showRootMessage('3D paused: the graphics context was lost.', [
      { label: 'Try again', onClick: () => { failure = null; clearRootMessage(); if (lastArgs) render(lastArgs[0], [], lastArgs[1]); } },
      { label: 'Use 2D', onClick: () => requestMode('2d') },
    ]);
  } else {
    showRootMessage("3D isn't supported on this device — use 2D.", [
      { label: 'Use 2D board', onClick: () => requestMode('2d') },
    ]);
  }
}

/** A different game is on screen: forget tokens, animations and caches. */
function resetGame() {
  if (!view) return;
  view.animator.clear();
  view.running = null;
  view.queue = [];
  view.settleItem = null;
  view.lastTrade = null;
  updateRate(view);
  view.tokens.clear();
  view.board.reset();
  view.city.reset();
  view.fx.clear();
  view.cards.hide();
  view.overlay.reset();
  view.director.resume();
  view.fresh = true;
}

function makeCtx(state, me) {
  const players = (Array.isArray(state.players) ? state.players : []).filter((p) => p && typeof p === 'object' && p.id != null);
  const turn = state.turn && typeof state.turn === 'object' ? state.turn : {};
  const order = Array.isArray(turn.order) ? turn.order : [];
  return {
    state,
    turn,
    me,
    players,
    byId: new Map(players.map((p) => [p.id, p])),
    colorOf: new Map(players.map((p, i) => [p.id, PALETTE[i % PALETTE.length]])),
    tileState: new Map((Array.isArray(state.tiles) ? state.tiles : []).filter(Boolean).map((t) => [t.index, t])),
    live: state.status === 'active' || state.status === 'finished',
    active: state.status === 'active',
    currentId: order[turn.currentIndex] ?? null,
  };
}

/** Text for the overlay (names, emoji, colours). */
function makeInfo() {
  const emoji = (tokenId) => BOARD.tokens?.find((t) => t.id === tokenId)?.emoji ?? '●';
  return {
    name: (ctx, id) => String(ctx.byId.get(id)?.name ?? 'Someone'),
    turn(ctx) {
      if (!ctx.live) return { id: '', label: 'Waiting for the game to start', emoji: '⏳', color: '#9aa39e', meta: '' };
      const cur = ctx.active ? ctx.byId.get(ctx.currentId) : null;
      if (!cur) return ctx.state.status === 'finished' ? { id: '', label: 'Game over', emoji: '🏁', color: '#9aa39e', meta: '' } : null;
      const number = Number.isInteger(ctx.turn.number) && ctx.turn.number > 0 ? ctx.turn.number : null;
      return {
        id: cur.id,
        name: String(cur.name ?? ''),
        emoji: emoji(cur.token),
        color: ctx.colorOf.get(cur.id),
        me: cur.id === ctx.me,
        meta: [cur.inJail && 'in jail', number && `turn ${number}`].filter(Boolean).join(' · '),
      };
    },
    winner(ctx) {
      if (ctx.state.status !== 'finished') return null;
      const w = ctx.byId.get(ctx.state.winnerId);
      return w
        ? { name: String(w.name ?? ''), emoji: emoji(w.token), color: ctx.colorOf.get(w.id), me: w.id === ctx.me }
        : { name: 'Nobody', emoji: '', color: '#e0a800', me: false };
    },
  };
}
