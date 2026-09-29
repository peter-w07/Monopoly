// public/r3d/tokens.js — player tokens on the board: creation, slots on shared tiles, and the
// movement animations (hop per tile for dice walks, high arcs for card / jail teleports).
//
// A token = Group (position on the board, yaw) → body (squash / tilt) → metal model + colour disc.
// Positions always converge on the state: layout() puts every visible token in its slot.

import * as THREE from './three.js';
import { buildTokenModel } from './token-models.js';
import { makeSpot, spotKey, slotWorld, wrap, travelDir, angleDelta } from './layout.js';
import { ease, clamp } from './tween.js';

const WALK_BUDGET = 2.2; // seconds for a whole dice walk (hops get shorter on long rolls)
const HOP_MIN = 0.16;
const HOP_MAX = 0.22;
const HOP_HEIGHT = 0.36;
const CORNER_PAUSE = 0.035; // a beat on each corner square
const ZIP_TILE = 0.045; // long card advances ("Advance to GO") zip along the track…
const ZIP_BUDGET = 1.4; // …in at most this long
const ZIP_HEIGHT = 0.07;
const ARC_TIME = 0.9; // card / jail teleports
const SETTLE_TIME = 0.28;
const MODEL_SCALE = 1.5; // token-models.js builds ~0.36-unit models; tokens stand ~0.55 tall on the board
const DISC_R = 0.22;
const BOB = 0.03; // idle bob of the current player's token (units, ~0.5 Hz)

export class TokenLayer {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./tween.js').Animator} animator
   * @param {() => void} markShadows
   * @param {number} jailIndex
   */
  constructor(scene, animator, markShadows, jailIndex = 10) {
    this.scene = scene;
    this.animator = animator;
    this.markShadows = markShadows;
    this.jailIndex = jailIndex;
    this.group = new THREE.Group();
    this.group.name = 'tokens';
    scene.add(this.group);
    this.metal = new THREE.MeshStandardMaterial({ color: '#d4d8dd', metalness: 1, roughness: 0.28 });
    this.discGeo = new THREE.CylinderGeometry(DISC_R, DISC_R * 1.06, 0.035, 36);
    this.ringGeo = new THREE.TorusGeometry(DISC_R + 0.045, 0.014, 8, 40).rotateX(Math.PI / 2);
    this.map = new Map(); // playerId → token record
    this.currentId = null;
  }

  get(id) {
    return this.map.get(id) ?? null;
  }

  /** Creates or updates the token for a player. */
  ensure(p, order, color) {
    let t = this.map.get(p.id);
    if (t && t.tokenId !== p.token) {
      this.remove(p.id);
      t = null;
    }
    if (!t) {
      t = this.create(p.id, p.token, color);
      this.map.set(p.id, t);
    }
    t.order = order;
    if (t.color !== color) {
      t.color = color;
      t.discMat.color.set(color);
      t.discMat.emissive.set(color);
      t.ringMat.color.set(color);
      t.ringMat.emissive.set(color);
    }
    return t;
  }

  create(id, tokenId, color) {
    const root = new THREE.Group();
    root.name = `player-${id}`;
    const body = new THREE.Group();
    root.add(body);
    const discMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.12, roughness: 0.4, metalness: 0.1 });
    const disc = new THREE.Mesh(this.discGeo, discMat);
    disc.position.y = 0.0175;
    disc.castShadow = true;
    disc.receiveShadow = true;
    body.add(disc);
    const model = buildTokenModel(tokenId, this.metal);
    model.position.y = 0.035;
    model.scale.setScalar(MODEL_SCALE);
    body.add(model);
    const ringMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1, roughness: 0.3, transparent: true, opacity: 0.9 });
    const ring = new THREE.Mesh(this.ringGeo, ringMat);
    ring.position.y = 0.012;
    ring.visible = false;
    root.add(ring);
    root.visible = false;
    this.group.add(root);
    return {
      id, tokenId, color, root, body, disc, discMat, ring, ringMat, model,
      order: 0,
      spot: makeSpot(0, false, this.jailIndex),
      visible: false,
      yaw: 0,
    };
  }

  remove(id) {
    const t = this.map.get(id);
    if (!t) return;
    this.group.remove(t.root);
    t.root.traverse((o) => {
      if (o.geometry && o.geometry !== this.discGeo && o.geometry !== this.ringGeo) o.geometry.dispose();
    });
    t.discMat.dispose();
    t.ringMat.dispose();
    this.map.delete(id);
  }

  clear() {
    for (const id of [...this.map.keys()]) this.remove(id);
    this.currentId = null;
  }

  /** World position of a player's token (for labels / camera), or null if it isn't on the board. */
  worldPos(id, out = new THREE.Vector3()) {
    const t = this.map.get(id);
    if (!t || !t.visible) return null;
    return out.copy(t.root.position);
  }

  /**
   * Reconciles tokens with the players list: creates / removes, shows / hides, sets the target spot.
   * With `place` true every token is put in its slot (animated if `animate`).
   */
  sync(ctx, { animate = false, place = true, popNew = false, keep = null } = {}) {
    const seen = new Set();
    const fresh = new Set();
    ctx.players.forEach((p, i) => {
      seen.add(p.id);
      const t = this.ensure(p, i, ctx.colorOf.get(p.id));
      const onBoard = ctx.live && !p.bankrupt;
      if (!onBoard && keep?.has(p.id) && t.visible) return; // leaves the board later (sink animation)
      if (!onBoard) {
        t.visible = false;
        t.root.visible = false;
        return;
      }
      const truth = makeSpot(p.position, p.inJail, this.jailIndex);
      if (!t.visible) {
        t.visible = true;
        t.root.visible = true;
        t.spot = truth;
        fresh.add(t);
        if (popNew && animate) this.pop(t, 0.08 * i);
        return;
      }
      if (place) t.spot = truth; // otherwise the batch's moves update it hop by hop, then settle
    });
    for (const id of [...this.map.keys()]) if (!seen.has(id)) this.remove(id);
    if (place) this.layout(animate, null, fresh);
    else if (fresh.size) this.layout(false, fresh); // newcomers appear in their slot; walkers stay put
  }

  /**
   * Puts visible tokens in their slots; tokens sharing a spot spread out.
   * @param {boolean} animate glide there (else snap)
   * @param {Set|null} only   move only these tokens (the others still count for the slot layout)
   * @param {Set|null} snapSet tokens that always snap (just appeared)
   */
  layout(animate, only = null, snapSet = null) {
    const groups = new Map();
    let changed = false;
    for (const t of this.map.values()) {
      if (!t.visible) continue;
      const key = spotKey(t.spot);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => a.order - b.order);
      const n = list.length;
      const s = n > 4 ? 0.8 : 1;
      list.forEach((t, k) => {
        if (only && !only.has(t)) return;
        const w = slotWorld(t.spot, k, n, this.jailIndex);
        t.slotScale = s;
        if (!animate || snapSet?.has(t)) {
          const p = t.root.position;
          if (Math.abs(p.x - w.x) > 1e-6 || Math.abs(p.z - w.z) > 1e-6 || p.y || Math.abs(t.root.scale.x - s) > 1e-6 || t.body.position.y) changed = true;
          t.root.position.set(w.x, 0, w.z);
          t.root.scale.setScalar(s);
          t.body.position.y = 0;
          t.body.scale.set(1, 1, 1);
          t.body.rotation.set(0, 0, 0);
          this.faceRow(t, t.spot.index);
          if (snapSet?.has(t) && t.popping) t.root.scale.setScalar(0.001);
          return;
        }
        const from = t.root.position.clone();
        const fromS = t.popping ? s : t.root.scale.x;
        if (from.distanceToSquared(new THREE.Vector3(w.x, 0, w.z)) < 1e-6 && Math.abs(fromS - s) < 1e-3) return;
        changed = true;
        this.animator.add({
          duration: SETTLE_TIME,
          easing: ease.outCubic,
          update: (p) => {
            t.root.position.set(from.x + (w.x - from.x) * p, 0, from.z + (w.z - from.z) * p);
            if (!t.popping) t.root.scale.setScalar(fromS + (s - fromS) * p);
            this.markShadows();
          },
        });
      });
    }
    if (changed) this.markShadows();
  }

  /** Turns a token to face along its row (the direction it will travel next). */
  faceRow(t, index) {
    const d = travelDir(index);
    t.yaw = Math.atan2(-d.z, d.x);
    t.root.rotation.y = t.yaw;
  }

  /** Scales a token in with a bounce. */
  pop(t, delay = 0) {
    t.popping = true;
    t.root.scale.setScalar(0.001);
    this.animator.add({
      delay,
      duration: 0.45,
      easing: ease.outBack,
      update: (p) => { t.root.scale.setScalar(Math.max(0.001, p * (t.slotScale ?? 1))); this.markShadows(); },
      end: () => { t.popping = false; },
    });
  }

  /** Bankrupt: the token sinks into the board and disappears. */
  sink(id, delay = 0) {
    const t = this.map.get(id);
    if (!t || !t.visible) return 0;
    this.animator.add({
      delay,
      duration: 0.7,
      easing: ease.inQuad,
      update: (p) => {
        t.root.position.y = -0.45 * p;
        t.body.rotation.z = 0.5 * p;
        this.markShadows();
      },
      end: () => {
        t.root.position.y = 0;
        t.body.rotation.z = 0;
      },
    });
    return 0.7;
  }

  /**
   * Schedules one `moved` event (CONTRACT §6) starting `delay` seconds from now.
   *   hop  dice walks and short card moves (≤ 6 steps): tile by tile, with weight
   *   zip  long forward card moves ("Advance to GO"): quick low skips along the track
   *   arc  jail and other teleports: one high arc to the target
   * @returns {{duration:number, goAt:number|null, hops:number, kind:'hop'|'zip'|'arc'|null}}
   *          seconds used, and when GO is crossed
   */
  scheduleMove(e, delay) {
    const t = this.map.get(e.playerId);
    if (!t || !t.visible) return { duration: 0, goAt: null, hops: 0, kind: null };
    if (t.bobbing) this.stopBob(t);
    const from = wrap(e.from);
    const to = wrap(e.to);
    const steps = Number.isInteger(e.steps) ? e.steps : null;
    const walk = steps !== null && steps !== 0 && Math.abs(steps) < 40;
    if (walk && (e.via === 'roll' || (e.via === 'card' && Math.abs(steps) <= 6))) return { ...this.scheduleHops(t, from, steps, delay), kind: 'hop' };
    if (walk && e.via === 'card' && steps > 6) return { ...this.scheduleHops(t, from, steps, delay, { zip: true }), kind: 'zip' };
    const jailed = e.via === 'jail';
    return { ...this.scheduleArc(t, makeSpot(to, jailed, this.jailIndex), delay, jailed ? 1.9 : 1.5), kind: 'arc' };
  }

  scheduleHops(t, from, steps, delay, { zip = false } = {}) {
    const n = Math.abs(steps);
    const dir = Math.sign(steps);
    const hop = zip ? Math.min(ZIP_TILE, ZIP_BUDGET / n) : clamp(WALK_BUDGET / n, HOP_MIN, HOP_MAX);
    const height = zip ? ZIP_HEIGHT : HOP_HEIGHT;
    const lean = zip ? 0 : 0.18;
    let goAt = null;
    let at = delay;
    const start = new THREE.Vector3();
    for (let s = 1; s <= n; s++) {
      const idx = wrap(from + dir * s);
      if (idx === 0 && dir > 0 && goAt === null) goAt = at + hop;
      const w = slotWorld(makeSpot(idx, false, this.jailIndex), 0, 1, this.jailIndex);
      const target = new THREE.Vector3(w.x, 0, w.z);
      const last = s === n;
      this.animator.add({
        delay: at,
        duration: hop,
        start: () => {
          start.copy(t.root.position);
          start.y = 0;
          t.spot = makeSpot(idx, false, this.jailIndex);
          const dx = target.x - start.x;
          const dz = target.z - start.z;
          if (dx * dx + dz * dz > 1e-6) t.targetYaw = Math.atan2(-dz, dx);
          t.fromYaw = t.root.rotation.y;
        },
        update: (p) => {
          const e = ease.inOutSine(p);
          t.root.position.set(start.x + (target.x - start.x) * e, 0, start.z + (target.z - start.z) * e);
          t.root.scale.setScalar(1);
          t.body.position.y = Math.sin(Math.PI * p) * height;
          t.body.rotation.z = -lean * Math.sin(Math.PI * p); // lean into the hop
          if (t.targetYaw !== undefined) {
            const k = Math.min(1, p / 0.35);
            t.root.rotation.y = t.fromYaw + angleDelta(t.fromYaw, t.targetYaw) * k;
          }
          // Squash on touchdown.
          const land = p > 0.8 ? (p - 0.8) / 0.2 : 0;
          const sq = land && !zip ? Math.sin(Math.PI * land) * (last ? 0.16 : 0.08) : 0;
          t.body.scale.set(1 + sq * 0.5, 1 - sq, 1 + sq * 0.5);
          this.markShadows();
        },
        end: () => {
          t.body.position.y = 0;
          t.body.rotation.z = 0;
          t.body.scale.set(1, 1, 1);
        },
      });
      at += hop + (!zip && !last && idx % 10 === 0 ? CORNER_PAUSE : 0);
    }
    return { duration: at - delay, goAt, hops: n };
  }

  scheduleArc(t, spot, delay, height) {
    const w = slotWorld(spot, 0, 1, this.jailIndex);
    const target = new THREE.Vector3(w.x, 0, w.z);
    const start = new THREE.Vector3();
    this.animator.add({
      delay,
      duration: ARC_TIME,
      start: () => {
        start.copy(t.root.position);
        start.y = 0;
        t.spot = spot;
        t.fromYaw = t.root.rotation.y;
        const dx = target.x - start.x;
        const dz = target.z - start.z;
        t.targetYaw = dx * dx + dz * dz > 1e-6 ? Math.atan2(-dz, dx) : t.fromYaw;
      },
      update: (p) => {
        const e = ease.inOutCubic(p);
        t.root.position.set(start.x + (target.x - start.x) * e, 0, start.z + (target.z - start.z) * e);
        t.body.position.y = Math.sin(Math.PI * p) * height;
        t.body.rotation.x = Math.sin(Math.PI * p) * 0.6; // a little tumble in the air
        t.root.rotation.y = t.fromYaw + angleDelta(t.fromYaw, t.targetYaw) * Math.min(1, p * 2);
        this.markShadows();
      },
      end: () => {
        t.body.position.y = 0;
        t.body.rotation.x = 0;
      },
    });
    return { duration: ARC_TIME, goAt: null, hops: 0 };
  }

  /** Marks the current player: their ring shows and their disc glows. */
  setCurrent(id) {
    this.currentId = id;
    for (const t of this.map.values()) {
      const cur = t.id === id;
      t.ring.visible = cur && t.visible;
      t.discMat.emissiveIntensity = cur ? 0.45 : 0.12;
    }
  }

  /**
   * Idle life of the current player's token: its ring breathes and the model bobs gently (its
   * shadow is left alone: 3 cm doesn't show). Returns true while there is one to animate.
   */
  ambient(now) {
    for (const t of this.map.values()) if (t.id !== this.currentId && t.bobbing) this.stopBob(t);
    const t = this.map.get(this.currentId);
    if (!t || !t.visible) return false;
    const k = 0.5 + 0.5 * Math.sin(now / 380);
    t.ringMat.emissiveIntensity = 0.5 + 1.2 * k;
    t.ring.scale.setScalar(1 + 0.08 * k);
    t.discMat.emissiveIntensity = 0.3 + 0.35 * k;
    t.model.position.y = 0.035 + BOB * (0.5 - 0.5 * Math.cos(now / 318)); // ~0.5 Hz
    t.bobbing = true;
    return true;
  }

  stopBob(t) {
    t.model.position.y = 0.035;
    t.bobbing = false;
  }
}
