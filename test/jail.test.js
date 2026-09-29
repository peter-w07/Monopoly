// Jail: getting in and all the ways out (CONTRACT §4.7).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { legalActions } from '../engine/index.js';
import {
  newGame, act, reject, roll, player, current, give, giveJailCard, setCash, setPlayer,
  setPosition, assertEvent,
} from './helpers.js';

/** Current player rolls [1, 2], declines any purchase (a TIMEOUT closes the auction unsold) and ends the turn. */
function simpleTurn(state) {
  const pid = current(state);
  let s = roll(state, pid, 1, 2).state;
  if (s.turn.phase === 'buying_or_auction') s = act(s, { type: 'DECLINE', playerId: pid }).state;
  if (s.turn.phase === 'auction') s = act(s, { type: 'TIMEOUT', playerId: pid }).state;
  return act(s, { type: 'END_TURN', playerId: pid }).state;
}

/** A 2-player game where p1 went to jail (via tile 30) and it is p1's turn again. */
function jailedGame(opts) {
  let s = roll(setPosition(newGame(opts), 'p1', 25), 'p1', 2, 3).state; // → 30 → jail
  s = act(s, { type: 'END_TURN', playerId: 'p1' }).state;
  s = simpleTurn(s); // p2
  assert.equal(current(s), 'p1');
  assert.equal(s.turn.phase, 'jail_decision');
  assert.equal(player(s, 'p1').inJail, true);
  return s;
}

describe('jail', () => {
  test('a jailed player starts their turn in jail_decision', () => {
    const s = jailedGame();
    assert.equal(player(s, 'p1').jailTurns, 0);
    assert.equal(player(s, 'p1').position, 10);
    const legal = legalActions(s, 'p1').actions;
    assert.ok(legal.includes('ROLL'));
    assert.ok(legal.includes('PAY_JAIL_FINE'));
    assert.ok(!legal.includes('USE_JAIL_CARD'));
    assert.ok(!legal.includes('END_TURN'));
    reject(s, { type: 'END_TURN', playerId: 'p1' }, 'WRONG_PHASE');
    reject(s, { type: 'USE_JAIL_CARD', playerId: 'p1' }, 'NO_JAIL_CARD');
  });

  test('PAY_JAIL_FINE releases the player for a normal roll', () => {
    const { state, events } = act(jailedGame(), { type: 'PAY_JAIL_FINE', playerId: 'p1' });
    assert.equal(player(state, 'p1').cash, 1450);
    assert.equal(player(state, 'p1').inJail, false);
    assert.equal(state.turn.phase, 'rolling');
    assertEvent(events, 'left_jail', { playerId: 'p1', method: 'fine' });

    // A normal roll: doubles now give another roll.
    const after = roll(state, 'p1', 3, 3).state; // → 16, unowned
    assert.equal(player(after, 'p1').position, 16);
    assert.equal(after.turn.rollAgain, true);
  });

  test('PAY_JAIL_FINE needs enough cash', () => {
    const s = setCash(jailedGame(), 'p1', 49);
    reject(s, { type: 'PAY_JAIL_FINE', playerId: 'p1' }, 'INSUFFICIENT_FUNDS');
    assert.ok(!legalActions(s, 'p1').actions.includes('PAY_JAIL_FINE'));
  });

  test('raising cash in jail_decision (management extension) then paying the fine', () => {
    let s = give(setCash(jailedGame(), 'p1', 20), 'p1', 5); // railroad, mortgage 100
    s = act(s, { type: 'MORTGAGE', playerId: 'p1', tileIndex: 5 }).state;
    s = act(s, { type: 'PAY_JAIL_FINE', playerId: 'p1' }).state;
    assert.equal(player(s, 'p1').cash, 70);
  });

  test('USE_JAIL_CARD releases the player and returns the card', () => {
    const s = giveJailCard(jailedGame(), 'p1', 'chance');
    assert.ok(legalActions(s, 'p1').actions.includes('USE_JAIL_CARD'));
    const { state, events } = act(s, { type: 'USE_JAIL_CARD', playerId: 'p1' });
    const p = player(state, 'p1');
    assert.equal(p.inJail, false);
    assert.equal(p.getOutOfJailCards, 0);
    assert.deepEqual(p.jailCards, []);
    assert.equal(p.cash, 1500);
    assert.equal(state.turn.phase, 'rolling');
    assertEvent(events, 'left_jail', { playerId: 'p1', method: 'card' });
  });

  test('USE_JAIL_CARD removes only the first matching card', () => {
    let s = giveJailCard(giveJailCard(jailedGame(), 'p1', 'community'), 'p1', 'chance');
    s = act(s, { type: 'USE_JAIL_CARD', playerId: 'p1' }).state;
    assert.equal(player(s, 'p1').getOutOfJailCards, 1);
    assert.equal(player(s, 'p1').jailCards.length, 1);
  });

  test('rolling doubles releases and moves, with no extra roll', () => {
    const { state, events } = roll(jailedGame(), 'p1', 5, 5); // 10 → 20 Free Parking
    const p = player(state, 'p1');
    assert.equal(p.inJail, false);
    assert.equal(p.position, 20);
    assert.equal(p.cash, 1500);
    assertEvent(events, 'dice_rolled', { playerId: 'p1', dice: [5, 5], purpose: 'jail' });
    assertEvent(events, 'left_jail', { playerId: 'p1', method: 'doubles' });
    assertEvent(events, 'moved', { playerId: 'p1', from: 10, to: 20 });
    assert.equal(state.turn.phase, 'end_turn');
    assert.equal(state.turn.rollAgain, false);
    act(state, { type: 'END_TURN', playerId: 'p1' });
  });

  test('doubles out of jail onto an unowned property → purchase, then no extra roll', () => {
    let { state } = roll(jailedGame(), 'p1', 2, 2); // → 14 Virginia
    assert.equal(state.turn.phase, 'buying_or_auction');
    state = act(state, { type: 'BUY', playerId: 'p1' }).state;
    assert.equal(state.turn.rollAgain, false);
    act(state, { type: 'END_TURN', playerId: 'p1' });
  });

  test('a failed roll keeps the player in jail and ends the turn', () => {
    const { state, events } = roll(jailedGame(), 'p1', 1, 2);
    const p = player(state, 'p1');
    assert.equal(p.inJail, true);
    assert.equal(p.jailTurns, 1);
    assert.equal(p.position, 10);
    assertEvent(events, 'jail_roll_failed', { playerId: 'p1', attempt: 1 });
    assert.equal(state.turn.phase, 'end_turn');
    assert.equal(state.turn.rollAgain, false);
    const next = act(state, { type: 'END_TURN', playerId: 'p1' }).state;
    assert.equal(current(next), 'p2');
  });

  test('the third failed roll forces the fine and moves', () => {
    let s = jailedGame();
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = roll(s, 'p1', 1, 2);
      assertEvent(r.events, 'jail_roll_failed', { playerId: 'p1', attempt });
      s = act(r.state, { type: 'END_TURN', playerId: 'p1' }).state;
      s = simpleTurn(s); // p2
    }
    assert.equal(player(s, 'p1').jailTurns, 2);
    assert.equal(s.turn.phase, 'jail_decision');

    const { state, events } = roll(s, 'p1', 4, 6); // not doubles, total 10 → 20
    const p = player(state, 'p1');
    assert.equal(p.inJail, false);
    assert.equal(p.cash, 1450);
    assert.equal(p.position, 20);
    assertEvent(events, 'left_jail', { playerId: 'p1', method: 'forced_fine' });
    assertEvent(events, 'moved', { playerId: 'p1', from: 10, to: 20 });
    assert.equal(state.turn.phase, 'end_turn');
    assert.equal(state.turn.rollAgain, false);
  });

  test('an unaffordable forced fine becomes a debt that moves the player once paid', () => {
    let s = setPlayer(jailedGame(), 'p1', { jailTurns: 2, cash: 20 });
    s = give(s, 'p1', 1); // mortgage value 30
    let { state } = roll(s, 'p1', 4, 6);
    assert.equal(state.turn.phase, 'paying');
    const debt = state.turn.pendingDebt;
    assert.equal(debt.toPlayerId, null);
    assert.equal(debt.amount, 50);
    assert.deepEqual(debt.then, { kind: 'jail_move', steps: 10 });
    assert.equal(player(state, 'p1').position, 10, 'no move until the fine is paid');

    reject(state, { type: 'PAY_DEBT', playerId: 'p1' }, 'INSUFFICIENT_FUNDS');
    state = act(state, { type: 'MORTGAGE', playerId: 'p1', tileIndex: 1 }).state;
    const paid = act(state, { type: 'PAY_DEBT', playerId: 'p1' });
    const p = player(paid.state, 'p1');
    assert.equal(p.cash, 0);
    assert.equal(p.position, 20);
    assert.equal(p.inJail, false);
    assertEvent(paid.events, 'moved', { playerId: 'p1', from: 10, to: 20 });
    assert.equal(paid.state.turn.phase, 'end_turn');
    assert.equal(paid.state.turn.pendingDebt, null);
  });

  test('jail actions are rejected when not in jail', () => {
    const s = giveJailCard(newGame(), 'p1', 'chance');
    reject(s, { type: 'PAY_JAIL_FINE', playerId: 'p1' }, ['WRONG_PHASE', 'NOT_IN_JAIL']);
    reject(s, { type: 'USE_JAIL_CARD', playerId: 'p1' }, ['WRONG_PHASE', 'NOT_IN_JAIL']);
  });
});
