export function formatDisplayTime(seconds) {
  if(!Number.isFinite(seconds)) return '--:--';
  const left=Math.max(0,Math.floor(seconds));
  return `${Math.floor(left/60)}:${String(left%60).padStart(2,'0')}`;
}
export function soloTvRoute(state,{page,side,tv}={}) {
  if(state.mode!=='solo') return null;
  if(page==='legacy') return tv==='2'?'dashboard.html?side=auto&tv=2':'tv-map.html?tv=1';
  if(page==='dashboard'&&(tv==='1'||(side==='spreader'&&tv!=='2'))) return 'tv-map.html?tv=1';
  return null;
}
export function tvCameraDistance(zoom,aspect) {
  return zoom/(2*Math.tan(Math.PI/8))/Math.min(1,aspect)*.72;
}
