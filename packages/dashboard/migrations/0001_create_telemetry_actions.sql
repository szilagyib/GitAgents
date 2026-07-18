CREATE TABLE IF NOT EXISTS gitagents_telemetry_actions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  action_name TEXT NOT NULL,
  started_at TEXT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS gitagents_telemetry_actions_received_idx
  ON gitagents_telemetry_actions (received_at DESC);

CREATE INDEX IF NOT EXISTS gitagents_telemetry_actions_run_idx
  ON gitagents_telemetry_actions (run_id);
