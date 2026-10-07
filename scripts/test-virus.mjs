// Runs the outbreak headless on the real map: no spread without a seed, spread when seeded,
// and a lockdown or vaccination slows it.
//
//   node scripts/test-virus.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Sim } from '../src/sim.js';
import { People } from '../src/people.js';
import { Trams } from '../src/transit.js';
import { CurberAI } from '../src/curber-ai.js';
import { Outbreak, S, I, R } from '../src/virus.js';

const map = JSON.parse(readFileSync(new URL('../public/gbg.json', import.meta.url)));
let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`ok  ${name}`);
};

function world(seedValue = 5) {
  const sim = new Sim(map, { clock: 8 * 3600 });
  const anchors = [...sim.homes, ...sim.works].map((i) => [sim.nodes[i].x, sim.nodes[i].z]);
  const people = new People(map.paths, sim, {
    walkers: Math.round(map.paths.edges.length * 0.072),
    cyclists: Math.round(map.paths.edges.length * 0.0105),
    anchors,
  });
  const trams = new Trams(map.tramLines, sim);
  const game = new Outbreak(people, { seed: seedValue, sim, trams });
  const step = (dt) => {
    sim.step(dt);
    trams.step(dt);
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
    if (t % 5400 === 0 || t % 450 === 0) rows.push(`${Math.round(t / 90)}d ${Math.round(w.game.counts().share * 1000) / 10}%`);
    
  }
  return { ...w.game.counts(), transit: w.game.fromTransit, phase: w.game.phase, rows, t: w.game.time };
}

if (!process.argv.includes('--actions-only')) {
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

check('crowded districts and transit matter', () => {
  const w = world();
  assert.ok(w.game.density.size > 20, 'density map built');
  const dense = Math.max(...w.game.density.values());
  assert.ok(dense > 1.5 && dense <= 2.5, `densest square ${dense}`);
  // People gather around homes and workplaces, not evenly: some squares hold far more than the average.
  const cells = new Map();
  for (const p of w.people.agents) {
    const k = Math.floor(p.x / 150) * 9973 + Math.floor(p.z / 150);
    cells.set(k, (cells.get(k) || 0) + 1);
  }
  const counts = [...cells.values()];
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  assert.ok(Math.max(...counts) > 3 * mean, `max ${Math.max(...counts)} vs mean ${mean.toFixed(1)}`);
  assert.ok(free.transit > 0, 'some cases came from trams and buses');
  console.log('    transit cases', free.transit, 'of', free.ever);
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

check('the computer Curber is lenient, then acts, and slows but does not erase the outbreak', () => {
  const w = world();
  const c = crowd(w.people);
  w.game.seed(c.x, c.z);
  const ai = new CurberAI(w.game);
  let noticed = null;
  const rows = [];
  for (let t = 0; t < 5400; t++) {
    w.step(1);
    ai.step();
    if (noticed === null && ai.noticedAt !== null) noticed = ai.noticedAt;
    if (t % 900 === 0) rows.push(`${Math.round(t / 90)}d ${Math.round(w.game.counts().share * 1000) / 10}%`);
  }
  const share = w.game.counts().share;
  console.log('   ', rows.join('  '), '| moves:', ai.log.map(([t, k]) => `${Math.round(t / 90)}d ${k}`).join(', '));
  assert.ok(noticed !== null, 'it noticed the outbreak');
  assert.ok(ai.log.length > 0, 'it did something');
  assert.ok(ai.log[0][0] >= noticed + 5 * 90, `first move came only ${(ai.log[0][0] - noticed) / 90} days after noticing`);
  assert.ok(ai.log[0][0] >= 12 * 90, `first move on day ${ai.log[0][0] / 90}: no grace period`);
  assert.ok(share > 0.02, `the Spreader got only ${share}`);
  assert.ok(share < free.share, `${share} vs ${free.share}`);
});

}

function fixture(n = 60) {
  const agents = Array.from({ length: n }, (_, k) => ({ x: k, z: 0, out: true, threshold: 0.5 }));
  const game = new Outbreak({ agents }, { seed: 7 });
  game.phase = 'running';
  game.points = { spreader: 1000, curber: 1000 };
  game.agents[0].inf = I;
  game.agents[0].infT = 10000;
  game.ever = 1;
  game.base.beta = 0;
  return game;
}

check('party has ten attendees, transmits, and expires', () => {
  const g = fixture();
  assert.ok(g.act('party', 0, 0));
  assert.equal(g.parties[0].members.length, 10);
  assert.equal(g.act('party', 0, 0), false);
  g.step(599);
  assert.ok(g.ever > 1);
  assert.equal(g.agents.slice(10).filter(p => p.inf !== S).length, 0);
  g.step(1);
  assert.equal(g.parties.length, 0);
  const small = fixture(9);
  assert.equal(small.act('party', 0, 0), false);
  assert.equal(small.points.spreader, 1000);
});

check('conspiracies start after five minutes and expire', () => {
  const g = fixture();
  for (const kind of ['antimask', 'antivaxx']) assert.ok(g.act(kind));
  g.step(299);
  assert.equal(g.active('antimask'), false);
  g.step(1);
  assert.ok(g.active('antimask') && g.active('antivaxx'));
  g.step(2400);
  assert.equal(g.active('antimask'), false);
  assert.equal(g.active('antivaxx'), false);
});

check('sick work selects an infectious person and lockdown takes precedence', () => {
  const g = fixture();
  g.agents[0].iso = true;
  assert.ok(g.act('sickwork', 0, 0));
  g.agents[0].out = false;
  g.enforce();
  assert.equal(g.agents[0].out, true);
  assert.ok(g.act('lockdown', 0, 0));
  g.step(60);
  assert.equal(g.agents[0].out, false);
  g.step(840);
  assert.equal(g.agents[0].workUntil > g.time, false);
});

check('vaccines roll out gradually, protection is delayed, research improves it', () => {
  const g = fixture(100);
  assert.ok(g.act('vaccines'));
  assert.ok(g.act('newvaccine'));
  g.step(119);
  assert.equal(g.agents.filter(p => p.vac).length, 0);
  g.step(601);
  assert.ok(g.agents.filter(p => p.vac).length > 0);
  const p = g.agents[1];
  p.vac = true;
  p.vacAt = g.time + 300;
  assert.equal(g.susceptibility(p), 1);
  g.step(300);
  assert.ok(Math.abs(g.susceptibility(p) - 0.35) < 1e-9);
  g.step(180);
  assert.ok(Math.abs(g.susceptibility(p) - 0.1) < 1e-9);
  assert.equal(g.act('newvaccine'), false);
});

check('distancing reduces transmission and hospitals isolate cases after construction', () => {
  function contacts(distancing) {
    const g = fixture(200);
    g.base.beta = 0.01;
    g.agents[0].infT = 10000;
    if (distancing) { g.act('distancing'); g.time = 60; }
    g.step(60);
    return g.ever;
  }
  assert.ok(contacts(true) < contacts(false));
  const g = fixture(200);
  for (const p of g.agents) { p.inf = I; p.infT = 10000; }
  assert.ok(g.act('hospitals'));
  g.step(599);
  assert.equal(g.counts().iso, 0);
  g.step(301);
  assert.ok(g.counts().iso > 0);
});

check('antimask increases cases and antivaxx reduces vaccine uptake', () => {
  function scenario(kind) {
    const g = fixture(200);
    g.time = 300;
    if (kind) { g.act(kind); g.effects[0].start = g.time; }
    if (kind === 'antivaxx' || !kind) { g.act('vaccines'); g.effects.at(-1).start = g.time; }
    g.base.beta = 0.01;
    g.step(60);
    return { ever: g.ever, vaccinated: g.agents.filter(p => p.vac).length };
  }
  const baseline = scenario();
  assert.ok(scenario('antimask').ever > baseline.ever);
  assert.ok(scenario('antivaxx').vaccinated < baseline.vaccinated);
});

check('rapid taps reward only their owner and respect the rate limit', () => {
  const g = fixture();
  assert.ok(g.rally('spreader'));
  assert.equal(g.rally('spreader'), false);
  assert.equal(g.points.spreader, 1000.3);
  assert.equal(g.points.curber, 1000);
  g.time += 3;
  assert.ok(g.rally('spreader'));
  assert.ok(g.rally('curber'));
  assert.equal(g.effort.spreader, 2);
  assert.equal(g.effort.curber, 1);
  g.phase = 'over';
  g.time += 3;
  assert.equal(g.rally('curber'), false);
});

check('ended games stop advancing', () => {
  const g = fixture();
  g.phase = 'over';
  g.step(60);
  assert.equal(g.time, 0);
});

console.log(`${passed} checks passed`);
