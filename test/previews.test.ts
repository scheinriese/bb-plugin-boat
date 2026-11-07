// P5: previews (boat host), shipping after approval, and snapshots.
import assert from "node:assert/strict";
import { test } from "node:test";
import { composeFollowupPrompt, composeInitialPrompt, parsePreview } from "../src/briefs.ts";
import { BoatError } from "../src/boat.ts";
import { notificationText } from "../src/format.ts";
import { checkPreview, previewLink, previewView } from "../src/previews.ts";
import { TaskError, previewStartScript, snapshotError } from "../src/service.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrchestratorProject } from "../src/projects.ts";
import { makeService } from "./fakes.ts";

const PREVIEW_REPORT = `Done, the header is sticky now.

=== REPORT ===
STATUS: done
PR: none
BRANCH: boat/x
SUMMARY: Sticky header.
TESTS: npm test passes
PREVIEW: port=4321 path=/projects cmd="npm run dev -- --host 0.0.0.0 --port 4321"
OPEN QUESTIONS: none
=== END REPORT ===`;

const STOREFRONT: OrchestratorProject = {
  id: "storefront",
  name: "Storefront",
  repos: [{ repo: "acme/storefront", baseBranch: "master" }],
  environment: "storefront",
  snapshot: null,
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
  brief: "Make the header sticky.",
  repo: "acme/storefront",
  orchestratorThreadId: "thr_orch",
  ...overrides,
});

test("the PREVIEW line: port, page and command, or none", () => {
  assert.deepEqual(parsePreview(PREVIEW_REPORT), { port: 4321, path: "/projects", command: "npm run dev -- --host 0.0.0.0 --port 4321" });
  assert.deepEqual(parsePreview('PREVIEW: port=3000 cmd="python3 -m http.server 3000 --bind 0.0.0.0"'), { port: 3000, path: "/", command: "python3 -m http.server 3000 --bind 0.0.0.0" });
  assert.deepEqual(parsePreview("PREVIEW: port=8080 path=docs/index.html cmd=npx serve -l 8080"), { port: 8080, path: "/docs/index.html", command: "npx serve -l 8080" });
  // The template's own wording, "none", nonsense, and the last line wins.
  assert.equal(parsePreview("PREVIEW: none"), null);
  assert.equal(parsePreview('PREVIEW: "none"'), null);
  assert.equal(parsePreview("PREVIEW: port=99999"), null);
  assert.equal(parsePreview("no preview here"), null);
  assert.equal(parsePreview("PREVIEW: port=1111\n...\nPREVIEW: port=2222")?.port, 2222);
  // A path that isn't a plain URL path falls back to the root.
  assert.equal(parsePreview('PREVIEW: port=3000 path=/"><script> cmd="x"')?.path, "/");
});

test("private links keep their token when a page path is added", () => {
  assert.equal(previewLink("https://box-1-4321.on.boat.dev?_token=abc", "/projects"), "https://box-1-4321.on.boat.dev/projects?_token=abc");
  assert.equal(previewLink("https://box-1-4321.on.boat.dev?_token=abc", "/a?b=1"), "https://box-1-4321.on.boat.dev/a?b=1&_token=abc");
  assert.equal(previewLink("https://box-1-4321.on.boat.dev?_token=abc", "/"), "https://box-1-4321.on.boat.dev/?_token=abc");
});

test("a preview check follows the token redirect with its cookie, like a browser", async () => {
  const seen: { url: string; cookie?: string }[] = [];
  const response = (status: number, headers: Record<string, string> = {}) => ({ status, headers: { get: (name: string) => headers[name] ?? null }, text: async () => "" });
  const up = await checkPreview("https://box-4321.on.boat.dev/projects?_token=abc", async (url, init) => {
    seen.push({ url, ...(init.headers?.cookie ? { cookie: init.headers.cookie } : {}) });
    return seen.length === 1 ? response(302, { location: "/projects", "set-cookie": "_port_auth=abc; Path=/; HttpOnly" }) : response(200);
  });
  assert.equal(up, "up");
  assert.deepEqual(seen, [{ url: "https://box-4321.on.boat.dev/projects?_token=abc" }, { url: "https://box-4321.on.boat.dev/projects", cookie: "_port_auth=abc" }]);
  // boat reached the sandbox but nothing listens; the sandbox is stopped; no answer at all.
  assert.equal(await checkPreview("https://bx-4321.on.boat.dev/", async () => response(502)), "down");
  assert.equal(await checkPreview("https://bx-4321.on.boat.dev/", async () => response(403)), "down");
  assert.equal(
    await checkPreview("https://bx-4321.on.boat.dev/", async () => {
      throw new Error("ECONNRESET");
    }),
    "unknown",
  );
  // A page the app says doesn't exist is still a live server.
  assert.equal(await checkPreview("https://bx-4321.on.boat.dev/", async () => response(404)), "up");
  // Vite's host check refuses boat's host name: not "stopped".
  const blocked = { status: 403, headers: { get: () => null }, text: async () => 'Blocked request. This host ("box-4321.on.boat.dev") is not allowed.' };
  assert.equal(await checkPreview("https://bx-4321.on.boat.dev/", async () => blocked), "blocked");
});

test("a preview server restarts from the checkout, allowing boat's host names, whatever shape its command has", () => {
  const dir = mkdtempSync(join(tmpdir(), "preview-start-"));
  mkdirSync(join(dir, "apps", "site"), { recursive: true });
  const script = previewStartScript(dir, 4321, 'cd apps/site && echo "allowed=$__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS" > started.txt && echo "server log line"');
  execFileSync("bash", ["-c", script.replaceAll("/tmp/preview-4321.log", join(dir, "preview.log"))]);
  assert.equal(readFileSync(join(dir, "apps", "site", "started.txt"), "utf8"), "allowed=.on.boat.dev\n");
  assert.equal(readFileSync(join(dir, "preview.log"), "utf8"), "server log line\n");
  // It frees the port first (a stuck or host-blocking server).
  assert.match(script, /ss -ltnpH "sport = :4321"/);
});

test("a reported preview is hosted privately and named in the orchestrator's notice", async () => {
  const env = makeService();
  const { task } = await env.service.launchTask(brief(), 5_000);
  env.boat.finish(task.conversationId!, PREVIEW_REPORT);
  await env.service.sweep();
  assert.deepEqual(env.boat.hosts, [{ id: task.sandboxId!, port: 4321, title: "Sticky header" }]);
  const link = env.service.previewLinkFor(task.id)!;
  assert.equal(link, `https://${task.sandboxId}-4321.on.boat.dev/projects?_token=tok_${task.sandboxId}`);
  const [view] = await env.service.previews({ taskId: task.id });
  assert.equal(view?.state, "live");
  assert.equal(view?.preview.command, "npm run dev -- --host 0.0.0.0 --port 4321");
  const notice = notificationText([env.store.get(task.id)!], undefined, undefined, (id) => env.service.previewLinkFor(id));
  assert.match(notice, new RegExp(`\\nPreview: ${link.replace(/[?.]/g, "\\$&")}`));
});

test("a server that didn't survive the turn is started again; Wake resumes, restarts and re-hosts", async () => {
  // The server answers once the plugin has started it (again).
  let started = 0;
  const previewsStarted = () => env.boat.detached.filter((entry) => entry.command.includes("/tmp/preview-4321.log"));
  const env = makeService({ checkPreview: async () => (previewsStarted().length > started ? "up" : "down") });
  const { task } = await env.service.launchTask(brief(), 5_000);
  env.boat.finish(task.conversationId!, PREVIEW_REPORT);
  // The first check at the end of the turn fails; the plugin restarts the server.
  await env.service.sweep();
  assert.equal(previewsStarted().length, 1);
  // …but it stops answering again.
  started = 1;
  const [first] = await env.service.previews({ taskId: task.id });
  env.store.setPreviewHealth(first!.preview.id, "down");
  assert.equal(previewsStarted()[0]!.command, previewStartScript("/home/user/work/storefront", 4321, "npm run dev -- --host 0.0.0.0 --port 4321"));
  const [down] = await env.service.previews({ taskId: task.id });
  assert.equal(down?.state, "sleeping");
  assert.equal(down?.reason, "the server isn't running");

  // Later: the sandbox stopped. Wake brings it back.
  await env.boat.stop(task.sandboxId!);
  assert.equal((await env.service.previews({ taskId: task.id }))[0]?.state, "sleeping");
  const woken = await env.service.wakePreview(down!.preview.id);
  assert.equal(woken.state, "live");
  assert.ok(env.boat.calls.some((call) => call.startsWith(`resume ${task.sandboxId}`)));
  assert.equal(previewsStarted().length, 2);
  assert.equal(env.boat.hosts.length, 2);

  // Extend and Stop.
  // The trial's auto-stop cap (2 h, from boat) bounds it; a plan without one gets the hours asked for.
  assert.equal((await env.service.extendPreview(down!.preview.id, 3)).hours, 2);
  assert.deepEqual(env.boat.extended.at(-1), { id: task.sandboxId, args: ["--ttl", "7200"] });
  env.boat.limitsValue = { ...env.boat.limitsValue, tier: "standard", autoStopCapHours: null };
  assert.equal((await env.service.extendPreview(down!.preview.id, 3)).hours, 3);
  assert.deepEqual(env.boat.extended.at(-1), { id: task.sandboxId, args: ["--ttl", "10800"] });
  await assert.rejects(env.service.extendPreview(down!.preview.id, 48), (error: unknown) => error instanceof TaskError && error.code === "invalid_value");
  const stopped = await env.service.stopPreview(down!.preview.id);
  assert.equal(stopped.state, "sleeping");
  assert.ok(env.boat.calls.includes(`stop ${task.sandboxId}`));

  // Closing the task (sandbox deleted) expires it.
  await env.service.closeTask(task.id, { status: "cancelled" });
  const [expired] = await env.service.previews({ taskId: task.id, includeExpired: true });
  assert.equal(expired?.state, "expired");
  await assert.rejects(env.service.wakePreview(down!.preview.id), (error: unknown) => error instanceof TaskError && error.code === "preview_expired");
});

test("a live preview waiting on the user keeps its sandbox from being stopped as idle", async () => {
  let health: "up" | "down" = "up";
  const env = makeService({ settings: { stopIdleAfterMinutes: 1 }, checkPreview: async () => health });
  const { task } = await env.service.launchTask(brief(), 5_000);
  env.boat.finish(task.conversationId!, PREVIEW_REPORT);
  await env.service.sweep();
  const db = env.store as unknown as { db: () => { prepare(sql: string): { run(...args: unknown[]): void } } };
  const age = () => db.db().prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 5 * 60_000).toISOString(), task.id);
  age();
  await env.service.sweep();
  assert.ok(!env.boat.calls.includes(`stop ${task.sandboxId}`));
  // Once the server is gone, the sandbox is stopped as usual.
  health = "down";
  const [view] = await env.service.previews({ taskId: task.id });
  env.store.setPreviewHealth(view!.preview.id, "down");
  age();
  await env.service.sweep();
  assert.ok(env.boat.calls.includes(`stop ${task.sandboxId}`));
});

test("projects that ship after approval: workers only commit, reviews run where the commits are", async () => {
  const env = makeService();
  env.boat.limitsValue.maxActiveSandboxes = 10;
  const { task } = await env.service.launchTask(brief({ project: STOREFRONT }), 5_000);
  assert.equal(task.delivery, "push");
  assert.equal(env.boat.prepared.at(-1)!.options.noPush, true);
  const prompt = env.boat.prompts.at(-1)!.text;
  assert.match(prompt, /3\. Commit in logical steps with clear messages\. Don't push and don't open a pull request/);
  assert.match(prompt, /Don't push anything and don't open a pull request: this project ships after the user approves your work, and then the plugin pushes your commits to `master`/);
  assert.match(prompt, /## Preview\nIf your change shows in a browser, leave a preview running/);
  assert.match(prompt, /PREVIEW: <port=<n> path=<page path> cmd=/);
  assert.doesNotMatch(prompt, /gh pr create/);
  // A PR project keeps pull requests (and still offers previews).
  const pr = await env.service.launchTask(brief({ project: { ...STOREFRONT, delivery: "pr" } }), 5_000);
  assert.equal(pr.task.delivery, "pr");
  assert.equal(env.boat.prepared.at(-1)!.options.noPush, false);
  assert.match(env.boat.prompts.at(-1)!.text, /gh pr create --draft/);
  // The review runs in the implementer's sandbox, without GitHub.
  env.boat.finish(task.conversationId!, PREVIEW_REPORT);
  await env.service.sweep();
  const { task: review } = await env.service.launchTask(await env.service.reviewInput(task.id), 5_000);
  assert.equal(review.sandboxId, task.sandboxId);
  assert.equal(review.delivery, "push");
  assert.match(env.boat.prompts.at(-1)!.text, /git log origin\/<base>\.\.HEAD[\s\S]*Don't post anything on GitHub/);
  // Follow-ups say commit, not push.
  assert.match(composeFollowupPrompt("implement", "Tweak it.", { delivery: "push" }), /Commit the changes on your branch \(don't push\)/);
  assert.match(composeInitialPrompt({ taskId: "t", role: "custom", title: "x", brief: "y", workspace: { repo: "a/b", repoPath: "/w", branch: "b", baseBranch: "main", prUrl: null, delivery: "push" } }), /If you change code: commit on your branch\.\n- Don't push anything/);
});

test("shipping: approved work lands on the base branch and the task closes; unshipped work isn't closed by accident", async () => {
  const env = makeService();
  env.boat.limitsValue.maxActiveSandboxes = 10;
  const { task } = await env.service.launchTask(brief({ project: STOREFRONT }), 5_000);
  env.boat.finish(task.conversationId!, PREVIEW_REPORT);
  await env.service.sweep();
  assert.match(notificationText([env.store.get(task.id)!]), /No pull request: this project ships to master once the user approves/);

  // Closing as done would delete the only copy.
  env.boat.execResult = (script) => (script.includes("BOAT_AHEAD") ? { exitCode: 0, stdout: "BOAT_AHEAD 2 clean\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
  await assert.rejects(env.service.closeTask(task.id), (error: unknown) => error instanceof TaskError && error.code === "unshipped_work");
  // A conflict stops the ship; the task stays open.
  env.boat.shipError = new BoatError("Couldn't ship /w → master: conflict.", { code: "ship_conflict" });
  await assert.rejects(env.service.shipTask(task.id, { approval: "test" }), (error: unknown) => error instanceof TaskError && error.code === "ship_conflict");
  assert.equal(env.store.get(task.id)!.status, "idle");
  env.boat.shipError = null;

  const result = await env.service.shipTask(task.id, { approval: "by the user on the overview" });
  assert.deepEqual(env.boat.ships.at(-1)!.targets, [{ path: "/home/user/work/storefront", baseBranch: "master" }]);
  assert.deepEqual(result.shipped.map((entry) => [entry.baseBranch, entry.commits]), [["master", 2]]);
  assert.equal(result.task.status, "done");
  assert.equal(result.sandbox, "deleted");
  assert.ok(env.store.events(task.id, 50).some((event) => event.kind === "shipped" && /Shipped 2 commits to master \(abcdef1\); approved by the user on the overview/.test(event.text)));

  // PR projects don't ship; nothing to ship is said plainly.
  const pr = await env.service.launchTask(brief({ project: { ...STOREFRONT, delivery: "pr" } }), 5_000);
  await assert.rejects(env.service.shipTask(pr.task.id, { approval: "test" }), (error: unknown) => error instanceof TaskError && error.code === "not_shippable");
  const other = await env.service.launchTask(brief({ project: STOREFRONT }), 5_000);
  env.boat.finish(other.task.conversationId!, PREVIEW_REPORT);
  await env.service.sweep();
  env.boat.shipCommits = 0;
  await assert.rejects(env.service.shipTask(other.task.id, { approval: "test" }), (error: unknown) => error instanceof TaskError && error.code === "nothing_to_ship");
  // Discarding is explicit; with nothing unshipped, closing just works.
  await env.service.closeTask(other.task.id, { discard: true });
  assert.equal(env.store.get(other.task.id)!.status, "done");
  const third = await env.service.launchTask(brief({ project: STOREFRONT }), 5_000);
  env.boat.finish(third.task.conversationId!, PREVIEW_REPORT);
  await env.service.sweep();
  env.boat.execResult = (script) => (script.includes("BOAT_AHEAD") ? { exitCode: 0, stdout: "BOAT_AHEAD 0 clean\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
  assert.equal((await env.service.closeTask(third.task.id)).task.status, "done");
});

test("snapshots: dispatch from one, save one, and plain errors for a missing name or the trial", async () => {
  const env = makeService();
  env.boat.limitsValue.maxActiveSandboxes = 10;
  await env.service.launchTask(brief({ project: { ...STOREFRONT, snapshot: "storefront-ready" } }), 5_000);
  assert.equal(env.boat.created.at(-1)!.from, "storefront-ready");
  await env.service.launchTask(brief({ project: { ...STOREFRONT, snapshot: "storefront-ready" }, snapshot: "none" }), 5_000);
  assert.equal(env.boat.created.at(-1)!.from, null);
  await env.service.launchTask(brief({ snapshot: "other" }), 5_000);
  assert.equal(env.boat.created.at(-1)!.from, "other");

  await env.service.saveSnapshot("bx_fake1", "storefront-ready");
  assert.deepEqual((await env.service.snapshots()).snapshots.map((entry) => entry.name), ["storefront-ready"]);
  await assert.rejects(env.service.saveSnapshot("bx_fake1", "has spaces"), (error: unknown) => error instanceof TaskError && error.code === "invalid_value");

  const missing = snapshotError(new BoatError('No saved snapshot "x". Run boat snapshots to list yours.', { code: "snapshot_not_found", status: 404 }), "x");
  assert.equal(missing?.code, "snapshot_not_found");
  assert.match(missing?.hint ?? "", /bb boat sandbox snapshots/);
  const trial = snapshotError(new BoatError("Saved snapshots are not available on the trial plan.", { code: "plan_required", status: 402 }), null);
  assert.equal(trial?.code, "snapshots_unavailable");
  assert.match(trial?.message ?? "", /paid boat plan; the trial doesn't have them/);
  assert.equal(snapshotError(new BoatError("boom", { code: "boat_failed" }), null), null);
  env.boat.snapshotError = new BoatError("Saved snapshots are not available on the trial plan.", { code: "plan_required", status: 402 });
  await assert.rejects(env.service.snapshots(), (error: unknown) => error instanceof TaskError && error.code === "snapshots_unavailable");
});

test("preview states", () => {
  const preview = {
    id: "p_1",
    taskId: "t_1",
    sandboxId: "bx_1",
    port: 3000,
    path: "/",
    command: null,
    url: "https://bx-3000.on.boat.dev?_token=t",
    title: "x",
    health: "up" as const,
    checkedAt: null,
    expiredAt: null,
    createdAt: "",
    updatedAt: "",
  };
  const sandbox = (state: string) => ({ id: "bx_1", name: null, state, health: null, url: null, desktopUrl: null, environment: null, createdAt: null, archiveAfter: "2026-11-05T22:00:00Z", stoppedAt: null, setupStatus: null, error: null });
  assert.equal(previewView(preview, null, sandbox("idle")).state, "live");
  assert.equal(previewView(preview, null, sandbox("idle")).stopsAt, "2026-11-05T22:00:00Z");
  assert.equal(previewView(preview, null, sandbox("stopped")).state, "sleeping");
  assert.equal(previewView({ ...preview, health: "down" }, null, sandbox("idle")).reason, "the server isn't running");
  assert.equal(previewView(preview, null, null).state, "expired");
  assert.equal(previewView({ ...preview, expiredAt: "x" }, null, sandbox("idle")).state, "expired");
  // Without a sandbox list, the last check decides.
  assert.equal(previewView(preview, null, undefined).state, "live");
});
