// A headless WebSocket player: connects to a game table like a browser tab would and plays
// from the `legal` lists the server sends. Used by scripts/playtest.js.
//
//   const bot = new BotClient({ url: 'ws://localhost:3000/ws', gameId, name: 'Bot 1', startAt: 4 });
//   bot.connect();
//   await bot.waitFor((b) => b.state?.status === 'finished', 60_000);
//   bot.close();
//
// Behaviour
// - Unseated in a lobby with JOIN legal: JOIN with its preferred game piece if free, else the first free one.
// - Host with START_GAME legal: starts once `startAt` players have joined.
// - In a game it asks test/bot.js chooseAction() for a move after every state it receives: on its own
//   turn (roll, buy when affordable, build sometimes, propose a trade now and then, raise cash with
//   legal.mortgage / legal.sellHouse when in debt, PAY_DEBT, DECLARE_BANKRUPTCY only when even
//   selling everything can't cover the debt, END_TURN), and off-turn in auctions (BID / PASS_AUCTION)
//   and when a trade is offered to it (ACCEPT_TRADE / REJECT_TRADE). Every move it sends comes from
//   the `legal` it last received.
// - At most one action in flight. Each action is followed by a `ping`: the server answers a socket's
//   messages in order, so the `pong` comes after the action's `error` or resulting `state`. The action
//   is settled by its error or by that pong, even when other players' moves arrive in between (bids).
// - Each action carries the seq of the state it was chosen from, so the server refuses (STALE_STATE)
//   rather than misapplies it when the game moved on. An error that arrives after a newer state means
//   another player got there first (outbid, STALE_STATE, auction over): it goes to `bot.races`, not
//   `bot.errors`, and the bot decides again on the new state. An error on an unchanged state is
//   recorded in `bot.errors`, and the bot doesn't try again until the state changes.
// - Paces its messages (actions and pings) below the server's per-socket budget (server/limits.js).
//   If the server still answers RATE_LIMITED, it holds back ~200 ms; that is not counted as an error.
//   An action with no answer after 2 s is settled anyway and the bot decides again on the latest state
//   (a repeat can't apply twice: it carries the same seq, and a repeated bid or pass is refused by
//   the engine).
// - Keeps the `welcome` credentials and resumes its seat with them on every reconnect.
//   Reconnects with exponential backoff + jitter, except after close code 4000 (seat REPLACED)
//   or error NO_GAME (the game no longer exists): then it stops for good.
// - Records every other `error` message in `bot.errors`, with the action that caused it (if any).
//
// Events (EventEmitter): 'welcome', 'state', 'server-error', 'open', 'close' (code), 'finished',
// 'settled' (the action in flight was answered).

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { TOKENS, makeRng } from '../engine/index.js';
import { chooseAction } from '../test/bot.js';

const CLOSE_REPLACED = 4000;
const RATE_RETRY_MS = 200;
const NO_ANSWER_MS = 2000;
// Own send budget, kept under the server's default (burst 100, 50 messages/s per socket).
const PACE_BURST = 80;
const PACE_PER_MS = 40 / 1000;

export class BotClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.url          WebSocket URL, e.g. ws://localhost:3000/ws
   * @param {string} opts.gameId
   * @param {string} [opts.name]       display name used for JOIN
   * @param {string} [opts.piece]      preferred game piece (board token id) for JOIN
   * @param {boolean} [opts.join]      take a seat when unseated in a lobby (default true; false = spectator)
   * @param {number} [opts.startAt]    host starts the game once this many players have joined (default 2)
   * @param {number} [opts.thinkMs]    delay before each move (default 0)
   * @param {number} [opts.seed]       seed for the bot's own decision RNG (never the game's)
   * @param {boolean} [opts.reconnect] reconnect after unexpected closes (default true)
   * @param {{playerId: string, token: string}} [opts.credentials]  resume this seat
   * @param {(line: string) => void} [opts.log]
   */
  constructor({
    url, gameId, name = 'Bot', piece = null, join = true, startAt = 2, thinkMs = 0, seed = 1,
    reconnect = true, credentials = null, log = null,
  }) {
    super();
    Object.assign(this, { url, gameId, name, piece, join, startAt, thinkMs, reconnect, log });
    this.playerId = credentials?.playerId ?? null;
    this.token = credentials?.token ?? null; // seat secret from `welcome`
    this.rng = makeRng(seed);

    this.ws = null;
    this.state = null;        // latest public state
    this.legal = null;        // latest legal actions for this seat
    this.errors = [];         // { code, message, action, phase, seq }
    this.races = [];          // same shape: actions that lost to another player's move (not errors)
    this.actionsSent = 0;
    this.rateLimited = 0;     // RATE_LIMITED answers (held back, not errors)
    this.pace = { tokens: PACE_BURST, at: Date.now() };
    this.holdUntil = 0;       // after RATE_LIMITED: send nothing before this time
    this.connects = 0;        // successful socket opens
    this.closeCodes = [];
    this.replaced = false;

    this.inFlight = null;     // { action, seq, fence } until the action's error or its fence pong
    this.pings = 0;           // pings sent on this socket (each action's fence)
    this.pongs = 0;           // pongs received on this socket
    this.blockedSeq = null;   // seq at which an action failed; don't retry until the state moves on
    this.stopped = false;     // close() called or seat replaced: never reconnect
    this.offline = false;     // disconnect() called: stay away until resume()
    this.attempt = 0;         // consecutive failed connects (backoff)
    this.thinkTimer = null;   // pending move (setTimeout, or setImmediate when thinkMs is 0)
    this.thinkImmediate = null;
    this.retryTimer = null;
  }

  get credentials() {
    return this.playerId && this.token ? { gameId: this.gameId, playerId: this.playerId, token: this.token } : null;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // -------------------------------------------------------------------------
  // Connection

  connect() {
    if (this.stopped || this.offline || this.ws) return this;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on('open', () => {
      this.attempt = 0;
      this.connects++;
      this.inFlight = null;
      this.blockedSeq = null;
      this.pings = this.pongs = 0;
      const hello = { t: 'hello', gameId: this.gameId };
      if (this.playerId && this.token) Object.assign(hello, { playerId: this.playerId, token: this.token });
      ws.send(JSON.stringify(hello));
      this.emit('open');
    });
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return this.say('ignoring a non-JSON message');
      }
      this.onMessage(msg);
    });
    ws.on('error', (err) => this.say(`socket error: ${err.message}`)); // 'close' follows
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.inFlight = null;
      this.cancelThink();
      this.closeCodes.push(code);
      this.emit('close', code);
      if (code === CLOSE_REPLACED) this.stopped = true;
      if (this.stopped || this.offline || !this.reconnect) return;
      this.scheduleReconnect();
    });
    return this;
  }

  scheduleReconnect() {
    const cap = Math.min(2000, 100 * 2 ** this.attempt);
    const delay = Math.round(cap / 2 + Math.random() * (cap / 2)); // backoff with jitter
    this.attempt = Math.min(this.attempt + 1, 10);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  /** Simulate a lost connection: drop the socket and stay away until resume(). */
  disconnect() {
    this.offline = true;
    clearTimeout(this.retryTimer);
    this.cancelThink();
    this.ws?.terminate();
    this.ws = null;
    this.inFlight = null;
  }

  /** Come back after disconnect(), resuming the seat with the stored credentials. */
  resume() {
    this.offline = false;
    return this.connect();
  }

  /** Stop for good (no reconnect). */
  close() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.cancelThink();
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.close(1000);
  }

  send(msg) {
    if (!this.connected) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  // -------------------------------------------------------------------------
  // Messages

  onMessage(msg) {
    switch (msg.t) {
      case 'welcome':
        this.playerId = msg.playerId;
        this.token = msg.token;
        this.emit('welcome', msg);
        break;

      case 'state': {
        this.state = msg.state;
        this.legal = msg.legal;
        if (this.blockedSeq !== null && msg.state.seq !== this.blockedSeq) this.blockedSeq = null;
        this.emit('state', msg);
        if (msg.state.status === 'finished') this.emit('finished', msg.state);
        if (!this.inFlight) this.schedule(); // else: decide once the action in flight is settled
        break;
      }

      case 'pong':
        this.pongs++;
        if (this.inFlight && this.pongs >= this.inFlight.fence) this.settle(); // no error came: it was applied
        break;

      case 'error': {
        const failed = this.inFlight;
        if (msg.code === 'RATE_LIMITED') {
          // Transient: the server dropped a message (the action or its ping). Hold back briefly; the
          // pong or the no-answer timer settles the action, and the bot decides again.
          this.rateLimited++;
          this.holdUntil = Date.now() + RATE_RETRY_MS;
          this.say(`rate limited${failed ? ` (during ${failed.action.type})` : ''}`);
          break;
        }
        // Another player's move got in first (the state changed before ours was handled): not a bot error.
        const raced = Boolean(failed) && this.state?.seq !== failed.seq;
        (raced ? this.races : this.errors).push({
          code: msg.code,
          message: msg.message,
          action: failed?.action?.type ?? null,
          phase: this.state?.turn?.phase ?? null,
          seq: this.state?.seq ?? null,
        });
        this.say(`${raced ? 'lost a race' : 'error'} ${msg.code}: ${msg.message}${failed ? ` (after ${failed.action.type})` : ''}`);
        if (msg.code === 'REPLACED') this.replaced = this.stopped = true;
        // The game is gone (finished and archived, or an idle lobby deleted). Reconnecting would only
        // get NO_GAME again every time the server closes the unattached socket, so stop for good.
        if (msg.code === 'NO_GAME') this.close();
        this.emit('server-error', msg);
        if (failed) {
          if (!raced) this.blockedSeq = failed.seq; // don't loop on a failing move; wait for the state to change
          this.settle();
        }
        break;
      }

      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Playing

  schedule() {
    this.cancelThink();
    if (this.stopped || this.inFlight) return;
    // setImmediate for 0: Windows timers have ~15ms granularity, which would slow fast games 10×.
    if (this.thinkMs > 0) this.thinkTimer = setTimeout(() => this.act(), this.thinkMs);
    else this.thinkImmediate = setImmediate(() => this.act());
  }

  cancelThink() {
    clearTimeout(this.thinkTimer);
    clearImmediate(this.thinkImmediate);
    this.thinkTimer = this.thinkImmediate = null;
  }

  act() {
    if (this.stopped || this.inFlight || !this.connected) return;
    const action = this.decide();
    if (!action) return;
    const waitMs = this.paceWait(2); // the action and its fence ping
    if (waitMs > 0) {
      this.cancelThink();
      this.thinkTimer = setTimeout(() => this.act(), waitMs);
      return;
    }
    const flight = { action, seq: this.state.seq, fence: ++this.pings };
    this.inFlight = flight;
    this.actionsSent++;
    this.send({ t: 'action', seq: this.state.seq, action });
    this.send({ t: 'ping' });
    // Dropped by the rate limit, or the socket died? Nothing else will settle it, so do it now.
    setTimeout(() => {
      if (this.inFlight !== flight) return;
      this.pongs = this.pings; // a lost ping must not hold up every later action
      this.settle();
    }, NO_ANSWER_MS).unref();
  }

  /** The action in flight has been answered: decide again on the latest state. */
  settle() {
    this.inFlight = null;
    this.emit('settled');
    this.schedule();
  }

  /** Take `n` send tokens: 0 if they were available, else the milliseconds to wait. */
  paceWait(n = 1) {
    const now = Date.now();
    if (now < this.holdUntil) return this.holdUntil - now;
    const pace = this.pace;
    pace.tokens = Math.min(PACE_BURST, pace.tokens + (now - pace.at) * PACE_PER_MS);
    pace.at = now;
    if (pace.tokens < n) return Math.ceil((n - pace.tokens) / PACE_PER_MS);
    pace.tokens -= n;
    return 0;
  }

  /** The move to make right now based on the latest state + legal, or null. */
  decide() {
    const { state, legal } = this;
    if (!state || !legal || state.seq === this.blockedSeq) return null;

    if (state.status === 'lobby') {
      if (!this.playerId) {
        if (!this.join || !legal.actions.includes('JOIN')) return null;
        return { type: 'JOIN', name: this.name, token: this.pickPiece(state) };
      }
      if (legal.actions.includes('START_GAME') && state.players.length >= this.startAt) return { type: 'START_GAME' };
      return null;
    }

    // chooseAction knows who may act: the current player, anyone in an auction, the target of a trade.
    if (state.status !== 'active' || !this.playerId) return null;
    const action = chooseAction(state, legal, this.playerId, this.rng);
    if (!action) return null;
    const { playerId, ...rest } = action; // the server takes the player from the seat
    return rest;
  }

  pickPiece(state) {
    const taken = new Set(state.players.map((p) => p.token));
    if (this.piece && !taken.has(this.piece)) return this.piece;
    return TOKENS.find((t) => !taken.has(t.id))?.id ?? TOKENS[0].id;
  }

  /** LEAVE: in the lobby this frees the seat; in an active game it resigns (bankrupt to the bank). */
  resign() {
    this.cancelThink();
    this.stopped = true; // no further moves; keep the socket open to see the result
    this.actionsSent++;
    return this.send({ t: 'action', action: { type: 'LEAVE' } });
  }

  // -------------------------------------------------------------------------
  // Helpers

  /** Resolve once predicate(bot) is true (checked now and after every message). */
  waitFor(predicate, timeoutMs = 30_000, label = 'condition') {
    return new Promise((resolve, reject) => {
      if (predicate(this)) return resolve(this);
      const check = () => {
        if (!predicate(this)) return;
        cleanup();
        resolve(this);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${this.name}: timed out after ${timeoutMs}ms waiting for ${label}`));
      }, timeoutMs);
      const names = ['state', 'welcome', 'server-error', 'close', 'open', 'settled'];
      const cleanup = () => {
        clearTimeout(timer);
        for (const n of names) this.off(n, check);
      };
      for (const n of names) this.on(n, check);
    });
  }

  say(line) {
    this.log?.(`[${this.name}] ${line}`);
  }
}
