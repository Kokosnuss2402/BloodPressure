import './styles.css';
import {
  listMeasurements,
  getMeasurement,
  saveMeasurement,
  deleteMeasurement,
  getPhoto,
  clearAll,
  bulkPut,
  getSetting,
  setSetting,
  listAllRecords,
  newId,
} from './db.js';
import { MEASUREMENT_TYPES, TYPE_LIST, GLUCOSE_CONTEXTS, DEFAULT_TAGS, formatGlucose, formatWeight, toMgdl, MGDL_PER_MMOL, LB_PER_KG, bmiOf } from './types.js';
import { toCSV, localDate } from './csv.js';
import { averages, byTimeOfDay, inLastDays, trend, allTags, unusualVsHistory } from './stats.js';
import { renderChart, markerSVG } from './chart.js';
import { icon, iconSVG } from './icons.js';
import { syncNow, scheduleSync, getSyncConfig, testConnection, resetSyncState, setPassphrase, forgetKey } from './sync.js';

// ---------------------------------------------------------------- helpers

function h(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

const $view = document.getElementById('view');
const $title = document.getElementById('view-title');
const $toast = document.getElementById('toast');
const $sync = document.getElementById('sync-indicator');

let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($toast.hidden = true), 2600);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtTime = (d) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const fmtDay = (d) => {
  const today = new Date();
  const yest = new Date(Date.now() - 86400000);
  if (localDate(d) === localDate(today)) return 'Today';
  if (localDate(d) === localDate(yest)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined });
};
function timeAgo(d) {
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
const toLocalInput = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const r0 = (v) => (Number.isFinite(v) ? Math.round(v) : '–');

function levelPill(level) {
  if (!level) return null;
  return h('span', { class: `pill lvl-${level.rank}`, title: level.label }, level.label);
}

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 500);
}

// ---------------------------------------------------------------- state

const state = {
  measurements: [],
  settings: {
    glucoseUnit: 'mg/dL',
    weightUnit: 'kg',
    heightCm: null,
    textSize: 'normal',
    keepPhotos: false,
    theme: 'system',
    tags: DEFAULT_TAGS,
    csvDelimiter: ',',
    claudeKey: '',
    claudeAuto: false,
  },
  overviewType: 'bp', // which measurement the overview shows
  historyFilter: { type: 'all', days: 0, tag: null },
  chartFilter: { type: 'bp', days: 30, tag: null },
};

async function loadSettings() {
  const ov = await getSetting('overviewType', 'bp');
  if (MEASUREMENT_TYPES[ov]) state.overviewType = ov;
  for (const k of Object.keys(state.settings)) state.settings[k] = await getSetting(k, state.settings[k]);
  applyTheme();
}
async function updateSetting(k, v) {
  state.settings[k] = v;
  await setSetting(k, v);
  if (k === 'theme' || k === 'textSize') applyTheme();
}
function applyTheme() {
  document.documentElement.dataset.textSize = state.settings.textSize;
  const t = state.settings.theme;
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}
async function reload() {
  state.measurements = await listMeasurements();
}
const tagList = () => allTags(state.measurements, state.settings.tags);

function afterChange() {
  if (!navigator.onLine) updateSyncIndicator(); // shows "offline – saved on device"; syncs when back online
  scheduleSync((r, err) => updateSyncIndicator(err ? 'Backup failed' : 'Backed up'));
}
async function updateSyncIndicator(text) {
  const cfg = await getSyncConfig();
  $sync.hidden = !cfg.enabled;
  const show = (name, label) => $sync.replaceChildren(icon(name, 15), document.createTextNode(` ${label}`));
  if (text) show(text === 'Backed up' ? 'cloud' : 'cloudOff', text);
  else {
    const last = await getSetting('syncLastResult', null);
    if (!cfg.key) show('lock', 'Backup locked');
    else if (!navigator.onLine) show('cloudOff', 'Offline – saved on device');
    else if (!last) show('cloud', 'Not synced yet');
    else if (last.ok) show('cloud', timeAgo(new Date(last.at)));
    else show('cloudOff', 'Backup failed');
  }
}

// ---------------------------------------------------------------- router

const routes = {
  overview: { title: 'Overview', render: renderOverview },
  history: { title: 'History', render: renderHistory },
  charts: { title: 'Charts', render: renderCharts },
  settings: { title: 'Settings', render: renderSettings },
  // old links to per-type pages: select the type on the overview instead
  type: {
    title: 'Overview',
    render: (root, { arg }) => {
      if (MEASUREMENT_TYPES[arg]) state.overviewType = arg;
      location.replace('#/overview');
    },
  },
  add: { title: 'New measurement', render: renderEditor },
  edit: { title: 'Edit measurement', render: renderEditor },
};

let currentCleanup = null;
async function route() {
  const [, name = 'overview', arg] = location.hash.match(/^#\/?([^/?]*)\/?([^?]*)/) ?? [];
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const r = routes[name] ?? routes.overview;
  currentCleanup?.();
  currentCleanup = null;
  $title.textContent = r.title;
  document.querySelectorAll('.tabbar a').forEach((a) => {
    if (a.dataset.tab === name || (name === 'edit' && a.dataset.tab === 'history')) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  $view.replaceChildren();
  const cleanup = await r.render($view, { arg, params });
  if (typeof cleanup === 'function') currentCleanup = cleanup;
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- overview

function renderOverview(root) {
  const content = h('div');
  const tiles = TYPE_LIST.map((t) =>
    h(
      'button',
      {
        class: 'btn big',
        type: 'button',
        'aria-pressed': String(state.overviewType === t.id),
        onclick: () => {
          state.overviewType = t.id;
          setSetting('overviewType', t.id);
          tiles.forEach((b, i) => b.setAttribute('aria-pressed', String(TYPE_LIST[i].id === t.id)));
          drawContent();
        },
      },
      h('span', { class: 'ico', 'aria-hidden': 'true' }, icon(t.icon, 28)),
      t.tabLabel ?? t.label,
    ),
  );
  // a switch: the tiles choose which measurement the overview shows
  root.append(h('div', { class: 'quick-actions', role: 'group', 'aria-label': 'Show measurement type' }, tiles), content);

  function drawContent() {
    content.replaceChildren();
    if (!state.measurements.length) {
      content.append(
        h(
          'div',
          { class: 'card empty' },
          h('div', { class: 'ico', 'aria-hidden': 'true' }, icon('gauge', 40)),
          h('h2', {}, 'No measurements yet'),
          h('p', {}, 'Take a photo of your blood pressure monitor, glucose meter or scale. The numbers are read right here in your browser – you check them before saving.'),
          h('a', { class: 'btn primary', href: `#/add?type=${state.overviewType}&camera=1` }, '+ Add measurement'),
        ),
      );
      return;
    }
    renderTypeContent(content, MEASUREMENT_TYPES[state.overviewType] ?? MEASUREMENT_TYPES.bp);
    content.append(
      h('p', { class: 'muted small', style: { textAlign: 'center' } }, 'Categories follow ESH 2023 (blood pressure), ADA (glucose) and WHO BMI thresholds. For information only – not a diagnosis.'),
    );
  }
  drawContent();
}

/** Latest blood pressure, 7-day averages and a chart of the last `days` days. */
function bpCards(bp, days) {
  {
    const last = bp[0];
    const t = MEASUREMENT_TYPES.bp;
    const lvl = t.classify(last.values, state.settings);
    const week = inLastDays(bp, 7);
    const avg = averages(week, t);
    const dSys = trend(bp, 'sys');
    const dDia = trend(bp, 'dia');
    const dPul = trend(bp, 'pulse');
    const trendTxt = (d) => {
      if (!Number.isFinite(d)) return '';
      const r = Math.round(d);
      return r === 0 ? '±0' : `${r > 0 ? '▲ +' : '▼ −'}${Math.abs(r)}`;
    };

    const chartBox = h('div');
    const cards = [
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Latest blood pressure'), h('span', { class: 'muted small' }, timeAgo(new Date(last.timestamp)))),
        h(
          'a',
          { href: `#/edit/${last.id}`, style: { textDecoration: 'none', color: 'inherit' } },
          h(
            'div',
            { class: 'reading' },
            h('div', { class: 'big' }, `${last.values.sys}/${last.values.dia}`, h('small', {}, 'mmHg')),
            Number.isFinite(last.values.pulse) ? h('div', { class: 'side' }, icon('heart', 18), ` ${last.values.pulse} `, h('small', {}, '/min')) : null,
          ),
        ),
        h('div', { class: 'row', style: { marginTop: '10px' } }, levelPill(lvl), (last.tags ?? []).map((tg) => h('span', { class: 'muted small' }, `#${tg}`))),
      ),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, '7-day average'), h('span', { class: 'muted small' }, `${avg.count} readings · ▲▼ vs. last week`)),
        h(
          'div',
          { class: 'grid-2', style: { gridTemplateColumns: 'repeat(3, 1fr)' } },
          h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Systolic'), h('div', { class: 'value' }, r0(avg.sys)), h('div', { class: 'delta' }, trendTxt(dSys))),
          h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Diastolic'), h('div', { class: 'value' }, r0(avg.dia)), h('div', { class: 'delta' }, trendTxt(dDia))),
          h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Pulse'), h('div', { class: 'value' }, r0(avg.pulse)), h('div', { class: 'delta' }, trendTxt(dPul))),
        ),
      ),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, `Last ${days} days`), h('a', { href: '#/charts', onclick: () => (state.chartFilter.type = 'bp'), class: 'small' }, 'All charts →')),
        bpLegend(false),
        chartBox,
      ),
    ];
    // charts measure their container: render once the cards are in the page
    queueMicrotask(() => renderChart(chartBox, bpChartConfig(inLastDays(bp, days), [Date.now() - days * 86400000, Date.now()], 180)));
    return cards;
  }
}

/** Latest blood sugar (+ a 30-day chart on the type dashboard). */
function glucoseCards(glu, withChart) {
  const unit = state.settings.glucoseUnit;
  {
    const last = glu[0];
    const t = MEASUREMENT_TYPES.glucose;
    const week = inLastDays(glu, 7);
    const avg = averages(week, t);
    const ctx = GLUCOSE_CONTEXTS.find((c) => c.id === last.values.context);
    const chartBox = h('div');
    if (withChart) queueMicrotask(() => renderChart(chartBox, glucoseChartConfig(inLastDays(glu, 30), [Date.now() - 30 * 86400000, Date.now()])));
    return [
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Latest blood sugar'), h('span', { class: 'muted small' }, timeAgo(new Date(last.timestamp)))),
        h(
          'a',
          { href: `#/edit/${last.id}`, style: { textDecoration: 'none', color: 'inherit' } },
          h('div', { class: 'reading' }, h('div', { class: 'big' }, formatGlucose(last.values.glucose, unit), h('small', {}, unit)), ctx ? h('div', { class: 'side' }, h('small', {}, ctx.label)) : null),
        ),
        h('div', { class: 'row', style: { marginTop: '10px' } }, levelPill(t.classify(last.values, state.settings)), h('span', { class: 'muted small' }, `7-day avg ${formatGlucose(avg.glucose, unit)} ${unit} · ${avg.count} readings`)),
      ),
      withChart ? h('div', { class: 'card' }, h('h2', {}, `Last 30 days (${unit})`), chartBox) : null,
    ].filter(Boolean);
  }
}

// ---------------------------------------------------------------- type dashboard

/** Overview content for one measurement type. */
function renderTypeContent(root, type) {
  const list = state.measurements.filter((m) => m.type === type.id);
  if (!list.length) {
    root.append(
      h(
        'div',
        { class: 'card empty' },
        h('div', { class: 'ico', 'aria-hidden': 'true' }, icon(type.icon, 40)),
        h('h2', {}, `No ${type.label.toLowerCase()} measurements yet`),
        h('p', {}, 'Take a photo of your device or enter the values by hand.'),
        h('a', { class: 'btn primary', href: `#/add?type=${type.id}&camera=1` }, `+ Add ${type.label.toLowerCase()}`),
      ),
    );
    return;
  }
  if (type.id === 'bp') root.append(...bpCards(list, 30));
  else if (type.id === 'glucose') root.append(...glucoseCards(list, true));
  else root.append(weightCard(list));

  const month = inLastDays(list, 30);
  if (month.length) {
    root.append(h('div', { class: 'section-title' }, 'Last 30 days'), statsCard(month, type), distributionCard(month, type));
    if (type.id === 'bp') root.append(tagCompareCard(month, type));
  }
  root.append(
    h(
      'div',
      { class: 'card-head', style: { margin: '22px 4px 8px' } },
      h('div', { class: 'section-title', style: { margin: 0 } }, 'Recent'),
      h(
        'a',
        {
          class: 'small',
          href: '#/history',
          onclick: () => Object.assign(state.historyFilter, { type: type.id, days: 0, tag: null }),
        },
        `All ${list.length} in history →`,
      ),
    ),
    ...list.slice(0, 10).map(entryRow),
  );
}

function weightCard(wt) {
  const st = state.settings;
  const unit = st.weightUnit;
  const t = MEASUREMENT_TYPES.weight;
  const last = wt[0];
  // change vs. the reading closest to 30 days ago
  const ref = wt.find((m) => Date.now() - new Date(m.timestamp).getTime() >= 30 * 86400000) ?? wt[wt.length - 1];
  const delta = ref && ref !== last ? last.values.weight - ref.values.weight : NaN;
  const sign = (d) => (d > 0 ? '▲ +' : d < 0 ? '▼ −' : '±');
  const deltaTxt = Number.isFinite(delta)
    ? `${sign(Math.round(delta * 10))}${formatWeight(Math.abs(delta), unit)} ${unit} since ${new Date(ref.timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
    : '';
  const chartBox = h('div');
  const card = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Latest weight'), h('span', { class: 'muted small' }, timeAgo(new Date(last.timestamp)))),
    h(
      'a',
      { href: `#/edit/${last.id}`, style: { textDecoration: 'none', color: 'inherit' } },
      h('div', { class: 'reading' }, h('div', { class: 'big' }, formatWeight(last.values.weight, unit), h('small', {}, unit))),
    ),
    h(
      'div',
      { class: 'row', style: { marginTop: '10px' } },
      levelPill(t.classify(last.values, st)),
      deltaTxt ? h('span', { class: 'muted small' }, deltaTxt) : null,
      !st.heightCm ? h('a', { class: 'small', href: '#/settings' }, 'Add your height for BMI') : null,
    ),
    wt.length > 1 ? chartBox : null,
  );
  if (wt.length > 1) queueMicrotask(() => renderChart(chartBox, weightChartConfig(inLastDays(wt, 90), null, 150)));
  return card;
}

// ---------------------------------------------------------------- chart configs

function bpLegend(withPulse) {
  const items = [
    ['s-sys', 'circle', 'Systolic'],
    ['s-dia', 'square', 'Diastolic'],
  ];
  if (withPulse) items.push(['s-pulse', 'triangle', 'Pulse']);
  return h(
    'div',
    { class: 'legend' },
    items.map(([cls, shape, label]) => h('span', { class: cls }, markerSVG(shape, 'marker'), label)),
  );
}

function tipHeader(t) {
  const d = new Date(t);
  return `<strong>${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · ${fmtTime(d)}</strong>`;
}
function tipRow(cls, shape, label, value) {
  const svg = markerSVG(shape, 'marker').outerHTML;
  return `<div class="tip-row"><span class="${cls}">${svg}</span>${label} <b>${value}</b></div>`;
}

function bpChartConfig(list, domain, height = 220) {
  const pts = (key) => list.filter((m) => Number.isFinite(m.values[key])).map((m) => ({ t: new Date(m.timestamp).getTime(), v: m.values[key], ref: m }));
  return {
    height,
    domain,
    series: [
      { key: 'sys', label: 'Systolic', short: 'SYS', cls: 's-sys', shape: 'circle', points: pts('sys') },
      { key: 'dia', label: 'Diastolic', short: 'DIA', cls: 's-dia', shape: 'square', points: pts('dia') },
    ],
    refLines: [
      { v: 135, label: '135 home limit' },
      { v: 85, label: '85' },
    ],
    tooltip: (t, rows) => {
      const m = rows[0]?.point.ref;
      return (
        tipHeader(t) +
        rows.map((r) => tipRow(r.series.cls, r.series.shape, r.series.short, r.point.v)).join('') +
        (Number.isFinite(m?.values.pulse) ? `<div class="tip-row muted">${iconSVG('heart', 13)} ${m.values.pulse} /min</div>` : '') +
        (m?.tags?.length ? `<div class="muted">${m.tags.map((x) => '#' + esc(x)).join(' ')}</div>` : '')
      );
    },
    onSelect: (m) => (location.hash = `#/edit/${m.id}`),
  };
}

function pulseChartConfig(list, domain) {
  const points = list.filter((m) => Number.isFinite(m.values.pulse)).map((m) => ({ t: new Date(m.timestamp).getTime(), v: m.values.pulse, ref: m }));
  return {
    height: 160,
    domain,
    series: [{ key: 'pulse', label: 'Pulse', short: 'PUL', cls: 's-pulse', shape: 'triangle', points }],
    tooltip: (t, rows) => tipHeader(t) + rows.map((r) => tipRow('s-pulse', 'triangle', 'Pulse', `${r.point.v} /min`)).join(''),
    onSelect: (m) => (location.hash = `#/edit/${m.id}`),
  };
}

function glucoseChartConfig(list, domain) {
  const unit = state.settings.glucoseUnit;
  const conv = (v) => (unit === 'mmol/L' ? v / MGDL_PER_MMOL : v);
  const points = list.map((m) => ({ t: new Date(m.timestamp).getTime(), v: conv(m.values.glucose), ref: m }));
  return {
    height: 220,
    domain,
    formatValue: (v) => (unit === 'mmol/L' ? v.toFixed(1) : String(Math.round(v))),
    series: [{ key: 'glucose', label: 'Glucose', cls: 's-glucose', shape: 'circle', points }],
    refLines: [
      { v: conv(70), label: unit === 'mmol/L' ? '3.9 low' : '70 low' },
      { v: conv(140), label: unit === 'mmol/L' ? '7.8' : '140' },
    ],
    tooltip: (t, rows) => {
      const m = rows[0]?.point.ref;
      const ctx = GLUCOSE_CONTEXTS.find((c) => c.id === m?.values.context);
      return tipHeader(t) + tipRow('s-glucose', 'circle', '', `${formatGlucose(m.values.glucose, unit)} ${unit}`) + (ctx ? `<div class="muted">${ctx.label}</div>` : '');
    },
    onSelect: (m) => (location.hash = `#/edit/${m.id}`),
  };
}

function weightChartConfig(list, domain, height = 220) {
  const unit = state.settings.weightUnit;
  const conv = (kg) => (unit === 'lb' ? kg * LB_PER_KG : kg);
  const points = list.map((m) => ({ t: new Date(m.timestamp).getTime(), v: conv(m.values.weight), ref: m }));
  const h0 = state.settings.heightCm;
  // reference lines at the BMI 18.5 / 25 limits when the height is known
  const refLines = Number.isFinite(h0)
    ? [
        { v: conv(25 * (h0 / 100) ** 2), label: 'BMI 25' },
        { v: conv(18.5 * (h0 / 100) ** 2), label: 'BMI 18.5' },
      ].filter((r) => points.some((p) => Math.abs(p.v - r.v) < 15))
    : [];
  return {
    height,
    domain: domain ?? undefined,
    formatValue: (v) => (Math.abs(v) < 100 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v))),
    series: [{ key: 'weight', label: 'Weight', cls: 's-weight', shape: 'circle', points }],
    refLines,
    tooltip: (t, rows) => {
      const m = rows[0]?.point.ref;
      const bmi = bmiOf(m.values.weight, h0);
      return tipHeader(t) + tipRow('s-weight', 'circle', '', `${formatWeight(m.values.weight, unit)} ${unit}`) + (Number.isFinite(bmi) ? `<div class="muted">BMI ${bmi.toFixed(1)}</div>` : '');
    },
    onSelect: (m) => (location.hash = `#/edit/${m.id}`),
  };
}

// ---------------------------------------------------------------- history

function filterBar(filter, onChange, { allowAll = true } = {}) {
  const typeBtns = [...(allowAll ? [['all', 'All']] : []), ...TYPE_LIST.map((t) => [t.id, t.tabLabel ?? t.label])];
  const periods = [
    [7, '7 days'],
    [30, '30 days'],
    [90, '3 months'],
    [365, '1 year'],
    [0, 'All time'],
  ];
  const tags = tagList();
  return h(
    'div',
    { class: 'filters stack' },
    h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': 'Type' },
      typeBtns.map(([v, l]) => h('button', { 'aria-pressed': String(filter.type === v), onclick: () => onChange({ type: v }) }, l)),
    ),
    h(
      'div',
      { class: 'chips', role: 'group', 'aria-label': 'Period' },
      periods.map(([v, l]) => h('button', { class: 'chip', 'aria-pressed': String(filter.days === v), onclick: () => onChange({ days: v }) }, l)),
    ),
    tags.length
      ? h(
          'div',
          { class: 'chips', role: 'group', 'aria-label': 'Tag filter' },
          h('button', { class: 'chip', 'aria-pressed': String(!filter.tag), onclick: () => onChange({ tag: null }) }, 'All tags'),
          tags.map((t) => h('button', { class: 'chip', 'aria-pressed': String(filter.tag === t), onclick: () => onChange({ tag: filter.tag === t ? null : t }) }, `#${t}`)),
        )
      : null,
  );
}

function applyFilter(list, f) {
  let out = list;
  if (f.type && f.type !== 'all') out = out.filter((m) => m.type === f.type);
  if (f.days) out = inLastDays(out, f.days);
  if (f.tag) out = out.filter((m) => (m.tags ?? []).includes(f.tag));
  return out;
}

function entryRow(m) {
  const d = new Date(m.timestamp);
  const t = MEASUREMENT_TYPES[m.type];
  const unit = state.settings.glucoseUnit;
  let vals;
  if (m.type === 'weight') {
    vals = h('div', { class: 'vals' }, `${formatWeight(m.values.weight, state.settings.weightUnit)} `, h('small', {}, state.settings.weightUnit));
  } else if (m.type === 'bp') {
    vals = h('div', { class: 'vals' }, `${m.values.sys}/${m.values.dia} `, h('small', {}, 'mmHg'), Number.isFinite(m.values.pulse) ? h('small', {}, '  ', icon('heart', 12), ` ${m.values.pulse}`) : null);
  } else {
    vals = h('div', { class: 'vals' }, `${formatGlucose(m.values.glucose, unit)} `, h('small', {}, unit));
  }
  const ctx = m.type === 'glucose' ? GLUCOSE_CONTEXTS.find((c) => c.id === m.values.context)?.label : null;
  const meta = [t.shortLabel, ctx, ...(m.tags ?? []).map((x) => `#${x}`), m.note ? 'note' : null, m.hasPhoto ? 'photo' : null].filter(Boolean).join(' · ');
  return h(
    'button',
    { class: 'entry', onclick: () => (location.hash = `#/edit/${m.id}`) },
    h('div', { class: 'time' }, fmtTime(d)),
    h('div', { class: 'entry-main' }, h('div', { class: 'entry-top' }, vals, levelPill(t.classify(m.values, state.settings))), h('div', { class: 'meta' }, meta)),
  );
}

function renderHistory(root) {
  const draw = () => {
    root.replaceChildren();
    const f = state.historyFilter;
    root.append(
      filterBar(f, (patch) => {
        Object.assign(state.historyFilter, patch);
        draw();
      }),
    );
    const list = applyFilter(state.measurements, f);
    if (!list.length) {
      root.append(h('div', { class: 'empty' }, h('p', {}, state.measurements.length ? 'No measurements match this filter.' : 'Nothing logged yet.'), h('a', { class: 'btn primary', href: '#/add' }, '+ Add measurement')));
      return;
    }
    root.append(
      h(
        'div',
        { class: 'row', style: { justifyContent: 'space-between' } },
        h('span', { class: 'muted small' }, `${list.length} measurement${list.length === 1 ? '' : 's'}`),
        h('button', { class: 'btn small', onclick: () => exportCSV(list) }, icon('download', 16), 'Export CSV'),
      ),
    );
    let day = null;
    let group = null;
    for (const m of list) {
      const d = new Date(m.timestamp);
      const key = localDate(d);
      if (key !== day) {
        day = key;
        group = h('section', { class: 'day-group' }, h('h3', {}, fmtDay(d)));
        root.append(group);
      }
      group.append(entryRow(m));
    }
  };
  draw();
}

function exportCSV(list) {
  const csv = toCSV(list, { delimiter: state.settings.csvDelimiter, settings: state.settings });
  download(`vitals-${localDate(new Date())}.csv`, csv, 'text/csv;charset=utf-8');
}

// ---------------------------------------------------------------- charts

function renderCharts(root) {
  const draw = () => {
    root.replaceChildren();
    const f = state.chartFilter;
    root.append(
      filterBar(
        f,
        (patch) => {
          Object.assign(state.chartFilter, patch);
          draw();
        },
        { allowAll: false },
      ),
    );
    const list = applyFilter(state.measurements, f);
    const now = Date.now();
    const oldest = list.length ? Math.min(...list.map((m) => new Date(m.timestamp).getTime())) : now - 7 * 86400000;
    const domain = [f.days ? now - f.days * 86400000 : oldest, now];
    const type = MEASUREMENT_TYPES[f.type];

    if (f.type === 'bp') {
      const c1 = h('div');
      const c2 = h('div');
      root.append(
        h('div', { class: 'card' }, h('h2', {}, 'Blood pressure (mmHg)'), bpLegend(false), c1),
        h('div', { class: 'card' }, h('h2', {}, 'Pulse (/min)'), c2),
      );
      renderChart(c1, bpChartConfig(list, domain));
      renderChart(c2, pulseChartConfig(list, domain));
    } else {
      const c1 = h('div');
      if (f.type === 'weight') {
        root.append(h('div', { class: 'card' }, h('h2', {}, `Weight (${state.settings.weightUnit})`), c1));
        renderChart(c1, weightChartConfig(list, domain));
      } else {
        root.append(h('div', { class: 'card' }, h('h2', {}, `Blood sugar (${state.settings.glucoseUnit})`), c1));
        renderChart(c1, glucoseChartConfig(list, domain));
      }
    }

    if (!list.length) return;
    root.append(statsCard(list, type), distributionCard(list, type));
    if (f.type === 'bp') root.append(tagCompareCard(list, type));
  };
  draw();
}

function statsCard(list, type) {
  const unit = state.settings.glucoseUnit;
  const fieldOf = (key) => type.fields.find((f) => f.key === key);
  const fmt = (key, v) => (Number.isFinite(v) ? fieldOf(key).toDisplay(v, state.settings) : '–');
  const { morning, evening } = byTimeOfDay(list);
  const groups = [
    ['All', list],
    ['Morning (4–12 h)', morning],
    ['Evening (17–24 h)', evening],
  ].filter(([, l]) => l.length);
  const fields = type.fields;
  return h(
    'div',
    { class: 'card' },
    h('h2', {}, 'Statistics'),
    h(
      'table',
      { class: 'stats' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'n'), fields.map((f) => h('th', {}, `Ø ${f.short}`)))),
      h(
        'tbody',
        {},
        groups.map(([label, l]) => {
          const a = averages(l, type);
          return h('tr', {}, h('td', {}, label), h('td', {}, l.length), fields.map((f) => h('td', {}, fmt(f.key, a[f.key]))));
        }),
        (() => {
          const a = averages(list, type);
          return h('tr', {}, h('td', {}, 'Min – max'), h('td', {}, ''), fields.map((f) => h('td', {}, `${fmt(f.key, a[f.key + 'Min'])}–${fmt(f.key, a[f.key + 'Max'])}`)));
        })(),
      ),
    ),
  );
}

function distributionCard(list, type) {
  const counts = new Map();
  for (const m of list) {
    const l = type.classify(m.values, state.settings);
    if (!l) continue;
    const c = counts.get(l.id) ?? { level: l, n: 0 };
    c.n++;
    counts.set(l.id, c);
  }
  const rows = [...counts.values()].sort((a, b) => a.level.rank - b.level.rank);
  if (!rows.length) return h('span');
  const max = Math.max(...rows.map((r) => r.n));
  return h(
    'div',
    { class: 'card' },
    h('h2', {}, 'Readings by category'),
    rows.map((r) =>
      h(
        'div',
        { class: 'dist-row' },
        h('span', {}, r.level.group ?? r.level.label),
        h('div', { class: `dist-bar lvl-${r.level.rank}`, style: { width: `${(r.n / max) * 100}%` }, title: `${r.level.group ?? r.level.label}: ${r.n}` }),
        h('span', { class: 'n' }, r.n),
      ),
    ),
  );
}

function tagCompareCard(list, type) {
  const tags = allTags(list).filter((t) => list.some((m) => (m.tags ?? []).includes(t)));
  if (!tags.length) return h('span');
  return h(
    'div',
    { class: 'card' },
    h('h2', {}, 'Averages by tag'),
    h(
      'table',
      { class: 'stats' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Tag'), h('th', {}, 'n'), h('th', {}, 'Ø SYS'), h('th', {}, 'Ø DIA'), h('th', {}, 'Ø PUL'))),
      h(
        'tbody',
        {},
        tags.map((t) => {
          const l = list.filter((m) => (m.tags ?? []).includes(t));
          const a = averages(l, type);
          return h('tr', {}, h('td', {}, `#${t}`), h('td', {}, l.length), h('td', {}, r0(a.sys)), h('td', {}, r0(a.dia)), h('td', {}, r0(a.pulse)));
        }),
      ),
    ),
  );
}

// ---------------------------------------------------------------- editor (capture + verify + save)

let worker = null;
let workerSeq = 0;
function warmReader() {
  worker ??= new Worker(new URL('./ocr/worker.js', import.meta.url), { type: 'module' });
}
function readInWorker(image, kind, crop) {
  warmReader();
  const id = ++workerSeq;
  return new Promise((resolve, reject) => {
    const onMsg = (e) => {
      if (e.data.id !== id) return;
      worker.removeEventListener('message', onMsg);
      e.data.ok ? resolve(e.data) : reject(new Error(e.data.error));
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage({ id, image, kind, crop, settings: { glucoseUnit: state.settings.glucoseUnit, weightUnit: state.settings.weightUnit } });
  });
}

// Decode via <img>: every current browser applies the EXIF orientation there
// (phone cameras store portrait photos sideways + an orientation flag), while
// createImageBitmap's imageOrientation option is not honoured everywhere.
async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function drawScaled(img, maxDim) {
  // <video> reports its frame size in videoWidth/videoHeight (width is the CSS attribute)
  const w0 = img.videoWidth || img.naturalWidth || img.width;
  const h0 = img.videoHeight || img.naturalHeight || img.height;
  const s = Math.min(1, maxDim / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * s);
  c.height = Math.round(h0 * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}
const canvasToBlob = (c, q = 0.82) => new Promise((res) => c.toBlob(res, 'image/jpeg', q));

async function renderEditor(root, { arg, params }) {
  const editing = arg ? await getMeasurement(arg) : null;
  if (arg && (!editing || editing.deleted)) {
    root.append(h('div', { class: 'empty' }, 'Measurement not found.'));
    return;
  }
  const unit = state.settings.glucoseUnit;
  const s = {
    type: editing?.type ?? (MEASUREMENT_TYPES[params.get('type')] ? params.get('type') : 'bp'),
    values: { ...(editing?.values ?? {}) },
    fromPhoto: new Set(),
    uncertain: new Set(), // fields with a digit the reader was not sure about
    ocrRaw: editing?.ocr?.raw ?? null,
    tags: new Set(editing?.tags ?? []),
    note: editing?.note ?? '',
    when: editing ? new Date(editing.timestamp) : new Date(),
    source: editing?.source ?? 'manual',
    editedAt: {}, // field -> time the user last typed in it
    readStartedAt: 0,
    photoImg: null, // decoded photo, kept to redraw the analysis canvas when the type changes
    photoCanvas: null, // analysis canvas (1600 px, 2400 px for far-away displays)
    photoBlob: null, // compressed photo for storage
    overlay: null, // detected boxes
    crop: null,
    busy: false,
    status: null,
  };
  if (!editing) Object.assign(s.values, MEASUREMENT_TYPES[s.type].defaults?.() ?? {});

  const fileCam = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'visually-hidden', 'aria-hidden': 'true', tabindex: '-1' });
  const fileGal = h('input', { type: 'file', accept: 'image/*', class: 'visually-hidden', 'aria-hidden': 'true', tabindex: '-1' });
  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) await handlePhoto(file);
  };
  fileCam.addEventListener('change', onFile);
  fileGal.addEventListener('change', onFile);

  const photoArea = h('div');
  const formArea = h('div', { class: 'stack' });
  const errorsBox = h('div');

  // (DOM append() would render a null as the text "null": drop it)
  root.append(
    ...[
      fileCam,
      fileGal,
      editing
      ? null
      : h(
          'div',
          { class: 'segmented', role: 'group', 'aria-label': 'Measurement type', style: { marginBottom: '14px' } },
          TYPE_LIST.map(({ id: t }) =>
            h(
              'button',
              {
                'aria-pressed': String(s.type === t),
                onclick: (e) => {
                  s.type = t;
                  s.values = { ...(MEASUREMENT_TYPES[t].defaults?.() ?? {}) };
                  s.fromPhoto.clear();
                  e.currentTarget.parentElement.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(TYPE_LIST[i].id === t)));
                  if (s.photoImg) {
                    s.photoCanvas = drawScaled(s.photoImg, MEASUREMENT_TYPES[t].farDisplay ? 2400 : 1600);
                    s.crop = null;
                  }
                  if (s.photoCanvas) runOCR();
                  drawForm();
                },
              },
              MEASUREMENT_TYPES[t].tabLabel ?? MEASUREMENT_TYPES[t].label,
            ),
          ),
        ),
      photoArea,
      formArea,
      errorsBox,
    ].filter(Boolean),
  );

  // ---- photo

  async function handlePhoto(file) {
    s.status = { busy: true, text: 'Loading photo…' };
    drawPhoto();
    const img = await loadImage(file);
    // scales are photographed from further away: keep more pixels for the small display
    s.photoImg = img;
    s.photoCanvas = drawScaled(img, MEASUREMENT_TYPES[s.type].farDisplay ? 2400 : 1600);
    if (state.settings.keepPhotos) s.photoBlob = await canvasToBlob(drawScaled(img, 1024));
    // photos picked from the gallery keep their own capture time
    if (!editing && file.lastModified && Date.now() - file.lastModified > 5 * 60000) s.when = new Date(file.lastModified);
    s.crop = null;
    await runOCR();
    if (!s.fromPhoto.size && state.settings.claudeAuto && state.settings.claudeKey) await runClaude();
  }

  async function runOCR() {
    if (!s.photoCanvas) return;
    s.status = { busy: true, text: 'Reading display…' };
    s.readStartedAt = Date.now();
    drawPhoto();
    const c = s.photoCanvas;
    const image = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    try {
      const { result, ms } = await readInWorker(image, s.type, s.crop);
      s.overlay = result;
      s.uncertain = new Set(result.uncertain ?? []);
      s.ocrRaw = { ...result.values, engine: 'on-device', score: result.score };
      applyRecognized(result.values);
      const n = Object.keys(result.values).length;
      const need = MEASUREMENT_TYPES[s.type].fields.length;
      if (n >= need && s.uncertain.size) s.status = { warn: true, text: `Read on your device in ${ms} ms – some digits were hard to read: check the values marked "please check".` };
      else if (n >= need) s.status = { ok: true, text: `Read on your device in ${ms} ms – please check the values below.` };
      else if (n) s.status = { warn: true, text: 'Only part of the display could be read. Check and complete the values, or drag a box around the numbers.' };
      else s.status = { warn: true, text: 'Could not read the display. Drag a box around the numbers to retry, or type them in.' };
    } catch (err) {
      s.status = { warn: true, text: `Reading failed: ${err.message}` };
    }
    drawPhoto();
    drawForm();
  }

  async function runClaude() {
    if (!s.photoCanvas || !state.settings.claudeKey) return;
    s.status = { busy: true, text: 'Asking Claude to read the display…' };
    s.readStartedAt = Date.now();
    drawPhoto();
    try {
      const { readWithClaude } = await import('./ocr/claudeVision.js');
      const blob = await canvasToBlob(drawScaled(s.photoCanvas, 1568), 0.85);
      const { values } = await readWithClaude(blob, s.type, state.settings.claudeKey);
      let v = values;
      if (s.type === 'glucose') {
        const u = values.glucoseUnit ?? (values.glucoseDisplayed < 35 ? 'mmol/L' : 'mg/dL');
        v = Number.isFinite(values.glucoseDisplayed) ? { glucose: toMgdl(values.glucoseDisplayed, u) } : {};
      } else if (s.type === 'weight') {
        const u = values.weightUnit ?? state.settings.weightUnit;
        v = Number.isFinite(values.weightDisplayed) ? { weight: Math.round((u === 'lb' ? values.weightDisplayed / LB_PER_KG : values.weightDisplayed) * 10) / 10 } : {};
      }
      s.ocrRaw = { ...v, engine: 'claude' };
      s.overlay = null;
      applyRecognized(v);
      s.source = 'photo-ai';
      s.status = Object.keys(v).length ? { ok: true, text: 'Read by Claude – please check the values below.' } : { warn: true, text: 'Claude could not read the values.' };
    } catch (err) {
      s.status = { warn: true, text: err.message };
    }
    drawPhoto();
    drawForm();
  }

  function applyRecognized(values) {
    s.fromPhoto.clear();
    for (const [k, v] of Object.entries(values)) {
      if (!Number.isFinite(v)) continue;
      // keep what the user typed while this reading was running
      if ((s.editedAt[k] ?? 0) > s.readStartedAt) continue;
      s.values[k] = v;
      s.fromPhoto.add(k);
    }
    if (Object.keys(values).length) s.source = s.source === 'photo-ai' ? 'photo-ai' : 'photo';
  }

  // ---- live scan: read camera frames until two in a row agree
  const liveSupported = !!navigator.mediaDevices?.getUserMedia;
  const live = { on: false, stream: null, video: null, overlay: null, status: null, last: null, frames: 0 };

  async function startLive() {
    live.on = true;
    live.last = null;
    live.frames = 0;
    drawPhoto();
    try {
      live.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
    } catch (err) {
      live.on = false;
      s.status = { warn: true, text: `Camera not available (${err.name === 'NotAllowedError' ? 'permission denied' : err.message}). Use "Take photo" instead.` };
      drawPhoto();
      return;
    }
    if (!live.on) return stopLive(); // stopped while waiting for permission
    live.video.srcObject = live.stream;
    await live.video.play().catch(() => {});
    liveLoop();
  }

  function stopLive() {
    live.on = false;
    live.stream?.getTracks().forEach((t) => t.stop());
    live.stream = null;
  }

  function liveStatus(text) {
    if (live.status) live.status.textContent = text;
  }

  async function liveLoop() {
    const type = MEASUREMENT_TYPES[s.type];
    while (live.on) {
      const v = live.video;
      if (!v || v.readyState < 2 || !v.videoWidth) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      const frame = drawScaled(v, type.farDisplay ? 2400 : 1600);
      const image = frame.getContext('2d').getImageData(0, 0, frame.width, frame.height);
      let result;
      try {
        ({ result } = await readInWorker(image, s.type, null));
      } catch {
        continue;
      }
      if (!live.on) break;
      live.frames++;
      drawLiveBoxes(result, frame.width, frame.height);
      const complete = Object.keys(result.values).length === type.fields.length && !(result.uncertain ?? []).length;
      const key = complete ? JSON.stringify(result.values) : null;
      if (key && key === live.last) {
        // stable: freeze this frame and fill in the values for checking
        stopLive();
        s.photoImg = frame;
        s.photoCanvas = frame;
        if (state.settings.keepPhotos) s.photoBlob = await canvasToBlob(drawScaled(frame, 1024));
        s.crop = null;
        s.overlay = result;
        s.uncertain = new Set(result.uncertain ?? []);
        s.readStartedAt = Date.now() - 1; // edits made while scanning are kept
        s.ocrRaw = { ...result.values, engine: 'on-device-live', score: result.score };
        applyRecognized(result.values);
        s.status = { ok: true, text: `Read live from ${live.frames} camera frames – please check the values below.` };
        drawPhoto();
        drawForm();
        return;
      }
      live.last = key;
      if (key) liveStatus('Hold still…');
      else if (!result.box) liveStatus('Point the camera at the display.');
      else if ((result.box.x1 - result.box.x0) / frame.width < 0.12) liveStatus('Move closer to the display.');
      else liveStatus('Reading the display…');
    }
  }

  function drawLiveBoxes(result, w, h) {
    const cv = live.overlay;
    if (!cv) return;
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = Math.max(3, w / 250);
    ctx.strokeStyle = '#3987e5';
    for (const r of result.rows ?? []) {
      if (!r.poly) continue;
      ctx.beginPath();
      r.poly.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
    }
  }

  let canvasEl = null;
  function drawPhoto() {
    photoArea.replaceChildren();
    if (live.on) {
      live.video = h('video', { playsinline: true, muted: true, autoplay: true, class: 'live-video', 'aria-label': 'Camera preview' });
      live.video.muted = true;
      live.overlay = h('canvas', { class: 'live-overlay', 'aria-hidden': 'true' });
      live.status = h('span', {}, 'Starting the camera…');
      if (live.stream) {
        live.video.srcObject = live.stream;
        live.video.play().catch(() => {});
      }
      photoArea.append(
        h(
          'div',
          { class: 'card', style: { padding: '8px' } },
          h('div', { class: 'photo-wrap live-wrap' }, live.video, live.overlay),
          h('div', { class: 'photo-status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), live.status),
          h(
            'div',
            { class: 'row', style: { marginTop: '8px' } },
            h(
              'button',
              {
                class: 'btn small',
                onclick: () => {
                  stopLive();
                  drawPhoto();
                },
              },
              'Stop',
            ),
            h('span', { class: 'muted small' }, 'Hold the display inside the picture; it is read automatically.'),
          ),
        ),
      );
      return;
    }
    if (!s.photoCanvas) {
      const existing = editing?.hasPhoto;
      photoArea.append(
        h(
          'div',
          { class: 'card stack' },
          h(
            'div',
            { class: `photo-actions ${liveSupported ? 'three' : ''}` },
            h('button', { class: 'btn big primary', onclick: () => fileCam.click() }, h('span', { class: 'ico', 'aria-hidden': 'true' }, icon('camera', 26)), 'Take photo'),
            h('button', { class: 'btn big', onclick: () => fileGal.click() }, h('span', { class: 'ico', 'aria-hidden': 'true' }, icon('image', 26)), 'Choose image'),
            liveSupported ? h('button', { class: 'btn big', onclick: startLive }, h('span', { class: 'ico', 'aria-hidden': 'true' }, icon('scan', 26)), 'Live scan') : null,
          ),
          h(
            'p',
            { class: 'muted small', style: { margin: 0 } },
            existing
              ? 'Take a new photo to re-read this measurement.'
              : `Hold the phone straight in front of the display, avoid reflections.${liveSupported ? ' Live scan reads the display through the camera until the reading is stable.' : ''} Or simply type the values below.`,
          ),
        ),
      );
      if (existing) {
        getPhoto(editing.id).then((blob) => {
          if (!blob) return;
          const img = h('img', { src: URL.createObjectURL(blob), alt: 'Photo of the device display', style: { width: '100%', borderRadius: '14px', display: 'block' } });
          photoArea.prepend(h('div', { class: 'card', style: { padding: '8px' } }, img));
        });
      }
      return;
    }
    // analysis canvas with overlay
    const c = s.photoCanvas;
    canvasEl = h('canvas', { width: c.width, height: c.height, 'aria-label': 'Photo of the device display' });
    paintCanvas();
    attachCropper(canvasEl);
    const status = s.status
      ? h('div', { class: 'photo-status' }, s.status.busy ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : h('span', { 'aria-hidden': 'true', class: 'status-ico' }, icon(s.status.ok ? 'check' : 'info', 18)), h('span', {}, s.status.text))
      : null;
    photoArea.append(
      h(
        'div',
        { class: 'card', style: { padding: '8px' } },
        h('div', { class: 'photo-wrap' }, canvasEl),
        status,
        h(
          'div',
          { class: 'row', style: { marginTop: '8px' } },
          h('button', { class: 'btn small', onclick: () => fileCam.click() }, icon('retake', 16), 'Retake'),
          liveSupported ? h('button', { class: 'btn small', onclick: startLive }, icon('scan', 16), 'Scan again') : null,
          s.crop
            ? h(
                'button',
                {
                  class: 'btn small',
                  onclick: () => {
                    s.crop = null;
                    runOCR();
                  },
                },
                'Reset area',
              )
            : h('span', { class: 'muted small' }, 'Tip: drag over the photo to mark the numbers'),
          state.settings.claudeKey ? h('button', { class: 'btn small', onclick: runClaude }, icon('sparkle', 16), 'Read with Claude') : null,
        ),
      ),
    );
  }

  function paintCanvas(dragRect) {
    const c = s.photoCanvas;
    const ctx = canvasEl.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const lw = Math.max(2, c.width / 300);
    ctx.lineWidth = lw;
    if (s.crop) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      const { x, y, w, h: hh } = s.crop;
      ctx.fillRect(0, 0, c.width, y);
      ctx.fillRect(0, y + hh, c.width, c.height - y - hh);
      ctx.fillRect(0, y, x, hh);
      ctx.fillRect(x + w, y, c.width - x - w, hh);
    }
    if (s.overlay?.rows?.length) {
      const labels = MEASUREMENT_TYPES[s.type].fields.map((f) => f.short);
      const fontPx = Math.round(Math.max(14, c.width / 28));
      ctx.font = `700 ${fontPx}px system-ui, sans-serif`;
      s.overlay.rows.forEach((r, i) => {
        const pad = lw * 3;
        ctx.strokeStyle = '#3987e5';
        if (r.poly) {
          // the row's outline in the photo (tilted if the photo was read straightened)
          const cxp = r.poly.reduce((a, p) => a + p[0], 0) / 4;
          const cyp = r.poly.reduce((a, p) => a + p[1], 0) / 4;
          ctx.beginPath();
          r.poly.forEach(([x, y], j) => {
            const px = x + Math.sign(x - cxp) * pad;
            const py = y + Math.sign(y - cyp) * pad;
            j ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
          });
          ctx.closePath();
          ctx.stroke();
        } else {
          ctx.strokeRect(r.box.x0 - pad, r.box.y0 - pad, r.box.x1 - r.box.x0 + 2 * pad, r.box.y1 - r.box.y0 + 2 * pad);
        }
        // show the number as on the display, with its decimal point
        const shown = r.decimals > 0 && Number.isFinite(r.number) ? r.number.toFixed(r.decimals) : r.text;
        const tag = `${labels[i] ?? ''} ${shown}`.trim();
        const tw = ctx.measureText(tag).width;
        const lx = Math.max(0, r.box.x0 - pad - tw - fontPx * 0.8);
        ctx.fillStyle = '#3987e5';
        ctx.fillRect(lx, r.box.y0 - pad, tw + fontPx * 0.6, fontPx * 1.4);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(tag, lx + fontPx * 0.3, r.box.y0 - pad + fontPx * 1.05);
      });
    }
    if (dragRect) {
      ctx.strokeStyle = '#eb6834';
      ctx.setLineDash([lw * 4, lw * 3]);
      ctx.strokeRect(dragRect.x, dragRect.y, dragRect.w, dragRect.h);
      ctx.setLineDash([]);
    }
  }

  function attachCropper(cv) {
    let start = null;
    let rect = null;
    const pos = (e) => {
      const b = cv.getBoundingClientRect();
      return { x: ((e.clientX - b.left) / b.width) * cv.width, y: ((e.clientY - b.top) / b.height) * cv.height };
    };
    cv.addEventListener('pointerdown', (e) => {
      start = pos(e);
      rect = null;
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!start) return;
      const p = pos(e);
      rect = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
      paintCanvas(rect);
    });
    cv.addEventListener('pointerup', () => {
      start = null;
      if (rect && rect.w > cv.width * 0.08 && rect.h > cv.height * 0.05) {
        s.crop = rect;
        runOCR();
      } else paintCanvas();
    });
  }

  // ---- form

  function drawForm() {
    formArea.replaceChildren();
    const type = MEASUREMENT_TYPES[s.type];
    const st = state.settings;
    const valueInputs = h('div', { class: `value-inputs ${type.fields.length === 1 ? 'one' : ''}` });
    for (const f of type.fields) {
      const dec = f.decimalInput(st);
      const input = h('input', {
        id: `in-${f.key}`,
        type: 'text',
        inputmode: dec ? 'decimal' : 'numeric',
        pattern: dec ? '[0-9]+([.,][0-9])?' : '[0-9]*',
        autocomplete: 'off',
        value: f.toDisplay(s.values[f.key], st),
        placeholder: '–',
        'aria-label': `${f.label} in ${f.unit(st)}`,
      });
      input.addEventListener('input', () => {
        const raw = input.value.replace(',', '.').trim();
        const n = raw === '' ? undefined : Number(raw);
        s.values[f.key] = Number.isFinite(n) ? f.fromInput(n, st) : undefined;
        s.fromPhoto.delete(f.key);
        s.uncertain.delete(f.key);
        s.editedAt[f.key] = Date.now();
        const box = input.closest('.value-input');
        box.classList.remove('from-photo', 'uncertain');
        box.querySelector('.from-photo-tag')?.remove();
        drawErrors();
        drawHints();
      });
      valueInputs.append(
        h(
          'div',
          { class: `value-input ${s.fromPhoto.has(f.key) ? 'from-photo' : ''} ${s.uncertain.has(f.key) ? 'uncertain' : ''}` },
          h('label', { for: `in-${f.key}` }, f.short),
          input,
          h('div', { class: 'unit' }, f.unit(st)),
          s.fromPhoto.has(f.key)
            ? s.uncertain.has(f.key)
              ? h('div', { class: 'from-photo-tag uncertain', title: 'A digit of this value was hard to read' }, 'please check')
              : h('div', { class: 'from-photo-tag', title: 'Read from the photo' }, 'from photo')
            : null,
        ),
      );
    }

    const tagBox = h('div', { class: 'chips' });
    const drawTags = () => {
      tagBox.replaceChildren();
      const tags = [...new Set([...tagList(), ...s.tags])];
      for (const t of tags) {
        tagBox.append(
          h(
            'button',
            {
              class: 'chip',
              type: 'button',
              'aria-pressed': String(s.tags.has(t)),
              onclick: (e) => {
                s.tags.has(t) ? s.tags.delete(t) : s.tags.add(t);
                e.currentTarget.setAttribute('aria-pressed', String(s.tags.has(t)));
              },
            },
            t,
          ),
        );
      }
      const add = h('input', { type: 'text', placeholder: '+ New tag', 'aria-label': 'New tag', enterkeyhint: 'done', maxlength: '40' });
      const commit = async () => {
        const t = add.value.trim().replace(/^#/, '');
        if (!t) return;
        s.tags.add(t);
        if (!state.settings.tags.includes(t)) await updateSetting('tags', [...state.settings.tags, t]);
        drawTags();
      };
      add.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      });
      add.addEventListener('blur', commit);
      tagBox.append(h('span', { class: 'chip-add' }, add));
    };
    drawTags();

    // The native date/time input is laid over a styled box and made invisible:
    // iOS Safari sizes visible date inputs by their content and lets them overflow.
    const fmtWhen = (d) => {
      const narrow = window.innerWidth < 360;
      const opts = { day: 'numeric', month: 'short' };
      if (!narrow) opts.weekday = 'short';
      if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
      return `${d.toLocaleDateString(undefined, opts)} · ${fmtTime(d)}`;
    };
    const whenText = h('span', { class: 'dt-text' }, fmtWhen(s.when));
    const whenInput = h('input', {
      type: 'datetime-local',
      class: 'dt-native',
      id: 'in-when',
      value: toLocalInput(s.when),
      max: toLocalInput(new Date(Date.now() + 60000)),
      'aria-label': 'Date and time of the measurement',
    });
    whenInput.addEventListener('change', () => {
      if (!whenInput.value) return;
      s.when = new Date(whenInput.value);
      whenText.textContent = fmtWhen(s.when);
    });
    // desktop browsers only open the picker from the calendar icon; open it on any click
    whenInput.addEventListener('click', () => {
      try {
        whenInput.showPicker?.();
      } catch {
        /* not allowed / not supported: the native control still works */
      }
    });
    const calIcon = h('span', {
      class: 'dt-ico',
      'aria-hidden': 'true',
      html: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    });
    const when = h('div', { class: 'dt-wrap' }, whenText, calIcon, whenInput);
    const note = h('textarea', { placeholder: 'Optional note (symptoms, medication, …)', maxlength: '1000' }, s.note);
    note.addEventListener('input', () => (s.note = note.value));

    formArea.append(
      h(
        'div',
        { class: 'card stack' },
        s.fromPhoto.size ? h('div', { class: 'notice' }, 'Values marked in blue were read from the photo. Compare them with the display and correct them if needed before saving.') : null,
        valueInputs,
        hintBox,
        s.type === 'glucose'
          ? h(
              'label',
              { class: 'field' },
              h('span', {}, 'Context'),
              h(
                'select',
                { onchange: (e) => (s.values.context = e.target.value) },
                GLUCOSE_CONTEXTS.map((c) => h('option', { value: c.id, selected: s.values.context === c.id }, c.label)),
              ),
            )
          : null,
        h('div', { class: 'field' }, h('span', {}, 'Date & time'), when),
      ),
      h('div', { class: 'card stack' }, h('h2', { style: { margin: 0 } }, 'Tags'), tagBox, h('label', { class: 'field' }, h('span', {}, 'Note'), note)),
      h(
        'div',
        { class: 'sticky-actions' },
        editing ? h('button', { class: 'btn danger', onclick: onDelete }, 'Delete') : h('a', { class: 'btn', href: '#/overview' }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: onSave }, editing ? 'Save changes' : 'Save'),
      ),
    );
    drawErrors();
    drawHints();
  }

  function currentValues() {
    const type = MEASUREMENT_TYPES[s.type];
    const v = {};
    for (const f of type.fields) if (Number.isFinite(s.values[f.key])) v[f.key] = s.values[f.key];
    if (s.type === 'glucose') v.context = s.values.context;
    return v;
  }

  function drawErrors() {
    errorsBox.replaceChildren();
  }

  // compare with the user's recent readings (a hint only; nothing is changed)
  const hintBox = h('div');
  function drawHints() {
    const others = state.measurements.filter((m) => m.id !== editing?.id);
    const hints = unusualVsHistory(s.type, currentValues(), others);
    hintBox.replaceChildren(...hints.map((x) => h('div', { class: 'notice warn' }, `${x.text} Please check the value.`)));
  }

  async function onSave() {
    const type = MEASUREMENT_TYPES[s.type];
    const values = currentValues();
    const errors = type.validate(values);
    if (errors.length) {
      errorsBox.replaceChildren(h('div', { class: 'card' }, h('ul', { class: 'errors' }, errors.map((e) => h('li', {}, e)))));
      errorsBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const rec = {
      ...(editing ?? {}),
      id: editing?.id ?? newId(),
      type: s.type,
      timestamp: s.when.toISOString(),
      values,
      tags: [...s.tags],
      note: s.note.trim(),
      source: s.source,
    };
    if (s.ocrRaw) {
      const corrected = Object.keys(values).some((k) => k !== 'context' && s.ocrRaw[k] !== undefined && s.ocrRaw[k] !== values[k]);
      rec.ocr = { raw: s.ocrRaw, corrected };
    }
    await saveMeasurement(rec, state.settings.keepPhotos ? s.photoBlob : null);
    await reload();
    afterChange();
    toast(editing ? 'Changes saved' : `Saved: ${type.format(values, state.settings)}`);
    // show what was just measured on the overview
    if (!editing) {
      state.overviewType = s.type;
      setSetting('overviewType', s.type);
    }
    location.hash = editing ? '#/history' : '#/overview';
  }

  async function onDelete() {
    if (!confirm('Delete this measurement?')) return;
    await deleteMeasurement(editing.id);
    await reload();
    afterChange();
    toast('Measurement deleted');
    location.hash = '#/history';
  }

  drawPhoto();
  drawForm();
  // leaving the editor switches the camera off
  const cleanup = () => stopLive();
  if (params.get('camera') === '1' && !editing) {
    // Opening the camera needs a user gesture on most mobile browsers; the
    // quick-action link counts as one in Chrome/Safari when triggered immediately.
    try {
      fileCam.click();
    } catch {
      /* ignored – the user can tap "Take photo" */
    }
  }
  return cleanup;
}

// ---------------------------------------------------------------- settings

async function renderSettings(root) {
  const st = state.settings;
  const heightInput = () => {
    const el = h('input', { type: 'text', inputmode: 'numeric', pattern: '[0-9]*', placeholder: 'cm', value: st.heightCm ?? '', 'aria-label': 'Height in cm', class: 'inline-input' });
    el.addEventListener('change', () => {
      const n = Number(el.value.replace(',', '.'));
      updateSetting('heightCm', Number.isFinite(n) && n >= 50 && n <= 250 ? Math.round(n) : null);
    });
    return el;
  };
  const sw = (key, onChange) => {
    const input = h('input', { type: 'checkbox', class: 'switch', checked: !!st[key], 'aria-label': key });
    input.addEventListener('change', async () => {
      await updateSetting(key, input.checked);
      onChange?.(input.checked);
    });
    return input;
  };
  const select = (key, options, label) => {
    const el = h('select', { 'aria-label': label }, options.map(([v, l]) => h('option', { value: v, selected: st[key] === v }, l)));
    el.addEventListener('change', () => updateSetting(key, el.value));
    return el;
  };

  // --- general
  root.append(
    h('div', { class: 'section-title' }, 'General'),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'setting' }, h('div', {}, 'Blood sugar unit'), select('glucoseUnit', [['mg/dL', 'mg/dL'], ['mmol/L', 'mmol/L']], 'Blood sugar unit')),
      h('div', { class: 'setting' }, h('div', {}, 'Weight unit'), select('weightUnit', [['kg', 'kg'], ['lb', 'lb']], 'Weight unit')),
      h('div', { class: 'setting' }, h('div', {}, 'Height', h('div', { class: 'desc' }, 'For BMI. Kept on this device only.')), heightInput()),
      h('div', { class: 'setting' }, h('div', {}, 'Text size'), select('textSize', [['normal', 'Normal'], ['large', 'Large'], ['xlarge', 'Extra large']], 'Text size')),
      h('div', { class: 'setting' }, h('div', {}, 'Appearance'), select('theme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], 'Appearance')),
      h('div', { class: 'setting' }, h('div', {}, 'Keep photos', h('div', { class: 'desc' }, 'Stored only in this browser, never uploaded to the backup.')), sw('keepPhotos')),
    ),
  );

  // --- tags
  const tagCard = h('div', { class: 'card' });
  const drawTagCard = () => {
    tagCard.replaceChildren();
    const tags = tagList();
    for (const t of tags) {
      const n = state.measurements.filter((m) => (m.tags ?? []).includes(t)).length;
      tagCard.append(
        h(
          'div',
          { class: 'tag-row' },
          h('span', {}, `#${t} `, h('span', { class: 'muted small' }, n ? `· ${n}` : '')),
          h(
            'span',
            { class: 'row' },
            h('button', { class: 'btn small', onclick: () => renameTag(t) }, 'Rename'),
            h('button', { class: 'btn small danger', onclick: () => removeTag(t, n) }, 'Delete'),
          ),
        ),
      );
    }
    const input = h('input', { type: 'text', placeholder: 'New tag', maxlength: '40', 'aria-label': 'New tag name' });
    tagCard.append(
      h(
        'form',
        {
          class: 'row',
          style: { marginTop: '10px' },
          onsubmit: async (e) => {
            e.preventDefault();
            const t = input.value.trim().replace(/^#/, '');
            if (!t || state.settings.tags.includes(t)) return;
            await updateSetting('tags', [...state.settings.tags, t]);
            drawTagCard();
          },
        },
        h('label', { class: 'field', style: { flex: 1 } }, input),
        h('button', { class: 'btn', type: 'submit' }, 'Add'),
      ),
    );
  };
  async function renameTag(t) {
    const nt = prompt(`Rename tag "${t}" to:`, t)?.trim().replace(/^#/, '');
    if (!nt || nt === t) return;
    await updateSetting('tags', [...new Set(state.settings.tags.map((x) => (x === t ? nt : x)))]);
    const changed = state.measurements.filter((m) => (m.tags ?? []).includes(t));
    for (const m of changed) await saveMeasurement({ ...m, tags: [...new Set(m.tags.map((x) => (x === t ? nt : x)))] });
    await reload();
    if (changed.length) afterChange();
    drawTagCard();
  }
  async function removeTag(t, n) {
    if (n && !confirm(`Remove tag "${t}" from ${n} measurement(s)?`)) return;
    await updateSetting('tags', state.settings.tags.filter((x) => x !== t));
    const changed = state.measurements.filter((m) => (m.tags ?? []).includes(t));
    for (const m of changed) await saveMeasurement({ ...m, tags: m.tags.filter((x) => x !== t) });
    await reload();
    if (changed.length) afterChange();
    drawTagCard();
  }
  drawTagCard();
  root.append(h('div', { class: 'section-title' }, 'Tags'), tagCard);

  // --- cloud backup
  const cfg = await getSyncConfig();
  const urlIn = h('input', { type: 'url', value: cfg.url, placeholder: `${location.origin} (this site)`, autocomplete: 'off' });
  const tokIn = h('input', { type: 'password', value: cfg.token, placeholder: 'Sync token', autocomplete: 'off' });
  const syncStatus = h('div', { class: 'muted small' });
  const showLast = async () => {
    const last = await getSetting('syncLastResult', null);
    syncStatus.textContent = last ? (last.ok ? `Last backup ${timeAgo(new Date(last.at))} · ${last.pushed} sent, ${last.pulled} received` : `Last attempt failed: ${last.error}`) : 'Not synced yet.';
  };
  showLast();
  const saveCfg = async () => {
    await setSetting('syncUrl', urlIn.value.trim());
    await setSetting('syncToken', tokIn.value.trim());
  };
  urlIn.addEventListener('change', async () => {
    await saveCfg();
    await resetSyncState(); // new server -> full re-sync
  });
  tokIn.addEventListener('change', saveCfg);
  // --- end-to-end encryption passphrase
  const passIn = h('input', { type: 'password', placeholder: 'Backup passphrase (min. 8 characters)', autocomplete: 'new-password', minlength: '8' });
  const keyState = h('div', { class: 'small' });
  const keyBtn = h('button', { class: 'btn small' });
  let hasKey = !!cfg.key;
  const showKeyState = () => {
    keyState.textContent = hasKey
      ? 'Unlocked on this device. Records are encrypted (AES-256-GCM) before upload.'
      : 'Choose a passphrase on your first device and enter the same one on every other device. It is never stored or uploaded – if you lose it, the backup cannot be read.';
    keyBtn.textContent = hasKey ? 'Forget key on this device' : 'Set / unlock passphrase';
    passIn.closest('label')?.toggleAttribute('hidden', hasKey);
  };
  keyBtn.addEventListener('click', async () => {
    if (hasKey) {
      if (!confirm('Remove the encryption key from this device? Backup pauses until you enter the passphrase again.')) return;
      await forgetKey();
      hasKey = false;
      showKeyState();
      return;
    }
    await saveCfg();
    keyBtn.disabled = true;
    keyState.textContent = 'Deriving key…';
    try {
      await setPassphrase(await getSyncConfig(), passIn.value);
      passIn.value = '';
      hasKey = true;
      toast('Passphrase set – backup is end-to-end encrypted');
      if (enabled.checked) doSync();
    } catch (e) {
      toast(e.message);
    }
    keyBtn.disabled = false;
    showKeyState();
  });

  const enabled = h('input', { type: 'checkbox', class: 'switch', checked: cfg.enabled, 'aria-label': 'Enable cloud backup' });
  enabled.addEventListener('change', async () => {
    await saveCfg();
    await setSetting('syncEnabled', enabled.checked);
    updateSyncIndicator();
    if (enabled.checked && hasKey) doSync();
    else if (enabled.checked) toast('Now set the backup passphrase below');
  });
  async function doSync() {
    await saveCfg();
    syncStatus.textContent = 'Syncing…';
    try {
      const r = await syncNow();
      await reload();
      toast(`Backup complete · ${r.pushed} sent, ${r.pulled} received`);
      updateSyncIndicator('Backed up');
    } catch (e) {
      toast(e.message);
      updateSyncIndicator('Backup failed');
    }
    showLast();
  }
  root.append(
    h('div', { class: 'section-title' }, 'Cloud backup (Cloudflare D1)'),
    h(
      'div',
      { class: 'card stack' },
      h('div', { class: 'setting', style: { padding: 0, border: 0 } }, h('div', {}, 'Back up to cloud', h('div', { class: 'desc' }, 'Measurements, tags and notes are encrypted on this device and synced to your own Cloudflare D1 database. Photos stay on this device.')), enabled),
      h('label', { class: 'field' }, h('span', {}, 'Backup server URL'), urlIn),
      h('label', { class: 'field' }, h('span', {}, 'Sync token'), tokIn),
      h('label', { class: 'field' }, h('span', {}, 'Encryption passphrase'), passIn),
      keyState,
      keyBtn,
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn small', onclick: doSync }, '⟳ Sync now'),
        h(
          'button',
          {
            class: 'btn small',
            onclick: async () => {
              await saveCfg();
              try {
                const r = await testConnection(await getSyncConfig());
                toast(`Connected · ${r.records} records in backup`);
              } catch (e) {
                toast(e.message);
              }
            },
          },
          'Test connection',
        ),
      ),
      syncStatus,
    ),
  );
  showKeyState();

  // --- claude
  const keyIn = h('input', { type: 'password', value: st.claudeKey, placeholder: 'sk-ant-…', autocomplete: 'off' });
  keyIn.addEventListener('change', () => updateSetting('claudeKey', keyIn.value.trim()));
  root.append(
    h('div', { class: 'section-title' }, 'AI reading (optional)'),
    h(
      'div',
      { class: 'card stack' },
      h('p', { class: 'small muted', style: { margin: 0 } }, 'By default, photos are read on your device and never leave it. For displays the built-in reader cannot handle, you can let Claude read the photo using your own Anthropic API key. The photo is then sent to the Anthropic API.'),
      h('label', { class: 'field' }, h('span', {}, 'Anthropic API key'), keyIn),
      h('div', { class: 'setting', style: { padding: 0, border: 0 } }, h('div', {}, 'Use automatically', h('div', { class: 'desc' }, 'Ask Claude when the on-device reader finds nothing.')), sw('claudeAuto')),
    ),
  );

  // --- data
  const importIn = h('input', { type: 'file', accept: 'application/json,.json', class: 'visually-hidden' });
  importIn.addEventListener('change', async () => {
    const f = importIn.files?.[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const recs = (data.measurements ?? data).filter((r) => r && r.id && r.type && r.timestamp);
      const local = new Map((await listAllRecords()).map((m) => [m.id, m]));
      const now = new Date().toISOString();
      // keep newer local versions; stamp imported ones as changed now so they reach the backup
      const toPut = recs
        .filter((r) => !local.has(r.id) || (r.updatedAt ?? '') > (local.get(r.id).updatedAt ?? ''))
        .map((r) => ({ ...r, updatedAt: now, hasPhoto: local.get(r.id)?.hasPhoto || undefined }));
      await bulkPut(toPut);
      if (Array.isArray(data.tags)) await updateSetting('tags', [...new Set([...state.settings.tags, ...data.tags])]);
      await reload();
      afterChange();
      toast(`Imported ${toPut.length} of ${recs.length} measurements`);
      route();
    } catch (e) {
      toast(`Import failed: ${e.message}`);
    }
  });
  root.append(
    h('div', { class: 'section-title' }, 'Data'),
    h(
      'div',
      { class: 'card stack' },
      h('div', { class: 'setting', style: { padding: 0, border: 0 } }, h('div', {}, 'CSV separator', h('div', { class: 'desc' }, 'Use semicolon for Excel with German/European locale.')), select('csvDelimiter', [[',', 'Comma ( , )'], [';', 'Semicolon ( ; )']], 'CSV separator')),
      h('button', { class: 'btn block', onclick: () => exportCSV(state.measurements) }, icon('download', 16), 'Export all as CSV'),
      h(
        'button',
        {
          class: 'btn block',
          onclick: async () => {
            const all = await listAllRecords();
            const payload = { app: 'vitals-log', version: 1, exportedAt: new Date().toISOString(), tags: state.settings.tags, measurements: all.filter((m) => !m.deleted) };
            download(`vitals-backup-${localDate(new Date())}.json`, JSON.stringify(payload, null, 2), 'application/json');
          },
        },
        icon('download', 16),
        'Export JSON backup',
      ),
      h('button', { class: 'btn block', onclick: () => importIn.click() }, icon('upload', 16), 'Import JSON backup'),
      importIn,
      h(
        'button',
        {
          class: 'btn block danger',
          onclick: async () => {
            if (!confirm('Delete ALL measurements and photos stored in this browser? Cloud backup is switched off on this device; the backup itself is not touched.')) return;
            await clearAll();
            await resetSyncState();
            // otherwise the next sync would download everything again
            await setSetting('syncEnabled', false);
            updateSyncIndicator();
            await reload();
            toast('Local data deleted');
            route();
          },
        },
        'Delete all local data',
      ),
    ),
    h('p', { class: 'muted small', style: { textAlign: 'center' } }, `${state.measurements.length} measurements stored in this browser.`),
  );
}

// ---------------------------------------------------------------- boot

// Sticky bars below the title bar need its real height (notch / safe area, text size).
{
  const topbar = document.querySelector('.topbar');
  const setTopbarH = () => document.documentElement.style.setProperty('--topbar-h', `${topbar.getBoundingClientRect().height}px`);
  new ResizeObserver(setTopbarH).observe(topbar, { box: 'border-box' }); // safe-area padding counts
  setTopbarH();
}

// Safari ignores user-scalable=no: block pinch gestures explicitly (text size is a setting instead)
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('touchmove', (e) => e.touches.length > 1 && e.preventDefault(), { passive: false });

async function boot() {
  await loadSettings();
  await reload();
  await route();
  updateSyncIndicator();
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker
      .register('./sw.js')
      .then(() => navigator.serviceWorker.ready)
      // start the photo reader once so the service worker caches it for offline use
      .then(() => warmReader())
      .catch(() => {});
  }

  // Offline changes are kept locally; sync them as soon as the connection is back,
  // and pick up changes from other devices when the app returns to the foreground.
  const syncAndRefresh = async () => {
    const c = await getSyncConfig();
    if (!c.enabled || !c.token || !c.key || !navigator.onLine) return;
    try {
      const r = await syncNow();
      updateSyncIndicator('Backed up');
      if (r.pulled) {
        await reload();
        if (!location.hash.startsWith('#/add') && !location.hash.startsWith('#/edit')) route();
      }
    } catch {
      updateSyncIndicator('Backup failed');
    }
  };
  window.addEventListener('online', syncAndRefresh);
  window.addEventListener('offline', () => updateSyncIndicator());
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && syncAndRefresh());
  syncAndRefresh(); // initial sync (push offline changes, pull other devices)
}

boot();

