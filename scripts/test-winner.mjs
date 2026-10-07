// Checks who wins a round of the outbreak game, the government's approval, and cars carrying the
// virus, on a handful of made-up people rather than the whole city, so it runs in a moment.
//
//   node scripts/test-winner.mjs

import assert from 'node:assert/strict';
import { Outbreak, TAKEOVER, DAY, S, I } from '../src/virus.js';
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

check('time running out with the virus held back is a win for the Curber', () => {
  const { game } = crowd(400, 200); // too far apart to pass it on
  game.seed(0, 0, 250);
  run(game, 60);
  game.finish();
  assert.equal(game.winner, 'curber');
  assert.equal(game.phase, 'over');
});

check('stamping the outbreak out is a win for the Curber', () => {
  const { game } = crowd(400, 200);
  game.seed(0, 0, 250);
  run(game, 20 * DAY);
  assert.equal(game.winner, 'curber');
  assert.match(game.reason, /stamped out/);
});

check(`the Spreader wins the moment ${TAKEOVER * 100}% of the city has caught it`, () => {
  const { game } = crowd(40, 3); // shoulder to shoulder
  game.seed(60, 0, 20);
  run(game, 30 * DAY);
  assert.equal(game.winner, 'spreader');
  assert.ok(game.ever / game.total >= TAKEOVER && game.ever / game.total < TAKEOVER + 0.1);
});

check('lockdowns and distancing cost approval; doing nothing costs none', () => {
  const { game } = crowd(400, 200);
  game.seed(0, 0, 250);
  run(game, 5);
  assert.equal(game.approval, 100);
  game.points.curber = 100;
  assert.ok(game.act('distancing'));
  run(game, 5 * DAY);
  const afterDistancing = game.approval;
  assert.ok(afterDistancing < 100 && afterDistancing > 90, `approval ${afterDistancing}`);
});

check('a government that locks down everywhere falls, and the Spreader wins', () => {
  const { game, agents } = crowd(400, 200);
  for (const p of agents) p.threshold = 0; // essential workers: the lockdowns do not send them home
  game.seed(0, 0, 250);
  game.base.infectious = 1e9; // keep the outbreak alive for as long as the test needs
  for (let t = 0; t < 60 * DAY && game.phase === 'running'; t++) {
    game.points.curber = 100;
    game.act('lockdown', (t % 50) * 1000, 5000);
    game.step(1);
  }
  assert.equal(game.winner, 'spreader');
  assert.equal(game.approval, 0);
  assert.match(game.reason, /confidence/);
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
  assert.equal(s.goal, TAKEOVER);
  assert.ok(s.history.length > 1 && s.history.at(-1)[0] <= DAYS);
  assert.ok(s.history.every(([day, n]) => day >= 0 && Number.isInteger(n)));
});

console.log(`\n${passed} checks passed`);
