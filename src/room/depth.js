// Finds objects on the table in a depth camera frame.
//
// A frame is { width, height, data }, where data holds one distance per pixel (millimetres from a
// RealSense; 0 means "no reading"). The detector remembers what the empty table looks like and
// reports anything that now stands higher than that.

export class BlobDetector {
  constructor(options = {}) {
    this.minHeight = 15; // an object must rise at least this far above the table (depth units)
    this.maxHeight = 700; // and no more than this (ignores someone leaning right over the camera)
    this.minArea = 40; // pixels; smaller specks are noise
    this.nearIsSmaller = true; // true for real depth; false if the feed is an image where nearer is brighter
    Object.assign(this, options);
    this.background = null;
    this.width = 0;
    this.height = 0;
  }

  get ready() {
    return this.background !== null;
  }

  // Learns the empty table from several frames: the median reading at each pixel, ignoring dropouts.
  setBackground(frames) {
    const { width, height } = frames[0];
    const n = width * height;
    const background = new Float32Array(n);
    const values = [];
    for (let i = 0; i < n; i++) {
      values.length = 0;
      for (const f of frames) if (f.data[i] > 0) values.push(f.data[i]);
      if (!values.length) continue;
      values.sort((a, b) => a - b);
      background[i] = values[values.length >> 1];
    }
    this.background = background;
    this.width = width;
    this.height = height;
    this.seen = new Uint8Array(n); // how many recent frames each pixel has been raised in
    this.mask = new Uint8Array(n);
    this.scratch = new Uint8Array(n);
    this.rise = new Float32Array(n); // height above the table, for the preview
    this.stack = new Int32Array(n);
  }

  // Returns circles in camera pixels: [{ x, y, r, area, height, compact }]. Something long and thin,
  // such as an arm, comes back as a row of circles; `compact` is true for a single round object.
  detect(frame) {
    if (!this.background || frame.width !== this.width || frame.height !== this.height) return [];
    const { width: W, height: H, background, seen, mask, scratch, rise, stack } = this;
    const data = frame.data;
    const n = W * H;

    // 1. Which pixels stand above the table? A pixel must be raised in two of the last three frames,
    //    which removes the flicker a depth camera has around edges.
    for (let i = 0; i < n; i++) {
      const d = data[i];
      const b = background[i];
      const up = d > 0 && b > 0 ? (this.nearIsSmaller ? b - d : d - b) : 0;
      rise[i] = up;
      const raised = up >= this.minHeight && up <= this.maxHeight;
      seen[i] = raised ? Math.min(3, seen[i] + 1) : Math.max(0, seen[i] - 1);
      scratch[i] = seen[i] >= 2 ? 1 : 0;
    }

    // 2. Open the mask (shrink, then grow) to drop specks and thin threads.
    mask.fill(0);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (scratch[i] && scratch[i - 1] && scratch[i + 1] && scratch[i - W] && scratch[i + W]) mask[i] = 1;
      }
    }
    scratch.fill(0);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (mask[i] || mask[i - 1] || mask[i + 1] || mask[i - W] || mask[i + W]) scratch[i] = 1;
      }
    }
    mask.set(scratch);

    // 3. Group touching pixels into objects and measure each one.
    const blobs = [];
    for (let start = 0; start < n; start++) {
      if (scratch[start] !== 1) continue;
      let top = 0;
      stack[top++] = start;
      scratch[start] = 2;
      let area = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, peak = 0;
      while (top) {
        const i = stack[--top];
        const x = i % W;
        const y = (i - x) / W;
        area++;
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
        if (rise[i] > peak) peak = rise[i];
        for (const j of [i - 1, i + 1, i - W, i + W]) {
          if (scratch[j] === 1) {
            scratch[j] = 2;
            stack[top++] = j;
          }
        }
      }
      if (area < this.minArea) continue;
      const mx = sx / area;
      const my = sy / area;
      // Spread along the long and short axes of the shape.
      const cxx = sxx / area - mx * mx;
      const cyy = syy / area - my * my;
      const cxy = sxy / area - mx * my;
      const mid = (cxx + cyy) / 2;
      const span = Math.hypot((cxx - cyy) / 2, cxy);
      const long = Math.max(mid + span, 1e-6);
      const short = Math.max(mid - span, 1e-6);
      const stretch = Math.sqrt(long / short);
      if (stretch < 1.8 || area < this.minArea * 3) {
        blobs.push({ x: mx, y: my, r: Math.sqrt(area / Math.PI), area, height: peak, compact: stretch < 1.6 });
        continue;
      }
      // Long and thin: cover it with a row of circles along its length.
      const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
      const halfLength = Math.sqrt(3 * long);
      const halfWidth = Math.sqrt(3 * short);
      const count = Math.min(6, Math.max(2, Math.round(stretch)));
      for (let k = 0; k < count; k++) {
        const t = (-1 + (2 * k + 1) / count) * (halfLength - halfWidth * 0.5);
        blobs.push({
          x: mx + Math.cos(angle) * t,
          y: my + Math.sin(angle) * t,
          r: halfWidth * 1.15,
          area: area / count,
          height: peak,
          compact: false,
        });
      }
    }
    return blobs;
  }
}

// Steadies the detected objects from frame to frame, so that streets do not flicker open and shut.
// An object must be seen a few frames running before it counts, survives a few missed frames, and
// only moves once it has clearly moved.
export class BlobTracker {
  constructor(options = {}) {
    this.confirm = 3; // frames before a new object counts
    this.forget = 4; // frames an object may go missing before it is dropped
    this.match = 0.06; // how far (in table widths) an object may jump between frames and still be the same one
    this.deadband = 0.004; // movement smaller than this is treated as noise
    Object.assign(this, options);
    this.tracks = [];
  }

  // blobs: [{ x, y, r }] in table coordinates. Returns the steady list in the same form.
  update(blobs) {
    const free = blobs.slice();
    for (const t of this.tracks) {
      let best = -1;
      let bestD = this.match;
      free.forEach((b, k) => {
        const d = Math.hypot(b.x - t.x, b.y - t.y);
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      });
      if (best < 0) {
        t.missed++;
        continue;
      }
      const b = free.splice(best, 1)[0];
      t.x += (b.x - t.x) * 0.5;
      t.y += (b.y - t.y) * 0.5;
      t.r += (b.r - t.r) * 0.5;
      t.seen++;
      t.missed = 0;
    }
    for (const b of free) this.tracks.push({ x: b.x, y: b.y, r: b.r, seen: 1, missed: 0, out: null });
    this.tracks = this.tracks.filter((t) => t.missed <= this.forget);

    const steady = [];
    for (const t of this.tracks) {
      if (t.seen < this.confirm) continue;
      const o = t.out;
      if (!o || Math.hypot(t.x - o.x, t.y - o.y) > this.deadband || Math.abs(t.r - o.r) > o.r * 0.12) {
        t.out = { x: t.x, y: t.y, r: t.r };
      }
      steady.push(t.out);
    }
    return steady;
  }
}
