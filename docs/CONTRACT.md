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
`unmortgageInterest` (0.1), `tokens` (`[{id,label,emoji}]`), `groups`
(`{groupId:{name,color}}`), `tiles` (40 entries, `tiles[i].index === i`).

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
JSON-module warnings on Node 20). That is the only Node API the engine may use.

### `engine/rng.js`  (mulberry32, stateless over `{seed, counter}`)
```js
export function makeRng(seed)            // → { seed: seed >>> 0, counter: 0 }
export function peekFloat(rng, n)        // pure: the float the n-th call will return (n = counter+1 for the next)
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
export function getTile(index)            // static tile data
export function isOwnable(index)          // property | railroad | utility
export function groupIndices(group)       // → sorted tile indices of a color group
export const OWNABLE_INDICES              // sorted indices of all 28 ownable tiles
```

### `engine/cards.js`
```js
export const CARDS                        // parsed cards.json
export function getCard(deck, id)         // deck: "chance" | "community"
export const GOOJF_ID                     // { chance: 8, community: 4 } — derived from data (kind === "goojf")
```

### `engine/state.js`
```js
export const DEFAULT_SETTINGS  // { maxPlayers:6, startingCash:1500, turnTimeoutSec:90, freeParkingPot:false, auctionOnDecline:true, evenBuild:true }
export function normalizeSettings(partial) // merge with defaults + clamp: maxPlayers 2..8, startingCash 100..100000,
                                           // turnTimeoutSec 0 (=off) or 10..3600, booleans coerced
export function createGame({ id, seed, settings }) // → fresh lobby state (see §3). Deck orders are shuffled here with state.rng.
```

### `engine/rules.js` (pure helpers, never mutate)
```js
export function getTileState(state, index)          // → state.tiles entry or null
export function getPlayer(state, playerId)
export function currentPlayerId(state)              // state.turn.order[state.turn.currentIndex] (null in lobby)
export function activePlayers(state)                // non-bankrupt players, in turn order
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
       // after removing float noise ($100 → $110, not 111; $30 → $33). Always call this; never recompute it.
export function liquidationValue(state, playerId)        // cash + half house cost of every building + mortgage value of every unmortgaged property
export function netWorth(state, playerId)                // cash + price of owned (mortgage value if mortgaged) + houseCost of buildings — for UI
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
    "bankrupt": false, "connected": true
  }],
  "turn": {
    "order": [], "currentIndex": 0,
    "phase": "lobby",
    "number": 0,                            // (ext) 1 at game start, +1 each time the turn passes
    "doublesCount": 0,
    "rollAgain": false,                     // (ext) true after a doubles roll resolves (player not jailed): must ROLL again, END_TURN rejected
    "lastRoll": null,                       // [d1, d2] of the current player's latest roll this turn; null at turn start
    "pendingPurchase": null,                // tile index
    "pendingDebt": null,                    // { toPlayerId|null, amount, reason, payees?, then? } — see §4.6
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
new `players[0].id` (or `null` if empty).

Turn order = join order (`turn.order` set at START_GAME). Bankrupt players stay in `order` and
are skipped.

---

## 4. Rules

### 4.1 Actions (all `{ type, playerId, ...payload }`)
Lobby: `JOIN {name, token}` (playerId is supplied by the server), `LEAVE`, `START_GAME` (host only, ≥2 players).
Turn: `ROLL`, `BUY`, `DECLINE`, `END_TURN`. Jail: `PAY_JAIL_FINE`, `USE_JAIL_CARD`.
Money: `PAY_DEBT`, `DECLARE_BANKRUPTCY`. Build: `BUILD|SELL_HOUSE|MORTGAGE|UNMORTGAGE {tileIndex}`.
Stubs → error `NOT_IMPLEMENTED` (after checking game is active): `START_AUCTION, BID, PROPOSE_TRADE, ACCEPT_TRADE, REJECT_TRADE`.
Server-only: `TIMEOUT` (see 4.9). The engine accepts it; the **server** refuses it from clients.

Validation order: known type → payload shape → game status → player exists & not bankrupt → is
it this player's turn (where required) → phase → rule checks. First failure wins.

Error codes: `UNKNOWN_ACTION, BAD_PAYLOAD, NOT_IN_LOBBY, GAME_NOT_ACTIVE, NO_PLAYER, ALREADY_JOINED,
GAME_FULL, BAD_NAME, BAD_TOKEN, TOKEN_TAKEN, NOT_HOST, NOT_ENOUGH_PLAYERS, NOT_YOUR_TURN, WRONG_PHASE,
MUST_ROLL_AGAIN, INSUFFICIENT_FUNDS, NO_JAIL_CARD, NOT_IN_JAIL, INVALID_TILE, NOT_OWNER, NOT_MONOPOLY,
MORTGAGED_IN_GROUP, UNEVEN_BUILD, MAX_BUILDINGS, NO_BUILDINGS, BANK_SHORTAGE, HAS_BUILDINGS,
ALREADY_MORTGAGED, NOT_MORTGAGED, NOT_IMPLEMENTED, INTERNAL`.

### 4.2 Lobby
- JOIN: status lobby; `playerId` not already present (`ALREADY_JOINED`); name trimmed 1–20 chars (`BAD_NAME`);
  token must be one of `BOARD.tokens[].id` (`BAD_TOKEN`) and unused (`TOKEN_TAKEN`); players < maxPlayers (`GAME_FULL`).
  Check order: `NOT_IN_LOBBY, ALREADY_JOINED, GAME_FULL, BAD_NAME, BAD_TOKEN, TOKEN_TAKEN` (a full table says so, not "token taken").
  New player: cash = startingCash, position 0, all flags false/0, `jailCards: []`, `connected: true`.
- LEAVE in lobby: remove the player. LEAVE while active = **resign**: bankrupt to the bank (4.8) — allowed any time, even off-turn.
- START_GAME: host only; ≥2 players. status → active, order = player ids in join order, currentIndex 0,
  number 1, phase `rolling`. Events `game_started`, `turn_started`.

### 4.3 Rolling & movement
- `rolling`: current player ROLLs. Doubles → `doublesCount++`. Third consecutive doubles → go to jail
  immediately (no move), turn ends (`phase end_turn`, `rollAgain false`).
- Otherwise move forward `d1+d2`. Passing **or landing on** GO pays `goSalary` (once). Then resolve the landing.
- `rollAgain` is set right after a normal roll (`= doubles`) and cleared if the player is sent to jail while resolving.
  It survives `buying_or_auction` / `paying`, so after BUY/DECLINE/PAY_DEBT the player is back in `end_turn` and must roll again.
- After resolution with nothing pending: `phase end_turn`.
- `end_turn`: if `rollAgain` → only ROLL is legal (END_TURN → `MUST_ROLL_AGAIN`); ROLL behaves as in `rolling`
  (doublesCount carries). Otherwise END_TURN passes the turn.
- END_TURN: next non-bankrupt player in order; reset `doublesCount 0, rollAgain false, lastRoll null,
  pendingPurchase null`; `number++`; phase = `jail_decision` if that player is in jail else `rolling`. Events `turn_ended`, `turn_started`.

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
  (log "auction not implemented yet" when `auctionOnDecline`).

### 4.5 Cards
Draw: `id = decks[d].order[pos]`, `pos++`; when `pos` reaches the end, reshuffle `order` with `shuffle(state.rng, ...)`
and `pos = 0`. Skip (draw again) a GOOJF card that is currently held by any player (`players[].jailCards` includes that deck).
Drawing GOOJF: `getOutOfJailCards++`, `jailCards.push(deck)`. Using one: `getOutOfJailCards--`, remove the first
matching entry — the card becomes drawable again.

### 4.6 Payments and debt
`charge(payer, toPlayerId|null, amount, reason)`: if `cash ≥ amount` pay immediately. Otherwise:
`turn.pendingDebt = { toPlayerId, amount, reason }`, phase `paying`, event `debt_started`.
- Money paid "to the bank" for `tax`, `card` fees (`pay`, `repairs`) and `jail_fine` goes to `state.pot`
  instead when `settings.freeParkingPot` is on.
- `pay_each` owed but unaffordable: `pendingDebt = { toPlayerId: null, amount: total, reason: "card", payees: [{playerId, amount}] }`;
  PAY_DEBT pays each payee; bankruptcy on it goes to the bank.
- `collect_each`: each other player who can't pay is auto-liquidated (`autoRaise`, 4.10); if still short they go
  bankrupt to the collector (4.8). No pendingDebt for off-turn players.
- `paying` phase: only the debtor (current player) acts: SELL_HOUSE, MORTGAGE, PAY_DEBT (needs cash ≥ amount),
  DECLARE_BANKRUPTCY. After PAY_DEBT: if `pendingDebt.then` exists run it, else phase `end_turn` (rollAgain preserved).
- `then` is used only for the forced jail fine: `{ kind: "jail_move", steps }` → after paying, move `steps` and resolve.

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
Creditor = `pendingDebt.toPlayerId` (null → bank; `payees` debts → bank; LEAVE → bank).
1. Sell every building back to the bank for `floor(houseCost/2)` per level (hotel = 5 levels); houses/hotels return to bank supply.
2. Creditor is a player → they receive all the debtor's cash, all properties (mortgage state kept), and jail cards.
   Creditor is the bank → properties become unowned + unmortgaged; jail cards return to their decks; cash is removed.
3. Debtor: `bankrupt true, cash 0, jailCards [], getOutOfJailCards 0, inJail false`. `pendingDebt null`.
   If anyone else's `pendingDebt.toPlayerId` was the bankrupt player it becomes `null` (bank).
4. If ≤1 non-bankrupt player remains → `status finished`, `phase game_over`, `winnerId`, event `game_over`.
   Else if the bankrupt player was the current player → the turn passes to the next player (as END_TURN).

### 4.9 TIMEOUT `{ type:"TIMEOUT", playerId }` — playerId must be the current player
Emits `{type:"timeout", playerId, phase}` then: `rolling`→ROLL; `jail_decision`→ROLL; `buying_or_auction`→DECLINE;
`end_turn`→ rollAgain ? ROLL : END_TURN; `paying`→ if cash ≥ amount PAY_DEBT, else `autoRaise` then PAY_DEBT if now
affordable, else DECLARE_BANKRUPTCY. Other phases → `WRONG_PHASE`.

### 4.10 Building, selling, mortgaging
- BUILD: property owned by actor; owns full group (`NOT_MONOPOLY`); no tile in group mortgaged; houses < 5;
  if `evenBuild`: this tile's houses === min houses in group (`UNEVEN_BUILD`); bank supply: 0–3→4 needs 1 house,
  4→5 (hotel) needs 1 hotel and returns 4 houses to the bank (`BANK_SHORTAGE`); cash ≥ houseCost.
- SELL_HOUSE: houses > 0; if `evenBuild`: this tile's houses === max in group; hotel→4 houses needs 4 houses in the bank
  (`BANK_SHORTAGE`); refund `floor(houseCost/2)`.
- MORTGAGE: owned, not mortgaged, no buildings on any tile of its color group (`HAS_BUILDINGS`); +mortgage value.
- UNMORTGAGE: owned, mortgaged, cash ≥ `unmortgageCost`.
- `autoRaise(state, playerId, target)` (internal, deterministic): while cash < target: sell one level from the tile
  with the most buildings (ties → lowest index; skip hotels that can't break for lack of houses); when no buildings
  remain, mortgage unmortgaged tiles whose group has no buildings in ascending index order. Stop once cash ≥ target.

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
player. The management arrays list tile indices for which that action would succeed. `playerId` may be null
(spectator): lobby with room → `["JOIN"]`, else empty. Stub and TIMEOUT actions are never listed.
Invariant (tested by the simulator): every listed action succeeds when applied; unlisted turn actions fail.

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
card_drawn {playerId, deck, cardId, text}    jail_card_received {playerId, deck}
sent_to_jail {playerId, reason:"tile"|"card"|"doubles"}
left_jail {playerId, method:"fine"|"card"|"doubles"|"forced_fine"}
jail_roll_failed {playerId, attempt}
built {playerId, tileIndex, houses}          sold_house {playerId, tileIndex, houses}
mortgaged {playerId, tileIndex, amount}      unmortgaged {playerId, tileIndex, amount}
debt_started {playerId, toPlayerId, amount, reason}   debt_paid {playerId, toPlayerId, amount}
bankrupt {playerId, toPlayerId}              game_over {winnerId}
timeout {playerId, phase}
```
Server-added (not from the engine): `connection {playerId, connected}`.

---

## 7. Server ↔ client protocol (JSON over WebSocket at `/ws`)
Client → server:
- `{ t:"hello", gameId, playerId?, token? }` — first message. Valid playerId+token → seat resumed (`welcome`
  then `state`). Missing/invalid credentials → spectator (`state` only; plus `error` code `BAD_TOKEN` if a token was sent).
  Unknown game → `error` code `NO_GAME`.
- `{ t:"action", action:{ type, ...payload } }` — the server sets `action.playerId` from the socket's seat and ignores
  any client value. `JOIN` from a seatless socket: server creates `playerId` (`p_` + 8 random chars) and a secret
  `token` (32 hex), applies JOIN, binds the socket, sends `welcome`. `TIMEOUT` from a client → error.
- `{ t:"ping" }` → `{ t:"pong" }` (optional app-level keepalive).

Server → client:
- `{ t:"welcome", gameId, playerId, token }`
- `{ t:"state", state, events, legal, now }` — `state` is the **public** state: `rng` removed and `decks` replaced by
  `{ chance:{ size }, community:{ size } }` (hides future dice/cards). `legal` = `legalActions(state, thisSocketsPlayerId)`.
  `now` = server `Date.now()` for countdown clock-skew correction. Sent to every socket in the room after every change.
- `{ t:"error", code, message }`

One socket per seat: if a seat is resumed from a second socket, the server sends the old socket
`{t:"error", code:"REPLACED"}` and closes it with WebSocket close code **4000**. Clients must NOT auto-reconnect after
4000/REPLACED (prevents two tabs fighting); show "Opened in another tab — [Use here]" instead. On graceful shutdown
the server closes sockets with code **1012**; clients reconnect with backoff as usual.

HTTP:
- `GET /health` → `200 {"ok":true,"games":<n>,"uptime":<s>}`
- `POST /api/games` body `{settings?}` → `201 {"gameId"}`
- `GET /api/games` → `{"games":[{id, players, maxPlayers, hostName, createdAt}]}` (open lobbies only)
- `GET /api/games/:id` → `{id, status, players:[{id, name, token, connected, bankrupt}], settings, createdAt}` or 404
  (`token` here is the game piece, never the secret)
- `GET /api/board` → board.json contents (client uses it for names/colors/prices/tokens)
- Everything else: static files from `/public` (`/` → `index.html`), no directory traversal, correct content types.

Game ids: `g_` + 6 chars from `abcdefghjkmnpqrstuvwxyz23456789`. The "join code" shown to users is the 6 chars
(accept with or without `g_`, any case).

---

## 8. Client ownership rules
- `public/renderer2d.js` exports **only** `render(state, events, myPlayerId)`. It is the only file that touches the
  board DOM: everything inside `<div id="board">`. It fetches `/api/board` itself (top-level await) and injects its own
  stylesheet `public/renderer2d.css`. Swapping it for a Three.js renderer must not require touching any other file.
- `public/ui.js` owns everything outside `#board`: screens, side panel, buttons (driven by `legal`), dialogs, countdown.
- `public/net.js` owns the socket: reconnect with exponential backoff + random jitter, hello with stored credentials.
- Player colors (renderer and UI must agree): by index in `state.players`, palette
  `#e74c3c, #3498db, #2ecc71, #f1c40f, #9b59b6, #e67e22, #1abc9c, #e84393`.
- `public/boarddata.js` (shared tiny module) → `export const BOARD = await fetch('/api/board').then(r => r.json())`.
- Seats and tabs (so 2+ tabs in one browser can play as different players):
  - `sessionStorage["monopoly.seat.<gameId>"] = { playerId, token }` — this tab's seat; auto-resumed on reload.
  - `localStorage["monopoly.sessions"] = { [gameId]: { playerId, token, name } }` — remembered across tabs/restarts.
  - Opening a game with no seat in sessionStorage: `GET /api/games/:id`; if a remembered localStorage seat for this game
    exists and that player is **not** connected → resume it automatically (copy into sessionStorage). If that player **is**
    connected (another tab has it) → act as a new visitor (join form in lobby / spectator in game) and offer a small
    "Take over <name>'s seat" link.
  - `localStorage["monopoly.name"]` = last used display name.
- URL: `/?game=<gameId>` opens that game (lobby or table). The page updates the URL with `history.replaceState`.
