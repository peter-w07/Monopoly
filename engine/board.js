// Static board data, loaded from engine/data/board.json (frozen: the engine never mutates it).

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const OWNABLE_TYPES = new Set(['property', 'railroad', 'utility']);

export const BOARD = deepFreeze(require('./data/board.json'));
export const TILES = BOARD.tiles;
export const TOKENS = BOARD.tokens;

/** Sorted indices of all ownable tiles (property | railroad | utility). */
export const OWNABLE_INDICES = Object.freeze(
  TILES.filter((t) => OWNABLE_TYPES.has(t.type)).map((t) => t.index),
);

// group id → sorted list of property indices
const GROUPS = {};
for (const tile of TILES) {
  if (tile.type === 'property') (GROUPS[tile.group] ??= []).push(tile.index);
}

/** Static tile data, or null for an invalid index. */
export function getTile(index) {
  return TILES[index] ?? null;
}

export function isOwnable(index) {
  const tile = getTile(index);
  return tile !== null && OWNABLE_TYPES.has(tile.type);
}

/** Sorted tile indices of a colour group (a fresh array; empty for an unknown group). */
export function groupIndices(group) {
  return GROUPS[group] ? [...GROUPS[group]] : [];
}
