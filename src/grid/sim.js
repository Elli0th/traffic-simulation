// Traffic simulation on a grid of streets. Pure logic, no rendering.
// World units: x runs across the table, z runs down it.

export const CELL = 12; // distance between intersections
export const ROAD = 4; // street width
export const VMAX = 7; // free-flow speed, units per second
export const GAP = 2.2; // minimum spacing between cars
export const LANE = 1; // offset from the centre line to the driving lane

const NODE_HEADWAY = 0.45; // seconds between cars crossing one intersection
const EDGE_CAPACITY = CELL / GAP;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Sim {
  constructor(w, h, seed = 1) {
    this.w = w;
    this.h = h;
    this.nx = w + 1;
    this.ny = h + 1;
    this.rand = mulberry32(seed);
    this.time = 0;
    this.tick = 0;
    this.target = 220;
    this.cars = [];
    this.nodes = [];
    this.edges = [];

    for (let j = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++) {
        const boundary = i === 0 || j === 0 || i === w || j === h;
        this.nodes.push({ i, j, x: i * CELL, z: j * CELL, out: [], free: 0, boundary });
      }
    }
    const link = (a, b) => {
      const A = this.nodes[a];
      const B = this.nodes[b];
      const add = (from, to, F, T) => {
        const e = {
          a: from,
          b: to,
          len: CELL,
          dx: (T.x - F.x) / CELL,
          dz: (T.z - F.z) / CELL,
          blocked: false,
          sBlock: 0,
          cars: [],
          rev: -1,
        };
        F.out.push(this.edges.length);
        this.edges.push(e);
        return this.edges.length - 1;
      };
      const ab = add(a, b, A, B);
      const ba = add(b, a, B, A);
      this.edges[ab].rev = ba;
      this.edges[ba].rev = ab;
    };
    for (let j = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++) {
        if (i < w) link(this.idx(i, j), this.idx(i + 1, j));
        if (j < h) link(this.idx(i, j), this.idx(i, j + 1));
      }
    }
    this.boundary = this.nodes.map((n, k) => (n.boundary ? k : -1)).filter((k) => k >= 0);
    this.hospital = this.idx(1, 1);
    this.incident = this.idx(w - 1, h - 1);
  }

  idx(i, j) {
    return i + j * this.nx;
  }

  // blobs: [{x, z, r}] in world units. Any street a blob touches is closed.
  setBlobs(blobs) {
    let changed = false;
    for (const e of this.edges) {
      const A = this.nodes[e.a];
      let blocked = false;
      let sBlock = 0;
      for (const b of blobs) {
        const t = Math.max(0, Math.min(e.len, (b.x - A.x) * e.dx + (b.z - A.z) * e.dz));
        const d = Math.hypot(A.x + e.dx * t - b.x, A.z + e.dz * t - b.z);
        if (d < b.r + ROAD / 2) {
          blocked = true;
          sBlock = t;
          break;
        }
      }
      if (blocked !== e.blocked) changed = true;
      e.blocked = blocked;
      e.sBlock = sBlock;
    }
    if (!changed) return;

    // Cars approaching a new closure turn around; everyone replans.
    for (const e of this.edges) {
      if (!e.blocked) continue;
      const rev = this.edges[e.rev];
      const stay = [];
      for (const car of e.cars) {
        if (car.s < e.sBlock) {
          car.s = e.len - car.s;
          car.edge = e.rev;
          car.turned = this.tick;
          rev.cars.push(car);
        } else {
          stay.push(car);
        }
      }
      e.cars = stay;
    }
    for (const car of this.cars) this.reroute(car);
  }

  // Dijkstra over open streets. Returns a list of edge indices, or null.
  // jitter > 0 makes equally long routes a coin toss, so traffic spreads over the grid.
  route(from, to, congestionWeight = 0.5, jitter = 0) {
    const n = this.nodes.length;
    const dist = new Float64Array(n).fill(Infinity);
    const via = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    dist[from] = 0;
    for (;;) {
      let u = -1;
      let best = Infinity;
      for (let k = 0; k < n; k++) {
        if (!done[k] && dist[k] < best) {
          best = dist[k];
          u = k;
        }
      }
      if (u < 0) return null;
      if (u === to) break;
      done[u] = 1;
      for (const ei of this.nodes[u].out) {
        const e = this.edges[ei];
        if (e.blocked) continue;
        const cost =
          e.len * (1 + (congestionWeight * e.cars.length) / EDGE_CAPACITY) * (1 + jitter * this.rand());
        if (dist[u] + cost < dist[e.b]) {
          dist[e.b] = dist[u] + cost;
          via[e.b] = ei;
        }
      }
    }
    const path = [];
    for (let k = to; k !== from; k = this.edges[via[k]].a) path.push(via[k]);
    return path.reverse();
  }

  reroute(car) {
    const from = this.edges[car.edge].b;
    let path = this.route(from, car.dest, 0.5, 0.3);
    for (let tries = 0; !path && tries < 5; tries++) {
      const dest = this.anyNode();
      path = this.route(from, dest, 0.5, 0.3);
      if (path) car.dest = dest;
    }
    car.path = path || [];
  }

  tailS(e) {
    let s = Infinity;
    for (const c of e.cars) if (c.s < s) s = c.s;
    return s;
  }

  anyNode() {
    return Math.floor(this.rand() * this.nodes.length);
  }

  // Trips start at the edge of the map and end anywhere in the city, or the other way round.
  spawn() {
    const edge = this.boundary[Math.floor(this.rand() * this.boundary.length)];
    const inbound = this.rand() < 0.5;
    const from = inbound ? edge : this.anyNode();
    const dest = inbound ? this.anyNode() : edge;
    if (from === dest) return;
    const path = this.route(from, dest, 0.5, 0.3);
    if (!path || !path.length) return;
    const e = this.edges[path[0]];
    if (this.tailS(e) < GAP) return;
    const car = {
      edge: path[0],
      s: 0,
      v: VMAX,
      vmax: VMAX * (0.85 + this.rand() * 0.3),
      dest,
      path: path.slice(1),
      wait: 0,
      moved: this.tick,
      turned: -1,
    };
    e.cars.push(car);
    this.cars.push(car);
  }

  step(dt) {
    this.time += dt;
    this.tick++;
    for (let k = 0; k < 4 && this.cars.length < this.target; k++) this.spawn();

    const gone = new Set();
    for (let ei = 0; ei < this.edges.length; ei++) {
      const e = this.edges[ei];
      if (!e.cars.length) continue;
      const queue = e.cars.slice().sort((p, q) => q.s - p.s);
      let ahead = Infinity;
      for (const car of queue) {
        // A car that entered this street earlier in the same tick has already moved.
        if (car.moved === this.tick) {
          ahead = car.s;
          continue;
        }
        let ns = Math.max(car.s, Math.min(car.s + car.vmax * dt, ahead - GAP, e.len));
        let left = false;
        if (ns >= e.len) {
          const node = this.nodes[e.b];
          if (!car.path.length && e.b === car.dest) {
            gone.add(car);
            e.cars.splice(e.cars.indexOf(car), 1);
            continue;
          }
          car.wait += dt;
          if (!car.path.length || this.edges[car.path[0]].blocked || car.wait > 4) {
            if (car.wait > 1 || car.path.length) this.reroute(car);
            if (car.wait > 4) car.wait = 1.01;
          }
          const next = car.path.length ? this.edges[car.path[0]] : null;
          if (next && !next.blocked && node.free <= this.time && this.tailS(next) >= GAP) {
            e.cars.splice(e.cars.indexOf(car), 1);
            next.cars.push(car);
            car.edge = car.path.shift();
            car.s = 0;
            car.v = car.vmax;
            car.wait = 0;
            car.moved = this.tick;
            node.free = this.time + NODE_HEADWAY;
            left = true;
          } else {
            ns = e.len;
          }
        }
        if (!left) {
          car.v = (ns - car.s) / dt;
          if (ns > car.s && ns < e.len) car.wait = 0;
          car.s = ns;
          ahead = ns;
        }
      }
    }
    if (gone.size) this.cars = this.cars.filter((c) => !gone.has(c));
  }

  // Mean speed as a fraction of free flow, 0..1.
  flow() {
    if (!this.cars.length) return 1;
    let sum = 0;
    for (const c of this.cars) sum += Math.min(1, c.v / c.vmax);
    return sum / this.cars.length;
  }

  closures() {
    let n = 0;
    for (const e of this.edges) if (e.blocked) n++;
    return n / 2;
  }

  // Fastest way from the hospital to the incident right now.
  emergency() {
    const path = this.route(this.hospital, this.incident, 1.5);
    if (!path) return null;
    let time = 0;
    for (const ei of path) {
      const e = this.edges[ei];
      time += (e.len / VMAX) * (1 + (1.5 * e.cars.length) / EDGE_CAPACITY);
    }
    return { path, time };
  }
}
