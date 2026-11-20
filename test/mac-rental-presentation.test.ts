import assert from "node:assert/strict";
import { test } from "node:test";
import type { OwnMacNotice } from "../contract-ownmac.ts";
import type { Task } from "../src/store.ts";
import { awaitsMacRentalChoice } from "../src/rpc.ts";
const task: Pick<Task, "status" | "turns" | "sandboxId" | "hostId"> = { status: "failed", turns: 0, sandboxId: null, hostId: null };
const notice: OwnMacNotice = {
  taskId: "fake-task", title: "Test the sample app", reason: "unavailable", alias: "",
  offers: [], unavailable: [{ provider: "fake", label: "Fake Mac", reason: "No capacity" }],
};
test("an unavailable-only rental request still waits for the owner", () => {
  assert.equal(awaitsMacRentalChoice(task, notice), true);
  assert.equal(awaitsMacRentalChoice(task, { ...notice, answer: "wait" }), true);
  assert.equal(awaitsMacRentalChoice(task, null), false);
  assert.equal(awaitsMacRentalChoice(task, { ...notice, offers: undefined }), false);
});
test("started, cancelled, pinned and ambiguous requests are not offered as fresh rental choices", () => {
  for (const patch of [{ turns: 1 }, { sandboxId: "fake-machine" }, { hostId: "fake-host" }, { status: "cancelled" as const }, { status: "starting" as const }, { status: "done" as const }]) {
    assert.equal(awaitsMacRentalChoice({ ...task, ...patch }, notice), false, JSON.stringify(patch));
  }
  assert.equal(awaitsMacRentalChoice(task, { ...notice, answer: "rent", replacementId: "fake-replacement" }), false);
  assert.equal(awaitsMacRentalChoice(task, { ...notice, answer: "failed" }), false);
  assert.equal(awaitsMacRentalChoice(task, { ...notice, answer: "failed", replacementId: "fake-replacement" }), false);
});
