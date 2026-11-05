// Cloudflare Worker: serves the web app (static assets from ./dist) and a small
// sync API that keeps a backup of the measurements in a D1 database.
//
//   GET  /api/health                 -> { ok, records }
//   GET  /api/crypto                 -> { meta }   key-derivation salt + passphrase check
//   POST /api/crypto { salt, iterations, check } -> { meta } (first one wins)
//   POST /api/sync  { records: [] }  -> { accepted }     (upsert, last write wins)
//   GET  /api/sync?since=N&limit=M   -> { records, cursor, more }
//
// Records are end-to-end encrypted in the browser: { id, updatedAt, deleted?, enc }.
// The worker never sees measurement values and rejects unencrypted records.
//
// Every /api request needs "Authorization: Bearer <SYNC_TOKEN>".
// Set the secret with:  npx wrangler secret put SYNC_TOKEN

const MAX_RECORD_BYTES = 64 * 1024;
const MAX_BATCH = 500;

// Same schema as migrations/0001_init.sql, applied lazily so a fresh
// deployment works without a separate migration step.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS measurements (
     id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL,
     deleted INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS idx_measurements_seq ON measurements (seq)',
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
];
let schemaReady = null;
function ensureSchema(env) {
  schemaReady ??= env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q))).catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

// CORS: lets the app run on another origin (e.g. local dev) with "Backup server URL" set.
// Auth is a bearer token (no cookies), so reflecting the origin does not grant access by itself.
const cors = (request) => {
  const origin = request.headers.get('origin');
  return origin
    ? {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '86400',
        vary: 'Origin',
      }
    : {};
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

async function authorized(request, env) {
  const expected = env.SYNC_TOKEN;
  if (!expected) return false;
  const header = request.headers.get('authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  // constant-time comparison of SHA-256 digests
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual
    ? crypto.subtle.timingSafeEqual(a, b)
    : new Uint8Array(a).every((x, i) => x === new Uint8Array(b)[i]);
}

const isB64 = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
const validBox = (e) => e && typeof e === 'object' && e.v === 1 && isB64(e.iv, 24) && isB64(e.ct, MAX_RECORD_BYTES);

function validRecord(r) {
  return (
    r &&
    typeof r === 'object' &&
    typeof r.id === 'string' &&
    r.id.length > 0 &&
    r.id.length <= 100 &&
    typeof r.updatedAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(r.updatedAt) &&
    validBox(r.enc)
  );
}

async function cryptoMeta(request, env) {
  if (request.method === 'POST') {
    let m;
    try {
      m = await request.json();
    } catch {
      return json({ error: 'invalid JSON' }, 400);
    }
    if (!isB64(m?.salt, 64) || !Number.isInteger(m.iterations) || m.iterations < 100000 || !validBox(m.check))
      return json({ error: 'invalid crypto metadata' }, 400);
    const value = JSON.stringify({ salt: m.salt, iterations: m.iterations, check: m.check });
    await env.DB.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('crypto', ?1)").bind(value).run();
  }
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'crypto'").first();
  return json({ meta: row ? JSON.parse(row.value) : null });
}

async function push(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  const records = Array.isArray(body?.records) ? body.records : null;
  if (!records) return json({ error: 'records[] required' }, 400);
  if (records.length > MAX_BATCH) return json({ error: `at most ${MAX_BATCH} records per request` }, 413);

  const stmt = env.DB.prepare(
    `INSERT INTO measurements (id, data, updated_at, deleted, seq)
     VALUES (?1, ?2, ?3, ?4, (SELECT COALESCE(MAX(seq), 0) + 1 FROM measurements))
     ON CONFLICT(id) DO UPDATE SET
       data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted, seq = excluded.seq
     WHERE excluded.updated_at > measurements.updated_at`,
  );
  const batch = [];
  for (const r of records) {
    if (!validRecord(r)) return json({ error: 'invalid record', id: r?.id ?? null }, 400);
    // store only the envelope, never anything else a client might send along
    const data = JSON.stringify({ id: r.id, updatedAt: r.updatedAt, deleted: r.deleted ? true : undefined, enc: r.enc });
    if (data.length > MAX_RECORD_BYTES) return json({ error: 'record too large', id: r.id }, 413);
    batch.push(stmt.bind(r.id, data, r.updatedAt, r.deleted ? 1 : 0));
  }
  if (batch.length) await env.DB.batch(batch);
  return json({ accepted: batch.length });
}

async function pull(url, env) {
  const since = Math.max(0, parseInt(url.searchParams.get('since') ?? '0', 10) || 0);
  const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit') ?? '500', 10) || 500));
  const { results } = await env.DB.prepare('SELECT data, seq FROM measurements WHERE seq > ?1 ORDER BY seq LIMIT ?2')
    .bind(since, limit + 1)
    .all();
  const more = results.length > limit;
  const page = more ? results.slice(0, limit) : results;
  return json({
    records: page.map((r) => JSON.parse(r.data)),
    cursor: page.length ? page[page.length - 1].seq : since,
    more,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const corsHeaders = cors(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
    const res = await handleApi(request, env, url);
    for (const [k, v] of Object.entries(corsHeaders)) res.headers.set(k, v);
    return res;
  },
};

async function handleApi(request, env, url) {
  if (!env.SYNC_TOKEN) return json({ error: 'SYNC_TOKEN secret is not set on the worker' }, 503);
  if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, 401);

  try {
    await ensureSchema(env);
    if (url.pathname === '/api/health' && request.method === 'GET') {
      const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM measurements WHERE deleted = 0').first();
      return json({ ok: true, records: row?.n ?? 0 });
    }
    if (url.pathname === '/api/crypto' && (request.method === 'GET' || request.method === 'POST')) return await cryptoMeta(request, env);
    if (url.pathname === '/api/sync' && request.method === 'POST') return await push(request, env);
    if (url.pathname === '/api/sync' && request.method === 'GET') return await pull(url, env);
    return json({ error: 'not found' }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: 'server error' }, 500);
  }
}
