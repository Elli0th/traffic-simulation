// The table as a test card: for calibrating the lidar and seeing what it registers, with nothing
// else running. No city and no game, only a flat drawing, so the display's own computer can show it
// easily. Put it on the table with: npm run room show check
//
// It shows three things:
//   - calibration, as the lidar page asks for it: the nine circles, one at a time
//   - everything the lidar page registers, as rings (see touch-marks.js)
//   - nine crosses to try the calibration against: hold a fingertip on one until its ring turns
//     amber, and the page writes how far from the cross the table thinks the finger is
//
// ?width=1440 is the width of the projected picture in millimetres, to give the misses in millimetres too.

import * as relay from './relay.js';
import { MARKERS } from './calibration.js';
import { TouchMarks } from './touch-marks.js';
import { drawCalibration } from './calibration-view.js';

const params = new URLSearchParams(location.search);
const widthMm = Number(params.get('width')) || 1440;
const canvas = document.getElementById('table');
const ctx = canvas.getContext('2d');
let W = 1;
let H = 1;
function resize() {
  W = canvas.width = innerWidth;
  H = canvas.height = innerHeight;
}
addEventListener('resize', resize);
resize();
const aspect = () => W / H;

const marks = new TouchMarks();
let calibrating = null;
let verdict = null;
let heardAt = -Infinity; // when the lidar page last said anything
let gestureAt = -Infinity;
let gesture = { pan: [0, 0], zoom: 1 };
let moved = [0, 0]; // how far the hands have dragged in all, in pictures
let zoomed = 1;
// What a finger held on each cross came to: { u, v, error } (error as a share of the picture's width).
const tried = MARKERS.map(() => null);

relay.on('calibrate', (m) => {
  calibrating = m.index >= 0 ? m : null;
  if (m.verdict) verdict = { ...m.verdict, until: performance.now() + 6000 };
  if (calibrating) tried.fill(null); // a new calibration: the old misses say nothing about it
  heardAt = performance.now();
});
relay.on('touches', (m) => {
  heardAt = performance.now();
  marks.update(m?.list);
  // Something that has stood still (the lidar page calls it an object) on or near a cross: note the miss.
  for (const p of m?.list || []) {
    if (p.kind !== 'object') continue;
    let best = -1;
    let bestD = 0.08;
    MARKERS.forEach(([x, y], k) => {
      const d = Math.hypot(p.x - x, (p.y - y) / aspect());
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    });
    if (best < 0) continue;
    const before = tried[best];
    if (before && Math.hypot(before.u - p.x, before.v - p.y) < 0.004) continue; // the same finger, still there
    tried[best] = { u: p.x, v: p.y, error: bestD };
    relay.send('record', { what: 'accuracy', page: 'check', cross: best, target: MARKERS[best], landed: [p.x, p.y], error: bestD, mm: Math.round(bestD * widthMm) });
  }
});
relay.on('gesture', (g) => {
  gesture = g;
  gestureAt = performance.now();
  moved = [moved[0] + g.pan[0], moved[1] + g.pan[1]];
  zoomed *= g.zoom;
});
relay.on('who', () => relay.send('hello', { aspect: aspect() }));
relay.send('hello', { aspect: aspect() });
addEventListener('keydown', (e) => {
  if (e.key === 'c') {
    tried.fill(null);
    moved = [0, 0];
    zoomed = 1;
  }
  if (e.key === 'f') document.documentElement.requestFullscreen?.();
});

function text(string, x, y, size, color, align = 'center', weight = 500) {
  ctx.font = `${weight} ${Math.round(W * size)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.fillText(string, x, y);
}

function draw(now) {
  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, W, H);

  // A frame round the picture, so that it is plain where its edges are on the table.
  ctx.strokeStyle = '#2a3340';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);

  // The crosses, and what was measured at each.
  const arm = W * 0.012;
  MARKERS.forEach(([x, y], k) => {
    const cx = x * W;
    const cy = y * H;
    const t = tried[k];
    const color = !t ? '#5b6675' : t.error < 0.02 ? '#39e6b0' : t.error < 0.04 ? '#ffb020' : '#ff6a5e';
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - arm, cy);
    ctx.lineTo(cx + arm, cy);
    ctx.moveTo(cx, cy - arm);
    ctx.lineTo(cx, cy + arm);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, arm * 1.6, 0, Math.PI * 2);
    ctx.stroke();
    if (t) {
      // A line from the cross to where the finger was thought to be.
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(t.u * W, t.v * H);
      ctx.stroke();
      text(`${(t.error * 100).toFixed(1)}% · ${Math.round(t.error * widthMm)} mm`, cx, cy + arm * 3.4, 0.011, color, 'center', 600);
    } else text(String(k + 1), cx, cy + arm * 3.4, 0.011, '#5b6675');
  });

  marks.draw(ctx, W, H, now);

  // What it all adds up to.
  const live = now - heardAt < 3000;
  text(live ? 'Lidar page connected' : 'Nothing heard from the lidar page: open /lidar.html on the laptop and keep it visible', W / 2, H * 0.31, 0.014, live ? '#39e6b0' : '#ff6a5e', 'center', 600);
  const done = tried.filter(Boolean);
  if (done.length) {
    const worst = Math.max(...done.map((t) => t.error));
    const typical = Math.sqrt(done.reduce((sum, t) => sum + t.error * t.error, 0) / done.length);
    text(`${done.length} of ${MARKERS.length} crosses tried · typical miss ${(typical * 100).toFixed(1)}% (${Math.round(typical * widthMm)} mm) · worst ${(worst * 100).toFixed(1)}% (${Math.round(worst * widthMm)} mm)`, W / 2, H * 0.36, 0.013, '#e9ecef');
  } else text('Hold a fingertip still on a cross for a second: the ring turns amber and the miss is written under it', W / 2, H * 0.36, 0.013, '#8a94a3');
  const dragging = now - gestureAt < 400;
  text(`drag ${moved[0] >= 0 ? '+' : ''}${(moved[0] * 100).toFixed(0)}%, ${moved[1] >= 0 ? '+' : ''}${(moved[1] * 100).toFixed(0)}% · zoom ×${zoomed.toFixed(2)}${dragging ? (gesture.zoom !== 1 ? ' · two hands' : ' · one hand') : ''}`, W / 2, H * 0.66, 0.012, dragging ? '#5ad1ff' : '#5b6675');
  text('faint ring: seen · white: confirmed · blue: dragging · amber: standing still', W / 2, H * 0.7, 0.011, '#5b6675');

  if (verdict && now > verdict.until) verdict = null;
  if (calibrating || verdict) drawCalibration(ctx, W, H, now, calibrating, verdict);
}

// Thirty frames a second is plenty for rings, and leaves the display's computer idle.
let last = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (now - last < 30) return;
  last = now;
  draw(now);
}
requestAnimationFrame(frame);
window.pageLog?.('running');

// For tests and for poking at from the console.
window.check = { tried, marks, get state() { return { calibrating, verdict, tried: tried.map((t) => t && Number((t.error * 100).toFixed(2))), moved, zoomed }; } };
