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
//   ?via=video        send video instead of JPEG frames: each display plays it in /watch.html (see
//                     watch.js). Sharper and far lighter on the wifi; the displays must be showing
//                     that page (npm run room video).
//   ?tvs=0            the table only; the TVs are left alone
//   ?fps=20           fewer frames a second for the table (30 at most)
//   ?tvfps=8          frames a second for each TV (8 unless said; their dashboards change slowly, and a
//                     TV picture that has not changed is not sent again)
//   ?res=1920         JPEG frames for the table never narrower than this (1280 unless said, 1920 at most):
//                     on a slow wifi the table then gets fewer frames a second, not fewer pixels
//   ?q=0.6            a fixed JPEG quality; without it the quality and size follow what the wifi carries
//   ?direct           use the displays' /frames/direct (less work for them; plain sRGB only)
//   ?map=west         passed on to the table page
//   ?lights=0         passed on to the table page: the game leaves the room's Hue lights alone
//   ?box=…  ?lidarmm=1  passed on to the game: where the picture is for the lidar (see lidar-touch.js)

import * as relay from './relay.js';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const fps = Math.min(30, Math.max(1, Number(params.get('fps')) || 30));
const tvFps = Math.min(30, Math.max(1, Number(params.get('tvfps')) || 8));
const tableOnly = params.get('tvs') === '0';
const viaVideo = params.get('via') === 'video';
// The least picture a JPEG frame carries, as a share of the full size: below this the page gives up
// frames a second instead. A blurred table is worse than one that moves a little less smoothly.
const floorScale = (name) => (name === 'projector' ? Math.min(1920, Math.max(960, Number(params.get('res')) || 1280)) / 1920 : 0.75);
const FLOOR_QUALITY = 0.62;
document.body.classList.toggle('table-only', tableOnly);

// ---------- the pictures: what each display's frame holds ----------

// map and lights are the table page's own switches (lights=0 leaves the room's Hue lights alone).
const extra = ['map', 'lights', 'box', 'lidarmm'].filter((k) => params.get(k)).map((k) => `&${k}=${encodeURIComponent(params.get(k))}`).join('');
const PAGES = {
  traffic: { projector: `/?nohud${extra}`, 'tv-1': `/?view=screen&nohud${extra}`, 'tv-2': `/?view=screen&nohud${extra}` },
  // tv=2 lets the right TV follow the player's role in a solo round; the left one turns to the 3D city by itself.
  // pr=1.5: the game drawn at the projector's full 1920 x 1200 (see main.js).
  game: { projector: `/?game=table&pr=1.5${extra}`, 'tv-1': '/dashboard.html?side=spreader', 'tv-2': '/dashboard.html?side=curber&tv=2' },
};
// The size each page is laid out at, whatever the size of this window: what the display would give it.
const LAYOUT = { projector: [1280, 800], 'tv-1': [1280, 720], 'tv-2': [1280, 720] };
// The most picture sent to each display: the projector's own 1920 x 1200. A TV's picture is a third of
// this window at best, so more than 1280 across would be pixels the tab does not have.
const SEND = { projector: [1920, 1200], 'tv-1': [1280, 720], 'tv-2': [1280, 720] };
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
      quality: Math.min(0.9, Math.max(0.3, Number(params.get('q')) || 0.75)),
      // JPEG frames start at two thirds (1280 across for the table) and grow if the wifi carries it.
      scale: viaVideo ? 1 : floorScale(name),
      frames: !viaVideo, // sending JPEG frames; with ?via=video only if the video connection fails
      thumb: null, // a TV's last picture, very small, to tell whether it has changed
      thumbAt: 0,
      pc: null, // the video connection, with ?via=video
      stream: null,
      size: [0, 0],
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
let startedAt = 0;

// Cuts this display's picture out of the picture of the tab, into its canvas.
function cut(s) {
  const box = s.el.getBoundingClientRect();
  const kx = video.videoWidth / innerWidth;
  const ky = video.videoHeight / innerHeight;
  const [fullW, fullH] = SEND[s.name];
  // No more pixels than the tab has for it: a small window gives a soft picture, not a slow one.
  const width = Math.min(fullW, box.width * kx) * s.scale;
  const w = Math.max(2, Math.round(width / 2) * 2);
  const h = Math.max(2, Math.round((width * fullH) / fullW / 2) * 2);
  if (s.canvas.width !== w || s.canvas.height !== h) {
    s.canvas.width = w;
    s.canvas.height = h;
  }
  s.ctx.imageSmoothingQuality = 'high';
  s.ctx.drawImage(video, box.left * kx, box.top * ky, box.width * kx, box.height * ky, 0, 0, w, h);
}

// A TV dashboard mostly stands still. Its picture is compared, sixteen pixels across, with the last
// one sent; if nothing has changed it is not sent again, bar once every two seconds for a display
// that has just been taken back from something else.
const tiny = document.createElement('canvas');
tiny.width = 32;
tiny.height = 18;
const tinyCtx = tiny.getContext('2d', { willReadFrequently: true });
function unchanged(s, now) {
  tinyCtx.drawImage(s.canvas, 0, 0, 32, 18);
  const data = tinyCtx.getImageData(0, 0, 32, 18).data;
  let same = Boolean(s.thumb) && now - s.thumbAt < 2000;
  if (same) for (let i = 0; i < data.length; i += 4) if (Math.abs(data[i] - s.thumb[i]) + Math.abs(data[i + 1] - s.thumb[i + 1]) + Math.abs(data[i + 2] - s.thumb[i + 2]) > 12) { same = false; break; }
  if (same) return true;
  s.thumb = data;
  s.thumbAt = now;
  return false;
}

function send(s, now) {
  if (now - s.last < 1000 / s.fps - 2) return;
  // Video: the canvas is the source of the connection's track; drawing on it is sending.
  if (!s.frames) {
    s.last = now;
    return cut(s);
  }
  // The display still has two to receive, or the last one is still being encoded: this frame is
  // dropped, so the picture never falls behind.
  if (s.encoding || s.inFlight >= 2) return;
  s.last = now;
  cut(s);
  if (s.name !== 'projector' && unchanged(s, now)) return;
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

// Once a second, for JPEG frames: is the display getting them? If not, send less picture: fewer
// pixels down to the floor, then a rougher JPEG down to its floor, and after that nothing more is
// taken away: the frames a second drop instead. If so, send more again. (Video does this by itself.)
function adapt(s) {
  if (!s.frames || !capture || s.problem || params.has('q')) return;
  const floor = floorScale(s.name);
  // A TV that sends nothing because nothing changed is not a slow TV.
  const slow = s.name === 'projector' ? s.rate < s.fps * 0.9 : s.inFlight >= 2;
  if (slow) {
    if (s.scale > floor) s.scale = Math.max(floor, s.scale - 0.11);
    else if (s.quality > FLOOR_QUALITY) s.quality = Math.max(FLOOR_QUALITY, s.quality - 0.05);
  } else if (s.name !== 'projector' || s.rate >= s.fps * 0.97) {
    if (s.quality < 0.8) s.quality = Math.min(0.8, s.quality + 0.03);
    else s.scale = Math.min(1, s.scale + 0.05);
  }
}

// ---------- video: one connection to each display's /watch.html ----------

const tell = (to, data) => relay.send('rtc', { to, from: 'sender', ...data });

async function offer(s) {
  s.pc?.close();
  cut(s); // the canvas has its size before the track starts
  s.stream ||= s.canvas.captureStream(s.fps);
  const track = s.stream.getVideoTracks()[0];
  track.contentHint = 'detail'; // text and thin lines: keep them sharp, give up frames first
  const pc = (s.pc = new RTCPeerConnection());
  pc.born = performance.now();
  const sender = pc.addTransceiver(track, {
    direction: 'sendonly',
    sendEncodings: [{ maxBitrate: s.name === 'projector' ? 12e6 : 4e6, maxFramerate: s.fps }],
  });
  // H.264 first: the laptop encodes it and a Raspberry Pi decodes it in hardware. The rest stay as a fallback.
  try {
    const codecs = RTCRtpSender.getCapabilities('video').codecs;
    sender.setCodecPreferences([...codecs.filter((c) => c.mimeType === 'video/H264'), ...codecs.filter((c) => c.mimeType !== 'video/H264')]);
  } catch {}
  pc.onicecandidate = (e) => e.candidate && tell(s.name, { candidate: e.candidate.toJSON() });
  pc.onconnectionstatechange = () => {
    if (s.pc !== pc) return;
    s.problem = pc.connectionState === 'failed' ? 'no video connection' : '';
  };
  await pc.setLocalDescription(await pc.createOffer());
  tell(s.name, { sdp: pc.localDescription.toJSON() });
}

relay.on('rtc', async (m) => {
  if (!viaVideo || m.to !== 'sender' || !capture) return;
  const s = senders.find((x) => x.name === m.from);
  if (!s || s.frames) return;
  if (m.ready) {
    // A display that says it is ready while a connection is being made is left to finish it.
    const state = s.pc?.connectionState;
    if (state === 'connected' || ((state === 'new' || state === 'connecting') && performance.now() - s.pc.born < 6000)) return;
    await offer(s);
  } else if (m.sdp) await s.pc?.setRemoteDescription(m.sdp).catch(() => {});
  else if (m.candidate) await s.pc?.addIceCandidate(m.candidate).catch(() => {});
});

// Once a second: what each connection is really sending.
async function measure(s) {
  // No video after eight seconds (no watch page on the display, or the browser will not connect to it
  // directly): that display gets JPEG frames instead, which need nothing from it.
  if (s.pc?.connectionState !== 'connected' && performance.now() - startedAt > 8000) {
    s.frames = true;
    s.scale = floorScale(s.name);
    s.pc?.close();
    s.pc = null;
    s.problem = '';
    return;
  }
  if (!s.pc) return void (s.problem ||= 'waiting for its watch page');
  for (const r of (await s.pc.getStats()).values()) {
    if (r.type !== 'outbound-rtp' || r.kind !== 'video') continue;
    s.rate = Math.round(r.framesPerSecond || 0);
    s.megabits = ((r.bytesSent - (s.bytesBefore ?? r.bytesSent)) * 8) / 1e6;
    s.bytesBefore = r.bytesSent;
    s.size = [r.frameWidth || 0, r.frameHeight || 0];
  }
  if (s.pc.connectionState === 'connected') s.problem = '';
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
  startedAt = performance.now();
  if (viaVideo) for (const s of senders) tell(s.name, { hello: true }); // the watch pages answer that they are ready
  $('start').hidden = true;
  $('stop').hidden = false;
  describe();
}

function stop() {
  clearInterval(timer);
  for (const track of capture?.getTracks() || []) track.stop();
  capture = null;
  for (const s of senders) {
    s.problem = '';
    if (s.pc) tell(s.name, { bye: true });
    s.pc?.close();
    s.pc = null;
    s.frames = !viaVideo;
  }
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
    const size = (s) => (s.frames ? [s.canvas.width, s.canvas.height] : s.size).join('×');
    status.textContent = `${senders.map((s) => (s.problem ? `${s.name}: ${s.problem}` : `${s.name} ${s.frames ? 'frames' : 'video'} ${s.rate}/${s.fps} at ${size(s)}`)).join(' · ')} · ${total.toFixed(1)} Mbit/s`;
  }
  status.className = trouble || problems.length ? 'bad' : capture ? 'live' : '';
}

$('start').addEventListener('click', start);
$('stop').addEventListener('click', stop);
setInterval(() => {
  for (const s of senders) {
    if (!s.frames) {
      if (capture) measure(s).catch(() => {});
      continue;
    }
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
    return { streaming: Boolean(capture), mode: shown(), via: viaVideo ? 'video' : 'frames', fps, tvFps, trouble, displays: senders.map((s) => ({ name: s.name, rate: s.rate, megabits: s.megabits, size: [s.canvas.width, s.canvas.height], quality: s.quality, connection: s.pc?.connectionState, problem: s.problem })) };
  },
};
