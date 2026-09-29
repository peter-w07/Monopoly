// public/r3d/layout.js — board geometry for the 3D renderer. Pure maths, no three.js, no DOM
// (so it can be unit-tested in Node).
//
// Units are the same as renderer2d.js: a side is 12 units (1.5 per corner + 9 × 1 per edge tile).
// "uv" = 2D board units, u → right, v → down (exactly the 2D layout and the board texture).
// World: the board lies in the XZ plane centred on the origin, top face at y = 0:
//   x = u - 6, z = v - 6. So +Z is the GO / Jail row ("bottom" in 2D) and +X the GO / Go-To-Jail column.

export const UNITS = 12;
export const HALF = UNITS / 2;
export const CORNER = 1.5;
export const BAND = 0.3; // colour band depth (inner edge of a property)
export const JAIL_STRIP = 0.46; // "just visiting" strip inside the jail corner
export const TOKEN_GAP = 0.5; // max distance between tokens sharing a spot
export const TILE_COUNT = 40;
export const SLAB_H = 0.26; // board thickness: top face at y = 0, the table at y = -SLAB_H

// The living centre (city.js, board-texture.js): a ring road around the dice plaza, with one
// district per colour group between the road and the tile ring. World units from the centre.
export const ROAD_R = 3.34; // centre line of the square ring road
export const ROAD_W = 0.26;
export const ROAD_CORNER = 0.45; // radius of the road's rounded corners
export const DISTRICT_IN = 3.5; // district strips span this..DISTRICT_OUT from the centre
export const DISTRICT_OUT = 4.38;
export const DISTRICT_SPAN = 3.25; // strips stay within ±this along their side (inner corners stay free)

/** Wraps any integer onto 0..39. */
export const wrap = (i) => ((Math.trunc(Number(i) || 0) % TILE_COUNT) + TILE_COUNT) % TILE_COUNT;

/** 0-based [column, row] of tile i: GO bottom-right, then clockwise (left along the bottom first). */
export function cellOf(i) {
  i = wrap(i);
  if (i <= 10) return [10 - i, 10];
  if (i <= 20) return [0, 20 - i];
  if (i <= 30) return [i - 20, 0];
  return [10, i - 30];
}

/** 'bottom' | 'left' | 'top' | 'right' | 'corner'. */
export function sideOf(i) {
  i = wrap(i);
  if (i % 10 === 0) return 'corner';
  return ['bottom', 'left', 'top', 'right'][Math.floor(i / 10)];
}

/** The side a tile belongs to for camera / facing purposes: a corner counts as the row it starts. */
export function rowOf(i) {
  return ['bottom', 'left', 'top', 'right'][Math.floor(wrap(i) / 10)];
}

const trackStart = (c) => (c === 0 ? 0 : CORNER + c - 1);
const trackSize = (c) => (c === 0 || c === 10 ? CORNER : 1);

/** Tile rectangle in uv units: { x, y, w, h }. */
export function tileRect(i) {
  const [c, r] = cellOf(i);
  return { x: trackStart(c), y: trackStart(r), w: trackSize(c), h: trackSize(r) };
}

/** The colour band of a property (on the tile's inner edge), in uv units. */
export function bandRect(i) {
  const a = tileRect(i);
  const side = sideOf(i);
  if (side === 'bottom') return { x: a.x, y: a.y, w: a.w, h: BAND };
  if (side === 'top') return { x: a.x, y: a.y + a.h - BAND, w: a.w, h: BAND };
  if (side === 'left') return { x: a.x + a.w - BAND, y: a.y, w: BAND, h: a.h };
  if (side === 'right') return { x: a.x, y: a.y, w: BAND, h: a.h };
  return a;
}

/** Where tokens may stand on a tile: the tile minus its colour band. */
export function tokenArea(i) {
  const a = tileRect(i);
  const side = sideOf(i);
  if (side === 'bottom') { a.y += BAND; a.h -= BAND; }
  if (side === 'top') a.h -= BAND;
  if (side === 'left') a.w -= BAND;
  if (side === 'right') { a.x += BAND; a.w -= BAND; }
  return a;
}

/** The jail cell (bottom-left corner, toward the board centre). Visitors use the L-shaped outer strip. */
export const JAIL_CELL = { x: JAIL_STRIP, y: UNITS - CORNER, w: CORNER - JAIL_STRIP, h: CORNER - JAIL_STRIP };

/** Lays n tokens out in the grid that keeps them furthest apart inside `area`, clustered at its centre. */
export function gridSlot(area, k, n) {
  let cols = 1;
  let best = 0;
  for (let c = 1; c <= n; c++) {
    const size = Math.min(area.w / c, area.h / Math.ceil(n / c));
    if (size > best + 1e-6) { best = size; cols = c; }
  }
  const rows = Math.ceil(n / cols);
  const row = Math.floor(k / cols);
  const inRow = row === rows - 1 ? n - row * cols : cols;
  const dx = Math.min(area.w / cols, TOKEN_GAP);
  const dy = Math.min(area.h / rows, TOKEN_GAP);
  return [
    area.x + area.w / 2 + ((k % cols) - (inRow - 1) / 2) * dx,
    area.y + area.h / 2 + (row - (rows - 1) / 2) * dy,
  ];
}

/** Visitors fill the jail corner's L-shaped outer strip, from the corner outward. */
export function visitingSlot(k, n) {
  const cx = JAIL_STRIP / 2;
  const cy = UNITS - JAIL_STRIP / 2;
  if (k === 0) return [cx, cy];
  const perArm = Math.ceil((n - 1) / 2);
  const gap = Math.min(TOKEN_GAP, (CORNER - JAIL_STRIP) / perArm);
  const d = Math.ceil(k / 2) * gap;
  return k % 2 ? [cx, cy - d] : [cx + d, cy];
}

/** A token spot: a tile, plus whether it is inside the jail cell (only meaningful on the jail tile). */
export function makeSpot(index, jailed, jailIndex = 10) {
  const i = wrap(index);
  return { index: i, jailed: !!jailed && i === jailIndex };
}

export const spotKey = (s) => (s.jailed ? `${s.index}j` : `${s.index}`);

/** uv centre of the k-th of n tokens sharing `spot`. */
export function slotUV(spot, k = 0, n = 1, jailIndex = 10) {
  if (spot.index === jailIndex && jailIndex === 10) return spot.jailed ? gridSlot(JAIL_CELL, k, n) : visitingSlot(k, n);
  return gridSlot(tokenArea(spot.index), k, n);
}

/** uv → world {x, z}. */
export const toWorld = (u, v) => ({ x: u - HALF, z: v - HALF });

/** World {x, z} of the k-th of n tokens on `spot`. */
export function slotWorld(spot, k = 0, n = 1, jailIndex = 10) {
  const [u, v] = slotUV(spot, k, n, jailIndex);
  return toWorld(u, v);
}

/** World {x, z} of a tile's centre. */
export function tileCenter(i) {
  const r = tileRect(i);
  return toWorld(r.x + r.w / 2, r.y + r.h / 2);
}

/** Unit vector (world x, z) pointing from the board centre out through the tile's edge. */
export function outward(i) {
  const side = sideOf(i);
  if (side === 'bottom') return { x: 0, z: 1 };
  if (side === 'top') return { x: 0, z: -1 };
  if (side === 'left') return { x: -1, z: 0 };
  if (side === 'right') return { x: 1, z: 0 };
  const c = tileCenter(i);
  const len = Math.hypot(c.x, c.z) || 1;
  return { x: c.x / len, z: c.z / len };
}

/** Direction of travel (world x, z) along the row a tile starts: tokens move clockwise. */
export function travelDir(i) {
  const row = rowOf(i);
  if (row === 'bottom') return { x: -1, z: 0 };
  if (row === 'left') return { x: 0, z: -1 };
  if (row === 'top') return { x: 1, z: 0 };
  return { x: 0, z: 1 };
}

/**
 * Camera yaw (radians about +Y) that looks at the board from outside a side, so that side's tile
 * text reads upright. Camera offset = (sin yaw, ·, cos yaw): yaw 0 = from +Z (the GO row).
 */
export const SIDE_YAW = { bottom: 0, left: -Math.PI / 2, top: Math.PI, right: Math.PI / 2 };

/** Rotation (about +Y) that turns a tile-local frame (x along the row, +z outward) onto its side. */
export const SIDE_ROT = { bottom: 0, left: -Math.PI / 2, top: Math.PI, right: Math.PI / 2 };

/**
 * Chance / Community Chest card piles in the centre (uv centre, size, rotation in radians — canvas
 * convention: positive = clockwise when looking down on the board).
 */
export const DECK_SPOTS = {
  community: { u: 3.95, v: 3.95, w: 1.9, h: 1.2, rot: -Math.PI / 4 },
  chance: { u: 8.05, v: 8.05, w: 1.9, h: 1.2, rot: -Math.PI / 4 },
};

/**
 * Tile index under a board point in uv units, or null (off the board / the centre).
 * Inverse of tileRect: tileAt(centre of tileRect(i)) === i.
 */
export function tileAt(u, v) {
  if (!(u >= 0 && u <= UNITS && v >= 0 && v <= UNITS)) return null;
  const cell = (x) => (x < CORNER ? 0 : x >= UNITS - CORNER ? 10 : 1 + Math.min(8, Math.floor(x - CORNER)));
  const c = cell(u);
  const r = cell(v);
  if (r === 10) return 10 - c;
  if (c === 0) return 20 - r;
  if (r === 0) return 20 + c;
  if (c === 10) return 30 + r;
  return null; // centre
}

/**
 * One district per colour group, just inside its tiles, in world units:
 * { group, color, tiles, side, out: {x,z} (unit vector to the tiles), along: {x,z} (travel direction),
 *   a0, a1 (extent along `along`, measured on the axis), depth range DISTRICT_IN..DISTRICT_OUT }.
 * @param {object} board parsed board.json
 */
export function districts(board) {
  const groups = board?.groups ?? {};
  const out = [];
  for (const [group, info] of Object.entries(groups)) {
    const tiles = (board.tiles ?? []).filter((t) => t.type === 'property' && t.group === group).map((t) => t.index);
    if (!tiles.length) continue;
    const side = sideOf(tiles[0]);
    if (side === 'corner' || tiles.some((i) => sideOf(i) !== side)) continue;
    const o = outward(tiles[0]);
    const horizontal = side === 'bottom' || side === 'top';
    const pos = tiles.map((i) => (horizontal ? tileCenter(i).x : tileCenter(i).z));
    const a0 = Math.max(-DISTRICT_SPAN, Math.min(...pos) - 0.45);
    const a1 = Math.min(DISTRICT_SPAN, Math.max(...pos) + 0.45);
    if (a1 - a0 < 0.3) continue;
    out.push({ group, color: info?.color ?? '#999999', tiles, side, out: o, horizontal, a0, a1 });
  }
  return out;
}

/** World {x, z} of a point in a district: `a` along its side axis, `r` distance from the centre. */
export function districtPoint(d, a, r) {
  return d.horizontal ? { x: a, z: d.out.z * r } : { x: d.out.x * r, z: a };
}

/** Signed shortest angle from a to b. */
export function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
