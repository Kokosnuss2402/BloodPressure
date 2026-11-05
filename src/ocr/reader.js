// High-level reader: runs the seven-segment recogniser in several passes
// (different thresholds, small rotations, zoom-in on the detected display)
// and keeps the most plausible reading for the requested measurement type.

import { readSevenSegment, pickDisplayStack } from './sevenSegment.js';
import { MEASUREMENT_TYPES } from '../types.js';

export function rotateImage(img, degrees) {
  if (!degrees) return img;
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  const cx = w / 2;
  const cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const sx = Math.round(cos * dx + sin * dy + cx);
      const sy = Math.round(-sin * dx + cos * dy + cy);
      const o = (y * w + x) * 4;
      if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
        const i = (sy * w + sx) * 4;
        out[o] = data[i];
        out[o + 1] = data[i + 1];
        out[o + 2] = data[i + 2];
      } else {
        out[o] = out[o + 1] = out[o + 2] = 128;
      }
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

function stackBox(stack) {
  return {
    x0: Math.min(...stack.map((r) => r.box.x0)),
    x1: Math.max(...stack.map((r) => r.box.x1)),
    y0: Math.min(...stack.map((r) => r.box.y0)),
    y1: Math.max(...stack.map((r) => r.box.y1)),
  };
}

/**
 * Read a measurement device display.
 * @param {ImageData|{width:number,height:number,data:Uint8ClampedArray}} img
 * @param {'bp'|'glucose'} kind
 * @param {{crop?:{x:number,y:number,w:number,h:number}}} [opts]
 * @returns {{values: object, score: number, confidence: number, rows: Array, box: object|null, rotation: number}}
 */
export function readDisplay(img, kind = 'bp', opts = {}) {
  const type = MEASUREMENT_TYPES[kind];
  const passes = [];
  const attempt = (image, rotation, readOpts) => {
    const { rows } = readSevenSegment(image, readOpts);
    const stack = pickDisplayStack(rows);
    const mapped = type.fromDisplayRows(stack);
    passes.push({ ...mapped, rows: stack, rotation, box: stack.length ? stackBox(stack) : null, readOpts });
    return passes[passes.length - 1];
  };
  const good = () => passes.some((p) => p.score >= 1);

  const base = { crop: opts.crop };
  for (const threshold of [0.18, 0.12, 0.25]) {
    attempt(img, 0, { ...base, threshold });
    if (good()) break;
  }
  if (!good()) {
    for (const rot of [-6, 6, -10, 10]) {
      const r = rotateImage(img, rot);
      for (const threshold of [0.18, 0.12]) {
        attempt(r, rot, { ...base, threshold });
        if (good()) break;
      }
      if (good()) break;
    }
  }

  passes.sort((a, b) => b.score - a.score);
  let best = passes[0];

  // Zoom-in pass: re-read just the display region at higher resolution.
  if (best?.box) {
    const b = best.box;
    const mw = (b.x1 - b.x0) * 0.35;
    const mh = (b.y1 - b.y0) * 0.15;
    const crop = { x: b.x0 - mw, y: b.y0 - mh, w: b.x1 - b.x0 + 2 * mw, h: b.y1 - b.y0 + 2 * mh };
    crop.x = Math.max(0, crop.x);
    crop.y = Math.max(0, crop.y);
    const srcImg = best.rotation ? rotateImage(img, best.rotation) : img;
    crop.w = Math.min(srcImg.width - crop.x, crop.w);
    crop.h = Math.min(srcImg.height - crop.y, crop.h);
    // zoom only helps when the display is small in the frame
    if (crop.w < srcImg.width * 0.75 || crop.h < srcImg.height * 0.75) {
      const z = attempt(srcImg, best.rotation, { crop, threshold: best.readOpts.threshold });
      // the zoomed read sees the digits at higher resolution, prefer it when as plausible
      if (z.score >= best.score - 0.05) best = z;
    }
  }

  if (!best) return { values: {}, score: 0, confidence: 0, rows: [], box: null, rotation: 0 };
  const { readOpts, ...result } = best;
  return result;
}
