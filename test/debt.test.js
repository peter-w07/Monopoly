// Debt, bankruptcy, resigning and game over (CONTRACT §4.6, §4.8, §4.2 LEAVE).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { legalActions } from '../engine/index.js';
import {
  newGame, act, reject, roll, player, tile, current, give, giveJailCard, setCash, setPosition,
  stackDeck, assertEvent, assertNoEvent, ofType,
} from './helpers.js';

const bankrupt = (playerId = 'p1') => ({ type: 'DECLARE_BANKRUPTCY', playerId });
const payDebt = (playerId = 'p1') => ({ type: 'PAY_DEBT', playerId });

describe('debt', () => {
  test('unaffordable tax → paying → MORTGAGE → PAY_DEBT', () => {
    let s = give(give(setCash(newGame(), 'p1', 150), 'p1', 6), 'p1', 8);
    const r = roll(s, 'p1', 1, 3); // → 4 Income Tax 200
    let state = r.state;
    assert.equal(state.turn.phase, 'paying');
    assert.equal(state.turn.pendingDebt.toPlayerId, null);
    assert.equal(state.turn.pendingDebt.amount, 200);
    assert.equal(player(state, 'p1').cash, 150, 'no partial payment');
    assertEvent(r.events, 'debt_started', { playerId: 'p1', toPlayerId: null, amount: 200 });

    const legal = legalActions(state, 'p1');
    assert.ok(legal.actions.includes('DECLARE_BANKRUPTCY'));
    assert.ok(!legal.actions.includes('PAY_DEBT'));
    assert.deepEqual(legal.mortgage, [6, 8]);
    reject(state, payDebt(), 'INSUFFICIENT_FUNDS');
    reject(state, { type: 'END_TURN', playerId: 'p1' }, 'WRONG_PHASE');
    reject(state, { type: 'ROLL', playerId: 'p1' }, 'WRONG_PHASE');
    reject(state, payDebt('p2'), 'NOT_YOUR_TURN');

    state = act(state, { type: 'MORTGAGE', playerId: 'p1', tileIndex: 6 }).state;
    assert.equal(player(state, 'p1').cash, 200);
    assert.ok(legalActions(state, 'p1').actions.includes('PAY_DEBT'));
    const paid = act(state, payDebt());
    assert.equal(player(paid.state, 'p1').cash, 0);
    assert.equal(paid.state.turn.phase, 'end_turn');
    assert.equal(paid.state.turn.pendingDebt, null);
    assertEvent(paid.events, 'debt_paid', { playerId: 'p1', toPlayerId: null, amount: 200, reason: 'tax' });
  });

  test('rent debt is paid to the owner once cash is raised', () => {
    let s = give(setCash(newGame(), 'p1', 2), 'p1', 6);
    s = give(s, 'p2', 3); // rent 4
    let { state } = roll(s, 'p1', 1, 2);
    assert.equal(state.turn.phase, 'paying');
    assert.equal(state.turn.pendingDebt.toPlayerId, 'p2');
    assert.equal(state.turn.pendingDebt.amount, 4);
    state = act(state, { type: 'MORTGAGE', playerId: 'p1', tileIndex: 6 }).state;
    const paid = act(state, payDebt());
    state = paid.state;
    assertEvent(paid.events, 'debt_paid', { playerId: 'p1', toPlayerId: 'p2', amount: 4, reason: 'rent' });
    assert.equal(player(state, 'p1').cash, 48);
    assert.equal(player(state, 'p2').cash, 1504);
    assert.equal(state.turn.phase, 'end_turn');
  });

  test('building and unmortgaging are not allowed while paying', () => {
    let s = give(give(setCash(newGame(), 'p1', 150), 'p1', 1), 'p1', 3);
    s = give(s, 'p1', 5, { mortgaged: true });
    const { state } = roll(s, 'p1', 1, 3);
    assert.equal(state.turn.phase, 'paying');
    reject(state, { type: 'BUILD', playerId: 'p1', tileIndex: 1 }, 'WRONG_PHASE');
    reject(state, { type: 'UNMORTGAGE', playerId: 'p1', tileIndex: 5 }, 'WRONG_PHASE');
  });

  test('selling houses raises cash while paying', () => {
    let s = give(setCash(newGame(), 'p1', 150), 'p1', 1, { houses: 1 });
    s = give(s, 'p1', 3, { houses: 1 });
    let { state } = roll(s, 'p1', 1, 3); // 200 tax
    state = act(state, { type: 'SELL_HOUSE', playerId: 'p1', tileIndex: 1 }).state;
    state = act(state, { type: 'SELL_HOUSE', playerId: 'p1', tileIndex: 3 }).state;
    state = act(state, payDebt()).state;
    assert.equal(player(state, 'p1').cash, 0);
  });

  test('rollAgain survives a debt', () => {
    let s = give(setCash(newGame(), 'p1', 150), 'p1', 6);
    let { state } = roll(setPosition(s, 'p1', 0), 'p1', 2, 2); // doubles → 4 Income Tax
    assert.equal(state.turn.phase, 'paying');
    state = act(state, { type: 'MORTGAGE', playerId: 'p1', tileIndex: 6 }).state;
    state = act(state, payDebt()).state;
    assert.equal(state.turn.phase, 'end_turn');
    assert.equal(state.turn.rollAgain, true);
    reject(state, { type: 'END_TURN', playerId: 'p1' }, 'MUST_ROLL_AGAIN');
  });

  test('PAY_DEBT / DECLARE_BANKRUPTCY only while paying', () => {
    const s = newGame();
    reject(s, payDebt(), 'WRONG_PHASE');
    reject(s, bankrupt(), 'WRONG_PHASE');
  });
});

describe('bankruptcy', () => {
  /**
   * 3 players. p1 has 100 cash, the light blues with buildings (2,2,1 houses; house cost 50),
   * a mortgaged railroad and a Chance jail card, and is about to land on p2's Boardwalk hotel.
   */
  function brokeOnBoardwalk() {
    let s = setCash(newGame({ players: 3 }), 'p1', 100);
    s = give(s, 'p1', 6, { houses: 2 });
    s = give(s, 'p1', 8, { houses: 2 });
    s = give(s, 'p1', 9, { houses: 1 });
    s = give(s, 'p1', 5, { mortgaged: true });
    s = giveJailCard(s, 'p1', 'chance');
    s = give(s, 'p2', 37);
    s = give(s, 'p2', 39, { houses: 5 }); // rent 2000
    const { state } = roll(setPosition(s, 'p1', 35), 'p1', 1, 3); // → 39
    assert.equal(state.turn.phase, 'paying');
    assert.equal(state.turn.pendingDebt.toPlayerId, 'p2');
    assert.equal(state.turn.pendingDebt.amount, 2000);
    return state;
  }

  test('to a player: buildings sold at half, then cash, properties and jail cards transfer', () => {
    const s = brokeOnBoardwalk();
    const { state, events } = act(s, bankrupt());
    const p1 = player(state, 'p1');
    const p2 = player(state, 'p2');
    // Events say how much each sell-off raised and how much cash went to the creditor.
    assert.deepEqual(ofType(events, 'sold_house').map((e) => [e.tileIndex, e.houses, e.amount]), [[6, 0, 50], [8, 0, 50], [9, 0, 25]]);
    assertEvent(events, 'bankrupt', { playerId: 'p1', toPlayerId: 'p2', cash: 225 });

    // 5 building levels × floor(50 / 2) = 125, plus 100 cash.
    assert.equal(p2.cash, 1500 + 225);
    assert.equal(player(state, 'p3').cash, 1500);
    for (const i of [6, 8, 9]) assert.deepEqual(tile(state, i), { index: i, ownerId: 'p2', houses: 0, mortgaged: false });
    assert.deepEqual(tile(state, 5), { index: 5, ownerId: 'p2', houses: 0, mortgaged: true });
    assert.equal(state.bank.houses, 32);
    assert.equal(state.bank.hotels, 11); // p2's Boardwalk hotel is untouched
    assert.equal(p2.getOutOfJailCards, 1);
    assert.deepEqual(p2.jailCards, ['chance']);

    assert.equal(p1.bankrupt, true);
    assert.equal(p1.cash, 0);
    assert.equal(p1.getOutOfJailCards, 0);
    assert.deepEqual(p1.jailCards, []);
    assert.equal(p1.inJail, false);
    assert.equal(state.turn.pendingDebt, null);
    assert.equal(state.tiles.filter((t) => t.ownerId === 'p1').length, 0);

    // The game goes on with the next player.
    assert.equal(state.status, 'active');
    assert.equal(current(state), 'p2');
    assert.equal(state.turn.phase, 'rolling');
    assert.equal(state.turn.number, s.turn.number + 1);
    assertEvent(events, 'turn_started', { playerId: 'p2' });
    reject(state, { type: 'ROLL', playerId: 'p1' });
  });

  test('to the bank: properties unowned and unmortgaged, jail cards back in the decks', () => {
    let s = setCash(newGame({ players: 3 }), 'p1', 100);
    s = give(s, 'p1', 6, { houses: 2 });
    s = give(s, 'p1', 8, { houses: 2 });
    s = give(s, 'p1', 9, { houses: 1 });
    s = give(s, 'p1', 5, { mortgaged: true });
    s = giveJailCard(giveJailCard(s, 'p1', 'chance'), 'p1', 'community');
    let { state } = roll(s, 'p1', 1, 3); // → 4 Income Tax 200
    assert.equal(state.turn.pendingDebt.toPlayerId, null);

    const r = act(state, bankrupt());
    state = r.state;
    assertEvent(r.events, 'bankrupt', { playerId: 'p1', toPlayerId: null, cash: 100 + 5 * 25 }); // removed from the game
    for (const i of [5, 6, 8, 9]) assert.deepEqual(tile(state, i), { index: i, ownerId: null, houses: 0, mortgaged: false });
    assert.deepEqual(state.bank, { houses: 32, hotels: 12 });
    assert.equal(player(state, 'p2').cash, 1500);
    assert.equal(player(state, 'p3').cash, 1500);
    assert.equal(player(state, 'p1').cash, 0);
    assert.equal(player(state, 'p1').bankrupt, true);
    assert.equal(state.players.reduce((n, p) => n + p.getOutOfJailCards, 0), 0);
    assert.equal(current(state), 'p2');

    // The returned Chance card can be drawn again.
    state = stackDeck(setPosition(state, 'p2', 4), 'chance', [8]);
    const drawn = roll(state, 'p2', 1, 2); // → 7 Chance
    assert.deepEqual(player(drawn.state, 'p2').jailCards, ['chance']);
  });

  test('the last player standing wins', () => {
    let s = setCash(newGame(), 'p1', 100);
    const { state: paying } = roll(s, 'p1', 1, 3);
    const { state, events } = act(paying, bankrupt());
    assert.equal(state.status, 'finished');
    assert.equal(state.turn.phase, 'game_over');
    assert.equal(state.winnerId, 'p2');
    // The bankrupt player's turn is closed (turn_started / turn_ended always pair), then the game ends.
    assert.deepEqual(events.map((e) => e.type), ['bankrupt', 'turn_ended', 'game_over']);
    assertEvent(events, 'turn_ended', { playerId: 'p1' });
    assertEvent(events, 'game_over', { winnerId: 'p2' });
    reject(state, { type: 'ROLL', playerId: 'p2' }, 'GAME_NOT_ACTIVE');
    reject(state, { type: 'END_TURN', playerId: 'p2' }, 'GAME_NOT_ACTIVE');
    assert.deepEqual(legalActions(state, 'p2').actions.filter((a) => a !== 'LEAVE'), []);
  });
});

describe('LEAVE while active (resign)', () => {
  test('off-turn resignation bankrupts the player to the bank; the turn is unaffected', () => {
    let s = give(give(newGame({ players: 3 }), 'p2', 6, { houses: 1 }), 'p2', 8);
    s = give(s, 'p2', 9);
    const { state, events } = act(s, { type: 'LEAVE', playerId: 'p2' });
    assertEvent(events, 'bankrupt', { playerId: 'p2', toPlayerId: null });
    assert.equal(player(state, 'p2').bankrupt, true);
    assert.equal(player(state, 'p2').cash, 0);
    for (const i of [6, 8, 9]) assert.equal(tile(state, i).ownerId, null);
    assert.equal(state.bank.houses, 32);
    assert.equal(state.status, 'active');
    assert.equal(current(state), 'p1');
    assert.equal(state.turn.phase, 'rolling');
    assert.deepEqual(state.players.map((p) => p.id), ['p1', 'p2', 'p3'], 'resigned players stay listed');

    // Their turn is skipped.
    let next = roll(state, 'p1', 4, 6).state;
    next = act(next, { type: 'END_TURN', playerId: 'p1' }).state;
    assert.equal(current(next), 'p3');
  });

  test('the current player resigning passes the turn', () => {
    const { state, events } = act(newGame({ players: 3 }), { type: 'LEAVE', playerId: 'p1' });
    assertEvent(events, 'bankrupt', { playerId: 'p1', toPlayerId: null });
    assert.equal(player(state, 'p1').bankrupt, true);
    assert.equal(current(state), 'p2');
    assert.equal(state.turn.phase, 'rolling');
  });

  test('resigning in a 2-player game ends it', () => {
    const { state, events } = act(newGame(), { type: 'LEAVE', playerId: 'p2' });
    assert.equal(state.status, 'finished');
    assert.equal(state.turn.phase, 'game_over');
    assert.equal(state.winnerId, 'p1');
    assert.deepEqual(events.slice(-2).map((e) => e.type), ['turn_ended', 'game_over']);
    assertEvent(events, 'turn_ended', { playerId: 'p1' }); // it was p1's turn
    assertEvent(events, 'game_over', { winnerId: 'p1' });
  });

  describe('a debtor who resigns', () => {
    /**
     * 3 players. p1 has $300, all four railroads, a mortgaged Mediterranean and a Chance jail card,
     * and owes p2 $2000 for Boardwalk.
     */
    function owingBoardwalk() {
      let s = give(give(newGame({ players: 3 }), 'p2', 39, { houses: 5 }), 'p2', 37, { houses: 5 });
      for (const i of [5, 15, 25, 35]) s = give(s, 'p1', i);
      s = giveJailCard(give(s, 'p1', 1, { mortgaged: true }), 'p1', 'chance');
      s = roll(setPosition(setCash(s, 'p1', 300), 'p1', 32), 'p1', 3, 4).state;
      assert.deepEqual(s.turn.pendingDebt, { toPlayerId: 'p2', amount: 2000, reason: 'rent' });
      return s;
    }

    test('goes bankrupt to the player they owe, exactly as DECLARE_BANKRUPTCY', () => {
      const s = owingBoardwalk();
      const left = act(s, { type: 'LEAVE', playerId: 'p1' });
      const declared = act(s, bankrupt());
      assertEvent(left.events, 'bankrupt', { playerId: 'p1', toPlayerId: 'p2', cash: 300 });
      assert.deepEqual(player(left.state, 'p2'), player(declared.state, 'p2'));
      assert.deepEqual(left.state.tiles, declared.state.tiles);
      assert.deepEqual(player(left.state, 'p2').jailCards, ['chance']);
      assert.equal(player(left.state, 'p2').cash, 1800);
      assert.deepEqual([1, 5, 15, 25, 35].map((i) => [tile(left.state, i).ownerId, tile(left.state, i).mortgaged]),
        [['p2', true], ['p2', false], ['p2', false], ['p2', false], ['p2', false]]);
      assert.equal(current(left.state), 'p2');
    });

    test('someone else resigning meanwhile still goes to the bank', () => {
      const { state, events } = act(give(owingBoardwalk(), 'p3', 12), { type: 'LEAVE', playerId: 'p3' });
      assertEvent(events, 'bankrupt', { playerId: 'p3', toPlayerId: null });
      assert.equal(tile(state, 12).ownerId, null);
      assert.equal(state.turn.phase, 'paying', "p1's debt is untouched");
      assert.equal(state.turn.pendingDebt.amount, 2000);
    });

    test('a debt to the bank, or to every player (pay_each), resigns to the bank', () => {
      const tax = roll(setCash(give(newGame({ players: 3 }), 'p1', 5), 'p1', 100), 'p1', 1, 3).state; // Income Tax
      assertEvent(act(tax, { type: 'LEAVE', playerId: 'p1' }).events, 'bankrupt', { playerId: 'p1', toPlayerId: null });
      const payEach = roll(stackDeck(setPosition(setCash(newGame({ players: 3 }), 'p1', 60), 'p1', 2), 'chance', [14]), 'p1', 1, 4).state;
      assert.ok(payEach.turn.pendingDebt.payees);
      assertEvent(act(payEach, { type: 'LEAVE', playerId: 'p1' }).events, 'bankrupt', { playerId: 'p1', toPlayerId: null });
    });
  });

  describe('a creditor who resigns', () => {
    test('a single-creditor debt is cancelled: no bankruptcy, the debtor moves on', () => {
      let s = give(give(give(newGame({ players: 3 }), 'p2', 39, { houses: 3 }), 'p2', 37), 'p1', 5);
      s = roll(setPosition(setCash(s, 'p1', 100), 'p1', 32), 'p1', 3, 4).state; // Boardwalk, 3 houses: $1400
      assert.equal(s.turn.pendingDebt.amount, 1400);
      const { state, events } = act(s, { type: 'LEAVE', playerId: 'p2' });
      assertEvent(events, 'bankrupt', { playerId: 'p2', toPlayerId: null });
      assertEvent(events, 'debt_reduced', { playerId: 'p1', amount: 0 });
      assertNoEvent(events, 'paid');
      assert.equal(state.turn.pendingDebt, null);
      assert.equal(state.turn.phase, 'end_turn');
      assert.equal(player(state, 'p1').cash, 100);
      assert.equal(tile(state, 5).mortgaged, false);
      assert.deepEqual(legalActions(state, 'p1').actions, ['LEAVE', 'END_TURN']);
      const next = act(state, { type: 'TIMEOUT', playerId: 'p1' });
      assertNoEvent(next.events, 'bankrupt');
      assert.equal(current(next.state), 'p3');
    });

    test('after a doubles roll the debtor must roll again', () => {
      let s = setCash(give(newGame({ players: 3 }), 'p2', 3), 'p1', 2);
      s = roll(setPosition(s, 'p1', 1), 'p1', 1, 1).state; // doubles → Baltic, rent $4
      assert.equal(s.turn.phase, 'paying');
      const { state } = act(s, { type: 'LEAVE', playerId: 'p2' });
      assert.equal(state.turn.pendingDebt, null);
      assert.equal(state.turn.phase, 'end_turn');
      assert.equal(state.turn.rollAgain, true);
      assert.deepEqual(legalActions(state, 'p1').actions, ['LEAVE', 'ROLL']);
      assert.equal(player(state, 'p1').cash, 2);
      assert.equal(player(state, 'p2').cash, 0);
    });

    test("a payee's share of a pay_each debt is cancelled, not sent to the pot", () => {
      let s = setPosition(setCash(newGame({ players: 3, settings: { freeParkingPot: true } }), 'p1', 60), 'p1', 2);
      s = roll(stackDeck(s, 'chance', [14]), 'p1', 1, 4).state; // Chance: pay each player $50
      assert.equal(s.turn.pendingDebt.amount, 100);
      reject(s, payDebt(), 'INSUFFICIENT_FUNDS');

      const r = act(s, { type: 'LEAVE', playerId: 'p2' });
      assertEvent(r.events, 'debt_reduced', { playerId: 'p1', amount: 50 });
      assert.deepEqual(r.state.turn.pendingDebt, { toPlayerId: null, amount: 50, reason: 'card', payees: [{ playerId: 'p3', amount: 50 }] });
      assert.equal(r.state.turn.phase, 'paying', 'nothing is paid automatically');
      assert.ok(legalActions(r.state, 'p1').actions.includes('PAY_DEBT'));

      const paid = act(r.state, payDebt());
      assert.equal(player(paid.state, 'p1').cash, 10);
      assert.equal(player(paid.state, 'p3').cash, 1550);
      assert.equal(paid.state.pot, 0);
      assert.equal(paid.state.turn.phase, 'end_turn');
    });

    test('4 players: two payees resign one after the other, the last one is paid by TIMEOUT', () => {
      let s = setPosition(setCash(newGame({ players: 4, settings: { freeParkingPot: true } }), 'p1', 120), 'p1', 2);
      s = roll(stackDeck(s, 'chance', [14]), 'p1', 1, 4).state; // owes 3 × $50
      assert.equal(s.turn.pendingDebt.amount, 150);
      s = act(s, { type: 'LEAVE', playerId: 'p3' }).state;
      assert.deepEqual(s.turn.pendingDebt.payees, [{ playerId: 'p2', amount: 50 }, { playerId: 'p4', amount: 50 }]);
      assert.equal(s.turn.pendingDebt.amount, 100);
      s = act(s, { type: 'LEAVE', playerId: 'p2' }).state;
      assert.deepEqual(s.turn.pendingDebt.payees, [{ playerId: 'p4', amount: 50 }]);
      const { state, events } = act(s, { type: 'TIMEOUT', playerId: 'p1' });
      assertEvent(events, 'debt_paid', { playerId: 'p1', amount: 50, reason: 'card', payees: [{ playerId: 'p4', amount: 50 }] });
      assert.deepEqual(state.players.map((p) => p.cash), [70, 0, 0, 1550]);
      assert.equal(state.pot, 0);
      assert.equal(state.status, 'active');
    });

    test('the creditor resigning in a 2-player game just ends it', () => {
      let s = setCash(give(newGame(), 'p2', 3), 'p1', 2);
      s = roll(s, 'p1', 1, 2).state; // rent $4 owed to p2
      const { state, events } = act(s, { type: 'LEAVE', playerId: 'p2' });
      assertNoEvent(events, 'debt_reduced');
      assert.equal(state.winnerId, 'p1');
      assert.equal(state.turn.pendingDebt, null);
    });
  });

  test('a bankrupt player cannot act any more', () => {
    const { state } = act(newGame({ players: 3 }), { type: 'LEAVE', playerId: 'p3' });
    reject(state, { type: 'LEAVE', playerId: 'p3' });
  });
});
