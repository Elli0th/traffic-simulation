// Runs the same stretch of the day with a set of planned changes, off the main thread, and reports
// how traffic fared. Two of these run side by side: one with the plan and one without.
// Road vehicles only: trams and pedestrians are left out to keep it quick.

import { Sim } from './sim.js';

const maps = {};

onmessage = async ({ data }) => {
  const { mapUrl, edits, blobs, start, hours } = data;
  maps[mapUrl] ??= await (await fetch(mapUrl)).json();
  // Begin ten minutes early so the streets are already busy when measuring starts.
  const sim = new Sim(maps[mapUrl], { clock: (((start - 1 / 6 + 24) % 24) * 3600) });
  sim.setEdits(edits);
  sim.setBlobs(blobs);
  const dt = 0.15;
  for (let t = 0; t < 600; t += dt) sim.step(dt);
  sim.stats = { started: 0, arrived: 0, lost: 0, tripTime: 0 };

  const slots = []; // one per quarter of an hour: mean speed and vehicles on the road
  let driving = 0; // vehicle-seconds
  let ambulance = 0;
  let ambulanceSamples = 0;
  let unreachable = 0;
  const total = hours * 3600;
  for (let slot = 0; slot * 900 < total; slot++) {
    let speed = 0;
    let vehicles = 0;
    let samples = 0;
    for (let t = 0; t < 900; t += dt) {
      sim.step(dt);
      driving += sim.cars.length * dt;
      if (Math.round(t / dt) % 100 === 0) {
        speed += sim.meanSpeed();
        vehicles += sim.cars.length;
        samples++;
      }
    }
    const e = sim.emergency();
    if (e) {
      ambulance += e.time;
      ambulanceSamples++;
    } else unreachable++;
    slots.push({ speed: speed / samples, vehicles: vehicles / samples });
    postMessage({ progress: ((slot + 1) * 900) / total });
  }
  const s = sim.stats;
  postMessage({
    done: true,
    slots,
    speed: slots.reduce((sum, x) => sum + x.speed, 0) / slots.length,
    trips: s.arrived,
    tripMinutes: s.arrived ? s.tripTime / s.arrived / 60 : 0,
    abandoned: s.lost,
    drivingHours: driving / 3600,
    ambulanceMinutes: ambulanceSamples ? ambulance / ambulanceSamples / 60 : null,
    ambulanceCut: unreachable,
  });
};
