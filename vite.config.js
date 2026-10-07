import { defineConfig } from 'vite';

// Passes messages between every window that has the app open (see src/room/relay.js), so the camera
// page on the laptop can tell the table and the screens what is on the table.
const MESSAGES = ['blobs', 'world', 'state', 'calibrate', 'hello', 'who', 'gesture', 'edits', 'ink', 'virus', 'game_sync', 'game_scene', 'scene_request', 'action', 'lights'];
const relay = () => ({
  name: 'room-relay',
  configureServer(server) {
    for (const type of MESSAGES) {
      server.ws.on(`room:${type}`, (data) => server.ws.send(`room:${type}`, data));
    }
  },
});

// If the room's API refuses requests from a web page (CORS), start the server with
//   ROOM_API=http://address-of-the-room npm run dev
// and use /room-api/... as the address on the camera page; the server fetches it on the page's behalf.
const api = process.env.ROOM_API;
const hueHost = process.env.HUE_IP || (process.env.ROOM_ENV === 'sim' ? 'localhost:8011' : '192.168.42.11');

export default defineConfig({
  plugins: [relay()],
  server: {
    proxy: {
      '/hue-api': {
        target: `http://${hueHost}`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/hue-api/, ''),
      },
      ...(api ? { '/room-api': { target: api, changeOrigin: true, ws: true, rewrite: (path) => path.replace(/^\/room-api/, '') } } : {}),
    },
  },
  build: {
    rollupOptions: { input: ['index.html', 'camera.html', 'lidar.html', 'grid.html', 'draw.html', 'dashboard.html', 'tv-map.html'] },
  },
});
