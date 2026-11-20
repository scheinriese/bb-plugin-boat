import assert from "node:assert/strict";
import { test } from "node:test";
import { quotaLine, weeklyPace, type AgentQuota } from "../src/quota.ts";
import { agentsText } from "../src/protocol.ts";
import { defaultSettings } from "./fakes.ts";

const day = 86_400_000;
const start = Date.parse("2026-11-01T00:00:00Z");
const reset = start + 7 * day;
function quota(usedPercent: number, resetsAt = reset): AgentQuota {
  return { provider: "claude", usedPercent, resetsAt: new Date(resetsAt).toISOString(), window: "Weekly limit", weekly: { usedPercent, resetsAt: new Date(resetsAt).toISOString(), windowMinutes: 7 * 24 * 60 } };
}

test("weekly pace advises conservation for early fast burn, keeps sustainable pace, and forgets old/reset windows", () => {
  const early = weeklyPace(quota(45), start + day)!;
  assert.equal(early.conserve, true);
  assert.equal(early.projectedPercent, 315);
  assert.equal(weeklyPace(quota(45), start + 4 * day)!.conserve, false);
  assert.equal(weeklyPace(quota(2, reset + 7 * day), reset + day, early)!.conserve, false);
  assert.equal(weeklyPace(quota(45), reset), null);
  assert.equal(weeklyPace(quota(1), start + 30 * 60_000), null);
  assert.equal(weeklyPace({ ...quota(45), weekly: undefined }, start + day), null);
});

test("weekly pace holds conservation through small reading/reset jitter and clears after sustainable recovery", () => {
  const now = start + 3.5 * day;
  const conserve = weeklyPace(quota(51), now)!;
  assert.equal(conserve.conserve, true);
  const noisy = weeklyPace(quota(49, reset + 60_000), now, conserve)!;
  assert.equal(noisy.conserve, true);
  assert.equal(weeklyPace(quota(47), now, noisy)!.conserve, false);
  assert.equal(weeklyPace(quota(49), now)!.conserve, false);
});

test("pace advice has a visible CLI consumer and protocol preserves explicit task choices and review/orchestration", () => {
  assert.match(quotaLine(quota(45), "claude", start + day), /weekly pace projects 315%.*Codex for flexible implementation.*Claude for orchestration\/reviews/);
  assert.doesNotMatch(quotaLine(quota(45), "claude", start + 4 * day), /pace projects/);
  assert.doesNotMatch(quotaLine({ ...quota(45), provider: "codex" }, "codex", start + day), /pace projects/);
  const protocol = agentsText(defaultSettings());
  assert.match(protocol, /weekly pace advice/);
  assert.match(protocol, /Sustainable pace keeps the preferred agent/);
  assert.match(protocol, /never override an explicitly pinned agent or task-scoped Claude continuation approval/);
});
