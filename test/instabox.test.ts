// Instabox as the second sandbox provider (src/providers/instabox/), against
// the fake instabox CLI and REST API (src/providers/instabox/fixtures/):
// a machine's whole life, the headless agent runner through the service,
// a task chat's bb setup, and what happens without a key, with Instabox
// down, with an account that isn't activated, and with no room for a machine.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { sandboxDashboardUrl } from "../src/providers/dashboard.ts";
import type { BbPluginApi, MachineExecutor } from "@get-bb/plugin-sdk";
import { InstaboxCli, InstaboxError, redactKeys } from "../src/providers/instabox/cli.ts";
import { InstaboxRest } from "../src/providers/instabox/api.ts";
import { INSTABOX_GIT_ENV, INSTABOX_MACHINE, INSTABOX_MACHINE_PROVIDER_ID, MACHINE_NAME, createInstaboxProvider, machineName, restExecutor } from "../src/providers/instabox/provider.ts";
import { createInstaboxSetup, instaboxPreflight } from "../src/providers/instabox/setup.ts";
import { createInstaboxKeeper, LEASE_ID } from "../src/providers/instabox/keeper.ts";
import { toChatEvents } from "../src/providers/instabox/parse.ts";
import { createProviderRegistry } from "../src/providers/registry.ts";
import { createBoatProvider } from "../src/providers/boat/provider.ts";
import { registerSandboxMachine } from "../src/providers/machine.ts";
import { ProviderError, type SandboxProvider } from "../src/providers/types.ts";
import type { BoatApi } from "../src/providers/boat/api.ts";
import { githubAccessSnippet, prepareRepo } from "../src/sandbox-repos.ts";
import { BoatService, TaskError, type BoatSettings } from "../src/service.ts";
import { normalizeProject, toOrchestratorProject } from "../src/projects.ts";
import { FakeBoat, defaultSettings, memoryStore } from "./fakes.ts";
import { hostCheck, worstCheck } from "../src/paid-resume.ts";
import type { MachineType } from "../src/providers/types.ts";
import type { RunsOnDto, SandboxProvidersResultDto } from "../contract-providers.ts";
// @ts-expect-error: a plain JavaScript fixture.
import { startFakeInstaboxApi } from "../src/providers/instabox/fixtures/fake-api.mjs";

const FAKE_CLI = fileURLToPath(new URL("../src/providers/instabox/fixtures/fake-instabox.mjs", import.meta.url));
/** A made-up key: it must never show up in arguments, output, errors or task history. */
const KEY = "ibk_fake_example_key";
const REPORT = "Done.\n\n=== REPORT ===\nSTATUS: done\nSUMMARY: Added the route.\n=== END REPORT ===";

interface FakeApi {
  url: string;
  received: { method: string; path: string; query: string; keyOk: boolean; accept: string | null; body: Record<string, unknown> | null }[];
  close(): Promise<void>;
}

/** The fake CLI and API on one state file, and an Instabox provider on them. */
async function instabox(t: { after(fn: () => unknown): void }, options: { key?: string | null; state?: Record<string, unknown>; ledger?: import("../src/mac-leases.ts").MacLeaseLedger; secrets?: () => Promise<string>; now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "instabox-"));
  const statePath = join(dir, "state.json");
  if (options.state) writeFileSync(statePath, JSON.stringify(options.state));
  process.env.FAKE_INSTABOX_STATE = statePath;
  process.env.FAKE_INSTABOX_KEY = KEY;
  const api = (await startFakeInstaboxApi({ statePath, key: KEY })) as FakeApi;
  t.after(() => api.close());
  const key = options.key === undefined ? KEY : options.key;
  const cli = new InstaboxCli(async () => FAKE_CLI, async () => key);
  const rest = new InstaboxRest({ key: async () => key, baseUrl: () => api.url });
  const provider = createInstaboxProvider(cli, rest, { ledger: options.ledger, secrets: options.secrets, now: options.now });
  const state = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {}) as Record<string, any>;
  const setState = (patch: Record<string, unknown>) => writeFileSync(statePath, JSON.stringify({ ...state(), ...patch }));
  return { cli, rest, provider, api, state, setState, statePath };
}

/** The query of the last usage request the fake API got. */
function box_api_usage_query(api: FakeApi): string {
  return api.received.filter((entry) => entry.path.endsWith("/usage")).at(-1)?.query ?? "";
}

function hooks(overrides: Record<string, unknown> = {}) {
  const warnings: string[] = [];
  return {
    warnings,
    hooks: {
      settings: async () => defaultSettings({ maxActiveSandboxes: 0 }),
      lifecycle: new AbortController().signal,
      changed: () => undefined,
      notify: async () => undefined,
      log: { info: () => undefined, warn: (line: string) => void warnings.push(line), debug: () => undefined },
      checkPreview: async () => "up" as const,
      ...overrides,
    },
  };
}

const WEB = { id: "web", name: "Web app", repos: [{ repo: "acme/web", baseBranch: "main" }], machineType: null, sandboxProvider: "instabox" };

test("an Instabox machine's life: create, exec, preview, stop, resume, delete", async (t) => {
  const { provider, state, api } = await instabox(t);
  const sandbox = await provider.create({ name: "bb t_1 fix the login", type: "large", environment: "ignored", snapshot: null, ttlSeconds: 7200, gitGuard: true });
  assert.match(sandbox.id, /^m_\d+$/);
  assert.equal(sandbox.state, "idle", "a running machine reads idle (no agent state of Instabox's)");
  assert.equal(sandbox.machineType, "large");
  assert.equal(sandbox.environment, null);
  const created = state().machines[sandbox.id];
  assert.deepEqual(created.envNames, [...Object.keys(INSTABOX_GIT_ENV), "GH_TOKEN"].sort(), "git env plus the selected proxy Secret");
  assert.equal(created.secretSelection, "all");
  assert.equal(created.metadata["created-by"], "bb-boat");
  assert.ok(state().calls.some((call: string) => call.startsWith("create --name bb-t-1-fix-the-login --json --fail-fast --ready-timeout 10m --meta created-by=bb-boat --vcpus 8 --mem-mib 16384")));
  assert.equal(sandbox.name, "bb-t-1-fix-the-login", "a valid Instabox name: lowercase letters, digits and hyphens");

  // exec: one command, its exit code and output; a checkout over it with the plugin's own script.
  const result = await provider.exec(sandbox.id, "echo hi", { timeoutMs: 30_000 });
  assert.deepEqual(result, { exitCode: 0, stdout: "", stderr: "" });
  assert.equal(state().execs.at(-1).timeout, 30);
  const prepared = await prepareRepo(provider, sandbox.id, "acme/web", { kind: "new-branch", branch: "fix-login", base: "main" });
  assert.deepEqual([prepared.path, prepared.branch, prepared.baseBranch, prepared.canPush], ["/data/home/work/web", "fix-login", "main", true]);
  // Capped at Instabox's 600 s.
  await provider.exec(sandbox.id, "true", { timeoutMs: 3_600_000 });
  assert.equal(state().execs.at(-1).timeout, 600);

  // A private preview: the link with its token, kept for the next wake (the token is shown once).
  const hosted = await provider.host(sandbox.id, 3000, "Fix the login");
  assert.equal(hosted.isProtected, true);
  assert.match(hosted.url, /^https:\/\/3000-\d+\.instabox\.test\/\?_token=ibp_/);
  assert.equal((await provider.host(sandbox.id, 3000, "Fix the login")).url, hosted.url, "the same link again");
  // After a reload (no link kept), a republish rotates the token rather than returning no link.
  const reloaded = createInstaboxProvider(new InstaboxCli(async () => FAKE_CLI, async () => KEY), new InstaboxRest({ key: async () => KEY, baseUrl: () => api.url }));
  const rotated = await reloaded.host(sandbox.id, 3000, "Fix the login");
  assert.notEqual(rotated.url, hosted.url);
  assert.ok(state().calls.some((call: string) => call.includes("--rotate-token")));

  // Stop (shut down, disk kept), resume (start), and a paused one resumes with `resume`.
  assert.deepEqual(await provider.stop(sandbox.id), { status: "completed", stopId: null, forced: null, error: null });
  assert.equal((await provider.info(sandbox.id)).state, "stopped");
  assert.equal((await provider.list()).length, 0, "a stopped machine isn't up");
  assert.equal((await provider.list({ all: true })).length, 1);
  await provider.resume(sandbox.id, { ttlSeconds: 3600 });
  assert.equal((await provider.info(sandbox.id)).state, "idle");
  state(); // paused by Instabox's idle check:
  const paused = state();
  paused.machines[sandbox.id].state = "suspended";
  writeFileSync(process.env.FAKE_INSTABOX_STATE!, JSON.stringify(paused));
  assert.equal((await provider.info(sandbox.id)).state, "stopped");
  await provider.resume(sandbox.id, { ttlSeconds: 3600 });
  assert.ok(state().calls.includes(`resume ${sandbox.id} --json`));
  // A size move: resized while stopped, then started.
  await provider.stop(sandbox.id);
  await provider.resume(sandbox.id, { ttlSeconds: 3600, type: "small" });
  assert.equal((await provider.info(sandbox.id)).machineType, "small");

  // Extend: no deadline on Instabox, an activity lease instead (at most an hour).
  assert.deepEqual(await provider.extend(sandbox.id, 4 * 3600), { ttlSeconds: 3600 });
  assert.deepEqual(state().leases, { [`${sandbox.id}:bb-boat-extend`]: { ttlSeconds: 3600 } });
  // Usage: its running time from the API; no price (Instabox bills by allocation and credit).
  const { until: _until, ...usage } = await provider.usage(sandbox.id, { since: "2026-11-19T00:00:00.000Z" });
  assert.deepEqual(usage, { seconds: 5400, hours: 1.5, dollars: null, since: "2026-11-19T00:00:00.000Z", running: null });
  assert.equal(box_api_usage_query(api), "?from=2026-11-19T00%3A00%3A00.000Z");
  // Capacity: the plan's machine limit, stopped and paused machines included.
  const capacity = await provider.capacity();
  assert.deepEqual([capacity.activeSandboxes, capacity.maxActiveSandboxes, capacity.canStart, capacity.tier], [1, 5, true, "pro"]);

  await provider.delete(sandbox.id);
  assert.equal(await provider.findInfo(sandbox.id), null);
  await assert.rejects(provider.info(sandbox.id), (error: unknown) => error instanceof InstaboxError && error.code === "not_found");
  // The key went to the CLI's environment and the API's header only.
  for (const call of state().calls as string[]) assert.ok(!call.includes(KEY));
  assert.ok(api.received.every((entry) => entry.keyOk && !JSON.stringify(entry).includes(KEY)));
});

test("a project that runs on Instabox: the task's sandbox, checkout and headless agent are Instabox's", async (t) => {
  const box = await instabox(t, { state: { autoReply: REPORT } });
  const fakeBoat = new FakeBoat();
  const registry = createProviderRegistry([createBoatProvider(fakeBoat as unknown as BoatApi), box.provider]);
  const store = memoryStore();
  const { hooks: serviceHooks } = hooks({ projects: () => [WEB] });
  const service = new BoatService(registry, store, serviceHooks);
  const project = toOrchestratorProject(normalizeProject({ id: "web", name: "Web app", repos: [{ repo: "acme/web", baseBranch: "main" }] }));
  const { task } = await service.launchTask({ title: "Add a health route", role: "implement", brief: "Add /healthz.", project, provider: "claude" }, 10_000);
  assert.equal(task.status, "running", task.error ?? "");
  assert.equal(task.sandboxProvider, "instabox");
  assert.match(task.sandboxId!, /^m_/);
  assert.equal(task.repoPath, "/data/home/work/web");
  assert.deepEqual(fakeBoat.created, [], "nothing went to boat.dev");
  assert.equal(service.sandboxProvider(task).id, "instabox");
  // The prompt went in on stdin, a new conversation of Instabox's own.
  const calls = box.state().calls as string[];
  assert.ok(calls.some((call) => /^agent prompt m_\d+ --provider claude --json (--model \S+ )?--new -$/.test(call)), calls.join("\n"));
  assert.match(task.conversationId!, /^c\d+$/);
  assert.equal(task.promptId, "turn-1");
  const convo = box.state().convos[task.conversationId!];
  assert.ok(convo.promptBytes[0] > 100, "the brief was on stdin");

  // The sweep reads its events through `instabox agent events` and finishes the turn.
  await service.sweep();
  const done = store.get(task.id)!;
  assert.equal(done.status, "idle", done.error ?? "");
  assert.match(done.result ?? "", /=== REPORT ===/);
  // A follow-up resumes the same conversation.
  await service.followup(task.id, "Also add a test.");
  assert.ok((box.state().calls as string[]).some((call) => call.includes(`--resume ${task.conversationId}`)));
  // The task's provider and machine label for the page.
  assert.ok(fakeBoat.calls.every((call) => !call.includes(task.sandboxId!)));
});

test("a task chat's bb setup on Instabox: Instabox's own step, then bb's command over exec with noHistory and stdin", async (t) => {
  const box = await instabox(t);
  const sandbox = await box.provider.create({ name: "bb machine k1", type: "small", ttlSeconds: 3600, gitGuard: false });
  const definitions: Record<string, unknown>[] = [];
  const outputs: string[] = [];
  const kv = new Map<string, unknown>();
  const bb = {
    log: { warn: () => undefined, debug: () => undefined },
    experimental_machines: {
      register: (definition: Record<string, unknown>) => void definitions.push(definition),
      bootstrap: async ({ executor }: { executor: MachineExecutor }) => {
        // bb's installer: one command, its enrollment secret on stdin.
        const { exitCode } = await executor.exec({ command: ["sh", "-c", "install bb"], stdin: "enrollment-secret-value", timeoutMs: 900_000, signal: new AbortController().signal, onOutput: (chunk) => void outputs.push(chunk) });
        assert.equal(exitCode, 0);
        return { hostId: "host_abcdef123456" };
      },
    },
    experimental_environments: { register: () => undefined },
    storage: { kv: { get: async (key: string) => kv.get(key), set: async (key: string, value: unknown) => void kv.set(key, value), delete: async (key: string) => void kv.delete(key) } },
  } as unknown as BbPluginApi;
  const service = { createSandbox: async () => assert.fail("adopts the prepared machine"), bringUp: async () => assert.fail("it's up") } as never;
  registerSandboxMachine(bb, box.provider, { service, settings: async () => defaultSettings(), availability: async () => ({ status: "available" }) });
  const definition = definitions[0] as { id: string; create(args: unknown): Promise<{ status: string; name?: string; message?: string }> };
  assert.equal(definition.id, INSTABOX_MACHINE_PROVIDER_ID);
  const steps: string[] = [];
  const result = await definition.create({ inputs: { sandboxId: sandbox.id, taskId: "t_1" }, key: "task-t_1", checkpoint: async () => undefined, report: { step: (text: string) => void steps.push(text), log: (text: string) => void steps.push(text) }, signal: new AbortController().signal });
  assert.equal(result.status, "created", result.message);
  assert.equal(result.name, `Instabox ${sandbox.id} (123456)`);
  // Step 1, on its own: linger and the Secrets CA (a short exec of the CLI's).
  assert.equal(box.state().execs.at(-1).marker, "BOAT_IBX");
  // Step 2: bb's command over the API, streamed, never in the machine's history, capped at 600 s.
  const exec = box.api.received.find((entry) => entry.path === `/v1/machines/${sandbox.id}/exec`)!;
  assert.equal(exec.accept, "text/event-stream");
  assert.deepEqual(exec.body, { cmd: "'sh' '-c' 'install bb'", stdin: "[23 chars]", timeoutSeconds: 600, noHistory: true });
  assert.deepEqual(outputs, ["installing bb\n", "a warning\n"]);
  // A setup that runs past the cap says so.
  box.setState({ execTimesOut: true });
  await assert.rejects(
    restExecutor(box.rest, sandbox.id).exec({ command: ["true"], stdin: "", timeoutMs: 900_000, signal: new AbortController().signal, onOutput: () => undefined }),
    /past Instabox's 10-minute limit for one command/,
  );
});

test("the keeper holds an activity lease while a bb chat works on an Instabox machine, and lets go after", async (t) => {
  const box = await instabox(t);
  const sandbox = await box.provider.create({ name: "bb machine k2", type: "default", ttlSeconds: 3600, gitGuard: false });
  let status = "active";
  const bb = {
    sdk: {
      hosts: { list: async () => [{ id: "host_1", machineProviderId: INSTABOX_MACHINE_PROVIDER_ID, lifecycle: { phase: "active" } }, { id: "host_2", machineProviderId: "boat-sandbox", lifecycle: { phase: "active" } }] },
      threads: { list: async () => [{ id: "thr_1", status }] },
    },
    experimental_machines: { getResource: async (hostId: string) => (hostId === "host_1" ? { sandboxId: sandbox.id, key: "k2" } : null) },
  } as unknown as BbPluginApi;
  const keep = createInstaboxKeeper(bb, { rest: box.rest });
  await keep();
  assert.deepEqual(box.state().leases, { [`${sandbox.id}:${LEASE_ID}`]: { ttlSeconds: 900 } });
  status = "idle";
  await keep();
  assert.deepEqual(box.state().leases, {}, "released once the chat is done: the idle pause applies again");
});

test("without a key, Instabox isn't enabled: its tasks refuse, nothing goes to boat.dev, and the doctor says how to add one", async (t) => {
  const box = await instabox(t, { key: null });
  let keyPresent = false;
  const fakeBoat = new FakeBoat();
  const registry = createProviderRegistry([createBoatProvider(fakeBoat as unknown as BoatApi), box.provider], { isEnabled: (provider) => provider.id !== "instabox" || keyPresent });
  assert.deepEqual(registry.enabled.map((provider) => provider.id), ["boat"]);
  assert.equal(registry.get("instabox"), null);
  assert.equal(registry.forTask({ sandboxProvider: "instabox" }).displayName, "Instabox");
  await assert.rejects(registry.forTask({ sandboxProvider: "instabox" }).list(), (error: unknown) => error instanceof ProviderError && error.code === "provider_unavailable");
  // A machine id of Instabox's fails closed too, never goes to boat.dev.
  await assert.rejects(registry.forSandbox("m_000001").findInfo("m_000001"), (error: unknown) => error instanceof ProviderError && error.code === "provider_unavailable");
  // The provider itself refuses before spawning anything.
  await assert.rejects(box.provider.list(), (error: unknown) => error instanceof InstaboxError && error.code === "key_missing" && /Instabox API key/.test(error.explain().hint ?? ""));
  assert.equal(box.state().calls?.length ?? 0, 0);

  // A project on Instabox: its new task refuses with what to do.
  const service = new BoatService(registry, memoryStore(), hooks({ projects: () => [WEB] }).hooks);
  const project = toOrchestratorProject(normalizeProject({ id: "web", name: "Web app", repos: [{ repo: "acme/web", baseBranch: "main" }] }));
  await assert.rejects(service.launchTask({ title: "x", role: "implement", brief: "x", project }, 5_000), (error: unknown) => error instanceof TaskError && error.code === "provider_unavailable" && /Web app runs on Instabox, which isn't turned on/.test(error.message));
  assert.deepEqual(fakeBoat.created, []);

  // The doctor's checks.
  const setup = createInstaboxSetup({ cli: box.cli, turnedOn: async () => true, keyPresent: () => keyPresent });
  const status = await setup.status({ force: true });
  assert.equal(status.ok, false);
  const key = status.checks.find((check) => check.id === "key")!;
  assert.equal(key.state, "missing");
  assert.match(key.fix!.text, /Settings → Plugins → Harbormaster → Instabox API key/);
  await assert.rejects(instaboxPreflight(setup), (error: unknown) => error instanceof TaskError && error.code === "setup_required");
  // Stored: enabled.
  keyPresent = true;
  assert.deepEqual(registry.enabled.map((provider) => provider.id), ["boat", "instabox"]);
});

test("Instabox down: a clear provider error, and a running task isn't marked failed or its sandbox gone", async (t) => {
  const box = await instabox(t, { state: { autoReply: null } });
  const fakeBoat = new FakeBoat();
  const registry = createProviderRegistry([createBoatProvider(fakeBoat as unknown as BoatApi), box.provider]);
  const store = memoryStore();
  const { hooks: serviceHooks, warnings } = hooks({ projects: () => [WEB] });
  const service = new BoatService(registry, store, serviceHooks);
  const project = toOrchestratorProject(normalizeProject({ id: "web", name: "Web app", repos: [{ repo: "acme/web", baseBranch: "main" }] }));
  const { task } = await service.launchTask({ title: "Slow work", role: "implement", brief: "Do it.", project, provider: "codex" }, 10_000);
  assert.equal(task.status, "running", task.error ?? "");
  // A boat.dev task runs next to it.
  fakeBoat.addSandbox("bx_1", "default", "idle");

  box.setState({ fail: "down" });
  await assert.rejects(box.provider.list(), (error: unknown) => {
    assert.ok(error instanceof InstaboxError);
    assert.equal(error.code, "host_unavailable");
    assert.equal(error.retryable, true);
    assert.match(error.explain().message, /Instabox isn't answering right now/);
    assert.match(error.explain().hint ?? "", /nothing was marked failed/);
    return true;
  });
  await service.sweep();
  await service.sweep();
  const after = store.get(task.id)!;
  assert.equal(after.status, "running", "still running: Instabox is only unreachable");
  assert.equal(after.error, null);
  assert.ok(warnings.some((line) => /sweep: instabox list failed/.test(line)), warnings.join("\n"));
  // boat.dev's sandboxes still list; Instabox's are named as unreadable.
  const listed = await service.listSandboxes({ all: true });
  assert.deepEqual(listed.sandboxes.map((sandbox) => [sandbox.id, sandbox.provider]), [["bx_1", "boat"]]);
  assert.deepEqual(listed.failed.map((entry) => entry.provider), ["instabox"]);
  // The REST side says the same.
  await assert.rejects(box.rest.lease(task.sandboxId!, "x", 60), (error: unknown) => error instanceof InstaboxError && error.code === "host_unavailable");
  // Back up: the turn is read again.
  box.setState({ fail: null });
  await service.sweep();
  assert.equal(store.get(task.id)!.status, "running");
});

test("an account that isn't activated (403 invite_required): the doctor and the error say how to get in", async (t) => {
  const box = await instabox(t, { state: { fail: "invite" } });
  await assert.rejects(box.provider.create({ name: "bb t_9", type: "default", ttlSeconds: 3600, gitGuard: true }), (error: unknown) => {
    assert.ok(error instanceof InstaboxError);
    assert.equal(error.code, "invite_required");
    assert.equal(error.status, 403);
    assert.deepEqual(error.explain(), { code: "invite_required", message: "Your Instabox account isn't activated yet (invite only).", hint: error.explain().hint });
    assert.match(error.explain().hint ?? "", /invite code|paid plan/);
    return true;
  });
  const status = await createInstaboxSetup({ cli: box.cli, turnedOn: async () => true, keyPresent: () => true }).status({ force: true });
  const account = status.checks.find((check) => check.id === "account")!;
  assert.equal(account.state, "missing");
  assert.match(account.fix?.text ?? "", /invite/);
  assert.equal(Object.keys(box.state().machines).length, 0);
});

test("no room on Instabox: create fails at once with no_capacity and leaves no machine; the task fails with that", async (t) => {
  const box = await instabox(t, { state: { fail: "no_capacity" } });
  await assert.rejects(box.provider.create({ name: "bb t_3", type: "default", ttlSeconds: 3600, gitGuard: true }), (error: unknown) => {
    assert.ok(error instanceof InstaboxError);
    assert.equal(error.code, "no_capacity");
    assert.equal(error.retryable, true);
    assert.equal(error.explain().message, "Instabox has no room for a new machine right now.");
    return true;
  });
  assert.deepEqual(box.state().machines, {});
  // Through the service: the task fails with Instabox's words (a create isn't retried behind the user's back).
  const store = memoryStore();
  const registry = createProviderRegistry([createBoatProvider(new FakeBoat() as unknown as BoatApi), box.provider]);
  const service = new BoatService(registry, store, hooks({ projects: () => [WEB] }).hooks);
  const project = toOrchestratorProject(normalizeProject({ id: "web", name: "Web app", repos: [{ repo: "acme/web", baseBranch: "main" }] }));
  await assert.rejects(service.launchTask({ title: "x", role: "implement", brief: "x", project }, 10_000), /no host has room/);
  const failed = store.list({ limit: 10 })[0]!;
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /no host has room/);
  // At the plan's machine limit (stopped ones count), no start either, and nothing is stopped to make room.
  box.setState({ fail: null, maxMachines: 1 });
  await box.provider.create({ name: "bb other", type: "default", ttlSeconds: 3600, gitGuard: false });
  const capacity = await box.provider.capacity();
  assert.equal(capacity.canStart, false);
  assert.match(capacity.blockedReason ?? "", /paused and stopped ones count/);
  await assert.rejects(service.launchTask({ title: "y", role: "implement", brief: "y", project }, 10_000), (error: unknown) => error instanceof TaskError && error.code === "provider_start_blocked" && /Instabox will not start a machine right now/.test(error.message));
  assert.equal((box.state().calls as string[]).filter((call) => call.startsWith("stop ")).length, 0, "nothing stopped to make room");
});

test("Instabox's agent events read into turns: Claude's and Codex's messages, an interrupted and a lost turn", () => {
  const events = toChatEvents(
    {
      status: "lost",
      events: [
        { type: "instabox.turn", turn: 1, jobId: "job_1", prompt: "Fix it" },
        { type: "assistant", message: { content: [{ type: "text", text: "Looking." }, { type: "tool_use", name: "Edit" }] } },
        { type: "result", result: "Fixed.", is_error: false },
        { type: "instabox.turn_end", exitCode: 0, interrupted: false },
        { type: "instabox.turn", turn: 2, jobId: "job_2" },
        { type: "item.completed", item: { type: "agent_message", text: "On it." } },
        { type: "instabox.turn_end", exitCode: 130, interrupted: true },
        { type: "instabox.turn", turn: 3, jobId: "job_3" },
      ],
    },
    "c1",
  );
  assert.deepEqual(
    events.map((event) => [event.type, event.promptId, event.status, event.content, event.tools]),
    [
      ["prompt", "turn-1", "running", "Fix it", []],
      ["response", "turn-1", null, "Looking.", ["Edit"]],
      ["response", "turn-1", null, "Fixed.", []],
      ["prompt", "turn-1", "finished", null, []],
      ["prompt", "turn-2", "running", null, []],
      ["response", "turn-2", null, "On it.", []],
      ["prompt", "turn-2", "interrupted", null, []],
      ["prompt", "turn-3", "running", null, []],
      ["prompt", "turn-3", "failed", null, []],
    ],
  );
  assert.equal(events.at(-1)!.error, "Instabox lost the agent's job");
});

test("keys never show in Instabox's messages", () => {
  assert.equal(redactKeys("bad key ibk_fake_example_1 and port ibp_fake_example_2"), "bad key ib…_[hidden] and port ib…_[hidden]");
  const provider: Pick<SandboxProvider, "id"> = { id: "instabox" };
  assert.equal(provider.id, "instabox");
});

test("the plugin with Instabox on and a key in bb's secret settings: providers, doctor, runs on, machines and lists; the key shows nowhere", async (t) => {
  const box = await instabox(t, { state: { autoReply: REPORT } });
  process.env.FAKE_BOAT_STATE = join(mkdtempSync(join(tmpdir(), "instabox-boat-")), "state.json");
  const fakeBoat = fileURLToPath(new URL("../src/providers/boat/fixtures/fake-boat.mjs", import.meta.url));
  const previousUrl = process.env.INSTABOX_API_URL;
  process.env.INSTABOX_API_URL = box.api.url;
  t.after(() => {
    if (previousUrl === undefined) delete process.env.INSTABOX_API_URL;
    else process.env.INSTABOX_API_URL = previousUrl;
  });
  const { createTestHost } = await import("./fakes.ts");
  const { default: plugin } = await import("../server.ts");
  const { bb, harness } = await createTestHost({
    pluginId: "boat",
    settings: { boatPath: fakeBoat, evidenceUploader: "", instaboxEnabled: true, instaboxPath: FAKE_CLI, instaboxApiKey: KEY },
    agentSkillIds: ["boat", "boat-orchestrator"],
  });
  t.after(() => harness.lifecycle.dispose());
  harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_1" }));
  await plugin(bb);
  const cli = (args: string[]) => harness.runCli(args, { cwd: "/work" });

  // bb offers Instabox machines for task chats (registered at load, with Instabox on).
  assert.ok(harness.inspection.registrations.machineProviders.has(INSTABOX_MACHINE_PROVIDER_ID));
  assert.ok(harness.inspection.registrations.machineProviders.has("boat-sandbox"));

  // Settings › Sandbox providers (the providers UI's view): Instabox on and connected, Linux ready, Mac next,
  // its key in bb's secret setting (named, never shown), and what Instabox itself says it cost.
  const providers = (await harness.callRpc("sandboxProviders", null)) as SandboxProvidersResultDto;
  const ibx = providers.providers.find((entry) => entry.id === "instabox")!;
  assert.deepEqual([ibx.enabled, ibx.connection, ibx.apiKey], [true, "connected", { setting: "Instabox API key" }]);
  assert.deepEqual(ibx.systems.map((system) => [system.os, system.ready, system.note]), [["linux", true, null], ["macos", false, "coming next"], ["windows", false, "not launched yet"]]);
  assert.equal(ibx.pricing, "$3.21 used this month · $16.79 credit left");
  assert.equal(providers.options.find((option) => option.provider === "instabox")!.disabledReason, null);
  const listed = await cli(["providers"]);
  assert.equal(listed.exitCode, 0, listed.stderr);
  assert.match(listed.stdout, /Instabox: ready\n {2}API key: stored/);

  // The doctor checks Instabox too.
  const doctor = await cli(["doctor", "--json"]);
  const report = JSON.parse(doctor.stdout) as { instabox?: { ok: boolean; checks: { id: string; state: string }[] } };
  assert.equal(report.instabox?.ok, true);
  assert.deepEqual(report.instabox?.checks.map((check) => [check.id, check.state]), [["enabled", "ok"], ["cli", "ok"], ["key", "ok"], ["account", "ok"], ["capacity", "ok"]]);

  // A project runs on Instabox.
  const added = await cli(["project", "add", "--name", "Web app", "--repo", "acme/web@main"]);
  assert.equal(added.exitCode, 0, added.stderr);
  const set = await cli(["config", "runs-on", "web-app", "instabox"]);
  assert.equal(set.exitCode, 0, set.stderr);
  assert.match(set.stdout, /web-app now runs on Instabox\./);
  assert.match((await cli(["config", "runs-on"])).stdout, /web-app {2}Web app {2}runs on Instabox/);
  const projects = (await harness.callRpc("projects", null)) as { projects: { id: string; sandboxProvider?: string }[] };
  assert.equal(projects.projects[0]!.sandboxProvider, "instabox");
  // The page's Runs on sets the same field.
  assert.deepEqual(await harness.callRpc("setProjectRunsOn", { projectId: "web-app", provider: "boat" }), { projectId: "web-app", name: "Web app", detail: "acme/web · Linux", provider: "boat", chosen: false });
  assert.equal((await harness.callRpc("setProjectRunsOn", { projectId: "web-app", provider: "instabox" }) as { provider: string }).provider, "instabox");

  // A task of the project: on an Instabox machine, headless, finished by the sweep.
  const started = await cli(["task", "start", "--title", "Add a health route", "--brief", "Add /healthz.", "--project", "web-app", "--headless"]);
  assert.equal(started.exitCode, 0, started.stderr);
  const taskId = started.stdout.match(/Task (t_[a-z0-9]+)/)![1]!;
  assert.doesNotMatch(started.stdout, /boat\.dev\/dashboard/);
  const tasks = (await harness.callRpc("tasks", { statuses: null, threadId: null, limit: 10 })) as { tasks: { id: string; sandboxId: string | null; runsOn?: RunsOnDto }[] };
  const task = tasks.tasks.find((entry) => entry.id === taskId)!;
  assert.match(task.sandboxId ?? "", /^m_/);
  assert.deepEqual([task.runsOn?.provider, task.runsOn?.label, task.runsOn?.os], ["instabox", "Instabox", "linux"]);
  // Its sandbox in the lists, with its provider.
  const sandboxes = (await harness.callRpc("sandboxes", { all: true })) as { sandboxes: { id: string; runsOn?: RunsOnDto; sshCommand: string; dashboardUrl: string | null }[] };
  const sandbox = sandboxes.sandboxes.find((entry) => entry.id === task.sandboxId)!;
  assert.deepEqual([sandbox.runsOn?.provider, sandbox.sshCommand], ["instabox", `instabox ssh ${task.sandboxId}`]);
  assert.equal(sandbox.dashboardUrl, null);
  const detail = await harness.callRpc("task", { id: taskId }) as { task: { dashboardUrl: string | null } };
  assert.equal(detail.task.dashboardUrl, null);
  const shown = await cli(["task", "show", taskId]);
  const tool = await harness.callAgentTool("boat_task", { task_id: taskId });
  assert.doesNotMatch(JSON.stringify([shown, tool]), /boat\.dev\/dashboard/);
  assert.match((await cli(["sandbox", "list", "--all"])).stdout, new RegExp(`Instabox {2}${task.sandboxId}`));

  // boat.dev's wake procedure isn't for an Instabox machine: refused, with what brings it back.
  const wake = await cli(["sandbox", "wake", taskId]);
  assert.notEqual(wake.exitCode, 0);
  assert.match(`${wake.stdout}${wake.stderr}`, new RegExp(`runs on Instabox machine ${task.sandboxId}, which isn't on boat\\.dev: this wake is for boat\\.dev sandboxes`));
  assert.match(`${wake.stdout}${wake.stderr}`, new RegExp(`bb boat sandbox resume ${task.sandboxId}`));
  assert.ok(!(box.state().calls as string[]).some((call) => call.startsWith("stop ")), "nothing of boat's wake ran on it");

  // The key: never in what the CLI printed, the page got, the logs, or the task's history.
  const everything = JSON.stringify([
    listed,
    doctor,
    providers,
    tasks,
    sandboxes,
    await cli(["task", "show", taskId, "--json"]),
    await cli(["config", "get", "--json"]),
    await cli(["config", "export"]),
    harness.inspection.logEntries,
    box.state(),
    box.api.received,
  ]);
  assert.ok(!everything.includes(KEY), "the key shows nowhere");
  assert.ok(!everything.includes("ibsec_"), "the placeholder shows nowhere");
  assert.ok(!everything.includes("instaboxApiKey\":\"ibk"), "not even as a setting value");
});

test("machine names follow Instabox's rule: lowercase letters, digits and hyphens, at most 63, from a letter or digit", () => {
  assert.equal(machineName("bb t_1a2b3c4d Fix the LOGIN!"), "bb-t-1a2b3c4d-fix-the-login");
  assert.equal(machineName("__weird..name__"), "weird-name");
  assert.equal(machineName(""), "bb-machine");
  const long = machineName(`bb t_1a2b3c4d ${"very-long-title-".repeat(8)}`);
  assert.ok(long.length <= 63 && MACHINE_NAME.test(long) && !long.endsWith("-"), long);
  // bb machine names are found again by name after a lost create: already valid.
  for (const key of ["task-t_1a2b3c4d", "task-t_1a2b3c4d-m1xyz", "Orchestrator_Key.1"]) assert.match(INSTABOX_MACHINE.machineName(key), MACHINE_NAME);
});

/** A service with boat.dev (FakeBoat) and Instabox (the fakes), and settings a test can change. */
async function bothProviders(
  t: { after(fn: () => unknown): void },
  options: { state?: Record<string, unknown>; settings?: Partial<BoatSettings>; instabox?: (provider: SandboxProvider) => SandboxProvider; serviceHooks?: Record<string, unknown> } = {},
) {
  const box = await instabox(t, { state: options.state });
  const fakeBoat = new FakeBoat();
  const store = memoryStore();
  let settings = defaultSettings({ maxActiveSandboxes: 0, ...options.settings });
  const registry = createProviderRegistry([createBoatProvider(fakeBoat as unknown as BoatApi), options.instabox?.(box.provider) ?? box.provider]);
  const service = new BoatService(registry, store, {
    ...hooks({ projects: () => [WEB] }).hooks,
    settings: async () => settings,
    sizeTiming: { checkMs: 2_000, pollMs: 1, stopMs: 5_000, startMs: 5_000, reconnectMs: 2_000 },
    ...options.serviceHooks,
  });
  const project = toOrchestratorProject(normalizeProject({ id: "web", name: "Web app", repos: [{ repo: "acme/web", baseBranch: "main" }] }));
  return { box, fakeBoat, store, service, registry, project, setSettings: (next: Partial<BoatSettings>) => void (settings = { ...settings, ...next }) };
}

test("a stopped Instabox machine resumes at the plan's machine limit (it's counted already); a new one doesn't", async (t) => {
  const env = await bothProviders(t, { state: { autoReply: REPORT, maxMachines: 1 } });
  const { task } = await env.service.launchTask({ title: "Fix it", role: "implement", brief: "x", project: env.project }, 10_000);
  assert.equal(task.status, "running", task.error ?? "");
  await env.service.sweep();
  await env.box.provider.stop(task.sandboxId!);
  // One machine on a one-machine plan, stopped: Instabox says no new machine can start…
  assert.equal((await env.box.provider.capacity()).canStart, false);
  // …but bringing that one back adds none: it resumes.
  const resumed = await env.service.bringUp(task.sandboxId!);
  assert.equal(resumed.state, "idle");
  assert.ok((env.box.state().calls as string[]).includes(`start ${task.sandboxId} --json`));
  // A follow-up on the task resumes it the same way.
  await env.box.provider.stop(task.sandboxId!);
  await env.service.followup(task.id, "One more thing.");
  assert.equal((await env.box.provider.info(task.sandboxId!)).state, "idle");
  // A new machine is still refused at the plan's limit.
  await assert.rejects(env.service.launchTask({ title: "Other", role: "implement", brief: "y", project: env.project }, 10_000), (error: unknown) => error instanceof TaskError && error.code === "provider_start_blocked");
});

test("Sandboxes at once counts the Instabox machines running, not the ones it keeps stopped", async (t) => {
  const env = await bothProviders(t, { state: { autoReply: REPORT }, settings: { maxActiveSandboxes: 1 } });
  const first = (await env.service.launchTask({ title: "One", role: "implement", brief: "x", project: env.project }, 10_000)).task;
  await env.service.sweep();
  await env.box.provider.stop(first.sandboxId!);
  // One stopped, none running: a second task gets a machine (two kept, one running).
  const second = (await env.service.launchTask({ title: "Two", role: "implement", brief: "y", project: env.project }, 10_000)).task;
  assert.equal(second.status, "running", second.error ?? "");
  await env.service.sweep();
  // One running (the cap): the stopped one can't resume beside it, refused in plain words…
  await assert.rejects(env.service.bringUp(first.sandboxId!), (error: unknown) => {
    assert.ok(error instanceof TaskError);
    assert.equal(error.code, "boat_at_capacity");
    assert.match(error.message, /^All 1 sandboxes Sandboxes at once allows are running/);
    return true;
  });
  assert.ok(!(env.box.state().calls as string[]).some((call) => call.startsWith("stop ") && call.includes(second.sandboxId!)), "nothing stopped to make room on Instabox");
  // …and it resumes once the other is stopped, though two machines are kept.
  await env.box.provider.stop(second.sandboxId!);
  assert.equal((await env.service.bringUp(first.sandboxId!)).state, "idle");
  // A new machine counts against the cap too.
  await assert.rejects(env.service.launchTask({ title: "Three", role: "implement", brief: "z", project: env.project }, 10_000), (error: unknown) => error instanceof TaskError && error.code === "boat_at_capacity");
});

test("an automatic review of an Instabox task reads Instabox's room: at its limit it shares the parent's running machine, whatever boat.dev says", async (t) => {
  const env = await bothProviders(t, { state: { autoReply: REPORT, maxMachines: 1 }, settings: { reviewSandbox: "auto" } });
  const { task } = await env.service.launchTask({ title: "Fix it", role: "implement", brief: "x", project: env.project }, 10_000);
  await env.service.sweep();
  assert.equal(env.store.get(task.id)!.status, "idle");
  // boat.dev has room, and can't even be listed: neither matters for a review that stays on Instabox.
  env.fakeBoat.list = async () => {
    throw new Error("boat is down");
  };
  const { task: review } = await env.service.launchTask(await env.service.reviewInput(task.id), 10_000);
  assert.equal(review.status, "running", review.error ?? "");
  assert.equal(review.sandboxProvider, "instabox");
  assert.equal(review.sandboxId, task.sandboxId, "Instabox is full: the review shares the parent's running machine");
  assert.deepEqual(env.fakeBoat.created, []);
  // With room on Instabox, the review gets its own machine there.
  const env2 = await bothProviders(t, { state: { autoReply: REPORT, maxMachines: 5 }, settings: { reviewSandbox: "auto" } });
  const parent = (await env2.service.launchTask({ title: "Fix it", role: "implement", brief: "x", project: env2.project }, 10_000)).task;
  await env2.service.sweep();
  const own = (await env2.service.launchTask(await env2.service.reviewInput(parent.id), 10_000)).task;
  assert.equal(own.sandboxProvider, "instabox");
  assert.notEqual(own.sandboxId, parent.sandboxId);
  assert.match(own.sandboxId ?? "", /^m_/);
});

/** A move of the task's sandbox to another size, from the page. */
const resizeTo = (taskId: string, type: MachineType) => ({ taskId, type, message: null, userApproved: true, notifyThreadId: null, waitMs: 20_000, by: "page" as const });

test("resizing an Instabox machine at its plan's machine limit is a restart, not a new machine: it moves", async (t) => {
  const env = await bothProviders(t, { state: { autoReply: REPORT, maxMachines: 1 } });
  const { task } = await env.service.launchTask({ title: "Fix it", role: "implement", brief: "x", project: env.project }, 10_000);
  await env.service.sweep();
  assert.equal(env.store.get(task.id)!.status, "idle");
  assert.equal((await env.box.provider.capacity()).canStart, false, "no new machine fits the plan");
  // The dialog: nothing blocks the move.
  const info = await env.service.sizes.info(task.id);
  assert.equal(info.blocker, null, JSON.stringify(info.blocker));
  // The move: stopped, resized, started again; the same machine, now Large.
  const result = await env.service.sizes.resize(resizeTo(task.id, "large"));
  assert.equal(result.sent, false);
  const calls = env.box.state().calls as string[];
  assert.ok(calls.includes(`stop ${task.sandboxId} --json`), calls.join("\n"));
  assert.ok(calls.includes(`resize ${task.sandboxId} --vcpus 8 --mem-mib 16384 --json`));
  assert.ok(calls.includes(`start ${task.sandboxId} --json`));
  assert.equal((await env.box.provider.info(task.sandboxId!)).machineType, "large");
  assert.equal(Object.keys(env.box.state().machines).length, 1);
});

test("a move of an Instabox machine reserves no slot of boat.dev's (nor the other way round)", async (t) => {
  let held: Promise<void> | null = null;
  let release = () => undefined as void;
  const env = await bothProviders(t, {
    state: { autoReply: REPORT },
    settings: { maxActiveSandboxes: 1 },
    // The move's first look at the machine waits until the test lets it go.
    instabox: (provider) => ({ ...provider, findInfo: async (id, signal) => ((held !== null ? await held : undefined), provider.findInfo(id, signal)) }),
  });
  const { task } = await env.service.launchTask({ title: "Fix it", role: "implement", brief: "x", project: env.project }, 10_000);
  await env.service.sweep();
  const boat = env.registry.default;
  assert.deepEqual(pick(await env.service.capacity(undefined, undefined, boat)), { active: 0, free: 1 });
  held = new Promise<void>((resolve) => (release = resolve));
  const moving = env.service.sizes.resize(resizeTo(task.id, "large"));
  for (let tries = 0; !env.service.sizes.isResizing(task.sandboxId!) && tries < 200; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(env.service.sizes.isResizing(task.sandboxId!));
  // boat.dev's room doesn't change for an Instabox move.
  assert.deepEqual(pick(await env.service.capacity(undefined, undefined, boat)), { active: 0, free: 1 });
  held = null;
  release();
  await moving;
});

function pick(room: { active: unknown[]; free: number | null }) {
  return { active: room.active.length, free: room.free };
}

test("only boat.dev's wakes take a slot of the wake pacer: an Instabox resume takes none and holds nothing", async (t) => {
  const acquired: string[][] = [] as string[][];
  const pacer = {
    acquire: async (options: { ids?: string[] }) => {
      acquired.push(options.ids ?? []);
      return { succeeded: async () => undefined, failed: async () => undefined };
    },
  };
  const env = await bothProviders(t, { state: { autoReply: REPORT }, serviceHooks: { wakes: { pacer, forget: async () => undefined } } });
  const { task } = await env.service.launchTask({ title: "Fix it", role: "implement", brief: "x", project: env.project }, 10_000);
  await env.service.sweep();
  await env.box.provider.stop(task.sandboxId!);
  await env.service.bringUp(task.sandboxId!);
  assert.deepEqual(acquired, [], "no slot for an Instabox machine");
  // boat.dev's are paced as before.
  const sandbox = env.fakeBoat.addSandbox("bx_9", "default", "stopped");
  await env.service.bringUp(sandbox.id);
  assert.equal(acquired.length, 1);
  assert.ok((acquired[0] as string[]).some((id: string) => id.includes("bx_9")), JSON.stringify(acquired));
});

test("paid resume wakes an Instabox machine without a slot of boat.dev's pacer", () => {
  const instaboxHost = hostCheck({ phase: "suspended", connected: false, message: null, machineProviderId: INSTABOX_MACHINE_PROVIDER_ID }, "host:h_1");
  assert.deepEqual(instaboxHost, { state: "asleep", ids: ["host:h_1"], unpaced: true });
  const boatHost = hostCheck({ phase: "suspended", connected: false, message: null, machineProviderId: "boat-sandbox" }, "host:h_2");
  assert.deepEqual(boatHost, { state: "asleep", ids: ["host:h_2"] }, "boat.dev's machine is paced as before");
  assert.deepEqual(hostCheck({ phase: "suspended", connected: false, message: null }, "host:h_3"), { state: "asleep", ids: ["host:h_3"] }, "a machine bb doesn't name stays paced");
  // One paced machine in the mix: the wake is paced.
  assert.deepEqual(worstCheck([instaboxHost, boatHost]), { state: "asleep", ids: ["host:h_1", "host:h_2"] });
  assert.deepEqual(worstCheck([instaboxHost]), { state: "asleep", ids: ["host:h_1"], unpaced: true });
});

test("Instabox's own plan sizes apply to its machines; boat.dev's plan doesn't", async (t) => {
  // boat.dev's plan has no Large (and its reading must not decide an Instabox size); Instabox's Pro plan has up to Large.
  const boatPlan = [{ type: "small", available: true, reason: null }, { type: "default", available: true, reason: null }, { type: "large", available: false, reason: "needs a bigger boat plan" }, { type: "xlarge", available: false, reason: "needs a bigger boat plan" }];
  const pro = [{ vcpus: 2, memMiB: 4096 }, { vcpus: 4, memMiB: 8192 }, { vcpus: 8, memMiB: 16384 }];
  const env = await bothProviders(t, { state: { autoReply: REPORT, machineSpecs: pro }, serviceHooks: { sizePlan: async () => boatPlan, sizePlanNow: () => boatPlan } });
  const capacity = await env.box.provider.capacity();
  assert.deepEqual(capacity.machineTypes?.map((entry) => [entry.type, entry.available]), [["small", true], ["default", true], ["large", true], ["xlarge", false]]);
  // A new Large machine is fine on Instabox; boat.dev's plan has no say.
  const { task } = await env.service.launchTask({ title: "Big", role: "implement", brief: "x", project: env.project, machineType: "large" }, 10_000);
  assert.equal(task.status, "running", task.error ?? "");
  await env.service.sweep();
  // XLarge isn't on the Instabox plan: refused in Instabox's words, before anything stops.
  await assert.rejects(env.service.sizes.resize(resizeTo(task.id, "xlarge")), (error: unknown) => {
    assert.ok(error instanceof TaskError);
    assert.equal(error.code, "size_not_on_plan");
    assert.match(error.message, /^Your Instabox plan doesn't include XLarge sandboxes: your Instabox plan doesn't include this size\.$/);
    return true;
  });
  assert.ok(!(env.box.state().calls as string[]).some((call) => call.startsWith("stop ")));
});

const MAC_TEMPLATES = [{ id: "macos", os: "macos", creatable: true, latest: true, models: [
  {name:"m2",label:"M2",defaultSpec:{vcpus:8,memMiB:16384},minimumLease:{hours:24,hourUSD:0.45,minimumUSD:10.8}},
  {name:"m4",label:"M4",defaultSpec:{vcpus:10,memMiB:24576},minimumLease:{hours:24,hourUSD:0.75,minimumUSD:18}},
] }];
async function macEnv(t: { after(fn: () => unknown): void }, overrides: Record<string,unknown> = {}) {
  const store=memoryStore();
  const box=await instabox(t,{ledger:store.macLeases,state:{templates:MAC_TEMPLATES,maxMachines:3}});
  const fakeBoat=new FakeBoat();
  const notices:string[]=[];
  const registry=createProviderRegistry([createBoatProvider(fakeBoat as unknown as BoatApi),box.provider]);
  const service=new BoatService(registry,store,hooks({tell:async (_id:string,text:string)=>{notices.push(text)},...overrides}).hooks);
  const start=(extra:Partial<import("../src/service.ts").StartTaskInput>={})=>service.startTask({title:"Mac task",brief:"Check tools",role:"custom",sandboxSystem:"macos",...extra});
  return {box,store,service,start,notices,fakeBoat};
}
test("Mac capability fails closed; prices and model sizes come from live templates",async t=>{
  const {box}=await macEnv(t);
  assert.deepEqual(box.provider.caps.systems,["linux"]);
  assert.match((await box.provider.pricing!())!,/M2 \$10.80 minimum/);
  assert.deepEqual(box.provider.caps.systems,["linux","macos"]);
  box.setState({tier:"free"});
  assert.deepEqual(await box.provider.macModels!(),[]);
  assert.deepEqual(box.provider.caps.systems,["linux"]);
  await assert.rejects(box.provider.create({name:"mac",type:"default",system:"macos",ttlSeconds:3600,gitGuard:true}),/cannot create/);
  box.setState({tier:"pro",templates:[]});
  assert.deepEqual(await box.provider.macModels!(),[]);
});
test("Mac tasks share held leases as separate workspaces, full capacity creates a new lease, Linux stays Linux",async t=>{
  const {start,box,store,service}=await macEnv(t);
  const first=await start(); const second=await start(); const third=await start();
  assert.equal(first.status,"running",first.error??"");
  assert.equal(second.sandboxId,first.sandboxId,second.error??"");
  assert.notEqual(third.sandboxId,first.sandboxId);
  assert.equal(store.macLeases.held().length,2);
  assert.equal(store.macLeases.tasks(store.macLeases.held(first.sandboxId!)[0]!.id).length,2);
  assert.ok(box.state().calls.some((c:string)=>c.includes("--template macos --model m2 --accept-24h-minimum")));
  const linux=await service.startTask({title:"Linux",brief:"Check",role:"custom"});
  assert.equal(linux.sandboxProvider,undefined);
  assert.notEqual(linux.sandboxId,first.sandboxId);
});
test("held Mac works at the provider machine limit; a full lease still respects Instabox capacity without stopping boat.dev",async t=>{
  const {start,box,fakeBoat}=await macEnv(t);
  box.setState({maxMachines:1});
  const first=await start();const second=await start();
  assert.equal(second.sandboxId,first.sandboxId);
  await assert.rejects(start(),/plan allows|limit|room/i);
  assert.equal(fakeBoat.sandboxes.size,0);
  assert.equal(Object.keys(box.state().machines).length,1);
});
test("Mac review auto never joins its busy parent's workspace",async t=>{
  const {start}=await macEnv(t);
  const parent=await start();
  const review=await start({role:"review",parentTaskId:parent.id,sandbox:"auto"});
  assert.equal(review.status,"running",review.error??"");
  assert.notEqual(review.sandboxId,parent.sandboxId);
});
test("empty Mac schedules hand-back at the minimum, then releases idempotently",async t=>{
  const {start,service,store,box}=await macEnv(t);
  const task=await start();
  store.update(task.id,{status:"done"});
  const lease=store.macLeases.held()[0]!;const until=Date.parse(lease.paidUntil);
  await service.processMacLeases(until-31*60000);
  assert.equal(store.macLeases.held().length,1);
  await service.processMacLeases(until-29*60000);
  await service.processMacLeases(until-28*60000);
  assert.equal(store.macLeases.held().length,1,"the paid Mac stays available");
  assert.equal(box.state().machines[task.sandboxId!].state,"running");
  assert.equal(store.macLeases.held()[0]!.releaseAt,lease.paidUntil);
  assert.ok(!box.state().calls.some((c:string)=>c.includes("--now")));
  box.setState({nowMs:until+1});
  await service.processMacLeases(until+1);
  await service.processMacLeases(until+2);
  assert.equal(store.macLeases.held().length,0);
  assert.equal(store.macLeases.list()[0]!.endReason,"handed back");
  assert.equal(box.state().calls.filter((c:string)=>c.startsWith("rm ")).length,1);
});
test("idle open tasks get recurring paid-time heads-ups across restarts; running work is never deleted",async t=>{
  const {start,service,store,notices,box}=await macEnv(t);
  const task=await start({orchestratorThreadId:"thread_1"});
  const lease=store.macLeases.held()[0]!;const until=Date.parse(lease.paidUntil);
  // Task updates and the simulated sweeps must use the CLI lease's timeline.
  t.mock.timers.enable({apis:["Date"],now:Date.parse(lease.startedAt)});
  await service.processMacLeases(until-29*60000);
  assert.equal(notices.length,0,"active work continues silently");
  store.update(task.id,{status:"idle",unshipped:4});
  await service.processMacLeases(until-28*60000);
  await service.processMacLeases(until-27*60000);
  assert.equal(notices.length,1);
  assert.match(notices[0]!,/^\[boat\] Mac lease's paid time ends at .*after that it bills per second while tasks /);
  const restarted=new BoatService(service.sandboxProviders,store,hooks({tell:async (_id:string,text:string)=>{notices.push(text)}}).hooks);
  await restarted.processMacLeases(until-26*60000);
  assert.equal(notices.length,1);
  await restarted.processMacLeases(until+24*3600000-28*60000);
  assert.equal(notices.length,2);
  assert.match(notices[1]!,/paid time ended.*compute cost/);
  assert.equal(store.macLeases.held()[0]!.paidUntil,lease.paidUntil);
  assert.equal(box.state().calls.filter((c:string)=>c.startsWith("rm ")).length,0);
});
test("hand-back rechecks task attachment after I/O",async t=>{
  const {start,service,store,box}=await macEnv(t);
  const task=await start();store.update(task.id,{status:"done"});
  const lease=store.macLeases.held()[0]!;
  const original=box.provider.findInfo;
  box.provider.findInfo=async (...args)=>{const result=await original(...args);store.update(task.id,{status:"idle",unshipped:2});return result;};
  await service.processMacLeases(Date.parse(lease.paidUntil)-29*60000);
  assert.equal(store.macLeases.held().length,1);
  assert.equal(box.state().calls.filter((c:string)=>c.startsWith("rm ")).length,0);
});

test("CLI and page resume TTL use the sandbox provider's cap, never boat.dev's cap",async t=>{
  const { service,box }=await macEnv(t);
  const {createTestHost}=await import("./fakes.ts");
  const {registerRpc}=await import("../src/rpc.ts");
  const {buildCli}=await import("../src/cli.ts");
  const {bb,harness}=await createTestHost({pluginId:"boat",settings:{boatPath:"/fake/boat"}});
  t.after(()=>harness.lifecycle.dispose());
  const asked:(string|undefined)[]=[]; const resumed:number[]=[];
  const originalCapacity=service.capacity.bind(service);
  service.capacity=async (signal,id,...rest)=>{
    asked.push(id);
    const result=await originalCapacity(signal,id,...rest);
    return {...result,limits:result.limits?{...result.limits,autoStopCapHours:id?.startsWith("m_")?0.5:0.25}:null};
  };
  service.sandboxAction=async (_id,_action,ttl)=>{resumed.push(ttl);};
  const runtime={bb,service,changed:()=>{},settings:{},projects:{}} as unknown as import("../src/runtime.ts").Runtime;
  registerRpc(runtime);bb.cli.register(buildCli(runtime));
  // A real fake-Instabox machine makes the provider resolution observable.
  const sandbox=await box.provider.create({name:"resume-ttl",type:"default",ttlSeconds:3600,gitGuard:false});
  const cli=await harness.runCli(["sandbox","resume",sandbox.id,"--json"]);
  assert.equal(cli.exitCode,0,cli.stderr);
  await harness.callRpc("sandboxAction",{id:sandbox.id,action:"resume"});
  assert.deepEqual(asked,[sandbox.id,sandbox.id]);
  assert.deepEqual(resumed,[1800,1800]);
});

test("Mac snapshots inherit their model and consent without conflicting template flags",async t=>{
  const {box}=await macEnv(t);
  box.setState({snapshots:[{id:"sn_mac",name:"mac-xcode",status:"ready",template:{id:"macos"},defaultSpec:{vcpus:8,memMiB:16384}}]});
  const sandbox=await box.provider.create({name:"snapshot-mac",type:"default",system:"macos",snapshot:"mac-xcode",ttlSeconds:3600,gitGuard:true});
  assert.equal(sandbox.system,"macos");
  const call=box.state().calls.find((c:string)=>c.startsWith("create ")) as string;
  assert.ok(call.includes("--snapshot mac-xcode"));assert.ok(call.includes("--accept-24h-minimum"));
  assert.ok(!call.includes("--template"));assert.ok(!call.includes("--vcpus"));
});

test("Mac task chats reuse a machine with separate checkout paths and workspaces",async t=>{
  const {FakeChat}=await import("./fakes.ts");
  const chat=new FakeChat();
  const repos:import("../src/sandbox-repos.ts").RepoSteps={
    prepareRepo:async (_provider,_id,_repo,_checkout,opts)=>({path:`/work/${opts?.workDir}/web`,branch:"task-branch",baseBranch:"main",canPush:true}),
    githubLogin:async ()=>({valid:true,expiresAt:null}),
    ship:async ()=>({shipped:[]}),
  };
  const {start}=await macEnv(t,{chat,repos,settings:async()=>defaultSettings({maxActiveSandboxes:0,workerMode:"chat",adhocWorkerMode:"chat",evidenceUploader:""})});
  const first=await start({repo:"acme/web",runner:"chat",confirmUntrustedChat:["acme/web"]});
  const second=await start({repo:"acme/web",runner:"chat",confirmUntrustedChat:["acme/web"]});
  assert.equal(first.status,"running",first.error??"");assert.equal(second.status,"running",second.error??"");
  assert.equal(first.sandboxId,second.sandboxId);assert.equal(first.hostId,second.hostId);
  assert.notEqual(first.repoPath,second.repoPath);
  assert.notEqual(chat.spawns[0]!.environmentId,chat.spawns[1]!.environmentId);
  assert.equal(chat.spawns[1]!.where.kind,"machine");
  assert.equal(chat.machines.length,1);
});

test("a stopped Mac still inside its held minimum is resumed before creating another lease",async t=>{
  const {start,service,store,box}=await macEnv(t);
  box.setState({maxMachines:1});
  const first=await start();store.update(first.id,{status:"done"});
  await box.provider.stop(first.sandboxId!);
  const second=await start();
  assert.equal(second.sandboxId,first.sandboxId);
  assert.equal(second.status,"running",second.error??"");
  assert.equal(store.macLeases.list().length,1);
  assert.ok(box.state().calls.includes(`start ${first.sandboxId} --accept-24h-minimum --json`));
  assert.equal(box.state().calls.filter((c:string)=>c.startsWith("create ")).length,1);
  assert.equal((await service.sandboxProvider(second).info(second.sandboxId!)).state,"idle");
});

test("an empty Mac after its minimum is released on the next pass without a day extension",async t=>{
  const {start,service,store,box}=await macEnv(t);
  const task=await start();store.update(task.id,{status:"done"});
  const lease=store.macLeases.held()[0]!, after=Date.parse(lease.paidUntil)+30_000;
  await service.processMacLeases(after);
  assert.equal(store.macLeases.held().length,0);
  assert.equal(store.macLeases.list()[0]!.paidUntil,lease.paidUntil);
  assert.ok(Math.abs(store.macLeases.between(Date.parse(lease.startedAt),after,after).costs.USD!-(lease.minimumCost+lease.hourPrice/120))<1e-8);
  assert.equal(box.state().machines[task.sandboxId!].state,"deleted");
});
test("explicit keep_sandbox protects closed unpushed work across restarts and stays visible in usage",async t=>{
  const {start,service,store,box}=await macEnv(t);
  const task=await start();store.update(task.id,{status:"idle",unshipped:5,delivery:"push"});
  const closed=await service.closeTask(task.id,{keepSandbox:true});assert.equal(closed.sandbox,"kept");
  const lease=store.macLeases.held()[0]!;assert.equal(lease.kept,true);
  const restarted=new BoatService(service.sandboxProviders,store,hooks().hooks);
  await restarted.processMacLeases(Date.parse(lease.paidUntil)+3*86400000);
  assert.equal(box.state().machines[task.sandboxId!].state,"running");
  const {providerHandlers}=await import("../src/rpc-providers.ts");
  const usage=providerHandlers({service,bb:{}} as unknown as import("../src/runtime.ts").Runtime).macUsage();
  assert.equal(usage.held[0]!.kept,true);
  assert.equal(box.state().calls.filter((c:string)=>c.startsWith("rm ")).length,0);
});
test("new work cancels a scheduled minimum-end release before reusing the paid Mac",async t=>{
  const {start,service,store,box}=await macEnv(t);
  const first=await start();store.update(first.id,{status:"done"});
  const lease=store.macLeases.held()[0]!;
  await service.processMacLeases(Date.parse(lease.paidUntil)-29*60000);
  assert.equal(box.state().machines[first.sandboxId!].deleteAt,lease.paidUntil);
  const second=await start();assert.equal(second.sandboxId,first.sandboxId);
  assert.equal(box.state().machines[first.sandboxId!].deleteAt,undefined);
  assert.equal(store.macLeases.held()[0]!.releaseAt,null);
  box.setState({nowMs:Date.parse(lease.paidUntil)+1});
  await service.processMacLeases(Date.parse(lease.paidUntil)+1);
  assert.equal(box.state().machines[first.sandboxId!].state,"running");
});
test("concurrent Mac dispatches share a held lease while the first still prepares its checkout",async t=>{
  let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve}),preparing=new Promise<void>(resolve=>{entered=resolve});
  let calls=0;
  const repos:import("../src/sandbox-repos.ts").RepoSteps={
    prepareRepo:async (_provider,_id,_repo,_checkout,opts)=>{if(++calls===1){entered();await gate;}return {path:`/work/${opts?.workDir}/web`,branch:"task",baseBranch:"main",canPush:true}},
    githubLogin:async()=>({valid:true,expiresAt:null}),ship:async()=>({shipped:[]}),
  };
  const {start,box}=await macEnv(t,{repos});t.after(release);
  const first=start({repo:"acme/web"});await preparing;
  try {const second=await start({repo:"acme/web"});release();const ready=await first;assert.equal(second.sandboxId,ready.sandboxId);assert.equal(box.state().calls.filter((c:string)=>c.startsWith("create ")).length,1);}finally{release();}
});
test("a Linux parent's review stays Linux when its project and requested default switch to Mac",async t=>{
  const project=normalizeProject({id:"web",name:"Web",repos:[{repo:"acme/web",baseBranch:"main"}],sandboxProvider:"instabox",sandboxSystem:"macos"});
  const {start}=await macEnv(t,{projects:()=>[project]});
  const parent=await start({repo:"acme/web",sandboxSystem:"linux"});
  const review=await start({parentTaskId:parent.id,role:"review",sandbox:"auto"});
  assert.equal(review.status,"running",review.error??"");assert.equal(review.sandboxSystem,undefined);
});
test("a stopped Mac whose lease ended rechecks plan and capacity before accepting a new minimum",async t=>{
  const {start,box,store}=await macEnv(t);
  const task=await start(),id=task.sandboxId!;
  const state=box.state();state.machines[id].state="stopped";delete state.machines[id].lease;
  box.setState({machines:state.machines,tier:"free"});
  await assert.rejects(box.provider.resume(id,{ttlSeconds:3600}),/cannot start a new Mac lease/);
  assert.ok(!box.state().calls.some((c:string)=>c.startsWith(`start ${id}`)));
  box.setState({tier:"pro",maxMachines:1});
  const capacity=box.provider.capacity;box.provider.capacity=async signal=>({...await capacity(signal),canStart:false,maxActiveSandboxes:0,blockedReason:"No Mac capacity"});
  await assert.rejects(box.provider.resume(id,{ttlSeconds:3600}),/No Mac capacity/);
  box.provider.capacity=async signal=>({...await capacity(signal),canStart:false,maxActiveSandboxes:3,blockedReason:"Account is blocked"});
  await assert.rejects(box.provider.resume(id,{ttlSeconds:3600}),/Account is blocked/);
  box.provider.capacity=capacity;
  await box.provider.resume(id,{ttlSeconds:3600});
  assert.equal(store.macLeases.held(id).length,1);
  assert.equal(store.macLeases.list().length,2,"new physical lease gets new billing terms");
  assert.ok(store.macLeases.list().some(lease=>lease.endReason === "handed back"));
  assert.ok(box.state().calls.some((c:string)=>c.startsWith(`start ${id}`)));
});
test("a stale Instabox list finishing after hand-back cannot reopen the lease",async t=>{
  const {start,box,store}=await macEnv(t);await start();
  const lease=store.macLeases.held()[0]!;
  const run=box.cli.run.bind(box.cli);let release!:()=>void,read!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve}),readGate=new Promise<void>(resolve=>{read=resolve});
  box.cli.run=async(...args)=>{const result=await run(...args);if(args[0][0]==="ls"){read();await gate;}return result;};
  const pending=box.provider.list({all:true});await readGate;
  store.macLeases.end(lease.id,"handed back");release();await pending;
  assert.equal(store.macLeases.held().length,0);assert.equal(store.macLeases.list()[0]!.endReason,"handed back");
});

test("task collection RPCs batch lease reads and task detail retains unrelated lease sharers",async t=>{
  const {start,service,store}=await macEnv(t);
  const first=await start({orchestratorThreadId:"orch_a"}),second=await start({orchestratorThreadId:"orch_b"});
  const {createTestHost}=await import("./fakes.ts"),{registerRpc}=await import("../src/rpc.ts");
  const {bb,harness}=await createTestHost({pluginId:"boat",settings:{boatPath:"/fake/boat"}});t.after(()=>harness.lifecycle.dispose());
  registerRpc({bb,service,settings:{},projects:{}} as unknown as import("../src/runtime.ts").Runtime);
  let snapshots=0;const snapshot=store.macLeases.snapshot.bind(store.macLeases);
  store.macLeases.snapshot=()=>{snapshots++;return snapshot()};
  await harness.callRpc("tasks",{statuses:null,threadId:null,limit:100});assert.equal(snapshots,1);
  await harness.callRpc("tasksByThread",{keys:["orch_a","orch_b"]});assert.equal(snapshots,2);
  const detail=await harness.callRpc("task",{id:second.id}) as {task:{runsOn:RunsOnDto}};
  assert.equal(detail.task.runsOn.sharedTasks,1);assert.match(detail.task.runsOn.detail!,new RegExp(first.title));
});

async function macPushChat(t: {after(fn:()=>unknown):void}, deleteOnClose=true) {
  const {FakeChat}=await import("./fakes.ts");const chat=new FakeChat();
  const repos:import("../src/sandbox-repos.ts").RepoSteps={
    prepareRepo:async(_provider,_id,_repo,_checkout,opts)=>({path:`/work/${opts?.workDir}/web`,branch:"task",baseBranch:"main",canPush:true}),
    githubLogin:async()=>({valid:true,expiresAt:null}),ship:async()=>({shipped:[]}),
  };
  const env=await macEnv(t,{chat,repos,settings:async()=>defaultSettings({deleteSandboxOnClose:deleteOnClose,maxActiveSandboxes:0,workerMode:"chat",adhocWorkerMode:"chat",evidenceUploader:""})});
  const exec=env.box.provider.exec;
  env.box.provider.exec=async(id,script,opts)=>script.includes("BOAT_AHEAD")?{exitCode:0,stdout:"BOAT_AHEAD 3 dirty\n",stderr:""}:exec(id,script,opts);
  const task=await env.start({repo:"acme/web",runner:"chat",confirmUntrustedChat:["acme/web"],orchestratorThreadId:"orch"});
  env.store.update(task.id,{status:"idle",delivery:"push",unshipped:4});
  return {...env,chat,task,repos};
}
test("archiving a Mac chat preserves its unshipped work and marks the lease kept",async t=>{
  const {chat,task,service,store,box}=await macPushChat(t);
  await chat.archive(task.threadId!);await service.syncChatThread(task.threadId!,{kind:"archived"});
  assert.equal(store.get(task.id)!.status,"cancelled");
  const lease=store.macLeases.held()[0]!;assert.equal(lease.kept,true);
  await service.processMacLeases(Date.parse(lease.paidUntil)+86400000);
  assert.equal(box.state().machines[task.sandboxId!].state,"running");
  assert.equal(box.state().calls.filter((c:string)=>c.startsWith("rm ")).length,0);
});
test("hand-back checks closed tasks in attachment history even without a prior keep flag",async t=>{
  const {chat,task,service,store,box}=await macPushChat(t);
  await chat.archive(task.threadId!);store.update(task.id,{status:"cancelled"});
  const lease=store.macLeases.held()[0]!;assert.equal(lease.kept,false);
  await service.processMacLeases(Date.parse(lease.paidUntil)+1);
  assert.equal(store.macLeases.held()[0]!.kept,true);
  assert.equal(box.state().calls.filter((c:string)=>c.startsWith("rm ")).length,0);
});
test("keep-on-close setting releases a clean Mac instead of permanently exempting it",async t=>{
  const {start,service,store,box}=await macEnv(t,{settings:async()=>defaultSettings({maxActiveSandboxes:0,deleteSandboxOnClose:false})});
  const task=await start();await service.closeTask(task.id);
  const lease=store.macLeases.held()[0]!;assert.equal(lease.kept,false);
  await service.processMacLeases(Date.parse(lease.paidUntil)+1);
  assert.equal(store.macLeases.held().length,0);
  assert.equal(box.state().machines[task.sandboxId!].state,"deleted");
});
test("setting preserves unshipped Mac work with daily cost reminders across restarts",async t=>{
  const {chat,task,service,store,notices,box}=await macPushChat(t,false);
  chat.finish(task.threadId!,"done");await service.closeTask(task.id);
  const lease=store.macLeases.held()[0]!;assert.equal(lease.kept,true);
  const end=Date.parse(lease.paidUntil);
  await service.processMacLeases(end+1);assert.equal(notices.length,1);
  assert.match(notices[0]!,/Mac lease is kept; compute cost \$10\.80/);
  const restarted=new BoatService(service.sandboxProviders,store,hooks({tell:async(_thread:string,text:string)=>{notices.push(text)}}).hooks);
  await restarted.processMacLeases(end+23*3600000);assert.equal(notices.length,1);
  await restarted.processMacLeases(end+86400000+1);assert.equal(notices.length,2);
  await restarted.processMacLeases(end+7*86400000);assert.equal(notices.length,3);
  assert.match(notices[2]!,/compute cost \$86\.40/);
  await restarted.processMacLeases(end+7*86400000+60000);assert.equal(notices.length,3);
  assert.equal(box.state().calls.filter((c:string)=>c.startsWith("rm ")).length,0);
});
test("stopped Mac leases end at stoppedAt rather than the later list time",async t=>{
  const {start,store,box}=await macEnv(t);const task=await start();
  const lease=store.macLeases.held()[0]!,stoppedAt=new Date(Date.parse(lease.paidUntil)+3600000).toISOString();
  const state=box.state();state.machines[task.sandboxId!].state="stopped";state.machines[task.sandboxId!].updatedAt=stoppedAt;delete state.machines[task.sandboxId!].lease;
  box.setState({machines:state.machines});await box.provider.list({all:true});
  assert.equal(store.macLeases.list()[0]!.endedAt,stoppedAt);
  assert.ok(Math.abs(store.macLeases.between(0,Infinity,Date.parse(stoppedAt)+86400000).costs.USD!-(lease.minimumCost+lease.hourPrice))<1e-8);
});

test("a Mac create readiness timeout is an unknown allocation outcome, never a safe fallback",async t=>{
  const {box}=await macEnv(t);const json=box.cli.json.bind(box.cli);
  box.cli.json=async(args,options)=>{
    if(args[0]==="create")throw new InstaboxError("ready timeout after allocation",{code:"instabox_timeout"});
    return json(args,options);
  };
  await assert.rejects(box.provider.create({name:"mac",type:"default",system:"macos",ttlSeconds:3600,gitGuard:true}),{code:"creation_unknown"});
});

function pauseMac(box: Awaited<ReturnType<typeof instabox>>, id: string) {
  const state=box.state();state.machines[id].state="suspended";box.setState({machines:state.machines});
}
test("ship then close then pause resolves the Mac attachment instead of keeping it forever",async t=>{
  const {chat,task,service,store,box,repos}=await macPushChat(t);
  chat.finish(task.threadId!,"done");store.update(task.id,{finishedAt:new Date(Date.now()-1000).toISOString()});
  repos.ship=async()=>({shipped:[{path:task.repoPath!,baseBranch:"main",sha:"abcdef123456",commits:1}]});
  const shipped=await service.shipTask(task.id,{approval:"approved in test"});assert.equal(shipped.task.status,"done");
  const event=store.latestEvent(task.id,"shipped")!;
  store.update(task.id,{finishedAt:new Date(Date.parse(event.at)+1000).toISOString()});
  const lease=store.macLeases.held()[0]!;assert.equal(store.macLeases.tasks(lease.id)[0]!.workOutcome,"shipped");
  pauseMac(box,task.sandboxId!);await service.processMacLeases(Date.parse(lease.paidUntil)+1);
  assert.equal(store.macLeases.list()[0]!.kept,false);assert.equal(store.macLeases.held().length,0);
});
test("clean push close then pause uses the recorded clean result for hand-back",async t=>{
  const {chat,task,service,store,box}=await macPushChat(t);chat.finish(task.threadId!,"done");
  const exec=box.provider.exec;let probes=0;
  box.provider.exec=async(id,script,options)=>script.includes("BOAT_AHEAD")?(probes++,{exitCode:0,stdout:"BOAT_AHEAD 0 clean\n",stderr:""}):exec(id,script,options);
  await service.closeTask(task.id);const lease=store.macLeases.held()[0]!;
  assert.equal(store.macLeases.tasks(lease.id)[0]!.workOutcome,"clean");const before=probes;
  pauseMac(box,task.sandboxId!);await service.processMacLeases(Date.parse(lease.paidUntil)+1);
  assert.equal(probes,before);assert.equal(store.macLeases.list()[0]!.kept,false);assert.equal(store.macLeases.held().length,0);
});
test("discarded push work is resolved with deletion on close disabled and a paused Mac",async t=>{
  const {chat,task,service,store,box,notices}=await macPushChat(t,false);chat.finish(task.threadId!,"done");
  await service.closeTask(task.id,{discard:true});const lease=store.macLeases.held()[0]!;
  assert.equal(lease.kept,false);assert.equal(store.macLeases.tasks(lease.id)[0]!.workOutcome,"discarded");
  pauseMac(box,task.sandboxId!);await service.processMacLeases(Date.parse(lease.paidUntil)+1);
  assert.equal(store.macLeases.held().length,0);assert.deepEqual(notices,[]);
});
test("paused confirmed unshipped work is still protected",async t=>{
  const {chat,task,service,store,box}=await macPushChat(t,false);chat.finish(task.threadId!,"done");
  await service.closeTask(task.id);const lease=store.macLeases.held()[0]!;
  assert.equal(store.macLeases.tasks(lease.id)[0]!.workOutcome,"unshipped");
  pauseMac(box,task.sandboxId!);await service.processMacLeases(Date.parse(lease.paidUntil)+1);
  assert.equal(store.macLeases.held().length,1);assert.equal(store.macLeases.held()[0]!.kept,true);
  assert.equal(box.state().calls.filter((c:string)=>c.startsWith("rm ")).length,0);
});
test("closing a paused push task records uncertainty without turning the keep setting into a permanent keep",async t=>{
  const {chat,task,service,store,box,notices}=await macPushChat(t,false);chat.finish(task.threadId!,"done");pauseMac(box,task.sandboxId!);
  await service.closeTask(task.id);const lease=store.macLeases.held()[0]!;
  assert.equal(lease.kept,false);assert.equal(store.macLeases.tasks(lease.id)[0]!.workOutcome,"unknown");
  await service.processMacLeases(Date.parse(lease.paidUntil)+1);
  assert.equal(store.macLeases.held()[0]!.kept,false);assert.match(notices[0]!,/could not be checked/);assert.doesNotMatch(notices[0]!,/delete it manually/);
  assert.equal(box.state().calls.filter((c:string)=>c.startsWith("rm ")).length,0);
});
test("an inconclusive paused probe defers one pass without a sticky keep and retries on resume",async t=>{
  const {chat,task,service,store,box}=await macPushChat(t);await chat.archive(task.threadId!);store.update(task.id,{status:"cancelled"});
  const lease=store.macLeases.held()[0]!;pauseMac(box,task.sandboxId!);
  await service.processMacLeases(Date.parse(lease.paidUntil)+1);
  assert.equal(store.macLeases.held()[0]!.kept,false);assert.equal(store.macLeases.tasks(lease.id)[0]!.workOutcome,"unknown");
  const state=box.state();state.machines[task.sandboxId!].state="running";box.setState({machines:state.machines});
  await service.processMacLeases(Date.parse(lease.paidUntil)+2);
  assert.equal(store.macLeases.held()[0]!.kept,true);assert.equal(store.macLeases.tasks(lease.id)[0]!.workOutcome,"unshipped");
});
test("unknown paused work cancels a pending release without permanently keeping the lease",async t=>{
  const {chat,task,service,store,box}=await macPushChat(t);await chat.archive(task.threadId!);store.update(task.id,{status:"cancelled"});
  const lease=store.macLeases.held()[0]!;
  await box.provider.scheduleLeaseRelease!(lease.machineId,lease.paidUntil);store.macLeases.schedule(lease.id,lease.paidUntil);
  pauseMac(box,task.sandboxId!);await service.processMacLeases(Date.parse(lease.paidUntil)-15*60000);
  assert.equal(store.macLeases.held()[0]!.releaseAt,null);assert.equal(store.macLeases.held()[0]!.kept,false);
  const state=box.state();state.machines[task.sandboxId!].state="running";box.setState({machines:state.machines});
  const exec=box.provider.exec;box.provider.exec=async(id,script,options)=>script.includes("BOAT_AHEAD")?{exitCode:0,stdout:"BOAT_AHEAD 0 clean\n",stderr:""}:exec(id,script,options);
  await service.processMacLeases(Date.parse(lease.paidUntil)+1);assert.equal(store.macLeases.held().length,0);
});
test("a resolved close outcome does not cover work from a later turn",async t=>{
  const {chat,task,service,store,box}=await macPushChat(t);chat.finish(task.threadId!,"done");
  const exec=box.provider.exec;box.provider.exec=async(id,script,options)=>script.includes("BOAT_AHEAD")?{exitCode:0,stdout:"BOAT_AHEAD 0 clean\n",stderr:""}:exec(id,script,options);
  await service.closeTask(task.id);box.provider.exec=exec;
  store.update(task.id,{turns:task.turns+1,status:"cancelled"});const lease=store.macLeases.held()[0]!;
  await service.processMacLeases(Date.parse(lease.paidUntil)+1);
  assert.equal(store.macLeases.held()[0]!.kept,true);assert.equal(store.macLeases.tasks(lease.id)[0]!.workTurns,task.turns+1);
});
test("hand-back does not exec git before the minimum-end margin",async t=>{
  const {chat,task,service,store,box}=await macPushChat(t);await chat.archive(task.threadId!);store.update(task.id,{status:"cancelled"});
  let probes=0;const exec=box.provider.exec;box.provider.exec=async(...args)=>{if(args[1].includes("BOAT_AHEAD"))probes++;return exec(...args)};
  const lease=store.macLeases.held()[0]!;await service.processMacLeases(Date.parse(lease.paidUntil)-31*60000);
  assert.equal(probes,0);assert.equal(store.macLeases.held()[0]!.kept,false);
});
test("page-started kept leases persist recurring cost notices without an orchestrator thread",async t=>{
  const {start,service,store}=await macEnv(t);const task=await start({orchestratorThreadId:null});
  await service.closeTask(task.id,{keepSandbox:true});const lease=store.macLeases.held()[0]!,end=Date.parse(lease.paidUntil);
  await service.processMacLeases(end+1);
  const {providerHandlers}=await import("../src/rpc-providers.ts");
  const view=()=>providerHandlers({service,bb:{}} as unknown as import("../src/runtime.ts").Runtime).macUsage();
  assert.match(view().notices[0]!.text,/Mac lease is kept; compute cost \$10\.80/);
  const restarted=new BoatService(service.sandboxProviders,store,hooks().hooks);
  await restarted.processMacLeases(end+86400000+1);
  assert.match(view().notices[0]!.text,/compute cost \$21\.60/);assert.equal(view().notices.length,1);
});

test("an unactivated Instabox Mac account fails preflight before model lookup or create",async t=>{
  let setup!:ReturnType<typeof createInstaboxSetup>;
  const f=await macEnv(t,{preflight:async(input:import("../src/providers/boat/setup.ts").PreflightInput)=>{
    if(input.provider==="instabox")await instaboxPreflight(setup);
  }});
  setup=createInstaboxSetup({cli:f.box.cli,turnedOn:async()=>true,keyPresent:()=>true});
  f.box.setState({fail:"invite"});
  f.box.provider.macModels=async()=>{assert.fail("account preflight must run first");};
  await assert.rejects(f.start(),error=>{
    assert.match(String(error),/Instabox isn't ready: Instabox account.*isn't activated/);
    assert.doesNotMatch(String(error),/may have allocated/);return true;
  });
  assert.equal(Object.keys(f.box.state().machines).length,0);
  assert.ok(!f.box.state().calls.some((call:string)=>call.startsWith("create ")));
});

test("Instabox reports a confirmed allocation when local ledger registration fails",async t=>{
  const f=await macEnv(t);
  f.store.macLeases.record=()=>{throw new Error("local ledger unavailable");};
  assert.equal(f.box.provider.classifiesCreateErrors,true);
  await assert.rejects(f.box.provider.create({name:"mac",type:"default",system:"macos",ttlSeconds:3600,gitGuard:true}),{code:"creation_allocated"});
  assert.equal(Object.keys(f.box.state().machines).length,1);
});

test("create, snapshot and fork use the configured proxy Secret selection", async t => {
  let choice = " GH_TOKEN ";
  const box = await instabox(t, { secrets: async () => choice });
  const first = await box.provider.create({ name: "selected", type: "small", snapshot: "fake-snapshot", ttlSeconds: 3600, gitGuard: false });
  assert.equal(box.state().machines[first.id].secretSelection, "GH_TOKEN");
  assert.ok(box.state().calls.some((call: string) => call.includes("--snapshot fake-snapshot --secrets GH_TOKEN")));
  choice = "none";
  const fork = await box.provider.fork(first.id);
  assert.equal(box.state().machines[fork.id].secretSelection, "none");
  assert.ok(!box.state().machines[fork.id].envNames.includes("GH_TOKEN"));
  assert.ok(box.state().calls.includes(`secrets push ${fork.id} --json`));
  choice = "bad selection";
  await assert.rejects(box.provider.create({ name: "invalid", type: "small", ttlSeconds: 3600, gitGuard: false }), /comma-separated Secret names/);
  assert.equal(Object.keys(box.state().machines).length, 2);
});

test("GitHub preflight refuses missing, mis-scoped, direct or unselected Secrets before creating a machine", async t => {
  for (const scenario of [
    { secrets: [{ name: "GH_TOKEN", delivery: "proxy", hosts: ["*"] }], choice: "all", message: /exact hosts; wildcard/ },
    { secrets: [{ name: "GH_TOKEN", delivery: "proxy", hosts: ["github.com", "api.github.com", "*"] }], choice: "all", message: /exact hosts; wildcard/ },
    { secrets: [], choice: "all", message: /has no GitHub login/ },
    { secrets: [{ name: "GH_TOKEN", delivery: "proxy", hosts: ["api.github.com"] }], choice: "all", message: /both github.com and api.github.com/ },
    { secrets: [{ name: "GH_TOKEN", delivery: "env", hosts: [] }], choice: "all", message: /proxy Secret/ },
    { choice: "none", message: /Include GH_TOKEN/ },
    { choice: "MODEL_KEY", message: /Include GH_TOKEN/ },
  ]) {
    const box = await instabox(t, { secrets: async () => scenario.choice, state: scenario.secrets ? { secrets: scenario.secrets } : {} });
    const registry = createProviderRegistry([createBoatProvider(new FakeBoat() as unknown as BoatApi), box.provider]);
    const service = new BoatService(registry, memoryStore(), hooks({ projects: () => [WEB] }).hooks);
    const project = toOrchestratorProject(normalizeProject(WEB));
    await assert.rejects(service.launchTask({ title: "Check", role: "implement", brief: "Check repo", project }, 5000), scenario.message);
    assert.equal(Object.keys(box.state().machines ?? {}).length, 0);
    assert.ok(!(box.state().calls ?? []).some((call: string) => call.startsWith("create ")));
  }
});

test("GitHub metadata is cached for a minute; selection changes apply immediately", async t => {
  let now = 1000, choice = "all";
  const box = await instabox(t, { now: () => now, secrets: async () => choice });
  const check = () => box.provider.assertTaskReady!({ agent: "codex", repos: ["acme/web"] });
  await check();
  box.setState({ secrets: [] });
  await check();
  assert.equal(box.state().calls.filter((call: string) => call === "secrets ls --json").length, 1);
  choice = "MODEL_KEY";
  await assert.rejects(check(), /Include GH_TOKEN/);
  choice = "GH_TOKEN";
  now += 60_001;
  await assert.rejects(check(), /has no GitHub login/);
  assert.equal(box.state().calls.filter((call: string) => call === "secrets ls --json").length, 2);
});

test("only transient Secret read errors fail open, with a note in task history", async t => {
  const box = await instabox(t, { state: { secretsFail: "transient" } });
  const registry = createProviderRegistry([createBoatProvider(new FakeBoat() as unknown as BoatApi), box.provider]);
  const store = memoryStore();
  const { hooks: serviceHooks, warnings } = hooks({ projects: () => [WEB] });
  const service = new BoatService(registry, store, serviceHooks);
  const project = toOrchestratorProject(normalizeProject(WEB));
  const { task } = await service.launchTask({ title: "Check", role: "implement", brief: "Check repo", project }, 10000);
  assert.equal(task.status, "running", task.error ?? "");
  assert.match(store.latestEvent(task.id, "preflight-warning")?.text ?? "", /could not be checked temporarily/);
  box.setState({ secretsFail: "permission" });
  await assert.rejects(service.launchTask({ title: "Check again", role: "implement", brief: "Check repo", project }, 5000), /machines:read permission/);
  assert.equal(Object.keys(box.state().machines).length, 1);
  const outputs = JSON.stringify([warnings, store.events(task.id, 100)]);
  assert.ok(!outputs.includes(KEY));
  assert.ok(!outputs.includes("ibsec_"));
});

test("an older resumed machine gets Secrets selected and pushed before repo prep", async t => {
  const box = await instabox(t, { secrets: async () => "GH_TOKEN" });
  const old = await box.cli.json(["create", "--name", "old", "--json"]);
  assert.ok(!box.state().machines[old.id as string].envNames.includes("GH_TOKEN"));
  await box.provider.stop(old.id as string);
  await box.provider.resume(old.id as string, { ttlSeconds: 3600 });
  const prepared = await prepareRepo(box.provider, old.id as string, "acme/web", { kind: "default-branch", base: "main" });
  assert.equal(prepared.canPush, true);
  const calls: string[] = box.state().calls;
  const select = calls.indexOf(`secrets select ${old.id} --secrets GH_TOKEN --json`);
  const push = calls.indexOf(`secrets push ${old.id} --json`);
  const lastExec = calls.map((call, index) => call.startsWith("exec ") ? index : -1).filter(index => index !== -1);
  assert.ok(select > lastExec[0]! && push > select && lastExec.at(-1)! > push);
  await prepareRepo(box.provider, old.id as string, "acme/web", { kind: "default-branch", base: "main" });
  assert.equal(box.state().calls.filter((call: string) => call.startsWith("secrets select ")).length, 1);
});

test("Instabox placeholders are removed from exec results and checkout errors", async t => {
  const box = await instabox(t);
  const machine = await box.provider.create({ name: "redact", type: "small", ttlSeconds: 3600, gitGuard: false });
  box.setState({ execOutput: "BOAT_GH_SECRET_present\nBOAT_ACCESS denied\nBOAT_ACCESS_DETAIL refused ibsec_obviously_fake_placeholder\n" });
  const result = await box.provider.exec(machine.id, "echo fake");
  assert.ok(!JSON.stringify(result).includes("ibsec_"));
  await assert.rejects(prepareRepo(box.provider, machine.id, "acme/web", { kind: "default-branch" }), error => {
    assert.match(String(error), /GitHub refused/);
    assert.doesNotMatch(String(error), /ibsec_/);
    return true;
  });
  const failure = new InstaboxError(redactKeys("refused ibsec_obviously_fake_placeholder"));
  assert.doesNotMatch(failure.explain().message, /ibsec_/);
});

test("only Instabox omits dashboard URLs; boat and Scaleway keep their existing links", () => {
  assert.equal(sandboxDashboardUrl("bx_1"), "https://boat.dev/dashboard?sandbox=bx_1");
  assert.equal(sandboxDashboardUrl("m_fake", "instabox"), null);
  assert.equal(sandboxDashboardUrl("fake-mac", "scaleway"), "https://boat.dev/dashboard?sandbox=fake-mac");
});

test("gh auth setup-git gives git the proxy placeholder for HTTPS clone and push", t => {
  if (spawnSync("gh", ["--version"]).status !== 0) return t.skip("gh CLI is not installed");
  const dir = mkdtempSync(join(tmpdir(), "instabox-git-auth-"));
  const placeholder = "ibsec_obviously_fake_placeholder";
  const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir, GH_CONFIG_DIR: join(dir, "gh"), GH_TOKEN: placeholder, GIT_CONFIG_GLOBAL: join(dir, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0", GIT_TERMINAL_PROMPT: "0" };
  execFileSync("gh", ["auth", "setup-git", "--hostname", "github.com"], { env, stdio: "pipe" });
  // credential fill is the same helper handshake git uses for both HTTPS
  // operations. No requests to GitHub and no credentials printed by the test.
  const credentials = execFileSync("git", ["credential", "fill"], { env, input: "protocol=https\nhost=github.com\n\n", encoding: "utf8" });
  assert.ok(credentials.includes(`password=${placeholder}\n`));
  assert.ok(!readFileSync(join(dir, "gitconfig"), "utf8").includes(placeholder), "the helper config must not store the credential");
});

test("network and unavailable Secrets reads continue with a task-history note", async t => {
  for (const secretsFail of ["network", "unavailable"]) {
    const box = await instabox(t, { state: { secretsFail } });
    const registry = createProviderRegistry([createBoatProvider(new FakeBoat() as unknown as BoatApi), box.provider]);
    const store = memoryStore();
    const service = new BoatService(registry, store, hooks({ projects: () => [WEB] }).hooks);
    const project = toOrchestratorProject(normalizeProject(WEB));
    const { task } = await service.launchTask({ title: "Check", role: "implement", brief: "Check repo", project }, 10000);
    assert.equal(task.status, "running", task.error ?? "");
    const note = store.latestEvent(task.id, "preflight-warning")?.text ?? "";
    assert.match(note, /could not be checked temporarily/);
    assert.doesNotMatch(note, /permission|ibsec_/);
  }
});

test("Instabox retries a pending proxy 401 once, and permanent failures remain blocked", t => {
  const dir = mkdtempSync(join(tmpdir(), "instabox-proxy-race-"));
  const counter = join(dir, "attempts");
  const gh = join(dir, "gh");
  const sleep = join(dir, "sleep");
  writeFileSync(sleep, "#!/bin/sh\nexit 0\n");
  chmodSync(sleep, 0o755);
  const run = (recover: boolean, retry = true) => {
    writeFileSync(counter, "0");
    writeFileSync(gh, `#!/bin/sh
case "$*" in *"-i user"*) exit 0 ;; esac
count=$(cat '${counter}')
count=$((count + 1))
printf %s "$count" > '${counter}'
if [ "$count" -eq 1 ] || [ '${recover}' = false ]; then
  echo 'HTTP 401: Bad credentials' >&2
  exit 1
fi
echo 'true true'
`);
    chmodSync(gh, 0o755);
    return execFileSync("bash", ["-c", `REPO=acme/web\n${githubAccessSnippet(retry)}`], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  };
  assert.match(run(true), /BOAT_ACCESS ok push=true/);
  assert.equal(readFileSync(counter, "utf8"), "2");
  assert.match(run(false), /BOAT_ACCESS expired/);
  assert.equal(readFileSync(counter, "utf8"), "2");
  assert.match(run(true, false), /BOAT_ACCESS expired/);
  assert.equal(readFileSync(counter, "utf8"), "1", "other providers retain one attempt");
});

test("setup presentation uses live allowance and period, and Check again invalidates GitHub metadata",async t=>{
 const f=await instabox(t,{state:{cost:{costUSD:6.4,allowanceUSD:20,creditRemainingUSD:13.6,periodStart:"2026-11-01T00:00:00Z",periodEnd:"2026-12-01T00:00:00Z"}}});
 const first=await f.provider.presentation!();
 assert.deepEqual(first.steps.map(s=>s.done),[true,true,true,true,true]);
 assert.deepEqual([first.linuxUsage?.used,first.linuxUsage?.credit,first.linuxUsage?.remaining,first.linuxUsage?.resetsAt],[6.4,20,13.6,"2026-12-01T00:00:00Z"]);
 f.setState({secrets:[]});
 assert.equal((await f.provider.presentation!()).steps[3]!.done,true,"ordinary read uses the minute cache");
 assert.equal((await f.provider.presentation!({force:true})).steps[3]!.done,false,"Check again reads metadata now");
 assert.doesNotMatch(JSON.stringify(first),new RegExp(KEY));
 assert.equal(f.state().calls.some((c:string)=>c.startsWith("create ")),false);
});
test("setup detects a rejected key and unavailable metadata without showing key values",async t=>{
 const f=await instabox(t,{key:"ibk_fake-rejected-key-0001"});
 const reading=await f.provider.presentation!();
 assert.equal(reading.steps[1]!.done,false);assert.match(reading.steps[1]!.detail,/rejected the key/);
 assert.equal(reading.steps[2]!.done,false);assert.equal(reading.steps[3]!.done,false);
 assert.doesNotMatch(JSON.stringify(reading),/ibk_fake-rejected-key-0001/);
});
test("off-provider setup checks stored key and CLI without enabling or renting",async t=>{
 const f=await instabox(t);
 const provider=createInstaboxProvider(f.cli,f.rest,{enabled:()=>false,keyPresent:()=>false});
 const reading=await provider.presentation!();
 assert.deepEqual(reading.steps.map(s=>s.done),[true,false,false,false,false]);
 assert.equal(f.state().calls?.length ?? 0,0);
});
test("a blocked GitHub start records a real cause for its card and never rents",async t=>{
 const f=await instabox(t,{state:{secrets:[]}}),store=memoryStore();
 const service=new BoatService(createProviderRegistry([createBoatProvider(new FakeBoat() as unknown as BoatApi),f.provider]),store,hooks({projects:()=>[WEB]}).hooks);
 await assert.rejects(service.startTask({title:"Blocked fixture task",role:"custom",brief:"Read the repo",repo:"acme/web",project:toOrchestratorProject(normalizeProject(WEB))}),/GitHub/);
 const task=store.list({limit:1})[0]!;assert.equal(task.status,"failed");assert.equal(task.sandboxId,null);
 const event=store.history({taskId:task.id}).events.find(e=>e.kind==="stopped")!;
 assert.equal(event.cause,"setup_required");assert.equal(service.publicStatus(task).needsYou,true);
 assert.equal(f.state().calls.some((c:string)=>c.startsWith("create ")),false);
});

test("retrying a blocked provider start preserves its project and refuses concurrent or ambiguous rentals",async t=>{
 const f=await instabox(t,{state:{secrets:[]}}),store=memoryStore();
 const service=new BoatService(createProviderRegistry([createBoatProvider(new FakeBoat() as unknown as BoatApi),f.provider]),store,hooks({projects:()=>[WEB]}).hooks);
 const project=toOrchestratorProject(normalizeProject(WEB));
 await assert.rejects(service.startTask({title:"Blocked retry fixture",role:"custom",brief:"Read repo",repo:"acme/web",project}),/GitHub/);
 const original=store.list({limit:1})[0]!;
 const {createTestHost}=await import("./fakes.ts"),{registerRpc}=await import("../src/rpc.ts");
 const {bb,harness}=await createTestHost({pluginId:"boat",settings:{boatPath:"/fake/boat"}});t.after(()=>harness.lifecycle.dispose());
 let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
 const runtime={bb,service,settings:{},projects:{},changed:()=>{},wake:()=>{},launchWaitMs:10000,resolveProject:async(ref:{id:string})=>{assert.equal(ref.id,original.boatProject);return project;},launchTask:async(input:import("../src/service.ts").StartTaskInput)=>{entered();await gate;return {kind:"started",...await service.launchTask(input,10000)};}};
 registerRpc(runtime as unknown as import("../src/runtime.ts").Runtime);
 f.setState({secrets:[{name:"GH_TOKEN",delivery:"proxy",hosts:["github.com","api.github.com"]}]});await f.provider.presentation!({force:true});
 const first=harness.callRpc("retryProviderStart",{id:original.id});await started;
 await assert.rejects(harness.callRpc("retryProviderStart",{id:original.id}),/Check the provider machine list/);
 release();const result=await first as {task:{id:string;runsOn:RunsOnDto}};
 assert.equal(result.task.runsOn.provider,"instabox");assert.equal(store.get(original.id)!.status,"cancelled");
 await assert.rejects(harness.callRpc("retryProviderStart",{id:original.id}),/Check the provider machine list/);
 const replacement=store.get(result.task.id)!;assert.equal(replacement.boatProject,original.boatProject);
 store.update(replacement.id,{status:"failed"});store.addEvent(replacement.id,"failed","Unknown allocation",{cause:"creation_unknown"});
 const before=f.state().calls.filter((c:string)=>c.startsWith("create ")).length;
 await assert.rejects(harness.callRpc("retryProviderStart",{id:replacement.id}),/Check the provider machine list/);
 assert.equal(f.state().calls.filter((c:string)=>c.startsWith("create ")).length,before);
});

test("a failed provider dispatch returns the real task's live blocked card to the orchestrator",async t=>{
 const f=await instabox(t,{state:{secrets:[]}}),store=memoryStore();
 const service=new BoatService(createProviderRegistry([createBoatProvider(new FakeBoat() as unknown as BoatApi),f.provider]),store,hooks({projects:()=>[WEB]}).hooks);
 const {createTestHost}=await import("./fakes.ts"),{registerTools}=await import("../src/tools.ts");
 const {bb,harness}=await createTestHost({pluginId:"boat",settings:{boatPath:"/fake/boat"}});t.after(()=>harness.lifecycle.dispose());
 const project=toOrchestratorProject(normalizeProject(WEB));
 registerTools({bb,service,projectForThread:async()=>project,launchWaitMs:10000,launchTask:async(input:import("../src/service.ts").StartTaskInput)=>({kind:"started",...await service.launchTask(input,10000)})} as unknown as import("../src/runtime.ts").Runtime);
 const result=await harness.callAgentTool("boat_dispatch",{title:"Blocked tool fixture",brief:"Read repo",role:"custom",tier:"light",reason:"Fixture provider check"});
 const id=store.list({limit:1})[0]!.id;
 assert.equal(typeof result,"object");assert.ok(JSON.stringify(result).includes("boat-problem"));assert.ok(JSON.stringify(result).includes(id));
 assert.equal(store.get(id)!.sandboxId,null);
});

test("repeated failed retries supersede the old block and preserve size and confirmed repositories",async t=>{
 const f=await instabox(t,{state:{secrets:[]}}),store=memoryStore();
 const service=new BoatService(createProviderRegistry([createBoatProvider(new FakeBoat() as unknown as BoatApi),f.provider]),store,hooks({projects:()=>[WEB]}).hooks);
 const project=toOrchestratorProject(normalizeProject(WEB));
 await assert.rejects(service.startTask({title:"Repeated blocked fixture",role:"custom",brief:"Read repo",repo:"acme/web",project,machineType:"small",confirmUntrustedChat:["acme/web"]}),/GitHub/);
 let blocked=store.list({limit:1})[0]!;
 assert.deepEqual(store.get(blocked.id)!.startOptions,{machineType:"small",confirmUntrustedChat:["acme/web"]});
 const {createTestHost}=await import("./fakes.ts"),{registerRpc}=await import("../src/rpc.ts"),{rpcErrorInfo}=await import("../contract.ts");
 const {bb,harness}=await createTestHost({pluginId:"boat",settings:{boatPath:"/fake/boat"}});t.after(()=>harness.lifecycle.dispose());
 const runtime={bb,service,settings:{},projects:{list:()=>[]},changed:()=>{},wake:()=>{},launchWaitMs:10000,resolveProject:async()=>project,launchTask:async(input:import("../src/service.ts").StartTaskInput)=>{
   assert.equal(input.machineType,"small");assert.deepEqual(input.confirmUntrustedChat,["acme/web"]);
   return {kind:"started",...await service.launchTask(input,10000)};
 }} as unknown as import("../src/runtime.ts").Runtime;
 registerRpc(runtime);
 const {providerHandlers}=await import("../src/rpc-providers.ts");const providers=providerHandlers(runtime);
 for(let i=0;i<3;i++){
   let nextId:string|undefined;
   await assert.rejects(harness.callRpc("retryProviderStart",{id:blocked.id}),error=>{nextId=rpcErrorInfo(error).taskId;assert.match(rpcErrorInfo(error).message,/GitHub/);return true;});
   assert.ok(nextId);assert.notEqual(nextId,blocked.id);assert.equal(store.get(blocked.id)!.status,"cancelled");
   const failures=store.list({statuses:["failed"],limit:50});assert.equal(failures.length,1);assert.equal(failures[0]!.id,nextId);
   assert.equal((await providers.sandboxProviders()).providers.find(p=>p.id==="instabox")!.waitingTasks,1);
   await assert.rejects(harness.callRpc("retryProviderStart",{id:blocked.id}),/Check the provider machine list/);
   blocked=failures[0]!;
 }
});

test("Linux hours include classified deleted usage, or explicitly fall back to running machines",async()=>{
 let machines:unknown[]=[{id:"old-linux",os:"linux",runningSeconds:7200},{id:"current",runningSeconds:3600},{id:"old-mac",os:"macos",runningSeconds:86400}];
 const rest=new InstaboxRest({key:async()=>KEY,fetch:async()=>new Response(JSON.stringify({machines,total:machines.length}))});
 assert.deepEqual(await rest.linuxHours(new Set(["current"]),new Set()),{hours:3,scope:"period"});
 machines=[{id:"old-unknown",runningSeconds:7200},{id:"current",runningSeconds:3600}];
 assert.deepEqual(await rest.linuxHours(new Set(["current"]),new Set()),{hours:1,scope:"running-machines"});
});
