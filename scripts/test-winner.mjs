// Checks that a round has no winner and just runs to the end, and cars carrying the virus, on a handful of made-up people rather than the whole city, so it runs in a moment.
//
//   node scripts/test-winner.mjs

import assert from 'node:assert/strict';
import { Outbreak, DAY, S, I } from '../src/virus.js';
import { boardState, DAYS } from '../src/virus-board.js';

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`ok  ${name}`);
};

// `count` people standing `gap` metres apart in a row, all out of doors.
function crowd(count, gap, sim = null) {
  const agents = [];
  for (let k = 0; k < count; k++) agents.push({ x: k * gap, z: 0, out: true, threshold: 0.5 });
  const game = new Outbreak({ agents, sim }, { sim });
  return { agents, game };
}
const run = (game, seconds) => {
  for (let t = 0; t < seconds && game.phase === 'running'; t++) game.step(1);
};

check('there is no winner: the round runs until time is up, whatever has happened', () => {
  const { game } = crowd(40, 3); // shoulder to shoulder: the whole crowd catches it
  game.seed(60, 0, 20);
  run(game, 40 * DAY);
  assert.ok(game.ever / game.total > 0.5, 'it spread well past a third of the city');
  assert.equal(game.phase, 'running');
  assert.equal(game.winner, undefined);
  assert.equal(game.approval, undefined);
  game.finish();
  assert.equal(game.phase, 'over');
});

check('stamping the outbreak out does not end the round either', () => {
  const { game } = crowd(400, 200); // too far apart to pass it on
  game.seed(0, 0, 250);
  run(game, 20 * DAY);
  assert.equal(game.counts().active, 0);
  assert.equal(game.phase, 'running');
});

check('lockdowns and distancing cost nothing but the people they keep at home', () => {
  const { game } = crowd(400, 200);
  game.seed(0, 0, 250);
  game.points.curber = 100;
  assert.ok(game.act('distancing'));
  assert.ok(game.act('lockdown', 0, 0));
  run(game, 5 * DAY);
  assert.equal(game.phase, 'running');
});

check('a driver who has been among the infectious carries it to the end of the trip', () => {
  const sim = { nodes: [{ x: 0, z: 0 }, { x: 5000, z: 0 }, { x: 9000, z: 0 }], gateSet: new Set([2]), homes: [], works: [], cars: [], edges: [] };
  const agents = [];
  for (let k = 0; k < 8; k++) agents.push({ x: k * 2, z: 30, out: true, threshold: 0.5 }); // around the start
  for (let k = 0; k < 8; k++) agents.push({ x: 5000 + k * 2, z: 30, out: true, threshold: 0.5 }); // around the end
  const game = new Outbreak({ agents, sim }, { sim });
  game.phase = 'running';
  game.rate = game.base.beta;
  for (let k = 0; k < 8; k++) agents[k].inf = I;
  let carried = 0;
  for (let k = 0; k < 40; k++) {
    const car = { kind: 'car', dest: 1 };
    sim.onLaunch(car, 0);
    if (car.load > 0) carried++;
    sim.onArrive(car);
  }
  assert.ok(carried > 30, `${carried} of 40 cars carried it`);
  assert.ok(game.fromCars > 0);
  assert.ok(agents.slice(8).some((p) => p.inf !== S));

  const outsider = { kind: 'car', dest: 1 };
  sim.onLaunch(outsider, 2); // a trip from beyond the edge of the map
  assert.equal(outsider.load, 0);
});

check('the screens are told the round in real people, with the curve in days', () => {
  const { game } = crowd(400, 200);
  game.seed(0, 0, 250);
  run(game, 2 * DAY);
  const s = boardState(game);
  assert.equal(s.infected + s.noninfected, game.population);
  assert.equal(s.day, 3);
  assert.ok(s.history.length > 1 && s.history.at(-1)[0] <= DAYS);
  assert.ok(s.history.every(([day, n]) => day >= 0 && Number.isInteger(n)));
});

console.log(`\n${passed} checks passed`);
