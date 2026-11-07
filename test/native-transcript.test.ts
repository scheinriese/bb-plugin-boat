import { test } from "node:test";
import assert from "node:assert/strict";
import { nativeMilestones, nativeWorkCounts, type NativeRow, type NativeTurn } from "../web/native-transcript.ts";
const turn = { id: "turn", turnId: "t", startedAt: 100, children: [] } as unknown as NativeTurn;
function row(id: string, sequence: number, values: Record<string, unknown>): NativeRow {
  return { id, turnId: "t", sourceSeqStart: sequence, startedAt: sequence * 100, ...values } as NativeRow;
}
const message = (id: string, seq: number, text: string) => row(id, seq, { kind: "conversation", role: "assistant", text });
const command = (id: string, seq: number, text: string) => row(id, seq, { kind: "work", workKind: "command", command: text, exitCode: 0, status: "completed" });
test("native milestones use actual ordered messages and retain work before and after each boundary", () => {
  const plan = message("plan", 2, "Read the cart"); const built = message("built", 6, "Built the drawer");
  const before = command("before", 1, "pwd"); const read = command("read", 3, "cat cart.tsx"); const after = command("after", 7, "pnpm test cart");
  const groups = nativeMilestones(turn, [after, plan, before, read, built], [built, plan, message("other-turn", 8, "Ignore me" )].map((r) => r.id === "other-turn" ? { ...r, turnId: "other" } : r));
  assert.deepEqual(groups.map((g) => ({ id: g.id, at: g.at, work: g.work.map((r) => r.id) })), [
    { id: "plan", at: 200, work: ["before", "read"] }, { id: "built", at: 600, work: ["after"] },
  ]);
});
test("native work counts distinct observed paths and test commands without inventing test case totals", () => {
  const groups = nativeMilestones(turn, [message("m", 1, "Built"), command("c", 2, "pnpm test cart"), command("c2", 3, "echo 'pnpm test'"),
    row("r", 4, { kind: "work", workKind: "file-read", path: "cart.tsx" }), row("r2", 5, { kind: "work", workKind: "file-read", path: "cart.tsx" }),
    row("e", 6, { kind: "work", workKind: "file-change", change: { path: "cart.tsx" } }), row("e2", 7, { kind: "work", workKind: "file-change", change: { path: "cart.tsx" } })], []);
  assert.equal(nativeWorkCounts(groups[0]), "ran 2 commands · read 1 file · edited 1 file · 1 test command");
  assert.equal(nativeWorkCounts(nativeMilestones(turn, [], [message("m", 1, "Ready")])[0]), "1 message");
});
test("a native turn without assistant messages preserves its measured work and original start", () => {
  const groups = nativeMilestones(turn, [command("c", 1, "git status")], []);
  assert.equal(groups[0].at, 100); assert.equal(groups[0].message, null); assert.equal(nativeWorkCounts(groups[0]), "ran 1 command");
});
test("compact evidence retains actual test/edit/build rows and prioritizes failures", async () => {
  const { nativeEvidence } = await import("../web/native-transcript.ts");
  const group = nativeMilestones(turn, [message("m", 1, "Built"), command("test", 2, "pnpm test cart"), command("other", 3, "git status"), command("build", 4, "pnpm build"),
    row("e", 5, { kind: "work", workKind: "file-change", change: { path: "cart.tsx" } })], [])[0];
  assert.deepEqual(nativeEvidence(group).map((r) => r.id), ["test", "e", "build"]);
  group.work.push(row("failed", 6, { kind: "work", workKind: "command", command: "pnpm lint", exitCode: 1, status: "error" }) as typeof group.work[number]);
  assert.deepEqual(nativeEvidence(group).map((r) => r.id), ["failed"]);
});
test("standalone typed work outside a collapsed turn is still assigned to its actual milestone", () => {
  const groups = nativeMilestones(turn, [command("early", 2, "git status")], [message("plan", 1, "Plan"), message("pr", 3, "Opened PR"), command("late", 4, "gh pr view")]);
  assert.deepEqual(groups.map((g) => nativeWorkCounts(g)), ["ran 1 command", "ran 1 command"]);
});
test("authored milestone titles come only from bounded public assistant event presentation", async () => {
  const { nativeActivityTitles } = await import("../web/native-transcript.ts");
  type Event = import("../web/native-transcript.ts").NativeEvent;
  const events = [{ seq: 10, type: "item/completed", data: { item: { type: "agentMessage", text: "Full response", presentation: { title: " Opened PR " } } } },
    { seq: 11, type: "item/completed", data: { item: { type: "commandExecution", presentation: { title: "Not a milestone" } } } },
    { seq: 12, type: "item/completed", data: { item: { type: "agentMessage", text: "No authored label" } } }] as unknown as Event[];
  assert.deepEqual([...nativeActivityTitles(events)], [[10, "Opened PR"]]);
});
