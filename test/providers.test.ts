// The sandbox provider layer (src/providers/): the registry, boat.dev as a
// provider, provider errors, the bb machine registration with another
// provider, and tasks that keep the provider their sandbox is on.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi, MachineExecutor } from "@get-bb/plugin-sdk";
import { DEFAULT_PROVIDER_ID, createProviderRegistry } from "../src/providers/registry.ts";
import { ProviderError, isNotFound, type MachineSpec, type SandboxInfo, type SandboxProvider } from "../src/providers/types.ts";
import { MACHINE_PROVIDER_ID, createBoatProvider } from "../src/providers/boat/provider.ts";
import { BOAT_GIT_ENV, type BoatApi } from "../src/providers/boat/api.ts";
import { BoatError } from "../src/providers/boat/cli.ts";
import { explainBoatError } from "../src/providers/boat/words.ts";
import { registerSandboxMachine } from "../src/providers/machine.ts";
import type { BoatService } from "../src/service.ts";
import { FakeBoat, defaultSettings } from "./fakes.ts";

const SANDBOX: SandboxInfo = {
  id: "bx_1",
  name: "bb t_1 fix",
  state: "idle",
  health: null,
  url: null,
  desktopUrl: null,
  environment: "base",
  createdAt: null,
  archiveAfter: null,
  stoppedAt: null,
  setupStatus: null,
  error: null,
};

/** A boat client that records each call and answers it with a fixed value. */

function recordingClient() {
  const calls: unknown[][] = [];
  const answer = (name: string, value: unknown) => (...args: unknown[]) => {
    calls.push([name, ...args]);
    return Promise.resolve(value);
  };
  const client = {
    limits: answer("limits", { canStart: true }),
    usagePlan: answer("usagePlan", null),
    usage: answer("usage", { seconds: 60, hours: 1 / 60, dollars: 0.01, since: null, until: null, running: false }),
    list: answer("list", [SANDBOX]),
    info: answer("info", SANDBOX),
    findInfo: answer("findInfo", SANDBOX),
    create: answer("create", SANDBOX),
    delete: answer("delete", undefined),
    stop: answer("stop", undefined),
    resume: answer("resume", undefined),
    extend: answer("extend", {}),
    exec: answer("exec", { exitCode: 0, stdout: "", stderr: "" }),
    execDetached: answer("execDetached", { pid: 7 }),
    processes: answer("processes", { live: true, sampledAt: null, processes: [] }),
    prepareRepo: answer("prepareRepo", { path: "/home/user/work/web", branch: "fix", baseBranch: "main" }),
    githubLogin: answer("githubLogin", { valid: true, expiresAt: null }),
    ship: answer("ship", { shipped: [] }),
    host: answer("host", { url: "https://bx_1-3000.on.boat.dev?_token=tok_fake", port: 3000, title: "Fix", isProtected: true }),
    snapshot: answer("snapshot", { name: "base-snap", sizeBytes: null }),
    snapshots: answer("snapshots", { snapshots: [], included: null, used: null }),
    environments: answer("environments", ["base"]),
    defaultEnvironment: answer("defaultEnvironment", "base"),
    environmentInfo: answer("environmentInfo", { name: "base" }),
    aiProxy: answer("aiProxy", { enabled: false, dailyDollars: null, dollarsPer1000Requests: null }),
    prompt: answer("prompt", { conversationId: "c_1", promptId: "p_1", model: null }),
    conversations: answer("conversations", []),
    events: answer("events", []),
    steer: answer("steer", undefined),
    interrupt: answer("interrupt", undefined),
  };
  return { calls, client: client as unknown as BoatApi };
}

test("boat.dev is the only provider and the default: projects, tasks and sandboxes get it", () => {
  const boat = createBoatProvider(new FakeBoat() as unknown as BoatApi);
  const registry = createProviderRegistry([boat]);
  assert.equal(boat.id, DEFAULT_PROVIDER_ID);
  assert.equal(registry.default, boat);
  assert.deepEqual(registry.enabled, [boat]);
  assert.equal(registry.get("boat"), boat);
  assert.equal(registry.get("other"), null);
  assert.equal(registry.forProject(null), boat);
  assert.equal(registry.forProject({ sandboxProvider: "other" }), boat, "a provider that isn't enabled: the default");
  assert.equal(registry.forTask({}), boat, "a task from before the column");
  assert.equal(registry.forTask({ sandboxProvider: "boat" }), boat);
  assert.equal(registry.forSandbox("bx_abc123"), boat);
  assert.equal(registry.forSandbox("someone-else"), boat, "an id no provider claims: the default");
  assert.equal(registry.forMachine(MACHINE_PROVIDER_ID), boat);
  assert.equal(registry.forMachine("manual"), null);
  assert.equal(registry.forMachine(null), null);
  assert.throws(() => createProviderRegistry([]), /No sandbox provider/);
});

test("each boat provider member makes the boat call the plugin made before", async () => {
  const { calls, client } = recordingClient();
  const boat = createBoatProvider(client);
  const signal = new AbortController().signal;
  const shippedBy = (sha: string) => (sha === "abc1234" ? "t_0" : null);
  await boat.capacity(signal);
  await boat.usagePlan(signal);
  await boat.usage("bx_1", { since: "2026-11-18T00:00:00.000Z" }, signal);
  await boat.list({ all: true, signal });
  await boat.list({ signal });
  await boat.info("bx_1", signal);
  await boat.findInfo("bx_1");
  await boat.create({ name: "bb t_1 fix", type: "large", environment: "web", snapshot: "base-snap", ttlSeconds: 7200, gitGuard: true, signal });
  await boat.create({ name: "bb machine k1", type: "small", environment: null, ttlSeconds: 3600, gitGuard: false });
  await boat.delete("bx_1", signal);
  await boat.stop("bx_1");
  await boat.resume("bx_1", { ttlSeconds: 3600, type: "xlarge", signal });
  await boat.resume("bx_1", { ttlSeconds: 3600, signal });
  assert.deepEqual(await boat.extend("bx_1", 1800, signal), { ttlSeconds: 1800 });
  await boat.exec("bx_1", "ls", { timeoutMs: 5000, signal });
  await boat.execDetached("bx_1", "sleep 1", signal);
  await boat.processes("bx_1", signal);
  await boat.prepareRepo("bx_1", "acme/web", { kind: "default-branch" }, { workDir: "t_1" });
  await boat.githubLogin("bx_1", signal);
  await boat.ship("bx_1", [{ path: "/home/user/work/web", baseBranch: "main" }], signal, shippedBy);
  await boat.host("bx_1", 3000, "Fix", signal);
  await boat.snapshot("bx_1", "base-snap", signal);
  await boat.snapshots(signal);
  await boat.environments(signal);
  await boat.defaultEnvironment(signal);
  await boat.environmentInfo("base", signal);
  await boat.aiProxy(signal);
  await boat.prompt({ sandboxId: "bx_1", prompt: "Go", provider: "codex", conversationId: "c_1", signal });
  await boat.conversations("bx_1", signal);
  await boat.events("bx_1", "c_1", signal);
  await boat.steer("bx_1", "c_1", "Also add a test", signal);
  await boat.interrupt("bx_1", null);
  assert.deepEqual(calls, [
    ["limits", signal],
    ["usagePlan", signal],
    ["usage", "bx_1", { since: "2026-11-18T00:00:00.000Z" }, signal],
    ["list", { all: true, signal }],
    ["list", { signal }],
    ["info", "bx_1", signal],
    ["findInfo", "bx_1", undefined],
    ["create", { name: "bb t_1 fix", type: "large", environment: "web", from: "base-snap", env: BOAT_GIT_ENV, ttlSeconds: 7200, signal }],
    ["create", { name: "bb machine k1", type: "small", environment: null, from: null, env: {}, ttlSeconds: 3600, signal: undefined }],
    ["delete", "bx_1", signal],
    ["stop", "bx_1", undefined, undefined],
    ["resume", "bx_1", 3600, signal, "xlarge"],
    ["resume", "bx_1", 3600, signal, undefined],
    ["extend", "bx_1", ["--ttl", "1800"], signal],
    ["exec", "bx_1", "ls", { timeoutMs: 5000, signal }],
    ["execDetached", "bx_1", "sleep 1", signal],
    ["processes", "bx_1", signal],
    ["prepareRepo", "bx_1", "acme/web", { kind: "default-branch" }, { workDir: "t_1" }],
    ["githubLogin", "bx_1", signal],
    ["ship", "bx_1", [{ path: "/home/user/work/web", baseBranch: "main" }], signal, shippedBy],
    ["host", "bx_1", 3000, "Fix", signal],
    ["snapshot", "bx_1", "base-snap", signal],
    ["snapshots", signal],
    ["environments", signal],
    ["defaultEnvironment", signal],
    ["environmentInfo", "base", signal],
    ["aiProxy", signal],
    ["prompt", { sandboxId: "bx_1", prompt: "Go", provider: "codex", conversationId: "c_1", signal }],
    ["conversations", "bx_1", signal],
    ["events", "bx_1", "c_1", signal],
    ["steer", "bx_1", "c_1", "Also add a test", signal],
    ["interrupt", "bx_1", null, undefined],
  ]);
});

test("above the plan's auto-stop cap, the boat provider tries once more at the cap boat names", async () => {
  const fake = new FakeBoat();
  fake.autoStopCapSeconds = 7200;
  const boat = createBoatProvider(fake as unknown as BoatApi);
  const sandbox = await boat.create({ name: "bb t_2 web", type: "default", ttlSeconds: 4 * 3600, gitGuard: true });
  assert.deepEqual(fake.calls, ["create default ttl=14400", "create default ttl=7200"]);
  await boat.resume(sandbox.id, { ttlSeconds: 4 * 3600 });
  assert.deepEqual(fake.calls.slice(2), [`resume ${sandbox.id} ttl=14400`, `resume ${sandbox.id} ttl=7200`]);
  assert.deepEqual(await boat.extend(sandbox.id, 4 * 3600), { ttlSeconds: 7200 }, "the seconds boat set");
  assert.deepEqual(await boat.extend(sandbox.id, 3600), { ttlSeconds: 3600 });
  assert.deepEqual(fake.extended.map((entry) => entry.args), [["--ttl", "7200"], ["--ttl", "3600"]]);
  // Another refusal goes through unchanged.
  fake.resumeError = () => new BoatError("boat start limit reached", { code: "start_limited", status: 429 });
  await assert.rejects(boat.resume(sandbox.id, { ttlSeconds: 3600 }), (error: unknown) => error instanceof BoatError && error.code === "start_limited");
});

test("provider errors explain themselves; boat's in boat's words", () => {
  const plain = new ProviderError("Sandbox quota reached", { code: "at_capacity", status: 429 });
  assert.equal(plain.name, "ProviderError");
  assert.deepEqual(plain.explain(), { code: "at_capacity", message: "Sandbox quota reached", hint: null });
  assert.equal(new ProviderError("x").code, "provider_failed");
  const gone = new BoatError("not found (404)", { code: "not_found", status: 404 });
  assert.ok(gone instanceof ProviderError);
  assert.equal(gone.name, "BoatError");
  assert.equal(new BoatError("x").code, "boat_failed");
  assert.deepEqual(gone.explain(), explainBoatError(gone));
  assert.deepEqual(gone.explain(), { code: "not_found", message: "boat: not found (404)", hint: null });
  assert.equal(new BoatError("Unauthorized", { status: 401 }).explain().message, "You're not signed in to boat.dev.");
  assert.ok(isNotFound(gone));
  assert.ok(isNotFound(new ProviderError("gone", { status: 404 })));
  assert.ok(!isNotFound(new ProviderError("boat start limit reached", { code: "start_limited" })));
  assert.ok(!isNotFound(new Error("not_found")));
});

test("any provider with bb enrollment registers as a bb machine provider, in its own words", async () => {
  const definitions: Record<string, unknown>[] = [];
  const environments: Record<string, unknown>[] = [];
  const kv = new Map<string, unknown>();
  const executors: string[] = [];
  const bb = {
    experimental_machines: {
      register: (definition: Record<string, unknown>) => void definitions.push(definition),
      bootstrap: async ({ executor }: { executor: MachineExecutor }) => {
        await executor.exec({ command: ["true"], stdin: "", timeoutMs: 1000, signal: new AbortController().signal, onOutput: () => undefined });
        return { hostId: "host_abcdef123456" };
      },
    },
    experimental_environments: { register: (environment: Record<string, unknown>) => void environments.push(environment) },
    storage: {
      kv: {
        get: async (key: string) => kv.get(key),
        set: async (key: string, value: unknown) => void kv.set(key, value),
        delete: async (key: string) => void kv.delete(key),
      },
    },
  } as unknown as BbPluginApi;
  const sandboxes = new Map<string, SandboxInfo>();
  const deleted: string[] = [];
  const execs: string[] = [];
  const machine: MachineSpec = {
    id: "other-sandbox",
    displayName: "Other sandbox",
    description: "Run bb chats in another cloud sandbox",
    icon: "ComputerCloud",
    environments: [{ id: "other-sandbox", displayName: "Other sandbox", description: "A new sandbox with this project checked out", environmentProviderId: "project-checkout" }],
    machineName: (key) => `bb machine ${key}`,
    machineLabel: (sandboxId, hostId) => `Other ${sandboxId} (${hostId.slice(-6)})`,
    words: {
      invalidInputs: "Other machine options are invalid.",
      usingPrepared: "Using the prepared sandbox",
      creating: "Creating the other sandbox",
      resuming: "Resuming the other sandbox",
      created: (sandboxId) => `other sandbox ${sandboxId}`,
      gone: (sandboxId) => `other sandbox ${sandboxId} no longer exists`,
      stopSaid: (reason) => `other said: "${reason}"`,
      notStopped: (why) => `other didn't stop it: ${why}`,
      stillRestoring: (detail) => `it's still restoring${detail}`,
    },
  };
  const other = {
    id: "other",
    idPattern: /^ot_[a-z0-9]+$/,
    sizes: [{ id: "small", label: "Small", cpus: 2, memoryGb: 4 }],
    machine,
    executor: (sandboxId: string): MachineExecutor => ({
      async exec() {
        executors.push(sandboxId);
        return { exitCode: 0 };
      },
    }),
    findInfo: async (sandboxId: string) => sandboxes.get(sandboxId) ?? null,
    list: async () => [...sandboxes.values()],
    // The login scripts are quieted over the provider's exec before bb's setup.
    exec: async (sandboxId: string) => {
      execs.push(sandboxId);
      return { exitCode: 0, stdout: "BOAT_MOTD off", stderr: "" };
    },
    stop: async () => undefined,
    delete: async (sandboxId: string) => {
      if (!sandboxes.has(sandboxId)) throw new ProviderError("no such sandbox", { code: "not_found" });
      deleted.push(sandboxId);
      sandboxes.delete(sandboxId);
    },
  } as unknown as SandboxProvider;
  const created: Record<string, unknown>[] = [];
  const service = {
    async createSandbox(options: Record<string, unknown>) {
      created.push(options);
      const sandbox = { ...SANDBOX, id: "ot_1", name: String(options.name) };
      sandboxes.set(sandbox.id, sandbox);
      return sandbox;
    },
    bringUp: async (sandboxId: string) => sandboxes.get(sandboxId)!,
  } as unknown as BoatService;
  registerSandboxMachine(bb, other, { service, settings: async () => defaultSettings(), availability: async () => ({ status: "available" }) });

  type Definition = {
    id: string;
    displayName: string;
    create(args: unknown): Promise<{ status: string; name?: string; message?: string; resource?: unknown }>;
    remove(args: unknown): Promise<{ status: string }>;
  };
  const definition = definitions[0] as unknown as Definition;
  assert.equal(definition.id, "other-sandbox");
  assert.equal(definition.displayName, "Other sandbox");
  assert.deepEqual(environments, [{ id: "other-sandbox", displayName: "Other sandbox", description: "A new sandbox with this project checked out", icon: "ComputerCloud", machineProviderId: "other-sandbox", environmentProviderId: "project-checkout" }]);

  const steps: string[] = [];
  const report = { step: (text: string) => void steps.push(text), log: (text: string) => void steps.push(`log: ${text}`) };
  const args = (key: string, inputs: unknown = {}) => ({ inputs, key, checkpoint: async () => undefined, report, signal: new AbortController().signal });
  const result = await definition.create(args("k1"));
  assert.equal(result.status, "created", result.message);
  assert.equal(result.name, "Other ot_1 (123456)");
  assert.deepEqual(created.map((options) => [options.name, options.type, options.gitGuard]), [["bb machine k1", "small", false]]);
  assert.deepEqual(steps.slice(0, 3), ["Creating the other sandbox", "log: other sandbox ot_1", "Installing bb on the sandbox"]);
  assert.deepEqual(executors, ["ot_1"], "bb's bootstrap ran through the provider's executor");
  assert.deepEqual(execs, ["ot_1"], "the login scripts were quieted through the provider's exec");
  // Its own sandbox ids and sizes: a boat id or size is refused.
  assert.equal((await definition.create(args("k2", { sandboxId: "bx_1" }))).message, "Other machine options are invalid.");
  assert.equal((await definition.create(args("k3", { type: "large" }))).message, "Other machine options are invalid.");
  assert.equal((await definition.remove({ resource: { sandboxId: "ot_1", key: "k1" } })).status, "removed");
  assert.deepEqual(deleted, ["ot_1"]);
  assert.equal((await definition.remove({ resource: { sandboxId: "ot_1", key: "k1" } })).status, "removed", "already gone counts as removed");
});
