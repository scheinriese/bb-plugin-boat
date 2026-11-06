// The Cloud agents UI's pure logic (web/logic.ts) and the sandbox "used by"
// rows the page shows (src/rpc.ts sandboxUses).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlanDto } from "../contract.ts";
import { sandboxUses } from "../src/rpc.ts";
import {
  STARTERS,
  canRequestReview,
  evidenceMode,
  historyText,
  isCheckRepoTask,
  pageState,
  richText,
  sandboxLink,
  sandboxUseLabel,
  snapshotNameFor,
  splitPlaceholders,
  statusLine,
  taskPhaseLabel,
  titleFromBrief,
  usageSummary,
} from "../web/logic.ts";

const plan = (patch: Partial<PlanDto> = {}): PlanDto => ({
  name: "Standard",
  accessTier: "standard",
  trial: false,
  trialEndsAt: null,
  checkoutRequired: false,
  canStart: true,
  startBlockedReason: null,
  activeSandboxes: 0,
  maxActiveSandboxes: 100,
  startsLeftToday: 162,
  startsPerDay: 200,
  vmHoursRemaining: 550,
  machineTypes: [],
  extraStartsEnabled: false,
  autoStopCapHours: null,
  ...patch,
});

test("the page state: setup only while there's nothing to show, orchestrators take the top once there is one", () => {
  assert.equal(pageState({ setupOk: false, hasTasks: false, orchestrators: 0 }), "setup");
  // Someone with work keeps seeing it (the checklist sits on top).
  assert.equal(pageState({ setupOk: false, hasTasks: true, orchestrators: 0 }), "regular");
  assert.equal(pageState({ setupOk: false, hasTasks: false, orchestrators: 1 }), "orchestrators");
  // Checks that couldn't run never block.
  assert.equal(pageState({ setupOk: null, hasTasks: false, orchestrators: 0 }), "first");
  assert.equal(pageState({ setupOk: true, hasTasks: false, orchestrators: 0 }), "first");
  assert.equal(pageState({ setupOk: true, hasTasks: true, orchestrators: 0 }), "regular");
  assert.equal(pageState({ setupOk: true, hasTasks: true, orchestrators: 2 }), "orchestrators");
});

test("status line: plan, sandboxes of the cap, hours left; starts only when low or on the trial; a bar only near the cap", () => {
  const normal = statusLine({ plan: plan(), cap: 3, active: 1 });
  assert.deepEqual(normal.parts, ["Standard plan", "1 of 3 sandboxes", "550 sandbox hours left"]);
  assert.equal(normal.barPercent, null);
  assert.equal(normal.full, false);

  const low = statusLine({ plan: plan({ startsLeftToday: 40, startsPerDay: 200 }), cap: 3, active: 3 });
  assert.ok(low.parts.includes("40 starts left today"));
  assert.equal(low.barPercent, 100);
  assert.equal(low.full, true);

  const trial = statusLine({ plan: plan({ name: "Trial", trial: true, startsLeftToday: 70, startsPerDay: 75, vmHoursRemaining: 4.25 }), cap: 2, active: 1 });
  assert.deepEqual(trial.parts, ["Trial plan", "1 of 2 sandboxes", "4.3 sandbox hours left", "70 starts left today"]);
  assert.equal(trial.barPercent, null, "50 % is under the bar's 70 %");

  const unknown = statusLine({ plan: null, cap: null, active: 1 });
  assert.deepEqual(unknown.parts, ["1 sandbox"]);
  assert.equal(statusLine({ plan: null, cap: 10, active: 7 }).barPercent, 70);
});

test("usage: one shared window reads 'of weekly limits'; different windows name their own", () => {
  assert.equal(
    usageSummary([
      { provider: "claude", usedPercent: 29.4, window: "Weekly limit" },
      { provider: "codex", usedPercent: 0, window: "Weekly limit" },
    ]),
    "Claude 29% · Codex 0% of weekly limits",
  );
  assert.equal(usageSummary([{ provider: "claude", usedPercent: 12, window: "Weekly" }]), "Claude 12% of the weekly limit");
  assert.equal(
    usageSummary([
      { provider: "claude", usedPercent: 50, window: "5-hour limit" },
      { provider: "codex", usedPercent: 4, window: "Weekly limit" },
    ]),
    "Claude 50% of the 5-hour limit · Codex 4% of the weekly limit",
  );
  assert.equal(usageSummary([{ provider: "codex", usedPercent: null, window: null }]), null);
});

test("a finished turn reads Finished unless an orchestrator started it", () => {
  const source = (kind: "orchestrator" | "chat" | "page") => ({ kind, threadId: kind === "page" ? null : "thr_1", title: null });
  assert.equal(taskPhaseLabel({ phase: "ready", source: source("chat") }), "Finished");
  assert.equal(taskPhaseLabel({ phase: "ready", source: source("page") }), "Finished");
  assert.equal(taskPhaseLabel({ phase: "ready", source: source("orchestrator") }), "Ready");
  assert.equal(taskPhaseLabel({ phase: "waiting", source: source("orchestrator") }), "Waiting on orchestrator");
  assert.equal(taskPhaseLabel({ phase: "waiting", source: source("chat") }), "Waiting on you");
});

test("a title comes from the first line of what to do", () => {
  assert.equal(titleFromBrief("\n\n## Fix the flaky login test\nIt fails one run in ten."), "Fix the flaky login test");
  assert.equal(titleFromBrief("What's wrong: the cart total is off by one\nWhere: cart.ts"), "the cart total is off by one");
  const long = titleFromBrief("Rewrite the quickstart guide for the new command line so every single step works in a clean environment", 40);
  assert.ok(long.length <= 40 && long.endsWith("…"), long);
  assert.equal(titleFromBrief("   "), "");
});

test("starters: the repo check names the repo and offers a snapshot later; the test task needs no repo", () => {
  const check = STARTERS.find((entry) => entry.id === "check-repo")!;
  assert.equal(check.title("acme/web"), "Check acme/web runs in a sandbox");
  // The plugin checks the repo out first; the starter says so, and asks for no commits.
  assert.match(check.brief("acme/web"), /^acme\/web is already checked out in this sandbox\. Install its dependencies, run the tests and start the app\. Don't change any code, and don't commit or push anything\./);
  assert.doesNotMatch(check.brief("acme/web"), /Clone/);
  // Checks and read-only exploring run on light presets; fixing a bug keeps the role's default (Build).
  assert.equal(check.tier, "light");
  assert.equal(STARTERS.find((entry) => entry.id === "explore")!.tier, "review");
  assert.equal(STARTERS.find((entry) => entry.id === "fix-bug")!.tier, null);
  assert.ok(isCheckRepoTask(check.title("acme/web")));
  assert.ok(!isCheckRepoTask("Fix the login bug"));
  assert.equal(STARTERS.find((entry) => entry.id === "test")!.needsRepo, false);
  assert.match(STARTERS.find((entry) => entry.id === "fix-bug")!.brief(""), /What's wrong: \nWhere \(file or function\): \nError output: \nExpected: \nHow to check: /);
  assert.equal(snapshotNameFor("acme/Web.git"), "web-ready");
  assert.equal(snapshotNameFor(null), "sandbox-ready");
});

test("closed tasks: no review, and a sandbox link only while boat still has the sandbox", () => {
  const task = { role: "custom" as const, status: "idle" as const, title: "Check acme/web runs in a sandbox", repo: "acme/web", sandboxId: "bx_1" };
  assert.equal(canRequestReview(task), true);
  for (const status of ["done", "cancelled"] as const) assert.equal(canRequestReview({ ...task, status }), false, status);
  assert.equal(canRequestReview({ ...task, role: "review" }), false);
  assert.equal(canRequestReview({ ...task, title: "Test task", repo: null }), false);

  // Open tasks keep their sandbox; a closed one's link only while boat lists it.
  assert.equal(sandboxLink(task, null), "live");
  const closed = { ...task, status: "done" as const };
  assert.equal(sandboxLink(closed, [{ id: "bx_1" }]), "live", "kept on close");
  assert.equal(sandboxLink(closed, [{ id: "bx_2" }]), "gone");
  assert.equal(sandboxLink(closed, null), "unknown", "boat's list not read yet");
  assert.equal(sandboxLink({ ...closed, sandboxId: null }, []), null);
});

test("the history says until when the sandbox's GitHub login lasts, not a raw timestamp", () => {
  const at = "2026-11-06T13:07:07.000Z";
  assert.equal(historyText({ kind: "github-token", text: at }, (iso) => `[${iso}]`), `The sandbox's GitHub login lasts until [${at}].`);
  assert.equal(historyText({ kind: "github-token", text: "soon" }, () => "x"), "soon");
  assert.equal(historyText({ kind: "access", text: "GitHub access to acme/web: can push" }, () => "x"), "GitHub access to acme/web: can push");
});

test("protocol fields are split out (known ones marked) so the editor can show them as chips", () => {
  const segments = splitPlaceholders("Intro {{workers}} and {{nope}}.\n{{model-tiers}}");
  assert.deepEqual(segments, [
    { kind: "text", text: "Intro " },
    { kind: "field", text: "{{workers}}", known: true },
    { kind: "text", text: " and " },
    { kind: "field", text: "{{nope}}", known: false },
    { kind: "text", text: ".\n" },
    { kind: "field", text: "{{model-tiers}}", known: true },
  ]);
  assert.deepEqual(splitPlaceholders("no fields"), [{ kind: "text", text: "no fields" }]);
  // The segments put back together are the text, unchanged.
  const text = "a {{agents}} b {{evidence}}";
  assert.equal(splitPlaceholders(text).map((segment) => segment.text).join(""), text);
});

test("hints: commands become code and https links become links", () => {
  assert.deepEqual(richText("Sign in to boat.dev: run `boat onboard` in a terminal."), [
    { kind: "text", text: "Sign in to boat.dev: run " },
    { kind: "code", text: "boat onboard" },
    { kind: "text", text: " in a terminal." },
  ]);
  assert.deepEqual(richText("Connect Claude on boat.dev → Agents (https://boat.dev/dashboard?tab=agents)."), [
    { kind: "text", text: "Connect Claude on boat.dev → Agents (" },
    { kind: "url", text: "https://boat.dev/dashboard?tab=agents" },
    { kind: "text", text: ")." },
  ]);
});

test("evidence uploader modes", () => {
  assert.equal(evidenceMode(""), "off");
  assert.equal(evidenceMode(" builtin "), "builtin");
  assert.equal(evidenceMode("acme/tools:scripts/upload.mjs@abc123"), "script");
});

test("a sandbox says what uses it: open tasks, chats on its machine (not a task's own chat), then kept tasks", () => {
  const tasks = [
    { id: "t_1", title: "Fix the cart", status: "running" as const, sandboxId: "bx_1", threadId: "thr_task" },
    { id: "t_2", title: "Old check", status: "done" as const, sandboxId: "bx_1", threadId: null },
    { id: "t_3", title: "Elsewhere", status: "idle" as const, sandboxId: "bx_2", threadId: null },
  ];
  const chats = [
    { sandboxId: "bx_1", threadId: "thr_task", title: "Fix the cart" },
    { sandboxId: "bx_3", threadId: "thr_orch", title: "Checkout refresh" },
    { sandboxId: "bx_3", threadId: "thr_plain", title: "Planning" },
  ];
  const orchestrators = new Set(["thr_orch"]);
  assert.deepEqual(sandboxUses("bx_1", tasks, chats, orchestrators), [
    { kind: "task", id: "t_1", title: "Fix the cart", open: true },
    { kind: "task", id: "t_2", title: "Old check", open: false },
  ]);
  assert.deepEqual(
    sandboxUses("bx_3", tasks, chats, orchestrators).map((use) => sandboxUseLabel(use)),
    ["Orchestrator: Checkout refresh", "Chat: Planning"],
  );
  assert.deepEqual(sandboxUses("bx_9", tasks, chats, orchestrators), []);
});

test("model names read the same everywhere: boat's ids and Claude Code's", async () => {
  const { modelName } = await import("../web/format.ts");
  assert.equal(modelName("opus-5-5"), "Opus 5.5");
  assert.equal(modelName("claude-sonnet-5-5"), "Sonnet 5.5");
  assert.equal(modelName("sonnet-5"), "Sonnet 5");
  assert.equal(modelName("gpt-6.1-sol"), "GPT-6.1 Sol");
  assert.equal(modelName("my-own-model"), "my-own-model");
});

test("the setup summary in the UI: no pointer to bb boat doctor, the labels after a colon", async () => {
  const { setupSummaryText } = await import("../web/logic.ts");
  assert.equal(setupSummaryText("Setup: 1 thing to fix (Coding agents). Run `bb boat doctor`."), "1 thing to fix: Coding agents.");
  assert.equal(setupSummaryText("Setup: ready."), "Ready.");
  assert.equal(setupSummaryText("Setup: ready, but check boat CLI. Run `bb boat doctor`."), "Ready, but check boat CLI.");
});

test("the test task: no repo, named Test task (it gets a next step instead of Request review)", async () => {
  const { isTestTask } = await import("../web/logic.ts");
  assert.equal(isTestTask({ title: "Test task", repo: null }), true);
  assert.equal(isTestTask({ title: "Test task", repo: "acme/web" }), false);
  assert.equal(isTestTask({ title: "Fix the header", repo: null }), false);
});

test("a title is the first sentence; a repo comes from a GitHub link or a project's repo in the text", async () => {
  const { repoFromText } = await import("../web/logic.ts");
  assert.equal(titleFromBrief("Fix the flaky login test in acme/web. Keep the current retry logic and add a test."), "Fix the flaky login test in acme/web");
  assert.equal(titleFromBrief("Why does the cart total drift? Look at cart.ts first."), "Why does the cart total drift?");
  assert.equal(titleFromBrief("Use v2.1 of the parser"), "Use v2.1 of the parser");
  const known = ["acme/storefront", "acme/api"];
  assert.equal(repoFromText("Update the checkout copy in acme/storefront.", known), "acme/storefront");
  assert.equal(repoFromText("See https://github.com/acme/docs/issues/4 for details", known), "acme/docs");
  assert.equal(repoFromText("Edit src/app.ts and/or the tests", known), null);
});

test("Select ignores the empty change Radix's hidden native select reports (it cleared derived choices)", async () => {
  // Seen live: opening a task page directly left the reply box's agent empty
  // ("…over to undefined"), and New orchestrator's Where showed its placeholder,
  // because the selected option mounted in the same render as the value.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../components/ui/select.tsx", import.meta.url), "utf8");
  const handler = /const handleValueChange = React\.useCallback\(\s*\(next: string\) => \{([\s\S]*?)\n    \},/.exec(source)?.[1] ?? "";
  const guard = handler.indexOf('if (next === "") return;');
  assert.ok(guard !== -1, "the wrapper drops empty changes");
  assert.ok(guard < handler.indexOf("onValueChange?.(next)"), "before telling the caller");
  assert.ok(guard < handler.indexOf("setUncontrolledValue(next)"), "and before storing it");
});

test("sandbox sizes on the page: cost, the follow-up, the preselected size, the peak's sentence", async () => {
  const { costHint, isSmaller, peakSentence, resizeMessage, suggestedSize } = await import("../web/logic.ts");
  assert.equal(costHint("large"), "Large costs twice as much per hour as Default.");
  assert.equal(costHint("small"), "Small costs half as much per hour as Default.");
  assert.doesNotMatch(costHint("xlarge"), /\$/);
  assert.equal(resizeMessage("large", false), "Continue where you left off. The sandbox is now Large (8 vCPU, 16 GB).");
  assert.equal(resizeMessage("large", true), "Continue where you left off. The sandbox is now Large (8 vCPU, 16 GB). Run heavy test suites one at a time.");
  const all = (["small", "default", "large", "xlarge"] as const).map((type) => ({ type, available: true }));
  const trial = all.map((size) => ({ ...size, available: size.type === "small" || size.type === "default" }));
  assert.equal(suggestedSize("default", all, "large"), "large");
  assert.equal(suggestedSize("default", all, null), "large");
  assert.equal(suggestedSize("default", trial, null), "small");
  assert.equal(suggestedSize("xlarge", all, null), "small");
  assert.equal(isSmaller("small", "default"), true);
  assert.equal(isSmaller("large", null), false);

  const rec = (reason: "near-limit" | "out-of-memory" | "fits" | "largest", extra: Record<string, unknown> = {}) => ({
    type: reason === "fits" ? ("default" as const) : reason === "largest" ? ("xlarge" as const) : ("large" as const),
    label: reason === "fits" ? "Default" : reason === "largest" ? "XLarge" : "Large",
    current: reason === "largest" ? ("xlarge" as const) : ("default" as const),
    reason,
    allowed: true,
    planReason: null,
    ...extra,
  });
  const peak = { shared: false };
  assert.equal(peakSentence({ peak, recommendation: rec("fits"), project: null }), "Recommended size: Default. The check fits with room to spare.");
  assert.equal(
    peakSentence({ peak, recommendation: rec("near-limit"), project: null }),
    "Recommended size: Large. The sandbox used over 75% of its memory during the check. Next time, pick Large under More options in New task.",
  );
  assert.match(peakSentence({ peak, recommendation: rec("out-of-memory"), project: { name: "Web app", effective: "default" } }), /^Recommended size: Large\. The sandbox ran out of memory during the check\.$/);
  assert.equal(peakSentence({ peak, recommendation: rec("largest"), project: null }), "XLarge is the largest size. Run fewer tests at once.");
  assert.equal(
    peakSentence({ peak, recommendation: rec("near-limit", { allowed: false, planReason: "not during the free trial; the first payment unlocks it" }), project: null }),
    "Recommended size: Large. The sandbox used over 75% of its memory during the check. Your boat plan doesn't include Large: not during the free trial; the first payment unlocks it.",
  );
  assert.match(peakSentence({ peak, recommendation: rec("near-limit"), project: { name: "Web app", effective: "large" } }), /Web app already uses Large sandboxes\.$/);
  assert.match(peakSentence({ peak: { shared: true }, recommendation: rec("near-limit"), project: null }), /Other tasks worked on this sandbox meanwhile, so part of it is theirs\./);
});
