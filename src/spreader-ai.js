// Aggressive solo opponent: imports are explicit, limited, and announced to the player.
import { E, I, S } from './virus.js';
export class SpreaderAI {
  constructor(game, onAct) { this.game = game; this.onAct = onAct; this.nextAt = 0; this.waveAt = 0; this.cursor = 0; }
  start() {
    const g = this.game;
    if (g.phase !== 'setup') return;
    const count = Math.max(4, Math.ceil(g.total * 0.008));
    for (let i = 0; i < count; i++) {
      const p = g.agents[Math.floor(i * g.total / count)];
      g.infect(p, true, null);
      p.inf = I; p.infT = g.base.infectious; p.workUntil = 240;
    }
    g.phase = 'running'; this.waveAt = 450;
  }
  step() {
    const g = this.game;
    if (g.phase !== 'running' || g.time < this.nextAt) return;
    this.nextAt = g.time + 90;
    if (g.soloRole === 'curber' && g.time >= this.waveAt) {
      this.waveAt = g.time + 450;
      // Imported cases keep pressure on new districts without bypassing protection or lockdown.
      let count = 0;
      for (let i = 0; i < g.total && count < Math.max(2, Math.ceil(g.total * 0.003)); i++) {
        const p = g.agents[(this.cursor++ % g.total)];
        if (p.inf !== S || p.vac || g.inLockdown(p)) continue;
        g.infect(p, true, null); count++;
      }
      if (count) this.onAct?.('imports', {}, g.time);
    }
    const sick = g.agents.filter(p => (p.inf === I || p.inf === E) && !p.iso && !g.inLockdown(p));
    const at = sick.length ? sick[Math.floor(g.rand() * sick.length)] : null;
    const choices = ['antimask', 'antivaxx', 'sickwork', 'party'];
    // Rotate actions, and fall back if a local action cannot find a suitable target.
    for (let i = 0; i < choices.length; i++) {
      const kind = choices[(Math.floor(g.time / 90) + i) % choices.length];
      if (!g.available(kind) || (['sickwork', 'party'].includes(kind) && !at)) continue;
      if (g.act(kind, at?.x, at?.z)) { this.onAct?.(kind, at || {}, g.time); break; }
    }
  }
}
