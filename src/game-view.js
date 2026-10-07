// Shared geometry and visibility rules for the two player views.
export const GAME_HEADER = 112;
export const GAME_CONTROLS = 0;
export const SIDES = ['spreader', 'curber'];
// In the one-player game there is one map, the Spreader's, across the whole width.
export const GAME_LOG = 280; // width of the notification column beside the map in the one-player game
let single = false;
export const setSinglePlayer = (on) => { single = on; };
export const isSinglePlayer = () => single;
export const activeSides = () => (single ? ['spreader'] : SIDES);
export function controlWidth(width) { return Math.max(180, Math.min(240, width * 0.15)); }
export function gameRect(side, width, height) {
  const rail = controlWidth(width), half = Math.floor(width / 2);
  return { x: side === 'spreader' ? rail : half, y: GAME_HEADER,
    width: single ? Math.max(1, width - rail - GAME_LOG) : Math.max(1, (side === 'spreader' ? half : width - half) - rail),
    height: Math.max(1, height - GAME_HEADER) };
}
export function sideAt(x, y, width, height) {
  for (const side of activeSides()) {
    const r = gameRect(side, width, height);
    if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) return side;
  }
  return null;
}
export function ownsAction(side, kind, actions) { return actions[kind]?.side === side; }
export function privateOverlays(game, side) {
  if (side === 'spreader') return game.parties.filter(p => p.until > game.time).map(p => ({ x: p.x, z: p.z, r: 35 }));
  return game.lockdowns.filter(z => (z.start || 0) <= game.time && z.until > game.time);
}
export function publicCounts(counts) {
  return { infected: counts.e + counts.i, noninfected: counts.s + counts.r };
}

export function actionState(event, time) {
  if (time < event.start) return { label: 'Pending', seconds: event.start - time };
  if (time >= event.until) return { label: 'Finished', seconds: 0 };
  return { label: 'Active', seconds: event.until === Infinity ? Infinity : event.until - time };
}
export function nearestPlace(labels, x, z) {
  let best = null, dist = Infinity;
  for (const [name, px, pz] of labels) {
    const d = Math.hypot(px - x, pz - z);
    if (d < dist) { best = name; dist = d; }
  }
  return best ? `Near ${best}` : 'Selected location';
}
export function ownedEvents(game, side, actions) {
  return game.actionLog.filter(e => ownsAction(side, e.kind, actions));
}
