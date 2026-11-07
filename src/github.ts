// Read single files from GitHub with the bb server machine's `gh` login
// (GitHub is the source of truth; orchestrators may run anywhere).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

const MAX_BYTES = 200 * 1024;
// What a signed-out gh prints ("Welcome to GitHub CLI! … run `gh auth login`").
const SIGNED_OUT = /not logged in|gh auth login|no accounts/i;
// Short: an edited rules file should reach the next boat_protocol call.
const CACHE_MS = 30_000;

/** ref null: the repo's default branch. */
export type RepoFileReader = (repo: string, path: string, ref: string | null, signal?: AbortSignal) => Promise<string>;

function ghBinary(): string {
  // Tests point this at a fake gh.
  if (process.env.BOAT_PLUGIN_GH) return process.env.BOAT_PLUGIN_GH;
  for (const candidate of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "gh";
}

/** `contents/` API path for a repo-relative file (each segment encoded). */
export function contentsPath(repo: string, path: string, ref: string | null): string {
  const file = path
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .map(encodeURIComponent)
    .join("/");
  return `repos/${repo}/contents/${file}${ref === null ? "" : `?ref=${encodeURIComponent(ref)}`}`;
}

/** Raw file content via `gh api`, cached for a few minutes. */
export function createRepoFileReader(): RepoFileReader {
  const cache = new Map<string, { at: number; text: string }>();
  return (repo, path, ref, signal) => {
    const key = `${repo}\n${path}\n${ref}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.text);
    return new Promise((resolve, reject) => {
      execFile(
        ghBinary(),
        ["api", "-H", "Accept: application/vnd.github.raw", contentsPath(repo, path, ref)],
        { timeout: 20_000, maxBuffer: MAX_BYTES * 2, signal, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } },
        (error, stdout, stderr) => {
          if (error) {
            const text = `${stderr}`.trim() || error.message;
            const detail = text.split("\n").map((line) => line.trim()).filter((line) => line !== "").slice(-2).join(" ");
            reject(
              new Error(
                /ENOENT/.test(error.message)
                  ? "the GitHub CLI (gh) isn't installed on the bb server's machine"
                  : SIGNED_OUT.test(text)
                    ? "the GitHub CLI (gh) on the bb server's machine isn't signed in (run `gh auth login` there)"
                    : detail,
              ),
            );
            return;
          }
          if (Buffer.byteLength(stdout) > MAX_BYTES) {
            reject(new Error(`the file is larger than ${MAX_BYTES / 1024} KiB`));
            return;
          }
          cache.set(key, { at: Date.now(), text: stdout });
          resolve(stdout);
        },
      );
    });
  };
}

/** Is `gh` on this computer installed and signed in? (`gh auth status`; read-only.) */
export function ghStatus(signal?: AbortSignal): Promise<{ state: "ok" | "not-installed" | "signed-out" | "unknown"; detail: string | null }> {
  return new Promise((resolve) => {
    execFile(
      ghBinary(),
      ["auth", "status"],
      { timeout: 10_000, signal, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } },
      (error, _stdout, stderr) => {
        if (!error) return resolve({ state: "ok", detail: null });
        if (/ENOENT/.test(error.message)) return resolve({ state: "not-installed", detail: null });
        const text = `${stderr}`.trim();
        resolve(SIGNED_OUT.test(text) ? { state: "signed-out", detail: null } : { state: "unknown", detail: text.split("\n").at(-1) ?? null });
      },
    );
  });
}

/** Only canonical GitHub PR URLs that belong to this task's repository. */
export function pullRequestNumber(repo: string, url: string): number {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("The task repository is invalid.");
  const parsed = new URL(url);
  const match = /^\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?$/.exec(parsed.pathname);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || !match || match[1].toLowerCase() !== repo.toLowerCase() || !Number.isSafeInteger(Number(match[2]))) {
    throw new Error("The pull request doesn't belong to this task's repository.");
  }
  return Number(match[2]);
}

/** Bounded, cancellable invocation of the existing server-side gh path. */
function gh(args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => execFile(ghBinary(), args,
    { timeout: 30_000, maxBuffer: MAX_BYTES, signal, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } },
    (error, stdout, stderr) => error ? reject(new Error((String(stderr).trim() || error.message).slice(0, 600))) : resolve(stdout)));
}

const PR_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed pullRequest(number:$number){number url title headRefOid baseRefOid headRefName baseRefName additions deletions state isDraft mergeable mergeStateStatus reviewDecision commits(last:1){totalCount nodes{commit{statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} nodes{__typename ... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}}}}}}}}}}`;

/** No cache: confirmations always see fresh HEAD, branch rules and checks. */
export async function getPullRequest(repo: string, url: string, signal?: AbortSignal): Promise<import("../contract-merge.ts").PullRequestFacts> {
  const number = pullRequestNumber(repo, url);
  const [owner, name] = repo.split("/");
  const raw = JSON.parse(await gh(["api", "graphql", "-f", `query=${PR_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`], signal));
  if (raw.errors?.length) throw new Error("GitHub couldn't read the pull request and checks. Try again.");
  const repository = raw.data?.repository;
  const pr = repository?.pullRequest;
  if (!pr) throw new Error("GitHub couldn't find this task's pull request.");
  const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
  const { pullRequestFactsSchema } = await import("../contract-merge.ts");
  const facts = pullRequestFactsSchema.parse({ repo, number: pr.number, url: pr.url, title: pr.title, head: pr.headRefOid, base: pr.baseRefOid,
    headBranch: pr.headRefName, baseBranch: pr.baseRefName, additions: pr.additions, deletions: pr.deletions, commits: pr.commits.totalCount,
    state: pr.state, draft: pr.isDraft, mergeable: pr.mergeable, mergeState: pr.mergeStateStatus, reviewDecision: pr.reviewDecision ?? "",
    checks: (contexts?.nodes ?? []).map((check: Record<string, string | null>) => ({ name: check.name ?? check.context,
      state: check.__typename === "CheckRun" ? check.status === "COMPLETED" ? check.conclusion ?? "UNKNOWN" : check.status : check.state,
      url: check.detailsUrl || check.targetUrl || null })), checksTruncated: contexts?.pageInfo?.hasNextPage ?? false,
    mergeMethod: repository.mergeCommitAllowed ? "merge" : repository.squashMergeAllowed ? "squash" : repository.rebaseMergeAllowed ? "rebase" : null,
  });
  if (facts.number !== number || pullRequestNumber(repo, facts.url) !== number) throw new Error("GitHub returned a different pull request.");
  return facts;
}

/** Atomic server-side HEAD guard; no admin bypass, auto-merge or branch deletion. */
export async function mergePullRequest(facts: import("../contract-merge.ts").PullRequestFacts, signal?: AbortSignal): Promise<void> {
  const { pullRequestFactsSchema } = await import("../contract-merge.ts");
  const checked = pullRequestFactsSchema.parse(facts);
  const number = pullRequestNumber(checked.repo, checked.url);
  if (checked.mergeMethod === null) throw new Error("This repository has no enabled merge method.");
  await gh(["pr", "merge", String(number), "--repo", checked.repo, `--${checked.mergeMethod}`, "--match-head-commit", checked.head], signal);
}
