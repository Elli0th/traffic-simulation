// Runs the projector stream off the main thread: it owns the WebSocket, turns each frame it is handed into
// a JPEG and sends it. The game thread only copies the canvas (createImageBitmap); encoding is what was
// taking most of its time and held the stream to under 10 frames a second.

let ws = null;
let url = '';
let enabled = false;
let quality = 0.75;
let width = 1280;
let height = 800;
let canvas = null;
let ctx = null;
let busy = 0;

const tell = (message) => postMessage(message);

function connect() {
  if (ws || !enabled) return;
  try {
    ws = new WebSocket(url);
  } catch {
    ws = null;
    setTimeout(connect, 3000);
    return;
  }
  ws.binaryType = 'blob';
  ws.onopen = () => tell({ type: 'status', connected: true });
  ws.onclose = () => {
    ws = null;
    tell({ type: 'status', connected: false });
    if (enabled) setTimeout(connect, 2000);
  };
  ws.onerror = () => tell({ type: 'status', connected: false });
}

onmessage = async ({ data }) => {
  if (data.type === 'start') {
    ({ url, quality, width, height } = data);
    canvas = new OffscreenCanvas(width, height);
    ctx = canvas.getContext('2d');
    enabled = true;
    connect();
  } else if (data.type === 'stop') {
    enabled = false;
    try { ws?.close(); } catch {}
    ws = null;
  } else if (data.type === 'frame') {
    const { scene, overlay } = data;
    // Drop the frame rather than queue it: a late frame is worse than a missing one.
    if (!ctx || !ws || ws.readyState !== 1 || ws.bufferedAmount > 120000 || busy >= 2) {
      scene.close();
      overlay?.close();
      return;
    }
    busy++;
    try {
      ctx.drawImage(scene, 0, 0, width, height);
      if (overlay) ctx.drawImage(overlay, 0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      if (ws && ws.readyState === 1) ws.send(blob);
    } finally {
      scene.close();
      overlay?.close();
      busy--;
    }
  }
};
