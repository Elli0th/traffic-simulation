// Where depth frames come from. Every source has read(), which resolves to { width, height, data }
// with one distance per pixel, or null if no frame is available yet.
//
// SimulatedDepth needs no hardware and is what the tests and rehearsals use. HttpDepth and
// SocketDepth are the starting points for the real camera: adjust `decode` once the room's API is known.

import { solveHomography, applyHomography } from './homography.js';

const SIZES = { 307200: [640, 480], 407040: [848, 480], 921600: [1280, 720], 76800: [320, 240], 230400: [640, 360] };

// A pretend depth camera looking down at a table. It sees the projected image at an angle, with
// noise and dropouts, and sees whatever is listed in `objects`:
//   { x, y, r, h }            a round object at table position (x, y), radius r (fraction of the image
//                             width), h millimetres tall
//   { x, y, x2, y2, r, h }    something long, such as an arm, from (x, y) to (x2, y2)
export class SimulatedDepth {
  constructor({ width = 640, height = 480, aspect = 1.6, seed = 7 } = {}) {
    this.width = width;
    this.height = height;
    this.aspect = aspect; // width / height of the projected image
    this.objects = [];
    this.noise = 2.5; // millimetres
    this.dropouts = 0.003; // share of pixels with no reading
    // Where the corners of the projected image fall in the camera's picture. The detector is never
    // told this; calibration has to work it out.
    const sx = width / 640;
    const sy = height / 480;
    this.corners = [[118 * sx, 64 * sy], [548 * sx, 92 * sy], [566 * sx, 404 * sy], [92 * sx, 428 * sy]];
    this.toCamera = solveHomography([[0, 0], [1, 0], [1, 1], [0, 1]], this.corners);
    const toTable = solveHomography(this.corners, [[0, 0], [1, 0], [1, 1], [0, 1]]);

    // The empty scene: a slightly tilted table 1.5 m below the camera, and the floor beyond its edge.
    this.empty = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [u, v] = applyHomography(toTable, x, y);
        const onTable = u > -0.12 && u < 1.12 && v > -0.12 && v < 1.12;
        this.empty[y * width + x] = onTable ? 1480 + 0.03 * x + 0.02 * y : 2250;
      }
    }
    let a = seed >>> 0;
    this.rand = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Table position -> camera pixel, and the object's radius in pixels there.
  place(x, y, r) {
    const [cx, cy] = applyHomography(this.toCamera, x, y);
    const [ax, ay] = applyHomography(this.toCamera, x + r, y);
    const [bx, by] = applyHomography(this.toCamera, x, y + r * this.aspect);
    return { cx, cy, pr: (Math.hypot(ax - cx, ay - cy) + Math.hypot(bx - cx, by - cy)) / 2 };
  }

  async read() {
    const { width: W, height: H, empty, rand } = this;
    const data = new Uint16Array(W * H);
    const lift = new Float32Array(W * H);
    for (const o of this.objects) {
      const from = this.place(o.x, o.y, o.r);
      const to = o.x2 === undefined ? from : this.place(o.x2, o.y2, o.r);
      const steps = Math.max(1, Math.ceil(Math.hypot(to.cx - from.cx, to.cy - from.cy) / 2));
      for (let s = 0; s <= steps; s++) {
        const cx = from.cx + ((to.cx - from.cx) * s) / steps;
        const cy = from.cy + ((to.cy - from.cy) * s) / steps;
        const pr = from.pr;
        for (let y = Math.max(0, Math.floor(cy - pr)); y <= Math.min(H - 1, Math.ceil(cy + pr)); y++) {
          for (let x = Math.max(0, Math.floor(cx - pr)); x <= Math.min(W - 1, Math.ceil(cx + pr)); x++) {
            if (Math.hypot(x - cx, y - cy) <= pr) lift[y * W + x] = Math.max(lift[y * W + x], o.h ?? 90);
          }
        }
      }
    }
    for (let i = 0; i < data.length; i++) {
      if (rand() < this.dropouts) continue;
      data[i] = Math.round(empty[i] - lift[i] + (rand() + rand() - 1) * this.noise);
    }
    return { width: W, height: H, data };
  }
}

// Turns whatever the server sent into a frame. `format` is 'raw16', 'raw32f', 'json', 'image' or 'auto'.
export async function decode(response, { format = 'auto', width, height } = {}) {
  const type = response.headers.get('content-type') || '';
  if (format === 'auto') format = type.startsWith('image/') ? 'image' : type.includes('json') ? 'json' : 'raw16';

  if (format === 'image') {
    // A picture of the depth (PNG or JPEG). Only 8 bits survive, so heights are in shades, not millimetres.
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const rgba = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const data = new Uint16Array(bitmap.width * bitmap.height);
    for (let i = 0; i < data.length; i++) data[i] = rgba[4 * i];
    return { width: bitmap.width, height: bitmap.height, data };
  }

  if (format === 'json') {
    const body = await response.json();
    let rows = body.data ?? body.depth ?? body.frame ?? body;
    let w = body.width ?? width;
    let h = body.height ?? height;
    if (Array.isArray(rows[0])) {
      h = rows.length;
      w = rows[0].length;
      rows = rows.flat();
    }
    let max = 0;
    for (let i = 0; i < rows.length; i += 97) max = Math.max(max, rows[i]);
    const metres = max > 0 && max < 20; // readings in metres rather than millimetres
    const data = Float32Array.from(rows, (v) => (metres ? v * 1000 : v));
    return { width: w, height: h, data };
  }

  const buffer = await response.arrayBuffer();
  if (format === 'raw32f') {
    const metres = new Float32Array(buffer);
    const [w, h] = width && height ? [width, height] : SIZES[metres.length] || [];
    return w ? { width: w, height: h, data: metres.map((v) => v * 1000) } : null;
  }
  const data = new Uint16Array(buffer, 0, buffer.byteLength >> 1);
  const [w, h] = width && height ? [width, height] : SIZES[data.length] || [];
  return w ? { width: w, height: h, data } : null;
}

// Asks a URL for the latest frame each time.
export class HttpDepth {
  constructor(options) {
    this.options = options; // { url, format, width, height, headers }
  }
  async read() {
    const response = await fetch(this.options.url, { headers: this.options.headers, cache: 'no-store' });
    if (!response.ok) throw new Error(`Depth camera answered ${response.status}`);
    return decode(response, this.options);
  }
}

// Listens to a WebSocket that pushes binary depth frames, and hands out the newest one.
export class SocketDepth {
  constructor(options) {
    this.options = options; // { url, format, width, height }
    this.latest = null;
    this.socket = new WebSocket(options.url);
    this.socket.binaryType = 'arraybuffer';
    this.socket.onmessage = async (event) => {
      const type = typeof event.data === 'string' ? 'application/json' : 'application/octet-stream';
      this.latest = await decode(new Response(event.data, { headers: { 'content-type': type } }), this.options);
    };
  }
  async read() {
    return this.latest;
  }
  close() {
    this.socket.close();
  }
}
