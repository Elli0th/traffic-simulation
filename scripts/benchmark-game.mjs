import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Sim } from '../src/sim.js';
import { People } from '../src/people.js';
import { Outbreak } from '../src/virus.js';
import { stepOutbreakWorld, GAME_STEP } from '../src/game-runtime.js';
const map = JSON.parse(readFileSync(new URL('../public/gbg.json', import.meta.url)));
for (const light of [false, true]) {
  const sim = new Sim(map);
  const people = new People(map.paths, sim, { walkers: Math.round(map.paths.edges.length * .072), cyclists: Math.round(map.paths.edges.length * .0105) });
  const game = new Outbreak(people);
  const dt = light ? GAME_STEP : .12;
  const start = performance.now();
  for (let t = 0; t < 120; t += dt) {
    if (light) stepOutbreakWorld(sim, people, game, dt);
    else { sim.step(dt); people.step(dt); game.step(dt); }
  }
  console.log(`${light ? 'Outbreak loop' : 'Previous traffic loop'}: ${(performance.now() - start).toFixed(0)} ms for 120 simulated seconds (${people.agents.length} people)`);
}
