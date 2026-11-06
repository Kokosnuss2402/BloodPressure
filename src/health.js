// Import of weight and blood sugar from Apple Health, via an iPhone Shortcut.
//
// Websites cannot read Apple Health, so a Shortcut reads the samples and hands
// them to the app as plain text, one sample per line:
//
//   W|2026-11-05T07:31:00+01:00|78,4|kg
//   G|2026-11-05T07:40:00+01:00|5.6|mmol<180.15588000005408>/L
//
// W = weight, G = blood glucose; then the date (ISO 8601), the value and the
// unit exactly as the Shortcut gives them. Separators "|", ";" or tab; decimal
// point or comma. Nothing is sent anywhere: the text comes from the Shortcut
// (link or clipboard) and is read on the device.

import { toKg, toMgdl } from './types.js';

const KG_PER_STONE = 6.35029;

/** Parse the Shortcut's text. Returns { items, errors } (errors: unreadable lines). */
export function parseHealthText(text) {
  const items = [];
  const errors = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/[|;\t]/).map((p) => p.trim());
    const [kind, date, valueText, unitText = ''] = parts;
    const value = Number((valueText ?? '').replace(/\s/g, '').replace(',', '.'));
    const when = new Date(date);
    const unit = unitText.toLowerCase();
    if (!Number.isFinite(value) || Number.isNaN(when.getTime())) {
      errors.push(line);
      continue;
    }
    if (/^w/i.test(kind)) {
      let kg;
      if (unit === 'lb' || unit === 'lbs') kg = toKg(value, 'lb');
      else if (unit === 'st') kg = Math.round(value * KG_PER_STONE * 10) / 10;
      else if (unit === 'g') kg = Math.round(value / 100) / 10;
      else kg = Math.round(value * 10) / 10; // kg (or no unit)
      if (kg < 2 || kg > 350) {
        errors.push(line);
        continue;
      }
      items.push({ type: 'weight', timestamp: when.toISOString(), values: { weight: kg } });
    } else if (/^g/i.test(kind)) {
      // Apple writes mmol/L as "mmol<180.15588000005408>/L" (with the molar mass)
      const mmol = unit.includes('mmol');
      const mg = mmol ? toMgdl(value, 'mmol/L') : Math.round(value);
      if (mg < 10 || mg > 700) {
        errors.push(line);
        continue;
      }
      items.push({ type: 'glucose', timestamp: when.toISOString(), values: { glucose: mg, context: 'random' } });
    } else errors.push(line);
  }
  return { items, errors };
}

/** Stable id of an imported sample, so importing the same sample again is a no-op. */
export function healthId(item) {
  const v = item.type === 'weight' ? item.values.weight : item.values.glucose;
  return `health-${item.type}-${item.timestamp}-${v}`;
}

/**
 * What would be imported. A sample is skipped when it was imported before (same
 * id) or when the app already has the same kind of reading within 2 minutes with
 * (almost) the same value, e.g. one you also logged here.
 */
export function planHealthImport(items, measurements) {
  const ids = new Set(measurements.map((m) => m.id));
  const seen = new Set();
  const add = [];
  const skip = [];
  for (const it of items) {
    const id = healthId(it);
    if (seen.has(id)) continue; // the same sample twice in one import
    seen.add(id);
    const t = new Date(it.timestamp).getTime();
    const twin = measurements.some((m) => {
      if (m.deleted || m.type !== it.type || Math.abs(new Date(m.timestamp).getTime() - t) > 2 * 60000) return false;
      if (it.type === 'weight') return Math.abs((m.values?.weight ?? NaN) - it.values.weight) <= 0.15;
      return Math.abs((m.values?.glucose ?? NaN) - it.values.glucose) <= 2;
    });
    if (ids.has(id) || twin) skip.push(it);
    else add.push({ ...it, id });
  }
  add.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { add, skip };
}

