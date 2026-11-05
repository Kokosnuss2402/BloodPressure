import { MEASUREMENT_TYPES, GLUCOSE_CONTEXTS, MGDL_PER_MMOL, LB_PER_KG, bmiOf } from './types.js';

const pad = (n) => String(n).padStart(2, '0');
export const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

// Free text starting with = + - @ would be run as a formula by spreadsheet apps.
const defuse = (s) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

function cell(v, delim) {
  if (v == null) return '';
  const s = String(v);
  return s.includes(delim) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_COLUMNS = [
  'date',
  'time',
  'type',
  'systolic_mmHg',
  'diastolic_mmHg',
  'pulse_per_min',
  'glucose_mg_dl',
  'glucose_mmol_l',
  'glucose_context',
  'weight_kg',
  'weight_lb',
  'bmi',
  'category',
  'tags',
  'note',
  'source',
  'timestamp_iso',
];

/**
 * Build a CSV string from measurements.
 * @param {Array} measurements
 * @param {{delimiter?: ',' | ';', decimal?: '.' | ',', settings?: object}} [opts]  settings: heightCm for BMI
 */
export function toCSV(measurements, opts = {}) {
  const delim = opts.delimiter ?? ',';
  const dec = opts.decimal ?? (delim === ';' ? ',' : '.');
  const num = (n, digits = 0) => (Number.isFinite(n) ? n.toFixed(digits).replace('.', dec) : '');
  const lines = [CSV_COLUMNS.join(delim)];
  const sorted = [...measurements].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const m of sorted) {
    const d = new Date(m.timestamp);
    const v = m.values ?? {};
    const type = MEASUREMENT_TYPES[m.type];
    const cat = type?.classify(v, opts.settings);
    const bmi = bmiOf(v.weight, opts.settings?.heightCm);
    const ctx = GLUCOSE_CONTEXTS.find((c) => c.id === v.context);
    const row = [
      localDate(d),
      localTime(d),
      type?.label ?? m.type,
      num(v.sys),
      num(v.dia),
      num(v.pulse),
      num(v.glucose),
      Number.isFinite(v.glucose) ? num(v.glucose / MGDL_PER_MMOL, 1) : '',
      ctx?.label ?? '',
      num(v.weight, 1),
      Number.isFinite(v.weight) ? num(v.weight * LB_PER_KG, 1) : '',
      Number.isFinite(bmi) ? num(bmi, 1) : '',
      cat?.label ?? '',
      defuse((m.tags ?? []).join('; ')),
      defuse(m.note ?? ''),
      m.source ?? '',
      m.timestamp,
    ];
    lines.push(row.map((c) => cell(c, delim)).join(delim));
  }
  // BOM so spreadsheet apps detect UTF-8
  return '﻿' + lines.join('\r\n') + '\r\n';
}
