// Seven-segment LCD reader that runs entirely in the browser (no network).
//
// Pipeline:
//   1. grayscale + downscale
//   2. adaptive (Bradley) threshold -> mask of "darker than surroundings" pixels
//   3. connected components -> keep the ones shaped like LCD segments
//   4. estimate the italic slant of the digits and un-shear the segments
//   5. merge nearby segments into digits, digits into rows (numbers)
//   6. decode every digit by sampling the seven segment zones
//
// Works on any ImageData-like object: { width, height, data: RGBA bytes }.

const SEGMENT_PATTERNS = {
  // bits: a b c d e f g
  '0': 0b1111110,
  '1': 0b0110000,
  '2': 0b1101101,
  '3': 0b1111001,
  '4': 0b0110011,
  '5': 0b1011011,
  '6': 0b1011111,
  '7': 0b1110000,
  '8': 0b1111111,
  '9': 0b1111011,
};
// Common display variants
const VARIANTS = [
  ['7', 0b1110010], // 7 with segment f
  ['6', 0b0011111], // 6 without top bar
  ['9', 0b1110011], // 9 without bottom bar
  ['-', 0b0000001],
];
const ALL_PATTERNS = [...Object.entries(SEGMENT_PATTERNS), ...VARIANTS];

const SEG_NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

function popcount(n) {
  let c = 0;
  while (n) {
    c += n & 1;
    n >>= 1;
  }
  return c;
}

/** Decode a 7-bit segment mask into a character. */
export function decodeSegments(bits) {
  for (const [ch, p] of ALL_PATTERNS) if (p === bits) return { char: ch, exact: true };
  // nearest pattern with Hamming distance 1 (one segment misread)
  let best = null;
  let bestDist = 99;
  for (const [ch, p] of ALL_PATTERNS) {
    if (ch === '-') continue;
    const d = popcount(p ^ bits);
    if (d < bestDist) {
      bestDist = d;
      best = ch;
    } else if (d === bestDist) {
      best = null; // ambiguous
    }
  }
  if (bestDist === 1 && best) return { char: best, exact: false };
  return { char: '?', exact: false };
}

export function segmentsToString(bits) {
  return SEG_NAMES.filter((_, i) => bits & (1 << (6 - i))).join('');
}

// maxUp > 1 lets small crops be enlarged (thin segments of a small display separate better)
function toGray(img, maxDim, maxUp = 1) {
  const scale = Math.min(maxUp, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const gray = new Float32Array(w * h);
  const src = img.data;
  const sx = img.width / w;
  const sy = img.height / h;
  if (scale > 1) {
    // enlarging: bilinear interpolation of the luminance
    const lum = (x, y) => {
      const i = (y * img.width + x) * 4;
      return 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
    };
    for (let y = 0; y < h; y++) {
      const fy = Math.min(img.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
      const y0 = Math.floor(fy);
      const y1 = Math.min(img.height - 1, y0 + 1);
      const ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(img.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
        const x0 = Math.floor(fx);
        const x1 = Math.min(img.width - 1, x0 + 1);
        const tx = fx - x0;
        const top = lum(x0, y0) * (1 - tx) + lum(x1, y0) * tx;
        const bot = lum(x0, y1) * (1 - tx) + lum(x1, y1) * tx;
        gray[y * w + x] = top * (1 - ty) + bot * ty;
      }
    }
    return { gray, w, h, scale };
  }
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let sum = 0;
      let n = 0;
      // box filter while downscaling (sub-sampled for speed)
      const stepY = Math.max(1, ((y1 - y0) / 3) | 0);
      const stepX = Math.max(1, ((x1 - x0) / 3) | 0);
      for (let yy = y0; yy < y1; yy += stepY) {
        for (let xx = x0; xx < x1; xx += stepX) {
          const i = (yy * img.width + xx) * 4;
          sum += 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
          n++;
        }
      }
      gray[y * w + x] = sum / n;
    }
  }
  return { gray, w, h, scale };
}

function adaptiveThreshold(gray, w, h, win, t) {
  // integral image (Float64 to avoid precision loss)
  const integ = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      integ[(y + 1) * (w + 1) + x + 1] = integ[y * (w + 1) + x + 1] + row;
    }
  }
  const mask = new Uint8Array(w * h);
  const r = Math.max(2, win >> 1);
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - r);
    const yb = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - r);
      const xb = Math.min(w, x + r + 1);
      const count = (yb - ya) * (xb - xa);
      const sum =
        integ[yb * (w + 1) + xb] - integ[ya * (w + 1) + xb] - integ[yb * (w + 1) + xa] + integ[ya * (w + 1) + xa];
      if (gray[y * w + x] * count < sum * (1 - t)) mask[y * w + x] = 1;
    }
  }
  return mask;
}

function connectedComponents(mask, w, h) {
  const labels = new Int32Array(w * h).fill(-1);
  const comps = [];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || labels[start] !== -1) continue;
    const id = comps.length;
    const pixels = [];
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    while (sp > 0) {
      const p = stack[--sp];
      pixels.push(p);
      const x = p % w;
      const y = (p / w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      // 4-connectivity keeps neighbouring LCD segments apart
      if (x > 0 && mask[p - 1] && labels[p - 1] === -1) {
        labels[p - 1] = id;
        stack[sp++] = p - 1;
      }
      if (x < w - 1 && mask[p + 1] && labels[p + 1] === -1) {
        labels[p + 1] = id;
        stack[sp++] = p + 1;
      }
      if (y > 0 && mask[p - w] && labels[p - w] === -1) {
        labels[p - w] = id;
        stack[sp++] = p - w;
      }
      if (y < h - 1 && mask[p + w] && labels[p + w] === -1) {
        labels[p + w] = id;
        stack[sp++] = p + w;
      }
    }
    comps.push({ id, pixels, minX, minY, maxX, maxY });
  }
  return comps;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Stroke width = median length of the shorter of horizontal/vertical pixel runs.
function strokeWidth(c, w, bw, bh) {
  const grid = new Uint8Array(bw * bh);
  for (const p of c.pixels) grid[(((p / w) | 0) - c.minY) * bw + (p % w) - c.minX] = 1;
  const runs = (outer, inner, at) => {
    const out = [];
    for (let o = 0; o < outer; o++) {
      let run = 0;
      for (let i = 0; i <= inner; i++) {
        if (i < inner && at(o, i)) run++;
        else if (run) {
          out.push(run);
          run = 0;
        }
      }
    }
    return out;
  };
  const hr = runs(bh, bw, (y, x) => grid[y * bw + x]);
  const vr = runs(bw, bh, (x, y) => grid[y * bw + x]);
  return Math.min(median(hr), median(vr));
}

// cropped: the image is a close crop around the display, so glyphs may fill most of it
// far: also keep the tiny bars of a display far away in the frame (more noise)
function segmentCandidates(comps, w, h, cropped = false, far = false) {
  const minDim = Math.min(w, h);
  const out = [];
  for (const c of comps) {
    const bw = c.maxX - c.minX + 1;
    const bh = c.maxY - c.minY + 1;
    const area = c.pixels.length;
    if (area < Math.max(12, (minDim * (far ? 0.0035 : 0.006)) ** 2)) continue;
    if (bh > h * (cropped ? 0.9 : 0.25) || bw > w * (cropped ? 0.5 : 0.3)) continue;
    if (c.minX === 0 || c.minY === 0 || c.maxX === w - 1 || c.maxY === h - 1) continue;
    const length = Math.max(bw, bh);
    const thickness = strokeWidth(c, w, bw, bh);
    if (thickness < 1.5) continue;
    const elong = length / thickness;
    const fill = area / (bw * bh);
    // single segment: elongated bar
    const isBar = elong >= 2.2 && elong <= 14 && fill >= 0.3 && Math.min(bw, bh) < 2.2 * thickness + 0.15 * length;
    // several touching segments (corner-joined): hollow shape made of strokes
    const isJoined = !isBar && fill < 0.72 && fill > 0.2 && Math.min(bw, bh) >= 2.5 * thickness && length / thickness < 16;
    if (!isBar && !isJoined) continue;
    // centroid & second moments (for slant estimation)
    let sx = 0;
    let sy = 0;
    for (const p of c.pixels) {
      sx += p % w;
      sy += (p / w) | 0;
    }
    const cx = sx / area;
    const cy = sy / area;
    let cov = 0;
    let vy = 0;
    for (const p of c.pixels) {
      const dx = (p % w) - cx;
      const dy = ((p / w) | 0) - cy;
      cov += dx * dy;
      vy += dy * dy;
    }
    out.push({
      ...c,
      area,
      thickness,
      vertical: isBar ? bh > bw : bh >= bw * 0.6,
      joined: isJoined,
      cx,
      cy,
      slope: vy > 0 ? cov / vy : 0,
    });
  }
  return out;
}

/**
 * Italic slant of the digits: the shear x' = x - s*y under which the segment
 * pixels line up most sharply in columns (sum of squared column counts).
 * Works for separate bar segments and for blobs of merged segments alike.
 */
function estimateSlant(segs, w) {
  // Separate bar segments (most LCDs up close): their own slope is the most reliable cue.
  const bars = segs.filter((sg) => sg.vertical && !sg.joined && sg.maxY - sg.minY > 3 * sg.thickness);
  if (bars.length >= 4) {
    const m = median(bars.map((v) => v.slope));
    return Number.isFinite(m) && Math.abs(m) <= 0.4 ? m : 0;
  }
  // Merged segments (far away / tight gaps): column-projection sharpness.
  const pts = [];
  for (const sg of segs) {
    if (!sg.vertical) continue;
    const step = Math.max(1, Math.floor(sg.pixels.length / 400)); // subsample big blobs
    for (let i = 0; i < sg.pixels.length; i += step) pts.push(sg.pixels[i]);
  }
  if (pts.length < 50) return 0;
  const xs = new Float32Array(pts.length);
  const ys = new Float32Array(pts.length);
  pts.forEach((p, i) => {
    xs[i] = p % w;
    ys[i] = (p / w) | 0;
  });
  let best = 0;
  let bestScore = -1;
  const hist = new Map();
  for (let s = -0.35; s <= 0.3501; s += 0.025) {
    hist.clear();
    for (let i = 0; i < xs.length; i++) {
      const b = Math.round(xs[i] - s * ys[i]);
      hist.set(b, (hist.get(b) ?? 0) + 1);
    }
    let score = 0;
    for (const c of hist.values()) score += c * c;
    // prefer upright when scores are nearly equal
    score *= 1 - 0.15 * Math.abs(s);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return Math.abs(best) < 0.0125 ? 0 : best;
}

function shearBoxes(segs, w, s) {
  for (const seg of segs) {
    let minX = Infinity;
    let maxX = -Infinity;
    for (const p of seg.pixels) {
      const x = (p % w) - s * ((p / w) | 0);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
    seg.box = { x0: minX, x1: maxX, y0: seg.minY, y1: seg.maxY };
  }
}

function boxesNear(a, b, ex, ey) {
  return a.x0 - ex <= b.x1 && b.x0 - ex <= a.x1 && a.y0 - ey <= b.y1 && b.y0 - ey <= a.y1;
}

function groupDigits(segs) {
  // union-find on segments whose (sheared) boxes are close
  const parent = segs.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const a = segs[i];
      const b = segs[j];
      const tmin = Math.min(a.thickness, b.thickness);
      const tmax = Math.max(a.thickness, b.thickness);
      if (tmax > tmin * 2.2) continue; // different stroke widths -> different glyph sizes
      if (boxesNear(a.box, b.box, 0.45 * tmin, 1.1 * tmin)) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  segs.forEach((s, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(s);
  });
  const digits = [];
  for (const members of groups.values()) {
    const box = {
      x0: Math.min(...members.map((m) => m.box.x0)),
      x1: Math.max(...members.map((m) => m.box.x1)),
      y0: Math.min(...members.map((m) => m.box.y0)),
      y1: Math.max(...members.map((m) => m.box.y1)),
    };
    const t = median(members.map((m) => m.thickness));
    const bw = box.x1 - box.x0 + 1;
    const bh = box.y1 - box.y0 + 1;
    // A digit is taller than wide and has at least one vertical segment
    if (bh < bw * 0.9 || bh < t * 4) continue;
    if (!members.some((m) => m.vertical)) continue;
    if (members.length > 9) continue;
    digits.push({ members, box, t, w: bw, h: bh });
  }
  return digits;
}

function groupRows(digits) {
  digits.sort((a, b) => a.box.x0 - b.box.x0);
  const rows = [];
  const used = new Set();
  for (let i = 0; i < digits.length; i++) {
    if (used.has(i)) continue;
    const row = [digits[i]];
    used.add(i);
    let last = digits[i];
    for (let j = i + 1; j < digits.length; j++) {
      if (used.has(j)) continue;
      const d = digits[j];
      const hRatio = d.h / last.h;
      const cyA = (last.box.y0 + last.box.y1) / 2;
      const cyB = (d.box.y0 + d.box.y1) / 2;
      const gap = d.box.x0 - last.box.x1;
      if (hRatio < 0.75 || hRatio > 1.33) continue;
      if (Math.abs(cyA - cyB) > 0.25 * Math.max(d.h, last.h)) continue;
      if (gap < -0.2 * d.h || gap > 0.9 * d.h) continue;
      row.push(d);
      used.add(j);
      last = d;
    }
    rows.push(row);
  }
  return rows;
}

function decodeRow(row, w, s, mask) {
  const y0 = Math.min(...row.map((d) => d.box.y0));
  const y1 = Math.max(...row.map((d) => d.box.y1));
  const rh = y1 - y0 + 1;
  const wide = row.filter((d) => d.w > rh * 0.35);
  const cellW = wide.length ? median(wide.map((d) => d.w)) : rh * 0.55;
  const chars = [];
  let exact = 0;
  for (const d of row) {
    if (d.w < cellW * 0.5) {
      // narrow glyph: a "1" (segments b+c) - require two stacked verticals or one tall one
      const verts = d.members.filter((m) => m.vertical);
      const vSpan = Math.max(...verts.map((m) => m.box.y1)) - Math.min(...verts.map((m) => m.box.y0));
      if (vSpan > rh * 0.7) {
        chars.push({ char: '1', exact: true, bits: SEGMENT_PATTERNS['1'] });
        exact++;
      } else chars.push({ char: '?', exact: false, bits: 0 });
      continue;
    }
    // rasterise members into a set of sheared pixel coordinates for zone sampling
    const cx0 = d.box.x0;
    const cw = d.w;
    const zones = [
      [0.3, 0.7, 0.0, 0.16], // a
      [0.72, 1.0, 0.12, 0.44], // b
      [0.72, 1.0, 0.56, 0.88], // c
      [0.3, 0.7, 0.84, 1.0], // d
      [0.0, 0.28, 0.56, 0.88], // e
      [0.0, 0.28, 0.12, 0.44], // f
      [0.3, 0.7, 0.42, 0.58], // g
    ];
    const hits = new Array(7).fill(0);
    const totals = new Array(7).fill(0);
    // sample a grid inside each zone against the mask (in unsheared image space)
    for (let z = 0; z < 7; z++) {
      const [u0, u1, v0, v1] = zones[z];
      const steps = 6;
      for (let iy = 0; iy < steps; iy++) {
        const yy = y0 + (v0 + ((v1 - v0) * (iy + 0.5)) / steps) * rh;
        for (let ix = 0; ix < steps; ix++) {
          const xs = cx0 + (u0 + ((u1 - u0) * (ix + 0.5)) / steps) * cw;
          const xi = Math.round(xs + s * yy);
          const yi = Math.round(yy);
          totals[z]++;
          if (xi >= 0 && xi < w && mask.has(yi * w + xi)) hits[z]++;
        }
      }
    }
    let bits = 0;
    for (let z = 0; z < 7; z++) if (hits[z] / totals[z] > 0.12) bits |= 1 << (6 - z);
    const dec = decodeSegments(bits);
    if (dec.exact) exact++;
    chars.push({ ...dec, bits });
  }
  const text = chars.map((c) => c.char).join('');
  return {
    text,
    value: /^\d+$/.test(text) ? parseInt(text, 10) : null,
    confidence: chars.length ? exact / chars.length : 0,
    digits: chars,
    height: rh,
    box: {
      x0: Math.min(...row.map((d) => d.box.x0)),
      x1: Math.max(...row.map((d) => d.box.x1)),
      y0,
      y1,
    },
  };
}

/**
 * Look for a decimal point: a small compact blob near the baseline, in the gap
 * between two digits of the row. Returns { decimals } = digits after the point.
 */
function findDecimal(row, cands, w, slant) {
  if (row.length < 2) return { decimals: 0 };
  const t = median(row.map((d) => d.t));
  const y1 = Math.max(...row.map((d) => d.box.y1));
  const y0 = Math.min(...row.map((d) => d.box.y0));
  const rh = y1 - y0 + 1;
  const sorted = [...row].sort((a, b) => a.box.x0 - b.box.x0);
  let best = null;
  for (const c of cands) {
    const bw = c.maxX - c.minX + 1;
    const bh = c.maxY - c.minY + 1;
    const area = c.pixels.length;
    if (bw < 0.45 * t || bh < 0.45 * t || bw > 2.4 * t || bh > 2.4 * t) continue;
    if (area < 0.25 * t * t || area > 5 * t * t || area / (bw * bh) < 0.45) continue;
    const cy = (c.minY + c.maxY) / 2;
    if (cy < y1 - 0.3 * rh || cy > y1 + 0.12 * rh) continue;
    const cx = (c.minX + c.maxX) / 2 - slant * cy; // de-slanted, like the digit boxes
    for (let k = 0; k < sorted.length - 1; k++) {
      const a = sorted[k].box;
      const b = sorted[k + 1].box;
      // between the centres of two neighbouring digits, in the lower right of the first
      const ca = (a.x0 + a.x1) / 2;
      const cb = (b.x0 + b.x1) / 2;
      if (cx > ca + 0.25 * (a.x1 - a.x0) && cx < cb - 0.1 * (b.x1 - b.x0)) {
        const score = Math.abs(cy - (y1 - t / 2));
        if (!best || score < best.score) best = { score, k };
      }
    }
  }
  return { decimals: best ? sorted.length - 1 - best.k : 0 };
}

/**
 * Read all seven-segment numbers in an image.
 * @param {{width:number,height:number,data:Uint8ClampedArray}} img
 * @param {{maxDim?:number, crop?:{x:number,y:number,w:number,h:number}}} [opts]
 *   crop is in source pixel units (optional region of interest)
 *   invert: read bright segments on a dark background (LED / backlit displays)
 * @returns {{rows: Array<{text:string,value:number|null,number:number|null,decimals:number,confidence:number,height:number,box:object}>, slant:number}}
 *   value = digits as an integer, number = value with the detected decimal point
 */
export function readSevenSegment(img, opts = {}) {
  const src = opts.crop ? cropImage(img, opts.crop) : img;
  const { gray, w, h, scale } = toGray(src, opts.maxDim ?? 900, opts.crop ? 2 : 1);
  // LED / backlit displays: bright segments on a dark background
  if (opts.invert) for (let i = 0; i < gray.length; i++) gray[i] = 255 - gray[i];
  const win = Math.round(Math.max(w, h) / 10);
  const mask = adaptiveThreshold(gray, w, h, win, opts.threshold ?? 0.18);
  const comps = connectedComponents(mask, w, h);
  const segs = segmentCandidates(comps, w, h, !!opts.crop, !!opts.far);

  const slant = estimateSlant(segs, w);
  shearBoxes(segs, w, slant);

  const digits = groupDigits(segs);
  const rows = groupRows(digits);

  const segPixels = new Set();
  for (const d of digits) for (const m of d.members) for (const p of m.pixels) segPixels.add(p);

  const used = new Set();
  for (const d of digits) for (const m of d.members) used.add(m.id);
  // size is checked against the stroke width in findDecimal
  const dotCands = comps.filter((c) => !used.has(c.id) && c.pixels.length >= 3 && c.pixels.length < 20000);

  const decoded = rows
    .map((r) => ({ ...decodeRow(r, w, slant, segPixels), ...findDecimal(r, dotCands, w, slant) }))
    .filter((r) => r.digits.length >= 1)
    .map((r) => ({ ...r, number: Number.isFinite(r.value) ? r.value / 10 ** r.decimals : null }))
    .map((r) => ({
      ...r,
      // boxes were computed in de-slanted space (x' = x - slant*y): map back to
      // the image and report them in source-image pixel units
      box: {
        x0: Math.min(r.box.x0 + slant * r.box.y0, r.box.x0 + slant * r.box.y1) / scale + (opts.crop?.x ?? 0),
        x1: Math.max(r.box.x1 + slant * r.box.y0, r.box.x1 + slant * r.box.y1) / scale + (opts.crop?.x ?? 0),
        y0: r.box.y0 / scale + (opts.crop?.y ?? 0),
        y1: r.box.y1 / scale + (opts.crop?.y ?? 0),
      },
      height: r.height / scale,
    }));
  decoded.sort((a, b) => a.box.y0 - b.box.y0);
  if (opts.debug) return { rows: decoded, slant, debug: { scale, w, h, comps, segs, digits, mask } };
  return { rows: decoded, slant };
}

function cropImage(img, c) {
  const x = Math.max(0, Math.round(c.x));
  const y = Math.max(0, Math.round(c.y));
  const w = Math.min(img.width - x, Math.round(c.w));
  const h = Math.min(img.height - y, Math.round(c.h));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let yy = 0; yy < h; yy++) {
    const so = ((y + yy) * img.width + x) * 4;
    data.set(img.data.subarray(so, so + w * 4), yy * w * 4);
  }
  return { width: w, height: h, data };
}

/**
 * Choose the stack of numbers that most likely forms the device display:
 * rows that are vertically stacked and overlap horizontally, made of valid digits.
 */
export function pickDisplayStack(rows) {
  const valid = rows.filter((r) => r.value !== null && r.text.length >= 2);
  let best = [];
  let bestScore = 0;
  for (const anchor of valid) {
    const stack = valid.filter((r) => {
      const overlap = Math.min(r.box.x1, anchor.box.x1) - Math.max(r.box.x0, anchor.box.x0);
      const minW = Math.min(r.box.x1 - r.box.x0, anchor.box.x1 - anchor.box.x0);
      return overlap > 0.3 * minW && r.height > anchor.height * 0.35 && r.height < anchor.height * 2.8;
    });
    stack.sort((a, b) => a.box.y0 - b.box.y0);
    const score = stack.reduce((s, r) => s + r.text.length * (0.5 + r.confidence), 0);
    if (score > bestScore) {
      bestScore = score;
      best = stack;
    }
  }
  return best;
}
