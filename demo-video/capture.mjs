// Records the footage the tutorial is cut from: one scripted round of the outbreak game, played on
// the table version with pretend pieces and hands. Needs the dev server running.
//
//   node capture.mjs [http://localhost:5193]
//
// Writes assets/round.mp4 and assets/footage.json (where each piece and hand was, and when, for the
// graphics drawn over the footage). Part of the take shows the round in 3D, as the TVs do.

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// puppeteer-core comes with the HyperFrames CLI; borrow it from the npx cache rather than install it twice.
const cache = path.join(os.homedir(), '.npm/_npx');
const home = fs.readdirSync(cache).map((d) => path.join(cache, d, 'node_modules')).find((d) => fs.existsSync(path.join(d, 'puppeteer-core')));
const puppeteer = createRequire(path.join(home, 'x.js'))('puppeteer-core');

const base = process.argv[2] || 'http://localhost:5193';
const W = 1920;
const H = 1080;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync('assets', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  defaultViewport: { width: W, height: H },
  args: [`--window-size=${W},${H}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--hide-scrollbars'],
});
const table = await browser.newPage();
await table.goto(`${base}/?game=table`);
await table.waitForFunction('window.table && window.table.game', { timeout: 120000 });

await sleep(2000);

// A busy street well inside the picture for the first piece, and where the cards are.
const spots = await table.evaluate(() => {
  const v = window.table.view;
  const crowd = {};
  for (const p of window.table.people.agents) {
    if (!p.out) continue;
    const k = `${Math.floor(p.x / 100)},${Math.floor(p.z / 100)}`;
    crowd[k] = (crowd[k] || 0) + 1;
  }
  const at = (k) => {
    const [cx, cz] = k.split(',').map(Number);
    return { x: ((cx + 0.5) * 100 - v.x) / v.across + 0.5, y: ((cz + 0.5) * 100 - v.z) / (v.across / (innerWidth / innerHeight)) + 0.5 };
  };
  const seed = Object.entries(crowd)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => at(k))
    .find((p) => p.x > 0.3 && p.x < 0.7 && p.y > 0.32 && p.y < 0.68);
  const card = (name) => {
    const r = document.querySelector(`.vt-dock [data-card="${name}"]`).getBoundingClientRect();
    return { x: (r.left + r.width / 2) / innerWidth, y: (r.top + r.height / 2) / innerHeight };
  };
  return { seed, cup: { x: seed.x + 0.045, y: seed.y + 0.03 }, masks: card('masks'), spread: card('spread') };
});

const put = (list) => table.evaluate((l) => window.table.setBlobs(l), list);
const puck = { ...spots.seed, r: 0.012, h: 30 };
const cup = { ...spots.cup, r: 0.014, h: 95 };
const hand = (p) => ({ ...p, r: 0.02, h: 40 });
const marks = {};
const start = Date.now();
const mark = (name) => (marks[name] = (Date.now() - start) / 1000);

const recorder = await table.screencast({ path: 'assets/round.webm' });
await sleep(4000);
mark('puck');
await put([puck]);
await sleep(12000);
mark('cup');
await put([puck, cup]);
await sleep(6000);
mark('masks');
await put([puck, cup, hand(spots.masks)]);
await sleep(5000);
mark('spread');
await put([puck, cup, hand(spots.spread)]);
await sleep(4000);
await put([puck, cup]);
await sleep(2000);
// What the TVs show: the same round in 3D, with both rows of cards the right way up.
mark('tv');
await table.keyboard.press('v');
await table.evaluate(() => document.body.classList.add('vt-screen'));
await sleep(6000);
await table.keyboard.press('v');
await table.evaluate(() => document.body.classList.remove('vt-screen'));
await sleep(1000);
// The end of a round, without waiting out the three minutes.
mark('over');
await table.evaluate(() => (window.table.game.phase = 'over'));
await sleep(5000);
mark('end');
await recorder.stop();
const state = await table.evaluate(() => ({ lockdowns: window.table.game.lockdowns.length, points: window.table.game.points, share: window.table.game.counts().share, level: window.table.game.level, masksUntil: window.table.game.masksUntil }));
await browser.close();

execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', 'assets/round.webm', '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-g', '30', '-an', 'assets/round.mp4']);
fs.rmSync('assets/round.webm');
fs.writeFileSync('assets/footage.json', JSON.stringify({ spots, marks, state }, null, 2));
console.log(JSON.stringify({ spots, marks, state }));
