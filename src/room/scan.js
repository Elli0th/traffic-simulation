// Hands over the table, from a lidar that sits on the table's edge and sweeps a flat fan just above
// the surface. Each sweep is a list of (angle, distance) readings. Anything nearer than the empty
// room is something reaching over the table.
//
// Lengths are millimetres. The lidar is at (0, 0), x to its right and y straight out across the table.

// Turns whatever the lidar's API sends into { angles (radians), ranges (mm) }. Understands:
//   { t, points: [{ angle, distance, quality }] }   the room's lidar (ws://pi-lidar.local/scan)
//   { angle_min, angle_increment, ranges }          the usual laser-scan message
//   [{ angle, distance }] or [[angle, distance]]
// Angles may be degrees or radians, distances metres or millimetres; it works out which.
export function decodeScan(body) {
  let angles = [];
  let ranges = [];
  const scan = body.points ?? body.scan ?? body.data ?? body;
  if (Array.isArray(scan)) {
    for (const p of scan) {
      if (Array.isArray(p)) {
        angles.push(p.length >= 3 ? p[1] : p[0]);
        ranges.push(p.length >= 3 ? p[2] : p[1]);
      } else {
        angles.push(p.angle ?? p.theta ?? p.a);
        ranges.push(p.distance ?? p.range ?? p.dist ?? p.r ?? p.d);
      }
    }
  } else if (scan.ranges) {
    const start = scan.angle_min ?? scan.angleMin ?? 0;
    const step = scan.angle_increment ?? scan.angleIncrement ?? (2 * Math.PI) / scan.ranges.length;
    ranges = Array.from(scan.ranges);
    angles = ranges.map((_, i) => start + i * step);
  } else {
    return null;
  }
  let widest = 0;
  let farthest = 0;
  for (let i = 0; i < angles.length; i++) {
    widest = Math.max(widest, Math.abs(angles[i]));
    if (Number.isFinite(ranges[i])) farthest = Math.max(farthest, ranges[i]);
  }
  const degrees = widest > 7;
  const metres = farthest > 0 && farthest < 60;
  return {
    angles: Float32Array.from(angles, (a) => (degrees ? (a * Math.PI) / 180 : a)),
    ranges: Float32Array.from(ranges, (r) => (Number.isFinite(r) ? (metres ? r * 1000 : r) : 0)),
  };
}

const BIN = (0.5 * Math.PI) / 180; // readings are compared with the empty room in half-degree steps

// Finds the things in the lidar's fan that are not part of the empty room.
export class ScanDetector {
  constructor(options = {}) {
    this.margin = 60; // must be this much nearer than the empty room to count
    this.minWidth = 8; // a finger
    this.maxWidth = 450; // wider than this is a person leaning in, not a hand
    Object.assign(this, options);
    this.background = null;
    this.recent = []; // the last few sweeps' things, to tell what stays from what flickers
  }

  // The things that have been there for three sweeps running: a finger, not a flicker.
  steady(blips) {
    const near = (list, b) => list.some((o) => Math.hypot(o.x - b.x, o.y - b.y) < 60);
    const out = this.recent.length >= 2 ? blips.filter((b) => this.recent.every((list) => near(list, b))) : [];
    this.recent.push(blips);
    if (this.recent.length > 2) this.recent.shift();
    return out;
  }

  get ready() {
    return this.background !== null;
  }

  bin(angle) {
    return Math.round((angle + Math.PI) / BIN);
  }

  // Learns the empty room: the nearest distance seen in each direction, bar the odd stray reading.
  // (Not the median: a beam that only sometimes catches a dent or an edge of the table would then
  // count as something new every time it does.)
  setBackground(scans) {
    const seen = new Map();
    for (const s of scans) {
      for (let i = 0; i < s.angles.length; i++) {
        if (s.ranges[i] <= 0) continue;
        const k = this.bin(s.angles[i]);
        if (!seen.has(k)) seen.set(k, []);
        seen.get(k).push(s.ranges[i]);
      }
    }
    this.background = new Map();
    for (const [k, list] of seen) {
      list.sort((a, b) => a - b);
      this.background.set(k, list[Math.min(list.length - 1, Math.floor(list.length * 0.1))]);
    }
  }

  // Returns [{ x, y, width, compact: true }]: the middle of each thing in the fan. With `keep` set to
  // a function of (x, y) in millimetres from the lidar, readings it turns down are ignored: people
  // and chairs around the table are not on it.
  detect(scan) {
    if (!this.background) return [];
    const hits = [];
    const keep = this.keep;
    for (let i = 0; i < scan.angles.length; i++) {
      const r = scan.ranges[i];
      if (keep && !keep(r * Math.cos(scan.angles[i]), r * Math.sin(scan.angles[i]))) continue;
      const k = this.bin(scan.angles[i]);
      // The readings do not fall on the same angles every sweep, so look half a degree either side too.
      let far = this.background.get(k);
      if (far === undefined) {
        const [left, right] = [this.background.get(k - 1), this.background.get(k + 1)];
        if (left !== undefined || right !== undefined) far = Math.min(left ?? Infinity, right ?? Infinity);
      }
      // A direction that was empty space before counts as far away.
      if (r > 30 && r < (far ?? 1e9) - this.margin) hits.push({ a: scan.angles[i], r });
    }
    hits.sort((p, q) => p.a - q.a);
    // A lidar that sees all the way round has a seam where 360° meets 0°. Start the list at the widest
    // gap instead, so a hand lying across the seam stays one thing.
    let widest = hits.length ? hits[0].a + 2 * Math.PI - hits[hits.length - 1].a : 0;
    let start = 0;
    for (let i = 1; i < hits.length; i++) {
      if (hits[i].a - hits[i - 1].a > widest) {
        widest = hits[i].a - hits[i - 1].a;
        start = i;
      }
    }
    if (start > 0) hits.push(...hits.splice(0, start).map((h) => ({ a: h.a + 2 * Math.PI, r: h.r })));
    const blips = [];
    let run = [];
    const close = () => {
      if (run.length >= 2) {
        const first = run[0];
        const last = run[run.length - 1];
        const width = Math.hypot(last.r * Math.cos(last.a) - first.r * Math.cos(first.a), last.r * Math.sin(last.a) - first.r * Math.sin(first.a));
        if (width >= this.minWidth && width <= this.maxWidth) {
          let a = 0;
          let r = 0;
          for (const h of run) {
            a += h.a;
            r += h.r;
          }
          a /= run.length;
          // The lidar sees the near face; the middle of the thing is a little further in.
          r = r / run.length + Math.min(40, width / 2);
          blips.push({ x: r * Math.cos(a), y: r * Math.sin(a), width, compact: true });
        }
      }
      run = [];
    };
    for (const h of hits) {
      const prev = run[run.length - 1];
      if (prev && (h.a - prev.a > BIN * 3 || Math.abs(h.r - prev.r) > 90)) close();
      run.push(h);
    }
    close();
    return blips;
  }
}

// Turns points over the table into map gestures. One moving hand drags the map; two hands moving
// apart or together zoom it. Something that stays put for a second is an object on the table, not a
// hand, and is left out (and reported separately, so it can close a street).
//
// Points are in table coordinates: x and y from 0 to 1 across the projected picture.
export class Gestures {
  constructor(options = {}) {
    this.match = 0.12; // how far a hand may jump between sweeps and still be the same hand
    this.settle = 1.0; // seconds without moving before a point counts as an object
    this.slack = 0.012; // movement smaller than this is noise
    this.engage = 0.025; // a hand must travel this far before it starts to drag
    Object.assign(this, options);
    this.tracks = [];
    this.nextId = 1;
  }

  // points: [{ x, y }], time in seconds. Returns { pan: [dx, dy], zoom, at: [x, y], hands, objects },
  // where pan is how far the map should follow (fractions of the picture) and zoom multiplies its scale.
  update(points, time) {
    const free = points.slice();
    for (const t of this.tracks) {
      let best = -1;
      let bestD = this.match;
      free.forEach((p, k) => {
        const d = Math.hypot(p.x - t.x, p.y - t.y);
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      });
      t.px = t.x;
      t.py = t.y;
      if (best < 0) {
        t.missed++;
        continue;
      }
      const p = free.splice(best, 1)[0];
      t.x += (p.x - t.x) * 0.5;
      t.y += (p.y - t.y) * 0.5;
      t.missed = 0;
      t.seen++;
      // Has it left the spot where it last rested?
      if (Math.hypot(t.x - t.restX, t.y - t.restY) > this.slack) {
        t.travel += Math.hypot(t.x - t.restX, t.y - t.restY);
        t.restX = t.x;
        t.restY = t.y;
        t.restSince = time;
        t.still = false;
      } else if (time - t.restSince > this.settle) {
        t.still = true;
        t.travel = 0;
      }
    }
    for (const p of free) {
      this.tracks.push({ id: this.nextId++, x: p.x, y: p.y, px: p.x, py: p.y, restX: p.x, restY: p.y, restSince: time, travel: 0, seen: 1, missed: 0, still: false });
    }
    this.tracks = this.tracks.filter((t) => t.missed <= 3);

    const live = this.tracks.filter((t) => !t.missed && t.seen >= 3);
    const objects = live.filter((t) => t.still).map((t) => ({ x: t.restX, y: t.restY }));
    const hands = live.filter((t) => !t.still && t.travel >= this.engage).sort((p, q) => p.id - q.id);
    const out = { pan: [0, 0], zoom: 1, at: [0.5, 0.5], hands: hands.length, objects };
    if (hands.length === 1) {
      const h = hands[0];
      out.pan = [h.x - h.px, h.y - h.py];
      out.at = [h.x, h.y];
    } else if (hands.length >= 2) {
      const [a, b] = hands;
      out.pan = [(a.x + b.x - a.px - b.px) / 2, (a.y + b.y - a.py - b.py) / 2];
      out.at = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      const before = Math.hypot(a.px - b.px, a.py - b.py);
      const after = Math.hypot(a.x - b.x, a.y - b.y);
      if (before > 0.03 && after > 0.03) out.zoom = Math.max(0.9, Math.min(1.1, after / before));
    }
    return out;
  }
}

// A pretend lidar on the middle of the table's top edge, for tests and rehearsal. `things` are
// round objects in table coordinates: { x, y, r } with r in millimetres.
export class SimulatedLidar {
  constructor({ width = 1200, aspect = 1.6, seed = 3 } = {}) {
    this.width = width; // of the projected picture, millimetres
    this.depth = width / aspect;
    this.things = [];
    this.noise = 6;
    // Where the lidar sits and which way it faces, relative to the picture. Calibration finds this out.
    this.at = [width * 0.5 + 35, -60];
    this.turn = 0.06; // radians
    let a = seed >>> 0;
    this.rand = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  async read() {
    const angles = [];
    const ranges = [];
    const things = this.things.map((o) => ({ cx: o.x * this.width - this.at[0], cy: o.y * this.depth - this.at[1], r: o.r ?? 35 }));
    for (let deg = 0; deg <= 180; deg += 0.5) {
      const a = (deg * Math.PI) / 180;
      const dx = Math.cos(a + this.turn);
      const dy = Math.sin(a + this.turn);
      let r = 2600 + 300 * Math.sin(a * 3); // the room's walls
      for (const o of things) {
        // Nearest point where this beam meets the round object.
        const along = o.cx * dx + o.cy * dy;
        const off2 = o.cx * o.cx + o.cy * o.cy - along * along;
        if (along > 0 && off2 < o.r * o.r) r = Math.min(r, along - Math.sqrt(o.r * o.r - off2));
      }
      angles.push(a);
      ranges.push(this.rand() < 0.01 ? 0 : r + (this.rand() + this.rand() - 1) * this.noise);
    }
    return { angles: Float32Array.from(angles), ranges: Float32Array.from(ranges) };
  }
}
