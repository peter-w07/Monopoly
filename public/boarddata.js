// Static board data (tile names, prices, colors, tokens) shared by the UI and the renderer.
// Fetched once from the server, which serves engine/data/board.json at /api/board.
export const BOARD = await fetch('/api/board').then((r) => {
  if (!r.ok) throw new Error(`GET /api/board failed with HTTP ${r.status}`);
  return r.json();
});
