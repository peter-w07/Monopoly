// public/r3d/info.js — what the tile info card says (same facts as renderer2d's card): price,
// rents, owner, buildings and the rent right now. Pure; no DOM, no three.js.

const money = (n) => `$${Number(n) || 0}`;
// Where each square is in the 3D city (city design §5, §6.2).
export const HOOD = {
  brown: 'Brickworks Row', lightblue: 'Old Town', pink: 'Market Lanes', orange: 'Midtown Brownstones',
  red: 'Theatre Row', yellow: 'Downtown', green: 'Bank Quarter', darkblue: 'Harbour Heights',
};
const PLACE = {
  railroad: 'Circle Line station', utility: 'City utility', chance: 'Fortune Kiosk', community: 'Community Hall',
  tax: 'City Revenue Office', go: 'GO Plaza & City Bank', jail: 'Central Police Station', free_parking: 'Parking Plaza',
  go_to_jail: 'Police checkpoint',
};

/** The place a tile is in the 3D city: its neighbourhood (properties) or what stands there. */
export function placeOf(BOARD, i) {
  const t = BOARD?.tiles?.[i];
  if (!t) return '';
  if (t.type === 'property') return HOOD[t.group] ?? '';
  if (t.type === 'tax' && /luxury/i.test(String(t.name))) return 'The Jeweller';
  return PLACE[t.type] ?? '';
}
const isOwnable = (t) => t?.type === 'property' || t?.type === 'railroad' || t?.type === 'utility';

/**
 * @param {object} BOARD parsed board.json
 * @param {object} ctx   render context (renderer3d makeCtx)
 * @param {number} i     tile index
 * @returns {{name:string, band:string, owner:{name:string,color:string}|null, status:string[], facts:string[], where:string}|null}
 */
export function tileInfo(BOARD, ctx, i) {
  const tile = BOARD?.tiles?.[i];
  if (!tile) return null;
  const facts = [];
  const rent = Array.isArray(tile.rent) ? tile.rent : [];
  switch (tile.type) {
    case 'property':
      facts.push(`Price ${money(tile.price)} · house ${money(tile.houseCost)} · mortgage ${money(tile.mortgage)}`);
      facts.push(`Rent ${money(rent[0])} (${money(rent[0] * 2)} with the full color set)`);
      facts.push(`1–4 houses ${rent.slice(1, 5).map(money).join(' / ')} · hotel ${money(rent[5])}`);
      break;
    case 'railroad':
      facts.push(`Price ${money(tile.price)} · mortgage ${money(tile.mortgage)}`);
      facts.push(`Rent ${rent.map(money).join(' / ')} for 1–${rent.length} railroads owned`);
      break;
    case 'utility': {
      const m = tile.multipliers ?? [];
      facts.push(`Price ${money(tile.price)} · mortgage ${money(tile.mortgage)}`);
      facts.push(`Rent ${m[0]}× dice with one utility, ${m[1]}× with both`);
      break;
    }
    case 'go': facts.push(`Collect ${money(BOARD.goSalary)} salary as you pass`); break;
    case 'jail': facts.push(`Get out: pay ${money(BOARD.jailFine)}, use a card or roll doubles`); break;
    case 'go_to_jail': facts.push('Go directly to jail. Do not pass GO.'); break;
    case 'chance':
    case 'community': facts.push('Draw a card'); break;
    case 'tax': facts.push(`Pay ${money(tile.amount)}`); break;
    case 'free_parking':
      if (ctx?.state?.settings?.freeParkingPot) facts.push(`Pot: ${money(ctx.state.pot)}`);
      break;
    default: break;
  }
  const status = [];
  let owner = null;
  if (ctx?.live && isOwnable(tile)) {
    const ts = ctx.tileState.get(i);
    const p = ts?.ownerId ? ctx.byId.get(ts.ownerId) : null;
    if (!p) status.push('Unowned');
    else {
      const houses = Math.max(0, Math.min(5, Math.trunc(Number(ts.houses)) || 0));
      const mortgaged = !!ts.mortgaged;
      owner = { name: String(p.name ?? ''), color: ctx.colorOf.get(p.id) };
      status.push(`Owner: ${owner.name}${mortgaged ? ' (mortgaged)' : ''}`);
      if (houses) status.push(houses === 5 ? 'Hotel' : `${houses} house${houses > 1 ? 's' : ''}`);
      status.push(mortgaged ? 'No rent while mortgaged' : `Rent now: ${currentRent(BOARD, tile, ctx, p.id, houses)}`);
    }
  }
  const band = tile.type === 'property' ? BOARD.groups?.[tile.group]?.color ?? '' : '';
  const where = placeOf(BOARD, i);
  if (where) facts.unshift(tile.type === 'property' ? `${where} · ${BOARD.groups?.[tile.group]?.name ?? ''} set` : where);
  return { name: String(tile.name ?? ''), band, owner, status, facts, where };
}

function currentRent(BOARD, tile, ctx, ownerId, houses) {
  const rent = Array.isArray(tile.rent) ? tile.rent : [];
  const ownedBy = (i) => ctx.tileState.get(i)?.ownerId === ownerId;
  if (tile.type === 'property') {
    if (houses > 0) return money(rent[houses]);
    const set = BOARD.tiles.filter((t) => t.type === 'property' && t.group === tile.group).map((t) => t.index);
    return money((rent[0] ?? 0) * (set.every(ownedBy) ? 2 : 1));
  }
  const count = BOARD.tiles.filter((t) => t.type === tile.type && ownedBy(t.index)).length;
  if (tile.type === 'railroad') return money(rent[Math.min(count, rent.length) - 1]);
  return `${tile.multipliers?.[count - 1] ?? '?'}× dice`;
}
