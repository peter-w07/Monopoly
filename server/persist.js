// Atomic JSON persistence for games.
//
// Layout under DATA_DIR:
//   games/<id>.json      live games (lobby + active): { version: 1, state, secrets: { playerId: token } }
//   finished/<id>.json   games that reached game over
//   abandoned/<id>.json  active games nobody played for days (moved out of memory; never restored)
//   corrupt/             unreadable files moved aside at startup
//   instance.lock        { hostname, pid, startedAt } of the running server (one server per DATA_DIR)
//
// The save policy works on the room objects owned by rooms.js and only touches these fields:
//   id, state, secrets (Map), dirty, saveTimer, saving (promise chain), archived, deleted.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const GAME_ID_RE = /^g_[abcdefghjkmnpqrstuvwxyz23456789]{6}$/;

const FILE_VERSION = 1;
const DEBOUNCE_MS = 5_000;
const LOCK_FILE = 'instance.lock';
const LOCK_STALE_MS = 30_000;
const LOCK_REFRESH_MS = 10_000;
// Events after which the game is saved at once instead of on the debounce: turn ends, the end of
// the game, and seat changes (a lost JOIN would make the player's stored token worthless).
const SAVE_NOW_EVENTS = new Set(['turn_ended', 'game_over', 'player_joined', 'player_left', 'game_started']);

const dirs = { root: null, games: null, finished: null, abandoned: null, corrupt: null };
let stopping = false; // shutdown: failed saves are not retried on a timer (rooms.flushAll retries)

export function isValidGameId(id) {
  return typeof id === 'string' && GAME_ID_RE.test(id);
}

/** Resolve DATA_DIR and make sure the sub-directories exist. Call once at startup. */
export async function initPersist(dataDir) {
  dirs.root = path.resolve(dataDir);
  dirs.games = path.join(dirs.root, 'games');
  dirs.finished = path.join(dirs.root, 'finished');
  dirs.abandoned = path.join(dirs.root, 'abandoned');
  dirs.corrupt = path.join(dirs.root, 'corrupt');
  for (const dir of [dirs.games, dirs.finished, dirs.abandoned, dirs.corrupt]) {
    await fsp.mkdir(dir, { recursive: true });
  }
  return dirs.root;
}

// Every filesystem path built from a game id goes through here, so ids are always validated first.
function gameFile(dir, id) {
  if (!isValidGameId(id)) throw new Error(`invalid game id: ${JSON.stringify(id)}`);
  if (!dir) throw new Error('persistence not initialised (call initPersist first)');
  return path.join(dir, `${id}.json`);
}

/** True if an id is already used on disk (live or finished) — avoids reusing ids of old games. */
export function gameIdTaken(id) {
  return fs.existsSync(gameFile(dirs.games, id)) || fs.existsSync(gameFile(dirs.finished, id));
}

// ---------------------------------------------------------------------------
// Low-level file operations

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Windows can briefly refuse a rename while another process (antivirus, indexer) holds the target open.
async function renameWithRetry(from, to, attempts = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fsp.rename(from, to);
    } catch (err) {
      if (attempt >= attempts || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      await sleep(50 * attempt);
    }
  }
}

/** Write <file>.tmp, fsync it, then rename it over <file>. Readers never see a half-written file. */
async function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await renameWithRetry(tmp, file);
}

/** Save one game snapshot atomically. `secrets` is a Map<playerId, token>. */
export async function writeGame(id, state, secrets) {
  const data = JSON.stringify({ version: FILE_VERSION, state, secrets: Object.fromEntries(secrets) });
  await writeFileAtomic(gameFile(dirs.games, id), data);
}

/** Move games/<id>.json to finished/<id>.json. */
export async function archiveGame(id) {
  await renameWithRetry(gameFile(dirs.games, id), gameFile(dirs.finished, id));
}

/**
 * Move an abandoned game to abandoned/<id>.json. The room has already left memory (room.deleted),
 * so its latest state is written here first if it has unsaved changes.
 */
export async function abandonGame(room) {
  await room.saving; // let an in-flight write finish
  if (room.dirty) {
    await writeGame(room.id, room.state, room.secrets);
    room.dirty = false;
  }
  await renameWithRetry(gameFile(dirs.games, room.id), gameFile(dirs.abandoned, room.id));
}

/** Delete a live game's file (and any leftover temp file). Missing files are fine. */
export async function deleteGame(id) {
  const file = gameFile(dirs.games, id);
  for (const target of [file, `${file}.tmp`]) {
    await fsp.rm(target, { force: true });
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function looksLikeSave(data, id) {
  const state = data?.state;
  return (
    data?.version === FILE_VERSION &&
    isObject(state) &&
    state.id === id &&
    typeof state.status === 'string' &&
    Array.isArray(state.players) &&
    state.players.every((p) => isObject(p) && typeof p.id === 'string') &&
    isObject(state.turn) &&
    Array.isArray(state.turn.order) &&
    Array.isArray(state.tiles) &&
    isObject(state.settings) &&
    (data.secrets == null || typeof data.secrets === 'object')
  );
}

/** Move games/<name> aside to corrupt/<name>.<timestamp> (never throws). */
export async function moveToCorrupt(name) {
  const target = path.join(dirs.corrupt, `${name}.${Date.now()}`);
  try {
    await renameWithRetry(path.join(dirs.games, name), target);
    console.error(`[persist] moved ${name} to ${target}`);
  } catch (err) {
    console.error(`[persist] could not move corrupt file ${name}: ${err.message}`);
  }
}

/**
 * Read every games/*.json. Returns [{ state, secrets }]. Temp files are skipped; unreadable or
 * malformed files are logged and moved to corrupt/ so they don't block startup.
 */
export async function loadAll() {
  const names = await fsp.readdir(dirs.games);
  const games = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue; // skips *.json.tmp and anything else
    const id = name.slice(0, -'.json'.length);
    if (!isValidGameId(id)) {
      console.warn(`[persist] skipping unexpected file games/${name}`);
      continue;
    }
    try {
      const data = JSON.parse(await fsp.readFile(gameFile(dirs.games, id), 'utf8'));
      if (!looksLikeSave(data, id)) throw new Error('unexpected file shape');
      games.push({ state: data.state, secrets: data.secrets ?? {} });
    } catch (err) {
      console.error(`[persist] corrupt save games/${name}: ${err.message}`);
      await moveToCorrupt(name);
    }
  }
  return games;
}

// ---------------------------------------------------------------------------
// Save policy

/**
 * Save the room now if it is dirty. Saves of one room are chained so two writes never race on
 * the same temp file; the state is serialised when the write actually starts, so it is always
 * the latest. The returned promise never rejects: it resolves true when this call wrote the file,
 * false when the write failed (the room is marked dirty again and, unless the server is shutting
 * down, retried on the debounce), and undefined when there was nothing to save.
 */
export function saveRoom(room) {
  const run = async () => {
    if (!room.dirty || room.archived || room.deleted) return undefined;
    room.dirty = false;
    try {
      await writeGame(room.id, room.state, room.secrets);
      return true;
    } catch (err) {
      console.error(`[persist] saving ${room.id} failed: ${err.message}`);
      room.dirty = true;
      scheduleSave(room);
      return false;
    }
  };
  room.saving = (room.saving ?? Promise.resolve()).then(run);
  return room.saving;
}

/** Save at most DEBOUNCE_MS after the first unsaved change (the timer is not pushed back by later changes). */
export function scheduleSave(room) {
  if (stopping || room.saveTimer || room.archived || room.deleted) return;
  room.saveTimer = setTimeout(() => {
    room.saveTimer = null;
    saveRoom(room);
  }, DEBOUNCE_MS);
}

export function cancelScheduledSave(room) {
  if (room.saveTimer) {
    clearTimeout(room.saveTimer);
    room.saveTimer = null;
  }
}

/** Shutdown has begun: from now on failed saves are not rescheduled (the caller retries them). */
export function stopSaveRetries() {
  stopping = true;
}

/** Called after every successful change: save right away after SAVE_NOW_EVENTS, else debounce. */
export function applySavePolicy(room, events = []) {
  room.dirty = true;
  if (events.some((e) => SAVE_NOW_EVENTS.has(e?.type))) {
    cancelScheduledSave(room);
    return saveRoom(room);
  }
  scheduleSave(room);
  return room.saving ?? Promise.resolve();
}

// ---------------------------------------------------------------------------
// Instance lock: one server per DATA_DIR
//
// Two servers on one DATA_DIR (e.g. a rolling update that starts the new container while the old
// one still runs) would each load the games and overwrite each other's saves. The running server
// keeps instance.lock's mtime fresh; a starting server refuses to run while the lock is fresh and
// belongs to another live process: a different host (container), or the same host and a different
// pid that is still alive. A lock left by a crash goes stale after LOCK_STALE_MS (or at once when
// its pid is gone on the same host).

let lock = null; // { file, owner, timer } while we hold it

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, but belongs to someone else
  }
}

/** The lock's owner if another live instance holds it, else null. */
async function currentHolder(file, me) {
  let stat;
  let owner;
  try {
    stat = await fsp.stat(file);
    owner = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[persist] ignoring unreadable ${LOCK_FILE}: ${err.message}`);
    return null;
  }
  if (!isObject(owner) || Date.now() - stat.mtimeMs >= LOCK_STALE_MS) return null;
  if (owner.hostname !== me.hostname) return owner;
  return owner.pid !== me.pid && pidAlive(owner.pid) ? owner : null;
}

/**
 * Take DATA_DIR/instance.lock. Returns null on success (the lock is refreshed every
 * LOCK_REFRESH_MS until releaseInstanceLock), or the { hostname, pid, startedAt } of the other
 * live instance that holds it.
 */
export async function acquireInstanceLock() {
  const file = path.join(dirs.root, LOCK_FILE);
  const me = { hostname: os.hostname(), pid: process.pid, startedAt: new Date().toISOString() };
  const holder = await currentHolder(file, me);
  if (holder) return holder;
  await fsp.writeFile(file, JSON.stringify(me));
  const timer = setInterval(() => {
    const now = new Date();
    fsp.utimes(file, now, now).catch((err) => {
      if (err.code === 'ENOENT') return fsp.writeFile(file, JSON.stringify(me));
      throw err;
    }).catch((err) => console.warn(`[persist] refreshing ${LOCK_FILE} failed: ${err.message}`));
  }, LOCK_REFRESH_MS);
  timer.unref();
  lock = { file, owner: me, timer };
  return null;
}

/** Stop refreshing the lock and delete it if it is still ours. Synchronous, so it can run right before exit. */
export function releaseInstanceLock() {
  if (!lock) return;
  const { file, owner, timer } = lock;
  lock = null;
  clearInterval(timer);
  try {
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (onDisk.hostname === owner.hostname && onDisk.pid === owner.pid) fs.rmSync(file, { force: true });
  } catch {
    // already gone or unreadable: nothing to release
  }
}
