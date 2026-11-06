// Continue as a chat: the headless (boat) conversation so far, as a Markdown
// file the new chat reads first. It holds prompts, the agent's messages and
// the names of the tools it used; boat's log has no tool output or diffs.
import type { ChatEvent } from "./boat-api.ts";

/** About 30k tokens: room to read it in a turn that only reads up. */
export const TRANSCRIPT_LIMIT = 120_000;
/** Agents' file readers cut very long lines; replies are often one long paragraph. */
const LINE_LIMIT = 1_000;

/** Where a moved task's files go: the sandbox's home, outside every checkout (/home/user/work/… or /home/user/<repo>). */
export function transcriptDir(taskId: string): string {
  return `/home/user/.boat-tasks/${taskId}`;
}

export function transcriptPath(taskId: string): string {
  return `${transcriptDir(taskId)}/conversation.md`;
}

interface Turn {
  promptId: string | null;
  status: string | null;
  prompt: string | null;
  /** Replies, tool lines and errors, in order. */
  parts: { kind: "reply" | "tools" | "error" | "limit"; text: string }[];
}

/** Hard-wrap long lines (at a space when there's one near the limit). */
export function wrapLines(text: string, limit = LINE_LIMIT): string {
  return text
    .split("\n")
    .flatMap((line) => {
      const out: string[] = [];
      let rest = line;
      while (rest.length > limit) {
        const space = rest.lastIndexOf(" ", limit);
        const at = space > limit * 0.6 ? space : limit;
        out.push(rest.slice(0, at));
        rest = rest.slice(at).replace(/^ /, "");
      }
      out.push(rest);
      return out;
    })
    .join("\n");
}

function group(events: readonly ChatEvent[]): Turn[] {
  const turns: Turn[] = [];
  const byPrompt = new Map<string, Turn>();
  const turnFor = (promptId: string | null): Turn => {
    if (promptId !== null) {
      const known = byPrompt.get(promptId);
      if (known) return known;
    } else if (turns.length > 0) {
      return turns.at(-1)!;
    }
    const turn: Turn = { promptId, status: null, prompt: null, parts: [] };
    turns.push(turn);
    if (promptId !== null) byPrompt.set(promptId, turn);
    return turn;
  };
  for (const event of events) {
    const turn = turnFor(event.promptId);
    if (event.type === "prompt") {
      // boat re-emits a prompt as its status changes; the last status wins.
      turn.status = event.status ?? turn.status;
      if (event.content && event.content.trim() !== "" && turn.prompt === null) turn.prompt = event.content.trim();
      if (event.error) turn.parts.push({ kind: "error", text: event.error });
      continue;
    }
    if (event.type === "usage_limit") {
      turn.parts.push({ kind: "limit", text: event.error ?? event.content ?? "Usage limit reached." });
      continue;
    }
    if (event.tools.length > 0) {
      const last = turn.parts.at(-1);
      if (last?.kind === "tools") last.text = [...new Set([...last.text.split(", "), ...event.tools])].join(", ");
      else turn.parts.push({ kind: "tools", text: event.tools.join(", ") });
    }
    if (event.content && event.content.trim() !== "") turn.parts.push({ kind: "reply", text: event.content.trim() });
    if (event.error) turn.parts.push({ kind: "error", text: event.error });
  }
  return turns;
}

function renderTurn(turn: Turn, index: number): string {
  const lines = [`## Turn ${index} · ${turn.status ?? "unknown"}`, "", "### Prompt", turn.prompt ?? "(boat's log doesn't have this prompt's text)", ""];
  let inAgent = false;
  for (const part of turn.parts) {
    if (part.kind === "reply" || part.kind === "tools") {
      if (!inAgent) lines.push("### Agent");
      inAgent = true;
      lines.push(part.kind === "tools" ? `Tools: ${part.text}` : part.text, "");
    } else {
      inAgent = false;
      lines.push(part.kind === "error" ? "### Error" : "### Usage limit", part.text, "");
    }
  }
  return wrapLines(lines.join("\n").trimEnd());
}

function oneLine(text: string | null, max = 100): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (flat === "") return "(no prompt text)";
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * The conversation as Markdown: a header, a one-line-per-turn index (with the
 * line each turn starts on), then the turns, oldest first. Over the limit,
 * the oldest turns go first (the last one always stays).
 */
export function renderBoatTranscript(
  events: readonly ChatEvent[],
  meta: { taskId: string; title: string; provider: string; model: string | null; at: string; expectedTurns?: number },
  limit = TRANSCRIPT_LIMIT,
): { text: string; turns: number; cut: number } {
  const all = group(events);
  // boat keeps only the end of a long log: the first turns may be gone.
  const startsCut = events.length > 0 && events[0]!.type !== "prompt";
  const missing = Math.max(meta.expectedTurns !== undefined ? meta.expectedTurns - all.length : 0, startsCut ? 1 : 0);
  let rendered = all.map((turn, index) => renderTurn(turn, index + 1 + missing));
  let kept = all;
  const head = (cut: number, index: string[]) =>
    [
      `# Headless conversation of task ${meta.taskId}: ${oneLine(meta.title, 200)}`,
      "",
      `Agent: ${meta.provider}${meta.model ? ` · ${meta.model}` : ""}. Written ${meta.at}, when the task moved to a bb chat. It has the prompts (from the plugin, the orchestrator or the user), the agent's messages, and only the names of the tools it used: no tool output or diffs.`,
      "Read the end first: the newest turns are last. The index says where each turn starts.",
      ...(cut > 0 ? ["", `_(${cut} earlier ${cut === 1 ? "turn is" : "turns are"} left out: the conversation was too long, or boat's log no longer has ${cut === 1 ? "it" : "them"}. Your first message has the brief.)_`] : []),
      "",
      "## Index",
      ...index,
      "",
    ].join("\n");
  const build = (cut: number) => {
    // Line numbers need the header's length, which needs the index: two passes.
    const draft = head(cut, rendered.map(() => "-"));
    let line = draft.split("\n").length + 1;
    const index = kept.map((turn, i) => {
      const entry = `- Turn ${i + 1 + missing + (all.length - kept.length)} · ${turn.status ?? "unknown"} · line ${line}: ${oneLine(turn.prompt)}`;
      line += rendered[i]!.split("\n").length + 1;
      return entry;
    });
    return `${head(cut, index)}\n${rendered.join("\n\n")}\n`;
  };
  let text = build(missing);
  while (text.length > limit && kept.length > 1) {
    kept = kept.slice(1);
    rendered = rendered.slice(1);
    text = build(missing + (all.length - kept.length));
  }
  if (text.length > limit && rendered.length === 1) {
    // One turn longer than the limit: keep its start and its end.
    const only = rendered[0]!;
    const room = Math.max(1_000, limit - (text.length - only.length) - 100);
    rendered = [`${only.slice(0, Math.floor(room / 4))}\n\n…(cut)…\n\n${only.slice(only.length - Math.floor((room * 3) / 4))}`];
    text = build(missing + (all.length - kept.length));
  }
  return { text, turns: kept.length, cut: missing + (all.length - kept.length) };
}
