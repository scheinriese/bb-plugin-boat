import { readTeamThread } from "./thread.ts";
import { PERSONAL_PROJECT_ID } from "../orchestrator.ts";
import { createTeamMirror } from "./mirror.ts";
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
/** Bound the cause chain without losing the HTTP/SDK error that explains setup failure. */
export function describeTeamSetupError(error: unknown): string {
  const messages: string[] = [],
    seen = new Set<unknown>();
  while (error != null && !seen.has(error) && messages.length < 4) {
    seen.add(error);
    const item = error as {
      message?: unknown;
      code?: unknown;
      status?: unknown;
      cause?: unknown;
    };
    const message =
      typeof item.message === "string" ? item.message : String(error);
    const code = typeof item.code === "string" ? ` [code=${item.code}]` : "";
    const status =
      typeof item.status === "number" ? ` [status=${item.status}]` : "";
    messages.push(message.slice(0, 500) + code + status);
    error = item.cause;
  }
  return messages.join(" <- caused by: ");
}
export function isWorkbenchProvider(value: unknown): boolean {
  if (typeof value !== "string") return false;
  // SDK provider selections use pluginId/providerId. Accept the earlier colon
  // representation and bare plugin id as well, matching the plugin id exactly.
  return value === "workbench" || value.split(/[/:]/)[0] === "workbench";
}
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
  const turnOrigins = new Map<
    string,
    { initiator: string; senderThreadId: string | null; input: string }
  >();
  let workbench = false,
    flushing: Promise<void> | null = null,
    preparing: Promise<void> | null = null;
  const mirror = createTeamMirror(runtime, engine);
  let saving: Promise<unknown> = Promise.resolve();
  function saveSerially<T>(run: () => Promise<T>): Promise<T> {
    const next = saving.then(run, run);
    saving = next.catch(() => undefined);
    return next;
  }
  async function prepare(enabling = false) {
    if (!engine.enabled() && !enabling) return;
    // A failed bootstrap requires an explicit retry, including after plugin reload.
    if (!enabling && engine.store.setting("homeSetupFailed", false)) {
      engine.store.saveSetting("enabled", false);
      engine.changed();
      return;
    }
    if (preparing) return preparing;
    preparing = (async () => {
      const preferences = await bb.sdk.system.uiPreferences
        .list()
        .catch(() => null);
      workbench = isWorkbenchProvider(
        preferences?.preferences["sidebar.threadListProvider"]?.value,
      );
      const members = engine.store.list("member");
      let chief =
        members.find((m) => m.kind === "lead") ?? engine.enable("Nora", false);
      if (chief.projectId === "personal")
        chief = engine.saveMember(chief, { projectId: PERSONAL_PROJECT_ID });
      if (!chief.homeThreadId) {
        const spawned = await bb.sdk.threads.spawn({
          projectId: PERSONAL_PROJECT_ID,
          title: chief.name,
          origin: "plugin",
          originPluginId: bb.pluginId,
          input: [
            {
              type: "text",
              text: "[team · setup] Plugin bootstrap, not a user request. Introduce yourself as the chief of staff in two or three sentences and explain how to hand you work. Do not start any work yet. [/team]",
              mentions: [],
            },
          ],
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
        chief = engine.home(chief, threadId, PERSONAL_PROJECT_ID);
      } else {
        try {
          const thread = await readTeamThread(bb, chief.homeThreadId);
          const availability = thread.available ? "available" : "unavailable";
          if (!thread.available)
            mirror.problem(
              "chief home",
              chief.id,
              new Error("The home chat is archived or deleted"),
            );
          if (
            chief.availability !== availability ||
            (thread.projectId && chief.projectId !== thread.projectId)
          )
            chief = engine.saveMember(chief, {
              projectId: thread.projectId ?? chief.projectId,
              availability,
            });
        } catch (error) {
          if (chief.availability !== "unknown")
            chief = engine.saveMember(chief, { availability: "unknown" });
          mirror.problem("chief home", chief.id, error);
        }
      }
      const at = members.findIndex((m) => m.id === chief.id);
      if (at < 0) members.push(chief);
      else members[at] = chief;
      engine.store.saveSetting("homeSetupFailed", false);
      if (enabling) engine.store.saveSetting("enabled", true);
      engine.ensureEnabledAt(chief);
      await mirror.sync(chief, members);
    })()
      .catch((error) => {
        if (!engine.chief()?.homeThreadId) {
          engine.store.saveSetting("enabled", false);
          engine.store.saveSetting("homeSetupFailed", true);
        }
        bb.log.warn(`Couldn't enable Team: ${describeTeamSetupError(error)}`);
        engine.changed();
        throw new Error(
          "Couldn't enable Team: the home chat could not be prepared. Please try again.",
          { cause: error },
        );
      })
      .finally(() => {
        preparing = null;
      });
    return preparing;
  }
  function recipientMember(threadId: string) {
    return (
      engine.store.list("member").find((m) => m.homeThreadId === threadId) ??
      engine.memberForThread(threadId)
    );
  }
  async function flush() {
    if (!engine.enabled()) return;
    if (flushing) return flushing;
    flushing = (async () => {
      // Reconcile recipients before taking a send claim, including after reload.
      await prepare();
      for (const receipt of engine.store
        .list("receipt")
        .filter((r) => r.state === "pending")) {
        if (!engine.enabled()) break;
        try {
          const thread = await readTeamThread(bb, receipt.threadId);
          if (!thread.available) continue;
        } catch (error) {
          mirror.problem("delivery recipient", receipt.threadId, error);
          continue;
        }
        // Native lookup yielded: re-read user intent and the outbox before claiming.
        const fresh = engine.store.get("receipt", receipt.id);
        if (
          !engine.enabled() ||
          fresh.state !== "pending" ||
          fresh.threadId !== receipt.threadId
        )
          continue;
        const member = recipientMember(receipt.threadId);
        if (
          member &&
          (member.status !== "active" ||
            member.pauseRequested ||
            member.availability !== "available")
        )
          continue;
        const a = receipt.assignmentId
          ? engine.store.get("assignment", receipt.assignmentId)
          : null;
        if (receipt.kind === "assignment" && a?.status === "closed") continue;
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
          const current = a ? engine.store.get("assignment", a.id) : null;
          if (receipt.kind === "assignment" && current?.status === "queued")
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
          engine.incident(
            "A team message needs delivery checked",
            a?.id ?? null,
          );
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
    teamSave: (input) =>
      saveSerially(async () => {
        if (input.rules !== undefined) core(input.rules, 350);
        if (input.standingInstructions !== undefined)
          core(input.standingInstructions, 900);
        // Validate both the pointer and native project before changing any settings.
        const adopted = input.homeThreadId
          ? await readTeamThread(bb, input.homeThreadId)
          : null;
        if (adopted && !adopted.available)
          throw new Error(
            "This home chat is archived or unavailable. Choose an available chat.",
          );
        if (input.enabled) {
          let chief = engine.chief() ?? engine.enable(input.name, false);
          // Repair the half-enabled state left by an earlier failed bootstrap.
          if (!chief.homeThreadId) engine.store.saveSetting("enabled", false);
          if (input.name)
            chief = engine.saveMember(chief, {
              name: input.name,
              avatar: { ...chief.avatar, initials: input.name.slice(0, 1) },
            });
          if (input.homeThreadId)
            chief = engine.home(chief, input.homeThreadId, adopted!.projectId!);
          if (input.standingInstructions !== undefined)
            engine.saveStanding(chief, input.standingInstructions);
          if (input.rules !== undefined) engine.saveRules(input.rules);
          try {
            await prepare(true);
            engine.store.saveSetting("enabled", true);
          } catch (error) {
            engine.store.saveSetting("enabled", false);
            engine.changed();
            throw error;
          }
        } else {
          turnOrigins.clear();
          engine.store.saveSetting("enabled", false);
        }
        engine.changed();
        return { ok: true as const };
      }),
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
          await prepare();
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
    () => engine.store.list("member").filter((m) => m.status !== "archived"),
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
      quote: z.string().trim().min(1).max(4000),
    }),
    async (v, threadId) => {
      const origin = turnOrigins.get(threadId);
      if (origin?.initiator !== "user" || origin.senderThreadId !== null)
        throw new Error(
          "Only an explicit reply in a user-started turn can answer this ask",
        );
      const ask = engine.store.get("ask", v.askId);
      if (
        ask.threadId !== threadId &&
        engine.chief()?.homeThreadId !== threadId
      )
        throw new Error("This ask is not shown in this chat");
      const outline = (await bb.sdk.threads.conversationOutline({
        threadId,
        role: "user",
      } as never)) as {
        items?: { preview?: string; senderThreadId?: string | null }[];
      };
      const latest = outline.items?.at(-1);
      if (
        turnOrigins.get(threadId) !== origin ||
        !origin.input.includes(v.quote) ||
        !latest?.preview?.includes(v.quote) ||
        latest.senderThreadId ||
        /^\[(team|boat|bb message)/.test(latest.preview)
      )
        throw new Error(
          "Quote the answer from the latest user message in this chat",
        );
      return engine.answer({ ...v, surface: "tool" }, "typed reply");
    },
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
    const member = recipientMember(context.thread.id);
    if (context.attempt === "start-turn") {
      turnOrigins.set(context.thread.id, {
        initiator: context.initiator,
        senderThreadId: context.senderThreadId,
        input: context.input.text,
      });
      engine.store.saveSetting(
        `countTurn:${context.thread.id}`,
        context.initiator === "agent" || context.initiator === "system",
      );
    }
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
    if (member && (member.pauseRequested || member.status === "paused"))
      return {
        action: "wait",
        reason: "This member is paused. Resume in Team settings to continue.",
      };
    if (
      member &&
      (member.status === "archived" || member.availability !== "available")
    )
      return {
        action: "wait",
        reason: "This team member's chat is unavailable. Delivery is waiting.",
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
    if (!engine.enabled()) return;
    const t = (payload as { thread?: { id?: string } }).thread?.id;
    if (t) {
      turnOrigins.delete(t);
      try {
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
        void flush().catch((error) => mirror.problem("delivery", t, error));
      } catch (error) {
        mirror.problem("result", t, error);
      }
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
              engine.store
                .list("member")
                .filter((m) => m.status !== "archived"),
              engine.store.list("assignment"),
              engine.store.setting("rules", ""),
            );
      return { tools: TEAM_TOOLS, instructions };
    },
  };
}
export type TeamRuntime = ReturnType<typeof createTeamRuntime>;
