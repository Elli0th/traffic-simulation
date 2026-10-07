import assert from 'node:assert/strict';
import { gameRect, sideAt, ownsAction, privateOverlays, publicCounts, actionState, nearestPlace, ownedEvents } from '../src/game-view.js';
import { ACTIONS } from '../src/virus.js';
for (const width of [800, 801, 1920]) {
  const a = gameRect('spreader', width, 900), b = gameRect('curber', width, 900);
  assert.equal(a.width + b.width, width);
  assert.equal(a.x + a.width, b.x);
  assert.equal(a.height, b.height);
  assert.equal(sideAt(a.width - 1, 200, width, 900), 'spreader');
  assert.equal(sideAt(a.width, 200, width, 900), 'curber');
  assert.equal(sideAt(100, 40, width, 900), null);
  assert.equal(sideAt(100, 899, width, 900), null);
}
for (const [kind, action] of Object.entries(ACTIONS)) {
  assert.ok(ownsAction(action.side, kind, ACTIONS));
  assert.equal(ownsAction(action.side === 'curber' ? 'spreader' : 'curber', kind, ACTIONS), false);
}
const party = { x: 20, z: 30, until: 400 };
const lockdown = { x: 40, z: 50, r: 220, start: 60, until: 500 };
const game = { time: 100, parties: [party], lockdowns: [lockdown, { ...lockdown, start: 200 }] };
assert.deepEqual(privateOverlays(game, 'spreader'), [{ x: 20, z: 30, r: 35 }]);
assert.deepEqual(privateOverlays(game, 'curber'), [lockdown]);
game.time = 600;
assert.deepEqual(privateOverlays(game, 'spreader'), []);
assert.deepEqual(privateOverlays(game, 'curber'), []);
assert.deepEqual(publicCounts({ s: 10, e: 2, i: 3, r: 5, iso: 2 }), { infected: 5, noninfected: 15 });
console.log('Split-view geometry, action ownership, private overlays and public counts passed.');

assert.deepEqual(actionState({ start: 60, until: 180 }, 30), { label: 'Pending', seconds: 30 });
assert.deepEqual(actionState({ start: 60, until: 180 }, 60), { label: 'Active', seconds: 120 });
assert.deepEqual(actionState({ start: 60, until: 180 }, 180), { label: 'Finished', seconds: 0 });
assert.equal(actionState({ start: 0, until: Infinity }, 500).seconds, Infinity);
assert.equal(nearestPlace([['Centre', 10, 10], ['Harbour', 500, 500]], 15, 12), 'Near Centre');
assert.deepEqual(ownedEvents({ actionLog: [{ kind: 'party' }, { kind: 'lockdown' }] }, 'spreader', ACTIONS), [{ kind: 'party' }]);
console.log('Action countdowns, location names and private action history passed.');
