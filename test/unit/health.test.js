import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHealthText, planHealthImport, healthId } from '../../src/health.js';

test('Shortcut text: weight and glucose in Apple\'s units, comma decimals, separators', () => {
  const { items, errors } = parseHealthText(
    [
      'W|2026-11-05T07:31:00+01:00|78,4|kg',
      'W;2026-11-04T07:30:00+01:00;172.8;lb',
      'G|2026-11-05T07:40:00+01:00|5.6|mmol<180.15588000005408>/L',
      'G\t2026-11-05T12:10:00+01:00\t104\tmg/dL',
      '',
      'W|not a date|78|kg',
      'X|2026-11-05T07:31:00+01:00|1|?',
    ].join('\n'),
  );
  assert.equal(errors.length, 2);
  assert.deepEqual(items.map((i) => [i.type, i.values.weight ?? i.values.glucose]), [
    ['weight', 78.4],
    ['weight', 78.4],
    ['glucose', 101],
    ['glucose', 104],
  ]);
  assert.equal(items[0].timestamp, '2026-11-05T06:31:00.000Z');
  assert.equal(items[2].values.context, 'random');
});

test('import plan skips samples imported before and readings already logged', () => {
  const { items } = parseHealthText('W|2026-11-05T07:31:00Z|78.4|kg\nW|2026-11-05T07:31:00Z|78.4|kg\nG|2026-11-05T08:00:00Z|99|mg/dL\nW|2026-11-06T07:30:00Z|78.1|kg');
  const existing = [
    { id: healthId(items[0]), type: 'weight', timestamp: items[0].timestamp, values: { weight: 78.4 } }, // imported before
    { id: 'x', type: 'glucose', timestamp: '2026-11-05T08:01:00Z', values: { glucose: 100 } }, // logged in the app 1 min later
  ];
  const { add, skip } = planHealthImport(items, existing);
  assert.deepEqual(add.map((a) => a.values.weight), [78.1]);
  assert.equal(skip.length, 2);
  assert.ok(add[0].id.startsWith('health-weight-'));
});
