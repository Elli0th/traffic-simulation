// Circles on the table that show what the lidar page has registered, so that people can see the
// table noticing them before anything happens:
//
//   seen     a faint ring: something is there, not yet confirmed
//   hover    a white ring: confirmed, waiting to see whether it moves or stays
//   hand     a blue ring with a tail: a hand dragging the map
//   object   an amber ring: it has stood still, and counts as an object
//
// Positions are fractions of the picture, 0 to 1 each way, as the lidar page sends them.

const STYLE = {
  seen: { color: '#ffffff', alpha: 0.35, r: 0.011, width: 2, label: '' },
  hover: { color: '#ffffff', alpha: 0.8, r: 0.015, width: 3, label: '' },
  hand: { color: '#5ad1ff', alpha: 1, r: 0.02, width: 4, label: 'drag' },
  object: { color: '#ffb020', alpha: 1, r: 0.024, width: 4, label: 'object' },
};
const LINGER = 450; // milliseconds a ring takes to fade once its hand has gone

export class TouchMarks {
  constructor() {
    this.marks = [];
  }

  // list: [{ x, y, kind }], several times a second.
  update(list, now = performance.now()) {
    const free = this.marks.slice();
    for (const p of list || []) {
      let best = -1;
      let bestD = 0.1;
      free.forEach((m, k) => {
        const d = Math.hypot(m.tx - p.x, m.ty - p.y);
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      });
      if (best < 0) {
        this.marks.push({ x: p.x, y: p.y, tx: p.x, ty: p.y, kind: p.kind, seen: now, changed: now, trail: [] });
        continue;
      }
      const m = free.splice(best, 1)[0];
      m.tx = p.x;
      m.ty = p.y;
      m.seen = now;
      if (m.kind !== p.kind) {
        m.kind = p.kind;
        m.changed = now;
      }
    }
  }

  draw(ctx, w, h, now = performance.now()) {
    this.marks = this.marks.filter((m) => now - m.seen < LINGER + 150);
    for (const m of this.marks) {
      const style = STYLE[m.kind] || STYLE.seen;
      // Glide to where it was last seen, so the ring does not jump from sweep to sweep.
      m.x += (m.tx - m.x) * 0.3;
      m.y += (m.ty - m.y) * 0.3;
      const fade = Math.max(0, 1 - Math.max(0, now - m.seen - 150) / LINGER);
      const x = m.x * w;
      const y = m.y * h;
      const r = style.r * w * (1 + 0.06 * Math.sin(now / 160));

      if (m.kind === 'hand') {
        m.trail.push(x, y);
        if (m.trail.length > 28) m.trail.splice(0, 2);
        for (let k = 2; k < m.trail.length; k += 2) {
          ctx.globalAlpha = fade * 0.5 * (k / m.trail.length);
          ctx.strokeStyle = style.color;
          ctx.lineWidth = r * 0.5 * (k / m.trail.length);
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(m.trail[k - 2], m.trail[k - 1]);
          ctx.lineTo(m.trail[k], m.trail[k + 1]);
          ctx.stroke();
        }
      } else m.trail.length = 0;

      ctx.globalAlpha = fade * style.alpha * 0.18;
      ctx.fillStyle = style.color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = fade * style.alpha;
      ctx.strokeStyle = style.color;
      ctx.lineWidth = style.width;
      ctx.stroke();

      // A ring that spreads out as it changes from one kind to the next: "noticed", "now dragging".
      const since = (now - m.changed) / 450;
      if (since < 1 && m.kind !== 'seen') {
        ctx.globalAlpha = fade * (1 - since) * 0.8;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, r * (1 + since * 1.6), 0, Math.PI * 2);
        ctx.stroke();
      }
      if (style.label) {
        ctx.globalAlpha = fade * 0.9;
        ctx.fillStyle = style.color;
        ctx.font = `600 ${Math.round(w * 0.011)}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(style.label, x, y + r + w * 0.016);
      }
    }
    ctx.globalAlpha = 1;
  }
}
