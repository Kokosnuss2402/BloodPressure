// High-level reader: runs the seven-segment recogniser in several passes
// (different thresholds, small rotations, zoom-in on the detected display)
// and keeps the most plausible reading for the requested measurement type.

import { readSevenSegment, pickDisplayStack } from './sevenSegment.js';
import { MEASUREMENT_TYPES } from '../types.js';

/** Rotate by k quarter turns clockwise (swaps width and height for odd k). */
export function rotateQuarter(img, k) {
  k = ((k % 4) + 4) % 4;
  if (!k) return img;
  const { width: w, height: h, data } = img;
  const W = k % 2 ? h : w;
  const H = k % 2 ? w : h;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let X;
      let Y;
      if (k === 1) [X, Y] = [h - 1 - y, x];
      else if (k === 2) [X, Y] = [w - 1 - x, h - 1 - y];
      else [X, Y] = [y, w - 1 - x];
      const i = (y * w + x) * 4;
      const o = (Y * W + X) * 4;
      out[o] = data[i];
      out[o + 1] = data[i + 1];
      out[o + 2] = data[i + 2];
      out[o + 3] = 255;
    }
  }
  return { width: W, height: H, data: out };
}

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

/** Nearest-neighbour downscale (rotation passes don't need full resolution). */
function downscale(img, maxDim) {
  const f = Math.max(img.width, img.height) / maxDim;
  if (f <= 1) return { image: img, factor: 1 };
  const w = Math.round(img.width / f);
  const h = Math.round(img.height / f);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y * f));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x * f));
      out.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * w + x) * 4);
    }
  }
  return { image: { width: w, height: h, data: out }, factor: f };
}

const scaleBox = (b, f) => (f === 1 ? b : { x0: b.x0 * f, x1: b.x1 * f, y0: b.y0 * f, y1: b.y1 * f });

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
 * @param {{crop?:{x:number,y:number,w:number,h:number}, settings?:object}} [opts]
 *   settings: user units (glucoseUnit, weightUnit) used to interpret the digits
 * @returns {{values: object, score: number, confidence: number, rows: Array, box: object|null, rotation: number}}
 */
export function readDisplay(img, kind = 'bp', opts = {}) {
  const type = MEASUREMENT_TYPES[kind];
  const passes = [];
  // factor: how much `image` was downscaled; boxes are reported in full-resolution units
  // transform: how to get the full-resolution image the boxes refer to (for the zoom pass)
  const attempt = (image, rotation, readOpts, factor = 1, transform = null) => {
    const { rows } = readSevenSegment(image, readOpts);
    // multi-value displays (blood pressure): the stacked rows; single-value: every candidate row
    const picked = type.fields.length > 1 ? pickDisplayStack(rows) : rows.filter((r) => r.value !== null);
    // rel: digit height relative to the photo (small patterns in floors and fabrics are tiny)
    const longSide = Math.max(img.width, img.height);
    const stack = picked.map((r) => ({ ...r, box: scaleBox(r.box, factor), height: r.height * factor, rel: (r.height * factor) / longSide }));
    const mapped = type.fromDisplayRows(stack, opts.settings);
    if (type.fields.length === 1 && mapped.values && stack.length) {
      // keep only the row that was used, for the overlay and the zoom pass
      const used = stack.filter((r) => r === mapped.row);
      if (used.length) stack.splice(0, stack.length, ...used);
    }
    passes.push({ ...mapped, rows: stack, rotation, box: stack.length ? stackBox(stack) : null, readOpts, transform });
    return passes[passes.length - 1];
  };
  const good = () => passes.some((p) => p.score >= 1);

  const base = { crop: opts.crop };
  for (const threshold of [0.18, 0.12, 0.25]) {
    attempt(img, 0, { ...base, threshold });
    if (good()) break;
  }
  // display far away (small in the frame): read at higher resolution
  if (!good() || type.farDisplay) {
    for (const threshold of [0.18, 0.12]) {
      attempt(img, 0, { ...base, threshold, maxDim: 2400, far: true });
      if (good()) break;
    }
  }
  // LED / backlit displays: bright digits on a dark background
  if (!good()) {
    for (const maxDim of [900, 1800]) {
      for (const threshold of [0.18, 0.12]) {
        attempt(img, 0, { ...base, threshold, maxDim, invert: true });
        if (good()) break;
      }
      if (good()) break;
    }
  }
  if (!good()) {
    const small = downscale(img, 1000);
    const c = opts.crop;
    const crop = c && { x: c.x / small.factor, y: c.y / small.factor, w: c.w / small.factor, h: c.h / small.factor };
    for (const rot of [-6, 6, -10, 10]) {
      const r = rotateImage(small.image, rot);
      for (const [threshold, invert] of [[0.18, false], [0.12, false], [0.18, true]]) {
        attempt(r, rot, { crop, threshold, invert }, small.factor);
        if (good()) break;
      }
      if (good()) break;
    }
  }

  // photo sideways or upside down (e.g. EXIF orientation not applied): quarter turns
  // Far-away displays (scales) need the full resolution here, and both sideways
  // directions are tried: upside-down seven-segment digits often still look like
  // digits (6/9, 2/2), so the more plausible reading (decimal point on the
  // baseline, exactly decoded digits) decides.
  if (!good()) {
    const src = type.farDisplay ? { image: img, factor: 1 } : downscale(img, 1000);
    const extra = type.farDisplay ? { maxDim: 2400, far: true } : {};
    for (const k of [1, 3, 2]) {
      const r = rotateQuarter(src.image, k);
      for (const threshold of [0.18, 0.12]) {
        attempt(r, k * 90, { threshold, quarter: k, ...extra }, src.factor, (im) => rotateQuarter(im, k));
        if (passes[passes.length - 1].score >= 1) break;
      }
      if (good() && k !== 1) break;
    }
  }

  passes.sort((a, b) => b.score - a.score);
  let best = passes[0];

  // Zoom-in pass: re-read just the display region at higher resolution.
  if (best?.box) {
    const b = best.box;
    const mw = (b.x1 - b.x0) * 0.35;
    const mh = (b.y1 - b.y0) * (best.rows.length > 1 ? 0.15 : 0.4);
    const crop = { x: b.x0 - mw, y: b.y0 - mh, w: b.x1 - b.x0 + 2 * mw, h: b.y1 - b.y0 + 2 * mh };
    // multi-row display read only partly (e.g. SYS found, DIA/PUL missed): the other
    // rows are below and may be wider, so zoom on a larger area around it
    if (type.fields.length > 1 && best.score < 1) {
      const rh = Math.max(...best.rows.map((r) => r.height));
      const missing = type.fields.length - Object.keys(best.values).length;
      crop.h += missing * rh * 1.6;
      crop.x -= (b.x1 - b.x0) * 0.3;
      crop.w += (b.x1 - b.x0) * 0.6;
    }
    crop.x = Math.max(0, crop.x);
    crop.y = Math.max(0, crop.y);
    const srcImg = best.transform ? best.transform(img) : best.rotation ? rotateImage(img, best.rotation) : img;
    crop.w = Math.min(srcImg.width - crop.x, crop.w);
    crop.h = Math.min(srcImg.height - crop.y, crop.h);
    // zoom only helps when the display is small in the frame
    if (crop.w < srcImg.width * 0.75 || crop.h < srcImg.height * 0.75) {
      const z = attempt(srcImg, best.rotation, { crop, threshold: best.readOpts.threshold, invert: best.readOpts.invert, quarter: best.readOpts.quarter }, 1, best.transform);
      // The zoomed read sees the digits at higher resolution: prefer it when it is as
      // plausible for a complete reading, but only when strictly better for a partial
      // one (a partial zoom can pick a different row, e.g. pulse read as systolic).
      if (best.score >= 1 ? z.score >= best.score - 0.05 : z.score > best.score) best = z;
    }
  }

  if (!best) return { values: {}, score: 0, confidence: 0, rows: [], box: null, rotation: 0 };
  const { readOpts, transform, ...result } = best;
  // read on a quarter-turned copy: report the boxes in the photo's own orientation
  if (readOpts.quarter) {
    const k = readOpts.quarter;
    const { width: w, height: h } = img;
    const map = (b) => {
      if (k === 1) return { x0: b.y0, x1: b.y1, y0: h - 1 - b.x1, y1: h - 1 - b.x0 };
      if (k === 3) return { x0: w - 1 - b.y1, x1: w - 1 - b.y0, y0: b.x0, y1: b.x1 };
      return { x0: w - 1 - b.x1, x1: w - 1 - b.x0, y0: h - 1 - b.y1, y1: h - 1 - b.y0 };
    };
    result.rows = result.rows.map((r) => ({ ...r, box: map(r.box) }));
    if (result.box) result.box = map(result.box);
    result.orientation = k * 90;
    result.rotation = 0;
  }
  if (opts.debug) result.passes = passes.map((p) => ({ score: p.score, values: p.values, rows: p.rows.map((r) => r.text), opts: { ...p.readOpts, crop: p.readOpts.crop && 'crop' }, rotation: p.rotation, box: p.box, crop: p.readOpts.crop }));
  delete result.transform;
  return result;
}
