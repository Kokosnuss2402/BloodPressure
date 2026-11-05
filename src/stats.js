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

export function allTags(measurements, defaults = []) {
  const counts = new Map(defaults.map((t) => [t, 0]));
  for (const m of measurements) for (const t of m.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}
