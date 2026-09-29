// Unit tests for server/timers.js on hand-built rooms (no server process). Date.now is replaced by
// a fake clock so deadlines can be checked exactly; every armed setTimeout is cleared afterwards.

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { newTimerState, reconcileTimer, onConnectionChange, clearTimer, AFK_MS } from '../server/timers.js';

const realNow = Date.now;
let clock;
const rooms = [];

beforeEach(() => {
  clock = 1_700_000_000_000;
  Date.now = () => clock;
});

afterEach(() => {
  for (const room of rooms.splice(0)) clearTimer(room);
  Date.now = realNow;
});

/** An active two-player game at the start of p1's turn, shaped like the engine's state. */
function fakeRoom({ turnTimeoutSec = 10 } = {}) {
  const state = {
    id: 'g_timers',
    status: 'active',
    settings: { turnTimeoutSec },
    players: [
      { id: 'p1', connected: true },
      { id: 'p2', connected: true },
    ],
    turn: {
      order: ['p1', 'p2'], currentIndex: 0, number: 1, phase: 'rolling',
      doublesCount: 0, rollAgain: false, lastRoll: null, deadlineAt: null,
    },
  };
  const room = { id: state.id, state, timer: newTimerState(), deleted: false };
  rooms.push(room);
  return room;
}

/** The turn after p1 rolls doubles and the landing resolves with nothing pending (CONTRACT §4.3). */
function rollDoubles(room, doublesCount) {
  room.state = {
    ...room.state,
    turn: { ...room.state.turn, phase: 'end_turn', rollAgain: true, doublesCount, lastRoll: [3, 3] },
  };
}

describe('turn timer', () => {
  test('every doubles roll re-arms the deadline, not just the first', () => {
    const room = fakeRoom({ turnTimeoutSec: 10 });
    reconcileTimer(room);
    assert.equal(room.state.turn.deadlineAt, clock + 10_000);

    clock += 2_000;
    rollDoubles(room, 1);
    reconcileTimer(room);
    assert.equal(room.state.turn.deadlineAt, clock + 10_000, 'first doubles: fresh deadline');

    clock += 7_500;
    rollDoubles(room, 2); // same phase and rollAgain as before; only doublesCount changed
    reconcileTimer(room);
    assert.equal(room.state.turn.deadlineAt, clock + 10_000, 'second doubles: fresh deadline too');

    clock += 1_000;
    reconcileTimer(room); // nothing changed: the deadline stays
    assert.equal(room.state.turn.deadlineAt, clock - 1_000 + 10_000);
  });

  test(`the current player disconnecting leaves them ${AFK_MS / 1000} s (not the whole 90 s turn)`, () => {
    assert.equal(AFK_MS, 45_000);
    const room = fakeRoom({ turnTimeoutSec: 90 });
    reconcileTimer(room);
    assert.equal(room.state.turn.deadlineAt, clock + 90_000);

    clock += 5_000;
    room.state.players[0].connected = false;
    onConnectionChange(room, 'p1', false);
    assert.equal(room.state.turn.deadlineAt, clock + 45_000);

    clock += 10_000; // back before the AFK deadline: the rest of the turn time is restored
    room.state.players[0].connected = true;
    onConnectionChange(room, 'p1', true);
    assert.equal(room.state.turn.deadlineAt, clock - 15_000 + 90_000);
  });

  test('a short turn timer is not extended by the AFK grace', () => {
    const room = fakeRoom({ turnTimeoutSec: 20 });
    reconcileTimer(room);
    room.state.players[0].connected = false;
    onConnectionChange(room, 'p1', false);
    assert.equal(room.state.turn.deadlineAt, clock + 20_000);
  });
});
