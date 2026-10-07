// Road traffic on the real street network. Pure logic, no rendering. Units are metres and seconds.
//
// Each vehicle follows the Intelligent Driver Model: it accelerates towards the speed limit and
// brakes for whatever is ahead (another vehicle, a red light, a closure, a pedestrian on a crossing).
// Junctions follow the mapped rules: signals run fixed cycles, minor roads give way to major ones,
// roundabout entries give way to traffic on the roundabout, and mapped turn bans are respected.

import { makeEdge, reversed, mulberry32, Heap } from './geometry.js';

const S0 = 2; // gap kept to the vehicle ahead at standstill
const BLOCK_STOP = 6; // vehicles stop this far before a closure
const BLOCK_REACH = 5; // a street closes when an object comes within this distance of it
// Seconds a driver giving way needs clear before pulling out: across a road, onto a roundabout, or
// merging into a stream that is going the same way.
const GAP_CROSS = 4;
const GAP_ROUNDABOUT = 3;
const GAP_MERGE = 2;
export const LANE_WIDTH = 3.2;
const KEY = 1048576; // turn bans are stored as (from edge) * KEY + (to edge)

export const KINDS = {
  car: { len: 4.5, speed: 1, a: 1.9, b: 2.6, T: 1.2 },
  van: { len: 5.6, speed: 0.97, a: 1.6, b: 2.5, T: 1.3 },
  bus: { len: 12, speed: 0.9, a: 1.1, b: 2.0, T: 1.5 },
  truck: { len: 11, speed: 0.88, a: 0.9, b: 2.0, T: 1.7 },
  ambulance: { len: 5.6, speed: 1.5, a: 2.4, b: 3.2, T: 0.9 },
};
for (const k in KINDS) KINDS[k].ab = 2 * Math.sqrt(KINDS[k].a * KINDS[k].b);

// Share of the day's peak traffic at each hour.
const PROFILE = [[0, 0.07], [4.5, 0.06], [6, 0.35], [7.5, 1], [8.75, 0.9], [10, 0.6], [12, 0.62], [15, 0.78], [16.5, 1], [17.75, 0.9], [19, 0.5], [22, 0.22], [24, 0.07]];
export function demandAt(hour) {
  for (let k = 1; k < PROFILE.length; k++) {
    if (hour <= PROFILE[k][0]) {
      const [h0, d0] = PROFILE[k - 1];
      const [h1, d1] = PROFILE[k];
      return d0 + ((d1 - d0) * (hour - h0)) / (h1 - h0);
    }
  }
  return PROFILE[0][1];
}

const RANK = [5, 4, 3, 1, 3]; // right of way by road class: motorway, primary, secondary, residential, slip road

export class Sim {
  constructor(map, { seed = 1, clock = 7.5 * 3600 } = {}) {
    const R = map.roads;
    this.rand = mulberry32(seed);
    // Which trips are made is drawn separately from how they are driven, so that two runs of the same
    // hours make the same trips even when a change to the streets sends the drivers different ways.
    this.randTrip = mulberry32(seed + 7919);
    this.time = 0;
    this.clock = clock; // seconds since midnight
    this.tick = 0;
    this.cars = [];
    this.nextId = 1;
    this.peakRate = map.peakRate ?? 2.5; // trips started per second at the height of rush hour
    this.demandScale = 1;
    // Live traffic (see live.js): how busy the measured roads are, in place of the daily profile, and
    // whether the real buses are being shown, so that none of our own need to set out.
    this.liveDemand = null;
    this.liveBuses = false;
    this.narrowed = []; // streets an accident has taken a lane from
    this.carry = 0;
    this.backlog = [];
    this.pending = [];
    this.blockVersion = 0;
    this.blobKey = '';
    this.diverted = 0; // vehicles sent another way by the current closures
    this.detour = 0; // extra driving time those detours cost, in seconds
    this.stats = { started: 0, arrived: 0, lost: 0, tripTime: 0 };

    this.nodes = [];
    for (let k = 0; k < R.nodes.length; k += 2) {
      this.nodes.push({ x: R.nodes[k], z: R.nodes[k + 1], out: [], inc: [], near: new Set(), until: 0, owner: -1, tramUntil: 0 });
    }
    // Two-phase signals are traffic-actuated: `phase` has right of way and `state` is 0 green, 1 amber, 2 all red.
    this.controllers = R.controllers.map(([cycle, g0, g1, offset, phases], k) => ({
      cycle, g0, g1, offset, phases,
      phase: phases === 2 ? k % 2 : 0,
      state: 0,
      timer: (k * 7) % 20,
      approaches: [[], []],
      ped: [0, 0], // until when someone on foot is waiting to cross each phase's traffic
    }));
    this.crossings = map.crossings.map(([x, z, signal]) => ({ x, z, signal, until: 0, claim: 0, roads: [] }));

    this.edges = [];
    const recEdges = [];
    for (const rec of R.edges) {
      const [a, b, cls, oneway, tunnel, lanes, v, way, roundabout, sigF, ctlF, phF, sigB, ctlB, phB, yF, yB, cross, pts] = rec;
      const pair = [-1, -1];
      recEdges.push(pair);
      const common = { cls, tunnel, lanes, v, way, oneway, roundabout, rank: RANK[cls] + (roundabout ? 2 : 0) };
      const add = (from, to, flat, stop, ctl, phase, giveWay, marks) => {
        const e = makeEdge(from, to, flat, { ...common, ctl, phase, giveWay, cars: [], blocked: false, sBlock: 0, rev: -1 });
        if (e.len < 1) return -1;
        // Where the front bumper stops: at the signal, or just short of the junction.
        e.stopS = ctl >= 0 ? Math.min(stop, e.len - 0.5) : e.len > 9 ? e.len - 3 : e.len * 0.65;
        e.cross = [];
        for (let k = 0; k < marks.length; k += 2) {
          if (marks[k] > 3) e.cross.push({ s: marks[k], c: this.crossings[marks[k + 1]] });
        }
        e.cross.sort((p, q) => p.s - q.s);
        e.free = e.len / Math.min(e.v, e.vcap); // seconds to drive it on an empty road
        e.tt = e.free; // recent experience of how long it actually takes
        const idx = this.edges.push(e) - 1;
        if (ctl >= 0) this.controllers[ctl].approaches[phase].push(idx);
        for (const x of e.cross) x.c.roads.push({ edge: idx, s: x.s });
        this.nodes[from].out.push(idx);
        this.nodes[to].inc.push(idx);
        this.nodes[from].near.add(to);
        this.nodes[to].near.add(from);
        return idx;
      };
      pair[0] = add(a, b, pts, sigF, ctlF, phF, yF, cross);
      if (!oneway && pair[0] >= 0) {
        const len = this.edges[pair[0]].len;
        const back = [];
        for (let k = 0; k < cross.length; k += 2) back.push(len - cross[k], cross[k + 1]);
        pair[1] = add(b, a, reversed(pts), sigB, ctlB, phB, yB, back);
        this.edges[pair[0]].rev = pair[1];
        this.edges[pair[1]].rev = pair[0];
      }
    }

    // Which signalled approaches a pedestrian on each crossing has to wait for. A crossing in the middle
    // of a junction touches both phases, so one of them is always green; there, people just watch the cars.
    for (const x of this.crossings) {
      const phases = new Map();
      const lights = [];
      for (const r of x.roads) {
        const e = this.edges[r.edge];
        if (e.ctl < 0 || Math.abs(e.stopS - r.s) > 35) continue;
        phases.set(e.ctl, (phases.get(e.ctl) || 0) | (1 << e.phase));
        lights.push(r.edge);
      }
      x.lights = lights.filter((ei) => phases.get(this.edges[ei].ctl) !== 3);
    }

    // Who gives way: anyone with a sign, and anyone joining a road that outranks theirs.
    this.edges.forEach((e, ei) => {
      e.baseLanes = e.lanes;
      this.rightOfWay(ei);
    });
    this.edits = [];
    this.built = new Map(); // roads added by the planner: edit id -> their edges
    this.roadworks = []; // each in force for part of the day
    this.worksKey = '';
    this.lastBlobs = [];

    // Mapped turn restrictions. (U-turns are refused separately, in route().)
    this.banned = new Set();
    for (const [fromWay, via, toWay, only] of R.restrictions) {
      for (const pi of this.nodes[via].inc) {
        if (this.edges[pi].way !== fromWay) continue;
        for (const fi of this.nodes[via].out) {
          if ((this.edges[fi].way === toWay) !== Boolean(only)) this.banned.add(pi * KEY + fi);
        }
      }
    }

    for (let k = 0; k < R.busStops.length; k += 3) {
      const ei = recEdges[R.busStops[k]][R.busStops[k + 1]];
      if (ei >= 0) (this.edges[ei].stops ||= []).push(R.busStops[k + 2]);
    }

    // Where trips begin and end.
    const gates = [];
    for (let k = 0; k < R.gates.length; k += 2) gates.push({ node: R.gates[k], weight: R.gates[k + 1] });
    this.gateSet = new Set(gates.map((g) => g.node));
    this.gatesIn = this.weighted(gates.filter((g) => this.nodes[g.node].out.length));
    this.gatesOut = this.weighted(gates.filter((g) => this.nodes[g.node].inc.length));
    this.homes = R.homes;
    this.works = R.works;
    this.hospital = map.hospital.node;
    this.incident = map.incident.node;
    this.ambulanceAt = 0;
    // Buses run their real lines, each on its own timetable.
    this.busHeadway = 720;
    this.busLines = R.busLines.map((l) => ({ ...l, ways: new Set(l.ways), next: this.randTrip() * 720 }));

    this.stamp = 0;
    this.resize();
    this.heap = new Heap();
    this.lead = [null, null, null, null];
  }

  // ---------- planning: changes to the street network ----------

  resize() {
    const E = this.edges.length;
    this.cost = new Float64Array(E);
    this.via = new Int32Array(E);
    this.seen = new Uint32Array(E);
    this.closed = new Uint32Array(E);
  }

  // Who gives way at the end of this edge: anyone with a sign, and anyone joining a road that outranks theirs.
  rightOfWay(ei) {
    const e = this.edges[ei];
    e.conflicts = [];
    e.yield = false;
    const node = this.nodes[e.b];
    if (e.ctl >= 0 || node.near.size < 3) return;
    for (const fi of node.inc) {
      const f = this.edges[fi];
      if (fi === ei || f.a === e.a || f.gone) continue;
      if (f.rank > e.rank || (e.giveWay && f.rank >= e.rank)) e.conflicts.push(fi);
    }
    e.yield = e.conflicts.length > 0;
  }

  // The street nearest a point, within `reach` metres: its edge index, or -1. Tunnels are skipped.
  pickEdge(x, z, reach = 30) {
    let best = -1;
    let bestD = reach;
    this.edges.forEach((e, ei) => {
      if (e.tunnel || e.gone || x < e.x0 - reach || x > e.x1 + reach || z < e.z0 - reach || z > e.z1 + reach) return;
      const p = e.pts;
      for (let i = 1; i < e.cum.length; i++) {
        const ax = p[2 * i - 2];
        const az = p[2 * i - 1];
        const dx = p[2 * i] - ax;
        const dz = p[2 * i + 1] - az;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
        const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
        if (d < bestD) {
          bestD = d;
          best = ei;
        }
      }
    });
    return best;
  }

  nearestNode(x, z) {
    let best = 0;
    let bestD = Infinity;
    this.nodes.forEach((n, k) => {
      const d = Math.hypot(n.x - x, n.z - z);
      if (d < bestD && (n.out.length || n.inc.length)) {
        bestD = d;
        best = k;
      }
    });
    return best;
  }

  // Both directions of the street an edge belongs to.
  pair(ei) {
    return this.edges[ei].rev >= 0 ? [ei, this.edges[ei].rev] : [ei];
  }

  // Replaces the whole list of planned changes. Each is one of:
  //   { id, type: 'lanes', edge, lanes }                      a street with more or fewer lanes each way
  //   { id, type: 'works', edge, lanes, from, to }            roadworks between two hours of the day;
  //                                                           lanes 0 closes the street
  //   { id, type: 'road', points: [[x, z], ...], lanes, v }   a new two-way street; its ends join the
  //                                                           nearest existing junctions
  setEdits(list) {
    this.edits = list;
    for (const e of this.edges) e.planLanes = e.baseLanes;
    for (const [id, edges] of this.built) {
      const kept = list.some((x) => x.id === id);
      for (const ei of edges) this.edges[ei].gone = !kept;
    }
    this.roadworks = [];
    for (const x of list) {
      if (x.type === 'lanes') for (const ei of this.pair(x.edge)) this.edges[ei].planLanes = Math.max(1, Math.min(4, x.lanes));
      if (x.type === 'works') this.roadworks.push({ ...x, edges: this.pair(x.edge) });
      if (x.type === 'road' && !this.built.has(x.id)) this.build(x);
    }
    this.worksKey = 'x'; // force the next check to apply everything afresh
    this.applyWorks();
  }

  // Sets every street to its planned width, then applies whichever roadworks are in force right now.
  applyWorks() {
    const hour = this.clock / 3600;
    const active = this.roadworks.filter((w) => (w.from <= w.to ? hour >= w.from && hour < w.to : hour >= w.from || hour < w.to));
    const key = `${this.edits.length}:${active.map((w) => w.id).join(',')}:${this.narrowed.join(',')}`;
    if (key === this.worksKey) return;
    this.worksKey = key;
    for (const e of this.edges) {
      e.lanes = e.planLanes ?? e.baseLanes;
      e.shut = Boolean(e.gone);
    }
    for (const w of active) {
      for (const ei of w.edges) {
        if (w.lanes > 0) this.edges[ei].lanes = Math.min(this.edges[ei].lanes, w.lanes);
        else this.edges[ei].shut = true;
      }
    }
    for (const ei of this.narrowed) this.edges[ei].lanes = Math.max(1, this.edges[ei].lanes - 1);
    for (const c of this.cars) {
      const e = this.edges[c.edge];
      if (c.lane >= e.lanes) c.lane = e.lanes - 1;
      c.nextLane = -1;
    }
    this.blobKey = null;
    this.setBlobs(this.lastBlobs);
  }

  // What the road sensors and incident reports say right now: the speed traffic is really doing on
  // some streets (edge -> m/s; drivers there go no faster), and the streets an accident has narrowed.
  setLive(speeds, narrowed) {
    for (const e of this.edges) e.liveV = 0;
    for (const [ei, v] of speeds) this.edges[ei].liveV = v;
    this.narrowed = narrowed;
    this.applyWorks();
  }

  build(x) {
    const first = x.points[0];
    const last = x.points[x.points.length - 1];
    const a = this.nearestNode(first[0], first[1]);
    const b = this.nearestNode(last[0], last[1]);
    if (a === b) return;
    const flat = [this.nodes[a].x, this.nodes[a].z, ...x.points.slice(1, -1).flat(), this.nodes[b].x, this.nodes[b].z];
    const made = [];
    const add = (from, to, pts) => {
      const e = makeEdge(from, to, pts, {
        cls: 2, tunnel: 0, lanes: x.lanes || 1, v: x.v || 13.9, way: -1, oneway: 0, roundabout: 0, rank: RANK[2],
        ctl: -1, phase: 0, giveWay: 0, cars: [], blocked: false, sBlock: 0, rev: -1, cross: [], planned: true,
      });
      e.stopS = e.len > 9 ? e.len - 3 : e.len * 0.65;
      e.free = e.len / Math.min(e.v, e.vcap);
      e.tt = e.free;
      e.baseLanes = e.planLanes = e.lanes;
      const idx = this.edges.push(e) - 1;
      this.nodes[from].out.push(idx);
      this.nodes[to].inc.push(idx);
      this.nodes[from].near.add(to);
      this.nodes[to].near.add(from);
      made.push(idx);
      return idx;
    };
    const ab = add(a, b, flat);
    const ba = add(b, a, reversed(flat));
    this.edges[ab].rev = ba;
    this.edges[ba].rev = ab;
    this.built.set(x.id, made);
    this.resize();
    // The junctions at either end have a new arm, so work out again who gives way there.
    for (const n of [a, b]) for (const ei of this.nodes[n].inc) this.rightOfWay(ei);
  }

  // ---------- routing ----------

  freeTime(path, from = 0) {
    let t = 0;
    for (let k = from; k < path.length; k++) t += this.edges[path[k]].free;
    return t;
  }

  // Expected time for the rest of a route given current traffic.
  liveTime(path, from = 0) {
    let t = 0;
    for (let k = from; k < path.length; k++) t += this.edges[path[k]].tt;
    return t;
  }

  turnCost(e, f) {
    let c = e.ctl >= 0 ? 8 : e.yield ? 4 : 0;
    const dot = e.ox * f.ix + e.oz * f.iz;
    if (dot < -0.7) c += 15;
    else if (dot < 0.6) c += e.ox * f.iz - e.oz * f.ix > 0 ? 1.5 : 5; // right turns are cheap, left turns cross traffic
    return c;
  }

  // A* over directed edges by travel time, honouring closures and turn bans.
  // Starts either at a node or on the edge a vehicle is already driving; returns the edges still to drive.
  // `congestion` is how much the driver knows about current delays: 0 = none, 1 = live traffic.
  // `prefer` is a set of ways to stick to where possible (a bus line's own streets).
  route(fromNode, fromEdge, dest, congestion = 0.8, jitter = 0, prefer = null) {
    const { nodes, edges, cost, via, seen, closed, heap, banned } = this;
    const stamp = ++this.stamp;
    const T = nodes[dest];
    const time = (f) =>
      (f.free + congestion * (f.tt - f.free)) *
      (jitter ? 1 + jitter * this.rand() : 1) *
      (prefer ? (prefer.has(f.way) ? 0.25 : 2) : 1);
    const open = (fi, c, prev) => {
      if (seen[fi] === stamp && c >= cost[fi]) return;
      cost[fi] = c;
      seen[fi] = stamp;
      via[fi] = prev;
      const B = nodes[edges[fi].b];
      heap.push(c + Math.hypot(B.x - T.x, B.z - T.z) / 31, fi);
    };
    heap.clear();
    if (fromEdge >= 0) open(fromEdge, 0, -1);
    else for (const fi of nodes[fromNode].out) if (!edges[fi].blocked) open(fi, time(edges[fi]), -1);

    let goal = -1;
    while (heap.size) {
      const ei = heap.pop();
      if (closed[ei] === stamp) continue;
      closed[ei] = stamp;
      const e = edges[ei];
      if (e.b === dest) {
        goal = ei;
        break;
      }
      const out = nodes[e.b].out;
      for (const fi of out) {
        const f = edges[fi];
        if (f.blocked || closed[fi] === stamp) continue;
        if (fi === e.rev && out.length > 1) continue;
        if (banned.has(ei * KEY + fi)) continue;
        open(fi, cost[ei] + this.turnCost(e, f) + time(f), ei);
      }
    }
    if (goal < 0) return null;
    const path = [];
    for (let k = goal; k >= 0 && k !== fromEdge; k = via[k]) path.push(k);
    return path.reverse();
  }

  // ---------- signals ----------

  // 0 green, 1 amber, 2 red for traffic leaving this edge.
  signal(e) {
    const C = this.controllers[e.ctl];
    return C.phases === 1 || C.phase === e.phase ? C.state : 2;
  }

  // Is anyone queuing at a red, or still arriving on a green, on this phase of a junction?
  demand(C, phase, queued) {
    for (const ei of C.approaches[phase]) {
      const e = this.edges[ei];
      for (const c of e.cars) {
        const d = e.stopS - c.s - c.len / 2;
        if (d < -1) continue;
        if (queued ? d < 60 && c.v < 2 : d < Math.max(12, c.v * 2.5)) return true;
      }
    }
    return false;
  }

  // Vehicle-actuated control, as most city signals work: green stays while traffic keeps coming,
  // changes when the other street is waiting and this one has a gap or has had its maximum, and rests otherwise.
  stepSignals(dt) {
    for (const C of this.controllers) {
      C.timer += dt;
      if (C.phases === 1) {
        // A pedestrian signal: green for traffic until someone presses the button.
        if (C.state === 0) {
          if (C.timer >= 15 && C.ped[0] > this.time) {
            C.state = 1;
            C.timer = 0;
          }
        } else if (C.timer >= (C.state === 1 ? 3 : 12)) {
          C.state = C.state === 1 ? 2 : 0;
          C.timer = 0;
        }
        continue;
      }
      if (C.state === 0) {
        if (C.timer < 7) continue;
        const max = (C.phase ? C.g1 : C.g0) + 10;
        const wanted = this.demand(C, 1 - C.phase, true) || C.ped[C.phase] > this.time;
        if (wanted && (C.timer >= max || !this.demand(C, C.phase, false))) {
          C.state = 1;
          C.timer = 0;
        }
      } else if (C.state === 1) {
        if (C.timer >= 3) {
          C.state = 2;
          C.timer = 0;
        }
      } else if (C.timer >= 2) {
        C.phase = 1 - C.phase;
        C.state = 0;
        C.timer = 0;
      }
    }
  }

  // ---------- closures ----------

  // blobs: [{x, z, r}] in metres. Any street a blob touches is closed.
  setBlobs(blobs) {
    this.lastBlobs = blobs;
    const key = this.worksKey + '|' + blobs.map((b) => `${b.x.toFixed(0)},${b.z.toFixed(0)},${b.r.toFixed(0)}`).join(';');
    if (key === this.blobKey) return;
    this.blobKey = key;
    let changed = false;
    let fresh = false;
    for (const e of this.edges) {
      // Roadworks and removed roads are shut whatever is on the table.
      let blocked = Boolean(e.shut);
      let sBlock = e.len / 2;
      // An object on the table closes what is on the surface, not a tunnel beneath it.
      for (const b of e.tunnel || blocked ? [] : blobs) {
        const reach = b.r + BLOCK_REACH;
        if (b.x < e.x0 - reach || b.x > e.x1 + reach || b.z < e.z0 - reach || b.z > e.z1 + reach) continue;
        const p = e.pts;
        for (let i = 1; i < e.cum.length && !blocked; i++) {
          const ax = p[2 * i - 2];
          const az = p[2 * i - 1];
          const dx = p[2 * i] - ax;
          const dz = p[2 * i + 1] - az;
          const l2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((b.x - ax) * dx + (b.z - az) * dz) / l2));
          if (Math.hypot(ax + dx * t - b.x, az + dz * t - b.z) < reach) {
            blocked = true;
            sBlock = e.cum[i - 1] + t * Math.sqrt(l2);
          }
        }
        if (blocked) break;
      }
      if (blocked !== e.blocked) {
        changed = true;
        if (blocked) fresh = true;
      }
      e.blocked = blocked;
      e.sBlock = sBlock;
    }
    if (changed) this.blockVersion++;
    if (!blobs.length && !this.edits.length) {
      this.diverted = 0;
      this.detour = 0;
    }
    // Drivers heading for a new closure replan, a few per step so the frame rate holds.
    if (fresh) this.pending = this.cars.slice();
  }

  // Replans a trip that a closure has cut, and records what the detour costs.
  divert(car) {
    const before = this.freeTime(car.path, car.pi);
    const path = this.route(-1, car.edge, car.dest, 0.8, 0.2, car.line?.ways);
    this.diverted++;
    if (!path) return false;
    car.path = path;
    car.pi = 0;
    car.nextLane = -1;
    this.detour += Math.max(0, this.freeTime(path) - before);
    return true;
  }

  // ---------- demand ----------

  weighted(list) {
    let total = 0;
    const cum = list.map((g) => (total += g.weight));
    return { list, cum, total };
  }

  pickGate(set) {
    const r = this.randTrip() * set.total;
    let lo = 0;
    let hi = set.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (set.cum[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return set.list[lo].node;
  }

  pickPlace(list) {
    return list[Math.floor(this.randTrip() * list.length)];
  }

  // Starts new trips at the rate the time of day calls for.
  generate(dt) {
    const hour = this.clock / 3600;
    this.carry += this.peakRate * this.demandScale * (this.liveDemand ?? demandAt(hour)) * dt;
    while (this.carry >= 1) {
      this.carry -= 1;
      const t = this.trip(hour);
      t.path = t.from === t.dest ? null : this.route(t.from, -1, t.dest, 0.8, 0.2);
      if (t.path?.length) this.backlog.push(t);
    }
    // Buses leave on their timetable, more often by day than at night.
    for (const line of this.liveBuses ? [] : this.busLines) {
      line.next -= dt * (0.35 + 0.65 * demandAt(hour));
      if (line.next > 0) continue;
      line.next = this.busHeadway * (0.85 + 0.3 * this.randTrip());
      if (line.path === undefined) line.path = this.route(line.from, -1, line.to, 0, 0, line.ways);
      // A closure on the line means a fresh route this time; otherwise every bus follows the same streets.
      let path = line.path;
      if (path && path.some((ei) => this.edges[ei].blocked)) path = this.route(line.from, -1, line.to, 0.5, 0, line.ways);
      if (path?.length) this.backlog.push({ kind: 'bus', from: line.from, dest: line.to, path: path.slice(), tries: 0, line });
    }

    // Trips wait at their origin until there is room to pull out.
    for (let k = Math.min(16, this.backlog.length); k > 0; k--) {
      const t = this.backlog.shift();
      const car = this.launch(t.kind, t.from, t.dest, t.path);
      if (car && t.line) car.line = t.line;
      if (!car && ++t.tries < 200) this.backlog.push(t);
    }
    if (this.backlog.length > 800) this.backlog.length = 800;
  }

  trip(hour) {
    const morning = hour >= 5 && hour < 11;
    const evening = hour >= 14 && hour < 20;
    const anywhere = this.randTrip() < 0.5 ? this.homes : this.works;
    const r = this.randTrip();
    const inbound = morning ? 0.45 : evening ? 0.15 : 0.28;
    const outbound = morning ? 0.15 : evening ? 0.45 : 0.28;
    let from, dest;
    let through = false;
    if (r < inbound) {
      from = this.pickGate(this.gatesIn);
      dest = this.pickPlace(morning ? this.works : anywhere);
    } else if (r < inbound + outbound) {
      from = this.pickPlace(morning ? this.homes : evening ? this.works : anywhere);
      dest = this.pickGate(this.gatesOut);
    } else if (r < inbound + outbound + 0.22) {
      from = this.pickPlace(morning ? this.homes : anywhere);
      dest = this.pickPlace(morning ? this.works : anywhere);
    } else {
      through = true;
      from = this.pickGate(this.gatesIn);
      for (let k = 0; k < 6; k++) {
        dest = this.pickGate(this.gatesOut);
        if (Math.hypot(this.nodes[dest].x - this.nodes[from].x, this.nodes[dest].z - this.nodes[from].z) > 1500) break;
      }
    }
    const q = this.randTrip();
    const kind = through ? (q < 0.2 ? 'truck' : q < 0.3 ? 'van' : 'car') : q < 0.03 ? 'truck' : q < 0.12 ? 'van' : 'car';
    return { kind, from, dest, tries: 0 };
  }

  // Puts a vehicle on the first street of its route, if there is room for it.
  launch(kind, from, dest, path) {
    const e = this.edges[path[0]];
    if (e.blocked) return null;
    const K = KINDS[kind];
    const lane = this.pickLane(e, K.len, kind);
    const tail = this.tail(e, lane);
    const v = this.gateSet.has(from) ? e.v * 0.8 : 0; // arriving at speed, or pulling out from the kerb
    if (tail && tail.s - tail.len / 2 < K.len + S0 + 2 + v * 1.2) return null;
    const car = {
      id: this.nextId++,
      kind,
      K,
      len: K.len,
      f: K.speed * (0.92 + this.rand() * 0.16),
      edge: path[0],
      lane,
      nextLane: -1,
      s: K.len / 2,
      v,
      acc: 0,
      dest,
      park: !this.gateSet.has(dest),
      path,
      pi: 1,
      wait: 0,
      blockWait: 0,
      dwell: 0,
      served: -1,
      born: this.time,
      since: this.time, // when it joined its current street
      look: this.time + 40 + this.rand() * 40, // when it next checks for a quicker route
      moved: this.tick,
    };
    e.cars.push(car);
    this.cars.push(car);
    this.stats.started++;
    this.onLaunch?.(car, from); // for whoever wants to know who is on the road (the outbreak game)
    return car;
  }

  // ---------- lanes ----------

  // Last vehicle in a lane of an edge, or null.
  tail(e, lane) {
    let last = null;
    for (const c of e.cars) if (c.lane === lane && c.dwell <= 0 && (!last || c.s < last.s)) last = c;
    return last;
  }

  // Keep right unless the right lane is busy; heavy vehicles stay right.
  pickLane(e, len, kind) {
    if (e.lanes === 1) return 0;
    let best = 0;
    let bestRoom = -1;
    for (let l = 0; l < e.lanes; l++) {
      const t = this.tail(e, l);
      const room = t ? t.s - t.len / 2 : 1e9;
      if (l === 0 && (room > 40 || ((kind === 'truck' || kind === 'bus') && room > len + 6))) return 0;
      if (room > bestRoom) {
        bestRoom = room;
        best = l;
      }
    }
    return best;
  }

  // Vehicles stuck behind something slower move over when the next lane has room.
  changeLanes(e) {
    const cars = e.cars;
    for (const c of cars) {
      if (c.dwell > 0 || c.s > e.len - 12 || c.kind === 'bus') continue;
      let gap = Infinity;
      for (const o of cars) if (o !== c && o.lane === c.lane && o.dwell <= 0 && o.s > c.s) gap = Math.min(gap, o.s - c.s);
      const wantsOut = gap < c.v * 1.4 + 8 && c.v < e.v * c.f * 0.85;
      const wantsRight = c.lane > 0 && gap > 60;
      if (!wantsOut && !wantsRight) continue;
      for (const lane of wantsRight ? [c.lane - 1] : [c.lane + 1, c.lane - 1]) {
        if (lane < 0 || lane >= e.lanes) continue;
        let front = Infinity;
        let back = Infinity;
        let backV = 0;
        for (const o of cars) {
          if (o.lane !== lane) continue;
          const d = o.s - c.s;
          if (d >= 0 && d < front) front = d;
          if (d < 0 && -d < back) {
            back = -d;
            backV = o.v;
          }
        }
        if (front > (wantsRight ? 45 : gap + 8) && back > c.len + 4 + backV * 0.8) {
          c.lane = lane;
          break;
        }
      }
    }
  }

  // ---------- junctions ----------

  // May this vehicle, first in line at the end of edge e, drive on?
  mayGo(c, e, ei) {
    const edges = this.edges;
    if (c.pi >= c.path.length) return true;
    let next = edges[c.path[c.pi]];
    if (next.blocked) {
      if (this.time < (c.retry || 0) || !this.divert(c)) {
        c.retry = this.time + 5;
        return false;
      }
      if (c.pi >= c.path.length) return true;
      next = edges[c.path[c.pi]];
    }
    const node = this.nodes[e.b];
    const emergency = c.kind === 'ambulance';
    if (node.tramUntil > this.time) return false;
    if (e.ctl >= 0) {
      const state = emergency ? 0 : this.signal(e);
      if (state === 2) return false;
      // Amber: stop if it can be done comfortably. (A driver who has been waiting to turn left goes now.)
      if (state === 1 && !c.turning && e.stopS - c.s - c.len / 2 > (c.v * c.v) / 7 + 1) return false;
      c.turning = false;
      // Turning left on green means waiting for a gap in the traffic coming the other way.
      if (state === 0 && !emergency && e.ox * next.ix + e.oz * next.iz < 0.6 && e.ox * next.iz - e.oz * next.ix < -0.3) {
        for (const fi of this.controllers[e.ctl].approaches[e.phase]) {
          const f = edges[fi];
          if (fi === ei || e.ox * f.ox + e.oz * f.oz > -0.7) continue;
          for (const q of f.cars) {
            const d = f.stopS - q.s;
            if (d > -3 && d < 70 && q.v > 2 && d / q.v < 3.5) {
              c.turning = true;
              return false;
            }
          }
        }
      }
    } else if (!emergency) {
      if (e.yield) {
        for (const fi of e.conflicts) {
          const f = edges[fi];
          const merge = e.ox * f.ox + e.oz * f.oz > 0.8;
          const need = merge ? GAP_MERGE : f.roundabout ? GAP_ROUNDABOUT : GAP_CROSS;
          for (const q of f.cars) {
            if (merge && q.lane > 0) continue; // only the nearside lane is in the way of a merge
            const d = f.len - q.s;
            if (d > 90) continue;
            if (q.v > 1.5 ? d / q.v < need : d < 8 && q.v > 0.4) return false;
          }
        }
      }
      // Someone from another street is in the junction right now.
      if (node.until > this.time && node.owner !== ei) {
        const owner = edges[node.owner];
        if (owner.rank >= e.rank && owner.a !== next.b) return false;
      }
    }
    // Do not enter a junction you cannot clear.
    if (c.nextLane < 0 || c.nextLane >= next.lanes) c.nextLane = this.pickLane(next, c.len, c.kind);
    const a = this.ahead(c, e);
    if (a && a.v < 2 && a.gap - (e.len - c.s) + c.len / 2 < c.len + S0 + 1) return false;
    return true;
  }

  // The nearest vehicle down the route beyond the current street, looking up to 80 m ahead:
  // its speed and the bumper-to-bumper gap to it.
  ahead(c, e) {
    const edges = this.edges;
    let dist = e.len - c.s;
    for (let k = c.pi; k < c.path.length && dist < 80; k++) {
      const f = edges[c.path[k]];
      const lane = k === c.pi && c.nextLane >= 0 && c.nextLane < f.lanes ? c.nextLane : Math.min(c.lane, f.lanes - 1);
      const t = this.tail(f, lane);
      if (t) return { gap: dist + t.s - (t.len + c.len) / 2, v: t.v };
      dist += f.len;
    }
    return null;
  }

  // ---------- driving ----------

  // Intelligent Driver Model: acceleration given the desired speed and the gap and closing speed to an obstacle.
  idm(c, v0, gap, dv) {
    const K = c.K;
    const free = Math.max(1 - (c.v / v0) ** 4, -1.2 * (K.b / K.a));
    if (gap === Infinity) return K.a * free;
    const want = S0 + Math.max(0, c.v * K.T + (c.v * dv) / K.ab);
    return K.a * (free - (want / Math.max(gap, 0.1)) ** 2);
  }

  drive(c, e, ei, leader, dt) {
    const edges = this.edges;
    const K = c.K;
    if (c.dwell > 0) {
      // A bus standing in the bay at its stop. It pulls out again when there is a gap in its lane.
      c.dwell -= dt;
      c.v = 0;
      c.acc = 0;
      if (c.dwell <= 0) {
        for (const o of e.cars) {
          if (o !== c && o.lane === c.lane && o.dwell <= 0 && Math.abs(o.s - c.s) < (o.len + c.len) / 2 + 3) c.dwell = 1;
        }
      }
      return;
    }
    const half = c.len / 2;
    const left = e.len - c.s;
    const next = c.pi < c.path.length ? edges[c.path[c.pi]] : null;

    // Desired speed: the limit, bends in the road, and slowing for the turn ahead.
    let v0 = Math.min(e.v * c.f, e.vcap);
    if (e.liveV) v0 = Math.min(v0, e.liveV * c.f);
    if (next) {
      const dot = e.ox * next.ix + e.oz * next.iz;
      if (dot < 0.97) {
        const turn = Math.max(3.5, 14 - (Math.acos(Math.max(-1, dot)) / (Math.PI / 2)) * 8.5);
        v0 = Math.min(v0, Math.sqrt(turn * turn + 3.2 * left));
      }
    }
    v0 = Math.max(v0, 1);

    let acc = leader
      ? this.idm(c, v0, leader.s - c.s - (leader.len + c.len) / 2, c.v - leader.v)
      : this.idm(c, v0, Infinity, 0);
    const look = Math.max(45, c.v * 7);

    if (e.blocked && c.s <= e.sBlock) {
      acc = Math.min(acc, this.idm(c, v0, e.sBlock - BLOCK_STOP - c.s - half, c.v));
      if (c.v < 0.3) {
        c.blockWait += dt;
        if (c.blockWait > 14 && e.rev >= 0) {
          // Turn round and find another way.
          const back = edges[e.rev];
          c.edge = e.rev;
          c.s = Math.max(half, Math.min(back.len - half, e.len - c.s));
          c.lane = 0;
          c.nextLane = -1;
          c.v = 0;
          c.blockWait = 0;
          c.since = this.time;
          c.moved = this.tick;
          back.cars.push(c);
          this.divert(c);
          return;
        }
        if (c.blockWait > 90) {
          c.gone = true;
          this.stats.lost++;
          return;
        }
      }
    }

    for (const x of e.cross) {
      const d = x.s - 4 - c.s - half;
      if (d < -1 || d > look) continue;
      // Someone is on the crossing, or waiting at it while we still have room to stop.
      const busy = x.c.until > this.time || (x.c.claim > this.time && d > (c.v * c.v) / 5);
      if (busy) acc = Math.min(acc, this.idm(c, v0, Math.max(d, 0.1), c.v));
    }

    if (e.stops && c.kind === 'bus') {
      for (let k = 0; k < e.stops.length; k++) {
        const id = ei * 8 + k;
        const d = e.stops[k] - c.s;
        if (d < -2 || d > look || id === c.served) continue;
        if (d < 3 && c.v < 0.4) {
          c.dwell = 8 + this.rand() * 12;
          c.served = id;
          c.v = 0;
          c.acc = 0;
          return;
        }
        acc = Math.min(acc, this.idm(c, v0, d + S0 - 1, c.v));
      }
    }

    // The junction at the end of the street.
    const first = !leader || leader.s - leader.len / 2 > e.stopS;
    if (first) {
      const beforeLine = c.s + half <= e.stopS + 0.5;
      if (beforeLine && e.stopS - c.s < look && !this.mayGo(c, e, ei)) {
        acc = Math.min(acc, this.idm(c, v0, Math.max(0.1, e.stopS - c.s - half + S0 * 0.5), c.v));
      } else if (!leader) {
        if (next) {
          // Follow whoever is last on the streets we are about to join.
          const a = this.ahead(c, e);
          if (a) acc = Math.min(acc, this.idm(c, v0, a.gap, c.v - a.v));
        } else if (c.park) {
          // Pulling up at the destination.
          acc = Math.min(acc, this.idm(c, v0, Math.max(0.1, left - half), c.v));
          if (left < half + 6 && c.v < 1) {
            c.gone = true;
            this.arrive(c);
            return;
          }
        }
      }
    }

    acc = Math.max(-9, Math.min(K.a, acc));
    const v = Math.max(0, c.v + acc * dt);
    let ds = ((c.v + v) / 2) * dt;
    if (leader) ds = Math.max(0, Math.min(ds, leader.s - (leader.len + c.len) / 2 - 0.3 - c.s));
    c.acc = acc;
    c.v = v;
    c.s += ds;

    if (v < 0.3) {
      c.wait += dt;
      // Safety net for a jam that cannot clear itself: try another way, and in the end give up the trip.
      if (c.wait > 150 && this.time > (c.retry || 0)) {
        c.retry = this.time + 40;
        const path = this.route(-1, ei, c.dest, 1.5, 0.5);
        if (path) {
          c.path = path;
          c.pi = 0;
          c.nextLane = -1;
        }
      }
      if (c.wait > 400) {
        c.gone = true;
        this.stats.lost++;
        return;
      }
    } else {
      c.wait = 0;
      c.blockWait = 0;
    }

    if (c.s < e.len) return;
    if (c.pi >= c.path.length) {
      c.gone = true;
      if (e.b === c.dest) this.arrive(c);
      else this.stats.lost++;
      return;
    }
    const to = edges[c.path[c.pi]];
    if (to.blocked) {
      c.s = e.len - 0.05;
      c.v = 0;
      return;
    }
    const node = this.nodes[e.b];
    if (e.ctl < 0 && node.near.size >= 3) {
      node.owner = ei;
      node.until = this.time + 1.3;
    }
    // Two vehicles cannot occupy the same stretch of road: wait at the end of this street if the next is full.
    const lane = c.nextLane >= 0 && c.nextLane < to.lanes ? c.nextLane : Math.min(c.lane, to.lanes - 1);
    const t = this.tail(to, lane);
    const room = t ? t.s - (t.len + c.len) / 2 - 0.3 : Infinity;
    if (room < 0) {
      c.s = e.len - 0.05;
      c.v = 0;
      return;
    }
    e.tt += (this.time - c.since - e.tt) * 0.3;
    c.since = this.time;
    c.s = Math.min(c.s - e.len, room);
    c.edge = c.path[c.pi++];
    c.lane = lane;
    c.nextLane = -1;
    c.moved = this.tick;
    to.cars.push(c);
  }

  arrive(c) {
    this.stats.arrived++;
    this.onArrive?.(c);
    this.stats.tripTime += this.time - c.born;
  }

  step(dt) {
    this.time += dt;
    this.clock = (this.clock + dt) % 86400;
    this.tick++;
    if (this.roadworks.length && this.tick % 20 === 0) this.applyWorks();
    const edges = this.edges;
    this.generate(dt);
    if ((!this.ambulance || this.ambulance.gone) && this.time >= this.ambulanceAt) {
      this.ambulanceAt = this.time + 5;
      const path = this.route(this.hospital, -1, this.incident, 1);
      this.ambulance = path?.length ? this.launch('ambulance', this.hospital, this.incident, path) : null;
    }
    for (let k = 0; k < 40 && this.pending.length; k++) {
      const car = this.pending.pop();
      if (car.gone) continue;
      let cut = false;
      for (let i = car.pi; i < car.path.length && !cut; i++) cut = edges[car.path[i]].blocked;
      // Most drivers hear about the closure in time; the rest drive up to it and have to turn round.
      if (cut && this.rand() < 0.75) this.divert(car);
    }

    if (this.tick % 4 === 0) this.stepSignals(dt * 4);

    const lead = this.lead;
    let removed = false;
    let rethinks = 6;
    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei];
      const cars = e.cars;
      if ((this.tick + ei) % 16 === 0) {
        // Keep the travel-time estimate honest: a queue that is not moving counts for as long as it has stood,
        // and an empty street drifts back to its free-flow time.
        let oldest = 0;
        for (const c of cars) oldest = Math.max(oldest, this.time - c.since);
        if (oldest > e.tt) e.tt = oldest;
        else if (!cars.length) e.tt += (e.free - e.tt) * 0.15;
      }
      if (!cars.length) continue;
      if (cars.length > 1) cars.sort((p, q) => q.s - p.s);
      if (e.lanes > 1 && (this.tick + ei) % 8 === 0) this.changeLanes(e);
      lead[0] = lead[1] = lead[2] = lead[3] = null;
      let moved = false;
      for (let k = 0; k < cars.length; k++) {
        const c = cars[k];
        if (c.moved !== this.tick) this.drive(c, e, ei, lead[c.lane], dt);
        if (rethinks && this.time > c.look && !c.gone && c.edge === ei && !c.line) {
          // Drivers with navigation switch route when traffic ahead makes another way clearly quicker.
          c.look = this.time + 60;
          if (c.pi < c.path.length - 2 && this.liveTime(c.path, c.pi) > 1.3 * this.freeTime(c.path, c.pi) + 30) {
            rethinks--;
            const path = this.route(-1, ei, c.dest, 1, 0.1);
            if (path && this.liveTime(path) < 0.8 * this.liveTime(c.path, c.pi)) {
              c.path = path;
              c.pi = 0;
              c.nextLane = -1;
            }
          }
        }
        if (c.edge !== ei || c.gone) {
          moved = true;
          removed ||= Boolean(c.gone);
        } else if (c.dwell <= 0) {
          lead[c.lane] = c; // a bus in its bay is not in anyone's way
        }
      }
      if (moved) e.cars = cars.filter((c) => c.edge === ei && !c.gone);
    }
    if (removed) this.cars = this.cars.filter((c) => !c.gone);
  }

  // ---------- pedestrians ----------

  // May someone step onto crossing x now? 0: yes. 1: wait for the lights. 2: wait for a vehicle that
  // is too close to stop.
  crossingState(x) {
    for (const ei of x.lights) {
      const e = this.edges[ei];
      if (this.signal(e) !== 2) {
        this.controllers[e.ctl].ped[e.phase] = this.time + 3; // presses the button
        return 1;
      }
    }
    for (const r of x.roads) {
      for (const c of this.edges[r.edge].cars) {
        const d = r.s - c.s - c.len / 2;
        if (d > -6 && d < (c.v * c.v) / 5 + 5 && c.v > 0.5) return 2;
      }
    }
    return 0;
  }

  // ---------- measurements ----------

  // Mean speed as a fraction of free flow, 0..1.
  flow() {
    if (!this.cars.length) return 1;
    let sum = 0;
    for (const c of this.cars) sum += Math.min(1, c.v / (this.edges[c.edge].v * c.f));
    return sum / this.cars.length;
  }

  // Mean speed in km/h.
  meanSpeed() {
    if (!this.cars.length) return 0;
    let sum = 0;
    for (const c of this.cars) sum += c.v;
    return (sum / this.cars.length) * 3.6;
  }

  // Number of street segments currently closed.
  closures() {
    let n = 0;
    this.edges.forEach((e, k) => {
      if (e.blocked && !e.gone && (e.rev < 0 || k < e.rev)) n++;
    });
    return n;
  }

  // Fastest way from the hospital to the incident right now.
  emergency() {
    const path = this.route(this.hospital, -1, this.incident, 1);
    if (!path) return null;
    let time = 0;
    for (const ei of path) {
      const e = this.edges[ei];
      time += (e.free + (e.tt - e.free) * 0.5) / KINDS.ambulance.speed;
    }
    return { path, time };
  }
}
