// Checks the game's tap touch (src/room/lidar-touch.js) against the simulated lidar, once it has the
// lidar page's calibration and empty table: taps, held fingers, and the things that must not click.
//
//   node scripts/test-touch.mjs

import assert from 'node:assert/strict';
import { Calibrator, MARKERS } from '../src/room/calibration.js';
import { ScanDetector, SimulatedLidar } from '../src/room/scan.js';

globalThis.window = { innerWidth: 1920, innerHeight: 1200, addEventListener() {} };
const { LidarTouchController } = await import('../src/room/lidar-touch.js');

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`ok  ${name}`);
};

// What the lidar page does first: learn the empty table (with a dent in it), then calibrate.
const lidar = new SimulatedLidar();
const dent = { x: 0.97, y: 0.5, r: 6 }; // at the edge: whatever lies behind a dent, seen from the lidar, is hidden by it
lidar.things = [dent];
const detector = new ScanDetector();
const empty = [];
for (let k = 0; k < 30; k++) empty.push(await lidar.read());
detector.setBackground(empty);
const calibrator = new Calibrator({ apart: 80, steady: 25 });
for (const [x, y] of MARKERS) {
  lidar.things = [dent, { x, y, r: 12 }];
  let captured = false;
  for (let k = 0; k < 40 && !captured; k++) captured = calibrator.observe(detector.detect(await lidar.read()));
  assert.ok(captured, `marker at ${x}, ${y} was captured`);
}
const { toTable } = calibrator.result();

// A fresh controller with what the lidar page sends, fed sweeps a tenth of a second apart.
let taps = [];
let clock = 0;
let touch;
const fresh = (options) => {
  taps = [];
  touch = new LidarTouchController({ onTap: (side, u, v) => taps.push({ side, u, v, at: clock }), ...options });
  touch.setCalibration(toTable);
  touch.setEmptyTable([...detector.background], 60);
};
const sweeps = async (things, count) => {
  for (let k = 0; k < count; k++) {
    lidar.things = [dent, ...(typeof things === 'function' ? things(k) : things)];
    touch.processScan(await lidar.read(), (clock += 100));
  }
};
const near = (tap, x, y, slack = 0.025) => Math.hypot(tap.u - x, (tap.v - y) / 1.6) < slack;

fresh();
await sweeps([], 50);
check('an empty table with a dent in it clicks nothing', () => assert.equal(taps.length, 0));

fresh();
await sweeps([{ x: 0.3, y: 0.6, r: 9 }], 4);
await sweeps([], 5);
check('a finger that touches and lifts is one tap, within 2.5% of where it touched', () => {
  assert.equal(taps.length, 1);
  assert.ok(near(taps[0], 0.3, 0.6), `tapped at ${taps[0].u.toFixed(3)}, ${taps[0].v.toFixed(3)}`);
  assert.equal(taps[0].side, 'spreader');
});

fresh();
await sweeps([{ x: 0.8, y: 0.4, r: 9 }], 1);
await sweeps([], 6);
check('a single stray reading is not a tap', () => assert.equal(taps.length, 0));

fresh();
const started = clock;
await sweeps([{ x: 0.75, y: 0.7, r: 9 }], 30);
check('a finger held still clicks once, within a second, without lifting', () => {
  assert.equal(taps.length, 1);
  assert.ok(taps[0].at - started <= 1000, `clicked after ${taps[0].at - started} ms`);
  assert.ok(near(taps[0], 0.75, 0.7));
  assert.equal(taps[0].side, 'curber');
});
await sweeps([], 6);
check('lifting it afterwards is not a second click', () => assert.equal(taps.length, 1));

fresh();
await sweeps((k) => [{ x: 0.2 + k * 0.03, y: 0.5, r: 9 }], 12);
await sweeps([], 6);
check('a finger sliding across the table clicks nothing', () => assert.equal(taps.length, 0));

fresh();
await sweeps([{ x: 0.5, y: 0.8, r: 60 }], 30);
await sweeps([], 6);
check('a hand or arm resting on the table clicks nothing', () => assert.equal(taps.length, 0));

fresh();
await sweeps([{ x: 0.3, y: 0.6, r: 9 }, { x: 0.7, y: 0.3, r: 9 }], 4);
await sweeps([], 5);
check('two players tapping at once are two taps, one on each side', () => {
  assert.equal(taps.length, 2);
  assert.deepEqual(taps.map((t) => t.side).sort(), ['curber', 'spreader']);
});

fresh({ dwell: false });
await sweeps([{ x: 0.75, y: 0.7, r: 9 }], 30);
check('with the hold switched off, a held finger clicks nothing', () => assert.equal(taps.length, 0));

console.log(`\n${passed} checks passed`);
