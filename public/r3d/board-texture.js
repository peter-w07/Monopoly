// public/r3d/board-texture.js — draws the whole board face into ONE canvas (uploaded once as the
// slab's top texture). Everything that changes during a game (owners, houses, mortgages, highlights)
// is a separate 3D object, so this canvas is drawn once per renderer instance and quality tier
// (~10 ms at 2048 px, ~40 ms at 4096 px).
//
// The centre is the city's ground plan: the dice plaza, the ring road with sidewalks, one lot per
// colour group, lawns (parks) in the gaps between them and four landmark lots in the inner corners
// (city.js builds on exactly these: districtGaps / LANDMARK_LOTS are exported for it).
//
// Canvas pixels map 1:1 onto the 2D renderer's uv units (u → right, v → down), which is also how the
// top face of the slab is UV-mapped, so tile i sits exactly at layout.tileRect(i).

import {
  UNITS, CORNER, BAND, JAIL_STRIP, DECK_SPOTS, HALF, ROAD_R, ROAD_W, ROAD_CORNER, DISTRICT_IN, DISTRICT_OUT,
  DISTRICT_SPAN, sideOf, tileRect, districts, districtPoint,
} from './layout.js';

export const COLORS = {
  board: '#d3e9d6',
  centre: '#cde6d0',
  line: '#1b1b1b',
  ink: '#161b18',
  muted: '#3d4a42',
  accent: '#c8102e',
  chance: '#f07c1a',
  community: '#2b8fd6',
  jail: '#f29a1d',
};

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

// Rotation of a side's tiles so their colour band points at the board centre (canvas: + = clockwise).
const SIDE_ANGLE = { bottom: 0, left: Math.PI / 2, top: Math.PI, right: -Math.PI / 2 };
// Corner squares are drawn diagonally, readable from outside their corner.
const CORNER_ANGLE = { 0: -Math.PI / 4, 10: Math.PI / 4, 20: (3 * Math.PI) / 4, 30: (-3 * Math.PI) / 4 };

/**
 * @param {object} board  parsed board.json
 * @param {number} size   canvas size in px (square)
 * @returns {HTMLCanvasElement}
 */
export function drawBoardCanvas(board, size = 2048) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const s = size / UNITS; // px per unit
  PX = s;
  g.scale(s, s); // draw in board units from here on
  g.lineJoin = 'round';

  g.fillStyle = COLORS.board;
  g.fillRect(0, 0, UNITS, UNITS);
  drawCentre(g, board);

  for (const tile of board.tiles) {
    const i = tile.index;
    const r = tileRect(i);
    const side = sideOf(i);
    g.save();
    g.translate(r.x + r.w / 2, r.y + r.h / 2);
    if (side === 'corner') {
      drawCorner(g, board, tile);
    } else {
      g.rotate(SIDE_ANGLE[side]);
      drawEdgeTile(g, board, tile, 1, CORNER);
    }
    g.restore();
  }

  // Tile grid lines on top, crisp and continuous.
  g.strokeStyle = COLORS.line;
  g.lineWidth = 0.022;
  for (const tile of board.tiles) {
    const r = tileRect(tile.index);
    g.strokeRect(r.x, r.y, r.w, r.h);
  }
  g.lineWidth = 0.05;
  g.strokeRect(CORNER, CORNER, UNITS - 2 * CORNER, UNITS - 2 * CORNER);
  g.strokeRect(0.025, 0.025, UNITS - 0.05, UNITS - 0.05);
  drawGrain(g, size);
  return cv;
}

// ---- text helpers -----------------------------------------------------------------------------------

// The canvas is scaled to board units for shapes, but text is drawn in device pixels (fonts
// smaller than 1px under a scale transform render unreliably across browsers).
let PX = 1; // canvas px per board unit while drawing

function setFont(g, units, weight = 700, family = FONT) {
  g.font = `${weight} ${Math.max(1, Math.round(units * PX * 10) / 10)}px ${family}`;
}

function fillText(g, text, x, y, strokeWidth = 0) {
  g.save();
  g.scale(1 / PX, 1 / PX);
  if (strokeWidth) {
    g.lineWidth = strokeWidth * PX;
    g.strokeText(text, x * PX, y * PX);
  } else {
    g.fillText(text, x * PX, y * PX);
  }
  g.restore();
}

const measure = (g, text) => g.measureText(text).width / PX;

/** Word-wraps `text` to `maxW`, shrinking the font so the longest word fits. Draws centred lines. */
function wrapText(g, text, y, maxW, px, { weight = 800, lineHeight = 1.12, minPx = px * 0.55, baseline = 'top' } = {}) {
  const words = String(text).split(/\s+/).filter(Boolean);
  let size = px;
  setFont(g, size, weight);
  const longest = Math.max(...words.map((w) => measure(g, w)), 0.001);
  if (longest > maxW) {
    size = Math.max(minPx, (size * maxW) / longest);
    setFont(g, size, weight);
  }
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (line && measure(g, t) > maxW) {
      lines.push(line);
      line = w;
    } else {
      line = t;
    }
  }
  if (line) lines.push(line);
  g.textAlign = 'center';
  g.textBaseline = baseline === 'middle' ? 'middle' : 'top';
  const lh = size * lineHeight;
  const y0 = baseline === 'middle' ? y - ((lines.length - 1) * lh) / 2 : y;
  lines.forEach((l, k) => fillText(g, l, 0, y0 + k * lh));
  return y0 + lines.length * lh;
}

const money = (n) => `$${n}`;

// ---- edge tiles -----------------------------------------------------------------------------------

/** Draws a tile in its local frame: centred, width w along x, depth h along y (−y = inner edge). */
function drawEdgeTile(g, board, tile, w, h) {
  const top = -h / 2;
  const bottom = h / 2;
  const maxW = w * 0.86;
  g.fillStyle = COLORS.ink;

  switch (tile.type) {
    case 'property': {
      g.fillStyle = board.groups?.[tile.group]?.color ?? '#999';
      g.fillRect(-w / 2, top, w, BAND);
      g.strokeStyle = COLORS.line;
      g.lineWidth = 0.02;
      g.beginPath();
      g.moveTo(-w / 2, top + BAND);
      g.lineTo(w / 2, top + BAND);
      g.stroke();
      g.fillStyle = COLORS.ink;
      wrapText(g, tile.name.toUpperCase(), top + BAND + 0.1, maxW, 0.125);
      priceLine(g, money(tile.price), bottom);
      break;
    }
    case 'railroad':
      wrapText(g, tile.name.toUpperCase(), top + 0.1, maxW, 0.115);
      drawTrain(g, 0, 0.12, 0.62);
      priceLine(g, money(tile.price), bottom);
      break;
    case 'utility': {
      wrapText(g, tile.name.toUpperCase(), top + 0.1, maxW, 0.115);
      const water = /water/i.test(tile.name);
      if (water) drawTap(g, 0, 0.1, 0.5);
      else drawBulb(g, 0, 0.1, 0.5);
      priceLine(g, money(tile.price), bottom);
      break;
    }
    case 'chance':
      wrapText(g, 'CHANCE', top + 0.12, maxW, 0.15);
      g.fillStyle = COLORS.chance;
      setFont(g, 0.78, 900, 'Georgia, "Times New Roman", serif');
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      fillText(g, '?', 0, 0.22);
      g.strokeStyle = COLORS.ink;
      fillText(g, '?', 0, 0.22, 0.025);
      break;
    case 'community':
      wrapText(g, 'COMMUNITY CHEST', top + 0.1, maxW, 0.12);
      drawChest(g, 0, 0.22, 0.56);
      break;
    case 'tax':
      wrapText(g, tile.name.toUpperCase(), top + 0.12, maxW, 0.13);
      if (/luxury/i.test(tile.name)) drawRing(g, 0, 0.12, 0.42);
      else drawDiamondBag(g, 0, 0.12, 0.42);
      priceLine(g, `PAY ${money(tile.amount)}`, bottom);
      break;
    default:
      wrapText(g, tile.name.toUpperCase(), top + 0.12, maxW, 0.12);
  }
}

function priceLine(g, text, bottom) {
  g.fillStyle = COLORS.ink;
  setFont(g, 0.13, 700);
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  fillText(g, text, 0, bottom - 0.1);
}

// Tiny vector icons (no emoji dependency on the board face).
function drawTrain(g, x, y, s) {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.fillStyle = COLORS.ink;
  g.fillRect(-0.42, -0.12, 0.5, 0.26); // boiler
  g.fillRect(0.06, -0.3, 0.3, 0.44); // cab
  g.fillRect(-0.36, -0.3, 0.1, 0.2); // funnel
  g.fillRect(-0.5, 0.12, 1.0, 0.05); // frame
  for (const cx of [-0.3, -0.05, 0.25]) {
    g.beginPath();
    g.arc(cx, 0.24, 0.1, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = COLORS.board;
  g.fillRect(0.13, -0.24, 0.16, 0.14); // window
  g.restore();
}

function drawBulb(g, x, y, s) {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.fillStyle = '#ffd84a';
  g.strokeStyle = COLORS.ink;
  g.lineWidth = 0.05;
  g.beginPath();
  g.arc(0, -0.08, 0.3, Math.PI * 0.8, Math.PI * 2.2);
  g.lineTo(0.12, 0.28);
  g.lineTo(-0.12, 0.28);
  g.closePath();
  g.fill();
  g.stroke();
  g.fillStyle = COLORS.ink;
  g.fillRect(-0.13, 0.3, 0.26, 0.14);
  g.restore();
}

function drawTap(g, x, y, s) {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.fillStyle = COLORS.ink;
  g.fillRect(-0.4, -0.2, 0.55, 0.14); // pipe
  g.fillRect(0.05, -0.2, 0.14, 0.34); // spout
  g.fillRect(-0.2, -0.38, 0.08, 0.2); // stem
  g.fillRect(-0.32, -0.42, 0.32, 0.07); // handle
  g.fillStyle = COLORS.community;
  g.beginPath();
  g.ellipse(0.12, 0.3, 0.07, 0.11, 0, 0, Math.PI * 2); // drop
  g.fill();
  g.restore();
}

function drawChest(g, x, y, s) {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.fillStyle = COLORS.community;
  g.strokeStyle = COLORS.ink;
  g.lineWidth = 0.045;
  g.beginPath();
  g.rect(-0.42, -0.08, 0.84, 0.42);
  g.fill();
  g.stroke();
  g.beginPath();
  g.moveTo(-0.42, -0.08);
  g.quadraticCurveTo(0, -0.46, 0.42, -0.08);
  g.closePath();
  g.fill();
  g.stroke();
  g.fillStyle = '#f4c542';
  g.fillRect(-0.08, -0.12, 0.16, 0.18);
  g.strokeRect(-0.08, -0.12, 0.16, 0.18);
  g.restore();
}

function drawRing(g, x, y, s) {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.strokeStyle = '#b8912f';
  g.lineWidth = 0.1;
  g.beginPath();
  g.arc(0, 0.12, 0.3, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#8fd3ff';
  g.strokeStyle = COLORS.ink;
  g.lineWidth = 0.04;
  g.beginPath();
  g.moveTo(-0.16, -0.18);
  g.lineTo(0.16, -0.18);
  g.lineTo(0, 0.02);
  g.closePath();
  g.fill();
  g.stroke();
  g.restore();
}

function drawDiamondBag(g, x, y, s) {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.fillStyle = '#c9a44a';
  g.strokeStyle = COLORS.ink;
  g.lineWidth = 0.045;
  g.beginPath();
  g.moveTo(-0.14, -0.3);
  g.lineTo(0.14, -0.3);
  g.lineTo(0.08, -0.16);
  g.bezierCurveTo(0.5, 0.0, 0.42, 0.42, 0, 0.42);
  g.bezierCurveTo(-0.42, 0.42, -0.5, 0.0, -0.08, -0.16);
  g.closePath();
  g.fill();
  g.stroke();
  g.fillStyle = COLORS.ink;
  setFont(g, 0.36, 900);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  fillText(g, '$', 0, 0.14);
  g.restore();
}

// ---- corners ------------------------------------------------------------------------------------

function drawCorner(g, board, tile) {
  const i = tile.index;
  if (tile.type === 'jail') {
    drawJail(g);
    return;
  }
  const h = CORNER / 2;
  const angle = CORNER_ANGLE[i] ?? 0;
  if (tile.type === 'go') {
    // Sunburst behind the lettering (in board axes, clipped to the square).
    g.save();
    g.beginPath();
    g.rect(-h, -h, CORNER, CORNER);
    g.clip();
    const rays = 16;
    for (let k = 0; k < rays; k++) {
      const a0 = (k / rays) * Math.PI * 2;
      const a1 = ((k + 0.5) / rays) * Math.PI * 2;
      g.fillStyle = 'rgba(200, 16, 46, 0.09)';
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(Math.cos(a0) * 1.4, Math.sin(a0) * 1.4);
      g.lineTo(Math.cos(a1) * 1.4, Math.sin(a1) * 1.4);
      g.closePath();
      g.fill();
    }
    g.restore();
    g.save();
    g.rotate(angle);
    g.fillStyle = COLORS.ink;
    wrapText(g, `COLLECT ${money(board.goSalary ?? 200)} SALARY AS YOU PASS`, -0.56, 1.15, 0.105, { weight: 800 });
    setFont(g, 0.62, 900);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.strokeStyle = '#ffffff';
    g.lineJoin = 'round';
    fillText(g, 'GO', 0.02, 0.0, 0.09); // white halo
    g.fillStyle = COLORS.accent;
    fillText(g, 'GO', 0.02, 0.0);
    g.strokeStyle = COLORS.ink;
    fillText(g, 'GO', 0.02, 0.0, 0.018);
    g.restore();
    // Travel arrow along the bottom row (points left, drawn in board axes).
    g.fillStyle = COLORS.accent;
    g.strokeStyle = COLORS.ink;
    g.lineWidth = 0.02;
    g.beginPath();
    g.moveTo(-0.68, 0.6);
    g.lineTo(-0.36, 0.43);
    g.lineTo(-0.36, 0.53);
    g.lineTo(0.6, 0.53);
    g.lineTo(0.6, 0.67);
    g.lineTo(-0.36, 0.67);
    g.lineTo(-0.36, 0.73);
    g.closePath();
    g.fill();
    g.stroke();
    return;
  }
  g.rotate(angle);
  g.fillStyle = COLORS.ink;
  if (tile.type === 'free_parking') {
    wrapText(g, 'FREE', -0.5, 1.2, 0.2, { baseline: 'middle' });
    drawCar(g, -0.08, 0.04, 0.6);
    drawParkingSign(g, 0.42, -0.02, 0.36);
    g.fillStyle = COLORS.ink;
    wrapText(g, 'PARKING', 0.5, 1.2, 0.2, { baseline: 'middle' });
  } else if (tile.type === 'go_to_jail') {
    wrapText(g, 'GO TO', -0.5, 1.2, 0.2, { baseline: 'middle' });
    drawBadge(g, 0, 0.03, 0.55);
    g.fillStyle = COLORS.ink;
    wrapText(g, 'JAIL', 0.5, 1.2, 0.2, { baseline: 'middle' });
  } else {
    wrapText(g, tile.name.toUpperCase(), 0, 1.2, 0.18, { baseline: 'middle' });
  }
}

/** Jail corner, drawn in board axes (the tile is centred on the origin, 1.5 × 1.5). */
function drawJail(g) {
  const h = CORNER / 2;
  // The cell: the square toward the board centre (top-right of this corner).
  const cx = -h + JAIL_STRIP;
  const cy = -h;
  const cw = CORNER - JAIL_STRIP;
  g.fillStyle = COLORS.jail;
  g.fillRect(cx, cy, cw, cw);
  // Painted bars and a back wall line.
  g.fillStyle = 'rgba(22, 27, 24, 0.55)';
  const bars = 7;
  for (let k = 1; k < bars; k++) g.fillRect(cx + (k * cw) / bars - 0.012, cy, 0.024, cw);
  g.fillRect(cx, cy + 0.06, cw, 0.03);
  g.fillRect(cx, cy + cw - 0.09, cw, 0.03);
  g.strokeStyle = COLORS.line;
  g.lineWidth = 0.03;
  g.strokeRect(cx, cy, cw, cw);
  g.save();
  g.translate(cx + cw / 2, cy + cw / 2);
  g.rotate(Math.PI / 4);
  g.fillStyle = '#fbf6ea';
  g.strokeStyle = COLORS.ink;
  g.lineWidth = 0.02;
  g.beginPath();
  g.rect(-0.4, -0.14, 0.8, 0.28);
  g.fill();
  g.stroke();
  g.fillStyle = COLORS.ink;
  wrapText(g, 'IN JAIL', 0, 0.74, 0.19, { baseline: 'middle', weight: 900 });
  g.restore();
  // "JUST" up the left strip, "VISITING" along the bottom strip — readable from outside.
  g.fillStyle = COLORS.ink;
  g.save();
  g.translate(-h + JAIL_STRIP / 2, -h + cw / 2);
  g.rotate(Math.PI / 2);
  setFont(g, 0.17, 800);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  fillText(g, 'JUST', 0, 0);
  g.restore();
  setFont(g, 0.17, 800);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  fillText(g, 'VISITING', -h + JAIL_STRIP + cw / 2, h - JAIL_STRIP / 2);
}

function drawCar(g, x, y, s) {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.lineJoin = 'round';
  g.fillStyle = COLORS.accent;
  g.strokeStyle = COLORS.ink;
  g.lineWidth = 0.045;
  g.beginPath();
  g.moveTo(-0.52, 0.12);
  g.quadraticCurveTo(-0.54, -0.06, -0.4, -0.1);
  g.lineTo(-0.22, -0.13);
  g.quadraticCurveTo(-0.1, -0.36, 0.1, -0.36);
  g.quadraticCurveTo(0.28, -0.36, 0.36, -0.13);
  g.lineTo(0.48, -0.09);
  g.quadraticCurveTo(0.56, -0.02, 0.54, 0.12);
  g.closePath();
  g.fill();
  g.stroke();
  // Windows.
  g.fillStyle = '#bfe3f6';
  g.beginPath();
  g.moveTo(-0.14, -0.14);
  g.quadraticCurveTo(-0.06, -0.3, 0.04, -0.3);
  g.lineTo(0.04, -0.14);
  g.closePath();
  g.fill();
  g.beginPath();
  g.moveTo(0.1, -0.14);
  g.lineTo(0.1, -0.3);
  g.quadraticCurveTo(0.24, -0.3, 0.29, -0.14);
  g.closePath();
  g.fill();
  // Headlight and wheels.
  g.fillStyle = '#ffe07a';
  g.fillRect(0.44, -0.05, 0.07, 0.05);
  for (const cx of [-0.3, 0.3]) {
    g.fillStyle = COLORS.ink;
    g.beginPath();
    g.arc(cx, 0.13, 0.13, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#d5d8da';
    g.beginPath();
    g.arc(cx, 0.13, 0.055, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

/** A blue "P" parking sign on a pole. */
function drawParkingSign(g, x, y, s) {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.fillStyle = '#6b7075';
  g.fillRect(-0.03, -0.1, 0.06, 0.6);
  g.fillStyle = '#1d5fb4';
  g.strokeStyle = '#ffffff';
  g.lineWidth = 0.05;
  g.beginPath();
  g.rect(-0.26, -0.56, 0.52, 0.52);
  g.fill();
  g.stroke();
  g.restore();
  // The letter in unscaled board units (fillText works in board units).
  g.save();
  g.fillStyle = '#ffffff';
  setFont(g, 0.15, 900);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  fillText(g, 'P', x, y - 0.3 * s + 0.005);
  g.restore();
}

/** A police officer's cap with a gold badge and a whistle on a cord. */
function drawBadge(g, x, y, s) {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.lineJoin = 'round';
  g.fillStyle = '#1d3f8f';
  g.strokeStyle = COLORS.ink;
  g.lineWidth = 0.045;
  g.beginPath();
  g.moveTo(-0.5, -0.08);
  g.quadraticCurveTo(-0.5, -0.46, 0, -0.5);
  g.quadraticCurveTo(0.5, -0.46, 0.5, -0.08);
  g.lineTo(0.44, 0.04);
  g.lineTo(-0.44, 0.04);
  g.closePath();
  g.fill();
  g.stroke();
  g.fillStyle = '#10141a';
  g.beginPath();
  g.moveTo(-0.46, 0.04);
  g.lineTo(0.46, 0.04);
  g.quadraticCurveTo(0.3, 0.22, 0, 0.22);
  g.quadraticCurveTo(-0.3, 0.22, -0.46, 0.04);
  g.closePath();
  g.fill();
  g.fillStyle = '#f4c542';
  g.strokeStyle = '#8a6a12';
  g.lineWidth = 0.025;
  g.beginPath();
  for (let k = 0; k < 10; k++) {
    const r = k % 2 ? 0.07 : 0.14;
    const a = (k / 10) * Math.PI * 2 - Math.PI / 2;
    g.lineTo(Math.cos(a) * r, -0.24 + Math.sin(a) * r);
  }
  g.closePath();
  g.fill();
  g.stroke();
  g.restore();
}

// ---- centre ------------------------------------------------------------------------------------

/**
 * Gaps between the colour districts along each side (world units, like layout.districts):
 * [{ side, horizontal, out, a0, a1 }]. The city plants parks there; the texture paints lawns.
 */
export function districtGaps(board) {
  const list = districts(board);
  const out = [];
  for (const side of ['bottom', 'left', 'top', 'right']) {
    const mine = list.filter((d) => d.side === side).sort((a, b) => a.a0 - b.a0);
    if (!mine.length) continue;
    const proto = mine[0];
    let at = -DISTRICT_SPAN;
    for (const d of mine) {
      if (d.a0 - at > 0.45) out.push({ side, horizontal: proto.horizontal, out: proto.out, a0: at + 0.05, a1: d.a0 - 0.05 });
      at = Math.max(at, d.a1);
    }
    if (DISTRICT_SPAN - at > 0.45) out.push({ side, horizontal: proto.horizontal, out: proto.out, a0: at + 0.05, a1: DISTRICT_SPAN - 0.05 });
  }
  return out;
}

/** The four inner corners (world centres of the landmark lots): go, jail, parking, gotojail. */
export const LANDMARK_LOTS = {
  go: { x: 3.98, z: 3.98 },
  jail: { x: -3.98, z: 3.98 },
  parking: { x: -3.98, z: -3.98 },
  gotojail: { x: 3.98, z: -3.98 },
};

function drawCentre(g, board) {
  const c0 = CORNER;
  const c1 = UNITS - CORNER;
  g.fillStyle = COLORS.centre;
  g.fillRect(c0, c0, c1 - c0, c1 - c0);

  const roundRect = (x, y, w, h, r) => {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  };

  // The dice plaza: a softly paved circle.
  g.fillStyle = '#d9eedb';
  g.beginPath();
  g.arc(HALF, HALF, 2.55, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(22, 60, 38, 0.1)';
  g.lineWidth = 0.02;
  for (const r of [0.9, 1.7, 2.55]) {
    g.beginPath();
    g.arc(HALF, HALF, r, 0, Math.PI * 2);
    g.stroke();
  }

  // Landmark lots in the inner corners (bank, power plant, fairground, water tower).
  const lot = (p, fill, edge) => {
    const x = HALF + p.x - 0.5;
    const y = HALF + p.z - 0.5;
    g.fillStyle = fill;
    roundRect(x, y, 1, 1, 0.12);
    g.fill();
    g.strokeStyle = edge;
    g.lineWidth = 0.025;
    g.stroke();
  };
  lot(LANDMARK_LOTS.go, '#ece3cf', '#bfae8a');
  lot(LANDMARK_LOTS.jail, '#cfd1cc', '#9da19b');
  lot(LANDMARK_LOTS.parking, '#f1e2bd', '#d4b879');
  lot(LANDMARK_LOTS.gotojail, '#b6dca6', '#86b877');

  // Parks between the districts.
  for (const p of districtGaps(board)) {
    const a = districtPoint(p, p.a0, DISTRICT_IN);
    const b = districtPoint(p, p.a1, DISTRICT_OUT);
    const x = Math.min(a.x, b.x) + HALF;
    const y = Math.min(a.z, b.z) + HALF;
    const w = Math.abs(a.x - b.x);
    const h = Math.abs(a.z - b.z);
    g.fillStyle = '#a9d89a';
    roundRect(x, y, w, h, 0.1);
    g.fill();
    g.strokeStyle = '#86bd76';
    g.lineWidth = 0.02;
    g.stroke();
    g.strokeStyle = '#efe6cf';
    g.lineWidth = 0.05;
    g.beginPath();
    if (p.horizontal) {
      g.moveTo(x + 0.08, y + h / 2);
      g.lineTo(x + w - 0.08, y + h / 2);
    } else {
      g.moveTo(x + w / 2, y + 0.08);
      g.lineTo(x + w / 2, y + h - 0.08);
    }
    g.stroke();
  }

  // One lot per colour group: pale pavement tinted with the group colour, plot lines.
  for (const d of districts(board)) {
    const a = districtPoint(d, d.a0, DISTRICT_IN);
    const b = districtPoint(d, d.a1, DISTRICT_OUT);
    const x = Math.min(a.x, b.x) + HALF;
    const y = Math.min(a.z, b.z) + HALF;
    const w = Math.abs(a.x - b.x);
    const h = Math.abs(a.z - b.z);
    g.fillStyle = '#e7e3d6';
    roundRect(x, y, w, h, 0.08);
    g.fill();
    g.globalAlpha = 0.28;
    g.fillStyle = d.color;
    g.fill();
    g.globalAlpha = 0.85;
    g.strokeStyle = d.color;
    g.lineWidth = 0.03;
    g.stroke();
    g.globalAlpha = 1;
  }

  // The ring road with sidewalks and kerbs (cars drive on it: city.js).
  const road = () => roundRect(HALF - ROAD_R, HALF - ROAD_R, 2 * ROAD_R, 2 * ROAD_R, ROAD_CORNER);
  road();
  g.strokeStyle = '#b9b2a2';
  g.lineWidth = ROAD_W + 0.24;
  g.stroke();
  g.strokeStyle = '#e4ded0';
  g.lineWidth = ROAD_W + 0.2;
  g.stroke();
  g.strokeStyle = '#6f7773';
  g.lineWidth = ROAD_W;
  g.stroke();
  g.setLineDash([0.12, 0.1]);
  g.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  g.lineWidth = 0.02;
  g.stroke();
  g.setLineDash([]);

  // Deck spots.
  for (const [deck, spot] of Object.entries(DECK_SPOTS)) {
    g.save();
    g.translate(spot.u, spot.v);
    g.rotate(spot.rot);
    g.setLineDash([0.08, 0.06]);
    g.strokeStyle = deck === 'chance' ? COLORS.chance : COLORS.community;
    g.lineWidth = 0.035;
    g.strokeRect(-spot.w / 2 - 0.08, -spot.h / 2 - 0.08, spot.w + 0.16, spot.h + 0.16);
    g.setLineDash([]);
    g.fillStyle = COLORS.muted;
    setFont(g, 0.13, 800);
    g.textAlign = 'center';
    g.textBaseline = 'top';
    fillText(g, deck === 'chance' ? 'CHANCE' : 'COMMUNITY CHEST', 0, spot.h / 2 + 0.14);
    g.restore();
  }

  // Wordmark across the anti-diagonal: plain type, not the trademark banner, kept modest so the
  // town reads as the centrepiece.
  g.save();
  g.translate(UNITS / 2, UNITS / 2);
  g.rotate(-Math.PI / 4);
  g.fillStyle = 'rgba(22, 60, 38, 0.85)';
  setFont(g, 0.78, 900);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  fillText(g, 'MONOPOLY', 0, 0.02);
  g.lineWidth = 0.03;
  g.strokeStyle = 'rgba(22, 60, 38, 0.3)';
  g.strokeRect(-2.55, -0.6, 5.1, 1.2);
  g.restore();
}

/** A faint printed-card grain over the whole face (keeps large flat areas from looking plastic). */
function drawGrain(g, size) {
  let seed = 99;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  const n = Math.round((size * size) / 700);
  for (let k = 0; k < n; k++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,0.05)';
    const w = 1 + rnd() * (size / 1024);
    g.fillRect(rnd() * size, rnd() * size, w, w);
  }
  g.restore();
}
