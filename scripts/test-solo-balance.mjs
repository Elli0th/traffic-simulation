import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Sim } from '../src/sim.js';
import { People } from '../src/people.js';
import { Outbreak } from '../src/virus.js';
import { SpreaderAI } from '../src/spreader-ai.js';
import { stepOutbreakWorld } from '../src/game-runtime.js';
const map = JSON.parse(readFileSync(new URL('../public/gbg.json', import.meta.url)));
function run(defend) {
  const sim = new Sim(map, { clock:8*3600 });
  const anchors = [...sim.homes,...sim.works].map(i=>[sim.nodes[i].x,sim.nodes[i].z]);
  const people = new People(map.paths,sim,{walkers:1800,cyclists:260,anchors});
  people.step(1);
  const game = new Outbreak(people,{sim,seed:5}); game.configureSolo('curber');
  const ai = new SpreaderAI(game); ai.start();
  let firstMinute;
  for(let t=0;t<3600;t++) {
    if(defend && t%90===0) {
      const hot = [...game.heat()].sort((a,b)=>b.n-a.n)[0];
      if(hot) { game.act('tracing',hot.x,hot.z); game.act('lockdown',hot.x,hot.z); }
      if(!game.active('vaccines')) game.act('vaccines');
      if(!game.active('distancing')) game.act('distancing');
      if(!game.active('hospitals')) game.act('hospitals');
      if(!game.active('newvaccine')) game.act('newvaccine');
    }
    stepOutbreakWorld(sim,people,game,1); ai.step();
    if(t===1799) firstMinute=game.counts().share;
  }
  return {firstMinute,share:game.counts().share,moves:game.actionLog.length};
}
const idle = run(false), active = run(true);
console.log('Government full round:',JSON.stringify({idle,active}));
assert.ok(idle.firstMinute>0.08,'Unchecked outbreak must pressure the government in the first minute');
assert.ok(idle.share>0.25,'Waiting must not yield an easy government win');
assert.ok(active.share<idle.share,'Government actions must meaningfully improve the score');
assert.ok(idle.moves>15,'Computer must sustain pressure throughout the round');
// Spreader should be able to reach the first power during ordinary party play.
const sim = new Sim(map, {clock:8*3600});
const anchors = [...sim.homes,...sim.works].map(i=>[sim.nodes[i].x,sim.nodes[i].z]);
const people = new People(map.paths,sim,{walkers:1800,cyclists:260,anchors});
people.step(1);
const spreader = new Outbreak(people,{sim,seed:5}); spreader.configureSolo('spreader');
const start = people.agents.find(p=>p.out) || people.agents[0];
assert.ok(spreader.seed(start.x,start.z,200));
const { CurberAI, SOLO_CURBER_AI } = await import('../src/curber-ai.js');
const defender = new CurberAI(spreader, {tuning:SOLO_CURBER_AI});
let firstPowerAt = null, firstMinuteShare = null;
for(let t=0;t<3600;t++) {
  if(t%75===0) {
    const source = spreader.agents.find(p=>p.inf===2 && !p.iso);
    if(source) spreader.act('party',source.x,source.z);
  }
  stepOutbreakWorld(sim,people,spreader,1); defender.step();
  if(firstPowerAt===null && spreader.unlocked('relocate')) firstPowerAt=t/30;
  if(t===1799) firstMinuteShare=spreader.counts().share;
}
console.log('Spreader round:', JSON.stringify({firstPowerAt,firstMinuteShare,finalShare:spreader.counts().share}));
assert.ok(firstPowerAt!==null && firstPowerAt<100,'An active Spreader should unlock relocation with time to use it in a two-minute round');
assert.ok(spreader.counts().share>firstMinuteShare,'Spread should continue growing after the early phase');
