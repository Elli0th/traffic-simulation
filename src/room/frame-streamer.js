// WebSocket frame streamer for the room projector.
// Offloads the rendering and simulation from the Raspberry Pi to the host laptop by streaming the
// rendered canvas to ws://192.168.42.21/frames as binary JPEGs, 30 frames a second.
//
// The JPEG encoding and the socket live in a worker (frame-worker.js) so the game's own thread is not
// held up by them. Without Worker/OffscreenCanvas support it falls back to encoding on the main thread.

export class FrameStreamer {
  constructor(options = {}) {
    this.url = options.url || 'ws://192.168.42.21/frames';
    this.targetFps = options.targetFps || 30;
    this.quality = options.quality || 0.75; // JPEG quality recommended by room API (70-80)
    this.width = options.width || 1280;
    this.height = options.height || 800; // 16:10 aspect ratio matching 1920x1200
    this.enabled = options.enabled ?? true;

    this.ws = null;
    this.worker = null;
    this.connected = false;
    this.sending = false;
    this.lastFrameTime = 0;
    // Frames arrive from a loop capped at 30 FPS, so ask for slightly under a full gap: otherwise a frame
    // that lands 0.1 ms early is skipped and the stream silently drops to 15.
    this.minInterval = (1000 / this.targetFps) * 0.85;
    this.copying = 0;
    this.useWorker = (options.useWorker ?? true) && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined';

    // Fallback: an offscreen canvas for compositing and encoding on the main thread.
    if (!this.useWorker && typeof document !== 'undefined') {
      this.canvas = document.createElement('canvas');
      this.canvas.width = this.width;
      this.canvas.height = this.height;
      this.ctx = this.canvas.getContext('2d');
    }
  }

  start() {
    if (!this.enabled || typeof WebSocket === 'undefined') return;
    if (this.useWorker) {
      this.worker = new Worker(new URL('./frame-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }) => {
        if (data.type !== 'status') return;
        if (data.connected && !this.connected) console.log(`[FrameStreamer] Connected to projector stream at ${this.url}`);
        this.connected = data.connected;
      };
      this.worker.postMessage({ type: 'start', url: this.url, quality: this.quality, width: this.width, height: this.height });
    } else this.connect();
  }

  connect() {
    if (this.ws || !this.enabled) return;
    try {
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = 'blob';

      this.ws.onopen = () => {
        this.connected = true;
        console.log(`[FrameStreamer] Connected to projector stream at ${this.url}`);
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.ws = null;
        if (this.enabled) {
          setTimeout(() => this.connect(), 2000);
        }
      };

      this.ws.onerror = () => {
        this.connected = false;
      };
    } catch {
      this.ws = null;
      if (this.enabled) setTimeout(() => this.connect(), 3000);
    }
  }

  stop() {
    this.enabled = false;
    this.connected = false;
    if (this.worker) {
      this.worker.postMessage({ type: 'stop' });
      this.worker.terminate();
      this.worker = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  // Hands the rendered scene (and the touch overlay on top of it) to the encoder.
  pushFrame(rendererCanvas, overlayCanvas = null) {
    if (!this.connected) return;
    const now = performance.now();
    if (now - this.lastFrameTime < this.minInterval) return;

    if (this.worker) {
      if (this.copying >= 2) return;
      this.lastFrameTime = now;
      this.copying++;
      // The canvases are copied and scaled to the stream size here; the encoding happens in the worker.
      const size = { resizeWidth: this.width, resizeHeight: this.height, resizeQuality: 'low' };
      Promise.all([createImageBitmap(rendererCanvas, size), overlayCanvas ? createImageBitmap(overlayCanvas, size) : null])
        .then(([scene, overlay]) => {
          if (!this.worker) return scene.close();
          this.worker.postMessage({ type: 'frame', scene, overlay }, overlay ? [scene, overlay] : [scene]);
        })
        .catch(() => {})
        .finally(() => { this.copying--; });
      return;
    }

    if (!this.ws || this.sending || !this.ctx) return;
    // Apply backpressure: drop frame if socket buffer has > 120KB unsent
    if (this.ws.bufferedAmount > 120000) return;
    this.lastFrameTime = now;
    this.sending = true;
    this.ctx.drawImage(rendererCanvas, 0, 0, this.width, this.height);
    if (overlayCanvas) this.ctx.drawImage(overlayCanvas, 0, 0, this.width, this.height);
    this.canvas.toBlob(
      (blob) => {
        if (blob && this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(blob);
        this.sending = false;
      },
      'image/jpeg',
      this.quality
    );
  }
}
