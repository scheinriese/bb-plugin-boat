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
export const sidebarRpcMethods = {
  sidebarState: { input: z.object({ version: z.literal(1) }), output: z.object({ version: z.literal(1), revision: z.string(), threads: z.array(sidebarThreadSchema).max(2000), truncated: z.boolean() }) },
};
