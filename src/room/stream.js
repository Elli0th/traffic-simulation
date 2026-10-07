// The table rendered on this laptop and streamed to a display, for when the display's own computer
// is too slow to run it. Open /stream.html, choose Traffic or Outbreak game, press Start streaming
// and allow the browser to share this tab.
//
// One window, one stream: the picture is a frame holding the table page, and the buttons swap what
// that frame shows. Only the one chosen is loaded, so only that one runs. The stream carries on
// across the swap. Frames go to the display's /frames WebSocket as JPEGs, never more than 30 a
// second, and a frame is skipped rather than queued if the last one has not left yet.
//
//   ?display=tv-1     which display (projector by default); passed on by the dev server
//   ?to=ws://…        a WebSocket address to send to instead
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
const target =
  params.get('to') ||
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/room-display/${display}/frames${params.has('direct') ? '/direct' : ''}`;
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
let socket = null;
let retryAt = 0;
let timer = 0;
let encoding = false;
let sent = 0;
let skipped = 0;
let rate = 0;
let problem = '';

function connect(now) {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  if (now < retryAt) return;
  retryAt = now + 1000; // a display that is not answering is tried once a second, not once a frame
  const opened = (socket = new WebSocket(target));
  opened.binaryType = 'arraybuffer';
  opened.onopen = () => (problem = '');
  opened.onclose = () => {
    if (socket === opened && capture) problem = `No connection to the ${display}. Trying again…`;
  };
}

function frame() {
  const now = performance.now();
  connect(now);
  if (!capture || !video.videoWidth) return;
  // Still sending or encoding the last one: this frame is dropped, so the picture never falls behind.
  if (encoding || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 0) {
    skipped++;
    return;
  }
  ctx.drawImage(video, 0, 0, W, H);
  encoding = true;
  canvas.toBlob(
    (blob) => {
      encoding = false;
      if (!blob || !capture || socket.readyState !== WebSocket.OPEN) return;
      socket.send(blob);
      sent++;
    },
    'image/jpeg',
    0.75,
  );
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
  socket?.close();
  socket = null;
  document.body.classList.remove('bare');
  $('start').hidden = false;
  $('stop').hidden = true;
  describe();
}

function describe() {
  const status = $('status');
  if (problem) status.textContent = problem;
  else if (!capture) status.textContent = 'Not streaming. Only what is chosen on the left is running.';
  else status.textContent = `Streaming to the ${display}: ${rate} frames a second, ${W} × ${H}${skipped ? ` (the display is keeping up with ${Math.round((100 * rate) / fps)}%)` : ''}`;
  status.className = problem ? 'bad' : capture ? 'live' : '';
}

$('start').addEventListener('click', start);
$('stop').addEventListener('click', stop);
setInterval(() => {
  rate = sent;
  sent = 0;
  describe();
  skipped = 0;
}, 1000);
// In a browser without cropping the bar is hidden while streaming: Escape stops and brings it back.
addEventListener('keydown', (e) => e.key === 'Escape' && capture && stop());

// For tests and for poking at from the console.
window.stream = { start, stop, show, get state() { return { streaming: Boolean(capture), mode: shown(), target, fps, size: [W, H], rate, problem }; } };
