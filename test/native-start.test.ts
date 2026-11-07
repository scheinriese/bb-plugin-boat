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
