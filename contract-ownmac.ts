import { z } from "zod";
export const OWN_MAC_MIN_FREE_GB = 6;
export const OWN_MAC_TAG = "boat:ownmac";
export function ownMacTargetChangedNotice(at?: string) {
  return `Your Mac's target changed at ${at ?? "an unknown time"}. The owner must run Test connection again in Settings before tasks run there. Agents must not run Test connection or change Your Mac settings.`;
}
export const OWN_MAC_VM_POWER_HELP =
  "Inside a VM, power is read from the guest. Keep the host Mac on mains power; host battery use may not be detected.";
export const OWN_MAC_GUIDE =
  "https://github.com/scheinriese/bb-plugin-boat/blob/main/docs/settings.md#your-mac";
export const ownMacCodeSchema = z.enum([
  "available",
  "busy",
  "off",
  "setup",
  "paused",
  "unreachable",
  "battery",
  "power",
  "memory",
  "session",
  "personal",
  "admin",
  "target",
  "cleanup",
]);
export const ownMacFactsSchema = z.object({
  code: ownMacCodeSchema.optional(),
  alias: z.string().optional(),
  enabled: z.boolean().optional(),
  status: z.string(),
  running: z.number(),
  max: z.number(),
  vm: z.boolean().nullable().optional(),
  freeMiB: z.number().optional(),
  onPower: z.boolean().nullable().optional(),
  loggedIn: z.boolean().optional(),
  runningTitles: z.array(z.string()).optional(),
  account: z.string().optional(),
  checkedAt: z.string().optional(),
  since: z.string().nullable().optional(),
  tested: z.boolean().optional(),
  setupSteps: z.number().optional(),
  testResult: z
    .object({
      ok: z.boolean(),
      title: z.string(),
      detail: z.string(),
      checkedAt: z.string(),
    })
    .optional(),
  cleanup: z
    .object({
      failed: z.boolean(),
      checkedAt: z.string().nullable(),
      taskIds: z.array(z.string()),
      steps: z.string(),
    })
    .optional(),
  tasksThisMonth: z.number().optional(),
});
export type OwnMacFacts = z.infer<typeof ownMacFactsSchema>;
export const macRentalQuoteSchema = z.object({
  id: z.string(),
  provider: z.string(),
  label: z.string(),
  model: z.string(),
  modelLabel: z.string(),
  minimumCost: z.number().nonnegative(),
  hourPrice: z.number().nonnegative(),
  minimumHours: z.number().positive(),
  currency: z.string(),
  expiresAt: z.string().refine(value=>Number.isFinite(Date.parse(value)),"Invalid quote expiry"),
});
export type MacRentalQuote = z.infer<typeof macRentalQuoteSchema>;
export const ownMacNoticeSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  alias: z.string(),
  reason: z.string(),
  canWaitForOwnMac: z.boolean().optional(),
  refusal: z.enum(["personal", "admin"]).optional(),
  account: z.string().optional(),
  fallback: z
    .object({
      provider: z.string(),
      label: z.string(),
      monthly: z.boolean(),
      paidUntil: z.string().nullable(),
    })
    .optional(),
  offer: macRentalQuoteSchema.optional(),
  offers: z.array(macRentalQuoteSchema).optional(),
  recommendedQuoteId: z.string().optional(),
  recommendationReason: z.string().optional(),
  unavailable: z.array(z.object({provider:z.string(),label:z.string(),reason:z.string()})).optional(),
  answer: z.enum(["wait", "rent", "auto", "failed"]).optional(),
  replacementId: z.string().optional(),
  cleanup: ownMacFactsSchema.shape.cleanup,
  disconnect: z.string().optional(),
});
export type OwnMacNotice = z.infer<typeof ownMacNoticeSchema>;
export function ownMacStatusWords(facts: OwnMacFacts) {
  if (facts.code === "cleanup") return "Logins left behind";
  if (
    ["available", "busy"].includes(facts.code ?? "") ||
    facts.status === "Available" ||
    facts.status === "At task limit"
  )
    return facts.running
      ? `Running ${facts.running} of ${facts.max}`
      : `Available · 0 of ${facts.max}`;
  if (facts.code === "memory") return "Low memory";
  if (facts.code === "session") return "Not logged in";
  if (facts.code === "unreachable" && facts.since)
    return `Asleep or unreachable · since ${new Date(facts.since).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
  return facts.status;
}
export const ownMacRpcMethods = {
  ownMacTestConnection: { input: z.null(), output: ownMacFactsSchema },
  ownMacSetupStep: {
    input: z.object({ step: z.number().int().min(1).max(4) }),
    output: z.null(),
  },
  ownMacCheckCleanup: { input: z.null(), output: ownMacFactsSchema },
  ownMacNotices: {
    tags: () => [OWN_MAC_TAG, "boat:tasks", "boat:providers"],
    input: z.object({
      taskId: z.string().optional(),
      threadId: z.string().optional(),
    }),
    output: z.object({ notices: z.array(ownMacNoticeSchema) }),
  },
  refreshMacRentalOffers: {
    input: z.object({taskId:z.string()}),
    output: z.object({notice:ownMacNoticeSchema}),
  },
  selectMacRentalOffer: {
    input: z.object({taskId:z.string(),quoteId:z.string()}),
    output: z.object({notice:ownMacNoticeSchema}),
  },
  answerOwnMacRental: {
    input: z.object({
      taskId: z.string(),
      answer: z.enum(["rent", "wait"]),
      quoteId: z.string().optional(),
    }),
    output: z.object({ replacementId: z.string().nullable() }),
  },
};
