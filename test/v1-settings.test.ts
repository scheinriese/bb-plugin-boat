import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { DECLARED_SETTINGS_KEY, PLUGIN_SETTINGS_KEY, createMigratingSettingsStore, settingRows, type SettingsStore } from "../src/settings-store.ts";
import { SETTINGS } from "../src/settings.ts";
import type { SetupStatusDto } from "../contract.ts";
import { groupedSettings, setupProgress, setupTestPassed } from "../web/v1-settings-logic.ts";
import { makeService } from "./fakes.ts";
import { testTaskInput } from "../src/setup.ts";

test("settings migrate over two generations without losing false, zero, empty or later edits", async (t) => {
  let host = createFakePluginHost({ pluginId: "boat", settings: { agents: "codex", workers: "projects", environment: "", maxActiveSandboxes: 0, pushNotifications: false, machineType: "small" } });
  const { bb } = host;
  t.after(() => host.harness.lifecycle.dispose());
  await bb.storage.kv.set(PLUGIN_SETTINGS_KEY, { avoidExtraUsage: false, orchestratorEffort: "xhigh" });
  const first = await createMigratingSettingsStore(bb);
  assert.equal(first.declaredInPlugin, false);
  assert.equal(first.where("agents"), "bb");
  await first.set({ machineType: "large", pushNotifications: true });
  const expected = await first.get();
  assert.equal(expected.avoidExtraUsage, false);
  assert.equal(expected.maxActiveSandboxes, 0);
  // A legacy host field changed just before the reload must be mirrored too.
  await host.harness.behavior.setSettings({ reviewProvider: "claude" });
  expected.reviewProvider = "claude";
  let next!: SettingsStore;
  host = await host.harness.lifecycle.reload(async (bb) => { next = await createMigratingSettingsStore(bb); });
  assert.equal(next.declaredInPlugin, true);
  assert.equal(next.where("agents"), "plugin");
  assert.deepEqual(await next.get(), expected);
  const rows = settingRows(await next.get(), { onlyAgent: null, declaredInPlugin: true });
  assert.ok(rows.every((row) => row.where === "plugin" && row.section !== null));
  await next.set({ agents: "both", machineType: null, stopIdleAfterMinutes: 0, avoidExtraUsage: true });
  assert.equal((await next.get()).machineType, SETTINGS.machineType.default);
  assert.equal((await next.get()).stopIdleAfterMinutes, 0);
  host = await host.harness.lifecycle.reload(async (bb) => { next = await createMigratingSettingsStore(bb); });
  assert.equal((await next.get()).agents, "both");
  assert.equal((await next.get()).stopIdleAfterMinutes, 0);
  assert.equal((await next.get()).avoidExtraUsage, true);
});

test("corrupt migration data blocks instead of silently replacing choices with defaults", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "boat" });
  t.after(() => harness.lifecycle.dispose());
  await bb.storage.kv.set(DECLARED_SETTINGS_KEY, { agents: "codex" });
  await assert.rejects(createMigratingSettingsStore(bb), /could not be read/);
  assert.deepEqual(await bb.storage.kv.get(DECLARED_SETTINGS_KEY), { agents: "codex" });
});

test("grouped controls include every setting once and notifications have one actual switch", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "boat" });
  t.after(() => harness.lifecycle.dispose());
  const store = await createMigratingSettingsStore(bb);
  const rows = settingRows(await store.get(), { onlyAgent: null });
  const grouped = groupedSettings(rows);
  const all = [...grouped.groups.flatMap((group) => group.rows), ...grouped.advanced];
  assert.equal(new Set(all.map((row) => row.key)).size, rows.length);
  assert.equal(all.length, rows.length);
  assert.deepEqual(grouped.groups.find((group) => group.title === "Notifications")!.rows.map((row) => row.key), ["pushNotifications"]);
});

test("setup progression never treats warnings or unknown checks as passed", () => {
  const check = (id: string, state: string, required = true) => ({ id, state, required, label: id, detail: id });
  const status = { checks: [check("cli", "ok"), check("signed-in", "ok"), check("plan", "warning"), check("agents", "unknown"), check("github", "optional", false), check("environment", "missing")] } as SetupStatusDto;
  const progress = setupProgress(status);
  assert.deepEqual(progress.complete.map((check) => check.id), ["cli", "signed-in", "github"]);
  assert.equal(progress.current!.id, "plan");
  status.checks[2]!.state = "ok";
  status.checks[3]!.state = "ok";
  assert.equal(setupProgress(status).current!.id, "environment", "a required extra check still has a single visible fix");
});

test("an idle test task needs a passing report before setup claims All set", () => {
  assert.equal(setupTestPassed({ status: "idle", error: null, reportStatus: "blocked" }), false);
  assert.equal(setupTestPassed({ status: "idle", error: null, reportStatus: null }), false);
  assert.equal(setupTestPassed({ status: "idle", error: null, reportStatus: "done" }), true);
});

test("setup receipt survives the board's recent-history limit and newer failures replace it", async () => {
  const env = makeService();
  const task = (await env.service.launchTask(testTaskInput(null), 5_000)).task;
  env.store.update(task.id, { status: "done", result: "=== REPORT ===\nSTATUS: done\n=== END REPORT ===" });
  for (let i = 0; i < 25; i++) env.store.insert({ ...task, id: `t_later${i}`, title: "Ordinary task", status: "done" });
  assert.equal(env.store.latestSetupTest()!.id, task.id);
  env.store.insert({ ...task, id: "t_new_test", status: "failed", error: "Agent could not sign in" });
  assert.equal(env.store.latestSetupTest()!.id, "t_new_test");
});
