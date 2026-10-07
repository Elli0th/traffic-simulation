// The operator's page for the lidar: reads its sweeps, finds hands over the table, and tells the
// table how to move the map. Open /lidar.html on the laptop and keep it visible.

import { ScanDetector, Gestures, SimulatedLidar, decodeScan } from './scan.js';
import { Calibrator, MARKERS } from './calibration.js';
import { applyHomography } from './homography.js';
import * as relay from './relay.js';

const KEY = 'tangible-table/lidar';
// The room's lidar. In the virtual room (Docker) it is ws://localhost:8024/scan.
const ROOM_LIDAR = 'ws://pi-lidar.local/scan';
const config = {
  source: 'sim',
  url: ROOM_LIDAR,
  interval: 80,
  margin: 60,
  objects: true,
  sending: true,
  calibrations: {},
  ...JSON.parse(localStorage.getItem(KEY) || '{}'),
};
if (!config.url) config.url = ROOM_LIDAR;
const save = () => localStorage.setItem(KEY, JSON.stringify(config));
const $ = (id) => document.getElementById(id);

let source = null;
let socket = null;
let latest = null; // newest sweep from a WebSocket
let detector = new ScanDetector();
let gestures = new Gestures();
let calibrator = null;
let collecting = null;
let scan = null;
let blips = [];
let last = { hands: 0, objects: [], pan: [0, 0], zoom: 1 };
let frames = 0;
let fps = 0;
let problem = '';

const slot = () => (config.source === 'sim' ? 'sim' : 'real');
const calibration = () => config.calibrations[slot()] || null;

function connect() {
  socket?.close();
  socket = null;
  latest = null;
  scan = null;
  if (config.source !== 'sim' && !config.url) {
    source = null;
    problem = 'Enter the address the lidar sweeps come from, then press Connect.';
    return;
  }
  if (config.source === 'sim') source = new SimulatedLidar();
  else if (config.source === 'ws') {
    const opened = (socket = new WebSocket(config.url));
    socket.onmessage = (event) => (latest = decodeScan(JSON.parse(event.data)));
    socket.onclose = () => {
      if (socket !== opened) return;
      problem = `No connection to the lidar at ${config.url}. Is this laptop on the room wifi? Trying again…`;
      setTimeout(() => socket === opened && connect(), 2000);
    };
    // Each sweep is handed out once, however often the page asks.
    source = {
      read: async () => {
        const sweep = latest;
        latest = null;
        return sweep;
      },
    };
  } else {
    source = {
      read: async () => {
        const response = await fetch(config.url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`The lidar answered ${response.status}`);
        return decodeScan(await response.json());
      },
    };
  }
  detector = new ScanDetector({ margin: Number(config.margin) });
  gestures = new Gestures();
  calibrator = null;
  relay.send('calibrate', { index: -1 });
  collecting = config.source === 'sim' ? [] : null;
}

async function tick() {
  if (!source) return;
  try {
    const next = await source.read();
    if (!next) return;
    scan = next;
    if (!socket || socket.readyState === WebSocket.OPEN) problem = '';
  } catch (error) {
    problem = `${error.message}. If the browser blocked the request, start the server with ROOM_API set and use /room-api/… as the address.`;
    return;
  }
  frames++;
  if (collecting) {
    collecting.push(scan);
    if (collecting.length >= 12) {
      detector.setBackground(collecting);
      collecting = null;
    }
  }
  detector.margin = Number(config.margin);
  blips = detector.detect(scan);

  if (calibrator) {
    if (calibrator.observe(blips)) nextMarker();
  } else if (calibration() && detector.ready) {
    const points = [];
    for (const b of blips) {
      const [x, y] = applyHomography(calibration().toTable, b.x, b.y);
      if (x > -0.05 && x < 1.05 && y > -0.05 && y < 1.05) points.push({ x, y });
    }
    last = gestures.update(points, performance.now() / 1000);
    if (config.sending && (last.pan[0] || last.pan[1] || last.zoom !== 1)) {
      relay.send('gesture', { pan: last.pan, zoom: last.zoom, at: last.at });
    }
    if (config.objects) relay.send('blobs', { from: 'lidar', list: last.objects.map((o) => ({ x: o.x, y: o.y, r: 0.02 })) });
  }
}

// ---------- calibration ----------

function startCalibration() {
  if (!detector.ready) return;
  calibrator = new Calibrator({ apart: 80, steady: 25 });
  showMarker();
}
function showMarker() {
  const k = calibrator ? calibrator.step : -1;
  if (k >= 0 && k < MARKERS.length) relay.send('calibrate', { index: k, x: MARKERS[k][0], y: MARKERS[k][1] });
  else relay.send('calibrate', { index: -1 });
}
function nextMarker() {
  if (calibrator.step < MARKERS.length) return showMarker();
  const result = calibrator.result();
  calibrator = null;
  showMarker();
  if (!result) {
    problem = 'Those four positions cannot be right (they cross over or line up). Calibrate again.';
    return;
  }
  config.calibrations[slot()] = result;
  save();
  gestures = new Gestures();
}

// ---------- drawing ----------

const preview = $('preview');
const ctx = preview.getContext('2d');
const RANGE = 1800; // millimetres shown either side of the lidar
const toPx = (x, y) => [preview.width / 2 + (x / RANGE) * (preview.width / 2), 30 + (y / RANGE) * (preview.width / 2)];

function draw() {
  const room = preview.parentElement.clientWidth;
  const scale = Math.min(room / preview.width, (innerHeight * 0.55) / preview.height);
  preview.style.width = `${Math.round(preview.width * scale)}px`;
  preview.style.height = `${Math.round(preview.height * scale)}px`;

  ctx.fillStyle = '#0d1016';
  ctx.fillRect(0, 0, preview.width, preview.height);
  if (scan) {
    ctx.fillStyle = '#6f7b8a';
    for (let i = 0; i < scan.angles.length; i++) {
      if (scan.ranges[i] <= 0) continue;
      const [x, y] = toPx(scan.ranges[i] * Math.cos(scan.angles[i]), scan.ranges[i] * Math.sin(scan.angles[i]));
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }
    const c = calibration();
    if (c && !calibrator) {
      ctx.strokeStyle = '#5ad1ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) ctx.lineTo(...toPx(...applyHomography(c.toCamera, u, v)));
      ctx.closePath();
      ctx.stroke();
    }
    ctx.fillStyle = '#ff9628';
    ctx.strokeStyle = '#ffffff';
    for (const b of blips) {
      const [x, y] = toPx(b.x, b.y);
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (calibrator) {
      ctx.fillStyle = '#39e6b0';
      calibrator.points.forEach(([px, py], k) => {
        const [x, y] = toPx(px, py);
        ctx.fillRect(x - 4, y - 4, 8, 8);
        ctx.fillText(String(k + 1), x + 8, y - 6);
      });
    }
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(...toPx(0, 0), 5, 0, Math.PI * 2);
    ctx.fill();
  }
  drawPretend();
  describe();
}

function describe() {
  const connected = Boolean(scan);
  const live = connected && detector.ready && calibration() && !calibrator;
  const now = !connected ? 'connect' : !detector.ready ? 'empty' : live ? 'live' : 'calibrate';
  const order = ['connect', 'empty', 'calibrate', 'live'];
  for (const li of $('steps').children) {
    const k = order.indexOf(li.dataset.step);
    li.className = k < order.indexOf(now) ? 'done' : k === order.indexOf(now) ? 'now' : '';
  }
  let hint;
  if (problem) hint = problem;
  else if (!connected) hint = 'Choose where the lidar sweeps come from and press Connect.';
  else if (collecting) hint = 'Keep hands and objects off the table…';
  else if (!detector.ready) hint = 'Clear the table, step back, then press “Capture the empty table”.';
  else if (calibrator && calibrator.candidates > 1) hint = `I can see ${calibrator.candidates} things. Only one finger on the table, on the glowing circle (${calibrator.step + 1} of ${MARKERS.length}).`;
  else if (calibrator) hint = `Hold a finger on the glowing circle on the table (${calibrator.step + 1} of ${MARKERS.length}) and keep it still for a second.`;
  else if (!calibration()) hint = 'Press Calibrate. The table will show four circles, one at a time.';
  else {
    const what = last.hands === 0 ? 'No hands over the table.' : last.hands === 1 ? 'One hand: dragging the map.' : 'Two hands: zooming.';
    hint = `Live. ${what}${last.objects.length ? ` ${last.objects.length} still ${last.objects.length === 1 ? 'object' : 'objects'}.` : ''}`;
  }
  $('hint').textContent = hint;
  $('status').textContent = scan ? `${scan.angles.length} readings a sweep · ${fps} sweeps a second` : '';
  $('status').className = problem ? 'bad' : '';
  $('calibration').textContent = calibration() ? 'Calibrated. Calibrate again if the lidar or projector moves.' : 'Not calibrated yet.';
  $('out').textContent = `pan ${last.pan.map((v) => v.toFixed(3)).join(', ')}   zoom ${last.zoom.toFixed(3)}`;
}

// ---------- the pretend table (simulated lidar only) ----------

const pretend = $('pretend');
const pctx = pretend.getContext('2d');
let cups = [];
let hands = [];
const place = () => (source.things = cups.concat(hands));

function drawPretend() {
  $('virtual').hidden = config.source !== 'sim';
  $('remote').hidden = config.source === 'sim';
  if (config.source !== 'sim' || !source) return;
  const W = pretend.width;
  const H = pretend.height;
  pctx.clearRect(0, 0, W, H);
  if (calibrator && calibrator.step < MARKERS.length) {
    pctx.strokeStyle = '#ffffff';
    pctx.lineWidth = 2;
    pctx.beginPath();
    pctx.arc(MARKERS[calibrator.step][0] * W, MARKERS[calibrator.step][1] * H, 14, 0, Math.PI * 2);
    pctx.stroke();
  }
  for (const [list, color, size] of [[cups, '#ff8a5e', 8], [hands, '#5ad1ff', 5]]) {
    pctx.fillStyle = color;
    for (const o of list) {
      pctx.beginPath();
      pctx.arc(o.x * W, o.y * H, size, 0, Math.PI * 2);
      pctx.fill();
    }
  }
}

let dragging = null;
const where = (e) => {
  const box = pretend.getBoundingClientRect();
  return { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height };
};
pretend.addEventListener('pointerdown', (e) => {
  dragging = { start: where(e), moved: false };
  pretend.setPointerCapture(e.pointerId);
});
pretend.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const p = where(e);
  if (Math.hypot(p.x - dragging.start.x, p.y - dragging.start.y) > 0.02) dragging.moved = true;
  if (!dragging.moved) return;
  // Shift-drag: a second hand mirrors the first through the middle of the table.
  hands = e.shiftKey ? [{ ...p, r: 14 }, { x: 1 - p.x, y: 1 - p.y, r: 14 }] : [{ ...p, r: 14 }];
  place();
});
pretend.addEventListener('pointerup', (e) => {
  if (dragging && !dragging.moved) {
    const p = where(e);
    const hit = cups.findIndex((o) => Math.hypot(o.x - p.x, o.y - p.y) < 0.05);
    if (hit >= 0) cups.splice(hit, 1);
    else cups.push({ ...p, r: 35 });
  }
  hands = [];
  dragging = null;
  place();
});
$('onmarker').addEventListener('click', () => {
  if (!calibrator || calibrator.step >= MARKERS.length) return;
  cups = [];
  hands = [{ x: MARKERS[calibrator.step][0], y: MARKERS[calibrator.step][1], r: 12 }];
  place();
});
$('clear').addEventListener('click', () => {
  cups = [];
  hands = [];
  place();
  problem = '';
});

// ---------- controls ----------

for (const id of ['source', 'url', 'interval', 'margin']) {
  const input = $(id);
  input.value = config[id];
  const show = () => {
    const out = document.querySelector(`output[for="${id}"]`);
    if (out) out.textContent = id === 'interval' ? `${input.value} ms` : `${input.value} mm`;
  };
  show();
  input.addEventListener('input', () => {
    config[id] = input.value;
    show();
    save();
  });
}
for (const id of ['objects', 'sending']) {
  $(id).checked = config[id];
  $(id).addEventListener('change', () => {
    config[id] = $(id).checked;
    save();
    if (id === 'objects' && !config.objects) relay.send('blobs', { from: 'lidar', list: [] });
  });
}
$('connect').addEventListener('click', connect);
$('empty').addEventListener('click', () => {
  if (config.source === 'sim' && source?.things.length) {
    problem = 'The pretend table is not empty. Press Clear first, then capture it.';
    return;
  }
  problem = '';
  collecting = [];
});
$('calibrate').addEventListener('click', startCalibration);
$('cancel').addEventListener('click', () => {
  calibrator = null;
  showMarker();
});
$('undo').addEventListener('click', () => {
  calibrator?.undo();
  showMarker();
});

connect();
async function loop() {
  await tick();
  draw();
  setTimeout(loop, Number(config.interval));
}
loop();
setInterval(() => {
  fps = frames;
  frames = 0;
  if (calibrator) showMarker();
}, 1000);

// For tests and for poking at from the console.
window.lidar = {
  config,
  tick,
  draw,
  connect,
  startCalibration,
  get source() {
    return source;
  },
  get state() {
    return { ready: detector.ready, calibrating: calibrator ? calibrator.step : -1, calibrated: Boolean(calibration()), blips, last, problem };
  },
};
