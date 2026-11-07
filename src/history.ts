import { historySourceSchema, reviewPayloadSchema, type HistoryEventDto, type ReviewPayload } from "../contract-fidelity.ts";
import type { Task } from "./store.ts";

export interface EventMetadata {
  source?: HistoryEventDto["source"];
  from?: string; to?: string; cause?: string; detail?: string; decisionId?: string;
  orchestratorThreadId?: string;
  review?: ReviewPayload;
}

/** Only the explicit structured report is parsed; prose never becomes invented findings. */
export function reviewFindings(result: string | null): ReviewPayload["findings"] {
  const json = result?.match(/^\s*FINDINGS:\s*(\[[^\n]*\])\s*$/im)?.[1];
  if (!json || json.length > 50_000) return [];
  try { return reviewPayloadSchema.shape.findings.parse(JSON.parse(json)); } catch { return []; }
}

export function eventMetadata(value: unknown): EventMetadata {
  let parsed = value;
  if (typeof value === "string") { try { parsed = JSON.parse(value); } catch { return {}; } }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const input = parsed as Record<string, unknown>;
  const out: EventMetadata = {};
  const source = historySourceSchema.safeParse(input.source);
  if (source.success) out.source = source.data;
  for (const key of ["from", "to", "cause", "detail", "decisionId", "orchestratorThreadId"] as const) {
    if (typeof input[key] === "string") out[key] = input[key].slice(0, key === "cause" ? 1000 : key === "detail" ? 500 : 200);
  }
  const review = reviewPayloadSchema.safeParse(input.review);
  if (review.success) out.review = review.data;
  return out;
}

/** Raw operational events, commands, credentials and preview URLs never enter the feed. */
export function projectHistoryEvent(row: Record<string, unknown>, task: Task | null): HistoryEventDto | null {
  const rawKind = String(row.kind);
  const rawText = String(row.text);
  const metadata = eventMetadata(row.metadata);
  let kind: HistoryEventDto["kind"] | null = null;
  let text = rawText;
  let to = metadata.to ?? null;
  switch (rawKind) {
    case "created": case "orchestrator-started": kind = "started"; to ??= "working"; break;
    case "turn": kind = "started"; to ??= "working"; break;
    case "finished": kind = "finished"; break;
    case "review":
      if (/^Review t_[\w]+ started\b/.test(rawText)) { kind = "review-started"; to ??= "review"; }
      else if (/^Review t_[\w]+:/.test(rawText)) { kind = "review-verdict"; }
      break;
    case "followup": case "followup-switch": kind = "sent-back"; text = "Sent back for another pass"; to ??= "working"; break;
    case "needs-you": kind = "needs-you"; to ??= "needs-you"; break;
    case "decision-answered": kind = "decision-answered"; break;
    case "decision-withdrawn": kind = "decision-withdrawn"; break;
    case "failed": case "sandbox-stopped": case "cancelled": case "interrupted": case "stopped": kind = "stopped"; to ??= rawKind === "failed" ? "broken" : "stopped"; break;
    case "ready": kind = "ready"; to ??= "ready"; break;
    case "shipped": kind = "shipped"; to ??= "shipped"; break;
    case "merged": kind = "merged"; to ??= "shipped"; break;
    case "provider-changed": kind = "provider-changed"; break;
  }
  if (kind === null) return null;
  return {
    seq: Number(row.seq), kind, at: String(row.at), source: metadata.source ?? "system",
    taskId: task?.id ?? null, taskTitle: task?.title ?? null, threadId: task?.threadId ?? metadata.orchestratorThreadId ?? null,
    orchestratorThreadId: task?.orchestratorThreadId ?? metadata.orchestratorThreadId ?? null,
    provider: metadata.review?.provider ?? task?.provider ?? null,
    from: metadata.from ?? null, to, text: text.slice(0, 4000),
    cause: metadata.cause ?? (rawKind === "failed" || rawKind === "stopped" ? text.slice(0, 1000) : null),
    detail: metadata.detail ?? null,
    decisionId: metadata.decisionId ?? null, review: metadata.review ?? null,
  };
}
