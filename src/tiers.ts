// Model tiers: the orchestrator picks a tier per task (how hard the work is),
// the plugin picks the model and reasoning effort for the agent that runs it.
import { z } from "zod";
import type { Provider, TaskRole } from "./store.ts";

export const TIERS = ["light", "review", "build", "deep", "frontier"] as const;
export type Tier = (typeof TIERS)[number];

/**
 * Reasoning levels. bb's agents add one above max each: Claude Code's
 * "ultracode" (xhigh plus multi-agent workflows) and Codex's "ultra" (max
 * plus automatic delegation). boat conversations stop at max.
 */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultracode", "ultra"] as const;
export type Effort = (typeof EFFORTS)[number];

/** The level only one agent has; null for shared levels. */
export function effortAgent(effort: string | null): Provider | null {
  return effort === "ultracode" ? "claude" : effort === "ultra" ? "codex" : null;
}

/** The agent a model id is for, when the id says (claude-…, opus-…, gpt-…); null: can't tell. */
export function modelAgent(model: string | null): Provider | null {
  if (model === null) return null;
  if (/^(claude|opus|sonnet|haiku|fable)-/i.test(model)) return "claude";
  if (/^(gpt|codex)-|^o\d/i.test(model)) return "codex";
  return null;
}

/** Levels above xhigh: Frontier at any of them needs the user's OK. */
export const TOP_EFFORTS: readonly string[] = ["max", "ultracode", "ultra"];

export const TIER_LABEL: Record<Tier, string> = {
  light: "Light",
  review: "Review",
  build: "Build",
  deep: "Deep",
  frontier: "Frontier",
};

export const TIER_USE: Record<Tier, string> = {
  light: "Mechanical or exactly specified work, re-running existing scripts",
  review: "Read-only reviews and audits; small fixes with a known cause",
  build: "Normal implementation and debugging",
  deep: "Parallel exploration plus independent checking; hard bugs, side-by-side options",
  frontier: "Only after Deep fell short; never at max effort without the user's OK",
};

const choiceSchema = z.object({
  model: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:/-]+$/, "not a model id"),
  effort: z.enum(EFFORTS),
});
export type TierChoice = z.infer<typeof choiceSchema>;

const rowSchema = z
  .object({ claude: choiceSchema, codex: choiceSchema })
  .refine((row) => row.claude.effort !== "ultra", { message: "ultra is a Codex level; Claude's is ultracode", path: ["claude", "effort"] })
  .refine((row) => row.codex.effort !== "ultracode", { message: "ultracode is a Claude level; Codex's is ultra", path: ["codex", "effort"] });

export const tierMapSchema = z.object({
  light: rowSchema,
  review: rowSchema,
  build: rowSchema,
  deep: rowSchema,
  frontier: rowSchema,
});
export type TierMap = z.infer<typeof tierMapSchema>;

/**
 * As of 2026-11: GPT-6.1 Sol is the Codex counterpart of Opus 5.5. Model ids
 * are bb's (worker chats); boat conversations get them translated
 * (claude-opus-5-5 → opus-5-5, ultracode/ultra → max).
 */
export const DEFAULT_TIERS: TierMap = {
  light: { claude: { model: "claude-sonnet-5-5", effort: "high" }, codex: { model: "gpt-6.1-sol", effort: "medium" } },
  review: { claude: { model: "claude-opus-5-5", effort: "high" }, codex: { model: "gpt-6.1-sol", effort: "high" } },
  build: { claude: { model: "claude-opus-5-5", effort: "xhigh" }, codex: { model: "gpt-6.1-sol", effort: "xhigh" } },
  deep: { claude: { model: "claude-opus-5-5", effort: "ultracode" }, codex: { model: "gpt-6.1-sol", effort: "ultra" } },
  frontier: { claude: { model: "claude-fable-5-1", effort: "xhigh" }, codex: { model: "gpt-6-astra", effort: "xhigh" } },
};

/** bb's id for a Claude model given the way boat writes it (opus-5-5 → claude-opus-5-5). */
export function bbModelId(provider: Provider, model: string | null): string | null {
  if (model === null || provider !== "claude") return model;
  return /^(opus|sonnet|haiku|fable)-\d/.test(model) ? `claude-${model}` : model;
}

/** boat's id for a Claude model (claude-opus-5-5 → opus-5-5; boat lists the others with the prefix). */
export function boatModelId(provider: Provider, model: string | null): string | null {
  if (model === null || provider !== "claude") return model;
  return /^claude-opus-\d/.test(model) ? model.slice("claude-".length) : model;
}

/** boat conversations stop at max. */
export function boatEffort(effort: string | null): string | null {
  return effort === "ultracode" || effort === "ultra" ? "max" : effort;
}

/** A stored tier map, or the defaults when it's missing or invalid. */
export function parseTierMap(value: unknown): TierMap {
  const parsed = tierMapSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_TIERS;
}

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

export function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && (EFFORTS as readonly string[]).includes(value);
}

/** The tier a task gets when nobody chose one (and no model was configured). */
export function defaultTierFor(role: TaskRole): Tier {
  return role === "review" ? "review" : "build";
}

/** "Build · opus-5-5 · xhigh" (any part may be missing). */
export function tierSummary(tier: string | null, model: string | null, effort: string | null): string {
  return [isTier(tier) ? TIER_LABEL[tier] : null, model, effort].filter(Boolean).join(" · ");
}

/** Frontier models at the highest effort cost a lot more; they need the user's OK. */
export function needsFrontierApproval(tiers: TierMap, tier: Tier | null, model: string | null, effort: string | null): boolean {
  if (effort === null || !TOP_EFFORTS.includes(effort)) return false;
  if (tier === "frontier") return true;
  const frontierModels = [tiers.frontier.claude.model, tiers.frontier.codex.model].flatMap((id) => [
    id.toLowerCase(),
    (boatModelId("claude", id) ?? id).toLowerCase(),
    (bbModelId("claude", id) ?? id).toLowerCase(),
  ]);
  return model !== null && frontierModels.includes(model.toLowerCase());
}

/** The tier table as Markdown, for the protocol. */
export function tierTable(tiers: TierMap): string {
  const rows = TIERS.map(
    (tier) =>
      `| ${TIER_LABEL[tier]} | ${tiers[tier].claude.model} · ${tiers[tier].claude.effort} | ${tiers[tier].codex.model} · ${tiers[tier].codex.effort} |`,
  );
  return ["| Tier | Claude (agent: claude) | Codex (agent: codex) |", "|---|---|---|", ...rows].join("\n");
}

export function choiceFor(tiers: TierMap, tier: Tier, provider: Provider): TierChoice {
  return tiers[tier][provider];
}
