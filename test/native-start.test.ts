import assert from "node:assert/strict";
import { test } from "node:test";
import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { nativeStart } from "../src/native-start.ts";
import type { Runtime } from "../src/runtime.ts";
import { submitNativeStart } from "../web/entry-logic.ts";

function fixture() {
  const calls: string[] = [];
  const runtime = {
    service: { store: { byThread: () => null } },
    projects: { forRepo: () => ({ id: "store" }) },
    isOrchestrator: async () => false,
    resolveProject: async (ref: unknown) => {
      calls.push(`resolve:${JSON.stringify(ref)}`);
      return { id: "store" };
    },
    setOrchestrator: async (id: string, on: boolean) => {
      calls.push(`mark:${id}:${on}`);
    },
  } as unknown as Runtime;
  const context = makeMessageDispatchHookContext({
    experimental_submission: {
      pluginId: "boat",
      data: { boatStart: "orchestrator" },
    },
  });
  context.project.gitRemoteUrl = "https://github.com/acme/store";
  return { calls, runtime, context };
}

test("native orchestrator is marked before proceed without changing core selection", async () => {
  const { calls, runtime, context } = fixture();
  const execution = structuredClone(context.requestedExecution);
  const environment = context.environment;
  const input = structuredClone(context.input);
  assert.deepEqual(await nativeStart(context, runtime), { action: "proceed" });
  assert.deepEqual(calls, [
    'resolve:{"kind":"boat","id":"store"}',
    `mark:${context.thread.id}:true`,
  ]);
  assert.deepEqual(context.requestedExecution, execution);
  assert.equal(context.environment, environment);
  assert.deepEqual(context.input, input);
});

test("native start ignores foreign and ordinary submissions; repeated mark is idempotent", async () => {
  const { calls, runtime, context } = fixture();
  context.experimental_submission = {
    pluginId: "other",
    data: { boatStart: "orchestrator" },
  };
  assert.equal(await nativeStart(context, runtime), null);
  context.experimental_submission = {
    pluginId: "boat",
    data: { boatStart: "task" },
  };
  assert.equal(await nativeStart(context, runtime), null);
  context.experimental_submission = {
    pluginId: "boat",
    data: { boatStart: "orchestrator" },
  };
  runtime.isOrchestrator = async () => true;
  assert.deepEqual(await nativeStart(context, runtime), { action: "proceed" });
  assert.deepEqual(calls, []);
});

test("failed project setup rejects before any role mutation", async () => {
  const { calls, runtime, context } = fixture();
  runtime.resolveProject = async () => {
    throw new Error("Push this branch first");
  };
  assert.deepEqual(await nativeStart(context, runtime), {
    action: "reject",
    message: "Push this branch first",
  });
  assert.deepEqual(calls, []);
});

test("native menu delegates the complete submission, and blocked starts never submit", async () => {
  const options: unknown[] = [];
  const composer = {
    isSubmittingBlocked: false,
    submittingBlockedReason: null as string | null,
    submit: async (value: unknown) => {
      options.push(value);
    },
  };
  await submitNativeStart(composer, "task");
  await submitNativeStart(composer, "orchestrator");
  assert.deepEqual(options, [
    { experimental_data: { boatStart: "task" } },
    { experimental_data: { boatStart: "orchestrator" } },
  ]);
  composer.isSubmittingBlocked = true;
  composer.submittingBlockedReason = "Select an environment";
  await assert.rejects(
    submitNativeStart(composer, "task"),
    /Select an environment/,
  );
  assert.equal(options.length, 2);
});

import { adoptNativeChat } from "../src/native-start.ts";
import { makeService } from "./fakes.ts";

test("native adoption records the real chat once without a sandbox start or launch", async () => {
  const fake = makeService();
  const runtime = {
    service: fake.service,
    isOrchestrator: async () => false,
    projects: { forRepo: () => null },
    bb: {
      sdk: {
        threads: {
          get: async () => ({
            id: "thr_native",
            title: "Fix the header",
            providerId: "codex",
            projectId: "proj_demo",
            environmentId: "env_demo",
            parentThreadId: "thr_parent",
          }),
        },
        environments: {
          get: async () => ({
            id: "env_demo",
            path: "/work/demo",
            hostId: "host_demo",
          }),
        },
        hosts: {
          get: async () => ({
            id: "host_demo",
            machineProviderId: "boat-sandbox",
          }),
        },
        projects: {
          get: async () => ({ gitRemoteUrl: "https://github.com/acme/demo" }),
        },
      },
      experimental_machines: {
        getResource: async () => ({
          sandboxId: "bx_native",
          snapshot: "demo-base",
        }),
      },
      rpc: { experimental_invalidate: () => undefined },
    },
  } as unknown as Runtime;
  assert.equal(await adoptNativeChat("thr_native", runtime), true);
  const task = fake.service.store.byThread("thr_native")!;
  assert.equal(task.sandboxId, "bx_native");
  assert.equal(task.environmentId, "env_demo");
  assert.equal(task.orchestratorThreadId, "thr_parent");
  assert.equal(task.provider, "codex");
  assert.equal(task.ownsSandbox, false);
  assert.equal(
    task.delivery,
    "pr",
    "unknown native branch must not offer direct shipping",
  );
  assert.equal(task.snapshot, "demo-base");
  assert.equal(await adoptNativeChat("thr_native", runtime), false);
  assert.deepEqual(fake.boat.calls, [], "passive adoption never calls Boat");
});

import {
  createFakePluginHost,
  makeHostResponse,
} from "@get-bb/plugin-sdk/testing";
import type { Quotas, QuotaReader } from "../src/quota.ts";

function usageFixture() {
  const fake = makeService();
  const { bb, harness } = createFakePluginHost({ pluginId: "boat" });
  let marked = false;
  let readings: Quotas = new Map([
    [
      "claude",
      {
        provider: "claude",
        usedPercent: 95,
        resetsAt: null,
        window: "Weekly limit",
      },
    ],
    [
      "codex",
      {
        provider: "codex",
        usedPercent: 97,
        resetsAt: null,
        window: "Weekly limit",
      },
    ],
  ]);
  const reads: { signal?: AbortSignal; fresh?: boolean }[] = [];
  const runtime = {
    bb,
    service: fake.service,
    projects: { forRepo: () => ({ id: "demo" }) },
    isOrchestrator: async () => marked,
    resolveProject: async () => ({ id: "demo" }),
    setOrchestrator: async () => {
      marked = true;
    },
  } as unknown as Runtime;
  const context = makeMessageDispatchHookContext({
    thread: {
      status: "pending",
      environmentId: null,
      archivedAt: null,
      deletedAt: null,
    },
    environment: null,
    host: null,
    attempt: "start-turn",
    experimental_submission: null,
    environmentIntent: {
      kind: "provider",
      environmentProviderId: "project-checkout",
      machine: { type: "new", machineProviderId: "boat-sandbox", inputs: null },
      inputs: null,
    },
    requestedExecution: { providerId: "codex", model: "gpt-6.1" },
    executionSources: { providerId: "explicit", model: "explicit" },
  });
  const reader: QuotaReader = {
    read: async (signal, options) => {
      reads.push({ signal, fresh: options?.fresh });
      return readings;
    },
  };
  return {
    ...fake,
    runtime,
    harness,
    context,
    reader,
    reads,
    marked: () => marked,
    usage(value: Quotas) {
      readings = value;
    },
    noWork() {
      assert.deepEqual(fake.boat.calls, []);
      assert.equal(fake.store.list().length, 0);
      assert.equal(harness.sdk.callsTo("threads.send").length, 0);
      assert.equal(harness.sdk.callsTo("threads.spawn").length, 0);
    },
  };
}

test("first pending selected Boat start waits on fresh actual-provider usage; explicit model/provider is not paid consent", async (t) => {
  const e = usageFixture();
  t.after(() => e.harness.lifecycle.dispose());
  const before = structuredClone(e.context);
  const result = await nativeStart(e.context, e.runtime, e.reader);
  assert.equal(result?.action, "wait");
  if (result?.action !== "wait") throw Error("Expected wait");
  assert.match(result.reason, /Codex.*subscription limit/);
  assert.match(result.reason, /Send now.*may use paid extra usage/);
  assert.ok(
    result.sendAt! > Date.now() && result.sendAt! <= Date.now() + 30_000,
  );
  assert.equal(e.reads.length, 1);
  assert.equal(e.reads[0]!.fresh, true);
  assert.ok(e.reads[0]!.signal instanceof AbortSignal);
  assert.deepEqual(e.context, before, "no core selection/draft mutation");
  e.noWork();
});

test("resolved provider with room proceeds unchanged; other-provider room never silently switches a native start", async (t) => {
  const e = usageFixture();
  t.after(() => e.harness.lifecycle.dispose());
  e.usage(
    new Map([
      [
        "claude",
        {
          provider: "claude",
          usedPercent: 99,
          resetsAt: null,
          window: "Weekly",
        },
      ],
      [
        "codex",
        {
          provider: "codex",
          usedPercent: 10,
          resetsAt: null,
          window: "Weekly",
        },
      ],
    ]),
  );
  e.context.thread.providerId = "claude-code";
  assert.equal(
    await nativeStart(e.context, e.runtime, e.reader),
    null,
    "resolved requestedExecution.providerId wins over the thread's older value",
  );
  e.context.requestedExecution.providerId = "claude-code";
  const waiting = await nativeStart(e.context, e.runtime, e.reader);
  assert.equal(waiting?.action, "wait");
  if (waiting?.action === "wait")
    assert.match(waiting.reason, /Claude.*subscription limit/);
  assert.equal(e.context.requestedExecution.providerId, "claude-code");
  e.noWork();
});

test("known earlier reset only shortens retry; every drain checks fresh room again", async (t) => {
  const e = usageFixture();
  t.after(() => e.harness.lifecycle.dispose());
  const reset = Date.now() + 10_000;
  e.usage(
    new Map([
      [
        "codex",
        {
          provider: "codex",
          usedPercent: 99,
          resetsAt: new Date(reset).toISOString(),
          window: "Weekly",
        },
      ],
    ]),
  );
  const first = await nativeStart(e.context, e.runtime, e.reader);
  assert.equal(first?.action, "wait");
  if (first?.action === "wait") assert.equal(first.sendAt, reset);
  e.context.experimental_submission = null;
  assert.equal(
    (await nativeStart(e.context, e.runtime, e.reader))?.action,
    "wait",
  );
  e.usage(
    new Map([
      [
        "codex",
        {
          provider: "codex",
          usedPercent: 10,
          resetsAt: null,
          window: "Weekly",
        },
      ],
    ]),
  );
  assert.equal(await nativeStart(e.context, e.runtime, e.reader), null);
  assert.equal(e.reads.length, 3);
  e.noWork();
});

test("unknown, invalid and failed native usage wait honestly without exposing source errors", async (t) => {
  const e = usageFixture();
  t.after(() => e.harness.lifecycle.dispose());
  const choices: (QuotaReader | undefined)[] = [
    undefined,
    { read: async () => new Map() },
    {
      read: async () => {
        throw Error("private credential detail");
      },
    },
    {
      read: async () =>
        new Map([
          [
            "codex",
            {
              provider: "codex",
              usedPercent: NaN,
              resetsAt: "bad",
              window: "Weekly",
            },
          ],
        ]),
    },
  ];
  for (const reader of choices) {
    const now = Date.now(),
      result = await nativeStart(e.context, e.runtime, reader);
    assert.equal(result?.action, "wait");
    if (result?.action !== "wait") throw Error("Expected wait");
    assert.match(result.reason, /Couldn’t confirm usage/);
    assert.doesNotMatch(result.reason, /private|credential|reset at/);
    assert.ok(
      result.sendAt! >= now + 30_000 && result.sendAt! <= Date.now() + 30_000,
    );
  }
  e.context.requestedExecution.providerId = "custom-agent";
  assert.equal(
    (await nativeStart(e.context, e.runtime, e.reader))?.action,
    "wait",
  );
  e.noWork();
});

test("native opt-out and warm/join/non-Boat dispatches do not read or alter usage admission", async (t) => {
  const e = usageFixture();
  t.after(() => e.harness.lifecycle.dispose());
  e.setSettings({ avoidExtraUsage: false });
  assert.equal(await nativeStart(e.context, e.runtime, e.reader), null);
  e.setSettings({ avoidExtraUsage: true });
  const base = structuredClone(e.context);
  const contexts = [
    { ...base, attempt: "join-turn" as const },
    { ...base, thread: { ...base.thread, status: "active" as const } },
    { ...base, thread: { ...base.thread, environmentId: "env_existing" } },
    { ...base, thread: { ...base.thread, archivedAt: Date.now() } },
    {
      ...base,
      environmentIntent: {
        kind: "provider" as const,
        environmentProviderId: "project-checkout",
        machine: {
          type: "new" as const,
          machineProviderId: "another-machine",
          inputs: null,
        },
        inputs: null,
      },
    },
    {
      ...base,
      host: makeHostResponse({ machineProviderId: "boat-sandbox" }),
      environmentIntent: {
        kind: "provider" as const,
        environmentProviderId: "project-checkout",
        machine: { type: "existing" as const, hostId: "host_existing" },
        inputs: null,
      },
    },
  ];
  for (const context of contexts)
    assert.equal(await nativeStart(context, e.runtime, e.reader), null);
  assert.equal(e.reads.length, 0);
  e.noWork();
});

test("first pending start on a selected suspended Boat host is gated before resume", async (t) => {
  const e = usageFixture();
  t.after(() => e.harness.lifecycle.dispose());
  const host = makeHostResponse({ machineProviderId: "boat-sandbox" });
  host.lifecycle.phase = "suspended";
  e.context.host = host;
  e.context.environmentIntent = {
    kind: "provider",
    environmentProviderId: "project-checkout",
    machine: { type: "existing", hostId: host.id },
    inputs: null,
  };
  assert.equal(
    (await nativeStart(e.context, e.runtime, e.reader))?.action,
    "wait",
  );
  e.noWork();
});

test("orchestrator role survives core dropping opaque submission on a queued retry", async (t) => {
  const e = usageFixture();
  t.after(() => e.harness.lifecycle.dispose());
  e.context.experimental_submission = {
    pluginId: "boat",
    data: { boatStart: "orchestrator" },
  };
  assert.equal(
    (await nativeStart(e.context, e.runtime, e.reader))?.action,
    "wait",
  );
  assert.equal(e.marked(), true);
  e.context.experimental_submission = null;
  e.usage(
    new Map([
      [
        "codex",
        {
          provider: "codex",
          usedPercent: 10,
          resetsAt: null,
          window: "Weekly",
        },
      ],
    ]),
  );
  assert.equal(await nativeStart(e.context, e.runtime, e.reader), null);
  assert.equal(e.marked(), true);
  e.noWork();
});

test("policy is re-read after an async usage read before native admission", async (t) => {
  const e = usageFixture();
  t.after(() => e.harness.lifecycle.dispose());
  const reader: QuotaReader = {
    read: async () => {
      e.setSettings({ avoidExtraUsage: false });
      return new Map();
    },
  };
  assert.equal(await nativeStart(e.context, e.runtime, reader), null);
  e.noWork();
});

test(
  "a non-cooperative usage source cannot leave first native admission hanging",
  { timeout: 8000 },
  async (t) => {
    const e = usageFixture();
    t.after(() => e.harness.lifecycle.dispose());
    const keepAlive = setTimeout(() => undefined, 6000);
    t.after(() => clearTimeout(keepAlive));
    let signal: AbortSignal | undefined;
    const result = await nativeStart(e.context, e.runtime, {
      read: async (value) => {
        signal = value;
        return new Promise(() => undefined);
      },
    });
    assert.equal(signal?.aborted, true);
    assert.equal(result?.action, "wait");
    e.noWork();
  },
);
