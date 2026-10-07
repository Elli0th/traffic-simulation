export const TRENCH_RADIUS = 28;
export function pointSegmentDistance(p, a, b) {
  const dx = b.x-a.x, dz = b.z-a.z, length2 = dx*dx+dz*dz;
  const t = length2 ? Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.z-a.z)*dz)/length2)) : 0;
  return Math.hypot(p.x-a.x-dx*t,p.z-a.z-dz*t);
}
export function crossesTrench(a,b,c,d,radius=TRENCH_RADIUS) {
  if(Math.max(a.x,b.x)+radius<Math.min(c.x,d.x) || Math.min(a.x,b.x)-radius>Math.max(c.x,d.x) || Math.max(a.z,b.z)+radius<Math.min(c.z,d.z) || Math.min(a.z,b.z)-radius>Math.max(c.z,d.z)) return false;
  const cross=(p,q,r)=>(q.x-p.x)*(r.z-p.z)-(q.z-p.z)*(r.x-p.x);
  if(cross(a,b,c)*cross(a,b,d)<=0 && cross(c,d,a)*cross(c,d,b)<=0 && Math.max(a.x,b.x)>=Math.min(c.x,d.x) && Math.min(a.x,b.x)<=Math.max(c.x,d.x) && Math.max(a.z,b.z)>=Math.min(c.z,d.z) && Math.min(a.z,b.z)<=Math.max(c.z,d.z)) return true;
  return Math.min(pointSegmentDistance(a,c,d),pointSegmentDistance(b,c,d),pointSegmentDistance(c,a,b),pointSegmentDistance(d,a,b))<=radius;
}
export function inTrench(p, trenches) {
  return trenches.some(t=>t.points.some((b,i)=>i>0 && pointSegmentDistance(p,t.points[i-1],b)<=TRENCH_RADIUS));
}
