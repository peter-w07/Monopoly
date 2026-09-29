// A simple deterministic Monopoly bot, shared by the simulation test and any script that needs
// automatic players (load tests, demo games, ...).
//
//   const legal = legalActions(state, playerId);
//   const action = chooseAction(state, legal, playerId, botRng);   // → action object, or null
//   if (action) state = applyAction(state, action).state;
//
// The bot only ever returns actions listed in `legal` (a BID amount within legal.auction, a
// PROPOSE_TRADE to one of legal.tradeTargets that validateTrade accepts), so a correct engine
// accepts every one. It never picks LEAVE or TIMEOUT and does nothing in the lobby.
//
// On its own turn it buys everything it can afford (and mortgages loose lots to buy a tile that
// completes a colour group), builds while it keeps a small cash reserve, sometimes offers a trade
// for the one tile it is missing from a colour group, and handles debt by mortgaging loose
// properties first, then selling houses, then declaring bankruptcy (at once if even selling
// everything couldn't cover the debt).
// Off its turn it bids in auctions (up to ~90% of the price, 120% for a tile that completes one of
// its groups, keeping a cash reserve; otherwise it passes) and answers trades offered to it
// (accepting when what it gets clearly outweighs what it gives). The proposer of a pending trade
// waits (returns null), as does anyone with nothing to do.
//
// `rng` is optional and may be:
//   - a function returning floats in [0, 1), or
//   - an engine-style RNG object { seed, counter } (see engine/rng.js), advanced with nextFloat.
//     Use a separate one for the bot — never state.rng, which belongs to the game.
//   - omitted: the bot always takes its preferred option.
// With the same state, legal list and rng position the bot always returns the same action.
// Trade offers are only ever ones the target would accept by this same logic, so between bots
// nothing loops. The bot keeps no memory, though: without an rng it offers the same trade again
// each time it is rejected, so pass one when it plays against people (bot-client does).

import {
  BOARD, currentPlayerId, getPlayer, getTile, getTileState, groupIndices, liquidationValue,
  mortgageTransferFee, nextFloat, tradeableTiles, unmortgageCost, validateTrade,
} from '../engine/index.js';

/** Cash the bot tries to keep after voluntary spending (building, unmortgaging, bidding, trading). */
const RESERVE = 150;
/** Chance per decision on its own turn that it looks for a trade to propose. */
const PROPOSE_CHANCE = 0.3;
/** What a Get Out of Jail Free card is worth to it in a trade. */
const JAIL_CARD_VALUE = 50;
const GROUPS = Object.keys(BOARD.groups).map((g) => groupIndices(g)).filter((g) => g.length > 0);

export function chooseAction(state, legal, playerId, rng = null) {
  if (rng !== null && rng === state.rng) throw new Error('chooseAction: pass the bot its own rng, not state.rng');
  const me = playerId ? getPlayer(state, playerId) : null;
  if (!me || me.bankrupt || state.status !== 'active' || !legal) return null;

  const random = randomSource(rng);
  const has = (type) => legal.actions.includes(type);
  const act = (type, tileIndex) => (tileIndex === undefined ? { type, playerId } : { type, playerId, tileIndex });

  // Anyone may take part in an auction or answer a trade; everything else is for the current player.
  if (state.turn.phase === 'auction') return auctionAction(state, legal, me, act, has);
  if (state.turn.phase === 'trading') return tradeAnswer(state, me, act, has);
  if (currentPlayerId(state) !== playerId) return null;

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
      return has('DECLINE') ? act('DECLINE') : null; // opens an auction when auctionOnDecline is on
    }

    case 'jail_decision':
      if (has('USE_JAIL_CARD') && random() < 0.75) return act('USE_JAIL_CARD');
      if (has('PAY_JAIL_FINE') && me.cash >= 400 && random() < 0.5) return act('PAY_JAIL_FINE');
      return has('ROLL') ? act('ROLL') : null;

    case 'rolling':
    case 'end_turn': {
      // First try to trade for the missing tile of a colour group, then spend spare cash:
      // houses, then lifting mortgages (inside complete groups first, since that allows building there).
      if (has('PROPOSE_TRADE') && random() < PROPOSE_CHANCE) {
        const offer = tradeProposal(state, legal, me);
        if (offer) return offer;
      }
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

// ---------------------------------------------------------------------------
// Auctions

/**
 * Bids in steps of ~10% of the price (opening at half of it), up to 90% of the price, or 120% for a
 * tile that completes one of its groups, while keeping a cash reserve. Otherwise drops out.
 */
function auctionAction(state, legal, me, act, has) {
  const { tileIndex, highBid } = state.auction;
  if (legal.auction) {
    const { minBid, maxBid } = legal.auction;
    const { price } = getTile(tileIndex);
    const key = completesGroup(state, me.id, tileIndex);
    const limit = Math.min(Math.floor(price * (key ? 1.2 : 0.9)), me.cash - (key ? RESERVE / 2 : RESERVE), maxBid);
    const wanted = highBid === 0 ? Math.round(price / 2) : highBid + Math.max(5, Math.round(price / 10));
    const amount = Math.min(Math.max(minBid, wanted), limit);
    if (amount >= minBid) return { type: 'BID', playerId: me.id, amount };
  }
  return has('PASS_AUCTION') ? act('PASS_AUCTION') : null;
}

// ---------------------------------------------------------------------------
// Trading

/** The target accepts a trade that is good for it and rejects anything else; the proposer waits. */
function tradeAnswer(state, me, act, has) {
  const { trade } = state;
  if (trade.toPlayerId !== me.id) return null;
  if (has('ACCEPT_TRADE') && tradeIsGood(state, me.id, trade.fromPlayerId, trade.give, trade.get)) return act('ACCEPT_TRADE');
  return has('REJECT_TRADE') ? act('REJECT_TRADE') : null;
}

/**
 * For each colour group where the bot owns every tile but one, and an opponent holds that one:
 * offer a swap (preferably a tile that completes one of *their* groups), else about 1.5× the
 * price in cash. Only offers the target would accept by this same logic, and that the bot likes.
 */
function tradeProposal(state, legal, me) {
  const mine = tradeableTiles(state, me.id);
  for (const group of GROUPS) {
    const missing = group.filter((i) => ownerOf(state, i) !== me.id);
    if (missing.length !== 1) continue;
    const want = missing[0];
    const holderId = ownerOf(state, want);
    if (!legal.tradeTargets.includes(holderId) || !group.every((i) => i === want || mine.includes(i))) continue;

    const get = { cash: 0, tiles: [want], jailCards: 0 };
    const swaps = mine.filter((i) => !group.includes(i));
    swaps.sort((a, b) => Number(completesGroup(state, holderId, b)) - Number(completesGroup(state, holderId, a)));
    const offers = swaps.map((i) => ({ cash: 0, tiles: [i], jailCards: 0 }));
    const cash = Math.ceil(getTile(want).price * 1.5);
    if (me.cash - cash - feeFor(state, [want]) >= RESERVE) offers.push({ cash, tiles: [], jailCards: 0 });

    for (const give of offers) {
      const offer = { toPlayerId: holderId, give, get };
      if (validateTrade(state, me.id, offer)) continue;
      if (!tradeIsGood(state, me.id, holderId, get, give) || !tradeIsGood(state, holderId, me.id, give, get)) continue;
      return { type: 'PROPOSE_TRADE', playerId: me.id, ...offer };
    }
  }
  return null;
}

/**
 * Would `playerId` like receiving `receive` from `otherId` in exchange for `give`? What it gets
 * (tiles that complete one of its groups count double; minus the 10% fee on mortgaged tiles)
 * must be worth at least what it gives, valued 10% above face — and a tile that completes the
 * other player's group, or belongs to a group it already owns, is not given away cheaply. It
 * also keeps its cash reserve (or at least doesn't dip further below it).
 */
function tradeIsGood(state, playerId, otherId, receive, give) {
  const me = getPlayer(state, playerId);
  const fee = feeFor(state, receive.tiles);
  const cashAfter = me.cash - give.cash + receive.cash - fee;
  if (cashAfter < Math.min(RESERVE, me.cash) || cashAfter < 0) return false;

  let gain = receive.cash + receive.jailCards * JAIL_CARD_VALUE - fee;
  for (const i of receive.tiles) gain += tileValue(state, i) * (completesGroup(state, playerId, i) ? 2 : 1);
  let loss = give.cash + give.jailCards * JAIL_CARD_VALUE;
  for (const i of give.tiles) {
    const { price } = getTile(i);
    let value = tileValue(state, i) * 1.1;
    if (completesGroup(state, otherId, i)) value = Math.max(value, price * 1.5);
    if (completesGroup(state, playerId, i)) value = Math.max(value, price * 3); // breaks up my own group
    loss += value;
  }
  return gain > 0 && gain >= loss;
}

/** A tile's worth in a trade: its price, less the cost of lifting the mortgage if it is mortgaged. */
function tileValue(state, index) {
  const { price } = getTile(index);
  return getTileState(state, index).mortgaged ? price - unmortgageCost(index) : price;
}

function feeFor(state, tiles) {
  return tiles.reduce((sum, i) => sum + (getTileState(state, i).mortgaged ? mortgageTransferFee(i) : 0), 0);
}

// ---------------------------------------------------------------------------
// Helpers

/** True if the player owns every *other* tile of this property's colour group (so it is or would be complete). */
function completesGroup(state, playerId, index) {
  const tile = getTile(index);
  if (tile.type !== 'property') return false;
  return groupIndices(tile.group).every((i) => i === index || ownerOf(state, i) === playerId);
}

function ownerOf(state, index) {
  return getTileState(state, index)?.ownerId ?? null;
}

function houses(state, index) {
  return getTileState(state, index)?.houses ?? 0;
}

function pick(list, random) {
  return list[Math.min(list.length - 1, Math.floor(random() * list.length))];
}

function randomSource(rng) {
  if (typeof rng === 'function') return rng;
  if (rng && typeof rng === 'object') return () => nextFloat(rng);
  return () => 0; // no rng: always the preferred option
}
