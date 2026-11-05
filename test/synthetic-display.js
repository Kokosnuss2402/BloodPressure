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
  if (String(value).includes('.')) return drawDecimal(ctx, String(value), right, y, h, slant);
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

// number with a decimal point, e.g. "72.4" (all digits full width, dot near the baseline)
function drawDecimal(ctx, s, right, y, h, slant) {
  const w = h * 0.52;
  const t = h * 0.11;
  let x = right;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === '.') {
      // the point sits in its own gap between the digits, on the baseline
      const g = h * 0.1;
      const d = t * 1.1;
      x += h * 0.16; // undo the normal digit gap; the point brings its own
      ctx.fillRect(x - g - d, y + h - d, d, d);
      x -= 2 * g + d;
      continue;
    }
    x -= w;
    drawDigit(ctx, x, y, w, h, t, BITS[s[i]], slant);
    x -= h * 0.16;
  }
}

/**
 * A bathroom scale photographed from standing height: small display far away
 * in a large frame, floor texture with straight lines, optional LED look
 * (bright digits on dark glass) and perspective.
 */
export function syntheticScale({ value = '72.4', width = 2400, height = 1800, seed = 3, led = false, floor = 'tiles', displayH = 70, perspective = 0.15 }) {
  let r = seed;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  // floor
  if (floor === 'tiles') {
    ctx.fillStyle = '#d8d4cc';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#8f8a80';
    ctx.lineWidth = 6;
    for (let x = 0; x < width; x += 300) { ctx.beginPath(); ctx.moveTo(x + rnd() * 6, 0); ctx.lineTo(x, height); ctx.stroke(); }
    for (let y = 0; y < height; y += 300) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y + rnd() * 6); ctx.stroke(); }
  } else {
    ctx.fillStyle = '#9a7652';
    ctx.fillRect(0, 0, width, height);
    for (let i = 0; i < 160; i++) {
      ctx.strokeStyle = `rgba(60,40,20,${0.2 + rnd() * 0.4})`;
      ctx.lineWidth = 2 + rnd() * 6;
      const y = rnd() * height;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.bezierCurveTo(width / 3, y + rnd() * 30, (2 * width) / 3, y - rnd() * 30, width, y + rnd() * 20); ctx.stroke();
    }
  }
  // scale body seen in perspective (narrower at the far edge)
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.transform(1, 0, -perspective, 1, 0, 0);
  const bw = 900;
  const bh = 900;
  ctx.fillStyle = led ? '#202326' : '#f2f2ef';
  ctx.beginPath();
  ctx.roundRect(-bw / 2, -bh / 2, bw, bh, 90);
  ctx.fill();
  // display window near the top edge of the scale
  const dw = displayH * 3.6;
  const dh = displayH * 1.6;
  ctx.fillStyle = led ? '#0a0b0c' : '#b9bdac';
  ctx.fillRect(-dw / 2, -bh / 2 + 70, dw, dh);
  ctx.fillStyle = led ? '#e8f0ff' : '#1d1f1a';
  drawNumber(ctx, value, dw / 2 - displayH * 0.3, -bh / 2 + 70 + displayH * 0.3, displayH, 0.06);
  ctx.restore();
  // soft light falloff + noise
  const g = ctx.createRadialGradient(width * 0.3, height * 0.3, 100, width / 2, height / 2, width * 0.8);
  g.addColorStop(0, 'rgba(255,255,255,0.08)');
  g.addColorStop(1, 'rgba(0,0,0,0.25)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
  const img = ctx.getImageData(0, 0, width, height);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 20;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
