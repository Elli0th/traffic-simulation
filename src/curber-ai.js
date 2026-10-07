// The computer's Curber for the one-player game. Pure logic, no rendering.
// It plays by the same rules as a person: it spends the same points and uses game.act(), so cooldowns,
// delays and costs all apply. It is deliberately lenient so the Spreader gets a real chance to spread:
// it does not notice a small outbreak, takes about a week of game days to react once it does, acts at
// a leisurely pace, and aims its lockdowns by eye rather than exactly.

import { mulberry32 } from './geometry.js';
import { DAY } from './virus.js';

export const SOLO_CURBER_AI = { notice: 0.025, reaction: 900, pace: [720, 1080] };

export const AI = {
  notice: 0.012, // share of the city that must have caught it before the computer takes it seriously
  reaction: 7 * DAY, // then it waits this long (a week of game days) before the first move
  pace: [4 * DAY, 8 * DAY], // and this long (min, max) between moves after that
  sloppy: 0.4, // chance a lockdown goes on the second or third worst area instead of the worst
  jitter: 160, // metres a lockdown can land away from where it was aimed
};

// What it does, in order of preference.
const PLAN = [
  { kind: 'distancing' },
  { kind: 'lockdown', hotspot: true },
  { kind: 'vaccines' },
  { kind: 'hospitals' },
  { kind: 'lockdown', hotspot: true },
  { kind: 'newvaccine' },
];

const REPEAT = { kind: 'lockdown', hotspot: true };

export class CurberAI {
  constructor(game, { seed = 77, onAct = null, onNotice = null, tuning = {} } = {}) {
    this.game = game;
    this.rand = mulberry32(seed);
    this.onAct = onAct;
    this.onNotice = onNotice;
    this.cfg = { ...AI, ...tuning };
    this.noticedAt = null;
    this.nextAt = 0;
    this.step_ = 0; // how far through PLAN it is
    this.checked = 0;
    this.log = []; // [time, text] of what it has done
  }

  pace() {
    const [a, b] = this.cfg.pace;
    return a + this.rand() * (b - a);
  }

  // Called as often as you like; it looks at the outbreak every few simulated seconds.
  step() {
    const g = this.game;
    if (g.phase !== 'running' || g.time - this.checked < 5) return;
    this.checked = g.time;
    const c = g.counts();
    if (this.noticedAt === null) {
      if (c.share < this.cfg.notice) return;
      this.noticedAt = g.time;
      this.onNotice?.(g.time);
      this.nextAt = g.time + this.cfg.reaction * (0.8 + 0.4 * this.rand());
      return;
    }
    if (g.time < this.nextAt) return;

    // Once the plan has run out, it keeps locking down the worst area whenever the outbreak is still big.
    const done = this.step_ >= PLAN.length;
    const item = done ? REPEAT : PLAN[this.step_];
    if (done && c.active / g.total < 0.02) {
      this.nextAt = g.time + this.pace();
      return;
    }
    if (!g.available(item.kind)) {
      // Saving up for it, or still on cooldown: try again soon, without skipping the item.
      if (this.waited(item)) this.advance();
      return;
    }
    const at = item.hotspot ? this.aim() : {};
    if (item.hotspot && !at) {
      this.nextAt = g.time + 30;
      return;
    }
    if (g.act(item.kind, at.x, at.z)) {
      this.log.push([g.time, item.kind]);
      this.onAct?.(item.kind, at, g.time);
      this.advance();
    }
  }

  // Gives up on an item it cannot afford for far too long, so one expensive step cannot stall it for ever.
  waited(item) {
    this.stuck = (this.stuck ?? 0) + 1;
    if (this.stuck < 200) return false; // 200 looks, about 1000 simulated seconds
    return item.kind !== 'lockdown';
  }

  advance() {
    this.stuck = 0;
    this.step_++;
    this.nextAt = this.game.time + this.pace();
  }

  // The worst-looking area, give or take: where the computer thinks the outbreak is.
  aim() {
    const cells = [...this.game.heat(100)].sort((a, b) => b.n - a.n);
    if (!cells.length) return null;
    const pick = this.rand() < this.cfg.sloppy ? cells[Math.min(cells.length - 1, 1 + Math.floor(this.rand() * 2))] : cells[0];
    const j = this.cfg.jitter;
    return { x: pick.x + (this.rand() * 2 - 1) * j, z: pick.z + (this.rand() * 2 - 1) * j };
  }
}
