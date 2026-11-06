// What a new orchestrator starts with (src/orchestrator-agent.ts), part of
// the RPC contract (contract.ts spreads orchestratorRpcMethods into it): the
// New orchestrator dialog shows it and lets you change agent and effort.
// Like contract.ts, it may only import zod.
import { z } from "zod";

/** Mirrors ORCHESTRATOR_EFFORTS in src/settings.ts (the app can't import server modules). */
export const ORCHESTRATOR_EFFORT_VALUES = ["low", "medium", "high", "xhigh"] as const;
export const orchestratorEffortSchema = z.enum(ORCHESTRATOR_EFFORT_VALUES);
export type OrchestratorEffortDto = z.infer<typeof orchestratorEffortSchema>;

const agentSchema = z.enum(["claude", "codex"]);

export const orchestratorChoicesSchema = z.object({
  /** Claude, then Codex: the Build preset's model for each, and whether new orchestrators can start on it. */
  agents: z.array(
    z.object({
      provider: agentSchema,
      /** bb's model id. */
      model: z.string(),
      available: z.boolean(),
      /** Why it isn't available ("Not connected in boat.dev"), else null. */
      reason: z.string().nullable(),
    }),
  ),
  /** The default: Agent for orchestrators while it's connected, else the one that is. */
  provider: agentSchema,
  /** Agent for orchestrators (the setting). */
  mainAgent: agentSchema,
  /** Effort for orchestrators (the setting). */
  effort: orchestratorEffortSchema,
  /** Claude ↔ Codex switching is on (and both agents are there): an orchestrator on the other agent moves back to mainAgent. */
  switching: z.boolean(),
});
export type OrchestratorChoicesDto = z.infer<typeof orchestratorChoicesSchema>;

export const orchestratorRpcMethods = {
  /** For the New orchestrator dialog. */
  orchestratorChoices: {
    input: z.null(),
    output: orchestratorChoicesSchema,
    // TAGS.settings, TAGS.protocol (model presets) and TAGS.setup (agents) in contract.ts.
    tags: () => ["boat:settings", "boat:protocol", "boat:setup"],
  },
};
