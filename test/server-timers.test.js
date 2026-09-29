// Unit tests for server/timers.js on hand-built rooms (no server process). Date.now is replaced by
// a fake clock so deadlines can be checked exactly; every armed setTimeout is cleared afterwards.

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { newTimerState, reconcileTimer, onConnectionChange, clearTimer, AFK_MS, AUCTION_MS, AUCTION_MAX_MS } from '../server/timers.js';

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

/** p1 declined a purchase: the auction for tile 3 is on (CONTRACT §4.12). */
function startAuction(room) {
  room.state = {
    ...room.state,
    turn: { ...room.state.turn, phase: 'auction' },
    auction: { tileIndex: 3, highBid: 0, highBidderId: null, bids: [], participants: ['p1', 'p2'], passed: [] },
  };
}

function bid(room, playerId, amount) {
  const { auction } = room.state;
  room.state = {
    ...room.state,
    auction: { ...auction, highBid: amount, highBidderId: playerId, bids: [...auction.bids, { playerId, amount }] },
  };
}

function pass(room, playerId) {
  room.state = { ...room.state, auction: { ...room.state.auction, passed: [...room.state.auction.passed, playerId] } };
}

/** The auction is over (won or unsold): back to p1's end_turn. */
function endAuction(room) {
  room.state = { ...room.state, turn: { ...room.state.turn, phase: 'end_turn' }, auction: null };
}

/** p1 proposes a trade to p2 from the current phase (CONTRACT §4.13); `answer` puts the phase back. */
function proposeTrade(room) {
  const returnPhase = room.state.turn.phase;
  room.state = {
    ...room.state,
    turn: { ...room.state.turn, phase: 'trading' },
    trade: { id: `t_${room.state.turn.number}`, fromPlayerId: 'p1', toPlayerId: 'p2', give: {}, get: {}, returnPhase },
  };
}

function answerTrade(room) {
  room.state = { ...room.state, turn: { ...room.state.turn, phase: room.state.trade.returnPhase }, trade: null };
}

function setConnected(room, playerId, connected) {
  room.state.players.find((p) => p.id === playerId).connected = connected;
  onConnectionChange(room, playerId, connected);
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

describe('auction clock', () => {
  test(`an auction runs on a ${AUCTION_MS / 1000} s clock even with the turn timer off; bids restart it, passes don't`, () => {
    assert.equal(AUCTION_MS, 10_000);
    const room = fakeRoom({ turnTimeoutSec: 0 });
    reconcileTimer(room);
    assert.equal(room.state.turn.deadlineAt, null, 'no turn timer');

    startAuction(room);
    reconcileTimer(room);
    assert.equal(room.state.turn.deadlineAt, clock + 10_000);
    assert.ok(room.timer.handle, 'the expiry is scheduled');

    clock += 4_000;
    pass(room, 'p2');
    reconcileTimer(room);
    assert.equal(room.state.turn.deadlineAt, clock - 4_000 + 10_000, 'a pass keeps the clock');

    clock += 3_000;
    bid(room, 'p1', 10);
    reconcileTimer(room);
    assert.equal(room.state.turn.deadlineAt, clock + 10_000, 'a bid restarts it');

    clock += 9_000;
    bid(room, 'p2', 20);
    reconcileTimer(room);
    assert.equal(room.state.turn.deadlineAt, clock + 10_000, 'every bid does');

    endAuction(room);
    reconcileTimer(room);
    assert.equal(room.state.turn.deadlineAt, null, 'turn timer off again once the auction is over');
    assert.equal(room.timer.handle, null);
  });

  test('the auction clock ignores who is connected, but pauses while nobody is', () => {
    const room = fakeRoom({ turnTimeoutSec: 90 });
    reconcileTimer(room);
    clock += 1_000;
    startAuction(room);
    reconcileTimer(room);
    const deadline = clock + 10_000;
    assert.equal(room.state.turn.deadlineAt, deadline, 'the auction clock, not what is left of the turn');

    clock += 2_000;
    setConnected(room, 'p1', false); // the current player (the decliner) drops out
    assert.equal(room.state.turn.deadlineAt, deadline);
    setConnected(room, 'p1', true); // and comes back: no turn time "restored" into the auction
    assert.equal(room.state.turn.deadlineAt, deadline);

    setConnected(room, 'p1', false);
    setConnected(room, 'p2', false);
    assert.equal(room.state.turn.deadlineAt, null, 'nobody connected: paused');
    assert.equal(room.timer.handle, null);

    clock += 60_000;
    setConnected(room, 'p2', true); // anyone coming back gets a fresh auction clock
    assert.equal(room.state.turn.deadlineAt, clock + 10_000);

    clock += 3_000;
    endAuction(room);
    reconcileTimer(room);
    assert.equal(room.state.turn.deadlineAt, clock + AFK_MS, "back to the turn clock (the current player is still away)");
  });

  test(`however many bids come in, an auction closes ${AUCTION_MAX_MS / 1000} s after it started`, () => {
    assert.equal(AUCTION_MAX_MS, 120_000);
    const room = fakeRoom({ turnTimeoutSec: 0 });
    startAuction(room);
    reconcileTimer(room);
    const cap = clock + AUCTION_MAX_MS;
    for (let amount = 1; clock + AUCTION_MS <= cap; amount++) { // two players raising by $1 every 5 s
      clock += 5_000;
      bid(room, amount % 2 ? 'p1' : 'p2', amount);
      reconcileTimer(room);
      assert.equal(room.state.turn.deadlineAt, Math.min(clock + AUCTION_MS, cap));
    }
    clock += 5_000;
    bid(room, 'p1', 1_000);
    reconcileTimer(room);
    assert.equal(room.state.turn.deadlineAt, cap, 'a late bid no longer buys another 10 s');

    endAuction(room);
    reconcileTimer(room);
    startAuction(room); // the next auction gets a limit of its own
    reconcileTimer(room);
    assert.equal(room.state.turn.deadlineAt, clock + AUCTION_MS);
    assert.equal(room.timer.auctionEndsBy, clock + AUCTION_MAX_MS);
  });

  test('an auction resumed after everyone was away gets a fresh clock and a fresh limit', () => {
    const room = fakeRoom({ turnTimeoutSec: 0 });
    startAuction(room);
    reconcileTimer(room);
    clock += 100_000;
    bid(room, 'p2', 10);
    reconcileTimer(room);
    setConnected(room, 'p1', false);
    setConnected(room, 'p2', false);
    assert.equal(room.state.turn.deadlineAt, null);
    clock += 60_000;
    setConnected(room, 'p1', true);
    assert.equal(room.state.turn.deadlineAt, clock + AUCTION_MS);
    assert.equal(room.timer.auctionEndsBy, clock + AUCTION_MAX_MS);
  });

  test('a turn timed out into an auction: the auction still gets its own clock', () => {
    const room = fakeRoom({ turnTimeoutSec: 30 });
    reconcileTimer(room);
    clock += 30_000; // TIMEOUT in buying_or_auction declines, which opens the auction
    startAuction(room);
    reconcileTimer(room, { force: true });
    assert.equal(room.state.turn.deadlineAt, clock + 10_000);
  });
});

describe('trading and the turn clock', () => {
  test('proposing, rejecting and accepting trades never restart the turn deadline', () => {
    const room = fakeRoom({ turnTimeoutSec: 90 });
    reconcileTimer(room);
    const deadline = clock + 90_000;

    clock += 20_000;
    proposeTrade(room);
    reconcileTimer(room);
    assert.equal(room.state.turn.deadlineAt, deadline, 'proposing keeps the deadline');
    assert.equal(room.state.turn.phase, 'trading');

    clock += 5_000;
    answerTrade(room); // rejected (or accepted): back to rolling
    reconcileTimer(room);
    assert.equal(room.state.turn.deadlineAt, deadline, 'answering keeps it too');

    for (let i = 0; i < 5; i++) { // proposing again and again can't stall the turn
      clock += 1_000;
      proposeTrade(room);
      reconcileTimer(room);
      answerTrade(room);
      reconcileTimer(room);
    }
    assert.equal(room.state.turn.deadlineAt, deadline);

    clock += 1_000;
    proposeTrade(room);
    reconcileTimer(room);
    room.state = { ...room.state, turn: { ...room.state.turn, phase: 'end_turn' }, trade: null }; // TIMEOUT: cancel + roll
    reconcileTimer(room, { force: true });
    assert.equal(room.state.turn.deadlineAt, clock + 90_000, 'a real phase change still earns a fresh deadline');
  });

  test('the proposer going offline mid-trade gets the usual AFK grace', () => {
    const room = fakeRoom({ turnTimeoutSec: 90 });
    reconcileTimer(room);
    clock += 10_000;
    proposeTrade(room);
    reconcileTimer(room);
    setConnected(room, 'p1', false);
    assert.equal(room.state.turn.deadlineAt, clock + AFK_MS);
  });
});
