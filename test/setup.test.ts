// Setup checks: boat's JSON (real shapes in fixtures/boat-json), the
// checklist, the checks before a sandbox, and the cached reader.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BoatError, type BoatCli, type BoatRunResult, type JsonRecord } from "../src/boat.ts";
import {
  AGENTS_URL,
  INSTALL_COMMAND,
  PLAN_COMMAND,
  agentsFromConnected,
  buildChecks,
  buildStatus,
  createSetup,
  detectAgents,
  doctorText,
  effectiveAgents,
  explainBoatError,
  machineProblem,
  parseAccount,
  parseEnvironments,
  parsePlan,
  parseProfiles,
  parseVersion,
  preflightProblem,
  readBoatFacts,
  setupOk,
  summaryLine,
  testTaskInput,
  type BoatFacts,
  type CheckContext,
  type SetupSettings,
} from "../src/setup.ts";
import { TaskError } from "../src/service.ts";
import { BoatApi, TRIAL_AUTO_STOP_HOURS, autoStopCapFromLimits, autoStopCapFromText, parseAiProxy, withinAutoStopCap } from "../src/boat-api.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/boat-json/${name}`, import.meta.url), "utf8")) as JsonRecord;

/** Facts from the real shapes: signed in, Standard plan, both agents, a "base" default environment. */
function facts(overrides: Partial<BoatFacts> = {}): BoatFacts {
  const account = parseAccount(fixture("status-signed-in.json"));
  return {
    at: Date.now(),
    cli: { found: true, version: "1.0.89" },
    account,
    plan: parsePlan(fixture("limits-standard.json"), account.plan),
    planError: null,
    environments: parseEnvironments(fixture("env-list.json")),
    environmentsError: null,
    profiles: parseProfiles(fixture("ai-profiles.json")),
    profilesError: null,
    ...overrides,
  };
}

const SETTINGS: SetupSettings = { agents: "auto", environment: "", connectNeeded: false, ghNeeded: false };
const context = (settings: Partial<SetupSettings> = {}, extra: Partial<CheckContext> = {}): CheckContext => ({
  settings: { ...SETTINGS, ...settings },
  connect: { state: "off", fix: "Run `bb connect on`." },
  repoAccess: null,
  gh: null,
  ...extra,
});
const check = (list: ReturnType<typeof buildChecks>, id: string) => list.find((entry) => entry.id === id)!;
const withProfile = (connected: string[]) => facts({ profiles: [{ id: "prof_default", name: "default", isDefault: true, personal: true, connected }] });

test("boat's JSON parses as the plugin needs it (real shapes, no variable values kept)", () => {
  assert.equal(parseVersion("boat 1.0.89\n"), "1.0.89");
  assert.deepEqual(parseAccount(fixture("status-signed-in.json")), { signedIn: true, identifier: "you@example.com", plan: "Standard", error: null });
  assert.equal(parseAccount(fixture("status-signed-out.json")).signedIn, false);

  const plan = parsePlan(fixture("limits-standard.json"), "Standard");
  assert.equal(plan.name, "Standard");
  assert.equal(plan.trial, false);
  assert.equal(plan.checkoutRequired, false);
  assert.equal(plan.canStart, true);
  assert.equal(plan.maxActiveSandboxes, 100);
  assert.equal(plan.startsLeftToday, 180);
  assert.equal(plan.startsPerDay, 200);
  assert.equal(plan.vmHoursRemaining, 550);
  assert.equal(plan.extraStartsEnabled, false);
  assert.deepEqual(plan.machineTypes.at(-1), { type: "xlarge", available: false, reason: "needs the $100/month plan or higher" });
  // A paid plan has no cap on the auto-stop.
  assert.equal(plan.autoStopCapHours, null);

  const environments = parseEnvironments(fixture("env-list.json"));
  assert.deepEqual(environments[0], {
    name: "base",
    isDefault: true,
    safeForThirdParties: false,
    passAgentsCredentials: true,
    passGithub: true,
    passSecrets: true,
    passSandboxCredentials: true,
    credentialProfileId: null,
  });
  assert.doesNotMatch(JSON.stringify(environments), /fake_value|EXAMPLE_TOKEN/, "variable values are dropped");

  const profiles = parseProfiles(fixture("ai-profiles.json"));
  assert.deepEqual(profiles, [{ id: "prof_default", name: "default", isDefault: true, personal: true, connected: ["claude-subscription", "chatgpt-subscription"] }]);
});

test("the effective toggles count, not the raw ones (Safe for third parties)", () => {
  const raw = fixture("env-list.json");
  const environments = raw.environments as JsonRecord[];
  environments[0] = { ...environments[0], safeForThirdParties: true, passGithub: true, passAgentsCredentials: true, effective: { passAgentsCredentials: false, passGithub: false, passSecrets: false } };
  const [base] = parseEnvironments(raw);
  assert.equal(base!.passGithub, false);
  assert.equal(base!.passAgentsCredentials, false);
  assert.equal(base!.passSandboxCredentials, true, "the raw toggle when effective doesn't say");
  environments[0] = { ...environments[0], effective: { passSandboxCredentials: false }, passSandboxCredentials: true };
  assert.equal(parseEnvironments(raw)[0]!.passSandboxCredentials, false);
  environments[0] = { name: "bare" };
  assert.equal(parseEnvironments(raw)[0]!.passSandboxCredentials, null, "unknown, not false");
});

test("boat credentials and the AI proxy, as boat reports them (env info, `boat ai proxy`)", async () => {
  assert.equal(parseAiProxy({ enabled: true, pricing: { dailyDollars: 0 } }), true);
  assert.equal(parseAiProxy({ enabled: false }), false);
  assert.equal(parseAiProxy({ proxy: { enabled: true } }), true);
  assert.equal(parseAiProxy({ state: "off" }), false);
  assert.equal(parseAiProxy({ event: "error", code: "api_key_action_forbidden" }), null);

  const seen: string[][] = [];
  const answers: Record<string, JsonRecord> = {
    "ai proxy": { enabled: false },
    "env info web": {
      environment: {
        name: "web",
        envContents: "EXAMPLE_TOKEN=fake_value_123\n",
        effective: { passAgentsCredentials: true, passGithub: true, passSecrets: true, passSandboxCredentials: false },
        passSandboxCredentials: true,
        proxyAiCredentials: false,
        safeForThirdParties: false,
      },
    },
  };
  const api = new BoatApi({
    json: async (args: string[]) => {
      seen.push(args);
      return answers[args.join(" ")]!;
    },
  } as unknown as BoatCli);
  assert.equal(await api.aiProxy(), false);
  // Only shown: no on or off.
  assert.deepEqual(seen[0], ["ai", "proxy"]);
  const info = await api.environmentInfo("web");
  assert.equal(info.passSandboxCredentials, false, "the effective toggle wins");
  assert.equal(info.passAgentsCredentials, true);
  assert.deepEqual(info.secretNames, ["EXAMPLE_TOKEN"]);
  assert.doesNotMatch(JSON.stringify(info), /fake_value/);
});

test("agents come from the environment's credential profile", () => {
  assert.deepEqual(agentsFromConnected(["claude-subscription", "chatgpt-subscription"]), ["claude", "codex"]);
  assert.deepEqual(agentsFromConnected(["anthropic-api-key"]), ["claude"]);
  assert.deepEqual(agentsFromConnected(["openai-api-key", "kimi-subscription"]), ["codex"]);
  assert.deepEqual(agentsFromConnected([]), []);
  assert.deepEqual(detectAgents(facts(), ""), ["claude", "codex"]);
  // A named environment with its own profile.
  const own = facts({
    environments: [
      ...parseEnvironments(fixture("env-list.json")).map((env) => (env.name === "web" ? { ...env, credentialProfileId: "prof_team" } : env)),
    ],
    profiles: [
      ...parseProfiles(fixture("ai-profiles.json")),
      { id: "prof_team", name: "team", isDefault: false, personal: false, connected: ["openai-api-key"] },
    ],
  });
  assert.deepEqual(detectAgents(own, "web"), ["codex"]);
  assert.deepEqual(detectAgents(own, ""), ["claude", "codex"]);
  // Signed out or unreadable: unknown.
  assert.equal(detectAgents(facts({ account: { signedIn: false, identifier: null, plan: null, error: null } }), ""), null);
  assert.equal(detectAgents(facts({ profiles: null, profilesError: "timeout" }), ""), null);

  assert.equal(effectiveAgents("auto", ["claude"]), "claude");
  assert.equal(effectiveAgents("auto", ["claude", "codex"]), "both");
  assert.equal(effectiveAgents("auto", null), "both", "unknown behaves like both");
  assert.equal(effectiveAgents("auto", []), "both");
  assert.equal(effectiveAgents("codex", ["claude"]), "codex", "a manual choice wins");
});

/** The fixture's environments with boat credentials off (boat passes them by default). */
const withoutBoatLogin = () => parseEnvironments(fixture("env-list.json")).map((env) => ({ ...env, passSandboxCredentials: false }));

test("a working setup reads ready, with plain details", () => {
  const status = buildStatus(facts({ environments: withoutBoatLogin() }), context());
  assert.equal(status.ok, true);
  assert.equal(status.summary, "Setup: ready.");
  assert.deepEqual(
    status.checks.map((entry) => [entry.id, entry.state]),
    [
      ["cli", "ok"],
      ["signed-in", "ok"],
      ["plan", "ok"],
      ["agents", "ok"],
      ["environment", "ok"],
      ["boat-credentials", "ok"],
      ["github", "unknown"],
      ["connect", "optional"],
      ["gh", "optional"],
    ],
  );
  assert.equal(check(status.checks, "cli").detail, "boat 1.0.89 found");
  assert.equal(check(status.checks, "signed-in").detail, "Signed in as you@example.com");
  assert.equal(check(status.checks, "plan").detail, "Standard plan · 100 sandboxes at once · 550 sandbox hours left");
  assert.equal(check(status.checks, "agents").detail, "Claude and Codex connected in boat.dev.");
  assert.match(check(status.checks, "environment").detail, /^"base" \(your default\): agent logins and GitHub reach sandboxes/);
  assert.match(check(status.checks, "github").detail, /Not checked yet/);
  assert.equal(check(status.checks, "boat-credentials").detail, "Your tasks' environments don't pass boat credentials into sandboxes.");
  assert.deepEqual(status.agents, { setting: "auto", detected: ["claude", "codex"], effective: "both" });
  assert.deepEqual(status.environment, { name: "base", isDefault: true, safeForThirdParties: false });
});

test("boat credentials in the environments workers use: a warning with the fix, never a failure", () => {
  // boat passes them by default (the fixture's "base").
  const status = buildStatus(facts(), context());
  const boatLogin = check(status.checks, "boat-credentials");
  assert.equal(boatLogin.state, "warning");
  assert.equal(boatLogin.required, false);
  assert.equal(
    boatLogin.detail,
    '"base" (your default) passes boat credentials into sandboxes: your boat CLI login, for your whole account. Workers there can start, stop and delete any of your sandboxes. The plugin doesn\'t need them: it runs boat on the machine that runs bb, and task chats and cloud orchestrators reach it through bb Connect.',
  );
  assert.equal(boatLogin.fix?.command, "boat env set base --boat-credentials false");
  assert.match(boatLogin.fix!.text, /`boat api-key create --env <env id> --actions <only what's needed> --ttl <short>`/);
  assert.match(boatLogin.fix!.text, /stored as a secret variable of that environment/);
  assert.equal(status.ok, true, "a warning doesn't block");
  assert.equal(status.summary, "Setup: ready, but check boat login in sandboxes. Run `bb boat doctor`.");
  assert.equal(preflightProblem(facts(), SETTINGS, { agent: "claude", runner: "boat", newSandbox: true }), null, "work still starts");
  const text = doctorText(status);
  assert.match(text, /^Setup: ready, but check boat login in sandboxes\.\n/);
  assert.match(text, /\n! boat login in sandboxes: "base" \(your default\) passes boat credentials/);
  assert.match(text, /\n {4}\$ boat env set base --boat-credentials false/);

  // Every environment workers use: the default and each project's, named once; others don't count.
  const some = parseEnvironments(fixture("env-list.json")).map((env) => ({ ...env, passSandboxCredentials: env.name !== "docs" }));
  const projects = buildChecks(facts({ environments: some }), context({ projectEnvironments: ["web", "docs", "web", "missing"] }));
  assert.match(check(projects, "boat-credentials").detail, /^"base" \(your default\) and "web" pass boat credentials/);
  assert.equal(check(projects, "boat-credentials").fix?.command, "boat env set base --boat-credentials false && boat env set web --boat-credentials false");
  assert.doesNotMatch(check(projects, "boat-credentials").detail, /"api"/, "an environment no worker uses");
  // A named Boat environment replaces boat's default.
  const named = buildChecks(facts({ environments: some.map((env) => (env.name === "base" ? { ...env, passSandboxCredentials: false } : env)) }), context({ environment: "web" }));
  assert.match(check(named, "boat-credentials").detail, /^"web" passes boat credentials/);
  const elsewhere = buildChecks(facts({ environments: some }), context({ environment: "docs" }));
  assert.equal(check(elsewhere, "boat-credentials").state, "ok", "boat's default isn't used then");

  // Off everywhere workers go: quiet. Unknown when boat can't be read.
  assert.equal(check(buildChecks(facts({ environments: withoutBoatLogin() }), context({ projectEnvironments: ["web"] })), "boat-credentials").state, "ok");
  const unread = buildChecks(facts({ environments: null, environmentsError: "timeout" }), context());
  assert.equal(check(unread, "boat-credentials").state, "unknown");
  assert.doesNotMatch(summaryLine(unread), /boat login/);
  const signedOut = buildChecks(facts({ account: parseAccount(fixture("status-signed-out.json")) }), context());
  assert.equal(check(signedOut, "boat-credentials").state, "unknown");
  assert.equal(check(signedOut, "boat-credentials").detail, "Needs you to sign in to boat.dev first.");
  // Alongside another warning, the summary names both.
  assert.match(buildStatus(withProfile(["claude-subscription"]), context({ agents: "both" })).summary, /^Setup: ready, but check Coding agents, boat login in sandboxes\. Run `bb boat doctor`\.$/);
});

test("each missing piece says how to fix it", () => {
  const noCli = buildChecks({ ...facts(), cli: { found: false, version: null } }, context());
  assert.equal(check(noCli, "cli").state, "missing");
  assert.equal(check(noCli, "cli").fix?.command, INSTALL_COMMAND);
  assert.equal(check(noCli, "signed-in").state, "unknown");

  const signedOut = buildChecks(facts({ account: parseAccount(fixture("status-signed-out.json")), plan: null, environments: null, profiles: null }), context());
  assert.equal(check(signedOut, "signed-in").state, "missing");
  assert.equal(check(signedOut, "signed-in").detail, "Not signed in yet.");
  assert.deepEqual(check(signedOut, "signed-in").fix, { text: "Sign in to boat.dev: run this in a terminal, then check again.", command: "boat onboard", action: "sign-in" });
  assert.equal(check(signedOut, "plan").state, "unknown");
  assert.match(summaryLine(signedOut), /^Setup: 1 thing to fix \(Signed in to boat\.dev\)/);

  const noPlan = buildChecks(facts({ plan: { ...facts().plan!, checkoutRequired: true, canStart: false } }), context());
  assert.equal(check(noPlan, "plan").state, "missing");
  assert.equal(check(noPlan, "plan").fix?.command, PLAN_COMMAND);
  assert.match(check(noPlan, "plan").fix!.text, /7-day trial, card required/);

  const noAgents = buildChecks(withProfile([]), context());
  assert.equal(check(noAgents, "agents").state, "missing");
  assert.equal(check(noAgents, "agents").fix?.url, AGENTS_URL);

  const safeEnvs = parseEnvironments(fixture("env-list.json")).map((env) =>
    env.isDefault ? { ...env, safeForThirdParties: true, passAgentsCredentials: false, passGithub: false, passSecrets: false } : env,
  );
  const safe = buildChecks(facts({ environments: safeEnvs }), context());
  assert.equal(check(safe, "environment").state, "missing");
  assert.match(check(safe, "environment").detail, /"base" \(your default\) is set to "Safe for third parties", so sandboxes get no agent logins and no GitHub/);
  assert.equal(check(safe, "environment").fix?.command, "boat env set base --safe-for-third-parties false");
  // One cause, one fix: the environment row has it (its command once, in the Copy block).
  assert.doesNotMatch(check(safe, "environment").fix!.text, /boat env set/);
  assert.equal(check(safe, "agents").state, "unknown", "fix the environment first");
  assert.equal(check(safe, "agents").fix, undefined);
  assert.match(summaryLine(safe), /^Setup: 1 thing to fix \(Boat environment\)/);

  // Installed after the plugin loaded: bb's "needs configuration" stays until a reload.
  const reload = buildChecks(facts(), context({}, { reloadNeeded: true }));
  assert.equal(check(reload, "cli").state, "warning");
  assert.equal(check(reload, "cli").fix?.command, "bb plugin reload boat");
  assert.equal(setupOk(reload), true);

  const missingEnv = buildChecks(facts(), context({ environment: "staging" }));
  assert.equal(check(missingEnv, "environment").state, "missing");
  assert.equal(check(missingEnv, "environment").fix?.command, "boat env new staging");

  const connect = buildChecks(facts(), context({ connectNeeded: true }));
  assert.equal(check(connect, "connect").state, "missing");
  assert.equal(check(connect, "connect").required, true);
  assert.equal(check(connect, "connect").fix?.text, "Run `bb connect on`.");

  const access = buildChecks(facts(), context({}, { repoAccess: { repo: "acme/web", access: "none", detail: "boat's GitHub access can't see acme/web.", checkedAt: "2026-11-05T10:00:00Z" } }));
  assert.equal(check(access, "github").state, "warning");
  assert.equal(check(access, "github").detail, "Last check on acme/web: boat's GitHub access can't see acme/web.");

  const gh = buildChecks(facts(), context({ ghNeeded: true }, { gh: { state: "signed-out", detail: null } }));
  assert.equal(check(gh, "gh").state, "warning");
  assert.equal(check(gh, "gh").fix?.command, "gh auth login");

  const text = doctorText(buildStatus(facts({ account: parseAccount(fixture("status-signed-out.json")) }), context()));
  assert.match(text, /^Setup: 1 thing to fix \(Signed in to boat\.dev\)\.\n/);
  assert.match(text, /✗ Signed in to boat\.dev: Not signed in yet\.\n {4}Sign in to boat\.dev: run this in a terminal, then check again\.\n {4}\$ boat onboard/);
});

test("a hand-picked agent boat doesn't have is a warning with a one-click fix", () => {
  const onlyClaude = withProfile(["claude-subscription"]);
  const both = buildStatus(onlyClaude, context({ agents: "both" }));
  const agents = check(both.checks, "agents");
  assert.equal(agents.state, "warning");
  assert.match(agents.detail, /^boat\.dev has only Claude connected, but Coding agents is set to Claude and Codex\. Work sent to Codex would fail/);
  assert.deepEqual(agents.fix, { text: "Use Auto-detect", action: "use-detected-agents" });
  assert.equal(both.ok, true, "a warning doesn't block");
  assert.match(both.summary, /^Setup: ready, but check Coding agents/);
  assert.deepEqual(both.agents, { setting: "both", detected: ["claude"], effective: "both" });
  // Fewer than boat has is a choice, not a problem.
  const narrower = buildChecks(facts(), context({ agents: "claude" }));
  assert.equal(check(narrower, "agents").state, "ok");
  assert.match(check(narrower, "agents").detail, /You chose only Claude\./);
  // Auto-detect follows boat.
  assert.equal(buildStatus(onlyClaude, context()).agents.effective, "claude");
});

test("the checks before a sandbox: unknowns never block, broken setups do", () => {
  assert.equal(preflightProblem(facts(), SETTINGS, { agent: "claude", runner: "boat", newSandbox: true }), null);
  assert.match(preflightProblem({ ...facts(), cli: { found: false, version: null } }, SETTINGS, {})!.hint, /curl -fsSL https:\/\/boat\.dev\/install \| sh/);
  const out = preflightProblem(facts({ account: { signedIn: false, identifier: null, plan: null, error: null } }), SETTINGS, { newSandbox: true })!;
  assert.equal(out.message, "You're not signed in to boat.dev.");
  assert.equal(out.hint, "Sign in to boat.dev: run `boat onboard` in a terminal.");
  // A plan is only needed to start a sandbox.
  const noPlan = facts({ plan: { ...facts().plan!, checkoutRequired: true } });
  assert.equal(preflightProblem(noPlan, SETTINGS, { agent: "claude", newSandbox: false }), null);
  assert.match(preflightProblem(noPlan, SETTINGS, { newSandbox: true })!.hint, /^Start a boat plan \(7-day trial, card required\): run `boat billing plan 20`/);
  // The agent's login, in the environment the sandbox uses.
  const onlyClaude = withProfile(["claude-subscription"]);
  const codex = preflightProblem(onlyClaude, SETTINGS, { agent: "codex", runner: "boat" })!;
  assert.equal(codex.message, "Codex isn't connected in boat.dev (only Claude is).");
  assert.match(codex.hint, /^Connect ChatGPT on boat\.dev → Agents \(https:\/\/boat\.dev\/dashboard\?tab=agents\)\. Already connected\? .*Safe for third parties/);
  // A chat with a hand-picked agent may log in through bb's Account Pooler.
  assert.equal(preflightProblem(onlyClaude, { ...SETTINGS, agents: "both" }, { agent: "codex", runner: "chat" }), null);
  assert.notEqual(preflightProblem(onlyClaude, SETTINGS, { agent: "codex", runner: "chat" }), null);
  assert.equal(preflightProblem(withProfile([]), SETTINGS, { agent: "claude" })!.message, "No Claude or ChatGPT login is connected in boat.dev.");
  // Couldn't read the profiles: nothing blocks.
  assert.equal(preflightProblem(facts({ profiles: null }), SETTINGS, { agent: "codex", runner: "boat", newSandbox: true }), null);
  // Environment that hides logins.
  const hidden = facts({ environments: parseEnvironments(fixture("env-list.json")).map((env) => ({ ...env, safeForThirdParties: true, passAgentsCredentials: false })) });
  assert.match(preflightProblem(hidden, SETTINGS, { agent: "claude", environment: "web" })!.message, /^Your boat environment "web" doesn't pass agent logins to sandboxes \("Safe for third parties"\)\.$/);
});

test("a Boat sandbox machine says what's missing", () => {
  assert.equal(machineProblem(facts(), SETTINGS, { state: "ready", fix: null }), null);
  assert.match(machineProblem(facts({ account: { signedIn: false, identifier: null, plan: null, error: null } }), SETTINGS, null)!, /boat onboard/);
  assert.match(machineProblem(withProfile([]), SETTINGS, null)!, /Connect Claude or ChatGPT/);
  assert.equal(machineProblem(withProfile([]), { ...SETTINGS, agents: "both" }, null), null, "a hand-picked agent may come from the Account Pooler");
  assert.match(machineProblem(facts(), SETTINGS, { state: "off", fix: "Run `bb connect on`." })!, /bb Connect, which is off\. Run `bb connect on`\./);
});

test("boat's errors read in plain words, with what to do", () => {
  const unauthorized = explainBoatError(new BoatError("not signed in, or your session expired. run `boat onboard`", { code: "unauthorized", status: 401 }));
  assert.deepEqual(unauthorized, { code: "unauthorized", message: "You're not signed in to boat.dev.", hint: "Sign in to boat.dev: run `boat onboard` in a terminal." });
  const codex = explainBoatError(new BoatError("codex is not configured for this sandbox", { code: "provider_not_configured", status: 409 }));
  assert.match(codex.hint!, /^Connect ChatGPT on boat\.dev → Agents \(https:\/\/boat\.dev\/dashboard\?tab=agents\)\. Already connected\? Your boat environment may be set to "Safe for third parties", which hides agent logins from sandboxes\.$/);
  assert.match(explainBoatError(new BoatError("no provider", { code: "provider_not_configured" })).hint!, /^Connect Claude or ChatGPT/);
  assert.match(explainBoatError(new BoatError("x", { code: "boat_not_found" })).hint!, /boat CLI location/);
  assert.match(explainBoatError(new BoatError("payment needed", { code: "checkout_required", status: 402 })).hint!, /^Start a boat plan/);
  assert.equal(explainBoatError(new BoatError("Saved snapshots need a plan", { code: "plan_required", status: 402 })).hint, null, "snapshot errors have their own words");
  assert.deepEqual(explainBoatError(new BoatError("boom", { code: "boat_failed" })), { code: "boat_failed", message: "boat: boom", hint: null });
});

test("the test task has no repo and runs headless on a small sandbox", () => {
  const input = testTaskInput("thr_chat");
  assert.equal(input.title, "Test task");
  assert.equal(input.repo, null);
  assert.equal(input.project, null);
  assert.equal(input.runner, "boat");
  assert.equal(input.machineType, "small");
  assert.equal(input.role, "custom");
  assert.equal(input.orchestratorThreadId, "thr_chat");
  assert.equal(input.evidence, false, "no evidence uploader");
  assert.match(input.brief, /`uname -a`, `node --version`, `git --version` and whether GitHub access works \(`gh auth status`\)\. Change nothing\./);
});

/** A scripted boat for the reader: answers per command, counting calls. */
function scriptedBoat(answers: Record<string, () => JsonRecord | Error>) {
  const calls: string[] = [];
  const run = async (args: string[]): Promise<BoatRunResult> => {
    const key = args.join(" ");
    calls.push(key);
    if (key === "--version") return { exitCode: 0, stdout: "boat 1.0.89\n", stderr: "", records: [] };
    const answer = answers[key]?.() ?? new BoatError(`unknown ${key}`, { code: "unknown" });
    if (answer instanceof Error) throw answer;
    return { exitCode: 0, stdout: JSON.stringify(answer), stderr: "", records: [answer] };
  };
  return { calls, run };
}

const REAL = {
  status: () => fixture("status-signed-in.json"),
  limits: () => fixture("limits-standard.json"),
  "env list": () => fixture("env-list.json"),
  "ai profiles": () => fixture("ai-profiles.json"),
};

test("reading boat: read-only commands, nothing more once signed out", async () => {
  const boat = scriptedBoat(REAL);
  const read = await readBoatFacts({ binary: async () => "/bin/boat", run: boat.run });
  assert.deepEqual(boat.calls.sort(), ["--version", "ai profiles", "env list", "limits", "status"]);
  assert.equal(read.cli.version, "1.0.89");
  assert.equal(read.plan?.name, "Standard");

  const signedOut = scriptedBoat({ ...REAL, status: () => fixture("status-signed-out.json") });
  const out = await readBoatFacts({ binary: async () => "/bin/boat", run: signedOut.run });
  assert.deepEqual(signedOut.calls.sort(), ["--version", "status"]);
  assert.equal(out.account.signedIn, false);

  const none = scriptedBoat(REAL);
  const missing = await readBoatFacts({ binary: async () => null, run: none.run });
  assert.equal(missing.cli.found, false);
  assert.deepEqual(none.calls, []);

  // A command that fails is reported, the others still count.
  const flaky = scriptedBoat({ ...REAL, "ai profiles": () => new BoatError("timed out", { code: "boat_timeout" }) });
  const partial = await readBoatFacts({ binary: async () => "/bin/boat", run: flaky.run });
  assert.equal(partial.profiles, null);
  assert.equal(partial.profilesError, "timed out");
  assert.notEqual(partial.plan, null);
});

test("the reader caches about a minute, re-reads before refusing, and remembers the last known agents", async () => {
  let answers: Record<string, () => JsonRecord | Error> = { ...REAL, status: () => fixture("status-signed-out.json") };
  const calls: string[] = [];
  const settings: SetupSettings = { ...SETTINGS };
  const setup = createSetup({
    binary: async () => "/bin/boat",
    run: async (args) => {
      const key = args.join(" ");
      calls.push(key);
      if (key === "--version") return { exitCode: 0, stdout: "boat 1.0.89\n", stderr: "", records: [] };
      const answer = answers[key]!();
      if (answer instanceof Error) throw answer;
      return { exitCode: 0, stdout: "", stderr: "", records: [answer] };
    },
    settings: async () => settings,
  });
  const first = await setup.status();
  assert.equal(first.ok, false);
  const reads = calls.filter((call) => call === "status").length;
  await setup.status();
  assert.equal(calls.filter((call) => call === "status").length, reads, "cached");

  // The user signs in: the check before a sandbox reads boat again instead of refusing.
  answers = { ...REAL };
  await setup.preflight({ agent: "claude", runner: "boat", newSandbox: true });
  assert.equal(calls.filter((call) => call === "status").length, reads + 1);
  assert.deepEqual(await setup.detectedAgents(""), ["claude", "codex"]);

  // Still broken after the re-read: a setup_required refusal with the fix.
  answers = { ...REAL, "ai profiles": () => ({ profiles: [{ id: "p", isDefault: true, owner: { kind: "personal" }, connected: ["claude-subscription"] }] }) };
  setup.invalidate();
  await assert.rejects(
    setup.preflight({ agent: "codex", runner: "boat", newSandbox: true }),
    (error: unknown) => error instanceof TaskError && error.code === "setup_required" && /bb boat doctor/.test(error.hint ?? ""),
  );

  // boat can't be read now: the last reading that knew says Codex isn't there.
  answers = { ...REAL, "ai profiles": () => new BoatError("timed out", { code: "boat_timeout" }) };
  await setup.status({ force: true });
  assert.equal(await setup.detectedAgents(""), null);
  assert.deepEqual(setup.lastMissingAgents(""), ["codex"]);
});

test("the auto-stop cap comes from boat limits: the trial's line, a trial fallback, none on paid plans", async () => {
  const trial = fixture("limits-trial.json");
  const plan = parsePlan(trial);
  assert.equal(plan.trial, true);
  assert.equal(plan.name, "Trial");
  assert.equal(plan.autoStopCapHours, 2, "from \"auto-stop max 2h\" in trialLine");
  // boat changes the cap: the plugin follows it.
  assert.equal(autoStopCapFromLimits({ ...trial, trialLine: "2 boxes, 75 new/day, auto-stop max 3h, no large or xlarge types" }), 3);
  assert.equal(autoStopCapFromLimits({ ...trial, trialLine: "2 boxes, auto-stop max 90m" }), 1.5);
  // A trial whose line doesn't say keeps the cap boat has enforced so far.
  assert.equal(autoStopCapFromLimits({ ...trial, trialLine: null }), TRIAL_AUTO_STOP_HOURS);
  assert.equal(autoStopCapFromLimits({ ...trial, trialLine: "2 boxes" }), TRIAL_AUTO_STOP_HOURS);
  assert.equal(autoStopCapFromLimits(fixture("limits-standard.json")), null);

  // BoatApi.limits() carries it to sandbox creation, resume and extend.
  const api = (raw: JsonRecord) => new BoatApi({ json: async () => raw } as unknown as BoatCli);
  assert.equal((await api(trial).limits()).autoStopCapHours, 2);
  assert.equal((await api(fixture("limits-standard.json")).limits()).autoStopCapHours, null);

  // boat's refusals name the cap too.
  assert.equal(autoStopCapFromText("Free-trial auto-stop is 2 hours maximum. Set a TTL of 2 hours or less, or end the trial (first payment) to lift it."), 2);
  assert.equal(autoStopCapFromText("Free-trial Sandboxes cannot run without auto-stop. Set a TTL of 2 hours or less, or end the trial (first payment) to lift it."), 2);
  assert.equal(autoStopCapFromText("auto-stop max 7200s"), 2);
  assert.equal(autoStopCapFromText("2 boxes, 75 new/day, 25h of 25h compute left"), null, "compute hours aren't the auto-stop");
  assert.equal(autoStopCapFromText(null), null);
});

test("a refused auto-stop is retried once at the cap boat names", async () => {
  const refusal = (hours: number) =>
    new BoatError(`Free-trial auto-stop is ${hours} hours maximum. Set a TTL of ${hours} hours or less, or end the trial (first payment) to lift it.`, {
      code: "trial_auto_stop_required",
      status: 400,
    });
  const tried: number[] = [];
  const capAt = (cap: number, hours: number) => async (ttl: number) => {
    tried.push(ttl);
    if (ttl > cap) throw refusal(hours);
    return ttl;
  };
  assert.equal(await withinAutoStopCap(14_400, capAt(10_800, 3)), 10_800);
  assert.deepEqual(tried, [14_400, 10_800]);
  // A refusal that names no cap falls back to the trial's 2 hours.
  tried.length = 0;
  const vague = async (ttl: number) => {
    tried.push(ttl);
    if (ttl > 7200) throw new BoatError("auto-stop required", { code: "trial_auto_stop_required", status: 400 });
    return ttl;
  };
  assert.equal(await withinAutoStopCap(14_400, vague), 7200);
  assert.deepEqual(tried, [14_400, 7200]);
  // Already within what boat names, or another error: no second call.
  tried.length = 0;
  await assert.rejects(withinAutoStopCap(3600, capAt(1800, 2)), (error: unknown) => error instanceof BoatError && error.code === "trial_auto_stop_required");
  assert.deepEqual(tried, [3600]);
  let calls = 0;
  await assert.rejects(
    withinAutoStopCap(14_400, async () => {
      calls += 1;
      throw new BoatError("boom", { code: "boat_failed" });
    }),
    /boom/,
  );
  assert.equal(calls, 1);
});
