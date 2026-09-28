// Building, selling, mortgaging (CONTRACT §4.10, §4.11).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { legalActions, unmortgageCost } from '../engine/index.js';
import {
  newGame, act, reject, roll, player, tile, give, edit, jail, setCash, setTurn, assertEvent,
} from './helpers.js';

const build = (tileIndex, playerId = 'p1') => ({ type: 'BUILD', playerId, tileIndex });
const sell = (tileIndex, playerId = 'p1') => ({ type: 'SELL_HOUSE', playerId, tileIndex });
const mortgage = (tileIndex, playerId = 'p1') => ({ type: 'MORTGAGE', playerId, tileIndex });
const unmortgage = (tileIndex, playerId = 'p1') => ({ type: 'UNMORTGAGE', playerId, tileIndex });

/** p1 owns the brown group (1, 3; house cost 50) with the given houses. */
function browns(h1 = 0, h3 = 0, opts) {
  return give(give(newGame(opts), 'p1', 1, { houses: h1 }), 'p1', 3, { houses: h3 });
}

const houses = (s) => [tile(s, 1).houses, tile(s, 3).houses];

describe('BUILD', () => {
  test('building costs houseCost and takes a house from the bank', () => {
    const { state, events } = act(browns(), build(1));
    assert.equal(tile(state, 1).houses, 1);
    assert.equal(player(state, 'p1').cash, 1450);
    assert.equal(state.bank.houses, 31);
    assertEvent(events, 'built', { playerId: 'p1', tileIndex: 1, houses: 1 });
  });

  test('even-build rule', () => {
    let s = act(browns(), build(1)).state;           // [1,0]
    reject(s, build(1), 'UNEVEN_BUILD');
    assert.deepEqual(legalActions(s, 'p1').build, [3]);
    s = act(s, build(3)).state;                       // [1,1]
    s = act(s, build(1)).state;                       // [2,1]
    reject(s, build(1), 'UNEVEN_BUILD');
    s = act(s, build(3)).state;                       // [2,2]
    assert.deepEqual(houses(s), [2, 2]);
    assert.equal(player(s, 'p1').cash, 1300);
    assert.equal(s.bank.houses, 28);
  });

  test('evenBuild: false allows uneven building', () => {
    let s = browns(0, 0, { settings: { evenBuild: false } });
    s = act(s, build(1)).state;
    s = act(s, build(1)).state;
    s = act(s, build(1)).state;
    assert.deepEqual(houses(s), [3, 0]);
    assert.deepEqual(legalActions(s, 'p1').build.sort((a, b) => a - b), [1, 3]);
  });

  test('requires the full color group', () => {
    const s = give(newGame(), 'p1', 1);
    reject(s, build(1), 'NOT_MONOPOLY');
    reject(give(s, 'p2', 3), build(1), 'NOT_MONOPOLY');
  });

  test('requires ownership', () => {
    const s = give(give(newGame(), 'p2', 1), 'p2', 3);
    reject(s, build(1), 'NOT_OWNER');
  });

  test('only on properties', () => {
    const s = give(give(browns(), 'p1', 5), 'p1', 12);
    reject(s, build(5), 'INVALID_TILE');
    reject(s, build(12), 'INVALID_TILE');
    reject(s, build(0), 'INVALID_TILE');
    reject(s, build(99), ['INVALID_TILE', 'BAD_PAYLOAD']);
    reject(s, build('1'), 'BAD_PAYLOAD');
    reject(s, { type: 'BUILD', playerId: 'p1' }, 'BAD_PAYLOAD');
  });

  test('no building while any tile in the group is mortgaged', () => {
    const s = give(browns(), 'p1', 3, { mortgaged: true });
    reject(s, build(1), 'MORTGAGED_IN_GROUP');
  });

  test('at most a hotel', () => {
    reject(browns(5, 5), build(1), 'MAX_BUILDINGS');
  });

  test('needs the house cost in cash', () => {
    reject(setCash(browns(), 'p1', 49), build(1), 'INSUFFICIENT_FUNDS');
    act(setCash(browns(), 'p1', 50), build(1));
  });

  test('bank house shortage', () => {
    const s = edit(browns(), (x) => { x.bank.houses = 0; });
    reject(s, build(1), 'BANK_SHORTAGE');
    assert.deepEqual(legalActions(s, 'p1').build, []);
  });

  test('upgrading to a hotel returns 4 houses to the bank', () => {
    const s = browns(4, 4);
    assert.equal(s.bank.houses, 24);
    const { state, events } = act(s, build(1));
    assert.equal(tile(state, 1).houses, 5);
    assert.equal(state.bank.houses, 28);
    assert.equal(state.bank.hotels, 11);
    assert.equal(player(state, 'p1').cash, 1450);
    assertEvent(events, 'built', { playerId: 'p1', tileIndex: 1, houses: 5 });
  });

  test('a hotel needs a hotel in the bank (houses do not matter)', () => {
    const s = edit(browns(4, 4), (x) => { x.bank.hotels = 0; x.bank.houses = 0; });
    reject(s, build(1), 'BANK_SHORTAGE');
    act(edit(s, (x) => { x.bank.hotels = 1; }), build(1));
  });

  test('allowed in end_turn, jail_decision and buying_or_auction; not off-turn', () => {
    const s = browns();
    reject(s, build(1, 'p2'), 'NOT_YOUR_TURN');
    act(setTurn(s, { phase: 'end_turn' }), build(1));
    act(jail(s, 'p1'), build(1)); // phase jail_decision
    const buying = roll(s, 'p1', 3, 3).state; // → 6, unowned
    assert.equal(buying.turn.phase, 'buying_or_auction');
    act(buying, build(1));
  });
});

describe('SELL_HOUSE', () => {
  test('even-build rule for selling, refund is half the house cost', () => {
    const s = browns(2, 1);
    reject(s, sell(3), 'UNEVEN_BUILD');
    assert.deepEqual(legalActions(s, 'p1').sellHouse, [1]);
    const { state, events } = act(s, sell(1));
    assert.deepEqual(houses(state), [1, 1]);
    assert.equal(player(state, 'p1').cash, 1525);
    assert.equal(state.bank.houses, s.bank.houses + 1);
    assertEvent(events, 'sold_house', { playerId: 'p1', tileIndex: 1, houses: 1 });
  });

  test('evenBuild: false allows uneven selling', () => {
    const s = browns(2, 1, { settings: { evenBuild: false } });
    const { state } = act(s, sell(3));
    assert.deepEqual(houses(state), [2, 0]);
  });

  test('nothing to sell', () => {
    reject(browns(), sell(1), 'NO_BUILDINGS');
  });

  test('not on someone else\'s tile', () => {
    const s = give(give(newGame(), 'p2', 1, { houses: 1 }), 'p2', 3, { houses: 1 });
    reject(s, sell(1), 'NOT_OWNER');
  });

  test('selling a hotel breaks it into 4 houses', () => {
    const s = browns(5, 5);
    assert.equal(s.bank.houses, 32);
    const { state } = act(s, sell(1));
    assert.deepEqual(houses(state), [4, 5]);
    assert.equal(state.bank.houses, 28);
    assert.equal(state.bank.hotels, 11);
    assert.equal(player(state, 'p1').cash, 1525);
  });

  test('breaking a hotel needs 4 houses in the bank', () => {
    const s = edit(browns(5, 5), (x) => { x.bank.houses = 3; });
    reject(s, sell(1), 'BANK_SHORTAGE');
    assert.deepEqual(legalActions(s, 'p1').sellHouse, []);
  });
});

describe('MORTGAGE / UNMORTGAGE', () => {
  test('MORTGAGE pays the mortgage value', () => {
    const { state, events } = act(give(newGame(), 'p1', 6), mortgage(6));
    assert.equal(tile(state, 6).mortgaged, true);
    assert.equal(player(state, 'p1').cash, 1550);
    assertEvent(events, 'mortgaged', { playerId: 'p1', tileIndex: 6, amount: 50 });
  });

  test('railroads and utilities can be mortgaged', () => {
    let s = give(give(newGame(), 'p1', 5), 'p1', 12);
    s = act(s, mortgage(5)).state;
    s = act(s, mortgage(12)).state;
    assert.equal(player(s, 'p1').cash, 1500 + 100 + 75);
  });

  test('cannot mortgage twice, or someone else\'s tile', () => {
    reject(give(newGame(), 'p1', 6, { mortgaged: true }), mortgage(6), 'ALREADY_MORTGAGED');
    reject(give(newGame(), 'p2', 6), mortgage(6), 'NOT_OWNER');
  });

  test('blocked while any tile in the color group has buildings', () => {
    const s = browns(0, 1);
    reject(s, mortgage(1), 'HAS_BUILDINGS');
    reject(s, mortgage(3), 'HAS_BUILDINGS');
    assert.deepEqual(legalActions(s, 'p1').mortgage, []);
    const sold = act(s, sell(3)).state;
    act(sold, mortgage(1));
  });

  test('unmortgageCost is mortgage + 10%, rounded up', () => {
    assert.equal(unmortgageCost(1), 33);   // 30
    assert.equal(unmortgageCost(6), 55);   // 50
    assert.equal(unmortgageCost(12), 83);  // 75 → 82.5
    assert.equal(unmortgageCost(5), 110);  // 100
    assert.equal(unmortgageCost(37), 193); // 175 → 192.5
    assert.equal(unmortgageCost(39), 220); // 200
  });

  test('UNMORTGAGE charges the unmortgage cost', () => {
    const s = give(newGame(), 'p1', 12, { mortgaged: true });
    const { state, events } = act(s, unmortgage(12));
    assert.equal(tile(state, 12).mortgaged, false);
    assert.equal(player(state, 'p1').cash, 1500 - 83);
    assertEvent(events, 'unmortgaged', { playerId: 'p1', tileIndex: 12, amount: 83 });

    const rail = act(give(newGame(), 'p1', 5, { mortgaged: true }), unmortgage(5)).state;
    assert.equal(player(rail, 'p1').cash, 1500 - 110);
  });

  test('UNMORTGAGE needs cash and a mortgaged tile', () => {
    const s = give(newGame(), 'p1', 12, { mortgaged: true });
    reject(setCash(s, 'p1', 82), unmortgage(12), 'INSUFFICIENT_FUNDS');
    act(setCash(s, 'p1', 83), unmortgage(12));
    reject(give(newGame(), 'p1', 12), unmortgage(12), 'NOT_MORTGAGED');
    reject(give(newGame(), 'p2', 12, { mortgaged: true }), unmortgage(12), 'NOT_OWNER');
  });

  test('a tile mortgaged via MORTGAGE collects no rent; unmortgaged it does again', () => {
    let s = give(newGame(), 'p1', 3);
    s = act(s, mortgage(3)).state;
    s = roll(s, 'p1', 4, 6).state; // p1 → 10
    s = act(s, { type: 'END_TURN', playerId: 'p1' }).state;
    const blocked = roll(s, 'p2', 1, 2); // p2 → 3
    assert.equal(player(blocked.state, 'p2').cash, 1500);
    assert.equal(player(blocked.state, 'p1').cash, 1530);
    assert.ok(!blocked.events.some((e) => e.type === 'paid_rent'));

    const paid = roll(give(s, 'p1', 3), 'p2', 1, 2);
    assert.equal(player(paid.state, 'p2').cash, 1496);
  });
});
