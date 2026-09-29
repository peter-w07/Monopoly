// TIMEOUT auto-actions per phase (CONTRACT §4.9) and autoRaise order (§4.10).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { legalActions, liquidationValue } from '../engine/index.js';
import {
  newGame, lobby, act, reject, roll, withDice, player, tile, current, give, jail, setCash, setPosition,
  stackDeck, assertEvent, assertNoEvent, ofType,
} from './helpers.js';

const timeout = (playerId = 'p1') => ({ type: 'TIMEOUT', playerId });

/** p1 lands on Income Tax (200) holding `cash`. */
function owingTax(state, cash) {
  const s = roll(setCash(state, 'p1', cash), 'p1', 1, 3).state;
  assert.equal(s.turn.phase, 'paying');
  return s;
}

describe('TIMEOUT', () => {
  test('rolling → ROLL', () => {
    const { state, events } = act(withDice(newGame(), 1, 2), timeout());
    assert.equal(events[0].type, 'timeout');
    assertEvent(events, 'timeout', { playerId: 'p1', phase: 'rolling' });
    assertEvent(events, 'dice_rolled', { playerId: 'p1', dice: [1, 2] });
    assert.equal(player(state, 'p1').position, 3);
    assert.equal(state.turn.phase, 'buying_or_auction');
  });

  test('buying_or_auction → DECLINE (which opens an auction when auctionOnDecline is on)', () => {
    const s = roll(newGame(), 'p1', 1, 2).state;
    const { state, events } = act(s, timeout());
    assertEvent(events, 'timeout', { playerId: 'p1', phase: 'buying_or_auction' });
    assertEvent(events, 'declined', { playerId: 'p1', tileIndex: 3 });
    assertEvent(events, 'auction_started', { tileIndex: 3 });
    assert.equal(tile(state, 3).ownerId, null);
    assert.equal(state.turn.phase, 'auction');

    const off = roll(newGame({ settings: { auctionOnDecline: false } }), 'p1', 1, 2).state;
    const declined = act(off, timeout());
    assertEvent(declined.events, 'declined', { playerId: 'p1', tileIndex: 3 });
    assert.equal(tile(declined.state, 3).ownerId, null);
    assert.equal(declined.state.turn.phase, 'end_turn');
  });

  test('end_turn → END_TURN', () => {
    const s = roll(newGame(), 'p1', 4, 6).state;
    const { state, events } = act(s, timeout());
    assertEvent(events, 'timeout', { playerId: 'p1', phase: 'end_turn' });
    assertEvent(events, 'turn_ended', { playerId: 'p1' });
    assert.equal(current(state), 'p2');
  });

  test('end_turn with rollAgain → ROLL', () => {
    const s = roll(newGame(), 'p1', 5, 5).state; // → 10, must roll again
    const { state, events } = act(withDice(s, 4, 6), timeout());
    assertEvent(events, 'timeout', { playerId: 'p1', phase: 'end_turn' });
    assertEvent(events, 'dice_rolled', { playerId: 'p1', dice: [4, 6] });
    assert.equal(player(state, 'p1').position, 20);
    assert.equal(current(state), 'p1');
  });

  test('jail_decision → ROLL (a jail roll)', () => {
    const s = jail(newGame(), 'p1');
    assert.equal(s.turn.phase, 'jail_decision');
    const { state, events } = act(withDice(s, 1, 2), timeout());
    assertEvent(events, 'timeout', { playerId: 'p1', phase: 'jail_decision' });
    assertEvent(events, 'jail_roll_failed', { playerId: 'p1', attempt: 1 });
    assert.equal(player(state, 'p1').inJail, true);
    assert.equal(player(state, 'p1').cash, 1500, 'a timeout never pays the fine by choice');
    assert.equal(state.turn.phase, 'end_turn');
  });

  test('paying with enough cash → PAY_DEBT', () => {
    let s = give(owingTax(newGame(), 150), 'p1', 6);
    s = act(s, { type: 'MORTGAGE', playerId: 'p1', tileIndex: 6 }).state;
    const { state, events } = act(s, timeout());
    assertEvent(events, 'timeout', { playerId: 'p1', phase: 'paying' });
    assertEvent(events, 'debt_paid', { playerId: 'p1', amount: 200 });
    assert.equal(player(state, 'p1').cash, 0);
    assert.equal(state.turn.phase, 'end_turn');
  });

  test('paying short → autoRaise mortgages in ascending index order, then pays', () => {
    let s = give(give(newGame(), 'p1', 6), 'p1', 8);
    s = owingTax(s, 150);
    const { state } = act(s, timeout());
    assert.equal(tile(state, 6).mortgaged, true);
    assert.equal(tile(state, 8).mortgaged, false, 'stops once the debt is covered');
    assert.equal(player(state, 'p1').cash, 0);
    assert.equal(player(state, 'p1').bankrupt, false);
    assert.equal(state.turn.phase, 'end_turn');
  });

  test('autoRaise sells from the tile with most buildings first (ties → lowest index)', () => {
    let s = give(newGame(), 'p1', 6, { houses: 1 });
    s = give(s, 'p1', 8, { houses: 2 });
    s = give(s, 'p1', 9, { houses: 1 });
    s = owingTax(s, 150); // needs 50 = two levels at 25
    const { state } = act(s, timeout());
    assert.deepEqual([6, 8, 9].map((i) => tile(state, i).houses), [0, 1, 1]);
    assert.ok([6, 8, 9].every((i) => !tile(state, i).mortgaged));
    assert.equal(player(state, 'p1').cash, 0);
    assert.equal(state.turn.phase, 'end_turn');
  });

  test('autoRaise: loose tiles are mortgaged first, then buildings sold, then the rest mortgaged', () => {
    let s = give(give(give(newGame(), 'p1', 1, { houses: 1 }), 'p1', 3, { houses: 1 }), 'p1', 5);
    s = owingTax(s, 20); // 20 + Reading 100 + 2 houses × 25 = 170; Mediterranean's 30 makes 200
    const { state, events } = act(s, timeout());
    const steps = events.filter((e) => ['mortgaged', 'sold_house', 'debt_paid'].includes(e.type)).map((e) => `${e.type}:${e.tileIndex ?? ''}`);
    assert.deepEqual(steps, ['mortgaged:5', 'sold_house:1', 'sold_house:3', 'mortgaged:1', 'debt_paid:']);
    assert.equal(tile(state, 3).mortgaged, false, 'stops once the debt is covered');
    assert.equal(player(state, 'p1').cash, 0);
  });

  test('autoRaise keeps buildings when mortgaging a railroad covers the debt', () => {
    let s = give(give(give(newGame(), 'p1', 1, { houses: 2 }), 'p1', 3, { houses: 2 }), 'p1', 5);
    s = owingTax(s, 150);
    const { state, events } = act(s, timeout());
    assertNoEvent(events, 'sold_house');
    assert.deepEqual([tile(state, 1).houses, tile(state, 3).houses], [2, 2]);
    assert.equal(tile(state, 5).mortgaged, true);
    assert.equal(player(state, 'p1').cash, 50);
  });

  test('collect_each auto-liquidates an off-turn player the same way: railroad before hotel', () => {
    let s = give(give(give(newGame(), 'p2', 37, { houses: 5 }), 'p2', 39, { houses: 5 }), 'p2', 5);
    s = stackDeck(setPosition(setCash(s, 'p2', 5), 'p1', 12), 'community', [8]); // birthday: $10 from each
    const { state, events } = roll(s, 'p1', 2, 3); // → 17 Community Chest
    assertEvent(events, 'mortgaged', { playerId: 'p2', tileIndex: 5, amount: 100 });
    assertNoEvent(events, 'sold_house');
    assertEvent(events, 'collected', { playerId: 'p1', fromPlayerId: 'p2', amount: 10 });
    assert.equal(tile(state, 37).houses, 5);
    assert.equal(player(state, 'p2').cash, 95);
  });

  test('paying and unable to raise enough → bankruptcy', () => {
    let s = give(newGame({ players: 3 }), 'p1', 6);
    s = owingTax(s, 100); // 100 + 50 mortgage < 200
    const { state, events } = act(s, timeout());
    assertNoEvent(events, 'mortgaged');
    assertEvent(events, 'bankrupt', { playerId: 'p1', toPlayerId: null });
    assert.equal(player(state, 'p1').bankrupt, true);
    assert.equal(tile(state, 6).ownerId, null);
    assert.equal(current(state), 'p2');
  });

  test('a hopeless debt to a player: nothing is mortgaged, the creditor gets clean tiles', () => {
    let s = give(give(newGame(), 'p2', 39, { houses: 5 }), 'p2', 37, { houses: 5 });
    for (const i of [5, 12, 15, 25, 28, 35]) s = give(s, 'p1', i);
    s = roll(setPosition(setCash(s, 'p1', 50), 'p1', 32), 'p1', 3, 4).state; // Boardwalk hotel: $2000
    assert.equal(liquidationValue(s, 'p1'), 600);
    const { state, events } = act(s, timeout());
    assertNoEvent(events, 'mortgaged');
    assertEvent(events, 'bankrupt', { playerId: 'p1', toPlayerId: 'p2', cash: 50 });
    for (const i of [5, 12, 15, 25, 28, 35]) assert.deepEqual(tile(state, i), { index: i, ownerId: 'p2', houses: 0, mortgaged: false });
    assert.equal(player(state, 'p2').cash, 1550);
  });

  test('a debtor whose only assets are hotels can sell them during a house shortage (and TIMEOUT pays)', () => {
    let s = give(give(newGame(), 'p1', 37, { houses: 5 }), 'p1', 39, { houses: 5 });
    // p2 holds 30 of the bank's 32 houses: oranges and reds 4/4/4, light blues 2/2/2.
    for (const i of [16, 18, 19, 21, 23, 24]) s = give(s, 'p2', i, { houses: 4 });
    for (const i of [6, 8, 9]) s = give(s, 'p2', i, { houses: 2 });
    assert.equal(s.bank.houses, 2);
    s = roll(setPosition(setCash(s, 'p1', 100), 'p1', 14), 'p1', 3, 4).state; // Kentucky, 4 houses: $875
    assert.deepEqual(s.turn.pendingDebt, { toPlayerId: 'p2', amount: 875, reason: 'rent' });

    assert.deepEqual(legalActions(s, 'p1').sellHouse, [37, 39]);
    act(s, { type: 'SELL_HOUSE', playerId: 'p1', tileIndex: 39 });

    const { state, events } = act(s, timeout());
    // Park Place breaks into the bank's last 2 houses ($300), Boardwalk into none ($500).
    assert.deepEqual(ofType(events, 'sold_house').map((e) => [e.tileIndex, e.houses, e.amount]), [[37, 2, 300], [39, 0, 500]]);
    assertEvent(events, 'debt_paid', { playerId: 'p1', toPlayerId: 'p2', amount: 875, reason: 'rent' });
    assertNoEvent(events, 'bankrupt');
    assertNoEvent(events, 'game_over');
    assert.equal(player(state, 'p1').cash, 25);
    assert.equal(player(state, 'p2').cash, 1500 + 875);
    assert.equal(state.status, 'active');
    assert.equal(state.turn.phase, 'end_turn');
  });

  test('only the current player can time out, and only in an active game', () => {
    reject(newGame(), timeout('p2'), 'NOT_YOUR_TURN');
    reject(lobby({ players: 2 }), timeout('p1'), ['GAME_NOT_ACTIVE', 'WRONG_PHASE']);
  });
});
