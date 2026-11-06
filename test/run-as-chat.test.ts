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

test("explicit headless wins everywhere and needs no bb Connect", async () => {
  const made = env({ workers: "all", connect: OFF });
  const { task } = await start(made, { runner: "boat" });
  assert.equal(task.runner, "boat");
  assert.ok(kinds(made, task.id).includes("runner"));
  assert.match(made.store.latestEvent(task.id, "runner")!.text, /Runs headless in boat, as asked/);
  // Headless by choice isn't "untrusted".
  assert.equal(made.store.latestEvent(task.id, "trust"), null);
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

test("only the plugin's projects make a repo trusted, never a thread's project metadata", async () => {
  const made = env({ workers: "projects" });
  // An agent can write any project into its thread's metadata.
  const forged = toOrchestratorProject(normalizeProject({ id: "evil", name: "Evil", repos: [{ repo: "evil/x", baseBranch: "main" }] }));
  await refused(start(made, { runner: "chat", repo: "evil/x", project: { ...forged, source: "local" } }), "untrusted_repo");
  await refused(start(made, { runner: "chat", repo: null, project: forged }), "untrusted_repo");
});

test("every repo of the task counts: a project's other repo outside the chat projects needs the confirm too", async () => {
  const made = env();
  const project = toOrchestratorProject(
    normalizeProject({ id: "web", name: "Web", repos: [{ repo: "acme/web", baseBranch: "main" }, { repo: "acme/api", baseBranch: "main" }] }),
  );
  await refused(start(made, { runner: "chat", repo: null, project }), "untrusted_repo", /acme\/api/);
  await refused(start(made, { runner: "chat", repo: null, project, confirmUntrustedChat: ["acme/web"] }), "untrusted_repo");
  const { task } = await start(made, { runner: "chat", repo: null, project, confirmUntrustedChat: ["acme/api"] });
  assert.equal(task.runner, "chat");
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
