import { syncProjectLeads } from "./leads.ts";
import type { Assignment, Ask, Member, Receipt } from "../../contract-team.ts";
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
  async function sync(chief: Member, members: Member[]) {
    const { current, registrations } = await syncProjectLeads(
      runtime,
      engine,
      members,
      problem,
    );
    const memberByThread = new Map<string, Member>([
      [chief.homeThreadId!, chief],
    ]);
    for (const member of members)
      if (
        member.kind === "specialist" &&
        member.status !== "archived" &&
        member.homeThreadId
      )
        memberByThread.set(member.homeThreadId, member);
    for (const member of current.values())
      memberByThread.set(member.homeThreadId!, member);
    const projectByThread = new Map(
      registrations.map((r) => [r.threadId, r.projectId]),
    );
    const memberFor = (threadId: string | null, projectId?: string | null) =>
      memberByThread.get(threadId ?? "") ??
      current.get(projectByThread.get(threadId ?? "") ?? projectId ?? "") ??
      chief;
    const enabledAt = engine.ensureEnabledAt(chief);
    const recentSince = new Date(
      engine.now().getTime() - 24 * 3600000,
    ).toISOString();
    const tasks = [
      ...service.store.list({
        statuses: ["starting", "running", "idle", "failed"],
        limit: 1000,
      }),
      ...service.store.list({
        statuses: ["done", "cancelled"],
        updatedSince: recentSince,
        limit: 1000,
      }),
    ];
    const tasksById = new Map(tasks.map((t) => [t.id, t]));
    const historical = new Set(
      tasks
        .filter(
          (t) => t.readyAt && Date.parse(t.readyAt) <= Date.parse(enabledAt),
        )
        .map((t) => t.id),
    );
    const beforeTeam = tasks
      .filter(
        (t) =>
          historical.has(t.id) &&
          t.role !== "review" &&
          !["done", "cancelled"].includes(t.status),
      )
      .map((t) => ({
        taskId: t.id,
        title: t.title.slice(0, 200),
        threadId: t.threadId,
        readyAt: t.readyAt!,
      }));
    if (
      JSON.stringify(beforeTeam) !==
      JSON.stringify(engine.store.setting("beforeTeam", []))
    ) {
      engine.store.saveSetting("beforeTeam", beforeTeam);
      engine.changed();
    }
    // Read each Team kind once. Hidden projection copies stay available to audit/get,
    // but are no longer parsed or rewritten on every monitor sweep.
    const assignments = engine.store.list("assignment");
    const byTask = new Map<string, Assignment>();
    const memberById = new Map(members.map((m) => [m.id, m]));
    const replacement = (id: string) => {
      const member = memberById.get(id);
      return member?.kind === "project-lead"
        ? current.get(member.orchestratorProjectId ?? "")
        : undefined;
    };
    const pendingByAssignment = new Map<string, Receipt[]>();
    const memberByHome = new Map(
      members.filter((m) => m.homeThreadId).map((m) => [m.homeThreadId!, m]),
    );
    for (const receipt of engine.store.list("receipt")) {
      if (receipt.state !== "pending" || !receipt.assignmentId) continue;
      const group = pendingByAssignment.get(receipt.assignmentId) ?? [];
      group.push(receipt);
      pendingByAssignment.set(receipt.assignmentId, group);
    }
    for (let a of assignments) {
      if (
        a.id.startsWith("a_native") &&
        a.taskIds.every((id) => !tasksById.has(id) || historical.has(id))
      ) {
        guard("cloud task", a.id, () =>
          engine.updateAssignment(
            a,
            { hiddenFromTeam: true },
            "task-hidden",
            "team",
          ),
        );
        continue;
      }
      guard("assignment", a.id, () => {
        const assignee = replacement(a.assignee);
        const requester = replacement(a.requester);
        const watchers = [
          ...new Set(a.watchers.map((id) => replacement(id)?.id ?? id)),
        ];
        if (
          (assignee && assignee.id !== a.assignee) ||
          (requester && requester.id !== a.requester) ||
          JSON.stringify(watchers) !== JSON.stringify(a.watchers)
        )
          a = engine.updateAssignment(
            a,
            {
              assignee: assignee?.id ?? a.assignee,
              requester: requester?.id ?? a.requester,
              watchers,
              threadId:
                a.threadId === memberById.get(a.assignee)?.homeThreadId
                  ? (assignee?.homeThreadId ?? a.threadId)
                  : a.threadId,
            },
            "lead-synced",
            "team",
          );
        // Assignment ownership and its unsent outbox move in this same savepoint.
        // Also repair receipts left on an old home by earlier partial migrations.
        for (const receipt of pendingByAssignment.get(a.id) ?? []) {
          const old = memberByHome.get(receipt.threadId);
          const next = old ? replacement(old.id) : undefined;
          if (!next?.homeThreadId || next.homeThreadId === receipt.threadId)
            continue;
          engine.store.put(
            "receipt",
            { ...receipt, threadId: next.homeThreadId, updatedAt: engine.at() },
            0,
          );
        }
        for (const taskId of a.taskIds) byTask.set(taskId, a);
      });
    }
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
    const decisions = service.store.decisions({
      statuses: ["open"],
      limit: 1000,
    });
    const decisionsById = new Map(decisions.map((d) => [d.id, d]));
    for (const decision of decisions)
      guard("project decision", decision.id, () => {
        if (byDecision.has(decision.id)) return;
        const member = memberFor(decision.orchestratorThreadId);
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
          options: options.slice(0, 8).map((o, i) => ({
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
    for (const key of versions.keys())
      if (!tasksById.has(key)) versions.delete(key);
    for (const task of tasks) {
      if (task.role === "review" || historical.has(task.id)) continue;
      // Include the few mutable display fields in case native updates share a millisecond.
      const version = JSON.stringify([
        task.updatedAt,
        task.readyAt,
        task.status,
        task.prUrl,
        task.title,
        memberFor(task.orchestratorThreadId, task.boatProject).id,
      ]);
      if (versions.get(task.id) === version) continue;
      guard("cloud task", task.id, () => {
        const member = memberFor(task.orchestratorThreadId, task.boatProject);
        let linked = byTask.get(task.id);
        const assignmentId = "a_native" + task.id.replace(/^t_/, "");
        // A previously hidden projection may become current again when native work resumes.
        if (
          !linked &&
          engine.store
            .db()
            .prepare(
              "SELECT 1 FROM team_records WHERE kind='assignment' AND id=?",
            )
            .get(assignmentId)
        )
          linked = engine.store.get("assignment", assignmentId);
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
              hiddenFromTeam: false,
              assignee: member.id,
              threadId: member.homeThreadId,
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
    for (let ask of asks)
      guard("ask", ask.id, () => {
        const member = replacement(ask.memberId);
        if (
          member &&
          member.id !== ask.memberId &&
          ["open", "confirming", "verifying"].includes(ask.state)
        )
          ask = engine.putAsk(ask, { memberId: member.id });
        if (
          ask.taskId &&
          !["answered", "superseded", "withdrawn"].includes(ask.state)
        ) {
          const task =
            tasksById.get(ask.taskId) ?? service.store.get(ask.taskId);
          if (
            !task ||
            task.status === "cancelled" ||
            (historical.has(ask.taskId) && ask.verb === "Review") ||
            task.status === "done" ||
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
