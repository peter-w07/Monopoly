# Interface contract

This file is the single source of truth for how the engine, server and client talk to each
other. Every module is built against it. If code and this file disagree, fix the code — or
change this file deliberately and update every consumer.

Target runtime: **Node 20+** (don't use Node 21+ only APIs such as `Object.groupBy`,
`Promise.withResolvers`, `Set.prototype.union`, `fs.globSync`). Plain JavaScript ES modules.
The only runtime dependency is `ws`.

---

## 1. Static data (`engine/data/*.json`)

`board.json` top level: `goSalary`, `jailFine`, `jailIndex` (10), `goToJailIndex` (30),
`freeParkingIndex` (20), `maxJailTurns` (3), `bankHouses` (32), `bankHotels` (12),
`unmortgageInterest` (0.1), `tokens` (`[{id,label,emoji}]`, 8 pieces), `groups`
(`{groupId:{name,color}}`), `tiles` (40 entries, each `{index, type, name, ...}`, `tiles[i].index === i`).

Tile types: `go`, `property`, `railroad`, `utility`, `tax`, `chance`, `community`, `jail`,
`free_parking`, `go_to_jail`.

- property: `group, price, houseCost, rent[6]` (rent[0] = unimproved, rent[1..4] = 1–4 houses,
  rent[5] = hotel), `mortgage`
- railroad: `price, rent[4]` (rent by number of railroads the owner owns), `mortgage`
- utility: `price, multipliers[2]` (`[4,10]`: dice × 4 if owner has 1 utility, × 10 if 2), `mortgage`
- tax: `amount`

`cards.json`: `{ chance: Card[16], community: Card[16] }`, `Card = { id, text, action }`,
`cards[deck][i].id === i`. Action kinds:

| kind | fields | effect |
|---|---|---|
| `move_to` | `to` | move **forward** to tile `to`; collect GO salary if you pass or land on GO; resolve landing |
| `move_by` | `steps` (negative) | move backward; never collects GO; resolve landing |
| `nearest` | `tileType`, `rentMultiplier?`, `diceMultiplier?` | move forward to next tile of that type (collect GO if passed); if unowned → buy decision; if owned by another & not mortgaged → railroad: normal rent × `rentMultiplier`; utility: roll fresh dice (from RNG, emit `dice_rolled` with `purpose:"utility"`) and pay total × `diceMultiplier` |
| `collect` | `amount` | bank pays player |
| `pay` | `amount` | player pays bank (or pot, see free parking) |
| `jail` | – | go to jail |
| `goojf` | – | player keeps a Get Out of Jail Free card |
| `repairs` | `house`, `hotel` | pay per house / per hotel owned (hotel = `houses === 5`, counts only as a hotel) |
| `pay_each` | `amount` | pay each other non-bankrupt player |
| `collect_each` | `amount` | each other non-bankrupt player pays you |

---

## 2. Engine modules (`/engine`) — pure, no I/O, no `Date.now()`, no `Math.random()`

Loading JSON: use `createRequire(import.meta.url)` and `require('./data/board.json')` (avoids
JSON-module warnings on Node 20). That is the only Node API the engine may use. The loaded
board and card data are deep-frozen.

### `engine/rng.js`  (mulberry32, stateless over `{seed, counter}`)
```js
export function makeRng(seed)            // → { seed: seed >>> 0, counter: 0 }
export function peekFloat(rng, n = rng.counter + 1)  // pure: the float the n-th call will return
export function nextFloat(rng)           // MUTATES rng.counter++ and returns float in [0,1)
export function nextInt(rng, min, max)   // inclusive, via nextFloat: min + Math.floor(f * (max - min + 1))
export function rollDice(rng)            // → [d1, d2], exactly two nextInt(rng,1,6) calls, d1 first
export function shuffle(rng, array)      // → new array, Fisher–Yates from the end: for i=len-1..1: j=nextInt(rng,0,i)
```
The n-th float (1-based) is mulberry32 evaluated with `a = (seed + n * 0x6D2B79F5) | 0`:
```js
function floatAt(seed, n) {
  let a = (seed + Math.imul(n, 0x6D2B79F5)) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
// nextFloat: rng.counter += 1; return floatAt(rng.seed, rng.counter)
```
Every random decision in the engine goes through these functions on `state.rng`, so a saved
state replays identically.

### `engine/board.js`
```js
export const BOARD          // the parsed board.json object
export const TILES          // BOARD.tiles
export const TOKENS         // BOARD.tokens
export function getTile(index)            // static tile data, null for an invalid index
export function isOwnable(index)          // property | railroad | utility
export function groupIndices(group)       // → sorted tile indices of a color group (fresh array; [] if unknown)
export const OWNABLE_INDICES              // sorted indices of all 28 ownable tiles
```

### `engine/cards.js`
```js
export const CARDS                        // parsed cards.json
export function getCard(deck, id)         // deck: "chance" | "community"; null if unknown
export const GOOJF_ID                     // { chance: 8, community: 4 } — derived from data (kind === "goojf")
```

### `engine/state.js`
```js
export const DEFAULT_SETTINGS  // { maxPlayers:6, startingCash:1500, turnTimeoutSec:90, freeParkingPot:false, auctionOnDecline:true, evenBuild:true }
export function normalizeSettings(partial) // merge with defaults + clamp: maxPlayers 2..8, startingCash 100..100000,
                                           // turnTimeoutSec 0 (=off) or 10..3600, booleans coerced; unknown keys dropped
export function createGame({ id = null, seed = 0, settings } = {}) // → fresh lobby state (see §3).
                                           // Deck orders are shuffled here with state.rng (chance first).
```

### `engine/rules.js` (pure helpers, never mutate)
```js
export function getTileState(state, index)          // → state.tiles entry or null
export function getPlayer(state, playerId)
export function currentPlayerId(state)              // state.turn.order[state.turn.currentIndex] (null in lobby)
export function activePlayers(state)                // non-bankrupt players, in turn order (join order in the lobby)
export function ownsFullGroup(state, playerId, group)
export function countOwned(state, playerId, type)   // e.g. railroads owned (mortgaged ones count)
export function rentFor(state, tileIndex, { diceTotal = 0, rentMultiplier = 1, diceMultiplier = null } = {})
       // 0 if unowned or mortgaged. property: houses>0 ? rent[houses] : rent[0] × (owner owns full group ? 2 : 1)
       // railroad: rent[count-1] × rentMultiplier. utility: diceTotal × (diceMultiplier ?? multipliers[count-1])
export function canBuild(state, playerId, tileIndex)     // → { ok:true } | { ok:false, code, message }
export function canSellHouse(state, playerId, tileIndex)
export function canMortgage(state, playerId, tileIndex)
export function canUnmortgage(state, playerId, tileIndex)
export function unmortgageCost(tileIndex)                // mortgage × (1 + unmortgageInterest), rounded up to whole dollars
       // after removing float noise ($100 → $110, not 111; $75 → $83). Always call this; never recompute it
       // (ui.js keeps an identical copy, because the browser can't load /engine).
export function buildingRefund(tileIndex)                // floor(houseCost / 2): refund per building level sold
export function liquidationValue(state, playerId)        // cash + buildingRefund × every building level + mortgage value of
       // every unmortgaged tile. Exact: every level can always be sold (§4.10) and every tile can be mortgaged
       // once its group's buildings are gone.
export function netWorth(state, playerId)                // cash + price of owned (mortgage value if mortgaged) + houseCost of buildings — for UI
export function validateAction(state, action)            // → null if the action would succeed, else { code, message } (§4.1)
export const ACTION_TYPES                                // every action type the engine knows (incl. TIMEOUT)
export function legalActions(state, playerId)            // see §5
// Trading (§4.13)
export function validateTrade(state, fromPlayerId, offer) // offer = { toPlayerId, give, get } → null | { code, message }.
       // Shared by PROPOSE_TRADE and ACCEPT_TRADE; ignores turn and phase. Checks, first failure wins: shape (BAD_PAYLOAD),
       // proposer active (NO_PLAYER), target ≠ proposer (BAD_PAYLOAD), target exists and active (NO_PLAYER), EMPTY_TRADE,
       // NOT_OWNER, HAS_BUILDINGS, INSUFFICIENT_FUNDS, NO_JAIL_CARD (each check: proposer's side first).
export function tradeableTiles(state, playerId)          // → ascending indices of the player's tiles that can be traded now
       // (railroads, utilities, and properties whose colour group has no buildings)
export function tradeFees(state, fromPlayerId, offer)    // → { [fromPlayerId]: n, [toPlayerId]: m }: 10% fees each party pays
       // for the mortgaged tiles it would receive (0 when none)
export function mortgageTransferFee(tileIndex)           // mortgage × unmortgageInterest (10%), rounded up like unmortgageCost ($75 → $8)
export function normalizeTradeSide(side)                 // → { cash, tiles, jailCards } with absent fields filled in (0 / [])
export const MAX_TRADES_PER_TURN                         // 5: PROPOSE_TRADE per turn (TRADE_LIMIT after that, §4.13)
```

### `engine/actions.js`
```js
export function applyAction(state, action) // → { state, events }            on success (state is a NEW object)
                                            // → { state, events: [], error: { code, message } }  on failure (state is the SAME input object, untouched)
```
- Never throws (wrap in try/catch; an unexpected exception returns `{ error: { code: "INTERNAL", message } }` with the untouched input state).
- Never mutates the input: deep-copy the state first, mutate the copy. (The state is plain JSON, so the engine uses a
  small recursive copy; it is ~7× faster than `structuredClone`, which matters to bots and simulations.)
- Reads the action once: validation and the handler share one shallow copy (`{...action}`; for PROPOSE_TRADE the
  `give` / `get` objects and their `tiles` arrays are copied too), so getters or proxies can't make an action validate
  as one thing and run as another.
- Deterministic: same input state + action → deep-equal output.
- Every successful action increments `state.seq` by 1.

### `engine/index.js`
Barrel re-exporting everything above.

---

## 3. State shape

Exactly the spec's shape, plus the documented extensions marked **(ext)**:

```jsonc
{
  "version": 1,
  "id": "g_abc123",
  "createdAt": 0, "updatedAt": 0,           // server sets; engine copies through untouched
  "status": "lobby" | "active" | "finished",
  "seq": 0,                                 // (ext) successful-action counter
  "hostId": null,                           // (ext) first joiner; reassigned to players[0] if host LEAVEs in lobby
  "winnerId": null,                         // (ext) set at game over
  "pot": 0,                                 // (ext) free-parking pot (only used when settings.freeParkingPot)
  "settings": { "maxPlayers": 6, "startingCash": 1500, "turnTimeoutSec": 90,
                "freeParkingPot": false, "auctionOnDecline": true, "evenBuild": true },
  "rng": { "seed": 123456, "counter": 0 },
  "players": [{
    "id": "p_x", "name": "Peter", "token": "car",
    "cash": 1500, "position": 0,
    "inJail": false, "jailTurns": 0, "getOutOfJailCards": 0,
    "jailCards": [],                        // (ext) source deck of each held card: "chance" | "community"; length === getOutOfJailCards
    "bankrupt": false, "connected": true    // connected: maintained by the server
  }],
  "turn": {
    "order": [], "currentIndex": 0,         // currentIndex has no meaning once status is "finished"
    "phase": "lobby",
    "number": 0,                            // (ext) 1 at game start, +1 each time the turn passes
    "doublesCount": 0,
    "rollAgain": false,                     // (ext) true after a doubles roll resolves (player not jailed): must ROLL again, END_TURN rejected
    "lastRoll": null,                       // [d1, d2] of the current player's latest roll this turn; null at turn start
    "pendingPurchase": null,                // tile index
    "pendingDebt": null,                    // { toPlayerId|null, amount, reason, payees?, then? } — see §4.6
                                            //   reason: "rent" | "tax" | "card" | "jail_fine"
    "tradesProposed": 0,                    // (ext) PROPOSE_TRADEs this turn (§4.13 limit); 0 at START_GAME and each
                                            //   END_TURN / turn change. Absent in older saves = 0.
    "deadlineAt": null                      // server sets; engine copies through untouched
  },
  "tiles": [ { "index": 1, "ownerId": null, "houses": 0, "mortgaged": false } ],
                                            // ONLY the 28 ownable tiles, sorted by index. houses: 0-4, 5 = hotel
  "bank": { "houses": 32, "hotels": 12 },
  "decks": { "chance": { "order": [...16 ids], "pos": 0 }, "community": { "order": [...], "pos": 0 } },
  "auction": null,                          // while phase is "auction" (§4.12):
      // { "tileIndex": 21, "highBid": 0, "highBidderId": null,
      //   "bids": [ { "playerId": "p_a", "amount": 10 } ],   // history, oldest first
      //   "participants": ["p_a", "p_b"],                     // non-bankrupt players at the start, in turn order (incl. the decliner)
      //   "passed": ["p_b"] }                                 // participants who dropped out (or resigned)
  "trade": null,                            // while phase is "trading" (§4.13):
      // { "id": "t_42", "fromPlayerId": "p_a", "toPlayerId": "p_b",
      //   "give": { "cash": 100, "tiles": [1, 3], "jailCards": 0 },   // from proposer to target
      //   "get":  { "cash": 0,   "tiles": [39],   "jailCards": 1 },   // from target to proposer
      //   "returnPhase": "end_turn" }                                 // the phase the trade interrupted
  "log": []                                 // human-readable strings, newest last, capped at 100
}
```

Phases (`turn.phase`): `lobby`, `rolling`, `jail_decision`, `buying_or_auction`, `paying`,
`end_turn`, `auction`, `trading`, `game_over`. (`resolving` is internal to a single `applyAction` call and is never
the phase of a returned state.) `phase === "auction"` ⇔ `auction !== null`; `phase === "trading"` ⇔ `trade !== null`.
While trading, `pendingDebt` stays set when `returnPhase` is `paying`; `pendingPurchase` is null in both phases.

Host: `hostId` is the first player to JOIN. If the host LEAVEs the lobby, `hostId` becomes the
new `players[0].id` (or `null` if empty). START_GAME may be sent by the host or — while the host's
`connected === false` — by the first player in join order whose `connected` is true (the stand-in).
`hostId` itself does not change.

Turn order = join order (`turn.order` set at START_GAME). Bankrupt players stay in `order` and
are skipped.

---

## 4. Rules

### 4.1 Actions (all `{ type, playerId, ...payload }`)
Lobby: `JOIN {name, token}` (playerId is supplied by the server), `LEAVE {lobbyOnly?: boolean}`, `START_GAME` (host or stand-in, ≥2 players).
Turn: `ROLL`, `BUY`, `DECLINE`, `END_TURN`. Jail: `PAY_JAIL_FINE`, `USE_JAIL_CARD`.
Money: `PAY_DEBT`, `DECLARE_BANKRUPTCY`. Build: `BUILD|SELL_HOUSE|MORTGAGE|UNMORTGAGE {tileIndex}`.
Auction (4.12): `START_AUCTION`, `BID {amount}`, `PASS_AUCTION`. Trade (4.13): `PROPOSE_TRADE {toPlayerId, give, get}`,
`ACCEPT_TRADE {tradeId?}`, `REJECT_TRADE {tradeId?}`. BID and PASS_AUCTION may come from any participant, ACCEPT/REJECT_TRADE from a trade party —
not only from the current player.
Server-only: `TIMEOUT` (see 4.9). The engine accepts it; the **server** refuses it from clients.

Validation order: known type (`type` must be a string naming an engine action, else `UNKNOWN_ACTION` — so `['ROLL']`
is rejected) → `playerId` a non-empty string (`BAD_PAYLOAD`) → payload shape (`BAD_PAYLOAD`: JOIN name/token strings,
integer `tileIndex`, LEAVE `lobbyOnly` absent or boolean, BID integer `amount`, PROPOSE_TRADE per 4.13, ACCEPT/REJECT_TRADE
`tradeId` absent or a string) → game status →
player exists & not bankrupt → is it this player's turn (where required) → phase → rule checks. First failure wins.
(The auction and trade actions order their checks as listed in 4.12 / 4.13.)

Error codes: `UNKNOWN_ACTION, BAD_PAYLOAD, NOT_IN_LOBBY, GAME_NOT_ACTIVE, NO_PLAYER, ALREADY_JOINED,
GAME_FULL, BAD_NAME, BAD_TOKEN, TOKEN_TAKEN, NOT_HOST, NOT_ENOUGH_PLAYERS, NOT_YOUR_TURN, WRONG_PHASE,
MUST_ROLL_AGAIN, INSUFFICIENT_FUNDS, NO_JAIL_CARD, NOT_IN_JAIL, INVALID_TILE, NOT_OWNER, NOT_MONOPOLY,
MORTGAGED_IN_GROUP, UNEVEN_BUILD, MAX_BUILDINGS, NO_BUILDINGS, BANK_SHORTAGE (BUILD only), HAS_BUILDINGS,
ALREADY_MORTGAGED, NOT_MORTGAGED, AUCTIONS_DISABLED, BID_TOO_LOW, ALREADY_HIGH_BIDDER, ALREADY_PASSED, NOT_PARTICIPANT,
TRADE_PENDING, NO_TRADE, NOT_TRADE_PARTY, EMPTY_TRADE, UNFAIR_TRADE, TRADE_LIMIT, INTERNAL`.

### 4.2 Lobby
- JOIN: status lobby; `playerId` not already present (`ALREADY_JOINED`); name trimmed 1–20 characters (code points) (`BAD_NAME`);
  token must be one of `BOARD.tokens[].id` (`BAD_TOKEN`) and unused (`TOKEN_TAKEN`); players < maxPlayers (`GAME_FULL`).
  Check order: `NOT_IN_LOBBY, ALREADY_JOINED, GAME_FULL, BAD_NAME, BAD_TOKEN, TOKEN_TAKEN` (a full table says so, not "token taken").
  New player: cash = startingCash, position 0, all flags false/0, `jailCards: []`, `connected: true`.
- LEAVE in the lobby (with or without `lobbyOnly`): remove the player (`NO_PLAYER` if not in the game).
  LEAVE after the lobby:
  - `lobbyOnly: true` → `NOT_IN_LOBBY`, state untouched (a "leave the lobby" click that arrives late never resigns).
  - otherwise, while active: **resign**, allowed any time, even off-turn and during an auction or a trade: bankrupt to
    the bank (4.8) — except when the leaver is the current player in `paying` with a single-creditor debt (no `payees`):
    then bankrupt to that creditor, exactly as DECLARE_BANKRUPTCY. In a finished game → `GAME_NOT_ACTIVE`.
    A pending trade or running auction is dealt with around the bankruptcy, in this order:
    1. a pending trade is cancelled (`trade_cancelled {reason:"resigned"}`, phase = `returnPhase`) if the leaver is a
       party to it, or if `returnPhase` is `paying` and part of the proposer's `pendingDebt` is owed to the leaver (4.8
       step 4 is about to change that debt). A third party's resignation otherwise leaves the trade pending;
    2. if the leaver is the current player, a running auction is cancelled (`auction_unsold`, tile unowned, phase
       `end_turn`) before the turn passes on;
    3. the bankruptcy (4.8), using the phase as restored in step 1 (so a proposer who was `paying` goes bankrupt to
       their creditor);
    4. if an auction is still running and the game is not over: the leaver counts as passed (`auction_passed`, if they
       were a participant who hadn't passed); if they had the high bid, `highBid` / `highBidderId` fall back to the
       best (= latest) bid in `bids` by a player who is still in the auction (not bankrupt, not passed), or 0 / null;
       then the auction closes if its end condition (4.12) holds. If the bankruptcy ended the game, the auction is cancelled
       (`auction_unsold`) just before the final `turn_ended`.
- START_GAME: check order `NOT_IN_LOBBY, NO_PLAYER, NOT_HOST` (not the host or the stand-in, §3), `NOT_ENOUGH_PLAYERS` (<2).
  status → active, order = player ids in join order, currentIndex 0, number 1, phase `rolling`. Events `game_started`, `turn_started`.

### 4.3 Rolling & movement
- `rolling`: current player ROLLs. Doubles → `doublesCount++`. Third consecutive doubles → go to jail
  immediately (no move), turn ends (`phase end_turn`, `rollAgain false`).
- Otherwise move forward `d1+d2`. Passing **or landing on** GO pays `goSalary` (once). Then resolve the landing.
- `rollAgain` is set right after a normal roll (`= doubles`) and cleared if the player is sent to jail while resolving.
  It survives `buying_or_auction` / `paying`, so after BUY/DECLINE/PAY_DEBT the player is back in `end_turn` and must roll again.
- After resolution with nothing pending: `phase end_turn`.
- `end_turn`: if `rollAgain` → only ROLL is legal (END_TURN → `MUST_ROLL_AGAIN`); ROLL behaves as in `rolling`
  (doublesCount carries). Otherwise END_TURN passes the turn (ROLL → `WRONG_PHASE`).
- END_TURN: next non-bankrupt player in order; reset `doublesCount 0, rollAgain false, lastRoll null,
  pendingPurchase null, pendingDebt null`; `number++`; phase = `jail_decision` if that player is in jail else `rolling`.
  Events `turn_ended`, `turn_started`.

### 4.4 Landing resolution
- property/railroad/utility, unowned → `pendingPurchase = index`, phase `buying_or_auction` (even if the
  player can't afford it — BUY then fails with INSUFFICIENT_FUNDS; they may MORTGAGE/SELL_HOUSE to raise cash, or DECLINE).
- owned by self → nothing. Owned by another: mortgaged → no rent (log it); else pay `rentFor(...)` to the owner
  (owner collects even while in jail). Utility from a normal roll uses the roll total.
- tax → pay `amount` to the bank (or the pot).
- chance / community → draw (4.5) and apply. A card that moves you resolves the new landing (recursively).
- go_to_jail → go to jail. free_parking → if `settings.freeParkingPot` and `pot > 0`, collect the pot.
- go / jail (just visiting) → nothing.
- BUY: cash ≥ price → owner = player, phase `end_turn`. DECLINE (event `declined`) → if `settings.auctionOnDecline`,
  an auction for the tile starts (4.12); otherwise it stays unowned, phase `end_turn`. Either way `pendingPurchase = null`.

### 4.5 Cards
Draw: `id = decks[d].order[pos]`, `pos++`; when `pos` reaches the end, reshuffle `order` with `shuffle(state.rng, ...)`
and `pos = 0`. Skip (draw again) a GOOJF card that is currently held by any player (`players[].jailCards` includes that deck).
Drawing GOOJF: `getOutOfJailCards++`, `jailCards.push(deck)`. Using one: `getOutOfJailCards--`, remove the first
matching entry — the card becomes drawable again.

### 4.6 Payments and debt
`charge(payer, toPlayerId|null, amount, reason)`: if `cash ≥ amount` pay immediately. Otherwise:
`turn.pendingDebt = { toPlayerId, amount, reason }`, phase `paying`, event `debt_started`.
- Money paid "to the bank" for `tax`, `card` fees (`pay`, `repairs`) and `jail_fine` goes to `state.pot`
  instead when `settings.freeParkingPot` is on. (Log lines still say "to the bank".)
- `pay_each` owed but unaffordable: `pendingDebt = { toPlayerId: null, amount: total, reason: "card", payees: [{playerId, amount}] }`;
  PAY_DEBT pays each payee; bankruptcy on it goes to the bank.
- `collect_each`: each other player who can't pay is auto-liquidated (`autoRaise`, 4.10); if still short they go
  bankrupt to the collector (4.8). No pendingDebt for off-turn players.
- `paying` phase: only the debtor (current player) acts: SELL_HOUSE, MORTGAGE, PAY_DEBT (needs cash ≥ amount),
  DECLARE_BANKRUPTCY, PROPOSE_TRADE (to raise cash: selling is fine, giving away is `UNFAIR_TRADE`; the debt stays pending
  while trading, 4.13) (and LEAVE, 4.2).
  After PAY_DEBT: if `pendingDebt.then` exists run it, else phase `end_turn` (rollAgain preserved).
- `then` is used only for the forced jail fine: `{ kind: "jail_move", steps }` → after paying, move `steps` and resolve.
- A creditor who goes bankrupt (resigns) while owed: see 4.8 step 4 — their share is cancelled.

### 4.7 Jail
Sent to jail (tile 30, card, 3 doubles): position = jailIndex, `inJail true, jailTurns 0`, `doublesCount 0`,
`rollAgain false`, no GO salary, and the turn ends (`phase end_turn` unless a debt is pending — it can't be).
At the start of a jailed player's turn the phase is `jail_decision`:
- PAY_JAIL_FINE (cash ≥ jailFine) → pay, released, phase `rolling` (normal roll, doubles give rollAgain).
- USE_JAIL_CARD → released, phase `rolling`.
- ROLL → doubles: released, move by the total, resolve landing, **no** rollAgain. Not doubles: `jailTurns++`;
  if `jailTurns >= maxJailTurns` → forced fine: charge jailFine (debt with `then: {kind:"jail_move", steps}` if short),
  released, move and resolve; else phase `end_turn`.
Management actions are also allowed in `jail_decision` (extension, see 4.11).

### 4.8 Bankruptcy
Triggered by DECLARE_BANKRUPTCY (paying phase), TIMEOUT when unavoidable, `collect_each`, or LEAVE while active.
Creditor: DECLARE_BANKRUPTCY / TIMEOUT → `pendingDebt.toPlayerId` (null → bank; `payees` debts → bank);
`collect_each` → the collector; LEAVE → bank, unless the leaver is the debtor of a single-player debt (→ that player).
A creditor who is bankrupt (or the debtor) counts as the bank.
1. Sell every building back to the bank for `buildingRefund` per level (hotel = 5 levels); houses/hotels return to
   bank supply. One `sold_house {houses: 0, amount}` per tile.
2. Creditor is a player → they receive all the debtor's cash (after step 1), all properties (mortgage state kept, no
   interest charged), and jail cards. Creditor is the bank → properties become unowned + unmortgaged; jail cards return
   to their decks; cash leaves the game.
3. Debtor: `bankrupt true, cash 0, jailCards [], getOutOfJailCards 0, inJail false, jailTurns 0`. If they were the
   current player: `pendingDebt null, pendingPurchase null`. Event `bankrupt {playerId, toPlayerId, cash, reason}`
   (`reason`: `"resigned"` for LEAVE, else `"debt"`).
4. Then the first of these that applies (else nothing more happens):
   - ≤1 non-bankrupt player remains → events `turn_ended {playerId: current player}` then `game_over`;
     `status finished`, `phase game_over`, `winnerId`, `rollAgain false`, pending purchase/debt cleared.
   - the bankrupt player was the current player → the turn passes to the next player (as END_TURN).
   - it was someone else's turn and that player has a `pendingDebt` owed wholly or partly to the bankrupt player →
     that share is cancelled (nothing goes to the bank or the pot): their `payees` entries are removed and their amounts
     subtracted, or a single-creditor debt to them drops to 0. Event `debt_reduced {playerId: debtor, amount: remaining}`
     (after `bankrupt`). remaining 0 → `pendingDebt null`, then run `then` if present, else phase `end_turn` (rollAgain
     preserved). remaining > 0 → the debtor stays in `paying` and pays with PAY_DEBT (or TIMEOUT); nothing is paid
     automatically.

### 4.9 TIMEOUT `{ type:"TIMEOUT", playerId }` — playerId must be the current player
Emits `{type:"timeout", playerId, phase}` (and the log line "<name> ran out of time.", except in `auction`, where the
clock running out is simply how auctions end) then: `rolling`→ROLL; `jail_decision`→ROLL (never uses a jail card);
`buying_or_auction`→DECLINE (which starts an auction when `auctionOnDecline`); `end_turn`→ rollAgain ? ROLL : END_TURN;
`paying`→ if cash < amount `autoRaise` (4.10), then PAY_DEBT if affordable, else DECLARE_BANKRUPTCY;
`auction`→ the auction ends now (4.12: the high bidder wins, or unsold); `trading`→ the trade is cancelled
(`trade_cancelled {reason:"timeout"}`), the phase goes back to `returnPhase`, and that phase's TIMEOUT action above
follows in the same call (`timeout.phase` is `"trading"`). Other phases → `WRONG_PHASE`.

### 4.10 Building, selling, mortgaging
- BUILD: property owned by actor; owns full group (`NOT_MONOPOLY`); no tile in group mortgaged (`MORTGAGED_IN_GROUP`);
  houses < 5 (`MAX_BUILDINGS`); if `evenBuild`: this tile's houses === min houses in group (`UNEVEN_BUILD`); bank supply:
  0–3→4 needs 1 house, 4→5 (hotel) needs 1 hotel and returns 4 houses to the bank (`BANK_SHORTAGE`); cash ≥ houseCost.
- SELL_HOUSE: houses > 0 (`NO_BUILDINGS`); if `evenBuild`: this tile's houses === max in group (`UNEVEN_BUILD`).
  A house refunds `buildingRefund`. A hotel can always be sold: it breaks into 4 houses, or — when the bank has fewer
  than 4 — into N = `bank.houses` houses (0–3); refund `(5 − N) × buildingRefund`; `bank.hotels += 1`, `bank.houses −= N`.
  So an evenBuild group can end up uneven by more than 1 (e.g. `[5,5,5]` with 4 houses in the bank → `[4,5,5]` →
  `[4,0,5]` → `[4,0,0]`); selling from the max and BUILD on the min bring it back to even.
- MORTGAGE: owned, not mortgaged (`ALREADY_MORTGAGED`), no buildings on any tile of its color group (`HAS_BUILDINGS`); +mortgage value.
- UNMORTGAGE: owned, mortgaged (`NOT_MORTGAGED`), cash ≥ `unmortgageCost`.
- `autoRaise(state, playerId, target)` (internal, deterministic; used by TIMEOUT in `paying` and by off-turn `collect_each`),
  stopping as soon as cash ≥ target:
  0. if `liquidationValue < target`, do nothing (the caller bankrupts the player, so the creditor gets the assets intact);
  1. mortgage unmortgaged tiles whose colour group has no buildings (railroads, utilities, unbuilt lots), ascending index;
  2. sell one building level at a time from the tile with the most buildings (ties → lowest index);
  3. mortgage the remaining unmortgaged tiles, ascending index.

### 4.11 Where management actions are legal
Only the current player, only while status active.
BUILD, UNMORTGAGE: phases `rolling`, `jail_decision`, `end_turn`, `buying_or_auction`.
SELL_HOUSE, MORTGAGE: those phases **and** `paying`.
(Spec says rolling/end_turn; `jail_decision` and `buying_or_auction` are a deliberate extension so a player can raise
cash to pay a jail fine or buy a property.) Never during `auction` or `trading` (`WRONG_PHASE`).

### 4.12 Auctions
An open ascending auction; anyone taking part may bid at any time, not just the current player, who stays the
current player throughout.
- Start: DECLINE in `buying_or_auction` with `settings.auctionOnDecline` (4.4), or `START_AUCTION`, which is identical
  (same state, same events). START_AUCTION checks: game active, player active, current player (`NOT_YOUR_TURN`), phase
  `buying_or_auction` (`WRONG_PHASE`), then `auctionOnDecline` (`AUCTIONS_DISABLED`). State: `pendingPurchase = null`,
  `auction = { tileIndex, highBid: 0, highBidderId: null, bids: [], participants, passed: [] }` with `participants` =
  `activePlayers` (non-bankrupt, in `turn.order` order, the decliner included); phase `auction`. Events `declined`,
  `auction_started {tileIndex, participants}`.
- `BID {amount}` checks, first failure wins: `amount` an integer (`BAD_PAYLOAD`, before the status check) → game active
  (`GAME_NOT_ACTIVE`) → player active (`NO_PLAYER`) → phase `auction` (`WRONG_PHASE`) → in `participants`
  (`NOT_PARTICIPANT`) → not in `passed` (`ALREADY_PASSED`) → not the high bidder (`ALREADY_HIGH_BIDDER`) →
  `amount > highBid` and `amount >= 1` (`BID_TOO_LOW`) → `amount <= cash` (`INSUFFICIENT_FUNDS`; bidding all your cash is
  fine). Effect: `highBid = amount`, `highBidderId = player`, `bids.push({playerId, amount})`; event `auction_bid`.
- `PASS_AUCTION` checks the same chain without the amount (so the high bidder can't pass: `ALREADY_HIGH_BIDDER`).
  Effect: `passed.push(player)`; event `auction_passed`.
- End condition, checked after every BID, PASS_AUCTION and resignation: no participant other than the high bidder is
  still in (i.e. every other participant has passed or is bankrupt). With a high bidder that means everyone else passed;
  without one, everyone passed. (So a bid made when everyone else has already passed wins at once.)
- `TIMEOUT` (current player) in `auction` ends it now, whatever the end condition says.
- Ending: the high bidder pays `highBid` to the bank (never the pot) and owns the tile (unmortgaged, no buildings) →
  `auction_won {playerId, tileIndex, amount}`; no high bidder → `auction_unsold {tileIndex}` and the tile stays unowned.
  `auction = null`, phase `end_turn` (`rollAgain` preserved, so after a doubles roll the player must ROLL next).
- Nothing else is legal during an auction: no turn, management or trade actions for anyone (`WRONG_PHASE`), except
  LEAVE (resign, 4.2) and the server's TIMEOUT.
- Invariants: `highBid === 0` ⇔ `highBidderId === null`; `highBid` ≤ the high bidder's cash (cash can't change during
  an auction); bids by players still in the auction (not passed, not bankrupt) rise strictly, and `highBid` is the latest
  of them (or 0). A player who passed is never the high bidder.

### 4.13 Trading
One pending trade at a time, proposed by the current player on their own turn to one other active player.
- `PROPOSE_TRADE {toPlayerId, give, get}`, `give` = what the proposer hands over, `get` = what the target hands over.
  Shape (`BAD_PAYLOAD`, checked before the game status): `toPlayerId` a string; `give` and `get` plain objects whose
  `cash` and `jailCards` are absent or non-negative integers and whose `tiles` is absent or an array of distinct
  integers that are ownable tile indices. Absent fields mean 0 / `[]` (the stored trade always has all three).
  Then: game active → player active → current player (`NOT_YOUR_TURN`) → no trade pending (`TRADE_PENDING`) → phase
  `rolling`, `jail_decision`, `end_turn` or `paying` (`WRONG_PHASE`) → fewer than `MAX_TRADES_PER_TURN` (5) proposals
  this turn (`TRADE_LIMIT`) → `validateTrade` (§2: target ≠ self `BAD_PAYLOAD`, target exists and active `NO_PLAYER`,
  `EMPTY_TRADE` when both sides are empty, then ownership, buildings, cash, cards) → in `paying` only, the debt rule below
  (`UNFAIR_TRADE`).
  Effect: `trade = { id: "t_" + seq, fromPlayerId, toPlayerId, give, get, returnPhase: <current phase> }` where `seq` is
  the `state.seq` the action was applied to; phase `trading`; `turn.tradesProposed += 1`. Event `trade_proposed`.
- Proposals per turn: at most `MAX_TRADES_PER_TURN` (5), answered or not, so a player can't flood the table (and the log)
  with offer/withdraw cycles. The count is `turn.tradesProposed`, reset when the turn passes.
- Debt rule (`UNFAIR_TRADE`, when proposed from `paying` and checked again on ACCEPT when `returnPhase` is `paying`): a
  debtor may sell but not give anything away, so their assets can't be handed to someone other than their creditor just
  before a bankruptcy. The trade must not lower the proposer's `liquidationValue`: cash received − cash given − the
  proposer's 10% fees + the mortgage value of the unmortgaged tiles received − that of the unmortgaged tiles given ≥ 0.
  Mortgaged tiles and jail cards count as $0 (they raise nothing). Outside a debt any offer is allowed, gifts included.
- Validity (`validateTrade`, on PROPOSE and again on ACCEPT): each side owns the tiles it gives (`NOT_OWNER`); no tile in
  the colour group of any traded property has buildings (`HAS_BUILDINGS`; railroads and utilities are always fine); each
  side has the cash (`INSUFFICIENT_FUNDS`) and the jail cards (`NO_JAIL_CARD`, counted by `getOutOfJailCards`) it gives.
- Mortgaged tiles change hands still mortgaged; the RECEIVER immediately pays the bank (never the pot)
  `mortgageTransferFee` (10% of the mortgage value, rounded up) per mortgaged tile received. ACCEPT fails with
  `INSUFFICIENT_FUNDS` if either side couldn't pay its fees from its cash after the cash exchange (PROPOSE doesn't check
  fees).
- Phase `trading`: the target may `ACCEPT_TRADE` or `REJECT_TRADE`; the proposer may `REJECT_TRADE` (withdraw). Nothing
  else is legal for anyone (`WRONG_PHASE` for turn and management actions) except LEAVE and the server's TIMEOUT.
  ACCEPT / REJECT checks: game active → player active → a trade pending, and when the action carries `tradeId`, it is
  that trade's id (`NO_TRADE` otherwise: the offer the player read was withdrawn or replaced) → ACCEPT: player is the
  target, REJECT: player is either party (`NOT_TRADE_PARTY` otherwise; also for the proposer trying to ACCEPT) → ACCEPT
  only: `validateTrade` again, the debt rule (when `returnPhase` is `paying`), then the fee check. `tradeId` is
  optional; the client always sends it.
- `ACCEPT_TRADE`: cash moves both ways; each traded tile's `ownerId` changes (mortgage state kept); jail cards move
  from the END of the giver's `jailCards` to the end of the receiver's, `getOutOfJailCards` adjusted on both; fees are
  charged; `trade = null`; phase = `returnPhase`. Event `trade_accepted {..., fees}` with `fees = { [fromPlayerId]: n,
  [toPlayerId]: m }` (both keys, 0 when none).
- `REJECT_TRADE`: `trade = null`; phase = `returnPhase`. Event `trade_rejected {tradeId, byPlayerId}`.
- The turn resumes exactly where it was: `turn` is unchanged apart from the phase and `tradesProposed` (a pending debt
  stays pending, `rollAgain` is kept). `TIMEOUT` → 4.9; resignations → 4.2.

Settled here where the auction/trading feature spec left a choice (engine and tests both pin these; real-Monopoly-like
where it matters):
- BID: `ALREADY_HIGH_BIDDER` is checked before the amount; an integer below 1 is `BID_TOO_LOW` (a non-integer `BAD_PAYLOAD`).
- A resigned high bidder's bid falls back only to a bid by a player still in the auction. A player who passed dropped out
  and is never made to buy (so their old bid no longer counts, and a later bid may be lower than it).
- The auction price and the mortgage-transfer fee go to the bank, never to the free-parking pot.
- PROPOSE_TRADE: to yourself, or a non-string `toPlayerId` → `BAD_PAYLOAD`; an unknown or bankrupt target → `NO_PLAYER`;
  non-ownable or repeated tile indices → `BAD_PAYLOAD`; a second proposal → `TRADE_PENDING` (checked before the phase).
- ACCEPT_TRADE / REJECT_TRADE with no trade pending, or naming another trade (`tradeId`) → `NO_TRADE` for anyone (on or
  off turn); the proposer trying to ACCEPT → `NOT_TRADE_PARTY`.
- Gifts are allowed outside a debt (official rules allow a sale "for any amount"), so a player about to resign can still
  give their things away; only the debtor's gift to someone other than the creditor is blocked (debt rule above).
- `trade.id` = `"t_" + seq` of the state the proposal was applied to; `trade_accepted.fees` always has both keys.
- A third player's resignation leaves a pending trade alone, as at a real table, unless the proposer is paying a debt
  partly owed to the leaver (4.2 step 1).
- `START_AUCTION` is listed wherever it would succeed, alongside DECLINE (same effect).

---

## 5. `legalActions(state, playerId)`
```js
→ { actions: string[], build: number[], sellHouse: number[], mortgage: number[], unmortgage: number[],
    auction: { minBid, maxBid } | null, tradeTargets: string[] }
```
`actions` lists action types (other than the four management ones) that would **succeed right now** for this
player — any player, not only the current one (BID / PASS_AUCTION for auction participants, ACCEPT / REJECT_TRADE for
trade parties). The management arrays list tile indices (ascending) for which that action would succeed. `playerId`
may be null (spectator): lobby with room → `["JOIN"]`, else empty (`auction: null`, `tradeTargets: []`). TIMEOUT is
never listed.
- `BID` is listed, and `auction` is `{ minBid: highBid + 1, maxBid: player's cash }`, when a bid of `minBid` would
  succeed; then every integer amount in that range succeeds. Otherwise `auction` is null.
- `PROPOSE_TRADE` is listed when the player may open a trade at all (game active, their turn, no trade pending, a
  proposing phase, proposals left this turn); `tradeTargets` then lists every other active player (in turn order), else
  it is empty. Whether a particular offer is valid is only known on send (`validateTrade`, and in `paying` the debt rule).
- `ACCEPT_TRADE` is listed for the target only if accepting would succeed right now (including the fee check);
  `REJECT_TRADE` for both parties. `START_AUCTION` is listed wherever it would succeed (alongside DECLINE).
Invariant (tested by the simulator): every listed action succeeds when applied (BID at `minBid` and `maxBid`,
PROPOSE_TRADE with a valid offer to each target); unlisted actions fail.
It gives the same result on the public state (§7: no `rng`, decks reduced to `{size}`), so clients may call it.
`START_GAME` depends on `players[].connected` (§3 stand-in); the server broadcasts every connection change, so the
list stays current.

---

## 6. Events (`applyAction` → `events[]`) — presentation only, state is the truth
```
player_joined {playerId, name, token}        player_left {playerId}
game_started {order}                         turn_started {playerId, turnNumber}      turn_ended {playerId}
dice_rolled {playerId, dice:[d1,d2], doubles, purpose:"move"|"jail"|"utility"}
moved {playerId, from, to, steps, via:"roll"|"card"|"jail"}   // steps: signed count for walks, null for teleports
passed_go {playerId, amount}                 landed {playerId, tileIndex}
bought {playerId, tileIndex, price}          declined {playerId, tileIndex}
paid_rent {playerId, ownerId, tileIndex, amount}
paid_tax {playerId, tileIndex, amount}
paid {playerId, toPlayerId, amount, reason}  collected {playerId, fromPlayerId, amount, reason}
                                             // paid reasons: "card", "jail_fine"; collected: "card", "free_parking"
card_drawn {playerId, deck, cardId, text}    jail_card_received {playerId, deck}
sent_to_jail {playerId, reason:"tile"|"card"|"doubles"}      // followed by moved {via:"jail"}
left_jail {playerId, method:"fine"|"card"|"doubles"|"forced_fine"}
jail_roll_failed {playerId, attempt}
built {playerId, tileIndex, houses}
sold_house {playerId, tileIndex, houses, amount}   // houses left; amount = refund (several levels for a
                                                   // shortage hotel sale or the bankruptcy sell-off)
mortgaged {playerId, tileIndex, amount}      unmortgaged {playerId, tileIndex, amount}
debt_started {playerId, toPlayerId, amount, reason}
debt_paid {playerId, toPlayerId, amount, reason, payees?}    // payees: [{playerId, amount}] for pay_each debts
debt_reduced {playerId, amount}                    // a creditor went bankrupt; amount = what is still owed (4.8)
bankrupt {playerId, toPlayerId, cash, reason}      // cash = after the building sale; goes to the creditor or leaves the game
                                                   // reason: "resigned" (LEAVE) | "debt"
game_over {winnerId}
timeout {playerId, phase}                          // always the first event of a TIMEOUT
auction_started {tileIndex, participants}          auction_bid {playerId, amount}      auction_passed {playerId}
auction_won {playerId, tileIndex, amount}          auction_unsold {tileIndex}          // amount paid to the bank
trade_proposed {tradeId, fromPlayerId, toPlayerId, give, get}
trade_accepted {tradeId, fromPlayerId, toPlayerId, give, get, fees}   // fees: { [playerId]: amount } for both parties
trade_rejected {tradeId, byPlayerId}               trade_cancelled {tradeId, reason:"timeout"|"resigned"}
```
Ordering notes: every `turn_started` gets a `turn_ended`; a game-over batch ends `[..., turn_ended, game_over]`.
Every `auction_started` gets exactly one `auction_won` or `auction_unsold` (a cancelled auction is `auction_unsold`,
emitted before the `turn_ended` of the turn that passes or ends). Every `trade_proposed` gets exactly one
`trade_accepted`, `trade_rejected` or `trade_cancelled`. A DECLINE / START_AUCTION batch is `[declined, auction_started]`.
Cash in `give` / `get` and `fees` is part of `trade_accepted`; there are no separate `paid` events for it.
When a forced jail fine is paid later (PAY_DEBT or TIMEOUT in `paying`), that batch has `left_jail {method:"forced_fine"}`
and `moved {via:"roll"}` but no `dice_rolled`; the dice are in `state.turn.lastRoll`.

Server-added (not from the engine): `connection {playerId, connected}`.

---

## 7. Server ↔ client protocol (JSON over WebSocket at `/ws`)
Client → server:
- `{ t:"hello", gameId, playerId?, token? }` — first message. Valid playerId+token → seat resumed (`welcome`
  then `state`). Missing/invalid credentials → spectator (`state` only; plus `error` code `BAD_TOKEN` if a token was sent).
  Unknown game → `error` code `NO_GAME`.
  - Re-sending hello for the seat this socket already holds (valid token), or as a spectator with no credentials,
    just gets `state` again: no `welcome`, no `connection` broadcast.
  - At most one hello per socket per second is processed; extra ones are ignored, with at most one error `HELLO_RATE` per second.
  - A socket must attach (as seat or spectator) within 10 s of connecting, or it is closed with code **1008**.
  - At most 20 spectators per room: a further spectator hello gets error `ROOM_BUSY` and the socket stays unattached
    (its actions then get `NO_GAME`). This also blocks visitors who want to JOIN, since they attach as spectators first.
  - After `NO_GAME` or `ROOM_BUSY` the socket is useless (a never-attached one is closed at the 10 s hello deadline).
    Clients must not reconnect after `NO_GAME` and must not retry `ROOM_BUSY` in a loop.
- `{ t:"action", seq?, action:{ type, ...payload } }` — the server sets `action.playerId` from the socket's seat and ignores
  any client value. `type` must be a non-empty string of ≤ 40 chars (`BAD_MESSAGE`). If `seq` is a number and differs from
  the current `state.seq`, the reply is error `STALE_STATE` ("The game moved on — try again") and nothing is applied;
  without `seq`, no check. Exception, because bids race each other: for `BID` and `PASS_AUCTION` any `seq` from the
  running auction (≥ the `seq` of the state in which it started, ≤ the current one) passes, and the engine judges the
  action against the current state (a bid that was overtaken gets `BID_TOO_LOW`); a `seq` from before the auction is
  still `STALE_STATE`, so a late bid never lands in a later auction. `JOIN` from a seatless socket: error
  `ALREADY_SEATED` if this socket already created a seat in this game that still exists; else the server creates
  `playerId` (`p_` + 8 chars of the game-id alphabet) and a secret `token` (32 hex), applies JOIN, binds the socket, sends
  `welcome`, then broadcasts `state`. Other actions from a seatless socket → `NOT_SEATED`. `TIMEOUT` from a client →
  `FORBIDDEN`. Engine errors are forwarded as `{code, message}` (§4.1).
- `{ t:"ping" }` → `{ t:"pong" }` (app-level keepalive).
- The server handles a socket's messages one at a time, in order, and sends everything a message causes (its `error`,
  or the `state` broadcast of the change it made) before it reads the next one. So a `ping` sent right after an action
  is answered after that action's result, even when other players' moves arrive in between (scripts/bot-client.js
  settles its actions this way).

Server → client:
- `{ t:"welcome", gameId, playerId, token }`
- `{ t:"state", state, events, legal, now }` — `state` is the **public** state: `rng` removed and `decks` replaced by
  `{ chance:{ size }, community:{ size } }` (hides future dice/cards). `legal` = `legalActions(state, thisSocketsPlayerId)`.
  `now` = server `Date.now()` for countdown clock-skew correction. Sent to every socket in the room after every change,
  including connection changes (events `[connection]`, `seq` unchanged). Clients must not dedupe frames by `seq`: it
  repeats on connection frames and re-hellos, and after a hard kill the restored game reuses seq numbers.
- `{ t:"error", code, message }`

Server error codes (besides the engine's, §4.1): `NO_GAME, BAD_TOKEN, REPLACED, NOT_SEATED, FORBIDDEN, BAD_MESSAGE,
BAD_JSON, SHUTTING_DOWN, INTERNAL, HELLO_RATE, RATE_LIMITED, ROOM_BUSY, ALREADY_SEATED, STALE_STATE`.

One socket per seat: if a seat is resumed from a second socket, the server sends the old socket
`{t:"error", code:"REPLACED"}` and closes it with WebSocket close code **4000**; anything the old socket still sends is
ignored. Clients must NOT auto-reconnect after 4000/REPLACED (prevents two tabs fighting); show "Opened in another
tab — [Use here]" instead. Other close codes: **1012** graceful shutdown (reconnect with backoff as usual); **1008**
policy close (no hello within 10 s, or flooding); **1006** after the server terminates a socket that missed a protocol
ping (sent every 30 s, so a dead socket goes within 30–60 s) or has more than 2 MiB of unsent data.

Limits (defaults; each has an env override in `server/limits.js`, 0 = off):
- Messages: 50/s per socket with a burst of 100 (pings count). Excess messages are dropped, with at most one error
  `RATE_LIMITED` per second; more than 500 drops within 10 s closes the socket (1008).
- WebSocket upgrade: refused with a plain HTTP `429` JSON `{error}` + `Retry-After: 1` when the client IP has 30 open
  sockets or exceeds 20 upgrades per burst, then 1/s; `503` when the server has 2000 sockets. Upgrades on any path other
  than `/ws`, or during shutdown, are dropped.
- Client IP = the TCP peer, or the rightmost `X-Forwarded-For` entry when the peer is loopback/private (`TRUST_PROXY=auto`;
  `1` = always trust the header, `0` = never).

HTTP (`GET` routes also answer `HEAD`; wrong methods → `405` with `Allow`; unknown `/api/*` → `404` JSON):
- `GET /health` → `200 {"ok":true,"games":<n>,"uptime":<s>}`
- `POST /api/games` body `{settings?}` (≤ 16 KB) → `201 {"gameId"}`. `400 {error}` malformed JSON / body not an object /
  settings not an object; `413` body too large; `429 {error}` + `Retry-After` (seconds) beyond 10 games per burst, then
  5/min per client IP; `503 {error}` while shutting down, or at 1000 games when no idle game can be evicted (§9).
- `GET /api/games` → `{"games":[{id, players, maxPlayers, hostName, createdAt}]}` — open lobbies only: not full, ≥1 player
  and ≥1 connected seated player; newest first, at most 100.
- `GET /api/games/:id` → `{id, status, players:[{id, name, token, connected, bankrupt}], settings, createdAt}` or 404
  (`token` here is the game piece, never the secret). A finished game answers for about a minute, then 404.
- `GET /api/board` → board.json contents (client uses it for names/colors/prices/tokens)
- Everything else: static files from `/public` (`/` → `index.html`), no directory traversal or dot-files, correct content
  types, `Cache-Control: no-cache`.

Game ids: `g_` + 6 chars from `abcdefghjkmnpqrstuvwxyz23456789` (never reusing an id in `games/` or `finished/`). The
"join code" shown to users is the 6 chars (accept with or without `g_`, any case).

---

## 8. Client ownership rules
- `public/renderer-switch.js` is the board module `ui.js` imports (one line:
  `import { render as renderBoard, busyUntil as boardBusyUntil } from './renderer-switch.js'`). It exports
  `render(state, events, myPlayerId)` (the renderer contract below) plus `busyUntil()` (the `Date.now()` ms at which the
  board's running animation lands; 0 when idle or in 2D — ui.js holds dialogs until then), `getMode()`,
  `setMode('2d'|'3d', {persist})`, `onModeChange(cb)` and `setBoardToggle(visible)`. It hands `#board` to exactly one
  renderer at a time and draws a small 2D|3D toggle inside `#board`. `localStorage["monopoly.renderer"]` = `'2d'|'3d'`
  (default `'2d'`; `?renderer=3d` forces 3D for one page load). If 3D can't run (no WebGL2, start failure, lost GPU
  context) it shows 2D for that page without changing the saved choice.
- Renderers — `public/renderer2d.js` (DOM, `renderer2d.css`) and `public/renderer3d.js` (Three.js; pieces in
  `public/r3d/`, styles in `public/r3d/r3d.css`, three r186 vendored in `public/vendor/three/`, downloaded only when 3D is
  chosen) — each export `render(state, events, myPlayerId)` and `dispose()` (renderer3d also `busyUntil()`), own
  everything inside `<div id="board">` while active, fetch `/api/board` themselves and inject their own stylesheet. No
  other module touches the board DOM; `ui.js` ignores clicks inside `#board`.
- renderer2d specifics: a tile info card (tap/click a tile); to close it, document-level `click` (capture) and `keydown`
  (Escape) listeners and a window `resize` listener. On boards ≤ 480px wide, tiles show short labels
  (`.r2d-name-full` / `.r2d-name-short`).
- `public/ui.js` owns everything outside `#board`: screens, side panel, buttons (driven by `legal`), dialogs, countdown.
  - `index.html` panel slots owned by ui.js: `#panel-dialog` (buy / debt / jail / trade / game-over details on narrow
    layouts, above `#action-bar`), `#recent-log` (last 5 log lines on narrow layouts) and `#auction-sheet` (the running
    auction, for everyone at the table on every layout: deed, high bid, clock, quick bids / own amount / pass from
    `legal`, read-only for spectators). At ≤ 899px `#dialog-layer` is unused. There, when an auction starts and the
    player can bid or pass, the sheet is scrolled into view (instead of the "up for auction" toast, which would cover it).
  - Quick bids (+$1 / +$10 / +$50 / +$100 over the high bid) keep fixed slots: a step the bidder can't afford stays in
    its slot, disabled (never turned into "all in"); the bid box's Max button fills in all their cash, and Bid sends it.
    Whenever the high bid changes, the quick bids ignore clicks for 700 ms, so a click aimed at the old amount can't bid
    the new one.
  - Trading: "Trade" (when `legal.actions` has PROPOSE_TRADE) opens a builder dialog (target from `legal.tradeTargets`,
    tradeable tiles, cash, jail cards, the 10% fees) that refuses to send an offer `validateTrade` or the ACCEPT fee check
    would reject (in debt, also the debt rule's `UNFAIR_TRADE`). The target gets the offer as a dialog (Accept only when
    legal, and not until the offer has been on screen for 1 s, so an offer swapped in at the last moment isn't accepted
    by a click meant for the one before; the dialog says which colour sets the trade completes), the proposer can
    withdraw (REJECT_TRADE), everyone else sees it in the banner and action bar. ACCEPT_TRADE / REJECT_TRADE carry the
    `tradeId` of the offer on screen. Accept / Reject never receive focus automatically, and a focus remembered from an
    earlier offer never lands on a new offer's buttons. A BID / PASS_AUCTION refused because someone was quicker
    (`BID_TOO_LOW`, `ALREADY_*`, the auction just ended) gets a mild info toast, not an error.
  - Debt: once the player has the cash to pay, the banner says so and Declare bankruptcy is not offered (Resign still is).
  - The create form's settings: starting cash, turn timer, max players, Free Parking pot, build evenly, auctions
    (`auctionOnDecline`); the lobby lists all six.
  - After `POST /api/games` the creating tab joins the new lobby automatically (JOIN with the home-screen name and the
    first free token), so the creator becomes host. With no name it focuses the lobby's join form instead.
  - "Start game" is shown to any seated player whose `legal.actions` includes START_GAME (e.g. the stand-in).
  - The lobby's Leave sends `LEAVE {lobbyOnly:true}`; the in-game Resign sends a plain `LEAVE`.
  - Actions are sent with `seq` = the `state.seq` they were chosen from, except JOIN, LEAVE and START_GAME.
    `STALE_STATE` → mild info toast ("Too late — the game moved on."); `NOT_IN_LOBBY` → "The game has already started."
    `NO_GAME` → back to home (a finished game instead keeps its final table and closes the socket); `ROOM_BUSY` → back
    to home with a toast. Both close the connection, so neither loops.
  - A mouse or touch click on an action button drops focus from it, so Space/Enter keep meaning roll / end turn;
    keyboard activations keep focus on the same control across re-renders.
- `public/net.js` owns the socket: `connectGame(gameId, handlers)` → `{ send(action, seq?), reconnect(), close() }`.
  Reconnect with exponential backoff (0.5 s base, 15 s cap) + full random jitter, hello with stored credentials. Every
  connect, hello and ping (every 25 s) must be answered within 10 s or the socket is replaced. On `visibilitychange`
  (visible) and window `online` it reconnects at once if the socket isn't open or has been silent for more than 30 s.
- Player colors (renderer and UI must agree): by index in `state.players`, palette
  `#e74c3c, #3498db, #2ecc71, #f1c40f, #9b59b6, #e67e22, #1abc9c, #e84393`.
- `public/boarddata.js` (shared tiny module) → `export const BOARD = await fetch('/api/board').then(r => r.json())`.
- Seats and tabs (so 2+ tabs in one browser can play as different players):
  - `sessionStorage["monopoly.seat.<gameId>"] = { playerId, token, replaced? }` — this tab's seat; auto-resumed on reload.
    `replaced: true` marks a seat another tab took over: reloading this tab then offers a takeover instead of taking it back.
  - `localStorage["monopoly.sessions"] = { [gameId]: { playerId, token, name } }` — remembered across tabs/restarts.
  - Opening a game with no seat in sessionStorage: `GET /api/games/:id`; if a remembered localStorage seat for this game
    exists and that player is **not** connected → resume it automatically (copy into sessionStorage). If that player **is**
    connected (another tab has it) → act as a new visitor (join form in lobby / spectator in game) and offer a small
    "Take over <name>'s seat" link.
  - `localStorage["monopoly.name"]` = last used display name.
- URL: `/?game=<gameId>` opens that game (lobby or table). The page updates the URL with `history.replaceState`.

---

## 9. Server: turn timers, persistence, room lifecycle
Turn timer (`server/timers.js`), only while status active, `turnTimeoutSec > 0` and at least one player is connected:
- The deadline (`turn.deadlineAt`) restarts at `now + turnTimeoutSec` (or `now + 45 s` if sooner while the current
  player is offline) whenever the turn key
  `status|number|currentPlayer|phase|rollAgain|doublesCount` changes (so every doubles roll re-arms it) and after every
  TIMEOUT. Management actions (BUILD, MORTGAGE, …) don't restart it.
- Current player disconnected: deadline = min(existing, now + 45 s); if they return before it expires, the rest of their
  turn time is restored. Nobody connected: timer paused (`deadlineAt null`); the first player back gets a fresh deadline.
- On expiry the server applies `TIMEOUT` (4.9); a failed TIMEOUT is retried every 5 s, 3 times.
- With `turnTimeoutSec 0` nothing is auto-played, even for a disconnected player — except auctions (below).
- Auctions are ALWAYS timed, independent of `turnTimeoutSec` and of who is connected: `deadlineAt = now + 10 s`
  when the auction starts and after every bid (the timer key includes `auction.tileIndex` and `auction.bids.length`;
  passes do NOT reset the clock) — but never later than 120 s after the auction started (`AUCTION_MAX_MS`), so two
  players raising each other by $1 can't hold the table. Disconnected participants — the current player included — are not waited for and
  get no 45 s grace: the 10 s clock simply runs out, and TIMEOUT (current player) ends the auction. Like the turn timer
  it pauses only while nobody at all is connected (e.g. right after a restart), and the first player back gets a fresh
  10 s (and a fresh 120 s limit) — so a restart mid-auction doesn't close it before anyone could reconnect.
- While `trading`, the timer key uses the trade's `returnPhase` instead of `trading`, so proposing (and rejecting)
  trades never refreshes the proposer's turn deadline; when it expires, TIMEOUT cancels the trade and times out the
  underlying phase (4.9).

Persistence (`server/persist.js`), under `DATA_DIR`:
- `games/<id>.json` = `{ version: 1, state /* full private state incl. rng + decks */, secrets: { [playerId]: token } }`,
  written atomically (`<id>.json.tmp`, fsync, rename). `finished/<id>.json` (game over), `abandoned/<id>.json` (active,
  nobody connected for 7 days, or evicted; never reloaded), `corrupt/<name>.<timestamp>` (unreadable or malformed saves
  moved aside at startup), `instance.lock` (`{hostname, pid, startedAt}`, mtime refreshed every 10 s).
- Saved immediately after `player_joined`, `player_left`, `game_started`, `turn_ended` and `game_over`; otherwise at most
  5 s after the first unsaved change. `connected` changes alone are not saved. A failed save is retried every 5 s.
- Startup: refuse to start (exit 1) if another live instance holds `instance.lock` (fresh mtime < 30 s and a different
  host, or a live different pid on this host). Load every `games/*.json`; mark all players disconnected, clear
  `deadlineAt`; a finished game found there is moved to `finished/`.
- Shutdown (SIGTERM/SIGINT, or IPC message `"shutdown"` when started with an IPC channel): refuse new games, upgrades and
  messages (`SHUTTING_DOWN`), stop timers, flush every dirty game (2 retries, 200 ms apart), close sockets with 1012,
  release the lock, exit 0 — or exit 1 after logging `[rooms] FAILED to save: <ids>`. Forced exit (1) after 10 s.

Room lifecycle (maintenance every minute; a room's idle clock stops only while a seated player is connected —
spectators don't count; restored rooms continue from `state.updatedAt` and get a 5-minute startup grace):
- Lobby idle 30 min (0-player lobbies included) → deleted from memory and disk.
- Active game idle 7 days → moved to `abandoned/`.
- Game over → file moved to `finished/`; the room stays in memory ~60 s so clients see the end.
- At 1000 rooms, creating a game first evicts the longest-idle unattended room (idle ≥ 1 h; 0-player lobbies ≥ 1 min):
  lobbies are deleted, active games moved to `abandoned/`; `503` only when nothing is evictable.
