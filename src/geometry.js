// Shared helpers: polylines with distances along them, a seeded random generator, a priority queue.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A polyline from node a to node b, with cumulative length, bounding box, the direction it starts and
// ends in, and the speed its tightest bend allows.
export function makeEdge(a, b, flatPts, extra) {
  const pts = Float32Array.from(flatPts);
  const n = pts.length / 2;
  const cum = new Float32Array(n);
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pts[2 * i];
    const z = pts[2 * i + 1];
    if (i) cum[i] = cum[i - 1] + Math.hypot(x - pts[2 * i - 2], z - pts[2 * i - 1]);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  const len = cum[n - 1];
  const dir = (i, j) => {
    const l = Math.hypot(pts[2 * j] - pts[2 * i], pts[2 * j + 1] - pts[2 * i + 1]) || 1;
    return [(pts[2 * j] - pts[2 * i]) / l, (pts[2 * j + 1] - pts[2 * i + 1]) / l];
  };
  const [ix, iz] = dir(0, 1);
  const [ox, oz] = dir(n - 2, n - 1);

  // Speed through the tightest bend. Each bend is measured over at least 8 m either side so that a
  // wobble between two close map points does not read as a hairpin; cornering at 3 m/s² sets the speed.
  let vcap = 40;
  for (let i = 1; i < n - 1; i++) {
    let j = i - 1;
    let k = i + 1;
    while (j > 0 && cum[i] - cum[j] < 8) j--;
    while (k < n - 1 && cum[k] - cum[i] < 8) k++;
    const [ax, az] = dir(j, i);
    const [bx, bz] = dir(i, k);
    const t = Math.acos(Math.max(-1, Math.min(1, ax * bx + az * bz)));
    if (t > 0.1) vcap = Math.min(vcap, Math.sqrt((3 * (cum[k] - cum[j])) / 2 / t));
  }
  return { a, b, pts, cum, len, x0, z0, x1, z1, ix, iz, ox, oz, vcap: Math.max(5, vcap), ...extra };
}

export function reversed(flatPts) {
  const out = [];
  for (let i = flatPts.length - 2; i >= 0; i -= 2) out.push(flatPts[i], flatPts[i + 1]);
  return out;
}

// Position and direction at distance s along an edge.
export function pointAt(e, s, out) {
  const c = e.cum;
  let i = 1;
  while (i < c.length - 1 && c[i] < s) i++;
  const l = c[i] - c[i - 1] || 1;
  const t = Math.max(0, Math.min(1, (s - c[i - 1]) / l));
  const ax = e.pts[2 * i - 2];
  const az = e.pts[2 * i - 1];
  const bx = e.pts[2 * i];
  const bz = e.pts[2 * i + 1];
  out.x = ax + (bx - ax) * t;
  out.z = az + (bz - az) * t;
  out.dx = (bx - ax) / l;
  out.dz = (bz - az) / l;
  return out;
}

// Binary min-heap of (key, value) pairs.
export class Heap {
  constructor() {
    this.k = [];
    this.v = [];
  }
  get size() {
    return this.k.length;
  }
  clear() {
    this.k.length = 0;
    this.v.length = 0;
  }
  push(key, val) {
    const { k, v } = this;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop() {
    const { k, v } = this;
    const top = v[0];
    const key = k.pop();
    const val = v.pop();
    const n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= key) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = key;
      v[i] = val;
    }
    return top;
  }
}
