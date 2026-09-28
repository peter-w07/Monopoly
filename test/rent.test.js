// Rent: properties, monopolies, buildings, railroads, utilities, mortgages (CONTRACT §2 rentFor, §4.4).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { rentFor } from '../engine/index.js';
import {
  newGame, roll, player, give, setPosition, setPlayer, assertEvent, assertNoEvent,
} from './helpers.js';

/** p1 lands on `target` with a non-doubles roll of [1, 2] (starting 3 tiles earlier). */
function landOn(state, target, dice = [1, 2]) {
  const from = (target - dice[0] - dice[1] + 40) % 40;
  return roll(setPosition(state, 'p1', from), 'p1', dice[0], dice[1]);
}

/** Land p1 on `target` and check rent `amount` went to p2. */
function expectRent(state, target, amount, dice) {
  const { state: after, events } = landOn(state, target, dice);
  assertEvent(events, 'paid_rent', { playerId: 'p1', ownerId: 'p2', tileIndex: target, amount });
  assert.equal(player(after, 'p1').cash, 1500 - amount);
  assert.equal(player(after, 'p2').cash, 1500 + amount);
  assert.equal(after.turn.phase, 'end_turn');
  return after;
}

describe('property rent', () => {
  test('unimproved rent without a monopoly', () => {
    expectRent(give(newGame(), 'p2', 3), 3, 4); // Baltic rent[0] = 4
  });

  test('unimproved rent is doubled with a monopoly', () => {
    expectRent(give(give(newGame(), 'p2', 1), 'p2', 3), 3, 8);
  });

  const houseRents = [20, 60, 180, 320, 450]; // Baltic rent[1..5]
  for (let houses = 1; houses <= 5; houses++) {
    test(`rent with ${houses === 5 ? 'a hotel' : `${houses} house(s)`}`, () => {
      let s = give(newGame(), 'p2', 1, { houses });
      s = give(s, 'p2', 3, { houses });
      expectRent(s, 3, houseRents[houses - 1]);
    });
  }

  test('no rent on a mortgaged property', () => {
    const s = give(give(newGame(), 'p2', 1), 'p2', 3, { mortgaged: true });
    const { state, events } = landOn(s, 3);
    assertNoEvent(events, 'paid_rent');
    assert.equal(player(state, 'p1').cash, 1500);
    assert.equal(player(state, 'p2').cash, 1500);
    assert.equal(state.turn.phase, 'end_turn');
  });

  test('no rent on your own property', () => {
    const { state, events } = landOn(give(newGame(), 'p1', 3), 3);
    assertNoEvent(events, 'paid_rent');
    assert.equal(player(state, 'p1').cash, 1500);
    assert.equal(state.turn.phase, 'end_turn');
  });

  test('an owner in jail still collects', () => {
    const s = setPlayer(give(newGame(), 'p2', 3), 'p2', { inJail: true, position: 10 });
    expectRent(s, 3, 4);
  });
});

describe('railroad rent', () => {
  const railroads = [5, 15, 25, 35];
  const rents = [25, 50, 100, 200];
  for (let count = 1; count <= 4; count++) {
    test(`owner of ${count} railroad(s) charges ${rents[count - 1]}`, () => {
      let s = newGame();
      for (const r of railroads.slice(0, count)) s = give(s, 'p2', r);
      expectRent(s, 5, rents[count - 1]);
    });
  }

  test('mortgaged railroads still count towards the total', () => {
    let s = give(newGame(), 'p2', 5);
    s = give(s, 'p2', 15, { mortgaged: true });
    s = give(s, 'p2', 25, { mortgaged: true });
    expectRent(s, 5, 100);
  });
});

describe('utility rent', () => {
  test('one utility: 4 × dice', () => {
    expectRent(give(newGame(), 'p2', 12), 12, 28, [3, 4]); // 5 → 12, total 7
  });

  test('both utilities: 10 × dice', () => {
    expectRent(give(give(newGame(), 'p2', 12), 'p2', 28), 12, 70, [3, 4]);
  });

  test('mortgaged utility charges nothing', () => {
    const s = give(give(newGame(), 'p2', 12, { mortgaged: true }), 'p2', 28);
    const { state, events } = landOn(s, 12, [3, 4]);
    assertNoEvent(events, 'paid_rent');
    assert.equal(player(state, 'p1').cash, 1500);
  });
});

describe('rentFor', () => {
  test('matches the contract for every kind of tile', () => {
    let s = newGame();
    assert.equal(rentFor(s, 3), 0, 'unowned');
    s = give(s, 'p2', 3);
    assert.equal(rentFor(s, 3), 4);
    s = give(s, 'p2', 1);
    assert.equal(rentFor(s, 3), 8);
    assert.equal(rentFor(s, 1), 4); // Mediterranean rent[0] 2 × 2
    s = give(s, 'p2', 3, { houses: 3 });
    assert.equal(rentFor(s, 3), 180);
    s = give(s, 'p2', 3, { mortgaged: true });
    assert.equal(rentFor(s, 3), 0, 'mortgaged');

    s = give(give(s, 'p2', 5), 'p2', 15);
    assert.equal(rentFor(s, 5), 50);
    assert.equal(rentFor(s, 5, { rentMultiplier: 2 }), 100);

    s = give(s, 'p2', 12);
    assert.equal(rentFor(s, 12, { diceTotal: 9 }), 36);
    assert.equal(rentFor(s, 12, { diceTotal: 9, diceMultiplier: 10 }), 90);
    s = give(s, 'p2', 28);
    assert.equal(rentFor(s, 28, { diceTotal: 9 }), 90);
  });

  test('does not mutate the state', () => {
    const s = give(give(newGame(), 'p2', 1), 'p2', 3);
    const before = structuredClone(s);
    rentFor(s, 3);
    assert.deepEqual(s, before);
  });
});
