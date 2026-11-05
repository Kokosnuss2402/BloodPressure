// Cloudflare Worker: serves the web app (static assets from ./dist) and a small
// sync API that keeps a backup of the measurements in a D1 database.
//
//   GET  /api/health                 -> { ok, records }
//   POST /api/sync  { records: [] }  -> { accepted }     (upsert, last write wins)
//   GET  /api/sync?since=N&limit=M   -> { records, cursor, more }
//
// Every /api request needs "Authorization: Bearer <SYNC_TOKEN>".
// Set the secret with:  npx wrangler secret put SYNC_TOKEN

const MAX_RECORD_BYTES = 64 * 1024;
const MAX_BATCH = 500;

// Same schema as migrations/0001_init.sql, applied lazily so a fresh
// deployment works without a separate migration step.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS measurements (
     id TEXT PRIMARY KEY, type TEXT NOT NULL, timestamp TEXT NOT NULL, data TEXT NOT NULL,
     updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS idx_measurements_seq ON measurements (seq)',
  'CREATE INDEX IF NOT EXISTS idx_measurements_timestamp ON measurements (timestamp)',
];
let schemaReady = null;
function ensureSchema(env) {
  schemaReady ??= env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q))).catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

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

function validRecord(r) {
  return (
    r &&
    typeof r === 'object' &&
    typeof r.id === 'string' &&
    r.id.length > 0 &&
    r.id.length <= 100 &&
    typeof r.updatedAt === 'string' &&
    typeof r.timestamp === 'string' &&
    typeof r.type === 'string'
  );
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
    `INSERT INTO measurements (id, type, timestamp, data, updated_at, deleted, seq)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, (SELECT COALESCE(MAX(seq), 0) + 1 FROM measurements))
     ON CONFLICT(id) DO UPDATE SET
       type = excluded.type, timestamp = excluded.timestamp, data = excluded.data,
       updated_at = excluded.updated_at, deleted = excluded.deleted, seq = excluded.seq
     WHERE excluded.updated_at > measurements.updated_at`,
  );
  const batch = [];
  for (const r of records) {
    if (!validRecord(r)) return json({ error: 'invalid record', id: r?.id ?? null }, 400);
    const data = JSON.stringify(r);
    if (data.length > MAX_RECORD_BYTES) return json({ error: 'record too large', id: r.id }, 413);
    batch.push(stmt.bind(r.id, r.type, r.timestamp, data, r.updatedAt, r.deleted ? 1 : 0));
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

    if (!env.SYNC_TOKEN) return json({ error: 'SYNC_TOKEN secret is not set on the worker' }, 503);
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, 401);

    try {
      await ensureSchema(env);
      if (url.pathname === '/api/health' && request.method === 'GET') {
        const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM measurements WHERE deleted = 0').first();
        return json({ ok: true, records: row?.n ?? 0 });
      }
      if (url.pathname === '/api/sync' && request.method === 'POST') return push(request, env);
      if (url.pathname === '/api/sync' && request.method === 'GET') return pull(url, env);
      return json({ error: 'not found' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: 'server error' }, 500);
    }
  },
};
