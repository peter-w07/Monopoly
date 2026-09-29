# Monopoly (browser multiplayer)

A multiplayer Monopoly game for 2–8 players that runs in the browser. A single Node.js
process serves the static client, a small JSON API and a WebSocket endpoint, and keeps
games in memory with JSON files on disk for persistence. There is no database, no build
step and no front-end framework; the only dependency is [`ws`](https://github.com/websockets/ws).
The rules engine is pure and deterministic, so any saved game replays identically.
The board has two interchangeable renderers — a classic 2D board and an early 3D board
(Three.js) inspired by Monopoly Plus — switched with the 2D | 3D toggle on the board.

**What works**

- Lobby: create a game (starting cash, turn timer, max players, Free Parking pot, even
  building, auctions), share a 6-character code or invite link, pick a token, host starts.
- Full turn flow: dice, doubles (three doubles → jail), passing and landing on GO, buying
  or declining, rent (monopoly double rent, railroads, utilities), taxes, all 32 Chance /
  Community Chest cards, jail (fine, card, rolling for doubles, forced fine on the third miss).
- Auctions: a declined property goes to an open auction that everyone at the table can bid in.
- Trading: properties, cash and Get Out of Jail Free cards, one offer at a time, on your turn
  (also to raise cash when you're in debt).
- Houses and hotels with the even-build rule and the bank's limited supply, selling,
  mortgaging and unmortgaging (10% interest).
- Debt: raise cash by selling, mortgaging or trading, then pay; bankruptcy to a player or to
  the bank; game over and standings.
- Turn timer with auto-play for absent players, reconnect and seat resume, several tabs
  as different players, spectators.
- Games survive a server restart or redeploy.
- 3D board (early, work in progress): a toy board on a table, hopping tokens, thrown dice,
  a camera that follows the action (drag to orbit, scroll to zoom, ⟲ to reset), and a small
  town that grows as properties are bought and built on. Click **3D** on the board to try it;
  it falls back to 2D on devices without WebGL2.

---

## Quick start

Requires **Node 20 or newer**.

```sh
npm install
npm start            # http://localhost:3000, games saved under ./data
```

Open <http://localhost:3000>, type a name and click **Create game**. To try multiplayer
alone, open the invite link in a second tab: each tab keeps its own seat, so two tabs are
two players.

To play with friends, they need to reach your server:

- **Same network:** they open `http://<your computer's LAN IP>:3000` (the server listens on
  all interfaces; your firewall may ask to allow Node).
- **Over the internet:** put a tunnel (Cloudflare Tunnel, ngrok, …) in front of port 3000, or
  deploy it (see [Deploying on Coolify](#deploying-on-coolify)). WebSockets work through
  HTTPS proxies; the client switches to `wss://` on its own.

Other scripts:

| Command | What it does |
|---|---|
| `npm run dev` | Same server, restarted when a server or engine file changes (`node --watch`). Client files are served fresh; just reload the page. |
| `npm test` | All tests, about 10 s. See [Testing](#testing). |
| `npm run playtest -- --help` | Headless bots play a game against a running server. |

Stop the server with Ctrl+C: it saves every game before exiting.

---

## How to play

1. **Create.** Enter your name, choose the settings and click **Create game**. You are seated
   as the host with the first free token. (Without a name, the lobby's join form asks for one.)
2. **Invite.** Share the game code (top bar and lobby) or **Copy invite link**
   (`/?game=<id>`). Friends can also type the code under **Join by code**; the home page lists
   open lobbies too.
3. **Join.** Friends enter a name, pick a token and click **Join game**.
4. **Start.** The host clicks **Start game** once at least 2 players have joined. If the host
   is offline, the first connected player in join order can start instead. Turn order is
   join order.

**On your turn** the side panel only shows buttons that are legal right now:

- **Roll dice**, then answer the buy dialog (**Buy** / **Decline**), then **End turn**. After
  doubles you must **Roll again**.
- Keyboard: **Space** or **Enter** rolls, and later ends the turn. For about 0.7–1.5 s after
  a roll it will not end the turn, so a double press can't skip your move. It never takes
  a jail decision for you. When a buy, debt or jail dialog opens, focus moves to its main
  button, so Space/Enter then presses that button (e.g. **Buy**). Buttons you click with the
  mouse or a tap don't keep focus; a button you reached with Tab does, and Space/Enter press it.
- **Build, sell, mortgage, unmortgage** from *My properties* during your own turn: before or
  after rolling, while deciding on a purchase and in jail. Selling and mortgaging also work
  while you are in debt.
- **Jail:** pay the $50 fine, use a Get Out of Jail Free card, or roll for doubles. On the third
  failed roll you pay the fine and move.
- **Debt:** when you owe more than you have, the debt dialog lists what you can sell or
  mortgage, and you can also trade (see below). Pay once you have enough, or **Declare
  bankruptcy**. Once you can pay, the bankruptcy button goes away (Resign is still there).
- **Information:** tap or click a board tile for its price, owner, buildings and current
  rent. Tap a player's row for everything they own. Spectators can do both.
- Phones and narrow windows (≤ 899px): dialogs appear in the panel above the buttons, with a
  *Raise cash* list, and the panel shows the last 5 log lines. Phone-sized boards use short
  tile names; tap a tile for the full one.

**Auctions.** When the player who landed on an unowned property declines it (with *Auctions*
on, the default), it goes up for auction at once, and everyone still in the game can bid, the
decliner and off-turn players included. The auction panel shows the deed, the high bid, a
10-second clock and your options:

- Quick bids raise the high bid by $1, $10, $50 or $100. After every new bid they ignore
  clicks for 0.7 s, so a click meant for the old amount can't bid the new one; a step you
  can't afford stays greyed out. Type any amount in the box instead (**Max** fills in all your
  cash), then press **Bid**.
- **Pass** drops you out for good. The high bidder can't pass.
- Every bid restarts the 10 s clock (passes don't). The auction ends when everyone else has
  passed or the clock runs out; an auction never runs longer than 2 minutes in total. The
  winner pays the bank (never the Free Parking pot); with no bids the property stays unowned.
- You can't bid more than your cash, and nobody's cash changes during an auction (no
  mortgaging or trading meanwhile), so a winner can always pay.
- Disconnected players aren't waited for. On a phone, the page scrolls to the auction panel
  when one starts.
- If the high bidder resigns, the high bid falls back to the best bid by someone still in the
  auction (never to a player who passed). If the current player resigns, the auction is
  called off.

**Trading.** On your turn, before or after rolling, in jail or while in debt, **Trade** opens
the offer builder: pick a player, tick properties on either side, add cash and Get Out of
Jail Free cards. It shows the fees and your cash afterwards, and won't send an offer the game
would refuse.

- Properties in a colour group with buildings can't be traded (sell the buildings first).
- Mortgaged properties change hands still mortgaged, and whoever receives one pays the bank
  10% of its mortgage value at once.
- The other player sees the offer (and which colour sets it would complete) and can
  **Accept** or **Reject**; you can **Withdraw** it. Accept only works after the offer has
  been on screen for a second, and it accepts exactly that offer: if you withdraw and send a
  different one, a click meant for the old one does nothing.
- One offer can be pending at a time, and you can make at most 5 offers per turn.
- Your turn clock keeps running while an offer waits. If it runs out, the offer is cancelled
  and your turn is played as usual.
- **In debt you may sell but not give away:** what you get (cash, plus properties at their
  mortgage value, minus fees) must be worth at least what you give (properties at their
  mortgage value; mortgaged ones and jail cards count as $0). So a player about to go
  bankrupt can't hand everything to a friend instead of their creditor.

**Turn timer and absent players.** With a turn timer set (default 90 s), an expired turn is
played automatically: roll, decline the purchase, end the turn, or pay a debt. To pay, it
mortgages railroads, utilities and unbuilt lots first, then sells buildings, then mortgages
the rest. It declares bankruptcy only when even selling everything couldn't cover the debt,
and in that case the creditor gets the properties untouched. Disconnected players are never
removed. If the current player is offline, they are auto-played after 45 s (or when their
turn time runs out, if sooner); if they come back first, they get the rest of their turn
time. With the timer **off**, the game waits for them. When everyone is offline, the timer
pauses.

**Reconnecting.** Seats are secret tokens kept in the browser (`sessionStorage` for the tab,
`localStorage` for the browser). Reloading, a network drop or a server restart resumes your
seat automatically. If the same seat is opened in another tab, the old tab shows *Opened in
another tab — Use here*. A new tab on a game whose seat is live elsewhere offers *Take over
&lt;name&gt;'s seat*. While disconnected, the buttons are paused with a **Retry** link.

**Leaving.** In the lobby, **Leave** just gives up your seat. In a game, **Resign** makes you
bankrupt. Your assets go to the bank, except when you are in debt to one player: then they
go to that player, the same as declaring bankruptcy. If a player you owe resigns first, your
debt to them is cancelled (a *pay each player* card debt shrinks by their share).

**Rule details worth knowing**

- Rent doubles on unimproved lots of a complete colour group, even if one lot in the group is
  mortgaged. Mortgaged lots charge no rent.
- Building must be even across a group (can be turned off). If the bank has fewer than 4 houses
  left, a hotel can still be sold: it becomes as many houses as the bank has (possibly none),
  and you get half the house cost for every level that disappears. The group may be uneven
  for a while after that.
- Property handed over in a bankruptcy keeps its mortgage, and the new owner pays no 10% fee.
  Property returned to the bank becomes unowned and unmortgaged.
- Property received in a trade pays the 10% fee at once; lifting the mortgage later costs the
  mortgage value plus 10% again, as in the official rules when the mortgage isn't lifted
  straight away. (There is no option to lift it at the moment of the trade.)
- Free Parking pot (optional house rule): taxes, card fees and jail fines go into a pot that
  whoever lands on Free Parking collects.
- Card decks are reshuffled when they run out. A held Get Out of Jail Free card is out of the
  deck until it is used.

---

## Configuration

All settings are environment variables. None are required.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP and WebSocket port. |
| `DATA_DIR` | `./data` | Where games are saved (relative to the working directory). The Docker image sets `/data`. |
| `TRUST_PROXY` | `auto` | Which address counts as the client IP for the per-IP limits. `auto`: the rightmost `X-Forwarded-For` entry when the TCP peer is loopback or a private address (a reverse proxy such as Traefik on Coolify), otherwise the TCP peer. `1`: always use the header. `0`: never use it. |
| `LIMIT_*` | see below | Abuse limits; `0` turns a limit off. |
| `PLAYTEST_URL` | `http://localhost:3000` | Default `--url` for `npm run playtest`. |

`NODE_ENV=production` is set in the Docker image, but the app doesn't read it.

Limits (defined and documented at the top of `server/limits.js`):

| Variable | Default | Limit |
|---|---|---|
| `LIMIT_SOCKETS` | 2000 | Open WebSockets in total (more → 503) |
| `LIMIT_SOCKETS_PER_IP` | 30 | Open WebSockets per client IP (more → 429). Households share an IP, so don't go much lower. |
| `LIMIT_UPGRADE_BURST` / `LIMIT_UPGRADE_PER_SEC` | 20 / 1 | New WebSocket connections per IP: a burst, then this many per second |
| `LIMIT_MSG_BURST` / `LIMIT_MSG_PER_SEC` | 100 / 50 | Messages per socket; extras are dropped with a `RATE_LIMITED` error |
| `LIMIT_MSG_DROPS_TO_CLOSE` | 500 | More drops than this within 10 s closes the socket |
| `LIMIT_HELLO_TIMEOUT_MS` | 10000 | A socket that hasn't joined a game by then is closed |
| `LIMIT_HELLO_INTERVAL_MS` | 1000 | At most one `hello` per socket per interval |
| `LIMIT_SPECTATORS_PER_ROOM` | 20 | Watchers per game (visitors who want to join count too until they sit down) |
| `LIMIT_SEND_BUFFER_BYTES` | 2097152 | A socket with more unsent data than this (a client that stopped reading) is cut off |
| `LIMIT_CREATE_BURST` / `LIMIT_CREATE_PER_MIN` | 10 / 5 | New games per IP: a burst, then this many per minute (more → 429) |

Load tests or bot swarms that open many sockets or games from one machine need the per-IP
limits relaxed, e.g. `LIMIT_SOCKETS_PER_IP=0 LIMIT_UPGRADE_BURST=0 LIMIT_CREATE_BURST=0 npm start`.

---

## Project layout

```
engine/    Pure rules engine: no I/O, no clock, no Math.random. applyAction(state, action) → { state, events }.
           Board and card data live in engine/data/*.json.
server/    node:http + ws. index.js (HTTP API, static files, /ws, shutdown), rooms.js (games, seats,
           broadcast), persist.js (atomic JSON saves, instance lock), timers.js (turn timer, AFK),
           limits.js (abuse limits).
public/    Vanilla ES-module client, served as-is. ui.js (screens, panel, dialogs), net.js (socket,
           reconnect), renderer-switch.js (2D | 3D), renderer2d.js + renderer2d.css (2D board),
           renderer3d.js + r3d/ (3D board), vendor/three/ (three.js r186, MIT), boarddata.js, style.css.
test/      node:test suites: engine unit tests, a 150-game simulation, server integration tests.
           bot.js is the bots' move chooser (shared with scripts/).
scripts/   bot-client.js (headless WebSocket player), playtest.js (bot game against a live server).
docs/      SPEC.md (the original brief), CONTRACT.md (authoritative interfaces: state shape, rules,
           events, protocol, persistence).
```

**Renderer isolation.** Only the renderers know what the board looks like. `renderer2d.js`
and `renderer3d.js` each export `render(state, events, myPlayerId)` and `dispose()`, own every
node inside `<div id="board">` while active, load `/api/board` themselves and inject their own
styles. `renderer-switch.js` hands the board to one of them (remembered in
`localStorage["monopoly.renderer"]`; `?renderer=3d` forces 3D once) and is the one module
`ui.js` imports. three.js is only downloaded when 3D is chosen.

Rules every renderer follows:

- On every call, **state is the truth**: always converge on it.
- Use `events` only for animation: `dice_rolled`, `moved` (with `from`, `to`, signed `steps`
  and `via`), `passed_go`, `bought`, `built`, `card_drawn`, `sent_to_jail` and so on (the full
  list is in CONTRACT §6).
- A state that arrives with no events (first load, reconnect) should snap into place.
- Player colours are fixed by index (CONTRACT §8), so the board and the panel agree.

---

## Persistence

Everything lives under `DATA_DIR`:

| Path | Contents |
|---|---|
| `games/<id>.json` | Live lobbies and active games: `{ version, state, secrets }` (secrets = seat tokens) |
| `finished/<id>.json` | Games that reached game over |
| `abandoned/<id>.json` | Active games nobody connected to for 7 days, or evicted at the 1000-game cap; never reloaded |
| `corrupt/` | Saves that couldn't be read at startup, moved aside so the server still starts |
| `instance.lock` | Marks the running server (`{hostname, pid, startedAt}`) |

- **When it saves:** immediately after a turn ends, game over, a join, a leave and the game
  start; otherwise within 5 s of any change. Not on every action.
- **Atomic writes:** each save writes `<id>.json.tmp`, fsyncs it and renames it over the old
  file, so a crash never leaves a half-written save. A stray `.tmp` after a crash is harmless.
- **Restart and resume:** on startup every file in `games/` is loaded. Players start as
  disconnected, and turn timers wait until someone is back. Browsers reconnect by themselves
  and resume their seats.
- **Graceful stop** (SIGTERM, e.g. `docker stop` or a redeploy, or Ctrl+C): the server stops
  accepting, saves every game, closes sockets with code 1012 (clients reconnect) and exits 0.
  If a save still fails after 2 retries it logs `[rooms] FAILED to save: <ids>` and exits 1.
- **Hard kill** (SIGKILL, power loss): loses at most the last ~5 s of mid-turn actions, since
  turn ends are saved right away. Sequence numbers can then repeat, so clients must never
  dedupe by `seq`.
- **Cleanup:**
  - A lobby with no connected player for 30 min is deleted.
  - A game over moves to `finished/`; it stays visible to its players for about a minute.
  - An active game with nobody connected for 7 days moves to `abandoned/`.
  - At 1000 games, creating a new one first evicts the longest-idle unattended game (idle
    ≥ 1 h).
  - To bring an abandoned game back, move its file into `games/` while the server is stopped.
- **One server per data directory.** State lives in process memory, so only one instance may
  use a `DATA_DIR`. A second server on the same directory refuses to start: it logs
  `another instance is using DATA_DIR (<host>/<pid>)…` and exits 1. A lock left by a crash is
  ignored once its process is gone, or after 30 s.

---

## Testing

```sh
npm test
```

Runs every suite with `node:test` (about 290 tests in about 10 s; passes on Node 20 and 24):

- **Engine unit tests:** movement and GO, doubles and three-doubles jail, buying, rent
  (monopolies, railroads, utilities, mortgages), taxes, cards and decks, jail escapes,
  building and selling (including the house shortage), mortgages, debt, bankruptcy to a player
  or the bank, resigning, TIMEOUT auto-play, auctions (bids, passes, the clock, resignations),
  trading (validation, fees, the in-debt rule, the per-turn limit, answering a named offer),
  `legalActions`, the lobby, the RNG, determinism (same seed + same actions = same state), and
  "failed actions never change the state".
- **Simulation:** 150 seeded bot games with random timeouts and resignations; the bots bid in
  auctions and trade for the missing lot of a colour group, and all 150 games reach game over.
  After every action it checks the invariants: cash never negative, houses and hotels conserved,
  the input state never mutated, the cash and pot changes described by the events match the new
  state, auction and trade bookkeeping, and every listed legal action succeeds (unlisted ones fail). Five games are replayed from a
  JSON copy of their start state and must come out identical.
- **Server integration:** starts real servers on temporary data directories. Covers the HTTP
  API, the WebSocket protocol, seat resume, restart-and-resume, stale-action (`seq`) rejection,
  rate limits and connection caps, corrupt saves, a failed save at shutdown, and the instance
  lock. Also turn-timer unit tests (including the auction clock and its 2-minute limit).

**Bot playtest** against a running server:

```sh
npm start                                        # in one terminal
npm run playtest -- --bots 4                     # in another
npm run playtest -- --url http://localhost:3000 --bots 6 --max-turns 300 --think 50 --json
```

Options: `--url`, `--bots 2-6` (default 4), `--max-turns` (default 500), `--think <ms>`,
`--seed`, `--cash`, `--turn-timeout <s>`, `--timeout <s>` (wall clock, default 300),
`--keep` (leave the game running at the turn cap), `--json`, `--verbose`. The exit code is 0
if the game ended (game over or turn cap) with no errors sent to the bots. The summary lists
each bot's result, then the auctions (and how many sold), trades proposed and accepted, turn
timeouts, reconnects, and "lost races": actions another player's move beat to it, such as a bid
that was outbid a moment earlier (`BID_TOO_LOW`). Those are part of play, not errors. With
auctions and trading, 4- and 6-bot games normally reach game over in 100–200 turns.

---

## Deploying on Coolify

The repo includes a `Dockerfile` (node:24-alpine, `npm ci --omit=dev`, runs
`node server/index.js`, sets `PORT=3000` and `DATA_DIR=/data`, and has a HEALTHCHECK on
`/health`).

1. **New Resource → Application**, pick your Git repository and branch.
2. **Build Pack: Dockerfile.** Coolify preselects Nixpacks; change it. Nixpacks would pick
   Node 20 (end of life), have no health check, and (unless `DATA_DIR=/data` is set) save
   games inside the container.
   Base directory `/`, Dockerfile `/Dockerfile`.
3. **Network:** Ports Exposes = `3000`. Leave **Ports Mappings empty**; Traefik handles
   ingress.
4. **Domain:** e.g. `https://monopoly.example.com`, with DNS pointing at the Coolify server. It
   must be the **root** of a (sub)domain: the client uses absolute paths (`/ws`, `/api/...`,
   `/style.css`), so path-prefix deployments break. The `https://` prefix gets a Let's Encrypt
   certificate. WebSockets (`wss://…/ws`) work through Traefik with no extra labels.
5. **Persistent Storage → Add → Volume Mount:** name e.g. `monopoly-data`, Destination Path
   `/data`. Exactly one volume. Without it, every game is lost on each redeploy. If you
   override `DATA_DIR`, it must equal the mount path.
6. **Environment variables:** none needed. Optionally add `LIMIT_*` or `TRUST_PROXY` (see
   [Configuration](#configuration)). If you change Ports Exposes, set `PORT` to match.
7. **Advanced → enable "Consistent Container Names". This is required.** It turns off rolling
   updates, so the old container is stopped (SIGTERM, games saved) before the new one starts
   on the same volume. With rolling updates, two instances would share `/data` for a while and
   moves would be lost. The server refuses to start while another live instance holds the lock,
   and says why in the log. Don't work around this with a Ports Mapping. Run exactly one
   instance.
8. **Health check:** the Dockerfile's HEALTHCHECK (every 5 s) marks the container healthy. If
   you configure one in the dashboard instead, use `GET /health` on port 3000, expecting 200.
   The default Stop Grace Period (30 s) is plenty; saving takes milliseconds.
9. **Deploy**, then check `https://<domain>/health` returns `{"ok":true,…}`. The log shows
   `[rooms] restored N game(s)` and `[server] listening on http://localhost:3000 (data: /data)`.
   The "localhost" there is only cosmetic.

**What a redeploy does:**

1. The new image builds while the old container keeps serving.
2. Coolify stops the old container with SIGTERM. It saves every game, closes sockets with 1012
   and exits.
3. The new container loads every game from `/data`.
4. Browsers reconnect (with random backoff, at most 15 s) and resume their seats. As long as
   the old container got SIGTERM, nothing is lost.

In the deploy log, check that the old container is stopped with `docker stop --time=…`. Some
Coolify v4 betas used `docker rm -f`, which kills without saving and loses up to the last
~5 s of play.

**Backups:** Coolify doesn't back up application volumes. For example:

```sh
docker run --rm -v <volume-name>:/data -v "$PWD":/b alpine tar czf /b/monopoly-data.tgz -C /data .
```

**Troubleshooting**

- *Sockets drop exactly every 60 s:* some Traefik versions (v2.11+, v3) are reported to close
  long-lived connections after the entrypoint `readTimeout` (60 s). Set
  `--entrypoints.https.transport.respondingTimeouts.readTimeout=0` (and the same for `http`)
  in Coolify → Servers → Proxy. Clients reconnect on their own either way.
- *Players get 429 errors behind a CDN:* the app uses the rightmost `X-Forwarded-For` entry,
  which is whatever the last proxy appended. Behind Cloudflare's proxy (orange cloud) that is
  usually a Cloudflare edge address, so many players can share one "IP". Use a DNS-only
  record, or raise `LIMIT_SOCKETS_PER_IP`, `LIMIT_UPGRADE_BURST` and `LIMIT_CREATE_BURST`.
- *Deploy stays unhealthy with "another instance is using DATA_DIR" in the log:* enable
  Consistent Container Names (step 7).

### Plain Docker

```sh
docker build -t monopoly .
docker volume create monopoly-data
docker run -d --name monopoly -p 3000:3000 -v monopoly-data:/data --restart unless-stopped monopoly
docker stop monopoly          # SIGTERM: saves every game, then exits
docker start monopoly         # games resume
docker run --rm monopoly npm test
```

To upgrade, build the new image, then `docker stop monopoly && docker rm monopoly` **before**
running the new container on the same volume.

---

## Limits and known gaps

- **Trading limits:** no counter-offers (reject and let them propose again), one pending offer
  at a time, only on your own turn, at most 5 offers per turn. Properties returned to the bank
  by a bankruptcy stay unowned (they aren't auctioned).
- **Gifts and kingmaking:** outside a debt, a player may give anything away (as the official
  rules allow), so someone about to resign can still pick who benefits. In debt, gifts are
  refused, but mortgaged properties and jail cards count as $0 there, so those can still be
  given away before a bankruptcy.
- **Auctions don't wait:** disconnected players aren't waited for, and each bid gives the others
  10 s to answer.
- **No accounts.** A seat is a secret token in one browser's storage. Clearing site data loses
  the seat, and a seat can't be moved to another device. There is no chat, no kicking players,
  and no way to hand over the host role except leaving the lobby.
- **One process, one instance.** All state is in memory, so the server can't scale
  horizontally.
- **Rule simplifications:**
  - Management actions (build, mortgage, …) only on your own turn.
  - An auto-played player in jail always rolls; it never uses a Get Out of Jail Free card.
  - Log lines say "to the bank" even when money goes to the Free Parking pot.
- **With the turn timer off,** an offline player's turn blocks the game until they return.
- **Spectator cap:** a game allows 20 watchers. Because visitors watch before they join, a lobby
  that already has 20 watchers can't be joined until some leave; a visitor turned away is sent
  back to the home page with a message.
- **No UI for old games:** finished games are kept in `finished/`, but nothing shows them.
- **The 2D client is temporary.** See [Renderer isolation](#project-layout).
