// Chance / Community Chest decks, loaded from engine/data/cards.json (frozen).

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const CARDS = deepFreeze(require('./data/cards.json'));

/** deck: "chance" | "community". Returns null for an unknown deck/id. */
export function getCard(deck, id) {
  return (deck === 'chance' || deck === 'community') ? CARDS[deck][id] ?? null : null;
}

const goojfId = (deck) => CARDS[deck].find((card) => card.action.kind === 'goojf')?.id ?? null;

/** Id of the Get Out of Jail Free card in each deck, derived from the data. */
export const GOOJF_ID = Object.freeze({ chance: goojfId('chance'), community: goojfId('community') });
