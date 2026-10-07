export const roundDuration = (solo) => solo ? 120 : 180;
// Outbreak mode needs pedestrian movement and crossing signals, not vehicle route planning.
export const GAME_STEP = 0.25;
export function stepOutbreakWorld(sim, people, game, dt) {
  sim.time += dt;
  sim.clock = (sim.clock + dt) % 86400;
  sim.stepSignals(dt);
  game.prepareTrenchMovement?.();
  people.step(dt, (p, normallyOut) => {
    const sickWorker = p.workUntil > game.time && p.inf === 2;
    return (normallyOut || sickWorker) && (!p.iso || sickWorker) &&
      !(p.threshold > 0.1 && game.inLockdown(p));
  });
  game.enforceTrenchMovement?.();
  game.step(dt);
}
