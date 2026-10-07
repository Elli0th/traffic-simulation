// High-performance WebSocket frame streamer for the room projector.
// Offloads 100% of WebGL rendering and simulation from the Raspberry Pi to the host laptop.
// Streams rendered canvas frames directly to ws://192.168.42.21/frames as binary JPEGs.

export class FrameStreamer {
  constructor(options = {}) {
    this.url = options.url || 'ws://192.168.42.21/frames';
    this.targetFps = options.targetFps || 28; // ~28 fps for fluid projection with low network overhead
    this.quality = options.quality || 0.75; // JPEG quality recommended by room API (70-80)
    this.width = options.width || 1280;
    this.height = options.height || 800; // 16:10 aspect ratio matching 1920x1200
    this.enabled = options.enabled ?? true;

    this.ws = null;
    this.connected = false;
    this.sending = false;
    this.lastFrameTime = 0;
    this.minInterval = 1000 / this.targetFps;

    // Offscreen canvas for compositing and encoding
    if (typeof document !== 'undefined') {
      this.canvas = document.createElement('canvas');
      this.canvas.width = this.width;
      this.canvas.height = this.height;
      this.ctx = this.canvas.getContext('2d');
    }
  }

  start() {
    if (!this.enabled || typeof WebSocket === 'undefined') return;
    this.connect();
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
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  // Composites WebGL renderer and touch overlay and pushes binary JPEG
  pushFrame(rendererCanvas, overlayCanvas = null) {
    if (!this.connected || !this.ws || this.sending || !this.ctx) return;

    const now = performance.now();
    if (now - this.lastFrameTime < this.minInterval) return;

    // Apply backpressure: drop frame if socket buffer has > 120KB unsent
    if (this.ws.bufferedAmount > 120000) return;

    this.lastFrameTime = now;
    this.sending = true;

    // 1. Draw 3D scene from WebGL canvas
    this.ctx.drawImage(rendererCanvas, 0, 0, this.width, this.height);

    // 2. Draw touch ripples / halos if overlay canvas present
    if (overlayCanvas) {
      this.ctx.drawImage(overlayCanvas, 0, 0, this.width, this.height);
    }

    // 3. Compress to JPEG blob and send as binary message
    this.canvas.toBlob(
      (blob) => {
        if (blob && this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(blob);
        }
        this.sending = false;
      },
      'image/jpeg',
      this.quality
    );
  }
}
