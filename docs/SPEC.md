# Build: Browser Monopoly — Node server, 2D client, JSON persistence

(Original project brief. `docs/CONTRACT.md` pins down the exact interfaces built from it.)

Build a web-based, multiplayer Monopoly game as a single Node.js server that serves everything: HTTP, WebSockets, and all static front-end assets from the repo. No database, no external services, no front-end build step, no framework. It will be deployed on Coolify with one persistent volume for game data.

## Hard constraints
- Node 20+, plain JavaScript (ES modules). Dependencies: `ws` only (Express optional). Nothing else unless truly necessary; justify any addition.
- One process serves: `/` static files from `/public`, a small JSON API, and a WebSocket endpoint at `/ws`.
- No database of any kind. State lives in memory; persistence is JSON files in `DATA_DIR` (env var, default `./data`).
- Port from `PORT` env var (default 3000). Include a `Dockerfile` (or Nixpacks-compatible `package.json` start script) and a `GET /health` endpoint for Coolify.
- The 2D client is temporary. A Three.js renderer will replace it later, so rendering must be fully isolated.

## Repo layout
```
/engine        pure game logic — no I/O, no network, no Date.now(), no Math.random()
  board.js     board data (40 tiles) loaded from /engine/data/board.json
  cards.js     Chance / Community Chest decks from /engine/data/cards.json
  state.js     createGame(config) → state
  actions.js   applyAction(state, action) → { state, events }
  rules.js     rent calc, monopolies, bankruptcy checks, etc.
  rng.js       seeded PRNG (e.g. mulberry32); seed stored in state
/server
  index.js     http + ws bootstrap, static serving, /health
  rooms.js     in-memory game registry, player sessions, broadcast
  persist.js   atomic JSON save/load
  timers.js    turn timers + AFK auto-actions
/public
  index.html, style.css
  net.js       WebSocket client, reconnect logic
  ui.js        menus, dialogs, buttons (DOM)
  renderer2d.js  board drawing — the ONLY file that knows the board is 2D
/test          engine unit tests (node:test, no extra deps)
```

## Engine rules
- `applyAction` is pure and deterministic: same state + same action → same result. All randomness comes from the seeded RNG whose current seed/counter is stored IN the state, so any saved state replays identically.
- Every action is validated against the current `phase` and the acting player. Invalid actions return an error object and leave state untouched — never throw.
- `applyAction` returns `{ state, events }`. Events are a list of what happened (`{type:"moved", playerId, from, to}`, `{type:"paid_rent", ...}`, `{type:"passed_go"}`, etc.) so a future Three.js renderer can animate them. State is the truth; events are just for presentation.
- Board and card data live in JSON files, not code, so names/prices/art can be swapped without touching logic.

## State shape (use exactly this; extend only if needed and document it)
```jsonc
{
  "version": 1,
  "id": "g_abc123",
  "createdAt": 0, "updatedAt": 0,          // set by server, not engine
  "status": "lobby" | "active" | "finished",
  "settings": {
    "maxPlayers": 6, "startingCash": 1500,
    "turnTimeoutSec": 90, "freeParkingPot": false,
    "auctionOnDecline": true, "evenBuild": true
  },
  "rng": { "seed": 123456, "counter": 0 },
  "players": [
    {
      "id": "p_x", "name": "Peter", "token": "car",
      "cash": 1500, "position": 0,
      "inJail": false, "jailTurns": 0, "getOutOfJailCards": 0,
      "bankrupt": false, "connected": true
    }
  ],
  "turn": {
    "order": ["p_x", "p_y"],
    "currentIndex": 0,
    "phase": "rolling",
    "doublesCount": 0,
    "lastRoll": null,            // [d1, d2]
    "pendingPurchase": null,     // tile index awaiting buy/decline
    "pendingDebt": null,         // { toPlayerId|null, amount }
    "deadlineAt": null           // set by server timers
  },
  "tiles": [                     // ownership only; static data comes from board.json
    { "index": 1, "ownerId": null, "houses": 0, "mortgaged": false }
  ],
  "bank": { "houses": 32, "hotels": 12 },
  "decks": {
    "chance":    { "order": [3,0,7], "pos": 0 },
    "community": { "order": [5,1,2], "pos": 0 }
  },
  "auction": null,               // stubbed for now
  "trade": null,                 // stubbed for now
  "log": []                      // last ~100 human-readable lines
}
```

## Phases
lobby → rolling → resolving → (buying_or_auction | paying | jail_decision) → end_turn → rolling (next player) … → game_over
Also stubbed: auction, trading.
- rolling: current player may ROLL (or, if jailed, go to jail_decision first).
- resolving: server-only; engine resolves the landing (rent, tax, card, go-to-jail) and picks the next phase automatically.
- buying_or_auction: current player may BUY or DECLINE.
- paying: player owes more than cash; may MORTGAGE/SELL_HOUSE, then PAY_DEBT, or DECLARE_BANKRUPTCY.
- jail_decision: PAY_JAIL_FINE, USE_JAIL_CARD, or ROLL (for doubles; 3rd failed attempt forces fine).
- end_turn: END_TURN, or ROLL again if doubles (3 doubles → jail).
- Building/mortgaging (BUILD, SELL_HOUSE, MORTGAGE, UNMORTGAGE) allowed on your own turn in rolling or end_turn phases.

## Actions (all shaped { type, playerId, ...payload })
- Lobby:  JOIN { name, token }, LEAVE, START_GAME (host only)
- Turn:   ROLL, BUY, DECLINE, END_TURN
- Jail:   PAY_JAIL_FINE, USE_JAIL_CARD
- Money:  PAY_DEBT, DECLARE_BANKRUPTCY
- Build:  BUILD { tileIndex }, SELL_HOUSE { tileIndex }, MORTGAGE { tileIndex }, UNMORTGAGE { tileIndex }
- Stubs (validate phase, return "not implemented"): START_AUCTION, BID, PROPOSE_TRADE, ACCEPT_TRADE, REJECT_TRADE
- Server-only (never accepted from clients): TIMEOUT { playerId } → auto-action for the current phase (auto-roll, auto-decline purchase, auto-end turn, auto-bankrupt only if unavoidable).

Implement fully for the first slice: lobby, rolling (incl. doubles and 3-doubles jail), movement and passing GO, buying/declining, rent (incl. monopoly double rent, railroads, utilities), taxes, Chance/Community Chest (move, pay, collect, jail, GOOJF card), jail rules, building evenly, mortgaging, debt, bankruptcy to bank or player, and game over.

## Server
- Registry: Map<gameId, { state, sockets: Map<playerId, ws>, dirty, timer }>.
- Protocol (JSON over WS):
  - client → server: { t:"hello", gameId?, playerId?, token? } then { t:"action", action }
  - server → client: { t:"state", state, events } | { t:"error", message } | { t:"welcome", gameId, playerId, token }
- Join/resume: on first join the server issues a random secret `token` per player; the client stores gameId/playerId/token in localStorage and resends it on reconnect to resume the same seat. Without the right token you can't act as that player.
- After every successful action, broadcast full state + events to every socket at that table. Clients never hold authoritative state.
- Mark players connected/disconnected on socket open/close; never remove a disconnected player automatically.
- Turn timers: server sets `turn.deadlineAt`; on expiry, apply TIMEOUT. Clear/reset timers on every phase change.
- HTTP API: POST /api/games (create, returns gameId), GET /api/games (list open lobbies), GET /api/games/:id (summary), GET /health.

## Persistence
- One file per game: `DATA_DIR/games/<gameId>.json`.
- Mark game dirty on change; save at END_TURN, on game over, and on a 5-second debounce if dirty. Never save on every action.
- Atomic writes: write `<id>.json.tmp`, fsync, rename over the real file.
- On startup: load every file in `DATA_DIR/games`, restore to memory, restart timers for active games, mark all players disconnected until they reconnect.
- Finished games: keep file, move to `DATA_DIR/finished/`, remove from memory. Lobbies with no players for 30 min: delete from memory and disk.
- Graceful shutdown on SIGTERM/SIGINT: flush all dirty games, then exit (Coolify sends SIGTERM on redeploy).

## Client (2D, temporary)
- Plain HTML/CSS/vanilla JS modules. No framework, no bundler.
- Screens: home (create/join by code), lobby (players, token pick, host start), game.
- `renderer2d.js` exports `render(state, events, myPlayerId)` and nothing else touches board DOM. Board = 11×11 CSS grid, 40 perimeter tiles, center area for dice/log. Tokens as positioned markers; simple CSS transitions on move.
- `ui.js` owns the side panel: player cash list, my properties, action buttons enabled only when legal for the current phase and my turn, buy/decline dialog, jail options, debt dialog, turn countdown.
- `net.js`: auto-reconnect with exponential backoff plus random jitter (so a server restart doesn't cause a reconnect stampede), resumes via stored token.

## Tests
Unit tests for the engine with node:test covering: passing GO, rent with and without monopoly, railroad/utility rent, 3 doubles → jail, jail escape paths, even-build rule, mortgage blocks rent, bankruptcy transfers assets, and determinism (same seed + same actions = identical final state).

## Deliverable order
1. Engine + tests passing (no server yet).
2. Server + persistence, including restart-and-resume.
3. 2D client, playable end-to-end with 2+ browser tabs.
4. README: how to run locally, env vars, Coolify setup (mount persistent volume at DATA_DIR, health check path, port).

Keep it simple. Don't add auth systems, accounts, chat, ORMs, TypeScript, or build tooling.
