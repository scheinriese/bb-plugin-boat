import assert from "node:assert/strict";
import { test } from "node:test";
import type { SandboxDto, TaskDto } from "../contract.ts";
import { sandboxFailure, sandboxPrimaryTask } from "../web/sandboxes-logic.ts";

const sandbox = (patch: Partial<SandboxDto> = {}) => ({ id: "bx_demo", state: "stopped", health: "ok", uses: [], ...patch }) as SandboxDto;
const task = (patch: Partial<TaskDto> = {}) => ({ id: "t_demo", sandboxId: "bx_demo", status: "idle", error: null, ...patch }) as TaskDto;

test("idle-stopped sandboxes never become footer error exceptions", () => {
  assert.equal(sandboxFailure(sandbox(), [task()]), null);
  assert.equal(sandboxFailure(sandbox(), [task({ status: "cancelled" })]), null);
  assert.equal(sandboxFailure(sandbox({ health: "unknown" }), []), null);
  assert.equal(sandboxFailure(sandbox(), [task({ publicStatus: { status: "stopped", label: "Stopped", tone: "neutral", reason: "Idle stop", needsYou: false, moving: false } })]), null);
});

test("recorded task causes and sandbox health failures retain a concrete reason", () => {
  assert.equal(sandboxFailure(sandbox(), [task({ status: "failed", error: "Out of memory" })])?.reason, "Out of memory");
  assert.equal(sandboxFailure(sandbox({ state: "error" }), [])?.reason, "Sandbox error");
  assert.equal(sandboxFailure(sandbox({ health: "unhealthy" }), [])?.reason, "Sandbox health: unhealthy");
  assert.equal(sandboxFailure(sandbox(), [task({ sandboxId: "different", status: "failed", error: "Unrelated failure" })]), null);
});

test("a sandbox's active chat wins over an old closed task sharing the machine", () => {
  const old = task({ id: "old", status: "done", threadId: "thr_old" });
  const current = task({ id: "current", threadId: "thr_current" });
  const used = sandbox({ uses: [{ id: "thr_current", kind: "chat", title: "Current chat", open: true }] });
  assert.equal(sandboxPrimaryTask(used, [old, current])?.id, "current");
  assert.equal(sandboxPrimaryTask(used, [old]), null);
  assert.equal(sandboxPrimaryTask(sandbox(), [old, current])?.id, "current");
});
