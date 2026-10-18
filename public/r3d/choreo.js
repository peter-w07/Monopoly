// public/r3d/choreo.js — turns one batch of engine events (CONTRACT §6) into a timeline on the
// shared Animator: the life-size city version (city design §8.2, §10).
//
// Rules:
//   * State is the truth. Every batch ends in a settle step that converges characters, lots,
//     landmarks, the overlay and the city clock on the batch's state, so a skip (finishAll) lands
//     on the truth.
//   * Relevance (pacing.js): the viewer's own (HIGH) events play the full scene; another player's
//     notable (MED) events and LOW big scenes the own scene × 0.7; routine LOW events a compressed
//     helicopter-only version ("short", the default of the city menu's `others` option). `full`
//     plays everything as own; `instant` snaps batches without a HIGH event.
//   * Moves (§8.2): route ribbon + chip at dice rest − 0.25, the character's real launch, then by
//     distance a tracking dolly (≤ 60 m), a pull-out over the time-lapsing city with ONE cut to the
//     kerb at T − arrive (≤ 400 m), or the helicopter (card advances); the counting ritual (bays
//     flash, HUD step counter, a tick per address); passed_go at goAt; J-cut audio.
//   * At most one cut per move, never two cuts within 1.0 s (the director enforces the gap).
//   * Nothing here blocks the UI: ui.js keeps its buttons live the whole time.
//
// Named beats — the hook points (onBeat(name, fn), '*' = all). Every moment worth a sound or an
// effect is a beat, fired once at its time on the timeline, never while skipping:
//   gameStart turnStart wake diceShake diceThrow diceBounce diceSettle doubles routeShow walkStart
//   stepTick lapseStart kerbCut lapseEnd land teleport cut passGo goBurst cardDraw cardFlip kiosk
//   chestLid jailCard siren tow barrier gate jailIn jailOut jailStay buy stamp flagUp ribbon rent
//   doorman windows tax pay income coin build floor crane collapse topOut firework hotel demolish
//   mortgage unmortgage ownerChange board crowd auctionStart bid auctionPass gavel sold unsold
//   tradePropose tradeAccept tradeReject tradeCancel potBurst rewind letterboxIn letterboxOut
//   bankrupt victory monopoly
// Each plays its default sound(s) (BEAT_SOUND, via view.sound → sfx.play; place-tied sounds carry
// their world position, score sounds don't) and then the onBeat listeners.

import * as THREE from './three.js';
import { address, pointAt, sOf, wrap, LOOP } from './city-layout.js';
import { shotTier } from './travel.js';
import {
  BUDGET, relevance, dur, versionOf, movePlan, buildGroups, housesTime, mortgageTime, completesSet,
  batchAnimates, maxRel, SETTLE_PAD, estimate as paceEstimate,
} from './pacing.js';
import { HOOD, placeOf } from './info.js';

// ---- tuning knobs (animation seconds; the speed setting scales them all) ------------------------
const CARD_HOLD = 1.2; // the 3D card hangs in front of the camera…
const CARD_IN = 0.76; // …after hopping off its kiosk and flying up (cards.js: 0.14 + 0.46 + 0.16)
const DIVE = 0.7; // turn start: helicopter → ready
const READY_GLIDE = 0.5;
const PULL_OUT = 0.35; // × T: the scripted pull-out to the transit frame
const JCUT = 0.15; // the arrival's ambience leads the picture by this much
const MONOPOLY_CHEER_GAP_MS = 2500;
export const CATCH_UP = 1.5; // states queued behind the running batch: everything plays 1.5× faster…
export const CATCH_UP_MAX = 2.25; // …2.25× when three or more are waiting
export const MAX_QUEUE = 4; // beyond this many waiting states the oldest land at once
export { paceEstimate as estimate };

// ---- sounds -------------------------------------------------------------------------------------------
// Default sound(s) of each beat: [sfx name, options]. `delay` is real seconds. Names sfx.js doesn't
// have (yet) fall back in renderer3d's view.sound, or stay silent.
export const BEAT_SOUND = {
  gameStart: [['cheer', { volume: 0.45 }]],
  wake: [['engineStart', { volume: 0.55 }]],
  diceShake: [['diceShake', { volume: 0.75 }]],
  diceThrow: [['diceThrow']],
  diceBounce: [['diceBounce']],
  diceSettle: [['diceSettle']],
  doubles: [['doubles'], ['crowdOoh', { volume: 0.5, delay: 0.1 }]],
  routeShow: [['tick', { volume: 0.3, rate: 1.5 }]],
  stepTick: [['stepTick', { volume: 0.15 }]],
  lapseStart: [['timelapseRise', { volume: 0.7 }]],
  lapseEnd: [['timelapseLand', { volume: 0.7 }]],
  kerbCut: [['whoosh', { volume: 0.45 }]],
  cut: [['whoosh', { volume: 0.45 }]],
  land: [['land', { volume: 0.6 }]],
  teleport: [['whoosh']],
  passGo: [['passGo']],
  goBurst: [['confettiPop', { volume: 0.8 }]],
  cardDraw: [['cardDraw']],
  cardFlip: [['cardFlip']],
  kiosk: [['splitFlap', { volume: 0.6 }]],
  chestLid: [['doorSlam', { volume: 0.4, rate: 1.4 }]],
  jailCard: [['cardFlip', { volume: 0.6 }]],
  siren: [['siren', { volume: 0.8 }]],
  tow: [['brakeSqueal', { volume: 0.7 }]],
  barrier: [['barrierArm']],
  gate: [['gateSlide', { volume: 0.8 }]],
  jailIn: [['jailSlam']],
  jailOut: [['jailFree']],
  jailStay: [['jailSlam', { volume: 0.35, rate: 1.3 }]],
  buy: [['cashRegister']],
  stamp: [['stamp']],
  flagUp: [['chainFence', { volume: 0.35, rate: 1.3 }]],
  ribbon: [['ribbonSnip'], ['confettiPop', { delay: 0.05 }]],
  rent: [['rent']],
  doorman: [['doormanBell', { volume: 0.7 }]],
  tax: [['tax']],
  pay: [['coins', { volume: 0.8 }]],
  income: [['coins']],
  coin: [['coin', { volume: 0.3 }]],
  build: [['build']],
  floor: [['hammer', { volume: 0.35 }]],
  crane: [['craneBeep', { volume: 0.5 }]],
  collapse: [['demolishRumble', { volume: 0.7 }]],
  topOut: [['hotel']],
  firework: [['firework', { volume: 0.8 }]],
  hotel: [['hotel']],
  demolish: [['demolish']],
  mortgage: [['stamp']],
  unmortgage: [['unstamp']],
  board: [['splitFlap']],
  crowd: [['applause', { volume: 0.7 }]],
  auctionStart: [['gavel']],
  bid: [['bid']],
  sold: [['gavel'], ['sold', { delay: 0.15 }]],
  gavel: [['gavel']],
  unsold: [['auctionEnd'], ['crowdAww', { volume: 0.6 }]],
  deedLand: [['cardFlip', { volume: 0.45, rate: 1.15 }]],
  tradePropose: [['tradePropose']],
  tradeAccept: [['tradeAccept']],
  tradeReject: [['tradeReject']],
  tradeCancel: [['tradeReject', { volume: 0.5 }]],
  potBurst: [['coins'], ['coinsIn', { delay: 0.2 }]],
  rewind: [['reverseBeep', { volume: 0.6 }]],
  bankrupt: [['bankrupt']],
  victory: [['victory'], ['cheer', { delay: 0.6, volume: 0.8 }]],
  monopoly: [['setComplete'], ['cheer', { delay: 0.35, volume: 0.7 }]],
};
// Ritual cue → beat (lots / landmarks rituals return { duration, cues: [{ name, at }] }).
const CUE_BEAT = {
  stamp: 'stamp', flagUp: 'flagUp', ribbon: 'ribbon', floor: 'floor', crane: 'crane', reveal: 'build',
  collapse: 'collapse', topOut: 'topOut', firework: 'firework', doorman: 'doorman', windows: 'windows',
  unstamp: 'unmortgage', board: 'board', gate: 'gate', barrier: 'barrier', slam: 'jailIn', burst: 'goBurst',
  lid: 'chestLid', neon: 'kiosk', geyser: 'potBurst', coins: 'coin',
};
// When nothing animates (instant, reduced motion) a batch gets at most one sound: the most
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
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// ---- beat listeners ---------------------------------------------------------------------------------
const listeners = new Map();

/** Registers `fn(payload)` for a named beat ('*' = every beat). Returns an unsubscribe function. */
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

/** Plays a beat's sounds now (with the world position of what makes the noise). */
function playBeatSound(view, name, data) {
  if (data.silent || !view.sound) return;
  const list = data.sounds ?? BEAT_SOUND[name];
  if (!list?.length) return;
  const p = resolvePos(data.pos);
  const pan = panOf(view, p);
  const pos = p ? { x: p.x, y: p.y ?? 0, z: p.z } : undefined;
  for (const [snd, opts] of list) view.sound(snd, { pan, pos, ...opts, ...(data.soundOpts ?? {}) });
}

function resolvePos(pos) {
  try {
    const p = typeof pos === 'function' ? pos() : pos;
    return p && Number.isFinite(p.x) && Number.isFinite(p.z) ? p : null;
  } catch {
    return null;
  }
}

const panVec = new THREE.Vector3();
function panOf(view, p) {
  try {
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
 * @param {object} view renderer3d's view (animator, director, overlay, chars, lots, landmarks, life,
 *   ground, hudDice, cards, fx, audio, clock, BOARD, info, sound, opts)
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
    this.diceEnd = 0;
    this.walkAt = null;
    this.diceBy = null; // who threw the dice of this batch
    this.moved = false;
    this.street = false; // the camera went down to street level: crane back up at the end
    this.lingerFor = BUDGET.linger.own;
    this.goAt = new Map(); // playerId → time the current walk crosses GO
    this.landTile = new Map(); // playerId → the tile they landed on in this batch
    this.types = new Set(this.events.map((e) => e.type));
    this.others = view.opts?.others ?? 'short';
    this.relCtx = { ...ctx, BOARD: view.BOARD, lastTrade: view.lastTrade };
    this.rels = this.events.map((e) => relevance(e, this.relCtx));
    this.handled = new Set(); // batched events (builds, mortgages) already laid out
  }

  get current() {
    return this.view.batchSeq === this.id;
  }

  /** Version of event k: 'own' | 'med' | 'others'. */
  ver(k) {
    return versionOf(this.rels[k], this.others);
  }

  d(name, k) {
    return dur(name, this.rels[k], this.others);
  }

  /** May event k move the camera off the helicopter (not for compressed LOW events)? */
  cam(k) {
    const d = this.view.director;
    return d.auto && d.style !== 'free' && this.ver(k) !== 'others';
  }

  get cinematic() {
    const d = this.view.director;
    return d.style === 'cinematic' && d.auto && !d.instant;
  }

  // ---- scheduling helpers ----

  at(time, fn) {
    return this.view.animator.at(Math.max(0, time), fn);
  }

  /** `fn` at `time`, skipped while skipping (transient effects: floats, flights, flashes). */
  soft(time, fn) {
    const { view } = this;
    return this.at(time, () => {
      if (view.animator.finishing) return;
      try {
        fn();
      } catch (err) {
        console.error('[renderer3d] effect failed:', err);
      }
    });
  }

  beat(name, time, data = {}) {
    this.at(time, () => this.fire(name, data));
  }

  /** Fires the named beat now: its sound(s), then onBeat listeners. Nothing while skipping. */
  fire(name, data = {}) {
    const { view } = this;
    if (view.animator.finishing) return;
    playBeatSound(view, name, data);
    const pos = resolvePos(data.pos);
    runListeners(name, { ...data, pos, name, view, ctx: this.ctx, batch: this.id });
    view.beatLog?.push({ name, t: performance.now(), at: view.animator.time, batch: this.id, pid: data.pid ?? null, tile: data.tile ?? null });
  }

  /** The cues of a ritual (started at `time`) as beats. */
  cues(time, ritual, data = {}, { only = null, skip = null } = {}) {
    for (const c of Array.isArray(ritual?.cues) ? ritual.cues : []) {
      const name = CUE_BEAT[c?.name] ?? c?.name;
      if (!name || !Number.isFinite(c.at)) continue;
      if (only && !only.includes(name)) continue;
      if (skip && skip.includes(name)) continue;
      this.beat(name, time + c.at, data);
    }
    return Number(ritual?.duration) || 0;
  }

  /** An fx.js effect at `time` (not while skipping). */
  effect(time, fn) {
    const { view } = this;
    this.soft(time, () => { if (view.fx) fn(view.fx); });
  }

  /** Camera call at `time` (only while this batch is the current one). */
  shot(time, fn) {
    this.at(time, () => { if (this.current && !this.view.animator.finishing) fn(this.view.director); });
  }

  /** A cut at `time` (the director glides instead when a cut isn't allowed); whoosh unless silent. */
  cutTo(time, setup, { silent = false, beat = 'cut' } = {}) {
    this.at(time, () => {
      if (!this.current || this.view.animator.finishing) return;
      const d = this.view.director;
      setup(d);
      if (d.cut() && !silent) this.fire(beat, {});
    });
  }

  letterbox(time, on) {
    this.soft(time, () => {
      this.view.letterboxOn = on;
      this.view.overlay.letterbox(on);
    });
    this.beat(on ? 'letterboxIn' : 'letterboxOut', time, {});
  }

  /** A character reaction at `time` (chars.react: celebrate, sad, jail, goJump, bankrupt, victory, wake). */
  react(time, pid, kind, opts = {}) {
    if (!pid) return 0;
    return Number(this.view.chars.react(pid, kind, { ...opts, delay: Math.max(0, time) })) || 0;
  }

  charPos(id) {
    return this.view.chars.worldPos(id) ?? null;
  }

  /** A point over a character's head (pins / floats), or null. */
  head(id, dy = 0.5) {
    const p = this.view.chars.headPos(id) ?? this.view.chars.worldPos(id);
    return p ? new THREE.Vector3(p.x, (p.y ?? 0) + dy, p.z) : null;
  }

  /** The lot's forecourt (crowds, floats over a lot) at height dy. */
  lotFront(i, dy = 0) {
    const a = address(i);
    return new THREE.Vector3(a.lot.front.x + a.out.x * 4, dy, a.lot.front.z + a.out.z * 4);
  }

  /** Where a float over lot i goes: above the building. */
  overLot(i) {
    const an = this.view.lots.anchor(i);
    if (an?.top && Number.isFinite(an.top.x)) return new THREE.Vector3(an.top.x, (an.top.y ?? 10) + 3, an.top.z);
    const a = address(i);
    const h = this.view.heightOf(this.view.BOARD?.tiles?.[i]?.group, num(this.ctx.tileState.get(i)?.houses)) ?? 12;
    return new THREE.Vector3(a.lot.cx, h + 4, a.lot.cz);
  }

  float(time, id, text, kind, opts) {
    this.at(time, () => this.view.overlay.float(this.head(id), text, kind, opts));
  }

  floatTile(time, i, text, kind, opts) {
    this.at(time, () => this.view.overlay.float(this.overLot(i), text, kind, opts));
  }

  /** HUD coins / notes between players' pins or the bank (overlay.moneyFlight). */
  money(time, from, to, amount) {
    if (!(Math.abs(num(amount)) > 0)) return;
    const ok = (id) => (id && this.ctx.byId.has(id) ? id : 'bank');
    this.soft(time, () => this.view.overlay.moneyFlight(ok(from), ok(to), Math.abs(num(amount)), { delay: 0 }));
  }

  /** A crowd rushing to `pos` (life.crowd.rush): own scenes only, never while skipping. */
  crowd(time, pos, n, opts = {}) {
    if (!pos) return;
    this.soft(time, () => this.view.life.crowd.rush(pos, n, { delay: 0, ...opts }));
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

  charAt(id) {
    return () => this.charPos(id);
  }

  tile(i) {
    return this.view.BOARD?.tiles?.[i] ?? null;
  }

  /** The tile a player's character stands on now (or will, after this batch's moves so far). */
  spotOf(pid) {
    if (this.landTile.has(pid)) return this.landTile.get(pid);
    const s = this.view.chars.get(pid)?.spot?.index;
    if (Number.isInteger(s)) return s;
    const p = this.ctx.byId.get(pid)?.position;
    return Number.isInteger(p) ? p : null;
  }

  // ---- the timeline ----

  play() {
    const { view, ctx } = this;
    const { chars, overlay } = view;
    if (view.director.mode === 'orbit' && ctx.state.status !== 'finished') view.director.heli(activePos(view, ctx));

    // New players' characters appear in place (lined up at GO at game start); walkers keep their position.
    const leaving = new Set(this.events.filter((e) => e.type === 'bankrupt').map((e) => e.playerId));
    chars.sync(ctx, { animate: true, place: false, popNew: this.types.has('game_started'), keep: leaving });
    if (!this.types.has('turn_started')) overlay.setTurn(view.info.turn(ctx), false);

    this.events.forEach((e, k) => {
      const handler = ON[e.type];
      if (!handler || this.handled.has(k)) return;
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
    const end = Math.max(this.t, this.diceEnd) + SETTLE_PAD;
    view.settleItem = this.at(end, () => {
      const latest = view.latest && view.latest.state?.seq === ctx.state?.seq ? view.latest : ctx;
      settle(view, latest, { animate: !view.queue?.[0]?.before });
      if (view.running === this.id) view.running = null;
      view.onBatchDone?.();
    });
    const hold = holdTile(view, ctx);
    const offer = !!ctx.state.trade && this.types.has('trade_proposed');
    if (!this.events.length) {
      this.shot(0, () => aimCamera(view, ctx));
    } else if (hold !== null) {
      this.shot(end, (d) => d.kerb(hold, { hold: true, glide: d.mode === 'kerb' && d.kerbTile === hold ? 0 : 0.6 }));
    } else if (!offer && this.street && !this.types.has('turn_started') && !this.types.has('game_over')) {
      // The landing lingers at the kerb, then the camera cranes back up to the helicopter.
      this.shot(end + (this.moved ? this.lingerFor : this.lingerFor * 0.6), (d) => {
        if (d.mode !== 'orbit' && d.mode !== 'heli') d.heli(activePos(view, ctx), { glide: BUDGET.craneUp.own });
      });
    } else if (!offer && !this.types.has('turn_started') && !this.types.has('game_over') && view.director.mode === 'map' && !view.director.userMap) {
      this.shot(end + 0.4, (d) => d.heli(activePos(view, ctx), { glide: 0.45 }));
    }
  }
}

// ---- event handlers (one per CONTRACT §6 event type) ------------------------------------------------

const ON = {
  game_started(b, e) {
    const { view, ctx } = b;
    const calm = view.director.style !== 'cinematic';
    const T = calm ? BUDGET.introCalm.own : BUDGET.intro.own;
    const t0 = b.t;
    b.letterbox(t0, true);
    b.beat('gameStart', t0 + 0.1, {});
    // Dawn → morning time-lapse over the intro.
    b.soft(t0, () => {
      view.stage.setDayPhase(-0.3, { instant: true });
      view.stage.setDayPhase(view.dayTarget?.(ctx) ?? 0.1, { duration: 4 });
    });
    if (b.cinematic) b.shot(t0, (d) => d.establish('intro', { seconds: T }));
    else b.shot(t0, (d) => d.heli(null, { glide: 1.2 }));
    // The characters, lined up at GO, show off one after another.
    const order = Array.isArray(e.order) ? e.order : ctx.players.map((p) => p.id);
    order.forEach((pid, n) => b.react(t0 + T * 0.55 + n * 0.25, pid, 'celebrate'));
    const first = order[0];
    if (first && ctx.byId.has(first)) {
      b.soft(t0 + T * 0.78, () => view.overlay.callout(`${b.Name(first)} ${first === ctx.me ? 'go' : 'goes'} first`, 'gold', 1400, { color: b.chip(first) }));
    }
    b.letterbox(t0 + T - 0.1, false);
    b.t += T;
    b.street = false;
  },

  turn_started(b, e, k) {
    const { view, ctx } = b;
    const pid = e.playerId;
    const own = b.ver(k) === 'own';
    const t0 = b.t;
    b.at(t0, () => {
      view.overlay.setTurn(view.info.turn(ctx), true);
      view.chars.setCurrent(ctx.active ? pid : null);
      if (!view.director.pinned && !view.animator.finishing) view.director.resume();
    });
    if (own && b.cam(k)) {
      const first = !(view.seenTurn ??= new Set()).has(pid);
      view.seenTurn.add(pid);
      const jailed = !!ctx.byId.get(pid)?.inJail;
      if (b.cinematic && jailed) {
        // In the yard: the turn starts across the street from the police station (Just Visiting kerb).
        b.shot(t0, (d) => d.kerb(10, { glide: DIVE }));
        b.street = true;
      } else if (b.cinematic) {
        let at = t0;
        if (first) {
          b.cutTo(at, (d) => d.hero(pid), { silent: true });
          at += 0.9;
        }
        b.shot(at, (d) => d.ready(pid, { glide: DIVE }));
      } else b.shot(t0, (d) => d.heli(b.charPos(pid), { glide: 0.6 }));
      b.react(t0 + 0.05, pid, 'wake');
      b.beat('wake', t0 + 0.05, { pid, pos: b.charAt(pid) });
    } else {
      b.shot(t0, (d) => { if (d.mode !== 'heli') d.heli(b.charPos(pid), { glide: 0.9 }); else d.heli(b.charPos(pid)); });
    }
    b.beat('turnStart', t0, { pid, silent: !own });
    b.t += b.d('turnStart', k);
  },

  dice_rolled(b, e, k) {
    const values = Array.isArray(e.dice) && e.dice.length === 2 ? e.dice.map(Number) : null;
    if (!values || values.some((v) => !(v >= 1 && v <= 6))) return;
    const { view, ctx } = b;
    const pid = e.playerId;
    const ver = b.ver(k);
    const seed = ((Number(ctx.state.seq) || 0) * 31 + k * 7) >>> 0;
    const small = e.purpose === 'utility';
    const t0 = b.t;
    const budget = b.d('dice', k);
    // The camera is already behind the thrower (turn-start dive); after a doubles landing it glides back.
    if (b.cam(k) && b.cinematic && !small) {
      if (e.purpose === 'jail') b.shot(t0, (d) => d.kerb(10, { glide: READY_GLIDE }));
      else b.shot(t0, (d) => { if (d.mode !== 'ready') d.ready(pid, { glide: READY_GLIDE }); });
    }
    const res = view.hudDice.schedule(values, seed, t0, {
      scale: ver === 'others' ? 0.6 : 1,
      small,
      speed: ver === 'others' ? BUDGET.dice.own / BUDGET.dice.others : 1,
      shake: 0.18,
      onShake: () => b.fire('diceShake', { pid }),
      onThrow: () => b.fire('diceThrow', { pid }),
      onBounce: (intensity, die, kind) => b.fire('diceBounce', {
        pid, die, kind,
        soundOpts: { volume: 0.3 + 0.7 * Math.max(0, Math.min(1, Number(intensity) || 0)), rate: (kind === 'edge' ? 1.2 : 1) + (die ? 0.06 : 0) },
      }),
      onSettle: (info) => { if (!info?.skipped) b.fire('diceSettle', { pid, values }); },
    }) ?? {};
    let rest = Number.isFinite(res.restAt) && res.restAt > 0 ? res.restAt : budget - 0.05;
    if (rest > budget) rest = budget; // pacing: the walk never waits for slow dice
    const total = values[0] + values[1];
    const doubles = values[0] === values[1];
    b.soft(t0 + rest - 0.1, () => view.overlay.callout(doubles ? `DOUBLES! ${total}` : `${total}`, doubles ? 'doubles' : 'total', doubles ? 1300 : 900));
    if (doubles && e.purpose !== 'utility') {
      b.beat('doubles', t0 + rest, { pid, values, sounds: ver === 'own' ? undefined : [['doubles', { volume: 0.6 }]] });
      b.soft(t0 + rest, () => view.hudDice.celebrate(0));
    }
    b.diceEnd = t0 + Math.min(budget, Math.max(rest, Number(res.duration) || budget));
    b.walkAt = t0 + Math.max(0.3, rest - b.d('walkEarly', k));
    b.diceBy = pid;
    b.t = small || e.purpose === 'jail' ? b.diceEnd : b.walkAt;
  },

  moved(b, e, k) {
    if (e.via === 'jail') return towScene(b, e, k);
    const { view, ctx } = b;
    const { chars, director } = view;
    const pid = e.playerId;
    const ch = chars.get(pid);
    const ver = b.ver(k);
    const tokenId = ch?.tokenId ?? ctx.byId.get(pid)?.token ?? 'pawn';
    const mp = movePlan(e, b.rels[k], { others: b.others, tokenId });
    if (!mp) return dropScene(b, e, k);
    const { path, plan } = mp;
    const dest = wrap(e.to ?? path.to);
    const start = b.t;
    const color = b.chip(pid) ?? '#ffffff';
    const own = ver !== 'others';
    const n = Math.abs(path.steps);

    // Route preview: ribbon on the lane, the destination's post pulses, the route chip.
    if (own) {
      const at = b.diceBy === pid && b.walkAt !== null ? Math.max(0, start - 0.2) : start;
      b.soft(at, () => {
        view.ground.setRoute({ s0: path.s0, s1: path.s1, color }, { delay: 0, reveal: 0.25 });
        view.ground.pulseBay(dest, { color, duration: 0.6 });
        view.overlay.routeChip({ text: routeText(b, dest, pid), color });
      });
      b.beat('routeShow', at, { pid, tile: dest });
    }

    b.soft(start, () => view.setTrail?.({ from: wrap(e.from), to: dest, color }));
    // The character's move (lane C): real launch and arrival, the time-lapse in between.
    const r = chars.scheduleMove(e, start, {
      plan,
      path,
      onStart: () => b.fire('walkStart', { pid, token: tokenId, via: e.via, pos: b.charAt(pid), silent: true }),
    }) ?? {};
    const T = Number(r.duration) > 0 ? Number(r.duration) : plan.T;
    const landAt = Number.isFinite(r.landAt) && r.landAt > start ? r.landAt : start + T;
    const arrive = Number.isFinite(plan.arrive) ? plan.arrive : 0.45;
    const tileTimes = Array.isArray(r.tileTimes) && r.tileTimes.length
      ? r.tileTimes.filter((x) => Number.isFinite(x?.at))
      : path.tiles.map((x) => ({ index: x.index, at: start + plan.timeAt(Math.abs(x.s - path.s0)) }));
    const goAt = Number.isFinite(r.goAt) ? r.goAt : path.goAt !== null ? start + plan.timeAt(path.goAt * path.length) : null;
    if (goAt !== null) b.goAt.set(pid, goAt);

    // Counting ritual: each address on the way flashes, the HUD counts, a tick (own turns).
    tileTimes.forEach((x, j) => {
      if (j === tileTimes.length - 1) return; // the destination flashes on landing
      if (own) {
        b.soft(x.at, () => {
          view.ground.pulseBay(x.index, { color, duration: 0.35 });
          view.overlay.stepCount(j + 1, n);
        });
        if (ver === 'own') b.beat('stepTick', x.at, { pid, tile: x.index, pos: b.charAt(pid) });
      }
    });
    if (own) b.soft(landAt, () => view.overlay.stepCount(n, n));
    if (path.steps < 0) b.beat('rewind', start, { pid, pos: b.charAt(pid) });

    // Camera by distance.
    const tier = shotTier(path.length);
    const cine = b.cam(k) && b.cinematic;
    const arriveAt = start + Math.max(0, T - arrive);
    if (cine) {
      if (tier === 'track') {
        b.shot(start, (d) => d.track(pid, dest, { glide: 0.35, dir: path.dir, from: wrap(e.from) }));
      } else {
        if (tier === 'swoop') {
          const pts = pathPoints(path, 0);
          b.shot(start + (Number(plan.launch) || 0), (d) => d.transit(pts, { pullOut: PULL_OUT * T }));
          // FOV kick with the cruise speed.
          const vMax = Math.max(1, Number(plan.vCruise) || 1);
          view.animator.add({
            delay: start,
            duration: T,
            update: (p) => { if (b.current && director.mode === 'transit') director.setFovKick(6 * Math.min(1, (plan.vAt?.(p * T) ?? 0) / vMax)); },
            end: () => director.setFovKick(0),
          });
        } else {
          b.shot(start, (d) => d.heli(b.charPos(pid), { glide: 0.6 }));
        }
        // One cut to the kerb as the character comes in to land (the J-cut leads it).
        b.soft(arriveAt - JCUT, () => view.audio.jcut(address(dest)));
        b.cutTo(arriveAt, (d) => d.kerb(dest), { silent: plan.lapse, beat: 'kerbCut' });
      }
      b.street = true;
    } else if (b.cam(k) && director.style === 'calm') {
      b.shot(start, (d) => d.heli(b.charPos(pid), { glide: 0.8 }));
      b.shot(arriveAt, (d) => d.kerb(dest, { glide: 0.8 }));
      b.street = true;
    } else if (director.style !== 'free') {
      b.shot(start, (d) => { if (d.mode === 'heli') d.heli(b.charPos(pid)); });
    }
    // Time-lapse sound design (own scenes): rise at cruise start, land at the arrival cut.
    if (plan.lapse && own) {
      b.beat('lapseStart', start + (Number(plan.cruiseStart) || 0), { pid });
      b.beat('lapseEnd', arriveAt, { pid });
    }
    b.landTile.set(pid, dest);
    b.t = Math.max(b.t, start + T);
    b.moved = true;
    b.lastMove = { pid, dest };
    if (!b.events.slice(k + 1).some((x) => x.type === 'landed' && x.playerId === pid)) {
      b.soft(b.t, () => view.ground.pulseBay(dest, { color, duration: 0.5 }));
      b.beat('land', b.t, { pid, tile: dest, pos: b.charAt(pid) });
      b.t += b.d('land', k);
    }
  },

  passed_go(b, e, k) {
    const { view } = b;
    const pid = e.playerId;
    const at = b.goAt.get(pid) ?? b.t;
    b.goAt.delete(pid);
    const ritual = view.landmarks.goBurst(at, { amount: num(e.amount) || 200 });
    b.cues(at, ritual, { pid, tile: 0, pos: address(0) }, { skip: ['goBurst'] });
    b.beat('goBurst', at, { pid, tile: 0, pos: address(0), amount: e.amount, sounds: b.ver(k) === 'own' ? undefined : [['confettiPop', { volume: 0.4 }]] });
    b.beat('passGo', at, { pid, amount: e.amount, tile: 0 });
    b.float(at, pid, `+${money(e.amount)}`, 'gold');
    b.money(at + 0.1, null, pid, e.amount);
    const landsOnGo = b.events.some((x) => x.type === 'moved' && x.playerId === pid && wrap(x.to) === 0);
    if (landsOnGo) b.react(at + 0.05, pid, 'goJump');
  },

  landed(b, e, k) {
    const { view, ctx } = b;
    const i = Number(e.tileIndex);
    const pid = e.playerId;
    const ver = b.ver(k);
    const t0 = b.t;
    const color = b.chip(pid) ?? '#ffffff';
    b.soft(t0, () => view.ground.pulseBay(i, { color, duration: 0.6 }));
    if (ver !== 'others' || b.rels[k].level === 'med') b.soft(t0, () => view.overlay.chyron(chyronFor(b, i), 2600));
    const tile = b.tile(i);
    const pending = pendingTile(ctx) === i;
    if (pending && ver !== 'others') {
      b.soft(t0, () => view.lots.signBounce(i, 0));
      b.floatTile(t0 + 0.1, i, money(tile?.price), 'gold');
    }
    if (i === 20) {
      b.cues(t0, view.landmarks.fpBarrier(true, t0), { pid, tile: 20, pos: address(20) });
      view.landmarks.fpWheel(t0);
    }
    if (i === 30) b.cues(t0, view.landmarks.gtjBarrier(true, t0), { pid, tile: 30, pos: address(30) }, { only: ['barrier'] });
    b.beat('land', t0, { pid, tile: i, pos: b.charAt(pid), soundOpts: ver === 'own' ? undefined : { volume: 0.35 } });
    b.landTile.set(pid, i);
    const next = b.events[k + 1]?.type;
    b.t += next === 'card_drawn' ? b.d('landToCard', k) : b.d('land', k);
  },

  card_drawn(b, e, k) {
    const { view } = b;
    const pid = e.playerId;
    const who = b.Name(pid);
    const text = String(e.text ?? '');
    const deck = e.deck === 'community' ? 'community' : 'chance';
    const t0 = b.t;
    const at = b.spotOf(pid);
    const tile = Number.isInteger(at) && [2, 7, 17, 22, 33, 36].includes(at) ? at : nearestDeckTile(deck, at);
    // The kiosk neon / the chest lid tells first; the card hops out of its slot and flies to the camera.
    const k1 = view.landmarks.kiosk(tile, t0) ?? {};
    b.cues(t0, k1, { pid, tile, pos: address(tile) });
    b.beat(deck === 'community' ? 'chestLid' : 'kiosk', t0, { pid, tile, pos: address(tile) });
    const pose = k1.cardPose ?? null;
    b.at(t0, () => view.deck?.set(deck, pose));
    view.cards.schedule({ deck, text, who }, t0, CARD_HOLD, { silent: true });
    b.beat('cardDraw', t0, { pid, deck });
    b.beat('cardFlip', t0 + 0.35, { pid, deck, text });
    b.soft(t0 + CARD_IN + CARD_HOLD - 0.1, () => view.overlay.showCard({ deck, who, text }));
    // Act-outs during the hang.
    if (/speeding/i.test(text)) b.soft(t0 + 0.8, () => view.chars.cameo('patrol', { tile, delay: 0 }));
    b.t += b.d('card', k);
  },

  jail_card_received(b, e, k) {
    b.float(b.t, e.playerId, 'Get Out of Jail Free', 'gold');
    b.beat('jailCard', b.t, { pid: e.playerId, deck: e.deck });
    b.t += b.d('jailCard', k);
  },

  paid_rent(b, e, k) {
    const { view, ctx } = b;
    const pid = e.playerId;
    const to = e.ownerId;
    const i = Number(e.tileIndex);
    const amount = num(e.amount);
    const ver = b.ver(k);
    const t0 = b.t;
    const big = amount >= 1000;
    if (big && ver !== 'others') b.letterbox(t0, true);
    if (b.cam(k) && Number.isInteger(i)) b.shot(t0, (d) => { if (!(d.mode === 'kerb' && d.kerbTile === i)) d.kerb(i, { glide: 0.5 }); });
    const ritual = view.lots.ritual(i, 'rent', t0 + 0.05, { own: ver !== 'others', color: b.chip(to) });
    b.cues(t0 + 0.05, ritual, { pid: to, tile: i, pos: b.lotFront(i, 4) });
    b.float(t0, pid, `−${money(amount)}`, 'minus');
    if (to && ctx.byId.has(to)) b.float(t0 + 0.3, pid, `+${money(amount)} → ${b.name(to)}`, 'plus', { chip: b.chip(to) });
    b.beat('rent', t0, { pid, to: to ?? null, amount, tile: Number.isInteger(i) ? i : null });
    b.money(t0 + 0.2, pid, to, amount);
    if (ver !== 'others') {
      b.react(t0 + 0.05, pid, 'sad');
      if (to && ctx.byId.has(to)) b.react(t0 + 0.3, to, 'celebrate');
      if (ver === 'own') b.crowd(t0 + 0.2, b.lotFront(i), 5, { duration: 1.2 });
    }
    if (big && ver !== 'others') {
      b.effect(t0 + 0.3, (fx) => fx.money(b.charPos(pid), b.lotFront(i, 2), amount));
      b.t += b.d('bigRent', k);
      b.letterbox(t0 + b.d('rent', k) + b.d('bigRent', k) - 0.05, false);
    }
    b.street = b.street || b.cam(k);
    b.t += b.d('rent', k);
  },

  paid_tax(b, e, k) {
    const { view } = b;
    const pid = e.playerId;
    const i = Number(e.tileIndex);
    const t0 = b.t;
    if (Number.isInteger(i)) b.cues(t0 + 0.1, view.landmarks.taxSlot(i, t0 + 0.1), { pid, tile: i, pos: address(i) });
    b.float(t0, pid, `−${money(e.amount)}`, 'minus');
    b.beat('tax', t0, { pid, amount: e.amount, tile: i });
    b.money(t0 + 0.1, pid, null, e.amount);
    if (b.ver(k) !== 'others') b.react(t0 + 0.05, pid, 'sad');
    b.t += b.d('tax', k);
  },

  paid(b, e, k) {
    payment(b, e, k, 'pay', e.toPlayerId);
  },

  debt_paid(b, e, k) {
    const payees = Array.isArray(e.payees) && e.payees.length ? e.payees : null;
    if (!payees) return payment(b, e, k, 'pay', e.toPlayerId);
    b.float(b.t, e.playerId, `−${money(e.amount)}`, 'minus');
    b.beat('pay', b.t, { pid: e.playerId, amount: e.amount });
    payees.slice(0, 7).forEach((p, n) => {
      if (!b.ctx.byId.has(p.playerId)) return;
      b.float(b.t + 0.2 + n * 0.1, p.playerId, `+${money(p.amount)}`, 'plus');
      b.money(b.t + 0.1 + n * 0.1, e.playerId, p.playerId, p.amount);
    });
    b.t += b.d('money', k);
  },

  collected(b, e, k) {
    const { view } = b;
    const pid = e.playerId;
    const t0 = b.t;
    const from = e.fromPlayerId && b.ctx.byId.has(e.fromPlayerId) ? e.fromPlayerId : null;
    if (e.reason === 'free_parking') {
      b.cues(t0, view.landmarks.potBurst(t0), { pid, tile: 20, pos: address(20) }, { skip: ['potBurst'] });
      b.beat('potBurst', t0, { pid, tile: 20, pos: address(20) });
    } else b.beat('income', t0, { pid, from, amount: e.amount, reason: e.reason });
    b.float(t0, pid, `+${money(e.amount)}`, 'plus');
    if (from) b.float(t0 + 0.25, from, `−${money(e.amount)}`, 'minus');
    b.money(t0, from, pid, e.amount);
    if (!laterMove(b, k, pid) && b.ver(k) !== 'others') b.react(t0 + 0.05, pid, 'celebrate');
    b.t += b.d('money', k);
  },

  bought(b, e, k) {
    const { view } = b;
    const i = Number(e.tileIndex);
    const pid = e.playerId;
    const ver = b.ver(k);
    const t0 = b.t;
    const color = b.chip(pid);
    if (b.cam(k) && ver === 'own') b.shot(t0, (d) => { if (!(d.mode === 'kerb' && d.kerbTile === i)) d.kerb(i, { glide: 0.5 }); });
    const ritual = view.lots.ritual(i, 'buy', t0, { own: ver === 'own', color });
    b.cues(t0, ritual, { pid, tile: i, pos: b.lotFront(i, 3) });
    b.beat('buy', t0, { pid, tile: i, amount: e.price });
    b.money(t0 + 0.1, pid, null, e.price);
    b.floatTile(t0 + 0.15, i, `−${money(e.price)}`, 'minus', { chip: color });
    if (ver !== 'others') b.react(t0 + 0.3, pid, 'celebrate');
    if (ver === 'own') {
      b.crowd(t0 + 0.4, b.lotFront(i), 10, { hardHats: 2, duration: 1.5, face: address(i).lot.front });
      b.beat('crowd', t0 + 1.0, { tile: i, pos: b.lotFront(i), soundOpts: { volume: 0.5 } });
      b.street = true;
    }
    b.t += b.d('buy', k);
    if (completesSet(e, b.relCtx)) setComplete(b, k, b.tile(i)?.group, pid);
  },

  declined(b) {
    b.street = true; // let go of the held tile (an auction usually follows)
  },

  built(b) {
    const { view } = b;
    // Every build of this batch is laid out here, grouped by colour group.
    const list = b.events.map((x, n) => ({ x, n })).filter(({ x }) => x.type === 'built');
    for (const { n } of list) b.handled.add(n);
    const groups = buildGroups(list.map((o) => o.x), view.BOARD);
    const relB = list.map(({ n }) => b.rels[n]).reduce(maxRel, null);
    const ver = versionOf(relB, b.others);
    const D = (name) => dur(name, relB, b.others);
    const own = ver === 'own';
    const cam = view.director.auto && view.director.style !== 'free' && ver !== 'others';
    const sweep = (g) => g.filter((x) => num(x.houses) !== 5);
    if (groups.length > 2) {
      // Many groups at once: the map view, everything pops together.
      const t0 = b.t;
      if (cam) b.shot(t0, (d) => d.map(true));
      for (const g of groups) {
        for (const x of g) {
          const i = Number(x.tileIndex);
          const hotel = num(x.houses) === 5;
          const r = view.lots.ritual(i, hotel ? 'hotel' : 'house', t0 + 0.4, { own: false, color: b.chip(x.playerId), level: num(x.houses), fromLevel: num(x.houses) - 1 });
          b.cues(t0 + 0.4, r, { pid: x.playerId, tile: i }, { only: ['topOut'] });
        }
      }
      b.beat('build', t0 + 0.45, { pid: list[0].x.playerId });
      b.t += D('housesMap');
      return;
    }
    for (const g of groups) {
      const houses = sweep(g);
      const hotels = g.filter((x) => num(x.houses) === 5);
      const pid = g[0].playerId;
      const color = b.chip(pid);
      const group = view.BOARD?.tiles?.[Number(g[0].tileIndex)]?.group;
      if (houses.length) {
        const tiles = [...new Set(houses.map((x) => Number(x.tileIndex)))];
        const H = Math.max(...houses.map((x) => view.heightOf(group, num(x.houses)) ?? 12));
        const t0 = b.t;
        const span = housesTime(houses.length, relB, b.others);
        let at = t0;
        if (cam) {
          if (b.cinematic || view.director.style === 'calm') b.shot(t0, (d) => d.crane(tiles, { height: H, duration: D('craneIn') + span }));
          at += D('craneIn');
          b.street = true;
        }
        const stagger = D('houseStagger');
        houses.forEach((x, n) => {
          const i = Number(x.tileIndex);
          const when = at + n * stagger;
          const r = view.lots.ritual(i, 'house', when, { own, color, level: num(x.houses), fromLevel: num(x.houses) - 1 });
          b.cues(when, r, { pid, tile: i, pos: b.lotFront(i, 4) }, { skip: ['build'] });
          b.beat('build', when + Math.min(0.5, (Number(r?.duration) || 0.6) * 0.8), { pid, tile: i, houses: num(x.houses), pos: b.lotFront(i, 4) });
          const cost = num(b.tile(i)?.houseCost);
          if (cost && ver !== 'others') b.floatTile(when + 0.1, i, `−${money(cost)}`, 'minus', { chip: color });
          if (own && n === 0) b.crowd(when + 0.1, b.lotFront(i), 6, { hardHats: 3, duration: 1.4 });
        });
        b.t = at + span;
      }
      hotels.forEach((x, n) => {
        const i = Number(x.tileIndex);
        const H = view.heightOf(group, 5) ?? 40;
        const T = D('hotel');
        const t0 = b.t + (n ? D('houseStagger') : 0);
        const scene = ver !== 'others';
        if (scene) b.letterbox(t0, true);
        if (cam) {
          b.shot(t0, (d) => d.crane([i], { hotel: true, height: H, duration: T }));
          b.street = true;
        }
        const r = view.lots.ritual(i, 'hotel', t0, { own, color, level: 5, fromLevel: 4 });
        b.cues(t0, r, { pid, tile: i, pos: b.lotFront(i, 6) });
        const topOut = (r?.cues ?? []).find((c) => c?.name === 'topOut')?.at ?? T * 0.75;
        if (!(r?.cues ?? []).some((c) => c?.name === 'topOut')) b.beat('topOut', t0 + topOut, { pid, tile: i });
        b.shot(t0 + topOut, (d) => d.shake(0.05, 0.25));
        if (own) {
          b.crowd(t0 + 0.2, b.lotFront(i), 30, { hardHats: 4, duration: T });
          b.beat('crowd', t0 + topOut + 0.1, { tile: i, pos: b.lotFront(i) });
        }
        const cost = num(b.tile(i)?.houseCost);
        if (cost && scene) b.floatTile(t0 + 0.1, i, `−${money(cost)}`, 'minus', { chip: color });
        if (scene) b.letterbox(t0 + T - 0.05, false);
        b.t = t0 + T;
      });
    }
  },

  sold_house(b, e, k) {
    const { view } = b;
    const list = b.events.map((x, n) => ({ x, n })).filter(({ x }) => x.type === 'sold_house');
    for (const { n } of list) b.handled.add(n);
    const relB = list.map(({ n }) => b.rels[n]).reduce(maxRel, null);
    const ver = versionOf(relB, b.others);
    const byGroup = new Map();
    for (const { x } of list) {
      const g = view.BOARD?.tiles?.[Number(x.tileIndex)]?.group ?? x.tileIndex;
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(x);
    }
    for (const g of byGroup.values()) {
      const t0 = b.t;
      const tiles = [...new Set(g.map((x) => Number(x.tileIndex)))];
      const group = view.BOARD?.tiles?.[tiles[0]]?.group;
      if (view.director.auto && view.director.style !== 'free' && ver === 'own' && byGroup.size <= 2) {
        b.shot(t0, (d) => d.crane(tiles, { height: view.heightOf(group, 4) ?? 15, duration: dur('sell', relB, b.others) }));
        b.street = true;
      }
      g.forEach((x, n) => {
        const i = Number(x.tileIndex);
        const left = num(x.houses);
        const kind = left === 4 && view.lots.inspect(i)?.level === 5 ? 'unhotel' : 'sell';
        const r = view.lots.ritual(i, kind, t0 + n * 0.12, { own: ver === 'own', color: b.chip(x.playerId), level: left, fromLevel: left + 1 });
        b.cues(t0 + n * 0.12, r, { pid: x.playerId, tile: i, pos: b.lotFront(i, 4) });
        b.beat('demolish', t0 + n * 0.12, { pid: x.playerId, tile: i, houses: left, pos: b.lotFront(i, 4) });
        if (num(x.amount) && ver !== 'others') b.floatTile(t0 + 0.15 + n * 0.12, i, `+${money(x.amount)}`, 'plus', { chip: b.chip(x.playerId) });
      });
      b.t += dur('sell', relB, b.others);
    }
  },

  mortgaged(b, e, k) {
    ledger(b, k);
  },

  unmortgaged(b, e, k) {
    ledger(b, k);
  },

  sent_to_jail(b, e, k) {
    b.soft(b.t, () => b.view.overlay.callout('GO TO JAIL!', 'alert', 1100, { color: b.chip(e.playerId) }));
    b.t += b.d('sentToJail', k);
  },

  left_jail(b, e, k) {
    const { view } = b;
    const pid = e.playerId;
    const t0 = b.t;
    b.cues(t0, view.landmarks.jailGate(true, t0), { pid, tile: 10, pos: address(10) });
    const out = Number(view.chars.release(pid, t0)) || 0;
    b.float(t0, pid, e.method === 'card' ? 'Get Out of Jail Free' : 'Out of jail', e.method === 'card' ? 'gold' : 'info');
    if (e.method === 'fine' || e.method === 'forced_fine') b.money(t0 + 0.1, pid, null, view.BOARD?.jailFine ?? 50);
    b.beat('jailOut', t0, { pid, method: e.method });
    b.landTile.set(pid, 10);
    b.t += Math.max(b.d('leftJail', k), Math.min(out, 1.2));
    b.cues(b.t, view.landmarks.jailGate(false, b.t), { pid, tile: 10, pos: address(10) }, { skip: ['jailIn'] });
  },

  jail_roll_failed(b, e, k) {
    const at = Math.max(b.t, b.diceEnd - 0.05);
    b.float(at, e.playerId, 'No doubles', 'info');
    b.beat('jailStay', at, { pid: e.playerId, attempt: e.attempt });
    if (b.ver(k) !== 'others') b.react(at, e.playerId, 'sad');
  },

  debt_started(b, e, k) {
    b.float(b.t, e.playerId, `Owes ${money(e.amount)}`, 'minus');
    b.t += b.d('note', k);
  },

  debt_reduced(b, e, k) {
    b.float(b.t, e.playerId, `Still owes ${money(e.amount)}`, 'info');
    b.t += b.d('note', k);
  },

  timeout(b, e, k) {
    b.float(b.t, e.playerId, "Time's up", 'info');
    b.t += b.d('note', k);
  },

  bankrupt(b, e, k) {
    const { view, ctx } = b;
    const pid = e.playerId;
    const ver = b.ver(k);
    const T = ver === 'others' ? BUDGET.bankrupt.others : b.d('bankrupt', k);
    const f = T / BUDGET.bankrupt.own;
    const t0 = b.t;
    const to = e.toPlayerId && ctx.byId.has(e.toPlayerId) ? e.toPlayerId : null;
    b.letterbox(t0, true);
    b.soft(t0, () => view.overlay.callout('BANKRUPT!', 'alert', 1400, { sub: view.info.name(ctx, pid), color: b.chip(pid) }));
    b.beat('bankrupt', t0, { pid, to });
    const cine = view.director.auto && view.director.style === 'cinematic' && !view.director.instant;
    if (cine && view.chars.get(pid)?.visible !== false) {
      b.cutTo(t0, (d) => { d.hero(pid); d.dollyZoom(31, 0.6); }, { silent: true });
      b.street = true;
    }
    b.react(t0 + 0.05, pid, 'bankrupt');
    if (num(e.cash) > 0) b.money(t0 + 0.3, pid, to, e.cash);
    // Foreclosure: the bankrupt player's lots go to the creditor or back to the bank.
    const tiles = forecloseTiles(view, ctx, pid);
    const mapAt = t0 + 0.6 * f;
    if (view.director.auto && view.director.style !== 'free') b.cutTo(mapAt, (d) => d.map(true), { silent: true });
    tiles.forEach((i, n) => {
      const when = mapAt + 0.35 + n * 0.12 * f;
      const r = view.lots.ritual(i, 'foreclose', when, { own: ver === 'own', toCreditor: !!to, color: to ? b.chip(to) : null, fromColor: b.chip(pid) });
      b.cues(when, r, { pid, tile: i }, { only: ['stamp'] });
    });
    const leave = mapAt + 0.35 + Math.min(tiles.length, 12) * 0.12 * f;
    view.chars.exitTown(pid, Math.min(leave, t0 + T - 1.0 * f));
    b.shot(t0 + T - 0.3, (d) => d.heli(activePos(view, ctx), { glide: 0.6 }));
    b.letterbox(t0 + T - 0.05, false);
    b.t = t0 + T;
  },

  game_over(b, e) {
    const { view, ctx } = b;
    const w = e.winnerId;
    const T = BUDGET.victory.own;
    const t0 = b.t;
    b.letterbox(t0, true);
    b.beat('victory', t0, { pid: w });
    b.soft(t0, () => view.stage.setDayPhase(1.0, { duration: 1.5 }));
    b.soft(t0 + 0.5, () => view.life.crowd.cheerAll(0, 5));
    if (w && ctx.byId.has(w)) {
      view.chars.victoryLap(w, t0 + 0.3, { duration: 3 });
      b.react(t0 + 3.6, w, 'victory', { loops: 3 });
    }
    const harbour = new THREE.Vector3(320, 70, 220);
    for (const at of [1.0, 2.4, 3.8, 5.2]) b.effect(t0 + at, (fx) => fx.fireworks(harbour, { bursts: 4, radius: 18, height: 60 }));
    const top = tallestLot(view, ctx, w);
    if (top !== null) b.effect(t0 + 3.0, (fx) => fx.fireworks(b.overLot(top), { bursts: 3, radius: 12, height: 20 }));
    if (view.director.auto && view.director.style !== 'free') {
      b.shot(t0, (d) => d.heli(b.charPos(w), { glide: 0.8 }));
      if (view.director.style === 'cinematic') b.cutTo(t0 + 3.3, (d) => d.orbit(w, 1.4), { silent: true });
      b.shot(t0 + 4.7, (d) => d.skyline(2.2));
    }
    b.letterbox(t0 + T - 0.05, false);
    b.t = t0 + T;
  },

  // ---- auctions (CONTRACT §4.12) ----

  auction_started(b, e, k) {
    const { view, ctx } = b;
    const i = Number(e.tileIndex);
    const t0 = b.t;
    if (b.cam(k)) {
      b.shot(t0, (d) => d.kerb(i, { hold: true, glide: d.mode === 'kerb' && d.kerbTile === i ? 0 : 0.6 }));
      b.street = true;
    }
    b.soft(t0, () => {
      view.overlay.callout('AUCTION!', 'gold', 1100, { sub: tileName(view, i) });
      view.overlay.setAuction(auctionInfo(view, ctx));
      view.lots.setAuction(i, { bid: 0, color: null, name: tileName(view, i) });
    });
    b.beat('auctionStart', t0, { tile: i, participants: e.participants });
    b.beat('board', t0 + 0.15, { tile: i, pos: b.lotFront(i, 3) });
    if (b.ver(k) === 'own') b.crowd(t0 + 0.1, b.lotFront(i), 12, { duration: 2.5 });
    b.t += b.d('auctionStart', k);
  },

  auction_bid(b, e, k) {
    const { view, ctx } = b;
    const pid = e.playerId;
    const i = auctionTile(ctx) ?? lastAuctionTile(b);
    const n = (b.bids = (b.bids ?? 0) + 1);
    b.soft(b.t, () => {
      view.overlay.setAuction(auctionInfo(view, ctx, { playerId: pid, amount: e.amount }));
      view.overlay.pulseAuction(b.chip(pid));
      if (i !== null) view.lots.setAuction(i, { bid: num(e.amount), color: b.chip(pid), name: b.Name(pid) });
      view.chars.pulse(pid, 0);
    });
    b.beat('bid', b.t, { pid, amount: e.amount, tile: i, soundOpts: { rate: Math.min(1.5, 1 + 0.03 * n) } });
    b.float(b.t, pid, `Bids ${money(e.amount)}`, 'info', { chip: b.chip(pid) });
    b.t += b.d('bid', k);
  },

  auction_passed(b, e, k) {
    b.float(b.t, e.playerId, 'Pass', 'info', { chip: b.chip(e.playerId) });
    b.beat('auctionPass', b.t, { pid: e.playerId });
    b.t += b.d('pass', k);
  },

  auction_won(b, e, k) {
    const { view } = b;
    const i = Number(e.tileIndex);
    const pid = e.playerId;
    const ver = b.ver(k);
    const t0 = b.t;
    b.soft(t0, () => {
      view.overlay.setAuction(null);
      view.lots.setAuction(null);
    });
    b.beat('gavel', t0, { tile: i, pos: b.lotFront(i, 3) });
    b.beat('sold', t0 + 0.45, { pid, tile: i, amount: e.amount, pos: b.lotFront(i, 3), sounds: [['sold']] });
    b.soft(t0 + 0.45, () => view.overlay.callout('SOLD!', 'gold', 1400, { sub: `${b.Name(pid)} · ${money(e.amount)}`, color: b.chip(pid) }));
    const r = view.lots.ritual(i, 'buy', t0 + 0.5, { own: false, color: b.chip(pid) });
    b.cues(t0 + 0.5, r, { pid, tile: i, pos: b.lotFront(i, 3) }, { skip: ['stamp'] });
    b.money(t0 + 0.5, pid, null, e.amount);
    b.floatTile(t0 + 0.5, i, `−${money(e.amount)}`, 'minus', { chip: b.chip(pid) });
    if (ver !== 'others') b.react(t0 + 0.6, pid, 'celebrate');
    b.street = b.street || b.cam(k);
    b.t += b.d('auctionWon', k);
    if (completesSet(e, b.relCtx)) setComplete(b, k, b.tile(i)?.group, pid);
  },

  auction_unsold(b, e, k) {
    const { view } = b;
    const i = Number(e.tileIndex);
    b.soft(b.t, () => {
      view.overlay.setAuction(null);
      view.lots.setAuction(null);
      view.overlay.callout('No sale', 'total', 900);
    });
    b.beat('unsold', b.t, { tile: i, pos: b.lotFront(i, 3) });
    b.street = b.street || b.cam(k);
    b.t += b.d('unsold', k);
  },

  // ---- trades (CONTRACT §4.13) ----

  trade_proposed(b, e, k) {
    const { view } = b;
    const from = e.fromPlayerId;
    const to = e.toPlayerId;
    const tiles = tradeTiles(e);
    if (b.cam(k)) b.shot(b.t, (d) => frameTrade(d, view, [from, to], tiles.map((x) => x.index)));
    b.soft(b.t, () => view.overlay.setTrade(tradeChips(b, e)));
    b.float(b.t, from, `Offer → ${b.name(to)}`, 'info', { chip: b.chip(to) });
    const sounds = to === b.ctx.me ? [] : undefined; // the target hears ui.js's 'offer' chime instead
    b.beat('tradePropose', b.t, { pid: from, to, tradeId: e.tradeId, tiles: tiles.map((x) => x.index), sounds });
    b.t += b.d('tradePropose', k);
  },

  trade_accepted(b, e, k) {
    const { view } = b;
    const from = e.fromPlayerId;
    const to = e.toPlayerId;
    const tiles = tradeTiles(e);
    const ver = b.ver(k);
    const t0 = b.t;
    const T = b.d('trade', k);
    if (b.cam(k)) b.shot(t0, (d) => d.map(true));
    b.soft(t0, () => {
      view.overlay.setTrade(null);
      view.overlay.callout('DEAL!', 'deal', 1200, { sub: `${b.Name(from)} ⇄ ${b.name(to)}` });
    });
    b.beat('tradeAccept', t0, { pid: from, to, tradeId: e.tradeId, tiles: tiles.map((x) => x.index) });
    const first = t0 + (b.cam(k) ? 0.45 : 0.1);
    const stagger = Math.min(0.16, (T - 0.8) / Math.max(1, tiles.length));
    tiles.forEach((x, n) => {
      const when = first + n * stagger;
      const r = view.lots.ritual(x.index, 'transfer', when, { own: ver === 'own', color: b.chip(x.to), fromColor: b.chip(x.from) });
      b.cues(when, r, { pid: x.to, tile: x.index }, { only: ['flagUp'] });
      b.beat('ownerChange', when, { pid: x.to, from: x.from, tile: x.index });
      b.effect(when + 0.1, (fx) => fx.confetti(b.lotFront(x.index, 6), { count: 60, spread: 8, height: 6 }));
    });
    const give = e.give ?? {};
    const get = e.get ?? {};
    if (give.cash > 0) {
      b.money(t0 + 0.3, from, to, give.cash);
      b.float(t0 + 0.3, from, `−${money(give.cash)}`, 'minus');
      b.float(t0 + 0.45, to, `+${money(give.cash)}`, 'plus', { chip: b.chip(from) });
    }
    if (get.cash > 0) {
      b.money(t0 + 0.5, to, from, get.cash);
      b.float(t0 + 0.5, to, `−${money(get.cash)}`, 'minus');
      b.float(t0 + 0.65, from, `+${money(get.cash)}`, 'plus', { chip: b.chip(to) });
    }
    if (give.jailCards > 0) b.float(t0 + 0.7, to, 'Get Out of Jail Free', 'gold');
    if (get.jailCards > 0) b.float(t0 + 0.7, from, 'Get Out of Jail Free', 'gold');
    for (const [id, fee] of Object.entries(e.fees ?? {})) if (fee > 0 && b.ctx.byId.has(id)) b.float(t0 + 0.8, id, `Fee −${money(fee)}`, 'minus');
    if (ver !== 'others') {
      b.react(t0 + 0.35, from, 'celebrate');
      b.react(t0 + 0.45, to, 'celebrate');
    }
    b.t += T;
    if (completesSet(e, b.relCtx)) {
      const groups = new Set();
      for (const x of tiles) {
        const g = b.tile(x.index)?.group;
        const owner = b.ctx.tileState.get(x.index)?.ownerId;
        if (g && owner && completesSet({ type: 'bought', playerId: owner, tileIndex: x.index }, b.relCtx)) groups.add(`${g}|${owner}`);
      }
      for (const key of groups) {
        const [g, owner] = key.split('|');
        setComplete(b, k, g, owner);
      }
    }
  },

  trade_rejected(b, e, k) {
    const { view, ctx } = b;
    const by = e.byPlayerId;
    const trade = tradeOf(b, e.tradeId);
    const withdrawn = trade ? by === trade.fromPlayerId : false;
    b.soft(b.t, () => view.overlay.setTrade(null));
    b.float(b.t, by, withdrawn ? 'Offer withdrawn' : 'No deal', 'info', { chip: ctx.colorOf.get(by) ?? null });
    b.beat('tradeReject', b.t, { pid: by, tradeId: e.tradeId, withdrawn });
    b.t += b.d('tradeReject', k);
  },

  trade_cancelled(b, e, k) {
    b.soft(b.t, () => b.view.overlay.setTrade(null));
    b.beat('tradeCancel', b.t, { tradeId: e.tradeId, reason: e.reason });
    b.t += b.d('tradeCancel', k);
  },
};

// ---- scenes ----------------------------------------------------------------------------------------

/** moved {via:'jail'}: the tow truck scene (2.4 s own, 1.6 s others; letterboxed). */
function towScene(b, e, k) {
  const { view } = b;
  const pid = e.playerId;
  const ver = b.ver(k);
  const own = ver === 'own';
  const t0 = b.t;
  const r = view.chars.scheduleMove(e, t0, { plan: { own }, short: !own }) ?? {};
  const T = Number(r.duration) > 0 ? Number(r.duration) : own ? BUDGET.jail.own : BUDGET.jail.others;
  const f = T / BUDGET.jail.own;
  const cutAt = Number.isFinite(r.cutAt) ? r.cutAt : t0 + 0.95 * f;
  const gateAt = Number.isFinite(r.gateAt) ? r.gateAt : t0 + 1.0 * f;
  const slamAt = Number.isFinite(r.slamAt) ? r.slamAt : t0 + 1.6 * f;
  const scene = ver !== 'others';
  const where = b.spotOf(pid);
  if (scene) b.letterbox(t0, true);
  b.beat('siren', t0, { pid, pos: b.charAt(pid) });
  b.beat('tow', t0 + 0.1 * f, { pid, pos: b.charAt(pid) });
  const d0 = view.director;
  if (d0.auto && d0.style !== 'free') {
    if (own && b.cinematic) {
      if (Number.isInteger(where)) b.shot(t0, (d) => { if (!(d.mode === 'kerb' && d.kerbTile === where)) d.kerb(where, { glide: 0.3 }); });
      b.shot(t0, (d) => d.dollyZoom(31, 0.8));
    } else b.shot(t0, (d) => d.heli(b.charPos(pid)));
    if (scene) b.cutTo(cutAt, (d) => d.establish('jail'), { silent: true });
    if (own && b.cinematic) b.shot(t0 + 1.8 * f, (d) => d.hero(pid, { jail: true }));
    b.street = true;
  }
  b.cues(gateAt, view.landmarks.jailGate(true, gateAt), { pid, tile: 10, pos: address(10) }, { only: ['gate'] });
  b.cues(slamAt, view.landmarks.jailGate(false, slamAt), { pid, tile: 10, pos: address(10) }, { skip: ['jailIn', 'gate'] });
  b.beat('gate', gateAt, { pid, tile: 10, pos: address(10) });
  b.beat('jailIn', slamAt, { pid, tile: 10 });
  b.shot(slamAt, (d) => d.shake(0.08, 0.3));
  b.react(slamAt + 0.2, pid, 'jail');
  b.landTile.set(pid, 10);
  if (scene) b.letterbox(t0 + T - 0.05, false);
  b.t = t0 + T;
  b.moved = true;
}

/** A teleport that isn't jail (steps null): cut + drop-in. */
function dropScene(b, e, k) {
  const { view } = b;
  const pid = e.playerId;
  const to = wrap(e.to);
  const t0 = b.t;
  const r = view.chars.scheduleMove(e, t0, {}) ?? {};
  const T = Number(r.duration) > 0 ? Number(r.duration) : b.d('drop', k);
  if (b.cam(k)) {
    b.cutTo(t0, (d) => d.kerb(to), { silent: true });
    b.street = true;
  }
  b.beat('teleport', t0, { pid, tile: to, pos: address(to) });
  b.landTile.set(pid, to);
  b.t = t0 + T;
  b.moved = true;
  if (!b.events.slice(k + 1).some((x) => x.type === 'landed' && x.playerId === pid)) {
    b.beat('land', b.t, { pid, tile: to, pos: b.charAt(pid) });
    b.t += b.d('land', k);
  }
}

/** A colour set completed: the group's flourish, the cheer, MONOPOLY! (all versions; 1.2 s). */
function setComplete(b, k, group, owner) {
  const { view } = b;
  if (!group || !view.BOARD?.groups?.[group]) return;
  const t0 = b.t;
  const r = view.lots.celebrate(group, { color: b.chip(owner), delay: t0 });
  b.cues(t0, r, { pid: owner, group });
  b.at(t0, () => celebrateSet(view, group));
  const tiles = (view.BOARD.tiles ?? []).filter((t) => t?.group === group).map((t) => t.index);
  if (tiles.length && b.ver(k) === 'own') {
    const a = address(tiles[Math.floor(tiles.length / 2)]);
    b.crowd(t0 + 0.1, { x: a.lot.front.x + a.out.x * 4, y: 0, z: a.lot.front.z + a.out.z * 4 }, 30, { duration: 1.6 });
  }
  b.t += b.d('setComplete', k);
}

/** Mortgages / unmortgages of this batch: the ledger shot and the rituals, 0.12 s apart. */
function ledger(b, k) {
  const { view } = b;
  const list = b.events.map((x, n) => ({ x, n })).filter(({ x }) => x.type === 'mortgaged' || x.type === 'unmortgaged');
  for (const { n } of list) b.handled.add(n);
  const relB = list.map(({ n }) => b.rels[n]).reduce(maxRel, null);
  const ver = versionOf(relB, b.others);
  const tiles = list.map(({ x }) => Number(x.tileIndex)).filter(Number.isInteger);
  const t0 = b.t;
  const T = mortgageTime(list.length, relB, b.others);
  if (view.director.auto && view.director.style !== 'free' && ver === 'own' && tiles.length) {
    const sides = new Set(tiles.map((i) => Math.floor(i / 10)));
    if (sides.size > 1) b.shot(t0, (d) => d.map(true));
    else b.shot(t0, (d) => d.crane([...new Set(tiles)], { height: 12, duration: T }));
    b.street = true;
  }
  list.forEach(({ x }, n) => {
    const i = Number(x.tileIndex);
    const when = t0 + (ver === 'own' ? 0.2 : 0) + n * dur('mortgageStagger', relB, b.others);
    const kind = x.type === 'mortgaged' ? 'mortgage' : 'unmortgage';
    const r = view.lots.ritual(i, kind, when, { own: ver === 'own', color: b.chip(x.playerId) });
    b.cues(when, r, { pid: x.playerId, tile: i, pos: b.lotFront(i, 3) }, { skip: ['stamp', 'unmortgage'] });
    b.beat(kind, when, { pid: x.playerId, tile: i, amount: x.amount, pos: b.lotFront(i, 3) });
    if (ver !== 'others') b.floatTile(when + 0.1, i, `${kind === 'mortgage' ? '+' : '−'}${money(x.amount)}`, kind === 'mortgage' ? 'plus' : 'minus', { chip: b.chip(x.playerId) });
  });
  b.t += T;
}

/** Money between two players (card payments, debts): both halves, HUD flight. */
function payment(b, e, k, beatName, to) {
  const pid = e.playerId;
  b.float(b.t, pid, `−${money(e.amount)}`, 'minus');
  if (to && b.ctx.byId.has(to)) b.float(b.t + 0.3, to, `+${money(e.amount)}`, 'plus', { chip: b.chip(pid) });
  b.beat(beatName, b.t, { pid, to: to ?? null, amount: e.amount, reason: e.reason });
  b.money(b.t + 0.1, pid, to, e.amount);
  b.t += b.d('money', k);
}

// ---- helpers ---------------------------------------------------------------------------------------

/** Does player `pid` still move later in this batch (after event k)? Reactions would fight the walk. */
function laterMove(b, k, pid) {
  return b.events.some((e, n) => n > k && e.type === 'moved' && e.playerId === pid);
}

/** Sample points of a walk's path (remaining from `from` fraction) for the transit fit. */
function pathPoints(path, from = 0) {
  const pts = [];
  const n = 24;
  const s0 = path.s0 + path.dir * path.length * from;
  const len = path.length * (1 - from);
  for (let j = 0; j <= n; j++) {
    const p = pointAt(s0 + path.dir * (len * j) / n, 0);
    pts.push({ x: p.x, z: p.z });
  }
  return pts;
}

/** "→ Park Place · $350 · for sale" / "→ Park Place · rent $35 to Bob". */
function routeText(b, dest, pid) {
  const { ctx } = b;
  const t = b.tile(dest);
  if (!t) return '';
  const name = String(t.name ?? '');
  const ts = ctx.tileState.get(dest);
  const owner = ts?.ownerId && ctx.byId.has(ts.ownerId) ? ts.ownerId : null;
  if (t.type === 'property' || t.type === 'railroad' || t.type === 'utility') {
    if (!owner) return `→ ${name} · ${money(t.price)} · for sale`;
    if (owner === pid) return `→ ${name} · yours`;
    if (ts?.mortgaged) return `→ ${name} · mortgaged`;
    const rent = rentOf(b.view.BOARD, t, ctx, owner, num(ts?.houses));
    return `→ ${name} · rent ${rent} to ${b.view.info.name(ctx, owner)}`;
  }
  if (t.type === 'tax') return `→ ${name} · pay ${money(t.amount)}`;
  return `→ ${name}`;
}

function rentOf(BOARD, tile, ctx, ownerId, houses) {
  const rent = Array.isArray(tile.rent) ? tile.rent : [];
  const ownedBy = (i) => ctx.tileState.get(i)?.ownerId === ownerId;
  if (tile.type === 'property') {
    if (houses > 0) return money(rent[houses]);
    const set = (BOARD?.tiles ?? []).filter((t) => t.type === 'property' && t.group === tile.group).map((t) => t.index);
    return money((rent[0] ?? 0) * (set.length && set.every(ownedBy) ? 2 : 1));
  }
  const count = (BOARD?.tiles ?? []).filter((t) => t.type === tile.type && ownedBy(t.index)).length;
  if (tile.type === 'railroad') return money(rent[Math.max(0, Math.min(count, rent.length) - 1)]);
  return `${tile.multipliers?.[Math.max(0, count - 1)] ?? '?'}× dice`;
}

/** The lower-third for a landing: name · neighbourhood · price or rent · owner. */
function chyronFor(b, i) {
  const { view, ctx } = b;
  const t = b.tile(i);
  if (!t) return null;
  const ts = ctx.tileState.get(i);
  const owner = ts?.ownerId && ctx.byId.has(ts.ownerId) ? ts.ownerId : null;
  const band = t.type === 'property' ? view.BOARD?.groups?.[t.group]?.color ?? null : null;
  const where = placeOf(view.BOARD, i);
  let what = '';
  if (t.type === 'property' || t.type === 'railroad' || t.type === 'utility') {
    if (!owner) what = `For sale · ${money(t.price)}`;
    else if (ts?.mortgaged) what = 'Mortgaged';
    else what = `Rent ${rentOf(view.BOARD, t, ctx, owner, num(ts?.houses))}`;
  } else if (t.type === 'tax') what = `Pay ${money(t.amount)}`;
  else if (t.type === 'free_parking' && ctx.state.settings?.freeParkingPot) what = `Pot ${money(ctx.state.pot)}`;
  return {
    title: String(t.name ?? ''),
    sub: [where, what].filter(Boolean).join(' · '),
    band,
    owner: owner ? { name: view.info.name(ctx, owner), color: ctx.colorOf.get(owner) } : null,
  };
}

function nearestDeckTile(deck, at) {
  const list = deck === 'community' ? [2, 17, 33] : [7, 22, 36];
  if (!Number.isInteger(at)) return list[0];
  let best = list[0];
  let bd = Infinity;
  for (const i of list) {
    const d = Math.abs(sOf(i) - sOf(at));
    const dd = Math.min(d, LOOP - d);
    if (dd < bd) { bd = dd; best = i; }
  }
  return best;
}

/** Ownable tiles the bankrupt player held (the city still shows them as theirs). */
function forecloseTiles(view, ctx, pid) {
  const out = [];
  for (const t of view.BOARD?.tiles ?? []) {
    if (!t || !(t.type === 'property' || t.type === 'railroad' || t.type === 'utility')) continue;
    const vis = view.lots.inspect(t.index);
    if (vis ? vis.owner === pid : false) out.push(t.index);
  }
  if (!out.length) {
    // No lot module to ask: the tiles that changed hands are unknown; use the creditor's tiles.
    for (const ts of ctx.tileState.values()) if (ts?.ownerId === pid) out.push(ts.index);
  }
  return out.slice(0, 28);
}

/** The winner's tallest lot (fireworks), or null. */
function tallestLot(view, ctx, w) {
  let best = null;
  let bh = -1;
  for (const ts of ctx.tileState.values()) {
    if (ts?.ownerId !== w) continue;
    const g = view.BOARD?.tiles?.[ts.index]?.group;
    const h = view.heightOf(g, num(ts.houses)) ?? 0;
    if (h > bh) { bh = h; best = ts.index; }
  }
  return best;
}

/**
 * A completed colour set is celebrated: the 'monopoly' beat — its chime and cheer, a "MONOPOLY!"
 * callout in the owner's colour — and its listeners. Silent while skipping or at "instant".
 */
export function celebrateSet(view, group) {
  try {
    if (view.animator.finishing) return;
    const ctx = view.latest;
    const g = view.BOARD?.groups?.[group];
    if (!ctx || !g || ctx.state.status === 'finished') return;
    const tiles = (view.BOARD.tiles ?? []).filter((t) => t?.group === group).map((t) => t.index);
    const owner = ctx.tileState.get(tiles[0])?.ownerId ?? null;
    const who = owner && ctx.byId.has(owner) ? (owner === ctx.me ? 'You' : view.info.name(ctx, owner)) : null;
    const hood = HOOD[group] ? `${HOOD[group]} · ` : '';
    view.overlay.callout('MONOPOLY!', 'gold', 1600, { sub: who ? `${who} · ${hood}${g.name}` : g.name, color: owner ? ctx.colorOf.get(owner) ?? g.color : g.color });
    const c = tiles.length ? address(tiles[Math.floor(tiles.length / 2)]).lot : null;
    const data = { pid: owner, group, tiles, pos: c ? { x: c.cx, y: 4, z: c.cz } : null };
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

/** Does this batch animate at all with the viewer's `others` setting (instant: only HIGH batches)? */
export function animates(view, ctx, events) {
  return batchAnimates(events, { me: ctx.me, others: view.opts?.others ?? 'short', ctx: { ...ctx, BOARD: view.BOARD, lastTrade: view.lastTrade } });
}

/** Applies the state with no animation (first sight, hidden tab, reduced motion, "instant"). */
export function snapTo(view, ctx, { resetCamera = false, snapCamera = false, events = [] } = {}) {
  const { director, overlay } = view;
  settle(view, ctx, { animate: false });
  const roll = asRoll(ctx.turn.lastRoll);
  const shown = view.hudDice.values;
  if (roll && (resetCamera || !Array.isArray(shown) || shown.join() !== roll.join())) view.hudDice.rest(roll, (Number(ctx.state.seq) || 1) * 31);
  overlay.setTurn(view.info.turn(ctx), false);
  // Cards still need reading when nothing animates: show the last one.
  const card = events.filter((e) => e?.type === 'card_drawn').at(-1);
  if (card) overlay.showCard({ deck: card.deck, who: card.playerId === ctx.me ? 'You' : view.info.name(ctx, card.playerId), text: String(card.text ?? '') });
  if (resetCamera || !director.suspended) aimCamera(view, ctx, { snap: resetCamera || snapCamera, force: resetCamera });
}

/** Points the director at what matters now: a held decision, a trade, else the helicopter. */
export function aimCamera(view, ctx, { snap = false, force = false } = {}) {
  const d = view.director;
  const hold = holdTile(view, ctx);
  const trade = ctx.state.trade;
  if (hold !== null) d.kerb(hold, { hold: true });
  else if (trade && ctx.active) {
    const tiles = [...(trade.give?.tiles ?? []), ...(trade.get?.tiles ?? [])];
    frameTrade(d, view, [trade.fromPlayerId, trade.toPlayerId], tiles);
  } else d.heli(activePos(view, ctx));
  if (snap) d.snap({ force });
}

/** Reconciles characters, lots, landmarks, the overlay and the city clock with ctx. */
export function settle(view, ctx, { animate }) {
  const { chars, lots, landmarks, overlay } = view;
  chars.sync(ctx, { animate, place: true });
  lots.sync(ctx, animate);
  landmarks.sync(ctx, animate);
  lots.setPending(pendingTile(ctx));
  const at = auctionTile(ctx);
  if (at !== null) {
    const a = ctx.state.auction;
    lots.setAuction(at, { bid: num(a.highBid), color: a.highBidderId ? ctx.colorOf.get(a.highBidderId) ?? null : null, name: a.highBidderId ? view.info.name(ctx, a.highBidderId) : '' });
  } else lots.setAuction(null);
  chars.setCurrent(ctx.active ? ctx.currentId : null);
  overlay.setWinner(view.info.winner(ctx));
  overlay.setTurn(view.info.turn(ctx), false);
  overlay.setAuction(auctionInfo(view, ctx));
  overlay.setTrade(ctx.state.trade && ctx.active ? tradeChips({ chip: (id) => ctx.colorOf.get(id) ?? null }, ctx.state.trade) : null);
  if (ctx.state.trade) view.lastTrade = ctx.state.trade;
  overlay.setPins(pinList(view, ctx), (id, out) => chars.headPos(id, out) ?? chars.worldPos(id, out), { lift: 0.6 });
  const lines = ctx.live && Array.isArray(ctx.state.log) ? ctx.state.log.slice(-4).map(String) : [];
  const pot = ctx.state.settings?.freeParkingPot ? ` · Free Parking pot ${money(ctx.state.pot)}` : '';
  overlay.setLog(lines, `Game log${pot}`);
  // The time-lapse, route, counters and letterbox never outlive their batch.
  view.clock.setTarget(1, { snap: true });
  view.ground.clearRoute();
  overlay.routeChip(null);
  overlay.stepCount(null);
  overlay.letterbox(false);
  view.letterboxOn = false;
  view.director.setFovKick(0);
  view.refresh?.(ctx, animate);
}

/** A held decision's tile: the viewer's pending purchase, or a running auction (everyone bids). */
function holdTile(view, ctx) {
  const auction = auctionTile(ctx);
  if (auction !== null) return auction;
  const pending = pendingTile(ctx);
  if (pending === null) return null;
  return ctx.currentId === ctx.me || view.opts?.others === 'full' ? pending : null;
}

function pendingTile(ctx) {
  const i = ctx.active && ctx.turn.phase === 'buying_or_auction' ? ctx.turn.pendingPurchase : null;
  return Number.isInteger(i) ? i : null;
}

function auctionTile(ctx) {
  const i = ctx.active && ctx.state.auction ? ctx.state.auction.tileIndex : null;
  return Number.isInteger(i) ? i : null;
}

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
  const L = address(a.tileIndex).lot;
  const top = view.lots.anchor(a.tileIndex)?.top;
  return {
    tileIndex: a.tileIndex,
    pos: new THREE.Vector3(L.cx, (top?.y ?? 8) + 4, L.cz),
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

function tradeChips(b, t) {
  const tiles = tradeTiles(t).map((x) => {
    const L = address(x.index).lot;
    return { index: x.index, pos: new THREE.Vector3(L.cx, 14, L.cz), color: b.chip(x.to) ?? '#999' };
  });
  return tiles.length ? { tiles } : null;
}

/** Frames a trade: both characters and the lots involved, or the map when they are far apart. */
function frameTrade(d, view, ids, tiles) {
  const pts = [];
  for (const id of ids) {
    const p = view.chars.worldPos(id);
    if (p) pts.push({ x: p.x, z: p.z });
  }
  for (const i of tiles) if (Number.isInteger(i)) { const L = address(i).lot; pts.push({ x: L.cx, z: L.cz }); }
  let far = 0;
  for (const a of pts) for (const c of pts) far = Math.max(far, Math.hypot(a.x - c.x, a.z - c.z));
  if (!pts.length || far > 250) d.map(true);
  else d.frame(pts);
}

function tradeOf(b, tradeId) {
  const p = b.events.find((e) => e.type === 'trade_proposed' && e.tradeId === tradeId);
  if (p) return p;
  const t = b.view.lastTrade;
  return t && t.id === tradeId ? t : null;
}

/** Pins over the characters: every character in the city. */
function pinList(view, ctx) {
  const emoji = (tokenId) => view.BOARD?.tokens?.find((t) => t.id === tokenId)?.emoji ?? '●';
  if (!ctx.live) return [];
  return ctx.players
    .filter((p) => !p.bankrupt)
    .map((p) => ({ id: p.id, color: ctx.colorOf.get(p.id), emoji: emoji(p.token), name: String(p.name ?? ''), current: ctx.active && p.id === ctx.currentId }));
}

/** World {x, z} of the active (or winning) player's character, for the helicopter's lean. */
export function activePos(view, ctx) {
  const id = ctx.currentId ?? ctx.state.winnerId;
  const p = view.chars.worldPos(id);
  if (p) return p;
  const pl = ctx.byId.get(id);
  return Number.isInteger(pl?.position) ? address(pl.position) : null;
}

export function asRoll(v) {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [a, b] = v.map(Number);
  return a >= 1 && a <= 6 && b >= 1 && b <= 6 ? [a, b] : null;
}

/** Legacy: the city is always filmed from the helicopter seat. */
export function seatYaw() {
  return 0;
}

