// public/r3d/director.js — the "TV director" camera.
//
// Shots:
//   overview  the whole board from the viewer's side of the table (the GO side), turned toward a
//             3/4 view. It leans at most ~20° toward the active player but never spins the table.
//   dice      a closer, steeper look at the plaza (and the thrower) while the dice are thrown.
//   follow    trails a walking token from outside the board edge, leading it (feed-forward on its
//             velocity) so the token stays centred instead of hugging the frame edge.
//   focus     close on one tile (landing, purchase, building), or a wider look (a token arriving by
//             card / jail).
//   frame     fits a set of world points (both parties of a trade, tiles changing hands).
//   orbit     slow circle around the winner.
//
// Styles (the "3D camera" setting):
//   cinematic follow / focus / cuts; shots stay within ±110° of the seat.
//   calm      overview-anchored: gentle push-ins, walks filmed within ±45° of the overview yaw, no cuts.
//   free      never moves on its own: the player orbits (⟲ glides back to the overview once).
//
// Framing: the board is framed inside the part of #board that ui.js's header / panel / bottom sheet
// leave uncovered (#board.dataset.safe* → setSafeArea). The camera's nominal frustum is mapped onto
// that rectangle with camera.setViewOffset, so every shot is centred in the visible area while the
// rest of the canvas (under the panels, and the table / room on wide screens) still renders.
//
// Motion: every channel (yaw, pitch, distance, look-at point) is a critically damped spring that
// keeps its velocity, so a shot change mid-move blends smoothly. Speeding up is limited (a new shot
// eases in from rest instead of whipping) and top speeds are capped. `rate` scales all of it (the
// "fast" speed setting, catching up on queued states): stiffness and speeds × rate, accel × rate².
//
// The player can take the camera (drag / wheel on desktop, the ✋ free-look button everywhere):
// the director steps aside and takes over again after AUTO_RESUME_MS without input, unless free
// look is pinned (✋), then only on ⟲.

import * as THREE from './three.js';
import { SIDE_YAW, sideOf, tileCenter, outward, angleDelta } from './layout.js';

// ---- tuning knobs ---------------------------------------------------------------------------------
// Overview by the aspect (w / h) of the visible rectangle. Yaw: a 3/4 view turned ~31° toward the GO
// corner on landscape screens; nearly square-on in portrait, where a turned board's diagonal would
// have to fit the narrow width (~35% smaller). Pitch: steep on tall phones so the board fills the
// width, lower on wide screens — a toy on a table, with the room around it.
const OVERVIEW_YAW_BY_ASPECT = [[0.7, 0.12], [1.0, 0.36], [1.3, 0.55]];
const OVERVIEW_PITCH_BY_ASPECT = [[0.6, 1.1], [0.9, 1.0], [1.25, 0.88], [1.7, 0.8], [2.4, 0.74], [3.2, 0.66]];
const DRIFT_GAIN = 0.3; // how far the overview leans toward the active player…
const DRIFT_MAX = 0.35; // …at most ~20°
const FIT_MARGIN = 0.9; // share of the visible rectangle the board fills in the overview
const FIT_MARGIN_SMALL = 0.98; // small screens: every pixel counts
const SMALL_PX = 520; // a visible rectangle narrower or shorter than this is "small"
const MIN_SAFE = 0.5; // panels never squeeze the board's frame below this share of the canvas (per axis)
const DICE_PITCH = 1.0; // ~57°
const DICE_DIST = 9.8;
const DICE_TOWARD = 0.3; // the dice shot aims this share of the way from the plaza to the thrower
const FOLLOW_PITCH = 0.62; // ~35°
const FOLLOW_DIST = 7.2;
const FOLLOW_TRAIL = 0.38; // radians behind the token (tokens travel toward decreasing yaw)
const FOLLOW_LEAD_MAX = 2.6; // units: cap on the feed-forward lead
const VEL_SMOOTH = 7; // 1/s: low-pass on the followed token's velocity (hops are jerky)
const FOCUS_PITCH = 1.02; // ~58°
const FOCUS_DIST = 7.4;
const WIDE_DIST = 9.6; // focus(…, {wide}) — a token flying in by card / to jail, a cut before a push-in
const FRAME_PITCH = 0.95;
const ORBIT_SPEED = 0.35; // rad/s around the winner
const ORBIT_PITCH = 0.75; // high enough that the city's towers don't hide the winner
const ORBIT_DIST = 6.2;
const MAX_SWING = 1.9; // cinematic follow / focus shots stay within ±this (rad) of the seat
// Calm style: overview-anchored, gentle.
const CALM = { swing: Math.PI / 4, followPitch: 0.9, followDist: 10.5, focusPitch: 0.98, focusDist: 10.2, wideDist: 12, diceShare: 0.84, omega: 0.8 };
const MAX_YAW_SPEED = 1.5; // rad/s (~86°/s) — also pitch
const MAX_YAW_ACCEL = 3.2; // rad/s² while speeding up: a shot change eases in over ~0.4 s
const MAX_MOVE_SPEED = 14; // units/s for the look-at point and the distance
const MAX_MOVE_ACCEL = 30; // units/s² while speeding up
const OMEGA = { overview: 3.4, dice: 4.6, follow: 4.2, focus: 4.2, frame: 3.8, orbit: 2.4 }; // spring stiffness (1/s)
const VIEW_OMEGA = 9; // 1/s: how fast the framing follows a changed safe area (panel opened / closed)
const AUTO_RESUME_MS = 4000;
// Where ui.js shows its buy / debt dialogs: over the lower part of the board on wide layouts, in the
// side panel / sheet below 900px. A held tile is framed to stay clear of it.
const DIALOG_OVER_BOARD = '(min-width: 900px)';
const EPS = 1e-4;

const CHANNELS = ['yaw', 'pitch', 'dist', 'tx', 'ty', 'tz'];
export const CAMERA_STYLES = ['cinematic', 'calm', 'free'];

/** Piecewise-linear lookup in a [[aspect, value], …] table (clamped at both ends). */
function byAspect(table, a) {
  if (a <= table[0][0]) return table[0][1];
  for (let k = 1; k < table.length; k++) {
    if (a <= table[k][0]) {
      const f = (a - table[k - 1][0]) / (table[k][0] - table[k - 1][0]);
      return table[k - 1][1] + (table[k][1] - table[k - 1][1]) * f;
    }
  }
  return table[table.length - 1][1];
}

export class Director {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {object} controls OrbitControls
   * @param {object} [opts]
   * @param {{w:number,h:number}} [opts.size]  live canvas size
   * @param {() => void} [opts.onWake]        the camera wants frames (auto-resume)
   * @param {(s:{suspended:boolean,pinned:boolean,style:string}) => void} [opts.onChange]  free-camera state changed
   */
  constructor(camera, controls, { size = null, onWake = null, onChange = null } = {}) {
    this.camera = camera;
    this.controls = controls;
    this.size = size;
    this.onWake = onWake;
    this.onChange = onChange;
    this.cur = { yaw: 0, pitch: 0.82, dist: 20, tx: 0, ty: 0, tz: 0 };
    this.vel = { yaw: 0, pitch: 0, dist: 0, tx: 0, ty: 0, tz: 0 };
    this.goal = { yaw: 0, pitch: 0.82, dist: 20, tx: 0, ty: 0, tz: 0 };
    this.mode = 'overview';
    this.omega = OMEGA.overview;
    this.subject = null; // Object3D followed / orbited
    this.seatYaw = 0; // the viewer's side of the table
    this.leanYaw = 0; // current overview yaw (seat + 3/4 offset + lean toward the active player)
    this.overviewDist = 20;
    this.suspended = false;
    this.pinned = false; // free look pinned: no auto-resume
    this.lastInput = 0;
    this.resumeTimer = 0;
    this.orbitUntil = 0;
    this.instant = false; // reduced motion / "instant" speed: cut between shots
    this.rate = 1; // time scale (speed setting × catch-up)
    this.style = 'cinematic';
    this.recentering = false; // free style: gliding back to the overview after ⟲
    this.placed = false; // the camera has been put somewhere (free style places it once)
    this.fitCache = new Map();
    this.tmp = new THREE.Vector3();
    // Follow feed-forward: smoothed velocity of the followed object.
    this.fprev = new THREE.Vector3();
    this.fvel = new THREE.Vector3();
    this.fhas = false;
    // Framing inside the visible rectangle (canvas px): insets from ui.js, current / goal rectangles.
    this.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    this.view = null; // current { x, y, w, h }
    this.viewGoal = null;
    this.viewFor = { w: 0, h: 0 }; // canvas size the rectangles were computed for
    this.syncView(true);
    this.overview();
    this.snap({ force: true });
    this.placed = false; // provisional: the first render places the camera for real
  }

  /** The visible rectangle is small (phones): tighter framing, steeper overview. */
  get narrow() {
    const r = this.viewGoal;
    if (r) return r.w < SMALL_PX || r.h < SMALL_PX * 0.75;
    return !!this.size?.w && this.size.w < SMALL_PX;
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

  // ---- settings ---------------------------------------------------------------------------------

  /** 'cinematic' | 'calm' | 'free' (unknown values are ignored). */
  setStyle(style) {
    if (!CAMERA_STYLES.includes(style) || style === this.style) return;
    const was = this.style;
    this.style = style;
    this.recentering = false;
    if (was === 'free') {
      // Take the camera back from wherever the player left it (the caller re-aims the director).
      this.readCamera();
      this.overview(this.leanTarget);
    }
    this.notify();
  }

  /** Time scale (1 = normal). */
  setRate(rate) {
    this.rate = Number.isFinite(rate) && rate > 0 ? rate : 1;
  }

  /**
   * The part of the canvas covered by ui.js (CSS px from each edge). The board is framed inside what
   * is left. `snap`: jump there (first frame), else glide.
   */
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

  // ---- shots ------------------------------------------------------------------------------------

  /** The viewer's side of the table (radians, SIDE_YAW convention). */
  setSeat(yaw) {
    this.seatYaw = Number.isFinite(yaw) ? yaw : 0;
  }

  /** Overview pitch for the current visible rectangle. */
  overviewPitch() {
    return byAspect(OVERVIEW_PITCH_BY_ASPECT, this.aspect);
  }

  /**
   * Whole board from the seat, leaning toward `lean` (a world {x, z} — the active token), fitted
   * to the visible rectangle.
   */
  overview(lean = null) {
    this.setMode('overview', null);
    this.leanTarget = lean ? { x: lean.x, z: lean.z } : null;
    const offset = byAspect(OVERVIEW_YAW_BY_ASPECT, this.aspect);
    const leanMax = DRIFT_MAX * (offset / OVERVIEW_YAW_BY_ASPECT.at(-1)[1]); // portrait: lean less too
    let drift = 0;
    if (lean && Math.hypot(lean.x, lean.z) > 0.5) {
      drift = angleDelta(this.seatYaw + offset, Math.atan2(lean.x, lean.z)) * DRIFT_GAIN;
      drift = Math.max(-leanMax, Math.min(leanMax, drift));
    }
    this.leanYaw = this.seatYaw + offset + drift;
    const pitch = this.overviewPitch();
    const fit = this.fit(this.leanYaw, pitch);
    this.overviewDist = fit.dist;
    this.setGoal(this.leanYaw, pitch, fit.dist, fit.tx, 0, fit.tz);
  }

  /** Overview leaning toward tile `index`. */
  overviewFor(index) {
    const c = Number.isInteger(index) ? tileCenter(index) : null;
    this.overview(c);
  }

  /**
   * The plaza while dice are thrown, from the overview's side. `near` (world {x, z}): the thrower's
   * token — the shot leans toward it so the follow shot that comes next has less ground to cover.
   */
  dice(near = null) {
    this.setMode('dice', null);
    const nx = near ? near.x * DICE_TOWARD : 0;
    const nz = near ? near.z * DICE_TOWARD : 0;
    if (this.style === 'calm') {
      const pitch = Math.min(1.15, this.overviewPitch() + 0.08);
      this.setGoal(this.leanYaw, pitch, this.overviewDist * CALM.diceShare, nx * 0.5, 0, 0.1 + nz * 0.5);
      return;
    }
    const dist = this.narrow ? DICE_DIST * 1.08 : DICE_DIST;
    this.setGoal(this.leanYaw, DICE_PITCH, dist, nx, 0, 0.15 + nz);
  }

  /** Trails an object (a walking token) from outside the board edge. */
  follow(obj) {
    const same = this.mode === 'follow' && this.subject === obj;
    this.setMode('follow', obj);
    if (!same) {
      this.fhas = false;
      this.fvel.set(0, 0, 0);
    }
    this.aimFollow();
  }

  /**
   * Close-up of a tile from outside its edge. `hold`: keep the tile clear of the dialog area.
   * `wide`: further out (a token arriving from across the board, or the wide half of a cut).
   */
  focus(index, { hold = false, wide = false } = {}) {
    this.setMode('focus', null);
    this.focusIndex = index;
    const c = tileCenter(index);
    const o = outward(index);
    // Look a bit nearer the camera → the tile sits higher on screen (above a dialog); or further in
    // → more of the board shows around it.
    const overBoard = typeof matchMedia === 'function' && matchMedia(DIALOG_OVER_BOARD).matches;
    const push = hold ? (overBoard ? 0.4 : -0.45) : wide ? -0.9 : -0.5;
    const side = sideOf(index) === 'corner' ? Math.atan2(c.x, c.z) : SIDE_YAW[sideOf(index)];
    const calm = this.style === 'calm';
    const pitch = calm ? CALM.focusPitch : FOCUS_PITCH;
    const dist = calm ? (wide ? CALM.wideDist : CALM.focusDist) : wide ? WIDE_DIST : FOCUS_DIST;
    this.setGoal(this.limitYaw(side), pitch, dist * (this.narrow ? 1.08 : 1), c.x + o.x * push, 0.1, c.z + o.z * push);
  }

  /**
   * Fits a set of world points ({x, z}; e.g. both tokens of a trade and the tiles changing hands),
   * seen from the overview's side.
   */
  frame(points, { pad = 1.2 } = {}) {
    const pts = (points ?? []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.z));
    if (!pts.length) return this.overview(this.leanTarget);
    this.setMode('frame', null);
    let cx = 0;
    let cz = 0;
    for (const p of pts) { cx += p.x; cz += p.z; }
    cx /= pts.length;
    cz /= pts.length;
    let r = 0.9;
    for (const p of pts) r = Math.max(r, Math.hypot(p.x - cx, p.z - cz) + pad * 0.5);
    const half = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const halfMin = Math.min(half, Math.atan(Math.tan(half) * this.aspect));
    const dist = Math.max(6, Math.min(this.overviewDist, (r * pad) / Math.sin(halfMin)));
    const yaw = this.style === 'calm' ? this.leanYaw : this.limitYaw(this.leanYaw + angleDelta(this.leanYaw, Math.atan2(cx, cz)) * 0.35);
    this.setGoal(yaw, FRAME_PITCH, dist, cx, 0.1, cz);
  }

  /** Slow circle around an object for `seconds` (winner). */
  orbit(obj, seconds = 10) {
    this.setMode('orbit', obj);
    this.orbitUntil = performance.now() + seconds * 1000;
    this.setGoal(this.cur.yaw, ORBIT_PITCH, ORBIT_DIST * (this.narrow ? 1.15 : 1), obj.position.x, 0.25, obj.position.z);
  }

  setMode(mode, subject) {
    this.mode = mode;
    this.subject = subject;
    this.omega = OMEGA[mode] ?? OMEGA.overview;
  }

  setGoal(yaw, pitch, dist, tx, ty, tz) {
    // Free style: once the camera is placed, shots don't aim it — only the ⟲ glide back does.
    if (this.style === 'free' && this.placed && !this.freeShot) return;
    Object.assign(this.goal, { yaw, pitch, dist, tx, ty, tz });
  }

  /**
   * Keeps a shot's yaw near the viewer: cinematic within ±MAX_SWING of the seat (staying on the side
   * the camera is on); calm within ±45° of the overview yaw.
   */
  limitYaw(yaw) {
    const calm = this.style === 'calm';
    const base = calm ? this.leanYaw : this.seatYaw;
    const swing = calm ? CALM.swing : MAX_SWING;
    const d = angleDelta(base, yaw);
    if (Math.abs(d) <= swing) return yaw;
    if (calm) return base + Math.sign(d) * swing;
    const side = angleDelta(base, this.cur.yaw);
    const sign = Math.abs(side) > 0.2 ? Math.sign(side) : Math.sign(d);
    return base + sign * swing;
  }

  aimFollow() {
    const p = this.subject?.position;
    if (!p) return;
    // Feed-forward: a critically damped spring trails a steadily moving target by 2v/ω; aiming that
    // far ahead keeps the token centred.
    const w = this.effOmega();
    const k = Math.min(FOLLOW_LEAD_MAX, 2 / w);
    let lx = this.fvel.x * k;
    let lz = this.fvel.z * k;
    const len = Math.hypot(lx, lz);
    if (len > FOLLOW_LEAD_MAX) { lx *= FOLLOW_LEAD_MAX / len; lz *= FOLLOW_LEAD_MAX / len; }
    const x = p.x + lx;
    const z = p.z + lz;
    const radial = Math.hypot(x, z) > 0.5 ? Math.atan2(x, z) : this.goal.yaw;
    const calm = this.style === 'calm';
    const pitch = calm ? CALM.followPitch : FOLLOW_PITCH;
    const dist = (calm ? CALM.followDist : FOLLOW_DIST) * (this.narrow ? 1.1 : 1);
    this.setGoal(this.limitYaw(radial + FOLLOW_TRAIL), pitch, dist, x, 0.25, z);
  }

  /** Stiffness right now (mode × style × rate). */
  effOmega() {
    return this.omega * (this.style === 'calm' ? CALM.omega : 1) * this.rate;
  }

  // ---- user override ----------------------------------------------------------------------------

  /** The player moved the camera: step aside (and come back after a pause unless pinned / free). */
  suspend() {
    this.lastInput = performance.now();
    this.recentering = false;
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

  /** ⟲: back to the director's current shot; in free style, one glide back to the overview. */
  recenter() {
    this.resume();
    if (this.style !== 'free') return;
    this.readCamera();
    this.freeShot = true;
    this.overview(this.leanTarget);
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

  /** Moves the camera toward the current shot. Returns true while it (or the framing) still moves. */
  update(dt) {
    const framing = this.updateView(dt);
    if (this.mode === 'follow') this.trackSubject(dt);
    if (!this.auto) return framing;
    if (this.mode === 'follow') this.aimFollow();
    if (this.mode === 'orbit') {
      if (performance.now() > this.orbitUntil || !this.subject) this.overview(this.leanTarget);
      else {
        this.goal.tx = this.subject.position.x;
        this.goal.tz = this.subject.position.z;
        this.goal.yaw += dt * ORBIT_SPEED * this.rate;
      }
    }
    if (this.instant) {
      this.snap({ force: true });
      return this.mode === 'orbit' || framing;
    }
    if (dt <= 0) return true;
    const w = this.effOmega();
    const r = this.rate;
    let moving = false;
    // Critically damped spring per channel, with the speed-up limited (a gentle ease-in however far
    // the shot is) and a top speed; slowing down is left to the spring. Sub-stepped for stability.
    const n = Math.max(1, Math.ceil(dt / (1 / 90)));
    const h = dt / n;
    for (const k of CHANNELS) {
      const angular = k === 'yaw' || k === 'pitch';
      const vmax = (angular ? MAX_YAW_SPEED : MAX_MOVE_SPEED) * r;
      const amax = (angular ? MAX_YAW_ACCEL : MAX_MOVE_ACCEL) * r * r;
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
    if (!moving && this.recentering) this.recentering = false; // free style: arrived, hands off again
    return moving || framing || this.mode === 'follow' || this.mode === 'orbit';
  }

  /** Low-pass velocity of the followed object (for the feed-forward lead). */
  trackSubject(dt) {
    const p = this.subject?.position;
    if (!p || !(dt > 0)) return;
    if (!this.fhas) {
      this.fprev.copy(p);
      this.fvel.set(0, 0, 0);
      this.fhas = true;
      return;
    }
    const k = 1 - Math.exp(-VEL_SMOOTH * dt);
    this.fvel.x += ((p.x - this.fprev.x) / dt - this.fvel.x) * k;
    this.fvel.z += ((p.z - this.fprev.z) / dt - this.fvel.z) * k;
    this.fprev.copy(p);
  }

  /**
   * A hard cut to the current shot (TV-style: no travel). Returns true if it cut (cinematic style,
   * director in charge) — the caller plays the whoosh.
   */
  cut() {
    if (!this.auto || this.instant || this.style !== 'cinematic') return false;
    this.snap();
    return true;
  }

  /**
   * Jumps straight to the current shot. In free style only the first placement (or `force`) moves
   * the camera — the player owns it after that.
   */
  snap({ force = false } = {}) {
    if (this.style === 'free' && this.placed && !force && !this.recentering) return;
    if (this.mode === 'follow') this.aimFollow();
    Object.assign(this.cur, this.goal);
    for (const k of CHANNELS) this.vel[k] = 0;
    if (!this.suspended) {
      this.apply();
      this.placed = true;
    }
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

  /**
   * Is the camera already close on tile `index` (a building pop can play right away)?
   * Looks at where the camera is now, not where it is going.
   */
  isFraming(index, radius = 1.6) {
    if (!this.auto) return true; // the player has the camera: nothing to wait for
    const c = tileCenter(index);
    return Math.hypot(this.cur.tx - c.x, this.cur.tz - c.z) < radius && this.cur.dist < WIDE_DIST + 1.5;
  }

  // ---- framing (visible rectangle → view offset) --------------------------------------------------

  /** The visible rectangle for the current insets and canvas size (canvas px), or null. */
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

  /** Recomputes the goal rectangle (canvas resized / insets changed); `snap` jumps to it. */
  syncView(snap = false) {
    const goal = this.computeView();
    if (!goal) return;
    const resized = this.viewFor.w !== this.size.w || this.viewFor.h !== this.size.h;
    this.viewFor = { w: this.size.w, h: this.size.h };
    this.viewGoal = goal;
    if (snap || resized || !this.view) this.view = { ...goal };
    this.applyView();
  }

  /** Eases the framing toward its goal. Returns true while it moves. */
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

  /** Maps the camera's nominal frustum onto the visible rectangle (the rest of the canvas still renders). */
  applyView() {
    const W = this.size?.w || 0;
    const H = this.size?.h || 0;
    const v = this.view;
    if (!W || !H || !v || v.w < 1 || v.h < 1) return;
    this.camera.setViewOffset(v.w, v.h, -v.x, -v.y, W, H); // also sets camera.aspect = v.w / v.h
    this.camera.updateProjectionMatrix();
  }

  /** The canvas changed size: re-frame, and refit the overview. */
  onResize() {
    this.fitCache.clear();
    this.syncView(true);
    this.refit({ snap: this.style !== 'free' });
  }

  /** Recomputes the overview for the current frame (glides there, or `snap`s). */
  refit({ snap = false } = {}) {
    if (this.mode !== 'overview') return;
    this.overview(this.leanTarget); // yaw, pitch and distance all depend on the frame's aspect
    if (snap && !this.suspended) this.snap();
  }

  /**
   * Closest overview from (yaw, pitch) that shows the whole board inside the visible rectangle:
   * the distance, and where to aim. The aim slides toward / away from the camera — of the aim
   * points that need (almost) the least distance, the one that centres the board vertically wins —
   * and sideways, so the board's (perspective-skewed) outline is centred horizontally too.
   * @returns {{dist:number, tx:number, tz:number}}
   */
  fit(yaw, pitch) {
    const aspect = this.aspect;
    const margin = this.narrow ? FIT_MARGIN_SMALL : FIT_MARGIN;
    const key = `${aspect.toFixed(3)}|${yaw.toFixed(3)}|${pitch.toFixed(3)}|${margin}`;
    if (this.fitCache.has(key)) return this.fitCache.get(key);
    const cam = new THREE.PerspectiveCamera(this.camera.fov, aspect, 0.1, 200);
    const pts = [];
    const R = 6.1;
    for (const x of [-R, R]) for (const z of [-R, R]) for (const y of [0, 0.3]) pts.push(new THREE.Vector3(x, y, z));
    const v = new THREE.Vector3();
    const cp = Math.cos(pitch);
    const dx = Math.sin(yaw);
    const dz = Math.cos(yaw);
    // Aim point: `off` along the ground toward the far side, `lat` to the camera's right.
    const aimAt = (off, lat) => ({ x: -dx * off + dz * lat, z: -dz * off - dx * lat });
    const place = (d, off, lat = 0) => {
      const a = aimAt(off, lat);
      cam.position.set(a.x + d * cp * dx, d * Math.sin(pitch), a.z + d * cp * dz);
      cam.lookAt(a.x, 0, a.z);
      cam.updateMatrixWorld();
    };
    const fits = (d, off, lat = 0) => {
      place(d, off, lat);
      return pts.every((p) => {
        v.copy(p).project(cam);
        return Math.abs(v.x) <= margin && Math.abs(v.y) <= margin && v.z < 1;
      });
    };
    const extent = (d, off, lat = 0) => {
      place(d, off, lat);
      const e = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
      for (const p of pts) {
        v.copy(p).project(cam);
        e.x0 = Math.min(e.x0, v.x);
        e.x1 = Math.max(e.x1, v.x);
        e.y0 = Math.min(e.y0, v.y);
        e.y1 = Math.max(e.y1, v.y);
      }
      return e;
    };
    const closest = (off, lat) => {
      let lo = 4;
      let hi = 70;
      if (!fits(hi, off, lat)) return null;
      for (let k = 0; k < 20; k++) {
        const mid = (lo + hi) / 2;
        if (fits(mid, off, lat)) hi = mid;
        else lo = mid;
      }
      return hi;
    };
    const cands = [];
    for (let off = -3.5; off <= 3.501; off += 0.125) {
      const dist = closest(off, 0);
      if (dist !== null) cands.push({ off, dist });
    }
    let best = { dist: 22, tx: 0, tz: 0 };
    if (cands.length) {
      // Trade a little distance for a vertically centred board (width-limited frames have slack).
      const min = Math.min(...cands.map((c) => c.dist));
      let pick = null;
      let score = Infinity;
      for (const c of cands) {
        if (c.dist > min * 1.08) continue;
        const e = extent(c.dist, c.off);
        const s = c.dist / min + 0.6 * Math.abs(e.y1 + e.y0);
        if (s < score) { score = s; pick = c; }
      }
      // Centre sideways: shift the aim by the outline's horizontal imbalance, refit, repeat.
      let lat = 0;
      let dist = pick.dist;
      const halfW = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * aspect;
      for (let k = 0; k < 4; k++) {
        const e = extent(dist, pick.off, lat);
        const c = (e.x0 + e.x1) / 2;
        if (Math.abs(c) < 0.004) break;
        lat += c * dist * halfW;
        dist = closest(pick.off, lat) ?? dist;
      }
      const a = aimAt(pick.off, lat);
      best = { dist, tx: a.x, tz: a.z };
    }
    this.fitCache.set(key, best);
    if (this.fitCache.size > 64) this.fitCache.delete(this.fitCache.keys().next().value);
    return best;
  }

  dispose() {
    clearTimeout(this.resumeTimer);
    this.resumeTimer = 0;
  }
}
