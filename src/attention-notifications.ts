import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import type { TaskPublicStatus } from "./board.ts";
import type { Decision, Task } from "./store.ts";

export interface AttentionNotice { title: string; body: string; threadId: string }
export type AttentionKind = "needs-you" | "ready";
export interface AttentionNotifications {
  flush(): Promise<void>;
}

/**
 * One delivery path for explicit decisions and work that became ready.
 * Delivery is at least once: acknowledge in KV only after a channel accepted
 * it. An ambiguous transport failure can still cause a retry; the push API
 * has no idempotency key. No timers or agent messages are created here.
 */
export function createAttentionNotifications(deps: {
  kv: PluginKvStorage;
  enabled(kind?: AttentionKind): Promise<boolean>;
  decisions(): Decision[];
  tasks(): Task[];
  status(task: Task): TaskPublicStatus;
  send(notice: AttentionNotice): Promise<void>;
  failed(error: unknown): void;
  stopped?(): boolean;
}): AttentionNotifications {
  let active: Promise<void> | null = null;
  let dirty = false;

  async function scan(): Promise<void> {
    if (deps.stopped?.() || !(await deps.enabled())) return;
    const notices: { key: string; generation: string; kind: AttentionKind; notice: AttentionNotice }[] = [];
    const decisions = deps.decisions();
    for (const decision of decisions) {
      if (decision.status !== "open" || decision.orchestratorThreadId === null) continue;
      notices.push({ key: `attention:decision:${decision.id}`, generation: "open", kind: "needs-you", notice: { title: `Needs you: ${decision.question}`, body: decision.recommendation, threadId: decision.orchestratorThreadId } });
    }
    for (const task of deps.tasks()) {
      const status = deps.status(task);
      const ready = status.status === "ready";
      const problem = status.needsYou && !decisions.some((decision) => decision.status === "open" && decision.taskIds.includes(task.id));
      if (task.role === "review" || (!ready && !problem)) continue;
      const threadId = task.threadId ?? task.orchestratorThreadId;
      if (threadId === null) continue;
      notices.push({ key: `attention:${ready ? "ready" : "problem"}:${task.id}`, generation: `${task.turns}:${task.promptId ?? task.finishedAt ?? task.readyAt ?? ""}`, kind: ready ? "ready" : "needs-you", notice: { title: `${ready ? "Ready" : "Needs you"}: ${task.title}`, body: ready ? task.readyNote ?? task.prUrl ?? "Open the task to inspect the change." : status.reason ?? task.error ?? "Open the task to choose how to continue.", threadId } });
    }
    for (const { key, generation, kind, notice } of notices) {
      if (deps.stopped?.()) return;
      if (!(await deps.enabled(kind))) continue;
      try {
        if ((await deps.kv.get<string>(key)) === generation) continue;
        await deps.send(notice);
        await deps.kv.set(key, generation);
      } catch (error) {
        // A deleted source chat must not starve unrelated ready work.
        if (!deps.stopped?.()) deps.failed(error);
      }
    }
  }

  const flush = (): Promise<void> => {
    dirty = true;
    if (active !== null) return active;
    active = (async () => {
      do {
        dirty = false;
        try { await scan(); } catch (error) { if (!deps.stopped?.()) deps.failed(error); }
      } while (dirty && !deps.stopped?.());
    })().finally(() => {
      active = null;
      // A change queued between the last scan and this completion is retained.
      if (dirty && !deps.stopped?.()) void flush();
    });
    return active;
  };
  return { flush };
}
