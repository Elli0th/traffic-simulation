// Optional smoke check: start a Chromium browser with --remote-debugging-port=9224 first.
import assert from 'node:assert/strict';
import { gameRect, controlWidth, soloLayout } from '../src/game-view.js';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const targets = await (await fetch('http://127.0.0.1:9224/json/list')).json();
const target = targets.find(t => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let next = 0;
const pending = new Map(), errors = [];
ws.onmessage = message => {
  const data = JSON.parse(message.data);
  if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.text + ' ' + (data.params.exceptionDetails.exception?.description || ''));
  if (data.id) { const p = pending.get(data.id); pending.delete(data.id); data.error ? p.reject(data.error) : p.resolve(data.result); }
};
function command(method, params = {}) {
  return new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression) {
  const r = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
try {
  await command('Runtime.enable');
  await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: 'http://localhost:5173/?game&players=2' });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await evaluate('!!window.table?.game && !document.getElementById("loading")')) break;
    if (attempt === 119) throw Error('Game did not load');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  console.log('Game loaded without startup exceptions.');
  assert.equal(await evaluate('document.querySelectorAll("[data-map]").length'), 2);
  const views = await evaluate('window.table.playerViews');
  await evaluate('document.querySelector("[data-player=curber] .zoom-tools button").click()');
  const after = await evaluate('window.table.playerViews');
  assert.equal(after.spreader.zoom, views.spreader.zoom);
  assert.ok(after.curber.zoom < views.curber.zoom);
  const target = await evaluate(`(() => {
    const g = window.table.game;
    const p = g.agents.find(p => g.agents.filter(q => Math.hypot(q.x-p.x, q.z-p.z) <= 300).length >= 10);
    g.seed(p.x, p.z); g.points.spreader = 100; g.points.curber = 100;
    return {x:p.x,z:p.z};
  })()`);
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await evaluate('!document.querySelector("[data-act=party]").disabled')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await evaluate('document.querySelector("[data-act=party]").click()');
  const leftRect = gameRect('spreader',1440,900);
  const pixels = { x:leftRect.x + leftRect.width / 2 + (target.x-after.spreader.x)*leftRect.width/after.spreader.zoom, y:leftRect.y+leftRect.height/2+(target.z-after.spreader.z)*leftRect.width/after.spreader.zoom };
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pixels.x, y: pixels.y });
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await evaluate('!document.querySelector("[data-map=spreader] .target-preview").hidden')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await evaluate('document.querySelector("[data-map=spreader] .target-preview").hidden'), false);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: pixels.x, y: pixels.y, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pixels.x, y: pixels.y, button: 'left', clickCount: 1 });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await evaluate('window.table.game.actionLog.at(-1).kind'), 'party');
  assert.ok(await evaluate('document.querySelector("[data-map=spreader] .action-pin").textContent.includes("Party")'));
  assert.equal(await evaluate('document.querySelectorAll("[data-map=curber] .action-pin").length'), 0);
  assert.ok(await evaluate('document.getElementById("g-effects-spreader").textContent.includes("Active")'));
  assert.equal(await evaluate('document.querySelectorAll("[data-rally], [data-reveal]").length'), 0);
  assert.equal(await evaluate('getComputedStyle(document.querySelector("[data-player=spreader] .private-controls")).display'), 'grid');
  assert.ok(await evaluate('document.querySelector("[data-act=party]").getBoundingClientRect().height >= 68'));
  assert.ok(await evaluate('document.querySelector("[data-zoom]").getBoundingClientRect().height >= 48'));
  assert.equal(await evaluate('document.querySelectorAll("[data-repeat]").length'), 0);
  await evaluate('document.querySelector("[data-act=lockdown]").click()');
  const rightRect = gameRect('curber',1440,900);
  const rightPixels = {x:rightRect.x+rightRect.width/2+(target.x-after.curber.x)*rightRect.width/after.curber.zoom, y:rightRect.y+rightRect.height/2+(target.z-after.curber.z)*rightRect.width/after.curber.zoom};
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: rightPixels.x, y: rightPixels.y, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rightPixels.x, y: rightPixels.y, button: 'left', clickCount: 1 });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await evaluate('window.table.game.actionLog.at(-1).kind'), 'lockdown');
  assert.ok(await evaluate('document.querySelector("[data-map=curber] .action-pin").textContent.includes("Pending")'));
  assert.equal(await evaluate('document.querySelector("[data-map=spreader]").textContent.includes("Lockdown")'), false);
  const count = await evaluate('Number(document.getElementById("g-infected").textContent.replaceAll(",", "")) + Number(document.getElementById("g-noninfected").textContent.replaceAll(",", ""))');
  assert.equal(count, await evaluate('window.table.game.population'));
  await evaluate('document.querySelector("[data-act=fakenews]").click(); document.querySelector("[data-act=education]").click()');
  assert.equal(await evaluate('window.table.game.actionLog.at(-2).kind'), 'fakenews');
  assert.equal(await evaluate('window.table.game.actionLog.at(-1).kind'), 'education');
  assert.ok(await evaluate('document.getElementById("g-effects-spreader").textContent.includes("Spread fake news")'));
  assert.ok(await evaluate('document.getElementById("g-effects-curber").textContent.includes("Health education")'));
  assert.equal(await evaluate('document.getElementById("g-effects-spreader").textContent.includes("Health education")'), false);
  assert.equal(await evaluate('document.getElementById("g-effects-curber").textContent.includes("Spread fake news")'), false);
  assert.deepEqual(errors, []);
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(tmpdir(), 'traffic-game-interactions.png'), Buffer.from(screenshot.data, 'base64'));
  console.log('Independent zoom, target preview, party placement, private pins, visible enlarged controls, cooldowns and shared totals passed.');
  await command('Page.navigate', { url: 'http://localhost:5173/?game&players=1' });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await evaluate('!!window.table?.game && document.body.classList.contains("one-player") && !document.getElementById("loading")')) break;
    if (attempt === 119) throw Error('Single-player game did not load');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const layout = await evaluate('({ map:document.querySelector("[data-map=spreader]").getBoundingClientRect().width, feed:document.getElementById("g-feed").getBoundingClientRect().width, curber:getComputedStyle(document.querySelector("[data-player=curber]")).display })');
  assert.ok(Math.abs(layout.map - soloLayout(1440,900).width) < 1);
  assert.equal(layout.feed, soloLayout(1440,900).right);
  assert.equal(layout.curber, 'none');
  assert.equal(await evaluate('window.table.game.winner'), undefined);
  assert.deepEqual(errors, []);
  console.log('Updated single-player menu and layout passed with no winner field.');
  await command('Page.navigate', { url: 'http://localhost:5173/?game&players=1&role=curber' });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await evaluate('window.table?.game?.soloRole === "curber" && !document.getElementById("loading")')) break;
    if (attempt === 119) throw Error('Curber solo game did not load');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(await evaluate('getComputedStyle(document.querySelector("[data-player=curber]")).display'), 'block');
  assert.ok(await evaluate('document.querySelector("[data-map=curber]").getBoundingClientRect().width > 800'));
  assert.deepEqual(errors, []);
  console.log('New Curber solo role loads with its controls and centered map.');
} finally { await command('Browser.close').catch(() => {}); ws.close(); }
