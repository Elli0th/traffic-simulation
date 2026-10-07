// The operator's page: reads the depth camera, finds what is on the table, and tells the table and
// screens. Open /camera.html on the laptop and keep it visible while the installation runs.

import { BlobDetector, BlobTracker } from './depth.js';
import { Calibrator, MARKERS, toTable } from './calibration.js';
import { applyHomography } from './homography.js';
import { SimulatedDepth, HttpDepth, SocketDepth } from './sources.js';
import * as relay from './relay.js';

const KEY = 'tangible-table/camera';
const config = {
  source: 'sim',
  url: '',
  format: 'auto',
  width: '',
  height: '',
  interval: 80, // milliseconds between frames
  minHeight: 15,
  maxHeight: 700,
  minArea: 40,
  nearIsSmaller: true,
  sending: true,
  calibrations: {}, // one for the simulated camera, one for the real one
  ...JSON.parse(localStorage.getItem(KEY) || '{}'),
};
const save = () => localStorage.setItem(KEY, JSON.stringify(config));
const $ = (id) => document.getElementById(id);

let source = null;
let detector = new BlobDetector();
let tracker = new BlobTracker();
let calibrator = null; // set while calibrating
let collecting = null; // frames of the empty table being gathered
let frame = null;
let raw = [];
let steady = [];
let aspect = 1.6; // of the projected image; the table window tells us the real value
let tableSeen = -Infinity; // when the table window last answered
let frames = 0;
let fps = 0;
let problem = '';

const slot = () => (config.source === 'sim' ? 'sim' : 'real');
const calibration = () => config.calibrations[slot()] || null;

// ---------- camera ----------

function connect() {
  source?.close?.();
  problem = '';
  const size = { width: Number(config.width) || undefined, height: Number(config.height) || undefined };
  if (config.source !== 'sim' && !config.url) {
    source = null;
    frame = null;
    problem = 'Enter the address the depth frames come from, then press Connect.';
    return;
  }
  if (config.source === 'sim') source = new SimulatedDepth();
  else if (config.source === 'ws') source = new SocketDepth({ url: config.url, format: config.format, ...size });
  else source = new HttpDepth({ url: config.url, format: config.format, ...size });
  detector = new BlobDetector();
  tracker = new BlobTracker();
  calibrator = null;
  frame = null;
  applyThresholds();
  relay.send('calibrate', { index: -1 });
  // The simulated table is empty to begin with, so its background can be learned straight away.
  collecting = config.source === 'sim' ? [] : null;
}

function applyThresholds() {
  detector.minHeight = Number(config.minHeight);
  detector.maxHeight = Number(config.maxHeight);
  detector.minArea = Number(config.minArea);
  detector.nearIsSmaller = Boolean(config.nearIsSmaller);
}

// One round: fetch a frame, find the objects, pass them on.
async function tick() {
  if (!source) return;
  try {
    const next = await source.read();
    if (!next) return;
    frame = next;
    problem = '';
  } catch (error) {
    problem = `${error.message}. If the browser blocked the request, start the server with ROOM_API set and use /room-api/… as the address.`;
    return;
  }
  frames++;
  if (collecting) {
    collecting.push(frame);
    if (collecting.length >= 15) {
      detector.setBackground(collecting);
      collecting = null;
      tracker = new BlobTracker();
    }
  }
  raw = detector.detect(frame);

  if (calibrator) {
    if (calibrator.observe(raw)) nextMarker();
  } else if (calibration() && detector.ready) {
    steady = tracker.update(toTable(raw, calibration().toTable, aspect));
    if (config.sending) relay.send('blobs', steady);
  }
}

// ---------- calibration ----------

function startCalibration() {
  if (!detector.ready) return;
  calibrator = new Calibrator();
  steady = [];
  relay.send('blobs', []);
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
  tracker = new BlobTracker();
}

function cancelCalibration() {
  calibrator = null;
  showMarker();
}

// ---------- drawing ----------

const preview = $('preview');
const ctx = preview.getContext('2d');
let image = null;

// Sizes the picture to fit the window, so the instructions above it stay on screen.
function fit() {
  const room = preview.parentElement.clientWidth;
  const scale = Math.min(room / preview.width, (innerHeight * 0.6) / preview.height);
  preview.style.width = `${Math.round(preview.width * scale)}px`;
  preview.style.height = `${Math.round(preview.height * scale)}px`;
}
addEventListener('resize', fit);

function draw() {
  if (frame) {
    if (preview.width !== frame.width || preview.height !== frame.height) {
      preview.width = frame.width;
      preview.height = frame.height;
    }
    fit();
    if (!image || image.width !== frame.width || image.height !== frame.height) {
      image = ctx.createImageData(frame.width, frame.height);
    }
    // Depth as grey (near is light), no reading as dark blue, anything raised above the table in orange.
    const d = frame.data;
    let lo = Infinity;
    let hi = 0;
    for (let i = 0; i < d.length; i += 37) {
      if (d[i] > 0) {
        if (d[i] < lo) lo = d[i];
        if (d[i] > hi) hi = d[i];
      }
    }
    const span = Math.max(1, hi - lo);
    const px = image.data;
    const mask = detector.ready && detector.width === frame.width ? detector.mask : null;
    for (let i = 0; i < d.length; i++) {
      const o = 4 * i;
      if (mask && mask[i]) {
        px[o] = 255;
        px[o + 1] = 150;
        px[o + 2] = 40;
      } else if (d[i] > 0) {
        const t = (d[i] - lo) / span;
        const g = 40 + 150 * (detector.nearIsSmaller ? 1 - t : t);
        px[o] = px[o + 1] = px[o + 2] = g;
      } else {
        px[o] = 12;
        px[o + 1] = 20;
        px[o + 2] = 60;
      }
      px[o + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);

    const unit = frame.width / 640;
    ctx.lineWidth = 2 * unit;
    ctx.font = `${14 * unit}px ui-sans-serif, system-ui, sans-serif`;
    const c = calibration();
    if (c && !calibrator) {
      // Where the projected image lies in the camera's picture.
      ctx.strokeStyle = '#5ad1ff';
      ctx.beginPath();
      for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) ctx.lineTo(...applyHomography(c.toCamera, u, v));
      ctx.closePath();
      ctx.stroke();
    }
    ctx.strokeStyle = '#ffffff';
    for (const b of raw) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (calibrator) {
      ctx.fillStyle = '#39e6b0';
      calibrator.points.forEach(([x, y], k) => {
        ctx.beginPath();
        ctx.arc(x, y, 5 * unit, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText(String(k + 1), x + 8 * unit, y - 8 * unit);
      });
      if (calibrator.last) {
        // The ring fills as the object holds still.
        ctx.strokeStyle = '#39e6b0';
        ctx.beginPath();
        ctx.arc(calibrator.last.x, calibrator.last.y, calibrator.last.r + 6 * unit, -Math.PI / 2, -Math.PI / 2 + (calibrator.still / 10) * Math.PI * 2);
        ctx.stroke();
      }
    }
  }
  drawPretend();
  describe();
}

function describe() {
  const connected = Boolean(frame);
  const live = connected && detector.ready && calibration() && !calibrator;
  const now = !connected ? 'connect' : !detector.ready ? 'empty' : live ? 'live' : 'calibrate';
  const order = ['connect', 'empty', 'calibrate', 'live'];
  for (const li of $('steps').children) {
    const k = order.indexOf(li.dataset.step);
    li.className = k < order.indexOf(now) || (now === 'live' && k < 3) ? 'done' : k === order.indexOf(now) ? 'now' : '';
  }

  let hint;
  if (problem) hint = problem;
  else if (!connected) hint = 'Choose where the depth frames come from and press Connect.';
  else if (collecting) hint = 'Keep the table clear…';
  else if (!detector.ready) hint = 'Clear everything off the table, then press “Capture the empty table”.';
  else if (calibrator && calibrator.candidates > 1) {
    hint = `I can see ${calibrator.candidates} things on the table. Leave only the one on the glowing circle (${calibrator.step + 1} of ${MARKERS.length}).`;
  } else if (calibrator) {
    hint = `Put an object on the glowing circle on the table (${calibrator.step + 1} of ${MARKERS.length}) and take your hand away. Or click where it is in the picture below.`;
  } else if (!calibration()) hint = 'Press Calibrate. The table will show four circles, one at a time.';
  else if (config.source === 'sim' && source.objects.length && !raw.length) {
    // Only the pretend camera can know this: the objects were there when the empty table was captured.
    hint = 'The objects on the pretend table were there when the table was captured as empty, so they count as part of it. Press Clear, capture the empty table again, then put objects back.';
  } else {
    hint = `Live: ${steady.length} ${steady.length === 1 ? 'object' : 'objects'} on the table.`;
    if (!steady.length) hint += config.source === 'sim' ? ' Click the pretend table to add one.' : ' Put something on the table.';
  }
  $('hint').textContent = hint;

  const table = performance.now() - tableSeen < 6000 ? `table connected (${aspect.toFixed(2)} : 1)` : 'no table window heard from';
  $('status').textContent = frame ? `${frame.width} × ${frame.height} · ${fps} frames a second · ${table}` : table;
  $('status').className = problem ? 'bad' : '';
  $('calibration').textContent = calibration()
    ? 'Calibrated. The blue outline in the picture is the projected image. Calibrate again if the camera or projector moves.'
    : 'Not calibrated yet.';
  $('out').textContent = steady.map((b) => `x ${b.x.toFixed(3)}  y ${b.y.toFixed(3)}  r ${b.r.toFixed(3)}`).join('\n');
}

// ---------- the pretend table (simulated camera only) ----------

const pretend = $('pretend');
const pctx = pretend.getContext('2d');

function drawPretend() {
  $('virtual').hidden = config.source !== 'sim';
  $('remote').hidden = config.source === 'sim';
  if (config.source !== 'sim' || !source) return;
  const W = pretend.width;
  const H = pretend.height;
  pctx.clearRect(0, 0, W, H);
  if (calibrator && calibrator.step < MARKERS.length) {
    const [x, y] = MARKERS[calibrator.step];
    pctx.strokeStyle = '#ffffff';
    pctx.lineWidth = 2;
    pctx.beginPath();
    pctx.arc(x * W, y * H, 14, 0, Math.PI * 2);
    pctx.stroke();
  }
  for (const o of source.objects) {
    pctx.fillStyle = o.h < 60 ? '#7be04a' : '#ff8a5e'; // something flat, or a cup
    pctx.beginPath();
    pctx.arc(o.x * W, o.y * H, o.r * W, 0, Math.PI * 2);
    pctx.fill();
  }
}

pretend.addEventListener('click', (e) => {
  const box = pretend.getBoundingClientRect();
  const x = (e.clientX - box.left) / box.width;
  const y = (e.clientY - box.top) / box.height;
  const hit = source.objects.findIndex((o) => Math.hypot(o.x - x, (o.y - y) / aspect) < o.r * 1.3);
  if (hit >= 0) source.objects.splice(hit, 1);
  else source.objects.push({ x, y, r: 0.028, h: e.shiftKey ? 30 : 95 });
});
$('onmarker').addEventListener('click', () => {
  if (!calibrator || calibrator.step >= MARKERS.length) return;
  const [x, y] = MARKERS[calibrator.step];
  source.objects = [{ x, y, r: 0.028, h: 95 }];
});
$('clear').addEventListener('click', () => {
  source.objects = [];
  problem = '';
});

// ---------- controls ----------

for (const id of ['source', 'url', 'format', 'width', 'height', 'interval', 'minHeight', 'maxHeight', 'minArea']) {
  const input = $(id);
  input.value = config[id];
  const show = () => {
    const out = document.querySelector(`output[for="${id}"]`);
    if (out) out.textContent = id === 'interval' ? `${input.value} ms` : input.value;
  };
  show();
  input.addEventListener('input', () => {
    config[id] = input.value;
    show();
    save();
    applyThresholds();
    if (id === 'source') draw();
  });
}
for (const id of ['nearIsSmaller', 'sending']) {
  $(id).checked = config[id];
  $(id).addEventListener('change', () => {
    config[id] = $(id).checked;
    save();
    applyThresholds();
    if (id === 'sending' && !config.sending) relay.send('blobs', []);
  });
}
$('connect').addEventListener('click', connect);
$('empty').addEventListener('click', () => {
  // With the pretend table we can tell that it is not empty; with the real one you have to look.
  if (config.source === 'sim' && source?.objects.length) {
    problem = 'The pretend table is not empty. Press Clear first, then capture it.';
    return;
  }
  problem = '';
  collecting = [];
});
$('calibrate').addEventListener('click', startCalibration);
$('cancel').addEventListener('click', cancelCalibration);
$('undo').addEventListener('click', () => {
  calibrator?.undo();
  showMarker();
});
preview.addEventListener('click', (e) => {
  if (!calibrator || !frame) return;
  const box = preview.getBoundingClientRect();
  calibrator.capture(((e.clientX - box.left) / box.width) * frame.width, ((e.clientY - box.top) / box.height) * frame.height);
  nextMarker();
});

// The table window says how wide its picture is compared with its height.
relay.on('hello', (m) => {
  if (m.aspect) aspect = m.aspect;
  tableSeen = performance.now();
});
relay.send('who', {});

// ---------- running ----------

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
  if (calibrator) showMarker(); // repeat, in case the table window has only just opened
  relay.send('who', {});
}, 1000);

// For tests and for poking at from the console.
window.cam = {
  config,
  tick,
  draw,
  connect,
  startCalibration,
  get source() {
    return source;
  },
  get state() {
    return { ready: detector.ready, calibrating: calibrator ? calibrator.step : -1, calibrated: Boolean(calibration()), raw, steady, problem, aspect };
  },
};
