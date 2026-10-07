// Mouse stand-in for the depth camera: each blob is "an object on the table".
// Left click places one, dragging moves it, clicking an existing one removes it.

export class MouseInput {
  // pick(event) -> {x, z} in metres; radius() -> size of a new blob in metres.
  constructor(el, pick, radius) {
    this.blobs = [];
    let drag = null;
    let fresh = false;
    let start = null;
    let moved = false;

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.shiftKey) return;
      const p = pick(e);
      if (!p) return;
      drag = this.hit(p);
      fresh = !drag;
      if (!drag) {
        drag = { x: p.x, z: p.z, r: radius() };
        this.blobs.push(drag);
      }
      start = { x: e.clientX, y: e.clientY };
      moved = false;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) moved = true;
      const p = moved && pick(e);
      if (p) {
        drag.x = p.x;
        drag.z = p.z;
      }
    });
    el.addEventListener('pointerup', () => {
      if (drag && !fresh && !moved) this.blobs.splice(this.blobs.indexOf(drag), 1);
      drag = null;
    });
  }

  hit(p) {
    return this.blobs.find((b) => Math.hypot(b.x - p.x, b.z - p.z) < b.r);
  }

  clear() {
    this.blobs.length = 0;
  }
}
