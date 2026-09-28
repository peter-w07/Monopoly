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
const NOT_FOUND = Symbol('not found');

const KEY_NAME = 'monopoly.name';
const KEY_SESSIONS = 'monopoly.sessions';
const seatKey = (gameId) => `monopoly.seat.${gameId}`;

const CONFIRM_TEXT = {
  DECLARE_BANKRUPTCY: 'Declare bankruptcy? Everything you own goes to your creditor and you are out of the game.',
  LEAVE: 'Resign from this game? Your cash and properties go back to the bank and you are out of the game.',
};

const ERROR_TEXT = {
  NOT_YOUR_TURN: "It's not your turn.",
  INSUFFICIENT_FUNDS: "You don't have enough cash for that.",
  TOKEN_TAKEN: 'That token was just taken — pick another one.',
  GAME_FULL: 'Sorry, this game is full.',
  BAD_NAME: 'Names must be 1–20 characters.',
  MUST_ROLL_AGAIN: 'You rolled doubles — roll again first.',
  NOT_ENOUGH_PLAYERS: 'You need at least 2 players to start.',
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
  });
  setBusy(false);
  app.dismissed.clear();
  app.dialogAt = 0;
  clearTimeout(app.dialogTimer);
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

/** Open a game table (lobby or game) — resolving this tab's seat per CONTRACT §8. */
async function openGame(gameId) {
  closeGame();
  const seq = app.openSeq;
  app.gameId = gameId;
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
  const firstState = !app.state;
  app.state = state;
  app.legal = { ...EMPTY_LEGAL, ...(msg.legal ?? {}) };
  if (typeof msg.now === 'number') app.clockOffset = msg.now - Date.now();
  setBusy(false);
  syncStoredSeat();

  const events = Array.isArray(msg.events) ? msg.events : [];
  if (state.status === 'lobby') {
    showScreen('lobby');
    renderLobby();
  } else {
    if (app.screen !== 'game') showScreen('game');
    if (!firstState && !document.hidden && events.some((e) => e.type === 'moved')) {
      app.dialogAt = Date.now() + DIALOG_HOLD_MS;
    }
    drawBoard(events);
    renderGame();
    if (!firstState) announceLater(events);
  }
  updateTitle();
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
// seat once our player has left the lobby (the server turns that socket into a spectator).
// Only `welcome` creates remembered seats, so two tabs in one browser don't keep overwriting
// each other's entry on every broadcast.
function syncStoredSeat() {
  if (!app.seat) return;
  const m = me();
  const remembered = getSessions()[app.gameId];
  if (m) {
    if (remembered?.playerId === m.id && remembered.name !== m.name) rememberSession(app.gameId, app.seat, m.name);
  } else if (app.state.status === 'lobby') {
    clearTabSeat(app.gameId);
    forgetSession(app.gameId, app.seat.playerId);
    app.seat = null; // a new JOIN gets a fresh seat via `welcome`
  }
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
  if (msg.code === 'BAD_TOKEN') {
    clearTabSeat(app.gameId);
    forgetSession(app.gameId, app.seat?.playerId);
    app.seat = null;
    toast('Your saved seat is no longer valid — you are watching as a visitor.', 'error');
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
  if (!app.conn.send({ type, ...payload })) {
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
  const cd = document.querySelector('[data-countdown]');
  if (cd) {
    const deadline = app.state?.status === 'active' ? app.state.turn.deadlineAt : null;
    if (!deadline) {
      cd.hidden = true;
    } else {
      const secs = Math.max(0, Math.ceil((deadline - (Date.now() + app.clockOffset)) / 1000));
      const text = `⏱ ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      if (cd.textContent !== text) cd.textContent = text;
      cd.hidden = false;
      cd.classList.toggle('urgent', secs <= 10);
    }
  }
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
    openGame(body.gameId);
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

  // Seated: host starts, anyone can leave.
  let actions = '';
  if (m) {
    if (s.hostId === m.id) {
      actions += `<button type="button" class="btn primary" data-act="START_GAME"${disabledAttr(can('START_GAME') && ready())}>Start game</button>`;
      if (!can('START_GAME')) actions += `<span class="hint">${s.players.length < 2 ? 'Need 2+ players to start.' : 'Waiting…'}</span>`;
    } else {
      const host = playerById(s, s.hostId);
      actions += `<span class="hint">Waiting for ${host ? esc(host.name) : 'the host'} to start the game…</span>`;
    }
    if (can('LEAVE')) actions += `<button type="button" class="btn ghost" data-act="LEAVE"${disabledAttr(ready())}>Leave</button>`;
  }
  setHtml($('#lobby-actions'), actions);

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
    title = winner ? (winner.id === m?.id ? '🏆 You win!' : `🏆 ${winner.name} wins!`) : 'Game over';
  } else {
    title = mine ? myTurnText(s) : otherTurnText(s, cur);
  }
  const sub = [];
  if (s.status === 'active') sub.push(`Turn ${s.turn.number}`);
  if (s.settings.freeParkingPot) sub.push(`Free Parking pot ${money(s.pot)}`);
  if (!m) sub.push('Spectating');

  setHtml($('#turn-banner'), `
    <div class="turn-banner${mine ? ' mine' : ''}" style="--pc:${cur && s.status === 'active' ? playerColor(s, cur.id) : 'var(--muted)'}">
      <span class="turn-token">${cur && s.status === 'active' ? tokenEmoji(cur.token) : '🏁'}</span>
      <div class="turn-text">
        <div class="turn-title">${esc(title)}</div>
        <div class="turn-sub">${esc(sub.join(' · '))}</div>
      </div>
      <span class="countdown" data-countdown hidden></span>
    </div>`);
}

function myTurnText(s) {
  const t = s.turn;
  switch (t.phase) {
    case 'rolling': return 'Your turn — roll the dice';
    case 'jail_decision': return `You're in jail — pay ${money(BOARD.jailFine)}, use a card or roll for doubles`;
    case 'buying_or_auction': return `Buy ${tileName(t.pendingPurchase)} for ${money(TILES[t.pendingPurchase]?.price)}?`;
    case 'paying': return `You owe ${money(t.pendingDebt?.amount)} — raise cash or declare bankruptcy`;
    case 'end_turn': return t.rollAgain ? 'Doubles! Roll again' : 'Build or mortgage if you like, then end your turn';
    default: return 'Your turn';
  }
}

function otherTurnText(s, cur) {
  const t = s.turn;
  const name = cur?.name ?? 'the next player';
  switch (t.phase) {
    case 'rolling': return `Waiting for ${name} to roll…`;
    case 'jail_decision': return `${name} is in jail and deciding what to do…`;
    case 'buying_or_auction': return `${name} is deciding whether to buy ${tileName(t.pendingPurchase)}…`;
    case 'paying': return `${name} owes ${money(t.pendingDebt?.amount)} and is raising cash…`;
    case 'end_turn': return t.rollAgain ? `${name} rolled doubles and goes again…` : `Waiting for ${name} to finish their turn…`;
    default: return `Waiting for ${name}…`;
  }
}

function renderActions() {
  const s = app.state;
  const m = me();
  const bar = $('#action-bar');
  if (s.status !== 'active') {
    setHtml(bar, '<button type="button" class="btn primary block" data-ui="home">Back to home</button>');
    return;
  }
  if (!m) {
    setHtml(bar, `<p class="note">👀 You're watching this game.${app.takeover ? ` ${takeoverLink()}` : ''}</p>`);
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
  if (isMyTurn() && t.phase === 'buying_or_auction' && !can('BUY')) {
    hint = 'Not enough cash to buy — mortgage or sell below, or decline.';
  } else if (isMyTurn() && t.phase === 'paying' && !can('PAY_DEBT')) {
    hint = `Raise ${money(t.pendingDebt.amount - m.cash)} more by selling or mortgaging below.`;
  }
  const key = keyboardAction();
  const keyHint = key ? `<p class="hint kbd-hint">Tip: press <kbd>Space</kbd> to ${key === 'ROLL' ? 'roll' : 'end your turn'}.</p>` : '';
  setHtml(bar, buttons.length
    ? `<div class="action-buttons">${buttons.join('')}</div>${hint ? `<p class="hint">${hint}</p>` : keyHint}`
    : '');
}

function renderPlayers() {
  const s = app.state;
  const curId = s.status === 'active' ? currentPlayerId(s) : null;
  const myId = me()?.id;
  setHtml($('#game-players'), s.players.map((p, i) => {
    const badges = [];
    if (p.inJail) badges.push('<span class="tag jail">🔒 In jail</span>');
    if (p.getOutOfJailCards > 0) badges.push(`<span class="tag goojf" title="Get Out of Jail Free cards">🎫 ${p.getOutOfJailCards}</span>`);
    if (!p.connected && !p.bankrupt) badges.push('<span class="tag off">offline</span>');
    if (p.id === s.winnerId) badges.push('<span class="tag set">winner</span>');
    const cls = ['prow', p.id === curId && 'current', p.bankrupt && 'bankrupt', !p.connected && 'offline'].filter(Boolean).join(' ');
    return `<li class="${cls}" style="--pc:${PLAYER_COLORS[i % PLAYER_COLORS.length]}">
      <span class="pdot"></span>
      <span class="prow-token">${tokenEmoji(p.token)}</span>
      <span class="prow-main">
        <span class="prow-name">${esc(p.name)}${p.id === myId ? ' <span class="tag you">you</span>' : ''}</span>
        <span class="prow-badges">${badges.join('')}</span>
      </span>
      <span class="prow-cash">${p.bankrupt ? 'Bankrupt' : money(p.cash)}</span>
    </li>`;
  }).join(''));
}

function renderProperties() {
  const s = app.state;
  const m = me();
  const section = $('#props-section');
  section.hidden = !m || m.bankrupt;
  if (section.hidden) return;

  const owned = s.tiles.filter((t) => t.ownerId === m.id);
  const bankLine = `<div class="bank-line">Bank: ${s.bank.houses} houses · ${s.bank.hotels} hotels</div>`;
  if (!owned.length) {
    setHtml($('#my-props'), `<p class="muted small">You don't own anything yet — land on an unowned property to buy it.</p>`);
    return;
  }
  const groups = new Map();
  for (const ts of owned) {
    const tile = TILES[ts.index];
    const key = tile.type === 'property' ? tile.group : tile.type;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ts);
  }
  setHtml($('#my-props'), bankLine + GROUP_ORDER
    .filter((key) => groups.has(key))
    .map((key) => groupHtml(s, key, groups.get(key)))
    .join(''));
}

function groupHtml(s, key, list) {
  const info = BOARD.groups[key];
  const name = info?.name ?? (key === 'railroad' ? 'Railroads' : 'Utilities');
  const color = info?.color ?? (key === 'railroad' ? '#3d4448' : '#8a9199');
  const total = TILES.filter((t) => (info ? t.group === key : t.type === key)).length;
  const fullSet = !!info && list.length === total;
  return `<div class="pgroup" style="--gc:${color}">
    <div class="pgroup-head">
      <span>${esc(name)}</span><span class="muted">${list.length}/${total}</span>
      ${fullSet ? '<span class="tag set">Full set</span>' : ''}
    </div>
    ${list.sort((a, b) => a.index - b.index).map((ts) => propertyRow(s, ts, fullSet)).join('')}
  </div>`;
}

function propertyRow(s, ts, fullSet) {
  const tile = TILES[ts.index];
  const i = ts.index;
  const L = app.legal;
  const ok = ready();
  const button = (type, list, label, cls = '') =>
    `<button type="button" class="btn small ${cls}" data-act="${type}" data-tile="${i}"${disabledAttr(ok && list.includes(i))}>${label}</button>`;

  const buttons = [];
  if (tile.type === 'property' && fullSet && !ts.mortgaged && ts.houses < 5) {
    buttons.push(button('BUILD', L.build, `${ts.houses === 4 ? 'Build hotel' : 'Build house'} −${money(tile.houseCost)}`));
  }
  if (ts.houses > 0) {
    buttons.push(button('SELL_HOUSE', L.sellHouse, `Sell ${ts.houses === 5 ? 'hotel' : 'house'} +${money(Math.floor(tile.houseCost / 2))}`));
  }
  if (!ts.mortgaged && ts.houses === 0) buttons.push(button('MORTGAGE', L.mortgage, `Mortgage +${money(tile.mortgage)}`));
  if (ts.mortgaged) buttons.push(button('UNMORTGAGE', L.unmortgage, `Unmortgage −${money(unmortgageCost(i))}`, 'primary'));

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
// Dialogs — floating cards over the board (never over the side panel), only for me.
// Closing one just hides it; the same buttons stay available in the side panel.
// ---------------------------------------------------------------------------

function renderDialog() {
  const layer = $('#dialog-layer');
  const dialog = currentDialog();
  const visible = !!dialog && !app.dismissed.has(dialog.key);
  const hold = app.dialogAt - Date.now();
  clearTimeout(app.dialogTimer);
  // A dialog that is already up just refreshes; a new one waits for the board's move animation.
  if (!visible || (hold > 0 && layer.dataset.key !== dialog.key)) {
    clearDialog();
    if (visible) app.dialogTimer = setTimeout(renderDialog, hold);
    return;
  }
  const alreadyShown = layer.dataset.key === dialog.key;
  layer.dataset.key = dialog.key;
  setHtml(layer, `<div class="dialog ${dialog.cls ?? ''}" role="dialog" aria-labelledby="dialog-title">
    <button type="button" class="dialog-x" data-ui="dismiss" data-key="${esc(dialog.key)}" aria-label="Hide" title="Hide — the buttons stay in the side panel">×</button>
    ${dialog.html}
  </div>`);
  // Only a newly opened dialog pops in; updates to the one on screen (cash, buttons) don't.
  if (alreadyShown) layer.firstElementChild?.classList.add('shown');
}

function clearDialog() {
  const layer = $('#dialog-layer');
  setHtml(layer, '');
  delete layer.dataset.key;
}

function currentDialog() {
  const s = app.state;
  if (s.status === 'finished') return { key: 'game-over', cls: 'dialog-over', html: gameOverHtml(s) };
  const m = me();
  if (!m || m.bankrupt || !isMyTurn()) return null;
  const t = s.turn;
  if (t.phase === 'buying_or_auction' && t.pendingPurchase != null) {
    return { key: `buy:${t.number}:${t.pendingPurchase}`, html: buyHtml(m, t.pendingPurchase) };
  }
  if (t.phase === 'paying' && t.pendingDebt) {
    return { key: `debt:${t.number}:${t.pendingDebt.reason}:${t.pendingDebt.amount}`, html: debtHtml(s, m, t.pendingDebt) };
  }
  if (t.phase === 'jail_decision') return { key: `jail:${t.number}`, html: jailHtml(m) };
  return null;
}

function buyHtml(m, index) {
  const tile = TILES[index];
  const ok = ready();
  const short = tile.price - m.cash;
  let hint = '';
  if (!can('BUY')) {
    hint = short > 0
      ? `<p class="hint">You need ${money(short)} more. Mortgage or sell buildings under <em>My properties</em>, or decline.</p>`
      : `<p class="hint">You can't buy this right now.</p>`;
  }
  return `<h3 id="dialog-title" class="dialog-title">Buy ${esc(tile.name)}?</h3>
    ${deedHtml(tile)}
    <div class="dialog-cash">You have <strong>${money(m.cash)}</strong></div>
    <div class="dialog-btns">
      <button type="button" class="btn primary" data-act="BUY"${disabledAttr(ok && can('BUY'))}>Buy ${money(tile.price)}</button>
      <button type="button" class="btn" data-act="DECLINE"${disabledAttr(ok && can('DECLINE'))}>Decline</button>
    </div>
    ${hint}`;
}

/** Title-deed card: color band, rent table, costs. */
function deedHtml(tile) {
  let band = '#3d4448';
  let kicker = 'Title deed';
  let rows = [];
  if (tile.type === 'property') {
    band = BOARD.groups[tile.group]?.color ?? band;
    rows = [
      ['Rent', money(tile.rent[0])],
      ['With the full color set', money(tile.rent[0] * 2)],
      ...[1, 2, 3, 4].map((n) => [`With ${n} house${n > 1 ? 's' : ''}`, money(tile.rent[n])]),
      ['With a hotel', money(tile.rent[5])],
    ];
  } else if (tile.type === 'railroad') {
    kicker = '🚂 Railroad';
    rows = tile.rent.map((r, i) => [`If ${i + 1} railroad${i ? 's are' : ' is'} owned`, money(r)]);
  } else if (tile.type === 'utility') {
    band = '#8a9199';
    kicker = /water/i.test(tile.name) ? '🚰 Utility' : '💡 Utility';
    rows = tile.multipliers.map((x, i) => [`If ${i + 1} utilit${i ? 'ies are' : 'y is'} owned`, `${x}× dice`]);
  }
  const costs = [`Price ${money(tile.price)}`, tile.houseCost ? `Houses ${money(tile.houseCost)} each` : '', `Mortgage ${money(tile.mortgage)}`]
    .filter(Boolean).join(' · ');
  return `<div class="deed" style="--gc:${band};--gc-text:${textOn(band)}">
    <div class="deed-band"><span class="deed-kicker">${kicker}</span><strong>${esc(tile.name)}</strong></div>
    <table class="deed-rent">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
    <div class="deed-foot">${costs}</div>
  </div>`;
}

function debtHtml(s, m, debt) {
  const ok = ready();
  const creditor = debt.payees?.length ? 'the other players' : debt.toPlayerId ? playerName(s, debt.toPlayerId) : 'the bank';
  const reason = { rent: 'rent', tax: 'tax', card: 'a card', jail_fine: 'the jail fine' }[debt.reason] ?? String(debt.reason ?? '').replace(/_/g, ' ');
  const short = debt.amount - m.cash;
  return `<h3 id="dialog-title" class="dialog-title">💸 You owe ${money(debt.amount)}</h3>
    <p class="dialog-text">To <strong>${esc(creditor)}</strong>${reason ? ` for ${esc(reason)}` : ''}.</p>
    <div class="dialog-cash">You have <strong>${money(m.cash)}</strong>${short > 0 ? ` — <span class="neg">${money(short)} short</span>` : ''}</div>
    ${short > 0 ? '<p class="hint">Sell buildings or mortgage properties under <em>My properties</em> to raise the rest — or declare bankruptcy.</p>' : ''}
    <div class="dialog-btns">
      <button type="button" class="btn primary" data-act="PAY_DEBT"${disabledAttr(ok && can('PAY_DEBT'))}>Pay ${money(debt.amount)}</button>
      <button type="button" class="btn danger" data-act="DECLARE_BANKRUPTCY"${disabledAttr(ok && can('DECLARE_BANKRUPTCY'))}>Declare bankruptcy</button>
    </div>`;
}

function jailHtml(m) {
  const ok = ready();
  const used = m.jailTurns ?? 0;
  const max = BOARD.maxJailTurns;
  const lastTry = used >= max - 1;
  const cards = m.getOutOfJailCards;
  return `<h3 id="dialog-title" class="dialog-title">🔒 You're in jail</h3>
    <p class="dialog-text">Doubles attempts used: <strong>${used} of ${max}</strong>.
      ${lastTry ? `Last try — if you miss, you pay ${money(BOARD.jailFine)} and move anyway.` : ''}</p>
    <div class="dialog-cash">You have <strong>${money(m.cash)}</strong>${cards ? ` · 🎫 ${cards} jail card${cards > 1 ? 's' : ''}` : ''}</div>
    <div class="dialog-btns stack">
      <button type="button" class="btn primary" data-act="ROLL"${disabledAttr(ok && can('ROLL'))}>🎲 Roll for doubles</button>
      <button type="button" class="btn" data-act="PAY_JAIL_FINE"${disabledAttr(ok && can('PAY_JAIL_FINE'))}>Pay fine ${money(BOARD.jailFine)}</button>
      <button type="button" class="btn" data-act="USE_JAIL_CARD"${disabledAttr(ok && can('USE_JAIL_CARD'))}>🎫 Use jail card</button>
    </div>`;
}

function gameOverHtml(s) {
  const winner = playerById(s, s.winnerId);
  const iWon = !!winner && winner.id === me()?.id;
  return `<h3 id="dialog-title" class="dialog-title">${iWon ? '🏆 You win!' : '🏁 Game over'}</h3>
    ${winner ? `<p class="dialog-text">${tokenEmoji(winner.token)} ${esc(winner.name)} is the last player standing with ${money(winner.cash)}.</p>` : ''}
    <div class="dialog-btns"><button type="button" class="btn primary" data-ui="home">Back to home</button></div>`;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function toast(text, kind = 'info', ms = 4500) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = text;
  el.addEventListener('click', () => el.remove());
  box.append(el);
  while (box.children.length > 5) box.firstElementChild.remove();
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

/** Toasts for events that involve me (plus bankruptcies, which matter to everyone). */
function announce(events) {
  const s = app.state;
  const myId = me()?.id;
  const name = (id) => playerName(s, id);
  for (const ev of events) {
    const mine = !!myId && ev.playerId === myId;
    switch (ev.type) {
      case 'turn_started':
        if (mine) toast("🎲 It's your turn!", 'info', 2500);
        break;
      case 'passed_go':
        if (mine) toast(`You passed GO and collected ${money(ev.amount)}`, 'good');
        break;
      case 'bought':
        if (mine) toast(`You bought ${tileName(ev.tileIndex)} for ${money(ev.price)}`, 'good');
        break;
      case 'paid_rent':
        if (mine) toast(`You paid ${money(ev.amount)} rent to ${name(ev.ownerId)} for ${tileName(ev.tileIndex)}`, 'bad');
        else if (myId && ev.ownerId === myId) toast(`${name(ev.playerId)} paid you ${money(ev.amount)} rent for ${tileName(ev.tileIndex)}`, 'good');
        break;
      case 'paid_tax':
        if (mine) toast(`You paid ${money(ev.amount)} ${tileName(ev.tileIndex)}`, 'bad');
        break;
      case 'paid': // card fees / jail fines; my own card fees are already explained by the card toast
        if (mine && ev.reason !== 'card') toast(`You paid ${money(ev.amount)} to ${ev.toPlayerId ? name(ev.toPlayerId) : 'the bank'}`, 'bad');
        else if (!mine && myId && ev.toPlayerId === myId) toast(`${name(ev.playerId)} paid you ${money(ev.amount)}`, 'good');
        break;
      case 'collected':
        if (mine && ev.reason === 'free_parking') toast(`You collected the ${money(ev.amount)} Free Parking pot!`, 'good');
        else if (mine && ev.reason !== 'card') toast(`You collected ${money(ev.amount)}`, 'good');
        else if (!mine && myId && ev.fromPlayerId === myId) toast(`You paid ${money(ev.amount)} to ${name(ev.playerId)}`, 'bad');
        break;
      case 'debt_paid':
        if (mine) toast(`Debt of ${money(ev.amount)} paid`, 'good');
        else if (myId && (ev.toPlayerId === myId || ev.payees?.some((x) => x.playerId === myId))) {
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
      case 'left_jail':
        if (mine) toast("You're out of jail!", 'good');
        break;
      case 'debt_started':
        if (mine) toast(`You owe ${money(ev.amount)} — raise cash to pay it`, 'bad');
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

function onActionClick(el) {
  const type = el.dataset.act;
  // LEAVE only needs a confirmation while the game is running (it means resigning).
  const confirmText = type === 'LEAVE' && app.state?.status !== 'active' ? null : CONFIRM_TEXT[type];
  if (confirmText && !window.confirm(confirmText)) return;
  if (type === 'LEAVE' && app.state?.status === 'active') app.resigned = true;
  act(type, el.dataset.tile != null ? { tileIndex: Number(el.dataset.tile) } : {});
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
  if (can('END_TURN')) return 'END_TURN';
  return null;
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
    if (el.dataset.act) onActionClick(el);
    else onUiClick(el, event);
  });
  document.addEventListener('keydown', onKeyDown);
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
