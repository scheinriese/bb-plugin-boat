import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type Database from "better-sqlite3";
import { TaskStore } from "../src/store.ts";
import { normalizeDecisionOptions, decisionOptionInputSchema, historyInputSchema } from "../contract-fidelity.ts";
import { parseSandboxUsage, parseUsagePlan, usageWindows } from "../src/usage.ts";
import { reviewFindings } from "../src/history.ts";
import { fidelityHandlers } from "../src/rpc-fidelity.ts";
import { sidebarState } from "../src/sidebar.ts";
import { makeService, memoryStore } from "./fakes.ts";

function dbStore() {
  const db = new DatabaseSync(":memory:");
  for (const sql of TaskStore.migrations()) db.exec(sql);
  return { db, store: new TaskStore(() => db as unknown as Database.Database) };
}

test("decision migration preserves IDs, old string consumers and closed rows", () => {
  const { db, store } = dbStore();
  db.prepare(`INSERT INTO decisions (id,question,recommendation,options,task_ids,status,answer,created_at,resolved_at) VALUES (?,?,?,?,?,?,?,?,?)`).run("d_old", "Which?", "B", '["A","B"]', '[]', "answered", "B", "2026-11-01", "2026-11-02");
  const old = store.decision("d_old")!;
  assert.equal(old.id, "d_old"); assert.equal(old.status, "answered"); assert.equal(old.answer, "B");
  assert.deepEqual(old.options, ["A", "B"]); assert.deepEqual(old.optionDetails, [{ label: "A" }, { label: "B" }]);
  assert.equal(old.context, null); assert.equal(old.askedByTaskId, null);
  const decision = store.addDecision({ orchestratorThreadId: "thr_demo", question: "Choose a limit", recommendation: "Generous", context: "The API uses this for each key.", shortLabel: "Pick a rate limit", options: ["Strict", { label: "Generous", facts: { Limit: "120/min", Cost: 0 }, verdict: { text: "Room to grow", tone: "good" }, recommended: true }], taskIds: [] });
  assert.equal(decision.shortLabel, "Pick a rate limit");
  assert.deepEqual(decision.options, ["Strict", "Generous"]); assert.equal(decision.optionDetails![1]!.recommended, true);
  assert.equal(store.history({ orchestratorThreadId: "thr_demo" }).events[0]!.decisionId, decision.id);
  assert.equal(store.resolveDecision(decision.id, "answered", "Generous")!.id, decision.id);
  assert.equal(store.resolveDecision(decision.id, "answered", "Strict"), null);
  assert.deepEqual(store.history({ orchestratorThreadId: "thr_demo" }).events.map((entry) => entry.kind), ["decision-answered", "needs-you"]);
});

test("decision boundary bounds and corrupt persisted options fail safely", () => {
  assert.deepEqual(normalizeDecisionOptions("bad json"), []);
  assert.deepEqual(normalizeDecisionOptions('[null,{},"A",{"label":"B","facts":{"Cost":2}}]'), [{ label: "A" }, { label: "B", facts: { Cost: 2 } }]);
  assert.equal(decisionOptionInputSchema.safeParse({ label: "A", facts: { x: Infinity } }).success, false);
  assert.equal(decisionOptionInputSchema.safeParse({ label: "A", facts: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i), i])) }).success, false);
});

test("history uses stable seq pages, offset-aware time bounds and private event exclusion", () => {
  const { db, store } = dbStore();
  for (const [kind, at, text] of [["ready", "2026-11-07T10:00:00Z", "Ready"], ["github-token", "2026-11-07T11:00:00Z", "secret"], ["shipped", "2026-11-07T12:00:00Z", "Shipped"], ["ready", "2026-11-07T13:00:00Z", "New ready"]]) {
    db.prepare(`INSERT INTO task_events(task_id,kind,at,text,metadata) VALUES ('',?,?,?,?)`).run(kind!, at!, text!, JSON.stringify({ orchestratorThreadId: "thr_one", source: "user" }));
  }
  const first = store.history({ orchestratorThreadId: "thr_one", limit: 1 });
  assert.equal(first.events[0]!.text, "New ready"); assert.ok(first.nextBeforeSeq);
  const next = store.history({ orchestratorThreadId: "thr_one", limit: 1, beforeSeq: first.nextBeforeSeq! });
  assert.equal(next.events[0]!.text, "Shipped");
  const tail = store.history({ orchestratorThreadId: "thr_one", beforeSeq: next.nextBeforeSeq! });
  assert.deepEqual(tail.events.map((entry) => entry.text), ["Ready"]); assert.equal(tail.nextBeforeSeq, null);
  assert.equal(store.history({ orchestratorThreadId: "thr_other" }).events.length, 0);
  assert.deepEqual(store.history({ since: "2026-11-07T12:00:00+02:00", until: "2026-11-07T13:00:00Z" }).events.map((entry) => entry.text), ["Shipped", "Ready"]);
  assert.equal(historyInputSchema.safeParse({ since: "2026-11-07T12:00:00+02:00", until: "2026-11-07T11:00:00Z" }).success, true);
  assert.throws(() => store.history({ limit: 201 }));
  assert.throws(() => store.history({ since: "invalid" }));
  assert.ok(!JSON.stringify(first).includes("secret"));
});

test("history scan is bounded even when private raw logs dominate", () => {
  const { db, store } = dbStore();
  const insert = db.prepare(`INSERT INTO task_events(task_id,kind,at,text) VALUES ('','chat-info','2026-11-07','hidden')`);
  for (let i = 0; i < 2002; i++) insert.run();
  const first = store.history(); assert.equal(first.events.length, 0); assert.ok(first.nextBeforeSeq);
  const tail = store.history({ beforeSeq: first.nextBeforeSeq! }); assert.equal(tail.nextBeforeSeq, null);
});

test("actual Boat limits and documented usage payload retain measured numbers and drop unrelated secrets", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/boat-json/limits-standard.json", import.meta.url), "utf8"));
  assert.deepEqual(parseUsagePlan(fixture), { name: "standard", hoursRemaining: 550, hoursTotal: 555.56, resetsAt: "2026-02-01T12:00:00.000Z" });
  assert.deepEqual(parseSandboxUsage({ ok: true, type: "sandbox.usage", sandboxId: "bx_23456789", sandboxType: "default", billingMultiplier: 1, since: "2026-09-01T00:00:00.000Z", until: "2026-09-14T09:30:00.000Z", seconds: 4980, dollars: 0.0498, secondsPerDollar: 100000, running: false, token: "hidden" }), { seconds: 4980, hours: 4980 / 3600, dollars: 0.0498, since: "2026-09-01T00:00:00.000Z", until: "2026-09-14T09:30:00.000Z", running: false });
  assert.equal(parseSandboxUsage({ seconds: -1, dollars: Infinity }).hours, null);
  assert.equal(parseSandboxUsage({ seconds: "4980", dollars: "0.0498" }).hours, null, "do not coerce unsupported payloads");
  assert.equal(parseUsagePlan({ creditBalanceHours: 550 }), null, "wallet and trial are not plan allocation");
  assert.equal(parseSandboxUsage({}).dollars, null);
  const windows = usageWindows(new Date("2026-11-07T10:00:00Z"), -60);
  assert.equal(windows.day.since, "2026-11-06T23:00:00.000Z"); assert.equal(windows.week.since, "2026-11-01T23:00:00.000Z");
});

test("structured review findings are explicit, bounded and optional for older reports", () => {
  assert.deepEqual(reviewFindings("Must fix: an issue"), []);
  assert.deepEqual(reviewFindings('FINDINGS: [{"severity":"must-fix","text":"Handle the empty cart","file":"src/cart.ts","line":12}]'), [{ severity: "must-fix", text: "Handle the empty cart", file: "src/cart.ts", line: 12 }]);
  assert.deepEqual(reviewFindings('FINDINGS: [{"severity":"bad","text":"Oops"}]'), []);
});

test("usage aggregates read-only facts, caches calls, and does not publish incomplete totals", async () => {
  const env = makeService(); let calls = 0;
  env.service.boat.usagePlan = async () => ({ name: "Standard", hoursRemaining: 475, hoursTotal: 555, resetsAt: "2026-11-30T00:00:00.000Z" });
  env.service.boat.list = async () => [{ id: "bx_demo" } as never];
  env.service.boat.usage = async (_id, window) => { calls++; return { seconds: 3600, hours: 1, dollars: 0.036, since: window?.since ?? null, until: window?.until ?? null, running: true }; };
  const handlers = fidelityHandlers({ service: env.service });
  const result = await handlers.fidelityUsage({ timezoneOffsetMinutes: 0 });
  assert.equal(result.sandboxes![0]!.hours, 1); assert.equal(result.week.hours, 1); assert.equal(result.day.dollars, 0.036); assert.equal(result.missing.length, 0);
  await handlers.fidelityUsage({ timezoneOffsetMinutes: 0 }); assert.equal(calls, 2);
  env.service.boat.usage = async () => { throw new Error("private account details"); };
  const failed = await fidelityHandlers({ service: env.service }).fidelityUsage({ timezoneOffsetMinutes: 0 });
  assert.equal(failed.day.hours, null); assert.equal(failed.week.dollars, null); assert.equal(failed.missing.length, 2);
  assert.ok(!JSON.stringify(failed).includes("private account"));
});

test("sidebar v1 is independent, stable and exposes no operational secrets", async () => {
  const env = makeService(); env.store.addOrchestrator("thr_demo", { id: "storefront", name: "Storefront" });
  const first = sidebarState(env.service); assert.equal(first.version, 1); assert.equal(first.threads[0]!.role, "orchestrator");
  assert.equal(sidebarState(env.service).revision, first.revision);
  env.store.addDecision({ orchestratorThreadId: "thr_demo", question: "Choose a limit", recommendation: "Generous", options: ["Generous"], taskIds: [] });
  const next = sidebarState(env.service); assert.notEqual(next.revision, first.revision);
  assert.equal(next.threads[0]!.rollup!.needsYou, 1); assert.equal(next.threads[0]!.status, "needs-you");
  assert.ok(!JSON.stringify(next).includes("sandboxId"));
});

test("structured decision CLI, agent tool and RPC preserve their shared boundary", async (t) => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createTestHost } = await import("./fakes.ts");
  const { default: plugin } = await import("../server.ts");
  const dir = mkdtempSync(join(tmpdir(), "boat-data-rpc-"));
  process.env.FAKE_BOAT_STATE = join(dir, "state.json");
  const { bb, harness } = await createTestHost({ pluginId: "boat", settings: { boatPath: new URL("./fixtures/fake-boat.mjs", import.meta.url).pathname, evidenceUploader: "" }, agentSkillIds: ["boat", "boat-orchestrator"] });
  harness.sdk.stub("threads.get", async () => ({ id: "thr_demo", environmentId: null, deletedAt: null, archivedAt: null }));
  harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_demo" }));
  await plugin(bb); t.after(() => harness.lifecycle.dispose());
  const cli = await harness.runCli(["decision", "add", "--question", "Choose a limit", "--recommendation", "Generous", "--option", "Strict", "--option", JSON.stringify({ label: "Generous", facts: { Limit: "120/min" }, verdict: { label: "Busiest client", text: "Room to grow", tone: "good" }, recommended: true }), "--context", "Applies per API key", "--thread", "thr_demo", "--json"]);
  assert.equal(cli.exitCode, 0, cli.stderr);
  const created = JSON.parse(cli.stdout); assert.deepEqual(created.options, ["Strict", "Generous"]);
  assert.equal(created.optionDetails[1].verdict.label, "Busiest client");
  const decision = await harness.callRpc("decision", { id: created.id }) as { decision: typeof created };
  assert.equal(decision.decision.context, "Applies per API key");
  const board = await harness.callRpc("board", { threadId: "thr_demo" }) as { needsYou: typeof created[] };
  assert.equal(board.needsYou[0]!.optionDetails[1].recommended, true);
  const history = await harness.callRpc("history", { orchestratorThreadId: "thr_demo" }) as { events: { kind: string }[] };
  assert.equal(history.events[0]!.kind, "needs-you");
  await harness.callAgentTool("boat_needs_you", { question: "Choose a size", recommendation: "Default", options: [{ label: "Default", recommended: true }], context: "For the next task" }, { threadId: "thr_demo" });
  const all = await harness.callRpc("board", { threadId: "thr_demo" }) as { needsYou: typeof created[] };
  assert.equal(all.needsYou.length, 2);
  assert.ok(all.needsYou.some((entry) => entry.optionDetails[0]?.label === "Default"));
  const bad = await harness.runCli(["decision", "add", "--question", "Choose again", "--recommendation", "A", "--option", '{"label":null}', "--json"]);
  assert.notEqual(bad.exitCode, 0);
  const sidebar = await harness.callRpc("sidebarState", { version: 1 }) as { version: number };
  assert.equal(sidebar.version, 1);
});
