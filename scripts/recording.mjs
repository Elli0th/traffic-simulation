// Summarises a recording made by scripts/recorder.mjs: what is in it, and whether it is usable.
//
//   node scripts/recording.mjs recordings/2026-10-08_10-15-00.jsonl

import fs from 'node:fs';
import readline from 'node:readline';

const file = process.argv[2];
if (!file) {
  console.log('Usage: node scripts/recording.mjs recordings/<file>.jsonl');
  process.exit(1);
}
const kinds = new Map();
let first = 0;
let last = 0;
let meta = null;
const clicks = [];
const calibrations = [];
const gaps = [];
let lastSweep = 0;
let readings = 0;
for await (const line of readline.createInterface({ input: fs.createReadStream(file) })) {
  if (!line) continue;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue; // a line cut short when the server stopped
  }
  first ||= e.t;
  last = e.t;
  kinds.set(e.k, (kinds.get(e.k) || 0) + 1);
  if (e.k === 'meta') meta = e;
  if (e.k === 'sweep') {
    if (lastSweep && e.t - lastSweep > 500) gaps.push([lastSweep - first, e.t - lastSweep]);
    lastSweep = e.t;
    readings += e.a?.length || 0;
  }
  if (e.k === 'relay:record' && e.d?.what === 'click') clicks.push(e.d);
  if (e.k === 'relay:record' && e.d?.what === 'calibration') calibrations.push(e);
}
const seconds = (last - first) / 1000;
console.log(`${file}`);
if (meta) console.log(`  started ${meta.started}, code at: ${meta.commit}`);
console.log(`  ${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s, ${[...kinds.values()].reduce((a, b) => a + b, 0)} lines`);
for (const [k, n] of [...kinds].sort((p, q) => q[1] - p[1])) console.log(`  ${String(n).padStart(8)}  ${k}`);
const sweeps = kinds.get('sweep') || 0;
if (sweeps) console.log(`  lidar: ${(sweeps / seconds).toFixed(1)} sweeps a second, ${Math.round(readings / sweeps)} readings a sweep, ${gaps.length} gaps longer than half a second`);
else console.log('  lidar: no sweeps recorded (the server could not reach it)');
console.log(`  clicks on the table: ${clicks.length} (${clicks.filter((c) => c.kind === 'tap').length} taps, ${clicks.filter((c) => c.kind === 'hold').length} holds)`);
console.log(`  calibrations made: ${calibrations.length}`);
