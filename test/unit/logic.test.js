import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSegments } from '../../src/ocr/sevenSegment.js';
import { MEASUREMENT_TYPES, toMgdl, formatGlucose } from '../../src/types.js';
import { toCSV, CSV_COLUMNS } from '../../src/csv.js';
import { averages, trend, allTags, byTimeOfDay } from '../../src/stats.js';

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
  assert.match(lines[2], /,Blood sugar,,,,99,5\.5,Fasting,Normal,/);
  const semi = toCSV([{ id: '2', type: 'glucose', timestamp: '2026-11-05T08:00:00.000Z', values: { glucose: 99 } }], { delimiter: ';' });
  assert.match(semi, /;99;5,5;/); // decimal comma with semicolon separator
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
