import * as THREE from 'three';
import { Sim, LANE_WIDTH } from './sim.js';
import { Trams, Ferries, inTunnel } from './transit.js';
import { People } from './people.js';
import { pointAt } from './geometry.js';
import { buildGround, buildBuildings, buildTrees, buildStops, buildLabels, setDaylight } from './world.js';
import { MouseInput } from './input.js';
import { Outbreak, ACTIONS, DAY } from './virus.js';
import { SIDES, gameRect, sideAt, ownsAction, privateOverlays, publicCounts } from './game-view.js';
import { startTablePlay } from './virus-table.js';
import * as relay from './room/relay.js';

const SPEEDS = [1, 3, 10, 30]; // simulated seconds per real second
const MAX_STEP = 0.12; // longest simulation step, in seconds, that keeps the driving model stable
const MAX_PARTS = 40000;
const MAX_LIGHTS = 12000;
const MAX_PEOPLE = 14000;
const MAX_STRIPS = 4000;
const MAX_JAMS = 3000;
const MAX_DOTS = 1200;

// ?map=west loads the larger map that reaches Älvsborgsbron; without it, the city centre.
const params = new URLSearchParams(location.search);
const mapName = params.get('map');
const map = await (await fetch(mapName && mapName !== 'central' ? `/gbg-${mapName}.json` : '/gbg.json')).json();
const [WX, WZ] = map.size;
const sim = new Sim(map);
const trams = new Trams(map.tramLines, sim);
const ferries = new Ferries(map.ferries);
// About one person out walking for every 14 stretches of footpath, and one cyclist per 95.
// In the outbreak game people live around homes and workplaces, so dense districts have the crowds.
const gameMode = params.has('game') && params.get('view') !== 'screen';
const anchors = gameMode ? [...sim.homes, ...sim.works].map((i) => [sim.nodes[i].x, sim.nodes[i].z]) : null;
const people = new People(map.paths, sim, {
  walkers: Math.round(map.paths.edges.length * 0.072),
  cyclists: Math.round(map.paths.edges.length * 0.0105),
  anchors,
});

// Place indoor agents on their assigned paths too, so both views can display every person.
if (params.has('game')) for (const p of people.agents) pointAt(people.edges[p.edge], p.s, p);

// ?game turns the table into a two-player outbreak: one player spreads a virus, the other curbs it.
const game = gameMode ? new Outbreak(people, { sim, trams }) : null;
if (game) document.body.classList.add('game');

function stepAll(dt) {
  sim.step(dt);
  trams.step(dt);
  ferries.step(dt);
  people.step(dt);
  game?.step(dt);
}
// Start with the city already busy rather than filling up from empty.
for (let t = 0; t < 420; t += 0.15) stepAll(0.15);

// ---------- renderer, cameras, lights ----------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.localClippingEnabled = true; // lets the ground be cut off at the edge of the map
document.body.appendChild(renderer.domElement);
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

const scene = new THREE.Scene();
scene.background = new THREE.Color('#000000');
const sky = new THREE.HemisphereLight('#dfe8ff', '#30343c', 1.6);
const sun = new THREE.DirectionalLight('#fff1d6', 1.5);
sun.position.set(0.35, 1, 0.55);
scene.add(sky, sun);

scene.add(buildGround(map), buildBuildings(map), buildTrees(map), buildStops(map));
const labels = buildLabels(map);
scene.add(...labels);

// Table view looks straight down like the projector; screen view is a 3D flyover for the TVs.
const tableCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 6000);
tableCam.up.set(0, 0, -1);
const screenCam = new THREE.PerspectiveCamera(38, 1, 5, 60000);

let view = params.get('view') === 'screen' ? 'screen' : 'table';
const camera = () => (view === 'table' ? tableCam : screenCam);
// The table window leads: it owns the objects, the clock and where the map is looking.
// Windows opened with ?view=screen follow it.
const follower = view === 'screen';

// What the cameras look at: a point on the ground and how many metres fit across the window.
const focus = { x: WX / 2, z: WZ / 2 };
let zoom = 1;
let orbit = 0.9;
const aspect = () => innerWidth / innerHeight;
const fitZoom = () => Math.max(WX, WZ * aspect()) * 1.04;
const metresPerPixel = () => zoom / innerWidth;

function updateCameras() {
  // No zooming out past the whole map, and no panning off its edge.
  zoom = Math.max(35, Math.min(fitZoom(), zoom));
  const halfW = zoom / 2;
  const halfH = halfW / aspect();
  focus.x = zoom >= WX ? WX / 2 : Math.max(halfW, Math.min(WX - halfW, focus.x));
  focus.z = halfH * 2 >= WZ ? WZ / 2 : Math.max(halfH, Math.min(WZ - halfH, focus.z));
  tableCam.left = -halfW;
  tableCam.right = halfW;
  tableCam.top = halfH;
  tableCam.bottom = -halfH;
  tableCam.position.set(focus.x, 3000, focus.z);
  tableCam.lookAt(focus.x, 0, focus.z);
  tableCam.updateProjectionMatrix();
  tableCam.updateMatrixWorld();

  const dist = zoom * 0.95;
  screenCam.aspect = aspect();
  screenCam.near = dist / 50;
  screenCam.position.set(focus.x + Math.cos(orbit) * dist * 0.72, dist * 0.55, focus.z + Math.sin(orbit) * dist * 0.72);
  screenCam.lookAt(focus.x, 0, focus.z);
  screenCam.updateProjectionMatrix();
  screenCam.updateMatrixWorld();
}

const gameViews = Object.fromEntries(SIDES.map(side => {
  const cam = tableCam.clone();
  return [side, { cam, x: WX / 2, z: WZ / 2, zoom: 1, armed: null, toastUntil: 0 }];
}));
let activeSide = 'spreader';
function updateGameCamera(side, fit = false) {
  const v = gameViews[side];
  const rect = gameRect(side, innerWidth, innerHeight);
  const ratio = rect.width / rect.height;
  const whole = Math.max(WX, WZ * ratio) * 1.04;
  v.zoom = fit ? whole : Math.max(35, Math.min(whole, v.zoom));
  const w = v.zoom / 2, h = w / ratio;
  v.x = v.zoom >= WX ? WX / 2 : Math.max(w, Math.min(WX - w, v.x));
  v.z = h * 2 >= WZ ? WZ / 2 : Math.max(h, Math.min(WZ - h, v.z));
  Object.assign(v.cam, { left: -w, right: w, top: h, bottom: -h });
  v.cam.position.set(v.x, 3000, v.z);
  v.cam.lookAt(v.x, 0, v.z);
  v.cam.updateProjectionMatrix();
  v.cam.updateMatrixWorld();
}
function zoomGame(side, factor) {
  gameViews[side].zoom *= factor;
  updateGameCamera(side);
}

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  updateCameras();
  if (game) for (const side of SIDES) updateGameCamera(side);
}
addEventListener('resize', resize);
zoom = fitZoom();
resize();
if (game) for (const side of SIDES) updateGameCamera(side, true);

// ---------- dynamic meshes ----------

const unitBox = new THREE.BoxGeometry(1, 1, 1);
const m4 = new THREE.Matrix4();
const quat = new THREE.Quaternion();
const vPos = new THREE.Vector3();
const vScale = new THREE.Vector3();
const yAxis = new THREE.Vector3(0, 1, 0);
const tmpColor = new THREE.Color();

function pool(material, count, order = 0) {
  const mesh = new THREE.InstancedMesh(unitBox, material, count);
  mesh.setColorAt(0, tmpColor.set('#ffffff'));
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.renderOrder = order;
  scene.add(mesh);
  return mesh;
}

// A box of size (length, height, width) centred at (x, y, z), pointing along (dx, dz).
function putBox(mesh, k, x, y, z, dx, dz, l, h, w, color) {
  quat.setFromAxisAngle(yAxis, Math.atan2(-dz, dx));
  m4.compose(vPos.set(x, y, z), quat, vScale.set(l, h, w));
  mesh.setMatrixAt(k, m4);
  if (color) mesh.setColorAt(k, color);
}

const bodies = pool(new THREE.MeshLambertMaterial(), MAX_PARTS); // vehicle bodywork, lit by the sun
const lamps = pool(new THREE.MeshBasicMaterial(), MAX_LIGHTS); // things that glow: lamps and traffic lights
const walkers = pool(game ? new THREE.MeshBasicMaterial({ depthTest: false }) : new THREE.MeshLambertMaterial(), MAX_PEOPLE, game ? 4 : 0);
const jamStrips = pool(
  new THREE.MeshBasicMaterial({ color: '#ff8a1f', transparent: true, opacity: 0.5, depthTest: false }),
  MAX_JAMS,
  1,
);
const closedStrips = pool(
  new THREE.MeshBasicMaterial({ color: '#ff3b30', transparent: true, opacity: 0.6, depthTest: false }),
  MAX_STRIPS,
  2,
);
const heatCells = pool(
  new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5, depthTest: false }),
  3000,
  1,
);
const routeDots = pool(new THREE.MeshBasicMaterial({ color: '#5ad1ff', depthTest: false }), MAX_DOTS, 3);

// Parts per vehicle: [offset along, centre height, length, height, width, colour role].
// Roles: 0 = the vehicle's own paint, 1 = glass, 2 = white, 3 = red.
const PARTS = {
  car: [[0, 0.55, 4.4, 0.9, 1.8, 0], [-0.3, 1.3, 2.2, 0.7, 1.6, 1]],
  van: [[0, 1.0, 5.3, 1.9, 2.0, 0], [1.75, 1.35, 1.4, 0.8, 2.04, 1]],
  bus: [[0, 1.6, 12, 2.8, 2.5, 0], [0, 2.1, 11.2, 0.9, 2.56, 1]],
  truck: [[4.0, 1.4, 2.4, 2.6, 2.4, 0], [-1.3, 1.9, 8, 3.4, 2.5, 2]],
  ambulance: [[0, 1.2, 5.5, 2.2, 2.1, 2], [0, 0.9, 5.56, 0.45, 2.16, 3]],
};
const PAINT = {
  car: ['#dfe3e8', '#9aa5b1', '#c0392b', '#2d6cdf', '#f2c94c', '#1f9d6b', '#f08a24', '#5b6470', '#22262c', '#7a1f2b'],
  van: ['#dfe3e8', '#f2c94c', '#9aa5b1'],
  bus: ['#1f6fb2'],
  truck: ['#c0392b', '#2d6cdf', '#1f9d6b', '#f08a24'],
  ambulance: ['#eef1f4'],
};
const CLOTHES = ['#d9534f', '#3b7dd8', '#e8c547', '#4caf7d', '#b8bec7', '#8e6bbf', '#f08a24', '#2b2f36'];
const color = (hex) => new THREE.Color(hex);
const GLASS = color('#18202c');
const WHITE = color('#eef1f4');
const RED = color('#e02b3a');
const TRAM_BLUE = color('#1d5fa8');
const TYRE = color('#101216');
const SKIN = color('#e0b99a');
const TROUSERS = color('#2b2f36');
const TAIL_OFF = color('#4a1014');
const TAIL_ON = color('#ff2a2a');
const HEAD_DAY = color('#b9bec6');
const HEAD_NIGHT = color('#fff3c4');
const SIGNAL = [color('#2ee66b'), color('#ffc233'), color('#ff3b30')];
const paintCache = new Map();
const paint = (hex) => paintCache.get(hex) || paintCache.set(hex, color(hex)).get(hex);

// One bar across the lanes at every signalled stop line.
const P = {};
const signals = [];
sim.edges.forEach((e) => {
  if (e.ctl < 0 || e.tunnel) return;
  pointAt(e, e.stopS + 1, P);
  const side = e.oneway ? 0 : (e.lanes * LANE_WIDTH) / 2;
  signals.push({ e, x: P.x - P.dz * side, z: P.z + P.dx * side, dx: P.dx, dz: P.dz });
});

const rings = [];
function ring(k) {
  while (rings.length <= k) {
    const g = new THREE.Group();
    const edge = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1, 64),
      new THREE.MeshBasicMaterial({ color: '#ff6a5e', depthTest: false }),
    );
    const fill = new THREE.Mesh(
      new THREE.CircleGeometry(0.9, 64),
      new THREE.MeshBasicMaterial({ color: '#ff3b30', transparent: true, opacity: 0.2, depthTest: false }),
    );
    edge.renderOrder = 5;
    fill.renderOrder = 4;
    g.add(edge, fill);
    g.rotation.x = -Math.PI / 2;
    scene.add(g);
    rings.push(g);
  }
  return rings[k];
}

const marker = (node, hex) => {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.7, 1, 48), new THREE.MeshBasicMaterial({ color: hex, depthTest: false }));
  m.rotation.x = -Math.PI / 2;
  m.position.set(sim.nodes[node].x, 2, sim.nodes[node].z);
  m.renderOrder = 6;
  scene.add(m);
  return m;
};
const markers = [marker(sim.hospital, '#5ad1ff'), marker(sim.incident, '#ff9f1c')];

// The circle shown on the table during calibration: put an object on it.
const target = new THREE.Group();
for (const [geometry, opacity] of [
  [new THREE.RingGeometry(0.8, 1, 64), 1],
  [new THREE.CircleGeometry(0.8, 64), 0.35],
  [new THREE.CircleGeometry(0.12, 24), 1],
]) {
  const part = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: opacity < 1, opacity, depthTest: false }),
  );
  part.renderOrder = 8;
  target.add(part);
}
target.rotation.x = -Math.PI / 2;
target.visible = false;
scene.add(target);

// ---------- input ----------

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const ndc = new THREE.Vector2();
const hitPoint = new THREE.Vector3();

function pick(e, side = game ? sideAt(e.clientX, e.clientY, innerWidth, innerHeight) : null) {
  if (game) {
    if (!side) return null;
    const r = gameRect(side, innerWidth, innerHeight);
    ndc.set(((e.clientX - r.x) / r.width) * 2 - 1, -((e.clientY - r.y) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, gameViews[side].cam);
    if (!raycaster.ray.intersectPlane(groundPlane, hitPoint)) return null;
    return { x: hitPoint.x, z: hitPoint.z };
  }
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera());
  if (!raycaster.ray.intersectPlane(groundPlane, hitPoint)) return null;
  return { x: hitPoint.x, z: hitPoint.z };
}

const mouse = new MouseInput(renderer.domElement, e => game ? null : pick(e), () => Math.max(12, zoom * 0.014));

// Scroll zooms towards the cursor, or resizes an object if the cursor is on one.
renderer.domElement.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (game) {
      const side = sideAt(e.clientX, e.clientY, innerWidth, innerHeight);
      if (!side) return;
      activeSide = side;
      const before = pick(e, side);
      zoomGame(side, Math.exp(e.deltaY * 0.0015));
      const after = pick(e, side);
      if (before && after) { gameViews[side].x += before.x - after.x; gameViews[side].z += before.z - after.z; updateGameCamera(side); }
      return;
    }
    const before = pick(e);
    const blob = before && mouse.hit(before);
    if (blob) {
      blob.r = Math.max(8, Math.min(600, blob.r * Math.exp(-e.deltaY * 0.002)));
      return;
    }
    zoom *= Math.exp(e.deltaY * 0.0015);
    updateCameras();
    const after = pick(e);
    if (before && after) {
      focus.x += before.x - after.x;
      focus.z += before.z - after.z;
      updateCameras();
    }
  },
  { passive: false },
);

// Right-drag or shift-drag pans.
let grab = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 2 && !(e.button === 0 && e.shiftKey)) return;
  if (game) {
    const side = sideAt(e.clientX, e.clientY, innerWidth, innerHeight);
    if (!side) return;
    activeSide = side;
    grab = { ...pick(e, side), side };
  } else grab = pick(e);
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!grab) return;
  if (game) {
    const p = pick(e, grab.side);
    if (!p) return;
    const v = gameViews[grab.side];
    v.x += grab.x - p.x; v.z += grab.z - p.z;
    updateGameCamera(grab.side);
    return;
  }
  const p = pick(e);
  if (!p) return;
  focus.x += grab.x - p.x;
  focus.z += grab.z - p.z;
  updateCameras();
});
renderer.domElement.addEventListener('pointerup', () => (grab = null));

// Swap point for the real depth camera: feed it objects in table coordinates,
// x and y from 0 to 1 across the projected image, r as a fraction of its width.
let external = [];
const fromTable = (b) => ({
  x: focus.x + (b.x - 0.5) * zoom,
  z: focus.z + ((b.y - 0.5) * zoom) / aspect(),
  r: (b.r ?? 0.02) * zoom,
});

let speed = game ? 3 : 1; // index into SPEEDS
let paused = false;

// ---------- the room: depth camera, calibration, other windows ----------

let remote = []; // objects in metres, as told by the table window (screens only)
let calibrating = null; // the calibration circle to show, in table coordinates
// Objects can come from more than one sensor page (the depth camera, the lidar); keep each one's list.
const sensed = {};
relay.on('blobs', (message) => {
  if (follower) return;
  if (Array.isArray(message)) sensed.depth = message;
  else sensed[message.from] = message.list;
  external = Object.values(sensed).flat();
});

// Hands over the table, from the lidar page: drag the map, or spread two hands to zoom.
// `pan` is how far the hand moved and `at` where it is, as fractions of the picture.
function gesture(g) {
  if (follower || view !== 'table' || tablePlay?.pieces) return; // the game's pieces need the map to stay put
  if (g.zoom !== 1) {
    const before = fromTable({ x: g.at[0], y: g.at[1] });
    zoom /= g.zoom;
    updateCameras();
    const after = fromTable({ x: g.at[0], y: g.at[1] });
    focus.x += before.x - after.x;
    focus.z += before.z - after.z;
  }
  focus.x -= g.pan[0] * zoom;
  focus.z -= (g.pan[1] * zoom) / aspect();
  updateCameras();
}
relay.on('gesture', gesture);
relay.on('world', (list) => {
  if (follower) remote = list;
});
relay.on('calibrate', (m) => {
  calibrating = m.index >= 0 ? m : null;
});
relay.on('who', () => {
  if (!follower) relay.send('hello', { aspect: aspect() });
});
relay.on('state', (s) => {
  if (!follower) return;
  if (Math.abs(sim.clock - s.clock) > 20) sim.clock = s.clock;
  speed = s.speed;
  paused = s.paused;
  sim.demandScale = s.demand;
  focus.x = s.x;
  focus.z = s.z;
  zoom = s.zoom;
  updateCameras();
});
if (!follower) relay.send('hello', { aspect: aspect() });

let sentWorld = '';
let sentAt = 0;
function tellScreens(blobs, now) {
  if (follower) return;
  const world = blobs.map((b) => ({ x: Math.round(b.x), z: Math.round(b.z), r: Math.round(b.r) }));
  const text = JSON.stringify(world);
  if (text === sentWorld && now - sentAt < 2000) return;
  sentWorld = text;
  sentAt = now;
  relay.send('world', world);
  relay.send('state', { clock: sim.clock, speed, paused, demand: sim.demandScale, x: focus.x, z: focus.z, zoom });
}

// If the projector cannot open a web page and only accepts pictures, open the table window with
// ?push=<address>&fps=8 and it sends each frame there as a JPEG. Change the request below to
// whatever the room's API expects (method, headers, field names).
const pushTo = params.get('push');
const pushGap = 1000 / (Number(params.get('fps')) || 8);
let pushAt = 0;
let pushing = false;
function pushFrame(now) {
  if (!pushTo || pushing || now < pushAt) return;
  pushAt = now + pushGap;
  pushing = true;
  renderer.domElement.toBlob(
    async (blob) => {
      try {
        await fetch(pushTo, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
      } catch {
        // The room is not answering; try again with the next frame.
      }
      pushing = false;
    },
    'image/jpeg',
    0.85,
  );
}

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return; // typing an hour, not a shortcut
  if (game) {
    if (e.key === ' ') { e.preventDefault(); paused = !paused; }
    if (e.key === 'f') document.documentElement.requestFullscreen?.();
    if (e.key === '0') updateGameCamera(activeSide, true);
    if (e.key === '+' || e.key === '=') zoomGame(activeSide, 0.8);
    if (e.key === '-') zoomGame(activeSide, 1.25);
    return;
  }
  const step = zoom * 0.08;
  if (e.key >= '1' && e.key <= '4') speed = Number(e.key) - 1;
  if (e.key === ' ') paused = !paused;
  if (e.key === 't') sim.clock = (sim.clock + 3600) % 86400;
  if (e.key === 'v') view = view === 'table' ? 'screen' : 'table';
  if (e.key === 'h') document.body.classList.toggle('nohud');
  if (e.key === 'c') window.table.clear();
  if (e.key === '+' || e.key === '=') sim.demandScale = Math.min(2, sim.demandScale * 1.15);
  if (e.key === '-') sim.demandScale = Math.max(0.3, sim.demandScale / 1.15);
  if (e.key === 'f') document.documentElement.requestFullscreen?.();
  if (e.key === '0') {
    zoom = fitZoom();
    focus.x = WX / 2;
    focus.z = WZ / 2;
  }
  if (e.key === 'ArrowLeft') focus.x -= step;
  if (e.key === 'ArrowRight') focus.x += step;
  if (e.key === 'ArrowUp') focus.z -= step;
  if (e.key === 'ArrowDown') focus.z += step;
  updateCameras();
});

// ---------- planning: change the streets and see what it does ----------

const el = (id) => document.getElementById(id);

const mapUrl = mapName && mapName !== 'central' ? `/gbg-${mapName}.json` : '/gbg.json';
let tool = 'object'; // what a click (or a newly placed object) does
let edits = []; // the plan: see Sim.setEdits for the kinds of change
let nextEdit = 1;
let sketch = []; // corners of the road being drawn
let planDirty = true;

const planStrips = pool(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.75, depthTest: false }), 4000, 2);
const newRoads = pool(new THREE.MeshBasicMaterial({ depthTest: false }), 2000, 1);
const NARROWED = color('#ffb020');
const WIDENED = color('#39e6b0');
const WORKS = color('#b98cff');
const NEW_ROAD = color('#9fe3f5');

function setPlan(list, tell = true) {
  edits = list;
  sim.setEdits(edits);
  planDirty = true;
  if (tell && !follower) relay.send('edits', edits);
}
relay.on('edits', (list) => {
  if (follower) setPlan(list, false);
});

// Applies the current tool at a point on the map.
function useTool(p) {
  if (tool === 'road') {
    sketch.push([Math.round(p.x), Math.round(p.z)]);
    planDirty = true;
    return;
  }
  const ei = sim.pickEdge(p.x, p.z, Math.max(30, metresPerPixel() * 14));
  if (ei < 0) return;
  const street = sim.pair(ei);
  const e = sim.edges[ei];
  if (tool === 'works') {
    const from = Number(el('works-from').value);
    const to = Number(el('works-to').value);
    setPlan([...edits, { id: nextEdit++, type: 'works', edge: ei, lanes: 0, from, to }]);
    return;
  }
  // Lane changes: adjust the change already planned for this street, or start one.
  const others = edits.filter((x) => !(x.type === 'lanes' && street.includes(x.edge)));
  const lanes = Math.max(1, Math.min(4, (e.planLanes ?? e.baseLanes) + (tool === 'widen' ? 1 : -1)));
  setPlan(lanes === e.baseLanes ? others : [...others, { id: nextEdit++, type: 'lanes', edge: ei, lanes }]);
}

function finishRoad() {
  if (sketch.length >= 2) setPlan([...edits, { id: nextEdit++, type: 'road', points: sketch, lanes: 1, v: 13.9 }]);
  sketch = [];
  planDirty = true;
}

// With a planning tool chosen, a click on the map uses the tool instead of placing an object.
renderer.domElement.addEventListener(
  'pointerdown',
  (e) => {
    if (tool === 'object' || e.button !== 0 || e.shiftKey) return;
    e.stopImmediatePropagation();
    const p = pick(e);
    if (p) useTool(p);
  },
  { capture: true },
);
renderer.domElement.addEventListener('dblclick', () => tool === 'road' && finishRoad());
addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && tool === 'road') finishRoad();
  if (e.key === 'Escape') {
    sketch = [];
    planDirty = true;
  }
});

const HINTS = {
  object: 'Put an object on a street to close it.',
  narrow: 'Click a street, or put an object on it, to take away a lane each way.',
  widen: 'Click a street, or put an object on it, to add a lane each way.',
  works: 'Click a street, or put an object on it, to close it between the hours above.',
  road: 'Click along the route of the new road. Double-click or press Enter to finish, Esc to cancel.',
};
function chooseTool(name) {
  tool = name;
  sketch = [];
  planDirty = true;
  for (const b of document.querySelectorAll('#plan [data-tool]')) b.classList.toggle('on', b.dataset.tool === name);
}
for (const b of document.querySelectorAll('#plan [data-tool]')) b.addEventListener('click', () => chooseTool(b.dataset.tool));
el('plan-undo').addEventListener('click', () => {
  if (sketch.length) sketch.pop();
  else setPlan(edits.slice(0, -1));
  planDirty = true;
});
// The screens follow the table's plan; they have no tools of their own. (Hidden, not removed: the code below still writes to it.)
if (follower) el('plan').style.display = 'none';

// Objects from the depth camera use the planning tool too: each newly placed one applies it once.
const usedObjects = new Set();
function objectsUseTool(list) {
  const now = new Set();
  for (const b of list) {
    const key = `${Math.round(b.x * 50)},${Math.round(b.y * 50)}`;
    now.add(key);
    if (!usedObjects.has(key)) {
      usedObjects.add(key);
      useTool(fromTable(b));
    }
  }
  for (const key of usedObjects) if (!now.has(key)) usedObjects.delete(key);
}

function drawPlan() {
  if (!planDirty) return;
  planDirty = false;
  let n = 0;
  let m = 0;
  for (const x of edits) {
    if (x.type === 'road') {
      for (const ei of sim.built.get(x.id) || []) if (ei < sim.edges[ei].rev) m = strips(newRoads, m, 2000, sim.edges[ei], 0.6, x.lanes * 6.4 + 1, NEW_ROAD);
      continue;
    }
    const e = sim.edges[x.edge];
    const tint = x.type === 'works' ? WORKS : x.lanes < e.baseLanes ? NARROWED : WIDENED;
    n = strips(planStrips, n, 4000, e, 1.2, 5 + e.baseLanes * 3, tint);
  }
  // The road being drawn: a mark at each corner so far.
  const dot = Math.max(4, metresPerPixel() * 6);
  for (const [x, z] of sketch) putBox(newRoads, m++, x, 1.4, z, 1, 0, dot, 1, dot, NEW_ROAD);
  planStrips.count = n;
  planStrips.instanceMatrix.needsUpdate = true;
  if (planStrips.instanceColor) planStrips.instanceColor.needsUpdate = true;
  newRoads.count = m;
  newRoads.instanceMatrix.needsUpdate = true;
  if (newRoads.instanceColor) newRoads.instanceColor.needsUpdate = true;

  const count = edits.length;
  el('plan-hint').textContent = `${HINTS[tool]} ${count ? `${count} planned ${count === 1 ? 'change' : 'changes'}.` : ''}`;
}

// Runs the coming hours twice in the background, with and without the plan, and shows the difference.
let comparing = false;
function compare(hours) {
  if (comparing) return;
  comparing = true;
  const start = sim.clock / 3600;
  const closures = mouse.blobs.concat(tool === 'object' ? external.map(fromTable) : []);
  const jobs = [{ edits: [], blobs: [] }, { edits, blobs: closures }];
  const results = [null, null];
  const progress = [0, 0];
  const out = el('plan-result');
  for (const b of document.querySelectorAll('#compare-2, #compare-day')) b.disabled = true;
  jobs.forEach((job, k) => {
    const worker = new Worker(new URL('./compare.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.progress) {
        progress[k] = data.progress;
        out.innerHTML = `<p>Simulating ${hours === 24 ? 'the whole day' : `the next ${hours} hours`} twice… ${Math.round(((progress[0] + progress[1]) / 2) * 100)}%</p>`;
        return;
      }
      results[k] = data;
      worker.terminate();
      if (results[0] && results[1]) {
        comparing = false;
        for (const b of document.querySelectorAll('#compare-2, #compare-day')) b.disabled = false;
        showComparison(results[0], results[1], start, hours);
      }
    };
    worker.postMessage({ mapUrl, start, hours, ...job });
  });
}
el('compare-2').addEventListener('click', () => compare(2));
el('compare-day').addEventListener('click', () => compare(24));

function showComparison(before, after, start, hours) {
  const row = (label, a, b, digits, unit, higherIsBetter) => {
    const change = a ? (b - a) / a : 0;
    const cls = Math.abs(change) < 0.01 ? '' : change > 0 === higherIsBetter ? 'better' : 'worse';
    const pct = `${change >= 0 ? '+' : ''}${(change * 100).toFixed(0)}%`;
    return `<tr><td>${label}</td><td>${a.toFixed(digits)}</td><td>${b.toFixed(digits)}${unit}</td><td class="${cls}">${pct}</td></tr>`;
  };
  const ambulance =
    after.ambulanceMinutes === null || before.ambulanceMinutes === null
      ? `<tr><td>Ambulance to Centralen</td><td colspan="3" class="worse">${after.ambulanceMinutes === null ? 'no route with the plan' : 'no route today'}</td></tr>`
      : row('Ambulance to Centralen', before.ambulanceMinutes, after.ambulanceMinutes, 1, ' min', false);
  const from = `${String(Math.floor(start)).padStart(2, '0')}:${String(Math.floor((start % 1) * 60)).padStart(2, '0')}`;
  el('plan-result').innerHTML = `
    <table>
      <tr><th>${hours === 24 ? '24 hours' : `${hours} hours`} from ${from}</th><th>Today</th><th>With plan</th><th></th></tr>
      ${row('Average speed', before.speed, after.speed, 1, ' km/h', true)}
      ${row('Average trip', before.tripMinutes, after.tripMinutes, 1, ' min', false)}
      ${row('Hours spent driving', before.drivingHours, after.drivingHours, 0, '', false)}
      ${row('Trips completed', before.trips, after.trips, 0, '', true)}
      ${ambulance}
    </table>
    <canvas id="plan-chart" width="536" height="180"></canvas>
    <p>Average speed through the period: grey is today, blue is with the plan. Road vehicles only; traffic volumes are plausible, not measured.</p>`;
  const c = el('plan-chart').getContext('2d');
  const all = before.slots.concat(after.slots).map((x) => x.speed);
  const lo = Math.min(...all) - 2;
  const hi = Math.max(...all) + 2;
  for (const [slots, stroke] of [[before.slots, '#8a94a3'], [after.slots, '#5ad1ff']]) {
    c.strokeStyle = stroke;
    c.lineWidth = 3;
    c.beginPath();
    slots.forEach((x, k) => c.lineTo(8 + (k / Math.max(1, slots.length - 1)) * 520, 170 - ((x.speed - lo) / (hi - lo)) * 160));
    c.stroke();
  }
}

// ---------- metrics and narration ----------

const metrics = {
  clock: '',
  congestion: 0,
  vehicles: 0,
  kmh: 0,
  trams: 0,
  people: 0,
  closures: 0,
  diverted: 0,
  detourMinutes: 0,
  ambulanceDelay: 0,
  noRoute: false,
};
let flowEma = sim.flow();
let baseAmbulance = 0;
let emergency = null;
let metricsTimer = 0;

const minSec = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const hhmm = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;

function timeOfDay(hour) {
  if (hour < 5) return 'Night';
  if (hour < 6.5) return 'Early morning';
  if (hour < 9.5) return 'Morning rush';
  if (hour < 15) return 'Daytime';
  if (hour < 18.5) return 'Evening rush';
  if (hour < 22) return 'Evening';
  return 'Night';
}

function story(m) {
  if (!m.closures) {
    return `${timeOfDay(sim.clock / 3600)}: ${m.vehicles} vehicles at ${m.kmh} km/h on average. Put something on the table to close a street.`;
  }
  const parts = [`${m.closures} street ${m.closures === 1 ? 'segment is' : 'segments are'} closed.`];
  if (m.diverted) {
    parts.push(
      `${m.diverted} ${m.diverted === 1 ? 'vehicle has' : 'vehicles have'} been diverted, adding ${Math.round(m.detourMinutes)} minutes of driving.`,
    );
  }
  if (m.noRoute) parts.push('The ambulance cannot reach Centralstationen.');
  else if (m.ambulanceDelay >= 0.05) parts.push(`The ambulance needs ${Math.round(m.ambulanceDelay * 100)}% longer.`);
  else parts.push('The ambulance route is unaffected.');
  return parts.join(' ');
}

function updateMetrics() {
  flowEma += (sim.flow() - flowEma) * 0.15;
  emergency = sim.emergency();
  const closures = sim.closures();
  // Learn what "normal" looks like while nothing is on the table.
  if (!closures && emergency) {
    baseAmbulance = baseAmbulance ? baseAmbulance + (emergency.time - baseAmbulance) * 0.05 : emergency.time;
  }
  let out = 0;
  for (const p of people.agents) if (p.out) out++;
  metrics.clock = hhmm(sim.clock);
  metrics.congestion = 1 - flowEma;
  metrics.vehicles = sim.cars.length;
  metrics.kmh = Math.round(sim.meanSpeed());
  metrics.trams = trams.trams.length;
  metrics.people = out;
  metrics.closures = closures;
  metrics.diverted = sim.diverted;
  metrics.detourMinutes = sim.detour / 60;
  metrics.noRoute = !emergency;
  metrics.ambulanceDelay = emergency && baseAmbulance ? Math.max(0, emergency.time / baseAmbulance - 1) : 0;

  el('clock').textContent = metrics.clock;
  el('m-speed').textContent = paused ? 'paused' : `${SPEEDS[speed]}×`;
  el('m-cong').textContent = `${Math.round(metrics.congestion * 100)}%`;
  const bar = el('bar').firstElementChild;
  bar.style.width = `${Math.round(metrics.congestion * 100)}%`;
  bar.style.background = `hsl(${Math.round((1 - metrics.congestion) * 150)} 80% 55%)`;
  el('m-cars').textContent = metrics.vehicles;
  el('m-kmh').textContent = `${metrics.kmh} km/h`;
  el('m-life').textContent = `${metrics.trams} · ${metrics.people}`;
  el('m-closed').textContent = `${closures} · ${metrics.diverted}`;
  el('m-amb').textContent = metrics.noRoute ? 'no route' : `${minSec(emergency.time)} min`;
  el('story').textContent = story(metrics);
  // Hook for lights, sound and the AI narrator.
  dispatchEvent(new CustomEvent('table-metrics', { detail: { ...metrics } }));
}

// ---------- drawing ----------

let stripVersion = -1;
let day = 1;

// Vehicles are drawn larger than life when zoomed out, so they stay visible from above.
const vehicleScale = () => Math.max(1, Math.min(7, metresPerPixel() * 2.2));

function drawVehicles(dt, time) {
  const S = vehicleScale();
  const spread = 1 + (S - 1) * 0.25;
  const k = Math.min(1, dt * 10 * Math.max(1, SPEEDS[speed] / 3));
  const flash = Math.sin(time * 9) > 0;
  const head = day < 0.6 ? HEAD_NIGHT : HEAD_DAY;
  const close = metresPerPixel() < 0.2;
  let n = 0;
  let nl = 0;

  for (const car of sim.cars) {
    if (n > MAX_PARTS - 8 || nl > MAX_LIGHTS - 4) break;
    const e = sim.edges[car.edge];
    if (e.tunnel) {
      // Underground: out of sight until it comes back up.
      car.rx = undefined;
      continue;
    }
    pointAt(e, car.s, P);
    // Lane 0 is the nearside (right-hand) lane.
    // A bus at a stop stands in the bay beside the road.
    const side =
      ((e.oneway ? (e.lanes - 1) / 2 - car.lane : e.lanes - car.lane - 0.5) * LANE_WIDTH + (car.dwell > 0 ? 2.8 : 0)) * spread;
    const tx = P.x - P.dz * side;
    const tz = P.z + P.dx * side;
    if (car.rx === undefined) {
      car.rx = tx;
      car.rz = tz;
      car.rdx = P.dx;
      car.rdz = P.dz;
      car.paint = paint(PAINT[car.kind][car.id % PAINT[car.kind].length]);
    }
    car.rx += (tx - car.rx) * k;
    car.rz += (tz - car.rz) * k;
    car.rdx += (P.dx - car.rdx) * k;
    car.rdz += (P.dz - car.rdz) * k;
    const norm = Math.hypot(car.rdx, car.rdz) || 1;
    const dx = car.rdx / norm;
    const dz = car.rdz / norm;
    const { rx, rz } = car;

    for (const [along, y, l, h, w, role] of PARTS[car.kind]) {
      const c = role === 0 ? (game && car.load > 0.08 ? RED : car.paint) : role === 1 ? GLASS : role === 2 ? WHITE : RED;
      putBox(bodies, n++, rx + dx * along * S, y * S, rz + dz * along * S, dx, dz, l * S, h * S, w * S, c);
    }
    const half = (car.len / 2) * S;
    const wide = car.kind === 'car' ? 1.7 : 2.2;
    if (close) {
      // Wheels, once you are near enough to see them.
      for (const a of [-0.3, 0.3]) {
        for (const b of [-0.5, 0.5]) {
          const wx = rx + dx * car.len * a - dz * wide * b;
          const wz = rz + dz * car.len * a + dx * wide * b;
          putBox(bodies, n++, wx, 0.35, wz, dx, dz, 0.7, 0.7, 0.28, TYRE);
        }
      }
    }
    // Brake lights, headlights, and the ambulance's blue flash.
    const braking = car.acc < -0.9 || car.v < 0.3;
    putBox(lamps, nl++, rx - dx * half, 0.8 * S, rz - dz * half, dx, dz, 0.25 * S, 0.3 * S, wide * S, braking ? TAIL_ON : TAIL_OFF);
    putBox(lamps, nl++, rx + dx * half, 0.7 * S, rz + dz * half, dx, dz, 0.25 * S, 0.25 * S, wide * S, head);
    if (car.kind === 'ambulance') {
      putBox(lamps, nl++, rx + dx * S, 2.5 * S, rz + dz * S, dx, dz, 0.8 * S, 0.35 * S, 1.4 * S, tmpColor.set(flash ? '#3d8bff' : '#0d2450'));
    }
  }

  // Trams: three articulated sections following the track.
  const wideT = 1 + (S - 1) * 0.35;
  for (const t of trams.trams) {
    if (n > MAX_PARTS - 9) break;
    for (let sec = 0; sec < 3; sec++) {
      const s = t.s - 5 - sec * 10.2;
      if (s < 0) break;
      if (inTunnel(t.line, s)) continue;
      pointAt(t.line.path, s, P);
      putBox(bodies, n++, P.x, 1.05 * wideT, P.z, P.dx, P.dz, 9.8, 1.5 * wideT, 2.4 * wideT, game && t.load > 0.08 ? RED : TRAM_BLUE);
      putBox(bodies, n++, P.x, 2.15 * wideT, P.z, P.dx, P.dz, 9.2, 0.75 * wideT, 2.44 * wideT, GLASS);
      putBox(bodies, n++, P.x, 2.95 * wideT, P.z, P.dx, P.dz, 9.6, 0.85 * wideT, 2.3 * wideT, WHITE);
    }
  }

  // Ferries: the river shuttles, and the big ship to Denmark.
  for (const b of ferries.boats) {
    if (n > MAX_PARTS - 3) break;
    const L = b.big ? 170 : 30;
    const W = b.big ? 26 : 8;
    putBox(bodies, n++, b.x, b.big ? 6 : 1.2, b.z, b.dx, b.dz, L, b.big ? 12 : 2.4, W, WHITE);
    putBox(bodies, n++, b.x - b.dx * L * 0.1, b.big ? 16 : 3.4, b.z - b.dz * L * 0.1, b.dx, b.dz, L * 0.6, b.big ? 8 : 2, W * 0.75, b.big ? WHITE : TRAM_BLUE);
    if (b.big) putBox(bodies, n++, b.x - b.dx * 45, 24, b.z - b.dz * 45, b.dx, b.dz, 12, 10, 10, RED);
  }

  // Traffic lights.
  const along = Math.max(0.6, metresPerPixel() * 1.3);
  for (const g of signals) {
    if (nl >= MAX_LIGHTS) break;
    putBox(lamps, nl++, g.x, 0.3, g.z, g.dx, g.dz, along, 0.3, g.e.lanes * LANE_WIDTH - 0.4, SIGNAL[sim.signal(g.e)]);
  }

  bodies.count = n;
  bodies.instanceMatrix.needsUpdate = true;
  bodies.instanceColor.needsUpdate = true;
  lamps.count = nl;
  lamps.instanceMatrix.needsUpdate = true;
  lamps.instanceColor.needsUpdate = true;
}

const STATE_COLOUR = [null, color('#ffb020'), color('#ff2d2d'), color('#39e6b0')];
function infectionColour(p) {
  if (game) return paint(p.inf === 1 || p.inf === 2 ? '#ff4545' : '#50dda5');
  if (p.iso) return paint('#ffffff');
  return STATE_COLOUR[p.inf] || paint('#6f7a89');
}

function drawPeople(mpp = metresPerPixel()) {
  let n = 0;
  // From far above a person is smaller than a pixel, so skip them.
  if (game || mpp < 2.2) {
    const S = Math.max(1, game ? mpp * 2.2 : Math.min(3, mpp * 1.6));
    for (const p of people.agents) {
      if ((!game && !p.out) || n > MAX_PEOPLE - 4) continue;
      const side = p.bike ? 0.6 : 0.9; // keep to the right
      const x = p.x - p.dz * side;
      const z = p.z + p.dx * side;
      const c = game ? infectionColour(p) : paint(CLOTHES[p.shade]);
      if (game) {
        const size = Math.max(1, mpp * 2.4);
        putBox(walkers, n++, x, 3, z, 1, 0, size, 1, size, c);
      } else if (mpp < 0.12) {
        // Close up: legs, a coat and a head; cyclists get a bicycle under them.
        const lift = p.bike ? 0.35 : 0;
        if (p.bike) putBox(walkers, n++, x, 0.5, z, p.dx, p.dz, 1.7, 0.9, 0.12, TROUSERS);
        putBox(walkers, n++, x, 0.42 + lift, z, p.dx, p.dz, 0.3, 0.85, 0.42, TROUSERS);
        putBox(walkers, n++, x, 1.15 + lift, z, p.dx, p.dz, 0.34, 0.65, 0.5, c);
        putBox(walkers, n++, x, 1.6 + lift, z, p.dx, p.dz, 0.24, 0.26, 0.24, SKIN);
      } else if (p.bike) putBox(walkers, n++, x, 0.8 * S, z, p.dx, p.dz, 1.7 * S, 1.6 * S, 0.5 * S, c);
      else putBox(walkers, n++, x, 0.85 * S, z, p.dx, p.dz, 0.45 * S, 1.7 * S, 0.5 * S, c);
    }
  }
  walkers.count = n;
  walkers.instanceMatrix.needsUpdate = true;
  walkers.instanceColor.needsUpdate = true;
}

// A flat strip over every stretch of an edge.
function strips(mesh, n, max, e, y, width, tint) {
  for (let i = 1; i < e.cum.length && n < max; i++) {
    const ax = e.pts[2 * i - 2];
    const az = e.pts[2 * i - 1];
    const bx = e.pts[2 * i];
    const bz = e.pts[2 * i + 1];
    const l = Math.hypot(bx - ax, bz - az);
    if (l < 0.5) continue;
    putBox(mesh, n++, (ax + bx) / 2, y, (az + bz) / 2, (bx - ax) / l, (bz - az) / l, l + 4, 0.5, width, tint);
  }
  return n;
}

function drawClosures() {
  if (stripVersion === sim.blockVersion) return;
  stripVersion = sim.blockVersion;
  let n = 0;
  sim.edges.forEach((e, ei) => {
    if (e.blocked && !e.gone && (e.rev < 0 || ei < e.rev)) n = strips(closedStrips, n, MAX_STRIPS, e, 1, 9 + e.lanes * 3);
  });
  closedStrips.count = n;
  closedStrips.instanceMatrix.needsUpdate = true;
}

// Orange glow on streets that are taking far longer than they should, readable even when cars are specks.
function drawJams() {
  let n = 0;
  for (const e of sim.edges) {
    if (!e.blocked && e.cars.length > 1 && e.tt > 3 * e.free + 25) n = strips(jamStrips, n, MAX_JAMS, e, 0.8, 4 + e.lanes * 3);
  }
  jamStrips.count = n;
  jamStrips.instanceMatrix.needsUpdate = true;
}

function drawRoute(time) {
  let n = 0;
  if (emergency) {
    const size = Math.max(2, metresPerPixel() * 3.2);
    const spacing = size * 3.5;
    let s = (time * 12) % spacing;
    for (const ei of emergency.path) {
      const e = sim.edges[ei];
      for (; s < e.len && n < MAX_DOTS; s += spacing) {
        if (e.tunnel) continue; // no dots across the rooftops where the route runs underground
        pointAt(e, s, P);
        putBox(routeDots, n++, P.x, 1.5, P.z, P.dx, P.dz, size, 1, size);
      }
      s -= e.len;
    }
  }
  routeDots.count = n;
  routeDots.instanceMatrix.needsUpdate = true;
}

function drawOverlays(blobs, time) {
  const pulse = 1 + Math.sin(time * 1.5) * 0.04;
  blobs.forEach((b, k) => {
    const g = ring(k);
    g.visible = true;
    g.position.set(b.x, 3, b.z);
    g.scale.setScalar(b.r * pulse);
  });
  for (let k = blobs.length; k < rings.length; k++) rings[k].visible = false;

  for (const m of markers) m.scale.setScalar(metresPerPixel() * 14 * (1 + Math.sin(time * 1.2) * 0.12));

  target.visible = Boolean(calibrating) && !follower;
  if (target.visible) {
    const p = fromTable(calibrating);
    target.position.set(p.x, 4, p.z);
    target.scale.setScalar(zoom * 0.03 * (1 + Math.sin(performance.now() / 180) * 0.07));
  }

  const labelH = view === 'table' ? (zoom / aspect()) * 0.026 : 0.026 * 2 * Math.tan((screenCam.fov * Math.PI) / 360);
  for (const s of labels) s.scale.set(labelH * s.userData.aspect, labelH, 1);
}

// The sun: up around half past seven and down around half past six, as in Göteborg in early October.
function drawSky() {
  const h = sim.clock / 3600;
  const ramp = (a, b) => Math.max(0, Math.min(1, (h - a) / (b - a)));
  day = ramp(6.7, 7.9) * (1 - ramp(17.9, 19.1));
  setDaylight(day);
  sky.intensity = 0.55 + 1.05 * day;
  sun.intensity = 0.1 + 1.4 * day;
}

// ---------- the outbreak game ----------

function toast(side, text) {
  el(`g-toast-${side}`).textContent = text;
  gameViews[side].toastUntil = performance.now() + 4000;
}
function doAction(side, name, p) {
  if (!game || game.phase === 'over') return;
  if (name === 'seed' ? side !== 'spreader' : !ownsAction(side, name, ACTIONS)) return;
  const v = gameViews[side];
  if (['seed', 'party', 'sickwork', 'lockdown'].includes(name) && !p) {
    v.armed = v.armed === name ? null : name;
    toast(side, v.armed ? `Click your map: ${ACTIONS[name]?.label || 'place patient zero'}.` : '');
    return;
  }
  const ok = name === 'seed' ? game.seed(p.x, p.z) : game.act(name, p?.x, p?.z);
  if (!ok) toast(side, 'Unavailable: check points/cooldown. Parties need 10 nearby people; sick work needs an infectious person.');
  else { v.armed = null; toast(side, 'Action scheduled.'); }
}
const GAME_KEYS = { q: 'party', w: 'antimask', e: 'antivaxx', r: 'sickwork', i: 'lockdown', o: 'vaccines', p: 'distancing', l: 'hospitals', k: 'newvaccine' };
if (game) {
  for (const panel of document.querySelectorAll('[data-player]')) {
    const side = panel.dataset.player;
    panel.addEventListener('pointerdown', () => { activeSide = side; });
    for (const b of panel.querySelectorAll('[data-act]')) b.addEventListener('click', () => { doAction(side, b.dataset.act); panel.classList.remove('revealed'); panel.querySelector('[data-reveal]').setAttribute('aria-expanded', 'false'); });
    for (const b of panel.querySelectorAll('[data-zoom]')) b.addEventListener('click', () => b.dataset.zoom === 'fit' ? updateGameCamera(side, true) : zoomGame(side, Number(b.dataset.zoom)));
    const reveal = panel.querySelector('[data-reveal]');
    reveal.addEventListener('click', () => {
      const open = !panel.classList.contains('revealed');
      for (const other of document.querySelectorAll('[data-player]')) {
        other.classList.remove('revealed');
        other.querySelector('[data-reveal]').setAttribute('aria-expanded', 'false');
      }
      panel.classList.toggle('revealed', open);
      reveal.setAttribute('aria-expanded', String(open));
    });
  }
  renderer.domElement.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.shiftKey) return;
    e.stopImmediatePropagation();
    const side = sideAt(e.clientX, e.clientY, innerWidth, innerHeight);
    if (!side) return;
    activeSide = side;
    const p = pick(e, side);
    if (!p) return;
    if (game.phase === 'setup' && side === 'spreader') doAction(side, 'seed', p);
    else if (gameViews[side].armed) doAction(side, gameViews[side].armed, p);
  }, { capture: true });
  addEventListener('keydown', e => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement) return;
    if (GAME_KEYS[e.key]) doAction(activeSide, GAME_KEYS[e.key]);
    if (e.key === 'Escape') { gameViews[activeSide].armed = null; toast(activeSide, ''); }
  });
}

const num = (n) => n.toLocaleString('en-GB');
const pct = (x) => `${Math.round(x * 1000) / 10}%`;
const ROUND = 180; // real seconds a round runs once the virus is seeded
let roundTime = 0;
function updateGame() {
  const c = game.counts();
  const total = game.total;
  const bars = el('g-split').children;
  [c.s + c.r, c.e + c.i].forEach((n, k) => (bars[k].style.width = `${(n / total) * 100}%`));
  const left = Math.max(0, ROUND - roundTime);
  el('g-time').textContent = game.phase === 'setup' ? '3:00' : `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
  if (game.phase === 'running' && left <= 0) game.phase = 'over';
  const R_ = game.history.length > 3 ? growth() : null;
  const shared = publicCounts(c);
  el('g-infected').textContent = num(Math.round(shared.infected * game.scale));
  el('g-noninfected').textContent = num(Math.round(shared.noninfected * game.scale));
  el('g-status').textContent =
    game.phase === 'setup'
      ? 'Spreader: click a busy street to place patient zero. Curber: get ready.'
      : `Day ${Math.min(60, Math.floor(game.time / DAY) + 1)} of 60. ${num(c.people.ever)} of ${num(game.population)} people have caught it (${pct(c.share)}); ${num(c.people.active)} infected now, ${num(c.people.hospital)} needing a hospital bed, an estimated ${num(c.people.dead)} deaths.${c.iso ? ` ${num(Math.round(c.iso * game.scale))} isolating.` : ''}${R_ ? ` ${R_}` : ''}`;
  el('g-sp').textContent = Math.floor(game.points.spreader);
  el('g-cp').textContent = Math.floor(game.points.curber);
  for (const b of document.querySelectorAll('#game [data-act]')) {
    const a = b.dataset.act;
    const action = ACTIONS[a];
    const remaining = Math.max(0, (game.ready[a] || 0) - game.time);
    const effect = game.effects.find(e => e.kind === a && e.until > game.time);
    const cs = b.querySelector('[data-cost]');
    if (cs) cs.textContent = effect && effect.start > game.time ? `starts in ${Math.ceil((effect.start - game.time) / 60)}m` : remaining === Infinity ? 'built' : remaining > 0 ? `${Math.ceil(remaining / 60)}m cooldown` : `${action.cost} pts`;
    b.disabled = !game.available(a);
    b.classList.toggle('on', gameViews[action.side].armed === a);
  }
  for (const side of SIDES) if (performance.now() > gameViews[side].toastUntil) el(`g-toast-${side}`).textContent = '';
  drawChart();
  drawHeat();
  if (game.phase === 'over' && !el('g-over').classList.contains('show')) {
    el('g-win').textContent = "Time's up";
    const peak = game.history.reduce((a, h) => (h[1] > a[1] ? h : a), [0, 0]);
    el('g-sum').textContent = `In ${Math.round(game.time / DAY)} days ${num(c.people.ever)} of ${num(game.population)} people (${pct(c.share)}) caught the virus. Cases peaked at ${num(Math.round(peak[1] * game.scale))} on day ${Math.round(peak[0] / DAY)}. An estimated ${num(c.people.dead)} died, and ${num(c.people.immune)} are immune.`;
    el('g-over').classList.add('show');
    paused = true;
  }
}

// Plain-words reading of how fast it is growing, from the last week of game days (history is one entry a minute).
function growth() {
  const h = game.history;
  const last = h[h.length - 1];
  const prev = h[Math.max(0, h.length - 11)];
  if (last[1] === 0) return 'Contained.';
  if (prev[1] === 0 || last[0] === prev[0]) return '';
  const days = (last[0] - prev[0]) / DAY;
  const rate = Math.log(last[1] / prev[1]) / days; // per day
  if (rate > 0.03) return `Doubling every ${(Math.LN2 / rate).toFixed(1)} days.`;
  if (rate > -0.03) return 'Levelling off.';
  return `Halving every ${(Math.LN2 / -rate).toFixed(1)} days.`;
}

function drawChart() {
  const cv = el('g-chart');
  const g = cv.getContext('2d');
  const w = cv.width;
  const h = cv.height;
  g.clearRect(0, 0, w, h);
  const hist = game.history;
  if (hist.length < 2) return;
  const tMax = hist[hist.length - 1][0];
  const top = Math.max(game.total * 0.1, ...hist.map((x) => x[2]));
  const line = (idx, colour) => {
    g.beginPath();
    hist.forEach((row, k) => {
      const x = (row[0] / tMax) * (w - 4) + 2;
      const y = h - 4 - (row[idx] / top) * (h - 8);
      if (k) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.strokeStyle = colour;
    g.lineWidth = 3;
    g.stroke();
  };
  line(2, '#ffb020');
  line(1, '#ff3b30');
}

// Where the virus is, as glowing squares: readable even when people are too small to see.
function drawHeat() {
  const cells = game.heat(100);
  let n = 0;
  for (const c of cells) {
    if (n >= 3000) break;
    const k = Math.min(1, c.n / 5);
    tmpColor.setRGB(1, 0.65 * (1 - k), 0.1 * (1 - k));
    putBox(heatCells, n++, c.x, 0.9, c.z, 1, 0, 96, 0.4, 96, tmpColor);
  }
  heatCells.count = n;
  heatCells.instanceMatrix.needsUpdate = true;
  if (heatCells.instanceColor) heatCells.instanceColor.needsUpdate = true;
}

// The same game played with pieces and hands on the table (?game=table), and shown on the screens.
const tablePlay = params.has('game')
  ? startTablePlay({
      game,
      follower,
      onTable: params.get('game') === 'table' && !follower,
      relay,
      pool,
      putBox,
      act: doAction,
      armed: (side) => gameViews[side].armed,
      pick,
    })
  : null;

// ---------- the two modes: the traffic demo, or the outbreak game on top of it ----------

// Each is the same page at a different address, so changing mode starts it afresh. The game opens
// with everything on: pieces and hands on the table, and the mouse and keyboard as well.
function modeUrl(name) {
  const next = new URLSearchParams(location.search);
  if (name === 'game') next.set('game', follower ? '' : 'table');
  else next.delete('game');
  const query = next.toString().replace(/=(&|$)/g, '$1');
  return location.pathname + (query ? `?${query}` : '');
}
const mode = params.has('game') ? 'game' : 'traffic';
for (const a of document.querySelectorAll('#modes a')) {
  a.href = modeUrl(a.dataset.mode);
  a.classList.toggle('on', a.dataset.mode === mode);
}
addEventListener('keydown', (e) => {
  if (e.key === 'm' && !(e.target instanceof HTMLInputElement) && !follower) location.href = modeUrl(mode === 'game' ? 'traffic' : 'game');
});
if (follower) {
  // A screen has no switch of its own: it goes where the table goes.
  el('modes').remove();
  let gameSeen = performance.now();
  relay.on('virus', () => {
    gameSeen = performance.now();
    if (mode !== 'game') location.href = modeUrl('game');
  });
  relay.on('state', () => {
    if (mode === 'game' && performance.now() - gameSeen > 6000) location.href = modeUrl('traffic');
  });
}

// ---------- frame loop ----------

function advance(simSeconds) {
  // With a planning tool chosen, objects from the camera apply the tool instead of closing streets.
  const planning = tool !== 'object' && tool !== 'road' && !follower;
  if (planning) objectsUseTool(external);
  const zones = game ? game.lockdowns.filter(z => (z.start || 0) <= game.time && z.until > game.time) : [];
  // Played on the table, objects are the game's pieces: they act through the game, not by closing the street under them.
  const blobs = mouse.blobs.concat(zones, follower ? remote : planning || tablePlay?.pieces ? [] : external.map(fromTable));
  sim.setBlobs(blobs);
  const n = Math.ceil(simSeconds / MAX_STEP);
  for (let k = 0; k < n; k++) stepAll(simSeconds / n);
  return blobs;
}

function draw(dt, blobs) {
  metricsTimer -= dt;
  if (metricsTimer <= 0) {
    metricsTimer = 0.25;
    updateMetrics();
    drawJams();
    if (game) updateGame();
  }
  drawSky();
  drawVehicles(dt, sim.time);
  drawPeople();
  drawClosures();
  drawPlan();
  drawRoute(sim.time);
  drawOverlays(blobs, sim.time);
  if (game) {
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, innerWidth, innerHeight);
    renderer.clear();
    renderer.setScissorTest(true);
    heatCells.visible = false;
    routeDots.visible = false;
    for (const side of SIDES) {
      const r = gameRect(side, innerWidth, innerHeight);
      const y = innerHeight - r.y - r.height;
      renderer.setViewport(r.x, y, r.width, r.height);
      renderer.setScissor(r.x, y, r.width, r.height);
      closedStrips.visible = side === 'curber';
      drawOverlays(privateOverlays(game, side), sim.time);
      drawPeople(gameViews[side].zoom / r.width);
      renderer.render(scene, gameViews[side].cam);
    }
    renderer.setScissorTest(false);
  } else renderer.render(scene, camera());
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (view === 'screen') {
    orbit += dt * 0.04;
    updateCameras();
  }
  if (game?.phase === 'running' && !paused) roundTime += dt;
  tablePlay?.update(dt, external);
  const blobs = advance(paused ? 0 : dt * SPEEDS[speed]);
  draw(dt, blobs);
  tellScreens(blobs, now);
  pushFrame(now);
  requestAnimationFrame(frame);
}
el('loading').remove();
requestAnimationFrame(frame);

window.table = {
  game,
  setBlobs(list) {
    external = list;
  },
  clear() {
    external = [];
    mouse.clear();
  },
  // Runs the simulation ahead by this many simulated seconds without waiting for frames.
  advance(seconds) {
    let blobs = [];
    for (let t = 0; t < seconds; t += 1) blobs = advance(1);
    metricsTimer = 0;
    draw(1, blobs);
    tellScreens(blobs, performance.now());
  },
  // Moves the cameras: centre in metres, metres across the window, 'table' or 'screen'.
  look(x, z, across, mode) {
    focus.x = x ?? focus.x;
    focus.z = z ?? focus.z;
    zoom = across ?? zoom;
    view = mode ?? view;
    updateCameras();
  },
  gesture,
  // The planner, for scripting: choose a tool, use it at a point in metres, read or replace the plan.
  plan: {
    tool: chooseTool,
    use: (x, z) => useTool({ x, z }),
    finishRoad,
    compare,
    get edits() {
      return edits;
    },
    set: setPlan,
  },
  setClock(hours) {
    sim.clock = (hours * 3600) % 86400;
  },
  // Where the cameras are looking: centre in metres and metres across the window.
  get view() {
    return { x: focus.x, z: focus.z, across: zoom, mode: view };
  },
  sim,
  trams,
  people,
  metrics,
};
