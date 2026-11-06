// Back up and restore (`bb boat config export|import` and the settings
// section's RPCs), through the whole plugin in bb's fake host.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import plugin from "../server.ts";
import { createTestHost } from "./fakes.ts";
import { CONFIG_FORMAT, ConfigError, parseConfigText } from "../src/config.ts";
import { ALL_SETTINGS, PLUGIN_SETTINGS, SETTINGS } from "../src/settings.ts";
import { PLUGIN_SETTINGS_KEY } from "../src/settings-store.ts";
import { DEFAULT_TIERS } from "../src/tiers.ts";

const fakeBoat = fileURLToPath(new URL("./fixtures/fake-boat.mjs", import.meta.url));

/** A plugin in a fresh fake bb; `files` stands in for the machine the CLI runs on. */
async function setup(settings: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "boat-config-test-"));
  process.env.FAKE_BOAT_STATE = join(dir, "state.json");
  const { bb, harness } = await createTestHost({
    pluginId: "boat",
    settings: { boatPath: fakeBoat, evidenceUploader: "", ...settings },
    agentSkillIds: ["boat", "boat-orchestrator"],
  });
  const files = new Map<string, string>();
  const writes: { path: string; content: string; mode?: number; hostId?: string }[] = [];
  /** Threads that are archived (an orchestrator that's gone). */
  const archived = new Set<string>();
  harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => ({
    id: threadId,
    environmentId: null,
    deletedAt: null,
    archivedAt: archived.has(threadId) ? 1 : null,
  }));
  harness.sdk.stub("threads.send", async () => ({ ok: true, delivery: "sent" }));
  harness.sdk.stub("threads.updatePluginMetadata", async () => ({ role: "orchestrator" }));
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "orchestrator" }));
  harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_1" }));
  harness.sdk.stub("files.read", async ({ path }: { path: string }) => {
    const content = files.get(path);
    if (content === undefined) throw new Error(`ENOENT: no such file ${path}`);
    return { content, contentEncoding: "utf8", sizeBytes: Buffer.byteLength(content) };
  });
  harness.sdk.stub("files.write", async (args: { path: string; content: string; mode?: number; hostId?: string }) => {
    writes.push(args);
    files.set(args.path, args.content);
    return { ok: true };
  });
  await plugin(bb);
  const cli = async (args: string[], ctx: { threadId?: string; cwd?: string } = { cwd: "/work" }) => harness.runCli(args, ctx);
  const exported = async () => {
    const result = await cli(["config", "export"]);
    assert.equal(result.exitCode, 0, result.stderr);
    return JSON.parse(result.stdout) as Record<string, unknown> & {
      settings: Record<string, unknown>;
      projects: Record<string, unknown>[];
      modelTiers: unknown;
      protocol: { text: string } | null;
    };
  };
  /** Import a file (as JSON text or an object) from /work/backup.json. */
  const importFile = async (content: unknown, flags: string[] = []) => {
    files.set("/work/backup.json", typeof content === "string" ? content : JSON.stringify(content, null, 2));
    return cli(["config", "import", "backup.json", ...flags]);
  };
  return { bb, harness, files, writes, archived, cli, exported, importFile };
}

/** Every setting with a value that isn't its default (the test fails when a setting is added without a value here). */
const EVERY_SETTING = {
  // bb's settings list
  agents: "claude",
  workers: "all",
  environment: "web",
  machineType: "large",
  maxActiveSandboxes: 4,
  implementProvider: "codex",
  reviewProvider: "claude",
  stopIdleAfterMinutes: 45,
  pushNotifications: true,
  workerInstructions: "Run npm test before you push.\nUse conventional commits.",
  // the plugin's own
  evidenceUploader: "acme/tools:scripts/evidence-upload.mjs@0123abc",
  autoFailover: false,
  avoidExtraUsage: false,
  relayEnabled: true,
  relayPreferred: "codex",
  relaySwitchAt: 85,
  relaySwitchBackBelow: 40,
  relayQuietMinutes: 15,
  implementModel: "gpt-6.1-sol",
  reviewModel: "claude-opus-5-5",
  reasoningEffort: "high",
  sidebarLayout: "pinned",
  orchestratorMachineType: "default",
  cloudOrchestratorFullAccess: false,
  sandboxTtlHours: 3,
  freeSlotsWhenFull: false,
  deleteSandboxOnClose: false,
  reviewSandbox: "new",
  extraProtectedBranches: "release, develop",
  boatPath: "~/bin/boat",
};

/**
 * A version 1 backup with every setting that version had, shaped like a real
 * one: task chats for projects only, the relay on at 90 %, a protected
 * branch, a custom uploader and no cap of its own on sandboxes.
 */
const V1_SETTINGS = {
  boatPath: "",
  environment: "",
  machineType: "default",
  orchestratorMachineType: "small",
  workerMode: "chat",
  adhocWorkerMode: "boat",
  sidebarLayout: "sections",
  relayEnabled: true,
  relayPreferred: "claude",
  relaySwitchAt: 90,
  relaySwitchBackBelow: 50,
  relayQuietMinutes: 10,
  avoidExtraUsage: true,
  implementProvider: "claude",
  implementModel: "",
  reviewProvider: "codex",
  reviewModel: "",
  reasoningEffort: "default",
  reviewSandbox: "auto",
  sandboxTtlHours: 2,
  stopIdleAfterMinutes: 30,
  maxActiveSandboxes: 0,
  freeSlotsWhenFull: true,
  deleteSandboxOnClose: true,
  autoFailover: true,
  pushNotifications: true,
  pollIntervalSeconds: 15,
  workerInstructions: "",
  evidenceUploader: "acme/tools:scripts/upload.mjs",
  agents: "both",
  extraProtectedBranches: "staging",
};

const PROJECTS = [
  {
    id: "web",
    name: "Web app",
    repos: [{ repo: "acme/web", baseBranch: "main" }],
    environment: "web",
    snapshot: "web-base",
    protocolPath: "docs/agents/orchestrator.md",
    workerMode: "chat",
    delivery: "push",
    protectedBranches: ["release", "staging"],
    instructions: "Use pnpm, not npm.",
    machineType: "large",
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-20T09:00:00.000Z",
  },
  {
    id: "storefront",
    name: "Storefront and API",
    repos: [
      { repo: "acme/storefront", baseBranch: "master" },
      { repo: "acme/api", baseBranch: "main" },
    ],
    environment: "storefront-api",
    snapshot: null,
    protocolPath: null,
    workerMode: "boat",
    delivery: "pr",
    protectedBranches: [],
    instructions: "",
    machineType: null,
    createdAt: "2026-10-02T09:00:00.000Z",
    updatedAt: "2026-10-02T09:00:00.000Z",
  },
  {
    id: "docs",
    name: "Docs",
    repos: [{ repo: "acme/docs", baseBranch: "develop" }],
    environment: null,
    snapshot: null,
    protocolPath: "AGENTS.md",
    workerMode: "chat",
    delivery: "pr",
    protectedBranches: [],
    instructions: "",
    machineType: null,
    createdAt: "2026-10-03T09:00:00.000Z",
    updatedAt: "2026-10-03T09:00:00.000Z",
  },
];

/** A long custom protocol (~6 KB) with placeholders, Markdown and non-ASCII text. */
function longProtocol(): string {
  const sections = ["Dispatching", "Reviews", "Shipping", "Evidence", "Talking to me", "Limits"];
  const body = sections
    .map(
      (title, index) =>
        `## ${index + 1}. ${title}\n\n` +
        Array.from(
          { length: 6 },
          (_, line) => `- Rule ${index + 1}.${line + 1}: keep briefs short → name the files, the tests and the “done” check; never push to main.`,
        ).join("\n"),
    )
    .join("\n\n");
  const text = `# Orchestrator protocol\n\nYou coordinate cloud workers for me.\n\n{{workers}}\n\n{{agents}}\n\n${body}\n\n## Model tiers\n\n{{model-tiers}}\n\n{{evidence}}\n`;
  return text.length >= 6000 ? text : `${text}\n${"Notes: be brief and concrete. ".repeat(Math.ceil((6000 - text.length) / 30))}\n`;
}

const CUSTOM_TIERS = {
  ...DEFAULT_TIERS,
  build: { claude: { model: "claude-opus-5-5", effort: "high" }, codex: { model: "gpt-6.1-sol", effort: "high" } },
};

function ownerFile() {
  return {
    format: CONFIG_FORMAT,
    version: 2,
    exportedAt: "2026-11-06T10:00:00.000Z",
    settings: EVERY_SETTING,
    projects: PROJECTS,
    modelTiers: CUSTOM_TIERS,
    protocol: { text: longProtocol() },
  };
}

const withoutDates = (projects: Record<string, unknown>[]) => projects.map(({ createdAt: _c, updatedAt: _u, ...rest }) => rest);

test("export: every setting, the projects, tiers and protocol, and nothing else", async (t) => {
  const { harness, cli, exported, writes } = await setup();
  t.after(() => harness.lifecycle.dispose());

  const fresh = await exported();
  assert.deepEqual(Object.keys(fresh).sort(), ["exportedAt", "format", "modelTiers", "projects", "protocol", "settings", "version"]);
  assert.equal(fresh.format, "bb-plugin-boat-config");
  assert.equal(fresh.version, 2);
  // Every setting, bb's list first, then the plugin's own.
  assert.deepEqual(Object.keys(fresh.settings), Object.keys(ALL_SETTINGS));
  assert.deepEqual(Object.keys(fresh.settings).slice(0, Object.keys(SETTINGS).length), Object.keys(SETTINGS));
  assert.equal(fresh.settings.workers, "boat");
  assert.equal(fresh.settings.relayEnabled, false);
  assert.equal(fresh.settings.maxActiveSandboxes, 0, "the test host's own value");
  assert.deepEqual(fresh.projects, []);
  // null: the built-in tiers and protocol.
  assert.equal(fresh.modelTiers, null);
  assert.equal(fresh.protocol, null);

  // --output writes the file on the calling machine, readable only by its owner.
  const saved = await cli(["config", "export", "--output", "backups/boat.json"], { cwd: "/work" });
  assert.equal(saved.exitCode, 0, saved.stderr);
  assert.match(saved.stdout, /^Saved \/work\/backups\/boat\.json: \d+ settings, 0 projects, the built-in model presets, the built-in protocol\. Keep it private\./);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.path, "/work/backups/boat.json");
  assert.equal(writes[0]!.mode, 0o600);
  assert.equal(writes[0]!.hostId, "host_1");
  assert.equal(JSON.parse(writes[0]!.content).format, CONFIG_FORMAT);
});

test("a file with every setting, three projects and a long protocol imports cleanly, and again changes nothing", async (t) => {
  const { harness, exported, importFile } = await setup();
  t.after(() => harness.lifecycle.dispose());
  assert.deepEqual(Object.keys(EVERY_SETTING).sort(), Object.keys(ALL_SETTINGS).sort(), "the fixture covers every setting");
  for (const [key, value] of Object.entries(EVERY_SETTING)) {
    assert.notDeepEqual(value, ALL_SETTINGS[key as keyof typeof ALL_SETTINGS].default, `${key} differs from its default`);
  }
  const file = ownerFile();
  assert.ok(file.protocol.text.length >= 6000 && file.protocol.text.length < 8000, `protocol is ${file.protocol.text.length} characters`);

  const dry = await importFile(file, ["--dry-run"]);
  assert.equal(dry.exitCode, 0, dry.stderr);
  assert.match(dry.stdout, /^Dry run: nothing was changed\. Importing would make \d+ changes:/);
  // Nothing changed yet.
  const before = await exported();
  assert.equal(before.settings.workers, "boat");
  assert.deepEqual(before.projects, []);

  const result = await importFile(file);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /^Imported \d+ changes:/);
  assert.match(result.stdout, /workers: "boat" → "all"/);
  assert.match(result.stdout, /relayEnabled: false → true/);
  assert.match(result.stdout, /extraProtectedBranches: \(empty\) → "release, develop"/);
  assert.match(result.stdout, /evidenceUploader: \(empty\) → "acme\/tools:scripts\/evidence-upload\.mjs@0123abc"/);
  assert.match(result.stdout, /workerInstructions: \(empty\) → "Run npm test before you push\.…" \(2 lines\)/);
  assert.match(result.stdout, /Projects: 3 added, 0 updated, 0 unchanged, 0 removed/);
  assert.match(result.stdout, /Add storefront \(Storefront and API\): acme\/storefront@master \+ acme\/api@main/);
  assert.match(result.stdout, /Model presets: Use the model presets from the file/);
  assert.match(result.stdout, /Protocol: Use the protocol from the file \(\d,\d{3} characters\)/);

  const after = await exported();
  assert.deepEqual(after.settings, EVERY_SETTING);
  assert.deepEqual(withoutDates(after.projects), withoutDates(PROJECTS));
  assert.deepEqual(after.modelTiers, CUSTOM_TIERS);
  assert.equal(after.protocol?.text, file.protocol.text);

  // Importing the same file again: nothing to change.
  const again = await importFile(file);
  assert.equal(again.exitCode, 0, again.stderr);
  assert.match(again.stdout, /^Imported: nothing changed; this bb already matched the file\./);
  assert.match(again.stdout, /Settings: 0 changes, \d+ unchanged/);
  assert.match(again.stdout, /Projects: 0 added, 0 updated, 3 unchanged, 0 removed/);
});

test("a version 1 backup with every old setting imports into today's settings", async (t) => {
  // A fresh install: Sandboxes at once has its real default (3).
  const { bb, harness, exported, importFile, cli } = await setup({ maxActiveSandboxes: undefined });
  t.after(() => harness.lifecycle.dispose());
  assert.equal((await exported()).settings.maxActiveSandboxes, 3);
  const file = { format: CONFIG_FORMAT, version: 1, exportedAt: "2026-11-06T10:00:00.000Z", settings: V1_SETTINGS, projects: PROJECTS, modelTiers: null, protocol: { text: longProtocol() } };

  const dry = await importFile(file, ["--dry-run"]);
  assert.equal(dry.exitCode, 0, dry.stderr);
  assert.match(dry.stdout, /From an older backup: workers from workerMode "chat" and adhocWorkerMode "boat": "projects"/);
  assert.match(dry.stdout, /Ignored, no longer settings: pollIntervalSeconds/);
  // The one setting newer than the file is named, with the value it keeps.
  assert.match(dry.stdout, /Not in the file, stays as it is: cloudOrchestratorFullAccess = true\n/);
  assert.doesNotMatch(dry.stdout, /Skipped, not settings of this version/);

  const result = await importFile(file);
  assert.equal(result.exitCode, 0, result.stderr);
  for (const line of [
    /workers: "boat" → "projects"/,
    /maxActiveSandboxes: 3 → 0/,
    /agents: "auto" → "both"/,
    /pushNotifications: false → true/,
    /evidenceUploader: \(empty\) → "acme\/tools:scripts\/upload\.mjs"/,
    /relayEnabled: false → true/,
    /extraProtectedBranches: \(empty\) → "staging"/,
  ]) {
    assert.match(result.stdout, line);
  }
  assert.doesNotMatch(result.stdout, /relaySwitchAt:/, "90 is already the default");

  // The effective settings are the intended ones: the file's values by today's keys, defaults for the rest.
  const { workerMode: _w, adhocWorkerMode: _a, pollIntervalSeconds: _p, ...rest } = V1_SETTINGS;
  const intended = { ...rest, workers: "projects", cloudOrchestratorFullAccess: true };
  const after = await exported();
  assert.deepEqual(after.settings, Object.fromEntries(Object.keys(ALL_SETTINGS).map((key) => [key, intended[key as keyof typeof intended]])));
  assert.equal(after.version, 2);
  assert.equal(after.protocol?.text, file.protocol.text);
  assert.deepEqual(withoutDates(after.projects), withoutDates(PROJECTS));

  // Each value went where it lives now: the moved ones in the plugin's own storage.
  const own = (await bb.storage.kv.get<Record<string, unknown>>(PLUGIN_SETTINGS_KEY)) ?? {};
  for (const key of ["relayEnabled", "relaySwitchAt", "extraProtectedBranches", "evidenceUploader", "boatPath"]) assert.ok(Object.hasOwn(own, key), key);
  for (const key of ["workers", "maxActiveSandboxes", "agents", "pushNotifications"]) assert.ok(!Object.hasOwn(own, key), key);
  for (const key of Object.keys(own)) assert.ok(Object.hasOwn(PLUGIN_SETTINGS, key), key);
  // And the plugin runs with them.
  const relay = JSON.parse((await cli(["relay", "status", "--json"])).stdout) as { relay: { enabled: boolean; switchAtPercent: number } };
  assert.equal(relay.relay.enabled, true);
  assert.equal(relay.relay.switchAtPercent, 90);
  assert.equal((await cli(["config", "get", "workers"])).stdout.trim(), "projects");

  // The same file again changes nothing.
  const again = await importFile(file);
  assert.match(again.stdout, /^Imported: nothing changed; this bb already matched the file\./);
});

test("version 1: each workerMode pair becomes one workers value; a file with workers keeps it", async (t) => {
  const { harness, importFile, cli } = await setup();
  t.after(() => harness.lifecycle.dispose());
  const workers = async () => (await cli(["config", "get", "workers"])).stdout.trim();
  for (const [workerMode, adhocWorkerMode, expected] of [
    ["chat", "chat", "all"],
    ["boat", "chat", "boat"],
    ["chat", "boat", "projects"],
    ["boat", "boat", "boat"],
  ] as const) {
    const result = await importFile({ format: CONFIG_FORMAT, version: 1, settings: { workerMode, adhocWorkerMode } });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(await workers(), expected, `${workerMode} + ${adhocWorkerMode}`);
  }
  // Only one of the two: the other keeps its current meaning (projects: tasks outside projects run in boat).
  assert.equal((await importFile({ format: CONFIG_FORMAT, version: 1, settings: { workerMode: "chat" } })).exitCode, 0);
  assert.equal(await workers(), "projects");
  assert.equal((await importFile({ format: CONFIG_FORMAT, version: 1, settings: { adhocWorkerMode: "chat" } })).exitCode, 0);
  assert.equal(await workers(), "all");
  // workers wins over the old pair.
  const both = await importFile({ format: CONFIG_FORMAT, version: 2, settings: { workers: "boat", workerMode: "chat" } });
  assert.match(both.stdout, /Ignored, no longer settings: workerMode/);
  assert.equal(await workers(), "boat");
  // A bad old value is refused like any other.
  const bad = await importFile({ format: CONFIG_FORMAT, version: 1, settings: { workerMode: "sometimes" } });
  assert.notEqual(bad.exitCode, 0);
  assert.match(bad.stderr, /Setting workerMode must be one of boat, chat\./);
});

test("an import can't break the rule between Switch at and Switch back below", async (t) => {
  const { harness, importFile, exported } = await setup();
  t.after(() => harness.lifecycle.dispose());
  const refused = await importFile({ format: CONFIG_FORMAT, version: 2, settings: { relaySwitchAt: 60, relaySwitchBackBelow: 58 } });
  assert.notEqual(refused.exitCode, 0);
  assert.match(refused.stderr, /relaySwitchBackBelow \(58\) must be at least 5 below relaySwitchAt \(60\)[^\n]*use 55 or less/);
  assert.equal((await exported()).settings.relaySwitchAt, 90);
  // Both together, in any order, are fine.
  assert.equal((await importFile({ format: CONFIG_FORMAT, version: 2, settings: { relaySwitchBackBelow: 30, relaySwitchAt: 60 } })).exitCode, 0);
  assert.equal((await exported()).settings.relaySwitchAt, 60);
  // Version 1 had no such rule (the plugin lowered the value quietly): the import lowers it and says so.
  const old = await importFile({ format: CONFIG_FORMAT, version: 1, settings: { relaySwitchAt: 50, relaySwitchBackBelow: 50 } });
  assert.equal(old.exitCode, 0, old.stderr);
  assert.match(old.stdout, /relaySwitchBackBelow: 30 → 45/);
  assert.match(old.stdout, /From an older backup: relaySwitchBackBelow lowered from 50 to 45: it must be at least 5 below relaySwitchAt \(50\)/);
  assert.equal((await exported()).settings.relaySwitchBackBelow, 45);
  // Only Switch at in the file: the current Switch back below is lowered the same way.
  const atOnly = await importFile({ format: CONFIG_FORMAT, version: 1, settings: { relaySwitchAt: 40 } });
  assert.equal(atOnly.exitCode, 0, atOnly.stderr);
  assert.match(atOnly.stdout, /relaySwitchBackBelow: 45 → 35/);
  assert.match(atOnly.stdout, /Settings: 2 changes, 0 unchanged/);
});

test("round trip: an export imported into a fresh bb gives the same configuration", async (t) => {
  const source = await setup();
  t.after(() => source.harness.lifecycle.dispose());
  assert.equal((await source.importFile(ownerFile())).exitCode, 0);
  const file = await source.exported();

  const target = await setup();
  t.after(() => target.harness.lifecycle.dispose());
  const imported = await target.importFile(file);
  assert.equal(imported.exitCode, 0, imported.stderr);
  const copy = await target.exported();
  assert.deepEqual(copy.settings, file.settings);
  assert.deepEqual(withoutDates(copy.projects), withoutDates(file.projects));
  assert.deepEqual(copy.modelTiers, file.modelTiers);
  assert.deepEqual(copy.protocol, file.protocol);

  // null in the file brings back the built-in tiers and protocol.
  const builtin = await target.importFile({ ...file, modelTiers: null, protocol: null });
  assert.equal(builtin.exitCode, 0, builtin.stderr);
  assert.match(builtin.stdout, /Model presets: Back to the built-in model presets/);
  assert.match(builtin.stdout, /Protocol: Back to the built-in protocol/);
  const reset = await target.exported();
  assert.equal(reset.modelTiers, null);
  assert.equal(reset.protocol, null);
});

test("unknown settings are reported and skipped; what the file leaves out stays", async (t) => {
  const { harness, exported, importFile } = await setup();
  t.after(() => harness.lifecycle.dispose());
  assert.equal((await importFile(ownerFile())).exitCode, 0);

  const result = await importFile({ format: CONFIG_FORMAT, version: 2, settings: { workers: "boat", someFutureSetting: true, anotherOne: "x" } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /workers: "all" → "boat"/);
  assert.match(result.stdout, /Skipped, not settings of this version: someFutureSetting, anotherOne/);
  // What the file leaves out is named, with the value it keeps (the first few, then a count).
  assert.match(result.stdout, /Not in the file, stay as they are: agents = "claude", environment = "web", .* and \d+ more settings\n/);
  assert.match(result.stdout, /Projects: not in the file/);
  assert.match(result.stdout, /Model presets: Not in the file: unchanged/);
  const after = await exported();
  assert.equal(after.settings.workers, "boat");
  assert.equal(after.settings.relayEnabled, true);
  assert.equal(after.projects.length, 3);
  assert.deepEqual(after.modelTiers, CUSTOM_TIERS);
  assert.ok(after.protocol !== null);
});

test("an invalid file is refused with a clear reason, and nothing changes", async (t) => {
  const { harness, exported, importFile } = await setup();
  t.after(() => harness.lifecycle.dispose());
  const before = await exported();
  const cases: [unknown, RegExp][] = [
    ["{ not json", /The file isn't valid JSON/],
    [{ format: "something-else", version: 1 }, /This isn't a Boat backup: its "format" should be "bb-plugin-boat-config"/],
    [{ format: CONFIG_FORMAT, version: 3 }, /format version 3, and this plugin reads versions up to 2\. Update the plugin first\./],
    [{ format: CONFIG_FORMAT, version: 0 }, /Unknown format version 0\./],
    [
      { format: CONFIG_FORMAT, version: 1, settings: { workerMode: "chat", relaySwitchAt: 500, machineType: "huge", relayEnabled: "yes", evidenceUploader: "s3://bucket" } },
      /Setting relaySwitchAt: [^\n]*\n- Setting machineType must be one of small, default, large, xlarge\.\n- Setting relayEnabled must be true or false\.\n- Setting evidenceUploader: Use builtin, or owner\/repo:path\/to\/script\.mjs \(optionally @commit\)\.(?!\.)/,
    ],
    [
      { format: CONFIG_FORMAT, version: 1, projects: [{ name: "Web app", repos: [{ repo: "not a repo", baseBranch: "main" }] }] },
      /Project "Web app": /,
    ],
    [
      { format: CONFIG_FORMAT, version: 1, projects: [PROJECTS[0], { ...PROJECTS[1], id: "web" }] },
      /the file has two projects with the id "web"/,
    ],
    [{ format: CONFIG_FORMAT, version: 1, projects: [{ name: "No repos", repos: [] }] }, /projects\[0\]\.repos: /],
    [{ format: CONFIG_FORMAT, version: 1, modelTiers: { light: {} } }, /modelTiers\.light\.claude: /],
  ];
  for (const [content, expected] of cases) {
    const result = await importFile(content);
    assert.notEqual(result.exitCode, 0, JSON.stringify(content));
    assert.match(result.stderr, expected);
    // A dry run refuses it the same way.
    const dry = await importFile(content, ["--dry-run"]);
    assert.notEqual(dry.exitCode, 0, JSON.stringify(content));
    assert.match(dry.stderr, expected);
  }
  // Even the valid workerMode (workers) in the refused file wasn't applied.
  assert.deepEqual(await exported().then((file) => ({ ...file, exportedAt: null })), { ...before, exportedAt: null });
  // A missing file is a read error.
  const missing = await harness.runCli(["config", "import", "/nowhere.json"], { cwd: "/work" });
  assert.notEqual(missing.exitCode, 0);
  assert.match(missing.stderr, /Could not read \/nowhere\.json/);
});

test("replacing projects never removes one with open tasks or an open orchestrator", async (t) => {
  const { harness, cli, exported, importFile, archived } = await setup();
  t.after(() => harness.lifecycle.dispose());
  assert.equal((await importFile({ format: CONFIG_FORMAT, version: 1, projects: PROJECTS })).exitCode, 0);
  // storefront: an open orchestrator. docs: its orchestrator is archived, but a task it started is open. web: free.
  assert.equal((await cli(["orchestrator", "on", "--project", "storefront"], { threadId: "thr_store" })).exitCode, 0);
  assert.equal((await cli(["orchestrator", "on", "--project", "docs"], { threadId: "thr_docs" })).exitCode, 0);
  archived.add("thr_docs");
  const started = await cli(["task", "start", "--title", "Fix docs", "--repo", "acme/docs", "--base", "develop", "--brief", "Fix the typo."], { threadId: "thr_docs" });
  assert.equal(started.exitCode, 0, started.stderr);

  const file = { format: CONFIG_FORMAT, version: 1, projects: [{ id: "api", name: "API", repos: [{ repo: "acme/api", baseBranch: "main" }] }] };
  // Merging (the default) keeps them all.
  const merged = await importFile(file, ["--dry-run"]);
  assert.match(merged.stdout, /Not in the file, kept: web, storefront, docs/);

  const replaced = await importFile(file, ["--replace-projects"]);
  assert.equal(replaced.exitCode, 0, replaced.stderr);
  assert.match(replaced.stdout, /Projects: 1 added, 0 updated, 0 unchanged, 1 removed/);
  assert.match(replaced.stdout, /Remove web \(Web app\)/);
  assert.match(replaced.stdout, /Keep storefront \(Storefront and API\): its orchestrator @thread:thr_store is open, so it can't be removed/);
  assert.match(replaced.stdout, /Keep docs \(Docs\): it has 1 open task, so it can't be removed/);
  assert.deepEqual((await exported()).projects.map((project) => project.id).sort(), ["api", "docs", "storefront"]);
});

test("the settings section's RPCs: export, preview (changes nothing) and import", async (t) => {
  const { harness, exported } = await setup();
  t.after(() => harness.lifecycle.dispose());
  const download = (await harness.callRpc("exportConfig", null)) as { fileName: string; text: string };
  assert.match(download.fileName, /^boat-config-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(JSON.parse(download.text).format, CONFIG_FORMAT);

  const text = JSON.stringify(ownerFile());
  const preview = (await harness.callRpc("previewConfigImport", { text, replaceProjects: false })) as {
    problems: string[];
    changes: number;
    sections: { title: string; lines: string[] }[];
  };
  assert.deepEqual(preview.problems, []);
  assert.ok(preview.changes >= Object.keys(ALL_SETTINGS).length);
  assert.match(preview.sections.map((section) => section.title).join("\n"), /Projects: 3 added/);
  assert.deepEqual((await exported()).projects, [], "a preview changes nothing");

  // Problems come back as data, so the dialog can show them.
  const bad = (await harness.callRpc("previewConfigImport", { text: "[]", replaceProjects: false })) as { problems: string[] };
  assert.match(bad.problems[0] ?? "", /This isn't a Boat backup/);
  await assert.rejects(harness.callRpc("importConfig", { text: "[]", replaceProjects: false }), /This isn't a Boat backup/);

  const done = (await harness.callRpc("importConfig", { text, replaceProjects: false })) as { changes: number };
  assert.equal(done.changes, preview.changes);
  assert.equal((await exported()).projects.length, 3);
});

test("parseConfigText: a byte-order mark is fine; problems are listed one per line", () => {
  const parsed = parseConfigText(`\uFEFF${JSON.stringify({ format: CONFIG_FORMAT, version: 1 })}`);
  assert.equal(parsed.version, 1);
  assert.throws(
    () => parseConfigText(JSON.stringify({ format: CONFIG_FORMAT, version: 1, protocol: { text: "x".repeat(100_001) } })),
    (error: unknown) => error instanceof ConfigError && /protocol\.text: The protocol is longer than 100,000 characters\./.test(error.message),
  );
});

test("a project's sandbox size: exported, kept by older files, listed when it changes, refused per project when invalid", async (t) => {
  const { harness, exported, importFile } = await setup();
  t.after(() => harness.lifecycle.dispose());
  assert.equal((await importFile(ownerFile())).exitCode, 0);
  const file = await exported();
  assert.equal(file.version, 2);
  assert.equal(file.projects.find((project) => project.id === "web")?.machineType, "large");

  // An older backup has no size: the project keeps the one it has.
  const older = PROJECTS.map(({ machineType: _size, ...rest }) => rest);
  const kept = await importFile({ format: CONFIG_FORMAT, version: 2, projects: older }, ["--dry-run"]);
  assert.equal(kept.exitCode, 0, kept.stderr);
  assert.match(kept.stdout, /Projects: 0 added, 0 updated, 3 unchanged/);

  // A new size is a change of that field.
  const bigger = PROJECTS.map((project) => (project.id === "docs" ? { ...project, machineType: "small" } : project));
  const changed = await importFile({ format: CONFIG_FORMAT, version: 2, projects: bigger });
  assert.equal(changed.exitCode, 0, changed.stderr);
  assert.match(changed.stdout, /Update docs \(Docs\): machineType/);
  assert.equal((await exported()).projects.find((project) => project.id === "docs")?.machineType, "small");

  // A size this version doesn't know is that project's problem, said plainly; nothing is imported.
  const bad = await importFile({ format: CONFIG_FORMAT, version: 2, projects: [{ ...PROJECTS[0], machineType: "huge" }] });
  assert.notEqual(bad.exitCode, 0);
  assert.match(bad.stderr, /Project "Web app": machineType: /);
  assert.equal((await exported()).projects.find((project) => project.id === "web")?.machineType, "large");
});
