// Two-way sync of the browser database with the Cloudflare D1 backup
// (see worker/index.js). Last write wins, by each record's updatedAt.
//
// push: every record changed since the last successful push
// pull: every record the server stored after our last pull cursor

import { listAllRecords, getMeasurement, bulkPut, getSetting, setSetting } from './db.js';

const BATCH = 200;

export async function getSyncConfig() {
  return {
    enabled: await getSetting('syncEnabled', false),
    url: await getSetting('syncUrl', ''),
    token: await getSetting('syncToken', ''),
  };
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

/** Strip local-only fields before upload. */
function toWire(m) {
  const { hasPhoto, ...rest } = m;
  return rest;
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

    // push
    const lastPush = await getSetting('syncLastPush', '');
    const startedAt = new Date().toISOString();
    const changed = (await listAllRecords()).filter((m) => !lastPush || (m.updatedAt ?? '') > lastPush);
    let pushed = 0;
    for (let i = 0; i < changed.length; i += BATCH) {
      const chunk = changed.slice(i, i + BATCH).map(toWire);
      const r = await call(cfg, 'sync', { method: 'POST', body: JSON.stringify({ records: chunk }) });
      pushed += r.accepted ?? chunk.length;
    }
    await setSetting('syncLastPush', startedAt);

    // pull
    let cursor = await getSetting('syncCursor', 0);
    let pulled = 0;
    for (;;) {
      const r = await call(cfg, `sync?since=${encodeURIComponent(cursor)}&limit=500`);
      const incoming = [];
      for (const remote of r.records) {
        const local = await getMeasurement(remote.id);
        if (!local || (remote.updatedAt ?? '') > (local.updatedAt ?? '')) {
          incoming.push({ ...remote, hasPhoto: local?.hasPhoto && !remote.deleted ? true : undefined });
        }
      }
      if (incoming.length) await bulkPut(incoming);
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
    if (!cfg.enabled || !cfg.token || !navigator.onLine) return;
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
