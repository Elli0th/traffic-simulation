// Records everything that happens during a slot in the room, so that the lidar can be calibrated
// and the gestures tuned afterwards from what really happened rather than from guesses.
//
// It is part of the dev server and only runs when asked for:
//
//   npm run live:record          the live server (port 5203), recording
//   RECORD=1 npm run dev         any other way of starting it
//
// Each run writes one file, recordings/<date>_<time>.jsonl, a line of JSON per event:
//
//   { t, k: 'meta', … }            what was running: commit, addresses, settings
//   { t, k: 'sweep', lt, a, d, q } every sweep of the lidar, read by this server itself, so it is
//                                  there whether or not a page was open: angles in hundredths of a
//                                  degree, distances in millimetres, quality
//   { t, k: 'relay:<type>', d }    every message the pages send each other: gestures, objects, what
//                                  the lidar page registers, its calibration and empty table, the
//                                  game's state and actions
//   { t, k: 'relay:record', d }    what a page reports for the record: each touch the game saw, how
//                                  long and how wide it was, whether it became a tap or a hold, and
//                                  what it pressed
//   { t, k: 'page', d }            errors and start-ups reported by the pages (see /client-log)
//
// `t` is this laptop's clock in milliseconds. GET /record/status says whether it is recording and
// how much it has written. Summarise a file with: node scripts/recording.mjs recordings/<file>

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function recorder({ on, types, lidar, dir = 'recordings' }) {
  let out = null;
  let file = '';
  let lines = 0;
  let bytes = 0;
  let sweeps = 0;
  let lidarState = 'not connected';

  function write(k, fields) {
    if (!out) return;
    const line = JSON.stringify({ t: Date.now(), k, ...fields }) + '\n';
    out.write(line);
    lines++;
    bytes += line.length;
  }

  function open() {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toLocaleString('sv-SE').replace(' ', '_').replaceAll(':', '-');
    file = path.join(dir, `${stamp}.jsonl`);
    out = fs.createWriteStream(file, { flags: 'a' });
    let commit = '';
    try {
      commit = execFileSync('git', ['log', '-1', '--format=%h %s'], { encoding: 'utf8' }).trim();
    } catch {}
    write('meta', { commit, lidar, started: new Date().toISOString(), node: process.version });
    console.log(`  recording to ${file}`);
  }

  // The lidar, read here rather than through a page: one line per sweep, for as long as the server runs.
  function listen() {
    if (!lidar || typeof WebSocket === 'undefined') return;
    const url = lidar.replace(/^http/, 'ws').replace(/\/$/, '') + '/scan';
    let socket;
    try {
      socket = new WebSocket(url);
    } catch {
      return void setTimeout(listen, 3000);
    }
    socket.onopen = () => {
      lidarState = 'connected';
      write('lidar', { state: 'connected', url });
    };
    socket.onmessage = (event) => {
      try {
        const body = JSON.parse(event.data);
        const points = body.points || [];
        const a = new Array(points.length);
        const d = new Array(points.length);
        const q = new Array(points.length);
        for (let i = 0; i < points.length; i++) {
          a[i] = Math.round(points[i].angle * 100);
          d[i] = Math.round(points[i].distance);
          q[i] = points[i].quality ?? 0;
        }
        sweeps++;
        // A lidar that speaks another dialect is kept as it came.
        write('sweep', points.length ? { lt: body.t, a, d, q } : { raw: body });
      } catch {}
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      if (lidarState === 'connected') write('lidar', { state: 'lost', url });
      lidarState = 'not connected';
      setTimeout(listen, 3000);
    };
  }

  return {
    name: 'recorder',
    // For the page log to pass its lines on.
    api: { write },
    configureServer(server) {
      server.middlewares.use('/record/status', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ recording: Boolean(out), file, lines, megabytes: Number((bytes / 1e6).toFixed(1)), sweeps, lidar: lidarState }));
      });
      if (!on) return;
      open();
      listen();
      for (const type of [...types, 'record']) {
        server.ws.on(`room:${type}`, (data) => write(`relay:${type}`, { d: data }));
      }
      server.httpServer?.on('close', () => out?.end());
    },
  };
}
