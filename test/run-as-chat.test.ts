// Run as a chat: an explicit runner on a new task, and who may ask for a chat.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConnectStatus } from "../src/connect.ts";
import { TaskError, chatTrust, confirmCovers, type StartTaskInput } from "../src/service.ts";
import type { Runner } from "../src/store.ts";
import { toOrchestratorProject, normalizeProject } from "../src/projects.ts";
import { makeService } from "./fakes.ts";

const READY: ConnectStatus = { state: "ready", fix: null };
const OFF: ConnectStatus = { state: "off", fix: "Sign this bb in to getbb.app with `bb account login`, then run `bb connect on`." };
const UNKNOWN: ConnectStatus = { state: "unknown", fix: null };

/** acme/web is in a project that runs tasks as chats, acme/careful in one that runs them headless. */
const projects = (repo: string): Runner | null => (repo === "acme/web" ? "chat" : repo === "acme/careful" ? "boat" : null);

type Workers = "boat" | "projects" | "all";
const WORKERS: Record<Workers, { workerMode: Runner; adhocWorkerMode: Runner }> = {
  boat: { workerMode: "boat", adhocWorkerMode: "boat" },
  projects: { workerMode: "chat", adhocWorkerMode: "boat" },
  all: { workerMode: "chat", adhocWorkerMode: "chat" },
};

function env(options: { workers?: Workers; connect?: ConnectStatus; chat?: boolean } = {}) {
  const made = makeService({
    chat: options.chat ?? true,
    settings: WORKERS[options.workers ?? "projects"],
    connect: options.connect ?? READY,
    repoWorkerMode: projects,
  });
  made.boat.limitsValue.maxActiveSandboxes = 20;
  return made;
}

function start(made: ReturnType<typeof env>, overrides: Partial<StartTaskInput> = {}) {
  return made.service.launchTask(
    { title: "Fix the header", role: "implement", brief: "Fix it.", repo: "acme/web", orchestratorThreadId: null, ...overrides },
    5_000,
  );
}

async function refused(promise: Promise<unknown>, code: string, pattern?: RegExp): Promise<TaskError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof TaskError, String(error));
    assert.equal(error.code, code, error.message);
    if (pattern) assert.match(`${error.message} ${error.hint ?? ""}`, pattern);
    return error;
  }
  assert.fail(`expected ${code}`);
}

const kinds = (made: ReturnType<typeof env>, id: string) => made.store.events(id, 100).map((event) => event.kind);

test("trust: How tasks run allows chats, and every repo is in a chat project (or outside projects with As chats everywhere)", () => {
  assert.deepEqual(chatTrust(["acme/web"], WORKERS.projects, projects), { trusted: true, untrustedRepos: [], workersBoat: false });
  assert.deepEqual(chatTrust(["acme/web", "acme/other"], WORKERS.projects, projects).untrustedRepos, ["acme/other"]);
  assert.deepEqual(chatTrust(["acme/careful"], WORKERS.all, projects).untrustedRepos, ["acme/careful"], "a project's off wins over everywhere");
  assert.equal(chatTrust(["acme/other"], WORKERS.all, projects).trusted, true);
  assert.equal(chatTrust([], WORKERS.projects, projects).trusted, true, "no repo");
  // In boat: nothing is trusted, a task with no repo neither.
  assert.deepEqual(chatTrust([], WORKERS.boat, projects), { trusted: false, untrustedRepos: [], workersBoat: true });
  assert.deepEqual(chatTrust(["acme/web"], WORKERS.boat, projects).untrustedRepos, ["acme/web"]);
  // A confirm covers exactly the repos the warning named (case doesn't matter); [] for no repo.
  const trust = chatTrust(["acme/Other"], WORKERS.projects, projects);
  assert.equal(confirmCovers(null, trust), false);
  assert.equal(confirmCovers(["acme/other"], trust), true);
  assert.equal(confirmCovers(["acme/else"], trust), false);
  assert.equal(confirmCovers([], chatTrust([], WORKERS.boat, projects)), true);
});

test("explicit headless wins everywhere and needs no bb Connect; the history says why", async () => {
  const made = env({ workers: "all", connect: OFF });
  const { task } = await start(made, { runner: "boat" });
  assert.equal(task.runner, "boat");
  // bb Connect off: New task's box was greyed out, so nobody chose headless.
  assert.equal(made.store.latestEvent(task.id, "runner")!.text, "Runs headless in boat: task chats need bb Connect, which is off");
  // Headless by choice isn't "untrusted".
  assert.equal(made.store.latestEvent(task.id, "trust"), null);

  const ready = env({ workers: "all" });
  const { task: chosen } = await start(ready, { runner: "boat" });
  assert.match(ready.store.latestEvent(chosen.id, "runner")!.text, /Runs headless in boat, as asked \(How tasks run would make it a task chat\)/);
  assert.equal(ready.store.latestEvent(chosen.id, "trust"), null);
});

test("headless where the rules say headless anyway (New task's box left off): the Untrusted repo badge and no 'as asked'", async () => {
  const made = env();
  const { task } = await start(made, { runner: "boat", repo: "acme/other" });
  assert.match(made.store.latestEvent(task.id, "trust")!.text, /acme\/other isn't one of your projects: the task runs headless in boat/);
  assert.equal(made.store.latestEvent(task.id, "runner"), null);
  // Its reviews keep the badge too.
  made.boat.finish(task.conversationId!, "Done.\n=== REPORT ===\nSTATUS: done\n=== END REPORT ===");
  await made.service.sweep();
  const review = await made.service.launchTask({ ...(await made.service.reviewInput(task.id, { sandbox: "new" })), runner: "boat" }, 5_000);
  assert.notEqual(made.store.latestEvent(review.task.id, "trust"), null);
  // A project that runs its tasks headless isn't "untrusted": the user said so.
  const { task: careful } = await start(made, { runner: "boat", repo: "acme/careful" });
  assert.equal(made.store.latestEvent(careful.id, "trust"), null);
  assert.equal(made.store.latestEvent(careful.id, "runner"), null);
});

test("explicit chat on a trusted repo: bb Connect ready or unknown starts it, off refuses with --headless as the way out", async () => {
  const ready = env();
  assert.equal((await start(ready, { runner: "chat" })).task.runner, "chat");

  const unknown = env({ connect: UNKNOWN });
  assert.equal((await start(unknown, { runner: "chat" })).task.runner, "chat");

  const off = env({ connect: OFF });
  const error = await refused(start(off, { runner: "chat" }), "connect_required");
  assert.match(error.hint ?? "", /bb account login/);
  assert.match(error.hint ?? "", /--headless/);
  assert.doesNotMatch(error.hint ?? "", /config set workers boat/);
  assert.equal(off.boat.sandboxes.size, 0);
});

test("explicit chat on a repo outside your projects: refused without the user's confirm, started with it", async () => {
  const made = env();
  const error = await refused(start(made, { runner: "chat", repo: "acme/other" }), "untrusted_repo", /acme\/other isn't in one of your projects with Run tasks as chats on/);
  // Never "only the user": any RPC client can send the confirm.
  assert.match(error.hint ?? "", /the user decides/);
  assert.match(error.hint ?? "", /drop --chat/);
  assert.equal(made.boat.sandboxes.size, 0);
  assert.equal(made.store.list({ limit: 10 }).length, 0, "no task record either");

  const { task } = await start(made, { runner: "chat", repo: "acme/other", confirmUntrustedChat: ["acme/other"] });
  assert.equal(task.runner, "chat");
  assert.match(made.store.latestEvent(task.id, "trust-confirmed")!.text, /Your projects don't run tasks on acme\/other as chats; started as a task chat after the warning/);
  assert.equal(made.store.latestEvent(task.id, "trust"), null);
  assert.match(made.store.latestEvent(task.id, "runner")!.text, /Runs as a task chat, as asked/);
});

test("a confirm for another repo doesn't count", async () => {
  const made = env();
  await refused(start(made, { runner: "chat", repo: "acme/other", confirmUntrustedChat: ["acme/else"] }), "untrusted_repo", /changed after the warning/);
});

test("trust passed but bb Connect off: still connect_required", async () => {
  await refused(start(env({ connect: OFF }), { runner: "chat", repo: "acme/other", confirmUntrustedChat: ["acme/other"] }), "connect_required");
});

test("a project that runs its tasks headless is not trusted for chats", async () => {
  await refused(start(env(), { runner: "chat", repo: "acme/careful" }), "untrusted_repo", /acme\/careful's project runs its tasks headless/);
});

test("How tasks run In boat: no repo is trusted, a task with no repo neither", async () => {
  const made = env({ workers: "boat" });
  await refused(start(made, { runner: "chat" }), "untrusted_repo", /How tasks run is set to In boat/);
  await refused(start(made, { runner: "chat", repo: null }), "untrusted_repo", /How tasks run is set to In boat/);
  const { task } = await start(made, { runner: "chat", repo: null, confirmUntrustedChat: [] });
  assert.equal(task.runner, "chat");
  assert.match(made.store.latestEvent(task.id, "trust-confirmed")!.text, /How tasks run is set to In boat/);
});

test("no repo with chats on: a chat without a warning", async () => {
  const made = env();
  assert.equal((await start(made, { runner: "chat", repo: null })).task.runner, "chat");
});

test("explicit chat needs a chat runner, and a named sandbox that runs bb", async () => {
  await refused(start(env({ chat: false }), { runner: "chat" }), "chat_unavailable");
  const made = env();
  const { task: headless } = await start(made, { runner: "boat" });
  await refused(start(made, { runner: "chat", sandbox: headless.sandboxId }), "sandbox_not_chat", /doesn't run bb/);
});

test("--chat and the rules agree on a thread's project: an orchestrator's local project counts for both", async () => {
  const made = env({ workers: "projects" });
  const local = { ...toOrchestratorProject(normalizeProject({ id: "local", name: "Local", repos: [{ repo: "acme/local", baseBranch: "main" }] })), source: "local" as const };
  assert.equal((await start(made, { repo: null, project: local })).task.runner, "chat");
  assert.equal((await start(made, { runner: "chat", repo: null, project: local })).task.runner, "chat");
  // Its project runs tasks headless: neither.
  const headlessLocal = { ...local, workerMode: "boat" as const };
  assert.equal((await start(made, { repo: null, project: headlessLocal })).task.runner, "boat");
  await refused(start(made, { runner: "chat", repo: null, project: headlessLocal }), "untrusted_repo");
  // The plugin's projects win over the thread's: acme/careful's project runs its tasks headless.
  const claims = { ...local, repos: [{ repo: "acme/careful", baseBranch: "main" }] };
  assert.equal((await start(made, { repo: null, project: claims })).task.runner, "boat");
  await refused(start(made, { runner: "chat", repo: null, project: claims }), "untrusted_repo", /acme\/careful's project runs its tasks headless/);
});

test("every repo the task clones counts, for the rules as for --chat: a project's other repo in a headless project", async () => {
  const made = env();
  const project = toOrchestratorProject(
    normalizeProject({ id: "web", name: "Web", repos: [{ repo: "acme/web", baseBranch: "main" }, { repo: "acme/careful", baseBranch: "main" }] }),
  );
  // The rules: headless, and the history says why (acme/web alone would be a chat).
  const { task: ruled } = await start(made, { repo: null, project });
  assert.equal(ruled.runner, "boat");
  assert.equal(made.store.latestEvent(ruled.id, "runner")!.text, "Runs headless in boat: your projects don't run tasks on acme/careful as chats, and the task clones it too");
  assert.equal(made.store.latestEvent(ruled.id, "trust"), null, "acme/web is a project repo");
  // --chat: the user decides.
  await refused(start(made, { runner: "chat", repo: null, project }), "untrusted_repo", /acme\/careful/);
  await refused(start(made, { runner: "chat", repo: null, project, confirmUntrustedChat: ["acme/web"] }), "untrusted_repo");
  const { task } = await start(made, { runner: "chat", repo: null, project, confirmUntrustedChat: ["acme/careful"] });
  assert.equal(task.runner, "chat");
});

test("the rules and --chat never disagree: --chat goes without a confirm exactly where the rules pick a chat", async () => {
  const thread = (workerMode: Runner, ...repos: string[]) => ({
    ...toOrchestratorProject(normalizeProject({ id: "p", name: "P", repos: repos.map((repo) => ({ repo, baseBranch: "main" })) })),
    workerMode,
    source: "local" as const,
  });
  const cases: { name: string; input: Partial<StartTaskInput> }[] = [
    { name: "a chat project's repo", input: { repo: "acme/web" } },
    { name: "a headless project's repo", input: { repo: "acme/careful" } },
    { name: "a repo outside projects", input: { repo: "acme/other" } },
    { name: "no repo", input: { repo: null } },
    { name: "a project with a headless project's repo", input: { repo: null, project: thread("chat", "acme/web", "acme/careful") } },
    { name: "a project with a repo outside projects", input: { repo: null, project: thread("chat", "acme/web", "acme/other") } },
    { name: "a local project", input: { repo: null, project: thread("chat", "acme/local") } },
    { name: "a local project that runs headless", input: { repo: null, project: thread("boat", "acme/local") } },
  ];
  for (const workers of ["boat", "projects", "all"] as const) {
    for (const { name, input } of cases) {
      const made = env({ workers });
      const ruled = (await start(made, input)).task.runner;
      let explicit: Runner | "refused";
      try {
        explicit = (await start(made, { ...input, runner: "chat" })).task.runner;
      } catch (error) {
        assert.ok(error instanceof TaskError && error.code === "untrusted_repo", String(error));
        explicit = "refused";
      }
      assert.equal(explicit === "chat", ruled === "chat", `${workers}, ${name}: the rules pick ${ruled}, --chat is ${explicit}`);
    }
  }
});

test("a sandbox that runs bb takes no untrusted repo, headless or not (--headless, boat_dispatch headless, reviews)", async () => {
  const made = env();
  const { task: chatTask } = await start(made);
  assert.equal(chatTask.runner, "chat");
  const sandbox = chatTask.sandboxId!;
  // The rules refused this already; an explicit headless (CLI --headless, the tool's headless: true) does too.
  await refused(start(made, { repo: "acme/evil", sandbox }), "untrusted_sandbox");
  await refused(start(made, { repo: "acme/evil", sandbox, runner: "boat" }), "untrusted_sandbox", /headless or not/);
  await refused(start(made, { repo: "acme/careful", sandbox, runner: "boat" }), "untrusted_sandbox");
  assert.equal(made.store.list({ limit: 50 }).length, 1, "no task record");

  // A closed task chat's kept machine still holds bb's login.
  await made.service.closeTask(chatTask.id, { status: "done", keepSandbox: true });
  assert.equal(made.store.hostForSandbox(sandbox), null);
  await refused(start(made, { repo: "acme/evil", sandbox }), "untrusted_sandbox");
  await refused(start(made, { repo: "acme/evil", sandbox, runner: "boat" }), "untrusted_sandbox");
  // A trusted repo may still run headless there.
  const { task: trusted } = await start(made, { sandbox, runner: "boat" });
  assert.equal(trusted.runner, "boat");
  await made.service.closeTask(trusted.id, { status: "done", keepSandbox: true });

  // A machine only bb knows (an orchestrator's).
  const orchestrator = await made.boat.create({ name: "orchestrator", type: "small" });
  made.chat.machines.push({ taskId: "orchestrator", sandboxId: orchestrator.id, hostId: "host_orch", key: "orchestrator-x" });
  await refused(start(made, { repo: "acme/evil", sandbox: orchestrator.id, runner: "boat" }), "untrusted_sandbox");

  // A review of a chat the user made against the rules: not into another chat's sandbox, but its own is no news.
  const { task: userMade } = await start(made, { runner: "chat", repo: "acme/evil", confirmUntrustedChat: ["acme/evil"] });
  await made.service.sweep();
  made.chat.finish(userMade.threadId!, "Done.");
  await made.service.sweep();
  const { task: other } = await start(made);
  await refused(made.service.launchTask(await made.service.reviewInput(userMade.id, { sandbox: other.sandboxId }), 5_000), "untrusted_sandbox");
  const own = await made.service.launchTask(await made.service.reviewInput(userMade.id, { sandbox: made.store.get(userMade.id)!.sandboxId }), 5_000);
  assert.equal(own.task.runner, "boat");
});

test("reviews follow their task, unless explicitly overridden", async () => {
  const made = env();
  const { task: implementation } = await start(made, { runner: "boat" });
  made.boat.finish(implementation.conversationId!, "Done.\n=== REPORT ===\nSTATUS: done\n=== END REPORT ===");
  await made.service.sweep();
  // The rules: a headless task's review is headless.
  const followed = await made.service.launchTask(await made.service.reviewInput(implementation.id, { sandbox: "new" }), 5_000);
  assert.equal(followed.task.runner, "boat");
  // An explicit chat on a review with its own sandbox: a chat.
  const chatReview = await made.service.launchTask({ ...(await made.service.reviewInput(implementation.id, { sandbox: "new" })), runner: "chat" }, 5_000);
  assert.equal(chatReview.task.runner, "chat");
  // Sharing the headless task's sandbox can't be a chat, and isn't quietly switched to headless.
  await refused(
    made.service.launchTask({ ...(await made.service.reviewInput(implementation.id, { sandbox: "same" })), runner: "chat" }, 5_000),
    "sandbox_not_chat",
  );
});

test("a task the user made a chat against the rules: its reviews run headless", async () => {
  const made = env();
  const { task } = await start(made, { runner: "chat", repo: "acme/other", confirmUntrustedChat: ["acme/other"] });
  await made.service.sweep();
  made.chat.finish(task.threadId!, "Done.\n```text\n=== REPORT ===\nSTATUS: done\n=== END REPORT ===\n```");
  await made.service.sweep();
  const review = await made.service.launchTask(await made.service.reviewInput(task.id, { sandbox: "new" }), 5_000);
  assert.equal(review.task.runner, "boat");
  assert.match(made.store.latestEvent(review.task.id, "runner")!.text, /only because the user asked/);
  // A trusted chat task's reviews still follow it.
  const { task: trusted } = await start(made, { runner: "chat" });
  await made.service.sweep();
  made.chat.finish(trusted.threadId!, "Done.");
  await made.service.sweep();
  assert.equal((await made.service.launchTask(await made.service.reviewInput(trusted.id, { sandbox: "new" }), 5_000)).task.runner, "chat");
});

test("without a runner the rules decide as before", async () => {
  const made = env();
  assert.equal((await start(made)).task.runner, "chat");
  assert.equal((await start(made, { repo: "acme/other" })).task.runner, "boat");
  assert.equal((await start(made, { repo: "acme/careful" })).task.runner, "boat");
  // A project from the thread's metadata still counts for the rules (unchanged).
  const project = toOrchestratorProject(normalizeProject({ id: "local", name: "Local", repos: [{ repo: "acme/local", baseBranch: "main" }] }));
  assert.equal((await start(made, { repo: null, project })).task.runner, "chat");
});
