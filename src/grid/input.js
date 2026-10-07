// Mouse stand-in for the depth camera: each blob is "an object on the table".
// Click to place, drag to move, click an existing blob to remove, scroll to resize.

export class MouseInput {
  constructor(el, pick, radius = 3) {
    this.blobs = [];
    let drag = null;
    let fresh = false;
    let start = null;
    let moved = false;

    const hit = (p) => this.blobs.find((b) => Math.hypot(b.x - p.x, b.z - p.z) < b.r);

    el.addEventListener('pointerdown', (e) => {
      const p = pick(e);
      if (!p) return;
      drag = hit(p);
      fresh = !drag;
      if (!drag) {
        drag = { x: p.x, z: p.z, r: radius };
        this.blobs.push(drag);
      }
      start = p;
      moved = false;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const p = pick(e);
      if (!p) return;
      if (Math.hypot(p.x - start.x, p.z - start.z) > 0.5) moved = true;
      if (moved) {
        drag.x = p.x;
        drag.z = p.z;
      }
    });
    el.addEventListener('pointerup', () => {
      if (drag && !fresh && !moved) this.blobs.splice(this.blobs.indexOf(drag), 1);
      drag = null;
    });
    el.addEventListener(
      'wheel',
      (e) => {
        const p = pick(e);
        const b = p && hit(p);
        if (!b) return;
        e.preventDefault();
        b.r = Math.max(1.5, Math.min(10, b.r - e.deltaY * 0.01));
      },
      { passive: false },
    );
  }

  clear() {
    this.blobs.length = 0;
  }
}
