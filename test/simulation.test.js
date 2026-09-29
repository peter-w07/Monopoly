// Whole-game simulation: bots (test/bot.js) play many seeded games while the engine's invariants
// are checked after every single action. Fully deterministic: the same seeds play the same games.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD, applyAction, createGame, currentPlayerId, getTile, groupIndices, legalActions,
  makeRng, nextFloat, nextInt, tradeFees, tradeableTiles, validateAction,
} from '../engine/index.js';
import { chooseAction } from './bot.js';

const GAMES = 150;
const MAX_ACTIONS = 1500;
// Share of games that must reach game_over within MAX_ACTIONS. Before auctions and trading, colour
// groups rarely completed in 4–6 player games and about half of all games stalled (79/150; 4–6
// players 31/92). With bots that bid and trade for the missing tile of a group, all 150 finish.
const MIN_FINISHED_SHARE = 0.85;
const MIN_FINISHED_SHARE_2P = 0.9;
const MIN_FINISHED_SHARE_4_6P = 0.8;
const REPLAY_GAMES = 5;           // games whose recorded actions are replayed to check determinism
const TIMEOUT_RATE = 0.03;        // share of steps where the server's TIMEOUT acts instead of the bot
const EXPLORE_RATE = 0.05;        // share of steps where a random listed action replaces the bot's choice
const RESIGN_RATE = 1 / 3000;     // chance per step that an off-turn player resigns (LEAVE)
const PAYING_RESIGN_RATE = 0.02;  // the same while a debt is pending (the debtor may resign too), to exercise
                                  // debts owed to or by a player who resigns
const DEAL_RESIGN_RATE = 0.01;    // the same during an auction or a pending trade (anyone may resign)
const LEGAL_CHECK_EVERY = 50;     // every n-th step, cross-check the whole legalActions list of every player
const DEAL_CHECK_EVERY = 2;       // the same during auctions and trades, where every player may act

const PLAY_PHASES = ['rolling', 'jail_decision', 'buying_or_auction', 'paying', 'end_turn', 'auction', 'trading'];
const ROLL_AGAIN_PHASES = ['end_turn', 'buying_or_auction', 'paying', 'auction', 'trading'];
const TRADE_PHASES = ['rolling', 'jail_decision', 'end_turn', 'paying']; // a trade's returnPhase
const DEAL_PHASES = ['auction', 'trading'];
// Listed-or-fails actions that need no payload (BID and PROPOSE_TRADE are checked with payloads).
const TURN_ACTIONS = [
  'ROLL', 'BUY', 'DECLINE', 'START_AUCTION', 'END_TURN', 'PAY_JAIL_FINE', 'USE_JAIL_CARD', 'PAY_DEBT',
  'DECLARE_BANKRUPTCY', 'PASS_AUCTION', 'ACCEPT_TRADE', 'REJECT_TRADE',
];
const MANAGEMENT = { build: 'BUILD', sellHouse: 'SELL_HOUSE', mortgage: 'MORTGAGE', unmortgage: 'UNMORTGAGE' };
const OWNABLE = BOARD.tiles.filter((t) => ['property', 'railroad', 'utility'].includes(t.type)).map((t) => t.index);
const GROUPS = Object.keys(BOARD.groups).map((g) => groupIndices(g)).filter((g) => g.length > 0);
const DECK_SIZE = 16;
const POT_REASONS = ['tax', 'card', 'jail_fine']; // bank payments that feed the free-parking pot (CONTRACT §4.6)

// ---------------------------------------------------------------------------
// Playing a game

function mustApply(state, action, where) {
  const res = applyAction(state, action);
  if (res.error) assert.fail(`${where}: ${JSON.stringify(action)} failed: ${JSON.stringify(res.error)}`);
  return res;
}

/** A started game with 2–6 players and randomised settings. `rng` is the scenario/bot RNG. */
function startGame(seed, rng) {
  const players = nextInt(rng, 2, 6);
  const settings = {
    startingCash: [1500, 1500, 1000, 600][nextInt(rng, 0, 3)],
    freeParkingPot: nextFloat(rng) < 0.3,
    evenBuild: nextFloat(rng) < 0.8,
    auctionOnDecline: nextFloat(rng) < 0.85,
  };
  let state = createGame({ id: `g_sim${seed}`, seed, settings });
  for (let i = 0; i < players; i++) {
    const join = { type: 'JOIN', playerId: `p${i + 1}`, name: `Bot ${i + 1}`, token: BOARD.tokens[i].id };
    state = mustApply(state, join, `seed ${seed} setup`).state;
  }
  return mustApply(state, { type: 'START_GAME', playerId: 'p1' }, `seed ${seed} setup`).state;
}

/**
 * The next action: usually a bot's — the current player's, or during an auction or a trade any
 * player with something to do; sometimes a TIMEOUT, a random listed action (reaching moves a
 * sensible bot never makes, e.g. building while poor, withdrawing a trade) or a resignation (by an
 * off-turn player; while a debt is pending also by the debtor, during an auction or trade by anyone).
 */
function nextAction(state, rng, step, where) {
  const pid = currentPlayerId(state);
  const { phase } = state.turn;
  const dealing = DEAL_PHASES.includes(phase);
  const paying = phase === 'paying';
  if (nextFloat(rng) < (paying ? PAYING_RESIGN_RATE : dealing ? DEAL_RESIGN_RATE : RESIGN_RATE)) {
    const others = state.players.filter((p) => !p.bankrupt && (paying || dealing || p.id !== pid));
    const quitter = others[nextInt(rng, 0, others.length - 1)];
    assert.ok(legalActions(state, quitter.id).actions.includes('LEAVE'), `${where}: LEAVE not listed for ${quitter.id}`);
    return { type: 'LEAVE', playerId: quitter.id };
  }
  if (nextFloat(rng) < TIMEOUT_RATE) return { type: 'TIMEOUT', playerId: pid };

  // Everyone who can do more than resign: normally just the current player; in an auction every
  // bidder, in a trade both parties.
  const candidates = [];
  for (const p of state.players) {
    if (p.bankrupt) continue;
    const legal = legalActions(state, p.id);
    if (step % (dealing ? DEAL_CHECK_EVERY : LEGAL_CHECK_EVERY) === 0) checkLegalList(state, p.id, legal, where);
    const moves = legal.actions.some((type) => type !== 'LEAVE') || Object.keys(MANAGEMENT).some((key) => legal[key].length > 0);
    if (moves) candidates.push({ playerId: p.id, legal });
  }
  if (candidates.length === 0) assert.fail(`${where}: nobody can act in ${phase}`);
  if (!dealing) assert.deepEqual(candidates.map((c) => c.playerId), [pid], `${where}: only the current player acts in ${phase}`);

  // Starting from a random candidate, the first whose bot wants to act does (a trade's proposer waits).
  const first = nextInt(rng, 0, candidates.length - 1);
  for (let k = 0; k < candidates.length; k++) {
    const { playerId, legal } = candidates[(first + k) % candidates.length];
    const explore = nextFloat(rng) < EXPLORE_RATE;
    const action = explore ? randomListed(state, legal, playerId, rng) : chooseAction(state, legal, playerId, rng);
    if (!action) continue;
    if (!isListed(action, legal)) assert.fail(`${where}: the bot chose an unlisted action ${JSON.stringify(action)}`);
    return action;
  }
  return assert.fail(`${where}: no bot wants to act in ${phase}`);
}

/** Is the action one that `legal` lists (with a BID amount in range, a PROPOSE_TRADE to a listed target)? */
function isListed(action, legal) {
  const key = Object.keys(MANAGEMENT).find((k) => MANAGEMENT[k] === action.type);
  if (key) return legal[key].includes(action.tileIndex);
  if (!legal.actions.includes(action.type)) return false;
  if (action.type === 'BID') return action.amount >= legal.auction.minBid && action.amount <= legal.auction.maxBid;
  if (action.type === 'PROPOSE_TRADE') return legal.tradeTargets.includes(action.toPlayerId);
  return true;
}

/** Any listed action except LEAVE, uniformly at random (a random bid; a random valid offer, if one turns up). */
function randomListed(state, legal, playerId, rng) {
  const options = [];
  for (const type of legal.actions) {
    if (type === 'LEAVE') continue;
    if (type === 'BID') {
      const { minBid, maxBid } = legal.auction;
      options.push({ type, playerId, amount: nextInt(rng, minBid, Math.min(maxBid, minBid + 200)) });
    } else if (type === 'PROPOSE_TRADE') {
      const offer = randomOffer(state, legal, playerId, rng);
      if (offer) options.push({ type, playerId, ...offer });
    } else {
      options.push({ type, playerId });
    }
  }
  for (const [key, type] of Object.entries(MANAGEMENT)) {
    for (const tileIndex of legal[key]) options.push({ type, playerId, tileIndex });
  }
  return options.length > 0 ? options[nextInt(rng, 0, options.length - 1)] : null;
}

/** A random offer to a random listed target (tiles, cash and jail cards on either side), or null if invalid. */
function randomOffer(state, legal, playerId, rng) {
  const toPlayerId = legal.tradeTargets[nextInt(rng, 0, legal.tradeTargets.length - 1)];
  const side = (owner) => {
    const p = state.players.find((x) => x.id === owner);
    const tiles = tradeableTiles(state, owner).filter(() => nextFloat(rng) < 0.25);
    const cash = nextFloat(rng) < 0.5 ? nextInt(rng, 0, Math.min(p.cash, 300)) : 0;
    const jailCards = nextFloat(rng) < 0.5 ? p.getOutOfJailCards : 0;
    return { cash, tiles, jailCards };
  };
  const offer = { toPlayerId, give: side(playerId), get: side(toPlayerId) };
  return validateAction(state, { type: 'PROPOSE_TRADE', playerId, ...offer }) ? null : offer;
}

/**
 * Plays one seeded game to game over or MAX_ACTIONS, checking every step.
 * With `record`, also returns the action and event lists for a replay.
 */
function playGame(seed, { record = false } = {}) {
  const rng = makeRng(seed * 7919 + 17); // the scenario/bot RNG, separate from the game's state.rng
  const start = startGame(seed, rng);
  let state = start;
  let snapshot = jsonSnapshot(state, `seed ${seed} start`);
  const actions = [];
  const events = [];
  const turn = { open: true, auction: false }; // START_GAME opened the first turn
  const stats = { auctions: 0, auctionsWon: 0, trades: 0, tradesAccepted: 0 };
  let steps = 0;
  for (; steps < MAX_ACTIONS && state.status === 'active'; steps++) {
    const where = `seed ${seed} step ${steps}`;
    const action = nextAction(state, rng, steps, where);
    const res = mustApply(state, action, where);
    if (!sameJson(state, snapshot)) assert.fail(`${where}: ${JSON.stringify(action)} mutated its input state`);
    if (res.state === state || res.state.seq !== state.seq + 1) assert.fail(`${where}: expected a new state with seq + 1`);
    snapshot = jsonSnapshot(res.state, where);
    checkInvariants(res.state, where, action, state, res.events);
    checkEvents(state, res.state, res.events, turn, where, action);
    checkDeals(state, res.state, res.events, where, action);
    for (const e of res.events) {
      if (e.type === 'auction_started') stats.auctions += 1;
      if (e.type === 'auction_won') stats.auctionsWon += 1;
      if (e.type === 'trade_proposed') stats.trades += 1;
      if (e.type === 'trade_accepted') stats.tradesAccepted += 1;
    }
    if (record) {
      actions.push(action);
      events.push(res.events);
    }
    state = res.state;
  }
  if (state.status === 'finished') {
    assert.ok(!turn.open, `seed ${seed}: the last turn never got a turn_ended`);
    assert.ok(!turn.auction, `seed ${seed}: an auction never got auction_won / auction_unsold`);
  }
  // jsonSnapshot checks JSON-safety at every step; do one real round trip per game as well.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(state)), state, `seed ${seed}: JSON round trip lost data`);
  return { start, state, steps, actions, events, stats };
}

// ---------------------------------------------------------------------------
// Checks

/**
 * Deep copy of a state that also asserts it survives JSON.stringify → JSON.parse unchanged:
 * only plain objects, dense arrays, strings, booleans, null and finite numbers (no undefined,
 * NaN, ±Infinity, -0, Dates, ...). The copy is compared with sameJson after the next action to
 * prove that action left its input alone. (Deep-freezing the states would catch writes too, but
 * frozen arrays make the engine ~5× slower in V8; this is also cheaper than JSON.stringify twice.)
 */
function jsonSnapshot(state, where) {
  try {
    return jsonCopy(state);
  } catch {
    assert.fail(`${where}: ${jsonProblem(state, 'state') ?? 'state is not plain JSON'}`);
  }
}

function jsonCopy(value) {
  if (typeof value === 'object') {
    if (value === null) return null;
    if (Array.isArray(value)) {
      const copy = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) throw new Error('sparse array');
        copy[i] = jsonCopy(value[i]);
      }
      return copy;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error('not a plain object');
    const copy = {};
    for (const key of Object.keys(value)) copy[key] = jsonCopy(value[key]);
    return copy;
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
  throw new Error('not a JSON value');
}

/** Slow path for the error message: where is the first non-JSON value? */
function jsonProblem(value, path) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? null : `${path} is ${value}`;
  if (typeof value !== 'object') return `${path} is ${String(value)}`;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const bad = i in value ? jsonProblem(value[i], `${path}[${i}]`) : `${path}[${i}] is a hole`;
      if (bad) return bad;
    }
    return null;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return `${path} is not a plain object`;
  for (const key of Object.keys(value)) {
    const bad = jsonProblem(value[key], `${path}.${key}`);
    if (bad) return bad;
  }
  return null;
}

/** Deep equality for plain JSON data. */
function sameJson(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameJson(a[i], b[i])) return false;
    return true;
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) if (!Object.hasOwn(b, key) || !sameJson(a[key], b[key])) return false;
  return true;
}

function failer(where, action) {
  return (ok, message) => {
    if (!ok) assert.fail(`${where} after ${JSON.stringify(action)}: ${typeof message === 'function' ? message() : message}`);
  };
}

/** `prev` is the state the action was applied to, `events` what it emitted. */
function checkInvariants(s, where, action, prev, events) {
  const expect = failer(where, action);
  const t = s.turn;
  const alive = s.players.filter((p) => !p.bankrupt);
  const tileAt = new Map(s.tiles.map((tile) => [tile.index, tile]));

  // Status and phase
  expect(t.phase !== 'resolving', 'phase "resolving" leaked out of applyAction');
  if (s.status === 'finished') {
    expect(t.phase === 'game_over', 'a finished game must be in game_over');
    expect(alive.length === 1, 'a finished game has exactly one survivor');
    expect(s.winnerId === alive[0]?.id, 'winnerId must be the survivor');
  } else {
    expect(s.status === 'active', () => `status ${s.status}`);
    expect(PLAY_PHASES.includes(t.phase), () => `unexpected phase ${t.phase}`);
    expect(alive.length >= 2, 'an active game needs two players');
    const current = s.players.find((p) => p.id === currentPlayerId(s));
    expect(current && !current.bankrupt, 'the current player must be active');
    const underlying = s.trade ? s.trade.returnPhase : t.phase; // the phase a pending trade interrupted
    expect(underlying !== 'jail_decision' || current.inJail, 'jail_decision for a player who is not in jail');
  }
  expect((t.pendingPurchase !== null) === (t.phase === 'buying_or_auction'), 'pendingPurchase ⇔ buying_or_auction');
  const debtPhase = t.phase === 'paying' || (t.phase === 'trading' && s.trade?.returnPhase === 'paying');
  expect((t.pendingDebt !== null) === debtPhase, 'pendingDebt ⇔ paying (or trading from paying)');
  expect(!t.rollAgain || ROLL_AGAIN_PHASES.includes(t.phase), () => `rollAgain in ${t.phase}`);
  expect((s.auction !== null) === (t.phase === 'auction'), () => `auction ${JSON.stringify(s.auction)} in phase ${t.phase}`);
  expect((s.trade !== null) === (t.phase === 'trading'), () => `trade ${JSON.stringify(s.trade)} in phase ${t.phase}`);
  if (s.auction) checkAuction(s, expect);
  if (s.trade) checkTrade(s, expect);

  // Players
  const held = { chance: 0, community: 0 };
  for (const p of s.players) {
    expect(Number.isInteger(p.cash) && p.cash >= 0, () => `${p.id} has cash ${p.cash}`);
    expect(Number.isInteger(p.position) && p.position >= 0 && p.position < 40, () => `${p.id} at ${p.position}`);
    expect(p.jailCards.length === p.getOutOfJailCards, () => `${p.id} jailCards ${p.jailCards} vs ${p.getOutOfJailCards}`);
    for (const deck of p.jailCards) held[deck] += 1;
    if (p.inJail) {
      expect(p.position === BOARD.jailIndex, () => `${p.id} is jailed off the jail tile`);
      expect(p.jailTurns <= BOARD.maxJailTurns, () => `${p.id} jailTurns ${p.jailTurns}`);
    }
    if (p.bankrupt) {
      expect(p.cash === 0 && !p.inJail && p.getOutOfJailCards === 0, () => `bankrupt ${p.id} kept cash, jail or cards`);
      expect(!s.tiles.some((tile) => tile.ownerId === p.id), () => `bankrupt ${p.id} still owns tiles`);
    }
  }
  expect(held.chance <= 1 && held.community <= 1, () => `a GOOJF card is held twice: ${JSON.stringify(held)}`);

  // Tiles and the bank's building supply
  let houses = 0;
  let hotels = 0;
  for (const tile of s.tiles) {
    expect(Number.isInteger(tile.houses) && tile.houses >= 0 && tile.houses <= 5, () => `tile ${tile.index} houses ${tile.houses}`);
    if (tile.houses === 5) hotels += 1;
    else houses += tile.houses;
    if (tile.ownerId === null) {
      expect(!tile.mortgaged && tile.houses === 0, () => `unowned tile ${tile.index} is mortgaged or built on`);
    } else {
      expect(s.players.some((p) => p.id === tile.ownerId), () => `tile ${tile.index} owned by unknown ${tile.ownerId}`);
    }
    if (tile.houses > 0) {
      const info = getTile(tile.index);
      expect(info.type === 'property', () => `buildings on non-property ${tile.index}`);
      for (const i of groupIndices(info.group)) {
        const other = tileAt.get(i);
        expect(other.ownerId === tile.ownerId && !other.mortgaged, () => `buildings on ${tile.index} but ${i} is not a clean part of the monopoly`);
      }
    }
  }
  expect(s.bank.houses >= 0 && s.bank.hotels >= 0, () => `negative bank ${JSON.stringify(s.bank)}`);
  expect(s.bank.houses + houses === BOARD.bankHouses, () => `houses not conserved: bank ${s.bank.houses} + board ${houses}`);
  expect(s.bank.hotels + hotels === BOARD.bankHotels, () => `hotels not conserved: bank ${s.bank.hotels} + board ${hotels}`);
  if (s.settings.evenBuild) {
    // An even group only turns uneven when a hotel is sold while the bank is short of houses: it
    // breaks into fewer than 4 houses (a sale of more than one level). The even-build/sell rules
    // then steer the group back to even.
    const spread = (state, group) => {
      const levels = group.map((i) => state.tiles.find((tile) => tile.index === i).houses);
      return Math.max(...levels) - Math.min(...levels);
    };
    for (const group of GROUPS) {
      if (spread(s, group) <= 1 || spread(prev, group) > 1) continue;
      const shortageSale = events.some((e) => e.type === 'sold_house' && group.includes(e.tileIndex)
        && e.amount > Math.floor(getTile(e.tileIndex).houseCost / 2));
      expect(shortageSale, () => `group ${group} became uneven: ${group.map((i) => tileAt.get(i).houses)}`);
    }
  }

  // Decks, pot, log
  for (const deck of ['chance', 'community']) {
    const d = s.decks[deck];
    const ids = new Set(d.order);
    expect(d.order.length === DECK_SIZE && ids.size === DECK_SIZE && d.order.every((id) => id >= 0 && id < DECK_SIZE),
      () => `${deck} order ${d.order} is not a permutation`);
    expect(Number.isInteger(d.pos) && d.pos >= 0 && d.pos < DECK_SIZE, () => `${deck} pos ${d.pos}`);
  }
  expect(Number.isInteger(s.pot) && s.pot >= 0, () => `pot ${s.pot}`);
  expect(s.settings.freeParkingPot || s.pot === 0, 'pot used while freeParkingPot is off');
  expect(s.log.length <= 100, () => `log has ${s.log.length} lines`);
}

/** A running auction: sane bookkeeping, an affordable high bid, and someone besides the high bidder still in. */
function checkAuction(s, expect) {
  const a = s.auction;
  const byId = (id) => s.players.find((p) => p.id === id);
  const tile = s.tiles.find((x) => x.index === a.tileIndex);
  expect(s.settings.auctionOnDecline, 'an auction although auctionOnDecline is off');
  expect(tile && tile.ownerId === null, () => `auctioning tile ${a.tileIndex}, which is not an unowned ownable tile`);
  expect(a.participants.every((id) => byId(id)) && new Set(a.participants).size === a.participants.length,
    () => `participants ${a.participants}`);
  expect(a.participants.includes(currentPlayerId(s)), 'the current player takes part in their auction');
  expect(a.passed.every((id) => a.participants.includes(id)) && new Set(a.passed).size === a.passed.length,
    () => `passed ${a.passed} vs participants ${a.participants}`);
  expect(a.participants.every((id) => !byId(id).bankrupt || a.passed.includes(id)), 'a bankrupt participant has not passed');
  expect(Number.isInteger(a.highBid) && a.highBid >= 0 && (a.highBid === 0) === (a.highBidderId === null),
    () => `highBid ${a.highBid} / highBidderId ${a.highBidderId}`);
  for (const bid of a.bids) {
    expect(a.participants.includes(bid.playerId) && Number.isInteger(bid.amount) && bid.amount >= 1, () => `bid ${JSON.stringify(bid)}`);
  }
  // Bids by players still in the auction only ever rise (a resigned high bidder's bid drops out, and
  // so do the bids of players who passed, so a later bid may repeat or undercut their amounts).
  const standing = a.bids.filter((b) => !byId(b.playerId).bankrupt && !a.passed.includes(b.playerId));
  expect(standing.every((b, i) => i === 0 || b.amount > standing[i - 1].amount), () => `bids do not rise: ${JSON.stringify(a.bids)}`);
  if (a.highBidderId !== null) {
    const bidder = byId(a.highBidderId);
    expect(!bidder.bankrupt, 'the high bidder is bankrupt');
    expect(a.highBid <= bidder.cash, () => `high bid ${a.highBid} > ${bidder.id}'s cash ${bidder.cash}`);
    expect(a.bids.some((b) => b.playerId === a.highBidderId && b.amount === a.highBid), 'the high bid is not in the bid history');
  }
  const best = standing.at(-1);
  expect(a.highBid === (best?.amount ?? 0), () => `high bid ${a.highBid}, best standing bid ${best?.amount}`);
  const stillIn = a.participants.filter((id) => id !== a.highBidderId && !a.passed.includes(id));
  expect(stillIn.length > 0, 'the auction should have closed: nobody but the high bidder is still in');
}

/** A pending trade: proposed by the current player to another active player, from a proposing phase, well-formed. */
function checkTrade(s, expect) {
  const t = s.trade;
  const byId = (id) => s.players.find((p) => p.id === id);
  expect(t.fromPlayerId === currentPlayerId(s), 'the pending trade was not proposed by the current player');
  expect(t.toPlayerId !== t.fromPlayerId && byId(t.toPlayerId) && !byId(t.toPlayerId).bankrupt, () => `bad trade target ${t.toPlayerId}`);
  expect(TRADE_PHASES.includes(t.returnPhase), () => `returnPhase ${t.returnPhase}`);
  expect(/^t_\d+$/.test(t.id), () => `trade id ${t.id}`);
  for (const side of [t.give, t.get]) {
    expect(Object.keys(side).sort().join() === 'cash,jailCards,tiles', () => `trade side ${JSON.stringify(side)}`);
    expect(Number.isInteger(side.cash) && side.cash >= 0 && Number.isInteger(side.jailCards) && side.jailCards >= 0,
      () => `trade side ${JSON.stringify(side)}`);
  }
}

/**
 * Auction and trade actions: no bids by bankrupt or passed players; an accepted trade moves exactly
 * the offered tiles, cash and jail cards between the two parties and only its fees leave the game;
 * proposing, rejecting and cancelling move nothing at all.
 */
function checkDeals(prev, s, events, where, action) {
  const expect = failer(where, action);
  for (const e of events) {
    if (e.type !== 'auction_bid') continue;
    const bidder = prev.players.find((p) => p.id === e.playerId);
    expect(prev.auction && !bidder.bankrupt && !prev.auction.passed.includes(bidder.id), () => `bid by ${e.playerId}, who is out`);
  }
  const accepted = events.find((e) => e.type === 'trade_accepted');
  const dealOnly = events.every((e) => ['trade_proposed', 'trade_rejected', 'trade_cancelled', 'timeout'].includes(e.type));
  if (!accepted && !(dealOnly && events.some((e) => e.type.startsWith('trade_')))) return;

  const cashOf = (state, id) => state.players.find((p) => p.id === id).cash;
  const cardsOf = (state, id) => state.players.find((p) => p.id === id).jailCards.join();
  const moved = new Map(); // tile index → new owner
  let fees = 0;
  if (accepted) {
    const trade = prev.trade;
    expect(trade && accepted.tradeId === trade.id, 'trade_accepted for a trade that was not pending');
    const expected = tradeFees(prev, trade.fromPlayerId, trade);
    expect(sameJson(accepted.fees, expected), () => `fees ${JSON.stringify(accepted.fees)}, expected ${JSON.stringify(expected)}`);
    fees = Object.values(expected).reduce((sum, n) => sum + n, 0);
    for (const i of trade.give.tiles) moved.set(i, trade.toPlayerId);
    for (const i of trade.get.tiles) moved.set(i, trade.fromPlayerId);
    const net = trade.give.cash - trade.get.cash;
    expect(cashOf(s, trade.fromPlayerId) === cashOf(prev, trade.fromPlayerId) - net - expected[trade.fromPlayerId], 'proposer cash');
    expect(cashOf(s, trade.toPlayerId) === cashOf(prev, trade.toPlayerId) + net - expected[trade.toPlayerId], 'target cash');
    const cards = (state) => state.players.reduce((sum, p) => sum + p.jailCards.length, 0);
    expect(cards(s) === cards(prev), 'jail cards were created or lost');
    const from = s.players.find((p) => p.id === trade.fromPlayerId);
    const to = s.players.find((p) => p.id === trade.toPlayerId);
    const before = (id) => prev.players.find((p) => p.id === id).jailCards.length;
    expect(from.jailCards.length === before(from.id) - trade.give.jailCards + trade.get.jailCards, 'proposer jail cards');
    expect(to.jailCards.length === before(to.id) - trade.get.jailCards + trade.give.jailCards, 'target jail cards');
  } else {
    for (const p of s.players) expect(cardsOf(s, p.id) === cardsOf(prev, p.id), () => `${p.id}'s jail cards changed`);
  }
  const total = (state) => state.players.reduce((sum, p) => sum + p.cash, 0);
  expect(total(prev) - total(s) === fees, () => `cash total changed by ${total(prev) - total(s)}, fees ${fees}`);
  for (const tile of s.tiles) {
    const old = prev.tiles.find((x) => x.index === tile.index);
    const owner = moved.has(tile.index) ? moved.get(tile.index) : old.ownerId;
    expect(tile.ownerId === owner && tile.houses === old.houses && tile.mortgaged === old.mortgaged,
      () => `tile ${tile.index}: ${JSON.stringify(old)} → ${JSON.stringify(tile)}`);
  }
}

/**
 * Events are enough for an event-driven renderer: replaying one action's money events on the old
 * cash and pot gives exactly the new cash and pot, and turn_started / turn_ended alternate
 * (`turn.open` carries that across actions).
 */
function checkEvents(prev, next, events, turn, where, action) {
  const expect = failer(where, action);
  const cash = new Map(prev.players.map((p) => [p.id, p.cash]));
  const add = (playerId, amount) => cash.set(playerId, cash.get(playerId) + amount);
  let pot = prev.pot;
  const toBank = (reason, amount) => {
    if (prev.settings.freeParkingPot && POT_REASONS.includes(reason)) pot += amount;
  };
  for (const e of events) {
    switch (e.type) {
      case 'passed_go': add(e.playerId, e.amount); break;
      case 'bought': add(e.playerId, -e.price); break;
      case 'paid_rent': add(e.playerId, -e.amount); add(e.ownerId, e.amount); break;
      case 'paid_tax': add(e.playerId, -e.amount); toBank('tax', e.amount); break;
      case 'paid':
        add(e.playerId, -e.amount);
        if (e.toPlayerId) add(e.toPlayerId, e.amount);
        else toBank(e.reason, e.amount);
        break;
      case 'collected':
        add(e.playerId, e.amount);
        if (e.fromPlayerId) add(e.fromPlayerId, -e.amount);
        else if (e.reason === 'free_parking') pot -= e.amount;
        break;
      case 'built': add(e.playerId, -getTile(e.tileIndex).houseCost); break;
      case 'sold_house':
      case 'mortgaged': add(e.playerId, e.amount); break;
      case 'unmortgaged': add(e.playerId, -e.amount); break;
      case 'debt_paid':
        add(e.playerId, -e.amount);
        if (e.payees) for (const payee of e.payees) add(payee.playerId, payee.amount);
        else if (e.toPlayerId) add(e.toPlayerId, e.amount);
        else toBank(e.reason, e.amount);
        break;
      case 'bankrupt':
        expect(cash.get(e.playerId) === e.cash, () => `bankrupt.cash ${e.cash}, events give ${cash.get(e.playerId)}`);
        cash.set(e.playerId, 0);
        if (e.toPlayerId) add(e.toPlayerId, e.cash);
        break;
      case 'auction_started':
        expect(!turn.auction, 'auction_started while an auction is open');
        turn.auction = true;
        break;
      case 'auction_won':
        add(e.playerId, -e.amount); // to the bank, never the pot
        // falls through
      case 'auction_unsold':
        expect(turn.auction, `${e.type} without an open auction`);
        turn.auction = false;
        break;
      case 'trade_accepted':
        add(e.fromPlayerId, e.get.cash - e.give.cash - e.fees[e.fromPlayerId]);
        add(e.toPlayerId, e.give.cash - e.get.cash - e.fees[e.toPlayerId]);
        break;
      case 'turn_started':
        expect(!turn.open, 'turn_started while a turn is open');
        turn.open = true;
        break;
      case 'turn_ended':
        expect(turn.open, 'turn_ended without an open turn');
        turn.open = false;
        break;
      default:
        break;
    }
  }
  for (const p of next.players) {
    expect(cash.get(p.id) === p.cash, () => `${p.id} cash ${p.cash}, events give ${cash.get(p.id)}: ${JSON.stringify(events)}`);
  }
  expect(pot === next.pot, () => `pot ${next.pot}, events give ${pot}: ${JSON.stringify(events)}`);
}

/**
 * Every listed action succeeds and every unlisted one fails (CONTRACT §5): payload-free actions as
 * they are, BID at minBid and at maxBid, PROPOSE_TRADE with a simple valid offer to each listed
 * target, management actions on every ownable tile.
 */
function checkLegalList(state, playerId, legal, where) {
  const fails = (action) => applyAction(state, action).error;
  const must = (ok, message) => {
    if (!ok) assert.fail(`${where}: ${playerId}: ${typeof message === 'function' ? message() : message}`);
  };
  for (const type of legal.actions) {
    if (type === 'BID' || type === 'PROPOSE_TRADE') continue;
    const error = fails({ type, playerId });
    must(!error, () => `listed ${type} fails with ${JSON.stringify(error)}`);
  }
  for (const type of TURN_ACTIONS) {
    if (!legal.actions.includes(type)) must(fails({ type, playerId }), `unlisted ${type} succeeds`);
  }

  // BID: the whole range [minBid, maxBid] works (checked at both ends), nothing works when unlisted.
  const me = state.players.find((p) => p.id === playerId);
  const lowest = (state.auction?.highBid ?? 0) + 1;
  if (legal.actions.includes('BID')) {
    must(sameJson(legal.auction, { minBid: lowest, maxBid: me.cash }), () => `auction ${JSON.stringify(legal.auction)}`);
    for (const amount of [lowest, me.cash]) {
      const error = fails({ type: 'BID', playerId, amount });
      must(!error, () => `listed BID ${amount} fails with ${JSON.stringify(error)}`);
    }
  } else {
    must(legal.auction === null, 'auction set but BID unlisted');
    for (const amount of [lowest, me.cash]) must(fails({ type: 'BID', playerId, amount }), `unlisted BID ${amount} succeeds`);
  }

  // PROPOSE_TRADE: a simple valid offer to every listed target works; unlisted, none does.
  const others = state.players.filter((p) => !p.bankrupt && p.id !== playerId).map((p) => p.id);
  const simpleOffer = (toPlayerId) => {
    const target = state.players.find((p) => p.id === toPlayerId);
    // In debt a gift is UNFAIR_TRADE (§4.13), so the debtor asks for something instead.
    const inDebt = state.turn.phase === 'paying';
    if (me.cash > 0 && !inDebt) return { toPlayerId, give: { cash: 1 }, get: {} };
    if (target.cash > 0) return { toPlayerId, give: {}, get: { cash: 1 } };
    if (inDebt) {
      const theirs = tradeableTiles(state, toPlayerId).filter((i) => !state.tiles.find((x) => x.index === i).mortgaged);
      return theirs.length > 0 ? { toPlayerId, give: {}, get: { tiles: [theirs[0]] } } : null;
    }
    const tiles = tradeableTiles(state, playerId);
    return tiles.length > 0 ? { toPlayerId, give: { tiles: [tiles[0]] }, get: {} } : null;
  };
  if (legal.actions.includes('PROPOSE_TRADE')) {
    must(sameJson(legal.tradeTargets, others), () => `tradeTargets ${legal.tradeTargets}, active others ${others}`);
    for (const toPlayerId of legal.tradeTargets) {
      const offer = simpleOffer(toPlayerId);
      const error = offer && fails({ type: 'PROPOSE_TRADE', playerId, ...offer });
      must(!error, () => `listed PROPOSE_TRADE ${JSON.stringify(offer)} fails with ${JSON.stringify(error)}`);
    }
  } else {
    must(legal.tradeTargets.length === 0, 'tradeTargets set but PROPOSE_TRADE unlisted');
    for (const toPlayerId of others) {
      const offer = simpleOffer(toPlayerId);
      if (offer) must(fails({ type: 'PROPOSE_TRADE', playerId, ...offer }), `unlisted PROPOSE_TRADE ${JSON.stringify(offer)} succeeds`);
    }
  }

  for (const [key, type] of Object.entries(MANAGEMENT)) {
    for (const tileIndex of OWNABLE) {
      const ok = !fails({ type, playerId, tileIndex });
      must(ok === legal[key].includes(tileIndex), `${type} ${tileIndex} listed/succeeds disagree`);
    }
  }
}

// ---------------------------------------------------------------------------

describe('simulation', () => {
  test(`${GAMES} seeded bot games keep every invariant`, (t) => {
    let finished = 0;
    let actions = 0;
    const byPlayers = {};
    const totals = { auctions: 0, auctionsWon: 0, trades: 0, tradesAccepted: 0 };
    for (let seed = 1; seed <= GAMES; seed++) {
      const game = playGame(seed);
      actions += game.steps;
      for (const key of Object.keys(totals)) totals[key] += game.stats[key];
      const n = game.start.players.length;
      byPlayers[n] ??= { games: 0, finished: 0 };
      byPlayers[n].games += 1;
      if (game.state.status === 'finished') {
        finished += 1;
        byPlayers[n].finished += 1;
      }
    }
    t.diagnostic(`${GAMES} games, ${finished} reached game over, ${actions} actions`);
    t.diagnostic(`finished by player count: ${Object.entries(byPlayers).map(([n, c]) => `${n}p ${c.finished}/${c.games}`).join(', ')}`);
    t.diagnostic(`auctions ${totals.auctions} (${totals.auctionsWon} sold), trades proposed ${totals.trades} (${totals.tradesAccepted} accepted)`);
    assert.ok(totals.auctionsWon > 0 && totals.tradesAccepted > 0, 'the bots should win auctions and make trades');
    assert.ok(finished >= GAMES * MIN_FINISHED_SHARE, `only ${finished}/${GAMES} games finished`);
    const two = byPlayers[2];
    assert.ok(two.finished >= two.games * MIN_FINISHED_SHARE_2P, `only ${two.finished}/${two.games} 2-player games finished`);
    const big = [4, 5, 6].map((n) => byPlayers[n] ?? { games: 0, finished: 0 })
      .reduce((sum, c) => ({ games: sum.games + c.games, finished: sum.finished + c.finished }));
    assert.ok(big.finished >= big.games * MIN_FINISHED_SHARE_4_6P, `only ${big.finished}/${big.games} 4–6 player games finished`);
  });

  test('replaying a game from its (JSON-restored) start state is identical', () => {
    for (let seed = 1; seed <= REPLAY_GAMES; seed++) {
      const game = playGame(seed, { record: true });
      assert.ok(game.actions.length > 50, `seed ${seed}: the game should run for a while`);
      let state = JSON.parse(JSON.stringify(game.start));
      const events = [];
      for (const action of game.actions) {
        const res = mustApply(state, action, `replay seed ${seed}`);
        events.push(res.events);
        state = res.state;
      }
      assert.deepStrictEqual(state, game.state, `seed ${seed}: replayed state differs`);
      assert.deepStrictEqual(events, game.events, `seed ${seed}: replayed events differ`);
    }
  });
});
