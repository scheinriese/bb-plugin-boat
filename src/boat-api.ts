// Typed boat operations built on the CLI wrapper. All JSON shapes were
// observed from boat CLI 1.0.89; every accessor tolerates missing fields.
import { randomUUID } from "node:crypto";
import { BoatCli, BoatError, bool, num, rec, str, type JsonRecord } from "./boat.ts";
import type { Provider } from "./store.ts";

export const MACHINE_TYPES = ["small", "default", "large", "xlarge"] as const;
export type MachineType = (typeof MACHINE_TYPES)[number];

/**
 * The trial's auto-stop cap when boat says it's the trial but not the cap
 * (boat 1.0.89–1.0.92 enforce 2 hours). The cap itself comes from boat:
 * see autoStopCapFromLimits.
 */
export const TRIAL_AUTO_STOP_HOURS = 2;

const AUTO_STOP_UNITS: Record<string, number> = { h: 1, m: 1 / 60, s: 1 / 3600 };

/**
 * An auto-stop cap in boat's own words, in hours (null: none stated):
 * "auto-stop max 2h" (the trial's line in `boat limits`), "Set a TTL of
 * 2 hours or less" and "auto-stop is 2 hours maximum" (its refusals).
 */
export function autoStopCapFromText(text: string | null | undefined): number | null {
  if (!text) return null;
  const unit = String.raw`(\d+(?:\.\d+)?)\s*(h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)\b`;
  const match =
    new RegExp(String.raw`auto-?stop[^.,;\n]{0,24}?\b` + unit, "i").exec(text) ??
    new RegExp(String.raw`\bttl of ` + unit + String.raw`\s+or less`, "i").exec(text);
  if (match === null) return null;
  const hours = Number(match[1]) * AUTO_STOP_UNITS[match[2]!.charAt(0).toLowerCase()]!;
  return Number.isFinite(hours) && hours > 0 ? hours : null;
}

/**
 * The plan's cap on a sandbox's auto-stop, in hours, from `boat limits --json`
 * (null: no cap). boat has no number field for it (checked with 1.0.89 and
 * 1.0.92): the trial's `trialLine` says it ("2 boxes, 75 new/day, …,
 * auto-stop max 2h, …"), and other plans have none. A trial whose line
 * doesn't say gets TRIAL_AUTO_STOP_HOURS.
 */
export function autoStopCapFromLimits(raw: JsonRecord): number | null {
  const stated = autoStopCapFromText(str(raw.trialLine));
  if (stated !== null) return stated;
  return str(raw.accessTier) === "trial" ? TRIAL_AUTO_STOP_HOURS : null;
}

/** Hours a new sandbox runs before boat stops it: the Hard stop setting, within the plan's cap (null: none known). */
export function autoStopHours(settingHours: number, capHours: number | null, floor = 0.25): number {
  const hours = Math.max(floor, settingHours);
  return capHours === null ? hours : Math.min(hours, capHours);
}

/**
 * Run a boat call that sets an auto-stop. When boat refuses it as over the
 * plan's cap (trial_auto_stop_required: `boat limits` couldn't be read
 * first, or the cap changed), run it once more at the cap boat names in the
 * refusal, else TRIAL_AUTO_STOP_HOURS.
 */
export async function withinAutoStopCap<T>(ttlSeconds: number, run: (ttlSeconds: number) => Promise<T>): Promise<T> {
  try {
    return await run(ttlSeconds);
  } catch (error) {
    if (!(error instanceof BoatError) || error.code !== "trial_auto_stop_required") throw error;
    const capped = Math.round((autoStopCapFromText(error.message) ?? TRIAL_AUTO_STOP_HOURS) * 3600);
    if (capped >= ttlSeconds) throw error;
    return run(capped);
  }
}

/** States boat counts against the active-sandbox limit. */
export const ACTIVE_STATES = new Set(["provisioned", "cloning", "ready", "idle", "running"]);

export interface Sandbox {
  id: string;
  name: string | null;
  state: string;
  health: string | null;
  url: string | null;
  desktopUrl: string | null;
  environment: string | null;
  createdAt: string | null;
  archiveAfter: string | null;
  stoppedAt: string | null;
  setupStatus: string | null;
  error: string | null;
  /** Its size, when boat's JSON says (not verified that it does; the memory probe is what counts). */
  machineType?: MachineType | null;
}

export interface Limits {
  tier: string | null;
  summary: string | null;
  activeSandboxes: number;
  maxActiveSandboxes: number | null;
  startsLeftToday: number | null;
  startsLeftThisHour: number | null;
  canStart: boolean;
  blockedReason: string | null;
  /** The account has no plan yet (boat asks for a checkout first). */
  checkoutRequired: boolean;
  /** The plan's cap on a sandbox's auto-stop, in hours (null: none). */
  autoStopCapHours: number | null;
}

export interface Conversation {
  id: string;
  running: boolean;
  harness: string | null;
  model: string | null;
  prompts: number;
  lastPromptAt: string | null;
  lastPromptPreview: string | null;
}

export interface ChatEvent {
  type: string;
  /** The prompt run this event belongs to (`promptId` from `boat prompt`). */
  promptId: string | null;
  conversationId: string | null;
  status: string | null;
  content: string | null;
  /** Failure reason on a failed prompt event. */
  error: string | null;
  timestamp: number | null;
  tools: string[];
}

export interface Dispatch {
  conversationId: string;
  promptId: string | null;
  model: string | null;
}

export function toSandbox(raw: JsonRecord): Sandbox {
  const id = str(raw.id);
  if (id === null) throw new BoatError("boat returned a sandbox without an id", { code: "boat_bad_output" });
  return {
    id,
    name: str(raw.name),
    state: str(raw.state) ?? "unknown",
    health: str(raw.health),
    url: str(raw.url),
    desktopUrl: str(raw.desktopUrl),
    environment: str(raw.environment),
    createdAt: str(raw.createdAt),
    archiveAfter: str(raw.archiveAfter),
    stoppedAt: str(raw.stoppedAt),
    setupStatus: str(raw.setupStatus),
    error: str(raw.error) ?? str(raw.setupError),
    machineType: [raw.type, raw.machineType, raw.size].find((value): value is MachineType => typeof value === "string" && (MACHINE_TYPES as readonly string[]).includes(value)) ?? null,
  };
}

export function dashboardUrl(sandboxId: string): string {
  return `https://boat.dev/dashboard?sandbox=${encodeURIComponent(sandboxId)}`;
}

/** `owner/name` from `owner/name`, `https://github.com/owner/name(.git)`, or `git@github.com:owner/name.git`. */
export function normalizeRepo(input: string): string {
  const trimmed = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const match =
    trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+)$/i) ??
    trimmed.match(/^git@github\.com:([\w.-]+)\/([\w.-]+)$/i) ??
    trimmed.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new BoatError(`"${input}" is not a GitHub repository (expected owner/name or a github.com URL)`, {
      code: "invalid_repo",
    });
  }
  return `${match[1]}/${match[2]}`;
}

const BRANCH_PATTERN = /^(?!\/|.*\/\/|.*\.\.|.*@\{|.*\.lock$)[A-Za-z0-9._\/-]{1,200}$/;

export function assertBranch(name: string, label = "branch"): string {
  if (!BRANCH_PATTERN.test(name) || name.startsWith("-")) {
    throw new BoatError(`"${name}" is not a valid ${label} name`, { code: "invalid_branch" });
  }
  return name;
}

/** Branches no worker may push to anywhere (plus each project's base and the extra-branches setting). */
export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = ["main", "master"];

const isBranchName = (name: string) => BRANCH_PATTERN.test(name) && !name.startsWith("-");

/** "release, develop" → ["release", "develop"]; names that aren't valid branch names are left out. */
export function parseBranchList(text: string): string[] {
  const names = text
    .split(/[,\n]/)
    .map((name) => name.trim())
    .filter((name) => name !== "" && isBranchName(name));
  return [...new Set(names)];
}

/** The entries of a comma-separated list that aren't valid branch names. */
export function invalidBranchNames(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((name) => name.trim())
    .filter((name) => name !== "" && !isBranchName(name));
}

/** A positional argument that clap must not read as a flag. */
function safePositional(text: string): string {
  return /^\s*-/.test(text) ? `\u200b${text}` : text;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export type CheckoutMode =
  | { kind: "new-branch"; branch: string; base: string | null }
  | { kind: "existing-branch"; branch: string }
  | { kind: "pull-request"; pr: string }
  /** Check out the base branch itself (read-only use: context repos, reviews). */
  | { kind: "default-branch"; base?: string | null };

export interface PrepareOptions {
  signal?: AbortSignal;
  /** Subfolder of ~/work for this checkout (one per task, so tasks sharing a sandbox never share a working tree). */
  workDir?: string | null;
  /** Branches a pre-push hook refuses to push to from this checkout (base branches). */
  protect?: readonly string[];
  /** Branches refused from every checkout in the sandbox (default: main and master). */
  alwaysProtect?: readonly string[];
  /**
   * Use the copy the boat environment already cloned into ~/<repo name>
   * (setup script and dependencies done) when it's there. Only for a sandbox
   * the task has to itself.
   */
  useEnvironmentCheckout?: boolean;
  /**
   * The project ships after the user approves: the worker only commits, and
   * the pre-push hook refuses every push from this checkout (the plugin's
   * ship step pushes with --no-verify).
   */
  noPush?: boolean;
  /** The sandbox's boat environment (named in error hints). */
  environment?: string | null;
}

/** A boat environment, as the plugin shows it: secret NAMES only, never values. */
export interface EnvironmentInfo {
  name: string;
  secretNames: string[];
  secretFiles: string[];
  /** Repos the environment clones, with the permission boat's GitHub access has. */
  repos: { repo: string; permission: string | null; baseBranch: string | null }[];
  /** What sandboxes really get (boat's effective.* toggles; "Safe for third parties" turns them off). */
  passGithub: boolean | null;
  passSecrets: boolean | null;
  passAgentsCredentials: boolean | null;
  /** boat credentials: the in-sandbox boat CLI login, for the whole account. */
  passSandboxCredentials: boolean | null;
  /** With "Safe for third parties": AI logins still go in, as proxy placeholders. */
  proxyAiCredentials: boolean | null;
  safeForThirdParties: boolean | null;
}

/**
 * The account's AI credentials proxy, a paid boat add-on: on, sandboxes get
 * placeholder AI keys and real keys never enter them.
 */
export interface AiProxyState {
  /** null: couldn't tell. */
  enabled: boolean | null;
  /** What it costs, as boat prices it (null: not reported). */
  dailyDollars: number | null;
  dollarsPer1000Requests: number | null;
}

/**
 * `boat ai proxy --json` (no state given: it only shows), e.g.
 * `{"enabled":false,"pricing":{"dailyDollars":1,"dollarsPer1000Requests":1},…}`
 * (test/fixtures/boat-json/ai-proxy.json).
 */
export function parseAiProxy(raw: JsonRecord): AiProxyState {
  const nested = rec(raw.proxy) ?? rec(raw.aiProxy);
  const state = str(raw.state) ?? str(nested?.state);
  const enabled = bool(raw.enabled) ?? bool(nested?.enabled) ?? (state === "on" ? true : state === "off" ? false : null);
  const pricing = rec(raw.pricing) ?? rec(nested?.pricing);
  const dollars = (value: unknown) => {
    const amount = num(value);
    return amount !== null && amount >= 0 ? amount : null;
  };
  return { enabled, dailyDollars: dollars(pricing?.dailyDollars), dollarsPer1000Requests: dollars(pricing?.dollarsPer1000Requests) };
}

/** "about $1 a day plus $1 per 1,000 requests" (null: boat didn't say). */
export function aiProxyPrice(state: Pick<AiProxyState, "dailyDollars" | "dollarsPer1000Requests">): string | null {
  const money = (amount: number) => "$" + (Number.isInteger(amount) ? String(amount) : amount.toFixed(2));
  const parts = [
    state.dailyDollars !== null ? `${money(state.dailyDollars)} a day` : null,
    state.dollarsPer1000Requests !== null ? `${money(state.dollarsPer1000Requests)} per 1,000 requests` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : `about ${parts.join(" plus ")}`;
}

/** A sandbox port on a stable HTTPS URL (`boat host`); a private one carries its token in the query. */
export interface HostedPort {
  url: string;
  port: number;
  title: string | null;
  isProtected: boolean;
}

/** A saved snapshot (`boat snapshot <id> <name>`), what `boat new --from` starts from. */
export interface SavedSnapshot {
  name: string;
  sizeBytes: number | null;
  createdAt: string | null;
  sourceSandboxId: string | null;
  status: string | null;
  type: string | null;
}

/** One repo the ship step pushes: its checkout and the branch it lands on. */
export interface ShipTarget {
  path: string;
  baseBranch: string;
}

export interface ShipResult {
  /** Repos whose commits landed, with the new head and how many commits. */
  shipped: { path: string; baseBranch: string; sha: string; commits: number }[];
}

/** Where the plugin keeps its git hooks in a sandbox. */
export const BOAT_HOOKS_DIR = "/home/user/.boat-hooks";

/**
 * Per-sandbox environment for sandboxes the plugin creates: git reads hooks
 * from the plugin's folder whatever the repo configures (husky and friends
 * set a repo-local core.hooksPath during `npm install`). Environment config
 * outranks repo config; the hooks chain to the repo's own hooks.
 */
export const BOAT_GIT_ENV: Record<string, string> = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: BOAT_HOOKS_DIR,
};

/** Hooks the plugin passes through to the repo's own hooks. */
export const CHAINED_HOOKS = [
  "pre-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-merge-commit",
  "post-rewrite",
  "pre-auto-gc",
] as const;

/** Shell snippet: run the repo's own hook of this name (its core.hooksPath, else .git/hooks). */
function chainSnippet(hook: string): string {
  return `ours="\${BOAT_HOOKS_DIR:-$HOME/.boat-hooks}"
dir="$(git config --local --get core.hooksPath 2>/dev/null || true)"
if [ -n "$dir" ] && [ "\${dir#/}" = "$dir" ]; then dir="$(git rev-parse --show-toplevel 2>/dev/null)/$dir"; fi
if [ -z "$dir" ] || [ "$(cd "$dir" 2>/dev/null && pwd -P)" = "$(cd "$ours" 2>/dev/null && pwd -P)" ]; then
  dir="$(git rev-parse --git-common-dir 2>/dev/null)/hooks"
fi
if [ -x "$dir/${hook}" ] && [ "$(cd "$dir" 2>/dev/null && pwd -P)" != "$(cd "$ours" 2>/dev/null && pwd -P)" ]; then`;
}

/**
 * The plugin's pre-push hook: refuse protected branches, then run the repo's
 * own pre-push. Two lists: sandbox-wide (always-protected names) and per
 * checkout (that task's base branches), so stacking one task on another's
 * branch never blocks the first task's pushes.
 *
 * Pushes to a folder on the sandbox's own disk skip both checks: they can't
 * reach GitHub, and repos' own tests push to throwaway local remotes. The
 * local test follows git's rule ($2 is the remote's URL): `file://`, or no
 * "://" and no colon before the first slash ("host:path" is ssh). Anything
 * else, including an empty URL, is checked as before.
 */
export function prePushHook(): string {
  return `#!/bin/sh
# Installed by the Boat plugin: workers push their own branch and open a draft PR.
# Pushes to a folder in this sandbox (a test's temporary remote) skip the checks.
url="$2"
local_remote=""
case "$url" in
  "") ;;
  file://*) local_remote=1 ;;
  *://*) ;;
  *) case "\${url%%/*}" in *:*) ;; *) local_remote=1 ;; esac ;;
esac
if [ -z "$local_remote" ] && [ -f "$(git rev-parse --git-common-dir 2>/dev/null)/boat-no-push" ]; then
  echo "boat: this project ships after the user approves. Commit on your branch and don't push; the plugin pushes your commits to the base branch once they're approved." >&2
  exit 1
fi
sandbox_list="\${BOAT_HOOKS_DIR:-$HOME/.boat-hooks}/protected"
checkout_list="$(git rev-parse --git-common-dir 2>/dev/null)/boat-protected"
protected="$(cat "$sandbox_list" "$checkout_list" 2>/dev/null)"
input="$(cat)"
if [ -z "$local_remote" ] && [ -n "$protected" ]; then
  printf '%s\\n' "$input" | while read -r local_ref local_sha remote_ref remote_sha; do
    [ -n "$remote_ref" ] || continue
    branch="\${remote_ref#refs/heads/}"
    printf '%s\\n' "$protected" | while read -r name; do
      if [ -n "$name" ] && [ "$branch" = "$name" ]; then
        echo "boat: pushing to $name is not allowed. Push your own branch and open a draft pull request against $name." >&2
        exit 1
      fi
    done || exit 1
  done || exit 1
fi
${chainSnippet("pre-push")}
  printf '%s\\n' "$input" | "$dir/pre-push" "$@"
  exit $?
fi
exit 0
`;
}

/** A pass-through hook that runs the repo's own hook of the same name. */
export function chainedHook(hook: string): string {
  return `#!/bin/sh
# Installed by the Boat plugin: runs the repo's own ${hook} hook.
${chainSnippet(hook)}
  exec "$dir/${hook}" "$@"
fi
exit 0
`;
}

export interface PreparedRepo {
  path: string;
  branch: string | null;
  baseBranch: string | null;
  /** What the sandbox's GitHub login may do there (null: couldn't tell). */
  canPush?: boolean | null;
  /** When the sandbox's GitHub token expires (ISO), if GitHub said. */
  githubExpiresAt?: string | null;
}

/** The sandbox's GitHub login and a repo: one line the prepare script prints, and how to fix it. */
export const GITHUB_ACCESS_SNIPPET = `ACCESS_OUT=$(gh api "repos/$REPO" --jq '"\\(.permissions.push) \\(.permissions.pull)"' 2>&1) && ACCESS_OK=1 || ACCESS_OK=0
if [ "$ACCESS_OK" = 0 ]; then
  case "$ACCESS_OUT" in
    *"rate limit"*) echo "BOAT_ACCESS unknown" ;;
    *"Bad credentials"*|*"HTTP 401"*) echo "BOAT_ACCESS expired" ;;
    *"gh auth login"*|*"GH_TOKEN"*|*"not logged"*) echo "BOAT_ACCESS nologin" ;;
    *"Not Found"*|*"HTTP 404"*) echo "BOAT_ACCESS none" ;;
    *"HTTP 403"*) echo "BOAT_ACCESS denied" ;;
    *) echo "BOAT_ACCESS unknown" ;;
  esac
  printf 'BOAT_ACCESS_DETAIL %s\\n' "$(printf '%s' "$ACCESS_OUT" | head -1 | cut -c1-300)"
else
  echo "BOAT_ACCESS ok push=\${ACCESS_OUT%% *}"
fi
GH_EXP=$(gh api -i user 2>/dev/null | tr -d '\\r' | grep -i '^github-authentication-token-expiration:' | cut -d' ' -f2- || true)
echo "BOAT_GH_EXPIRES \${GH_EXP:-unknown}"`;

/** Access results that stop a checkout before it clones (the rest let the clone try). */
export const ACCESS_BLOCKING = ["none", "denied", "expired", "nologin"] as const;

/** Parse the access lines; throws the plain-words error when the work can't go on. */
export function parseGithubAccess(
  stdout: string,
  repo: string,
  environment: string | null = null,
): { canPush: boolean | null; githubExpiresAt: string | null } {
  const access = stdout.match(/BOAT_ACCESS (\w+)(?: push=(\w+))?/);
  const detail = stdout.match(/BOAT_ACCESS_DETAIL (.*)/)?.[1]?.trim() ?? "";
  const expires = stdout.match(/BOAT_GH_EXPIRES (.+)/)?.[1]?.trim() ?? "unknown";
  const parsed = expires === "unknown" ? NaN : Date.parse(expires.replace(" UTC", "Z").replace(" ", "T"));
  const githubExpiresAt = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  const owner = repo.split("/")[0] ?? repo;
  const envName = environment ? `\`${environment}\`` : "the sandbox's boat environment";
  switch (access?.[1]) {
    case "none":
      throw new BoatError(
        `boat's GitHub access can't see ${repo}. Connect GitHub on boat.dev → Environment and give boat access to ${repo} (GitHub → Settings → Applications → boat → Repository access, on ${owner}), or check the repo name. Then try again.`,
        { code: "repo_access" },
      );
    case "denied":
      throw new BoatError(`GitHub refused boat's access to ${repo}: ${detail || "HTTP 403"}.`, { code: "repo_access" });
    case "nologin":
      throw new BoatError(
        `The sandbox has no GitHub login. Connect GitHub on boat.dev → Environment and give boat access to this repo (or turn off "Safe for third parties" for ${envName}), then try again.`,
        { code: "repo_access" },
      );
    case "expired":
      throw new BoatError(
        `The sandbox's GitHub login has expired (boat's GitHub tokens last about 8 hours). Run \`boat env upgrade ${environment ?? "<environment>"}\` to give sandboxes fresh credentials, or start the work in a new sandbox.`,
        { code: "github_token_expired" },
      );
  }
  return { canPush: access?.[1] === "ok" ? (access[2] === "true" ? true : access[2] === "false" ? false : null) : null, githubExpiresAt };
}

/**
 * Variable names from a dotenv text, never values: a quoted value spanning
 * lines (a PEM key) is skipped whole, so none of it can pass for a name.
 */
export function envNames(contents: string): string[] {
  const names: string[] = [];
  let open: string | null = null;
  const closes = (text: string, quote: string): boolean => {
    for (let index = 0; index < text.length; index += 1) {
      if (quote !== "'" && text[index] === "\\") {
        index += 1;
        continue;
      }
      if (text[index] === quote) return true;
    }
    return false;
  };
  for (const raw of contents.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (open !== null) {
      if (closes(line, open)) open = null;
      continue;
    }
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match === null) continue;
    names.push(match[1]!);
    const value = match[2] ?? "";
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === "`") && !closes(value.slice(1), quote)) open = quote;
  }
  return [...new Set(names)];
}

/**
 * The ship step, run in the sandbox: refuse uncommitted changes, bring each
 * repo's commits up to date with its base (rebase; nothing is ever forced)
 * and push them. Every check runs before the first push.
 */
export function shipScript(targets: ShipTarget[]): string {
  const each = (body: (target: ShipTarget, index: number) => string) => targets.map(body).join("\n");
  return `set -uo pipefail
export GIT_TERMINAL_PROMPT=0
fail() { echo "BOAT_SHIP_ERROR $1 $2"; [ -n "\${3:-}" ] && printf '%s\\n' "$3" | tail -5 | sed 's/^/BOAT_SHIP_DETAIL /'; exit 3; }
${each((target, index) => `cd ${shellQuote(target.path)} || fail ${index} missing
DIRTY=$(git status --porcelain)
[ -z "$DIRTY" ] || fail ${index} dirty "$DIRTY"
OUT=$(git fetch --quiet origin ${shellQuote(target.baseBranch)} 2>&1) || fail ${index} fetch "$OUT"`)}
${each((target, index) => `cd ${shellQuote(target.path)}
AHEAD_${index}=$(git rev-list --count ${shellQuote(`origin/${target.baseBranch}`)}..HEAD)
if [ "$AHEAD_${index}" != "0" ]; then
  git rebase --quiet ${shellQuote(`origin/${target.baseBranch}`)} >/dev/null 2>&1 || { git rebase --abort >/dev/null 2>&1; fail ${index} conflict; }
fi`)}
${each((target, index) => `cd ${shellQuote(target.path)}
if [ "$AHEAD_${index}" != "0" ]; then
  OUT=$(git push --no-verify --quiet origin ${shellQuote(`HEAD:refs/heads/${target.baseBranch}`)} 2>&1) || fail ${index} push "$OUT"
  echo "BOAT_SHIPPED ${index} $(git rev-parse HEAD) $AHEAD_${index}"
fi`)}
echo "BOAT_SHIP_DONE"
`;
}

/** What the ship script said: what landed, and why it stopped if it did. */
export function parseShipOutput(stdout: string, targets: ShipTarget[]): ShipResult & { failure: { target: ShipTarget | null; reason: string; detail: string[] } | null } {
  const shipped = [...stdout.matchAll(/BOAT_SHIPPED (\d+) ([0-9a-f]{7,40}) (\d+)/g)].map((match) => {
    const target = targets[Number(match[1])]!;
    return { path: target.path, baseBranch: target.baseBranch, sha: match[2]!, commits: Number(match[3]) };
  });
  const failed = stdout.match(/BOAT_SHIP_ERROR (\d+) (\w+)/);
  const detail = [...stdout.matchAll(/^BOAT_SHIP_DETAIL (.*)$/gm)].map((match) => match[1]!.trim()).filter(Boolean);
  return {
    shipped,
    failure: failed === null ? null : { target: targets[Number(failed[1])] ?? null, reason: failed[2]!, detail },
  };
}

export class BoatApi {
  readonly cli: BoatCli;

  constructor(cli: BoatCli) {
    this.cli = cli;
  }

  async limits(signal?: AbortSignal): Promise<Limits> {
    const raw = await this.cli.json(["limits"], { signal });
    const current = rec(raw.currentLimits);
    const starts = rec(raw.starts);
    return {
      tier: str(raw.accessTier) ?? str(raw.planName),
      summary: str(raw.trialLine),
      activeSandboxes: num(raw.activeSandboxes) ?? 0,
      maxActiveSandboxes: num(current?.activeSandboxes) ?? num(raw.maxActiveSandboxes),
      startsLeftToday: num(rec(starts?.day)?.remaining),
      startsLeftThisHour: num(rec(starts?.hour)?.remaining),
      canStart: bool(raw.canStart) ?? true,
      blockedReason: str(raw.startBlockedReason) ?? str(raw.blockedReason),
      checkoutRequired: bool(raw.checkoutRequired) ?? false,
      autoStopCapHours: autoStopCapFromLimits(raw),
    };
  }

  /** Names of the account's boat environments. */
  /** The environment boat uses when none is named (null: none marked). */
  async defaultEnvironment(signal?: AbortSignal): Promise<string | null> {
    const raw = await this.cli.json(["env", "list"], { signal });
    const list = Array.isArray(raw.environments) ? raw.environments : [];
    const entry = list.map((item) => rec(item)).find((item) => item !== null && item.isDefault === true);
    return str(entry?.name) ?? null;
  }

  async environments(signal?: AbortSignal): Promise<string[]> {
    const raw = await this.cli.json(["env", "list"], { signal });
    const list = Array.isArray(raw.environments) ? raw.environments : [];
    return list.map((entry) => str(rec(entry)?.name)).filter((name): name is string => name !== null);
  }

  async list(options: { all?: boolean; signal?: AbortSignal } = {}): Promise<Sandbox[]> {
    const raw = await this.cli.json(["list", ...(options.all === true ? ["--all"] : [])], {
      signal: options.signal,
    });
    const sandboxes = Array.isArray(raw.sandboxes) ? raw.sandboxes : [];
    return sandboxes
      .map((entry) => rec(entry))
      .filter((entry): entry is JsonRecord => entry !== null)
      .map(toSandbox);
  }

  async info(id: string, signal?: AbortSignal): Promise<Sandbox> {
    const raw = await this.cli.json(["info", id], { signal });
    const sandbox = rec(raw.sandbox) ?? raw;
    return toSandbox(sandbox);
  }

  /** Returns null when boat says the sandbox does not exist. */
  async findInfo(id: string, signal?: AbortSignal): Promise<Sandbox | null> {
    try {
      return await this.info(id, signal);
    } catch (error) {
      if (error instanceof BoatError && (error.code === "not_found" || error.status === 404)) return null;
      throw error;
    }
  }

  async create(options: {
    name: string;
    type: MachineType;
    environment?: string | null;
    ttlSeconds?: number | null;
    noAutoStop?: boolean;
    /** Saved snapshot (or share code) to start from: `boat new --from`. */
    from?: string | null;
    /** Per-sandbox environment variables (`boat new -e`). */
    env?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<Sandbox> {
    const args = ["new", "--name", options.name.slice(0, 120), "--type", options.type];
    if (options.environment) args.push("--environment", options.environment);
    if (options.from) args.push("--from", options.from);
    for (const [key, value] of Object.entries(options.env ?? {})) args.push("-e", `${key}=${value}`);
    if (options.ttlSeconds !== null && options.ttlSeconds !== undefined) {
      args.push("--ttl", String(Math.round(options.ttlSeconds)));
    }
    if (options.noAutoStop === true) args.push("--no-auto-stop");
    const result = await this.cli.run(args, { timeoutMs: 180_000, signal: options.signal, allowFailure: true });
    const ready = [...result.records].reverse().find((record) => record.event === "ready");
    const created = result.records.find((record) => record.event === "created");
    if (result.exitCode !== 0) {
      // boat may have created the sandbox before failing; don't leave it holding a slot.
      const orphan = str(created?.id);
      if (orphan !== null) await this.delete(orphan).catch(() => undefined);
      const error = [...result.records].reverse().find((record) => record.event === "error");
      throw new BoatError(str(error?.error) ?? (result.stderr.trim() || `boat new exited with code ${result.exitCode}`), {
        code: str(error?.code) ?? "boat_failed",
        status: num(error?.status),
        exitCode: result.exitCode,
      });
    }
    const id = str(ready?.id) ?? str(created?.id);
    if (id === null) {
      throw new BoatError("boat new did not report a sandbox id", { code: "boat_bad_output" });
    }
    try {
      return await this.info(id, options.signal);
    } catch {
      return {
        id,
        name: options.name,
        state: str(ready?.state) ?? "ready",
        health: null,
        url: str(ready?.url),
        desktopUrl: str(ready?.desktopUrl),
        environment: options.environment ?? null,
        createdAt: null,
        archiveAfter: str(ready?.archiveAfter),
        stoppedAt: null,
        setupStatus: null,
        error: null,
      };
    }
  }

  async delete(id: string, signal?: AbortSignal): Promise<void> {
    await this.cli.run(["delete", id, "--yes"], { timeoutMs: 120_000, signal });
  }

  async stop(id: string, signal?: AbortSignal): Promise<void> {
    await this.cli.run(["stop", id], { timeoutMs: 180_000, signal });
  }

  /** `type`: resume onto another size (`--type`); omitted, boat keeps the sandbox's size. */
  async resume(id: string, ttlSeconds: number | null, signal?: AbortSignal, type?: MachineType | null): Promise<void> {
    const args = ["resume", id];
    if (ttlSeconds !== null) args.push("--ttl", String(Math.round(ttlSeconds)));
    if (type) args.push("--type", type);
    await this.cli.run(args, { timeoutMs: 180_000, signal });
  }

  /** Expose a port on a private, token-gated HTTPS link (stable across stop and resume). */
  async host(id: string, port: number, title: string, signal?: AbortSignal): Promise<HostedPort> {
    const record = await this.cli.json(["host", id, String(port), "--private", "--title", title.slice(0, 120)], { timeoutMs: 60_000, signal });
    const url = str(record.url);
    if (url === null || !/^https:\/\//.test(url)) throw new BoatError("boat host did not return a link", { code: "boat_bad_output" });
    return { url, port: num(record.port) ?? port, title: str(record.title), isProtected: bool(record.isProtected) ?? true };
  }

  /** Start a command in the background (it outlives the call); returns its process id. */
  async execDetached(id: string, command: string, signal?: AbortSignal): Promise<{ pid: number | null }> {
    const record = await this.cli.json(["exec", id, "--detach", "--", "bash", "-lc", command], { timeoutMs: 90_000, signal });
    if (record.event === "error" || record.success === false) {
      throw new BoatError(str(record.error) ?? "boat exec --detach failed", { code: str(record.code) ?? "boat_failed" });
    }
    return { pid: num(record.pid) ?? num(record.processId) };
  }

  /** Save the sandbox's state under a name (`boat new --from <name>` starts from it). */
  async snapshot(id: string, name: string, signal?: AbortSignal): Promise<{ name: string; sizeBytes: number | null }> {
    const record = await this.cli.json(["snapshot", id, name], { timeoutMs: 900_000, signal });
    return { name: str(record.name) ?? name, sizeBytes: num(record.sizeBytes) };
  }

  /** Saved snapshots and the plan's allowance for them. */
  async snapshots(signal?: AbortSignal): Promise<{ snapshots: SavedSnapshot[]; included: number | null; used: number | null }> {
    const record = await this.cli.json(["snapshots"], { timeoutMs: 60_000, signal });
    const named = Array.isArray(record.named) ? record.named : [];
    const allowance = rec(record.namedAllowance) ?? rec(record.savedAllowance);
    return {
      snapshots: named
        .map((entry) => rec(entry))
        .filter((entry): entry is JsonRecord => entry !== null && str(entry.name) !== null)
        .map((entry) => ({
          name: str(entry.name)!,
          sizeBytes: num(entry.sizeBytes),
          createdAt: str(entry.createdAt),
          sourceSandboxId: str(entry.sourceSandboxId),
          status: str(entry.status),
          type: str(entry.type),
        })),
      included: num(allowance?.included),
      used: num(allowance?.used),
    };
  }

  /**
   * Land a worker's commits on the base branch, after the user approved them:
   * bring them up to date with the base (a rebase; nothing is ever forced) and
   * push. Uncommitted changes or conflicts stop it before anything is pushed.
   */
  /**
   * Land a worker's commits on the base branch (see shipScript). Throws a
   * BoatError with code ship_<reason>; its `shipped` lists repos that landed
   * before a later one failed.
   */
  async ship(id: string, targets: ShipTarget[], signal?: AbortSignal): Promise<ShipResult> {
    const result = await this.exec(id, shipScript(targets), { timeoutMs: 300_000, signal });
    const parsed = parseShipOutput(result.stdout, targets);
    if (parsed.failure !== null) {
      const { target, reason, detail } = parsed.failure;
      const where = target ? `${target.path} → ${target.baseBranch}` : "the checkout";
      const why: Record<string, string> = {
        missing: "the checkout is gone",
        dirty: `it has changes that aren't committed (${detail.slice(0, 4).join("; ") || "see git status"}); the task's agent must commit or remove them`,
        fetch: `fetching the base branch failed (${detail.at(-1) ?? "is the sandbox's GitHub login still valid?"})`,
        conflict: "its commits conflict with the latest base branch (the task's agent must rebase and resolve them)",
        push: `the push was refused (${detail.at(-1) ?? "the base moved on, or the GitHub login can't push there"})`,
      };
      const partial = parsed.shipped.length > 0 ? ` Already shipped: ${parsed.shipped.map((entry) => `${entry.path} → ${entry.baseBranch}`).join(", ")}.` : "";
      throw Object.assign(new BoatError(`Couldn't ship ${where}: ${why[reason] ?? reason}.${partial}`, { code: `ship_${reason}` }), { shipped: parsed.shipped });
    }
    if (!result.stdout.includes("BOAT_SHIP_DONE")) {
      const detail = `${result.stderr}\n${result.stdout}`.trim().split("\n").slice(-4).join(" ");
      throw Object.assign(new BoatError(`Shipping failed: ${detail || `exit code ${result.exitCode}`}`, { code: "ship_failed" }), { shipped: parsed.shipped });
    }
    return { shipped: parsed.shipped };
  }

  async extend(id: string, args: string[], signal?: AbortSignal): Promise<JsonRecord> {
    return this.cli.json(["extend", id, ...args], { signal });
  }

  async exec(
    id: string,
    command: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const remoteSeconds = Math.max(5, Math.min(600, Math.round((options.timeoutMs ?? 120_000) / 1000)));
    const result = await this.cli.run(
      ["exec", id, "--timeout", String(remoteSeconds), "--", "bash", "-lc", command],
      { timeoutMs: remoteSeconds * 1000 + 30_000, signal: options.signal, allowFailure: true },
    );
    const record = result.records.at(-1);
    if (record?.event === "error") {
      throw new BoatError(str(record.error) ?? "boat exec failed", {
        code: str(record.code) ?? "boat_failed",
        status: num(record.status),
      });
    }
    if (record === undefined || num(record.exitCode) === null) {
      throw new BoatError(result.stderr.trim() || "boat exec printed no result", {
        code: "boat_bad_output",
        exitCode: result.exitCode,
      });
    }
    return {
      exitCode: num(record.exitCode) ?? result.exitCode,
      stdout: str(record.stdout) ?? "",
      stderr: str(record.stderr) ?? "",
    };
  }

  /**
   * Make git + gh usable and clone the repository into ~/work/<name>. The
   * sandbox's gh CLI is already logged in as the user; git needs the gh
   * credential helper and a commit identity.
   */
  async prepareRepo(id: string, repo: string, checkout: CheckoutMode, options: PrepareOptions = {}): Promise<PreparedRepo> {
    const { signal, workDir } = options;
    const name = repo.split("/")[1] ?? "repo";
    const repoPattern = repo.replace(/[.]/g, "\\.");
    const parentDir = workDir ? `$HOME/work/${workDir.replace(/[^A-Za-z0-9_.-]/g, "")}` : "$HOME/work";
    const checkoutScript = (() => {
      switch (checkout.kind) {
        case "new-branch":
          return `BRANCH=${shellQuote(checkout.branch)}
if [ "$BRANCH" = "$BASE" ]; then
  echo "Refusing to work directly on the base branch $BASE; pick a separate working branch." >&2
  exit 3
fi
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git checkout "$BRANCH"
elif git show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
  git checkout -b "$BRANCH" --track "origin/$BRANCH"
else
  git checkout -b "$BRANCH" "origin/$BASE"
fi`;
        case "existing-branch":
          return `BRANCH=${shellQuote(checkout.branch)}
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git checkout "$BRANCH"
  git pull --ff-only --quiet || true
else
  git checkout -b "$BRANCH" --track "origin/$BRANCH"
fi`;
        case "pull-request":
          return `gh pr checkout ${shellQuote(checkout.pr)} --force`;
        case "default-branch":
          // Fresh from GitHub (an environment's clone can be days old).
          return `git checkout -B "$BASE" "origin/$BASE"`;
      }
    })();
    const base = checkout.kind === "new-branch" || checkout.kind === "default-branch" ? (checkout.base ?? null) : null;
    const safeName = (name: string) => /^[A-Za-z0-9._\/-]+$/.test(name);
    const protect = (options.protect ?? []).filter(safeName);
    const alwaysProtect = (options.alwaysProtect ?? DEFAULT_PROTECTED_BRANCHES).filter(safeName);
    // The plugin's hooks folder: the protected list (incl. the base found
    // here), pre-push, and pass-through hooks. Sandboxes the plugin creates
    // point git at it through BOAT_GIT_ENV; elsewhere it's set repo-locally
    // unless the repo already has its own hooks path.
    const hookFiles = [
      `printf '%s' ${shellQuote(prePushHook())} > "$HOOKS/pre-push"`,
      ...CHAINED_HOOKS.map((hook) => `printf '%s' ${shellQuote(chainedHook(hook))} > "$HOOKS/${hook}"`),
    ].join("\n");
    const hook = `HOOKS="$HOME/.boat-hooks"
mkdir -p "$HOOKS"
{ cat "$HOOKS/protected" 2>/dev/null || true; printf '%s\\n' ${alwaysProtect.map(shellQuote).join(" ")}; } | grep -v '^$' | sort -u > "$HOOKS/protected.new"
mv "$HOOKS/protected.new" "$HOOKS/protected"
printf '%s\\n' ${protect.map(shellQuote).join(" ")} "$BASE" | grep -v '^$' | sort -u > "$(git rev-parse --git-common-dir)/boat-protected"
${options.noPush === true ? `printf 'ships after approval\\n' > "$(git rev-parse --git-common-dir)/boat-no-push"` : `rm -f "$(git rev-parse --git-common-dir)/boat-no-push"`}
${hookFiles}
chmod +x "$HOOKS"/*
# Worktree config outranks the repo-local hooksPath that husky & co. write
# during npm install; the repo's own hooks still run through the chain.
git config extensions.worktreeConfig true
git config --worktree core.hooksPath "$HOOKS"`;
    const script = `set -euo pipefail
export GIT_TERMINAL_PROMPT=0
gh auth setup-git >/dev/null 2>&1 || true
if [ -z "$(git config --global user.email || true)" ]; then
  LOGIN=$(gh api user --jq .login 2>/dev/null || echo boat-agent)
  UID_=$(gh api user --jq .id 2>/dev/null || echo 0)
  git config --global user.name "$LOGIN"
  git config --global user.email "$UID_+$LOGIN@users.noreply.github.com"
fi
REPO=${shellQuote(repo)}
DIR=${shellQuote(name)}
# Can boat's GitHub login see this repo (and push to it)? Say so before cloning.
set +e
ACCESS_LINES=$(
${GITHUB_ACCESS_SNIPPET}
)
set -e
printf '%s\\n' "$ACCESS_LINES"
case "$ACCESS_LINES" in *"BOAT_ACCESS none"*|*"BOAT_ACCESS denied"*|*"BOAT_ACCESS expired"*|*"BOAT_ACCESS nologin"*) exit 4 ;; esac
is_repo() { git -C "$1" remote get-url origin 2>/dev/null | grep -qiE ${shellQuote(`github\\.com[:/]${repoPattern}(\\.git)?$`)}; }
if [ ${options.useEnvironmentCheckout === true ? "1" : "0"} = 1 ] && [ -d "$HOME/$DIR/.git" ] && is_repo "$HOME/$DIR" \
   && [ -z "$(git -C "$HOME/$DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
  # The boat environment cloned it (and ran its setup script) already.
  cd "$HOME/$DIR"
else
  mkdir -p "${parentDir}"
  cd "${parentDir}"
  # Another repo with the same name lives here (multi-repo projects): use owner-name.
  if [ -d "$DIR/.git" ] && ! is_repo "$DIR"; then DIR=${shellQuote(`${repo.split("/")[0] ?? "owner"}-${name}`)}; fi
  if [ ! -d "$DIR/.git" ]; then
    gh repo clone "$REPO" "$DIR" -- --filter=blob:none --quiet
  fi
  cd "$DIR"
fi
git fetch origin --prune --quiet
BASE=${base === null ? `"$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)"` : shellQuote(base)}
[ -n "$BASE" ] || BASE=$(gh repo view "$REPO" --json defaultBranchRef --jq .defaultBranchRef.name)
${checkoutScript}
${hook}
echo "BOAT_SETUP path=$PWD branch=$(git rev-parse --abbrev-ref HEAD) base=$BASE"
`;
    const result = await this.exec(id, script, { timeoutMs: 600_000, signal });
    // No access, or an expired login: say exactly what to fix.
    const access = parseGithubAccess(result.stdout, repo, options.environment ?? null);
    const marker = result.stdout.match(/BOAT_SETUP path=(\S+) branch=(\S+) base=(\S*)/);
    if (result.exitCode !== 0 || marker === null) {
      const detail = `${result.stderr}\n${result.stdout}`.trim().split("\n").slice(-12).join("\n");
      throw new BoatError(`Preparing ${repo} in the sandbox failed:\n${detail}`, {
        code: "repo_setup_failed",
        exitCode: result.exitCode,
      });
    }
    return {
      path: marker[1] ?? `~/work/${name}`,
      branch: marker[2] === "HEAD" ? null : (marker[2] ?? null),
      baseBranch: marker[3] === "" ? null : (marker[3] ?? null),
      canPush: access.canPush,
      githubExpiresAt: access.githubExpiresAt,
    };
  }

  /** The sandbox's GitHub login now: still valid, and until when (no repo needed). */
  async githubLogin(id: string, signal?: AbortSignal): Promise<{ valid: boolean | null; expiresAt: string | null }> {
    const result = await this.exec(
      id,
      `OUT=$(gh api -i user 2>&1); case "$OUT" in *"Bad credentials"*|*"HTTP 401"*) echo "BOAT_LOGIN expired" ;; *"HTTP/"*" 200"*) echo "BOAT_LOGIN ok" ;; *) echo "BOAT_LOGIN unknown" ;; esac
printf '%s\n' "$OUT" | tr -d '\r' | grep -i '^github-authentication-token-expiration:' | cut -d' ' -f2- | sed 's/^/BOAT_GH_EXPIRES /'`,
      { timeoutMs: 30_000, signal },
    );
    const state = result.stdout.match(/BOAT_LOGIN (\w+)/)?.[1];
    const expires = result.stdout.match(/BOAT_GH_EXPIRES (.+)/)?.[1]?.trim();
    const parsed = expires ? Date.parse(expires.replace(" UTC", "Z").replace(" ", "T")) : NaN;
    return { valid: state === "ok" ? true : state === "expired" ? false : null, expiresAt: Number.isFinite(parsed) ? new Date(parsed).toISOString() : null };
  }

  /**
   * A boat environment's setup, with its variables' NAMES only: the values
   * are dropped the moment they're read and never leave this function.
   */
  async environmentInfo(name: string, signal?: AbortSignal): Promise<EnvironmentInfo> {
    const record = await this.cli.json(["env", "info", name], { timeoutMs: 60_000, signal });
    const env = rec(record.environment) ?? record;
    const effective = rec(env.effective) ?? {};
    const secretNames = envNames(typeof env.envContents === "string" ? env.envContents : "");
    const files = Array.isArray(env.secretFiles) ? env.secretFiles : [];
    const repos = Array.isArray(env.selectedRepositories) ? env.selectedRepositories : [];
    return {
      name: str(env.name) ?? name,
      secretNames,
      secretFiles: files.map((file) => (typeof file === "string" ? file : (str(rec(file)?.path) ?? str(rec(file)?.name) ?? "?"))),
      repos: repos
        .map((entry) => rec(entry))
        .filter((entry): entry is JsonRecord => entry !== null && str(entry.fullName) !== null)
        .map((entry) => ({ repo: str(entry.fullName)!, permission: str(entry.permissions), baseBranch: str(entry.baseBranch) })),
      passGithub: bool(effective.passGithub) ?? bool(env.passGithub),
      passSecrets: bool(effective.passSecrets) ?? bool(env.passSecrets),
      passAgentsCredentials: bool(effective.passAgentsCredentials) ?? bool(env.passAgentsCredentials),
      passSandboxCredentials: bool(effective.passSandboxCredentials) ?? bool(env.passSandboxCredentials),
      proxyAiCredentials: bool(env.proxyAiCredentials),
      safeForThirdParties: bool(env.safeForThirdParties),
    };
  }

  /** The account's AI credentials proxy and its price (read-only: `boat ai proxy` without on or off). */
  async aiProxy(signal?: AbortSignal): Promise<AiProxyState> {
    return parseAiProxy(await this.cli.json(["ai", "proxy"], { timeoutMs: 30_000, signal }));
  }

  /**
   * Send a prompt to a coding agent in the sandbox and return as soon as boat
   * has queued it. The agent keeps working after the local CLI exits.
   */
  async prompt(options: {
    sandboxId: string;
    prompt: string;
    /** Always explicit: without it boat uses the dashboard default harness. */
    provider: Provider;
    model?: string | null;
    reasoningEffort?: string | null;
    conversationId?: string | null;
    signal?: AbortSignal;
  }): Promise<Dispatch> {
    // boat creates a conversation under an unknown id passed to --resume, so
    // new conversations get an id we choose: known before dispatch, and a
    // retry cannot fork a second conversation.
    const conversationId = options.conversationId ?? randomUUID();
    const args = ["prompt", options.sandboxId, "--provider", options.provider, "--resume", conversationId];
    if (options.model) args.push("--model", options.model);
    if (options.reasoningEffort) args.push("--reasoning-effort", options.reasoningEffort);
    args.push(safePositional(options.prompt));
    return this.cli.until(
      args,
      (record) => {
        if (record.event !== "queued") return null;
        const data = rec(record.data);
        const run = rec(data?.promptRun);
        return {
          conversationId:
            str(data?.conversationId) ?? str(run?.conversationId) ?? str(record.convo) ?? conversationId,
          promptId: str(data?.promptId) ?? str(run?.id) ?? str(record.promptId),
          model: str(data?.model) ?? str(record.model),
        };
      },
      { timeoutMs: 120_000, signal: options.signal },
    );
  }

  async conversations(sandboxId: string, signal?: AbortSignal): Promise<Conversation[]> {
    const result = await this.cli.run(["conversations", sandboxId], { signal });
    return result.records
      .map((record) => rec(record.data) ?? record)
      .map((data) => {
        const id = str(data.id);
        if (id === null) return null;
        return {
          id,
          running: bool(data.running) ?? false,
          harness: str(data.lastHarness),
          model: str(data.lastModel),
          prompts: num(data.prompts) ?? 0,
          lastPromptAt: str(data.lastPromptAt),
          lastPromptPreview: str(data.lastPromptPreview),
        };
      })
      .filter((entry): entry is Conversation => entry !== null);
  }

  async events(sandboxId: string, conversationId: string, signal?: AbortSignal): Promise<ChatEvent[]> {
    const result = await this.cli.run(["events", sandboxId, "--convo", conversationId], {
      signal,
      timeoutMs: 120_000,
      keepTail: true,
    });
    return result.records
      .filter((record) => record.event === "chat" || record.event === "usage_limit")
      .map((record) => {
        const outer = rec(record.data) ?? {};
        const inner = rec(outer.data) ?? {};
        const tools = Array.isArray(inner.tools)
          ? inner.tools
              // boat sends { use: { name, input }, result } per tool step.
              .map((tool) => str(rec(rec(tool)?.use)?.name) ?? str(rec(tool)?.name))
              .filter((name): name is string => name !== null)
          : [];
        return {
          type: str(outer.type) ?? "unknown",
          promptId: str(outer.taskId),
          conversationId: str(outer.conversationId),
          status: str(inner.status),
          // Responses carry `content`; prompt events carry the prompt text.
          content: typeof inner.content === "string" ? inner.content : str(inner.prompt),
          error: str(inner.error) ?? str(rec(inner.error)?.message) ?? (record.event === "chat" && str(outer.type) === "usage_limit" ? JSON.stringify(inner).slice(0, 500) : null),
          timestamp: num(outer.timestamp),
          tools,
        };
      });
  }

  async steer(sandboxId: string, conversationId: string, message: string, signal?: AbortSignal): Promise<void> {
    await this.cli.run(["steer", sandboxId, "--convo", conversationId, safePositional(message)], { signal });
  }

  async interrupt(sandboxId: string, conversationId: string | null, signal?: AbortSignal): Promise<void> {
    const args = ["interrupt", sandboxId];
    if (conversationId !== null) args.push("--convo", conversationId);
    await this.cli.run(args, { signal });
  }
}

/** The agent's final answer for one prompt run: the last non-empty response. */
export function finalResponse(events: ChatEvent[], promptId: string | null): string | null {
  const relevant = events.filter(
    (event) => event.type === "response" && (promptId === null || event.promptId === promptId),
  );
  for (let index = relevant.length - 1; index >= 0; index -= 1) {
    const content = relevant[index]?.content?.trim();
    if (content) return content;
  }
  return null;
}

/** The terminal status boat recorded for one prompt run (`finished`, `failed`, ...). */
export function promptStatus(events: ChatEvent[], promptId: string | null): string | null {
  const prompts = events.filter(
    (event) => event.type === "prompt" && (promptId === null || event.promptId === promptId),
  );
  return prompts.at(-1)?.status ?? null;
}
