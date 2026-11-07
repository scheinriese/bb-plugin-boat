import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type Database from "better-sqlite3";
import { TaskStore } from "../src/store.ts";
import { ProjectStore, normalizeProject, toOrchestratorProject } from "../src/projects.ts";
import { projectSnapshotHandlers, snapshotCheckView } from "../src/project-snapshot.ts";
import { readProjectCatalog, validateLocalProjectLink } from "../src/project-catalog.ts";
import { makeService } from "./fakes.ts";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
function projects() { const db = new DatabaseSync(":memory:"); for (const sql of TaskStore.migrations()) db.exec(sql); return new ProjectStore(() => db as unknown as Database.Database); }
const input = { id: "storefront", name: "Storefront", repos: [{ repo: "acme/storefront", baseBranch: "main" }], snapshot: "storefront-ready", reviewer: "claude" as const, localBbProjectId: "proj_demo" };
test("local project link is additive, retains reviewer and is used for orchestrator placement", async () => {
 const store = projects(); const before = store.save(input); assert.equal(before.localBbProjectId, "proj_demo"); assert.equal(before.reviewer, "claude");
 const after = store.save({ id: before.id, name: "Storefront", repos: before.repos }); assert.equal(after.localBbProjectId, "proj_demo"); assert.equal(after.reviewer, "claude"); assert.equal(toOrchestratorProject(after).bbProjectId, "proj_demo");
 assert.equal(normalizeProject({ name: "Old", repos: input.repos }).localBbProjectId, null);
 const bb = { sdk: { projects: { list: async () => [{ id: "proj_demo", name: "Local", gitRemoteUrl: "git@github.com:acme/storefront.git" }] } } } as unknown as Pick<BbPluginApi, "sdk">;
 await validateLocalProjectLink(bb, "proj_demo", "acme/storefront"); await assert.rejects(validateLocalProjectLink(bb, "proj_demo", "acme/other"), /no longer matches/); await assert.rejects(validateLocalProjectLink(bb, "proj_missing", "acme/storefront"), /no longer matches/);
});
test("snapshot check is fresh/headless, deduplicates concurrent and reloaded callers, never snapshots or deletes automatically", async () => {
 let evidenceCalls = 0; const env = makeService({ chat: true, settings: { workerMode: "chat", evidenceUploader: "builtin" }, evidence: { script: async () => { evidenceCalls++; return "echo uploader"; } } }); const store = projects(); store.save(input);
 const runtime = { service: env.service, projects: store, launchWaitMs: 1000, wake: () => {}, changed: () => {} };
 const handlers = projectSnapshotHandlers(runtime); const [a,b] = await Promise.all([handlers.startProjectSnapshot({ projectId: "storefront" }), handlers.startProjectSnapshot({ projectId: "storefront" })]); assert.equal(a.taskId, b.taskId);
 const task = env.service.store.get(a.taskId)!; assert.equal(evidenceCalls, 0, "snapshot checks never install the evidence uploader"); assert.equal(task.runner, "boat"); assert.equal(task.snapshot, null, "explicit none defeats project snapshot fallback"); assert.equal(task.ownsSandbox, true); assert.equal(task.boatProject, "storefront"); assert.match(task.brief, /Don't change any code/); assert.match(task.brief, /Do not install or authenticate bb/); assert.equal(env.boat.savedSnapshots.length, 0); assert.equal(env.boat.calls.some(call => /delete/.test(call)), false);
 const reload = projectSnapshotHandlers(runtime); assert.equal((await reload.startProjectSnapshot({ projectId: "storefront" })).taskId, task.id);
 env.service.store.update(task.id, { status: "idle", result: "STATUS: blocked\nTests failed", finishedAt: new Date().toISOString() }); assert.equal(reload.projectSnapshotCheck({ projectId: "storefront" })?.stage, "failed");
 env.service.store.update(task.id, { result: "STATUS: done\nChecks passed" }); assert.equal(reload.projectSnapshotCheck({ projectId: "storefront" })?.stage, "ready");
 await env.service.saveSnapshot(task.sandboxId!, "storefront-ready"); assert.equal(reload.projectSnapshotCheck({ projectId: "storefront" })?.stage, "saved"); assert.equal(store.get("storefront")!.snapshot, "storefront-ready", "saving a disk never changes project settings");
 env.service.store.update(task.id, { status: "running" }); assert.equal(snapshotCheckView(runtime, env.service.store.get(task.id)!).stage, "checking", "old saved event cannot hide a new running turn");
});
test("catalog returns only configured Boat repos, bounds optional metadata and excludes secrets/paths", async () => {
 const bb = { sdk: { projects: { list: async () => [{ id: "proj_demo", name: "Local", gitRemoteUrl: "https://github.com/acme/storefront" }] }, system: { config: async () => ({ primaryHostId: "host_demo" }) } } } as unknown as Pick<BbPluginApi, "sdk">;
 const boat = { defaultEnvironment: async () => "default", environments: async () => ["default"], environmentInfo: async () => ({ repos: [{ repo: "acme/storefront", baseBranch: "main", permission: "write" }], secretNames: ["PRIVATE"], envContents: "TOKEN=hidden" }) };
 const facts = await readProjectCatalog(bb, boat as never, async () => ({ language: "TypeScript", updatedAt: "2026-11-07T12:00:00Z", baseBranch: "main" })); assert.equal(facts.repos[0]!.language, "TypeScript"); assert.equal(facts.local[0]!.repo, "acme/storefront"); assert.doesNotMatch(JSON.stringify(facts), /TOKEN|PRIVATE|hidden|path/); assert.equal(facts.scope, "configured-boat-repos");
 const partial = await readProjectCatalog(bb, boat as never, async () => { throw new Error("secret auth details"); }); assert.equal(partial.repos[0]!.language, null); assert.doesNotMatch(JSON.stringify(partial), /secret auth/);
});
