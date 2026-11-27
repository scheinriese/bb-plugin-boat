import { strictTeamSpawn } from "./team-spawn.ts";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { makeService } from "./fakes.ts";
import { createTeamRuntime, isWorkbenchProvider } from "../src/team/runtime.ts";
import { registerTools } from "../src/tools.ts";
import { buildCli } from "../src/cli.ts";
import { fidelityHandlers } from "../src/rpc-fidelity.ts";
import type { Runtime } from "../src/runtime.ts";
import type { Ask, TeamState } from "../contract-team.ts";
import {
  projectLeadInstructions,
  CONSENT,
  GOAL_LINE,
} from "../src/team/instructions.ts";
import {
  teamTime,
  teamDue,
  answerSurface,
  receiptState,
} from "../lib/team-copy.ts";

function setup(t: { after(fn: () => unknown): void }) {
  const env = makeService();
  const { bb, harness } = createFakePluginHost({ pluginId: "boat" });
  t.after(() => harness.lifecycle.dispose());
  const sent: { threadId: string; input: { text: string }[] }[] = [];
  harness.sdk.stub("system.uiPreferences.list", async () => ({
    preferences: {
      "sidebar.threadListProvider": { value: "builtin", revision: 1 },
    },
  }));
  harness.sdk.stub("threads.spawn", strictTeamSpawn(async () => ({
    thread: { id: "home-chief" },
  })));
  harness.sdk.stub("threads.send", async (input) => {
    sent.push(input as never);
    return { delivery: "sent" };
  });
  const runtime = {
    bb,
    service: env.service,
    changed() {},
  } as unknown as Runtime;
  const team = createTeamRuntime(runtime);
  runtime.team = team;
  return { ...env, bb, harness, runtime, team, sent, db: env.store.team.db() };
}
const isError = (result: unknown) =>
  typeof result === "object" &&
  result !== null &&
  (result as { isError?: boolean }).isError === true;

test("optionless decisions and bad records cannot break enable, Team state, sidebar or other work", async (t) => {
  const e = setup(t);
  const empty = e.store.addDecision({
    question: "What should happen next?",
    recommendation: "",
    options: [],
    taskIds: [],
    orchestratorThreadId: "lead-chat",
  });
  const recommended = e.store.addDecision({
    question: "Which route should we choose?",
    recommendation: "Take the coastal route",
    options: [],
    taskIds: [],
    orchestratorThreadId: "lead-chat",
  });
  await e.harness.behavior.callRpc("teamSave", { enabled: true });
  let state = (await e.harness.behavior.callRpc(
    "teamState",
    null,
  )) as TeamState;
  assert.equal(
    state.asks.find((a) => a.legacyDecisionId === empty.id)?.options[0].label,
    "Answer in your own words",
  );
  assert.equal(
    state.asks.find((a) => a.legacyDecisionId === recommended.id)?.options[0]
      .label,
    "Take the coastal route",
  );
  e.store.addDecision({
    question: "q".repeat(13000),
    recommendation: "A",
    options: ["A"],
    taskIds: [],
    orchestratorThreadId: "lead-chat",
  });
  // Simulate damaged source data and an invalid persisted Team row independently.
  e.store.addDecision({
    question: "Malformed choice",
    recommendation: "A",
    options: ["x".repeat(200)],
    taskIds: [],
    orchestratorThreadId: "lead-chat",
  });
  e.db
    .prepare(
      "INSERT INTO tasks(id,title,brief,role,status,provider,created_at,updated_at) VALUES('t_bad','Bad date','Brief','implement','running','codex','bad date','bad date')",
    )
    .run();
  e.db
    .prepare(
      "INSERT INTO team_records(kind,id,revision,body) VALUES('ask','broken',0,'{}')",
    )
    .run();
  await e.team.prepare();
  await e.team.prepare();
  state = (await e.harness.behavior.callRpc("teamState", null)) as TeamState;
  assert.ok(
    state.incidents.some((i) => i.title.includes("could not be shown")),
  );
  assert.ok(state.asks.some((a) => a.legacyDecisionId === empty.id));
  assert.ok(e.team.engine.sidebar());
  // Full native mirroring is never part of a Workbench poll.
  e.team.prepare = async () => {
    throw new Error("Sidebar must not prepare");
  };
  assert.ok(
    (await fidelityHandlers(e.runtime).sidebarState({ version: 1 })).team,
  );
});

test("Team decision answers are durably queued once and relayed with provenance; uncertain sends are visible", async (t) => {
  const e = setup(t);
  await e.harness.behavior.callRpc("teamSave", { enabled: true });
  const d = e.store.addDecision({
    question: "Choose a direction",
    recommendation: "North",
    options: ["North"],
    taskIds: [],
    orchestratorThreadId: "lead-chat",
  });
  await e.team.prepare();
  const ask = e.team.engine.store
    .list("ask")
    .find((a) => a.legacyDecisionId === d.id)!;
  const pending = (await e.harness.behavior.callRpc("answerAsk", {
    askId: ask.id,
    revision: ask.revision,
    option: "0",
    text: "Go north",
    surface: "today",
  })) as { ask: Ask };
  const token = (await e.harness.behavior.callRpc("openAskConfirm", {
    askId: ask.id,
    revision: pending.ask.revision,
  })) as { confirmToken: string };
  await e.harness.behavior.callRpc("confirmAsk", {
    askId: ask.id,
    revision: pending.ask.revision,
    confirmToken: token.confirmToken,
  });
  assert.equal(e.store.decision(d.id)?.answer, "Go north");
  assert.equal(e.sent.length, 1);
  assert.equal(e.sent[0].threadId, "lead-chat");
  assert.match(e.sent[0].input[0].text, /Go north/);
  assert.match(e.sent[0].input[0].text, /Provenance: unverified tap/);
  assert.ok(e.sent[0].input[0].text.includes(CONSENT));
  await e.team.settle();
  assert.equal(e.sent.length, 1);
  const second = e.store.addDecision({
    question: "Choose again",
    recommendation: "South",
    options: [],
    taskIds: [],
    orchestratorThreadId: "lead-chat",
  });
  await e.team.prepare();
  const k = e.team.engine.store
    .list("ask")
    .find((a) => a.legacyDecisionId === second.id)!;
  const chosen = e.team.engine.answer(
    {
      askId: k.id,
      revision: k.revision,
      option: "0",
      text: "South please",
      surface: "tool",
    },
    "typed reply",
  ).ask;
  const ct = e.team.engine.openConfirm(chosen.id, chosen.revision);
  e.team.engine.confirm(chosen.id, chosen.revision, ct.confirmToken);
  e.harness.sdk.stub("threads.send", async () => {
    throw new Error("connection lost");
  });
  await e.team.settle();
  const receipt = e.team.engine.store
    .list("receipt")
    .find((r) => r.text.includes("South please"));
  assert.equal(receipt?.state, "uncertain");
  assert.match(receipt!.text, /typed reply/);
  assert.ok(e.team.engine.store.list("incident").length);
});

test("native needs-you, resolve and CLI withdraw keep working with Team on and off", async (t) => {
  const e = setup(t);
  registerTools(e.runtime);
  e.bb.cli.register(buildCli(e.runtime));
  for (const enabled of [true, false]) {
    await e.harness.behavior.callRpc("teamSave", { enabled });
    const result = await e.harness.callAgentTool(
      "boat_needs_you",
      { question: "Which route should we take?", recommendation: "North" },
      { threadId: "lead-chat" },
    );
    assert.ok(!isError(result));
    const d = e.store.decisions({ statuses: ["open"] })[0];
    await e.team.prepare();
    const ask = e.team.engine.store
      .list("ask")
      .find((a) => a.legacyDecisionId === d.id);
    if (ask) {
      const pending = e.team.engine.answer({
        askId: ask.id,
        revision: ask.revision,
        option: "0",
        text: "",
        surface: "today",
      }).ask;
      e.team.engine.openConfirm(pending.id, pending.revision);
    }
    const resolved = await e.harness.callAgentTool(
      "boat_resolve",
      { decision_id: d.id, answer: "North" },
      { threadId: "lead-chat" },
    );
    assert.ok(!isError(resolved));
    assert.equal(e.store.decision(d.id)?.status, "answered");
    if (ask) {
      assert.equal(e.team.engine.store.get("ask", ask.id).state, "superseded");
      assert.equal(
        (
          e.db
            .prepare(
              "SELECT count(*) AS n FROM team_confirm_tokens WHERE ask_id=?",
            )
            .get(ask.id) as { n: number }
        ).n,
        0,
      );
    }
    const withdraw = e.store.addDecision({
      question: "No longer needed?",
      recommendation: "Cancel",
      options: [],
      taskIds: [],
      orchestratorThreadId: "lead-chat",
    });
    await e.team.prepare();
    const cli = await e.harness.runCli([
      "decision",
      "resolve",
      withdraw.id,
      "--withdrawn",
      "--json",
    ]);
    assert.equal(cli.exitCode, 0);
    assert.equal(e.store.decision(withdraw.id)?.status, "withdrawn");
    const mirrored = e.team.engine.store
      .list("ask")
      .find((a) => a.legacyDecisionId === withdraw.id);
    if (mirrored) assert.equal(mirrored.state, "superseded");
  }
});

test("800-task steady-state mirroring stays below 100 ms, lists each kind once and writes no unchanged tasks", async (t) => {
  const e = setup(t);
  await e.harness.behavior.callRpc("teamSave", { enabled: true });
  const insert = e.db.prepare(
    "INSERT INTO tasks(id,title,brief,role,status,provider,created_at,updated_at) VALUES(?,?,?,'implement','running','codex','2026-11-26T08:00:00Z','2026-11-26T08:00:00Z')",
  );
  for (let i = 0; i < 800; i++) insert.run(`t_perf${i}`, `Task ${i}`, "Brief");
  await e.team.prepare();
  const events = e.db
    .prepare("SELECT count(*) AS n FROM team_events")
    .get() as { n: number };
  const calls = new Map<string, number>();
  const list = e.team.engine.store.list.bind(e.team.engine.store);
  e.team.engine.store.list = (kind) => {
    calls.set(kind, (calls.get(kind) ?? 0) + 1);
    return list(kind);
  };
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    calls.clear();
    const start = performance.now();
    await e.team.prepare();
    samples.push(performance.now() - start);
    assert.equal(calls.get("member"), 1);
    assert.equal(calls.get("assignment"), 1);
    assert.equal(calls.get("ask"), 1);
  }
  t.diagnostic(
    `800 tasks, steady-state ms: ${samples.map((n) => n.toFixed(1)).join(", ")}`,
  );
  assert.ok(
    Math.min(...samples) < 100,
    `Steady-state took ${Math.min(...samples)} ms`,
  );
  assert.equal(
    (
      e.db.prepare("SELECT count(*) AS n FROM team_events").get() as {
        n: number;
      }
    ).n,
    events.n,
  );
  e.db
    .prepare(
      "UPDATE tasks SET updated_at='2026-11-26T09:00:00Z' WHERE id='t_perf0'",
    )
    .run();
  await e.team.prepare();
  assert.equal(
    (
      e.db.prepare("SELECT count(*) AS n FROM team_events").get() as {
        n: number;
      }
    ).n,
    events.n + 1,
  );
});

test("typed answers require a current user initiator, no sender, the right thread and a quote in the latest message", async (t) => {
  const e = setup(t);
  await e.harness.behavior.callRpc("teamSave", { enabled: true });
  e.team.engine.syncLead({
    threadId: "lead-chat",
    projectId: "web",
    projectName: "Web",
  });
  e.team.engine.syncLead({
    threadId: "other-chat",
    projectId: "docs",
    projectName: "Docs",
  });
  const chief = e.team.engine.chief()!;
  const k = e.team.engine.createAsk({
    memberId: chief.id,
    threadId: "lead-chat",
    title: "Continue the work?",
    verb: "Decide",
    unblocks: "Continuing",
    options: [
      { id: "yes", label: "Continue", effect: "Continue", tier: "contained" },
    ],
    secondary: "Not now",
  });
  let latest = "Yes, continue";
  e.harness.sdk.stub("threads.conversationOutline", async () => ({
    items: [{ preview: "An earlier yes" }, { preview: latest }],
  }));
  const args = {
    askId: k.id,
    revision: k.revision,
    option: "yes",
    text: "Yes",
    quote: "Yes, continue",
  };
  const dispatch = (
    threadId: string,
    initiator: "user" | "agent" | "mixed" = "user",
    senderThreadId: string | null = null,
  ) =>
    e.team.dispatch(
      makeMessageDispatchHookContext({
        thread: makeThreadResponse({ id: threadId }),
        initiator,
        senderThreadId,
        input: { text: "Yes, continue", blocks: [] },
      }),
    );
  for (const [thread, initiator, sender] of [
    ["lead-chat", "agent", null],
    ["lead-chat", "mixed", null],
    ["lead-chat", "user", "remote-thread"],
    ["other-chat", "user", null],
  ] as const) {
    dispatch(thread, initiator, sender);
    assert.ok(
      isError(
        await e.harness.callAgentTool("team_answer_card", args, {
          threadId: thread,
        }),
      ),
    );
    assert.equal(e.team.engine.store.get("ask", k.id).state, "open");
  }
  await assert.rejects(() =>
    e.harness.callAgentTool(
      "team_answer_card",
      { ...args, quote: undefined },
      { threadId: "lead-chat" },
    ),
  );
  dispatch("lead-chat");
  assert.ok(
    isError(
      await e.harness.callAgentTool(
        "team_answer_card",
        { ...args, quote: "Not in the message" },
        { threadId: "lead-chat" },
      ),
    ),
  );
  latest = "Unrelated new message";
  assert.ok(
    isError(
      await e.harness.callAgentTool("team_answer_card", args, {
        threadId: "lead-chat",
      }),
    ),
  );
  latest = "Yes, continue";
  dispatch("home-chief");
  assert.ok(
    !isError(
      await e.harness.callAgentTool("team_answer_card", args, {
        threadId: "home-chief",
      }),
    ),
  );
  assert.equal(
    e.team.engine.store.get("ask", k.id).answer?.provenance,
    "typed reply",
  );
});

test("Workbench selection checks the plugin id, not unrelated preferences or a partial match", () => {
  assert.ok(isWorkbenchProvider("workbench"));
  assert.ok(isWorkbenchProvider("workbench:threads"));
  assert.ok(isWorkbenchProvider("workbench/threads"));
  for (const input of [
    "not-workbench",
    "other/workbench",
    "workbench-copy/threads",
    "workbench-copy:threads",
    "builtin",
    null,
    { theme: "workbench" },
  ])
    assert.equal(isWorkbenchProvider(input), false);
});

test("idle reports cannot escape the event listener, including after disabling Team", async (t) => {
  const e = setup(t);
  await e.harness.behavior.callRpc("teamSave", { enabled: true });
  const a = e.team.engine.assign(
    {
      assignee: e.team.engine.chief()!.id,
      mode: "consult",
      title: "Check",
      brief: "Check",
      doneWhen: "",
      parentId: null,
      dedupeKey: null,
      wallHours: 12,
    },
    "user",
    "home-chief",
  );
  e.team.engine.start(a.id, a.assignee);
  const report = `=== RESULT ===\nASSIGNMENT: ${a.id}\nSTATUS: done\nSUMMARY: Checked\nDELIVERED: Answer\nEVIDENCE: Probe passed\nFILES: none\nOPEN QUESTIONS: none\n=== END RESULT ===`;
  e.team.engine.report = () => {
    throw new Error("Open ask prevents reporting");
  };
  const result = await e.harness.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: "home-chief" }),
    lastAssistantText: report,
  });
  assert.deepEqual(result.errors, []);
  assert.ok(e.team.engine.store.list("incident").length);
  await e.harness.behavior.callRpc("teamSave", { enabled: false });
  const disabled = await e.harness.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: "home-chief" }),
    lastAssistantText: report,
  });
  assert.deepEqual(disabled.errors, []);
});

test("copy uses 24-hour times and human labels; oversized instructions fall back with consent", async (t) => {
  const e = setup(t);
  await e.harness.behavior.callRpc("teamSave", { enabled: true });
  const chief = e.team.engine.chief()!;
  assert.match(teamTime("2026-11-26T16:05:00"), /^16:05$/);
  assert.ok(!teamDue("2026-11-26T16:05:00").includes("PM"));
  assert.equal(answerSurface("tray"), "the ask tray");
  assert.equal(receiptState.accepted, "Delivered to bb");
  const instructions = projectLeadInstructions({
    member: chief,
    chief,
    project: null,
    tasksBeforeAsking: 0,
    goal: true,
    rules: "## Always include\n" + "x".repeat(351),
  });
  assert.ok(instructions.length <= 4046);
  assert.ok(instructions.includes(CONSENT));
  assert.ok(instructions.includes(GOAL_LINE));
});

test("sidebar DTO is versioned, capped and reports real truncation without losing the chief or global count", async (t) => {
  const { teamSidebarSchema, TEAM_SIDEBAR_LIMITS } = await import(
    "../contract-team.ts"
  );
  const e = setup(t);
  await e.harness.behavior.callRpc("teamSave", { enabled: true });
  const chief = e.team.engine.chief()!;
  for (let i = 0; i < 202; i++)
    for (const kind of ["specialist", "project-lead"] as const)
      e.team.engine.store.put("member", {
        ...chief,
        id: `m_${kind}${i}`,
        name: "Member",
        kind,
        homeThreadId: `home-${kind}${i}`,
      });
  const base = e.team.engine.assign(
    {
      assignee: chief.id,
      mode: "consult",
      title: "Check",
      brief: "Check",
      doneWhen: "",
      parentId: null,
      dedupeKey: null,
      wallHours: 12,
    },
    "user",
    "home-chief",
  );
  for (let i = 0; i < 101; i++)
    e.team.engine.store.put("assignment", {
      ...base,
      id: `a_background${i}`,
      rootId: `a_background${i}`,
      threadId: `background-${i}`,
    });
  e.team.engine.createAsk({
    memberId: chief.id,
    title: "Choose a route",
    verb: "Decide",
    unblocks: "Moving forward",
    options: [{ id: "a", label: "A", effect: "Choose A", tier: "contained" }],
    secondary: "Not now",
  });
  const dto = teamSidebarSchema.parse(e.team.engine.sidebar());
  assert.equal(dto.version, 1);
  assert.equal(dto.lead?.memberId, chief.id);
  assert.equal(dto.members.length, TEAM_SIDEBAR_LIMITS.members);
  assert.equal(dto.projects.length, TEAM_SIDEBAR_LIMITS.projects);
  assert.equal(dto.hideFromSections.length, TEAM_SIDEBAR_LIMITS.hidden);
  assert.equal(
    dto.lead?.backgroundThreadIds.length,
    TEAM_SIDEBAR_LIMITS.backgroundThreads,
  );
  assert.equal(dto.truncated, true);
  assert.equal(dto.yourMove.count, 1);
  assert.ok(!teamSidebarSchema.safeParse({ ...dto, version: 2 }).success);
  assert.ok(
    !teamSidebarSchema.safeParse({
      ...dto,
      members: [...dto.members, dto.members[0]],
    }).success,
  );
});

test("empty free-text decisions require a real answer and preserve it in the relay", async (t) => {
  const e = setup(t);
  const d = e.store.addDecision({
    question: "What should happen?",
    recommendation: "",
    options: [],
    taskIds: [],
    orchestratorThreadId: "lead-chat",
  });
  await e.harness.behavior.callRpc("teamSave", { enabled: true });
  const ask = e.team.engine.store.list("ask")[0];
  assert.equal(ask.options[0].id, "free-text");
  await assert.rejects(
    () =>
      e.harness.behavior.callRpc("answerAsk", {
        askId: ask.id,
        revision: ask.revision,
        option: "free-text",
        text: "",
        surface: "today",
      }),
    /Write an answer/,
  );
  const choice = (await e.harness.behavior.callRpc("answerAsk", {
    askId: ask.id,
    revision: ask.revision,
    option: "free-text",
    text: "Take a break",
    surface: "today",
  })) as { ask: Ask };
  const ct = e.team.engine.openConfirm(ask.id, choice.ask.revision);
  await e.harness.behavior.callRpc("confirmAsk", {
    askId: ask.id,
    revision: choice.ask.revision,
    confirmToken: ct.confirmToken,
  });
  assert.equal(e.store.decision(d.id)?.answer, "Take a break");
  assert.match(e.sent[0].input[0].text, /Take a break/);
});
