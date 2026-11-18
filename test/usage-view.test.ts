// The usage view (Settings › Usage limits): each pooled account's limits and
// Claude extra usage as the Account Pooler last read them, and where new
// work goes now, from the relay's own checks. The Pooler is a fake callRpc.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import plugin from "../server.ts";
import type { UsageViewDto } from "../contract.ts";
import { USAGE_STALE_MS } from "../contract-usage.ts";
import { readPoolUsage, type AgentQuota, type Quotas } from "../src/quota.ts";
import { nextForNewWork, PAID_USAGE_EVIDENCE_MS, type NewWorkSettings } from "../src/relay.ts";
import { refreshErrorText } from "../src/rpc-usage.ts";
import { accountStatus, agentFact, creditsRow, dayTime, isStale, nextStepLine, resetLabel, windowTone } from "../web/usage-logic.ts";
import { createTestHost } from "./fakes.ts";

const MIN = 60_000;
const WEEK = 7 * 24 * 60;
const RESET = Date.now() + 2 * 24 * 60 * MIN;
const LATER_RESET = Date.now() + 4 * 24 * 60 * MIN;

/** The Pooler's status.get account, shaped like bb 0.49.0's (fields may be left out). */
function account(id: string, provider: "claude" | "codex", options: { email?: string | null; label?: string; utilization?: number; status?: string; observedAt?: number | null; extra?: { status: string; observedAt: number | null } | null; restriction?: unknown; fable?: number | null; enabled?: boolean; error?: unknown; heldUntil?: number | null; fiveHour?: number } = {}) {
  const observedAt = options.observedAt === undefined ? Date.now() - MIN : options.observedAt;
  return {
    id,
    provider,
    kind: "oauth",
    label: options.label ?? `${provider} ${id}`,
    email: options.email === undefined ? `${id}@example.com` : options.email,
    subscriptionType: "max",
    enabled: options.enabled ?? true,
    priority: 100,
    usageRestriction: options.restriction ?? null,
    extraUsage: options.extra === undefined ? { status: "allowed", observedAt, source: "header" } : options.extra,
    representativeClaim: "seven_day",
    familyWeekly: { fable: options.fable === undefined || options.fable === null ? null : { utilization: options.fable, resetAt: RESET, status: "allowed", observedAt, source: "usage" }, sonnet: null, opus: null, haiku: null, other: null },
    limitWindows: [
      ...(options.fiveHour === undefined ? [] : [{ slot: "primary", windowMinutes: 300, utilization: options.fiveHour, resetAt: Date.now() + 3 * 60 * MIN, status: "allowed", observedAt, source: "header" }]),
      { slot: "secondary", windowMinutes: WEEK, utilization: options.utilization ?? 0.2, resetAt: provider === "claude" ? RESET : LATER_RESET, status: options.status ?? "allowed", observedAt, source: "header" },
    ],
    observedAt,
    heldUntil: options.heldUntil ?? null,
    error: options.error ?? null,
    inFlight: 0,
    status: options.enabled === false ? "disabled" : "ready",
  };
}

interface FakePool {
  /** The Pooler is off: every call to it fails. */
  off?: boolean;
  routing?: { claude: boolean; codex: boolean };
  accounts?: ReturnType<typeof account>[];
  /** account.refreshUsage, per account (default: { ok: true }). */
  refresh?: (accountId: string) => unknown;
  /** This computer's own logins (bb's provider-claude-code and provider-codex), percent used. */
  login?: { claude?: number; codex?: number };
  /** status.get answers this instead. */
  raw?: unknown;
}

type Call = { pluginId: string; method: string; input: { resourceId?: string; refresh?: boolean; accountId?: string } | null };

function fakeCallRpc(pool: FakePool) {
  const calls: Call[] = [];
  async function callRpc({ pluginId, method, input }: Call) {
    calls.push({ pluginId, method, input });
    if (pluginId === "account-pool") {
      if (pool.off) throw new Error("plugin account-pool is not installed");
      const accounts = pool.accounts ?? [];
      if (method === "status.get") return pool.raw ?? { enabledAccountCount: accounts.length, accepting: true, accounts, routing: pool.routing ?? { claude: true, codex: true }, parent: null };
      if (method === "provider-usage.v1.listResources") {
        return { label: "Account Pooler", resources: accounts.map((entry) => ({ id: entry.id, providerId: entry.provider === "claude" ? "claude-code" : "codex", label: entry.label, accountKey: entry.id, scope: "account" })) };
      }
      if (method === "provider-usage.v1.getResource") {
        const found = accounts.find((entry) => entry.id === input?.resourceId);
        const windows = (found?.limitWindows ?? []).map((window) => ({ label: window.windowMinutes === WEEK ? "Weekly limit" : "5-hour limit", usedPercent: window.utilization * 100, resetsAt: new Date(window.resetAt).toISOString(), model: null }));
        return { usage: { status: "ok", windows } };
      }
      if (method === "account.refreshUsage") return pool.refresh ? await pool.refresh(input!.accountId!) : { ok: true };
      throw new Error(`unknown method ${method}`);
    }
    const login = pluginId === "provider-claude-code" ? pool.login?.claude : pluginId === "provider-codex" ? pool.login?.codex : undefined;
    if (login === undefined) throw new Error(`plugin ${pluginId} is not installed`);
    if (method === "provider-usage.v1.listResources") return { resources: [{ id: `${pluginId}:me`, providerId: pluginId === "provider-codex" ? "codex" : "claude-code" }] };
    return { usage: { status: "ok", windows: [{ label: "Weekly limit", usedPercent: login, resetsAt: new Date(RESET).toISOString(), model: null }] } };
  }
  return { calls, callRpc };
}

async function usageHost(t: { after(fn: () => unknown): void }, pool: FakePool, settings: Record<string, unknown> = {}) {
  process.env.FAKE_BOAT_STATE = join(mkdtempSync(join(tmpdir(), "boat-usage-test-")), "state.json");
  const { bb, harness } = await createTestHost({
    pluginId: "boat",
    settings: { boatPath: fileURLToPath(new URL("./fixtures/fake-boat.mjs", import.meta.url)), evidenceUploader: "", agents: "both", ...settings },
    agentSkillIds: ["boat", "boat-orchestrator"],
  });
  t.after(() => harness.lifecycle.dispose());
  const fake = fakeCallRpc(pool);
  harness.sdk.stub("plugins.callRpc", fake.callRpc);
  await plugin(bb);
  return {
    calls: fake.calls,
    usage: async () => (await harness.callRpc("usage", null)) as UsageViewDto,
    refresh: async () => (await harness.callRpc("refreshUsage", null)) as { errors: { accountId: string | null; name: string | null; message: string }[] },
  };
}

/** Boat only reads from the Pooler; account.refreshUsage only when asked. */
const READ_ONLY = new Set(["status.get", "provider-usage.v1.listResources", "provider-usage.v1.getResource"]);
function poolMethods(calls: readonly Call[]): Set<string> {
  return new Set(calls.filter((call) => call.pluginId === "account-pool").map((call) => call.method));
}

// ------------------------------------------------------------------ the reading

test("Pooler on: every pooled account with each limit (Fable labelled), Claude extra usage, read only", async (t) => {
  const pool: FakePool = {
    accounts: [
      account("claude-main", "claude", { utilization: 1, status: "rejected", fable: 0, fiveHour: 0.3 }),
      account("claude-spare", "claude", { email: null, label: "Spare", utilization: 0.42 }),
      account("codex-main", "codex", { utilization: 0.99 }),
      account("codex-spare", "codex", { utilization: 0.1, extra: { status: "allowed", observedAt: Date.now() } }),
    ],
  };
  const host = await usageHost(t, pool);
  const view = await host.usage();
  assert.equal(view.pool, "on");
  assert.deepEqual(view.routing, { claude: true, codex: true });
  // Several accounts per provider, in the Pooler's order; the email, else the label.
  assert.deepEqual(view.accounts.map((entry) => [entry.provider, entry.name]), [["claude", "claude-main@example.com"], ["claude", "Spare"], ["codex", "codex-main@example.com"], ["codex", "codex-spare@example.com"]]);
  const main = view.accounts[0]!;
  assert.deepEqual(main.windows.map((window) => [window.label, window.model, Math.round(window.usedPercent!), window.atLimit]), [
    ["5-hour limit", null, 30, false],
    ["Weekly limit", null, 100, true],
    ["Fable weekly limit", "fable", 0, false],
  ]);
  assert.equal(main.windows[1]!.resetsAt, new Date(RESET).toISOString());
  assert.equal(main.credits?.status, "allowed");
  assert.equal(typeof main.credits?.observedAt, "number");
  // Credits are Claude's; a Codex account has none.
  assert.equal(view.accounts[2]!.credits, null);
  // The relay's numbers come from the Pooler: Claude's freest account (42%), Codex's (10%).
  assert.deepEqual(view.agents.map((agent) => [agent.provider, Math.round(agent.usedPercent!), agent.source]), [["claude", 42, "pool"], ["codex", 10, "pool"]]);
  assert.deepEqual(view.next, { kind: "room", agent: "claude", wanted: "claude", until: null, switching: false });
  // Nothing but reads.
  for (const method of poolMethods(host.calls)) assert.ok(READ_ONLY.has(method), `called ${method}`);
});

test("Pooler off: the RPC fails, the plugin is missing, or it answers nonsense; never empty bars", async (t) => {
  for (const pool of [{ off: true, login: { claude: 40, codex: 20 } }, { raw: "nope", login: { claude: 40, codex: 20 } }] satisfies FakePool[]) {
    const view = await (await usageHost(t, pool)).usage();
    assert.equal(view.pool, "off");
    assert.deepEqual(view.accounts, []);
    assert.deepEqual(view.claudeExtraUsage, { status: "unknown", observedAt: null, pool: "off" });
    // What Boat goes by instead: this computer's own logins.
    assert.deepEqual(view.agents.map((agent) => [agent.provider, agent.usedPercent, agent.source]), [["claude", 40, "login"], ["codex", 20, "login"]]);
    assert.equal(nextStepLine(view), "Claude is at 40% · new work goes to Claude");
  }
  // Nothing reads at all: unknown, not zero.
  const nothing = await (await usageHost(t, { off: true })).usage();
  assert.deepEqual(nothing.agents.map((agent) => agent.usedPercent), [null, null]);
  assert.equal(nextStepLine(nothing), "Claude's usage is unknown · new work goes to Claude");
});

test("not routing Claude: its own state, Claude read from this computer's login, extra usage unknown", async (t) => {
  const host = await usageHost(t, { routing: { claude: false, codex: true }, accounts: [account("c1", "claude", { utilization: 0.05 }), account("x1", "codex", { utilization: 0.3 })], login: { claude: 61 } });
  const view = await host.usage();
  assert.equal(view.pool, "on");
  assert.deepEqual(view.routing, { claude: false, codex: true });
  assert.deepEqual(view.claudeExtraUsage, { status: "unknown", observedAt: null, pool: "not-routing" });
  // The pooled Claude account (5%) doesn't count: chats use the login (61%).
  assert.deepEqual(view.agents.map((agent) => [agent.provider, agent.usedPercent, agent.source]), [["claude", 61, "login"], ["codex", 30, "pool"]]);
});

test("a stale reading keeps its own time and shows as stale; a fresh one doesn't", async (t) => {
  const now = Date.now();
  const old = now - 30 * MIN;
  const host = await usageHost(t, { accounts: [account("c-old", "claude", { observedAt: old }), account("c-new", "claude", { observedAt: now - 2 * MIN }), account("c-never", "claude", { observedAt: null, extra: null })] });
  const [stale, fresh, never] = (await host.usage()).accounts;
  assert.equal(stale!.observedAt, old, "never restamped as now");
  assert.equal(stale!.credits?.observedAt, old);
  assert.equal(isStale(stale!.observedAt, now), true);
  assert.match(accountStatus(stale!, now).text, /^Stale · checked /);
  assert.equal(accountStatus(stale!, now).tone, "warning");
  assert.equal(creditsRow(stale!.credits!, now).stale, true);
  assert.match(creditsRow(stale!.credits!, now).checked, /^stale · checked /);
  assert.equal(isStale(fresh!.observedAt, now), false);
  assert.match(accountStatus(fresh!, now).text, /^checked /);
  assert.equal(accountStatus(never!, now).text, "Not read yet");
  assert.deepEqual(creditsRow(never!.credits!, now), { status: "Unknown", tone: "muted", checked: "not checked yet", stale: true });
  // About ten minutes.
  assert.equal(isStale(now - USAGE_STALE_MS + 1000, now), false);
  assert.equal(isStale(now - USAGE_STALE_MS - 1000, now), true);
});

test("a rejected window is at its limit; spend control turns credits off for the account; a blocked one says so", async (t) => {
  const host = await usageHost(t, {
    accounts: [
      account("c-rejected", "claude", { utilization: 0.97, status: "rejected", extra: { status: "rejected", observedAt: Date.now() - MIN } }),
      account("c-spend", "claude", { restriction: { reason: "spend_control_reached" } }),
      account("c-ok", "claude"),
    ],
  });
  const [rejected, spend, ok] = (await host.usage()).accounts;
  const weekly = rejected!.windows.find((window) => window.label === "Weekly limit")!;
  assert.equal(weekly.atLimit, true, "the provider refuses at 97%");
  assert.equal(windowTone(weekly, 90), "danger");
  assert.equal(windowTone({ usedPercent: 92, atLimit: false }, 90), "warning");
  assert.equal(windowTone({ usedPercent: 40, atLimit: false }, 90), "muted");
  const now = Date.now();
  assert.equal(creditsRow(rejected!.credits!, now).status, "Blocked");
  assert.equal(spend!.credits?.status, "disabled");
  assert.equal(creditsRow(spend!.credits!, now).status, "Off for this account");
  assert.equal(creditsRow(ok!.credits!, now).status, "Available");
});

test("status.get is parsed defensively: wrong types read as null, an account without an id is skipped, unknown fields ignored", async () => {
  const bb = {
    sdk: {
      plugins: {
        callRpc: async () => ({
          routing: { claude: true, codex: "yes" },
          somethingNew: { nested: true },
          accounts: [
            { provider: "claude", email: "no-id@example.com" },
            { id: "a", provider: "claude", email: 42, label: "Team", limitWindows: [{ windowMinutes: "weekly", utilization: "x", resetAt: "not a date", status: 7 }, null], familyWeekly: "nope", extraUsage: { status: "allowed" }, error: { message: "Refresh token expired" }, brandNew: 1 },
            { id: "b", provider: "gemini" },
            { id: "c", provider: "codex", limitWindows: "nope", heldUntil: "soon" },
          ],
        }),
      },
    },
  };
  const read = await readPoolUsage(bb as never);
  assert.equal(read.pool, "on");
  if (read.pool !== "on") return;
  assert.deepEqual(read.routing, { claude: true, codex: false });
  assert.deepEqual(read.accounts.map((entry) => entry.id), ["a", "c"]);
  const team = read.accounts[0]!;
  assert.equal(team.name, "Team");
  assert.deepEqual(team.windows, [{ label: "Usage limit", model: null, usedPercent: null, resetsAt: null, atLimit: false, observedAt: null }]);
  assert.equal(team.error, "Refresh token expired");
  // "allowed" without a time is never evidence.
  assert.deepEqual(team.extraUsage, { allowed: false, status: "unknown", observedAt: null, pool: "on" });
  assert.equal(read.accounts[1]!.heldUntil, null);
  assert.equal(read.accounts[1]!.name, "Codex account");
});

// ------------------------------------------------------------------ refresh

test("Refresh: account.refreshUsage for each account the Pooler uses, then a new reading; errors per account in plain words", async (t) => {
  const pool: FakePool = {
    routing: { claude: true, codex: false },
    accounts: [
      account("c-ok", "claude"),
      account("c-expired", "claude"),
      account("c-busy", "claude"),
      account("c-slow", "claude"),
      account("c-off", "claude", { enabled: false }),
    ],
    login: { codex: 15 },
    refresh: (id) => {
      if (id === "c-expired") throw new Error("Refresh token was rejected (401)");
      if (id === "c-busy") return { ok: false, error: "Usage endpoint answered 429" };
      if (id === "c-slow") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      return { ok: true };
    },
  };
  const host = await usageHost(t, pool);
  await host.usage();
  assert.equal(host.calls.filter((call) => call.method === "account.refreshUsage").length, 0, "never without the button");
  host.calls.length = 0;
  const { errors } = await host.refresh();
  // Enabled accounts only; never another write method.
  assert.deepEqual(host.calls.filter((call) => call.method === "account.refreshUsage").map((call) => call.input?.accountId), ["c-ok", "c-expired", "c-busy", "c-slow"]);
  for (const method of poolMethods(host.calls)) assert.ok(READ_ONLY.has(method) || method === "account.refreshUsage", `called ${method}`);
  assert.deepEqual(errors, [
    { accountId: "c-expired", name: "c-expired@example.com", message: "Refresh token was rejected (401)" },
    { accountId: "c-busy", name: "c-busy@example.com", message: "Usage endpoint answered 429" },
    { accountId: "c-slow", name: "c-slow@example.com", message: "The Account Pooler didn't answer in time." },
  ]);
  // Then read again: the Pooler's accounts without asking twice, this computer's Codex login refreshed.
  const reads = host.calls.filter((call) => call.method === "provider-usage.v1.getResource");
  assert.ok(reads.length > 0);
  for (const call of reads) assert.equal(call.input?.refresh, call.pluginId !== "account-pool", `${call.pluginId} refresh`);
});

test("Refresh with the Pooler off re-reads this computer's logins and asks the Pooler for nothing", async (t) => {
  const host = await usageHost(t, { off: true, login: { claude: 40, codex: 20 } });
  const { errors } = await host.refresh();
  assert.deepEqual(errors, []);
  assert.equal(host.calls.filter((call) => call.method === "account.refreshUsage").length, 0);
  assert.ok(host.calls.some((call) => call.pluginId === "provider-claude-code" && call.method === "provider-usage.v1.getResource" && call.input?.refresh === true));
  assert.equal(refreshErrorText(new Error("unknown method account.refreshUsage")), "This Account Pooler can't refresh from Boat. Use Reload in its own settings.");
  assert.equal(refreshErrorText(new Error("plugin account-pool is not installed")), "The Account Pooler is off.");
});

// ------------------------------------------------------------------ the next step

const BASE: NewWorkSettings = {
  relay: { enabled: true, preferred: "claude", switchAtPercent: 90, switchBackBelowPercent: 50, quietMinutes: 10 },
  agents: "both",
  avoidExtraUsage: true,
  implementProvider: "claude",
  notConnectedAgents: [],
};

function usage(claude: number | null, codex: number | null, extra?: AgentQuota["extraUsage"]): Quotas {
  const map: Quotas = new Map();
  if (claude !== null) map.set("claude", { provider: "claude", usedPercent: claude, resetsAt: new Date(RESET).toISOString(), window: "Weekly limit", ...(extra ? { extraUsage: extra } : {}) });
  if (codex !== null) map.set("codex", { provider: "codex", usedPercent: codex, resetsAt: new Date(LATER_RESET).toISOString(), window: "Weekly limit" });
  return map;
}

/** A view around a next step, as the RPC returns it. */
function viewOf(quotas: Quotas, settings: NewWorkSettings, extra: Partial<UsageViewDto> = {}): UsageViewDto {
  return {
    checkedAt: Date.now(),
    pool: "on",
    routing: { claude: true, codex: true },
    accounts: [],
    agents: (["claude", "codex"] as const).map((provider) => ({ provider, usedPercent: quotas.get(provider)?.usedPercent ?? null, window: quotas.get(provider)?.window ?? null, resetsAt: quotas.get(provider)?.resetsAt ?? null, source: "pool" as const })),
    onlyAgent: null,
    switchAtPercent: settings.relay.switchAtPercent,
    paidClaudeFallback: settings.relay.paidClaudeFallback === true,
    paidClaudeHeadless: settings.relay.paidClaudeHeadless === true,
    paidClaudeAvailable: false,
    claudeExtraUsage: { status: "unknown", observedAt: null, pool: "on" },
    next: { ...nextForNewWork(quotas, settings), switching: settings.relay.enabled },
    ...extra,
  };
}

test("next step: Claude has room, so new work goes to Claude", () => {
  const quotas = usage(40, 99);
  assert.deepEqual(nextForNewWork(quotas, BASE), { kind: "room", agent: "claude", wanted: "claude", until: null });
  assert.equal(nextStepLine(viewOf(quotas, BASE)), "Claude is at 40% · new work goes to Claude");
});

test("next step: Claude at its limit, Codex has room, so new work goes to Codex (switching on)", () => {
  const quotas = usage(100, 12);
  assert.deepEqual(nextForNewWork(quotas, BASE), { kind: "switch", agent: "codex", wanted: "claude", until: null });
  assert.equal(nextStepLine(viewOf(quotas, BASE)), "Claude is at its weekly limit · Codex is at 12%, so new work goes to Codex");
  // Switching off: the start waits for Claude's own reset instead.
  const off = { ...BASE, relay: { ...BASE.relay, enabled: false } };
  const waiting = nextForNewWork(quotas, off);
  assert.deepEqual(waiting, { kind: "wait", agent: null, wanted: "claude", until: new Date(RESET).toISOString() });
  assert.equal(nextStepLine(viewOf(quotas, off)), `Claude is at its weekly limit · switching is off · work waits until ${dayTime(new Date(RESET).toISOString(), Date.now())}`);
});

test("next step: both at their limits with fresh paid Claude evidence: paid Claude", () => {
  const paid = { ...BASE, relay: { ...BASE.relay, paidClaudeFallback: true, paidClaudeHeadless: true } };
  const quotas = usage(100, 99, { allowed: true, status: "allowed", observedAt: Date.now() - MIN, pool: "on" });
  assert.deepEqual(nextForNewWork(quotas, paid), { kind: "paid", agent: "claude", wanted: "claude", until: null });
  assert.equal(nextStepLine(viewOf(quotas, paid, { paidClaudeAvailable: true })), "Codex is at 99% · Claude is at its weekly limit · paid Claude is available, so new work goes to Claude");
  // Headless tasks need their own authorization.
  const chatsOnly = { ...paid, relay: { ...paid.relay, paidClaudeHeadless: false } };
  assert.match(nextStepLine(viewOf(quotas, chatsOnly, { paidClaudeAvailable: true })), /so new work goes to Claude \(headless tasks wait\)$/);
  // Only a fresh (≤5 min) "allowed" starts paid Claude: an older one waits.
  const old = usage(100, 99, { allowed: true, status: "allowed", observedAt: Date.now() - PAID_USAGE_EVIDENCE_MS - MIN, pool: "on" });
  assert.equal(nextForNewWork(old, paid).kind, "wait");
  assert.match(nextStepLine(viewOf(old, paid, { claudeExtraUsage: { status: "allowed", observedAt: Date.now() - 6 * MIN, pool: "on" } })), /^Both are at their limits · paid Claude needs a newer check · work waits until /);
});

test("next step: both at their limits, so work waits until the first reset", () => {
  const quotas = usage(100, 95);
  const next = nextForNewWork(quotas, BASE);
  assert.deepEqual(next, { kind: "wait", agent: null, wanted: "claude", until: new Date(RESET).toISOString() });
  const when = dayTime(new Date(RESET).toISOString(), Date.now());
  assert.equal(nextStepLine(viewOf(quotas, BASE)), `Both are at their limits · work waits until ${when}`);
  // With the paid fallback on, the line says why paid Claude doesn't start.
  const paid = { ...BASE, relay: { ...BASE.relay, paidClaudeFallback: true } };
  const blocked = usage(100, 95, { allowed: false, status: "rejected", observedAt: Date.now() - MIN, pool: "on" });
  assert.equal(nextForNewWork(blocked, paid).kind, "wait");
  assert.equal(nextStepLine(viewOf(blocked, paid, { claudeExtraUsage: { status: "rejected", observedAt: Date.now() - MIN, pool: "on" } })), `Both are at their limits · paid Claude is blocked · work waits until ${when}`);
  assert.match(nextStepLine(viewOf(blocked, paid, { claudeExtraUsage: { status: "disabled", observedAt: null, pool: "on" } })), /· paid Claude is off · /);
  assert.match(nextStepLine(viewOf(blocked, paid, { claudeExtraUsage: { status: "unknown", observedAt: null, pool: "off" } })), /paid Claude is unknown \(Account Pooler off\)/);
  // No reset time known.
  assert.equal(nextStepLine(viewOf(usage(100, 95), BASE, { next: { kind: "wait", agent: null, wanted: "claude", until: null, switching: true } })), "Both are at their limits · work waits for a reset");
});

test("next step: with paid extra usage not avoided, work still starts past a limit; with one agent, only its own reset", () => {
  const free = { ...BASE, avoidExtraUsage: false, relay: { ...BASE.relay, enabled: false } };
  assert.deepEqual(nextForNewWork(usage(100, 95), free), { kind: "over", agent: "claude", wanted: "claude", until: null });
  assert.equal(nextStepLine(viewOf(usage(100, 95), free)), "Both are at their limits · new work still starts on Claude (Don’t start work on paid extra usage is off)");
  const onlyCodex = { ...BASE, agents: "codex" as const };
  const next = nextForNewWork(usage(10, 97), onlyCodex);
  assert.deepEqual(next, { kind: "wait", agent: null, wanted: "codex", until: new Date(LATER_RESET).toISOString() });
  const view = viewOf(usage(10, 97), onlyCodex, { onlyAgent: "codex" });
  view.agents = view.agents.filter((agent) => agent.provider === "codex");
  assert.equal(nextStepLine(view), `Codex is at 97% · work waits until ${dayTime(new Date(LATER_RESET).toISOString(), Date.now())}`);
});

test("next step through the RPC: paid Claude from a fresh Pooler reading, then both at limits once it's blocked", async (t) => {
  const accounts = [account("c", "claude", { utilization: 1, status: "rejected" }), account("x", "codex", { utilization: 0.99 })];
  const host = await usageHost(t, { accounts }, { relayEnabled: true, paidClaudeFallback: true, paidClaudeHeadless: true });
  const view = await host.usage();
  assert.equal(view.paidClaudeAvailable, true);
  assert.equal(view.next.kind, "paid");
  assert.equal(nextStepLine(view), "Codex is at 99% · Claude is at its weekly limit · paid Claude is available, so new work goes to Claude");
  accounts[0] = account("c", "claude", { utilization: 1, status: "rejected", extra: { status: "rejected", observedAt: Date.now() } });
  const blocked = await usageHost(t, { accounts }, { relayEnabled: true, paidClaudeFallback: true, paidClaudeHeadless: true });
  const after = await blocked.usage();
  assert.equal(after.next.kind, "wait");
  assert.equal(after.next.until, new Date(RESET).toISOString());
  assert.match(nextStepLine(after), /^Both are at their limits · paid Claude is blocked · work waits until /);
});

// ------------------------------------------------------------------ wording

test("usage wording: agent facts, reset times in local time", () => {
  const now = Date.parse("2026-11-17T12:00:00Z");
  assert.equal(agentFact(undefined, "codex"), "Codex's usage is unknown");
  assert.equal(agentFact({ provider: "claude", usedPercent: 100, window: "Usage limit (hit)", resetsAt: null, source: "limit-hit" }, "claude"), "Claude hit its usage limit");
  assert.equal(agentFact({ provider: "claude", usedPercent: 103, window: "5-hour limit", resetsAt: null, source: "pool" }, "claude"), "Claude is at its 5-hour limit");
  assert.equal(agentFact({ provider: "codex", usedPercent: 98.6, window: "Weekly limit", resetsAt: null, source: "pool" }, "codex"), "Codex is at 99%");
  const reset = "2026-11-19T01:00:00Z";
  const date = new Date(reset);
  assert.equal(resetLabel(reset, now), `resets ${date.toLocaleDateString([], { weekday: "short" })} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
  assert.match(resetLabel("2026-11-30T01:00:00Z", now)!, /^resets \S+ \d+/, "a date past six days");
  assert.match(resetLabel("2026-11-16T01:00:00Z", now)!, /^reset was due /);
  assert.equal(resetLabel(null, now), null);
  assert.equal(resetLabel("soon", now), null);
  assert.equal(accountStatus({ enabled: false, state: null, heldUntil: null, observedAt: now }, now).text, "Off in the Account Pooler");
  assert.match(accountStatus({ enabled: true, state: null, heldUntil: now + 30 * MIN, observedAt: now }, now).text, /^Held until /);
  assert.equal(accountStatus({ enabled: true, state: "needs_login", heldUntil: null, observedAt: now }, now).text, "Account Pooler: needs login");
});
