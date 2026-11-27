import type { MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { parseTeamResult } from "./result.ts";
import { getPullRequest, mergePullRequest } from "../github.ts";
import {
  assertMergeable,
  assertMergeableTask,
  mergeGeneration,
} from "../merge-interaction.ts";
import type { PullRequestFacts } from "../../contract-merge.ts";
import { z } from "zod";
import type { Runtime } from "../runtime.ts";
import {
  teamRpcContract,
  assignmentInputSchema,
  askInputSchema,
  resultSchema,
  type Ask,
} from "../../contract-team.ts";
import { TeamEngine } from "./engine.ts";
import {
  core,
  memberInstructions,
  projectLeadInstructions,
  TEAM_TOOL_RULES,
} from "./instructions.ts";
import { parseOrchestratorProject } from "../projects.ts";
export const TEAM_TOOLS = [
  "team_directory",
  "team_board",
  "team_assign",
  "team_start",
  "team_progress",
  "team_wait",
  "team_report",
  "team_create_ask",
  "team_answer_card",
  "team_standing_read",
  "team_grant_use",
  "team_effect_report",
];
export function createTeamRuntime(runtime: Runtime) {
  const { bb, service } = runtime;
  const engine = new TeamEngine(service.store.team, () => {
    bb.rpc.experimental_invalidate(["boat:team"]);
    runtime.changed();
  });
  let workbench = false,
    flushing: Promise<void> | null = null,
    preparing: Promise<void> | null = null;
  async function prepare() {
    if (!engine.enabled()) return;
    if (preparing) return preparing;
    preparing = (async () => {
      const preferences = await bb.sdk.system.uiPreferences
        .list()
        .catch(() => null);
      workbench = JSON.stringify(preferences ?? {}).includes("workbench");
      let chief = engine.chief() ?? engine.enable();
      if (!chief.homeThreadId) {
        const spawned = await bb.sdk.threads.spawn({
          projectId: "personal",
          title: chief.name,
          input: [],
          environment: { type: "host", workspace: { type: "personal" } },
          pinned: !workbench,
        });
        const record = spawned as unknown as {
          id?: string;
          threadId?: string;
          thread?: { id: string };
        };
        const threadId = record.thread?.id ?? record.threadId ?? record.id;
        if (!threadId) throw new Error("bb did not return the home chat");
        chief = engine.home(chief, threadId);
      }
      for (const lead of service.store.orchestrators()) engine.syncLead(lead);
      for (const decision of service.store.decisions({ statuses: ["open"] })) {
        if (
          engine.store
            .list("ask")
            .some((a) => a.legacyDecisionId === decision.id)
        )
          continue;
        const member =
          engine.store
            .list("member")
            .find((m) => m.homeThreadId === decision.orchestratorThreadId) ??
          chief;
        engine.createAsk({
          memberId: member.id,
          threadId: decision.orchestratorThreadId,
          title: decision.question.slice(0, 80),
          verb: "Decide",
          unblocks: "Continuing the project work",
          context: decision.context ?? decision.question,
          options: decision.options.map((o, i) => ({
            id: String(i),
            label: o.slice(0, 100),
            effect: decision.question + "\n" + o,
            tier: "confirm",
            recommended: false,
          })),
          secondary: "Not now",
          confirmLabel: "Apply this project decision",
          legacyDecisionId: decision.id,
        });
      }
      // Reflect existing cloud work in the ledger without dispatching it again.
      for (const task of service.store
        .list({ limit: 1000 })
        .filter((t) => t.role !== "review")) {
        const linked = engine.store
          .list("assignment")
          .find((a) => a.taskIds.includes(task.id));
        const member =
          engine.store
            .list("member")
            .find((m) => m.homeThreadId === task.orchestratorThreadId) ?? chief;
        const assignmentId = "a_native" + task.id.replace(/^t_/, "");
        const merged = service.store.latestEvent(task.id, "merged");
        const done = task.status === "done" || task.status === "cancelled";
        if (!linked)
          engine.store.put("assignment", {
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
            status: done
              ? "closed"
              : task.readyAt
                ? "needs-user"
                : task.status === "failed"
                  ? "paused"
                  : task.status === "running"
                    ? "running"
                    : "waiting",
            outcome: done
              ? task.status === "cancelled"
                ? "cancelled"
                : merged
                  ? "done"
                  : "partial"
              : null,
            result: merged
              ? {
                  status: "done",
                  summary: "Pull request merged",
                  delivered: task.prUrl ?? "Pull request",
                  evidence: merged.text,
                  files: [],
                  openQuestions: "none",
                }
              : null,
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
        else if (
          linked.id === assignmentId &&
          engine.store.setting(`nativeSynced:${task.id}`, "") !== task.updatedAt
        )
          engine.updateAssignment(
            linked,
            {
              status: done
                ? "closed"
                : task.readyAt
                  ? "needs-user"
                  : task.status === "failed"
                    ? "paused"
                    : task.status === "running"
                      ? "running"
                      : "waiting",
              outcome: done
                ? task.status === "cancelled"
                  ? "cancelled"
                  : merged
                    ? "done"
                    : "partial"
                : null,
              updatedAt: task.updatedAt,
              result: merged
                ? {
                    status: "done",
                    summary: "Pull request merged",
                    delivered: task.prUrl ?? "Pull request",
                    evidence: merged.text,
                    files: [],
                    openQuestions: "none",
                  }
                : linked.result,
              lastProgress: task.readyNote,
            },
            "task-synced",
            "team",
          );
        engine.store.saveSetting(`nativeSynced:${task.id}`, task.updatedAt);
      }
      for (const task of service.store
        .list({ statuses: ["idle"], limit: 1000 })
        .filter(
          (t) =>
            t.readyAt && t.role !== "review" && t.delivery === "pr" && t.prUrl,
        )) {
        if (
          engine.store
            .list("ask")
            .some(
              (a) =>
                a.taskId === task.id &&
                (["open", "confirming", "verifying"].includes(a.state) ||
                  a.createdAt >= task.readyAt!),
            )
        )
          continue;
        const member =
          engine.store
            .list("member")
            .find((m) => m.homeThreadId === task.orchestratorThreadId) ?? chief;
        engine.createAsk({
          memberId: member.id,
          taskId: task.id,
          assignmentId:
            engine.store
              .list("assignment")
              .find((a) => a.taskIds.includes(task.id))?.id ?? null,
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
      }
      for (const ask of engine.store
        .list("ask")
        .filter((a) => a.taskId && a.state !== "answered")) {
        const task = service.store.get(ask.taskId!);
        if (
          task?.status === "done" ||
          (task && !task.readyAt && task.status !== "idle")
        )
          engine.putAsk(ask, { state: "superseded" });
      }
      // Project decisions still close in their existing store, inside the same DB.
      for (const ask of engine.store
        .list("ask")
        .filter((a) => a.legacyDecisionId && a.state === "answered")) {
        const d = service.store.decision(ask.legacyDecisionId!);
        if (d?.status === "open")
          service.store.resolveDecision(
            d.id,
            "answered",
            ask.options.find((o) => o.id === ask.answer?.option)?.label ??
              ask.answer?.text ??
              "Answered",
            true,
          );
      }
    })().finally(() => {
      preparing = null;
    });
    return preparing;
  }
  async function flush() {
    if (!engine.enabled()) return;
    if (flushing) return flushing;
    flushing = (async () => {
      for (const receipt of engine.store
        .list("receipt")
        .filter((r) => r.state === "pending")) {
        const member = engine.memberForThread(receipt.threadId);
        if (member?.status === "paused") continue;
        const a = engine.store.get("assignment", receipt.assignmentId);
        if (receipt.kind === "assignment" && a.status === "closed") continue;
        engine.store.put(
          "receipt",
          { ...receipt, state: "sending", updatedAt: engine.at() },
          0,
        );
        try {
          const sent = await bb.sdk.threads.send({
            threadId: receipt.threadId,
            mode: "queue-if-active",
            input: [{ type: "text", text: receipt.text, mentions: [] }],
          });
          engine.store.put(
            "receipt",
            {
              ...receipt,
              state: "accepted",
              delivery: JSON.stringify(sent),
              updatedAt: engine.at(),
            },
            0,
          );
          if (sent.delivery === "sent")
            engine.store.saveSetting(
              `seen:${receipt.threadId}:${receipt.nonce}`,
              true,
            );
          const current = engine.store.get("assignment", a.id);
          if (receipt.kind === "assignment" && current.status === "queued")
            engine.updateAssignment(
              current,
              {
                status: current.mode === "notify" ? "closed" : "delivered",
                outcome: current.mode === "notify" ? "done" : null,
              },
              "delivered",
              "team",
            );
        } catch {
          // Never automatically resend an ambiguous send: preserve the receipt
          // and raise a visible problem, since this host has no idempotent send.
          engine.store.put(
            "receipt",
            { ...receipt, state: "uncertain", updatedAt: engine.at() },
            0,
          );
          engine.incident("A team message needs delivery checked", a.id);
        }
      }
      engine.changed();
    })().finally(() => {
      flushing = null;
    });
    return flushing;
  }
  async function settle() {
    await prepare();
    engine.sweep();
    await flush();
  }
  bb.rpc.register(teamRpcContract, {
    teamState: async () => {
      await prepare();
      return engine.state(workbench);
    },
    teamSave: async (input) => {
      if (input.rules !== undefined) core(input.rules, 350);
      if (input.standingInstructions !== undefined)
        core(input.standingInstructions, 900);
      // Validate an adopted pointer before changing state.
      if (input.homeThreadId)
        await bb.sdk.threads.get({ threadId: input.homeThreadId });
      if (input.enabled) {
        let chief = engine.enable(input.name);
        if (input.name)
          chief = engine.saveMember(chief, {
            name: input.name,
            avatar: { ...chief.avatar, initials: input.name.slice(0, 1) },
          });
        if (input.homeThreadId) chief = engine.home(chief, input.homeThreadId);
        if (input.standingInstructions !== undefined)
          engine.saveStanding(chief, input.standingInstructions);
        if (input.rules !== undefined) engine.saveRules(input.rules);
        await prepare();
      } else engine.store.saveSetting("enabled", false);
      engine.changed();
      return { ok: true as const };
    },
    answerAsk: async (input) => {
      const result = engine.answer(input);
      if (
        result.ask.taskId &&
        result.ask.state === "answered" &&
        result.ask.answer?.option === "secondary"
      )
        service.store.update(result.ask.taskId, {
          readyAt: null,
          readyNote: null,
        });
      await settle();
      return result;
    },
    openAskConfirm: async (input) => {
      const ask = engine.store.get("ask", input.askId);
      let facts: PullRequestFacts | null = null;
      if (ask.taskId) {
        const task = service.mustGet(ask.taskId);
        assertMergeableTask(task);
        facts = await getPullRequest(task.repo!, task.prUrl!);
        assertMergeable(facts);
        engine.store.saveSetting(`merge:${ask.id}:${input.revision}`, {
          facts,
          generation: mergeGeneration(task),
        });
      }
      return { ...engine.openConfirm(input.askId, input.revision), facts };
    },
    confirmAsk: async (input) => {
      const ask = engine.store.get("ask", input.askId);
      if (!ask.taskId) {
        const result = engine.confirm(
          input.askId,
          input.revision,
          input.confirmToken,
        );
        await settle();
        return result;
      }
      const snapshot = engine.store.setting<{
        facts: PullRequestFacts;
        generation: string;
      } | null>(`merge:${ask.id}:${input.revision}`, null);
      if (!snapshot) throw new Error("Review the merge checks again");
      await service.withMergeClaim(ask.taskId, async (task) => {
        assertMergeableTask(task);
        if (mergeGeneration(task) !== snapshot.generation)
          throw new Error("The work changed; review it again");
        const facts = await getPullRequest(task.repo!, task.prUrl!);
        assertMergeable(facts);
        if (
          facts.head !== snapshot.facts.head ||
          facts.baseBranch !== snapshot.facts.baseBranch
        )
          throw new Error("The pull request changed; review it again");
        engine.confirm(input.askId, input.revision, input.confirmToken);
        try {
          await mergePullRequest(facts);
          const after = await getPullRequest(facts.repo, facts.url);
          if (after.state !== "MERGED")
            throw new Error(
              "The merge has not completed; check the pull request",
            );
          service.store.addEvent(
            task.id,
            "merged",
            `Merged PR #${facts.number} into ${facts.baseBranch}; approved HEAD ${facts.head}`,
          );
          service.store.transition(
            task.id,
            ["idle"],
            { status: "done", finishedAt: engine.at(), readyAt: null },
            { promptId: task.promptId },
          );
          engine.effectRan(
            ask.id,
            ask.memberId,
            "GitHub reports the pull request merged",
          );
        } catch (error) {
          engine.incident(
            "An approved merge needs its outcome checked",
            ask.assignmentId,
          );
          throw error;
        }
      });
      await settle();
      return engine.store.get("ask", ask.id);
    },
    cancelAskConfirm: (input) =>
      engine.cancelConfirm(input.askId, input.revision),
    resumeTeamMember: (input) => {
      engine.requireEnabled();
      engine.saveMember(engine.store.get("member", input.memberId), {
        status: "active",
      });
      engine.changed();
      return { ok: true as const };
    },
    revokeAsk: (input) => {
      engine.revoke(input.askId);
      return { ok: true as const };
    },
  });
  const actor = (threadId: string) => {
    const member = engine.memberForThread(threadId);
    if (!member || member.status !== "active")
      throw new Error("This chat is not an active team member");
    return member;
  };
  function tool<S extends z.ZodType>(
    name: string,
    description: string,
    parameters: S,
    run: (value: z.infer<S>, threadId: string) => unknown | Promise<unknown>,
  ) {
    bb.agents.registerTool({
      name,
      description,
      instructions: TEAM_TOOL_RULES,
      parameters,
      execute: async (value, ctx) => {
        try {
          actor(ctx.threadId);
          const result = await run(value, ctx.threadId);
          await flush();
          engine.changed();
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            isError: true,
          };
        }
      },
    });
  }
  tool(
    "team_directory",
    "Read the team directory: names, roles and home chats.",
    z.object({}),
    () => engine.store.list("member"),
  );
  tool(
    "team_board",
    "Read assignments, waiting asks and delivery receipts. Read before acting on a relay; never poll or sleep.",
    z.object({}),
    () => engine.state(workbench),
  );
  tool(
    "team_standing_read",
    "Read full standing instructions and shared team rules.",
    z.object({}),
    (_, threadId) => ({
      standing: actor(threadId).standingInstructions,
      rules: engine.store.setting("rules", ""),
    }),
  );
  tool(
    "team_assign",
    "Assign work, consult for advice, or notify a member. Project work goes to its project lead. Work requires doneWhen.",
    assignmentInputSchema,
    (value, threadId) => engine.assign(value, actor(threadId).id, threadId),
  );
  tool(
    "team_start",
    "Start a delivered assignment once. A duplicate start returns its current state.",
    z.object({ assignmentId: z.string() }),
    (v, t) => engine.start(v.assignmentId, actor(t).id),
  );
  tool(
    "team_progress",
    "Record one self-reported progress line. It never counts as a result.",
    z.object({ assignmentId: z.string(), text: z.string().max(400) }),
    (v, t) => engine.progress(v.assignmentId, actor(t).id, v.text),
  );
  tool(
    "team_wait",
    "Declare waiting with a reason and timeout. Never sleep or poll.",
    z.object({
      assignmentId: z.string(),
      reason: z.string().min(1).max(400),
      until: z.string().datetime(),
    }),
    (v, t) => engine.wait(v.assignmentId, actor(t).id, v.reason, v.until),
  );
  tool(
    "team_report",
    "Close an assignment with a structured result. Done work needs evidence; otherwise partial.",
    z.object({ assignmentId: z.string(), result: resultSchema }),
    (v, t) => engine.report(v.assignmentId, actor(t).id, v.result),
  );
  tool(
    "team_create_ask",
    "Ask the user a scoped question. Every risky action requires confirmation; the user may deny it.",
    askInputSchema,
    (v, t) => {
      const m = actor(t);
      if (v.memberId !== m.id) throw new Error("Ask as yourself");
      if (v.assignmentId) engine.owned(v.assignmentId, m.id);
      const result = engine.createAsk(v);
      return { ask: result, link: `ask/${result.id}` };
    },
  );
  tool(
    "team_answer_card",
    "Record an explicit typed reply to one named ask. Unrelated messages are not answers. Locked actions wait for the user's confirm; this tool never returns a token.",
    z.object({
      askId: z.string(),
      revision: z.number().int(),
      option: z.string(),
      text: z.string().max(4000),
    }),
    (v) => engine.answer({ ...v, surface: "tool" }, "typed reply"),
  );
  tool(
    "team_grant_use",
    "Consume a scoped, unexpired, single-use grant immediately before performing an approved action. Held sends cannot run early.",
    z.object({
      grantId: z.string(),
      actionClass: z.string(),
      target: z.string(),
    }),
    (v, t) => engine.useGrant(v.grantId, actor(t).id, v.actionClass, v.target),
  );
  tool(
    "team_effect_report",
    "Record observed evidence that an answered action ran. Do asks close only after this verification; never infer success from the user's answer.",
    z.object({ askId: z.string(), evidence: z.string().min(1).max(3000) }),
    (v, t) => engine.effectRan(v.askId, actor(t).id, v.evidence),
  );
  function dispatch(
    context: MessageDispatchHookContext,
  ):
    | { action: "proceed" }
    | { action: "wait"; reason: string }
    | { action: "reject"; message: string } {
    if (!engine.enabled()) return { action: "proceed" };
    const member = engine.memberForThread(context.thread.id);
    if (context.attempt === "start-turn")
      engine.store.saveSetting(
        `countTurn:${context.thread.id}`,
        context.initiator === "agent" || context.initiator === "system",
      );
    const nonces = context.input.text.match(/\bn_[a-f0-9]{16}\b/g) ?? [];
    const relaysOnly =
      nonces.length > 0 &&
      !context.input.text.replace(/\[team ·[\s\S]*?\[\/team\]/g, "").trim();
    if (
      !relaysOnly ||
      context.initiator === "user" ||
      context.initiator === "mixed"
    )
      return { action: "proceed" };
    if (member?.status === "paused")
      return {
        action: "wait",
        reason: "This member is paused. Resume in Team settings to continue.",
      };
    if (
      nonces.every((n) =>
        engine.store.setting(`seen:${context.thread.id}:${n}`, false),
      )
    )
      return {
        action: "reject",
        message: "Already delivered. Check the board for the current state.",
      };
    return { action: "proceed" };
  }
  bb.events.on("message.dispatched", (payload) => {
    if (!engine.enabled()) return;
    const text = JSON.stringify(payload.entry);
    for (const receipt of engine.store.list("receipt")) {
      if (text.includes(receipt.nonce))
        engine.store.saveSetting(
          `seen:${receipt.threadId}:${receipt.nonce}`,
          true,
        );
    }
  });
  bb.events.on("thread.idle", (payload: unknown) => {
    const t = (payload as { thread?: { id?: string } }).thread?.id;
    if (t) {
      const text = (payload as { lastAssistantText?: string })
        .lastAssistantText;
      if (text && engine.chief()?.homeThreadId === t) {
        engine.store.saveSetting(
          "chiefPreview",
          text.replace(/\s+/g, " ").slice(0, 160),
        );
        engine.changed();
      }
      const result = parseTeamResult(text ?? "");
      if (result) {
        const work = engine.store
          .list("assignment")
          .find(
            (a) =>
              a.id === result.assignmentId &&
              a.threadId === t &&
              a.status === "running",
          );
        if (work) engine.report(work.id, work.assignee, result.result);
      }
      engine.idle(t);
      void flush().catch(() => undefined);
    }
  });
  bb.events.on("thread.active", (payload: unknown) => {
    const t = (payload as { thread?: { id?: string } }).thread?.id;
    if (!t || !engine.enabled()) return;
    const counted = engine.store.setting(`countTurn:${t}`, false);
    engine.store.saveSetting(`countTurn:${t}`, false);
    if (!counted) return;
    for (const a of engine.store
      .list("assignment")
      .filter((a) => a.threadId === t && a.status === "running")) {
      const turns = a.turns + 1;
      if (turns > a.maxTurns || a.deadline <= engine.at()) {
        engine.updateAssignment(
          a,
          { status: "closed", outcome: "expired" },
          "expired",
          "team",
        );
        engine.incident("Work reached its budget", a.id);
      } else engine.updateAssignment(a, { turns }, "turn", "team");
    }
  });
  // Interrupted sends stay visible after restart; never claim a delivery.
  if (engine.enabled())
    for (const r of engine.store
      .list("receipt")
      .filter((r) => r.state === "sending")) {
      engine.store.put("receipt", { ...r, state: "uncertain" }, 0);
      engine.incident("A team message needs delivery checked", r.assignmentId);
    }
  return {
    engine,
    dispatch,
    prepare,
    flush,
    settle,
    get workbench() {
      return workbench;
    },
    configure(
      threadId: string,
      metadata: Record<string, unknown>,
      tasksBeforeAsking: number,
    ) {
      const member = engine.memberForThread(threadId);
      if (!member) return null;
      const chief = engine.chief()!;
      const instructions =
        member.kind === "project-lead"
          ? projectLeadInstructions({
              member,
              chief,
              project: parseOrchestratorProject(metadata.project),
              tasksBeforeAsking,
              goal: !!metadata.continuationGoal,
              rules: engine.store.setting("rules", ""),
            })
          : memberInstructions(
              member,
              chief,
              engine.store.list("member"),
              engine.store.list("assignment"),
              engine.store.setting("rules", ""),
            );
      return { tools: TEAM_TOOLS, instructions };
    },
  };
}
export type TeamRuntime = ReturnType<typeof createTeamRuntime>;
