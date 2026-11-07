import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { QueuedStartDto } from "../contract-start-queue.ts";
import { MACHINE_TYPES } from "./boat-api.ts";
import { newTaskId, type Task } from "./store.ts";
import type { StartTaskInput } from "./service.ts";
import { TIERS } from "./tiers.ts";

const text = (max = 200) => z.string().max(max).nullable().optional();
const projectSchema = z.object({
  id: z.string().min(1).max(200), name: z.string().min(1).max(200), repos: z.array(z.object({ repo: z.string().max(200), baseBranch: z.string().max(200) })).min(1).max(8),
  environment: text(), snapshot: text(), protocolPath: text(300), workerMode: z.enum(["boat", "chat"]), delivery: z.enum(["pr", "push"]),
  protectedBranches: z.array(z.string().max(200)).max(50), instructions: z.string().max(10_000), source: z.enum(["boat", "local"]), bbProjectId: text(), reviewer: z.enum(["claude", "codex", "none"]).nullable().optional(),
});
/** No closures/signals/internal launch capabilities may cross the durable boundary. */
export const queuedInputSchema = z.object({
  title: z.string().trim().min(1).max(200), compactTitle: text(120), role: z.enum(["implement", "review", "custom"]), brief: z.string().trim().min(1).max(100_000),
  repo: text(), branch: text(), baseBranch: text(), pr: text(1000), provider: z.enum(["claude", "codex"]).nullable().optional(), model: text(), reasoningEffort: text(40),
  tier: z.enum(TIERS).nullable().optional(), reason: text(4000), userApproved: z.boolean().optional(), flexibleAgent: z.boolean().optional(),
  sandbox: text(), machineType: z.enum(MACHINE_TYPES).nullable().optional(), parentTaskId: text(), orchestratorThreadId: text(), projectId: text(),
  project: projectSchema.nullable().optional(), environment: text(), snapshot: text(), runner: z.enum(["boat", "chat"]).nullable().optional(),
  confirmUntrustedChat: z.array(z.string().max(200)).max(20).nullable().optional(), evidence: z.boolean().optional(), measureMemory: z.boolean().optional(),
}).strict();
export type QueuedInput = z.infer<typeof queuedInputSchema>;
export function durableStartInput(input: StartTaskInput): QueuedInput {
  const { signal: _signal, nativeReview: _review, queuedStart: _queued, ...plain } = input;
  if (_review || _queued) throw new Error("Internal review/queued launches cannot be enqueued again.");
  return queuedInputSchema.parse(plain);
}
export function queueDigest(value: unknown): string {
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,x]) => [k,sorted(x)])) : v;
  return createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex");
}
export interface QueuedStart { dto: QueuedStartDto; input: QueuedInput; digest: string; parentGeneration: string | null; reservedTaskId: string }
export class StartQueueStore {
  private readonly db: () => Database.Database;
  constructor(db: () => Database.Database) { this.db = db; }
  private decode(row: Record<string, unknown>): QueuedStart {
    const input = queuedInputSchema.parse(JSON.parse(String(row.input)));
    if (queueDigest({ input, parentGeneration: row.parent_generation }) !== row.digest) throw new Error("Queued request data changed. Cancel it and request the work again.");
    return { input, digest: String(row.digest), parentGeneration: row.parent_generation as string | null, reservedTaskId: String(row.reserved_task_id), dto: {
      id: String(row.id), revision: Number(row.revision), state: row.state as QueuedStartDto["state"], title: input.title,
      threadId: input.orchestratorThreadId ?? null, parentTaskId: input.parentTaskId ?? null, taskId: row.task_id as string | null,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), message: String(row.message), resetsAt: row.resets_at as string | null, requestedProvider: input.provider ?? null,
    } };
  }
  get(id: string): QueuedStart | null { const row = this.db().prepare("SELECT * FROM start_queue WHERE id=?").get(id) as Record<string, unknown> | undefined; return row ? this.decode(row) : null; }
  list(includeFinished = false): QueuedStart[] { return (this.db().prepare(`SELECT * FROM start_queue ${includeFinished ? "ORDER BY updated_at DESC,id" : "WHERE state IN ('waiting','dispatching') ORDER BY created_at,id"} LIMIT 200`).all() as Record<string, unknown>[]).map(row => this.decode(row)); }
  pending(input: QueuedInput, parentGeneration: string | null): QueuedStart | null {
    const row = this.db().prepare("SELECT * FROM start_queue WHERE digest=? AND state IN ('waiting','dispatching')").get(queueDigest({ input, parentGeneration })) as Record<string, unknown> | undefined;
    return row ? this.decode(row) : null;
  }
  enqueue(input: QueuedInput, parentGeneration: string | null, message: string, resetsAt: string | null): QueuedStart {
    const digest = queueDigest({ input, parentGeneration });
    const existing = this.pending(input, parentGeneration);
    if (existing) return existing;
    if (this.list().length >= 100) throw new Error("The waiting-work queue is full. Cancel an existing request first.");
    const id = `qs_${randomUUID()}`, now = new Date().toISOString();
    this.db().prepare("INSERT INTO start_queue(id,state,input,digest,parent_generation,reserved_task_id,created_at,updated_at,message,resets_at) VALUES (?,'waiting',?,?,?,?,?,?,?,?)").run(id, JSON.stringify(input), digest, parentGeneration, newTaskId(), now, now, message.slice(0,1000), resetsAt);
    // Finished receipts are bounded; live entries are never removed.
    this.db().prepare("DELETE FROM start_queue WHERE id IN (SELECT id FROM start_queue WHERE state IN ('started','failed','cancelled') ORDER BY updated_at DESC LIMIT -1 OFFSET 1000)").run();
    return this.get(id)!;
  }
  transition(id: string, revision: number, from: QueuedStartDto["state"][], to: QueuedStartDto["state"], message: string, resetsAt: string | null = null): QueuedStart | null {
    const result = this.db().prepare(`UPDATE start_queue SET state=?,revision=revision+1,updated_at=?,message=?,resets_at=? WHERE id=? AND revision=? AND state IN (${from.map(()=>"?").join(",")})`).run(to, new Date().toISOString(), message.slice(0,1000), resetsAt, id, revision, ...from);
    return result.changes ? this.get(id) : null;
  }
  /** The queue receipt and actual registry insertion share one synchronous DB transaction. */
  attach(entry: QueuedStart, task: Task, insert: () => Task): Task {
    const db = this.db(); db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(entry.dto.id);
      if (!current || current.dto.state !== "dispatching" || current.dto.revision !== entry.dto.revision || current.digest !== entry.digest || task.id !== current.reservedTaskId) throw new Error("Queued start changed before task creation.");
      const saved = insert();
      db.prepare("UPDATE start_queue SET state='started',task_id=?,revision=revision+1,updated_at=?,message=? WHERE id=?").run(task.id, new Date().toISOString(), `Started task ${task.id}.`, entry.dto.id);
      db.exec("COMMIT"); return saved;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
}
