import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSegments } from '../../src/ocr/sevenSegment.js';
import { MEASUREMENT_TYPES, toMgdl, formatGlucose } from '../../src/types.js';
import { toCSV, CSV_COLUMNS } from '../../src/csv.js';
import { averages, trend, allTags, byTimeOfDay, unusualVsHistory } from '../../src/stats.js';
import { voteRows } from '../../src/ocr/reader.js';

const bp = MEASUREMENT_TYPES.bp;
const glu = MEASUREMENT_TYPES.glucose;

test('seven-segment patterns decode to digits', () => {
  assert.equal(decodeSegments(0b1111110).char, '0');
  assert.equal(decodeSegments(0b0110000).char, '1');
  assert.equal(decodeSegments(0b1111111).char, '8');
  assert.equal(decodeSegments(0b1110010).char, '7'); // 7 with segment f (boso style)
  const near = decodeSegments(0b1111101); // 0 with g instead of e -> ambiguous/near
  assert.equal(near.exact, false);
});

test('blood pressure display rows map to sys/dia/pulse', () => {
  const row = (value, h = 100) => ({ value, confidence: 1, height: h, text: String(value) });
  const r = bp.fromDisplayRows([row(108), row(71), row(101, 60)]);
  assert.deepEqual(r.values, { sys: 108, dia: 71, pulse: 101 });
  assert.equal(r.score, 1);
  // implausible order (dia > sys) is rejected
  assert.ok(bp.fromDisplayRows([row(70), row(120), row(60)]).score < 1);
});

test('blood pressure validation & ESH classification', () => {
  assert.deepEqual(bp.validate({ sys: 120, dia: 80, pulse: 60 }), []);
  assert.ok(bp.validate({ sys: 80, dia: 90 }).length > 0);
  assert.ok(bp.validate({ dia: 80 }).length > 0);
  assert.equal(bp.classify({ sys: 108, dia: 71 }).id, 'optimal');
  assert.equal(bp.classify({ sys: 125, dia: 70 }).id, 'normal');
  assert.equal(bp.classify({ sys: 132, dia: 70 }).id, 'high_normal');
  assert.equal(bp.classify({ sys: 120, dia: 92 }).id, 'grade1');
  assert.equal(bp.classify({ sys: 165, dia: 92 }).id, 'grade2');
  assert.equal(bp.classify({ sys: 185, dia: 92 }).id, 'grade3');
  assert.equal(bp.classify({ sys: 85, dia: 55 }).id, 'low');
});

test('glucose units and classification', () => {
  assert.equal(toMgdl(5.5, 'mmol/L'), 99);
  assert.equal(formatGlucose(99, 'mmol/L'), '5.5');
  assert.equal(glu.classify({ glucose: 95, context: 'fasting' }).id, 'normal');
  assert.equal(glu.classify({ glucose: 110, context: 'fasting' }).id, 'elevated');
  assert.equal(glu.classify({ glucose: 130, context: 'fasting' }).id, 'high');
  assert.equal(glu.classify({ glucose: 130, context: 'after_meal' }).id, 'normal');
  assert.equal(glu.classify({ glucose: 60, context: 'after_meal' }).id, 'low');
});

test('weight: BMI categories incl. WHO underweight grades', () => {
  const w = MEASUREMENT_TYPES.weight;
  const at = (kg) => w.classify({ weight: kg }, { heightCm: 180 }).id;
  assert.equal(at(50), 'underweight3'); // BMI 15.4
  assert.equal(at(54), 'underweight2'); // 16.7
  assert.equal(at(57), 'underweight1'); // 17.6
  assert.equal(at(72), 'normal'); // 22.2
  assert.equal(at(85), 'overweight'); // 26.2
  assert.equal(at(100), 'obese1'); // 30.9
  assert.equal(w.classify({ weight: 72 }, {}), null); // no height, no category
});

test('CSV export escapes values and includes pulse and tags', () => {
  const csv = toCSV(
    [
      { id: '1', type: 'bp', timestamp: '2026-11-05T07:30:00.000Z', values: { sys: 108, dia: 71, pulse: 101 }, tags: ['Morning', 'Left arm'], note: 'felt "dizzy", tired', source: 'photo' },
      { id: '2', type: 'glucose', timestamp: '2026-11-05T08:00:00.000Z', values: { glucose: 99, context: 'fasting' }, tags: [], note: '', source: 'manual' },
    ],
    { delimiter: ',' },
  );
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], CSV_COLUMNS.join(','));
  assert.match(lines[1], /,Blood pressure,108,71,101,/);
  assert.match(lines[1], /Morning; Left arm/);
  assert.match(lines[1], /"felt ""dizzy"", tired"/);
  assert.match(lines[2], /,Blood sugar,,,,99,5\.5,Fasting,,,,Normal,/);
  const semi = toCSV([{ id: '2', type: 'glucose', timestamp: '2026-11-05T08:00:00.000Z', values: { glucose: 99 } }], { delimiter: ';' });
  assert.match(semi, /;99;5,5;/); // decimal comma with semicolon separator
});

test('CSV export neutralises spreadsheet formulas in free text', () => {
  const csv = toCSV([{ id: '3', type: 'bp', timestamp: '2026-11-05T09:00:00.000Z', values: { sys: 120, dia: 80 }, tags: ['=cmd'], note: '=HYPERLINK("http://x")' }]);
  assert.match(csv, /,'=cmd,/);
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/x""\)"/);
});

test('stats: averages, trends, tags, time of day', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  const mk = (daysAgo, sys, dia, tags = []) => ({ type: 'bp', timestamp: new Date(now - daysAgo * 86400000).toISOString(), values: { sys, dia }, tags });
  const list = [mk(1, 120, 80, ['Morning']), mk(2, 130, 84, ['Morning']), mk(9, 140, 90, ['Evening'])];
  const a = averages(list.slice(0, 2), bp);
  assert.equal(a.sys, 125);
  assert.equal(a.diaMax, 84);
  assert.equal(trend(list, 'sys', 7, now), -15);
  assert.deepEqual(allTags(list, ['Stressed']), ['Morning', 'Evening', 'Stressed']);
  const { morning, evening } = byTimeOfDay([{ timestamp: '2026-11-05T07:00:00' }, { timestamp: '2026-11-05T20:00:00' }]);
  assert.equal(morning.length, 1);
  assert.equal(evening.length, 1);
});

test('per-digit vote across thresholds, uncertain digits are reported', () => {
  const box = { x0: 0, x1: 100, y0: 0, y1: 50 };
  const row = (chars, exact = true) => ({ box, decimals: 0, digits: [...chars].map((c) => ({ char: c, exact })), text: chars });
  // the chosen pass misread the middle digit; three other thresholds agree on "0"
  const best = row('188', false);
  const { rows } = voteRows([best], [{ rows: [best] }, { rows: [row('108')] }, { rows: [row('108')] }, { rows: [row('108')] }]);
  assert.equal(rows[0].text, '108');
  assert.equal(rows[0].value, 108);
  assert.deepEqual(rows[0].uncertain, []);
  // passes disagree: the digit is reported as uncertain
  const split = voteRows([row('71')], [{ rows: [row('71')] }, { rows: [row('11')] }]);
  assert.deepEqual(split.rows[0].uncertain, [0]);
});

test('hint when a reading is far from the recent ones', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  const bp = [120, 124, 118, 122].map((sys, i) => ({ type: 'bp', timestamp: new Date(now - (i + 1) * 86400000).toISOString(), values: { sys, dia: 80 } }));
  assert.deepEqual(unusualVsHistory('bp', { sys: 121, dia: 79 }, bp, now), []);
  assert.equal(unusualVsHistory('bp', { sys: 181, dia: 79 }, bp, now)[0].key, 'sys');
  const wt = [78.1, 78.4].map((w, i) => ({ type: 'weight', timestamp: new Date(now - (i + 1) * 86400000).toISOString(), values: { weight: w } }));
  assert.equal(unusualVsHistory('weight', { weight: 49.2 }, wt, now).length, 1);
  assert.equal(unusualVsHistory('weight', { weight: 78.9 }, wt, now).length, 0);
});
