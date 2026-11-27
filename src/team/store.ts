import type Database from "better-sqlite3";
import type { z } from "zod";
import {
  memberSchema,
  assignmentSchema,
  askSchema,
  grantSchema,
  receiptSchema,
  incidentSchema,
} from "../../contract-team.ts";

// Append-only migration: no existing table or setting changes. JSON payloads are
// schema-checked on every read; record CAS and outbox creation share transactions.
export const TEAM_MIGRATIONS = [
  `
CREATE TABLE team_records (kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
CREATE TABLE team_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, assignment_id TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL);
CREATE INDEX team_events_assignment ON team_events(assignment_id,sequence);
CREATE TABLE team_settings (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE team_confirm_tokens (ask_id TEXT NOT NULL, revision INTEGER NOT NULL, hash TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY(ask_id,hash));
CREATE UNIQUE INDEX team_one_chief ON team_records(kind) WHERE kind='member' AND json_extract(body,'$.kind')='lead';
`,
];
const schemas = {
  member: memberSchema,
  assignment: assignmentSchema,
  ask: askSchema,
  grant: grantSchema,
  receipt: receiptSchema,
  incident: incidentSchema,
};
type Records = { [K in keyof typeof schemas]: z.infer<(typeof schemas)[K]> };
export class TeamStore {
  readonly db: () => Database.Database;
  constructor(db: () => Database.Database) {
    this.db = db;
  }
  private depth = 0;
  transaction<T>(run: () => T): T {
    const name = "team_tx_" + this.depth++;
    this.db().exec(`SAVEPOINT ${name}`);
    try {
      const value = run();
      this.db().exec(`RELEASE ${name}`);
      return value;
    } catch (error) {
      this.db().exec(`ROLLBACK TO ${name}`);
      this.db().exec(`RELEASE ${name}`);
      throw error;
    } finally {
      this.depth--;
    }
  }
  list<K extends keyof Records>(kind: K): Records[K][] {
    return (
      this.db()
        .prepare("SELECT body FROM team_records WHERE kind=? ORDER BY rowid")
        .all(kind) as { body: string }[]
    ).map((row) => schemas[kind].parse(JSON.parse(row.body)) as Records[K]);
  }
  get<K extends keyof Records>(kind: K, id: string): Records[K] {
    const row = this.db()
      .prepare("SELECT body FROM team_records WHERE kind=? AND id=?")
      .get(kind, id) as { body: string } | undefined;
    if (!row) throw new Error("This item is no longer available");
    return schemas[kind].parse(JSON.parse(row.body)) as Records[K];
  }
  put<K extends keyof Records>(
    kind: K,
    record: Records[K],
    expected?: number,
  ): Records[K] {
    const parsed = schemas[kind].parse(record);
    const revision = "revision" in parsed ? parsed.revision : 0;
    if (expected === undefined)
      this.db()
        .prepare(
          "INSERT INTO team_records(kind,id,revision,body) VALUES(?,?,?,?)",
        )
        .run(kind, parsed.id, revision, JSON.stringify(parsed));
    else if (
      this.db()
        .prepare(
          "UPDATE team_records SET revision=?,body=? WHERE kind=? AND id=? AND revision=?",
        )
        .run(revision, JSON.stringify(parsed), kind, parsed.id, expected)
        .changes !== 1
    )
      throw new Error("This item changed; check it again");
    return parsed as Records[K];
  }
  setting<T>(id: string, fallback: T): T {
    const row = this.db()
      .prepare("SELECT body FROM team_settings WHERE id=?")
      .get(id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : fallback;
  }
  saveSetting(id: string, value: unknown) {
    this.db()
      .prepare(
        "INSERT INTO team_settings(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(id, JSON.stringify(value));
  }
  event(
    assignmentId: string,
    kind: string,
    actor: string,
    at: string,
    data: unknown,
  ) {
    this.db()
      .prepare(
        "INSERT INTO team_events(assignment_id,kind,actor,at,body) VALUES(?,?,?,?,?)",
      )
      .run(assignmentId, kind, actor, at, JSON.stringify(data));
  }
}
