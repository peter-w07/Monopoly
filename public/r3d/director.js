// public/r3d/director.js — the camera director of Loop City (city design §9). Metres.
//
// Shots (all poses are { yaw, pitch, dist, tx, ty, tz, fov }; camera = target + dist ·
// (cos p · sin yaw, sin p, cos p · cos yaw), the convention of city-layout's SEAT_YAW):
//   heli(lean)        home: the helicopter south-west of the city (SEAT_YAW), leaning ≤ ±0.15 rad
//                     toward the active character, pitch 58°→68° by aspect, FOV 30, fitted to the
//                     lot ring; idle drift ±3° over 40 s (cinematic).
//   map()             north up (GO bottom-right, like the 2D board), pitch 88°, FOV 22.
//   ready(id)         behind a character at street level (FOV 50) — the turn-start dive.
//   transit(points)   fits the rest of a walk from the inner (park) side, pitch 50°, FOV 45 (+kick).
//   track(id, tile)   a tracking dolly on the inner side, ending in kerb(tile).
//   kerb(tile)        across the avenue from a lot, eye 1.7 m (5 m / FOV 58 for tall buildings);
//                     `hold` keeps the lot above ui.js's dialogs and breathes ±1 %.
//   crane(tiles)      30 m in front of the lots, rising with the growth front (hotel: a tilt-up).
//   establish(name)   'jail' | 'go' | 'fp' | 'gtj' (55 m up, 110 m out along the corner diagonal,
//                     orbiting 4°/s) | 'intro' (a 5 s spline from over the sea past the
//                     lighthouse to the GO Gate, rising to the helicopter).
//   hero(id)          4–6 m from a character at 1.2 m, FOV 32, orbiting 6°/s (jail: through the gate).
//   frame(points)     fits points from the helicopter's yaw, pitch 60°, FOV 35.
//   orbit(id)         radius 28 m, 10 m up, 0.25 rad/s (victory).
//   skyline()         a 4 s crane back to the helicopter (victory end).
//
// Motion: every channel (yaw, pitch, dist, look-at, fov) is a critically damped spring with its
// speed-up limited; look-at and distance speeds are capped relative to the distance (≤ 2.5 ×
// dist / s, accel ≤ 6 × dist / s²), so a shot 300 m up moves as calmly as one at the kerb.
// Scripted glides (flyTo — the dive to `ready`, the pull-out, the crane-up) interpolate the
// distance in log space and move the look-at with the distance, so the subject stays in frame.
// Cuts: cinematic style only, ≥ 1.0 s (animation time) apart — a cut asked for too soon glides.
// Shake and dolly-zoom: cinematic only. `rate` scales everything (Fast, catching up).
//
// Per frame: near = clamp(0.02 · min(altitude, dist), 0.1, 1), far = clamp(6 · dist + 8 ·
// altitude + 1500, 2000, tier.far); the stage's shadow box is refitted per shot
// (stage.setShadowFocus). Framing: the nominal frustum is mapped onto the part of #board that
// ui.js leaves uncovered (setViewOffset), exactly as before.
//
// Styles: cinematic (everything) · calm (helicopter + gentle push-ins, raised kerb, no cuts /
// shake / dolly) · free (never moves by itself; ⟲ glides back once). The player can take the
// camera (drag / wheel / ✋); the director steps aside and resumes after AUTO_RESUME_MS.
// The user's map view (⊞ / M) outranks every scripted shot: shots asked for meanwhile are kept
// and the latest one plays when the map closes.

import * as THREE from './three.js';
import { SEAT_YAW, M, pointAt, address, sOf, angleDelta, wrap, JAIL_YARD } from './city-layout.js';

const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };
const inOut = (u) => { u = clamp(u, 0, 1); return u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2; };

// ---- tuning (§9) -----------------------------------------------------------------------------------
const HELI = { fov: 30, pitchWide: 58 * DEG, pitchTall: 68 * DEG, ring: 175 * 1.08, top: 30, lean: 0.15, shift: 0.1, drift: 3 * DEG, driftPeriod: 40 };
const MAP = { fov: 22, pitch: 88 * DEG, ring: 185 * 1.05, glide: 0.45 };
const READY = { fov: 50, back: 8, backPerLength: 1.2, up: 3, upPerHeight: 0.4, inner: 2, ahead: 6, lookY: 1.2 };
const TRANSIT = { fov: 45, pitch: 50 * DEG, pad: 1.25, kick: 6 };
const TRACK = { fov: 45, lateral: -12, up: 4, lead: 4, blend: 18 };
const KERB = { fov: 45, fovTall: 58, back: -12.5, along: 4, eye: 1.7, eyeTall: 5, tall: 30, calmEye: 25, breathe: 0.01, breathePeriod: 6 };
const CRANE = { fov: 40, out: 30, eye: 8, over: 10, pan: 0.25, hotelOut: 90, hotelEye: 10 };
const ESTABLISH = { fov: 40, up: 55, out: 110, orbit: 4 * DEG };
const HERO = { fov: 32, dist: 5, eye: 1.2, orbit: 6 * DEG };
const FRAME = { fov: 35, pitch: 60 * DEG, pad: 1.2 };
const ORBIT = { fov: 40, radius: 28, up: 10, speed: 0.25 };
const CUT_GAP = 1.0; // animation s between two cuts
const MAX_ANG_SPEED = 1.5; // rad/s
const MAX_ANG_ACCEL = 3.2; // rad/s²
const MOVE_SPEED = 2.5; // × dist per s (look-at, distance)
const MOVE_ACCEL = 6; // × dist per s²
const FOV_SPEED = 40; // °/s
const OMEGA = { heli: 2.5, map: 3.2, ready: 4.2, transit: 3.2, track: 5, kerb: 4.2, crane: 3, establish: 3, hero: 4, frame: 3.4, orbit: 2.4, skyline: 2.5 };
const CALM_OMEGA = 0.8;
const VIEW_OMEGA = 9; // the framing follows a changed safe area
const AUTO_RESUME_MS = 4000;
const DIALOG_OVER_BOARD = '(min-width: 900px)';
const MIN_SAFE = 0.5;
const CHANNELS = ['yaw', 'pitch', 'dist', 'tx', 'ty', 'tz', 'fov'];
const SHAKE_HZ = 18;
const SHAKE_RAD = 0.15; // shake amplitude 1 = 0.15 rad of jitter (0.08 → ~0.7°)
export const CAMERA_STYLES = ['cinematic', 'calm', 'free'];
const CORNER_OF = { go: 0, jail: 10, fp: 20, gtj: 30 };

/** Scratch objects (no per-frame allocation). */
const V1 = new THREE.Vector3();
const PT = {};

export class Director {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {object} controls OrbitControls
   * @param {object} [opts]
   * @param {{w:number,h:number}} [opts.size]  live canvas size
   * @param {() => void} [opts.onWake]        the camera wants frames (auto-resume)
   * @param {(s:{suspended:boolean,pinned:boolean,style:string}) => void} [opts.onChange]
   * @param {object} [opts.stage]             setShadowFocus, tier.far
   * @param {object} [opts.subjects]          { char(id) → {x,y,z,heading,length,height}|null, lot(tile) → {height}|null }
   */
  constructor(camera, controls, { size = null, onWake = null, onChange = null, stage = null, subjects = null } = {}) {
    this.camera = camera;
    this.controls = controls;
    this.size = size;
    this.onWake = onWake;
    this.onChange = onChange;
    this.stage = stage;
    this.subjects = subjects ?? {};
    this.cur = { yaw: SEAT_YAW, pitch: HELI.pitchWide, dist: 900, tx: 0, ty: 0, tz: 0, fov: HELI.fov };
    this.vel = { yaw: 0, pitch: 0, dist: 0, tx: 0, ty: 0, tz: 0, fov: 0 };
    this.goal = { ...this.cur };
    this.mode = 'heli';
    this.omega = OMEGA.heli;
    this.live = null; // () => pose: a shot that follows something (re-aimed every frame)
    this.glide = null; // scripted flyTo in progress
    this.time = 0; // animation seconds (dt × rate)
    this.lastCut = -Infinity;
    this.cuts = []; // { at (animation s), real (ms), shot } — metrics / debugging
    this.fovKick = 0;
    this.shakeFx = null;
    this.dolly = null;
    this.leanTarget = null;
    this.heliPose = null;
    this.userMap = false;
    this.deferred = null;
    this.focusKey = '';
    this.lastFocus = null;
    this.suspended = false;
    this.pinned = false;
    this.lastInput = 0;
    this.resumeTimer = 0;
    this.instant = false;
    this.rate = 1;
    this.style = 'cinematic';
    this.recentering = false;
    this.placed = false;
    this.freeShot = false;
    this.fitCache = new Map();
    this.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    this.view = null;
    this.viewGoal = null;
    this.viewFor = { w: 0, h: 0 };
    this.nearFar = { near: 0, far: 0, fov: 0 };
    // The stage fits near / far (and fog) per frame when it can (setAutoClip); otherwise the director does.
    this.ownClip = typeof stage?.setAutoClip !== 'function';
    this.syncView(true);
    this.heli();
    this.snap({ force: true });
    this.placed = false; // provisional: the first render places the camera for real
  }

  // ---- settings ---------------------------------------------------------------------------------

  get narrow() {
    const r = this.viewGoal;
    if (r) return r.w < 520 || r.h < 390;
    return !!this.size?.w && this.size.w < 520;
  }

  /** Aspect of the visible rectangle the shots are composed for. */
  get aspect() {
    const r = this.viewGoal;
    return r && r.h > 0 ? r.w / r.h : this.camera.aspect || 1;
  }

  /** May the director move the camera right now? */
  get auto() {
    return !this.suspended && (this.style !== 'free' || this.recentering);
  }

  get cinematic() {
    return this.style === 'cinematic' && !this.instant;
  }

  setStyle(style) {
    if (!CAMERA_STYLES.includes(style) || style === this.style) return;
    const was = this.style;
    this.style = style;
    this.recentering = false;
    if (style !== 'cinematic') { this.shakeFx = null; this.dolly = null; }
    if (was === 'free') {
      this.readCamera();
      this.heli(this.leanTarget);
    }
    this.notify();
  }

  setRate(rate) {
    this.rate = Number.isFinite(rate) && rate > 0 ? rate : 1;
  }

  setSafeArea(insets, { snap = false } = {}) {
    const n = (v) => Math.max(0, Number(v) || 0);
    const next = { top: n(insets?.top), right: n(insets?.right), bottom: n(insets?.bottom), left: n(insets?.left) };
    const same = ['top', 'right', 'bottom', 'left'].every((k) => Math.abs(next[k] - this.insets[k]) < 0.5);
    this.insets = next;
    if (same && !snap) return false;
    this.syncView(snap);
    this.refit({ snap: snap && this.style !== 'free' });
    return true;
  }

  /** Legacy (tabletop seats): the city always films from the helicopter seat. */
  setSeat() {}

  // ---- shot plumbing ----------------------------------------------------------------------------

  /** The user's map view holds the camera: remember the latest scripted shot for later. */
  held(name, args) {
    if (!this.userMap || this.mapCall) return false;
    this.deferred = [name, args];
    return true;
  }

  setMode(mode, live = null) {
    this.mode = mode;
    this.live = live;
    this.breathe = false;
    this.omega = OMEGA[mode] ?? OMEGA.heli;
    if (mode !== 'transit') this.fovKick = 0;
  }

  setGoal(p) {
    if (this.style === 'free' && this.placed && !this.freeShot) return;
    const g = this.goal;
    g.yaw = p.yaw; g.pitch = p.pitch; g.dist = p.dist; g.tx = p.tx; g.ty = p.ty; g.tz = p.tz; g.fov = p.fov;
  }

  /** Shadow box for the shot (stage.setShadowFocus). */
  focusShadow(focus, { freeze = false } = {}) {
    const key = focus ? `${Math.round(focus.x)},${Math.round(focus.z)},${Math.round(focus.radius)},${freeze}` : `null,${freeze}`;
    if (key === this.focusKey) return;
    this.focusKey = key;
    if (focus) this.lastFocus = focus;
    try {
      this.stage?.setShadowFocus?.(focus ?? this.lastFocus ?? null, { freeze });
    } catch (err) {
      console.error('[renderer3d] setShadowFocus failed:', err);
    }
  }

  /**
   * Turns the shot just set into a scripted glide of `seconds` (animation s): the distance moves
   * in log space and the look-at follows the distance, so pull-outs and dives keep the subject.
   */
  flyTo(seconds, { ease = inOut } = {}) {
    if (!this.auto || this.instant || !(seconds > 0)) return;
    if (this.live) { const p = this.live(); if (p) this.setGoal(p); }
    this.glide = { from: { ...this.cur }, dur: seconds, t: 0, ease };
    for (const k of CHANNELS) this.vel[k] = 0;
  }

  /**
   * A hard cut to the current shot (cinematic style, director in charge, ≥ CUT_GAP after the last
   * one). Returns true if it cut (the caller plays the whoosh); otherwise the shot glides in.
   */
  cut({ glide = 0.45 } = {}) {
    if (!this.auto || this.instant) return false;
    if (this.style !== 'cinematic' || this.time - this.lastCut < CUT_GAP - 1e-6) {
      if (this.style !== 'free') this.flyTo(glide / (this.style === 'calm' ? 0.8 : 1));
      return false;
    }
    this.lastCut = this.time;
    this.cuts.push({ at: this.time, real: performance.now(), shot: this.mode });
    if (this.cuts.length > 200) this.cuts.splice(0, this.cuts.length - 200);
    this.snap();
    return true;
  }

  /** Seconds (animation) since the last cut. */
  get sinceCut() {
    return this.time - this.lastCut;
  }

  // ---- shots ------------------------------------------------------------------------------------

  /** Helicopter pitch for the visible rectangle: 58° on wide frames → 68° on tall ones. */
  heliPitch() {
    const a = this.aspect;
    const f = clamp((a - 0.75) / (1.3 - 0.75), 0, 1);
    return lerp(HELI.pitchTall, HELI.pitchWide, f);
  }

  /** The helicopter pose leaning toward `lean` ({x, z} — the active character), without the drift. */
  heliPoseFor(lean = null) {
    const has = lean && Number.isFinite(lean.x) && Number.isFinite(lean.z) && Math.hypot(lean.x, lean.z) > 1;
    const yaw = SEAT_YAW + (has ? HELI.lean * Math.sin(angleDelta(SEAT_YAW, Math.atan2(lean.x, lean.z))) : 0);
    const pitch = this.heliPitch();
    const R = HELI.ring;
    const pts = [];
    for (const x of [-R, R]) for (const z of [-R, R]) for (const y of [0, HELI.top]) pts.push({ x, y, z });
    const f = this.fit(pts, yaw, pitch, HELI.fov, { margin: this.narrow ? 1.0 : 0.97, key: 'heli' });
    let tx = f.tx;
    let tz = f.tz;
    if (has) { tx += (lean.x - tx) * HELI.shift; tz += (lean.z - tz) * HELI.shift; }
    return { yaw, pitch, dist: f.dist, tx, ty: 0, tz, fov: HELI.fov };
  }

  /** Home: the helicopter, leaning toward `lean` (world {x, z}). `glide`: a scripted crane-up (s). */
  heli(lean = null, { glide = 0 } = {}) {
    if (this.held('heli', [lean, { glide }])) return;
    this.leanTarget = lean && Number.isFinite(lean.x) ? { x: lean.x, z: lean.z } : null;
    const pose = this.heliPoseFor(this.leanTarget);
    this.heliPose = pose;
    this.setMode('heli');
    this.setGoal(pose);
    this.focusShadow({ x: 0, z: 0, radius: 230 });
    if (glide > 0) this.flyTo(glide);
  }

  /** Legacy name of heli(). */
  overview(lean = null) {
    this.heli(lean);
  }

  /** The map view (north up). `user`: the ⊞ / M toggle (outranks scripted shots). */
  map(on = true, { user = false, glide = MAP.glide } = {}) {
    if (user) {
      this.userMap = !!on;
      if (!on) {
        const d = this.deferred;
        this.deferred = null;
        this.mapCall = false;
        if (d && typeof this[d[0]] === 'function') this[d[0]](...d[1]);
        else this.heli(this.leanTarget);
        this.flyTo(glide);
        return;
      }
    } else if (this.held('map', [on, { glide }])) return;
    if (!on) { this.heli(this.leanTarget, { glide }); return; }
    this.mapCall = user;
    const R = MAP.ring;
    const pts = [];
    for (const x of [-R, R]) for (const z of [-R, R]) pts.push({ x, y: 0, z });
    const f = this.fit(pts, 0, MAP.pitch, MAP.fov, { margin: 1, key: 'map' });
    this.setMode('map');
    this.setGoal({ yaw: 0, pitch: MAP.pitch, dist: f.dist, tx: f.tx, ty: 0, tz: f.tz, fov: MAP.fov });
    this.flyTo(glide);
    this.mapCall = false;
  }

  /** Behind character `id` at street level, looking down the lane (the turn-start dive: glide 0.7). */
  ready(id, { glide = 0.5 } = {}) {
    if (this.held('ready', [id, { glide }])) return;
    const live = () => {
      const c = this.subjects.char?.(id);
      if (!c) return null;
      const fx = Math.sin(c.heading);
      const fz = Math.cos(c.heading);
      const ox = Math.cos(c.heading); // outward (toward the lots) = left of travel
      const oz = -Math.sin(c.heading);
      const back = READY.back + READY.backPerLength * (c.length || 1);
      const cx = c.x - fx * back - ox * READY.inner;
      const cz = c.z - fz * back - oz * READY.inner;
      const cy = (c.y || 0) + READY.up + READY.upPerHeight * (c.height || 1);
      return poseFrom(cx, cy, cz, c.x + fx * READY.ahead, (c.y || 0) + READY.lookY, c.z + fz * READY.ahead, READY.fov);
    };
    if (!live()) return;
    this.setMode('ready', live);
    this.setGoal(live());
    const c = this.subjects.char?.(id);
    if (c) this.focusShadow({ x: c.x, z: c.z, radius: 45 });
    if (glide > 0) this.flyTo(glide);
  }

  /**
   * The rest of a walk from the inner side: fits `points` ({x, z}) with pad 1.25 at pitch 50°,
   * FOV 45. `pullOut`: the scripted glide out of the current shot (animation s).
   */
  transit(points, { pullOut = 0 } = {}) {
    if (this.held('transit', [points, { pullOut }])) return;
    const pts = (points ?? []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.z));
    if (!pts.length) return;
    // The inner side: the camera stands toward the city centre from the middle of the walk.
    let mx = 0;
    let mz = 0;
    for (const p of pts) { mx += p.x; mz += p.z; }
    mx /= pts.length;
    mz /= pts.length;
    const yaw = Math.hypot(mx, mz) > 1 ? Math.atan2(-mx, -mz) : SEAT_YAW;
    const fitPts = [];
    for (const p of pts) { fitPts.push({ x: p.x, y: 0, z: p.z }); fitPts.push({ x: p.x, y: 4, z: p.z }); }
    const f = this.fit(fitPts, yaw, TRANSIT.pitch, TRANSIT.fov, { margin: 1 / TRANSIT.pad, minDist: 40 });
    this.setMode('transit');
    this.setGoal({ yaw, pitch: TRANSIT.pitch, dist: f.dist, tx: f.tx, ty: 0, tz: f.tz, fov: TRANSIT.fov });
    this.focusShadow(null, { freeze: true });
    if (pullOut > 0) this.flyTo(pullOut);
  }

  /** FOV kick during the time-lapse cruise (degrees, cinematic only). */
  setFovKick(deg) {
    this.fovKick = this.cinematic && this.mode === 'transit' ? clamp(Number(deg) || 0, 0, TRANSIT.kick) : 0;
  }

  /** A tracking dolly on the inner side of character `id`, blending into kerb(dest) as it arrives. */
  track(id, dest, { glide = 0.4, dir = 1, from = null } = {}) {
    if (this.held('track', [id, dest, { glide, dir, from }])) return;
    const end = this.kerbPose(dest);
    const ds = sOf(dest);
    let sGuess = null;
    const live = () => {
      const c = this.subjects.char?.(id);
      if (!c) return end;
      sGuess = sNear(c.x, c.z, sGuess ?? sOf(Number.isInteger(from) ? from : dest));
      const p = pointAt(sGuess + TRACK.lead * (dir < 0 ? -1 : 1), TRACK.lateral, PT);
      const pose = poseFrom(p.x, TRACK.up, p.z, c.x, (c.y || 0) + 1.2, c.z, TRACK.fov);
      const rem = Math.abs(modDist(ds - sGuess));
      const u = smooth(1 - rem / TRACK.blend);
      return u > 0 ? mixPose(pose, end, u) : pose;
    };
    this.setMode('track', live);
    this.setGoal(live());
    this.focusShadow({ x: end.tx, z: end.tz, radius: 45 });
    if (glide > 0) this.flyTo(glide);
  }

  /**
   * The kerb pose of tile i: on the inner sidewalk across the avenue, eye 1.7 m (5 m for a building
   * over 30 m), looking at the lot front at y = clamp(0.35 · H, 3, 25). Calm style: 25 m up.
   */
  kerbPose(tile, { hold = false, height = null } = {}) {
    const i = wrap(tile);
    const a = address(i);
    const H = Number.isFinite(height) ? height : Number(this.subjects.lot?.(i)?.height) || 12;
    const tall = H > KERB.tall;
    const calm = this.style === 'calm';
    // lane point + out × (−12.5) + along × 4: the inner sidewalk, a little past the address.
    const camX = a.x + a.out.x * KERB.back + a.along.x * KERB.along;
    const camZ = a.z + a.out.z * KERB.back + a.along.z * KERB.along;
    const eye = calm ? KERB.calmEye : tall ? KERB.eyeTall : KERB.eye;
    const front = { x: a.lot.front.x + a.out.x * 8, z: a.lot.front.z + a.out.z * 8 };
    let lookY = clamp(0.35 * H, 3, 25);
    let lx = front.x;
    let lz = front.z;
    const fov = tall ? KERB.fovTall : KERB.fov;
    if (hold && typeof matchMedia === 'function' && matchMedia(DIALOG_OVER_BOARD).matches) {
      // The buy / debt dialog covers the lower part of the board: aim lower and nearer, so the lot
      // sits in the upper 60 % of the frame.
      const d = Math.hypot(lx - camX, lz - camZ);
      lookY = Math.max(0.5, lookY - Math.tan((fov / 2) * DEG) * d * 0.35);
    }
    if (a.corner) { lx = a.lot.cx; lz = a.lot.cz; }
    return poseFrom(camX, eye, camZ, lx, lookY, lz, fov);
  }

  /** At the kerb across from tile `tile` (landing, buy commercial, rent, card at a kiosk, auction). */
  kerb(tile, { hold = false, height = null, glide = 0 } = {}) {
    if (this.held('kerb', [tile, { hold, height, glide }])) return;
    if (!Number.isInteger(tile)) return;
    const base = this.kerbPose(tile, { hold, height });
    this.kerbTile = tile;
    this.setMode('kerb');
    this.breathe = hold && this.style !== 'free';
    this.setGoal(base);
    const a = address(tile);
    this.focusShadow({ x: a.lot.cx, z: a.lot.cz, radius: 45 });
    if (glide > 0) this.flyTo(glide);
  }

  /** Legacy name: a tile close-up is the kerb shot now. */
  focus(index, { hold = false } = {}) {
    this.kerb(index, { hold });
  }

  /**
   * Construction: 30 m in front of the lots (inner side), 8 m up, rising to H + 10 with the growth
   * front over `duration` while panning 0.25 rad across the group. `hotel`: 90 m out (more for
   * towers), a tilt-up from 10 m to the crown.
   */
  crane(tiles, { hotel = false, height = 20, duration = 1.5 } = {}) {
    if (this.held('crane', [tiles, { hotel, height, duration }])) return;
    const list = (Array.isArray(tiles) ? tiles : [tiles]).filter(Number.isInteger);
    if (!list.length) return;
    const H = Math.max(6, Number(height) || 20);
    let cx = 0;
    let cz = 0;
    let ox = 0;
    let oz = 0;
    for (const i of list) {
      const a = address(i);
      cx += a.lot.cx / list.length;
      cz += a.lot.cz / list.length;
      ox += a.out.x / list.length;
      oz += a.out.z / list.length;
    }
    const on = Math.hypot(ox, oz) || 1;
    ox /= on;
    oz /= on;
    const t0 = this.time;
    const dur = Math.max(0.3, duration);
    const calm = this.style === 'calm';
    const live = () => {
      const u = smooth((this.time - t0) / dur);
      if (hotel) {
        const D = clamp(1.4 * H, CRANE.hotelOut, 220);
        const eye = lerp(CRANE.hotelEye, Math.max(CRANE.hotelEye, 0.35 * H), u);
        const look = lerp(CRANE.hotelEye, 0.75 * H, u);
        return poseFrom(cx - ox * D, eye, cz - oz * D, cx, look, cz, CRANE.fov);
      }
      const D = CRANE.out + (M.LOT_D / 2 + (M.PROP - M.KERB) + 0); // from the lot centre
      const panYaw = (u - 0.5) * (calm ? 0 : CRANE.pan) * (list.length > 1 ? 1 : 0.4);
      const px = Math.cos(panYaw) * -ox - Math.sin(panYaw) * -oz;
      const pz = Math.sin(panYaw) * -ox + Math.cos(panYaw) * -oz;
      const eye = lerp(CRANE.eye, H + CRANE.over, u);
      const look = lerp(3, 0.55 * H, u);
      return poseFrom(cx + px * D, eye, cz + pz * D, cx, look, cz, CRANE.fov);
    };
    this.setMode('crane', live);
    this.setGoal(live());
    this.focusShadow({ x: cx, z: cz, radius: Math.max(45, H) });
  }

  /** Establishing shots: 'jail' | 'go' | 'fp' | 'gtj' (orbiting 4°/s) and the 5 s 'intro' spline. */
  establish(name, { seconds = 5 } = {}) {
    if (this.held('establish', [name, { seconds }])) return;
    if (name === 'intro') return this.introShot(seconds);
    const i = CORNER_OF[name];
    if (i === undefined) return;
    const a = address(i);
    const cx = a.lot.cx;
    const cz = a.lot.cz;
    const n = Math.hypot(cx, cz) || 1;
    const base = Math.atan2(cx / n, cz / n); // outward along the corner diagonal
    const t0 = this.time;
    const look = name === 'jail' ? { x: (JAIL_YARD.minX + JAIL_YARD.maxX) / 2, z: (JAIL_YARD.minZ + JAIL_YARD.maxZ) / 2 } : { x: cx, z: cz };
    const live = () => {
      const yaw = base + ESTABLISH.orbit * (this.time - t0);
      const r = ESTABLISH.out;
      return poseFrom(look.x + Math.sin(yaw) * r, ESTABLISH.up, look.z + Math.cos(yaw) * r, look.x, 4, look.z, ESTABLISH.fov);
    };
    this.setMode('establish', live);
    this.setGoal(live());
    this.focusShadow({ x: look.x, z: look.z, radius: 70 });
  }

  /** The intro: over the sea, past the lighthouse, to the GO Gate, then up to the helicopter. */
  introShot(seconds = 5) {
    const t0 = this.time;
    const spline = seconds * 0.76;
    const cam = new THREE.CatmullRomCurve3([
      new THREE.Vector3(900, 120, 300), new THREE.Vector3(560, 80, -40), new THREE.Vector3(330, 45, 150), new THREE.Vector3(175, 16, 182),
    ], false, 'centripetal');
    const look = new THREE.CatmullRomCurve3([
      new THREE.Vector3(380, 20, -270), new THREE.Vector3(300, 15, -120), new THREE.Vector3(160, 12, 150), new THREE.Vector3(130, 8, 130),
    ], false, 'centripetal');
    const P = new THREE.Vector3();
    const L = new THREE.Vector3();
    const heliPose = () => this.heliPoseFor(this.leanTarget);
    const live = () => {
      const t = this.time - t0;
      if (t >= seconds) return heliPose();
      const u = inOut(Math.min(1, t / spline));
      cam.getPoint(u, P);
      look.getPoint(u, L);
      const p = poseFrom(P.x, P.y, P.z, L.x, L.y, L.z, 40);
      if (t <= spline) return p;
      return logMix(p, heliPose(), inOut((t - spline) / (seconds - spline)));
    };
    this.setMode('establish', live);
    this.setGoal(live());
    this.snap();
    this.focusShadow({ x: 0, z: 0, radius: 230 });
  }

  /** Close on a character (4–6 m, 1.2 m up, FOV 32), orbiting 6°/s. `jail`: through the yard gate. */
  hero(id, { jail = false } = {}) {
    if (this.held('hero', [id, { jail }])) return;
    const c0 = this.subjects.char?.(id);
    if (!c0) return;
    const t0 = this.time;
    const start = c0.heading + 2.2; // front-left, the inner side
    const live = () => {
      const c = this.subjects.char?.(id) ?? c0;
      const ly = (c.y || 0) + 0.6 * (c.height || 1.2);
      if (jail) return poseFrom(JAIL_YARD.gate.x - 1, 2.2, JAIL_YARD.gate.z + 1.5, c.x, ly, c.z, HERO.fov);
      const yaw = start + HERO.orbit * (this.time - t0);
      const d = HERO.dist + 0.5 * (c.length || 1);
      return poseFrom(c.x + Math.sin(yaw) * d, (c.y || 0) + HERO.eye + 0.3 * (c.height || 1), c.z + Math.cos(yaw) * d, c.x, ly, c.z, HERO.fov);
    };
    this.setMode('hero', live);
    this.setGoal(live());
    this.focusShadow({ x: c0.x, z: c0.z, radius: 45 });
  }

  /** Fits world points ({x, z}) from the helicopter's yaw, pitch 60°, FOV 35. */
  frame(points, { pad = FRAME.pad } = {}) {
    if (this.held('frame', [points, { pad }])) return;
    const pts = (points ?? []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.z));
    if (!pts.length) return this.heli(this.leanTarget);
    const yaw = this.heliPose?.yaw ?? SEAT_YAW;
    const fitPts = [];
    for (const p of pts) { fitPts.push({ x: p.x, y: 0, z: p.z }); fitPts.push({ x: p.x, y: 6, z: p.z }); }
    const f = this.fit(fitPts, yaw, FRAME.pitch, FRAME.fov, { margin: 1 / pad, minDist: 60 });
    this.setMode('frame');
    this.setGoal({ yaw, pitch: FRAME.pitch, dist: f.dist, tx: f.tx, ty: 0, tz: f.tz, fov: FRAME.fov });
    let r = 45;
    for (const p of pts) r = Math.max(r, Math.hypot(p.x - f.tx, p.z - f.tz) + 10);
    this.focusShadow({ x: f.tx, z: f.tz, radius: Math.min(230, r) });
  }

  /** A slow circle around character `id` (victory). */
  orbit(id, seconds = 10) {
    if (this.held('orbit', [id, seconds])) return;
    const c0 = this.subjects.char?.(id);
    if (!c0) return;
    const t0 = this.time;
    const y0 = Math.atan2(-c0.x, -c0.z); // start on the inner side
    const live = () => {
      const c = this.subjects.char?.(id) ?? c0;
      const yaw = y0 + ORBIT.speed * (this.time - t0);
      return poseFrom(c.x + Math.sin(yaw) * ORBIT.radius, (c.y || 0) + ORBIT.up, c.z + Math.cos(yaw) * ORBIT.radius, c.x, (c.y || 0) + 2, c.z, ORBIT.fov);
    };
    this.orbitUntil = this.time + seconds;
    this.setMode('orbit', live);
    this.setGoal(live());
    this.focusShadow({ x: c0.x, z: c0.z, radius: 45 });
  }

  /** Crane back from wherever the camera is to the helicopter over `seconds` (victory end). */
  skyline(seconds = 4) {
    if (this.held('skyline', [seconds])) return;
    const pose = this.heliPoseFor(this.leanTarget);
    this.heliPose = pose;
    this.setMode('skyline');
    this.setGoal(pose);
    this.focusShadow({ x: 0, z: 0, radius: 230 });
    this.flyTo(seconds);
  }

  /** Decaying 18 Hz jitter on the view (cinematic only): amp (0.08 = jail slam), seconds. */
  shake(amp, seconds = 0.3) {
    if (!this.cinematic || !this.auto) return;
    this.shakeFx = { amp: Number(amp) || 0, dur: Math.max(0.05, seconds), t0: this.time };
  }

  /** Dolly-zoom: the FOV tweens to `fov` while the distance compensates (cinematic only). */
  dollyZoom(fov = 31, seconds = 0.8) {
    if (!this.cinematic || !this.auto) return;
    this.dolly = { f0: this.cur.fov, f1: fov, dur: Math.max(0.1, seconds), t0: this.time };
  }

  // ---- user override ----------------------------------------------------------------------------

  suspend() {
    this.lastInput = performance.now();
    this.recentering = false;
    this.glide = null;
    if (!this.suspended) {
      this.suspended = true;
      this.notify();
    }
    this.armResume();
  }

  pin(on) {
    this.pinned = !!on;
    if (this.pinned) this.suspend();
    else this.resume();
    this.notify();
  }

  resume() {
    clearTimeout(this.resumeTimer);
    this.resumeTimer = 0;
    const was = this.suspended || this.pinned;
    this.pinned = false;
    if (!this.suspended) {
      if (was) this.notify();
      return;
    }
    this.suspended = false;
    this.readCamera();
    this.notify();
  }

  recenter() {
    this.resume();
    if (this.style !== 'free') return;
    this.readCamera();
    this.freeShot = true;
    this.heli(this.leanTarget);
    this.freeShot = false;
    this.recentering = true;
  }

  armResume() {
    clearTimeout(this.resumeTimer);
    this.resumeTimer = 0;
    if (this.pinned || this.style === 'free') return;
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = 0;
      if (!this.suspended || this.pinned || this.style === 'free') return;
      const idle = performance.now() - this.lastInput;
      if (idle < AUTO_RESUME_MS - 50) return this.armResume();
      this.resume();
      this.onWake?.();
    }, AUTO_RESUME_MS);
  }

  notify() {
    try {
      this.onChange?.({ suspended: this.suspended, pinned: this.pinned, style: this.style });
    } catch (err) {
      console.error('[renderer3d] camera state listener failed:', err);
    }
  }

  /** Reads the pose back from the camera (after the player moved it). */
  readCamera() {
    const off = V1.subVectors(this.camera.position, this.controls.target);
    const dist = off.length() || 1;
    const c = this.cur;
    c.tx = this.controls.target.x;
    c.ty = this.controls.target.y;
    c.tz = this.controls.target.z;
    c.dist = dist;
    c.pitch = Math.asin(clamp(off.y / dist, -1, 1));
    c.yaw = Math.atan2(off.x, off.z);
    c.fov = this.camera.fov - this.fovKick;
    for (const k of CHANNELS) this.vel[k] = 0;
    this.glide = null;
  }

  // ---- per frame --------------------------------------------------------------------------------

  /** Moves the camera toward the current shot. Returns true while it (or the framing) still moves. */
  update(dt) {
    const framing = this.updateView(dt);
    const step = Math.max(0, Number(dt) || 0) * this.rate;
    this.time += step;
    if (!this.auto) {
      this.updateLens();
      return framing;
    }
    if (this.mode === 'orbit' && this.time > (this.orbitUntil ?? Infinity)) this.skyline();
    // A live shot (it follows something) only asks for frames while its subject actually moves.
    let liveMoved = false;
    if (this.live) {
      const p = this.live();
      if (p) {
        const g = this.goal;
        liveMoved = Math.abs(angleDelta(g.yaw, p.yaw)) > 1e-5 || Math.abs(g.pitch - p.pitch) > 1e-5 || Math.abs(g.dist - p.dist) > 1e-4
          || Math.abs(g.tx - p.tx) > 1e-4 || Math.abs(g.ty - p.ty) > 1e-4 || Math.abs(g.tz - p.tz) > 1e-4 || Math.abs(g.fov - p.fov) > 1e-4;
        this.setGoal(p);
      }
    }
    if (this.instant) {
      this.glide = null;
      this.snap({ force: true });
      return framing || liveMoved;
    }
    if (dt <= 0) return true;
    let moving = false;
    if (this.glide) {
      const g = this.glide;
      g.t += step;
      const u = g.ease(Math.min(1, g.t / g.dur));
      const p = logMix(g.from, this.goal, u);
      Object.assign(this.cur, p);
      if (g.t >= g.dur) {
        this.glide = null;
        Object.assign(this.cur, this.goal);
      }
      for (const k of CHANNELS) this.vel[k] = 0;
      moving = true;
    } else {
      moving = this.spring(dt);
    }
    this.apply();
    if (!moving && this.recentering) this.recentering = false;
    return moving || framing || liveMoved || !!this.shakeFx || !!this.dolly;
  }

  /** Critically damped springs with eased speed-up and distance-relative caps. */
  spring(dt) {
    const w = this.omega * (this.style === 'calm' ? CALM_OMEGA : 1) * this.rate;
    const r = this.rate;
    const n = Math.max(1, Math.ceil(dt / (1 / 90)));
    const h = dt / n;
    let moving = false;
    const scale = Math.max(5, this.cur.dist);
    for (const k of CHANNELS) {
      const angular = k === 'yaw' || k === 'pitch';
      const vmax = (angular ? MAX_ANG_SPEED : k === 'fov' ? FOV_SPEED : MOVE_SPEED * scale) * r;
      const amax = (angular ? MAX_ANG_ACCEL : k === 'fov' ? FOV_SPEED * 3 : MOVE_ACCEL * scale) * r * r;
      let x = this.cur[k];
      let v = this.vel[k];
      for (let s = 0; s < n; s++) {
        const d = k === 'yaw' ? -angleDelta(x, this.goal.yaw) : x - this.goal[k];
        let a = -w * w * d - 2 * w * v;
        if (a * v >= 0 && Math.abs(a) > amax) a = Math.sign(a) * amax;
        v += a * h;
        if (Math.abs(v) > vmax) v = Math.sign(v) * vmax;
        x += v * h;
      }
      this.cur[k] = x;
      this.vel[k] = v;
      const d = k === 'yaw' ? -angleDelta(x, this.goal.yaw) : x - this.goal[k];
      const eps = k === 'dist' || k === 'tx' || k === 'ty' || k === 'tz' ? 1e-3 * Math.max(1, scale / 20) : 1e-4;
      if (Math.abs(d) > eps || Math.abs(v) > eps) moving = true;
    }
    return moving;
  }

  /** Jumps straight to the current shot (free style: only the first placement, or `force`). */
  snap({ force = false } = {}) {
    if (this.style === 'free' && this.placed && !force && !this.recentering) return;
    if (this.live) { const p = this.live(); if (p) this.setGoal(p); }
    this.glide = null;
    Object.assign(this.cur, this.goal);
    for (const k of CHANNELS) this.vel[k] = 0;
    if (!this.suspended) {
      this.apply();
      this.placed = true;
    }
  }

  /** Writes the pose to the camera (+ shake, dolly-zoom, FOV kick, per-shot near / far). */
  apply() {
    const c = this.cur;
    let yaw = c.yaw;
    let pitch = c.pitch;
    let dist = c.dist;
    let fov = c.fov;
    if (this.dolly) {
      const d = this.dolly;
      const u = smooth((this.time - d.t0) / d.dur);
      const f = lerp(d.f0, d.f1, u);
      dist *= Math.tan((d.f0 / 2) * DEG) / Math.tan((f / 2) * DEG);
      fov = f;
      if (u >= 1 && this.mode !== 'kerb' && this.mode !== 'hero') this.dolly = null;
    }
    if (this.mode === 'heli' && this.cinematic && !this.glide) {
      yaw += HELI.drift * Math.sin((2 * Math.PI * performance.now()) / 1000 / HELI.driftPeriod);
    }
    if (this.breathe && !this.glide) dist *= 1 + KERB.breathe * Math.sin((2 * Math.PI * performance.now()) / 1000 / KERB.breathePeriod);
    if (this.shakeFx) {
      const s = this.shakeFx;
      const t = this.time - s.t0;
      if (t >= s.dur) this.shakeFx = null;
      else {
        const k = s.amp * SHAKE_RAD * (1 - t / s.dur) ** 2;
        yaw += k * Math.sin(2 * Math.PI * SHAKE_HZ * t);
        pitch += k * 0.7 * Math.sin(2 * Math.PI * SHAKE_HZ * 1.37 * t + 1.1);
      }
    }
    const cp = Math.cos(pitch);
    let px = c.tx + dist * cp * Math.sin(yaw);
    let py = c.ty + dist * Math.sin(pitch);
    let pz = c.tz + dist * cp * Math.cos(yaw);
    if (py < 0.6) py = 0.6; // never under the street
    this.camera.position.set(px, py, pz);
    this.controls.target.set(c.tx, c.ty, c.tz);
    this.camera.lookAt(this.controls.target);
    fov += this.fovKick;
    this.camera.fov = clamp(fov, 10, 90);
    this.updateLens(dist, py);
  }

  /** Per-shot near / far and the FOV (projection updated only when they change). */
  updateLens(dist = this.camera.position.distanceTo(this.controls.target), altitude = this.camera.position.y) {
    if (!this.ownClip) {
      if (this.nearFar.fov !== this.camera.fov) {
        this.nearFar.fov = this.camera.fov;
        this.camera.updateProjectionMatrix();
      }
      return;
    }
    const far0 = Number(this.stage?.tier?.far) || 3000;
    const near = clamp(0.02 * Math.min(Math.max(altitude, 0.5), dist), 0.1, 1.0);
    const far = clamp(6 * dist + 8 * altitude + 1500, 2000, Math.max(2000, far0));
    const nf = this.nearFar;
    if (Math.abs(nf.near - near) > nf.near * 0.05 || Math.abs(nf.far - far) > nf.far * 0.05 || nf.fov !== this.camera.fov) {
      nf.near = near;
      nf.far = far;
      nf.fov = this.camera.fov;
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Live speeds (for tests): yaw rad/s, look-at m/s, distance m/s. */
  speed() {
    return { yaw: Math.abs(this.vel.yaw), move: Math.hypot(this.vel.tx, this.vel.ty, this.vel.tz), dist: Math.abs(this.vel.dist) };
  }

  /** Is the camera already close on tile `index` (legacy helper)? */
  isFraming(index, radius = 40) {
    if (!this.auto) return true;
    const a = address(index);
    return Math.hypot(this.cur.tx - a.lot.cx, this.cur.tz - a.lot.cz) < radius && this.cur.dist < 80;
  }

  // ---- framing (visible rectangle → view offset) --------------------------------------------------

  computeView() {
    const W = this.size?.w || 0;
    const H = this.size?.h || 0;
    if (!W || !H) return null;
    const squeeze = (a, b, total) => {
      const free = total - a - b;
      if (free >= total * MIN_SAFE) return [a, b];
      const k = (total * (1 - MIN_SAFE)) / (a + b || 1);
      return [a * k, b * k];
    };
    const { top, right, bottom, left } = this.insets;
    const [l, r] = squeeze(left, right, W);
    const [t, b] = squeeze(top, bottom, H);
    return { x: l, y: t, w: W - l - r, h: H - t - b };
  }

  syncView(snap = false) {
    const goal = this.computeView();
    if (!goal) return;
    const resized = this.viewFor.w !== this.size.w || this.viewFor.h !== this.size.h;
    this.viewFor = { w: this.size.w, h: this.size.h };
    this.viewGoal = goal;
    if (snap || resized || !this.view) this.view = { ...goal };
    this.applyView();
  }

  updateView(dt) {
    if (!this.view || !this.viewGoal) return false;
    const v = this.view;
    const g = this.viewGoal;
    const d = Math.abs(v.x - g.x) + Math.abs(v.y - g.y) + Math.abs(v.w - g.w) + Math.abs(v.h - g.h);
    if (d < 0.25) {
      if (d > 0) {
        Object.assign(v, g);
        this.applyView();
      }
      return false;
    }
    const k = this.instant ? 1 : 1 - Math.exp(-VIEW_OMEGA * Math.max(0, dt));
    for (const key of ['x', 'y', 'w', 'h']) v[key] += (g[key] - v[key]) * k;
    this.applyView();
    return true;
  }

  applyView() {
    const W = this.size?.w || 0;
    const H = this.size?.h || 0;
    const v = this.view;
    if (!W || !H || !v || v.w < 1 || v.h < 1) return;
    this.camera.setViewOffset(v.w, v.h, -v.x, -v.y, W, H);
    this.camera.updateProjectionMatrix();
  }

  onResize() {
    this.fitCache.clear();
    this.syncView(true);
    this.refit({ snap: this.style !== 'free' });
  }

  /** Recomputes the helicopter / map framing for the current frame (glides there, or snaps). */
  refit({ snap = false } = {}) {
    if (this.mode === 'heli') this.heli(this.leanTarget);
    else if (this.mode === 'map') { const was = this.mapCall; this.mapCall = true; this.map(true, { glide: 0 }); this.mapCall = was; }
    else return;
    if (snap && !this.suspended) this.snap();
  }

  /**
   * Closest pose from (yaw, pitch, fov) that shows every point inside the visible rectangle
   * (scaled by `margin`): an exact solve per aim point (camera-space bounds are linear in the
   * distance), the aim slid along the ground (convex → ternary search) and centred sideways.
   * @returns {{dist:number, tx:number, tz:number}}
   */
  fit(points, yaw, pitch, fov, { margin = 1, key = null, minDist = 5 } = {}) {
    const aspect = this.aspect;
    const ck = key ? `${key}|${aspect.toFixed(3)}|${yaw.toFixed(3)}|${pitch.toFixed(3)}|${fov}|${margin}` : null;
    if (ck && this.fitCache.has(ck)) return this.fitCache.get(ck);
    const res = fitPoints(points, yaw, pitch, fov, aspect, margin, minDist);
    if (ck) {
      this.fitCache.set(ck, res);
      if (this.fitCache.size > 64) this.fitCache.delete(this.fitCache.keys().next().value);
    }
    return res;
  }

  dispose() {
    clearTimeout(this.resumeTimer);
    this.resumeTimer = 0;
  }
}

// ---- pure helpers --------------------------------------------------------------------------------

/** A pose from a camera position and a look-at point. */
export function poseFrom(cx, cy, cz, tx, ty, tz, fov) {
  const dx = cx - tx;
  const dy = cy - ty;
  const dz = cz - tz;
  const dist = Math.max(0.5, Math.hypot(dx, dy, dz));
  return { yaw: Math.atan2(dx, dz), pitch: Math.asin(clamp(dy / dist, -1, 1)), dist, tx, ty, tz, fov };
}

/** Blend of two poses (shortest yaw, linear everything else). */
function mixPose(a, b, u) {
  return {
    yaw: a.yaw + angleDelta(a.yaw, b.yaw) * u,
    pitch: lerp(a.pitch, b.pitch, u),
    dist: lerp(a.dist, b.dist, u),
    tx: lerp(a.tx, b.tx, u),
    ty: lerp(a.ty, b.ty, u),
    tz: lerp(a.tz, b.tz, u),
    fov: lerp(a.fov, b.fov, u),
  };
}

/**
 * The scripted-glide blend: distance in log space; the look-at follows the distance's progress,
 * so on a pull-out it stays with the subject while the camera is close and slides over once it is
 * far (small angular change), and on a dive it does the opposite.
 */
export function logMix(a, b, u) {
  const d0 = Math.max(0.5, a.dist);
  const d1 = Math.max(0.5, b.dist);
  const dist = d0 * (d1 / d0) ** u;
  const w = Math.abs(d1 - d0) > 1e-3 ? (dist - d0) / (d1 - d0) : u;
  return {
    yaw: a.yaw + angleDelta(a.yaw, b.yaw) * u,
    pitch: lerp(a.pitch, b.pitch, u),
    dist,
    tx: lerp(a.tx, b.tx, w),
    ty: lerp(a.ty, b.ty, w),
    tz: lerp(a.tz, b.tz, w),
    fov: lerp(a.fov, b.fov, u),
  };
}

/** Signed shortest distance along the loop. */
function modDist(d) {
  const L = 1042.549;
  d %= L;
  if (d > L / 2) d -= L;
  if (d < -L / 2) d += L;
  return d;
}

/** Arc length along the token lane nearest to (x, z), refined from `guess`. */
export function sNear(x, z, guess = 0) {
  let s = Number.isFinite(guess) ? guess : 0;
  for (let k = 0; k < 4; k++) {
    const p = pointAt(s, 0, PT);
    const ds = (x - p.x) * Math.sin(p.heading) + (z - p.z) * Math.cos(p.heading);
    s += ds;
    if (Math.abs(ds) < 0.01) break;
  }
  return s;
}

/**
 * Fit (see Director.fit). Camera basis for (yaw, pitch): back b = (cp·sy, sp, cp·cy), right
 * r = (cy, 0, −sy), up u = (−sp·sy, cp, −sp·cy). With the camera at c (coordinates c_r, c_u, c_b in
 * that basis) a point P is inside iff |P_r − c_r| ≤ kh·(c_b − P_b) and |P_u − c_u| ≤ kv·(c_b − P_b).
 * The two axes decouple: the closest camera (least c_b) is solved exactly per axis, then the axis
 * with slack is centred. The aim is where the view ray meets the ground.
 */
export function fitPoints(points, yaw, pitch, fov, aspect, margin = 1, minDist = 5) {
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  const kv = Math.tan((fov / 2) * DEG) * margin;
  const kh = kv * aspect;
  const pts = points ?? [];
  if (!pts.length) return { dist: minDist, tx: 0, tz: 0 };
  const q = pts.map((p) => {
    const x = p.x;
    const y = p.y ?? 0;
    const z = p.z;
    return { r: x * cy - z * sy, u: -sp * sy * x + cp * y - sp * cy * z, b: cp * sy * x + sp * y + cp * cy * z };
  });
  const axis = (key, k) => {
    let A = -Infinity;
    let B = -Infinity;
    for (const v of q) {
      A = Math.max(A, k * v.b + v[key]);
      B = Math.max(B, k * v.b - v[key]);
    }
    return (A + B) / (2 * k);
  };
  const cb = Math.max(axis('r', kh), axis('u', kv));
  // Centre an axis for the chosen depth: f(c) = max + min of the projected offsets = 0 (monotone).
  const centre = (key) => {
    let lo = -1e5;
    let hi = 1e5;
    for (let n = 0; n < 60; n++) {
      const c = (lo + hi) / 2;
      let mx = -Infinity;
      let mn = Infinity;
      for (const v of q) {
        const t = (v[key] - c) / Math.max(1e-6, cb - v.b);
        if (t > mx) mx = t;
        if (t < mn) mn = t;
      }
      if (mx + mn > 0) lo = c;
      else hi = c;
    }
    return (lo + hi) / 2;
  };
  const cr = centre('r');
  const cu = centre('u');
  // World camera position, then the aim on the ground along the view ray (−b).
  let px = cr * cy - cu * sp * sy + cb * cp * sy;
  let py = cu * cp + cb * sp;
  let pz = -cr * sy - cu * sp * cy + cb * cp * cy;
  if (!(sp > 0.05)) return { dist: Math.max(minDist, cb), tx: px - cp * sy * cb, tz: pz - cp * cy * cb };
  let d = py / sp;
  if (d < minDist) {
    px += (minDist - d) * cp * sy;
    pz += (minDist - d) * cp * cy;
    py += (minDist - d) * sp;
    d = minDist;
  }
  return { dist: d, tx: px - d * cp * sy, tz: pz - d * cp * cy };
}
