import { roundDuration } from '../game-runtime.js';

// A render snapshot from the authoritative game; TVs never run their own outbreak.
export function gameSceneState(game, {session,startedAt,sequence,roundTime=0,paused=false,selectionPending=false,map='central',view=null}={}) {
  return {
    session,startedAt,sequence,map,role:game.soloRole,mode:selectionPending?'menu':game.soloRole?'solo':'multiplayer',
    phase:game.phase,paused:paused||game.phase==='over',gameTime:game.time,
    timeLeft:selectionPending?null:Math.max(0,roundDuration(!!game.soloRole)-roundTime),
    roundDuration:roundDuration(!!game.soloRole),counts:game.counts().people,
    camera:view?{x:view.x,z:view.z,zoom:view.zoom}:null,
    agents:game.agents.flatMap(p=>[Math.round(p.x*10)/10,Math.round(p.z*10)/10,p.inf]),
    trenches:game.barriers.map(b=>({points:b.points.map(p=>({x:p.x,z:p.z})),until:Number.isFinite(b.until)?b.until:null,placed:b.placed??0})),
    preview:game.barrierPreview?.map(p=>({x:p.x,z:p.z}))||[],
    parties:game.parties.filter(p=>p.until>game.time).map(p=>({x:p.x,z:p.z,r:60})),
    lockdowns:game.lockdowns.filter(p=>(p.start||0)<=game.time&&p.until>game.time).map(p=>({x:p.x,z:p.z,r:p.r})),
  };
}

export class SceneReceiver {
  constructor() {this.state=null;this.sequence=-1;this.startedAt=-1;this.session=null;}
  receive(packet) {
    if(!packet || !Number.isFinite(packet.sequence) || !Number.isFinite(packet.startedAt) || !Array.isArray(packet.agents)) return false;
    if(packet.startedAt<this.startedAt || (packet.session===this.session && packet.sequence<=this.sequence)) return false;
    this.session=packet.session; this.startedAt=packet.startedAt; this.sequence=packet.sequence;
    this.state={...packet,trenches:packet.trenches.map(b=>({...b,until:b.until===null?Infinity:b.until}))};
    return true;
  }
}
