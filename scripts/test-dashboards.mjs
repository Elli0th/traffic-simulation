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

// 1. Test Hue Lighting
check('hue lights ramp from calm cyan to emergency crimson as virus spreads', () => {
  const lighting = new VirusLighting({ enabled: false });
  const game = makeGame();

  // Baseline state (0 infections)
  const base = lighting.computeLighting(game);
  assert.ok(base.threat < 0.05, `baseline threat ${base.threat}`);
  assert.ok(base.spots.bri < 100, `baseline brightness ${base.spots.bri}`);
  assert.ok(base.spots.hue > 30000, `baseline hue ${base.spots.hue} should be cyan`);

  // Severe infection state (simulate 60% active infections)
  for (let i = 0; i < 30; i++) {
    game.agents[i].inf = 2; // I
  }
  game.ever = 35;

  const severe = lighting.computeLighting(game);
  assert.ok(severe.threat > 0.8, `severe threat ${severe.threat}`);
  assert.ok(severe.spots.bri > 220, `severe brightness ${severe.spots.bri} should be glaring`);
  assert.ok(severe.spots.hue < 3000, `severe hue ${severe.spots.hue} should be deep crimson red`);
  assert.ok(severe.spots.sat > 240, `severe saturation ${severe.spots.sat}`);
});

check('active party triggers spreader strip burst', () => {
  const lighting = new VirusLighting({ enabled: false });
  const game = makeGame();

  // No party
  const normal = lighting.computeLighting(game);
  assert.ok(normal.spreaderStrip.bri < 200);

  // Add active party
  game.time = 50;
  game.parties.push({ x: 1000, z: 1000, until: 200, members: [] });

  const partyState = lighting.computeLighting(game);
  assert.equal(partyState.spreaderStrip.bri, 254, 'party triggers maximum strip brightness');
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
  assert.ok(payload.spreaderIntel.targets.length > 0, 'has vulnerable targets');
  assert.ok(payload.spreaderIntel.targets[0].susceptible > 0);
  assert.ok(payload.spreaderIntel.deck.length === 4, 'spreader has 4 actions in deck');
  assert.ok(payload.spreaderIntel.recommended.length > 5);

  // Curber intel
  assert.ok(payload.curberIntel.deck.length === 5, 'curber has 5 actions in deck');
  assert.ok(payload.curberIntel.hospitalStress >= 0);
  assert.ok(payload.curberIntel.recommended.length > 5);
});

console.log(`\n${passed} dashboard & lighting tests passed.`);
