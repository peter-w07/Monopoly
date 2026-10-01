// public/r3d/choreo.js — turns one batch of engine events (CONTRACT §6) into a short timeline on
// the shared Animator: dice shot → token walk → landing beat → money / cards / buildings → settle.
//
// Rules (Monopoly Plus feel, minus its slowness):
//   * State is the truth. The timeline always ends with a "settle" step that reconciles every token,
//     owner marker, building and district with the batch's state, so skipping (finishAll) lands on
//     the truth.
//   * The camera frames each moment: dice in the plaza, the walking token (led, not trailed), the
//     landing tile, the tile being built on (the building pops once the camera has arrived), both
//     parties of a trade. Teleports and long card moves cut instead of chasing.
//   * Pacing: a normal roll lands in ~2.5 s (the token sets off as the dice settle). A newer state
//     arriving mid-timeline doesn't snap: renderer3d.js queues it and plays everything faster
//     (CATCH_UP) until the queue drains. The speed setting scales all of it; click / Esc skips.
//   * Nothing here blocks the UI: ui.js keeps its own buttons live the whole time.
//
// Named beats — the hook points of the choreography. Every moment worth a sound or an effect is a
// beat, fired once at its time on the timeline:
//     gameStart turnStart diceShake diceThrow diceBounce diceSettle doubles walkStart hop land zip
//     teleport cut passGo cardDraw cardFlip jailCard jailIn jailOut jailStay buy rent tax pay income
//     build hotel demolish mortgage unmortgage ownerChange auctionStart bid auctionPass gavel sold
//     stamp unsold tradePropose tradeAccept tradeReject tradeCancel deedLand coin bankrupt victory
//     monopoly (a colour set completed: the city's district celebrates — see celebrateSet)
// Each plays its default sound (BEAT_SOUND, via view.sound → sfx.play) and then calls the listeners
// registered with onBeat(name, fn) with { name, view, ctx, batch, pid?, tile?, pos?, amount?, … }.
// That is where new actor / world effects plug in (coins flying, token reactions, crowd cheers…)
// without touching the timeline. Beats never fire while a timeline is being skipped (finishAll),
// so a skip is silent.

import * as THREE from './three.js';
import { outward, tileCenter, SIDE_YAW } from './layout.js';
import * as TOKENS from './tokens.js'; // (namespace: optional exports like PERSONALITIES may be absent)

// ---- tuning knobs (animation seconds; the speed setting scales them all) ------------------------
const WALK_EARLY = 0.05; // the token sets off this long before the dice come to rest
const DICE_SHAKE = 0.18; // dice.js: the rattle in the hand before the throw (its default is longer)
const FOLLOW_EARLY = 0.35; // the follow shot starts this long before the first hop (camera on its way)
const LAND_BEAT = 0.25;
const LAND_TO_CARD = 0.1; // a landing on Chance / Community Chest: the card is the beat
const CARD_BEAT = 0.72; // a drawn card moves the token this long after it lifts off the pile (it keeps hanging)
const CARD_HOLD = 1.2; // seconds the 3D card hangs in front of the camera…
const CARD_FLY_IN = 0.5; // …after flying up from its pile (cards.js)
const FOCUS_HOLD = 0.7; // the camera lingers on a landing before going back to the overview
const BUILD_HOLD = 1.1; // …and on a tile being built on / sold / mortgaged
const PUSH_IN = 0.55; // cut to a wide shot of the tile, push in: the building pops this long after
const PAN_TO = 0.4; // …or, when the camera is already there, after a short pan
const CALM_ARRIVE = 0.8; // calm camera: the gentle glide before a building pops
const TELEPORT_LAND = 0.12; // a teleported token's push-in starts this long before it touches down
const CAGE_CONTACT = 0.18; // board.cageBounce: the bars first hit the board this long after they start to drop
const SOLD_BEAT = 0.9;
const SOLD_STAMP_AT = 0.95; // fx.auctionSold with two strikes: the stamp lands about this long in
const BANK_POS = new THREE.Vector3(0, 0.3, 0.15); // the bank / pot (the plaza), for coins going there
const TRADE_BEAT = 0.75;
const SWAP_STAGGER = 0.16; // tiles changing hands swap owner colours one after another
const MONOPOLY_CHEER_GAP_MS = 2500; // completed sets celebrated closer together than this share one cheer
const BANKRUPT_BEAT = 0.3;
export const CATCH_UP = 1.5; // states queued behind the running batch: everything plays 1.5× faster…
export const CATCH_UP_MAX = 2.25; // …2.25× when three or more are waiting
export const MAX_QUEUE = 4; // beyond this many waiting states the oldest land at once
// Seats around the table, in join order (the viewer's side for the overview); spectators sit at GO.
const SEATS = ['bottom', 'left', 'top', 'right'];

// ---- sounds -------------------------------------------------------------------------------------------
// Default sound(s) of each beat: [sfx name, options] (sfx.js, brief §1). `delay` is real seconds.
const BEAT_SOUND = {
  gameStart: [['cheer', { volume: 0.45 }]],
  diceShake: [['diceShake', { volume: 0.75 }]],
  diceThrow: [['diceThrow']],
  diceBounce: [['diceBounce']],
  diceSettle: [['diceSettle']],
  doubles: [['doubles']],
  hop: [['hop', { volume: 0.3 }]],
  land: [['land']],
  zip: [['whoosh', { volume: 0.7 }]],
  teleport: [['whoosh']],
  cut: [['whoosh', { volume: 0.45 }]],
  passGo: [['passGo']],
  cardDraw: [['cardDraw']],
  cardFlip: [['cardFlip']],
  jailCard: [['cardFlip', { volume: 0.6 }]],
  jailIn: [['jailSlam']],
  jailOut: [['jailFree']],
  jailStay: [['jailSlam', { volume: 0.35, rate: 1.3 }]],
  buy: [['cashRegister']],
  rent: [['rent']],
  tax: [['tax']],
  pay: [['coins', { volume: 0.8 }]],
  income: [['coins']],
  build: [['build']],
  hotel: [['hotel']],
  demolish: [['demolish']],
  mortgage: [['stamp']],
  unmortgage: [['unstamp']],
  auctionStart: [['gavel']],
  bid: [['bid']],
  sold: [['gavel'], ['sold', { delay: 0.15 }]],
  gavel: [['gavel']],
  stamp: [['sold']],
  coin: [['coin', { volume: 0.3 }]],
  deedLand: [['cardFlip', { volume: 0.45, rate: 1.15 }]],
  unsold: [['auctionEnd']],
  tradePropose: [['tradePropose']],
  tradeAccept: [['tradeAccept']],
  tradeReject: [['tradeReject']],
  tradeCancel: [['tradeReject', { volume: 0.5 }]],
  bankrupt: [['bankrupt']],
  victory: [['victory'], ['cheer', { delay: 0.6, volume: 0.8 }]],
  monopoly: [['doubles', { volume: 0.55, rate: 0.9 }], ['cheer', { delay: 0.35, volume: 0.7 }]],
};
// Each token's signature sound, once per walk, and the pitch of its hops.
const SIGNATURE = { car: 'drive', dog: 'bark', ship: 'horn', hat: 'hatSpin', boot: 'stomp', cat: 'purr', thimble: 'clink', wheelbarrow: 'squeak' };
const HOP_RATE = { car: 0.9, dog: 1.2, ship: 0.8, hat: 1.1, boot: 0.85, cat: 1.25, thimble: 1.35, wheelbarrow: 0.95 };
// When nothing animates ("instant" speed, reduced motion) a batch gets at most one sound: the most
// important of its beats, in this order.
const SUMMARY = [
  ['game_over', 'victory'], ['bankrupt', 'bankrupt'], ['auction_won', 'sold'], ['trade_accepted', 'tradeAccept'],
  ['sent_to_jail', 'jailIn'], ['bought', 'buy'], ['built', 'build'], ['paid_rent', 'rent'], ['paid_tax', 'tax'],
  ['passed_go', 'passGo'], ['card_drawn', 'cardFlip'], ['left_jail', 'jailOut'], ['sold_house', 'demolish'],
  ['mortgaged', 'mortgage'], ['unmortgaged', 'unmortgage'], ['trade_proposed', 'tradePropose'],
  ['trade_rejected', 'tradeReject'], ['auction_started', 'auctionStart'], ['auction_unsold', 'unsold'],
  ['auction_bid', 'bid'], ['collected', 'income'], ['paid', 'pay'], ['dice_rolled', 'diceSettle'], ['moved', 'land'],
];

const money = (n) => `$${Math.abs(Math.round(Number(n) || 0))}`;

// ---- beat listeners ---------------------------------------------------------------------------------
const listeners = new Map(); // beat name → Set<fn>

/**
 * Registers `fn(payload)` for a named beat ('*' = every beat). Returns an unsubscribe function.
 * Listeners run at the beat's moment on the timeline (never during a skip); errors are caught.
 */
export function onBeat(name, fn) {
  if (typeof fn !== 'function') return () => {};
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name)?.delete(fn);
}

function runListeners(name, payload) {
  for (const key of [name, '*']) {
    const set = listeners.get(key);
    if (!set) continue;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[renderer3d] beat listener "${name}" failed:`, err);
      }
    }
  }
}

/** Plays a beat's sounds now (pan from the world position of what makes the noise). */
function playBeatSound(view, name, data) {
  if (data.silent || !view.sound) return;
  const list = data.sounds ?? BEAT_SOUND[name];
  if (!list?.length) return;
  const pan = panOf(view, data.pos);
  for (const [snd, opts] of list) view.sound(snd, { pan, ...opts, ...(data.soundOpts ?? {}) });
}

/** Stereo position (-1…1) of a world point on screen. */
const panVec = new THREE.Vector3();
function panOf(view, pos) {
  try {
    const p = typeof pos === 'function' ? pos() : pos;
    if (!p || !view.stage?.camera) return 0;
    panVec.set(p.x, p.y ?? 0, p.z).project(view.stage.camera);
    if (!Number.isFinite(panVec.x)) return 0;
    return Math.max(-0.75, Math.min(0.75, panVec.x * 0.6));
  } catch {
    return 0;
  }
}

// ---- the batch builder -----------------------------------------------------------------------------

/**
 * Plays `events` for the new state in `ctx`.
 * @param {object} view  { animator, tokens, dice, board, city, cards, fx, overlay, director, BOARD, info, sound }
 * @param {object} ctx   render context (renderer3d.makeCtx)
 * @param {object[]} events
 */
export function playBatch(view, ctx, events) {
  new Batch(view, ctx, events).play();
}

class Batch {
  constructor(view, ctx, events) {
    this.view = view;
    this.ctx = ctx;
    this.events = events.filter((e) => e && typeof e === 'object');
    this.id = ++view.batchSeq;
    view.running = this.id;
    this.t = 0; // timeline cursor (animation seconds from now)
    this.diceEnd = 0; // when the dice have come to rest
    this.walkAt = null; // when a walk after the dice may start
    this.moved = false;
    this.focused = false; // the camera went close: come back to the overview at the end
    this.lingerFor = FOCUS_HOLD;
    this.buildFocus = null; // tile the camera pushed in on for building / mortgaging
    this.goAt = new Map(); // playerId → time the current walk crosses GO
    this.landSounds = new Map(); // playerId → the landing sound of their token's personality
    this.jailBars = false;
    this.types = new Set(this.events.map((e) => e.type));
  }

  get current() {
    return this.view.batchSeq === this.id; // false once a newer batch took over
  }

  // ---- scheduling helpers ----

  at(time, fn) {
    return this.view.animator.at(Math.max(0, time), fn);
  }

  /** Fires the named beat at `time` (timeline seconds from now). */
  beat(name, time, data = {}) {
    this.at(time, () => this.fire(name, data));
  }

  /** Fires the named beat now: its sound(s), then onBeat listeners. Nothing while skipping. */
  fire(name, data = {}) {
    const { view } = this;
    if (view.animator.finishing) return; // skipped: silent, no effects
    playBeatSound(view, name, data);
    const pos = typeof data.pos === 'function' ? data.pos() : data.pos;
    runListeners(name, { ...data, pos: pos ?? null, name, view, ctx: this.ctx, batch: this.id });
    view.beatLog?.push({ name, t: performance.now(), at: view.animator.time, batch: this.id, pid: data.pid ?? null, tile: data.tile ?? null });
  }

  /**
   * An fx.js effect at `time`: fn(fx) runs then (not while skipping — the settle step shows the
   * outcome). Only effects the Fx actually has are called (hasFx), so older layers just skip them.
   */
  effect(time, fn) {
    const { view } = this;
    this.at(time, () => {
      if (view.animator.finishing || !view.fx) return;
      try {
        fn(view.fx);
      } catch (err) {
        console.error('[renderer3d] effect failed:', err);
      }
    });
  }

  /** A city.js flourish at `time` (pulse, bankPulse…): skipped while skipping, like effects. */
  cityFx(time, fn) {
    const { view } = this;
    this.at(time, () => {
      if (view.animator.finishing || !view.city) return;
      try {
        fn(view.city);
      } catch (err) {
        console.error('[renderer3d] city effect failed:', err);
      }
    });
  }

  /**
   * Coins (and notes) flying between two players' tokens, or to / from the bank (null), at `time`.
   * Each piece clinks as it lands (the 'coin' beat).
   */
  money(time, from, to, amount) {
    const { view } = this;
    if (!hasFx(view, 'money') || !(Math.abs(Number(amount) || 0) > 0)) return;
    this.effect(time, (fx) => {
      const A = from ? view.tokens.worldPos(from) : null;
      const B = to ? view.tokens.worldPos(to) : null;
      if ((from && !A) || (to && !B)) return; // a token that isn't on the board
      fx.money(A, B, amount, { onLand: (k, n) => { if (k % 2 === 0 || k === n - 1) this.fire('coin', { pid: to ?? null, pos: B ?? BANK_POS }); } });
    });
  }

  /** claim() right now (for effect callbacks, e.g. the SOLD stamp landing). */
  claimNow(i, beatName = 'ownerChange', data = {}) {
    if (this.view.animator.finishing) return;
    syncOne(this.view, this.ctx, i, true);
    this.view.city.sync(this.ctx, true);
    this.fire(beatName, { tile: i, pos: this.overTile(i, 0.3), ...data });
  }

  /** A token reaction (tokens.js react: celebrate, sad, jail, goJump, victory…) at `time`, if supported. */
  react(time, pid, kind, opts = {}) {
    const { tokens } = this.view;
    if (typeof tokens.react !== 'function' || !pid) return 0;
    return Number(tokens.react(pid, kind, { ...opts, delay: Math.max(0, time) })) || 0;
  }

  /** Camera call at `time` (the director ignores it while the player has the camera). */
  shot(time, fn) {
    this.at(time, () => { if (this.current) fn(this.view.director); });
  }

  /**
   * A TV cut at `time`: `setup` picks the shot, then the director cuts if its style allows — with a
   * soft whoosh unless `silent` (a teleport / zip beat at the same moment has its own).
   */
  cutTo(time, setup, { silent = false } = {}) {
    this.at(time, () => {
      if (!this.current) return;
      const d = this.view.director;
      setup(d);
      if (d.cut() && !silent && !this.view.animator.finishing) playBeatSound(this.view, 'cut', {});
    });
  }

  above(id, dy = 0.95) {
    const p = this.view.tokens.worldPos(id);
    return p ? p.setY(p.y + dy) : null;
  }

  overTile(i, dy = 0.9) {
    const c = tileCenter(i);
    return new THREE.Vector3(c.x, dy, c.z);
  }

  float(time, id, text, kind, opts, dy) {
    this.at(time, () => this.view.overlay.float(this.above(id, dy), text, kind, opts));
  }

  floatTile(time, i, text, kind, opts) {
    this.at(time, () => this.view.overlay.float(this.overTile(i), text, kind, opts));
  }

  name(id) {
    return id === this.ctx.me ? 'you' : this.view.info.name(this.ctx, id);
  }

  Name(id) {
    return id === this.ctx.me ? 'You' : this.view.info.name(this.ctx, id);
  }

  chip(id) {
    return this.ctx.colorOf.get(id) ?? null;
  }

  tokenPos(id) {
    return () => this.view.tokens.worldPos(id);
  }

  /** Reconciles one tile with the batch's state (owner strip pops, buildings grow) + the city. */
  claim(time, i, beatName = 'ownerChange', data = {}) {
    this.at(time, () => {
      syncOne(this.view, this.ctx, i, true);
      this.view.city.sync(this.ctx, true);
    });
    this.beat(beatName, time, { tile: i, pos: this.overTile(i, 0.3), ...data });
  }

  /**
   * Frames tile i for a building / mortgage change and returns when the change should pop: once the
   * camera has arrived (cut to a wide shot and push in when it is far, pan when it is near).
   */
  pushIn(i) {
    const d = this.view.director;
    this.focused = true;
    this.lingerFor = Math.max(this.lingerFor, BUILD_HOLD);
    if (this.buildFocus === i) return this.t;
    const first = this.buildFocus === null;
    this.buildFocus = i;
    if (!d.auto || d.instant) {
      this.shot(this.t, (dir) => dir.focus(i));
      return this.t;
    }
    if (d.style === 'calm') {
      this.shot(this.t, (dir) => dir.focus(i));
      this.t += first ? CALM_ARRIVE : PAN_TO;
      return this.t;
    }
    if (first && this.t < 0.05 && !d.isFraming(i)) {
      this.cutTo(this.t, (dir) => dir.focus(i, { wide: true }));
      this.shot(this.t + 0.02, (dir) => dir.focus(i));
      this.t += PUSH_IN;
    } else {
      this.shot(this.t, (dir) => dir.focus(i));
      this.t += first ? PUSH_IN : PAN_TO;
    }
    return this.t;
  }

  // ---- the timeline ----

  play() {
    const { view, ctx } = this;
    const { tokens, overlay, director } = view;
    director.setSeat(seatYaw(ctx));
    if (director.mode === 'orbit' && ctx.state.status !== 'finished') director.overview(activePos(view, ctx));

    // New players' tokens appear in place (popping in at game start); walkers keep their position.
    const leaving = new Set(this.events.filter((e) => e.type === 'bankrupt').map((e) => e.playerId));
    tokens.sync(ctx, { animate: true, place: false, popNew: this.types.has('game_started'), keep: leaving });
    if (!this.types.has('turn_started')) overlay.setTurn(view.info.turn(ctx), false);

    this.events.forEach((e, k) => {
      const handler = ON[e.type];
      if (!handler) return;
      try {
        handler(this, e, k);
      } catch (err) {
        console.error(`[renderer3d] choreography for ${e.type} failed:`, err);
      }
    });
    this.finish();
  }

  /** Settle: everything converges on the state of this batch; then the next queued batch starts. */
  finish() {
    const { view, ctx } = this;
    const end = Math.max(this.t, this.diceEnd) + 0.05;
    view.settleItem = this.at(end, () => {
      // The same state may have been re-sent meanwhile (connection flags, timers): use the latest copy.
      const latest = view.latest && view.latest.state?.seq === ctx.state?.seq ? view.latest : ctx;
      // When the next queued state lands at once (far behind), don't start glides it would undo.
      settle(view, latest, { animate: !view.queue?.[0]?.before });
      if (view.running === this.id) view.running = null;
      view.onBatchDone?.();
    });
    const pending = pendingTile(ctx);
    const auction = auctionTile(ctx);
    const hold = pending ?? auction;
    // A pending purchase / auction keeps its tile framed; a pending trade offer stays framed as
    // trade_proposed left it; otherwise a close shot drifts back to the overview after a moment.
    const offer = !!ctx.state.trade && this.types.has('trade_proposed');
    if (!this.events.length) {
      // A new state without events (a reconnect, a skipped-ahead seq): glide to what matters now.
      this.shot(0, () => aimCamera(view, ctx));
    } else if (hold !== null) {
      this.shot(end, (d) => d.focus(hold, { hold: true }));
    } else if (!offer && (this.moved || this.focused) && !this.types.has('turn_started') && !this.types.has('game_over')) {
      this.shot(end + (this.moved ? this.lingerFor : this.lingerFor * 0.75), (d) => {
        if (d.mode !== 'orbit') d.overview(activePos(view, ctx));
      });
    }
  }
}

// ---- event handlers (one per CONTRACT §6 event type) ------------------------------------------------

const ON = {
  game_started(b) {
    b.beat('gameStart', 0.1, {});
  },

  turn_started(b, e) {
    const { view, ctx } = b;
    b.at(b.t, () => {
      view.overlay.setTurn(view.info.turn(ctx), true);
      view.tokens.setCurrent(ctx.active ? e.playerId : null);
      if (!view.director.pinned) view.director.resume();
    });
    b.shot(b.t, (d) => d.overview(view.tokens.worldPos(e.playerId)));
    b.beat('turnStart', b.t, { pid: e.playerId });
  },

  dice_rolled(b, e, k) {
    const values = Array.isArray(e.dice) && e.dice.length === 2 ? e.dice.map(Number) : null;
    if (!values || values.some((v) => !(v >= 1 && v <= 6))) return;
    const { view, ctx } = b;
    const { tokens, dice, overlay } = view;
    const pid = e.playerId;
    const tok = tokens.get(pid);
    const from = outward(tok?.spot.index ?? 0);
    const seed = ((Number(ctx.state.seq) || 0) * 31 + k * 7) >>> 0;
    const small = e.purpose === 'utility';
    const t0 = b.t;
    const near = tokens.worldPos(pid);
    // Utility dice are thrown without moving the camera off the utility.
    if (!small) b.shot(t0, (d) => d.dice(near));
    const pos = () => view.dice.labelPos?.() ?? new THREE.Vector3(0, 0.5, 0);
    // dice.js calls back at the throw's real moments (shake, release, every bounce, rest); an older
    // layer doesn't, and gets beats spread over its known timing instead.
    const res = dice.schedule(values, from, seed, t0, {
      small,
      shake: DICE_SHAKE,
      onShake: () => b.fire('diceShake', { pid, pos: near }),
      onThrow: () => b.fire('diceThrow', { pid, pos: near }),
      onBounce: (intensity, die, kind) => b.fire('diceBounce', {
        pid, pos, die, kind,
        soundOpts: { volume: 0.3 + 0.7 * Math.max(0, Math.min(1, Number(intensity) || 0)), rate: (kind === 'edge' ? 1.2 : 1) + (die ? 0.06 : 0) },
      }),
      onSettle: (info) => { if (!info?.skipped) b.fire('diceSettle', { pid, pos, values }); },
    });
    const { dur, rest, contacts } = diceTiming(res);
    if (!Array.isArray(res?.bounces)) {
      b.beat('diceShake', t0, { pid, pos: near });
      b.beat('diceThrow', t0 + 0.06, { pid, pos: near });
      contacts.forEach((c, n) => b.beat('diceBounce', t0 + c, { pid, pos, soundOpts: { volume: [1, 0.62, 0.38][n] ?? 0.25, rate: 1 + n * 0.07 } }));
      b.beat('diceSettle', t0 + rest, { pid, pos, values });
    }
    const total = values[0] + values[1];
    const doubles = values[0] === values[1];
    b.at(t0 + rest - 0.1, () => overlay.callout(doubles ? `DOUBLES! ${total}` : `${total}`, doubles ? 'doubles' : 'total', doubles ? 1300 : 900));
    if (doubles && e.purpose !== 'utility') {
      b.beat('doubles', t0 + rest, { pid, pos, values });
      if (typeof dice.celebrate === 'function') b.at(t0 + rest, () => dice.celebrate());
    }
    b.diceEnd = t0 + dur;
    b.walkAt = t0 + Math.max(0.5, rest - WALK_EARLY);
    b.t = small ? b.diceEnd : b.walkAt;
  },

  moved(b, e) {
    const { view } = b;
    const { tokens, board } = view;
    const pid = e.playerId;
    const tok = tokens.get(pid);
    if (!tok) return;
    const start = b.t;
    const token = tok.tokenId;
    const pos = b.tokenPos(pid);
    // tokens.js calls back at the walk's real moments with its personality's sound suggestions (the
    // car drives, the boot stomps each step, the dog barks on arrival…); they become beats.
    const r = tokens.scheduleMove(e, start, {
      onStart: (info) => {
        if (info?.kind !== 'arc') b.fire('walkStart', { pid, token, via: e.via, style: info?.style ?? null, pos, sounds: suggested(info) });
      },
      onStep: (i, info) => {
        if (info?.kind === 'hop' && !info.last) b.fire('hop', { pid, token, step: i, tile: info.index ?? null, pos, sounds: suggested(info) });
      },
    }) ?? {};
    // Does the layer call back (older layers: evenly spread hop beats instead)?
    const live = Array.isArray(r.hopTimes) && typeof r.style === 'string';
    const dur = Number(r.duration) || 0;
    const landSound = personaLand(view, token, r.kind);
    if (r.kind === 'hop') {
      b.shot(start - FOLLOW_EARLY, (d) => d.follow(tok.root));
      if (!live) {
        b.beat('walkStart', start, { pid, token, via: e.via, pos, sounds: SIGNATURE[token] ? [[SIGNATURE[token], { volume: 0.55 }]] : [] });
        const rate = HOP_RATE[token] ?? 1;
        // The last touchdown is the landing (its own beat and sound).
        hopTimes(r, start).slice(0, -1).forEach((at, n) => b.beat('hop', at, { pid, token, step: n + 1, pos, soundOpts: { rate: rate * (0.97 + (n % 3) * 0.03) } }));
      }
      b.landSounds.set(pid, landSound);
      if (e.via !== 'roll' && !b.types.has('landed')) b.beat('land', start + dur, { pid, tile: Number(e.to), pos, sounds: landSound });
    } else if (r.kind === 'zip') {
      // A long card move ("Advance to GO"): cut wide so the whole trip is in shot, then push in.
      b.cutTo(start, (d) => d.overview(tokens.worldPos(pid)), { silent: true });
      b.beat('zip', start, { pid, token, pos });
      b.landSounds.set(pid, landSound);
      if (!b.types.has('landed')) b.beat('land', start + dur, { pid, tile: Number(e.to), pos, sounds: landSound });
    } else if (r.kind === 'arc') {
      // Don't chase a token flying over the board: cut to a wide shot of the destination (it flies
      // into frame), then push in as it lands.
      const to = Number(e.to);
      b.cutTo(start, (d) => d.focus(to, { wide: true }), { silent: true });
      b.beat('teleport', start, { pid, token, tile: to, pos });
      b.shot(start + Math.max(0, dur - TELEPORT_LAND), (d) => d.focus(to));
      if (e.via !== 'jail' && !b.jailBars && !b.types.has('landed')) b.beat('land', start + dur, { pid, tile: to, pos });
    }
    if (Number.isFinite(r.goAt)) b.goAt.set(pid, r.goAt);
    b.t += dur;
    b.moved = true;
    if (e.via === 'jail' || b.jailBars) {
      const at = b.t - 0.05;
      board.cageBounce(at);
      const data = { pid, tile: Number(e.to), pos };
      if (hasFx(view, 'jailSlam')) b.effect(at, (fx) => fx.jailSlam(undefined, { onSlam: () => b.fire('jailIn', data) }));
      else b.beat('jailIn', at + CAGE_CONTACT, data);
      b.react(at + CAGE_CONTACT + 0.3, pid, 'jail');
      b.jailBars = false;
      b.focused = true;
    }
  },

  passed_go(b, e) {
    const pid = e.playerId;
    const at = b.goAt.get(pid) ?? b.t;
    b.goAt.delete(pid);
    b.at(at, () => b.view.board.flash(0, 0.7));
    b.cityFx(at, (city) => city.bankPulse?.()); // the Bank in GO's corner sparkles
    const data = { pid, amount: e.amount, tile: 0, pos: b.overTile(0, 0.3) };
    if (hasFx(b.view, 'goBurst')) {
      // "GO! +$200" bursts on the GO tile; the fanfare plays with it.
      b.effect(at, (fx) => fx.goBurst(b.overTile(0, 0), { amount: e.amount, onBurst: () => b.fire('passGo', data) }));
    } else {
      b.float(at, pid, `+${money(e.amount)}`, 'gold');
      b.beat('passGo', at, data);
    }
  },

  landed(b, e, k) {
    const i = Number(e.tileIndex);
    b.at(b.t, () => b.view.board.flash(i));
    b.shot(b.t, (d) => d.focus(i));
    const sounds = b.landSounds.get(e.playerId) ?? undefined;
    b.beat('land', b.t, { pid: e.playerId, tile: i, pos: b.tokenPos(e.playerId), sounds });
    b.focused = true;
    b.t += b.events[k + 1]?.type === 'card_drawn' ? LAND_TO_CARD : LAND_BEAT;
  },

  card_drawn(b, e) {
    const { view } = b;
    const who = b.Name(e.playerId);
    const text = String(e.text ?? '');
    view.board.drawCard(e.deck, b.t);
    view.cards.schedule({ deck: e.deck, text, who }, b.t, CARD_HOLD);
    const pile = () => view.board.deckPose?.(e.deck)?.position ?? null;
    b.beat('cardDraw', b.t, { pid: e.playerId, deck: e.deck, pos: pile });
    b.beat('cardFlip', b.t + 0.3, { pid: e.playerId, deck: e.deck, text });
    // The caption takes over as the 3D card flies away (both at once would overlap), and stays readable.
    b.at(b.t + CARD_FLY_IN + CARD_HOLD - 0.1, () => view.overlay.showCard({ deck: e.deck, who, text }));
    b.t += CARD_BEAT;
  },

  jail_card_received(b, e) {
    b.float(b.t, e.playerId, 'Get Out of Jail Free', 'gold');
    b.beat('jailCard', b.t, { pid: e.playerId, deck: e.deck, pos: b.tokenPos(e.playerId) });
  },

  paid_rent(b, e) {
    money2(b, e, 'rent', e.ownerId, 0.45);
  },

  paid(b, e) {
    money2(b, e, 'pay', e.toPlayerId, 0.2);
  },

  debt_paid(b, e) {
    const payees = Array.isArray(e.payees) && e.payees.length ? e.payees : null;
    if (!payees) return money2(b, e, 'pay', e.toPlayerId, 0.2);
    b.float(b.t, e.playerId, `−${money(e.amount)}`, 'minus');
    b.beat('pay', b.t, { pid: e.playerId, amount: e.amount, pos: b.tokenPos(e.playerId) });
    payees.slice(0, 5).forEach((p, n) => {
      if (!b.ctx.byId.has(p.playerId)) return;
      b.float(b.t + 0.2 + n * 0.12, p.playerId, `+${money(p.amount)}`, 'plus');
      b.money(b.t + 0.1 + n * 0.12, e.playerId, p.playerId, p.amount);
    });
    b.t += 0.3;
  },

  paid_tax(b, e) {
    b.float(b.t, e.playerId, `−${money(e.amount)}`, 'minus');
    b.beat('tax', b.t, { pid: e.playerId, amount: e.amount, tile: Number(e.tileIndex), pos: b.tokenPos(e.playerId) });
    b.money(b.t + 0.1, e.playerId, null, e.amount);
    b.react(b.t + 0.05, e.playerId, 'sad');
    b.t += 0.25;
  },

  collected(b, e) {
    const pid = e.playerId;
    b.float(b.t, pid, `+${money(e.amount)}`, 'plus');
    if (e.fromPlayerId && b.ctx.byId.has(e.fromPlayerId)) b.float(b.t + 0.25, pid, `−${money(e.amount)} from ${b.name(e.fromPlayerId)}`, 'minus', { chip: b.chip(e.fromPlayerId) }, 1.5);
    b.beat('income', b.t, { pid, from: e.fromPlayerId ?? null, amount: e.amount, reason: e.reason, pos: b.tokenPos(pid) });
    b.money(b.t, e.fromPlayerId && b.ctx.byId.has(e.fromPlayerId) ? e.fromPlayerId : null, pid, e.amount);
    if (!laterMove(b, pid)) b.react(b.t + 0.05, pid, 'celebrate');
    b.t += 0.2;
  },

  bought(b, e) {
    const i = Number(e.tileIndex);
    b.shot(b.t, (d) => d.focus(i));
    b.claim(b.t, i);
    b.beat('buy', b.t, { pid: e.playerId, tile: i, amount: e.price, pos: b.overTile(i, 0.3) });
    b.money(b.t + 0.05, e.playerId, null, e.price);
    if (hasFx(b.view, 'sparkles')) b.effect(b.t + 0.1, (fx) => fx.sparkles(b.overTile(i, 0.15), { count: 28, color: b.chip(e.playerId) ?? undefined }));
    b.react(b.t + 0.2, e.playerId, 'celebrate');
    b.floatTile(b.t + 0.1, i, `−${money(e.price)}`, 'minus', { chip: b.chip(e.playerId) });
    b.focused = true;
    b.t += 0.5;
  },

  declined(b) {
    b.focused = true; // let go of the held tile → back to the overview (unless an auction follows)
  },

  built(b, e) {
    const i = Number(e.tileIndex);
    const at = b.pushIn(i);
    const hotel = Number(e.houses) === 5;
    b.claim(at, i, hotel ? 'hotel' : 'build', { pid: e.playerId, houses: Number(e.houses) });
    const cost = Number(b.view.BOARD.tiles[i]?.houseCost) || 0;
    if (cost) b.floatTile(at + 0.15, i, `−${money(cost)}`, 'minus', { chip: b.chip(e.playerId) });
    b.t = at + 0.3;
  },

  sold_house(b, e) {
    const i = Number(e.tileIndex);
    const at = b.pushIn(i);
    b.claim(at, i, 'demolish', { pid: e.playerId, houses: Number(e.houses) });
    const amount = Number(e.amount) || 0; // the refund (may cover several levels)
    if (amount) b.floatTile(at + 0.15, i, `+${money(amount)}`, 'plus', { chip: b.chip(e.playerId) });
    b.t = at + 0.3;
  },

  mortgaged(b, e) {
    const i = Number(e.tileIndex);
    const at = b.pushIn(i);
    b.claim(at, i, 'mortgage', { pid: e.playerId, amount: e.amount });
    b.floatTile(at + 0.1, i, `+${money(e.amount)}`, 'plus', { chip: b.chip(e.playerId) });
    b.t = at + 0.25;
  },

  unmortgaged(b, e) {
    const i = Number(e.tileIndex);
    const at = b.pushIn(i);
    b.claim(at, i, 'unmortgage', { pid: e.playerId, amount: e.amount });
    b.floatTile(at + 0.1, i, `−${money(e.amount)}`, 'minus', { chip: b.chip(e.playerId) });
    b.t = at + 0.25;
  },

  sent_to_jail(b, e) {
    b.at(b.t, () => b.view.overlay.callout('GO TO JAIL!', 'alert', 1100));
    b.jailBars = true;
    b.t += 0.3;
  },

  left_jail(b, e) {
    b.float(b.t, e.playerId, 'Out of jail', 'info');
    const board = b.view.board;
    if (typeof board.cageLift === 'function') board.cageLift(b.t);
    b.beat('jailOut', b.t, { pid: e.playerId, method: e.method, pos: b.tokenPos(e.playerId) });
    b.t += 0.25;
  },

  jail_roll_failed(b, e) {
    const at = Math.max(b.t, b.diceEnd - 0.05);
    b.float(at, e.playerId, 'No doubles', 'info');
    b.beat('jailStay', at, { pid: e.playerId, attempt: e.attempt, pos: b.tokenPos(e.playerId) });
  },

  debt_started(b, e) {
    b.float(b.t, e.playerId, `Owes ${money(e.amount)}`, 'minus');
  },

  timeout(b, e) {
    b.float(b.t, e.playerId, "Time's up", 'info');
  },

  bankrupt(b, e) {
    const { view, ctx } = b;
    const pid = e.playerId;
    const tok = view.tokens.get(pid);
    b.at(b.t, () => view.overlay.callout('BANKRUPT!', 'alert', 1200, { sub: view.info.name(ctx, pid), color: b.chip(pid) }));
    if (tok?.visible) b.shot(b.t, (d) => d.focus(tok.spot.index));
    b.beat('bankrupt', b.t, { pid, to: e.toPlayerId ?? null, pos: b.tokenPos(pid) });
    if (Number(e.cash) > 0) b.money(b.t + 0.1, pid, e.toPlayerId && ctx.byId.has(e.toPlayerId) ? e.toPlayerId : null, e.cash);
    b.focused = true;
    b.t += view.tokens.sink(pid, b.t + 0.2) + 0.2;
    // Their properties change hands one after another (to the creditor, or back to the bank).
    const tiles = changedTiles(view, ctx).slice(0, 28);
    if (tiles.length) {
      b.shot(b.t, (d) => d.overview(activePos(view, ctx)));
      tiles.forEach((i, n) => b.claim(b.t + 0.2 + n * 0.09, i, 'ownerChange', { pid: e.toPlayerId ?? null, from: pid }));
      b.t += 0.2 + tiles.length * 0.09 + BANKRUPT_BEAT;
    }
  },

  game_over(b, e) {
    const { view } = b;
    b.shot(b.t, (d) => {
      const w = view.tokens.get(e.winnerId);
      if (w?.visible) d.orbit(w.root, 10);
    });
    b.effect(b.t, (fx) => {
      const w = view.tokens.get(e.winnerId);
      if (!w?.visible) return;
      if (typeof fx.confetti === 'function') fx.confetti(w.root.position, { delay: 0.2, count: 160 });
      else fx.confettiAt?.(w.root.position, 0.2);
    });
    if (hasFx(view, 'fireworks')) b.effect(b.t + 0.4, (fx) => fx.fireworks(BANK_POS, { bursts: 7 }));
    b.beat('victory', b.t, { pid: e.winnerId, pos: b.tokenPos(e.winnerId) });
    b.react(b.t + 0.3, e.winnerId, 'victory');
  },

  // ---- auctions (CONTRACT §4.12) ----

  auction_started(b, e) {
    const { view, ctx } = b;
    const i = Number(e.tileIndex);
    b.shot(b.t, (d) => d.focus(i, { hold: true }));
    b.at(b.t, () => {
      view.overlay.callout('AUCTION!', 'gold', 1100, { sub: tileName(view, i) });
      view.overlay.setAuction(auctionInfo(view, ctx));
      view.board.flash(i, 1.2);
    });
    const data = { tile: i, participants: e.participants, pos: b.overTile(i, 0.3) };
    if (hasFx(view, 'gavel')) b.effect(b.t, (fx) => fx.gavel(gavelSpot(i), { strikes: 1, onStrike: () => b.fire('auctionStart', data) }));
    else b.beat('auctionStart', b.t, data);
    b.t += 0.5;
  },

  auction_bid(b, e) {
    const { view, ctx } = b;
    const pid = e.playerId;
    const i = auctionTile(ctx) ?? lastAuctionTile(b);
    b.at(b.t, () => {
      view.overlay.setAuction(auctionInfo(view, ctx, { playerId: pid, amount: e.amount }));
      view.overlay.pulseAuction(b.chip(pid));
    });
    b.beat('bid', b.t, { pid, amount: e.amount, tile: i, pos: i !== null ? b.overTile(i, 0.3) : b.tokenPos(pid) });
    b.float(b.t, pid, `Bids ${money(e.amount)}`, 'info', { chip: b.chip(pid) });
    b.t += 0.2;
  },

  auction_passed(b, e) {
    b.float(b.t, e.playerId, 'Pass', 'info', { chip: b.chip(e.playerId) });
    b.beat('auctionPass', b.t, { pid: e.playerId, pos: b.tokenPos(e.playerId) });
    b.t += 0.1;
  },

  auction_won(b, e) {
    const { view } = b;
    const i = Number(e.tileIndex);
    const pid = e.playerId;
    const data = { pid, tile: i, amount: e.amount, pos: b.overTile(i, 0.3) };
    const sold = () => {
      view.overlay.callout('SOLD!', 'gold', 1400, { sub: `${b.Name(pid)} · ${money(e.amount)}`, color: b.chip(pid) });
      view.overlay.float(b.overTile(i), `−${money(e.amount)}`, 'minus', { chip: b.chip(pid) });
      b.claimNow(i, 'ownerChange', { pid });
    };
    b.shot(b.t, (d) => d.focus(i));
    b.at(b.t, () => view.overlay.setAuction(null));
    if (hasFx(view, 'auctionSold')) {
      // "Going, going…" — two gavel strikes, then the SOLD stamp lands on the tile and it changes hands.
      b.effect(b.t, (fx) => fx.auctionSold(b.overTile(i, 0), {
        strikes: 2,
        onStrike: () => b.fire('gavel', { tile: i, pos: data.pos }),
        onStamp: () => { b.fire('sold', { ...data, sounds: BEAT_SOUND.stamp }); sold(); },
      }));
      b.money(b.t + SOLD_STAMP_AT, pid, null, e.amount);
      b.react(b.t + SOLD_STAMP_AT + 0.1, pid, 'celebrate');
      b.t += SOLD_STAMP_AT + 0.45;
    } else {
      b.at(b.t, () => { if (!view.animator.finishing) sold(); });
      b.beat('sold', b.t, data);
      b.react(b.t + 0.35, pid, 'celebrate');
      b.t += SOLD_BEAT;
    }
    b.focused = true;
  },

  auction_unsold(b, e) {
    const { view } = b;
    const i = Number(e.tileIndex);
    b.at(b.t, () => {
      view.overlay.setAuction(null);
      view.overlay.callout('No sale', 'total', 900);
    });
    b.beat('unsold', b.t, { tile: i, pos: b.overTile(i, 0.3) });
    b.focused = true;
    b.t += 0.4;
  },

  // ---- trades (CONTRACT §4.13) ----

  trade_proposed(b, e) {
    const { view } = b;
    const from = e.fromPlayerId;
    const to = e.toPlayerId;
    const tiles = tradeTiles(e);
    b.shot(b.t, (d) => d.frame(tradePoints(view, [from, to], tiles.map((x) => x.index))));
    b.at(b.t, () => view.overlay.setTrade(tradeChips(b, e)));
    b.float(b.t, from, `Offer → ${b.name(to)}`, 'info', { chip: b.chip(to) });
    // The offer's target hears ui.js's 'offer' chime instead (never both for the same thing).
    const sounds = to === b.ctx.me ? [] : undefined;
    b.beat('tradePropose', b.t, { pid: from, to, tradeId: e.tradeId, tiles: tiles.map((x) => x.index), pos: b.tokenPos(from), sounds });
    b.t += 0.4;
  },

  trade_accepted(b, e) {
    const { view } = b;
    const from = e.fromPlayerId;
    const to = e.toPlayerId;
    const tiles = tradeTiles(e);
    b.shot(b.t, (d) => d.frame(tradePoints(view, [from, to], tiles.map((x) => x.index))));
    b.at(b.t, () => {
      view.overlay.setTrade(null);
      view.overlay.callout('DEAL!', 'deal', 1200, { sub: `${b.Name(from)} ⇄ ${b.name(to)}` });
    });
    b.beat('tradeAccept', b.t, { pid: from, to, tradeId: e.tradeId, tiles: tiles.map((x) => x.index), pos: b.tokenPos(to) });
    // Tiles change owner one after another, each popping in its new owner's colour.
    tiles.forEach((x, n) => b.claim(b.t + 0.3 + n * SWAP_STAGGER, x.index, 'ownerChange', { pid: x.to, from: x.from }));
    b.react(b.t + 0.35, from, 'celebrate');
    b.react(b.t + 0.45, to, 'celebrate');
    if (hasFx(view, 'deeds')) {
      // The deeds (and cash / jail cards) change hands as cards flying between the two tokens.
      const fly = (at, a, z, cards) => b.effect(at, (fx) => {
        const A = view.tokens.worldPos(a);
        const Z = view.tokens.worldPos(z);
        if (A && Z && cards.length) fx.deeds(A, Z, cards, { onLand: () => b.fire('deedLand', { pid: z, pos: Z }) });
      });
      fly(b.t + 0.15, from, to, tradeCards(view, e.give));
      fly(b.t + 0.35, to, from, tradeCards(view, e.get));
    }
    // Cash (and jail cards) change hands; fees go to the bank.
    const give = e.give ?? {};
    const get = e.get ?? {};
    const cashAt = b.t + 0.25;
    if (give.cash > 0) {
      b.float(cashAt, from, `−${money(give.cash)}`, 'minus');
      b.float(cashAt + 0.15, to, `+${money(give.cash)}`, 'plus', { chip: b.chip(from) });
    }
    if (get.cash > 0) {
      b.float(cashAt + 0.3, to, `−${money(get.cash)}`, 'minus');
      b.float(cashAt + 0.45, from, `+${money(get.cash)}`, 'plus', { chip: b.chip(to) });
    }
    if (give.jailCards > 0) b.float(cashAt + 0.5, to, 'Get Out of Jail Free', 'gold');
    if (get.jailCards > 0) b.float(cashAt + 0.5, from, 'Get Out of Jail Free', 'gold');
    for (const [id, fee] of Object.entries(e.fees ?? {})) if (fee > 0 && b.ctx.byId.has(id)) b.float(cashAt + 0.7, id, `Fee −${money(fee)}`, 'minus');
    b.focused = true;
    b.lingerFor = Math.max(b.lingerFor, 0.9);
    b.t += TRADE_BEAT + tiles.length * SWAP_STAGGER;
  },

  trade_rejected(b, e) {
    const { view, ctx } = b;
    const by = e.byPlayerId;
    const trade = tradeOf(b, e.tradeId);
    const withdrawn = trade ? by === trade.fromPlayerId : false;
    b.at(b.t, () => view.overlay.setTrade(null));
    b.float(b.t, by, withdrawn ? 'Offer withdrawn' : 'No deal', 'info', { chip: ctx.colorOf.get(by) ?? null });
    b.beat('tradeReject', b.t, { pid: by, tradeId: e.tradeId, withdrawn, pos: b.tokenPos(by) });
    b.focused = true;
    b.t += 0.3;
  },

  trade_cancelled(b, e) {
    b.at(b.t, () => b.view.overlay.setTrade(null));
    b.beat('tradeCancel', b.t, { tradeId: e.tradeId, reason: e.reason });
    b.focused = true;
    b.t += 0.2;
  },
};

/** Does player `pid` still move later in this batch (after the cursor)? Reactions would fight the walk. */
function laterMove(b, pid) {
  const k = b.events.findIndex((e) => e.type === 'collected' && e.playerId === pid);
  return b.events.some((e, n) => n > k && e.type === 'moved' && e.playerId === pid);
}

/** Money between two players (rent, card payments, debts): both halves, over the payer's token. */
function money2(b, e, beatName, to, advance) {
  const pid = e.playerId;
  b.float(b.t, pid, `−${money(e.amount)}`, 'minus');
  // The receiver's half, next to the payer (the receiver is rarely in shot).
  if (to && b.ctx.byId.has(to)) b.float(b.t + 0.3, pid, `+${money(e.amount)} → ${b.name(to)}`, 'plus', { chip: b.chip(to) }, 1.5);
  b.beat(beatName, b.t, { pid, to: to ?? null, amount: e.amount, reason: e.reason, tile: Number.isInteger(e.tileIndex) ? e.tileIndex : null, pos: b.tokenPos(pid) });
  b.money(b.t + 0.1, pid, to && b.ctx.byId.has(to) ? to : null, e.amount);
  if (beatName === 'rent') {
    const tile = Number(e.tileIndex);
    if (Number.isInteger(tile)) b.cityFx(b.t + 0.2, (city) => city.pulse?.(tile)); // the owner's buildings bounce
    b.react(b.t + 0.05, pid, 'sad');
    if (to && b.ctx.byId.has(to)) b.react(b.t + 0.3, to, 'celebrate');
  }
  b.t += advance;
}

/** dice.schedule's result → { dur, rest, contacts } (animation s from the throw). */
function diceTiming(res) {
  const dur = typeof res === 'number' ? res : Number(res?.duration) || 1.1;
  const rest = Number.isFinite(res?.restAt) ? res.restAt : Math.max(0.3, dur - 0.1);
  // dice.js: the dice first touch down at 40% of the throw, bounce at 70% and 88%.
  const contacts = Array.isArray(res?.contacts) ? res.contacts.filter(Number.isFinite) : [0.4, 0.7, 0.88].map((f) => f * rest);
  return { dur, rest, contacts };
}

/** Does the Fx have effect `name` (fx.js grows; older layers lack some)? */
function hasFx(view, name) {
  return typeof view.fx?.[name] === 'function';
}

/** Where the auction gavel strikes: beside tile i, toward the board centre. */
function gavelSpot(i) {
  const c = tileCenter(i);
  const o = outward(i);
  return new THREE.Vector3(c.x - o.x * 0.55, 0, c.z - o.z * 0.55);
}

/** Deed cards for one side of a trade (fx.deeds): tiles, cash, jail cards. */
function tradeCards(view, side) {
  const cards = [];
  for (const i of side?.tiles ?? []) {
    const t = view.BOARD?.tiles?.[i];
    if (!t) continue;
    const kind = t.type === 'property' ? 'street' : t.type;
    cards.push({ name: String(t.name ?? ''), color: t.type === 'property' ? view.BOARD.groups?.[t.group]?.color : undefined, kind });
  }
  if (side?.cash > 0) cards.push({ name: `$${side.cash}`, kind: 'cash', amount: side.cash });
  for (let k = 0; k < (side?.jailCards ?? 0); k++) cards.push({ name: 'Get Out of Jail Free', kind: 'jail' });
  return cards;
}

/** A tokens.js callback's sound suggestion ({ name, rate, volume } | null) → beat sounds. */
function suggested(info) {
  const s = info?.sound;
  return s?.name ? [[s.name, { rate: Number(s.rate) || 1, volume: Number(s.volume) || 1 }]] : [];
}

/**
 * The landing sound for a token's walk: its personality's (the dog barks, the cat purrs, the car
 * toots — over a softer thud), else the plain 'land'. null = the beat's default.
 */
function personaLand(view, tokenId, kind) {
  if (kind !== 'hop' && kind !== 'zip') return null;
  const s = TOKENS.PERSONALITIES?.[tokenId]?.sounds?.land;
  if (!Array.isArray(s) || !s[0]) return null;
  const own = [s[0], { rate: Number(s[1]) || 1, volume: Number(s[2]) || 1 }];
  return s[0] === 'land' ? [own] : [['land', { volume: 0.55 }], own];
}

/** Touchdown times of a hop walk (tokens.scheduleMove's `hopTimes` when given, else evenly spread). */
function hopTimes(r, start) {
  if (Array.isArray(r.hopTimes) && r.hopTimes.length) return r.hopTimes.filter(Number.isFinite);
  const n = Math.max(0, Number(r.hops) || 0);
  const dur = Number(r.duration) || 0;
  return Array.from({ length: n }, (_, k) => start + ((k + 1) * dur) / n);
}

/**
 * A completed colour set is being celebrated by the city (city.onCelebrate, ~1 s after the claim
 * that completed it): the 'monopoly' beat — its chime and cheer, a "MONOPOLY!" callout in the
 * owner's colour — and its listeners. Silent while skipping or at the "instant" speed (view.sound).
 */
export function celebrateSet(view, group) {
  try {
    if (view.animator.finishing) return;
    const ctx = view.latest;
    const g = view.BOARD?.groups?.[group];
    if (!ctx || !g || ctx.state.status === 'finished') return; // the winner's moment takes over
    const tiles = (view.BOARD.tiles ?? []).filter((t) => t?.group === group).map((t) => t.index);
    const owner = ctx.tileState.get(tiles[0])?.ownerId ?? null;
    const who = owner && ctx.byId.has(owner) ? (owner === ctx.me ? 'You' : view.info.name(ctx, owner)) : null;
    view.overlay.callout('MONOPOLY!', 'gold', 1600, { sub: who ? `${who} · ${g.name}` : g.name, color: owner ? ctx.colorOf.get(owner) ?? g.color : g.color });
    const c = tiles.length ? tiles.map(tileCenter).reduce((a, p) => ({ x: a.x + p.x / tiles.length, z: a.z + p.z / tiles.length }), { x: 0, z: 0 }) : null;
    const data = { pid: owner, group, tiles, pos: c ? new THREE.Vector3(c.x, 0.5, c.z) : null };
    // A second set right after the first (a bankrupt's estate): its chime, but one cheer is enough.
    // "Right after" on both clocks, like view.sound's duplicate guard (the timeline may run faster).
    const now = [performance.now(), view.animator.time];
    const last = view.lastMonopolyAt ?? [-1e9, -1e9];
    if (now[0] - last[0] < MONOPOLY_CHEER_GAP_MS && now[1] - last[1] < MONOPOLY_CHEER_GAP_MS / 1000) data.sounds = BEAT_SOUND.monopoly.slice(0, 1);
    view.lastMonopolyAt = now;
    playBeatSound(view, 'monopoly', data);
    runListeners('monopoly', { ...data, name: 'monopoly', view, ctx, batch: view.running });
    view.beatLog?.push({ name: 'monopoly', t: performance.now(), at: view.animator.time, batch: view.running, pid: owner, tile: null });
  } catch (err) {
    console.error('[renderer3d] monopoly celebration failed:', err);
  }
}

/** Rough length (animation s) of a batch before its settle step (busyUntil while it waits in the queue). */
export function estimate(events) {
  let s = 0.1;
  for (const e of events) {
    switch (e?.type) {
      case 'dice_rolled': s += e.purpose === 'utility' ? 1.1 : 1.0 - WALK_EARLY; break;
      case 'moved': {
        const n = Number.isInteger(e.steps) ? Math.abs(e.steps) : 0;
        const walk = Math.min(Math.max(2.2, 0.16 * n), 0.22 * n); // tokens.js hop timing
        s += e.via === 'roll' || (e.via === 'card' && n <= 6) ? walk : e.via === 'card' && n > 6 ? 1.4 : 0.9;
        break;
      }
      case 'landed': s += LAND_BEAT; break;
      case 'card_drawn': s += CARD_BEAT; break;
      case 'bought': s += 0.5; break;
      case 'built': case 'sold_house': s += PUSH_IN + 0.3; break;
      case 'mortgaged': case 'unmortgaged': s += PUSH_IN + 0.25; break;
      case 'bankrupt': s += 1.4; break;
      case 'auction_started': s += 0.5; break;
      case 'auction_won': s += SOLD_BEAT; break;
      case 'trade_accepted': s += TRADE_BEAT + 0.3; break;
      default: s += 0.1; break;
    }
  }
  return s;
}

/** The one sound for a batch that isn't animated ("instant" speed / reduced motion), or null. */
export function summaryBeat(events) {
  const types = new Set((events ?? []).map((e) => e?.type));
  for (const [type, name] of SUMMARY) {
    if (!types.has(type)) continue;
    if (type === 'built' && events.some((e) => e?.type === 'built' && Number(e.houses) === 5)) return 'hotel';
    return name;
  }
  return null;
}

/** Plays a named beat's default sound right now (no timeline; used for the "instant" summary). */
export function playBeatNow(view, name, data = {}) {
  playBeatSound(view, name, data);
}

/** Applies the state with no animation (first sight, hidden tab, reduced motion, "instant"). */
export function snapTo(view, ctx, { resetCamera = false, snapCamera = false, events = [] } = {}) {
  const { dice, director, overlay } = view;
  director.setSeat(seatYaw(ctx));
  settle(view, ctx, { animate: false });
  const roll = asRoll(ctx.turn.lastRoll);
  if (roll && (resetCamera || dice.values.join() !== roll.join())) dice.rest(roll, (Number(ctx.state.seq) || 1) * 31);
  overlay.setTurn(view.info.turn(ctx), false);
  // Cards still need reading when nothing animates (reduced motion, hidden tab): show the last one.
  const card = events.filter((e) => e?.type === 'card_drawn').at(-1);
  if (card) overlay.showCard({ deck: card.deck, who: card.playerId === ctx.me ? 'You' : view.info.name(ctx, card.playerId), text: String(card.text ?? '') });
  if (resetCamera || !director.suspended) aimCamera(view, ctx, { snap: resetCamera || snapCamera, force: resetCamera });
}

/** Points the director at what matters now: a pending purchase / auction, a trade, else the overview. */
export function aimCamera(view, ctx, { snap = false, force = false } = {}) {
  const d = view.director;
  d.setSeat(seatYaw(ctx));
  const hold = pendingTile(ctx) ?? auctionTile(ctx);
  const trade = ctx.state.trade;
  if (hold !== null) d.focus(hold, { hold: true });
  else if (trade && ctx.active) {
    const tiles = [...(trade.give?.tiles ?? []), ...(trade.get?.tiles ?? [])];
    d.frame(tradePoints(view, [trade.fromPlayerId, trade.toPlayerId], tiles));
  } else d.overview(activePos(view, ctx));
  if (snap) d.snap({ force });
}

/** Reconciles tokens, board pieces, the city, highlights, banners, labels and the log with ctx. */
export function settle(view, ctx, { animate }) {
  const { tokens, board, overlay } = view;
  tokens.sync(ctx, { animate, place: true });
  board.sync(ctx, animate);
  view.city.sync(ctx, animate);
  board.setPending(pendingTile(ctx) ?? auctionTile(ctx));
  tokens.setCurrent(ctx.active ? ctx.currentId : null);
  overlay.setWinner(view.info.winner(ctx));
  overlay.setTurn(view.info.turn(ctx), false);
  overlay.setAuction(auctionInfo(view, ctx));
  overlay.setTrade(ctx.state.trade && ctx.active ? tradeChips({ chip: (id) => ctx.colorOf.get(id) ?? null }, ctx.state.trade) : null);
  if (ctx.state.trade) view.lastTrade = ctx.state.trade; // trade_rejected only names the trade
  // Pins sit just over the token's head (tokens.headPos follows hops and the display scale).
  if (typeof tokens.headPos === 'function') overlay.setPins(pinList(view, ctx), (id, out) => tokens.headPos(id, out), { lift: 0.12 });
  else overlay.setPins(pinList(view, ctx), (id, out) => tokens.worldPos(id, out));
  const lines = ctx.live && Array.isArray(ctx.state.log) ? ctx.state.log.slice(-4).map(String) : [];
  const pot = ctx.state.settings?.freeParkingPot ? ` · Free Parking pot ${money(ctx.state.pot)}` : '';
  overlay.setLog(lines, `Game log${pot}`);
}

function syncOne(view, ctx, i, animate) {
  const ts = ctx.tileState.get(i);
  const owner = ts?.ownerId && ctx.byId.has(ts.ownerId) ? ts.ownerId : null;
  view.board.syncTile(i, {
    owner,
    color: owner ? ctx.colorOf.get(owner) : null,
    mortgaged: !!ts?.mortgaged,
    houses: Number(ts?.houses) || 0,
  }, animate);
}

/** Ownable tiles whose owner on the board differs from ctx (a bankruptcy's transfers). */
function changedTiles(view, ctx) {
  const out = [];
  for (const i of view.board.ownable ?? []) {
    const ts = ctx.tileState.get(i);
    const owner = ts?.ownerId && ctx.byId.has(ts.ownerId) ? ts.ownerId : null;
    const vis = view.board.inspect?.(i);
    if (vis && vis.owner !== owner) out.push(i);
  }
  return out;
}

function pendingTile(ctx) {
  const i = ctx.active && ctx.turn.phase === 'buying_or_auction' ? ctx.turn.pendingPurchase : null;
  return Number.isInteger(i) ? i : null;
}

function auctionTile(ctx) {
  const i = ctx.active && ctx.state.auction ? ctx.state.auction.tileIndex : null;
  return Number.isInteger(i) ? i : null;
}

/** The auctioned tile of this batch's events (the state's auction is already over at auction_won). */
function lastAuctionTile(b) {
  const s = b.events.find((e) => e.type === 'auction_started' || e.type === 'auction_won' || e.type === 'auction_unsold');
  return s && Number.isInteger(s.tileIndex) ? s.tileIndex : null;
}

function tileName(view, i) {
  return String(view.BOARD?.tiles?.[i]?.name ?? '');
}

/** The auction tag's content from ctx (optionally with a bid that just landed), or null. */
function auctionInfo(view, ctx, bid = null) {
  const a = ctx.active ? ctx.state.auction : null;
  if (!a || !Number.isInteger(a.tileIndex)) return null;
  const highBid = bid ? Number(bid.amount) || 0 : Number(a.highBid) || 0;
  const bidder = bid ? bid.playerId : a.highBidderId;
  const c = tileCenter(a.tileIndex);
  return {
    tileIndex: a.tileIndex,
    pos: new THREE.Vector3(c.x, 0, c.z),
    name: tileName(view, a.tileIndex),
    highBid,
    bidder: bidder && ctx.byId.has(bidder) ? (bidder === ctx.me ? 'You' : view.info.name(ctx, bidder)) : null,
    color: bidder ? ctx.colorOf.get(bidder) ?? null : null,
  };
}

/** Tiles of a trade: [{ index, from, to }] (give: proposer → target, get: target → proposer). */
function tradeTiles(t) {
  const out = [];
  for (const i of t?.give?.tiles ?? []) if (Number.isInteger(i)) out.push({ index: i, from: t.fromPlayerId, to: t.toPlayerId });
  for (const i of t?.get?.tiles ?? []) if (Number.isInteger(i)) out.push({ index: i, from: t.toPlayerId, to: t.fromPlayerId });
  return out;
}

/** Chips over a pending trade's tiles, coloured for whoever would receive each. */
function tradeChips(b, t) {
  const tiles = tradeTiles(t).map((x) => {
    const c = tileCenter(x.index);
    return { index: x.index, pos: new THREE.Vector3(c.x, 0, c.z), color: b.chip(x.to) ?? '#999' };
  });
  return tiles.length ? { tiles } : null;
}

/** World points to frame for a trade: both tokens and the tiles involved. */
function tradePoints(view, ids, tiles) {
  const pts = [];
  for (const id of ids) {
    const p = view.tokens.worldPos(id);
    if (p) pts.push({ x: p.x, z: p.z });
  }
  for (const i of tiles) if (Number.isInteger(i)) pts.push(tileCenter(i));
  return pts;
}

/**
 * The trade a batch answers ({ fromPlayerId, toPlayerId, … }): proposed in the same batch, or the
 * one the previous state showed (the state's own trade is already gone once it was answered).
 */
function tradeOf(b, tradeId) {
  const p = b.events.find((e) => e.type === 'trade_proposed' && e.tradeId === tradeId);
  if (p) return p;
  const t = b.view.lastTrade;
  return t && t.id === tradeId ? t : null;
}

/** Pins over the tokens (overview readability): every token on the board. */
function pinList(view, ctx) {
  const emoji = (tokenId) => view.BOARD?.tokens?.find((t) => t.id === tokenId)?.emoji ?? '●';
  if (!ctx.live) return [];
  return ctx.players
    .filter((p) => !p.bankrupt)
    .map((p) => ({ id: p.id, color: ctx.colorOf.get(p.id), emoji: emoji(p.token), current: ctx.active && p.id === ctx.currentId }));
}

/**
 * The viewer's side of the table. Everyone views from the GO side, as on a screen game — seating
 * players around the table by join order showed the board sideways or upside down to players 2–4.
 * Set SEAT_BY_JOIN_ORDER to bring the physical-table seating back.
 */
const SEAT_BY_JOIN_ORDER = false;
export function seatYaw(ctx) {
  if (!SEAT_BY_JOIN_ORDER) return SIDE_YAW.bottom;
  const k = ctx.players.findIndex((p) => p.id === ctx.me);
  return SIDE_YAW[SEATS[k < 0 ? 0 : k % SEATS.length]] ?? 0;
}

/** World {x, z} of the active (or winning) player's token, for the overview's lean. */
function activePos(view, ctx) {
  const id = ctx.currentId ?? ctx.state.winnerId;
  const p = view.tokens.worldPos(id);
  if (p) return p;
  const pl = ctx.byId.get(id);
  return Number.isInteger(pl?.position) ? tileCenter(pl.position) : null;
}

export function asRoll(v) {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [a, b] = v.map(Number);
  return a >= 1 && a <= 6 && b >= 1 && b <= 6 ? [a, b] : null;
}
