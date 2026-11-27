import type { Assignment, Ask, Member } from "../../contract-team.ts";
import type { Runtime } from "../runtime.ts";
import type { TeamEngine } from "./engine.ts";

/** The monitor and Team actions mirror native records. Sidebar reads never do. */
export function createTeamMirror(runtime: Runtime, engine: TeamEngine) {
  const { service, bb } = runtime;
  const versions = new Map<string, string>();
  const reported = new Set<string>();
  function problem(kind: string, key: string, error: unknown) {
    const fingerprint = `${kind}:${key}`;
    if (reported.has(fingerprint)) return;
    reported.add(fingerprint);
    bb.log.warn(
      `Team ${kind} mirror failed (${error instanceof Error ? error.name : "Error"})`,
    );
    try {
      engine.incident(
        `A ${kind} could not be shown in Team. The original work is still available in Cloud work and activity.`,
        null,
      );
      engine.changed();
    } catch {
      /* A damaged Team record must not disable native orchestration. */
    }
  }
  engine.store.onInvalid = (kind, id, error) => problem(kind, id, error);
  function guard(kind: string, key: string, run: () => void) {
    try {
      engine.store.transaction(run);
    } catch (error) {
      problem(kind, key, error);
    }
  }
  function sync(chief: Member, members: Member[]) {
    // One scan of each Team kind, indexed once. Newly created records join the indexes.
    const memberByThread = new Map(
      members.filter((m) => m.homeThreadId).map((m) => [m.homeThreadId!, m]),
    );
    const assignments = engine.store.list("assignment");
    const byTask = new Map<string, Assignment>();
    for (const a of assignments)
      for (const taskId of a.taskIds) byTask.set(taskId, a);
    const asks = engine.store.list("ask");
    const byDecision = new Map(
      asks
        .filter((a) => a.legacyDecisionId)
        .map((a) => [a.legacyDecisionId!, a]),
    );
    const asksByTask = new Map<string, Ask[]>();
    for (const ask of asks)
      if (ask.taskId) {
        const group = asksByTask.get(ask.taskId) ?? [];
        group.push(ask);
        asksByTask.set(ask.taskId, group);
      }
    for (const lead of service.store.orchestrators())
      guard("project lead", lead.threadId, () => {
        if (!memberByThread.has(lead.threadId)) {
          const member = engine.syncLead(lead, members);
          members.push(member);
          memberByThread.set(lead.threadId, member);
        }
      });
    const decisions = service.store.decisions({
      statuses: ["open"],
      limit: 1000,
    });
    const decisionsById = new Map(decisions.map((d) => [d.id, d]));
    for (const decision of decisions)
      guard("project decision", decision.id, () => {
        if (byDecision.has(decision.id)) return;
        const member =
          memberByThread.get(decision.orchestratorThreadId ?? "") ?? chief;
        const options = decision.options.length
          ? decision.options
          : [decision.recommendation.trim() || "Answer in your own words"];
        const ask = engine.createAsk({
          memberId: member.id,
          threadId: decision.orchestratorThreadId,
          title:
            decision.question.trim().slice(0, 80) ||
            "Answer this project question",
          verb: "Decide",
          unblocks: "Continuing the project work",
          context: decision.context ?? decision.question,
          options: options
            .slice(0, 8)
            .map((o, i) => ({
              id:
                !decision.options.length && !decision.recommendation.trim()
                  ? "free-text"
                  : String(i),
              label: o.trim().slice(0, 100) || "Answer in your own words",
              effect: (decision.question + "\n" + o).slice(0, 4000),
              tier: "confirm",
              recommended: false,
            })),
          secondary: "Not now",
          confirmLabel: "Apply this project decision",
          legacyDecisionId: decision.id,
        });
        asks.push(ask);
        byDecision.set(decision.id, ask);
      });
    const tasks = service.store.list({ limit: 1000 });
    const tasksById = new Map(tasks.map((t) => [t.id, t]));
    for (const key of versions.keys())
      if (!tasksById.has(key)) versions.delete(key);
    for (const task of tasks) {
      if (task.role === "review") continue;
      // Include the few mutable display fields in case native updates share a millisecond.
      const version = JSON.stringify([
        task.updatedAt,
        task.readyAt,
        task.status,
        task.prUrl,
        task.title,
      ]);
      if (versions.get(task.id) === version) continue;
      guard("cloud task", task.id, () => {
        const member =
          memberByThread.get(task.orchestratorThreadId ?? "") ?? chief;
        let linked = byTask.get(task.id);
        const assignmentId = "a_native" + task.id.replace(/^t_/, "");
        const merged = service.store.latestEvent(task.id, "merged");
        const done = task.status === "done" || task.status === "cancelled";
        const status = done
          ? "closed"
          : task.readyAt
            ? "needs-user"
            : task.status === "failed"
              ? "paused"
              : task.status === "running"
                ? "running"
                : "waiting";
        const outcome = done
          ? task.status === "cancelled"
            ? "cancelled"
            : merged
              ? "done"
              : "partial"
          : null;
        const result = merged
          ? {
              status: "done" as const,
              summary: "Pull request merged",
              delivered: task.prUrl ?? "Pull request",
              evidence: merged.text,
              files: [],
              openQuestions: "none",
            }
          : (linked?.result ?? null);
        if (!linked)
          linked = engine.store.put("assignment", {
            id: assignmentId,
            rootId: assignmentId,
            parentId: null,
            depth: 0,
            origin: { kind: "user", id: "user", source: "Harbormaster task" },
            requester: chief.id,
            assignee: member.id,
            watchers: [],
            mode: "work",
            title: task.title.slice(0, 120),
            brief: task.brief.slice(0, 12000) || task.title,
            doneWhen: "Task result with evidence and owner review",
            dedupeKey: null,
            wallHours: 72,
            status,
            outcome,
            result,
            lastProgress: task.readyNote,
            taskIds: [task.id],
            decisionIds: [],
            threadId: member.homeThreadId,
            continues: 0,
            turns: task.turns,
            maxTurns: 1000,
            treeTurnLimit: 1000,
            waitUntil: null,
            deadline: new Date(
              Date.parse(task.createdAt) + 72 * 3600000,
            ).toISOString(),
            revision: 0,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
          });
        else if (linked.id === assignmentId)
          linked = engine.updateAssignment(
            linked,
            {
              status,
              outcome,
              result,
              turns: task.turns,
              lastProgress: task.readyNote,
            },
            "task-synced",
            "team",
          );
        byTask.set(task.id, linked);
        if (
          task.status === "idle" &&
          task.readyAt &&
          task.delivery === "pr" &&
          task.prUrl
        ) {
          const previous = asksByTask.get(task.id) ?? [];
          if (
            !previous.some(
              (a) =>
                ["open", "confirming", "verifying"].includes(a.state) ||
                a.createdAt >= task.readyAt!,
            )
          ) {
            const ask = engine.createAsk({
              memberId: member.id,
              taskId: task.id,
              assignmentId: linked.id,
              threadId: task.threadId,
              title: ("Review and merge " + task.title).slice(0, 80),
              verb: "Review",
              unblocks: "Shipping the finished work",
              context: task.readyNote ?? task.title,
              options: [
                {
                  id: "merge",
                  label: "Merge",
                  effect: `Merge the pull request into ${task.baseBranch ?? "its base branch"}. It can't be undone.`,
                  tier: "confirm",
                },
              ],
              secondary: "Send back",
              confirmLabel: "Merge the pull request",
            });
            asks.push(ask);
            previous.push(ask);
            asksByTask.set(task.id, previous);
          }
        }
        versions.set(task.id, version);
      });
    }
    for (const ask of asks)
      guard("ask", ask.id, () => {
        if (
          ask.taskId &&
          !["answered", "superseded", "withdrawn"].includes(ask.state)
        ) {
          const task = tasksById.get(ask.taskId);
          if (
            task?.status === "done" ||
            (task && !task.readyAt && task.status !== "idle")
          )
            engine.putAsk(ask, { state: "superseded" });
        }
        if (!ask.legacyDecisionId) return;
        const decision =
          decisionsById.get(ask.legacyDecisionId) ??
          service.store.decision(ask.legacyDecisionId);
        if (!decision || decision.status !== "open") {
          if (["open", "confirming", "verifying"].includes(ask.state))
            engine.putAsk(ask, { state: "superseded" });
          return;
        }
        if (ask.state !== "answered") return;
        // Closing and writing the outbox share a transaction. Restarting cannot lose
        // the relay or enqueue another answer for this decision.
        if (decision.orchestratorThreadId)
          engine.queueDecisionAnswer(ask, decision.orchestratorThreadId);
        const answer =
          ask.answer?.text.trim() ||
          ask.options.find((o) => o.id === ask.answer?.option)?.label ||
          "Answered";
        service.store.resolveDecision(decision.id, "answered", answer, true);
      });
  }
  return { sync, problem };
}
