// public/r3d/lot-styles.js — what stands on every lot of Loop City, as pure data (no three.js, no DOM).
//
// The single source of truth for lane B's buildings (city-design §5, §6): city-lots.js and landmarks.js
// build their meshes FROM these plans, and test/lot-kit.test.js checks the same plans against the
// occlusion rule (§3.10, `laneClear`), the side caps and the lot rectangles. Everything is in metres.
//
//   LOT_STYLES[group]   the eight neighbourhoods (§6.2): palette, units or tiers, heights per level 0..5,
//                        front faces per level, the landmark hotel, L0 kit, flourish, ambience bed
//   STATION_STYLES, UTILITY_STYLES, SPECIAL_STYLES, CORNER_STYLES   the other lots (§5)
//   planLot(tile, level) → structures in the lot's local frame (a = along, d = distance from the centre)
//   planSite(tile)       → structures of a special lot / corner site / reserved zone in world coordinates
//   structures()         → every structure of every tile and level: { tile, level, part, height, frontFace,
//                          footprint: { minX, maxX, minZ, maxZ }, thin, zone }
//   heightOf(group, level)
//
// Lot frame (§2): a lot group with rotation.y = lot.yaw has local +z toward the street and local +x along
// it; a local point (lx, lz) is (a, 156 − d) where d is the distance from the city centre (front of the
// lot at d = 139, back at 173). Heights are WORLD tops (road y = 0; the lot ground is at LOT_BASE).

import { address, M } from './city-layout.js';

export const LOT_BASE = 0.15; // lot ground = kerb / sidewalk level
export const STOREY = Object.freeze({ residential: 3.2, retail: 4.2, office: 3.6 });
/** The four unit slots (§3.4): 6 m wide, 2/3 m gaps → exactly 26 m; centres along the lot. */
export const UNIT_W = 6;
export const UNIT_GAP = 2 / 3;
export const UNIT_SLOTS = Object.freeze([0, 1, 2, 3].map((k) => -13 + UNIT_W / 2 + k * (UNIT_W + UNIT_GAP)));
/** Which slot each house fills: middle pair first, then the ends. */
export const UNIT_ORDER = Object.freeze([1, 2, 0, 3]);
export const UNIT_FRONT = 148.2; // street face of the unit band buildings (the forecourt keeps a 9 m roundel)
export const LOT_CENTRE_D = 156;
export const FLAG_SPOT = Object.freeze({ a: 11.6, d: 140.4, h: 8 }); // owner flagpole in the forecourt
export const SIGN_SPOT = Object.freeze({ a: -10.5, d: 140.2 });     // estate-agent sign
export const POST_D = M.POST; // 134.8: address post on the outer sidewalk (lane A keeps it free)

/** Facade atlas cells (lot-kit draws them; 16 columns × 2 row-pairs). */
export const FACADE = Object.freeze({
  COTTAGE: 0, TOWN: 1, SHOP: 2, BROWNSTONE: 3, DECO: 4, GLASS: 5, VILLA: 6, HOTEL: 7, VACANT: 8, BOARDED: 9,
  ROOF: 10, CIVIC: 11, STATION: 12, STONE: 13, INDUSTRIAL: 14, BRICK: 15,
  DECOHOTEL: 16, GLASSHOTEL: 17, STONEHOTEL: 18, INN: 19, STORE: 20, PAVILION: 21, POLICE: 22, BANK: 23,
});

const r3 = (v) => Math.round(v * 1000) / 1000;

// ---- the eight neighbourhoods ---------------------------------------------------------------------
//
// unit: { depth, body, ground, storey, roof: variant name, roofH, facade, decor } — one building per house.
// tiers: { storeys: [n0, +n1, +n2, +n3], ground, storey, shrink } — one 22 × 20 building, each house adds
//        a setback tier (footprint shrinks by `shrink` m in both directions per tier).
// hotel: { name, frontFace, parts: [...] } — explicit boxes (local a, d, w, y); `height` is derived.

const GROUP_ORDER = ['brown', 'lightblue', 'pink', 'orange', 'red', 'yellow', 'green', 'darkblue'];

const HOTELS = {
  // Brown — The Railway Arms: 5-storey brick pub-hotel with a clock gable on the street front.
  brown: {
    name: 'The Railway Arms', facade: FACADE.INN, top: 'railwayArms', frontFace: 145,
    parts: [
      { role: 'body', a: 0, w: 22, d0: 145, d1: 159, y1: 12.95, storey: 3.2, ground: 3.2 },
      { role: 'roof', variant: 'mansardFlat', a: 0, w: 22, d0: 145, d1: 159, y0: 12.95, y1: 16.2 },
      { role: 'top', a: 0, w: 7, d0: 145, d1: 147.5, y0: 12.95, y1: 17.0 },
    ],
    roundel: { a: 0, d: 153, roof: true, y: 16.2, size: 9 },
  },
  // Light blue — Old Town Inn: 6 storeys, slate mansard and a tall clock gable (front face exactly 147).
  lightblue: {
    name: 'Old Town Inn', facade: FACADE.INN, top: 'oldTownInn', frontFace: 147,
    parts: [
      { role: 'body', a: 0, w: 22, d0: 147, d1: 161, y1: 19.35, storey: 3.2, ground: 3.2 },
      { role: 'roof', variant: 'mansardFlat', a: 0, w: 22, d0: 147, d1: 161, y0: 19.35, y1: 22.0 },
      { role: 'top', a: 0, w: 6, d0: 147, d1: 149.5, y0: 19.35, y1: 24.0 },
    ],
    roundel: { a: 0, d: 155, roof: true, y: 22.0, size: 9 },
  },
  // Pink — The Emporium: 8-storey department store with a copper corner dome.
  pink: {
    name: 'The Emporium', facade: FACADE.STORE, top: 'emporium', frontFace: 153,
    parts: [
      { role: 'body', a: 0, w: 22, d0: 153, d1: 173, y1: 29.55, storey: 3.6, ground: 4.2 },
      { role: 'roof', variant: 'flat', a: 0, w: 22, d0: 153, d1: 173, y0: 29.55, y1: 30.0 },
      { role: 'top', a: -7.5, w: 7, d0: 153.5, d1: 160.5, y0: 29.55, y1: 34.0 },
    ],
    roundel: { a: 3.5, d: 164, roof: true, size: 12 },
  },
  // Orange — Rotunda Grand: 10-storey Beaux-Arts block crowned by a colonnaded rotunda and dome.
  orange: {
    name: 'Rotunda Grand', facade: FACADE.STONEHOTEL, top: 'rotunda', frontFace: 156,
    parts: [
      { role: 'body', a: 0, w: 22, d0: 156, d1: 173, y1: 33.15, storey: 3.2, ground: 4.2 },
      { role: 'roof', variant: 'balustrade', a: 0, w: 22, d0: 156, d1: 173, y0: 33.15, y1: 33.5 },
      { role: 'top', a: 0, w: 9.4, d0: 161.8, d1: 171.2, y0: 33.15, y1: 40.0 },
    ],
    roundel: { a: 0, d: 147.5, roof: false, size: 11 },
  },
  // Red — Marquee Tower: 15-storey art-deco setback tower with a vertical neon blade.
  red: {
    name: 'Marquee Tower', facade: FACADE.DECOHOTEL, top: 'marqueeTower', frontFace: 153,
    parts: [
      { role: 'body', a: 0, w: 22, d0: 153, d1: 173, y1: 33.15, storey: 3.6, ground: 4.2 },
      { role: 'roof', variant: 'flat', a: 0, w: 22, d0: 153, d1: 173, y0: 33.15, y1: 33.6 },
      { role: 'body', a: 0, w: 16, d0: 156, d1: 170, y0: 33.15, y1: 47.55, storey: 3.6, ground: 3.6 },
      { role: 'roof', variant: 'flat', a: 0, w: 16, d0: 156, d1: 170, y0: 47.55, y1: 48.0 },
      { role: 'body', a: 0, w: 10, d0: 158.5, d1: 167.5, y0: 47.55, y1: 58.35, storey: 3.6, ground: 3.6 },
      { role: 'top', a: 0, w: 10, d0: 158, d1: 167, y0: 58.35, y1: 64.0 },
      { role: 'top', variant: 'marqueeBlade', a: 0, w: 1.4, d0: 154.6, d1: 156, y0: 36, y1: 60.25 },
    ],
    roundel: { a: 0, d: 146, roof: false, size: 10 },
  },
  // Yellow — The Helix: a twisting glass tower (5 rotated segments) with a helipad.
  yellow: {
    name: 'The Helix', facade: FACADE.GLASSHOTEL, top: 'helix', frontFace: 153,
    parts: [
      { role: 'body', a: 0, w: 22, d0: 153, d1: 173, y1: 7.95, storey: 3.6, ground: 4.2 },
      { role: 'roof', variant: 'flat', a: 0, w: 22, d0: 153, d1: 173, y0: 7.95, y1: 8.4 },
      ...[0, 1, 2, 3, 4].map((k) => ({ role: 'body', a: 0, w: 14, d0: 156, d1: 170, y0: r3(7.95 + 18 * k), y1: r3(7.95 + 18 * (k + 1)), rot: (k * 9 * Math.PI) / 180, storey: 3.6, ground: 3.6 })),
      { role: 'top', a: 0, w: 13.6, d0: 156.2, d1: 169.8, y0: 97.95, y1: 104.0, rot: (45 * Math.PI) / 180 },
    ],
    roundel: { a: 0, d: 163, roof: true, y: 100.2, size: 11 },
  },
  // Green — Exchange Tower: 32 storeys of stone and glass with a gilded crown.
  green: {
    name: 'Exchange Tower', facade: FACADE.STONEHOTEL, top: 'exchange', frontFace: 153,
    parts: [
      { role: 'body', a: 0, w: 22, d0: 153, d1: 173, y1: 11.55, storey: 3.6, ground: 4.2 },
      { role: 'roof', variant: 'flat', a: 0, w: 22, d0: 153, d1: 173, y0: 11.55, y1: 12.0 },
      { role: 'body', a: 0, w: 18, d0: 155, d1: 171, y0: 11.55, y1: 83.55, storey: 3.6, ground: 3.6 },
      { role: 'roof', variant: 'flat', a: 0, w: 18, d0: 155, d1: 171, y0: 83.55, y1: 84.0 },
      { role: 'body', a: 0, w: 14, d0: 157, d1: 169, y0: 83.55, y1: 112.35, storey: 3.6, ground: 3.6 },
      { role: 'top', a: 0, w: 14, d0: 157, d1: 169, y0: 112.35, y1: 134.0 },
    ],
    roundel: { a: 0, d: 145.5, roof: false, size: 10 },
  },
  // Dark blue — Harbour Spire: 47 storeys, three setbacks, crown and spire: the city's peak.
  darkblue: {
    name: 'Harbour Spire', facade: FACADE.GLASSHOTEL, top: 'spire', frontFace: 153,
    parts: [
      { role: 'body', a: 0, w: 22, d0: 153, d1: 173, y1: 7.95, storey: 3.6, ground: 4.2 },
      { role: 'roof', variant: 'flat', a: 0, w: 22, d0: 153, d1: 173, y0: 7.95, y1: 8.4 },
      { role: 'body', a: 0, w: 18, d0: 155, d1: 171, y0: 7.95, y1: 101.55, storey: 3.6, ground: 3.6 },
      { role: 'roof', variant: 'flat', a: 0, w: 18, d0: 155, d1: 171, y0: 101.55, y1: 102.0 },
      { role: 'body', a: 0, w: 15, d0: 156.5, d1: 169.5, y0: 101.55, y1: 144.75, storey: 3.6, ground: 3.6 },
      { role: 'roof', variant: 'flat', a: 0, w: 15, d0: 156.5, d1: 169.5, y0: 144.75, y1: 145.2 },
      { role: 'body', a: 0, w: 11, d0: 158.5, d1: 167.5, y0: 144.75, y1: 169.95, storey: 3.6, ground: 3.6 },
      { role: 'top', a: 0, w: 11, d0: 158.5, d1: 167.5, y0: 169.95, y1: 195.0 },
    ],
    roundel: { a: 0, d: 145.5, roof: false, size: 10 },
  },
};

export const LOT_STYLES = {
  brown: {
    name: 'Brickworks Row', side: 'south', kind: 'units', bed: 'suburbs', flourish: 'barbecue',
    palette: { walls: ['#9a5440', '#efe4cf', '#8a4b36', '#d9c9a8'], trim: '#f4ecdc', roof: '#4a4f57', accent: '#c8a165', ground: 'lawn' },
    unit: { depth: 9, body: 4.6, ground: 3.2, storey: 3.2, roof: 'gable', roofH: 2.1, facade: FACADE.COTTAGE, decor: 'cottage', top: 7.5 },
    kit: { name: 'cottageGarden', height: 2.75 },
    level0Ground: 'lawn',
  },
  lightblue: {
    name: 'Old Town', side: 'south', kind: 'units', bed: 'oldtown', flourish: 'balloons',
    palette: { walls: ['#9fd4e8', '#f3e28a', '#f2b8c6', '#f7f4ee'], trim: '#ffffff', roof: '#5b6670', accent: '#e05a5a', ground: 'cobble' },
    unit: { depth: 10, body: 9.6, ground: 3.2, storey: 3.2, roof: 'frontGable', roofH: 1.25, facade: FACADE.TOWN, decor: 'oldTown', top: 11.0 },
    kit: { name: 'pocketSquare', height: 2.95 },
    level0Ground: 'cobble',
  },
  pink: {
    name: 'Market Lanes', side: 'west', kind: 'units', bed: 'market', flourish: 'petals',
    palette: { walls: ['#d9643a', '#9bb08a', '#efe2c4', '#c9573a'], trim: '#f6efe2', roof: '#5a5e63', accent: '#2f6b4f', ground: 'paving' },
    unit: { depth: 11, body: 10.6, ground: 4.2, storey: 3.2, roof: 'mansard', roofH: 1.75, facade: FACADE.SHOP, decor: 'shopHouse', top: 12.5 },
    kit: { name: 'marketTents', height: 4.15 },
    level0Ground: 'paving',
  },
  orange: {
    name: 'Midtown Brownstones', side: 'west', kind: 'units', bed: 'midtown', flourish: 'lanterns',
    palette: { walls: ['#7b4a36', '#8a5640', '#e7c15a', '#6e4232'], trim: '#e9dcc6', roof: '#3d3a38', accent: '#1f1f1f', ground: 'lawn' },
    unit: { depth: 12, body: 16.0, ground: 3.2, storey: 3.2, roof: 'cornice', roofH: 0.85, facade: FACADE.BROWNSTONE, decor: 'brownstone', top: 17.0 },
    kit: { name: 'cafeGarden', height: 3.15 },
    level0Ground: 'lawn',
  },
  red: {
    name: 'Theatre Row', side: 'north', kind: 'units', bed: 'theatre', flourish: 'marquees',
    palette: { walls: ['#c23b2e', '#f2e6d0', '#a8322a', '#e9d8b8'], trim: '#d8b25a', roof: '#8d8f91', accent: '#d8b25a', ground: 'plaza' },
    unit: { depth: 12, body: 22.2, ground: 4.2, storey: 3.6, roof: 'flat', roofH: 0.65, facade: FACADE.DECO, decor: 'theatre', top: 23.0 },
    kit: { name: 'foodTrucks', height: 4.65 },
    level0Ground: 'plaza',
  },
  yellow: {
    name: 'Downtown', side: 'north', kind: 'tiers', bed: 'downtown', flourish: 'rooftopLetters',
    palette: { walls: ['#9cc7e8', '#a9d0ee', '#8fbcdf', '#b3d6f0'], trim: '#ffffff', roof: '#c9cdd1', accent: '#d8b25a', ground: 'plaza' },
    tiers: { storeys: [4, 3, 3, 3], ground: 4.2, storey: 3.6, shrink: 3, w0: 22, d0: 20, parapet: 0.85, facade: FACADE.GLASS, decor: 'downtownPodium' },
    kit: { name: 'popUpPavilion', height: 6.15 },
    level0Ground: 'plaza',
  },
  green: {
    name: 'Bank Quarter', side: 'east', kind: 'tiers', bed: 'bank', flourish: 'tickerTape',
    palette: { walls: ['#e9e0cf', '#e3d8c4', '#efe7d8', '#ddd2bd'], trim: '#8a6a3a', roof: '#c8c2b4', accent: '#1f5a3a', ground: 'paving' },
    tiers: { storeys: [6, 3, 3, 3], ground: 4.2, storey: 3.6, shrink: 3, w0: 22, d0: 20, parapet: 0.65, facade: FACADE.STONE, decor: 'bankPodium' },
    kit: { name: 'sculpturePlaza', height: 4.65 },
    level0Ground: 'paving',
  },
  darkblue: {
    name: 'Harbour Heights', side: 'east', kind: 'units', bed: 'harbourHeights', flourish: 'poolJets',
    palette: { walls: ['#f7f7f5', '#eef3f2', '#f3f0ea', '#e9f1f4'], trim: '#1d3557', roof: '#d9d4c7', accent: '#8a6a4a', ground: 'lawn' },
    unit: { depth: 11, body: 10.8, ground: 3.6, storey: 3.6, roof: 'villaTerrace', roofH: 1.05, facade: FACADE.VILLA, decor: 'villa', top: 12.0 },
    kit: { name: 'poolGarden', height: 7.15 },
    level0Ground: 'lawn',
  },
};
for (const g of GROUP_ORDER) LOT_STYLES[g].hotel = HOTELS[g];

/** The style of a group (unknown group names fall back by board order). */
export function styleOf(group, index = 0) {
  return LOT_STYLES[group] ?? LOT_STYLES[GROUP_ORDER[((index % 8) + 8) % 8]];
}

// ---- stations, utilities, special lots, corners ---------------------------------------------------

/** Circle Line stations on lots 5, 15, 25, 35 (local plans; unowned = the same building, shabby). */
export const STATION_STYLES = {
  5: {
    name: 'Reading Terminus', short: 'Reading', style: 'victorian', facade: FACADE.STATION, wall: '#a8452f', trim: '#e6dccb', roofColor: '#4d535a',
    parts: [
      { role: 'body', a: 2, w: 20, d0: 147, d1: 161, y1: 7.95, storey: 3.6, ground: 4.2 },
      { role: 'roof', variant: 'hip', a: 2, w: 20, d0: 147, d1: 161, y0: 7.95, y1: 10.95 },
      { role: 'body', a: -10, w: 5, d0: 147, d1: 152, y1: 19.0, storey: 3.6, ground: 4.2 },
      { role: 'top', variant: 'clockTower', a: -10, w: 5.6, d0: 147, d1: 152.6, y0: 19.0, y1: 24.0 },
      { role: 'canopy', a: 2, w: 12, d0: 144.6, d1: 147, y0: 3.4, y1: 3.9 },
    ],
  },
  15: {
    name: 'Pennsylvania Hall', short: 'Pennsylvania', style: 'beauxArts', facade: FACADE.CIVIC, wall: '#e9e0cf', trim: '#f5efe2', roofColor: '#8b9a97',
    parts: [
      { role: 'body', a: 0, w: 24, d0: 147, d1: 163, y1: 12.15, storey: 3.6, ground: 4.2 },
      { role: 'roof', variant: 'balustrade', a: 0, w: 24, d0: 147, d1: 163, y0: 12.15, y1: 13.0 },
      { role: 'top', variant: 'portico', a: 0, w: 16, d0: 143, d1: 147, y0: 0.15, y1: 14.0 },
      { role: 'top', variant: 'attic', a: 0, w: 10, d0: 149, d1: 159, y0: 12.15, y1: 18.0 },
      { role: 'canopy', a: 0, w: 14, d0: 141.6, d1: 143, y0: 3.6, y1: 4.0 },
    ],
  },
  25: {
    name: 'B. & O. Central', short: 'B. & O.', style: 'deco', facade: FACADE.DECO, wall: '#d9cdb2', trim: '#b68a3e', roofColor: '#9a9c9e',
    parts: [
      { role: 'body', a: 0, w: 24, d0: 147, d1: 163, y1: 12.15, storey: 3.6, ground: 4.2 },
      { role: 'roof', variant: 'flat', a: 0, w: 24, d0: 147, d1: 163, y0: 12.15, y1: 12.7 },
      { role: 'body', a: 0, w: 8, d0: 147, d1: 153, y0: 12.15, y1: 21.0, storey: 3.6, ground: 3.6 },
      { role: 'top', variant: 'decoFin', a: 0, w: 8.4, d0: 146.4, d1: 153, y0: 12.15, y1: 24.0 },
      { role: 'canopy', a: 0, w: 14, d0: 144.6, d1: 147, y0: 3.8, y1: 4.2 },
    ],
  },
  35: {
    name: 'Short Line Metro', short: 'Short Line', style: 'metro', facade: FACADE.PAVILION, wall: '#cfe3ea', trim: '#3d4a52', roofColor: '#3d4a52',
    parts: [
      { role: 'body', a: 0, w: 18, d0: 151, d1: 161, y1: 6.95, storey: 3.4, ground: 3.4 },
      { role: 'top', variant: 'metroRoof', a: 0, w: 21, d0: 148.6, d1: 162.4, y0: 6.95, y1: 8.0 },
      { role: 'canopy', a: 0, w: 10, d0: 148.6, d1: 151, y0: 3.2, y1: 3.6 },
    ],
  },
};

/** Utilities on lots 12 (Electric Company) and 28 (Water Works). */
export const UTILITY_STYLES = {
  12: {
    name: 'Electric Company', kind: 'electric', facade: FACADE.BRICK, wall: '#9c4e3a', trim: '#e9dcc6', roofColor: '#4d535a',
    parts: [
      { role: 'body', a: 0, w: 22, d0: 148, d1: 162, y1: 11.55, storey: 3.6, ground: 4.2 },
      { role: 'roof', variant: 'flat', a: 0, w: 22, d0: 148, d1: 162, y0: 11.55, y1: 12.0 },
      { role: 'top', variant: 'bulbSign', a: 0, w: 9, d0: 152, d1: 156, y0: 11.55, y1: 20.0 },
      { role: 'canopy', a: 0, w: 8, d0: 146, d1: 148, y0: 3.4, y1: 3.8 },
    ],
  },
  28: {
    name: 'Water Works', kind: 'water', facade: FACADE.INDUSTRIAL, wall: '#a65a42', trim: '#efe3cc', roofColor: '#5a6168',
    parts: [
      { role: 'body', a: -3, w: 18, d0: 149, d1: 161, y1: 10.15, storey: 5, ground: 5 },
      { role: 'roof', variant: 'gable', a: -3, w: 18, d0: 149, d1: 161, y0: 10.15, y1: 14.0 },
      { role: 'top', variant: 'waterTower', a: 7.5, w: 9.4, d0: 161.6, d1: 171, y0: 0.15, y1: 35.0 },
      { role: 'top', variant: 'fountain', a: -3, w: 6, d0: 141, d1: 147, y0: 0.15, y1: 1.4 },
      { role: 'canopy', a: -3, w: 6, d0: 147.4, d1: 149, y0: 3.2, y1: 3.6 },
    ],
  },
};

/** Chance kiosks, Community Halls, the Revenue Office and the Jeweller (landmarks.js builds them). */
export const SPECIAL_STYLES = {
  2: { kind: 'hall', name: 'Community Hall', sign: 'COMMUNITY HALL' },
  17: { kind: 'hall', name: 'Community Hall', sign: 'COMMUNITY HALL' },
  33: { kind: 'hall', name: 'Community Hall', sign: 'COMMUNITY HALL' },
  7: { kind: 'kiosk', name: 'Fortune Kiosk', sign: 'FORTUNE KIOSK' },
  22: { kind: 'kiosk', name: 'Fortune Kiosk', sign: 'FORTUNE KIOSK' },
  36: { kind: 'kiosk', name: 'Fortune Kiosk', sign: 'FORTUNE KIOSK' },
  4: { kind: 'tax', name: 'City Revenue Office', sign: 'CITY REVENUE OFFICE' },
  38: { kind: 'jeweller', name: 'The Jeweller', sign: 'THE JEWELLER' },
};
const SPECIAL_PARTS = {
  hall: [
    { role: 'body', a: 0, w: 18, d0: 150, d1: 162, y1: 7.15, storey: 3.5, ground: 3.6, facade: FACADE.CIVIC },
    { role: 'roof', variant: 'gable', a: 0, w: 18, d0: 150, d1: 162, y0: 7.15, y1: 10.0 },
    { role: 'top', variant: 'hallSteps', a: 0, w: 10, d0: 146.5, d1: 150, y0: 0.15, y1: 1.2 },
    { role: 'top', variant: 'chest', a: 0, w: 3.2, d0: 143.4, d1: 146.2, y0: 0.15, y1: 3.4 },
    { role: 'top', variant: 'noticeBoard', a: 7.5, w: 2.6, d0: 141.5, d1: 142.2, y0: 0.15, y1: 2.4 },
  ],
  kiosk: [
    { role: 'body', a: -3, w: 4.4, d0: 149, d1: 153.4, y1: 3.35, storey: 3.2, ground: 3.2, facade: FACADE.PAVILION },
    { role: 'top', variant: 'kiosk', a: -3, w: 5.4, d0: 148.5, d1: 153.9, y0: 3.35, y1: 4.6 },
    { role: 'top', variant: 'neonQ', a: 4, w: 3.4, d0: 150.6, d1: 151.4, y0: 0.15, y1: 6.15 },
    { role: 'top', variant: 'benches', a: 0, w: 18, d0: 143, d1: 146, y0: 0.15, y1: 1.0 },
  ],
  tax: [
    { role: 'body', a: 0, w: 20, d0: 150, d1: 162, y1: 9.95, storey: 4.6, ground: 5.0, facade: FACADE.BANK },
    { role: 'roof', variant: 'flat', a: 0, w: 20, d0: 150, d1: 162, y0: 9.95, y1: 10.4 },
    { role: 'top', variant: 'portico', a: 0, w: 14, d0: 147, d1: 150, y0: 0.15, y1: 12.5 },
    { role: 'top', variant: 'coinSlot', a: 8.5, w: 2.2, d0: 145.4, d1: 146.4, y0: 0.15, y1: 2.6 },
  ],
  jeweller: [
    { role: 'body', a: 0, w: 16, d0: 149, d1: 159, y1: 8.15, storey: 4, ground: 4.2, facade: FACADE.HOTEL },
    { role: 'roof', variant: 'flat', a: 0, w: 16, d0: 149, d1: 159, y0: 8.15, y1: 8.6 },
    { role: 'top', variant: 'ringSign', a: 0, w: 5, d0: 152.5, d1: 155.5, y0: 8.15, y1: 14.0 },
    { role: 'canopy', a: 0, w: 8, d0: 147.4, d1: 149, y0: 3.2, y1: 3.6 },
  ],
};

/** The four corner sites (§3.5, §5) in world coordinates (rects; landmarks.js builds the detail). */
export const CORNER_STYLES = {
  0: { name: 'GO Gate & City Bank' },
  10: { name: 'Central Police Station' },
  20: { name: 'Free Parking Plaza' },
  30: { name: 'Traffic Police Checkpoint' },
};

// GO Gate geometry (§3.5): legs on the diagonal through the SE apex, within 14 m of it.
export const GO_GATE = Object.freeze({ inner: { x: 120.25, z: 120.25 }, outer: { x: 136.6, z: 136.6 }, height: 31, leg: 0.8 });
export const POWER_ZONE = Object.freeze({ minX: -245, maxX: -200, minZ: 50, maxZ: 105 });
const APEX_R = 14;

const rect = (x0, x1, z0, z1) => ({ minX: Math.min(x0, x1), maxX: Math.max(x0, x1), minZ: Math.min(z0, z1), maxZ: Math.max(z0, z1) });

/** Corner structures in world coordinates. `zone`: 'site' (inside the L-site) or 'apex' (≤ 14 m of the apex). */
function cornerParts(tile) {
  const out = [];
  const push = (part, r, y1, extra = {}) => out.push({ part, ...r, y0: extra.y0 ?? LOT_BASE, y1, zone: extra.zone ?? 'site', thin: !!extra.thin, ...extra });
  if (tile === 0) {
    // City Bank (rotated 45° on the main block), its dome, the LED billboard, the coin fountain; the GO Gate.
    push('bank', rect(143, 171, 143, 171), 22.0);
    push('bankDome', rect(151, 163, 151, 163), 32.0);
    push('billboard', rect(141, 143, 160, 170), 9.0);
    push('fountain', rect(141, 147, 141, 147), 1.6);
    const g = GO_GATE;
    const h = g.leg / 2;
    push('goGateLegInner', rect(g.inner.x - h, g.inner.x + h, g.inner.z - h, g.inner.z + h), g.height, { zone: 'apex' });
    push('goGateLegOuter', rect(g.outer.x - h, g.outer.x + h, g.outer.z - h, g.outer.z + h), g.height, { zone: 'apex' });
    push('goGateArch', rect(g.inner.x - h, g.outer.x + h, g.inner.z - h, g.outer.z + h), g.height, { zone: 'apex', y0: 22 });
  } else if (tile === 10) {
    // Police station on the west arm (frontFace = |x| of its east face = 141 → ≤ 12 m), the walled yard on the main
    // block, the barred cell block on the south arm, the watch tower in the far corner (§3.10).
    push('policeStation', rect(-165, -141, 119, 137), 12.0);
    push('yardWallN', rect(-168, -148.6, 146, 146.6), 6.15);
    push('yardWallS', rect(-168, -144, 165.4, 166), 6.15);
    push('yardWallW', rect(-168, -167.4, 146, 166), 6.15);
    push('yardWallE', rect(-144.6, -144, 146, 166), 6.15);
    push('yardGate', rect(-148.6, -144.6, 145.7, 146.6), 6.4);
    push('cellBlock', rect(-137, -119, 141, 153), 6.15);
    push('watchTower', rect(-171, -166.5, 165, 170.5), 14.15);
    push('visitorsBench', rect(-138.4, -136.4, 137.5, 138.3), 1.0, { zone: 'apex' });
  } else if (tile === 20) {
    push('wheel', rect(-172, -148, -172, -148), 45.0);
    push('booths', rect(-144.5, -140.5, -144.5, -140.5), 3.4);
    push('foodTrucks', rect(-171, -147, -145, -141), 3.6);
    push('foodTrucks2', rect(-145, -141, -171, -147), 3.6);
    push('fountain', rect(-149, -143, -149, -143), 2.4);
    push('barrierPosts', rect(-138.6, -135.6, -138.6, -135.6), 1.4, { zone: 'apex' });
  } else if (tile === 30) {
    push('precinct', rect(148, 170, -170, -148), 16.15);
    push('policeBox', rect(135.8, 139.0, -139.0, -135.8), 4.6, { zone: 'apex' });
    push('barrierPost', rect(131.0, 131.9, -131.9, -131.0), 1.4, { zone: 'apex' });
    push('floodMast', rect(142.9, 143.3, -143.3, -142.9), 14.0, { thin: true });
    push('patrolCars', rect(140, 147, -147, -140), 1.6);
    push('towBay', rect(126, 138, -170, -160), 0.3);
  }
  return out;
}

/** Station extras outside the lots (§3.9): platforms and canopies in the rail corridor, footbridges. */
function stationExtras(tile) {
  const out = [];
  const q = Math.floor(tile / 10);
  if (q === 3) return out; // Short Line: the line runs underground on the east side
  const A = address(tile);
  // Along-axis extent ±60 m around the station, in world coordinates.
  const ax = A.along.x;
  const az = A.along.z;
  const ox = A.out.x;
  const oz = A.out.z;
  const box = (a0, a1, d0, d1, y1, part) => {
    const pts = [[a0, d0], [a1, d0], [a0, d1], [a1, d1]].map(([a, d]) => ({ x: A.lot.cx + ox * (d - 156) + ax * a, z: A.lot.cz + oz * (d - 156) + az * a }));
    const xs = pts.map((p) => p.x);
    const zs = pts.map((p) => p.z);
    out.push({ part, minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs), y0: 0, y1, zone: part === 'footbridge' ? 'footbridge' : 'rail', thin: false });
  };
  box(-60, 60, 191.2, 193.4, 1.1, 'platformIn');
  box(-60, 60, 200.6, 202.8, 1.1, 'platformOut');
  box(-40, 40, 191.2, 193.4, 5.2, 'canopyIn');
  box(-40, 40, 200.6, 202.8, 5.2, 'canopyOut');
  if (tile === 5) box(-50, 50, 191, 203, 9.5, 'trainShed');
  box(-2, 2, 173, 191.2, 8.4, 'footbridge');
  return out;
}

// ---- lot plans (local frame) ----------------------------------------------------------------------

/** Unit footprint for slot k of a group (local). */
function unitParts(style, slot, tile) {
  const u = style.unit;
  const a = UNIT_SLOTS[slot];
  const d0 = UNIT_FRONT;
  const d1 = d0 + u.depth;
  const yBody = LOT_BASE + u.body;
  const parts = [
    { role: 'body', slot, a, w: UNIT_W, d0, d1, y0: LOT_BASE, y1: r3(yBody), storey: u.storey, ground: u.ground, facade: u.facade },
    { role: 'roof', slot, variant: u.roof, a, w: UNIT_W, d0, d1, y0: r3(yBody), y1: r3(Math.min(u.top, yBody + u.roofH)) },
  ];
  // Decor: porches, awnings, stoops, marquees, pools… (front of the unit; owner colour where it shows).
  const decorDepth = { cottage: 1.4, oldTown: 0.6, shopHouse: 1.8, brownstone: 2.0, theatre: 2.2, villa: 0.4 }[u.decor] ?? 1;
  const decorTop = { cottage: 3.2, oldTown: 4.0, shopHouse: 4.6, brownstone: 3.4, theatre: 6.4, villa: 3.9 }[u.decor] ?? 3;
  // (The theatre marquee hangs over the forecourt from 3.8 m up; every other decor stands on the ground.)
  parts.push({ role: 'decor', slot, variant: u.decor, a, w: UNIT_W, d0: r3(d0 - decorDepth), d1, y0: u.decor === 'theatre' ? 3.8 : LOT_BASE, y1: decorTop });
  if (u.decor === 'cottage') parts.push({ role: 'chimney', slot, a: a + 1.6, w: 0.8, d0: d0 + 5.2, d1: d0 + 6.0, y0: r3(yBody), y1: u.top });
  if (u.decor === 'theatre') parts.push({ role: 'blade', slot, a: a + 2.6, w: 0.5, d0: r3(d0 - 1.4), d1: d0, y0: 6.5, y1: 18.0 });
  // Dark blue villas: cantilevered upper storey toward the street, and a pool in the front garden.
  if (u.decor === 'villa') parts.push({ role: 'pool', slot, a, w: 4.6, d0: 160.6, d1: 166.4, y0: 0.0, y1: LOT_BASE + 0.05 });
  return parts;
}

/** Tier buildings for tier groups (local). */
function tierParts(style, level) {
  const t = style.tiers;
  const parts = [];
  let y = LOT_BASE;
  for (let k = 0; k < level; k++) {
    const w = t.w0 - k * t.shrink;
    const dd = t.d0 - k * t.shrink;
    const n = t.storeys[k];
    const h = k === 0 ? t.ground + (n - 1) * t.storey : n * t.storey;
    const d0 = 163 - dd / 2;
    parts.push({ role: 'body', tier: k, a: 0, w, d0, d1: d0 + dd, y0: r3(y), y1: r3(y + h), storey: t.storey, ground: k === 0 ? t.ground : t.storey, facade: t.facade });
    y += h;
    parts.push({ role: 'roof', tier: k, variant: 'flat', a: 0, w, d0, d1: d0 + dd, y0: r3(y), y1: r3(y + t.parapet) });
  }
  if (level > 0) parts.push({ role: 'decor', variant: t.decor, a: 0, w: 14, d0: 150.6, d1: 153, y0: LOT_BASE, y1: 10.5 });
  return parts;
}

/** Group's L0 kit as one bounding box (the kit geometry stays inside it). */
function kitPart(style) {
  return { role: 'kit', variant: style.kit.name, a: 0, w: 25, d0: 139.5, d1: 172.5, y0: LOT_BASE, y1: style.kit.height };
}

/**
 * Structures of an edge lot at `level` (−1 for sale, 0 bought, 1–4 houses, 5 hotel) in the lot frame.
 * Each: { role, a, w, d0 (street face distance), d1, y0, y1 (world top), rot?, thin?, slot?, tier?, variant? }.
 * Mortgaged lots keep the same structures (boarded, banner + chain: low).
 */
export function planLot(tile, level, { group = null, board = null } = {}) {
  const parts = [];
  const lv = Math.max(-1, Math.min(5, Math.trunc(Number(level) || 0)));
  // Always: the address post on the sidewalk and the 8 m flagpole (thin poles, §3.10 exempt).
  parts.push({ role: 'post', a: 0, w: 1.5, d0: POST_D - 0.1, d1: POST_D + 0.1, y0: LOT_BASE, y1: 2.6, thin: true });
  parts.push({ role: 'flagpole', a: FLAG_SPOT.a, w: 0.2, d0: FLAG_SPOT.d - 0.1, d1: FLAG_SPOT.d + 0.1, y0: LOT_BASE, y1: LOT_BASE + FLAG_SPOT.h, thin: true });
  const station = STATION_STYLES[tile];
  const util = UTILITY_STYLES[tile];
  if (station || util) {
    for (const p of (station ?? util).parts) parts.push({ y0: LOT_BASE, ...p });
    if (lv < 0) parts.push({ role: 'billboard', a: 9.5, w: 6.4, d0: 140.2, d1: 141.0, y0: LOT_BASE, y1: 5.6 });
    return parts;
  }
  const style = styleOf(group ?? groupOfTile(tile, board));
  if (lv < 0) {
    parts.push({ role: 'hoarding', a: 0, w: 25.2, d0: 139.4, d1: 172.6, y0: LOT_BASE, y1: 2.55 });
    parts.push({ role: 'agentSign', a: SIGN_SPOT.a, w: 1.4, d0: SIGN_SPOT.d - 0.15, d1: SIGN_SPOT.d + 0.15, y0: LOT_BASE, y1: 3.15 });
    return parts;
  }
  if (lv === 5) {
    for (const p of style.hotel.parts) parts.push({ y0: LOT_BASE, ...p, facade: p.facade ?? style.hotel.facade, variant: p.variant ?? (p.role === 'top' ? style.hotel.top : p.variant) });
    parts.push({ role: 'podium', a: 0, w: 25, d0: 139.6, d1: style.hotel.frontFace, y0: LOT_BASE, y1: 0.75 });
    return parts;
  }
  if (lv === 0) {
    parts.push(kitPart(style));
    return parts;
  }
  if (style.kind === 'tiers') {
    parts.push(...tierParts(style, lv));
  } else {
    for (let k = 0; k < lv; k++) parts.push(...unitParts(style, UNIT_ORDER[k], tile));
  }
  return parts;
}

/**
 * Where the owner roundel lies (§6.5): { a, d, y, size, roof } in the lot frame. L0: the middle of the lawn;
 * units: the back garden on south / west lots (camera side), the forecourt on north / east lots; tiers: the
 * top tier's roof; hotels: as designed; stations and utilities: the back yard.
 */
export function roundelSpot(tile, level, { group = null, board = null } = {}) {
  const lv = Math.max(-1, Math.min(5, Math.trunc(Number(level) || 0)));
  const ground = LOT_BASE + 0.04;
  if (STATION_STYLES[tile]) return { a: 0, d: 168, y: ground, size: 9, roof: false };
  if (UTILITY_STYLES[tile]) return tile === 28 ? { a: -6, d: 166.5, y: ground, size: 9, roof: false } : { a: 0, d: 167.5, y: ground, size: 9, roof: false };
  const style = styleOf(group ?? groupOfTile(tile, board));
  if (lv <= 0) return { a: 0, d: 156, y: ground, size: 10, roof: false };
  if (lv === 5) {
    const r = style.hotel.roundel;
    const roofY = r.y ?? (r.roof ? Math.max(...style.hotel.parts.filter((p) => p.role === 'roof' && Math.abs((p.d0 + p.d1) / 2 - r.d) < 12).map((p) => p.y1), LOT_BASE) : ground);
    return { a: r.a, d: r.d, y: r.roof ? roofY + 0.03 : ground, size: r.size ?? 10, roof: !!r.roof };
  }
  if (style.kind === 'tiers') {
    const plan = tierParts(style, lv).filter((p) => p.role === 'roof');
    const top = plan[plan.length - 1];
    const size = Math.max(9, 0.7 * Math.min(top.w, top.d1 - top.d0));
    return { a: 0, d: (top.d0 + top.d1) / 2, y: top.y0 + 0.08, size, roof: true };
  }
  const q = Math.floor(tile / 10);
  return q <= 1 ? { a: 0, d: 166.6, y: ground, size: 9, roof: false } : { a: 0, d: 143.6, y: ground, size: 9, roof: false };
}

/** Built-in tile → group map for the standard board (BOARD may override). */
const STD_GROUP = { 1: 'brown', 3: 'brown', 6: 'lightblue', 8: 'lightblue', 9: 'lightblue', 11: 'pink', 13: 'pink', 14: 'pink', 16: 'orange', 18: 'orange', 19: 'orange', 21: 'red', 23: 'red', 24: 'red', 26: 'yellow', 27: 'yellow', 29: 'yellow', 31: 'green', 32: 'green', 34: 'green', 37: 'darkblue', 39: 'darkblue' };
export function groupOfTile(tile, board = null) {
  const t = board?.tiles?.[tile];
  if (t && t.type === 'property' && t.group) return t.group;
  return STD_GROUP[tile] ?? null;
}

/** Special-lot plans (local frame, landmarks.js). */
export function planSpecial(tile) {
  const s = SPECIAL_STYLES[tile];
  if (!s) return [];
  return [
    { role: 'post', a: 0, w: 1.5, d0: POST_D - 0.1, d1: POST_D + 0.1, y0: LOT_BASE, y1: 2.6, thin: true },
    ...SPECIAL_PARTS[s.kind].map((p) => ({ y0: LOT_BASE, ...p })),
  ];
}

// ---- heights --------------------------------------------------------------------------------------

/** Tallest world top of a plan (thin poles excluded). */
function topOf(parts) {
  let h = 0;
  for (const p of parts) if (!p.thin) h = Math.max(h, p.y1);
  return r3(h);
}
/** Nearest street face of a plan (thin poles excluded). */
function frontOf(parts) {
  let f = Infinity;
  for (const p of parts) if (!p.thin) f = Math.min(f, p.d0);
  return f === Infinity ? null : r3(f);
}
for (const g of GROUP_ORDER) {
  const s = LOT_STYLES[g];
  const tile = { brown: 1, lightblue: 6, pink: 11, orange: 16, red: 21, yellow: 26, green: 31, darkblue: 37 }[g];
  s.heights = [0, 1, 2, 3, 4, 5].map((lv) => topOf(planLot(tile, lv, { group: g })));
  s.frontFace = [0, 1, 2, 3, 4, 5].map((lv) => frontOf(planLot(tile, lv, { group: g })));
  s.hotel.height = s.heights[5];
}

/** World height of group `group` at level −1..5 (−1: the hoarding). */
export function heightOf(group, level) {
  const s = styleOf(group);
  const lv = Math.trunc(Number(level) || 0);
  if (lv < 0) return 3.15;
  return s.heights[Math.min(5, lv)];
}

// ---- local → world --------------------------------------------------------------------------------

/** World point of a lot-local (a, d). */
export function lotPoint(tile, a, d, out = {}) {
  const A = address(tile);
  const cos = Math.cos(A.lot.yaw);
  const sin = Math.sin(A.lot.yaw);
  const lx = a;
  const lz = LOT_CENTRE_D - d;
  out.x = A.lot.cx + lx * cos + lz * sin;
  out.z = A.lot.cz - lx * sin + lz * cos;
  return out;
}

/** World AABB of a local plan part (respects `rot` about the part's centre). */
export function partFootprint(tile, p) {
  const A = address(tile);
  const cos = Math.cos(A.lot.yaw);
  const sin = Math.sin(A.lot.yaw);
  const cd = (p.d0 + p.d1) / 2;
  const hw = p.w / 2;
  const hd = (p.d1 - p.d0) / 2;
  const rc = Math.cos(p.rot ?? 0);
  const rs = Math.sin(p.rot ?? 0);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [u, v] of [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]]) {
    // Rotate about the part centre in the local frame (x along, z toward the street).
    const lx = p.a + u * rc + v * rs;
    const lz = LOT_CENTRE_D - cd - u * rs + v * rc;
    const x = A.lot.cx + lx * cos + lz * sin;
    const z = A.lot.cz - lx * sin + lz * cos;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { minX: r3(minX), maxX: r3(maxX), minZ: r3(minZ), maxZ: r3(maxZ) };
}

/**
 * Street-face distance of a world footprint on tile i: south lots → min z, west → −max x, north → −max z,
 * east → min x. Jail corner (§3.10): west arm (z < 139) → −max x, south arm (x > −139) → min z, main block →
 * the nearer of both. Other corners: the nearer of both.
 */
export function frontFaceOf(tile, fp) {
  const q = Math.floor((((tile % 40) + 40) % 40) / 10);
  if (tile % 10 !== 0) return r3([fp.minZ, -fp.maxX, -fp.maxZ, fp.minX][q]);
  const sx = [1, -1, -1, 1][q];
  const sz = [1, 1, -1, -1][q];
  const nx = sx > 0 ? fp.minX : -fp.maxX; // distance of the face nearest the centre in x
  const nz = sz > 0 ? fp.minZ : -fp.maxZ;
  if (nz < M.PROP - 1e-6) return r3(nx); // the arm along the side avenue (x-facing)
  if (nx < M.PROP - 1e-6) return r3(nz); // the arm along the row avenue (z-facing)
  return r3(Math.min(nx, nz));
}

/**
 * Every structure in the city that lane B builds: { tile, level, part, height, frontFace, footprint, thin, zone }.
 * zone: 'lot' (inside lotRect), 'site' (corner L-site), 'apex' (≤ 14 m of the corner apex), 'rail'/'footbridge'
 * (station extras), 'power' (power-station zone).
 */
export function structures({ board = null } = {}) {
  const list = [];
  const add = (tile, level, part, fp, y1, thin, zone) => list.push({ tile, level, part, height: r3(y1), frontFace: frontFaceOf(tile, fp), footprint: fp, thin: !!thin, zone });
  for (let tile = 0; tile < 40; tile++) {
    if (tile % 10 === 0) {
      for (const p of cornerParts(tile)) add(tile, 0, p.part, { minX: p.minX, maxX: p.maxX, minZ: p.minZ, maxZ: p.maxZ }, p.y1, p.thin, p.zone);
      continue;
    }
    if (SPECIAL_STYLES[tile]) {
      for (const p of planSpecial(tile)) add(tile, 0, p.role + (p.variant ? `:${p.variant}` : ''), partFootprint(tile, p), p.y1, p.thin, p.role === 'post' ? 'sidewalk' : 'lot');
      continue;
    }
    const levels = STATION_STYLES[tile] || UTILITY_STYLES[tile] ? [-1, 0] : [-1, 0, 1, 2, 3, 4, 5];
    for (const lv of levels) {
      for (const p of planLot(tile, lv, { board })) add(tile, lv, p.role + (p.variant ? `:${p.variant}` : ''), partFootprint(tile, p), p.y1, p.thin, p.role === 'post' ? 'sidewalk' : 'lot');
    }
    if (STATION_STYLES[tile]) for (const p of stationExtras(tile)) add(tile, 0, p.part, p, p.y1, false, p.zone);
  }
  // The power station (Electric Company's plant) in its reserved zone behind tile 12.
  const pz = POWER_ZONE;
  list.push({ tile: 12, level: 0, part: 'turbineHall', height: 25, frontFace: 205, footprint: { minX: -238, maxX: -206, minZ: 58, maxZ: 80 }, thin: false, zone: 'power' });
  list.push({ tile: 12, level: 0, part: 'chimneys', height: 70, frontFace: 214, footprint: { minX: -236, maxX: -214, minZ: 86, maxZ: 96 }, thin: false, zone: 'power' });
  list.push({ tile: 12, level: 0, part: 'substation', height: 9, frontFace: 203, footprint: { minX: pz.minX + 3, maxX: pz.maxX - 2, minZ: 97, maxZ: 103 }, thin: false, zone: 'power' });
  return list;
}

/** Exposed so landmarks.js and the test share the exact numbers. */
export { cornerParts, stationExtras, tierParts, unitParts, APEX_R, GROUP_ORDER };
