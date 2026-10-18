// Lane D (city sound): the additive sfx.js API of design §14.1–14.3 — the new city one-shots, positional
// play through a PannerNode, the listener, loops (LOOP_NAMES, sfx.loop, renderLoopInto) and priorities.
// Its own strict mock AudioContext includes createPanner and an AudioListener (with and without the
// positionX AudioParams, like Chrome and Firefox).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sfx, SOUND_NAMES, LOOP_NAMES, soundBudget, renderInto, renderLoopInto, masterChainInto, isLoop,
} from '../public/sfx.js';

const CITY_NAMES = [
  'crowdAww', 'crowdOoh', 'applause', 'coinsIn', 'siren', 'whistleCop', 'hornCar', 'hornBus', 'bikeBell', 'tramBell',
  'trainHorn', 'brakeSqueal', 'skid', 'reverseBeep', 'hydraulicHop', 'meow', 'footstep', 'pawStep', 'engineStart',
  'doorSlam', 'ribbonSnip', 'confettiPop', 'firework', 'craneBeep', 'hammer', 'drill', 'demolishRumble', 'barrierArm',
  'gateSlide', 'chainFence', 'splitFlap', 'doormanBell', 'pigeonFlap', 'gull', 'foghorn', 'chirp', 'thunder',
  'timelapseRise', 'timelapseLand', 'stepTick', 'setComplete', 'outbid',
];
const CITY_LOOPS = [
  'engineRoadster', 'engineBubble', 'engineBoot', 'dieselBoat', 'pennyTick', 'cityHum', 'trafficBed', 'parkBed',
  'marketBed', 'harbourBed', 'windHigh', 'rainBed', 'constructionBed', 'crowdMurmur', 'nightBed', 'sirenLoop',
  'trainRumble', 'fountainBed',
];

// ---- strict mock -----------------------------------------------------------------------------------------

class MockParam {
  constructor(value) { this.value = value; this.events = []; this.last = value; this.lastTime = 0; }
  #at(kind, v, t) {
    assert.ok(Number.isFinite(v), `${kind}: value ${v} is not finite`);
    assert.ok(Number.isFinite(t) && t >= 0, `${kind}: time ${t}`);
    assert.ok(t >= this.lastTime - 1e-9, `${kind} at ${t} scheduled before an earlier event at ${this.lastTime}`);
    this.events.push([kind, v, t]);
    this.lastTime = t;
    this.last = v;
    return this;
  }
  setValueAtTime(v, t) { return this.#at('setValueAtTime', v, t); }
  linearRampToValueAtTime(v, t) { return this.#at('linearRamp', v, t); }
  exponentialRampToValueAtTime(v, t) {
    assert.ok(v !== 0, 'exponential ramp to 0');
    assert.ok(this.last !== 0 && Math.sign(this.last) === Math.sign(v), `exponential ramp from ${this.last} to ${v}`);
    return this.#at('exponentialRamp', v, t);
  }
  setTargetAtTime(v, t, tau) {
    assert.ok(Number.isFinite(tau) && tau > 0, `setTargetAtTime tau ${tau}`);
    return this.#at('setTarget', v, t);
  }
  cancelScheduledValues(t) { assert.ok(Number.isFinite(t)); this.lastTime = Math.min(this.lastTime, t); return this; }
  cancelAndHoldAtTime(t) { return this.cancelScheduledValues(t); }
}

class MockNode {
  constructor(ctx, kind) { this.ctx = ctx; this.kind = kind; this.outputs = []; ctx.nodes.push(this); }
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
    assert.ok(Number.isInteger(length) && length > 0);
    this.length = length; this.sampleRate = sampleRate; this.duration = length / sampleRate;
    this.channels = Array.from({ length: channels }, () => new Float32Array(length));
  }
  getChannelData(i) { return this.channels[i]; }
}

class MockListener {
  constructor(withParams) {
    if (withParams) {
      for (const p of ['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'upX', 'upZ', 'upY']) this[p] = new MockParam(0);
      this.forwardZ = new MockParam(-1);
      this.upY.value = 1;
    } else {
      this.calls = [];
    }
  }
  setPosition(...a) { assert.ok(a.length === 3 && a.every(Number.isFinite)); this.calls?.push(['setPosition', ...a]); }
  setOrientation(...a) { assert.ok(a.length === 6 && a.every(Number.isFinite)); this.calls?.push(['setOrientation', ...a]); }
}

class MockContext {
  constructor(sampleRate = 48000, { listenerParams = true } = {}) {
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.state = 'running';
    this.nodes = [];
    this.destination = new MockNode(this, 'destination');
    this.listener = new MockListener(listenerParams);
  }
  createGain() { const n = new MockNode(this, 'gain'); n.gain = new MockParam(1); return n; }
  createStereoPanner() { const n = new MockNode(this, 'stereo'); n.pan = new MockParam(0); return n; }
  createPanner() {
    const n = new MockNode(this, 'panner');
    for (const p of ['positionX', 'positionY', 'positionZ', 'orientationX', 'orientationY', 'orientationZ']) n[p] = new MockParam(0);
    Object.assign(n, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 1, maxDistance: 10000, rolloffFactor: 1 });
    return n;
  }
  createWaveShaper() { const n = new MockNode(this, 'shaper'); n.curve = null; return n; }
  createBuffer(ch, len, sr) { return new MockBuffer(ch, len, sr); }
  createOscillator() {
    const n = new MockSource(this, 'oscillator');
    n.type = 'sine'; n.frequency = new MockParam(440); n.detune = new MockParam(0);
    return n;
  }
  createBufferSource() {
    const n = new MockSource(this, 'bufferSource');
    n.buffer = null; n.loop = false; n.playbackRate = new MockParam(1);
    return n;
  }
  createBiquadFilter() {
    const n = new MockNode(this, 'biquad');
    n.type = 'lowpass'; n.frequency = new MockParam(350); n.Q = new MockParam(1); n.gain = new MockParam(0);
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

function reaches(node, ctx, seen = new Set()) {
  if (node === ctx.destination || node instanceof MockParam) return true;
  if (seen.has(node)) return false;
  seen.add(node);
  return node.outputs.some((o) => reaches(o, ctx, seen));
}

/** Every source starts no earlier than `from`, stops by `end` and is audible; frequencies are sane. */
function checkGraph(ctx, nodes, from, end, label) {
  const sources = nodes.filter((n) => n instanceof MockSource);
  assert.ok(sources.length > 0, `${label}: no sources`);
  const ny = ctx.sampleRate / 2;
  for (const s of sources) {
    assert.ok(s.startAt !== undefined && s.startAt >= from - 1e-9, `${label}: a ${s.kind} starts at ${s.startAt}`);
    assert.ok(s.stopAt !== undefined, `${label}: a ${s.kind} never stops`);
    assert.ok(s.stopAt <= end + 1e-6, `${label}: a ${s.kind} stops at ${s.stopAt.toFixed(3)}, after ${end.toFixed(3)}`);
    assert.ok(reaches(s, ctx), `${label}: a ${s.kind} is connected to nothing audible`);
    if (s.kind === 'oscillator') {
      assert.ok(s.frequency.value > 0 && s.frequency.value < ny, `${label}: oscillator at ${s.frequency.value} Hz`);
      for (const [, v] of s.frequency.events) assert.ok(v > 0 && v < ny, `${label}: oscillator at ${v} Hz`);
    }
    if (s.kind === 'bufferSource') assert.ok(s.buffer instanceof MockBuffer, `${label}: buffer source without a buffer`);
  }
  for (const n of nodes) {
    if (n.kind === 'biquad') {
      assert.ok(n.frequency.value > 0 && n.frequency.value < ny, `${label}: filter at ${n.frequency.value} Hz`);
      for (const [, v] of n.frequency.events) assert.ok(v > 0 && v < ny, `${label}: filter at ${v} Hz`);
    }
    if (n.kind === 'gain') assert.ok(Number.isFinite(n.gain.value), `${label}: gain ${n.gain.value}`);
  }
}

// ---- catalogue ----------------------------------------------------------------------------------------

test('on import: status() keeps its exact shape and nothing is running', () => {
  assert.deepEqual(sfx.status(), { state: 'none', voices: 0, played: 0, music: false });
  for (const fn of ['setListener', 'loop', 'stopLoops']) assert.equal(typeof sfx[fn], 'function', fn);
});

test('every city one-shot exists with a budget under 1 s; every loop exists; the two lists are disjoint', () => {
  for (const name of CITY_NAMES) {
    assert.ok(SOUND_NAMES.includes(name), `missing one-shot "${name}"`);
    const b = soundBudget(name);
    assert.ok(b > 0 && b < 1, `${name}: ${b} s`);
  }
  assert.deepEqual([...LOOP_NAMES].sort(), [...CITY_LOOPS].sort());
  const one = new Set(SOUND_NAMES);
  for (const name of LOOP_NAMES) {
    assert.ok(!one.has(name), `"${name}" is both a one-shot and a loop`);
    assert.ok(isLoop(name));
    assert.equal(soundBudget(name), 0, 'loops are not one-shots');
  }
  assert.equal(isLoop('coin'), false);
  assert.equal(isLoop('__proto__'), false);
});

test('every city one-shot renders a valid graph within its budget at rates 0.5, 1 and 2 (stereo and placed)', () => {
  for (const [rate, sr] of [[0.5, 44100], [1, 48000], [2, 48000]]) {
    for (const pos of [null, { x: 30, y: 2, z: -12 }]) {
      const ctx = new MockContext(sr);
      const chain = masterChainInto(ctx, ctx.destination, 1);
      let when = 0.05;
      for (const name of CITY_NAMES) {
        const before = ctx.nodes.length;
        const end = renderInto(ctx, chain.sfx, name, when, { rate, pan: 0.3, seed: 5, pos });
        assert.ok(Math.abs(end - (when + soundBudget(name) / rate)) < 1e-9, `${name}: end`);
        const nodes = ctx.nodes.slice(before);
        checkGraph(ctx, nodes, when, end, `${name} @ ${rate}${pos ? ' placed' : ''}`);
        if (pos) {
          const pn = nodes.find((n) => n.kind === 'panner');
          assert.ok(pn, `${name}: placed without a panner`);
          assert.equal(pn.panningModel, 'equalpower');
          assert.equal(pn.distanceModel, 'inverse');
          assert.equal(pn.maxDistance, 800);
          assert.deepEqual([pn.positionX.value, pn.positionY.value, pn.positionZ.value], [30, 2, -12]);
        }
        when = end + 0.1;
      }
    }
  }
});

test('refDistance follows the kind of sound (footsteps 2 … fireworks 150)', () => {
  const ctx = new MockContext();
  const ref = (name) => {
    const before = ctx.nodes.length;
    renderInto(ctx, ctx.destination, name, 0, { pos: { x: 1, y: 0, z: 1 } });
    return ctx.nodes.slice(before).find((n) => n.kind === 'panner').refDistance;
  };
  assert.equal(ref('footstep'), 2);
  assert.equal(ref('engineStart'), 6);
  assert.equal(ref('hornCar'), 10);
  assert.equal(ref('crowdAww'), 15);
  assert.equal(ref('hammer'), 20);
  assert.equal(ref('siren'), 40);
  assert.equal(ref('trainHorn'), 60);
  assert.equal(ref('firework'), 150);
  assert.equal(ref('coinsIn'), 10, 'default');
});

test('every loop renders for its window and stops cleanly, at rates 0.5, 1 and 2', () => {
  for (const [rate, sr] of [[0.5, 44100], [1, 48000], [2, 48000]]) {
    const ctx = new MockContext(sr);
    const chain = masterChainInto(ctx, ctx.destination, 1);
    let when = 0.1;
    for (const name of LOOP_NAMES) {
      const before = ctx.nodes.length;
      const end = renderLoopInto(ctx, chain.sfx, name, when, 3, { rate, seed: 9 });
      assert.ok(Math.abs(end - (when + 3)) < 1e-9, `${name}: end`);
      const nodes = ctx.nodes.slice(before);
      checkGraph(ctx, nodes, when, end, `loop ${name} @ ${rate}`);
      when = end + 0.2;
    }
  }
  assert.equal(renderLoopInto(new MockContext(), null, 'nope', 0, 2), 0);
  assert.equal(renderLoopInto(new MockContext(), null, 'coin', 0, 2), 0, 'a one-shot is not a loop');
  // short windows and placed loops
  const ctx = new MockContext();
  const before = ctx.nodes.length;
  const end = renderLoopInto(ctx, ctx.destination, 'trainRumble', 0, 0.3, { pos: { x: 100, z: 5 } });
  checkGraph(ctx, ctx.nodes.slice(before), 0, end, 'short placed loop');
  assert.ok(ctx.nodes.slice(before).some((n) => n.kind === 'panner'));
});

test('event loops schedule grains over the whole window (birds, gulls, ticks, rail joints)', () => {
  for (const name of ['parkBed', 'harbourBed', 'pennyTick', 'trainRumble', 'constructionBed', 'rainBed', 'trafficBed']) {
    const ctx = new MockContext();
    renderLoopInto(ctx, ctx.destination, name, 0, 30, { seed: 3 });
    const starts = ctx.nodes.filter((n) => n instanceof MockSource).map((s) => s.startAt).filter((t) => t > 0.05);
    assert.ok(starts.length > 3, `${name}: only ${starts.length} grains`);
    assert.ok(Math.max(...starts) > 20, `${name}: grains stop early (last at ${Math.max(...starts).toFixed(1)} s)`);
  }
});

// ---- Node (no WebAudio): harmless ------------------------------------------------------------------------

test('without WebAudio: positional play, setListener and loop never throw and stay silent', () => {
  assert.doesNotThrow(() => sfx.play('hornCar', { pos: { x: 1, y: 2, z: 3 } }));
  assert.doesNotThrow(() => sfx.play('hornCar', { pos: { x: NaN, z: 'a' }, priority: 7 }));
  for (const args of [[], [null], [{ x: 1, y: 1, z: 1 }], [{ x: 0, z: 0 }, { x: 0, z: -1 }, { x: 0, y: 1, z: 0 }], [{ x: 'a' }], ['nope', 5, 6]]) {
    assert.doesNotThrow(() => sfx.setListener(...args));
  }
  assert.doesNotThrow(() => sfx.play('siren', { pos: { x: 10, y: 0, z: 0 } }), 'with a listener but no context');
  for (const name of [...LOOP_NAMES, 'nope', null, '__proto__']) {
    let h;
    assert.doesNotThrow(() => { h = sfx.loop(name, { volume: 0.5, pos: { x: 1, z: 2 } }); });
    assert.equal(h.playing, false, `${name}: inert without audio`);
    assert.doesNotThrow(() => h.set({ volume: 1, rate: 2, pos: { x: 0, z: 0 }, pan: 3, lowpass: 900 }));
    assert.doesNotThrow(() => h.stop());
    assert.doesNotThrow(() => h.set(null));
  }
  assert.doesNotThrow(() => sfx.stopLoops());
  assert.deepEqual(sfx.status(), { state: 'none', voices: 0, played: 0, music: false });
});

// ---- with a (mock) live context ----------------------------------------------------------------------------

async function liveModule(tag, { listenerParams = true } = {}) {
  const saved = globalThis.AudioContext;
  const created = [];
  globalThis.AudioContext = class extends MockContext {
    constructor() { super(48000, { listenerParams }); created.push(this); }
  };
  const mod = await import(`../public/sfx.js?${tag}`);
  mod.sfx.unlock();
  await Promise.resolve();
  globalThis.AudioContext = saved;
  return { live: mod.sfx, ctx: created[0] };
}

test('live: positional play uses a panner once a listener is set, ≤ 16 at once, then stereo pan', async () => {
  const { live, ctx } = await liveModule('city-pos');
  assert.ok(ctx, 'a context was created by unlock()');
  // no listener yet: stereo
  let before = ctx.nodes.length;
  live.play('hornCar', { pos: { x: 5, y: 0, z: 0 } });
  assert.equal(live.status().played, 1);
  assert.ok(!ctx.nodes.slice(before).some((n) => n.kind === 'panner'), 'no panner without a listener');
  live.setListener({ x: 0, y: 1.7, z: 0 }, { x: 0, y: 0, z: -1 });
  assert.equal(ctx.listener.positionY.last, 1.7, 'listener params glide (setTargetAtTime)');
  assert.equal(ctx.listener.forwardZ.last, -1);
  before = ctx.nodes.length;
  live.play('bikeBell', { pos: { x: 12, y: 1, z: -3 } });
  const pn = ctx.nodes.slice(before).find((n) => n.kind === 'panner');
  assert.ok(pn, 'positional voice');
  assert.equal(pn.refDistance, 10);
  assert.deepEqual([pn.positionX.value, pn.positionY.value, pn.positionZ.value], [12, 1, -3]);
  const lp = ctx.nodes.slice(before).find((n) => n.kind === 'biquad' && n.type === 'lowpass' && n.outputs.includes(pn));
  assert.ok(lp && lp.frequency.value < 18000, 'distance low-pass in front of the panner');
  // fill up to 16 positional voices with different sounds, then the rest fall back to stereo
  const names = CITY_NAMES.filter((n) => n !== 'bikeBell' && n !== 'hornCar');
  let panners = 1;
  let stereo = 0;
  for (const name of names.slice(0, 24)) {
    before = ctx.nodes.length;
    live.play(name, { pos: { x: -20, y: 0, z: 4 }, delay: 0.5, priority: 1 });
    const fresh = ctx.nodes.slice(before);
    if (fresh.some((n) => n.kind === 'panner')) panners++;
    else if (fresh.some((n) => n.kind === 'stereo')) stereo++;
  }
  assert.equal(panners, 16, 'positional voices are capped at 16');
  assert.ok(stereo > 0, 'the rest fall back to stereo pan');
  assert.deepEqual(Object.keys(live.status()), ['state', 'voices', 'played', 'music']);
});

test('live: a burst of ≥ 12 voices within 100 ms drops priority-2 sounds first', async () => {
  const { live } = await liveModule('city-burst');
  const names = ['crowdAww', 'crowdOoh', 'applause', 'coinsIn', 'siren', 'whistleCop', 'hornBus', 'tramBell', 'trainHorn', 'brakeSqueal', 'skid', 'meow', 'doorSlam'];
  for (const name of names) live.play(name, { delay: 1 });
  const n = live.status().played;
  assert.equal(n, names.length);
  live.play('chirp', { delay: 1.02 });
  assert.equal(live.status().played, n, 'a P2 chirp is dropped in the burst');
  live.play('outbid', { delay: 1.02 });
  assert.equal(live.status().played, n + 1, 'a P0 sound still plays');
  live.play('drill', { delay: 1.03, priority: 2 });
  assert.equal(live.status().played, n + 1, 'explicit priority 2 is dropped too');
  live.play('chirp', { delay: 3 });
  assert.equal(live.status().played, n + 2, 'outside the burst a P2 sound plays');
});

test('live: loops start, glide, stop; they never count as voices and stop when sound is switched off', async () => {
  const { live, ctx } = await liveModule('city-loops');
  const voices0 = live.status().voices;
  live.setListener({ x: 0, y: 2, z: 0 }, { x: 0, y: 0, z: -1 });
  const bed = live.loop('parkBed', { volume: 0.4 });
  assert.equal(bed.playing, true);
  const before = ctx.nodes.length;
  const eng = live.loop('engineRoadster', { volume: 0.8, pos: { x: 10, y: 0.5, z: 0 } });
  const pn = ctx.nodes.slice(before).find((n) => n.kind === 'panner');
  assert.ok(pn, 'a placed loop runs through a panner');
  assert.equal(pn.refDistance, 6);
  assert.doesNotThrow(() => eng.set({ volume: 1, rate: 1.8, pos: { x: 14, y: 0.5, z: 2 }, lowpass: 3000 }));
  assert.equal(pn.positionX.last, 14, 'position glides');
  assert.doesNotThrow(() => bed.set({ volume: 0.2, pan: -0.5, lowpass: 1500, rate: 1.1 }));
  assert.equal(live.status().voices, voices0, 'loops are not one-shot voices');
  assert.deepEqual(Object.keys(live.status()), ['state', 'voices', 'played', 'music']);
  assert.equal(live.loop('nope').playing, false);
  eng.stop(0.2);
  assert.equal(eng.playing, false);
  assert.doesNotThrow(() => eng.set({ volume: 1 }));
  assert.doesNotThrow(() => eng.stop());
  const engineSources = ctx.nodes.slice(before).filter((n) => n instanceof MockSource);
  assert.ok(engineSources.every((s) => s.stopAt !== undefined), 'a stopped loop stops its sources');
  live.setEnabled(false);
  assert.equal(bed.playing, false, 'switching sound off stops the loops');
  assert.equal(live.loop('cityHum').playing, false, 'no loops while switched off');
  live.setEnabled(true);
  const again = live.loop('cityHum');
  assert.equal(again.playing, true);
  live.stopLoops();
  assert.equal(again.playing, false);
  // a hidden tab gives inert handles
  const hadDoc = 'document' in globalThis;
  const savedDoc = globalThis.document;
  globalThis.document = { visibilityState: 'hidden' };
  try {
    assert.equal(live.loop('cityHum').playing, false, 'inert while the tab is hidden');
  } finally {
    if (hadDoc) globalThis.document = savedDoc;
    else delete globalThis.document;
  }
});

test('live: a listener without AudioParams (Firefox) uses setPosition / setOrientation', async () => {
  const { live, ctx } = await liveModule('city-firefox', { listenerParams: false });
  live.setListener({ x: 3, y: 4, z: 5 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  assert.deepEqual(ctx.listener.calls.at(-2), ['setPosition', 3, 4, 5]);
  assert.deepEqual(ctx.listener.calls.at(-1), ['setOrientation', 1, 0, 0, 0, 1, 0]);
  assert.doesNotThrow(() => live.play('gull', { pos: { x: 50, y: 10, z: 0 } }));
  assert.doesNotThrow(() => live.setListener({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), 'zero forward');
});
