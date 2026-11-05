-- Encrypted backup of the measurements kept in the browser.
-- `data` holds { id, updatedAt, deleted?, enc } where `enc` is AES-256-GCM
-- ciphertext produced in the browser; the server cannot read the values.
-- (The worker also creates these tables itself on first use.)
CREATE TABLE IF NOT EXISTS measurements (
  id          TEXT PRIMARY KEY,
  data        TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  seq         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_measurements_seq ON measurements (seq);

-- key-derivation salt and an encrypted passphrase check (no secrets)
CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
