// Cross-cutting guarantees of applyAction (CONTRACT §2 actions.js, §4.1): determinism,
// immutability, error handling, seq, stubs.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, legalActions, getTile } from '../engine/index.js';
import { newGame, lobby, act, reject, roll, player, current, give, TOKEN_IDS } from './helpers.js';

/**
 * Deterministic auto-player: builds when rich, buys whatever it lands on, pays debts,
 * otherwise rolls / ends the turn, and falls back to TIMEOUT (which handles jail,
 * declining and bankruptcy). Every chosen action must succeed.
 */
function chooseAction(state) {
  const pid = current(state);
  const legal = legalActions(state, pid);
  const cash = player(state, pid).cash;
  if (legal.build.length && cash > 700) return { type: 'BUILD', playerId: pid, tileIndex: legal.build[0] };
  if (legal.unmortgage.length && cash > 900) return { type: 'UNMORTGAGE', playerId: pid, tileIndex: legal.unmortgage[0] };
  for (const type of ['BUY', 'PAY_DEBT', 'USE_JAIL_CARD', 'ROLL', 'END_TURN']) {
    if (legal.actions.includes(type)) return { type, playerId: pid };
  }
  return { type: 'TIMEOUT', playerId: pid };
}

function autoPlay(state, maxSteps, actions = []) {
  const events = [];
  for (let i = 0; i < maxSteps && state.status === 'active'; i++) {
    const action = chooseAction(state);
    const res = applyAction(state, action);
    assert.ok(!res.error, `step ${i}: ${JSON.stringify(action)} failed: ${JSON.stringify(res.error)}`);
    assert.equal(res.state.seq, state.seq + 1);
    actions.push(action);
    events.push(res.events);
    state = res.state;
  }
  return { state, events, actions };
}

function replay(state, actions) {
  for (const action of actions) state = act(state, action).state;
  return state;
}

describe('determinism', () => {
  test('same seed + same actions → identical final state and events', () => {
    const a = autoPlay(newGame({ players: 3, seed: 20240601 }), 600);
    const b = autoPlay(newGame({ players: 3, seed: 20240601 }), 600);
    assert.deepStrictEqual(a.state, b.state);
    assert.deepStrictEqual(a.events, b.events);
    assert.ok(a.actions.length > 100, 'the simulated game should run for a while');

    const c = autoPlay(newGame({ players: 3, seed: 7 }), 600);
    assert.notDeepStrictEqual(a.state, c.state);
  });

  test('a JSON-saved state replays identically', () => {
    const start = autoPlay(newGame({ players: 4, seed: 99 }), 150).state;
    const { actions, state: direct } = autoPlay(start, 200);
    const restored = JSON.parse(JSON.stringify(start));
    assert.deepStrictEqual(restored, start, 'state is plain JSON');
    assert.deepStrictEqual(replay(restored, actions), direct);
  });

  test('simulated games reach game over with a winner', () => {
    let finished = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
      const { state } = autoPlay(newGame({ players: 2, seed }), 1500);
      assert.ok(state.status === 'active' || state.status === 'finished');
      if (state.status === 'finished') {
        finished += 1;
        assert.equal(state.turn.phase, 'game_over');
        const alive = state.players.filter((p) => !p.bankrupt);
        assert.equal(alive.length, 1);
        assert.equal(state.winnerId, alive[0].id);
      }
      // Bank supply never goes negative or above the board totals.
      assert.ok(state.bank.houses >= 0 && state.bank.houses <= 32);
      assert.ok(state.bank.hotels >= 0 && state.bank.hotels <= 12);
      const onBoard = state.tiles.reduce((n, t) => n + (t.houses === 5 ? 0 : t.houses), 0);
      const hotels = state.tiles.filter((t) => t.houses === 5).length;
      assert.equal(onBoard + state.bank.houses, 32);
      assert.equal(hotels + state.bank.hotels, 12);
    }
    assert.ok(finished >= 1, 'at least one simulated game should finish');
  });
});

describe('failed actions leave the state untouched', () => {
  test('error codes for malformed or misplaced actions', () => {
    const s = newGame();
    reject(s, { type: 'FLY', playerId: 'p1' }, 'UNKNOWN_ACTION');
    reject(s, { playerId: 'p1' }, ['UNKNOWN_ACTION', 'BAD_PAYLOAD']);
    reject(s, { type: 'ROLL', playerId: 'ghost' }, 'NO_PLAYER');
    reject(s, { type: 'ROLL', playerId: 'p2' }, 'NOT_YOUR_TURN');
    reject(s, { type: 'BUY', playerId: 'p1' }, 'WRONG_PHASE');
    reject(s, { type: 'MORTGAGE', playerId: 'p1', tileIndex: 'x' }, 'BAD_PAYLOAD');
    reject(s, { type: 'MORTGAGE', playerId: 'p1', tileIndex: 1.5 }, 'BAD_PAYLOAD');
    reject(s, { type: 'JOIN', playerId: 'p9', name: 'Late', token: TOKEN_IDS[5] }, 'NOT_IN_LOBBY');
    reject(lobby({ players: 2 }), { type: 'ROLL', playerId: 'p1' }, 'GAME_NOT_ACTIVE');
  });

  test('garbage input never throws', () => {
    const s = newGame();
    for (const action of [null, undefined, 42, 'ROLL', [], {}, { type: null }]) {
      let res;
      assert.doesNotThrow(() => { res = applyAction(s, action); });
      assert.ok(res.error, `${JSON.stringify(action)} should fail`);
      assert.equal(res.state, s);
      assert.deepEqual(res.events, []);
    }
  });

  test('stub actions are NOT_IMPLEMENTED once the game is active', () => {
    const s = newGame();
    for (const type of ['START_AUCTION', 'BID', 'PROPOSE_TRADE', 'ACCEPT_TRADE', 'REJECT_TRADE']) {
      reject(s, { type, playerId: 'p1' }, 'NOT_IMPLEMENTED');
      reject(lobby({ players: 2 }), { type, playerId: 'p1' }, 'GAME_NOT_ACTIVE');
    }
  });
});

describe('successful actions', () => {
  test('never mutate their input', () => {
    let s = give(give(newGame(), 'p1', 1), 'p1', 3);
    const actions = [
      { type: 'BUILD', playerId: 'p1', tileIndex: 1 },
      { type: 'ROLL', playerId: 'p1' },
    ];
    for (const action of actions) {
      const before = structuredClone(s);
      const res = applyAction(s, action);
      assert.ok(!res.error);
      assert.deepEqual(s, before, 'input state was mutated');
      assert.notEqual(res.state, s);
      assert.notEqual(res.state.players, s.players, 'nested objects must not be shared');
      s = res.state;
    }
  });

  test('seq increments by exactly 1 per successful action and not on failures', () => {
    let s = lobby({ players: 0 });
    assert.equal(s.seq, 0);
    s = act(s, { type: 'JOIN', playerId: 'p1', name: 'A', token: 'car' }).state;
    assert.equal(s.seq, 1);
    s = act(s, { type: 'JOIN', playerId: 'p2', name: 'B', token: 'dog' }).state;
    s = act(s, { type: 'JOIN', playerId: 'p3', name: 'C', token: 'hat' }).state;
    s = act(s, { type: 'LEAVE', playerId: 'p3' }).state;
    assert.equal(s.seq, 4);
    reject(s, { type: 'START_GAME', playerId: 'p2' }, 'NOT_HOST');
    s = act(s, { type: 'START_GAME', playerId: 'p1' }).state;
    assert.equal(s.seq, 5);
    s = give(s, 'p1', 3);
    s = act(s, { type: 'MORTGAGE', playerId: 'p1', tileIndex: 3 }).state;
    s = roll(s, 'p1', 3, 3).state;                               // → 6 buying (a doubles roll)
    s = act(s, { type: 'BUY', playerId: 'p1' }).state;
    s = roll(s, 'p1', 1, 2).state;                               // → 9 buying
    s = act(s, { type: 'TIMEOUT', playerId: 'p1' }).state;       // declines
    s = act(s, { type: 'END_TURN', playerId: 'p1' }).state;
    assert.equal(s.seq, 11);
  });

  test('server-owned fields are copied through untouched', () => {
    const s = { ...newGame(), createdAt: 111, updatedAt: 222 };
    s.turn = { ...s.turn, deadlineAt: 333 };
    const { state } = roll(s, 'p1', 1, 2);
    assert.equal(state.createdAt, 111);
    assert.equal(state.updatedAt, 222);
    assert.equal(state.turn.deadlineAt, 333);
    assert.equal(state.id, 'g_test');
  });

  test('the log is capped at 100 lines', () => {
    const { state } = autoPlay(newGame({ players: 3, seed: 3 }), 400);
    assert.ok(Array.isArray(state.log));
    assert.ok(state.log.length <= 100);
    assert.ok(state.log.every((line) => typeof line === 'string'));
  });

  test('BUY pays the listed price from board data', () => {
    const s = roll(newGame(), 'p1', 4, 5).state; // → 9 Connecticut
    const bought = act(s, { type: 'BUY', playerId: 'p1' }).state;
    assert.equal(player(bought, 'p1').cash, 1500 - getTile(9).price);
  });
});
