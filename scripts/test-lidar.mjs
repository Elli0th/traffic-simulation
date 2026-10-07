// Checks the lidar pipeline against the simulated lidar: learn the empty room, calibrate by touching
// the four markers, then recognise dragging and pinching.
//
//   node scripts/test-lidar.mjs

import assert from 'node:assert/strict';
import { applyHomography } from '../src/room/homography.js';
import { Calibrator, MARKERS } from '../src/room/calibration.js';
import { ScanDetector, Gestures, SimulatedLidar, decodeScan } from '../src/room/scan.js';

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`ok  ${name}`);
};

const lidar = new SimulatedLidar();
const detector = new ScanDetector();
const empty = [];
for (let k = 0; k < 12; k++) empty.push(await lidar.read());
detector.setBackground(empty);
let stray = 0;
for (let k = 0; k < 60; k++) stray += detector.detect(await lidar.read()).length;
check('an empty table shows nothing in 60 sweeps', () => assert.equal(stray, 0));

const calibrator = new Calibrator({ apart: 80, steady: 25 });
for (const [x, y] of MARKERS) {
  lidar.things = [{ x, y, r: 12 }]; // a fingertip on the marker
  let captured = false;
  for (let k = 0; k < 40 && !captured; k++) captured = calibrator.observe(detector.detect(await lidar.read()));
  assert.ok(captured, `marker at ${x}, ${y} was captured`);
}
const calibration = calibrator.result();
check('touching four markers gives a calibration', () => assert.ok(calibration));
const locate = async () => detector.detect(await lidar.read()).map((b) => applyHomography(calibration.toTable, b.x, b.y)).map(([x, y]) => ({ x, y }));

lidar.things = [{ x: 0.3, y: 0.6, r: 12 }, { x: 0.72, y: 0.35, r: 35 }];
const found = await locate();
check('a finger and a cup are placed within 2.5% of the picture width', () => {
  assert.equal(found.length, 2);
  for (const t of lidar.things) assert.ok(found.some((p) => Math.hypot(p.x - t.x, p.y - t.y) < 0.025), `thing at ${t.x}, ${t.y}`);
});

// One hand dragging right while a cup sits still.
let gestures = new Gestures();
let time = 0;
let pan = [0, 0];
let zoom = 1;
let objects = [];
const run = async (frames, place) => {
  for (let k = 0; k < frames; k++) {
    lidar.things = place(k / frames);
    const g = gestures.update(await locate(), (time += 0.08));
    pan = [pan[0] + g.pan[0], pan[1] + g.pan[1]];
    zoom *= g.zoom;
    objects = g.objects;
  }
};
await run(20, () => [{ x: 0.8, y: 0.75, r: 35 }]);
await run(30, (t) => [{ x: 0.8, y: 0.75, r: 35 }, { x: 0.3 + 0.3 * t, y: 0.4, r: 14 }]);
check('a hand dragged 30% of the way across pans the map about that far', () => {
  assert.ok(pan[0] > 0.2 && pan[0] < 0.34, `panned ${pan[0].toFixed(3)}`);
  assert.ok(Math.abs(pan[1]) < 0.03, `drifted ${pan[1].toFixed(3)}`);
  assert.ok(Math.abs(zoom - 1) < 0.02, `zoomed ${zoom.toFixed(3)}`);
});
check('the cup that sat still is reported as an object, not a hand', () => {
  assert.equal(objects.length, 1);
  assert.ok(Math.hypot(objects[0].x - 0.8, objects[0].y - 0.75) < 0.03);
});

// Two hands moving apart.
gestures = new Gestures();
pan = [0, 0];
zoom = 1;
await run(30, (t) => [{ x: 0.42 - 0.17 * t, y: 0.5, r: 14 }, { x: 0.58 + 0.17 * t, y: 0.5, r: 14 }]);
check('two hands spreading from 16% to 50% apart zoom in about threefold', () => {
  assert.ok(zoom > 2.2 && zoom < 3.6, `zoomed ${zoom.toFixed(2)}`);
  assert.ok(Math.hypot(pan[0], pan[1]) < 0.04, `panned ${pan[0].toFixed(3)}, ${pan[1].toFixed(3)}`);
});

// A cup left alone must not move the map.
gestures = new Gestures();
pan = [0, 0];
zoom = 1;
await run(60, () => [{ x: 0.5, y: 0.5, r: 35 }]);
check('a cup standing still for 60 sweeps does not move the map', () => {
  assert.ok(Math.hypot(pan[0], pan[1]) < 0.002 && zoom === 1, `pan ${pan}, zoom ${zoom}`);
});

check('scan messages in other shapes are understood', () => {
  const a = decodeScan({ angle_min: 0, angle_increment: Math.PI / 4, ranges: [1, 2, 1.5] });
  assert.equal(a.ranges[1], 2000);
  const b = decodeScan([{ angle: 0, distance: 1500 }, { angle: 90, distance: 800 }]);
  assert.ok(Math.abs(b.angles[1] - Math.PI / 2) < 1e-6 && b.ranges[1] === 800);
});

console.log(`\n${passed} checks passed`);
