// Everything the room shows, rendered on this laptop and streamed to the displays, so that none of
// their own computers (Raspberry Pis) has to run a page. Open /stream.html, choose Traffic or Outbreak
// game, press Start streaming and allow the browser to share this tab.
//
// One window, one click: the window holds three pictures, the table and the two TVs, each a frame
// holding the page that display would otherwise have loaded. The browser's picture of this tab is cut
// into those three and each is sent to its display. The buttons swap what the frames show; only what
// is chosen is loaded, so only that runs. Frames go through the dev server (scripts/frame-relay.mjs)
// to each display's /frames WebSocket as JPEGs: never more than 30 a second for the table, and a
// frame is skipped rather than queued while a display still has two to receive.
//
//   ?tvs=0            the table only; the TVs are left alone
//   ?fps=20           fewer frames a second for the table (30 at most)
//   ?tvfps=12         frames a second for each TV (12 unless said; their dashboards change slowly)
//   ?q=0.6            a fixed JPEG quality; without it the quality and size follow what the wifi carries
//   ?direct           use the displays' /frames/direct (less work for them; plain sRGB only)
//   ?map=west         passed on to the table page
//   ?lights=0         passed on to the table page: the game leaves the room's Hue lights alone

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const fps = Math.min(30, Math.max(1, Number(params.get('fps')) || 30));
const tvFps = Math.min(30, Math.max(1, Number(params.get('tvfps')) || 12));
const tableOnly = params.get('tvs') === '0';
document.body.classList.toggle('table-only', tableOnly);

// ---------- the pictures: what each display's frame holds ----------

// map and lights are the table page's own switches (lights=0 leaves the room's Hue lights alone).
const extra = ['map', 'lights'].filter((k) => params.get(k)).map((k) => `&${k}=${encodeURIComponent(params.get(k))}`).join('');
const PAGES = {
  traffic: { projector: `/?nohud${extra}`, 'tv-1': `/?view=screen&nohud${extra}`, 'tv-2': `/?view=screen&nohud${extra}` },
  // tv=2 lets the right TV follow the player's role in a solo round; the left one turns to the 3D city by itself.
  game: { projector: `/?game=table${extra}`, 'tv-1': '/dashboard.html?side=spreader', 'tv-2': '/dashboard.html?side=curber&tv=2' },
};
// The size each page is laid out at, whatever the size of this window: what the display would give it.
const LAYOUT = { projector: [1280, 800], 'tv-1': [1280, 720], 'tv-2': [1280, 720] };
const KEY = 'tangible-table/stream-mode';

// One per display: its frame on this page, and how its stream is doing.
const senders = [...document.querySelectorAll('.stage')]
  .filter((el) => !tableOnly || el.dataset.display === 'projector')
  .map((el) => {
    const name = el.dataset.display;
    const canvas = document.createElement('canvas');
    return {
      name,
      el,
      frame: el.querySelector('iframe'),
      fps: name === 'projector' ? fps : tvFps,
      target: `/room-frame/${name}${params.has('direct') ? '?direct' : ''}`,
      canvas,
      ctx: canvas.getContext('2d', { alpha: false }),
      last: 0,
      encoding: false,
      inFlight: 0, // frames sent that the display has not yet said it has
      sent: 0,
      bytes: 0,
      rate: 0,
      megabits: 0,
      problem: '',
      // How much picture each frame carries. Both come down when the wifi cannot carry the frames,
      // and back up when it can: a softer picture on time is better than a sharp one late.
      quality: Math.min(0.85, Math.max(0.3, Number(params.get('q')) || 0.7)),
      scale: 1,
    };
  });
const view = senders[0].frame;

function fit() {
  for (const s of senders) {
    const [w, h] = LAYOUT[s.name];
    s.frame.style.width = `${w}px`;
    s.frame.style.height = `${h}px`;
    s.frame.style.transform = `scale(${s.el.clientWidth / w})`;
  }
}
addEventListener('resize', fit);
fit();

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
  if (!PAGES[mode]) return;
  localStorage.setItem(KEY, mode);
  mark(mode);
  // What was shown is unloaded: its simulation, sockets and lights stop with it.
  for (const s of senders) s.frame.src = PAGES[mode][s.name];
}
for (const b of document.querySelectorAll('[data-mode]')) b.addEventListener('click', () => show(b.dataset.mode));
// The table page can also change mode itself (its own switcher, or M): follow it, TVs included.
view.addEventListener('load', () => {
  // The page's own switcher would be part of the picture on the table; the buttons above replace it.
  try {
    const own = view.contentDocument.getElementById('modes');
    if (own) own.style.display = 'none';
  } catch {}
  const mode = shown();
  if (!mode) return;
  if (mode !== localStorage.getItem(KEY)) for (const s of senders.slice(1)) s.frame.src = PAGES[mode][s.name];
  mark(mode);
  localStorage.setItem(KEY, mode);
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

let capture = null; // the browser's picture of this tab
let timer = 0;
let trouble = ''; // why the tab could not be shared

function send(s, now) {
  if (now - s.last < 1000 / s.fps - 2) return;
  // The display still has two to receive, or the last one is still being encoded: this frame is
  // dropped, so the picture never falls behind.
  if (s.encoding || s.inFlight >= 2) return;
  s.last = now;
  // Where this display's picture is in the picture of the tab.
  const box = s.el.getBoundingClientRect();
  const kx = video.videoWidth / innerWidth;
  const ky = video.videoHeight / innerHeight;
  const [fullW, fullH] = LAYOUT[s.name];
  // No more pixels than the tab has for it: a small window gives a soft picture, not a slow one.
  const width = Math.min(fullW, box.width * kx) * s.scale;
  const w = Math.max(2, Math.round(width / 2) * 2);
  const h = Math.max(2, Math.round((width * fullH) / fullW / 2) * 2);
  if (s.canvas.width !== w || s.canvas.height !== h) {
    s.canvas.width = w;
    s.canvas.height = h;
  }
  s.ctx.drawImage(video, box.left * kx, box.top * ky, box.width * kx, box.height * ky, 0, 0, w, h);
  s.encoding = true;
  s.canvas.toBlob(
    async (blob) => {
      s.encoding = false;
      if (!blob || !capture) return;
      s.inFlight++;
      try {
        const answer = await (await fetch(s.target, { method: 'POST', body: blob })).json();
        if (answer.ok) {
          s.sent++;
          s.bytes += blob.size;
          s.problem = '';
        } else if (answer.late) s.problem = ''; // slow, not gone: adapt() sends less picture
        else if (capture) s.problem = answer.why;
      } catch {
        if (capture) s.problem = 'the dev server is not answering';
      } finally {
        s.inFlight--;
      }
    },
    'image/jpeg',
    s.quality,
  );
}

function frame() {
  if (!capture || !video.videoWidth) return;
  const now = performance.now();
  for (const s of senders) send(s, now);
}

// Once a second: is the display getting its frames? If not, send less picture; if so, send more again.
function adapt(s) {
  if (!capture || s.problem || params.has('q')) return;
  if (s.rate < s.fps * 0.9) {
    if (s.quality > 0.4) s.quality = Math.max(0.4, s.quality - 0.08);
    else s.scale = Math.max(0.6, s.scale - 0.1);
  } else if (s.rate >= s.fps * 0.97) {
    if (s.scale < 1) s.scale = Math.min(1, s.scale + 0.05);
    else s.quality = Math.min(0.75, s.quality + 0.02);
  }
}

async function start() {
  if (capture) return;
  trouble = '';
  try {
    capture = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: fps, max: fps }, cursor: 'never' },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
    });
  } catch (error) {
    capture = null;
    trouble = error.name === 'NotAllowedError' ? 'Sharing was not allowed. Press Start streaming and choose this tab.' : `Could not share the tab: ${error.message}`;
    return describe();
  }
  capture.getVideoTracks()[0].addEventListener('ended', stop);
  video.srcObject = capture;
  await video.play().catch(() => {});
  timer = setInterval(frame, 1000 / Math.max(fps, tvFps));
  $('start').hidden = true;
  $('stop').hidden = false;
  describe();
}

function stop() {
  clearInterval(timer);
  for (const track of capture?.getTracks() || []) track.stop();
  capture = null;
  for (const s of senders) s.problem = '';
  fetch('/room-frame-stop', { method: 'POST' }).catch(() => {});
  $('start').hidden = false;
  $('stop').hidden = true;
  describe();
}

function describe() {
  const status = $('status');
  const problems = senders.filter((s) => s.problem);
  if (trouble) status.textContent = trouble;
  else if (!capture) status.textContent = 'Not streaming. Only what is chosen on the left is running.';
  else {
    const total = senders.reduce((sum, s) => sum + s.megabits, 0);
    status.textContent = `${senders.map((s) => (s.problem ? `${s.name}: ${s.problem}` : `${s.name} ${s.rate}/${s.fps}`)).join(' · ')} frames a second · ${total.toFixed(1)} Mbit/s`;
  }
  status.className = trouble || problems.length ? 'bad' : capture ? 'live' : '';
}

$('start').addEventListener('click', start);
$('stop').addEventListener('click', stop);
setInterval(() => {
  for (const s of senders) {
    s.rate = s.sent;
    s.megabits = (s.bytes * 8) / 1e6;
    s.sent = 0;
    s.bytes = 0;
    adapt(s);
  }
  describe();
}, 1000);
addEventListener('keydown', (e) => e.key === 'Escape' && capture && stop());

// For tests and for poking at from the console.
window.stream = {
  start,
  stop,
  show,
  get state() {
    return { streaming: Boolean(capture), mode: shown(), fps, tvFps, trouble, displays: senders.map((s) => ({ name: s.name, rate: s.rate, size: [s.canvas.width, s.canvas.height], quality: s.quality, problem: s.problem })) };
  },
};
