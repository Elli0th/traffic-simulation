import * as THREE from 'three';
import { Sim, LANE_WIDTH } from './sim.js';
import { Trams, Ferries, inTunnel } from './transit.js';
import { People } from './people.js';
import { Live, cityClock } from './live.js';
import { pointAt } from './geometry.js';
import { buildGround, buildBuildings, buildTrees, buildStops, buildLabels, setDaylight } from './world.js';
import { MouseInput } from './input.js';
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
// ?nohud starts with the panels hidden, for a display with no keyboard to press H on.
if (params.has('nohud')) document.body.classList.add('nohud');
const mapName = params.get('map');
const map = await (await fetch(mapName && mapName !== 'central' ? `/gbg-${mapName}.json` : '/gbg.json')).json();
const [WX, WZ] = map.size;
const sim = new Sim(map);
const simTrams = new Trams(map.tramLines, sim);
const ferries = new Ferries(map.ferries);
// Live traffic: real sensor readings, incidents, trams, buses and ferries, when the server has keys
// for them (see .env.example). ?live=0 starts without; L switches it on and off.
const live = new Live(map, mapName, sim, simTrams.lines);
const liveAtStart = (await live.check()) && params.get('live') !== '0';
if (liveAtStart) sim.clock = cityClock();
// The trams on the map: the real ones while they are being reported, otherwise our own.
const tramsNow = () => (live.vehiclesFresh ? live.trams : simTrams.trams);
// About one person out walking for every 14 stretches of footpath, and one cyclist per 95.
const people = new People(map.paths, sim, {
  walkers: Math.round(map.paths.edges.length * 0.072),
  cyclists: Math.round(map.paths.edges.length * 0.0105),
});

function stepAll(dt) {
  sim.step(dt);
  if (!live.vehiclesFresh) simTrams.step(dt);
  ferries.step(dt);
  people.step(dt);
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

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  updateCameras();
}
addEventListener('resize', resize);
zoom = fitZoom();
resize();

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

// Sets how many of a pool's boxes are drawn, and sends only those to the graphics card.
function commit(mesh, n, colours = true) {
  mesh.count = n;
  if (!n) return;
  for (const attribute of [mesh.instanceMatrix, colours && mesh.instanceColor]) {
    if (!attribute) continue;
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, n * attribute.itemSize);
    attribute.needsUpdate = true;
  }
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
const walkers = pool(new THREE.MeshLambertMaterial(), MAX_PEOPLE);
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
const reportMarks = []; // one per incident reported by live traffic

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

function pick(e) {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera());
  if (!raycaster.ray.intersectPlane(groundPlane, hitPoint)) return null;
  return { x: hitPoint.x, z: hitPoint.z };
}

const mouse = new MouseInput(renderer.domElement, pick, () => Math.max(12, zoom * 0.014));

// Scroll zooms towards the cursor, or resizes an object if the cursor is on one.
renderer.domElement.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
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
  grab = pick(e);
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!grab) return;
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

let speed = liveAtStart ? 0 : 1; // index into SPEEDS; live traffic is shown at the speed it happens
let paused = false;

function setLive(on) {
  if (on === live.on) return;
  if (on) {
    live.start();
    if (live.on) speed = 0;
  } else live.stop();
}
setLive(liveAtStart);

// ---------- the room: depth camera, calibration, other windows ----------

let remote = []; // objects in metres, as told by the table window (screens only)
let calibrating = null; // the calibration circle to show, in table coordinates
// Objects can come from more than one sensor page (the depth camera, the lidar); keep each one's list.
const sensed = {}; // sensor -> { list, at }
const SENSOR_QUIET = 5000; // milliseconds without a word before a sensor's objects are taken off the table
function gather() {
  external = Object.values(sensed).flatMap((s) => s.list);
}
relay.on('blobs', (message) => {
  if (follower) return;
  const [from, list] = Array.isArray(message) ? ['depth', message] : [message.from, message.list];
  sensed[from] = { list, at: performance.now() };
  gather();
});
// The sensor pages repeat what they see several times a second. One that has stopped (closed, or cut
// off from its sensor) would otherwise leave its last objects closing streets for good.
setInterval(() => {
  let dropped = false;
  for (const from of Object.keys(sensed)) {
    if (performance.now() - sensed[from].at < SENSOR_QUIET) continue;
    delete sensed[from];
    dropped = true;
  }
  if (dropped) gather();
}, 1000);

// Hands over the table, from the lidar page: drag the map, or spread two hands to zoom.
// `pan` is how far the hand moved and `at` where it is, as fractions of the picture.
function gesture(g) {
  if (follower || view !== 'table') return;
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
  if (s.live !== undefined) setLive(s.live);
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
  const state = { speed, paused, demand: sim.demandScale, x: focus.x, z: focus.z, zoom, live: live.on };
  const text = JSON.stringify([world, state]);
  // A change is told at once (ten times a second at most, while the map is being dragged); otherwise
  // everything is repeated every two seconds, for a screen that has only just opened.
  if (now - sentAt < (text === sentWorld ? 2000 : 100)) return;
  sentWorld = text;
  sentAt = now;
  relay.send('world', world);
  relay.send('state', { ...state, clock: sim.clock });
}

// If the display's own browser is too slow to run the city, render it here instead: open this window
// with ?push=ws://pi-projector.local/frames (or pi-tv-1, pi-tv-2) and every frame goes to that display
// as a JPEG over its WebSocket. &fps=20 sets the rate. An http address gets each frame as a POST.
const pushTo = params.get('push');
const pushSocket = pushTo?.startsWith('ws');
const pushGap = 1000 / (Number(params.get('fps')) || (pushSocket ? 20 : 8));
let pushAt = 0;
let pushRetry = 0;
let pushing = false;
let frames = null;
function pushFrame(now) {
  if (!pushTo || pushing || now < pushAt) return;
  pushAt = now + pushGap;
  if (pushSocket) {
    if (!frames || frames.readyState > WebSocket.OPEN) {
      // A display that is not answering is tried again once a second, not once a frame.
      if (now < pushRetry) return;
      pushRetry = now + 1000;
      frames = new WebSocket(pushTo);
    }
    // Not connected yet, or the last frame is still on its way: skip this one rather than queue it.
    if (frames.readyState !== WebSocket.OPEN || frames.bufferedAmount > 0) return;
  }
  pushing = true;
  renderer.domElement.toBlob(
    async (blob) => {
      try {
        if (pushSocket) frames.send(blob);
        else await fetch(pushTo, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
      } catch {
        // The room is not answering; try again with the next frame.
      }
      pushing = false;
    },
    'image/jpeg',
    pushSocket ? 0.75 : 0.85,
  );
}

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return; // typing an hour, not a shortcut
  if (e.metaKey || e.ctrlKey || e.altKey) return; // the browser's own shortcuts: Cmd+C must not clear the table
  const step = zoom * 0.08;
  if (e.key >= '1' && e.key <= '4') speed = Number(e.key) - 1;
  if (e.key === ' ') paused = !paused;
  if (e.key === 't' && !live.on) sim.clock = (sim.clock + 3600) % 86400; // live traffic keeps the real time
  if (e.key === 'l') setLive(!live.on);
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
// An object is the same one as before if it is still within a few centimetres of where it was, so a
// reading that wobbles does not apply the tool again and again.
let usedObjects = []; // where the objects that have had their turn are, in table coordinates
function objectsUseTool(list) {
  const before = usedObjects;
  usedObjects = [];
  for (const b of list) {
    const k = before.findIndex((u) => Math.hypot(u.x - b.x, u.y - b.y) < 0.03);
    if (k >= 0) before.splice(k, 1);
    else useTool(fromTable(b));
    usedObjects.push({ x: b.x, y: b.y });
  }
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
  commit(planStrips, n);
  commit(newRoads, m);

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
  const workers = [];
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
    worker.onerror = (event) => {
      if (!comparing) return;
      comparing = false;
      for (const w of workers) w.terminate();
      for (const b of document.querySelectorAll('#compare-2, #compare-day')) b.disabled = false;
      out.innerHTML = `<p>The comparison could not be run: ${event.message || 'the simulation stopped'}.</p>`;
    };
    workers.push(worker);
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

const minSec = (s) => `${Math.floor(Math.round(s) / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}`;
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

// What the live sources report, for the panel: one line of numbers and one sentence.
function liveSummary() {
  if (!live.on) return { line: live.available ? 'off (L)' : 'no keys', text: '' };
  const parts = [];
  if (live.sites) parts.push(`${live.sites} sensors`);
  if (live.vehiclesFresh) parts.push(`${live.trams.length + live.buses.length + live.boats.length} vehicles`);
  if (live.incidents.length) parts.push(`${live.incidents.length} ${live.incidents.length === 1 ? 'incident' : 'incidents'}`);
  let text = live.sites ? `Live: the measured roads are at ${live.kmh} km/h with ${live.perLane} vehicles an hour in each lane.` : '';
  const worst = live.incidents.find((r) => r.accident) || live.incidents[0];
  if (worst) text += ` ${[worst.what || worst.type, worst.where].filter(Boolean).join(', ')}.`;
  return { line: parts.join(' · ') || live.error || 'waiting…', text };
}

function story(m, now) {
  if (!m.closures) {
    if (now) return `${now} Put something on the table to close a street.`;
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
  if (live.on && !follower) {
    const real = cityClock();
    if (Math.abs(sim.clock - real) > 3) sim.clock = real;
  }
  sim.liveBuses = live.vehiclesFresh;
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
  metrics.trams = tramsNow().length;
  metrics.live = live.on;
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
  const summary = liveSummary();
  el('m-live').textContent = summary.line;
  el('story').textContent = story(metrics, summary.text);
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
      const c = role === 0 ? car.paint : role === 1 ? GLASS : role === 2 ? WHITE : RED;
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
  for (const t of tramsNow()) {
    if (n > MAX_PARTS - 9) break;
    for (let sec = 0; sec < 3; sec++) {
      const s = t.s - 5 - sec * 10.2;
      if (s < 0) break;
      if (inTunnel(t.line, s)) continue;
      pointAt(t.line.path, s, P);
      putBox(bodies, n++, P.x, 1.05 * wideT, P.z, P.dx, P.dz, 9.8, 1.5 * wideT, 2.4 * wideT, TRAM_BLUE);
      putBox(bodies, n++, P.x, 2.15 * wideT, P.z, P.dx, P.dz, 9.2, 0.75 * wideT, 2.44 * wideT, GLASS);
      putBox(bodies, n++, P.x, 2.95 * wideT, P.z, P.dx, P.dz, 9.6, 0.85 * wideT, 2.3 * wideT, WHITE);
    }
  }

  // The real buses, when they are being reported. They are drawn where they are; the simulated
  // traffic does not see them.
  const realFleet = live.vehiclesFresh;
  if (realFleet) {
    const bus = paint(PAINT.bus[0]);
    for (const b of live.buses) {
      if (n > MAX_PARTS - 2) break;
      for (const [along, y, l, h, w, role] of PARTS.bus) {
        putBox(bodies, n++, b.x + b.dx * along * S, y * S, b.z + b.dz * along * S, b.dx, b.dz, l * S, h * S, w * S, role ? GLASS : bus);
      }
    }
  }

  // Ferries: the river shuttles (the real ones when reported), and the big ship to Denmark.
  for (const b of realFleet ? ferries.boats.filter((f) => f.big).concat(live.boats) : ferries.boats) {
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

  commit(bodies, n);
  commit(lamps, nl);
}

function drawPeople() {
  const mpp = metresPerPixel();
  let n = 0;
  // From far above a person is smaller than a pixel, so skip them.
  if (mpp < 2.2) {
    const S = Math.max(1, Math.min(3, mpp * 1.6));
    for (const p of people.agents) {
      if (!p.out || n > MAX_PEOPLE - 4) continue;
      const side = p.bike ? 0.6 : 0.9; // keep to the right
      const x = p.x - p.dz * side;
      const z = p.z + p.dx * side;
      const c = paint(CLOTHES[p.shade]);
      if (mpp < 0.12) {
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
  commit(walkers, n);
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
  commit(closedStrips, n, false);
}

// Orange glow on streets that are taking far longer than they should, readable even when cars are specks.
function drawJams() {
  let n = 0;
  for (const e of sim.edges) {
    if (!e.blocked && e.cars.length > 1 && e.tt > 3 * e.free + 25) n = strips(jamStrips, n, MAX_JAMS, e, 0.8, 4 + e.lanes * 3);
  }
  commit(jamStrips, n, false);
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
  commit(routeDots, n, false);
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

  // Reported incidents: red for an accident, amber for roadworks and everything else.
  const reports = live.on ? live.incidents : [];
  reports.forEach((r, k) => {
    const m = (reportMarks[k] ||= marker(0, '#ffffff'));
    m.visible = true;
    m.material.color.set(r.accident ? '#ff3b30' : '#ffb020');
    m.position.set(r.x, 2.5, r.z);
    m.scale.setScalar(metresPerPixel() * (r.accident ? 16 : 9) * (1 + Math.sin(performance.now() / 300 + k) * 0.15));
  });
  for (let k = reports.length; k < reportMarks.length; k++) reportMarks[k].visible = false;

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

// ---------- frame loop ----------

function advance(simSeconds) {
  // With a planning tool chosen, objects from the camera apply the tool instead of closing streets.
  const planning = tool !== 'object' && tool !== 'road' && !follower;
  if (planning) objectsUseTool(external);
  else usedObjects = []; // whatever is put down once a tool is chosen again gets its turn
  const blobs = mouse.blobs.concat(follower ? remote : planning ? [] : external.map(fromTable));
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
  }
  drawSky();
  drawVehicles(dt, sim.time);
  drawPeople();
  drawClosures();
  drawPlan();
  drawRoute(sim.time);
  drawOverlays(blobs, sim.time);
  renderer.render(scene, camera());
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (view === 'screen') {
    orbit += dt * 0.04;
    updateCameras();
  }
  live.step();
  const blobs = advance(paused ? 0 : dt * SPEEDS[speed]);
  draw(dt, blobs);
  tellScreens(blobs, now);
  pushFrame(now);
  requestAnimationFrame(frame);
}
el('loading').remove();
requestAnimationFrame(frame);

window.table = {
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
  trams: simTrams,
  live,
  setLive,
  people,
  metrics,
};
