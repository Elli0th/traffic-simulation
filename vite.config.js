import { defineConfig } from 'vite';

// Passes messages between every window that has the app open (see src/room/relay.js), so the camera
// page on the laptop can tell the table and the screens what is on the table.
const MESSAGES = ['blobs', 'world', 'state', 'calibrate', 'hello', 'who', 'gesture', 'edits', 'ink', 'virus'];
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

// The room's lidar, passed on by this server at /room-lidar/scan. A browser that macOS does not let
// onto the local network cannot open ws://192.168.42.24/scan itself; this server can, as long as it
// was started from a terminal. ROOM_LIDAR points it somewhere else (http://localhost:8024 in the
// virtual room).
const lidar = { target: process.env.ROOM_LIDAR ?? 'http://192.168.42.24', changeOrigin: true, ws: true, rewrite: (path) => path.replace(/^\/room-lidar/, '') };

export default defineConfig({
  plugins: [relay()],
  server: {
    proxy: {
      '/room-lidar': lidar,
      ...(api ? { '/room-api': { target: api, changeOrigin: true, ws: true, rewrite: (path) => path.replace(/^\/room-api/, '') } } : {}),
    },
  },
  build: {
    rollupOptions: { input: ['index.html', 'camera.html', 'lidar.html', 'grid.html', 'draw.html'] },
  },
});
