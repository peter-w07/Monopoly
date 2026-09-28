// End-to-end server test: spawns server/index.js on a free port with a temp DATA_DIR and talks to it
// over HTTP and WebSocket, including a graceful restart (IPC 'shutdown') and seat resume.
// Child processes are always killed and temp dirs removed, even when a test fails.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const SERVER = fileURLToPath(new URL('../server/index.js', import.meta.url));
const children = new Set();
let dataDir;

// Last-resort cleanup if the test process exits without running the after() hook.
process.on('exit', () => {
  for (const child of children) child.kill();
});

// ---------------------------------------------------------------------------
// Helpers

/** Start the server (PORT=0 → the OS picks a free port) and resolve once it is listening. */
function startServer() {
  const child = fork(SERVER, [], {
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir },
    silent: true, // pipe stdout/stderr (and keep the IPC channel for 'shutdown')
  });
  children.add(child);
  const exited = new Promise((resolve) => {
    child.once('exit', (code) => {
      children.delete(child);
      resolve(code);
    });
  });
  const output = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output.join('')}`)), 10_000);
    const onData = (chunk) => {
      output.push(chunk.toString());
      const match = /listening on http:\/\/localhost:(\d+)/.exec(output.join(''));
      if (match) {
        clearTimeout(timer);
        resolve({ child, exited, output, port: Number(match[1]), base: `http://127.0.0.1:${match[1]}` });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => output.push(chunk.toString()));
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code}):\n${output.join('')}`));
    });
  });
}

async function getJson(url, init) {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };
}

/** WebSocket client that buffers messages; take() returns the next matching one in arrival order. */
class Client {
  constructor(server) {
    this.ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
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

  close() {
    this.ws.close();
  }
}

async function connect(server, hello) {
  const client = new Client(server);
  await client.opened;
  if (hello) client.send({ t: 'hello', ...hello });
  return client;
}

// ---------------------------------------------------------------------------

describe('server', () => {
  let server;
  let gameId;
  let alice, bob;              // sockets
  let aliceSeat, bobSeat;      // { playerId, token } from welcome
  let lastSeq;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monopoly-server-test-'));
    server = await startServer();
  });

  after(async () => {
    for (const c of [alice, bob]) c?.ws.terminate();
    for (const child of [...children]) {
      child.kill();
      await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
    }
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test('GET /health', async () => {
    const { status, body } = await getJson(`${server.base}/health`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.games, 0);
    assert.equal(typeof body.uptime, 'number');
  });

  test('create, list and summarise a game', async () => {
    const created = await getJson(`${server.base}/api/games`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { maxPlayers: 4 } }),
    });
    assert.equal(created.status, 201);
    assert.match(created.body.gameId, /^g_[a-z2-9]{6}$/);
    gameId = created.body.gameId;

    const list = await getJson(`${server.base}/api/games`);
    const entry = list.body.games.find((g) => g.id === gameId);
    assert.deepEqual({ ...entry, createdAt: 0 }, { id: gameId, players: 0, maxPlayers: 4, hostName: null, createdAt: 0 });

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
    bob = await connect(server, { gameId });
    const first = await alice.state();
    assert.deepEqual(first.legal.actions, ['JOIN']);
    assert.equal(first.state.rng, undefined, 'public state hides the rng');
    assert.deepEqual(first.state.decks, { chance: { size: 16 }, community: { size: 16 } });
    await bob.state();

    alice.send({ t: 'action', action: { type: 'JOIN', name: 'Alice', token: 'car', playerId: 'p_spoofed' } });
    const welcomeA = await alice.take((m) => m.t === 'welcome', 'welcome');
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

    bob.send({ t: 'action', action: { type: 'JOIN', name: 'Bob', token: 'dog' } });
    const welcomeB = await bob.take((m) => m.t === 'welcome', 'welcome');
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

    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'games', `${gameId}.json`), 'utf8'));
    assert.equal(saved.state.seq, lastSeq, 'flushed on shutdown');
    assert.equal(fs.existsSync(path.join(dataDir, 'games', `${gameId}.json.tmp`)), false);

    server = await startServer();
    const summary = await getJson(`${server.base}/api/games/${gameId}`);
    assert.equal(summary.body.status, 'active');
    assert.deepEqual(summary.body.players.map((p) => p.connected), [false, false], 'everyone starts disconnected');

    alice = await connect(server, { gameId, ...aliceSeat });
    const welcome = await alice.take((m) => m.t === 'welcome', 'welcome');
    assert.deepEqual({ playerId: welcome.playerId, token: welcome.token }, aliceSeat);
    const resumed = await alice.state();
    assert.equal(resumed.state.seq, lastSeq, 'same seq after restart');
    assert.equal(resumed.state.players[0].connected, true);
    assert.equal(resumed.state.players[1].connected, false);
    assert.ok(resumed.legal.actions.length > 0, 'Alice can carry on with her turn');

    bob = await connect(server, { gameId, ...bobSeat });
    await bob.take((m) => m.t === 'welcome', 'welcome');
    assert.equal((await bob.state()).state.seq, lastSeq);

    // The game carries on: Alice plays a legal action and both see it.
    const [type] = resumed.legal.actions.filter((a) => a !== 'LEAVE');
    alice.send({ t: 'action', action: { type } });
    const moved = await bob.take((m) => m.t === 'state' && m.state.seq === lastSeq + 1, `state after ${type}`);
    assert.equal(moved.state.status, 'active');
  });
});
