// A homography maps points on one flat surface to the same points seen from another angle.
// Here: where something is in the depth camera's picture -> where it is on the projected image.

// Finds the homography taking each `from` point to its `to` point. Needs at least four pairs,
// no three of them in a line. Returns nine numbers (row by row), or null if the points are unusable.
export function solveHomography(from, to) {
  if (from.length < 4 || from.length !== to.length) return null;
  // Work with inputs near 1 so the arithmetic stays well behaved, then fold the scale back in.
  let scale = 1;
  for (const [x, y] of from) scale = Math.max(scale, Math.abs(x), Math.abs(y));

  // Least squares over all pairs: accumulate the normal equations as an 8 x 9 system.
  const A = Array.from({ length: 8 }, () => new Float64Array(9));
  for (let k = 0; k < from.length; k++) {
    const x = from[k][0] / scale;
    const y = from[k][1] / scale;
    const [u, v] = to[k];
    for (const row of [
      [x, y, 1, 0, 0, 0, -u * x, -u * y, u],
      [0, 0, 0, x, y, 1, -v * x, -v * y, v],
    ]) {
      for (let i = 0; i < 8; i++) for (let j = 0; j < 9; j++) A[i][j] += row[i] * row[j];
    }
  }

  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    if (Math.abs(A[pivot][col]) < 1e-12) return null;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let j = col; j < 9; j++) A[r][j] -= f * A[col][j];
    }
  }
  const h = A.map((row, i) => row[8] / row[i]);
  return [h[0] / scale, h[1] / scale, h[2], h[3] / scale, h[4] / scale, h[5], h[6] / scale, h[7] / scale, 1];
}

export function applyHomography(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

// True if four points, taken in order, form a sensible four-sided shape (no crossing, no dents).
export function isConvexQuad(points) {
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = points[k];
    const [bx, by] = points[(k + 1) % 4];
    const [cx, cy] = points[(k + 2) % 4];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cross) < 1e-6) return false;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}
