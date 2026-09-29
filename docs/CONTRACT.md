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
export const ACTION_TYPES                                // every action type the engine knows (incl. stubs and TIMEOUT)
export function legalActions(state, playerId)            // see §5
```

### `engine/actions.js`
```js
export function applyAction(state, action) // → { state, events }            on success (state is a NEW object)
                                            // → { state, events: [], error: { code, message } }  on failure (state is the SAME input object, untouched)
```
- Never throws (wrap in try/catch; an unexpected exception returns `{ error: { code: "INTERNAL", message } }` with the untouched input state).
- Never mutates the input: deep-copy the state first, mutate the copy. (The state is plain JSON, so the engine uses a
  small recursive copy; it is ~7× faster than `structuredClone`, which matters to bots and simulations.)
- Reads the action once: validation and the handler share one shallow copy (`{...action}`), so getters or proxies
  can't make an action validate as one thing and run as another.
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
    "deadlineAt": null                      // server sets; engine copies through untouched
  },
  "tiles": [ { "index": 1, "ownerId": null, "houses": 0, "mortgaged": false } ],
                                            // ONLY the 28 ownable tiles, sorted by index. houses: 0-4, 5 = hotel
  "bank": { "houses": 32, "hotels": 12 },
  "decks": { "chance": { "order": [...16 ids], "pos": 0 }, "community": { "order": [...], "pos": 0 } },
  "auction": null, "trade": null,           // stubs
  "log": []                                 // human-readable strings, newest last, capped at 100
}
```

Phases (`turn.phase`): `lobby`, `rolling`, `jail_decision`, `buying_or_auction`, `paying`,
`end_turn`, `game_over`. (`resolving` is internal to a single `applyAction` call and is never
the phase of a returned state. `auction` / `trading` are reserved, unused.)

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
Stubs → error `NOT_IMPLEMENTED` (after checking game is active): `START_AUCTION, BID, PROPOSE_TRADE, ACCEPT_TRADE, REJECT_TRADE`.
Server-only: `TIMEOUT` (see 4.9). The engine accepts it; the **server** refuses it from clients.

Validation order: known type (`type` must be a string naming an engine action, else `UNKNOWN_ACTION` — so `['ROLL']`
is rejected) → `playerId` a non-empty string (`BAD_PAYLOAD`) → payload shape (`BAD_PAYLOAD`: JOIN name/token strings,
integer `tileIndex`, LEAVE `lobbyOnly` absent or boolean) → game status → player exists & not bankrupt → is it this
player's turn (where required) → phase → rule checks. First failure wins.

Error codes: `UNKNOWN_ACTION, BAD_PAYLOAD, NOT_IN_LOBBY, GAME_NOT_ACTIVE, NO_PLAYER, ALREADY_JOINED,
GAME_FULL, BAD_NAME, BAD_TOKEN, TOKEN_TAKEN, NOT_HOST, NOT_ENOUGH_PLAYERS, NOT_YOUR_TURN, WRONG_PHASE,
MUST_ROLL_AGAIN, INSUFFICIENT_FUNDS, NO_JAIL_CARD, NOT_IN_JAIL, INVALID_TILE, NOT_OWNER, NOT_MONOPOLY,
MORTGAGED_IN_GROUP, UNEVEN_BUILD, MAX_BUILDINGS, NO_BUILDINGS, BANK_SHORTAGE (BUILD only), HAS_BUILDINGS,
ALREADY_MORTGAGED, NOT_MORTGAGED, NOT_IMPLEMENTED, INTERNAL`.

### 4.2 Lobby
- JOIN: status lobby; `playerId` not already present (`ALREADY_JOINED`); name trimmed 1–20 characters (code points) (`BAD_NAME`);
  token must be one of `BOARD.tokens[].id` (`BAD_TOKEN`) and unused (`TOKEN_TAKEN`); players < maxPlayers (`GAME_FULL`).
  Check order: `NOT_IN_LOBBY, ALREADY_JOINED, GAME_FULL, BAD_NAME, BAD_TOKEN, TOKEN_TAKEN` (a full table says so, not "token taken").
  New player: cash = startingCash, position 0, all flags false/0, `jailCards: []`, `connected: true`.
- LEAVE in the lobby (with or without `lobbyOnly`): remove the player (`NO_PLAYER` if not in the game).
  LEAVE after the lobby:
  - `lobbyOnly: true` → `NOT_IN_LOBBY`, state untouched (a "leave the lobby" click that arrives late never resigns).
  - otherwise, while active: **resign**, allowed any time, even off-turn: bankrupt to the bank (4.8) — except when the
    leaver is the current player in `paying` with a single-creditor debt (no `payees`): then bankrupt to that creditor,
    exactly as DECLARE_BANKRUPTCY. In a finished game → `GAME_NOT_ACTIVE`.
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
- BUY: cash ≥ price → owner = player, phase `end_turn`. DECLINE → stays unowned, phase `end_turn`
  (log "auctions are not implemented yet" when `auctionOnDecline`).

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
  DECLARE_BANKRUPTCY (and LEAVE, 4.2). After PAY_DEBT: if `pendingDebt.then` exists run it, else phase `end_turn` (rollAgain preserved).
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
   current player: `pendingDebt null, pendingPurchase null`. Event `bankrupt {playerId, toPlayerId, cash}`.
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
Emits `{type:"timeout", playerId, phase}` then: `rolling`→ROLL; `jail_decision`→ROLL (never uses a jail card);
`buying_or_auction`→DECLINE; `end_turn`→ rollAgain ? ROLL : END_TURN; `paying`→ if cash < amount `autoRaise` (4.10),
then PAY_DEBT if affordable, else DECLARE_BANKRUPTCY. Other phases → `WRONG_PHASE`.

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
cash to pay a jail fine or buy a property.)

---

## 5. `legalActions(state, playerId)`
```js
→ { actions: string[], build: number[], sellHouse: number[], mortgage: number[], unmortgage: number[] }
```
`actions` lists action types (other than the four management ones) that would **succeed right now** for this
player. The management arrays list tile indices (ascending) for which that action would succeed. `playerId` may be null
(spectator): lobby with room → `["JOIN"]`, else empty. Stub and TIMEOUT actions are never listed.
Invariant (tested by the simulator): every listed action succeeds when applied; unlisted turn actions fail.
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
bankrupt {playerId, toPlayerId, cash}              // cash = after the building sale; goes to the creditor or leaves the game
game_over {winnerId}
timeout {playerId, phase}                          // always the first event of a TIMEOUT
```
Ordering notes: every `turn_started` gets a `turn_ended`; a game-over batch ends `[..., turn_ended, game_over]`.
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
  without `seq`, no check. `JOIN` from a seatless socket: error `ALREADY_SEATED` if this socket already created a seat in
  this game that still exists; else the server creates `playerId` (`p_` + 8 chars of the game-id alphabet) and a secret
  `token` (32 hex), applies JOIN, binds the socket, sends `welcome`, then broadcasts `state`. Other actions from a seatless
  socket → `NOT_SEATED`. `TIMEOUT` from a client → `FORBIDDEN`. Engine errors are forwarded as `{code, message}` (§4.1).
- `{ t:"ping" }` → `{ t:"pong" }` (app-level keepalive).

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
- `public/renderer2d.js` exports **only** `render(state, events, myPlayerId)`. It is the only file that touches the
  board DOM: everything inside `<div id="board">`, including a tile info card (tap/click a tile). It fetches `/api/board`
  itself (top-level await) and injects its own stylesheet `public/renderer2d.css`. To close the info card it registers
  document-level `click` (capture) and `keydown` (Escape) listeners and a window `resize` listener. On boards ≤ 480px wide,
  tiles show short labels (`.r2d-name-full` / `.r2d-name-short`). `ui.js` imports it in one place
  (`import { render as renderBoard } from './renderer2d.js'`) and ignores clicks inside `#board`; swapping in another
  renderer (e.g. Three.js) means replacing this module or that one import, nothing else.
- `public/ui.js` owns everything outside `#board`: screens, side panel, buttons (driven by `legal`), dialogs, countdown.
  - `index.html` panel slots owned by ui.js: `#panel-dialog` (buy / debt / jail / game-over details on narrow layouts,
    above `#action-bar`) and `#recent-log` (last 5 log lines on narrow layouts). At ≤ 899px `#dialog-layer` is unused.
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
- With `turnTimeoutSec 0` nothing is auto-played, even for a disconnected player.

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
