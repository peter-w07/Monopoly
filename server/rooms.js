// In-memory game registry, player sessions (seats) and broadcast.
//
// room = {
//   id, state,                     authoritative engine state (full, private: includes rng + decks)
//   sockets: Map<playerId, ws>,    one socket per seat
//   spectators: Set<ws>,           sockets without a seat
//   secrets: Map<playerId, token>, seat tokens (never sent to anyone but the seat owner)
//   dirty, saveTimer, saving,      save policy (persist.js)
//   timer,                         turn timer (timers.js)
//   emptySince,                    when the last socket left (lobby cleanup)
//   finishing, archived, deleted, dropTimer   game-over / removal bookkeeping
// }
// Each socket carries ws.session = { room, playerId } (room null until hello, playerId null for spectators).

import crypto from 'node:crypto';
import {
  createGame,
  normalizeSettings,
  applyAction,
  legalActions,
  currentPlayerId,
} from '../engine/index.js';
import {
  isValidGameId,
  gameIdTaken,
  loadAll,
  saveRoom,
  scheduleSave,
  cancelScheduledSave,
  applySavePolicy,
  archiveGame,
  deleteGame,
} from './persist.js';
import { newTimerState, reconcileTimer, onConnectionChange, clearTimer, setExpireHandler } from './timers.js';

const MAX_ROOMS = 1000;
const LOBBY_IDLE_MS = 30 * 60_000;
const FINISHED_LINGER_MS = 60_000;
const CLEANUP_INTERVAL_MS = 60_000;
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const MAX_ACTION_TYPE_LENGTH = 40;

const rooms = new Map();
let shuttingDown = false;
let cleanupHandle = null;

const log = (...args) => console.log('[rooms]', ...args);
const logError = (...args) => console.error('[rooms]', ...args);

// ---------------------------------------------------------------------------
// Helpers

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function randomChars(n) {
  let out = '';
  for (let i = 0; i < n; i++) out += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
  return out;
}

function newGameId() {
  for (let i = 0; i < 100; i++) {
    const id = `g_${randomChars(6)}`;
    if (!rooms.has(id) && !gameIdTaken(id)) return id;
  }
  throw new Error('could not allocate a game id');
}

function newPlayerId(room) {
  for (;;) {
    const id = `p_${randomChars(8)}`;
    if (!room.state.players.some((p) => p.id === id) && !room.secrets.has(id)) return id;
  }
}

/** Accepts "g_abc234", "abc234", "ABC234"... → canonical id, or null. */
export function normalizeGameId(raw) {
  if (typeof raw !== 'string' || raw.length > 32) return null;
  let id = raw.trim().toLowerCase();
  if (!id.startsWith('g_')) id = `g_${id}`;
  return isValidGameId(id) ? id : null;
}

// Constant-time comparison that is safe for inputs of different lengths.
function tokensMatch(expected, given) {
  if (typeof expected !== 'string' || typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const findPlayer = (state, playerId) => state.players.find((p) => p.id === playerId) ?? null;
const socketCount = (room) => room.sockets.size + room.spectators.size;
const playerLabel = (room, playerId) => `${findPlayer(room.state, playerId)?.name ?? '?'} (${playerId})`;

function updateEmptySince(room) {
  room.emptySince = socketCount(room) === 0 ? (room.emptySince ?? Date.now()) : null;
}

function makeRoom(state, secrets = new Map()) {
  return {
    id: state.id,
    state,
    sockets: new Map(),
    spectators: new Set(),
    secrets,
    dirty: false,
    saveTimer: null,
    saving: null,
    timer: newTimerState(),
    emptySince: Date.now(),
    finishing: null,
    archived: false,
    deleted: false,
    dropTimer: null,
  };
}

// ---------------------------------------------------------------------------
// Sending

const OPEN = 1; // WebSocket.OPEN

function sendRaw(ws, text) {
  if (ws.readyState !== OPEN) return;
  ws.send(text, (err) => {
    if (err) console.warn(`[ws] send failed: ${err.message}`);
  });
}

const send = (ws, msg) => sendRaw(ws, JSON.stringify(msg));
const sendError = (ws, code, message) => send(ws, { t: 'error', code, message });

/** The state clients see: no rng (future dice) and no deck order (future cards). */
export function publicState(state) {
  const { rng, decks, ...rest } = state;
  return {
    ...rest,
    decks: {
      chance: { size: decks?.chance?.order?.length ?? 0 },
      community: { size: decks?.community?.order?.length ?? 0 },
    },
  };
}

function safeLegal(state, playerId) {
  try {
    return legalActions(state, playerId);
  } catch (err) {
    logError(`legalActions failed for ${state.id}/${playerId}:`, err);
    return { actions: [], build: [], sellHouse: [], mortgage: [], unmortgage: [] };
  }
}

// Serialise the public state once; each socket only adds its own `legal`.
function stateFrames(room, events) {
  const head =
    `{"t":"state","state":${JSON.stringify(publicState(room.state))}` +
    `,"events":${JSON.stringify(events)},"now":${Date.now()},"legal":`;
  return (playerId) => `${head}${JSON.stringify(safeLegal(room.state, playerId))}}`;
}

function broadcast(room, events = []) {
  const frameFor = stateFrames(room, events);
  for (const [playerId, ws] of room.sockets) sendRaw(ws, frameFor(playerId));
  if (room.spectators.size > 0) {
    const frame = frameFor(null);
    for (const ws of room.spectators) sendRaw(ws, frame);
  }
}

function sendState(room, ws, events = []) {
  sendRaw(ws, stateFrames(room, events)(ws.session.playerId));
}

// ---------------------------------------------------------------------------
// Registry

export const roomCount = () => rooms.size;

export function getRoom(rawId) {
  const id = normalizeGameId(rawId);
  return (id && rooms.get(id)) || null;
}

/** Create a lobby. Returns the room, or null when the server is at capacity. */
export function createRoom(settings = {}) {
  if (rooms.size >= MAX_ROOMS) return null;
  const id = newGameId();
  const seed = crypto.randomBytes(4).readUInt32BE(0);
  const state = createGame({ id, seed, settings: normalizeSettings(isPlainObject(settings) ? settings : {}) });
  const now = Date.now();
  state.createdAt = now;
  state.updatedAt = now;

  const room = makeRoom(state);
  rooms.set(id, room);
  reconcileTimer(room);
  room.dirty = true;
  scheduleSave(room);
  log(`created ${id}`);
  return room;
}

/** Open lobbies for the home screen. */
export function listOpenLobbies() {
  const games = [];
  for (const { state } of rooms.values()) {
    if (state.status !== 'lobby' || state.players.length >= state.settings.maxPlayers) continue;
    games.push({
      id: state.id,
      players: state.players.length,
      maxPlayers: state.settings.maxPlayers,
      hostName: findPlayer(state, state.hostId)?.name ?? null,
      createdAt: state.createdAt,
    });
  }
  return games.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
}

/** Public summary for GET /api/games/:id (`token` is the game piece, never the secret). */
export function gameSummary(room) {
  const { state } = room;
  return {
    id: state.id,
    status: state.status,
    players: state.players.map(({ id, name, token, connected, bankrupt }) => ({ id, name, token, connected, bankrupt })),
    settings: state.settings,
    createdAt: state.createdAt,
  };
}

/** Restore every saved game at startup. */
export async function loadRooms() {
  const saved = await loadAll();
  let restored = 0;
  for (const { state, secrets } of saved) {
    if (rooms.has(state.id)) continue;
    if (state.status === 'finished') {
      // Crashed between the final save and the move: finish the move now.
      try {
        await archiveGame(state.id);
        log(`archived finished game ${state.id} found in games/`);
      } catch (err) {
        logError(`could not archive ${state.id}: ${err.message}`);
      }
      continue;
    }
    for (const p of state.players) p.connected = false;
    state.turn.deadlineAt = null;
    const secretMap = new Map(
      Object.entries(secrets).filter(([pid, token]) => typeof token === 'string' && findPlayer(state, pid)),
    );
    const room = makeRoom(state, secretMap);
    rooms.set(room.id, room);
    reconcileTimer(room); // nobody is connected yet, so this stays paused until someone returns
    restored++;
  }
  const active = [...rooms.values()].filter((r) => r.state.status === 'active').length;
  log(`restored ${restored} game(s): ${active} active, ${restored - active} in lobby`);
}

async function dropRoom(room, { deleteFile = false } = {}) {
  if (room.deleted) return;
  room.deleted = true;
  if (rooms.get(room.id) === room) rooms.delete(room.id);
  clearTimer(room);
  cancelScheduledSave(room);
  clearTimeout(room.dropTimer);
  for (const ws of [...room.sockets.values(), ...room.spectators]) ws.session = { room: null, playerId: null };
  room.sockets.clear();
  room.spectators.clear();
  if (deleteFile) {
    await room.saving; // let an in-flight write finish before unlinking
    await deleteGame(room.id);
  }
}

function cleanupIdleLobbies() {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.state.status !== 'lobby' || socketCount(room) > 0 || room.emptySince == null) continue;
    if (now - room.emptySince < LOBBY_IDLE_MS) continue;
    log(`removing idle lobby ${room.id}`);
    dropRoom(room, { deleteFile: true }).catch((err) => logError(`removing ${room.id} failed: ${err.message}`));
  }
}

export function startMaintenance() {
  cleanupHandle ??= setInterval(cleanupIdleLobbies, CLEANUP_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Applying changes

// Seats whose player is gone (LEAVE in the lobby) become spectators; their secrets are forgotten.
function pruneSeats(room) {
  const ids = new Set(room.state.players.map((p) => p.id));
  for (const [playerId, ws] of room.sockets) {
    if (ids.has(playerId)) continue;
    room.sockets.delete(playerId);
    ws.session = { room, playerId: null };
    room.spectators.add(ws);
  }
  for (const playerId of room.secrets.keys()) {
    if (!ids.has(playerId)) room.secrets.delete(playerId);
  }
}

function logNotableEvents(room, events) {
  for (const e of events) {
    if (e.type === 'game_started') log(`${room.id}: game started with ${e.order?.length ?? '?'} players`);
    else if (e.type === 'player_left') log(`${room.id}: ${e.playerId} left the lobby`);
    else if (e.type === 'bankrupt') log(`${room.id}: ${playerLabel(room, e.playerId)} went bankrupt`);
    else if (e.type === 'timeout') log(`${room.id}: turn timeout for ${playerLabel(room, e.playerId)} in ${e.phase}`);
  }
}

// Adopt a successful engine result: timers, broadcast, persistence.
function commit(room, result, { forceTimer = false } = {}) {
  room.state = result.state;
  room.state.updatedAt = Date.now();
  pruneSeats(room);
  reconcileTimer(room, { force: forceTimer });
  broadcast(room, result.events);
  logNotableEvents(room, result.events);
  if (room.state.status === 'finished') finishRoom(room);
  else applySavePolicy(room, result.events);
}

// Game over: save, move the file to finished/, keep the room around briefly so clients see the end.
function finishRoom(room) {
  if (room.finishing) return room.finishing;
  const winner = room.state.winnerId ? playerLabel(room, room.state.winnerId) : 'nobody';
  log(`${room.id}: game over, winner ${winner}`);
  cancelScheduledSave(room);
  room.dirty = true;
  room.finishing = (async () => {
    await saveRoom(room);
    try {
      await archiveGame(room.id);
    } catch (err) {
      logError(`archiving ${room.id} failed (will retry at next startup): ${err.message}`);
    } finally {
      room.archived = true;
    }
    if (!room.deleted) room.dropTimer = setTimeout(() => dropRoom(room), FINISHED_LINGER_MS);
  })();
  return room.finishing;
}

// Called by timers.js when the deadline passes. Returns null on success or an error object.
function applyTimeout(room) {
  if (shuttingDown) return null;
  const playerId = currentPlayerId(room.state);
  const result = applyAction(room.state, { type: 'TIMEOUT', playerId });
  if (result.error) return result.error;
  commit(room, result, { forceTimer: true });
  return null;
}
setExpireHandler(applyTimeout);

function setConnected(room, playerId, connected) {
  const player = findPlayer(room.state, playerId);
  if (!player || player.connected === connected) return false;
  player.connected = connected;
  onConnectionChange(room, playerId, connected);
  broadcast(room, [{ type: 'connection', playerId, connected }]);
  log(`${room.id}: ${playerLabel(room, playerId)} ${connected ? 'connected' : 'disconnected'}`);
  return true;
}

// ---------------------------------------------------------------------------
// Sockets

// Bind `ws` to a seat, kicking out any other socket that holds it, and send `welcome`.
function bindSocket(room, ws, playerId) {
  const old = room.sockets.get(playerId);
  if (old && old !== ws) {
    old.session = { room: null, playerId: null }; // its close event must not mark the seat disconnected
    sendError(old, 'REPLACED', 'This seat was opened in another tab or window');
    old.close(4000, 'Replaced');
  }
  room.spectators.delete(ws);
  room.sockets.set(playerId, ws);
  ws.session = { room, playerId };
  updateEmptySince(room);
  send(ws, { t: 'welcome', gameId: room.id, playerId, token: room.secrets.get(playerId) });
}

// Leave whatever room the socket is in.
function detach(ws) {
  const { room, playerId } = ws.session ?? {};
  ws.session = { room: null, playerId: null };
  if (!room) return;
  if (playerId && room.sockets.get(playerId) === ws) {
    room.sockets.delete(playerId);
    if (!shuttingDown && !room.deleted) setConnected(room, playerId, false);
  } else {
    room.spectators.delete(ws);
  }
  updateEmptySince(room);
}

function handleHello(ws, msg) {
  const gameId = normalizeGameId(msg.gameId);
  const room = gameId ? rooms.get(gameId) : null;
  if (!room || room.deleted) return sendError(ws, 'NO_GAME', 'Game not found');

  detach(ws);
  const { playerId, token } = msg;
  if (typeof playerId === 'string' && tokensMatch(room.secrets.get(playerId), token) && findPlayer(room.state, playerId)) {
    bindSocket(room, ws, playerId);
    // Seat was offline → everyone hears about it; seat was taken over from another tab → only this socket needs state.
    if (!setConnected(room, playerId, true)) sendState(room, ws);
    return;
  }

  if (token) sendError(ws, 'BAD_TOKEN', 'Seat credentials not recognised; watching as a spectator');
  ws.session = { room, playerId: null };
  room.spectators.add(ws);
  updateEmptySince(room);
  sendState(room, ws);
}

function sendEngineError(ws, room, error) {
  if (error.code === 'INTERNAL') logError(`engine error in ${room.id}: ${error.message}`);
  sendError(ws, error.code ?? 'ERROR', error.message ?? 'Action failed');
}

function handleJoin(room, ws, action) {
  const playerId = newPlayerId(room);
  const result = applyAction(room.state, { ...action, playerId });
  if (result.error) return sendEngineError(ws, room, result.error);

  const joined = findPlayer(result.state, playerId);
  if (joined) joined.connected = true; // the engine should already do this; the socket is live either way
  room.secrets.set(playerId, crypto.randomBytes(16).toString('hex'));
  bindSocket(room, ws, playerId); // welcome first, so the client knows its seat when the state arrives
  commit(room, result);
  log(`${room.id}: ${playerLabel(room, playerId)} joined`);
}

function handleAction(ws, action) {
  const { room, playerId } = ws.session;
  if (!room || room.deleted) return sendError(ws, 'NO_GAME', 'Send hello with a gameId first');
  if (!isPlainObject(action) || typeof action.type !== 'string' || !action.type || action.type.length > MAX_ACTION_TYPE_LENGTH) {
    return sendError(ws, 'BAD_MESSAGE', 'Expected { t: "action", action: { type, ...payload } }');
  }
  if (action.type === 'TIMEOUT') return sendError(ws, 'FORBIDDEN', 'TIMEOUT is a server-only action');

  if (!playerId) {
    if (action.type !== 'JOIN') return sendError(ws, 'NOT_SEATED', 'Join the game first');
    return handleJoin(room, ws, action);
  }

  // The seat decides who acts; any client-supplied playerId is overwritten.
  const result = applyAction(room.state, { ...action, playerId });
  if (result.error) return sendEngineError(ws, room, result.error);
  commit(room, result);
}

function handleMessage(ws, data, isBinary) {
  if (shuttingDown) return sendError(ws, 'SHUTTING_DOWN', 'Server is restarting, reconnect shortly');
  if (isBinary) return sendError(ws, 'BAD_MESSAGE', 'Binary messages are not supported');

  let msg;
  try {
    msg = JSON.parse(data.toString('utf8'));
  } catch {
    return sendError(ws, 'BAD_JSON', 'Message is not valid JSON');
  }
  if (!isPlainObject(msg) || typeof msg.t !== 'string') {
    return sendError(ws, 'BAD_MESSAGE', 'Expected an object with a string "t"');
  }

  switch (msg.t) {
    case 'hello':
      return handleHello(ws, msg);
    case 'action':
      return handleAction(ws, msg.action);
    case 'ping':
      return send(ws, { t: 'pong' });
    default:
      return sendError(ws, 'BAD_MESSAGE', `Unknown message type "${msg.t.slice(0, 20)}"`);
  }
}

/** Wire up a freshly upgraded WebSocket. */
export function attachSocket(ws) {
  ws.session = { room: null, playerId: null };
  ws.on('message', (data, isBinary) => {
    try {
      handleMessage(ws, data, isBinary);
    } catch (err) {
      logError('message handling failed:', err);
      sendError(ws, 'INTERNAL', 'Internal server error');
    }
  });
  ws.on('close', () => {
    try {
      detach(ws);
    } catch (err) {
      logError('close handling failed:', err);
    }
  });
  ws.on('error', (err) => console.warn(`[ws] socket error: ${err.message}`));
}

// ---------------------------------------------------------------------------
// Shutdown

/** Stop timers and maintenance, and refuse further messages. */
export function beginShutdown() {
  shuttingDown = true;
  clearInterval(cleanupHandle);
  cleanupHandle = null;
  for (const room of rooms.values()) clearTimer(room);
}

/** Write every dirty game (and finish any in-progress game-over archiving). */
export async function flushAll() {
  const jobs = [];
  let dirty = 0;
  for (const room of rooms.values()) {
    cancelScheduledSave(room);
    if (room.dirty) dirty++;
    jobs.push(room.finishing ?? saveRoom(room));
  }
  await Promise.all(jobs);
  log(`flushed ${dirty} unsaved game(s)`);
}
