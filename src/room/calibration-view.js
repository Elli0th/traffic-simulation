// How calibration looks on the table, wherever it is drawn: the traffic view, the game and the check
// page. A circle to hold a finger on, a ring that fills while it is held, a word when too much is in
// view; and afterwards, while `verdict` is given, how well the points agreed.
//
// `calibrating` is what the lidar or camera page sends: { index, of, x, y, progress, seen }.

export function drawCalibration(ctx, W, H, now, calibrating, verdict) {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.88)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  const big = `600 ${Math.round(W * 0.02)}px ui-sans-serif, system-ui, sans-serif`;
  const small = `500 ${Math.round(W * 0.014)}px ui-sans-serif, system-ui, sans-serif`;
  if (!calibrating) {
    if (!verdict) return;
    ctx.font = big;
    ctx.fillStyle = verdict.good ? '#39e6b0' : '#ffb020';
    ctx.fillText(verdict.good ? 'Calibrated' : 'Calibrated, but not well: do it again', W / 2, H / 2);
    ctx.font = small;
    ctx.fillStyle = '#e9ecef';
    ctx.fillText(`The nine points agree to within ${verdict.error.toFixed(1)}% of the picture.`, W / 2, H / 2 + W * 0.03);
    return;
  }
  const cx = calibrating.x * W;
  const cy = calibrating.y * H;
  const r = W * (0.02 + 0.002 * Math.sin(now / 180));
  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.15, 0, Math.PI * 2);
  ctx.fill();
  // The ring that fills while the finger is held still.
  const progress = Math.max(0, Math.min(1, calibrating.progress || 0));
  if (progress > 0) {
    ctx.strokeStyle = '#39e6b0';
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.5, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.stroke();
  }
  // The words keep clear of the circle: between the rows of circles, above or below the middle.
  const ty = H * (calibrating.y > 0.6 ? 0.3 : 0.7);
  ctx.font = big;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`Calibrating ${calibrating.index + 1} of ${calibrating.of || 9}: hold one finger still on the circle`, W / 2, ty);
  if (calibrating.seen > 1) {
    ctx.font = small;
    ctx.fillStyle = '#ffb020';
    ctx.fillText(`I can see ${calibrating.seen} things. Take everything else off the table.`, W / 2, ty + W * 0.03);
  } else if (calibrating.seen === 0) {
    ctx.font = small;
    ctx.fillStyle = '#8a94a3';
    ctx.fillText('Touch the table with a fingertip, in the middle of the circle.', W / 2, ty + W * 0.03);
  }
}
