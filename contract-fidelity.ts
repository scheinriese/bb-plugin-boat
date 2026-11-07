// Additive data contracts. Safe to import in the app: no server dependencies.
import { z } from "zod";

export const compactTitleSchema = z.string().trim().min(1).max(120);

export const decisionOptionSchema = z.object({
  label: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(500).optional(),
  facts: z.record(z.string().min(1).max(80), z.union([z.string().max(300), z.number().finite(), z.boolean(), z.null()])).refine((facts) => Object.keys(facts).length <= 8, "Use at most 8 fact columns").optional(),
  verdict: z.object({ label: z.string().trim().max(100).optional(), text: z.string().trim().min(1).max(200), tone: z.enum(["good", "caution", "bad"]) }).optional(),
  recommended: z.boolean().optional(),
});
export const decisionOptionInputSchema = z.union([z.string().trim().min(1).max(200), decisionOptionSchema]);
export type DecisionOption = z.infer<typeof decisionOptionSchema>;
export type DecisionOptionInput = z.infer<typeof decisionOptionInputSchema>;

/** Tolerates old rows and damaged JSON without changing their IDs or string API. */
export function normalizeDecisionOptions(value: unknown): DecisionOption[] {
  let entries = value;
  if (typeof entries === "string") { try { entries = JSON.parse(entries); } catch { return []; } }
  if (!Array.isArray(entries)) return [];
  return entries.slice(0, 50).flatMap((entry) => {
    const result = decisionOptionInputSchema.safeParse(entry);
    return result.success ? [typeof result.data === "string" ? { label: result.data } : result.data] : [];
  });
}

export const findingSchema = z.object({
  severity: z.enum(["must-fix", "should"]),
  label: z.string().trim().max(100).optional(),
  text: z.string().trim().min(1).max(2000),
  file: z.string().max(300).optional(),
  line: z.number().int().positive().optional(),
});
export const reviewPayloadSchema = z.object({
  reviewTaskId: z.string(), round: z.number().int().positive(),
  provider: z.enum(["claude", "codex"]), model: z.string().nullable(),
  freshContext: z.boolean(), verdict: z.string().max(100).nullable(),
  findings: z.array(findingSchema).max(20),
});
export type ReviewPayload = z.infer<typeof reviewPayloadSchema>;

export const HISTORY_KINDS = ["started", "finished", "review-started", "review-verdict", "sent-back", "needs-you", "decision-answered", "decision-withdrawn", "stopped", "ready", "shipped", "merged", "provider-changed"] as const;
export const historyKindSchema = z.enum(HISTORY_KINDS);
export const historySourceSchema = z.enum(["agent", "user", "system", "boat", "github"]);
export const historyEventSchema = z.object({
  seq: z.number().int(), kind: historyKindSchema, at: z.string(), source: historySourceSchema,
  taskId: z.string().nullable(), taskTitle: z.string().nullable(), threadId: z.string().nullable(),
  orchestratorThreadId: z.string().nullable(), provider: z.enum(["claude", "codex"]).nullable(),
  from: z.string().nullable(), to: z.string().nullable(), text: z.string().max(4000),
  cause: z.string().nullable(), detail: z.string().max(500).nullable().optional(), decisionId: z.string().nullable(), review: reviewPayloadSchema.nullable(),
});
export type HistoryEventDto = z.infer<typeof historyEventSchema>;
export const historyInputSchema = z.object({
  taskId: z.string().optional(), orchestratorThreadId: z.string().optional(),
  beforeSeq: z.number().int().positive().optional(), since: z.iso.datetime({ offset: true }).optional(), until: z.iso.datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(200).default(50),
}).refine((input) => !input.since || !input.until || Date.parse(input.since) <= Date.parse(input.until), "since must precede until");

const usageWindowSchema = z.object({ since: z.string(), until: z.string(), hours: z.number().nullable(), dollars: z.number().nullable(), complete: z.boolean(), sandboxCount: z.number().int() });
export const usageResultSchema = z.object({
  plan: z.object({ name: z.string().nullable(), hoursRemaining: z.number().nullable(), hoursTotal: z.number().nullable(), resetsAt: z.string().nullable() }).nullable(),
  day: usageWindowSchema, week: usageWindowSchema,
  task: z.object({ taskId: z.string(), sandboxId: z.string(), attribution: z.literal("sandbox-window"), seconds: z.number().nullable(), hours: z.number().nullable(), dollars: z.number().nullable(), since: z.string().nullable(), until: z.string().nullable(), running: z.boolean().nullable() }).nullable(),
  sandboxes: z.array(z.object({ sandboxId: z.string(), hours: z.number().nullable(), dollars: z.number().nullable() })).max(100).optional(),
  missing: z.array(z.object({ metric: z.string(), capability: z.string() })), checkedAt: z.string(),
});
export type FidelityUsageDto = z.infer<typeof usageResultSchema>;
export const fidelityRpcMethods = {
  history: { input: historyInputSchema, output: z.object({ events: z.array(historyEventSchema), nextBeforeSeq: z.number().int().nullable() }), tags: () => ["boat:tasks"] },
  fidelityUsage: { input: z.object({ taskId: z.string().optional(), timezoneOffsetMinutes: z.number().int().min(-840).max(840).default(0) }), output: usageResultSchema, tags: () => ["boat:tasks", "boat:sandboxes", "boat:overview"] },
};
