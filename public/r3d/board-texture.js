// public/r3d/board-texture.js — draws the whole board face into ONE canvas (uploaded once as the
// slab's top texture). Everything that changes during a game (owners, houses, mortgages, highlights)
// is a separate 3D object, so this canvas is drawn once per renderer instance (~5 ms at 2048 px).
//
// Canvas pixels map 1:1 onto the 2D renderer's uv units (u → right, v → down), which is also how the
// top face of the slab is UV-mapped, so tile i sits exactly at layout.tileRect(i).

import {
  UNITS, CORNER, BAND, JAIL_STRIP, DECK_SPOTS, HALF, ROAD_R, ROAD_W, ROAD_CORNER, DISTRICT_IN, DISTRICT_OUT,
  sideOf, tileRect, districts, districtPoint,
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
  g.rotate(CORNER_ANGLE[i] ?? 0);
  g.fillStyle = COLORS.ink;
  if (tile.type === 'go') {
    setFont(g, 0.11, 700);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    wrapText(g, `COLLECT ${money(board.goSalary ?? 200)} SALARY AS YOU PASS`, -0.44, 1.2, 0.11, { weight: 700 });
    g.fillStyle = COLORS.accent;
    setFont(g, 0.62, 900);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    fillText(g, 'GO', 0, 0.12);
    g.strokeStyle = COLORS.ink;
    fillText(g, 'GO', 0, 0.12, 0.02);
    // Travel arrow along the bottom row (points left, drawn in board axes).
    g.rotate(-(CORNER_ANGLE[i] ?? 0));
    g.fillStyle = COLORS.accent;
    g.beginPath();
    g.moveTo(-0.62, 0.52);
    g.lineTo(-0.3, 0.34);
    g.lineTo(-0.3, 0.46);
    g.lineTo(0.52, 0.46);
    g.lineTo(0.52, 0.58);
    g.lineTo(-0.3, 0.58);
    g.lineTo(-0.3, 0.7);
    g.closePath();
    g.fill();
  } else if (tile.type === 'free_parking') {
    wrapText(g, 'FREE', -0.5, 1.2, 0.2, { baseline: 'middle' });
    drawCar(g, 0, 0.02, 0.62);
    g.fillStyle = COLORS.ink;
    wrapText(g, 'PARKING', 0.5, 1.2, 0.2, { baseline: 'middle' });
  } else if (tile.type === 'go_to_jail') {
    wrapText(g, 'GO TO', -0.5, 1.2, 0.2, { baseline: 'middle' });
    drawBadge(g, 0, 0.02, 0.5);
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
  g.strokeStyle = COLORS.line;
  g.lineWidth = 0.03;
  g.strokeRect(cx, cy, cw, cw);
  g.save();
  g.translate(cx + cw / 2, cy + cw / 2);
  g.rotate(Math.PI / 4);
  g.fillStyle = COLORS.ink;
  wrapText(g, 'IN JAIL', 0, 1.0, 0.2, { baseline: 'middle' });
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
  g.fillStyle = COLORS.accent;
  g.strokeStyle = COLORS.ink;
  g.lineWidth = 0.05;
  g.beginPath();
  g.moveTo(-0.5, 0.1);
  g.lineTo(-0.44, -0.08);
  g.lineTo(-0.2, -0.12);
  g.lineTo(-0.08, -0.32);
  g.lineTo(0.24, -0.32);
  g.lineTo(0.36, -0.12);
  g.lineTo(0.5, -0.06);
  g.lineTo(0.5, 0.1);
  g.closePath();
  g.fill();
  g.stroke();
  g.fillStyle = COLORS.ink;
  for (const cx of [-0.28, 0.3]) {
    g.beginPath();
    g.arc(cx, 0.12, 0.12, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

function drawBadge(g, x, y, s) {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.fillStyle = '#1d3f8f';
  g.strokeStyle = COLORS.ink;
  g.lineWidth = 0.05;
  g.beginPath();
  g.moveTo(-0.46, -0.1);
  g.quadraticCurveTo(0, -0.62, 0.46, -0.1); // cap
  g.lineTo(0.5, 0.02);
  g.lineTo(-0.5, 0.02);
  g.closePath();
  g.fill();
  g.stroke();
  g.fillStyle = '#111';
  g.fillRect(-0.52, 0.02, 1.04, 0.1); // visor
  g.fillStyle = '#f4c542';
  g.beginPath();
  g.arc(0, -0.2, 0.1, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

// ---- centre ------------------------------------------------------------------------------------

function drawCentre(g, board) {
  const c0 = CORNER;
  const c1 = UNITS - CORNER;
  g.fillStyle = COLORS.centre;
  g.fillRect(c0, c0, c1 - c0, c1 - c0);

  // The city's ring road (cars drive on it: city.js) and one plot per colour group.
  const roundRect = (x, y, w, h, r) => {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  };
  roundRect(HALF - ROAD_R, HALF - ROAD_R, 2 * ROAD_R, 2 * ROAD_R, ROAD_CORNER);
  g.strokeStyle = '#7d8581';
  g.lineWidth = ROAD_W;
  g.stroke();
  g.setLineDash([0.12, 0.1]);
  g.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  g.lineWidth = 0.02;
  g.stroke();
  g.setLineDash([]);
  for (const d of districts(board)) {
    const a = districtPoint(d, d.a0, DISTRICT_IN);
    const b = districtPoint(d, d.a1, DISTRICT_OUT);
    const x = Math.min(a.x, b.x) + HALF;
    const y = Math.min(a.z, b.z) + HALF;
    const w = Math.abs(a.x - b.x);
    const h = Math.abs(a.z - b.z);
    g.globalAlpha = 0.3;
    g.fillStyle = d.color;
    roundRect(x, y, w, h, 0.08);
    g.fill();
    g.globalAlpha = 0.7;
    g.strokeStyle = d.color;
    g.lineWidth = 0.03;
    g.stroke();
    g.globalAlpha = 1;
  }

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

  // Wordmark across the anti-diagonal: plain type, not the trademark banner.
  g.save();
  g.translate(UNITS / 2, UNITS / 2);
  g.rotate(-Math.PI / 4);
  g.fillStyle = 'rgba(22, 60, 38, 0.9)';
  setFont(g, 1.05, 900);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  fillText(g, 'MONOPOLY', 0, 0.02);
  g.lineWidth = 0.035;
  g.strokeStyle = 'rgba(22, 60, 38, 0.35)';
  g.strokeRect(-3.35, -0.78, 6.7, 1.56);
  g.restore();
}
