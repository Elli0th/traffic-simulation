// Works out where the projected image sits in the depth camera's picture.
//
// The table shows a glowing circle at nine known places in turn, three rows of three. Someone puts
// an object on each circle; the sensor sees where that object is in its own picture. Four such pairs
// would be enough to convert any sensor position into a position on the projected image; nine even
// out a fingertip put down a little off the mark, and how well they agree says how good the result is.

import { solveHomography, applyHomography, isConvexQuad } from './homography.js';

// Where the circles appear, as fractions of the projected image (x across, y down).
// They go back and forth across the picture, so the hand never has far to move to the next one.
export const MARKERS = [
  [0.15, 0.15], [0.5, 0.15], [0.85, 0.15],
  [0.85, 0.5], [0.5, 0.5], [0.15, 0.5],
  [0.15, 0.85], [0.5, 0.85], [0.85, 0.85],
];
const CORNERS = [0, 2, 8, 6]; // of those, the four corners, going round

export class Calibrator {
  // `apart` and `steady` are in the sensor's own units: pixels for the depth camera, millimetres for
  // the lidar. A new position must be `apart` from those already taken, and hold within `steady`.
  constructor({ apart = 30, steady = 2.5 } = {}) {
    this.apart = apart;
    this.steady = steady;
    this.points = []; // camera pixel positions captured so far, one per marker
    this.still = 0;
    this.last = null;
    this.candidates = 0; // how many objects it could see last frame, apart from those already captured
  }

  // Which marker should be showing: 0 to 8, or 9 when all are captured.
  get step() {
    return this.points.length;
  }

  // Feed it the objects detected in each frame (camera pixels). When a single round object has sat
  // still for ten frames, its position is taken for the current marker. Returns true on the frame a
  // point is captured.
  observe(blobs) {
    if (this.step >= MARKERS.length) return false;
    // Everything in view apart from the objects already captured. There must be exactly one, and it
    // must be round: a hand still holding it makes a long shape, or a second one.
    const fresh = blobs.filter((b) => this.points.every(([x, y]) => Math.hypot(b.x - x, b.y - y) > this.apart));
    this.candidates = fresh.length;
    if (fresh.length !== 1 || !fresh[0].compact) {
      this.still = 0;
      this.last = null;
      return false;
    }
    const b = fresh[0];
    this.still = this.last && Math.hypot(b.x - this.last.x, b.y - this.last.y) < this.steady ? this.still + 1 : 0;
    this.last = b;
    if (this.still < 10) return false;
    this.capture(b.x, b.y);
    return true;
  }

  // Takes a position for the current marker directly (a click in the camera preview).
  capture(x, y) {
    if (this.step >= MARKERS.length) return;
    this.points.push([x, y]);
    this.still = 0;
    this.last = null;
  }

  undo() {
    this.points.pop();
    this.still = 0;
    this.last = null;
  }

  // The finished calibration, or null if the points cannot be right (crossed over or in a line).
  // `fit` says how well the nine agree with it: how far each lands from its own circle, as a share
  // of the picture's width (`aspect` is the picture's width divided by its height).
  result(aspect = 1.6) {
    if (this.points.length < MARKERS.length || !isConvexQuad(CORNERS.map((k) => this.points[k]))) return null;
    const toTable = solveHomography(this.points, MARKERS);
    const toCamera = solveHomography(MARKERS, this.points);
    if (!toTable || !toCamera) return null;
    const off = this.points.map(([x, y], k) => {
      const [u, v] = applyHomography(toTable, x, y);
      return Math.hypot(u - MARKERS[k][0], (v - MARKERS[k][1]) / aspect);
    });
    const fit = { off, worst: Math.max(...off), typical: Math.sqrt(off.reduce((sum, e) => sum + e * e, 0) / off.length) };
    return { toTable, toCamera, fit };
  }
}

// Converts detected circles from camera pixels to table coordinates: x and y from 0 to 1 across the
// projected image, r as a fraction of its width, h its height above the table in the camera's depth
// units. `aspect` is the image's width divided by its height.
// Anything clearly off the image is dropped.
export function toTable(blobs, H, aspect = 1.6) {
  const out = [];
  for (const b of blobs) {
    const [x, y] = applyHomography(H, b.x, b.y);
    if (x < -0.03 || x > 1.03 || y < -0.03 || y > 1.03) continue;
    // Measure the radius both ways across the picture, since the camera may be turned relative to the table.
    const [ax, ay] = applyHomography(H, b.x + b.r, b.y);
    const [bx, by] = applyHomography(H, b.x, b.y + b.r);
    const r = (Math.hypot(ax - x, (ay - y) / aspect) + Math.hypot(bx - x, (by - y) / aspect)) / 2;
    out.push({ x, y, r, h: b.height });
  }
  return out;
}
