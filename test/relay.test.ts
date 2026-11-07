// The relay: orchestrators move between Claude and Codex around usage limits,
// and new workers start on an agent with room.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import plugin from "../server.ts";
import { DEFAULT_LIMIT_MS, createLimitTracker, limitFromErrorText, limitFromTurnFailure } from "../src/limits.ts";
import { applyLimitFlags, bindingWindow, createQuotaReader, pickAgentQuota, type AgentQuota, type Quotas } from "../src/quota.ts";
import {
  HANDOFF_WAIT_MS,
  NOTE_START_GRACE_MS,
  agentWithRoom,
  decideRelay,
  handoffRequest,
  relayNote,
  retryDelay,
  type OrchestratorView,
  type RelaySettings,
} from "../src/relay.ts";
import { TaskError } from "../src/service.ts";
import { DEFAULT_TIERS } from "../src/tiers.ts";
import type { Provider } from "../src/store.ts";
import { makeService, createTestHost } from "./fakes.ts";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const SETTINGS: RelaySettings = { enabled: true, preferred: "claude", switchAtPercent: 90, switchBackBelowPercent: 50, quietMinutes: 10 };

function quotas(claude: number | null, codex: number | null): Quotas {
  const map: Quotas = new Map();
  const add = (provider: Provider, usedPercent: number | null) => {
    if (usedPercent !== null) map.set(provider, { provider, usedPercent, resetsAt: "2026-11-12T00:00:00Z", window: "Weekly limit" } satisfies AgentQuota);
  };
  add("claude", claude);
  add("codex", codex);
  return map;
}

function view(overrides: Partial<OrchestratorView> = {}): OrchestratorView {
  return { threadId: "thr_o", provider: "claude", status: "idle", updatedAt: NOW - 60 * 60_000, archived: false, hasProject: true, ...overrides };
}

test("an orchestrator near its limit asks for a handoff note, at a quiet moment", () => {
  assert.deepEqual(decideRelay(view(), quotas(40, 0), null, SETTINGS, NOW), { kind: "none" });
  const near = decideRelay(view(), quotas(92, 10), null, SETTINGS, NOW);
  assert.equal(near.kind, "request-handoff");
  assert.equal(near.kind === "request-handoff" && near.to, "codex");
  assert.match(near.kind === "request-handoff" ? near.reason : "", /^Claude is at 92% of its weekly limit/);
  // Mid-turn (or stopping): wait for the turn to end.
  assert.deepEqual(decideRelay(view({ status: "active" }), quotas(92, 10), null, SETTINGS, NOW), { kind: "none" });
  assert.deepEqual(decideRelay(view({ status: "stopping" }), quotas(92, 10), null, SETTINGS, NOW), { kind: "none" });
  // Off, archived or another agent: nothing.
  assert.deepEqual(decideRelay(view(), quotas(92, 10), null, { ...SETTINGS, enabled: false }, NOW), { kind: "none" });
  assert.deepEqual(decideRelay(view({ archived: true }), quotas(92, 10), null, SETTINGS, NOW), { kind: "none" });
  assert.deepEqual(decideRelay(view({ provider: null }), quotas(92, 10), null, SETTINGS, NOW), { kind: "none" });
  // No project: it can't be restarted elsewhere, so it says so instead of asking for a note.
  assert.deepEqual(decideRelay(view({ hasProject: false }), quotas(92, 10), null, SETTINGS, NOW), { kind: "stuck", reason: "it has no project to restart it with" });
});

test("an agent that hit its limit reads as full until it lifts, so the other takes over at once", () => {
  assert.equal(decideRelay(view(), quotas(100, 10), null, SETTINGS, NOW).kind, "take-over");
  // bb reported a limit hit for Claude; no usage source knows either agent.
  const flagged = applyLimitFlags(quotas(null, null), { claude: NOW + 3_600_000 });
  assert.equal(flagged.get("claude")?.usedPercent, 100);
  const taken = decideRelay(view({ status: "error" }), flagged, null, SETTINGS, NOW);
  assert.equal(taken.kind, "take-over");
  assert.match(taken.kind === "take-over" ? taken.reason : "", /^Claude hit its usage limit \(until about /);
  // A stale low reading doesn't hide a real limit hit.
  assert.equal(applyLimitFlags(quotas(40, null), { claude: NOW + 1 }).get("claude")?.usedPercent, 100);
  // An error that isn't a limit isn't the relay's business.
  assert.deepEqual(decideRelay(view({ status: "error" }), quotas(50, 10), null, SETTINGS, NOW), { kind: "none" });
  // Both out after limit hits: wait (no ping-pong between two agents that are out).
  const both = applyLimitFlags(quotas(null, null), { claude: NOW + 1, codex: NOW + 1 });
  assert.equal(decideRelay(view({ provider: "codex", status: "error" }), both, null, SETTINGS, NOW).kind, "both-out");
});

test("a requested note is waited for, but not forever", () => {
  const since = NOW - 60_000;
  const state = { phase: "handoff-requested" as const, to: "codex" as const, reason: "Claude is at 92%", since };
  // The turn hasn't started yet: not answered.
  assert.deepEqual(decideRelay(view({ updatedAt: since - 1 }), quotas(92, 10), state, SETTINGS, NOW), { kind: "none" });
  // Writing it.
  assert.deepEqual(decideRelay(view({ status: "active", updatedAt: NOW }), quotas(92, 10), state, SETTINGS, NOW), { kind: "none" });
  // Written (bb said the turn ended with the note): take over.
  assert.deepEqual(decideRelay(view({ updatedAt: since - 1 }), quotas(92, 10), { ...state, note: "Handoff", noteAt: NOW - 1_000 }, SETTINGS, NOW), {
    kind: "take-over",
    to: "codex",
    reason: "Claude is at 92%",
  });
  assert.equal(decideRelay(view({ updatedAt: NOW - 1_000 }), quotas(92, 10), state, SETTINGS, NOW).kind, "take-over");
  // The chat never reacted: after a short grace, take over anyway.
  assert.equal(decideRelay(view({ updatedAt: since - 1 }), quotas(92, 10), { ...state, since: NOW - NOTE_START_GRACE_MS - 1 }, SETTINGS, NOW).kind, "take-over");
  // Still busy long after: take over (the old turn is stopped first).
  assert.equal(decideRelay(view({ status: "active", updatedAt: NOW }), quotas(92, 10), { ...state, since: NOW - HANDOFF_WAIT_MS - 1 }, SETTINGS, NOW).kind, "take-over");
  // A hand-over asked for by hand finishes even with the relay off, or with an agent the relay doesn't know.
  assert.equal(decideRelay(view({ updatedAt: NOW - 1_000 }), quotas(92, 10), state, { ...SETTINGS, enabled: false }, NOW).kind, "take-over");
  assert.equal(decideRelay(view({ provider: null, updatedAt: NOW - 1_000 }), quotas(null, null), state, SETTINGS, NOW).kind, "take-over");
  // The target filled up meanwhile: no move onto a full agent.
  assert.equal(decideRelay(view({ updatedAt: NOW - 1_000 }), quotas(92, 95), state, SETTINGS, NOW).kind, "both-out");
});

test("with both agents near their limits it waits once, without paid extra usage", () => {
  const both = decideRelay(view(), quotas(95, 93), null, SETTINGS, NOW);
  assert.equal(both.kind, "both-out");
  assert.match(both.kind === "both-out" ? both.reason : "", /Claude is at 95%.*; Codex is at 93%/);
  // Told once per episode.
  assert.deepEqual(decideRelay(view(), quotas(95, 93), { phase: "both-out", since: NOW - 60_000 }, SETTINGS, NOW), { kind: "none" });
  // An unknown reading counts as room, as for new workers (a limit hit would mark it full).
  assert.equal(decideRelay(view(), quotas(95, null), null, SETTINGS, NOW).kind, "request-handoff");
  // A reset on the other side ends the wait.
  assert.equal(decideRelay(view(), quotas(95, 5), { phase: "both-out", since: NOW - 60_000 }, SETTINGS, NOW).kind, "request-handoff");
});

test("a failed take-over backs off before trying again", () => {
  const failed = { phase: "failed" as const, to: "codex" as const, reason: "x", attempts: 2, retryAt: NOW + 60_000, error: "spawn failed" };
  assert.deepEqual(decideRelay(view(), quotas(100, 10), failed, SETTINGS, NOW), { kind: "none" });
  assert.equal(decideRelay(view(), quotas(100, 10), { ...failed, retryAt: NOW - 1 }, SETTINGS, NOW).kind, "take-over");
  assert.deepEqual([1, 2, 3, 7, 9].map((attempts) => retryDelay(attempts) / 60_000), [1, 2, 4, 60, 60]);
  assert.equal(relayNote(failed, { kind: "none" }, NOW), "couldn't move to Codex; trying again soon");
  assert.equal(relayNote(null, { kind: "stuck", reason: "it has no project" }, NOW), "can't move: it has no project");
});

test("back to the preferred agent once it has room, when the chat has been quiet", () => {
  const onCodex = view({ provider: "codex" });
  const back = decideRelay(onCodex, quotas(30, 60), null, SETTINGS, NOW);
  assert.equal(back.kind, "request-handoff");
  assert.equal(back.kind === "request-handoff" && back.to, "claude");
  assert.match(back.kind === "request-handoff" ? back.reason : "", /Claude has room again \(30% of its weekly limit used\)/);
  // Not yet below the hand-back mark, busy, recently active, or just switched: stay.
  assert.deepEqual(decideRelay(onCodex, quotas(60, 60), null, SETTINGS, NOW), { kind: "none" });
  assert.deepEqual(decideRelay(view({ provider: "codex", status: "active" }), quotas(30, 60), null, SETTINGS, NOW), { kind: "none" });
  assert.deepEqual(decideRelay(view({ provider: "codex", updatedAt: NOW - 60_000 }), quotas(30, 60), null, SETTINGS, NOW), { kind: "none" });
  assert.deepEqual(decideRelay(onCodex, quotas(30, 60), { phase: "cooldown", until: NOW + 60_000 }, SETTINGS, NOW), { kind: "none" });
  // An unknown reading for the preferred agent doesn't move anything.
  assert.deepEqual(decideRelay(onCodex, quotas(null, 60), null, SETTINGS, NOW), { kind: "none" });
});

test("limit hits come from bb's failure events, with the reset time when bb knows it", async () => {
  const reset = NOW + 2 * 3_600_000;
  assert.equal(
    limitFromTurnFailure(
      { errorInfo: { category: "rate-limit" }, rateLimits: { kind: "subscription-window", status: "blocked", providerId: "claude-code", windows: [{ status: "blocked", resetsAtMs: reset }, { status: "allowed", resetsAtMs: reset + 99 }] } },
      NOW,
    ),
    reset,
  );
  assert.equal(limitFromTurnFailure({ errorInfo: { category: "billing" }, rateLimits: null }, NOW), NOW + DEFAULT_LIMIT_MS);
  // Overloads and disconnects are bb's to retry, not limits.
  assert.equal(limitFromTurnFailure({ errorInfo: { category: "overloaded" }, rateLimits: { kind: "subscription-window", status: "allowed", windows: [] } }, NOW), null);
  assert.equal(limitFromTurnFailure({ errorInfo: { category: "rate-limit" }, rateLimits: null }, NOW), null);
  assert.equal(limitFromErrorText("You've hit your usage limit. Try again at 8pm.", NOW), NOW + DEFAULT_LIMIT_MS);
  assert.equal(limitFromErrorText("Connection reset by peer", NOW), null);

  const kv = new Map<string, unknown>();
  const tracker = createLimitTracker({ get: async (key) => (kv.get(key) as never) ?? null, set: async (key, value) => void kv.set(key, value) });
  await tracker.record("claude", NOW + 10);
  await tracker.record("claude", NOW + 5); // an earlier end doesn't shorten it
  assert.deepEqual(await tracker.active(NOW), { claude: NOW + 10 });
  assert.deepEqual(await tracker.active(NOW + 11), {});
  // It survives a restart.
  const again = createLimitTracker({ get: async (key) => (kv.get(key) as never) ?? null, set: async () => undefined });
  assert.deepEqual(await again.active(NOW), { claude: NOW + 10 });
});

test("the note request and the relay's few words", () => {
  const text = handoffRequest("codex", "Claude is at 92% of its weekly limit");
  assert.match(text, /^\[boat relay\] Claude is at 92% of its weekly limit\. A Codex orchestrator takes over/);
  assert.match(text, /Don't dispatch, follow up or close anything else\./);
  assert.equal(relayNote({ phase: "handoff-requested", to: "codex", reason: "x", since: NOW }, { kind: "none" }, NOW), "writing a handoff note for Codex");
  assert.equal(relayNote(null, { kind: "request-handoff", to: "claude", reason: "x" }, NOW), "moves to Claude at the next check");
  assert.equal(relayNote({ phase: "cooldown", until: NOW - 1 }, { kind: "none" }, NOW), null);
});

test("new workers start on an agent with room", () => {
  assert.equal(agentWithRoom("claude", quotas(40, 0), 90), "claude");
  assert.equal(agentWithRoom("claude", quotas(95, 0), 90), "codex");
  assert.equal(agentWithRoom("claude", quotas(95, 92), 90), null);
  // Unknown usage counts as room (the readings may be off).
  assert.equal(agentWithRoom("codex", quotas(null, null), 90), "codex");
});

test("usage readings: the binding window, the freest pooled account, the first source that knows", async () => {
  assert.deepEqual(
    bindingWindow([
      { label: "5-hour limit", usedPercent: 20, resetsAt: "a", model: null },
      { label: "Weekly limit", usedPercent: 61, resetsAt: "b", model: null },
      // A model-only cap (e.g. Fable) doesn't block the agent.
      { label: "Fable weekly", usedPercent: 99, resetsAt: "c", model: "claude-fable-5-1" },
    ]),
    { usedPercent: 61, resetsAt: "b", label: "Weekly limit" },
  );
  assert.equal(bindingWindow([{ usedPercent: 99, model: "x" }]), null);
  assert.equal(pickAgentQuota("claude", [{ usedPercent: 80, resetsAt: null, label: "Weekly limit" }, { usedPercent: 12, resetsAt: null, label: "Weekly limit" }])?.usedPercent, 12);

  const calls: string[] = [];
  const bb = {
    sdk: {
      plugins: {
        async callRpc({ pluginId, method, input }: { pluginId: string; method: string; input: { resourceId?: string } }) {
          calls.push(`${pluginId} ${method}`);
          if (pluginId === "account-pool") throw new Error("plugin account-pool is not installed");
          if (method.endsWith("listResources")) {
            return { resources: [{ id: `${pluginId}:1`, providerId: pluginId === "provider-codex" ? "codex" : "claude-code" }] };
          }
          if (input.resourceId === "provider-codex:1") return { usage: { status: "error", windows: [] } };
          return { usage: { status: "ok", windows: [{ label: "Weekly limit", usedPercent: 21, resetsAt: "2026-11-12T00:00:00Z", model: null }] } };
        },
      },
    },
  };
  const reader = createQuotaReader(bb as never);
  const read = await reader.read();
  assert.deepEqual([...read.keys()], ["claude"]);
  assert.equal(read.get("claude")?.usedPercent, 21);
  assert.deepEqual(calls, [
    "account-pool status.get",
    "provider-claude-code provider-usage.v1.listResources",
    "provider-claude-code provider-usage.v1.getResource",
    "provider-codex provider-usage.v1.listResources",
    "provider-codex provider-usage.v1.getResource",
  ]);
  // Cached for a minute.
  await reader.read();
  assert.equal(calls.length, 5);
});

test("Account Pooler readings count only for the agents it routes, and only its enabled accounts", async () => {
  const usage: Record<string, number> = { "pool-claude-1": 15, "pool-claude-off": 2, "pool-codex": 3, "host-codex": 88 };
  const bb = {
    sdk: {
      plugins: {
        async callRpc({ pluginId, method, input }: { pluginId: string; method: string; input: { resourceId?: string } }) {
          if (pluginId === "account-pool" && method === "status.get") {
            return {
              routing: { claude: true, codex: false },
              accounts: [
                { id: "pool-claude-1", provider: "claude", status: "ready" },
                { id: "pool-claude-off", provider: "claude", status: "disabled" },
                { id: "pool-codex", provider: "codex", status: "ready" },
              ],
            };
          }
          if (method.endsWith("listResources")) {
            if (pluginId === "account-pool") {
              return { resources: [{ id: "pool-claude-1", providerId: "claude-code" }, { id: "pool-claude-off", providerId: "claude-code" }, { id: "pool-codex", providerId: "codex" }] };
            }
            if (pluginId === "provider-codex") return { resources: [{ id: "host-codex", providerId: "codex" }] };
            return { resources: [] };
          }
          return { usage: { status: "ok", windows: [{ label: "Weekly limit", usedPercent: usage[input.resourceId!], resetsAt: null, model: null }] } };
        },
      },
    },
  };
  const read = await createQuotaReader(bb as never).read();
  // Claude: the enabled pooled account (not the disabled one at 2%).
  assert.equal(read.get("claude")?.usedPercent, 15);
  // Codex isn't routed through the pool: the host's own login counts.
  assert.equal(read.get("codex")?.usedPercent, 88);
  // A limit hit overrides the readings until it lifts.
  const flagged = await createQuotaReader(bb as never, { limits: async () => ({ claude: Date.now() + 60_000 }) }).read();
  assert.equal(flagged.get("claude")?.usedPercent, 100);
  assert.equal(flagged.get("claude")?.window, "Usage limit (hit)");
});

test("a worker's default agent gives way near its limit; both out stops new work", async () => {
  const env = makeService({ quotas: quotas(95, 10) });
  const brief = { title: "Header", role: "implement" as const, brief: "Do it.", repo: "acme/web", orchestratorThreadId: "thr_orch" };
  const { task } = await env.service.launchTask(brief, 5_000);
  assert.equal(task.provider, "codex");
  assert.ok(env.store.events(task.id, 20).some((event) => /Claude is near its usage limit, so Codex runs this task/.test(event.text)));
  // A named agent is the orchestrator's call (paid extra usage is then theirs to allow).
  const named = await makeService({ quotas: quotas(95, 10) }).service.launchTask({ ...brief, provider: "claude" }, 5_000);
  assert.equal(named.task.provider, "claude");

  const out = makeService({ quotas: quotas(95, 97) });
  await assert.rejects(out.service.launchTask(brief, 5_000), (error: unknown) => error instanceof TaskError && error.code === "agents_at_limit");
  // With paid extra usage allowed, it runs on the default.
  const allowed = makeService({ quotas: quotas(95, 97), settings: { avoidExtraUsage: false } });
  assert.equal((await allowed.service.launchTask(brief, 5_000)).task.provider, "claude");
  // With the relay off, the default agent stays, but "both out" still stops new work.
  const relayOff = { relay: { ...SETTINGS, enabled: false } };
  assert.equal((await makeService({ quotas: quotas(95, 10), settings: relayOff }).service.launchTask(brief, 5_000)).task.provider, "claude");
  await assert.rejects(
    makeService({ quotas: quotas(95, 97), settings: relayOff }).service.launchTask(brief, 5_000),
    (error: unknown) => error instanceof TaskError && error.code === "agents_at_limit",
  );
});

async function relayHost(t: { after(fn: () => unknown): void }, usage: { claude: number; codex: number }, settings: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "boat-relay-test-"));
  const statePath = join(dir, "state.json");
  process.env.FAKE_BOAT_STATE = statePath;
  const finishAll = (reply: string) => {
    const current = JSON.parse(readFileSync(statePath, "utf8"));
    for (const convo of Object.values(current.convos) as { running: boolean; reply: string | null; sandboxId: string }[]) {
      convo.running = false;
      convo.reply = reply;
      current.sandboxes[convo.sandboxId].state = "idle";
    }
    writeFileSync(statePath, JSON.stringify(current));
  };
  const { bb, harness } = await createTestHost({
    pluginId: "boat",
    // The relay is off by default (opt-in); these tests turn it on unless they say otherwise.
    settings: { boatPath: fileURLToPath(new URL("./fixtures/fake-boat.mjs", import.meta.url)), evidenceUploader: "", relayEnabled: true, ...settings },
    agentSkillIds: ["boat", "boat-orchestrator"],
  });
  t.after(() => harness.lifecycle.dispose());
  const threads = new Map<string, Record<string, unknown>>();
  const metadata = new Map<string, unknown>();
  let spawned = 0;
  harness.sdk.stub("threads.spawn", async (args: { pluginMetadata: unknown }) => {
    const id = ["thr_old", "thr_new", "thr_third"][spawned++]!;
    metadata.set(id, args.pluginMetadata);
    threads.set(id, { id, title: "Storefront", providerId: "claude-code", status: "idle", updatedAt: Date.now() - 3_600_000, environmentId: "env_1", projectId: "proj_personal", sectionId: "sec_1", pinnedAt: null, archivedAt: null, deletedAt: null });
    return { id };
  });
  harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => threads.get(threadId) ?? { id: threadId, environmentId: null, deletedAt: null, archivedAt: null });
  harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => metadata.get(threadId) ?? {});
  harness.sdk.stub("threads.output", async () => ({ output: "Handoff: the header PR is open; waiting on the user for the font." }));
  harness.sdk.stub("threads.send", async () => ({ ok: true, delivery: "sent" }));
  harness.sdk.stub("threads.stop", async () => ({ ok: true }));
  // Waiting on the old chat: a plugin notice bb is retrying, and a message from the user.
  harness.sdk.stub("threads.queuedMessages.list", async ({ threadId }: { threadId: string }) =>
    threadId === "thr_old"
      ? [
          { id: "q_retry", initiator: "system", originPluginId: "provider-retry", payload: { kind: "retry" }, content: [{ type: "text", text: "[boat] Task t_x finished a turn." }] },
          { id: "q_user", initiator: "user", originPluginId: null, payload: { kind: "inline" }, content: [{ type: "text", text: "Also make the header sticky, please." }] },
        ]
      : [],
  );
  harness.sdk.stub("threads.updatePluginMetadata", async () => ({ ok: true }));
  harness.sdk.stub("threads.queuedMessages.delete", async () => ({ ok: true }));
  harness.sdk.stub("threads.archive", async ({ threadId }: { threadId: string }) => {
    threads.get(threadId)!.archivedAt = Date.now();
    return { ok: true };
  });
  harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_1" }));
  harness.sdk.stub("plugins.callRpc", async ({ pluginId, method, input }: { pluginId: string; method: string; input: { resourceId?: string } }) => {
    if (pluginId !== "account-pool") throw new Error("not installed");
    if (method === "status.get") {
      return { routing: { claude: true, codex: true }, accounts: [{ id: "c", provider: "claude", status: "ready" }, { id: "x", provider: "codex", status: "ready" }] };
    }
    if (method.endsWith("listResources")) return { resources: [{ id: "c", providerId: "claude-code" }, { id: "x", providerId: "codex" }] };
    const usedPercent = input.resourceId === "c" ? usage.claude : usage.codex;
    return { usage: { status: "ok", windows: [{ label: "Weekly limit", usedPercent, resetsAt: "2026-11-12T00:00:00Z", model: null }] } };
  });
  await plugin(bb);
  const added = await harness.runCli(["project", "add", "--name", "Storefront", "--repo", "acme/storefront@master", "--environment", "storefront"]);
  assert.equal(added.exitCode, 0, added.stderr);
  return { harness, threads, metadata, finishAll };
}

test("the plugin hands an orchestrator to Codex: note first, then a successor in the same workspace", async (t) => {
  const { harness, threads, finishAll } = await relayHost(t, { claude: 93, codex: 12 });

  await harness.callRpc("startOrchestrator", { project: { kind: "boat", id: "storefront" }, prompt: "Ship the about page", title: null, hostId: null, cloud: false });
  const started = await harness.runCli(["task", "start", "--title", "Header", "--repo", "acme/storefront", "--brief", "Do it.", "--json"], { threadId: "thr_old" });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  const { task } = JSON.parse(started.stdout) as { task: { id: string; provider: string } };
  // Claude is near its limit, so the worker runs on Codex.
  assert.equal(task.provider, "codex");

  const status = await harness.runCli(["relay", "status"]);
  assert.match(status.stdout, /Claude: 93% of the weekly limit used/);
  assert.match(status.stdout, /@thread:thr_old Storefront — Claude · moves to Codex at the next check/);

  // First the note.
  const first = JSON.parse((await harness.runCli(["relay", "check", "--json"])).stdout) as { actions: { kind: string }[] };
  assert.deepEqual(first.actions.map((action) => action.kind), ["requested-handoff"]);
  const request = harness.inspection.sdk.callsTo("threads.send").at(-1)![0] as { threadId: string; input: { text: string }[] };
  assert.equal(request.threadId, "thr_old");
  assert.match(request.input[0]!.text, /^\[boat relay\] Claude is at 93% of its weekly limit/);
  // Not answered yet: nothing happens.
  assert.deepEqual((JSON.parse((await harness.runCli(["relay", "check", "--json"])).stdout) as { actions: unknown[] }).actions, []);

  // The worker finishes while the note is being written: its notice waits for the successor.
  finishAll("Done.\n=== REPORT ===\nSTATUS: done\nPR: https://github.com/acme/storefront/pull/3\n=== END REPORT ===");
  await harness.runCli(["task", "show", task.id, "--refresh"]);
  const noticesToOld = () =>
    harness.inspection.sdk
      .callsTo("threads.send")
      .map((call) => call[0] as { threadId: string; input: { text: string }[] })
      .filter((call) => call.threadId === "thr_old" && call.input[0]!.text.startsWith("[boat] Task"));
  assert.equal(noticesToOld().length, 0);

  // The note is written: Codex takes over in the same workspace and section.
  threads.get("thr_old")!.updatedAt = Date.now() + 1_000;
  const second = JSON.parse((await harness.runCli(["relay", "check", "--json"])).stdout) as { actions: { kind: string; successor?: string }[] };
  assert.deepEqual(second.actions.map((action) => [action.kind, action.successor]), [["took-over", "thr_new"]]);
  const spawn = harness.inspection.sdk.callsTo("threads.spawn").at(-1)![0] as Record<string, unknown> & { prompt: string };
  assert.equal(spawn.providerId, "codex");
  assert.equal(spawn.model, "gpt-6.1-sol");
  assert.equal(spawn.reasoningLevel, "high");
  assert.deepEqual(spawn.environment, { type: "reuse", environmentId: "env_1" });
  assert.equal(spawn.sectionId, "sec_1");
  assert.equal(spawn.title, "Storefront · Codex");
  assert.match(spawn.prompt, /Codex switching moved this orchestrator to Codex: Claude is at 93%/);
  assert.match(spawn.prompt, /hands back to Claude on its own/);
  assert.match(spawn.prompt, /## Taking over from @thread:thr_old/);
  assert.match(spawn.prompt, /the header PR is open/);
  // The user's waiting message moves along; the plugin's own notice doesn't (it's re-sent).
  assert.match(spawn.prompt, /## Messages from the user it hadn't answered yet[\s\S]*> Also make the header sticky, please\./);
  assert.doesNotMatch(spawn.prompt, /> \[boat\] Task t_x/);
  // The old chat stops being an orchestrator.
  assert.ok(
    harness.inspection.sdk
      .callsTo("threads.updatePluginMetadata")
      .some((call) => (call[0] as { threadId: string; set?: { role?: string } }).threadId === "thr_old" && (call[0] as { set?: { role?: string } }).set?.role === "former-orchestrator"),
  );
  assert.deepEqual(harness.inspection.sdk.callsTo("threads.archive").map((call) => (call[0] as { threadId: string }).threadId), ["thr_old"]);
  // A provider handoff stays in chat; no progress push is sent.
  const pushes = harness.inspection.sdk.callsTo("plugins.callRpc").map((call) => call[0] as { pluginId: string; input: { title?: string } });
  assert.equal(pushes.some((call) => call.pluginId === "push-notifications" && call.input.title === "Storefront moved to Codex"), false, "provider handoffs stay quiet; pushes are only for needs you and ready");
  // Nothing queued can wake the old chat later.
  assert.ok(harness.inspection.sdk.callsTo("threads.queuedMessages.delete").some((call) => (call[0] as { queuedMessageId: string }).queuedMessageId === "q_retry"));

  // The task reports to the successor; the old chat is no longer an orchestrator.
  const shown = JSON.parse((await harness.runCli(["task", "show", task.id, "--json"])).stdout) as { task: { orchestratorThreadId: string } };
  assert.equal(shown.task.orchestratorThreadId, "thr_new");
  const relay = (await harness.callRpc("relay", null)) as { agents: { provider: string; usedPercent: number }[]; orchestrators: { threadId: string; note: string | null }[] };
  assert.deepEqual(relay.agents.map((agent) => [agent.provider, agent.usedPercent]), [["claude", 93], ["codex", 12]]);
  assert.deepEqual(relay.orchestrators.map((row) => row.threadId), ["thr_new"]);

  // Outcome delivery also waits for the asynchronous final memory sample.
  // Keep refreshing the real task until its actual notice reaches the successor.
  const deliveredToSuccessor = () => harness.inspection.sdk.callsTo("threads.send").some(
    (call) => (call[0] as { threadId: string; input: { text: string }[] }).threadId === "thr_new" &&
      (call[0] as { input: { text: string }[] }).input[0]!.text.startsWith(`[boat] Task ${task.id}`),
  );
  for (let attempt = 0; attempt < 20 && !deliveredToSuccessor(); attempt++) {
    await harness.runCli(["task", "show", task.id, "--refresh"]);
    if (!deliveredToSuccessor()) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(noticesToOld().length, 0);
  assert.ok(
    harness.inspection.sdk
      .callsTo("threads.send")
      .some((call) => (call[0] as { threadId: string; input: { text: string }[] }).threadId === "thr_new" && (call[0] as { input: { text: string }[] }).input[0]!.text.startsWith(`[boat] Task ${task.id}`)),
  );

  // The successor (still on Claude in this fake) is in its cooldown: no ping-pong.
  assert.deepEqual((JSON.parse((await harness.runCli(["relay", "check", "--json"])).stdout) as { actions: unknown[] }).actions, []);
});

test("a manual take-over retires the old orchestrator, and a hand-over asked for by hand finishes with the relay off", async (t) => {
  const { harness, threads } = await relayHost(t, { claude: 93, codex: 12 }, { relayEnabled: false });
  await harness.callRpc("startOrchestrator", { project: { kind: "boat", id: "storefront" }, prompt: "Ship it", title: null, hostId: null, cloud: false });
  // The user starts a successor by hand ("Take over from").
  await harness.callRpc("startOrchestrator", { project: { kind: "boat", id: "storefront" }, prompt: "Carry on", title: null, hostId: null, cloud: false, takeOverThreadId: "thr_old" });
  const retire = harness.inspection.sdk.callsTo("threads.updatePluginMetadata").map((call) => call[0] as { threadId: string; set?: { role?: string; successor?: string } });
  assert.ok(retire.some((call) => call.threadId === "thr_old" && call.set?.role === "former-orchestrator" && call.set.successor === "thr_new"));
  // The relay no longer sees the old chat (it would start a second successor).
  const status = await harness.runCli(["relay", "status", "--json"]);
  assert.deepEqual((JSON.parse(status.stdout) as { orchestrators: { threadId: string }[] }).orchestrators.map((row) => row.threadId), ["thr_new"]);

  // With the relay off, nothing moves on its own…
  assert.deepEqual((JSON.parse((await harness.runCli(["relay", "check", "--json"])).stdout) as { actions: unknown[] }).actions, []);
  // …but a switch asked for by hand completes.
  const switched = await harness.runCli(["relay", "switch", "thr_new", "--to", "codex", "--json"]);
  assert.equal(switched.exitCode, 0, switched.stderr);
  assert.equal((JSON.parse(switched.stdout) as { kind: string }).kind, "requested-handoff");
  threads.get("thr_new")!.updatedAt = Date.now() + 1_000;
  const done = JSON.parse((await harness.runCli(["relay", "check", "--json"])).stdout) as { actions: { kind: string }[] };
  assert.deepEqual(done.actions.map((action) => action.kind), ["took-over"]);
});

test("with one agent (Coding agents), the relay stays off and won't move an orchestrator to the other one", async (t) => {
  const { harness } = await relayHost(t, { claude: 93, codex: 12 }, { agents: "claude" });
  await harness.callRpc("startOrchestrator", { project: { kind: "boat", id: "storefront" }, prompt: "Ship it", title: null, hostId: null, cloud: false });
  // Near Claude's limit, nothing moves.
  assert.deepEqual((JSON.parse((await harness.runCli(["relay", "check", "--json"])).stdout) as { actions: unknown[] }).actions, []);
  const status = await harness.runCli(["relay", "status"]);
  assert.match(status.stdout, /Claude ↔ Codex switching off: only Claude is set up \(Coding agents\)/);
  assert.doesNotMatch(status.stdout, /Codex:/);
  const relay = (await harness.callRpc("relay", null)) as { enabled: boolean; onlyAgent: string | null; agents: { provider: string }[]; orchestrators: { note: string | null }[] };
  assert.equal(relay.enabled, false);
  assert.equal(relay.onlyAgent, "claude");
  assert.deepEqual(relay.agents.map((agent) => agent.provider), ["claude"]);
  assert.deepEqual(relay.orchestrators.map((row) => row.note), [null]);
  // A switch by hand to the missing agent is refused.
  const switched = await harness.runCli(["relay", "switch", "thr_old", "--to", "codex", "--json"]);
  assert.notEqual(switched.exitCode, 0);
  assert.equal(JSON.parse(switched.stdout).error.code, "agent_unavailable");
  // New workers don't go to Codex either: Claude is near its limit, so new work waits.
  const started = await harness.runCli(["task", "start", "--title", "Header", "--repo", "acme/storefront", "--brief", "Do it.", "--json"], { threadId: "thr_old" });
  assert.equal(JSON.parse(started.stdout).error.code, "agents_at_limit");
  // The overview tells the dialogs.
  const overview = (await harness.callRpc("overview", null)) as { defaults: { onlyAgent: string | null; reviewProvider: string } };
  assert.equal(overview.defaults.onlyAgent, "claude");
  assert.equal(overview.defaults.reviewProvider, "claude");
});

test("the relay is off unless turned on", async (t) => {
  const { harness } = await relayHost(t, { claude: 93, codex: 12 }, { relayEnabled: undefined });
  await harness.callRpc("startOrchestrator", { project: { kind: "boat", id: "storefront" }, prompt: "Ship it", title: null, hostId: null, cloud: false });
  assert.deepEqual((JSON.parse((await harness.runCli(["relay", "check", "--json"])).stdout) as { actions: unknown[] }).actions, []);
  assert.match((await harness.runCli(["relay", "status"])).stdout, /Claude ↔ Codex switching off: orchestrators stay on their agent\./);
});

test("a hand-over to an agent the user no longer has is dropped", async (t) => {
  const { harness } = await relayHost(t, { claude: 40, codex: 12 });
  await harness.callRpc("startOrchestrator", { project: { kind: "boat", id: "storefront" }, prompt: "Ship it", title: null, hostId: null, cloud: false });
  const switched = await harness.runCli(["relay", "switch", "thr_old", "--to", "codex", "--json"]);
  assert.equal((JSON.parse(switched.stdout) as { kind: string }).kind, "requested-handoff");
  const note = async () => ((await harness.callRpc("relay", null)) as { orchestrators: { note: string | null }[] }).orchestrators[0]!.note;
  assert.equal(await note(), "writing a handoff note for Codex");
  await harness.setSettings({ agents: "claude" });
  assert.deepEqual((JSON.parse((await harness.runCli(["relay", "check", "--json"])).stdout) as { actions: unknown[] }).actions, []);
  assert.equal(await note(), null, "notices flow to it again");
});

test("a successor in a boat sandbox starts in Full Access (the setting), like the first cloud orchestrator", async (t) => {
  for (const fullAccess of [true, false]) {
    const { harness, threads } = await relayHost(t, { claude: 93, codex: 12 }, { cloudOrchestratorFullAccess: fullAccess });
    // The orchestrator's workspace lives on a Boat sandbox machine.
    harness.sdk.stub("environments.get", async () => ({ id: "env_1", hostId: "host_boat" }));
    harness.sdk.stub("hosts.list", async () => [{ id: "host_boat", machineProviderId: "boat-sandbox" }]);
    await harness.callRpc("startOrchestrator", { project: { kind: "boat", id: "storefront" }, prompt: "Ship it", title: null, hostId: null, cloud: false });
    await harness.runCli(["relay", "check", "--json"]);
    threads.get("thr_old")!.updatedAt = Date.now() + 1_000;
    const second = JSON.parse((await harness.runCli(["relay", "check", "--json"])).stdout) as { actions: { kind: string }[] };
    assert.deepEqual(second.actions.map((action) => action.kind), ["took-over"]);
    const spawn = harness.inspection.sdk.callsTo("threads.spawn").at(-1)![0] as Record<string, unknown>;
    assert.deepEqual(spawn.environment, { type: "reuse", environmentId: "env_1" });
    assert.equal(spawn.permissionMode, fullAccess ? "full" : undefined);
  }
});

test("a successor on this computer keeps the default mode", async (t) => {
  const { harness, threads } = await relayHost(t, { claude: 93, codex: 12 });
  harness.sdk.stub("environments.get", async () => ({ id: "env_1", hostId: "host_1" }));
  harness.sdk.stub("hosts.list", async () => [{ id: "host_1", machineProviderId: null }]);
  await harness.callRpc("startOrchestrator", { project: { kind: "boat", id: "storefront" }, prompt: "Ship it", title: null, hostId: null, cloud: false });
  await harness.runCli(["relay", "check", "--json"]);
  threads.get("thr_old")!.updatedAt = Date.now() + 1_000;
  await harness.runCli(["relay", "check", "--json"]);
  const spawn = harness.inspection.sdk.callsTo("threads.spawn").at(-1)![0] as Record<string, unknown>;
  assert.equal(spawn.providerId, "codex");
  assert.equal(spawn.permissionMode, undefined);
});

test("a successor starts with the other agent's Build model at Effort for orchestrators, like a new orchestrator there", async (t) => {
  const { harness, threads } = await relayHost(t, { claude: 93, codex: 12 }, { orchestratorEffort: "medium" });
  await harness.callRpc("saveModelTiers", {
    tiers: { ...DEFAULT_TIERS, build: { claude: { model: "claude-opus-5-6", effort: "max" }, codex: { model: "gpt-6.2", effort: "max" } } },
  });
  await harness.callRpc("startOrchestrator", { project: { kind: "boat", id: "storefront" }, prompt: "Ship it", title: null, hostId: null, cloud: false });
  const first = harness.inspection.sdk.callsTo("threads.spawn").at(-1)![0] as Record<string, unknown>;
  assert.deepEqual([first.providerId, first.model, first.reasoningLevel], ["claude-code", "claude-opus-5-6", "medium"]);
  await harness.runCli(["relay", "check", "--json"]);
  threads.get("thr_old")!.updatedAt = Date.now() + 1_000;
  const second = JSON.parse((await harness.runCli(["relay", "check", "--json"])).stdout) as { actions: { kind: string }[] };
  assert.deepEqual(second.actions.map((action) => action.kind), ["took-over"]);
  const successor = harness.inspection.sdk.callsTo("threads.spawn").at(-1)![0] as Record<string, unknown>;
  // Not the preset's max: the setting.
  assert.deepEqual([successor.providerId, successor.model, successor.reasoningLevel], ["codex", "gpt-6.2", "medium"]);
});

test("an effort or model picked for one orchestrator stays through switching: the effort on both agents, the model on its own", async (t) => {
  const { harness, threads, metadata } = await relayHost(t, { claude: 93, codex: 12 });
  const spawned = () => {
    const spawn = harness.inspection.sdk.callsTo("threads.spawn").at(-1)![0] as Record<string, unknown>;
    return [spawn.providerId, spawn.model, spawn.reasoningLevel];
  };
  const picks = (threadId: string) => (metadata.get(threadId) as { picks?: unknown }).picks;
  // Effort for orchestrators is High; this one runs on Fable at Low.
  const started = await harness.runCli(["orchestrator", "new", "--project", "storefront", "--prompt", "Ship it", "--local", "--model", "claude-fable-5-1", "--effort", "low"]);
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  assert.deepEqual(spawned(), ["claude-code", "claude-fable-5-1", "low"]);
  assert.deepEqual(picks("thr_old"), { effort: "low", models: { claude: "claude-fable-5-1" } });

  // To Codex: still Low, on Codex's Build model (Fable is Claude's).
  const toCodex = await harness.runCli(["relay", "switch", "thr_old", "--to", "codex", "--now", "--json"]);
  assert.equal((JSON.parse(toCodex.stdout) as { kind: string }).kind, "took-over", toCodex.stderr || toCodex.stdout);
  assert.deepEqual(spawned(), ["codex", "gpt-6.1-sol", "low"]);
  assert.deepEqual(picks("thr_new"), picks("thr_old"));

  // Back to Claude: Fable at Low again, though the setting has changed since.
  assert.equal((await harness.runCli(["config", "set", "orchestratorEffort", "medium"])).exitCode, 0);
  threads.get("thr_new")!.providerId = "codex";
  const back = await harness.runCli(["relay", "switch", "thr_new", "--to", "claude", "--now", "--json"]);
  assert.equal((JSON.parse(back.stdout) as { kind: string }).kind, "took-over", back.stderr || back.stdout);
  assert.deepEqual(spawned(), ["claude-code", "claude-fable-5-1", "low"]);
  assert.deepEqual(picks("thr_third"), picks("thr_old"));
});

test("the switch back to Claude starts with Claude's Build model (bb's id) at Effort for orchestrators, and the plain title", async (t) => {
  const { harness, threads } = await relayHost(t, { claude: 20, codex: 93 }, { orchestratorEffort: "low" });
  // boat's form of the id in the presets table.
  await harness.callRpc("saveModelTiers", {
    tiers: { ...DEFAULT_TIERS, build: { claude: { model: "opus-5-6", effort: "max" }, codex: { model: "gpt-6.2", effort: "max" } } },
  });
  await harness.callRpc("startOrchestrator", { project: { kind: "boat", id: "storefront" }, prompt: "Ship it", title: null, hostId: null, cloud: false, provider: "codex" });
  const first = harness.inspection.sdk.callsTo("threads.spawn").at(-1)![0] as Record<string, unknown>;
  assert.deepEqual([first.providerId, first.model, first.reasoningLevel], ["codex", "gpt-6.2", "low"]);
  Object.assign(threads.get("thr_old")!, { providerId: "codex", title: "Storefront · Codex" });
  const note = JSON.parse((await harness.runCli(["relay", "check", "--json"])).stdout) as { actions: { kind: string; to?: string }[] };
  assert.deepEqual(note.actions.map((action) => [action.kind, action.to]), [["requested-handoff", "claude"]]);
  threads.get("thr_old")!.updatedAt = Date.now() + 1_000;
  const second = JSON.parse((await harness.runCli(["relay", "check", "--json"])).stdout) as { actions: { kind: string }[] };
  assert.deepEqual(second.actions.map((action) => action.kind), ["took-over"]);
  const successor = harness.inspection.sdk.callsTo("threads.spawn").at(-1)![0] as Record<string, unknown>;
  assert.deepEqual([successor.providerId, successor.model, successor.reasoningLevel, successor.title], ["claude-code", "claude-opus-5-6", "low", "Storefront"]);
});

test("Auto-detect: while boat.dev can't be read, the relay never moves an orchestrator to an agent it last reported missing", async (t) => {
  const { harness, threads } = await relayHost(t, { claude: 93, codex: 12 }, { agents: "auto" });
  const patchBoat = (changes: Record<string, unknown>) => {
    const path = process.env.FAKE_BOAT_STATE!;
    const current = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { sandboxes: {}, convos: {}, calls: [], next: 1 };
    writeFileSync(path, JSON.stringify({ ...current, ...changes }));
  };
  // boat.dev has only Claude: one agent, so the relay is off.
  patchBoat({ connected: ["claude-subscription"] });
  await harness.callRpc("setup", { force: true });
  await harness.callRpc("startOrchestrator", { project: { kind: "boat", id: "storefront" }, prompt: "Ship it", title: null, hostId: null, cloud: false });
  assert.deepEqual(JSON.parse((await harness.runCli(["relay", "check", "--json"])).stdout).actions, []);
  // Now boat.dev doesn't answer: the plugin behaves like both, but won't hand to Codex.
  patchBoat({ profilesFail: true });
  await harness.callRpc("setup", { force: true });
  threads.get("thr_old")!.updatedAt = Date.now() - 3_600_000;
  const check = JSON.parse((await harness.runCli(["relay", "check", "--json"])).stdout) as { actions: { kind: string; reason: string }[] };
  assert.deepEqual(check.actions.map((action) => [action.kind, action.reason]), [["skipped", "boat.dev last reported Codex as not connected"]]);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 1, "no successor");
});
