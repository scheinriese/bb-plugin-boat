// Continue as a chat: the headless conversation as a file, the chat's first
// message, and boat's model ids as bb's.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatEvent } from "../src/boat-api.ts";
import { composeHandoverPrompt } from "../src/briefs.ts";
import { DEFAULT_TIERS, chatChoiceFromBoat } from "../src/tiers.ts";
import { renderBoatTranscript, transcriptPath, wrapLines } from "../src/transcript.ts";

let ts = 0;
const prompt = (promptId: string, status: string, content: string | null = null): ChatEvent => ({
  type: "prompt",
  promptId,
  conversationId: "c_1",
  status,
  content,
  error: null,
  timestamp: ++ts,
  tools: [],
});
const reply = (promptId: string, content: string, tools: string[] = []): ChatEvent => ({
  type: "response",
  promptId,
  conversationId: "c_1",
  status: null,
  content,
  error: null,
  timestamp: ++ts,
  tools,
});
const META = { taskId: "t_1", title: "Fix the header", provider: "claude", model: "opus-5-5", at: "2026-11-06T10:00:00.000Z" };

test("the transcript groups turns by prompt, merges tool steps, and shows errors and usage limits", () => {
  const events: ChatEvent[] = [
    prompt("p1", "queued", "# Implementation task t_1\nFix the header."),
    prompt("p1", "running"),
    reply("p1", "", ["Bash"]),
    reply("p1", "", ["Edit", "Bash"]),
    reply("p1", "I fixed it."),
    prompt("p1", "finished"),
    prompt("p2", "failed", "Add a test."),
    { ...reply("p2", ""), type: "usage_limit", error: "You've hit your limit." },
    { ...prompt("p2", "failed"), error: "harness crashed" },
  ];
  const { text, turns, cut } = renderBoatTranscript(events, META);
  assert.equal(turns, 2);
  assert.equal(cut, 0);
  assert.match(text, /^# Headless conversation of task t_1: Fix the header/);
  assert.match(text, /Agent: claude · opus-5-5\./);
  assert.match(text, /Read the end first/);
  assert.match(text, /## Turn 1 · finished\n\n### Prompt\n# Implementation task t_1\nFix the header\.\n\n### Agent\nTools: Bash, Edit\n\nI fixed it\./);
  assert.match(text, /## Turn 2 · failed[\s\S]*### Usage limit\nYou've hit your limit\.[\s\S]*### Error\nharness crashed/);
  // The index points at the line each turn starts on.
  const lines = text.split("\n");
  const entry = /- Turn 2 · failed · line (\d+): Add a test\./.exec(text);
  assert.ok(entry, text);
  assert.equal(lines[Number(entry[1]) - 1], "## Turn 2 · failed");
  const first = /- Turn 1 · finished · line (\d+):/.exec(text)!;
  assert.equal(lines[Number(first[1]) - 1], "## Turn 1 · finished");
});

test("the transcript drops the oldest turns past the limit, notes boat's cut log, and wraps long lines", () => {
  const events = Array.from({ length: 30 }, (_, index) => [prompt(`p${index}`, "finished", `Prompt ${index}`), reply(`p${index}`, `Reply ${index} ${"x".repeat(2_000)}`)]).flat();
  const { text, turns, cut } = renderBoatTranscript(events, META, 20_000);
  assert.ok(text.length <= 20_000, String(text.length));
  assert.ok(turns >= 1 && turns < 30);
  assert.equal(cut, 30 - turns);
  assert.match(text, new RegExp(`_\\(${cut} earlier turns are left out`));
  assert.match(text, /## Turn 30 · finished/);
  assert.match(text, /Reply 29/);
  assert.ok(text.split("\n").every((line) => line.length <= 1_000));
  // boat kept only the end of a long log: the first event isn't a prompt.
  const tail = renderBoatTranscript([reply("p9", "late reply"), prompt("p10", "finished", "Next"), reply("p10", "ok")], { ...META, expectedTurns: 5 });
  assert.equal(tail.cut, 3);
  assert.match(tail.text, /3 earlier turns are left out/);
  assert.match(tail.text, /## Turn 4 · unknown/);
  // One turn longer than the limit keeps its start and its end.
  const huge = renderBoatTranscript([prompt("p1", "finished", "Start"), reply("p1", `${"a ".repeat(30_000)}THE END`)], META, 10_000);
  assert.ok(huge.text.length <= 10_000, String(huge.text.length));
  assert.match(huge.text, /…\(cut\)…[\s\S]*THE END/);
  assert.equal(wrapLines("word ".repeat(500), 100).split("\n").every((line) => line.length <= 100), true);
});

test("the transcript lives in the sandbox's home, outside every checkout", () => {
  const path = transcriptPath("t_1");
  assert.equal(path, "/home/user/.boat-tasks/t_1/conversation.md");
  for (const checkout of ["/home/user/work/t_1/web", "/home/user/web", "/home/user/work/t_1"]) assert.ok(!path.startsWith(`${checkout}/`));
});

const WORKSPACE = {
  repo: "acme/web",
  repoPath: "/home/user/work/t_1/web",
  branch: "boat/1-fix",
  baseBranch: "main",
  prUrl: null,
  protectedBranches: ["main", "master"],
  delivery: "pr" as const,
};

test("the chat's first message after a move: the conversation's path, the report, the rules, and read-up only", () => {
  const text = composeHandoverPrompt({
    taskId: "t_1",
    role: "implement",
    title: "Fix the header",
    brief: "Fix the header on phones.",
    workspace: WORKSPACE,
    fromProvider: "claude",
    fromThreadId: null,
    why: "from-boat",
    message: null,
    tier: "deep",
    provider: "claude",
    effort: "ultracode",
    evidence: true,
    transcriptPath: "/home/user/.boat-tasks/t_1/conversation.md",
    latestReport: "=== REPORT ===\nSTATUS: partial\n=== END REPORT ===",
    extraInstructions: "Use pnpm.",
  });
  assert.match(text, /^# Continuing task t_1 in a bb chat: Fix the header/);
  assert.match(text, /The headless conversation has stopped/);
  assert.match(text, /`\/home\/user\/\.boat-tasks\/t_1\/conversation\.md`, outside the repo/);
  assert.match(text, /## Latest report\n=== REPORT ===\nSTATUS: partial/);
  assert.match(text, /Checkout: \/home\/user\/work\/t_1\/web/);
  assert.match(text, /## Push rules\n- Never push to `main`, `master`/);
  assert.match(text, /evidence-upload/);
  assert.match(text, /## Original brief\nFix the header on phones\./);
  assert.match(text, /## Standing instructions\nUse pnpm\./);
  // Deep work's mode is for later turns; this one only reads up.
  assert.match(text, /## Working mode \(from the next message on\)\nThis is Deep work: you run with Ultracode on/);
  assert.match(text, /Don't change, commit or push anything in this turn/);
  assert.match(text, /```text\n=== REPORT ===/);
  assert.match(text, /EVIDENCE:/);
  // A review gets its review block and no push rules.
  const review = composeHandoverPrompt({
    taskId: "t_2",
    role: "review",
    title: "Review",
    brief: "Review it.",
    workspace: WORKSPACE,
    fromProvider: "codex",
    fromThreadId: null,
    why: "from-boat",
    message: null,
    transcriptPath: "/home/user/.boat-tasks/t_2/conversation.md",
    latestReport: null,
  });
  assert.match(review, /=== REVIEW ===/);
  assert.match(review, /## Latest report\n\(none yet\)/);
  assert.doesNotMatch(review, /## Push rules/);
  // Later handovers of a moved task still point at the old conversation.
  const later = composeHandoverPrompt({
    taskId: "t_1",
    role: "implement",
    title: "Fix",
    brief: "b",
    workspace: WORKSPACE,
    fromProvider: "claude",
    fromThreadId: "thr_1",
    why: "usage-limit",
    message: null,
    transcriptPath: "/home/user/.boat-tasks/t_1/conversation.md",
  });
  assert.match(later, /that conversation is in `\/home\/user\/\.boat-tasks\/t_1\/conversation\.md`/);
});

test("boat's model ids become bb's for the chat: a tier gets its own back, aliases don't pass", () => {
  // A tier the task still runs: the tier's bb id, and Ultracode back from max.
  assert.deepEqual(chatChoiceFromBoat("claude", "opus-5-5", "xhigh", "build", DEFAULT_TIERS), { model: "claude-opus-5-5", effort: "xhigh", note: null });
  assert.deepEqual(chatChoiceFromBoat("claude", "opus-5-5", "max", "deep", DEFAULT_TIERS), { model: "claude-opus-5-5", effort: "ultracode", note: null });
  assert.deepEqual(chatChoiceFromBoat("codex", "gpt-6.1-sol", "max", "deep", DEFAULT_TIERS), { model: "gpt-6.1-sol", effort: "ultra", note: null });
  // A model picked by hand keeps its effort; a clean id maps to bb's.
  assert.deepEqual(chatChoiceFromBoat("claude", "sonnet-5-5", "high", null, DEFAULT_TIERS), { model: "claude-sonnet-5-5", effort: "high", note: null });
  assert.deepEqual(chatChoiceFromBoat("claude", "opus-5-5", "low", "build", DEFAULT_TIERS), { model: "claude-opus-5-5", effort: "low", note: null });
  // No model: bb's default.
  assert.deepEqual(chatChoiceFromBoat("claude", null, null, null, DEFAULT_TIERS), { model: null, effort: null, note: null });
  // Aliases, boat's default and dated ids: the tier's model, else bb's default, with a note.
  const alias = chatChoiceFromBoat("claude", "opus", "xhigh", "build", DEFAULT_TIERS);
  assert.deepEqual([alias.model, alias.effort], ["claude-opus-5-5", "xhigh"]);
  assert.match(alias.note ?? "", /"opus"/);
  assert.deepEqual(chatChoiceFromBoat("claude", "default", "high", null, DEFAULT_TIERS).model, null);
  assert.equal(chatChoiceFromBoat("claude", "claude-opus-5-5-20261001", "xhigh", null, DEFAULT_TIERS).model, null);
  assert.equal(chatChoiceFromBoat("claude", "gpt-6.1-sol", "xhigh", null, DEFAULT_TIERS).model, null, "another agent's model");
});
