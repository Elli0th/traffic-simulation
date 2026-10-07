// The outbreak game (virus.js) played on the table itself rather than with the mouse and keyboard,
// and shown on the screens. It changes none of the rules: it is another way of pressing the same buttons.
//
// The two players sit on opposite long sides. Each has a row of cards along their edge of the
// picture, the Spreader's turned to face them, and plays with what the room's sensors can see:
//
//   a flat object on the map (a puck)     the Spreader seeds the virus there
//   a tall object on the map (a cup)      the Curber locks that zone down, or vaccinates it if the
//                                         Vaccinate card was pressed first
//   a hand or object held on a card       buys that card
//
// The depth camera tells a cup from a puck by its height. An object has to sit still for a second
// before it counts, so an arm reaching across the map does nothing.
//
// Open the table with ?game=table. The screens (?game&view=screen) follow whichever way it is played.

import * as THREE from 'three';

const HOLD = 1; // seconds a hand must stay on a card, or a piece on the map
const SAME = 0.03; // a piece that has moved less than this share of the picture is still the same piece
const RETRY = 1; // seconds between tries for a piece that could not be afforded yet

// The cards, in the order of the buttons in index.html. `how` replaces the keyboard hint there.
const CARDS = [
  { act: 'seed', side: 'spreader', name: 'Seed the virus', how: 'Put a flat piece on the map' },
  { act: 'spread', side: 'spreader', name: 'Spreads faster', how: 'Hold a hand here' },
  { act: 'reach', side: 'spreader', name: 'Airborne reach', how: 'Hold a hand here' },
  { act: 'stealth', side: 'spreader', name: 'Evades tests', how: 'Hold a hand here' },
  { act: 'lockdown', side: 'curber', name: 'Lockdown zone', how: 'Put a cup on the map' },
  { act: 'vaccinate', side: 'curber', name: 'Vaccinate zone', how: 'Hold here, then place a cup' },
  { act: 'masks', side: 'curber', name: 'Mask mandate', how: 'Hold a hand here' },
  { act: 'test', side: 'curber', name: 'Test and trace', how: 'Hold a hand here' },
];
const SPLIT = ['#3b8cff', '#ffb020', '#ff3b30', '#39e6b0']; // as in index.html: well, exposed, infectious, recovered

const CSS = `
  .vt-dock { position: fixed; left: 0; right: 0; height: 13vh; display: flex; gap: 1vw; align-items: stretch;
    padding: 0.8vh 1vw; box-sizing: border-box; background: rgba(6, 8, 12, 0.86); font-size: 1.5vh; pointer-events: none; }
  .vt-dock.curber { bottom: 0; border-top: 2px solid #5ee6a8; }
  .vt-dock.spreader { top: 0; border-bottom: 2px solid #ff6b6b; transform: rotate(180deg); }
  body.vt-screen .vt-dock.spreader { transform: none; }
  .vt-dock .who { width: 30vw; flex: none; }
  .vt-dock h3 { margin: 0 0 0.7vh; white-space: nowrap; font-size: 1.7vh; letter-spacing: 0.14em; text-transform: uppercase; }
  .vt-dock.curber h3 { color: #5ee6a8; }
  .vt-dock.spreader h3 { color: #ff6b6b; }
  .vt-dock h3 b { margin-left: 0.8vw; color: #f3f5f7; font-variant-numeric: tabular-nums; }
  .vt-dock p { margin: 0.5vh 0 0; line-height: 1.3; color: #cfd6e0; }
  .vt-dock p.toast { color: #ffc233; }
  .vt-dock .split { display: flex; height: 1vh; border-radius: 1vh; overflow: hidden; background: #1c222b; }
  .vt-dock .split i { display: block; height: 100%; }
  .vt-dock .cards { flex: 1; display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.7vw; }
  .vt-dock button { position: relative; padding: 0.6vh 0.7vw; text-align: left; color: #e9ecef; background: #1c222b;
    border: 2px solid rgba(255, 255, 255, 0.16); border-radius: 0.8vh; font: inherit; cursor: pointer; pointer-events: auto; overflow: hidden; }
  .vt-dock button strong { display: block; font-size: 1.7vh; }
  .vt-dock button small { display: block; margin-top: 0.3vh; font-size: 1.3vh; color: #9aa4b2; }
  .vt-dock button em { position: absolute; right: 0.6vw; bottom: 0.4vh; font-style: normal; font-size: 1.5vh; font-weight: 600; }
  .vt-dock button.on { color: #06222e; background: #5ad1ff; border-color: #5ad1ff; }
  .vt-dock button.on small { color: #06222e; }
  .vt-dock button.off { opacity: 0.45; }
  .vt-dock button u { position: absolute; left: 0; bottom: 0; height: 0.5vh; width: 0; background: #ffffff; }
  .vt-banner { position: fixed; left: 10vw; right: 10vw; text-align: center; font-size: 3.2vh; font-weight: 600; line-height: 1.3;
    text-shadow: 0 0 1.2vh #000, 0 0 0.4vh #000; pointer-events: none; }
  .vt-banner small { display: block; font-size: 1.9vh; font-weight: 400; color: #c9d1db; }
  .vt-banner.curber { bottom: 17vh; }
  .vt-banner.spreader { top: 17vh; transform: rotate(180deg); }
  body.vt-screen .vt-banner.spreader { display: none; }
  body.vt-on #game, body.vt-on #g-over { display: none; }
`;

// `room` is what the table page gives this to work with:
//   game      the Outbreak, or null in a window that only follows (a screen)
//   follower  true for a screen
//   onTable   true when the table is played with pieces and hands (?game=table)
//   act       presses one of the game's buttons by name, as a click on it would
//   armed     which map action is waiting for its place, if any
//   fromTable turns a position on the picture into metres
//   tall      objects at least this high, in the depth camera's units, are the Curber's
//   relay, pool, putBox
export function startTablePlay(room) {
  const { game, follower, onTable, relay, act, armed, fromTable, tall = 60 } = room;
  const docks = onTable || follower;
  if (docks) {
    document.head.appendChild(Object.assign(document.createElement('style'), { textContent: CSS }));
    document.body.classList.add('vt-on', 'nohud');
    if (follower) document.body.classList.add('vt-screen');
    const dock = (side, title) => `
      <div class="vt-dock ${side}">
        <div class="who"><h3>${title} <b data-points></b></h3><div class="split">${SPLIT.map((c) => `<i style="background:${c}"></i>`).join('')}</div><p data-status></p><p class="toast" data-toast></p></div>
        <div class="cards">${CARDS.filter((c) => c.side === side).map((c) => `<button data-card="${c.act}"><strong>${c.name}</strong><small>${c.how}</small><em></em><u></u></button>`).join('')}</div>
      </div><div class="vt-banner ${side}"></div>`;
    document.body.insertAdjacentHTML('beforeend', dock('spreader', 'Spreader') + dock('curber', 'Curber'));
  }
  const buttons = [...document.querySelectorAll('.vt-dock button')];
  const dockBoxes = [...document.querySelectorAll('.vt-dock')];
  const held = {}; // card -> seconds a hand has been on it; Infinity once it has been pressed
  let pieces = []; // what is standing on the map: { x, y, h, still, done, next }
  let shownAt = 0;
  let toldAt = 0;

  const press = (name) => {
    if (follower) return;
    if (game.phase === 'over') location.reload(); // as the Play again button does
    else act(name);
  };
  for (const b of buttons) b.addEventListener('click', () => press(b.dataset.card));

  // ----- what there is to show, read off the game and its own panel so the two can never disagree -----

  const text = (id) => document.getElementById(id).textContent;
  function view() {
    const heat = [];
    for (const c of game.heat(100)) heat.push(Math.round(c.x), Math.round(c.z), c.n);
    return {
      phase: game.phase,
      status: text('g-status'),
      time: text('g-time'),
      toast: text('g-toast'),
      points: { spreader: text('g-sp'), curber: text('g-cp') },
      split: [...document.getElementById('g-split').children].map((i) => i.style.width),
      cards: CARDS.map(({ act: name }) => {
        const b = document.querySelector(`#game [data-act="${name}"]`);
        // The price is the last thing on the button's small print: "Q · click map · 8".
        return { off: b.disabled, on: b.classList.contains('on'), cost: b.querySelector('small').textContent.split('·').pop().trim() };
      }),
      over: game.phase === 'over' ? { win: text('g-win'), sum: text('g-sum') } : null,
      heat,
    };
  }

  function show(v) {
    for (const d of dockBoxes) {
      const side = d.classList.contains('spreader') ? 'spreader' : 'curber';
      d.querySelector('[data-points]').textContent = `${v.points[side]} points · ${v.time}`;
      d.querySelector('[data-status]').textContent = v.status;
      d.querySelector('[data-toast]').textContent = v.toast;
      [...d.querySelector('.split').children].forEach((i, k) => (i.style.width = v.split[k]));
      d.nextElementSibling.innerHTML = v.over
        ? `${v.over.win}<small>${v.over.sum}${follower ? '' : ' Hold a hand on any card to play again.'}</small>`
        : v.phase === 'setup'
          ? side === 'spreader'
            ? 'Spreader: put your flat piece on a busy street<small>Wherever it lands, the first people catch it.</small>'
            : 'Curber: get ready<small>A cup on the map locks that zone down. Hold a hand on a card to buy it.</small>'
          : '';
    }
    buttons.forEach((b) => {
      const c = v.cards[CARDS.findIndex((x) => x.act === b.dataset.card)];
      b.classList.toggle('on', c.on);
      b.classList.toggle('off', c.off && !v.over && !(v.phase === 'setup' && b.dataset.card === 'seed'));
      b.querySelector('em').textContent = c.cost;
    });
  }

  // ----- the screens: the same panels, and the glowing squares where the virus is -----

  if (follower) {
    const squares = room.pool(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5, depthTest: false }), 3000, 1);
    const tint = new THREE.Color();
    relay.on('virus', (v) => {
      show(v);
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

  const inside = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

  // A piece that has stood still long enough: play it. Returns false if it could not be done yet.
  function place(piece) {
    const p = fromTable(piece);
    if (piece.h !== undefined && piece.h < tall) return game.seed(p.x, p.z);
    if (armed() !== 'vaccinate') return game.lockdown(p.x, p.z);
    if (!game.vaccinate(p.x, p.z)) return false;
    act('vaccinate'); // done: the card is no longer waiting for a place
    return true;
  }

  // sensed: what the room's sensors see, as fractions of the picture: [{ x, y, r, h }].
  function hands(dt, sensed) {
    const touched = new Set();
    const onMap = [];
    const boxes = dockBoxes.map((d) => d.getBoundingClientRect());
    const cardBoxes = buttons.map((b) => b.getBoundingClientRect());
    for (const b of sensed) {
      const x = b.x * innerWidth;
      const y = b.y * innerHeight;
      if (!boxes.some((r) => inside(r, x, y))) onMap.push(b);
      else {
        // On a player's edge of the table: a hand on a card, not a piece on the map.
        const k = cardBoxes.findIndex((r) => inside(r, x, y));
        if (k >= 0) touched.add(buttons[k]);
      }
    }
    for (const b of buttons) {
      const name = b.dataset.card;
      if (!touched.has(b)) held[name] = 0;
      else if (held[name] !== Infinity) {
        held[name] = (held[name] || 0) + dt;
        if (held[name] >= HOLD) {
          held[name] = Infinity;
          press(name);
        }
      }
      b.lastElementChild.style.width = held[name] && held[name] !== Infinity ? `${(held[name] / HOLD) * 100}%` : '0';
    }

    // Pieces: each is played once, after it has stood still, and again only if it is lifted and put back.
    const now = [];
    for (const b of onMap) {
      const old = pieces.find((p) => Math.hypot(p.x - b.x, p.y - b.y) < SAME && !now.includes(p));
      const piece = old || { x: b.x, y: b.y, still: 0, done: false, next: 0 };
      piece.h = b.h;
      piece.still += dt;
      piece.next -= dt;
      if (!piece.done && piece.still >= HOLD && piece.next <= 0 && game.phase !== 'over') {
        piece.done = place(piece);
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
      if (t - shownAt < 250) return;
      shownAt = t;
      const v = view();
      if (onTable) show(v);
      if (t - toldAt < 500) return;
      toldAt = t;
      relay.send('virus', v);
    },
  };
}
