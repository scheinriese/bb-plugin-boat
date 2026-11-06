// Local bb projects as orchestrator projects: each one is resolved to its
// GitHub repo and the branch checked out locally. Workers can't see local
// files, so a branch with unpushed commits must be pushed first.
import { execFile } from "node:child_process";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { normalizeRepo } from "./boat-api.ts";
import { protectedBranches, type OrchestratorProject, type ProjectStore } from "./projects.ts";

export interface LocalProject {
  bbProjectId: string;
  name: string;
  repo: string;
  /** Branch checked out in the local checkout; null when it can't be read (other machine). */
  branch: string | null;
  /** Commits not on GitHub yet; null when unknown. */
  unpushed: number | null;
  /** True when the branch doesn't exist on GitHub at all. */
  branchMissingRemotely: boolean;
  path: string | null;
  /** A configured project with the same main repo (its environment etc. are reused). */
  matchesProjectId: string | null;
  problem: string | null;
}

function git(cwd: string, args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().split("\n").slice(-3).join("\n")));
      else resolve(stdout.trim());
    });
  });
}

interface BbProjectRow {
  id: string;
  name: string;
  gitRemoteUrl: string | null;
  sources?: { hostId: string; path: string; isDefault?: boolean; type?: string }[];
}

async function bbProjects(bb: BbPluginApi): Promise<BbProjectRow[]> {
  const raw = (await bb.sdk.projects.list()) as unknown;
  const rows = Array.isArray(raw) ? raw : ((raw as { projects?: unknown[] }).projects ?? []);
  return rows as BbProjectRow[];
}

async function primaryHostId(bb: BbPluginApi): Promise<string | null> {
  const config = (await bb.sdk.system.config()) as { primaryHostId?: string | null };
  return config.primaryHostId ?? null;
}

function githubRepo(url: string | null): string | null {
  if (!url) return null;
  try {
    return normalizeRepo(url);
  } catch {
    return null;
  }
}

/** A bb project's GitHub repo, from its git remote (no git commands); null without one (the personal project). */
export async function bbProjectRepo(bb: BbPluginApi, bbProjectId: string): Promise<string | null> {
  const row = (await bbProjects(bb)).find((entry) => entry.id === bbProjectId);
  return githubRepo(row?.gitRemoteUrl ?? null);
}

/** The checkout on this machine (where git can run), if any. */
function localSource(row: BbProjectRow, hostId: string | null) {
  const sources = (row.sources ?? []).filter((source) => source.hostId === hostId && source.type !== "remote");
  return sources.find((source) => source.isDefault) ?? sources[0] ?? null;
}

/** The git remote whose URL is this GitHub repo (not necessarily "origin"). */
async function remoteFor(path: string, repo: string): Promise<string | null> {
  const lines = (await git(path, ["remote", "-v"])).split("\n");
  for (const line of lines) {
    const [name, url] = line.split(/\s+/);
    if (!name || !url) continue;
    if (githubRepo(url)?.toLowerCase() === repo.toLowerCase()) return name;
  }
  return null;
}

async function inspect(row: BbProjectRow, repo: string, path: string | null, projects: ProjectStore): Promise<LocalProject> {
  const base: LocalProject = {
    bbProjectId: row.id,
    name: row.name,
    repo,
    branch: null,
    unpushed: null,
    branchMissingRemotely: false,
    path,
    matchesProjectId: projects.forRepo(repo)?.id ?? null,
    problem: null,
  };
  if (path === null) return { ...base, problem: "Its checkout is on another machine; pick the branch in a configured project instead." };
  try {
    const branch = await git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch === "HEAD") return { ...base, problem: "The checkout is on a detached HEAD." };
    const remote = await remoteFor(path, repo);
    if (remote === null) return { ...base, branch, problem: `No git remote points at github.com/${repo}.` };
    // Ask GitHub, not the (possibly different or stale) upstream ref.
    const listed = await git(path, ["ls-remote", "--heads", remote, `refs/heads/${branch}`], 20_000);
    const remoteSha = listed.split(/\s+/)[0] ?? "";
    if (remoteSha === "") return { ...base, branch, unpushed: null, branchMissingRemotely: true };
    try {
      await git(path, ["cat-file", "-e", `${remoteSha}^{commit}`]);
    } catch {
      // GitHub is ahead of this checkout: fetch just that branch so local-only
      // commits can still be counted (being behind alone is fine).
      try {
        await git(path, ["fetch", "--quiet", remote, `refs/heads/${branch}`], 30_000);
        await git(path, ["cat-file", "-e", `${remoteSha}^{commit}`]);
      } catch {
        return { ...base, branch, problem: `Couldn't compare ${branch} with GitHub; fetch it locally and reopen the dialog.` };
      }
    }
    const count = Number(await git(path, ["rev-list", "--count", `${remoteSha}..HEAD`]));
    return { ...base, branch, unpushed: Number.isFinite(count) ? count : null };
  } catch (error) {
    return { ...base, problem: error instanceof Error ? error.message : String(error) };
  }
}

/** Local bb projects with a GitHub remote, with their checked-out branch. */
export async function listLocalProjects(bb: BbPluginApi, projects: ProjectStore): Promise<LocalProject[]> {
  const [rows, hostId] = await Promise.all([bbProjects(bb), primaryHostId(bb)]);
  const candidates = rows
    .map((row) => ({ row, repo: githubRepo(row.gitRemoteUrl) }))
    .filter((entry): entry is { row: BbProjectRow; repo: string } => entry.repo !== null);
  return Promise.all(candidates.map(({ row, repo }) => inspect(row, repo, localSource(row, hostId)?.path ?? null, projects)));
}

export async function findLocalProject(bb: BbPluginApi, projects: ProjectStore, bbProjectId: string): Promise<LocalProject> {
  const rows = await bbProjects(bb);
  const row = rows.find((entry) => entry.id === bbProjectId);
  const repo = githubRepo(row?.gitRemoteUrl ?? null);
  if (row === undefined || repo === null) throw new Error(`bb project ${bbProjectId} has no GitHub remote.`);
  return inspect(row, repo, localSource(row, await primaryHostId(bb))?.path ?? null, projects);
}

/** Why this branch must not be pushed from the dialog, or null when it's fine. */
export function pushRefusal(local: LocalProject, expectedBranch: string, protect: readonly string[]): string | null {
  if (local.path === null || local.branch === null) return local.problem ?? "No local branch to push.";
  if (local.branch !== expectedBranch) {
    return `The checkout is on ${local.branch} now, not ${expectedBranch}; reopen the dialog.`;
  }
  if (protect.includes(local.branch)) {
    return `${local.branch} is a base branch. Put these commits on a feature branch, or push ${local.branch} yourself.`;
  }
  return null;
}

/** Push exactly the branch the user saw (sets upstream) so workers can clone it. */
export async function pushLocalBranch(
  bb: BbPluginApi,
  projects: ProjectStore,
  bbProjectId: string,
  expectedBranch: string,
  /** main, master and the extra protected branches from the settings. */
  always?: readonly string[],
): Promise<LocalProject> {
  const local = await findLocalProject(bb, projects, bbProjectId);
  const match = local.matchesProjectId ? projects.get(local.matchesProjectId) : null;
  const refusal = pushRefusal(local, expectedBranch, protectedBranches(match, [], always));
  if (refusal !== null) throw new Error(refusal);
  const remote = await remoteFor(local.path!, local.repo);
  if (remote === null) throw new Error(`No git remote points at github.com/${local.repo}.`);
  await git(local.path!, ["push", "-u", remote, `refs/heads/${local.branch}:refs/heads/${local.branch}`], 120_000);
  return findLocalProject(bb, projects, bbProjectId);
}

/** A local project as the orchestrator's project: its branch is the base. */
export function localToOrchestratorProject(local: LocalProject, projects: ProjectStore): OrchestratorProject {
  if (local.branch === null) throw new Error(local.problem ?? "Couldn't read the local branch.");
  const match = local.matchesProjectId ? projects.get(local.matchesProjectId) : null;
  // Keep the configured project's other repos, with this branch as the main repo's base.
  const repos = match
    ? match.repos.map((entry, index) => (index === 0 ? { repo: local.repo, baseBranch: local.branch! } : entry))
    : [{ repo: local.repo, baseBranch: local.branch }];
  return {
    id: `local:${local.bbProjectId}`,
    name: `${local.name} (${local.branch})`,
    repos,
    environment: match?.environment ?? null,
    snapshot: match?.snapshot ?? null,
    protocolPath: match?.protocolPath ?? null,
    // Your own local checkout: trusted like a project, unless its project says otherwise.
    workerMode: match?.workerMode ?? "chat",
    delivery: match?.delivery ?? "pr",
    protectedBranches: match?.protectedBranches ?? [],
    instructions: match?.instructions ?? "",
    source: "local",
    bbProjectId: local.bbProjectId,
  };
}
