import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { makeService } from "./fakes.ts";
import { strictTeamSpawn } from "./team-spawn.ts";
import {
  createTeamRuntime,
  describeTeamSetupError,
} from "../src/team/runtime.ts";
import type { Runtime } from "../src/runtime.ts";
import type { TeamState } from "../contract-team.ts";
function setup(t: { after(fn: () => unknown): void }) {
  const env = makeService();
  const { bb, harness } = createFakePluginHost({ pluginId: "boat" });
  t.after(() => harness.lifecycle.dispose());
  harness.sdk.stub("system.uiPreferences.list", async () => ({
    preferences: {},
  }));
  harness.sdk.stub("threads.get", async ({ threadId }) => ({
    id: threadId,
    projectId: "proj_personal",
  }));
  const runtime = {
    bb,
    service: env.service,
    changed() {},
  } as unknown as Runtime;
  const team = createTeamRuntime(runtime);
  runtime.team = team;
  return { team, bb, harness };
}
test("strict fake rejects the same empty spawn input as real bb", async (t) => {
  const { bb, harness } = setup(t);
  harness.sdk.stub(
    "threads.spawn",
    strictTeamSpawn(async () => ({ thread: { id: "home" } })),
  );
  await assert.rejects(
    () =>
      bb.sdk.threads.spawn({
        projectId: "personal",
        input: [],
        environment: { type: "host", workspace: { type: "personal" } },
      }),
    /input must contain at least one entry/,
  );
});
test("enable remains off during bootstrap, uses a labelled plugin input and adopts once", async (t) => {
  const { team, harness } = setup(t);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const spawning = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  harness.sdk.stub(
    "threads.spawn",
    strictTeamSpawn(async (args) => {
      calls++;
      assert.equal(args.projectId, "proj_personal");
      assert.equal(args.origin, "plugin");
      assert.equal(args.originPluginId, "boat");
      assert.equal(args.input?.length, 1);
      const input = args.input![0];
      assert.equal(input.type, "text");
      if (input.type === "text") {
        assert.ok(input.text.length < 300);
        assert.match(input.text, /\[team · setup\]/);
        assert.match(input.text, /not a user request/);
      }
      started();
      await held;
      return { thread: { id: "home-chief" } };
    }),
  );
  const enabled = harness.behavior.callRpc("teamSave", { enabled: true });
  await spawning;
  assert.equal(team.engine.enabled(), false);
  const pending = (await harness.behavior.callRpc(
    "teamState",
    null,
  )) as TeamState;
  assert.equal(pending.enabled, false);
  assert.equal(pending.members[0].homeThreadId, null);
  release();
  await enabled;
  assert.equal(team.engine.enabled(), true);
  assert.equal(team.engine.chief()?.homeThreadId, "home-chief");
  await harness.behavior.callRpc("teamSave", { enabled: true });
  assert.equal(calls, 1);
});
test("bootstrap failure rolls back enable, exposes a clear error and retries without duplicate chiefs", async (t) => {
  const { team, harness } = setup(t);
  let attempts = 0;
  harness.sdk.stub(
    "threads.spawn",
    strictTeamSpawn(async () => {
      if (++attempts === 1) throw new Error("Connection lost");
      return { thread: { id: "home-retry" } };
    }),
  );
  await assert.rejects(
    () => harness.behavior.callRpc("teamSave", { enabled: true }),
    /Couldn't enable Team.*try again/,
  );
  const failed = (await harness.behavior.callRpc(
    "teamState",
    null,
  )) as TeamState;
  assert.equal(failed.enabled, false);
  assert.equal(failed.members[0].homeThreadId, null);
  assert.equal(team.engine.sidebar(), undefined);
  for (let i = 0; i < 3; i++) {
    await team.settle();
    await harness.behavior.callRpc("teamState", null);
  }
  assert.equal(attempts, 1);
  // Even a stale enabled flag after reload must not restart a failed bootstrap.
  team.engine.store.saveSetting("enabled", true);
  await team.prepare();
  assert.equal(team.engine.enabled(), false);
  assert.equal(attempts, 1);
  await harness.behavior.callRpc("teamSave", { enabled: true });
  assert.equal(team.engine.enabled(), true);
  assert.equal(team.engine.chief()?.homeThreadId, "home-retry");
  assert.equal(
    team.engine.store.list("member").filter((m) => m.kind === "lead").length,
    1,
  );
  assert.equal(attempts, 2);
});
test("retry repairs the half-enabled state from an older failed installation", async (t) => {
  const { team, harness } = setup(t);
  team.engine.enable();
  harness.sdk.stub(
    "threads.spawn",
    strictTeamSpawn(async () => {
      throw new Error("Offline");
    }),
  );
  await assert.rejects(() =>
    harness.behavior.callRpc("teamSave", { enabled: true }),
  );
  assert.equal(team.engine.enabled(), false);
  harness.sdk.stub(
    "threads.spawn",
    strictTeamSpawn(async () => ({ thread: { id: "home-recovered" } })),
  );
  await harness.behavior.callRpc("teamSave", { enabled: true });
  assert.equal(team.engine.chief()?.homeThreadId, "home-recovered");
  assert.equal(team.engine.enabled(), true);
});
test("simultaneous enables serialize and create only one home", async (t) => {
  const { team, harness } = setup(t);
  let calls = 0;
  harness.sdk.stub(
    "threads.spawn",
    strictTeamSpawn(async () => {
      calls++;
      return { thread: { id: "home-once" } };
    }),
  );
  await Promise.all([
    harness.behavior.callRpc("teamSave", { enabled: true }),
    harness.behavior.callRpc("teamSave", { enabled: true }),
  ]);
  assert.equal(calls, 1);
  assert.equal(team.engine.enabled(), true);
});

test("setup diagnostics retain wrapped cause messages and codes", () => {
  const root = Object.assign(new Error("HTTP 404: Project not found"), {
    code: "project_not_found",
    status: 404,
  });
  const error = new Error("Couldn't enable Team", { cause: root });
  const log = describeTeamSetupError(error);
  assert.match(log, /Couldn't enable Team/);
  assert.match(log, /HTTP 404: Project not found/);
  assert.match(log, /code=project_not_found/);
  assert.match(log, /status=404/);
});
