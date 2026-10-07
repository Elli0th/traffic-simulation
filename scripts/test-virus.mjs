// Runs the outbreak headless on the real map: no spread without a seed, spread when seeded,
// and a lockdown or vaccination slows it.
//
//   node scripts/test-virus.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Sim } from '../src/sim.js';
import { People } from '../src/people.js';
import { Outbreak } from '../src/virus.js';

const map = JSON.parse(readFileSync(new URL('../public/gbg.json', import.meta.url)));
let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`ok  ${name}`);
};

function world(seedValue = 5) {
  const sim = new Sim(map, { clock: 8 * 3600 });
  const people = new People(map.paths, sim, {
    walkers: Math.round(map.paths.edges.length * 0.072),
    cyclists: Math.round(map.paths.edges.length * 0.0105),
  });
  const game = new Outbreak(people, { seed: seedValue });
  const step = (dt) => {
    sim.step(dt);
    people.step(dt);
    game.step(dt);
  };
  for (let t = 0; t < 300; t += 0.5) step(0.5);
  return { sim, people, game, step };
}

function crowd(people) {
  const grid = new Map();
  for (const p of people.agents) {
    if (!p.out) continue;
    const k = Math.floor(p.x / 100) * 9973 + Math.floor(p.z / 100);
    grid.set(k, (grid.get(k) || 0) + 1);
  }
  let best = null;
  for (const p of people.agents) {
    const n = grid.get(Math.floor(p.x / 100) * 9973 + Math.floor(p.z / 100)) || 0;
    if (p.out && (!best || n > best.n)) best = { n, x: p.x, z: p.z };
  }
  return best;
}

function run(hours, act) {
  const w = world();
  const c = crowd(w.people);
  w.game.seed(c.x, c.z);
  act?.(w, c);
  const rows = [];
  for (let t = 0; t < hours * 3600; t += 1) {
    w.step(1);
    if (t % 900 === 0) rows.push(`${(t / 3600).toFixed(1)}h ${Math.round(w.game.counts().share * 1000) / 10}%`);
    
  }
  return { ...w.game.counts(), phase: w.game.phase, rows, t: w.game.time };
}

check('nothing spreads before the first seed', () => {
  const w = world();
  for (let t = 0; t < 600; t++) w.step(1);
  assert.equal(w.game.counts().ever, 0);
  assert.equal(w.game.phase, 'setup');
});

let free;
check('an unchecked outbreak spreads', () => {
  free = run(1.5);
  console.log('   ', free.rows.join('  '));
  assert.ok(free.ever > 20, `only ${free.ever} caught it`);
});

check('a lockdown and vaccination slow it', () => {
  const held = run(1.5, ({ game }, c) => {
    game.points.curber = 100;
    game.lockdown(c.x, c.z, 400);
    game.vaccinate(c.x, c.z, 400);
  });
  console.log('   ', held.rows.join('  '));
  assert.ok(held.ever < free.ever, `${held.ever} vs ${free.ever}`);
});

console.log(`${passed} checks passed`);
