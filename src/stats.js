// Aggregations used by the dashboard and charts.

const DAY = 86400000;

export function inLastDays(measurements, days, now = Date.now()) {
  if (!days) return measurements;
  const from = now - days * DAY;
  return measurements.filter((m) => new Date(m.timestamp).getTime() >= from);
}

export function mean(values) {
  const v = values.filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}

/** Averages of every field of a type over a list of measurements. */
export function averages(measurements, type) {
  const out = { count: measurements.length };
  for (const f of type.fields) {
    const vals = measurements.map((m) => m.values?.[f.key]).filter(Number.isFinite);
    out[f.key] = mean(vals);
    out[`${f.key}Min`] = vals.length ? Math.min(...vals) : NaN;
    out[`${f.key}Max`] = vals.length ? Math.max(...vals) : NaN;
  }
  return out;
}

/** Split by time of day: morning 04–12, evening 17–24 (common home-monitoring protocol). */
export function byTimeOfDay(measurements) {
  const morning = [];
  const evening = [];
  for (const m of measurements) {
    const h = new Date(m.timestamp).getHours();
    if (h >= 4 && h < 12) morning.push(m);
    else if (h >= 17) evening.push(m);
  }
  return { morning, evening };
}

/** Difference of the mean of the last `days` vs the `days` before (for trend arrows). */
export function trend(measurements, key, days = 7, now = Date.now()) {
  const recent = measurements.filter((m) => now - new Date(m.timestamp).getTime() < days * DAY);
  const prev = measurements.filter((m) => {
    const age = now - new Date(m.timestamp).getTime();
    return age >= days * DAY && age < 2 * days * DAY;
  });
  const a = mean(recent.map((m) => m.values?.[key]));
  const b = mean(prev.map((m) => m.values?.[key]));
  return Number.isFinite(a) && Number.isFinite(b) ? a - b : NaN;
}

/**
 * Is a new reading far from the user's recent ones? Returns short hints (no
 * values are changed): blood pressure more than max(25 mmHg, 3 SD) away from
 * the 30-day mean, weight more than 5 % away. Needs a few recent readings.
 */
export function unusualVsHistory(type, values, measurements, now = Date.now()) {
  const recent = measurements.filter((m) => m.type === type && now - new Date(m.timestamp).getTime() < 30 * DAY);
  const hints = [];
  const stat = (key) => {
    const v = recent.map((m) => m.values?.[key]).filter(Number.isFinite);
    const mu = mean(v);
    const sd = v.length > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - mu) ** 2, 0) / (v.length - 1)) : 0;
    return { n: v.length, mu, sd };
  };
  if (type === 'bp') {
    for (const [key, label] of [['sys', 'Systolic'], ['dia', 'Diastolic']]) {
      const { n, mu, sd } = stat(key);
      if (n < 3 || !Number.isFinite(values[key])) continue;
      if (Math.abs(values[key] - mu) > Math.max(25, 3 * sd)) hints.push({ key, text: `${label} is far ${values[key] > mu ? 'above' : 'below'} your 30-day average of ${Math.round(mu)}.` });
    }
  } else if (type === 'weight') {
    const { n, mu } = stat('weight');
    if (n >= 2 && Number.isFinite(values.weight) && Math.abs(values.weight - mu) > 0.05 * mu)
      hints.push({ key: 'weight', text: `This is more than 5 % ${values.weight > mu ? 'above' : 'below'} your 30-day average.` });
  }
  return hints;
}

export function allTags(measurements, defaults = []) {
  const counts = new Map(defaults.map((t) => [t, 0]));
  for (const m of measurements) for (const t of m.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}
