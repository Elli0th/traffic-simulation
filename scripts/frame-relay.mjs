// Frames from the stream page to a display's /frames WebSocket, paced by what the display has
// actually received.
//
// A page that sends straight into a WebSocket (or through a plain proxy) only knows that a frame has
// left the browser. On a slow wifi the frames then pile up in buffers on the way and the picture on
// the table falls seconds behind. Here every frame is followed by a WebSocket ping; the display
// answers pings in order, so its pong says the frame before it has arrived. The page waits for that
// answer before sending more, so nothing queues: a slow link gives fewer frames, never older ones.
//
//   POST /room-frame/<display>           one JPEG as the body; answered when the display has it
//   POST /room-frame/<display>?direct    the same, to the display's /frames/direct
//   answers: {"ok":true,"ms":…} | {"ok":false,"why":"…"}

import net from 'node:net';
import crypto from 'node:crypto';

const WAIT = 1500; // milliseconds before a frame that was never answered stops holding the page up

// A WebSocket client with only what this needs: binary frames out, pings out, pongs in.
function open(address, path, onClose) {
  const url = new URL(address);
  const socket = net.connect({ host: url.hostname, port: Number(url.port) || 80 });
  socket.setNoDelay(true);
  const link = { socket, ready: false, waiting: new Map(), next: 1, opened: null };
  let buffer = Buffer.alloc(0);
  let shaken = false;

  const frame = (opcode, payload) => {
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | opcode, 0x80 | n]) : n < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), Buffer.from(new BigUint64Array([BigInt(n)]).buffer).reverse()]);
    // The mask is four zero bytes, which leaves the payload as it is: no pass over 150 kB a frame, and
    // no copy either, as the header and the payload are written one after the other.
    socket.cork();
    socket.write(Buffer.concat([head, Buffer.alloc(4)]));
    socket.write(payload);
    socket.uncork();
  };
  link.send = (jpeg) =>
    new Promise((resolve) => {
      const id = link.next++;
      const tag = Buffer.alloc(4);
      tag.writeUInt32BE(id);
      const timer = setTimeout(() => {
        link.waiting.delete(id);
        resolve(false);
      }, WAIT);
      link.waiting.set(id, () => {
        clearTimeout(timer);
        resolve(true);
      });
      frame(0x2, jpeg);
      frame(0x9, tag);
    });
  link.close = () => socket.destroy();

  link.opened = new Promise((resolve) => {
    socket.on('connect', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!shaken) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const ok = buffer.subarray(0, end).toString().startsWith('HTTP/1.1 101');
        buffer = buffer.subarray(end + 4);
        shaken = true;
        link.ready = ok;
        resolve(ok);
        if (!ok) return socket.destroy();
      }
      // What the display sends back: pongs for our pings, its own pings, a close. Never fragmented, never masked.
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15;
        let n = buffer[1] & 127;
        let at = 2;
        if (n === 126) {
          if (buffer.length < 4) return;
          n = buffer.readUInt16BE(2);
          at = 4;
        } else if (n === 127) {
          if (buffer.length < 10) return;
          n = Number(buffer.readBigUInt64BE(2));
          at = 10;
        }
        if (buffer.length < at + n) return;
        const payload = buffer.subarray(at, at + n);
        buffer = buffer.subarray(at + n);
        if (opcode === 0xa && n === 4) {
          const id = payload.readUInt32BE(0);
          link.waiting.get(id)?.();
          link.waiting.delete(id);
        } else if (opcode === 0x9) frame(0xa, payload);
        else if (opcode === 0x8) socket.destroy();
      }
    });
    const gone = () => {
      link.ready = false;
      resolve(false);
      for (const done of link.waiting.values()) done();
      link.waiting.clear();
      onClose(link);
    };
    socket.on('error', gone);
    socket.on('close', gone);
    socket.setTimeout(10000, () => socket.destroy()); // a display that has gone silent
  });
  return link;
}

export function frameRelay(displays) {
  const links = new Map(); // "projector" or "projector/direct" -> link
  return {
    name: 'frame-relay',
    configureServer(server) {
      server.middlewares.use('/room-frame', (req, res) => {
        const [name, query = ''] = req.url.replace(/^\//, '').split('?');
        const answer = (body) => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        };
        if (req.method !== 'POST' || !displays[name]) return answer({ ok: false, why: 'POST a JPEG to /room-frame/<display>' });
        const key = name + (query.includes('direct') ? '/direct' : '');
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', async () => {
          let link = links.get(key);
          if (!link) {
            link = open(displays[name], query.includes('direct') ? '/frames/direct' : '/frames', (closed) => links.get(key) === closed && links.delete(key));
            links.set(key, link);
          }
          if (!(await link.opened) || !link.ready) return answer({ ok: false, why: `no connection to the ${name}` });
          const started = performance.now();
          const arrived = await link.send(Buffer.concat(chunks));
          // late: the link is there but slow, which the page answers by sending less picture.
          answer(arrived ? { ok: true, ms: Math.round(performance.now() - started) } : { ok: false, late: link.ready, why: `the ${name} did not answer in time` });
        });
      });
      // The page says when it stops, so the display is not left with a sender that sends nothing.
      server.middlewares.use('/room-frame-stop', (req, res) => {
        for (const link of links.values()) link.close();
        links.clear();
        res.end('ok');
      });
    },
  };
}
