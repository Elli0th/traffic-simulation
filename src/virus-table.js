// The outbreak game (virus.js) played on the table itself rather than with the mouse and keyboard,
// and shown on the screens. It changes none of the rules or the layout: it lets hands and objects
// press the same buttons and click the same maps.
//
// The picture is split down the middle, the Spreader's map on the left and the Curber's on the
// right, each with its panel of controls underneath. With the room's sensors:
//
//   a hand or object held on a button      presses it (Show / hide, an action, + and -, Play again)
//   an object put down on your own map     plays there: the Spreader's first one places patient
//                                          zero; after that it is the action chosen on the panel,
//                                          or a party (Spreader) or a lockdown (Curber) if none is
//
// Whose piece it is follows from which half of the table it stands on. An object has to sit still
// for a second before it counts, so an arm reaching across the map does nothing.
//
// Open the table with ?game=table. The screens (?game&view=screen) show the public numbers.

import * as THREE from 'three';
import { sideAt } from './game-view.js';

const HOLD = 1; // seconds a hand must stay on a button, or a piece on the map
const SAME = 0.03; // a piece that has moved less than this share of the picture is still the same piece
const RETRY = 1; // seconds between tries for a piece that could not be played yet
const DEFAULT = { spreader: 'party', curber: 'lockdown' }; // what a piece does when nothing is chosen

const CSS = `
  #vt-board { position: fixed; inset: 0 0 auto; padding: 14px 24px; background: #101720; font-size: 2.2vh; }
  #vt-board h2 { display: flex; justify-content: space-between; margin: 0 0 6px; font-size: 2.2vh; letter-spacing: 0.14em; text-transform: uppercase; color: #9aa4b2; }
  #vt-board .totals { display: flex; gap: 4vw; }
  #vt-board .totals b { margin-left: 1vw; font-size: 4.4vh; font-variant-numeric: tabular-nums; }
  #vt-board .totals span:first-child b { color: #ff4545; }
  #vt-board .totals span:last-child b { color: #50dda5; }
  #vt-board p { margin: 6px 0 0; color: #cfd6e0; }
`;

// `room` is what the table page gives this to work with:
//   game      the Outbreak, or null in a window that only follows (a screen)
//   follower  true for a screen
//   onTable   true when the table is played with pieces and hands (?game=table)
//   act       does one of a player's actions, as their button or a click on their map would
//   armed     the action a player has chosen that is waiting for its place on the map, if any
//   pick      turns a point of the window into metres on that player's map
//   relay, pool, putBox
export function startTablePlay(room) {
  const { game, follower, onTable, relay, act, armed, pick } = room;
  const text = (id) => document.getElementById(id).textContent;

  // ----- the screens: the numbers everyone may see, and the glowing squares where the virus is -----

  if (follower) {
    document.head.appendChild(Object.assign(document.createElement('style'), { textContent: CSS }));
    document.body.classList.add('nohud');
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="vt-board"><h2>Outbreak <span data-time></span></h2><div class="totals"><span>Infected <b data-infected>0</b></span><span>Non-infected <b data-noninfected>0</b></span></div><p data-status></p></div>',
    );
    const board = document.getElementById('vt-board');
    const squares = room.pool(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5, depthTest: false }), 3000, 1);
    const tint = new THREE.Color();
    relay.on('virus', (v) => {
      board.querySelector('[data-time]').textContent = v.time;
      board.querySelector('[data-infected]').textContent = v.infected;
      board.querySelector('[data-noninfected]').textContent = v.noninfected;
      board.querySelector('[data-status]').textContent = v.over ? `${v.over.win} ${v.over.sum}` : v.status;
      let n = 0;
      for (let k = 0; k < v.heat.length && n < 3000; k += 3) {
        const s = Math.min(1, v.heat[k + 2] / 5);
        room.putBox(squares, n++, v.heat[k], 0.9, v.heat[k + 1], 1, 0, 96, 0.4, 96, tint.setRGB(1, 0.65 * (1 - s), 0.1 * (1 - s)));
      }
      squares.count = n;
      squares.instanceMatrix.needsUpdate = true;
      if (squares.instanceColor) squares.instanceColor.needsUpdate = true;
    });
    return { pieces: false, update() {} };
  }

  // ----- the table -----

  const held = new Map(); // button -> seconds a hand has been on it; Infinity once it has been pressed
  let pieces = []; // what is standing on the maps: { x, y, still, done, next }
  let toldAt = 0;

  // The button of the game under a point of the window, if there is one to press.
  function buttonAt(x, y) {
    for (const node of document.elementsFromPoint(x, y)) {
      const b = node.closest?.('#game button, #g-over button');
      if (b && !b.disabled) return b;
    }
    return null;
  }

  // A piece that has stood still long enough: play it. Returns false if it could not be done yet.
  function place(piece, side) {
    const p = pick({ clientX: piece.x * innerWidth, clientY: piece.y * innerHeight }, side);
    if (!p) return false;
    if (game.phase === 'setup') {
      if (side !== 'spreader') return false;
      act(side, 'seed', p);
      return game.phase === 'running';
    }
    const kind = armed(side) || DEFAULT[side];
    if (!game.available(kind)) return false; // waits for the points or the cooldown without complaining
    const before = game.points[side];
    act(side, kind, p);
    return game.points[side] < before;
  }

  // sensed: what the room's sensors see, as fractions of the picture: [{ x, y, r }].
  function hands(dt, sensed) {
    const touched = new Set();
    const onMap = [];
    for (const b of sensed) {
      const x = b.x * innerWidth;
      const y = b.y * innerHeight;
      const button = buttonAt(x, y);
      if (button) touched.add(button);
      else if (sideAt(x, y, innerWidth, innerHeight)) onMap.push(b);
    }
    for (const b of held.keys()) {
      if (touched.has(b)) continue;
      b.style.outline = '';
      held.delete(b);
    }
    for (const b of touched) {
      const t = held.get(b) || 0;
      if (t === Infinity) continue;
      b.style.outline = '3px solid #ffffff';
      if (t + dt < HOLD) held.set(b, t + dt);
      else {
        held.set(b, Infinity);
        b.style.outline = '';
        b.click();
      }
    }

    // Pieces: each is played once, after it has stood still, and again only if it is lifted and put back.
    const now = [];
    for (const b of onMap) {
      const old = pieces.find((p) => Math.hypot(p.x - b.x, p.y - b.y) < SAME && !now.includes(p));
      const piece = old || { x: b.x, y: b.y, still: 0, done: false, next: 0 };
      piece.still += dt;
      piece.next -= dt;
      if (!piece.done && piece.still >= HOLD && piece.next <= 0 && game.phase !== 'over') {
        piece.done = place(piece, sideAt(piece.x * innerWidth, piece.y * innerHeight, innerWidth, innerHeight));
        piece.next = RETRY;
      }
      now.push(piece);
    }
    pieces = now;
  }

  return {
    // True when what the sensors see are the game's pieces, so the table must not close streets under them.
    pieces: onTable,
    // Once a frame, with the real seconds since the last one.
    update(dt, sensed) {
      if (onTable) hands(dt, sensed);
      const t = performance.now();
      if (t - toldAt < 500) return;
      toldAt = t;
      const heat = [];
      for (const c of game.heat(100)) heat.push(Math.round(c.x), Math.round(c.z), c.n);
      relay.send('virus', {
        time: text('g-time'),
        infected: text('g-infected'),
        noninfected: text('g-noninfected'),
        status: text('g-status'),
        over: game.phase === 'over' ? { win: text('g-win'), sum: text('g-sum') } : null,
        heat,
      });
    },
  };
}
