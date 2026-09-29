// applyAction(state, action) → { state, events } | { state, events: [], error }.
//
// Validation lives in rules.js (validateAction, shared with legalActions). Handlers here only ever
// run on valid actions: they mutate a deep copy of the input and push CONTRACT §6 events and
// human-readable log lines as things happen, so both come out in chronological order.

import { BOARD, TILES, getTile } from './board.js';
import { getCard } from './cards.js';
import { rollDice, shuffle } from './rng.js';
import {
  activePlayers, buildingRefund, canMortgage, currentPlayerId, getPlayer, getTileState, liquidationValue,
  normalizeTradeSide, rentFor, tradeFees, unmortgageCost, validateAction,
} from './rules.js';

const LOG_LIMIT = 100;
const BOARD_SIZE = TILES.length;
// Money paid to the bank for these reasons goes to the free-parking pot when that option is on.
const POT_REASONS = new Set(['tax', 'card', 'jail_fine']);

export function applyAction(state, action) {
  try {
    // Validation and the handler read one copy, so an action whose fields change between reads
    // (getters, proxies) can't pass validation as one action and then run as another.
    const a = action !== null && typeof action === 'object' ? readAction(action) : action;
    const error = validateAction(state, a);
    if (error) return { state, events: [], error };
    const ctx = { s: cloneState(state), events: [] };
    HANDLERS[a.type](ctx, a);
    ctx.s.seq = (ctx.s.seq ?? 0) + 1;
    return { state: ctx.s, events: ctx.events };
  } catch (e) {
    return { state, events: [], error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } };
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A shallow copy of the action; a trade offer's two sides (and their tile lists) are copied too. */
function readAction(action) {
  const a = { ...action };
  if (a.type === 'PROPOSE_TRADE') {
    for (const key of ['give', 'get']) {
      if (a[key] === null || typeof a[key] !== 'object' || Array.isArray(a[key])) continue;
      const side = { ...a[key] };
      if (Array.isArray(side.tiles)) side.tiles = [...side.tiles];
      a[key] = side;
    }
  }
  return a;
}

/**
 * Deep copy of the state, which is plain JSON data (CONTRACT §3). About 7× faster than
 * structuredClone on a game state, which matters to bots and simulations that apply
 * hundreds of thousands of actions.
 */
function cloneState(value) {
  if (Array.isArray(value)) return value.map(cloneState);
  if (value === null || typeof value !== 'object') return value;
  const copy = {};
  for (const key of Object.keys(value)) copy[key] = cloneState(value[key]);
  return copy;
}

function emit(ctx, type, data) {
  ctx.events.push({ type, ...data });
}

function log(ctx, line) {
  const lines = ctx.s.log;
  lines.push(line);
  if (lines.length > LOG_LIMIT) lines.splice(0, lines.length - LOG_LIMIT);
}

const money = (n) => `$${n}`;
const tileName = (index) => getTile(index).name;
const mod = (n, m) => ((n % m) + m) % m;
const actor = (ctx, action) => getPlayer(ctx.s, action.playerId);

// ---------------------------------------------------------------------------
// Handlers (one per action type; they only ever see actions that passed validation)
// ---------------------------------------------------------------------------

const HANDLERS = {
  JOIN(ctx, a) {
    const { s } = ctx;
    const name = a.name.trim();
    s.players.push({
      id: a.playerId, name, token: a.token,
      cash: s.settings.startingCash, position: 0,
      inJail: false, jailTurns: 0, getOutOfJailCards: 0, jailCards: [],
      bankrupt: false, connected: true,
    });
    if (!s.hostId) s.hostId = a.playerId;
    emit(ctx, 'player_joined', { playerId: a.playerId, name, token: a.token });
    log(ctx, `${name} joined the game.`);
  },

  LEAVE(ctx, a) {
    const { s } = ctx;
    const p = actor(ctx, a);
    if (s.status === 'lobby') {
      s.players = s.players.filter((x) => x.id !== p.id);
      if (s.hostId === p.id) s.hostId = s.players[0]?.id ?? null;
      emit(ctx, 'player_left', { playerId: p.id });
      log(ctx, `${p.name} left the game.`);
    } else {
      log(ctx, `${p.name} resigned.`);
      const wasCurrent = currentPlayerId(s) === p.id;
      // A pending trade that involves the leaver is called off first (restoring its phase); so is
      // one whose proposer owes the leaver money (§4.8 step 4 is about to change that debt).
      if (s.trade && (s.trade.fromPlayerId === p.id || s.trade.toPlayerId === p.id
        || (s.trade.returnPhase === 'paying' && debtShare(s.turn.pendingDebt, p.id) > 0))) {
        cancelTrade(ctx, 'resigned');
      }
      // The current player's auction is cancelled before the turn passes on.
      if (s.auction && wasCurrent) cancelAuction(ctx);
      // Resigning is bankruptcy to the bank, except that a debtor who owes one player (the current
      // player in the paying phase) goes bankrupt to that creditor, exactly as DECLARE_BANKRUPTCY.
      const owing = s.turn.phase === 'paying' && wasCurrent;
      goBankrupt(ctx, p, owing ? debtCreditor(s.turn.pendingDebt) : null, 'resigned');
      // Anyone else leaving an auction counts as a pass (and loses the high bid).
      if (s.auction && s.status === 'active') leaveAuction(ctx, p);
    }
  },

  START_GAME(ctx) {
    const { s } = ctx;
    s.status = 'active';
    Object.assign(s.turn, {
      order: s.players.map((p) => p.id), currentIndex: 0, number: 1,
      doublesCount: 0, rollAgain: false, lastRoll: null, pendingPurchase: null, pendingDebt: null, tradesProposed: 0,
    });
    emit(ctx, 'game_started', { order: [...s.turn.order] });
    log(ctx, `The game has started with ${s.players.length} players.`);
    startTurn(ctx);
  },

  ROLL(ctx, a) {
    const p = actor(ctx, a);
    if (ctx.s.turn.phase === 'jail_decision') jailRoll(ctx, p);
    else moveRoll(ctx, p);
  },

  BUY(ctx, a) {
    const { s } = ctx;
    const p = actor(ctx, a);
    const index = s.turn.pendingPurchase;
    const tile = getTile(index);
    p.cash -= tile.price;
    getTileState(s, index).ownerId = p.id;
    s.turn.pendingPurchase = null;
    s.turn.phase = 'end_turn';
    emit(ctx, 'bought', { playerId: p.id, tileIndex: index, price: tile.price });
    log(ctx, `${p.name} bought ${tile.name} for ${money(tile.price)}.`);
  },

  DECLINE(ctx, a) {
    const { s } = ctx;
    const p = actor(ctx, a);
    const index = s.turn.pendingPurchase;
    s.turn.pendingPurchase = null;
    s.turn.phase = 'end_turn';
    emit(ctx, 'declined', { playerId: p.id, tileIndex: index });
    log(ctx, `${p.name} declined to buy ${tileName(index)}.`);
    if (s.settings.auctionOnDecline) startAuction(ctx, index);
  },

  START_AUCTION(ctx, a) {
    HANDLERS.DECLINE(ctx, a); // validation made sure auctionOnDecline is on
  },

  BID(ctx, a) {
    const p = actor(ctx, a);
    const auction = ctx.s.auction;
    auction.highBid = a.amount;
    auction.highBidderId = p.id;
    auction.bids.push({ playerId: p.id, amount: a.amount });
    emit(ctx, 'auction_bid', { playerId: p.id, amount: a.amount });
    log(ctx, `${p.name} bid ${money(a.amount)} for ${tileName(auction.tileIndex)}.`);
    checkAuctionEnd(ctx);
  },

  PASS_AUCTION(ctx, a) {
    const p = actor(ctx, a);
    ctx.s.auction.passed.push(p.id);
    emit(ctx, 'auction_passed', { playerId: p.id });
    log(ctx, `${p.name} dropped out of the auction.`);
    checkAuctionEnd(ctx);
  },

  PROPOSE_TRADE(ctx, a) {
    const { s } = ctx;
    const p = actor(ctx, a);
    const trade = {
      id: `t_${s.seq ?? 0}`, fromPlayerId: p.id, toPlayerId: a.toPlayerId,
      give: normalizeTradeSide(a.give), get: normalizeTradeSide(a.get), returnPhase: s.turn.phase,
    };
    s.trade = trade;
    s.turn.phase = 'trading';
    s.turn.tradesProposed = (s.turn.tradesProposed ?? 0) + 1; // MAX_TRADES_PER_TURN (rules.js)
    emit(ctx, 'trade_proposed', tradeEvent(trade));
    log(ctx, `${p.name} offers ${getPlayer(s, trade.toPlayerId).name} ${describeSide(trade.give)} for ${describeSide(trade.get)}.`);
  },

  ACCEPT_TRADE(ctx) {
    const { s } = ctx;
    const trade = s.trade;
    const from = getPlayer(s, trade.fromPlayerId);
    const to = getPlayer(s, trade.toPlayerId);
    const fees = tradeFees(s, from.id, trade); // before any tile moves; mortgages don't change
    from.cash += trade.get.cash - trade.give.cash;
    to.cash += trade.give.cash - trade.get.cash;
    for (const index of trade.give.tiles) getTileState(s, index).ownerId = to.id;
    for (const index of trade.get.tiles) getTileState(s, index).ownerId = from.id;
    moveJailCards(from, to, trade.give.jailCards);
    moveJailCards(to, from, trade.get.jailCards);
    for (const p of [from, to]) p.cash -= fees[p.id]; // to the bank, never the pot
    s.trade = null;
    s.turn.phase = trade.returnPhase;
    emit(ctx, 'trade_accepted', { ...tradeEvent(trade), fees: { ...fees } });
    log(ctx, `${to.name} accepted ${from.name}'s trade.`);
    for (const p of [from, to]) {
      if (fees[p.id] > 0) log(ctx, `${p.name} paid the bank ${money(fees[p.id])} interest on mortgaged property received.`);
    }
  },

  REJECT_TRADE(ctx, a) {
    const { s } = ctx;
    const trade = s.trade;
    s.trade = null;
    s.turn.phase = trade.returnPhase;
    emit(ctx, 'trade_rejected', { tradeId: trade.id, byPlayerId: a.playerId });
    log(ctx, a.playerId === trade.fromPlayerId
      ? `${getPlayer(s, a.playerId).name} withdrew the trade offer.`
      : `${getPlayer(s, a.playerId).name} rejected the trade.`);
  },

  END_TURN(ctx) {
    advanceTurn(ctx);
  },

  PAY_JAIL_FINE(ctx, a) {
    const p = actor(ctx, a);
    pay(ctx, p, null, BOARD.jailFine, 'jail_fine');
    releaseFromJail(ctx, p, 'fine');
    ctx.s.turn.phase = 'rolling';
  },

  USE_JAIL_CARD(ctx, a) {
    const p = actor(ctx, a);
    const deck = p.jailCards.shift(); // the card goes back into its deck (drawable again)
    p.getOutOfJailCards -= 1;
    log(ctx, `${p.name} used a Get Out of Jail Free card (${deck === 'chance' ? 'Chance' : 'Community Chest'}).`);
    releaseFromJail(ctx, p, 'card');
    ctx.s.turn.phase = 'rolling';
  },

  PAY_DEBT(ctx, a) {
    const { s } = ctx;
    const p = actor(ctx, a);
    const debt = s.turn.pendingDebt;
    s.turn.pendingDebt = null;
    if (debt.payees) {
      for (const payee of debt.payees) transfer(ctx, p, payee.playerId, payee.amount, debt.reason);
    } else {
      transfer(ctx, p, debt.toPlayerId, debt.amount, debt.reason);
    }
    emit(ctx, 'debt_paid', {
      playerId: p.id, toPlayerId: debt.toPlayerId, amount: debt.amount, reason: debt.reason,
      ...(debt.payees ? { payees: debt.payees.map((x) => ({ ...x })) } : {}),
    });
    log(ctx, `${p.name} paid the ${money(debt.amount)} debt${recipientText(ctx, debt)}.`);
    debtSettled(ctx, p, debt);
  },

  DECLARE_BANKRUPTCY(ctx, a) {
    goBankrupt(ctx, actor(ctx, a), debtCreditor(ctx.s.turn.pendingDebt));
  },

  BUILD(ctx, a) {
    buildOne(ctx, actor(ctx, a), a.tileIndex);
  },

  SELL_HOUSE(ctx, a) {
    sellOne(ctx, actor(ctx, a), a.tileIndex);
  },

  MORTGAGE(ctx, a) {
    mortgageOne(ctx, actor(ctx, a), a.tileIndex);
  },

  UNMORTGAGE(ctx, a) {
    const p = actor(ctx, a);
    const index = a.tileIndex;
    const cost = unmortgageCost(index);
    p.cash -= cost;
    getTileState(ctx.s, index).mortgaged = false;
    emit(ctx, 'unmortgaged', { playerId: p.id, tileIndex: index, amount: cost });
    log(ctx, `${p.name} unmortgaged ${tileName(index)} for ${money(cost)}.`);
  },

  TIMEOUT(ctx, a) {
    const { s } = ctx;
    const p = actor(ctx, a);
    emit(ctx, 'timeout', { playerId: p.id, phase: s.turn.phase });
    // The auction clock running out is how auctions end, not the current player's fault; closeAuction logs the result.
    if (s.turn.phase !== 'auction') log(ctx, `${p.name} ran out of time.`);
    // An unanswered trade is called off, then the phase it interrupted times out as usual.
    if (s.turn.phase === 'trading') cancelTrade(ctx, 'timeout');
    const phase = s.turn.phase;
    switch (phase) {
      case 'auction':
        return closeAuction(ctx);
      case 'rolling':
      case 'jail_decision':
        return HANDLERS.ROLL(ctx, a);
      case 'buying_or_auction':
        return HANDLERS.DECLINE(ctx, a);
      case 'end_turn':
        return s.turn.rollAgain ? HANDLERS.ROLL(ctx, a) : HANDLERS.END_TURN(ctx, a);
      case 'paying': {
        const { amount } = s.turn.pendingDebt;
        if (p.cash < amount) autoRaise(ctx, p, amount);
        return p.cash >= amount ? HANDLERS.PAY_DEBT(ctx, a) : HANDLERS.DECLARE_BANKRUPTCY(ctx, a);
      }
      default:
        throw new Error(`TIMEOUT in unexpected phase ${phase}`); // unreachable: validation checks the phase
    }
  },
};

// ---------------------------------------------------------------------------
// Turn flow
// ---------------------------------------------------------------------------

/** Sets the phase for the (new) current player and announces the turn. */
function startTurn(ctx) {
  const { s } = ctx;
  const p = getPlayer(s, currentPlayerId(s));
  s.turn.phase = p.inJail ? 'jail_decision' : 'rolling';
  emit(ctx, 'turn_started', { playerId: p.id, turnNumber: s.turn.number });
  log(ctx, `Turn ${s.turn.number}: ${p.name}${p.inJail ? ' (in jail)' : ''}.`);
}

/** Passes the turn to the next non-bankrupt player in order. */
function advanceTurn(ctx) {
  const { s } = ctx;
  const t = s.turn;
  emit(ctx, 'turn_ended', { playerId: currentPlayerId(s) });
  for (let k = 1; k <= t.order.length; k++) {
    const i = (t.currentIndex + k) % t.order.length;
    const next = getPlayer(s, t.order[i]);
    if (next && !next.bankrupt) {
      t.currentIndex = i;
      break;
    }
  }
  Object.assign(t, { doublesCount: 0, rollAgain: false, lastRoll: null, pendingPurchase: null, pendingDebt: null, tradesProposed: 0 });
  t.number += 1;
  startTurn(ctx);
}

/** A landing may leave a pending purchase / debt / jail; otherwise the player moves on to end_turn. */
function finishResolution(ctx) {
  if (ctx.s.turn.phase === 'resolving') ctx.s.turn.phase = 'end_turn';
}

function emitRoll(ctx, p, dice, purpose) {
  const doubles = dice[0] === dice[1];
  emit(ctx, 'dice_rolled', { playerId: p.id, dice: [...dice], doubles, purpose });
  log(ctx, `${p.name} rolled ${dice[0]} + ${dice[1]}${doubles ? ' (doubles)' : ''}.`);
  return doubles;
}

/** ROLL in rolling / end_turn (rollAgain). */
function moveRoll(ctx, p) {
  const { s } = ctx;
  const t = s.turn;
  const dice = rollDice(s.rng);
  t.lastRoll = dice;
  const doubles = emitRoll(ctx, p, dice, 'move');
  if (doubles) t.doublesCount += 1;
  if (t.doublesCount >= 3) {
    log(ctx, `${p.name} rolled doubles three times in a row.`);
    sendToJail(ctx, p, 'doubles');
    return;
  }
  t.rollAgain = doubles;
  t.phase = 'resolving';
  movePlayer(ctx, p, dice[0] + dice[1], 'roll');
  resolveLanding(ctx, p, { diceTotal: dice[0] + dice[1] });
  finishResolution(ctx);
}

/** ROLL in jail_decision: doubles free you (no roll again); the third miss forces the fine. */
function jailRoll(ctx, p) {
  const { s } = ctx;
  const dice = rollDice(s.rng);
  s.turn.lastRoll = dice;
  const steps = dice[0] + dice[1];
  if (emitRoll(ctx, p, dice, 'jail')) {
    releaseFromJail(ctx, p, 'doubles');
    s.turn.phase = 'resolving';
    movePlayer(ctx, p, steps, 'roll');
    resolveLanding(ctx, p, { diceTotal: steps });
    finishResolution(ctx);
    return;
  }
  p.jailTurns += 1;
  emit(ctx, 'jail_roll_failed', { playerId: p.id, attempt: p.jailTurns });
  if (p.jailTurns < BOARD.maxJailTurns) {
    log(ctx, `${p.name} stays in jail.`);
    s.turn.phase = 'end_turn';
    return;
  }
  log(ctx, `${p.name} must pay the ${money(BOARD.jailFine)} fine.`);
  const then = { kind: 'jail_move', steps };
  if (charge(ctx, p, null, BOARD.jailFine, 'jail_fine', { then })) leaveJailAndMove(ctx, p, steps);
}

/** Forced-fine continuation: release, walk the rolled total and resolve the landing. */
function leaveJailAndMove(ctx, p, steps) {
  releaseFromJail(ctx, p, 'forced_fine');
  ctx.s.turn.phase = 'resolving';
  movePlayer(ctx, p, steps, 'roll');
  resolveLanding(ctx, p, { diceTotal: steps });
  finishResolution(ctx);
}

function releaseFromJail(ctx, p, method) {
  p.inJail = false;
  p.jailTurns = 0;
  emit(ctx, 'left_jail', { playerId: p.id, method });
  log(ctx, `${p.name} is out of jail.`);
}

function sendToJail(ctx, p, reason) {
  const { s } = ctx;
  const from = p.position;
  p.position = BOARD.jailIndex;
  p.inJail = true;
  p.jailTurns = 0;
  s.turn.doublesCount = 0;
  s.turn.rollAgain = false;
  s.turn.phase = 'end_turn';
  emit(ctx, 'sent_to_jail', { playerId: p.id, reason });
  emit(ctx, 'moved', { playerId: p.id, from, to: BOARD.jailIndex, steps: null, via: 'jail' });
  log(ctx, `${p.name} went to jail.`);
}

// ---------------------------------------------------------------------------
// Movement & landing
// ---------------------------------------------------------------------------

/** Walks `steps` tiles (negative = backwards). Moving forward past or onto GO pays the salary once. */
function movePlayer(ctx, p, steps, via) {
  const from = p.position;
  const to = mod(from + steps, BOARD_SIZE);
  p.position = to;
  emit(ctx, 'moved', { playerId: p.id, from, to, steps, via });
  if (steps > 0 && from + steps >= BOARD_SIZE) {
    p.cash += BOARD.goSalary;
    emit(ctx, 'passed_go', { playerId: p.id, amount: BOARD.goSalary });
    log(ctx, `${p.name} passed GO and collected ${money(BOARD.goSalary)}.`);
  }
}

/**
 * Resolves the tile the player is standing on.
 * opts.diceTotal: roll total for utility rent. opts.fromCard: the move came from a card, so a utility
 * rent uses a fresh dice roll and card multipliers apply.
 */
function resolveLanding(ctx, p, opts = {}) {
  const { s } = ctx;
  const index = p.position;
  const tile = getTile(index);
  emit(ctx, 'landed', { playerId: p.id, tileIndex: index });
  log(ctx, `${p.name} landed on ${tile.name}.`);

  switch (tile.type) {
    case 'property':
    case 'railroad':
    case 'utility':
      landOnOwnable(ctx, p, index, opts);
      break;
    case 'tax':
      charge(ctx, p, null, tile.amount, 'tax', { tileIndex: index });
      break;
    case 'chance':
    case 'community': {
      const card = drawCard(ctx, p, tile.type);
      if (card) applyCard(ctx, p, tile.type, card);
      break;
    }
    case 'go_to_jail':
      sendToJail(ctx, p, 'tile');
      break;
    case 'free_parking':
      if (s.settings.freeParkingPot && s.pot > 0) {
        const amount = s.pot;
        s.pot = 0;
        p.cash += amount;
        emit(ctx, 'collected', { playerId: p.id, fromPlayerId: null, amount, reason: 'free_parking' });
        log(ctx, `${p.name} collected the ${money(amount)} Free Parking pot.`);
      }
      break;
    default: // go, jail (just visiting)
      break;
  }
}

function landOnOwnable(ctx, p, index, { diceTotal = 0, rentMultiplier = 1, diceMultiplier = null, fromCard = false }) {
  const { s } = ctx;
  const tile = getTile(index);
  const ts = getTileState(s, index);
  if (ts.ownerId === null) {
    s.turn.pendingPurchase = index;
    s.turn.phase = 'buying_or_auction';
    log(ctx, `${tile.name} is for sale for ${money(tile.price)}.`);
    return;
  }
  if (ts.ownerId === p.id) return;
  const owner = getPlayer(s, ts.ownerId);
  if (ts.mortgaged) {
    log(ctx, `${tile.name} is mortgaged; no rent is due to ${owner.name}.`);
    return;
  }
  let total = diceTotal;
  if (tile.type === 'utility' && fromCard) {
    const dice = rollDice(s.rng);
    emitRoll(ctx, p, dice, 'utility');
    total = dice[0] + dice[1];
  }
  const rent = rentFor(s, index, { diceTotal: total, rentMultiplier, diceMultiplier });
  charge(ctx, p, owner.id, rent, 'rent', { tileIndex: index });
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** Draws the next card, reshuffling when the deck runs out and skipping a GOOJF card someone holds. */
function drawCard(ctx, p, deck) {
  const { s } = ctx;
  const d = s.decks[deck];
  for (let tries = 0; tries < 2 * d.order.length; tries++) {
    const id = d.order[d.pos];
    d.pos += 1;
    if (d.pos >= d.order.length) {
      d.order = shuffle(s.rng, d.order);
      d.pos = 0;
    }
    const card = getCard(deck, id);
    if (card.action.kind === 'goojf' && s.players.some((x) => x.jailCards.includes(deck))) continue;
    emit(ctx, 'card_drawn', { playerId: p.id, deck, cardId: id, text: card.text });
    log(ctx, `${p.name} drew ${deck === 'chance' ? 'Chance' : 'Community Chest'}: "${card.text}"`);
    return card;
  }
  return null; // only possible if every card in the deck were a held GOOJF card
}

function applyCard(ctx, p, deck, card) {
  const { s } = ctx;
  const act = card.action;
  switch (act.kind) {
    case 'move_to':
      movePlayer(ctx, p, mod(act.to - p.position, BOARD_SIZE) || BOARD_SIZE, 'card');
      resolveLanding(ctx, p, { fromCard: true });
      break;
    case 'move_by':
      movePlayer(ctx, p, act.steps, 'card');
      resolveLanding(ctx, p, { fromCard: true });
      break;
    case 'nearest': {
      const steps = stepsToNearest(p.position, act.tileType);
      if (steps === null) break;
      movePlayer(ctx, p, steps, 'card');
      resolveLanding(ctx, p, {
        fromCard: true, rentMultiplier: act.rentMultiplier ?? 1, diceMultiplier: act.diceMultiplier ?? null,
      });
      break;
    }
    case 'collect':
      p.cash += act.amount;
      emit(ctx, 'collected', { playerId: p.id, fromPlayerId: null, amount: act.amount, reason: 'card' });
      log(ctx, `${p.name} collected ${money(act.amount)}.`);
      break;
    case 'pay':
      charge(ctx, p, null, act.amount, 'card');
      break;
    case 'jail':
      sendToJail(ctx, p, 'card');
      break;
    case 'goojf':
      p.getOutOfJailCards += 1;
      p.jailCards.push(deck);
      emit(ctx, 'jail_card_received', { playerId: p.id, deck });
      log(ctx, `${p.name} keeps a Get Out of Jail Free card.`);
      break;
    case 'repairs': {
      let amount = 0;
      for (const ts of s.tiles) {
        if (ts.ownerId !== p.id || ts.houses === 0) continue;
        amount += ts.houses === 5 ? act.hotel : ts.houses * act.house;
      }
      if (amount === 0) log(ctx, `${p.name} has no buildings to repair.`);
      charge(ctx, p, null, amount, 'card');
      break;
    }
    case 'pay_each':
      payEach(ctx, p, act.amount);
      break;
    case 'collect_each':
      collectEach(ctx, p, act.amount);
      break;
    default:
      log(ctx, `Unknown card action "${act.kind}" ignored.`);
  }
}

function stepsToNearest(from, tileType) {
  for (let steps = 1; steps <= BOARD_SIZE; steps++) {
    if (getTile((from + steps) % BOARD_SIZE).type === tileType) return steps;
  }
  return null;
}

function payEach(ctx, p, amount) {
  const others = activePlayers(ctx.s).filter((x) => x.id !== p.id);
  const total = amount * others.length;
  if (total <= 0) return;
  if (p.cash >= total) {
    for (const other of others) pay(ctx, p, other.id, amount, 'card');
    return;
  }
  startDebt(ctx, p, {
    toPlayerId: null, amount: total, reason: 'card',
    payees: others.map((other) => ({ playerId: other.id, amount })),
  });
}

/** Every other player pays `amount`; anyone short is auto-liquidated, then bankrupted to the collector. */
function collectEach(ctx, p, amount) {
  for (const other of activePlayers(ctx.s)) {
    if (other.id === p.id) continue;
    if (other.cash < amount) autoRaise(ctx, other, amount);
    if (other.cash >= amount) {
      other.cash -= amount;
      p.cash += amount;
      emit(ctx, 'collected', { playerId: p.id, fromPlayerId: other.id, amount, reason: 'card' });
      log(ctx, `${p.name} collected ${money(amount)} from ${other.name}.`);
    } else {
      log(ctx, `${other.name} cannot pay ${p.name} ${money(amount)}.`);
      goBankrupt(ctx, other, p.id);
      if (ctx.s.status !== 'active') return; // game over
    }
  }
}

// ---------------------------------------------------------------------------
// Payments & debt
// ---------------------------------------------------------------------------

/** Moves money without events: to a player, or to the bank (the pot for tax/card/fine when enabled). */
function transfer(ctx, payer, toPlayerId, amount, reason) {
  const { s } = ctx;
  payer.cash -= amount;
  const to = toPlayerId ? getPlayer(s, toPlayerId) : null;
  if (to && !to.bankrupt) to.cash += amount;
  else if (s.settings.freeParkingPot && POT_REASONS.has(reason)) s.pot += amount;
}

function recipientText(ctx, { toPlayerId, payees }) {
  if (payees) return ' to the other players';
  const to = toPlayerId ? getPlayer(ctx.s, toPlayerId) : null;
  return to ? ` to ${to.name}` : ' to the bank';
}

/** Immediate payment with the matching event (paid_rent / paid_tax / paid). */
function pay(ctx, payer, toPlayerId, amount, reason, tileIndex = null) {
  transfer(ctx, payer, toPlayerId, amount, reason);
  if (reason === 'rent') {
    emit(ctx, 'paid_rent', { playerId: payer.id, ownerId: toPlayerId, tileIndex, amount });
    log(ctx, `${payer.name} paid ${money(amount)} rent to ${getPlayer(ctx.s, toPlayerId).name} for ${tileName(tileIndex)}.`);
  } else if (reason === 'tax') {
    emit(ctx, 'paid_tax', { playerId: payer.id, tileIndex, amount });
    log(ctx, `${payer.name} paid ${money(amount)} ${tileName(tileIndex)}.`);
  } else {
    emit(ctx, 'paid', { playerId: payer.id, toPlayerId, amount, reason });
    log(ctx, `${payer.name} paid ${money(amount)}${recipientText(ctx, { toPlayerId })}.`);
  }
}

/**
 * Charges the (current) player. Pays immediately and returns true when affordable; otherwise
 * records turn.pendingDebt, switches to the paying phase and returns false.
 */
function charge(ctx, payer, toPlayerId, amount, reason, { tileIndex = null, then = null } = {}) {
  if (amount <= 0) return true;
  if (payer.cash >= amount) {
    pay(ctx, payer, toPlayerId, amount, reason, tileIndex);
    return true;
  }
  startDebt(ctx, payer, { toPlayerId, amount, reason, ...(then ? { then } : {}) });
  return false;
}

function startDebt(ctx, p, debt) {
  ctx.s.turn.pendingDebt = debt;
  ctx.s.turn.phase = 'paying';
  emit(ctx, 'debt_started', { playerId: p.id, toPlayerId: debt.toPlayerId, amount: debt.amount, reason: debt.reason });
  log(ctx, `${p.name} owes ${money(debt.amount)}${recipientText(ctx, debt)} but has only ${money(p.cash)}.`);
}

/** Who a debtor goes bankrupt to: the single player they owe, else (bank debts, payees debts) the bank. */
function debtCreditor(debt) {
  return debt && !debt.payees ? debt.toPlayerId : null;
}

/** How much of a pending debt is owed to `playerId` (0 without a debt). */
function debtShare(debt, playerId) {
  if (!debt) return 0;
  if (debt.payees) return debt.payees.filter((x) => x.playerId === playerId).reduce((sum, x) => sum + x.amount, 0);
  return debt.toPlayerId === playerId ? debt.amount : 0;
}

/** The pending debt is gone (paid or cancelled): run its continuation, else back to end_turn. */
function debtSettled(ctx, p, debt) {
  if (debt.then?.kind === 'jail_move') {
    leaveJailAndMove(ctx, p, debt.then.steps);
  } else {
    ctx.s.turn.phase = 'end_turn'; // rollAgain is preserved
  }
}

/**
 * A player the current player owes money to went bankrupt (they resigned): their share of the
 * pending debt is cancelled — it is not re-routed to the bank or the pot. Nothing is paid
 * automatically; if something is still owed the debtor stays in the paying phase.
 */
function cancelDebtShare(ctx, gone) {
  const t = ctx.s.turn;
  const debt = t.pendingDebt;
  const share = debtShare(debt, gone.id);
  if (share === 0) return;
  const debtor = getPlayer(ctx.s, currentPlayerId(ctx.s));
  if (debt.payees) debt.payees = debt.payees.filter((x) => x.playerId !== gone.id);
  debt.amount -= share;
  emit(ctx, 'debt_reduced', { playerId: debtor.id, amount: debt.amount });
  if (debt.amount > 0) {
    log(ctx, `${debtor.name} no longer owes ${gone.name} ${money(share)}; ${money(debt.amount)} is still due.`);
    return;
  }
  log(ctx, `${debtor.name} no longer owes ${gone.name} anything.`);
  t.pendingDebt = null;
  debtSettled(ctx, debtor, debt);
}

// ---------------------------------------------------------------------------
// Buildings & mortgages (shared by the handlers and autoRaise; callers have validated)
// ---------------------------------------------------------------------------

function buildOne(ctx, p, index) {
  const { s } = ctx;
  const tile = getTile(index);
  const ts = getTileState(s, index);
  p.cash -= tile.houseCost;
  if (ts.houses === 4) {
    s.bank.hotels -= 1;
    s.bank.houses += 4; // the four houses go back to the bank
  } else {
    s.bank.houses -= 1;
  }
  ts.houses += 1;
  emit(ctx, 'built', { playerId: p.id, tileIndex: index, houses: ts.houses });
  log(ctx, `${p.name} built ${ts.houses === 5 ? 'a hotel' : `house ${ts.houses}`} on ${tile.name} for ${money(tile.houseCost)}.`);
}

/**
 * Sells one building level. A hotel breaks back down into four houses — or, when the bank is short
 * of houses, into as many as it has (0–3), and every level that can't stay as a house is refunded too.
 */
function sellOne(ctx, p, index) {
  const { s } = ctx;
  const ts = getTileState(s, index);
  const before = ts.houses;
  if (before === 5) {
    const houses = Math.min(4, s.bank.houses);
    s.bank.hotels += 1;
    s.bank.houses -= houses;
    ts.houses = houses;
  } else {
    s.bank.houses += 1;
    ts.houses -= 1;
  }
  const amount = (before - ts.houses) * buildingRefund(index);
  p.cash += amount;
  emit(ctx, 'sold_house', { playerId: p.id, tileIndex: index, houses: ts.houses, amount });
  log(ctx, before - ts.houses > 1
    ? `${p.name} sold a hotel on ${tileName(index)} (bank short of houses) for ${money(amount)}.`
    : `${p.name} sold a building on ${tileName(index)} for ${money(amount)}.`);
}

function mortgageOne(ctx, p, index) {
  const { mortgage } = getTile(index);
  getTileState(ctx.s, index).mortgaged = true;
  p.cash += mortgage;
  emit(ctx, 'mortgaged', { playerId: p.id, tileIndex: index, amount: mortgage });
  log(ctx, `${p.name} mortgaged ${tileName(index)} for ${money(mortgage)}.`);
}

/**
 * Deterministic liquidation (CONTRACT §4.10), stopping as soon as cash ≥ target:
 * 0. if even full liquidation can't reach the target, do nothing — the caller bankrupts the player
 *    and the creditor gets the assets intact (liquidationValue is exact);
 * 1. mortgage tiles whose colour group has no buildings (railroads, utilities, unbuilt lots), ascending;
 * 2. sell one building level at a time from the tile with the most buildings (ties → lowest index;
 *    that tile is always the group's maximum, so the even-sell rule allows it);
 * 3. mortgage the remaining tiles (whose buildings are now gone), ascending.
 */
function autoRaise(ctx, p, target) {
  const { s } = ctx;
  if (liquidationValue(s, p.id) < target) return;
  const mortgageUnbuilt = () => { // canMortgage: owned, not mortgaged, no buildings in the group
    for (const ts of s.tiles) {
      if (p.cash >= target) return;
      if (ts.ownerId === p.id && canMortgage(s, p.id, ts.index).ok) mortgageOne(ctx, p, ts.index);
    }
  };
  mortgageUnbuilt();
  while (p.cash < target) {
    let best = null;
    for (const ts of s.tiles) {
      if (ts.ownerId === p.id && ts.houses > (best ? best.houses : 0)) best = ts;
    }
    if (!best) break;
    sellOne(ctx, p, best.index);
  }
  mortgageUnbuilt();
}

// ---------------------------------------------------------------------------
// Auctions (CONTRACT §4.12)
// ---------------------------------------------------------------------------

/** Every active player (in turn order, the decliner included) may bid; the current player stays current. */
function startAuction(ctx, tileIndex) {
  const { s } = ctx;
  const participants = activePlayers(s).map((p) => p.id);
  s.auction = { tileIndex, highBid: 0, highBidderId: null, bids: [], participants, passed: [] };
  s.turn.phase = 'auction';
  emit(ctx, 'auction_started', { tileIndex, participants: [...participants] });
  log(ctx, `${tileName(tileIndex)} is up for auction.`);
}

/** The auction is over once nobody but the high bidder (if any) is still in it. */
function checkAuctionEnd(ctx) {
  const { s } = ctx;
  const { participants, passed, highBidderId } = s.auction;
  const stillIn = participants.some((id) => id !== highBidderId && !passed.includes(id) && !getPlayer(s, id).bankrupt);
  if (!stillIn) closeAuction(ctx);
}

/** Ends the auction now: the high bidder pays the bank (never the pot) and gets the tile; no bids → unsold. */
function closeAuction(ctx) {
  const { s } = ctx;
  const { tileIndex, highBid, highBidderId } = s.auction;
  s.auction = null;
  s.turn.phase = 'end_turn'; // rollAgain is preserved
  if (highBidderId === null) {
    emit(ctx, 'auction_unsold', { tileIndex });
    log(ctx, `Nobody bid; ${tileName(tileIndex)} stays unowned.`);
    return;
  }
  const winner = getPlayer(s, highBidderId);
  winner.cash -= highBid;
  getTileState(s, tileIndex).ownerId = winner.id;
  emit(ctx, 'auction_won', { playerId: winner.id, tileIndex, amount: highBid });
  log(ctx, `${winner.name} won ${tileName(tileIndex)} at auction for ${money(highBid)}.`);
}

/** Calls the auction off without a sale (the current player resigned, or the game ended). */
function cancelAuction(ctx) {
  const { s } = ctx;
  const { tileIndex } = s.auction;
  s.auction = null;
  s.turn.phase = 'end_turn';
  emit(ctx, 'auction_unsold', { tileIndex });
  log(ctx, `The auction for ${tileName(tileIndex)} was called off; it stays unowned.`);
}

/**
 * A participant resigned (and is already bankrupt): they count as passed, and if they had the high
 * bid it falls back to the best bid by a player who is still in the auction (a player who passed
 * dropped out of it, so their old bid no longer counts). Then the auction may be over.
 */
function leaveAuction(ctx, p) {
  const { s } = ctx;
  const auction = s.auction;
  if (auction.participants.includes(p.id) && !auction.passed.includes(p.id)) {
    auction.passed.push(p.id);
    emit(ctx, 'auction_passed', { playerId: p.id });
  }
  if (auction.highBidderId === p.id) {
    // Bids by players still in only ever rise, so the latest one is the best.
    const best = auction.bids.findLast((b) => !auction.passed.includes(b.playerId) && !getPlayer(s, b.playerId).bankrupt);
    auction.highBid = best ? best.amount : 0;
    auction.highBidderId = best ? best.playerId : null;
    log(ctx, best
      ? `${getPlayer(s, best.playerId).name}'s bid of ${money(best.amount)} is the high bid again.`
      : 'There are no bids left in the auction.');
  }
  checkAuctionEnd(ctx);
}

// ---------------------------------------------------------------------------
// Trading (CONTRACT §4.13; validateTrade in rules.js)
// ---------------------------------------------------------------------------

function copySide(side) {
  return { cash: side.cash, tiles: [...side.tiles], jailCards: side.jailCards };
}

function tradeEvent(trade) {
  return {
    tradeId: trade.id, fromPlayerId: trade.fromPlayerId, toPlayerId: trade.toPlayerId,
    give: copySide(trade.give), get: copySide(trade.get),
  };
}

function describeSide({ cash, tiles, jailCards }) {
  const parts = [];
  if (cash > 0) parts.push(money(cash));
  for (const index of tiles) parts.push(tileName(index));
  if (jailCards > 0) parts.push(jailCards === 1 ? 'a Get Out of Jail Free card' : `${jailCards} Get Out of Jail Free cards`);
  if (parts.length === 0) return 'nothing';
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Hands over the giver's last `count` jail cards, keeping jailCards and getOutOfJailCards in sync. */
function moveJailCards(giver, receiver, count) {
  if (count <= 0) return;
  const cards = giver.jailCards.splice(giver.jailCards.length - count, count);
  receiver.jailCards.push(...cards);
  giver.getOutOfJailCards -= count;
  receiver.getOutOfJailCards += count;
}

/** Drops the pending trade and returns to the phase it interrupted. reason: "timeout" | "resigned". */
function cancelTrade(ctx, reason) {
  const { s } = ctx;
  const trade = s.trade;
  s.trade = null;
  s.turn.phase = trade.returnPhase;
  emit(ctx, 'trade_cancelled', { tradeId: trade.id, reason });
  log(ctx, `The trade offer from ${getPlayer(s, trade.fromPlayerId).name} to ${getPlayer(s, trade.toPlayerId).name} was called off.`);
}

// ---------------------------------------------------------------------------
// Bankruptcy & game over (CONTRACT §4.8)
// ---------------------------------------------------------------------------

/** reason: "resigned" (LEAVE) or "debt" (declared, TIMEOUT, or unable to pay a collect_each card). */
function goBankrupt(ctx, p, creditorId, reason = 'debt') {
  const { s } = ctx;
  const t = s.turn;
  const wasCurrent = currentPlayerId(s) === p.id;
  let creditor = creditorId ? getPlayer(s, creditorId) : null;
  if (creditor && (creditor.bankrupt || creditor.id === p.id)) creditor = null;
  const owned = s.tiles.filter((ts) => ts.ownerId === p.id);

  // 1. Every building goes back to the bank at half price.
  for (const ts of owned) {
    if (ts.houses === 0) continue;
    const amount = ts.houses * buildingRefund(ts.index);
    p.cash += amount;
    if (ts.houses === 5) s.bank.hotels += 1;
    else s.bank.houses += ts.houses;
    ts.houses = 0;
    emit(ctx, 'sold_house', { playerId: p.id, tileIndex: ts.index, houses: 0, amount });
  }
  const cash = p.cash; // goes to the creditor, or leaves the game with a bank bankruptcy

  // 2. Assets go to the creditor, or back to the bank.
  if (creditor) {
    creditor.cash += p.cash;
    for (const ts of owned) ts.ownerId = creditor.id;
    creditor.jailCards.push(...p.jailCards);
    creditor.getOutOfJailCards += p.jailCards.length;
  } else {
    for (const ts of owned) {
      ts.ownerId = null;
      ts.mortgaged = false;
    }
    // jail cards simply return to their decks: nobody holds them any more, so they are drawable again
  }

  // 3. The debtor is out.
  Object.assign(p, { bankrupt: true, cash: 0, jailCards: [], getOutOfJailCards: 0, inJail: false, jailTurns: 0 });
  if (wasCurrent) {
    t.pendingDebt = null;
    t.pendingPurchase = null;
  }
  emit(ctx, 'bankrupt', { playerId: p.id, toPlayerId: creditor ? creditor.id : null, cash, reason });
  log(ctx, `${p.name} is bankrupt${creditor ? `; everything goes to ${creditor.name}` : ''}.`);

  // 4. Game over, or pass the turn on, or (someone else's turn) cancel what the current player owed them.
  const remaining = activePlayers(s);
  if (remaining.length <= 1) endGame(ctx, remaining[0] ?? null);
  else if (wasCurrent) advanceTurn(ctx);
  else if (t.pendingDebt) cancelDebtShare(ctx, p);
}

/** Ends the game. turn.currentIndex has no meaning afterwards. */
function endGame(ctx, winner) {
  const { s } = ctx;
  if (s.auction) cancelAuction(ctx); // e.g. the only other bidder resigned
  s.trade = null; // unreachable: a pending trade always has two active parties
  emit(ctx, 'turn_ended', { playerId: currentPlayerId(s) }); // every turn_started gets its turn_ended
  s.status = 'finished';
  s.winnerId = winner ? winner.id : null;
  Object.assign(s.turn, { phase: 'game_over', rollAgain: false, pendingPurchase: null, pendingDebt: null });
  emit(ctx, 'game_over', { winnerId: s.winnerId });
  log(ctx, winner ? `${winner.name} wins the game!` : 'The game is over.');
}
