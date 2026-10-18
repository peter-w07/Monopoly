// public/r3d/city-clock.js — pure
//
// The city clock (design §8.3, normative): a second time line for ambient life (traffic, pedestrians,
// trains, boats, birds, clouds, water, flags) that can run faster than real time (the time-lapse while a
// character travels) or backwards (the "rewind" of a go-back card). `uCityTime` is the shared shader
// uniform: clock.time wrapped to [0, 3600) so it stays precise in highp floats; loops whose lap count per
// 3600 s is an integer stay continuous across the wrap.
//
//   const clock = createCityClock(bus);   // shares bus.uniforms.uCityTime when the bus has one
//   clock.step(dtReal)                     // first thing every frame (lane E)
//   clock.setTarget(rate, { snap, tau })   // lane C during moves; setTarget(1, { snap: true }) on settle
export function createCityClock(bus = null) {
  const uCityTime = bus?.uniforms?.uCityTime ?? { value: 0 };
  const clock = {
    time: 0, rate: 1, target: 1, tau: 0.08, uniforms: { uCityTime },
    /** Advances by real seconds × rate (rate eases toward target). Returns true while rate ≠ 1. */
    step(dtReal) {
      const dt = Math.min(0.1, Math.max(0, Number(dtReal) || 0));
      clock.rate += (clock.target - clock.rate) * (1 - Math.exp(-dt / clock.tau));
      if (Math.abs(clock.rate - clock.target) < 1e-3) clock.rate = clock.target;
      clock.time += dt * clock.rate;
      uCityTime.value = ((clock.time % 3600) + 3600) % 3600;
      return clock.rate !== 1 || clock.target !== 1;
    },
    /** rate in [−8, 60]; snap: jump now (skip / settle). */
    setTarget(rate, { snap = false, tau } = {}) {
      const r = Math.min(60, Math.max(-8, Number.isFinite(rate) ? rate : 1));
      clock.target = r; if (tau > 0) clock.tau = tau; if (snap) clock.rate = r;
    },
    reset() { clock.time = 0; clock.rate = clock.target = 1; uCityTime.value = 0; },
  };
  return clock;
}
