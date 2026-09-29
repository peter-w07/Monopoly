// legalActions(state, playerId) must agree with applyAction (CONTRACT §5).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, legalActions } from '../engine/index.js';
import {
  newGame, lobby, act, roll, give, jail, giveJailCard, setCash, setPosition, setTurn, setPlayer,
} from './helpers.js';

// Non-management actions that need no payload; unlisted ones must fail.
const TURN_ACTIONS = [
  'ROLL', 'BUY', 'DECLINE', 'START_AUCTION', 'END_TURN', 'PAY_JAIL_FINE', 'USE_JAIL_CARD',
  'PAY_DEBT', 'DECLARE_BANKRUPTCY', 'START_GAME', 'PASS_AUCTION', 'ACCEPT_TRADE', 'REJECT_TRADE',
];
const MANAGEMENT = { build: 'BUILD', sellHouse: 'SELL_HOUSE', mortgage: 'MORTGAGE', unmortgage: 'UNMORTGAGE' };
const NEVER_LISTED = ['TIMEOUT'];
const NEEDS_PAYLOAD = ['JOIN', 'BID', 'PROPOSE_TRADE']; // covered by lobby / auction / trade tests
const ALL_TILES = [...Array(40).keys()];

/** Check every listed action succeeds and every unlisted turn/management action fails. */
function assertConsistent(state, playerId) {
  const legal = legalActions(state, playerId);
  assert.deepEqual(Object.keys(legal).sort(), ['actions', 'auction', 'build', 'mortgage', 'sellHouse', 'tradeTargets', 'unmortgage']);
  for (const type of NEVER_LISTED) assert.ok(!legal.actions.includes(type), `${type} must never be listed`);

  for (const type of legal.actions) {
    if (NEEDS_PAYLOAD.includes(type)) continue;
    const res = applyAction(state, { type, playerId });
    assert.ok(!res.error, `${playerId}: ${type} is listed but fails with ${JSON.stringify(res.error)}`);
  }
  for (const type of TURN_ACTIONS) {
    if (legal.actions.includes(type)) continue;
    const res = applyAction(state, { type, playerId });
    assert.ok(res.error, `${playerId}: ${type} is not listed but succeeds`);
  }
  for (const [key, type] of Object.entries(MANAGEMENT)) {
    for (const tileIndex of ALL_TILES) {
      const listed = legal[key].includes(tileIndex);
      const res = applyAction(state, { type, playerId, tileIndex });
      assert.equal(!res.error, listed,
        `${playerId}: ${type} ${tileIndex} listed=${listed} but error=${JSON.stringify(res.error)}`);
    }
  }
  return legal;
}

const sorted = (a) => [...a].sort((x, y) => x - y);

describe('legalActions', () => {
  test('spectators', () => {
    const empty = { actions: [], build: [], sellHouse: [], mortgage: [], unmortgage: [], auction: null, tradeTargets: [] };
    assert.deepEqual(legalActions(lobby({ players: 2 }), null), { ...empty, actions: ['JOIN'] });
    assert.deepEqual(legalActions(lobby({ players: 2, settings: { maxPlayers: 2 } }), null), empty);
    assert.deepEqual(legalActions(newGame(), null), empty);
  });

  test('lobby', () => {
    const one = lobby({ players: 1 });
    assert.ok(!assertConsistent(one, 'p1').actions.includes('START_GAME'));
    const two = lobby({ players: 2 });
    assert.ok(assertConsistent(two, 'p1').actions.includes('START_GAME'));
    assert.ok(!assertConsistent(two, 'p2').actions.includes('START_GAME'));
  });

  test('start of a turn', () => {
    const s = newGame({ players: 3 });
    assert.ok(assertConsistent(s, 'p1').actions.includes('ROLL'));
    for (const pid of ['p2', 'p3']) {
      const legal = assertConsistent(s, pid);
      assert.deepEqual(legal.actions.filter((a) => a !== 'LEAVE'), []);
      assert.deepEqual(legal.build, []);
      assert.deepEqual(legal.mortgage, []);
    }
  });

  test('management lists on a mixed portfolio', () => {
    let s = give(newGame(), 'p1', 1, { houses: 1 });
    s = give(s, 'p1', 3);
    s = give(s, 'p1', 6, { mortgaged: true });
    s = give(s, 'p1', 8);
    s = give(s, 'p1', 5);
    s = give(s, 'p2', 9);
    const legal = assertConsistent(s, 'p1');
    assert.deepEqual(sorted(legal.build), [3]);
    assert.deepEqual(sorted(legal.sellHouse), [1]);
    assert.deepEqual(sorted(legal.mortgage), [5, 8]);
    assert.deepEqual(sorted(legal.unmortgage), [6]);
    assertConsistent(s, 'p2'); // off-turn: nothing
    assert.deepEqual(legalActions(s, 'p2').mortgage, []);
  });

  test('end_turn with and without rollAgain', () => {
    const again = roll(give(give(newGame(), 'p1', 1), 'p1', 3), 'p1', 5, 5).state;
    const a = assertConsistent(again, 'p1');
    assert.ok(a.actions.includes('ROLL') && !a.actions.includes('END_TURN'));
    assert.deepEqual(sorted(a.build), [1, 3]);

    const done = roll(newGame(), 'p1', 4, 6).state;
    const d = assertConsistent(done, 'p1');
    assert.ok(d.actions.includes('END_TURN') && !d.actions.includes('ROLL'));
  });

  test('buying_or_auction, affordable and not', () => {
    const rich = roll(newGame(), 'p1', 1, 2).state;
    const r = assertConsistent(rich, 'p1');
    assert.ok(r.actions.includes('BUY') && r.actions.includes('DECLINE'));

    const poor = roll(setPosition(setCash(give(newGame(), 'p1', 5), 'p1', 100), 'p1', 35), 'p1', 1, 3).state;
    const p = assertConsistent(poor, 'p1');
    assert.ok(!p.actions.includes('BUY') && p.actions.includes('DECLINE'));
    assert.deepEqual(p.mortgage, [5]);
  });

  test('paying, affordable and not (hand-built)', () => {
    let s = give(give(newGame(), 'p1', 1, { houses: 2 }), 'p1', 3, { houses: 1 });
    s = give(s, 'p1', 5, { mortgaged: true });
    s = give(s, 'p1', 12);
    s = setTurn(setCash(s, 'p1', 10), { phase: 'paying', pendingDebt: { toPlayerId: 'p2', amount: 300, reason: 'rent' } });
    const short = assertConsistent(s, 'p1');
    assert.ok(short.actions.includes('DECLARE_BANKRUPTCY') && !short.actions.includes('PAY_DEBT'));
    assert.deepEqual(short.build, []);
    assert.deepEqual(short.unmortgage, []);
    assert.deepEqual(sorted(short.sellHouse), [1]);
    assert.deepEqual(sorted(short.mortgage), [12]);

    const flush = assertConsistent(setCash(s, 'p1', 300), 'p1');
    assert.ok(flush.actions.includes('PAY_DEBT'));
    assertConsistent(s, 'p2');
  });

  test('jail_decision with and without card / cash', () => {
    const full = giveJailCard(jail(newGame(), 'p1'), 'p1', 'community');
    const f = assertConsistent(full, 'p1');
    for (const a of ['ROLL', 'PAY_JAIL_FINE', 'USE_JAIL_CARD']) assert.ok(f.actions.includes(a), a);

    const broke = setCash(jail(newGame(), 'p1'), 'p1', 10);
    const b = assertConsistent(broke, 'p1');
    assert.ok(b.actions.includes('ROLL'));
    assert.ok(!b.actions.includes('PAY_JAIL_FINE') && !b.actions.includes('USE_JAIL_CARD'));
  });

  test('bankrupt players and finished games', () => {
    const s = setPlayer(newGame({ players: 3 }), 'p3', { bankrupt: true, cash: 0 });
    assert.deepEqual(legalActions(s, 'p3').actions, []);
    assertConsistent(s, 'p3');

    const over = act(newGame(), { type: 'LEAVE', playerId: 'p2' }).state;
    assert.equal(over.status, 'finished');
    for (const pid of ['p1', 'p2']) {
      const legal = assertConsistent(over, pid);
      assert.deepEqual(legal.actions, []);
    }
  });
});
