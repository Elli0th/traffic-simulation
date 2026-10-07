// The table rendered on this laptop and streamed to a display, for when the display's own computer
// is too slow to run it. Open /stream.html, choose Traffic or Outbreak game, press Start streaming
// and allow the browser to share this tab.
//
// One window, one stream: the picture is a frame holding the table page, and the buttons swap what
// that frame shows. Only the one chosen is loaded, so only that one runs. The stream carries on
// across the swap. Frames go to the display's /frames WebSocket as JPEGs, never more than 30 a
// second, and a frame is skipped rather than queued while the display still has two to receive.
//
//   ?display=tv-1     which display (projector by default); passed on by the dev server
//   ?q=0.6            a fixed JPEG quality; without it the quality and size follow what the wifi carries
//   ?fps=20           fewer frames a second
//   ?size=1920x1200   the size of the frames sent (1280 wide by default)
//   ?direct           use the display's /frames/direct (less work for it; plain sRGB only)
//   ?map=west         passed on to the table page
//   ?lights=0         passed on to the table page: the game leaves the room's Hue lights alone

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const display = params.get('display') || 'projector';
const fps = Math.min(30, Math.max(1, Number(params.get('fps')) || 30));
const SHAPES = { projector: 1920 / 1200, 'tv-1': 16 / 9, 'tv-2': 16 / 9 };
const shape = SHAPES[display] || 1.6;
const [W, H] = params.get('size')?.split('x').map(Number).filter(Boolean).length === 2
  ? params.get('size').split('x').map(Number)
  : [1280, Math.round(1280 / shape)];
// Frames go through the dev server (scripts/frame-relay.mjs), which holds the display's WebSocket and
// answers each frame once the display has received it.
const target = `/room-frame/${display}${params.has('direct') ? '?direct' : ''}`;
document.documentElement.style.setProperty('--shape', String(shape));

// ---------- what is shown: one of the two, never both ----------

const view = $('view');
// map and lights are the table page's own switches (lights=0 leaves the room's Hue lights alone).
const extra = ['map', 'lights'].filter((k) => params.get(k)).map((k) => `&${k}=${encodeURIComponent(params.get(k))}`).join('');
const MODES = { traffic: `/?nohud${extra}`, game: `/?game=table${extra}` };
const KEY = 'tangible-table/stream-mode';

function shown() {
  try {
    return new URLSearchParams(view.contentWindow.location.search).has('game') ? 'game' : 'traffic';
  } catch {
    return null;
  }
}
function mark(mode) {
  for (const b of document.querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === mode);
}
function show(mode) {
  if (!MODES[mode]) return;
  localStorage.setItem(KEY, mode);
  mark(mode);
  view.src = MODES[mode]; // the other one is unloaded: its simulation, sockets and lights stop with it
}
for (const b of document.querySelectorAll('[data-mode]')) b.addEventListener('click', () => show(b.dataset.mode));
// The table page can also change mode itself (its own switcher, or M): follow it.
view.addEventListener('load', () => {
  // The page's own switcher would be part of the picture on the table; the buttons above replace it.
  try {
    const own = view.contentDocument.getElementById('modes');
    if (own) own.style.display = 'none';
  } catch {}
  const mode = shown();
  if (mode) {
    mark(mode);
    localStorage.setItem(KEY, mode);
  }
});
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 't') show('traffic');
  if (e.key === 'g') show('game');
});
show(params.get('mode') || localStorage.getItem(KEY) || 'traffic');

// ---------- the stream ----------

const video = document.createElement('video');
video.muted = true;
video.playsInline = true;
const canvas = document.createElement('canvas');
canvas.width = W;
canvas.height = H;
const ctx = canvas.getContext('2d', { alpha: false });

let capture = null; // the browser's picture of this tab
let timer = 0;
let encoding = false;
let inFlight = 0; // frames sent that the display has not yet said it has
let sent = 0;
let bytes = 0;
let skipped = 0;
let rate = 0;
let megabits = 0;
let problem = '';
// How much picture each frame carries. Both come down when the wifi cannot carry 30 frames a second,
// and back up when it can: a softer picture on time is better on the table than a sharp one late.
let quality = Math.min(0.85, Math.max(0.3, Number(params.get('q')) || 0.7));
let scale = 1;

function frame() {
  if (!capture || !video.videoWidth) return;
  // The display still has two to receive, or the last one is still being encoded: this frame is
  // dropped, so the picture never falls behind.
  if (encoding || inFlight >= 2) {
    skipped++;
    return;
  }
  const w = Math.round((W * scale) / 2) * 2;
  const h = Math.round((H * scale) / 2) * 2;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.drawImage(video, 0, 0, w, h);
  encoding = true;
  canvas.toBlob(
    async (blob) => {
      encoding = false;
      if (!blob || !capture) return;
      inFlight++;
      try {
        const answer = await (await fetch(target, { method: 'POST', body: blob })).json();
        if (answer.ok) {
          sent++;
          bytes += blob.size;
          problem = '';
        } else if (capture) problem = `${answer.why[0].toUpperCase()}${answer.why.slice(1)}. Trying again…`;
      } catch {
        if (capture) problem = 'The dev server is not answering.';
      } finally {
        inFlight--;
      }
    },
    'image/jpeg',
    quality,
  );
}

// Once a second: is the display getting its frames? If not, send less picture; if so, send more again.
function adapt() {
  if (!capture || problem || params.has('q')) return;
  if (rate < fps * 0.9) {
    if (quality > 0.4) quality = Math.max(0.4, quality - 0.08);
    else scale = Math.max(0.6, scale - 0.1);
  } else if (rate >= fps * 0.97) {
    if (scale < 1) scale = Math.min(1, scale + 0.05);
    else quality = Math.min(0.75, quality + 0.02);
  }
}

async function start() {
  if (capture) return;
  problem = '';
  try {
    capture = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: fps, max: fps }, cursor: 'never' },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
    });
  } catch (error) {
    capture = null;
    problem = error.name === 'NotAllowedError' ? 'Sharing was not allowed. Press Start streaming and choose this tab.' : `Could not share the tab: ${error.message}`;
    return describe();
  }
  const track = capture.getVideoTracks()[0];
  track.addEventListener('ended', stop);
  // Send only the picture, not the bar above it. Where the browser cannot crop, the bar goes away instead.
  try {
    if (!window.CropTarget || !track.cropTo) throw new Error('no cropping');
    await track.cropTo(await window.CropTarget.fromElement($('stage')));
  } catch {
    document.body.classList.add('bare');
  }
  video.srcObject = capture;
  await video.play().catch(() => {});
  timer = setInterval(frame, 1000 / fps);
  $('start').hidden = true;
  $('stop').hidden = false;
  describe();
}

function stop() {
  clearInterval(timer);
  for (const track of capture?.getTracks() || []) track.stop();
  capture = null;
  fetch('/room-frame-stop', { method: 'POST' }).catch(() => {});
  document.body.classList.remove('bare');
  $('start').hidden = false;
  $('stop').hidden = true;
  describe();
}

function describe() {
  const status = $('status');
  if (problem) status.textContent = problem;
  else if (!capture) status.textContent = 'Not streaming. Only what is chosen on the left is running.';
  else status.textContent = `Streaming to the ${display}: ${rate} of ${fps} frames a second, ${canvas.width} × ${canvas.height}, quality ${Math.round(quality * 100)}, ${megabits.toFixed(1)} Mbit/s`;
  status.className = problem ? 'bad' : capture ? 'live' : '';
}

$('start').addEventListener('click', start);
$('stop').addEventListener('click', stop);
setInterval(() => {
  rate = sent;
  megabits = (bytes * 8) / 1e6;
  sent = 0;
  bytes = 0;
  adapt();
  describe();
  skipped = 0;
}, 1000);
// In a browser without cropping the bar is hidden while streaming: Escape stops and brings it back.
addEventListener('keydown', (e) => e.key === 'Escape' && capture && stop());

// For tests and for poking at from the console.
window.stream = { start, stop, show, get state() { return { streaming: Boolean(capture), mode: shown(), target, fps, size: [W, H], rate, problem }; } };
