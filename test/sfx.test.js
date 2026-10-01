// public/sfx.js: the procedural sound engine (wave-4 brief §1). Node has no WebAudio, so these tests
// check that the module is harmless without it, keep its settings honest, and run every recipe
// against a strict mock AudioContext that rejects the automation mistakes a browser would punish
// (NaN times, exponential ramps from zero, sources that never stop or outlive their budget).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sfx, SOUND_NAMES, soundBudget, renderInto, renderMusicInto, masterChainInto, MUSIC_LOOP_SECONDS,
} from '../public/sfx.js';

// The names renderers and ui.js may call (brief §1). All must exist.
const BRIEF_NAMES = [
  'click', 'toggle', 'error', 'notify', 'offer', 'tick', 'open', 'close',
  'diceShake', 'diceThrow', 'diceBounce', 'diceSettle', 'doubles',
  'hop', 'land', 'whoosh', 'drive', 'bark', 'horn', 'purr', 'stomp', 'clink', 'squeak', 'hatSpin',
  'coin', 'coins', 'cashRegister', 'rent', 'passGo', 'tax',
  'cardDraw', 'cardFlip', 'jailSlam', 'jailFree',
  'build', 'hotel', 'demolish', 'stamp', 'unstamp', 'sold',
  'gavel', 'bid', 'auctionEnd', 'tradePropose', 'tradeAccept', 'tradeReject',
  'bankrupt', 'victory', 'cheer',
];

// ---------------------------------------------------------------------------
// A strict mock of the WebAudio graph
// ---------------------------------------------------------------------------

class MockParam {
  constructor(value) {
    this.value = value;
    this.events = [];
    this.last = value; // target value of the latest scheduled event
    this.lastTime = 0;
  }

  #at(kind, v, t) {
    assert.ok(Number.isFinite(v), `${kind}: value ${v} is not finite`);
    assert.ok(Number.isFinite(t) && t >= 0, `${kind}: time ${t} is not a finite, non-negative time`);
    assert.ok(t >= this.lastTime - 1e-9, `${kind} at ${t} scheduled before an earlier event at ${this.lastTime}`);
    this.events.push([kind, v, t]);
    this.lastTime = t;
    this.last = v;
    return this;
  }

  setValueAtTime(v, t) { return this.#at('setValueAtTime', v, t); }
  linearRampToValueAtTime(v, t) { return this.#at('linearRamp', v, t); }
  exponentialRampToValueAtTime(v, t) {
    assert.ok(v !== 0, 'exponential ramp to 0 throws in browsers');
    // From 0 or across a sign change the spec holds the old value and then jumps: an audible click.
    assert.ok(this.last !== 0 && Math.sign(this.last) === Math.sign(v), `exponential ramp from ${this.last} to ${v}`);
    return this.#at('exponentialRamp', v, t);
  }

  setTargetAtTime(v, t, tau) {
    assert.ok(Number.isFinite(tau) && tau > 0, `setTargetAtTime time constant ${tau}`);
    return this.#at('setTarget', v, t);
  }

  cancelScheduledValues(t) { assert.ok(Number.isFinite(t)); this.lastTime = Math.min(this.lastTime, t); return this; }
  cancelAndHoldAtTime(t) { return this.cancelScheduledValues(t); }
}

class MockNode {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.outputs = [];
    ctx.nodes.push(this);
  }

  connect(dest) {
    assert.ok(dest instanceof MockNode || dest instanceof MockParam, `${this.kind}.connect() to a non-node`);
    this.outputs.push(dest);
    return dest;
  }

  disconnect() { this.outputs = []; }
}

class MockSource extends MockNode {
  start(t = 0, offset = 0) {
    assert.equal(this.startAt, undefined, `${this.kind} started twice`);
    assert.ok(Number.isFinite(t) && t >= 0, `${this.kind}.start(${t})`);
    assert.ok(Number.isFinite(offset) && offset >= 0, `${this.kind}.start offset ${offset}`);
    this.startAt = t;
  }

  stop(t = 0) {
    assert.ok(this.startAt !== undefined, `${this.kind} stopped before it started`);
    assert.ok(Number.isFinite(t) && t >= this.startAt, `${this.kind}.stop(${t}) before its start ${this.startAt}`);
    this.stopAt = t;
  }
}

class MockBuffer {
  constructor(channels, length, sampleRate) {
    assert.ok(Number.isInteger(length) && length > 0, `buffer length ${length}`);
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: channels }, () => new Float32Array(length));
  }

  getChannelData(i) { return this.channels[i]; }
}

class MockContext {
  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.state = 'running';
    this.nodes = [];
    this.destination = new MockNode(this, 'destination');
  }

  createGain() { const n = new MockNode(this, 'gain'); n.gain = new MockParam(1); return n; }
  createStereoPanner() { const n = new MockNode(this, 'panner'); n.pan = new MockParam(0); return n; }
  createWaveShaper() { const n = new MockNode(this, 'shaper'); n.curve = null; return n; }
  createBuffer(ch, len, sr) { return new MockBuffer(ch, len, sr); }

  createOscillator() {
    const n = new MockSource(this, 'oscillator');
    n.type = 'sine';
    n.frequency = new MockParam(440);
    n.detune = new MockParam(0);
    return n;
  }

  createBufferSource() {
    const n = new MockSource(this, 'bufferSource');
    n.buffer = null;
    n.loop = false;
    n.playbackRate = new MockParam(1);
    return n;
  }

  createBiquadFilter() {
    const n = new MockNode(this, 'biquad');
    n.type = 'lowpass';
    n.frequency = new MockParam(350);
    n.Q = new MockParam(1);
    n.gain = new MockParam(0);
    return n;
  }

  createDynamicsCompressor() {
    const n = new MockNode(this, 'compressor');
    for (const p of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[p] = new MockParam(0);
    return n;
  }

  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
}

/** Whether `node`'s signal reaches the context's destination (or modulates a parameter). */
function reaches(node, ctx, seen = new Set()) {
  if (node === ctx.destination || node instanceof MockParam) return true;
  if (seen.has(node)) return false;
  seen.add(node);
  return node.outputs.some((o) => reaches(o, ctx, seen));
}

/** Checks every node a recipe created: sources start, stop by `end` and are audible or modulating. */
function checkNodes(ctx, nodes, end, label) {
  const sources = nodes.filter((n) => n instanceof MockSource);
  assert.ok(sources.length > 0, `${label}: no sources`);
  for (const s of sources) {
    assert.ok(s.startAt !== undefined, `${label}: a ${s.kind} never starts`);
    assert.ok(s.stopAt !== undefined, `${label}: a ${s.kind} never stops`);
    assert.ok(s.stopAt <= end + 1e-6, `${label}: a ${s.kind} stops at ${s.stopAt.toFixed(3)}, after its budget ${end.toFixed(3)}`);
    assert.ok(reaches(s, ctx), `${label}: a ${s.kind} is connected to nothing audible`);
    if (s.kind === 'oscillator') {
      for (const [, v] of s.frequency.events) assert.ok(v > 0 && v < ctx.sampleRate / 2, `${label}: oscillator at ${v} Hz`);
    }
    if (s.kind === 'bufferSource') assert.ok(s.buffer instanceof MockBuffer, `${label}: buffer source without a buffer`);
  }
  for (const n of nodes) {
    if (n.kind === 'biquad') {
      for (const [, v] of n.frequency.events) assert.ok(v > 0 && v < ctx.sampleRate / 2, `${label}: filter at ${v} Hz`);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('importing sfx.js in Node works and exposes the brief\'s API', () => {
  for (const fn of ['play', 'unlock', 'setEnabled', 'isEnabled', 'setVolume', 'getVolume', 'setMusic', 'isMusicOn', 'status']) {
    assert.equal(typeof sfx[fn], 'function', fn);
  }
  assert.deepEqual(sfx.status(), { state: 'none', voices: 0, played: 0, music: false });
});

test('every sound the brief names exists, with a budget within the brief\'s limits', () => {
  for (const name of BRIEF_NAMES) assert.ok(SOUND_NAMES.includes(name), `missing sound "${name}"`);
  assert.equal(new Set(SOUND_NAMES).size, SOUND_NAMES.length);
  const long = new Set(['passGo', 'jailSlam', 'jailFree', 'hotel', 'cashRegister', 'bankrupt', 'victory', 'cheer', 'notify']);
  for (const name of SOUND_NAMES) {
    const budget = soundBudget(name);
    assert.ok(budget > 0 && budget <= 4, `${name}: budget ${budget}`);
    if (!long.has(name)) assert.ok(budget < 1, `${name}: ${budget} s is long for an everyday sound`);
  }
  assert.equal(soundBudget('nope'), 0);
});

test('play() is a harmless no-op without WebAudio, whatever it is given', () => {
  for (const name of SOUND_NAMES) assert.equal(sfx.play(name), undefined);
  const odd = [undefined, null, 42, 'nope', '__proto__', 'constructor', 'toString', {}, []];
  for (const name of odd) assert.doesNotThrow(() => sfx.play(name));
  const opts = [null, 'loud', { volume: NaN, rate: -1, delay: Infinity, pan: 9 }, { volume: '1' }, { delay: 450 }];
  for (const o of opts) assert.doesNotThrow(() => sfx.play('coin', o));
  assert.doesNotThrow(() => sfx.unlock());
  assert.equal(sfx.status().played, 0);
});

test('settings clamp and round-trip (without storage)', () => {
  assert.equal(sfx.isEnabled(), true);
  assert.equal(sfx.getVolume(), 0.7);
  assert.equal(sfx.isMusicOn(), false);
  sfx.setVolume(1.7);
  assert.equal(sfx.getVolume(), 1);
  sfx.setVolume(-3);
  assert.equal(sfx.getVolume(), 0);
  sfx.setVolume('0.25');
  assert.equal(sfx.getVolume(), 0.25);
  sfx.setVolume(NaN);
  assert.equal(sfx.getVolume(), 0.25);
  sfx.setVolume(0.7);
  sfx.setMusic(1);
  assert.equal(sfx.isMusicOn(), true);
  sfx.setMusic(false);
  sfx.setEnabled(0);
  assert.equal(sfx.isEnabled(), false);
  sfx.setEnabled(true);
  assert.equal(sfx.isEnabled(), true);
});

test('every recipe schedules a valid graph that stops within its budget, at any rate', () => {
  for (const [rate, sampleRate] of [[1, 48000], [0.5, 44100], [2.2, 48000]]) {
    const ctx = new MockContext(sampleRate);
    const chain = masterChainInto(ctx, ctx.destination, 1);
    let when = 0.05;
    for (const name of SOUND_NAMES) {
      const before = ctx.nodes.length;
      const end = renderInto(ctx, chain.sfx, name, when, { rate, pan: -0.4, seed: 7 });
      assert.ok(Math.abs(end - (when + soundBudget(name) / rate)) < 1e-9, `${name}: end time`);
      checkNodes(ctx, ctx.nodes.slice(before), end, `${name} @ rate ${rate}`);
      when = end + 0.1;
    }
  }
});

test('recipes are deterministic for a seed (offline renders are reproducible)', () => {
  const graph = (seed) => {
    const ctx = new MockContext();
    renderInto(ctx, ctx.destination, 'coins', 0, { seed });
    return ctx.nodes.filter((n) => n.kind === 'oscillator').map((n) => [n.frequency.value, n.startAt].join()).join('|');
  };
  assert.equal(graph(3), graph(3));
  assert.notEqual(graph(3), graph(4));
  assert.equal(renderInto(new MockContext(), null, 'nope'), 0);
});

test('the music loop schedules a valid, gap-free graph', () => {
  const ctx = new MockContext();
  const chain = masterChainInto(ctx, ctx.destination, 1);
  const seconds = MUSIC_LOOP_SECONDS * 2;
  renderMusicInto(ctx, chain.music, 0, seconds);
  const sources = ctx.nodes.filter((n) => n instanceof MockSource);
  checkNodes(ctx, ctx.nodes, seconds + 5, 'music');
  // Something is sounding at every moment of both loops (the pad and bass hold the harmony).
  for (let t = 0.5; t < seconds; t += 0.1) {
    assert.ok(sources.some((s) => s.startAt <= t && s.stopAt > t), `music silent at ${t.toFixed(1)} s`);
  }
  // Both loops schedule the same parts.
  const count = (from, to) => sources.filter((s) => s.startAt >= from && s.startAt < to).length;
  assert.equal(count(0, MUSIC_LOOP_SECONDS), count(MUSIC_LOOP_SECONDS, seconds));
});

test('with a (mock) AudioContext: silent until unlocked, then plays, limits voices, obeys the switch', async () => {
  const saved = globalThis.AudioContext;
  const created = [];
  globalThis.AudioContext = class extends MockContext {
    constructor() {
      super();
      this.state = 'suspended';
      created.push(this);
    }
  };
  try {
    const { sfx: live } = await import('../public/sfx.js?live');
    live.play('coin');
    assert.equal(created.length, 0, 'no context before unlock');
    live.unlock();
    assert.equal(created.length, 1);
    const ctx = created[0];
    await Promise.resolve();
    assert.equal(ctx.state, 'running');
    const before = ctx.nodes.length;
    live.play('coin', { volume: 0.8, pan: 0.5, delay: 0.2 });
    assert.ok(ctx.nodes.length > before, 'play() built a voice');
    assert.equal(live.status().played, 1);
    // Voice limits: a burst of the same sound at one instant plays once …
    for (let k = 0; k < 10; k++) live.play('hop', { delay: 0.5 + k * 0.001 });
    assert.equal(live.status().played, 2);
    // … and a one-voice sound doesn't stack over itself (notify lasts 1 s).
    live.play('notify', { delay: 2 });
    live.play('notify', { delay: 2.5 });
    assert.equal(live.status().played, 3);
    live.play('notify', { delay: 3.1 });
    assert.equal(live.status().played, 4);
    live.play('nope');
    assert.equal(live.status().played, 4);
    live.setEnabled(false);
    live.play('coin');
    assert.equal(live.status().played, 4, 'no sound while switched off');
    live.setEnabled(true);
    live.setMusic(true);
    assert.equal(live.status().music, true);
    live.setMusic(false);
    assert.equal(live.status().music, false);
  } finally {
    globalThis.AudioContext = saved;
  }
});

test('settings persist in localStorage["monopoly.audio"] and survive bad data', async () => {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  const hadWindow = 'window' in globalThis;
  globalThis.window = { localStorage, addEventListener() {} };
  try {
    store.set('monopoly.audio', JSON.stringify({ enabled: false, volume: 0.3, music: true }));
    const { sfx: a } = await import('../public/sfx.js?persist-a');
    assert.equal(a.isEnabled(), false);
    assert.equal(a.getVolume(), 0.3);
    assert.equal(a.isMusicOn(), true);
    a.setVolume(0.55);
    a.setEnabled(true);
    a.setMusic(false);
    assert.deepEqual(JSON.parse(store.get('monopoly.audio')), { enabled: true, volume: 0.55, music: false });

    store.set('monopoly.audio', '{not json');
    const { sfx: b } = await import('../public/sfx.js?persist-b');
    assert.deepEqual([b.isEnabled(), b.getVolume(), b.isMusicOn()], [true, 0.7, false]);

    store.set('monopoly.audio', JSON.stringify({ enabled: 'yes', volume: 7, music: null }));
    const { sfx: c } = await import('../public/sfx.js?persist-c');
    assert.deepEqual([c.isEnabled(), c.getVolume(), c.isMusicOn()], [true, 1, false]);
  } finally {
    if (!hadWindow) delete globalThis.window;
  }
});
