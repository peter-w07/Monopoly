// Turn timers and AFK handling: one timer per room, driving state.turn.deadlineAt.
//
// room.timer = { key, handle, retries, turnDeadline }
//   key          `${status}|${turn.number}|${currentPlayerId}|${phase}|${rollAgain}|${doublesCount}` the
//                deadline belongs to (doublesCount: every doubles roll that lands with nothing pending
//                leaves phase end_turn + rollAgain unchanged, but still earns a fresh deadline)
//   handle       the pending setTimeout (expiry or retry)
//   retries      failed TIMEOUT attempts for the current key
//   turnDeadline the full-length deadline for this key (restored if an AFK player comes back)
//
// Rules:
// - When the key changes, the deadline restarts: turnTimeoutSec, or 45s if the current player is
//   disconnected. No timer unless the game is active, turnTimeoutSec > 0 and a player is connected.
// - Current player disconnects: deadline = min(existing, now + 45s) — long enough for a phone that
//   switched apps or networks to come back. All players gone: pause.
//   Someone reconnects to a paused game: fresh deadline.
// - On expiry the registered handler applies TIMEOUT. If that errors: retry every 5s, 3 times max.

import { currentPlayerId } from '../engine/index.js';

export const AFK_MS = 45_000;
const RETRY_MS = 5_000;
const MAX_RETRIES = 3;

let expireHandler = () => ({ code: 'NO_HANDLER', message: 'no timeout handler registered' });

/**
 * Register the function that applies TIMEOUT for a room. It must return null on success (having
 * already called reconcileTimer(room, { force: true })) or an error object { code, message }.
 */
export function setExpireHandler(fn) {
  expireHandler = fn;
}

export function newTimerState() {
  return { key: null, handle: null, retries: 0, turnDeadline: null };
}

function turnKey(state) {
  const { turn } = state;
  return `${state.status}|${turn.number}|${currentPlayerId(state)}|${turn.phase}|${turn.rollAgain}|${turn.doublesCount}`;
}

const timeoutMs = (state) => (Number(state.settings?.turnTimeoutSec) || 0) * 1000;
const anyConnected = (state) => state.players.some((p) => p.connected);
const timersEnabled = (state) => state.status === 'active' && timeoutMs(state) > 0;

/** Stop the pending timeout (does not touch state). */
export function clearTimer(room) {
  if (room.timer.handle) {
    clearTimeout(room.timer.handle);
    room.timer.handle = null;
  }
}

function stop(room) {
  clearTimer(room);
  room.timer.turnDeadline = null;
  room.state.turn.deadlineAt = null;
}

function setDeadline(room, at) {
  clearTimer(room);
  room.state.turn.deadlineAt = at;
  room.timer.handle = setTimeout(() => expire(room), Math.max(0, at - Date.now()));
}

// Start a fresh deadline for the current turn state (or clear it if no timer should run).
function armFresh(room) {
  const { state, timer } = room;
  if (!timersEnabled(state) || !anyConnected(state)) return stop(room);
  const now = Date.now();
  timer.turnDeadline = now + timeoutMs(state);
  const current = state.players.find((p) => p.id === currentPlayerId(state));
  const afk = !current?.connected;
  setDeadline(room, afk ? Math.min(timer.turnDeadline, now + AFK_MS) : timer.turnDeadline);
}

/**
 * Call after every state change (before broadcasting, so the new deadlineAt goes out with it).
 * Restarts the deadline when the turn key changed; `force` restarts it regardless (after a TIMEOUT,
 * which may leave the key unchanged, e.g. an auto-roll of doubles).
 */
export function reconcileTimer(room, { force = false } = {}) {
  const key = turnKey(room.state);
  if (!force && key === room.timer.key) return;
  room.timer.key = key;
  room.timer.retries = 0;
  armFresh(room);
}

/** Call after a player's connected flag changed (before broadcasting). */
export function onConnectionChange(room, playerId, connected) {
  const { state, timer } = room;
  if (!timersEnabled(state)) return;

  if (!anyConnected(state)) {
    if (state.turn.deadlineAt != null) console.log(`[timers] ${room.id}: everyone left, turn timer paused`);
    return stop(room);
  }
  if (state.turn.deadlineAt == null) {
    // Paused (or gave up after failed retries): someone is back, start over.
    timer.retries = 0;
    return armFresh(room);
  }
  if (playerId !== currentPlayerId(state)) return;

  if (!connected) {
    setDeadline(room, Math.min(state.turn.deadlineAt, Date.now() + AFK_MS));
  } else if (timer.turnDeadline != null && timer.turnDeadline > state.turn.deadlineAt) {
    // The current player came back before the AFK deadline: give back the rest of their turn time.
    setDeadline(room, timer.turnDeadline);
  }
}

function expire(room) {
  const { timer } = room;
  timer.handle = null;
  if (room.deleted || room.state.status !== 'active') return;

  let error;
  try {
    error = expireHandler(room);
  } catch (err) {
    error = { code: 'INTERNAL', message: err?.message ?? String(err) };
  }
  if (!error) return;

  if (timer.retries >= MAX_RETRIES) {
    console.error(`[timers] ${room.id}: TIMEOUT failed (${error.code}: ${error.message}); giving up until the turn changes`);
    room.state.turn.deadlineAt = null;
    return;
  }
  timer.retries += 1;
  console.error(
    `[timers] ${room.id}: TIMEOUT failed (${error.code}: ${error.message}); retry ${timer.retries}/${MAX_RETRIES} in ${RETRY_MS / 1000}s`,
  );
  timer.handle = setTimeout(() => expire(room), RETRY_MS);
}
