// public/r3d/tokens.js — player tokens on the board: creation, slots on shared tiles, personality
// movement (the car drives, the dog bounds, the ship sails, the hat spins, the boot stomps, the cat
// pounces, the thimble flips, the wheelbarrow rolls), reactions (celebrate, sad, jail, bankrupt,
// victory…) and idle life.
//
// A token = root (board position, yaw) → body (hop height, squash, lean, roll — identity at rest)
//                                      → pose (pivot at the model's centre: flips, spins, idle sway)
//                                        → model (ONE mesh, token-models.js; wheels / tails move in its shader)
//         + ring (the current player's halo on the board).
// Positions always converge on the state: layout() puts every visible token in its slot, and every
// animation ends with body and pose back at rest. Callbacks (onStep, onLand…) never fire during a
// skip (Animator.finishAll) except the final onLand / onDone, which get { skipped: true }.

import * as THREE from './three.js';
import { buildTokenGeometry, createTokenMaterial, setTokenColor, trackEnvironment, MODEL_INFO } from './token-models.js';
import { makeSpot, spotKey, slotWorld, wrap, travelDir, angleDelta } from './layout.js';
import { ease, clamp } from './tween.js';

// ---- tuning knobs ---------------------------------------------------------------------------------
const WALK_BUDGET = 2.2; // seconds for a whole dice walk (hops get shorter on long rolls)
const HOP_MIN = 0.16;
const HOP_MAX = 0.22;
const HOP_HEIGHT = 0.36;
const CORNER_PAUSE = 0.035; // a beat on each corner square (hopping styles)
const ZIP_TILE = 0.045; // long card advances ("Advance to GO") zip along the track…
const ZIP_BUDGET = 1.4; // …in at most this long
const ZIP_HEIGHT = 0.07;
const ARC_TIME = 0.9; // card / jail teleports
const SETTLE_TIME = 0.28;
const MODEL_SCALE = 1.5; // token-models.js builds ~0.36-unit models; tokens stand ~0.5 tall on the board
const PIVOT_Y = 0.24; // the pose pivot (≈ the model's centre): flips and spins turn about it
const BASE_EDGE = 0.225; // plinth radius on the board (topple pivot)
const RING_R = 0.27;
const TOKEN_ENV_GAIN = 1.9; // reflections: × the scene's environment intensity (0.55 by day → ~1.05)
const GLOW_IDLE = 0.1; // enamel glow (emissive intensity) of a waiting token…
const GLOW_CURRENT = [0.35, 0.8]; // …and the current player's, pulsing between these

/**
 * How each token moves, idles and sounds. `sounds` are sfx.js names [name, rate, volume] the layer
 * plays itself only when given an sfx (setSfx / opts.sfx); otherwise they are passed to the
 * callbacks as `info.sound` suggestions.
 *   style   hop (classic) · drive · bound · sail · spin · stomp · pounce · flip · roll
 * Step sounds are short taps (they repeat every ~0.2 s); a longer signature sound (the hat's whirr,
 * the car's revving) plays once, at the start.
 */
export const PERSONALITIES = {
  car: { style: 'drive', sounds: { start: ['drive', 1, 0.7], step: null, land: ['horn', 1.2, 0.45] } },
  dog: { style: 'bound', sounds: { start: null, step: ['hop', 1.35, 0.3], land: ['bark', 1, 0.75] } },
  ship: { style: 'sail', sounds: { start: ['horn', 0.75, 0.55], step: null, land: ['land', 0.8, 0.5] } },
  hat: { style: 'spin', sounds: { start: ['hatSpin', 1, 0.5], step: ['hop', 1.06, 0.3], land: ['land', 1, 0.7] } },
  boot: { style: 'stomp', sounds: { start: null, step: ['stomp', 1, 0.5], land: ['stomp', 0.85, 0.95] } },
  cat: { style: 'pounce', sounds: { start: null, step: ['hop', 1.25, 0.35], land: ['purr', 1, 0.8] } },
  thimble: { style: 'flip', sounds: { start: null, step: ['clink', 1, 0.45], land: ['clink', 0.9, 0.85] } },
  wheelbarrow: { style: 'roll', sounds: { start: null, step: ['squeak', 1, 0.3], land: ['land', 1, 0.6] } },
  pawn: { style: 'hop', sounds: { start: null, step: ['hop', 1, 0.4], land: ['land', 1, 0.8] } },
};
export const STYLES = ['hop', 'drive', 'bound', 'sail', 'spin', 'stomp', 'pounce', 'flip', 'roll'];
const GLIDES = new Set(['drive', 'sail', 'roll']); // one continuous glide instead of hops
const ARC_SOUNDS = { start: ['whoosh', 1, 0.6], land: ['land', 1, 0.8] };

/** Reaction lengths (s, before `speed`). victory repeats until the state changes (see react()). */
export const REACTIONS = { celebrate: 0.95, sad: 1.2, jail: 1.4, goJump: 0.6, bankrupt: 1.15, victory: 0.62 };

/**
 * Seconds a `moved` event takes (CONTRACT §6) — the same numbers scheduleMove uses, for
 * estimates. opts: { duration, speed } as for scheduleMove.
 */
export function moveDuration(e, { duration, speed = 1 } = {}) {
  const steps = Number.isInteger(e?.steps) ? e.steps : null;
  const n = steps === null ? 0 : Math.abs(steps);
  const k = speed > 0 ? speed : 1;
  if (duration > 0) return duration / k;
  const walk = steps !== null && n > 0 && n < 40;
  if (walk && (e.via === 'roll' || (e.via === 'card' && n <= 6))) return (n * clamp(WALK_BUDGET / n, HOP_MIN, HOP_MAX)) / k;
  if (walk && e.via === 'card' && steps > 6) return (n * Math.min(ZIP_TILE, ZIP_BUDGET / n)) / k;
  return ARC_TIME / k;
}

let tmpV = null;

export class TokenLayer {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./tween.js').Animator} animator
   * @param {() => void} markShadows
   * @param {number} jailIndex
   * @param {{fx?: object, sfx?: object}} [opts] fx: an Fx (else scene.userData.fx) for dust / sparkles
   */
  constructor(scene, animator, markShadows, jailIndex = 10, { fx = null, sfx = null } = {}) {
    this.scene = scene;
    this.animator = animator;
    this.markShadows = markShadows;
    this.jailIndex = jailIndex;
    this.fx = fx;
    this.sfx = sfx;
    this.group = new THREE.Group();
    this.group.name = 'tokens';
    scene.add(this.group);
    this.ringGeo = new THREE.TorusGeometry(RING_R, 0.014, 8, 40).rotateX(Math.PI / 2);
    this.map = new Map(); // playerId → token record
    this.currentId = null;
    this.displayScale = 1;
    tmpV ??= new THREE.Vector3();
  }

  /** Plays the personalities' own sounds through `sfx` (sfx.js API) — off unless set. */
  setSfx(sfx) {
    this.sfx = sfx ?? null;
  }

  /** Effects used for boot dust etc. (defaults to the Fx registered on the scene). */
  setFx(fx) {
    this.fx = fx ?? null;
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
      setTokenColor(t.mat, color);
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
    const pose = new THREE.Group();
    pose.position.y = PIVOT_Y;
    body.add(pose);
    const known = Object.hasOwn(PERSONALITIES, tokenId) ? tokenId : 'pawn';
    const mat = createTokenMaterial(color, { envMap: this.scene.environment ?? null });
    const model = new THREE.Mesh(buildTokenGeometry(tokenId), mat);
    model.name = `token-${tokenId}`;
    model.castShadow = true;
    trackEnvironment(model, TOKEN_ENV_GAIN);
    model.position.y = -PIVOT_Y;
    model.scale.setScalar(MODEL_SCALE * this.displayScale);
    pose.add(model);
    const ringMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1, roughness: 0.3, transparent: true, opacity: 0.9 });
    const ring = new THREE.Mesh(this.ringGeo, ringMat);
    ring.position.y = 0.012;
    ring.visible = false;
    root.add(ring);
    root.visible = false;
    this.group.add(root);
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return {
      id, tokenId, color, root, body, pose, model, mat, ring, ringMat,
      persona: PERSONALITIES[known],
      info: MODEL_INFO[known] ?? MODEL_INFO.pawn,
      rig: mat.userData.rig.value, // (wheel, wag, tilt) angles
      order: 0,
      spot: makeSpot(0, false, this.jailIndex),
      visible: false,
      yaw: 0,
      acts: 0, // running moves / reactions (idle life pauses meanwhile)
      phase: (h % 1000) / 159.2, // idle phase offset
      reaction: null,
    };
  }

  remove(id) {
    const t = this.map.get(id);
    if (!t) return;
    this.group.remove(t.root);
    t.model.geometry.dispose();
    t.mat.map?.dispose();
    t.mat.dispose();
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

  /** World position just above a token's head (for effects / labels), or null. */
  headPos(id, out = new THREE.Vector3()) {
    const t = this.map.get(id);
    if (!t || !t.visible) return null;
    return out.copy(t.root.position).setY(t.root.position.y + t.body.position.y + (t.info.height + 0.06) * MODEL_SCALE * this.displayScale * t.root.scale.y);
  }

  /** Scales every token's figure (e.g. 1.3 in a wide overview so tokens read; 1 in close-ups). */
  setDisplayScale(k = 1) {
    this.displayScale = clamp(Number(k) || 1, 0.5, 2);
    for (const t of this.map.values()) t.model.scale.setScalar(MODEL_SCALE * this.displayScale);
    this.markShadows();
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
        t.reaction = null;
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
      if (t.reaction && spotKey(t.spot) !== spotKey(truth)) t.reaction = null; // the state moved on
      if (place) {
        t.spot = truth; // otherwise the batch's moves update it hop by hop, then settle
        t.root.visible = true; // (a bankrupt topple hides it; a token back on the board shows)
      }
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
          restBody(t);
          if (!t.acts) restPose(t);
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

  /**
   * Bankrupt: the token topples over and sinks into the board (react 'bankrupt').
   * @returns {number} seconds
   */
  sink(id, delay = 0, opts = {}) {
    return this.react(id, 'bankrupt', { ...opts, delay });
  }

  // ---- movement -------------------------------------------------------------------------------------

  /**
   * Schedules one `moved` event (CONTRACT §6) starting `delay` seconds from now.
   *   dice walks and short card moves (≤ 6 steps) → kind 'hop', in the token's personality style
   *   long forward card moves ("Advance to GO")  → kind 'zip' (low skips; drivers glide fast)
   *   jail and other teleports                   → kind 'arc' (one high arc; the hat / thimble spin)
   * @param {object} e  the moved event
   * @param {number} delay
   * @param {object} [opts]
   *   style      force a style (STYLES) instead of the token's personality ('hop' = the classic hop)
   *   duration   fit the whole move into this many seconds      speed  play it this much faster
   *   onStart(info)  onStep(i, info)  onLand(info)   i = 1..n, info = { playerId, tokenId, style, kind,
   *              index (tile), step, of, last, corner, sound: {name, rate, volume}|null, skipped }
   *   sfx        play the personality's sounds through this sfx (else this.sfx; none by default)
   *   silent     no sounds at all
   * @returns {{duration:number, goAt:number|null, hops:number, kind:'hop'|'zip'|'arc'|null,
   *   style:string|null, hopTimes:number[], tileTimes:number[], landAt:number, touchdowns:boolean}}
   *   times are seconds from now (like `delay`): goAt = GO crossed; tileTimes = arrival on each tile;
   *   hopTimes = touchdowns, the last one being the landing (one per tile for hopping styles, one
   *   per leap for the cat, just [landAt] for the gliding car / ship / wheelbarrow); landAt = the end.
   */
  scheduleMove(e, delay, opts = {}) {
    const t = this.map.get(e?.playerId);
    const none = { duration: 0, goAt: null, hops: 0, kind: null, style: null, hopTimes: [], tileTimes: [], landAt: delay, touchdowns: false };
    if (!t || !t.visible) return none;
    const speed = opts.speed > 0 ? opts.speed : 1;
    const from = wrap(e.from);
    const to = wrap(e.to);
    const steps = Number.isInteger(e.steps) ? e.steps : null;
    const n = steps === null ? 0 : Math.abs(steps);
    const walk = steps !== null && n > 0 && n < 40;
    const ctx = { t, e, opts, speed, delay };
    if (walk && (e.via === 'roll' || (e.via === 'card' && n <= 6))) {
      const style = STYLES.includes(opts.style) ? opts.style : t.persona.style;
      return { ...this.walk(ctx, from, steps, style, false), kind: 'hop' };
    }
    if (walk && e.via === 'card' && steps > 6) {
      const style = GLIDES.has(opts.style ?? t.persona.style) ? (opts.style ?? t.persona.style) : 'zip';
      return { ...this.walk(ctx, from, steps, style, true), kind: 'zip' };
    }
    const jailed = e.via === 'jail';
    return { ...this.scheduleArc(ctx, makeSpot(to, jailed, this.jailIndex), jailed ? 1.9 : 1.5), kind: 'arc' };
  }

  /** Per-tile timing of a walk: [{ idx, at (start, s from the walk start), dur }], total. */
  walkPlan(from, steps, style, zip, opts, speed) {
    const n = Math.abs(steps);
    const dir = Math.sign(steps);
    let hop = zip ? Math.min(ZIP_TILE, ZIP_BUDGET / n) : clamp(WALK_BUDGET / n, HOP_MIN, HOP_MAX);
    const pauses = !zip && !GLIDES.has(style) && style !== 'pounce';
    let corners = 0;
    if (pauses) for (let s = 1; s < n; s++) if (wrap(from + dir * s) % 10 === 0) corners++;
    if (opts.duration > 0) hop = Math.max(0.02, (opts.duration - corners * CORNER_PAUSE) / n);
    hop /= speed;
    const pause = CORNER_PAUSE / speed;
    const tiles = [];
    let at = 0;
    for (let s = 1; s <= n; s++) {
      const idx = wrap(from + dir * s);
      tiles.push({ idx, at, dur: hop });
      at += hop + (pauses && s < n && idx % 10 === 0 ? pause : 0);
    }
    return { tiles, total: at, hop, dir };
  }

  walk(ctx, from, steps, style, zip) {
    const { delay, speed, opts } = ctx;
    const plan = this.walkPlan(from, steps, style, zip, opts, speed);
    let tileTimes = plan.tiles.map((x) => delay + x.at + x.dur);
    const landAt = delay + plan.total;
    const startAt = ctx.t.acts > 0 && ctx.t.planSpot ? slotWorld(ctx.t.planSpot, 0, 1, this.jailIndex) : ctx.t.root.position;
    ctx.t.planSpot = makeSpot(plan.tiles.at(-1).idx, false, this.jailIndex);
    this.begin(ctx, style, zip ? 'zip' : 'hop');
    let hopTimes = tileTimes;
    if (GLIDES.has(style)) {
      // Glides accelerate and brake: estimate the real tile arrivals from the path.
      const path = buildPath(startAt, plan.tiles.map((x) => slotWorld(makeSpot(x.idx, false, this.jailIndex), 0, 1, this.jailIndex)));
      tileTimes = path.marks.map((m) => delay + invGlide(m / Math.max(1e-6, path.length)) * plan.total);
      this.scheduleGlide(ctx, plan, style, zip);
      hopTimes = [landAt]; // no touchdowns on the way, just the arrival
    } else if (style === 'pounce') {
      hopTimes = this.schedulePounces(ctx, plan).map((L) => delay + L.at + L.dur);
    } else this.scheduleHops(ctx, plan, style, zip);
    const goTile = plan.dir > 0 ? plan.tiles.findIndex((x) => x.idx === 0) : -1;
    const goAt = goTile >= 0 ? tileTimes[goTile] : null; // arriving on GO (touchdown / drive-over)
    return { duration: plan.total, goAt, hops: plan.tiles.length, style, hopTimes, tileTimes, landAt, touchdowns: !GLIDES.has(style) };
  }

  /** Marks a token busy from now until its last item ends (idle life pauses; counters balance). */
  begin(ctx, style, kind) {
    const { t } = ctx;
    t.acts++;
    ctx.style = style;
    ctx.kind = kind;
  }

  /** Common start of a move's first item: reset the pose, onStart + start sound. */
  started(ctx) {
    const { t } = ctx;
    restPose(t);
    t.reaction = null;
    const snd = ctx.kind === 'arc' ? ARC_SOUNDS.start : t.persona.sounds.start;
    const info = this.info(ctx, { sound: sound(snd) });
    this.cue(ctx, snd);
    if (!this.animator.finishing) safe(ctx.opts.onStart, info);
  }

  /** Common end of a move's last item: body + pose at rest, onLand + landing sound. */
  landed(ctx) {
    const { t } = ctx;
    restBody(t);
    restPose(t);
    t.acts = Math.max(0, t.acts - 1);
    const snd = ctx.kind === 'arc' ? ARC_SOUNDS.land : t.persona.sounds.land;
    this.cue(ctx, snd);
    safe(ctx.opts.onLand, this.info(ctx, { index: t.spot.index, last: true, sound: sound(snd), skipped: this.animator.finishing }));
    this.markShadows();
  }

  /**
   * Arrival on tile `i` of the walk (1-based). `midair`: a tile the token flies over (the cat's
   * leaps) — announced, but without a touchdown sound.
   */
  stepped(ctx, i, idx, n, extra = null, midair = false) {
    if (this.animator.finishing) return;
    const snd = i < n && !midair ? ctx.t.persona.sounds.step : null;
    const jitter = 0.94 + ((i * 37) % 10) * 0.012;
    if (snd && ctx.kind !== 'zip') this.cue(ctx, [snd[0], snd[1] * jitter, snd[2]]);
    safe(ctx.opts.onStep, i, this.info(ctx, { index: idx, step: i, of: n, last: i === n, corner: idx % 10 === 0, sound: i < n ? sound(snd, jitter) : null, ...extra }));
  }

  info(ctx, extra) {
    const { t } = ctx;
    return { playerId: t.id, tokenId: t.tokenId, style: ctx.style, kind: ctx.kind, index: t.spot.index, step: 0, of: 0, last: false, corner: false, sound: null, skipped: false, ...extra };
  }

  /** Plays a [name, rate, volume] sound through the injected sfx (never during a skip). */
  cue(ctx, snd) {
    if (!snd || ctx.opts.silent || this.animator.finishing) return;
    const sfx = ctx.opts.sfx ?? this.sfx;
    try {
      sfx?.play?.(snd[0], { rate: snd[1], volume: snd[2] });
    } catch { /* sound must never break the board */ }
  }

  /** Hopping styles: one item per tile (hop, bound, spin, stomp, flip, and the zip's low skips). */
  scheduleHops(ctx, plan, style, zip) {
    const { t, delay } = ctx;
    const n = plan.tiles.length;
    const start = new THREE.Vector3();
    const target = new THREE.Vector3();
    const H = zip ? ZIP_HEIGHT : { hop: HOP_HEIGHT, bound: 0.24, spin: 0.3, stomp: 0.26, flip: 0.4 }[style] ?? HOP_HEIGHT;
    plan.tiles.forEach(({ idx, at, dur }, k) => {
      const s = k + 1;
      const last = s === n;
      this.animator.add({
        delay: delay + at,
        duration: dur,
        start: () => {
          if (k === 0) this.started(ctx);
          start.copy(t.root.position).setY(0);
          const w = slotWorld(makeSpot(idx, false, this.jailIndex), 0, 1, this.jailIndex);
          target.set(w.x, 0, w.z);
          t.spot = makeSpot(idx, false, this.jailIndex);
          const dx = target.x - start.x;
          const dz = target.z - start.z;
          if (dx * dx + dz * dz > 1e-6) t.targetYaw = Math.atan2(-dz, dx);
          t.fromYaw = t.root.rotation.y;
        },
        update: (p) => {
          const b = t.body;
          const e = style === 'bound' ? p : ease.inOutSine(p);
          t.root.position.set(start.x + (target.x - start.x) * e, 0, start.z + (target.z - start.z) * e);
          if (t.targetYaw !== undefined) t.root.rotation.y = t.fromYaw + angleDelta(t.fromYaw, t.targetYaw) * Math.min(1, p / 0.35);
          const arc = Math.sin(Math.PI * p);
          const land = p > 0.8 ? Math.sin(Math.PI * ((p - 0.8) / 0.2)) : 0; // touchdown squash window
          let sq = 0;
          b.rotation.set(0, 0, 0);
          t.pose.rotation.set(0, 0, 0);
          if (zip) {
            b.position.y = arc * H;
          } else if (style === 'bound') {
            // Dog: quick low bounds, nose up on take-off and down on landing, stretched in the air, wagging.
            b.position.y = arc * H;
            b.rotation.z = 0.34 * Math.cos(Math.PI * p) * arc;
            b.scale.set(1 + 0.14 * arc, 1 - 0.05 * arc, 1);
            t.rig.y = 0.6 * Math.sin(this.animator.time * 26);
            sq = land * (last ? 0.12 : 0.06);
          } else if (style === 'spin') {
            // Top hat: a full turn on every hop, brim tipping.
            b.position.y = arc * H;
            t.pose.rotation.y = Math.PI * 2 * ease.inOutSine(p);
            t.pose.rotation.z = 0.14 * Math.sin(Math.PI * 2 * p);
            sq = land * (last ? 0.14 : 0.07);
          } else if (style === 'stomp') {
            // Boot: lifts slowly toe-first, then slams down flat (heavy squash + dust).
            const up = 0.62;
            b.position.y = p < up ? H * Math.sin((Math.PI / 2) * (p / up)) : H * (1 - ((p - up) / (1 - up)) ** 2);
            b.rotation.z = 0.3 * Math.sin(Math.PI * Math.min(1, p / up)) * (p < up ? 1 : 1 - (p - up) / (1 - up));
            sq = p > 0.9 ? Math.sin(Math.PI * ((p - 0.9) / 0.1)) * (last ? 0.3 : 0.22) : 0;
          } else if (style === 'flip') {
            // Thimble: a forward somersault over each tile.
            b.position.y = arc * H;
            t.pose.rotation.z = -Math.PI * 2 * ease.inOutSine(p);
            sq = land * (last ? 0.14 : 0.06);
          } else {
            // Classic hop: lean into it, squash on touchdown.
            b.position.y = arc * H;
            b.rotation.z = -0.18 * arc;
            sq = land * (last ? 0.16 : 0.08);
          }
          if (style !== 'bound' || sq) b.scale.set(1 + sq * 0.5, 1 - sq, 1 + sq * 0.5);
          this.markShadows();
        },
        end: () => {
          restBody(t);
          t.pose.rotation.set(0, 0, 0);
          if (style === 'stomp' && !this.animator.finishing) this.dust(target, last ? 1 : 0.55);
          this.stepped(ctx, s, idx, n);
          if (last) this.landed(ctx);
        },
      });
    });
  }

  /**
   * Glides (drive / sail / roll): one item along a path through the tile centres with rounded
   * corners, accelerating out and braking in; wheels spin by distance, the body rolls into turns.
   */
  scheduleGlide(ctx, plan, style, zip) {
    const { t, delay } = ctx;
    const n = plan.tiles.length;
    let path = null;
    let next = 1; // next tile to announce (1-based)
    let cursor = 0;
    let wheel0 = 0;
    this.animator.add({
      delay,
      duration: plan.total,
      start: () => {
        this.started(ctx);
        path = buildPath(t.root.position, plan.tiles.map((x) => slotWorld(makeSpot(x.idx, false, this.jailIndex), 0, 1, this.jailIndex)));
        t.fromYaw = t.root.rotation.y;
        wheel0 = t.rig.x;
        next = 1;
        cursor = 0;
      },
      update: (p) => {
        if (!path) return;
        const s = glideProfile(p) * path.length;
        cursor = path.at(s, cursor, tmpGlide);
        const g = tmpGlide;
        t.root.position.set(g.x, 0, g.z);
        const turnIn = Math.min(1, p / 0.12);
        t.root.rotation.y = turnIn < 1 ? t.fromYaw + angleDelta(t.fromYaw, g.yaw) * ease.outQuad(turnIn) : g.yaw;
        const v = (glideSpeed(p) * path.length) / Math.max(0.05, plan.total); // units / s
        const tiles = s / Math.max(0.3, path.length / n); // tiles travelled (for rhythmic motion)
        const b = t.body;
        const accel = p < 0.16 ? 1 : p > 0.76 ? -1 : 0;
        b.rotation.set(0, 0, 0);
        if (style === 'drive') {
          b.rotation.x = clamp(g.curv * v * v * 0.02, -0.16, 0.16); // body roll, outward in turns
          b.rotation.z = accel * 0.05 * Math.sin(Math.PI * (accel > 0 ? p / 0.16 : (1 - p) / 0.24)); // squat / dive
          b.position.y = 0.006 * Math.abs(Math.sin(tiles * Math.PI * 3));
        } else if (style === 'sail') {
          b.position.y = 0.04 * Math.sin(tiles * Math.PI * 2) * Math.sin(Math.PI * p) + 0.012;
          b.rotation.x = 0.11 * Math.sin(tiles * Math.PI * 2 + 1.2) + clamp(g.curv * v * 0.05, -0.1, 0.1);
          b.rotation.z = 0.07 * Math.cos(tiles * Math.PI * 2);
        } else {
          // Wheelbarrow: tipped forward onto its wheel while pushed, a bump per tile, a wobble.
          const tip = Math.min(1, p / 0.1, (1 - p) / 0.12);
          b.rotation.z = -0.13 * tip;
          b.position.y = 0.025 * Math.abs(Math.sin(tiles * Math.PI)) * tip + 0.03 * tip;
          b.rotation.x = 0.05 * Math.sin(tiles * Math.PI * 2);
        }
        const wr = (t.info.wheelR ?? 0.05) * MODEL_SCALE * this.displayScale;
        t.rig.x = wheel0 - s / wr;
        while (next <= n && s >= path.marks[next - 1] - 1e-6) {
          const idx = plan.tiles[next - 1].idx;
          t.spot = makeSpot(idx, false, this.jailIndex);
          this.stepped(ctx, next, idx, n);
          next++;
        }
        this.markShadows();
      },
      end: () => {
        const last = plan.tiles[n - 1];
        if (last) t.spot = makeSpot(last.idx, false, this.jailIndex);
        this.landed(ctx);
      },
    });
  }

  /** Cat: leaps of up to 3 tiles (never across a corner), each with a crouch and a butt wiggle. */
  schedulePounces(ctx, plan) {
    const { t, delay } = ctx;
    const n = plan.tiles.length;
    const leaps = [];
    let cur = null;
    plan.tiles.forEach((x, k) => {
      if (!cur) cur = { tiles: [], at: x.at, dur: 0, first: k };
      cur.tiles.push(x);
      cur.dur = x.at + x.dur - cur.at;
      if (cur.tiles.length === 3 || x.idx % 10 === 0 || k === n - 1) {
        leaps.push(cur);
        cur = null;
      }
    });
    const start = new THREE.Vector3();
    const target = new THREE.Vector3();
    leaps.forEach((L, j) => {
      const lastLeap = j === leaps.length - 1;
      const crouch = L.dur > 0.3 ? 0.3 : 0.2;
      let announced = 0;
      this.animator.add({
        delay: delay + L.at,
        duration: L.dur,
        start: () => {
          if (j === 0) this.started(ctx);
          start.copy(t.root.position).setY(0);
          const endIdx = L.tiles.at(-1).idx;
          const w = slotWorld(makeSpot(endIdx, false, this.jailIndex), 0, 1, this.jailIndex);
          target.set(w.x, 0, w.z);
          const dx = target.x - start.x;
          const dz = target.z - start.z;
          t.fromYaw = t.root.rotation.y;
          t.targetYaw = dx * dx + dz * dz > 1e-6 ? Math.atan2(-dz, dx) : t.fromYaw;
          announced = 0;
        },
        update: (p) => {
          const b = t.body;
          b.rotation.set(0, 0, 0);
          t.pose.rotation.set(0, 0, 0);
          t.root.rotation.y = t.fromYaw + angleDelta(t.fromYaw, t.targetYaw) * Math.min(1, p / crouch);
          if (p < crouch) {
            // Crouch: low, tail up, wiggling.
            const c = Math.sin((Math.PI / 2) * Math.min(1, p / (crouch * 0.6)));
            t.root.position.set(start.x, 0, start.z);
            b.position.y = 0;
            b.scale.set(1 + 0.07 * c, 1 - 0.2 * c, 1 + 0.04 * c);
            b.rotation.z = 0.08 * c;
            t.pose.rotation.y = 0.12 * c * Math.sin((p / crouch) * Math.PI * 6);
            t.rig.y = 0.25 * c;
          } else {
            const q = (p - crouch) / (1 - crouch);
            const e = ease.inOutSine(q);
            t.root.position.set(start.x + (target.x - start.x) * e, 0, start.z + (target.z - start.z) * e);
            const arc = Math.sin(Math.PI * q);
            b.position.y = arc * (0.16 + 0.07 * L.tiles.length);
            b.rotation.z = 0.32 * Math.cos(Math.PI * q) * arc;
            const land = q > 0.82 ? Math.sin(Math.PI * ((q - 0.82) / 0.18)) * (lastLeap ? 0.14 : 0.1) : 0;
            b.scale.set(1 + 0.18 * arc + land * 0.5, 1 - 0.06 * arc - land, 1 + land * 0.5);
            t.rig.y = 0.25 * (1 - q);
            // Tiles passed in this leap (by distance along it); the last one is announced on touchdown.
            const passed = Math.min(L.tiles.length - 1, Math.floor(e * L.tiles.length + 1e-6));
            while (announced < passed) {
              announced++;
              const x = L.tiles[announced - 1];
              t.spot = makeSpot(x.idx, false, this.jailIndex);
              this.stepped(ctx, L.first + announced, x.idx, n, null, true); // flown over
            }
          }
          this.markShadows();
        },
        end: () => {
          restBody(t);
          t.pose.rotation.set(0, 0, 0);
          t.rig.y = 0;
          while (announced < L.tiles.length) {
            announced++;
            const x = L.tiles[announced - 1];
            t.spot = makeSpot(x.idx, false, this.jailIndex);
            // Only the leap's last tile is a touchdown (a slow frame may leave earlier ones unannounced).
            this.stepped(ctx, L.first + announced, x.idx, n, null, announced < L.tiles.length);
          }
          if (lastLeap) this.landed(ctx);
        },
      });
    });
    return leaps;
  }

  /** One high arc to `spot` (card / jail teleports); the hat and thimble spin, the rest tumble. */
  scheduleArc(ctx, spot, height) {
    const { t, delay, speed, opts } = ctx;
    const dur = (opts.duration > 0 ? opts.duration : ARC_TIME) / speed;
    t.planSpot = spot;
    this.begin(ctx, t.persona.style, 'arc');
    const w = slotWorld(spot, 0, 1, this.jailIndex);
    const target = new THREE.Vector3(w.x, 0, w.z);
    const start = new THREE.Vector3();
    const style = t.persona.style;
    this.animator.add({
      delay,
      duration: dur,
      start: () => {
        this.started(ctx);
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
        t.root.rotation.y = t.fromYaw + angleDelta(t.fromYaw, t.targetYaw) * Math.min(1, p * 2);
        if (style === 'spin') t.pose.rotation.y = Math.PI * 4 * e;
        else if (style === 'flip') t.pose.rotation.z = -Math.PI * 4 * e;
        else t.body.rotation.x = Math.sin(Math.PI * p) * 0.6; // a little tumble in the air
        const land = p > 0.88 ? Math.sin(Math.PI * ((p - 0.88) / 0.12)) * 0.16 : 0;
        t.body.scale.set(1 + land * 0.5, 1 - land, 1 + land * 0.5);
        this.markShadows();
      },
      end: () => {
        if (!this.animator.finishing) this.dust(target, 0.8);
        this.landed(ctx);
      },
    });
    return { duration: dur, goAt: null, hops: 0, style, hopTimes: [], tileTimes: [], landAt: delay + dur, touchdowns: true };
  }

  dust(pos, size) {
    const fx = this.fx ?? this.scene.userData?.fx;
    try {
      fx?.dust?.(pos, { size });
    } catch { /* cosmetic */ }
  }

  // ---- reactions --------------------------------------------------------------------------------------

  /**
   * A short emotive animation for a player's token, `delay` seconds from now.
   *   celebrate  crouch, jump with a full spin, land             (~0.95 s)
   *   sad        slump forward, shake the head, recover           (~1.2 s)
   *   jail       sulk: turn away, droop, sigh, turn back          (~1.4 s)
   *   goJump     two quick happy hops with a half twirl           (~0.6 s)
   *   bankrupt   topple over its base edge, sink into the board   (~1.15 s; stays hidden until sync)
   *   victory    bouncing with a quarter twirl each bounce, repeating (opts.loops, default 16) until
   *              the token moves, stopReaction(id), or the game resets; returns ONE bounce's length
   * @param {string} playerId
   * @param {string} kind
   * @param {{delay?:number, speed?:number, loops?:number, onPeak?:Function, onLand?:Function,
   *          onDone?:Function, sfx?:object, silent?:boolean}} [opts]
   * @returns {number} seconds (0 if the token isn't on the board or the kind is unknown)
   */
  react(playerId, kind, opts = {}) {
    const t = this.map.get(playerId);
    if (!t || !t.visible || !Object.hasOwn(REACTIONS, kind)) return 0;
    const speed = opts.speed > 0 ? opts.speed : 1;
    const dur = REACTIONS[kind] / speed;
    const delay = Math.max(0, Number(opts.delay) || 0);
    const token = {};
    if (kind === 'victory') {
      t.reaction = token;
      this.victoryBounce(t, token, 0, Math.max(1, opts.loops ?? 16), dur, delay, opts);
      return dur;
    }
    t.acts++;
    let peaked = false;
    let landedAt = false;
    this.animator.add({
      delay,
      duration: dur,
      start: () => {
        restPose(t);
        restBody(t);
      },
      update: (p) => {
        const b = t.body;
        const q = t.pose;
        b.rotation.set(0, 0, 0);
        q.rotation.set(0, 0, 0);
        b.position.set(0, 0, 0);
        let sq = 0;
        if (kind === 'celebrate') {
          if (p < 0.15) sq = 0.2 * Math.sin((Math.PI / 2) * (p / 0.15));
          else if (p < 0.75) {
            const k = (p - 0.15) / 0.6;
            b.position.y = 0.55 * Math.sin(Math.PI * k);
            q.rotation.y = Math.PI * 2 * ease.inOutCubic(k);
            b.scale.set(0.94, 1.08, 0.94);
            if (!peaked && k >= 0.5) { peaked = true; this.fire(opts.onPeak, t); }
            sq = -1;
          } else {
            if (!landedAt) { landedAt = true; this.fire(opts.onLand, t); }
            sq = 0.18 * Math.sin(Math.PI * ((p - 0.75) / 0.25)) * (1 - (p - 0.75) / 0.25 * 0.5);
          }
        } else if (kind === 'sad') {
          const slump = Math.min(1, p / 0.3, (1 - p) / 0.2);
          q.rotation.z = -0.38 * ease.inOutSine(clamp(slump, 0, 1));
          sq = 0.1 * clamp(slump, 0, 1);
          if (p > 0.3 && p < 0.8) q.rotation.y = 0.3 * Math.sin(((p - 0.3) / 0.5) * Math.PI * 6) * (1 - (p - 0.3) / 0.5);
        } else if (kind === 'jail') {
          const away = ease.inOutSine(clamp(Math.min(p / 0.3, (1 - p) / 0.25), 0, 1));
          q.rotation.y = 2.5 * away;
          q.rotation.z = -0.26 * away;
          sq = away * (0.07 + 0.03 * Math.sin(p * Math.PI * 4));
        } else if (kind === 'goJump') {
          const k = (p * 2) % 1;
          b.position.y = 0.24 * Math.sin(Math.PI * k);
          q.rotation.y = Math.PI * ease.inOutSine(p);
          sq = k > 0.8 ? 0.12 * Math.sin(Math.PI * ((k - 0.8) / 0.2)) : 0;
          if (!peaked && p >= 0.25) { peaked = true; this.fire(opts.onPeak, t); }
        } else if (kind === 'bankrupt') {
          // Topple over the plinth's +Z edge (pivot there, not at the centre), then sink.
          const th = (Math.PI / 2) * ease.outBounce(clamp(p / 0.45, 0, 1));
          b.rotation.x = th;
          b.position.set(0, BASE_EDGE * Math.sin(th), BASE_EDGE * (1 - Math.cos(th)));
          if (!landedAt && p >= 0.2) { landedAt = true; this.fire(opts.onLand, t); }
          const s = clamp((p - 0.55) / 0.45, 0, 1);
          t.root.position.y = -0.6 * ease.inQuad(s);
          b.scale.setScalar(1 - 0.4 * s);
          sq = -1;
        }
        if (sq >= 0) b.scale.set(1 + sq * 0.5, 1 - sq, 1 + sq * 0.5);
        this.markShadows();
      },
      end: () => {
        if (kind === 'bankrupt') {
          t.root.visible = false; // hidden until sync() takes it off the board (or puts it back)
          t.root.position.y = 0;
        }
        restBody(t);
        restPose(t);
        t.acts = Math.max(0, t.acts - 1);
        safe(opts.onDone, { playerId, kind, skipped: this.animator.finishing });
        this.markShadows();
      },
    });
    return dur;
  }

  victoryBounce(t, token, k, loops, dur, delay, opts) {
    t.acts++;
    this.animator.add({
      delay,
      duration: dur,
      update: (p) => {
        const b = t.body;
        b.position.y = 0.36 * Math.sin(Math.PI * p);
        t.pose.rotation.y = (Math.PI / 2) * (k + ease.inOutSine(p));
        const land = p > 0.85 ? Math.sin(Math.PI * ((p - 0.85) / 0.15)) * 0.16 : 0;
        const air = Math.sin(Math.PI * p);
        b.scale.set(1 - 0.05 * air + land * 0.5, 1 + 0.08 * air - land, 1 - 0.05 * air + land * 0.5);
        this.markShadows();
      },
      end: () => {
        restBody(t);
        t.acts = Math.max(0, t.acts - 1);
        if (!this.animator.finishing) this.fire(opts.onLand, t);
        const more = !this.animator.finishing && t.reaction === token && t.visible && k + 1 < loops;
        if (more) this.victoryBounce(t, token, k + 1, loops, dur, 0.04, opts);
        else {
          if (t.reaction === token) t.reaction = null;
          restPose(t);
          safe(opts.onDone, { playerId: t.id, kind: 'victory', skipped: this.animator.finishing });
        }
      },
    });
  }

  /** Stops a looping reaction (victory) after its current bounce. */
  stopReaction(playerId) {
    const t = this.map.get(playerId);
    if (t) t.reaction = null;
  }

  fire(fn, t) {
    if (!this.animator.finishing) safe(fn, { playerId: t.id, tokenId: t.tokenId });
  }

  // ---- current player & idle life --------------------------------------------------------------------

  /** Marks the current player: their ring shows and their enamel glows. */
  setCurrent(id) {
    this.currentId = id;
    for (const t of this.map.values()) {
      const cur = t.id === id;
      t.ring.visible = cur && t.visible;
      t.mat.emissiveIntensity = cur ? GLOW_CURRENT[0] : GLOW_IDLE;
    }
  }

  /**
   * Idle life (the ambient timer, ~24 fps): every resting token breathes / sways in character (the
   * dog wags, the ship bobs and its turrets traverse, the hat tips, the boot taps, the thimble
   * wobbles, the wheelbarrow rocks); the current player's glows and its ring pulses. Only the pose
   * and the rig move (not the shadow-casting layout), so shadows aren't re-rendered.
   * Returns true while there is something to animate.
   */
  ambient(now) {
    const s = now / 1000;
    let any = false;
    for (const t of this.map.values()) {
      if (!t.visible) continue;
      any = true;
      const cur = t.id === this.currentId;
      if (cur) {
        const k = 0.5 + 0.5 * Math.sin(now / 380);
        t.ringMat.emissiveIntensity = 0.5 + 1.2 * k;
        t.ring.scale.setScalar(1 + 0.08 * k);
        t.mat.emissiveIntensity = GLOW_CURRENT[0] + (GLOW_CURRENT[1] - GLOW_CURRENT[0]) * k;
      }
      if (t.acts || t.popping) continue;
      idle(t, s + t.phase, cur ? 1.7 : 1);
    }
    return any;
  }

  /** Kept for callers of the old API: puts a token's pose back at rest. */
  stopBob(t) {
    restPose(t);
  }
}

// ---- helpers ------------------------------------------------------------------------------------------

function restBody(t) {
  t.body.position.set(0, 0, 0);
  t.body.rotation.set(0, 0, 0);
  t.body.scale.set(1, 1, 1);
}

function restPose(t) {
  t.pose.position.set(0, PIVOT_Y, 0);
  t.pose.rotation.set(0, 0, 0);
  t.pose.scale.set(1, 1, 1);
  t.rig.y = 0;
  t.rig.z = 0;
}

/** Per-personality idle motion at time s (seconds, phase-shifted per token), amplitude a. */
function idle(t, s, a) {
  const q = t.pose;
  q.position.set(0, PIVOT_Y, 0);
  q.rotation.set(0, 0, 0);
  q.scale.set(1, 1, 1);
  const breathe = Math.sin(s * 2.6);
  switch (t.tokenId) {
    case 'car':
      q.position.y += 0.0035 * a * Math.abs(Math.sin(s * 11)); // engine idling
      q.rotation.x = 0.012 * a * Math.sin(s * 2.1);
      break;
    case 'dog':
      t.rig.y = (0.35 + 0.25 * a) * Math.sin(s * 9);
      q.scale.y = 1 + 0.018 * a * breathe;
      q.rotation.z = 0.02 * a * Math.sin(s * 1.3);
      break;
    case 'ship':
      q.position.y += 0.012 * a * Math.sin(s * 1.6);
      q.rotation.x = 0.05 * a * Math.sin(s * 1.1);
      q.rotation.z = 0.025 * a * Math.sin(s * 0.8);
      t.rig.y = 0.55 * Math.sin(s * 0.3);
      break;
    case 'hat':
      q.rotation.z = -0.12 * a * Math.max(0, Math.sin(s * 1.2)) ** 6; // tips its brim now and then
      q.rotation.y = 0.18 * Math.sin(s * 0.45);
      break;
    case 'boot':
      q.rotation.z = 0.07 * a * Math.max(0, Math.sin(s * 3.1)) ** 4; // toe taps
      q.scale.y = 1 + 0.01 * a * breathe;
      break;
    case 'cat':
      t.rig.y = 0.2 * a * Math.sin(s * 1.3);
      q.scale.y = 1 + 0.02 * a * breathe;
      q.rotation.y = 0.08 * Math.sin(s * 0.5);
      break;
    case 'thimble':
      q.rotation.x = 0.045 * a * Math.sin(s * 1.7);
      q.rotation.z = 0.045 * a * Math.cos(s * 1.7);
      break;
    case 'wheelbarrow':
      q.rotation.z = 0.035 * a * Math.sin(s * 1.4);
      break;
    default:
      q.scale.y = 1 + 0.015 * a * breathe;
  }
}

const sound = (snd, rate = 1) => (snd ? { name: snd[0], rate: snd[1] * rate, volume: snd[2] } : null);

function safe(fn, ...args) {
  if (typeof fn !== 'function') return;
  try {
    fn(...args);
  } catch (err) {
    console.error('[renderer3d] token callback failed:', err);
  }
}

/** Glide progress (0..1 of the distance) at time fraction p: accelerate, cruise, brake. */
const ACC = 0.16;
const DEC = 0.24;
const VMAX = 1 / (1 - ACC / 2 - DEC / 2);
function glideProfile(p) {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  if (p < ACC) return (VMAX * p * p) / (2 * ACC);
  if (p <= 1 - DEC) return VMAX * (ACC / 2 + (p - ACC));
  return 1 - (VMAX * (1 - p) ** 2) / (2 * DEC);
}
/** Time fraction at which the glide has covered `f` of its distance (inverse of glideProfile). */
function invGlide(f) {
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 24; k++) {
    const mid = (lo + hi) / 2;
    if (glideProfile(mid) < f) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
/** d(glideProfile)/dp. */
function glideSpeed(p) {
  if (p < ACC) return (VMAX * p) / ACC;
  if (p <= 1 - DEC) return VMAX;
  return (VMAX * Math.max(0, 1 - p)) / DEC;
}

const tmpGlide = { x: 0, z: 0, yaw: 0, curv: 0 };

/**
 * A glide path from `start` through `points` ({x, z}), corners rounded with quadratic curves.
 * Returns { length, marks (arc length at each point), at(s, cursor, out) → cursor }.
 */
function buildPath(start, points) {
  const P = [{ x: start.x, z: start.z }, ...points];
  const xs = [P[0].x];
  const zs = [P[0].z];
  const markIdx = [];
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1];
    const b = P[i];
    const c = P[i + 1];
    if (!c) {
      xs.push(b.x); zs.push(b.z); markIdx.push(xs.length - 1);
      continue;
    }
    const inx = b.x - a.x, inz = b.z - a.z;
    const outx = c.x - b.x, outz = c.z - b.z;
    const li = Math.hypot(inx, inz), lo = Math.hypot(outx, outz);
    const cos = li > 1e-6 && lo > 1e-6 ? (inx * outx + inz * outz) / (li * lo) : 1;
    if (cos > 0.985) {
      xs.push(b.x); zs.push(b.z); markIdx.push(xs.length - 1);
      continue;
    }
    const r = Math.min(0.45, li * 0.5, lo * 0.5);
    const p0x = b.x - (inx / li) * r, p0z = b.z - (inz / li) * r;
    const p2x = b.x + (outx / lo) * r, p2z = b.z + (outz / lo) * r;
    const SEG = 8;
    for (let k = 0; k <= SEG; k++) {
      const u = k / SEG;
      const w0 = (1 - u) * (1 - u), w1 = 2 * u * (1 - u), w2 = u * u;
      xs.push(w0 * p0x + w1 * b.x + w2 * p2x);
      zs.push(w0 * p0z + w1 * b.z + w2 * p2z);
      if (k === SEG / 2) markIdx.push(xs.length - 1);
    }
  }
  const m = xs.length;
  const cum = new Float32Array(m);
  const segYaw = new Float32Array(Math.max(1, m - 1));
  for (let k = 1; k < m; k++) {
    const dx = xs[k] - xs[k - 1], dz = zs[k] - zs[k - 1];
    cum[k] = cum[k - 1] + Math.hypot(dx, dz);
    segYaw[k - 1] = Math.hypot(dx, dz) > 1e-6 ? Math.atan2(-dz, dx) : (k > 1 ? segYaw[k - 2] : 0);
  }
  // Vertex yaw = bisector of the neighbouring segments; curvature = turn / length.
  const yaw = new Float32Array(m);
  const curv = new Float32Array(m);
  for (let k = 0; k < m; k++) {
    const a = segYaw[Math.max(0, k - 1)];
    const b = segYaw[Math.min(m - 2, k)];
    yaw[k] = a + angleDelta(a, b) / 2;
    const len = (k > 0 ? cum[k] - cum[k - 1] : 0) + (k < m - 1 ? cum[k + 1] - cum[k] : 0);
    curv[k] = len > 1e-6 ? (2 * angleDelta(a, b)) / len : 0;
  }
  const length = cum[m - 1];
  return {
    length,
    marks: markIdx.map((k) => cum[k]),
    /** Position / yaw / curvature at arc length s; `cursor` is the segment to start searching from. */
    at(s, cursor, out) {
      let k = Math.max(0, Math.min(cursor, m - 2));
      while (k < m - 2 && cum[k + 1] < s) k++;
      while (k > 0 && cum[k] > s) k--;
      if (m < 2) {
        out.x = xs[0]; out.z = zs[0]; out.yaw = 0; out.curv = 0;
        return 0;
      }
      const L = cum[k + 1] - cum[k];
      const f = L > 1e-6 ? clamp((s - cum[k]) / L, 0, 1) : 1;
      out.x = xs[k] + (xs[k + 1] - xs[k]) * f;
      out.z = zs[k] + (zs[k + 1] - zs[k]) * f;
      out.yaw = yaw[k] + angleDelta(yaw[k], yaw[k + 1]) * f;
      out.curv = curv[k] + (curv[k + 1] - curv[k]) * f;
      return k;
    },
  };
}
