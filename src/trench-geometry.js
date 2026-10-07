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

// Fit an optimal straight line segment through a cloud of 2D points using Principal Component Analysis (PCA).
export function fitTrenchLine(points, minLength = 40, maxSegment = 18) {
  if (!points || points.length < 2) return null;
  const n = points.length;
  let meanX = 0, meanZ = 0;
  for (const p of points) { meanX += p.x; meanZ += p.z; }
  meanX /= n; meanZ /= n;

  let sxx = 0, szz = 0, sxz = 0;
  for (const p of points) {
    const dx = p.x - meanX, dz = p.z - meanZ;
    sxx += dx * dx; szz += dz * dz; sxz += dx * dz;
  }
  if (sxx + szz < 1e-4) return null;

  // Closed-form eigenvector direction for 2x2 symmetric covariance matrix
  const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const vx = Math.cos(theta), vz = Math.sin(theta);

  let minT = Infinity, maxT = -Infinity;
  for (const p of points) {
    const t = (p.x - meanX) * vx + (p.z - meanZ) * vz;
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
  }

  const length = maxT - minT;
  if (!Number.isFinite(length) || length < minLength) return null;

  const startX = meanX + minT * vx, startZ = meanZ + minT * vz;
  const endX = meanX + maxT * vx, endZ = meanZ + maxT * vz;

  const steps = Math.max(2, Math.min(100, Math.ceil(length / maxSegment)));
  const resultPoints = [];
  for (let i = 0; i <= steps; i++) {
    const frac = i / steps;
    resultPoints.push({
      x: startX + (endX - startX) * frac,
      z: startZ + (endZ - startZ) * frac,
    });
  }

  return {
    start: { x: startX, z: startZ },
    end: { x: endX, z: endZ },
    length,
    points: resultPoints,
  };
}
