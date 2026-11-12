import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskDto } from "../contract.ts";
import { sandboxPower, taskRecovery } from "../web/recovery-logic.ts";

function task(status: "broken" | "stopped" | "working" | "ready" | "waiting-reset", moving = false): TaskDto {
  return { phase: "failed", error: "Command turn.submit failed", publicStatus: { status, moving, label: status, tone: "neutral", reason: null, needsYou: false } } as TaskDto;
}

test("a failed agent on a connected VM is not offered a sandbox resume", () => {
  const recovery = taskRecovery(task("broken"), "on", false, false)!;
  assert.equal(recovery.message, "Agent stopped · sandbox is still on");
  assert.equal(recovery.action, "follow-up");
  assert.equal(recovery.icon, "AlertCircle");
});

test("a manual turn interruption also leaves its powered VM alone", () => {
  assert.equal(taskRecovery(task("stopped"), "on", false, false)?.action, "follow-up");
  assert.equal(taskRecovery(task("stopped"), "off", false, false), null, "native bb owns paused-machine controls");
});

test("unavailable power is not a claim that work is lost or the VM is stopped", () => {
  for (const power of ["checking", "unavailable"] as const) {
    const recovery = taskRecovery(task("broken"), power, false, false)!;
    assert.equal(recovery.message, "Agent stopped · check the error above");
    assert.equal(recovery.action, "follow-up");
  }
});

test("a usage wait never offers to resume the VM as a way around the limit", () => {
  for (const power of ["on", "unavailable"] as const) {
    const recovery = taskRecovery(task("waiting-reset"), power, false, false)!;
    assert.equal(recovery.message, "Waiting for a reset · work is saved");
    assert.equal(recovery.action, "follow-up");
    assert.equal(recovery.icon, "Clock");
  }
});

test("OOM recovery retains the existing resize eligibility guard", () => {
  assert.equal(taskRecovery(task("broken"), "on", true, true)?.action, "resize");
  assert.equal(taskRecovery(task("broken"), "on", true, false)?.action, "follow-up");
});

test("running or recovered tasks have no stale recovery banner", () => {
  assert.equal(taskRecovery(task("working", true), "on", false, false), null);
  assert.equal(taskRecovery(task("ready"), "on", false, false), null);
  for (const power of ["off", "starting", "stopping", "removed"] as const)
    assert.equal(taskRecovery(task("broken"), power, false, false), null);
});

test("only a connected active host establishes a powered-on sandbox", () => {
  const host = (phase: string, status = "connected") => ({ status, lifecycle: { phase } });
  assert.equal(sandboxPower(host("active")), "on");
  assert.equal(sandboxPower(host("active", "disconnected")), "unavailable");
  assert.equal(sandboxPower(host("suspended", "disconnected")), "off");
  assert.equal(sandboxPower(host("suspending")), "stopping");
  assert.equal(sandboxPower(host("resuming")), "starting");
  assert.equal(sandboxPower(host("creating")), "starting");
  assert.equal(sandboxPower(host("destroyed")), "removed");
  assert.equal(sandboxPower(host("removing")), "removed");
  assert.equal(sandboxPower(host("new-phase")), "unavailable");
  assert.equal(sandboxPower(null), "unavailable");
});

test("an automatic retry after a provider error shows as retrying, not Agent stopped", () => {
  const retrying = { phase: "working", error: null, publicStatus: { status: "working", moving: true, label: "Retrying", tone: "neutral", reason: null, needsYou: false, retrying: true } } as unknown as TaskDto;
  const recovery = taskRecovery(retrying, "on", false, false)!;
  assert.equal(recovery.message, "Retrying automatically · provider error after a steer");
  assert.equal(recovery.action, null);
  assert.equal(recovery.icon, "Loading");
  // A plain running turn still has no banner.
  assert.equal(taskRecovery(task("working", true), "on", false, false), null);
});
