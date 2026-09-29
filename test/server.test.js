// End-to-end server tests: spawn server/index.js on a free port with a temp DATA_DIR and talk to it
// over HTTP and WebSocket, including a graceful restart (IPC 'shutdown') and seat resume, the abuse
// limits (server/limits.js), room lifecycle, save durability and the one-instance lock.
// Child processes are always killed and temp dirs removed, even when a test fails.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createGame, applyAction } from '../engine/index.js';
import { withDice } from './helpers.js';

const SERVER = fileURLToPath(new URL('../server/index.js', import.meta.url));
const children = new Set();
const tempDirs = new Set();

// Last-resort cleanup if the test process exits without running the after() hooks.
process.on('exit', () => {
  for (const child of children) child.kill('SIGKILL');
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monopoly-server-test-'));
  tempDirs.add(dir);
  return dir;
}

async function removeTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  tempDirs.delete(dir);
}

/** Fork the server (PORT=0 → the OS picks a free port). Resolves { child, exited, output } at once. */
function spawnServer(dataDir, env = {}) {
  const child = fork(SERVER, [], {
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ...env },
    silent: true, // pipe stdout/stderr (and keep the IPC channel for 'shutdown')
  });
  children.add(child);
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  const exited = new Promise((resolve) => {
    child.once('exit', (code) => {
      children.delete(child);
      resolve(code);
    });
  });
  return { child, exited, output, text: () => output.join('') };
}

/** Start the server and resolve once it is listening. */
function startServer(dataDir, env = {}) {
  const srv = spawnServer(dataDir, env);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${srv.text()}`)), 10_000);
    const onData = () => {
      const match = /listening on http:\/\/localhost:(\d+)/.exec(srv.text());
      if (!match) return;
      clearTimeout(timer);
      srv.child.stdout.off('data', onData);
      resolve({ ...srv, port: Number(match[1]), base: `http://127.0.0.1:${match[1]}` });
    };
    srv.child.stdout.on('data', onData);
    srv.exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code}):\n${srv.text()}`));
    });
  });
}

async function killAll() {
  for (const child of [...children]) {
    child.kill('SIGKILL');
    await new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve)));
  }
}

async function getJson(url, init) {
  const res = await fetch(url, init);
  return { status: res.status, headers: res.headers, body: await res.json() };
}

const postGame = (server, settings = {}, headers = {}) =>
  getJson(`${server.base}/api/games`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ settings }),
  });

/** WebSocket client that buffers messages; take() returns the next matching one in arrival order. */
class Client {
  constructor(server, { headers } = {}) {
    this.ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers });
    this.buffer = [];
    this.waiter = null;
    this.closed = new Promise((resolve) => this.ws.once('close', (code) => resolve(code)));
    this.ws.on('error', () => {}); // surfaced through 'close'
    this.ws.on('message', (data) => {
      this.buffer.push(JSON.parse(data.toString()));
      this.waiter?.();
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  /** Next message matching `pred`; earlier non-matching messages are skipped. */
  take(pred, label = 'message', timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`timed out waiting for ${label}; got ${JSON.stringify(this.buffer.map((m) => m.t))}`));
      }, timeoutMs);
      const scan = () => {
        const i = this.buffer.findIndex(pred);
        if (i === -1) return;
        const [msg] = this.buffer.splice(0, i + 1).slice(-1);
        clearTimeout(timer);
        this.waiter = null;
        resolve(msg);
      };
      this.waiter = scan;
      scan();
    });
  }

  state(label = 'state') {
    return this.take((m) => m.t === 'state', label);
  }

  error(label = 'error') {
    return this.take((m) => m.t === 'error', label);
  }

  welcome(label = 'welcome') {
    return this.take((m) => m.t === 'welcome', label);
  }

  close() {
    this.ws.close();
  }
}

async function connect(server, hello, opts) {
  const client = new Client(server, opts);
  await client.opened;
  if (hello) client.send({ t: 'hello', ...hello });
  return client;
}

/** Connect, hello as a spectator, JOIN. Resolves the client with .seat = { playerId, token }. */
async function joinAs(server, gameId, name, token, opts) {
  const client = await connect(server, { gameId }, opts);
  await client.state(`${name}: first state`);
  client.send({ t: 'action', action: { type: 'JOIN', name, token } });
  const welcome = await client.welcome(`${name}: welcome`);
  client.seat = { playerId: welcome.playerId, token: welcome.token };
  await client.state(`${name}: state after JOIN`);
  return client;
}

/** A raw WebSocket upgrade request: resolves { status: 101, socket } or { status, body, headers }. */
function upgradeAttempt(server, ip) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port: server.port,
      path: '/ws',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
        'X-Forwarded-For': ip,
      },
    });
    req.on('upgrade', (res, socket) => resolve({ status: res.statusCode, socket }));
    req.on('response', (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body || 'null') }));
    });
    req.on('error', reject);
  });
}

/** Everything `client` received within `ms`. */
async function drain(client, ms) {
  await sleep(ms);
  return client.buffer.splice(0);
}

// ---------------------------------------------------------------------------

describe('server', () => {
  let dataDir;
  let server;
  let gameId;
  let alice, bob;              // sockets
  let aliceSeat, bobSeat;      // { playerId, token } from welcome
  let aliceHelloAt;
  let lastSeq;

  before(async () => {
    dataDir = makeTempDir();
    server = await startServer(dataDir);
  });

  after(async () => {
    for (const c of [alice, bob]) c?.ws.terminate();
    await killAll();
    await removeTempDir(dataDir);
  });

  test('GET /health', async () => {
    const { status, body } = await getJson(`${server.base}/health`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.games, 0);
    assert.equal(typeof body.uptime, 'number');
  });

  test('create and summarise a game; an empty lobby is not listed', async () => {
    const created = await postGame(server, { maxPlayers: 4 });
    assert.equal(created.status, 201);
    assert.match(created.body.gameId, /^g_[a-z2-9]{6}$/);
    gameId = created.body.gameId;

    const list = await getJson(`${server.base}/api/games`);
    assert.equal(list.body.games.some((g) => g.id === gameId), false, '0-player lobbies are not listed');

    // The join code works without "g_" and in any case.
    const summary = await getJson(`${server.base}/api/games/${gameId.slice(2).toUpperCase()}`);
    assert.equal(summary.status, 200);
    assert.equal(summary.body.id, gameId);
    assert.equal(summary.body.status, 'lobby');
    assert.deepEqual(summary.body.players, []);
    assert.equal(summary.body.settings.maxPlayers, 4);

    assert.equal((await fetch(`${server.base}/api/games/g_zzzzzz`)).status, 404);
  });

  test('two players join, start and roll; every change reaches both sockets', async () => {
    alice = await connect(server, { gameId });
    aliceHelloAt = Date.now();
    bob = await connect(server, { gameId });
    const first = await alice.state();
    assert.deepEqual(first.legal.actions, ['JOIN']);
    assert.equal(first.state.rng, undefined, 'public state hides the rng');
    assert.deepEqual(first.state.decks, { chance: { size: 16 }, community: { size: 16 } });
    await bob.state();

    alice.send({ t: 'action', action: { type: 'JOIN', name: 'Alice', token: 'car', playerId: 'p_spoofed' } });
    const welcomeA = await alice.welcome();
    assert.notEqual(welcomeA.playerId, 'p_spoofed', 'the server picks the playerId');
    assert.match(welcomeA.playerId, /^p_[a-z2-9]{8}$/);
    assert.match(welcomeA.token, /^[0-9a-f]{32}$/);
    aliceSeat = { playerId: welcomeA.playerId, token: welcomeA.token };
    const joinedA = await alice.state('state after JOIN');
    assert.equal(joinedA.state.players[0].name, 'Alice');
    assert.ok(joinedA.legal.actions.includes('LEAVE'));
    const seenByBob = await bob.state('broadcast of Alice joining');
    assert.equal(seenByBob.state.seq, joinedA.state.seq);
    assert.deepEqual(seenByBob.legal.actions, ['JOIN']);

    const list = await getJson(`${server.base}/api/games`);
    const entry = list.body.games.find((g) => g.id === gameId);
    assert.deepEqual({ ...entry, createdAt: 0 }, { id: gameId, players: 1, maxPlayers: 4, hostName: 'Alice', createdAt: 0 });

    bob.send({ t: 'action', action: { type: 'JOIN', name: 'Bob', token: 'dog' } });
    const welcomeB = await bob.welcome();
    bobSeat = { playerId: welcomeB.playerId, token: welcomeB.token };
    await bob.state();
    await alice.state();

    alice.send({ t: 'action', action: { type: 'START_GAME' } });
    const startA = await alice.state('game start (Alice)');
    const startB = await bob.state('game start (Bob)');
    for (const msg of [startA, startB]) {
      assert.equal(msg.state.status, 'active');
      assert.ok(msg.events.some((e) => e.type === 'game_started'));
      assert.equal(typeof msg.now, 'number');
    }
    assert.deepEqual(startA.state.turn.order, [aliceSeat.playerId, bobSeat.playerId]);
    assert.ok(startA.legal.actions.includes('ROLL'), 'Alice may roll');
    assert.deepEqual(startB.legal.actions, ['LEAVE'], 'Bob has to wait (he could only resign)');
    assert.ok(startA.state.turn.deadlineAt > startA.now, 'turn timer running');

    bob.send({ t: 'action', action: { type: 'ROLL' } });
    assert.equal((await bob.error()).code, 'NOT_YOUR_TURN');

    alice.send({ t: 'action', action: { type: 'ROLL' } });
    const rollA = await alice.state('roll (Alice)');
    const rollB = await bob.state('roll (Bob)');
    assert.equal(rollA.state.seq, startA.state.seq + 1);
    assert.equal(rollB.state.seq, rollA.state.seq);
    const dice = rollB.events.find((e) => e.type === 'dice_rolled');
    assert.equal(dice.playerId, aliceSeat.playerId);
    assert.equal(dice.dice.length, 2);
    lastSeq = rollA.state.seq;
  });

  test('a seated socket re-sending hello gets the state again; the table hears nothing', async () => {
    await sleep(Math.max(0, aliceHelloAt + 1100 - Date.now())); // one hello per second per socket
    alice.send({ t: 'hello', gameId, ...aliceSeat });
    const again = await alice.state('state after re-hello');
    assert.equal(again.state.seq, lastSeq);
    assert.equal(again.state.players[0].connected, true);
    assert.ok(again.legal.actions.length > 0, 'still seated');
    assert.deepEqual(await drain(bob, 300), [], 'no disconnect/connect broadcast to the other player');
    assert.equal(alice.buffer.some((m) => m.t === 'error'), false);
  });

  test('a burst of 50 hellos from one socket gets at most 2 state frames back', async () => {
    const carol = await connect(server);
    const hello = JSON.stringify({ t: 'hello', gameId });
    for (let i = 0; i < 50; i++) carol.ws.send(hello);
    const got = await drain(carol, 500);
    const states = got.filter((m) => m.t === 'state');
    assert.ok(states.length >= 1 && states.length <= 2, `got ${states.length} state frames`);
    const errors = got.filter((m) => m.t === 'error');
    assert.ok(errors.length <= 1 && errors.every((m) => m.code === 'HELLO_RATE'), JSON.stringify(errors));
    assert.deepEqual(await drain(bob, 0), [], 'a spectator arriving is not broadcast');
    carol.close();
  });

  test('a wrong seat token only gets a spectator view', async () => {
    const eve = await connect(server, { gameId, playerId: aliceSeat.playerId, token: 'f'.repeat(32) });
    assert.equal((await eve.error()).code, 'BAD_TOKEN');
    const view = await eve.state();
    assert.deepEqual(view.legal.actions, []);
    assert.equal(eve.buffer.some((m) => m.t === 'welcome'), false);
    eve.send({ t: 'action', action: { type: 'END_TURN' } });
    assert.equal((await eve.error()).code, 'NOT_SEATED');
    eve.close();

    const summary = await getJson(`${server.base}/api/games/${gameId}`);
    assert.equal(summary.body.players.find((p) => p.id === aliceSeat.playerId).connected, true, "Alice's seat untouched");
  });

  test('TIMEOUT from a client is rejected', async () => {
    alice.send({ t: 'action', action: { type: 'TIMEOUT' } });
    assert.equal((await alice.error()).code, 'FORBIDDEN');
    // Nothing was applied: the next message after a ping is the pong, not a state.
    alice.send({ t: 'ping' });
    const next = await alice.take(() => true, 'pong');
    assert.equal(next.t, 'pong');
    assert.equal(bob.buffer.some((m) => m.t === 'state'), false);
  });

  test('graceful restart (IPC shutdown) keeps the game; players resume with their tokens', async () => {
    server.child.send('shutdown');
    assert.equal(await server.exited, 0);
    assert.equal(await alice.closed, 1012);
    assert.equal(await bob.closed, 1012);
    assert.match(server.text(), /flushed \d+ game\(s\)/);

    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'games', `${gameId}.json`), 'utf8'));
    assert.equal(saved.state.seq, lastSeq, 'flushed on shutdown');
    assert.equal(fs.existsSync(path.join(dataDir, 'games', `${gameId}.json.tmp`)), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'instance.lock')), false, 'lock released');

    server = await startServer(dataDir);
    const summary = await getJson(`${server.base}/api/games/${gameId}`);
    assert.equal(summary.body.status, 'active');
    assert.deepEqual(summary.body.players.map((p) => p.connected), [false, false], 'everyone starts disconnected');

    alice = await connect(server, { gameId, ...aliceSeat });
    const welcome = await alice.welcome();
    assert.deepEqual({ playerId: welcome.playerId, token: welcome.token }, aliceSeat);
    const resumed = await alice.state();
    assert.equal(resumed.state.seq, lastSeq, 'same seq after restart');
    assert.equal(resumed.state.players[0].connected, true);
    assert.equal(resumed.state.players[1].connected, false);
    assert.ok(resumed.legal.actions.length > 0, 'Alice can carry on with her turn');

    bob = await connect(server, { gameId, ...bobSeat });
    await bob.welcome();
    assert.equal((await bob.state()).state.seq, lastSeq);

    // The game carries on: Alice plays a legal action and both see it.
    const [type] = resumed.legal.actions.filter((a) => a !== 'LEAVE');
    alice.send({ t: 'action', action: { type } });
    const moved = await bob.take((m) => m.t === 'state' && m.state.seq === lastSeq + 1, `state after ${type}`);
    assert.equal(moved.state.status, 'active');
  });
});

// ---------------------------------------------------------------------------

describe('server: action seq', () => {
  let dataDir;
  let server;

  before(async () => {
    dataDir = makeTempDir();
    server = await startServer(dataDir);
  });

  after(async () => {
    await killAll();
    await removeTempDir(dataDir);
  });

  test('two identical ROLLs with the same seq: the first applies, the second is STALE_STATE', async () => {
    const { body } = await postGame(server);
    const alice = await joinAs(server, body.gameId, 'Alice', 'car');
    const bob = await joinAs(server, body.gameId, 'Bob', 'dog');
    alice.send({ t: 'action', seq: 999, action: { type: 'START_GAME' } });
    assert.equal((await alice.error()).code, 'STALE_STATE', 'a seq that is not the current one is refused');
    alice.send({ t: 'action', action: { type: 'START_GAME' } }); // no seq: accepted as before
    const started = await alice.take((m) => m.t === 'state' && m.state.status === 'active', 'game start');
    const { seq } = started.state;

    const roll = JSON.stringify({ t: 'action', seq, action: { type: 'ROLL' } });
    alice.ws.send(roll);
    alice.ws.send(roll);
    const rolled = await alice.state('state after the first ROLL');
    assert.equal(rolled.state.seq, seq + 1);
    assert.equal((await alice.error('second ROLL')).code, 'STALE_STATE');
    const rest = await drain(bob, 300);
    const seqs = [...new Set(rest.filter((m) => m.t === 'state').map((m) => m.state.seq))];
    assert.deepEqual(seqs.filter((s) => s > seq), [seq + 1], 'state.seq advanced exactly once');
    alice.close();
    bob.close();
  });
});

// ---------------------------------------------------------------------------

describe('server: auctions and trades over WebSocket', () => {
  const GAME = 'g_auct23';
  const ANN = { playerId: 'p_aaaaaaaa', token: 'a'.repeat(32) };
  const BEN = { playerId: 'p_bbbbbbbb', token: 'b'.repeat(32) };
  let dataDir;
  let server;

  // A saved game where Ann (to move) has just rolled 1+2 onto Baltic Avenue (3, $60): buy or decline.
  before(async () => {
    dataDir = makeTempDir();
    let state = createGame({ id: GAME, seed: 7, settings: {} });
    state = applyAction(state, { type: 'JOIN', playerId: ANN.playerId, name: 'Ann', token: 'car' }).state;
    state = applyAction(state, { type: 'JOIN', playerId: BEN.playerId, name: 'Ben', token: 'dog' }).state;
    state = applyAction(state, { type: 'START_GAME', playerId: ANN.playerId }).state;
    state = applyAction(withDice(state, 1, 2), { type: 'ROLL', playerId: ANN.playerId }).state;
    assert.equal(state.turn.phase, 'buying_or_auction');
    state.createdAt = state.updatedAt = Date.now();
    fs.mkdirSync(path.join(dataDir, 'games'), { recursive: true });
    const secrets = { [ANN.playerId]: ANN.token, [BEN.playerId]: BEN.token };
    fs.writeFileSync(path.join(dataDir, 'games', `${GAME}.json`), JSON.stringify({ version: 1, state, secrets }));
    server = await startServer(dataDir);
  });

  after(async () => {
    await killAll();
    await removeTempDir(dataDir);
  });

  /** The next state frame at `seq` (skipping connection frames and older states). */
  const stateAt = (client, seq, label) => client.take((m) => m.t === 'state' && m.state.seq === seq, label);
  const cashOf = (msg, id) => msg.state.players.find((p) => p.id === id).cash;
  const ownerOf = (msg, index) => msg.state.tiles.find((t) => t.index === index).ownerId;
  const types = (msg) => msg.events.map((e) => e.type);
  const clock = (msg) => msg.state.turn.deadlineAt - msg.now;

  test('two sockets bid in an auction; then a trade is proposed and accepted off-turn', async () => {
    const ann = await connect(server, { gameId: GAME, ...ANN });
    await ann.welcome();
    const ben = await connect(server, { gameId: GAME, ...BEN });
    await ben.welcome();
    const bothIn = (m) => m.t === 'state' && m.state.players.every((p) => p.connected);
    let a = await ann.take(bothIn, 'both connected (Ann)');
    await ben.take(bothIn, 'both connected (Ben)');
    const seq0 = a.state.seq;
    assert.ok(a.legal.actions.includes('DECLINE') && a.legal.actions.includes('START_AUCTION'));

    // Ann declines: the auction opens for both, each with their own legal (BID range, PASS_AUCTION).
    ann.send({ t: 'action', seq: seq0, action: { type: 'DECLINE' } });
    const s1 = seq0 + 1;
    a = await stateAt(ann, s1, 'auction start (Ann)');
    let b = await stateAt(ben, s1, 'auction start (Ben)');
    assert.deepEqual(types(b), ['declined', 'auction_started']);
    assert.equal(b.state.turn.phase, 'auction');
    assert.deepEqual(b.state.auction.participants, [ANN.playerId, BEN.playerId]);
    for (const msg of [a, b]) {
      assert.ok(msg.legal.actions.includes('BID') && msg.legal.actions.includes('PASS_AUCTION'));
      assert.equal(msg.legal.auction.minBid, 1);
    }
    assert.equal(b.legal.auction.maxBid, cashOf(b, BEN.playerId));
    assert.ok(clock(b) > 9_000 && clock(b) <= 10_000, `10 s auction clock, got ${clock(b)} ms`);

    // Both bid on the state they saw (seq s1). Ann's arrives first; Ben's is then judged by the engine,
    // not refused as stale: a tie is too low, a higher bid takes the lead and restarts the clock.
    ann.send({ t: 'action', seq: s1, action: { type: 'BID', amount: 10 } });
    await stateAt(ann, s1 + 1, 'bid from Ann (Ann)');
    b = await stateAt(ben, s1 + 1, 'bid from Ann (Ben)');
    assert.deepEqual(b.events, [{ type: 'auction_bid', playerId: ANN.playerId, amount: 10 }]);
    assert.deepEqual(b.legal.auction, { minBid: 11, maxBid: cashOf(b, BEN.playerId) });
    const deadlineAfterAnn = b.state.turn.deadlineAt;

    ben.send({ t: 'action', seq: s1, action: { type: 'BID', amount: 10 } });
    assert.equal((await ben.error('tied bid')).code, 'BID_TOO_LOW');
    await sleep(20); // so the restarted deadline is measurably later
    ben.send({ t: 'action', seq: s1, action: { type: 'BID', amount: 20 } });
    a = await stateAt(ann, s1 + 2, 'bid from Ben (Ann)');
    b = await stateAt(ben, s1 + 2, 'bid from Ben (Ben)');
    assert.deepEqual(a.events, [{ type: 'auction_bid', playerId: BEN.playerId, amount: 20 }]);
    assert.equal(a.state.auction.highBidderId, BEN.playerId);
    assert.ok(a.state.turn.deadlineAt > deadlineAfterAnn, 'the bid restarted the auction clock');
    assert.equal(b.legal.auction, null, 'the high bidder cannot bid again');
    assert.ok(!b.legal.actions.includes('PASS_AUCTION'), 'or pass');

    // A seq from before the auction started is still stale; the high bidder can't pass.
    ann.send({ t: 'action', seq: seq0, action: { type: 'BID', amount: 30 } });
    assert.equal((await ann.error('bid with a pre-auction seq')).code, 'STALE_STATE');
    ben.send({ t: 'action', seq: s1 + 2, action: { type: 'PASS_AUCTION' } });
    assert.equal((await ben.error('high bidder passing')).code, 'ALREADY_HIGH_BIDDER');

    // Ann drops out (from a state one bid old): Ben wins the tile for $20, paid to the bank.
    ann.send({ t: 'action', seq: s1 + 1, action: { type: 'PASS_AUCTION' } });
    a = await stateAt(ann, s1 + 3, 'auction over (Ann)');
    b = await stateAt(ben, s1 + 3, 'auction over (Ben)');
    assert.deepEqual(types(b), ['auction_passed', 'auction_won']);
    assert.deepEqual(b.events[1], { type: 'auction_won', playerId: BEN.playerId, tileIndex: 3, amount: 20 });
    assert.equal(b.state.auction, null);
    assert.equal(b.state.turn.phase, 'end_turn');
    assert.equal(ownerOf(b, 3), BEN.playerId);
    assert.equal(cashOf(b, BEN.playerId), 1480);
    assert.ok(clock(a) > 80_000, `back on the 90 s turn clock, got ${clock(a)} ms`);
    const turnDeadline = a.state.turn.deadlineAt;

    // Ann offers $100 for Baltic Avenue; only Ben may accept.
    assert.deepEqual(a.legal.tradeTargets, [BEN.playerId]);
    assert.ok(a.legal.actions.includes('PROPOSE_TRADE'));
    const offer = { type: 'PROPOSE_TRADE', toPlayerId: BEN.playerId, give: { cash: 100 }, get: { tiles: [3] } };
    ann.send({ t: 'action', seq: s1 + 3, action: offer });
    a = await stateAt(ann, s1 + 4, 'trade proposed (Ann)');
    b = await stateAt(ben, s1 + 4, 'trade proposed (Ben)');
    assert.deepEqual(types(b), ['trade_proposed']);
    assert.equal(b.state.turn.phase, 'trading');
    assert.equal(b.state.trade.id, `t_${s1 + 3}`);
    assert.ok(b.legal.actions.includes('ACCEPT_TRADE') && b.legal.actions.includes('REJECT_TRADE'));
    assert.ok(!a.legal.actions.includes('ACCEPT_TRADE') && a.legal.actions.includes('REJECT_TRADE'));
    assert.equal(b.state.turn.deadlineAt, turnDeadline, 'proposing does not restart the turn clock');

    // Ben answers the offer he read, by id (a replaced offer would be NO_TRADE).
    ben.send({ t: 'action', seq: s1 + 4, action: { type: 'ACCEPT_TRADE', tradeId: 't_0' } });
    assert.equal((await ben.error('accepting an offer that is not the pending one')).code, 'NO_TRADE');
    ben.send({ t: 'action', seq: s1 + 4, action: { type: 'ACCEPT_TRADE', tradeId: b.state.trade.id } });
    a = await stateAt(ann, s1 + 5, 'trade accepted (Ann)');
    await stateAt(ben, s1 + 5, 'trade accepted (Ben)');
    assert.deepEqual(types(a), ['trade_accepted']);
    assert.deepEqual(a.events[0].fees, { [ANN.playerId]: 0, [BEN.playerId]: 0 });
    assert.equal(ownerOf(a, 3), ANN.playerId);
    assert.equal(cashOf(a, ANN.playerId), 1400);
    assert.equal(cashOf(a, BEN.playerId), 1580);
    assert.equal(a.state.turn.phase, 'end_turn');
    assert.equal(a.state.turn.deadlineAt, turnDeadline, 'nor does answering');
    assert.ok(a.legal.actions.includes('END_TURN'));

    ann.close();
    ben.close();
  });
});

// ---------------------------------------------------------------------------

describe('server: limits and room lifecycle', () => {
  let dataDir;
  let server;
  const ip = (n) => ({ headers: { 'X-Forwarded-For': `198.51.100.${n}` } }); // one fake client address per test

  before(async () => {
    dataDir = makeTempDir();
    server = await startServer(dataDir, {
      LIMIT_SPECTATORS_PER_ROOM: '2',
      LIMIT_HELLO_TIMEOUT_MS: '500',
      LIMIT_MSG_BURST: '10',
      LIMIT_MSG_PER_SEC: '10',
      LIMIT_MSG_DROPS_TO_CLOSE: '30',
    });
  });

  after(async () => {
    await killAll();
    await removeTempDir(dataDir);
  });

  test('POST /api/games: the 11th game in a burst from one address gets 429 with Retry-After', async () => {
    const statuses = [];
    let refused;
    for (let i = 0; i < 11; i++) {
      const res = await postGame(server, {}, { 'X-Forwarded-For': '203.0.113.50' });
      statuses.push(res.status);
      if (res.status === 429) refused = res;
    }
    assert.deepEqual(statuses, [...Array(10).fill(201), 429]);
    assert.equal(typeof refused.body.error, 'string');
    assert.ok(Number(refused.headers.get('retry-after')) >= 1, 'Retry-After in seconds');
    assert.equal((await postGame(server, {}, { 'X-Forwarded-For': '203.0.113.51' })).status, 201, 'other addresses are unaffected');
  });

  test('the lobby list only shows lobbies with a connected player', async () => {
    const { body } = await postGame(server);
    const listed = async () => (await getJson(`${server.base}/api/games`)).body.games.some((g) => g.id === body.gameId);
    const watcher = await connect(server, { gameId: body.gameId }, ip(1));
    await watcher.state();
    assert.equal(await listed(), false, 'a spectator alone does not make a lobby joinable');
    const alice = await joinAs(server, body.gameId, 'Alice', 'car', ip(1));
    assert.equal(await listed(), true);
    alice.close();
    await alice.closed;
    await watcher.take((m) => m.t === 'state' && m.events.some((e) => e.type === 'connection'), 'disconnect broadcast');
    assert.equal(await listed(), false, 'nobody left to start it');
    watcher.close();
  });

  test('one socket gets one seat: JOIN after a re-hello is ALREADY_SEATED, and a friend can still join', async () => {
    const { body } = await postGame(server, { maxPlayers: 2 });
    const mallory = await joinAs(server, body.gameId, 'Mallory', 'car', ip(2));
    await sleep(1100); // one hello per second per socket
    mallory.send({ t: 'hello', gameId: body.gameId }); // back to spectating
    await mallory.state();
    mallory.send({ t: 'action', action: { type: 'JOIN', name: 'Mallory 2', token: 'dog' } });
    const refused = await mallory.error();
    assert.equal(refused.code, 'ALREADY_SEATED');

    const friend = await joinAs(server, body.gameId, 'Friend', 'dog', ip(2));
    assert.match(friend.seat.playerId, /^p_/);
    const summary = await getJson(`${server.base}/api/games/${body.gameId}`);
    assert.deepEqual(summary.body.players.map((p) => p.name), ['Mallory', 'Friend']);
    mallory.close();
    friend.close();
  });

  test('spectators beyond the per-room cap get ROOM_BUSY and stay unattached', async () => {
    const { body } = await postGame(server);
    const watchers = [];
    for (let i = 0; i < 2; i++) {
      const w = await connect(server, { gameId: body.gameId }, ip(3));
      await w.state();
      watchers.push(w);
    }
    const third = await connect(server, { gameId: body.gameId }, ip(3));
    assert.equal((await third.error()).code, 'ROOM_BUSY');
    third.send({ t: 'action', action: { type: 'JOIN', name: 'Late', token: 'car' } });
    assert.equal((await third.error()).code, 'NO_GAME', 'not attached to the room');
    for (const w of [...watchers, third]) w.close();
  });

  test('a socket that never says hello is closed with 1008', async () => {
    const idle = new Client(server, ip(4));
    await idle.opened;
    const started = Date.now();
    assert.equal(await idle.closed, 1008);
    assert.ok(Date.now() - started >= 400, 'after the hello deadline');
  });

  test('a flooding socket gets RATE_LIMITED once, then is closed with 1008', async () => {
    const flooder = await connect(server, null, ip(5));
    for (let i = 0; i < 60; i++) flooder.send({ t: 'ping' });
    assert.equal(await flooder.closed, 1008);
    const pongs = flooder.buffer.filter((m) => m.t === 'pong').length;
    const errors = flooder.buffer.filter((m) => m.t === 'error');
    assert.ok(pongs >= 10 && pongs <= 12, `burst answered (${pongs} pongs)`);
    assert.deepEqual(errors.map((m) => m.code), ['RATE_LIMITED']);
    assert.equal((await getJson(`${server.base}/health`)).status, 200);
  });
});

// ---------------------------------------------------------------------------

describe('server: connection caps', () => {
  let dataDir;
  let server;
  const open = [];

  before(async () => {
    dataDir = makeTempDir();
    server = await startServer(dataDir, {
      LIMIT_SOCKETS_PER_IP: '3',
      LIMIT_UPGRADE_BURST: '5',
      LIMIT_UPGRADE_PER_SEC: '1',
      LIMIT_HELLO_TIMEOUT_MS: '0',
    });
  });

  after(async () => {
    for (const socket of open) socket.destroy();
    await killAll();
    await removeTempDir(dataDir);
  });

  test('the 4th socket from one address gets 429; another address still connects', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await upgradeAttempt(server, '192.0.2.10');
      assert.equal(res.status, 101);
      open.push(res.socket);
    }
    const refused = await upgradeAttempt(server, '192.0.2.10');
    assert.equal(refused.status, 429);
    assert.match(refused.body.error, /Too many connections/);
    const other = await upgradeAttempt(server, '192.0.2.11');
    assert.equal(other.status, 101);
    open.push(other.socket);
  });

  test('connecting too often from one address gets 429', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = await upgradeAttempt(server, '192.0.2.20');
      statuses.push(res.status);
      if (res.socket) {
        const closed = new Promise((resolve) => res.socket.once('close', resolve));
        res.socket.destroy();
        await closed;
        await sleep(20); // let the server see the close, so only the rate (not the cap) applies
      } else {
        assert.match(res.body.error, /too often/);
      }
    }
    assert.deepEqual(statuses, [101, 101, 101, 101, 101, 429]);
  });
});

// ---------------------------------------------------------------------------

describe('server: startup, saves and the instance lock', () => {
  const dirs = [];
  const newDir = () => {
    const dir = makeTempDir();
    dirs.push(dir);
    return dir;
  };

  after(async () => {
    await killAll();
    for (const dir of dirs) await removeTempDir(dir);
  });

  function writeSave(dir, id, state, secrets = {}) {
    fs.mkdirSync(path.join(dir, 'games'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'games', `${id}.json`), JSON.stringify({ version: 1, state, secrets }));
  }

  test('malformed saves are moved to corrupt/ and the valid game still resumes', async () => {
    const dir = newDir();
    let state = createGame({ id: 'g_gd2345', seed: 7, settings: {} });
    state = applyAction(state, { type: 'JOIN', playerId: 'p_aaaaaaaa', name: 'Ann', token: 'car' }).state;
    state = applyAction(state, { type: 'JOIN', playerId: 'p_bbbbbbbb', name: 'Ben', token: 'dog' }).state;
    state = applyAction(state, { type: 'START_GAME', playerId: 'p_aaaaaaaa' }).state;
    state.createdAt = state.updatedAt = Date.now();
    writeSave(dir, 'g_gd2345', state, { p_aaaaaaaa: 'a'.repeat(32), p_bbbbbbbb: 'b'.repeat(32) });
    writeSave(dir, 'g_aaaaaa', { id: 'g_aaaaaa', status: 'active', players: [null], turn: {}, tiles: [], settings: {} });
    writeSave(dir, 'g_bbbbbb', { id: 'g_bbbbbb', status: 'active', players: [], turn: {}, tiles: [], settings: {} });

    const server = await startServer(dir);
    assert.equal((await getJson(`${server.base}/health`)).body.games, 1);
    const corrupt = fs.readdirSync(path.join(dir, 'corrupt'));
    assert.equal(corrupt.filter((f) => f.startsWith('g_aaaaaa.json')).length, 1);
    assert.equal(corrupt.filter((f) => f.startsWith('g_bbbbbb.json')).length, 1);

    const ann = await connect(server, { gameId: 'g_gd2345', playerId: 'p_aaaaaaaa', token: 'a'.repeat(32) });
    await ann.welcome();
    const resumed = await ann.state();
    assert.equal(resumed.state.status, 'active');
    assert.ok(resumed.legal.actions.includes('ROLL'));
    ann.close();
    server.child.send('shutdown');
    assert.equal(await server.exited, 0);
  });

  test('a save that fails during shutdown is retried, reported by id, and the exit code is 1', async () => {
    const dir = newDir();
    const server = await startServer(dir);
    const { body } = await postGame(server); // unsaved: the first save of a new lobby is debounced
    fs.mkdirSync(path.join(dir, 'games', `${body.gameId}.json.tmp`)); // the atomic write can't create its temp file
    server.child.send('shutdown');
    assert.equal(await server.exited, 1);
    assert.match(server.text(), new RegExp(`FAILED to save: ${body.gameId}`));
    assert.equal((server.text().match(new RegExp(`saving ${body.gameId} failed`, 'g')) ?? []).length, 3, 'first try + 2 retries');
  });

  test('seats survive a hard kill right after START_GAME (saved at once, not on the debounce)', async () => {
    const dir = newDir();
    let server = await startServer(dir);
    const { body } = await postGame(server);
    const alice = await joinAs(server, body.gameId, 'Alice', 'car');
    const bob = await joinAs(server, body.gameId, 'Bob', 'dog');
    alice.send({ t: 'action', action: { type: 'START_GAME' } });
    const started = await alice.take((m) => m.t === 'state' && m.state.status === 'active', 'game start');
    await sleep(300); // well inside the 5 s debounce
    server.child.kill('SIGKILL');
    await server.exited;
    await Promise.all([alice.closed, bob.closed]);

    server = await startServer(dir); // the dead server's lock (dead pid) doesn't block this
    for (const c of [alice, bob]) {
      const again = await connect(server, { gameId: body.gameId, ...c.seat });
      const first = await again.take((m) => m.t === 'welcome' || m.t === 'error', 'welcome');
      assert.equal(first.t, 'welcome', JSON.stringify(first));
      const view = await again.state();
      assert.equal(view.state.status, 'active');
      assert.equal(view.state.seq, started.state.seq);
      again.close();
    }
    server.child.send('shutdown');
    assert.equal(await server.exited, 0);
  });

  test('a second server on the same DATA_DIR refuses to start until the first one is gone', async () => {
    const dir = newDir();
    const first = await startServer(dir);
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'instance.lock'), 'utf8'));
    assert.equal(lock.pid, first.child.pid);
    assert.equal(lock.hostname, os.hostname());

    const second = spawnServer(dir);
    assert.equal(await second.exited, 1);
    assert.match(second.text(), /another instance is using DATA_DIR/);
    assert.equal(fs.existsSync(path.join(dir, 'instance.lock')), true, "the refused server leaves the lock alone");

    first.child.send('shutdown');
    assert.equal(await first.exited, 0);
    assert.equal(fs.existsSync(path.join(dir, 'instance.lock')), false);
    const third = await startServer(dir);
    third.child.send('shutdown');
    assert.equal(await third.exited, 0);
  });
});
