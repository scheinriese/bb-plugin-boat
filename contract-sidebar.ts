// Boat is independent of the sidebar. Consumers call this additive v1 RPC.
import { z } from "zod";
export const sidebarStatusSchema = z.enum(["working", "review", "ready", "shipped", "needs-you", "broken", "stopped", "waiting-reset"]);
export const sidebarThreadSchema = z.object({
  threadId: z.string(), role: z.enum(["orchestrator", "task", "review", "chat"]), status: sidebarStatusSchema,
  provider: z.enum(["claude", "codex"]).nullable(),
  secondLine: z.object({ text: z.string(), tone: z.enum(["neutral", "attention", "danger", "success"]) }).nullable(),
  parentThreadId: z.string().nullable(),
  createdFor: z.literal("you").nullable(),
  moving: z.boolean().optional(),
  listedIn: z.string().nullable(),
  rollup: z.object({ needsYou: z.number(), stopped: z.number(), ready: z.number(), working: z.number(), shippedToday: z.number() }).nullable(),
  hidden: z.boolean(), updatedAt: z.string(),
});
export type SidebarThreadDto = z.infer<typeof sidebarThreadSchema>;
/** A request is not a BB thread. Only a verified taskThreadId is a chat target. */
export const sidebarQueuedStartSchema = z.object({
  id: z.string().min(1).max(100), revision: z.number().int().nonnegative(), title: z.string().max(200),
  sourceThreadId: z.string().max(200).nullable(), provider: z.enum(["claude", "codex"]).nullable(),
  resetsAt: z.string().max(100).nullable(), createdAt: z.string().max(100),
  state: z.enum(["waiting", "dispatching", "started"]),
  taskId: z.string().max(200).nullable(), taskThreadId: z.string().max(200).nullable(),
});
export type SidebarQueuedStartDto = z.infer<typeof sidebarQueuedStartSchema>;
export const sidebarRpcMethods = {
  sidebarState: { input: z.object({ version: z.literal(1), timezoneOffsetMinutes: z.number().int().min(-840).max(840).optional() }), output: z.object({ version: z.literal(1), revision: z.string(), threads: z.array(sidebarThreadSchema).max(2000), queuedStarts: z.array(sidebarQueuedStartSchema).max(200).optional(), truncated: z.boolean() }) },
};
