// Shared by the app and server; no runtime SDK or node imports here.
import type { defineRpcContract as DefineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const defineRpcContract = ((contract: unknown) => contract) as typeof DefineRpcContract;
export const SHIP_RENDERER_ID = "ship-to-main";

export const shipChoiceSchema = z.object({
  requestId: z.string(),
  choice: z.enum(["ship", "not-yet"]),
  note: z.string().trim().max(4_000).default(""),
}).strict();

export const shipFormSchema = z.object({
  requestId: z.string(),
  taskId: z.string(),
  title: z.string(),
  baseBranch: z.string(),
  keepOpen: z.boolean(),
  commits: z.number().int().nonnegative(),
  repositories: z.number().int().positive(),
  checks: z.array(z.object({ text: z.string(), tone: z.enum(["ready", "caution", "neutral"]) })),
  changedSinceApproval: z.string().nullable(),
  projectName: z.string().nullable().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  changes: z.string().nullable().optional(),
  changesUrl: z.string().url().nullable().optional(),
  closesSandbox: z.boolean().optional(),
});
export type ShipForm = z.infer<typeof shipFormSchema>;

export const shipRpcContract = defineRpcContract({
  /** Opens an in-thread form and returns without waiting for an answer. */
  requestShip: {
    input: z.object({ id: z.string().min(1), keepOpen: z.boolean().optional(), from: z.enum(["chat", "page"]).optional() }),
    output: z.object({ pending: z.literal(true), requestId: z.string(), threadId: z.string(), duplicate: z.boolean() }),
  },
});
