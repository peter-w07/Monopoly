// Pure rule queries. Nothing here mutates state.
//
// validateAction() holds one validator per action type. applyAction (actions.js) and
// legalActions (below) both use it, so an action listed as legal always succeeds.

import { BOARD, TOKENS, getTile, groupIndices, isOwnable } from './board.js';

// ---------------------------------------------------------------------------
// Basic lookups
// ---------------------------------------------------------------------------

/** The state.tiles entry for an ownable tile, or null. */
export function getTileState(state, index) {
  return state.tiles.find((t) => t.index === index) ?? null;
}

export function getPlayer(state, playerId) {
  return state.players.find((p) => p.id === playerId) ?? null;
}

/** Id of the player whose turn it is (null in the lobby). */
export function currentPlayerId(state) {
  if (state.status === 'lobby') return null;
  return state.turn.order[state.turn.currentIndex] ?? null;
}

/** Non-bankrupt players, in turn order (join order while in the lobby). */
export function activePlayers(state) {
  const ids = state.turn.order.length > 0 ? state.turn.order : state.players.map((p) => p.id);
  return ids.map((id) => getPlayer(state, id)).filter((p) => p !== null && !p.bankrupt);
}

export function ownsFullGroup(state, playerId, group) {
  const indices = groupIndices(group);
  return indices.length > 0 && indices.every((i) => getTileState(state, i)?.ownerId === playerId);
}

/** Number of tiles of a type the player owns (mortgaged ones count). */
export function countOwned(state, playerId, type) {
  return state.tiles.filter((t) => t.ownerId === playerId && getTile(t.index).type === type).length;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** Rent owed for landing on a tile; 0 if unowned or mortgaged. */
export function rentFor(state, tileIndex, { diceTotal = 0, rentMultiplier = 1, diceMultiplier = null } = {}) {
  const ts = getTileState(state, tileIndex);
  if (!ts || ts.ownerId === null || ts.mortgaged) return 0;
  const tile = getTile(tileIndex);
  switch (tile.type) {
    case 'property':
      if (ts.houses > 0) return tile.rent[ts.houses];
      return tile.rent[0] * (ownsFullGroup(state, ts.ownerId, tile.group) ? 2 : 1);
    case 'railroad': {
      const count = Math.min(countOwned(state, ts.ownerId, 'railroad'), tile.rent.length);
      return tile.rent[count - 1] * rentMultiplier;
    }
    case 'utility': {
      const count = Math.min(countOwned(state, ts.ownerId, 'utility'), tile.multipliers.length);
      return diceTotal * (diceMultiplier ?? tile.multipliers[count - 1]);
    }
    default:
      return 0;
  }
}

/**
 * Cost to lift a mortgage: mortgage value plus interest, rounded up to whole dollars.
 * Float noise is rounded away first (100 * 1.1 is 110.00000000000001 in JS, which must be 110, not 111).
 */
export function unmortgageCost(tileIndex) {
  const exact = getTile(tileIndex).mortgage * (1 + BOARD.unmortgageInterest);
  return Math.ceil(Math.round(exact * 1e6) / 1e6);
}

/** Refund for selling one building level back to the bank. */
export function buildingRefund(tileIndex) {
  return Math.floor(getTile(tileIndex).houseCost / 2);
}

/**
 * Cash the player could raise: cash + half cost of every building level + mortgage value of unmortgaged tiles.
 * Exact, because every building level can always be sold (a hotel breaks into as many houses as the bank
 * has, see canSellHouse) and every tile can be mortgaged once its group's buildings are gone.
 */
export function liquidationValue(state, playerId) {
  const player = getPlayer(state, playerId);
  if (!player) return 0;
  let total = player.cash;
  for (const ts of state.tiles) {
    if (ts.ownerId !== playerId) continue;
    if (ts.houses > 0) total += ts.houses * buildingRefund(ts.index);
    if (!ts.mortgaged) total += getTile(ts.index).mortgage;
  }
  return total;
}

/** For display: cash + price of owned tiles (mortgage value if mortgaged) + cost of buildings. */
export function netWorth(state, playerId) {
  const player = getPlayer(state, playerId);
  if (!player) return 0;
  let total = player.cash;
  for (const ts of state.tiles) {
    if (ts.ownerId !== playerId) continue;
    const tile = getTile(ts.index);
    total += ts.mortgaged ? tile.mortgage : tile.price;
    if (ts.houses > 0) total += ts.houses * tile.houseCost;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Building / mortgage rule checks (ownership & board rules only; turn and phase are checked by the validators)
// ---------------------------------------------------------------------------

const OK = Object.freeze({ ok: true });
const fail = (code, message) => ({ ok: false, code, message });

function checkOwnedTile(state, playerId, tileIndex, propertyOnly) {
  const valid = Number.isInteger(tileIndex) && (propertyOnly ? getTile(tileIndex)?.type === 'property' : isOwnable(tileIndex));
  if (!valid) return fail('INVALID_TILE', propertyOnly ? 'That tile is not a property.' : 'That tile cannot be owned.');
  const tile = getTile(tileIndex);
  if (getTileState(state, tileIndex)?.ownerId !== playerId) return fail('NOT_OWNER', `You don't own ${tile.name}.`);
  return null;
}

function groupStates(state, tileIndex) {
  return groupIndices(getTile(tileIndex).group).map((i) => getTileState(state, i));
}

export function canBuild(state, playerId, tileIndex) {
  const bad = checkOwnedTile(state, playerId, tileIndex, true);
  if (bad) return bad;
  const tile = getTile(tileIndex);
  const ts = getTileState(state, tileIndex);
  const group = groupStates(state, tileIndex);
  if (!group.every((t) => t.ownerId === playerId)) return fail('NOT_MONOPOLY', `You need the whole ${BOARD.groups[tile.group]?.name ?? tile.group} group to build.`);
  if (group.some((t) => t.mortgaged)) return fail('MORTGAGED_IN_GROUP', 'Unmortgage every property in the group before building.');
  if (ts.houses >= 5) return fail('MAX_BUILDINGS', `${tile.name} already has a hotel.`);
  if (state.settings.evenBuild && ts.houses !== Math.min(...group.map((t) => t.houses))) {
    return fail('UNEVEN_BUILD', 'Build evenly: add to the property with the fewest buildings first.');
  }
  if (ts.houses === 4 ? state.bank.hotels < 1 : state.bank.houses < 1) {
    return fail('BANK_SHORTAGE', `The bank has no ${ts.houses === 4 ? 'hotels' : 'houses'} left.`);
  }
  const player = getPlayer(state, playerId);
  if (!player || player.cash < tile.houseCost) return fail('INSUFFICIENT_FUNDS', `Building costs $${tile.houseCost}.`);
  return OK;
}

/**
 * A hotel can always be sold: it breaks into 4 houses, or into as many as the bank has left
 * (0–3) during a house shortage, and the missing levels are refunded too (see sellOne in actions.js).
 */
export function canSellHouse(state, playerId, tileIndex) {
  const bad = checkOwnedTile(state, playerId, tileIndex, true);
  if (bad) return bad;
  const tile = getTile(tileIndex);
  const ts = getTileState(state, tileIndex);
  if (ts.houses === 0) return fail('NO_BUILDINGS', `${tile.name} has no buildings.`);
  if (state.settings.evenBuild && ts.houses !== Math.max(...groupStates(state, tileIndex).map((t) => t.houses))) {
    return fail('UNEVEN_BUILD', 'Sell evenly: sell from the property with the most buildings first.');
  }
  return OK;
}

export function canMortgage(state, playerId, tileIndex) {
  const bad = checkOwnedTile(state, playerId, tileIndex, false);
  if (bad) return bad;
  const tile = getTile(tileIndex);
  if (getTileState(state, tileIndex).mortgaged) return fail('ALREADY_MORTGAGED', `${tile.name} is already mortgaged.`);
  if (tile.type === 'property' && groupStates(state, tileIndex).some((t) => t.houses > 0)) {
    return fail('HAS_BUILDINGS', 'Sell all buildings in the group before mortgaging.');
  }
  return OK;
}

export function canUnmortgage(state, playerId, tileIndex) {
  const bad = checkOwnedTile(state, playerId, tileIndex, false);
  if (bad) return bad;
  const tile = getTile(tileIndex);
  if (!getTileState(state, tileIndex).mortgaged) return fail('NOT_MORTGAGED', `${tile.name} is not mortgaged.`);
  const cost = unmortgageCost(tileIndex);
  const player = getPlayer(state, playerId);
  if (!player || player.cash < cost) return fail('INSUFFICIENT_FUNDS', `Unmortgaging costs $${cost}.`);
  return OK;
}

// ---------------------------------------------------------------------------
// Action validation (CONTRACT §4.1). Order: known type → payload shape → game status →
// player exists & not bankrupt → current player → phase → rule checks. First failure wins.
// ---------------------------------------------------------------------------

const err = (code, message) => ({ code, message });
const fromCheck = (result) => (result.ok ? null : err(result.code, result.message));

const MANAGE_PHASES = ['rolling', 'jail_decision', 'end_turn', 'buying_or_auction'];
const RAISE_PHASES = [...MANAGE_PHASES, 'paying'];
const TIMEOUT_PHASES = ['rolling', 'jail_decision', 'buying_or_auction', 'end_turn', 'paying'];

function requireActive(state) {
  return state.status === 'active' ? null : err('GAME_NOT_ACTIVE', 'The game is not in progress.');
}

function requirePlayer(state, playerId) {
  const player = getPlayer(state, playerId);
  return player && !player.bankrupt ? null : err('NO_PLAYER', 'You are not an active player in this game.');
}

/** Game active → player active → player's turn → phase allowed. */
function requireTurn(state, action, phases) {
  return requireActive(state)
    ?? requirePlayer(state, action.playerId)
    ?? (currentPlayerId(state) === action.playerId ? null : err('NOT_YOUR_TURN', "It's not your turn."))
    ?? (phases.includes(state.turn.phase) ? null : err('WRONG_PHASE', `You can't do that now (phase: ${state.turn.phase}).`));
}

function validateStub(state) {
  return requireActive(state) ?? err('NOT_IMPLEMENTED', 'Auctions and trading are not implemented yet.');
}

const hasTileIndex = (a) => Number.isInteger(a.tileIndex);

/**
 * Who may START_GAME: the host, or — while the host is offline — the first connected player in
 * join order, so a lobby whose host went away can still be started. The engine only reads
 * `connected`, which the server maintains.
 */
function mayStart(state, playerId) {
  if (playerId === state.hostId) return true;
  if (getPlayer(state, state.hostId)?.connected !== false) return false;
  return state.players.find((p) => p.connected)?.id === playerId;
}

/** Payload shape checks, beyond the playerId every action needs. */
const PAYLOAD_CHECKS = {
  JOIN: (a) => typeof a.name === 'string' && typeof a.token === 'string',
  LEAVE: (a) => a.lobbyOnly === undefined || typeof a.lobbyOnly === 'boolean',
  BUILD: hasTileIndex,
  SELL_HOUSE: hasTileIndex,
  MORTGAGE: hasTileIndex,
  UNMORTGAGE: hasTileIndex,
};

const VALIDATORS = {
  JOIN(state, a) {
    if (state.status !== 'lobby') return err('NOT_IN_LOBBY', 'The game has already started.');
    if (getPlayer(state, a.playerId)) return err('ALREADY_JOINED', 'You have already joined this game.');
    if (state.players.length >= state.settings.maxPlayers) return err('GAME_FULL', 'The game is full.');
    const length = [...a.name.trim()].length;
    if (length < 1 || length > 20) return err('BAD_NAME', 'Name must be 1–20 characters.');
    if (!TOKENS.some((t) => t.id === a.token)) return err('BAD_TOKEN', 'Unknown token.');
    if (state.players.some((p) => p.token === a.token)) return err('TOKEN_TAKEN', 'That token is already taken.');
    return null;
  },

  // { lobbyOnly: true } means "leave the lobby": it never turns into a resignation once the game has started.
  LEAVE(state, a) {
    if (state.status === 'lobby') return getPlayer(state, a.playerId) ? null : err('NO_PLAYER', 'You are not in this game.');
    if (a.lobbyOnly === true) return err('NOT_IN_LOBBY', 'The game has already started.');
    return requireActive(state) ?? requirePlayer(state, a.playerId);
  },

  START_GAME(state, a) {
    if (state.status !== 'lobby') return err('NOT_IN_LOBBY', 'The game has already started.');
    if (!getPlayer(state, a.playerId)) return err('NO_PLAYER', 'You are not in this game.');
    if (!mayStart(state, a.playerId)) return err('NOT_HOST', 'Only the host can start the game.');
    if (state.players.length < 2) return err('NOT_ENOUGH_PLAYERS', 'At least 2 players are needed.');
    return null;
  },

  ROLL(state, a) {
    return requireTurn(state, a, ['rolling', 'jail_decision', 'end_turn'])
      ?? (state.turn.phase === 'end_turn' && !state.turn.rollAgain ? err('WRONG_PHASE', 'You have already rolled; end your turn.') : null);
  },

  BUY(state, a) {
    const bad = requireTurn(state, a, ['buying_or_auction']);
    if (bad) return bad;
    const index = state.turn.pendingPurchase;
    const ts = getTileState(state, index);
    if (!ts || ts.ownerId !== null) return err('INVALID_TILE', 'There is nothing to buy.');
    const tile = getTile(index);
    if (getPlayer(state, a.playerId).cash < tile.price) return err('INSUFFICIENT_FUNDS', `${tile.name} costs $${tile.price}.`);
    return null;
  },

  DECLINE(state, a) {
    return requireTurn(state, a, ['buying_or_auction']);
  },

  END_TURN(state, a) {
    return requireTurn(state, a, ['end_turn'])
      ?? (state.turn.rollAgain ? err('MUST_ROLL_AGAIN', 'You rolled doubles: roll again.') : null);
  },

  PAY_JAIL_FINE(state, a) {
    const bad = requireTurn(state, a, ['jail_decision']);
    if (bad) return bad;
    const player = getPlayer(state, a.playerId);
    if (!player.inJail) return err('NOT_IN_JAIL', 'You are not in jail.');
    if (player.cash < BOARD.jailFine) return err('INSUFFICIENT_FUNDS', `The fine is $${BOARD.jailFine}.`);
    return null;
  },

  USE_JAIL_CARD(state, a) {
    const bad = requireTurn(state, a, ['jail_decision']);
    if (bad) return bad;
    const player = getPlayer(state, a.playerId);
    if (!player.inJail) return err('NOT_IN_JAIL', 'You are not in jail.');
    if (player.getOutOfJailCards < 1) return err('NO_JAIL_CARD', 'You have no Get Out of Jail Free card.');
    return null;
  },

  PAY_DEBT(state, a) {
    const bad = requireTurn(state, a, ['paying']);
    if (bad) return bad;
    const debt = state.turn.pendingDebt;
    if (!debt) return err('WRONG_PHASE', 'You have no debt to pay.');
    if (getPlayer(state, a.playerId).cash < debt.amount) return err('INSUFFICIENT_FUNDS', `You need $${debt.amount}.`);
    return null;
  },

  DECLARE_BANKRUPTCY(state, a) {
    return requireTurn(state, a, ['paying']);
  },

  BUILD(state, a) {
    return requireTurn(state, a, MANAGE_PHASES) ?? fromCheck(canBuild(state, a.playerId, a.tileIndex));
  },

  SELL_HOUSE(state, a) {
    return requireTurn(state, a, RAISE_PHASES) ?? fromCheck(canSellHouse(state, a.playerId, a.tileIndex));
  },

  MORTGAGE(state, a) {
    return requireTurn(state, a, RAISE_PHASES) ?? fromCheck(canMortgage(state, a.playerId, a.tileIndex));
  },

  UNMORTGAGE(state, a) {
    return requireTurn(state, a, MANAGE_PHASES) ?? fromCheck(canUnmortgage(state, a.playerId, a.tileIndex));
  },

  // Server-only; the engine accepts it for the current player in any turn phase.
  TIMEOUT(state, a) {
    return requireTurn(state, a, TIMEOUT_PHASES);
  },

  START_AUCTION: validateStub,
  BID: validateStub,
  PROPOSE_TRADE: validateStub,
  ACCEPT_TRADE: validateStub,
  REJECT_TRADE: validateStub,
};

/** All action types the engine knows. */
export const ACTION_TYPES = Object.freeze(Object.keys(VALIDATORS));

/** → null if the action would succeed, else { code, message }. Pure. */
export function validateAction(state, action) {
  if (!action || typeof action !== 'object' || typeof action.type !== 'string' || !Object.hasOwn(VALIDATORS, action.type)) {
    const type = typeof action?.type === 'string' ? action.type : `(${typeof action?.type})`;
    return err('UNKNOWN_ACTION', `Unknown action type: ${type}.`);
  }
  if (typeof action.playerId !== 'string' || action.playerId === '') return err('BAD_PAYLOAD', 'Missing playerId.');
  const shapeOk = PAYLOAD_CHECKS[action.type]?.(action) ?? true;
  if (!shapeOk) return err('BAD_PAYLOAD', `Malformed ${action.type} action.`);
  return VALIDATORS[action.type](state, action);
}

// ---------------------------------------------------------------------------
// legalActions (CONTRACT §5)
// ---------------------------------------------------------------------------

const LISTED_TYPES = [
  'JOIN', 'LEAVE', 'START_GAME', 'ROLL', 'BUY', 'DECLINE', 'END_TURN',
  'PAY_JAIL_FINE', 'USE_JAIL_CARD', 'PAY_DEBT', 'DECLARE_BANKRUPTCY',
];

export function legalActions(state, playerId) {
  const result = { actions: [], build: [], sellHouse: [], mortgage: [], unmortgage: [] };

  if (!playerId) {
    // Spectator: can only take a seat.
    if (state.status === 'lobby' && state.players.length < state.settings.maxPlayers) result.actions.push('JOIN');
    return result;
  }

  for (const type of LISTED_TYPES) {
    const action = { type, playerId };
    if (type === 'JOIN') {
      action.name = 'Player';
      action.token = TOKENS.find((t) => !state.players.some((p) => p.token === t.id))?.id ?? '';
    }
    if (!validateAction(state, action)) result.actions.push(type);
  }

  // Management actions need the current player in an active game, and every one of them needs
  // the tile to be theirs (NOT_OWNER otherwise), so only their own tiles are worth validating.
  if (state.status !== 'active' || currentPlayerId(state) !== playerId) return result;
  const legalFor = (type, tileIndex) => !validateAction(state, { type, playerId, tileIndex });
  for (const { index, ownerId } of state.tiles) { // sorted by index, so the lists come out sorted
    if (ownerId !== playerId) continue;
    if (getTile(index).type === 'property') {
      if (legalFor('BUILD', index)) result.build.push(index);
      if (legalFor('SELL_HOUSE', index)) result.sellHouse.push(index);
    }
    if (legalFor('MORTGAGE', index)) result.mortgage.push(index);
    if (legalFor('UNMORTGAGE', index)) result.unmortgage.push(index);
  }
  return result;
}
