// ui.js — everything outside #board: screens (home / lobby / game), the side panel, dialogs,
// toasts and the turn countdown. The board itself is drawn by renderer2d.js; the server is the
// only source of truth, so every screen is re-rendered from the latest `state` + `legal`.

import { BOARD } from './boarddata.js';
import { render as renderBoard } from './renderer2d.js';
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
const EMPTY_LEGAL = { actions: [], build: [], sellHouse: [], mortgage: [], unmortgage: [] };
const HOME_REFRESH_MS = 5000;
const BUSY_TIMEOUT_MS = 4000;
// After a move, dialogs wait this long so the board can show the dice and the token's walk first
// (the same buttons are in the side panel right away).
const DIALOG_HOLD_MS = 1500;
// Space/Enter can't end the turn this soon after my roll (a double press would skip the move).
const END_TURN_KEY_HOLD_MS = 700;
const RECENT_LOG_LINES = 5;
const NOT_FOUND = Symbol('not found');
// Must match the single-column breakpoint in style.css: there, dialogs sit in the side panel
// above the action bar instead of floating over the board.
const NARROW = window.matchMedia('(max-width: 899px)');

const KEY_NAME = 'monopoly.name';
const KEY_SESSIONS = 'monopoly.sessions';
const seatKey = (gameId) => `monopoly.seat.${gameId}`;

// Actions that don't depend on what the player saw last: sent without the state seq.
const SEQ_FREE = new Set(['JOIN', 'LEAVE', 'START_GAME']);

const ERROR_TEXT = {
  NOT_YOUR_TURN: "It's not your turn.",
  INSUFFICIENT_FUNDS: "You don't have enough cash for that.",
  TOKEN_TAKEN: 'That token was just taken — pick another one.',
  GAME_FULL: 'Sorry, this game is full.',
  BAD_NAME: 'Names must be 1–20 characters.',
  MUST_ROLL_AGAIN: 'You rolled doubles — roll again first.',
  NOT_ENOUGH_PLAYERS: 'You need at least 2 players to start.',
  NOT_IN_LOBBY: 'The game has already started.',
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
};

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

// A control's identity across re-renders: its action (+ tile), UI command, or player row.
function focusKey(el) {
  const d = el.dataset ?? {};
  if (d.act) return `act:${d.act}:${d.tile ?? ''}`;
  if (d.ui) return `ui:${d.ui}:${d.key ?? d.game ?? ''}`;
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
  const controls = [...el.querySelectorAll('[data-act], [data-ui], summary')];
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
  document.body.dataset.screen = name;
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
    autoJoin: null, focusMemo: null, lastRollAt: 0,
  });
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
      app.dialogAt = Date.now() + DIALOG_HOLD_MS;
    }
    const myId = me()?.id;
    if (myId && events.some((e) => e.type === 'dice_rolled' && e.playerId === myId)) app.lastRollAt = Date.now();
    drawBoard(events);
    renderGame();
    if (!firstState) announceLater(events);
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
function announceLater(events) {
  const wait = app.dialogAt - Date.now();
  if (wait <= 0) {
    announce(events);
    return;
  }
  const gameId = app.gameId;
  setTimeout(() => { if (app.gameId === gameId && app.state) announce(events); }, wait);
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
    toast(`Game ${code} doesn't exist anymore.`, 'error');
    return;
  }
  if (msg.code === 'ROOM_BUSY') {
    // Too many spectators: the server didn't let this tab in. Staying would only repeat this every
    // few seconds (the unattached socket is closed, net.js reconnects, same answer), so go home.
    const code = codeOf(app.gameId);
    goHome();
    toast(`Too many people are watching game ${code} right now — try again in a little while.`, 'error', 8000);
    return;
  }
  if (msg.code === 'BAD_TOKEN') {
    clearTabSeat(app.gameId);
    forgetSession(app.gameId, app.seat?.playerId);
    app.seat = null;
    toast('Your saved seat is no longer valid — you are watching as a visitor.', 'error');
    rerender();
    return;
  }
  if (msg.code === 'STALE_STATE') {
    // The click was meant for a state that has already changed (e.g. a timeout played the move).
    toast('Too late — the game moved on.', 'info', 2500);
    rerender();
    return;
  }
  toast(ERROR_TEXT[msg.code] ?? msg.message ?? msg.code ?? 'Something went wrong.', 'error');
  rerender();
}

function handleStatus(status) {
  app.net = status;
  const replaced = status.status === 'replaced';
  $('#replaced-banner').hidden = !replaced;
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
    console.error('renderer2d.render failed:', err);
  }
}

function updateTitle() {
  const s = app.state;
  let title = 'Monopoly';
  if (app.net.status === 'replaced') title = 'Opened in another tab · Monopoly';
  else if (s?.status === 'lobby') title = `Lobby ${codeOf(s.id)} · Monopoly`;
  else if (s?.status === 'active') title = isMyTurn() ? '● Your turn · Monopoly' : `${codeOf(s.id)} · Monopoly`;
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
  if (!app.conn || app.busy) return;
  const seq = SEQ_FREE.has(type) ? undefined : app.state?.seq;
  if (!app.conn.send({ type, ...payload }, seq)) {
    toast('Not connected right now — please wait a moment.', 'error');
    return;
  }
  setBusy(true);
  rerender();
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

// Runs 4× a second: turn countdown (clock-skew corrected) and the reconnect countdown.
function tick() {
  const deadline = app.state?.status === 'active' ? app.state.turn.deadlineAt : null;
  const left = deadline ? Math.max(0, Math.ceil((deadline - (Date.now() + app.clockOffset)) / 1000)) : 0;
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  const cd = document.querySelector('[data-countdown]');
  if (cd) {
    if (!deadline) {
      cd.hidden = true;
    } else {
      const text = `⏱ ${clock}`;
      if (cd.textContent !== text) cd.textContent = text;
      cd.hidden = false;
      cd.classList.toggle('urgent', left <= 10);
    }
  }
  const offline = document.querySelector('[data-offline-in]');
  if (offline && deadline && offline.textContent !== clock) offline.textContent = clock;
  const retry = document.querySelector('[data-retry-in]');
  if (retry && app.net.retryAt) {
    retry.textContent = `${Math.max(0, Math.ceil((app.net.retryAt - Date.now()) / 1000))}s`;
  }
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
  renderBanner();
  renderActions();
  renderRecentLog();
  renderPlayers();
  renderProperties();
  renderFooter();
  renderDialog();
  tick();
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

  setHtml($('#turn-banner'), `
    <div class="turn-banner${mine ? ' mine' : ''}" style="--pc:${cur && s.status === 'active' ? playerColor(s, cur.id) : 'var(--muted)'}">
      <span class="turn-token">${cur && s.status === 'active' ? tokenEmoji(cur.token) : '🏁'}</span>
      <div class="turn-text">
        <div class="turn-title">${title}</div>
        <div class="turn-sub">${esc(sub.join(' · '))}</div>
      </div>
      <span class="countdown" data-countdown hidden></span>
    </div>`);
}

function myTurnText(s) {
  const t = s.turn;
  switch (t.phase) {
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
    case 'paying': return `You owe ${money(t.pendingDebt?.amount)} — raise cash or declare bankruptcy`;
    case 'end_turn': return t.rollAgain ? 'Doubles! Roll again' : 'Build or mortgage if you like, then end your turn';
    default: return 'Your turn';
  }
}

/** Banner text (HTML) while someone else is to move. */
function otherTurnHtml(s, cur) {
  const t = s.turn;
  const name = cur?.name ?? 'the next player';
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
    setHtmlKeepFocus(bar, `<p class="note">👀 You're watching this game.${app.takeover ? ` ${takeoverLink()}` : ''}</p>`);
    return;
  }
  if (m.bankrupt) {
    setHtml(bar, `<p class="note">${app.resigned ? 'You resigned' : 'You went bankrupt'} — watching the rest of the game.</p>`);
    return;
  }

  const t = s.turn;
  const ok = ready();
  const buttons = [];
  const button = (type, label, cls = '', enabled = true) =>
    buttons.push(`<button type="button" class="btn ${cls}" data-act="${type}"${disabledAttr(enabled && ok)}>${label}</button>`);

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
  if (can('DECLARE_BANKRUPTCY')) button('DECLARE_BANKRUPTCY', 'Declare bankruptcy', 'danger');

  let hint = '';
  const canRaise = app.legal.mortgage.length > 0 || app.legal.sellHouse.length > 0;
  if (isMyTurn() && t.phase === 'buying_or_auction' && !can('BUY')) {
    hint = canRaise ? 'Not enough cash to buy — mortgage or sell to raise it, or decline.' : 'Not enough cash to buy — decline.';
  } else if (isMyTurn() && t.phase === 'paying' && !can('PAY_DEBT')) {
    hint = canRaise
      ? `Raise ${money(t.pendingDebt.amount - m.cash)} more by selling or mortgaging.`
      : 'Nothing left to sell or mortgage.';
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
  return `<div class="pgroup" style="--gc:${color}">
    <div class="pgroup-head">
      <span>${esc(name)}</span><span class="muted">${list.length}/${total}</span>
      ${fullSet ? '<span class="tag set">Full set</span>' : ''}
    </div>
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
  const hold = app.dialogAt - Date.now();
  clearTimeout(app.dialogTimer);
  // A dialog that is already up just refreshes; a new one waits for the board's move animation.
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
  box.querySelectorAll(scrollers).forEach((e, k) => { if (scrolled[k]) e.scrollTop = scrolled[k]; });
  // Only a newly opened dialog pops in; updates to the one on screen (cash, buttons) don't.
  if (alreadyShown) box.firstElementChild?.classList.add('shown');
  else focusNewDialog(box, narrow);
}

// Keyboard users continue in a new dialog: if focus was lost to a re-render (after Roll) or is in
// the action bar, move it to the dialog's main button (never a dangerous one). On narrow layouts
// those buttons live in the action bar.
function focusNewDialog(box, narrow) {
  const active = document.activeElement;
  const bar = $('#action-bar');
  const fromBody = !active || active === document.body;
  if (!fromBody && !(!narrow && bar.contains(active))) return;
  const safe = '[data-act]:not(:disabled):not(.danger)';
  const target = narrow
    ? bar.querySelector(`.action-buttons ${safe}`)
    : box.querySelector(`.dialog-btns ${safe}`) ?? box.querySelector('.dialog');
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
  if (!m || m.bankrupt || !isMyTurn()) return null;
  const t = s.turn;
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
function deedHtml(tile, heading) {
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
    <div class="deed-band" id="dialog-title"><span class="deed-kicker">${esc(heading)}</span><strong>${esc(tile.name)}</strong></div>
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
      <button type="button" class="btn danger" data-act="DECLARE_BANKRUPTCY"${disabledAttr(ok && can('DECLARE_BANKRUPTCY'))}>Declare bankruptcy</button>
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
function announce(events) {
  const s = app.state;
  const myId = me()?.id;
  const name = (id) => playerName(s, id);
  for (const ev of events) {
    const mine = !!myId && ev.playerId === myId;
    switch (ev.type) {
      case 'turn_started':
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
      case 'timeout':
        if (mine) toast("Time's up — the game played your turn for you", 'bad');
        break;
      case 'bankrupt':
        if (mine) toast(app.resigned ? 'You resigned from the game' : 'You went bankrupt', 'bad', 6000);
        else if (myId && ev.toPlayerId === myId) toast(`${name(ev.playerId)} went bankrupt — their assets are yours`, 'good', 6000);
        else toast(`${name(ev.playerId)} went bankrupt`, 'info');
        break;
      default:
        break;
    }
  }
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
      app.dismissed.add(el.dataset.key);
      renderDialog();
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

  document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-act], [data-ui]');
    if (!el || el.disabled || el.closest('#board')) return; // #board belongs to the renderer
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
