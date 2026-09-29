// Game creation, settings and the lobby (CONTRACT §2 state.js, §3, §4.2).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, normalizeSettings, DEFAULT_SETTINGS, OWNABLE_INDICES, legalActions,
} from '../engine/index.js';
import { lobby, act, reject, player, setPlayer, assertEvent, TOKEN_IDS } from './helpers.js';

const join = (playerId, name, token) => ({ type: 'JOIN', playerId, name, token });

describe('createGame', () => {
  test('returns a fresh lobby state with the documented shape', () => {
    const s = createGame({ id: 'g_abc234', seed: 777 });
    assert.equal(s.version, 1);
    assert.equal(s.id, 'g_abc234');
    assert.equal(s.status, 'lobby');
    assert.equal(s.seq, 0);
    assert.equal(s.hostId, null);
    assert.equal(s.winnerId, null);
    assert.equal(s.pot, 0);
    assert.deepEqual(s.settings, DEFAULT_SETTINGS);
    assert.equal(s.rng.seed, 777);
    assert.deepEqual(s.players, []);
    assert.equal(s.turn.phase, 'lobby');
    assert.deepEqual(s.turn.order, []);
    assert.equal(s.turn.number, 0);
    assert.equal(s.turn.rollAgain, false);
    assert.equal(s.turn.lastRoll, null);
    assert.equal(s.turn.pendingPurchase, null);
    assert.equal(s.turn.pendingDebt, null);
    assert.deepEqual(s.tiles.map((t) => t.index), OWNABLE_INDICES);
    assert.equal(s.tiles.length, 28);
    for (const t of s.tiles) assert.deepEqual(t, { index: t.index, ownerId: null, houses: 0, mortgaged: false });
    assert.deepEqual(s.bank, { houses: 32, hotels: 12 });
    for (const deck of ['chance', 'community']) {
      assert.equal(s.decks[deck].pos, 0);
      assert.deepEqual([...s.decks[deck].order].sort((a, b) => a - b), [...Array(16).keys()]);
    }
    assert.equal(s.auction, null);
    assert.equal(s.trade, null);
    assert.ok(Array.isArray(s.log));
  });

  test('is deterministic for a seed and shuffles decks from the RNG', () => {
    const a = createGame({ id: 'g_x', seed: 1 });
    const b = createGame({ id: 'g_x', seed: 1 });
    const c = createGame({ id: 'g_x', seed: 2 });
    assert.deepEqual(a, b);
    assert.ok(a.rng.counter > 0, 'deck shuffles consume the RNG');
    assert.notDeepEqual(a.decks, c.decks);
  });

  test('normalises the settings it is given', () => {
    const s = createGame({ id: 'g_x', seed: 1, settings: { maxPlayers: 20, freeParkingPot: true } });
    assert.equal(s.settings.maxPlayers, 8);
    assert.equal(s.settings.freeParkingPot, true);
    assert.equal(s.settings.startingCash, 1500);
  });
});

describe('normalizeSettings', () => {
  test('merges with defaults', () => {
    assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS);
    assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
    assert.deepEqual(DEFAULT_SETTINGS, {
      maxPlayers: 6, startingCash: 1500, turnTimeoutSec: 90,
      freeParkingPot: false, auctionOnDecline: true, evenBuild: true,
    });
  });

  test('clamps numbers and coerces booleans', () => {
    assert.equal(normalizeSettings({ maxPlayers: 1 }).maxPlayers, 2);
    assert.equal(normalizeSettings({ maxPlayers: 99 }).maxPlayers, 8);
    assert.equal(normalizeSettings({ maxPlayers: 4 }).maxPlayers, 4);
    assert.equal(normalizeSettings({ startingCash: 5 }).startingCash, 100);
    assert.equal(normalizeSettings({ startingCash: 1e9 }).startingCash, 100000);
    assert.equal(normalizeSettings({ turnTimeoutSec: 0 }).turnTimeoutSec, 0);
    assert.equal(normalizeSettings({ turnTimeoutSec: 60 }).turnTimeoutSec, 60);
    assert.equal(normalizeSettings({ turnTimeoutSec: 99999 }).turnTimeoutSec, 3600);
    assert.equal(normalizeSettings({ freeParkingPot: 1 }).freeParkingPot, true);
    assert.equal(normalizeSettings({ evenBuild: 0 }).evenBuild, false);
  });
});

describe('JOIN', () => {
  test('adds a player with starting values; first joiner is host', () => {
    const s0 = createGame({ id: 'g_x', seed: 1, settings: { startingCash: 2000 } });
    const { state, events } = act(s0, join('p_a', '  Peter  ', 'car'));
    assert.deepEqual(player(state, 'p_a'), {
      id: 'p_a', name: 'Peter', token: 'car', cash: 2000, position: 0,
      inJail: false, jailTurns: 0, getOutOfJailCards: 0, jailCards: [],
      bankrupt: false, connected: true,
    });
    assert.equal(state.hostId, 'p_a');
    assertEvent(events, 'player_joined', { playerId: 'p_a', name: 'Peter', token: 'car' });

    const second = act(state, join('p_b', 'Ann', 'dog')).state;
    assert.equal(second.hostId, 'p_a');
    assert.deepEqual(second.players.map((p) => p.id), ['p_a', 'p_b']);
  });

  test('validates the name', () => {
    const s = lobby({ players: 0 });
    reject(s, join('p1', '', 'car'), 'BAD_NAME');
    reject(s, join('p1', '    ', 'car'), 'BAD_NAME');
    reject(s, join('p1', 'x'.repeat(21), 'car'), 'BAD_NAME');
    act(s, join('p1', 'x'.repeat(20), 'car'));
    act(s, join('p1', ` ${'y'.repeat(20)} `, 'car')); // trimmed to 20
    reject(s, join('p1', 42, 'car'), ['BAD_NAME', 'BAD_PAYLOAD']);
  });

  test('validates the token', () => {
    const s = lobby({ players: 1 }); // p1 has TOKEN_IDS[0]
    reject(s, join('p2', 'Bob', 'unicorn'), 'BAD_TOKEN');
    reject(s, join('p2', 'Bob', TOKEN_IDS[0]), 'TOKEN_TAKEN');
    act(s, join('p2', 'Bob', TOKEN_IDS[1]));
  });

  test('rejects a duplicate player id', () => {
    const s = lobby({ players: 1 });
    reject(s, join('p1', 'Again', TOKEN_IDS[3]), 'ALREADY_JOINED');
  });

  test('rejects joining a full game', () => {
    const s = lobby({ players: 2, settings: { maxPlayers: 2 } });
    reject(s, join('p3', 'Late', TOKEN_IDS[2]), 'GAME_FULL');
    assert.deepEqual(legalActions(s, null).actions, []);
  });

  test('rejects joining once the game has started', () => {
    const s = act(lobby({ players: 2 }), { type: 'START_GAME', playerId: 'p1' }).state;
    reject(s, join('p3', 'Late', TOKEN_IDS[2]), 'NOT_IN_LOBBY');
  });

  test('spectators may JOIN while there is room', () => {
    assert.deepEqual(legalActions(lobby({ players: 1 }), null), {
      actions: ['JOIN'], build: [], sellHouse: [], mortgage: [], unmortgage: [],
    });
  });
});

describe('START_GAME', () => {
  test('only the host may start', () => {
    const s = lobby({ players: 3 });
    reject(s, { type: 'START_GAME', playerId: 'p2' }, 'NOT_HOST');
    reject(s, { type: 'START_GAME', playerId: 'nobody' }, 'NO_PLAYER');
  });

  test('needs at least two players', () => {
    reject(lobby({ players: 1 }), { type: 'START_GAME', playerId: 'p1' }, 'NOT_ENOUGH_PLAYERS');
  });

  describe('while the host is offline', () => {
    const start = (playerId) => ({ type: 'START_GAME', playerId });
    const canStart = (state, playerId) => legalActions(state, playerId).actions.includes('START_GAME');
    const hostOffline = () => setPlayer(lobby({ players: 3 }), 'p1', { connected: false });

    test('the first connected player in join order may start instead', () => {
      const s = hostOffline();
      assert.ok(canStart(s, 'p2'));
      assert.ok(!canStart(s, 'p3'));
      reject(s, start('p3'), 'NOT_HOST');
      const { state } = act(s, start('p2'));
      assert.equal(state.status, 'active');
      assert.deepEqual(state.turn.order, ['p1', 'p2', 'p3'], 'turn order is still join order');
      assert.equal(state.hostId, 'p1');
    });

    test('offline players are skipped when picking the stand-in', () => {
      const s = setPlayer(hostOffline(), 'p2', { connected: false });
      assert.deepEqual(['p1', 'p2', 'p3'].filter((id) => canStart(s, id)), ['p1', 'p3']);
      reject(s, start('p2'), 'NOT_HOST');
      act(s, start('p3'));
    });

    test('with the host connected only the host may start', () => {
      const s = setPlayer(lobby({ players: 3 }), 'p2', { connected: false });
      assert.deepEqual(['p1', 'p2', 'p3'].filter((id) => canStart(s, id)), ['p1']);
      reject(s, start('p3'), 'NOT_HOST');
    });
  });

  test('activates the game with join order as turn order', () => {
    const { state, events } = act(lobby({ players: 3 }), { type: 'START_GAME', playerId: 'p1' });
    assert.equal(state.status, 'active');
    assert.deepEqual(state.turn.order, ['p1', 'p2', 'p3']);
    assert.equal(state.turn.currentIndex, 0);
    assert.equal(state.turn.number, 1);
    assert.equal(state.turn.phase, 'rolling');
    assertEvent(events, 'game_started', { order: ['p1', 'p2', 'p3'] });
    assertEvent(events, 'turn_started', { playerId: 'p1', turnNumber: 1 });
    reject(state, { type: 'START_GAME', playerId: 'p1' }, 'NOT_IN_LOBBY');
  });
});

describe('LEAVE in the lobby', () => {
  test('removes the player and frees their token', () => {
    const s = lobby({ players: 3 });
    const { state, events } = act(s, { type: 'LEAVE', playerId: 'p2' });
    assert.deepEqual(state.players.map((p) => p.id), ['p1', 'p3']);
    assert.equal(state.hostId, 'p1');
    assertEvent(events, 'player_left', { playerId: 'p2' });
    act(state, join('p4', 'New', TOKEN_IDS[1]));
  });

  test('reassigns the host to players[0]; empty lobby has no host', () => {
    let s = lobby({ players: 3 });
    s = act(s, { type: 'LEAVE', playerId: 'p1' }).state;
    assert.equal(s.hostId, 'p2');
    reject(s, { type: 'START_GAME', playerId: 'p3' }, 'NOT_HOST');
    s = act(s, { type: 'LEAVE', playerId: 'p2' }).state;
    assert.equal(s.hostId, 'p3');
    s = act(s, { type: 'LEAVE', playerId: 'p3' }).state;
    assert.equal(s.hostId, null);
    assert.deepEqual(s.players, []);
  });

  test('unknown players cannot leave', () => {
    reject(lobby({ players: 2 }), { type: 'LEAVE', playerId: 'ghost' }, 'NO_PLAYER');
  });

  test('LEAVE { lobbyOnly: true } leaves the lobby but never resigns from a started game', () => {
    const leave = { type: 'LEAVE', playerId: 'p2', lobbyOnly: true };
    const { state, events } = act(lobby({ players: 3 }), leave);
    assert.deepEqual(state.players.map((p) => p.id), ['p1', 'p3']);
    assertEvent(events, 'player_left', { playerId: 'p2' });

    const started = act(lobby({ players: 3 }), { type: 'START_GAME', playerId: 'p1' }).state;
    reject(started, leave, 'NOT_IN_LOBBY'); // also checks the state is untouched
    reject(started, { ...leave, lobbyOnly: 'yes' }, 'BAD_PAYLOAD');
    for (const plain of [{ type: 'LEAVE', playerId: 'p2' }, { ...leave, lobbyOnly: false }]) {
      const resigned = act(started, plain);
      assert.equal(player(resigned.state, 'p2').bankrupt, true);
      assertEvent(resigned.events, 'bankrupt', { playerId: 'p2', toPlayerId: null });
    }
  });
});
