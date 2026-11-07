export const START_QUEUE_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS start_queue (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, input TEXT NOT NULL, digest TEXT NOT NULL, parent_generation TEXT, reserved_task_id TEXT NOT NULL, task_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, message TEXT NOT NULL, resets_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS start_queue_state ON start_queue(state, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS start_queue_pending_digest ON start_queue(digest) WHERE state IN ('waiting','dispatching')`,
];
