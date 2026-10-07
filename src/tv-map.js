import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {formatDisplayTime,tvCameraDistance} from './room/tv-display.js';
import {buildGround,buildBuildings,buildLabels,setDaylight} from './world.js';
import {TrenchEffects} from './trench-effects.js';
import {SceneReceiver} from './room/game-broadcast.js';
import * as relay from './room/relay.js';

const el=id=>document.getElementById(id), receiver=new SceneReceiver();
const renderer=new THREE.WebGLRenderer({antialias:true}); renderer.setPixelRatio(Math.min(devicePixelRatio,1.5)); renderer.localClippingEnabled=true;
document.body.appendChild(renderer.domElement);
const scene=new THREE.Scene(); scene.background=new THREE.Color('#000000');
scene.add(new THREE.HemisphereLight('#e0ecff','#394338',2));
const sun=new THREE.DirectionalLight('#fff1dc',2); sun.position.set(500,2000,1000); scene.add(sun);
const camera=new THREE.PerspectiveCamera(45,innerWidth/innerHeight,1,50000);
const controls=new OrbitControls(camera,renderer.domElement);
controls.enableDamping=true; controls.dampingFactor=.06; controls.autoRotate=true; controls.autoRotateSpeed=1.3;
controls.minPolarAngle=.15; controls.maxPolarAngle=Math.PI*.47;
let cameraReady=false, followCamera=true, spinning=true, lastFrame=0;
controls.addEventListener('start',()=>{followCamera=false;});
el('spin').onclick=()=>{spinning=!spinning;el('spin').textContent=spinning?'Pause spin':'Resume spin';};
el('recenter').onclick=()=>{followCamera=true;if(receiver.state&&mapSize)fitView(receiver.state.camera);};
const dummy=new THREE.Object3D(), color=new THREE.Color();
const people=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial({depthTest:false}),14000); people.frustumCulled=false; people.count=0; people.renderOrder=6; scene.add(people);
let city=null, effects=null, labels=[], currentMap=null, mapSize=null, mapRequest=0, loadingMap=null;
let receivedAt=0, previousAgents=[], previousSession=null, processedTrenches=0, displayedSequence=-1;
const rings=new THREE.Group(); scene.add(rings);
const ringGeometry=new THREE.RingGeometry(.93,1,48); ringGeometry.rotateX(-Math.PI/2);
const partyMaterial=new THREE.MeshBasicMaterial({color:'#ffad55',depthTest:false,transparent:true,opacity:.8});
const lockMaterial=new THREE.MeshBasicMaterial({color:'#50dda5',depthTest:false,transparent:true,opacity:.8});

async function loadCity(name) {
  loadingMap=name;
  const request=++mapRequest;
  const map=await(await fetch(name==='central'?'/gbg.json':`/gbg-${encodeURIComponent(name)}.json`)).json();
  if(request!==mapRequest) return;
  if(city) location.reload(); // Each city owns its static material and clipping configuration.
  currentMap=name; loadingMap=null; mapSize=map.size; city=new THREE.Group();
  const ground=buildGround(map),buildings=buildBuildings(map);
  buildings.material=new THREE.MeshLambertMaterial(); // Lit extruded blocks, with the original instance colours.
  labels=buildLabels(map);
  const labelHeight=.025*2*Math.tan(camera.fov*Math.PI/360);
  for(const label of labels) label.scale.set(labelHeight*label.userData.aspect,labelHeight,1);
  city.add(ground,buildings,...labels); scene.add(city); setDaylight(1);
  effects=new TrenchEffects(scene,map,ground,buildings); processedTrenches=0; displayedSequence=-1;
}
function fitView(view) {
  const [width,height]=mapSize;
  const x=view?.x??width/2,z=view?.z??height/2,zoom=view?.zoom??Math.max(width,height);
  const distance=tvCameraDistance(zoom,camera.aspect);
  controls.target.set(x,0,z); controls.minDistance=zoom*.12; controls.maxDistance=zoom*3;
  camera.position.set(x+distance*.28,distance*.82,z+distance*.55); camera.lookAt(x,0,z); camera.updateMatrixWorld(); cameraReady=true; controls.update();
}
function rebuildZones(state) {
  rings.clear();
  for(const [list,material] of [[state.parties,partyMaterial],[state.lockdowns,lockMaterial]]) for(const p of list) {
    const mesh=new THREE.Mesh(ringGeometry,material); mesh.position.set(p.x,4,p.z); mesh.scale.setScalar(p.r); mesh.renderOrder=5; rings.add(mesh);
  }
}
function displayPacket(state) {
  if(previousSession!==state.session) {
    if(processedTrenches) { location.reload(); return; }
    previousSession=state.session; processedTrenches=0;
  }
  // Catch up late-opening TVs without replaying old explosions; new trenches detonate live.
  for(let i=processedTrenches;i<state.trenches.length;i++) effects.commit(state.trenches[i],state.trenches[i].placed);
  processedTrenches=state.trenches.length;
  if(!cameraReady)fitView(state.camera); rebuildZones(state);
  el('waiting').hidden=state.mode!=='menu';
  el('role').textContent=state.role?`Solo · ${state.role==='curber'?'Government':'Spreader'} · broadcast from the main game`:'Two players · broadcast from the main game';
  el('timer').textContent=formatDisplayTime(state.timeLeft);
  el('counts').textContent=`${state.counts.active.toLocaleString()} infected now`;
  el('title').textContent=state.phase==='over'?'Round finished':state.paused?'Game paused':'Live 3D outbreak';
  displayedSequence=state.sequence;
}
relay.on('game_scene',async packet=>{
  const prior=receiver.state;
  if(!receiver.receive(packet)) return;
  previousAgents=prior?.session===packet.session?prior.agents:packet.agents;
  receivedAt=performance.now();
  if(currentMap!==packet.map && loadingMap!==packet.map) {
    try {await loadCity(packet.map);} catch {loadingMap=null;el('connection').textContent='Could not load the broadcast map';}
  }
});
relay.send('scene_request',{});
// Asked again every few seconds: the game only sends the scene while a TV map is there to draw it.
setInterval(()=>relay.send('scene_request',{}),3000);
function resize(){renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();if(followCamera&&receiver.state&&mapSize)fitView(receiver.state.camera);}
addEventListener('resize',resize); resize();
function frame(now) {
  const state=receiver.state;
  const delta=Math.min(.1,(now-lastFrame)/1000||0); lastFrame=now;
  controls.autoRotate=spinning&&state?.mode==='solo'&&!state.paused&&state.phase==='running'&&now-receivedAt<2500;
  if(followCamera&&cameraReady&&state?.camera) {
    const target=new THREE.Vector3(state.camera.x,0,state.camera.z);
    const shift=target.sub(controls.target).multiplyScalar(Math.min(1,delta*4));
    controls.target.add(shift);camera.position.add(shift);
    const offset=camera.position.clone().sub(controls.target);
    const distance=tvCameraDistance(state.camera.zoom,camera.aspect);
    offset.setLength(THREE.MathUtils.lerp(offset.length(),distance,Math.min(1,delta*3)));
    camera.position.copy(controls.target).add(offset);
  }
  controls.update(delta);
  if(state&&effects&&state.map===currentMap) {
    if(displayedSequence!==state.sequence) displayPacket(state);
    const elapsed=Math.min(.25,(now-receivedAt)/1000), blend=state.paused?1:Math.min(1,elapsed/.1);
    const gameTime=state.gameTime+(state.phase==='running'&&!state.paused?elapsed*30:0);
    const renderGame={time:gameTime,barrierPreview:state.preview};
    effects.draw(renderGame,true);
    let n=0; const size=Math.max(5,(state.camera?.zoom||5000)/innerWidth*3);
    for(let i=0;i<state.agents.length&&n<14000;i+=3) {
      const x=state.agents[i],z=state.agents[i+1],beforeX=previousAgents[i]??x,beforeZ=previousAgents[i+1]??z;
      // The shader cuts the city; omit residents in that same trench footprint.
      const mx=Math.max(0,Math.min(511,Math.floor(x/mapSize[0]*512))),mz=Math.max(0,Math.min(511,Math.floor(z/mapSize[1]*512)));
      if(effects.maskData[mz*512+mx])continue;
      dummy.position.set(beforeX+(x-beforeX)*blend,5,beforeZ+(z-beforeZ)*blend);dummy.scale.set(size,2,size);dummy.updateMatrix();people.setMatrixAt(n,dummy.matrix);
      people.setColorAt(n++,color.set(state.agents[i+2]===1||state.agents[i+2]===2?'#ff4545':'#50dda5'));
    }
    people.count=n;people.instanceMatrix.needsUpdate=true;if(people.instanceColor)people.instanceColor.needsUpdate=true;
    for(const label of labels) {
      const x=Math.max(0,Math.min(511,Math.floor(label.position.x/mapSize[0]*512))),z=Math.max(0,Math.min(511,Math.floor(label.position.z/mapSize[1]*512)));
      label.visible=!effects.maskData[z*512+x];
    }
    const stale=now-receivedAt>2500;
    el('connection').textContent=stale?'Broadcast disconnected · last received frame':state.paused?'Broadcast live · paused':state.phase==='over'?'Broadcast live · round finished':'Broadcast live · exact game population';
  }
  const impact=effects&&state?.role==='curber'?effects.impact(state.gameTime):{x:0,z:0};
  const saved=camera.position.clone();camera.position.x+=impact.x;camera.position.z+=impact.z;
  renderer.render(scene,camera);camera.position.copy(saved);requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
