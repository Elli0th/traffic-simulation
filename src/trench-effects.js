import * as THREE from 'three';
import {mulberry32} from './geometry.js';
import { TRENCH_RADIUS, pointSegmentDistance } from './trench-geometry.js';
const RESOLUTION = 512, MAX_SHARDS = 10000, MAX_BLASTS = 160;
function radialTexture(flame=false) {
  const size=64,data=new Uint8Array(size*size*4);
  for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
    const r=Math.hypot((x+.5)/size*2-1,(y+.5)/size*2-1), i=(y*size+x)*4;
    data[i]=255; data[i+1]=flame?Math.round(255*Math.max(.2,1-r*1.3)):255;
    data[i+2]=flame?Math.round(255*Math.max(.05,1-r*2)):255;
    data[i+3]=Math.round(Math.max(0,1-r)**2*255);
  }
  const texture=new THREE.DataTexture(data,size,size,THREE.RGBAFormat);
  texture.minFilter=texture.magFilter=THREE.LinearFilter; texture.needsUpdate=true; return texture;
}
// A shared damage texture actually cuts fragments out of every ground layer and building.
// It is sampled only while rebuilding the cached map, rather than testing every trench each frame.
export class TrenchEffects {
  constructor(scene,map,ground,buildings) {
    this.reducedMotion=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
    this.lastImpactAt=-Infinity; this.random=mulberry32(1);
    this.map=map; this.shards=[]; this.blasts=[]; this.version=0;
    this.maskData=new Uint8Array(RESOLUTION*RESOLUTION);
    this.mask=new THREE.DataTexture(this.maskData,RESOLUTION,RESOLUTION,THREE.RedFormat);
    this.mask.minFilter=this.mask.magFilter=THREE.NearestFilter; this.mask.needsUpdate=true;
    const uniforms={ trenchMask:{value:this.mask}, trenchMapSize:{value:new THREE.Vector2(...map.size)} };
    const materials=new Set(); ground.traverse(o=>{if(o.material) for(const m of Array.isArray(o.material)?o.material:[o.material]) materials.add(m);}); materials.add(buildings.material);
    for(const material of materials) {
      const before=material.onBeforeCompile;
      material.onBeforeCompile=(shader,renderer)=>{
        before.call(material,shader,renderer); Object.assign(shader.uniforms,uniforms);
        shader.vertexShader='varying vec2 trenchWorld;\n'+shader.vertexShader;
        shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>',`#include <project_vertex>
          vec4 trenchPoint = vec4(transformed,1.0);
          #ifdef USE_INSTANCING
            trenchPoint = instanceMatrix * trenchPoint;
          #endif
          trenchWorld = (modelMatrix * trenchPoint).xz;`);
        shader.fragmentShader='uniform sampler2D trenchMask; uniform vec2 trenchMapSize; varying vec2 trenchWorld;\n'+shader.fragmentShader;
        shader.fragmentShader=shader.fragmentShader.replace('#include <clipping_planes_fragment>',`#include <clipping_planes_fragment>
          if(texture2D(trenchMask,clamp(trenchWorld / trenchMapSize,vec2(0.0),vec2(1.0))).r > 0.5) discard;`);
      };
      material.customProgramCacheKey=()=> 'government-trench-v1'; material.needsUpdate=true;
    }
    this.pieces=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial({vertexColors:false,depthTest:false}),MAX_SHARDS);
    this.pieces.renderOrder=8; this.pieces.frustumCulled=false; this.pieces.count=0;
    const ring=new THREE.RingGeometry(.86,1,48); ring.rotateX(-Math.PI/2);
    this.flashes=new THREE.InstancedMesh(ring,new THREE.MeshBasicMaterial({color:'#fff0bb',transparent:true,opacity:.85,depthTest:false,blending:THREE.AdditiveBlending}),MAX_BLASTS*2);
    this.flashes.renderOrder=9; this.flashes.frustumCulled=false; this.flashes.count=0;
    this.preview=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial({color:'#ffb75b',transparent:true,opacity:.6,depthTest:false}),200);
    this.preview.renderOrder=7; this.preview.frustumCulled=false; this.preview.count=0;
    const disc=new THREE.PlaneGeometry(2,2); disc.rotateX(-Math.PI/2);
    this.fireballs=new THREE.InstancedMesh(disc,new THREE.MeshBasicMaterial({map:radialTexture(true),transparent:true,opacity:.95,depthWrite:false,depthTest:false,blending:THREE.AdditiveBlending}),MAX_BLASTS);
    this.fireballs.renderOrder=10; this.fireballs.frustumCulled=false; this.fireballs.count=0;
    this.dust=new THREE.InstancedMesh(disc,new THREE.MeshBasicMaterial({map:radialTexture(),color:'#8a8074',transparent:true,opacity:.22,depthWrite:false,depthTest:false}),MAX_BLASTS);
    this.dust.renderOrder=7; this.dust.frustumCulled=false; this.dust.count=0;
    scene.add(this.pieces,this.flashes,this.fireballs,this.dust,this.preview); this.setVisible(false);
    this.matrix=new THREE.Matrix4(); this.position=new THREE.Vector3(); this.scale=new THREE.Vector3(); this.quaternion=new THREE.Quaternion(); this.euler=new THREE.Euler(); this.color=new THREE.Color();
  }
  setVisible(on) { this.pieces.visible=this.flashes.visible=this.fireballs.visible=this.dust.visible=this.preview.visible=on; }
  emit(x,z,start,building=false) {
    for(let j=0;j<(building?24:32);j++) {
      const angle=this.random()*Math.PI*2, velocity=100+this.random()*220;
      this.shards.push({x,z,start,vx:Math.cos(angle)*velocity,vz:Math.sin(angle)*velocity,vy:90+this.random()*170,size:8+this.random()*18,spin:this.random()*8,life:2.2+this.random()*1.8,color:building?'#89929f':j%4===0?'#ffb75b':j%4===1?'#e76126':'#3c424b'});
    }
    if(this.shards.length>MAX_SHARDS) this.shards.splice(0,this.shards.length-MAX_SHARDS);
  }
  commit(trench,gameTime) {
    const points=trench.points, [width,height]=this.map.size, cellX=width/RESOLUTION, cellZ=height/RESOLUTION;
    const now=gameTime/30; this.lastImpactAt=now;
    const seed=points.reduce((h,p)=>(Math.imul(h,31)+Math.round(p.x*100)+Math.imul(Math.round(p.z*100),17))|0,Math.round(gameTime));
    this.random=mulberry32(seed);
    let along=0;
    for(let i=1;i<points.length;i++) {
      const a=points[i-1],b=points[i],length=Math.hypot(b.x-a.x,b.z-a.z);
      const minX=Math.max(0,Math.floor((Math.min(a.x,b.x)-TRENCH_RADIUS)/cellX)), maxX=Math.min(RESOLUTION-1,Math.ceil((Math.max(a.x,b.x)+TRENCH_RADIUS)/cellX));
      const minZ=Math.max(0,Math.floor((Math.min(a.z,b.z)-TRENCH_RADIUS)/cellZ)), maxZ=Math.min(RESOLUTION-1,Math.ceil((Math.max(a.z,b.z)+TRENCH_RADIUS)/cellZ));
      for(let z=minZ;z<=maxZ;z++) for(let x=minX;x<=maxX;x++) if(pointSegmentDistance({x:(x+.5)*cellX,z:(z+.5)*cellZ},a,b)<=TRENCH_RADIUS) this.maskData[z*RESOLUTION+x]=255;
      for(let d=0;d<length;d+=18) {
        const x=a.x+(b.x-a.x)*d/length,z=a.z+(b.z-a.z)*d/length,start=now+(along+d)/2500;
        this.emit(x,z,start); this.blasts.push({x,z,start});
      }
      along+=length;
    }
    // Break the building blocks themselves into a separate grey cluster at each damaged cell.
    const B=this.map.boxes,cell=this.map.cell;
    for(let k=0;k<B.length;k+=6) {
      const x=(B[k]+B[k+2]/2)*cell,z=(B[k+1]+.5)*cell;
      if(points.some((b,i)=>i>0 && pointSegmentDistance({x,z},points[i-1],b)<TRENCH_RADIUS+cell/2)) this.emit(x,z,now+.15,true);
    }
    this.blasts=this.blasts.slice(-MAX_BLASTS); this.mask.needsUpdate=true; this.version++;
  }
  impact(gameTime) {
    const age=gameTime/30-this.lastImpactAt;
    if(this.reducedMotion || age<0 || age>1.15) return {x:0,z:0,strength:0};
    const strength=(1-age/1.15)**2;
    return {x:Math.sin(age*91)*9*strength,z:Math.cos(age*73)*7*strength,strength};
  }
  draw(game,visible) {
    this.setVisible(visible); if(!visible) return;
    const now=game.time/30;
    this.shards=this.shards.filter(p=>now-p.start<p.life); this.blasts=this.blasts.filter(p=>now-p.start<2.6);
    let n=0;
    for(const p of this.shards) {
      const t=now-p.start; if(t<0) continue;
      const fade=Math.max(0,1-t/p.life), lift=Math.max(0,p.vy*t-80*t*t);
      this.quaternion.setFromEuler(this.euler.set(t*p.spin,t*p.spin*.7,t*p.spin*.3));
      this.matrix.compose(this.position.set(p.x+p.vx*t,8+lift,p.z+p.vz*t),this.quaternion,this.scale.setScalar(p.size*fade));
      this.pieces.setMatrixAt(n,this.matrix); this.pieces.setColorAt(n++,this.color.set(p.color).multiplyScalar(.35+.65*fade));
    }
    this.pieces.count=n; this.pieces.visible=n>0; this.pieces.instanceMatrix.needsUpdate=true; if(this.pieces.instanceColor) this.pieces.instanceColor.needsUpdate=true;
    n=0; let cores=0,clouds=0; this.quaternion.identity();
    for(const p of this.blasts) {
      const t=now-p.start; if(t<0) continue;
      if(t<1.1) {
        for(const offset of [0,.16]) {
          const age=t-offset; if(age<0 || age>1.1) continue;
          const radius=20+320*age;
          this.matrix.compose(this.position.set(p.x,7,p.z),this.quaternion,this.scale.set(radius,1,radius));
          this.flashes.setMatrixAt(n,this.matrix); this.flashes.setColorAt(n++,this.color.set(offset?'#ff7c32':'#ffe8af').multiplyScalar((1-age/1.1)**2));
        }
      }
      if(t<.7) {
        const radius=50+190*Math.sin(t/.7*Math.PI);
        this.matrix.compose(this.position.set(p.x,10,p.z),this.quaternion,this.scale.set(radius,1,radius));
        this.fireballs.setMatrixAt(cores,this.matrix); this.fireballs.setColorAt(cores++,this.color.setScalar((1-t/.7)*(this.reducedMotion ? .4 : 1)));
      }
      const radius=30+130*t;
      this.matrix.compose(this.position.set(p.x+25*t,6,p.z-20*t),this.quaternion,this.scale.set(radius,1,radius));
      this.dust.setMatrixAt(clouds,this.matrix); this.dust.setColorAt(clouds++,this.color.setScalar((1-t/2.6)**2));
    }
    for(const [mesh,count] of [[this.flashes,n],[this.fireballs,cores],[this.dust,clouds]]) {
      mesh.count=count; mesh.visible=count>0; mesh.instanceMatrix.needsUpdate=true; if(mesh.instanceColor) mesh.instanceColor.needsUpdate=true;
    }
    n=0; const points=game.barrierPreview||[];
    for(let i=1;i<points.length && n<200;i++) {
      const a=points[i-1],b=points[i],length=Math.hypot(b.x-a.x,b.z-a.z);
      this.quaternion.setFromAxisAngle(new THREE.Vector3(0,1,0),Math.atan2(-(b.z-a.z),b.x-a.x));
      this.matrix.compose(this.position.set((a.x+b.x)/2,5,(a.z+b.z)/2),this.quaternion,this.scale.set(length+8,1,TRENCH_RADIUS*2));
      this.preview.setMatrixAt(n++,this.matrix);
    }
    this.preview.count=n; this.preview.visible=n>0; this.preview.instanceMatrix.needsUpdate=true;
  }
}
