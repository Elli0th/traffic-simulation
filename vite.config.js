import { defineConfig, loadEnv } from 'vite';
import { live } from './scripts/live.mjs';

// Passes messages between every window that has the app open (see src/room/relay.js), so the camera
// page on the laptop can tell the table and the screens what is on the table.
const MESSAGES = ['blobs', 'world', 'state', 'calibrate', 'hello', 'who', 'gesture', 'edits', 'ink', 'virus', 'game_sync', 'action', 'lights', 'lidar-map'];
const relay = () => ({
  name: 'room-relay',
  configureServer(server) {
    for (const type of MESSAGES) {
      server.ws.on(`room:${type}`, (data) => server.ws.send(`room:${type}`, data));
    }
  },
});

// What the pages on the room's displays report about themselves (they have no console we can read):
// POST /client-log with a line of text; GET /client-log lists the last hundred, newest last.
const pageLog = [];
const clientLog = () => ({
  name: 'client-log',
  configureServer(server) {
    server.middlewares.use('/client-log', (req, res) => {
      if (req.method !== 'POST') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.end(pageLog.join('\n') + '\n');
      }
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        pageLog.push(`${new Date().toLocaleTimeString('sv-SE')} ${req.socket.remoteAddress?.replace('::ffff:', '')} ${body.slice(0, 600)}`);
        if (pageLog.length > 100) pageLog.shift();
        res.end('ok');
      });
    });
  },
});

// If the room's API refuses requests from a web page (CORS), start the server with
//   ROOM_API=http://address-of-the-room npm run dev
// and use /room-api/... as the address on the camera page; the server fetches it on the page's behalf.
const api = process.env.ROOM_API;
const hueHost = process.env.HUE_IP || (process.env.ROOM_ENV === 'sim' ? 'localhost:8011' : '192.168.42.11');

// The room's lidar, passed on by this server at /room-lidar/scan. A browser that macOS does not let
// onto the local network cannot open ws://192.168.42.24/scan itself; this server can, as long as it
// was started from a terminal. ROOM_LIDAR points it somewhere else (http://localhost:8024 in the
// virtual room).
const lidar = { target: process.env.ROOM_LIDAR ?? 'http://192.168.42.24', changeOrigin: true, ws: true, rewrite: (path) => path.replace(/^\/room-lidar/, '') };

// The keys for live traffic are read from .env.local; see .env.example and scripts/live.mjs.
// PROJECTOR, TV1 and TV2 point somewhere else, as for scripts/room.mjs.
const displays = {
  projector: process.env.PROJECTOR ?? 'http://192.168.42.21',
  'tv-1': process.env.TV1 ?? 'http://192.168.42.22',
  'tv-2': process.env.TV2 ?? 'http://192.168.42.23',
};

export default defineConfig(({ mode }) => ({
  plugins: [relay(), clientLog(), live({ ...loadEnv(mode, process.cwd(), ''), ...process.env })],
  server: {
    proxy: {
      '/room-lidar': lidar,
      // The displays, for a page that streams frames to one (stream.html): ws://…/room-display/projector/frames.
      ...Object.fromEntries(
        Object.entries(displays).map(([name, address]) => [
          `/room-display/${name}`,
          { target: address, changeOrigin: true, ws: true, rewrite: (path) => path.replace(`/room-display/${name}`, '') },
        ]),
      ),
      '/hue-api': {
        target: `http://${hueHost}`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/hue-api/, ''),
      },
      ...(api ? { '/room-api': { target: api, changeOrigin: true, ws: true, rewrite: (path) => path.replace(/^\/room-api/, '') } } : {}),
    },
  },
  build: {
    rollupOptions: { input: ['index.html', 'camera.html', 'lidar.html', 'grid.html', 'draw.html', 'dashboard.html', 'stream.html'] },
  },
}));
