/** The any-chat recovery's once-per-failed-turn records, keyed by thread and turn (src/chat-recovery.ts). */
export const CHAT_RECOVERY_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS chat_recoveries (thread_id TEXT NOT NULL, turn_key TEXT NOT NULL, state TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (thread_id, turn_key))`,
  // The failed turn moved a Codex goal from active to blocked: resume it once the recovery turn ends.
  `ALTER TABLE chat_recoveries ADD COLUMN resume_goal INTEGER NOT NULL DEFAULT 0`,
];
