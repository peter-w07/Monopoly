// public/renderer-switch.js — picks the board renderer (2D DOM or 3D Three.js) and forwards to it.
//
// Drop-in replacement for renderer2d.js from ui.js's point of view: it exports the same
// render(state, events, myPlayerId), and owns everything inside <div id="board"> by delegating to
// exactly one renderer at a time. Extra API:
//   getMode() → '2d' | '3d'      setMode(mode, {persist})      onModeChange(cb) → unsubscribe
//                                 (cb runs before the board is redrawn, so the page can switch
//                                 its layout first and the new renderer is built at its final size)
//   getStatus() → { mode, view, loading, unsupported, paused, failed }
//                                 view = the renderer on screen ('2d' | '3d' | null before the first
//                                 render); loading = 3D is wanted but not on screen yet
//   onStatus(cb) → unsubscribe    cb(status) whenever anything in getStatus() changes
//   probe3d() → boolean           checks for WebGL2 now (cached) — e.g. when a 3D button is pointed at
//   setOptions({ speed, camera, quality }) / getOptions()
//                                 remembered and forwarded to the active renderer's setOptions?.(),
//                                 to 3D right after it loads, and to each renderer as it takes over
//   setBoardToggle(visible)       show / hide the small built-in 2D|3D toggle inside #board
//   busyUntil()                   Date.now() ms when the board's running animation reaches its
//                                 landing (0 when idle / in 2D) — ui.js holds dialogs until then
//
// * The choice is remembered in localStorage 'monopoly.renderer' (default '2d'); `?renderer=3d`
//   in the URL overrides it for that page load without saving.
// * renderer2d.js is imported statically (instant). renderer3d.js and three.js are only
//   downloaded when 3D is chosen; the 2D board stays on screen (under a "Loading 3D…" veil) until
//   they are ready. WebGL2 is only probed when 3D is wanted (or its button is pointed at).
// * Switching disposes the old renderer (if it has dispose()), empties #board and re-renders the
//   latest state with no events, so the new renderer snaps into place without replaying anything.
// * No WebGL2, a failed download or a lost GPU context fall back to the 2D board for this page
//   (the saved choice is kept); the toggle's 3D button then says why and retries on click.

import * as r2d from './renderer2d.js';

const STORAGE_KEY = 'monopoly.renderer';
const MODES = ['2d', '3d'];
const EVENT = 'monopoly:renderer'; // renderer3d asks for a mode change with this window event

let mode = initialMode();
let active = null; // the renderer that currently owns #board: r2d | r3d
let r3d = null; // renderer3d module once loaded
let loading3d = null; // Promise while downloading
let loadFailed = false;
let paused = null; // null | 'lost' | 'unsupported': 3D gave up on this page
let webgl2 = null; // cached capability probe (null = not probed yet)
let last = null; // { state, myPlayerId } of the latest render
let toggle = null;
let toggleVisible = true;
let veil = null;
let swapTimer = 0;
let swapReady = false;
let options = {}; // renderer options from ui.js ({ speed, camera, quality }), see setOptions
let statusSig = ''; // getStatus() as last reported to status listeners
const listeners = new Set();
const statusListeners = new Set();

injectStyles();
window.addEventListener(EVENT, (e) => {
  const d = e?.detail ?? {};
  if (d.paused) pause(d.paused);
  else if (MODES.includes(d.mode)) setMode(d.mode, { persist: d.persist !== false });
});
if (mode === '3d' && supportsWebGL2()) ensure3d(); // start the download before the first render

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/** Same contract as renderer2d.render (docs/CONTRACT.md §8). Never throws. */
export function render(state, events, myPlayerId) {
  last = { state, myPlayerId: myPlayerId ?? null };
  try {
    draw(Array.isArray(events) ? events : []);
  } catch (err) {
    console.error('[renderer-switch] render failed:', err);
  }
}

export function getMode() {
  return mode;
}

/** Switches to '2d' or '3d' (remembered unless persist is false). */
export function setMode(next, { persist = true } = {}) {
  if (!MODES.includes(next)) return;
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch { /* storage blocked: the choice lasts for this page only */ }
  }
  if (next === '3d') {
    paused = null; // an explicit 3D request retries
    loadFailed = false;
  }
  if (next === mode) {
    refresh();
    return;
  }
  mode = next;
  notify();
  if (mode === '3d' && supportsWebGL2()) ensure3d();
  if (last) render(last.state, [], last.myPlayerId);
  else refresh();
}

/**
 * Calls cb(mode) whenever the mode changes — before the board is redrawn for it. Returns an
 * unsubscribe function.
 */
export function onModeChange(cb) {
  if (typeof cb !== 'function') return () => {};
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** What the board is doing, for view controls outside #board (see the header comment). */
export function getStatus() {
  const view = !active ? null : active === r3d && r3d ? '3d' : '2d';
  return {
    mode,
    view,
    loading: mode === '3d' && view !== '3d',
    unsupported: webgl2 === false,
    paused,
    failed: loadFailed,
  };
}

/** Calls cb(getStatus()) whenever the status changes. Returns an unsubscribe function. */
export function onStatus(cb) {
  if (typeof cb !== 'function') return () => {};
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

/** Probes WebGL2 now (once per page; cheap afterwards). True when the 3D board can run. */
export function probe3d() {
  const ok = supportsWebGL2();
  refresh();
  return ok;
}

/**
 * Renderer options ({ speed: 'normal'|'fast'|'instant', camera: 'cinematic'|'calm'|'free',
 * quality: 'auto'|'low'|'medium'|'high' }; any subset). Remembered here and forwarded to the
 * active renderer's setOptions?.() now, to the 3D renderer as soon as it has loaded, and to each
 * renderer again when it takes over #board. Renderers ignore what they don't use.
 */
export function setOptions(opts) {
  if (!opts || typeof opts !== 'object') return;
  options = { ...options, ...opts };
  forwardOptions(active);
}

export function getOptions() {
  return { ...options };
}

/** Shows or hides the small 2D|3D toggle drawn inside #board (e.g. when ui.js offers its own). */
export function setBoardToggle(visible) {
  toggleVisible = !!visible;
  if (!toggleVisible) toggle?.remove();
  else if (last) mountToggle();
}

/** When the running board animation reaches its landing (Date.now() ms), or 0. */
export function busyUntil() {
  try {
    return Number(active?.busyUntil?.()) || 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------------------

function initialMode() {
  try {
    const q = new URLSearchParams(location.search).get('renderer');
    if (MODES.includes(q)) return q;
  } catch { /* no location */ }
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (MODES.includes(saved)) return saved;
  } catch { /* storage blocked */ }
  return '2d';
}

function notify() {
  for (const cb of listeners) {
    try {
      cb(mode);
    } catch (err) {
      console.error('[renderer-switch] mode listener failed:', err);
    }
  }
  refresh();
}

/** Updates the in-board toggle and tells status listeners, if anything in getStatus() changed. */
function refresh() {
  updateToggle();
  const status = getStatus();
  const sig = JSON.stringify(status);
  if (sig === statusSig) return;
  statusSig = sig;
  for (const cb of statusListeners) {
    try {
      cb({ ...status });
    } catch (err) {
      console.error('[renderer-switch] status listener failed:', err);
    }
  }
}

function forwardOptions(target) {
  if (!target) return;
  try {
    target.setOptions?.({ ...options });
  } catch (err) {
    console.error('[renderer-switch] setOptions failed:', err);
  }
}

/** 3D can't go on: show 2D for this page (the saved choice stays), and say why on the toggle. */
function pause(reason) {
  paused = reason;
  if (reason === 'unsupported') webgl2 = webgl2 ?? false;
  cancelSwap();
  if (mode !== '2d') {
    mode = '2d';
    notify();
    if (last) render(last.state, [], last.myPlayerId);
  }
  refresh();
}

/** WebGL2 is required by three.js r163+. The probe context is released straight away. */
function supportsWebGL2() {
  if (webgl2 !== null) return webgl2;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    webgl2 = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    webgl2 = false;
  }
  return webgl2;
}

function ensure3d() {
  if (r3d || loading3d) return loading3d;
  loading3d = import('./renderer3d.js')
    .then((mod) => {
      r3d = mod;
      loading3d = null;
      forwardOptions(r3d); // before it builds anything
      if (mode === '3d' && last) render(last.state, [], last.myPlayerId);
      else refresh();
      return mod;
    })
    .catch((err) => {
      console.warn('[renderer-switch] could not load the 3D renderer:', err);
      loading3d = null;
      loadFailed = true;
      if (mode === '3d') {
        mode = '2d'; // this page only: the saved choice stays, so a reload retries
        notify();
        if (last) render(last.state, [], last.myPlayerId);
      }
      refresh();
    });
  refresh();
  return loading3d;
}

function draw(events) {
  let target = r2d;
  if (mode === '3d') {
    if (!supportsWebGL2()) {
      pause('unsupported'); // renders 2D itself
      return;
    }
    if (!r3d) ensure3d(); // keep showing 2D until the download finishes
    else if (active === r3d || swapReady) target = r3d;
    else scheduleSwap();
  }
  swapReady = false;
  const switched = use(target);
  target.render(last.state, switched ? [] : events, last.myPlayerId);
  mountToggle();
  mountVeil();
  refresh();
}

/**
 * Building the 3D view blocks the page for a moment: put a "Loading 3D…" veil over the 2D board,
 * let it paint, then swap.
 */
function scheduleSwap() {
  if (swapTimer) return;
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    clearTimeout(swapTimer);
    swapTimer = 0;
    if (mode !== '3d' || !r3d || !last) return;
    swapReady = true;
    render(last.state, [], last.myPlayerId);
  };
  swapTimer = setTimeout(go, 120); // requestAnimationFrame may be paused (hidden / occluded view)
  requestAnimationFrame(() => setTimeout(go, 0));
}

function cancelSwap() {
  clearTimeout(swapTimer);
  swapTimer = 0;
  swapReady = false;
}

/**
 * Makes `target` the owner of #board. Returns true if it just took over. It gets the current
 * options, and status listeners hear about the new view, before it draws anything.
 */
function use(target) {
  if (active === target) return false;
  const prev = active;
  active = target;
  if (prev) {
    try {
      prev.dispose?.();
    } catch (err) {
      console.error('[renderer-switch] dispose failed:', err);
    }
  }
  document.getElementById('board')?.replaceChildren();
  forwardOptions(target);
  refresh();
  return true;
}

// ---- toggle & veil -------------------------------------------------------------------------------

function mountToggle() {
  if (!toggleVisible) return;
  const host = document.getElementById('board');
  if (!host) return;
  if (!toggle) toggle = buildToggle();
  if (toggle.parentNode !== host || host.lastChild !== toggle) host.append(toggle); // keep it on top
  updateToggle();
}

/** The "Loading 3D…" veil shows while 3D is wanted but the 2D board is still on screen. */
function mountVeil() {
  const want = mode === '3d' && active !== r3d;
  const host = document.getElementById('board');
  if (!want || !host) {
    veil?.remove();
    return;
  }
  if (!veil) {
    veil = document.createElement('div');
    veil.className = 'rsw-veil';
    veil.setAttribute('role', 'status');
    veil.textContent = 'Loading 3D…';
  }
  if (veil.parentNode !== host) host.append(veil);
  if (toggle?.parentNode === host) host.append(toggle); // the toggle stays on top
}

function buildToggle() {
  const box = document.createElement('div');
  box.className = 'rsw';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Board view');
  for (const m of MODES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.mode = m;
    b.textContent = m.toUpperCase();
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (m === '3d' && supportsWebGL2() === false) {
        refresh();
        return;
      }
      setMode(m);
    });
    if (m === '3d') {
      // Probe WebGL2 only when someone shows interest in 3D (not on every 2D page load).
      const probe = () => {
        if (webgl2 === null) probe3d();
      };
      b.addEventListener('pointerenter', probe);
      b.addEventListener('focus', probe);
    }
    box.append(b);
  }
  return box;
}

function updateToggle() {
  if (!toggle) return;
  toggle.dataset.mode = active === r3d && r3d ? '3d' : '2d'; // positions it for the board on screen
  for (const b of toggle.querySelectorAll('button')) {
    const on = b.dataset.mode === mode;
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (b.dataset.mode !== '3d') {
      b.title = 'Classic 2D board';
      continue;
    }
    const loading = mode === '3d' && (!!loading3d || active !== r3d);
    const unsupported = webgl2 === false;
    b.classList.toggle('is-loading', loading);
    b.classList.toggle('is-paused', !loading && !unsupported && (!!paused || loadFailed));
    b.setAttribute('aria-disabled', unsupported ? 'true' : 'false');
    b.title = unsupported
      ? "3D isn't available in this browser (it needs WebGL2)"
      : loading
        ? 'Loading 3D…'
        : paused === 'lost'
          ? '3D paused (the graphics context was lost) — click to retry'
          : paused
            ? "3D couldn't start on this device — click to retry"
            : loadFailed
              ? '3D failed to load — click to retry'
              : '3D board';
  }
}

function injectStyles() {
  if (document.getElementById('rsw-css')) return;
  const style = document.createElement('style');
  style.id = 'rsw-css';
  style.textContent = `
.rsw { position: absolute; top: 10px; right: 10px; z-index: 20; display: flex; padding: 2px;
  border-radius: 999px; background: rgb(20 14 10 / 0.62); box-shadow: 0 2px 8px rgb(0 0 0 / 0.3);
  font: 700 12px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; backdrop-filter: blur(4px); }
.rsw[data-mode="2d"] { top: calc(12.5% + 6px); right: calc(12.5% + 6px); }
.rsw button { min-width: 34px; padding: 6px 9px; border: 0; border-radius: 999px; background: transparent;
  color: #fff; font: inherit; cursor: pointer; }
.rsw button[aria-pressed="true"] { background: #fff; color: #17211b; }
.rsw button[aria-disabled="true"] { opacity: 0.45; cursor: not-allowed; }
.rsw button.is-loading::after { content: "…"; }
.rsw button.is-paused::after { content: " !"; color: #ffcf3a; }
.rsw button:focus-visible { outline: 2px solid #2b7de9; outline-offset: 1px; }
.rsw-veil { position: absolute; inset: 0; z-index: 19; display: grid; place-items: center; border-radius: 8px;
  background: rgb(20 14 10 / 0.55); color: #fff; font: 700 16px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  letter-spacing: 0.02em; pointer-events: none; }
/* Full-screen 3D layout (ui.js: body.board-3d): the 2D board waiting underneath isn't shown at all. */
body.board-3d .rsw-veil { border-radius: 0; background: #1b130e; }
`;
  document.head.append(style);
}
