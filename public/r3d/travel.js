// public/r3d/travel.js — the travel planner for life-size moves (city design §8.1; normative, pure: no three).
//
// A move of `length` metres along the token lane is planned as: a real-speed launch, a time-lapse cruise
// (the city clock speeds up so the character can cover hundreds of metres in ~1 s while still "driving at
// 14 m/s" relative to the traffic), and a real-speed arrival. Short hops skip the time-lapse.
// `t` everywhere is animation seconds since the move started; the Animator rate applies Fast / catch-up.

export const V_REAL = { car: 14, boot: 12, thimble: 10, ship: 9, hat: 6, dog: 7, cat: 8, wheelbarrow: 3.5, pawn: 3 };
export const TRAFFIC_SPEED = 14;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sm = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };
const N = 256;

/** Own: T = clamp(0.8 + d/400, 0.9, 1.8). Others (LOW): T = clamp(0.5 + d/800, 0.55, 0.9). speed: 1 | 1.8 … */
export function travelPlan({ length, tokenId = 'pawn', own = true, speed = 1 } = {}) {
  const d = Math.max(0, Number(length) || 0);
  const vReal0 = V_REAL[tokenId] ?? 3;
  const T0 = own ? clamp(0.8 + d / 400, 0.9, 1.8) : clamp(0.5 + d / 800, 0.55, 0.9);
  const L = Math.min(0.30, 0.2 * T0), A = Math.min(0.45, 0.28 * T0), K = Math.min(0.15, (T0 - L - A) / 2);
  const a = (t) => (t < L ? t / L : t < L + K ? 1 - sm((t - L) / K) : t < T0 - A - K ? 0 : t < T0 - A ? sm((t - (T0 - A - K)) / K) : 1 - (t - (T0 - A)) / A);
  const b = (t) => (t < L ? 0 : t < L + K ? sm((t - L) / K) : t < T0 - A - K ? 1 : t < T0 - A ? 1 - sm((t - (T0 - A - K)) / K) : 0);
  const dt = T0 / N; let IA = 0, IB = 0;
  for (let k = 0; k < N; k++) { const t = (k + 0.5) * dt; IA += a(t) * dt; IB += b(t) * dt; }
  let vReal = vReal0, vCruise = (d - vReal0 * IA) / IB, lapse = true;
  if (!(vCruise >= vReal0)) { lapse = false; vReal = d / (IA + IB); vCruise = vReal; } // short hop: no time-lapse
  const v0 = (t) => vReal * a(t) + vCruise * b(t);
  const S = new Float64Array(N + 1);
  for (let k = 0; k < N; k++) S[k + 1] = S[k] + v0((k + 0.5) * dt) * dt;
  const fix = d / (S[N] || 1), k1 = speed > 0 ? speed : 1, T = T0 / k1;
  const sAt = (t) => { const x = clamp((t * k1) / T0, 0, 1) * N, j = Math.min(N - 1, Math.floor(x)); return (S[j] + (S[j + 1] - S[j]) * (x - j)) * fix; };
  const vAt = (t) => v0(clamp(t * k1, 0, T0)) * fix * k1;
  const clockAt = (t) => (lapse ? clamp(vAt(t) / (TRAFFIC_SPEED * k1), 1, 40) : 1);
  const timeAt = (s) => { let lo = 0, hi = T; for (let j = 0; j < 30; j++) { const m = (lo + hi) / 2; if (sAt(m) < s) lo = m; else hi = m; } return hi; };
  return {
    length: d, T, launch: L / k1, arrive: A / k1, cruiseStart: (L + K) / k1, cruiseEnd: (T0 - A - K) / k1,
    vReal: vReal * fix * k1, vCruise: vCruise * fix * k1, lapse, clockPeak: lapse ? clamp(vCruise / TRAFFIC_SPEED, 1, 40) : 1,
    altitude: clamp((vCruise * fix) / 3, 25, 140), sAt, vAt, clockAt, timeAt,
  };
}
/** Camera tier for a walk of `length` m (§8.2). */
export const shotTier = (length) => (length <= 60 ? 'track' : length <= 400 ? 'swoop' : 'maphop');
