// Real-time RPLIDAR C1 touch engine for the projected table.
// Ingests sweeps, extracts hand touch clusters, converts coordinates with projector alignment,
// and maps touches to player actions (Left = Spreader, Right = Curber) with visual ripple feedback.
//
// This is the virus-game branch's engine: the table's place in front of the lidar is a fixed box, so
// there is nothing to calibrate (the [ ] { } keys nudge it by 10 mm), and a press counts as
// soon as the finger is down.

import { decodeScan } from './scan.js';

export class LidarTouchController {
  constructor(options = {}) {
    // First the dev server passing the lidar on (/room-lidar in vite.config.js): it knows whether it is
    // pointed at the room or the virtual room, and a browser on the laptop may not be allowed to open an
    // address on the local network itself.
    const viaServer = typeof location !== 'undefined' && location.protocol.startsWith('http')
      ? [`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/room-lidar/scan`]
      : [];
    this.urls = options.urls || [
      ...viaServer,
      'ws://192.168.42.24/scan',
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
    // Where the projected picture is, in millimetres from the lidar: x sideways from its centre, y
    // straight out from it. Measured on the table and given once in the address, it is remembered:
    //   ?box=-720,720,150,1050     left edge, right edge, near edge, far edge of the picture
    // ?lidarmm=1 writes each touch's own x and y beside its ring, and looks 400 mm beyond the box, so
    // a finger put on each corner of the picture reads the four numbers off the table itself.
    const fixed = { minX: -720.0, maxX: 720.0, minY: 150.0, maxY: 1050.0 };
    const asBox = (text) => {
      const n = String(text || '').split(',').map(Number);
      return n.length === 4 && n.every(Number.isFinite) && n[0] < n[1] && n[2] < n[3] ? { minX: n[0], maxX: n[1], minY: n[2], maxY: n[3] } : null;
    };
    const given = asBox(urlParams?.get('box'));
    if (given && typeof localStorage !== 'undefined') localStorage.setItem('lidar_table_box', urlParams.get('box'));
    const kept = typeof localStorage !== 'undefined' ? asBox(localStorage.getItem('lidar_table_box')) : null;
    this.tableBounds = options.tableBounds || given || kept || fixed;
    this.showMm = Boolean(urlParams?.get('lidarmm'));
    this.margin = this.showMm ? 400 : 40; // mm around the box that still counts
    this.clusterRadius = options.clusterRadius || 80.0; // mm
    this.minPoints = options.minPoints || 2;
    // A press counts as soon as the finger is down: when the lidar has seen it in two sweeps running
    // (it sweeps ten times a second, so about 0.1 s after it lands). There is no waiting for the lift
    // and no longest or shortest press. A touch is over once it has gone unseen for one sweep more
    // than the next (120 ms).
    this.gap = options.gap || 120; // ms
    // One press, one click: whatever stays on the table, or flickers in and out of the lidar's sight,
    // has already clicked. It can click again once that spot has been empty for this long.
    this.sameTap = { mm: 80, ms: 600 };
    this.lastTaps = []; // { x, y, at }
    this.onTap = options.onTap || null; // (side, u, v, screenX, screenY) => void
    this.activeTouches = new Map(); // id -> { id, u, v, side, startTime, x, y }
    this.ws = null;
    this.connected = false;
    this.nextId = 1;
    this.touchRipples = []; // { x, y, r, alpha, color }

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

  processScan(scan) {
    const { angles, ranges } = scan;
    const candidates = [];

    for (let i = 0; i < angles.length; i++) {
      const r = ranges[i];
      if (r <= 0 || r > 2500) continue;
      const a = angles[i];

      // Convert polar (angle, range) to Cartesian (x, y) relative to lidar
      const x = r * Math.sin(a);
      const y = r * Math.cos(a);

      const minX = this.tableBounds.minX + this.xOffset;
      const maxX = this.tableBounds.maxX + this.xOffset;
      const minY = this.tableBounds.minY + this.yOffset;
      const maxY = this.tableBounds.maxY + this.yOffset;

      // Check if within physical table projection box (with a margin)
      if (
        x >= minX - this.margin &&
        x <= maxX + this.margin &&
        y >= minY - this.margin &&
        y <= maxY + this.margin
      ) {
        candidates.push({ x, y });
      }
    }

    // Cluster points into discrete hand/finger contacts
    const clusters = this.clusterPoints(candidates);
    this.updateTouches(clusters);
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

  updateTouches(clusters) {
    const now = performance.now();
    const minX = this.tableBounds.minX + this.xOffset;
    const maxX = this.tableBounds.maxX + this.xOffset;
    const minY = this.tableBounds.minY + this.yOffset;
    const maxY = this.tableBounds.maxY + this.yOffset;

    const matchedClusters = new Set();
    const liveTouchIds = new Set();

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

        // Horizontally inverted mapping for ceiling projector alignment:
        const normU = Math.max(0, Math.min(1, 1.0 - (c.x - minX) / (maxX - minX)));
        const normV = Math.max(0, Math.min(1, (c.y - minY) / (maxY - minY)));
        touch.u = normU;
        touch.v = normV;
        touch.side = normU < 0.5 ? 'spreader' : 'curber';
        liveTouchIds.add(id);
      } else {
        // Did not match: over once it has gone unseen for longer than this.gap.
        if (now - touch.lastSeen > this.gap) this.activeTouches.delete(id);
      }
    }

    // Add new clusters
    clusters.forEach((c, idx) => {
      if (!matchedClusters.has(idx)) {
        const normU = Math.max(0, Math.min(1, 1.0 - (c.x - minX) / (maxX - minX)));
        const normV = Math.max(0, Math.min(1, (c.y - minY) / (maxY - minY)));
        const id = this.nextId++;
        const touch = {
          id,
          x: c.x,
          y: c.y,
          u: normU,
          v: normV,
          side: normU < 0.5 ? 'spreader' : 'curber',
          startTime: now,
          lastSeen: now,
          sightings: 1,
          pressed: false,
        };
        this.activeTouches.set(id, touch);
        // Add visual ripple
        this.addRipple(normU * window.innerWidth, normV * window.innerHeight, touch.side);
      }
    });

    // Press: seen twice running, and not the same thing that has already clicked here.
    this.lastTaps = this.lastTaps.filter((t) => now - t.at < this.sameTap.ms);
    for (const touch of this.activeTouches.values()) {
      if (touch.lastSeen !== now) continue;
      const before = this.lastTaps.find((t) => Math.hypot(t.x - touch.x, t.y - touch.y) < this.sameTap.mm);
      if (before) {
        // Still there, or back after a flicker: keep its place taken.
        before.at = now;
        before.x = touch.x;
        before.y = touch.y;
        touch.pressed = true;
      } else if (!touch.pressed && touch.sightings >= 2) {
        touch.pressed = true;
        this.lastTaps.push({ x: touch.x, y: touch.y, at: now });
        this.handleTap(touch);
      }
    }
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
      if (this.showMm) {
        ctx.globalAlpha = 1;
        ctx.font = '600 18px ui-monospace, monospace';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = sx > window.innerWidth / 2 ? 'right' : 'left';
        ctx.fillText(`x ${Math.round(touch.x)}  y ${Math.round(touch.y)} mm`, sx + (sx > window.innerWidth / 2 ? -26 : 26), Math.max(24, Math.min(window.innerHeight - 12, sy + 6)));
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
