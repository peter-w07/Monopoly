// Chance / Community Chest (CONTRACT §1 card kinds, §4.5, §4.6) and the free parking pot.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { rollDice, shuffle, GOOJF_ID } from '../engine/index.js';
import {
  newGame, act, roll, withDice, player, tile, give, jail, giveJailCard, stackDeck, edit,
  setPosition, setCash, setPlayer, assertEvent, assertNoEvent, ofType,
} from './helpers.js';

describe('nearest railroad / utility cards', () => {
  test('nearest railroad: owned by another player → double rent', () => {
    let s = stackDeck(setPosition(newGame(), 'p1', 3), 'chance', [4]);
    s = give(give(s, 'p2', 15), 'p2', 5); // two railroads → normal rent 50
    const { state, events } = roll(s, 'p1', 1, 3); // 3 → 7 Chance → 15
    assert.equal(player(state, 'p1').position, 15);
    assertEvent(events, 'paid_rent', { playerId: 'p1', ownerId: 'p2', tileIndex: 15, amount: 100 });
    assert.equal(player(state, 'p1').cash, 1400);
    assert.equal(player(state, 'p2').cash, 1600);
    assert.equal(state.turn.phase, 'end_turn');
  });

  test('nearest railroad wraps past GO (collecting salary) before paying', () => {
    let s = stackDeck(setPosition(newGame(), 'p1', 31), 'chance', [5]);
    s = give(s, 'p2', 5);
    const { state, events } = roll(s, 'p1', 2, 3); // 31 → 36 Chance → 5
    assert.equal(player(state, 'p1').position, 5);
    assert.equal(ofType(events, 'passed_go').length, 1);
    assertEvent(events, 'paid_rent', { tileIndex: 5, amount: 50 });
    assert.equal(player(state, 'p1').cash, 1500 + 200 - 50);
  });

  test('nearest railroad unowned → purchase decision', () => {
    const s = stackDeck(setPosition(newGame(), 'p1', 19), 'chance', [4]);
    const { state } = roll(s, 'p1', 1, 2); // 19 → 22 Chance → 25
    assert.equal(player(state, 'p1').position, 25);
    assert.equal(state.turn.phase, 'buying_or_auction');
    assert.equal(state.turn.pendingPurchase, 25);
  });

  test('nearest utility: owned → fresh roll × 10, even with a single utility', () => {
    let s = stackDeck(setPosition(newGame({ seed: 4242 }), 'p1', 3), 'chance', [6]);
    s = give(s, 'p2', 12);
    s = withDice(s, 1, 3); // 3 → 7 Chance → 12
    const fresh = rollDice({ seed: s.rng.seed, counter: s.rng.counter + 2 });
    const amount = 10 * (fresh[0] + fresh[1]);

    const { state, events } = act(s, { type: 'ROLL', playerId: 'p1' });
    assert.equal(player(state, 'p1').position, 12);
    assertEvent(events, 'dice_rolled', { playerId: 'p1', dice: fresh, purpose: 'utility' });
    assertEvent(events, 'paid_rent', { playerId: 'p1', ownerId: 'p2', tileIndex: 12, amount });
    assert.equal(player(state, 'p1').cash, 1500 - amount);
    assert.equal(player(state, 'p2').cash, 1500 + amount);
    assert.equal(state.rng.counter, s.rng.counter + 4, 'two dice for the move, two for the utility');
    assert.deepEqual(state.turn.lastRoll, [1, 3], 'the utility roll is not the player\'s move roll');
  });
});

describe('Get Out of Jail Free', () => {
  test('drawing it gives the player a card from that deck', () => {
    const s = stackDeck(setPosition(newGame(), 'p1', 10), 'community', [GOOJF_ID.community]);
    const { state, events } = roll(s, 'p1', 3, 4); // 10 → 17 Community Chest
    assert.equal(player(state, 'p1').getOutOfJailCards, 1);
    assert.deepEqual(player(state, 'p1').jailCards, ['community']);
    assertEvent(events, 'jail_card_received', { playerId: 'p1', deck: 'community' });
    assert.equal(state.turn.phase, 'end_turn');
  });

  test('is skipped while held, and drawable again once used', () => {
    assert.deepEqual(GOOJF_ID, { chance: 8, community: 4 });
    // p2 holds the Chance card; p1 draws: the GOOJF on top is skipped.
    let s = giveJailCard(newGame(), 'p2', 'chance');
    s = stackDeck(setPosition(s, 'p1', 4), 'chance', [8, 7]); // 7 = collect 50
    const { state, events } = roll(s, 'p1', 1, 2); // 4 → 7 Chance
    assertEvent(events, 'card_drawn', { playerId: 'p1', deck: 'chance', cardId: 7 });
    assert.equal(player(state, 'p1').getOutOfJailCards, 0);
    assert.equal(player(state, 'p1').cash, 1550);
    assert.equal(state.decks.chance.pos, 2);

    // p1 uses its held Community Chest card, then draws it again.
    let j = jail(giveJailCard(newGame(), 'p1', 'community'), 'p1');
    j = stackDeck(j, 'community', [4]);
    j = act(j, { type: 'USE_JAIL_CARD', playerId: 'p1' }).state;
    assert.equal(player(j, 'p1').getOutOfJailCards, 0);
    assert.deepEqual(player(j, 'p1').jailCards, []);
    const again = roll(j, 'p1', 3, 4); // 10 → 17 Community Chest
    assertEvent(again.events, 'card_drawn', { deck: 'community', cardId: 4 });
    assert.equal(player(again.state, 'p1').getOutOfJailCards, 1);
    assert.deepEqual(player(again.state, 'p1').jailCards, ['community']);
  });
});

describe('movement cards', () => {
  test('"Go back 3 spaces" onto Community Chest resolves that card too', () => {
    let s = stackDeck(setPosition(newGame(), 'p1', 31), 'chance', [9]);
    s = stackDeck(s, 'community', [1]); // Bank error: collect 200
    const { state, events } = roll(s, 'p1', 2, 3); // 31 → 36 Chance → 33
    assert.equal(player(state, 'p1').position, 33);
    assertEvent(events, 'moved', { playerId: 'p1', from: 36, to: 33, steps: -3, via: 'card' });
    assertEvent(events, 'card_drawn', { deck: 'chance', cardId: 9 });
    assertEvent(events, 'card_drawn', { deck: 'community', cardId: 1 });
    assert.equal(player(state, 'p1').cash, 1700);
    assertNoEvent(events, 'passed_go');
  });

  test('"Advance to" an owned property pays normal rent', () => {
    let s = stackDeck(setPosition(newGame(), 'p1', 2), 'chance', [0]); // Boardwalk
    s = give(give(s, 'p2', 37), 'p2', 39); // monopoly → 2 × 50
    const { state, events } = roll(s, 'p1', 2, 3);
    assertEvent(events, 'paid_rent', { playerId: 'p1', ownerId: 'p2', tileIndex: 39, amount: 100 });
    assert.equal(player(state, 'p1').cash, 1400);
  });

  test('"Go back 3 spaces" onto Income Tax pays the tax', () => {
    const s = stackDeck(setPosition(newGame(), 'p1', 4), 'chance', [9]);
    const { state } = roll(s, 'p1', 1, 2); // 4 → 7 Chance → 4
    assert.equal(player(state, 'p1').position, 4);
    assert.equal(player(state, 'p1').cash, 1300);
  });
});

describe('deck cycling', () => {
  test('drawing the last card reshuffles the deck with the RNG and resets pos', () => {
    let s = setPosition(newGame({ seed: 31337 }), 'p1', 4);
    const order = [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 7]; // 7 = collect 50, drawn last
    s = edit(s, (x) => { x.decks.chance = { order, pos: 15 }; });
    s = withDice(s, 1, 2); // 4 → 7 Chance
    const expectedOrder = shuffle({ seed: s.rng.seed, counter: s.rng.counter + 2 }, order);

    const { state, events } = act(s, { type: 'ROLL', playerId: 'p1' });
    assertEvent(events, 'card_drawn', { deck: 'chance', cardId: 7 });
    assert.equal(player(state, 'p1').cash, 1550);
    assert.equal(state.decks.chance.pos, 0);
    assert.deepEqual(state.decks.chance.order, expectedOrder);
    assert.equal(state.rng.counter, s.rng.counter + 2 + 15);
  });
});

describe('money cards', () => {
  test('collect and pay', () => {
    let s = stackDeck(setPosition(newGame(), 'p1', 4), 'chance', [15]); // collect 150
    assert.equal(player(roll(s, 'p1', 1, 2).state, 'p1').cash, 1650);
    s = stackDeck(setPosition(newGame(), 'p1', 4), 'chance', [12]); // pay 15
    const { state } = roll(s, 'p1', 1, 2);
    assert.equal(player(state, 'p1').cash, 1485);
    assert.equal(state.pot, 0);
  });

  test('pay_each pays every other non-bankrupt player', () => {
    let s = setPlayer(newGame({ players: 4 }), 'p4', { bankrupt: true, cash: 0 });
    s = stackDeck(setPosition(s, 'p1', 4), 'chance', [14]); // pay each 50
    const { state } = roll(s, 'p1', 1, 2);
    assert.equal(player(state, 'p1').cash, 1400);
    assert.equal(player(state, 'p2').cash, 1550);
    assert.equal(player(state, 'p3').cash, 1550);
    assert.equal(player(state, 'p4').cash, 0);
    assert.equal(state.turn.phase, 'end_turn');
  });

  test('pay_each unaffordable → debt with payees, settled by PAY_DEBT', () => {
    let s = setCash(newGame({ players: 3 }), 'p1', 60);
    s = give(s, 'p1', 6); // mortgage value 50
    s = stackDeck(setPosition(s, 'p1', 4), 'chance', [14]);
    let { state } = roll(s, 'p1', 1, 2);
    assert.equal(state.turn.phase, 'paying');
    const debt = state.turn.pendingDebt;
    assert.equal(debt.toPlayerId, null);
    assert.equal(debt.amount, 100);
    assert.deepEqual(debt.payees, [{ playerId: 'p2', amount: 50 }, { playerId: 'p3', amount: 50 }]);
    assert.equal(player(state, 'p1').cash, 60, 'nothing is paid until the debt is settled');

    state = act(state, { type: 'MORTGAGE', playerId: 'p1', tileIndex: 6 }).state;
    state = act(state, { type: 'PAY_DEBT', playerId: 'p1' }).state;
    assert.equal(player(state, 'p1').cash, 10);
    assert.equal(player(state, 'p2').cash, 1550);
    assert.equal(player(state, 'p3').cash, 1550);
    assert.equal(state.turn.phase, 'end_turn');
    assert.equal(state.turn.pendingDebt, null);
  });

  test('collect_each collects from every other player', () => {
    const s = stackDeck(setPosition(newGame({ players: 3 }), 'p1', 10), 'community', [8]);
    const { state } = roll(s, 'p1', 3, 4); // 10 → 17 Community Chest
    assert.equal(player(state, 'p1').cash, 1520);
    assert.equal(player(state, 'p2').cash, 1490);
    assert.equal(player(state, 'p3').cash, 1490);
    assert.equal(state.turn.phase, 'end_turn');
  });

  test('collect_each: a short payer is auto-liquidated', () => {
    let s = setCash(newGame({ players: 3 }), 'p3', 5);
    s = give(s, 'p3', 1); // mortgage value 30
    s = stackDeck(setPosition(s, 'p1', 10), 'community', [8]);
    const { state } = roll(s, 'p1', 3, 4);
    assert.equal(tile(state, 1).mortgaged, true);
    assert.equal(tile(state, 1).ownerId, 'p3');
    assert.equal(player(state, 'p3').cash, 25);
    assert.equal(player(state, 'p3').bankrupt, false);
    assert.equal(player(state, 'p1').cash, 1520);
    assert.equal(state.turn.phase, 'end_turn');
    assert.equal(state.turn.pendingDebt, null);
  });

  test('collect_each: a broke payer goes bankrupt to the collector', () => {
    let s = setCash(newGame({ players: 3 }), 'p3', 5);
    s = give(s, 'p3', 3, { mortgaged: true });
    s = stackDeck(setPosition(s, 'p1', 10), 'community', [8]);
    const { state, events } = roll(s, 'p1', 3, 4);
    assert.equal(player(state, 'p3').bankrupt, true);
    assert.equal(player(state, 'p3').cash, 0);
    assertEvent(events, 'bankrupt', { playerId: 'p3', toPlayerId: 'p1', reason: 'debt' });
    assert.deepEqual(tile(state, 3), { index: 3, ownerId: 'p1', houses: 0, mortgaged: true });
    assert.equal(player(state, 'p1').cash, 1500 + 10 + 5);
    assert.equal(player(state, 'p2').cash, 1490);
    assert.equal(state.status, 'active');
    assert.equal(state.turn.phase, 'end_turn');
    assert.equal(state.turn.order[state.turn.currentIndex], 'p1');
  });

  test('collect_each that bankrupts the last opponent ends the game', () => {
    const s = stackDeck(setPosition(setCash(newGame(), 'p2', 3), 'p1', 10), 'community', [8]);
    const { state, events } = roll(s, 'p1', 3, 4);
    assert.equal(state.status, 'finished');
    assert.equal(state.turn.phase, 'game_over');
    assert.equal(state.winnerId, 'p1');
    assertEvent(events, 'game_over', { winnerId: 'p1' });
  });

  test('repairs charge per house and per hotel', () => {
    let s = give(newGame(), 'p1', 1, { houses: 2 });
    s = give(s, 'p1', 3, { houses: 5 });
    s = give(s, 'p1', 6, { houses: 1 });
    s = stackDeck(setPosition(s, 'p1', 4), 'chance', [11]); // 25/house, 100/hotel
    const { state } = roll(s, 'p1', 1, 2);
    assert.equal(player(state, 'p1').cash, 1500 - (3 * 25 + 1 * 100));
  });

  test('repairs with no buildings cost nothing', () => {
    const s = stackDeck(setPosition(newGame(), 'p1', 4), 'chance', [11]);
    assert.equal(player(roll(s, 'p1', 1, 2).state, 'p1').cash, 1500);
  });
});

describe('free parking pot', () => {
  test('off: taxes go to the bank and free parking pays nothing', () => {
    let s = roll(newGame(), 'p1', 1, 3).state; // Income Tax
    assert.equal(s.pot, 0);
    s = act(s, { type: 'END_TURN', playerId: 'p1' }).state;
    s = roll(setPosition(s, 'p2', 17), 'p2', 1, 2).state; // → 20
    assert.equal(player(s, 'p2').cash, 1500);
  });

  test('on: taxes, card fees and jail fines feed the pot; free parking collects it', () => {
    const settings = { freeParkingPot: true };
    let s = roll(newGame({ settings }), 'p1', 1, 3).state; // Income Tax 200
    assert.equal(s.pot, 200);
    s = act(s, { type: 'END_TURN', playerId: 'p1' }).state;

    s = stackDeck(setPosition(s, 'p2', 4), 'chance', [12]); // speeding fine 15
    s = roll(s, 'p2', 1, 2).state;
    assert.equal(s.pot, 215);
    s = act(s, { type: 'END_TURN', playerId: 'p2' }).state;

    s = jail(s, 'p1');
    s = act(s, { type: 'PAY_JAIL_FINE', playerId: 'p1' }).state;
    assert.equal(s.pot, 265);

    const { state } = roll(s, 'p1', 4, 6); // 10 → 20 Free Parking
    assert.equal(player(state, 'p1').cash, 1500 - 200 - 50 + 265);
    assert.equal(state.pot, 0);
  });

  test('on: rent still goes to the owner, not the pot', () => {
    const s = give(newGame({ settings: { freeParkingPot: true } }), 'p2', 3);
    const { state } = roll(s, 'p1', 1, 2);
    assert.equal(state.pot, 0);
    assert.equal(player(state, 'p2').cash, 1504);
  });
});
