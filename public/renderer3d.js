// public/renderer3d.js — the Three.js board renderer (bare-bones first cut of the "Monopoly Plus"
// feel: a physical board on a table with a living city in the middle, metal tokens that hop, thrown
// dice, buildings that pop up and a camera that directs the action).
//
// Same contract as renderer2d.js (docs/CONTRACT.md §8), plus:
//   * render(state, events, myPlayerId) — draws the public state into <div id="board">. Never throws.
//     State is the truth; events only add animation. First render / reconnect / hidden tab /
//     prefers-reduced-motion → no animation. A newer state arriving mid-animation speeds the running
//     one up (×3) and plays next; a third one lands everything and plays the newest.
//   * dispose() — frees the WebGL context and everything else, empties its part of #board.
//   * busyUntil() — Date.now()-based time at which the running animation reaches its landing
//     (0 when idle), so ui.js can hold its dialogs until the token has arrived.
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
import { playBatch, snapTo, settle, aimCamera, estimate, QUEUE_SPEEDUP } from './r3d/choreo.js';

const PALETTE = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#e84393'];
const CLICK_SLOP = 6; // px a pointer may move and still count as a click rather than a drag
const WARMUP_MAX_MS = 4000; // draw anyway if background shader compilation hasn't finished by then
const AMBIENT_WINDOW_MS = 45_000; // idle life (city, current-player ring) runs this long after activity, then the GPU rests
const DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('r3d-debug');

let BOARD = null;
let boardRetry = null;
let root = null; // <div class="r3d"> inside #board
let rootMsg = null; // message shown when there is no 3D view (loading, unsupported, context lost)
let view = null; // everything 3D (see createView)
let failure = null; // null | 'unsupported' | 'lost'
let gameId; // id of the game on screen
let lastSeq = null; // seq whose events have been played
let lastArgs = null; // [state, myPlayerId] of the latest render

injectStylesheet();
BOARD = await loadBoard();

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
 * When the running animation reaches its landing (Date.now() ms), or 0 if nothing is animating.
 * ui.js: `app.dialogAt = Math.max(app.dialogAt, busyUntil())` after render().
 */
export function busyUntil() {
  try {
    if (!view) return 0;
    let s = view.animator.until(view.settleItem);
    if (view.queued) s += estimate(view.queued.events);
    return s > 0 ? Date.now() + Math.round(s * 1000) : 0;
  } catch {
    return 0;
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
      v.stage?.renderNow();
    },
  });
  const v = { animator, BOARD, fresh: true, latest: null, ambientUntil: 0, batchSeq: 0, running: null, queued: null, settleItem: null };
  const stage = createStage(host, {
    onFrame: (dt) => {
      const a = animator.step(dt);
      const c = v.director.update(dt);
      const f = v.overlay.updateFloats();
      return a || c || f;
    },
    onAmbient: (now) => {
      if (reducedMotion() || now > v.ambientUntil) return false;
      const a = v.tokens.ambient(now);
      const b = v.board.ambient(now);
      const c = v.city.ambient(now);
      return a || b || c;
    },
    onResize: () => v.director?.onResize(),
    onContextLost: () => contextLost(),
  });
  v.stage = stage;
  try {
    const deps = { renderer: stage.renderer, animator, markShadows: stage.markShadows };
    v.fx = new Fx(stage.scene, animator);
    const board = createBoard(BOARD, { ...deps, fx: v.fx });
    stage.scene.add(board.group);
    v.board = board;
    v.city = new City(stage.scene, BOARD, { ...deps, fx: v.fx });
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
        if (!s.pinned && stage.touchFirst) stage.setFreeLook(false);
      },
    });
    v.director.instant = reducedMotion();
    v.info = makeInfo();
    wireInput(v);
  } catch (err) {
    stage.dispose();
    throw err;
  }
  if (DEBUG) host.__r3d = v;
  return v;
}

/**
 * Pointer: a click / tap (not a drag) skips the running animation, or — when nothing animates —
 * shows the tile info card. Dragging / the wheel hands the camera to the player (OrbitControls; on
 * phones only after ✋, so one finger keeps scrolling the page).
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

/** Fast-forwards whatever is animating to the current state. */
function skip() {
  if (!view) return;
  view.animator.finishAll();
  view.overlay.hideCard();
  view.cards.hide();
  view.stage.invalidate();
}

/** ✋: free camera on / off (pinned: the director keeps out until ✋ again or ⟲). */
function setFreeLook(on) {
  if (!view) return;
  if (on && view.stage.touchFirst) view.stage.setFreeLook(true);
  view.director.pin(on);
  if (!on) resetCamera();
}

function resetCamera() {
  if (!view) return;
  if (view.stage.touchFirst) view.stage.setFreeLook(false);
  view.director.resume();
  if (view.latest) aimCamera(view, view.latest);
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
  view.director.instant = reducedMotion();
  view.stage.measure(); // the canvas is 0×0 while #board is hidden: nothing to animate then
  const canAnimate = !view.fresh && !document.hidden && !reducedMotion() && view.stage.size.w > 0;
  const running = view.running !== null && animator.busy;
  const isNew = newSeq || events.length > 0;
  view.latest = ctx;

  if (view.fresh || !canAnimate) {
    view.queued = null;
    animator.finishAll(); // the previous batch lands on its own state first
    view.running = null;
    snapTo(view, ctx, { resetCamera: view.fresh, snapCamera: true, events: view.fresh ? [] : events });
    view.fresh = false;
  } else if (!isNew) {
    // The same state re-sent (connection flag, turn timer): a running timeline settles on it anyway.
    if (!running) settle(view, ctx, { animate: true });
  } else if (running && !view.queued) {
    // A newer state mid-animation: finish the running one quickly, then play this one.
    animator.compress(QUEUE_SPEEDUP);
    view.queued = { ctx, events };
  } else if (running) {
    // A third state: land everything so far and play the newest.
    const q = view.queued;
    view.queued = null;
    animator.finishAll();
    view.running = null;
    settle(view, q.ctx, { animate: false });
    playBatch(view, ctx, events);
  } else {
    playBatch(view, ctx, events);
  }
  if (view.overlay.infoShown && isNew) view.overlay.hideInfo();
  view.ambientUntil = performance.now() + AMBIENT_WINDOW_MS;
  view.stage.renderSoon(); // a correct frame even if requestAnimationFrame is paused
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
  view.queued = null;
  view.settleItem = null;
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
