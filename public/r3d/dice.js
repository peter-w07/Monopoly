// public/r3d/dice.js — two ivory dice that are shaken, thrown into a virtual tray in the plaza and
// always come to rest showing the server's roll (the result is never simulated, only presented).
//
// The throw is "physics-lite": a seeded, deterministic simulation (gravity, bounces that lose
// height and spin, tray walls, a last tumble over the die's edges) laid out up-front, while the
// orientation is solved BACKWARDS from the rest pose that shows the engine's value (dice-math.js):
// each flight segment unwinds a spin about its own axis onto the next segment's start, so the
// final frame is exactly faceUpQuaternion(value). Same seed → same throw on every client.
//
// The dice are rounded ivory with engraved pips (a normal map of concave dimples, paint in the
// hollows) under a thin clear lacquer.

import * as THREE from './three.js';
import { PIP_ORDER, faceUpQuaternion, seeded } from './dice-math.js';
import { ease } from './tween.js';
import { trackEnvironment } from './token-models.js';

const SIZE = 0.44;
const REST_Y = SIZE / 2;
const CORNER = 0.07; // rounded-corner radius (RoundedBoxGeometry)
const SHAKE_TIME = 0.26; // default pre-throw rattle in the hand
const GRAVITY = 28; // units / s² (toy scale: snappy)
const RESTITUTION = 0.42;
const FRICTION = 0.6; // horizontal speed kept per bounce
const SPIN_KEEP = 0.55; // spin kept per bounce
const MIN_BOUNCE_VY = 1.4; // below this the die stops bouncing and tumbles over its edges
const HAND_R = 2.5; // the hand: this far out toward the thrower…
const HAND_Y = 1.2; // …and this high
const FIRST_HIT = 0.62; // first touchdown: this far from the tray centre, toward the thrower
const FLIGHT = 0.32; // seconds from the hand to the first touchdown
const TRAY = { x: 0, z: 0.15, hx: 1.2, hz: 0.95 }; // die centres stay inside this box (the plaza)
const WOBBLE = 0.12; // a last rock on the resting face
const PIPS = {
  1: [[0.5, 0.5]],
  2: [[0.27, 0.27], [0.73, 0.73]],
  3: [[0.25, 0.25], [0.5, 0.5], [0.75, 0.75]],
  4: [[0.27, 0.27], [0.73, 0.27], [0.27, 0.73], [0.73, 0.73]],
  5: [[0.25, 0.25], [0.75, 0.25], [0.5, 0.5], [0.25, 0.75], [0.75, 0.75]],
  6: [[0.28, 0.22], [0.72, 0.22], [0.28, 0.5], [0.72, 0.5], [0.28, 0.78], [0.72, 0.78]],
};
const UP = new THREE.Vector3(0, 1, 0);

export class Dice {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./tween.js').Animator} animator
   * @param {() => void} markShadows
   * @param {number} maxAniso
   * @param {{sfx?: object}} [opts]
   */
  constructor(scene, animator, markShadows, maxAniso = 4, { sfx = null } = {}) {
    this.scene = scene;
    this.animator = animator;
    this.markShadows = markShadows;
    this.sfx = sfx;
    this.group = new THREE.Group();
    this.group.name = 'dice';
    // One atlas (3 × 2 faces) per map and one material: a single draw call per die.
    const maps = pipMaps(maxAniso);
    const mat = new THREE.MeshPhysicalMaterial({
      map: maps.color,
      normalMap: maps.normal,
      normalScale: new THREE.Vector2(1, 1),
      roughnessMap: maps.rough,
      roughness: 1,
      metalness: 0,
      clearcoat: 0.55,
      clearcoatRoughness: 0.22,
    });
    const geo = new THREE.RoundedBoxGeometry(SIZE, SIZE, SIZE, 4, CORNER);
    const uv = geo.attributes.uv;
    const per = uv.count / 6; // faces in material-group order [+X, -X, +Y, -Y, +Z, -Z] (PIP_ORDER)
    for (let k = 0; k < uv.count; k++) {
      const f = Math.floor(k / per);
      uv.setXY(k, ((f % 3) + uv.getX(k)) / 3, (Math.floor(f / 3) + uv.getY(k)) / 2);
    }
    geo.clearGroups();
    this.dice = [0, 1].map(() => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      trackEnvironment(m, 1.45); // the lacquer catches the room (follows the time of day)
      this.group.add(m);
      return m;
    });
    scene.add(this.group);
    this.values = [5, 2];
    this.lastThrow = null;
    this.tmp = { q: new THREE.Quaternion(), q2: new THREE.Quaternion(), v: new THREE.Vector3() };
    this.rest([5, 2], 1);
  }

  /** Plays the dice's own sounds through `sfx` (sfx.js API) — off unless set. */
  setSfx(sfx) {
    this.sfx = sfx ?? null;
  }

  /** Where the dice rest when snapped (seeded jitter inside the tray). */
  restPose(k, rnd) {
    const x = TRAY.x + (k ? 0.42 : -0.42) + (rnd() - 0.5) * 0.25;
    const z = TRAY.z + (rnd() - 0.5) * 0.5;
    return { pos: new THREE.Vector3(x, REST_Y, z), yaw: rnd() * Math.PI * 2 };
  }

  /** Snaps the dice to rest showing `values` (no animation). */
  rest(values, seed = 1) {
    const rnd = seeded(seed);
    this.values = values.slice();
    this.dice.forEach((d, k) => {
      const { pos, yaw } = this.restPose(k, rnd);
      d.position.copy(pos);
      faceUpQuaternion(values[k], yaw, d.quaternion);
      d.scale.setScalar(1);
    });
    this.markShadows();
  }

  /**
   * Schedules a shake + throw that lands on `values`, starting `delay` seconds from now: the dice
   * fly to the thrower's hand and rattle (opts.shake s), are thrown into the plaza, bounce (each
   * bounce lower and slower), tumble over an edge or two and rock to rest.
   * @param {number[]} values  [d1, d2] from dice_rolled
   * @param {{x:number, z:number}} from  unit direction (from the board centre) the dice come from
   * @param {number} seed      same seed → same throw on every client
   * @param {number} delay
   * @param {object} [opts]
   *   small      smaller dice (utility rolls)        speed  play it this much faster
   *   shake      seconds of rattle before the throw (default 0.3; 0 = throw straight away)
   *   onShake()  onThrow()  onBounce(intensity 0..1, die 0|1, kind 'floor'|'edge')
   *   onSettle({ values })  — never during a skip except onSettle({ skipped: true })
   *   sfx        play diceShake / diceThrow / diceBounce / diceSettle through this sfx (else this.sfx)
   * @returns {{duration:number, restAt:number, throwAt:number, contacts:number[],
   *   bounces:{at:number, intensity:number, die:number, kind:string}[], valueOf():number}}
   *   seconds from `delay`: throwAt = release, contacts = the first die's touchdowns, restAt = both
   *   at rest (≈ duration). valueOf() is `duration`, so arithmetic with the old number result works.
   */
  schedule(values, from, seed, delay = 0, opts = {}) {
    const { small = false } = opts;
    const speed = opts.speed > 0 ? opts.speed : 1;
    const shake = (Number.isFinite(opts.shake) ? Math.max(0, opts.shake) : SHAKE_TIME) / speed;
    const scale = small ? 0.8 : 1;
    this.values = values.slice();
    const dir = new THREE.Vector3(from?.x ?? 0, 0, from?.z ?? 1);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    const plans = planThrow(values, dir, seed, scale);
    const bounces = [];
    let restAt = 0;
    plans.forEach((plan, k) => {
      const d = this.dice[k];
      const t0 = shake + plan.offset / speed;
      for (const b of plan.hits) bounces.push({ at: t0 + b.t / speed, intensity: b.intensity, die: k, kind: b.kind });
      restAt = Math.max(restAt, t0 + plan.total / speed);
      const startPos = new THREE.Vector3();
      const startQ = new THREE.Quaternion();
      let hit = 0;
      // Shake: fly from wherever the die is to the hand, then rattle there.
      if (shake > 0) {
        this.animator.add({
          delay,
          duration: shake + plan.offset / speed,
          start: () => {
            startPos.copy(d.position);
            startQ.copy(d.quaternion);
            d.scale.setScalar(scale);
            if (k === 0) this.fire(opts.onShake, opts, ['diceShake', 1, 0.8]);
          },
          update: (p) => {
            const T = p * (shake + plan.offset / speed);
            const gather = Math.min(1, T / (shake * 0.35));
            const g = ease.inOutCubic(gather);
            const { v, q, q2 } = this.tmp;
            const hand = plan.hand;
            // Rattle: small orbits and jitter, fading out at the release so the throw starts clean.
            const r = gather >= 1 ? Math.sin(Math.PI * Math.min(1, T / Math.max(1e-3, shake))) : 0;
            const w = T * 38 + k * 2.1;
            v.set(Math.sin(w) * 0.07 * r, Math.abs(Math.sin(w * 1.3)) * 0.05 * r, Math.cos(w * 0.9) * 0.07 * r);
            d.position.lerpVectors(startPos, hand, g).add(v);
            d.position.y += Math.sin(Math.PI * g) * 0.4 * (1 - gather);
            q2.setFromAxisAngle(v.set(Math.sin(w * 0.7), 0.5, Math.cos(w * 0.6)).normalize(), 0.5 * r * Math.sin(w * 1.7));
            q.copy(plan.q0).premultiply(q2);
            d.quaternion.slerpQuaternions(startQ, q, g);
            this.markShadows();
          },
        });
      }
      // The throw: flight segments, then the edge tumble and the final rock.
      this.animator.add({
        delay: delay + t0,
        duration: (plan.total + WOBBLE) / speed,
        start: () => {
          d.scale.setScalar(scale);
          hit = 0;
          if (k === 0) this.fire(opts.onThrow, opts, ['diceThrow', 1, 0.9]);
        },
        update: (p) => {
          const T = p * (plan.total + WOBBLE);
          plan.pose(T, d.position, d.quaternion, this.tmp);
          while (hit < plan.hits.length && plan.hits[hit].t <= T + 1e-6) {
            const h = plan.hits[hit++];
            if (!this.animator.finishing) {
              this.fire(opts.onBounce, opts, ['diceBounce', 0.9 + 0.25 * (1 - h.intensity), 0.25 + 0.75 * h.intensity], h.intensity, k, h.kind);
            }
          }
          this.markShadows();
        },
        end: () => {
          d.position.copy(plan.rest);
          d.quaternion.copy(plan.final);
          if (d === this.dice[plan.lastDie]) {
            const skipped = this.animator.finishing;
            if (!skipped) this.cue(opts, ['diceSettle', 1, 0.8]);
            try {
              opts.onSettle?.({ values: values.slice(), skipped });
            } catch (err) {
              console.error('[renderer3d] dice callback failed:', err);
            }
          }
        },
      });
    });
    const total = restAt + WOBBLE / speed;
    const contacts = bounces.filter((b) => b.die === 0 && b.kind === 'floor').map((b) => b.at);
    this.lastThrow = { duration: total, restAt, throwAt: shake, contacts, bounces: bounces.sort((a, b) => a.at - b.at) };
    return { ...this.lastThrow, valueOf() { return this.duration; } };
  }

  /**
   * Doubles: the dice give a little hop and sparkle (uses the scene's Fx), `delay` seconds from now.
   * @returns {number} seconds
   */
  celebrate(delay = 0) {
    const fx = this.scene.userData?.fx;
    const c = new THREE.Vector3();
    this.animator.add({
      delay,
      duration: 0.42,
      start: () => {
        if (!this.animator.finishing) fx?.sparkles?.(this.labelPos(c).setY(0.25), { count: 28, radius: 0.7 });
      },
      update: (p) => {
        this.dice.forEach((d, k) => {
          d.position.y = REST_Y * d.scale.x + 0.18 * Math.sin(Math.PI * Math.min(1, p * 1.08 + k * 0.04)) * (p < 0.95 ? 1 : 0);
        });
        this.markShadows();
      },
      end: () => this.dice.forEach((d) => { d.position.y = REST_Y * d.scale.x; }),
    });
    return 0.42;
  }

  /** World position above the dice (for the total / "Doubles!" label). */
  labelPos(out = new THREE.Vector3()) {
    out.addVectors(this.dice[0].position, this.dice[1].position).multiplyScalar(0.5);
    out.y = 0.75;
    return out;
  }

  fire(fn, opts, snd, ...args) {
    if (this.animator.finishing) return;
    this.cue(opts, snd);
    try {
      fn?.(...args);
    } catch (err) {
      console.error('[renderer3d] dice callback failed:', err);
    }
  }

  cue(opts, snd) {
    if (!snd || opts.silent || this.animator.finishing) return;
    try {
      (opts.sfx ?? this.sfx)?.play?.(snd[0], { rate: snd[1], volume: snd[2] });
    } catch { /* sound must never break the board */ }
  }
}

// ---- the throw ----------------------------------------------------------------------------------

/**
 * Plans both dice (seeded; pure maths, exported for tests). Retries a die whose rest spot is too
 * close to the other's.
 * Each plan: { hand, q0, rest, final, total, offset, hits[], pose(T, pos, quat, tmp), lastDie }.
 */
export function planThrow(values, dir, seed, scale = 1) {
  const plans = [];
  for (let k = 0; k < 2; k++) {
    let plan = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      plan = planDie(values[k], dir, (seed * 2 + k * 7919 + attempt * 104729) >>> 0, k, scale, attempt);
      if (k === 0 || plan.rest.distanceTo(plans[0].rest) > SIZE * scale * 1.35) break;
      plan = null;
    }
    // Fallback (never seen in practice): the old fixed rest spots.
    plans.push(plan ?? planDie(values[k], dir, seed + 17, k, scale, 99, true));
  }
  const last = plans[0].offset + plans[0].total >= plans[1].offset + plans[1].total ? 0 : 1;
  plans.forEach((p) => { p.lastDie = last; });
  return plans;
}

function planDie(value, dir, seed, k, scale, attempt, fallback = false) {
  const rnd = seeded(seed);
  const size = SIZE * scale;
  const restY = size / 2;
  const rc = CORNER * scale;
  const side = new THREE.Vector3(-dir.z, 0, dir.x); // left / right of the throw line
  const lane = (k ? 1 : -1) * (0.26 + 0.08 * attempt) + (rnd() - 0.5) * 0.2;
  const offset = k * 0.035; // the second die leaves the hand a hair later
  const hand = new THREE.Vector3(TRAY.x, HAND_Y, TRAY.z).addScaledVector(dir, HAND_R).addScaledVector(side, lane * 0.6);
  const hit1 = new THREE.Vector3(TRAY.x, restY, TRAY.z).addScaledVector(dir, FIRST_HIT + (rnd() - 0.5) * 0.3).addScaledVector(side, lane);
  if (fallback) hit1.addScaledVector(side, k ? 0.45 : -0.45);
  clampTray(hit1, 0.15 * scale);

  // Ballistic segments: hand → first touchdown, then bounces until they are too small. A landing
  // outside the tray is mirrored back in (the bounce simply heads the other way).
  const segs = []; // { t0, dur, p0, v, y0, vy, axis, spin }
  const hits = [];
  let t = 0;
  let p0 = hand.clone();
  let y0 = HAND_Y;
  const flight = FLIGHT * (0.88 + 0.24 * rnd());
  const bounciness = RESTITUTION * (0.85 + 0.3 * rnd());
  const vh = new THREE.Vector3().subVectors(hit1, hand).setY(0).divideScalar(flight);
  let vy = (restY - HAND_Y + 0.5 * GRAVITY * flight * flight) / flight;
  let omega = 20 + rnd() * 8; // rad/s
  let dur = flight;
  for (let n = 0; n < 5; n++) {
    const land = p0.clone().addScaledVector(vh, dur).setY(0);
    if (reflect(land, vh)) vh.subVectors(land, p0).setY(0).divideScalar(dur);
    const mdir = vh.lengthSq() > 1e-6 ? vh.clone().normalize() : dir.clone().negate();
    // Spin about the rolling axis (tilted at random): positive angles roll the top forward.
    const axis = new THREE.Vector3().crossVectors(UP, mdir).applyAxisAngle(mdir, (rnd() - 0.5) * 1.4).normalize();
    segs.push({ t0: t, dur, p0: p0.clone(), v: vh.clone(), y0, vy, axis, spin: omega * dur });
    t += dur;
    const vImpact = Math.abs(vy - GRAVITY * dur);
    hits.push({ t, intensity: Math.min(1, vImpact / 8), kind: 'floor' });
    p0 = land;
    y0 = restY;
    vy = vImpact * bounciness;
    vh.multiplyScalar(FRICTION);
    omega *= SPIN_KEEP;
    if (vy < MIN_BOUNCE_VY) break;
    dur = (2 * vy) / GRAVITY;
  }
  // Tumble over the die's edges to rest (1 or 2 quarter turns along the remaining motion).
  let rollDir = vh.lengthSq() > 1e-6 ? vh.clone().normalize() : dir.clone().negate();
  const quarters = vh.length() * (0.6 + 0.8 * rnd()) > 1.6 ? 2 : 1;
  const hp = size / 2 - rc; // centre-to-edge-axis distance
  const rollLen = quarters * 2 * hp;
  const probe = p0.clone().addScaledVector(rollDir, rollLen);
  if (Math.abs(probe.x - TRAY.x) > TRAY.hx - 0.2 || Math.abs(probe.z - TRAY.z) > TRAY.hz - 0.2) rollDir.negate();
  const rollT = 0.14 + 0.1 * quarters;
  const rollStart = t;
  const rest = p0.clone().addScaledVector(rollDir, rollLen).setY(restY);
  // The resting face-up orientation, yaw aligned with the roll so the edge tumble lands flat.
  const yaw = Math.atan2(-rollDir.z, rollDir.x) + (Math.floor(rnd() * 4) * Math.PI) / 2;
  const final = faceUpQuaternion(value, yaw);
  const rollAxis = new THREE.Vector3().crossVectors(UP, rollDir).normalize();
  const rollAngle = quarters * (Math.PI / 2);
  // Solve the orientations backwards: each segment ends where the next one starts.
  let qEnd = new THREE.Quaternion().setFromAxisAngle(rollAxis, -rollAngle).multiply(final); // before the tumble
  for (let n = segs.length - 1; n >= 0; n--) {
    segs[n].qEnd = qEnd.clone();
    qEnd = new THREE.Quaternion().setFromAxisAngle(segs[n].axis, -segs[n].spin).multiply(qEnd);
  }
  const q0 = qEnd; // orientation leaving the hand
  for (let n = 0; n < quarters; n++) hits.push({ t: rollStart + (rollT * (n + 1)) / quarters * 0.92, intensity: 0.18, kind: 'edge' });
  const total = rollStart + rollT;
  const tmpQ = new THREE.Quaternion();

  /** Pose at T seconds after release (allocation-free). */
  function pose(T, pos, quat) {
    if (T >= total) {
      // Rock back and forth on the resting face, damped.
      const w = Math.min(1, (T - total) / WOBBLE);
      const a = 0.07 * Math.sin(w * Math.PI * 2.5) * (1 - w);
      quat.setFromAxisAngle(rollAxis, a).multiply(final);
      pos.copy(rest);
      pos.y = rc + hp * (Math.cos(Math.abs(a)) + Math.sin(Math.abs(a)));
      return;
    }
    if (T >= rollStart) {
      const u = ease.outQuad((T - rollStart) / rollT);
      const th = u * rollAngle; // turned so far
      const q = Math.min(quarters - 1, Math.floor(th / (Math.PI / 2)));
      const phi = th - q * (Math.PI / 2);
      quat.setFromAxisAngle(rollAxis, th - rollAngle).multiply(final);
      pos.copy(p0).addScaledVector(rollDir, hp + q * 2 * hp + hp * (Math.sin(phi) - Math.cos(phi)));
      pos.y = rc + hp * (Math.sin(phi) + Math.cos(phi));
      return;
    }
    let s = segs[0];
    for (let n = segs.length - 1; n >= 0; n--) if (T >= segs[n].t0) { s = segs[n]; break; }
    const tt = T - s.t0;
    const u = Math.min(1, tt / s.dur);
    pos.copy(s.p0).addScaledVector(s.v, tt);
    const yBall = s.y0 + s.vy * tt - 0.5 * GRAVITY * tt * tt;
    quat.copy(tmpQ.setFromAxisAngle(s.axis, -s.spin * (1 - u))).multiply(s.qEnd);
    // Keep the lowest corner on the floor at touchdowns (a tilted die stands taller than restY).
    pos.y = Math.max(yBall, restY) - restY + extent(quat, hp, rc);
  }

  // The hand holds the die exactly where the flight starts (no jump at the release).
  pose(0, hand, new THREE.Quaternion());
  return { hand, q0, rest, final, total, offset, hits, pose };
}

/** Height of a rounded cube's centre above its lowest point for orientation q. */
function extent(q, hp, rc) {
  const { x, y, z, w } = q;
  const ax = Math.abs(2 * (x * y + w * z)); // world-y component of the die's local X axis
  const ay = Math.abs(1 - 2 * (x * x + z * z));
  const az = Math.abs(2 * (y * z - w * x));
  return hp * (ax + ay + az) + rc;
}

function clampTray(p, margin) {
  p.x = Math.min(TRAY.x + TRAY.hx - margin, Math.max(TRAY.x - TRAY.hx + margin, p.x));
  p.z = Math.min(TRAY.z + TRAY.hz - margin, Math.max(TRAY.z - TRAY.hz + margin, p.z));
}

/** Mirrors a landing point back into the tray (and flips that velocity component). Returns true on a wall hit. */
function reflect(p, v) {
  let hitWall = false;
  const lim = (c, h, key) => {
    const lo = c - h;
    const hi = c + h;
    if (p[key] > hi) { p[key] = Math.max(lo, 2 * hi - p[key]); v[key] = -Math.abs(v[key]); hitWall = true; }
    if (p[key] < lo) { p[key] = Math.min(hi, 2 * lo - p[key]); v[key] = Math.abs(v[key]); hitWall = true; }
  };
  lim(TRAY.x, TRAY.hx - 0.25, 'x');
  lim(TRAY.z, TRAY.hz - 0.25, 'z');
  return hitWall;
}

// ---- textures -------------------------------------------------------------------------------------

/**
 * All six faces in one set of textures (face f = PIP_ORDER index in column f % 3, row ⌊f / 3⌋,
 * row 0 at the bottom): ivory colour with dark paint in the pips, a tangent-space normal map of
 * concave dimples, and a roughness map (satin ivory, matt paint).
 */
function pipMaps(aniso) {
  const F = 192; // pixels per face
  const W = F * 3;
  const H = F * 2;
  const color = document.createElement('canvas');
  color.width = W;
  color.height = H;
  const g = color.getContext('2d');
  // Ivory with a faint warm vignette per face (reads as depth on the rounded edges).
  for (let f = 0; f < 6; f++) {
    const ox = (f % 3) * F;
    const oy = Math.floor(f / 3) === 0 ? F : 0; // canvas y runs down; texture v runs up
    const grad = g.createRadialGradient(ox + F / 2, oy + F / 2, F * 0.2, ox + F / 2, oy + F / 2, F * 0.75);
    grad.addColorStop(0, '#f8f3e6');
    grad.addColorStop(1, '#e9dfc8');
    g.fillStyle = grad;
    g.fillRect(ox, oy, F, F);
  }
  const pips = []; // [cx, cy, r (px), one]
  PIP_ORDER.forEach((v, f) => {
    const ox = (f % 3) * F;
    const oy = Math.floor(f / 3) === 0 ? F : 0;
    const r = (v === 1 ? 0.12 : 0.085) * F;
    for (const [x, y] of PIPS[v]) pips.push([ox + x * F, oy + y * F, r, v === 1]);
  });
  for (const [cx, cy, r, one] of pips) {
    const grad = g.createRadialGradient(cx, cy - r * 0.25, 0, cx, cy, r);
    grad.addColorStop(0, one ? '#8e0f22' : '#0c0c0c');
    grad.addColorStop(0.8, one ? '#b3122a' : '#262626');
    grad.addColorStop(1, one ? '#c9707a' : '#8a8274');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
  }
  // Normal map (analytic bowls) and roughness, per pixel.
  const nCv = document.createElement('canvas');
  nCv.width = W;
  nCv.height = H;
  const rCv = document.createElement('canvas');
  rCv.width = W;
  rCv.height = H;
  const nImg = nCv.getContext('2d').createImageData(W, H);
  const rImg = rCv.getContext('2d').createImageData(W, H);
  const nd = nImg.data;
  const rd = rImg.data;
  for (let i = 0; i < W * H; i++) {
    nd[i * 4] = 128; nd[i * 4 + 1] = 128; nd[i * 4 + 2] = 255; nd[i * 4 + 3] = 255;
    rd[i * 4] = 255; rd[i * 4 + 1] = 92; rd[i * 4 + 2] = 0; rd[i * 4 + 3] = 255; // G = roughness ≈ 0.36
  }
  const DEPTH = 0.9; // slope scale of the dimple walls
  for (const [cx, cy, r] of pips) {
    const x0 = Math.max(0, Math.floor(cx - r - 1));
    const x1 = Math.min(W - 1, Math.ceil(cx + r + 1));
    const y0 = Math.max(0, Math.floor(cy - r - 1));
    const y1 = Math.min(H - 1, Math.ceil(cy + r + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x + 0.5 - cx) / r;
        const dy = (y + 0.5 - cy) / r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= 1) continue;
        // Bowl h = -sqrt(1 - d²): slope grows toward the rim. Normal tilts toward the centre.
        const k = DEPTH / Math.sqrt(Math.max(0.08, 1 - d2));
        const sx = dx * k; // dh/dx (canvas x = u)
        const sy = dy * k; // dh/dy (canvas y = -v)
        let nx = -sx;
        let ny = sy;
        const len = Math.hypot(nx, ny, 1);
        nx /= len;
        ny /= len;
        const i = (y * W + x) * 4;
        nd[i] = Math.round((nx * 0.5 + 0.5) * 255);
        nd[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        nd[i + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
        rd[i + 1] = 170; // painted hollows are matt
      }
    }
  }
  nCv.getContext('2d').putImageData(nImg, 0, 0);
  rCv.getContext('2d').putImageData(rImg, 0, 0);
  const tex = (cv, srgb) => {
    const t = new THREE.CanvasTexture(cv);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = aniso;
    return t;
  };
  return { color: tex(color, true), normal: tex(nCv, false), rough: tex(rCv, false) };
}
