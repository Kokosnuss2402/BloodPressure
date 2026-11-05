// Measurement type registry. Every measurement kind (blood pressure, blood
// glucose, weight) is described here: its fields, units, plausibility ranges,
// how to map numbers read from a device display onto fields, and how to
// classify a value. Adding a new kind means adding an entry here; storage,
// history, editor, CSV export and charts are driven by this description.
//
// Values are stored in one canonical unit per field (mmHg, mg/dL, kg); a field's
// unit(settings) / toDisplay() / fromInput() convert for the unit the user chose.

export const MGDL_PER_MMOL = 18.016;
export const LB_PER_KG = 2.20462;

export const GLUCOSE_CONTEXTS = [
  { id: 'fasting', label: 'Fasting' },
  { id: 'before_meal', label: 'Before meal' },
  { id: 'after_meal', label: 'After meal (2 h)' },
  { id: 'bedtime', label: 'Bedtime' },
  { id: 'random', label: 'Other / random' },
];

const inRange = (v, f) => Number.isFinite(v) && v >= f.min && v <= f.max;
const round1 = (v) => Math.round(v * 10) / 10;

/**
 * Plausibility of one row as the reading of a single-number display (scale,
 * glucose meter): exactly decoded digits, at least three of them, and digits
 * that are not tiny relative to the photo (texture in floors, towels and
 * clothes produces small digit-like patterns). Rows without `rel` (unknown
 * photo size) are not penalised for size.
 */
const singleRowScore = (r) =>
  (0.6 + 0.4 * r.confidence) * (r.text.length >= 3 ? 1 : 0.85) * Math.min(1, (r.rel ?? 1) / 0.018);

/** Single-number displays: the most plausible row. */
const bestSingleRow = (rows, extra = () => 1) =>
  [...rows].sort((a, b) => singleRowScore(b) * extra(b) - singleRowScore(a) * extra(a) || b.height - a.height)[0] ?? null;

/** Plain integer field with a fixed unit (mmHg, /min). */
const intField = (f) => ({
  unit: () => f.unitLabel,
  toDisplay: (v) => (Number.isFinite(v) ? String(Math.round(v)) : ''),
  fromInput: (n) => Math.round(n),
  decimalInput: () => false,
  ...f,
});

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
    tabLabel: 'Pressure',
    icon: 'gauge',
    fields: [
      intField({ key: 'sys', label: 'Systolic', short: 'SYS', unitLabel: 'mmHg', min: 50, max: 280, required: true }),
      intField({ key: 'dia', label: 'Diastolic', short: 'DIA', unitLabel: 'mmHg', min: 25, max: 180, required: true }),
      intField({ key: 'pulse', label: 'Pulse', short: 'PUL', unitLabel: '/min', min: 25, max: 250, required: false }),
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
    tabLabel: 'Sugar',
    icon: 'drop',
    fields: [
      // stored canonically in mg/dL; displayed in the unit chosen in settings
      {
        key: 'glucose',
        label: 'Glucose',
        short: 'GLU',
        min: 10,
        max: 700,
        required: true,
        unit: (st) => st?.glucoseUnit ?? 'mg/dL',
        toDisplay: (v, st) => (Number.isFinite(v) ? formatGlucose(v, st?.glucoseUnit) : ''),
        fromInput: (n, st) => toMgdl(n, st?.glucoseUnit),
        decimalInput: (st) => st?.glucoseUnit === 'mmol/L',
      },
    ],
    defaults: () => ({ context: 'fasting' }),
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
    format(v, st) {
      const unit = st?.glucoseUnit ?? 'mg/dL';
      const ctx = GLUCOSE_CONTEXTS.find((c) => c.id === v.context);
      return `${formatGlucose(v.glucose, unit)} ${unit}${ctx ? ` · ${ctx.label}` : ''}`;
    },
    fromDisplayRows(rows, st) {
      // Glucose meters show one big number. A decimal point means mmol/L
      // (mg/dL is always whole); if no point was seen but the user works in
      // mmol/L, the meter's one decimal was missed: 56 -> 5.6.
      const f = this.fields[0];
      const toMg = (r) => {
        if (r.decimals > 0) return toMgdl(r.number, 'mmol/L');
        return st?.glucoseUnit === 'mmol/L' ? toMgdl(r.value / 10, 'mmol/L') : r.value;
      };
      const r = bestSingleRow(rows.filter((x) => inRange(toMg(x), f)));
      if (!r) return { values: {}, score: 0, confidence: 0 };
      return { values: { glucose: toMg(r) }, score: singleRowScore(r) / (r.text.length >= 3 ? 1 : 0.85), confidence: r.confidence, row: r };
    },
  },
};

MEASUREMENT_TYPES.weight = {
  id: 'weight',
  label: 'Weight',
  shortLabel: 'Weight',
  icon: 'scale',
  // scales are photographed from standing height: the display is small in the frame
  farDisplay: true,
  fields: [
    {
      key: 'weight',
      label: 'Weight',
      short: 'WT',
      min: 2, // kg
      max: 350,
      required: true,
      unit: (st) => st?.weightUnit ?? 'kg',
      toDisplay: (v, st) => (Number.isFinite(v) ? formatWeight(v, st?.weightUnit) : ''),
      fromInput: (n, st) => toKg(n, st?.weightUnit),
      decimalInput: () => true,
    },
  ],
  validate(v) {
    const f = this.fields[0];
    if (!Number.isFinite(v.weight)) return ['Weight is required'];
    if (!inRange(v.weight, f)) return [`Weight must be between ${f.min} and ${f.max} kg`];
    return [];
  },
  /** WHO BMI categories; needs the body height from settings. */
  classify(v, st) {
    const bmi = bmiOf(v.weight, st?.heightCm);
    if (!Number.isFinite(bmi)) return null;
    // label: for one reading (with its BMI); group: for a category across readings
    const lvl = (id, group, rank) => ({ id, group, label: `${group} · BMI ${bmi.toFixed(1)}`, rank });
    // WHO grades of thinness
    if (bmi < 16) return lvl('underweight3', 'Severely underweight', 5);
    if (bmi < 17) return lvl('underweight2', 'Moderately underweight', 4);
    if (bmi < 18.5) return lvl('underweight1', 'Mildly underweight', 2);
    if (bmi < 25) return lvl('normal', 'Normal', 0);
    if (bmi < 30) return lvl('overweight', 'Overweight', 2);
    if (bmi < 35) return lvl('obese1', 'Obesity I', 3);
    if (bmi < 40) return lvl('obese2', 'Obesity II', 4);
    return lvl('obese3', 'Obesity III', 5);
  },
  format(v, st) {
    const unit = st?.weightUnit ?? 'kg';
    return `${formatWeight(v.weight, unit)} ${unit}`;
  },
  fromDisplayRows(rows, st) {
    // Scales show one number, normally with one decimal ("72.4"). If the
    // decimal point was not detected and the number is too large to be a
    // weight, the point was missed: 724 -> 72.4.
    const unit = st?.weightUnit ?? 'kg';
    const f = this.fields[0];
    const toW = (r) => {
      let n = r.decimals > 0 ? r.number : r.value;
      if (!(r.decimals > 0) && toKg(n, unit) > f.max) n /= 10;
      return toKg(n, unit);
    };
    // a decimal point found where one is expected makes the reading more trustworthy
    const dec = (x) => (x.decimals > 0 ? 1 : 0.9);
    // from a photo, accept 10 kg and up: smaller numbers are almost always texture
    // misread as digits (typing a lower weight by hand is still allowed)
    const ocrRange = { min: 10, max: f.max };
    const r = bestSingleRow(rows.filter((x) => x.text.length >= 2 && inRange(toW(x), ocrRange)), dec);
    if (!r) return { values: {}, score: 0, confidence: 0 };
    const score = singleRowScore(r) * dec(r);
    return { values: { weight: toW(r) }, score, confidence: r.confidence, row: r };
  },
};

export const TYPE_LIST = Object.values(MEASUREMENT_TYPES);

export function toKg(value, unit) {
  return round1(unit === 'lb' ? value / LB_PER_KG : value);
}

export function formatWeight(kg, unit) {
  if (!Number.isFinite(kg)) return '–';
  return (unit === 'lb' ? kg * LB_PER_KG : kg).toFixed(1);
}

export function bmiOf(kg, heightCm) {
  if (!Number.isFinite(kg) || !Number.isFinite(heightCm) || heightCm < 50) return NaN;
  return kg / (heightCm / 100) ** 2;
}

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
