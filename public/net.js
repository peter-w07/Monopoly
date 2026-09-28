// net.js — the WebSocket connection to one game table.
//
// Opens ws(s)://<host>/ws, sends `hello` with the current seat credentials on every (re)connect,
// and reconnects with exponential backoff + full random jitter so a server restart doesn't cause
// a reconnect stampede. It never reconnects after the server says this seat was opened
// elsewhere (close code 4000 / error REPLACED); the UI offers "Use here" instead.

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 15_000;
const STABLE_AFTER_MS = 10_000; // a connection that survives this long resets the backoff
const PING_EVERY_MS = 25_000;
const CLOSE_REPLACED = 4000;

/**
 * Connect to a game table.
 *
 * @param {string} gameId
 * @param {object} handlers
 * @param {() => ({playerId: string, token: string} | null)} handlers.getSeat
 *        Called on every (re)connect; its result goes into the hello.
 * @param {(msg: object) => void} [handlers.onState]    { t:'state', state, events, legal, now }
 * @param {(msg: object) => void} [handlers.onWelcome]  { t:'welcome', gameId, playerId, token }
 * @param {(msg: object) => void} [handlers.onError]    { t:'error', code, message } (REPLACED goes to onStatus)
 * @param {(s: {status: string, retryAt?: number}) => void} [handlers.onStatus]
 *        status: 'connecting' | 'connected' | 'reconnecting' | 'replaced' | 'closed';
 *        retryAt (epoch ms) is set while waiting to retry.
 * @returns {{ send(action: object): boolean, reconnect(): void, close(): void }}
 */
export function connectGame(gameId, handlers) {
  let ws = null;
  let attempt = 0;      // consecutive failures, drives the backoff
  let stopped = false;  // set by close() or when another tab took the seat
  let retryTimer = null;
  let stableTimer = null;
  let pingTimer = null;

  const setStatus = (status, extra = {}) => handlers.onStatus?.({ status, ...extra });

  function clearTimers() {
    clearTimeout(retryTimer);
    clearTimeout(stableTimer);
    clearInterval(pingTimer);
    retryTimer = stableTimer = pingTimer = null;
  }

  function sendRaw(message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  }

  // Detach and close the current socket without triggering a reconnect.
  function drop() {
    clearTimers();
    const old = ws;
    ws = null;
    if (!old) return;
    old.onopen = old.onmessage = old.onclose = old.onerror = null;
    try { old.close(1000); } catch { /* already closed */ }
  }

  function replaced() {
    stopped = true;
    drop();
    setStatus('replaced');
  }

  function scheduleRetry() {
    const cap = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
    const delay = Math.round(Math.random() * cap); // "full jitter": anywhere in [0, cap]
    attempt = Math.min(attempt + 1, 10);
    setStatus('reconnecting', { retryAt: Date.now() + delay });
    retryTimer = setTimeout(open, delay);
  }

  function open() {
    clearTimers();
    setStatus(attempt === 0 ? 'connecting' : 'reconnecting');

    let sock;
    try {
      sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    } catch {
      scheduleRetry();
      return;
    }
    ws = sock;

    sock.onopen = () => {
      const seat = handlers.getSeat?.();
      const hello = { t: 'hello', gameId };
      if (seat?.playerId && seat?.token) {
        hello.playerId = seat.playerId;
        hello.token = seat.token;
      }
      sock.send(JSON.stringify(hello));
      setStatus('connected');
      stableTimer = setTimeout(() => { attempt = 0; }, STABLE_AFTER_MS);
      pingTimer = setInterval(() => sendRaw({ t: 'ping' }), PING_EVERY_MS);
    };

    sock.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.t === 'state') handlers.onState?.(msg);
      else if (msg.t === 'welcome') handlers.onWelcome?.(msg);
      else if (msg.t === 'error') {
        if (msg.code === 'REPLACED') replaced();
        else handlers.onError?.(msg);
      }
      // 'pong' needs no handling: its only job is to keep proxies from idling the socket out.
    };

    sock.onclose = (event) => {
      ws = null;
      clearTimers();
      if (stopped) return;
      if (event.code === CLOSE_REPLACED) replaced();
      else scheduleRetry();
    };

    sock.onerror = () => { /* a close event always follows; reconnect is handled there */ };
  }

  open();

  return {
    /** Send a game action; returns false when not connected. */
    send: (action) => sendRaw({ t: 'action', action }),
    /** Reconnect right away (Retry now / Use here / seat takeover), re-reading the seat. */
    reconnect() {
      stopped = false;
      attempt = 0;
      drop();
      open();
    },
    /** Close for good (leaving the table). */
    close() {
      stopped = true;
      drop();
      setStatus('closed');
    },
  };
}
