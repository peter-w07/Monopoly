// Debt, bankruptcy, resigning and game over (CONTRACT §4.6, §4.8, §4.2 LEAVE).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { legalActions } from '../engine/index.js';
import {
  newGame, act, reject, roll, player, tile, current, give, giveJailCard, setCash, setPosition,
  stackDeck, assertEvent,
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
    assertEvent(paid.events, 'debt_paid', { playerId: 'p1', toPlayerId: null, amount: 200 });
  });

  test('rent debt is paid to the owner once cash is raised', () => {
    let s = give(setCash(newGame(), 'p1', 2), 'p1', 6);
    s = give(s, 'p2', 3); // rent 4
    let { state } = roll(s, 'p1', 1, 2);
    assert.equal(state.turn.phase, 'paying');
    assert.equal(state.turn.pendingDebt.toPlayerId, 'p2');
    assert.equal(state.turn.pendingDebt.amount, 4);
    state = act(state, { type: 'MORTGAGE', playerId: 'p1', tileIndex: 6 }).state;
    state = act(state, payDebt()).state;
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
    assertEvent(events, 'bankrupt', { playerId: 'p1', toPlayerId: 'p2' });

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
    assertEvent(r.events, 'bankrupt', { playerId: 'p1', toPlayerId: null });
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
    const { state } = act(newGame({ players: 3 }), { type: 'LEAVE', playerId: 'p1' });
    assert.equal(player(state, 'p1').bankrupt, true);
    assert.equal(current(state), 'p2');
    assert.equal(state.turn.phase, 'rolling');
  });

  test('resigning in a 2-player game ends it', () => {
    const { state, events } = act(newGame(), { type: 'LEAVE', playerId: 'p2' });
    assert.equal(state.status, 'finished');
    assert.equal(state.turn.phase, 'game_over');
    assert.equal(state.winnerId, 'p1');
    assertEvent(events, 'game_over', { winnerId: 'p1' });
  });

  test('a debt owed to a resigning player is redirected to the bank', () => {
    let s = setCash(give(newGame({ players: 3 }), 'p2', 3), 'p1', 2); // rent 4 owed to p2
    s = give(s, 'p1', 6);
    let { state } = roll(s, 'p1', 1, 2);
    assert.equal(state.turn.pendingDebt.toPlayerId, 'p2');
    state = act(state, { type: 'LEAVE', playerId: 'p2' }).state;
    assert.equal(state.turn.pendingDebt.toPlayerId, null);
    assert.equal(state.turn.phase, 'paying');
    state = act(state, { type: 'MORTGAGE', playerId: 'p1', tileIndex: 6 }).state;
    state = act(state, payDebt()).state;
    assert.equal(player(state, 'p1').cash, 48);
    assert.equal(player(state, 'p2').cash, 0);
  });

  test('a bankrupt player cannot act any more', () => {
    const { state } = act(newGame({ players: 3 }), { type: 'LEAVE', playerId: 'p3' });
    reject(state, { type: 'LEAVE', playerId: 'p3' });
  });
});
