import assert from 'node:assert/strict';
import { stepOutbreakWorld } from '../src/game-runtime.js';
const sim = { time: 0, clock: 86399, stepSignals(dt) { this.signals = (this.signals || 0) + dt; }, step() { throw Error('Full traffic loop must not run'); } };
let advanced = 0;
const game = { time: 100, inLockdown: p => p.locked, step: dt => { advanced += dt; } };
const people = { step(dt, policy) {
  assert.equal(policy({ threshold: .5, locked: true }, true), false);
  assert.equal(policy({ threshold: .5, iso: true }, true), false);
  assert.equal(policy({ threshold: .5, iso: true, workUntil: 200, inf: 2 }, false), true);
  assert.equal(policy({ threshold: .5, locked: true, workUntil: 200, inf: 2 }, true), false);
  assert.equal(policy({ threshold: .5 }, true), true);
} };
stepOutbreakWorld(sim, people, game, 2);
assert.equal(sim.time, 2);
assert.equal(sim.clock, 1);
assert.equal(sim.signals, 2);
assert.equal(advanced, 2);
console.log('Lightweight clock, crossing signals, isolation and lockdown movement passed.');
