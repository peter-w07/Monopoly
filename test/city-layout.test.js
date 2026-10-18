// public/r3d/city-layout.js — Loop City's ground plan (city design §3–§4). Pure module: these tests
// pin the geometry every lane builds against (addresses, the token lane, walks, parking slots,
// lot lookup, the parallel rings, the occlusion rule and the surface map).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as L from '../public/r3d/city-layout.js';

const {
  TILE_COUNT, M, STRAIGHT, ARC, HALF_ARC, QUARTER, LOOP, SEAT_YAW, SIDES, RINGS, JAIL_YARD, DOUBLE_LAT, WALK_LAT,
  GROUP_TILES, ZONES, wrap, qOf, isCorner, sideOf, rowOf, alongOf, sOf, pointAt, address, pathFor, restSlots,
  lotAt, lotRect, ringPath, laneClear, surfaceAt, angleDelta,
} = L;

const BOARD = JSON.parse(readFileSync(new URL('../engine/data/board.json', import.meta.url), 'utf8'));
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('exports exactly the §17.3 API', () => {
  const want = ['TILE_COUNT', 'M', 'STRAIGHT', 'ARC', 'HALF_ARC', 'QUARTER', 'LOOP', 'SEAT_YAW', 'SIDES', 'RINGS', 'JAIL_YARD',
    'DOUBLE_LAT', 'WALK_LAT', 'GROUP_TILES', 'ZONES', 'wrap', 'qOf', 'isCorner', 'sideOf', 'rowOf', 'alongOf', 'sOf', 'pointAt',
    'address', 'pathFor', 'restSlots', 'lotAt', 'lotRect', 'ringPath', 'laneClear', 'surfaceAt', 'angleDelta'];
  assert.deepEqual(Object.keys(L).sort(), want.slice().sort());
  assert.ok(Object.isFrozen(M) && Object.isFrozen(RINGS) && Object.isFrozen(JAIL_YARD) && Object.isFrozen(GROUP_TILES) && Object.isFrozen(ZONES));
});

test('lap and segment lengths', () => {
  assert.equal(TILE_COUNT, 40);
  assert.ok(near(STRAIGHT, 246.5));
  assert.ok(near(ARC, 14.137, 1e-3));
  assert.ok(near(HALF_ARC, 7.069, 1e-3));
  assert.ok(near(QUARTER, 260.637, 1e-3));
  assert.ok(near(LOOP, 1042.549, 1e-3));
  assert.equal(SEAT_YAW, -Math.PI / 4);
  assert.deepEqual(SIDES, ['south', 'west', 'north', 'east']);
  assert.ok(near(DOUBLE_LAT, -3.375));
  assert.ok(near(WALK_LAT, 4.25));
});

test('wrap / qOf / sides / rows', () => {
  assert.equal(wrap(-1), 39);
  assert.equal(wrap(40), 0);
  assert.equal(wrap(83), 3);
  assert.equal(wrap('x'), 0);
  assert.equal(wrap(12.7), 12);
  assert.equal(qOf(9), 0);
  assert.equal(qOf(10), 1);
  assert.equal(qOf(39), 3);
  assert.ok(isCorner(0) && isCorner(10) && isCorner(20) && isCorner(30) && !isCorner(5));
  assert.equal(sideOf(10), 'corner');
  assert.equal(sideOf(11), 'west');
  assert.equal(rowOf(10), 'west');
  assert.equal(rowOf(0), 'south');
  assert.equal(alongOf(1), 104);
  assert.equal(alongOf(9), -104);
});

test('40 distinct addresses with strictly increasing s, matching the §3.3 table', () => {
  const seen = new Set();
  let prev = -Infinity;
  for (let i = 0; i < 40; i++) {
    const a = address(i);
    assert.equal(a.i, i);
    assert.ok(a.s > prev, `s(${i}) increases`);
    prev = a.s;
    assert.ok(near(a.s, sOf(i)));
    const key = `${a.x.toFixed(2)},${a.z.toFixed(2)}`;
    assert.ok(!seen.has(key), `address ${i} is distinct`);
    seen.add(key);
    // The lane point is on the token-lane centre line.
    const p = pointAt(a.s);
    assert.ok(near(p.x, a.x) && near(p.z, a.z));
    // Unit out / along vectors, perpendicular.
    assert.ok(near(Math.hypot(a.out.x, a.out.z), 1, 1e-9));
    assert.ok(near(Math.hypot(a.along.x, a.along.z), 1, 1e-9));
    assert.ok(near(a.out.x * a.along.x + a.out.z * a.along.z, 0, 1e-9));
  }
  assert.ok(prev < LOOP);
  // Spot checks against the table.
  const table = {
    0: [129.6, 129.6, 156, 156], 1: [104, 132.25, 104, 156], 5: [0, 132.25, 0, 156], 9: [-104, 132.25, -104, 156],
    10: [-129.6, 129.6, -156, 156], 11: [-132.25, 104, -156, 104], 15: [-132.25, 0, -156, 0], 19: [-132.25, -104, -156, -104],
    20: [-129.6, -129.6, -156, -156], 21: [-104, -132.25, -104, -156], 25: [0, -132.25, 0, -156], 29: [104, -132.25, 104, -156],
    30: [129.6, -129.6, 156, -156], 31: [132.25, -104, 156, -104], 35: [132.25, 0, 156, 0], 39: [132.25, 104, 156, 104],
  };
  for (const [i, [x, z, cx, cz]] of Object.entries(table)) {
    const a = address(Number(i));
    assert.ok(near(a.x, x, 0.06) && near(a.z, z, 0.06), `lane point of ${i}: ${a.x}, ${a.z}`);
    assert.ok(near(a.lot.cx, cx) && near(a.lot.cz, cz), `lot centre of ${i}`);
  }
  const sTable = { 0: 0, 1: 26.3, 10: 260.6, 13: 339.0, 20: 521.3, 30: 781.9, 39: 1016.2 };
  for (const [i, s] of Object.entries(sTable)) assert.ok(near(sOf(Number(i)), s, 0.06), `s(${i})`);
  // Faces toward the street: lots on the south row look north (−z), the west row east (+x), …
  assert.deepEqual(address(3).out, { x: 0, z: 1 });
  assert.deepEqual(address(13).out, { x: -1, z: 0 });
  assert.deepEqual(address(23).out, { x: 0, z: -1 });
  assert.deepEqual(address(33).out, { x: 1, z: 0 });
  // Travel direction: clockwise from above.
  assert.ok(near(address(3).heading, Math.atan2(-1, 0)));
  assert.ok(near(Math.abs(address(13).heading), Math.PI));
  assert.ok(near(address(23).heading, Math.PI / 2));
  assert.ok(near(address(33).heading, 0));
  // Lot fronts sit on the property line (139 from the centre).
  for (let i = 0; i < 40; i++) {
    const { lot } = address(i);
    assert.ok(near(Math.max(Math.abs(lot.front.x), Math.abs(lot.front.z)), M.PROP), `front of ${i}`);
  }
});

test('edge steps are 26.000 m, corner steps 26.319 m', () => {
  for (let i = 0; i < 40; i++) {
    const d = (i === 39 ? LOOP : sOf(i + 1)) - sOf(i);
    const corner = isCorner(i) || isCorner(i + 1);
    if (corner) assert.ok(near(d, 26.319, 1e-3), `step ${i} → ${i + 1}: ${d}`);
    else assert.ok(near(d, 26, 1e-9), `step ${i} → ${i + 1}: ${d}`);
  }
});

test('pointAt is continuous (|Δp| ≈ Δs) around the whole lap, laterals included', () => {
  const ds = 0.05;
  for (const lateral of [0, -3.375, 4.25]) {
    const a = {};
    const b = {};
    pointAt(0, lateral, a);
    const n = Math.ceil(LOOP / ds) + 2;
    for (let k = 1; k <= n; k++) {
      pointAt(k * ds, lateral, b);
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      // Arcs scale with the radius (9 + lateral) / 9; straights keep ds.
      const max = ds * Math.max(1, (M.ARC_R + lateral) / M.ARC_R) + 1e-9;
      const min = ds * Math.min(1, (M.ARC_R + lateral) / M.ARC_R) * 0.999 - 1e-9;
      assert.ok(d <= max && d >= min, `|Δp| ${d} at s ${k * ds} (lateral ${lateral})`);
      // The heading follows the motion.
      const h = Math.atan2(b.x - a.x, b.z - a.z);
      assert.ok(Math.abs(angleDelta(h, b.heading)) < 0.02, `heading at s ${k * ds}`);
      a.x = b.x; a.z = b.z; a.heading = b.heading;
    }
  }
  // Wraps both ways, out param is reused.
  const o = {};
  assert.equal(pointAt(LOOP + 10, 0, o), o);
  const q = pointAt(10);
  assert.ok(near(o.x, q.x) && near(o.z, q.z));
  const r = pointAt(-10);
  const t = pointAt(LOOP - 10);
  assert.ok(near(r.x, t.x) && near(r.z, t.z));
  // Lateral + is outward (toward the lots).
  const lane = pointAt(sOf(5));
  const out = pointAt(sOf(5), 4);
  assert.ok(near(out.z - lane.z, 4));
});

test('pathFor: walks, GO crossings and tile order', () => {
  const a = pathFor(39, 3);
  assert.equal(a.from, 39);
  assert.equal(a.to, 2);
  assert.equal(a.dir, 1);
  assert.equal(a.goS, LOOP);
  assert.ok(a.goAt > 0 && a.goAt < 1);
  assert.ok(near(a.s0 + a.goAt * a.length, LOOP));
  assert.ok(near(a.s1, LOOP + sOf(2)));
  assert.deepEqual(a.tiles.map((t) => t.index), [0, 1, 2]);

  const b = pathFor(3, -3);
  assert.equal(b.to, 0);
  assert.equal(b.dir, -1);
  assert.equal(b.goS, null);
  assert.equal(b.goAt, null);
  assert.ok(near(b.s1, 0));
  assert.deepEqual(b.tiles.map((t) => t.index), [2, 1, 0]);

  const c = pathFor(0, 7);
  assert.equal(c.goS, null);
  assert.equal(c.to, 7);
  assert.ok(near(c.length, sOf(7)));

  // Landing exactly on GO counts as passing it.
  const d = pathFor(35, 5);
  assert.equal(d.to, 0);
  assert.equal(d.goS, LOOP);
  assert.ok(near(d.goAt, 1));

  // A zero walk and a full lap.
  const z = pathFor(12, 0);
  assert.equal(z.length, 0);
  assert.equal(z.tiles.length, 0);
  const lap = pathFor(12, 40);
  assert.ok(near(lap.length, LOOP));
  assert.equal(lap.tiles.length, 40);
  assert.equal(lap.goS, LOOP);

  // Tiles are ordered along the path for every start and roll, both directions.
  for (let from = 0; from < 40; from++) {
    for (const steps of [2, 3, 7, 12, -3, -1]) {
      const p = pathFor(from, steps);
      assert.equal(p.tiles.length, Math.abs(steps));
      let prevAt = 0;
      for (const t of p.tiles) {
        assert.ok(t.at > prevAt - 1e-12 && t.at <= 1 + 1e-12, `at increases (${from} ${steps})`);
        prevAt = t.at;
        assert.ok(near(t.s, p.s0 + p.dir * t.at * p.length, 1e-6));
      }
      assert.equal(p.tiles.at(-1).index, wrap(from + steps));
      assert.ok(near(p.tiles.at(-1).at, 1));
      assert.ok(near(p.s1, p.s0 + p.dir * p.length));
      const passes = steps > 0 && from !== 0 && from + steps >= 40;
      assert.equal(p.goS !== null, passes, `GO crossing ${from} + ${steps}`);
    }
  }
});

test('lotAt finds every lot from its centre and from its lane point', () => {
  for (let i = 0; i < 40; i++) {
    const a = address(i);
    assert.equal(lotAt(a.lot.cx, a.lot.cz), i, `lot centre of ${i}`);
    assert.equal(lotAt(a.x, a.z), i, `lane point of ${i}`);
    // The kerb post and the forecourt belong to the lot too.
    const post = pointAt(a.s, M.POST - M.LANE);
    assert.equal(lotAt(post.x, post.z), i, `address post of ${i}`);
  }
  assert.equal(lotAt(0, 0), null); // the park
  assert.equal(lotAt(0, 126), null); // traffic lanes
  assert.equal(lotAt(0, 190), null); // behind the service lane
  assert.equal(lotAt(400, 0), null); // the sea
});

test('lotRect: 26 × 34 edge lots, 34 × 34 corner blocks, containing their centres', () => {
  for (let i = 0; i < 40; i++) {
    const r = lotRect(i);
    const w = r.maxX - r.minX;
    const d = r.maxZ - r.minZ;
    if (isCorner(i)) assert.ok(near(w * d, 34 * 34), `corner block ${i}`);
    else {
      assert.ok(near(w * d, 26 * 34), `edge lot ${i}: ${w} × ${d}`);
      const q = qOf(i);
      // Frontage along the street, depth away from it.
      if (q === 0 || q === 2) assert.ok(near(w, 26) && near(d, 34));
      else assert.ok(near(w, 34) && near(d, 26));
    }
    const { lot } = address(i);
    assert.ok(lot.cx > r.minX && lot.cx < r.maxX && lot.cz > r.minZ && lot.cz < r.maxZ);
    assert.ok(near(Math.max(Math.abs(r.minX), Math.abs(r.maxX), Math.abs(r.minZ), Math.abs(r.maxZ)), M.LOT_BACK), `back of ${i}`);
  }
  // Neighbouring lots of a side share an edge (no gaps, no overlaps).
  for (let i = 1; i < 9; i++) assert.ok(near(lotRect(i).minX, lotRect(i + 1).maxX));
});

// ---- parking slots ------------------------------------------------------------------------------

// §7.1 sizes (length × width) and kinds.
const TOKENS = [
  { id: 'car', kind: 'vehicle', length: 4.1, width: 1.7 },
  { id: 'dog', kind: 'walker', length: 0.9, width: 0.35 },
  { id: 'hat', kind: 'vehicle', length: 1.8, width: 0.6 },
  { id: 'ship', kind: 'vehicle', length: 9.45, width: 2.44 },
  { id: 'boot', kind: 'vehicle', length: 4.6, width: 1.8 },
  { id: 'cat', kind: 'walker', length: 0.85, width: 0.3 },
  { id: 'thimble', kind: 'vehicle', length: 2.3, width: 1.4 },
  { id: 'wheelbarrow', kind: 'walker', length: 2.4, width: 0.8 },
];
const SIZE = Object.fromEntries(TOKENS.map((t) => [t.id, t]));

/** Separating-axis test of two oriented rectangles (heading convention: forward = (sin h, cos h)). */
function overlap(a, b, gap = 0) {
  const rect = (p) => {
    const t = SIZE[p.id];
    const f = { x: Math.sin(p.heading), z: Math.cos(p.heading) };
    const s = { x: f.z, z: -f.x };
    return { c: p, axes: [f, s], half: [t.length / 2 + gap / 2, t.width / 2 + gap / 2] };
  };
  const A = rect(a);
  const B = rect(b);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  for (const ax of [...A.axes, ...B.axes]) {
    const proj = (R) => R.axes.reduce((sum, u, k) => sum + Math.abs(u.x * ax.x + u.z * ax.z) * R.half[k], 0);
    if (Math.abs(dx * ax.x + dz * ax.z) > proj(A) + proj(B)) return false;
  }
  return true;
}

test('restSlots never drops anyone and never overlaps (all 255 subsets × tiles 0, 1, 10, 10 jailed, 20, 39)', () => {
  const cases = [[0, false], [1, false], [10, false], [10, true], [20, false], [39, false]];
  let checked = 0;
  for (let mask = 1; mask < 256; mask++) {
    const members = TOKENS.filter((_, k) => mask & (1 << k)).map(({ id, kind, length }) => ({ id, kind, length }));
    for (const [tile, jailed] of cases) {
      const slots = restSlots(tile, members, { jailed });
      assert.equal(slots.length, members.length, `tile ${tile} mask ${mask}: everyone placed`);
      assert.deepEqual(slots.map((s) => s.id).sort(), members.map((m) => m.id).sort());
      for (const s of slots) {
        assert.ok(Number.isFinite(s.x) && Number.isFinite(s.z) && Number.isFinite(s.heading));
        const m = SIZE[s.id];
        if (jailed) {
          assert.equal(s.place, 'yard');
          assert.ok(s.x - m.length / 2 >= JAIL_YARD.minX && s.x + m.length / 2 <= JAIL_YARD.maxX, `${s.id} inside the yard`);
          assert.ok(JAIL_YARD.rows.includes(s.z));
        } else {
          assert.ok(['lane', 'double', 'sidewalk'].includes(s.place));
          assert.equal(s.place === 'sidewalk', m.kind === 'walker', `${s.id} in its place`);
        }
      }
      for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
          assert.ok(!overlap(slots[i], slots[j]), `tile ${tile}${jailed ? ' (jailed)' : ''}: ${slots[i].id} / ${slots[j].id} overlap`);
          // Same place: at least the 0.8 m walker gap between bodies along the line.
          if (slots[i].place === slots[j].place) {
            const d = Math.hypot(slots[i].x - slots[j].x, slots[i].z - slots[j].z);
            assert.ok(d >= (SIZE[slots[i].id].length + SIZE[slots[j].id].length) / 2 + 0.79 - 0.25, `gap ${slots[i].id}/${slots[j].id} at ${tile}`);
          }
        }
      }
      checked++;
    }
  }
  assert.equal(checked, 255 * cases.length);
});

test('restSlots: order, places and bad input', () => {
  const s = restSlots(5, [{ id: 'a', kind: 'vehicle', length: 4 }, { id: 'b', kind: 'vehicle', length: 4 }]);
  // The first member is frontmost (ahead in the travel direction, −x on the south avenue).
  assert.ok(s[0].x < s[1].x);
  assert.ok(s.every((x) => x.place === 'lane'));
  // Too many vehicles for the 24 m block double-park in the outer traffic lane.
  const many = restSlots(5, Array.from({ length: 6 }, (_, k) => ({ id: k, kind: 'vehicle', length: 6 })));
  assert.ok(many.some((x) => x.place === 'double'));
  assert.equal(many.length, 6);
  assert.deepEqual(restSlots(3, null), []);
  assert.deepEqual(restSlots(3, [null, { kind: 'walker' }]), []);
  assert.equal(restSlots(3, [{ id: 'x', length: 'bad' }]).length, 1);
  // Not jailed at tile 10 = Just Visiting at the kerb.
  assert.equal(restSlots(10, [{ id: 'v', kind: 'vehicle', length: 4 }])[0].place, 'lane');
  assert.equal(restSlots(10, [{ id: 'v', kind: 'vehicle', length: 4 }], { jailed: true })[0].place, 'yard');
});

// ---- rings, occlusion rule, surfaces, zones -----------------------------------------------------

test('ringPath: every RINGS entry is a closed loop sampled at ≤ step', () => {
  for (const [name, ring] of Object.entries(RINGS)) {
    for (const step of [2, 5]) {
      const r = ringPath(ring.h, { c: ring.c, step });
      assert.ok(r.points.length >= 16);
      assert.ok(near(r.r, ring.h - ring.c));
      let max = 0;
      for (let k = 0; k < r.points.length; k++) {
        const a = r.points[k];
        const b = r.points[(k + 1) % r.points.length]; // the last point joins the first: closed
        max = Math.max(max, Math.hypot(b.x - a.x, b.z - a.z));
        assert.ok(near(Math.max(Math.abs(a.x), Math.abs(a.z)), ring.h, 1e-6) || Math.hypot(Math.abs(a.x) - ring.c, Math.abs(a.z) - ring.c) <= r.r + 1e-6, `${name} point ${k} on the ring`);
      }
      // n = round(length / step) samples, evenly spaced in arc length: every chord ≤ length / n,
      // which is the step up to the rounding of n (≤ step · (1 + 1 / 2n), i.e. < 0.1 % over).
      const n = r.points.length;
      assert.ok(max <= r.length / n + 1e-9, `${name}: segment ${max} > spacing ${r.length / n}`);
      assert.ok(r.length / n <= step * (1 + 0.5 / n) + 1e-9, `${name}: spacing ${r.length / n} vs step ${step}`);
      // Starts at the SE apex.
      const p0 = r.points[0];
      assert.ok(p0.x > 0 && p0.z > 0 && near(p0.x, p0.z, 1e-9));
    }
  }
  // The token-lane ring matches the lane itself.
  const lane = ringPath(RINGS.lane.h, { c: RINGS.lane.c, step: 1 });
  assert.ok(near(lane.length, LOOP, 1e-9));
  // Rail rings clear the corner sites (apex 183.3 / 186.1 from the centre along the diagonal axis).
  for (const name of ['railA', 'railB']) {
    const r = ringPath(RINGS[name].h, { c: RINGS[name].c });
    const apex = r.points[0].x;
    assert.ok(apex > M.LOT_BACK, `${name} apex ${apex}`);
  }
});

test('laneClear: the §3.10 occlusion rule examples', () => {
  // Units on the unit band (front face 147) on a south lot: ≤ 24 m.
  assert.equal(laneClear(6, 147, 24), true);
  assert.equal(laneClear(6, 147, 24.5), false);
  assert.equal(laneClear(1, 147, 7.5), true);
  // A 34 m hotel needs front face ≥ 152, a 40 m one ≥ 155 (west lots).
  assert.equal(laneClear(16, 152, 34), true);
  assert.equal(laneClear(16, 151, 34), false);
  assert.equal(laneClear(19, 155, 40), true);
  assert.equal(laneClear(19, 154, 40), false);
  assert.equal(laneClear(13, 160, 41), false); // west cap 40
  assert.equal(laneClear(6, 170, 26), false); // south cap 24
  // North / east lots project away from their street: only the caps apply.
  assert.equal(laneClear(21, 139, 110), true);
  assert.equal(laneClear(21, 139, 111), false);
  assert.equal(laneClear(39, 139, 195), true);
  assert.equal(laneClear(39, 139, 201), false);
  // The Jail corner obeys the rule; the other corners have no rule and no cap.
  assert.equal(laneClear(10, 147, 24), true);
  assert.equal(laneClear(10, 140, 24), false);
  assert.equal(laneClear(0, 139, 31), true);
  assert.equal(laneClear(20, 139, 45), true);
  assert.equal(laneClear(30, 139, 300), true);
  // Indices wrap.
  assert.equal(laneClear(46, 147, 24), true);
});

test('surfaceAt: the footstep / tyre surface map', () => {
  const cases = [
    [0, 0, 'grass'], [-50, 50, 'paving'], [60, -60, 'grass'],
    [0, 119.5, 'paving'], [-119.5, 0, 'paving'],
    [0, 123, 'asphalt'], [0, 127, 'asphalt'], [0, 132.25, 'asphalt'], [129.6, 129.6, 'asphalt'],
    [-26, 136.5, 'cobble'], [-104, 136.5, 'cobble'], [26, 136.5, 'paving'], [-136.5, 26, 'cobble'], [-136.5, -26, 'paving'],
    [136.5, 0, 'paving'], [0, -136.5, 'paving'],
    [0, 156, 'paving'], [-156, 0, 'paving'],
    [0, 177, 'asphalt'], [0, 197, 'gravel'], [-197, 0, 'gravel'],
    [210, 0, 'wood'], [220, 0, 'sand'], [0, 300, 'asphalt'], [-400, 0, 'asphalt'],
  ];
  const names = new Set(['asphalt', 'paving', 'cobble', 'grass', 'wood', 'sand', 'gravel']);
  for (const [x, z, want] of cases) assert.equal(surfaceAt(x, z), want, `surface at (${x}, ${z})`);
  for (let x = -600; x <= 600; x += 37) for (let z = -600; z <= 600; z += 41) assert.ok(names.has(surfaceAt(x, z)));
});

test('groups, zones and constants agree with the board data', () => {
  const byGroup = {};
  for (const t of BOARD.tiles) if (t.group) (byGroup[t.group] ??= []).push(t.index);
  assert.deepEqual(Object.keys(GROUP_TILES).sort(), Object.keys(BOARD.groups).sort());
  for (const [g, tiles] of Object.entries(GROUP_TILES)) assert.deepEqual(tiles, byGroup[g], g);
  for (const z of ZONES) {
    assert.equal(typeof z.name, 'string');
    assert.ok(Number.isFinite(z.x) && Number.isFinite(z.z) && z.r > 0);
    assert.ok(Array.isArray(z.beds) && z.beds.length > 0);
  }
  assert.equal(new Set(ZONES.map((z) => z.name)).size, ZONES.length);
  assert.equal(BOARD.jailIndex, 10);
  assert.equal(BOARD.goToJailIndex, 30);
  assert.equal(BOARD.freeParkingIndex, 20);
  assert.ok(JAIL_YARD.gate.x > JAIL_YARD.minX && JAIL_YARD.gate.x < JAIL_YARD.maxX);
  // The cross-section is ordered from the centre outward.
  const bands = [M.CORE, M.WALK_IN, M.CYCLE_OUT, M.TRAFFIC_OUT, M.KERB, M.PROP, M.FORECOURT, M.DEEP, M.LOT_BACK, M.SERVICE, M.SERVICE_OUT, M.RAIL_OUT, M.SEA_X];
  for (let k = 1; k < bands.length; k++) assert.ok(bands[k] > bands[k - 1]);
  assert.ok(M.LANE > M.TRAFFIC_OUT && M.LANE < M.KERB && near(M.KERB - M.TRAFFIC_OUT, M.LANE_W));
});

test('angleDelta: shortest signed turn', () => {
  assert.ok(near(angleDelta(0, Math.PI / 2), Math.PI / 2));
  assert.ok(near(angleDelta(Math.PI / 2, 0), -Math.PI / 2));
  assert.ok(near(angleDelta(3, -3), 2 * Math.PI - 6));
  assert.ok(near(angleDelta(-3, 3), 6 - 2 * Math.PI));
  assert.ok(near(angleDelta(0, 4 * Math.PI), 0));
  for (let a = -7; a <= 7; a += 0.7) for (let b = -7; b <= 7; b += 0.9) {
    const d = angleDelta(a, b);
    assert.ok(d >= -Math.PI - 1e-12 && d <= Math.PI + 1e-12);
    assert.ok(near(Math.cos(a + d), Math.cos(b), 1e-9) && near(Math.sin(a + d), Math.sin(b), 1e-9));
  }
});
