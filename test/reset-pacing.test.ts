// A usage limit's reset without a wake storm: bb 0.49's consent question declined for Boat's
// own chats (and Boat's paced resume after it), and reset retries that would wake a Boat
// sandbox spread 30 s apart at dispatch, on every bb version.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import {
  BOAT_RESET_REASON,
  DECLINE_REASON,
  RESET_GAP_MS,
  RESET_RESUMES_KEY,
  SLOT_KEPT_MS,
  RETRY_CONSENT_METHOD,
  ResetLane,
  createResetPacing,
  failureResetAt,
  retryConsentInputSchema,
  retryConsentSchema,
  type ResetDispatch,
  type ResetPacingDeps,
} from "../src/reset-pacing.ts";
import { TaskStore } from "../src/store.ts";
import { createTestHost } from "./fakes.ts";

const NOW = Date.parse("2026-11-19T05:00:00Z");
const RESET = Date.parse("2026-11-19T09:00:00Z");
const BOAT_CHATS = new Set(["thr_task", "thr_review", "thr_orch"]);

function pacing(overrides: Partial<ResetPacingDeps> & { decisions?: unknown[] } = {}) {
  let at = NOW;
  const retries: { threadId: string; turnRequestId: string; sendAt: number; reason: string }[] = [];
  const values = new Map<string, unknown>();
  const decisions = overrides.decisions ?? [];
  const reads: string[] = [];
  const resets = createResetPacing({
    isBoatChat: (threadId) => BOAT_CHATS.has(threadId),
    decision: async (threadId) => {
      reads.push(threadId);
      return decisions.length > 1 ? decisions.shift() : decisions[0] ?? null;
    },
    retry: async (args) => { retries.push(args); return { ok: true }; },
    kv: { async get<T>(key: string) { return values.get(key) as T | undefined; }, async set(key: string, value: unknown) { values.set(key, structuredClone(value)); } },
    now: () => at,
    sleep: async (ms) => { at += ms; },
    ...overrides,
  });
  return { resets, retries, values, reads, advance: (ms: number) => { at += ms; }, now: () => at };
}

const consent = (threadId: string, reason: string, sendAt = RESET + 20_000, requestId = "req_1") => ({ threadId, requestId, reason, sendAt });

/** bb's turn.failed for a subscription limit, resetting at RESET. */
const limitFailure = (threadId: string, requestId = "req_1") => ({
  threadId, requestId, turnId: null, inputAccepted: true, attemptNumber: 1,
  errorInfo: { category: "rate-limit", httpStatusCode: 429 },
  rateLimits: { kind: "subscription-window", status: "blocked", windows: [{ status: "blocked", resetsAtMs: RESET }] },
});

test("bb 0.49's consent question: Boat declines a usage-limit retry of its own chats, and allows the rest", async () => {
  const { resets } = pacing();
  await resets.load();
  for (const threadId of BOAT_CHATS) assert.deepEqual(resets.consent(consent(threadId, "Rate limited", RESET + 20_000, `req_${threadId}`)), { kind: "decline", reason: DECLINE_REASON });
  // Overloads and server errors stay bb's quick retries.
  assert.deepEqual(resets.consent(consent("thr_task", "Provider overloaded", NOW + 5_000)), { kind: "allow" });
  assert.deepEqual(resets.consent(consent("thr_task", "Provider unavailable", NOW + 60_000)), { kind: "allow" });
  // Another account is ready now (the Account Pooler): no reset to wait for.
  assert.deepEqual(resets.consent(consent("thr_task", "Rate limited", NOW + 30_000)), { kind: "allow" });
  // Chats Boat doesn't run.
  assert.deepEqual(resets.consent(consent("thr_someone", "Rate limited")), { kind: "allow" });
  // The contract matches bb 0.49's provider-retry: its input parses, and both answers match its output schema.
  assert.ok(retryConsentInputSchema.safeParse({ threadId: "thr_task", requestId: "req_1", reason: "Rate limited", sendAt: RESET }).success);
  assert.ok(retryConsentSchema.safeParse({ kind: "decline", reason: DECLINE_REASON }).success);
  assert.ok(retryConsentSchema.safeParse({ kind: "allow" }).success);
});

test("after a decline provider retry recorded, Boat queues the stopped turn for the reset itself, once", async () => {
  const declined = { requestId: "req_1", observedAt: NOW, availability: { kind: "not-routed" }, decision: { kind: "decline", reason: "declined-by-sender" }, consent: { pluginId: "boat", answer: { kind: "decline", reason: DECLINE_REASON } } };
  // The decision for an older failure first, then this one's.
  const env = pacing({ decisions: [{ ...declined, requestId: "req_0" }, declined] });
  await env.resets.load();
  assert.equal(env.resets.consent(consent("thr_task", "Rate limited", RESET + 21_000)).kind, "decline");
  assert.equal(await env.resets.failed(limitFailure("thr_task")), "queued");
  assert.deepEqual(env.retries, [{ threadId: "thr_task", turnRequestId: "req_1", sendAt: RESET + 21_000, reason: BOAT_RESET_REASON }], "the time provider retry had planned; the dispatch hook spreads the wakes");
  // The same failure again (a second event, a restart): still one.
  assert.equal(await env.resets.failed(limitFailure("thr_task")), "skipped");
  assert.equal(env.retries.length, 1);
  assert.deepEqual(Object.keys((env.values.get(RESET_RESUMES_KEY) as { handled: Record<string, number> }).handled), ["req_1"]);
  // If the resumed turn stops at a limit again, it's provider retry's: one Boat resume per stopped turn.
  assert.deepEqual(env.resets.consent(consent("thr_task", "Rate limited", RESET + 5 * 3_600_000, "req_2")), { kind: "allow" });
  // A reload remembers that.
  const fresh = createResetPacing({ isBoatChat: (id) => BOAT_CHATS.has(id), decision: async () => null, retry: async () => undefined, kv: { get: async <T>(key: string) => env.values.get(key) as T, set: async () => undefined }, now: () => NOW + 60_000 });
  await fresh.load();
  assert.deepEqual(fresh.consent(consent("thr_task", "Rate limited", RESET + 5 * 3_600_000, "req_3")), { kind: "allow" });
});

test("the default consent polling sleep keeps an awaited failure alive", async () => {
  // No injected sleep: the timer must keep Node alive until the next poll.
  let clockReads = 0;
  const env = pacing({ sleep: undefined, now: () => clockReads++ < 2 ? NOW : NOW + 60_000 });
  assert.equal(await env.resets.failed(limitFailure("thr_task")), "skipped");
  assert.deepEqual(env.reads, [], "without consent no provider decision is read");
});

test("Boat never retries what provider retry kept, or what it can't confirm", async () => {
  // bb 0.50: no consent question, so nothing of Boat's to resume, and decision.get is never polled.
  const kept = pacing({ decisions: [{ requestId: "req_1", observedAt: NOW, availability: { kind: "not-routed" }, decision: { kind: "retry", reason: "Rate limited", sendAt: RESET + 20_000 } }] });
  assert.equal(await kept.resets.failed(limitFailure("thr_task")), "skipped");
  assert.deepEqual(kept.retries, []);
  assert.deepEqual(kept.reads, [], "not one decision.get");
  assert.ok(kept.now() - NOW <= 10_000, "it waited for the consent question at most 10 s");
  // Boat allowed it (an overload, a chat Boat resumed once): provider retry's, nothing read either.
  const allowed = pacing();
  await allowed.resets.load();
  allowed.resets.consent(consent("thr_task", "Provider overloaded", NOW + 5_000));
  assert.equal(await allowed.resets.failed(limitFailure("thr_task")), "skipped");
  assert.deepEqual(allowed.reads, []);
  // Boat declined, but bb counted a slow answer as "allow": provider retry queued it, Boat doesn't.
  const slow = pacing({ decisions: [{ requestId: "req_1", decision: { kind: "retry", reason: "Rate limited", sendAt: RESET + 20_000 } }] });
  await slow.resets.load();
  slow.resets.consent(consent("thr_task", "Rate limited"));
  assert.equal(await slow.resets.failed(limitFailure("thr_task")), "skipped");
  assert.deepEqual(slow.retries, []);
  // A skip of provider retry's own (beyond its maximum wait): not Boat's, even after Boat's decline.
  const skipped = pacing({ decisions: [{ requestId: "req_1", decision: { kind: "decline", reason: "beyond-maximum-wait" } }] });
  await skipped.resets.load();
  skipped.resets.consent(consent("thr_task", "Rate limited"));
  assert.equal(await skipped.resets.failed(limitFailure("thr_task")), "skipped");
  assert.deepEqual(skipped.retries, []);
  // Boat declined but provider retry recorded nothing readable: bb's queue decides.
  for (const [queued, outcome] of [[false, "queued"], [true, "skipped"], [null, "skipped"]] as const) {
    const unread = pacing({ decisions: [null], queuedRetry: async () => queued });
    await unread.resets.load();
    unread.resets.consent(consent("thr_task", "Rate limited"));
    assert.equal(await unread.resets.failed(limitFailure("thr_task")), outcome, `queue says ${queued}`);
    assert.equal(unread.retries.length, outcome === "queued" ? 1 : 0);
  }
  // Not a limit, or not Boat's chat: nothing is read at all.
  const other = pacing();
  assert.equal(await other.resets.failed({ ...limitFailure("thr_task"), errorInfo: { category: "overloaded", httpStatusCode: 529 } }), "skipped");
  assert.equal(await other.resets.failed(limitFailure("thr_someone")), "skipped");
  assert.deepEqual(other.reads, []);
  // bb refuses the retry for good (the chat moved on): not again.
  let calls = 0;
  const moved = pacing({ decisions: [{ requestId: "req_1", decision: { kind: "decline", reason: "declined-by-sender" } }], retry: async () => { calls += 1; throw new Error("409 no_failed_turn"); } });
  await moved.resets.load();
  moved.resets.consent(consent("thr_task", "Rate limited"));
  assert.equal(await moved.resets.failed(limitFailure("thr_task")), "skipped");
  assert.equal(await moved.resets.failed(limitFailure("thr_task")), "skipped");
  assert.equal(calls, 1);
  // A passing failure (bb restarting) is tried again, and the stopped turn still goes out once.
  let flaky = 0;
  const shaky = pacing({ decisions: [{ requestId: "req_1", decision: { kind: "decline", reason: "declined-by-sender" } }], retry: async () => { flaky += 1; if (flaky < 3) throw new Error("ECONNRESET"); } });
  await shaky.resets.load();
  shaky.resets.consent(consent("thr_task", "Rate limited"));
  assert.equal(await shaky.resets.failed(limitFailure("thr_task")), "queued");
  assert.equal(flaky, 3);
  // Out of tries: not remembered as done, so a repeat of the failure event can try again.
  let down = 0;
  const offline = pacing({ decisions: [{ requestId: "req_1", decision: { kind: "decline", reason: "declined-by-sender" } }], retry: async () => { down += 1; throw new Error("ECONNREFUSED"); } });
  await offline.resets.load();
  offline.resets.consent(consent("thr_task", "Rate limited"));
  assert.equal(await offline.resets.failed(limitFailure("thr_task")), "skipped");
  assert.equal(down, 3);
  assert.equal((offline.values.get(RESET_RESUMES_KEY) as { handled?: Record<string, number> } | undefined)?.handled?.req_1, undefined);
  // No answer of Boat's on record (a reload in between): Boat can't tell it declined, so it leaves the chat.
  const lost = pacing({ decisions: [{ requestId: "req_1", decision: { kind: "decline", reason: "declined-by-sender" } }] });
  assert.equal(await lost.resets.failed(limitFailure("thr_task")), "skipped");
  assert.deepEqual(lost.reads, []);
  assert.equal(failureResetAt({ rateLimits: { windows: [{ status: "ok", resetsAtMs: 1 }, { status: "blocked", resetsAtMs: 5 }] } }), 5);
});

test("the lane gives each machine its own slot, 30 s apart, kept across re-attempts and for a while after", () => {
  const lane = new ResetLane();
  assert.equal(RESET_GAP_MS, 30_000);
  assert.equal(lane.slot("host_1", RESET), RESET);
  assert.equal(lane.slot("host_2", RESET + 1_000), RESET + 30_000);
  assert.equal(lane.slot("host_3", RESET + 2_000), RESET + 60_000);
  assert.equal(lane.slot("host_2", RESET + 5_000), RESET + 30_000, "a re-attempt keeps its slot");
  // Never before the pacer's next free wake.
  assert.equal(lane.slot("host_4", RESET + 3_000, RESET + 5 * 60_000), RESET + 5 * 60_000);
  // A slot passed long ago: a new reset of that machine gets a new one.
  assert.equal(lane.slot("host_1", RESET + 10 * 60_000), RESET);
  assert.equal(lane.slot("host_1", RESET + SLOT_KEPT_MS + 60_000), RESET + SLOT_KEPT_MS + 60_000);
});

const suspendedBoat = { id: "host_1", machineProviderId: "boat-sandbox", lifecycle: { phase: "suspended" } };
const otherBoat = { id: "host_2", machineProviderId: "boat-sandbox", lifecycle: { phase: "suspended" } };
const resetRow = (id: string, reason = "Rate limited") => ({ id, payload: { kind: "retry", reason } });

test("at dispatch, reset retries that would wake a Boat sandbox go one machine every 30 s; everything else goes ahead", async () => {
  let wakeAt = RESET;
  const env = pacing({ nextWakeAt: async () => wakeAt });
  env.advance(RESET - NOW);
  const at = (rows: ResetDispatch["queuedMessages"], host: ResetDispatch["host"] = suspendedBoat) => env.resets.dispatch({ host, queuedMessages: rows });
  assert.equal(await at([resetRow("qm_1")]), null, "the first goes at once");
  assert.equal(await at([resetRow("qm_2")]), null, "another retry for the same machine goes in its slot");
  const second = await at([resetRow("qm_3")], otherBoat);
  assert.deepEqual(second, { action: "wait", reason: "Boat wakes at most 2 sandboxes a minute after a usage limit resets; this chat goes on at 09:00 UTC.", sendAt: RESET + 30_000 });
  const third = await at([resetRow("qm_4", BOAT_RESET_REASON)], { id: "host_3", machineProviderId: "boat-sandbox", lifecycle: { phase: "suspended" } });
  assert.equal(third?.sendAt, RESET + 60_000, "Boat's own resumes too");
  // A second row for the waiting machine shares its slot, it doesn't push the others back.
  assert.equal((await at([resetRow("qm_5")], otherBoat))?.sendAt, RESET + 30_000);
  // bb re-attempts at sendAt: both go.
  env.advance(30_000);
  assert.equal(await at([resetRow("qm_3")], otherBoat), null);
  assert.equal(await at([resetRow("qm_5")], otherBoat), null);
  // Not a reset retry that wakes a Boat sandbox: no wait.
  assert.equal(await at([resetRow("qm_6")], { id: "host_9", machineProviderId: "boat-sandbox", lifecycle: { phase: "active" } }), null, "the machine is up");
  assert.equal(await at([resetRow("qm_7")], { id: "host_8", machineProviderId: "local", lifecycle: { phase: "suspended" } }), null, "not a Boat sandbox");
  assert.equal(await at([resetRow("qm_8")], null), null);
  assert.equal(await at([resetRow("qm_9", "Provider unavailable")], { ...suspendedBoat, id: "host_7" }), null, "bb's quick retries");
  assert.equal(await at([resetRow("qm_10"), { id: "qm_11", payload: { kind: "inline" } }], { ...suspendedBoat, id: "host_6" }), null, "never holds what someone sent");
  assert.equal(await at([], { ...suspendedBoat, id: "host_5" }), null, "an inline send");
  // The shared wake pacing pauses (a failed wake, the paid resume's hold): the next slot waits for it.
  wakeAt = env.now() + 4 * 60_000;
  assert.equal((await at([resetRow("qm_12")], { ...suspendedBoat, id: "host_4" }))?.sendAt, wakeAt);
});

test("in the plugin: the consent RPC answers provider retry, and the dispatch hook spreads reset retries", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-19T12:00:00.000Z") });
  process.env.FAKE_BOAT_STATE = join(mkdtempSync(join(tmpdir(), "boat-reset-")), "state.json");
  const { bb, harness } = await createTestHost({
    pluginId: "boat",
    settings: { boatPath: fileURLToPath(new URL("../src/providers/boat/fixtures/fake-boat.mjs", import.meta.url)), evidenceUploader: "" },
    agentSkillIds: ["boat", "boat-orchestrator"],
  });
  t.after(() => harness.lifecycle.dispose());
  harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_1" }));
  await plugin(bb);
  // An orchestrator, as the plugin's own store holds one.
  new TaskStore(() => bb.storage.database()).addOrchestrator("thr_orch");
  const caller = { experimental_caller: { kind: "plugin" as const, pluginId: "provider-retry" } };
  const later = Date.now() + 4 * 3_600_000;
  assert.deepEqual(await harness.callRpc(RETRY_CONSENT_METHOD, { threadId: "thr_orch", requestId: "req_1", reason: "Rate limited", sendAt: later }, caller), { kind: "decline", reason: DECLINE_REASON });
  assert.deepEqual(await harness.callRpc(RETRY_CONSENT_METHOD, { threadId: "thr_orch", requestId: "req_2", reason: "Provider overloaded", sendAt: Date.now() + 5_000 }, caller), { kind: "allow" });
  assert.deepEqual(await harness.callRpc(RETRY_CONSENT_METHOD, { threadId: "thr_plain", requestId: "req_3", reason: "Rate limited", sendAt: later }, caller), { kind: "allow" });
  const hook = harness.inspection.registrations.hooks["message.dispatch"]!;
  const context = (id: string, hostId: string) =>
    makeMessageDispatchHookContext({
      host: { id: hostId, machineProviderId: "boat-sandbox", lifecycle: { phase: "suspended", message: null, pendingLog: "", suspendedAt: Date.now(), teardown: null } },
      queuedMessages: [{ id, payload: { kind: "retry", reason: "Rate limited", attempt: 2, retryOfTurnRequestId: "req_0" } }],
    });
  const first = await hook(context("qm_1", "host_a"));
  assert.equal(first.action, "proceed");
  assert.equal((await hook(context("qm_2", "host_a"))).action, "proceed", "the same machine: its slot");
  const second = await hook(context("qm_3", "host_b"));
  assert.equal(second.action, "wait");
  assert.match((second as { reason: string }).reason, /^Boat wakes at most 2 sandboxes a minute after a usage limit resets; this chat goes on at \d\d:\d\d UTC\.$/);
});
