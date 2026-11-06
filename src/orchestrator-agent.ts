// The agent, model and effort an orchestrator chat starts with: new ones
// (the New orchestrator dialog, `bb boat orchestrator new`, take-overs) and
// Claude ↔ Codex switching's successors. One place decides, so the dialog
// shows what will start and every way of starting one agrees:
// - agent: Agent for orchestrators (relayPreferred) while it's connected,
//   else the one that is (Coding agents);
// - model: the Build preset's model for that agent (Settings → Models);
// - effort: Effort for orchestrators (orchestratorEffort).
// What a caller names (--provider, --model, --effort, the dialog's picks) wins.
// A successor keeps its orchestrator's effort and model picks (OrchestratorPicks).
// "Coordinate from this chat" isn't here: that chat keeps its own model.
import type { OrchestratorChoicesDto } from "../contract-orchestrator.ts";
import { AGENT_NAME, effectiveRelay, onlyAgent, otherAgent } from "./relay.ts";
import type { BoatSettings } from "./service.ts";
import { ORCHESTRATOR_EFFORTS, type OrchestratorEffort } from "./settings.ts";
import type { SettingsStore } from "./settings-store.ts";
import type { Provider } from "./store.ts";
import { bbModelId, modelAgent } from "./tiers.ts";

/** bb's agent provider ids. */
export const CHAT_PROVIDER_ID: Record<Provider, string> = { claude: "claude-code", codex: "codex" };
export const AGENT_LABEL: Record<Provider, string> = { claude: "Claude Code", codex: "Codex" };

/** What a caller may write for an agent: bb's provider id or the plugin's name. */
const NAMED_AGENT: Record<string, Provider> = { "claude-code": "claude", claude: "claude", codex: "codex" };

export type OrchestratorSettings = Pick<BoatSettings, "agents" | "agentsSetting" | "notConnectedAgents" | "relay" | "modelTiers">;

/** Why an agent can't run new orchestrators now (null: it can). */
export function agentUnavailable(settings: OrchestratorSettings, provider: Provider): string | null {
  const only = onlyAgent(settings.agents);
  if (only !== null) {
    if (provider === only) return null;
    return settings.agentsSetting === "auto" ? "Not connected in boat.dev" : `Coding agents is set to Only ${AGENT_NAME[only]}`;
  }
  return settings.notConnectedAgents.includes(provider) ? "boat.dev last reported it as not connected" : null;
}

/** The agent new orchestrators start on: Agent for orchestrators while it's connected, else the one that is. */
export function defaultOrchestratorAgent(settings: OrchestratorSettings): Provider {
  const main = settings.relay.preferred;
  if (agentUnavailable(settings, main) === null) return main;
  const other = otherAgent(main);
  return agentUnavailable(settings, other) === null ? other : main;
}

/** The Build preset's model for an agent, as bb's id. */
export function orchestratorModel(settings: Pick<BoatSettings, "modelTiers">, provider: Provider): string {
  return bbModelId(provider, settings.modelTiers.build[provider].model) ?? settings.modelTiers.build[provider].model;
}

/** What the caller named; empty or missing: the settings decide. */
export interface OrchestratorRequest {
  /** claude-code, codex (or claude), or another bb agent provider. */
  providerId?: string | null;
  model?: string | null;
  effort?: string | null;
}

export interface OrchestratorAgentChoice {
  /** bb's agent provider id. */
  providerId: string;
  /** Claude or Codex; null: another bb agent the caller named. */
  provider: Provider | null;
  /** null: bb's default for that agent (only for another bb agent without --model). */
  model: string | null;
  /** null: bb's default (only for another bb agent without --effort). */
  effort: string | null;
}

/**
 * The spawn's agent, model and effort. A named agent wins; else a named
 * model's agent (claude-…, gpt-…); else the default agent. Another bb agent
 * gets only what was named: the presets and levels are Claude's and Codex's.
 */
export function orchestratorAgentChoice(settings: OrchestratorSettings, effortSetting: string, request: OrchestratorRequest = {}): OrchestratorAgentChoice {
  const named = request.providerId?.trim() || null;
  const model = request.model?.trim() || null;
  const effort = request.effort?.trim() || null;
  if (named !== null && !Object.hasOwn(NAMED_AGENT, named)) return { providerId: named, provider: null, model, effort };
  const provider = named !== null ? NAMED_AGENT[named]! : (modelAgent(model) ?? defaultOrchestratorAgent(settings));
  return {
    providerId: CHAT_PROVIDER_ID[provider],
    provider,
    // boat's opus-5-5 is bb's claude-opus-5-5, like the preset's.
    model: model !== null ? (bbModelId(provider, model) ?? model) : orchestratorModel(settings, provider),
    effort: effort ?? effortSetting,
  };
}

/**
 * What one orchestrator was started with beyond the settings: an effort other
 * than Effort for orchestrators, a model other than its agent's Build model.
 * Its chat's metadata keeps them, and Claude ↔ Codex switching passes them on:
 * the effort on either agent, a model whenever it runs on that model's agent.
 */
export interface OrchestratorPicks {
  effort?: OrchestratorEffort;
  /** bb's model id, by the agent it's for. */
  models?: Partial<Record<Provider, string>>;
}

const isEffort = (value: unknown): value is OrchestratorEffort => (ORCHESTRATOR_EFFORTS as readonly unknown[]).includes(value);

/** The picks to keep with a new orchestrator; null: it follows the settings. */
export function orchestratorPicks(settings: Pick<BoatSettings, "modelTiers">, effortSetting: string, choice: OrchestratorAgentChoice): OrchestratorPicks | null {
  // Another bb agent: switching never moves it.
  if (choice.provider === null) return null;
  const picks: OrchestratorPicks = {};
  if (choice.effort !== effortSetting && isEffort(choice.effort)) picks.effort = choice.effort;
  if (choice.model !== null && choice.model !== orchestratorModel(settings, choice.provider)) picks.models = { [choice.provider]: choice.model };
  return Object.keys(picks).length > 0 ? picks : null;
}

/** Stored picks, minus anything that isn't one (old or hand-edited metadata). */
export function parseOrchestratorPicks(value: unknown): OrchestratorPicks {
  if (value === null || typeof value !== "object") return {};
  const raw = value as { effort?: unknown; models?: unknown };
  const picks: OrchestratorPicks = {};
  if (isEffort(raw.effort)) picks.effort = raw.effort;
  if (raw.models !== null && typeof raw.models === "object") {
    const models = raw.models as Record<string, unknown>;
    for (const provider of ["claude", "codex"] as const) {
      const model = models[provider];
      if (typeof model === "string" && model.trim() !== "" && model.length <= 200) (picks.models ??= {})[provider] = model.trim();
    }
  }
  return picks;
}

/** "Claude Code · claude-opus-5-5 · high effort" (the CLI's line). */
export function choiceSummary(choice: OrchestratorAgentChoice): string {
  return [
    choice.provider !== null ? AGENT_LABEL[choice.provider] : choice.providerId,
    choice.model,
    choice.effort !== null ? `${choice.effort} effort` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** What the New orchestrator dialog offers, and starts with unless you change it. */
export function orchestratorChoices(settings: OrchestratorSettings, effortSetting: string): OrchestratorChoicesDto {
  return {
    agents: (["claude", "codex"] as const).map((provider) => {
      const reason = agentUnavailable(settings, provider);
      return { provider, model: orchestratorModel(settings, provider), available: reason === null, reason };
    }),
    provider: defaultOrchestratorAgent(settings),
    mainAgent: settings.relay.preferred,
    effort: effortSetting as OrchestratorChoicesDto["effort"],
    switching: effectiveRelay(settings.relay, settings.agents).enabled,
  };
}

/** The RPC handler (contract-orchestrator.ts). */
export function orchestratorChoiceHandlers(deps: { settings(): Promise<OrchestratorSettings>; store: Pick<SettingsStore, "get"> }) {
  return {
    orchestratorChoices: async () => orchestratorChoices(await deps.settings(), (await deps.store.get()).orchestratorEffort),
  };
}
