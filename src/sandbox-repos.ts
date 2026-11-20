// The plugin's repo steps in a sandbox, on any provider: check a repo out
// with the push guard, ask the sandbox's GitHub login, and ship approved
// commits. Each is a bash script run over the provider's exec, with the
// GitHub login the provider gives its sandboxes (gh); the provider only
// words the problems (RepoWords) in its own terms.
import { codeSpan } from "./literal.ts";
import { shellQuote } from "./providers/shell.ts";
import {
  ProviderError,
  type CheckoutMode,
  type GithubLogin,
  type PrepareOptions,
  type PreparedRepo,
  type RepoWords,
  type SandboxProvider,
  type ShipConflict,
  type ShipResult,
  type ShipTarget,
} from "./providers/types.ts";

/** What the repo steps need from a provider: its exec, and its words for what goes wrong. */
export type RepoProvider = Pick<SandboxProvider, "exec" | "repoWords" | "beforeRepo" | "retryGithubAccess">;

/** Branches no worker may push to anywhere (plus each project's base and the extra-branches setting). */
export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = ["main", "master"];

/** Words for a provider that has none of its own. */
export const NEUTRAL_REPO_WORDS: RepoWords = {
  cantSee: (repo) => `The sandbox's GitHub login can't see ${repo}. Give it access to ${repo}, or check the repo name. Then try again.`,
  denied: (repo, detail) => `GitHub refused the sandbox's access to ${repo}: ${detail}.`,
  noLogin: () => "The sandbox has no GitHub login. Give its sandboxes a GitHub login, then try again.",
  expired: () => "The sandbox's GitHub login has expired. Give its sandboxes a fresh GitHub login, or start the work in a new sandbox.",
  error: (message, options) => new ProviderError(message, options),
};

function wordsOf(provider: Pick<RepoProvider, "repoWords">): RepoWords {
  return provider.repoWords ?? NEUTRAL_REPO_WORDS;
}

/** Conflicting files the ship script lists. */
export const SHIP_CONFLICT_FILES = 10;


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
  ("") ;;
  (file://*) local_remote=1 ;;
  (*://*) ;;
  (*) case "\${url%%/*}" in (*:*) ;; (*) local_remote=1 ;; esac ;;
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

// Leading parentheses keep case patterns balanced inside $(...) on bash 3.2.
/** The sandbox's GitHub login and a repo: one line the prepare script prints, and how to fix it. */
export const GITHUB_ACCESS_SNIPPET = `ACCESS_OUT=$(gh api "repos/$REPO" --jq '"\\(.permissions.push) \\(.permissions.pull)"' 2>&1) && ACCESS_OK=1 || ACCESS_OK=0
if [ "$ACCESS_OK" = 0 ]; then
  case "$ACCESS_OUT" in
    (*"rate limit"*) echo "BOAT_ACCESS unknown" ;;
    (*"Bad credentials"*|*"HTTP 401"*) echo "BOAT_ACCESS expired" ;;
    (*"gh auth login"*|*"GH_TOKEN"*|*"not logged"*) echo "BOAT_ACCESS nologin" ;;
    (*"Not Found"*|*"HTTP 404"*) echo "BOAT_ACCESS none" ;;
    (*"HTTP 403"*) echo "BOAT_ACCESS denied" ;;
    (*) echo "BOAT_ACCESS unknown" ;;
  esac
  printf 'BOAT_ACCESS_DETAIL %s\\n' "$(printf '%s' "$ACCESS_OUT" | head -1 | cut -c1-300)"
else
  echo "BOAT_ACCESS ok push=\${ACCESS_OUT%% *}"
fi
GH_EXP=$(gh api -i user 2>/dev/null | tr -d '\\r' | grep -i '^github-authentication-token-expiration:' | cut -d' ' -f2- || true)
echo "BOAT_GH_EXPIRES \${GH_EXP:-unknown}"`;

/** A proxy grant may still be pending just after secrets push. Retry only 401s. */
export function githubAccessSnippet(retry = false): string {
  if (!retry) return GITHUB_ACCESS_SNIPPET;
  return `ACCESS_LINES=$(
${GITHUB_ACCESS_SNIPPET}
)
case "$ACCESS_LINES" in
  (*"BOAT_ACCESS expired"*)
    sleep 2
    ACCESS_LINES=$(
${GITHUB_ACCESS_SNIPPET}
)
    ;;
esac
printf '%s\\n' "$ACCESS_LINES"`;
}

/** Access results that stop a checkout before it clones (the rest let the clone try). */
export const ACCESS_BLOCKING = ["none", "denied", "expired", "nologin"] as const;

/**
 * Parse the access lines; throws the plain-words error when the work can't
 * go on, in the provider's words (neutral ones for a provider without
 * its own).
 */
export function parseGithubAccess(
  stdout: string,
  repo: string,
  environment: string | null = null,
  words: RepoWords = NEUTRAL_REPO_WORDS,
): { canPush: boolean | null; githubExpiresAt: string | null } {
  const access = stdout.match(/BOAT_ACCESS (\w+)(?: push=(\w+))?/);
  const detail = stdout.match(/BOAT_ACCESS_DETAIL (.*)/)?.[1]?.trim() ?? "";
  const expires = stdout.match(/BOAT_GH_EXPIRES (.+)/)?.[1]?.trim() ?? "unknown";
  const parsed = expires === "unknown" ? NaN : Date.parse(expires.replace(" UTC", "Z").replace(" ", "T"));
  const githubExpiresAt = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  switch (access?.[1]) {
    case "none":
      throw words.error(words.cantSee(repo), { code: "repo_access" });
    case "denied":
      throw words.error(words.denied(repo, detail || "HTTP 403"), { code: "repo_access" });
    case "nologin":
      throw words.error(words.noLogin(environment), { code: "repo_access" });
    case "expired":
      throw words.error(words.expired(environment), { code: "github_token_expired" });
  }
  return { canPush: access?.[1] === "ok" ? (access[2] === "true" ? true : access[2] === "false" ? false : null) : null, githubExpiresAt };
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
# A rebase that stopped (already aborted): the task's head, the base, the
# conflicting files ($3, one per line) and the base commits that changed them.
conflict() {
  echo "BOAT_SHIP_ERROR $1 conflict"
  echo "BOAT_SHIP_DETAIL head $(git rev-parse HEAD 2>/dev/null)"
  echo "BOAT_SHIP_DETAIL base $(git rev-parse "$2" 2>/dev/null)"
  # A plain loop, not mapfile: bash 3.2 (macOS's /bin/bash) has no mapfile.
  local FILES=() LINE
  while IFS= read -r LINE; do [ -n "$LINE" ] && FILES+=("$LINE"); done <<< "$3"
  if [ "\${#FILES[@]}" -gt 0 ]; then
    printf 'BOAT_SHIP_DETAIL file %s\\n' "\${FILES[@]:0:${SHIP_CONFLICT_FILES}}"
    [ "\${#FILES[@]}" -gt ${SHIP_CONFLICT_FILES} ] && echo "BOAT_SHIP_DETAIL more $((\${#FILES[@]} - ${SHIP_CONFLICT_FILES}))"
    local FORK
    FORK=$(git merge-base HEAD "$2" 2>/dev/null) && git log --no-merges -n 3 --format='BOAT_SHIP_DETAIL commit %h %s' "$FORK..$2" -- "\${FILES[@]}" 2>/dev/null
  fi
  exit 3
}
${each((target, index) => `cd ${shellQuote(target.path)} || fail ${index} missing
DIRTY=$(git status --porcelain)
[ -z "$DIRTY" ] || fail ${index} dirty "$DIRTY"
OUT=$(git fetch --quiet origin ${shellQuote(target.baseBranch)} 2>&1) || fail ${index} fetch "$OUT"`)}
${each((target, index) => `cd ${shellQuote(target.path)}
AHEAD_${index}=$(git rev-list --count ${shellQuote(`origin/${target.baseBranch}`)}..HEAD)
if [ "$AHEAD_${index}" != "0" ]; then
  if ! git rebase --quiet ${shellQuote(`origin/${target.baseBranch}`)} >/dev/null 2>&1; then
    UNMERGED=$(git -c core.quotePath=false diff --name-only --diff-filter=U 2>/dev/null)
    git rebase --abort >/dev/null 2>&1
    conflict ${index} ${shellQuote(`origin/${target.baseBranch}`)} "$UNMERGED"
  fi
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
export function parseShipOutput(
  stdout: string,
  targets: ShipTarget[],
): ShipResult & { failure: { target: ShipTarget | null; reason: string; detail: string[]; conflict: ShipConflict | null } | null } {
  const shipped = [...stdout.matchAll(/BOAT_SHIPPED (\d+) ([0-9a-f]{7,40}) (\d+)/g)].map((match) => {
    const target = targets[Number(match[1])]!;
    return { path: target.path, baseBranch: target.baseBranch, sha: match[2]!, commits: Number(match[3]) };
  });
  const failed = stdout.match(/BOAT_SHIP_ERROR (\d+) (\w+)/);
  const detail = [...stdout.matchAll(/^BOAT_SHIP_DETAIL (.*)$/gm)].map((match) => match[1]!.trim()).filter(Boolean);
  if (failed === null) return { shipped, failure: null };
  const reason = failed[2]!;
  return {
    shipped,
    failure: { target: targets[Number(failed[1])] ?? null, reason, detail, conflict: reason === "conflict" ? parseConflictDetail(detail) : null },
  };
}

/** The ship script's conflict detail: `head <sha>`, `base <sha>`, `file <path>`, `more <n>`, `commit <sha> <subject>`. */
export function parseConflictDetail(detail: readonly string[]): ShipConflict {
  const conflict: ShipConflict = { head: null, base: null, files: [], moreFiles: 0, commits: [] };
  for (const line of detail) {
    const match = line.match(/^(head|base|file|more|commit) (.+)$/);
    if (match === null) continue;
    const key = match[1]!;
    const value = match[2]!.trim();
    if (key === "head" || key === "base") {
      if (/^[0-9a-f]{7,64}$/.test(value)) conflict[key] = value;
    } else if (key === "file") {
      conflict.files.push(value);
    } else if (key === "more") {
      conflict.moreFiles = Math.max(0, Number.parseInt(value, 10) || 0);
    } else {
      const commit = value.match(/^([0-9a-f]{4,64})(?: (.*))?$/);
      if (commit !== null) conflict.commits.push({ sha: commit[1]!, subject: (commit[2] ?? "").trim() });
    }
  }
  return conflict;
}

/** "a", "a and b", "a, b and c" */
function joinAnd(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Repository names and subjects in messages: each one clipped to this many characters. */
export const NAME_MAX = 120;
/** A conflict's files-and-commits part longer than this names one file and one commit instead. */
export const CONFLICT_DETAIL_MAX = 600;

/** Up to `shown` file names, as inline code (repository text stays literal), then "and 4 more files". */
export function fileList(files: readonly string[], more = 0, shown = 3): string {
  const named = files.slice(0, shown).map((file) => codeSpan(file, NAME_MAX));
  const rest = files.length - named.length + more;
  if (named.length === 0) return "";
  return rest > 0 ? `${named.join(", ")} and ${rest} more file${rest === 1 ? "" : "s"}` : joinAnd(named);
}

/**
 * Why a ship stopped on a conflict: the files, and the base commits that
 * changed them (with the task of this plugin that shipped one, when known).
 * "its commits conflict with the latest main in `package.json` (changed by
 * 1a2b3c4 `Add the test suite`). The task's agent must rebase and resolve them"
 * File names and subjects are inline code, clipped to NAME_MAX characters;
 * past CONFLICT_DETAIL_MAX it names one file and one commit.
 */
export function conflictReason(baseBranch: string, conflict: ShipConflict, shippedBy: (sha: string) => string | null = () => null): string {
  const detail = (files: number, commits: number): string => {
    const names = fileList(conflict.files, conflict.moreFiles, files);
    if (names === "") return "";
    const listed = conflict.commits.slice(0, commits).map((commit) => {
      const task = shippedBy(commit.sha);
      return `${commit.sha.slice(0, 7)}${commit.subject ? ` ${codeSpan(commit.subject, NAME_MAX)}` : ""}${task ? ` from task ${task}` : ""}`;
    });
    const rest = conflict.commits.length - listed.length;
    const by = rest > 0 ? [...listed, `${rest} more commit${rest === 1 ? "" : "s"}`] : listed;
    return ` in ${names}${listed.length > 0 ? ` (changed by ${joinAnd(by)})` : ""}`;
  };
  const full = detail(3, 3);
  const where = full.length <= CONFLICT_DETAIL_MAX ? full : detail(1, 1);
  return `its commits conflict with the latest ${baseBranch}${where}. The task's agent must rebase and resolve them`;
}

// ---------------------------------------------------------------- the steps

/**
 * Make git + gh usable and clone the repository into ~/work/<name>. The
 * sandbox's gh CLI is already logged in as the user; git needs the gh
 * credential helper and a commit identity.
 */
export async function prepareRepo(provider: RepoProvider, id: string, repo: string, checkout: CheckoutMode, options: PrepareOptions = {}): Promise<PreparedRepo> {
  await provider.beforeRepo?.(id, options.signal);
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
  const hook = `HOOKS="\${BOAT_HOOKS_DIR:-$HOME/.boat-hooks}"
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
${githubAccessSnippet(provider.retryGithubAccess === true)}
)
set -e
printf '%s\\n' "$ACCESS_LINES"
case "$ACCESS_LINES" in (*"BOAT_ACCESS none"*|*"BOAT_ACCESS denied"*|*"BOAT_ACCESS expired"*|*"BOAT_ACCESS nologin"*) exit 4 ;; esac
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
  const result = await provider.exec(id, script, { timeoutMs: 600_000, signal });
  // No access, or an expired login: say exactly what to fix.
  const access = parseGithubAccess(result.stdout, repo, options.environment ?? null, wordsOf(provider));
  const marker = result.stdout.match(/BOAT_SETUP path=(\S+) branch=(\S+) base=(\S*)/);
  if (result.exitCode !== 0 || marker === null) {
    const detail = `${result.stderr}\n${result.stdout}`.trim().split("\n").slice(-12).join("\n");
    throw wordsOf(provider).error(`Preparing ${repo} in the sandbox failed:\n${detail}`, {
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
export async function githubLogin(provider: Pick<RepoProvider, "exec">, id: string, signal?: AbortSignal): Promise<GithubLogin> {
  const result = await provider.exec(
    id,
    `OUT=$(gh api -i user 2>&1); case "$OUT" in (*"Bad credentials"*|*"HTTP 401"*) echo "BOAT_LOGIN expired" ;; (*"HTTP/"*" 200"*) echo "BOAT_LOGIN ok" ;; (*) echo "BOAT_LOGIN unknown" ;; esac
printf '%s\n' "$OUT" | tr -d '\r' | grep -i '^github-authentication-token-expiration:' | cut -d' ' -f2- | sed 's/^/BOAT_GH_EXPIRES /'`,
    { timeoutMs: 30_000, signal },
  );
  const state = result.stdout.match(/BOAT_LOGIN (\w+)/)?.[1];
  const expires = result.stdout.match(/BOAT_GH_EXPIRES (.+)/)?.[1]?.trim();
  const parsed = expires ? Date.parse(expires.replace(" UTC", "Z").replace(" ", "T")) : NaN;
  return { valid: state === "ok" ? true : state === "expired" ? false : null, expiresAt: Number.isFinite(parsed) ? new Date(parsed).toISOString() : null };
}

/**
 * Land a worker's commits on the base branch (see shipScript). Throws the
 * provider's error with code ship_<reason>; its `shipped` lists repos that landed
 * before a later one failed, and `conflict` what a conflict stopped on.
 * `shippedBy`: the task of this plugin that shipped a base commit, if any.
 */
export async function ship(provider: RepoProvider, id: string, targets: ShipTarget[], signal?: AbortSignal, shippedBy?: (sha: string) => string | null): Promise<ShipResult> {
  const result = await provider.exec(id, shipScript(targets), { timeoutMs: 300_000, signal });
  const parsed = parseShipOutput(result.stdout, targets);
  if (parsed.failure !== null) {
    const { target, reason, detail, conflict } = parsed.failure;
    const where = target ? `${target.path} → ${target.baseBranch}` : "the checkout";
    const why: Record<string, string> = {
      missing: "the checkout is gone",
      dirty: `it has changes that aren't committed (${detail.slice(0, 4).join("; ") || "see git status"}); the task's agent must commit or remove them`,
      fetch: `fetching the base branch failed (${detail.at(-1) ?? "is the sandbox's GitHub login still valid?"})`,
      conflict: conflictReason(target?.baseBranch ?? "base branch", conflict ?? parseConflictDetail([]), shippedBy),
      push: `the push was refused (${detail.at(-1) ?? "the base moved on, or the GitHub login can't push there"})`,
    };
    const partial = parsed.shipped.length > 0 ? ` Already shipped: ${parsed.shipped.map((entry) => `${entry.path} → ${entry.baseBranch}`).join(", ")}.` : "";
    throw Object.assign(wordsOf(provider).error(`Couldn't ship ${where}: ${why[reason] ?? reason}.${partial}`, { code: `ship_${reason}` }), {
      shipped: parsed.shipped,
      conflict: conflict !== null && target !== null ? { ...conflict, path: target.path, baseBranch: target.baseBranch } : null,
    });
  }
  if (!result.stdout.includes("BOAT_SHIP_DONE")) {
    const detail = `${result.stderr}\n${result.stdout}`.trim().split("\n").slice(-4).join(" ");
    throw Object.assign(wordsOf(provider).error(`Shipping failed: ${detail || `exit code ${result.exitCode}`}`, { code: "ship_failed" }), { shipped: parsed.shipped });
  }
  return { shipped: parsed.shipped };
}

/** The three steps, as the service calls them (tests swap them for fakes). */
export interface RepoSteps {
  prepareRepo: typeof prepareRepo;
  githubLogin: typeof githubLogin;
  ship: typeof ship;
}

export const SANDBOX_REPOS: RepoSteps = { prepareRepo, githubLogin, ship };
