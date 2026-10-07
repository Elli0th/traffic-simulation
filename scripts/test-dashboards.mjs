// Tests for the asymmetric TV dashboards and reactive Hue lighting.
//
//   node scripts/test-dashboards.mjs

import assert from 'node:assert/strict';
import { Outbreak } from '../src/virus.js';
import { VirusLighting } from '../src/room/hue-lights.js';
import { buildDashboardPayload, resolveDistrict } from '../src/room/dashboard-data.js';

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`ok  ${name}`);
};

// Mock agent world fixture
function makeGame(numAgents = 50) {
  const agents = Array.from({ length: numAgents }, (_, i) => ({
    x: 1000 + (i % 10) * 30,
    z: 1000 + Math.floor(i / 10) * 30,
    out: true,
    inf: 0,
    infT: 0,
    iso: false,
    vac: false,
    vacAt: 0,
    workUntil: 0,
  }));
  const game = new Outbreak({ agents }, { seed: 42 });
  game.phase = 'running';
  game.points = { spreader: 50, curber: 50 };
  return game;
}

// 1. Test Spatial Tug-of-War Hue Lighting
check('spatial hue lights initialize with Left Red, Right Green, Middle White', () => {
  const lighting = new VirusLighting({ enabled: false });
  const game = makeGame();

  // Baseline state (0 infections)
  const base = lighting.computeLighting(game);
  assert.ok(base);
  // Left side: Red (Spreader)
  assert.equal(base.left.hue, 0, 'left lights start pure red');
  assert.equal(base.left.sat, 254);
  // Right side: Green (Curber / Government)
  assert.equal(base.right.hue, 25500, 'right lights start green');
  assert.equal(base.right.sat, 254);
  // Middle: White (Neutral contested zone)
  assert.equal(base.middle.sat, 0, 'middle lights start uncolored white');
  assert.equal(base.middle.ct, 370, 'middle lights use warm/daylight white color temp');
});

check('virus expansion causes red intensity to ramp and spread into middle lights', () => {
  const lighting = new VirusLighting({ enabled: false });
  const game = makeGame();

  // Severe infection state (simulate 60% active infections)
  for (let i = 0; i < 30; i++) {
    game.agents[i].inf = 2; // I
  }
  game.ever = 35;

  const severe = lighting.computeLighting(game);
  assert.ok(severe.balance > 0.5, `balance should strongly favor virus: ${severe.balance}`);
  assert.ok(severe.left.bri > 220, `left red intensity should ramp up: ${severe.left.bri}`);
  assert.ok(severe.middle.hue <= 14000, `red/amber color spreads into center spots: hue ${severe.middle.hue}`);
  assert.ok(severe.middle.sat > 150, `middle lights saturate towards red: sat ${severe.middle.sat}`);
  assert.ok(severe.right.bri < 120, `right green territory dims: bri ${severe.right.bri}`);
});

check('active party triggers maximum spreader left-side burst', () => {
  const lighting = new VirusLighting({ enabled: false });
  const game = makeGame();

  // Add active party
  game.time = 50;
  game.parties.push({ x: 1000, z: 1000, until: 200, members: [] });

  const partyState = lighting.computeLighting(game);
  assert.equal(partyState.left.bri, 254, 'party triggers maximum left strip/spot brightness');
});

check('round ends with neutral lighting regardless of infection levels', () => {
  const lighting = new VirusLighting({ enabled: false });
  const game = makeGame();
  game.phase = 'over';
  game.ever = 25; // >= 30% of 50 agents -> Virus win

  const winState = lighting.computeLighting(game);
  assert.equal(winState.left.ct, 350);
  assert.equal(winState.middle.ct, 350);
  assert.equal(winState.right.ct, 350);
  game.ever = 0;
  assert.deepEqual(lighting.computeLighting(game).middle, winState.middle);
});

// 2. Test Asymmetric Dashboard Intelligence
check('resolveDistrict correctly identifies Gothenburg neighborhoods', () => {
  assert.equal(resolveDistrict(1200, 950), 'Nordstaden & Centralen');
  assert.equal(resolveDistrict(600, 1400), 'Haga & Järntorget');
  assert.equal(resolveDistrict(300, 1600), 'Majorna / Stigbergstorget');
});

check('dashboard payload formats asymmetric last actions for both teams', () => {
  const game = makeGame();
  game.time = 120;

  const history = [
    { side: 'spreader', name: 'party', label: 'Start a party (10 pax)', x: 1200, z: 950, gameTime: 80, duration: 600 },
    { side: 'curber', name: 'lockdown', label: 'Lockdown', x: 600, z: 1400, gameTime: 100, duration: 1800 },
  ];

  const payload = buildDashboardPayload(game, history, 60);
  assert.ok(payload);

  // Spreader action verification
  const spAct = payload.lastActions.spreader;
  assert.equal(spAct.name, 'party');
  assert.equal(spAct.status, 'ACTIVE');
  assert.ok(spAct.remainingSec > 0);
  assert.equal(spAct.target, 'Nordstaden & Centralen');

  // Curber action verification
  const cbAct = payload.lastActions.curber;
  assert.equal(cbAct.name, 'lockdown');
  assert.equal(cbAct.status, 'ACTIVE');
  assert.equal(cbAct.target, 'Haga & Järntorget');
});

check('dashboard computes high-value targets for Spreader and hospital load for Curber', () => {
  const game = makeGame();
  game.time = 150;
  // Make 10 cases infectious
  for (let i = 0; i < 10; i++) game.agents[i].inf = 2;
  game.ever = 10;

  const payload = buildDashboardPayload(game, [], 45);

  // Spreader intel
  assert.ok(payload.spreaderData.targets.length > 0, 'has vulnerable targets');
  assert.ok(payload.spreaderData.targets[0].susceptible > 0);
  assert.ok(payload.spreaderData.deck.length === 4, 'spreader has 4 actions in deck');
  assert.ok(payload.spreaderData.recommended.length > 5);

  // Curber intel
  assert.ok(payload.curberData.deck.length === 5, 'curber has 5 actions in deck');
  assert.ok(payload.curberData.hospitalStress >= 0);
  assert.ok(payload.curberData.recommended.length > 5);
});

check('dashboard enforces genuine information asymmetry between Spreader and Curber', () => {
  const game = makeGame();
  game.time = 150;
  // 10 exposed (latent E, asymptomatic) and 5 infectious (I)
  for (let i = 0; i < 10; i++) game.agents[i].inf = 1; // E
  for (let i = 10; i < 15; i++) game.agents[i].inf = 2; // I
  game.ever = 15;

  const payload = buildDashboardPayload(game, [], 45);

  // Spreader sees ground truth: both E and I are infected, plus stealth carriers
  assert.ok(payload.spreaderData.trueInfectedCount > 0);
  assert.ok(payload.spreaderData.stealthCarriers > 0, 'Spreader sees latent incubation carriers');
  assert.ok(payload.spreaderData.stealthPct > 0);

  // Curber only sees confirmed symptomatic fraction (~45% of I), blind to latent carriers
  assert.ok(payload.curberData.confirmedActiveCount < payload.spreaderData.trueInfectedCount,
    'Curber confirmed cases must be significantly lower than ground truth infected count');
  assert.equal(payload.curberData.approvalRating, undefined, 'No approval score in timed rounds');
});

console.log(`\n${passed} dashboard & lighting tests passed.`);

