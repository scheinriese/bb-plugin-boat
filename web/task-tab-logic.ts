import type { ChatEventDto, TaskDto } from "../contract.ts";

export interface TaskTranscriptTurn {
  key: string;
  prompt: string | null;
  status: string | null;
  at: number | null;
  content: string[];
  tools: string[];
  errors: string[];
}

/** boat repeats a prompt as its status changes; fold those without losing replies. */
export function groupTaskTranscript(events: readonly ChatEventDto[]): TaskTranscriptTurn[] {
  const turns: TaskTranscriptTurn[] = [];
  const prompts = new Map<number, TaskTranscriptTurn>();
  let current: TaskTranscriptTurn | undefined;
  for (const [index, event] of events.entries()) {
    if (event.type === "prompt") {
      const known = event.timestamp === null ? undefined : prompts.get(event.timestamp);
      if (known) {
        known.status = event.status ?? known.status;
        known.prompt = known.prompt ?? event.content;
        current = known;
      } else {
        current = { key: String(index), prompt: event.content, status: event.status, at: event.timestamp, content: [], tools: [], errors: [] };
        turns.push(current);
        if (event.timestamp !== null) prompts.set(event.timestamp, current);
      }
    }
    if (!current) {
      current = { key: String(index), prompt: null, status: null, at: event.timestamp, content: [], tools: [], errors: [] };
      turns.push(current);
    }
    if (event.type !== "prompt" && event.content?.trim()) current.content.push(event.content);
    current.tools.push(...event.tools);
    if (event.error) current.errors.push(event.error);
    else if (event.type === "usage_limit") current.errors.push("Usage limit reached");
  }
  return turns;
}

export function taskReviews(taskId: string, tasks: readonly TaskDto[]): TaskDto[] {
  return tasks.filter((task) => task.role === "review" && task.parentTaskId === taskId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function transcriptMatches(turn: TaskTranscriptTurn, query: string): boolean {
  return [turn.prompt, ...turn.content, ...turn.tools, ...turn.errors].join("\n").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}
