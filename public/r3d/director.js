// public/r3d/director.js — the "TV director" camera.
//
// Shots:
//   overview  the whole board from the viewer's seat (their side of the table; the GO side for
//             spectators), turned toward a 3/4 view. It leans at most ~30° toward the active player
//             but never spins the table: the viewer keeps their own side.
//   dice      a closer, steeper look at the plaza while the dice are thrown.
//   follow    trails a walking token from outside the board edge.
//   focus     close on one tile (landing, purchase, building), or a wider look (a token arriving by
//             card / jail).
//   orbit     slow circle around the winner.
// Follow and focus shots stay within ±110° of the seat, so the camera never swings across the board.
//
// Motion: every channel (yaw, pitch, distance, look-at point) is a critically damped spring that
// keeps its velocity, so a shot change mid-move blends smoothly. Speeding up is limited (a new shot
// eases in from rest instead of whipping) and top speeds are capped for big moves.
//
// The player can take the camera (drag / wheel on desktop, the ✋ free-look button everywhere):
// the director steps aside and takes over again after AUTO_RESUME_MS without input, unless free
// look is pinned (✋), then only on ⟲.

import * as THREE from './three.js';
import { SIDE_YAW, sideOf, tileCenter, outward, angleDelta } from './layout.js';

// ---- tuning knobs ---------------------------------------------------------------------------------
const OVERVIEW_YAW_OFFSET = 0.55; // 3/4 view: from the seat, turned ~31° toward the GO corner side
const OVERVIEW_PITCH = 0.82; // ~47° above the table
const OVERVIEW_PITCH_NARROW = 1.08; // ~62° on small canvases, so the board fills the square
const NARROW_PX = 500;
const DRIFT_GAIN = 0.3; // how far the overview leans toward the active player…
const DRIFT_MAX = 0.35; // …at most ~20°
const FIT_MARGIN = 0.98; // fraction of the canvas the board may fill in the overview
const DICE_PITCH = 1.05; // ~60°
const DICE_DIST = 9.5;
const FOLLOW_PITCH = 0.62; // ~35°
const FOLLOW_DIST = 7;
const FOLLOW_TRAIL = 0.38; // radians behind the token (tokens travel toward decreasing yaw)
const FOCUS_PITCH = 1.02; // ~58°
const FOCUS_DIST = 7.4;
const WIDE_DIST = 9.6; // focus(…, {wide}) — a token flying in by card / to jail
const ORBIT_SPEED = 0.35; // rad/s around the winner
const MAX_SWING = 1.9; // follow / focus shots stay within ±this (rad) of the seat
const MAX_YAW_SPEED = 1.5; // rad/s (~86°/s) — also pitch
const MAX_YAW_ACCEL = 3.2; // rad/s² while speeding up: a shot change eases in over ~0.4 s
const MAX_MOVE_SPEED = 14; // units/s for the look-at point and the distance
const MAX_MOVE_ACCEL = 30; // units/s² while speeding up
const OMEGA = { overview: 3.4, dice: 4.6, follow: 4.2, focus: 4.2, orbit: 2.4 }; // spring stiffness (1/s)
const AUTO_RESUME_MS = 4000;
// Where ui.js shows its buy / debt dialogs: over the lower part of the board on wide layouts, in the
// side panel below 900px (style.css / ui.js NARROW). A held tile is framed to stay clear of it.
const DIALOG_OVER_BOARD = '(min-width: 900px)';
const EPS = 1e-4;

const CHANNELS = ['yaw', 'pitch', 'dist', 'tx', 'ty', 'tz'];

export class Director {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {object} controls OrbitControls
   * @param {object} [opts]
   * @param {{w:number,h:number}} [opts.size]  live canvas size (narrow layouts)
   * @param {() => void} [opts.onWake]        the camera wants frames (auto-resume)
   * @param {(s:{suspended:boolean,pinned:boolean}) => void} [opts.onChange]  free-camera state changed
   */
  constructor(camera, controls, { size = null, onWake = null, onChange = null } = {}) {
    this.camera = camera;
    this.controls = controls;
    this.size = size;
    this.onWake = onWake;
    this.onChange = onChange;
    this.cur = { yaw: 0, pitch: OVERVIEW_PITCH, dist: 20, tx: 0, ty: 0, tz: 0 };
    this.vel = { yaw: 0, pitch: 0, dist: 0, tx: 0, ty: 0, tz: 0 };
    this.goal = { yaw: 0, pitch: OVERVIEW_PITCH, dist: 20, tx: 0, ty: 0, tz: 0 };
    this.mode = 'overview';
    this.omega = OMEGA.overview;
    this.subject = null; // Object3D followed / orbited
    this.seatYaw = 0; // the viewer's side of the table
    this.leanYaw = 0; // current overview lean toward the active player
    this.suspended = false;
    this.pinned = false; // free look pinned: no auto-resume
    this.lastInput = 0;
    this.resumeTimer = 0;
    this.orbitUntil = 0;
    this.instant = false; // reduced motion: cut between shots
    this.fitCache = new Map();
    this.tmp = new THREE.Vector3();
    this.overview();
    this.snap();
  }

  get narrow() {
    return !!this.size?.w && this.size.w < NARROW_PX;
  }

  // ---- shots ------------------------------------------------------------------------------------

  /** The viewer's side of the table (radians, SIDE_YAW convention). */
  setSeat(yaw) {
    this.seatYaw = Number.isFinite(yaw) ? yaw : 0;
  }

  /**
   * Whole board from the seat, leaning toward `lean` (a world {x, z} — the active token), fitted
   * to the canvas.
   */
  overview(lean = null) {
    this.setMode('overview', null);
    let drift = 0;
    if (lean && Math.hypot(lean.x, lean.z) > 0.5) {
      drift = angleDelta(this.seatYaw + OVERVIEW_YAW_OFFSET, Math.atan2(lean.x, lean.z)) * DRIFT_GAIN;
      drift = Math.max(-DRIFT_MAX, Math.min(DRIFT_MAX, drift));
    }
    this.leanYaw = this.seatYaw + OVERVIEW_YAW_OFFSET + drift;
    const pitch = this.narrow ? OVERVIEW_PITCH_NARROW : OVERVIEW_PITCH;
    const fit = this.fit(this.leanYaw, pitch);
    this.setGoal(this.leanYaw, pitch, fit.dist, fit.tx, 0, fit.tz);
  }

  /** Overview leaning toward tile `index`. */
  overviewFor(index) {
    const c = Number.isInteger(index) ? tileCenter(index) : null;
    this.overview(c);
  }

  /** The plaza while dice are thrown, from the overview's side. */
  dice() {
    this.setMode('dice', null);
    const dist = this.narrow ? DICE_DIST * 1.05 : DICE_DIST;
    this.setGoal(this.leanYaw, DICE_PITCH, dist, 0, 0, 0.15);
  }

  /** Trails an object (a walking token) from outside the board edge. */
  follow(obj) {
    this.setMode('follow', obj);
    this.aimFollow();
  }

  /**
   * Close-up of a tile from outside its edge. `hold`: keep the tile clear of the dialog area.
   * `wide`: further out (a token arriving from across the board).
   */
  focus(index, { hold = false, wide = false } = {}) {
    this.setMode('focus', null);
    const c = tileCenter(index);
    const o = outward(index);
    // Look a bit nearer the camera → the tile sits higher on screen (above a dialog); or further in
    // → more of the board shows around it.
    const overBoard = typeof matchMedia === 'function' && matchMedia(DIALOG_OVER_BOARD).matches;
    const push = hold ? (overBoard ? 0.4 : -0.45) : wide ? -0.9 : -0.5;
    const yaw = sideOf(index) === 'corner' ? Math.atan2(c.x, c.z) : SIDE_YAW[sideOf(index)];
    this.setGoal(this.limitYaw(yaw), FOCUS_PITCH, wide ? WIDE_DIST : FOCUS_DIST, c.x + o.x * push, 0.1, c.z + o.z * push);
  }

  /** Slow circle around an object for `seconds` (winner). */
  orbit(obj, seconds = 10) {
    this.setMode('orbit', obj);
    this.orbitUntil = performance.now() + seconds * 1000;
    this.setGoal(this.cur.yaw, 0.55, 5, obj.position.x, 0.25, obj.position.z);
  }

  setMode(mode, subject) {
    this.mode = mode;
    this.subject = subject;
    this.omega = OMEGA[mode] ?? OMEGA.overview;
  }

  setGoal(yaw, pitch, dist, tx, ty, tz) {
    Object.assign(this.goal, { yaw, pitch, dist, tx, ty, tz });
  }

  /** Keeps a shot's yaw within ±MAX_SWING of the seat, staying on the side the camera is on. */
  limitYaw(yaw) {
    const d = angleDelta(this.seatYaw, yaw);
    if (Math.abs(d) <= MAX_SWING) return yaw;
    const side = angleDelta(this.seatYaw, this.cur.yaw);
    const sign = Math.abs(side) > 0.2 ? Math.sign(side) : Math.sign(d);
    return this.seatYaw + sign * MAX_SWING;
  }

  aimFollow() {
    const p = this.subject?.position;
    if (!p) return;
    const radial = Math.hypot(p.x, p.z) > 0.5 ? Math.atan2(p.x, p.z) : this.goal.yaw;
    this.setGoal(this.limitYaw(radial + FOLLOW_TRAIL), FOLLOW_PITCH, FOLLOW_DIST, p.x, 0.25, p.z);
  }

  // ---- user override ----------------------------------------------------------------------------

  /** The player moved the camera: step aside (and come back after a pause unless pinned). */
  suspend() {
    this.lastInput = performance.now();
    if (!this.suspended) {
      this.suspended = true;
      this.notify();
    }
    this.armResume();
  }

  /** Free look pinned (✋): no auto-resume until unpinned or ⟲. */
  pin(on) {
    this.pinned = !!on;
    if (this.pinned) this.suspend();
    else this.resume();
    this.notify();
  }

  /** Hands the camera back to the director (starting from wherever the player left it). */
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

  armResume() {
    clearTimeout(this.resumeTimer);
    this.resumeTimer = 0;
    if (this.pinned) return;
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = 0;
      if (!this.suspended || this.pinned) return;
      const idle = performance.now() - this.lastInput;
      if (idle < AUTO_RESUME_MS - 50) return this.armResume();
      this.resume();
      this.onWake?.();
    }, AUTO_RESUME_MS);
  }

  notify() {
    try {
      this.onChange?.({ suspended: this.suspended, pinned: this.pinned });
    } catch (err) {
      console.error('[renderer3d] camera state listener failed:', err);
    }
  }

  readCamera() {
    const off = this.tmp.subVectors(this.camera.position, this.controls.target);
    const dist = off.length() || 1;
    const c = this.cur;
    c.tx = this.controls.target.x;
    c.ty = this.controls.target.y;
    c.tz = this.controls.target.z;
    c.dist = dist;
    c.pitch = Math.asin(Math.max(-1, Math.min(1, off.y / dist)));
    c.yaw = Math.atan2(off.x, off.z);
    for (const k of CHANNELS) this.vel[k] = 0;
  }

  // ---- per frame --------------------------------------------------------------------------------

  /** Moves the camera toward the current shot. Returns true while it is still moving. */
  update(dt) {
    if (this.suspended) return false;
    if (this.mode === 'follow') this.aimFollow();
    if (this.mode === 'orbit') {
      if (performance.now() > this.orbitUntil || !this.subject) this.overview();
      else {
        this.goal.tx = this.subject.position.x;
        this.goal.tz = this.subject.position.z;
        this.goal.yaw += dt * ORBIT_SPEED;
      }
    }
    if (this.instant) {
      this.snap();
      return this.mode === 'orbit';
    }
    if (dt <= 0) return true;
    const w = this.omega;
    let moving = this.mode === 'follow' || this.mode === 'orbit';
    // Critically damped spring per channel, with the speed-up limited (a gentle ease-in however far
    // the shot is) and a top speed; slowing down is left to the spring. Sub-stepped for stability.
    const n = Math.max(1, Math.ceil(dt / (1 / 90)));
    const h = dt / n;
    for (const k of CHANNELS) {
      const angular = k === 'yaw' || k === 'pitch';
      const vmax = angular ? MAX_YAW_SPEED : MAX_MOVE_SPEED;
      const amax = angular ? MAX_YAW_ACCEL : MAX_MOVE_ACCEL;
      let x = this.cur[k];
      let v = this.vel[k];
      for (let s = 0; s < n; s++) {
        const d = k === 'yaw' ? -angleDelta(x, this.goal.yaw) : x - this.goal[k];
        let a = -w * w * d - 2 * w * v;
        if (a * v >= 0 && Math.abs(a) > amax) a = Math.sign(a) * amax; // speeding up: ease in
        v += a * h;
        if (Math.abs(v) > vmax) v = Math.sign(v) * vmax;
        x += v * h;
      }
      this.cur[k] = x;
      this.vel[k] = v;
      const d = k === 'yaw' ? -angleDelta(x, this.goal.yaw) : x - this.goal[k];
      if (Math.abs(d) > (k === 'dist' ? 1e-3 : EPS) || Math.abs(v) > 1e-3) moving = true;
    }
    this.apply();
    return moving;
  }

  /** A hard cut to the current shot (TV-style: no travel), unless the player has the camera. */
  cut() {
    if (this.suspended || this.instant) return;
    this.snap();
  }

  /** Jumps straight to the current shot. */
  snap() {
    if (this.mode === 'follow') this.aimFollow();
    Object.assign(this.cur, this.goal);
    for (const k of CHANNELS) this.vel[k] = 0;
    if (!this.suspended) this.apply();
  }

  apply() {
    const c = this.cur;
    const cp = Math.cos(c.pitch);
    this.camera.position.set(
      c.tx + c.dist * cp * Math.sin(c.yaw),
      c.ty + c.dist * Math.sin(c.pitch),
      c.tz + c.dist * cp * Math.cos(c.yaw),
    );
    this.controls.target.set(c.tx, c.ty, c.tz);
    this.camera.lookAt(this.controls.target);
  }

  /** Live speeds (for tests): yaw rad/s, look-at point units/s. */
  speed() {
    return { yaw: Math.abs(this.vel.yaw), move: Math.hypot(this.vel.tx, this.vel.ty, this.vel.tz), dist: Math.abs(this.vel.dist) };
  }

  /** The canvas changed size: refit the overview. */
  onResize() {
    this.fitCache.clear();
    if (this.mode === 'overview') {
      const pitch = this.narrow ? OVERVIEW_PITCH_NARROW : OVERVIEW_PITCH;
      const fit = this.fit(this.goal.yaw, pitch);
      Object.assign(this.goal, { pitch, dist: fit.dist, tx: fit.tx, tz: fit.tz });
      if (!this.suspended) this.snap();
    }
  }

  /**
   * Closest overview from (yaw, pitch) that shows the whole board: the distance, and where to aim
   * (slid toward / away from the camera so the board sits centred instead of low in the frame).
   * @returns {{dist:number, tx:number, tz:number}}
   */
  fit(yaw, pitch) {
    const aspect = this.camera.aspect || 1;
    const key = `${aspect.toFixed(3)}|${yaw.toFixed(3)}|${pitch.toFixed(3)}`;
    if (this.fitCache.has(key)) return this.fitCache.get(key);
    const cam = new THREE.PerspectiveCamera(this.camera.fov, aspect, 0.1, 200);
    const pts = [];
    const R = 6.1;
    for (const x of [-R, R]) for (const z of [-R, R]) for (const y of [0, 0.3]) pts.push(new THREE.Vector3(x, y, z));
    const v = new THREE.Vector3();
    const cp = Math.cos(pitch);
    const dx = Math.sin(yaw);
    const dz = Math.cos(yaw);
    const fits = (d, off) => {
      const tx = -dx * off;
      const tz = -dz * off;
      cam.position.set(tx + d * cp * dx, d * Math.sin(pitch), tz + d * cp * dz);
      cam.lookAt(tx, 0, tz);
      cam.updateMatrixWorld();
      return pts.every((p) => {
        v.copy(p).project(cam);
        return Math.abs(v.x) <= FIT_MARGIN && Math.abs(v.y) <= FIT_MARGIN && v.z < 1;
      });
    };
    let best = { dist: Infinity, tx: 0, tz: 0 };
    for (let off = -3.5; off <= 3.501; off += 0.1) {
      let lo = 4;
      let hi = 60;
      if (!fits(hi, off)) continue;
      for (let k = 0; k < 22; k++) {
        const mid = (lo + hi) / 2;
        if (fits(mid, off)) hi = mid;
        else lo = mid;
      }
      if (hi < best.dist - 1e-6) best = { dist: hi, tx: -dx * off, tz: -dz * off };
    }
    if (!Number.isFinite(best.dist)) best = { dist: 22, tx: 0, tz: 0 };
    this.fitCache.set(key, best);
    return best;
  }

  dispose() {
    clearTimeout(this.resumeTimer);
    this.resumeTimer = 0;
  }
}
