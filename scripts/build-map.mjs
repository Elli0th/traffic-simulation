// Turns the raw OpenStreetMap downloads in data/ into the compact map the app loads (public/gbg.json):
// the road graph with signals, give-way rules, crossings and turn bans; tram lines with stops; ferries;
// footpaths and cycleways; building boxes on a 2 m grid; water, parks and trees.
//
//   for q in query query-extra query-rules; do   # raw.json, extra.json, rules.json
//     curl -A tangible-table --data-urlencode "data@data/$q.txt" https://overpass-api.de/api/interpreter -o data/<name>.json
//   done
//   node scripts/build-map.mjs

import fs from 'node:fs';
import { pick } from './maps.mjs';

// Which map to build: `node scripts/build-map.mjs west`. With no name it builds the central one.
const MAP = pick(process.argv[2]);
const BB = MAP.bbox;
const KX = 111320 * Math.cos((((BB.s + BB.n) / 2) * Math.PI) / 180);
const KZ = 111194;
const WX = (BB.e - BB.w) * KX;
const WZ = (BB.n - BB.s) * KZ;
const CELL = 2; // building blocks are 2 m cubes on the ground plan

const load = (name) => JSON.parse(fs.readFileSync(new URL(`../${MAP.data}/${name}.json`, import.meta.url))).elements;
const els = load('raw');
const extra = load('extra');
const rules = load('rules');

const px = (p) => [(p.lon - BB.w) * KX, (BB.n - p.lat) * KZ];
const r1 = (v) => Math.round(v * 10) / 10;
const inside = ([x, z]) => x >= 0 && x <= WX && z >= 0 && z <= WZ;
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const hash = (n) => {
  let t = (n ^ 0x9e3779b9) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
let seed = 12345;
const rand = () => hash(seed++);
const flatPts = (pts) => pts.flatMap(([x, z]) => [r1(x), r1(z)]);

// ---------- polygons ----------

// Multipolygon outlines arrive as loose pieces; join them end to end into rings.
function stitch(pieces) {
  const key = (p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
  const pool = pieces.map((g) => g.slice());
  const rings = [];
  while (pool.length) {
    let ring = pool.pop();
    for (;;) {
      if (key(ring[0]) === key(ring[ring.length - 1]) && ring.length > 3) break;
      const end = key(ring[ring.length - 1]);
      const k = pool.findIndex((g) => key(g[0]) === end || key(g[g.length - 1]) === end);
      if (k < 0) break;
      let next = pool.splice(k, 1)[0];
      if (key(next[0]) !== end) next = next.reverse();
      ring = ring.concat(next.slice(1));
    }
    rings.push(ring);
  }
  return rings;
}

function ringsOf(el) {
  if (el.type === 'way') return el.geometry ? [el.geometry.map(px)] : [];
  const pieces = (el.members || []).filter((m) => m.type === 'way' && m.geometry).map((m) => m.geometry);
  return stitch(pieces).map((r) => r.map(px));
}

const bboxOf = (rings) => {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const r of rings) for (const [x, z] of r) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { x0, z0, x1, z1 };
};
const onMap = (b) => b.x1 >= 0 && b.x0 <= WX && b.z1 >= 0 && b.z0 <= WZ;
const area = (ring) => {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(a) / 2;
};
const centroid = (rings) => {
  const b = bboxOf(rings);
  return [(b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2];
};
function contains(rings, [x, z]) {
  let hit = false;
  for (const r of rings) {
    for (let i = 0; i < r.length - 1; i++) {
      const [x1, z1] = r[i];
      const [x2, z2] = r[i + 1];
      if (z1 <= z !== z2 <= z && x < x1 + ((z - z1) / (z2 - z1)) * (x2 - x1)) hit = !hit;
    }
  }
  return hit;
}
const flat = (rings) => rings.map((r) => r.flatMap(([x, z]) => [Math.round(x), Math.round(z)]));

// Nearest point on a polyline: distance, how far along it lies, and which side the point is on.
function project(pts, p) {
  let best = { d: Infinity, s: 0, side: 0 };
  let run = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1];
    const dx = pts[i][0] - ax;
    const dz = pts[i][1] - az;
    const l = Math.hypot(dx, dz);
    if (l > 0) {
      const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / (l * l)));
      const d = Math.hypot(ax + dx * t - p[0], az + dz * t - p[1]);
      if (d < best.d) best = { d, s: run + t * l, side: (p[0] - ax) * -dz + (p[1] - az) * dx };
    }
    run += l;
  }
  return best;
}
const lengthOf = (pts) => pts.reduce((sum, p, i) => (i ? sum + dist(pts[i - 1], p) : 0), 0);

// Cuts a polyline into the stretches that lie on the map.
function clip(pts) {
  const parts = [];
  let cur = [];
  for (const p of pts) {
    if (inside(p)) cur.push(p);
    else if (cur.length) {
      parts.push(cur);
      cur = [];
    }
  }
  if (cur.length) parts.push(cur);
  return parts.filter((part) => part.length > 1);
}

function clipNodes(nodes) {
  const parts = [];
  let cur = [];
  for (const n of nodes) {
    if (inside(n.p)) cur.push(n);
    else if (cur.length) {
      parts.push(cur);
      cur = [];
    }
  }
  if (cur.length) parts.push(cur);
  return parts.filter((part) => part.length > 1);
}

// ---------- graphs ----------

// Splits ways at shared nodes into edges. `interest` is a set of node ids to report along each edge.
function buildGraph(ways, attrs, { keepLargest = true, interest = null } = {}) {
  const use = new Map();
  for (const w of ways) {
    w.nodes.forEach((id, i) => use.set(id, (use.get(id) || 0) + (i === 0 || i === w.nodes.length - 1 ? 2 : 1)));
  }
  const index = new Map();
  let nodes = [];
  let edges = [];
  const gateWeight = new Map();
  const vid = (id, p) => {
    if (!index.has(id)) {
      index.set(id, nodes.length);
      nodes.push(p);
    }
    return index.get(id);
  };
  for (const w of ways) {
    const a = attrs(w);
    if (!a) continue;
    let ids = w.nodes;
    let pts = w.geometry.map(px);
    if (a.reverse) {
      ids = ids.slice().reverse();
      pts = pts.reverse();
    }
    let start = 0;
    for (let i = 1; i < ids.length; i++) {
      if (use.get(ids[i]) < 2 && i !== ids.length - 1) continue;
      const seg = pts.slice(start, i + 1);
      if (seg.every(inside)) {
        const marks = [];
        let s = 0;
        for (let k = 0; k < seg.length; k++) {
          if (k) s += dist(seg[k - 1], seg[k]);
          if (interest?.has(ids[start + k])) marks.push({ s, id: ids[start + k] });
        }
        edges.push({ a: vid(ids[start], pts[start]), b: vid(ids[i], pts[i]), p: seg, len: s, marks, ...a });
      } else {
        for (const k of [start, i]) {
          if (inside(pts[k])) gateWeight.set(ids[k], Math.max(gateWeight.get(ids[k]) || 0, a.gate || 1));
        }
      }
      start = i;
    }
  }

  const remap = new Map();
  if (keepLargest) {
    // Keep only the largest connected piece so every trip has a chance of a route.
    const parent = nodes.map((_, k) => k);
    const find = (k) => {
      while (parent[k] !== k) k = parent[k] = parent[parent[k]];
      return k;
    };
    for (const e of edges) parent[find(e.a)] = find(e.b);
    const size = new Map();
    nodes.forEach((_, k) => size.set(find(k), (size.get(find(k)) || 0) + 1));
    const main = [...size.entries()].sort((p, q) => q[1] - p[1])[0][0];
    const kept = [];
    nodes.forEach((p, k) => {
      if (find(k) !== main) return;
      remap.set(k, kept.length);
      kept.push(p);
    });
    edges = edges.filter((e) => remap.has(e.a)).map((e) => ({ ...e, a: remap.get(e.a), b: remap.get(e.b) }));
    nodes = kept;
  } else {
    nodes.forEach((_, k) => remap.set(k, k));
  }
  const vertexOf = new Map();
  for (const [id, k] of index) if (remap.has(k)) vertexOf.set(id, remap.get(k));
  const gates = [...gateWeight].filter(([id]) => vertexOf.has(id)).map(([id, w]) => [vertexOf.get(id), w]);
  return { nodes, edges, gates, vertexOf };
}

// ---------- roads ----------

const ROAD_CLASS = {
  motorway: 0, trunk: 0,
  primary: 1,
  secondary: 2, tertiary: 2,
  residential: 3, unclassified: 3, living_street: 3,
  motorway_link: 4, trunk_link: 4, primary_link: 4, secondary_link: 4, tertiary_link: 4,
};
const CLASS_SPEED = [22, 14, 12, 8, 12]; // metres per second
const CLASS_LANES = [2, 2, 1, 1, 1];
const CLASS_GATE = [14, 6, 3, 1, 4]; // how much traffic enters the map on a road of this class

// Tagged nodes that govern traffic: signals, give-way and stop signs, pedestrian crossings.
const control = new Map();
const crossings = [];
const busStopAt = [];
const tramStopAt = new Map();
for (const el of rules) {
  if (el.type !== 'node') continue;
  const t = el.tags || {};
  const p = px(el);
  const dir = t['traffic_signals:direction'] || t.direction || null;
  const c = control.get(el.id) || {};
  if (t.highway === 'traffic_signals') c.signal = { dir };
  if (t.highway === 'give_way' || t.highway === 'stop') c.giveWay = { dir };
  if (t.highway === 'crossing' && inside(p)) {
    c.crossing = crossings.length;
    const signalled = t.crossing === 'traffic_signals' || t['crossing:signals'] === 'yes';
    crossings.push([Math.round(p[0]), Math.round(p[1]), signalled ? 1 : 0]);
  }
  if (c.signal || c.giveWay || c.crossing !== undefined) control.set(el.id, c);
  if (t.highway === 'bus_stop' && inside(p)) busStopAt.push(p);
  if (t.railway === 'tram_stop' && inside(p)) tramStopAt.set(el.id, p);
}

const wayIndex = new Map();
const roadWays = els.filter((e) => e.type === 'way' && e.tags?.highway && e.tags.highway in ROAD_CLASS && e.geometry);
const roads = buildGraph(
  roadWays,
  (w) => {
    const t = w.tags;
    if (t.access === 'private' || t.access === 'no' || t.area === 'yes') return null;
    const cls = ROAD_CLASS[t.highway];
    const oneway = t.oneway === 'yes' || t.oneway === '-1' || t.highway === 'motorway' || t.junction === 'roundabout';
    const total = parseInt(t.lanes, 10);
    const lanes = Number.isFinite(total)
      ? Math.max(1, Math.min(4, oneway ? total : Math.floor(total / 2)))
      : CLASS_LANES[cls];
    const limit = parseInt(t.maxspeed, 10);
    const v = Number.isFinite(limit) ? Math.max(6, limit / 3.6) : CLASS_SPEED[cls];
    if (!wayIndex.has(w.id)) wayIndex.set(w.id, wayIndex.size);
    return {
      cls,
      oneway: oneway ? 1 : 0,
      reverse: t.oneway === '-1',
      tunnel: t.tunnel ? 1 : 0,
      lanes,
      v: r1(v),
      way: wayIndex.get(w.id),
      roundabout: t.junction === 'roundabout' ? 1 : 0,
      gate: CLASS_GATE[cls] * lanes,
    };
  },
  { interest: control },
);

// Work out, for each direction of each road edge, where a signal or give-way sign applies.
// A tagged node near one end of the edge governs the traffic heading for that end.
const approaches = []; // signalled approaches, grouped into junctions below
for (const e of roads.edges) {
  const L = e.len;
  e.sig = [-1, -1]; // stop-line position along [forward, backward] travel
  e.yld = [0, 0];
  e.cross = [];
  const apply = (dirTag, s, set) => {
    const midBlock = !dirTag && Math.min(s, L - s) > 25;
    const fwd = dirTag === 'forward' || dirTag === 'both' || midBlock || (!dirTag && s >= L - s);
    const bwd = dirTag === 'backward' || dirTag === 'both' || midBlock || (!dirTag && s < L - s);
    if (fwd && s > 4) set(0, s);
    if (bwd && !e.oneway && L - s > 4) set(1, L - s);
  };
  for (const m of e.marks) {
    const c = control.get(m.id);
    if (c.signal) apply(c.signal.dir, m.s, (d, s) => (e.sig[d] = Math.max(e.sig[d], s)));
    if (c.giveWay) apply(c.giveWay.dir, m.s, (d) => (e.yld[d] = 1));
    if (c.crossing !== undefined) e.cross.push(r1(m.s), c.crossing);
  }
  for (const d of [0, 1]) {
    if (e.sig[d] < 0) continue;
    // A signal on the junction node itself: stop short of the junction rather than in the middle of it.
    const atEnd = e.sig[d] > L - 1;
    e.sig[d] = r1(atEnd ? Math.max(L * 0.6, L - 7) : Math.max(1, e.sig[d] - 1));
    // Where the stop line is, and which way traffic is heading as it reaches it.
    const pts = d ? e.p.slice().reverse() : e.p;
    let k = 1;
    let run = 0;
    while (k < pts.length - 1 && run + dist(pts[k - 1], pts[k]) < e.sig[d]) run += dist(pts[k - 1], pts[k++]);
    const seg = dist(pts[k - 1], pts[k]) || 1;
    const t = Math.max(0, Math.min(1, (e.sig[d] - run) / seg));
    approaches.push({
      e,
      d,
      at: [pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * t, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * t],
      bearing: Math.atan2(pts[k][1] - pts[k - 1][1], pts[k][0] - pts[k - 1][0]),
      weight: e.lanes * (e.cls === 3 ? 1 : e.cls === 2 ? 2 : 3),
    });
  }
}

// Signalled approaches within 40 m of each other belong to one junction and share a controller.
const group = approaches.map((_, k) => k);
const top = (k) => {
  while (group[k] !== k) k = group[k] = group[group[k]];
  return k;
};
for (let i = 0; i < approaches.length; i++) {
  for (let j = i + 1; j < approaches.length; j++) {
    if (dist(approaches[i].at, approaches[j].at) < 40) group[top(i)] = top(j);
  }
}
const junctions = new Map();
approaches.forEach((a, k) => {
  const g = top(k);
  if (!junctions.has(g)) junctions.set(g, []);
  junctions.get(g).push(a);
});
const controllers = [];
for (const list of junctions.values()) {
  const main = list.reduce((p, q) => (q.weight > p.weight ? q : p));
  const weight = [0, 0];
  for (const a of list) {
    let diff = Math.abs(a.bearing - main.bearing) % Math.PI;
    if (diff > Math.PI / 2) diff = Math.PI - diff;
    a.phase = diff < Math.PI / 4 ? 0 : 1;
    weight[a.phase] += a.weight;
    a.e.ctl = a.e.ctl || [-1, -1];
    a.e.phase = a.e.phase || [0, 0];
    a.e.ctl[a.d] = controllers.length;
    a.e.phase[a.d] = a.phase;
  }
  // Two crossing streams share an 80 s cycle by their size; a lone stream stops only for pedestrians.
  const twoPhase = weight[1] > 0;
  const g0 = twoPhase ? Math.round(Math.max(20, Math.min(50, (70 * weight[0]) / (weight[0] + weight[1])))) : 42;
  const g1 = twoPhase ? 70 - g0 : 13;
  const cycle = twoPhase ? g0 + g1 + 10 : g0 + g1 + 5;
  // Offsets follow position along the main street, which gives neighbouring signals a rough green wave.
  const along = main.at[0] * Math.cos(main.bearing) + main.at[1] * Math.sin(main.bearing);
  const offset = Math.round((((along / 12) % cycle) + cycle) % cycle);
  controllers.push([cycle, g0, g1, offset, twoPhase ? 2 : 1]);
}

// Turn restrictions: [from way, via node, to way, 1 if "only this turn" else 0 for "not this turn"].
const restrictions = [];
for (const el of rules) {
  if (el.type !== 'relation' || el.tags?.type !== 'restriction') continue;
  const kind = el.tags.restriction || '';
  const only = kind.startsWith('only_') ? 1 : kind.startsWith('no_') ? 0 : -1;
  const from = el.members.find((m) => m.role === 'from' && m.type === 'way');
  const via = el.members.find((m) => m.role === 'via' && m.type === 'node');
  const to = el.members.find((m) => m.role === 'to' && m.type === 'way');
  if (only < 0 || !from || !via || !to) continue;
  if (!wayIndex.has(from.ref) || !wayIndex.has(to.ref) || !roads.vertexOf.has(via.ref)) continue;
  restrictions.push([wayIndex.get(from.ref), roads.vertexOf.get(via.ref), wayIndex.get(to.ref), only]);
}

// Bus stops, attached to the side of the street they stand on: [edge, direction, distance along].
const busStops = [];
for (const p of busStopAt) {
  let best = null;
  roads.edges.forEach((e, k) => {
    if (e.cls === 0 || e.tunnel) return;
    const hit = project(e.p, p);
    if (hit.d < 14 && (!best || hit.d < best.hit.d)) best = { k, e, hit };
  });
  if (!best) continue;
  const backward = best.hit.side < 0 && !best.e.oneway;
  busStops.push(best.k, backward ? 1 : 0, r1(backward ? best.e.len - best.hit.s : best.hit.s));
}

// Bus lines: the streets each line follows, and where it enters and leaves the map.
const wayNodes = new Map();
for (const e of roads.edges) {
  if (!wayNodes.has(e.way)) wayNodes.set(e.way, new Set());
  wayNodes.get(e.way).add(e.a).add(e.b);
}
const farEnd = (way, other) => {
  // The end of `way` furthest from the neighbouring way on the route.
  let best = -1;
  let bestD = -1;
  for (const k of wayNodes.get(way)) {
    let d = Infinity;
    for (const j of wayNodes.get(other)) d = Math.min(d, dist(roads.nodes[k], roads.nodes[j]));
    if (d > bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
};
const busLines = [];
for (const rel of rules) {
  if (rel.type !== 'relation' || rel.tags?.route !== 'bus') continue;
  const ways = rel.members
    .filter((m) => m.type === 'way' && wayIndex.has(m.ref))
    .map((m) => wayIndex.get(m.ref))
    .filter((w) => wayNodes.has(w));
  if (ways.length < 6) continue;
  const from = farEnd(ways[0], ways[1]);
  const to = farEnd(ways[ways.length - 1], ways[ways.length - 2]);
  if (from >= 0 && to >= 0 && from !== to) busLines.push({ ref: rel.tags.ref || '', from, to, ways: [...new Set(ways)] });
}

// ---------- trams, ferries, rails ----------

const tramWay = new Map();
for (const w of els) {
  if (w.type === 'way' && w.tags?.railway === 'tram' && w.geometry) {
    const t = w.tags.tunnel && w.tags.tunnel !== 'no' ? 1 : 0;
    tramWay.set(w.id, w.nodes.map((id, i) => ({ id, p: px(w.geometry[i]), t })));
  }
}
const tramStops = [...tramStopAt.entries()];
const tramLines = [];
for (const rel of rules) {
  if (rel.type !== 'relation' || rel.tags?.route !== 'tram') continue;
  // Follow the member ways in order, turning each one to continue from the last.
  const chains = [];
  let cur = null;
  let single = false;
  for (const m of rel.members) {
    if (m.type !== 'way') continue;
    const way = tramWay.get(m.ref);
    if (!way) {
      if (cur) chains.push(cur);
      cur = null;
      continue;
    }
    if (!cur) {
      cur = way.slice();
      single = true;
      continue;
    }
    const last = way.length - 1;
    if (single && cur[cur.length - 1].id !== way[0].id && cur[cur.length - 1].id !== way[last].id) cur.reverse();
    const end = cur[cur.length - 1].id;
    if (way[0].id === end) cur = cur.concat(way.slice(1));
    else if (way[last].id === end) cur = cur.concat(way.slice().reverse().slice(1));
    else {
      chains.push(cur);
      cur = way.slice();
      single = true;
      continue;
    }
    single = false;
  }
  if (cur) chains.push(cur);

  const members = new Set(rel.members.filter((m) => m.type === 'node').map((m) => m.ref));
  for (const chain of chains) {
    for (const part of clipNodes(chain)) {
      const pts = part.map((n) => n.p);
      const len = lengthOf(pts);
      if (len < 300) continue;
      // Stretches that run underground, as [from, to, from, to, ...] distances along the line.
      const tunnels = [];
      let run = 0;
      let open = -1;
      for (let i = 1; i < part.length; i++) {
        const under = part[i].t && part[i - 1].t;
        if (under && open < 0) open = run;
        if (!under && open >= 0) {
          tunnels.push(r1(open), r1(run));
          open = -1;
        }
        run += dist(part[i - 1].p, part[i].p);
      }
      if (open >= 0) tunnels.push(r1(open), r1(run));
      const near = (limit, pick) =>
        tramStops
          .filter(([id]) => pick(id))
          .map(([, p]) => project(pts, p))
          .filter((hit) => hit.d < limit)
          .map((hit) => hit.s);
      let stops = near(12, (id) => members.has(id));
      if (stops.length < 2) stops = near(9, () => true);
      stops.sort((p, q) => p - q);
      stops = stops.filter((s, k) => s > 20 && s < len - 5 && (!k || s - stops[k - 1] > 50)).map(r1);
      // Places where the track passes over a road junction; cars there give way to the tram.
      const b = bboxOf([pts]);
      const xings = [];
      roads.nodes.forEach((n, k) => {
        if (n[0] < b.x0 - 5 || n[0] > b.x1 + 5 || n[1] < b.z0 - 5 || n[1] > b.z1 + 5) return;
        const hit = project(pts, n);
        if (hit.d < 4) xings.push([hit.s, k]);
      });
      xings.sort((p, q) => p[0] - q[0]);
      tramLines.push({
        ref: rel.tags.ref || '',
        colour: rel.tags.colour || '',
        pts: flatPts(pts),
        tunnels,
        stops,
        xings: xings.flatMap(([s, k]) => [r1(s), k]),
      });
    }
  }
}

const ferries = [];
const rails = [];
const trees = [];
for (const el of extra) {
  const t = el.tags || {};
  if (el.type === 'node' && t.natural === 'tree') {
    const p = px(el);
    if (inside(p)) trees.push(Math.round(p[0]), Math.round(p[1]));
  } else if (t.route === 'ferry' && el.geometry) {
    for (const pts of clip(el.geometry.map(px))) {
      if (lengthOf(pts) >= 150) ferries.push({ big: /Frederikshavn|Kiel/.test(t.name || '') ? 1 : 0, pts: flatPts(pts) });
    }
  } else if (t.railway === 'rail' && el.geometry) {
    const pts = el.geometry.map(px);
    if (onMap(bboxOf([pts]))) rails.push([t.tunnel ? 1 : 0, ...pts.flatMap(([x, z]) => [Math.round(x), Math.round(z)])]);
  }
}

// ---------- footpaths and cycleways ----------

const WALK = new Set(['footway', 'pedestrian', 'path', 'cycleway', 'steps']);
const walkWays = rules.filter((e) => e.type === 'way' && WALK.has(e.tags?.highway) && e.geometry);
const crossingNodes = new Map([...control].filter(([, c]) => c.crossing !== undefined));
const paths = buildGraph(
  walkWays,
  (w) => {
    const t = w.tags;
    if (t.access === 'private' || t.access === 'no' || t.area === 'yes') return null;
    const bike = t.highway === 'cycleway' || ((t.bicycle === 'designated' || t.bicycle === 'yes') && t.highway !== 'steps');
    return { bike: bike ? 1 : 0, foot: t.highway === 'cycleway' && t.foot !== 'designated' && t.foot !== 'yes' ? 0 : 1 };
  },
  { keepLargest: false, interest: crossingNodes },
);

// ---------- land cover ----------

const water = [];
const green = [];
const pitch = [];
const hospitals = [];
const helipads = [];
const coast = [];
let scattered = 0;
for (const el of els) {
  const t = el.tags || {};
  if (t.highway || t.railway) continue;
  if (t.natural === 'coastline') {
    if (el.geometry) coast.push(el);
    continue;
  }
  if (t.aeroway === 'helipad') {
    const c = centroid(ringsOf(el));
    if (inside(c)) helipads.push(c.map(Math.round));
    continue;
  }
  if (t.amenity === 'hospital') {
    const rings = ringsOf(el);
    if (rings.length) hospitals.push({ name: t.name || 'Hospital', rings, area: Math.max(...rings.map(area)) });
  }
  if (t.building) continue;
  const rings = ringsOf(el);
  if (!rings.length) continue;
  const b = bboxOf(rings);
  if (!onMap(b)) continue;
  if (t.natural === 'water') water.push(flat(rings));
  else if (t.leisure === 'pitch') pitch.push(flat(rings));
  else if (t.leisure || t.landuse || t.natural === 'wood') green.push(flat(rings));
  // Woodland has no individual trees mapped, so plant some.
  if ((t.natural === 'wood' || t.landuse === 'forest') && scattered < 30000) {
    const tries = Math.min(6000, ((b.x1 - b.x0) * (b.z1 - b.z0)) / 130);
    for (let k = 0; k < tries; k++) {
      const p = [b.x0 + rand() * (b.x1 - b.x0), b.z0 + rand() * (b.z1 - b.z0)];
      if (inside(p) && contains(rings, p)) {
        trees.push(Math.round(p[0]), Math.round(p[1]));
        scattered++;
      }
    }
  }
}
hospitals.sort((p, q) => q.area - p.area);

// The sea is mapped as a coastline (a line), not as an area, and this builder does not fill it in.
// Neither map reaches it: the river is mapped as water all the way past Älvsborgsbron.
if (coast.length) console.warn(`Warning: this map reaches the sea (${coast.length} stretches of coastline), which will be drawn as land.`);

// ---------- buildings ----------

const TYPE = { home: 0, work: 1, industry: 2, civic: 3, hospital: 4, other: 5 };
const KIND = {
  apartments: 'home', residential: 'home', house: 'home', detached: 'home', terrace: 'home',
  semidetached_house: 'home', dormitory: 'home',
  commercial: 'work', retail: 'work', office: 'work', hotel: 'work', supermarket: 'work',
  industrial: 'industry', warehouse: 'industry', garage: 'industry', garages: 'industry',
  shed: 'industry', service: 'industry', hangar: 'industry', parking: 'industry',
  church: 'civic', cathedral: 'civic', chapel: 'civic', school: 'civic', university: 'civic',
  college: 'civic', public: 'civic', civic: 'civic', government: 'civic', train_station: 'civic',
  museum: 'civic', theatre: 'civic', stadium: 'civic', sports_hall: 'civic', kindergarten: 'civic',
  hospital: 'hospital',
};
const LOW = new Set(['garage', 'garages', 'shed', 'roof', 'hut', 'kiosk', 'carport', 'service']);

const cols = Math.ceil(WX / CELL);
const rows = Math.ceil(WZ / CELL);
const boxes = []; // column, row, length in cells, height in metres, type, variant

// Carriageways marked on the building grid, so that no building block ends up standing in a street.
const roadMask = new Uint8Array(cols * rows);
for (const e of roads.edges) {
  if (e.tunnel) continue;
  const hw = e.oneway ? e.lanes * 1.6 + 0.5 : e.lanes * 3.2 + 0.4;
  for (let i = 1; i < e.p.length; i++) {
    const [ax, az] = e.p[i - 1];
    const [bx, bz] = e.p[i];
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz || 1;
    const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - hw) / CELL));
    const c1 = Math.min(cols - 1, Math.floor((Math.max(ax, bx) + hw) / CELL));
    const r0 = Math.max(0, Math.floor((Math.min(az, bz) - hw) / CELL));
    const r1c = Math.min(rows - 1, Math.floor((Math.max(az, bz) + hw) / CELL));
    for (let r = r0; r <= r1c; r++) {
      for (let c = c0; c <= c1; c++) {
        const x = (c + 0.5) * CELL;
        const z = (r + 0.5) * CELL;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        if (Math.hypot(ax + dx * t - x, az + dz * t - z) < hw) roadMask[r * cols + c] = 1;
      }
    }
  }
}
const places = { home: [], work: [] }; // [x, z, floor area] of where people live and work

for (const el of els) {
  const t = el.tags || {};
  if (!t.building || t.building === 'no') continue;
  const rings = ringsOf(el).filter((r) => r.length > 3);
  if (!rings.length) continue;
  const b = bboxOf(rings);
  if (!onMap(b)) continue;
  const c = centroid(rings);
  const a = Math.max(...rings.map(area));
  const h01 = hash(el.id);

  let type = TYPE[KIND[t.building]] ?? (h01 < 0.55 ? TYPE.home : h01 < 0.8 ? TYPE.work : TYPE.other);
  if (hospitals.some((hsp) => contains(hsp.rings, c))) type = TYPE.hospital;

  let height = parseFloat(t.height);
  if (!Number.isFinite(height)) {
    const levels = parseFloat(t['building:levels']);
    if (Number.isFinite(levels)) height = levels * 3.2;
    else if (LOW.has(t.building)) height = 3;
    else if (['church', 'cathedral'].includes(t.building)) height = 22;
    else if (['house', 'detached', 'terrace', 'semidetached_house'].includes(t.building)) height = 7;
    else if (type === TYPE.industry) height = 8 + h01 * 4;
    else if (a < 80) height = 4;
    else if (a < 300) height = 9 + h01 * 7;
    else height = 13 + h01 * 9;
  }
  height = Math.max(3, Math.min(260, Math.round(height)));
  const variant = Math.floor(hash(el.id * 7 + 3) * 16); // low 2 bits: colour, high 2 bits: shade
  if (inside(c) && a > 60 && !LOW.has(t.building)) {
    places[type === TYPE.home ? 'home' : 'work'].push([c[0], c[1], (a * height) / 3.2]);
  }

  let made = 0;
  for (let r = Math.max(0, Math.floor(b.z0 / CELL)); r <= Math.min(rows - 1, Math.floor(b.z1 / CELL)); r++) {
    const zc = (r + 0.5) * CELL;
    const xs = [];
    for (const ring of rings) {
      for (let i = 0; i < ring.length - 1; i++) {
        const [x1, z1] = ring[i];
        const [x2, z2] = ring[i + 1];
        if (z1 <= zc !== z2 <= zc) xs.push(x1 + ((zc - z1) / (z2 - z1)) * (x2 - x1));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] / CELL - 0.5));
      const c1 = Math.min(cols - 1, Math.floor(xs[k + 1] / CELL - 0.5));
      // One box per unbroken run of cells, split wherever a street passes through.
      let start = -1;
      for (let c = c0; c <= c1 + 1; c++) {
        const free = c <= c1 && !roadMask[r * cols + c];
        if (free && start < 0) start = c;
        if (!free && start >= 0) {
          boxes.push(start, r, c - start, height, type, variant);
          made++;
          start = -1;
        }
      }
    }
  }
  const cc = Math.floor(c[0] / CELL);
  const cr = Math.floor(c[1] / CELL);
  if (!made && inside(c) && !roadMask[cr * cols + cc]) boxes.push(cc, cr, 1, height, type, variant);
}

// ---------- where trips start and end ----------

// Ordinary streets only: nobody parks on a motorway or in a tunnel.
const street = new Set();
for (const e of roads.edges) if (e.cls >= 1 && e.cls <= 3 && !e.tunnel) street.add(e.a).add(e.b);
const GRID = 150;
const buckets = new Map();
for (const k of street) {
  const key = `${Math.floor(roads.nodes[k][0] / GRID)},${Math.floor(roads.nodes[k][1] / GRID)}`;
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(k);
}
function nearestStreet(p) {
  const cx = Math.floor(p[0] / GRID);
  const cz = Math.floor(p[1] / GRID);
  let best = -1;
  let d = Infinity;
  for (let ring = 0; ring < 6 && (best < 0 || ring < 2); ring++) {
    for (let i = cx - ring; i <= cx + ring; i++) {
      for (let j = cz - ring; j <= cz + ring; j++) {
        if (Math.max(Math.abs(i - cx), Math.abs(j - cz)) !== ring) continue;
        for (const k of buckets.get(`${i},${j}`) || []) {
          const q = dist(roads.nodes[k], p);
          if (q < d) {
            d = q;
            best = k;
          }
        }
      }
    }
  }
  return best;
}
// Sample buildings in proportion to their floor area and note the street node outside each.
function sample(list, count) {
  const total = list.reduce((sum, p) => sum + p[2], 0);
  const out = [];
  for (let n = 0; n < count; n++) {
    let pick = rand() * total;
    let k = 0;
    while (k < list.length - 1 && (pick -= list[k][2]) > 0) k++;
    const node = nearestStreet(list[k]);
    if (node >= 0) out.push(node);
  }
  return out;
}

const ll = (lat, lon) => px({ lat, lon }).map(Math.round);
const hospitalAt = hospitals.length ? centroid(hospitals[0].rings).map(Math.round) : ll(57.683, 11.961);
const incidentAt = ll(57.7089, 11.9733);

// ---------- output ----------

const out = {
  name: MAP.name,
  peakRate: MAP.peakRate,
  bbox: BB,
  size: [Math.round(WX), Math.round(WZ)],
  cell: CELL,
  roads: {
    nodes: roads.nodes.flatMap(([x, z]) => [r1(x), r1(z)]),
    gates: roads.gates.flat(),
    // [a, b, class, oneway, tunnel, lanes, speed, way, roundabout,
    //  signal stop F, controller F, phase F, signal stop B, controller B, phase B,
    //  give way F, give way B, [crossing distance, crossing id, ...], [x, z, ...]]
    edges: roads.edges.map((e) => [
      e.a, e.b, e.cls, e.oneway, e.tunnel, e.lanes, e.v, e.way, e.roundabout,
      e.sig[0], e.ctl?.[0] ?? -1, e.phase?.[0] ?? 0, e.sig[1], e.ctl?.[1] ?? -1, e.phase?.[1] ?? 0,
      e.yld[0], e.yld[1], e.cross, flatPts(e.p),
    ]),
    controllers,
    restrictions,
    busStops,
    busLines,
    homes: sample(places.home, 2500),
    works: sample(places.work, 2500),
  },
  crossings,
  tramLines,
  ferries,
  rails,
  trees,
  paths: {
    nodes: paths.nodes.flatMap(([x, z]) => [r1(x), r1(z)]),
    // [a, b, cycling allowed, walking allowed, [crossing distance, crossing id, ...], [x, z, ...]]
    edges: paths.edges.map((e) => [
      e.a, e.b, e.bike, e.foot,
      e.marks.flatMap((m) => [r1(m.s), crossingNodes.get(m.id).crossing]),
      flatPts(e.p),
    ]),
  },
  water,
  green,
  pitch,
  boxes,
  helipads,
  hospital: { name: hospitals[0]?.name || 'Hospital', at: hospitalAt, node: nearestStreet(hospitalAt) },
  incident: { at: incidentAt, node: nearestStreet(incidentAt) },
  labels: [
    ['Sahlgrenska', ...hospitalAt],
    ...[
      ['Centralstationen', 57.7089, 11.9733],
      ['Avenyn', 57.6995, 11.9765],
      ['Liseberg', 57.6952, 11.9925],
      ['Lindholmen', 57.7068, 11.9385],
      ['Göta älv', 57.7035, 11.948],
      ['Haga', 57.6985, 11.957],
      ['Slottsskogen', 57.685, 11.943],
      ['Ullevi', 57.706, 11.987],
      ['Älvsborgsbron', 57.6905, 11.9015],
      ['Majorna', 57.6905, 11.9185],
      ['Eriksberg', 57.7005, 11.9145],
      ['Tingstadstunneln', 57.7228, 11.9868],
      ['Backaplan', 57.7205, 11.952],
    ]
      .map(([text, lat, lon]) => [text, ...ll(lat, lon)])
      .filter(([, x, z]) => inside([x, z])),
  ],
};

fs.mkdirSync(new URL('../public/', import.meta.url), { recursive: true });
const file = new URL(`../${MAP.out}`, import.meta.url);
fs.writeFileSync(file, JSON.stringify(out));
const signalled = roads.edges.reduce((n, e) => n + (e.sig[0] >= 0) + (e.sig[1] >= 0), 0);
console.log(
  [
    `${MAP.name}: ${out.size[0]} x ${out.size[1]} m -> ${MAP.out}`,
    `roads: ${roads.nodes.length} nodes, ${roads.edges.length} edges, ${roads.gates.length} gates`,
    `signals: ${controllers.length} junctions over ${signalled} approaches, ${restrictions.length} turn bans`,
    `crossings ${crossings.length}, bus stops ${busStops.length / 3}, bus lines ${busLines.length}`,
    `tram lines ${tramLines.length} (${tramLines.map((l) => l.ref).join(' ')}), stops ${tramLines.reduce((n, l) => n + l.stops.length, 0)}`,
    `ferries ${ferries.length}, rails ${rails.length}, trees ${trees.length / 2}`,
    `paths: ${paths.nodes.length} nodes, ${paths.edges.length} edges`,
    `building boxes ${boxes.length / 6}, homes ${out.roads.homes.length}, works ${out.roads.works.length}`,
    `${(fs.statSync(file).size / 1e6).toFixed(1)} MB`,
  ].join('\n'),
);
