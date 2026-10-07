// Live traffic: what Gothenburg is doing right now, laid over the simulation. No rendering.
//
// The dev server fetches it (scripts/live.mjs). Three things come in:
//   - Road sensors (Trafikverket): the speed and the count of vehicles at measuring sites on the big
//     roads. Simulated drivers near a site go no faster than traffic there really is, and the number
//     of trips starting follows how full the measured lanes are instead of the daily profile.
//   - Incidents (Trafikverket): shown on the map; an accident also takes a lane from its street.
//   - Vehicles (Västtrafik): the real trams, buses and ferries, at their real positions.
// The cars themselves stay simulated: nobody publishes where every car is.

import { pointAt } from './geometry.js';
import { LANE_WIDTH } from './sim.js';

const ROADS_EVERY = 60; // seconds between questions to the server
const VEHICLES_EVERY = 5;
const FORGET = 30; // a vehicle not heard from for this long is taken off the map
// Vehicles an hour in one lane of the measured roads when the simulation is at its rush-hour peak.
// An assumption, not a measurement: raise it and the same readings give a quieter city.
const LANE_PEAK = 1500;
const SPREAD = 400; // metres either side of a sensor that its reading is taken to hold
const ACCIDENT_SPEED = 8.3; // 30 km/h past an accident
const CELL = 80;

// Seconds since midnight in Gothenburg, whatever the clock of this computer is set to.
const cityTime = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
export function cityClock() {
  const [h, m, s] = cityTime.format(new Date()).split(/\D/).map(Number);
  return (h * 3600 + m * 60 + s) % 86400;
}

// Nearest point on a polyline: how far away it is and how far along.
function project(path, x, z) {
  const p = path.pts;
  let d = Infinity;
  let s = 0;
  for (let i = 1; i < path.cum.length; i++) {
    const ax = p[2 * i - 2];
    const az = p[2 * i - 1];
    const dx = p[2 * i] - ax;
    const dz = p[2 * i + 1] - az;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    const dist = Math.hypot(ax + dx * t - x, az + dz * t - z);
    if (dist < d) {
      d = dist;
      s = path.cum[i - 1] + t * Math.sqrt(l2);
    }
  }
  return { d, s };
}

const P = {};

export class Live {
  // `lines` are the tram lines as Trams has prepared them (path, tunnels, crossings).
  constructor(map, mapName, sim, lines) {
    this.sim = sim;
    this.mapName = mapName || 'central';
    this.size = map.size;
    const bb = map.bbox;
    const kx = 111320 * Math.cos((((bb.s + bb.n) / 2) * Math.PI) / 180);
    this.xz = (lat, lon) => [(lon - bb.w) * kx, (bb.n - lat) * 111194];

    this.on = false;
    this.sources = { roads: false, vehicles: false };
    this.errors = {}; // what went wrong last time, for each source
    this.asking = {}; // which sources have a question out
    this.sites = 0; // sensors answering
    this.kmh = 0; // what they measure, averaged by vehicle
    this.perLane = 0; // vehicles an hour in the average measured lane
    this.incidents = []; // { x, z, type, what, where, text, accident }
    this.trams = []; // drawn like the simulated ones: { line, s, v, x, z, dx, dz }
    this.buses = []; // { x, z, dx, dz }
    this.boats = [];
    this.roadsAt = -Infinity;
    this.vehiclesAt = -Infinity; // when the vehicles last answered: never, so far

    this.linesByRef = new Map();
    for (const line of lines) {
      if (!this.linesByRef.has(line.ref)) this.linesByRef.set(line.ref, []);
      this.linesByRef.get(line.ref).push(line);
    }
    this.byId = new Map();
    this.siteEdges = new Map(); // sensor id -> the stretches of road it speaks for
    this.timers = [];
    this.last = performance.now();

    // Which streets pass through each 80 m square, to find the one nearest a point quickly.
    this.grid = new Map();
    sim.edges.forEach((e, ei) => {
      for (let cx = Math.floor(e.x0 / CELL); cx <= Math.floor(e.x1 / CELL); cx++) {
        for (let cz = Math.floor(e.z0 / CELL); cz <= Math.floor(e.z1 / CELL); cz++) {
          const key = cx * 4096 + cz;
          if (!this.grid.has(key)) this.grid.set(key, []);
          this.grid.get(key).push(ei);
        }
      }
    });
  }

  // Asks the server which sources it has keys for. True if there is anything live to show.
  async check() {
    try {
      this.sources = await (await fetch('/live/status')).json();
    } catch {
      this.sources = { roads: false, vehicles: false }; // a built copy of the site has no server behind it
    }
    return this.sources.roads || this.sources.vehicles;
  }

  get available() {
    return this.sources.roads || this.sources.vehicles;
  }

  get error() {
    return Object.values(this.errors).filter(Boolean).join('; ');
  }

  // Are the real trams, buses and ferries on the map at the moment?
  get vehiclesFresh() {
    return this.on && performance.now() - this.vehiclesAt < FORGET * 1000;
  }

  start() {
    if (this.on || !this.available) return;
    this.on = true;
    const every = (seconds, what) => {
      what();
      this.timers.push(setInterval(what, seconds * 1000));
    };
    if (this.sources.roads) every(ROADS_EVERY, () => this.ask('roads', (data) => this.applyRoads(data)));
    if (this.sources.vehicles) every(VEHICLES_EVERY, () => this.ask('vehicles', (data) => this.applyVehicles(data.list)));
  }

  // Back to a wholly simulated city.
  stop() {
    this.on = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.incidents = [];
    this.trams = [];
    this.buses = [];
    this.boats = [];
    this.byId.clear();
    this.errors = {};
    this.asking = {};
    this.vehiclesAt = -Infinity;
    this.sites = 0;
    this.sim.liveDemand = null;
    this.sim.liveBuses = false;
    this.sim.setLive([], []);
  }

  async ask(what, apply) {
    // A slow answer is waited for rather than asked for again: two on the way could arrive in the wrong order.
    if (this.asking[what]) return;
    this.asking[what] = true;
    try {
      const res = await fetch(`/live/${what}?map=${this.mapName}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (!this.on) return;
      this.errors[what] = data.errors?.join('; ') || '';
      apply(data);
    } catch (err) {
      if (this.on) this.errors[what] = err.message || 'The live data did not arrive';
    } finally {
      this.asking[what] = false;
    }
  }

  // ---------- roads ----------

  // The street nearest a point: { ei, d, s }, or null. `ok` chooses which streets count.
  nearest(x, z, reach, ok) {
    const { edges } = this.sim;
    let best = null;
    const tried = new Set();
    for (let cx = Math.floor((x - reach) / CELL); cx <= Math.floor((x + reach) / CELL); cx++) {
      for (let cz = Math.floor((z - reach) / CELL); cz <= Math.floor((z + reach) / CELL); cz++) {
        for (const ei of this.grid.get(cx * 4096 + cz) || []) {
          const e = edges[ei];
          if (tried.has(ei) || e.gone || !ok(e, ei)) continue;
          tried.add(ei);
          const hit = project(e, x, z);
          if (hit.d < reach && (!best || hit.d < best.d)) best = { ei, ...hit };
        }
      }
    }
    return best;
  }

  // The stretches of road a sensor speaks for: the carriageway it stands on, and the same road for
  // some hundred metres either way. Each as [edge, metres from the sensor].
  covers(site) {
    const { edges, nodes } = this.sim;
    const [x, z] = this.xz(site.lat, site.lon);
    // "northBound" and the like say which carriageway of a divided road is measured. North is -z.
    const side = site.side.toLowerCase();
    const hx = side.includes('east') ? 1 : side.includes('west') ? -1 : 0;
    const hz = side.includes('south') ? 1 : side.includes('north') ? -1 : 0;
    const major = (e) => e.cls === 0 || e.cls === 1 || e.cls === 4;
    const heading = (e, s) => {
      pointAt(e, s, P);
      return P.dx * hx + P.dz * hz;
    };
    let seed = null;
    if (hx || hz) seed = this.nearest(x, z, 45, (e) => major(e) && heading(e, project(e, x, z).s) > 0.3);
    seed ||= this.nearest(x, z, 30, major) || this.nearest(x, z, 12, () => true);
    if (!seed) return [];
    const out = [[seed.ei, 0]];
    // Follow the road on from each end while it stays the same kind of road and does not turn off.
    const walk = (forward) => {
      let cur = edges[seed.ei];
      let d = forward ? cur.len - seed.s : seed.s;
      while (d < SPREAD) {
        let next = -1;
        let bestDot = 0.7;
        for (const fi of forward ? nodes[cur.b].out : nodes[cur.a].inc) {
          const f = edges[fi];
          if (f.gone || f.cls !== cur.cls) continue;
          const dot = forward ? cur.ox * f.ix + cur.oz * f.iz : f.ox * cur.ix + f.oz * cur.iz;
          if (dot > bestDot) {
            bestDot = dot;
            next = fi;
          }
        }
        if (next < 0) break;
        out.push([next, d]);
        cur = edges[next];
        d += cur.len;
      }
    };
    walk(true);
    walk(false);
    return out;
  }

  applyRoads({ sites, incidents }) {
    const { edges } = this.sim;
    this.roadsAt = performance.now();

    // Each stretch of road takes the reading of the sensor nearest to it.
    const nearest = new Map(); // edge -> [metres to the sensor, m/s]
    let flow = 0;
    let lanes = 0;
    let weighted = 0;
    for (const site of sites) {
      if (!this.siteEdges.has(site.id)) this.siteEdges.set(site.id, this.covers(site));
      flow += site.flow;
      lanes += site.lanes;
      weighted += site.flow * site.kmh;
      if (!site.flow || !site.kmh) continue; // nothing passed, so there is no speed to go by
      for (const [ei, d] of this.siteEdges.get(site.id)) {
        if (!nearest.has(ei) || d < nearest.get(ei)[0]) nearest.set(ei, [d, site.kmh / 3.6]);
      }
    }
    const speeds = new Map();
    // Only slower than the limit counts: a sensor is no licence to speed.
    for (const [ei, [, v]] of nearest) if (v < edges[ei].v * 0.9) speeds.set(ei, Math.max(1.5, v));

    this.sites = sites.length;
    this.kmh = flow ? Math.round(weighted / flow) : 0;
    this.perLane = lanes ? Math.round(flow / lanes) : 0;
    // With too few sensors answering, the daily profile is the better guess.
    const level = sites.length >= 4 ? Math.max(0.05, Math.min(1.3, flow / lanes / LANE_PEAK)) : null;
    this.sim.liveDemand = level === null || this.sim.liveDemand === null ? level : this.sim.liveDemand + (level - this.sim.liveDemand) * 0.5;

    const narrowed = new Set(); // two reports of one accident still take only one lane
    this.incidents = [];
    for (const r of incidents) {
      const [x, z] = this.xz(r.lat, r.lon);
      if (x < 0 || z < 0 || x > this.size[0] || z > this.size[1]) continue;
      const accident = /olycka|accident/i.test(`${r.type} ${r.what}`);
      this.incidents.push({ ...r, x, z, accident });
      if (!accident) continue;
      const hit = this.nearest(x, z, 40, () => true);
      if (!hit) continue;
      narrowed.add(hit.ei);
      speeds.set(hit.ei, Math.min(speeds.get(hit.ei) ?? Infinity, ACCIDENT_SPEED));
    }
    this.sim.setLive(speeds, [...narrowed].sort((a, b) => a - b));
  }

  // ---------- vehicles ----------

  applyVehicles(list) {
    const now = performance.now();
    this.vehiclesAt = now;
    for (const v of list) {
      const [x, z] = this.xz(v.lat, v.lon);
      if (x < 0 || z < 0 || x > this.size[0] || z > this.size[1]) continue;
      if (v.mode === 'tram') this.fixTram(v, x, z, now);
      else if (v.mode === 'bus' || v.mode === 'ferry') this.fixFree(v, x, z, now);
    }
    for (const [id, v] of this.byId) if (now - v.seen > FORGET * 1000) this.byId.delete(id);
    const all = [...this.byId.values()];
    this.trams = all.filter((v) => v.mode === 'tram');
    this.buses = all.filter((v) => v.mode === 'bus');
    this.boats = all.filter((v) => v.mode === 'ferry');
    this.sim.liveBuses = true;
  }

  // A tram is put on the track of its line. The two directions of a line lie a few metres apart, too
  // close to tell by position alone, so the way it has been moving decides.
  fixTram(v, x, z, now) {
    let t = this.byId.get(v.id);
    const mx = t ? x - t.fx : 0;
    const mz = t ? z - t.fz : 0;
    const moved = Math.hypot(mx, mz);
    let best = null;
    for (const line of this.linesByRef.get(v.line) || []) {
      const hit = project(line.path, x, z);
      if (hit.d > 50) continue;
      let score = hit.d;
      if (t?.line === line) score -= 8;
      if (moved > 12) {
        pointAt(line.path, hit.s, P);
        score -= (25 * (P.dx * mx + P.dz * mz)) / moved;
      }
      if (!best || score < best.score) best = { line, s: hit.s, score };
    }
    if (!best) return; // a line we have no track for, or a tram off its line (in the depot, say)
    if (!t) {
      t = { id: v.id, mode: 'tram', line: best.line, s: best.s, v: 0, left: 0, fx: x, fz: z, x, z, dx: 1, dz: 0 };
      this.byId.set(v.id, t);
    }
    const gap = best.s - t.s;
    if (t.line !== best.line || Math.abs(gap) > 250) {
      t.line = best.line;
      t.s = best.s;
      t.v = t.left = 0;
    } else {
      // Glide to where it was last seen in the time until the next sighting.
      t.left = gap;
      t.v = gap / VEHICLES_EVERY;
    }
    if (moved > 12 || !t.seen) {
      t.fx = x;
      t.fz = z;
    }
    t.seen = now;
    pointAt(t.line.path, t.s, t);
  }

  // Buses and ferries go where they are seen. A bus is set on the nearest street, in its own lane.
  fixFree(v, x, z, now) {
    let b = this.byId.get(v.id);
    let ex = 0;
    let ez = 0;
    let side = 0;
    if (v.mode === 'bus') {
      const hit = this.nearest(x, z, 18, (e) => !e.tunnel);
      if (hit) {
        const e = this.sim.edges[hit.ei];
        pointAt(e, hit.s, P);
        [x, z, ex, ez] = [P.x, P.z, P.dx, P.dz];
        side = e.oneway ? 0 : (e.lanes - 0.5) * LANE_WIDTH;
      }
    }
    if (!b) {
      b = { id: v.id, mode: v.mode, line: v.line, x, z, dx: ex || 1, dz: ez, vx: 0, vz: 0, left: 0, cx: x, cz: z };
      this.byId.set(v.id, b);
    }
    const gx = x - b.cx;
    const gz = z - b.cz;
    const gap = Math.hypot(gx, gz);
    if (gap > 300) {
      b.cx = x;
      b.cz = z;
      b.vx = b.vz = b.left = 0;
    } else {
      b.vx = gx / VEHICLES_EVERY;
      b.vz = gz / VEHICLES_EVERY;
      b.left = VEHICLES_EVERY;
    }
    // Which way it points: along its street, in the direction it is moving.
    if (gap > 4) {
      const along = ex || ez ? Math.sign(ex * gx + ez * gz) || 1 : 0;
      b.hx = along ? ex * along : gx / gap;
      b.hz = along ? ez * along : gz / gap;
    } else if (b.hx === undefined) {
      b.hx = b.dx;
      b.hz = b.dz;
    }
    b.side = side;
    b.seen = now;
  }

  // Moves the real vehicles on between sightings, and has road traffic give way to the trams.
  step() {
    const now = performance.now();
    const dt = Math.min(1, (now - this.last) / 1000);
    this.last = now;
    if (!this.on) return;
    const { sim } = this;
    for (const t of this.trams) {
      let ds = t.v * dt;
      if (Math.abs(ds) > Math.abs(t.left)) ds = t.left;
      t.left -= ds;
      t.s = Math.max(0, Math.min(t.line.path.len, t.s + ds));
      pointAt(t.line.path, t.s, t);
      const speed = t.left ? Math.abs(t.v) : 0;
      const reach = Math.max(14, speed * 3.5);
      for (const x of t.line.xings) {
        const d = x.s - t.s;
        if (d > reach) break;
        if (d > -33) sim.nodes[x.node].tramUntil = sim.time + 1;
      }
    }
    const turn = Math.min(1, dt * 4);
    for (const b of this.buses.concat(this.boats)) {
      const step = Math.min(dt, b.left);
      b.left -= step;
      b.cx += b.vx * step;
      b.cz += b.vz * step;
      b.dx += (b.hx - b.dx) * turn;
      b.dz += (b.hz - b.dz) * turn;
      const n = Math.hypot(b.dx, b.dz) || 1;
      b.dx /= n;
      b.dz /= n;
      // Keep to the right-hand side of the street.
      b.x = b.cx - b.dz * b.side;
      b.z = b.cz + b.dx * b.side;
    }
  }
}
