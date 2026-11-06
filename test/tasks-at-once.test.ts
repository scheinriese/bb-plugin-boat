// Tasks at once before asking (Settings → Orchestrators): when an
// orchestrator checks in with the user before running more tasks at once.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { DEFAULT_PROTOCOL, OLD_TASKS_AT_ONCE_SENTENCE, TASKS_AT_ONCE_PLACEHOLDER } from "../src/default-protocol.ts";
import { tasksAtOnceLine } from "../src/format.ts";
import { ORCHESTRATOR_INSTRUCTIONS, orchestratorInstructions } from "../src/orchestrator.ts";
import { renderSharedProtocol } from "../src/protocol.ts";
import { PLUGIN_SETTINGS } from "../src/settings.ts";
import { DEFAULT_TIERS } from "../src/tiers.ts";
import { createTestHost } from "./fakes.ts";

const fakeBoat = fileURLToPath(new URL("./fixtures/fake-boat.mjs", import.meta.url));

async function host(settings: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "boat-tasks-at-once-"));
  process.env.FAKE_BOAT_STATE = join(dir, "state.json");
  const { bb, harness } = await createTestHost({
    pluginId: "boat",
    settings: { boatPath: fakeBoat, evidenceUploader: "", ...settings },
    agentSkillIds: ["boat", "boat-orchestrator"],
  });
  harness.sdk.stub("threads.get", async () => ({ id: "thr_orch", environmentId: null, deletedAt: null, archivedAt: null }));
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "orchestrator" }));
  harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_1" }));
  await plugin(bb);
  return harness;
}

const orchestratorContext = () => makePluginAgentConfigurationContext({ pluginMetadata: { role: "orchestrator" } });

test("the setting: under Orchestrators, 5 by default, 0 to never ask", () => {
  const spec = PLUGIN_SETTINGS.tasksBeforeAsking;
  assert.equal(spec.section, "orchestrators");
  assert.equal(spec.label, "Tasks at once before asking");
  assert.equal(spec.default, 5);
  assert.match(spec.description, /0: never ask/);
});

test("the orchestrator's instructions name the number, and say so when it never needs to ask", () => {
  assert.match(ORCHESTRATOR_INSTRUCTIONS, /Ask the user before running more than 5 tasks at once, unless they asked for more\./);
  assert.doesNotMatch(ORCHESTRATOR_INSTRUCTIONS, /more than 3 tasks/);
  assert.match(orchestratorInstructions(2), /more than 2 tasks at once/);
  assert.match(orchestratorInstructions(1), /more than 1 task at once/);
  const never = orchestratorInstructions(0);
  assert.doesNotMatch(never, /Ask the user before running more than/);
  assert.match(never, /don't need to ask the user before running several tasks at once/);
  assert.ok(!never.includes("{{"), "no placeholder left");
});

test("a chat's instructions follow the setting, also after it changes", async (t) => {
  const harness = await host({ tasksBeforeAsking: 2 });
  t.after(() => harness.lifecycle.dispose());
  assert.match((await harness.resolveAgentConfiguration(orchestratorContext())).instructions ?? "", /more than 2 tasks at once/);

  const set = await harness.runCli(["config", "set", "tasksBeforeAsking", "0"]);
  assert.equal(set.exitCode, 0, set.stderr);
  // The new value is read in the background right after the change.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const after = (await harness.resolveAgentConfiguration(orchestratorContext())).instructions ?? "";
  assert.match(after, /don't need to ask the user/);
  assert.doesNotMatch(after, /more than \d+ tasks at once/);
});

test("the protocol fills {{tasks-at-once}} from the setting, and older saved copies follow it too", () => {
  assert.ok(DEFAULT_PROTOCOL.includes(TASKS_AT_ONCE_PLACEHOLDER));
  // The sandbox limit stays in the same bullet.
  assert.match(DEFAULT_PROTOCOL, /Don't start more tasks than your sandbox limit has room for; queue the rest/);
  assert.match(renderSharedProtocol(DEFAULT_PROTOCOL, DEFAULT_TIERS), /Ask me before running more than 5 tasks at once, unless I asked for more/);
  const settings = {
    workerMode: "boat" as const,
    agents: "both" as const,
    implementProvider: "claude" as const,
    relay: { enabled: false, preferred: "claude" as const, switchAtPercent: 90, switchBackBelowPercent: 50, quietMinutes: 10 },
    avoidExtraUsage: true,
    autoFailover: true,
    evidenceUploader: "",
  };
  const eight = renderSharedProtocol(DEFAULT_PROTOCOL, DEFAULT_TIERS, { ...settings, tasksBeforeAsking: 8 });
  assert.match(eight, /Ask me before running more than 8 tasks at once/);
  assert.ok(!eight.includes(TASKS_AT_ONCE_PLACEHOLDER));
  const never = renderSharedProtocol(DEFAULT_PROTOCOL, DEFAULT_TIERS, { ...settings, tasksBeforeAsking: 0 });
  assert.match(never, /You don't need to ask me before running several tasks at once/);
  // A protocol saved from the older built-in text still says 3 in its file.
  const saved = `# My protocol\n\n- ${OLD_TASKS_AT_ONCE_SENTENCE}\n`;
  const followed = renderSharedProtocol(saved, DEFAULT_TIERS, { ...settings, tasksBeforeAsking: 4 });
  assert.match(followed, /Ask me before running more than 4 tasks at once/);
  assert.doesNotMatch(followed, /more than 3 tasks/);
});

test("bb boat status and boat_status name it", async (t) => {
  assert.equal(tasksAtOnceLine(5), "Tasks at once before asking: 5 (ask the user before running more than 5 at once)");
  assert.match(tasksAtOnceLine(0), /never ask/);
  const harness = await host({ tasksBeforeAsking: 3 });
  t.after(() => harness.lifecycle.dispose());
  const status = await harness.runCli(["status"]);
  assert.equal(status.exitCode, 0, status.stderr);
  assert.match(status.stdout, /Tasks at once before asking: 3 \(ask the user before running more than 3 at once\)/);
  const json = await harness.runCli(["status", "--json"]);
  assert.equal(JSON.parse(json.stdout).tasksBeforeAsking, 3);
});
