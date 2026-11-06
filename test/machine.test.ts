// The "Boat sandbox" machine provider (cloud orchestrators).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BoatApi } from "../src/boat-api.ts";
import type { BoatCli } from "../src/boat.ts";
import { MACHINE_PROVIDER_ID, keepBoatMachines, registerBoatMachine } from "../src/machine.ts";
import { defaultSettings, makeService } from "./fakes.ts";

type Provider = {
  create(args: unknown): Promise<{ status: string; resource?: { sandboxId: string; key: string }; message?: string }>;
  resume(args: unknown): Promise<unknown>;
};

function setup(settings: Parameters<typeof makeService>[0] = {}) {
  const fake = makeService(settings);
  let provider: Provider | null = null;
  const bb = {
    experimental_machines: {
      register: (definition: Provider) => {
        provider = definition;
      },
      bootstrap: async () => ({ hostId: "host_123456" }),
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
  return { ...fake, provider: () => provider!, args };
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

test("a busy chat's Boat sandbox is kept on within the plan's auto-stop cap", async () => {
  const fake = makeService();
  const sandbox = await fake.boat.create({ name: "orchestrator", type: "small", ttlSeconds: 7200 });
  sandbox.archiveAfter = new Date(Date.now() + 5 * 60_000).toISOString();
  const bb = {
    sdk: {
      hosts: { list: async () => [{ id: "host_1", machineProviderId: MACHINE_PROVIDER_ID, lifecycle: { phase: "active", suspendedAt: null } }] },
      threads: { list: async () => [{ status: "active" }] },
    },
    experimental_machines: { getResource: async () => ({ sandboxId: sandbox.id, key: "k" }) },
  } as unknown as BbPluginApi;
  const keep = (settings = defaultSettings()) =>
    keepBoatMachines(bb, { boat: fake.boat as unknown as BoatApi, settings: async () => settings, signal: new AbortController().signal, log: () => undefined });

  // Hard stop after 4 h; the trial's cap (2 h, from boat limits) wins.
  await keep();
  assert.deepEqual(fake.boat.extended.at(-1), { id: sandbox.id, args: ["--ttl", "7200"] });
  // boat reports a different cap.
  fake.boat.limitsValue = { ...fake.boat.limitsValue, autoStopCapHours: 3 };
  await keep();
  assert.deepEqual(fake.boat.extended.at(-1), { id: sandbox.id, args: ["--ttl", "10800"] });
  // boat can't be read: the setting, then the cap boat names when it refuses.
  fake.boat.limitsError = new Error("boat.dev didn't answer");
  fake.boat.autoStopCapSeconds = 7200;
  await keep();
  assert.deepEqual(fake.boat.extended.at(-1), { id: sandbox.id, args: ["--ttl", "7200"] });
});
