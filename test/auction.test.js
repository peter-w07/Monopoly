// Auctions (second slice): DECLINE / START_AUCTION open an ascending auction that every active
// player may bid in, off-turn included. Written from the auction/trading feature spec (§9 auctions,
// §11 legalActions, §12 events and error codes) as an independent check of the engine. Where the spec
// names no error code, the test expects the one CONTRACT §4.1 / §4.12 settled on.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { legalActions } from '../engine/index.js';
import {
  newGame, lobby, act, reject, roll, player, tile, current, give, setCash, setPlayer, edit,
  assertEvent, assertNoEvent, ofType,
} from './helpers.js';

const decline = (playerId = 'p1') => ({ type: 'DECLINE', playerId });
const startAuction = (playerId = 'p1') => ({ type: 'START_AUCTION', playerId });
const bid = (playerId, amount) => ({ type: 'BID', playerId, amount });
const pass = (playerId) => ({ type: 'PASS_AUCTION', playerId });
const leave = (playerId) => ({ type: 'LEAVE', playerId });
const timeout = (playerId = 'p1') => ({ type: 'TIMEOUT', playerId });

const BALTIC = 3; // p1 reaches it from GO with 1 + 2 (price 60)
const ORIENTAL = 6; // … and with 3 + 3 (doubles)

/** p1 has landed on an unowned tile and is offered it. `prep` edits the fresh game first. */
function offered({ players = 3, settings = {}, prep = (s) => s, dice = [1, 2] } = {}) {
  const s = roll(prep(newGame({ players, settings })), 'p1', ...dice).state;
  assert.equal(s.turn.phase, 'buying_or_auction');
  return s;
}

/** p1 declines the offered tile, which opens an auction for it. */
const auction = (opts) => act(offered(opts), decline()).state;

/** Applies actions in order (each must succeed and bump seq by exactly 1); returns the last state and all events. */
function run(state, ...actions) {
  let events = [];
  for (const action of actions) {
    const res = act(state, action);
    assert.equal(res.state.seq, state.seq + 1, `${action.type} by ${action.playerId} must increment seq by 1`);
    state = res.state;
    events = events.concat(res.events);
  }
  return { state, events };
}

const totalCash = (s) => s.players.reduce((sum, p) => sum + p.cash, 0);
const indexOf = (events, type) => events.findIndex((e) => e.type === type);
const sortedActions = (state, playerId) => [...legalActions(state, playerId).actions].sort();

/** The state as clients get it (CONTRACT §7): no rng, decks reduced to their sizes. */
function publicView(state) {
  const { rng, decks, ...rest } = state;
  return { ...rest, decks: { chance: { size: decks.chance.order.length }, community: { size: decks.community.order.length } } };
}

/** An auction with no bids and no passes yet. */
function assertFreshAuction(state, tileIndex, participants) {
  const a = state.auction;
  assert.ok(a, 'state.auction must be set');
  assert.equal(a.tileIndex, tileIndex);
  assert.equal(a.highBid, 0);
  assert.equal(a.highBidderId, null);
  assert.deepEqual(a.bids, []);
  assert.deepEqual(a.participants, participants);
  assert.deepEqual(a.passed, []);
}

// ---------------------------------------------------------------------------

describe('starting an auction', () => {
  test('DECLINE opens an auction for the offered tile; the current player stays current', () => {
    const s = offered();
    const { state, events } = run(s, decline());
    assert.equal(state.turn.phase, 'auction');
    assert.equal(state.turn.pendingPurchase, null);
    assert.equal(current(state), 'p1');
    assertFreshAuction(state, BALTIC, ['p1', 'p2', 'p3']);
    assertEvent(events, 'auction_started', { tileIndex: BALTIC, participants: ['p1', 'p2', 'p3'] });
    assert.equal(tile(state, BALTIC).ownerId, null);
    assert.equal(totalCash(state), totalCash(s), 'nobody pays anything yet');
  });

  test('participants are the non-bankrupt players in turn order, including the decliner', () => {
    const s = auction({ players: 4, prep: (g) => setPlayer(g, 'p3', { bankrupt: true, cash: 0 }) });
    assertFreshAuction(s, BALTIC, ['p1', 'p2', 'p4']);
  });

  test('START_AUCTION does exactly what DECLINE does', () => {
    const s = offered();
    const viaDecline = act(s, decline());
    const viaStart = act(s, startAuction());
    const strip = (x) => ({ ...x, log: null });
    assert.deepEqual(strip(viaStart.state), strip(viaDecline.state));
    assertEvent(viaStart.events, 'auction_started', { tileIndex: BALTIC, participants: ['p1', 'p2', 'p3'] });

    reject(s, startAuction('p2'), 'NOT_YOUR_TURN');
    reject(newGame({ players: 3 }), startAuction(), 'WRONG_PHASE');
    reject(viaStart.state, startAuction(), 'WRONG_PHASE');
    reject(lobby({ players: 2 }), startAuction(), 'GAME_NOT_ACTIVE');
  });

  test('auctionOnDecline off: DECLINE leaves the tile unowned and START_AUCTION is refused', () => {
    const s = offered({ settings: { auctionOnDecline: false } });
    reject(s, startAuction(), 'AUCTIONS_DISABLED');
    const { state, events } = run(s, decline());
    assert.equal(state.turn.phase, 'end_turn');
    assert.equal(state.auction, null);
    assert.equal(state.turn.pendingPurchase, null);
    assert.equal(tile(state, BALTIC).ownerId, null);
    assertNoEvent(events, 'auction_started');
    assert.equal(legalActions(state, 'p2').auction, null);
  });

  test('outside an auction BID and PASS_AUCTION are refused', () => {
    const s = offered();
    reject(s, bid('p1', 10), 'WRONG_PHASE');
    reject(s, pass('p1'), 'WRONG_PHASE');
    reject(newGame({ players: 3 }), bid('p1', 10), 'WRONG_PHASE');
    reject(newGame({ players: 3 }), bid('p2', 10), 'WRONG_PHASE'); // off-turn too: any participant may bid
    reject(lobby({ players: 2 }), bid('p1', 10), 'GAME_NOT_ACTIVE');
    reject(lobby({ players: 2 }), pass('p1'), 'GAME_NOT_ACTIVE');
  });
});

describe('bidding', () => {
  test('anyone may bid, off-turn included; each bid raises the high bid and is recorded', () => {
    const s = auction();
    const first = run(s, bid('p2', 10));
    assertEvent(first.events, 'auction_bid', { playerId: 'p2', amount: 10 });
    assert.equal(first.state.turn.phase, 'auction');
    assert.equal(current(first.state), 'p1', 'bidding never changes whose turn it is');

    const { state, events } = run(first.state, bid('p3', 25), bid('p1', 26), bid('p2', 40));
    assert.deepEqual(ofType(events, 'auction_bid').map((e) => [e.playerId, e.amount]), [['p3', 25], ['p1', 26], ['p2', 40]]);
    assert.equal(state.auction.highBid, 40);
    assert.equal(state.auction.highBidderId, 'p2');
    assert.deepEqual(state.auction.bids, [
      { playerId: 'p2', amount: 10 }, { playerId: 'p3', amount: 25 },
      { playerId: 'p1', amount: 26 }, { playerId: 'p2', amount: 40 },
    ]);
    assert.equal(totalCash(state), totalCash(s), 'bids are not paid until the auction ends');
  });

  test('BID validation', () => {
    const open = auction();
    reject(open, bid('p2', 0), 'BID_TOO_LOW'); // an integer, but below the minimum of 1
    reject(open, bid('p2', -5), 'BID_TOO_LOW');

    const s = setCash(run(open, bid('p2', 10)).state, 'p3', 40);
    reject(s, bid('p3', 10), 'BID_TOO_LOW');
    reject(s, bid('p3', 9), 'BID_TOO_LOW');
    reject(s, bid('p3', 41), 'INSUFFICIENT_FUNDS');
    reject(s, bid('p2', 20), 'ALREADY_HIGH_BIDDER');
    for (const amount of [10.5, '20', null, undefined, NaN, Infinity, [20], { amount: 20 }]) {
      reject(s, bid('p3', amount), 'BAD_PAYLOAD');
    }
    reject(s, { type: 'BID', playerId: 'p3' }, 'BAD_PAYLOAD');
    reject(s, bid('p9', 20), 'NO_PLAYER');

    const allIn = run(s, bid('p3', 40)).state; // exactly all your cash is allowed
    assert.equal(allIn.auction.highBidderId, 'p3');
    assert.equal(allIn.auction.highBid, 40);
  });

  test('a player who passed may not bid again (ALREADY_PASSED)', () => {
    const s = run(auction(), pass('p3')).state;
    reject(s, bid('p3', 10), 'ALREADY_PASSED');
    reject(s, pass('p3'), 'ALREADY_PASSED');
  });

  test('bankrupt players and non-participants may not bid or pass', () => {
    // p3 resigns mid-auction and is out.
    const gone = run(auction({ players: 4 }), bid('p2', 10), leave('p3')).state;
    assert.equal(player(gone, 'p3').bankrupt, true);
    reject(gone, bid('p3', 20), 'NO_PLAYER');
    reject(gone, pass('p3'), 'NO_PLAYER');

    // Hand-built: p3 is active but not in the auction's participant list.
    const outsider = edit(auction(), (s) => { s.auction.participants = ['p1', 'p2']; });
    reject(outsider, bid('p3', 10), 'NOT_PARTICIPANT');
    reject(outsider, pass('p3'), 'NOT_PARTICIPANT');
  });
});

describe('passing and closing', () => {
  test('PASS_AUCTION drops a participant out; the high bidder cannot pass', () => {
    const s = run(auction(), bid('p2', 10)).state;
    const { state, events } = run(s, pass('p3'));
    assertEvent(events, 'auction_passed', { playerId: 'p3' });
    assert.deepEqual(state.auction.passed, ['p3']);
    assert.equal(state.turn.phase, 'auction', 'p1 has not passed yet');
    reject(state, pass('p2'), 'ALREADY_HIGH_BIDDER');
  });

  test('the auction closes as soon as everyone but the high bidder has passed; the winner pays the bank', () => {
    const s = run(auction(), bid('p2', 10), bid('p3', 20), bid('p2', 45), pass('p1')).state;
    assert.equal(s.turn.phase, 'auction');
    const before = totalCash(s);
    const { state, events } = run(s, pass('p3'));
    assertEvent(events, 'auction_passed', { playerId: 'p3' });
    assertEvent(events, 'auction_won', { playerId: 'p2', tileIndex: BALTIC, amount: 45 });
    assert.ok(indexOf(events, 'auction_passed') < indexOf(events, 'auction_won'));
    assert.equal(state.auction, null);
    assert.equal(state.turn.phase, 'end_turn');
    assert.equal(current(state), 'p1');
    assert.equal(tile(state, BALTIC).ownerId, 'p2');
    assert.equal(tile(state, BALTIC).mortgaged, false);
    assert.equal(tile(state, BALTIC).houses, 0);
    assert.equal(player(state, 'p2').cash, 1500 - 45);
    assert.equal(player(state, 'p1').cash, 1500, 'the decliner gets nothing');
    assert.equal(player(state, 'p3').cash, 1500);
    assert.equal(totalCash(state), before - 45, 'the price leaves the game (paid to the bank)');
  });

  test('a bid closes the auction at once when everyone else has already passed', () => {
    const s = run(auction(), pass('p1'), pass('p2')).state;
    assert.equal(s.turn.phase, 'auction', 'p3 has neither bid nor passed');
    const { state, events } = run(s, bid('p3', 1));
    assertEvent(events, 'auction_won', { playerId: 'p3', tileIndex: BALTIC, amount: 1 });
    assert.equal(tile(state, BALTIC).ownerId, 'p3');
    assert.equal(player(state, 'p3').cash, 1499);
    assert.equal(state.turn.phase, 'end_turn');
  });

  test('the current player can win their own auction', () => {
    const { state, events } = run(auction({ players: 2 }), bid('p1', 30), pass('p2'));
    assertEvent(events, 'auction_won', { playerId: 'p1', tileIndex: BALTIC, amount: 30 });
    assert.equal(tile(state, BALTIC).ownerId, 'p1');
    assert.equal(player(state, 'p1').cash, 1470);
    assert.equal(state.turn.phase, 'end_turn');
  });

  test('everyone passes with no bids → unsold, the tile stays unowned', () => {
    const s = auction();
    const { state, events } = run(s, pass('p2'), pass('p1'), pass('p3'));
    assertEvent(events, 'auction_unsold', { tileIndex: BALTIC });
    assertNoEvent(events, 'auction_won');
    assert.equal(state.auction, null);
    assert.equal(state.turn.phase, 'end_turn');
    assert.equal(tile(state, BALTIC).ownerId, null);
    assert.equal(totalCash(state), totalCash(s));
  });

  test('the winner pays the bank, never the free-parking pot', () => {
    const s = edit(auction({ settings: { freeParkingPot: true } }), (x) => { x.pot = 75; });
    const { state } = run(s, bid('p3', 120), pass('p1'), pass('p2'));
    assert.equal(state.pot, 75);
    assert.equal(player(state, 'p3').cash, 1380);
    assert.equal(tile(state, BALTIC).ownerId, 'p3');
  });

  test('rollAgain survives the auction (won or unsold)', () => {
    const s = auction({ dice: [3, 3] });
    assert.equal(s.auction.tileIndex, ORIENTAL);
    assert.equal(s.turn.rollAgain, true);
    for (const actions of [[bid('p2', 50), pass('p1'), pass('p3')], [pass('p1'), pass('p2'), pass('p3')]]) {
      const { state } = run(s, ...actions);
      assert.equal(state.turn.phase, 'end_turn');
      assert.equal(state.turn.rollAgain, true);
      reject(state, { type: 'END_TURN', playerId: 'p1' }, 'MUST_ROLL_AGAIN');
      assert.ok(legalActions(state, 'p1').actions.includes('ROLL'));
    }
  });

  test('no turn, management or trade actions during an auction', () => {
    const s = auction({ prep: (g) => give(give(g, 'p1', 5), 'p2', 15) });
    for (const type of ['ROLL', 'BUY', 'DECLINE', 'END_TURN', 'PAY_DEBT', 'DECLARE_BANKRUPTCY', 'PAY_JAIL_FINE', 'USE_JAIL_CARD']) {
      reject(s, { type, playerId: 'p1' }, 'WRONG_PHASE');
    }
    for (const type of ['BUILD', 'SELL_HOUSE', 'MORTGAGE', 'UNMORTGAGE']) {
      reject(s, { type, playerId: 'p1', tileIndex: 5 }, 'WRONG_PHASE'); // the phase is checked before the tile
    }
    reject(s, { type: 'MORTGAGE', playerId: 'p2', tileIndex: 15 }, 'NOT_YOUR_TURN');
    const trade = { cash: 0, tiles: [5], jailCards: 0 };
    reject(s, { type: 'PROPOSE_TRADE', playerId: 'p1', toPlayerId: 'p2', give: trade, get: { cash: 10, tiles: [], jailCards: 0 } }, 'WRONG_PHASE');
    reject(s, { type: 'ACCEPT_TRADE', playerId: 'p2' }, 'NO_TRADE');
    reject(s, { type: 'REJECT_TRADE', playerId: 'p1' }, 'NO_TRADE');
  });
});

describe('TIMEOUT during an auction', () => {
  test('ends it now: the high bidder wins', () => {
    const s = run(auction(), bid('p2', 30)).state;
    reject(s, timeout('p2'), 'NOT_YOUR_TURN');
    const { state, events } = run(s, timeout());
    assert.equal(events[0].type, 'timeout');
    assertEvent(events, 'timeout', { playerId: 'p1', phase: 'auction' });
    assertEvent(events, 'auction_won', { playerId: 'p2', tileIndex: BALTIC, amount: 30 });
    assert.equal(state.auction, null);
    assert.equal(tile(state, BALTIC).ownerId, 'p2');
    assert.equal(player(state, 'p2').cash, 1470);
    assert.equal(state.turn.phase, 'end_turn');
    assert.equal(current(state), 'p1', 'the timeout only closes the auction; the turn is not ended');
    // The clock running out is how auctions end: the log doesn't blame the current player for it.
    assert.ok(!state.log.some((line) => /ran out of time/.test(line)), state.log.slice(-3).join(' | '));
    assert.match(state.log.at(-1), /won Baltic Avenue at auction for \$30/);
  });

  test('ends it now: no bids → unsold', () => {
    const s = run(auction(), pass('p3')).state;
    const { state, events } = run(s, timeout());
    assertEvent(events, 'auction_unsold', { tileIndex: BALTIC });
    assert.equal(tile(state, BALTIC).ownerId, null);
    assert.equal(state.auction, null);
    assert.equal(state.turn.phase, 'end_turn');
  });

  test('with rollAgain it closes the auction without rolling', () => {
    const s = auction({ dice: [3, 3] });
    const { state, events } = run(s, timeout());
    assertNoEvent(events, 'dice_rolled');
    assert.equal(player(state, 'p1').position, ORIENTAL);
    assert.equal(state.turn.phase, 'end_turn');
    assert.equal(state.turn.rollAgain, true);
  });
});

describe('resigning during an auction', () => {
  test('the high bidder resigns: the best remaining bid by an active player stands', () => {
    const s = run(auction({ players: 4 }), bid('p2', 10), bid('p3', 20), bid('p2', 30), bid('p4', 35), bid('p3', 40)).state;
    const { state } = run(s, leave('p3'));
    assert.equal(player(state, 'p3').bankrupt, true);
    assert.equal(state.turn.phase, 'auction');
    assert.equal(state.auction.highBid, 35);
    assert.equal(state.auction.highBidderId, 'p4');
    assert.equal(legalActions(state, 'p2').auction.minBid, 36);

    const end = run(state, pass('p1'), pass('p2'));
    assertEvent(end.events, 'auction_won', { playerId: 'p4', tileIndex: BALTIC, amount: 35 });
    assert.equal(tile(end.state, BALTIC).ownerId, 'p4');
    assert.equal(player(end.state, 'p4').cash, 1465);
  });

  test('the only bidder resigns: back to no bids, the auction goes on', () => {
    const s = run(auction(), bid('p3', 10)).state;
    const { state } = run(s, leave('p3'));
    assert.equal(state.turn.phase, 'auction');
    assert.equal(state.auction.highBid, 0);
    assert.equal(state.auction.highBidderId, null);
    assert.deepEqual(legalActions(state, 'p2').auction, { minBid: 1, maxBid: 1500 });

    const end = run(state, pass('p1'), pass('p2'));
    assertEvent(end.events, 'auction_unsold', { tileIndex: BALTIC });
    assert.equal(tile(end.state, BALTIC).ownerId, null);
  });

  test('a resignation counts as a pass and can close the auction', () => {
    // p3 was the high bidder: p2's earlier bid stands, and everyone else is out.
    const s = run(auction(), pass('p1'), bid('p2', 10), bid('p3', 20)).state;
    const { state, events } = run(s, leave('p3'));
    assertEvent(events, 'bankrupt', { playerId: 'p3' });
    assertEvent(events, 'auction_won', { playerId: 'p2', tileIndex: BALTIC, amount: 10 });
    assert.equal(state.auction, null);
    assert.equal(state.turn.phase, 'end_turn');
    assert.equal(current(state), 'p1');
    assert.equal(tile(state, BALTIC).ownerId, 'p2');
    assert.equal(player(state, 'p2').cash, 1490);

    // A player who never bid resigning is just a pass.
    const quiet = run(run(auction(), bid('p2', 10), pass('p1')).state, leave('p3'));
    assertEvent(quiet.events, 'auction_won', { playerId: 'p2', tileIndex: BALTIC, amount: 10 });
  });

  test('a bid by a player who has since passed never comes back: they dropped out and are never made to buy', () => {
    // p2 bid, was outbid by p3 and passed; p3 resigns. p2's $10 doesn't stand: no bids are left.
    const s = run(auction(), bid('p2', 10), bid('p3', 20), pass('p2')).state;
    const { state } = run(s, leave('p3'));
    assert.equal(state.turn.phase, 'auction', 'p1 is still in');
    assert.equal(state.auction.highBid, 0);
    assert.equal(state.auction.highBidderId, null);
    reject(state, bid('p2', 30), 'ALREADY_PASSED');
    assert.deepEqual(sortedActions(state, 'p2'), ['LEAVE']);
    assert.deepEqual(legalActions(state, 'p1').auction, { minBid: 1, maxBid: 1500 });
    const end = run(state, pass('p1'));
    assertEvent(end.events, 'auction_unsold', { tileIndex: BALTIC });
    assert.equal(player(end.state, 'p2').cash, 1500, 'the passed bidder pays nothing');

    // The latest bid by someone still in stands, even below a passed player's later bid.
    const four = run(auction({ players: 4 }), bid('p4', 10), bid('p2', 15), bid('p3', 20), pass('p2')).state;
    const after = run(four, leave('p3')).state;
    assert.equal(after.auction.highBid, 10);
    assert.equal(after.auction.highBidderId, 'p4');
    const raised = run(after, bid('p1', 11)).state; // below p2's old $15: that bid is out of the auction
    assert.equal(raised.auction.highBidderId, 'p1');
  });

  test('an off-turn resignation that ends the game cancels the auction just before the last turn_ended', () => {
    const s = run(auction({ players: 2 }), bid('p2', 10)).state;
    const { state, events } = run(s, leave('p2'));
    assert.deepEqual(events.slice(-3).map((e) => e.type), ['auction_unsold', 'turn_ended', 'game_over']);
    assertEvent(events, 'game_over', { winnerId: 'p1' });
    assertNoEvent(events, 'auction_won');
    assert.equal(state.auction, null);
    assert.equal(tile(state, BALTIC).ownerId, null);
  });

  test('the current player resigns: the auction is cancelled before the turn passes', () => {
    const s = run(auction(), bid('p2', 10)).state;
    const { state, events } = run(s, leave('p1'));
    assertEvent(events, 'auction_unsold', { tileIndex: BALTIC });
    assertNoEvent(events, 'auction_won');
    assert.ok(indexOf(events, 'auction_unsold') < indexOf(events, 'turn_ended'), 'cancelled before the turn passes');
    assertEvent(events, 'turn_started', { playerId: 'p2' });
    assert.equal(state.auction, null);
    assert.equal(tile(state, BALTIC).ownerId, null);
    assert.equal(player(state, 'p2').cash, 1500, 'the high bidder pays nothing');
    assert.equal(current(state), 'p2');
    assert.equal(state.turn.phase, 'rolling');
  });

  test('the current player resigns in a 2-player game: cancelled, game over', () => {
    const s = run(auction({ players: 2 }), bid('p2', 10)).state;
    const { state, events } = run(s, leave('p1'));
    assertEvent(events, 'auction_unsold', { tileIndex: BALTIC });
    assertEvent(events, 'game_over', { winnerId: 'p2' });
    assert.equal(state.status, 'finished');
    assert.equal(state.auction, null);
    assert.equal(tile(state, BALTIC).ownerId, null);
  });
});

describe('legalActions during an auction', () => {
  test('auction: { minBid, maxBid }, and BID / PASS_AUCTION, for whoever may use them', () => {
    const s = auction({ prep: (g) => give(g, 'p1', 5) });
    for (const pid of ['p1', 'p2', 'p3']) {
      const legal = legalActions(s, pid);
      assert.deepEqual(legal.auction, { minBid: 1, maxBid: 1500 });
      assert.deepEqual(legal.tradeTargets, []);
      assert.deepEqual(sortedActions(s, pid), ['BID', 'LEAVE', 'PASS_AUCTION'], `${pid}: only bid, pass or resign`);
    }
    const p1 = legalActions(s, 'p1');
    for (const key of ['build', 'sellHouse', 'mortgage', 'unmortgage']) assert.deepEqual(p1[key], [], `no ${key} during an auction`);
    assert.deepEqual(legalActions(publicView(s), 'p2'), legalActions(s, 'p2'), 'same answer on the public state');

    const bidding = setCash(run(s, bid('p2', 10)).state, 'p3', 5);
    const p2 = legalActions(bidding, 'p2');
    assert.equal(p2.auction, null, 'the high bidder may not bid');
    assert.ok(!p2.actions.includes('BID') && !p2.actions.includes('PASS_AUCTION'));

    const p3 = legalActions(bidding, 'p3');
    assert.equal(p3.auction, null, "p3 can't afford the minimum bid");
    assert.ok(!p3.actions.includes('BID') && p3.actions.includes('PASS_AUCTION'));

    assert.deepEqual(legalActions(bidding, 'p1').auction, { minBid: 11, maxBid: 1500 });
    act(bidding, bid('p1', 11));
    act(bidding, bid('p1', 1500));
    reject(bidding, bid('p1', 10), 'BID_TOO_LOW');
    reject(bidding, bid('p1', 1501), 'INSUFFICIENT_FUNDS');

    const passed = run(bidding, pass('p3')).state;
    assert.equal(legalActions(passed, 'p3').auction, null);
    assert.deepEqual(sortedActions(passed, 'p3'), ['LEAVE']);

    // Every listed payload-free action succeeds.
    for (const state of [s, bidding, passed]) {
      for (const pid of ['p1', 'p2', 'p3']) {
        for (const type of legalActions(state, pid).actions) {
          if (type === 'BID') continue;
          act(state, { type, playerId: pid });
        }
      }
    }
  });

  test('auction is null and BID / PASS_AUCTION unlisted outside an auction', () => {
    for (const s of [newGame({ players: 3 }), offered(), run(auction(), pass('p1'), pass('p2'), pass('p3')).state]) {
      for (const pid of ['p1', 'p2', 'p3']) {
        const legal = legalActions(s, pid);
        assert.equal(legal.auction, null);
        assert.ok(!legal.actions.includes('BID') && !legal.actions.includes('PASS_AUCTION'));
      }
    }
  });
});
