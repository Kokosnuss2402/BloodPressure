// Two-way sync of the browser database with the Cloudflare D1 backup
// (see worker/index.js). Last write wins, by each record's updatedAt.
//
// push: every record changed since the last successful push
// pull: every record the server stored after our last pull cursor
//
// Records are end-to-end encrypted (see crypto.js): the server receives only
// { id, updatedAt, deleted, enc } where `enc` is the AES-GCM ciphertext.

import { listAllRecords, bulkPut, deletePhoto, getSetting, setSetting } from './db.js';
import { deriveKey, encryptJSON, decryptJSON, makeCheck, verifyCheck, randomSalt, KDF_ITERATIONS } from './crypto.js';

const BATCH = 200;

export async function getSyncConfig() {
  return {
    enabled: await getSetting('syncEnabled', false),
    url: await getSetting('syncUrl', ''),
    token: await getSetting('syncToken', ''),
    key: await getSetting('syncKey', null), // non-extractable CryptoKey
  };
}

/**
 * Set up (first device) or unlock (further devices) the encrypted backup.
 * The passphrase is not stored; only the derived, non-extractable key is.
 */
export async function setPassphrase(cfg, passphrase) {
  if (!passphrase || passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
  let meta = (await call(cfg, 'crypto')).meta;
  if (!meta) {
    const salt = randomSalt();
    const key = await deriveKey(passphrase, salt, KDF_ITERATIONS);
    const proposal = { salt, iterations: KDF_ITERATIONS, check: await makeCheck(key) };
    // the server keeps the first one it receives (another device may have won a race)
    meta = (await call(cfg, 'crypto', { method: 'POST', body: JSON.stringify(proposal) })).meta;
  }
  const key = await deriveKey(passphrase, meta.salt, meta.iterations);
  if (!(await verifyCheck(key, meta.check))) throw new Error('Wrong passphrase for this backup.');
  await setSetting('syncKey', key);
  await resetSyncState(); // full re-sync with the (new) key
  return true;
}

export async function forgetKey() {
  await setSetting('syncKey', null);
}

function endpoint(cfg, path) {
  const base = (cfg.url || location.origin).replace(/\/+$/, '');
  return `${base}/api/${path}`;
}

async function call(cfg, path, init = {}) {
  const res = await fetch(endpoint(cfg, path), {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}`, ...(init.headers ?? {}) },
  });
  if (res.status === 401) throw new Error('Backup server rejected the sync token.');
  if (!res.ok) throw new Error(`Backup server error ${res.status}`);
  return res.json();
}

/** Encrypt a record for upload (local-only fields are dropped). */
async function toWire(key, m) {
  const { hasPhoto, ...rest } = m;
  const wire = { id: m.id, updatedAt: m.updatedAt, enc: await encryptJSON(key, rest, m.id) };
  if (m.deleted) wire.deleted = true;
  return wire;
}

async function fromWire(key, w) {
  let rec;
  try {
    rec = await decryptJSON(key, w.enc, w.id);
  } catch {
    throw new Error('Could not decrypt the backup – was it set up with a different passphrase?');
  }
  if (rec.id !== w.id) throw new Error('Backup record does not match its id.');
  return rec;
}

export async function testConnection(cfg) {
  return call(cfg, 'health');
}

let running = null;

/** Run a full push + pull. Returns { pushed, pulled }. */
export function syncNow() {
  if (running) return running;
  running = (async () => {
    const cfg = await getSyncConfig();
    if (!cfg.enabled || !cfg.token) throw new Error('Cloud backup is not configured.');
    if (!cfg.key) throw new Error('Enter the backup passphrase in Settings first.');

    // push
    const lastPush = await getSetting('syncLastPush', '');
    const startedAt = new Date().toISOString();
    const changed = (await listAllRecords()).filter((m) => !lastPush || (m.updatedAt ?? '') > lastPush);
    let pushed = 0;
    for (let i = 0; i < changed.length; i += BATCH) {
      const chunk = await Promise.all(changed.slice(i, i + BATCH).map((m) => toWire(cfg.key, m)));
      const r = await call(cfg, 'sync', { method: 'POST', body: JSON.stringify({ records: chunk }) });
      pushed += r.accepted ?? chunk.length;
    }
    await setSetting('syncLastPush', startedAt);

    // pull
    let cursor = await getSetting('syncCursor', 0);
    let pulled = 0;
    const local = new Map((await listAllRecords()).map((m) => [m.id, m]));
    for (;;) {
      const r = await call(cfg, `sync?since=${encodeURIComponent(cursor)}&limit=500`);
      const incoming = [];
      for (const wire of r.records) {
        const remote = await fromWire(cfg.key, wire);
        const mine = local.get(remote.id);
        if (!mine || (remote.updatedAt ?? '') > (mine.updatedAt ?? '')) {
          const rec = { ...remote, hasPhoto: mine?.hasPhoto && !remote.deleted ? true : undefined };
          incoming.push(rec);
          local.set(rec.id, rec);
        }
      }
      if (incoming.length) await bulkPut(incoming);
      // deletions from other devices: drop the photo kept on this device too
      for (const rec of incoming) if (rec.deleted) await deletePhoto(rec.id);
      pulled += incoming.length;
      cursor = r.cursor;
      if (!r.more) break;
    }
    await setSetting('syncCursor', cursor);
    await setSetting('syncLastResult', { at: new Date().toISOString(), pushed, pulled, ok: true });
    return { pushed, pulled };
  })()
    .catch(async (err) => {
      await setSetting('syncLastResult', { at: new Date().toISOString(), ok: false, error: String(err.message ?? err) });
      throw err;
    })
    .finally(() => {
      running = null;
    });
  return running;
}

let timer = null;
/** Debounced background sync after local changes (errors are recorded, not thrown). */
export function scheduleSync(onDone) {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const cfg = await getSyncConfig();
    if (!cfg.enabled || !cfg.token || !cfg.key || !navigator.onLine) return;
    try {
      const r = await syncNow();
      onDone?.(r);
    } catch (e) {
      onDone?.(null, e);
    }
  }, 1500);
}

export async function resetSyncState() {
  await setSetting('syncLastPush', '');
  await setSetting('syncCursor', 0);
}
