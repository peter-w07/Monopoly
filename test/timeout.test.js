// TIMEOUT auto-actions per phase (CONTRACT §4.9) and autoRaise order (§4.10).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newGame, lobby, act, reject, roll, withDice, player, tile, current, give, jail, setCash, assertEvent,
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

  test('buying_or_auction → DECLINE', () => {
    const s = roll(newGame(), 'p1', 1, 2).state;
    const { state, events } = act(s, timeout());
    assertEvent(events, 'timeout', { playerId: 'p1', phase: 'buying_or_auction' });
    assertEvent(events, 'declined', { playerId: 'p1', tileIndex: 3 });
    assert.equal(tile(state, 3).ownerId, null);
    assert.equal(state.turn.phase, 'end_turn');
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

  test('paying and unable to raise enough → bankruptcy', () => {
    let s = give(newGame({ players: 3 }), 'p1', 6);
    s = owingTax(s, 100); // 100 + 50 mortgage < 200
    const { state, events } = act(s, timeout());
    assertEvent(events, 'bankrupt', { playerId: 'p1', toPlayerId: null });
    assert.equal(player(state, 'p1').bankrupt, true);
    assert.equal(tile(state, 6).ownerId, null);
    assert.equal(current(state), 'p2');
  });

  test('only the current player can time out, and only in an active game', () => {
    reject(newGame(), timeout('p2'), 'NOT_YOUR_TURN');
    reject(lobby({ players: 2 }), timeout('p1'), ['GAME_NOT_ACTIVE', 'WRONG_PHASE']);
  });
});
