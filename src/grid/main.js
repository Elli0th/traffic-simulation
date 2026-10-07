import * as THREE from 'three';
import { Sim, CELL, ROAD, LANE } from './sim.js';
import { buildCity, VOX } from './city.js';
import { MouseInput } from './input.js';

const W = 8;
const H = 5;
const WX = W * CELL;
const WZ = H * CELL;
const MAX_CARS = 400;
const MAX_DOTS = 400;

const sim = new Sim(W, H);

// ---------- renderer, cameras, lights ----------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#000000');
scene.add(new THREE.HemisphereLight('#cfdcff', '#20232b', 1.3));
const sun = new THREE.DirectionalLight('#fff1d6', 1.7);
sun.position.set(WX * 0.2, 90, WZ * 1.2);
scene.add(sun);

const centre = new THREE.Vector3(WX / 2, 0, WZ / 2);

// Table view: straight down, x to the right and z towards the viewer, like the projector.
const tableCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 500);
tableCam.position.set(centre.x, 200, centre.z);
tableCam.up.set(0, 0, -1);
tableCam.lookAt(centre);

// Screen view: slow 3D flyover for the TVs.
const screenCam = new THREE.PerspectiveCamera(38, 1, 1, 1000);

let view = new URLSearchParams(location.search).get('view') === 'screen' ? 'screen' : 'table';
const camera = () => (view === 'table' ? tableCam : screenCam);

function resize() {
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h);
  const aspect = w / h;
  const viewW = WX + ROAD * 2;
  const viewH = WZ + ROAD * 2;
  let halfW = viewW / 2;
  let halfH = viewH / 2;
  if (aspect > viewW / viewH) halfW = halfH * aspect;
  else halfH = halfW / aspect;
  tableCam.left = -halfW;
  tableCam.right = halfW;
  tableCam.top = halfH;
  tableCam.bottom = -halfH;
  tableCam.updateProjectionMatrix();
  screenCam.aspect = aspect;
  screenCam.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------- static world ----------

const flat = (w, d, color, y, opts = {}) => {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    opts.basic ? new THREE.MeshBasicMaterial({ color, ...opts.mat }) : new THREE.MeshLambertMaterial({ color }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = y;
  return m;
};

const ground = flat(WX + 200, WZ + 200, '#050607', -0.02);
ground.position.x = centre.x;
ground.position.z = centre.z;
scene.add(ground);

for (let j = 0; j <= H; j++) {
  const r = flat(WX + ROAD, ROAD, '#2b2f38', 0);
  r.position.set(centre.x, 0, j * CELL);
  scene.add(r);
}
for (let i = 0; i <= W; i++) {
  const r = flat(ROAD, WZ + ROAD, '#2b2f38', 0.005);
  r.position.set(i * CELL, 0.005, centre.z);
  scene.add(r);
}

const dummy = new THREE.Object3D();
const tmpColor = new THREE.Color();

function instanced(geometry, material, items) {
  const mesh = new THREE.InstancedMesh(geometry, material, items.length);
  items.forEach((v, k) => {
    dummy.position.set(v.x, v.y, v.z);
    dummy.rotation.set(0, v.ry || 0, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(k, dummy.matrix);
    mesh.setColorAt(k, tmpColor.set(v.c));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  scene.add(mesh);
  return mesh;
}

const city = buildCity(W, H, { i: 1, j: 1 });
const cube = new THREE.BoxGeometry(VOX, VOX, VOX);
instanced(cube, new THREE.MeshLambertMaterial(), city.solid);
instanced(cube, new THREE.MeshBasicMaterial(), city.glow);

// Lane dashes and one red overlay per street segment (shown while it is closed).
const dashes = [];
const closedOverlay = [];
sim.edges.forEach((e, ei) => {
  if (ei > e.rev) return;
  const A = sim.nodes[e.a];
  for (let s = ROAD / 2 + 1; s <= CELL - ROAD / 2 - 1; s += 1.5) {
    dashes.push({ x: A.x + e.dx * s, y: 0.03, z: A.z + e.dz * s, ry: e.dz ? Math.PI / 2 : 0, c: '#c9b458' });
  }
  const o = flat(e.dx ? CELL : ROAD, e.dx ? ROAD : CELL, '#ff3b30', 0.02, {
    basic: true,
    mat: { transparent: true, opacity: 0.4 },
  });
  o.position.set(A.x + (e.dx * CELL) / 2, 0.02, A.z + (e.dz * CELL) / 2);
  o.visible = false;
  scene.add(o);
  closedOverlay.push({ edge: e, mesh: o });
});
instanced(new THREE.BoxGeometry(0.8, 0.04, 0.14), new THREE.MeshBasicMaterial(), dashes);

// Markers for the two ends of the ambulance route.
const marker = (node, color) => {
  const m = new THREE.Mesh(
    new THREE.RingGeometry(1.2, 1.7, 40),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.set(sim.nodes[node].x, 0.05, sim.nodes[node].z);
  scene.add(m);
  return m;
};
const markers = [marker(sim.hospital, '#5ad1ff'), marker(sim.incident, '#ff9f1c')];

// ---------- dynamic things ----------

const carBody = new THREE.InstancedMesh(
  new THREE.BoxGeometry(1.7, 0.45, 0.85),
  new THREE.MeshLambertMaterial(),
  MAX_CARS,
);
const carCabin = new THREE.InstancedMesh(
  new THREE.BoxGeometry(0.8, 0.35, 0.7),
  new THREE.MeshLambertMaterial({ color: '#141a24' }),
  MAX_CARS,
);
carBody.setColorAt(0, tmpColor.set('#ffffff'));
carBody.frustumCulled = false;
carCabin.frustumCulled = false;
scene.add(carBody, carCabin);

const dots = new THREE.InstancedMesh(
  new THREE.BoxGeometry(0.4, 0.4, 0.4),
  new THREE.MeshBasicMaterial({ color: '#5ad1ff' }),
  MAX_DOTS,
);
dots.frustumCulled = false;
dots.count = 0;
scene.add(dots);

const rings = [];
function ring(k) {
  while (rings.length <= k) {
    const g = new THREE.Group();
    const edge = new THREE.Mesh(new THREE.RingGeometry(0.88, 1, 56), new THREE.MeshBasicMaterial({ color: '#ff5a4d' }));
    const fill = new THREE.Mesh(
      new THREE.CircleGeometry(0.88, 56),
      new THREE.MeshBasicMaterial({ color: '#ff3b30', transparent: true, opacity: 0.18 }),
    );
    g.add(edge, fill);
    g.rotation.x = -Math.PI / 2;
    g.position.y = 0.6;
    scene.add(g);
    rings.push(g);
  }
  return rings[k];
}

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

const mouse = new MouseInput(renderer.domElement, pick);

// Swap point for the real depth camera: feed it objects in table coordinates,
// x and y from 0 to 1 (left to right, far edge to near edge), r as a fraction of the width.
let external = [];
window.table = {
  setBlobs(list) {
    external = list.map((b) => ({ x: b.x * WX, z: b.y * WZ, r: (b.r ?? 0.03) * WX }));
  },
  clear() {
    external = [];
    mouse.clear();
  },
  sim,
};

addEventListener('keydown', (e) => {
  if (e.key === 'v') view = view === 'table' ? 'screen' : 'table';
  if (e.key === 'h') document.body.classList.toggle('nohud');
  if (e.key === 'c') window.table.clear();
  if (e.key === '+' || e.key === '=') sim.target = Math.min(MAX_CARS, sim.target + 20);
  if (e.key === '-') sim.target = Math.max(20, sim.target - 20);
  if (e.key === 'f') document.documentElement.requestFullscreen?.();
});

// ---------- metrics and narration ----------

const el = (id) => document.getElementById(id);
const metrics = { congestion: 0, closures: 0, cars: 0, ambulanceDelay: 0, noRoute: false };
let flowEma = 1;
let baseFlow = 0;
let baseAmbulance = 0;
let emergency = null;
let metricsTimer = 0;

function story(m) {
  if (!m.closures) return 'Traffic is flowing. Put something on the table to close a street.';
  const parts = [`${m.closures} street ${m.closures === 1 ? 'segment is' : 'segments are'} closed.`];
  const drop = Math.round(m.speedDrop * 100);
  if (drop >= 5) parts.push(`Average speed is down ${drop}%.`);
  if (m.noRoute) parts.push('The ambulance cannot reach the incident.');
  else if (m.ambulanceDelay >= 0.05) parts.push(`The ambulance needs ${Math.round(m.ambulanceDelay * 100)}% longer.`);
  else parts.push('The ambulance route is unaffected.');
  return parts.join(' ');
}

function updateMetrics() {
  const flow = sim.flow();
  flowEma += (flow - flowEma) * 0.15;
  emergency = sim.emergency();
  const closures = sim.closures();
  // Learn what "normal" looks like while nothing is on the table.
  if (!closures && sim.time > 8) {
    baseFlow = baseFlow ? baseFlow + (flowEma - baseFlow) * 0.05 : flowEma;
    if (emergency) baseAmbulance = baseAmbulance ? baseAmbulance + (emergency.time - baseAmbulance) * 0.05 : emergency.time;
  }
  metrics.congestion = 1 - flowEma;
  metrics.closures = closures;
  metrics.cars = sim.cars.length;
  metrics.speedDrop = baseFlow ? Math.max(0, 1 - flowEma / baseFlow) : 0;
  metrics.noRoute = !emergency;
  metrics.ambulanceDelay = emergency && baseAmbulance ? Math.max(0, emergency.time / baseAmbulance - 1) : 0;

  el('m-cong').textContent = `${Math.round(metrics.congestion * 100)}%`;
  const bar = el('bar').firstElementChild;
  bar.style.width = `${Math.round(metrics.congestion * 100)}%`;
  bar.style.background = `hsl(${Math.round((1 - metrics.congestion) * 150)} 80% 55%)`;
  el('m-closed').textContent = closures;
  el('m-cars').textContent = metrics.cars;
  el('m-amb').textContent = metrics.noRoute ? 'no route' : emergency ? `${emergency.time.toFixed(0)} s` : '–';
  el('story').textContent = story(metrics);
  // Hook for lights, sound and the AI narrator.
  dispatchEvent(new CustomEvent('table-metrics', { detail: { ...metrics } }));
}

// ---------- frame loop ----------

const cabinOffset = new THREE.Vector3();
const yAxis = new THREE.Vector3(0, 1, 0);

function drawCars(dt) {
  const k = Math.min(1, dt * 12);
  let n = 0;
  for (const car of sim.cars) {
    if (n >= MAX_CARS) break;
    const e = sim.edges[car.edge];
    const A = sim.nodes[e.a];
    const tx = A.x + e.dx * car.s - e.dz * LANE;
    const tz = A.z + e.dz * car.s + e.dx * LANE;
    const ta = Math.atan2(-e.dz, e.dx);
    if (car.rx === undefined) {
      car.rx = tx;
      car.rz = tz;
      car.ra = ta;
      car.cf = 1;
    }
    car.rx += (tx - car.rx) * k;
    car.rz += (tz - car.rz) * k;
    car.ra += Math.atan2(Math.sin(ta - car.ra), Math.cos(ta - car.ra)) * k;
    car.cf += (Math.min(1, car.v / car.vmax) - car.cf) * Math.min(1, dt * 4);

    dummy.position.set(car.rx, 0.33, car.rz);
    dummy.rotation.set(0, car.ra, 0);
    dummy.updateMatrix();
    carBody.setMatrixAt(n, dummy.matrix);
    carBody.setColorAt(n, tmpColor.setHSL(car.cf * 0.44, 0.9, 0.55));
    cabinOffset.set(-0.12, 0.38, 0).applyAxisAngle(yAxis, car.ra);
    dummy.position.add(cabinOffset);
    dummy.updateMatrix();
    carCabin.setMatrixAt(n, dummy.matrix);
    n++;
  }
  carBody.count = n;
  carCabin.count = n;
  carBody.instanceMatrix.needsUpdate = true;
  carCabin.instanceMatrix.needsUpdate = true;
  carBody.instanceColor.needsUpdate = true;
}

function drawRoute(time) {
  let n = 0;
  if (emergency) {
    const spacing = 1.5;
    const phase = (time * 5) % spacing;
    for (const ei of emergency.path) {
      const e = sim.edges[ei];
      const A = sim.nodes[e.a];
      for (let s = phase; s < e.len && n < MAX_DOTS; s += spacing) {
        dummy.position.set(A.x + e.dx * s, 0.3, A.z + e.dz * s);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        dots.setMatrixAt(n++, dummy.matrix);
      }
    }
  }
  dots.count = n;
  dots.instanceMatrix.needsUpdate = true;
}

function drawBlobs(blobs, time) {
  const pulse = 1 + Math.sin(time * 4) * 0.04;
  blobs.forEach((b, k) => {
    const g = ring(k);
    g.visible = true;
    g.position.set(b.x, 0.6, b.z);
    g.scale.setScalar(b.r * pulse);
  });
  for (let k = blobs.length; k < rings.length; k++) rings[k].visible = false;
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  const blobs = mouse.blobs.concat(external);
  sim.setBlobs(blobs);
  sim.step(dt);

  metricsTimer -= dt;
  if (metricsTimer <= 0) {
    metricsTimer = 0.25;
    updateMetrics();
  }

  drawCars(dt);
  drawRoute(sim.time);
  drawBlobs(blobs, sim.time);
  for (const o of closedOverlay) {
    o.mesh.visible = o.edge.blocked;
    o.mesh.material.opacity = 0.32 + Math.sin(sim.time * 4) * 0.1;
  }
  const beat = 1 + Math.sin(sim.time * 3) * 0.12;
  for (const m of markers) m.scale.setScalar(beat);

  if (view === 'screen') {
    const a = sim.time * 0.06 + 0.6;
    screenCam.position.set(centre.x + Math.cos(a) * 112, 70, centre.z + Math.sin(a) * 112);
    screenCam.lookAt(centre);
  }
  renderer.render(scene, camera());
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
