// Checks the depth camera pipeline end to end against the simulated camera:
// learn the empty table, calibrate with an object on each marker, then find objects and place them.
//
//   node scripts/test-depth.mjs

import assert from 'node:assert/strict';
import { solveHomography, applyHomography } from '../src/room/homography.js';
import { BlobDetector, BlobTracker } from '../src/room/depth.js';
import { Calibrator, MARKERS, toTable } from '../src/room/calibration.js';
import { SimulatedDepth } from '../src/room/sources.js';

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`ok  ${name}`);
};

for (const size of [[640, 480], [848, 480], [1280, 720]]) {
  const [width, height] = size;
  console.log(`\n${width} x ${height}`);
  const camera = new SimulatedDepth({ width, height });
  const detector = new BlobDetector({ minArea: Math.round(40 * (width / 640) ** 2) });
  const frames = async (n) => {
    let blobs = [];
    for (let k = 0; k < n; k++) blobs = detector.detect(await camera.read());
    return blobs;
  };

  // The empty table.
  const empty = [];
  for (let k = 0; k < 15; k++) empty.push(await camera.read());
  detector.setBackground(empty);
  let stray = 0;
  for (let k = 0; k < 60; k++) stray += detector.detect(await camera.read()).length;
  check('an empty table shows no objects in 60 frames', () => assert.equal(stray, 0));

  // Calibration: a cup on each marker in turn, moved by a hand that comes and goes.
  const calibrator = new Calibrator();
  for (const [x, y] of MARKERS) {
    camera.objects = [{ x, y, r: 0.028, h: 95 }, { x, y: y + 0.02, x2: x, y2: 1.2, r: 0.03, h: 120 }];
    for (let k = 0; k < 8; k++) calibrator.observe(detector.detect(await camera.read())); // hand still there
    camera.objects = [{ x, y, r: 0.028, h: 95 }];
    let captured = false;
    for (let k = 0; k < 40 && !captured; k++) captured = calibrator.observe(detector.detect(await camera.read()));
    assert.ok(captured, `marker at ${x}, ${y} was captured`);
  }
  const calibration = calibrator.result();
  check('four markers give a calibration', () => assert.ok(calibration));
  check('the calibration puts the image corners within 0.6% of the truth', () => {
    for (const [k, [u, v]] of [[0, 0], [1, 0], [1, 1], [0, 1]].entries()) {
      const [x, y] = applyHomography(calibration.toTable, ...camera.corners[k]);
      assert.ok(Math.hypot(x - u, y - v) < 0.006, `corner ${k} is off by ${Math.hypot(x - u, y - v).toFixed(4)}`);
    }
  });

  // Finding objects.
  const truth = [
    { x: 0.3, y: 0.4, r: 0.03, h: 90 },
    { x: 0.7, y: 0.25, r: 0.05, h: 60 },
    { x: 0.55, y: 0.8, r: 0.02, h: 150 },
  ];
  camera.objects = truth;
  const tracker = new BlobTracker();
  let steady = [];
  let changes = 0;
  let previous = '';
  for (let k = 0; k < 120; k++) {
    steady = tracker.update(toTable(detector.detect(await camera.read()), calibration.toTable, camera.aspect));
    const now = JSON.stringify(steady);
    if (k > 10 && now !== previous) changes++;
    previous = now;
  }
  check('three objects are found', () => assert.equal(steady.length, 3));
  check('each is within 1% of the image width of where it really is, and the right size', () => {
    for (const t of truth) {
      const found = steady.find((b) => Math.hypot(b.x - t.x, b.y - t.y) < 0.01);
      assert.ok(found, `object at ${t.x}, ${t.y}`);
      assert.ok(Math.abs(found.r - t.r) / t.r < 0.25, `radius ${found.r.toFixed(4)} for ${t.r}`);
    }
  });
  check('still objects do not jitter (no change in 110 frames)', () => assert.equal(changes, 0));

  // Things that should not count, and things that should.
  camera.objects = [{ x: 0.5, y: 0.5, r: 0.08, h: 4 }];
  const paper = await frames(12);
  check('a sheet of paper is ignored', () => assert.equal(paper.length, 0));

  camera.objects = [{ x: 0.5, y: 0.55, x2: 0.5, y2: 1.15, r: 0.03, h: 120 }];
  const arm = toTable(await frames(12), calibration.toTable, camera.aspect);
  check('an arm reaching in becomes a row of circles along it', () => {
    assert.ok(arm.length >= 3, `${arm.length} circles`);
    for (const b of arm) assert.ok(Math.abs(b.x - 0.5) < 0.03, `circle at x ${b.x.toFixed(3)}`);
    assert.ok(Math.min(...arm.map((b) => b.y)) < 0.68 && Math.max(...arm.map((b) => b.y)) > 0.9);
  });

  camera.objects = [];
  await frames(6);
  let gone = tracker.update([]);
  for (let k = 0; k < 6; k++) gone = tracker.update([]);
  check('objects disappear once lifted off', () => assert.equal(gone.length, 0));
}

check('homography round trip', () => {
  const from = [[10, 20], [600, 40], [580, 470], [30, 440], [300, 250]];
  const H = [1.1, 0.2, 5, -0.1, 0.9, 12, 0.0004, 0.0002, 1];
  const to = from.map(([x, y]) => applyHomography(H, x, y));
  const solved = solveHomography(from, to);
  for (const [x, y] of [[100, 100], [500, 300]]) {
    const [a, b] = applyHomography(H, x, y);
    const [c, d] = applyHomography(solved, x, y);
    assert.ok(Math.hypot(a - c, b - d) < 1e-6);
  }
  assert.equal(solveHomography([[0, 0], [1, 1], [2, 2], [3, 3]], [[0, 0], [1, 0], [1, 1], [0, 1]]), null);
});

console.log(`\n${passed} checks passed`);
