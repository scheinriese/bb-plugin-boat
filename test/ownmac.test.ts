import { PLUGIN_SETTINGS, settingProblem } from "../src/settings.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import {
  createOwnMacProvider,
  type OwnMacConfig,
} from "../src/providers/ownmac/provider.ts";
import {
  AVAILABILITY_SCRIPT,
  availability,
  parseReading,
  refusal,
  type Reading,
} from "../src/providers/ownmac/probe.ts";
import { ownMacConfigSchema, sshAliasSchema } from "../contract-providers.ts";
import {
  createCredentialSource,
  CREDENTIAL_CLEANUP_SCRIPT,
  GITHUB_LOGIN_SCRIPT,
  type CredentialSource,
} from "../src/credentials.ts";
import { createProviderRegistry } from "../src/providers/registry.ts";
import { createBoatProvider } from "../src/providers/boat/provider.ts";
import type { BoatApi } from "../src/providers/boat/api.ts";
import { FakeBoat, FakeChat, defaultSettings, memoryStore } from "./fakes.ts";
import { BoatService } from "../src/service.ts";
import { providerHandlers, runsOnOf } from "../src/rpc-providers.ts";
import type { Runtime } from "../src/runtime.ts";
import type { SshRequest } from "../src/providers/scaleway/ssh.ts";
import { normalizeProject, toOrchestratorProject } from "../src/projects.ts";
import { runsOnLine } from "../web/providers-logic.ts";

const local = { hardware: "a".repeat(64), user: "fake-owner", uid: 501 };
const reading: Reading = {
  hardware: local.hardware,
  user: "fake-worker",
  uid: 502,
  admin: false,
  ac: true,
  session: true,
  memoryMiB: 32768,
  freeMiB: 24576,
  cpus: 8,
  load: 0.5,
  running: 0,
};
const output = (value: Reading) =>
  Object.entries(value)
    .map(
      ([key, value]) =>
        `${key}=${typeof value === "boolean" ? (value ? 1 : 0) : value}`,
    )
    .join("\n");
const input = {
  name: "fake task",
  type: "small" as const,
  system: "macos" as const,
  ttlSeconds: 0,
  gitGuard: true,
};
async function fixture(source?: CredentialSource) {
  const data = new Map<string, unknown>();
  const kv = {
    get: async (key: string) => data.get(key),
    set: async (key: string, value: unknown) => {
      data.set(key, structuredClone(value));
    },
  } as PluginKvStorage;
  const config: OwnMacConfig = {
    ownMacIsolation:"vm",
    ownMacAlias: "fake-mac",
    ownMacEnabled: true,
    ownMacPaused: false,
    ownMacMaxTasks: 1,
  };
  const calls: { alias: string; request: SshRequest }[] = [],
    cleaned: string[] = [];
  let current = { ...reading },
    fail = false,
    cleanupFail = false,
    clock = 0;
  const boat = new FakeBoat();
  const credentials: CredentialSource = source ?? {
    githubConfigured: async () => false,
    agentAvailable: async () => true,
    assertGithubAccess: async () => {},
    assertReady: async () => {},
    ensureGithub: async () => null,
    cleanupGithub: async () => {},
    cleanup: async (id) => {
      if (cleanupFail) throw Error("fake cleanup failed");
      cleaned.push(id);
    },
  };
  const options = {
    config: async () => config,
    kv,
    credentials,
    now: () => clock,
    local: async () => local,
    ssh: async (alias: string, request: SshRequest) => {
      calls.push({ alias, request });
      if (fail) return { exitCode: 255, stdout: "", stderr: "fake offline" };
      if (request.command.at(-1) === AVAILABILITY_SCRIPT)
        return { exitCode: 0, stdout: output(current), stderr: "" };
      if (request.stdin === undefined)
        return boat.exec("fake", request.command.at(-1)!);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const provider = await createOwnMacProvider(options);
  return {
    provider,
    config,
    calls,
    cleaned,
    kv,
    options,
    set: (patch: Partial<Reading>) => {
      current = { ...current, ...patch };
    },
    offline: (value = true) => {
      fail = value;
    },
    cleanupFail: (value = true) => {
      cleanupFail = value;
    },
    tick: () => {
      clock += 45001;
    },
  };
}
for (const [name, remote, expected] of [
  [
    "same machine and user",
    { ...reading, user: local.user, uid: local.uid },
    true,
  ],
  ["same name", { ...reading, user: local.user }, true],
  ["same uid", { ...reading, uid: local.uid }, true],
  ["separate user", reading, false],
  [
    "VM",
    { ...reading, hardware: "b".repeat(64), user: local.user, uid: local.uid },
    false,
  ],
  ["administrator", { ...reading, admin: true }, true],
] as const)
  test(`Your Mac identity guard: ${name}`, () =>
    assert.equal(refusal(remote, local) !== null, expected));
for (const [state, patch] of [
  ["Available", {}],
  ["On battery", { ac: false }],
  ["No logged-in session", { session: false }],
  ["Not enough free memory", { freeMiB: 1024 }],
  ["Not enough free CPU", { load: 9 }],
  ["At task limit", { running: 1 }],
] as const)
  test(`Your Mac probe parses ${state}`, () => {
    const parsed = parseReading(output({ ...reading, ...patch }));
    assert.equal(availability(parsed, local, 0, 1), state);
  });
test("malformed and missing probe fields fail closed", () => {
  for (const value of [
    "",
    output(reading).replace("ac=1", "ac=unknown"),
    output(reading).replace("freeMiB=24576", "freeMiB=NaN"),
    output(reading).replace(/hardware=.*/, "hardware="),
  ])
    assert.throws(() => parseReading(value));
});
for (const alias of ["fake-mac", "fake_vm2", ""])
  test(`SSH alias accepts ${alias || "empty setup"}`, () =>
    assert.equal(sshAliasSchema.safeParse(alias).success, true));
for (const alias of [
  "/tmp/fake-key",
  "~/.ssh/fake",
  "fake mac",
  "-fake",
  "fake@host",
  "host.example",
  "fake\nmac",
  "fake;id",
  "fake/../key",
])
  test(`SSH alias rejects ${JSON.stringify(alias)}`, () =>
    assert.equal(sshAliasSchema.safeParse(alias).success, false));
test("task limits validate at the settings boundary", () => {
  for (const max of [0, 1.5, 17])
    assert.equal(
      ownMacConfigSchema.safeParse({
        ownMacEnabled: true,
        ownMacPaused: false,
        ownMacAlias: "fake",
        ownMacMaxTasks: max,
      }).success,
      false,
    );
});
test("availability caches one cheap SSH probe for 45 seconds", async () => {
  const env = await fixture();
  await env.provider.ownMacStatus!();
  await env.provider.ownMacStatus!();
  assert.equal(env.calls.length, 1);
  env.tick();
  await env.provider.ownMacStatus!();
  assert.equal(env.calls.length, 2);
  env.set({ admin: true });
  assert.match(
    (await env.provider.ownMacStatus!(true)).status,
    /administrator/,
  );
});
test("disabled, unset and paused Macs do not use SSH; network failure is unavailable", async () => {
  const env = await fixture();
  env.config.ownMacEnabled = false;
  assert.equal((await env.provider.ownMacStatus!()).status, "Not set up");
  env.config.ownMacEnabled = true;
  env.config.ownMacAlias = "";
  assert.equal((await env.provider.ownMacStatus!()).status, "Not set up");
  env.config.ownMacAlias = "fake";
  env.config.ownMacPaused = true;
  assert.equal((await env.provider.ownMacStatus!()).status, "Paused");
  assert.equal(env.calls.length, 0);
  env.config.ownMacPaused = false;
  env.offline();
  assert.equal(
    (await env.provider.ownMacStatus!()).status,
    "Asleep or unreachable",
  );
});
test("admission checks identity again even with a warm available cache", async () => {
  const env = await fixture();
  await env.provider.ownMacStatus!();
  env.set({ user: local.user, uid: local.uid });
  await assert.rejects(env.provider.create(input), /personal login/);
  assert.equal(env.calls.length, 2);
});
test("per-task homes, persisted targets and capacity survive restart", async () => {
  const env = await fixture();
  env.config.ownMacMaxTasks = 2;
  const first = await env.provider.create(input),
    second = await env.provider.create(input);
  assert.notEqual(first.id, second.id);
  await assert.rejects(env.provider.create(input), /task limit/);
  await env.provider.exec(first.id, "true");
  assert.match(
    env.calls.at(-1)!.request.command.at(-1)!,
    new RegExp(`HOME=.*${first.id}`),
  );
  const restarted = await createOwnMacProvider(env.options);
  assert.equal((await restarted.ownMacStatus!()).running, 2);
  env.config.ownMacAlias = "fake-new-alias";
  await restarted.closeTaskCredentials!(first.id);
  assert.equal(env.calls.at(-1)!.alias, "fake-mac");
  assert.deepEqual(env.cleaned, [first.id]);
  assert.equal((await restarted.ownMacStatus!()).running, 1);
});
test("cleanup still works when paused and disabled; failed cleanup stays visible and retries", async () => {
  const env = await fixture();
  const task = await env.provider.create(input);
  env.config.ownMacEnabled = false;
  env.config.ownMacPaused = true;
  env.cleanupFail();
  await assert.rejects(
    env.provider.closeTaskCredentials!(task.id),
    /could not be verified/,
  );
  assert.match(env.provider.releaseNotice!()!, /Credential removal/);
  env.cleanupFail(false);
  await env.provider.closeTaskCredentials!(task.id);
  assert.equal(env.provider.releaseNotice!(), null);
});
test("cleanup refuses changed alias identity before touching credentials", async () => {
  const env = await fixture();
  const task = await env.provider.create(input);
  env.set({ hardware: "c".repeat(64) });
  await assert.rejects(
    env.provider.closeTaskCredentials!(task.id),
    /could not be verified/,
  );
  assert.equal(env.cleaned.length, 0);
});
test("unremoved bb machine keeps a proxy cleanup warning", async () => {
  const env = await fixture();
  const task = await env.provider.create(input);
  await assert.rejects(
    env.provider.closeTaskCredentials!(task.id, undefined, false),
    /revoke its agent proxy/,
  );
  assert.match(env.provider.releaseNotice!()!, /proxy/);
  assert.equal((await env.provider.ownMacStatus!()).running, 1);
});
test("Your Mac uses unchanged stdin delivery and verified cleanup scripts", async () => {
  const fakeToken = "fake_github_token";
  const source = createCredentialSource({
    githubToken: async () => fakeToken,
    agentAvailable: async () => true,
    fetch: async () =>
      new Response("{}", {
        headers: {
          "github-authentication-token-expiration": "2030-01-01T00:00:00Z",
        },
      }),
  });
  const env = await fixture(source);
  const task = await env.provider.create(input);
  await env.provider.beforeRepo!(task.id);
  const delivery = env.calls.find(
    (call) => call.request.stdin === `${fakeToken}\n`,
  )!;
  assert.ok(delivery);
  assert.ok(!JSON.stringify(delivery.request.command).includes(fakeToken));
  assert.ok(delivery.request.command.at(-1)!.includes(GITHUB_LOGIN_SCRIPT));
  await env.provider.closeTaskCredentials!(task.id);
  assert.ok(
    env.calls.some((call) =>
      call.request.command.at(-1)?.includes(CREDENTIAL_CLEANUP_SCRIPT),
    ),
  );
});
test("Your Mac reports zero rent without any lease or lease-days", async () => {
  const env = await fixture();
  const usage = await env.provider.usage("fake");
  assert.equal(usage.dollars, 0);
  assert.equal(await env.provider.pricing!(), "$0 rent");
  assert.equal(
    runsOnLine(runsOnOf(env.provider, "small", "boat")),
    "Your Mac · fake-mac · $0",
  );
});

async function routingFixture(monthly = false) {
  const env = await fixture();
  const store = memoryStore(),
    boat = new FakeBoat(),
    chat = new FakeChat();
  const rental = {
    ...createBoatProvider(boat as unknown as BoatApi),
    id: "fake-rental",
    displayName: "Fake rental",
    caps: { ...env.provider.caps, headlessAgentRunner: true },
    idPattern: /^fake_rental_/,
    pricing: async () => "USD 10 minimum",
  };
  // Never allocate in this fixture: held leases must win, or cost consent stops it.
  rental.create = async () => {
    throw Error("unexpected new rental");
  };
  const monthlyProvider = {
    ...rental,
    id: "fake-monthly",
    displayName: "Fake monthly",
    idPattern: /^fake_monthly_/,
    macLeaseKind: "monthly" as const,
  };
  const registry = createProviderRegistry([
    createBoatProvider(new FakeBoat() as unknown as BoatApi),
    rental,
    ...(monthly ? [monthlyProvider] : []),
    env.provider,
  ]);
  let project = normalizeProject({
    id: "fake-mac-project",
    name: "Fake Mac",
    repos: [{ repo: "acme/fake", baseBranch: "main" }],
    sandboxProvider: "ownmac",
    sandboxSystem: "macos",
  });
  const service = new BoatService(registry, store, {
    settings: async () => defaultSettings({ maxActiveSandboxes: 0 }),
    chat,
    lifecycle: new AbortController().signal,
    projects: () => [project],
    changed: () => {},
    notify: async () => {},
    log: { info: () => {}, warn: () => {} },
    connect: async () => ({ state: "ready", detail: "fake", fix: null }),
  });
  const start = (provider = "ownmac", system: "macos" | "linux" = "macos") => {
    project = normalizeProject(
      { ...project, sandboxProvider: provider, sandboxSystem: system },
      project,
    );
    return service.startTask({
      title: "Fake Mac task",
      role: "custom",
      brief: "Check fake tools",
      provider: "claude",
      runner: "chat",
      confirmUntrustedChat: [],
      sandboxSystem: system,
      project: { ...toOrchestratorProject(project), repos: [] },
    });
  };
  function held() {
    const at = Date.now();
    boat.addSandbox("fake_rental_1", "default", "idle");
    store.macLeases.record({
      id: "fake-lease",
      provider: rental.id,
      machineId: "fake_rental_1",
      size: "fake",
      startedAt: new Date(at).toISOString(),
      paidUntil: new Date(at + 86400000).toISOString(),
      minimumCost: 10,
      hourPrice: 0.5,
      currency: "USD",
      cpus: 8,
      memoryMiB: 32768,
    });
  }
  return { ...env, store, chat, service, start, held, rental, boat };
}
test("automatic Mac routing chooses Your Mac before a held rental", async () => {
  const env = await routingFixture();
  env.held();
  const task = await env.start("fake-rental");
  assert.equal(task.sandboxProvider, "ownmac");
  assert.equal(task.status, "running");
  assert.equal(env.store.macLeases.tasks("fake-lease").length, 0);
  assert.equal(env.store.macLeases.held().length, 1);
});
for (const state of ["paused", "battery", "full"] as const)
  test(`Mac routing falls back to held capacity when Your Mac is ${state}`, async () => {
    const env = await routingFixture();
    env.held();
    if (state === "paused") env.config.ownMacPaused = true;
    if (state === "battery") env.set({ ac: false });
    if (state === "full") await env.provider.create(input);
    const task = await env.start();
    assert.equal(task.sandboxProvider, "fake-rental");
    assert.equal(task.sandboxId, "fake_rental_1");
    assert.equal(task.status, "running");
  });
test("Your Mac fallback offers a rental estimate without silently renting", async () => {
  const env = await routingFixture();
  env.config.ownMacPaused = true;
  await assert.rejects(
    env.start(),
    /USD 10 minimum.*Choose this rental provider/,
  );
});
for (const status of ["done", "cancelled"] as const)
  test(`closing Your Mac as ${status} cleans credentials and removes its bb proxy machine`, async () => {
    const env = await routingFixture();
    const task = await env.start();
    assert.equal(task.status, "running");
    await env.service.closeTask(task.id, {
      status,
      discard: true,
      keepSandbox: true,
    });
    assert.deepEqual(env.cleaned, [task.sandboxId]);
    assert.deepEqual(env.chat.removed, [task.hostId]);
    assert.equal(env.store.get(task.id)!.status, status);
    assert.equal((await env.provider.ownMacStatus!()).running, 0);
  });
test("usage RPC includes Your Mac with zero rent and no lease-days", async () => {
  const env = await routingFixture();
  await env.start();
  const usage = await providerHandlers({
    service: env.service,
    bb: {},
  } as unknown as Runtime).macUsage();
  assert.equal(usage.ownMac!.rent, 0);
  assert.equal(usage.ownMac!.running, 1);
  assert.equal(usage.month.leaseDays, 0);
  assert.deepEqual(usage.held, []);
});

test("already rented monthly capacity wins before a held day lease", async () => {
  const env = await routingFixture(true);
  env.config.ownMacPaused = true;
  env.held();
  env.boat.addSandbox("fake_monthly_1", "default", "idle");
  const lease = env.store.macLeases.held()[0]!;
  env.store.macLeases.record({
    ...lease,
    id: "fake-monthly-lease",
    provider: "fake-monthly",
    machineId: "fake_monthly_1",
  });
  const task = await env.start("fake-rental");
  assert.equal(task.sandboxProvider, "fake-monthly");
  assert.equal(env.store.macLeases.tasks("fake-lease").length, 0);
});
test("Linux tasks leave Your Mac untouched", async () => {
  const env = await routingFixture();
  const task = await env.start("boat", "linux");
  assert.equal(task.sandboxProvider ?? "boat", "boat");
  assert.equal(task.status, "running");
  assert.equal(env.calls.length, 0);
});
test("closed task homes cannot receive credentials again", async () => {
  const env = await fixture();
  const task = await env.provider.create(input);
  await env.provider.closeTaskCredentials!(task.id);
  await assert.rejects(env.provider.refreshGithubLogin!(task.id), /closed/);
});
test("CPU and RAM reservations preserve headroom while starts are pending", async () => {
  const env = await fixture();
  env.config.ownMacMaxTasks = 16;
  env.set({ cpus: 4 });
  await env.provider.allocate!(input);
  await assert.rejects(env.provider.allocate!(input), /headroom/);
});

test("settings reject SSH paths, spaces and option-like aliases",()=>{
  for(const alias of ["/tmp/fake-key","fake mac","-fake"])
    assert.ok(settingProblem("ownMacAlias",PLUGIN_SETTINGS.ownMacAlias,alias));
  assert.equal(settingProblem("ownMacAlias",PLUGIN_SETTINGS.ownMacAlias,"fake-mac"),null);
});
