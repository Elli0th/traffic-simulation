// Controls room displays and Philips Hue lights for the Outbreak Game installation:
// - Projector (192.168.42.21): The two-player split-view table game (?game)
// - TV 1 (192.168.42.22): Spreader Tactical Dashboard (/dashboard.html?side=spreader)
// - TV 2 (192.168.42.23): Curber Public Health Dashboard (/dashboard.html?side=curber)
// - Philips Hue (192.168.42.11): Reactive infection lighting
//
// Usage:
//   node scripts/room-virus.mjs show
//   node scripts/room-virus.mjs idle
//   node scripts/room-virus.mjs status

import { networkInterfaces } from 'node:os';

const ROOM_ENV = process.env.ROOM_ENV === 'sim' ? 'sim' : 'real';
const HOSTS = {
  projector: ROOM_ENV === 'sim' ? 'http://localhost:8021' : 'http://192.168.42.21',
  tv1: ROOM_ENV === 'sim' ? 'http://localhost:8022' : 'http://192.168.42.22',
  tv2: ROOM_ENV === 'sim' ? 'http://localhost:8023' : 'http://192.168.42.23',
  hue: ROOM_ENV === 'sim' ? 'http://localhost:8011' : 'http://192.168.42.11',
};
const HUE_USER = 'ckwwi95MBr7z3fnL-CwSbtfmlfOtjmLK9fGPPkCu';

function getLocalIp() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        if (net.address.startsWith('192.168.42.')) return net.address;
      }
    }
  }
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

const LOCAL_IP = getLocalIp();
const PORT = process.env.PORT || 5173;

async function postJson(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

async function showAll() {
  const streamMode = !process.argv.includes('--no-stream');
  const tableUrl = `http://${LOCAL_IP}:${PORT}/?game=table`;
  const tv1Url = `http://${LOCAL_IP}:${PORT}/dashboard.html?side=spreader`;
  const tv2Url = `http://${LOCAL_IP}:${PORT}/dashboard.html?side=curber`;

  console.log(`Setting up Outbreak Room Installation:`);
  console.log(`  Projector -> ${streamMode ? 'WebSocket Stream from Laptop (ws://192.168.42.21/frames)' : tableUrl}`);
  console.log(`  TV 1 (Spreader) -> ${tv1Url}`);
  console.log(`  TV 2 (Curber)   -> ${tv2Url}`);

  const displayTasks = [
    postJson(`${HOSTS.tv1}/show`, { url: tv1Url }),
    postJson(`${HOSTS.tv2}/show`, { url: tv2Url }),
  ];

  if (!streamMode) {
    displayTasks.unshift(postJson(`${HOSTS.projector}/show`, { url: tableUrl }));
  }

  const results = await Promise.all(displayTasks);
  console.log(`\nDisplays updated:`, streamMode ? { tv1: results[0], tv2: results[1] } : results);
}

async function idleAll() {
  console.log(`Resetting room displays to idle...`);
  const [pRes, t1Res, t2Res] = await Promise.all([
    postJson(`${HOSTS.projector}/show`, { blank: true }),
    postJson(`${HOSTS.tv1}/show`, { idle: true }),
    postJson(`${HOSTS.tv2}/show`, { idle: true }),
  ]);
  console.log(`Displays set to idle:`, { projector: pRes, tv1: t1Res, tv2: t2Res });

  // Restore Hue lights
  console.log(`Restoring Philips Hue to neutral...`);
  const neutral = { on: true, bri: 140, ct: 350, transitiontime: 10 };
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8]) {
    try {
      await fetch(`${HOSTS.hue}/api/${HUE_USER}/lights/${id}/state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(neutral),
      });
    } catch {}
  }
  console.log(`Room restored.`);
}

async function statusAll() {
  for (const [name, host] of Object.entries(HOSTS)) {
    try {
      const res = await fetch(`${host}/status`);
      const data = await res.json();
      console.log(`${name} (${host}):`, data);
    } catch (e) {
      console.log(`${name} (${host}): error ${e.message}`);
    }
  }
}

const command = process.argv[2] || 'show';
if (command === 'show') {
  await showAll();
} else if (command === 'idle') {
  await idleAll();
} else if (command === 'status') {
  await statusAll();
} else {
  console.log(`Unknown command '${command}'. Use show, idle, or status.`);
}
