// Pedestrians and cyclists on the mapped footpaths and cycleways. Pure logic, no rendering.
// They wander rather than follow planned trips, but they obey the crossings: they wait for the
// green man at signals, and at zebra crossings drivers have to stop for them.

import { makeEdge, pointAt, mulberry32 } from './geometry.js';
import { demandAt } from './sim.js';

const ROAD_HALF = 5; // metres either side of a crossing's centre that count as being on the road

export class People {
  constructor(paths, sim, { walkers = 1800, cyclists = 260, seed = 3 } = {}) {
    this.sim = sim;
    this.rand = mulberry32(seed);
    this.at = []; // for each node, the path edges that meet there
    for (let k = 0; k < paths.nodes.length; k += 2) this.at.push([]);
    this.edges = [];
    this.footEdges = [];
    this.bikeEdges = [];
    for (const [a, b, bike, foot, marks, pts] of paths.edges) {
      const e = makeEdge(a, b, pts, { bike, foot, marks: [] });
      if (e.len < 1) continue;
      for (let k = 0; k < marks.length; k += 2) e.marks.push({ s: marks[k], c: sim.crossings[marks[k + 1]] });
      const idx = this.edges.push(e) - 1;
      this.at[a].push(idx);
      this.at[b].push(idx);
      if (foot) this.footEdges.push(idx);
      if (bike) this.bikeEdges.push(idx);
    }
    this.agents = [];
    for (let k = 0; k < walkers + cyclists; k++) {
      const bike = k >= walkers && this.bikeEdges.length > 0;
      const agent = {
        bike,
        speed: bike ? 4.2 + this.rand() * 2.2 : 1.05 + this.rand() * 0.55,
        // People come and go with the time of day: each is out and about once demand passes their threshold.
        threshold: this.rand(),
        shade: Math.floor(this.rand() * 8),
        wait: 0,
        x: 0, z: 0, dx: 1, dz: 0,
      };
      this.place(agent);
      this.agents.push(agent);
    }
  }

  place(agent) {
    const list = agent.bike ? this.bikeEdges : this.footEdges;
    agent.edge = list[Math.floor(this.rand() * list.length)];
    agent.dir = this.rand() < 0.5 ? 1 : -1;
    agent.s = this.rand() * this.edges[agent.edge].len;
  }

  step(dt) {
    const { sim, edges } = this;
    const time = sim.time;
    const busy = 0.15 + 0.85 * demandAt(sim.clock / 3600);
    for (const p of this.agents) {
      p.out = p.threshold < busy;
      if (!p.out) continue;
      let e = edges[p.edge];

      // Crossings: wait at the kerb until it is safe, and hold the traffic while on the road.
      let hold = false;
      let near = null;
      for (const m of e.marks) {
        const d = (m.s - p.s) * p.dir; // distance still to go to the middle of the road
        if (d > ROAD_HALF + 1.5 || d < -ROAD_HALF) continue;
        near = m.c;
        if (d > ROAD_HALF) {
          const state = sim.crossingState(m.c);
          if (state) {
            hold = true;
            if (state === 2) m.c.claim = time + 2; // drivers must give way at a zebra crossing
          }
        }
        // Traffic waits only for as long as it takes to walk across. Someone who lingers by the
        // crossing, or potters about on a short path beside it, does not hold the road for ever.
        // (The clock starts when they step off the kerb, not while they stand waiting at it.)
        if (p.crossing !== m.c || hold) {
          p.crossing = m.c;
          p.crossingUntil = time + (2 * ROAD_HALF + 2) / p.speed + 2;
        }
        if (!hold && time < p.crossingUntil) m.c.until = time + 1.2;
      }
      if (!near) p.crossing = null;
      if (hold) {
        p.wait += dt;
        continue;
      }
      p.wait = 0;

      p.s += p.dir * p.speed * dt;
      if (p.s > e.len || p.s < 0) {
        // At a junction of paths: carry on along any other path this person can use.
        const node = p.s > e.len ? e.b : e.a;
        const options = this.at[node].filter((k) => k !== p.edge && (p.bike ? edges[k].bike : edges[k].foot));
        if (options.length) {
          p.edge = options[Math.floor(this.rand() * options.length)];
          e = edges[p.edge];
          p.dir = e.a === node ? 1 : -1;
          p.s = p.dir > 0 ? 0 : e.len;
        } else {
          p.dir = -p.dir;
          p.s = Math.max(0, Math.min(e.len, p.s));
        }
      }
      pointAt(e, p.s, p);
      if (p.dir < 0) {
        p.dx = -p.dx;
        p.dz = -p.dz;
      }
    }
  }
}
