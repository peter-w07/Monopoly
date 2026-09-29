// Play a whole game with headless bots against a running server and print a summary.
//
//   npm run playtest -- --url http://localhost:3000 --bots 4
//   node scripts/playtest.js --bots 6 --max-turns 300 --think 50 --json
//
// Options (all optional):
//   --url <base>         server base URL (default $PLAYTEST_URL or http://localhost:3000)
//   --bots <n>           number of bots, 2–6 (default 4)
//   --max-turns <n>      stop once the turn number passes this (default 500)
//   --think <ms>         bot think delay per move (default 0)
//   --seed <n>           seed for the bots' decisions (default 1)
//   --cash <n>           starting cash setting
//   --turn-timeout <s>   turnTimeoutSec setting (default: server default)
//   --timeout <s>        give up after this many seconds of wall-clock time (default 300)
//   --keep               at the turn cap, leave the game running instead of resigning the bots
//   --json               print the summary as JSON
//   --verbose            log bot errors and socket problems as they happen
//
// Exit code: 0 if the game ended (game over or turn cap) and no bot received an error message, else 1.
// (An action that lost a race to another player's move, e.g. a bid that was outbid in the meantime,
// is counted under "races", not as an error.)

import { pathToFileURL } from 'node:url';
import { TOKENS, netWorth } from '../engine/index.js';
import { BotClient } from './bot-client.js';

const STALL_MS = 30_000; // no progress for this long (and no turn timer to rescue it) = stuck

/**
 * Run one bot game and return a summary. Throws only if the game can't be set up (server unreachable,
 * create/join failed); problems during play are reported in the summary (`errors`, `problems`).
 * @param {object} opts see the CLI options above (camelCase)
 */
export async function playtest({
  url = 'http://localhost:3000', bots = 4, maxTurns = 500, thinkMs = 0, seed = 1,
  settings = {}, timeoutMs = 300_000, keep = false, log = null,
} = {}) {
  if (!Number.isInteger(bots) || bots < 2 || bots > 6) throw new Error('bots must be 2–6');
  const base = url.replace(/\/+$/, '');
  const wsUrl = `${base.replace(/^http/, 'ws')}/ws`;
  const started = Date.now();
  const problems = [];

  const res = await fetch(`${base}/api/games`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  });
  if (res.status !== 201) throw new Error(`POST /api/games → ${res.status} ${await res.text()}`);
  const { gameId } = await res.json();

  // A spectator that watches every broadcast (counts events; never acts).
  const observer = new BotClient({ url: wsUrl, gameId, name: 'observer', join: false, log });
  const players = [];
  const eventCounts = {};
  let lastProgress = Date.now();
  let lastSeq = -1;
  observer.on('state', ({ state, events }) => {
    for (const e of events) eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1;
    if (state.seq !== lastSeq) {
      lastSeq = state.seq;
      lastProgress = Date.now();
    }
  });

  try {
    observer.connect();
    await observer.waitFor((b) => b.state, 10_000, 'observer state');

    // Join one at a time so turn order = bot order and bot 1 is the host.
    for (let i = 0; i < bots; i++) {
      const bot = new BotClient({
        url: wsUrl, gameId, name: `Bot ${i + 1}`, piece: TOKENS[i].id,
        startAt: bots, thinkMs, seed: seed * 1000 + i, log,
      });
      players.push(bot);
      bot.connect();
      await bot.waitFor((b) => b.playerId, 10_000, 'welcome');
    }

    const outcome = await waitForOutcome(observer, { maxTurns, started, timeoutMs, stalledSince: () => lastProgress });

    // The state the summary describes: the final one, or the one at the turn cap (before resignations).
    const shown = observer.state;
    if (outcome === 'turn_cap' && !keep) await resignAllButLeader(players, observer, shown);
    if (outcome === 'stalled' || outcome === 'timeout') problems.push(`game ${outcome} at seq ${shown.seq}`);

    return {
      gameId,
      bots,
      outcome,
      turns: shown.turn.number,
      actions: shown.seq,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      winner: nameOf(shown, shown.winnerId),
      leader: outcome === 'turn_cap' ? leaderOf(shown)?.name ?? null : null,
      players: shown.players.map((p) => ({
        name: p.name,
        piece: p.token,
        cash: p.cash,
        netWorth: netWorth(shown, p.id),
        properties: shown.tiles.filter((t) => t.ownerId === p.id).length,
        bankrupt: p.bankrupt,
      })),
      timeouts: eventCounts.timeout ?? 0,
      events: eventCounts,
      errors: players.flatMap((b) => b.errors.map((e) => ({ bot: b.name, ...e }))),
      races: players.reduce((n, b) => n + b.races.length, 0), // lost to another player's move; not errors
      raceCodes: tally(players.flatMap((b) => b.races.map((e) => `${e.code} (${e.action})`))),
      reconnects: players.reduce((n, b) => n + Math.max(0, b.connects - 1), 0),
      problems,
    };
  } finally {
    for (const bot of players) bot.close();
    observer.close();
  }
}

/** Resolve with 'finished', 'turn_cap', 'stalled' (no progress, no turn timer) or 'timeout'. */
function waitForOutcome(observer, { maxTurns, started, timeoutMs, stalledSince }) {
  return new Promise((resolve) => {
    const done = (value) => {
      clearInterval(poll);
      observer.off('state', check);
      resolve(value);
    };
    const check = () => {
      const s = observer.state;
      if (s.status === 'finished') return done('finished');
      if (s.status === 'active' && s.turn.number > maxTurns) return done('turn_cap');
      const timersOn = s.settings.turnTimeoutSec > 0; // a turn timer eventually moves a stuck game on
      if (!timersOn && Date.now() - stalledSince() > STALL_MS) return done('stalled');
      if (Date.now() - started > timeoutMs) return done('timeout');
    };
    const poll = setInterval(check, 500);
    observer.on('state', check);
    check();
  });
}

// At the turn cap: everyone but the richest bot resigns (LEAVE = bankrupt to the bank), so the
// game still ends cleanly on the server instead of lingering with nobody connected.
async function resignAllButLeader(players, observer, state) {
  const leaderId = leaderOf(state)?.id;
  for (const bot of players) bot.stopped = true; // no new moves
  await Promise.all(players.map((b) => b.waitFor((x) => !x.inFlight, 5000, 'in-flight move').catch(() => {})));
  for (const bot of players) {
    const me = observer.state.players.find((p) => p.id === bot.playerId);
    if (!me || me.bankrupt || bot.playerId === leaderId || observer.state.status !== 'active') continue;
    const seq = observer.state.seq;
    bot.resign();
    await observer.waitFor((o) => o.state.seq > seq, 5000, 'resignation').catch(() => {});
  }
}

function leaderOf(state) {
  if (!state) return null;
  const alive = state.players.filter((p) => !p.bankrupt);
  return alive.reduce((best, p) => (!best || netWorth(state, p.id) > netWorth(state, best.id) ? p : best), null);
}

const nameOf = (state, id) => state?.players.find((p) => p.id === id)?.name ?? null;

/** ['a', 'b', 'a'] → { a: 2, b: 1 } */
function tally(list) {
  const counts = {};
  for (const item of list) counts[item] = (counts[item] ?? 0) + 1;
  return counts;
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const opts = { url: process.env.PLAYTEST_URL || 'http://localhost:3000', settings: {} };
  const num = (v, flag) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${flag} needs a number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    switch (flag) {
      case '--url': opts.url = next(); break;
      case '--bots': opts.bots = num(next(), flag); break;
      case '--max-turns': opts.maxTurns = num(next(), flag); break;
      case '--think': opts.thinkMs = num(next(), flag); break;
      case '--seed': opts.seed = num(next(), flag); break;
      case '--cash': opts.settings.startingCash = num(next(), flag); break;
      case '--turn-timeout': opts.settings.turnTimeoutSec = num(next(), flag); break;
      case '--timeout': opts.timeoutMs = num(next(), flag) * 1000; break;
      case '--keep': opts.keep = true; break;
      case '--json': opts.json = true; break;
      case '--verbose': opts.log = (line) => console.error(line); break;
      case '-h':
      case '--help':
        opts.help = true; break;
      default:
        throw new Error(`unknown option ${flag} (try --help)`);
    }
  }
  return opts;
}

function printSummary(s) {
  const money = (n) => `$${n.toLocaleString('en-US')}`;
  const how = {
    finished: `game over after ${s.turns} turns`,
    turn_cap: `stopped at the turn cap (turn ${s.turns}); leader ${s.leader}`,
    stalled: 'STALLED (no progress)',
    timeout: 'TIMED OUT',
  }[s.outcome];
  console.log(`Game ${s.gameId} with ${s.bots} bots: ${how}, ${s.actions} actions, ${s.seconds}s`);
  if (s.winner) console.log(`Winner: ${s.winner}`);
  for (const p of s.players) {
    const status = p.bankrupt ? 'bankrupt' : `${money(p.cash)} cash, net worth ${money(p.netWorth)}, ${p.properties} properties`;
    console.log(`  ${p.name.padEnd(6)} ${p.piece.padEnd(11)} ${status}`);
  }
  const n = (type) => s.events[type] ?? 0;
  console.log(`Auctions: ${n('auction_started')} (${n('auction_won')} sold)   ` +
    `Trades: ${n('trade_proposed')} proposed, ${n('trade_accepted')} accepted`);
  const raced = Object.entries(s.raceCodes).map(([what, count]) => `${count}× ${what}`).join(', ');
  console.log(`Turn timeouts: ${s.timeouts}   Reconnects: ${s.reconnects}   Lost races: ${s.races}${raced ? ` (${raced})` : ''}`);
  console.log(`Error messages received by bots: ${s.errors.length}`);
  for (const e of s.errors) console.log(`  ${e.bot}: ${e.code} ${e.message} (action ${e.action}, phase ${e.phase}, seq ${e.seq})`);
  for (const p of s.problems) console.log(`Problem: ${p}`);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (opts.help) {
    console.log('Usage: node scripts/playtest.js [--url URL] [--bots 2-6] [--max-turns N] [--think MS] [--seed N]\n' +
      '       [--cash N] [--turn-timeout SEC] [--timeout SEC] [--keep] [--json] [--verbose]');
    return;
  }
  const summary = await playtest(opts);
  if (opts.json) console.log(JSON.stringify(summary, null, 2));
  else printSummary(summary);
  const ok = ['finished', 'turn_cap'].includes(summary.outcome) && summary.errors.length === 0;
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    const cause = err.cause ? ` (${err.cause.code ?? err.cause.message})` : '';
    console.error(`playtest failed: ${err.message}${cause}`);
    process.exit(1);
  });
}
