-- Backup of the measurements kept in the browser. `data` holds the full record as JSON.
CREATE TABLE IF NOT EXISTS measurements (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  timestamp   TEXT NOT NULL,
  data        TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  seq         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_measurements_seq ON measurements (seq);
CREATE INDEX IF NOT EXISTS idx_measurements_timestamp ON measurements (timestamp);
