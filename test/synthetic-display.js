// Draws a synthetic seven-segment LCD (like a blood pressure monitor) onto a
// canvas, with italic slant, uneven lighting and noise. Runs in the browser.

const BITS = { 0: 0b1111110, 1: 0b0110000, 2: 0b1101101, 3: 0b1111001, 4: 0b0110011, 5: 0b1011011, 6: 0b1011111, 7: 0b1110000, 8: 0b1111111, 9: 0b1111011 };

function drawDigit(ctx, x, y, w, h, t, bits, slant) {
  const gap = t * 0.25;
  const sk = (px, py) => [px + slant * (y + h - py), py];
  const poly = (pts) => {
    ctx.beginPath();
    pts.forEach(([px, py], i) => {
      const [sx, sy] = sk(px, py);
      i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
    });
    ctx.closePath();
    ctx.fill();
  };
  const hseg = (yy) => poly([[x + gap + t / 2, yy], [x + w - gap - t / 2, yy], [x + w - gap - t / 2, yy + t], [x + gap + t / 2, yy + t]]);
  const vseg = (xx, y0, y1) => poly([[xx, y0 + gap], [xx + t, y0 + gap], [xx + t, y1 - gap], [xx, y1 - gap]]);
  const mid = y + h / 2 - t / 2;
  const on = (i) => bits & (1 << (6 - i));
  if (on(0)) hseg(y);
  if (on(1)) vseg(x + w - t, y + t / 2, mid + t / 2);
  if (on(2)) vseg(x + w - t, mid + t / 2, y + h - t / 2);
  if (on(3)) hseg(y + h - t);
  if (on(4)) vseg(x, mid + t / 2, y + h - t / 2);
  if (on(5)) vseg(x, y + t / 2, mid + t / 2);
  if (on(6)) hseg(mid);
}

function drawNumber(ctx, value, right, y, h, slant) {
  const w = h * 0.52;
  const t = h * 0.11;
  const s = String(value);
  let x = right;
  for (let i = s.length - 1; i >= 0; i--) {
    const d = s[i];
    // leading "1" of a three-digit number is a narrow half digit (as on many monitors)
    if (d === '1' && i === 0 && s.length === 3) {
      x -= t + h * 0.12;
      drawDigit(ctx, x - (w - t), y, w, h, t, BITS[1], slant);
      continue;
    }
    x -= w;
    drawDigit(ctx, x, y, w, h, t, BITS[d], slant);
    x -= h * 0.16;
  }
}

export function syntheticDisplay({ sys, dia, pulse, width = 900, height = 1300, seed = 1, slant = 0.08, rotate = 0 }) {
  let r = seed;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#c9c5bc';
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate((rotate * Math.PI) / 180);
  ctx.translate(-width / 2, -height / 2);
  // bezel + LCD
  ctx.fillStyle = '#4a4a48';
  ctx.fillRect(120, 160, 660, 860);
  const g = ctx.createLinearGradient(160, 200, 700, 980);
  g.addColorStop(0, '#b7bba8');
  g.addColorStop(1, '#8e927f');
  ctx.fillStyle = g;
  ctx.fillRect(170, 200, 520, 780);
  ctx.fillStyle = '#1f201c';
  drawNumber(ctx, sys, 660, 240, 230, slant);
  drawNumber(ctx, dia, 660, 520, 230, slant);
  drawNumber(ctx, pulse, 660, 800, 130, slant);
  ctx.restore();
  // shadow over part of the display
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.ellipse(250 + rnd() * 100, 700, 220, 320, 0.3, 0, Math.PI * 2);
  ctx.fill();
  // sensor noise
  const img = ctx.getImageData(0, 0, width, height);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 24;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
