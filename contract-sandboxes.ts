import { z } from "zod";

/** Presentation evidence, separate from capacity and rental accounting. */
export const machinePowerSchema = z.enum(["on", "off", "unknown"]);
export type MachinePower = z.infer<typeof machinePowerSchema>;

export const sandboxInventorySchema = z.object({
  providers: z.array(z.object({
    id: z.string().max(40),
    status: z.enum(["fresh", "unavailable"]),
    observedAt: z.string().nullable(),
    /** Null if any state is unknown, the list failed, or rows were truncated. */
    poweredOn: z.number().int().nonnegative().nullable(),
    unknown: z.number().int().nonnegative().nullable(),
    truncated: z.boolean(),
  })).max(10),
  truncated: z.boolean(),
});
export type SandboxInventoryDto = z.infer<typeof sandboxInventorySchema>;

/** Local lease evidence cannot confirm the provider's final bill. */
export const sandboxMacLeaseSchema = z.object({
  provider: z.string().max(40), machineId: z.string().max(200), size: z.string().max(100),
  state: z.enum(["held", "returned", "ended-unverified"]),
  startedAt: z.string(), paidUntil: z.string(), endedAt: z.string().nullable(),
  endReason: z.enum(["handed back", "deleted", "failed"]).nullable(),
  endEvidence: z.enum(["legacy", "inferred", "confirmed"]),
  minimumCost: z.number(), hourPrice: z.number(), currency: z.string().max(10),
  kept: z.boolean(), releaseAt: z.string().nullable(),
  taskIds: z.array(z.string().max(200)).max(20),
});
export type SandboxMacLeaseDto = z.infer<typeof sandboxMacLeaseSchema>;
