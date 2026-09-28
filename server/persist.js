// Atomic JSON persistence for games.
//
// Layout under DATA_DIR:
//   games/<id>.json     live games (lobby + active): { version: 1, state, secrets: { playerId: token } }
//   finished/<id>.json  games that reached game over
//   corrupt/            unreadable files moved aside at startup
//
// The save policy works on the room objects owned by rooms.js and only touches these fields:
//   id, state, secrets (Map), dirty, saveTimer, saving (promise chain), archived, deleted.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const GAME_ID_RE = /^g_[abcdefghjkmnpqrstuvwxyz23456789]{6}$/;

const FILE_VERSION = 1;
const DEBOUNCE_MS = 5_000;

const dirs = { root: null, games: null, finished: null, corrupt: null };

export function isValidGameId(id) {
  return typeof id === 'string' && GAME_ID_RE.test(id);
}

/** Resolve DATA_DIR and make sure the sub-directories exist. Call once at startup. */
export async function initPersist(dataDir) {
  dirs.root = path.resolve(dataDir);
  dirs.games = path.join(dirs.root, 'games');
  dirs.finished = path.join(dirs.root, 'finished');
  dirs.corrupt = path.join(dirs.root, 'corrupt');
  for (const dir of [dirs.games, dirs.finished, dirs.corrupt]) {
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

/** Delete a live game's file (and any leftover temp file). Missing files are fine. */
export async function deleteGame(id) {
  const file = gameFile(dirs.games, id);
  for (const target of [file, `${file}.tmp`]) {
    await fsp.rm(target, { force: true });
  }
}

function looksLikeSave(data, id) {
  const state = data?.state;
  return (
    data?.version === FILE_VERSION &&
    state && typeof state === 'object' &&
    state.id === id &&
    typeof state.status === 'string' &&
    Array.isArray(state.players) &&
    state.turn && typeof state.turn === 'object' &&
    state.settings && typeof state.settings === 'object' &&
    (data.secrets == null || typeof data.secrets === 'object')
  );
}

async function moveToCorrupt(name) {
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
 * the latest. The returned promise never rejects: a failed save marks the room dirty again and
 * retries on the debounce.
 */
export function saveRoom(room) {
  const run = async () => {
    if (!room.dirty || room.archived || room.deleted) return;
    room.dirty = false;
    try {
      await writeGame(room.id, room.state, room.secrets);
    } catch (err) {
      console.error(`[persist] saving ${room.id} failed: ${err.message}`);
      room.dirty = true;
      scheduleSave(room);
    }
  };
  room.saving = (room.saving ?? Promise.resolve()).then(run);
  return room.saving;
}

/** Save at most DEBOUNCE_MS after the first unsaved change (the timer is not pushed back by later changes). */
export function scheduleSave(room) {
  if (room.saveTimer || room.archived || room.deleted) return;
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

/** Called after every successful change: save right away at the end of a turn / game, else debounce. */
export function applySavePolicy(room, events = []) {
  room.dirty = true;
  const immediate = events.some((e) => e?.type === 'turn_ended' || e?.type === 'game_over');
  if (immediate) {
    cancelScheduledSave(room);
    return saveRoom(room);
  }
  scheduleSave(room);
  return room.saving ?? Promise.resolve();
}
