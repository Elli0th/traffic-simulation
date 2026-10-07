// The outbreak game's dashboard for the screens (?game&view=screen): the round's clock, the public
// numbers, how close each side is to winning, the curve of cases and where the virus is. It shows
// nothing from either player's private panel, and no map: the map is on the table.

import { DAY } from './virus.js';

export const DAYS = 60; // game days in a round
const CELL = 100; // metres to a side of a square in "where the virus is"

// What the table tells the screens about the round, in real people.
export function boardState(game) {
  const c = game.counts();
  const k = game.scale;
  return {
    phase: game.phase,
    day: Math.min(DAYS, Math.floor(game.time / DAY) + 1),
    infected: Math.round((c.e + c.i) * k),
    noninfected: Math.round((c.s + c.r) * k),
    hospital: c.people.hospital,
    dead: c.people.dead,
    share: c.share,
    // The curve: [day, people infected then], one entry a game minute.
    history: game.history.map((h) => [Math.round((h[0] / DAY) * 100) / 100, Math.round(h[1] * k)]),
  };
}

const CSS = `
  #vt-board { position: fixed; inset: 0; z-index: 15; box-sizing: border-box; padding: 3vh 3vw; display: grid; grid-template-rows: auto auto auto minmax(0, 1fr) auto; gap: 2.2vh; background: #0a0f15; color: #e9ecef; font-size: 2.1vh; }
  #vt-board header { display: flex; align-items: baseline; justify-content: space-between; }
  #vt-board h1 { margin: 0; font-size: 3.4vh; letter-spacing: 0.16em; text-transform: uppercase; }
  #vt-board h1 small { margin-left: 1.5vw; font-size: 2.1vh; letter-spacing: 0.1em; color: #9aa4b2; }
  #vt-board [data-time] { font-size: 8vh; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
  #vt-board .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1.4vw; }
  #vt-board .tile, #vt-board .meter, #vt-board .panel { padding: 1.8vh 1.4vw; background: #101720; border: 1px solid #263240; border-radius: 1.2vh; }
  #vt-board label { display: block; font-size: 1.8vh; letter-spacing: 0.12em; text-transform: uppercase; color: #9aa4b2; }
  #vt-board .tile b { display: block; margin-top: 0.6vh; font-size: 6vh; line-height: 1.1; font-variant-numeric: tabular-nums; }
  #vt-board .meters { display: grid; grid-template-columns: 1fr 1fr; gap: 1.4vw; }
  #vt-board .meter label { display: flex; justify-content: space-between; align-items: baseline; }
  #vt-board .meter label b { font-size: 3.6vh; letter-spacing: 0; font-variant-numeric: tabular-nums; }
  #vt-board .bar { position: relative; height: 2.4vh; margin: 1vh 0 0.8vh; background: #1b2531; border-radius: 1.2vh; overflow: hidden; }
  #vt-board .bar i { display: block; height: 100%; width: 0; border-radius: 1.2vh; transition: width 0.5s linear; }
  #vt-board .meter small { color: #9aa4b2; font-size: 1.7vh; }
  #vt-board .main { display: grid; grid-template-columns: 2fr 1fr; gap: 1.4vw; min-height: 0; }
  #vt-board .panel { display: grid; grid-template-rows: auto minmax(0, 1fr); gap: 1vh; min-height: 0; }
  #vt-board canvas { width: 100%; height: 100%; min-height: 0; }
  #vt-board [data-status] { margin: 0; min-height: 2.6vh; color: #cfd6e0; }
  #vt-board .over { position: absolute; inset: 0; display: none; place-items: center; background: rgba(4, 7, 11, 0.86); text-align: center; }
  #vt-board .over.show { display: grid; }
  #vt-board .over h2 { margin: 0 0 2vh; font-size: 7vh; }
  #vt-board .over p { max-width: 60vw; margin: 0 auto; font-size: 2.6vh; line-height: 1.5; color: #cfd6e0; }
`;

const HTML = `
  <header><h1>Outbreak <small data-day>Göteborg</small></h1><span data-time>3:00</span></header>
  <div class="tiles">
    <div class="tile"><label>Infected now</label><b data-infected style="color:#ff4545">0</b></div>
    <div class="tile"><label>Not infected</label><b data-noninfected style="color:#50dda5">0</b></div>
    <div class="tile"><label>Need a hospital bed</label><b data-hospital style="color:#ff9f1c">0</b></div>
    <div class="tile"><label>Estimated deaths</label><b data-dead>0</b></div>
  </div>
  <div class="meters">
    <div class="meter"><label>Caught the virus <b data-share style="color:#ff4545">0%</b></label><div class="bar"><i data-share-bar style="background:#ff4545"></i></div></div>
  </div>
  <div class="main">
    <div class="panel"><label>People infected, day by day</label><canvas data-chart></canvas></div>
    <div class="panel"><label>Where the virus is</label><canvas data-heat></canvas></div>
  </div>
  <p data-status>Waiting for the table…</p>
  <div class="over"><div><h2 data-win></h2><p data-sum></p></div></div>
`;

const num = (n) => n.toLocaleString('en-GB');

// Sizes a canvas to the pixels it covers and returns its context, drawing in CSS pixels.
function fit(canvas) {
  const ratio = Math.min(devicePixelRatio, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
  }
  const g = canvas.getContext('2d');
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

// A round number at or above n, for the top of the chart.
function ceiling(n) {
  const step = 10 ** Math.floor(Math.log10(Math.max(n, 10)));
  return Math.ceil(n / step) * step;
}

function drawChart(canvas, history) {
  const { g, w, h } = fit(canvas);
  const font = Math.max(11, innerHeight * 0.017);
  const left = font * 5;
  const bottom = font * 1.8;
  const top = font * 0.8;
  const pw = w - left - font;
  const ph = h - top - bottom;
  const max = ceiling(Math.max(100, ...history.map((p) => p[1])));
  const x = (day) => left + (day / DAYS) * pw;
  const y = (n) => top + ph - (n / max) * ph;
  g.font = `${font}px ui-sans-serif, system-ui, sans-serif`;
  g.fillStyle = '#9aa4b2';
  g.strokeStyle = '#263240';
  g.lineWidth = 1;
  g.textBaseline = 'middle';
  g.textAlign = 'right';
  for (const n of [0, max / 2, max]) {
    g.beginPath();
    g.moveTo(left, y(n));
    g.lineTo(left + pw, y(n));
    g.stroke();
    g.fillText(num(n), left - font * 0.5, y(n));
  }
  g.textBaseline = 'top';
  g.textAlign = 'center';
  for (let day = 0; day <= DAYS; day += 10) g.fillText(day ? `${day}` : 'Day 0', x(day), top + ph + font * 0.5);
  if (history.length < 2) return;
  g.beginPath();
  history.forEach((p, k) => (k ? g.lineTo(x(p[0]), y(p[1])) : g.moveTo(x(p[0]), y(p[1]))));
  g.strokeStyle = '#ff4545';
  g.lineWidth = Math.max(2, innerHeight * 0.004);
  g.lineJoin = 'round';
  g.stroke();
  const last = history[history.length - 1];
  g.lineTo(x(last[0]), y(0));
  g.lineTo(x(history[0][0]), y(0));
  g.fillStyle = 'rgba(255, 69, 69, 0.16)';
  g.fill();
}

// The city as a plain rectangle with a square for each 100 m block that has cases: no streets.
function drawHeat(canvas, heat, size) {
  const { g, w, h } = fit(canvas);
  const scale = Math.min(w / size[0], h / size[1]);
  const ox = (w - size[0] * scale) / 2;
  const oy = (h - size[1] * scale) / 2;
  g.fillStyle = '#0c1219';
  g.strokeStyle = '#263240';
  g.fillRect(ox, oy, size[0] * scale, size[1] * scale);
  g.strokeRect(ox + 0.5, oy + 0.5, size[0] * scale - 1, size[1] * scale - 1);
  const side = Math.max(2, CELL * scale);
  for (let k = 0; k < heat.length; k += 3) {
    const s = Math.min(1, heat[k + 2] / 5);
    g.fillStyle = `rgba(255, ${Math.round(166 * (1 - s))}, ${Math.round(26 * (1 - s))}, ${0.55 + 0.45 * s})`;
    g.fillRect(ox + heat[k] * scale - side / 2, oy + heat[k + 1] * scale - side / 2, side, side);
  }
}

// Puts the dashboard over the whole window and keeps it up to date from the table's messages.
// `size` is the map's width and depth in metres.
export function startBoard(relay, size) {
  document.head.appendChild(Object.assign(document.createElement('style'), { textContent: CSS }));
  const board = Object.assign(document.createElement('div'), { id: 'vt-board', innerHTML: HTML });
  document.body.appendChild(board);
  const at = (name) => board.querySelector(`[data-${name}]`);
  let latest = null;

  function show(v) {
    const s = v.stats;
    at('time').textContent = v.time;
    at('day').textContent = s.phase === 'setup' ? 'Göteborg' : `Day ${s.day} of ${DAYS}`;
    at('infected').textContent = num(s.infected);
    at('noninfected').textContent = num(s.noninfected);
    at('hospital').textContent = num(s.hospital);
    at('dead').textContent = num(s.dead);
    at('share').textContent = `${s.share < 0.1 ? Math.floor(s.share * 1000) / 10 : Math.floor(s.share * 100)}%`;
    at('share-bar').style.width = `${Math.min(100, s.share * 100)}%`;
    at('status').textContent = v.status;
    board.querySelector('.over').classList.toggle('show', Boolean(v.over));
    if (v.over) {
      at('win').textContent = v.over.win;
      at('sum').textContent = v.over.sum;
    }
    drawChart(at('chart'), s.history);
    drawHeat(at('heat'), v.heat, size);
  }

  relay.on('virus', (v) => {
    latest = v;
    show(v);
  });
  addEventListener('resize', () => latest && show(latest));
}
