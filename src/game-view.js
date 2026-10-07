// Shared geometry and visibility rules for the two player views.
export const GAME_HEADER = 112;
export const GAME_CONTROLS = 224;
export const SIDES = ['spreader', 'curber'];
export function gameRect(side, width, height) {
  const left = Math.floor(width / 2);
  return { x: side === 'spreader' ? 0 : left, y: GAME_HEADER,
    width: side === 'spreader' ? left : width - left,
    height: Math.max(1, height - GAME_HEADER - GAME_CONTROLS) };
}
export function sideAt(x, y, width, height) {
  if (x < 0 || x >= width || y < GAME_HEADER || y >= height - GAME_CONTROLS) return null;
  return x < Math.floor(width / 2) ? 'spreader' : 'curber';
}
export function ownsAction(side, kind, actions) { return actions[kind]?.side === side; }
export function privateOverlays(game, side) {
  if (side === 'spreader') return game.parties.filter(p => p.until > game.time).map(p => ({ x: p.x, z: p.z, r: 35 }));
  return game.lockdowns.filter(z => (z.start || 0) <= game.time && z.until > game.time);
}
export function publicCounts(counts) {
  return { infected: counts.e + counts.i, noninfected: counts.s + counts.r };
}
