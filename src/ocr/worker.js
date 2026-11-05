// Runs the display reader off the main thread so the UI stays smooth.
import { readDisplay } from './reader.js';

self.onmessage = (e) => {
  const { id, image, kind, crop, settings } = e.data;
  try {
    const t0 = performance.now();
    const result = readDisplay(image, kind, { crop, settings });
    self.postMessage({ id, ok: true, result, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message ?? err) });
  }
};
