// Abuse limits: connection caps and rates per client IP, a message budget per socket, the hello
// deadline, spectators per room and game creation per IP. Every limit can be changed with an env
// var; 0 turns that limit off.
//
//   LIMIT_SOCKETS              2000  open WebSockets in total (more → upgrade refused with 503)
//   LIMIT_SOCKETS_PER_IP         30  open WebSockets per client IP (more → 429). Households and
//                                    friends on one Wi-Fi share an IP, so don't go much lower.
//   LIMIT_UPGRADE_BURST          20  WebSocket upgrades per IP in a burst ...
//   LIMIT_UPGRADE_PER_SEC         1  ... then this many per second (more → 429)
//   LIMIT_MSG_BURST             100  messages per socket in a burst (pings count) ...
//   LIMIT_MSG_PER_SEC            50  ... then this many per second. Extra messages are dropped, with
//                                    at most one error RATE_LIMITED per second
//   LIMIT_MSG_DROPS_TO_CLOSE    500  more drops than this within 10 s → the socket is closed (1008)
//   LIMIT_HELLO_TIMEOUT_MS    10000  a socket that hasn't joined a game (valid hello) by then is closed (1008)
//   LIMIT_HELLO_INTERVAL_MS    1000  at most one hello per socket per interval; extra hellos are
//                                    ignored, with at most one error HELLO_RATE per second
//   LIMIT_SPECTATORS_PER_ROOM    20  more spectators get error ROOM_BUSY
//   LIMIT_SEND_BUFFER_BYTES 2097152  a socket with more unsent data than this is terminated (slow consumer)
//   LIMIT_CREATE_BURST           10  POST /api/games per IP in a burst ...
//   LIMIT_CREATE_PER_MIN          5  ... then this many per minute (more → 429 with Retry-After)
//
//   TRUST_PROXY  auto  which address is "the client IP":
//                      auto: the rightmost X-Forwarded-For entry when the TCP peer is loopback or a
//                            private address (a reverse proxy on the same host / Docker network, e.g.
//                            Traefik on Coolify), else the TCP peer
//                      1:    always the rightmost X-Forwarded-For entry (if present)
//                      0:    always the TCP peer

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[limits] ignoring ${name}=${JSON.stringify(raw)} (expected a number ≥ 0)`);
    return fallback;
  }
  return n;
}

export const LIMITS = Object.freeze({
  sockets: envInt('LIMIT_SOCKETS', 2000),
  socketsPerIp: envInt('LIMIT_SOCKETS_PER_IP', 30),
  upgradeBurst: envInt('LIMIT_UPGRADE_BURST', 20),
  upgradePerSec: envInt('LIMIT_UPGRADE_PER_SEC', 1),
  msgBurst: envInt('LIMIT_MSG_BURST', 100),
  msgPerSec: envInt('LIMIT_MSG_PER_SEC', 50),
  msgDropsToClose: envInt('LIMIT_MSG_DROPS_TO_CLOSE', 500),
  helloTimeoutMs: envInt('LIMIT_HELLO_TIMEOUT_MS', 10_000),
  helloIntervalMs: envInt('LIMIT_HELLO_INTERVAL_MS', 1000),
  spectatorsPerRoom: envInt('LIMIT_SPECTATORS_PER_ROOM', 20),
  sendBufferBytes: envInt('LIMIT_SEND_BUFFER_BYTES', 2 * 1024 * 1024),
  createBurst: envInt('LIMIT_CREATE_BURST', 10),
  createPerMin: envInt('LIMIT_CREATE_PER_MIN', 5),
});

const DROP_WINDOW_MS = 10_000;
const NOTIFY_EVERY_MS = 1000;
const SWEEP_EVERY_MS = 60_000;

// ---------------------------------------------------------------------------
// Token bucket

/** `burst` tokens, refilled at `perMs` tokens per millisecond. */
export class TokenBucket {
  constructor(burst, perMs, now = Date.now()) {
    this.burst = burst;
    this.perMs = perMs;
    this.tokens = burst;
    this.at = now;
  }

  refill(now) {
    if (now > this.at) this.tokens = Math.min(this.burst, this.tokens + (now - this.at) * this.perMs);
    this.at = now;
  }

  /** Take one token if there is one. */
  take(now = Date.now()) {
    this.refill(now);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Milliseconds until the next token is available (0 = now). */
  waitMs(now = Date.now()) {
    this.refill(now);
    return this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.perMs);
  }

  isFull(now = Date.now()) {
    this.refill(now);
    return this.tokens >= this.burst;
  }
}

/** A bucket, or null when the limit is off (burst or rate 0). */
function makeBucket(burst, perMs) {
  return burst > 0 && perMs > 0 ? new TokenBucket(burst, perMs) : null;
}

/** One bucket per key (client IP); full buckets are forgotten by sweep(). */
class KeyedBuckets {
  constructor(burst, perMs) {
    this.burst = burst;
    this.perMs = perMs;
    this.map = new Map();
  }

  get enabled() {
    return this.burst > 0 && this.perMs > 0;
  }

  /** Take a token for `key`: 0 if allowed, else the milliseconds until the next token. */
  take(key, now = Date.now()) {
    if (!this.enabled) return 0;
    let bucket = this.map.get(key);
    if (!bucket) this.map.set(key, (bucket = new TokenBucket(this.burst, this.perMs, now)));
    return bucket.take(now) ? 0 : bucket.waitMs(now);
  }

  sweep(now = Date.now()) {
    for (const [key, bucket] of this.map) if (bucket.isFull(now)) this.map.delete(key);
  }
}

const upgradeBuckets = new KeyedBuckets(LIMITS.upgradeBurst, LIMITS.upgradePerSec / 1000);
const createBuckets = new KeyedBuckets(LIMITS.createBurst, LIMITS.createPerMin / 60_000);
let sweeper = null;

function startSweeper() {
  sweeper ??= setInterval(() => {
    const now = Date.now();
    upgradeBuckets.sweep(now);
    createBuckets.sweep(now);
  }, SWEEP_EVERY_MS).unref();
}

// ---------------------------------------------------------------------------
// Client IP

const TRUST_PROXY = (process.env.TRUST_PROXY ?? 'auto').trim().toLowerCase();
const MAX_IP_LENGTH = 64;

function normalizeIp(raw) {
  let ip = String(raw ?? '').trim().toLowerCase().slice(0, MAX_IP_LENGTH);
  if (ip.startsWith('[')) ip = ip.slice(1, ip.indexOf(']') === -1 ? undefined : ip.indexOf(']')); // "[::1]:port"
  if (ip.startsWith('::ffff:') && ip.includes('.')) ip = ip.slice('::ffff:'.length); // IPv4-mapped IPv6
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':')); // "1.2.3.4:port"
  return ip || 'unknown';
}

/** Loopback, RFC 1918 or IPv6 unique-local (fc00::/7): where a reverse proxy in front of us lives. */
export function isPrivateIp(ip) {
  if (ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m) return Number(m[1]) >= 16 && Number(m[1]) <= 31;
  return /^f[cd][0-9a-f]{2}:/.test(ip);
}

function trustsProxy(peer) {
  if (TRUST_PROXY === '1' || TRUST_PROXY === 'true') return true;
  if (TRUST_PROXY === '0' || TRUST_PROXY === 'false') return false;
  return isPrivateIp(peer);
}

/** The client's IP for rate limiting (see TRUST_PROXY above). */
export function clientIp(req) {
  const peer = normalizeIp(req.socket?.remoteAddress);
  if (!trustsProxy(peer)) return peer;
  const header = req.headers['x-forwarded-for'];
  const value = Array.isArray(header) ? header.join(',') : header;
  if (typeof value !== 'string') return peer;
  const last = value.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
  return last ? normalizeIp(last) : peer;
}

// ---------------------------------------------------------------------------
// WebSocket connections

const socketsByIp = new Map();
let socketTotal = 0;

/**
 * May a new WebSocket from `ip` be accepted? Returns null (yes) or { status, message } for the
 * refusal. Takes an upgrade token for `ip` when it says yes.
 */
export function admitUpgrade(ip, now = Date.now()) {
  startSweeper();
  if (LIMITS.sockets > 0 && socketTotal >= LIMITS.sockets) {
    return { status: 503, message: 'Server is full, try again later' };
  }
  if (LIMITS.socketsPerIp > 0 && (socketsByIp.get(ip) ?? 0) >= LIMITS.socketsPerIp) {
    return { status: 429, message: 'Too many connections from your address' };
  }
  if (upgradeBuckets.take(ip, now) > 0) {
    return { status: 429, message: 'Connecting too often, slow down' };
  }
  return null;
}

/** Count an accepted socket; call the returned function once when it closes. */
export function trackSocket(ip) {
  socketTotal++;
  socketsByIp.set(ip, (socketsByIp.get(ip) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    socketTotal--;
    const left = (socketsByIp.get(ip) ?? 1) - 1;
    if (left > 0) socketsByIp.set(ip, left);
    else socketsByIp.delete(ip);
  };
}

// ---------------------------------------------------------------------------
// Messages per socket

/** Per-socket message budget (store it on the socket). */
export function newMessageBudget() {
  return {
    bucket: makeBucket(LIMITS.msgBurst, LIMITS.msgPerSec / 1000),
    notifiedAt: -Infinity,
    windowStart: -Infinity,
    drops: 0,
  };
}

/**
 * Account for one incoming message. Returns 'ok' (handle it), 'drop' (ignore it silently),
 * 'notify' (ignore it and tell the client RATE_LIMITED) or 'close' (close the socket, 1008).
 */
export function checkMessage(budget, now = Date.now()) {
  if (!budget.bucket || budget.bucket.take(now)) return 'ok';
  if (now - budget.windowStart >= DROP_WINDOW_MS) {
    budget.windowStart = now;
    budget.drops = 0;
  }
  budget.drops++;
  if (LIMITS.msgDropsToClose > 0 && budget.drops > LIMITS.msgDropsToClose) return 'close';
  if (now - budget.notifiedAt < NOTIFY_EVERY_MS) return 'drop';
  budget.notifiedAt = now;
  return 'notify';
}

// ---------------------------------------------------------------------------
// Game creation

/** Take a create token for `ip`: 0 if allowed, else the milliseconds until the next one. */
export function takeCreate(ip, now = Date.now()) {
  startSweeper();
  return createBuckets.take(ip, now);
}
