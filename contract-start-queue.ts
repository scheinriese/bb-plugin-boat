import type { defineRpcContract as DefineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
const defineRpcContract = ((contract: unknown) => contract) as typeof DefineRpcContract;
export const PAID_START_RENDERER_ID = "paid-task-start";
export const START_QUEUE_TAG = "boat-start-queue";
export const queuedStartSchema = z.object({
  id: z.string(), revision: z.number().int().nonnegative(), title: z.string(),
  state: z.enum(["waiting", "dispatching", "started", "failed", "cancelled"]),
  threadId: z.string().nullable(), parentTaskId: z.string().nullable(), taskId: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(), message: z.string(),
  resetsAt: z.string().nullable(), requestedProvider: z.enum(["claude", "codex"]).nullable(),
});
export type QueuedStartDto = z.infer<typeof queuedStartSchema>;
export const startQuotaSchema = z.object({ provider: z.enum(["claude", "codex"]), usedPercent: z.number().finite().nonnegative().max(1_000_000), resetsAt: z.string().max(100).nullable(), window: z.string().max(200) });
export const paidStartFormSchema = z.object({
  requestId: z.string(), queueId: z.string(), title: z.string(), provider: z.enum(["claude", "codex"]),
  quotas: z.array(startQuotaSchema).max(2), quotedAt: z.string(), expiresAt: z.string(),
});
export type PaidStartForm = z.infer<typeof paidStartFormSchema>;
export const paidStartChoiceSchema = z.object({ requestId: z.string(), choice: z.enum(["start", "wait"]) }).strict();
const key = z.object({ id: z.string().min(1).max(100), revision: z.number().int().nonnegative() });
export const startQueueRpcContract = defineRpcContract({
  queuedStarts: { input: z.object({ threadId: z.string().max(200).optional(), includeFinished: z.boolean().optional() }), output: z.object({ requests: z.array(queuedStartSchema).max(200) }), tags: () => [START_QUEUE_TAG] },
  queuedStart: { input: z.object({ id: z.string().min(1).max(100) }), output: queuedStartSchema.nullable(), tags: () => [START_QUEUE_TAG] },
  cancelQueuedStart: { input: key, output: queuedStartSchema },
  requestPaidStart: { input: key.extend({ provider: z.enum(["claude", "codex"]) }), output: z.object({ pending: z.literal(true), requestId: z.string(), threadId: z.string(), duplicate: z.boolean() }) },
});
