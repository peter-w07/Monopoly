// ui.js — everything outside #board: screens (home / lobby / game), the side panel, dialogs,
// toasts, the turn countdown, the settings popover and interface sounds. The board itself is drawn
// by the renderer renderer-switch.js picks (2D DOM or 3D Three.js); the server is the only source
// of truth, so every screen is re-rendered from the latest `state` + `legal`.
//
// With the 3D board on (body.board-3d) the board fills the whole window: the header floats over it,
// the side panel becomes a floating card on the right (a bottom sheet on phones held upright), and
// ui.js tells the renderer which part of the board they cover (#board.dataset.safeTop/Right/Bottom/
// Left + a 'monopoly:safearea' window event) so it can frame the board in the rest.

import { BOARD } from './boarddata.js';
import {
  render as renderBoard, busyUntil as boardBusyUntil, getMode as boardMode, setMode as setBoardMode,
  onModeChange as onBoardModeChange, getStatus as boardStatus, onStatus as onBoardStatus, probe3d,
  setOptions as setBoardOptions, setBoardToggle,
} from './renderer-switch.js';
import { connectGame } from './net.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Player colors by index in state.players — renderer2d.js uses the same palette.
const PLAYER_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#e84393'];
const TILES = BOARD.tiles;
const TOKENS = BOARD.tokens;
const TOKEN_BY_ID = new Map(TOKENS.map((t) => [t.id, t]));
const GROUP_ORDER = [...Object.keys(BOARD.groups), 'railroad', 'utility'];
const EMPTY_LEGAL = { actions: [], build: [], sellHouse: [], mortgage: [], unmortgage: [], auction: null, tradeTargets: [] };
const HOME_REFRESH_MS = 5000;
const BUSY_TIMEOUT_MS = 4000;
// After a move, dialogs wait this long so the board can show the dice and the token's walk first
// (the same buttons are in the side panel right away) — per animation speed (settings). The 3D
// board says itself how long it needs (busyUntil).
const DIALOG_HOLD_MS = { normal: 1500, fast: 800, instant: 0 };
// Space/Enter can't end the turn this soon after my roll (a double press would skip the move).
const END_TURN_KEY_HOLD_MS = 700;
const RECENT_LOG_LINES = 5;
const NOT_FOUND = Symbol('not found');
// Must match the single-column breakpoint in style.css: there, dialogs sit in the side panel
// above the action bar instead of floating over the board.
const NARROW = window.matchMedia('(max-width: 899px)');
const COARSE = window.matchMedia('(pointer: coarse)');
// Must match style.css: in the 3D layout, the side panel becomes a bottom sheet here (phones held
// upright). Narrow landscape windows keep a (narrower) side panel, which leaves the board more room.
const SHEET = window.matchMedia('(max-width: 899px) and (orientation: portrait)');
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');
// The 3D overview shows the board about this much wider than tall: the safe-area maths uses it to
// decide whether a folded panel is better kept out of the way on the right or above the board.
const BOARD_VIEW_ASPECT = 1.35;
// …and switches between the two only when the other is this much better (no flip-flopping).
const SAFE_SWITCH_MARGIN = 1.08;
// The bottom sheet's tallest drag (share of the window height; style.css caps it the same way).
const SHEET_MAX_SHARE = 0.7;
// The last seconds of an auction I'm in tick (sfx 'tick'), once per second.
const AUCTION_TICK_SECONDS = 3;

const KEY_NAME = 'monopoly.name';
const KEY_SESSIONS = 'monopoly.sessions';
const KEY_SETTINGS = 'monopoly.settings';
const seatKey = (gameId) => `monopoly.seat.${gameId}`;

// Actions that don't depend on what the player saw last: sent without the state seq.
// (BID and PASS_AUCTION do carry it: the server accepts any seq from the running auction, since
// bids race each other, but refuses one from before it, so a late bid can't land in a later auction.)
const SEQ_FREE = new Set(['JOIN', 'LEAVE', 'START_GAME']);
const AUCTION_ACTIONS = new Set(['BID', 'PASS_AUCTION']);
const TRADE_ACTIONS = new Set(['PROPOSE_TRADE', 'ACCEPT_TRADE', 'REJECT_TRADE']);
// Quick-bid steps over the current high bid, each in a fixed slot (an unaffordable one is disabled).
const QUICK_BIDS = [1, 10, 50, 100];
// Quick bids are relative to the high bid, so their amounts change when a bid comes in. For this long
// after that they don't take clicks: a click aimed at the old amount must not bid the new one.
const QUICK_BID_ARM_MS = 700;
// A newly shown trade offer can't be accepted for this long, so an offer swapped in at the last
// moment (withdraw + propose again) isn't accepted by a click meant for the one before.
const TRADE_ARM_MS = 1000;
// Mirrors rules.MAX_TRADES_PER_TURN.
const MAX_TRADES_PER_TURN = 5;
// The server's auction clock (CONTRACT §9); only used to draw the "going, going…" bar.
const AUCTION_CLOCK_MS = 10_000;

// Board settings (localStorage KEY_SETTINGS), passed to the renderers through renderer-switch.
// The first choice of each is the default. `hints` explain the choice on screen.
const SETTINGS = {
  speed: {
    choices: ['normal', 'fast', 'instant'],
    hints: { normal: 'Every roll, walk and card is animated.', fast: 'Animations play about twice as fast.', instant: 'No board animations — the board just updates.' },
  },
  camera: {
    choices: ['cinematic', 'calm', 'free'],
    hints: { cinematic: 'The camera follows the action and pushes in on landings.', calm: 'A steady overview with gentle close-ups.', free: 'The camera only moves when you drag it.' },
  },
  quality: {
    choices: ['auto', 'low', 'medium', 'high'],
    hints: { auto: 'Picked for this device.', low: 'Fastest: for phones and older computers.', medium: 'Soft shadows and more detail.', high: 'Everything on: for strong graphics cards.' },
  },
};
// Interface controls that make a sound of their own instead of the generic click.
const OWN_SOUND_UI = new Set(['board-view', 'settings', 'settings-close', 'panel-toggle', 'fullscreen', 'dismiss', 'trade-open', 'trade-cancel']);

const ERROR_TEXT = {
  NOT_YOUR_TURN: "It's not your turn.",
  INSUFFICIENT_FUNDS: "You don't have enough cash for that.",
  TOKEN_TAKEN: 'That token was just taken — pick another one.',
  GAME_FULL: 'Sorry, this game is full.',
  BAD_NAME: 'Names must be 1–20 characters.',
  MUST_ROLL_AGAIN: 'You rolled doubles — roll again first.',
  NOT_ENOUGH_PLAYERS: 'You need at least 2 players to start.',
  NOT_IN_LOBBY: 'The game has already started.',
  TRADE_PENDING: 'A trade offer is already waiting for an answer.',
  NO_TRADE: 'That trade offer is no longer open.',
  EMPTY_TRADE: 'Put something on at least one side of the trade.',
};

// ---------------------------------------------------------------------------
// App state (client-side only; game state always comes from the server)
// ---------------------------------------------------------------------------

const app = {
  screen: null,
  gameId: null,
  conn: null,
  openSeq: 0,             // guards async openGame() against a newer navigation
  seat: null,             // this tab's { playerId, token }
  takeover: null,         // remembered seat currently used by another tab: { playerId, token, name }
  joinName: '',
  state: null,
  legal: EMPTY_LEGAL,
  clockOffset: 0,         // server clock − local clock, for the countdown
  net: { status: 'closed' },
  busy: false,            // an action is in flight; buttons stay disabled until the next state
  busyTimer: null,
  dismissed: new Set(),   // dialog keys the player closed
  dialogAt: 0,            // no dialog appears before this time (see DIALOG_HOLD_MS)
  dialogTimer: null,
  lastRollAt: 0,          // when my latest dice roll arrived (see END_TURN_KEY_HOLD_MS)
  keyTimer: null,
  expanded: new Set(),    // player ids whose holdings are open in the players list
  focusMemo: null,        // a control that lost focus to a re-render and should get it back
  autoJoin: null,         // { name }: take a seat as soon as the lobby we just created arrives
  selectedToken: null,
  resigned: false,        // I resigned (LEAVE while active): the engine records that as bankrupt
  homeTimer: null,
  lastAction: null,       // { type, at } of the latest action I sent (to word its error)
  auctionKey: null,       // the auction on screen (turn + tile): a new one clears the bid box
  auctionBids: 0,         // bids seen in it, so only a new bid replays the high-bid pop
  auctionHigh: 0,         // the high bid last drawn: when it changes, the quick bids re-arm
  quickBidsAt: 0,         // quick bids take clicks from this time on (QUICK_BID_ARM_MS)
  armTimer: null,         // re-renders once quick bids / a trade offer's Accept are armed
  tradeSeen: null,        // { id, at }: the trade offer on screen and when it first appeared (TRADE_ARM_MS)
  tradeDraft: null,       // trade builder: { to, give: side, get: side }, side = { tiles, cash, jail } (cash/jail as typed)
  tradeWith: null,        // whom I last sent an offer to: the builder's default target next time
  settings: null,         // { speed, camera, quality } (see SETTINGS; loaded in boot)
  panelOpen: { side: true, sheet: false }, // 3D layout: is the panel unfolded (per layout, this page only)
  sheetDrag: null,        // bottom-sheet drag in progress: { id, y0, h0, moved, lastY, lastT, v }
  sheetClickBlock: 0,     // the handle's click is ignored until then (it ends a drag, not a tap)
  sheetForTrade: false,   // the bottom sheet was unfolded for the trade builder: fold it when that closes
  safe: '',               // the safe area last written to #board (see updateSafeArea)
  safeUnder: false,       // a folded 3D panel keeps the board under it (true) or beside it
  tickKey: '',            // the auction second that last ticked
};

// ---------------------------------------------------------------------------
// Interface sounds (sfx.js, synthesised with WebAudio). The renderers play the board's own sounds
// (dice, hops, coins…); ui.js only plays interface ones: clicks, toggles, open / close, my turn,
// a trade offer for me, an auction's last seconds, errors. Loaded on the side: the game works
// the same without it (a missing or failing sfx.js just means silence).
// ---------------------------------------------------------------------------

let sfx = null;
let sfxFailed = false; // sfx.js couldn't be loaded: the sound settings say so
import('./sfx.js')
  .then((mod) => {
    sfx = mod.sfx ?? null;
    renderSettings();
  })
  .catch((err) => {
    console.warn('[ui] sound is unavailable:', err);
    sfxFailed = true;
    renderSettings();
  });

/** Plays an interface sound (sfx names, see sfx.js). Never throws; silent until sfx.js is loaded. */
function sound(name, opts) {
  try {
    sfx?.play(name, opts);
  } catch { /* sound is a nicety */ }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const money = (n) => `$${Number(n || 0).toLocaleString('en-US')}`;
const tokenEmoji = (id) => TOKEN_BY_ID.get(id)?.emoji ?? '●';
const codeOf = (gameId) => String(gameId ?? '').replace(/^g_/, '').toUpperCase();
const tileName = (index) => TILES[index]?.name ?? `tile ${index}`;
const disabledAttr = (enabled) => (enabled ? '' : ' disabled');

// Screens re-render on every server message. Rewriting identical markup would drop keyboard focus
// and hover, and replay CSS animations, so an element is only rewritten when its markup changed.
// (Elements written through setHtml must not be written any other way.)
const lastHtml = new WeakMap();
function setHtml(el, html) {
  if (lastHtml.get(el) === html) return;
  lastHtml.set(el, html);
  el.innerHTML = html;
}

// A control's identity across re-renders: its action (+ tile, or the trade offer it answers), UI
// command, or player row. (A new offer's Accept is a different control from the last one's.)
function focusKey(el) {
  const d = el.dataset ?? {};
  if (d.act) return `act:${d.act}:${d.tile ?? d.key ?? d.tradeId ?? ''}`;
  if (d.ui) return `ui:${d.ui}:${d.key ?? d.game ?? ''}`;
  if (d.trade) return `trade:${d.trade}:${d.key ?? ''}`;
  const row = el.tagName === 'SUMMARY' ? el.closest('details[data-player]') : null;
  return row ? `player:${row.dataset.player}` : null;
}

const focusable = (el) => el && !el.disabled && el.isConnected;

/**
 * setHtml for containers with buttons: keyboard focus stays on the same control (same action and
 * tile) after the rewrite. If that control is disabled right now (buttons are while an action is in
 * flight), the next rewrite of the container within a few seconds tries again, falling back to
 * another control for the same tile (Mortgage → Unmortgage). Mouse and touch clicks drop focus
 * instead (see boot), so this only carries keyboard users along.
 */
function setHtmlKeepFocus(el, html) {
  const active = document.activeElement;
  const inside = active && active !== document.body && el.contains(active);
  const memo = app.focusMemo;
  let want = null;
  if (inside) want = { el, key: focusKey(active), tile: active.dataset?.tile ?? null };
  else if (memo?.el === el && Date.now() - memo.at < 5000 && document.activeElement === document.body) want = memo;
  setHtml(el, html);
  if (!want?.key || el.contains(document.activeElement)) return;
  // Focus lost a while ago never comes back onto a decision like Accept trade (data-nofocus).
  const controls = [...el.querySelectorAll('[data-act], [data-ui], [data-trade], summary')]
    .filter((c) => !(want === memo && c.dataset.nofocus != null));
  const target = controls.find((c) => focusable(c) && focusKey(c) === want.key)
    ?? (want.tile != null ? controls.find((c) => focusable(c) && c.dataset.tile === want.tile) : null);
  if (target) {
    target.focus({ preventScroll: true });
    app.focusMemo = null;
  } else {
    app.focusMemo = { ...want, at: want.at ?? Date.now() };
  }
}

/** Accepts 'ABC123', 'abc123', 'g_abc123' or an invite URL; returns 'g_abc123' or null. */
function parseGameCode(input) {
  let text = String(input ?? '').trim();
  const fromUrl = text.match(/[?&]game=([^&#\s]+)/i);
  if (fromUrl) {
    try { text = decodeURIComponent(fromUrl[1]); } catch { return null; }
  }
  const code = text.toLowerCase().replace(/^g_/, '');
  return /^[a-z0-9]{6}$/.test(code) ? `g_${code}` : null;
}

function formatDuration(sec) {
  if (!sec) return 'Off';
  return sec < 60 || sec % 60 ? `${sec}s` : `${sec / 60} min`;
}

// Readable text color for a colored band (yellow/light blue need dark text).
function textOn(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  if (Number.isNaN(n)) return '#fff';
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? '#1c2421' : '#ffffff';
}

// ---------------------------------------------------------------------------
// Storage (CONTRACT §8): sessionStorage = this tab's seat, localStorage = remembered seats + name
// ---------------------------------------------------------------------------

function readJson(area, key, fallback) {
  try {
    const raw = window[area].getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(area, key, value) {
  try { window[area].setItem(key, JSON.stringify(value)); } catch { /* storage blocked or full */ }
}

function removeKey(area, key) {
  try { window[area].removeItem(key); } catch { /* storage blocked */ }
}

function savedName() {
  try { return localStorage.getItem(KEY_NAME) ?? ''; } catch { return ''; }
}

function saveName(name) {
  try { localStorage.setItem(KEY_NAME, name); } catch { /* storage blocked */ }
}

const getSessions = () => readJson('localStorage', KEY_SESSIONS, {}) ?? {};

function rememberSession(gameId, seat, name) {
  const all = getSessions();
  const prev = all[gameId];
  const next = { playerId: seat.playerId, token: seat.token, name: name || prev?.name || '' };
  if (prev && prev.playerId === next.playerId && prev.token === next.token && prev.name === next.name) return;
  all[gameId] = next;
  writeJson('localStorage', KEY_SESSIONS, all);
}

/** Forget the remembered seat for a game — only if it is `playerId`'s, when one is given. */
function forgetSession(gameId, playerId = null) {
  const all = getSessions();
  if (!all[gameId] || (playerId && all[gameId].playerId !== playerId)) return;
  delete all[gameId];
  writeJson('localStorage', KEY_SESSIONS, all);
}

/** This tab's seat: { playerId, token, replaced? } — `replaced` once another tab took the seat over. */
function getTabSeat(gameId) {
  const seat = readJson('sessionStorage', seatKey(gameId), null);
  if (!seat?.playerId || !seat?.token) return null;
  return { playerId: seat.playerId, token: seat.token, ...(seat.replaced ? { replaced: true } : {}) };
}

const setTabSeat = (gameId, seat) => writeJson('sessionStorage', seatKey(gameId), seat);
const clearTabSeat = (gameId) => removeKey('sessionStorage', seatKey(gameId));

// ---------------------------------------------------------------------------
// Game-state helpers (read-only views of the server state)
// ---------------------------------------------------------------------------

const playerById = (s, id) => s?.players.find((p) => p.id === id) ?? null;
const playerName = (s, id) => playerById(s, id)?.name ?? 'someone';
const currentPlayerId = (s) => (s && s.status !== 'lobby' ? s.turn.order[s.turn.currentIndex] ?? null : null);
const tileState = (s, index) => s.tiles.find((t) => t.index === index) ?? null;

function playerColor(s, id) {
  const i = s.players.findIndex((p) => p.id === id);
  return i < 0 ? 'var(--muted)' : PLAYER_COLORS[i % PLAYER_COLORS.length];
}

/** My player in the current state (null for spectators). */
const me = () => playerById(app.state, app.seat?.playerId);
const isMyTurn = () => {
  const m = me();
  return !!m && app.state.status === 'active' && currentPlayerId(app.state) === m.id;
};
const can = (type) => app.legal.actions.includes(type);
const ready = () => app.net.status === 'connected' && !app.busy;

function ownsFullGroup(s, ownerId, group) {
  return TILES.filter((t) => t.group === group).every((t) => tileState(s, t.index)?.ownerId === ownerId);
}

function countOwned(s, ownerId, type) {
  return s.tiles.filter((t) => t.ownerId === ownerId && TILES[t.index].type === type).length;
}

// Mirrors the engine's unmortgageCost (rounded before ceil to avoid 50 × 1.1 = 55.00000000000001 → 56).
function unmortgageCost(index) {
  const exact = TILES[index].mortgage * (1 + BOARD.unmortgageInterest);
  return Math.ceil(Math.round(exact * 1e6) / 1e6);
}

// Mirrors rules.mortgageTransferFee: the receiver of a mortgaged tile pays the bank 10% of its mortgage value.
function mortgageTransferFee(index) {
  const exact = TILES[index].mortgage * BOARD.unmortgageInterest;
  return Math.ceil(Math.round(exact * 1e6) / 1e6);
}

// Mirrors rules.tradeableTiles: a tile can change hands when no tile of its colour group has buildings.
function isTradeable(s, index) {
  const tile = TILES[index];
  return tile.type !== 'property'
    || TILES.every((t) => t.group !== tile.group || !(tileState(s, t.index)?.houses > 0));
}

/** The 10% fees whoever receives `tiles` pays for the mortgaged ones among them (mirrors rules.tradeFees). */
function tradeFee(s, tiles) {
  return tiles.reduce((sum, i) => sum + (tileState(s, i)?.mortgaged ? mortgageTransferFee(i) : 0), 0);
}

/** Tile indices owned by `playerId`, ascending. */
const ownedTiles = (s, playerId) => s.tiles.filter((t) => t.ownerId === playerId).map((t) => t.index);

/** Current rent of an owned tile as display text (mirrors rules.rentFor). */
function rentText(s, index) {
  const tile = TILES[index];
  const ts = tileState(s, index);
  if (!ts?.ownerId) return '';
  if (ts.mortgaged) return 'No rent while mortgaged';
  if (tile.type === 'property') {
    const rent = ts.houses > 0 ? tile.rent[ts.houses] : tile.rent[0] * (ownsFullGroup(s, ts.ownerId, tile.group) ? 2 : 1);
    return `Rent ${money(rent)}`;
  }
  if (tile.type === 'railroad') return `Rent ${money(tile.rent[countOwned(s, ts.ownerId, 'railroad') - 1])}`;
  if (tile.type === 'utility') return `Rent ${tile.multipliers[countOwned(s, ts.ownerId, 'utility') - 1]}× dice`;
  return '';
}

/** Mirrors rules.netWorth: cash + price of each tile (mortgage value if mortgaged) + house cost of buildings. */
function netWorth(s, playerId) {
  const p = playerById(s, playerId);
  if (!p) return 0;
  return s.tiles.reduce((sum, ts) => {
    if (ts.ownerId !== playerId) return sum;
    const tile = TILES[ts.index];
    return sum + (ts.mortgaged ? tile.mortgage : tile.price) + (ts.houses > 0 ? ts.houses * tile.houseCost : 0);
  }, p.cash);
}

/** Who gets my assets if I go bankrupt or resign now: the player I owe, else the bank (null). */
function myCreditor() {
  const debt = app.state?.turn.pendingDebt;
  if (!isMyTurn() || app.state.turn.phase !== 'paying' || !debt?.toPlayerId || debt.payees?.length) return null;
  return playerById(app.state, debt.toPlayerId);
}

// ---------------------------------------------------------------------------
// Screens & navigation
// ---------------------------------------------------------------------------

function showScreen(name) {
  if (app.screen !== name) window.scrollTo(0, 0);
  app.screen = name;
  for (const el of document.querySelectorAll('.screen')) el.hidden = el.id !== `screen-${name}`;
  $('#topbar-game').hidden = !['loading', 'lobby', 'game'].includes(name);
  $('#view-pill').hidden = name !== 'game';
  document.body.dataset.screen = name;
  syncBoardLayout();
  if (name === 'home') startHomeRefresh();
  else stopHomeRefresh();
}

function rerender() {
  if (!app.state) return;
  if (app.screen === 'lobby') renderLobby();
  else if (app.screen === 'game') renderGame();
}

/** Close the current table (if any) and reset all per-game client state. */
function closeGame() {
  app.openSeq += 1;
  app.conn?.close();
  Object.assign(app, {
    conn: null, gameId: null, seat: null, takeover: null, state: null,
    legal: EMPTY_LEGAL, net: { status: 'closed' }, selectedToken: null, resigned: false,
    autoJoin: null, focusMemo: null, lastRollAt: 0, lastAction: null, auctionKey: null, auctionBids: 0,
    auctionHigh: 0, quickBidsAt: 0, tradeSeen: null, tradeDraft: null, tradeWith: null, sheetForTrade: false,
  });
  clearTimeout(app.armTimer);
  $('#bid-input').value = '';
  setBusy(false);
  app.dismissed.clear();
  app.expanded.clear();
  app.dialogAt = 0;
  clearTimeout(app.dialogTimer);
  clearTimeout(app.keyTimer);
  $('#replaced-banner').hidden = true;
  clearDialog();
}

function goHome() {
  closeGame();
  history.replaceState(null, '', '/');
  document.title = 'Monopoly';
  if (!$('#home-name').value) $('#home-name').value = savedName();
  showScreen('home');
  refreshHome();
}

async function fetchSummary(gameId) {
  try {
    const res = await fetch(`/api/games/${encodeURIComponent(gameId)}`);
    if (res.status === 404) return NOT_FOUND;
    return res.ok ? await res.json() : null;
  } catch {
    return null; // network trouble: unknown
  }
}

/**
 * Open a game table (lobby or game) — resolving this tab's seat per CONTRACT §8.
 * `autoJoin: { name }` (a game we just created) takes a seat without a second click.
 */
async function openGame(gameId, { autoJoin = null } = {}) {
  closeGame();
  const seq = app.openSeq;
  app.gameId = gameId;
  app.autoJoin = autoJoin;
  history.replaceState(null, '', `/?game=${encodeURIComponent(gameId)}`);
  $('#topbar-code').textContent = codeOf(gameId);
  $('#loading-text').textContent = `Opening game ${codeOf(gameId)}…`;
  renderConn();
  showScreen('loading');

  const tabSeat = getTabSeat(gameId);
  if (tabSeat && !tabSeat.replaced) {
    app.seat = tabSeat;
  } else {
    // No seat of our own (or one another tab took over): resume a free seat, or offer a takeover.
    const summary = await fetchSummary(gameId);
    if (seq !== app.openSeq) return; // user navigated away meanwhile
    if (summary === NOT_FOUND) {
      clearTabSeat(gameId);
      forgetSession(gameId);
      goHome();
      toast(`Game ${codeOf(gameId)} doesn't exist or has ended.`, 'error');
      return;
    }
    const candidate = tabSeat ?? getSessions()[gameId];
    if (candidate) {
      const player = summary?.players?.find((p) => p.id === candidate.playerId);
      if (summary && !player) {
        // That seat is gone (left the lobby).
        if (tabSeat) clearTabSeat(gameId);
        else forgetSession(gameId);
      } else if (player && !player.connected) {
        app.seat = { playerId: candidate.playerId, token: candidate.token };
        setTabSeat(gameId, app.seat);
      } else {
        // Another tab has it (or we couldn't check): offer a takeover link.
        app.takeover = { playerId: candidate.playerId, token: candidate.token, name: player?.name ?? candidate.name };
      }
    }
  }

  app.conn = connectGame(gameId, {
    getSeat: () => app.seat,
    onState: handleState,
    onWelcome: handleWelcome,
    onError: handleError,
    onStatus: handleStatus,
  });
}

// ---------------------------------------------------------------------------
// Server messages
// ---------------------------------------------------------------------------

function handleWelcome(msg) {
  if (msg.gameId && msg.gameId !== app.gameId) return;
  app.seat = { playerId: msg.playerId, token: msg.token };
  app.takeover = null;
  setTabSeat(app.gameId, app.seat);
  rememberSession(app.gameId, app.seat, me()?.name || app.joinName || savedName());
}

function handleState(msg) {
  const { state } = msg;
  if (!state || (app.gameId && state.id !== app.gameId)) return;
  const prev = app.state;
  const firstState = !prev;
  app.state = state;
  app.legal = { ...EMPTY_LEGAL, ...(msg.legal ?? {}) };
  if (typeof msg.now === 'number') app.clockOffset = msg.now - Date.now();
  setBusy(false);
  if (syncStoredSeat() === 'left') {
    goHome();
    toast('You left the lobby.', 'info');
    return;
  }

  const events = Array.isArray(msg.events) ? msg.events : [];
  if (state.status === 'lobby') {
    showScreen('lobby');
    renderLobby();
    if (app.autoJoin) autoJoin();
    else if (becameHost(prev, state)) toast("You're the host now — start when everyone's in.", 'good', 6000);
  } else {
    app.autoJoin = null;
    if (app.screen !== 'game') showScreen('game');
    if (!firstState && !document.hidden && events.some((e) => e.type === 'moved')) {
      app.dialogAt = Date.now() + (DIALOG_HOLD_MS[app.settings.speed] ?? DIALOG_HOLD_MS.normal);
    }
    const myId = me()?.id;
    if (myId && events.some((e) => e.type === 'dice_rolled' && e.playerId === myId)) app.lastRollAt = Date.now();
    drawBoard(events);
    // The 3D board animates longer than DIALOG_HOLD_MS; hold dialogs until the token lands (0 in 2D).
    app.dialogAt = Math.max(app.dialogAt, boardBusyUntil());
    renderGame();
    // A trade's answer (rejected / cancelled) doesn't name its parties: they are in the previous state.
    if (!firstState) announceLater(events, prev?.trade ?? null);
  }
  updateTitle();
}

/** The previous host left the lobby and the seat passed to me. */
function becameHost(prev, state) {
  const myId = app.seat?.playerId;
  return !!myId && prev?.status === 'lobby' && !!playerById(prev, myId)
    && !!prev.hostId && prev.hostId !== myId && state.hostId === myId;
}

/** Take a seat in the lobby we just created, with the home screen's name and the first free token. */
function autoJoin() {
  if (me() || !can('JOIN')) {
    app.autoJoin = null;
    return;
  }
  const { name } = app.autoJoin;
  app.autoJoin = null;
  if (!name) {
    $('#join-name').focus();
    return;
  }
  const taken = new Set(app.state.players.map((p) => p.token));
  const token = TOKENS.find((t) => !taken.has(t.id))?.id;
  if (!token) return;
  app.joinName = name;
  act('JOIN', { name, token });
}

// Toasts about a move (rent, cards, passing GO…) wait for the board to show it, like dialogs do.
function announceLater(events, prevTrade) {
  const wait = app.dialogAt - Date.now();
  if (wait <= 0) {
    announce(events, prevTrade);
    return;
  }
  const gameId = app.gameId;
  setTimeout(() => { if (app.gameId === gameId && app.state) announce(events, prevTrade); }, wait);
}

// Keep stored credentials in line with the table: refresh the remembered name, and forget the
// seat once our player has left the lobby (returns 'left'; the caller goes home).
// Only `welcome` creates remembered seats, so two tabs in one browser don't keep overwriting
// each other's entry on every broadcast.
function syncStoredSeat() {
  if (!app.seat) return null;
  const m = me();
  const remembered = getSessions()[app.gameId];
  if (m) {
    if (remembered?.playerId === m.id && remembered.name !== m.name) rememberSession(app.gameId, app.seat, m.name);
  } else if (app.state.status === 'lobby') {
    clearTabSeat(app.gameId);
    forgetSession(app.gameId, app.seat.playerId);
    app.seat = null;
    return 'left';
  }
  return null;
}

function handleError(msg) {
  setBusy(false);
  if (msg.code === 'NO_GAME') {
    if (app.state?.status === 'finished') {
      // Finished games are archived by the server; keep the final table on screen.
      app.conn?.close();
      return;
    }
    const code = codeOf(app.gameId);
    clearTabSeat(app.gameId);
    forgetSession(app.gameId);
    goHome();
    sound('error');
    toast(`Game ${code} doesn't exist anymore.`, 'error');
    return;
  }
  if (msg.code === 'ROOM_BUSY') {
    // Too many spectators: the server didn't let this tab in. Staying would only repeat this every
    // few seconds (the unattached socket is closed, net.js reconnects, same answer), so go home.
    const code = codeOf(app.gameId);
    goHome();
    sound('error');
    toast(`Too many people are watching game ${code} right now — try again in a little while.`, 'error', 8000);
    return;
  }
  if (msg.code === 'BAD_TOKEN') {
    clearTabSeat(app.gameId);
    forgetSession(app.gameId, app.seat?.playerId);
    app.seat = null;
    sound('error');
    toast('Your saved seat is no longer valid — you are watching as a visitor.', 'error');
    rerender();
    return;
  }
  const last = app.lastAction && Date.now() - app.lastAction.at < BUSY_TIMEOUT_MS * 2 ? app.lastAction.type : null;
  const mild = AUCTION_ACTIONS.has(last) ? auctionErrorText(msg.code) : null;
  if (mild) {
    // Bids race each other: being outbid a moment earlier is part of an auction, not an error.
    toast(mild, 'info', 3000);
    rerender();
    return;
  }
  if (msg.code === 'STALE_STATE') {
    // The click was meant for a state that has already changed (e.g. a timeout played the move).
    toast('Too late — the game moved on.', 'info', 2500);
    rerender();
    return;
  }
  if (TRADE_ACTIONS.has(last) && msg.code === 'NO_TRADE') {
    toast('That trade offer is no longer open.', 'info', 3000);
    rerender();
    return;
  }
  // The engine's own wording is the most precise for trades ("Bob doesn't own Boardwalk.").
  const text = TRADE_ACTIONS.has(last) && msg.message ? msg.message : ERROR_TEXT[msg.code] ?? msg.message;
  sound('error');
  toast(text ?? msg.code ?? 'Something went wrong.', 'error');
  rerender();
}

/** A failed BID / PASS_AUCTION that only means someone was quicker; null for real errors. */
function auctionErrorText(code) {
  const a = app.state?.status === 'active' && app.state.turn.phase === 'auction' ? app.state.auction : null;
  if (!a) return code === 'WRONG_PHASE' || code === 'STALE_STATE' ? 'Too late — the auction is over.' : null;
  switch (code) {
    case 'BID_TOO_LOW': {
      const by = a.highBidderId ? ` by ${playerName(app.state, a.highBidderId)}` : '';
      return `Someone bid first — the high bid is now ${money(a.highBid)}${by}.`;
    }
    case 'ALREADY_HIGH_BIDDER': return "You're already the high bidder.";
    case 'ALREADY_PASSED': return 'You have already dropped out of this auction.';
    case 'STALE_STATE': return 'Too late — try again.';
    default: return null;
  }
}

function handleStatus(status) {
  app.net = status;
  const replaced = status.status === 'replaced';
  $('#replaced-banner').hidden = !replaced;
  updateSafeArea(); // the banner sits under the header, over the 3D board
  // Another tab has this seat now. Mark it so that reloading this stale tab doesn't quietly take
  // the seat back (it offers "Take over" instead); "Use here" takes it back on purpose.
  if (replaced && app.gameId && app.seat) setTabSeat(app.gameId, { ...app.seat, replaced: true });
  if (status.status !== 'connected') setBusy(false);
  renderConn();
  rerender(); // buttons depend on connectivity
  updateTitle();
}

function drawBoard(events) {
  try {
    renderBoard(app.state, events, me()?.id ?? null);
  } catch (err) {
    console.error('board render failed:', err);
  }
}

function updateTitle() {
  const s = app.state;
  let title = 'Monopoly';
  if (app.net.status === 'replaced') title = 'Opened in another tab · Monopoly';
  else if (s?.status === 'lobby') title = `Lobby ${codeOf(s.id)} · Monopoly`;
  else if (s?.status === 'active' && (can('BID') || can('PASS_AUCTION'))) title = '● Auction · Monopoly';
  else if (s?.status === 'active' && s.trade && s.trade.toPlayerId === me()?.id) title = '● Trade offer · Monopoly';
  // The dot means "you have something to do": not while an auction or my own offer waits on others.
  else if (s?.status === 'active') {
    const waiting = s.turn.phase === 'auction' || s.turn.phase === 'trading';
    title = isMyTurn() && !waiting ? '● Your turn · Monopoly' : `${codeOf(s.id)} · Monopoly`;
  }
  else if (s?.status === 'finished') title = 'Game over · Monopoly';
  document.title = title;
}

// ---------------------------------------------------------------------------
// Sending actions
// ---------------------------------------------------------------------------

function setBusy(on) {
  app.busy = on;
  clearTimeout(app.busyTimer);
  app.busyTimer = on ? setTimeout(() => { app.busy = false; rerender(); }, BUSY_TIMEOUT_MS) : null;
}

function act(type, payload = {}) {
  if (!app.conn || app.busy) return false;
  const seq = SEQ_FREE.has(type) ? undefined : app.state?.seq;
  if (!app.conn.send({ type, ...payload }, seq)) {
    sound('error');
    toast('Not connected right now — please wait a moment.', 'error');
    return false;
  }
  app.lastAction = { type, at: Date.now() };
  setBusy(true);
  rerender();
  return true;
}

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

function renderConn() {
  const el = $('#conn-status');
  const { status, retryAt } = app.net;
  let cls = '';
  let html = '';
  if (status === 'connecting') [cls, html] = ['warn', 'Connecting…'];
  else if (status === 'connected') [cls, html] = ['ok', 'Connected'];
  else if (status === 'replaced') [cls, html] = ['bad', 'Open in another tab'];
  else if (status === 'reconnecting') {
    cls = 'warn';
    html = retryAt
      ? 'Reconnecting in <span data-retry-in></span> <button type="button" class="linkish" data-ui="retry">Retry now</button>'
      : 'Reconnecting…';
  } else if (app.state?.status === 'finished') html = 'Game ended';
  el.className = `conn ${cls}`;
  setHtml(el, html ? `<i class="conn-dot"></i><span>${html}</span>` : '');
  tick();
}

// Runs 4× a second: turn countdown (clock-skew corrected), the auction clock and the reconnect countdown.
function tick() {
  const deadline = app.state?.status === 'active' ? app.state.turn.deadlineAt : null;
  const leftMs = deadline ? Math.max(0, deadline - (Date.now() + app.clockOffset)) : 0;
  const left = Math.ceil(leftMs / 1000);
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  for (const cd of document.querySelectorAll('[data-countdown]')) {
    if (!deadline) {
      cd.hidden = true;
      continue;
    }
    const text = `⏱ ${clock}`;
    if (cd.textContent !== text) cd.textContent = text;
    cd.hidden = false;
    cd.classList.toggle('urgent', left <= Number(cd.dataset.urgent || 10));
  }
  // "Going once, going twice…": the bar drains over the auction's last 10 seconds.
  const bar = document.querySelector('[data-auction-bar]');
  if (bar) {
    const width = deadline ? `${(Math.min(1, leftMs / AUCTION_CLOCK_MS) * 100).toFixed(1)}%` : '100%';
    if (bar.style.width !== width) bar.style.width = width;
    bar.parentElement.classList.toggle('urgent', !!deadline && leftMs <= 3000);
  }
  auctionTick(deadline, leftMs);
  const offline = document.querySelector('[data-offline-in]');
  if (offline && deadline && offline.textContent !== clock) offline.textContent = clock;
  const retry = document.querySelector('[data-retry-in]');
  if (retry && app.net.retryAt) {
    retry.textContent = `${Math.max(0, Math.ceil((app.net.retryAt - Date.now()) / 1000))}s`;
  }
}

/** The last AUCTION_TICK_SECONDS of an auction I'm still bidding in tick (sfx), once a second. */
function auctionTick(deadline, leftMs) {
  const s = app.state;
  const a = s?.status === 'active' && s.turn.phase === 'auction' ? s.auction : null;
  const m = me();
  const bidding = !!a && !!m && !m.bankrupt && a.participants.includes(m.id) && !a.passed.includes(m.id);
  const sec = Math.ceil(leftMs / 1000);
  if (!bidding || !deadline || sec < 1 || sec > AUCTION_TICK_SECONDS) return;
  const key = `${deadline}:${sec}`; // a new bid restarts the clock: its last seconds tick again
  if (app.tickKey === key) return;
  app.tickKey = key;
  sound('tick', { rate: sec === 1 ? 1.25 : 1 });
}

// ---------------------------------------------------------------------------
// Home screen
// ---------------------------------------------------------------------------

function startHomeRefresh() {
  if (!app.homeTimer) app.homeTimer = setInterval(refreshHome, HOME_REFRESH_MS);
}

function stopHomeRefresh() {
  clearInterval(app.homeTimer);
  app.homeTimer = null;
}

function refreshHome() {
  refreshLobbies();
  refreshMyGames();
}

async function refreshLobbies() {
  let games = null;
  try {
    const res = await fetch('/api/games');
    if (res.ok) games = (await res.json()).games ?? [];
  } catch { /* shown below */ }
  if (app.screen !== 'home') return;

  const list = $('#open-lobbies');
  if (!games) {
    setHtml(list, '<li class="empty">Can’t reach the server right now — retrying…</li>');
    return;
  }
  if (!games.length) {
    setHtml(list, '<li class="empty">No open lobbies right now. Create one and invite your friends!</li>');
    return;
  }
  games.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  setHtml(list, games.map((g) => {
    const count = Array.isArray(g.players) ? g.players.length : Number(g.players) || 0;
    const full = g.maxPlayers && count >= g.maxPlayers;
    return `<li class="row">
      <div class="row-main">
        <span class="row-code">${esc(codeOf(g.id))}</span>
        <span class="muted small">${g.hostName ? `Host ${esc(g.hostName)} · ` : ''}${count}/${esc(g.maxPlayers)} players</span>
      </div>
      <button type="button" class="btn small${full ? '' : ' primary'}" data-ui="open" data-game="${esc(g.id)}">${full ? 'Watch' : 'Join'}</button>
    </li>`;
  }).join(''));
}

async function refreshMyGames() {
  const sessions = getSessions();
  const results = await Promise.all(Object.keys(sessions).map(async (id) => [id, await fetchSummary(id)]));
  if (app.screen !== 'home') return;

  const rows = [];
  for (const [id, summary] of results) {
    if (summary === NOT_FOUND) {
      forgetSession(id);
      clearTabSeat(id);
    } else {
      rows.push({ id, summary, session: sessions[id] });
    }
  }
  $('#my-games-card').hidden = rows.length === 0;
  setHtml($('#my-games'), rows.map(({ id, summary, session }) => {
    const status = { lobby: 'In lobby', active: 'In progress', finished: 'Finished' }[summary?.status] ?? 'Status unknown';
    const tokens = (summary?.players ?? []).map((p) => `<span title="${esc(p.name)}">${tokenEmoji(p.token)}</span>`).join('');
    return `<li class="row">
      <div class="row-main">
        <span class="row-code">${esc(codeOf(id))} <span class="row-tokens">${tokens}</span></span>
        <span class="muted small">${esc(status)}${session?.name ? ` · playing as ${esc(session.name)}` : ''}</span>
      </div>
      <button type="button" class="btn small ghost" data-ui="forget" data-game="${esc(id)}" title="Remove from this list">Forget</button>
      <button type="button" class="btn small primary" data-ui="open" data-game="${esc(id)}">Resume</button>
    </li>`;
  }).join(''));
}

async function createGame(event) {
  event.preventDefault();
  const button = event.target.querySelector('[type="submit"]');
  const name = $('#home-name').value.trim();
  if (name) saveName(name);
  const settings = {
    startingCash: Number($('#set-cash').value) || 1500,
    turnTimeoutSec: Number($('#set-timer').value),
    maxPlayers: Number($('#set-max').value),
    freeParkingPot: $('#set-pot').checked,
    evenBuild: $('#set-even').checked,
    auctionOnDecline: $('#set-auction').checked,
  };
  button.disabled = true;
  try {
    const res = await fetch('/api/games', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.gameId) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
    openGame(body.gameId, { autoJoin: { name } }); // the creator sits down right away (as host)
  } catch (err) {
    toast(`Couldn't create a game: ${err.message}`, 'error');
  } finally {
    button.disabled = false;
  }
}

async function joinByCode(event) {
  event.preventDefault();
  const errorEl = $('#code-error');
  const showError = (text) => { errorEl.textContent = text; errorEl.hidden = false; };
  const gameId = parseGameCode($('#code-input').value);
  if (!gameId) {
    showError('Game codes are 6 letters or digits, like ABC123 — or paste an invite link.');
    return;
  }
  const name = $('#home-name').value.trim();
  if (name) saveName(name);
  const summary = await fetchSummary(gameId);
  if (summary === NOT_FOUND) {
    showError(`There's no game with code ${codeOf(gameId)}.`);
    return;
  }
  errorEl.hidden = true;
  $('#code-input').value = '';
  openGame(gameId);
}

// ---------------------------------------------------------------------------
// Lobby screen
// ---------------------------------------------------------------------------

function renderLobby() {
  const s = app.state;
  const m = me();
  $('#lobby-code').textContent = codeOf(s.id);
  $('#lobby-count').textContent = `${s.players.length}/${s.settings.maxPlayers}`;

  setHtml($('#lobby-players'), s.players.length
    ? s.players.map((p) => `
      <li class="prow" style="--pc:${playerColor(s, p.id)}">
        <span class="pdot"></span>
        <span class="prow-token">${tokenEmoji(p.token)}</span>
        <span class="prow-main"><span class="prow-name">${esc(p.name)}${p.id === m?.id ? ' <span class="tag you">you</span>' : ''}${p.id === s.hostId ? ' <span class="tag host">host</span>' : ''}</span></span>
        <span class="presence${p.connected ? ' on' : ''}" title="${p.connected ? 'Online' : 'Offline'}"></span>
      </li>`).join('')
    : '<li class="empty">Nobody has joined yet — be the first!</li>');

  // Join form: visitors only, while there's room.
  const canJoin = !m && can('JOIN');
  $('#lobby-join').hidden = !canJoin;
  if (canJoin) {
    const nameInput = $('#join-name');
    // Prefill the last used name — unless someone at this table already uses it (a second tab).
    const name = savedName();
    const taken = s.players.some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (!nameInput.value && document.activeElement !== nameInput && !taken) nameInput.value = name;
    renderTokenGrid();
    $('#join-btn').disabled = !ready() || !app.selectedToken;
  }

  // Notes for visitors (full lobby, remembered seat open in another tab).
  const notes = [];
  if (!m && !canJoin) notes.push('This game is full — you are watching.');
  if (!m && app.takeover) notes.push(takeoverLink());
  $('#lobby-note').hidden = notes.length === 0;
  setHtml($('#lobby-note'), notes.join(' '));

  // Seated: the host starts (or anyone the server lets start, e.g. while the host is offline); anyone can leave.
  let actions = '';
  if (m) {
    if (s.hostId === m.id || can('START_GAME')) {
      actions += `<button type="button" class="btn primary" data-act="START_GAME"${disabledAttr(can('START_GAME') && ready())}>Start game</button>`;
      if (s.hostId !== m.id) actions += '<span class="hint">The host is offline — you can start.</span>';
      else if (!can('START_GAME')) actions += `<span class="hint">${s.players.length < 2 ? 'Need 2+ players to start.' : 'Waiting…'}</span>`;
    } else {
      const host = playerById(s, s.hostId);
      actions += `<span class="hint">Waiting for ${host ? esc(host.name) : 'the host'} to start the game…</span>`;
    }
    // lobbyOnly: if the game starts before this arrives, the server refuses it instead of resigning me.
    if (can('LEAVE')) actions += `<button type="button" class="btn ghost" data-act="LEAVE" data-lobby-only${disabledAttr(ready())}>Leave</button>`;
  }
  setHtmlKeepFocus($('#lobby-actions'), actions);

  const st = s.settings;
  setHtml($('#lobby-settings'), [
    ['Starting cash', money(st.startingCash)],
    ['Turn timer', formatDuration(st.turnTimeoutSec)],
    ['Max players', st.maxPlayers],
    ['Free Parking pot', st.freeParkingPot ? 'On' : 'Off'],
    ['Build evenly', st.evenBuild ? 'On' : 'Off'],
    ['Auctions', st.auctionOnDecline ? 'On' : 'Off'],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join(''));
}

function renderTokenGrid() {
  const takenBy = new Map(app.state.players.map((p) => [p.token, p.name]));
  if (!app.selectedToken || takenBy.has(app.selectedToken)) {
    app.selectedToken = TOKENS.find((t) => !takenBy.has(t.id))?.id ?? null;
  }
  setHtml($('#token-grid'), TOKENS.map((t) => {
    const owner = takenBy.get(t.id);
    const selected = t.id === app.selectedToken;
    return `<button type="button" class="token-opt${selected ? ' selected' : ''}" data-ui="pick-token" data-token="${esc(t.id)}"
        role="radio" aria-checked="${selected}" title="${owner ? `Taken by ${esc(owner)}` : esc(t.label)}"${disabledAttr(!owner)}>
      <span class="token-emoji">${t.emoji}</span><span class="token-label">${esc(t.label)}</span>
    </button>`;
  }).join(''));
}

function takeoverLink() {
  const t = app.takeover;
  const name = playerById(app.state, t.playerId)?.name || t.name || 'your';
  return `<button type="button" class="linkish" data-ui="takeover">Take over ${esc(name)}'s seat</button>`;
}

function joinLobby(event) {
  event.preventDefault();
  const name = $('#join-name').value.trim();
  if (!name) {
    toast('Enter your name first.', 'error');
    $('#join-name').focus();
    return;
  }
  if (!app.selectedToken) {
    toast('Pick a token first.', 'error');
    return;
  }
  saveName(name);
  app.joinName = name;
  act('JOIN', { name, token: app.selectedToken });
}

// ---------------------------------------------------------------------------
// Game screen: side panel
// ---------------------------------------------------------------------------

function renderGame() {
  syncTradeDraft();
  syncTradeSeen();
  if (app.sheetForTrade && !app.tradeDraft) {
    app.sheetForTrade = false;
    if (in3dLayout() && SHEET.matches) setPanelOpen(false, { quiet: true });
  }
  renderBanner();
  renderAuction();
  renderActions();
  renderRecentLog();
  renderPlayers();
  renderProperties();
  renderFooter();
  renderDialog();
  tick();
  updateSafeArea(); // a folded bottom sheet grows and shrinks with what it shows
}

function renderBanner() {
  const s = app.state;
  const m = me();
  const cur = playerById(s, currentPlayerId(s));
  const mine = isMyTurn();
  let title;
  if (s.status === 'finished') {
    const winner = playerById(s, s.winnerId);
    title = esc(winner ? (winner.id === m?.id ? '🏆 You win!' : `🏆 ${winner.name} wins!`) : 'Game over');
  } else {
    title = mine ? esc(myTurnText(s)) : otherTurnHtml(s, cur);
  }
  const sub = [];
  if (s.status === 'active') sub.push(`Turn ${s.turn.number}`);
  if (s.settings.freeParkingPot) sub.push(`Free Parking pot ${money(s.pot)}`);
  if (!m) sub.push('Spectating');
  // During an auction the sheet right below shows its clock; the banner doesn't repeat it.
  const clock = s.status === 'active' && s.turn.phase === 'auction' ? '' : '<span class="countdown" data-countdown hidden></span>';

  setHtml($('#turn-banner'), `
    <div class="turn-banner${mine ? ' mine' : ''}" style="--pc:${cur && s.status === 'active' ? playerColor(s, cur.id) : 'var(--muted)'}">
      <span class="turn-token">${cur && s.status === 'active' ? tokenEmoji(cur.token) : '🏁'}</span>
      <div class="turn-text">
        <div class="turn-title">${title}</div>
        <div class="turn-sub">${esc(sub.join(' · '))}</div>
      </div>
      ${clock}
    </div>`);
}

function myTurnText(s) {
  const t = s.turn;
  switch (t.phase) {
    case 'auction': return `🔨 Auction for ${tileName(s.auction?.tileIndex)}`;
    case 'trading': return s.trade?.fromPlayerId === me()?.id
      ? `🤝 Waiting for ${playerName(s, s.trade.toPlayerId)} to answer your offer…`
      : `🤝 ${playerName(s, s.trade?.fromPlayerId)} offered ${playerName(s, s.trade?.toPlayerId)} a trade`;
    case 'rolling': return 'Your turn — roll the dice';
    case 'jail_decision': {
      // Only the options that are open right now (the fine needs the cash, the card needs a card).
      const options = [
        can('PAY_JAIL_FINE') && `pay ${money(BOARD.jailFine)}`,
        can('USE_JAIL_CARD') && 'use a card',
        'roll for doubles',
      ].filter(Boolean);
      const last = options.pop();
      const list = options.length ? `${options.join(', ')} or ${last}` : last;
      return `You're in jail — ${list}`;
    }
    case 'buying_or_auction': return `Buy ${tileName(t.pendingPurchase)} for ${money(TILES[t.pendingPurchase]?.price)}?`;
    case 'paying': return can('PAY_DEBT')
      ? `You owe ${money(t.pendingDebt?.amount)}${debtCreditorText(s, t.pendingDebt)} — pay it to continue`
      : `You owe ${money(t.pendingDebt?.amount)} — raise cash or declare bankruptcy`;
    case 'end_turn': return t.rollAgain ? 'Doubles! Roll again' : 'Build or mortgage if you like, then end your turn';
    default: return 'Your turn';
  }
}

/** Banner text (HTML) while someone else is to move. */
function otherTurnHtml(s, cur) {
  const t = s.turn;
  const name = cur?.name ?? 'the next player';
  // Auctions and trade offers involve more than the current player, whether or not they're online.
  if (t.phase === 'auction' && s.auction) return esc(`🔨 ${tileName(s.auction.tileIndex)} is up for auction`);
  if (t.phase === 'trading' && s.trade) {
    const to = s.trade.toPlayerId === me()?.id ? 'you' : playerName(s, s.trade.toPlayerId);
    return esc(`🤝 ${playerName(s, s.trade.fromPlayerId)} offered ${to} a trade`);
  }
  if (cur && !cur.connected) {
    // tick() fills in the countdown to the server's auto-play.
    return t.deadlineAt
      ? `${esc(name)} is offline — auto-play in <span data-offline-in></span>`
      : `${esc(name)} is offline — waiting for them to come back…`;
  }
  switch (t.phase) {
    case 'rolling': return esc(`Waiting for ${name} to roll…`);
    case 'jail_decision': return esc(`${name} is in jail and deciding what to do…`);
    case 'buying_or_auction': return esc(`${name} is deciding whether to buy ${tileName(t.pendingPurchase)}…`);
    case 'paying': return esc(`${name} owes ${money(t.pendingDebt?.amount)} and is raising cash…`);
    case 'end_turn': return esc(t.rollAgain ? `${name} rolled doubles and goes again…` : `Waiting for ${name} to finish their turn…`);
    default: return esc(`Waiting for ${name}…`);
  }
}

/** Shown with the (disabled) buttons while the connection is down. */
function netNoteHtml() {
  const { status } = app.net;
  if (status !== 'connecting' && status !== 'reconnecting') return '';
  return '<p class="hint net-note">Reconnecting… actions are paused. <button type="button" class="linkish" data-ui="retry">Retry</button></p>';
}

function renderActions() {
  const s = app.state;
  const m = me();
  const bar = $('#action-bar');
  if (s.status !== 'active') {
    setHtmlKeepFocus(bar, '<button type="button" class="btn primary block" data-ui="home">Back to home</button>');
    return;
  }
  if (!m) {
    setHtmlKeepFocus(bar, `<p class="note">👀 You're watching this game.${app.takeover ? ` ${takeoverLink()}` : ''}</p>${tradeNoteHtml(s)}`);
    return;
  }
  if (m.bankrupt) {
    setHtml(bar, `<p class="note">${app.resigned ? 'You resigned' : 'You went bankrupt'} — watching the rest of the game.</p>${tradeNoteHtml(s)}`);
    return;
  }

  const t = s.turn;
  const ok = ready();
  const buttons = [];
  // `nofocus`: a new dialog never moves keyboard focus onto it (Space must not accept a trade).
  // `attrs`: extra attributes, e.g. the id of the trade offer a button answers.
  const button = (type, label, cls = '', enabled = true, nofocus = false, attrs = '') =>
    buttons.push(`<button type="button" class="btn ${cls}" data-act="${type}"${nofocus ? ' data-nofocus' : ''}${attrs}${disabledAttr(enabled && ok)}>${label}</button>`);

  if (t.phase === 'trading' && s.trade) {
    setHtmlKeepFocus(bar, tradeActionsHtml(s, s.trade, m, button, buttons));
    return;
  }

  if (can('ROLL')) {
    const label = t.phase === 'jail_decision' ? 'Roll for doubles' : t.phase === 'end_turn' ? 'Roll again' : 'Roll dice';
    button('ROLL', `🎲 ${label}`, 'primary');
  }
  if (isMyTurn() && t.phase === 'buying_or_auction' && t.pendingPurchase != null) {
    button('BUY', `Buy ${money(TILES[t.pendingPurchase].price)}`, 'primary', can('BUY'));
  }
  if (isMyTurn() && t.phase === 'paying' && t.pendingDebt) {
    button('PAY_DEBT', `Pay debt ${money(t.pendingDebt.amount)}`, 'primary', can('PAY_DEBT'));
  }
  if (can('PAY_JAIL_FINE')) button('PAY_JAIL_FINE', `Pay fine ${money(BOARD.jailFine)}`);
  if (can('USE_JAIL_CARD')) button('USE_JAIL_CARD', '🎫 Use jail card');
  if (can('END_TURN')) button('END_TURN', 'End turn', 'primary');
  if (can('DECLINE')) button('DECLINE', 'Decline');
  // The builder is a panel of its own (a dialog, or the panel slot on phones); this only opens it.
  if (can('PROPOSE_TRADE') && !app.tradeDraft) {
    buttons.push(`<button type="button" class="btn" data-ui="trade-open"${disabledAttr(ok)}>🤝 Trade</button>`);
  }
  // Once the debt can be paid, bankruptcy is only a misclick away from quitting: not offered (Resign still is).
  if (can('DECLARE_BANKRUPTCY') && !can('PAY_DEBT')) button('DECLARE_BANKRUPTCY', 'Declare bankruptcy', 'danger');

  let hint = '';
  const canRaise = app.legal.mortgage.length > 0 || app.legal.sellHouse.length > 0;
  const canTrade = can('PROPOSE_TRADE');
  if (isMyTurn() && t.phase === 'buying_or_auction' && !can('BUY')) {
    const other = s.settings.auctionOnDecline ? 'decline to auction it' : 'decline';
    hint = canRaise ? `Not enough cash to buy — mortgage or sell to raise it, or ${other}.` : `Not enough cash to buy — ${other}.`;
  } else if (isMyTurn() && t.phase === 'paying' && !can('PAY_DEBT')) {
    hint = canRaise
      ? `Raise ${money(t.pendingDebt.amount - m.cash)} more by selling or mortgaging${canTrade ? ', or trade' : ''}.`
      : `Nothing left to sell or mortgage${canTrade ? ' — you can still trade' : ''}.`;
  }
  // The Trade button is gone once this turn's offers are used up (TRADE_LIMIT): say so.
  if (!hint && isMyTurn() && !canTrade && ['rolling', 'jail_decision', 'end_turn', 'paying'].includes(t.phase)
    && (t.tradesProposed ?? 0) >= MAX_TRADES_PER_TURN) {
    hint = `No more trade offers this turn (${MAX_TRADES_PER_TURN} is the limit).`;
  }
  // Space can't end the turn while the dice and token are still moving; the tip returns after.
  const hold = can('END_TURN') ? endTurnKeyHold() : 0;
  clearTimeout(app.keyTimer);
  if (hold > 0) app.keyTimer = setTimeout(rerender, hold + 20);
  const key = keyboardAction();
  const keyHint = key ? `<p class="hint kbd-hint">Tip: press <kbd>Space</kbd> to ${key === 'ROLL' ? 'roll' : 'end your turn'}.</p>` : '';
  setHtmlKeepFocus(bar, buttons.length
    ? `<div class="action-buttons">${buttons.join('')}</div>${netNoteHtml()}${hint ? `<p class="hint">${hint}</p>` : keyHint}`
    : '');
}

/** The action bar while a trade offer is pending: the target answers, the proposer may withdraw, others just see it. */
function tradeActionsHtml(s, trade, m, button, buttons) {
  const to = playerName(s, trade.toPlayerId);
  const id = tradeIdAttr(trade);
  if (m.id === trade.toPlayerId) {
    if (can('ACCEPT_TRADE')) button('ACCEPT_TRADE', 'Accept trade', 'primary', tradeArmed(), true, id);
    if (can('REJECT_TRADE')) button('REJECT_TRADE', 'Reject', '', true, true, id);
    const why = can('ACCEPT_TRADE') ? '' : `<p class="hint">${esc(acceptBlocker(s, trade))}</p>`;
    return `<div class="action-buttons">${buttons.join('')}</div>${netNoteHtml()}${why}`;
  }
  if (m.id === trade.fromPlayerId) {
    if (can('REJECT_TRADE')) button('REJECT_TRADE', 'Withdraw offer', '', true, true, id);
    const clock = s.settings.turnTimeoutSec > 0 ? `<p class="hint">Your turn clock keeps running while ${esc(to)} decides.</p>` : '';
    return `<div class="action-buttons">${buttons.join('')}</div>${netNoteHtml()}${clock}`;
  }
  return tradeNoteHtml(s);
}

/** Buttons that answer a trade offer name it, so a click never lands on an offer that replaced it. */
const tradeIdAttr = (trade) => ` data-trade-id="${esc(trade.id)}"`;

/** Remember when the pending offer first appeared on screen; its Accept waits TRADE_ARM_MS from then. */
function syncTradeSeen() {
  const s = app.state;
  const trade = s.status === 'active' && s.turn.phase === 'trading' ? s.trade : null;
  if (!trade) {
    app.tradeSeen = null;
    return;
  }
  if (app.tradeSeen?.id === trade.id) return;
  app.tradeSeen = { id: trade.id, at: Date.now() };
  if (trade.toPlayerId === me()?.id) rerenderAfter(TRADE_ARM_MS);
}

const tradeArmed = () => !!app.tradeSeen && Date.now() - app.tradeSeen.at >= TRADE_ARM_MS;

/** One re-render `ms` from now, once an arming delay is over (a later request replaces an earlier one). */
function rerenderAfter(ms) {
  clearTimeout(app.armTimer);
  app.armTimer = setTimeout(rerender, ms + 20);
}

/** For everyone but the two parties: what is on the table right now (empty when no offer is pending). */
function tradeNoteHtml(s) {
  const trade = s.status === 'active' && s.turn.phase === 'trading' ? s.trade : null;
  if (!trade) return '';
  const who = `${playerName(s, trade.fromPlayerId)} offered ${playerName(s, trade.toPlayerId)} a trade`;
  return `<p class="note trade-note">🤝 ${esc(who)}: ${esc(tradeLine(s, trade))}.</p>`;
}

// ---------------------------------------------------------------------------
// Auction sheet — shown to everyone at the table while the phase is `auction` (read-only for
// spectators and players out of the auction). It sits in the side panel on every layout, right
// under the turn banner. The custom bid box (#auction-form) is static markup: re-renders only
// update its limits, so a half-typed amount survives every incoming bid.
// ---------------------------------------------------------------------------

function renderAuction() {
  const s = app.state;
  const a = s.status === 'active' && s.turn.phase === 'auction' ? s.auction : null;
  $('#auction-sheet').hidden = !a;
  if (!a) {
    app.auctionKey = null;
    return;
  }
  const key = `${s.turn.number}:${a.tileIndex}`;
  const fresh = app.auctionKey !== key;
  if (fresh) {
    app.auctionKey = key;
    app.auctionBids = a.bids.length;
    $('#bid-input').value = '';
  }
  const bumped = a.bids.length !== app.auctionBids; // a new bid since the last render: the amount pops
  app.auctionBids = a.bids.length;
  // New amounts on the quick bids (a new auction, a bid, a resigned bidder's bid gone): arm them again.
  if (fresh || a.highBid !== app.auctionHigh) armQuickBids();
  app.auctionHigh = a.highBid;

  const m = me();
  const limits = can('BID') ? app.legal.auction : null;
  const ok = ready();
  const armed = Date.now() >= app.quickBidsAt;
  setHtml($('#auction-head'), auctionHeadHtml(a));
  setHtml($('#auction-high'), auctionHighHtml(s, a, m, bumped || fresh));
  setHtml($('#auction-status'), auctionStatusHtml(s, a, m, limits));
  setHtmlKeepFocus($('#auction-controls'), limits
    ? quickBids(a.highBid, limits).map(({ step, amount, affordable }) => `
      <button type="button" class="btn quick-bid" data-act="BID" data-amount="${amount}" data-key="${step}"
        aria-label="Bid ${money(amount)}${affordable ? '' : ' (more than you have)'}"${disabledAttr(ok && armed && affordable)}>
        <span class="qb-step">+${money(step)}</span><span class="qb-total">${money(amount)}</span>
      </button>`).join('')
    : '');
  const form = $('#auction-form');
  form.hidden = !limits;
  if (limits) {
    const input = $('#bid-input');
    input.min = String(limits.minBid);
    input.max = String(limits.maxBid);
    input.placeholder = `${limits.minBid}–${limits.maxBid}`;
    $('#bid-submit').disabled = !ok;
    $('#bid-max').disabled = !ok;
    $('#bid-max').title = `Fill in all your cash (${money(limits.maxBid)}), then press Bid`;
  }
  setHtmlKeepFocus($('#auction-pass'), can('PASS_AUCTION')
    ? `<button type="button" class="btn block" data-act="PASS_AUCTION"${disabledAttr(ok)}>Pass — drop out</button>`
    : '');
  if (fresh) revealAuctionControls();
  setHtml($('#auction-people'), a.participants.map((id) => {
    const p = playerById(s, id);
    const where = p?.bankrupt ? 'out' : a.passed.includes(id) ? 'passed' : id === a.highBidderId ? 'high' : 'in';
    const label = { out: 'out', passed: 'passed', high: 'high bid', in: 'in' }[where];
    return `<li class="ap ap-${where}" style="--pc:${playerColor(s, id)}">
      <span class="pdot"></span><span class="ap-name">${esc(p?.name ?? '?')}${id === m?.id ? ' (you)' : ''}</span><span class="ap-state">${label}</span>
    </li>`;
  }).join(''));
}

/**
 * Quick bids: highBid + each step, always in the same slots. A step I can't afford stays in its slot,
 * disabled, so a slot never changes into a different kind of bid under the pointer; bidding all my
 * cash goes through the bid box (its Max button).
 */
function quickBids(highBid, { maxBid }) {
  return QUICK_BIDS.map((step) => ({ step, amount: highBid + step, affordable: highBid + step <= maxBid }));
}

function armQuickBids() {
  app.quickBidsAt = Date.now() + QUICK_BID_ARM_MS;
  rerenderAfter(QUICK_BID_ARM_MS);
}

/**
 * Phones: the auction sheet sits under the board, and a 10 s clock leaves no time to scroll. When an
 * auction starts and I can bid or pass, bring its controls into view (unless they already are).
 */
function revealAuctionControls() {
  if (!NARROW.matches || !(can('BID') || can('PASS_AUCTION'))) return;
  const sheet = $('#auction-sheet');
  const controls = $('#auction-pass').firstElementChild ?? $('#auction-controls');
  if (in3dLayout()) {
    // The page doesn't scroll in the 3D layout: the floating panel / bottom sheet does.
    const behavior = document.hidden || REDUCED_MOTION.matches ? 'auto' : 'smooth';
    controls.scrollIntoView({ block: 'nearest', behavior });
    return;
  }
  const top = parseFloat(getComputedStyle(sheet).scrollMarginTop) || 0;
  const box = controls.getBoundingClientRect();
  if (box.top >= top && box.bottom <= window.innerHeight) return;
  // The whole sheet if it fits under the top bar, else just enough to show the controls at the bottom.
  const fits = sheet.getBoundingClientRect().height + top <= window.innerHeight;
  // A hidden tab doesn't animate (a smooth scroll would never happen): jump, so it's there on return.
  const behavior = document.hidden || REDUCED_MOTION.matches ? 'auto' : 'smooth';
  if (fits) sheet.scrollIntoView({ block: 'start', behavior });
  else controls.scrollIntoView({ block: 'end', behavior });
}

function auctionHeadHtml(a) {
  const tile = TILES[a.tileIndex];
  return `<div class="auction-top">
      <span class="auction-kicker">🔨 Auction</span>
      <span class="countdown auction-clock" data-countdown data-urgent="3" hidden></span>
    </div>
    <div class="auction-timebar" aria-hidden="true"><i data-auction-bar></i></div>
    ${deedHtml(tile, `List price ${money(tile.price)}`, 'auction-title')}`;
}

/** The high bid and who holds it. `bump`: a new bid just came in, so the amount pops (CSS). */
function auctionHighHtml(s, a, m, bump) {
  const bidder = playerById(s, a.highBidderId);
  const mine = !!m && bidder?.id === m.id;
  const who = bidder
    ? `<span class="auction-bidder" style="--pc:${playerColor(s, bidder.id)}"><span class="pdot"></span>${mine ? 'You' : esc(bidder.name)}</span>`
    : '';
  const cls = ['auction-amount', bump && 'bump', !bidder && 'none'].filter(Boolean).join(' ');
  return `<div class="auction-high${mine ? ' winning' : ''}">
    <span class="auction-label">High bid</span>
    <strong class="${cls}">${bidder ? money(a.highBid) : 'No bids yet'}</strong>${who}
  </div>`;
}

/** One line on where I stand in this auction. */
function auctionStatusHtml(s, a, m, limits) {
  const line = (text, cls = '') => `<p class="auction-status ${cls}">${text}</p>`;
  if (!m) return line('👀 You are watching.');
  if (m.bankrupt || !a.participants.includes(m.id)) return line('You are not in this auction.');
  if (a.passed.includes(m.id)) return line('You passed.');
  const cash = `You have <strong>${money(m.cash)}</strong>`;
  if (a.highBidderId === m.id) return line(`${cash} · you're winning — others can still outbid you.`, 'good');
  if (!limits) return line(`${cash} — not enough to outbid ${money(a.highBid)}.`, 'warn');
  const outbid = a.bids.some((b) => b.playerId === m.id);
  return line(`${cash}${outbid ? ' · <span class="neg">outbid</span> — raise or pass' : ' · bid or pass'}`);
}

/** The custom amount from the bid box (Enter or the Bid button). */
function submitBid(event) {
  event.preventDefault();
  const limits = can('BID') ? app.legal.auction : null;
  const input = $('#bid-input');
  if (!limits || !ready()) return;
  const text = input.value.trim();
  const amount = Number(text);
  if (!text || !Number.isInteger(amount)) {
    toast(`Type a whole-dollar bid of at least ${money(limits.minBid)}.`, 'error');
    return;
  }
  if (amount < limits.minBid) {
    toast(`The high bid is ${money(app.state.auction.highBid)} — bid at least ${money(limits.minBid)}.`, 'info', 3000);
    return;
  }
  if (amount > limits.maxBid) {
    toast(`You only have ${money(limits.maxBid)}.`, 'error');
    return;
  }
  if (!act('BID', { amount })) return;
  input.value = '';
  if (COARSE.matches) input.blur(); // let the phone keyboard go, so the result is visible
}

// ---------------------------------------------------------------------------
// Trading. The current player opens the builder (a dialog; the panel slot on narrow layouts),
// picks a player from legal.tradeTargets and what goes each way; the target gets the offer as
// a dialog with Accept / Reject, the proposer can withdraw it, everyone else sees a note.
// The builder's form is rewritten only when the table changes (tiles, cash, targets), never while
// typing: values live in app.tradeDraft and are put back after a rewrite (hydrateTradeBuilder).
// ---------------------------------------------------------------------------

const emptyTradeSide = () => ({ tiles: [], cash: '', jail: '' });

function openTradeBuilder() {
  if (!can('PROPOSE_TRADE') || !app.legal.tradeTargets.length) return;
  const targets = app.legal.tradeTargets;
  const to = targets.includes(app.tradeWith) ? app.tradeWith : targets[0];
  app.tradeDraft = { to, give: emptyTradeSide(), get: emptyTradeSide() };
  app.dismissed.delete('trade-build');
  // 3D on phones: the builder needs the whole sheet (folded again when it closes, see renderGame).
  if (in3dLayout() && SHEET.matches && !panelOpen()) {
    setPanelOpen(true, { quiet: true });
    app.sheetForTrade = true;
  }
  renderGame();
  // Phones: the builder opens above the action bar, which may be further down the page.
  if (NARROW.matches) $('#panel-dialog').scrollIntoView({ block: 'start', behavior: REDUCED_MOTION.matches ? 'auto' : 'smooth' });
}

function closeTradeBuilder() {
  app.tradeDraft = null;
  sound('close');
  rerender();
}

/**
 * Keep the draft in line with the table. It closes once the offer is out, or as soon as I can't
 * propose any more (I rolled onto a purchase decision, my turn ended); a draft that popped back up
 * later would be more surprising than one to rebuild.
 */
function syncTradeDraft() {
  const d = app.tradeDraft;
  if (!d) return;
  const s = app.state;
  if (!me() || s.status !== 'active' || !can('PROPOSE_TRADE')) {
    app.tradeDraft = null;
    return;
  }
  const m = me();
  const targets = app.legal.tradeTargets;
  if (!targets.includes(d.to)) {
    d.to = targets[0] ?? null;
    d.get = emptyTradeSide();
  }
  // Tiles that changed hands, or whose group got buildings meanwhile, drop out of the offer.
  d.give.tiles = d.give.tiles.filter((i) => tileState(s, i)?.ownerId === m.id && isTradeable(s, i));
  d.get.tiles = d.get.tiles.filter((i) => tileState(s, i)?.ownerId === d.to && isTradeable(s, i));
}

function tradeBuilderHtml(s, d) {
  const m = me();
  const target = playerById(s, d.to);
  const ok = ready();
  const chips = app.legal.tradeTargets.map((id) => playerById(s, id)).filter(Boolean).map((p) => `
    <button type="button" class="trade-target${p.id === d.to ? ' selected' : ''}" data-ui="trade-target" data-key="${esc(p.id)}"
      role="radio" aria-checked="${p.id === d.to}" aria-label="${esc(`${p.name}, ${money(p.cash)}`)}"
      style="--pc:${playerColor(s, p.id)}"${disabledAttr(ok)}>
      <span class="pdot"></span><span class="tt-token">${tokenEmoji(p.token)}</span><span class="tt-name">${esc(p.name)}</span><span class="tt-cash">${money(p.cash)}</span>
    </button>`).join('');
  return `<h3 id="dialog-title" class="dialog-title">🤝 Propose a trade</h3>
    <div class="trade-targets" role="radiogroup" aria-label="Trade with">${chips}</div>
    ${target ? `<div class="trade-cols">
        ${tradeSideFormHtml(s, 'give', 'You give', m)}
        ${tradeSideFormHtml(s, 'get', `You get from ${target.name}`, target)}
      </div>
      <div class="trade-summary" data-trade-summary aria-live="polite"></div>` : ''}
    <div class="dialog-btns">
      <button type="button" class="btn primary" data-ui="trade-send" data-trade-send disabled>Send offer</button>
      <button type="button" class="btn" data-ui="trade-cancel">Cancel</button>
    </div>`;
}

/** One side of the builder: `owner`'s tiles (locked when their group has buildings), cash and jail cards. */
function tradeSideFormHtml(s, side, heading, owner) {
  const rows = ownedTiles(s, owner.id).map((i) => {
    const ts = tileState(s, i);
    const free = isTradeable(s, i);
    let note = '';
    if (!free) note = '<span class="trade-lock">🏠 sell buildings first</span>';
    else if (ts.mortgaged) note = `<span class="tag mort" title="Mortgaged: the receiver pays the bank ${money(mortgageTransferFee(i))}">M · fee ${money(mortgageTransferFee(i))}</span>`;
    return `<label class="trade-tile${free ? '' : ' locked'}" style="--gc:${groupMeta(groupKeyOf(i)).color}">
      <input type="checkbox" data-trade="${side}-tile" data-key="${i}"${free ? '' : ' disabled'}>
      <span class="trade-tile-name">${esc(TILES[i].name)}</span>${note}
    </label>`;
  }).join('');
  const whose = side === 'give' ? 'You have' : `${esc(owner.name)} has`;
  const count = (field, label, max, maxText) => `<label class="trade-count">
      <span class="trade-count-label">${label}</span>
      <span class="count-field${field === 'cash' ? ' money' : ''}"><input type="number" inputmode="numeric" min="0" max="${max}" step="1"
        placeholder="0" autocomplete="off" data-trade="${side}-${field}"></span>
      <span class="trade-count-max">of ${maxText}</span>
    </label>`;
  const cards = owner.getOutOfJailCards;
  return `<fieldset class="trade-col trade-side-${side}">
    <legend class="trade-col-head">${esc(heading)}</legend>
    <div class="trade-tiles">${rows || `<p class="muted small">${whose} no properties.</p>`}</div>
    ${count('cash', 'Cash', owner.cash, money(owner.cash))}
    ${cards > 0 ? count('jail', '🎫 Jail cards', cards, cards) : ''}
  </fieldset>`;
}

/** After a (re)render of the builder: put the draft's values back and refresh the summary. */
function hydrateTradeBuilder(box) {
  const d = app.tradeDraft;
  if (!d) return;
  for (const el of box.querySelectorAll('[data-trade]')) {
    const [side, field] = el.dataset.trade.split('-');
    if (field === 'tile') el.checked = d[side].tiles.includes(Number(el.dataset.key));
    else if (el.value !== d[side][field]) el.value = d[side][field];
  }
  updateTradeSummary(box);
}

/** A builder input changed: update the draft and the summary, without rewriting the form. */
function onTradeInput(el) {
  const d = app.tradeDraft;
  if (!d) return;
  const [side, field] = el.dataset.trade.split('-');
  if (field === 'tile') {
    const index = Number(el.dataset.key);
    const tiles = d[side].tiles.filter((i) => i !== index);
    if (el.checked) tiles.push(index);
    d[side].tiles = tiles.sort((a, b) => a - b);
  } else {
    d[side][field] = el.value;
  }
  updateTradeSummary(el.closest('#dialog-layer, #panel-dialog') ?? document);
}

const parseCount = (text) => {
  const t = String(text ?? '').trim();
  const n = t === '' ? 0 : Number(t);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/**
 * The draft as a PROPOSE_TRADE payload plus what's wrong with it — the engine's validateTrade
 * checks, and the fee check ACCEPT_TRADE would fail on (cash can't change while an offer is open).
 */
function readTradeDraft(s, d) {
  const m = me();
  const target = playerById(s, d.to);
  const errors = [];
  const side = (raw, owner, you) => {
    const cash = parseCount(raw.cash);
    const jailCards = parseCount(raw.jail);
    if (cash === null) errors.push('Cash must be a whole number of dollars.');
    else if (cash > owner.cash) errors.push(`${you ? 'You only have' : `${owner.name} only has`} ${money(owner.cash)}.`);
    if (jailCards === null) errors.push('Jail cards must be a whole number.');
    else if (jailCards > owner.getOutOfJailCards) {
      errors.push(`${you ? 'You have' : `${owner.name} has`} only ${owner.getOutOfJailCards} jail card${owner.getOutOfJailCards === 1 ? '' : 's'}.`);
    }
    return { cash: cash ?? 0, tiles: [...raw.tiles], jailCards: jailCards ?? 0 };
  };
  const give = side(d.give, m, true);
  const get = side(d.get, target, false);
  const empty = [give, get].every((x) => !x.cash && !x.jailCards && !x.tiles.length);
  const fees = { mine: tradeFee(s, get.tiles), theirs: tradeFee(s, give.tiles) };
  const myCash = m.cash - give.cash + get.cash;
  const theirCash = target.cash - get.cash + give.cash;
  if (!errors.length && myCash < fees.mine) errors.push(`You couldn't pay the ${money(fees.mine)} mortgage fee.`);
  if (!errors.length && theirCash < fees.theirs) errors.push(`${target.name} couldn't pay the ${money(fees.theirs)} mortgage fee.`);
  // In debt, a trade may not leave me less to pay with (mirrors rules.checkDebtTrade: UNFAIR_TRADE).
  const inDebt = s.turn.phase === 'paying';
  if (!errors.length && inDebt) {
    const worth = (tiles) => tiles.reduce((sum, i) => sum + (tileState(s, i)?.mortgaged ? 0 : TILES[i].mortgage), 0);
    const change = get.cash - give.cash - fees.mine + worth(get.tiles) - worth(give.tiles);
    if (change < 0) errors.push(`You're in debt, so you can't give value away: ask for ${money(-change)} more (properties count at their mortgage value).`);
  }
  return { payload: { toPlayerId: d.to, give, get }, errors, empty, fees, target, inDebt, myCashAfter: myCash - fees.mine };
}

function updateTradeSummary(box) {
  const d = app.tradeDraft;
  const summary = box.querySelector('[data-trade-summary]');
  const send = box.querySelector('[data-trade-send]');
  if (!d || !summary || !playerById(app.state, d.to)) {
    if (send) send.disabled = true;
    return;
  }
  const r = readTradeDraft(app.state, d);
  const { give, get } = r.payload;
  const rows = [['You give', sideText(app.state, give)], ['You get', sideText(app.state, get)]];
  if (r.fees.mine || r.fees.theirs) rows.push(['10% fees', `you ${money(r.fees.mine)} · ${r.target.name} ${money(r.fees.theirs)}`]);
  rows.push(['Your cash after', money(r.myCashAfter)]);
  let note = '';
  if (r.errors.length) note = `<p class="form-error">${esc(r.errors[0])}</p>`;
  else if (r.empty) note = '<p class="hint">Tick properties or add cash on either side (or both).</p>';
  else if (r.inDebt) note = '<p class="hint">You’re in debt: you may sell, but not give away — what you get must be worth at least the mortgage value of what you give.</p>';
  else if (r.fees.mine || r.fees.theirs) note = '<p class="hint">Whoever receives a mortgaged property pays the bank 10% of its mortgage value.</p>';
  setHtml(summary, `<dl class="trade-sum">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>${note}`);
  if (send) send.disabled = !ready() || r.empty || r.errors.length > 0;
}

function sendTrade() {
  const d = app.tradeDraft;
  if (!d || !playerById(app.state, d.to)) return;
  const r = readTradeDraft(app.state, d);
  if (r.empty || r.errors.length) {
    toast(r.errors[0] ?? 'Pick something to trade first.', 'error');
    return;
  }
  app.tradeWith = d.to;
  act('PROPOSE_TRADE', r.payload);
}

/** "Boardwalk (mortgaged), $100, 1 jail card" — or "nothing". */
function sideText(s, side) {
  const parts = side.tiles.map((i) => `${tileName(i)}${tileState(s, i)?.mortgaged ? ' (mortgaged)' : ''}`);
  if (side.cash > 0) parts.push(money(side.cash));
  if (side.jailCards > 0) parts.push(`${side.jailCards} jail card${side.jailCards > 1 ? 's' : ''}`);
  return parts.length ? parts.join(', ') : 'nothing';
}

/** "Alice gives Boardwalk; Bob gives $300" — a pending trade in one line. */
function tradeLine(s, trade) {
  return `${playerName(s, trade.fromPlayerId)} gives ${sideText(s, trade.give)}; ${playerName(s, trade.toPlayerId)} gives ${sideText(s, trade.get)}`;
}

/** Why the target can't accept the pending offer (legal leaves ACCEPT_TRADE out). */
function acceptBlocker(s, trade) {
  const m = me();
  const from = playerById(s, trade.fromPlayerId);
  if (m.cash < trade.get.cash) return `You can't accept: it asks for ${money(trade.get.cash)} and you have ${money(m.cash)}.`;
  const myFee = tradeFee(s, trade.give.tiles);
  if (m.cash - trade.get.cash + trade.give.cash < myFee) return `You can't accept: you couldn't pay the ${money(myFee)} mortgage fee.`;
  const theirFee = tradeFee(s, trade.get.tiles);
  if (from && from.cash - trade.give.cash + trade.get.cash < theirFee) {
    return `This can't go through: ${from.name} couldn't pay the ${money(theirFee)} mortgage fee.`;
  }
  return "This offer can't be accepted as it stands — reject it.";
}

/** A pending offer, as the target (incoming) or the proposer (outgoing) sees it. */
function tradeOfferHtml(s, trade, compact) {
  const m = me();
  const incoming = trade.toPlayerId === m.id;
  const other = playerById(s, incoming ? trade.fromPlayerId : trade.toPlayerId);
  const youGet = incoming ? trade.give : trade.get;
  const youGive = incoming ? trade.get : trade.give;
  const myFee = tradeFee(s, youGet.tiles);
  const theirFee = tradeFee(s, youGive.tiles);
  const ok = ready();
  const id = tradeIdAttr(trade);
  const title = incoming ? `🤝 ${other?.name ?? 'Someone'} offers you a trade` : `🤝 Your offer to ${other?.name ?? 'them'}`;
  let buttons = '';
  if (!compact && incoming) {
    buttons = `<div class="dialog-btns">
      <button type="button" class="btn primary" data-act="ACCEPT_TRADE" data-nofocus${id}${disabledAttr(ok && can('ACCEPT_TRADE') && tradeArmed())}>Accept</button>
      <button type="button" class="btn" data-act="REJECT_TRADE" data-nofocus${id}${disabledAttr(ok && can('REJECT_TRADE'))}>Reject</button>
    </div>`;
  } else if (!compact) {
    buttons = `<div class="dialog-btns">
      <button type="button" class="btn" data-act="REJECT_TRADE" data-nofocus${id}${disabledAttr(ok && can('REJECT_TRADE'))}>Withdraw offer</button>
    </div>`;
  }
  const fees = myFee || theirFee
    ? `<p class="trade-fee">10% mortgage fees to the bank: you ${money(myFee)} · ${esc(other?.name ?? 'they')} ${money(theirFee)}</p>`
    : '';
  const after = m.cash - youGive.cash + youGet.cash - myFee;
  const blocker = incoming && !can('ACCEPT_TRADE') ? `<p class="hint">${esc(acceptBlocker(s, trade))}</p>` : '';
  const sets = [
    ...setsCompleted(s, m.id, youGet, youGive).map((g) => `Completes your ${g} set`),
    ...(other ? setsCompleted(s, other.id, youGive, youGet).map((g) => `Completes ${other.name}'s ${g} set`) : []),
  ];
  const setsLine = sets.length ? `<p class="trade-sets">✨ ${esc(sets.join(' · '))}</p>` : '';
  return `${compact ? '' : `<h3 id="dialog-title" class="dialog-title">${esc(title)}</h3>`}
    <div class="trade-cols offer">
      ${tradeListHtml(s, 'You get', youGet)}
      ${tradeListHtml(s, 'You give', youGive)}
    </div>
    ${setsLine}${fees}
    <div class="dialog-cash">Your cash <strong>${money(m.cash)}</strong> → <strong>${money(after)}</strong></div>
    ${buttons}${compact ? '' : blocker}`;
}

/** Names of the colour groups `playerId` would own in full after receiving `receive` and giving `give` (not before). */
function setsCompleted(s, playerId, receive, give) {
  const mineAfter = (i) => receive.tiles.includes(i) || (tileState(s, i)?.ownerId === playerId && !give.tiles.includes(i));
  const groups = new Set(receive.tiles.map((i) => TILES[i].group).filter(Boolean));
  return [...groups]
    .filter((g) => !ownsFullGroup(s, playerId, g) && TILES.every((t) => t.group !== g || mineAfter(t.index)))
    .map((g) => BOARD.groups[g]?.name ?? g);
}

function tradeListHtml(s, heading, side) {
  const items = side.tiles.map((i) => `<li class="trade-item" style="--gc:${groupMeta(groupKeyOf(i)).color}">
      <span class="trade-item-name">${esc(TILES[i].name)}</span>${tileState(s, i)?.mortgaged ? '<span class="tag mort">Mortgaged</span>' : ''}
    </li>`);
  if (side.cash > 0) items.push(`<li class="trade-item plain">💵 ${money(side.cash)}</li>`);
  if (side.jailCards > 0) items.push(`<li class="trade-item plain">🎫 ${side.jailCards} Get Out of Jail Free card${side.jailCards > 1 ? 's' : ''}</li>`);
  return `<div class="trade-col">
    <div class="trade-col-head">${heading}</div>
    <ul class="trade-items">${items.join('') || '<li class="trade-item plain muted">Nothing</li>'}</ul>
  </div>`;
}

// Phones and narrow windows: the latest log lines in the panel (the board's own log is tiny there;
// style.css hides this list on wide layouts).
function renderRecentLog() {
  const lines = Array.isArray(app.state.log) ? app.state.log.slice(-RECENT_LOG_LINES) : [];
  setHtml($('#recent-log'), lines.map((line) => `<li>${esc(line)}</li>`).join(''));
}

// Every player's row opens (a <details>) to show their properties, so anyone — spectators
// included — can check who owns what and what it rents for. Open rows stay open (app.expanded).
function renderPlayers() {
  const s = app.state;
  const curId = s.status === 'active' ? currentPlayerId(s) : null;
  const myId = me()?.id;
  setHtmlKeepFocus($('#game-players'), s.players.map((p, i) => {
    const badges = [];
    if (p.inJail) badges.push('<span class="tag jail">🔒 In jail</span>');
    if (p.getOutOfJailCards > 0) badges.push(`<span class="tag goojf" title="Get Out of Jail Free cards">🎫 ${p.getOutOfJailCards}</span>`);
    if (!p.connected && !p.bankrupt) badges.push('<span class="tag off">offline</span>');
    if (p.id === s.winnerId) badges.push('<span class="tag set">winner</span>');
    const cls = ['prow', p.id === curId && 'current', p.bankrupt && 'bankrupt', !p.connected && 'offline'].filter(Boolean).join(' ');
    return `<li style="--pc:${PLAYER_COLORS[i % PLAYER_COLORS.length]}">
      <details class="pdetails" data-player="${esc(p.id)}"${app.expanded.has(p.id) ? ' open' : ''}>
        <summary class="${cls}" title="Show ${esc(p.name)}'s properties">
          <span class="pdot"></span>
          <span class="prow-token">${tokenEmoji(p.token)}</span>
          <span class="prow-main">
            <span class="prow-name">${esc(p.name)}${p.id === myId ? ' <span class="tag you">you</span>' : ''}</span>
            <span class="prow-badges">${badges.join('')}</span>
          </span>
          <span class="prow-cash">${p.bankrupt ? 'Bankrupt' : money(p.cash)}</span>
          <span class="prow-chev" aria-hidden="true"></span>
        </summary>
        <div class="holdings">${holdingsHtml(s, p)}</div>
      </details>
    </li>`;
  }).join(''));
}

function holdingsHtml(s, p) {
  const owned = s.tiles.filter((t) => t.ownerId === p.id);
  if (!owned.length) return `<p class="muted small">${p.bankrupt ? 'Out of the game — owns nothing.' : 'No properties yet.'}</p>`;
  return groupsHtml(s, owned, false);
}

function renderProperties() {
  const s = app.state;
  const m = me();
  const section = $('#props-section');
  section.hidden = !m || m.bankrupt;
  if (section.hidden) return;

  const live = s.status === 'active'; // a finished game shows what I ended with, without buttons
  const owned = s.tiles.filter((t) => t.ownerId === m.id);
  if (!owned.length) {
    setHtml($('#my-props'), `<p class="muted small">${live
      ? "You don't own anything yet — land on an unowned property to buy it."
      : 'You ended the game without properties.'}</p>`);
    return;
  }
  const bankLine = live ? `<div class="bank-line">Bank: ${s.bank.houses} houses · ${s.bank.hotels} hotels</div>` : '';
  setHtmlKeepFocus($('#my-props'), bankLine + groupsHtml(s, owned, live));
}

const groupKeyOf = (index) => (TILES[index].type === 'property' ? TILES[index].group : TILES[index].type);

function groupMeta(key) {
  const info = BOARD.groups[key];
  return {
    info,
    name: info?.name ?? (key === 'railroad' ? 'Railroads' : 'Utilities'),
    color: info?.color ?? (key === 'railroad' ? '#3d4448' : '#8a9199'),
  };
}

/** Owned tiles grouped by color set (railroads and utilities last); `buttons` adds build/mortgage controls. */
function groupsHtml(s, owned, buttons) {
  const groups = new Map();
  for (const ts of owned) {
    const key = groupKeyOf(ts.index);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ts);
  }
  return GROUP_ORDER
    .filter((key) => groups.has(key))
    .map((key) => groupHtml(s, key, groups.get(key), buttons))
    .join('');
}

function groupHtml(s, key, list, buttons) {
  const { info, name, color } = groupMeta(key);
  const total = TILES.filter((t) => (info ? t.group === key : t.type === key)).length;
  const fullSet = !!info && list.length === total;
  // The Build buttons of a full set with a mortgaged lot are disabled (MORTGAGED_IN_GROUP): say why.
  const mortgaged = buttons && fullSet ? list.filter((ts) => ts.mortgaged).map((ts) => tileName(ts.index)) : [];
  const note = mortgaged.length
    ? `<p class="hint pgroup-note">Unmortgage ${esc(mortgaged.join(' and '))} to build here.</p>`
    : '';
  return `<div class="pgroup" style="--gc:${color}">
    <div class="pgroup-head">
      <span>${esc(name)}</span><span class="muted">${list.length}/${total}</span>
      ${fullSet ? '<span class="tag set">Full set</span>' : ''}
    </div>
    ${note}
    ${list.sort((a, b) => a.index - b.index).map((ts) => propertyRow(s, ts, fullSet, buttons)).join('')}
  </div>`;
}

function propertyRow(s, ts, fullSet, withButtons) {
  const tile = TILES[ts.index];
  const i = ts.index;
  const L = app.legal;
  const ok = ready();
  const button = (type, list, label, cls = '') =>
    `<button type="button" class="btn small ${cls}" data-act="${type}" data-tile="${i}"${disabledAttr(ok && list.includes(i))}>${label}</button>`;

  const buttons = [];
  if (withButtons) {
    if (tile.type === 'property' && fullSet && !ts.mortgaged && ts.houses < 5) {
      buttons.push(button('BUILD', L.build, `${ts.houses === 4 ? 'Build hotel' : 'Build house'} −${money(tile.houseCost)}`));
    }
    if (ts.houses > 0) {
      buttons.push(button('SELL_HOUSE', L.sellHouse, `Sell ${ts.houses === 5 ? 'hotel' : 'house'} +${money(Math.floor(tile.houseCost / 2))}`));
    }
    if (!ts.mortgaged && ts.houses === 0) buttons.push(button('MORTGAGE', L.mortgage, `Mortgage +${money(tile.mortgage)}`));
    if (ts.mortgaged) {
      const canPay = ok && L.unmortgage.includes(i);
      buttons.push(button('UNMORTGAGE', L.unmortgage, `Unmortgage −${money(unmortgageCost(i))}`, canPay ? 'primary' : ''));
    }
  }

  const status = ts.mortgaged ? '<span class="tag mort">Mortgaged</span>' : buildingsHtml(ts.houses);
  return `<div class="prop${ts.mortgaged ? ' mortgaged' : ''}">
    <div class="prop-info">
      <div class="prop-top"><span class="prop-name">${esc(tile.name)}</span>${status}</div>
      <div class="prop-meta">${esc(rentText(s, i))}</div>
    </div>
    ${buttons.length ? `<div class="prop-btns">${buttons.join('')}</div>` : ''}
  </div>`;
}

function buildingsHtml(houses) {
  if (houses === 5) return '<span class="bldgs" title="Hotel"><i class="bldg hotel"></i></span>';
  if (houses > 0) return `<span class="bldgs" title="${houses} house${houses > 1 ? 's' : ''}">${'<i class="bldg house"></i>'.repeat(houses)}</span>`;
  return '';
}

function renderFooter() {
  const s = app.state;
  setHtml($('#panel-footer'), s.status === 'active' && can('LEAVE')
    ? `<button type="button" class="btn small ghost danger" data-act="LEAVE"${disabledAttr(ready())}>Resign</button>`
    : '');
}

// ---------------------------------------------------------------------------
// Dialogs — only for me. On wide layouts they float low over the board (never over the side
// panel or the dice); closing one just hides it, as the same buttons are in the side panel. On
// narrow layouts (NARROW) the same information sits in the panel right above the action bar,
// without repeating the action bar's buttons, so nothing covers the board.
// ---------------------------------------------------------------------------

function renderDialog() {
  const narrow = NARROW.matches;
  const box = narrow ? $('#panel-dialog') : $('#dialog-layer');
  clearDialogBox(narrow ? $('#dialog-layer') : $('#panel-dialog'));
  const dialog = currentDialog(narrow);
  const visible = !!dialog && (narrow || !app.dismissed.has(dialog.key));
  const hold = dialog?.immediate ? 0 : app.dialogAt - Date.now();
  clearTimeout(app.dialogTimer);
  // A dialog that is already up just refreshes; a new one waits for the board's move animation
  // (except one the player opened themselves, like the trade builder).
  if (!visible || (hold > 0 && box.dataset.key !== dialog.key)) {
    clearDialogBox(box);
    if (visible) app.dialogTimer = setTimeout(renderDialog, hold);
    return;
  }
  const alreadyShown = box.dataset.key === dialog.key;
  box.dataset.key = dialog.key;
  // Updates (cash after each mortgage) must not scroll the dialog or its raise-cash list back up.
  const scrollers = '.dialog, .raise-list';
  const scrolled = alreadyShown ? [...box.querySelectorAll(scrollers)].map((e) => e.scrollTop) : [];
  // While the connection is down, say first why the buttons are disabled.
  const html = dialog.key === 'game-over' ? dialog.html : netNoteHtml() + dialog.html;
  setHtmlKeepFocus(box, narrow
    ? `<div class="panel-dialog ${dialog.cls ?? ''}" role="group" aria-label="${esc(dialog.label)}">${html}</div>`
    : `<div class="dialog ${dialog.cls ?? ''}" role="dialog" aria-labelledby="dialog-title" tabindex="-1">
        <button type="button" class="dialog-x" data-ui="dismiss" data-key="${esc(dialog.key)}" aria-label="Hide" title="Hide — the buttons stay in the side panel">×</button>
        ${html}
      </div>`);
  dialog.after?.(box); // e.g. put the trade builder's typed values back
  box.querySelectorAll(scrollers).forEach((e, k) => { if (scrolled[k]) e.scrollTop = scrolled[k]; });
  // Only a newly opened dialog pops in; updates to the one on screen (cash, buttons) don't.
  if (alreadyShown) {
    box.firstElementChild?.classList.add('shown');
  } else {
    focusNewDialog(box, narrow, dialog.focus);
    // Trade offers have their own sound (announce), the game's end the board's fanfare.
    if (!/^(trade-in|trade-out|game-over)/.test(dialog.key)) sound('open', { volume: 0.7 });
  }
}

// Keyboard users continue in a new dialog: if focus was lost to a re-render (after Roll) or is in
// the action bar, move it to the dialog's main button (never a dangerous one, nor one marked
// data-nofocus such as Accept trade: Space must never take a decision like that by accident). On
// narrow layouts those buttons live in the action bar. `own` = a control of the dialog itself to
// focus instead (the trade builder's form, which has no action-bar buttons).
function focusNewDialog(box, narrow, own = null) {
  const active = document.activeElement;
  const bar = $('#action-bar');
  const fromBody = !active || active === document.body;
  if (!fromBody && !(!narrow && bar.contains(active))) return;
  const safe = '[data-act]:not(:disabled):not(.danger):not([data-nofocus])';
  let target;
  if (own) target = box.querySelector(own);
  else if (narrow) target = bar.querySelector(`.action-buttons ${safe}`);
  else target = box.querySelector(`.dialog-btns ${safe}`) ?? box.querySelector('.dialog');
  target?.focus({ preventScroll: true });
}

function clearDialogBox(box) {
  setHtml(box, '');
  delete box.dataset.key;
}

function clearDialog() {
  clearDialogBox($('#dialog-layer'));
  clearDialogBox($('#panel-dialog'));
}

function currentDialog(compact) {
  const s = app.state;
  if (s.status === 'finished') return { key: 'game-over', cls: 'dialog-over', label: 'Final standings', html: gameOverHtml(s, compact) };
  const m = me();
  if (!m || m.bankrupt) return null;
  const t = s.turn;
  // A pending trade concerns its two parties, whoever's turn it is.
  if (t.phase === 'trading' && s.trade) {
    if (s.trade.toPlayerId !== m.id && s.trade.fromPlayerId !== m.id) return null;
    const incoming = s.trade.toPlayerId === m.id;
    return {
      key: `trade-${incoming ? 'in' : 'out'}:${s.trade.id}`,
      cls: 'dialog-offer',
      label: incoming ? 'Trade offer' : 'Your trade offer',
      html: tradeOfferHtml(s, s.trade, compact),
    };
  }
  if (!isMyTurn()) return null;
  if (app.tradeDraft && can('PROPOSE_TRADE')) {
    return {
      key: 'trade-build',
      cls: 'dialog-trade',
      label: 'Propose a trade',
      html: tradeBuilderHtml(s, app.tradeDraft),
      immediate: true,
      after: hydrateTradeBuilder,
      focus: '.trade-target.selected',
    };
  }
  if (t.phase === 'buying_or_auction' && t.pendingPurchase != null) {
    return { key: `buy:${t.number}:${t.pendingPurchase}`, label: 'Buy decision', html: buyHtml(m, t.pendingPurchase, compact) };
  }
  if (t.phase === 'paying' && t.pendingDebt) {
    return {
      key: `debt:${t.number}:${t.pendingDebt.reason}:${t.pendingDebt.amount}`,
      label: 'Debt',
      html: debtHtml(s, m, t.pendingDebt, compact),
    };
  }
  if (t.phase === 'jail_decision') return { key: `jail:${t.number}`, label: 'Jail', html: jailHtml(m, compact) };
  return null;
}

// `compact` = the panel version on narrow layouts: no title or buttons (the banner and the action
// bar already have them).
function buyHtml(m, index, compact) {
  const tile = TILES[index];
  const ok = ready();
  const short = tile.price - m.cash;
  let after = '';
  if (short > 0) after = raiseCashHtml(short, 'Nothing left to sell or mortgage — you can only decline.');
  else if (!can('BUY')) after = `<p class="hint">You can't buy this right now.</p>`;
  if (app.state.settings.auctionOnDecline) after += '<p class="hint">If you decline, it goes to auction — everyone can bid, you too.</p>';
  // The deed's band is the dialog's heading, which keeps the card short enough to sit under the dice.
  return `${deedHtml(tile, `Buy for ${money(tile.price)}?`)}
    <div class="dialog-cash">You have <strong>${money(m.cash)}</strong>${short > 0 ? ` — <span class="neg">${money(short)} short</span>` : ''}</div>
    ${compact ? '' : `<div class="dialog-btns">
      <button type="button" class="btn primary" data-act="BUY"${disabledAttr(ok && can('BUY'))}>Buy ${money(tile.price)}</button>
      <button type="button" class="btn" data-act="DECLINE"${disabledAttr(ok && can('DECLINE'))}>Decline</button>
    </div>`}
    ${after}`;
}

/** Compact title deed: color band (with `heading` as the dialog title), rent on up to three lines, costs. */
function deedHtml(tile, heading, id = 'dialog-title') {
  let band = '#3d4448';
  let rows = [];
  if (tile.type === 'property') {
    band = BOARD.groups[tile.group]?.color ?? band;
    rows = [
      ['Rent', `${money(tile.rent[0])} · full set ${money(tile.rent[0] * 2)}`],
      ['1–4 houses', tile.rent.slice(1, 5).map(money).join(' / ')],
      ['Hotel', money(tile.rent[5])],
    ];
  } else if (tile.type === 'railroad') {
    rows = [[`🚂 1–${tile.rent.length} railroads`, tile.rent.map(money).join(' / ')]];
  } else if (tile.type === 'utility') {
    band = '#8a9199';
    rows = [[/water/i.test(tile.name) ? '🚰 Rent' : '💡 Rent', `${tile.multipliers[0]}× dice · ${tile.multipliers[1]}× with both`]];
  }
  const costs = [tile.houseCost ? `Houses ${money(tile.houseCost)} each` : '', `Mortgage ${money(tile.mortgage)}`]
    .filter(Boolean).join(' · ');
  return `<div class="deed" style="--gc:${band};--gc-text:${textOn(band)}">
    <div class="deed-band" id="${id}"><span class="deed-kicker">${esc(heading)}</span><strong>${esc(tile.name)}</strong></div>
    <table class="deed-rent">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
    <div class="deed-foot">${costs}</div>
  </div>`;
}

/**
 * "Raise cash" buttons for when cash is short (buy or debt): sell a building or mortgage, straight
 * from `legal`, so the player doesn't have to scroll to My properties.
 */
function raiseCashHtml(short, emptyText) {
  const s = app.state;
  const ok = ready();
  const items = [
    ...app.legal.sellHouse.map((i) => [i, 'SELL_HOUSE',
      `Sell ${tileState(s, i)?.houses === 5 ? 'hotel' : 'house'} +${money(Math.floor(TILES[i].houseCost / 2))}`]),
    ...app.legal.mortgage.map((i) => [i, 'MORTGAGE', `Mortgage +${money(TILES[i].mortgage)}`]),
  ];
  if (!items.length) return `<p class="hint">${emptyText}</p>`;
  return `<div class="raise">
    <div class="raise-head">Raise ${money(short)}</div>
    <ul class="raise-list">${items.map(([i, type, label]) => `
      <li style="--gc:${groupMeta(groupKeyOf(i)).color}">
        <span class="raise-name">${esc(TILES[i].name)}</span>
        <button type="button" class="btn small" data-act="${type}" data-tile="${i}"${disabledAttr(ok)}>${label}</button>
      </li>`).join('')}
    </ul>
  </div>`;
}

/** " to Alice" / " to the bank" / " to the other players" for a pending debt. */
function debtCreditorText(s, debt) {
  if (!debt) return '';
  return ` to ${debt.payees?.length ? 'the other players' : debt.toPlayerId ? playerName(s, debt.toPlayerId) : 'the bank'}`;
}

function debtHtml(s, m, debt, compact) {
  const ok = ready();
  const creditor = debt.payees?.length ? 'the other players' : debt.toPlayerId ? playerName(s, debt.toPlayerId) : 'the bank';
  const reason = { rent: 'rent', tax: 'tax', card: 'a card', jail_fine: 'the jail fine' }[debt.reason] ?? String(debt.reason ?? '').replace(/_/g, ' ');
  const short = debt.amount - m.cash;
  return `${compact ? '' : `<h3 id="dialog-title" class="dialog-title">💸 You owe ${money(debt.amount)}</h3>`}
    <p class="dialog-text">${compact ? `You owe ${money(debt.amount)} to` : 'To'} <strong>${esc(creditor)}</strong>${reason ? ` for ${esc(reason)}` : ''}.</p>
    <div class="dialog-cash">You have <strong>${money(m.cash)}</strong>${short > 0 ? ` — <span class="neg">${money(short)} short</span>` : ''}</div>
    ${compact ? '' : `<div class="dialog-btns">
      <button type="button" class="btn primary" data-act="PAY_DEBT"${disabledAttr(ok && can('PAY_DEBT'))}>Pay ${money(debt.amount)}</button>
      ${can('PAY_DEBT') ? '' : `<button type="button" class="btn danger" data-act="DECLARE_BANKRUPTCY"${disabledAttr(ok && can('DECLARE_BANKRUPTCY'))}>Declare bankruptcy</button>`}
    </div>`}
    ${short > 0 ? raiseCashHtml(short, 'Nothing left to sell or mortgage — you can only declare bankruptcy.') : ''}`;
}

function jailHtml(m, compact) {
  const ok = ready();
  const used = m.jailTurns ?? 0;
  const max = BOARD.maxJailTurns;
  const lastTry = used >= max - 1;
  const cards = m.getOutOfJailCards;
  return `${compact ? '' : `<h3 id="dialog-title" class="dialog-title">🔒 You're in jail</h3>`}
    <p class="dialog-text">Doubles attempts used: <strong>${used} of ${max}</strong>.
      ${lastTry ? `Last try — if you miss, you pay ${money(BOARD.jailFine)} and move anyway.` : ''}</p>
    <div class="dialog-cash">You have <strong>${money(m.cash)}</strong>${cards ? ` · 🎫 ${cards} jail card${cards > 1 ? 's' : ''}` : ''}</div>
    ${compact ? '' : `<div class="dialog-btns stack">
      <button type="button" class="btn primary" data-act="ROLL"${disabledAttr(ok && can('ROLL'))}>🎲 Roll for doubles</button>
      <button type="button" class="btn" data-act="PAY_JAIL_FINE"${disabledAttr(ok && can('PAY_JAIL_FINE'))}>Pay fine ${money(BOARD.jailFine)}</button>
      <button type="button" class="btn" data-act="USE_JAIL_CARD"${disabledAttr(ok && can('USE_JAIL_CARD'))}>🎫 Use jail card</button>
    </div>`}`;
}

function gameOverHtml(s, compact) {
  const winner = playerById(s, s.winnerId);
  const iWon = !!winner && winner.id === me()?.id;
  return `${compact ? '' : `<h3 id="dialog-title" class="dialog-title">${iWon ? '🏆 You win!' : '🏁 Game over'}</h3>`}
    ${standingsHtml(s)}
    ${compact ? '' : '<div class="dialog-btns"><button type="button" class="btn primary" data-ui="home">Back to home</button></div>'}`;
}

/** Final standings: the winner, then other players still in by net worth, then bankrupt players in turn order. */
function standingsHtml(s) {
  const myId = me()?.id;
  const inGame = s.players
    .filter((p) => !p.bankrupt && p.id !== s.winnerId)
    .sort((a, b) => netWorth(s, b.id) - netWorth(s, a.id));
  const order = s.turn.order?.length ? s.turn.order : s.players.map((p) => p.id);
  const out = order.map((id) => playerById(s, id)).filter((p) => p?.bankrupt && p.id !== s.winnerId);
  const rows = [playerById(s, s.winnerId), ...inGame, ...out].filter(Boolean);
  return `<ol class="standings">${rows.map((p) => `
    <li class="${p.bankrupt ? 'out' : ''}" style="--pc:${playerColor(s, p.id)}">
      <span class="pdot"></span>
      <span class="st-token">${tokenEmoji(p.token)}</span>
      <span class="st-name">${esc(p.name)}${p.id === myId ? ' <span class="tag you">you</span>' : ''}${p.id === s.winnerId ? ' <span class="tag set">winner</span>' : ''}</span>
      <span class="st-worth"${p.bankrupt ? '' : ' title="Net worth: cash + property + buildings"'}>${p.bankrupt ? 'Bankrupt' : money(netWorth(s, p.id))}</span>
    </li>`).join('')}
  </ol>`;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function toast(text, kind = 'info', ms = 4500) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const message = document.createElement('span');
  message.textContent = text;
  // Toasts let clicks through to the buttons underneath (style.css); only the × is clickable.
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-x';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => el.remove());
  el.append(message, close);
  box.append(el);
  while (box.children.length > 5) box.firstElementChild.remove();
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

/**
 * Toasts for events that involve me (plus bankruptcies, which matter to everyone) — but not for
 * what I just did myself or what is already on screen (my purchase, my debt, the banner saying
 * it's my turn): those would only pile up over the buttons.
 */
function announce(events, prevTrade = null) {
  const s = app.state;
  const myId = me()?.id;
  const name = (id) => playerName(s, id);
  // Whoever went bankrupt (or resigned) in this batch: a cancelled trade or debt names them.
  const gone = events.find((e) => e.type === 'bankrupt')?.playerId ?? null;
  for (const ev of events) {
    const mine = !!myId && ev.playerId === myId;
    if (announceDeal(ev, s, myId, name, prevTrade, gone)) continue;
    switch (ev.type) {
      case 'turn_started':
        if (mine) sound('notify');
        if (mine && !document.hasFocus()) toast("🎲 It's your turn!", 'info', 2500);
        break;
      case 'passed_go':
        if (mine) toast(`You passed GO and collected ${money(ev.amount)}`, 'good');
        break;
      case 'paid_rent':
        if (mine) toast(`You paid ${money(ev.amount)} rent to ${name(ev.ownerId)} for ${tileName(ev.tileIndex)}`, 'bad');
        else if (myId && ev.ownerId === myId) toast(`${name(ev.playerId)} paid you ${money(ev.amount)} rent for ${tileName(ev.tileIndex)}`, 'good');
        break;
      case 'paid_tax':
        if (mine) toast(`You paid ${money(ev.amount)} ${tileName(ev.tileIndex)}`, 'bad');
        break;
      case 'paid': // card fees are explained by the card toast, jail fines by left_jail (or my own click)
        if (mine && ev.reason !== 'card' && ev.reason !== 'jail_fine') {
          toast(`You paid ${money(ev.amount)} to ${ev.toPlayerId ? name(ev.toPlayerId) : 'the bank'}`, 'bad');
        } else if (!mine && myId && ev.toPlayerId === myId) {
          toast(`${name(ev.playerId)} paid you ${money(ev.amount)}`, 'good');
        }
        break;
      case 'collected':
        if (mine && ev.reason === 'free_parking') toast(`You collected the ${money(ev.amount)} Free Parking pot!`, 'good');
        else if (mine && ev.reason !== 'card') toast(`You collected ${money(ev.amount)}`, 'good');
        else if (!mine && myId && ev.fromPlayerId === myId) toast(`You paid ${money(ev.amount)} to ${name(ev.playerId)}`, 'bad');
        break;
      case 'debt_paid':
        if (!mine && myId && (ev.toPlayerId === myId || ev.payees?.some((x) => x.playerId === myId))) {
          toast(`${name(ev.playerId)} paid what they owed you`, 'good');
        }
        break;
      case 'card_drawn':
        if (mine) toast(`${ev.deck === 'chance' ? '❓ Chance' : '📦 Community Chest'}: ${ev.text}`, 'card', 7000);
        break;
      case 'jail_card_received':
        if (mine) toast('You got a Get Out of Jail Free card 🎫', 'good');
        break;
      case 'sent_to_jail':
        if (mine) toast(ev.reason === 'doubles' ? 'Three doubles in a row — go to jail! 🔒' : 'You were sent to jail 🔒', 'bad');
        break;
      case 'left_jail': // paying the fine or using a card was my own click
        if (mine && ev.method === 'doubles') toast("Doubles — you're out of jail!", 'good');
        else if (mine && ev.method === 'forced_fine') toast(`Third miss — you paid the ${money(BOARD.jailFine)} fine and move on`, 'bad');
        break;
      case 'timeout': // an auction's clock running out is just how auctions end (auction_won / _unsold say it)
        if (mine && ev.phase !== 'auction') toast("Time's up — the game played your turn for you", 'bad');
        break;
      case 'bankrupt': {
        const resigned = ev.reason === 'resigned';
        if (mine) toast(resigned || app.resigned ? 'You resigned from the game' : 'You went bankrupt', 'bad', 6000);
        else if (myId && ev.toPlayerId === myId) toast(`${name(ev.playerId)} ${resigned ? 'resigned' : 'went bankrupt'} — their assets are yours`, 'good', 6000);
        else toast(`${name(ev.playerId)} ${resigned ? 'resigned' : 'went bankrupt'}`, 'info');
        break;
      }
      case 'debt_reduced': // someone I owed went bankrupt: their share of my debt is cancelled
        if (mine && gone) {
          toast(ev.amount > 0
            ? `${name(gone)} is out — you no longer owe them; ${money(ev.amount)} is still due`
            : `${name(gone)} is out — you no longer owe them anything`, 'good', 6000);
        }
        break;
      default:
        break;
    }
  }
}

/**
 * Toasts for auctions and trades; true if `ev` was one of theirs. Bids and passes get none (the
 * auction sheet shows them), nor does my own click (declining, accepting…).
 */
function announceDeal(ev, s, myId, name, prevTrade, gone) {
  switch (ev.type) {
    case 'auction_started':
      // The decliner just clicked; everyone else may be looking elsewhere (on phones the sheet is
      // below the board).
      if (!myId || currentPlayerId(s) !== myId) {
        const bidder = !!myId && ev.participants?.includes(myId) && !playerById(s, myId)?.bankrupt;
        // Phones scroll the sheet into view instead (revealAuctionControls); a toast would cover its clock.
        if (bidder && NARROW.matches) return true;
        toast(`🔨 ${tileName(ev.tileIndex)} is up for auction${bidder ? ' — bid or pass in the panel' : ''}`, 'info', 4000);
      }
      return true;
    case 'auction_won':
      if (ev.playerId === myId) toast(`🔨 You won ${tileName(ev.tileIndex)} for ${money(ev.amount)}!`, 'good', 5000);
      else toast(`🔨 ${name(ev.playerId)} won ${tileName(ev.tileIndex)} for ${money(ev.amount)}`, 'info');
      return true;
    case 'auction_unsold':
      toast(`🔨 No sale — ${tileName(ev.tileIndex)} stays with the bank`, 'info');
      return true;
    case 'trade_proposed':
      if (ev.toPlayerId === myId) {
        sound('offer');
        toast(`🤝 ${name(ev.fromPlayerId)} offered you a trade`, 'card', 5000);
      }
      return true;
    case 'trade_accepted': {
      const fee = myId ? ev.fees?.[myId] ?? 0 : 0;
      const feeText = fee > 0 ? ` (you paid a ${money(fee)} mortgage fee)` : '';
      if (ev.fromPlayerId === myId) toast(`🤝 ${name(ev.toPlayerId)} accepted your trade${feeText}`, 'good', 5000);
      else if (ev.toPlayerId === myId) toast(`🤝 Trade done${feeText}`, 'good');
      else toast(`🤝 ${name(ev.fromPlayerId)} and ${name(ev.toPlayerId)} made a trade`, 'info');
      return true;
    }
    case 'trade_rejected': {
      const t = prevTrade?.id === ev.tradeId ? prevTrade : null;
      if (!t || ev.byPlayerId === myId) return true; // my own click
      if (t.fromPlayerId === myId) toast(`🤝 ${name(ev.byPlayerId)} turned down your trade`, 'bad');
      else if (t.toPlayerId === myId) toast(`🤝 ${name(ev.byPlayerId)} withdrew the trade offer`, 'info');
      return true;
    }
    case 'trade_cancelled': {
      const t = prevTrade?.id === ev.tradeId ? prevTrade : null;
      if (t && (t.fromPlayerId === myId || t.toPlayerId === myId)) {
        const why = ev.reason === 'timeout' ? 'time ran out' : `${gone ? name(gone) : 'a player'} resigned`;
        toast(`🤝 The trade offer was called off (${why})`, 'info');
      }
      return true;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Settings popover (the header's gear): sound (sfx.js keeps it in localStorage "monopoly.audio"),
// board view (renderer-switch keeps it in "monopoly.renderer"), and the board options below, kept
// in KEY_SETTINGS and passed to the renderers through renderer-switch's setOptions.
// ---------------------------------------------------------------------------

/** fn(), or `fallback` if it throws (sfx.js is written separately and must never break the UI). */
function attempt(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function loadSettings() {
  const saved = readJson('localStorage', KEY_SETTINGS, {});
  const settings = {};
  for (const [key, { choices }] of Object.entries(SETTINGS)) {
    settings[key] = choices.includes(saved?.[key]) ? saved[key] : choices[0];
  }
  return settings;
}

function saveSettings() {
  const saved = readJson('localStorage', KEY_SETTINGS, {});
  writeJson('localStorage', KEY_SETTINGS, { ...(saved && typeof saved === 'object' ? saved : {}), ...app.settings });
}

/** Brings every control in the settings popover in line with the current settings. */
function renderSettings() {
  if (!app.settings) return; // before boot
  const on = !!sfx && attempt(() => sfx.isEnabled(), false);
  const soundBox = $('#opt-sound');
  soundBox.checked = on;
  soundBox.disabled = !sfx;
  const range = $('#opt-volume');
  range.value = String(Math.round(attempt(() => sfx.getVolume(), 0.7) * 100));
  range.disabled = !on;
  $('#opt-volume-out').textContent = `${range.value}%`;
  const music = $('#opt-music');
  music.checked = !!sfx && attempt(() => sfx.isMusicOn(), false);
  music.disabled = !on;
  $('#opt-sound-note').hidden = !sfxFailed;
  for (const [key, { hints }] of Object.entries(SETTINGS)) {
    for (const input of document.querySelectorAll(`input[name="opt-${key}"]`)) input.checked = input.value === app.settings[key];
    setHint(key, hints[app.settings[key]]);
  }
  renderViewControls();
  renderFullscreen();
}

function setHint(key, text) {
  const el = document.querySelector(`#settings [data-hint="${key}"]`);
  if (el && el.textContent !== text) el.textContent = text;
}

function openSettings() {
  const pop = $('#settings');
  probe3d(); // the Board choice says whether 3D can run here
  renderSettings();
  pop.hidden = false;
  $('#settings-btn').setAttribute('aria-expanded', 'true');
  sound('open');
  pop.querySelector('input:not(:disabled)')?.focus({ preventScroll: true });
}

/** `refocus`: put keyboard focus back on the gear (Esc, ×) — not when closed by clicking elsewhere. */
function closeSettings({ refocus = true } = {}) {
  const pop = $('#settings');
  if (pop.hidden) return;
  pop.hidden = true;
  $('#settings-btn').setAttribute('aria-expanded', 'false');
  sound('close');
  if (refocus) $('#settings-btn').focus({ preventScroll: true });
}

/** A settings control changed (a change event from inside #settings). */
function onSettingChange(el) {
  if (el.id === 'opt-sound') {
    attempt(() => {
      sfx.setEnabled(el.checked);
      if (el.checked) sfx.unlock();
    });
    sound('toggle'); // only audible when switched on
  } else if (el.id === 'opt-music') {
    attempt(() => {
      sfx.unlock();
      sfx.setMusic(el.checked);
    });
    sound('toggle');
  } else if (el.id === 'opt-volume') {
    sound('click'); // hear the new level
  } else if (el.name === 'opt-board') {
    chooseBoardView(el.value);
  } else if (el.name?.startsWith('opt-')) {
    const key = el.name.slice(4);
    if (!SETTINGS[key]?.choices.includes(el.value)) return;
    app.settings = { ...app.settings, [key]: el.value };
    saveSettings();
    setBoardOptions({ ...app.settings });
    sound('toggle');
  }
  renderSettings();
}

/** 2D or 3D board, from the header pill or the settings. 3D without WebGL2 just says so. */
function chooseBoardView(mode) {
  if (mode === '3d' && !probe3d()) {
    sound('error');
    toast("3D isn't available in this browser — it needs WebGL2.", 'error');
    renderViewControls();
    return;
  }
  if (mode !== boardMode()) sound('toggle');
  setBoardMode(mode); // also retries a 3D board that failed or was paused
}

/** The header's 2D|3D pill and the settings' Board choice, from renderer-switch's status. */
function renderViewControls(status = boardStatus()) {
  const trouble = !status.loading && !status.unsupported && (!!status.paused || status.failed);
  const title3d = status.unsupported
    ? "3D isn't available in this browser (it needs WebGL2)"
    : status.loading
      ? 'Loading 3D…'
      : status.paused === 'lost'
        ? '3D paused (the graphics card reset) — click to try again'
        : status.paused
          ? "3D couldn't start on this device — click to try again"
          : status.failed
            ? '3D failed to load — click to try again'
            : '3D board';
  for (const b of document.querySelectorAll('#view-pill button')) {
    b.setAttribute('aria-pressed', String(b.dataset.key === status.mode));
    if (b.dataset.key !== '3d') continue;
    b.classList.toggle('is-loading', status.loading);
    b.classList.toggle('is-paused', trouble);
    b.setAttribute('aria-disabled', String(status.unsupported));
    b.title = title3d;
  }
  for (const input of document.querySelectorAll('input[name="opt-board"]')) {
    input.checked = input.value === status.mode;
    if (input.value === '3d') input.disabled = status.unsupported;
  }
  let hint = status.mode === '3d' ? 'A 3D table that fills the window.' : 'The classic flat board.';
  if (status.unsupported) hint = "3D needs WebGL2, which this browser doesn't have.";
  else if (status.loading) hint = 'Loading the 3D board…';
  else if (trouble) hint = `${title3d.replace(/ — click to try again$/, '')}. Choose 3D to try again.`;
  setHint('board', hint);
}

// ---- full screen ----------------------------------------------------------------------------------

const fullscreenElement = () => document.fullscreenElement ?? document.webkitFullscreenElement ?? null;

/** False e.g. on iPhone Safari, which only lets videos go full screen: the buttons stay hidden. */
function fullscreenSupported() {
  const root = document.documentElement;
  return !!(document.fullscreenEnabled || document.webkitFullscreenEnabled)
    && typeof (root.requestFullscreen ?? root.webkitRequestFullscreen) === 'function';
}

function toggleFullscreen() {
  if (!fullscreenSupported()) return;
  const failed = () => {
    sound('error');
    toast("Couldn't switch to full screen here.", 'error');
  };
  try {
    let request;
    if (fullscreenElement()) {
      sound('close');
      request = (document.exitFullscreen ?? document.webkitExitFullscreen).call(document);
    } else {
      sound('open');
      const root = document.documentElement;
      request = (root.requestFullscreen ?? root.webkitRequestFullscreen).call(root, { navigationUI: 'hide' });
    }
    Promise.resolve(request).catch(failed);
  } catch {
    failed();
  }
}

function renderFullscreen() {
  const supported = fullscreenSupported();
  const on = !!fullscreenElement();
  for (const b of document.querySelectorAll('[data-fullscreen]')) {
    b.hidden = !supported;
    b.classList.toggle('is-on', on);
    if (b.classList.contains('icon-btn')) {
      b.setAttribute('aria-pressed', String(on));
      b.title = on ? 'Exit full screen' : 'Full screen';
    } else {
      b.textContent = on ? 'Exit full screen' : 'Full screen';
    }
  }
}

// ---------------------------------------------------------------------------
// The full-screen 3D layout (body.board-3d, style.css): #board fills the window behind a
// translucent header; the side panel floats on the right (a bottom sheet under 900px held upright)
// and folds down to the turn banner and the action buttons. The safe area — how much of the board
// the header / panel / sheet cover — is kept in #board.dataset.safeTop / safeRight / safeBottom /
// safeLeft (CSS px, as strings) and in --safe-* on <body> (for the dialogs and toasts); every
// change fires a 'monopoly:safearea' window event. All zero outside the 3D layout.
// ---------------------------------------------------------------------------

const in3dLayout = () => document.body.classList.contains('board-3d');
const panelLayout = () => (SHEET.matches ? 'sheet' : 'side');
const panelOpen = () => app.panelOpen[panelLayout()];

/** 3D board + game screen = the 3D layout. Runs on screen changes and before a board mode switch. */
function syncBoardLayout() {
  const on = app.screen === 'game' && boardMode() === '3d';
  if (in3dLayout() !== on) {
    document.body.classList.toggle('board-3d', on);
    if (on) window.scrollTo(0, 0); // a phone may have been scrolled down to the 2D panel
  }
  applyPanelState();
  updateSafeArea();
}

/** Folds (false) or unfolds (true) the 3D panel / sheet. Not remembered past this page. */
function setPanelOpen(open, { quiet = false } = {}) {
  const layout = panelLayout();
  if (app.panelOpen[layout] !== open) {
    app.panelOpen[layout] = open;
    if (!quiet) {
      sound(open ? 'open' : 'close');
      app.sheetForTrade = false; // folded or unfolded by hand: it stays that way
    }
    // Keyboard focus in the part that folds away moves to the control that folded it.
    if (!open && $('#panel-more').contains(document.activeElement)) {
      $(layout === 'sheet' ? '#sheet-handle' : '#panel-toggle').focus({ preventScroll: true });
    }
  }
  applyPanelState();
  updateSafeArea();
}

function applyPanelState() {
  const folded = in3dLayout() && !panelOpen();
  $('#game-panel').classList.toggle('is-folded', folded);
  const label = folded ? 'Show players and properties' : 'Hide players and properties';
  for (const b of [$('#panel-toggle'), $('#sheet-handle')]) b.setAttribute('aria-expanded', String(!folded));
  $('#sheet-handle').setAttribute('aria-label', label);
  $('#panel-toggle').title = label;
}

/** A fixed element's box in window px, ignoring transforms (so entrance animations don't count). */
function layoutBox(el) {
  const top = el.offsetTop;
  const left = el.offsetLeft;
  return { top, left, bottom: top + el.offsetHeight, right: left + el.offsetWidth };
}

/** How much of #board (px from each edge) the header, the replaced banner and the panel cover. */
function measureSafeArea() {
  const board = $('#board');
  const b = layoutBox(board);
  const W = board.offsetWidth;
  const H = board.offsetHeight;
  let top = 0;
  let right = 0;
  let bottom = 0;
  for (const el of [$('.topbar'), $('#replaced-banner')]) {
    if (el.offsetHeight) top = Math.max(top, layoutBox(el).bottom - b.top);
  }
  const panel = $('#game-panel');
  if (panel.offsetHeight) {
    const p = layoutBox(panel);
    if (SHEET.matches) {
      bottom = b.bottom - p.top;
    } else {
      // A card on the right: the board goes beside it — or, when the card is folded short, under
      // it, if that leaves the board more room (a wide board in a squarish window). The other
      // choice must be clearly better before the board moves (the card's height changes with
      // what it shows).
      const room = ({ top: t, right: r }) => Math.min((W - r) / BOARD_VIEW_ASPECT, H - t);
      const beside = { top, right: b.right - p.left };
      const under = { top: Math.max(top, p.bottom - b.top), right: 0 };
      app.safeUnder = app.safeUnder
        ? room(under) * SAFE_SWITCH_MARGIN >= room(beside)
        : room(under) >= room(beside) * SAFE_SWITCH_MARGIN;
      ({ top, right } = app.safeUnder ? under : beside);
    }
  }
  const clamp = (v, max) => Math.round(Math.min(Math.max(v, 0), max));
  return { top: clamp(top, H), right: clamp(right, W), bottom: clamp(bottom, H), left: 0 };
}

/** Recomputes the safe area; writes it and fires 'monopoly:safearea' only when it changed. */
function updateSafeArea() {
  const board = $('#board');
  if (!board) return;
  const area = in3dLayout() ? measureSafeArea() : { top: 0, right: 0, bottom: 0, left: 0 };
  const key = `${area.top},${area.right},${area.bottom},${area.left}`;
  if (key === app.safe) return;
  app.safe = key;
  const style = document.body.style;
  for (const [side, prop] of [['top', 'safeTop'], ['right', 'safeRight'], ['bottom', 'safeBottom'], ['left', 'safeLeft']]) {
    board.dataset[prop] = String(area[side]);
    style.setProperty(`--safe-${side}`, `${area[side]}px`);
  }
  window.dispatchEvent(new Event('monopoly:safearea'));
}

// ---- the bottom sheet's handle: tap to fold / unfold, or drag it to any height and let go ------------

function onSheetPointerDown(event) {
  if (!in3dLayout() || !SHEET.matches || event.button > 0) return;
  const panel = $('#game-panel');
  app.sheetDrag = { id: event.pointerId, y0: event.clientY, h0: panel.offsetHeight, moved: false, lastY: event.clientY, lastT: event.timeStamp, v: 0 };
  attempt(() => event.currentTarget.setPointerCapture(event.pointerId));
}

function onSheetPointerMove(event) {
  const d = app.sheetDrag;
  if (!d || d.id !== event.pointerId) return;
  const dy = event.clientY - d.y0;
  if (!d.moved && Math.abs(dy) < 6) return; // still a tap
  const panel = $('#game-panel');
  if (!d.moved) {
    d.moved = true;
    panel.classList.add('is-dragging');
    panel.classList.remove('is-folded'); // everything shows while the sheet is pulled
  }
  const height = Math.min(Math.max(d.h0 - dy, 64), Math.round(window.innerHeight * SHEET_MAX_SHARE));
  panel.style.height = `${height}px`;
  const dt = event.timeStamp - d.lastT;
  if (dt > 0) d.v = (event.clientY - d.lastY) / dt; // px per ms, positive = downwards
  d.lastY = event.clientY;
  d.lastT = event.timeStamp;
  updateSafeArea();
}

function onSheetPointerUp(event) {
  const d = app.sheetDrag;
  if (!d || d.id !== event.pointerId) return;
  app.sheetDrag = null;
  if (!d.moved) return; // a tap: the click that follows folds / unfolds
  app.sheetClickBlock = Date.now() + 400; // …but not the click that ends a drag
  const panel = $('#game-panel');
  const share = panel.offsetHeight / (window.innerHeight * SHEET_MAX_SHARE);
  panel.style.height = '';
  panel.classList.remove('is-dragging');
  let open = app.panelOpen.sheet;
  if (event.type !== 'pointercancel') open = d.v < -0.35 || (d.v <= 0.35 && share >= 0.5); // a flick, else the nearer end
  setPanelOpen(open); // also puts the fold back if it stays folded
}

function bootShell() {
  app.settings = loadSettings();
  setBoardOptions({ ...app.settings });
  setBoardToggle(false); // the header pill and the settings replace the board's own 2D|3D toggle
  onBoardModeChange(syncBoardLayout); // runs before the board is redrawn in the new mode
  onBoardStatus(renderViewControls);

  const settings = $('#settings');
  settings.addEventListener('change', (event) => onSettingChange(event.target));
  $('#opt-volume').addEventListener('input', (event) => {
    attempt(() => sfx.setVolume(Number(event.target.value) / 100));
    $('#opt-volume-out').textContent = `${event.target.value}%`;
  });
  settings.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation(); // Esc here closes the settings; it doesn't also skip the 3D animation
    closeSettings();
  });
  // Clicking anywhere else closes the settings (the gear's own click toggles them).
  document.addEventListener('pointerdown', (event) => {
    if (!settings.hidden && !settings.contains(event.target) && !event.target.closest?.('#settings-btn')) {
      closeSettings({ refocus: false });
    }
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !settings.hidden) closeSettings({ refocus: false });
  });
  // WebGL2 is only probed once someone shows interest in 3D.
  const want3d = document.querySelector('#view-pill [data-key="3d"]');
  want3d.addEventListener('pointerenter', () => probe3d());
  want3d.addEventListener('focus', () => probe3d());

  const handle = $('#sheet-handle');
  handle.addEventListener('pointerdown', onSheetPointerDown);
  handle.addEventListener('pointermove', onSheetPointerMove);
  handle.addEventListener('pointerup', onSheetPointerUp);
  handle.addEventListener('pointercancel', onSheetPointerUp);

  const onViewport = () => {
    applyPanelState();
    updateSafeArea();
  };
  window.addEventListener('resize', onViewport);
  window.addEventListener('orientationchange', onViewport);
  window.visualViewport?.addEventListener('resize', onViewport);
  SHEET.addEventListener('change', onViewport);
  for (const type of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(type, () => {
      renderFullscreen();
      onViewport();
    });
  }
  // Anything else that changes the size of what floats over the board (a player's holdings opened
  // in the sheet, the "opened in another tab" banner, the header wrapping).
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => updateSafeArea());
    for (const el of [$('#game-panel'), $('.topbar'), $('#replaced-banner')]) ro.observe(el);
  }
  renderSettings();
  syncBoardLayout(); // also writes the (zero) safe area, so #board always has one
}

// ---------------------------------------------------------------------------
// Input: clicks (delegated), forms, keyboard
// ---------------------------------------------------------------------------

async function copyInvite() {
  if (!app.gameId) return;
  const url = `${location.origin}/?game=${app.gameId}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied — send it to your friends!', 'good');
  } catch {
    window.prompt('Copy this invite link:', url); // clipboard API needs https or localhost
  }
}

function takeOver() {
  const t = app.takeover;
  if (!t || !app.conn) return;
  app.seat = { playerId: t.playerId, token: t.token };
  app.takeover = null;
  setTabSeat(app.gameId, app.seat);
  app.conn.reconnect(); // the hello with these credentials moves the seat to this tab
}

function confirmText(type) {
  if (type === 'DECLARE_BANKRUPTCY') {
    const to = myCreditor()?.name ?? 'the bank';
    return `Declare bankruptcy? Everything you own goes to ${to} and you are out of the game.`;
  }
  if (type === 'LEAVE' && app.state?.status === 'active') {
    // Resigning while I owe one player hands my assets to them, as bankruptcy would.
    const to = myCreditor()?.name ?? 'the bank';
    return `Resign from this game? Your cash and properties go to ${to} and you are out of the game.`;
  }
  return null;
}

function onActionClick(el) {
  const type = el.dataset.act;
  const lobbyOnly = type === 'LEAVE' && el.dataset.lobbyOnly != null; // the lobby's Leave never resigns
  const text = lobbyOnly ? null : confirmText(type);
  if (text && !window.confirm(text)) return;
  if (type === 'LEAVE' && !lobbyOnly && app.state?.status === 'active') app.resigned = true;
  const payload = el.dataset.tile != null ? { tileIndex: Number(el.dataset.tile) } : {};
  if (el.dataset.amount != null) payload.amount = Number(el.dataset.amount); // quick bids
  if (el.dataset.tradeId != null) payload.tradeId = el.dataset.tradeId; // answers exactly the offer on screen
  if (lobbyOnly) payload.lobbyOnly = true;
  act(type, payload);
}

function onUiClick(el, event) {
  switch (el.dataset.ui) {
    case 'home':
      event.preventDefault();
      goHome();
      break;
    case 'open':
      openGame(el.dataset.game);
      break;
    case 'forget':
      forgetSession(el.dataset.game);
      clearTabSeat(el.dataset.game);
      refreshMyGames();
      break;
    case 'copy-invite':
      copyInvite();
      break;
    case 'pick-token':
      app.selectedToken = el.dataset.token;
      renderTokenGrid();
      $('#join-btn').disabled = !ready() || !app.selectedToken;
      break;
    case 'takeover':
      takeOver();
      break;
    case 'use-here':
      if (app.seat && app.gameId) setTabSeat(app.gameId, { playerId: app.seat.playerId, token: app.seat.token });
      app.conn?.reconnect();
      break;
    case 'retry':
      app.conn?.reconnect();
      break;
    case 'dismiss':
      if (el.dataset.key === 'trade-build') {
        closeTradeBuilder(); // the builder has nothing in the side panel to fall back on
        break;
      }
      sound('close');
      app.dismissed.add(el.dataset.key);
      renderDialog();
      break;
    case 'trade-open':
      openTradeBuilder();
      break;
    case 'bid-max': { // fills the bid box only: bidding everything still takes the Bid button
      const limits = can('BID') ? app.legal.auction : null;
      if (limits) $('#bid-input').value = String(limits.maxBid);
      break;
    }
    case 'trade-target':
      if (app.tradeDraft && app.tradeDraft.to !== el.dataset.key) {
        // Another player: what I'd get from the previous one no longer applies.
        app.tradeDraft.to = el.dataset.key;
        app.tradeDraft.get = emptyTradeSide();
        rerender();
      }
      break;
    case 'trade-cancel':
      closeTradeBuilder();
      break;
    case 'trade-send':
      sendTrade();
      break;
    case 'board-view':
      chooseBoardView(el.dataset.key);
      break;
    case 'settings':
      if ($('#settings').hidden) openSettings();
      else closeSettings({ refocus: false });
      break;
    case 'settings-close':
      closeSettings();
      break;
    case 'fullscreen':
      toggleFullscreen();
      break;
    case 'panel-toggle':
      if (Date.now() < app.sheetClickBlock) break; // the end of a drag on the sheet's handle, not a tap
      setPanelOpen(!panelOpen());
      break;
    default:
      break;
  }
}

function onKeyDown(event) {
  if (event.key !== ' ' && event.key !== 'Enter') return;
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  if (app.screen !== 'game' || app.state?.status !== 'active') return;
  // Never while typing, and let focused buttons/links handle their own keys.
  const target = event.target;
  if (target.isContentEditable || target.closest?.('input, textarea, select, button, a, summary')) return;

  const type = keyboardAction();
  if (!type || !ready()) return;
  event.preventDefault();
  sound('click');
  act(type);
}

/** What Space/Enter does right now: roll or end the turn (never the jail roll — that's a real choice). */
function keyboardAction() {
  if (app.state?.status !== 'active') return null;
  const phase = app.state.turn.phase;
  if (can('ROLL') && (phase === 'rolling' || phase === 'end_turn')) return 'ROLL';
  if (can('END_TURN') && endTurnKeyHold() <= 0) return 'END_TURN';
  return null;
}

/** ms until Space/Enter may end the turn: not while my dice and token are still moving. */
function endTurnKeyHold() {
  return Math.max(app.dialogAt, app.lastRollAt + END_TURN_KEY_HOLD_MS) - Date.now();
}

function boot() {
  $('#home-name').value = savedName();
  $('#home-name').addEventListener('change', (e) => {
    const name = e.target.value.trim();
    if (name) saveName(name);
  });
  $('#create-form').addEventListener('submit', createGame);
  $('#code-form').addEventListener('submit', joinByCode);
  $('#lobby-join').addEventListener('submit', joinLobby);
  $('#auction-form').addEventListener('submit', submitBid);
  // Trade builder fields: update the draft and its summary in place (never a re-render while typing).
  const onTradeField = (event) => {
    if (event.target.dataset?.trade) onTradeInput(event.target);
  };
  document.addEventListener('input', onTradeField);
  document.addEventListener('change', onTradeField);

  document.addEventListener('click', (event) => {
    if (event.target.closest?.('summary') && !event.target.closest('#board')) sound('toggle', { volume: 0.5 });
    const el = event.target.closest('[data-act], [data-ui]');
    if (!el || el.disabled || el.closest('#board')) return; // #board belongs to the renderer
    if (!OWN_SOUND_UI.has(el.dataset.ui)) sound('click');
    if (el.dataset.act) {
      // A mouse or touch click (detail > 0) must not leave focus on the button, or on the control
      // setHtmlKeepFocus moves it to (Unmortgage → Mortgage): Space/Enter would then press that
      // instead of rolling or ending the turn. Keyboard presses (detail 0) keep their place.
      if (event.detail > 0) {
        el.blur();
        app.focusMemo = null;
      }
      onActionClick(el);
    } else {
      onUiClick(el, event);
    }
  });
  document.addEventListener('keydown', onKeyDown);
  // Remember which players' holdings are open, so re-renders keep them open (toggle doesn't bubble).
  document.addEventListener('toggle', (event) => {
    const row = event.target;
    if (!row.matches?.('details[data-player]') || !row.isConnected) return;
    if (row.open) app.expanded.add(row.dataset.player);
    else app.expanded.delete(row.dataset.player);
  }, true);
  document.addEventListener('focusin', () => { app.focusMemo = null; });
  NARROW.addEventListener('change', () => {
    clearDialog();
    rerender();
  });
  setInterval(tick, 250);
  bootShell();

  const param = new URLSearchParams(location.search).get('game');
  if (param) {
    const gameId = parseGameCode(param);
    if (gameId) {
      openGame(gameId);
      return;
    }
    toast('That game link is not valid.', 'error');
  }
  goHome();
}

boot();
