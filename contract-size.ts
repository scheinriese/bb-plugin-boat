// Sandbox sizes and memory in the RPC contract (spread into contract.ts).
// Like contract.ts it may only import zod: the app imports it as a value.
// It can't import contract.ts (that imports this), so it has its own size
// values and tag strings.
import { z } from "zod";

export const SIZE_VALUES = ["small", "default", "large", "xlarge"] as const;
const sizeSchema = z.enum(SIZE_VALUES);

/** One size with the plan's verdict (the shape of contract.ts sandboxSizeSchema). */
const sizeOptionSchema = z.object({
  type: sizeSchema,
  label: z.string(),
  /** "8 vCPU, 16 GB · double rate" */
  detail: z.string(),
  available: z.boolean(),
  reason: z.string().nullable(),
});

/** A sandbox's size: "Default", "4 vCPU, 8 GB" (type null: not known exactly). */
const sizeFactsSchema = z.object({ type: sizeSchema.nullable(), label: z.string(), summary: z.string() });

export const taskMemorySchema = z.object({
  /** The task's sandbox, as last measured or set (null: unknown). */
  size: sizeFactsSchema.nullable(),
  /**
   * An out-of-memory kill in the latest turn, named by the kernel's log.
   * cause: it ended the turn (the message leads the error); original: the
   * error it replaced.
   */
  oom: z
    .object({ message: z.string(), original: z.string().nullable(), at: z.string(), cause: z.boolean() })
    .nullable(),
  /** Measured tasks: the peak of the measured turn. */
  peak: z
    .object({
      usedGb: z.number(),
      totalGb: z.number(),
      percent: z.number(),
      /** Swap in use at the peak, GB (null: none to speak of). */
      swapGb: z.number().nullable(),
      /** Other tasks worked on the sandbox meanwhile: the peak is theirs too. */
      shared: z.boolean(),
      at: z.string(),
    })
    .nullable(),
  recommendation: z
    .object({
      type: sizeSchema,
      label: z.string(),
      current: sizeSchema.nullable(),
      reason: z.enum(["near-limit", "out-of-memory", "fits", "largest"]),
      allowed: z.boolean(),
      planReason: z.string().nullable(),
    })
    .nullable(),
  /** The next size up from the current one, with the plan's verdict (null: XLarge or unknown). */
  next: sizeOptionSchema.nullable(),
  /** The stored project whose size applies to this task's new sandboxes. */
  project: z.object({ id: z.string(), name: z.string(), machineType: sizeSchema.nullable(), effective: sizeSchema }).nullable(),
  /** A move in progress, or the last one that failed (until the next turn). */
  resize: z
    .object({
      state: z.enum(["running", "failed"]),
      from: sizeSchema.nullable(),
      to: sizeSchema,
      /** "Large (8 vCPU, 16 GB)" */
      toSummary: z.string(),
      step: z.enum(["stopping", "starting", "reconnecting", "sending"]).nullable(),
      error: z.string().nullable(),
      /** A follow-up goes out once it's up. */
      withMessage: z.boolean(),
      /** Failed after the size changed (bb didn't reconnect, the follow-up couldn't be sent): only the message is left to send. */
      moved: z.boolean(),
    })
    .nullable(),
  /** Change sandbox size can be offered now: open, between turns, with a sandbox the plugin created. */
  canResize: z.boolean(),
});
export type TaskMemoryDto = z.infer<typeof taskMemorySchema>;

export const resizeInfoSchema = z.object({
  sandboxId: z.string().nullable(),
  current: sizeFactsSchema.nullable(),
  /** The next allowed size up (null: none). */
  suggested: sizeSchema.nullable(),
  /** The latest turn ran out of memory. */
  oom: z.boolean(),
  /** Other open tasks on the sandbox: they move too. */
  others: z.array(z.object({ id: z.string(), title: z.string(), status: z.string() })),
  /** Live previews on the sandbox: they stop (Wake starts them again). */
  previews: z.number(),
  /** A bb machine (a task chat's): bb reconnects after it starts. */
  chat: z.boolean(),
  /** boat starts left (a move uses one), when boat says. */
  startsLeft: z.number().nullable(),
  /** Why it can't move now (null: it can). */
  blocker: z.object({ code: z.string(), message: z.string(), hint: z.string().nullable() }).nullable(),
});
export type ResizeInfoDto = z.infer<typeof resizeInfoSchema>;

export const sizeRpcMethods = {
  /** What the Change sandbox size dialog needs: the current size, who shares it, and what blocks a move. */
  sandboxResizeInfo: {
    input: z.object({ id: z.string() }),
    output: resizeInfoSchema,
    tags: () => ["boat:tasks", "boat:setup"],
  },
  /**
   * Move a task's sandbox to another size (stop, then resume with --type),
   * then send the message as a follow-up (null: only move it). pending: the
   * move goes on in the background.
   */
  resizeSandbox: {
    input: z.object({ id: z.string(), type: sizeSchema, message: z.string().trim().max(100_000).nullable() }),
    output: z.object({ pending: z.boolean(), to: sizeSchema, moved: z.array(z.string()), sent: z.boolean() }),
  },
  /** A project's sandbox size (null: the Default sandbox size setting); says when the plan doesn't allow it. */
  setProjectSize: {
    input: z.object({ projectId: z.string(), machineType: sizeSchema.nullable() }),
    output: z.object({ name: z.string(), machineType: sizeSchema.nullable(), allowed: z.boolean(), reason: z.string().nullable() }),
  },
} as const;
