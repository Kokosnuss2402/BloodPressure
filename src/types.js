// Measurement type registry. Every measurement kind (blood pressure, blood
// glucose, ...) is described here: its fields, plausibility ranges, how to map
// numbers read from a device display onto fields, and how to classify a value.
// Adding a new kind means adding an entry here; storage, history, CSV export
// and charts are driven by this description.

export const MGDL_PER_MMOL = 18.016;

export const GLUCOSE_CONTEXTS = [
  { id: 'fasting', label: 'Fasting' },
  { id: 'before_meal', label: 'Before meal' },
  { id: 'after_meal', label: 'After meal (2 h)' },
  { id: 'bedtime', label: 'Bedtime' },
  { id: 'random', label: 'Other / random' },
];

const inRange = (v, f) => Number.isFinite(v) && v >= f.min && v <= f.max;

// Ordinal ranks 0..5 map onto one blue ramp in the UI (colour-blind safe);
// every level is always shown with its text label, never colour alone.
const BP_LEVELS = [
  { id: 'low', label: 'Low', rank: 2 },
  { id: 'optimal', label: 'Optimal', rank: 0 },
  { id: 'normal', label: 'Normal', rank: 1 },
  { id: 'high_normal', label: 'High normal', rank: 2 },
  { id: 'grade1', label: 'Hypertension grade 1', rank: 3 },
  { id: 'grade2', label: 'Hypertension grade 2', rank: 4 },
  { id: 'grade3', label: 'Hypertension grade 3', rank: 5 },
];
const bpLevel = (id) => BP_LEVELS.find((l) => l.id === id);

export const MEASUREMENT_TYPES = {
  bp: {
    id: 'bp',
    label: 'Blood pressure',
    shortLabel: 'BP',
    fields: [
      { key: 'sys', label: 'Systolic', short: 'SYS', unit: 'mmHg', min: 50, max: 280, required: true },
      { key: 'dia', label: 'Diastolic', short: 'DIA', unit: 'mmHg', min: 25, max: 180, required: true },
      { key: 'pulse', label: 'Pulse', short: 'PUL', unit: '/min', min: 25, max: 250, required: false },
    ],
    validate(v) {
      const errors = [];
      for (const f of this.fields) {
        const x = v[f.key];
        if (x == null || x === '') {
          if (f.required) errors.push(`${f.label} is required`);
        } else if (!inRange(x, f)) errors.push(`${f.label} must be between ${f.min} and ${f.max}`);
      }
      if (Number.isFinite(v.sys) && Number.isFinite(v.dia) && v.sys <= v.dia)
        errors.push('Systolic must be higher than diastolic');
      return errors;
    },
    /** ESH 2023 categories (office thresholds). Informational only. */
    classify(v) {
      const { sys, dia } = v;
      if (!Number.isFinite(sys) || !Number.isFinite(dia)) return null;
      if (sys < 90 || dia < 60) return bpLevel('low');
      if (sys >= 180 || dia >= 110) return bpLevel('grade3');
      if (sys >= 160 || dia >= 100) return bpLevel('grade2');
      if (sys >= 140 || dia >= 90) return bpLevel('grade1');
      if (sys >= 130 || dia >= 85) return bpLevel('high_normal');
      if (sys >= 120 || dia >= 80) return bpLevel('normal');
      return bpLevel('optimal');
    },
    format(v) {
      const p = Number.isFinite(v.pulse) ? ` · ${v.pulse} /min` : '';
      return `${v.sys}/${v.dia} mmHg${p}`;
    },
    /**
     * Map the stacked numbers of a display (top to bottom) onto fields.
     * Returns a plausibility score: 1 = complete and plausible reading.
     */
    fromDisplayRows(rows) {
      const nums = rows.map((r) => r.value);
      const conf = rows.length ? rows.reduce((s, r) => s + r.confidence, 0) / rows.length : 0;
      const [fSys, fDia, fPul] = this.fields;
      let best = { values: {}, score: 0, confidence: conf };
      // try every consecutive triple / pair (some displays show date/time rows too)
      for (let i = 0; i < nums.length; i++) {
        const sys = nums[i];
        const dia = nums[i + 1];
        const pulse = nums[i + 2];
        if (!inRange(sys, fSys)) continue;
        let score = 0.3;
        const values = { sys };
        if (inRange(dia, fDia) && sys > dia && sys - dia >= 10) {
          values.dia = dia;
          score = 0.7;
          if (inRange(pulse, fPul)) {
            values.pulse = pulse;
            score = 1;
          }
        }
        score *= 0.6 + 0.4 * conf;
        if (score > best.score) best = { values, score: score >= 0.99 ? 1 : score, confidence: conf };
      }
      return best;
    },
  },

  glucose: {
    id: 'glucose',
    label: 'Blood sugar',
    shortLabel: 'Glucose',
    fields: [
      // stored canonically in mg/dL; displayed in the unit chosen in settings
      { key: 'glucose', label: 'Glucose', short: 'GLU', unit: 'mg/dL', min: 10, max: 700, required: true },
    ],
    validate(v) {
      const f = this.fields[0];
      if (v.glucose == null || v.glucose === '') return ['Glucose value is required'];
      if (!inRange(v.glucose, f)) return [`Glucose must be between ${f.min} and ${f.max} mg/dL`];
      return [];
    },
    classify(v) {
      const g = v.glucose;
      if (!Number.isFinite(g)) return null;
      if (g < 70) return { id: 'low', label: 'Low', rank: 3 };
      const fasting = v.context === 'fasting' || v.context === 'before_meal';
      if (fasting) {
        if (g < 100) return { id: 'normal', label: 'Normal', rank: 0 };
        if (g < 126) return { id: 'elevated', label: 'Elevated', rank: 2 };
        return { id: 'high', label: 'High', rank: 4 };
      }
      if (g < 140) return { id: 'normal', label: 'Normal', rank: 0 };
      if (g < 200) return { id: 'elevated', label: 'Elevated', rank: 2 };
      return { id: 'high', label: 'High', rank: 4 };
    },
    format(v, unit = 'mg/dL') {
      const ctx = GLUCOSE_CONTEXTS.find((c) => c.id === v.context);
      return `${formatGlucose(v.glucose, unit)} ${unit}${ctx ? ` · ${ctx.label}` : ''}`;
    },
    fromDisplayRows(rows) {
      // glucose meters show one big number; take the tallest plausible row
      const f = this.fields[0];
      const cands = rows.filter((r) => inRange(r.value, f)).sort((a, b) => b.height - a.height);
      if (!cands.length) return { values: {}, score: 0, confidence: 0 };
      const r = cands[0];
      return { values: { glucose: r.value }, score: 0.6 + 0.4 * r.confidence, confidence: r.confidence };
    },
  },
};

export const TYPE_LIST = Object.values(MEASUREMENT_TYPES);

export function toMgdl(value, unit) {
  return unit === 'mmol/L' ? Math.round(value * MGDL_PER_MMOL) : Math.round(value);
}

export function formatGlucose(mgdl, unit) {
  if (!Number.isFinite(mgdl)) return '–';
  return unit === 'mmol/L' ? (mgdl / MGDL_PER_MMOL).toFixed(1) : String(Math.round(mgdl));
}

export const DEFAULT_TAGS = [
  'Morning',
  'Evening',
  'Left arm',
  'Right arm',
  'Resting',
  'After exercise',
  'Medication taken',
  'Stressed',
  'After coffee',
];
