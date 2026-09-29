// Rolling, movement, GO, doubles, buying and ending the turn (CONTRACT §4.3, §4.4).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { legalActions } from '../engine/index.js';
import {
  newGame, act, reject, roll, player, tile, current, ofType, assertEvent, assertNoEvent,
  setPosition, setCash, setPlayer, stackDeck, give,
} from './helpers.js';

describe('movement and GO', () => {
  test('a normal roll moves forward and records the roll', () => {
    const { state, events } = roll(newGame(), 'p1', 2, 4);
    assert.equal(player(state, 'p1').position, 6);
    assert.deepEqual(state.turn.lastRoll, [2, 4]);
    assertEvent(events, 'dice_rolled', { playerId: 'p1', dice: [2, 4], doubles: false, purpose: 'move' });
    assertEvent(events, 'moved', { playerId: 'p1', from: 0, to: 6, steps: 6, via: 'roll' });
    assertEvent(events, 'landed', { playerId: 'p1', tileIndex: 6 });
  });

  test('passing GO pays the salary once', () => {
    const { state, events } = roll(setPosition(newGame(), 'p1', 38), 'p1', 2, 3);
    assert.equal(player(state, 'p1').position, 3);
    assert.equal(player(state, 'p1').cash, 1700);
    assert.equal(ofType(events, 'passed_go').length, 1);
    assertEvent(events, 'passed_go', { playerId: 'p1', amount: 200 });
    assertEvent(events, 'moved', { playerId: 'p1', from: 38, to: 3, steps: 5, via: 'roll' });
    assert.equal(state.turn.phase, 'buying_or_auction');
    assert.equal(state.turn.pendingPurchase, 3);
  });

  test('landing exactly on GO pays the salary once', () => {
    const { state, events } = roll(setPosition(newGame(), 'p1', 35), 'p1', 2, 3);
    assert.equal(player(state, 'p1').position, 0);
    assert.equal(player(state, 'p1').cash, 1700);
    assert.equal(ofType(events, 'passed_go').length, 1);
    assert.equal(state.turn.phase, 'end_turn');
  });

  test('a card that advances past GO pays the salary', () => {
    let s = stackDeck(setPosition(newGame(), 'p1', 31), 'chance', [3]); // Advance to St. Charles (11)
    const { state, events } = roll(s, 'p1', 2, 3);                      // 31 → 36 Chance
    assertEvent(events, 'card_drawn', { playerId: 'p1', deck: 'chance', cardId: 3 });
    assert.equal(player(state, 'p1').position, 11);
    assert.equal(player(state, 'p1').cash, 1700);
    assert.equal(ofType(events, 'passed_go').length, 1);
    assert.equal(state.turn.phase, 'buying_or_auction');
    assert.equal(state.turn.pendingPurchase, 11);
  });

  test('"Advance to GO" pays the salary exactly once', () => {
    const s = stackDeck(setPosition(newGame(), 'p1', 2), 'chance', [1]);
    const { state, events } = roll(s, 'p1', 2, 3); // 2 → 7 Chance → GO
    assert.equal(player(state, 'p1').position, 0);
    assert.equal(player(state, 'p1').cash, 1700);
    assert.equal(ofType(events, 'passed_go').length, 1);
  });

  test('a card that advances without passing GO pays nothing', () => {
    const s = stackDeck(setPosition(newGame(), 'p1', 2), 'chance', [0]); // Boardwalk
    const { state, events } = roll(s, 'p1', 2, 3);
    assert.equal(player(state, 'p1').position, 39);
    assert.equal(player(state, 'p1').cash, 1500);
    assertNoEvent(events, 'passed_go');
    assert.equal(state.turn.pendingPurchase, 39);
  });

  test('Go To Jail tile never pays GO', () => {
    const { state, events } = roll(setPosition(newGame(), 'p1', 25), 'p1', 2, 3); // → 30
    const p = player(state, 'p1');
    assert.equal(p.position, 10);
    assert.equal(p.inJail, true);
    assert.equal(p.jailTurns, 0);
    assert.equal(p.cash, 1500);
    assertNoEvent(events, 'passed_go');
    assertEvent(events, 'sent_to_jail', { playerId: 'p1', reason: 'tile' });
    assert.equal(state.turn.phase, 'end_turn');
    assert.equal(state.turn.rollAgain, false);
  });

  test('Go To Jail card never pays GO', () => {
    const s = stackDeck(setPosition(newGame(), 'p1', 31), 'chance', [10]);
    const { state, events } = roll(s, 'p1', 2, 3); // → 36 Chance → jail
    assert.equal(player(state, 'p1').position, 10);
    assert.equal(player(state, 'p1').inJail, true);
    assert.equal(player(state, 'p1').cash, 1500);
    assertNoEvent(events, 'passed_go');
    assertEvent(events, 'sent_to_jail', { playerId: 'p1', reason: 'card' });
    assert.equal(state.turn.phase, 'end_turn');
  });

  test('Community Chest jail card works the same', () => {
    const s = stackDeck(setPosition(newGame(), 'p1', 28), 'community', [5]);
    const { state } = roll(s, 'p1', 2, 3); // → 33 Community Chest → jail
    assert.equal(player(state, 'p1').position, 10);
    assert.equal(player(state, 'p1').inJail, true);
    assert.equal(player(state, 'p1').cash, 1500);
  });

  test('taxes are paid to the bank', () => {
    const { state, events } = roll(newGame(), 'p1', 1, 3); // → 4 Income Tax (200)
    assert.equal(player(state, 'p1').cash, 1300);
    assertEvent(events, 'paid_tax', { playerId: 'p1', tileIndex: 4, amount: 200 });
    assert.equal(state.pot, 0);
    assert.equal(state.turn.phase, 'end_turn');
  });
});

describe('doubles', () => {
  test('doubles force another roll: END_TURN rejected, then ROLL works', () => {
    let { state } = roll(newGame({ settings: { auctionOnDecline: false } }), 'p1', 5, 5); // → 10 just visiting
    assert.equal(state.turn.phase, 'end_turn');
    assert.equal(state.turn.rollAgain, true);
    assert.equal(state.turn.doublesCount, 1);
    reject(state, { type: 'END_TURN', playerId: 'p1' }, 'MUST_ROLL_AGAIN');
    const legal = legalActions(state, 'p1').actions;
    assert.ok(legal.includes('ROLL'));
    assert.ok(!legal.includes('END_TURN'));

    ({ state } = roll(state, 'p1', 1, 2)); // → 13, unowned
    assert.equal(player(state, 'p1').position, 13);
    state = act(state, { type: 'DECLINE', playerId: 'p1' }).state;
    assert.equal(state.turn.phase, 'end_turn');
    assert.equal(state.turn.rollAgain, false);
    state = act(state, { type: 'END_TURN', playerId: 'p1' }).state;
    assert.equal(current(state), 'p2');
  });

  test('rollAgain survives a purchase decision', () => {
    let { state } = roll(newGame(), 'p1', 3, 3); // → 6 Oriental, unowned
    assert.equal(state.turn.phase, 'buying_or_auction');
    state = act(state, { type: 'BUY', playerId: 'p1' }).state;
    assert.equal(state.turn.phase, 'end_turn');
    assert.equal(state.turn.rollAgain, true);
    reject(state, { type: 'END_TURN', playerId: 'p1' }, 'MUST_ROLL_AGAIN');
    roll(state, 'p1', 1, 2);
  });

  test('three doubles in a row send the player to jail without moving', () => {
    let s = newGame();
    s = roll(s, 'p1', 5, 5).state; // → 10
    s = roll(s, 'p1', 5, 5).state; // → 20 free parking
    assert.equal(s.turn.doublesCount, 2);
    const { state, events } = roll(s, 'p1', 1, 1);
    const p = player(state, 'p1');
    assert.equal(p.position, 10);
    assert.equal(p.inJail, true);
    assert.equal(p.cash, 1500);
    assertEvent(events, 'sent_to_jail', { playerId: 'p1', reason: 'doubles' });
    assert.ok(!ofType(events, 'moved').some((e) => e.via === 'roll'), 'no normal move on the third doubles');
    assertNoEvent(events, 'passed_go');
    assert.equal(state.turn.phase, 'end_turn');
    assert.equal(state.turn.rollAgain, false);
    assert.equal(state.turn.doublesCount, 0);

    // The turn ends normally; next time round the player starts in jail_decision.
    let next = act(state, { type: 'END_TURN', playerId: 'p1' }).state;
    assert.equal(current(next), 'p2');
    assert.equal(next.turn.phase, 'rolling');
    next = roll(next, 'p2', 4, 6).state; // → 10 just visiting
    next = act(next, { type: 'END_TURN', playerId: 'p2' }).state;
    assert.equal(current(next), 'p1');
    assert.equal(next.turn.phase, 'jail_decision');
  });

  test('doubles that land on Go To Jail clear rollAgain', () => {
    const { state } = roll(setPosition(newGame(), 'p1', 26), 'p1', 2, 2); // → 30
    assert.equal(player(state, 'p1').inJail, true);
    assert.equal(state.turn.rollAgain, false);
    act(state, { type: 'END_TURN', playerId: 'p1' });
  });
});

describe('buying and declining', () => {
  test('BUY transfers the tile for its price', () => {
    let { state } = roll(newGame(), 'p1', 1, 2); // → 3 Baltic (60)
    assert.equal(state.turn.phase, 'buying_or_auction');
    assert.equal(state.turn.pendingPurchase, 3);
    const { state: after, events } = act(state, { type: 'BUY', playerId: 'p1' });
    assert.equal(tile(after, 3).ownerId, 'p1');
    assert.equal(player(after, 'p1').cash, 1440);
    assert.equal(after.turn.phase, 'end_turn');
    assert.equal(after.turn.pendingPurchase, null);
    assertEvent(events, 'bought', { playerId: 'p1', tileIndex: 3, price: 60 });
  });

  test('DECLINE leaves the tile unowned (auctionOnDecline off; with it on see auction.test.js)', () => {
    const { state } = roll(newGame({ settings: { auctionOnDecline: false } }), 'p1', 1, 2);
    const { state: after, events } = act(state, { type: 'DECLINE', playerId: 'p1' });
    assert.equal(tile(after, 3).ownerId, null);
    assert.equal(player(after, 'p1').cash, 1500);
    assert.equal(after.turn.phase, 'end_turn');
    assert.equal(after.turn.pendingPurchase, null);
    assertEvent(events, 'declined', { playerId: 'p1', tileIndex: 3 });
  });

  test('an unaffordable tile still offers the decision; BUY fails until cash is raised', () => {
    let s = setCash(setPosition(newGame(), 'p1', 35), 'p1', 300);
    s = give(s, 'p1', 5); // Reading Railroad, mortgage value 100
    let { state } = roll(s, 'p1', 1, 3); // → 39 Boardwalk (400)
    assert.equal(state.turn.phase, 'buying_or_auction');
    assert.equal(state.turn.pendingPurchase, 39);
    reject(state, { type: 'BUY', playerId: 'p1' }, 'INSUFFICIENT_FUNDS');
    assert.ok(!legalActions(state, 'p1').actions.includes('BUY'));
    state = act(state, { type: 'MORTGAGE', playerId: 'p1', tileIndex: 5 }).state;
    state = act(state, { type: 'BUY', playerId: 'p1' }).state;
    assert.equal(tile(state, 39).ownerId, 'p1');
    assert.equal(player(state, 'p1').cash, 0);
  });

  test('BUY / DECLINE are only valid while a purchase is pending', () => {
    const s = newGame();
    reject(s, { type: 'BUY', playerId: 'p1' }, 'WRONG_PHASE');
    reject(s, { type: 'DECLINE', playerId: 'p1' }, 'WRONG_PHASE');
    const { state } = roll(s, 'p1', 1, 2);
    reject(state, { type: 'BUY', playerId: 'p2' }, 'NOT_YOUR_TURN');
    reject(state, { type: 'END_TURN', playerId: 'p1' }, 'WRONG_PHASE');
    reject(state, { type: 'ROLL', playerId: 'p1' }, 'WRONG_PHASE');
  });
});

describe('ending the turn', () => {
  test('END_TURN passes to the next player and resets the turn', () => {
    let s = roll(newGame({ players: 3, settings: { auctionOnDecline: false } }), 'p1', 1, 2).state;
    s = act(s, { type: 'DECLINE', playerId: 'p1' }).state;
    const { state, events } = act(s, { type: 'END_TURN', playerId: 'p1' });
    assert.equal(current(state), 'p2');
    assert.equal(state.turn.currentIndex, 1);
    assert.equal(state.turn.number, 2);
    assert.equal(state.turn.phase, 'rolling');
    assert.equal(state.turn.doublesCount, 0);
    assert.equal(state.turn.rollAgain, false);
    assert.equal(state.turn.lastRoll, null);
    assert.equal(state.turn.pendingPurchase, null);
    assertEvent(events, 'turn_ended', { playerId: 'p1' });
    assertEvent(events, 'turn_started', { playerId: 'p2', turnNumber: 2 });
  });

  test('END_TURN skips bankrupt players and wraps around', () => {
    let s = setPlayer(newGame({ players: 3 }), 'p2', { bankrupt: true, cash: 0 });
    s = roll(s, 'p1', 4, 6).state; // → 10 just visiting
    s = act(s, { type: 'END_TURN', playerId: 'p1' }).state;
    assert.equal(current(s), 'p3');
    s = roll(s, 'p3', 4, 6).state;
    s = act(s, { type: 'END_TURN', playerId: 'p3' }).state;
    assert.equal(current(s), 'p1');
    assert.equal(s.turn.number, 3);
    assert.deepEqual(s.turn.order, ['p1', 'p2', 'p3'], 'bankrupt players stay in order');
  });

  test('END_TURN is not allowed before rolling or off-turn', () => {
    const s = newGame();
    reject(s, { type: 'END_TURN', playerId: 'p1' }, 'WRONG_PHASE');
    reject(s, { type: 'ROLL', playerId: 'p2' }, 'NOT_YOUR_TURN');
  });
});
