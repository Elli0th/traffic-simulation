import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TRENCH_RADIUS, pointSegmentDistance, crossesTrench, fitTrenchLine } from '../src/trench-geometry.js';
import { TrenchEffects } from '../src/trench-effects.js';
import { Outbreak, S, I } from '../src/virus.js';
import { stepOutbreakWorld } from '../src/game-runtime.js';
const line=[{x:100,z:20},{x:100,z:180}];
assert.equal(pointSegmentDistance({x:130,z:100},...line),30);
assert.ok(crossesTrench({x:50,z:100},{x:150,z:100},...line));
assert.ok(crossesTrench({x:75,z:100},{x:80,z:100},...line));
assert.equal(crossesTrench({x:20,z:100},{x:60,z:100},...line),false);
assert.equal(crossesTrench({x:50,z:250},{x:150,z:250},...line),false,'Walk around a finite trench end');
const agents=[{x:50,z:100,out:true,edge:0,s:50,dir:1,dx:1,dz:0,threshold:0}];
const people={agents,step(){ Object.assign(agents[0],{x:150,s:150}); }};
const game=new Outbreak(people); game.configureSolo('curber'); game.phase='running'; game.time=600; game.points.curber=100;
assert.ok(game.addBarrier(line)); assert.equal(game.barriers[0].until,Infinity);
const sim={time:0,clock:0,stepSignals(){}};
stepOutbreakWorld(sim,people,game,.25);
assert.equal(agents[0].x,50); assert.equal(agents[0].s,50,'Rewind road progress with the blocked position');
assert.ok(game.inTrench({x:100,z:100}));
assert.equal(game.inTrench({x:100+TRENCH_RADIUS+1,z:100}),false);
// Contact transmission must stop even if the virus has enough reach to jump the gap.
const contacts=new Outbreak({agents:[{x:65,z:100,out:true},{x:135,z:100,out:true}]});
contacts.phase='running'; contacts.barriers=[{points:line,until:Infinity}];
contacts.agents[0].inf=I; contacts.agents[1].inf=S;
contacts.rand=()=>0; const cells=new Map([[0,contacts.agents]]);
contacts.expose(contacts.agents[0],cells,200,100);
assert.equal(contacts.agents[1].inf,S);
const scene=new THREE.Scene(),ground=new THREE.Group();
const groundMaterial=new THREE.MeshBasicMaterial();
ground.add(new THREE.Mesh(new THREE.PlaneGeometry(200,200),groundMaterial));
const buildings=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());
const effect=new TrenchEffects(scene,{size:[200,200],cell:10,boxes:[9,9,2,20,0,0]},ground,buildings);
effect.commit({points:line},600);
const remote=new TrenchEffects(new THREE.Scene(),{size:[200,200],cell:10,boxes:[9,9,2,20,0,0]},new THREE.Group(),new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial()));
remote.commit({points:line},600);
assert.deepEqual(remote.shards,effect.shards,'TV and main game use identical explosion trajectories');
assert.ok(effect.version>0);
assert.equal(effect.maskData[256*512+256],255,'Terrain at the trench is removed');
assert.equal(effect.maskData[256*512+20],0,'Unhit landscape remains');
assert.ok(effect.shards.some(p=>p.color==='#89929f'),'Hit building blocks produce rubble');
effect.draw({time:615,barrierPreview:null},true);
assert.ok(effect.pieces.count>0); assert.ok(effect.flashes.count>0);
assert.ok(effect.fireballs.count>0); assert.ok(effect.dust.count>0);
assert.ok(effect.impact(615).strength>0);
effect.reducedMotion=true; assert.equal(effect.impact(615).strength,0);
effect.reducedMotion=false;
const positions=effect.pieces.instanceMatrix.array.slice();
effect.draw({time:615,barrierPreview:null},true);
assert.deepEqual(effect.pieces.instanceMatrix.array,positions,'Pause freezes particle positions');
effect.draw({time:900,barrierPreview:null},true);
assert.equal(effect.pieces.count,0); assert.equal(effect.flashes.count,0);
assert.equal(effect.pieces.visible,false,'Pieces mesh hidden when particle count is zero');
assert.equal(effect.flashes.visible,false,'Flashes mesh hidden when particle count is zero');
assert.equal(effect.fireballs.visible,false,'Fireballs mesh hidden when particle count is zero');
assert.equal(effect.dust.visible,false,'Dust mesh hidden when particle count is zero');
assert.equal(effect.maskData[256*512+256],255,'The black trench remains after the explosion');

// Test 2D PCA line fitting through a scattered cloud of taps:
const horizontalCloud = [{x:100,z:50},{x:150,z:48},{x:200,z:52},{x:260,z:50}];
const hFit = fitTrenchLine(horizontalCloud);
assert.ok(hFit);
assert.ok(hFit.length >= 155 && hFit.length <= 165);
assert.ok(Math.abs(hFit.start.z - 50) < 3 && Math.abs(hFit.end.z - 50) < 3);

const diagonalCloud = [{x:10,z:10},{x:50,z:48},{x:100,z:102},{x:150,z:148}];
const dFit = fitTrenchLine(diagonalCloud);
assert.ok(dFit);
assert.ok(dFit.length >= 190);

const tinyCloud = [{x:10,z:10},{x:12,z:11},{x:11,z:13}];
assert.equal(fitTrenchLine(tinyCloud, 40), null, 'Rejects clouds under 40m');

for(const material of [groundMaterial,buildings.material]) {
  const shader={uniforms:{},vertexShader:THREE.ShaderLib.basic.vertexShader,fragmentShader:THREE.ShaderLib.basic.fragmentShader};
  material.onBeforeCompile(shader,{});
  assert.ok(shader.vertexShader.includes('instanceMatrix * trenchPoint'));
  assert.ok(shader.fragmentShader.includes('texture2D(trenchMask'));
  assert.ok(shader.uniforms.trenchMask.value===effect.mask);
}
console.log('Trench width, movement, contact blocking, actual terrain/building damage mask, explosions, pause, 2D PCA line fitting and persistence passed.');
