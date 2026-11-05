// Browser tests (Chromium via Playwright):
//  1. on-device OCR against synthetic seven-segment displays (all digits)
//  2. OCR against real photos in test/fixtures/private/ (if present, not committed)
//  3. end-to-end: photo -> recognised values -> verify -> save -> history -> CSV
//
// Run: npm run test:browser   (SCREENSHOTS=dir to also save phone screenshots)

import { createServer } from 'vite';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

// resolved via require so a globally installed Playwright works too
const { chromium } = createRequire(import.meta.url)('playwright');

const root = path.resolve(import.meta.dirname, '..');
const shots = process.env.SCREENSHOTS;
// Real photos: <sys>-<dia>-<pulse>[-anything].(jpg|png|webp) in test/fixtures/private
const privateDir = path.join(root, 'test/fixtures/private');
const expectations = { 'boso-medicus-x.webp': { sys: 108, dia: 71, pulse: 101 } };

const server = await createServer({ root, logLevel: 'error', server: { port: 5199, strictPort: false } });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch();
let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   - ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL - ${name}\n       ${e.message.split('\n').join('\n       ')}`);
  }
};

try {
  const page = await browser.newPage();
  await page.goto(base + 'test/harness.html');

  // ---------------- 1. synthetic displays
  const cases = [
    { sys: 108, dia: 71, pulse: 101 },
    { sys: 123, dia: 84, pulse: 67 },
    { sys: 145, dia: 92, pulse: 58 },
    { sys: 160, dia: 99, pulse: 73 },
    { sys: 97, dia: 63, pulse: 88 },
    { sys: 182, dia: 110, pulse: 120 },
    { sys: 134, dia: 85, pulse: 49 },
    { sys: 119, dia: 76, pulse: 62, rotate: 5 },
    { sys: 157, dia: 98, pulse: 102, slant: 0 },
    { sys: 128, dia: 79, pulse: 64, sideways: true },
  ];
  for (const [i, c] of cases.entries()) {
    await check(`synthetic display ${c.sys}/${c.dia}/${c.pulse}${c.rotate ? ` rotated ${c.rotate}°` : ''}${c.sideways ? ' sideways' : ''}`, async () => {
      const got = await page.evaluate(async ({ c, seed }) => {
        const { syntheticDisplay } = await import('/test/synthetic-display.js');
        const { readDisplay } = await import('/src/ocr/reader.js');
        let cv = syntheticDisplay({ ...c, seed });
        if (c.sideways) {
          // photo lying on its side (orientation flag not applied)
          const r = document.createElement('canvas');
          r.width = cv.height;
          r.height = cv.width;
          const ctx = r.getContext('2d');
          ctx.translate(r.width, 0);
          ctx.rotate(Math.PI / 2);
          ctx.drawImage(cv, 0, 0);
          cv = r;
        }
        const img = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
        return readDisplay(img, 'bp').values;
      }, { c, seed: i + 7 });
      assert.deepEqual(got, { sys: c.sys, dia: c.dia, pulse: c.pulse });
    });
  }

  // ---------------- 1b. bathroom scale far away (decimal point, LED, perspective, lb)
  const scales = [
    { value: '72.4' },
    { value: '105.8', floor: 'wood' },
    { value: '58.0', displayH: 50 },
    { value: '83.6', led: true },
    { value: '64.9', led: true, floor: 'wood', displayH: 55 },
    { value: '77.1', perspective: 0.3 },
    { value: '159.6', unit: 'lb', expectKg: 72.4 },
  ];
  for (const [i, c] of scales.entries()) {
    await check(`scale ${c.value} ${c.unit ?? 'kg'}${c.led ? ' LED' : ''}${c.floor === 'wood' ? ' wood floor' : ''}${c.displayH ? ` small (${c.displayH}px)` : ''}`, async () => {
      const got = await page.evaluate(async ({ c, seed }) => {
        const { syntheticScale } = await import('/test/synthetic-display.js');
        const { readDisplay } = await import('/src/ocr/reader.js');
        const cv = syntheticScale({ ...c, seed });
        const img = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
        return readDisplay(img, 'weight', { settings: { weightUnit: c.unit ?? 'kg' } }).values;
      }, { c, seed: i + 5 });
      assert.deepEqual(got, { weight: c.expectKg ?? Number(c.value) });
    });
  }

  // ---------------- 2. real photos
  const photos = fs.existsSync(privateDir) ? fs.readdirSync(privateDir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)) : [];
  for (const f of photos) {
    const m = f.match(/^(\d+)-(\d+)-(\d+)/);
    const expected = expectations[f] ?? (m ? { sys: +m[1], dia: +m[2], pulse: +m[3] } : null);
    if (!expected) continue;
    await check(`photo ${f}`, async () => {
      const got = await page.evaluate(async (url) => {
        const { readDisplay } = await import('/src/ocr/reader.js');
        const bmp = await createImageBitmap(await (await fetch(url)).blob());
        const cv = new OffscreenCanvas(bmp.width, bmp.height);
        cv.getContext('2d').drawImage(bmp, 0, 0);
        return readDisplay(cv.getContext('2d').getImageData(0, 0, bmp.width, bmp.height), 'bp').values;
      }, `/test/fixtures/private/${f}`);
      assert.deepEqual(got, expected);
    });
  }
  if (!photos.length) console.log('skip - no real photos in test/fixtures/private/');

  // ---------------- 3. end-to-end in a phone viewport
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true });
  const app = await ctx.newPage();
  const errors = [];
  app.on('pageerror', (e) => errors.push(e.message));
  await app.goto(base + '#/overview');
  await app.waitForSelector('.quick-actions');
  if (shots) await app.screenshot({ path: path.join(shots, '01-empty.png') });

  // photo to upload: real one if available, otherwise a synthetic display
  let photoPath = photos.includes('boso-medicus-x.webp') ? path.join(privateDir, 'boso-medicus-x.webp') : null;
  let expected = { sys: 108, dia: 71, pulse: 101 };
  if (!photoPath) {
    const b64 = await page.evaluate(async () => {
      const { syntheticDisplay } = await import('/test/synthetic-display.js');
      return syntheticDisplay({ sys: 108, dia: 71, pulse: 101 }).toDataURL('image/png').split(',')[1];
    });
    photoPath = path.join(root, 'node_modules/.cache-synthetic.png');
    fs.writeFileSync(photoPath, Buffer.from(b64, 'base64'));
  }

  await check('e2e: photo is read and values are prefilled for verification', async () => {
    await app.goto(base + '#/add?type=bp');
    await app.locator('input[type=file][capture]').setInputFiles(photoPath);
    await app.waitForFunction(() => document.querySelector('#in-sys')?.value !== '', null, { timeout: 15000 });
    assert.equal(await app.inputValue('#in-sys'), String(expected.sys));
    assert.equal(await app.inputValue('#in-dia'), String(expected.dia));
    assert.equal(await app.inputValue('#in-pulse'), String(expected.pulse));
    assert.equal(await app.locator('.value-input.from-photo').count(), 3);
    if (shots) {
      await app.screenshot({ path: path.join(shots, '02a-verify-top.png') });
      await app.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await app.waitForTimeout(200);
      await app.screenshot({ path: path.join(shots, '02b-verify-bottom.png') });
    }
  });

  await check('e2e: phone photo stored sideways with an EXIF orientation flag', async () => {
    // Phone cameras save portrait photos as landscape pixels + EXIF "rotate 90°".
    // Build such a JPEG from the upright test photo and upload it like a camera shot.
    const exifPath = path.join(root, 'node_modules/.cache-exif.jpg');
    const b64 = await page.evaluate(async (src) => {
      const bmp = await createImageBitmap(await (await fetch(src)).blob());
      // store the pixels rotated 90° counter-clockwise; EXIF orientation 6 = rotate 90° CW to view
      const c = new OffscreenCanvas(bmp.height, bmp.width);
      const ctx = c.getContext('2d');
      ctx.translate(0, bmp.width);
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(bmp, 0, 0);
      const jpg = new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer());
      // minimal APP1/Exif segment with Orientation = 6, inserted after SOI
      const exif = [0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
      const out = new Uint8Array(jpg.length + exif.length);
      out.set(jpg.subarray(0, 2), 0);
      out.set(exif, 2);
      out.set(jpg.subarray(2), 2 + exif.length);
      let bin = '';
      for (const x of out) bin += String.fromCharCode(x);
      return btoa(bin);
    }, photos.includes('boso-medicus-x.webp') ? '/test/fixtures/private/boso-medicus-x.webp' : null).catch(() => null);
    if (!b64) return console.log('skip - needs the real photo in test/fixtures/private/');
    fs.writeFileSync(exifPath, Buffer.from(b64, 'base64'));
    await app.goto(base + '#/overview'); // leave the previous editor (same URL would keep it)
    await app.goto(base + '#/add?type=bp');
    await app.waitForFunction(() => document.querySelector('#in-sys')?.value === '');
    await app.locator('input[type=file][capture]').setInputFiles(exifPath);
    await app.waitForFunction(() => document.querySelector('#in-sys')?.value !== '', null, { timeout: 15000 });
    assert.deepEqual([await app.inputValue('#in-sys'), await app.inputValue('#in-dia'), await app.inputValue('#in-pulse')], ['108', '71', '101']);
  });

  await check('e2e: user corrects a value, adds tags and saves', async () => {
    await app.fill('#in-pulse', '72');
    // the date field is a native input laid invisibly over a styled box
    const box = await app.locator('.dt-wrap').boundingBox();
    const card = await app.locator('.dt-wrap').locator('xpath=ancestor::div[contains(@class,"card")]').boundingBox();
    assert.ok(box.x + box.width <= card.x + card.width, 'date box stays inside its card');
    await app.fill('#in-when', '2026-11-04T07:45');
    assert.match(await app.locator('.dt-text').innerText(), /7:45|07:45/);
    await app.getByRole('button', { name: 'Morning', exact: true }).click();
    const newTag = app.getByPlaceholder('+ New tag');
    await newTag.fill('Home office');
    await newTag.press('Enter');
    await app.getByRole('button', { name: 'Save', exact: true }).click();
    await app.waitForSelector('.reading .big');
    assert.match(await app.locator('.reading .big').first().innerText(), /108\/71/);
  });

  await check('e2e: manual glucose entry + history + charts', async () => {
    await app.goto(base + '#/add?type=glucose');
    await app.fill('#in-glucose', '96');
    await app.getByRole('button', { name: 'Save', exact: true }).click();
    await app.waitForSelector('.reading .big');
    // add a few older readings so charts have data
    await app.evaluate(async () => {
      const db = await import('/src/db.js');
      const now = Date.now();
      for (let i = 1; i <= 20; i++) {
        const sys = 112 + Math.round(Math.sin(i) * 12 + i * 0.6);
        await db.saveMeasurement({ type: 'bp', timestamp: new Date(now - i * 0.75 * 86400000).toISOString(), values: { sys, dia: sys - 40 + (i % 5), pulse: 60 + (i % 9) * 3 }, tags: [i % 2 ? 'Morning' : 'Evening'], note: '', source: 'manual' });
        if (i % 3 === 0) await db.saveMeasurement({ type: 'glucose', timestamp: new Date(now - i * 86400000).toISOString(), values: { glucose: 88 + (i % 7) * 9, context: i % 2 ? 'fasting' : 'after_meal' }, tags: [], note: '', source: 'manual' });
      }
    });
    await app.goto(base + '#/overview');
    await app.reload();
    await app.waitForSelector('.chart svg');
    if (shots) {
      await app.screenshot({ path: path.join(shots, '03a-overview.png') });
      await app.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await app.waitForTimeout(200);
      await app.screenshot({ path: path.join(shots, '03b-overview-bottom.png') });
    }
    await app.goto(base + '#/history');
    await app.waitForSelector('.entry');
    const first = await app.locator('.entry').first().innerText();
    assert.match(first, /96/);
    assert.ok((await app.locator('.entry', { hasText: '#Home office' }).count()) === 1, 'custom tag shown in history');
    if (shots) await app.screenshot({ path: path.join(shots, '04-history.png') });
    await app.goto(base + '#/charts');
    await app.waitForSelector('.chart svg');
    assert.equal(await app.locator('.chart svg').count(), 2);
    // touch tooltip
    const box = await app.locator('.chart svg').first().boundingBox();
    await app.locator('.chart .hit').first().dispatchEvent('pointermove', { clientX: box.x + box.width * 0.7, clientY: box.y + 60 });
    await app.waitForSelector('.chart-tip:not([hidden])');
    if (shots) await app.screenshot({ path: path.join(shots, '05-charts.png'), fullPage: true });
  });

  await check('e2e: weight from a far-away scale photo, saved and charted', async () => {
    const b64 = await page.evaluate(async () => {
      const { syntheticScale } = await import('/test/synthetic-display.js');
      return syntheticScale({ value: '72.4', seed: 5 }).toDataURL('image/jpeg', 0.9).split(',')[1];
    });
    const scalePath = path.join(root, 'node_modules/.cache-scale.jpg');
    fs.writeFileSync(scalePath, Buffer.from(b64, 'base64'));
    await app.goto(base + '#/add?type=weight');
    await app.locator('input[type=file][capture]').setInputFiles(scalePath);
    await app.waitForFunction(() => document.querySelector('#in-weight')?.value !== '', null, { timeout: 20000 });
    assert.equal(await app.inputValue('#in-weight'), '72.4');
    if (shots) await app.screenshot({ path: path.join(shots, '08-weight-verify.png') });
    await app.getByRole('button', { name: 'Save', exact: true }).click();
    await app.waitForSelector('.reading .big');
    assert.ok(await app.locator('.card', { hasText: 'Latest weight' }).count());
  });

  await check('e2e: CSV export contains pulse and tags', async () => {
    await app.goto(base + '#/history');
    await app.waitForSelector('.entry');
    const [dl] = await Promise.all([app.waitForEvent('download'), app.getByRole('button', { name: /Export CSV/ }).click()]);
    const csv = fs.readFileSync(await dl.path(), 'utf8');
    assert.match(csv, /pulse_per_min/);
    assert.match(csv, /,108,71,72,/);
    assert.match(csv, /Morning; Home office|Home office; Morning/);
  });

  await check('e2e: dark mode renders', async () => {
    await app.emulateMedia({ colorScheme: 'dark' });
    await app.goto(base + '#/charts');
    await app.waitForSelector('.chart svg');
    const bg = await app.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(bg, 'rgb(17, 17, 16)');
    if (shots) await app.screenshot({ path: path.join(shots, '06-charts-dark.png') });
    await app.goto(base + '#/settings');
    await app.waitForSelector('.switch');
    if (shots) await app.screenshot({ path: path.join(shots, '07-settings-dark.png'), fullPage: true });
  });

  await check('no uncaught page errors', async () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  await server.close();
}

console.log(failures ? `\n${failures} failed` : '\nall browser tests passed');
process.exit(failures ? 1 : 0);
