// Trading (second slice): one pending trade at a time, proposed by the current player on their own
// turn and answered by the target. Written from the auction/trading feature spec (§10 trading,
// §11 legalActions, §12 events and error codes) as an independent check of the engine. Where the spec
// names no error code, the test expects the one CONTRACT §4.1 / §4.13 settled on.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
// Namespace import: a missing new export (validateTrade, tradeableTiles) fails its own test, not the file.
import * as engine from '../engine/index.js';
import {
  newGame, lobby, act, reject, roll, withDice, player, tile, current, give, giveJailCard, jail,
  setCash, setPlayer, edit, assertEvent, assertNoEvent,
} from './helpers.js';

const { legalActions } = engine;

/** A full offer (every field present). */
const offer = ({ cash = 0, tiles = [], jailCards = 0 } = {}) => ({ cash, tiles, jailCards });
const propose = (gives = {}, gets = {}, { from = 'p1', to = 'p2' } = {}) => (
  { type: 'PROPOSE_TRADE', playerId: from, toPlayerId: to, give: offer(gives), get: offer(gets) });
const accept = (playerId = 'p2') => ({ type: 'ACCEPT_TRADE', playerId });
const refuse = (playerId = 'p2') => ({ type: 'REJECT_TRADE', playerId });
const leave = (playerId) => ({ type: 'LEAVE', playerId });
const timeout = (playerId = 'p1') => ({ type: 'TIMEOUT', playerId });

/**
 * p1 to roll, 3 players (or `players`).
 * p1: Mediterranean (1), Reading Railroad (5). p2: Boardwalk (39), Electric Company (12, mortgaged).
 * p3: Vermont (8).
 */
function table({ players = 3, settings = {} } = {}) {
  let s = newGame({ players, settings });
  s = give(give(s, 'p1', 1), 'p1', 5);
  s = give(give(s, 'p2', 39), 'p2', 12, { mortgaged: true });
  if (players >= 3) s = give(s, 'p3', 8);
  return s;
}

/** Proposes (must succeed) and returns the trading state. */
const proposed = (state, action = propose({ cash: 100, tiles: [1] }, { tiles: [39] })) => act(state, action).state;

const totalCash = (s) => s.players.reduce((sum, p) => sum + p.cash, 0);
const indexOf = (events, type) => events.findIndex((e) => e.type === type);
const sortedActions = (state, playerId) => [...legalActions(state, playerId).actions].sort();
const feeTotal = (fees) => Object.values(fees).reduce((sum, n) => sum + n, 0);

/** The state as clients get it (CONTRACT §7): no rng, decks reduced to their sizes. */
function publicView(state) {
  const { rng, decks, ...rest } = state;
  return { ...rest, decks: { chance: { size: decks.chance.order.length }, community: { size: decks.community.order.length } } };
}

/** p1 lands on Income Tax (200) holding `cash`: phase paying. */
function owingTax(state, cash = 150) {
  const s = roll(setCash(state, 'p1', cash), 'p1', 1, 3).state;
  assert.equal(s.turn.phase, 'paying');
  return s;
}

// ---------------------------------------------------------------------------

describe('PROPOSE_TRADE', () => {
  test('opens a trade: state.trade, phase trading, event; nothing changes hands yet', () => {
    const s = table();
    const action = propose({ cash: 100, tiles: [1] }, { tiles: [39] });
    const { state, events } = act(s, action);
    assert.equal(state.seq, s.seq + 1);
    assert.equal(state.turn.phase, 'trading');
    assert.equal(current(state), 'p1');

    const t = state.trade;
    assert.ok(t, 'state.trade must be set');
    assert.match(t.id, /^t_\d+$/);
    assert.equal(t.id, `t_${s.seq}`, 'id is "t_" + the seq of the state the proposal was applied to');
    assert.equal(t.fromPlayerId, 'p1');
    assert.equal(t.toPlayerId, 'p2');
    assert.deepEqual(t.give, offer({ cash: 100, tiles: [1] }));
    assert.deepEqual(t.get, offer({ tiles: [39] }));
    assert.equal(t.returnPhase, 'rolling');
    assertEvent(events, 'trade_proposed', {
      tradeId: t.id, fromPlayerId: 'p1', toPlayerId: 'p2', give: offer({ cash: 100, tiles: [1] }), get: offer({ tiles: [39] }),
    });

    assert.deepEqual(state.players, s.players);
    assert.deepEqual(state.tiles, s.tiles);
  });

  test('returnPhase is the phase it was proposed from, and the turn resumes there unchanged', () => {
    const cases = {
      rolling: table(),
      jail_decision: jail(table(), 'p1'),
      end_turn: roll(table(), 'p1', 4, 6).state,
      paying: owingTax(table()),
    };
    const again = roll(table(), 'p1', 5, 5).state; // end_turn with rollAgain
    assert.equal(again.turn.rollAgain, true);
    for (const [phase, s] of [...Object.entries(cases), ['end_turn', again]]) {
      assert.equal(s.turn.phase, phase);
      const t = proposed(s, propose({ tiles: [5] }, { cash: 100 }));
      assert.equal(t.turn.phase, 'trading');
      assert.equal(t.trade.returnPhase, phase);
      for (const by of ['p2', 'p1']) { // declined by the target, or withdrawn by the proposer
        const back = act(t, refuse(by)).state;
        assert.equal(back.trade, null);
        // Only the per-turn proposal count moved (TRADE_LIMIT).
        assert.deepEqual(back.turn, { ...s.turn, tradesProposed: s.turn.tradesProposed + 1 },
          `${phase}: back to the same turn state after REJECT_TRADE by ${by}`);
        assert.deepEqual(back.players, s.players);
        assert.deepEqual(back.tiles, s.tiles);
      }
    }
  });

  test('payload and target validation', () => {
    const s = table();
    const ok = propose({ tiles: [1] }, { tiles: [39] });
    act(s, ok); // the base proposal is valid

    reject(s, { ...ok, playerId: 'p2', toPlayerId: 'p1' }, 'NOT_YOUR_TURN');
    reject(s, { ...ok, playerId: 'p9' }, 'NO_PLAYER');

    reject(s, { ...ok, toPlayerId: 'p1' }, 'BAD_PAYLOAD'); // self
    for (const toPlayerId of [null, undefined, 7]) reject(s, { ...ok, toPlayerId }, 'BAD_PAYLOAD'); // not a string
    for (const toPlayerId of ['p9', '']) reject(s, { ...ok, toPlayerId }, 'NO_PLAYER'); // nobody by that id
    const p3Out = setPlayer(edit(s, (x) => { tile(x, 8).ownerId = null; }), 'p3', { bankrupt: true, cash: 0 });
    reject(p3Out, propose({ tiles: [1] }, {}, { to: 'p3' }), 'NO_PLAYER');

    const shapes = [
      null, 'cash', 7,
      { cash: -1, tiles: [], jailCards: 0 },
      { cash: 1.5, tiles: [], jailCards: 0 },
      { cash: '10', tiles: [], jailCards: 0 },
      { cash: NaN, tiles: [], jailCards: 0 },
      { cash: 0, tiles: 1, jailCards: 0 },
      { cash: 0, tiles: [1, 1], jailCards: 0 },
      { cash: 0, tiles: ['1'], jailCards: 0 },
      { cash: 0, tiles: [1.5], jailCards: 0 },
      { cash: 0, tiles: [], jailCards: -1 },
      { cash: 0, tiles: [], jailCards: 0.5 },
    ];
    for (const bad of shapes) {
      reject(s, { ...ok, give: bad }, 'BAD_PAYLOAD');
      reject(s, { ...ok, get: bad }, 'BAD_PAYLOAD');
    }
    for (const index of [0, 2, 10, 40, -1]) { // not ownable
      reject(s, { ...ok, give: offer({ tiles: [index] }) }, 'BAD_PAYLOAD');
      reject(s, { ...ok, get: offer({ tiles: [index] }) }, 'BAD_PAYLOAD');
    }
  });

  test('rule validation: empty, ownership, cash, jail cards', () => {
    const s = table();
    reject(s, propose({}, {}), 'EMPTY_TRADE');
    reject(s, propose({ tiles: [3] }), 'NOT_OWNER'); // unowned
    reject(s, propose({ tiles: [8] }), 'NOT_OWNER'); // p3's
    reject(s, propose({}, { tiles: [1] }), 'NOT_OWNER'); // asks p2 for p1's own tile
    reject(s, propose({}, { tiles: [8] }), 'NOT_OWNER'); // asks p2 for p3's tile
    reject(s, propose({ tiles: [1, 3] }), 'NOT_OWNER');
    reject(s, propose({ cash: 1501 }), 'INSUFFICIENT_FUNDS');
    reject(s, propose({}, { cash: 1501 }), 'INSUFFICIENT_FUNDS');
    reject(s, propose({ jailCards: 1 }), 'NO_JAIL_CARD');
    reject(s, propose({}, { jailCards: 1 }), 'NO_JAIL_CARD');
    reject(giveJailCard(s, 'p1', 'chance'), propose({ jailCards: 2 }), 'NO_JAIL_CARD');

    // One non-empty side is enough, and giving exactly what you have is fine.
    act(s, propose({ cash: 1500 }));
    act(s, propose({}, { cash: 1500 }));
    act(giveJailCard(s, 'p1', 'chance'), propose({ jailCards: 1 }));
    act(giveJailCard(s, 'p2', 'community'), propose({}, { jailCards: 1 }));
    act(s, propose({ tiles: [1, 5] }, { cash: 1, tiles: [12, 39] }));
  });

  test('no buildings anywhere in the colour group of a traded property (HAS_BUILDINGS)', () => {
    let s = give(table(), 'p1', 3, { houses: 1 }); // brown: 1 bare, 3 built
    s = give(s, 'p2', 37, { houses: 2 }); // dark blue: 37 built, 39 bare
    reject(s, propose({ tiles: [1] }), 'HAS_BUILDINGS');
    reject(s, propose({ tiles: [3] }), 'HAS_BUILDINGS');
    reject(s, propose({}, { tiles: [39] }), 'HAS_BUILDINGS');
    reject(s, propose({ tiles: [5] }, { tiles: [39] }), 'HAS_BUILDINGS');
    act(s, propose({ tiles: [5] }, { tiles: [12] })); // railroads and utilities are never built on
  });

  test('only from rolling / jail_decision / end_turn / paying, one trade at a time', () => {
    const buying = roll(table(), 'p1', 1, 2).state; // Baltic Avenue is for sale
    assert.equal(buying.turn.phase, 'buying_or_auction');
    reject(buying, propose({ tiles: [1] }), 'WRONG_PHASE');
    const auctioning = act(buying, { type: 'DECLINE', playerId: 'p1' }).state;
    assert.equal(auctioning.turn.phase, 'auction');
    reject(auctioning, propose({ tiles: [1] }), 'WRONG_PHASE');

    const pending = proposed(table());
    reject(pending, propose({ tiles: [5] }, {}, { to: 'p3' }), 'TRADE_PENDING');
    reject(pending, propose({ tiles: [5] }), 'TRADE_PENDING');

    reject(lobby({ players: 2 }), propose({ cash: 1 }), 'GAME_NOT_ACTIVE');
    const over = act(newGame(), leave('p2')).state;
    assert.equal(over.status, 'finished');
    reject(over, propose({ cash: 1 }), 'GAME_NOT_ACTIVE');
  });
});

describe('ACCEPT_TRADE', () => {
  test('moves cash, tiles and jail cards, then returns to the saved phase', () => {
    const s = giveJailCard(giveJailCard(table(), 'p1', 'chance'), 'p1', 'community');
    const gives = offer({ cash: 100, tiles: [1], jailCards: 1 });
    const gets = offer({ cash: 50, tiles: [39] });
    const t = proposed(s, propose(gives, gets));
    const { state, events } = act(t, accept());
    assert.equal(state.seq, t.seq + 1);

    assert.equal(player(state, 'p1').cash, 1500 - 100 + 50);
    assert.equal(player(state, 'p2').cash, 1500 + 100 - 50);
    assert.equal(tile(state, 1).ownerId, 'p2');
    assert.equal(tile(state, 39).ownerId, 'p1');
    assert.equal(tile(state, 5).ownerId, 'p1', 'untraded tiles stay put');
    assert.equal(tile(state, 12).ownerId, 'p2');
    // Jail cards move from the end of the giver's list; counts stay in sync.
    assert.deepEqual(player(state, 'p1').jailCards, ['chance']);
    assert.equal(player(state, 'p1').getOutOfJailCards, 1);
    assert.deepEqual(player(state, 'p2').jailCards, ['community']);
    assert.equal(player(state, 'p2').getOutOfJailCards, 1);
    assert.equal(totalCash(state), totalCash(s), 'no fees on unmortgaged tiles');

    assert.equal(state.trade, null);
    assert.equal(state.turn.phase, 'rolling');
    assert.equal(current(state), 'p1');
    const e = assertEvent(events, 'trade_accepted', { tradeId: t.trade.id, fromPlayerId: 'p1', toPlayerId: 'p2', give: gives, get: gets });
    assert.equal(typeof e.fees, 'object');
    assert.equal(feeTotal(e.fees), 0);

    act(state, { type: 'ROLL', playerId: 'p1' }); // the turn carries on
  });

  test('the target can hand over jail cards too', () => {
    const s = giveJailCard(giveJailCard(table(), 'p2', 'community'), 'p2', 'chance');
    const t = proposed(s, propose({ cash: 20 }, { jailCards: 2 }));
    const { state } = act(t, accept());
    assert.deepEqual([...player(state, 'p1').jailCards].sort(), ['chance', 'community']);
    assert.equal(player(state, 'p1').getOutOfJailCards, 2);
    assert.deepEqual(player(state, 'p2').jailCards, []);
    assert.equal(player(state, 'p2').getOutOfJailCards, 0);
  });

  test('mortgaged tiles stay mortgaged; each receiver pays the bank 10% of their mortgage value', () => {
    let s = edit(table({ settings: { freeParkingPot: true } }), (x) => { x.pot = 40; });
    s = give(s, 'p1', 5, { mortgaged: true }); // mortgage 100 → fee 10
    s = give(s, 'p1', 6, { mortgaged: true }); // mortgage 50 → fee 5
    s = give(s, 'p2', 39, { mortgaged: true }); // mortgage 200 → fee 20; 12 (75) is mortgaged → 7.5 → 8
    const t = proposed(s, propose({ tiles: [1, 5, 6] }, { tiles: [12, 39] }));
    const { state, events } = act(t, accept());

    const e = assertEvent(events, 'trade_accepted', { tradeId: t.trade.id });
    assert.deepEqual(e.fees, { p1: 28, p2: 15 });
    assert.equal(player(state, 'p1').cash, 1500 - 28);
    assert.equal(player(state, 'p2').cash, 1500 - 15);
    for (const i of [5, 6]) assert.deepEqual([tile(state, i).ownerId, tile(state, i).mortgaged], ['p2', true]);
    assert.deepEqual([tile(state, 1).ownerId, tile(state, 1).mortgaged], ['p2', false]);
    for (const i of [12, 39]) assert.deepEqual([tile(state, i).ownerId, tile(state, i).mortgaged], ['p1', true]);
    assert.equal(state.pot, 40, 'fees go to the bank, not the free-parking pot');
  });

  test('fees must be affordable after the cash exchange (INSUFFICIENT_FUNDS otherwise)', () => {
    const s = give(table(), 'p1', 5, { mortgaged: true }); // fee 10 for whoever receives it

    // Target short of the fee.
    const t = proposed(s, propose({ tiles: [5] }));
    const short = setCash(t, 'p2', 9);
    reject(short, accept(), 'INSUFFICIENT_FUNDS');
    assert.ok(!legalActions(short, 'p2').actions.includes('ACCEPT_TRADE'));
    assert.ok(legalActions(short, 'p2').actions.includes('REJECT_TRADE'));
    assert.equal(player(act(setCash(t, 'p2', 10), accept()).state, 'p2').cash, 0);

    // The cash received in the trade counts towards the fee.
    const t2 = proposed(s, propose({ cash: 5, tiles: [5] }));
    reject(setCash(t2, 'p2', 4), accept(), 'INSUFFICIENT_FUNDS');
    const ok2 = act(setCash(t2, 'p2', 5), accept()).state;
    assert.equal(player(ok2, 'p2').cash, 0);
    assert.equal(player(ok2, 'p1').cash, 1495);

    // Proposer short of the fee on a mortgaged tile they receive (Electric Company, fee 8).
    const t3 = proposed(table(), propose({ cash: 100 }, { tiles: [12] }));
    const short3 = setCash(t3, 'p1', 107);
    reject(short3, accept(), 'INSUFFICIENT_FUNDS');
    assert.ok(!legalActions(short3, 'p2').actions.includes('ACCEPT_TRADE'));
    const ok3 = act(setCash(t3, 'p1', 108), accept()).state;
    assert.equal(player(ok3, 'p1').cash, 0);
    assert.equal(player(ok3, 'p2').cash, 1600);
  });

  test('re-validated on accept: a trade that has become invalid fails and stays pending', () => {
    const s = giveJailCard(table(), 'p1', 'chance');
    const t = proposed(s, propose({ cash: 100, tiles: [1], jailCards: 1 }, { tiles: [39] }));
    assert.ok(legalActions(t, 'p2').actions.includes('ACCEPT_TRADE'));
    const changed = {
      NOT_OWNER: [
        edit(t, (x) => { tile(x, 39).ownerId = 'p3'; }),
        edit(t, (x) => { tile(x, 1).ownerId = 'p3'; }),
      ],
      INSUFFICIENT_FUNDS: [setCash(t, 'p1', 99)],
      NO_JAIL_CARD: [setPlayer(t, 'p1', { jailCards: [], getOutOfJailCards: 0 })],
      HAS_BUILDINGS: [give(t, 'p1', 3, { houses: 1 }), give(t, 'p2', 37, { houses: 1 })],
    };
    for (const [code, states] of Object.entries(changed)) {
      for (const bad of states) {
        reject(bad, accept(), code);
        const legal = legalActions(bad, 'p2');
        assert.ok(!legal.actions.includes('ACCEPT_TRADE'), `${code}: ACCEPT_TRADE must not be listed`);
        assert.ok(legal.actions.includes('REJECT_TRADE'));
        const back = act(bad, refuse()).state;
        assert.equal(back.trade, null);
        assert.equal(back.turn.phase, 'rolling');
      }
    }
  });

  test('only the target may accept; nothing to accept without a trade', () => {
    const t = proposed(table());
    reject(t, accept('p1'), 'NOT_TRADE_PARTY'); // the proposer can only withdraw
    reject(t, accept('p3'), 'NOT_TRADE_PARTY');
    reject(t, refuse('p3'), 'NOT_TRADE_PARTY');
    reject(t, accept('p9'), 'NO_PLAYER');

    const s = table();
    for (const pid of ['p1', 'p2']) {
      reject(s, accept(pid), 'NO_TRADE');
      reject(s, refuse(pid), 'NO_TRADE');
    }
    reject(lobby({ players: 2 }), accept('p2'), 'GAME_NOT_ACTIVE');
    reject(lobby({ players: 2 }), refuse('p2'), 'GAME_NOT_ACTIVE');
  });

  test('nothing else is legal while a trade is pending', () => {
    const t = proposed(give(table(), 'p2', 15));
    for (const type of ['ROLL', 'END_TURN', 'BUY', 'DECLINE', 'PAY_DEBT', 'DECLARE_BANKRUPTCY', 'START_AUCTION', 'PAY_JAIL_FINE', 'USE_JAIL_CARD']) {
      reject(t, { type, playerId: 'p1' }, 'WRONG_PHASE');
    }
    reject(t, { type: 'MORTGAGE', playerId: 'p1', tileIndex: 5 }, 'WRONG_PHASE');
    reject(t, { type: 'MORTGAGE', playerId: 'p2', tileIndex: 15 }, 'NOT_YOUR_TURN');
    reject(t, { type: 'BID', playerId: 'p2', amount: 10 }, 'WRONG_PHASE');
    reject(t, { type: 'PASS_AUCTION', playerId: 'p1' }, 'WRONG_PHASE');
  });
});

describe('REJECT_TRADE', () => {
  test('by the target: declined, nothing changes hands', () => {
    const t = proposed(table());
    const { state, events } = act(t, refuse('p2'));
    assertEvent(events, 'trade_rejected', { tradeId: t.trade.id, byPlayerId: 'p2' });
    assertNoEvent(events, 'trade_accepted');
    assert.equal(state.trade, null);
    assert.equal(state.turn.phase, 'rolling');
    assert.equal(state.seq, t.seq + 1);
    assert.deepEqual(state.players, t.players);
    assert.deepEqual(state.tiles, t.tiles);
  });

  test('by the proposer: withdrawn', () => {
    const t = proposed(table());
    const { state, events } = act(t, refuse('p1'));
    assertEvent(events, 'trade_rejected', { tradeId: t.trade.id, byPlayerId: 'p1' });
    assert.equal(state.trade, null);
    assert.equal(state.turn.phase, 'rolling');
    // A new trade can be proposed straight away.
    const again = act(state, propose({ tiles: [5] }, {}, { to: 'p3' })).state;
    assert.notEqual(again.trade.id, t.trade.id);
  });
});

describe('TIMEOUT while trading', () => {
  test('rolling: the trade is cancelled, then the player rolls', () => {
    const t = proposed(table());
    reject(t, timeout('p2'), 'NOT_YOUR_TURN');
    const { state, events } = act(withDice(t, 4, 6), timeout());
    assert.equal(events[0].type, 'timeout');
    assert.equal(events[0].playerId, 'p1');
    assert.equal(events[0].phase, 'trading');
    assertEvent(events, 'trade_cancelled', { tradeId: t.trade.id, reason: 'timeout' });
    assertEvent(events, 'dice_rolled', { playerId: 'p1', dice: [4, 6] });
    assert.ok(indexOf(events, 'trade_cancelled') < indexOf(events, 'dice_rolled'));
    assert.equal(state.trade, null);
    assert.equal(player(state, 'p1').position, 10);
    assert.equal(state.turn.phase, 'end_turn');
    assert.deepEqual(state.tiles, t.tiles, 'nothing was traded');
  });

  test('end_turn: cancelled, then the turn ends', () => {
    const t = proposed(roll(table(), 'p1', 4, 6).state);
    const { state, events } = act(t, timeout());
    assertEvent(events, 'trade_cancelled', { tradeId: t.trade.id, reason: 'timeout' });
    assertEvent(events, 'turn_ended', { playerId: 'p1' });
    assert.equal(current(state), 'p2');
    assert.equal(state.turn.phase, 'rolling');
    assert.equal(state.trade, null);
  });

  test('end_turn with rollAgain: cancelled, then the player rolls again', () => {
    const t = proposed(roll(table(), 'p1', 5, 5).state);
    const { state, events } = act(withDice(t, 4, 6), timeout());
    assertEvent(events, 'trade_cancelled', { reason: 'timeout' });
    assertEvent(events, 'dice_rolled', { playerId: 'p1', dice: [4, 6] });
    assert.equal(player(state, 'p1').position, 20);
    assert.equal(current(state), 'p1');
  });

  test('jail_decision: cancelled, then a jail roll', () => {
    const t = proposed(jail(table(), 'p1'));
    const { state, events } = act(withDice(t, 1, 2), timeout());
    assertEvent(events, 'trade_cancelled', { reason: 'timeout' });
    assertEvent(events, 'jail_roll_failed', { playerId: 'p1', attempt: 1 });
    assert.equal(player(state, 'p1').inJail, true);
    assert.equal(state.turn.phase, 'end_turn');
  });

  test('paying: cancelled, then autoRaise and PAY_DEBT', () => {
    const t = proposed(owingTax(table()), propose({ tiles: [1] }, { cash: 30 }));
    assert.equal(t.trade.returnPhase, 'paying');
    const { state, events } = act(t, timeout());
    assertEvent(events, 'trade_cancelled', { reason: 'timeout' });
    const steps = events.filter((e) => ['trade_cancelled', 'mortgaged', 'debt_paid'].includes(e.type)).map((e) => `${e.type}:${e.tileIndex ?? ''}`);
    assert.deepEqual(steps, ['trade_cancelled:', 'mortgaged:1', 'mortgaged:5', 'debt_paid:']);
    assert.equal(player(state, 'p1').cash, 150 + 30 + 100 - 200);
    assert.equal(state.turn.phase, 'end_turn');
    assert.equal(state.trade, null);
  });
});

describe('resigning while a trade is pending', () => {
  test('the target resigns: cancelled, the proposer carries on from returnPhase', () => {
    const t = proposed(table());
    const { state, events } = act(t, leave('p2'));
    assertEvent(events, 'trade_cancelled', { tradeId: t.trade.id, reason: 'resigned' });
    assertEvent(events, 'bankrupt', { playerId: 'p2', toPlayerId: null });
    assert.equal(state.trade, null);
    assert.equal(state.turn.phase, 'rolling');
    assert.equal(current(state), 'p1');
    assert.equal(tile(state, 39).ownerId, null);
    assert.equal(tile(state, 1).ownerId, 'p1', 'nothing was traded');
    act(state, { type: 'ROLL', playerId: 'p1' });
  });

  test('the proposer resigns: cancelled first, then the turn passes', () => {
    const t = proposed(table());
    const { state, events } = act(t, leave('p1'));
    assertEvent(events, 'trade_cancelled', { tradeId: t.trade.id, reason: 'resigned' });
    assert.ok(indexOf(events, 'trade_cancelled') < indexOf(events, 'bankrupt'));
    assert.ok(indexOf(events, 'trade_cancelled') < indexOf(events, 'turn_ended'));
    assert.equal(state.trade, null);
    assert.equal(current(state), 'p2');
    assert.equal(state.turn.phase, 'rolling');
    assert.equal(player(state, 'p1').bankrupt, true);
    assert.equal(tile(state, 1).ownerId, null);
  });

  test('the proposer resigns from a paying returnPhase: bankrupt to their creditor', () => {
    let s = give(setCash(table(), 'p1', 2), 'p2', 3); // Baltic Avenue, rent 4
    s = roll(s, 'p1', 1, 2).state;
    assert.equal(s.turn.phase, 'paying');
    assert.equal(s.turn.pendingDebt.toPlayerId, 'p2');
    const t = proposed(s, propose({ tiles: [5] }, { cash: 100 }, { to: 'p3' }));
    const { state, events } = act(t, leave('p1'));
    assertEvent(events, 'trade_cancelled', { reason: 'resigned' });
    assertEvent(events, 'bankrupt', { playerId: 'p1', toPlayerId: 'p2', cash: 2 });
    assert.equal(tile(state, 1).ownerId, 'p2');
    assert.equal(tile(state, 5).ownerId, 'p2');
    assert.equal(player(state, 'p3').cash, 1500, 'nothing was traded');
    assert.equal(current(state), 'p2');
  });

  test('a third player resigning leaves the trade pending', () => {
    const t = proposed(table());
    const { state, events } = act(t, leave('p3'));
    assertNoEvent(events, 'trade_cancelled');
    assert.equal(player(state, 'p3').bankrupt, true);
    assert.equal(state.turn.phase, 'trading');
    assert.deepEqual(state.trade, t.trade);
    const done = act(state, accept()).state;
    assert.equal(tile(done, 39).ownerId, 'p1');
  });

  test('2 players: the target resigns → cancelled, game over', () => {
    const t = proposed(table({ players: 2 }));
    const { state, events } = act(t, leave('p2'));
    assertEvent(events, 'trade_cancelled', { reason: 'resigned' });
    assertEvent(events, 'game_over', { winnerId: 'p1' });
    assert.equal(state.status, 'finished');
    assert.equal(state.trade, null);
  });
});

describe('trading out of a debt', () => {
  test('paying → trade for cash → back to paying → PAY_DEBT', () => {
    const s = owingTax(table()); // 150 cash, owes 200
    reject(s, { type: 'PAY_DEBT', playerId: 'p1' }, 'INSUFFICIENT_FUNDS');
    const t = proposed(s, propose({ tiles: [5] }, { cash: 100 }));
    const { state } = act(t, accept());
    assert.equal(state.turn.phase, 'paying');
    assert.deepEqual(state.turn.pendingDebt, s.turn.pendingDebt);
    assert.equal(player(state, 'p1').cash, 250);
    assert.equal(tile(state, 5).ownerId, 'p2');
    const paid = act(state, { type: 'PAY_DEBT', playerId: 'p1' }).state;
    assert.equal(player(paid, 'p1').cash, 50);
    assert.equal(paid.turn.phase, 'end_turn');
  });
});

describe('trading while in debt: sell, never give away (UNFAIR_TRADE)', () => {
  // owingTax: p1 has $150 and owes the bank $200. Mortgage values: Mediterranean (1) $30, Reading (5)
  // $100, Vermont (8) $50, Boardwalk (39) $200; Electric Company (12) is mortgaged (fee $8).
  test('the trade must not lower what the debtor could raise: cash + mortgage value of unmortgaged tiles, after fees', () => {
    const s = owingTax(table());
    reject(s, propose({ cash: 150 }, {}, { to: 'p3' }), 'UNFAIR_TRADE');
    reject(s, propose({ tiles: [5] }), 'UNFAIR_TRADE');
    reject(s, propose({ tiles: [5] }, { cash: 99 }), 'UNFAIR_TRADE');
    reject(s, propose({}, { tiles: [12] }), 'UNFAIR_TRADE'); // the $8 fee on a mortgaged tile
    const message = reject(s, propose({ tiles: [1, 5] }, { cash: 100 }), 'UNFAIR_TRADE').message;
    assert.match(message, /\$30 less/);

    proposed(s, propose({ tiles: [5] }, { cash: 100 })); // at the mortgage value
    proposed(s, propose({ tiles: [5] }, { cash: 250 })); // better than mortgaging
    proposed(s, propose({ tiles: [5] }, { tiles: [39] })); // a swap for more
    proposed(s, propose({ tiles: [1] }, { tiles: [8] }, { to: 'p3' }));
    proposed(s, propose({}, { tiles: [12], cash: 8 }));
    proposed(s, propose({}, { cash: 500 })); // help from a friend is fine

    // Outside a debt, gifts are allowed.
    proposed(table(), propose({ cash: 150 }, {}, { to: 'p3' }));
  });

  test('a debtor facing bankruptcy cannot strip their assets: the creditor still gets everything', () => {
    let s = give(give(table(), 'p2', 37, { houses: 5 }), 'p2', 39, { houses: 5 });
    s = setPlayer(setCash(s, 'p1', 300), 'p1', { position: 35 });
    s = roll(s, 'p1', 1, 3).state; // Boardwalk with a hotel: $2000 to p2
    assert.equal(s.turn.phase, 'paying');
    reject(s, propose({ cash: 300, tiles: [1, 5] }, {}, { to: 'p3' }), 'UNFAIR_TRADE');
    const { events, state } = act(s, { type: 'DECLARE_BANKRUPTCY', playerId: 'p1' });
    assertEvent(events, 'bankrupt', { playerId: 'p1', toPlayerId: 'p2', cash: 300, reason: 'debt' });
    assert.equal(tile(state, 1).ownerId, 'p2');
    assert.equal(tile(state, 5).ownerId, 'p2');
  });

  test('checked again on ACCEPT_TRADE', () => {
    const s = owingTax(table());
    const unfair = edit(s, (x) => {
      x.trade = { id: 't_x', fromPlayerId: 'p1', toPlayerId: 'p2', give: offer({ tiles: [5] }), get: offer(), returnPhase: 'paying' };
      x.turn.phase = 'trading';
    });
    reject(unfair, accept(), 'UNFAIR_TRADE');
    assert.ok(!legalActions(unfair, 'p2').actions.includes('ACCEPT_TRADE'));
    act(unfair, refuse());
  });
});

describe('answering a named offer (tradeId)', () => {
  test('ACCEPT_TRADE / REJECT_TRADE with the id of an offer that was replaced get NO_TRADE', () => {
    const first = proposed(table(), propose({ cash: 500 }, { tiles: [39] }));
    const seen = first.trade.id;
    const withdrawn = act(first, refuse('p1')).state;
    const second = proposed(withdrawn, propose({ cash: 1 }, { tiles: [39] }));
    assert.notEqual(second.trade.id, seen);
    reject(second, { ...accept(), tradeId: seen }, 'NO_TRADE');
    reject(second, { ...refuse(), tradeId: seen }, 'NO_TRADE');
    reject(second, { ...refuse('p1'), tradeId: seen }, 'NO_TRADE');
    reject(second, { ...accept(), tradeId: 5 }, 'BAD_PAYLOAD');
    reject(withdrawn, { ...accept(), tradeId: seen }, 'NO_TRADE');

    const done = act(second, { ...accept(), tradeId: second.trade.id });
    assertEvent(done.events, 'trade_accepted', { tradeId: second.trade.id });
    act(second, { ...refuse('p1'), tradeId: second.trade.id });
    act(second, accept()); // the id stays optional
  });
});

describe('proposals per turn (TRADE_LIMIT)', () => {
  test(`at most ${engine.MAX_TRADES_PER_TURN} proposals per turn, answered or not; the count starts again each turn`, () => {
    assert.equal(engine.MAX_TRADES_PER_TURN, 5);
    let s = table();
    for (let k = 0; k < engine.MAX_TRADES_PER_TURN; k++) {
      assert.ok(legalActions(s, 'p1').actions.includes('PROPOSE_TRADE'));
      s = act(proposed(s, propose({ cash: 1 })), refuse(k % 2 ? 'p1' : 'p2')).state;
    }
    assert.equal(s.turn.tradesProposed, engine.MAX_TRADES_PER_TURN);
    reject(s, propose({ cash: 1 }), 'TRADE_LIMIT');
    const legal = legalActions(s, 'p1');
    assert.ok(!legal.actions.includes('PROPOSE_TRADE'));
    assert.deepEqual(legal.tradeTargets, []);

    const next = act(roll(s, 'p1', 4, 6).state, { type: 'END_TURN', playerId: 'p1' }).state;
    assert.equal(next.turn.tradesProposed, 0);
    proposed(next, propose({ cash: 1 }, {}, { from: 'p2', to: 'p1' }));
  });

  test('a game saved before the limit existed (no tradesProposed) can still trade', () => {
    const old = edit(table(), (s) => { delete s.turn.tradesProposed; });
    assert.equal(proposed(old).turn.tradesProposed, 1);
  });
});

describe('legalActions and trading', () => {
  test('PROPOSE_TRADE and tradeTargets for the current player in the four proposing phases', () => {
    const phases = [
      table(), jail(table(), 'p1'), roll(table(), 'p1', 4, 6).state, roll(table(), 'p1', 5, 5).state, owingTax(table()),
    ];
    for (const s of phases) {
      const legal = legalActions(s, 'p1');
      assert.ok(legal.actions.includes('PROPOSE_TRADE'), `phase ${s.turn.phase}`);
      assert.deepEqual([...legal.tradeTargets].sort(), ['p2', 'p3']);
      assert.equal(legal.auction, null);
      for (const pid of ['p2', 'p3']) {
        const off = legalActions(s, pid);
        assert.ok(!off.actions.includes('PROPOSE_TRADE'), `${pid} is off-turn`);
        assert.deepEqual(off.tradeTargets, []);
      }
    }
    const noP3 = setPlayer(newGame({ players: 3 }), 'p3', { bankrupt: true, cash: 0 });
    assert.deepEqual(legalActions(noP3, 'p1').tradeTargets, ['p2']);
    assert.deepEqual(legalActions(newGame(), 'p1').tradeTargets, ['p2']);
  });

  test('no trades in buying_or_auction, auction, trading, the lobby or a finished game', () => {
    const buying = roll(table(), 'p1', 1, 2).state;
    const auctioning = act(buying, { type: 'DECLINE', playerId: 'p1' }).state;
    const trading = proposed(table());
    const over = act(newGame(), leave('p2')).state;
    for (const s of [buying, auctioning, trading, over, lobby({ players: 2 })]) {
      for (const pid of ['p1', 'p2']) {
        const legal = legalActions(s, pid);
        assert.ok(!legal.actions.includes('PROPOSE_TRADE'), `${pid} in ${s.turn.phase}`);
        assert.deepEqual(legal.tradeTargets, []);
      }
    }
  });

  test('while trading: the target may accept or reject, the proposer may withdraw, anyone may resign', () => {
    const t = proposed(table());
    assert.deepEqual(sortedActions(t, 'p1'), ['LEAVE', 'REJECT_TRADE']);
    assert.deepEqual(sortedActions(t, 'p2'), ['ACCEPT_TRADE', 'LEAVE', 'REJECT_TRADE']);
    assert.deepEqual(sortedActions(t, 'p3'), ['LEAVE']);
    const p1 = legalActions(t, 'p1');
    for (const key of ['build', 'sellHouse', 'mortgage', 'unmortgage']) assert.deepEqual(p1[key], [], `no ${key} while trading`);
    for (const pid of ['p1', 'p2', 'p3']) {
      const legal = legalActions(t, pid);
      assert.equal(legal.auction, null);
      assert.deepEqual(legal.tradeTargets, []);
      assert.deepEqual(legalActions(publicView(t), pid), legal, 'same answer on the public state');
      for (const type of legal.actions) act(t, { type, playerId: pid }); // every listed action succeeds
    }
  });
});

describe('rules exports', () => {
  test('tradeableTiles: the player\'s tiles with no buildings in their colour group', () => {
    let s = give(table(), 'p1', 3, { houses: 1 }); // brown group now has a house: 1 and 3 are stuck
    s = give(s, 'p1', 6);
    assert.deepEqual([...engine.tradeableTiles(s, 'p1')].sort((a, b) => a - b), [5, 6]);
    assert.deepEqual([...engine.tradeableTiles(s, 'p2')].sort((a, b) => a - b), [12, 39]);
  });

  test('validateTrade(state, fromPlayerId, offer) is the shared check', () => {
    const s = table();
    const trade = (gives, gets) => ({ toPlayerId: 'p2', give: offer(gives), get: offer(gets) });
    assert.equal(engine.validateTrade(s, 'p1', trade({ tiles: [1] }, { tiles: [39] })), null);
    assert.equal(engine.validateTrade(s, 'p1', trade({ tiles: [3] }, {})).code, 'NOT_OWNER');
    assert.equal(engine.validateTrade(s, 'p1', trade({ cash: 1501 }, {})).code, 'INSUFFICIENT_FUNDS');
    assert.equal(engine.validateTrade(s, 'p1', trade({}, { jailCards: 1 })).code, 'NO_JAIL_CARD');
    assert.equal(engine.validateTrade(give(s, 'p2', 37, { houses: 1 }), 'p1', trade({}, { tiles: [39] })).code, 'HAS_BUILDINGS');
    assert.equal(typeof engine.validateTrade(s, 'p1', trade({ tiles: [3] }, {})).message, 'string');
  });
});
