// public/r3d/pacing.js — the 3D city's beat budgets (city design §8.5), relevance classes (§10)
// and the batch estimate behind busyUntil(). Pure module: no three.js, no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUDGET, MED_SCALE, SETTLE_PAD, relevance, estimate, dur, versionOf, movePlan, batchAnimates, completesSet, housesTime,
} from '../public/r3d/pacing.js';
import { pathFor } from '../public/r3d/city-layout.js';
import { travelPlan } from '../public/r3d/travel.js';

const BOARD = {
  tiles: Array.from({ length: 40 }, (_, i) => ({ index: i, type: 'go', name: `T${i}` })),
};
for (const [g, list] of Object.entries({ brown: [1, 3], lightblue: [6, 8, 9], pink: [11, 13, 14], orange: [16, 18, 19], red: [21, 23, 24], yellow: [26, 27, 29], green: [31, 32, 34], darkblue: [37, 39] })) {
  for (const i of list) BOARD.tiles[i] = { index: i, type: 'property', group: g, name: `P${i}` };
}
for (const i of [7, 22, 36]) BOARD.tiles[i] = { index: i, type: 'chance', name: 'Chance' };
for (const i of [2, 17, 33]) BOARD.tiles[i] = { index: i, type: 'community', name: 'Community Chest' };

/** A render context like renderer3d's makeCtx (only what pacing reads). */
function ctx({ me = 'p1', current = 'p1', owners = {}, players = ['p1', 'p2', 'p3'], auction = null } = {}) {
  const list = players.map((id, k) => ({ id, name: id, token: ['car', 'dog', 'hat', 'ship'][k % 4], bankrupt: false }));
  return {
    me,
    currentId: current,
    players: list,
    byId: new Map(list.map((p) => [p.id, p])),
    tileState: new Map(Object.entries(owners).map(([i, o]) => [Number(i), { index: Number(i), ownerId: o, houses: 0, mortgaged: false }])),
    state: { auction, trade: null, players: list },
    BOARD,
  };
}

const rollBatch = (pid, from, a, b) => {
  const steps = a + b;
  return [
    { type: 'dice_rolled', playerId: pid, dice: [a, b], doubles: a === b, purpose: 'move' },
    { type: 'moved', playerId: pid, from, to: (from + steps) % 40, steps, via: 'roll' },
    { type: 'landed', playerId: pid, tileIndex: (from + steps) % 40 },
  ];
};
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };

test('own roll → landed: ≤ 3.0 s from every start and every roll 2–12, median ≤ 2.5 s', () => {
  const c = ctx();
  const times = [];
  for (let from = 0; from < 40; from++) {
    for (let a = 1; a <= 6; a++) {
      for (let b = 1; b <= 6; b++) {
        const t = estimate(rollBatch('p1', from, a, b), { me: 'p1', ctx: c });
        assert.ok(t <= 3.0, `from ${from} roll ${a}+${b}: ${t.toFixed(3)} s`);
        assert.ok(t >= 1.5, `from ${from} roll ${a}+${b}: suspiciously short ${t}`);
        times.push(t);
      }
    }
  }
  assert.ok(median(times) <= 2.5, `median ${median(times)}`);
});

test("another player's roll on 'short' (LOW, helicopter only) ≤ 1.6 s; 'full' plays the own version", () => {
  const c = ctx({ current: 'p2' });
  for (let from = 0; from < 40; from++) {
    for (let r = 2; r <= 12; r++) {
      const batch = rollBatch('p2', from, Math.min(6, r - 1), r - Math.min(6, r - 1));
      const short = estimate(batch, { me: 'p1', others: 'short', ctx: c });
      assert.ok(short <= 1.6, `from ${from} roll ${r}: ${short}`);
      const full = estimate(batch, { me: 'p1', others: 'full', ctx: c });
      const own = estimate(rollBatch('p1', from, Math.min(6, r - 1), r - Math.min(6, r - 1)), { me: 'p1', ctx: ctx() });
      assert.ok(Math.abs(full - own) < 1e-9, `full ${full} own ${own}`);
      assert.ok(short < full);
    }
  }
});

test("others = 'instant': batches without a HIGH event snap (0), the viewer's own still animate", () => {
  const c = ctx({ current: 'p2' });
  assert.equal(estimate(rollBatch('p2', 5, 3, 4), { me: 'p1', others: 'instant', ctx: c }), 0);
  assert.equal(batchAnimates(rollBatch('p2', 5, 3, 4), { me: 'p1', others: 'instant', ctx: c }), false);
  assert.ok(estimate(rollBatch('p1', 5, 3, 4), { me: 'p1', others: 'instant', ctx: ctx() }) > 1.5);
  // Rent paid TO the viewer is HIGH even on someone else's turn.
  const rent = [{ type: 'paid_rent', playerId: 'p2', ownerId: 'p1', tileIndex: 39, amount: 50 }];
  assert.ok(estimate(rent, { me: 'p1', others: 'instant', ctx: c }) > 0);
});

test('a roll that draws a card: roll → card → its effect ≤ 4.6 s', () => {
  const c = ctx();
  let n = 0;
  for (let from = 0; from < 40; from++) {
    for (let r = 2; r <= 12; r++) {
      const to = (from + r) % 40;
      if (![2, 7, 17, 22, 33, 36].includes(to)) continue;
      const a = Math.min(6, r - 1);
      const batch = [
        ...rollBatch('p1', from, a, r - a),
        { type: 'card_drawn', playerId: 'p1', deck: [7, 22, 36].includes(to) ? 'chance' : 'community', cardId: 1, text: 'Bank pays you dividend of $50.' },
        { type: 'collected', playerId: 'p1', fromPlayerId: null, amount: 50, reason: 'card' },
      ];
      const t = estimate(batch, { me: 'p1', ctx: c });
      assert.ok(t <= 4.6, `from ${from} roll ${r}: ${t}`);
      n++;
    }
  }
  assert.ok(n > 30);
});

test('ceremony budgets: buy 1.4, hotel ≤ 2.2, a house group ≤ 1.6, bankruptcy ≤ 3.0, others compressed', () => {
  const c = ctx();
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(estimate([{ type: 'bought', playerId: 'p1', tileIndex: 6, price: 100 }], { me: 'p1', ctx: c }), BUDGET.buy.own + SETTLE_PAD));
  assert.equal(BUDGET.buy.own, 1.4);
  const hotel = estimate([{ type: 'built', playerId: 'p1', tileIndex: 39, houses: 5 }], { me: 'p1', ctx: c });
  assert.ok(hotel <= 2.2 + SETTLE_PAD, `hotel ${hotel}`);
  const houses = [11, 13, 14].map((i) => ({ type: 'built', playerId: 'p1', tileIndex: i, houses: 1 }));
  const h = estimate(houses, { me: 'p1', ctx: c });
  assert.ok(h <= BUDGET.craneIn.own + 1.6 + SETTLE_PAD, `houses ${h}`);
  assert.ok(housesTime(3, { level: 'high' }) <= 1.6);
  assert.ok(housesTime(9, { level: 'high' }) <= 1.6);
  const bk = estimate([{ type: 'bankrupt', playerId: 'p1', toPlayerId: 'p2', cash: 0, reason: 'debt' }], { me: 'p1', ctx: c });
  assert.ok(bk <= 3.0 + SETTLE_PAD, `bankrupt ${bk}`);
  // Someone else's buy (MED) is the own scene × 0.7; their small rent (LOW) the short version.
  const oc = ctx({ current: 'p2' });
  const ob = estimate([{ type: 'bought', playerId: 'p2', tileIndex: 6, price: 100 }], { me: 'p1', ctx: oc });
  assert.ok(near(ob, BUDGET.buy.own * MED_SCALE + SETTLE_PAD), `others' buy ${ob}`);
  const rent = estimate([{ type: 'paid_rent', playerId: 'p2', ownerId: 'p3', tileIndex: 6, amount: 30 }], { me: 'p1', ctx: oc });
  assert.ok(near(rent, BUDGET.rent.others + SETTLE_PAD), `others' rent ${rent}`);
  // > 2 colour groups in one batch: the map view, everything at once.
  const many = [1, 3, 6, 8, 9, 11, 13, 14].map((i) => ({ type: 'built', playerId: 'p1', tileIndex: i, houses: 1 }));
  assert.ok(estimate(many, { me: 'p1', ctx: c }) <= BUDGET.housesMap.own + SETTLE_PAD + 1e-9);
});

test('the jail tow: 2.4 s own, 1.6 s for others; advance-to card walks ≤ 1.8 s', () => {
  const c = ctx();
  const tow = [{ type: 'sent_to_jail', playerId: 'p1', reason: 'tile' }, { type: 'moved', playerId: 'p1', from: 30, to: 10, steps: null, via: 'jail' }];
  const own = estimate(tow, { me: 'p1', ctx: c });
  assert.ok(Math.abs(own - (BUDGET.sentToJail.own + 2.4 + SETTLE_PAD)) < 1e-9, `own tow ${own}`);
  const oc = ctx({ current: 'p2' });
  const other = estimate(tow.map((e) => ({ ...e, playerId: 'p2' })), { me: 'p1', ctx: oc });
  assert.ok(Math.abs(other - (BUDGET.sentToJail.own * MED_SCALE + 1.6 + SETTLE_PAD)) < 1e-9, `others' tow ${other}`);
  for (let from = 0; from < 40; from++) {
    const steps = (39 - from + 40) % 40 || 40;
    const mp = movePlan({ type: 'moved', playerId: 'p1', from, to: 39, steps, via: 'card' }, { level: 'high' });
    assert.ok(mp.plan.T <= 1.8 + 1e-9, `advance from ${from}: ${mp.plan.T}`);
  }
});

test('moves use pathFor + travelPlan exactly (the choreography plays the same plan)', () => {
  const e = { type: 'moved', playerId: 'p1', from: 3, to: 12, steps: 9, via: 'roll' };
  const mp = movePlan(e, { level: 'high' });
  const ref = travelPlan({ length: pathFor(3, 9).length, own: true });
  assert.equal(mp.plan.T, ref.T);
  assert.equal(mp.path.to, 12);
  const low = movePlan(e, { level: 'low' });
  assert.ok(low.plan.T <= 0.9 && low.version === 'others');
  const med = movePlan(e, { level: 'med' });
  assert.ok(Math.abs(med.plan.T - ref.T * MED_SCALE) < 1e-9);
  assert.equal(movePlan({ ...e, steps: null }, { level: 'high' }), null);
  // Going back three spaces walks backwards along the lane.
  const back = movePlan({ type: 'moved', playerId: 'p1', from: 7, to: 4, steps: -3, via: 'card' }, { level: 'high' });
  assert.equal(back.path.dir, -1);
  assert.ok(back.plan.T > 0.8 && back.plan.T < 1.2);
});

test('relevance classes follow the design (§10)', () => {
  const c = ctx({ current: 'p2', owners: { 39: 'p1', 6: 'p3', 1: 'p2' } });
  const r = (e, cc = c) => relevance(e, cc);
  // The viewer's own events, payments to the viewer, landings on the viewer's lots: HIGH.
  assert.equal(r({ type: 'dice_rolled', playerId: 'p1', dice: [1, 2] }).level, 'high');
  assert.equal(r({ type: 'paid_rent', playerId: 'p2', ownerId: 'p1', tileIndex: 39, amount: 50 }).level, 'high');
  assert.equal(r({ type: 'landed', playerId: 'p2', tileIndex: 39 }).level, 'high');
  assert.equal(r({ type: 'trade_proposed', tradeId: 't1', fromPlayerId: 'p2', toPlayerId: 'p1', give: {}, get: {} }).level, 'high');
  assert.equal(r({ type: 'auction_started', tileIndex: 6, participants: ['p1', 'p2'] }).level, 'high');
  // Other players: routine LOW, notable MED.
  assert.equal(r({ type: 'turn_started', playerId: 'p2' }).level, 'low');
  assert.equal(r({ type: 'dice_rolled', playerId: 'p2', dice: [1, 2] }).level, 'low');
  assert.equal(r({ type: 'moved', playerId: 'p2', from: 1, to: 4, steps: 3, via: 'roll' }).level, 'low');
  assert.equal(r({ type: 'paid_tax', playerId: 'p2', tileIndex: 4, amount: 200 }).level, 'low');
  assert.equal(r({ type: 'paid_rent', playerId: 'p2', ownerId: 'p3', tileIndex: 6, amount: 150 }).level, 'low');
  assert.equal(r({ type: 'mortgaged', playerId: 'p2', tileIndex: 1, amount: 30 }).level, 'low');
  assert.equal(r({ type: 'bought', playerId: 'p2', tileIndex: 8, price: 100 }).level, 'med');
  assert.equal(r({ type: 'card_drawn', playerId: 'p2', deck: 'chance' }).level, 'med');
  assert.equal(r({ type: 'built', playerId: 'p2', tileIndex: 1, houses: 2 }).level, 'med');
  assert.equal(r({ type: 'paid_rent', playerId: 'p2', ownerId: 'p3', tileIndex: 6, amount: 200 }).level, 'med');
  // big scenes.
  assert.deepEqual(r({ type: 'built', playerId: 'p2', tileIndex: 1, houses: 5 }), { level: 'med', big: true });
  assert.deepEqual(r({ type: 'moved', playerId: 'p2', from: 30, to: 10, steps: null, via: 'jail' }), { level: 'med', big: true });
  assert.deepEqual(r({ type: 'sent_to_jail', playerId: 'p2', reason: 'tile' }), { level: 'med', big: true });
  assert.deepEqual(r({ type: 'bankrupt', playerId: 'p2', toPlayerId: 'p3', cash: 0 }), { level: 'med', big: true });
  assert.equal(r({ type: 'paid_rent', playerId: 'p2', ownerId: 'p3', tileIndex: 6, amount: 1000 }).big, true);
  assert.equal(r({ type: 'paid_rent', playerId: 'p2', ownerId: 'p3', tileIndex: 6, amount: 999 }).big, false);
  assert.equal(r({ type: 'dice_rolled', playerId: 'p2', dice: [1, 2] }).big, false);
  assert.deepEqual(r({ type: 'game_over', winnerId: 'p3' }), { level: 'high', big: true });
  // A completed set: p2 already owns 1; buying 3 completes brown.
  const set = ctx({ current: 'p2', owners: { 1: 'p2', 3: 'p2' } });
  assert.equal(completesSet({ type: 'bought', playerId: 'p2', tileIndex: 3 }, set), true);
  assert.deepEqual(r({ type: 'bought', playerId: 'p2', tileIndex: 3, price: 60 }, set), { level: 'med', big: true });
  // Spectators: the active player's routine events are MED, others' LOW.
  const spec = ctx({ me: null, current: 'p2' });
  assert.equal(r({ type: 'dice_rolled', playerId: 'p2', dice: [1, 2] }, spec).level, 'med');
  assert.equal(r({ type: 'dice_rolled', playerId: 'p3', dice: [1, 2] }, spec).level, 'low');
  // Versions per the "others" setting.
  assert.equal(versionOf({ level: 'low', big: false }, 'short'), 'others');
  assert.equal(versionOf({ level: 'low', big: true }, 'short'), 'med');
  assert.equal(versionOf({ level: 'med', big: false }, 'short'), 'med');
  assert.equal(versionOf({ level: 'low', big: false }, 'full'), 'own');
  assert.equal(dur('buy', { level: 'med' }), BUDGET.buy.own * MED_SCALE);
});

test('estimate is defensive: junk in, a finite number out', () => {
  assert.equal(estimate(null), 0);
  assert.equal(estimate([]), 0);
  assert.equal(estimate([null, 3, 'x', {}]), SETTLE_PAD);
  for (const e of [
    { type: 'moved', from: 'x', steps: 'y' }, { type: 'moved', steps: 2.5 }, { type: 'built' }, { type: 'dice_rolled' },
    { type: 'paid_rent', amount: 'lots' }, { type: 'trade_accepted', give: null }, { type: 'bought', tileIndex: 99 },
  ]) {
    const t = estimate([e], { me: 'p1' });
    assert.ok(Number.isFinite(t) && t >= 0, `${JSON.stringify(e)} → ${t}`);
  }
  assert.equal(relevance(null, null).level, 'low');
});
