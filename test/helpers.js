// Shared helpers for the engine unit tests.
//
// Tests may *construct* states by editing plain JSON fields (every setter below works on a
// structuredClone and returns the copy), but behaviour is only ever driven through
// applyAction and the other functions exported by engine/index.js.

import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { applyAction, createGame, rollDice, BOARD } from '../engine/index.js';

export const TOKEN_IDS = BOARD.tokens.map((t) => t.id);

// ---------------------------------------------------------------------------
// Game construction

/** Lobby state with `players` joined as p1..pN (names "Player N", tokens in board order). */
export function lobby({ players = 0, seed = 12345, settings = {} } = {}) {
  let state = createGame({ id: 'g_test', seed, settings });
  for (let i = 1; i <= players; i++) {
    state = act(state, { type: 'JOIN', playerId: `p${i}`, name: `Player ${i}`, token: TOKEN_IDS[i - 1] }).state;
  }
  return state;
}

/** Active game: createGame + JOIN × players + START_GAME by the host (p1). p1 is to move. */
export function newGame({ players = 2, seed = 12345, settings = {} } = {}) {
  return act(lobby({ players, seed, settings }), { type: 'START_GAME', playerId: 'p1' }).state;
}

// ---------------------------------------------------------------------------
// Driving actions

/** Apply an action that must succeed; returns { state, events }. */
export function act(state, action) {
  const res = applyAction(state, action);
  assert.ok(res && typeof res === 'object', 'applyAction must return an object');
  assert.ok(!res.error, `${action.type} by ${action.playerId} failed: ${JSON.stringify(res.error)}`);
  assert.ok(Array.isArray(res.events), 'events must be an array');
  assert.notEqual(res.state, state, 'a successful action must return a new state object');
  return { state: res.state, events: res.events };
}

/**
 * Apply an action that must fail. `code` is the expected error code (or an array of
 * acceptable codes, or undefined for "any"). Checks the contract for failures: same state
 * reference returned, no events, input not mutated, error = { code, message }.
 */
export function reject(state, action, code) {
  const before = structuredClone(state);
  const res = applyAction(state, action);
  const label = `${action && action.type} by ${action && action.playerId}`;
  assert.ok(res && res.error, `${label} should have failed${code ? ` with ${code}` : ''}`);
  if (Array.isArray(code)) {
    assert.ok(code.includes(res.error.code), `${label}: expected one of ${code}, got ${res.error.code} (${res.error.message})`);
  } else if (code) {
    assert.equal(res.error.code, code, `${label}: ${res.error.message}`);
  }
  assert.equal(typeof res.error.code, 'string');
  assert.equal(typeof res.error.message, 'string');
  assert.equal(res.state, state, 'a failed action must return the same state object');
  assert.deepEqual(res.events, []);
  assert.deepEqual(state, before, 'a failed action must not mutate its input');
  return res.error;
}

/** Roll a specific pair of dice for `playerId` (sets the RNG counter first). */
export function roll(state, playerId, d1, d2) {
  return act(withDice(state, d1, d2), { type: 'ROLL', playerId });
}

// ---------------------------------------------------------------------------
// Dice control

/**
 * Clone whose rng.counter is positioned so the next rollDice() yields [d1, d2].
 * The RNG is stateless over {seed, counter} (CONTRACT §2), so we search counters upward
 * from the current one on throwaway copies.
 */
export function withDice(state, d1, d2) {
  const { seed, counter } = state.rng;
  for (let c = counter; c < counter + 100000; c++) {
    const [a, b] = rollDice({ seed, counter: c });
    if (a === d1 && b === d2) return edit(state, (s) => { s.rng.counter = c; });
  }
  throw new Error(`no RNG counter found for dice [${d1}, ${d2}]`);
}

// ---------------------------------------------------------------------------
// Reading state

export const player = (state, id) => state.players.find((p) => p.id === id);
export const tile = (state, index) => state.tiles.find((t) => t.index === index);
export const current = (state) => state.turn.order[state.turn.currentIndex];

/** Events of one type. */
export const ofType = (events, type) => events.filter((e) => e.type === type);

/** Assert there is an event of `type` whose fields include `fields` (deep-equal per key). */
export function assertEvent(events, type, fields = {}) {
  const match = events.find((e) => e.type === type
    && Object.entries(fields).every(([k, v]) => isDeepStrictEqual(e[k], v)));
  assert.ok(match, `expected event ${type} ${JSON.stringify(fields)} in ${JSON.stringify(events)}`);
  return match;
}

export function assertNoEvent(events, type) {
  assert.deepEqual(ofType(events, type), [], `unexpected ${type} event`);
}

// ---------------------------------------------------------------------------
// Building states (all return a modified clone)

export function edit(state, fn) {
  const copy = structuredClone(state);
  fn(copy);
  return copy;
}

export function setPlayer(state, playerId, fields) {
  return edit(state, (s) => { Object.assign(player(s, playerId), fields); });
}
export const setCash = (state, playerId, cash) => setPlayer(state, playerId, { cash });
export const setPosition = (state, playerId, position) => setPlayer(state, playerId, { position });
export const setTurn = (state, fields) => edit(state, (s) => { Object.assign(s.turn, fields); });

/**
 * Give a tile to a player (or null for the bank) with buildings / mortgage state.
 * Keeps the bank's building supply consistent (5 houses = a hotel).
 */
export function give(state, playerId, tileIndex, { houses = 0, mortgaged = false } = {}) {
  return edit(state, (s) => {
    const t = tile(s, tileIndex);
    assert.ok(t, `tile ${tileIndex} is not ownable`);
    if (t.houses === 5) s.bank.hotels += 1; else s.bank.houses += t.houses;
    if (houses === 5) s.bank.hotels -= 1; else s.bank.houses -= houses;
    Object.assign(t, { ownerId: playerId, houses, mortgaged });
  });
}

/** Put a player in jail. If it is their turn and they were about to roll, phase → jail_decision. */
export function jail(state, playerId, jailTurns = 0) {
  return edit(state, (s) => {
    Object.assign(player(s, playerId), { inJail: true, jailTurns, position: BOARD.jailIndex });
    if (current(s) === playerId && s.turn.phase === 'rolling') s.turn.phase = 'jail_decision';
  });
}

/** Hand a Get Out of Jail Free card from `deck` to a player. */
export function giveJailCard(state, playerId, deck) {
  return edit(state, (s) => {
    const p = player(s, playerId);
    p.getOutOfJailCards += 1;
    p.jailCards.push(deck);
  });
}

/** Reorder a deck so `ids` are drawn next (in that order); pos is reset to 0. */
export function stackDeck(state, deck, ids) {
  return edit(state, (s) => {
    const rest = s.decks[deck].order.filter((id) => !ids.includes(id));
    s.decks[deck].order = [...ids, ...rest];
    s.decks[deck].pos = 0;
  });
}
