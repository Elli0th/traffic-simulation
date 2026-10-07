// A two-player outbreak game on top of the pedestrians. Pure logic, no rendering.
// Fictional accelerated gameplay: timed social actions, vaccination and isolation.
// Parties add group contacts; ordinary exposure follows pedestrian proximity.

import { mulberry32 } from './geometry.js';

export const S = 0; // susceptible
export const E = 1; // exposed: carrying it but not yet infectious
export const I = 2; // infectious
export const R = 3; // recovered or vaccinated

export const ACTIONS = {
  party: { side: 'spreader', cost: 8, delay: 0, duration: 600, cooldown: 300, label: 'Start a party (10 pax)' },
  antimask: { side: 'spreader', cost: 14, delay: 300, duration: 1800, cooldown: 2100, label: 'Antimask conspiracy' },
  antivaxx: { side: 'spreader', cost: 16, delay: 300, duration: 2400, cooldown: 2700, label: 'Antivaxx conspiracy' },
  sickwork: { side: 'spreader', cost: 10, delay: 0, duration: 900, cooldown: 300, label: 'Send someone sick to work' },
  lockdown: { side: 'curber', cost: 12, delay: 60, duration: 1800, cooldown: 120, label: 'Lockdown' },
  vaccines: { side: 'curber', cost: 15, delay: 120, duration: 1800, cooldown: 2100, label: 'Free vaccines' },
  distancing: { side: 'curber', cost: 18, delay: 60, duration: 1800, cooldown: 1860, label: 'Social distancing' },
  hospitals: { side: 'curber', cost: 22, delay: 600, duration: Infinity, cooldown: Infinity, label: 'New hospitals' },
  newvaccine: { side: 'curber', cost: 28, delay: 1200, duration: Infinity, cooldown: Infinity, label: 'New vaccine' },
};

const TICK = 1; // simulated seconds between contact passes

export class Outbreak {
  constructor(people, { seed = 11 } = {}) {
    this.people = people;
    this.rand = mulberry32(seed);
    this.agents = people.agents;
    for (const p of this.agents) {
      p.inf = S;
      p.infT = 0;
      p.iso = false;
      p.vac = false;
      p.vacAt = 0;
      p.workUntil = 0;
    }
    this.acc = 0;
    this.time = 0; // simulated seconds since the first seed
    this.phase = 'setup'; // setup -> running -> over (ended by the caller after the round length)
    this.ever = 0; // everyone who has caught it
    this.newSince = 0;
    this.history = []; // [time, active, ever] once per simulated minute
    this.histAt = 0;
    this.lockdowns = []; // {x, z, r, until}
    this.masksUntil = 0;
    this.testing = 0; // level of testing and tracing
    this.points = { spreader: 10, curber: 20 };
    this.virus = { spread: 1, reach: 1, stealth: 1 }; // upgrade multipliers
    this.level = { spread: 0, reach: 0, stealth: 0 };
    // Tuned so an unchecked outbreak sweeps much of the city in about 90 simulated minutes (3 minutes at 30x).
    this.base = { beta: 0.1, reach: 18, incubation: 90, infectious: 1800 };
    this.effects = [];
    this.actionLog = [];
    this.rallyAt = { spreader: -Infinity, curber: -Infinity };
    this.effort = { spreader: 0, curber: 0 };
    this.parties = [];
    this.ready = {};
    this.vaccineEfficacy = 0.65;
    this.heatCache = null;
  }

  get total() {
    return this.agents.length;
  }

  counts() {
    const c = [0, 0, 0, 0];
    let iso = 0;
    for (const p of this.agents) {
      c[p.inf]++;
      if (p.iso) iso++;
    }
    return { s: c[S], e: c[E], i: c[I], r: c[R], iso, active: c[E] + c[I], ever: this.ever, share: this.ever / this.total };
  }

  // ----- player actions: each returns true if it was done -----

  spend(side, cost) {
    if (this.points[side] < cost) return false;
    this.points[side] -= cost;
    return true;
  }

  // Seed the virus around a point. The first seed is free and starts the game.
  seed(x, z, r = 70) {
    if (this.phase === 'over') return false;
    const first = this.phase === 'setup';
    if (!first && !this.spend('spreader', 8)) return false;
    let n = 0;
    for (const p of this.agents) {
      if (p.inf !== S || p.vac || Math.hypot(p.x - x, p.z - z) > r) continue;
      this.infect(p, true);
      if (++n >= 4) break;
    }
    if (n === 0) {
      if (!first) this.points.spreader += 8;
      return false;
    }
    if (first) this.phase = 'running';
    return true;
  }

  rally(side) {
    if (this.phase !== 'running' || !Object.hasOwn(this.points, side) || this.time - this.rallyAt[side] < 3) return false;
    this.rallyAt[side] = this.time;
    this.effort[side]++;
    this.points[side] += 0.3;
    return true;
  }

  active(kind) {
    return this.effects.some(e => e.kind === kind && e.start <= this.time && e.until > this.time);
  }

  available(kind) {
    const a = ACTIONS[kind];
    return a && this.phase === 'running' && this.time >= (this.ready[kind] || 0) && this.points[a.side] >= a.cost;
  }

  act(kind, x, z) {
    if (!this.available(kind)) return false;
    const a = ACTIONS[kind];
    let members;
    if (kind === 'party' || kind === 'sickwork') {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
      members = this.agents.filter(p => Math.hypot(p.x - x, p.z - z) <= 300)
        .sort((p, q) => Math.hypot(p.x - x, p.z - z) - Math.hypot(q.x - x, q.z - z));
      if (kind === 'party') {
        members = members.slice(0, 10);
        if (members.length !== 10) return false;
      } else {
        members = members.filter(p => p.inf === I).slice(0, 1);
        if (!members.length) return false;
      }
    }
    if (kind === 'lockdown' && (!Number.isFinite(x) || !Number.isFinite(z))) return false;
    this.spend(a.side, a.cost);
    this.ready[kind] = this.time + a.cooldown;
    const start = this.time + a.delay;
    const event = { id: this.actionLog.length + 1, kind, start, until: start + a.duration,
      placed: this.time, x, z, r: kind === 'lockdown' ? 220 : kind === 'party' ? 35 : 0 };
    if (kind === 'party') event.members = members;
    if (kind === 'sickwork') event.worker = members[0];
    this.effects.push(event);
    this.actionLog.push(event);
    if (kind === 'party') this.parties.push({ members, x, z, until: start + a.duration });
    if (kind === 'sickwork') {
      members[0].workUntil = start + a.duration;
      members[0].iso = false;
    }
    if (kind === 'lockdown') this.lockdowns.push({ x, z, r: 220, start, until: start + a.duration });
    return true;
  }

  susceptibility(p) {
    return p.vac && p.vacAt <= this.time ? 1 - this.vaccineEfficacy : 1;
  }

  upgrade(kind) {
    if (this.phase !== 'running' || this.level[kind] >= 4) return false;
    if (!this.spend('spreader', 12 + 6 * this.level[kind])) return false;
    this.level[kind]++;
    if (kind === 'spread') this.virus.spread *= 1.35;
    if (kind === 'reach') this.virus.reach *= 1.25;
    if (kind === 'stealth') this.virus.stealth *= 0.6;
    return true;
  }

  lockdown(x, z, r = 220) {
    if (this.phase !== 'running' || !this.spend('curber', 12)) return false;
    this.lockdowns.push({ x, z, r, until: this.time + 3 * 3600 });
    return true;
  }

  vaccinate(x, z, r = 260) {
    if (this.phase !== 'running' || !this.spend('curber', 15)) return false;
    for (const p of this.agents) {
      if (Math.hypot(p.x - x, p.z - z) > r || p.vac) continue;
      if (this.rand() < 0.85) {
        p.vac = true;
        if (p.inf === S) p.inf = R;
      }
    }
    return true;
  }

  masks() {
    if (this.phase !== 'running' || this.time < this.masksUntil || !this.spend('curber', 18)) return false;
    this.masksUntil = this.time + 4 * 3600;
    return true;
  }

  test() {
    if (this.phase !== 'running' || this.testing >= 3 || !this.spend('curber', 14 + 6 * this.testing)) return false;
    this.testing++;
    return true;
  }

  // ----- the epidemic -----

  infect(p, free = false) {
    p.inf = E;
    p.infT = this.base.incubation * (0.7 + 0.6 * this.rand());
    this.ever++;
    if (!free) {
      this.newSince++;
      this.points.spreader += 0.5;
    }
  }

  inLockdown(p) {
    for (const z of this.lockdowns) if ((z.start || 0) <= this.time && Math.hypot(p.x - z.x, p.z - z.z) < z.r) return true;
    return false;
  }

  // Called after the pedestrians have moved: keeps people home who are locked down or isolating.
  step(dt) {
    if (this.phase !== 'running') return;
    this.acc += dt;
    while (this.acc >= TICK) {
      this.acc -= TICK;
      this.tick();
      if (this.phase !== 'running') { this.acc = 0; break; }
    }
    this.enforce();
  }

  enforce() {
    for (const p of this.agents) {
      if (p.workUntil > this.time && p.inf === I) { p.out = true; p.iso = false; }
      if (!p.out) continue;
      if (p.iso || (p.threshold > 0.1 && this.lockdowns.length && this.inLockdown(p))) p.out = false;
    }
  }

  tick() {
    this.time += TICK;
    this.enforce();
    this.effects = this.effects.filter(e => e.until > this.time);
    this.parties = this.parties.filter(e => e.until > this.time);
    this.vaccineEfficacy = this.active('newvaccine') ? 0.9 : 0.65;
    if (this.active('vaccines')) {
      const acceptance = this.active('antivaxx') ? 0.25 : 0.85;
      for (const p of this.agents) if (!p.vac && this.rand() < acceptance / 600) {
        p.vac = true;
        p.vacAt = this.time + 300;
      }
    }
    for (const party of this.parties) {
      if (this.inLockdown(party)) continue;
      const sources = party.members.filter(p => p.inf === I && !p.iso).length;
      const partyRate = 0.004 * (this.active('distancing') ? 0.45 : 1);
      for (const p of party.members) if (p.inf === S && this.rand() < 1 - Math.exp(-partyRate * sources * this.susceptibility(p))) this.infect(p);
    }
    this.lockdowns = this.lockdowns.filter((z) => z.until > this.time);
    const { beta, reach, infectious } = this.base;
    const masked = this.time < this.masksUntil ? 0.45 : 1;
    const range = reach * this.virus.reach;
    const rate = beta * this.virus.spread * masked * (this.active('antimask') ? 1.4 : 1) * (this.active('distancing') ? 0.55 : 1);
    const detect = (0.0006 * this.testing + (this.active('hospitals') ? 0.003 : 0)) * this.virus.stealth;

    // Hash everyone who is outside, so each infectious person only looks at their neighbours.
    const cells = new Map();
    for (const p of this.agents) {
      if (!p.out || p.iso) continue;
      const key = Math.floor(p.x / range) * 65537 + Math.floor(p.z / range);
      const cell = cells.get(key);
      if (cell) cell.push(p);
      else cells.set(key, [p]);
    }

    for (const p of this.agents) {
      if (p.inf === E) {
        p.infT -= TICK;
        if (p.infT <= 0) {
          p.inf = I;
          p.infT = infectious * (0.7 + 0.6 * this.rand());
        }
      } else if (p.inf === I) {
        p.infT -= TICK;
        if (p.infT <= 0) {
          p.inf = R;
          p.iso = false;
        } else if (!(p.workUntil > this.time) && !p.iso && detect > 0 && this.rand() < detect) p.iso = true;
        else if (p.out && !p.iso) this.expose(p, cells, range, rate);
      }
    }

    if (this.time - this.histAt >= 60) {
      this.histAt = this.time;
      const c = this.counts();
      this.history.push([this.time, c.active, c.ever]);
    }
    this.heatCache = null;
    this.judge();
    if (this.phase === 'running' && this.counts().active === 0) this.phase = 'over';
  }

  expose(p, cells, range, rate) {
    const cx = Math.floor(p.x / range);
    const cz = Math.floor(p.z / range);
    const chance = 1 - Math.exp(-rate * TICK);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        const cell = cells.get((cx + a) * 65537 + cz + b);
        if (!cell) continue;
        for (const q of cell) {
          if (q.inf !== S || Math.hypot(q.x - p.x, q.z - p.z) > range) continue;
          if (this.rand() < chance * this.susceptibility(q)) this.infect(q);
        }
      }
    }
  }

  judge() {
    // Both sides earn a little all the time, so nobody is ever stuck with nothing to do.
    this.points.curber += TICK / 40;
    this.points.spreader += TICK / 90;
  }

  // Where the virus is: map of coarse cells to the number of exposed and infectious people in them.
  heat(cell = 100) {
    if (this.heatCache) return this.heatCache;
    const grid = new Map();
    for (const p of this.agents) {
      if (p.inf !== E && p.inf !== I) continue;
      const key = Math.floor(p.x / cell) * 65537 + Math.floor(p.z / cell);
      const g = grid.get(key);
      if (g) g.n++;
      else grid.set(key, { x: (Math.floor(p.x / cell) + 0.5) * cell, z: (Math.floor(p.z / cell) + 0.5) * cell, n: 1 });
    }
    this.heatCache = [...grid.values()];
    return this.heatCache;
  }
}
