# Vitals Log

A mobile-friendly web app for keeping a log of your **blood pressure, pulse, blood sugar and weight**.
Take a photo of your measuring device and the numbers are read **right in the browser**. Check
the values, add tags, then save.

- 📷 **Photo → values**: the on-device seven-segment reader works with typical LCD monitors (tested
  with a boso medicus X). It handles slanted digits, shadows, tilted and far-away photos. Nothing
  is uploaded. If it can't read the display, drag a box around the numbers or type them in.
- ✅ **Verify before saving**: values read from the photo are marked in blue and detected rows are
  outlined on the photo. Nothing is stored until you tap *Save*.
- 🏷 **Tags**: define your own tags (Morning, Left arm, Medication taken, …), add new ones while
  saving, and rename or delete them in Settings. History and charts can be filtered by tag.
- 📈 **Charts & stats**: systolic/diastolic, pulse and glucose over time. Includes 7/30/90/365-day
  ranges, morning vs. evening averages, averages by tag, and a breakdown by category (ESH 2023 /
  ADA). The colours are colour-blind safe (deuteranopia), and every series also has its own marker
  shape and label.
- 🩸 **Blood sugar** in mg/dL or mmol/L, with fasting / before / after meal context.
- ⚖️ **Weight** in kg or lb, read from a bathroom-scale photo taken from standing height (small, far-away
  display, LCD or LED, decimal point detected). With your height set, BMI and its WHO category are shown.
- ⬇ **CSV export** (comma or semicolon for European Excel), JSON backup and import.
- ☁ **Cloud backup** to your own **Cloudflare D1** database. The browser database (IndexedDB) stays
  the main store. Two-way sync lets a second device restore your data, and deletions sync too.
  Photos never leave the device.
- 🔒 **End-to-end encrypted backup**: every record is encrypted in the browser with AES-256-GCM, using
  a key derived from your backup passphrase (PBKDF2-SHA-256, 600,000 iterations) and bound to the
  record id. D1 stores only the id, the time of the last change, a deleted flag and the ciphertext.
  The Worker refuses unencrypted records. The passphrase is never stored or uploaded: each device
  keeps only a non-exportable key. If you lose the passphrase, the backup can't be read.
- ✨ Optional: let **Claude** read difficult displays with your own Anthropic API key (off by default).
- 📱 Feels like an app: no pinch or double-tap zoom (there's an adjustable text size instead), no text
  selection or long-press menus on controls. Photos are not kept unless you turn that on.
- 📱 Installable PWA that **works fully offline**, including reading photos: measurements are saved on the
  device and synced to the backup automatically once you're back online. Light & dark mode.

> Categories are for information only and are not a diagnosis.

## Deploy on Cloudflare (from this GitHub repo)

1. In the Cloudflare dashboard go to **Workers & Pages → Create → Import a repository** and pick
   this repository.
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy` (the default)

   On the first deploy, Wrangler creates the D1 database `vitals-log` automatically. The Worker
   creates its table on the first request, so no migration step is needed.
2. Open the Worker, go to **Settings → Variables and Secrets** and add a **secret** named
   `SYNC_TOKEN` with a long random value (e.g. from `openssl rand -base64 32`).
3. Open the app at the Worker URL (`https://vitals-log.<you>.workers.dev`). Go to
   **Settings → Cloud backup**, enter the same token, switch backup on and choose an **encryption
   passphrase**. Leave the URL empty when the app runs on the same Worker. On other devices, enter
   the same token and passphrase to restore and sync.

   To start over with a new passphrase, empty the backup with
   `npx wrangler d1 execute vitals-log --remote --command "DELETE FROM measurements; DELETE FROM meta;"`.
4. Recommended, because this is health data: put the Worker behind **Cloudflare Access**
   (Zero Trust → Access → Applications) so that only you can open it.

If the automatic D1 creation fails (e.g. missing permissions), create the database yourself with
`npx wrangler d1 create vitals-log` and add the printed `database_id` to `wrangler.jsonc`.

Deploying from your machine works as well: `npx wrangler login`, then `npm run deploy` and
`npx wrangler secret put SYNC_TOKEN`.

## Develop

```bash
npm install
npm run dev            # app only, http://localhost:5173
npm run worker:dev     # app + sync API + local D1 (put SYNC_TOKEN=... in .dev.vars)
npm test               # unit tests
npm run test:browser   # OCR + end-to-end tests in Chromium (needs Playwright)
```

Real device photos for the OCR tests go in `test/fixtures/private/` (git-ignored, so health
data isn't committed). Name them `<sys>-<dia>-<pulse>.jpg`, e.g. `128-82-64.jpg`.

### Layout

| Path | What |
| --- | --- |
| `src/ocr/sevenSegment.js` | LCD reader: adaptive threshold → segment components → de-slant → digits → rows |
| `src/ocr/reader.js` | multi-pass reading (thresholds, rotation, zoom on display) + plausibility scoring |
| `src/ocr/claudeVision.js` | optional Claude vision fallback (bring your own key) |
| `src/types.js` | measurement types (blood pressure, blood sugar): fields, ranges, categories. Add new types here |
| `src/db.js`, `src/sync.js`, `src/crypto.js` | IndexedDB storage, end-to-end encrypted two-way sync with the D1 backup |
| `src/chart.js` | responsive SVG charts with touch tooltips |
| `worker/index.js` | Cloudflare Worker: static app + `/api/sync` backed by D1 |
