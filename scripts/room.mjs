// Puts the installation on the room's displays, and takes it off again. Run it during your slot,
// with the dev server already running:
//
//   npm run room show            table on the projector, 3D view on both TVs
//   npm run room show draw       light painting instead of the city
//   npm run room status          what each display is showing
//   npm run room idle            hand the displays back
//
// ROOM=sim talks to the virtual room (Docker) instead. PAGE=http://address:port overrides the address
// the displays load from, which is otherwise this laptop on the room network, port 5173. PROJECTOR,
// TV1 and TV2 override a display's address, for example when a port of the virtual room is taken.

import os from 'node:os';

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
      signal: AbortSignal.timeout(5000),
    });
    console.log(`${name.padEnd(10)}${response.status}  ${(await response.text()).slice(0, 200)}`);
  } catch (error) {
    if (!sim && base !== NAMES[name]) return call(name, path, body, NAMES[name]);
    console.log(`${name.padEnd(10)}no answer (${error.cause?.code ?? error.message})`);
  }
}

// The Pis' names, for when a fixed address does not answer. The names resolve slowly on the room wifi.
const NAMES = { projector: 'http://pi-projector.local', 'tv-1': 'http://pi-tv-1.local', 'tv-2': 'http://pi-tv-2.local' };

const [action = 'status', what = ''] = process.argv.slice(2);
if (action === 'show') {
  const page = (process.env.PAGE ?? `http://${laptop()}:5173`) + (what === 'draw' ? '/draw.html' : '/');
  const query = what && what !== 'draw' ? [what] : []; // for example map=west
  // The displays have no keyboard, so the panels start hidden.
  await call('projector', '/show', { url: `${page}?${['nohud', ...query].join('&')}` });
  for (const tv of ['tv-1', 'tv-2']) await call(tv, '/show', { url: `${page}?${['view=screen', 'nohud', ...query].join('&')}` });
} else if (action === 'idle' || action === 'blank') {
  for (const name of Object.keys(DISPLAYS)) await call(name, '/show', { [action]: true });
} else if (action === 'status') {
  for (const name of Object.keys(DISPLAYS)) await call(name, '/status');
} else {
  console.log('Usage: npm run room [show [draw | map=west] | status | idle | blank]');
}
