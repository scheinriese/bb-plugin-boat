// Regressions from the P5 review: approvals, unshipped work, delivery rules,
// preview link safety and timing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePreview } from "../src/briefs.ts";
import { parseShipOutput } from "../src/boat-api.ts";
import { notificationText, taskDetail } from "../src/format.ts";
import { checkPreview, previewLink } from "../src/previews.ts";
import { toTaskDto } from "../src/rpc.ts";
import { TaskError, reviewSandboxFor } from "../src/service.ts";
import type { OrchestratorProject } from "../src/projects.ts";
import type { Task } from "../src/store.ts";
import { makeService } from "./fakes.ts";

const REPORT = `Done.
=== REPORT ===
STATUS: done
PREVIEW: port=4321 path=/ cmd="npm run dev"
=== END REPORT ===`;

const STOREFRONT: OrchestratorProject = {
  id: "storefront",
  name: "Storefront",
  repos: [{ repo: "acme/storefront", baseBranch: "master" }],
  environment: "storefront",
  snapshot: "storefront-ready",
  protocolPath: null,
  workerMode: "boat",
  delivery: "push",
  source: "boat",
  protectedBranches: [],
  instructions: "",
  bbProjectId: null,
};

const brief = (overrides: Record<string, unknown> = {}) => ({
  title: "Sticky header",
  role: "implement" as const,
  brief: "Do it.",
  repo: "acme/storefront",
  orchestratorThreadId: "thr_orch",
  project: STOREFRONT,
  ...overrides,
});

const ahead = (...rows: string[]) => (script: string) =>
  script.includes("BOAT_AHEAD") ? { exitCode: 0, stdout: rows.map((row) => `BOAT_AHEAD ${row}`).join("\n"), stderr: "" } : { exitCode: 0, stdout: "", stderr: "" };

test("preview links never leave boat's host, and checks only fetch boat's hosts", async () => {
  assert.equal(parsePreview('PREVIEW: port=3000 path=//evil.example/x cmd="x"')?.path, "/evil.example/x");
  assert.equal(previewLink("https://bx-3000.on.boat.dev?_token=t", "//evil.example/x"), "https://bx-3000.on.boat.dev/evil.example/x?_token=t");
  assert.equal(previewLink("https://bx-3000.on.boat.dev?_token=t", "/\\evil.example"), "https://bx-3000.on.boat.dev/evil.example?_token=t");
  const seen: string[] = [];
  const response = (status: number, headers: Record<string, string> = {}, body = "") => ({ status, headers: { get: (name: string) => headers[name] ?? null }, text: async () => body });
  // Not a boat host: never fetched.
  assert.equal(await checkPreview("https://intranet.local/", async (url) => (seen.push(url), response(200))), "unknown");
  assert.equal(seen.length, 0);
  // A redirect elsewhere isn't followed.
  await checkPreview("https://bx-3000.on.boat.dev/?_token=t", async (url: string) => {
    seen.push(url);
    return response(302, { location: "https://elsewhere.example/" });
  });
  assert.deepEqual(seen, ["https://bx-3000.on.boat.dev/?_token=t"]);
  // webpack's host check is "blocked"; an app's own 403 on a running sandbox is a live server.
  assert.equal(await checkPreview("https://bx-3000.on.boat.dev/", async () => response(403, {}, "Invalid Host header")), "blocked");
  assert.equal(await checkPreview("https://bx-3000.on.boat.dev/", async () => response(403, {}, "Forbidden"), 6_000, { sandboxActive: true }), "up");
  assert.equal(await checkPreview("https://bx-3000.on.boat.dev/", async () => response(403, {}, "Access denied")), "down");
});

test("a partial ship is parsed: what landed and where it stopped", () => {
  const targets = [
    { path: "/w/storefront", baseBranch: "master" },
    { path: "/w/api", baseBranch: "main" },
  ];
  const parsed = parseShipOutput("BOAT_SHIPPED 0 abcdef1234567 2\nBOAT_SHIP_ERROR 1 push\nBOAT_SHIP_DETAIL ! [rejected] HEAD -> main (fetch first)\n", targets);
  assert.deepEqual(parsed.shipped, [{ path: "/w/storefront", baseBranch: "master", sha: "abcdef1234567", commits: 2 }]);
  assert.deepEqual(parsed.failure, { target: targets[1], reason: "push", detail: ["! [rejected] HEAD -> main (fetch first)"], conflict: null });
});

test("unshipped work: every repo and uncommitted files count, cancel and archive keep it", async () => {
  const env = makeService({ chat: true });
  env.boat.limitsValue.maxActiveSandboxes = 10;
  const { task } = await env.service.launchTask(
    brief({ project: { ...STOREFRONT, workerMode: "chat", repos: [...STOREFRONT.repos, { repo: "acme/api", baseBranch: "main" }] } }),
    5_000,
  );
  await env.service.sweep();
  env.chat.finish(env.store.get(task.id)!.threadId!, REPORT);
  await env.service.sweep();
  const current = env.store.get(task.id)!;
  assert.equal(current.extraRepos.length, 1);
  // Only the second repo has a commit: still unshipped.
  env.boat.execResult = ahead("0 clean", "1 clean");
  await assert.rejects(env.service.closeTask(task.id), (error: unknown) => error instanceof TaskError && error.code === "unshipped_work");
  // Untracked or uncommitted files count too.
  env.boat.execResult = ahead("0 dirty", "0 clean");
  await assert.rejects(env.service.closeTask(task.id), (error: unknown) => error instanceof TaskError && error.code === "unshipped_work");
  // Cancelling is no shortcut.
  await assert.rejects(env.service.closeTask(task.id, { status: "cancelled" }), (error: unknown) => error instanceof TaskError && error.code === "unshipped_work");
  // The agent-facing hint doesn't suggest throwing it away.
  await env.service.closeTask(task.id).catch((error: TaskError) => assert.doesNotMatch(error.hint ?? "", /--discard/));

  // Archiving the worker chat cancels the task but keeps the machine with the work.
  env.boat.execResult = ahead("1 clean", "0 clean");
  await env.chat.archive(current.threadId!);
  await env.service.sweep();
  assert.equal(env.store.get(task.id)!.status, "cancelled");
  assert.deepEqual(env.chat.removed, []);
  assert.ok(env.store.events(task.id, 50).some((event) => /Kept sandbox .*hasn't shipped/.test(event.text)));
});

test("Ship is offered only when a finished turn left work to ship", async () => {
  const env = makeService();
  env.boat.limitsValue.maxActiveSandboxes = 10;
  // A check task in a project that ships after approval: it commits nothing.
  env.boat.execResult = ahead("0 clean");
  const { task } = await env.service.launchTask(brief({ title: "Check acme/storefront runs in a sandbox", role: "custom" }), 5_000);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  let current = env.store.get(task.id)!;
  assert.equal(current.unshipped, 0);
  assert.equal(toTaskDto(current).unshipped, false, "Close is a plain close");
  assert.equal(toTaskDto(current).canShip, false);
  // Its notice and details say so, without pointing at boat_ship.
  assert.match(notificationText([current]), /No pull request, and nothing to ship: the task left no new commits or changed files on top of master\./);
  assert.doesNotMatch(notificationText([current]), /boat_ship/);
  assert.match(taskDetail(current, []), /nothing to ship now/);

  // A follow-up that commits (or leaves changed files): Ship is back.
  env.boat.execResult = ahead("0 dirty");
  await env.service.followup(task.id, "Fix the failing test and commit it.");
  assert.equal(toTaskDto(env.store.get(task.id)!).unshipped, true, "a running turn may be committing");
  assert.equal(toTaskDto(env.store.get(task.id)!).canShip, false);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  current = env.store.get(task.id)!;
  assert.equal(current.unshipped, 1);
  assert.equal(toTaskDto(current).canShip, true);
  // Not while it moves to a chat (the move holds the sandbox).
  assert.equal(toTaskDto(current, { movingToChat: true }).canShip, false);
  assert.match(notificationText([current]), /ships to master once the user approves \(`boat_ship`/);

  // Shipped but kept open: nothing left to ship.
  await env.service.shipTask(task.id, { approval: "test", keepOpen: true });
  assert.equal(env.store.get(task.id)!.unshipped, 0);
  assert.equal(toTaskDto(env.store.get(task.id)!).canShip, false);

  // When the sandbox can't tell, Ship stays (as before the check).
  env.boat.execResult = () => ({ exitCode: 1, stdout: "", stderr: "boom" });
  const other = await env.service.launchTask(brief(), 5_000);
  env.boat.finish(other.task.conversationId!, REPORT);
  await env.service.sweep();
  assert.equal(env.store.get(other.task.id)!.unshipped, null);
  assert.equal(toTaskDto(env.store.get(other.task.id)!).canShip, true);
  // Pull-request projects never check.
  const before = env.boat.execs.length;
  const pr = await env.service.launchTask(brief({ project: { ...STOREFRONT, delivery: "pr" } }), 5_000);
  env.boat.finish(pr.task.conversationId!, REPORT);
  await env.service.sweep();
  assert.ok(!env.boat.execs.slice(before).some((entry) => entry.script.includes("BOAT_AHEAD")));
  assert.equal(toTaskDto(env.store.get(pr.task.id)!).unshipped, false);
});

test("a task chat's finished turn is checked for work to ship too", async () => {
  const env = makeService({ chat: true });
  env.boat.limitsValue.maxActiveSandboxes = 10;
  const { task } = await env.service.launchTask(brief({ project: { ...STOREFRONT, workerMode: "chat" } }), 5_000);
  await env.service.sweep();
  env.boat.execResult = ahead("0 clean");
  env.chat.finish(env.store.get(task.id)!.threadId!, REPORT);
  await env.service.sweep();
  assert.equal(env.store.get(task.id)!.status, "idle");
  assert.equal(env.store.get(task.id)!.unshipped, 0);
  assert.equal(toTaskDto(env.store.get(task.id)!).canShip, false);
  // Closing it needs no discard.
  assert.equal((await env.service.closeTask(task.id)).task.status, "done");
});

test("reviews of unshipped work run in the implementer's sandbox; other sandboxes are refused", () => {
  const parent = { id: "t_1", delivery: "push", sandboxId: "bx_1" } as Task;
  for (const requested of [null, "", "auto", "new", "same"]) assert.equal(reviewSandboxFor(parent, requested), "same");
  assert.equal(reviewSandboxFor(parent, "bx_1"), "bx_1");
  assert.throws(() => reviewSandboxFor(parent, "bx_other"), (error: unknown) => error instanceof TaskError && error.code === "invalid_value");
  assert.equal(reviewSandboxFor({ ...parent, delivery: "pr" } as Task, "auto"), "auto");
});

test("delivery: push only for new work off the project's base; current settings win; snapshots stay in the project", async () => {
  const env = makeService();
  env.boat.limitsValue.maxActiveSandboxes = 20;
  // A pull request or an existing branch goes through pull requests.
  assert.equal((await env.service.launchTask(brief({ pr: "12" }), 5_000)).task.delivery, "pr");
  assert.equal((await env.service.launchTask(brief({ branch: "existing-feature" }), 5_000)).task.delivery, "push");
  // Another base than the project's: pull requests.
  assert.equal((await env.service.launchTask(brief({ baseBranch: "release" }), 5_000)).task.delivery, "pr");
  // The repo from another orchestrator's project: the project that ships after approval still decides.
  const hooked = makeService();
  (hooked.service as unknown as { hooks: { repoDelivery: (repo: string, base: string) => "pr" | "push" | null } }).hooks.repoDelivery = (repo, base) =>
    repo === "acme/storefront" && base === "master" ? "push" : null;
  const other = await hooked.service.launchTask(brief({ project: null, baseBranch: "master" }), 5_000);
  assert.equal(other.task.delivery, "push");
  // A repo outside the project doesn't start from the project's snapshot.
  await env.service.launchTask(brief({ repo: "acme/other" }), 5_000);
  assert.equal(env.boat.created.at(-1)!.from, null);
  await env.service.launchTask(brief(), 5_000);
  assert.equal(env.boat.created.at(-1)!.from, "storefront-ready");
});

test("a notice waits for its preview link; Wake holds its sandbox and live means a fresh 'up'", async () => {
  let release: () => void = () => undefined;
  const env = makeService({ settings: { stopIdleAfterMinutes: 1 } });
  const original = env.boat.host.bind(env.boat);
  env.boat.host = (id: string, port: number, title: string) =>
    new Promise((resolve) => {
      release = () => void original(id, port, title).then(resolve);
    });
  const { task } = await env.service.launchTask(brief(), 5_000);
  env.boat.finish(task.conversationId!, REPORT);
  const sweeping = env.service.sweep();
  // Let the sweep reach host().
  await new Promise((resolve) => setTimeout(resolve, 20));
  await env.service.deliverPending();
  assert.equal(env.notifications.length, 0);
  release();
  await sweeping;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(env.notifications.length, 1);
  assert.equal(env.notifications[0]!.tasks[0]!.id, task.id);

  // Stop refuses while a ship or wake holds the sandbox.
  const [view] = await env.service.previews({ taskId: task.id });
  const claims = (env.service as unknown as { claims: Map<string, number> }).claims;
  claims.set(task.sandboxId!, 1);
  await assert.rejects(env.service.stopPreview(view!.preview.id), (error: unknown) => error instanceof TaskError && error.code === "sandbox_busy");
  claims.delete(task.sandboxId!);
  // After a resume, nothing counts as live until it's checked.
  env.store.resetPreviewHealthForSandbox(task.sandboxId!);
  assert.equal(env.store.preview(view!.preview.id)!.health, "unknown");
});

test("snapshots aren't taken of bb machines", async () => {
  const env = makeService({ chat: true });
  const { task } = await env.service.launchTask(brief({ project: { ...STOREFRONT, workerMode: "chat", snapshot: null } }), 5_000);
  await env.service.sweep();
  const sandboxId = env.store.get(task.id)!.sandboxId!;
  await assert.rejects(env.service.saveSnapshot(sandboxId, "with-bb"), (error: unknown) => error instanceof TaskError && /runs bb/.test(error.message));
});
