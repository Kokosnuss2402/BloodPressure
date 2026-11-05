// Lightweight responsive SVG time-series chart with touch/hover tooltip.
// Colours come from CSS custom properties (colour-blind safe palette); every
// series also has its own marker shape and a direct label, so identity never
// depends on colour alone.

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}, parent) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};

const DAY = 86400000;

function niceStep(range, target) {
  const raw = range / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * pow;
}

function marker(shape, x, y, r, cls, parent) {
  if (shape === 'square') return el('rect', { x: x - r * 0.9, y: y - r * 0.9, width: r * 1.8, height: r * 1.8, rx: 1.5, class: cls }, parent);
  if (shape === 'triangle')
    return el('path', { d: `M${x},${y - r * 1.15} L${x + r * 1.05},${y + r * 0.8} L${x - r * 1.05},${y + r * 0.8} Z`, class: cls }, parent);
  if (shape === 'diamond')
    return el('path', { d: `M${x},${y - r * 1.2} L${x + r * 1.2},${y} L${x},${y + r * 1.2} L${x - r * 1.2},${y} Z`, class: cls }, parent);
  return el('circle', { cx: x, cy: y, r, class: cls }, parent);
}

export function markerSVG(shape, cls) {
  const svg = el('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true' });
  marker(shape, 8, 8, 5, cls, svg);
  return svg;
}

/**
 * @param {HTMLElement} container
 * @param {{
 *   series: Array<{key:string,label:string,cls:string,shape:string,points:Array<{t:number,v:number,ref?:any}>}>,
 *   refLines?: Array<{v:number,label:string}>,
 *   domain?: [number, number],
 *   height?: number,
 *   unit?: string,
 *   formatValue?: (v:number)=>string,
 *   tooltip?: (t:number, rows:Array<{series:object,point:object}>)=>string,
 *   onSelect?: (ref:any)=>void,
 * }} cfg
 */
export function renderChart(container, cfg) {
  container.innerHTML = '';
  container.classList.add('chart');
  const fmt = cfg.formatValue ?? ((v) => String(Math.round(v)));
  const series = cfg.series.filter((s) => s.points.length);
  if (!series.length) {
    const empty = document.createElement('p');
    empty.className = 'chart-empty';
    empty.textContent = 'No data in this period yet.';
    container.appendChild(empty);
    return;
  }

  const draw = () => {
    const width = Math.max(260, container.clientWidth);
    const height = cfg.height ?? 220;
    const m = { l: 36, r: series.length > 1 ? 40 : 14, t: 12, b: 26 };
    const iw = width - m.l - m.r;
    const ih = height - m.t - m.b;

    const allT = series.flatMap((s) => s.points.map((p) => p.t));
    let [t0, t1] = cfg.domain ?? [Math.min(...allT), Math.max(...allT)];
    if (t1 - t0 < DAY) {
      t0 -= DAY / 2;
      t1 += DAY / 2;
    }
    const pad = (t1 - t0) * 0.03;
    t0 -= pad;
    t1 += pad;

    const allV = series.flatMap((s) => s.points.map((p) => p.v));
    for (const r of cfg.refLines ?? []) allV.push(r.v);
    let v0 = Math.min(...allV);
    let v1 = Math.max(...allV);
    if (v1 - v0 < 10) {
      v0 -= 5;
      v1 += 5;
    }
    const step = niceStep(v1 - v0, 4);
    v0 = Math.floor((v0 - step * 0.3) / step) * step;
    v1 = Math.ceil((v1 + step * 0.3) / step) * step;

    const x = (t) => m.l + ((t - t0) / (t1 - t0)) * iw;
    const y = (v) => m.t + ih - ((v - v0) / (v1 - v0)) * ih;

    const svg = el('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' });
    svg.setAttribute('aria-label', series.map((s) => s.label).join(', ') + ' over time');

    // grid + y axis
    const g = el('g', { class: 'grid' }, svg);
    for (let v = v0; v <= v1 + 1e-9; v += step) {
      el('line', { x1: m.l, x2: m.l + iw, y1: y(v), y2: y(v) }, g);
      const tx = el('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-label' }, g);
      tx.textContent = fmt(v);
    }
    // x ticks
    const span = t1 - t0;
    const tickCount = Math.max(2, Math.floor(iw / 80));
    const days = span / DAY;
    const tickStepDays = days <= tickCount ? 1 : Math.ceil(days / tickCount);
    const first = new Date(t0);
    first.setHours(0, 0, 0, 0);
    for (let d = new Date(first); d.getTime() <= t1; d.setDate(d.getDate() + tickStepDays)) {
      const t = d.getTime();
      if (t < t0) continue;
      const tx = el('text', { x: x(t), y: height - 6, 'text-anchor': 'middle', class: 'axis-label' }, g);
      tx.textContent = d.toLocaleDateString(undefined, days > 300 ? { month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' });
    }

    // reference lines
    for (const r of cfg.refLines ?? []) {
      el('line', { x1: m.l, x2: m.l + iw, y1: y(r.v), y2: y(r.v), class: 'ref-line' }, svg);
      const tx = el('text', { x: m.l + 4, y: y(r.v) - 4, class: 'ref-label' }, svg);
      tx.textContent = r.label;
    }

    // series
    const showMarkers = series.every((s) => s.points.length <= 90);
    for (const s of series) {
      const pts = [...s.points].sort((a, b) => a.t - b.t);
      const gS = el('g', { class: `series ${s.cls}` }, svg);
      if (pts.length > 1) {
        el('path', { d: pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' '), class: 'line' }, gS);
      }
      if (showMarkers || pts.length === 1) for (const p of pts) marker(s.shape, x(p.t), y(p.v), 4, 'marker', gS);
      // direct label at the last point
      if (series.length > 1) {
        const last = pts[pts.length - 1];
        const tx = el('text', { x: m.l + iw + 6, y: y(last.v) + 4, class: 'direct-label' }, svg);
        tx.textContent = s.short ?? s.label;
      }
    }
    // keep direct labels from overlapping
    const labels = [...svg.querySelectorAll('.direct-label')].sort((a, b) => +a.getAttribute('y') - +b.getAttribute('y'));
    for (let i = 1; i < labels.length; i++) {
      const prev = +labels[i - 1].getAttribute('y');
      if (+labels[i].getAttribute('y') - prev < 13) labels[i].setAttribute('y', prev + 13);
    }

    // hover / touch layer
    const hover = el('g', { class: 'hover', visibility: 'hidden' }, svg);
    const cross = el('line', { y1: m.t, y2: m.t + ih, class: 'crosshair' }, hover);
    const hoverMarks = series.map((s) => marker(s.shape, 0, 0, 5.5, `marker hover-marker ${s.cls}`, hover));
    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;

    // nearest timestamp lookup on the union of all points
    const stamps = [...new Set(allT)].sort((a, b) => a - b);
    const hit = el('rect', { x: m.l, y: m.t, width: iw, height: ih, class: 'hit' }, svg);
    let current = null;
    const show = (evt) => {
      const rect = svg.getBoundingClientRect();
      const px = evt.clientX - rect.left;
      const tGuess = t0 + ((px - m.l) / iw) * (t1 - t0);
      let best = stamps[0];
      for (const t of stamps) if (Math.abs(t - tGuess) < Math.abs(best - tGuess)) best = t;
      current = best;
      const rows = series.map((s) => ({ series: s, point: s.points.find((p) => p.t === best) })).filter((r) => r.point);
      hover.setAttribute('visibility', 'visible');
      cross.setAttribute('x1', x(best));
      cross.setAttribute('x2', x(best));
      series.forEach((s, i) => {
        const p = s.points.find((pp) => pp.t === best);
        const mk = hoverMarks[i];
        mk.style.display = p ? '' : 'none';
        if (!p) return;
        const nx = x(best);
        const ny = y(p.v);
        // move marker by transform (works for every shape)
        mk.setAttribute('transform', `translate(${nx},${ny})`);
      });
      tip.innerHTML = cfg.tooltip
        ? cfg.tooltip(best, rows)
        : `<strong>${new Date(best).toLocaleString()}</strong>` +
          rows.map((r) => `<div>${r.series.label}: ${fmt(r.point.v)}</div>`).join('');
      tip.hidden = false;
      const tw = tip.offsetWidth;
      let left = x(best) + 12;
      if (left + tw > width - 4) left = x(best) - tw - 12;
      tip.style.left = `${Math.max(4, left)}px`;
      tip.style.top = `${m.t}px`;
    };
    const hide = () => {
      hover.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    };
    hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', hide);
    if (cfg.onSelect)
      hit.addEventListener('click', () => {
        const p = series.flatMap((s) => s.points).find((pp) => pp.t === current);
        if (p?.ref) cfg.onSelect(p.ref);
      });
    // hover markers were drawn at origin; shapes are centred there via translate
    hoverMarks.forEach((mk, i) => {
      mk.remove();
      hoverMarks[i] = marker(series[i].shape, 0, 0, 5.5, `marker hover-marker`, el('g', { class: `series ${series[i].cls}` }, hover));
    });

    container.replaceChildren(svg, tip);
  };

  draw();
  if (container._ro) container._ro.disconnect();
  let lastW = container.clientWidth;
  container._ro = new ResizeObserver(() => {
    if (Math.abs(container.clientWidth - lastW) > 4) {
      lastW = container.clientWidth;
      draw();
    }
  });
  container._ro.observe(container);
}
