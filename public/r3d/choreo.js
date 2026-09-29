// public/r3d/choreo.js — turns one batch of engine events (CONTRACT §6) into a short timeline on
// the shared Animator: dice shot → token walk → landing beat → money / cards / buildings → settle.
//
// Rules (Monopoly Plus feel, minus its slowness):
//   * State is the truth. The timeline always ends with a "settle" step that reconciles every token,
//     owner marker, building and district with the batch's state, so skipping (finishAll) lands on
//     the truth.
//   * The camera frames each moment: dice in the plaza, the walking token, the landing tile, the
//     tile being built on. Teleports (card / jail) cut ahead to the destination instead of chasing.
//   * A newer state arriving mid-timeline doesn't snap: the running timeline speeds up (×3) and the
//     new batch plays when it settles (renderer3d.js queues it). A click / Esc skips everything.
//   * Nothing here blocks the UI: ui.js keeps its own buttons live the whole time.

import * as THREE from './three.js';
import { outward, tileCenter, SIDE_YAW } from './layout.js';

// ---- tuning knobs ---------------------------------------------------------------------------------
const DICE_READ = 0.25; // beat between the dice coming to rest and the token setting off
const LAND_BEAT = 0.3;
const CARD_BEAT = 1.6; // the card flies up and is read before it moves the token
const CARD_HOLD = 1.15; // seconds the 3D card hangs in front of the camera
const FOCUS_HOLD = 0.8; // the camera lingers on a landing before going back to the overview
const BUILD_HOLD = 1.4; // …and on a tile being built on / sold / mortgaged
const CAMERA_LEAD = 0.6; // the camera starts moving to a building tile this long before the pop
export const QUEUE_SPEEDUP = 3; // a newer state plays the rest of the running timeline this much faster
// Seats around the table, in join order (the viewer's side for the overview); spectators sit at GO.
const SEATS = ['bottom', 'left', 'top', 'right'];

const money = (n) => `$${Math.abs(Math.round(Number(n) || 0))}`;

/**
 * Plays `events` for the new state in `ctx`.
 * @param {object} view  { animator, tokens, dice, board, city, cards, fx, overlay, director, BOARD, info }
 * @param {object} ctx   render context (renderer3d.makeCtx)
 * @param {object[]} events
 */
export function playBatch(view, ctx, events) {
  const { animator, tokens, dice, board, overlay, director } = view;
  const batch = ++view.batchSeq;
  view.running = batch;
  const current = () => view.batchSeq === batch; // false once a newer batch took over
  const types = new Set(events.map((e) => e?.type));
  director.setSeat(seatYaw(ctx));
  if (director.mode === 'orbit' && ctx.state.status !== 'finished') director.overview(activePos(view, ctx));

  // New players' tokens appear in place (popping in at game start); walkers keep their position.
  const leaving = new Set(events.filter((e) => e?.type === 'bankrupt').map((e) => e.playerId));
  tokens.sync(ctx, { animate: true, place: false, popNew: types.has('game_started'), keep: leaving });
  if (!types.has('turn_started')) overlay.setTurn(view.info.turn(ctx), false);

  let t = 0;
  let diceEnd = 0;
  let moved = false;
  let focused = false; // the camera went close: come back to the overview at the end
  let lingerFor = FOCUS_HOLD;
  let buildFocus = null; // tile the camera pushed in on for building / mortgaging
  const goAt = new Map(); // playerId → time the current walk crosses GO
  let jailBars = false;
  const above = (id, dy = 0.95) => {
    const p = tokens.worldPos(id);
    return p ? p.setY(p.y + dy) : null;
  };
  const overTile = (i, dy = 0.9) => {
    const c = tileCenter(i);
    return new THREE.Vector3(c.x, dy, c.z);
  };
  const fx = (at, fn) => animator.at(Math.max(0, at), fn);
  const float = (at, id, text, kind, opts, dy) => fx(at, () => overlay.float(above(id, dy), text, kind, opts));
  const SECOND = 1.5; // height of the second label over a token (the other party's half)
  const name = (id) => (id === ctx.me ? 'you' : view.info.name(ctx, id));
  const chip = (id) => ctx.colorOf.get(id) ?? null;
  /** Push in on a tile for building / mortgaging (once per batch; not while the player has the camera). */
  const pushIn = (i) => {
    if (buildFocus === i) return;
    const first = buildFocus === null;
    buildFocus = i;
    fx(t, () => { if (!director.suspended) director.focus(i); });
    if (first) t += CAMERA_LEAD;
    focused = true;
    lingerFor = Math.max(lingerFor, BUILD_HOLD);
  };

  events.forEach((e, k) => {
    if (!e || typeof e !== 'object') return;
    const pid = e.playerId;
    switch (e.type) {
      case 'dice_rolled': {
        const values = Array.isArray(e.dice) && e.dice.length === 2 ? e.dice.map(Number) : null;
        if (!values || values.some((v) => !(v >= 1 && v <= 6))) break;
        const tok = tokens.get(pid);
        const from = outward(tok?.spot.index ?? 0);
        const seed = ((Number(ctx.state.seq) || 0) * 31 + k * 7) >>> 0;
        fx(t, () => director.dice());
        const dur = dice.schedule(values, from, seed, t, { small: e.purpose === 'utility' });
        diceEnd = t + dur;
        const total = values[0] + values[1];
        const doubles = values[0] === values[1];
        fx(diceEnd - 0.1, () => overlay.callout(doubles ? `DOUBLES! ${total}` : `${total}`, doubles ? 'doubles' : 'total', doubles ? 1300 : 900));
        t = diceEnd + DICE_READ;
        break;
      }
      case 'moved': {
        const tok = tokens.get(pid);
        if (!tok) break;
        const start = t;
        const r = tokens.scheduleMove(e, t);
        if (r.kind === 'hop') fx(start, () => director.follow(tok.root));
        else if (r.kind === 'zip') fx(start, () => director.overview(tokens.worldPos(pid)));
        else if (r.kind === 'arc') {
          // Don't chase a token flying over the board: cut to a wide shot of the destination (it
          // flies into frame), then push in as it lands.
          const to = Number(e.to);
          fx(start, () => {
            director.focus(to, { wide: true });
            director.cut();
          });
          fx(start + r.duration - 0.1, () => director.focus(to));
        }
        if (r.goAt !== null) goAt.set(pid, r.goAt);
        t += r.duration;
        moved = true;
        if (e.via === 'jail' || jailBars) {
          board.cageBounce(t - 0.05);
          jailBars = false;
        }
        break;
      }
      case 'passed_go': {
        const at = goAt.get(pid) ?? t;
        goAt.delete(pid);
        fx(at, () => board.flash(0, 0.7));
        float(at, pid, `+${money(e.amount)}`, 'gold');
        break;
      }
      case 'landed': {
        const i = Number(e.tileIndex);
        fx(t, () => {
          board.flash(i);
          director.focus(i);
        });
        focused = true;
        t += LAND_BEAT;
        break;
      }
      case 'card_drawn': {
        board.drawCard(e.deck, t);
        const who = pid === ctx.me ? 'You' : view.info.name(ctx, pid);
        const text = String(e.text ?? '');
        view.cards.schedule({ deck: e.deck, text, who }, t, CARD_HOLD);
        fx(t + 0.35, () => overlay.showCard({ deck: e.deck, who, text }));
        t += CARD_BEAT;
        break;
      }
      case 'paid_rent':
      case 'paid':
      case 'debt_paid': {
        const to = e.type === 'paid_rent' ? e.ownerId : e.toPlayerId;
        float(t, pid, `−${money(e.amount)}`, 'minus');
        // The receiver's half, next to the payer (the receiver is rarely in shot).
        if (to && ctx.byId.has(to)) float(t + 0.3, pid, `+${money(e.amount)} → ${name(to)}`, 'plus', { chip: chip(to) }, SECOND);
        t += e.type === 'paid_rent' ? 0.45 : 0.2;
        break;
      }
      case 'paid_tax':
        float(t, pid, `−${money(e.amount)}`, 'minus');
        t += 0.2;
        break;
      case 'collected':
        float(t, pid, `+${money(e.amount)}`, 'plus');
        if (e.fromPlayerId && ctx.byId.has(e.fromPlayerId)) float(t + 0.25, pid, `−${money(e.amount)} from ${name(e.fromPlayerId)}`, 'minus', { chip: chip(e.fromPlayerId) }, SECOND);
        t += 0.15;
        break;
      case 'bought': {
        const i = Number(e.tileIndex);
        fx(t, () => {
          director.focus(i);
          syncOne(view, ctx, i, true);
          view.city.sync(ctx, true);
        });
        fx(t + 0.1, () => overlay.float(overTile(i), `−${money(e.price)}`, 'minus', { chip: chip(pid) }));
        focused = true;
        t += 0.5;
        break;
      }
      case 'declined':
        focused = true; // let go of the held tile → back to the overview
        break;
      case 'built':
      case 'sold_house': {
        const i = Number(e.tileIndex);
        pushIn(i);
        fx(t, () => {
          syncOne(view, ctx, i, true);
          view.city.sync(ctx, true);
        });
        const cost = Number(view.BOARD.tiles[i]?.houseCost) || 0;
        const amount = e.type === 'built' ? cost : Number(e.amount) || 0; // sold_house: the refund (may cover several levels)
        if (amount) fx(t + 0.15, () => overlay.float(overTile(i), e.type === 'built' ? `−${money(amount)}` : `+${money(amount)}`, e.type === 'built' ? 'minus' : 'plus', { chip: chip(pid) }));
        t += 0.3;
        break;
      }
      case 'mortgaged':
      case 'unmortgaged': {
        const i = Number(e.tileIndex);
        pushIn(i);
        fx(t, () => {
          syncOne(view, ctx, i, true);
          view.city.sync(ctx, true);
        });
        fx(t + 0.1, () => overlay.float(overTile(i), e.type === 'mortgaged' ? `+${money(e.amount)}` : `−${money(e.amount)}`, e.type === 'mortgaged' ? 'plus' : 'minus', { chip: chip(pid) }));
        t += 0.25;
        break;
      }
      case 'sent_to_jail':
        fx(t, () => overlay.callout('GO TO JAIL!', 'alert', 1100));
        jailBars = true;
        t += 0.3;
        break;
      case 'left_jail':
        float(t, pid, 'Out of jail', 'info');
        t += 0.2;
        break;
      case 'jail_roll_failed':
        float(Math.max(t, diceEnd), pid, 'No doubles', 'info');
        break;
      case 'jail_card_received':
        float(t, pid, 'Get Out of Jail Free', 'gold');
        break;
      case 'debt_started':
        float(t, pid, `Owes ${money(e.amount)}`, 'minus');
        break;
      case 'bankrupt': {
        const tok = tokens.get(pid);
        fx(t, () => {
          overlay.callout('BANKRUPT!', 'alert', 1200);
          if (tok?.visible && !director.suspended) director.focus(tok.spot.index);
        });
        focused = true;
        t += tokens.sink(pid, t + 0.2) + 0.2;
        break;
      }
      case 'timeout':
        float(t, pid, "Time's up", 'info');
        break;
      case 'turn_started': {
        fx(t, () => {
          overlay.setTurn(view.info.turn(ctx), true);
          tokens.setCurrent(ctx.active ? pid : null);
          if (!director.pinned) director.resume();
          director.overview(tokens.worldPos(pid));
        });
        break;
      }
      case 'game_over': {
        fx(t, () => {
          const w = tokens.get(e.winnerId);
          if (w?.visible) {
            director.orbit(w.root, 10);
            view.fx.confettiAt(w.root.position, 0.2);
          }
        });
        break;
      }
      default:
        break;
    }
  });

  // Settle: everything converges on the state of this batch; then a queued newer batch starts.
  const end = Math.max(t, diceEnd) + 0.05;
  view.settleItem = fx(end, () => {
    // The same state may have been re-sent meanwhile (connection flags, timers): use the latest copy.
    const latest = view.latest && view.latest.state?.seq === ctx.state?.seq ? view.latest : ctx;
    settle(view, latest, { animate: true });
    if (view.running === batch) view.running = null;
    const q = view.queued;
    if (q) {
      view.queued = null;
      playBatch(view, q.ctx, q.events);
    }
  });
  const pending = pendingTile(ctx);
  if (pending !== null) {
    fx(end, () => { if (current()) director.focus(pending, { hold: true }); });
  } else if ((moved || focused) && !types.has('turn_started') && !types.has('game_over')) {
    fx(end + (moved ? lingerFor : lingerFor * 0.75), () => {
      if (current() && director.mode !== 'orbit') director.overview(activePos(view, ctx));
    });
  }
}

/** Rough length (s) of a batch before its settle step (for busyUntil while it waits in the queue). */
export function estimate(events) {
  let s = 0.1;
  for (const e of events) {
    switch (e?.type) {
      case 'dice_rolled': s += 1.1 + DICE_READ; break;
      case 'moved': {
        const n = Number.isInteger(e.steps) ? Math.abs(e.steps) : 0;
        const walk = Math.min(Math.max(2.2, 0.16 * n), 0.22 * n); // tokens.js hop timing
        s += e.via === 'roll' || (e.via === 'card' && n <= 6) ? walk : e.via === 'card' && n > 6 ? 1.4 : 0.9;
        break;
      }
      case 'landed': s += LAND_BEAT; break;
      case 'card_drawn': s += CARD_BEAT; break;
      case 'bought': s += 0.5; break;
      case 'built': case 'sold_house': case 'mortgaged': case 'unmortgaged': s += 0.35; break;
      case 'bankrupt': s += 1.1; break;
      default: s += 0.1; break;
    }
  }
  return s;
}

/** Applies the state with no animation (first sight, hidden tab, reduced motion). */
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
  if (resetCamera || !director.suspended) aimCamera(view, ctx, { snap: resetCamera || snapCamera });
}

/** Points the director at what matters now: a pending purchase, else the overview. */
export function aimCamera(view, ctx, { snap = false } = {}) {
  view.director.setSeat(seatYaw(ctx));
  const pending = pendingTile(ctx);
  if (pending !== null) view.director.focus(pending, { hold: true });
  else view.director.overview(activePos(view, ctx));
  if (snap) view.director.snap();
}

/** Reconciles tokens, board pieces, the city, highlights, banners and the log with ctx. */
export function settle(view, ctx, { animate }) {
  const { tokens, board, overlay } = view;
  tokens.sync(ctx, { animate, place: true });
  board.sync(ctx, animate);
  view.city.sync(ctx, animate);
  board.setPending(pendingTile(ctx));
  tokens.setCurrent(ctx.active ? ctx.currentId : null);
  overlay.setWinner(view.info.winner(ctx));
  overlay.setTurn(view.info.turn(ctx), false);
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

function pendingTile(ctx) {
  const i = ctx.active && ctx.turn.phase === 'buying_or_auction' ? ctx.turn.pendingPurchase : null;
  return Number.isInteger(i) ? i : null;
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
