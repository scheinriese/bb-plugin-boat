import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
export type NativeRow = Extract<Awaited<ReturnType<PluginBrowserBbSdk["threads"]["timeline"]>>, { rows: unknown[] }>["rows"][number];
export type NativeTurn = Extract<NativeRow, { kind: "turn" }>;
type AssistantRow = Extract<NativeRow, { kind: "conversation" }>;
export interface NativeMilestone {
  id: string;
  at: number;
  message: AssistantRow | null;
  work: Extract<NativeRow, { kind: "work" }>[];
}

/** Recorded assistant messages delimit activity; work before the first stays with it. */
export function nativeMilestones(turn: NativeTurn, children: readonly NativeRow[], messages: readonly NativeRow[]): NativeMilestone[] {
  const unique = new Map<string, NativeRow>();
  for (const row of [...children, ...messages]) if (row.turnId === turn.turnId) unique.set(row.id, row);
  const ordered = [...unique.values()].sort((a, b) => a.sourceSeqStart - b.sourceSeqStart || a.startedAt - b.startedAt);
  const assistants = ordered.filter((row): row is AssistantRow => row.kind === "conversation" && row.role === "assistant" && !!row.text.trim());
  if (!assistants.length) return [{ id: turn.id, at: turn.startedAt, message: null, work: ordered.filter((row) => row.kind === "work") }];
  const result: NativeMilestone[] = assistants.map((message) => ({ id: message.id, at: message.startedAt, message, work: [] }));
  for (const row of ordered) {
    if (row.kind !== "work") continue;
    let index = 0;
    for (let candidate = 1; candidate < assistants.length; candidate++) {
      if (assistants[candidate].sourceSeqStart > row.sourceSeqStart) break;
      index = candidate;
    }
    result[index].work.push(row);
  }
  return result;
}

/** Counts observed commands and distinct paths; test commands are not test cases. */
export function nativeWorkCounts(milestone: NativeMilestone): string {
  const commands = milestone.work.filter((row) => row.workKind === "command");
  const read = new Set(milestone.work.flatMap((row) => row.workKind === "file-read" ? [row.path] : [])).size;
  const edits = new Set(milestone.work.flatMap((row) => row.workKind === "file-change" ? [row.change.path] : [])).size;
  const tests = commands.filter((row) => isTestCommand(row.command)).length;
  const counts = [commands.length ? `ran ${commands.length} command${commands.length === 1 ? "" : "s"}` : null,
    read ? `read ${read} file${read === 1 ? "" : "s"}` : null,
    edits ? `edited ${edits} file${edits === 1 ? "" : "s"}` : null,
    tests ? `${tests} test command${tests === 1 ? "" : "s"}` : null].filter(Boolean);
  return counts.join(" · ") || (milestone.work.length ? `${milestone.work.length} recorded ${milestone.work.length === 1 ? "entry" : "entries"}` : milestone.message ? "1 message" : "");
}

function isTestCommand(command: string): boolean {
  return /^(?:pnpm|npm|yarn|bun|npx)(?:\s+(?:run|exec))?\s+(?:test(?::[\w-]+)?|vitest|jest|playwright|cypress)(?:\s|$)/.test(command.trim());
}
/** A small evidence preview; failures take priority and the full native log remains available. */
export function nativeEvidence(milestone: NativeMilestone): NativeMilestone["work"] {
  const failed = milestone.work.filter((row) => row.status === "error" || (row.workKind === "command" && typeof row.exitCode === "number" && row.exitCode !== 0));
  if (failed.length) return failed.slice(0, 4);
  const test = milestone.work.find((row) => row.workKind === "command" && isTestCommand(row.command));
  const edits = milestone.work.filter((row) => row.workKind === "file-change").slice(0, 2);
  const build = milestone.work.find((row) => row.workKind === "command" && /^(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+build(?:\s|$)/.test(row.command.trim()));
  const selected = [test, ...edits, build].filter((row): row is NativeMilestone["work"][number] => !!row);
  return selected.length ? selected : milestone.work.slice(0, 4);
}

export type NativeEvent = Awaited<ReturnType<PluginBrowserBbSdk["threads"]["events"]["list"]>>[number];
/** Optional authored labels come from public event presentation, keyed to its source sequence. */
export function nativeActivityTitles(events: readonly NativeEvent[]): Map<number, string> {
  const titles = new Map<number, string>();
  for (const event of events) {
    if (event.type !== "item/completed" || event.data.item.type !== "agentMessage") continue;
    const title = event.data.item.presentation?.title?.trim();
    if (title) titles.set(event.seq, title.slice(0, 240));
  }
  return titles;
}
