// Setup checks: is this bb ready to run cloud agents? Built from read-only
// boat commands (`--version`, `status`, `limits`, `env list`, `ai profiles`),
// the last GitHub check, bb Connect and `gh`. One cached status feeds
// `bb boat doctor`, the first line of `bb boat status`, the Cloud agents page,
// the machine provider's availability, and the checks that run before any
// sandbox is created (so a broken setup costs no starts).
//
// JSON shapes observed from boat CLI 1.0.89 (test/fixtures/boat-json).
// `env list` carries the environments' variable VALUES (envContents): they
// are never kept, logged or returned; only the fields below are read.
import { BoatError, bool, num, rec, str, type BoatRunOptions, type BoatRunResult, type JsonRecord } from "./boat.ts";
import { autoStopCapFromLimits } from "./boat-api.ts";
import { SIZE_ORDER, SIZE_SPECS, sizeDetail } from "./memory.ts";
import type { ConnectCheck, ConnectStatus } from "./connect.ts";
import { TaskError, type StartTaskInput } from "./service.ts";
import type { Provider } from "./store.ts";

// ---------------------------------------------------------------- wording

export const INSTALL_COMMAND = "curl -fsSL https://boat.dev/install | sh";
export const SIGN_IN_COMMAND = "boat onboard";
export const PLAN_COMMAND = "boat billing plan 20";
export const DASHBOARD_URL = "https://boat.dev/dashboard";
export const AGENTS_URL = "https://boat.dev/dashboard?tab=agents";
export const ENVIRONMENT_URL = "https://boat.dev/dashboard?tab=environment";

export const SIGN_IN_HINT = "Sign in to boat.dev: run `boat onboard` in a terminal.";
export const PLAN_HINT = `Start a boat plan (7-day trial, card required): run \`${PLAN_COMMAND}\` or open ${DASHBOARD_URL}.`;
export const INSTALL_HINT = `Install it: run \`${INSTALL_COMMAND}\` in a terminal (it signs you in and starts your trial). Installed somewhere else? Set boat CLI location in this plugin's settings.`;
export const GITHUB_HINT = 'Connect GitHub on boat.dev → Environment and give boat access to this repo (or turn off "Safe for third parties").';
export const DOCTOR_HINT = "Run `bb boat doctor` to see every check.";

const AGENT_NAME: Record<Provider, string> = { claude: "Claude", codex: "Codex" };
/** What to connect on boat.dev for each agent. */
const LOGIN_NAME: Record<Provider, string> = { claude: "Claude", codex: "ChatGPT" };

export function agentsHint(providers: readonly Provider[] = ["claude", "codex"]): string {
  const names = providers.map((provider) => LOGIN_NAME[provider]).join(" or ");
  return `Connect ${names} on boat.dev → Agents (${AGENTS_URL}). Already connected? Your boat environment may be set to "Safe for third parties", which hides agent logins from sandboxes.`;
}

/** The fix for "Safe for third parties" when the command is shown on its own. */
export const SAFETY_TEXT = 'Turn off "Safe for third parties" for it on boat.dev → Environment, or run this in a terminal:';
export const RELOAD_COMMAND = "bb plugin reload boat";

export function safetyHint(environment: string): string {
  return `Turn off "Safe for third parties" for it on boat.dev → Environment, or run \`boat env set ${environment} --safe-for-third-parties false\`.`;
}

/** The message posted when the plugin loads without the boat CLI (cleared by a reload or a settings save). */
export const CLI_MISSING_STATUS = `The boat CLI was not found. Install it: run \`${INSTALL_COMMAND}\` in a terminal, then reload the plugin (\`bb plugin reload boat\`). Installed somewhere else? Set boat CLI location in this plugin's settings, then reload the plugin.`;

// ---------------------------------------------------------------- sizes and auto-stop

/** Sizes as `boat new --help` describes them (src/memory.ts holds the numbers). */
export const SIZE_FACTS: Record<string, { label: string; detail: string }> = Object.fromEntries(
  SIZE_ORDER.map((type) => [type, { label: SIZE_SPECS[type].label, detail: sizeDetail(type) }]),
);

export interface SandboxSize {
  type: string;
  label: string;
  detail: string;
  available: boolean;
  reason: string | null;
}

/** Every size, with what the plan allows (unknown plan: all available). */
export function sandboxSizes(types: readonly string[], plan: PlanFacts | null): SandboxSize[] {
  return types.map((type) => {
    const facts = plan?.machineTypes.find((entry) => entry.type === type) ?? null;
    const known = SIZE_FACTS[type] ?? { label: type, detail: "" };
    return {
      type,
      label: known.label,
      detail: known.detail,
      available: facts?.available ?? true,
      reason: facts && !facts.available ? (facts.reason ?? "Your boat plan doesn't include this size.") : null,
    };
  });
}

// ---------------------------------------------------------------- types

export type CheckState = "ok" | "missing" | "warning" | "unknown" | "optional";
export const CHECK_IDS = ["cli", "signed-in", "plan", "agents", "environment", "github", "connect", "gh"] as const;
export type CheckId = (typeof CHECK_IDS)[number];
/**
 * Buttons the UI can offer. check-again: refresh the checks; sign-in: run
 * `boat onboard` in a terminal; use-detected-agents: set Coding agents to
 * Auto-detect (applySetupFix).
 */
export const SETUP_ACTIONS = ["check-again", "sign-in", "use-detected-agents"] as const;
export type SetupAction = (typeof SETUP_ACTIONS)[number];

export interface SetupFix {
  text: string;
  command?: string;
  url?: string;
  action?: SetupAction;
}

export interface SetupCheck {
  id: CheckId;
  label: string;
  state: CheckState;
  /** A failing required check blocks new work (missing); warnings never do. */
  required: boolean;
  detail: string;
  fix?: SetupFix;
}

/** The "Coding agents" setting: auto follows boat.dev. */
export type AgentsSetting = "auto" | "both" | Provider;
export type AgentChoice = "both" | Provider;

export interface MachineTypeFacts {
  type: string;
  available: boolean;
  reason: string | null;
}

export interface PlanFacts {
  /** "Standard", "Trial", … (boat's account plan, else its access tier). */
  name: string | null;
  /** boat's access tier: trial, standard, … */
  accessTier: string | null;
  trial: boolean;
  /** When the trial ends (ISO), on the trial. */
  trialEndsAt: string | null;
  checkoutRequired: boolean;
  canStart: boolean;
  startBlockedReason: string | null;
  activeSandboxes: number;
  maxActiveSandboxes: number | null;
  startsLeftToday: number | null;
  startsPerDay: number | null;
  /** Sandbox hours the plan has left this period. */
  vmHoursRemaining: number | null;
  machineTypes: MachineTypeFacts[];
  /** boat's paid extra starts ("keep going"); the plugin never turns them on. */
  extraStartsEnabled: boolean | null;
  /** The plan's cap on a sandbox's auto-stop, in hours (the trial's; null: none). */
  autoStopCapHours: number | null;
}

export interface EnvironmentFacts {
  name: string;
  isDefault: boolean;
  safeForThirdParties: boolean | null;
  /** effective.* toggles (what sandboxes really get). */
  passAgentsCredentials: boolean | null;
  passGithub: boolean | null;
  passSecrets: boolean | null;
  /** null: the account's default credential profile. */
  credentialProfileId: string | null;
}

export interface ProfileFacts {
  id: string;
  name: string | null;
  isDefault: boolean;
  personal: boolean;
  /** claude-subscription, anthropic-api-key, chatgpt-subscription, openai-api-key, … */
  connected: string[];
}

/** One reading of boat. Fields are null when the command failed (error says why). */
export interface BoatFacts {
  at: number;
  cli: { found: boolean; version: string | null };
  account: { signedIn: boolean | null; identifier: string | null; plan: string | null; error: string | null };
  plan: PlanFacts | null;
  planError: string | null;
  environments: EnvironmentFacts[] | null;
  environmentsError: string | null;
  profiles: ProfileFacts[] | null;
  profilesError: string | null;
}

export interface SetupSettings {
  agents: AgentsSetting;
  /** The environment for new sandboxes ("" = boat's default). */
  environment: string;
  /** Task chats (or cloud orchestrators) are in use: bb Connect is required. */
  connectNeeded: boolean;
  /** Project rules files or your own uploader script: gh on this computer is needed. */
  ghNeeded: boolean;
}

export interface RepoAccessFacts {
  repo: string;
  access: string;
  detail: string | null;
  checkedAt: string;
}

export interface GhFacts {
  state: "ok" | "not-installed" | "signed-out" | "unknown";
  detail: string | null;
}

export interface AgentsReport {
  setting: AgentsSetting;
  /** Agents boat.dev has for new sandboxes (null: couldn't tell). */
  detected: Provider[] | null;
  /** What the plugin uses: the setting, or what boat reports for Auto-detect. */
  effective: AgentChoice;
}

export interface SetupStatus {
  /** Every required check passes (warnings allowed). */
  ok: boolean;
  checkedAt: string;
  /** One line for `bb boat status` and the page. */
  summary: string;
  checks: SetupCheck[];
  agents: AgentsReport;
  plan: PlanFacts | null;
  /** The environment new sandboxes use, as boat reports it (null: unknown). */
  environment: { name: string; isDefault: boolean; safeForThirdParties: boolean | null } | null;
}

// ---------------------------------------------------------------- parsing

/** "boat 1.0.89" → "1.0.89". */
export function parseVersion(stdout: string): string | null {
  return /\b(\d+\.\d+\.\d+[\w.-]*)/.exec(stdout)?.[1] ?? null;
}

/** `boat status --json`. */
export function parseAccount(raw: JsonRecord): BoatFacts["account"] {
  const account = rec(raw.account) ?? {};
  const api = rec(raw.api);
  return {
    signedIn: bool(account.signedIn),
    identifier: str(account.identifier),
    plan: str(account.plan),
    error: api !== null && api.healthy === false ? (str(api.error) ?? "boat.dev isn't answering") : null,
  };
}

/** `boat limits --json`. */
export function parsePlan(raw: JsonRecord, accountPlan: string | null = null): PlanFacts {
  const starts = rec(raw.starts);
  const day = rec(starts?.day);
  const tier = str(raw.accessTier);
  const trial = tier === "trial" || str(raw.subscriptionStatus) === "trialing";
  const machineTypes = (Array.isArray(raw.machineTypes) ? raw.machineTypes : [])
    .map((entry) => rec(entry))
    .filter((entry): entry is JsonRecord => entry !== null && str(entry.type) !== null)
    .map((entry) => ({ type: str(entry.type)!, available: bool(entry.available) ?? true, reason: str(entry.reason) }));
  const name = accountPlan ?? str(raw.planName) ?? (tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : null);
  return {
    name: trial ? "Trial" : name,
    accessTier: tier,
    trial,
    trialEndsAt: trial ? str(raw.subscriptionTrialEndsAt) : null,
    checkoutRequired: bool(raw.checkoutRequired) ?? false,
    canStart: bool(raw.canStart) ?? true,
    startBlockedReason: str(raw.startBlockedReason) ?? str(raw.blockedReason),
    activeSandboxes: num(raw.activeSandboxes) ?? 0,
    maxActiveSandboxes: num(rec(raw.currentLimits)?.activeSandboxes) ?? num(raw.maxActiveSandboxes),
    startsLeftToday: rec(starts)?.unlimited === true ? null : num(day?.remaining),
    startsPerDay: num(day?.limit),
    vmHoursRemaining: num(rec(raw.planIncluded)?.vmHoursRemaining),
    machineTypes,
    extraStartsEnabled: bool(rec(raw.keepGoing)?.enabled),
    autoStopCapHours: autoStopCapFromLimits(raw),
  };
}

/** `boat env list --json` (the same fields as `env info`). Variable values are dropped. */
export function parseEnvironments(raw: JsonRecord): EnvironmentFacts[] {
  const list = Array.isArray(raw.environments) ? raw.environments : [];
  return list
    .map((entry) => rec(entry))
    .filter((entry): entry is JsonRecord => entry !== null && str(entry.name) !== null)
    .map((entry) => {
      const effective = rec(entry.effective) ?? {};
      // The effective toggles are what sandboxes get ("Safe for third parties" turns them off).
      const toggle = (key: string) => bool(effective[key]) ?? bool(entry[key]);
      return {
        name: str(entry.name)!,
        isDefault: entry.isDefault === true,
        safeForThirdParties: bool(entry.safeForThirdParties),
        passAgentsCredentials: toggle("passAgentsCredentials"),
        passGithub: toggle("passGithub"),
        passSecrets: toggle("passSecrets"),
        credentialProfileId: str(entry.credentialProfileId),
      };
    });
}

/** `boat ai profiles --json`. */
export function parseProfiles(raw: JsonRecord): ProfileFacts[] {
  const list = Array.isArray(raw.profiles) ? raw.profiles : [];
  return list
    .map((entry) => rec(entry))
    .filter((entry): entry is JsonRecord => entry !== null && str(entry.id) !== null)
    .map((entry) => ({
      id: str(entry.id)!,
      name: str(entry.name),
      isDefault: entry.isDefault === true,
      personal: str(rec(entry.owner)?.kind) === "personal",
      connected: (Array.isArray(entry.connected) ? entry.connected : []).filter((item): item is string => typeof item === "string"),
    }));
}

/** Which agents a profile's connected credentials run (a subscription or an API key). */
export function agentsFromConnected(connected: readonly string[]): Provider[] {
  const has = (prefixes: string[]) => connected.some((id) => prefixes.some((prefix) => id.startsWith(prefix)));
  const agents: Provider[] = [];
  if (has(["claude-", "anthropic-"])) agents.push("claude");
  if (has(["chatgpt-", "openai-"])) agents.push("codex");
  return agents;
}

/** The environment new sandboxes use: the named one, else boat's default (null: unknown or missing). */
export function environmentFor(facts: BoatFacts, name: string | null | undefined): EnvironmentFacts | null {
  const list = facts.environments;
  if (list === null) return null;
  const wanted = name?.trim() || null;
  return wanted === null ? (list.find((env) => env.isDefault) ?? null) : (list.find((env) => env.name === wanted) ?? null);
}

/** The credential profile an environment uses (its own, else the personal default). */
export function profileFor(facts: BoatFacts, environment: EnvironmentFacts | null): ProfileFacts | null {
  const list = facts.profiles;
  if (list === null) return null;
  const id = environment?.credentialProfileId ?? null;
  if (id !== null) return list.find((profile) => profile.id === id) ?? null;
  return list.find((profile) => profile.isDefault && profile.personal) ?? list.find((profile) => profile.isDefault) ?? null;
}

/**
 * The agents a sandbox in this environment can log in to, as boat reports it:
 * null when boat couldn't be read. An environment that hides agent logins
 * gives none.
 */
export function detectAgents(facts: BoatFacts, environmentName: string | null | undefined): Provider[] | null {
  if (facts.account.signedIn !== true) return null;
  const environment = environmentFor(facts, environmentName);
  const profile = profileFor(facts, environment);
  if (profile === null) return null;
  if (environment?.passAgentsCredentials === false) return [];
  return agentsFromConnected(profile.connected);
}

/** "auto" follows boat; unknown (or nothing connected) behaves like both. */
export function effectiveAgents(setting: AgentsSetting, detected: readonly Provider[] | null): AgentChoice {
  if (setting !== "auto") return setting;
  if (detected === null || detected.length !== 1) return "both";
  return detected[0]!;
}

export function parseAgentsSetting(value: unknown): AgentsSetting {
  return value === "both" || value === "claude" || value === "codex" ? value : "auto";
}

function agentList(agents: readonly Provider[]): string {
  return agents.length === 2 ? "Claude and Codex" : agents.length === 1 ? AGENT_NAME[agents[0]!] : "no agent";
}

function choiceAgents(choice: AgentChoice): Provider[] {
  return choice === "both" ? ["claude", "codex"] : [choice];
}

// ---------------------------------------------------------------- checks

export interface CheckContext {
  settings: SetupSettings;
  connect: ConnectStatus | null;
  repoAccess: RepoAccessFacts | null;
  gh: GhFacts | null;
  /** The plugin loaded without the CLI: bb shows "needs configuration" until a reload. */
  reloadNeeded?: boolean;
  now?: number;
}

function hours(value: number): string {
  return value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}

function day(iso: string): string {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toUTCString().slice(5, 11) : iso;
}

/** The plan in one line: "Standard plan · 550 sandbox hours left". */
export function planLine(plan: PlanFacts): string {
  const sizes = plan.machineTypes.filter((type) => type.available).map((type) => type.type);
  const parts = [
    plan.trial ? `Trial${plan.trialEndsAt ? ` until ${day(plan.trialEndsAt)}` : ""}` : `${plan.name ?? "Your"} plan`,
    plan.maxActiveSandboxes !== null ? `${plan.maxActiveSandboxes} sandboxes at once` : null,
    plan.vmHoursRemaining !== null ? `${hours(plan.vmHoursRemaining)} sandbox hours left` : null,
    plan.trial && plan.startsLeftToday !== null ? `${plan.startsLeftToday} starts left today` : null,
    plan.trial && sizes.length > 0 && sizes.length < plan.machineTypes.length ? `${sizes.join(" and ")} sizes` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

export function buildChecks(facts: BoatFacts, context: CheckContext): SetupCheck[] {
  const { settings } = context;
  const checks: SetupCheck[] = [];
  const signedIn = facts.account.signedIn === true;
  const needsCli = "Needs the boat CLI first.";
  const needsSignIn = "Needs you to sign in to boat.dev first.";

  // 1. The CLI.
  checks.push(
    facts.cli.found
      ? context.reloadNeeded
        ? {
            id: "cli",
            label: "boat CLI",
            state: "warning",
            required: true,
            detail: `${facts.cli.version ? `boat ${facts.cli.version} found` : "Found"}, but bb still says the plugin needs configuration: it loaded before the CLI was there.`,
            fix: { text: "Reload the plugin to clear that.", command: RELOAD_COMMAND },
          }
        : { id: "cli", label: "boat CLI", state: "ok", required: true, detail: facts.cli.version ? `boat ${facts.cli.version} found` : "Found" }
      : {
          id: "cli",
          label: "boat CLI",
          state: "missing",
          required: true,
          detail: "Install the boat CLI on the machine that runs bb. It signs you in and starts your trial. Installed somewhere else? Set boat CLI location in this plugin's settings.",
          fix: { text: "Run this in a terminal, then check again.", command: INSTALL_COMMAND, url: "https://boat.dev", action: "check-again" },
        },
  );

  // 2. Signed in.
  const signIn: SetupFix = { text: "Sign in to boat.dev: run this in a terminal, then check again.", command: SIGN_IN_COMMAND, action: "sign-in" };
  if (!facts.cli.found) checks.push({ id: "signed-in", label: "Signed in to boat.dev", state: "unknown", required: true, detail: needsCli });
  else if (facts.account.signedIn === true) {
    checks.push({ id: "signed-in", label: "Signed in to boat.dev", state: "ok", required: true, detail: facts.account.identifier ? `Signed in as ${facts.account.identifier}` : "Signed in" });
  } else if (facts.account.signedIn === false) {
    checks.push({ id: "signed-in", label: "Signed in to boat.dev", state: "missing", required: true, detail: "Not signed in yet.", fix: signIn });
  } else {
    checks.push({
      id: "signed-in",
      label: "Signed in to boat.dev",
      state: "unknown",
      required: true,
      detail: `Couldn't reach boat.dev${facts.account.error ? `: ${facts.account.error}` : ""}.`,
      fix: { text: "Check again in a moment.", action: "check-again" },
    });
  }

  // 3. The plan.
  const plan = facts.plan;
  if (!signedIn) checks.push({ id: "plan", label: "Boat plan", state: "unknown", required: true, detail: facts.cli.found ? needsSignIn : needsCli });
  else if (plan === null) {
    checks.push({ id: "plan", label: "Boat plan", state: "unknown", required: true, detail: `Couldn't read your plan${facts.planError ? `: ${facts.planError}` : ""}.`, fix: { text: "Check again in a moment.", action: "check-again" } });
  } else if (plan.checkoutRequired) {
    checks.push({
      id: "plan",
      label: "Boat plan",
      state: "missing",
      required: true,
      detail: "Your boat.dev account has no plan yet, so it can't start sandboxes.",
      fix: { text: "Start a boat plan (7-day trial, card required): run this in a terminal, or open boat.dev.", command: PLAN_COMMAND, url: DASHBOARD_URL },
    });
  } else if (!plan.canStart) {
    checks.push({
      id: "plan",
      label: "Boat plan",
      state: "missing",
      required: true,
      detail: `boat won't start sandboxes right now${plan.startBlockedReason ? `: ${plan.startBlockedReason}` : ""}.`,
      fix: { text: "Run `boat limits --all` for details, or start a bigger plan.", command: "boat billing plan", url: DASHBOARD_URL },
    });
  } else if (plan.startsLeftToday === 0) {
    checks.push({ id: "plan", label: "Boat plan", state: "warning", required: true, detail: `${planLine(plan)}. No sandbox starts left today; they come back tomorrow.` });
  } else {
    checks.push({ id: "plan", label: "Boat plan", state: "ok", required: true, detail: planLine(plan) });
  }

  // 4. The agents (the logins of the environment new sandboxes use).
  const environment = environmentFor(facts, settings.environment);
  const detected = detectAgents(facts, settings.environment);
  const profile = profileFor(facts, environment);
  const connected = profile === null ? null : agentsFromConnected(profile.connected);
  if (!signedIn) checks.push({ id: "agents", label: "Coding agents", state: "unknown", required: true, detail: facts.cli.found ? needsSignIn : needsCli });
  else if (connected === null) {
    checks.push({
      id: "agents",
      label: "Coding agents",
      state: "unknown",
      required: true,
      detail: `Couldn't read your agent logins from boat.dev${facts.profilesError ? `: ${facts.profilesError}` : ""}.`,
      fix: { text: "Check again in a moment.", action: "check-again" },
    });
  } else if (connected.length === 0) {
    checks.push({
      id: "agents",
      label: "Coding agents",
      state: "missing",
      required: true,
      detail: "No Claude or ChatGPT login is connected in boat.dev. Agents use your own subscriptions.",
      fix: { text: "Connect Claude or ChatGPT on boat.dev → Agents, then check again.", url: AGENTS_URL, action: "check-again" },
    });
  } else if (detected !== null && detected.length === 0) {
    // One cause, one fix: the Boat environment row says what to change.
    checks.push({
      id: "agents",
      label: "Coding agents",
      state: environment?.passAgentsCredentials === false ? "unknown" : "missing",
      required: true,
      detail: `${agentList(connected)} ${connected.length === 1 ? "is" : "are"} connected in boat.dev, but your boat environment hides agent logins from sandboxes. Fix the Boat environment first.`,
      ...(environment?.passAgentsCredentials === false ? {} : { fix: { text: safetyHint(environment?.name ?? "<environment>"), url: ENVIRONMENT_URL, action: "check-again" as const } }),
    });
  } else {
    const have = detected ?? connected;
    const wanted = settings.agents === "auto" ? have : choiceAgents(settings.agents);
    const missing = wanted.filter((agent) => !have.includes(agent));
    if (settings.agents !== "auto" && missing.length > 0) {
      const lost = missing.map((agent) => AGENT_NAME[agent]).join(" and ");
      checks.push({
        id: "agents",
        label: "Coding agents",
        state: "warning",
        required: true,
        detail: `boat.dev has ${have.length === 1 ? "only " : ""}${agentList(have)} connected, but Coding agents is set to ${settings.agents === "both" ? "Claude and Codex" : `only ${AGENT_NAME[settings.agents]}`}. Work sent to ${lost} would fail (unless bb's Account Pooler logs it in).`,
        fix: { text: "Use Auto-detect", action: "use-detected-agents" },
      });
    } else {
      const chosen = settings.agents !== "auto" && wanted.length < have.length ? ` You chose only ${agentList(wanted)}.` : "";
      checks.push({ id: "agents", label: "Coding agents", state: "ok", required: true, detail: `${agentList(have)} connected in boat.dev.${chosen}` });
    }
  }

  // 5. The environment: "Safe for third parties" hides logins and GitHub.
  const named = settings.environment.trim();
  if (!signedIn) checks.push({ id: "environment", label: "Boat environment", state: "unknown", required: true, detail: facts.cli.found ? needsSignIn : needsCli });
  else if (facts.environments === null) {
    checks.push({ id: "environment", label: "Boat environment", state: "unknown", required: true, detail: `Couldn't read your boat environments${facts.environmentsError ? `: ${facts.environmentsError}` : ""}.`, fix: { text: "Check again in a moment.", action: "check-again" } });
  } else if (environment === null) {
    checks.push(
      named !== ""
        ? {
            id: "environment",
            label: "Boat environment",
            state: "missing",
            required: true,
            detail: `The boat environment "${named}" (in this plugin's settings) doesn't exist.`,
            fix: { text: `Create it, or clear Boat environment in the settings to use your default.`, command: `boat env new ${named}`, url: ENVIRONMENT_URL },
          }
        : { id: "environment", label: "Boat environment", state: "ok", required: true, detail: "boat's default environment." },
    );
  } else {
    const which = `"${environment.name}"${environment.isDefault && named === "" ? " (your default)" : ""}`;
    const hidden = [
      environment.passAgentsCredentials === false ? "agent logins" : null,
      environment.passGithub === false ? "GitHub" : null,
    ].filter(Boolean);
    if (environment.passAgentsCredentials === false) {
      checks.push({
        id: "environment",
        label: "Boat environment",
        state: "missing",
        required: true,
        detail: `${which} ${environment.safeForThirdParties ? 'is set to "Safe for third parties", so sandboxes get' : "gives sandboxes"} no ${hidden.join(" and no ")}.`,
        fix: {
          // The command is in the Copy block below: say it once.
          text: environment.safeForThirdParties ? SAFETY_TEXT : `Turn on agent logins for it on boat.dev → Environment.`,
          ...(environment.safeForThirdParties ? { command: `boat env set ${environment.name} --safe-for-third-parties false` } : {}),
          url: ENVIRONMENT_URL,
        },
      });
    } else if (environment.passGithub === false) {
      checks.push({
        id: "environment",
        label: "Boat environment",
        state: "warning",
        required: true,
        detail: `${which} gives sandboxes no GitHub login, so tasks can't clone private repos or open pull requests.`,
        fix: { text: environment.safeForThirdParties ? safetyHint(environment.name) : "Turn on GitHub for it on boat.dev → Environment.", url: ENVIRONMENT_URL },
      });
    } else {
      checks.push({ id: "environment", label: "Boat environment", state: "ok", required: true, detail: `${which}: agent logins and GitHub reach sandboxes.` });
    }
  }

  // 6. GitHub: only a sandbox can tell; the last check of a repo says what it saw.
  const access = context.repoAccess;
  const githubFix: SetupFix = { text: "Connect GitHub on boat.dev → Environment and give boat access to your repos.", url: ENVIRONMENT_URL };
  if (access === null) {
    checks.push({ id: "github", label: "GitHub access", state: "unknown", required: false, detail: "Not checked yet. Your first task on a repo checks it.", fix: githubFix });
  } else if (access.access === "write" || access.access === "read") {
    checks.push({ id: "github", label: "GitHub access", state: "ok", required: false, detail: `Last check: boat ${access.access === "write" ? "can push to" : "can read (not push to)"} ${access.repo}.` });
  } else {
    checks.push({
      id: "github",
      label: "GitHub access",
      state: "warning",
      required: false,
      detail: `Last check on ${access.repo}: ${access.access === "expired" ? "the sandbox's GitHub login had expired" : (access.detail ?? "no access")}`.replace(/\.?$/, "."),
      fix: access.access === "expired" ? { text: "Run `boat env upgrade <environment>` to give sandboxes fresh credentials." } : githubFix,
    });
  }

  // 7. bb Connect: only when task chats (or cloud orchestrators) need it.
  const connect = context.connect;
  const connectWhy = "Needed for task chats and cloud orchestrators.";
  if (connect?.state === "ready") checks.push({ id: "connect", label: "bb Connect", state: "ok", required: settings.connectNeeded, detail: `On. ${connectWhy}` });
  else if (settings.connectNeeded && connect?.state === "off") {
    checks.push({
      id: "connect",
      label: "bb Connect",
      state: "missing",
      required: true,
      detail: `Off. Tasks are set to run as chats, which need it.`,
      fix: { text: connect.fix ?? "Turn on bb Connect: sign in with `bb account login`, then run `bb connect on`.", action: "check-again" },
    });
  } else if (settings.connectNeeded) {
    checks.push({ id: "connect", label: "bb Connect", state: "unknown", required: false, detail: `Couldn't tell if it's on. ${connectWhy}` });
  } else {
    checks.push({ id: "connect", label: "bb Connect", state: "optional", required: false, detail: `${connect?.state === "off" ? "Off. " : ""}Only for task chats and cloud orchestrators.` });
  }

  // 8. gh on this computer: only for project rules files and your own uploader script.
  const gh = context.gh;
  if (!settings.ghNeeded || gh === null) {
    checks.push({ id: "gh", label: "GitHub CLI on this computer", state: "optional", required: false, detail: "Only for project rules files and your own uploader script." });
  } else if (gh.state === "ok") {
    checks.push({ id: "gh", label: "GitHub CLI on this computer", state: "ok", required: false, detail: "Signed in. Reads project rules files and your uploader script." });
  } else {
    checks.push({
      id: "gh",
      label: "GitHub CLI on this computer",
      state: gh.state === "unknown" ? "unknown" : "warning",
      required: false,
      detail: `${gh.state === "not-installed" ? "Not installed" : gh.state === "signed-out" ? "Not signed in" : "Couldn't run it"}. Your projects' rules files or your uploader script need it.`,
      fix: gh.state === "not-installed" ? { text: "Install it, then sign in.", url: "https://cli.github.com" } : { text: "Sign in to GitHub on this computer.", command: "gh auth login" },
    });
  }
  return checks;
}

/** Ready unless a required check is missing. */
export function setupOk(checks: readonly SetupCheck[]): boolean {
  return checks.every((check) => !check.required || check.state !== "missing");
}

export function summaryLine(checks: readonly SetupCheck[]): string {
  const failing = checks.filter((check) => check.required && check.state === "missing");
  if (failing.length > 0) {
    return `Setup: ${failing.length === 1 ? "1 thing" : `${failing.length} things`} to fix (${failing.map((check) => check.label).join(", ")}). Run \`bb boat doctor\`.`;
  }
  const warnings = checks.filter((check) => check.state === "warning");
  const unknown = checks.filter((check) => check.required && check.state === "unknown");
  const notes = [
    warnings.length > 0 ? `check ${warnings.map((check) => check.label).join(", ")}` : null,
    unknown.length > 0 ? `couldn't check ${unknown.map((check) => check.label).join(", ")}` : null,
  ].filter(Boolean);
  return notes.length > 0 ? `Setup: ready, but ${notes.join("; ")}. Run \`bb boat doctor\`.` : "Setup: ready.";
}

const ICON: Record<CheckState, string> = { ok: "✓", missing: "✗", warning: "!", unknown: "?", optional: "–" };

/** The checklist as text (`bb boat doctor`). */
export function doctorText(status: SetupStatus): string {
  const lines = [status.summary.replace(/ Run `bb boat doctor`\.$/, ""), ""];
  for (const check of status.checks) {
    lines.push(`${ICON[check.state]} ${check.label}: ${check.detail}`);
    if (check.fix && check.state !== "ok") {
      lines.push(`    ${check.fix.text}${check.fix.command ? `\n    $ ${check.fix.command}` : ""}${check.fix.url ? `\n    ${check.fix.url}` : ""}`);
    }
  }
  return lines.join("\n");
}

export function buildStatus(facts: BoatFacts, context: CheckContext): SetupStatus {
  const checks = buildChecks(facts, context);
  const environment = environmentFor(facts, context.settings.environment);
  const detected = detectAgents(facts, context.settings.environment);
  return {
    ok: setupOk(checks),
    checkedAt: new Date(facts.at).toISOString(),
    summary: summaryLine(checks),
    checks,
    agents: { setting: context.settings.agents, detected, effective: effectiveAgents(context.settings.agents, detected) },
    plan: facts.plan,
    environment: environment === null ? null : { name: environment.name, isDefault: environment.isDefault, safeForThirdParties: environment.safeForThirdParties },
  };
}

// ---------------------------------------------------------------- the checks before a sandbox

export interface PreflightInput {
  /** The agent the work uses (checked against the environment's logins). */
  agent?: Provider | null;
  /** boat: headless in boat (boat's logins only); chat: a bb chat (bb's Account Pooler may log it in). */
  runner?: "boat" | "chat";
  /** The environment for a new sandbox (null: the setting, else boat's default). */
  environment?: string | null;
  /** A new sandbox will be created: the plan must allow starts. */
  newSandbox?: boolean;
}

export interface SetupProblem {
  message: string;
  hint: string;
}

/** Why work can't start with this setup (null: nothing known stands in the way). Unknowns never block. */
export function preflightProblem(facts: BoatFacts, settings: SetupSettings, input: PreflightInput): SetupProblem | null {
  if (!facts.cli.found) return { message: "The boat CLI isn't installed on the machine that runs bb.", hint: INSTALL_HINT };
  if (facts.account.signedIn === false) return { message: "You're not signed in to boat.dev.", hint: SIGN_IN_HINT };
  if (input.newSandbox && facts.plan !== null) {
    if (facts.plan.checkoutRequired) return { message: "Your boat.dev account has no plan yet, so it can't start sandboxes.", hint: PLAN_HINT };
    if (!facts.plan.canStart) {
      return {
        message: `boat won't start sandboxes right now${facts.plan.startBlockedReason ? `: ${facts.plan.startBlockedReason}` : ""}.`,
        hint: `Run \`boat limits --all\` for details, or start a bigger plan (\`boat billing plan\`, ${DASHBOARD_URL}).`,
      };
    }
  }
  const agent = input.agent ?? null;
  if (agent === null) return null;
  const environmentName = input.environment?.trim() || settings.environment;
  const environment = environmentFor(facts, environmentName);
  if (environment?.passAgentsCredentials === false) {
    return {
      message: `Your boat environment "${environment.name}" doesn't pass agent logins to sandboxes${environment.safeForThirdParties ? ' ("Safe for third parties")' : ""}.`,
      hint: environment.safeForThirdParties ? safetyHint(environment.name) : "Turn on agent logins for it on boat.dev → Environment.",
    };
  }
  const profile = profileFor(facts, environment);
  if (profile === null) return null;
  const connected = agentsFromConnected(profile.connected);
  if (connected.length === 0) {
    return { message: "No Claude or ChatGPT login is connected in boat.dev.", hint: agentsHint() };
  }
  // A chat may get its login from bb's Account Pooler: a hand-picked agent is trusted there.
  if (!connected.includes(agent) && (input.runner !== "chat" || settings.agents === "auto")) {
    const other = connected.find((entry) => entry !== agent);
    return {
      message: `${AGENT_NAME[agent]} isn't connected in boat.dev${other ? ` (only ${AGENT_NAME[other]} is)` : ""}.`,
      hint: `${agentsHint([agent])}${other ? ` Or run it with ${AGENT_NAME[other]}${settings.agents === "auto" ? "" : " (set Coding agents to Auto-detect)"}.` : ""}`,
    };
  }
  return null;
}

/**
 * Why a chat can't run on a Boat sandbox machine (null: it can). The machine
 * needs a signed-in boat with a plan, an agent login (unless one was picked by
 * hand: bb's Account Pooler may log chats in), and bb Connect.
 */
export function machineProblem(facts: BoatFacts, settings: SetupSettings, connect: ConnectStatus | null): string | null {
  if (!facts.cli.found) return `Install the boat CLI on the machine that runs bb: run \`${INSTALL_COMMAND}\` in a terminal.`;
  if (facts.account.signedIn === false) return SIGN_IN_HINT;
  if (facts.plan?.checkoutRequired) return PLAN_HINT;
  const detected = detectAgents(facts, settings.environment);
  if (settings.agents === "auto" && detected !== null && detected.length === 0) {
    return `Connect Claude or ChatGPT on boat.dev → Agents (${AGENTS_URL}), and check that your boat environment passes agent logins to sandboxes.`;
  }
  if (connect?.state === "off") return `A chat in a Boat sandbox reaches this bb through bb Connect, which is off. ${connect.fix ?? "Run `bb connect on`."}`;
  return null;
}

// ---------------------------------------------------------------- the test task

export const TEST_TASK_TITLE = "Test task";
export const TEST_TASK_BRIEF =
  "Report the output of `uname -a`, `node --version`, `git --version` and whether GitHub access works (`gh auth status`). Change nothing.";

/**
 * A task with no repo, headless in boat on a small sandbox: it proves sign-in,
 * the plan and the agent's login without touching any code.
 */
export function testTaskInput(notifyThreadId: string | null): StartTaskInput {
  return {
    title: TEST_TASK_TITLE,
    role: "custom",
    brief: TEST_TASK_BRIEF,
    repo: null,
    project: null,
    runner: "boat",
    sandbox: "new",
    machineType: "small",
    tier: "light",
    reason: "Test task: checks the setup",
    // It makes no screenshots, and a failing uploader would read like a setup problem.
    evidence: false,
    // It proves the peak-memory measurement works too.
    measureMemory: true,
    orchestratorThreadId: notifyThreadId,
  };
}

// ---------------------------------------------------------------- explaining errors

export interface ExplainedError {
  code: string;
  message: string;
  hint: string | null;
}

/** Which login a boat error is about, from its text. */
function loginFromText(text: string): Provider[] {
  const claude = /claude|anthropic/i.test(text);
  const codex = /codex|openai|chatgpt|gpt/i.test(text);
  return claude && !codex ? ["claude"] : codex && !claude ? ["codex"] : ["claude", "codex"];
}

/** boat's errors in plain words, with what to do (the CLI, the page and agent tools share them). */
export function explainBoatError(error: BoatError): ExplainedError {
  const text = `${error.code} ${error.message}`;
  if (error.code === "boat_not_found") return { code: error.code, message: "The boat CLI was not found.", hint: INSTALL_HINT };
  if (error.code === "unauthorized" || error.status === 401) return { code: "unauthorized", message: "You're not signed in to boat.dev.", hint: SIGN_IN_HINT };
  if (error.code === "provider_not_configured") return { code: error.code, message: `boat: ${error.message}`, hint: agentsHint(loginFromText(error.message)) };
  if (!/snapshot/i.test(text) && (/checkout_required|payment_required|plan_required|no_plan|subscription_required/.test(error.code) || error.status === 402)) {
    return { code: error.code, message: `boat: ${error.message}`, hint: PLAN_HINT };
  }
  return { code: error.code, message: `boat: ${error.message}`, hint: null };
}

// ---------------------------------------------------------------- the cached reader

export interface SetupDeps {
  /** The boat binary, or null when it isn't installed. */
  binary(): Promise<string | null>;
  /** Runs `boat <args> --json` (BoatCli.run). */
  run(args: string[], options?: BoatRunOptions): Promise<BoatRunResult>;
  settings(): Promise<SetupSettings>;
  connect?: ConnectCheck;
  /** The newest repo access check (store.latestRepoAccess). */
  repoAccess?(): RepoAccessFacts | null;
  gh?(): Promise<GhFacts>;
  /** The plugin loaded without the CLI (bb's "needs configuration" stays until a reload). */
  startedWithoutCli?(): boolean;
  cacheMs?: number;
  timeoutMs?: number;
}

export interface Setup {
  /** The checklist (cached about a minute; force reads boat again). */
  status(options?: { force?: boolean }): Promise<SetupStatus>;
  /** The newest reading, without waiting (null: none yet); a stale one is refreshed in the background. */
  peek(): SetupStatusLite | null;
  /** boat's facts (cached about a minute). */
  reading(options?: { force?: boolean }): Promise<BoatFacts>;
  /** Agents boat has for this environment (null: unknown). Waits only for the very first reading. */
  detectedAgents(environment: string | null | undefined): Promise<Provider[] | null>;
  /**
   * Agents boat last reported as not connected, while the current reading
   * can't tell (Auto-detect only): the relay never moves an orchestrator to one.
   */
  lastMissingAgents(environment: string | null | undefined): Provider[];
  /** Throws a setup_required error with the fix when the setup can't run this work. */
  preflight(input: PreflightInput): Promise<void>;
  /** Forget the reading (after a fix). */
  invalidate(): void;
}

/** What `peek` returns: the facts and when they were read. */
export interface SetupStatusLite {
  facts: BoatFacts;
}

/** The refusal for work the setup can't run (code setup_required, the fix as its hint). */
export function setupRequired(problem: SetupProblem): TaskError {
  return new TaskError(problem.message, "setup_required", `${problem.hint} ${DOCTOR_HINT}`);
}

const CACHE_MS = 60_000;

function errorText(error: unknown): string {
  if (error instanceof BoatError && (error.code === "unauthorized" || error.status === 401)) return "not signed in";
  return error instanceof Error ? error.message : String(error);
}

/** Read boat once: every command is read-only and never allocates anything. */
export async function readBoatFacts(deps: Pick<SetupDeps, "binary" | "run" | "timeoutMs">): Promise<BoatFacts> {
  const at = Date.now();
  const empty: BoatFacts = {
    at,
    cli: { found: false, version: null },
    account: { signedIn: null, identifier: null, plan: null, error: null },
    plan: null,
    planError: null,
    environments: null,
    environmentsError: null,
    profiles: null,
    profilesError: null,
  };
  const binary = await deps.binary().catch(() => null);
  if (binary === null) return empty;
  const options = { timeoutMs: deps.timeoutMs ?? 20_000 };
  const json = async (args: string[]) => {
    const result = await deps.run(args, options);
    const last = result.records.at(-1);
    if (last === undefined) throw new BoatError(`boat ${args.join(" ")} printed no JSON`, { code: "boat_bad_output" });
    return last;
  };
  const [version, status] = await Promise.all([
    deps
      .run(["--version"], { ...options, allowFailure: true })
      .then((result) => parseVersion(result.stdout))
      .catch(() => null),
    json(["status"]).then(
      (raw) => ({ account: parseAccount(raw), error: null as string | null }),
      (error: unknown) => ({ account: null, error: errorText(error) }),
    ),
  ]);
  const facts: BoatFacts = {
    ...empty,
    cli: { found: true, version },
    account: status.account ?? { ...empty.account, error: status.error },
  };
  // Signed out: the other commands answer 401.
  if (facts.account.signedIn !== true) return facts;
  // (Not named "environments": bb's load-time scan would read `.status` on it as a retired SDK API.)
  const [planResult, envList, profileList] = await Promise.allSettled([json(["limits"]), json(["env", "list"]), json(["ai", "profiles"])]);
  if (planResult.status === "fulfilled") facts.plan = parsePlan(planResult.value, facts.account.plan);
  else facts.planError = errorText(planResult.reason);
  if (envList.status === "fulfilled") facts.environments = parseEnvironments(envList.value);
  else facts.environmentsError = errorText(envList.reason);
  if (profileList.status === "fulfilled") facts.profiles = parseProfiles(profileList.value);
  else facts.profilesError = errorText(profileList.reason);
  return facts;
}

export function createSetup(deps: SetupDeps): Setup {
  const cacheMs = deps.cacheMs ?? CACHE_MS;
  let cache: BoatFacts | null = null;
  let inflight: Promise<BoatFacts> | null = null;
  /** The newest reading that knew the agents (for lastMissingAgents). */
  let lastKnown: BoatFacts | null = null;

  function read(): Promise<BoatFacts> {
    if (inflight === null) {
      inflight = readBoatFacts(deps)
        .then((facts) => {
          cache = facts;
          if (facts.profiles !== null && facts.environments !== null) lastKnown = facts;
          return facts;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  async function facts(force = false): Promise<BoatFacts> {
    if (!force && cache !== null && Date.now() - cache.at < cacheMs) return cache;
    return read();
  }

  let ghCache: { at: number; value: GhFacts } | null = null;
  async function ghFacts(force: boolean): Promise<GhFacts | null> {
    if (!deps.gh) return null;
    if (force || ghCache === null || Date.now() - ghCache.at >= cacheMs) {
      ghCache = { at: Date.now(), value: await deps.gh().catch(() => ({ state: "unknown" as const, detail: null })) };
    }
    return ghCache.value;
  }

  async function context(settings: SetupSettings, force: boolean): Promise<CheckContext> {
    const connect = deps.connect ? await deps.connect().catch(() => null) : null;
    const gh = settings.ghNeeded ? await ghFacts(force) : null;
    return { settings, connect, repoAccess: deps.repoAccess?.() ?? null, gh, reloadNeeded: deps.startedWithoutCli?.() ?? false };
  }

  return {
    async status(options = {}) {
      const [reading, settings] = await Promise.all([facts(options.force === true), deps.settings()]);
      return buildStatus(reading, await context(settings, options.force === true));
    },

    peek() {
      if (cache === null || Date.now() - cache.at >= cacheMs) void read().catch(() => undefined);
      return cache === null ? null : { facts: cache };
    },

    reading(options = {}) {
      return facts(options.force === true);
    },

    async detectedAgents(environment) {
      const reading = cache ?? (await facts().catch(() => null));
      if (cache !== null && Date.now() - cache.at >= cacheMs) void read().catch(() => undefined);
      return reading === null ? null : detectAgents(reading, environment);
    },

    lastMissingAgents(environment) {
      if (cache !== null && detectAgents(cache, environment) !== null) return [];
      const known = lastKnown === null ? null : detectAgents(lastKnown, environment);
      if (known === null || known.length === 0) return [];
      return (["claude", "codex"] as const).filter((agent) => !known.includes(agent));
    },

    async preflight(input) {
      const settings = await deps.settings();
      let problem = preflightProblem(await facts(), settings, input);
      if (problem === null) return;
      // Read boat again before refusing: the user may have just fixed it.
      problem = preflightProblem(await facts(true), settings, input);
      if (problem !== null) throw setupRequired(problem);
    },

    invalidate() {
      cache = null;
    },
  };
}
