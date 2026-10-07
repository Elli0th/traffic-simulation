// Computes asymmetric tactical intelligence for the Spreader and Curber dashboards.
// Translates raw simulation state into high-level actionable metrics and feeds.

import { ACTIONS, DAY, POPULATION, HOSPITAL } from '../virus.js';

// Gothenburg district centroids for translating (x, z) coordinates into human-readable locations
const DISTRICTS = [
  { name: 'Nordstaden & Centralen', x: 1200, z: 950, radius: 400 },
  { name: 'Inom Vallgraven', x: 950, z: 1200, radius: 350 },
  { name: 'Haga & Järntorget', x: 600, z: 1400, radius: 350 },
  { name: 'Vasastaden', x: 850, z: 1550, radius: 350 },
  { name: 'Lorensberg & Avenyn', x: 1200, z: 1450, radius: 400 },
  { name: 'Heden', x: 1450, z: 1400, radius: 350 },
  { name: 'Majorna / Stigbergstorget', x: 300, z: 1600, radius: 450 },
  { name: 'Lindholmen / Älvstranden', x: 750, z: 650, radius: 450 },
];

export function resolveDistrict(x, z) {
  if (x == null || z == null) return 'Gothenburg Metropolitan';
  let best = DISTRICTS[0];
  let minD = Infinity;
  for (const d of DISTRICTS) {
    const dist = Math.hypot(d.x - x, d.z - z);
    if (dist < minD) {
      minD = dist;
      best = d;
    }
  }
  return best.name;
}

export function buildDashboardPayload(game, actionHistory = [], roundTime = 0) {
  if (!game) return null;

  const counts = game.counts();
  const total = Math.max(1, game.total);
  const scale = game.scale || POPULATION / total;
  const gameTime = game.time;
  const day = Math.min(60, Math.floor(gameTime / DAY) + 1);
  const timeLeft = Math.max(0, 180 - roundTime);

  // 1. Resolve Last Actions
  const spreaderActions = actionHistory.filter((a) => a.side === 'spreader');
  const curberActions = actionHistory.filter((a) => a.side === 'curber');

  const formatAction = (a) => {
    if (!a) return { label: 'None yet', timeAgo: '-', status: 'Idle', target: 'None' };
    const elapsed = Math.round(gameTime - a.gameTime);
    const remaining = a.duration ? Math.max(0, a.duration - elapsed) : 0;
    const isActive = remaining > 0 || a.duration === Infinity;
    return {
      name: a.name,
      label: a.label || ACTIONS[a.name]?.label || a.name,
      target: a.targetDesc || resolveDistrict(a.x, a.z),
      timeAgo: `${Math.max(0, Math.floor(elapsed / 60))}m ${elapsed % 60}s ago`,
      remainingSec: remaining,
      active: isActive,
      status: isActive ? 'ACTIVE' : 'COMPLETED',
    };
  };

  const lastSpreader = formatAction(spreaderActions[spreaderActions.length - 1]);
  const lastCurber = formatAction(curberActions[curberActions.length - 1]);

  // 2. Compute Spreader Actionable Intel
  // Identify high-density districts with susceptible people not covered by lockdowns
  const activeLockdowns = game.lockdowns.filter((z) => (z.start || 0) <= gameTime && z.until > gameTime);
  const activeParties = game.parties.filter((p) => p.until > gameTime);

  const targets = DISTRICTS.map((d) => {
    const isLocked = activeLockdowns.some((z) => Math.hypot(z.x - d.x, z.z - d.z) < (z.r || 220) + 100);
    // Count susceptible agents near this district
    let susCount = 0;
    for (const p of game.agents) {
      if (p.inf === 0 && Math.hypot(p.x - d.x, p.z - d.z) < d.radius) susCount++;
    }
    const realSus = Math.round(susCount * scale);
    return {
      district: d.name,
      susceptible: realSus,
      locked: isLocked,
      score: isLocked ? 0 : realSus,
    };
  })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  // Transit vectors
  const transitCases = Math.round((game.fromTransit || 0) * scale);

  // Spreader action cards deck
  const spreaderDeck = ['party', 'antimask', 'antivaxx', 'sickwork'].map((k) => {
    const act = ACTIONS[k];
    const readyAt = game.ready[k] || 0;
    const cooldown = Math.max(0, readyAt - gameTime);
    const available = game.available(k);
    return {
      key: k,
      label: act.label,
      cost: act.cost,
      cooldownSec: cooldown,
      ready: cooldown <= 0,
      affordable: game.points.spreader >= act.cost,
      available,
    };
  });

  // 3. Compute Curber Actionable Intel
  // Identify top active infection hotspots from game heat
  const heatCells = game.heat ? game.heat(120) : [];
  const hotspots = heatCells
    .slice(0, 3)
    .map((c) => {
      const loc = resolveDistrict(c.x, c.z);
      const isLocked = activeLockdowns.some((z) => Math.hypot(z.x - c.x, z.z - c.z) < (z.r || 220));
      return {
        district: loc,
        cases: Math.round(c.n * scale),
        locked: isLocked,
        recommendation: isLocked ? 'CONTAINED' : 'QUARANTINE RECOMMENDED',
      };
    });

  // Hospital & ICU stress
  const hospitalized = counts.people.hospital;
  const hospitalCapacity = Math.round(POPULATION * 0.015); // baseline capacity ~9,000 beds
  const hospitalStress = Math.min(100, Math.round((hospitalized / hospitalCapacity) * 100));

  // Vaccine progress
  const vaccinatedCount = counts.people.immune;
  const vaccinatedPct = Math.round((counts.r / total) * 100);
  const vaccineUptakeNormal = !game.effects.some((e) => e.kind === 'antivaxx' && e.until > gameTime);

  // Curber action deck
  const curberDeck = ['lockdown', 'vaccines', 'distancing', 'hospitals', 'newvaccine'].map((k) => {
    const act = ACTIONS[k];
    const readyAt = game.ready[k] || 0;
    const cooldown = Math.max(0, readyAt - gameTime);
    const available = game.available(k);
    return {
      key: k,
      label: act.label,
      cost: act.cost,
      cooldownSec: cooldown,
      ready: cooldown <= 0,
      affordable: game.points.curber >= act.cost,
      available,
    };
  });

  return {
    gameTime,
    day,
    timeLeft,
    phase: game.phase,
    population: game.population || POPULATION,
    counts,
    scale,
    points: {
      spreader: Math.floor(game.points.spreader),
      curber: Math.floor(game.points.curber),
    },
    lastActions: {
      spreader: lastSpreader,
      curber: lastCurber,
    },
    spreaderIntel: {
      targets,
      transitCases,
      activeParties: activeParties.length,
      deck: spreaderDeck,
      recommended: targets[0] ? `Host Party in ${targets[0].district} (${targets[0].susceptible.toLocaleString()} unprotected)` : 'Infiltrate workplace',
    },
    curberIntel: {
      hotspots,
      hospitalized,
      hospitalCapacity,
      hospitalStress,
      vaccinatedCount,
      vaccinatedPct,
      vaccineEfficacy: Math.round((game.vaccineEfficacy || 0.65) * 100),
      vaccineUptakeStatus: vaccineUptakeNormal ? '85% (Normal)' : '25% (Suppressed by Disinformation!)',
      activeLockdowns: activeLockdowns.length,
      deck: curberDeck,
      recommended: hotspots.find((h) => !h.locked) ? `Lockdown ${hotspots.find((h) => !h.locked).district}` : 'Roll out Free Vaccines citywide',
    },
  };
}
