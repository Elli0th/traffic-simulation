// Real-time RPLIDAR C1 touch engine for the projected table.
// Ingests sweeps, extracts hand touch clusters, converts coordinates with projector alignment,
// and maps touches to player actions (Left = Spreader, Right = Curber) with visual ripple feedback.

import { decodeScan, ScanDetector } from './scan.js';
import { applyHomography } from './homography.js';

const MAP_KEY = 'lidar_to_table';
const EMPTY_KEY = 'lidar_empty_table';
const DWELL = 0.6; // seconds a finger or a piece stays put before that counts as a click
const DWELL_WIDTH = 70; // millimetres: wider than this is a hand or an arm resting, which clicks nothing
const DWELL_SLACK = 25; // millimetres it may wander while staying put
const GONE = 300; // milliseconds unseen before a touch has lifted
const TAP_SLACK = 80; // millimetres a tap may slide between touching and lifting

export class LidarTouchController {
  constructor(options = {}) {
    // The second address is the dev server passing the lidar on (/room-lidar in vite.config.js), for a
    // browser that is not allowed to open an address on the local network itself.
    const viaServer = typeof location !== 'undefined' && location.protocol.startsWith('http')
      ? [`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/room-lidar/scan`]
      : [];
    this.urls = options.urls || [
      'ws://192.168.42.24/scan',
      ...viaServer,
      'ws://pi-lidar.local/scan',
      'ws://localhost:8024/scan',
    ];
    const urlParams = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
    const urlYOff = urlParams?.get('yoff') ? Number(urlParams.get('yoff')) : null;
    const urlXOff = urlParams?.get('xoff') ? Number(urlParams.get('xoff')) : null;
    const storedYOff = typeof localStorage !== 'undefined' ? Number(localStorage.getItem('lidar_y_offset') ?? 0) : 0;
    const storedXOff = typeof localStorage !== 'undefined' ? Number(localStorage.getItem('lidar_x_offset') ?? 0) : 0;

    this.yOffset = urlYOff ?? storedYOff;
    this.xOffset = urlXOff ?? storedXOff;
    this.feedbackText = '';
    this.feedbackUntil = 0;

    // Shifted minY/maxY by +100mm (from [50, 950] to [150, 1050]) to correct the 10cm vertical downward desync
    this.tableBounds = options.tableBounds || {
      minX: -720.0,
      maxX: 720.0,
      minY: 150.0,
      maxY: 1050.0,
    };
    // The four-point calibration made on the lidar page (lidar.html), when that page has sent it: it
    // allows for the lidar being turned or off-centre, which the fixed box above cannot. Kept between
    // openings; the box and its nudge keys are what is used until one arrives.
    this.toTable = null;
    try {
      const kept = JSON.parse((typeof localStorage !== 'undefined' && localStorage.getItem(MAP_KEY)) || 'null');
      if (Array.isArray(kept) && kept.length === 9) this.toTable = kept;
    } catch {}
    // The empty table as the lidar page captured it. With it, the same detector as on that page finds
    // what is over the table, so dents and edges it has learned are not mistaken for fingers.
    this.detector = null;
    this.dwell = options.dwell ?? (urlParams?.get('dwell') !== '0');
    try {
      const kept = JSON.parse((typeof localStorage !== 'undefined' && localStorage.getItem(EMPTY_KEY)) || 'null');
      if (kept) this.setEmptyTable(kept.background, kept.margin);
    } catch {}
    this.clusterRadius = options.clusterRadius || 80.0; // mm
    this.minPoints = options.minPoints || 2;
    this.onTap = options.onTap || null; // (side, u, v, screenX, screenY) => void
    this.activeTouches = new Map(); // id -> { id, u, v, side, startTime, x, y }
    this.ws = null;
    this.connected = false;
    this.nextId = 1;
    this.touchRipples = []; // { x, y, r, alpha, color }
    this.clickedAt = []; // where held fingers have just clicked: { x, y, until }

    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', (e) => this.handleKeyCalibration(e));
    }
  }

  handleKeyCalibration(e) {
    if (e.target instanceof HTMLInputElement) return;
    let changed = false;
    if (e.key === '[' || (e.altKey && e.key === 'ArrowDown')) {
      this.yOffset -= 10; // moves projected point 10mm down
      changed = true;
    } else if (e.key === ']' || (e.altKey && e.key === 'ArrowUp')) {
      this.yOffset += 10; // moves projected point 10mm up
      changed = true;
    } else if (e.key === '{' || (e.altKey && e.key === 'ArrowLeft')) {
      this.xOffset -= 10;
      changed = true;
    } else if (e.key === '}' || (e.altKey && e.key === 'ArrowRight')) {
      this.xOffset += 10;
      changed = true;
    }
    if (changed) {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('lidar_y_offset', String(this.yOffset));
        localStorage.setItem('lidar_x_offset', String(this.xOffset));
      }
      this.feedbackText = `Lidar Cal: Y ${this.yOffset >= 0 ? '+' : ''}${this.yOffset}mm | X ${this.xOffset >= 0 ? '+' : ''}${this.xOffset}mm ([ / ] nudge)`;
      this.feedbackUntil = performance.now() + 2500;
      console.log(`[LidarTouch] Calibration updated: Y=${this.yOffset}mm, X=${this.xOffset}mm`);
    }
  }

  // H is the lidar page's homography from its own millimetres (x = r cos a, y = r sin a) to the picture.
  setCalibration(H) {
    if (!Array.isArray(H) || H.length !== 9 || !H.every(Number.isFinite)) return;
    if (!this.toTable) {
      this.feedbackText = 'Lidar: using the calibration from the lidar page';
      this.feedbackUntil = performance.now() + 2500;
    }
    this.toTable = H;
    try { localStorage.setItem(MAP_KEY, JSON.stringify(H)); } catch {}
  }

  // background: [[direction, millimetres], ...] as ScanDetector keeps it; margin in millimetres.
  setEmptyTable(background, margin = 60) {
    if (!Array.isArray(background) || !background.length) return;
    this.detector ||= new ScanDetector();
    this.detector.background = new Map(background);
    this.detector.margin = Number(margin) || 60;
    try { localStorage.setItem(EMPTY_KEY, JSON.stringify({ background, margin })); } catch {}
  }

  // True once taps are placed by the lidar page's calibration and empty table.
  get calibrated() {
    return Boolean(this.toTable && this.detector);
  }

  // Where a point (in this file's millimetres: x = r sin a, y = r cos a) is on the picture, 0 to 1 each way.
  place(x, y) {
    if (this.toTable) return applyHomography(this.toTable, y, x);
    const minX = this.tableBounds.minX + this.xOffset;
    const maxX = this.tableBounds.maxX + this.xOffset;
    const minY = this.tableBounds.minY + this.yOffset;
    const maxY = this.tableBounds.maxY + this.yOffset;
    // Horizontally inverted mapping for ceiling projector alignment:
    return [1.0 - (x - minX) / (maxX - minX), (y - minY) / (maxY - minY)];
  }

  start() {
    this.tryConnect(0);
  }

  stop() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
  }

  tryConnect(index) {
    if (index >= this.urls.length) {
      // Re-try after a few seconds
      setTimeout(() => this.tryConnect(0), 4000);
      return;
    }

    const url = this.urls[index];
    try {
      const socket = new WebSocket(url);
      socket.onopen = () => {
        this.ws = socket;
        this.connected = true;
        console.log(`[LidarTouch] Connected to lidar at ${url}`);
      };

      socket.onmessage = (event) => {
        try {
          const raw = JSON.parse(event.data);
          const scan = decodeScan(raw);
          if (scan) this.processScan(scan);
        } catch {}
      };

      socket.onerror = () => {
        socket.close();
      };

      socket.onclose = () => {
        this.connected = false;
        this.ws = null;
        setTimeout(() => this.tryConnect(index + 1), 1500);
      };
    } catch {
      setTimeout(() => this.tryConnect(index + 1), 1000);
    }
  }

  processScan(scan, now = performance.now()) {
    if (this.calibrated) {
      // The lidar page's way: whatever is nearer than the empty table, on the picture, three sweeps running.
      this.detector.keep = (px, py) => {
        const [u, v] = applyHomography(this.toTable, px, py);
        return u > -0.03 && u < 1.03 && v > -0.03 && v < 1.03;
      };
      const blips = this.detector.steady(this.detector.detect(scan));
      // (This file's x is the lidar page's y, and the other way round.)
      this.updateTouches(blips.map((b) => ({ x: b.y, y: b.x, width: b.width })), now, true);
      return;
    }

    const { angles, ranges } = scan;
    const candidates = [];

    for (let i = 0; i < angles.length; i++) {
      const r = ranges[i];
      if (r <= 0 || r > 2500) continue;
      const a = angles[i];

      // Convert polar (angle, range) to Cartesian (x, y) relative to lidar
      const x = r * Math.sin(a);
      const y = r * Math.cos(a);

      if (this.toTable) {
        // On the picture, or within a few centimetres of its edge.
        const [u, v] = this.place(x, y);
        if (u > -0.03 && u < 1.03 && v > -0.03 && v < 1.03) candidates.push({ x, y });
        continue;
      }

      const minX = this.tableBounds.minX + this.xOffset;
      const maxX = this.tableBounds.maxX + this.xOffset;
      const minY = this.tableBounds.minY + this.yOffset;
      const maxY = this.tableBounds.maxY + this.yOffset;

      // Check if within physical table projection box (with 40mm margin)
      if (
        x >= minX - 40 &&
        x <= maxX + 40 &&
        y >= minY - 40 &&
        y <= maxY + 40
      ) {
        candidates.push({ x, y });
      }
    }

    // Cluster points into discrete hand/finger contacts
    const clusters = this.clusterPoints(candidates);
    this.updateTouches(clusters, now, false);
  }

  clusterPoints(points) {
    const clusters = [];
    const visited = new Uint8Array(points.length);

    for (let i = 0; i < points.length; i++) {
      if (visited[i]) continue;
      const group = [points[i]];
      visited[i] = 1;

      for (let j = i + 1; j < points.length; j++) {
        if (visited[j]) continue;
        const dist = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
        if (dist <= this.clusterRadius) {
          group.push(points[j]);
          visited[j] = 1;
        }
      }

      if (group.length >= this.minPoints) {
        let sumX = 0, sumY = 0;
        for (const p of group) {
          sumX += p.x;
          sumY += p.y;
        }
        clusters.push({
          x: sumX / group.length,
          y: sumY / group.length,
          size: group.length,
        });
      }
    }

    return clusters;
  }

  // Sets where on the picture a touch is, from a point in millimetres.
  aim(touch, x, y) {
    const [u, v] = this.place(x, y);
    touch.u = Math.max(0, Math.min(1, u));
    touch.v = Math.max(0, Math.min(1, v));
    touch.side = touch.u < 0.5 ? 'spreader' : 'curber';
  }

  // `steadied` is true when the clusters have already been seen three sweeps running.
  updateTouches(clusters, now = performance.now(), steadied = false) {
    const matchedClusters = new Set();

    for (const [id, touch] of this.activeTouches.entries()) {
      let closestIdx = -1;
      let closestDist = 120.0; // max track jump mm

      clusters.forEach((c, idx) => {
        if (matchedClusters.has(idx)) return;
        const d = Math.hypot(c.x - touch.x, c.y - touch.y);
        if (d < closestDist) {
          closestDist = d;
          closestIdx = idx;
        }
      });

      if (closestIdx >= 0) {
        matchedClusters.add(closestIdx);
        const c = clusters[closestIdx];
        touch.x = c.x;
        touch.y = c.y;
        touch.lastSeen = now;
        touch.sightings++;
        touch.sumX += c.x;
        touch.sumY += c.y;
        touch.travel = Math.max(touch.travel, Math.hypot(c.x - touch.startX, c.y - touch.startY));
        touch.width = Math.max(touch.width, c.width ?? Infinity);
        this.aim(touch, c.x, c.y);
        // Held still for a moment: a click, there and then. Lifting it afterwards is not another.
        if (this.dwell && !touch.clicked && this.dwelling(touch) && now - touch.startTime >= DWELL * 1000) {
          touch.clicked = true;
          this.aim(touch, touch.sumX / touch.sightings, touch.sumY / touch.sightings);
          this.handleTap(touch);
        }
      } else if (now - touch.lastSeen > GONE) {
        // Gone: a tap if it touched briefly and lifted where it came down. A single stray reading, or
        // an arm sweeping across, is not one.
        const duration = touch.lastSeen - touch.startTime;
        if (!touch.clicked && touch.sightings >= (steadied ? 1 : 3) && duration <= 1000 && touch.travel <= TAP_SLACK) {
          // Where it was on average: the last sighting, as the hand lifts, is the least reliable.
          this.aim(touch, touch.sumX / touch.sightings, touch.sumY / touch.sightings);
          this.handleTap(touch);
        }
        // A finger that has clicked and then drops out of sight for a moment must not click again.
        if (touch.clicked) this.clickedAt.push({ x: touch.x, y: touch.y, until: now + 800 });
        this.activeTouches.delete(id);
      }
    }
    this.clickedAt = this.clickedAt.filter((c) => c.until > now);

    // Add new clusters
    clusters.forEach((c, idx) => {
      if (matchedClusters.has(idx)) return;
      const touch = {
        id: this.nextId++,
        x: c.x,
        y: c.y,
        startX: c.x,
        startY: c.y,
        sumX: c.x,
        sumY: c.y,
        travel: 0,
        width: c.width ?? Infinity,
        clicked: this.clickedAt.some((o) => Math.hypot(o.x - c.x, o.y - c.y) < 60),
        startTime: now,
        lastSeen: now,
        sightings: 1,
      };
      this.aim(touch, c.x, c.y);
      this.activeTouches.set(touch.id, touch);
      // Add visual ripple
      this.addRipple(touch.u * window.innerWidth, touch.v * window.innerHeight, touch.side);
    });
  }

  // Is this touch something narrow that is staying where it came down: a finger, or a piece?
  dwelling(touch) {
    return touch.width <= DWELL_WIDTH && touch.travel <= DWELL_SLACK;
  }

  handleTap(touch) {
    const screenX = touch.u * window.innerWidth;
    const screenY = touch.v * window.innerHeight;

    this.addRipple(screenX, screenY, touch.side, 45);

    if (this.onTap) {
      this.onTap(touch.side, touch.u, touch.v, screenX, screenY);
    }
  }

  addRipple(x, y, side, maxR = 30) {
    this.touchRipples.push({
      x,
      y,
      r: 6,
      maxR,
      alpha: 0.9,
      color: side === 'spreader' ? '#ff3b5c' : '#00e5a3',
    });
  }

  // Draw touch ripple feedback over the table projection
  drawRipples(ctx) {
    if (!ctx) return;
    for (let i = this.touchRipples.length - 1; i >= 0; i--) {
      const rip = this.touchRipples[i];
      rip.r += 1.8;
      rip.alpha -= 0.04;

      if (rip.alpha <= 0) {
        this.touchRipples.splice(i, 1);
        continue;
      }

      ctx.beginPath();
      ctx.arc(rip.x, rip.y, rip.r, 0, Math.PI * 2);
      ctx.strokeStyle = rip.color;
      ctx.lineWidth = 3;
      ctx.globalAlpha = rip.alpha;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(rip.x, rip.y, rip.r * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = rip.color;
      ctx.globalAlpha = rip.alpha * 0.4;
      ctx.fill();
    }
    ctx.globalAlpha = 1.0;

    // Draw active touch halos
    for (const touch of this.activeTouches.values()) {
      const sx = touch.u * window.innerWidth;
      const sy = touch.v * window.innerHeight;
      ctx.beginPath();
      ctx.arc(sx, sy, 18, 0, Math.PI * 2);
      ctx.strokeStyle = touch.side === 'spreader' ? '#ff5c7c' : '#00e5a3';
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.7;
      ctx.stroke();
      // A ring that fills while a finger is held still, and closes as it clicks.
      if (this.dwell && this.dwelling(touch)) {
        const held = touch.clicked ? 1 : Math.min(1, (performance.now() - touch.startTime) / (DWELL * 1000));
        ctx.beginPath();
        ctx.arc(sx, sy, 26, -Math.PI / 2, -Math.PI / 2 + held * Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 4;
        ctx.globalAlpha = touch.clicked ? 0.35 : 0.9;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1.0;
  }

  getBlobs() {
    const list = [];
    for (const touch of this.activeTouches.values()) {
      list.push({ x: touch.u, y: touch.v, r: 0.025 });
    }
    return list;
  }
}
