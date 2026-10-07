// Light painting on the table: a hand moving over the surface leaves a glowing ribbon, which starts
// to sway like seaweed and fades after a while. Something that stands still stops painting and
// throws sparks instead.
//
// It listens to the same messages as the traffic table, so the camera and lidar pages work
// unchanged, including calibration. Positions are fractions of the picture, 0 to 1 each way.

import * as relay from '../room/relay.js';

const params = new URLSearchParams(location.search);
const follower = params.get('view') === 'screen'; // a TV: shows what the table paints, takes no input
const LIFE = Number(params.get('life')) || 45; // seconds a ribbon stays after it was drawn
const FADE = 8; // of which the last few are spent fading
const CHUNK = 80; // points per ribbon; a long line is a chain of ribbons, so its start fades first
const STEP = 0.004; // a pen must move this far before it adds a point
const REST = 1.5; // seconds of standing still before a pen counts as an object
// Circles this close, in multiples of their radii, are one arm. Generous, because the circles along
// a long arm do not quite touch; lower it (?reach=1.6) if hands near each other share one line.
const REACH = Number(params.get('reach')) || 2.5;
const LOST = 0.35; // seconds a hand may go unseen before its line ends

const canvas = document.getElementById('paint');
const ctx = canvas.getContext('2d');
const hint = document.getElementById('hint');
let W = 1;
let H = 1;
function resize() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  W = canvas.width = Math.round(innerWidth * dpr);
  H = canvas.height = Math.round(innerHeight * dpr);
}
addEventListener('resize', resize);
resize();
const aspect = () => (W && H ? W / H : 1.6); // a window that is not showing has no size
const now = () => performance.now() / 1000;
// Distance in picture widths, so that it means the same across and down.
const apart = (ax, ay, bx, by) => Math.hypot(ax - bx, (ay - by) / aspect());

// ---------- ribbons ----------

const session = Math.random().toString(36).slice(2, 7);
let strokes = []; // { id, hue, w, pts: [x, y, x, y, …], last, phase }
const byId = new Map();
let sparks = []; // { x, y, vx, vy, born, hue }
let outbox = []; // new points, for the screens
let serial = 0;
let hues = 0;

function newStroke(hue, w, id = `${session}-${serial++}`) {
  const stroke = { id, hue, w, pts: [], last: now(), phase: Math.random() * 6.28 };
  strokes.push(stroke);
  byId.set(id, stroke);
  return stroke;
}

function addPoint(stroke, x, y) {
  if (!follower) outbox.push([stroke.id, stroke.hue, stroke.w, stroke.pts.length, x, y]);
  stroke.pts.push(x, y);
  stroke.last = now();
}

function clear(tell = true) {
  strokes = [];
  byId.clear();
  sparks = [];
  for (const pen of pens.values()) pen.stroke = null;
  if (tell && !follower) relay.send('ink', { clear: true });
}

function spark(x, y, hue, speed = 0.05) {
  if (sparks.length > 600) return;
  const a = Math.random() * 6.28;
  const v = speed * (0.3 + Math.random());
  sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v * aspect(), born: now(), hue });
}

// ---------- pens: one per hand, object or pointer ----------

const pens = new Map(); // key -> { source, x, y, r, hue, stroke, seen, ax, ay, since, resting }
let penSerial = 0;

function addPen(source, x, y, r, key = `${source}-${penSerial++}`) {
  const t = now();
  const pen = { source, x, y, r, hue: (hues++ * 137.5) % 360, stroke: null, seen: t, ax: x, ay: y, since: t, resting: false };
  pens.set(key, pen);
  return pen;
}

function movePen(pen, x, y, smooth) {
  const t = now();
  pen.x += (x - pen.x) * smooth;
  pen.y += (y - pen.y) * smooth;
  pen.seen = t;
  if (apart(pen.x, pen.y, pen.ax, pen.ay) > 0.02) {
    pen.ax = pen.x;
    pen.ay = pen.y;
    pen.since = t;
    pen.resting = false;
  } else if (pen.source !== 'mouse' && t - pen.since > REST) {
    pen.resting = true;
    pen.stroke = null;
  }
  if (pen.resting) return;

  const s = pen.stroke;
  if (!s) {
    pen.stroke = newStroke(pen.hue, Math.max(0.004, Math.min(0.012, pen.r * 0.35)));
    addPoint(pen.stroke, pen.x, pen.y);
    return;
  }
  const n = s.pts.length;
  if (apart(pen.x, pen.y, s.pts[n - 2], s.pts[n - 1]) < STEP) return;
  addPoint(s, pen.x, pen.y);
  if (Math.random() < 0.5) spark(pen.x, pen.y, s.hue);
  if (s.pts.length >= CHUNK * 2) {
    // Carry on in a new ribbon from the same point, a little further round the colour wheel.
    pen.hue = (pen.hue + 12) % 360;
    pen.stroke = newStroke(pen.hue, s.w);
    addPoint(pen.stroke, pen.x, pen.y);
  }
}

// What a sensor page sees is circles: a cup is one, an arm is a row of them. Paint with the end of
// the arm only: the circle furthest from where the arm comes in over the edge of the picture.
function tips(list) {
  const group = list.map((_, i) => i);
  const find = (i) => (group[i] === i ? i : (group[i] = find(group[i])));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (apart(a.x, a.y, b.x, b.y) < (a.r + b.r) * REACH) group[find(i)] = find(j);
    }
  }
  const inward = (b) => Math.min(b.x, 1 - b.x, b.y, 1 - b.y);
  const groups = new Map();
  list.forEach((b, i) => groups.set(find(i), [...(groups.get(find(i)) || []), b]));
  return [...groups.values()].map((members) => {
    const root = members.reduce((a, b) => (inward(b) < inward(a) ? b : a));
    return members.reduce((a, b) => (apart(b.x, b.y, root.x, root.y) > apart(a.x, a.y, root.x, root.y) ? b : a));
  });
}

// A hand that has not been seen for a moment is gone, and its line ends.
function dropLost() {
  const t = now();
  for (const [key, pen] of pens) if (pen.source !== 'mouse' && t - pen.seen > LOST) pens.delete(key);
}

function feed(source, list) {
  dropLost();
  const free = tips(list);
  // Pair each hand with the pen it was last time, nearest pairs first, so that two hands passing
  // close to each other keep their own lines.
  const pairs = [];
  for (const pen of pens.values()) {
    if (pen.source !== source) continue;
    for (const b of free) {
      const d = apart(b.x, b.y, pen.x, pen.y);
      if (d < 0.12) pairs.push({ pen, b, d });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  const taken = new Set();
  for (const { pen, b } of pairs) {
    if (taken.has(pen) || taken.has(b)) continue;
    taken.add(pen).add(b);
    free.splice(free.indexOf(b), 1);
    pen.r = b.r;
    movePen(pen, b.x, b.y, 0.6);
  }
  for (const b of free) movePen(addPen(source, b.x, b.y, b.r), b.x, b.y, 1);
}

// ---------- the room ----------

let calibrating = null; // the calibration circle to show

if (follower) {
  relay.on('ink', (m) => {
    if (m.clear) clear(false);
    // Each point says where in its ribbon it goes, because messages can arrive twice.
    for (const [id, hue, w, i, x, y] of m.add || []) {
      const stroke = byId.get(id) || newStroke(hue, w, id);
      stroke.pts[i] = x;
      stroke.pts[i + 1] = y;
      stroke.last = now();
    }
  });
} else {
  relay.on('blobs', (m) => (Array.isArray(m) ? feed('depth', m) : feed(m.from, m.list)));
  relay.on('calibrate', (m) => {
    calibrating = m.index >= 0 ? m : null;
  });
  relay.on('who', () => relay.send('hello', { aspect: aspect() }));
  relay.send('hello', { aspect: aspect() });

  // Mouse and touch stand in for hands when rehearsing.
  const at = (e) => [e.clientX / innerWidth, e.clientY / innerHeight];
  canvas.addEventListener('pointerdown', (e) => {
    const [x, y] = at(e);
    movePen(addPen('mouse', x, y, 0.02, `mouse-${e.pointerId}`), x, y, 1);
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const pen = pens.get(`mouse-${e.pointerId}`);
    if (pen) movePen(pen, ...at(e), 1);
  });
  const lift = (e) => pens.delete(`mouse-${e.pointerId}`);
  canvas.addEventListener('pointerup', lift);
  canvas.addEventListener('pointercancel', lift);
}

addEventListener('keydown', (e) => {
  if (e.key === 'c' && !follower) clear();
  if (e.key === 'f') document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
});

// ---------- drawing ----------

function trace(s, t, sway) {
  const p = s.pts;
  const px = (i) => p[i] * W + sway * Math.sin(t * 1.1 + i * 0.22 + s.phase);
  const py = (i) => p[i + 1] * H + sway * Math.cos(t * 0.9 + i * 0.19 + s.phase * 1.7);
  ctx.beginPath();
  ctx.moveTo(px(0), py(0));
  if (p.length === 2) ctx.lineTo(px(0) + 0.01, py(0));
  // Curve through the midpoints, so that the line has no corners.
  for (let i = 2; i < p.length - 2; i += 2) ctx.quadraticCurveTo(px(i), py(i), (px(i) + px(i + 2)) / 2, (py(i) + py(i + 2)) / 2);
  if (p.length > 2) ctx.lineTo(px(p.length - 2), py(p.length - 2));
}

let before = now();
function frame() {
  const t = now();
  const dt = Math.min(0.1, t - before);
  before = t;

  dropLost();
  strokes = strokes.filter((s) => t - s.last < LIFE || (byId.delete(s.id), false));
  sparks = sparks.filter((s) => t - s.born < 1.2);
  if (outbox.length) {
    relay.send('ink', { add: outbox });
    outbox = [];
  }
  hint.classList.toggle('off', strokes.length > 0 || Boolean(calibrating));

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  if (calibrating) {
    // The circle to put an object on. Nothing else, so that the sensor page sees only that object.
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(calibrating.x * W, calibrating.y * H, W * (0.02 + 0.004 * Math.sin(t * 5)), 0, 6.3);
    ctx.fill();
    requestAnimationFrame(frame);
    return;
  }

  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = ctx.lineJoin = 'round';
  for (const s of strokes) {
    const age = t - s.last;
    const alpha = Math.min(1, (LIFE - age) / FADE);
    trace(s, t, Math.min(1, age / 6) * 0.005 * W);
    ctx.strokeStyle = `hsl(${s.hue} 100% 55%)`;
    ctx.globalAlpha = alpha * 0.16;
    ctx.lineWidth = s.w * W * 3.2;
    ctx.stroke();
    ctx.globalAlpha = alpha * 0.9;
    ctx.lineWidth = s.w * W;
    ctx.stroke();
    ctx.strokeStyle = `hsl(${s.hue} 100% 88%)`;
    ctx.globalAlpha = alpha * 0.8;
    ctx.lineWidth = s.w * W * 0.3;
    ctx.stroke();
  }

  for (const s of sparks) {
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    ctx.globalAlpha = 1 - (t - s.born) / 1.2;
    ctx.fillStyle = `hsl(${s.hue} 100% 75%)`;
    ctx.beginPath();
    ctx.arc(s.x * W, s.y * H, W * 0.0018, 0, 6.3);
    ctx.fill();
  }

  // A ring where each hand or object is seen, so people can tell the table has noticed them.
  for (const pen of pens.values()) {
    if (pen.resting && Math.random() < 0.4) spark(pen.x, pen.y, (pen.hue + t * 60) % 360, 0.09);
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = `hsl(${pen.hue} 100% 70%)`;
    ctx.lineWidth = W * 0.002;
    ctx.beginPath();
    ctx.arc(pen.x * W, pen.y * H, W * (pen.resting ? 0.022 + 0.004 * Math.sin(t * 4) : 0.014), 0, 6.3);
    ctx.stroke();
  }

  requestAnimationFrame(frame);
}
frame();

// For tests and for poking at from the console: the same hooks as the traffic table.
window.table = { setBlobs: (list) => feed('code', list), clear, strokes: () => strokes, pens: () => pens };
