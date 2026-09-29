// In-memory game registry, player sessions (seats) and broadcast.
//
// room = {
//   id, state,                     authoritative engine state (full, private: includes rng + decks)
//   sockets: Map<playerId, ws>,    one socket per seat (= the connected seated players)
//   spectators: Set<ws>,           sockets without a seat
//   secrets: Map<playerId, token>, seat tokens (never sent to anyone but the seat owner)
//   dirty, saveTimer, saving,      save policy (persist.js)
//   timer,                         turn timer (timers.js)
//   lastActiveAt,                  idle clock: kept at "now" while a seated player is connected, else the
//                                  time the last one left. Spectators never keep a room alive.
//   graceUntil,                    restored rooms: no idle cleanup / eviction before this (players reconnecting)
//   auctionSince,                  state.seq at which the running auction started (seq check for bids)
//   finishing, archived, deleted, dropTimer   game-over / removal bookkeeping
// }
// Each socket carries ws.session = { room, playerId } (room null until hello, playerId null for spectators)
// and some bookkeeping: ws.ip, ws.budget (message rate), ws.helloed, ws.helloTimer, ws.lastHelloAt,
// ws.createdSeats (Map<roomId, playerId> of seats this socket JOINed), ws.replaced (seat taken by another socket).
//
// Room lifecycle (maintenance pass every minute):
// - lobby with no connected seated player for 30 min (0-player lobbies included) → deleted (memory + file)
// - active game with no connected player for 7 days → moved to DATA_DIR/abandoned/, dropped from memory
// - finished game → file moved to finished/, room dropped a minute later
// - at MAX_ROOMS, creating a game evicts the longest-idle room with no connected seated player that has
//   been idle ≥ 1 h (0-player lobbies: ≥ 1 min) — deleted if a lobby, archived if active — before refusing.

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
  stopSaveRetries,
  applySavePolicy,
  archiveGame,
  abandonGame,
  deleteGame,
  moveToCorrupt,
} from './persist.js';
import { newTimerState, reconcileTimer, onConnectionChange, clearTimer, setExpireHandler } from './timers.js';
import { LIMITS, newMessageBudget, checkMessage } from './limits.js';

const MAX_ROOMS = 1000;
const LOBBY_IDLE_MS = 30 * 60_000;
const ABANDONED_MS = 7 * 24 * 60 * 60_000;
const EVICT_IDLE_MS = 60 * 60_000;
const EVICT_EMPTY_LOBBY_MS = 60_000;
const STARTUP_GRACE_MS = 5 * 60_000;
const FINISHED_LINGER_MS = 60_000;
const MAINTENANCE_INTERVAL_MS = 60_000;
const FLUSH_RETRIES = 2;
const FLUSH_RETRY_MS = 200;
const KICK_TERMINATE_MS = 5000; // a kicked socket that doesn't finish the close handshake is cut off
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const MAX_ACTION_TYPE_LENGTH = 40;

const rooms = new Map();
const background = new Set(); // file moves/deletes of rooms that already left memory (awaited by flushAll)
let shuttingDown = false;
let maintenanceHandle = null;
let lastCapacityLogAt = -Infinity;

const log = (...args) => console.log('[rooms]', ...args);
const logError = (...args) => console.error('[rooms]', ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
const playerLabel = (room, playerId) => `${findPlayer(room.state, playerId)?.name ?? '?'} (${playerId})`;
const hasSeatedPlayer = (room) => room.sockets.size > 0;

function makeRoom(state, secrets = new Map(), { lastActiveAt = Date.now(), graceUntil = 0 } = {}) {
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
    lastActiveAt,
    graceUntil,
    auctionSince: state.auction ? state.seq : null, // restored mid-auction: only seqs from now on count
    finishing: null,
    archived: false,
    deleted: false,
    dropTimer: null,
  };
}

/** Run a job for a room that already left memory; flushAll waits for it at shutdown. */
function track(job) {
  background.add(job);
  job.finally(() => background.delete(job));
}

// ---------------------------------------------------------------------------
// Sending

const OPEN = 1; // WebSocket.OPEN

function sendRaw(ws, text) {
  if (ws.readyState !== OPEN) return;
  // A client that stops reading makes its send buffer grow without bound: cut it off instead.
  if (LIMITS.sendBufferBytes > 0 && ws.bufferedAmount > LIMITS.sendBufferBytes) {
    console.warn(`[ws] terminating a slow consumer (${ws.ip ?? '?'}): ${Math.round(ws.bufferedAmount / 1024)} KiB unsent`);
    ws.terminate();
    return;
  }
  ws.send(text, (err) => {
    if (err && !ws.sendFailed) {
      ws.sendFailed = true; // once per socket: a dying socket fails every queued frame
      console.warn(`[ws] send failed: ${err.message}`);
    }
  });
}

const send = (ws, msg) => sendRaw(ws, JSON.stringify(msg));
const sendError = (ws, code, message) => send(ws, { t: 'error', code, message });

/** Close with `code`; if the peer doesn't answer the close handshake (e.g. it stopped reading), cut it off. */
function closeSocket(ws, code, reason) {
  if (ws.readyState !== OPEN) return;
  ws.close(code, reason);
  setTimeout(() => ws.terminate(), KICK_TERMINATE_MS).unref();
}

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
    return { actions: [], build: [], sellHouse: [], mortgage: [], unmortgage: [], auction: null, tradeTargets: [] };
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

/** Create a lobby. Returns the room, or null when shutting down or at capacity with nothing to evict. */
export function createRoom(settings = {}) {
  if (shuttingDown) return null;
  if (rooms.size >= MAX_ROOMS && !evictIdlest()) return null;
  const id = newGameId();
  const seed = crypto.randomBytes(4).readUInt32BE(0);
  const state = createGame({ id, seed, settings: normalizeSettings(isPlainObject(settings) ? settings : {}) });
  const now = Date.now();
  state.createdAt = now;
  state.updatedAt = now;

  const room = makeRoom(state, new Map(), { lastActiveAt: now });
  rooms.set(id, room);
  reconcileTimer(room);
  room.dirty = true;
  scheduleSave(room);
  log(`created ${id}`);
  return room;
}

/** Open lobbies for the home screen: joinable, with at least one player connected to start it. */
export function listOpenLobbies() {
  const games = [];
  for (const room of rooms.values()) {
    const { state } = room;
    if (state.status !== 'lobby' || state.players.length === 0 || state.players.length >= state.settings.maxPlayers) continue;
    if (!hasSeatedPlayer(room)) continue;
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

// A restored room's idle clock continues from its last change (never from the future).
function restoredIdleClock(state, now) {
  const at = [state.updatedAt, state.createdAt].find((t) => Number.isFinite(t)) ?? now;
  return Math.min(at, now);
}

/** Restore every saved game at startup. A save that can't be restored is moved to corrupt/. */
export async function loadRooms() {
  const saved = await loadAll();
  const now = Date.now();
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
    let room = null;
    try {
      for (const p of state.players) p.connected = false;
      state.turn.deadlineAt = null;
      const secretMap = new Map(
        Object.entries(secrets).filter(([pid, token]) => typeof token === 'string' && findPlayer(state, pid)),
      );
      room = makeRoom(state, secretMap, { lastActiveAt: restoredIdleClock(state, now), graceUntil: now + STARTUP_GRACE_MS });
      rooms.set(room.id, room);
      reconcileTimer(room); // nobody is connected yet, so this stays paused until someone returns
      restored++;
    } catch (err) {
      logError(`could not restore ${state.id} (${err.message}); moving it to corrupt/`);
      if (room) {
        clearTimer(room);
        if (rooms.get(room.id) === room) rooms.delete(room.id);
      }
      await moveToCorrupt(`${state.id}.json`);
    }
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

// Idle lobby: gone from memory at once, file deleted in the background.
function removeLobby(room, why) {
  if (room.deleted) return;
  log(`removing lobby ${room.id} (${why})`);
  track(dropRoom(room, { deleteFile: true }).catch((err) => logError(`removing ${room.id} failed: ${err.message}`)));
}

// Abandoned active game: gone from memory at once, file moved to abandoned/ in the background.
function archiveAbandoned(room, why) {
  if (room.deleted) return;
  log(`${room.id}: ${why}; moving it to abandoned/`);
  const dropped = dropRoom(room); // synchronous part: the room leaves memory now
  track(
    dropped
      .then(() => abandonGame(room))
      .catch((err) => logError(`archiving abandoned game ${room.id} failed: ${err.message}`)),
  );
}

const minutes = (ms) => Math.round(ms / 60_000);

/** One maintenance pass: delete idle lobbies, archive abandoned games. */
function runMaintenance(now = Date.now()) {
  for (const room of [...rooms.values()]) {
    if (room.deleted || room.finishing) continue;
    if (hasSeatedPlayer(room)) {
      room.lastActiveAt = now;
      continue;
    }
    if (now < room.graceUntil) continue;
    const idle = now - room.lastActiveAt;
    if (room.state.status === 'lobby' && idle >= LOBBY_IDLE_MS) {
      removeLobby(room, `no player connected for ${minutes(idle)} min`);
    } else if (room.state.status === 'active' && idle >= ABANDONED_MS) {
      archiveAbandoned(room, `abandoned: no player connected for ${Math.floor(idle / 86_400_000)} days`);
    }
  }
}

// At capacity: remove the longest-idle room nobody is connected to (idle ≥ 1 h, 0-player lobbies ≥ 1 min).
function evictIdlest(now = Date.now()) {
  let victim = null;
  for (const room of rooms.values()) {
    const { status, players } = room.state;
    if (room.deleted || room.finishing || hasSeatedPlayer(room)) continue;
    if (status !== 'lobby' && status !== 'active') continue;
    const emptyLobby = status === 'lobby' && players.length === 0;
    if (!emptyLobby && now < room.graceUntil) continue;
    if (now - room.lastActiveAt < (emptyLobby ? EVICT_EMPTY_LOBBY_MS : EVICT_IDLE_MS)) continue;
    if (!victim || room.lastActiveAt < victim.lastActiveAt) victim = room;
  }
  if (!victim) {
    if (now - lastCapacityLogAt >= 60_000) {
      lastCapacityLogAt = now;
      logError(`at capacity (${rooms.size} games) and no idle game to evict; refusing new games`);
    }
    return false;
  }
  const why = `evicted to make room (idle ${minutes(now - victim.lastActiveAt)} min)`;
  if (victim.state.status === 'lobby') removeLobby(victim, why);
  else archiveAbandoned(victim, why);
  return true;
}

export function startMaintenance() {
  maintenanceHandle ??= setInterval(() => runMaintenance(), MAINTENANCE_INTERVAL_MS);
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
  room.lastActiveAt = room.state.updatedAt;
  if (result.events.some((e) => e.type === 'auction_started')) room.auctionSince = room.state.seq;
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

// The socket has joined a game (as a seat or a spectator): the hello deadline no longer applies.
function markHelloed(ws) {
  ws.helloed = true;
  clearTimeout(ws.helloTimer);
  ws.helloTimer = null;
}

// Bind `ws` to a seat, kicking out any other socket that holds it, and send `welcome`.
function bindSocket(room, ws, playerId) {
  const old = room.sockets.get(playerId);
  if (old && old !== ws) {
    old.session = { room: null, playerId: null }; // its close event must not mark the seat disconnected
    old.replaced = true; // and anything it still sends (e.g. a hello racing the close) is ignored
    sendError(old, 'REPLACED', 'This seat was opened in another tab or window');
    old.close(4000, 'Replaced');
  }
  room.spectators.delete(ws);
  room.sockets.set(playerId, ws);
  room.lastActiveAt = Date.now();
  ws.session = { room, playerId };
  markHelloed(ws);
  send(ws, { t: 'welcome', gameId: room.id, playerId, token: room.secrets.get(playerId) });
}

// Leave whatever room the socket is in.
function detach(ws) {
  const { room, playerId } = ws.session ?? {};
  ws.session = { room: null, playerId: null };
  if (!room) return;
  if (playerId && room.sockets.get(playerId) === ws) {
    room.sockets.delete(playerId);
    room.lastActiveAt = Date.now();
    if (!shuttingDown && !room.deleted) setConnected(room, playerId, false);
  } else {
    room.spectators.delete(ws);
  }
}

// At most one hello per LIMITS.helloIntervalMs per socket; extra ones are dropped (HELLO_RATE ≤ 1/s).
function helloAllowed(ws, now) {
  if (LIMITS.helloIntervalMs > 0 && now - (ws.lastHelloAt ?? -Infinity) < LIMITS.helloIntervalMs) {
    if (now - (ws.helloRateAt ?? -Infinity) >= 1000) {
      ws.helloRateAt = now;
      sendError(ws, 'HELLO_RATE', 'Too many hello messages on one connection; slow down');
    }
    return false;
  }
  ws.lastHelloAt = now;
  return true;
}

function handleHello(ws, msg) {
  if (!helloAllowed(ws, Date.now())) return;
  const gameId = normalizeGameId(msg.gameId);
  const room = gameId ? rooms.get(gameId) : null;
  if (!room || room.deleted) return sendError(ws, 'NO_GAME', 'Game not found');

  const { playerId, token } = msg;
  const seatOk =
    typeof playerId === 'string' && tokensMatch(room.secrets.get(playerId), token) && Boolean(findPlayer(room.state, playerId));

  // A re-hello for the seat (or spectator view) this socket already has: no detach + re-attach,
  // which would tell the whole table the player disconnected and reconnected. Just resend the state.
  const { session } = ws;
  if (session.room === room && (seatOk ? session.playerId === playerId : !session.playerId && !token)) {
    return sendState(room, ws);
  }

  detach(ws);
  if (seatOk) {
    bindSocket(room, ws, playerId);
    // Seat was offline → everyone hears about it; seat was taken over from another tab → only this socket needs state.
    if (!setConnected(room, playerId, true)) sendState(room, ws);
    return;
  }

  if (token) sendError(ws, 'BAD_TOKEN', 'Seat credentials not recognised; watching as a spectator');
  if (LIMITS.spectatorsPerRoom > 0 && room.spectators.size >= LIMITS.spectatorsPerRoom) {
    return sendError(ws, 'ROOM_BUSY', 'Too many people are watching this game right now; try again later');
  }
  ws.session = { room, playerId: null };
  room.spectators.add(ws);
  markHelloed(ws);
  sendState(room, ws);
}

// Bids race each other: every bid or pass moves state.seq, so an exact-seq check would turn most
// simultaneous bids into STALE_STATE. For these two, any seq from the running auction is current
// enough: the engine re-checks the amount against the high bid, and a repeated bid or pass can't
// apply twice (ALREADY_HIGH_BIDDER, BID_TOO_LOW, ALREADY_PASSED). A seq from before the auction
// started is still stale, so a late bid can never land in a later auction.
const AUCTION_ACTIONS = new Set(['BID', 'PASS_AUCTION']);

/** Is `seq` (the state.seq the client acted on; optional) too old for this action? */
function isStale(room, type, seq) {
  const { state, auctionSince } = room;
  if (typeof seq !== 'number' || seq === state.seq) return false;
  const fromThisAuction = Boolean(state.auction) && auctionSince !== null && seq >= auctionSince && seq < state.seq;
  return !(AUCTION_ACTIONS.has(type) && fromThisAuction);
}

function sendEngineError(ws, room, error) {
  if (error.code === 'INTERNAL') logError(`engine error in ${room.id}: ${error.message}`);
  sendError(ws, error.code ?? 'ERROR', error.message ?? 'Action failed');
}

function handleJoin(room, ws, action) {
  // One seat per connection: re-sending hello between JOINs must not let one socket fill the table.
  const earlier = ws.createdSeats?.get(room.id);
  if (earlier && findPlayer(room.state, earlier)) {
    return sendError(ws, 'ALREADY_SEATED', 'You already have a seat in this game');
  }
  const playerId = newPlayerId(room);
  const result = applyAction(room.state, { ...action, playerId });
  if (result.error) return sendEngineError(ws, room, result.error);

  const joined = findPlayer(result.state, playerId);
  if (joined) joined.connected = true; // the engine should already do this; the socket is live either way
  room.secrets.set(playerId, crypto.randomBytes(16).toString('hex'));
  (ws.createdSeats ??= new Map()).set(room.id, playerId);
  bindSocket(room, ws, playerId); // welcome first, so the client knows its seat when the state arrives
  commit(room, result);
  log(`${room.id}: ${playerLabel(room, playerId)} joined`);
}

function handleAction(ws, msg) {
  const { room, playerId } = ws.session;
  const { action } = msg;
  if (!room || room.deleted) return sendError(ws, 'NO_GAME', 'Send hello with a gameId first');
  if (!isPlainObject(action) || typeof action.type !== 'string' || !action.type || action.type.length > MAX_ACTION_TYPE_LENGTH) {
    return sendError(ws, 'BAD_MESSAGE', 'Expected { t: "action", seq?, action: { type, ...payload } }');
  }
  if (action.type === 'TIMEOUT') return sendError(ws, 'FORBIDDEN', 'TIMEOUT is a server-only action');
  // Optional seq = the state.seq the client acted on: a duplicate or late action is refused, not applied twice.
  if (isStale(room, action.type, msg.seq)) {
    return sendError(ws, 'STALE_STATE', 'The game moved on — try again');
  }

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
      return handleAction(ws, msg);
    case 'ping':
      return send(ws, { t: 'pong' });
    default:
      return sendError(ws, 'BAD_MESSAGE', `Unknown message type "${msg.t.slice(0, 20)}"`);
  }
}

// A socket over its message budget: drop the message, tell it (≤ 1/s), close it if it keeps flooding.
function overBudget(ws, verdict) {
  if (verdict === 'notify') sendError(ws, 'RATE_LIMITED', 'Too many messages; slow down');
  else if (verdict === 'close') {
    console.warn(`[ws] closing a flooding socket (${ws.ip ?? '?'})`);
    closeSocket(ws, 1008, 'Too many messages');
  }
}

/** Wire up a freshly upgraded WebSocket (index.js sets ws.ip first). */
export function attachSocket(ws) {
  ws.session = { room: null, playerId: null };
  ws.budget = newMessageBudget();
  if (LIMITS.helloTimeoutMs > 0) {
    ws.helloTimer = setTimeout(() => {
      if (!ws.helloed) closeSocket(ws, 1008, 'No hello');
    }, LIMITS.helloTimeoutMs);
  }
  ws.on('message', (data, isBinary) => {
    // Closing (kicked, rate-limited, replaced...) or kicked out of its seat: nothing it says counts any more.
    if (ws.readyState !== OPEN || ws.replaced) return;
    const verdict = checkMessage(ws.budget);
    if (verdict !== 'ok') return overBudget(ws, verdict);
    try {
      handleMessage(ws, data, isBinary);
    } catch (err) {
      logError('message handling failed:', err);
      sendError(ws, 'INTERNAL', 'Internal server error');
    }
  });
  ws.on('close', () => {
    clearTimeout(ws.helloTimer);
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

/** Stop timers and maintenance, and refuse further messages and new games. */
export function beginShutdown() {
  shuttingDown = true;
  stopSaveRetries();
  clearInterval(maintenanceHandle);
  maintenanceHandle = null;
  for (const room of rooms.values()) clearTimer(room);
}

const needsSave = (room) => room.dirty && !room.archived && !room.deleted;

/**
 * Write every dirty game (and finish game-over archiving and background file moves). Games whose
 * save fails are retried FLUSH_RETRIES times; if any still can't be saved this throws, naming them.
 */
export async function flushAll() {
  const jobs = [...background];
  for (const room of rooms.values()) {
    cancelScheduledSave(room);
    jobs.push(room.finishing ?? saveRoom(room));
  }
  let saved = (await Promise.all(jobs)).filter((r) => r === true).length;

  for (let retry = 1; retry <= FLUSH_RETRIES; retry++) {
    const unsaved = [...rooms.values()].filter(needsSave);
    if (unsaved.length === 0) break;
    await sleep(FLUSH_RETRY_MS);
    saved += (await Promise.all(unsaved.map((room) => saveRoom(room)))).filter((r) => r === true).length;
  }

  const failed = [...rooms.values()].filter(needsSave).map((room) => room.id);
  if (failed.length > 0) {
    logError(`FAILED to save: ${failed.join(', ')}`);
    throw new Error(`could not save ${failed.length} game(s): ${failed.join(', ')}`);
  }
  log(`flushed ${saved} game(s)`);
}
