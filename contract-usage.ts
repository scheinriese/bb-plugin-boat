// The usage view (Settings › Usage limits) in the RPC contract (spread into
// contract.ts): each pooled account's limits and Claude extra usage, as the
// Account Pooler last read them, and where new work goes now. Like
// contract.ts it may only import zod: the app imports it as a value. It
// can't import contract.ts (that imports this), so it has its own values.
import { z } from "zod";

/** A reading older than this shows as stale (the Pooler polls more often while it runs). */
export const USAGE_STALE_MS = 10 * 60_000;

const provider = z.enum(["claude", "codex"]);
export const EXTRA_USAGE_STATUS_VALUES = ["allowed", "rejected", "disabled", "unknown"] as const;

/** Claude extra usage as the Account Pooler last saw it (the relay's claudeExtraUsage). */
export const extraUsageViewSchema = z.object({
  /** allowed: available; rejected: blocked; disabled: off for the account (a spend control); unknown. */
  status: z.enum(EXTRA_USAGE_STATUS_VALUES),
  /** When the Pooler read it (epoch ms; null: never). */
  observedAt: z.number().nullable(),
  /** off: the Pooler doesn't answer; not-routing: it doesn't route Claude. Then nothing is known. */
  pool: z.enum(["on", "off", "not-routing"]),
});

export const usageWindowSchema = z.object({
  /** "5-hour limit", "Weekly limit", "Fable weekly limit". */
  label: z.string(),
  /** The model family a model-only limit applies to ("fable"); null: every model. */
  model: z.string().nullable(),
  /** Percent used (over 100 past the limit); null: not read yet. */
  usedPercent: z.number().nullable(),
  resetsAt: z.string().nullable(),
  /** The provider refuses work at this limit now (the Pooler's "rejected"). */
  atLimit: z.boolean(),
  /** When the Pooler read it (epoch ms; null: never). */
  observedAt: z.number().nullable(),
});
export type UsageWindowDto = z.infer<typeof usageWindowSchema>;

export const usageAccountSchema = z.object({
  id: z.string(),
  provider,
  /** The account's email, else its label in the Account Pooler. */
  name: z.string(),
  /** Off in the Account Pooler: chats don't use it. */
  enabled: z.boolean(),
  /** The Pooler's state when it isn't "ready" (null: ready, or not said). */
  state: z.string().nullable(),
  windows: z.array(usageWindowSchema),
  /**
   * Claude extra usage (paid credits) on this account; null for Codex. Only
   * a status: the Pooler doesn't pass on money amounts yet (bb#7740).
   */
  credits: z.object({ status: z.enum(EXTRA_USAGE_STATUS_VALUES), observedAt: z.number().nullable() }).nullable(),
  /** The newest reading of this account (epoch ms; null: never). */
  observedAt: z.number().nullable(),
  /** The Pooler holds the account back until then (epoch ms). */
  heldUntil: z.number().nullable(),
  /** The Pooler's last error for this account, in its words. */
  error: z.string().nullable(),
});
export type UsageAccountDto = z.infer<typeof usageAccountSchema>;

export const NEXT_STEP_VALUES = ["room", "switch", "paid", "wait", "over"] as const;

export const usageViewSchema = z.object({
  /** When Boat read this (epoch ms). */
  checkedAt: z.number(),
  /** on: the Account Pooler answered; off: not installed, turned off or not answering. */
  pool: z.enum(["on", "off"]),
  /** The agents the Pooler routes; false: chats use this computer's own login. */
  routing: z.object({ claude: z.boolean(), codex: z.boolean() }),
  accounts: z.array(usageAccountSchema),
  /** What the relay and new work go by, per agent (relay.agents), and where it came from. */
  agents: z.array(
    z.object({
      provider,
      /** null: no usage source knows this agent. */
      usedPercent: z.number().nullable(),
      window: z.string().nullable(),
      resetsAt: z.string().nullable(),
      /** pool: the Account Pooler; login: this computer's own login; limit-hit: a failed turn. */
      source: z.enum(["pool", "login", "limit-hit"]).nullable(),
    }),
  ),
  /** The one agent the user has, or null with both. */
  onlyAgent: provider.nullable(),
  switchAtPercent: z.number(),
  paidClaudeFallback: z.boolean(),
  paidClaudeHeadless: z.boolean(),
  /** A fresh "allowed" reading lets automatic paid Claude start now. */
  paidClaudeAvailable: z.boolean(),
  claudeExtraUsage: extraUsageViewSchema,
  /** Where a task started now with no agent named goes, from the relay's own checks. */
  next: z.object({
    /** room: the default agent; switch: the other one; paid: paid Claude; wait: until a reset; over: past a limit (nothing holds it back). */
    kind: z.enum(NEXT_STEP_VALUES),
    /** The agent it starts on (null: it waits). */
    agent: provider.nullable(),
    /** The default agent (Agent for tasks), or the only one. */
    wanted: provider,
    /** Waiting: the earliest reset that frees an agent (ISO; null: unknown). */
    until: z.string().nullable(),
    /** Claude ↔ Codex switching is on (with both agents). */
    switching: z.boolean(),
  }),
});
export type UsageViewDto = z.infer<typeof usageViewSchema>;

export const usageRpcMethods = {
  /** The usage view: pooled accounts, Claude extra usage and the next step (read-only; never refreshes). */
  usage: {
    input: z.null(),
    output: usageViewSchema,
    // The relay's tag: its pass and a refresh bring new numbers.
    tags: () => ["boat:relay"],
  },
  /**
   * New readings, only when the user asks (the Refresh button): the
   * Account Pooler's account.refreshUsage for each account it uses, or the
   * providers' own readings when it's off. Errors in plain words, per account.
   */
  refreshUsage: {
    input: z.null(),
    output: z.object({
      errors: z.array(z.object({ accountId: z.string().nullable(), name: z.string().nullable(), message: z.string() })),
    }),
  },
};
