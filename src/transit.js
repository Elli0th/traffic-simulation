// Trams on their real lines, and the ferries on the river. Pure logic, no rendering.

import { makeEdge, pointAt, mulberry32 } from './geometry.js';

export const TRAM = {
  len: 30, // three articulated sections
  vmax: 13.9, // 50 km/h
  a: 1.0,
  b: 1.2,
  dwell: 20, // seconds at a stop
  headway: 480, // seconds between departures on a line
};

export class Trams {
  constructor(lines, sim, seed = 5) {
    this.sim = sim;
    this.rand = mulberry32(seed);
    this.nextId = 1;
    this.trams = [];
    this.lines = lines
      .filter((l) => l.ref !== 'Lisebergslinjen') // the heritage line only runs in summer
      .map((l) => {
        const path = makeEdge(0, 0, l.pts, {});
        // Bends the tram must slow for: where along the line, and how fast it may take them.
        const caps = [];
        const { cum } = path;
        const n = cum.length;
        for (let i = 1; i < n - 1; i++) {
          let j = i - 1;
          let k = i + 1;
          while (j > 0 && cum[i] - cum[j] < 10) j--;
          while (k < n - 1 && cum[k] - cum[i] < 10) k++;
          const ax = path.pts[2 * i] - path.pts[2 * j];
          const az = path.pts[2 * i + 1] - path.pts[2 * j + 1];
          const bx = path.pts[2 * k] - path.pts[2 * i];
          const bz = path.pts[2 * k + 1] - path.pts[2 * i + 1];
          const cos = (ax * bx + az * bz) / ((Math.hypot(ax, az) || 1) * (Math.hypot(bx, bz) || 1));
          const t = Math.acos(Math.max(-1, Math.min(1, cos)));
          if (t > 0.15) caps.push({ s: cum[i], v: Math.max(3.5, Math.sqrt((cum[k] - cum[j]) / 2 / t)) });
        }
        const xings = [];
        for (let k = 0; k < l.xings.length; k += 2) xings.push({ s: l.xings[k], node: l.xings[k + 1] });
        return {
          ref: l.ref,
          colour: l.colour,
          path,
          stops: l.stops,
          tunnels: l.tunnels || [],
          caps,
          xings,
          next: this.rand() * TRAM.headway,
        };
      });
    // Start with trams already spread along every line.
    for (const line of this.lines) {
      const spacing = TRAM.headway * 6.5;
      for (let s = this.rand() * spacing; s < line.path.len - 50; s += spacing) this.spawn(line, s);
    }
  }

  spawn(line, s) {
    const tram = { id: this.nextId++, line, s, v: s ? 8 : 0, dwell: 0, stop: 0, x: 0, z: 0, dx: 1, dz: 0 };
    while (tram.stop < line.stops.length && line.stops[tram.stop] < s + 20) tram.stop++;
    pointAt(line.path, s, tram);
    this.trams.push(tram);
  }

  step(dt) {
    const { sim, trams } = this;
    const time = sim.time;
    for (const line of this.lines) {
      line.next -= dt;
      if (line.next > 0) continue;
      line.next = TRAM.headway * (0.85 + 0.3 * this.rand());
      if (!trams.some((t) => t.line === line && t.s < 80)) this.spawn(line, 0);
    }

    let done = false;
    for (const t of trams) {
      const line = t.line;
      if (t.dwell > 0) {
        t.dwell -= dt;
      } else {
        let vmax = TRAM.vmax;
        for (const cap of line.caps) {
          const d = cap.s - t.s;
          if (d < -TRAM.len) continue;
          if (d > 150) break;
          vmax = Math.min(vmax, d <= 0 ? cap.v : Math.sqrt(cap.v * cap.v + 2 * TRAM.b * d));
        }
        if (t.stop < line.stops.length) {
          const d = line.stops[t.stop] - t.s;
          vmax = Math.min(vmax, Math.sqrt(2 * TRAM.b * Math.max(0, d - 0.5)) + 0.3);
          if (d < 1.5) {
            t.dwell = TRAM.dwell * (0.8 + 0.5 * this.rand());
            t.stop++;
            t.v = 0;
            vmax = 0;
          }
        }
        // Keep clear of the tram in front, whichever line it is on.
        for (const o of trams) {
          if (o === t) continue;
          const dx = o.x - t.x;
          const dz = o.z - t.z;
          const dist = Math.hypot(dx, dz);
          if (dist > 110 || dx * t.dx + dz * t.dz < 0.8 * dist || o.dx * t.dx + o.dz * t.dz < 0.3) continue;
          vmax = Math.min(vmax, Math.sqrt(2 * TRAM.b * Math.max(0, dist - TRAM.len - 5)));
        }
        t.v = t.v < vmax ? Math.min(vmax, t.v + TRAM.a * dt) : Math.max(vmax, t.v - 2.2 * dt);
        t.s += t.v * dt;
        if (t.s >= line.path.len) {
          t.gone = true;
          done = true;
          continue;
        }
        pointAt(line.path, t.s, t);
      }
      // Road traffic gives way where the track crosses a junction the tram is at or about to reach.
      const reach = Math.max(14, t.v * 3.5);
      for (const x of line.xings) {
        const d = x.s - t.s;
        if (d > reach) break;
        if (d > -TRAM.len - 3) sim.nodes[x.node].tramUntil = time + 1;
      }
    }
    if (done) this.trams = trams.filter((t) => !t.gone);
  }
}

// Is this point of a tram line underground?
export function inTunnel(line, s) {
  const t = line.tunnels;
  for (let k = 0; k < t.length; k += 2) if (s >= t[k] && s <= t[k + 1]) return true;
  return false;
}

export class Ferries {
  constructor(routes, seed = 9) {
    const rand = mulberry32(seed);
    this.boats = routes.map((r) => {
      const path = makeEdge(0, 0, r.pts, {});
      const boat = { path, big: r.big, s: rand() * path.len, dir: rand() < 0.5 ? 1 : -1, dwell: 0, x: 0, z: 0, dx: 1, dz: 0 };
      pointAt(path, boat.s, boat);
      return boat;
    });
    this.rand = rand;
  }

  step(dt) {
    for (const b of this.boats) {
      if (b.dwell > 0) {
        b.dwell -= dt;
        continue;
      }
      b.s += b.dir * (b.big ? 3 : 5) * dt;
      if (b.s >= b.path.len || b.s <= 0) {
        b.s = Math.max(0, Math.min(b.path.len, b.s));
        b.dir = -b.dir;
        b.dwell = 60 + this.rand() * 90; // at the quay
      }
      pointAt(b.path, b.s, b);
      if (b.dir < 0) {
        b.dx = -b.dx;
        b.dz = -b.dz;
      }
    }
  }
}
