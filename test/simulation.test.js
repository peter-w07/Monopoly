// Whole-game simulation: bots (test/bot.js) play many seeded games while the engine's invariants
// are checked after every single action. Fully deterministic: the same seeds play the same games.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD, applyAction, createGame, currentPlayerId, getTile, groupIndices, legalActions,
  makeRng, nextFloat, nextInt,
} from '../engine/index.js';
import { chooseAction } from './bot.js';

const GAMES = 150;
const MAX_ACTIONS = 1500;
// Share of games that must reach game_over within MAX_ACTIONS. Without trading or auctions (both
// stubs) colour groups rarely complete in 4–6 player games, so many of those stall; about half of
// all games and nearly every 2-player game finish today.
const MIN_FINISHED_SHARE = 0.4;
const MIN_FINISHED_SHARE_2P = 0.8;
const REPLAY_GAMES = 5;           // games whose recorded actions are replayed to check determinism
const TIMEOUT_RATE = 0.03;        // share of steps where the server's TIMEOUT acts instead of the bot
const EXPLORE_RATE = 0.05;        // share of steps where a random listed action replaces the bot's choice
const RESIGN_RATE = 1 / 3000;     // chance per step that an off-turn player resigns (LEAVE)
const LEGAL_CHECK_EVERY = 50;     // every n-th step, cross-check the whole legalActions list

const PLAY_PHASES = ['rolling', 'jail_decision', 'buying_or_auction', 'paying', 'end_turn'];
const ROLL_AGAIN_PHASES = ['end_turn', 'buying_or_auction', 'paying'];
const TURN_ACTIONS = ['ROLL', 'BUY', 'DECLINE', 'END_TURN', 'PAY_JAIL_FINE', 'USE_JAIL_CARD', 'PAY_DEBT', 'DECLARE_BANKRUPTCY'];
const MANAGEMENT = { build: 'BUILD', sellHouse: 'SELL_HOUSE', mortgage: 'MORTGAGE', unmortgage: 'UNMORTGAGE' };
const OWNABLE = BOARD.tiles.filter((t) => ['property', 'railroad', 'utility'].includes(t.type)).map((t) => t.index);
const GROUPS = Object.keys(BOARD.groups).map((g) => groupIndices(g)).filter((g) => g.length > 0);
const DECK_SIZE = 16;

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
  };
  let state = createGame({ id: `g_sim${seed}`, seed, settings });
  for (let i = 0; i < players; i++) {
    const join = { type: 'JOIN', playerId: `p${i + 1}`, name: `Bot ${i + 1}`, token: BOARD.tokens[i].id };
    state = mustApply(state, join, `seed ${seed} setup`).state;
  }
  return mustApply(state, { type: 'START_GAME', playerId: 'p1' }, `seed ${seed} setup`).state;
}

/**
 * The next action: usually the current player's bot; sometimes a TIMEOUT, a random listed action
 * (reaching moves a sensible bot never makes, e.g. building while poor) or an off-turn resignation.
 */
function nextAction(state, rng, step, where) {
  const pid = currentPlayerId(state);
  if (nextFloat(rng) < RESIGN_RATE) {
    const others = state.players.filter((p) => !p.bankrupt && p.id !== pid);
    const quitter = others[nextInt(rng, 0, others.length - 1)];
    assert.ok(legalActions(state, quitter.id).actions.includes('LEAVE'), `${where}: LEAVE not listed for ${quitter.id}`);
    return { type: 'LEAVE', playerId: quitter.id };
  }
  if (nextFloat(rng) < TIMEOUT_RATE) return { type: 'TIMEOUT', playerId: pid };

  const legal = legalActions(state, pid);
  if (step % LEGAL_CHECK_EVERY === 0) checkLegalList(state, pid, legal, where);
  const action = nextFloat(rng) < EXPLORE_RATE ? randomListed(legal, pid, rng) : chooseAction(state, legal, pid, rng);
  if (!action) assert.fail(`${where}: nothing to do for ${pid} in ${state.turn.phase}`);
  const key = Object.keys(MANAGEMENT).find((k) => MANAGEMENT[k] === action.type);
  const listed = key ? legal[key].includes(action.tileIndex) : legal.actions.includes(action.type);
  if (!listed) assert.fail(`${where}: the bot chose an unlisted action ${JSON.stringify(action)}`);
  return action;
}

/** Any listed action except LEAVE, uniformly at random. */
function randomListed(legal, playerId, rng) {
  const options = legal.actions.filter((type) => type !== 'LEAVE').map((type) => ({ type, playerId }));
  for (const [key, type] of Object.entries(MANAGEMENT)) {
    for (const tileIndex of legal[key]) options.push({ type, playerId, tileIndex });
  }
  return options.length > 0 ? options[nextInt(rng, 0, options.length - 1)] : null;
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
  let steps = 0;
  for (; steps < MAX_ACTIONS && state.status === 'active'; steps++) {
    const where = `seed ${seed} step ${steps}`;
    const action = nextAction(state, rng, steps, where);
    const res = mustApply(state, action, where);
    if (!sameJson(state, snapshot)) assert.fail(`${where}: ${JSON.stringify(action)} mutated its input state`);
    if (res.state === state || res.state.seq !== state.seq + 1) assert.fail(`${where}: expected a new state with seq + 1`);
    snapshot = jsonSnapshot(res.state, where);
    checkInvariants(res.state, where, action);
    if (record) {
      actions.push(action);
      events.push(res.events);
    }
    state = res.state;
  }
  // jsonSnapshot checks JSON-safety at every step; do one real round trip per game as well.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(state)), state, `seed ${seed}: JSON round trip lost data`);
  return { start, state, steps, actions, events };
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

function checkInvariants(s, where, action) {
  const expect = (ok, message) => {
    if (!ok) assert.fail(`${where} after ${JSON.stringify(action)}: ${typeof message === 'function' ? message() : message}`);
  };
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
    expect(t.phase !== 'jail_decision' || current.inJail, 'jail_decision for a player who is not in jail');
  }
  expect((t.pendingPurchase !== null) === (t.phase === 'buying_or_auction'), 'pendingPurchase ⇔ buying_or_auction');
  expect((t.pendingDebt !== null) === (t.phase === 'paying'), 'pendingDebt ⇔ paying');
  expect(!t.rollAgain || ROLL_AGAIN_PHASES.includes(t.phase), () => `rollAgain in ${t.phase}`);

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
    for (const group of GROUPS) {
      const levels = group.map((i) => tileAt.get(i).houses);
      expect(Math.max(...levels) - Math.min(...levels) <= 1, () => `uneven group ${group}: ${levels}`);
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

/** Every listed action succeeds and every unlisted turn / management action fails (CONTRACT §5). */
function checkLegalList(state, playerId, legal, where) {
  for (const type of legal.actions) {
    const res = applyAction(state, { type, playerId });
    if (res.error) assert.fail(`${where}: listed ${type} fails with ${JSON.stringify(res.error)}`);
  }
  for (const type of TURN_ACTIONS) {
    if (!legal.actions.includes(type) && !applyAction(state, { type, playerId }).error) {
      assert.fail(`${where}: unlisted ${type} succeeds`);
    }
  }
  for (const [key, type] of Object.entries(MANAGEMENT)) {
    for (const tileIndex of OWNABLE) {
      const ok = !applyAction(state, { type, playerId, tileIndex }).error;
      if (ok !== legal[key].includes(tileIndex)) assert.fail(`${where}: ${type} ${tileIndex} listed/succeeds disagree`);
    }
  }
}

// ---------------------------------------------------------------------------

describe('simulation', () => {
  test(`${GAMES} seeded bot games keep every invariant`, (t) => {
    let finished = 0;
    let actions = 0;
    const byPlayers = {};
    for (let seed = 1; seed <= GAMES; seed++) {
      const game = playGame(seed);
      actions += game.steps;
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
    assert.ok(finished >= GAMES * MIN_FINISHED_SHARE, `only ${finished}/${GAMES} games finished`);
    const two = byPlayers[2];
    assert.ok(two.finished >= two.games * MIN_FINISHED_SHARE_2P, `only ${two.finished}/${two.games} 2-player games finished`);
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
