// public/r3d/pacing.js — how long things take (pure: no three.js, no DOM; Node-testable).
//
// The choreography (choreo.js) lays every batch of engine events out on the shared Animator in
// animation seconds; this module is the single source of those durations:
//   * BUDGET    the beat budgets of the city design (§8.5), own (HIGH) and others ("short", LOW).
//   * relevance how much an event concerns the viewer (§10): HIGH / MED / LOW, plus `big`.
//   * dur       a beat's length for an event of a given relevance and the "others" setting.
//   * estimate  how long a batch will play before its settle (busyUntil for queued states), using
//               the same rules the choreography uses (moves through pathFor + travelPlan).
// Fast (×1.8) and catch-up are the Animator's rate: everything here is before that rate.

import { pathFor, wrap } from './city-layout.js';
import { travelPlan } from './travel.js';

/**
 * Beat budgets (animation seconds at Normal speed). `own` = the viewer's own / HIGH events (and
 * everything with others = 'full'); `others` = LOW events with others = 'short' (heli-only,
 * compressed). MED events and LOW `big` scenes play the own version × MED_SCALE.
 */
export const BUDGET = Object.freeze({
  turnStart: { own: 0.5, others: 0.2 }, // own: the 0.7 s dive overlaps the player's decision
  dice: { own: 0.85, others: 0.5 }, // HUD dice press → rest
  walkEarly: { own: 0.05, others: 0.05 }, // the move sets off this long before the dice rest
  move: { own: 1.8, others: 0.9 }, // caps; travelPlan computes the real T
  drop: { own: 0.45, others: 0.3 }, // teleport (not jail): cut + drop-in
  land: { own: 0.25, others: 0.1 },
  landToCard: { own: 0.1, others: 0.1 },
  buy: { own: 1.4, others: 0.9 },
  setComplete: { own: 1.2, others: 1.2 },
  rent: { own: 1.1, others: 0.6 },
  bigRent: { own: 0.4, others: 0.4 }, // ≥ $1000: letterbox + banknote fan
  tax: { own: 0.9, others: 0.5 },
  card: { own: 1.2, others: 0.8 }, // card draw → its effect starts (the card keeps hanging)
  money: { own: 0.35, others: 0.2 }, // collected / paid / debt_paid
  jail: { own: 2.4, others: 1.6 }, // the tow scene
  sentToJail: { own: 0.3, others: 0.2 },
  leftJail: { own: 0.6, others: 0.4 },
  jailCard: { own: 0.2, others: 0.2 },
  houseLot: { own: 0.6, others: 0.35 }, // one lot's house ritual…
  houseStagger: { own: 0.25, others: 0.12 }, // …the next lot of a group starts this much later
  houses: { own: 1.6, others: 0.8 }, // per colour group (cap)
  housesMap: { own: 0.8, others: 0.8 }, // > 2 groups in one batch: map view, all pop together
  craneIn: { own: 0.35, others: 0 }, // the crane shot settles before the first lot grows
  hotel: { own: 2.2, others: 1.5 },
  sell: { own: 0.6, others: 0.4 }, // per colour group
  mortgage: { own: 1.2, others: 0.6 }, // per batch (cap)
  mortgageLot: { own: 0.6, others: 0.35 },
  mortgageStagger: { own: 0.12, others: 0.12 },
  auctionStart: { own: 0.6, others: 0.5 },
  bid: { own: 0.25, others: 0.15 },
  pass: { own: 0.15, others: 0.1 },
  auctionWon: { own: 1.8, others: 1.3 },
  unsold: { own: 0.6, others: 0.4 },
  tradePropose: { own: 0.6, others: 0.4 },
  trade: { own: 2.2, others: 1.4 },
  tradeReject: { own: 0.4, others: 0.3 },
  tradeCancel: { own: 0.3, others: 0.2 },
  note: { own: 0.15, others: 0.1 }, // debt_started, timeout, debt_reduced floats
  bankrupt: { own: 3.0, others: 3.0 }, // always the full scene
  victory: { own: 7.0, others: 7.0 }, // skippable
  intro: { own: 5.0, others: 5.0 }, // live game_started, cinematic
  introCalm: { own: 4.2, others: 4.2 },
  craneUp: { own: 0.9, others: 0 }, // back to the helicopter (overlaps the next beat)
  linger: { own: 0.9, others: 0 }, // the kerb holds this long after a landing
});

export const MED_SCALE = 0.7; // MED events (and LOW big scenes) on "short": the own scene × 0.7
export const SETTLE_PAD = 0.05; // the settle step comes this long after the last beat
export const OTHERS = ['short', 'full', 'instant'];
const RANK = { low: 0, med: 1, high: 2 };

const MED_TYPES = new Set(['bought', 'card_drawn', 'built', 'sent_to_jail', 'bankrupt', 'auction_started', 'auction_won']);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** The players an event names (actor, payer / payee, owner, trade parties, auction participants). */
export function involved(e, ctx = {}) {
  const ids = new Set();
  if (!e || typeof e !== 'object') return ids;
  for (const k of ['playerId', 'ownerId', 'toPlayerId', 'fromPlayerId', 'byPlayerId', 'winnerId']) {
    if (e[k] != null) ids.add(e[k]);
  }
  for (const p of Array.isArray(e.payees) ? e.payees : []) if (p?.playerId != null) ids.add(p.playerId);
  if (e.type === 'auction_started') for (const id of Array.isArray(e.participants) ? e.participants : []) ids.add(id);
  if (/^auction_/.test(e.type ?? '')) {
    const a = ctx.state?.auction;
    for (const id of Array.isArray(a?.participants) ? a.participants : []) ids.add(id);
  }
  if (/^trade_/.test(e.type ?? '')) {
    const t = ctx.state?.trade?.id === e.tradeId ? ctx.state.trade : ctx.lastTrade?.id === e.tradeId ? ctx.lastTrade : null;
    if (t) { ids.add(t.fromPlayerId); ids.add(t.toPlayerId); }
  }
  return ids;
}

function playersOf(ctx) {
  if (ctx?.byId instanceof Map) return [...ctx.byId.values()];
  if (Array.isArray(ctx?.players)) return ctx.players;
  if (Array.isArray(ctx?.state?.players)) return ctx.state.players;
  return null;
}

function tileOwner(ctx, i) {
  if (!Number.isInteger(i)) return null;
  const ts = ctx?.tileState instanceof Map ? ctx.tileState.get(i) : (ctx?.state?.tiles ?? []).find((t) => t?.index === i);
  return ts?.ownerId ?? null;
}

/**
 * Did this event complete a colour set (in the batch's final state)? bought / auction_won: the
 * buyer now owns the whole group of that tile; trade_accepted: a received tile does.
 */
export function completesSet(e, ctx = {}) {
  const tiles = ctx?.BOARD?.tiles;
  if (!Array.isArray(tiles)) return false;
  const full = (i, owner) => {
    const g = tiles[i]?.type === 'property' ? tiles[i].group : null;
    if (!g || owner == null) return false;
    return tiles.filter((t) => t?.group === g && t.type === 'property').every((t) => tileOwner(ctx, t.index) === owner);
  };
  if (e?.type === 'bought' || e?.type === 'auction_won') return full(Number(e.tileIndex), e.playerId);
  if (e?.type === 'trade_accepted') {
    const give = Array.isArray(e.give?.tiles) ? e.give.tiles : [];
    const get = Array.isArray(e.get?.tiles) ? e.get.tiles : [];
    return give.some((i) => full(i, e.toPlayerId)) || get.some((i) => full(i, e.fromPlayerId));
  }
  return false;
}

/**
 * How much an event concerns the viewer (§10, bible §2.0.2).
 *   HIGH: the viewer is the actor / payer / owner / recipient / party / auction participant, their
 *         lots are affected, or game_over.
 *   MED:  another player's buy, card, build, hotel, jail, bankruptcy, auction start / win, set
 *         completion, rent ≥ $200; for spectators, the active player's events.
 *   LOW:  the rest.
 *   big:  hotel, jail, bankruptcy, game over, rent ≥ $1000, auction won, set completed.
 * @param {object} e   engine event
 * @param {object} ctx { me, currentId?, byId? | players? | state?, tileState?, BOARD?, lastTrade? }
 * @returns {{level:'high'|'med'|'low', big:boolean}}
 */
export function relevance(e, ctx = {}) {
  const type = e?.type;
  const me = ctx?.me ?? null;
  const amount = num(e?.amount);
  const hotel = type === 'built' && num(e?.houses) === 5;
  const jail = type === 'sent_to_jail' || (type === 'moved' && e?.via === 'jail');
  const setDone = completesSet(e, ctx);
  const big = type === 'game_over' || hotel || jail || type === 'bankrupt' || (type === 'paid_rent' && amount >= 1000)
    || type === 'auction_won' || setDone;
  if (type === 'game_over') return { level: 'high', big: true };
  if (me != null) {
    if (involved(e, ctx).has(me)) return { level: 'high', big };
    // The viewer's lots are affected (someone lands on them, builds / mortgages there — never another player).
    const tile = Number.isInteger(e?.tileIndex) ? e.tileIndex : null;
    if (tile !== null && tileOwner(ctx, tile) === me && type !== 'bought' && type !== 'auction_won') return { level: 'high', big };
    if (type === 'auction_bid' || type === 'auction_passed' || type === 'auction_won' || type === 'auction_unsold') {
      // Everyone at the table takes part in an auction (non-bankrupt players when it started).
      const pl = playersOf(ctx)?.find((p) => p?.id === me);
      if (pl && !pl.bankrupt && !ctx.state?.auction) return { level: 'high', big };
    }
  }
  if (MED_TYPES.has(type) || jail || setDone || (type === 'paid_rent' && amount >= 200)) return { level: 'med', big };
  const list = playersOf(ctx);
  const seated = me != null && (list ? list.some((p) => p?.id === me) : true);
  if (!seated && e?.playerId != null && e.playerId === ctx?.currentId) return { level: 'med', big };
  return { level: 'low', big };
}

/** The higher of two relevance results. */
export function maxRel(a, b) {
  if (!a) return b;
  if (!b) return a;
  return { level: RANK[a.level] >= RANK[b.level] ? a.level : b.level, big: !!(a.big || b.big) };
}

/** Which version of a beat plays: 'own' (full scene), 'med' (own × MED_SCALE) or 'others' (heli-only). */
export function versionOf(rel, others = 'short') {
  if (others === 'full' || rel?.level === 'high') return 'own';
  if (rel?.level === 'med' || rel?.big) return 'med';
  return 'others';
}

/** A beat's length (animation s) for an event of relevance `rel` with the "others" setting. */
export function dur(name, rel, others = 'short') {
  const b = BUDGET[name];
  if (!b) return 0;
  const v = versionOf(rel, others);
  return v === 'own' ? b.own : v === 'med' ? b.own * MED_SCALE : b.others;
}

/** Does a batch play at all with others = 'instant' (only batches with a HIGH event animate)? */
export function batchAnimates(events, { me = null, others = 'short', ctx = null } = {}) {
  if (others !== 'instant') return true;
  const c = { ...(ctx ?? {}), me: me ?? ctx?.me ?? null };
  return (events ?? []).some((e) => e && typeof e === 'object' && relevance(e, c).level === 'high');
}

/**
 * The travel plan of a walk (`moved` with integer steps) for relevance `rel`: the viewer's own /
 * HIGH walks (and MED / full) use the own planner, LOW ones the compressed one. MED walks play the
 * own plan × MED_SCALE (speed 1 / 0.7).
 */
export function movePlan(e, rel, { others = 'short', tokenId = 'pawn' } = {}) {
  const steps = Number.isInteger(e?.steps) ? e.steps : null;
  if (steps === null || steps === 0) return null;
  const path = pathFor(wrap(e.from), steps);
  const v = versionOf(rel, others);
  const plan = travelPlan({ length: path.length, tokenId, own: v !== 'others', speed: v === 'med' ? 1 / MED_SCALE : 1 });
  return { path, plan, version: v };
}

/** Builds in one batch, grouped by colour group (in order of first appearance). */
export function buildGroups(events, BOARD = null) {
  const groups = new Map();
  for (const e of events ?? []) {
    if (e?.type !== 'built') continue;
    const i = Number(e.tileIndex);
    const g = BOARD?.tiles?.[i]?.group ?? `tile${i}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  return [...groups.values()];
}

/** Time a group of house builds takes (lots grow one after another, capped per group). */
export function housesTime(n, rel, others = 'short') {
  if (n <= 0) return 0;
  const lot = dur('houseLot', rel, others);
  const stagger = dur('houseStagger', rel, others);
  return Math.min(dur('houses', rel, others), lot + stagger * (n - 1));
}

/** Time a batch of mortgages / unmortgages takes. */
export function mortgageTime(n, rel, others = 'short') {
  if (n <= 0) return 0;
  return Math.min(dur('mortgage', rel, others), dur('mortgageLot', rel, others) + dur('mortgageStagger', rel, others) * (n - 1));
}

/**
 * Rough length (animation s, before the Animator rate) of a batch before its settle — the same
 * beats the choreography lays out. Used by busyUntil() for states waiting in the queue.
 * @param {object[]} events
 * @param {{me?:string|null, others?:'short'|'full'|'instant', ctx?:object, calm?:boolean}} [opts]
 */
export function estimate(events, { me = null, others = 'short', ctx = null, calm = false } = {}) {
  try {
    const list = (Array.isArray(events) ? events : []).filter((e) => e && typeof e === 'object');
    if (!list.length) return 0;
    const c = { ...(ctx ?? {}), me: me ?? ctx?.me ?? null };
    if (!batchAnimates(list, { me: c.me, others, ctx: c })) return 0;
    const rels = list.map((e) => relevance(e, c));
    const token = (pid) => (c.byId instanceof Map ? c.byId.get(pid)?.token : null) ?? 'pawn';
    let t = 0;
    let diceEnd = 0;
    let builds = null; // built events are batched per group (handled at the first one)
    let mortgages = null;
    for (let k = 0; k < list.length; k++) {
      const e = list[k];
      const rel = rels[k];
      const d = (name) => dur(name, rel, others);
      switch (e.type) {
        case 'game_started': t += calm ? BUDGET.introCalm.own : BUDGET.intro.own; break;
        case 'turn_started': t += d('turnStart'); break;
        case 'dice_rolled': {
          const full = d('dice');
          diceEnd = t + full;
          t += e.purpose === 'utility' || e.purpose === 'jail' ? full : full - d('walkEarly');
          break;
        }
        case 'moved': {
          if (e.via === 'jail') {
            t += versionOf(rel, others) === 'own' ? BUDGET.jail.own : BUDGET.jail.others;
            break;
          }
          const mp = movePlan(e, rel, { others, tokenId: token(e.playerId) });
          if (!mp) { t += d('drop'); break; }
          t += mp.plan.T;
          if (!list.slice(k + 1).some((x) => x.type === 'landed')) t += d('land');
          break;
        }
        case 'landed': t += list[k + 1]?.type === 'card_drawn' ? d('landToCard') : d('land'); break;
        case 'card_drawn': t += d('card'); break;
        case 'bought': t += d('buy') + (completesSet(e, c) ? d('setComplete') : 0); break;
        case 'paid_rent': t += d('rent') + (num(e.amount) >= 1000 ? d('bigRent') : 0); break;
        case 'paid_tax': t += d('tax'); break;
        case 'paid': case 'collected': case 'debt_paid': t += d('money'); break;
        case 'sent_to_jail': t += d('sentToJail'); break;
        case 'left_jail': t += d('leftJail'); break;
        case 'jail_card_received': t += d('jailCard'); break;
        case 'built': {
          if (builds) break;
          builds = buildGroups(list, c.BOARD);
          const relB = list.filter((x) => x.type === 'built').map((x) => relevance(x, c)).reduce(maxRel, null);
          const hotels = list.filter((x) => x.type === 'built' && num(x.houses) === 5).length;
          if (builds.length > 2) t += dur('housesMap', relB, others) + (hotels ? dur('hotel', relB, others) * 0.5 : 0);
          else {
            for (const g of builds) {
              const h = g.filter((x) => num(x.houses) === 5).length;
              const n = g.length - h;
              if (n) t += dur('craneIn', relB, others) + housesTime(n, relB, others);
              if (h) t += dur('hotel', relB, others) + (h - 1) * dur('houseStagger', relB, others);
            }
          }
          break;
        }
        case 'sold_house': {
          if (list.findIndex((x) => x.type === 'sold_house') !== k) break;
          const n = new Set(list.filter((x) => x.type === 'sold_house').map((x) => c.BOARD?.tiles?.[x.tileIndex]?.group ?? x.tileIndex)).size;
          t += d('sell') * n;
          break;
        }
        case 'mortgaged': case 'unmortgaged': {
          if (mortgages) break;
          mortgages = list.filter((x) => x.type === 'mortgaged' || x.type === 'unmortgaged');
          t += mortgageTime(mortgages.length, rel, others);
          break;
        }
        case 'auction_started': t += d('auctionStart'); break;
        case 'auction_bid': t += d('bid'); break;
        case 'auction_passed': t += d('pass'); break;
        case 'auction_won': t += d('auctionWon') + (completesSet(e, c) ? d('setComplete') : 0); break;
        case 'auction_unsold': t += d('unsold'); break;
        case 'trade_proposed': t += d('tradePropose'); break;
        case 'trade_accepted': t += d('trade') + (completesSet(e, c) ? d('setComplete') : 0); break;
        case 'trade_rejected': t += d('tradeReject'); break;
        case 'trade_cancelled': t += d('tradeCancel'); break;
        case 'debt_started': case 'timeout': case 'debt_reduced': t += d('note'); break;
        case 'bankrupt': t += versionOf(rel, others) === 'others' ? BUDGET.bankrupt.others : d('bankrupt'); break;
        case 'game_over': t += BUDGET.victory.own; break;
        default: break;
      }
    }
    return Math.max(t, diceEnd) + SETTLE_PAD;
  } catch {
    return 0;
  }
}
