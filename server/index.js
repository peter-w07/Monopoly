// HTTP + WebSocket bootstrap: JSON API, static files from /public, /ws, /health, graceful shutdown.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { BOARD } from '../engine/index.js';
import { initPersist } from './persist.js';
import * as rooms from './rooms.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = parsePort(process.env.PORT, 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');

const BODY_LIMIT = 16 * 1024;
const WS_MAX_PAYLOAD = 64 * 1024;
const HEARTBEAT_MS = 30_000;
const FORCE_EXIT_MS = 10_000;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

const BOARD_JSON = JSON.stringify(BOARD);
let shuttingDown = false;

function parsePort(value, fallback) {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : fallback;
}

// ---------------------------------------------------------------------------
// HTTP helpers

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function sendJson(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(text);
}

const notFound = (res) => sendJson(res, 404, { error: 'Not found' });
const methodNotAllowed = (res, allow) => sendJson(res, 405, { error: 'Method not allowed' }, { Allow: allow });

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/** Read a JSON request body (≤ BODY_LIMIT). Resolves undefined for an empty body. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > BODY_LIMIT) {
      return reject(httpError(413, 'Request body too large'));
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        tooLarge = true;
        return reject(httpError(413, 'Request body too large'));
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(httpError(400, 'Malformed JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Routes

async function createGameRoute(req, res) {
  let body;
  try {
    body = (await readJsonBody(req)) ?? {};
  } catch (err) {
    const headers = err.status === 413 ? { Connection: 'close' } : {};
    return sendJson(res, err.status ?? 400, { error: err.message }, headers);
  }
  if (!isPlainObject(body)) return sendJson(res, 400, { error: 'Body must be a JSON object' });
  const settings = body.settings ?? {};
  if (!isPlainObject(settings)) return sendJson(res, 400, { error: '"settings" must be an object' });

  const room = rooms.createRoom(settings);
  if (!room) return sendJson(res, 503, { error: 'Too many games on this server, try again later' });
  sendJson(res, 201, { gameId: room.id });
}

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return notFound(res);
  }
  if (rel.includes('\0')) return notFound(res);
  if (rel.endsWith('/')) rel += 'index.html';

  // Reject "..", hidden files, Windows drive/stream syntax and anything that resolves outside /public.
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  if (segments.some((s) => s.startsWith('.') || s.includes(':'))) return notFound(res);
  const filePath = path.resolve(PUBLIC_DIR, ...segments);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return notFound(res);

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return notFound(res);
  }
  if (!stat.isFile()) return notFound(res);

  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath)
    .on('error', (err) => {
      console.error(`[http] reading ${filePath} failed: ${err.message}`);
      res.destroy();
    })
    .pipe(res);
}

async function handleRequest(req, res) {
  const pathname = (req.url ?? '/').split('?', 1)[0];
  const { method } = req;
  const isGet = method === 'GET' || method === 'HEAD';

  if (pathname === '/health') {
    if (!isGet) return methodNotAllowed(res, 'GET, HEAD');
    return sendJson(res, 200, { ok: true, games: rooms.roomCount(), uptime: Math.round(process.uptime()) });
  }
  if (pathname === '/api/board') {
    if (!isGet) return methodNotAllowed(res, 'GET, HEAD');
    return sendJson(res, 200, BOARD_JSON, { 'Cache-Control': 'no-cache' });
  }
  if (pathname === '/api/games') {
    if (method === 'POST') return createGameRoute(req, res);
    if (!isGet) return methodNotAllowed(res, 'GET, HEAD, POST');
    return sendJson(res, 200, { games: rooms.listOpenLobbies() });
  }
  if (pathname.startsWith('/api/games/')) {
    if (!isGet) return methodNotAllowed(res, 'GET, HEAD');
    let rawId;
    try {
      rawId = decodeURIComponent(pathname.slice('/api/games/'.length));
    } catch {
      return notFound(res);
    }
    const room = rooms.getRoom(rawId);
    return room ? sendJson(res, 200, rooms.gameSummary(room)) : sendJson(res, 404, { error: 'Game not found' });
  }
  if (pathname === '/api' || pathname.startsWith('/api/')) return notFound(res);

  if (!isGet) return methodNotAllowed(res, 'GET, HEAD');
  return serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error(`[http] ${req.method} ${req.url} failed:`, err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
    else res.destroy();
  });
});

// ---------------------------------------------------------------------------
// WebSocket

const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
wss.on('error', (err) => console.error('[ws] server error:', err));

server.on('upgrade', (req, socket, head) => {
  const pathname = (req.url ?? '').split('?', 1)[0];
  if (pathname !== '/ws' || shuttingDown) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  rooms.attachSocket(ws);
});

// Ping every socket; terminate the ones that did not answer the previous ping.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }
}, HEARTBEAT_MS);

// ---------------------------------------------------------------------------
// Shutdown

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function closeAllSockets(code, reason) {
  const closed = [...wss.clients].map(
    (ws) =>
      new Promise((resolve) => {
        ws.once('close', resolve);
        ws.close(code, reason);
      }),
  );
  // Give clients a moment to receive the close frame, but don't wait on slow ones.
  return Promise.race([Promise.all(closed), sleep(1000)]);
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] shutting down (${reason})`);
  setTimeout(() => {
    console.error('[server] shutdown took too long, forcing exit');
    process.exit(1);
  }, FORCE_EXIT_MS).unref();

  clearInterval(heartbeat);
  server.close(() => {});
  server.closeIdleConnections?.();
  rooms.beginShutdown();

  let exitCode = 0;
  try {
    await rooms.flushAll();
  } catch (err) {
    console.error('[server] flushing games failed:', err);
    exitCode = 1;
  }
  await closeAllSockets(1012, 'Server restarting');
  console.log('[server] bye');
  process.exit(exitCode);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// Started with an IPC channel (tests, scripts): Windows has no real SIGTERM for child processes, so
// the parent can ask over IPC instead, and a server never outlives the parent that started it.
if (process.send) {
  process.on('message', (m) => m === 'shutdown' && shutdown('ipc'));
  process.on('disconnect', () => shutdown('parent process went away'));
}
process.on('unhandledRejection', (err) => console.error('[server] unhandled rejection:', err));

// ---------------------------------------------------------------------------
// Start

server.on('error', (err) => {
  console.error(`[server] ${err.code === 'EADDRINUSE' ? `port ${PORT} is already in use` : err.message}`);
  process.exit(1);
});

try {
  await initPersist(DATA_DIR);
  await rooms.loadRooms();
} catch (err) {
  console.error(`[server] could not load games from ${DATA_DIR}:`, err);
  process.exit(1);
}
rooms.startMaintenance();
server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${server.address().port} (data: ${DATA_DIR})`);
});
