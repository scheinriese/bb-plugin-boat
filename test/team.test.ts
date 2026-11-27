import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryStore } from "./fakes.ts";
import { TeamEngine, waitingAsks } from "../src/team/engine.ts";
import {
  assignmentInputSchema,
  teamSidebarSchema,
  type Ask,
  type Member,
} from "../contract-team.ts";
import { sidebarRpcMethods } from "../contract-sidebar.ts";
import {
  core,
  memberInstructions,
  projectLeadInstructions,
  CONSENT,
  GOAL_LINE,
} from "../src/team/instructions.ts";
import { orchestratorInstructions } from "../src/orchestrator.ts";
import { projectReviewInstructions } from "../src/review-policy.ts";
import type { OrchestratorProject } from "../src/projects.ts";
function setup() {
  const taskStore = memoryStore();
  let now = new Date("2026-11-26T09:00:00Z");
  let changes = 0;
  const engine = new TeamEngine(
    taskStore.team,
    () => {
      changes++;
    },
    () => now,
  );
  const chief = engine.home(engine.enable(), "home-chief");
  const lead = engine.syncLead({
    threadId: "home-web",
    projectId: "web",
    projectName: "Web app",
  });
  return {
    engine,
    taskStore,
    chief,
    lead,
    clock: (at: string) => {
      now = new Date(at);
    },
    changes: () => changes,
  };
}
const option = {
  id: "approve",
  label: "Approve",
  effect: "Restart the staging service",
  tier: "contained" as const,
  recommended: false,
  action: "answer" as const,
};
function ask(
  engine: TeamEngine,
  member: Member,
  patch: Record<string, unknown> = {},
) {
  return engine.createAsk({
    memberId: member.id,
    title: "Restart the staging API",
    verb: "Approve",
    unblocks: "Checking the checkout fix on staging",
    secondary: "Deny",
    options: [option],
    ...patch,
  });
}
const answer = (a: Ask, patch: Record<string, unknown> = {}) => ({
  askId: a.id,
  revision: a.revision,
  option: "approve",
  text: "",
  surface: "today" as const,
  ...patch,
});
test("Team migration is additive and off by default; chief home is fixed and unique", () => {
  const s = memoryStore();
  const engine = new TeamEngine(s.team, () => {});
  assert.equal(engine.enabled(), false);
  assert.equal(engine.sidebar(), undefined);
  const chief = engine.enable();
  engine.home(chief, "fixed-home");
  assert.equal(engine.enable().homeThreadId, "fixed-home");
  assert.equal(s.team.list("member").length, 1);
  assert.equal(s.list().length, 0);
});
test("work needs done when; dedupe, watcher join and cycles preserve the ledger", () => {
  const { engine, chief, lead } = setup();
  const input = assignmentInputSchema.parse({
    assignee: lead.id,
    mode: "work",
    title: "Checkout rounding",
    brief: "Fix checkout",
  });
  assert.throws(() => engine.assign(input, chief.id, "home"), /no-done-when/);
  input.doneWhen = "Tests pass and a PR is open";
  const a = engine.assign(input, chief.id, "home");
  assert.equal(engine.assign(input, chief.id, "home").id, a.id);
  assert.equal(engine.store.list("receipt").length, 1);
  assert.throws(
    () =>
      engine.assign(
        { ...input, assignee: chief.id, parentId: a.id },
        lead.id,
        "home",
      ),
    /cycle/,
  );
  const keyed = engine.assign(
    { ...input, brief: "Another issue", dedupeKey: "issue:42" },
    chief.id,
    "home",
  );
  const joined = engine.assign(
    { ...input, brief: "Another issue", dedupeKey: "issue:42" },
    "user",
    "home",
  );
  assert.equal(joined.id, keyed.id);
  assert.deepEqual(joined.watchers, ["user"]);
});
test("progress is not completion; work without evidence is partial; result and wake are idempotent", () => {
  const { engine, chief, lead } = setup();
  const a = engine.assign(
    assignmentInputSchema.parse({
      assignee: lead.id,
      mode: "work",
      title: "Checkout",
      brief: "Fix checkout",
      doneWhen: "Tests pass",
    }),
    chief.id,
    "home",
  );
  engine.start(a.id, lead.id);
  engine.progress(a.id, lead.id, "Waiting for CI");
  assert.equal(engine.store.get("assignment", a.id).status, "running");
  const result = {
    status: "done",
    summary: "Fix pushed",
    delivered: "PR",
    evidence: "none",
  };
  assert.equal(engine.report(a.id, lead.id, result).outcome, "partial");
  engine.report(a.id, lead.id, result);
  assert.equal(
    engine.store.list("receipt").filter((r) => r.kind === "result").length,
    1,
  );
  assert.ok(
    engine.store.list("receipt").every((r) => r.text.includes(CONSENT)),
  );
});
test("one automatic continue, then paused with one incident and a resumable ask", () => {
  const { engine, chief, lead } = setup();
  const a = engine.assign(
    assignmentInputSchema.parse({
      assignee: lead.id,
      mode: "consult",
      title: "Flaky test?",
      brief: "Check test",
    }),
    chief.id,
    "home",
  );
  engine.start(a.id, lead.id);
  engine.idle("home-web");
  engine.idle("home-web");
  engine.idle("home-web");
  assert.equal(engine.store.get("assignment", a.id).status, "paused");
  assert.equal(engine.store.list("incident").length, 1);
  assert.equal(
    engine.store.list("receipt").filter((r) => r.kind === "continue").length,
    1,
  );
  const k = engine.store.list("ask")[0];
  engine.answer({ ...answer(k), option: "continue" });
  assert.equal(engine.store.get("assignment", a.id).status, "delivered");
});
test("Contained first answer wins, unrelated chat does not close it; Not now keeps it open", () => {
  const { engine, lead } = setup();
  const k = ask(engine, lead);
  engine.idle("home-web");
  assert.equal(engine.store.get("ask", k.id).state, "open");
  const deferred = engine.answer({ ...answer(k), option: "defer" }).ask;
  assert.equal(deferred.state, "open");
  const next = engine.answer(answer(deferred));
  const stale = engine.answer(answer(deferred));
  assert.equal(next.ask.state, "answered");
  assert.match(stale.message, /Already answered/);
  assert.equal(stale.ask.revision, next.ask.revision);
});
test("no bypass: all tap, typed, Board and RPC/CLI answers to Confirm wait; no grant before token", () => {
  for (const surface of [
    "today",
    "tray",
    "strip",
    "board",
    "confirm-view",
    "tool",
    "cli",
  ] as const) {
    const { engine, lead } = setup();
    const k = ask(engine, lead, {
      options: [
        {
          ...option,
          tier: "confirm",
          effect: "Send the application. It can't be unsent.",
        },
      ],
      scope: {
        actionClass: "submit-personal",
        targets: ["Example Corp"],
        members: [lead.id],
        uses: 1,
        expiresAt: "2026-11-27T09:00:00Z",
      },
      confirmLabel: "Send the application",
    });
    const result = engine.answer(
      { ...answer(k), surface },
      surface === "tool" ? "typed reply" : "unverified tap",
    );
    assert.equal(result.ask.state, "confirming");
    assert.equal(engine.store.list("grant").length, 0);
    assert.ok(!JSON.stringify(result).includes("confirmToken"));
    assert.equal(engine.store.get("ask", k.id).after.ranAt, null);
  }
});
test("single-use revision-bound tokens, two-minute timeout, scope expiry and held sends", () => {
  const { engine, lead, clock } = setup();
  let k = ask(engine, lead, {
    options: [{ ...option, tier: "confirm" }],
    scope: {
      actionClass: "external-send",
      targets: ["garage"],
      members: [lead.id],
      uses: 1,
      expiresAt: "2026-11-27T09:00:00Z",
    },
  });
  k = engine.answer(answer(k)).ask;
  const token = engine.openConfirm(k.id, k.revision);
  assert.throws(
    () => engine.confirm(k.id, k.revision + 1, token.confirmToken),
    /changed/,
  );
  const applied = engine.confirm(k.id, k.revision, token.confirmToken);
  assert.equal(applied.state, "answered");
  assert.equal(applied.answer?.provenance, "unverified tap");
  assert.throws(
    () => engine.confirm(k.id, k.revision, token.confirmToken),
    /changed/,
  );
  const grant = engine.store.list("grant")[0];
  assert.throws(
    () => engine.useGrant(grant.id, lead.id, "external-send", "garage"),
    /No active grant/,
  );
  clock("2026-11-26T09:00:31Z");
  assert.throws(
    () => engine.useGrant(grant.id, lead.id, "external-send", "elsewhere"),
    /No active grant/,
  );
  engine.useGrant(grant.id, lead.id, "external-send", "garage");
  assert.throws(
    () => engine.useGrant(grant.id, lead.id, "external-send", "garage"),
    /No active grant/,
  );
  const ran = engine.effectRan(k.id, lead.id, "Delivery receipt checked");
  assert.equal(ran.after.ranAt, "2026-11-26T09:00:31.000Z");
  assert.equal(ran.answer?.at, "2026-11-26T09:00:00.000Z");
});
test("expired and changed tokens cannot apply; Deny applies without confirm", () => {
  const { engine, lead, clock } = setup();
  let k = ask(engine, lead, { options: [{ ...option, tier: "confirm" }] });
  k = engine.answer(answer(k)).ask;
  const token = engine.openConfirm(k.id, k.revision);
  clock("2026-11-26T09:02:01Z");
  assert.throws(
    () => engine.confirm(k.id, k.revision, token.confirmToken),
    /timed out/,
  );
  engine.expireConfirmations();
  k = engine.store.get("ask", k.id);
  assert.equal(k.state, "open");
  assert.equal(
    engine.answer({ ...answer(k), option: "secondary" }).ask.state,
    "answered",
  );
  assert.equal(engine.store.list("grant").length, 0);
});
test("risky classes cannot be downgraded and grant expiry is bounded", () => {
  const { engine, lead } = setup();
  assert.throws(
    () =>
      ask(engine, lead, {
        scope: {
          actionClass: "ship",
          targets: ["acme/web"],
          members: [lead.id],
          uses: 1,
          expiresAt: "2026-11-27T09:00:00Z",
        },
      }),
    /requires confirmation/,
  );
  assert.throws(
    () =>
      ask(engine, lead, {
        scope: {
          actionClass: "restart-nonprod",
          targets: ["staging"],
          members: [lead.id],
          uses: 1,
          expiresAt: "2027-01-01T09:00:00Z",
        },
      }),
    /seven days/,
  );
});
test("Do waits for effect verification; revocation pauses work and unused grants", () => {
  const { engine, lead } = setup();
  let k = ask(engine, lead, {
    verb: "Do",
    title: "Reconnect the machine",
    secondary: "Not now",
  });
  k = engine.answer(answer(k)).ask;
  assert.equal(k.state, "verifying");
  assert.equal(waitingAsks(engine.store.list("ask")).length, 1);
  assert.equal(
    engine.effectRan(k.id, lead.id, "Machine responds to probe").state,
    "answered",
  );
  k = ask(engine, lead, {
    scope: {
      actionClass: "restart-nonprod",
      targets: ["staging"],
      members: [lead.id],
      uses: 1,
      expiresAt: "2026-11-27T09:00:00Z",
    },
  });
  engine.answer(answer(k));
  engine.revoke(k.id);
  assert.equal(engine.store.list("grant")[0].status, "revoked");
  assert.equal(engine.store.get("member", lead.id).status, "paused");
  assert.equal(engine.store.list("incident").length, 1);
});
test("legacy decisions still resolve and supersede a mapped ask", () => {
  const { engine, taskStore, lead } = setup();
  const d = taskStore.addDecision({
    orchestratorThreadId: "home-web",
    question: "Choose a layout",
    recommendation: "B",
    options: ["A", "B"],
    taskIds: [],
  });
  const mapped=ask(engine, lead, { legacyDecisionId: d.id });
  assert.equal(
    taskStore.resolveDecision(d.id, "answered", "B")?.status,
    "answered",
  );
  assert.equal(engine.store.get("ask",mapped.id).state,"superseded");
});
test("instruction cores, per-block budgets and actual worst-case project instructions fit the 4,096 floor", () => {
  const { engine, chief, lead } = setup();
  assert.equal(
    core("## Always include\nKeep this\n## Other\nSkip", 900),
    "Keep this",
  );
  assert.throws(
    () => engine.saveRules("## Always include\n" + "x".repeat(351)),
    /351 of 350/,
  );
  const member = {
    ...chief,
    standingInstructions:
      "## Always include\n" +
      "s".repeat(900) +
      "\n## Detail\n" +
      "d".repeat(18000),
  };
  const dynamic = memberInstructions(
    member,
    chief,
    Array.from({ length: 20 }, () => lead),
    [],
    "## Always include\n" + "r".repeat(350),
  );
  assert.ok(dynamic.length < 4096);
  assert.ok(dynamic.includes("s".repeat(900)));
  assert.ok(dynamic.includes("r".repeat(350)));
  for (const reviewer of [null, "none", "codex", "claude"] as const) {
    const project: OrchestratorProject = {
      id: "web",
      name: "P".repeat(40),
      repos: Array.from({ length: 8 }, () => ({
        repo: "acme/" + "r".repeat(55),
        baseBranch: "b".repeat(30),
      })),
      environment: "e".repeat(30),
      protocolPath: null,
      workerMode: "chat",
      delivery: "push",
      protectedBranches: [],
      instructions: "",
      source: "boat",
      snapshot: null,
      bbProjectId: null,
      reviewer,
    };
    const instructions = projectLeadInstructions({
      member: { ...lead, name: "L".repeat(30) },
      chief: { ...chief, name: "N".repeat(30) },
      project,
      tasksBeforeAsking: 0,
      goal: true,
      rules: "## Always include\n" + "r".repeat(350),
    });
    assert.ok(
      instructions.length <= 4046,
      `${reviewer}: ${instructions.length}`,
    );
    assert.ok(instructions.includes(orchestratorInstructions(0)));
    assert.ok(instructions.includes(GOAL_LINE));
    assert.ok(instructions.includes(projectReviewInstructions(project)));
    assert.ok(instructions.includes(CONSENT));
    assert.ok(instructions.includes("r".repeat(350)));
    assert.ok(instructions.includes("repo list shortened"));
  }
});
test("sidebar Team DTO is additive, bounded to real home pointers and latest chief line", () => {
  const { engine, chief, lead } = setup();
  ask(engine, lead);
  engine.store.saveSetting(
    "chiefPreview",
    "The checkout fix is ready for review",
  );
  const dto = teamSidebarSchema.parse(engine.sidebar());
  assert.equal(dto.yourMove.count, 1);
  assert.equal(dto.lead?.threadId, chief.homeThreadId);
  assert.equal(dto.lead?.preview.text, "The checkout fix is ready for review");
  assert.ok(!dto.lead?.preview.text.startsWith("Next:"));
  assert.equal(dto.members[0].threadId, "home-web");
  const old = { version: 1, revision: "v", threads: [], truncated: false };
  assert.ok(sidebarRpcMethods.sidebarState.output.parse(old));
  assert.ok(
    sidebarRpcMethods.sidebarState.output.parse({ ...old, team: dto }).team,
  );
});

test("scripted example day: 09:00, 14:30 and 18:00 counts, locks, incidents, results and receipts", async () => {
  const { replayDay } = await import("./fixtures/team-day.ts");
  for (const [at, count, locks, incidents, done] of [
    ["09:00", 2, 0, 0, 0],
    ["14:30", 3, 1, 2, 2],
    ["18:00", 3, 3, 0, 4],
  ] as const) {
    const { engine, clock } = setup();
    const { state } = replayDay(engine, clock, at);
    const dto = engine.sidebar()!;
    assert.equal(dto.yourMove.count, count, at);
    assert.equal(dto.yourMove.confirm, locks, at);
    assert.equal(
      state.incidents.filter((i) => !i.resolvedAt).length,
      incidents,
      at,
    );
    assert.equal(
      state.assignments.filter((a) => a.outcome === "done").length,
      done,
      at,
    );
    assert.ok(
      state.asks
        .filter((a) => a.state === "answered")
        .every((a) => a.answer?.provenance === "unverified tap"),
    );
  }
});

test("only a framed RESULT is completion; ordinary end text is never relayed", async () => {
  const { parseTeamResult } = await import("../src/team/result.ts");
  assert.equal(parseTeamResult("Done, waiting for CI"), null);
  assert.equal(
    parseTeamResult(
      "=== RESULT ===\nASSIGNMENT: a_123\nSTATUS: done\nSUMMARY: Tests pass\nDELIVERED: PR\nEVIDENCE: CI green\nFILES: none\nOPEN QUESTIONS: none\n=== END RESULT ===",
    )?.result.status,
    "done",
  );
});

test("wall timeout expires with an incident and wake; declared wait resumes; tree budget pauses once and renews", () => {
  const { engine, chief, lead, clock } = setup();
  const a = engine.assign(
    assignmentInputSchema.parse({
      assignee: lead.id,
      mode: "consult",
      title: "Check",
      brief: "Check",
      wallHours: 1,
    }),
    chief.id,
    "home",
  );
  engine.start(a.id, lead.id);
  engine.wait(a.id, lead.id, "Waiting for a check", "2026-11-26T09:05:00Z");
  clock("2026-11-26T09:06:00Z");
  engine.sweep();
  assert.equal(engine.store.get("assignment", a.id).status, "delivered");
  engine.start(a.id, lead.id);
  let current = engine.store.get("assignment", a.id);
  engine.updateAssignment(
    current,
    { turns: 4, treeTurnLimit: 4 },
    "budget-set",
    "user",
  );
  engine.sweep();
  engine.sweep();
  assert.equal(engine.store.get("assignment", a.id).status, "paused");
  const k = engine.store.list("ask")[0];
  assert.equal(engine.store.list("ask").length, 1);
  engine.answer({ ...answer(k), option: "extend" });
  assert.equal(engine.store.get("assignment", a.id).treeTurnLimit, 124);
  clock("2026-11-26T10:01:00Z");
  engine.sweep();
  assert.equal(engine.store.get("assignment", a.id).outcome, "expired");
  assert.equal(engine.store.list("incident").length, 1);
  assert.ok(engine.store.list("receipt").some((r) => r.kind === "result"));
});
