// Tiny IndexedDB wrapper. The browser database is the primary store; an optional
// Cloudflare D1 backup is kept in sync by sync.js.
//
// measurement = {
//   id: string, type: 'bp' | 'glucose', timestamp: ISO string,
//   values: { sys, dia, pulse } | { glucose (mg/dL), context },
//   tags: string[], note: string,
//   source: 'photo' | 'photo-ai' | 'manual', ocr?: { raw, corrected },
//   hasPhoto: boolean, createdAt, updatedAt,
//   deleted?: true   (soft delete, so deletions can be synced to the backup)
// }

const DB_NAME = 'vitals-log';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('measurements')) {
        const s = db.createObjectStore('measurements', { keyPath: 'id' });
        s.createIndex('timestamp', 'timestamp');
        s.createIndex('type', 'type');
      }
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos');
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let result;
        Promise.resolve(fn(s)).then((r) => (result = r));
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

const reqP = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export const newId = () =>
  (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

export async function listAllRecords() {
  return tx('measurements', 'readonly', (s) => reqP(s.getAll()));
}

export async function listMeasurements() {
  const all = await listAllRecords();
  return all.filter((m) => !m.deleted).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export async function getMeasurement(id) {
  return tx('measurements', 'readonly', (s) => reqP(s.get(id)));
}

export async function saveMeasurement(m, photoBlob) {
  const now = new Date().toISOString();
  const rec = { ...m, id: m.id ?? newId(), createdAt: m.createdAt ?? now, updatedAt: now };
  if (photoBlob) rec.hasPhoto = true;
  await tx('measurements', 'readwrite', (s) => s.put(rec));
  if (photoBlob) await tx('photos', 'readwrite', (s) => s.put(photoBlob, rec.id));
  return rec;
}

export async function deleteMeasurement(id) {
  const m = await getMeasurement(id);
  if (m) {
    const now = new Date().toISOString();
    // keep a tombstone so the deletion reaches the cloud backup
    const tomb = { id, type: m.type, timestamp: m.timestamp, deleted: true, createdAt: m.createdAt, updatedAt: now };
    await tx('measurements', 'readwrite', (s) => s.put(tomb));
  }
  await tx('photos', 'readwrite', (s) => s.delete(id));
}

export async function getPhoto(id) {
  return tx('photos', 'readonly', (s) => reqP(s.get(id)));
}

export async function deletePhoto(id) {
  await tx('photos', 'readwrite', (s) => s.delete(id));
}

export async function clearAll() {
  for (const store of ['measurements', 'photos']) await tx(store, 'readwrite', (s) => s.clear());
}

export async function bulkPut(records) {
  await tx('measurements', 'readwrite', (s) => {
    for (const r of records) s.put(r);
  });
}

export async function getSetting(key, fallback) {
  const v = await tx('settings', 'readonly', (s) => reqP(s.get(key)));
  return v === undefined ? fallback : v;
}

export async function setSetting(key, value) {
  await tx('settings', 'readwrite', (s) => s.put(value, key));
}
