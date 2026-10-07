// What a display shows when the stream page sends it video (stream.html?via=video): nothing but the
// picture. The display's own computer runs no game and no map, it only plays a video that arrives
// straight from the laptop (WebRTC), so the picture is sharp, a few megabits a second, and on time.
//
//   /watch.html?display=projector    which display this is: projector, tv-1 or tv-2
//
// The two pages find each other through the dev server (relay.js, the 'rtc' messages): this page says
// it is ready, the stream page offers a connection, and from then on the video goes directly.

import * as relay from './relay.js';

const display = new URLSearchParams(location.search).get('display') || 'projector';
const video = document.getElementById('video');
let pc = null;

const tell = (data) => relay.send('rtc', { to: 'sender', from: display, ...data });
const live = () => pc && ['connected', 'connecting', 'new'].includes(pc.connectionState);
function ready() {
  if (!live()) tell({ ready: true });
}

relay.on('rtc', async (m) => {
  if (m.to !== display) return;
  if (m.hello) return ready();
  if (m.bye) {
    pc?.close();
    pc = null;
    video.srcObject = null;
    return;
  }
  if (m.sdp) {
    pc?.close();
    const made = (pc = new RTCPeerConnection());
    made.ontrack = (e) => {
      // No buffering for smoothness: the newest picture, as soon as it is here.
      try {
        e.receiver.jitterBufferTarget = 0;
        e.receiver.playoutDelayHint = 0;
      } catch {}
      video.srcObject = e.streams[0] || new MediaStream([e.track]);
      video.play().catch(() => {});
    };
    made.onicecandidate = (e) => e.candidate && tell({ candidate: e.candidate.toJSON() });
    await made.setRemoteDescription(m.sdp);
    await made.setLocalDescription(await made.createAnswer());
    tell({ sdp: made.localDescription.toJSON() });
  } else if (m.candidate) await pc?.addIceCandidate(m.candidate).catch(() => {});
});

// Until the picture is here, and again whenever it is lost: say so, every two seconds.
setInterval(ready, 2000);
ready();
