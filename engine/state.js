// Game creation and settings normalisation.

import { BOARD, OWNABLE_INDICES } from './board.js';
import { CARDS } from './cards.js';
import { makeRng, shuffle } from './rng.js';

export const DEFAULT_SETTINGS = Object.freeze({
  maxPlayers: 6,
  startingCash: 1500,
  turnTimeoutSec: 90,
  freeParkingPot: false,
  auctionOnDecline: true,
  evenBuild: true,
});

function toInt(value, fallback, min, max) {
  const n = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function toBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return !['', '0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function toTimeout(value, fallback) {
  const n = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return fallback;
  return n <= 0 ? 0 : toInt(n, fallback, 10, 3600); // 0 = no turn timer
}

/** Merges a partial settings object with the defaults and clamps every field. Unknown keys are dropped. */
export function normalizeSettings(partial) {
  const src = partial && typeof partial === 'object' ? partial : {};
  const d = DEFAULT_SETTINGS;
  return {
    maxPlayers: toInt(src.maxPlayers, d.maxPlayers, 2, 8),
    startingCash: toInt(src.startingCash, d.startingCash, 100, 100000),
    turnTimeoutSec: toTimeout(src.turnTimeoutSec, d.turnTimeoutSec),
    freeParkingPot: toBool(src.freeParkingPot, d.freeParkingPot),
    auctionOnDecline: toBool(src.auctionOnDecline, d.auctionOnDecline),
    evenBuild: toBool(src.evenBuild, d.evenBuild),
  };
}

/** Fresh lobby state (CONTRACT §3). Both decks are shuffled here with the game's RNG (chance first). */
export function createGame({ id = null, seed = 0, settings } = {}) {
  const rng = makeRng(seed);
  const deckIds = (deck) => CARDS[deck].map((card) => card.id);
  const chanceOrder = shuffle(rng, deckIds('chance'));
  const communityOrder = shuffle(rng, deckIds('community'));

  return {
    version: 1,
    id,
    createdAt: 0,
    updatedAt: 0,
    status: 'lobby',
    seq: 0,
    hostId: null,
    winnerId: null,
    pot: 0,
    settings: normalizeSettings(settings),
    rng,
    players: [],
    turn: {
      order: [],
      currentIndex: 0,
      phase: 'lobby',
      number: 0,
      doublesCount: 0,
      rollAgain: false,
      lastRoll: null,
      pendingPurchase: null,
      pendingDebt: null,
      tradesProposed: 0,
      deadlineAt: null,
    },
    tiles: OWNABLE_INDICES.map((index) => ({ index, ownerId: null, houses: 0, mortgaged: false })),
    bank: { houses: BOARD.bankHouses, hotels: BOARD.bankHotels },
    decks: {
      chance: { order: chanceOrder, pos: 0 },
      community: { order: communityOrder, pos: 0 },
    },
    auction: null,
    trade: null,
    log: [],
  };
}
