// public/renderer3d.js — the Three.js renderer: Loop City, a life-size living city where the 40
// board squares are 40 real places on a one-way loop around a downtown. Characters drive and walk
// the streets, lots grow from hoardings to towers, the city lives (traffic, people, trains, boats,
// day and night), and a camera director films it like television.
//
// Same contract as renderer2d.js (docs/CONTRACT.md §8), plus:
//   * render(state, events, myPlayerId) — draws the public state into <div id="board">. Never throws.
//     State is the truth; events only add animation. First render / reconnect / hidden tab /
//     prefers-reduced-motion / the "instant" speed → no animation. A newer state arriving
//     mid-animation is queued: everything plays faster (×1.5, ×2.25 with three waiting) until the
//     queue drains; with more than four waiting, the oldest land at once.
//   * dispose() — frees the WebGL context and everything else, empties its part of #board.
//   * busyUntil() — Date.now()-based time at which the running animation (and the queue behind it)
//     reaches its landing (0 when idle or hidden), so ui.js can hold its dialogs until then.
//   * setOptions({ speed, camera, quality }) — speed 'normal' | 'fast' (≈1.8×, camera included) |
//     'instant' (snap; at most one summary sound per state); camera 'cinematic' | 'calm' | 'free';
//     quality 'auto' | 'low' | 'medium' | 'high' (forwarded to the stage).
// Full screen: the city is framed inside the part of #board ui.js leaves uncovered
// (#board.dataset.safeTop/Right/Bottom/Left, re-read on the window event 'monopoly:safearea').
// City options (the in-board 🏙 menu, saved as localStorage["monopoly.city"]): others' turns
// (short / full / instant), day mode, weather, ambience, minimap, labels. ⊞ or the M key toggles
// the north-up map view. Tap a building (or a minimap cell) for its info card.
//
// The pieces live in public/r3d/ and are built by separate modules (stage + world, lots and
// landmarks, characters, ambient life + sound, overlay + HUD dice). Each is loaded with a dynamic
// import and constructed inside try/catch: a module that is missing or fails becomes a null object
// with the same methods (an emptier city, never a broken board). Its methods are also guarded at
// run time — an exception is logged once and the call returns the safe default.

import * as THREE from './r3d/three.js';
import { Animator } from './r3d/tween.js';
import { Director } from './r3d/director.js';
import { tileInfo } from './r3d/info.js';
import { lotAt, address, wrap } from './r3d/city-layout.js';
import { OTHERS } from './r3d/pacing.js';
import {
  playBatch, snapTo, settle, aimCamera, estimate, summaryBeat, playBeatNow, animates,
  CATCH_UP, CATCH_UP_MAX, MAX_QUEUE,
} from './r3d/choreo.js';

export { onBeat } from './r3d/choreo.js'; // hook point for effects that ride on the choreography's beats

const PALETTE = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#e84393'];
const CLICK_SLOP = 6;
const WARMUP_MAX_MS = 4000;
const AMBIENT_WINDOW_MS = 45_000;
const DEBUG = (() => {
  try {
    return new URLSearchParams(location.search).has('r3d-debug') || sessionStorage.getItem('monopoly.r3dDebug') === '1';
  } catch {
    return false;
  }
})();
const SPEED_RATE = { normal: 1, fast: 1.8 };
const SPEEDS = ['normal', 'fast', 'instant'];
const CAMERAS = ['cinematic', 'calm', 'free'];
const QUALITIES = ['auto', 'low', 'medium', 'high'];
const SOUND_GAP_MS = { hop: 35, diceBounce: 45, coin: 40, stepTick: 70, floor: 70, hammer: 70 };
const SOUND_GAP_DEFAULT_MS = 80;
const LOG_CAP = 600;
const CITY_KEY = 'monopoly.city';
const CITY_DEFAULTS = Object.freeze({ others: 'short', dayMode: 'story', weather: 'clear', ambience: 0.5, minimap: true, labels: 'auto' });
const CITY_CHOICES = {
  others: OTHERS,
  dayMode: ['story', 'cycle', 'afternoon'],
  weather: ['clear', 'overcast', 'rain', 'storm', 'snow'],
  labels: ['auto', 'all', 'off'],
};
// Score and interface sounds are never placed in the world (§14.4); the rest carry a position.
const NON_SPATIAL = new Set([
  'passGo', 'jailSlam', 'sold', 'setComplete', 'hotel', 'bankrupt', 'victory', 'cashRegister', 'coins', 'coin', 'gavel',
  'notify', 'rent', 'tax', 'doubles', 'cardDraw', 'cardFlip', 'diceShake', 'diceThrow', 'diceBounce', 'diceSettle',
  'whoosh', 'tick', 'stepTick', 'timelapseRise', 'timelapseLand', 'tradePropose', 'tradeAccept', 'tradeReject', 'bid',
  'auctionEnd', 'jailFree', 'stamp', 'unstamp', 'cheer', 'click', 'outbid',
]);
// Sounds newer than this sfx.js: the closest existing one, or silence.
const SOUND_FALLBACK = {
  setComplete: ['doubles', { volume: 0.55, rate: 0.9 }], stepTick: ['tick', { volume: 0.5, rate: 1.4 }],
  timelapseRise: ['whoosh', { volume: 0.7, rate: 0.7 }], timelapseLand: ['whoosh', { volume: 0.6, rate: 1.2 }],
  engineStart: ['drive', { volume: 0.8 }], crowdOoh: ['cheer', { volume: 0.5 }], applause: ['cheer', { volume: 0.8 }],
  ribbonSnip: ['click'], barrierArm: ['click', { rate: 0.6 }], hammer: ['build', { volume: 0.5, rate: 1.5 }],
  demolishRumble: ['demolish'], splitFlap: ['tick'], coinsIn: ['coins', { volume: 0.6 }], doormanBell: ['bid', { volume: 0.5 }],
};

let BOARD = null;
let boardRetry = null;
let root = null;
let rootMsg = null;
let view = null;
let failure = null;
let gameId;
let lastSeq = null;
let lastArgs = null;
const options = { speed: 'normal', camera: 'cinematic', quality: 'auto' };
let qualityGiven = false;
const city = loadCityOptions();
seedOptions();

injectStylesheet();
const [loadedBoard, sfxMod, MOD] = await Promise.all([loadBoard(), loadSfx(), loadModules()]);
BOARD = loadedBoard;
const sfx = sfxMod?.sfx && typeof sfxMod.sfx.play === 'function' ? sfxMod.sfx : null;
const SOUNDS = Array.isArray(sfxMod?.SOUND_NAMES) ? new Set(sfxMod.SOUND_NAMES) : null;
window.addEventListener('monopoly:safearea', () => { if (view) applySafeArea(view); });

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

export function render(state, events, myPlayerId) {
  try {
    draw(state, Array.isArray(events) ? events : [], myPlayerId ?? null);
  } catch (err) {
    console.error('[renderer3d] render failed:', err);
  }
}

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

export function busyUntil() {
  try {
    if (!view || document.hidden) return 0;
    let s = view.animator.until(view.settleItem);
    for (const q of view.queue) s += estimate(q.events, { me: q.ctx.me, others: city.others, ctx: { ...q.ctx, BOARD }, calm: options.camera !== 'cinematic' });
    s /= view.animator.rate;
    return s > 0 ? Date.now() + Math.round(s * 1000) : 0;
  } catch {
    return 0;
  }
}

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
      if (options.speed === 'instant') skip();
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

function seedOptions() {
  try {
    const saved = JSON.parse(localStorage.getItem('monopoly.settings') ?? 'null');
    if (SPEEDS.includes(saved?.speed)) options.speed = saved.speed;
    if (CAMERAS.includes(saved?.camera)) options.camera = saved.camera;
  } catch { /* defaults */ }
}

/** City menu values (localStorage["monopoly.city"]), validated, defaults filled in. */
function loadCityOptions() {
  const out = { ...CITY_DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(CITY_KEY) ?? 'null');
    if (saved && typeof saved === 'object') for (const [k, v] of Object.entries(saved)) {
      const ok = validCity(k, v);
      if (ok !== undefined) out[k] = ok;
    }
  } catch { /* no storage / bad JSON */ }
  return out;
}

/** The value to store for a city option, or undefined when it isn't valid. */
function validCity(key, value) {
  if (CITY_CHOICES[key]) return CITY_CHOICES[key].includes(value) ? value : undefined;
  if (key === 'ambience') { const n = Number(value); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : undefined; }
  if (key === 'minimap') return typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : undefined;
  return undefined;
}

function saveCityOptions() {
  try {
    localStorage.setItem(CITY_KEY, JSON.stringify(city));
  } catch { /* storage full / blocked: the option still applies for this page */ }
}

async function loadSfx() {
  try {
    const mod = await import('./sfx.js');
    return mod ?? null;
  } catch (err) {
    console.warn('[renderer3d] no sound effects:', err);
    return null;
  }
}

/** The city's modules (lanes), each optional. A failed import is logged and becomes null. */
async function loadModules() {
  const paths = {
    stage: './r3d/stage.js', clock: './r3d/city-clock.js', lots: './r3d/city-lots.js', landmarks: './r3d/landmarks.js',
    chars: './r3d/char-motion.js', life: './r3d/life.js', audio: './r3d/audio-scene.js', overlay: './r3d/overlay.js',
    hudDice: './r3d/hud-dice.js', fx: './r3d/fx.js', cards: './r3d/cards.js', styles: './r3d/lot-styles.js',
  };
  const list = await Promise.all(Object.entries(paths).map(async ([key, path]) => {
    try {
      return [key, await import(path)];
    } catch (err) {
      console.error(`[renderer3d] module ${path} failed to load:`, err);
      return [key, null];
    }
  }));
  return Object.fromEntries(list);
}

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

function requestMode(mode, { persist = true, paused = null } = {}) {
  window.dispatchEvent(new CustomEvent('monopoly:renderer', { detail: { mode, persist, paused } }));
}

// ---------------------------------------------------------------------------------------------
// Null objects and guards — every city module degrades to "missing scenery"
// ---------------------------------------------------------------------------------------------

const NO_RITUAL = () => ({ duration: 0, cues: [] });
const noop = () => {};
const NULLS = {
  lots: {
    sync: noop, ritual: NO_RITUAL, celebrate: NO_RITUAL, signBounce: () => 0, setPending: noop, setAuction: noop,
    anchor: () => null, boxes: () => [], setFade: noop, inspect: () => null, pick: () => null, ambient: () => false,
    reset: noop, dispose: noop,
  },
  landmarks: {
    sync: noop, anchor: () => null, goBurst: NO_RITUAL, jailGate: NO_RITUAL, gtjBarrier: NO_RITUAL, fpBarrier: NO_RITUAL,
    fpWheel: NO_RITUAL, potBurst: NO_RITUAL, kiosk: () => ({ duration: 0, cues: [], cardPose: null }), taxSlot: NO_RITUAL,
    boxes: () => [], pick: () => null, ambient: () => false, reset: noop, dispose: noop,
  },
  chars: {
    sync: noop, get: () => null, worldPos: () => null, headPos: () => null, sizeOf: () => null,
    scheduleMove: () => ({ kind: 'none', duration: 0, tileTimes: [] }), react: () => 0, release: () => 0, exitTown: () => 0,
    victoryLap: () => 0, cameo: () => 0, pulse: noop, setCurrent: noop, setAudio: noop, ambient: () => false, clear: noop,
    remove: noop, dispose: noop,
  },
  life: {
    crowd: { rush: () => 0, cheerAll: noop, scatter: noop }, setTier: noop, setWeather: noop, setLivery: noop,
    ambient: () => false, reset: noop, dispose: noop,
  },
  audio: {
    update: noop, engine: () => ({ set: noop, stop: noop }), footstep: noop, site: noop, setAmbience: noop, duck: noop,
    jcut: noop, dispose: noop,
  },
  hudDice: { schedule: () => ({ duration: 0.85, restAt: 0.8, bounces: [] }), rest: noop, hide: noop, celebrate: () => 0, dispose: noop, values: null },
  overlay: {
    setSafeArea: noop, safeRect: () => null, setTurn: noop, callout: noop, showCard: noop, hideCard: noop, setWinner: noop,
    setLog: noop, float: noop, update: () => false, updateFloats: noop, setPins: noop, setAuction: noop, pulseAuction: noop,
    setTrade: noop, addAnchor: noop, removeAnchor: noop, showInfo: noop, hideInfo: noop, setFreeCam: noop, reset: noop,
    dispose: noop, infoShown: false, chyron: noop, stepCount: noop, routeChip: noop, letterbox: noop,
    moneyFlight: () => 0, setMinimap: noop, setMapLabels: noop, setCityMenu: noop, setMapButton: noop,
  },
  fx: {
    dust: noop, puff: noop, sparkles: noop, confetti: noop, fireworks: noop, money: noop, gavel: noop, soldStamp: noop,
    auctionSold: noop, deeds: noop, goBurst: noop, jailSlam: noop, clear: noop, dispose: noop,
  },
  cards: { schedule: () => 0, hide: noop, dispose: noop, setSfx: noop },
  clock: { step: () => false, setTarget: noop, reset: noop, time: 0, rate: 1, target: 1 },
  stage: {
    setShadowFocus: noop, setHudPass: noop, setMapMode: noop, setWeather: noop, setDayPhase: noop, setDusk: noop,
    dayPhase: 0.35, bus: null, setQuality: () => 'medium', markShadows: noop,
    world: {
      ground: { pulseBay: () => 0, setRoute: () => 0, clearRoute: noop },
      anchor: () => null, heightAt: () => 0, setTier: noop, setDayPhase: noop, setWeather: noop, setMapMode: noop,
      follow: noop, ambient: () => false, dispose: noop,
    },
  },
};
const NESTED = new Set(['crowd', 'world', 'ground']);

/**
 * Wraps a module instance so a throwing method logs once and returns its null-object default,
 * and a method / nested object it lacks (an older module) comes from the null object.
 */
function guard(real, nul, label) {
  const target = real && typeof real === 'object' ? real : {};
  const wrapped = new Map();
  const nested = new Map();
  const warned = new Set();
  const report = (prop, err) => {
    if (warned.has(prop)) return;
    warned.add(prop);
    console.error(`[renderer3d] ${label}.${String(prop)} failed:`, err);
  };
  return new Proxy(target, {
    get(t, prop) {
      let v;
      try {
        v = Reflect.get(t, prop, t);
      } catch (err) {
        report(prop, err);
        v = undefined;
      }
      if (typeof v === 'function') {
        const hit = wrapped.get(prop);
        if (hit && hit.fn === v) return hit.w;
        const fb = nul?.[prop];
        const w = (...args) => {
          try {
            return v.apply(t, args);
          } catch (err) {
            report(prop, err);
            return typeof fb === 'function' ? fb(...args) : fb;
          }
        };
        wrapped.set(prop, { fn: v, w });
        return w;
      }
      if (typeof prop === 'string' && NESTED.has(prop) && nul && nul[prop] && typeof nul[prop] === 'object') {
        const hit = nested.get(prop);
        if (hit && hit.real === v) return hit.p;
        const p = guard(v, nul[prop], `${label}.${prop}`);
        nested.set(prop, { real: v, p });
        return p;
      }
      if (v === undefined && nul && prop in nul) return nul[prop];
      return v;
    },
  });
}

/** Constructs an optional module (class or factory), guarded; a null object when it fails. */
function make(label, build) {
  try {
    const obj = build();
    if (!obj) throw new Error('module not loaded');
    return guard(obj, NULLS[label], label);
  } catch (err) {
    console.error(`[renderer3d] ${label} unavailable (an emptier city):`, err);
    return guard(null, NULLS[label], label);
  }
}

// ---------------------------------------------------------------------------------------------
// The 3D view
// ---------------------------------------------------------------------------------------------

function createView(host) {
  const createStage = MOD.stage?.createStage;
  if (typeof createStage !== 'function') throw new Error('the stage module is unavailable');
  const animator = new Animator({
    onActive: () => v.stage?.invalidate(),
    onBackstop: () => {
      v.director?.snap();
      v.clock?.setTarget(1, { snap: true });
      v.overlay?.update();
      v.stage?.renderNow();
    },
  });
  const v = {
    animator, BOARD, fresh: true, latest: null, ambientUntil: 0, batchSeq: 0,
    running: null, queue: [], settleItem: null, lastTrade: null, mapOn: false, letterboxOn: false,
    opts: city, dayShown: null, ambientCache: { now: -1, value: false },
  };
  const rawStage = createStage(host, {
    onFrame: (dt, now) => frame(v, dt, now),
    onAmbient: (now) => ambient(v, now),
    onResize: () => {
      if (!v.director) return;
      v.director.onResize();
      v.overlay.setSafeArea(readSafeArea());
      v.overlay.update();
    },
    onContextLost: () => contextLost(),
    quality: qualityGiven ? options.quality : undefined,
    BOARD,
  });
  const stage = guard(rawStage, NULLS.stage, 'stage');
  v.stage = stage;
  try {
    const { scene, renderer, camera } = rawStage;
    const bus = rawStage.bus ?? null;
    const markShadows = () => stage.markShadows();
    v.world = stage.world;
    v.ground = v.world.ground;
    v.clock = make('clock', () => MOD.clock?.createCityClock?.(bus));
    v.fx = make('fx', () => MOD.fx?.Fx && new MOD.fx.Fx(scene, animator));
    const deps = { renderer, animator, markShadows, fx: v.fx, bus };
    v.lots = make('lots', () => MOD.lots?.CityLots && new MOD.lots.CityLots(scene, BOARD, deps));
    v.landmarks = make('landmarks', () => MOD.landmarks?.Landmarks && new MOD.landmarks.Landmarks(scene, BOARD, deps));
    v.chars = make('chars', () => MOD.chars?.CharacterLayer && new MOD.chars.CharacterLayer(scene, animator, { markShadows, fx: v.fx, clock: v.clock, bus, BOARD }));
    v.life = make('life', () => MOD.life?.CityLife && new MOD.life.CityLife(scene, { renderer, bus, clock: v.clock, BOARD, animator }));
    v.audio = make('audio', () => MOD.audio?.AudioScene && new MOD.audio.AudioScene(sfx, { bus, clock: v.clock }));
    v.chars.setAudio(v.audio);
    v.hudDice = make('hudDice', () => MOD.hudDice?.HudDice && new MOD.hudDice.HudDice(stage, animator));
    v.deck = deckAdapter(camera);
    v.cards = make('cards', () => MOD.cards?.CardFlight && new MOD.cards.CardFlight(scene, camera, animator, v.deck, rawStage.size));
    v.overlay = make('overlay', () => MOD.overlay?.Overlay && new MOD.overlay.Overlay(host, {
      camera,
      size: rawStage.size,
      isQuiet: () => animator.finishing,
      onReset: () => resetCamera(),
      onFreeLook: () => setFreeLook(!v.director.pinned),
      onMap: () => toggleMap(),
      onCityOption: (key, value) => setCityOption(key, value),
      onMinimapTap: (index) => minimapTap(index),
    }));
    const tmp = new THREE.Vector3();
    v.director = new Director(camera, rawStage.controls, {
      size: rawStage.size,
      stage,
      onWake: () => stage.invalidate(),
      onChange: (s) => {
        v.overlay.setFreeCam(s);
        updateTouch(v);
      },
      subjects: {
        char: (id) => {
          const c = v.chars.get(id);
          if (!c || c.visible === false) return null;
          const p = v.chars.worldPos(id, tmp);
          if (!p) return null;
          const size = v.chars.sizeOf(id);
          return { x: p.x, y: p.y ?? 0, z: p.z, heading: c.root?.rotation?.y ?? 0, length: size?.length ?? 2, height: size?.height ?? 1.6 };
        },
        lot: (tile) => v.lots.anchor(tile),
      },
    });
    v.director.instant = reducedMotion() || options.speed === 'instant';
    v.heightOf = (group, level) => heightOf(group, level);
    v.dayTarget = (ctx) => dayTarget(ctx);
    v.refresh = (ctx, animate) => refresh(v, ctx, animate);
    v.step = (dt) => frame(v, dt, performance.now()); // one frame by hand (debug / harness)
    v.pickTile = (x, y) => pickTile(v, x, y);
    v.toggleMap = (on) => toggleMap(on);
    v.city = city;
    v.setTrail = (trail) => {
      v.trail = trail ?? null;
      if (v.minimap && city.minimap) v.overlay.setMinimap({ ...v.minimap, trail: v.trail, viewYaw: v.director.cur.yaw });
    };
    v.info = makeInfo();
    v.sound = makeSound(v);
    v.onBatchDone = () => nextBatch(v);
    if (DEBUG) {
      v.beatLog = cappedLog();
      v.soundLog = cappedLog();
    }
    v.overlay.setCityMenu({ ...city });
    v.overlay.setMapButton(false);
    v.audio.setAmbience(city.ambience);
    stage.setWeather(city.weather);
    applyCamera(v);
    applyQuality(v);
    applySafeArea(v, { snap: true });
    updateRate(v);
    wireInput(v);
  } catch (err) {
    teardownParts(v);
    rawStage.dispose();
    throw err;
  }
  if (DEBUG) host.__r3d = v;
  return v;
}

/** Per drawn frame: city clock → animations → camera → overlay → sound (§17.10). */
function frame(v, dt, now = performance.now()) {
  if (!v.director) return false;
  const k = v.clock.step(dt);
  const a = v.animator.step(dt);
  const c = v.director.update(dt);
  const f = v.overlay.update();
  const cam = v.stage.camera;
  try {
    v.audio.update(dt, { camera: cam, focus: v.stage.controls?.target ?? null, altitude: cam.position.y, mapMode: v.mapOn ? 1 : 0, letterbox: v.letterboxOn });
  } catch { /* guarded */ }
  if (!reducedMotion()) runAmbient(v, now); // ambient life keeps moving while the game animates
  minimapYaw(v);
  return !!(a || c || f || k);
}

/** Idle: the city's ambient life within the ambient window after activity. */
function ambient(v, now) {
  if (reducedMotion() || now > v.ambientUntil) return false;
  return runAmbient(v, now);
}

function runAmbient(v, now) {
  const cache = v.ambientCache;
  if (cache.now === now) return cache.value;
  let any = false;
  for (const part of [v.chars, v.lots, v.landmarks, v.life, v.world]) any = !!part.ambient(now) || any;
  cache.now = now;
  cache.value = any;
  return any;
}

/** Card flights start from the kiosk / chest the choreography names (landmarks.kiosk cardPose). */
function deckAdapter(camera) {
  const poses = { chance: null, community: null };
  const fallback = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), w: 0.6, h: 0.38 };
  const fwd = new THREE.Vector3();
  const up = new THREE.Vector3();
  return {
    set(deck, pose) {
      poses[deck === 'community' ? 'community' : 'chance'] = pose && pose.position ? pose : null;
    },
    deckPose(deck) {
      const p = poses[deck === 'community' ? 'community' : 'chance'];
      if (p && Number.isFinite(p.position.x)) {
        return {
          position: p.position.isVector3 ? p.position : new THREE.Vector3(p.position.x, p.position.y ?? 1, p.position.z),
          quaternion: p.quaternion?.isQuaternion ? p.quaternion : new THREE.Quaternion(),
          w: Number(p.w) || 0.6,
          h: Number(p.h) || 0.38,
        };
      }
      // No kiosk to start from: rise into view from below the frame.
      camera.updateMatrixWorld();
      fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
      up.set(0, 1, 0).applyQuaternion(camera.quaternion);
      fallback.position.copy(camera.position).addScaledVector(fwd, 5).addScaledVector(up, -3);
      fallback.quaternion.copy(camera.quaternion);
      return fallback;
    },
  };
}

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

// ---- city: heights, day, readability ------------------------------------------------------------

const HEIGHT_FALLBACK = {
  brown: [3, 7.5, 7.5, 7.5, 7.5, 17], lightblue: [3, 11, 11, 11, 11, 24], pink: [3, 12.5, 12.5, 12.5, 12.5, 34],
  orange: [3, 17, 17, 17, 17, 40], red: [3, 22, 22, 22, 22, 64], yellow: [3, 16, 27, 38, 49, 104],
  green: [3, 23, 34, 45, 57, 134], darkblue: [3, 12, 12, 12, 12, 195],
};

/** Building height of a colour group at a level (lot-styles.js when present). */
function heightOf(group, level) {
  try {
    const h = MOD.styles?.heightOf?.(group, level);
    if (Number.isFinite(h)) return h;
  } catch { /* fallback */ }
  const t = HEIGHT_FALLBACK[group];
  return t ? t[Math.max(0, Math.min(5, Math.trunc(Number(level) || 0)))] : 14;
}

/** The day phase the city should show (§13). */
function dayTarget(ctx) {
  if (city.dayMode === 'afternoon') return 0.35;
  if (ctx?.state?.status === 'finished') return 1.0;
  if (city.dayMode === 'cycle') {
    const n = Number(ctx?.turn?.number) || 1;
    const u = (((n - 1) % 24) + 24) % 24 / 24;
    return u < 0.85 ? -0.3 + (1.5 * u) / 0.85 : 1.2;
  }
  const tiles = Array.isArray(ctx?.state?.tiles) ? ctx.state.tiles : [];
  let owned = 0;
  let built = 0;
  for (const t of tiles) {
    if (!t?.ownerId) continue;
    owned++;
    built += Math.max(0, Math.min(5, Number(t.houses) || 0));
  }
  return 0.1 + 0.45 * (owned / 28) + 0.4 * (built / (22 * 5));
}

/** After every settle: day phase, minimap, map labels. */
function refresh(v, ctx, animate) {
  const target = dayTarget(ctx);
  if (v.dayShown === null || Math.abs(target - v.dayShown) > 0.004) {
    const wrapAround = city.dayMode === 'cycle' && v.dayShown !== null && target < v.dayShown - 0.5;
    v.stage.setDayPhase(target, animate && !wrapAround ? { duration: 3 } : { instant: true });
    v.dayShown = target;
  }
  v.trail = null;
  v.minimap = minimapModel(v, ctx);
  v.overlay.setMinimap(city.minimap ? { ...v.minimap, viewYaw: v.director.cur.yaw } : null);
  v.overlay.setMapLabels(labelsWanted(v) ? mapLabels(v, ctx) : null);
}

function labelsWanted(v) {
  return city.labels === 'all' || (city.labels === 'auto' && v.mapOn);
}

const SHORT = [[/\bAvenue\b/g, 'Ave'], [/\bPlace\b/g, 'Pl'], [/\bRailroad\b/g, 'RR'], [/\bGardens\b/g, 'Gdns'], [/^Community Chest$/, 'Chest'],
  [/^Electric Company$/, 'Electric Co'], [/^Income Tax$/, 'Tax'], [/^Luxury Tax$/, 'Lux Tax'], [/^Free Parking$/, 'Parking'], [/^Jail$/, 'Jail']];
function shortName(name) {
  let s = String(name ?? '');
  for (const [re, to] of SHORT) s = s.replace(re, to);
  return s;
}

function cellOf(ctx, t) {
  const ts = ctx.tileState.get(t.index);
  const owner = ts?.ownerId && ctx.byId.has(ts.ownerId) ? ts.ownerId : null;
  return {
    index: t.index,
    type: t.type,
    band: t.type === 'property' ? BOARD.groups?.[t.group]?.color ?? null : null,
    owner: owner ? ctx.colorOf.get(owner) ?? null : null,
    ownerName: owner ? String(ctx.byId.get(owner)?.name ?? '') : null,
    houses: owner ? Math.max(0, Math.min(5, Number(ts.houses) || 0)) : 0,
    mortgaged: !!(owner && ts.mortgaged),
  };
}

function minimapModel(v, ctx) {
  const cells = (BOARD?.tiles ?? []).map((t) => cellOf(ctx, t));
  const tokens = ctx.live ? ctx.players.filter((p) => !p.bankrupt && Number.isInteger(p.position)).map((p) => ({
    id: p.id, color: ctx.colorOf.get(p.id), index: p.position, current: ctx.active && p.id === ctx.currentId, jailed: !!p.inJail,
  })) : [];
  return { cells, tokens, trail: v.trail ?? null };
}

function mapLabels(v, ctx) {
  return (BOARD?.tiles ?? []).map((t) => {
    const c = cellOf(ctx, t);
    const L = address(t.index).lot;
    return { ...c, pos: { x: L.cx, y: 2, z: L.cz }, name: shortName(t.name) };
  });
}

/** The minimap's view wedge follows the camera's yaw (redrawn when it turns noticeably). */
function minimapYaw(v) {
  if (!city.minimap || !v.minimap) return;
  const yaw = v.director.cur.yaw;
  if (v.lastYaw !== undefined && Math.abs(yaw - v.lastYaw) < 0.06) return;
  v.lastYaw = yaw;
  v.overlay.setMinimap({ ...v.minimap, viewYaw: yaw });
}

/** A city menu change: validate, apply, persist. */
function setCityOption(key, value) {
  try {
    const ok = validCity(key, value);
    if (ok === undefined) return;
    city[key] = ok;
    saveCityOptions();
    const v = view;
    if (!v) return;
    switch (key) {
      case 'weather': v.stage.setWeather(ok); break;
      case 'ambience': v.audio.setAmbience(ok); break;
      case 'dayMode': if (v.latest) { v.dayShown = null; refresh(v, v.latest, true); } break;
      case 'minimap': case 'labels': if (v.latest) refresh(v, v.latest, false); break;
      default: break;
    }
    v.overlay.setCityMenu({ ...city });
    v.stage.invalidate();
  } catch (err) {
    console.error('[renderer3d] city option failed:', err);
  }
}

/** ⊞ / M: the north-up map view on or off. */
function toggleMap(on = !view?.mapOn) {
  const v = view;
  if (!v) return;
  v.mapOn = !!on;
  v.director.map(v.mapOn, { user: true });
  v.stage.setMapMode(v.mapOn ? 1 : 0, { duration: 0.45 });
  v.overlay.setMapButton(v.mapOn);
  if (v.latest) v.overlay.setMapLabels(labelsWanted(v) ? mapLabels(v, v.latest) : null);
  v.ambientUntil = performance.now() + AMBIENT_WINDOW_MS;
  v.stage.invalidate();
}

/** A minimap cell tapped: its info card, and (when nothing animates) a glide to its kerb. */
function minimapTap(index) {
  const v = view;
  if (!v || !v.latest || !Number.isInteger(index)) return;
  const data = tileInfo(BOARD, v.latest, wrap(index));
  if (data) v.overlay.showInfo(data, null);
  if (!v.animator.busy && v.director.auto && v.director.style !== 'free') {
    if (v.mapOn) toggleMap(false);
    v.director.kerb(wrap(index), { glide: 0.9 });
    v.stage.invalidate();
  }
}

// ---- options ------------------------------------------------------------------------------------

function updateRate(v) {
  const n = v.queue.length;
  const catchUp = n === 0 ? 1 : n >= 3 ? CATCH_UP_MAX : CATCH_UP;
  const rate = (SPEED_RATE[options.speed] ?? 1) * catchUp;
  v.animator.rate = rate;
  v.director.setRate(rate);
  v.director.instant = reducedMotion() || options.speed === 'instant';
}

function applyCamera(v) {
  v.director.setStyle(options.camera);
  v.overlay.setFreeCam({ suspended: v.director.suspended, pinned: v.director.pinned, style: v.director.style });
  updateTouch(v);
  if (options.camera !== 'free' && v.latest && !v.animator.busy) aimCamera(v, v.latest);
}

function applyQuality(v) {
  if (!qualityGiven) return;
  try {
    v.stage.setQuality(options.quality);
  } catch (err) {
    console.error('[renderer3d] setQuality failed:', err);
  }
}

function updateTouch(v) {
  if (!v.stage?.touchFirst || !v.director) return;
  const fullScreen = document.body?.classList.contains('board-3d');
  v.stage.setFreeLook(!!(fullScreen || v.director.pinned || v.director.style === 'free'));
}

// ---- safe area ----------------------------------------------------------------------------------

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

// ---- sound --------------------------------------------------------------------------------------

/**
 * view.sound(name, opts): plays an sfx.js sound for an animation moment. Silent without sfx, while
 * skipping, in a hidden tab, at "instant" (except the one summary sound) and for the same sound
 * started within SOUND_GAP_MS. Names this sfx.js lacks fall back (SOUND_FALLBACK) or stay silent.
 * Place-tied sounds keep `pos` (positional when audio-scene set a listener); score and interface
 * sounds never do.
 */
function makeSound(v) {
  const last = new Map();
  return (name, opts = {}) => {
    const { summary = false, ...play } = opts ?? {};
    if (!sfx || view !== v || v.animator.finishing || document.hidden) return false;
    if (options.speed === 'instant' && !summary) return false;
    let snd = name;
    if (SOUNDS && !SOUNDS.has(name)) {
      const fb = SOUND_FALLBACK[name];
      if (!fb || !SOUNDS.has(fb[0])) return false;
      snd = fb[0];
      const extra = fb[1] ?? {};
      if (extra.volume !== undefined) play.volume = (play.volume ?? 1) * extra.volume;
      if (extra.rate !== undefined) play.rate = (play.rate ?? 1) * extra.rate;
    }
    const now = performance.now();
    const anim = v.animator.time;
    const gap = SOUND_GAP_MS[name] ?? SOUND_GAP_DEFAULT_MS;
    const prev = last.get(name);
    if (prev && now - prev[0] < gap && anim - prev[1] < gap / 1000) return false;
    last.set(name, [now, anim]);
    if (NON_SPATIAL.has(snd) || !play.pos || !Number.isFinite(play.pos.x)) delete play.pos;
    try {
      sfx.play(snd, play);
    } catch (err) {
      console.warn('[renderer3d] sound failed:', err);
    }
    v.soundLog?.push({ name: snd, beat: name, t: now, at: anim, volume: play.volume ?? 1, rate: play.rate ?? 1, spatial: !!play.pos });
    return true;
  };
}

// ---- input --------------------------------------------------------------------------------------

/**
 * Pointer: a click / tap (not a drag) skips the running animation, or — when nothing animates —
 * shows the info card of the building / lot under it. Dragging / the wheel hands the camera to
 * the player. Keys: Esc skips, M toggles the map view (not while typing; Space / Enter stay ui.js's).
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
    if (down.moved && controls.enabled) v.director.suspend();
  };
  const onUp = (e) => {
    if (down && !down.moved) click(e);
    down = null;
  };
  const onCancel = () => { down = null; };
  const onStart = () => { if (controls.enabled) v.director.suspend(); };
  const onKey = (e) => {
    if (!root?.isConnected) return;
    if (e.key === 'Escape') {
      skip();
      view?.overlay.hideInfo();
      return;
    }
    if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
      const t = e.target;
      if (t?.isContentEditable || t?.closest?.('input, textarea, select, [contenteditable]')) return;
      toggleMap();
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
const ndc = new THREE.Vector2();
const hitV = new THREE.Vector3();

/** The tile under a canvas point: lots → landmarks → the ground (lotAt). */
function pickTile(v, cx, cy) {
  const rect = v.stage.canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  ndc.set(((cx - rect.left) / rect.width) * 2 - 1, -(((cy - rect.top) / rect.height) * 2 - 1));
  ray.setFromCamera(ndc, v.stage.camera);
  let i = v.lots.pick(ray);
  if (!Number.isInteger(i)) i = v.landmarks.pick(ray);
  if (!Number.isInteger(i)) {
    const hit = ray.ray.intersectPlane(plane, hitV);
    i = hit ? lotAt(hit.x, hit.z) : null;
  }
  return Number.isInteger(i) ? wrap(i) : null;
}

function click(e) {
  if (!view) return;
  if (view.animator.busy && view.running !== null) {
    skip();
    return;
  }
  const { overlay, stage } = view;
  if (overlay.infoShown) {
    overlay.hideInfo();
    return;
  }
  if (!view.latest) return;
  const i = pickTile(view, e.clientX, e.clientY);
  const data = i === null ? null : tileInfo(BOARD, view.latest, i);
  const rect = stage.canvas.getBoundingClientRect();
  if (data) overlay.showInfo(data, { x: e.clientX - rect.left, y: e.clientY - rect.top });
}

/** Fast-forwards whatever is animating — and every state queued behind it — to the latest state. */
function skip() {
  if (!view) return;
  view.animator.finishAll();
  updateRate(view);
  view.clock.setTarget(1, { snap: true });
  view.overlay.hideCard();
  view.cards.hide();
  view.overlay.letterbox(false);
  view.letterboxOn = false;
  if (view.latest && view.director.style !== 'free' && !view.director.suspended) aimCamera(view, view.latest);
  view.overlay.update();
  view.stage.invalidate();
}

function setFreeLook(on) {
  if (!view) return;
  view.director.pin(on);
  updateTouch(view);
  if (!on) resetCamera();
}

function resetCamera() {
  if (!view) return;
  if (view.mapOn) toggleMap(false);
  if (view.latest && view.director.style !== 'free') aimCamera(view, view.latest);
  view.director.recenter();
  updateTouch(view);
  view.stage.invalidate();
}

/** Frees everything the scene doesn't own (the stage frees the GPU side). */
function teardownParts(v) {
  v.animator?.clear();
  v.unwire?.();
  v.director?.dispose();
  for (const key of ['cards', 'overlay', 'hudDice', 'audio', 'chars', 'lots', 'landmarks', 'life', 'fx']) {
    try {
      v[key]?.dispose?.();
    } catch (err) {
      console.warn(`[renderer3d] ${key}.dispose failed:`, err);
    }
  }
}

function teardownView() {
  if (!view) return;
  const v = view;
  view = null;
  teardownParts(v);
  try {
    v.stage.dispose();
  } catch (err) {
    console.warn('[renderer3d] stage.dispose failed:', err);
  }
  if (root) delete root.__r3d;
}

function contextLost() {
  console.warn('[renderer3d] WebGL context lost');
  teardownView();
  failure = 'lost';
  requestMode('2d', { persist: false, paused: 'lost' });
  if (lastArgs && root) render(lastArgs[0], [], lastArgs[1]);
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
    root.setAttribute('aria-label', 'Game board (3D city)');
  }
  if (root.parentNode !== host) host.replaceChildren(root);

  if (!BOARD) {
    showRootMessage('Loading city…', []);
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
      requestMode('2d', { persist: false, paused: 'unsupported' });
      showFailure();
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
  let newSeq = false;
  if (typeof state.seq === 'number') {
    if (state.seq === lastSeq) events = [];
    else newSeq = true;
    lastSeq = state.seq;
  }

  const ctx = makeCtx(state, me);
  const { animator } = view;
  view.stage.measure();
  const instant = options.speed === 'instant' || reducedMotion();
  const canAnimate = !view.fresh && !document.hidden && !instant && view.stage.size.w > 0;
  const running = view.running !== null && animator.busy;
  const isNew = newSeq || events.length > 0;
  const fresh = view.fresh;
  // others = 'instant': batches without anything for the viewer land at once (one summary sound).
  const quiet = isNew && events.length > 0 && !animates(view, ctx, events);
  view.latest = ctx;
  updateTouch(view);

  if (fresh || !canAnimate || (quiet && !running)) {
    view.queue = [];
    animator.finishAll();
    view.running = null;
    updateRate(view);
    snapTo(view, ctx, { resetCamera: fresh, snapCamera: fresh || !canAnimate, events: fresh ? [] : events });
    view.fresh = false;
    if (!fresh && isNew && (instant || quiet)) {
      const name = summaryBeat(events);
      if (name) playBeatNow(view, name, { soundOpts: { summary: true } });
    }
  } else if (!isNew) {
    if (!running) settle(view, ctx, { animate: true });
  } else if (running) {
    view.queue.push({ ctx, events });
    while (view.queue.length > MAX_QUEUE) {
      const old = view.queue.shift();
      view.queue[0].before = old.before ?? old.ctx;
    }
    updateRate(view);
  } else {
    playBatch(view, ctx, events);
  }
  if (view.overlay.infoShown && isNew) view.overlay.hideInfo();
  view.overlay.update();
  view.ambientUntil = performance.now() + AMBIENT_WINDOW_MS;
  view.stage.renderSoon();
}

function nextBatch(v) {
  if (view !== v) return;
  const q = v.queue.shift();
  updateRate(v);
  if (!q) return;
  if (q.before) settle(v, q.before, { animate: false });
  if (!animates(v, q.ctx, q.events)) {
    settle(v, q.ctx, { animate: false });
    const name = summaryBeat(q.events);
    if (name) playBeatNow(v, name, { soundOpts: { summary: true } });
    v.onBatchDone?.();
    return;
  }
  playBatch(v, q.ctx, q.events);
}

/** Compiles shaders in the background (KHR_parallel_shader_compile) behind "Loading 3D…". */
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
    showRootMessage('Building the city…', []);
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

/** A different game is on screen: forget characters, animations and caches. */
function resetGame() {
  if (!view) return;
  const v = view;
  v.animator.clear();
  v.running = null;
  v.queue = [];
  v.settleItem = null;
  v.lastTrade = null;
  v.seenTurn = new Set();
  v.trail = null;
  v.dayShown = null;
  updateRate(v);
  v.chars.clear();
  v.lots.reset();
  v.landmarks.reset();
  v.life.reset();
  v.fx.clear();
  v.clock.reset();
  v.cards.hide();
  v.overlay.reset();
  v.director.resume();
  v.fresh = true;
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

