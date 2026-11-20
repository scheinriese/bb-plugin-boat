/** Chats stopped at a usage limit, and the once-per-stopped-turn paid Claude resumes (src/paid-resume.ts). */
export const PAID_RESUME_MIGRATIONS = [
  // A Claude Code chat's turn failed on a rate limit: a candidate until it moves on or is resumed.
  `CREATE TABLE IF NOT EXISTS paid_resume_stops (thread_id TEXT PRIMARY KEY, request_id TEXT, at TEXT NOT NULL)`,
  // One automatic resume per thread and stopped turn (turn_key: the request a retry chain started from).
  `CREATE TABLE IF NOT EXISTS paid_resumes (thread_id TEXT NOT NULL, turn_key TEXT NOT NULL, how TEXT NOT NULL, state TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (thread_id, turn_key))`,
  // A resume that failed may be tried again a few times (MAX_ATTEMPTS), after the pass's backoff.
  `ALTER TABLE paid_resumes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1`,
  // The pass's pacing that must outlive a restart: its backoff after a failure, and the hold on waking machines.
  `CREATE TABLE IF NOT EXISTS paid_resume_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // The failed request a chat's try re-submitted: a try is repeated only while that request is still the failed one.
  `ALTER TABLE paid_resumes ADD COLUMN request_id TEXT`,
];
