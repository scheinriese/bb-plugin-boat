// The "Boat sandbox" machine provider (cloud orchestrators).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BoatApi } from "../src/boat-api.ts";
import type { BoatCli } from "../src/boat.ts";
import { keepSandboxKey, registerBoatMachine } from "../src/machine.ts";
import { bootstrapFailureMessage } from "../src/bootstrap.ts";
import { defaultSettings, makeService } from "./fakes.ts";

type Provider = {
  create(args: unknown): Promise<{ status: string; resource?: { sandboxId: string; key: string }; message?: string }>;
  resume(args: unknown): Promise<unknown>;
  remove(args: unknown): Promise<{ status: string; message?: string }>;
  reconcileCleanup(args: unknown): Promise<{ status: string; message?: string }>;
};

function setup(settings: Parameters<typeof makeService>[0] = {}, bootstrap: BbPluginApi["experimental_machines"]["bootstrap"] = async () => ({ hostId: "host_123456" })) {
  const fake = makeService(settings);
  let provider: Provider | null = null;
  const bb = {
    experimental_machines: {
      register: (definition: Provider) => {
        provider = definition;
      },
      bootstrap,
    },
    experimental_environments: { register: () => undefined },
    storage: {
      kv: {
        values: new Map<string, unknown>(),
        async get(key: string) {
          return this.values.get(key);
        },
        async set(key: string, value: unknown) {
          this.values.set(key, value);
        },
        async delete(key: string) {
          this.values.delete(key);
        },
      },
    },
  } as unknown as BbPluginApi;
  const cli = { binary: async () => "/bin/boat" } as unknown as BoatCli;
  registerBoatMachine(bb, {
    boat: fake.boat as unknown as BoatApi,
    cli,
    service: fake.service,
    settings: async () => defaultSettings(settings.settings),
  });
  const report = { step: () => undefined, log: () => undefined };
  const args = (key: string, inputs: unknown = {}) => ({
    inputs,
    key,
    checkpoint: async () => undefined,
    report,
    signal: new AbortController().signal,
  });
  return { ...fake, provider: () => provider!, args, kv: (bb.storage.kv as unknown as { values: Map<string, unknown> }).values };
}

test("cloud orchestrator sandboxes are small, whatever the worker size", async () => {
  const { boat, provider, args } = setup({ settings: { machineType: "large" } });
  const result = await provider().create(args("abc"));
  assert.equal(result.status, "created", result.message);
  const created = boat.created.at(-1)!;
  assert.equal(created.type, "small");
  assert.equal(created.name, "bb machine abc");
  // Any bb chat may use the machine: the repo's own git hooks stay in charge.
  assert.deepEqual(created.env, {});
});

test("exhausted bootstrap keeps one checkpointed allocation and returns a sanitized retryable failure", async () => {
  let calls = 0;
  const env = setup({}, async () => { calls++; throw new Error(`Raw installer diagnostics\n${bootstrapFailureMessage({ code: "ETARGET", attempts: 3 })}`); });
  const checkpoints: unknown[] = [];
  const result = await env.provider().create({ ...env.args("failed-bootstrap"), checkpoint: async (resource: unknown) => { checkpoints.push(resource); } });
  assert.equal(result.status, "failed"); assert.match(result.message!, /bootstrap_retryable:ETARGET:3/);
  assert.ok(!result.message!.includes("Raw installer diagnostics"));
  assert.equal(calls, 1, "core enrollment is not replayed"); assert.equal(env.boat.created.length, 1); assert.equal(checkpoints.length, 1);
});

test("the orchestrator size is a setting, and an explicit input wins", async () => {
  const configured = setup({ settings: { orchestratorMachineType: "default" } });
  await configured.provider().create(configured.args("k1"));
  assert.equal(configured.boat.created.at(-1)!.type, "default");

  const explicit = setup();
  await explicit.provider().create(explicit.args("k2", { type: "xlarge" }));
  assert.equal(explicit.boat.created.at(-1)!.type, "xlarge");
});

test("a stopped orchestrator sandbox resumes through the slot check", async () => {
  const { boat, provider, args } = setup();
  const result = await provider().create(args("abc"));
  const sandboxId = result.resource!.sandboxId;
  boat.sandboxes.get(sandboxId)!.state = "stopped";
  await provider().resume({ resource: result.resource, report: args("abc").report, signal: new AbortController().signal });
  assert.ok(boat.calls.some((call) => call.startsWith(`resume ${sandboxId}`)), boat.calls.join("\n"));
});

test("a worker chat's machine adopts the prepared sandbox instead of creating one", async () => {
  const { boat, provider, args } = setup();
  const prepared = await boat.create({ name: "bb t_1 fix", type: "default" });
  const before = boat.created.length;
  const result = await provider().create({ ...args("task-t_1"), inputs: { sandboxId: prepared.id, taskId: "t_1" } });
  assert.equal(result.status, "created", result.message);
  assert.equal(result.resource!.sandboxId, prepared.id);
  assert.equal(boat.created.length, before); // nothing new
  // A machine for a sandbox that's gone fails instead of creating a fresh one.
  const gone = await provider().create({ ...args("task-t_2"), inputs: { sandboxId: "bx_missing", taskId: "t_2" } });
  assert.equal(gone.status, "failed");
  assert.equal(boat.created.length, before);
});

test("a machine for a move to a chat keeps its sandbox: removal and cleanup leave it alone while the keep flag is set", async () => {
  const { boat, provider, args, kv } = setup();
  const prepared = await boat.create({ name: "bb t_1 fix", type: "default" });
  const key = "task-t_1-m1";
  const result = await provider().create({ ...args(key), inputs: { sandboxId: prepared.id, taskId: "t_1", keepSandbox: true } });
  assert.equal(result.status, "created", result.message);
  assert.equal(kv.get(keepSandboxKey(key)), prepared.id, "create sets the flag");
  assert.equal((await provider().remove({ resource: result.resource })).status, "removed");
  assert.equal((await provider().reconcileCleanup({ key })).status, "removed");
  assert.ok(!boat.calls.some((call) => call.startsWith("delete ")), boat.calls.join("\n"));
  assert.ok(boat.sandboxes.has(prepared.id));
  // The move is done (the flag cleared): removing the machine deletes its sandbox, like any task chat's.
  kv.delete(keepSandboxKey(key));
  assert.equal((await provider().remove({ resource: result.resource })).status, "removed");
  assert.ok(boat.calls.includes(`delete ${prepared.id}`));
  // Without the flag, cleanup deletes too (today's behaviour).
  const other = await boat.create({ name: "bb t_2 fix", type: "default" });
  await provider().create({ ...args("task-t_2"), inputs: { sandboxId: other.id, taskId: "t_2" } });
  assert.equal((await provider().reconcileCleanup({ key: "task-t_2" })).status, "removed");
  assert.ok(boat.calls.includes(`delete ${other.id}`));
});

test("native machine starts from the selected snapshot", async () => {
  const { boat, provider, args } = setup();
  const result = await provider().create(args("snapshot-chat", { type: "default", snapshot: "repo-base" }));
  assert.equal(result.status, "created", result.message);
  assert.equal(boat.created.at(-1)!.from, "repo-base");
  assert.equal((result.resource as unknown as { snapshot: string }).snapshot, "repo-base");
});

for (const reviewer of ["codex", "claude", "none"]) test(`machine preserves the selected ${reviewer} reviewer in checkpoint and public resource`, async () => {
  const { provider, args, boat } = setup(); const checkpoints: unknown[] = [];
  const result = await provider().create({ ...args("native-policy", { type: "default", reviewer }), checkpoint: async (resource: unknown) => { checkpoints.push(resource); } });
  assert.equal(result.status, "created"); assert.equal((result.resource as unknown as { reviewer: string }).reviewer, reviewer);
  assert.equal((checkpoints[0] as { reviewer: string }).reviewer, reviewer); assert.equal(boat.created.length, 1);
});
test("invalid machine reviewer fails before any sandbox creation", async () => {
  const { provider, args, boat } = setup(); const result = await provider().create(args("bad-policy", { reviewer: "invalid" }));
  assert.equal(result.status, "failed"); assert.match(result.message!, /options are invalid/); assert.equal(boat.created.length, 0);
});
