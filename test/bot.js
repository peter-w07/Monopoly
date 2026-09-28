// A simple deterministic Monopoly bot, shared by the simulation test and any script that needs
// automatic players (load tests, demo games, ...).
//
//   const legal = legalActions(state, playerId);
//   const action = chooseAction(state, legal, playerId, botRng);   // → action object, or null
//   if (action) state = applyAction(state, action).state;
//
// The bot only ever returns actions listed in `legal`, so a correct engine accepts every one.
// It never picks LEAVE, TIMEOUT or the stub actions, and does nothing in the lobby or off-turn
// (returns null). It buys everything it can afford (and mortgages loose lots to buy a tile that
// completes a colour group), builds while it keeps a small cash reserve, and handles debt by
// mortgaging loose properties first, then selling houses, then declaring bankruptcy (at once if
// even selling everything couldn't cover the debt).
//
// `rng` is optional and may be:
//   - a function returning floats in [0, 1), or
//   - an engine-style RNG object { seed, counter } (see engine/rng.js), advanced with nextFloat.
//     Use a separate one for the bot — never state.rng, which belongs to the game.
//   - omitted: the bot always takes its preferred option.
// With the same state, legal list and rng position the bot always returns the same action.

import { getPlayer, getTile, groupIndices, liquidationValue, nextFloat, unmortgageCost } from '../engine/index.js';

/** Cash the bot tries to keep after voluntary spending (building, unmortgaging). */
const RESERVE = 150;

export function chooseAction(state, legal, playerId, rng = null) {
  if (rng !== null && rng === state.rng) throw new Error('chooseAction: pass the bot its own rng, not state.rng');
  const me = playerId ? getPlayer(state, playerId) : null;
  if (!me || me.bankrupt || state.status !== 'active' || !legal) return null;

  const random = randomSource(rng);
  const has = (type) => legal.actions.includes(type);
  const act = (type, tileIndex) => (tileIndex === undefined ? { type, playerId } : { type, playerId, tileIndex });

  switch (state.turn.phase) {
    case 'paying':
      return payingAction(state, legal, me, act, has);

    case 'buying_or_auction': {
      if (has('BUY')) return act('BUY'); // always buy what you can afford
      // Short of cash for a tile that would complete a colour group: mortgage loose tiles to afford it.
      const index = state.turn.pendingPurchase;
      if (completesGroup(state, me.id, index)) {
        const group = getTile(index).group;
        const loose = legal.mortgage.filter((i) => getTile(i).group !== group && !completesGroup(state, me.id, i));
        const raisable = loose.reduce((sum, i) => sum + getTile(i).mortgage, 0);
        if (loose.length > 0 && me.cash + raisable >= getTile(index).price) return act('MORTGAGE', loose[0]);
      }
      return has('DECLINE') ? act('DECLINE') : null;
    }

    case 'jail_decision':
      if (has('USE_JAIL_CARD') && random() < 0.75) return act('USE_JAIL_CARD');
      if (has('PAY_JAIL_FINE') && me.cash >= 400 && random() < 0.5) return act('PAY_JAIL_FINE');
      return has('ROLL') ? act('ROLL') : null;

    case 'rolling':
    case 'end_turn': {
      // Spend spare cash first: houses, then lifting mortgages (inside complete groups first,
      // since that allows building there).
      const builds = legal.build.filter((i) => me.cash - getTile(i).houseCost >= RESERVE);
      if (builds.length > 0 && random() < 0.9) return act('BUILD', pick(builds, random));
      const lifts = legal.unmortgage.filter((i) => me.cash - unmortgageCost(i) >= RESERVE);
      const key = lifts.find((i) => completesGroup(state, me.id, i));
      if (key !== undefined) return act('UNMORTGAGE', key);
      if (lifts.length > 0 && random() < 0.5) return act('UNMORTGAGE', pick(lifts, random));
      if (has('ROLL')) return act('ROLL');
      return has('END_TURN') ? act('END_TURN') : null;
    }

    default:
      return null;
  }
}

/** Debt: pay if possible; give up at once if even full liquidation can't cover it; else raise cash. */
function payingAction(state, legal, me, act, has) {
  if (has('PAY_DEBT')) return act('PAY_DEBT');
  const debt = state.turn.pendingDebt;
  if (debt && liquidationValue(state, me.id) < debt.amount) return act('DECLARE_BANKRUPTCY');

  // 1. Mortgage properties that are not part of a complete colour group (railroads, utilities, loose lots).
  const loose = legal.mortgage.filter((i) => !completesGroup(state, me.id, i));
  if (loose.length > 0) return act('MORTGAGE', loose[0]);
  // 2. Sell buildings, from the tile with the most (ties → lowest index), as autoRaise does.
  if (legal.sellHouse.length > 0) {
    const most = legal.sellHouse.reduce((best, i) => (houses(state, i) > houses(state, best) ? i : best));
    return act('SELL_HOUSE', most);
  }
  // 3. Mortgage whatever is left.
  if (legal.mortgage.length > 0) return act('MORTGAGE', legal.mortgage[0]);
  return act('DECLARE_BANKRUPTCY');
}

/** True if the player owns every *other* tile of this property's colour group (so it is or would be complete). */
function completesGroup(state, playerId, index) {
  const tile = getTile(index);
  if (tile.type !== 'property') return false;
  return groupIndices(tile.group).every((i) => i === index || state.tiles.find((t) => t.index === i)?.ownerId === playerId);
}

function houses(state, index) {
  return state.tiles.find((t) => t.index === index)?.houses ?? 0;
}

function pick(list, random) {
  return list[Math.min(list.length - 1, Math.floor(random() * list.length))];
}

function randomSource(rng) {
  if (typeof rng === 'function') return rng;
  if (rng && typeof rng === 'object') return () => nextFloat(rng);
  return () => 0; // no rng: always the preferred option
}
