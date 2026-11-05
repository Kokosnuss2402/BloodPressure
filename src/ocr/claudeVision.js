// Optional: read the display with Claude's vision model, using the user's own
// Anthropic API key (stored only in this browser). The photo is sent to the
// Anthropic API only when the user explicitly enables this in Settings.

const MODEL = 'claude-opus-5-5';

const SCHEMAS = {
  bp: {
    type: 'object',
    properties: {
      readable: { type: 'boolean', description: 'false if no blood pressure reading is visible' },
      systolic: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
      diastolic: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
      pulse: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    },
    required: ['readable', 'systolic', 'diastolic', 'pulse'],
    additionalProperties: false,
  },
  glucose: {
    type: 'object',
    properties: {
      readable: { type: 'boolean', description: 'false if no glucose reading is visible' },
      value: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'number exactly as displayed' },
      unit: { anyOf: [{ type: 'string', enum: ['mg/dL', 'mmol/L'] }, { type: 'null' }] },
    },
    required: ['readable', 'value', 'unit'],
    additionalProperties: false,
  },
};

SCHEMAS.weight = {
  type: 'object',
  properties: {
    readable: { type: 'boolean', description: 'false if no weight is visible' },
    value: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'number exactly as displayed, with its decimal point' },
    unit: { anyOf: [{ type: 'string', enum: ['kg', 'lb'] }, { type: 'null' }] },
  },
  required: ['readable', 'value', 'unit'],
  additionalProperties: false,
};

const PROMPTS = {
  bp:
    'This photo shows the display of a blood pressure monitor. Read the systolic (SYS), ' +
    'diastolic (DIA) and pulse (PUL) values exactly as shown on the display. ' +
    'Use null for any value that is not visible. Do not guess.',
  glucose:
    'This photo shows the display of a blood glucose meter. Read the measured glucose value ' +
    'exactly as shown (keep a decimal point if displayed) and its unit if visible. Do not guess.',
  weight:
    'This photo shows a bathroom scale; its display may be small and far away. Read the weight ' +
    'exactly as shown on the display (keep the decimal point) and its unit if visible. Do not guess.',
};

/**
 * @param {Blob} jpegBlob  photo (already downscaled)
 * @param {'bp'|'glucose'} kind
 * @param {string} apiKey
 */
export async function readWithClaude(jpegBlob, kind, apiKey) {
  const [{ default: Anthropic }, { betaJSONSchemaOutputFormat }] = await Promise.all([
    import('@anthropic-ai/sdk'),
    import('@anthropic-ai/sdk/helpers/beta/json-schema'),
  ]);
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const data = await blobToBase64(jpegBlob);

  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: betaJSONSchemaOutputFormat(SCHEMAS[kind]) },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
          { type: 'text', text: PROMPTS[kind] },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') throw new Error('The request was declined by the model.');
  const out = response.parsed_output;
  if (!out || !out.readable) throw new Error('Claude could not read a value on this photo.');

  if (kind === 'bp') {
    const values = {};
    if (Number.isInteger(out.systolic)) values.sys = out.systolic;
    if (Number.isInteger(out.diastolic)) values.dia = out.diastolic;
    if (Number.isInteger(out.pulse)) values.pulse = out.pulse;
    return { values };
  }
  if (kind === 'weight') return { values: { weightDisplayed: out.value, weightUnit: out.unit } };
  return { values: { glucoseDisplayed: out.value, glucoseUnit: out.unit } };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
