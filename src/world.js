// The static city. The ground is drawn as flat vector shapes (land, water, parks, road surfaces,
// lane markings, zebra crossings, tram and railway tracks) so that it stays sharp at any zoom.
// On top stand the building blocks, trees, stops and labels.

import * as THREE from 'three';

const LAND = '#13161b';
const ROAD_COLOR = ['#7d6f45', '#6c727e', '#5a606b', '#474c57', '#665f47']; // motorway, primary, secondary, residential, slip road
const ROAD_ORDER = [4, 3, 2, 0, 1]; // drawn in this order of class rank, so big roads sit on top of small ones
const PAVEMENT = '#2b2f37';
const SHOULDER = '#0b0d11';
const PAINT = '#d5d9df';
const LANE = 3.2;

const BUILDING_COLORS = [
  ['#b98a6a', '#c9a27c', '#a8795c', '#d4b08a'], // homes
  ['#7f93a8', '#8fa3b5', '#6f8496', '#9aa9b8'], // offices and shops
  ['#6d7278', '#7b8087', '#5f646a', '#868b91'], // industry
  ['#b5a37a', '#a3b08f', '#c2b28a', '#9aa58a'], // civic
  ['#eef1f4', '#e3e8ee', '#f4f6f8', '#dde3ea'], // hospital
  ['#8d8494', '#9a8c98', '#7d7a8c', '#a59aa8'], // other
];

// 1 in full daylight, 0 at night. Shared by everything that dims after dark.
const daylight = { value: 1 };
const groundMaterials = [];
// The ground stops dead at the edge of the map: rivers and roads that carry on beyond it are cut off there.
const mapEdges = [];
export function setDaylight(v) {
  daylight.value = v;
  for (const m of groundMaterials) m.color.setScalar(0.5 + 0.5 * v);
}

// Half the width of the carriageway. Two-way roads have `lanes` lanes each way.
const halfWidth = (oneway, lanes) => (oneway ? lanes * (LANE / 2) + 0.5 : lanes * LANE + 0.4);

// ---------- flat geometry ----------

// Collects coloured triangles lying on the ground and turns them into one mesh.
export class Flat {
  constructor() {
    this.pos = [];
    this.col = [];
    this.c = new THREE.Color();
  }
  color(hex) {
    this.c.set(hex);
    return this;
  }
  tri(ax, az, bx, bz, cx, cz) {
    const { r, g, b } = this.c;
    this.pos.push(ax, 0, az, bx, 0, bz, cx, 0, cz);
    this.col.push(r, g, b, r, g, b, r, g, b);
  }
  quad(ax, az, bx, bz, cx, cz, dx, dz) {
    this.tri(ax, az, bx, bz, cx, cz);
    this.tri(ax, az, cx, cz, dx, dz);
  }
  disc(x, z, r) {
    const n = 14;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const b = ((k + 1) / n) * Math.PI * 2;
      this.tri(x, z, x + Math.cos(a) * r, z + Math.sin(a) * r, x + Math.cos(b) * r, z + Math.sin(b) * r);
    }
  }
  // A band of half-width hw following a polyline, shifted `offset` metres to its right.
  // `show(s)` can hide stretches (tunnels) by distance along the line.
  ribbon(line, hw, offset = 0, show = null) {
    const { pts, cum } = line;
    const n = cum.length;
    let plx, plz, prx, prz;
    let open = false;
    for (let i = 0; i < n; i++) {
      const j = Math.max(0, i - 1);
      const k = Math.min(n - 1, i + 1);
      let tx = pts[2 * k] - pts[2 * j];
      let tz = pts[2 * k + 1] - pts[2 * j + 1];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      // Widen at corners so the band keeps its width round the bend.
      let sx = pts[2 * i] - pts[2 * j];
      let sz = pts[2 * i + 1] - pts[2 * j + 1];
      const sl = Math.hypot(sx, sz);
      const scale = sl > 0 ? 1 / Math.max(0.5, (tx * sx + tz * sz) / sl) : 1;
      const nx = -tz * scale;
      const nz = tx * scale;
      const cx = pts[2 * i] + nx * offset;
      const cz = pts[2 * i + 1] + nz * offset;
      const lx = cx - nx * hw;
      const lz = cz - nz * hw;
      const rx = cx + nx * hw;
      const rz = cz + nz * hw;
      const visible = !show || i === 0 || show((cum[i] + cum[j]) / 2);
      if (open && visible) this.quad(plx, plz, prx, prz, rx, rz, lx, lz);
      open = true;
      plx = lx;
      plz = lz;
      prx = rx;
      prz = rz;
    }
  }
  // Dashes along a polyline: `on` metres painted, `off` metres not.
  dashes(line, hw, offset, on, off) {
    const a = {};
    const b = {};
    for (let s = off / 2; s + on < line.len; s += on + off) {
      at(line, s, a);
      at(line, s + on, b);
      this.bar(a.x - a.dz * offset, a.z + a.dx * offset, b.x - b.dz * offset, b.z + b.dx * offset, hw);
    }
  }
  // A straight bar of half-width hw from one point to another.
  bar(ax, az, bx, bz, hw) {
    const l = Math.hypot(bx - ax, bz - az) || 1;
    const nx = (-(bz - az) / l) * hw;
    const nz = ((bx - ax) / l) * hw;
    this.quad(ax - nx, az - nz, ax + nx, az + nz, bx + nx, bz + nz, bx - nx, bz - nz);
  }
  mesh(order, opts = {}) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    // Ground layers do not write depth: they are painted in order, and everything else stands on top.
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      clippingPlanes: mapEdges,
      ...opts,
    });
    groundMaterials.push(material);
    const mesh = new THREE.Mesh(g, material);
    mesh.renderOrder = order;
    mesh.frustumCulled = false;
    return mesh;
  }
}

function polyline(flat) {
  const pts = Float32Array.from(flat);
  const cum = new Float32Array(pts.length / 2);
  for (let i = 1; i < cum.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
  }
  return { pts, cum, len: cum[cum.length - 1] };
}

// Position and direction at distance s along a polyline.
function at(line, s, out) {
  const { pts, cum } = line;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const l = cum[i] - cum[i - 1] || 1;
  const t = Math.max(0, Math.min(1, (s - cum[i - 1]) / l));
  out.x = pts[2 * i - 2] + (pts[2 * i] - pts[2 * i - 2]) * t;
  out.z = pts[2 * i - 1] + (pts[2 * i + 1] - pts[2 * i - 1]) * t;
  out.dx = (pts[2 * i] - pts[2 * i - 2]) / l;
  out.dz = (pts[2 * i + 1] - pts[2 * i - 1]) / l;
  return out;
}

// ---------- land ----------

// Fills polygons given as lists of rings. Where rings nest, the fill alternates: a ring inside
// another is a hole (an island in the river), a ring inside that is filled again, and so on.
export function fillPolygons(flatMesh, polygons) {
  for (const rings of polygons) {
    const loops = rings
      .map((r) => {
        const v = [];
        const n = r.length / 2 - (r[0] === r[r.length - 2] && r[1] === r[r.length - 1] ? 1 : 0);
        for (let k = 0; k < n; k++) v.push(new THREE.Vector2(r[2 * k], r[2 * k + 1]));
        return v;
      })
      .filter((v) => v.length >= 3);
    if (loops.length === 1) {
      // A plain outline: cut it into triangles, and check the triangles add up to the outline's area.
      const loop = loops[0];
      const faces = THREE.ShapeUtils.triangulateShape(loop, []);
      let covered = 0;
      for (const [a, b, c] of faces) {
        covered += Math.abs((loop[b].x - loop[a].x) * (loop[c].y - loop[a].y) - (loop[c].x - loop[a].x) * (loop[b].y - loop[a].y)) / 2;
      }
      const area = Math.abs(THREE.ShapeUtils.area(loop));
      if (Math.abs(covered - area) <= Math.max(20, area * 0.01)) {
        for (const [a, b, c] of faces) flatMesh.tri(loop[a].x, loop[a].y, loop[b].x, loop[b].y, loop[c].x, loop[c].y);
        continue;
      }
    }
    fillInStrips(flatMesh, loops);
  }
}

// Fills any set of rings, however they touch or nest, by slicing it into horizontal strips between
// one corner's height and the next. Within a strip the edges do not cross, so pairing them off left
// to right gives the filled pieces. Slower and more triangles than cutting ears, but it cannot spill:
// the river, with dozens of quays and islands touching its banks, defeats the quicker method.
function fillInStrips(flatMesh, loops) {
  const edges = []; // [x at top, top, x at bottom, bottom], top above bottom
  const heights = new Set();
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      heights.add(a.y);
      if (a.y !== b.y) edges.push(a.y < b.y ? [a.x, a.y, b.x, b.y] : [b.x, b.y, a.x, a.y]);
    }
  }
  const levels = [...heights].sort((p, q) => p - q);
  edges.sort((p, q) => p[1] - q[1]);
  let next = 0;
  let active = [];
  for (let k = 0; k < levels.length - 1; k++) {
    const top = levels[k];
    const bottom = levels[k + 1];
    while (next < edges.length && edges[next][1] <= top) active.push(edges[next++]);
    active = active.filter((e) => e[3] > top);
    const cuts = active.map((e) => {
      const slope = (e[2] - e[0]) / (e[3] - e[1]);
      return [e[0] + slope * (top - e[1]), e[0] + slope * (bottom - e[1])];
    });
    cuts.sort((p, q) => p[0] + p[1] - (q[0] + q[1]));
    for (let i = 0; i + 1 < cuts.length; i += 2) {
      flatMesh.quad(cuts[i][0], top, cuts[i + 1][0], top, cuts[i + 1][1], bottom, cuts[i][1], bottom);
    }
  }
}

function pointInLoop(p, loop) {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i];
    const b = loop[j];
    if (a.y <= p.y !== b.y <= p.y && p.x < a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x)) inside = !inside;
  }
  return inside;
}

// ---------- the ground ----------

export function buildGround(map) {
  const [WX, WZ] = map.size;
  const group = new THREE.Group();
  mapEdges.push(
    new THREE.Plane(new THREE.Vector3(1, 0, 0), 0),
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), WX),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
    new THREE.Plane(new THREE.Vector3(0, 0, -1), WZ),
  );

  const land = new Flat().color(LAND);
  land.quad(0, 0, WX, 0, WX, WZ, 0, WZ);
  land.color('#1b3a25');
  fillPolygons(land, map.green);
  land.color('#27603a');
  fillPolygons(land, map.pitch);
  land.color('#0e2d52');
  fillPolygons(land, map.water);
  group.add(land.mesh(-20));

  // Roads. Each record: [a, b, class, oneway, tunnel, lanes, ..., crossings at 17, points at 18].
  const roads = map.roads.edges
    .map((r) => ({
      a: r[0], b: r[1], cls: r[2], oneway: r[3], tunnel: r[4], lanes: r[5],
      stopF: r[9], ctlF: r[10], stopB: r[12], ctlB: r[13], cross: r[17],
      line: polyline(r[18]),
      hw: halfWidth(r[3], r[5]),
    }))
    .sort((p, q) => ROAD_ORDER[p.cls] - ROAD_ORDER[q.cls]);

  // The widest road at each junction decides how big a patch fills the gap between the road ends.
  const nodeCount = map.roads.nodes.length / 2;
  const nodeHalf = new Float32Array(nodeCount);
  const nodeCls = new Int8Array(nodeCount).fill(-1);
  for (const r of roads) {
    if (r.tunnel) continue;
    for (const k of [r.a, r.b]) {
      if (r.hw > nodeHalf[k]) nodeHalf[k] = r.hw;
      if (nodeCls[k] < 0 || ROAD_ORDER[r.cls] > ROAD_ORDER[nodeCls[k]]) nodeCls[k] = r.cls;
    }
  }
  const motorway = (cls) => cls === 0 || cls === 4;

  const kerb = new Flat();
  const asphalt = new Flat();
  const tunnels = new Flat().color('#7f8ea3');
  for (const r of roads) {
    if (r.tunnel) {
      tunnels.ribbon(r.line, r.hw * 0.7);
      continue;
    }
    // Streets get a pavement either side; motorways a dark verge.
    kerb.color(motorway(r.cls) ? SHOULDER : PAVEMENT).ribbon(r.line, r.hw + (motorway(r.cls) ? 0.9 : 2.3));
    asphalt.color(ROAD_COLOR[r.cls]).ribbon(r.line, r.hw);
  }
  for (let k = 0; k < nodeCount; k++) {
    if (nodeCls[k] < 0) continue;
    const x = map.roads.nodes[2 * k];
    const z = map.roads.nodes[2 * k + 1];
    kerb.color(motorway(nodeCls[k]) ? SHOULDER : PAVEMENT).disc(x, z, nodeHalf[k] + (motorway(nodeCls[k]) ? 0.9 : 2.3));
    asphalt.color(ROAD_COLOR[nodeCls[k]]).disc(x, z, nodeHalf[k]);
  }
  group.add(kerb.mesh(-18), asphalt.mesh(-17), tunnels.mesh(-19, { transparent: true, opacity: 0.16 }));

  // Paint on the road: centre lines, lane lines, stop lines, zebra crossings.
  const paint = new Flat().color(PAINT);
  const P = {};
  const drawn = new Set();
  for (const r of roads) {
    if (r.tunnel) continue;
    const { line, lanes, oneway, cls } = r;
    if (cls !== 3) {
      if (!oneway) {
        if (lanes > 1) paint.ribbon(line, 0.13);
        else paint.dashes(line, 0.1, 0, 3, 9);
      }
      for (let k = 1; k < lanes; k++) {
        if (oneway) paint.dashes(line, 0.1, (k - lanes / 2) * LANE, 3, 9);
        else {
          paint.dashes(line, 0.1, k * LANE, 3, 9);
          paint.dashes(line, 0.1, -k * LANE, 3, 9);
        }
      }
      if (cls === 0) {
        paint.ribbon(line, 0.1, lanes * (LANE / 2));
        paint.ribbon(line, 0.1, -lanes * (LANE / 2));
      }
    }
    // Stop lines across the lanes that a signal holds, for each direction of travel.
    const stopLine = (s, forward) => {
      at(line, forward ? s : line.len - s, P);
      const sign = forward ? 1 : -1;
      const from = oneway ? -lanes * (LANE / 2) : 0;
      const to = oneway ? lanes * (LANE / 2) : lanes * LANE;
      const nx = -P.dz * sign;
      const nz = P.dx * sign;
      paint.bar(P.x + nx * from, P.z + nz * from, P.x + nx * to, P.z + nz * to, 0.22);
    };
    if (r.ctlF >= 0) stopLine(r.stopF, true);
    if (r.ctlB >= 0) stopLine(r.stopB, false);
    // Zebra stripes, once per crossing.
    if (cls !== 0) {
      for (let k = 0; k < r.cross.length; k += 2) {
        if (drawn.has(r.cross[k + 1])) continue;
        drawn.add(r.cross[k + 1]);
        at(line, r.cross[k], P);
        for (let u = -r.hw + 0.4; u < r.hw - 0.1; u += 1) {
          const x = P.x - P.dz * u;
          const z = P.z + P.dx * u;
          paint.bar(x - P.dx * 1.6, z - P.dz * 1.6, x + P.dx * 1.6, z + P.dz * 1.6, 0.25);
        }
      }
    }
  }
  group.add(paint.mesh(-16));

  // Rails: a bed, then the two rails of each track.
  const beds = new Flat();
  const rails = new Flat();
  for (const [tunnel, ...flatPts] of map.rails) {
    if (tunnel) continue;
    const line = polyline(flatPts);
    beds.color('#24272e').ribbon(line, 1.8);
    rails.color('#8e97a5').ribbon(line, 0.09, 0.72);
    rails.ribbon(line, 0.09, -0.72);
  }
  for (const t of map.tramLines) {
    const line = polyline(t.pts);
    const above = (s) => {
      for (let k = 0; k < t.tunnels.length; k += 2) if (s >= t.tunnels[k] && s <= t.tunnels[k + 1]) return false;
      return true;
    };
    rails.color('#b4bfcc').ribbon(line, 0.1, 0.72, above);
    rails.ribbon(line, 0.1, -0.72, above);
  }
  group.add(beds.mesh(-19), rails.mesh(-15));

  // Helipads.
  const pads = new Flat();
  for (const [x, z] of map.helipads) {
    pads.color('#f2c94c').disc(x, z, 13);
    pads.color('#1d2026').disc(x, z, 11.5);
    pads.color('#f2c94c');
    pads.bar(x - 4, z - 5, x - 4, z + 5, 0.8);
    pads.bar(x + 4, z - 5, x + 4, z + 5, 0.8);
    pads.bar(x - 4, z, x + 4, z, 0.8);
  }
  group.add(pads.mesh(-14));
  return group;
}

// ---------- buildings ----------

// Walls get a grid of windows computed from world position, so every floor shows at any zoom,
// and the ground floor gets shop fronts.
const buildingMaterial = new THREE.ShaderMaterial({
  uniforms: { uDay: daylight },
  vertexShader: /* glsl */ `
    varying vec3 vWorld;
    varying vec3 vNormal;
    varying vec3 vColor;
    void main() {
      vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
      vWorld = world.xyz;
      vNormal = normal;
      vColor = instanceColor;
      gl_Position = projectionMatrix * viewMatrix * world;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uDay;
    varying vec3 vWorld;
    varying vec3 vNormal;
    varying vec3 vColor;
    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    void main() {
      float light = 0.5 + 0.5 * max(dot(vNormal, normalize(vec3(0.35, 1.0, 0.55))), 0.0);
      vec3 color = vColor * light * (0.4 + 0.6 * uDay);
      if (vNormal.y > 0.5) {
        // Roofs: a little grain per 2 m block, and taller buildings catch more light.
        color *= 0.9 + 0.14 * hash(floor(vWorld.xz / 2.0)) + 0.12 * clamp(vWorld.y / 60.0, 0.0, 1.0);
      } else if (abs(vNormal.y) < 0.5) {
        float along = abs(vNormal.x) > 0.5 ? vWorld.z : vWorld.x;
        bool shop = vWorld.y < 3.4 && vColor.b > vColor.r * 0.6;
        vec2 grid = shop ? vec2(along / 4.5, vWorld.y / 3.4) : vec2(along / 3.0, vWorld.y / 3.2);
        vec2 cell = fract(grid);
        float window = shop
          ? step(0.08, cell.x) * step(cell.x, 0.92) * step(0.14, cell.y) * step(cell.y, 0.82)
          : step(0.22, cell.x) * step(cell.x, 0.78) * step(0.3, cell.y) * step(cell.y, 0.8);
        // A few windows are lit by day; about half of them after dark. Shops keep their lights on.
        float lit = step(shop ? 0.35 : mix(0.5, 0.93, uDay), hash(floor(grid) + floor(vWorld.xz / 37.0)));
        vec3 glass = mix(vec3(0.03, 0.045, 0.07), vec3(1.0, 0.82, 0.5), lit);
        // Fade the windows out once they get smaller than a pixel, so far walls don't shimmer.
        float detail = 1.0 - smoothstep(0.3, 0.7, max(fwidth(grid.x), fwidth(grid.y)));
        color = mix(mix(color, color * 0.8 + vec3(0.05, 0.045, 0.03), 0.5), mix(color, glass, window), detail);
      }
      gl_FragColor = vec4(color, 1.0);
      #include <colorspace_fragment>
    }
  `,
});

export function buildBuildings(map) {
  const B = map.boxes;
  const cell = map.cell;
  const count = B.length / 6;
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), buildingMaterial, count);
  const m = new THREE.Matrix4();
  const color = new THREE.Color();
  for (let k = 0; k < count; k++) {
    const col = B[6 * k];
    const row = B[6 * k + 1];
    const len = B[6 * k + 2];
    const h = B[6 * k + 3];
    m.makeScale(len * cell, h, cell);
    m.setPosition((col + len / 2) * cell, h / 2, (row + 0.5) * cell);
    mesh.setMatrixAt(k, m);
    const variant = B[6 * k + 5];
    color.set(BUILDING_COLORS[B[6 * k + 4]][variant & 3]).multiplyScalar(0.82 + 0.09 * (variant >> 2));
    mesh.setColorAt(k, color);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

// ---------- trees, stops, labels ----------

// Every mapped tree, as a trunk and a crown.
export function buildTrees(map) {
  const T = map.trees;
  const count = T.length / 2;
  const box = new THREE.BoxGeometry(1, 1, 1);
  const crowns = new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial(), count);
  const trunks = new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial({ color: '#5b4636' }), count);
  const m = new THREE.Matrix4();
  const color = new THREE.Color();
  const greens = ['#2f7d3a', '#3a8f45', '#2a6e33', '#4a9a4f', '#356f2e'];
  for (let k = 0; k < count; k++) {
    const x = T[2 * k];
    const z = T[2 * k + 1];
    // Size and shade vary from tree to tree, the same way every time.
    const r = Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;
    const w = 3.5 + r * 3;
    const h = 4 + ((r * 7) % 1) * 4;
    const trunk = 2 + ((r * 13) % 1) * 2;
    m.makeScale(w, h, w);
    m.setPosition(x, trunk + h / 2, z);
    crowns.setMatrixAt(k, m);
    crowns.setColorAt(k, color.set(greens[Math.floor(r * greens.length)]));
    m.makeScale(0.7, trunk, 0.7);
    m.setPosition(x, trunk / 2, z);
    trunks.setMatrixAt(k, m);
  }
  crowns.frustumCulled = false;
  trunks.frustumCulled = false;
  const group = new THREE.Group();
  group.add(crowns, trunks);
  return group;
}

// Tram platforms beside the track and shelters at the bus stops.
export function buildStops(map) {
  const items = []; // x, z, direction, length, height, width, colour
  const P = {};
  const seen = new Set();
  for (const t of map.tramLines) {
    const line = polyline(t.pts);
    for (const s of t.stops) {
      at(line, Math.max(0, s - 15), P);
      const x = P.x - P.dz * 2.9;
      const z = P.z + P.dx * 2.9;
      const key = `${Math.round(x / 10)},${Math.round(z / 10)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push([x, 0.18, z, P.dx, P.dz, 32, 0.36, 2.6, '#8a909b']);
      items.push([x - P.dz * 0.6, 1.5, z + P.dx * 0.6, P.dx, P.dz, 8, 2.3, 1.2, '#5f7d94']);
    }
  }
  const S = map.roads.busStops;
  for (let k = 0; k < S.length; k += 3) {
    const r = map.roads.edges[S[k]];
    const line = polyline(r[18]);
    const backward = S[k + 1] === 1;
    at(line, backward ? line.len - S[k + 2] : S[k + 2], P);
    const side = (halfWidth(r[3], r[5]) + 3.6) * (backward ? -1 : 1);
    items.push([P.x - P.dz * side, 1.25, P.z + P.dx * side, P.dx, P.dz, 4.2, 2.5, 1.5, '#5f7d94']);
  }

  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), items.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();
  items.forEach(([x, y, z, dx, dz, l, h, w, hex], k) => {
    q.setFromAxisAngle(up, Math.atan2(-dz, dx));
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(l, h, w));
    mesh.setMatrixAt(k, m);
    mesh.setColorAt(k, color.set(hex));
  });
  mesh.frustumCulled = false;
  return mesh;
}

export function buildLabels(map) {
  return map.labels.map(([text, x, z]) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const font = '600 44px ui-sans-serif, system-ui, sans-serif';
    ctx.font = font;
    canvas.width = Math.ceil(ctx.measureText(text).width) + 40;
    canvas.height = 72;
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(5, 7, 10, 0.9)';
    ctx.strokeText(text, 20, 38);
    ctx.fillStyle = '#f3f5f7';
    ctx.fillText(text, 20, 38);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true, sizeAttenuation: false }),
    );
    sprite.renderOrder = 10;
    sprite.position.set(x, 90, z);
    sprite.userData.aspect = canvas.width / canvas.height;
    return sprite;
  });
}
