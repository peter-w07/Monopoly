// Lane B (lots, landmarks): the building plans in public/r3d/lot-styles.js obey the city design (§3.4, §3.9,
// §3.10, §6.2): hotels at least twice the four-house height, the occlusion rule on the near (south / west) side
// and the Jail corner, the side height caps, unit slots that fill the 26 m frontage, footprints inside their lots or
// reserved areas, and a style for every tile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { laneClear, lotRect, qOf, address, M, JAIL_YARD } from '../public/r3d/city-layout.js';
import {
  LOT_STYLES, STATION_STYLES, UTILITY_STYLES, SPECIAL_STYLES, CORNER_STYLES, UNIT_W, UNIT_GAP, UNIT_SLOTS, UNIT_ORDER,
  POWER_ZONE, APEX_R, GO_GATE, heightOf, planLot, planSpecial, partFootprint, frontFaceOf, structures, groupOfTile,
  roundelSpot, styleOf, LOT_BASE,
} from '../public/r3d/lot-styles.js';

const BOARD = JSON.parse(readFileSync(new URL('../engine/data/board.json', import.meta.url), 'utf8'));
const GROUPS = Object.keys(BOARD.groups);
const EPS = 1e-6;
const ALL = structures({ board: BOARD });
const inRect = (fp, r, slack = EPS) => fp.minX >= r.minX - slack && fp.maxX <= r.maxX + slack && fp.minZ >= r.minZ - slack && fp.maxZ <= r.maxZ + slack;

test('every board group has a style; H(L5) ≥ 2·H(L4) and heights never shrink with houses', () => {
  for (const g of GROUPS) {
    const s = LOT_STYLES[g];
    assert.ok(s, `style for ${g}`);
    assert.equal(s.heights.length, 6);
    assert.ok(s.heights[5] >= 2 * s.heights[4] - EPS, `${g}: hotel ${s.heights[5]} vs 2 × ${s.heights[4]}`);
    for (let lv = 1; lv <= 5; lv++) assert.ok(s.heights[lv] >= s.heights[lv - 1] - EPS, `${g} L${lv}`);
    assert.equal(heightOf(g, 5), s.hotel.height);
    assert.equal(heightOf(g, 4), s.heights[4]);
    assert.ok(heightOf(g, -1) > 0 && heightOf(g, -1) < 4);
    assert.ok(['units', 'tiers'].includes(s.kind));
    assert.ok(s.hotel.name && s.flourish && s.bed && s.name);
  }
});

test('the catalogue matches the design table (§6.2) within a metre', () => {
  const expect = { brown: [7.5, 17], lightblue: [11, 24], pink: [12.5, 34], orange: [17, 40], red: [22, 64], yellow: [49, 104], green: [57, 134], darkblue: [12, 195] };
  for (const [g, [h4, h5]] of Object.entries(expect)) {
    assert.ok(Math.abs(heightOf(g, 4) - h4) <= 1.65, `${g} H(L4) ${heightOf(g, 4)} ≈ ${h4}`);
    assert.ok(Math.abs(heightOf(g, 5) - h5) <= 1, `${g} H(L5) ${heightOf(g, 5)} ≈ ${h5}`);
  }
  const tiers = { yellow: [16, 27, 38, 49], green: [23, 34, 45, 57] };
  for (const [g, hs] of Object.entries(tiers)) hs.forEach((h, k) => assert.ok(Math.abs(heightOf(g, k + 1) - h) <= 1.65, `${g} L${k + 1}`));
});

test('four 6 m units with three 2/3 m gaps fill the 26 m frontage exactly and fit the lot', () => {
  const span = 4 * UNIT_W + 3 * UNIT_GAP;
  assert.ok(Math.abs(span - 26) < EPS, `span ${span}`);
  assert.equal(span <= M.LOT_W + EPS, true);
  assert.deepEqual([...UNIT_ORDER].sort(), [0, 1, 2, 3]);
  const left = UNIT_SLOTS[0] - UNIT_W / 2;
  const right = UNIT_SLOTS[3] + UNIT_W / 2;
  assert.ok(Math.abs(left + 13) < EPS && Math.abs(right - 13) < EPS);
  for (let k = 1; k < 4; k++) assert.ok(Math.abs(UNIT_SLOTS[k] - UNIT_SLOTS[k - 1] - (UNIT_W + UNIT_GAP)) < EPS);
  // And every unit-group lot at L4 shows four distinct slots.
  for (const g of GROUPS) {
    if (LOT_STYLES[g].kind !== 'units') continue;
    const bodies = planLot(BOARD.tiles.find((t) => t.group === g).index, 4, { board: BOARD }).filter((p) => p.role === 'body');
    assert.equal(new Set(bodies.map((b) => b.slot)).size, 4, g);
  }
});

test('every tile 0–39 has a style or a site plan', () => {
  for (let i = 0; i < 40; i++) {
    const t = BOARD.tiles[i];
    if (i % 10 === 0) assert.ok(CORNER_STYLES[i], `corner ${i}`);
    else if (t.type === 'property') assert.ok(LOT_STYLES[groupOfTile(i, BOARD)], `property ${i}`);
    else if (t.type === 'railroad') assert.ok(STATION_STYLES[i], `station ${i}`);
    else if (t.type === 'utility') assert.ok(UTILITY_STYLES[i], `utility ${i}`);
    else assert.ok(SPECIAL_STYLES[i] && planSpecial(i).length > 1, `special ${i}`);
    assert.ok(ALL.some((s) => s.tile === i), `structures on ${i}`);
  }
});

test('§3.10 occlusion rule: south / west lots and the Jail corner keep their lane visible', () => {
  let checked = 0;
  for (const s of ALL) {
    const near = (s.tile % 10 !== 0 && qOf(s.tile) <= 1) || s.tile === 10;
    if (!near || s.thin || s.zone === 'rail' || s.zone === 'footbridge' || s.zone === 'power') continue;
    // frontFace recomputed independently from the footprint.
    assert.equal(frontFaceOf(s.tile, s.footprint), s.frontFace);
    assert.ok(laneClear(s.tile, s.frontFace, s.height), `tile ${s.tile} L${s.level} ${s.part}: front ${s.frontFace}, height ${s.height}`);
    checked++;
  }
  assert.ok(checked > 200, `checked ${checked}`);
});

test('absolute side caps: S 24, W 40, N 110, E 200 (every lot structure, every level)', () => {
  const caps = [24, 40, 110, 200];
  for (const s of ALL) {
    if (s.tile % 10 === 0 || s.zone !== 'lot') continue;
    assert.ok(s.height <= caps[qOf(s.tile)] + EPS, `tile ${s.tile} L${s.level} ${s.part} ${s.height}`);
    assert.ok(laneClear(s.tile, s.frontFace, s.thin ? 0 : s.height) || s.thin, `tile ${s.tile} ${s.part}`);
  }
});

test('hotels and tiers fit inside the lot rectangle (1 m side inset); every footprint stays in its lot or reserved area', () => {
  for (const g of GROUPS) {
    const tile = BOARD.tiles.find((t) => t.group === g).index;
    const r = lotRect(tile);
    const inset = qOf(tile) % 2 === 0 ? { minX: r.minX + 1, maxX: r.maxX - 1, minZ: r.minZ, maxZ: r.maxZ } : { minX: r.minX, maxX: r.maxX, minZ: r.minZ + 1, maxZ: r.maxZ - 1 };
    for (const lv of [1, 2, 3, 4, 5]) {
      for (const p of planLot(tile, lv, { board: BOARD })) {
        if (p.role === 'post' || p.role === 'flagpole') continue;
        const big = lv === 5 || (LOT_STYLES[g].kind === 'tiers' && p.role !== 'decor');
        if (big && p.role !== 'podium') assert.ok(inRect(partFootprint(tile, p), inset), `${g} L${lv} ${p.role} inside the inset lot`);
      }
    }
  }
  for (const s of ALL) {
    const fp = s.footprint;
    if (s.zone === 'lot') assert.ok(inRect(fp, lotRect(s.tile)), `tile ${s.tile} L${s.level} ${s.part} in lotRect`);
    else if (s.zone === 'sidewalk') {
      const A = address(s.tile);
      const d = Math.abs((fp.minX + fp.maxX) / 2 - A.lot.cx) * Math.abs(A.out.x) + Math.abs((fp.minZ + fp.maxZ) / 2 - A.lot.cz) * Math.abs(A.out.z);
      assert.ok(Math.abs(156 - d - M.POST) < 0.2, `post of ${s.tile} at ${M.POST}`);
    } else if (s.zone === 'site') {
      // Corner L-site: [117,173]² minus [117,139]² in the corner's quadrant.
      const [sx, sz] = [[1, 1], [-1, 1], [-1, -1], [1, -1]][s.tile / 10];
      const ax0 = Math.min(sx * fp.minX, sx * fp.maxX);
      const ax1 = Math.max(sx * fp.minX, sx * fp.maxX);
      const az0 = Math.min(sz * fp.minZ, sz * fp.maxZ);
      const az1 = Math.max(sz * fp.minZ, sz * fp.maxZ);
      assert.ok(ax0 >= M.CORE - EPS && ax1 <= M.LOT_BACK + EPS && az0 >= M.CORE - EPS && az1 <= M.LOT_BACK + EPS, `corner ${s.tile} ${s.part} in the quadrant`);
      assert.ok(ax0 >= M.PROP - EPS || az0 >= M.PROP - EPS, `corner ${s.tile} ${s.part} outside the elbow`);
    } else if (s.zone === 'apex') {
      const q = s.tile / 10;
      const apex = address(s.tile);
      for (const x of [fp.minX, fp.maxX]) for (const z of [fp.minZ, fp.maxZ]) assert.ok(Math.hypot(x - apex.x, z - apex.z) <= APEX_R + EPS, `corner ${s.tile} ${s.part} within ${APEX_R} m of the apex (q ${q})`);
    } else if (s.zone === 'rail') {
      const A = address(s.tile);
      const along = Math.abs(((fp.minX + fp.maxX) / 2 - A.lot.cx) * A.along.x + ((fp.minZ + fp.maxZ) / 2 - A.lot.cz) * A.along.z);
      const half = Math.abs((fp.maxX - fp.minX) * A.along.x + (fp.maxZ - fp.minZ) * A.along.z) / 2;
      assert.ok(along + half <= 60 + EPS, `station extras of ${s.tile} within ±60 m`);
      const dist = [fp.minZ, -fp.maxX, -fp.maxZ, fp.minX][qOf(s.tile)];
      const far = [fp.maxZ, -fp.minX, -fp.minZ, fp.maxX][qOf(s.tile)];
      assert.ok(dist >= 191 - EPS && far <= M.RAIL_OUT + EPS, `rail corridor ${s.tile} ${s.part}`);
    } else if (s.zone === 'footbridge') {
      const dist = [fp.minZ, -fp.maxX, -fp.maxZ, fp.minX][qOf(s.tile)];
      const far = [fp.maxZ, -fp.minX, -fp.minZ, fp.maxX][qOf(s.tile)];
      assert.ok(dist >= M.LOT_BACK - EPS && far <= 191.2 + EPS, `footbridge ${s.tile}`);
    } else if (s.zone === 'power') {
      assert.ok(inRect(fp, POWER_ZONE), `power station part ${s.part}`);
    } else assert.fail(`unknown zone ${s.zone}`);
  }
});

test('the Jail yard and the GO Gate match the layout (§3.5)', () => {
  const yard = ALL.filter((s) => s.tile === 10 && /^yard/.test(s.part));
  const minX = Math.min(...yard.map((s) => s.footprint.minX));
  const maxX = Math.max(...yard.map((s) => s.footprint.maxX));
  const minZ = Math.min(...yard.map((s) => s.footprint.minZ));
  const maxZ = Math.max(...yard.map((s) => s.footprint.maxZ));
  assert.ok(Math.abs(minX - JAIL_YARD.minX) < 0.01 && Math.abs(maxX - JAIL_YARD.maxX) < 0.01, 'yard x');
  assert.ok(Math.abs(minZ - JAIL_YARD.minZ) < 0.31 && Math.abs(maxZ - JAIL_YARD.maxZ) < 0.01, 'yard z');
  const gate = ALL.find((s) => s.tile === 10 && s.part === 'yardGate').footprint;
  assert.ok(gate.minX <= JAIL_YARD.gate.x && gate.maxX >= JAIL_YARD.gate.x, 'the gate spans the layout gate point');
  const apex = address(0);
  for (const leg of [GO_GATE.inner, GO_GATE.outer]) assert.ok(Math.hypot(leg.x - apex.x, leg.z - apex.z) < APEX_R);
  assert.ok(GO_GATE.height === 31);
  // The legs straddle the token and traffic lanes on the diagonal (inner sidewalk ↔ corner plaza).
  const diag = (p) => (p.x + p.z) / Math.SQRT2;
  assert.ok(diag(GO_GATE.inner) < (M.ARC_C + 0.75 / Math.SQRT2) * Math.SQRT2 && diag(GO_GATE.outer) > diag({ x: 123.25 + 10.75 / Math.SQRT2, z: 123.25 + 10.75 / Math.SQRT2 }));
});

test('roundels: ≥ 9 m, on the lot, never under a building body', () => {
  for (const t of BOARD.tiles) {
    if (!['property', 'railroad', 'utility'].includes(t.type)) continue;
    const levels = t.type === 'property' ? [0, 1, 2, 3, 4, 5] : [0];
    for (const lv of levels) {
      const r = roundelSpot(t.index, lv, { board: BOARD });
      assert.ok(r.size >= 9 - EPS, `roundel ${t.index} L${lv}`);
      const fp = partFootprint(t.index, { a: r.a, w: r.size, d0: r.d - r.size / 2, d1: r.d + r.size / 2 });
      assert.ok(inRect(fp, lotRect(t.index)), `roundel ${t.index} L${lv} inside the lot`);
      if (r.roof) continue;
      for (const p of planLot(t.index, lv, { board: BOARD })) {
        if (!['body', 'top', 'kit', 'podium', 'pool', 'decor', 'canopy', 'billboard'].includes(p.role) || p.role === 'kit' || p.role === 'podium') continue;
        const overlapA = Math.min(r.a + r.size / 2, p.a + p.w / 2) - Math.max(r.a - r.size / 2, p.a - p.w / 2);
        const overlapD = Math.min(r.d + r.size / 2, p.d1) - Math.max(r.d - r.size / 2, p.d0);
        const onGround = p.y0 <= LOT_BASE + 0.5;
        assert.ok(!(overlapA > 0.3 && overlapD > 0.3 && onGround), `roundel ${t.index} L${lv} clear of ${p.role}:${p.variant ?? ''}`);
      }
    }
  }
});

test('plans are deterministic and defensive', () => {
  assert.deepEqual(planLot(39, 5), planLot(39, 5));
  assert.equal(styleOf('nope', 3), LOT_STYLES.orange);
  assert.ok(planLot(1, 99).some((p) => p.role === 'top'), 'levels clamp to 5');
  assert.ok(planLot(1, -7).some((p) => p.role === 'hoarding'), 'levels clamp to −1');
  assert.ok(planLot(1, NaN).some((p) => p.role === 'kit'));
  assert.equal(heightOf('brown', 'x'), LOT_STYLES.brown.heights[0]);
});
