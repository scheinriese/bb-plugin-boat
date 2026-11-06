// Account-level UI state: the orchestrator card's Hide holds on every device
// (the plugin's storage, over RPC), and isn't a setting or part of backups.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import plugin from "../server.ts";
import { UI_TAG } from "../contract.ts";
import { UI_STATE_KEY, readUiState, saveUiState } from "../src/ui-state.ts";
import { cardHiddenToast, cardShownToast } from "../web/logic.ts";
import { createTestHost } from "./fakes.ts";

function memoryKv(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial));
  return {
    values,
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async set(key: string, value: unknown) {
      values.set(key, value);
    },
  };
}

test("the UI state: defaults, what was saved, and nothing it doesn't accept", async () => {
  assert.deepEqual(await readUiState(memoryKv()), { hideOrchestratorCard: false });
  assert.deepEqual(await readUiState(memoryKv({ [UI_STATE_KEY]: "junk" })), { hideOrchestratorCard: false });
  assert.deepEqual(await readUiState(memoryKv({ [UI_STATE_KEY]: { hideOrchestratorCard: "yes", later: 1 } })), { hideOrchestratorCard: false });
  // A kv that can't be read: the defaults (the card shows).
  assert.deepEqual(await readUiState({ get: async () => Promise.reject(new Error("locked")) }), { hideOrchestratorCard: false });

  const kv = memoryKv();
  assert.deepEqual(await saveUiState(kv, { hideOrchestratorCard: true }), { hideOrchestratorCard: true });
  assert.deepEqual(kv.values.get(UI_STATE_KEY), { hideOrchestratorCard: true });
  assert.deepEqual(await readUiState(kv), { hideOrchestratorCard: true });
  // An empty change keeps what's there.
  assert.deepEqual(await saveUiState(kv, {}), { hideOrchestratorCard: true });
  await assert.rejects(saveUiState(kv, { hideOrchestratorCard: "no" as unknown as boolean }));
  assert.deepEqual(await saveUiState(kv, { hideOrchestratorCard: false }), { hideOrchestratorCard: false });
});

test("Hide and Show again go through the RPC, refresh open pages, and stay out of settings and backups", async (t) => {
  const fakeBoat = fileURLToPath(new URL("./fixtures/fake-boat.mjs", import.meta.url));
  process.env.FAKE_BOAT_STATE = join(mkdtempSync(join(tmpdir(), "boat-ui-state-test-")), "state.json");
  const { bb, harness } = await createTestHost({ pluginId: "boat", settings: { boatPath: fakeBoat, evidenceUploader: "" }, agentSkillIds: ["boat", "boat-orchestrator"] });
  t.after(async () => {
    await harness.lifecycle.dispose();
  });
  await plugin(bb);

  assert.deepEqual(await harness.callRpc("uiState", null), { hideOrchestratorCard: false });
  const before = harness.inspection.experimental_rpcInvalidations.length;
  assert.deepEqual(await harness.callRpc("saveUiState", { hideOrchestratorCard: true }), { hideOrchestratorCard: true });
  // Every open Cloud agents page and Settings page reads it again.
  assert.ok(
    harness.inspection.experimental_rpcInvalidations.slice(before).some((tags) => tags?.includes(UI_TAG)),
    JSON.stringify(harness.inspection.experimental_rpcInvalidations.slice(before)),
  );
  // Kept in the plugin's storage: every device sees it.
  assert.deepEqual(await bb.storage.kv.get(UI_STATE_KEY), { hideOrchestratorCard: true });
  assert.deepEqual(await harness.callRpc("uiState", null), { hideOrchestratorCard: true });
  await assert.rejects(harness.callRpc("saveUiState", { hideOrchestratorCard: "yes" }), /validation failed/);

  // Not a setting, and not in a backup.
  const settings = (await harness.callRpc("settings", null)) as { settings: { key: string }[] };
  assert.ok(!settings.settings.some((row) => /orchestratorcard|uistate/i.test(row.key)));
  const exported = (await harness.callRpc("exportConfig", null)) as { text: string };
  assert.doesNotMatch(exported.text, /hideOrchestratorCard|uiState/);

  // Show the orchestrator card again (Settings → Orchestrators).
  assert.deepEqual(await harness.callRpc("saveUiState", { hideOrchestratorCard: false }), { hideOrchestratorCard: false });
  assert.deepEqual(await harness.callRpc("uiState", null), { hideOrchestratorCard: false });
});

test("the card's toasts name the card and the Settings button, and promise it on the page only when it shows there", () => {
  // After ×: what was hidden, and the Settings button in its own words.
  const hidden = cardHiddenToast();
  assert.match(hidden.title, /^Orchestrator card hidden\./);
  assert.equal(hidden.description, "Show the orchestrator card again in Settings → Plugins → Boat Cloud Agents → Orchestrators.");
  // After Show again: back on the page only with no orchestrator (the page shows it only then).
  assert.deepEqual(cardShownToast(false), { title: "The orchestrator card is back on the Cloud agents page", description: null });
  const withOne = cardShownToast(true);
  assert.doesNotMatch(withOne.title, /back on the Cloud agents page/);
  assert.equal(withOne.description, "The Cloud agents page shows it while you have no orchestrator.");
});
