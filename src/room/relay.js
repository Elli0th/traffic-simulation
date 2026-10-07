// Messages between the windows of the installation: the camera page, the table and the screens.
//
// They travel two ways at once: over the dev server's socket, which reaches every machine that has
// the page open, and over a BroadcastChannel, which reaches other windows of the same browser even
// if the socket is not there. Messages are states ("these objects are on the table"), so receiving
// one twice does no harm.

const hot = import.meta.hot;
// Adding ?socket-only to a page's address turns the BroadcastChannel off, to test the socket path by itself.
const socketOnly = globalThis.location?.search.includes('socket-only');
const channel = 'BroadcastChannel' in globalThis && !socketOnly ? new BroadcastChannel('tangible-table') : null;
const listeners = new Map();

function deliver(type, data) {
  for (const fn of listeners.get(type) || []) fn(data);
}

if (channel) channel.onmessage = (event) => deliver(event.data.type, event.data.data);

export function send(type, data) {
  hot?.send(`room:${type}`, data);
  channel?.postMessage({ type, data });
}

export function on(type, fn) {
  if (!listeners.has(type)) {
    listeners.set(type, []);
    hot?.on(`room:${type}`, (data) => deliver(type, data));
  }
  listeners.get(type).push(fn);
}
