// public/renderer2d.js — the 2D board renderer.
//
// Contract (docs/CONTRACT.md §8):
//   * exports ONLY render(state, events, myPlayerId)
//   * owns every DOM node inside <div id="board">; no other module touches it
//   * loads the board itself (GET /api/board) and injects its own stylesheet (/renderer2d.css)
// A future Three.js renderer replaces this file and renderer2d.css with no other changes, so all
// knowledge of how the board is laid out and drawn lives here.
//
// Model: the static board (40 tiles + centre panel) is built once. Every render() diffs the public
// state against what is on screen and touches only what changed. State is the truth; events only
// drive short presentation effects (token hops, dice tumble, card popup).

const PALETTE = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#e84393'];

const HOP_MS = 110; // one square of a dice walk
const TELEPORT_MS = 450; // direct moves: cards, jail, settling, shuffling within a tile
const DICE_MS = 520; // dice tumble
const CARD_MS = 4000; // how long a drawn card stays up
const LOG_LINES = 8;

// Board geometry in "units": 1.5 per corner + 9 × 1 per edge tile = 12 per side.
// These must match the grid tracks and sizes in renderer2d.css.
const UNITS = 12;
const CORNER = 1.5;
const BAND = 0.3; // colour band depth (2.5cqi in CSS)
const JAIL_STRIP = 0.46; // "just visiting" strip inside the jail corner (30.67% in CSS)
const TOKEN_GAP = 0.5; // max distance between tokens sharing a spot

const ICONS = { chance: '❓', community: '📦', tax: '💰', railroad: '🚂' };
const money = (n) => `$${(Number(n) || 0).toLocaleString('en-US')}`; // "$1,400", as in the side panel

// Short tile labels for phone-sized boards, where full names would be tiny (renderer2d.css swaps
// them in): generic words dropped, whole words only, long words cut to fit ("Mediterranean" → "Medite.").
const GENERIC_WORDS = /^(avenue|ave\.?|place|railroad|company|gardens|works|tax|st\.)$/i;
const SHORT_CHARS = { top: 7, bottom: 7, left: 9, right: 9 }; // characters per line that fit at ~7px

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let BOARD = null; // parsed board.json
let JAIL = 10; // jail tile index
let groupTiles = {}; // group id → tile indices
let root = null; // <div class="r2d">, lives inside #board
let tokenLayer = null;
const tiles = []; // tile index → { node, bldg, pot, ownable, sig }
let center = null; // centre panel element refs + render caches
const tokens = new Map(); // playerId → token record (see createToken)
let gameId; // id of the game on screen (undefined until the first render)
let lastSeq = null; // seq whose events have already been played
let lastArgs = null; // [state, myPlayerId] of the latest render, for a late board load
let boardRetry = null;
let info = null; // tile info card (tap / click a tile): { card, index, ctx, sig }

injectStylesheet();
BOARD = await loadBoard();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Draws the public game state (CONTRACT §7) into #board. Cheap and idempotent: call it after every
 * state message. `events` (CONTRACT §6) only add animation; the result always converges on `state`.
 */
export function render(state, events, myPlayerId) {
  try {
    draw(state, Array.isArray(events) ? events : [], myPlayerId ?? null);
  } catch (err) {
    // A rendering bug must never take the rest of the UI down with it.
    console.error('[renderer2d] render failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function injectStylesheet() {
  if (document.querySelector('link[href$="renderer2d.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/renderer2d.css';
  document.head.append(link);
}

// Never rejects: a failed import would break ui.js entirely. render() retries while BOARD is null.
async function loadBoard() {
  try {
    const res = await fetch('/api/board');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const board = await res.json();
    if (!Array.isArray(board?.tiles) || board.tiles.length !== 40) throw new Error('unexpected board data');
    return board;
  } catch (err) {
    console.warn('[renderer2d] could not load /api/board:', err);
    return null;
  }
}

function retryBoardLoad() {
  if (boardRetry) return;
  boardRetry = setTimeout(async () => {
    BOARD = await loadBoard();
    boardRetry = null;
    if (BOARD && lastArgs) render(lastArgs[0], [], lastArgs[1]);
  }, 2000);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Write-only-if-changed helpers: render() runs on every state message, so skip no-op DOM writes.
function setHidden(node, hidden) {
  if (node.hidden !== hidden) node.hidden = hidden;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function setData(node, key, value) {
  const v = String(value);
  if (node.dataset[key] !== v) node.dataset[key] = v;
}

function dropClass(node, name) {
  if (node.classList.contains(name)) node.classList.remove(name);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** 0-based [column, row] of tile i: GO bottom-right, then clockwise (left along the bottom first). */
function cellOf(i) {
  if (i <= 10) return [10 - i, 10];
  if (i <= 20) return [0, 20 - i];
  if (i <= 30) return [i - 20, 0];
  return [10, i - 30];
}

function sideOf(i) {
  if (i % 10 === 0) return 'corner';
  return ['bottom', 'left', 'top', 'right'][Math.floor(i / 10)];
}

const trackStart = (c) => (c === 0 ? 0 : CORNER + c - 1);
const trackSize = (c) => (c === 0 || c === 10 ? CORNER : 1);

/** Tile rectangle in board units. */
function tileRect(i) {
  const [c, r] = cellOf(i);
  return { x: trackStart(c), y: trackStart(r), w: trackSize(c), h: trackSize(r) };
}

/** Where tokens may stand on a tile: the tile minus its colour band (on the inner edge). */
function tokenArea(i) {
  const a = tileRect(i);
  const side = sideOf(i);
  if (side === 'bottom') { a.y += BAND; a.h -= BAND; }
  if (side === 'top') a.h -= BAND;
  if (side === 'left') a.w -= BAND;
  if (side === 'right') { a.x += BAND; a.w -= BAND; }
  return a;
}

// The jail corner (bottom-left): the cell is the square toward the board centre; visitors stand
// on the L-shaped strip along its outer edges.
const JAIL_CELL = { x: JAIL_STRIP, y: UNITS - CORNER, w: CORNER - JAIL_STRIP, h: CORNER - JAIL_STRIP };

/** A token spot: a tile, plus whether it is inside the jail cell (only meaningful on the jail tile). */
function makeSpot(index, jailed) {
  const i = Number.isInteger(index) ? ((index % 40) + 40) % 40 : 0;
  return { index: i, jailed: !!jailed && i === JAIL };
}

const spotKey = (s) => (s.jailed ? `${s.index}j` : `${s.index}`);

/** Centre (in units) of the k-th of n tokens sharing a spot. */
function slotCenter(spot, k, n) {
  if (spot.index === 10 && JAIL === 10) return spot.jailed ? gridSlot(JAIL_CELL, k, n) : visitingSlot(k, n);
  return gridSlot(tokenArea(spot.index), k, n);
}

/** Lays n tokens out in the grid that keeps them furthest apart inside `area`, clustered at its centre. */
function gridSlot(area, k, n) {
  let cols = 1;
  let best = 0;
  for (let c = 1; c <= n; c++) {
    const size = Math.min(area.w / c, area.h / Math.ceil(n / c));
    if (size > best + 1e-6) { best = size; cols = c; }
  }
  const rows = Math.ceil(n / cols);
  const row = Math.floor(k / cols);
  const inRow = row === rows - 1 ? n - row * cols : cols; // a short last row is centred
  const dx = Math.min(area.w / cols, TOKEN_GAP);
  const dy = Math.min(area.h / rows, TOKEN_GAP);
  return [
    area.x + area.w / 2 + ((k % cols) - (inRow - 1) / 2) * dx,
    area.y + area.h / 2 + (row - (rows - 1) / 2) * dy,
  ];
}

/** Visitors fill the jail corner's L-shaped outer strip, from the corner outward (up / right alternately). */
function visitingSlot(k, n) {
  const cx = JAIL_STRIP / 2;
  const cy = UNITS - JAIL_STRIP / 2;
  if (k === 0) return [cx, cy];
  const perArm = Math.ceil((n - 1) / 2);
  const gap = Math.min(TOKEN_GAP, (CORNER - JAIL_STRIP) / perArm);
  const d = Math.ceil(k / 2) * gap;
  return k % 2 ? [cx, cy - d] : [cx + d, cy];
}

const pct = (u) => `${((u / UNITS) * 100).toFixed(3)}%`;

// ---------------------------------------------------------------------------
// Static board (built once)
// ---------------------------------------------------------------------------

function build() {
  JAIL = Number.isInteger(BOARD.jailIndex) ? BOARD.jailIndex : 10;
  groupTiles = {};
  for (const t of BOARD.tiles) if (t.group) (groupTiles[t.group] ??= []).push(t.index);

  root = el('div', 'r2d');
  root.lang = 'en'; // lets the browser hyphenate long tile names
  root.setAttribute('aria-label', 'Game board');
  BOARD.tiles.forEach((tile, i) => root.append(buildTile(tile, i)));
  root.append(buildCenter());
  tokenLayer = el('div', 'r2d-tokens');
  root.append(tokenLayer);
  buildInfoCard();
}

function isOwnable(tile) {
  return tile.type === 'property' || tile.type === 'railroad' || tile.type === 'utility';
}

function iconOf(tile) {
  if (tile.type === 'utility') return /water/i.test(tile.name) ? '🚰' : '💡';
  return ICONS[tile.type] ?? '';
}

/**
 * Scales a tile name down when its longest word would not fit the tile's width
 * (narrow tiles on the top/bottom rows fit ~10 characters per line, side tiles ~13).
 */
function nameFit(name, side) {
  const longest = Math.max(1, ...String(name).split(/\s+/).map((w) => w.length));
  const room = side === 'left' || side === 'right' ? 13 : 10.5;
  return Math.min(1, room / longest).toFixed(2);
}

/** Phone label: "St. Charles Place" → "Charles", "B. & O. Railroad" → "B&O", "Connecticut Avenue" → "Connec.". */
function shortName(name, side) {
  const max = SHORT_CHARS[side] ?? 7;
  let words = String(name).split(/\s+/).filter((w) => w && !GENERIC_WORDS.test(w));
  if (!words.length) words = String(name).split(/\s+/).slice(0, 1);
  if (words.every((w) => w.replace(/\./g, '').length <= 1)) words = [words.join('').replace(/\./g, '')]; // initials
  return words.slice(0, 2).map((w) => (w.length > max ? `${w.slice(0, max - 1)}.` : w)).join(' ');
}

function buildTile(tile, i) {
  const side = sideOf(i);
  const [c, r] = cellOf(i);
  const node = el('div', `r2d-tile r2d-side-${side} r2d-type-${tile.type}`);
  node.style.gridArea = `${r + 1} / ${c + 1}`;
  node.dataset.index = i;
  const refs = { node, ownable: isOwnable(tile), sig: null };

  if (side === 'corner') {
    buildCorner(tile, node, refs);
  } else {
    if (tile.type === 'property') {
      const band = el('div', 'r2d-band');
      band.style.background = BOARD.groups?.[tile.group]?.color ?? '#999';
      refs.bldg = el('div', 'r2d-bldg');
      band.append(refs.bldg);
      node.append(band);
    }
    const body = el('div', 'r2d-body');
    const name = el('div', 'r2d-name');
    name.append(el('span', 'r2d-name-full', tile.name), el('span', 'r2d-name-short', shortName(tile.name, side)));
    name.style.setProperty('--fit', nameFit(tile.name, side));
    body.append(name);
    const icon = iconOf(tile);
    if (icon) body.append(el('div', 'r2d-icon', icon));
    if (tile.price != null) body.append(el('div', 'r2d-price', `$${tile.price}`));
    else if (tile.type === 'tax') {
      const tax = el('div', 'r2d-price r2d-tax');
      tax.append(el('span', 'r2d-tax-pay', 'Pay '), `$${tile.amount}`); // phones drop the "Pay"
      body.append(tax);
    }
    node.append(body);
  }
  if (refs.ownable) node.append(el('div', 'r2d-owner'), el('div', 'r2d-mbadge', 'M'));
  node.title = tileTitle(tile, null);
  tiles[i] = refs;
  return node;
}

function buildCorner(tile, node, refs) {
  if (tile.type === 'jail') {
    const cell = el('div', 'r2d-jail-cell');
    cell.append(el('span', 'r2d-jail-label', 'In jail'));
    node.append(cell, el('div', 'r2d-just', 'Just'), el('div', 'r2d-visiting', 'Visiting'));
    return;
  }
  const body = el('div', 'r2d-cbody');
  if (tile.type === 'go') {
    body.append(
      el('div', 'r2d-go-small', `Collect $${BOARD.goSalary} salary as you pass`),
      el('div', 'r2d-go', 'GO'),
      el('div', 'r2d-go-arrow', '←'),
    );
  } else if (tile.type === 'free_parking') {
    refs.pot = el('div', 'r2d-pot-badge');
    refs.pot.hidden = true;
    body.append(el('div', 'r2d-cicon', '🅿️'), el('div', 'r2d-clabel', tile.name), refs.pot);
  } else if (tile.type === 'go_to_jail') {
    body.append(el('div', 'r2d-cicon', '👮'), el('div', 'r2d-clabel', tile.name));
  } else {
    body.append(el('div', 'r2d-clabel', tile.name));
  }
  node.append(body);
}

function buildCenter() {
  const node = el('div', 'r2d-center');
  const die = () => {
    const d = el('div', 'r2d-die');
    for (let k = 0; k < 9; k++) d.append(el('i'));
    d.dataset.v = '0';
    return d;
  };
  center = {
    turn: el('div', 'r2d-turn'),
    dice: el('div', 'r2d-dice'),
    d1: die(),
    d2: die(),
    doubles: el('div', 'r2d-doubles', 'Doubles!'),
    pot: el('div', 'r2d-pot'),
    log: el('ol', 'r2d-log'),
    winner: el('div', 'r2d-winner'),
    card: el('div', 'r2d-card'),
    sig: {}, // last rendered signature per part
    diceTimer: null,
    diceTarget: null,
    cardQueue: [],
    cardTimer: null,
    cardShowing: false,
  };
  center.dice.append(center.d1, center.d2, center.doubles);
  center.card.setAttribute('role', 'status');
  center.card.addEventListener('click', () => nextCard());
  for (const part of [center.turn, center.dice, center.pot, center.log, center.winner]) part.hidden = true;
  node.append(el('div', 'r2d-title', 'MONOPOLY'), center.turn, center.dice, center.pot, center.log,
    center.winner, center.card);
  return node;
}

// ---------------------------------------------------------------------------
// Per-render update
// ---------------------------------------------------------------------------

function draw(state, events, me) {
  lastArgs = [state, me];
  const host = document.getElementById('board');
  if (!host) return;
  if (!BOARD) {
    if (!host.querySelector('.r2d-loading')) host.replaceChildren(el('div', 'r2d-loading', 'Loading board…'));
    retryBoardLoad();
    return;
  }
  if (!root) build();
  if (root.parentNode !== host) host.replaceChildren(root);
  if (!state || typeof state !== 'object') return;

  if (state.id !== gameId) resetGame(state.id);
  // Each engine action bumps seq; re-rendering the same seq must not replay its events.
  if (typeof state.seq === 'number') {
    if (state.seq === lastSeq) events = [];
    lastSeq = state.seq;
  }

  const players = Array.isArray(state.players) ? state.players : [];
  const turn = state.turn && typeof state.turn === 'object' ? state.turn : {};
  const order = Array.isArray(turn.order) ? turn.order : [];
  const ctx = {
    state,
    turn,
    events,
    me,
    players,
    byId: new Map(players.map((p) => [p.id, p])),
    colorOf: new Map(players.map((p, i) => [p.id, PALETTE[i % PALETTE.length]])),
    tileState: new Map((Array.isArray(state.tiles) ? state.tiles : []).map((t) => [t?.index, t])),
    live: state.status === 'active' || state.status === 'finished',
    active: state.status === 'active',
    currentId: order[turn.currentIndex] ?? null,
  };

  drawTiles(ctx);
  drawInfo(ctx);
  drawTokens(ctx);
  drawTurn(ctx);
  drawDice(ctx);
  drawPot(ctx);
  drawLog(ctx);
  drawWinner(ctx);
  queueCards(ctx);
}

/** A different game is on screen: forget tokens, animations and caches. */
function resetGame(id) {
  gameId = id;
  lastSeq = null;
  closeInfo();
  for (const t of tokens.values()) {
    stopWalk(t);
    t.el.remove();
  }
  tokens.clear();
  for (const refs of tiles) if (refs) refs.sig = null;
  center.sig = {};
  stopTumble();
  clearTimeout(center.cardTimer);
  center.cardQueue.length = 0;
  center.cardShowing = false;
  center.card.classList.remove('is-visible');
}

// --- tiles -----------------------------------------------------------------

function drawTiles(ctx) {
  const pending = ctx.active ? ctx.turn.pendingPurchase : null;
  BOARD.tiles.forEach((tile, i) => {
    const refs = tiles[i];
    if (!refs.ownable) return;
    const ts = ctx.tileState.get(i);
    const owner = (ts?.ownerId && ctx.byId.get(ts.ownerId)) || null;
    const color = owner ? ctx.colorOf.get(owner.id) : '';
    const houses = owner ? Math.max(0, Math.min(5, Math.trunc(Number(ts.houses)) || 0)) : 0;
    const mortgaged = !!(owner && ts.mortgaged);
    const isPending = pending === i;
    const title = tileTitle(tile, ctx, owner, houses, mortgaged);
    const sig = `${color}|${houses}|${mortgaged}|${isPending}|${title}`;
    if (refs.sig === sig) return;
    refs.sig = sig;

    const { node } = refs;
    node.classList.toggle('is-owned', !!owner);
    node.classList.toggle('is-mortgaged', mortgaged);
    node.classList.toggle('is-pending', isPending);
    if (color) node.style.setProperty('--owner', color);
    else node.style.removeProperty('--owner');
    if (refs.bldg) {
      const blds = houses === 5 ? [el('i', 'r2d-hotel')] : Array.from({ length: houses }, () => el('i', 'r2d-house'));
      refs.bldg.replaceChildren(...blds);
    }
    node.title = title;
  });
}

/** Tooltip text: static facts, plus owner and current rent when `ctx` is given. */
function tileTitle(tile, ctx, owner = null, houses = 0, mortgaged = false) {
  const { facts, status } = tileInfo(tile, ctx, owner, houses, mortgaged);
  return [tile.name, ...facts, ...status].join('\n');
}

/** What the tooltip and the info card say: static `facts`, and `status` (owner, buildings, rent now) with `ctx`. */
function tileInfo(tile, ctx, owner = null, houses = 0, mortgaged = false) {
  const lines = [];
  const rent = Array.isArray(tile.rent) ? tile.rent : [];
  switch (tile.type) {
    case 'property':
      lines.push(`Price ${money(tile.price)} · house ${money(tile.houseCost)} · mortgage ${money(tile.mortgage)}`);
      lines.push(`Rent ${money(rent[0])} (${money(rent[0] * 2)} with the full color set)`);
      lines.push(`1–4 houses ${rent.slice(1, 5).map(money).join(' / ')} · hotel ${money(rent[5])}`);
      break;
    case 'railroad':
      lines.push(`Price ${money(tile.price)} · mortgage ${money(tile.mortgage)}`);
      lines.push(`Rent ${rent.map(money).join(' / ')} for 1–${rent.length} railroads owned`);
      break;
    case 'utility': {
      const m = tile.multipliers ?? [];
      lines.push(`Price ${money(tile.price)} · mortgage ${money(tile.mortgage)}`);
      lines.push(`Rent ${m[0]}× dice with one utility, ${m[1]}× with both`);
      break;
    }
    case 'go': lines.push(`Collect $${BOARD.goSalary} salary as you pass`); break;
    case 'jail': lines.push(`Get out: pay $${BOARD.jailFine}, use a card or roll doubles`); break;
    case 'go_to_jail': lines.push('Go directly to jail. Do not pass GO.'); break;
    case 'chance':
    case 'community': lines.push('Draw a card'); break;
    case 'tax': lines.push(`Pay $${tile.amount}`); break;
    default: break;
  }
  const status = [];
  if (ctx && isOwnable(tile)) {
    if (!owner) {
      status.push('Unowned');
    } else {
      status.push(`Owner: ${owner.name}${mortgaged ? ' (mortgaged)' : ''}`);
      if (houses) status.push(houses === 5 ? 'Hotel' : `${houses} house${houses > 1 ? 's' : ''}`);
      status.push(mortgaged ? 'No rent while mortgaged' : `Rent now: ${currentRent(tile, ctx, owner.id, houses)}`);
    }
  }
  return { facts: lines, status };
}

function currentRent(tile, ctx, ownerId, houses) {
  const rent = Array.isArray(tile.rent) ? tile.rent : [];
  const ownedBy = (i) => ctx.tileState.get(i)?.ownerId === ownerId;
  if (tile.type === 'property') {
    if (houses > 0) return money(rent[houses]);
    const fullSet = (groupTiles[tile.group] ?? []).every(ownedBy);
    return money((rent[0] ?? 0) * (fullSet ? 2 : 1));
  }
  const count = BOARD.tiles.filter((t, i) => t.type === tile.type && ownedBy(i)).length;
  if (tile.type === 'railroad') return money(rent[Math.min(count, rent.length) - 1]);
  return `${tile.multipliers?.[count - 1] ?? '?'}× dice`;
}

// --- tile info card ----------------------------------------------------------
// Tapping (or clicking) a tile opens a small card next to it with the tooltip's facts: price, owner,
// buildings and rent right now — the only way to see them on touch screens. The next tap anywhere
// closes it (a tap on another tile moves it there); it follows state changes while open.

function buildInfoCard() {
  const card = el('div', 'r2d-info');
  card.hidden = true;
  card.setAttribute('role', 'status');
  root.append(card);
  info = { card, index: null, ctx: null, sig: '' };
  root.addEventListener('click', onBoardClick);
  document.addEventListener('click', (e) => {
    if (info.index != null && !root.contains(e.target)) closeInfo();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && info.index != null) closeInfo();
  });
  window.addEventListener('resize', () => placeInfo());
}

function onBoardClick(e) {
  const target = e.target;
  let index = null;
  if (!target.closest('.r2d-info')) {
    const tile = target.closest('.r2d-tile');
    const token = target.closest('.r2d-token');
    if (tile) index = Number(tile.dataset.index);
    else if (token) index = [...tokens.values()].find((t) => t.el === token)?.spot.index ?? null;
  }
  if (index == null || index === info.index) closeInfo();
  else openInfo(index);
}

function openInfo(index) {
  if (info.index != null) dropClass(tiles[info.index].node, 'is-inspected');
  info.index = index;
  info.sig = '';
  tiles[index].node.classList.add('is-inspected');
  drawInfo(info.ctx);
}

function closeInfo() {
  if (!info || info.index == null) return;
  dropClass(tiles[info.index].node, 'is-inspected');
  info.index = null;
  info.sig = '';
  setHidden(info.card, true);
}

function drawInfo(ctx) {
  info.ctx = ctx;
  const i = info.index;
  if (i == null || !ctx) return;
  const tile = BOARD.tiles[i];
  const ts = ctx.tileState.get(i);
  const owner = (ts?.ownerId && ctx.byId.get(ts.ownerId)) || null;
  const houses = owner ? Math.max(0, Math.min(5, Math.trunc(Number(ts.houses)) || 0)) : 0;
  const mortgaged = !!(owner && ts.mortgaged);
  const { facts, status } = tileInfo(tile, ctx.live ? ctx : null, owner, houses, mortgaged);
  const band = tile.type === 'property' ? BOARD.groups?.[tile.group]?.color ?? '' : '';
  const color = owner ? ctx.colorOf.get(owner.id) : '';
  const sig = JSON.stringify([i, band, color, facts, status]);
  if (sig === info.sig) return;
  info.sig = sig;

  const { card } = info;
  const head = el('div', 'r2d-info-head');
  if (band) head.style.setProperty('--band', band);
  head.append(el('span', 'r2d-info-name', tile.name));
  const statusBox = el('div', 'r2d-info-status');
  status.forEach((line, k) => {
    const row = el('div', k === status.length - 1 && owner ? 'r2d-info-rent' : null, line);
    if (k === 0 && owner) {
      row.className = 'r2d-info-owner';
      row.style.setProperty('--owner', color);
    }
    statusBox.append(row);
  });
  const factsBox = el('div', 'r2d-info-facts');
  factsBox.append(...facts.map((line) => el('div', null, line)));
  card.replaceChildren(head, ...(status.length ? [statusBox] : []), factsBox);
  setHidden(card, false);
  placeInfo();
}

/** Puts the card beside its tile, toward the board centre, and keeps it on the board. */
function placeInfo() {
  if (!info || info.index == null || info.card.hidden) return;
  const { card } = info;
  const size = root.clientWidth;
  if (!size) return;
  const u = size / UNITS;
  const r = tileRect(info.index);
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  const gap = 0.15 * u;
  const cx = (r.x + r.w / 2) * u;
  const cy = (r.y + r.h / 2) * u;
  let x = cx - w / 2;
  let y = cy - h / 2;
  const side = sideOf(info.index);
  if (side === 'bottom' || (side === 'corner' && cy > size / 2)) y = r.y * u - h - gap;
  if (side === 'top' || (side === 'corner' && cy < size / 2)) y = (r.y + r.h) * u + gap;
  if (side === 'left' || (side === 'corner' && cx < size / 2)) x = (r.x + r.w) * u + gap;
  if (side === 'right' || (side === 'corner' && cx > size / 2)) x = r.x * u - w - gap;
  const clamp = (v, extent) => Math.max(gap, Math.min(v, size - extent - gap));
  card.style.left = pct((clamp(x, w) / size) * UNITS);
  card.style.top = pct((clamp(y, h) / size) * UNITS);
}

// --- tokens ----------------------------------------------------------------

function createToken(id) {
  const node = el('div', 'r2d-token');
  const inner = el('div', 'r2d-token-inner');
  node.append(inner);
  node.hidden = true;
  tokenLayer.append(node);
  return {
    id,
    el: node,
    inner,
    order: 0, // index in state.players: stable slot order on shared tiles
    spot: makeSpot(0, false), // where the token is drawn right now
    visible: false,
    dur: TELEPORT_MS, // transition length for its next left/top change
    instant: false, // next placement skips the transition
    timers: null, // pending walk steps, if walking
    final: null, // spotKey the running walk ends on
    left: '',
    top: '',
    sig: '',
  };
}

function tokenEmoji(tokenId) {
  return BOARD.tokens?.find((t) => t.id === tokenId)?.emoji ?? '●';
}

function drawTokens(ctx) {
  const { players, events, me, live } = ctx;

  // Create / update / remove token elements.
  const seen = new Set();
  players.forEach((p, i) => {
    seen.add(p.id);
    let t = tokens.get(p.id);
    if (!t) tokens.set(p.id, (t = createToken(p.id)));
    t.order = i;
    const color = ctx.colorOf.get(p.id);
    const sig = `${color}|${p.token}|${p.name}|${p.id === me}`;
    if (t.sig !== sig) {
      t.sig = sig;
      t.el.style.setProperty('--pc', color);
      t.inner.textContent = tokenEmoji(p.token);
      t.el.title = p.id === me ? `${p.name} (you)` : String(p.name ?? '');
      t.el.classList.toggle('is-me', p.id === me);
    }
    t.el.classList.toggle('is-current', ctx.active && p.id === ctx.currentId);
  });
  for (const [id, t] of tokens) {
    if (seen.has(id)) continue;
    stopWalk(t);
    t.el.remove();
    tokens.delete(id);
  }

  // This batch's moves, per player, in order.
  const moves = new Map();
  for (const e of events) {
    if (e?.type !== 'moved' || !tokens.has(e.playerId)) continue;
    if (!moves.has(e.playerId)) moves.set(e.playerId, []);
    moves.get(e.playerId).push(e);
  }
  const delay = walkDelay(events);

  for (const p of players) {
    const t = tokens.get(p.id);
    const truth = makeSpot(p.position, p.inJail);
    if (!live || p.bankrupt) {
      // Lobby shows an empty board; bankrupt players leave it.
      stopWalk(t);
      t.visible = false;
      t.spot = truth;
      continue;
    }
    if (!t.visible) {
      // First sight (first render, reconnect, new game): appear in place, no animation.
      stopWalk(t);
      t.visible = true;
      t.spot = truth;
      t.instant = true;
      continue;
    }
    const mine = moves.get(p.id);
    // Nothing new for a token that is mid-walk to where it should end up: let it finish.
    if (!mine && t.timers && t.final === spotKey(truth)) continue;
    stopWalk(t);
    if (mine && animate()) {
      walk(t, mine, truth, delay);
    } else {
      t.spot = truth;
      t.dur = TELEPORT_MS;
    }
  }
  layoutTokens();
}

/** Let the dice land before a token starts walking. */
function walkDelay(events) {
  const rolled = events.some((e) => e?.type === 'dice_rolled' && e.purpose !== 'utility');
  return rolled ? Math.round(DICE_MS * 0.8) : 0;
}

/** A dice move hops square by square; anything else (cards, jail) glides straight there. */
const isHopMove = (m) => m.via === 'roll' && Number.isInteger(m.steps) && m.steps > 0 && m.steps < 40;

/** How long walk() spends on one `moved` event (matches the step waits below). */
const moveTime = (m) => (isHopMove(m) ? m.steps * HOP_MS : TELEPORT_MS + 120);

/** Plays a player's moves: dice walks hop square by square, teleports glide; then settle on the truth. */
function walk(t, moves, truth, delay) {
  const steps = [];
  for (const m of moves) {
    if (isHopMove(m)) {
      const from = makeSpot(m.from, false).index;
      for (let s = 1; s <= m.steps; s++) steps.push({ spot: makeSpot(from + s, false), dur: HOP_MS, wait: HOP_MS, hop: true });
    } else {
      steps.push({ spot: makeSpot(m.to, m.via === 'jail'), dur: TELEPORT_MS, wait: moveTime(m) });
    }
  }
  steps.push({ spot: truth, dur: TELEPORT_MS, wait: TELEPORT_MS });

  t.final = spotKey(truth);
  t.timers = [];
  t.el.classList.add('is-moving');
  let at = delay;
  for (const step of steps) {
    t.timers.push(setTimeout(() => {
      t.spot = step.spot;
      t.dur = step.dur;
      layoutTokens();
      if (step.hop) hop(t);
    }, at));
    at += step.wait;
  }
  t.timers.push(setTimeout(() => {
    t.timers = null;
    t.final = null;
    t.el.classList.remove('is-moving');
  }, at));
}

/** Cancels a walk in flight; the token then transitions straight to wherever it is sent next. */
function stopWalk(t) {
  if (t.timers) t.timers.forEach(clearTimeout);
  t.timers = null;
  t.final = null;
  t.dur = TELEPORT_MS;
  dropClass(t.el, 'is-moving');
}

function hop(t) {
  t.inner.animate?.(
    [{ transform: 'none' }, { transform: 'translateY(-38%) scale(1.1)' }, { transform: 'none' }],
    { duration: HOP_MS, easing: 'ease-out' },
  );
}

/** Positions every visible token, spreading tokens that share a spot so they don't overlap. */
function layoutTokens() {
  const groups = new Map();
  for (const t of tokens.values()) {
    setHidden(t.el, !t.visible);
    if (!t.visible) continue;
    const key = spotKey(t.spot);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.order - b.order);
    const crowded = group.length > 4; // 5+ tokens on one spot: draw them a bit smaller
    group.forEach((t, k) => {
      const [x, y] = slotCenter(t.spot, k, group.length);
      t.el.classList.toggle('is-crowded', crowded); // toggle(name, force) is a no-op when unchanged
      placeToken(t, pct(x), pct(y));
    });
  }
}

function placeToken(t, left, top) {
  const { el: node } = t;
  if (t.instant) node.classList.add('r2d-instant');
  const dur = `${t.dur}ms`;
  if (node.style.transitionDuration !== dur) node.style.transitionDuration = dur;
  if (t.left !== left) node.style.left = t.left = left;
  if (t.top !== top) node.style.top = t.top = top;
  if (t.instant) {
    void node.offsetWidth; // commit the new position before transitions come back on
    node.classList.remove('r2d-instant');
    t.instant = false;
  }
}

function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

// No hops or tumbles in a background tab: its timers are throttled, so an animation would only
// replay late when the player switches back. Tokens just jump to where they belong.
function animate() {
  return !reducedMotion() && !document.hidden;
}

// --- centre panel ------------------------------------------------------------

function drawTurn(ctx) {
  const { state, me } = ctx;
  const cur = ctx.active ? ctx.byId.get(ctx.currentId) : null;
  const number = Number.isInteger(ctx.turn.number) && ctx.turn.number > 0 ? ctx.turn.number : null;
  let sig = '';
  if (cur) sig = [cur.id, cur.name, cur.token, !!cur.inJail, ctx.colorOf.get(cur.id), cur.id === me, number].join('|');
  else if (ctx.live) sig = state.status;
  if (center.sig.turn === sig) return;
  center.sig.turn = sig;

  const box = center.turn;
  box.hidden = !sig;
  box.replaceChildren();
  if (!cur) {
    box.style.removeProperty('--pc');
    if (sig) box.append(el('span', 'r2d-turn-name', state.status === 'finished' ? 'Game over' : 'Waiting…'));
    return;
  }
  box.style.setProperty('--pc', ctx.colorOf.get(cur.id));
  box.append(
    el('span', 'r2d-turn-token', tokenEmoji(cur.token)),
    el('span', 'r2d-turn-name', cur.id === me ? 'Your turn' : `${cur.name}'s turn`),
  );
  const meta = [cur.inJail && 'in jail', number && `turn ${number}`].filter(Boolean).join(' · ');
  if (meta) box.append(el('span', 'r2d-turn-meta', meta));
}

function asRoll(v) {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [a, b] = v.map(Number);
  return a >= 1 && a <= 6 && b >= 1 && b <= 6 ? [a, b] : null;
}

function drawDice(ctx) {
  setHidden(center.dice, !ctx.live);
  const roll = asRoll(ctx.turn.lastRoll);
  const rolled = ctx.events.filter((e) => e?.type === 'dice_rolled');
  if (ctx.live && rolled.length && animate()) {
    tumble(roll ?? asRoll(rolled[rolled.length - 1].dice));
    return;
  }
  // A running tumble that lands on the right faces can finish.
  if (center.diceTimer && center.diceTarget === String(roll)) return;
  stopTumble();
  showRoll(roll);
}

function showRoll(roll) {
  setData(center.d1, 'v', roll ? roll[0] : 0);
  setData(center.d2, 'v', roll ? roll[1] : 0);
  center.doubles.classList.toggle('is-on', !!roll && roll[0] === roll[1]);
}

function tumble(target) {
  stopTumble();
  center.diceTarget = String(target);
  dropClass(center.doubles, 'is-on');
  void center.dice.offsetWidth; // restart the CSS tumble animation
  center.dice.classList.add('is-rolling');
  const started = performance.now();
  const face = () => 1 + Math.floor(Math.random() * 6);
  center.diceTimer = setInterval(() => {
    if (performance.now() - started >= DICE_MS) {
      stopTumble();
      showRoll(target);
      return;
    }
    center.d1.dataset.v = face();
    center.d2.dataset.v = face();
  }, 70);
}

function stopTumble() {
  clearInterval(center.diceTimer);
  center.diceTimer = null;
  center.diceTarget = null;
  dropClass(center.dice, 'is-rolling');
}

function drawPot(ctx) {
  const on = ctx.live && !!ctx.state.settings?.freeParkingPot;
  const amount = Math.max(0, Number(ctx.state.pot) || 0);
  const text = on ? `Free Parking pot: ${money(amount)}` : '';
  setHidden(center.pot, !on);
  setText(center.pot, text);
  const badge = tiles[BOARD.freeParkingIndex ?? 20]?.pot;
  if (badge) {
    setHidden(badge, !on);
    setText(badge, on ? money(amount) : '');
  }
}

function drawLog(ctx) {
  const lines = ctx.live && Array.isArray(ctx.state.log) ? ctx.state.log.slice(-LOG_LINES).map(String) : [];
  const sig = lines.join('\n');
  if (center.sig.log === sig) return;
  center.sig.log = sig;
  center.log.hidden = !lines.length;
  center.log.replaceChildren(...lines.map((line) => {
    const li = el('li', null, line);
    li.title = line;
    return li;
  }));
}

function drawWinner(ctx) {
  const finished = ctx.state.status === 'finished';
  const w = finished ? ctx.byId.get(ctx.state.winnerId) : null;
  const sig = finished ? [w?.id, w?.name, w?.token, ctx.colorOf.get(w?.id), w?.id === ctx.me].join('|') : '';
  if (center.sig.winner === sig) return;
  center.sig.winner = sig;

  const box = center.winner;
  box.hidden = !finished;
  box.replaceChildren();
  if (!finished) return;
  if (w) box.style.setProperty('--pc', ctx.colorOf.get(w.id));
  else box.style.removeProperty('--pc');
  box.append(
    el('div', 'r2d-winner-trophy', '🏆'),
    el('div', 'r2d-winner-name', w ? (w.id === ctx.me ? 'You win!' : `${w.name} wins!`) : 'Game over'),
  );
  if (w) box.append(el('div', 'r2d-winner-sub', `${tokenEmoji(w.token)} Last player standing`));
}

// --- card popup ---------------------------------------------------------------

function queueCards(ctx) {
  const now = performance.now();
  ctx.events.forEach((e, k) => {
    if (e?.type !== 'card_drawn') return;
    const who = e.playerId === ctx.me ? 'You' : ctx.byId.get(e.playerId)?.name ?? 'Someone';
    center.cardQueue.push({ deck: e.deck, text: String(e.text ?? ''), who, at: now + cardDelay(ctx.events, k, e.playerId) });
  });
  if (center.cardQueue.length > 3) center.cardQueue.splice(0, center.cardQueue.length - 3);
  if (!center.cardShowing && center.cardQueue.length) nextCard();
}

/** A card is revealed when the drawing player's token reaches the Chance / Community Chest square. */
function cardDelay(events, index, playerId) {
  if (!animate()) return 0;
  let at = walkDelay(events);
  for (let k = 0; k < index; k++) {
    const e = events[k];
    if (e?.type === 'moved' && e.playerId === playerId) at += moveTime(e);
  }
  return at;
}

/** Shows the next queued card (or hides the popup when none is left). Clicking the card skips it. */
function nextCard() {
  clearTimeout(center.cardTimer);
  const box = center.card;
  const wait = center.cardQueue.length ? center.cardQueue[0].at - performance.now() : 0;
  if (wait > 0) {
    // The next card waits for its token to arrive.
    box.classList.remove('is-visible');
    center.cardShowing = true;
    center.cardTimer = setTimeout(nextCard, wait);
    return;
  }
  const card = center.cardQueue.shift();
  if (!card) {
    box.classList.remove('is-visible');
    center.cardShowing = false;
    return;
  }
  const community = card.deck === 'community';
  box.classList.toggle('is-community', community);
  box.replaceChildren(
    el('div', 'r2d-card-deck', community ? '📦 Community Chest' : '❓ Chance'),
    el('div', 'r2d-card-who', `${card.who} drew`),
    el('div', 'r2d-card-text', card.text),
  );
  box.classList.add('is-visible');
  center.cardShowing = true;
  center.cardTimer = setTimeout(() => {
    box.classList.remove('is-visible');
    center.cardTimer = setTimeout(nextCard, 350); // after the fade-out
  }, CARD_MS);
}
