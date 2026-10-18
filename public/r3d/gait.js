// public/r3d/gait.js — pure locomotion maths for the life-size characters (no three.js, no DOM).
//
//   gait phase      advances by DISTANCE / STRIDE, so a planted foot never slides; stride follows the
//                   speed (Alexander: λ/h = 2.3·Fr^0.3), the gait (walk / trot / gallop / bound / jog) is
//                   picked by the Froude number v²/(g·h) and two gaits cross-fade over 0.2 s on ONE shared
//                   phase (continuous). During the time-lapse the visual cadence is capped at 2.5× the
//                   cadence at the character's real speed.
//   foot targets    body-space (forward, lift) per leg: stance sweeps backward exactly one stride·duty per
//                   stance, swing arcs forward. Plant events = a leg entering stance.
//   ik2             planar two-bone IK (legs to feet / pedals, arms to barrow handles).
//   springs         2nd-order spring-dampers (vehicle pitch / roll / heave, tails, ears).
//   wheels          angle by distance (ω = v/r), revolution events, blur flag above 6 rev/s.
//   steer           bicycle model: front-wheel angle = atan(wheelbase · κ).
//
// Every state object is allocated once; the step functions never allocate.

export const G = 9.81;
export const BLEND = 0.2; // s to cross-fade between two gaits
export const CADENCE_CAP = 2.5; // × the real-speed cadence, during the time-lapse
export const BLUR_REVS = 6; // rev/s above which a wheel shows its blur disc
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };

/** Froude number v²/(g·h) for hip height h (m). */
export const froude = (v, hip) => (v * v) / (G * Math.max(0.05, hip));

/** One full gait cycle (two steps) in metres at speed v for hip height `hip` (λ = 2.3·h·Fr^0.3). */
export function strideFor(v, hip, scale = 1) {
  const h = Math.max(0.05, hip);
  return 2.3 * h * Math.max(0.02, froude(Math.abs(v), h)) ** 0.3 * scale;
}

// ---- gait tables ---------------------------------------------------------------------------------
// upTo: highest Froude number for this gait. duty: stance fraction. offsets: per-leg phase offsets.
// lift / bob: fractions of the hip height. rock: body pitch amplitude (rad). flex: spine flexion (rad).
// Legs: biped [L, R]; quadrupeds [FL, FR, HL, HR].
export const GAITS = Object.freeze({
  biped: [
    { name: 'walk', upTo: 0.45, duty: 0.62, offsets: [0, 0.5], lift: 0.16, bob: 0.025, lean: 0.03, rock: 0, flex: 0 },
    { name: 'jog', upTo: Infinity, duty: 0.4, offsets: [0, 0.5], lift: 0.3, bob: 0.045, lean: 0.12, rock: 0, flex: 0 },
  ],
  quad: [
    { name: 'walk', upTo: 0.4, duty: 0.66, offsets: [0.25, 0.75, 0, 0.5], lift: 0.18, bob: 0.012, lean: 0, rock: 0.02, flex: 0 },
    { name: 'trot', upTo: 2.2, duty: 0.42, offsets: [0, 0.5, 0.5, 0], lift: 0.26, bob: 0.03, lean: 0, rock: 0.02, flex: 0 },
    { name: 'gallop', upTo: Infinity, duty: 0.3, offsets: [0.6, 0.5, 0, 0.1], lift: 0.3, bob: 0.05, lean: 0, rock: 0.1, flex: 0.12 },
  ],
  cat: [
    { name: 'walk', upTo: 0.4, duty: 0.66, offsets: [0.25, 0.75, 0, 0.5], lift: 0.2, bob: 0.01, lean: 0, rock: 0.02, flex: 0 },
    { name: 'trot', upTo: 2.0, duty: 0.42, offsets: [0, 0.5, 0.5, 0], lift: 0.26, bob: 0.03, lean: 0, rock: 0.02, flex: 0 },
    { name: 'bound', upTo: Infinity, duty: 0.3, offsets: [0.5, 0.56, 0, 0.04], lift: 0.32, bob: 0.06, lean: 0, rock: 0.14, flex: 0.28 },
  ],
});

/**
 * A gait state. type: 'biped' | 'quad' | 'cat'; hip: hip height in metres (world scale, used for
 * stride and Froude); strideScale tweaks the stride (e.g. 0.9 for a burdened gardener).
 */
export function createGait(type = 'biped', { hip = 0.9, strideScale = 1 } = {}) {
  const table = GAITS[type] ?? GAITS.biped;
  const legs = table[0].offsets.length;
  return {
    type: GAITS[type] ? type : 'biped', table, hip: Math.max(0.05, hip), strideScale, legs,
    cycles: 0, // unwrapped phase (cycles travelled)
    phase: 0, // cycles mod 1
    gait: 0, from: 0, blend: 1, // current gait index, the one it blends from, blend progress 0..1
    speed: 0, stride: strideFor(0, hip, strideScale), amp: 0,
    feet: new Float64Array(legs * 2), // per leg: forward offset (m, body space), lift (m)
    bob: 0, rock: 0, flex: 0, lean: 0, plants: 0,
  };
}

/** Puts a gait back at rest (feet under the hips). */
export function resetGait(g) {
  g.speed = 0; g.amp = 0; g.blend = 1; g.from = g.gait = 0; g.plants = 0;
  g.feet.fill(0); g.bob = g.rock = g.flex = g.lean = 0;
  g.stride = strideFor(0, g.hip, g.strideScale);
}

function footInto(gt, u, sweep, lift, out, k) {
  const duty = gt.duty;
  if (u < duty) {
    out[k] = sweep * (0.5 - u / duty);
    out[k + 1] = 0;
  } else {
    const s = (u - duty) / (1 - duty);
    out[k] = sweep * (smooth(s) - 0.5);
    out[k + 1] = lift * Math.sin(Math.PI * s);
  }
}
const SCRATCH_A = new Float64Array(8);
const SCRATCH_B = new Float64Array(8);

/**
 * Advances a gait by `ds` metres (sign ignored: walkers always step forward) over `dt` seconds.
 * opts: vReal — the character's real top speed (m/s); lapse — cap the visual cadence at
 * CADENCE_CAP × the real-speed cadence (the time-lapse). Returns a bitmask of legs that planted.
 */
export function stepGait(g, ds, dt, { vReal = Infinity, lapse = false } = {}) {
  const d = Math.abs(Number(ds) || 0);
  const v = dt > 1e-6 ? d / dt : g.speed;
  const vVis = lapse && Number.isFinite(vReal) ? Math.min(v, vReal) : v;
  // Gait selection by Froude number, with ±8 % hysteresis.
  const T = g.table;
  const fr = froude(vVis, g.hip);
  let want = g.gait;
  while (want < T.length - 1 && fr > T[want].upTo * 1.08) want++;
  while (want > 0 && fr < T[want - 1].upTo * 0.92) want--;
  if (want !== g.gait) {
    g.from = g.blend >= 0.5 ? g.gait : g.from; // the dominant one keeps the pose continuous
    g.gait = want;
    g.blend = 0;
  }
  g.blend = Math.min(1, g.blend + (dt > 0 ? dt / BLEND : 1));
  const stride = strideFor(vVis, g.hip, g.strideScale);
  let dPhase = d / stride;
  if (lapse && Number.isFinite(vReal) && vReal > 0 && dt > 0) {
    const cap = (CADENCE_CAP * vReal) / strideFor(vReal, g.hip, g.strideScale);
    dPhase = Math.min(dPhase, cap * dt);
  }
  // Plant events: a leg (of the target gait) whose phase crosses 0 enters stance.
  const cur = T[g.gait];
  let plants = 0;
  const c0 = g.cycles;
  const c1 = c0 + dPhase;
  for (let i = 0; i < g.legs; i++) if (Math.floor(c0 + cur.offsets[i]) !== Math.floor(c1 + cur.offsets[i])) plants |= 1 << i;
  g.cycles = c1;
  g.phase = c1 - Math.floor(c1);
  g.stride = stride;
  g.speed = v;
  // Amplitude: feet converge under the hips as the character stops (only below 0.4 m/s).
  g.amp = clamp(vVis / 0.4, 0, 1);
  poseGait(g);
  g.plants = plants;
  return plants;
}

/** Recomputes feet / bob / rock / flex / lean from the current phase, gait blend and stride. */
export function poseGait(g) {
  const T = g.table;
  const w = smooth(g.blend);
  const A = T[g.from];
  const B = T[g.gait];
  const amp = g.amp;
  const sweepA = g.stride * A.duty * amp, sweepB = g.stride * B.duty * amp;
  const liftA = A.lift * g.hip * amp, liftB = B.lift * g.hip * amp;
  for (let i = 0; i < g.legs; i++) {
    const uA = g.phase + A.offsets[i] - Math.floor(g.phase + A.offsets[i]);
    const uB = g.phase + B.offsets[i] - Math.floor(g.phase + B.offsets[i]);
    footInto(A, uA, sweepA, liftA, SCRATCH_A, i * 2);
    footInto(B, uB, sweepB, liftB, SCRATCH_B, i * 2);
    g.feet[i * 2] = SCRATCH_A[i * 2] + (SCRATCH_B[i * 2] - SCRATCH_A[i * 2]) * w;
    g.feet[i * 2 + 1] = SCRATCH_A[i * 2 + 1] + (SCRATCH_B[i * 2 + 1] - SCRATCH_A[i * 2 + 1]) * w;
  }
  const ph = g.phase * TAU;
  const mix = (a, b) => a + (b - a) * w;
  g.bob = mix(A.bob, B.bob) * g.hip * amp * Math.cos(2 * ph);
  g.rock = mix(A.rock, B.rock) * amp * Math.sin(ph);
  g.flex = mix(A.flex, B.flex) * amp * Math.sin(ph);
  g.lean = mix(A.lean, B.lean) * amp;
  return g;
}

/** Name of the gait being shown ('walk', 'trot', …). */
export const gaitName = (g) => g.table[g.gait].name;

/** Is leg i (of the current gait) in stance at the current phase? */
export function inStance(g, i) {
  const gt = g.table[g.gait];
  const u = g.phase + gt.offsets[i] - Math.floor(g.phase + gt.offsets[i]);
  return u < gt.duty;
}

// ---- two-bone IK ---------------------------------------------------------------------------------

/**
 * Planar two-bone IK. Root at the origin, target (x forward, y up), bone lengths l1, l2.
 * bend +1 puts the middle joint forward (a knee), −1 backward (an elbow / a hock).
 * out.a: upper bone angle from straight down (forward positive); out.b: the lower bone's angle
 * relative to the upper one; out.reach: the clamped distance. Unreachable targets stretch toward them.
 */
export function ik2(x, y, l1, l2, bend, out) {
  const d0 = Math.hypot(x, y);
  const d = clamp(d0, Math.abs(l1 - l2) + 1e-4, (l1 + l2) * 0.9995);
  const base = Math.atan2(x, -y);
  const A = Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
  const K = Math.acos(clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1));
  const s = bend >= 0 ? 1 : -1;
  out.a = base + s * A;
  out.b = -s * (Math.PI - K);
  out.reach = d;
  return out;
}

// ---- springs ---------------------------------------------------------------------------------------

/** A 2nd-order spring-damper (frequency Hz, damping ratio ζ). */
export function createSpring(freq = 1.3, zeta = 0.45, x = 0) {
  return { x, v: 0, w: TAU * freq, z: zeta };
}

/** Advances a spring toward `target` over dt seconds (sub-stepped, stable). Returns x. */
export function stepSpring(s, target, dt) {
  const t = clamp(Number(dt) || 0, 0, 0.1);
  const n = Math.max(1, Math.ceil(t / 0.008));
  const h = t / n;
  for (let k = 0; k < n; k++) {
    const a = -s.w * s.w * (s.x - target) - 2 * s.z * s.w * s.v;
    s.v += a * h;
    s.x += s.v * h;
  }
  return s.x;
}

/** Sets a spring at rest at x. */
export function restSpring(s, x = 0) {
  s.x = x;
  s.v = 0;
  return s;
}

// ---- vehicles --------------------------------------------------------------------------------------

/** Body pitch target (rotation.x of a +Z-facing model) for a longitudinal acceleration (m/s²). */
export const pitchFor = (accel, k = 0.012, max = 0.09) => clamp(-k * accel, -max, max);
/** Body roll target (rotation.z) in a turn: 0.02·v²·κ (outward), clamped. */
export const rollFor = (v, kappa, k = 0.02, max = 0.07) => clamp(k * v * v * kappa, -max, max);
/** Rider lean into a curve (rotation.z; a bicycle leans inward): −atan(v²κ/g), clamped. */
export const leanFor = (v, kappa, max = 0.35) => clamp(-Math.atan((v * v * kappa) / G), -max, max);
/** Bicycle model: front-wheel steer angle for path curvature κ (1/m) and wheelbase (m). */
export const steer = (wheelbase, kappa, max = 0.6) => clamp(Math.atan(wheelbase * kappa), -max, max);

/** A wheel of radius r (m). */
export function createWheel(r = 0.33) {
  return { r: Math.max(0.02, r), angle: 0, rate: 0, blur: false };
}

/**
 * Turns a wheel by `ds` metres (signed) over dt seconds; ω = v/r. During the time-lapse the visual
 * spin is capped at CADENCE_CAP × the spin at vReal (the blur disc covers the rest).
 * Returns the number of whole revolutions completed (wheel-turn events).
 */
export function stepWheel(w, ds, dt, { vReal = Infinity, lapse = false } = {}) {
  let da = (Number(ds) || 0) / w.r;
  if (dt > 1e-6) w.rate = Math.abs(da) / dt / TAU;
  if (lapse && Number.isFinite(vReal) && dt > 0) {
    const cap = (CADENCE_CAP * vReal * dt) / w.r;
    da = clamp(da, -cap, cap);
  }
  const before = Math.floor(w.angle / TAU);
  w.angle += da;
  if (Math.abs(w.angle) > 1e6) w.angle %= TAU; // keep precision on very long sessions
  w.blur = w.rate > BLUR_REVS;
  return Math.abs(Math.floor(w.angle / TAU) - before);
}

/** Stops a wheel (keeps its angle). */
export function stopWheel(w) {
  w.rate = 0;
  w.blur = false;
  return w;
}
