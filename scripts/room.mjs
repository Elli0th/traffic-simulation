// Puts the installation on the room's displays, and takes it off again. Run it during your slot,
// with the dev server already running:
//
//   npm run room boot            everything for the outbreak game in one go: checks the wifi, the dev
//                                server and the lidar, opens the lidar page, puts the game on the displays
//   npm run room show            table on the projector, 3D view on both TVs
//   npm run room show game       the two-player outbreak game
//   npm run room show draw       light painting instead of the city
//   npm run room show check      the test card on the projector only: calibration circles, rings for
//                                what the lidar registers, crosses to try the calibration against
//   npm run room status          what each display is showing
//   npm run room idle            hand the displays back
//
// ROOM=sim talks to the virtual room (Docker) instead. PAGE=http://address:port overrides the address
// the displays load from, which is otherwise this laptop on the room network, on the port the dev
// server is found on (5203 for npm run live, else 5173). PROJECTOR,
// TV1 and TV2 override a display's address, for example when a port of the virtual room is taken.

import os from 'node:os';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const sim = process.env.ROOM === 'sim';
const DISPLAYS = sim
  ? { projector: 'http://localhost:8021', 'tv-1': 'http://localhost:8022', 'tv-2': 'http://localhost:8023' }
  : { projector: 'http://192.168.42.21', 'tv-1': 'http://192.168.42.22', 'tv-2': 'http://192.168.42.23' };

const given = { projector: process.env.PROJECTOR, 'tv-1': process.env.TV1, 'tv-2': process.env.TV2 };
for (const name of Object.keys(given)) if (given[name]) DISPLAYS[name] = given[name];

function laptop() {
  if (sim) return 'host.docker.internal';
  const all = Object.values(os.networkInterfaces()).flat().filter((a) => a.family === 'IPv4' && !a.internal);
  const found = all.find((a) => a.address.startsWith('192.168.42.')) ?? all[0];
  if (!found) throw new Error('This laptop has no network address. Join the room wifi, or set PAGE.');
  return found.address;
}

async function call(name, path, body, base = DISPLAYS[name]) {
  try {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: body && { 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(body ? 20000 : 5000), // the projector takes its time to answer a change of page
    });
    console.log(`${name.padEnd(10)}${response.status}  ${(await response.text()).slice(0, 200)}`);
  } catch (error) {
    if (!sim && base !== NAMES[name]) return call(name, path, body, NAMES[name]);
    console.log(`${name.padEnd(10)}no answer (${error.cause?.code ?? error.message})`);
  }
}

// The Pis' names, for when a fixed address does not answer. The names resolve slowly on the room wifi.
const NAMES = { projector: 'http://pi-projector.local', 'tv-1': 'http://pi-tv-1.local', 'tv-2': 'http://pi-tv-2.local' };

// The whole start of a slot. Stops at the first thing that is not ready and says what to do about it,
// rather than leaving the displays pointing at a page that cannot load.
async function boot() {
  const step = (ok, text, fix) => {
    console.log(`${ok ? 'ok  ' : 'STOP'} ${text}`);
    if (!ok) {
      console.log(`     ${fix}`);
      process.exit(1);
    }
  };
  const answers = async (url) => {
    try {
      return (await fetch(url, { signal: AbortSignal.timeout(4000) })).ok;
    } catch {
      return false;
    }
  };

  let address = 'localhost';
  if (!sim) {
    const all = Object.values(os.networkInterfaces()).flat().filter((a) => a.family === 'IPv4' && !a.internal);
    const room = all.find((a) => a.address.startsWith('192.168.42.'));
    step(Boolean(room), `on the room network${room ? ` as ${room.address}` : ''}`, 'Join the wifi AID-Hackathon-5G on this laptop, then run this again.');
    address = room.address;
  }

  // The dev server: the live one (npm run live, port 5203) or the ordinary one (npm run dev, 5173).
  let port = Number(process.env.PORT) || 0;
  for (const p of port ? [port] : [5203, 5173]) {
    if (await answers(`http://localhost:${p}/lidar.html`)) {
      port = p;
      break;
    }
    port = 0;
  }
  step(port > 0, `dev server${port ? ` on port ${port}` : ''}`, 'Start it in this folder with: npm run live');

  const lidar = sim ? 'http://localhost:8024' : (process.env.ROOM_LIDAR ?? 'http://192.168.42.24');
  step(await answers(`${lidar}/status`), 'lidar answers', sim ? 'Start the virtual room (Docker).' : 'The lidar is not answering. Check its power and that this laptop is on the room wifi.');

  // The lidar page, in the browser that holds the calibration. It has to stay visible on the laptop.
  const page = `http://localhost:${port}/lidar.html?${sim ? 'url=ws://localhost:8024/scan' : 'room'}`;
  try {
    const brave = '/Applications/Brave Browser.app';
    execFileSync('open', fs.existsSync(brave) ? ['-a', brave, page] : [page]);
    console.log(`ok   lidar page opened: ${page}`);
    console.log('     Keep that window visible. If it does not say "Live", capture the empty table (and calibrate if asked).');
  } catch {
    console.log(`     Open ${page} yourself and keep the window visible.`);
  }

  const base = process.env.PAGE ?? `http://${sim ? 'host.docker.internal' : address}:${port}`;
  await showGame(base);
  console.log('\nWhat the displays say now:');
  for (const name of Object.keys(DISPLAYS)) await call(name, '/status');
}

// The port the dev server is answering on: the live one (npm run live), else the ordinary one.
async function serverPort() {
  if (process.env.PORT) return Number(process.env.PORT);
  for (const port of [5203, 5173]) {
    try {
      if ((await fetch(`http://localhost:${port}/lidar.html`, { signal: AbortSignal.timeout(1500) })).ok) return port;
    } catch {}
  }
  return 5173;
}

// The outbreak game: the table on the projector, and each player's own dashboard on a TV, the
// Spreader's on the left one and the Curber's on the right (the same layout as scripts/room-virus.mjs).
async function showGame(base) {
  await call('projector', '/show', { url: `${base}/?game=table` });
  await call('tv-1', '/show', { url: `${base}/dashboard.html?side=spreader` });
  // tv=2 lets this one follow the player's role in a solo round; the left TV turns to the 3D city by itself.
  await call('tv-2', '/show', { url: `${base}/dashboard.html?side=curber&tv=2` });
}

const [action = 'status', what = ''] = process.argv.slice(2);
if (action === 'boot') {
  await boot();
} else if (action === 'show') {
  const base = process.env.PAGE ?? `http://${laptop()}:${await serverPort()}`;
  if (what === 'check') {
    // Only the projector: the test card is for the table, and the TVs are left as they are.
    await call('projector', '/show', { url: `${base}/check.html` });
  } else if (what === 'game') {
    // The outbreak game keeps its panels: the players press them with hands and pieces.
    await showGame(base);
  } else {
    const page = base + (what === 'draw' ? '/draw.html' : '/');
    const query = what && what !== 'draw' ? [what] : []; // for example map=west
    // The displays have no keyboard, so the panels start hidden.
    await call('projector', '/show', { url: `${page}?${['nohud', ...query].join('&')}` });
    for (const tv of ['tv-1', 'tv-2']) await call(tv, '/show', { url: `${page}?${['view=screen', 'nohud', ...query].join('&')}` });
  }
} else if (action === 'idle' || action === 'blank') {
  for (const name of Object.keys(DISPLAYS)) await call(name, '/show', { [action]: true });
} else if (action === 'status') {
  for (const name of Object.keys(DISPLAYS)) await call(name, '/status');
} else {
  console.log('Usage: npm run room [boot | show [check | game | draw | map=west] | status | idle | blank]');
}
