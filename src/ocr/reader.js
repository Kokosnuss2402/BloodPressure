// High-level reader: runs the seven-segment recogniser in several passes
// (different thresholds, small rotations, zoom-in on the detected display)
// and keeps the most plausible reading for the requested measurement type.

import { prepare, readPrepared, displayCandidates, pickDisplayStack, cropImage, releaseScratch } from './sevenSegment.js';
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

/** Map a point of a w×h image rotated by `deg` (rotateImage, about the centre) back. */
function unrotate(deg, w, h) {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = w / 2;
  const cy = h / 2;
  // rotateImage samples the source at R(p - c) + c
  return ([x, y]) => [cos * (x - cx) + sin * (y - cy) + cx, -sin * (x - cx) + cos * (y - cy) + cy];
}

/** Map a point of a quarter-turned image (k turns clockwise of a w×h image) back. */
function unturn(k, w, h) {
  if (k === 1) return ([x, y]) => [y, h - 1 - x];
  if (k === 3) return ([x, y]) => [w - 1 - y, x];
  if (k === 2) return ([x, y]) => [w - 1 - x, h - 1 - y];
  return (p) => p;
}

/**
 * Read a measurement device display.
 *
 * Every reading pass works on a "view" of the photo: the photo itself, a
 * slightly rotated or quarter-turned copy, or a crop around a display
 * candidate. A view knows how to map its coordinates back to the photo, so the
 * boxes of the result always mark the display in the photo.
 *
 *   1. quick pass on the whole photo (close-ups: done)
 *   2. display candidates: clusters of segment strokes, each read in all four
 *      orientations on a small crop
 *   3. fallback: further thresholds, high resolution, LED, small and quarter turns
 *   4. zoom on the best reading
 *   5. vote digit by digit across several thresholds of the final crop; digits
 *      without a clear majority are reported as uncertain
 *
 * @param {ImageData|{width:number,height:number,data:Uint8ClampedArray}} img
 * @param {'bp'|'glucose'|'weight'} kind
 * @param {{crop?:{x:number,y:number,w:number,h:number}, settings?:object, debug?:boolean}} [opts]
 *   crop: area the user marked; settings: user units (glucoseUnit, weightUnit)
 * @returns {{values: object, score: number, confidence: number, rows: Array, box: object|null,
 *   rotation: number, uncertain: string[]}}
 */
export function readDisplay(img, kind = 'bp', opts = {}) {
  const type = MEASUREMENT_TYPES[kind];
  const multi = type.fields.length > 1;
  const longSide = Math.max(img.width, img.height);
  const passes = [];

  // ---- views
  // lazily computed images that can be released again (and are recomputed if
  // needed later): turned copies of a large photo are 13 MB each
  const memo = (f) => {
    let v;
    const get = () => (v ??= f());
    get.release = () => (v = undefined);
    return get;
  };
  const release = (view) => {
    view.image.release?.();
    view.full.release?.();
    if (prepCache.view === view) prepCache = { key: null, prep: null, view: null };
  };
  const photoView = { key: 'photo', image: () => img, factor: 1, full: () => img, toPhoto: (p) => p, rotation: 0 };
  const small = memo(() => downscale(img, 1000));
  const rotView = (deg) => ({
    key: `rot${deg}`,
    image: memo(() => rotateImage(small().image, deg)),
    factor: small().factor,
    full: memo(() => rotateImage(img, deg)),
    toPhoto: unrotate(deg, img.width, img.height),
    rotation: deg,
  });
  const quarterView = (k, fullRes) => {
    const src = fullRes ? { image: img, factor: 1 } : small();
    return {
      key: `q${k}${fullRes ? 'f' : ''}`,
      image: memo(() => rotateQuarter(src.image, k)),
      factor: src.factor,
      full: memo(() => rotateQuarter(img, k)),
      toPhoto: unturn(k, img.width, img.height),
      rotation: k * 90,
    };
  };
  // a crop of the photo around a display candidate (pix: the crop, copied once
  // per candidate), turned by k quarters or rotated by a few degrees
  const cropView = (i, pix, k, deg = 0) => {
    const turned = memo(() => (deg ? rotateImage(pix, deg) : rotateQuarter(pix, k)));
    const inCrop = deg ? unrotate(deg, pix.width, pix.height) : unturn(k, pix.width, pix.height);
    const back = (p) => {
      const q = inCrop(p);
      return [q[0] + pix.x, q[1] + pix.y];
    };
    return { key: `c${i}q${k}r${deg}`, image: turned, factor: 1, full: turned, toPhoto: back, rotation: deg || k * 90, isCrop: true };
  };

  // ---- one reading pass (prepared images are shared between thresholds)
  // Only the most recent prepared image is kept: passes on the same view run back
  // to back, and keeping all of them costs hundreds of MB on large photos.
  let prepCache = { key: null, prep: null, view: null };
  const attempt = (view, readOpts) => {
    const image = view.image();
    // a crop view is read as a crop (glyphs may fill it; small crops are enlarged)
    const crop = readOpts.crop ?? (view.isCrop ? { x: 0, y: 0, w: image.width, h: image.height } : null);
    const pkey = `${view.key}|${readOpts.maxDim ?? 900}|${readOpts.invert ? 1 : 0}|${crop ? [crop.x, crop.y, crop.w, crop.h].map(Math.round).join(',') : ''}`;
    if (prepCache.key !== pkey) {
      prepCache = { key: null, prep: null, view: null }; // free the previous one first
      prepCache = { key: pkey, prep: prepare(image, { maxDim: readOpts.maxDim ?? 900, invert: readOpts.invert, crop }), view };
    }
    const prep = prepCache.prep;
    const { rows } = readPrepared(prep, { threshold: readOpts.threshold ?? 0.18, far: readOpts.far });
    // multi-value displays (blood pressure): the stacked rows; single-value: every candidate row
    const picked = multi ? pickDisplayStack(rows) : rows.filter((r) => r.value !== null);
    // boxes in full-resolution units of the view; rel: digit height relative to the photo
    const stack = picked.map((r) => ({ ...r, box: scaleBox(r.box, view.factor), height: r.height * view.factor, rel: (r.height * view.factor) / longSide }));
    const mapped = type.fromDisplayRows(stack, opts.settings);
    if (!multi && mapped.values && stack.length) {
      // keep only the row that was used, for the overlay and the zoom pass
      const used = stack.filter((r) => r === mapped.row);
      if (used.length) stack.splice(0, stack.length, ...used);
    }
    const pass = { ...mapped, rows: stack, box: stack.length ? stackBox(stack) : null, view, readOpts };
    passes.push(pass);
    if (globalThis.__memTrace) { const m = process.memoryUsage(); globalThis.__memTrace.push(m.heapUsed + m.arrayBuffers); }
    return pass;
  };
  // A reading on a display candidate that two thresholds agree on is accepted
  // even below a perfect score (small digits score lower by design).
  let accepted = false;
  const good = () => accepted || passes.some((p) => p.score >= 1);
  // best first; on equal plausibility prefer readings that saw the digits larger
  // (display crops, then higher working resolution)
  const detail = (p) => (p.view.isCrop || p.readOpts.crop ? 2 : 0) + (p.readOpts.maxDim ?? 900) / 2400;
  const better = (a, b) => b.score - a.score || detail(b) - detail(a);
  // done with a view: free its images unless it holds the best reading so far
  const doneWith = (view) => {
    const top = passes.reduce((a, p) => (!a || better(a, p) > 0 ? p : a), null);
    if (top?.view !== view) release(view);
  };
  const base = opts.crop ? { crop: opts.crop } : {};

  // 1. quick pass (close-ups of a monitor)
  attempt(photoView, { ...base, threshold: 0.18 });

  // 2. display candidates (skipped when the user marked the area): small crops,
  // read upright, slightly tilted and in the other quarter turns. Candidates are
  // searched for dark digits on a light background and, failing that, for bright
  // digits on a dark one (LED / backlit displays).
  if (!good() && !opts.crop) {
    const orientations = [[0, 0], [0, -6], [0, 6], [1, 0], [3, 0], [0, -10], [0, 10], [2, 0]];
    let n = 0;
    for (const invert of [false, true]) {
      if (good()) break;
      // the prepared full image is only needed to find the candidates
      const cands = displayCandidates(prepare(img, { maxDim: type.farDisplay ? 2400 : 1600, invert }), { max: 2 });
      for (const cb of cands) {
        if (good()) break;
        const i = n++;
        const bw = cb.x1 - cb.x0;
        const bh = cb.y1 - cb.y0;
        const m = Math.max(0.3 * Math.max(bw, bh), 6 * cb.t);
        const pix = cropImage(img, { x: cb.x0 - m, y: cb.y0 - m, w: bw + 2 * m, h: bh + 2 * m });
        for (const [k, deg] of orientations) {
          const view = cropView(i, pix, k, deg);
          // a second threshold only where the first one found digits at all
          const first = attempt(view, { threshold: 0.18, maxDim: 900, invert });
          if (first.score < 1 && first.rows.length) {
            const second = attempt(view, { threshold: 0.12, maxDim: 900, invert });
            const same = JSON.stringify(first.values) === JSON.stringify(second.values);
            const complete = Object.keys(first.values).length === type.fields.length;
            if (same && complete && Math.min(first.score, second.score) >= 0.85) accepted = true;
          }
          doneWith(view);
          if (good()) break;
        }
      }
    }
  }

  // 3. fallback: the whole photo with further settings
  if (!good()) {
    for (const threshold of [0.12, 0.25]) {
      attempt(photoView, { ...base, threshold });
      if (good()) break;
    }
  }
  // display far away (small in the frame): read at higher resolution
  // (for scales always, unless a display candidate already gave a sure reading:
  // the quick low-resolution pass can misread a small display plausibly)
  if (!good() || (type.farDisplay && !accepted && !passes.some((p) => p.view.isCrop && p.score >= 1))) {
    for (const threshold of [0.18, 0.12]) {
      if (attempt(photoView, { ...base, threshold, maxDim: 2400, far: true }).score >= 1) break;
    }
  }
  // LED / backlit displays: bright digits on a dark background
  if (!good()) {
    for (const maxDim of [900, 1800]) {
      for (const threshold of [0.18, 0.12]) {
        attempt(photoView, { ...base, threshold, maxDim, invert: true });
        if (good()) break;
      }
      if (good()) break;
    }
  }
  // tilted photo: read slightly rotated copies
  if (!good()) {
    const c = opts.crop;
    const f = small().factor;
    const crop = c && { x: c.x / f, y: c.y / f, w: c.w / f, h: c.h / f };
    for (const rot of [-6, 6, -10, 10]) {
      const view = rotView(rot);
      for (const [threshold, invert] of [[0.18, false], [0.12, false], [0.18, true]]) {
        attempt(view, { crop, threshold, invert });
        if (good()) break;
      }
      doneWith(view);
      if (good()) break;
    }
    small.release(); // the downscaled copy is only needed for these
  }
  // photo sideways or upside down (e.g. EXIF orientation not applied): quarter
  // turns. Far-away displays need the full resolution, and both sideways
  // directions are tried: upside-down seven-segment digits often still look like
  // digits (6/9, 2/2), so the more plausible reading decides.
  if (!good()) {
    for (const k of [1, 3, 2]) {
      const view = quarterView(k, !!type.farDisplay);
      const extra = type.farDisplay ? { maxDim: 2400, far: true } : {};
      for (const threshold of [0.18, 0.12]) {
        const ps = attempt(view, { threshold, ...extra });
        if (ps.score >= 1) break;
      }
      doneWith(view);
      if (good() && k !== 1) break;
    }
  }

  passes.sort(better);
  let best = passes[0];

  // 4. zoom: re-read just the display region at higher resolution
  if (best?.box && !best.view.isCrop) {
    const b = best.box;
    const mw = (b.x1 - b.x0) * 0.35;
    const mh = (b.y1 - b.y0) * (best.rows.length > 1 ? 0.15 : 0.4);
    const crop = { x: b.x0 - mw, y: b.y0 - mh, w: b.x1 - b.x0 + 2 * mw, h: b.y1 - b.y0 + 2 * mh };
    // multi-row display read only partly (e.g. SYS found, DIA/PUL missed): the other
    // rows are below and may be wider, so zoom on a larger area around it
    if (multi && best.score < 1) {
      const rh = Math.max(...best.rows.map((r) => r.height));
      const missing = type.fields.length - Object.keys(best.values).length;
      crop.h += missing * rh * 1.6;
      crop.x -= (b.x1 - b.x0) * 0.3;
      crop.w += (b.x1 - b.x0) * 0.6;
    }
    const full = best.view.full();
    crop.x = Math.max(0, crop.x);
    crop.y = Math.max(0, crop.y);
    crop.w = Math.min(full.width - crop.x, crop.w);
    crop.h = Math.min(full.height - crop.y, crop.h);
    // zoom only helps when the display is small in the frame
    if (crop.w < full.width * 0.75 || crop.h < full.height * 0.75) {
      const zoomView = { ...best.view, key: `${best.view.key}-full`, image: best.view.full, factor: 1 };
      const z = attempt(zoomView, { crop, threshold: best.readOpts.threshold, invert: best.readOpts.invert });
      // The zoomed read sees the digits at higher resolution: prefer it when it is as
      // plausible for a complete reading, but only when strictly better for a partial
      // one (a partial zoom can pick a different row, e.g. pulse read as systolic).
      if (best.score >= 1 ? z.score >= best.score - 0.05 : z.score > best.score) best = z;
    }
  }

  // single-number displays: a weak best guess is texture, not a reading
  if (best && !multi && best.score < 0.4) best = null;
  if (!best) {
    releaseScratch();
    return { values: {}, score: 0, confidence: 0, rows: [], box: null, rotation: 0, uncertain: [] };
  }

  // 5. vote digit by digit across thresholds of the same view and area
  let uncertain = [];
  if (best.rows.length) {
    const others = [best];
    // same view and area as the chosen reading (a crop view already is the area)
    for (const threshold of [0.12, 0.15, 0.18, 0.22, 0.25]) {
      if (Math.abs(threshold - (best.readOpts.threshold ?? 0.18)) < 1e-6) continue;
      others.push(attempt(best.view, { ...best.readOpts, threshold }));
    }
    const voted = voteRows(best.rows, others);
    // which field came from which row, before the rows are replaced
    const rowIndex = new Map(best.rows.map((r, i) => [r, i]));
    const fieldIndex = Object.entries(best.fieldRows ?? {}).map(([k, r]) => [k, rowIndex.get(r)]);
    const re = type.fromDisplayRows(voted.rows, opts.settings);
    // use the voted reading unless it became less plausible
    if (re.score >= best.score - 1e-9) {
      best = { ...best, ...re, rows: multi ? voted.rows : re.row ? [re.row] : voted.rows };
      const fr = best.fieldRows ?? {};
      uncertain = Object.keys(fr).filter((k) => fr[k]?.uncertain?.length);
    } else {
      // kept the original reading: its fields are uncertain where the vote disagreed
      uncertain = fieldIndex.filter(([, i]) => i !== undefined && voted.rows[i]?.uncertain?.length).map(([k]) => k);
    }
  }

  // map rows and box back to the photo: `poly` = four corners in the photo
  const toPhoto = best.view.toPhoto;
  const polyOf = (b) => [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]].map(toPhoto);
  const bboxOf = (poly) => ({
    x0: Math.min(...poly.map((p) => p[0])),
    x1: Math.max(...poly.map((p) => p[0])),
    y0: Math.min(...poly.map((p) => p[1])),
    y1: Math.max(...poly.map((p) => p[1])),
  });
  const result = {
    values: best.values,
    score: best.score,
    confidence: best.confidence,
    rows: best.rows.map((r) => {
      const poly = polyOf(r.box);
      return { ...r, poly, box: bboxOf(poly) };
    }),
    box: best.box ? bboxOf(polyOf(best.box)) : null,
    rotation: 0, // boxes are in the photo's own orientation
    orientation: best.view.rotation,
    uncertain,
  };
  // the worker keeps running between readings: free the work buffers
  releaseScratch();
  if (opts.debug)
    result.passes = passes.map((p) => ({ score: p.score, values: p.values, rows: p.rows.map((r) => r.text), view: p.view.key, opts: { ...p.readOpts, crop: p.readOpts.crop && 'crop' }, box: p.box }));
  return result;
}

/**
 * Per-digit majority vote. `rows` are the rows of the chosen reading; `passes`
 * are readings of the same view and area with other thresholds. A digit keeps
 * the character most passes agree on (exactly decoded digits count double);
 * positions without a clear majority are listed in row.uncertain.
 */
export function voteRows(rows, passes) {
  const iou = (a, b) => {
    const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
    const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    const inter = ix * iy;
    const ua = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
    return ua > 0 ? inter / ua : 0;
  };
  const out = rows.map((row) => {
    const tallies = row.digits.map(() => new Map());
    let voters = 0;
    for (const p of passes) {
      const match = p.rows.filter((r) => iou(r.box, row.box) > 0.4).sort((a, b) => iou(b.box, row.box) - iou(a.box, row.box))[0];
      if (!match || match.digits.length !== row.digits.length) continue;
      voters++;
      match.digits.forEach((d, i) => {
        if (d.char === '?') return;
        tallies[i].set(d.char, (tallies[i].get(d.char) ?? 0) + (d.exact ? 2 : 1));
      });
    }
    const uncertain = [];
    const digits = row.digits.map((d, i) => {
      const t = [...tallies[i].entries()].sort((a, b) => b[1] - a[1]);
      const total = t.reduce((s, [, n]) => s + n, 0);
      if (!t.length) {
        uncertain.push(i);
        return d;
      }
      const [char, n] = t[0];
      if (n / total < 0.7 || (voters < 2 && !d.exact)) uncertain.push(i);
      return char === d.char ? d : { ...d, char, exact: n / total >= 0.7 };
    });
    const text = digits.map((d) => d.char).join('');
    const value = /^\d+$/.test(text) ? parseInt(text, 10) : null;
    return {
      ...row,
      digits,
      text,
      value,
      number: Number.isFinite(value) ? value / 10 ** (row.decimals ?? 0) : null,
      confidence: digits.filter((d) => d.exact).length / Math.max(1, digits.length),
      uncertain,
      voters,
    };
  });
  return { rows: out };
}
