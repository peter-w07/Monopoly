// public/sfx.js — procedural sound effects and an optional music loop, synthesised with WebAudio.
//
// There are no audio files: every sound is built from oscillators, noise buffers, filters and
// envelopes at the moment it plays, so nothing copyrighted ships and nothing has to download.
//
// API (wave-4 brief §1):
//   sfx.play(name, { volume = 1, rate = 1, delay = 0, pan = 0 })   fire-and-forget, never throws
//       volume  gain multiplier, 0..2
//       rate    pitch × rate and length ÷ rate, like a sample's playbackRate (0.25..4)
//       delay   SECONDS from now (values above 30 are taken as milliseconds, so `delay: 450` works too)
//       pan     -1 (left) .. 1 (right)
//     Unknown names, sound switched off, no unlock yet, a suspended context or a hidden tab: nothing.
//   sfx.unlock()             creates / resumes the AudioContext. Browsers only allow that from a user
//                            gesture, so it also runs by itself on every pointer, key or touch until
//                            audio is running. No sound is heard before that (and nothing is queued).
//   sfx.setEnabled(bool) / sfx.isEnabled()      master switch (off also suspends the context)
//   sfx.setVolume(0..1)  / sfx.getVolume()      master volume (perceptual curve: gain = volume²)
//   sfx.setMusic(bool)   / sfx.isMusicOn()      the background loop, default off
//   sfx.status()                                diagnostics: { state, voices, played, music }
// Settings persist in localStorage["monopoly.audio"] = { enabled, volume, music } (and follow changes
// made in another tab). The context is suspended while the tab is hidden.
//
// Who plays what: the renderers play event / animation sounds timed to their animations; ui.js plays
// the interface sounds (click, toggle, error, notify, offer, tick, open, close). Never both.
//
// Signal chain:  voices ──→ sfx bus ──┐
//                music loop → music bus ┴→ compressor (glue) → soft clip (peaks < 0.87) → volume → out
//
// Every recipe schedules into any BaseAudioContext, so the exact same code renders offline
// (renderInto / renderMusicInto) for tests and for the audition page. The module is safe to import
// anywhere, including Node: it touches window, document, storage and AudioContext only behind guards.

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const num = (x, fallback) => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);

/** Seeded PRNG (mulberry32) for noise buffers and reproducible offline renders. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOTE_STEPS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const noteCache = new Map();

/** Frequency of a note name ('A4' → 440, 'F#3', 'Bb5'); numbers pass through as Hz. */
function hzOf(note) {
  if (typeof note === 'number') return note;
  let f = noteCache.get(note);
  if (f === undefined) {
    const m = /^([A-G])([#b]?)(-?\d)$/.exec(note);
    const midi = NOTE_STEPS[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12;
    f = 440 * 2 ** ((midi - 69) / 12);
    noteCache.set(note, f);
  }
  return f;
}

// ---------------------------------------------------------------------------
// Synthesis toolkit
//
// A recipe receives a voice `v = { ctx, out, t, r, rnd }`: the context, the node to connect to, the
// start time (context seconds), the rate (pitches × r, times ÷ r) and a random source. Every helper
// takes a time offset `dt` in seconds from the voice start and schedules only finite, stopping nodes.
// ---------------------------------------------------------------------------

const perContext = new WeakMap(); // BaseAudioContext → cached buffers

function cacheOf(c) {
  let store = perContext.get(c);
  if (!store) perContext.set(c, (store = {}));
  return store;
}

const NOISE_SECONDS = 3;

/** 3 s of white, pink or brown noise (seeded, DC-free, RMS 0.3), cached per context. */
function noiseBuffer(c, color) {
  const store = cacheOf(c);
  if (store[color]) return store[color];
  const n = Math.floor(c.sampleRate * NOISE_SECONDS);
  const buf = c.createBuffer(1, n, c.sampleRate);
  const d = buf.getChannelData(0);
  const rnd = mulberry32(color === 'white' ? 11 : color === 'pink' ? 23 : 37);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd() * 2 - 1;
    if (color === 'white') {
      d[i] = w;
    } else if (color === 'pink') { // Paul Kellet's refined pink filter
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    } else { // brown: leaky integration of white noise
      last = (last + 0.02 * w) / 1.02;
      d[i] = last;
    }
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += d[i];
  mean /= n;
  let sq = 0;
  for (let i = 0; i < n; i++) sq += (d[i] -= mean) ** 2;
  const k = 0.3 / Math.sqrt(sq / n || 1);
  for (let i = 0; i < n; i++) d[i] *= k;
  return (store[color] = buf);
}

const T = (v, dt) => v.t + dt / v.r; // context time of an offset within the voice
const nyquist = (c) => c.sampleRate * 0.45;

function gainNode(c, value = 0) {
  const g = c.createGain();
  g.gain.value = value;
  return g;
}

function filterNode(c, type, freq, q = 0.707) {
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.value = Math.min(freq, nyquist(c));
  f.Q.value = q;
  return f;
}

function oscNode(c, type, freq, t0, t1) {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.start(t0);
  o.stop(t1);
  return o;
}

/**
 * Percussive envelope: 0 → peak over `a` s (at least 1 ms, so no onset click), then an exponential
 * fall reaching -60 dB `d` s later, then a 5 ms ramp to true silence (no click when the source
 * stops). Returns the end time.
 */
function perc(param, t, peak, a, d) {
  const p = Math.max(peak, 1e-5);
  const A = Math.max(a, 0.001);
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(p, t + A);
  param.exponentialRampToValueAtTime(p * 1e-3, t + A + d);
  param.linearRampToValueAtTime(0, t + A + d + 0.005);
  return t + A + d + 0.005;
}

/** Held envelope: 0 → peak over `a`, easing to `sustain`×peak over `hold`, then a -60 dB fall over `r`. */
function held(param, t, peak, a, hold, r, sustain = 1) {
  const p = Math.max(peak, 1e-5);
  const A = Math.max(a, 0.001);
  const H = Math.max(hold, 0);
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(p, t + A);
  param.linearRampToValueAtTime(p * sustain, t + A + H);
  param.exponentialRampToValueAtTime(p * sustain * 1e-3, t + A + H + r);
  param.linearRampToValueAtTime(0, t + A + H + r + 0.005);
  return t + A + H + r + 0.005;
}

/** A sub-voice panned by `p` (on top of the voice's own pan). */
function panned(v, p) {
  if (typeof v.ctx.createStereoPanner !== 'function') return v;
  const node = v.ctx.createStereoPanner();
  node.pan.value = clamp(p, -1, 1);
  node.connect(v.out);
  return { ...v, out: node };
}

/**
 * Sum of decaying sine partials — the physical-model shortcut for struck things.
 * partials: [ratio, gain, t60 seconds]; `decay` scales every t60.
 */
function modal(v, dt, freq, partials, peak, { decay = 1, attack = 0.001, dest = v.out } = {}) {
  const c = v.ctx;
  const t = T(v, dt);
  const f0 = hzOf(freq) * v.r;
  for (const [ratio, g, t60] of partials) {
    const f = f0 * ratio;
    if (f >= nyquist(c)) continue;
    const o = c.createOscillator();
    o.frequency.value = f;
    const e = gainNode(c);
    const end = perc(e.gain, t, peak * g, attack, (t60 * decay) / v.r);
    o.connect(e).connect(dest);
    o.start(t);
    o.stop(end);
  }
}

/**
 * A filtered noise burst. `path: [[dt, hz], …]` sweeps the filter (exponentially) instead of a fixed `f`.
 * With `hold` the envelope is held (swells, rumbles); otherwise percussive.
 */
function hiss(v, dt, {
  color = 'white', type = 'bandpass', f = 1000, path = null, q = 0.8,
  a = 0.002, hold = 0, d = 0.1, peak = 0.2, dest = v.out,
} = {}) {
  const c = v.ctx;
  const t = T(v, dt);
  const flt = filterNode(c, type, f * v.r, q);
  if (path) {
    const ny = nyquist(c);
    flt.frequency.setValueAtTime(Math.min(path[0][1] * v.r, ny), t + path[0][0] / v.r);
    for (const [pt, pf] of path.slice(1)) flt.frequency.exponentialRampToValueAtTime(Math.min(pf * v.r, ny), t + pt / v.r);
  }
  const e = gainNode(c);
  const end = hold > 0 ? held(e.gain, t, peak, a / v.r, hold / v.r, d / v.r) : perc(e.gain, t, peak, a / v.r, d / v.r);
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, color);
  src.loop = true;
  src.connect(flt).connect(e).connect(dest);
  src.start(t, v.rnd() * (NOISE_SECONDS - 2.6));
  src.stop(end);
  return end;
}

/**
 * One oscillator note: optional glide to `f2` (over `glide` s, default the whole note), low-pass,
 * vibrato (`vib` = depth as a fraction of the pitch) and a percussive or held envelope.
 */
function tone(v, dt, {
  type = 'sine', f = 440, f2 = 0, glide = 0, a = 0.004, hold = 0, d = 0.15, sustain = 1, peak = 0.2,
  lp = 0, q = 0.707, vib = 0, vibRate = 5.5, dest = v.out,
} = {}) {
  const c = v.ctx;
  const t = T(v, dt);
  const F = hzOf(f) * v.r;
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(F, t);
  const e = gainNode(c);
  const end = hold > 0 ? held(e.gain, t, peak, a / v.r, hold / v.r, d / v.r, sustain) : perc(e.gain, t, peak, a / v.r, d / v.r);
  if (f2) o.frequency.exponentialRampToValueAtTime(hzOf(f2) * v.r, glide ? t + glide / v.r : end);
  let node = o;
  if (lp) node = node.connect(filterNode(c, 'lowpass', lp * v.r, q));
  node.connect(e).connect(dest);
  if (vib) {
    const depth = gainNode(c, F * vib);
    oscNode(c, 'sine', vibRate, t, end).connect(depth).connect(o.frequency);
  }
  o.start(t);
  o.stop(end);
  return end;
}

// Partial sets: [ratio, gain, t60 s].
const WOOD = [[1, 1, 0.1], [2.76, 0.45, 0.05], [5.4, 0.2, 0.025]]; // wood block / knock
const DIE = [[1, 1, 0.05], [2.3, 0.55, 0.03], [3.9, 0.3, 0.018]]; // small hard die
const BAR = [[1, 1, 1], [2.76, 0.28, 0.45], [5.4, 0.1, 0.2], [8.93, 0.04, 0.1]]; // glockenspiel bar
const MARIMBA = [[1, 1, 1], [3.93, 0.2, 0.28], [9.2, 0.05, 0.09]]; // tuned wooden bar
const COMB = [[1, 1, 1], [6.27, 0.14, 0.14]]; // music-box tooth
const BELL = [[1, 1, 1], [2.32, 0.5, 0.6], [4.25, 0.3, 0.35], [6.63, 0.18, 0.2], [9.38, 0.08, 0.12]]; // small bell
const COIN = [[1, 1, 1], [1.006, 0.6, 0.9], [2.01, 0.3, 0.45], [3.02, 0.12, 0.25], [4.23, 0.08, 0.15]]; // coin chime
const METAL = [[1, 1, 1], [2.41, 0.6, 0.75], [3.93, 0.45, 0.55], [5.84, 0.3, 0.35], [7.1, 0.2, 0.25]]; // heavy bars
const TIMPANI = [[1, 1, 0.9], [1.5, 0.5, 0.6], [1.98, 0.25, 0.4], [2.44, 0.12, 0.3]];

// --- instruments -------------------------------------------------------------

/** A short wooden knock: bar modes plus the stick's click. */
function knock(v, dt, f, peak, decay = 1) {
  modal(v, dt, f, WOOD, peak, { decay, attack: 0.001 });
  hiss(v, dt, { f: Math.min(f * 2.5, 9000), q: 1, a: 0.001, d: 0.012 * decay, peak: peak * 0.3 });
}

function mallet(v, dt, peak, f) {
  hiss(v, dt, { f, q: 0.7, a: 0.001, d: 0.012, peak });
}

function marimba(v, dt, note, peak, decay = 0.5) {
  modal(v, dt, note, MARIMBA, peak, { decay, attack: 0.002 });
  mallet(v, dt, peak * 0.12, 2200);
}

function glock(v, dt, note, peak, decay = 0.8) {
  modal(v, dt, note, BAR, peak, { decay, attack: 0.001 });
  mallet(v, dt, peak * 0.08, 5000);
}

function musicBox(v, dt, note, peak, decay = 1) {
  modal(v, dt, note, COMB, peak, { decay, attack: 0.0015 });
  mallet(v, dt, peak * 0.05, 6500);
}

function coinAt(v, dt, f, peak, decay = 0.5) {
  modal(v, dt, f, COIN, peak, { decay, attack: 0.001 });
  hiss(v, dt, { type: 'highpass', f: 6000, a: 0.001, d: 0.01, peak: peak * 0.25 });
}

function clinkAt(v, dt, f, peak, decay = 0.3) {
  modal(v, dt, f, BELL, peak, { decay, attack: 0.001 });
}

/** A thud: a sine that drops in pitch (kick drum, stomp, board thump). */
function thump(v, dt, f1, f2, d, peak) {
  tone(v, dt, { f: f1, f2, glide: d * 0.6, a: 0.0015, d, peak });
}

function timpani(v, dt, note, peak, decay = 1) {
  const f = hzOf(note);
  modal(v, dt, f, TIMPANI, peak, { decay, attack: 0.002 });
  thump(v, dt, f * 1.6, f, 0.12, peak * 0.4);
}

function crash(v, dt, peak, d = 1.2) {
  hiss(v, dt, { type: 'highpass', f: 5000, q: 0.5, a: 0.002, d, peak });
  hiss(v, dt, { f: 8500, q: 1, a: 0.002, d: d * 0.5, peak: peak * 0.6 });
}

/**
 * Brass-ish note: two detuned saws through a low-pass whose cutoff blooms with the attack, a small
 * pitch scoop into the note, optional vibrato and an optional "wah" (muted trombone) filter shape.
 */
function brass(v, dt, note, len, peak, { vib = 0, bright = 4.5, wah = false, dest = v.out } = {}) {
  const c = v.ctx;
  const t = T(v, dt);
  const s = (sec) => sec / v.r; // every time scales with the rate
  const L = s(Math.max(0.05, len));
  const F = hzOf(note) * v.r;
  const ny = nyquist(c);
  const cut = (k) => Math.min(F * k, ny);
  const e = gainNode(c);
  const end = held(e.gain, t, peak, s(0.022), L - s(0.022), s(0.1), 0.8);
  const lp = filterNode(c, 'lowpass', cut(1.1), 1.4);
  lp.frequency.setValueAtTime(cut(1.1), t);
  if (wah) {
    lp.frequency.linearRampToValueAtTime(cut(bright), t + L * 0.35);
    lp.frequency.exponentialRampToValueAtTime(cut(1.3), t + L + s(0.1));
  } else {
    lp.frequency.linearRampToValueAtTime(cut(bright), t + s(0.05));
    lp.frequency.exponentialRampToValueAtTime(cut(bright * 0.6), t + L + s(0.1));
  }
  const mix = gainNode(c, 0.5);
  let depth = null;
  if (vib) {
    depth = gainNode(c);
    depth.gain.setValueAtTime(0, t);
    depth.gain.linearRampToValueAtTime(F * vib, t + Math.min(s(0.3), L));
    oscNode(c, 'sine', 5.6, t, end).connect(depth);
  }
  for (const k of [1, 1.0045]) {
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(F * k * 0.985, t);
    o.frequency.exponentialRampToValueAtTime(F * k, t + s(0.045));
    if (depth) depth.connect(o.frequency);
    o.connect(mix);
    o.start(t);
    o.stop(end);
  }
  mix.connect(lp).connect(e).connect(dest);
  return end;
}

/** A soft electric-piano note (two-operator FM whose brightness fades) for the music loop's chords. */
function epiano(v, dt, note, peak, decay = 1.4) {
  const c = v.ctx;
  const t = T(v, dt);
  const F = hzOf(note) * v.r;
  const e = gainNode(c);
  const end = perc(e.gain, t, peak, 0.006, decay / v.r);
  const car = oscNode(c, 'sine', F, t, end);
  const index = gainNode(c);
  index.gain.setValueAtTime(F * 1.1, t);
  index.gain.exponentialRampToValueAtTime(F * 0.15, t + 0.6 / v.r);
  oscNode(c, 'sine', F, t, end).connect(index).connect(car.frequency);
  car.connect(e).connect(v.out);
}

/** A formant "voice" (bark, meow, crowd "yay"): a saw through parallel band-passes. */
function formantVoice(v, dt, { path, formants, a, hold, d, peak, trem = 0, tremRate = 25, vib = 0 }) {
  const c = v.ctx;
  const t = T(v, dt);
  const o = c.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(path[0][1] * v.r, t);
  for (const [pt, pf] of path.slice(1)) o.frequency.exponentialRampToValueAtTime(pf * v.r, t + pt / v.r);
  const e = gainNode(c);
  const end = held(e.gain, t, peak, a / v.r, hold / v.r, d / v.r, 0.85);
  let src = o;
  if (trem) { // amplitude flutter (a purr's "rrr"), fading out after the first 0.2 s
    const am = gainNode(c, 1);
    const depth = gainNode(c);
    depth.gain.setValueAtTime(trem, t);
    depth.gain.linearRampToValueAtTime(0, t + 0.2 / v.r);
    oscNode(c, 'sine', tremRate, t, end).connect(depth).connect(am.gain);
    o.connect(am);
    src = am;
  }
  if (vib) {
    const depth = gainNode(c, path[0][1] * v.r * vib);
    oscNode(c, 'sine', 5 + v.rnd() * 2, t, end).connect(depth).connect(o.frequency);
  }
  for (const fm of formants) {
    const flt = filterNode(c, 'bandpass', fm.f * v.r, fm.q);
    if (fm.path) {
      flt.frequency.setValueAtTime(fm.path[0][1] * v.r, t);
      for (const [pt, pf] of fm.path.slice(1)) flt.frequency.exponentialRampToValueAtTime(pf * v.r, t + pt / v.r);
    }
    const g = gainNode(c, fm.g);
    src.connect(flt).connect(g).connect(e);
  }
  e.connect(v.out);
  o.start(t);
  o.stop(end);
  return end;
}

/** A cheering whistle: a sine swooping up with a little vibrato. */
function whistle(v, dt, peak) {
  tone(v, dt, { f: 1250 + v.rnd() * 200, f2: 2300, glide: 0.2, a: 0.04, hold: 0.18, d: 0.18, sustain: 0.7, peak, vib: 0.012, vibRate: 7 });
}

/** ~520 hand claps of varying colour and strength, pre-rendered once per context (applause). */
function applauseBuffer(c) {
  const store = cacheOf(c);
  if (store.applause) return store.applause;
  const sr = c.sampleRate;
  const len = 2.2;
  const n = Math.floor(sr * len);
  const buf = c.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  const rnd = mulberry32(7);
  const density = (x) => (x < 0.25 ? x / 0.25 : x < 0.9 ? 1 : Math.exp(-(x - 0.9) / 0.35));
  for (let claps = 0; claps < 520;) {
    const x = rnd() * (len - 0.1);
    if (rnd() > density(x)) continue;
    claps++;
    const start = Math.floor(x * sr);
    const tau = (0.003 + rnd() * 0.006) * sr;
    const fall = Math.exp(-1 / tau); // per-sample decay of the clap
    const colour = 0.3 + rnd() * 0.6; // one-pole low-pass: every clapper sounds a bit different
    let env = (0.25 + rnd() * 0.75) * density(x);
    let y = 0;
    for (let i = 0, m = Math.min(n - start, Math.ceil(tau * 6)); i < m; i++) {
      y += colour * (rnd() * 2 - 1 - y);
      d[start + i] += env * y;
      env *= fall;
    }
  }
  let mean = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) mean += d[i];
  mean /= n;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs((d[i] -= mean)));
  const fade = Math.floor(sr * 0.05);
  for (let i = 0; i < n; i++) d[i] *= (0.8 / (peak || 1)) * Math.min(1, i / 64, (n - 1 - i) / fade);
  return (store.applause = buf);
}

// ---------------------------------------------------------------------------
// The sounds
//
// dur: budget in seconds at rate 1 (every node stops by then; the audition checks it);
// max: concurrent voices of that name; vary: random pitch spread (0 for anything musical, so chimes
// stay in tune); duck: dips the music while it plays; gain: loudness trim (calibrated by measurement).
// ---------------------------------------------------------------------------

const SOUNDS = {
  // --- interface (ui.js) -------------------------------------------------------
  click: { dur: 0.08, max: 4, vary: 0.04, gain: 1.1, fn(v) {
    knock(v, 0, 1900, 0.22, 0.35);
  } },
  toggle: { dur: 0.12, max: 2, vary: 0.03, gain: 0.93, fn(v) {
    knock(v, 0, 1500, 0.18, 0.3);
    knock(v, 0.045, 2250, 0.2, 0.35);
  } },
  error: { dur: 0.45, max: 1, vary: 0, gain: 0.8, fn(v) { // a soft, low "bonk-bonk"
    tone(v, 0, { type: 'square', f: 'Eb4', a: 0.004, hold: 0.07, d: 0.09, sustain: 0.7, peak: 0.1, lp: 1300 });
    tone(v, 0.13, { type: 'square', f: 'Bb3', a: 0.004, hold: 0.1, d: 0.16, sustain: 0.7, peak: 0.11, lp: 1000 });
  } },
  notify: { dur: 1.0, max: 1, vary: 0, gain: 0.68, fn(v) { // "your turn": a friendly rising fourth
    marimba(v, 0, 'G5', 0.3, 0.6);
    glock(v, 0, 'G6', 0.06, 0.5);
    marimba(v, 0.16, 'C6', 0.34, 0.75);
    glock(v, 0.16, 'C7', 0.07, 0.7);
  } },
  offer: { dur: 0.9, max: 1, vary: 0, gain: 0.6, fn(v) { // trade offer received: a bright three-note bell
    musicBox(v, 0, 'E6', 0.22, 0.55);
    musicBox(v, 0.09, 'G#6', 0.22, 0.55);
    musicBox(v, 0.18, 'B6', 0.25, 0.65);
    marimba(v, 0.18, 'E5', 0.12, 0.5);
  } },
  tick: { dur: 0.07, max: 2, vary: 0.01, gain: 1.1, fn(v) { // auction countdown
    knock(v, 0, 2600, 0.22, 0.3);
  } },
  open: { dur: 0.2, max: 2, vary: 0.02, gain: 1.8, fn(v) {
    tone(v, 0, { f: 380, f2: 760, glide: 0.09, a: 0.006, d: 0.1, peak: 0.1 });
    hiss(v, 0, { path: [[0, 900], [0.12, 2600]], q: 1.2, a: 0.03, d: 0.08, peak: 0.05 });
  } },
  close: { dur: 0.18, max: 2, vary: 0.02, gain: 2.1, fn(v) {
    tone(v, 0, { f: 700, f2: 380, glide: 0.08, a: 0.004, d: 0.09, peak: 0.09 });
    hiss(v, 0, { path: [[0, 2400], [0.1, 900]], q: 1.2, a: 0.01, d: 0.08, peak: 0.05 });
  } },

  // --- dice ------------------------------------------------------------------------
  diceShake: { dur: 0.6, max: 1, vary: 0.04, gain: 1, fn(v) { // two dice rattling in a cupped hand
    let at = 0;
    for (let k = 0; k < 11; k++) {
      modal(v, at, 2400 + v.rnd() * 1800, DIE, 0.08 + v.rnd() * 0.1, { decay: 0.4 });
      hiss(v, at, { f: 3500, q: 1.5, a: 0.001, d: 0.008, peak: 0.07 });
      at += 0.028 + v.rnd() * 0.022;
    }
    hiss(v, 0, { f: 1800, q: 0.8, a: 0.05, hold: 0.3, d: 0.1, peak: 0.03 });
  } },
  diceThrow: { dur: 0.35, max: 1, vary: 0.04, gain: 1.75, fn(v) { // release: a short whoosh and a last clack
    hiss(v, 0, { path: [[0, 700], [0.22, 2600]], q: 1, a: 0.06, d: 0.16, peak: 0.12 });
    modal(v, 0, 3000 + v.rnd() * 800, DIE, 0.12, { decay: 0.5 });
    modal(v, 0.03, 2600 + v.rnd() * 800, DIE, 0.09, { decay: 0.5 });
  } },
  diceBounce: { dur: 0.15, max: 6, gap: 0.012, vary: 0.05, gain: 1, fn(v) { // a die hitting the board
    thump(v, 0, 190, 120, 0.06, 0.32);
    modal(v, 0, 1500 + v.rnd() * 1100, DIE, 0.22);
    hiss(v, 0, { f: 4000, q: 0.8, a: 0.001, d: 0.012, peak: 0.1 });
  } },
  diceSettle: { dur: 0.32, max: 1, vary: 0.04, gain: 0.97, fn(v) { // a die rocking to rest
    const hits = [[0, 0.2], [0.075, 0.14], [0.13, 0.1], [0.17, 0.07], [0.2, 0.05]];
    thump(v, 0, 170, 110, 0.05, 0.18);
    for (const [at, g] of hits) {
      modal(v, at, 1700 + v.rnd() * 900, DIE, g, { decay: 0.8 });
      hiss(v, at, { f: 4200, q: 0.8, a: 0.001, d: 0.008, peak: g * 0.4 });
    }
  } },
  doubles: { dur: 0.95, max: 1, vary: 0, gain: 0.64, fn(v) {
    glock(v, 0, 'C6', 0.28, 0.6);
    glock(v, 0.1, 'G6', 0.3, 0.75);
    musicBox(v, 0.22, 'C7', 0.09, 0.5);
    musicBox(v, 0.27, 'E7', 0.08, 0.5);
    musicBox(v, 0.32, 'G7', 0.07, 0.45);
  } },

  // --- movement ----------------------------------------------------------------------
  hop: { dur: 0.12, max: 4, gap: 0.02, vary: 0.03, gain: 1.33, fn(v) { // a token touching down; rate per token
    knock(v, 0, 820, 0.15, 0.45);
    tone(v, 0, { f: 330, f2: 440, glide: 0.04, a: 0.002, d: 0.06, peak: 0.07 });
  } },
  land: { dur: 0.28, max: 2, vary: 0.03, gain: 1, fn(v) { // the last hop: a heavier "thock" and a settle
    knock(v, 0, 520, 0.26, 0.9);
    thump(v, 0, 170, 85, 0.12, 0.34);
    hiss(v, 0, { type: 'lowpass', f: 1200, a: 0.001, d: 0.03, peak: 0.1 });
    knock(v, 0.065, 700, 0.08, 0.4);
  } },
  whoosh: { dur: 0.5, max: 2, vary: 0.05, gain: 1.6, fn(v) { // teleports and camera cuts
    hiss(v, 0, { color: 'pink', path: [[0, 350], [0.2, 2600], [0.44, 700]], q: 1.4, a: 0.2, d: 0.24, peak: 0.35 });
    hiss(v, 0, { type: 'highpass', f: 3000, a: 0.18, d: 0.15, peak: 0.03 });
  } },
  drive: { dur: 0.75, max: 1, vary: 0.03, gain: 0.54, fn(v) { // toy car: "brrm-brrm" revving off
    const c = v.ctx;
    const t = T(v, 0);
    const e = gainNode(c);
    const end = held(e.gain, t, 0.3, 0.04 / v.r, 0.45 / v.r, 0.15 / v.r, 0.7);
    const lp = filterNode(c, 'lowpass', 700 * v.r, 2);
    const putt = gainNode(c, 0.45); // engine "putt": amplitude-modulated by a square LFO
    const lfo = c.createOscillator();
    lfo.type = 'square';
    lfo.frequency.setValueAtTime(20 * v.r, t);
    lfo.frequency.linearRampToValueAtTime(34 * v.r, t + 0.35 / v.r);
    lfo.frequency.linearRampToValueAtTime(27 * v.r, end);
    lfo.connect(gainNode(c, 0.4)).connect(putt.gain);
    lfo.start(t);
    lfo.stop(end);
    for (const k of [1, 1.01]) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(62 * k * v.r, t);
      o.frequency.exponentialRampToValueAtTime(100 * k * v.r, t + 0.35 / v.r);
      o.frequency.exponentialRampToValueAtTime(84 * k * v.r, end);
      o.connect(putt);
      o.start(t);
      o.stop(end);
    }
    putt.connect(lp).connect(e).connect(v.out);
    hiss(v, 0.05, { f: 1200, q: 0.5, a: 0.1, hold: 0.35, d: 0.2, peak: 0.02 });
  } },
  bark: { dur: 0.25, max: 1, vary: 0.05, gain: 1.2, fn(v) { // a small, friendly "yip"
    formantVoice(v, 0, {
      path: [[0, 620], [0.1, 430]],
      formants: [{ f: 1200, q: 3, g: 1 }, { f: 2600, q: 4, g: 0.5 }],
      a: 0.006, hold: 0.04, d: 0.1, peak: 0.5,
    });
    hiss(v, 0, { f: 1500, q: 1, a: 0.003, d: 0.04, peak: 0.08 });
  } },
  horn: { dur: 0.6, max: 1, vary: 0.02, gain: 0.56, fn(v) { // ship / car: a toy "toot-toot"
    const honk = (at, len, peak) => {
      for (const note of ['G3', 'B3']) {
        tone(v, at, { type: 'sawtooth', f: note, a: 0.02, hold: len, d: 0.06, sustain: 0.85, peak, lp: 1100, q: 1.5 });
        tone(v, at, { type: 'square', f: note, a: 0.02, hold: len, d: 0.06, sustain: 0.85, peak: peak * 0.4, lp: 900 });
      }
    };
    honk(0, 0.1, 0.09);
    honk(0.17, 0.28, 0.1);
  } },
  purr: { dur: 0.5, max: 1, vary: 0.04, gain: 0.73, fn(v) { // cat: a "mrrrow"
    formantVoice(v, 0, {
      path: [[0, 420], [0.12, 700], [0.4, 520]],
      formants: [{ f: 900, q: 4, g: 1, path: [[0, 900], [0.12, 1900], [0.4, 1000]] }, { f: 2800, q: 6, g: 0.35 }],
      a: 0.03, hold: 0.25, d: 0.12, peak: 0.55, trem: 0.6, tremRate: 26,
    });
  } },
  stomp: { dur: 0.28, max: 2, vary: 0.04, gain: 0.88, fn(v) { // boot
    thump(v, 0, 130, 48, 0.2, 0.45);
    hiss(v, 0, { type: 'lowpass', f: 600, a: 0.001, d: 0.07, peak: 0.22 });
    knock(v, 0, 380, 0.08, 0.6);
  } },
  clink: { dur: 0.42, max: 2, vary: 0.03, gain: 0.88, fn(v) { // thimble: a small metal ping and a bounce
    clinkAt(v, 0, 2900, 0.16, 0.35);
    hiss(v, 0, { type: 'highpass', f: 7000, a: 0.001, d: 0.006, peak: 0.05 });
    clinkAt(v, 0.05, 2900, 0.06, 0.25);
  } },
  squeak: { dur: 0.36, max: 1, vary: 0.04, gain: 0.37, fn(v) { // wheelbarrow wheel: "ee-ik"
    const c = v.ctx;
    const squeal = (at, f1, f2, len, peak) => {
      const t = T(v, at);
      const o = c.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(f1 * v.r, t);
      o.frequency.exponentialRampToValueAtTime(f2 * v.r, t + len / v.r);
      const e = gainNode(c);
      const end = held(e.gain, t, peak, 0.015 / v.r, len / v.r, 0.05 / v.r, 0.8);
      const wob = gainNode(c, f1 * v.r * 0.025);
      oscNode(c, 'sine', 28, t, end).connect(wob).connect(o.frequency);
      o.connect(filterNode(c, 'bandpass', 1700 * v.r, 3)).connect(e).connect(v.out);
      o.start(t);
      o.stop(end);
    };
    squeal(0, 1450, 1900, 0.1, 0.35);
    squeal(0.19, 1650, 1350, 0.08, 0.28);
  } },
  hatSpin: { dur: 0.65, max: 1, vary: 0.03, gain: 1.25, fn(v) { // top hat: a spinning whirr and a "ting"
    const c = v.ctx;
    const t = T(v, 0);
    const flutter = gainNode(c, 0.5); // tremolo speeding up as it spins
    const lfo = c.createOscillator();
    lfo.frequency.setValueAtTime(14, t);
    lfo.frequency.linearRampToValueAtTime(42, t + 0.42 / v.r);
    lfo.connect(gainNode(c, 0.45)).connect(flutter.gain);
    const end = t + 0.5 / v.r;
    lfo.start(t);
    lfo.stop(end);
    tone(v, 0, { f: 300, f2: 1100, glide: 0.45, a: 0.03, hold: 0.3, d: 0.12, peak: 0.1, dest: flutter });
    hiss(v, 0, { path: [[0, 600], [0.42, 3000]], q: 3, a: 0.05, hold: 0.28, d: 0.12, peak: 0.08, dest: flutter });
    flutter.connect(v.out);
    glock(v, 0.4, 'E7', 0.06, 0.2);
  } },

  // --- money ---------------------------------------------------------------------------
  coin: { dur: 0.6, max: 6, gap: 0.012, vary: 0.02, gain: 0.95, fn(v) {
    coinAt(v, 0, 2350, 0.2, 0.5);
    coinAt(v, 0.07, 2350, 0.07, 0.35); // the little bounce
  } },
  coins: { dur: 0.9, max: 2, vary: 0.02, gain: 0.94, fn(v) { // a handful of coins
    const pitches = [2093, 2349, 2637, 2794, 3136];
    let at = 0;
    for (let k = 0; k < 7; k++) {
      const f = pitches[Math.floor(v.rnd() * pitches.length)] * (0.99 + v.rnd() * 0.02);
      coinAt(panned(v, (v.rnd() * 2 - 1) * 0.35), at, f, 0.16 - k * 0.01, 0.4);
      at += 0.045 + v.rnd() * 0.03;
    }
  } },
  cashRegister: { dur: 1.1, max: 1, vary: 0, gain: 0.95, fn(v) { // "cha-ching"
    knock(v, 0, 950, 0.18, 0.5); // the lever
    hiss(v, 0, { f: 2200, q: 0.9, a: 0.002, d: 0.07, peak: 0.22 }); // "ch"
    hiss(v, 0, { color: 'brown', type: 'lowpass', f: 500, a: 0.01, hold: 0.06, d: 0.1, peak: 0.25 }); // drawer
    knock(v, 0.09, 600, 0.15, 0.6); // drawer stop
    modal(v, 0.13, 'E6', BELL, 0.2, { decay: 0.9 }); // "ching"
    modal(v, 0.13, 'B6', COIN, 0.11, { decay: 0.8 });
    coinAt(v, 0.2, 2637, 0.07, 0.5);
  } },
  rent: { dur: 0.85, max: 1, vary: 0, gain: 0.98, fn(v) { // money changing hands: coins tumbling down
    [[0, 3136, 0.14], [0.07, 2637, 0.12], [0.13, 2349, 0.1], [0.18, 2093, 0.09]]
      .forEach(([at, f, g]) => coinAt(v, at, f, g, 0.35));
    marimba(v, 0.22, 'G4', 0.2, 0.4);
    marimba(v, 0.36, 'D4', 0.24, 0.45);
  } },
  passGo: { dur: 1.3, max: 1, vary: 0, duck: true, gain: 1.2, fn(v) { // a short brass fanfare
    brass(v, 0, 'C4', 0.11, 0.11);
    brass(v, 0.12, 'E4', 0.11, 0.11);
    brass(v, 0.24, 'G4', 0.11, 0.11);
    brass(v, 0.36, 'C5', 0.55, 0.13, { vib: 0.004 });
    brass(v, 0.36, 'E4', 0.5, 0.06);
    brass(v, 0.36, 'G4', 0.5, 0.06);
    ['C6', 'E6', 'G6'].forEach((n, k) => glock(v, k * 0.12, n, 0.07, 0.35));
    glock(v, 0.36, 'C7', 0.09, 0.8);
    timpani(v, 0.36, 'C3', 0.25, 0.7);
    musicBox(v, 0.5, 'E7', 0.05, 0.5);
    musicBox(v, 0.58, 'G7', 0.045, 0.5);
  } },
  tax: { dur: 0.75, max: 1, vary: 0, gain: 1.6, fn(v) { // a muted "womp-womp" and a dull coin
    modal(v, 0, 1200, COIN, 0.08, { decay: 0.2 });
    brass(v, 0.02, 'Bb3', 0.14, 0.1, { bright: 2.2, wah: true });
    brass(v, 0.2, 'Gb3', 0.35, 0.11, { bright: 2.2, wah: true, vib: 0.012 });
  } },

  // --- cards & jail --------------------------------------------------------------------
  cardDraw: { dur: 0.28, max: 2, vary: 0.04, gain: 4.8, fn(v) { // a card sliding off the pile
    hiss(v, 0, { path: [[0, 1200], [0.2, 3200]], q: 0.9, a: 0.05, d: 0.16, peak: 0.12 });
    hiss(v, 0, { type: 'highpass', f: 4000, a: 0.03, d: 0.08, peak: 0.02 });
    knock(v, 0.17, 2200, 0.05, 0.3);
  } },
  cardFlip: { dur: 0.16, max: 2, vary: 0.04, gain: 4.5, fn(v) { // "fwip" and a paper snap
    hiss(v, 0, { path: [[0, 2200], [0.06, 3600]], q: 0.8, a: 0.004, d: 0.06, peak: 0.2 });
    hiss(v, 0.045, { f: 1300, q: 2, a: 0.001, d: 0.015, peak: 0.15 });
    knock(v, 0.045, 1800, 0.06, 0.3);
  } },
  jailSlam: { dur: 1.3, max: 1, vary: 0.02, duck: true, gain: 1, fn(v) { // a heavy barred door
    thump(v, 0, 95, 38, 0.35, 0.42);
    hiss(v, 0, { color: 'brown', type: 'lowpass', f: 1400, a: 0.001, d: 0.18, peak: 0.28 });
    modal(v, 0, 160, METAL, 0.22, { decay: 1.1 });
    clinkAt(v, 0, 1240, 0.07, 0.5); // the latch
    hiss(v, 0, { f: 5000, q: 1.2, a: 0.001, d: 0.25, peak: 0.08 });
    clinkAt(v, 0.14, 1650, 0.05, 0.25); // the bars rattling
    clinkAt(v, 0.23, 1900, 0.035, 0.2);
    clinkAt(v, 0.3, 1500, 0.025, 0.2);
  } },
  jailFree: { dur: 1.2, max: 1, vary: 0, gain: 0.9, fn(v) { // keys, the lock, and a happy run upward
    clinkAt(v, 0, 3400, 0.07, 0.25);
    clinkAt(v, 0.035, 4100, 0.06, 0.22);
    clinkAt(v, 0.065, 3000, 0.05, 0.2);
    knock(v, 0.13, 1100, 0.2, 0.5);
    ['C6', 'E6', 'G6', 'C7'].forEach((n, k) => glock(v, 0.26 + k * 0.07, n, 0.16 + k * 0.012, k === 3 ? 0.7 : 0.5));
  } },

  // --- property -------------------------------------------------------------------------
  build: { dur: 0.8, max: 2, vary: 0.02, gain: 1.5, fn(v) { // two hammer taps, a pop and a sparkle
    knock(v, 0, 760, 0.26, 0.8);
    thump(v, 0, 200, 120, 0.05, 0.15);
    knock(v, 0.14, 820, 0.28, 0.8);
    thump(v, 0.14, 200, 120, 0.05, 0.15);
    tone(v, 0.3, { f: 380, f2: 980, glide: 0.06, a: 0.002, d: 0.07, peak: 0.16 });
    glock(v, 0.34, 'C7', 0.07, 0.35);
    glock(v, 0.39, 'E7', 0.06, 0.35);
  } },
  hotel: { dur: 1.4, max: 1, vary: 0, duck: true, gain: 1.04, fn(v) { // three taps and a "ta-da"
    [[0, 760], [0.11, 820], [0.22, 900]].forEach(([at, f]) => {
      knock(v, at, f, 0.25, 0.8);
      thump(v, at, 200, 120, 0.05, 0.14);
    });
    for (const n of ['C4', 'E4', 'G4']) brass(v, 0.36, n, 0.3, 0.07);
    ['C6', 'E6', 'G6', 'C7'].forEach((n, k) => glock(v, 0.36 + k * 0.06, n, 0.14, k === 3 ? 0.8 : 0.5));
  } },
  demolish: { dur: 0.65, max: 2, vary: 0.04, gain: 1.5, fn(v) { // selling a building: a crumble
    hiss(v, 0, { color: 'brown', type: 'lowpass', f: 900, q: 0.7, a: 0.01, d: 0.5, peak: 0.35 });
    for (let k = 0; k < 9; k++) knock(v, v.rnd() * 0.35, 400 + v.rnd() * 1100, 0.06 + v.rnd() * 0.08, 0.25);
    tone(v, 0, { type: 'triangle', f: 520, f2: 180, glide: 0.35, a: 0.01, d: 0.35, peak: 0.07 });
  } },
  stamp: { dur: 0.3, max: 2, vary: 0.03, gain: 1.3, fn(v) { // mortgage: a rubber stamp "ka-THUNK"
    knock(v, 0, 1500, 0.07, 0.3);
    thump(v, 0.05, 170, 62, 0.14, 0.42);
    hiss(v, 0.05, { f: 900, q: 0.6, a: 0.001, d: 0.06, peak: 0.28 });
    hiss(v, 0.05, { type: 'highpass', f: 3000, a: 0.001, d: 0.02, peak: 0.06 });
  } },
  unstamp: { dur: 0.6, max: 2, vary: 0.02, gain: 1.33, fn(v) { // unmortgage: a quick "shwip" and a ping
    hiss(v, 0, { path: [[0, 700], [0.12, 3800]], q: 1.2, a: 0.06, d: 0.06, peak: 0.14 });
    glock(v, 0.1, 'G6', 0.14, 0.45);
    musicBox(v, 0.15, 'D7', 0.06, 0.3);
  } },
  sold: { dur: 0.95, max: 1, vary: 0, gain: 1, fn(v) { // the deed is yours: "ta-ding!"
    glock(v, 0, 'G5', 0.2, 0.5);
    glock(v, 0.09, 'C6', 0.24, 0.8);
    for (const n of ['C4', 'E4', 'G4']) marimba(v, 0.09, n, 0.1, 0.45);
    coinAt(v, 0.1, 3136, 0.06, 0.4);
  } },

  // --- auction & trade --------------------------------------------------------------------
  gavel: { dur: 0.25, max: 2, vary: 0.02, gain: 1.2, fn(v) {
    knock(v, 0, 430, 0.4, 1.3);
    thump(v, 0, 150, 95, 0.12, 0.18);
    hiss(v, 0, { f: 1800, q: 0.8, a: 0.001, d: 0.02, peak: 0.18 });
  } },
  bid: { dur: 0.35, max: 3, vary: 0.01, gain: 1.35, fn(v) { // a new high bid: a bright upward "bip"
    marimba(v, 0, 'A5', 0.2, 0.3);
    tone(v, 0, { f: 700, f2: 1050, glide: 0.05, a: 0.002, d: 0.05, peak: 0.06 });
  } },
  auctionEnd: { dur: 0.9, max: 1, vary: 0, gain: 1.2, fn(v) { // "going, going, gone": knock, knock, KNOCK
    [[0, 0.28, 1], [0.3, 0.3, 1], [0.62, 0.42, 1.4]].forEach(([at, g, decay]) => {
      knock(v, at, 430, g, decay);
      thump(v, at, 150, 95, 0.1 * decay, g * 0.45);
      hiss(v, at, { f: 1800, q: 0.8, a: 0.001, d: 0.02, peak: g * 0.4 });
    });
  } },
  tradePropose: { dur: 0.7, max: 1, vary: 0, gain: 1, fn(v) { // a paper swish and a questioning "hm?"
    hiss(v, 0, { path: [[0, 1500], [0.14, 4000]], q: 1, a: 0.04, d: 0.1, peak: 0.08 });
    marimba(v, 0.08, 'E5', 0.2, 0.35);
    marimba(v, 0.2, 'A5', 0.22, 0.45);
  } },
  tradeAccept: { dur: 0.9, max: 1, vary: 0, gain: 0.98, fn(v) { // "deal!"
    ['C5', 'E5', 'G5', 'C6'].forEach((n, k) => marimba(v, k * 0.07, n, 0.2, k === 3 ? 0.6 : 0.35));
    glock(v, 0.21, 'C7', 0.07, 0.6);
    coinAt(v, 0.3, 2637, 0.06, 0.4);
  } },
  tradeReject: { dur: 0.6, max: 1, vary: 0, gain: 1.07, fn(v) { // a soft falling "nuh-uh"
    marimba(v, 0, 'D5', 0.2, 0.3);
    marimba(v, 0.13, 'A4', 0.22, 0.45);
  } },

  // --- big moments -------------------------------------------------------------------------
  bankrupt: { dur: 2.3, max: 1, vary: 0, duck: true, gain: 1.5, fn(v) { // a sad trombone
    brass(v, 0, 'D4', 0.3, 0.12, { bright: 3.2, wah: true });
    brass(v, 0.34, 'C#4', 0.3, 0.12, { bright: 3.2, wah: true });
    brass(v, 0.68, 'C4', 0.3, 0.12, { bright: 3.2, wah: true });
    brass(v, 1.02, 'B3', 1.0, 0.13, { bright: 3.4, wah: true, vib: 0.025 });
    timpani(v, 1.02, 'B1', 0.2, 0.9);
  } },
  victory: { dur: 3.2, max: 1, vary: 0, duck: true, gain: 1, fn(v) { // the winner's fanfare
    brass(v, 0, 'G4', 0.12, 0.11);
    brass(v, 0.13, 'G4', 0.12, 0.11);
    brass(v, 0.26, 'G4', 0.12, 0.11);
    brass(v, 0.39, 'C5', 0.55, 0.13, { vib: 0.004 });
    for (const n of ['E4', 'G4']) brass(v, 0.39, n, 0.5, 0.06);
    timpani(v, 0.39, 'C3', 0.25, 0.7);
    brass(v, 1.05, 'A4', 0.12, 0.11);
    for (const n of ['F4', 'C4']) brass(v, 1.05, n, 0.12, 0.05);
    brass(v, 1.18, 'B4', 0.12, 0.11);
    for (const n of ['G4', 'D4']) brass(v, 1.18, n, 0.12, 0.05);
    brass(v, 1.31, 'C5', 1.2, 0.14, { vib: 0.006 });
    for (const n of ['C4', 'E4', 'G4']) brass(v, 1.31, n, 1.15, 0.055, { vib: 0.004 });
    for (let k = 0; k < 9; k++) timpani(v, 1.31 + k * 0.07, 'C3', 0.05 + k * 0.009, 0.3); // the roll
    timpani(v, 1.95, 'C3', 0.3, 0.9);
    crash(v, 1.31, 0.1, 1.2);
    ['C6', 'E6', 'G6', 'C7', 'E7', 'G7'].forEach((n, k) => glock(v, 1.31 + k * 0.07, n, 0.08, 0.6));
    glock(v, 1.9, 'C7', 0.09, 0.9);
  } },
  cheer: { dur: 2.4, max: 1, vary: 0.02, gain: 1.16, fn(v) { // a crowd: applause, a roar, "yay"s and whistles
    const c = v.ctx;
    const t = T(v, 0);
    const buf = applauseBuffer(c);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = v.r;
    const e = gainNode(c, 0.55);
    src.connect(filterNode(c, 'highpass', 350, 0.7)).connect(filterNode(c, 'bandpass', 1700, 0.45)).connect(e).connect(v.out);
    src.start(t);
    src.stop(t + buf.duration / v.r);
    for (const [f, q, g] of [[650, 1.6, 1], [1150, 2, 0.6], [2500, 3, 0.25]]) {
      hiss(v, 0, { color: 'pink', f, q, a: 0.3, hold: 0.6, d: 1.1, peak: 0.2 * g });
    }
    for (let k = 0; k < 5; k++) {
      const f = 190 + v.rnd() * 160;
      formantVoice(v, 0.05 + v.rnd() * 0.25, {
        path: [[0, f], [0.25, f * 1.35], [1.2, f * 1.2]],
        formants: [{ f: 800, q: 5, g: 1 }, { f: 1250, q: 6, g: 0.6 }],
        a: 0.15, hold: 0.55, d: 0.55, peak: 0.07, vib: 0.012,
      });
    }
    whistle(v, 0.35 + v.rnd() * 0.2, 0.035);
    whistle(v, 0.9 + v.rnd() * 0.3, 0.03);
  } },

  // =================================================================================================
  // The city (design §14.2): crowds, streets, construction, landmarks, nature and the time-lapse.
  // Every one of these is under 1 s; most are tied to a place (sfx.play(name, { pos })).
  // =================================================================================================

  // --- crowds -------------------------------------------------------------------------------------
  crowdAww: { dur: 0.95, max: 1, vary: 0.02, gain: 1.2, fn(v) { // a crowd's sympathetic "awww", falling
    for (let k = 0; k < 10; k++) {
      const f0 = 330 * 2 ** (((v.rnd() * 2 - 1) * 40) / 1200) * (0.85 + v.rnd() * 0.3);
      formantVoice(v, v.rnd() * 0.08, {
        path: [[0, f0], [0.55, f0 * 0.66]],
        formants: [{ f: 700, q: 4, g: 1, path: [[0, 700], [0.55, 380]] }, { f: 1100, q: 5, g: 0.55, path: [[0, 1100], [0.55, 760]] }],
        a: 0.09, hold: 0.3, d: 0.38, peak: 0.05, vib: 0.01,
      });
    }
    hiss(v, 0, { color: 'pink', f: 600, q: 0.9, a: 0.1, hold: 0.3, d: 0.4, peak: 0.04 });
  } },
  crowdOoh: { dur: 0.85, max: 1, vary: 0.02, gain: 1.2, fn(v) { // an impressed "ooh", rising
    for (let k = 0; k < 10; k++) {
      const f0 = 200 * 2 ** (((v.rnd() * 2 - 1) * 40) / 1200) * (0.9 + v.rnd() * 0.2);
      formantVoice(v, v.rnd() * 0.06, {
        path: [[0, f0], [0.45, f0 * 1.5]],
        formants: [{ f: 330, q: 4, g: 1, path: [[0, 330], [0.45, 520]] }, { f: 870, q: 5, g: 0.5, path: [[0, 870], [0.45, 920]] }],
        a: 0.08, hold: 0.3, d: 0.35, peak: 0.05, vib: 0.01,
      });
    }
    hiss(v, 0, { color: 'pink', f: 500, q: 0.9, a: 0.08, hold: 0.3, d: 0.35, peak: 0.03 });
  } },
  applause: { dur: 0.95, max: 1, vary: 0.02, gain: 1.3, fn(v) { // a short round of applause
    const c = v.ctx;
    const t = T(v, 0);
    const buf = applauseBuffer(c);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = v.r;
    const e = gainNode(c);
    const end = held(e.gain, t, 0.6, 0.04 / v.r, 0.5 / v.r, 0.3 / v.r, 0.9);
    src.connect(filterNode(c, 'highpass', 300, 0.7)).connect(e).connect(v.out);
    src.start(t, 0.35);
    src.stop(end);
  } },
  coinsIn: { dur: 0.7, max: 2, vary: 0, gain: 0.95, fn(v) { // money arriving: four coins rising C E G C
    ['C6', 'E6', 'G6', 'C7'].forEach((n, k) => coinAt(v, k * 0.07, hzOf(n), 0.15, 0.35));
    hiss(v, 0.21, { type: 'highpass', f: 7000, a: 0.01, d: 0.2, peak: 0.03 });
  } },

  // --- streets ------------------------------------------------------------------------------------
  siren: { dur: 0.95, max: 1, vary: 0.01, gain: 0.9, fn(v) { // one wail of a police siren
    const c = v.ctx;
    const t = T(v, 0);
    const e = gainNode(c);
    const end = held(e.gain, t, 0.22, 0.03 / v.r, 0.72 / v.r, 0.12 / v.r, 0.9);
    for (const [type, g, lpf] of [['triangle', 1, 0], ['square', 0.18, 2600]]) {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(620 * v.r, t);
      o.frequency.linearRampToValueAtTime(1320 * v.r, t + 0.42 / v.r);
      o.frequency.linearRampToValueAtTime(680 * v.r, t + 0.86 / v.r);
      let node = o.connect(gainNode(c, g));
      if (lpf) node = node.connect(filterNode(c, 'lowpass', lpf * v.r, 0.7));
      node.connect(filterNode(c, 'bandpass', 1100 * v.r, 0.9)).connect(e);
      o.start(t);
      o.stop(end);
    }
    e.connect(v.out);
  } },
  whistleCop: { dur: 0.5, max: 1, vary: 0.02, gain: 0.9, fn(v) { // a traffic cop's whistle: "fweet — fweeeet"
    for (const [at, hold] of [[0, 0.11], [0.17, 0.22]]) {
      tone(v, at, { f: 2900, a: 0.008, hold, d: 0.04, peak: 0.12, vib: 0.06, vibRate: 34 });
      hiss(v, at, { f: 3000, q: 1.5, a: 0.005, hold, d: 0.04, peak: 0.02 });
    }
  } },
  hornCar: { dur: 0.45, max: 2, vary: 0.04, gain: 0.8, fn(v) { // an everyday car horn (a major third)
    for (const f of [415, 523]) {
      tone(v, 0, { type: 'sawtooth', f, a: 0.012, hold: 0.28, d: 0.05, sustain: 0.9, peak: 0.07, lp: 1800, q: 1.2 });
      tone(v, 0, { type: 'square', f, a: 0.012, hold: 0.28, d: 0.05, sustain: 0.9, peak: 0.03, lp: 1200 });
    }
  } },
  hornBus: { dur: 0.7, max: 1, vary: 0.02, gain: 0.8, fn(v) { // a bus: lower and longer
    for (const f of [233, 294]) {
      tone(v, 0, { type: 'sawtooth', f, a: 0.02, hold: 0.48, d: 0.08, sustain: 0.9, peak: 0.08, lp: 1300, q: 1.4 });
      tone(v, 0, { type: 'square', f, a: 0.02, hold: 0.48, d: 0.08, sustain: 0.9, peak: 0.035, lp: 800 });
    }
  } },
  bikeBell: { dur: 0.45, max: 2, vary: 0.02, gain: 0.85, fn(v) { // "ring-ring"
    clinkAt(v, 0, 2350, 0.16, 0.26);
    clinkAt(v, 0.13, 2350, 0.16, 0.28);
    hiss(v, 0, { type: 'highpass', f: 6000, a: 0.001, d: 0.006, peak: 0.04 });
  } },
  tramBell: { dur: 0.5, max: 1, vary: 0.01, gain: 0.85, fn(v) { // "ding-ding" (the bus at its stops, trams)
    for (const at of [0, 0.16]) {
      modal(v, at, 1250, BELL, 0.18, { decay: 0.3 });
      hiss(v, at, { type: 'highpass', f: 5000, a: 0.001, d: 0.005, peak: 0.03 });
    }
  } },
  trainHorn: { dur: 0.9, max: 1, vary: 0.01, gain: 1, fn(v) { // a three-chime train horn
    for (const [f, g] of [[277, 1], [349, 0.85], [415, 0.7]]) brass(v, 0, f, 0.68, 0.05 * g, { bright: 3 });
  } },
  brakeSqueal: { dur: 0.6, max: 2, vary: 0.04, gain: 0.8, fn(v) { // a bus or truck pulling up
    const c = v.ctx;
    const t = T(v, 0);
    const o = c.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(2700 * v.r, t);
    o.frequency.exponentialRampToValueAtTime(2350 * v.r, t + 0.5 / v.r);
    const e = gainNode(c);
    const end = held(e.gain, t, 0.07, 0.04 / v.r, 0.38 / v.r, 0.1 / v.r, 0.8);
    oscNode(c, 'sine', 23, t, end).connect(gainNode(c, 2700 * v.r * 0.012)).connect(o.frequency);
    o.connect(filterNode(c, 'bandpass', 2500 * v.r, 6)).connect(e).connect(v.out);
    o.start(t);
    o.stop(end);
    hiss(v, 0, { f: 2600, q: 5, a: 0.04, hold: 0.36, d: 0.1, peak: 0.03 });
  } },
  skid: { dur: 0.5, max: 1, vary: 0.04, gain: 0.8, fn(v) { // tyres screeching
    hiss(v, 0, { path: [[0, 2300], [0.4, 1500]], q: 7, a: 0.01, hold: 0.3, d: 0.12, peak: 0.25 });
    hiss(v, 0, { color: 'pink', f: 900, q: 1, a: 0.01, hold: 0.3, d: 0.12, peak: 0.08 });
  } },
  reverseBeep: { dur: 0.5, max: 2, vary: 0, gain: 0.7, fn(v) { // one reversing beep (repeat every 0.5 s)
    tone(v, 0, { type: 'square', f: 1040, a: 0.004, hold: 0.22, d: 0.02, peak: 0.05, lp: 3000 });
    tone(v, 0, { f: 1040, a: 0.004, hold: 0.22, d: 0.02, peak: 0.05 });
  } },
  hydraulicHop: { dur: 0.45, max: 2, vary: 0.04, gain: 1, fn(v) { // the boot car's lowrider bounce
    hiss(v, 0, { type: 'highpass', f: 2200, a: 0.004, hold: 0.06, d: 0.14, peak: 0.12 });
    thump(v, 0.05, 160, 70, 0.12, 0.3);
    tone(v, 0.08, { f: 190, f2: 140, a: 0.005, d: 0.3, peak: 0.08, vib: 0.08, vibRate: 11 });
  } },
  meow: { dur: 0.45, max: 1, vary: 0.05, gain: 0.75, fn(v) { // the tabby's "mee-ow"
    formantVoice(v, 0, {
      path: [[0, 520], [0.12, 820], [0.34, 560]],
      formants: [{ f: 900, q: 4, g: 1, path: [[0, 900], [0.12, 1800], [0.34, 1000]] }, { f: 2900, q: 6, g: 0.35 }],
      a: 0.025, hold: 0.24, d: 0.12, peak: 0.5,
    });
  } },
  footstep: { dur: 0.1, max: 6, gap: 0.02, vary: 0.06, gain: 1, fn(v) { // one shoe step (rate = surface)
    thump(v, 0, 130, 70, 0.04, 0.22);
    hiss(v, 0, { type: 'lowpass', f: 1800, a: 0.002, d: 0.035, peak: 0.12 });
    hiss(v, 0.004, { f: 3200, q: 1.2, a: 0.001, d: 0.012, peak: 0.05 });
  } },
  pawStep: { dur: 0.08, max: 6, gap: 0.015, vary: 0.08, gain: 1, fn(v) { // a dog's or cat's padded step
    hiss(v, 0, { f: 2400, q: 1, a: 0.002, d: 0.025, peak: 0.08 });
    thump(v, 0, 260, 170, 0.025, 0.08);
  } },
  engineStart: { dur: 0.8, max: 1, vary: 0.03, gain: 0.9, fn(v) { // starter whirr, the engine catches and revs
    const c = v.ctx;
    const t = T(v, 0);
    const st = gainNode(c);
    const stEnd = held(st.gain, t, 0.12, 0.01 / v.r, 0.3 / v.r, 0.04 / v.r, 0.8);
    const so = c.createOscillator();
    so.type = 'sawtooth';
    so.frequency.setValueAtTime(110 * v.r, t);
    so.frequency.linearRampToValueAtTime(150 * v.r, t + 0.3 / v.r);
    const am = gainNode(c, 0.5);
    oscNode(c, 'square', 11 * v.r, t, stEnd).connect(gainNode(c, 0.45)).connect(am.gain);
    so.connect(am).connect(filterNode(c, 'lowpass', 900 * v.r, 1)).connect(st).connect(v.out);
    so.start(t);
    so.stop(stEnd);
    thump(v, 0.32, 90, 50, 0.1, 0.25);
    const rt = T(v, 0.33);
    const re = gainNode(c);
    const rEnd = held(re.gain, rt, 0.2, 0.02 / v.r, 0.3 / v.r, 0.1 / v.r, 0.7);
    const putt = gainNode(c, 0.55);
    oscNode(c, 'square', 22 * v.r, rt, rEnd).connect(gainNode(c, 0.4)).connect(putt.gain);
    for (const k of [1, 1.012]) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(45 * k * v.r, rt);
      o.frequency.exponentialRampToValueAtTime(110 * k * v.r, rt + 0.15 / v.r);
      o.frequency.exponentialRampToValueAtTime(72 * k * v.r, rt + 0.4 / v.r);
      o.connect(putt);
      o.start(rt);
      o.stop(rEnd);
    }
    putt.connect(filterNode(c, 'lowpass', 700 * v.r, 1.5)).connect(re).connect(v.out);
  } },
  doorSlam: { dur: 0.3, max: 2, vary: 0.04, gain: 1, fn(v) { // a car door
    thump(v, 0, 110, 55, 0.13, 0.4);
    hiss(v, 0, { color: 'brown', type: 'lowpass', f: 1200, a: 0.001, d: 0.08, peak: 0.25 });
    knock(v, 0.012, 2300, 0.06, 0.3);
    modal(v, 0, 240, METAL, 0.03, { decay: 0.12 });
  } },
  ribbonSnip: { dur: 0.3, max: 1, vary: 0.03, gain: 1, fn(v) { // ceremonial scissors through a ribbon
    clinkAt(v, 0, 4200, 0.06, 0.07);
    hiss(v, 0, { type: 'highpass', f: 5000, a: 0.001, d: 0.012, peak: 0.08 });
    clinkAt(v, 0.055, 4600, 0.05, 0.06);
    hiss(v, 0.055, { type: 'highpass', f: 5000, a: 0.001, d: 0.012, peak: 0.07 });
    hiss(v, 0.07, { path: [[0, 4500], [0.15, 1800]], q: 0.8, a: 0.02, d: 0.15, peak: 0.06 });
  } },
  confettiPop: { dur: 0.35, max: 3, vary: 0.05, gain: 1, fn(v) { // a confetti cannon: pop and paper
    hiss(v, 0, { type: 'lowpass', f: 1500, a: 0.001, d: 0.045, peak: 0.35 });
    thump(v, 0, 320, 90, 0.06, 0.25);
    hiss(v, 0.05, { type: 'highpass', f: 4000, a: 0.02, hold: 0.08, d: 0.15, peak: 0.05 });
  } },
  firework: { dur: 0.95, max: 4, gap: 0.05, vary: 0.05, gain: 1, fn(v) { // whistle up, BOOM (0.36 s in), crackle
    tone(v, 0, { f: 900, f2: 2400, glide: 0.34, a: 0.03, hold: 0.28, d: 0.05, sustain: 0.8, peak: 0.05 });
    hiss(v, 0.36, { type: 'lowpass', f: 1500, a: 0.001, d: 0.06, peak: 0.4 });
    thump(v, 0.36, 110, 40, 0.3, 0.35);
    for (let k = 0; k < 16; k++) {
      hiss(v, 0.45 + v.rnd() * 0.42, { type: 'highpass', f: 2500 + v.rnd() * 3000, a: 0.001, d: 0.004 + v.rnd() * 0.006, peak: 0.05 + v.rnd() * 0.08 });
    }
  } },

  // --- construction -------------------------------------------------------------------------------
  craneBeep: { dur: 0.5, max: 1, vary: 0, gain: 0.8, fn(v) { // a tower crane's warning beeps
    for (const at of [0, 0.22]) tone(v, at, { type: 'square', f: 2350, a: 0.004, hold: 0.12, d: 0.02, peak: 0.045, lp: 4000 });
  } },
  hammer: { dur: 0.5, max: 3, vary: 0.05, gain: 1, fn(v) { // two hammer blows on a nail
    for (const at of [0, 0.24]) {
      knock(v, at, 1750, 0.24, 0.7);
      thump(v, at, 280, 140, 0.05, 0.18);
      modal(v, at, 1750, METAL, 0.03, { decay: 0.12 });
    }
  } },
  drill: { dur: 0.6, max: 2, vary: 0.04, gain: 0.9, fn(v) { // a power drill
    const c = v.ctx;
    const t = T(v, 0);
    const o = c.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(150 * v.r, t);
    o.frequency.linearRampToValueAtTime(230 * v.r, t + 0.12 / v.r);
    o.frequency.linearRampToValueAtTime(215 * v.r, t + 0.5 / v.r);
    const am = gainNode(c, 0.6);
    const e = gainNode(c);
    const end = held(e.gain, t, 0.08, 0.03 / v.r, 0.44 / v.r, 0.06 / v.r, 0.85);
    oscNode(c, 'sine', 31, t, end).connect(gainNode(c, 0.35)).connect(am.gain);
    o.connect(am).connect(filterNode(c, 'bandpass', 1100 * v.r, 1.6)).connect(e).connect(v.out);
    o.start(t);
    o.stop(end);
    hiss(v, 0.02, { f: 2600, q: 1.5, a: 0.03, hold: 0.4, d: 0.06, peak: 0.03 });
  } },
  demolishRumble: { dur: 0.95, max: 2, vary: 0.04, gain: 1, fn(v) { // floors collapsing into a dust cloud
    hiss(v, 0, { color: 'brown', type: 'lowpass', f: 380, q: 0.7, a: 0.04, hold: 0.35, d: 0.5, peak: 0.45 });
    thump(v, 0, 75, 35, 0.5, 0.35);
    for (let k = 0; k < 10; k++) knock(v, 0.05 + v.rnd() * 0.55, 300 + v.rnd() * 900, 0.05 + v.rnd() * 0.07, 0.3);
    hiss(v, 0.02, { color: 'pink', f: 1400, q: 0.6, a: 0.05, hold: 0.25, d: 0.4, peak: 0.07 });
  } },

  // --- landmarks ----------------------------------------------------------------------------------
  barrierArm: { dur: 0.5, max: 2, vary: 0.02, gain: 1, fn(v) { // a boom barrier swinging, then its stop
    tone(v, 0, { type: 'sawtooth', f: 115, f2: 175, glide: 0.3, a: 0.02, hold: 0.28, d: 0.05, sustain: 0.8, peak: 0.07, lp: 900 });
    hiss(v, 0, { f: 1400, q: 2, a: 0.02, hold: 0.28, d: 0.05, peak: 0.02 });
    knock(v, 0.34, 620, 0.2, 0.8);
    thump(v, 0.34, 160, 80, 0.08, 0.2);
  } },
  gateSlide: { dur: 0.8, max: 1, vary: 0.02, gain: 1, fn(v) { // a heavy sliding gate rolling, then its clang
    const c = v.ctx;
    const t = T(v, 0);
    const rum = gainNode(c, 0.6);
    oscNode(c, 'square', 17, t, t + 0.66 / v.r).connect(gainNode(c, 0.35)).connect(rum.gain);
    hiss(v, 0, { color: 'pink', f: 650, q: 1.2, a: 0.05, hold: 0.48, d: 0.1, peak: 0.2, dest: rum });
    rum.connect(v.out);
    tone(v, 0.08, { type: 'triangle', f: 1900, f2: 1700, a: 0.03, hold: 0.25, d: 0.08, peak: 0.012, vib: 0.02, vibRate: 19 });
    modal(v, 0.6, 330, METAL, 0.16, { decay: 0.13 });
    thump(v, 0.6, 140, 70, 0.1, 0.25);
  } },
  chainFence: { dur: 0.5, max: 2, vary: 0.04, gain: 1, fn(v) { // a chain-link fence rattling
    for (let k = 0; k < 12; k++) clinkAt(v, v.rnd() * 0.28, 2500 + v.rnd() * 2200, 0.025 + v.rnd() * 0.03, 0.09);
    hiss(v, 0, { type: 'highpass', f: 3500, a: 0.01, hold: 0.15, d: 0.15, peak: 0.04 });
    thump(v, 0, 120, 70, 0.08, 0.1);
  } },
  splitFlap: { dur: 0.4, max: 2, vary: 0.03, gain: 1, fn(v) { // a split-flap board clattering to a new value
    for (let k = 0; k < 9; k++) {
      knock(v, k * 0.032, 2900 + v.rnd() * 600, 0.07, 0.18);
      hiss(v, k * 0.032, { f: 4500, q: 1, a: 0.001, d: 0.006, peak: 0.03 });
    }
  } },
  doormanBell: { dur: 0.4, max: 1, vary: 0, gain: 0.9, fn(v) { // a hotel desk bell
    knock(v, 0, 3000, 0.04, 0.2);
    modal(v, 0.005, 2637, BELL, 0.2, { decay: 0.34 });
  } },

  // --- nature and weather --------------------------------------------------------------------------
  pigeonFlap: { dur: 0.5, max: 2, vary: 0.06, gain: 1, fn(v) { // pigeons taking off
    const c = v.ctx;
    const t = T(v, 0);
    const fl = gainNode(c, 0.5);
    const lfo = c.createOscillator();
    lfo.type = 'square';
    lfo.frequency.setValueAtTime(13 * v.r, t);
    lfo.frequency.linearRampToValueAtTime(9 * v.r, t + 0.4 / v.r);
    lfo.connect(gainNode(c, 0.5)).connect(fl.gain);
    const end = hiss(v, 0, { color: 'pink', f: 1300, q: 0.9, a: 0.01, hold: 0.28, d: 0.12, peak: 0.25, dest: fl });
    hiss(v, 0, { type: 'highpass', f: 3500, a: 0.01, hold: 0.25, d: 0.1, peak: 0.04, dest: fl });
    lfo.start(t);
    lfo.stop(end);
    fl.connect(v.out);
  } },
  gull: { dur: 0.7, max: 2, vary: 0.06, gain: 0.7, fn(v) { // a herring gull: "kee-ow … kya"
    const formants = [{ f: 2200, q: 5, g: 1 }, { f: 3600, q: 6, g: 0.4 }];
    formantVoice(v, 0, { path: [[0, 1350], [0.07, 2000], [0.3, 1250], [0.45, 900]], formants, a: 0.015, hold: 0.32, d: 0.12, peak: 0.35, vib: 0.02 });
    formantVoice(v, 0.5, { path: [[0, 1600], [0.06, 1900], [0.12, 1500]], formants, a: 0.01, hold: 0.06, d: 0.06, peak: 0.25 });
  } },
  foghorn: { dur: 0.95, max: 1, vary: 0, gain: 1, fn(v) { // the lighthouse / ferry: a deep long blast
    for (const k of [1, 1.006]) tone(v, 0, { type: 'sawtooth', f: 87 * k, a: 0.14, hold: 0.55, d: 0.2, sustain: 0.85, peak: 0.12, lp: 420, q: 1.6 });
    tone(v, 0, { type: 'square', f: 43.5, a: 0.14, hold: 0.55, d: 0.2, sustain: 0.85, peak: 0.05, lp: 200 });
  } },
  chirp: { dur: 0.4, max: 3, vary: 0.08, gain: 0.8, fn(v) { // a small bird
    const n = 3 + Math.floor(v.rnd() * 2);
    for (let k = 0; k < n; k++) tone(v, k * 0.09, { f: 2800 + v.rnd() * 300, f2: 4200 + v.rnd() * 400, a: 0.004, d: 0.05, peak: 0.05 });
  } },
  thunder: { dur: 0.95, max: 2, vary: 0.06, gain: 1, fn(v) { // a crack and a rolling rumble
    hiss(v, 0, { color: 'brown', type: 'lowpass', f: 220, q: 0.7, a: 0.03, hold: 0.3, d: 0.55, peak: 0.6 });
    for (const [at, g] of [[0, 0.25], [0.06, 0.18], [0.15, 0.12]]) hiss(v, at, { type: 'lowpass', f: 2600, a: 0.001, d: 0.07, peak: g });
    thump(v, 0, 70, 32, 0.6, 0.35);
    hiss(v, 0.1, { color: 'pink', f: 500, q: 0.6, a: 0.08, hold: 0.2, d: 0.5, peak: 0.12 });
  } },

  // --- the clock and the game layer ---------------------------------------------------------------
  timelapseRise: { dur: 0.95, max: 1, vary: 0, gain: 1, fn(v) { // the city starts racing: a rising rush
    hiss(v, 0, { color: 'pink', path: [[0, 300], [0.75, 3200]], q: 1.4, a: 0.55, hold: 0.15, d: 0.2, peak: 0.25 });
    tone(v, 0, { f: 220, f2: 880, glide: 0.8, a: 0.5, hold: 0.2, d: 0.18, peak: 0.03 });
    hiss(v, 0.3, { type: 'highpass', f: 6000, a: 0.4, d: 0.2, peak: 0.02 });
  } },
  timelapseLand: { dur: 0.6, max: 1, vary: 0, gain: 1, fn(v) { // ... and settles back to real time
    hiss(v, 0, { color: 'pink', path: [[0, 2600], [0.4, 380]], q: 1.2, a: 0.01, hold: 0.08, d: 0.38, peak: 0.25 });
    thump(v, 0.02, 130, 60, 0.18, 0.18);
    glock(v, 0.04, 'G6', 0.03, 0.25);
  } },
  stepTick: { dur: 0.08, max: 2, gap: 0.05, vary: 0, gain: 1, fn(v) { // the counting ritual, one bay
    knock(v, 0, 3200, 0.12, 0.22);
    tone(v, 0, { f: 1760, a: 0.001, d: 0.03, peak: 0.04 });
  } },
  setComplete: { dur: 0.95, max: 1, vary: 0, duck: true, gain: 1.1, fn(v) { // a neighbourhood is yours
    brass(v, 0, 'F4', 0.08, 0.1);
    brass(v, 0.09, 'A4', 0.08, 0.1);
    brass(v, 0.18, 'C5', 0.08, 0.1);
    brass(v, 0.27, 'F5', 0.4, 0.13, { vib: 0.005 });
    brass(v, 0.27, 'A4', 0.36, 0.06);
    brass(v, 0.27, 'C5', 0.36, 0.06);
    ['F6', 'A6', 'C7'].forEach((n, k) => glock(v, k * 0.09, n, 0.06, 0.3));
    glock(v, 0.27, 'F7', 0.08, 0.5);
    crash(v, 0.27, 0.06, 0.5);
    timpani(v, 0.27, 'F2', 0.22, 0.5);
  } },
  outbid: { dur: 0.25, max: 1, vary: 0, gain: 1, fn(v) { // someone topped your bid: a falling minor third
    glock(v, 0, 'E6', 0.2, 0.14);
    glock(v, 0.08, 'C#6', 0.22, 0.15);
  } },
};

/**
 * Default priority per name (sfx.play's `priority` overrides): 0 = never dropped (score moments),
 * 2 = dropped first when a burst of ≥ 12 voices starts within 100 ms (small and ambient sounds).
 */
const PRIORITY = {
  passGo: 0, jailSlam: 0, sold: 0, auctionEnd: 0, notify: 0, offer: 0, outbid: 0, setComplete: 0, victory: 0, bankrupt: 0, hotel: 0,
  hop: 2, diceBounce: 2, coin: 2, footstep: 2, pawStep: 2, chirp: 2, pigeonFlap: 2, gull: 2, stepTick: 2, hornCar: 2, bikeBell: 2, splitFlap: 2,
};

/** refDistance (m) of the inverse-distance model, by kind of sound (design §14.1). */
const REF_CLASSES = [
  [2, ['footstep', 'pawStep']],
  [6, ['horn', 'bark', 'purr', 'meow', 'squeak', 'stomp', 'clink', 'hatSpin', 'drive', 'engineStart', 'hydraulicHop', 'reverseBeep', 'doorSlam', 'hop', 'land']],
  [10, ['hornCar', 'brakeSqueal', 'skid', 'bikeBell']],
  [15, ['crowdAww', 'crowdOoh', 'applause', 'cheer', 'hornBus', 'tramBell', 'pigeonFlap', 'gull', 'chirp', 'confettiPop', 'ribbonSnip', 'doormanBell']],
  [20, ['hammer', 'drill', 'craneBeep', 'demolishRumble', 'demolish', 'build', 'barrierArm', 'gateSlide', 'chainFence', 'splitFlap']],
  [40, ['siren', 'whistleCop']],
  [60, ['trainHorn']],
  [150, ['firework']],
  [200, ['foghorn']],
  [300, ['thunder']],
];
const REF_DISTANCE = new Map(REF_CLASSES.flatMap(([d, names]) => names.map((n) => [n, d])));

/** Every sound name, in catalogue order. */
export const SOUND_NAMES = Object.freeze(Object.keys(SOUNDS));

// ---------------------------------------------------------------------------
// The music loop: a mellow, swung music-box tune over soft e-piano, bass and brushes.
// 8 bars of F major (Fmaj7 Dm7 Gm7 C9 Am7 D9 Gm7 C9) at 84 BPM; the scheduler runs continuously, so
// the loop is seamless. It sits very low under the effects and ducks under the big fanfares.
// ---------------------------------------------------------------------------

const BPM = 84;
const SPB = 60 / BPM;
const SWING = 0.62; // swung eighths: the off-beat falls at 0.62 of the beat
const LOOP_BEATS = 32;
export const MUSIC_LOOP_SECONDS = LOOP_BEATS * SPB;
const MUSIC_LEVEL = 0.2; // music bus gain once faded in: about 14 LU under the effects

const CHORDS = [ // per bar: bass root, bass fifth, rootless voicing
  ['F2', 'C3', ['A3', 'C4', 'E4']],
  ['D2', 'A2', ['F3', 'A3', 'C4']],
  ['G2', 'D3', ['F3', 'Bb3', 'D4']],
  ['C2', 'G2', ['E3', 'Bb3', 'D4']],
  ['A2', 'E3', ['G3', 'C4', 'E4']],
  ['D2', 'A2', ['F#3', 'C4', 'E4']],
  ['G2', 'D3', ['F3', 'Bb3', 'D4']],
  ['C2', 'G2', ['E3', 'Bb3', 'D4']],
];
const APPROACH = { 1: 'F#2', 3: 'G#2', 5: 'F#2', 7: 'E2' }; // chromatic step into the next bar's root

const MELODY = [ // [beat, note, beats]
  [0, 'A5', 1.5], [1.5, 'G5', 0.5], [2, 'A5', 1], [3, 'C6', 1],
  [4, 'D6', 1.5], [5.5, 'C6', 0.5], [6, 'A5', 2],
  [8, 'Bb5', 1], [9, 'A5', 0.5], [9.5, 'G5', 0.5], [10, 'F5', 1], [11, 'D5', 1],
  [12, 'E5', 1.5], [13.5, 'G5', 0.5], [14, 'C6', 2],
  [16, 'E6', 1], [17, 'D6', 0.5], [17.5, 'C6', 0.5], [18, 'A5', 2],
  [20, 'F#5', 1], [21, 'A5', 1], [22, 'C6', 1.5], [23.5, 'D6', 0.5],
  [24, 'D6', 1.5], [25.5, 'Bb5', 0.5], [26, 'G5', 1], [27, 'A5', 1],
  [28, 'Bb5', 1], [29, 'G5', 1], [30, 'E5', 1], [31, 'C5', 1],
];

const swung = (beat) => (beat % 1 === 0.5 ? Math.floor(beat) + SWING : beat);

/** One loop's events, sorted by beat: { beat, play(v) } with v.t already at the event's time. */
const LOOP = (() => {
  const events = [];
  const add = (beat, play) => events.push({ beat: swung(beat), play });
  CHORDS.forEach(([root, fifth, voicing], bar) => {
    const b = bar * 4;
    const bass = (f, hold, peak) => (v) => tone(v, 0, { type: 'triangle', f, a: 0.01, hold, d: 0.45, sustain: 0.45, peak, lp: 500 });
    add(b, bass(root, 1.2, 0.07));
    add(b + 2, bass(fifth, APPROACH[bar] ? 0.9 : 1.2, 0.06));
    if (APPROACH[bar]) add(b + 3.5, bass(APPROACH[bar], 0.2, 0.045));
    // a soft pad holds the harmony between the plucks, so the loop never drops out
    add(b, (v) => voicing.forEach((n) => tone(v, 0, { type: 'triangle', f: n, a: 0.35, hold: 2.3, d: 0.6, sustain: 0.8, peak: 0.012, lp: 900, vib: 0.002, vibRate: 4.5 })));
    add(b, (v) => voicing.forEach((n, k) => epiano(v, k * 0.012, n, 0.022, 1.8)));
    add(b + 2.5, (v) => voicing.forEach((n, k) => epiano(v, k * 0.01, n, 0.014, 1.1)));
    add(b, (v) => thump(v, 0, 110, 55, 0.14, 0.05)); // a felt kick
    for (const beat of [1, 3]) add(b + beat, (v) => hiss(v, 0, { f: 2800, q: 0.7, a: 0.02, d: 0.16, peak: 0.022 })); // brush
    for (const beat of [0, 1, 1.5, 2, 3, 3.5]) add(b + beat, (v) => hiss(v, 0, { type: 'highpass', f: 7000, a: 0.001, d: 0.05, peak: 0.012 })); // ride
  });
  for (const [beat, note, len] of MELODY) {
    add(beat, (v) => musicBox(v, 0, note, 0.05, Math.min(1.4, 0.5 + len * 0.45)));
  }
  return events.sort((a, b) => a.beat - b.beat);
})();

/** Schedules the loop's events that start in [from, to) (context seconds) for a loop starting at `origin`. */
function scheduleMusicWindow(c, dest, origin, from, to, rnd) {
  const first = Math.max(0, Math.floor((from - origin) / MUSIC_LOOP_SECONDS));
  for (let loop = first; origin + loop * MUSIC_LOOP_SECONDS < to; loop++) {
    for (const ev of LOOP) {
      const t = origin + (loop * LOOP_BEATS + ev.beat) * SPB;
      if (t >= from && t < to) ev.play({ ctx: c, out: dest, t, r: 1, rnd });
    }
  }
}

// ---------------------------------------------------------------------------
// Engine: the live context, master chain, voice limits, unlock, visibility and settings
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'monopoly.audio';
const DEFAULTS = Object.freeze({ enabled: true, volume: 0.7, music: false });
const LEAD = 0.01; // seconds of scheduling headroom, so an attack is never in the past
const MAX_VOICES = 48; // all names together
const GESTURES = ['pointerdown', 'pointerup', 'mousedown', 'touchstart', 'touchend', 'keydown', 'click'];

const hasWindow = typeof window !== 'undefined' && typeof window.addEventListener === 'function';
const pageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

function storage() {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null; // storage blocked (privacy settings, sandboxed frame)
  }
}

function readSettings() {
  const s = { ...DEFAULTS };
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const saved = raw ? JSON.parse(raw) : null;
    if (saved && typeof saved === 'object') {
      if (typeof saved.enabled === 'boolean') s.enabled = saved.enabled;
      if (typeof saved.volume === 'number' && Number.isFinite(saved.volume)) s.volume = clamp(saved.volume, 0, 1);
      if (typeof saved.music === 'boolean') s.music = saved.music;
    }
  } catch { /* unreadable or corrupt: defaults */ }
  return s;
}

function saveSettings() {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* full or blocked: the setting still applies to this page */ }
}

const settings = readSettings();

let ctx = null; // the live AudioContext, created by the first unlock()
let chain = null; // { sfx, music, master }
let primed = false; // the silent iOS kick has been played
let played = 0;
const live = new Map(); // name → [{ start, end }] voices scheduled or sounding
const music = { timer: null, origin: 0, until: 0 };
let warned = false;

function warnOnce(err) {
  if (warned) return;
  warned = true;
  try { console.warn('[sfx] audio problem (further ones are silent):', err); } catch { /* no console */ }
}

const volumeGain = (volume) => volume * volume;

/** y = x up to 0.7, then a tanh knee that never reaches 0.87: a transparent last-resort limiter. */
function softClipCurve() {
  const n = 4097;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const ax = Math.abs(x);
    const y = ax <= 0.7 ? ax : 0.7 + 0.17 * Math.tanh((ax - 0.7) / 0.17);
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

/**
 * The master chain on any context: returns { sfx, music, master } — the two bus inputs and the
 * volume gain in front of `destination`.
 */
export function masterChainInto(c, destination, volume = 1) {
  const master = gainNode(c, volumeGain(clamp(num(volume, 1), 0, 1)));
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value = 12;
  comp.ratio.value = 3;
  comp.attack.value = 0.004;
  comp.release.value = 0.25;
  const clip = c.createWaveShaper();
  clip.curve = softClipCurve();
  const sfxBus = gainNode(c, 1);
  const musicBus = gainNode(c, 0);
  sfxBus.connect(comp);
  musicBus.connect(comp);
  comp.connect(clip).connect(master).connect(destination);
  return { sfx: sfxBus, music: musicBus, master };
}

function ensureContext() {
  if (ctx) return ctx;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof AC !== 'function') return null;
  // Creating a context outside a user gesture only earns a console warning and a suspended context.
  if (globalThis.navigator?.userActivation && !globalThis.navigator.userActivation.hasBeenActive) return null;
  try {
    ctx = new AC({ latencyHint: 'interactive' });
  } catch {
    ctx = new AC(); // older Safari: no options
  }
  chain = masterChainInto(ctx, ctx.destination, settings.enabled ? settings.volume : 0);
  warmUp(ctx);
  try { applyListener(); } catch (err) { warnOnce(err); }
  return ctx;
}

/**
 * Builds the noise and applause buffers in idle moments right after the context exists, so the first
 * whoosh or cheer doesn't pay for them (5–30 ms each) in the middle of an animation.
 */
function warmUp(c) {
  const jobs = [() => noiseBuffer(c, 'white'), () => noiseBuffer(c, 'pink'), () => noiseBuffer(c, 'brown'), () => applauseBuffer(c)];
  const later = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 60));
  const next = () => {
    try {
      jobs.shift()?.();
    } catch (err) {
      warnOnce(err);
    }
    if (jobs.length) later(next);
  };
  later(next);
}

/** Called once audio is running: (re)start the music if it should play. */
function onRunning() {
  if (!ctx || ctx.state !== 'running') return;
  applyMusic();
}

/** Reserves a voice slot for `name` at [start, end), or refuses (voice limits, near-duplicate starts). */
function admit(name, def, start, end) {
  const now = ctx.currentTime;
  let total = 0;
  for (const [key, list] of live) {
    const alive = list.filter((x) => x.end > now);
    if (alive.length) live.set(key, alive);
    else live.delete(key);
    total += alive.length;
  }
  if (total >= MAX_VOICES) return false;
  const mine = live.get(name) ?? [];
  if (mine.filter((x) => x.start <= start && x.end > start).length >= (def.max ?? 3)) return false;
  if (mine.some((x) => Math.abs(x.start - start) < (def.gap ?? 0.03))) return false;
  mine.push({ start, end });
  live.set(name, mine);
  return true;
}

// --- space: the listener, positional voices -----------------------------------------------------------
// A sound placed in the city (play(name, { pos })) runs through an equal-power PannerNode (inverse
// distance, refDistance by kind of sound, maxDistance 800 m) and a distance low-pass, once a listener
// has been set (sfx.setListener) and the context can make panners. Otherwise it falls back to stereo pan.

const MAX_POSITIONAL = 16;
const MAX_DISTANCE = 800;
const listener = { set: false, x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0 };
let positional = []; // end times of live positional one-shots
const recentStarts = new Float64Array(32); // start times of the last voices (P2 burst dropping)
let recentAt = 0;

const finite3 = (p) => !!p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y ?? 0)) && Number.isFinite(Number(p.z));
const refDistanceOf = (name) => REF_DISTANCE.get(name) ?? 10;
const distanceCutoff = (c, d) => Math.min(nyquist(c), 18000 / (1 + Math.max(0, d) / 60));

function listenerDistance(p) {
  return Math.hypot(Number(p.x) - listener.x, Number(p.y ?? 0) - listener.y, Number(p.z) - listener.z);
}

/** Stereo pan of a world point seen from the listener (the fallback when there is no panner). */
function panOf(p) {
  const dx = Number(p.x) - listener.x, dy = Number(p.y ?? 0) - listener.y, dz = Number(p.z) - listener.z;
  // right = forward × up
  const rx = listener.fy * listener.uz - listener.fz * listener.uy;
  const ry = listener.fz * listener.ux - listener.fx * listener.uz;
  const rz = listener.fx * listener.uy - listener.fy * listener.ux;
  const len = Math.hypot(dx, dy, dz) || 1;
  return clamp(((dx * rx + dy * ry + dz * rz) / len) * 0.8, -0.8, 0.8);
}

function setParam(param, value, at, tau = 0) {
  if (!param) return;
  if (tau > 0 && typeof param.setTargetAtTime === 'function') param.setTargetAtTime(value, at, tau);
  else param.value = value;
}

/** A PannerNode at `p` (equal-power, inverse distance); `tau` > 0 glides an existing one. */
function makePanner(c, p, ref) {
  const pn = c.createPanner();
  pn.panningModel = 'equalpower';
  pn.distanceModel = 'inverse';
  pn.refDistance = ref;
  pn.maxDistance = MAX_DISTANCE;
  pn.rolloffFactor = 1;
  placePanner(pn, p, c.currentTime, 0);
  return pn;
}

function placePanner(pn, p, at, tau) {
  const x = Number(p.x), y = Number(p.y ?? 0), z = Number(p.z);
  if (pn.positionX) {
    setParam(pn.positionX, x, at, tau);
    setParam(pn.positionY, y, at, tau);
    setParam(pn.positionZ, z, at, tau);
  } else if (typeof pn.setPosition === 'function') {
    pn.setPosition(x, y, z);
  }
}

function applyListener() {
  if (!ctx || !listener.set) return;
  const L = ctx.listener;
  if (!L) return;
  const at = ctx.currentTime;
  if (L.positionX) {
    setParam(L.positionX, listener.x, at, 0.03);
    setParam(L.positionY, listener.y, at, 0.03);
    setParam(L.positionZ, listener.z, at, 0.03);
    setParam(L.forwardX, listener.fx, at, 0.03);
    setParam(L.forwardY, listener.fy, at, 0.03);
    setParam(L.forwardZ, listener.fz, at, 0.03);
    setParam(L.upX, listener.ux, at, 0.03);
    setParam(L.upY, listener.uy, at, 0.03);
    setParam(L.upZ, listener.uz, at, 0.03);
  } else { // Firefox: no AudioParams on the listener
    L.setPosition?.(listener.x, listener.y, listener.z);
    L.setOrientation?.(listener.fx, listener.fy, listener.fz, listener.ux, listener.uy, listener.uz);
  }
}

/**
 * Where the ears are (metres, world space): sfx.setListener(pos, forward, up = {0, 1, 0}). Positional
 * sounds and loops are heard from here. Never throws; harmless before audio exists (applied on unlock).
 */
function setListener(pos, forward, up) {
  try {
    if (!finite3(pos)) return;
    const f = finite3(forward) ? forward : { x: 0, y: 0, z: -1 };
    const u = finite3(up) ? up : { x: 0, y: 1, z: 0 };
    const fl = Math.hypot(f.x, f.y ?? 0, f.z) || 1;
    const ul = Math.hypot(u.x, u.y ?? 0, u.z) || 1;
    listener.x = Number(pos.x); listener.y = Number(pos.y ?? 0); listener.z = Number(pos.z);
    listener.fx = f.x / fl; listener.fy = (f.y ?? 0) / fl; listener.fz = f.z / fl;
    listener.ux = u.x / ul; listener.uy = (u.y ?? 0) / ul; listener.uz = u.z / ul;
    listener.set = true;
    applyListener();
  } catch (err) {
    warnOnce(err);
  }
}

/**
 * Builds one voice of `name` into `dest` at time `t`; returns the voice's output and tail nodes.
 * `spatial` = { x, y, z, ref, d } routes it through a distance low-pass and a PannerNode instead of `pan`.
 */
function voice(c, dest, name, t, { volume = 1, rate = 1, pan = 0, rnd = Math.random, spatial = null } = {}) {
  const def = SOUNDS[name];
  const out = gainNode(c, volume * (def.gain ?? 1));
  let tail = out;
  if (spatial && typeof c.createPanner === 'function') {
    let node = out;
    if (Number.isFinite(spatial.d)) node = node.connect(filterNode(c, 'lowpass', distanceCutoff(c, spatial.d), 0.5));
    tail = makePanner(c, spatial, spatial.ref ?? refDistanceOf(name));
    node.connect(tail);
  } else if (pan && typeof c.createStereoPanner === 'function') {
    tail = c.createStereoPanner();
    tail.pan.value = clamp(pan, -1, 1);
    out.connect(tail);
  }
  tail.connect(dest);
  def.fn({ ctx: c, out, t, r: rate, rnd });
  return { out, tail };
}

/** Voices started within 100 ms of `start` (the P2 burst rule). */
function burstAround(start) {
  let n = 0;
  for (let i = 0; i < recentStarts.length; i++) if (recentStarts[i] > 0 && Math.abs(recentStarts[i] - start) < 0.1) n++;
  return n;
}

function play(name, opts) {
  try {
    if (typeof name !== 'string' || !Object.hasOwn(SOUNDS, name)) return;
    if (!settings.enabled || !ctx || !chain || ctx.state !== 'running' || pageHidden()) return;
    const o = opts && typeof opts === 'object' ? opts : {};
    const volume = clamp(num(o.volume, 1), 0, 2);
    if (volume < 0.001) return;
    const def = SOUNDS[name];
    let delay = num(o.delay, 0);
    if (delay > 30) delay /= 1000; // milliseconds, by the look of it
    delay = clamp(delay, 0, 30);
    const human = def.vary ?? 0.03;
    const rate = clamp(num(o.rate, 1), 0.25, 4) * (1 + (Math.random() * 2 - 1) * human);
    const start = ctx.currentTime + LEAD + delay + (human ? Math.random() * 0.005 : 0);
    const end = start + def.dur / rate;
    const priority = [0, 1, 2].includes(o.priority) ? o.priority : (PRIORITY[name] ?? 1);
    if (priority >= 2 && burstAround(start) >= 12) return;
    // Placed in the city: a panner once a listener exists (and the context makes panners), else stereo pan.
    let pan = clamp(num(o.pan, 0), -1, 1);
    let spatial = null;
    if (finite3(o.pos) && listener.set) {
      const d = listenerDistance(o.pos);
      if (d > MAX_DISTANCE * 1.5) return; // far beyond hearing
      positional = positional.filter((e) => e > ctx.currentTime);
      if (typeof ctx.createPanner === 'function' && positional.length < MAX_POSITIONAL) {
        spatial = { x: Number(o.pos.x), y: Number(o.pos.y ?? 0), z: Number(o.pos.z), d, ref: refDistanceOf(name) };
      } else if (!Number.isFinite(Number(o.pan))) {
        pan = panOf(o.pos);
      }
    }
    if (!admit(name, def, start, end)) return;
    const gain = volume * (human ? 1 + (Math.random() * 2 - 1) * 0.07 : 1);
    const { out, tail } = voice(ctx, chain.sfx, name, start, { volume: gain, rate, pan, spatial });
    played++;
    recentStarts[recentAt++ % recentStarts.length] = start;
    if (spatial) positional.push(end);
    if (def.duck) duckMusic(start, end);
    // Sources stop themselves; drop the voice's own nodes from the graph once it is over.
    setTimeout(() => {
      try { out.disconnect(); tail.disconnect(); } catch { /* already gone */ }
    }, (end - ctx.currentTime + 0.5) * 1000);
  } catch (err) {
    warnOnce(err);
  }
}

// ---------------------------------------------------------------------------
// Loops (design §14.3): continuous voices — character engines and the city's ambience beds — from a
// separate LOOPS registry (not in SOUND_NAMES, not counted by status()). sfx.loop(name, opts) returns a
// handle { set({ volume, rate, pos, pan, lowpass }), stop(fade), playing }; parameter changes glide.
// Inert (playing: false) when the name is unknown, audio is off / not unlocked / suspended, or the tab
// is hidden. Every loop stops when sound is switched off.
// ---------------------------------------------------------------------------

/**
 * Loop builder context: continuous sources started at L.t; `rate` lists [AudioParam, base] pairs that
 * follow handle.set({ rate }); `events(from, to)` (optional) schedules grains (chirps, ticks, gull cries)
 * into L.out for [from, to). L.state.rate is the current rate (event loops read it).
 */
function loopKit(c, out, t, rnd) {
  const L = { ctx: c, out, t, rnd, sources: [], rate: [], state: { rate: 1 }, events: null };
  L.noise = (color, { type = 'bandpass', f = 1000, q = 0.7, gain = 0.1, dest = out, follow = false, speed = 1 } = {}) => {
    const s = c.createBufferSource();
    s.buffer = noiseBuffer(c, color);
    s.loop = true;
    s.playbackRate.value = speed;
    const flt = filterNode(c, type, f, q);
    const g = gainNode(c, gain);
    s.connect(flt).connect(g).connect(dest);
    s.start(t, rnd() * (NOISE_SECONDS - 0.5));
    L.sources.push(s);
    if (follow) L.rate.push([flt.frequency, f]);
    return { src: s, flt, g };
  };
  L.osc = (type, f, { gain = 0.1, dest = out, follow = true } = {}) => {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = Math.min(f, nyquist(c));
    const g = gainNode(c, gain);
    o.connect(g).connect(dest);
    o.start(t);
    L.sources.push(o);
    if (follow) L.rate.push([o.frequency, f]);
    return { o, g };
  };
  /** An LFO adding ±depth to `param` (follow: its frequency tracks the rate). */
  L.lfo = (f, depth, param, { type = 'sine', follow = false } = {}) => {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.connect(gainNode(c, depth)).connect(param);
    o.start(t);
    L.sources.push(o);
    if (follow) L.rate.push([o.frequency, f]);
    return o;
  };
  L.gain = (value = 1, dest = out) => {
    const g = gainNode(c, value);
    g.connect(dest);
    return g;
  };
  L.filter = (type, f, q = 0.707, dest = out, follow = false) => {
    const flt = filterNode(c, type, f, q);
    flt.connect(dest);
    if (follow) L.rate.push([flt.frequency, f]);
    return flt;
  };
  /** A grain: one of the one-shot recipes into the loop (`at` is context time). */
  L.grain = (name, at, { volume = 1, rate = 1, pan = 0 } = {}) => {
    const def = SOUNDS[name];
    if (!def) return;
    const g = gainNode(c, volume * (def.gain ?? 1));
    let tail = g;
    if (pan && typeof c.createStereoPanner === 'function') {
      tail = c.createStereoPanner();
      tail.pan.value = clamp(pan, -1, 1);
      g.connect(tail);
    }
    tail.connect(out);
    def.fn({ ctx: c, out: g, t: at, r: rate, rnd });
  };
  /** Calls fn(at) at random intervals in [lo, hi] s over [from, to) (keeps its own schedule). */
  L.every = (lo, hi, fn) => {
    let next = t + lo + rnd() * (hi - lo);
    return (from, to) => {
      if (next < from) next = from + rnd() * (hi - lo) * 0.5;
      while (next < to) {
        fn(next);
        next += (lo + rnd() * (hi - lo)) / Math.max(0.25, L.state.rate || 1);
      }
    };
  };
  return L;
}

/** Combines several event schedulers into one. */
const allOf = (...fns) => (from, to) => { for (const fn of fns) fn(from, to); };

const LOOPS = {
  // --- the characters' engines (rate = rpm: 1 at idle-ish cruise, ~0.6 idle, up to ~2.5) -----------
  engineRoadster: { gain: 0.55, ref: 6, build(L) { // 1930s straight-six: saw harmonics and firing pulses
    const lp = L.filter('lowpass', 650, 1.2, L.out, true);
    const putt = L.gain(0.55, lp);
    L.lfo(24, 0.4, putt.gain, { type: 'square', follow: true });
    for (const k of [1, 1.008]) L.osc('sawtooth', 48 * k, { gain: 0.3, dest: putt });
    L.osc('square', 24, { gain: 0.12, dest: putt });
    L.noise('pink', { f: 900, q: 0.8, gain: 0.03, follow: true });
  } },
  engineBubble: { gain: 0.5, ref: 6, build(L) { // the bubble car's two-stroke buzz
    const bp = L.filter('bandpass', 1000, 1.4, L.out, true);
    const am = L.gain(0.5, bp);
    L.lfo(46, 0.45, am.gain, { type: 'square', follow: true });
    L.osc('square', 92, { gain: 0.25, dest: am });
    L.osc('sawtooth', 184, { gain: 0.12, dest: am });
    L.noise('white', { type: 'highpass', f: 3000, gain: 0.01 });
  } },
  engineBoot: { gain: 0.55, ref: 6, build(L) { // the boot car's lumpy big-block burble
    const lp = L.filter('lowpass', 420, 1.6, L.out, true);
    const am = L.gain(0.5, lp);
    L.lfo(18, 0.3, am.gain, { type: 'square', follow: true });
    L.lfo(7, 0.15, am.gain, { follow: true });
    for (const k of [1, 1.009]) L.osc('sawtooth', 36 * k, { gain: 0.3, dest: am });
    L.osc('square', 18, { gain: 0.15, dest: am });
  } },
  dieselBoat: { gain: 0.6, ref: 8, build(L) { // a duck boat's diesel chug over lapping water
    const lp = L.filter('lowpass', 300, 1, L.out, true);
    L.osc('sawtooth', 38, { gain: 0.25, dest: lp });
    const chug = L.gain(0.4);
    L.lfo(5.5, 0.38, chug.gain, { type: 'square', follow: true });
    L.noise('brown', { f: 160, q: 1, gain: 0.5, dest: chug, follow: true });
    const lap = L.gain(0.5);
    L.lfo(0.35, 0.3, lap.gain);
    L.noise('brown', { type: 'lowpass', f: 500, gain: 0.3, dest: lap });
  } },
  pennyTick: { gain: 0.6, ref: 4, build(L) { // a penny-farthing: spoke ticks and tyre hiss
    L.noise('pink', { type: 'lowpass', f: 1200, gain: 0.02, follow: true });
    L.events = L.every(0.12, 0.16, (at) => {
      L.grain('stepTick', at, { volume: 0.35, rate: 1.4 });
    });
  } },

  // --- the city's beds ----------------------------------------------------------------------------
  cityHum: { gain: 0.6, ref: 60, build(L) { // the distant city everywhere: a low rumble
    const g = L.gain(1);
    L.lfo(0.04, 0.25, g.gain);
    L.noise('brown', { type: 'lowpass', f: 160, gain: 0.35, dest: g });
    L.noise('pink', { f: 450, q: 0.6, gain: 0.06, dest: g });
  } },
  trafficBed: { gain: 0.6, ref: 30, build(L) { // nearby traffic: rumble, tyre hiss and pass-bys
    const g1 = L.gain(1);
    L.lfo(0.06, 0.3, g1.gain);
    L.noise('brown', { f: 300, q: 0.5, gain: 0.3, dest: g1 });
    const g2 = L.gain(1);
    L.lfo(0.11, 0.35, g2.gain);
    L.noise('pink', { f: 1300, q: 0.7, gain: 0.06, dest: g2 });
    const passBy = (at) => {
      const v = { ctx: L.ctx, out: L.out, t: at, r: 0.9 + L.rnd() * 0.4, rnd: L.rnd };
      hiss(v, 0, { color: 'pink', path: [[0, 500], [0.35, 1500], [0.75, 600]], q: 0.9, a: 0.3, hold: 0.05, d: 0.4, peak: 0.05 + L.rnd() * 0.04 });
    };
    L.events = L.every(1.8, 5.5, passBy);
  } },
  parkBed: { gain: 0.6, ref: 25, build(L) { // leaves in the wind, small birds
    const g = L.gain(1);
    L.lfo(0.13, 0.4, g.gain);
    L.noise('pink', { type: 'bandpass', f: 2600, q: 0.5, gain: 0.05, dest: g });
    L.noise('white', { type: 'highpass', f: 6000, gain: 0.006, dest: g });
    L.events = L.every(0.8, 3, (at) => L.grain('chirp', at, { volume: 0.25 + L.rnd() * 0.45, rate: 0.85 + L.rnd() * 0.45, pan: L.rnd() * 1.2 - 0.6 }));
  } },
  marketBed: { gain: 0.6, ref: 20, build(L) { // a market murmur and the odd till
    for (const [f, q] of [[400, 2], [750, 2.5], [1300, 3], [2300, 3]]) {
      const g = L.gain(0.6);
      L.lfo(3 + L.rnd() * 3, 0.4, g.gain);
      L.noise('pink', { f, q, gain: 0.06, dest: g });
    }
    L.events = L.every(3, 8, (at) => {
      const v = { ctx: L.ctx, out: L.out, t: at, r: 1, rnd: L.rnd };
      modal(v, 0, 2900 + L.rnd() * 400, BELL, 0.04, { decay: 0.4 });
    });
  } },
  harbourBed: { gain: 0.6, ref: 40, build(L) { // waves, lapping, rigging, gulls
    const waves = L.gain(0.7);
    L.lfo(0.11, 0.3, waves.gain);
    L.noise('pink', { type: 'lowpass', f: 700, gain: 0.18, dest: waves });
    const lap = L.gain(0.6);
    L.lfo(0.6, 0.35, lap.gain);
    L.noise('brown', { f: 260, q: 0.8, gain: 0.25, dest: lap });
    L.events = allOf(
      L.every(4, 11, (at) => L.grain('gull', at, { volume: 0.25 + L.rnd() * 0.3, rate: 0.9 + L.rnd() * 0.25, pan: L.rnd() * 1.4 - 0.7 })),
      L.every(1, 3, (at) => clinkAt({ ctx: L.ctx, out: L.out, t: at, r: 1, rnd: L.rnd }, 0, 2200 + L.rnd() * 1400, 0.012, 0.25)),
    );
  } },
  windHigh: { gain: 0.6, ref: 60, build(L) { // altitude: wind with gusts
    const g = L.gain(0.7);
    L.lfo(0.09, 0.3, g.gain);
    const n = L.noise('pink', { f: 520, q: 0.8, gain: 0.25, dest: g });
    L.lfo(0.07, 250, n.flt.frequency);
    L.noise('white', { type: 'highpass', f: 2500, gain: 0.015, dest: g });
  } },
  rainBed: { gain: 0.6, ref: 30, build(L) { // rain on the streets
    const hi = L.filter('lowpass', 9000);
    L.noise('white', { type: 'highpass', f: 900, gain: 0.07, dest: hi });
    L.noise('pink', { f: 3200, q: 0.6, gain: 0.05 });
    L.noise('brown', { type: 'lowpass', f: 300, gain: 0.08 });
    L.events = L.every(0.06, 0.22, (at) => {
      const v = { ctx: L.ctx, out: L.out, t: at, r: 0.7 + L.rnd() * 0.8, rnd: L.rnd };
      hiss(v, 0, { f: 2500 + L.rnd() * 2500, q: 2, a: 0.001, d: 0.012, peak: 0.01 + L.rnd() * 0.02 });
    });
  } },
  constructionBed: { gain: 0.6, ref: 20, build(L) { // a building site: machinery, hammers, a drill, the crane
    const lp = L.filter('lowpass', 250, 1);
    L.osc('sawtooth', 58, { gain: 0.05, dest: lp, follow: false });
    L.noise('brown', { f: 220, q: 0.8, gain: 0.1 });
    L.events = allOf(
      L.every(0.6, 1.6, (at) => L.grain('hammer', at, { volume: 0.5 + L.rnd() * 0.3, rate: 0.85 + L.rnd() * 0.3 })),
      L.every(4, 9, (at) => L.grain('drill', at, { volume: 0.45 })),
      L.every(10, 20, (at) => L.grain('craneBeep', at, { volume: 0.4 })),
    );
  } },
  crowdMurmur: { gain: 0.6, ref: 15, build(L) { // people talking
    for (const [f, q] of [[420, 2.5], [680, 2.5], [1050, 3], [1600, 3], [2500, 3]]) {
      const g = L.gain(0.5);
      L.lfo(2.5 + L.rnd() * 3, 0.45, g.gain);
      L.noise('pink', { f, q, gain: 0.07, dest: g });
    }
  } },
  nightBed: { gain: 0.6, ref: 25, build(L) { // crickets and a soft night wind
    for (const f of [4400, 4650]) {
      const groups = L.gain(0.5);
      L.lfo(1.4 + L.rnd() * 0.5, 0.5, groups.gain, { type: 'square' });
      const pulses = L.gain(0.5, groups);
      L.lfo(28 + L.rnd() * 4, 0.5, pulses.gain, { type: 'square' });
      L.osc('sine', f, { gain: 0.02, dest: pulses, follow: false });
    }
    L.noise('pink', { type: 'lowpass', f: 400, gain: 0.05 });
  } },
  sirenLoop: { gain: 0.5, ref: 40, build(L) { // a police wail, round and round (rate: Doppler)
    const bp = L.filter('bandpass', 1100, 0.8, L.out, true);
    for (const [type, gain] of [['triangle', 0.3], ['square', 0.05]]) {
      const o = L.osc(type, 950, { gain, dest: bp });
      L.lfo(0.32, 330, o.o.frequency, { follow: true });
    }
  } },
  trainRumble: { gain: 0.6, ref: 60, build(L) { // a passing train: rumble, rail joints, motor whine
    L.noise('brown', { type: 'lowpass', f: 220, gain: 0.4, follow: true });
    L.noise('pink', { f: 1800, q: 3, gain: 0.02, follow: true });
    const whine = L.filter('lowpass', 1000);
    L.osc('sawtooth', 210, { gain: 0.012, dest: whine });
    L.events = L.every(1.2, 1.4, (at) => {
      for (const dt of [0, 0.09]) {
        const v = { ctx: L.ctx, out: L.out, t: at + dt, r: 1, rnd: L.rnd };
        thump(v, 0, 95, 60, 0.06, 0.12);
        knock(v, 0, 700, 0.05, 0.4);
      }
    });
  } },
  fountainBed: { gain: 0.6, ref: 15, build(L) { // a plaza fountain
    const flutter = L.gain(0.85);
    L.lfo(7, 0.15, flutter.gain);
    L.noise('white', { f: 1900, q: 0.6, gain: 0.08, dest: flutter });
    L.noise('pink', { type: 'lowpass', f: 5000, gain: 0.06, dest: flutter });
    L.noise('brown', { type: 'lowpass', f: 300, gain: 0.05 });
  } },
};

/** Every loop name (disjoint from SOUND_NAMES). */
export const LOOP_NAMES = Object.freeze(Object.keys(LOOPS));

const MAX_LOOPS = 24;
const LOOP_TICK_MS = 100;
const LOOP_AHEAD = 0.4; // seconds of grains scheduled ahead of the clock
const loops = new Set(); // live loop voices
let loopTimer = null;

/**
 * Builds a loop voice into `dest` at `t`: sources → def gain → low-pass → volume → (panner | stereo pan).
 * Returns { L, inner, lp, vol, tail, ref }.
 */
function buildLoop(c, dest, name, t, { volume = 1, rate = 1, pan = 0, spatial = null, lowpass = 0, rnd = Math.random, fadeIn = 0.15 } = {}) {
  const def = LOOPS[name];
  const vol = gainNode(c, 0);
  const v0 = clamp(num(volume, 1), 0, 2);
  if (fadeIn > 0) {
    vol.gain.setValueAtTime(0, t);
    vol.gain.linearRampToValueAtTime(v0, t + fadeIn);
  } else vol.gain.value = v0;
  const lp = filterNode(c, 'lowpass', lowpass > 0 ? Math.min(lowpass, nyquist(c)) : nyquist(c), 0.5);
  const inner = gainNode(c, def.gain ?? 1);
  inner.connect(lp).connect(vol);
  let tail = vol;
  const ref = def.ref ?? 10;
  if (spatial && typeof c.createPanner === 'function') {
    tail = makePanner(c, spatial, ref);
    vol.connect(tail);
  } else if (typeof c.createStereoPanner === 'function') {
    tail = c.createStereoPanner();
    tail.pan.value = clamp(num(pan, 0), -1, 1);
    vol.connect(tail);
  }
  tail.connect(dest);
  const L = loopKit(c, inner, t, rnd);
  def.build(L);
  const r = clamp(num(rate, 1), 0.1, 4);
  if (r !== 1) {
    L.state.rate = r;
    for (const [param, base] of L.rate) param.value = Math.min(base * r, nyquist(c));
  }
  return { L, inner, lp, vol, tail, ref };
}

const INERT_LOOP = Object.freeze({ set() {}, stop() {}, get playing() { return false; } });

function loopTick() {
  try {
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    for (const lv of loops) {
      if (!lv.L.events || lv.stopped) continue;
      if (lv.until < now - 1) lv.until = now; // the timer stalled: no backlog
      const to = now + LOOP_AHEAD;
      if (to <= lv.until) continue;
      lv.L.events(Math.max(lv.until, now), to);
      lv.until = to;
    }
  } catch (err) {
    warnOnce(err);
  }
}

function syncLoopTimer() {
  const need = [...loops].some((lv) => lv.L.events);
  if (need && !loopTimer) loopTimer = setInterval(loopTick, LOOP_TICK_MS);
  else if (!need && loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
}

function stopLoopVoice(lv, fade) {
  if (lv.stopped) return;
  lv.stopped = true;
  loops.delete(lv);
  syncLoopTimer();
  try {
    const now = ctx.currentTime;
    const f = clamp(num(fade, 0.3), 0.01, 10);
    glideTo(lv.vol.gain, 0, now, f / 4);
    const end = now + f + 0.05;
    for (const s of lv.L.sources) { try { s.stop(end); } catch { /* already stopped */ } }
    setTimeout(() => {
      try { lv.tail.disconnect(); lv.vol.disconnect(); } catch { /* gone */ }
    }, (f + 0.5) * 1000);
  } catch (err) {
    warnOnce(err);
  }
}

/** Stops every live loop (sound switched off, view disposed). */
function stopLoops(fade = 0.2) {
  for (const lv of [...loops]) stopLoopVoice(lv, fade);
}

/**
 * Starts a continuous voice: sfx.loop(name, { volume = 1, rate = 1, pos, pan = 0, lowpass }) →
 * { set({ volume, rate, pos, pan, lowpass }), stop(fade = 0.3), playing }.
 */
function loop(name, opts) {
  try {
    if (typeof name !== 'string' || !Object.hasOwn(LOOPS, name)) return INERT_LOOP;
    if (!settings.enabled || !ctx || !chain || ctx.state !== 'running' || pageHidden()) return INERT_LOOP;
    if (loops.size >= MAX_LOOPS) return INERT_LOOP;
    const o = opts && typeof opts === 'object' ? opts : {};
    const spatial = finite3(o.pos) && listener.set ? { x: Number(o.pos.x), y: Number(o.pos.y ?? 0), z: Number(o.pos.z) } : null;
    const t = ctx.currentTime + LEAD;
    let userLp = num(o.lowpass, 0) > 0 ? num(o.lowpass, 0) : 0;
    const d0 = spatial ? listenerDistance(spatial) : NaN;
    const lp0 = Math.min(userLp || nyquist(ctx), spatial ? distanceCutoff(ctx, d0) : nyquist(ctx));
    const built = buildLoop(ctx, chain.sfx, name, t, {
      volume: o.volume ?? 1, rate: o.rate ?? 1, pan: spatial ? 0 : num(o.pan, 0), spatial, lowpass: lp0,
    });
    const lv = { ...built, name, until: t, stopped: false };
    const isSpatial = !!(spatial && typeof ctx.createPanner === 'function');
    loops.add(lv);
    syncLoopTimer();
    if (lv.L.events) loopTick();
    const handle = {
      set(p) {
        try {
          if (lv.stopped || !p || typeof p !== 'object') return;
          const now = ctx.currentTime;
          if (Number.isFinite(Number(p.volume))) glideTo(lv.vol.gain, clamp(Number(p.volume), 0, 2), now, 0.05);
          if (Number.isFinite(Number(p.rate))) {
            const r = clamp(Number(p.rate), 0.1, 4);
            lv.L.state.rate = r;
            for (const [param, base] of lv.L.rate) glideTo(param, Math.min(base * r, nyquist(ctx)), now, 0.05);
          }
          if (Number.isFinite(Number(p.lowpass))) userLp = Number(p.lowpass) > 0 ? Number(p.lowpass) : 0;
          if (isSpatial && finite3(p.pos)) {
            placePanner(lv.tail, p.pos, now, 0.05);
            const d = listenerDistance(p.pos);
            glideTo(lv.lp.frequency, Math.max(40, Math.min(userLp || nyquist(ctx), distanceCutoff(ctx, d))), now, 0.05);
          } else {
            if (Number.isFinite(Number(p.lowpass))) glideTo(lv.lp.frequency, Math.max(40, Math.min(userLp || nyquist(ctx), nyquist(ctx))), now, 0.05);
            const pan = Number.isFinite(Number(p.pan)) ? Number(p.pan) : finite3(p.pos) && listener.set ? panOf(p.pos) : NaN;
            if (Number.isFinite(pan) && lv.tail.pan) glideTo(lv.tail.pan, clamp(pan, -1, 1), now, 0.05);
          }
        } catch (err) {
          warnOnce(err);
        }
      },
      stop(fade = 0.3) {
        try { stopLoopVoice(lv, fade); } catch (err) { warnOnce(err); }
      },
      get playing() {
        return !lv.stopped;
      },
    };
    return handle;
  } catch (err) {
    warnOnce(err);
    return INERT_LOOP;
  }
}

function unlock() {
  try {
    if (!settings.enabled || pageHidden()) return;
    const c = ensureContext();
    if (!c) return;
    if (!primed) { // iOS unlocks only after something actually plays inside the gesture
      primed = true;
      const src = c.createBufferSource();
      src.buffer = c.createBuffer(1, 1, c.sampleRate);
      src.connect(c.destination);
      src.start();
    }
    if (c.state === 'running') onRunning();
    else c.resume().then(onRunning, () => { /* not allowed yet: the next gesture retries */ });
  } catch (err) {
    warnOnce(err);
  }
}

function onGesture() {
  if (settings.enabled && (!ctx || ctx.state !== 'running')) unlock();
}

function onVisibility() {
  try {
    if (!ctx) return;
    if (pageHidden()) {
      if (ctx.state === 'running') ctx.suspend().catch(() => {});
    } else if (settings.enabled) {
      ctx.resume().then(onRunning, () => {});
    }
  } catch (err) {
    warnOnce(err);
  }
}

/** Another tab changed the audio settings: follow them. */
function onStorage(e) {
  if (e.key !== STORAGE_KEY) return;
  const next = readSettings();
  if (next.enabled !== settings.enabled) setEnabled(next.enabled, false);
  if (next.volume !== settings.volume) setVolume(next.volume, false);
  if (next.music !== settings.music) setMusic(next.music, false);
}

/** Glides an AudioParam to `value` from wherever it is at `at` (no jump, even in the middle of a ramp). */
function glideTo(param, value, at, tau) {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    param.cancelAndHoldAtTime(at);
  } else { // Firefox
    param.cancelScheduledValues(at);
    param.setValueAtTime(param.value, at);
  }
  param.setTargetAtTime(value, at, tau);
}

function applyVolume() {
  if (!ctx || !chain) return;
  glideTo(chain.master.gain, settings.enabled ? volumeGain(settings.volume) : 0, ctx.currentTime, 0.02);
}

function setEnabled(on, persist = true) {
  try {
    settings.enabled = !!on;
    if (persist) saveSettings();
    if (settings.enabled) {
      applyVolume();
      unlock();
    } else if (ctx) {
      stopMusic();
      stopLoops(0.1);
      applyVolume();
      setTimeout(() => {
        if (!settings.enabled && ctx.state === 'running') ctx.suspend().catch(() => {});
      }, 150);
    }
  } catch (err) {
    warnOnce(err);
  }
}

function setVolume(value, persist = true) {
  try {
    settings.volume = clamp(num(Number(value), settings.volume), 0, 1);
    if (persist) saveSettings();
    applyVolume();
  } catch (err) {
    warnOnce(err);
  }
}

function setMusic(on, persist = true) {
  try {
    settings.music = !!on;
    if (persist) saveSettings();
    applyMusic();
  } catch (err) {
    warnOnce(err);
  }
}

// --- music scheduler -----------------------------------------------------------

const MUSIC_TICK_MS = 100;
const MUSIC_AHEAD = 0.35; // seconds scheduled ahead of the clock

function applyMusic() {
  const want = settings.music && settings.enabled && ctx && ctx.state === 'running';
  if (want && !music.timer) startMusic();
  else if (!settings.music || !settings.enabled) stopMusic();
}

function startMusic() {
  const now = ctx.currentTime;
  music.origin = now + 0.15;
  music.until = music.origin;
  glideTo(chain.music.gain, MUSIC_LEVEL, now, 0.6); // fades in over ~2 s
  music.timer = setInterval(musicTick, MUSIC_TICK_MS);
  musicTick();
}

function stopMusic() {
  if (!music.timer) return;
  clearInterval(music.timer);
  music.timer = null;
  if (ctx && chain) glideTo(chain.music.gain, 0, ctx.currentTime, 0.15);
}

function musicTick() {
  try {
    if (!ctx || ctx.state !== 'running') return; // suspended (hidden tab): the clock is frozen too
    const now = ctx.currentTime;
    if (music.until < now - 1) { // the timer stalled: skip ahead, keeping the beat grid
      const beats = Math.ceil((now - music.origin) / SPB);
      music.until = music.origin + beats * SPB;
    }
    const to = now + MUSIC_AHEAD;
    if (to <= music.until) return;
    scheduleMusicWindow(ctx, chain.music, music.origin, Math.max(music.until, now), to, Math.random);
    music.until = to;
  } catch (err) {
    warnOnce(err);
  }
}

/** Dips the music under a fanfare, then brings it back. */
function duckMusic(start, end) {
  if (!music.timer || !chain) return;
  const g = chain.music.gain;
  glideTo(g, MUSIC_LEVEL * 0.35, start, 0.05);
  g.setTargetAtTime(MUSIC_LEVEL, Math.max(start + 0.2, end - 0.3), 0.35);
}

// --- wiring ------------------------------------------------------------------------

if (hasWindow) {
  for (const type of GESTURES) window.addEventListener(type, onGesture, { capture: true, passive: true });
  window.addEventListener('storage', onStorage);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
}

export const sfx = {
  play,
  unlock,
  setEnabled: (on) => setEnabled(on),
  isEnabled: () => settings.enabled,
  setVolume: (value) => setVolume(value),
  getVolume: () => settings.volume,
  setMusic: (on) => setMusic(on),
  isMusicOn: () => settings.music,
  /** The listener for positional sounds (metres, world space). */
  setListener,
  /** A continuous voice from LOOP_NAMES → { set, stop, playing } (inert when audio is unavailable). */
  loop,
  /** Stops every live loop. */
  stopLoops: (fade) => { try { stopLoops(fade); } catch (err) { warnOnce(err); } },
  /** Diagnostics: context state, voices alive, sounds played so far, whether the music loop runs. */
  status() {
    let voices = 0;
    const now = ctx?.currentTime ?? 0;
    for (const list of live.values()) voices += list.filter((x) => x.end > now).length;
    return { state: ctx ? ctx.state : 'none', voices, played, music: !!music.timer };
  },
};

export default sfx;

// ---------------------------------------------------------------------------
// Offline rendering (tests, the audition page): the same recipes into any BaseAudioContext
// ---------------------------------------------------------------------------

/** Budgeted length of a sound in seconds at rate 1 (0 for an unknown name). */
export function soundBudget(name) {
  return Object.hasOwn(SOUNDS, name) ? SOUNDS[name].dur : 0;
}

/**
 * Schedules one sound into `destination` of any BaseAudioContext at context time `when`, with no
 * random variation beyond the seeded `seed`. Returns the budgeted end time, or 0 for an unknown name.
 */
export function renderInto(c, destination, name, when = 0, { volume = 1, rate = 1, pan = 0, seed = 1, pos = null } = {}) {
  if (!Object.hasOwn(SOUNDS, name)) return 0;
  const r = clamp(num(rate, 1), 0.25, 4);
  // `pos` (with a panner-capable context): placed relative to that context's listener at its origin.
  const spatial = finite3(pos) && typeof c.createPanner === 'function'
    ? { x: Number(pos.x), y: Number(pos.y ?? 0), z: Number(pos.z), d: Math.hypot(Number(pos.x), Number(pos.y ?? 0), Number(pos.z)), ref: refDistanceOf(name) }
    : null;
  voice(c, destination, name, when, { volume: clamp(num(volume, 1), 0, 2), rate: r, pan, rnd: mulberry32(seed), spatial });
  return when + SOUNDS[name].dur / r;
}

/**
 * Schedules `seconds` of the loop `name` into `destination` of any BaseAudioContext from `when`: every
 * source starts at `when` and stops by `when + seconds` (grains are only started while they can finish).
 * Returns the end time, or 0 for an unknown name.
 */
export function renderLoopInto(c, destination, name, when = 0, seconds = 2, { volume = 1, rate = 1, pan = 0, seed = 1, lowpass = 0, pos = null } = {}) {
  if (!Object.hasOwn(LOOPS, name)) return 0;
  const len = Math.max(0.1, num(seconds, 2));
  const end = when + len;
  const spatial = finite3(pos) && typeof c.createPanner === 'function' ? { x: Number(pos.x), y: Number(pos.y ?? 0), z: Number(pos.z) } : null;
  const lv = buildLoop(c, destination, name, when, { volume, rate, pan, spatial, lowpass, rnd: mulberry32(seed), fadeIn: Math.min(0.15, len / 4) });
  // fade out over the last 50 ms, then stop
  const fade = Math.min(0.05, len / 4);
  lv.vol.gain.setValueAtTime(clamp(num(volume, 1), 0, 2), end - fade);
  lv.vol.gain.linearRampToValueAtTime(0, end);
  if (lv.L.events) lv.L.events(when, end - 1.0);
  for (const s of lv.L.sources) s.stop(end);
  return end;
}

/** Whether `name` is a loop (LOOP_NAMES). */
export function isLoop(name) {
  return typeof name === 'string' && Object.hasOwn(LOOPS, name);
}

/**
 * Schedules `seconds` of the music loop (from its first beat) into `destination`, starting at `when`,
 * at the level the live music bus plays it.
 */
export function renderMusicInto(c, destination, when = 0, seconds = MUSIC_LOOP_SECONDS, seed = 1) {
  const level = gainNode(c, MUSIC_LEVEL);
  level.connect(destination);
  scheduleMusicWindow(c, level, when, when, when + seconds, mulberry32(seed));
}
