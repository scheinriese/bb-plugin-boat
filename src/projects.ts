// Projects: what an orchestrator works on. GitHub is the source of truth —
// sandboxes can't see local files, so every repo is cloned from GitHub.
import type Database from "better-sqlite3";
import { z } from "zod";
import { DEFAULT_PROTECTED_BRANCHES, MACHINE_TYPES, assertBranch, invalidBranchNames, normalizeRepo, parseBranchList, type MachineType } from "./boat-api.ts";

/** Longest project instructions (they go into every brief of the project's tasks). */
export const MAX_PROJECT_INSTRUCTIONS = 10_000;

export const projectRepoSchema = z.object({
  repo: z.string().trim().min(3),
  baseBranch: z.string().trim().min(1),
});

export const projectInputSchema = z.object({
  localBbProjectId: z.string().trim().min(1).max(200).nullable().optional(),
  /** Stable id (slug); generated from the name when empty. */
  id: z.string().trim().max(64).optional(),
  name: z.string().trim().min(1).max(80),
  repos: z.array(projectRepoSchema).min(1).max(8),
  environment: z.string().trim().max(80).nullable().optional(),
  snapshot: z.string().trim().max(120).nullable().optional(),
  protocolPath: z.string().trim().max(300).nullable().optional(),
  /** chat: workers are bb chats (a trusted repo); boat: boat conversations with no access to your bb. */
  workerMode: z.enum(["chat", "boat"]).optional(),
  /** pr: workers open draft pull requests; push: they only commit, and the plugin ships to the base branch once you approve. */
  delivery: z.enum(["pr", "push"]).optional(),
  /** Branches no task may push to, on top of the base branches: a list, or "release, develop". */
  protectedBranches: z.union([z.array(z.string().max(200)).max(50), z.string().max(2000)]).optional(),
  /** Added to the brief of every task of this project. */
  instructions: z.string().max(MAX_PROJECT_INSTRUCTIONS).optional(),
  /** Size of its new task sandboxes; null: the Default sandbox size setting; absent: unchanged. */
  machineType: z.enum(MACHINE_TYPES).nullable().optional(),
  /** null: configured reviewer; none: no automatic review. */
  reviewer: z.enum(["codex", "claude", "none"]).nullable().optional(),
});
export type ProjectInput = z.infer<typeof projectInputSchema>;

export interface ProjectRepo {
  /** owner/name */
  repo: string;
  baseBranch: string;
}

export interface BoatProject {
  localBbProjectId?: string | null;
  id: string;
  name: string;
  /** The first repo is the main one: branches, PRs and the protocol file live there. */
  repos: ProjectRepo[];
  /** boat environment for workers (`boat new --environment`); null = your default. */
  environment: string | null;
  /** Saved boat snapshot to start workers from (`boat new --from`). */
  snapshot: string | null;
  /** Repo-specific orchestrator rules, a path inside the main repo. */
  protocolPath: string | null;
  /** How workers run for this project's repos (chat = trusted: bb chats). */
  workerMode: "chat" | "boat";
  /** How work lands: draft PRs (pr), or pushed to the base branch once you approve a preview (push). */
  delivery: "pr" | "push";
  /** Branches no task may push to, on top of the base branches (and main, master and the extra ones from the settings). */
  protectedBranches: string[];
  /** Added to the brief of every task of this project ("" for none). */
  instructions: string;
  /** Size of new task sandboxes for this project (and their reviews); null: the Default sandbox size setting. */
  machineType: MachineType | null;
  reviewer?: "codex" | "claude" | "none" | null;
  createdAt: string;
  updatedAt: string;
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "project"
  );
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** Validate and normalize user input; throws with a readable message. */
export function normalizeProject(input: ProjectInput, existing?: BoatProject | null): BoatProject {
  const parsed = projectInputSchema.parse(input);
  const repos = parsed.repos.map((entry) => ({
    repo: normalizeRepo(entry.repo),
    baseBranch: assertBranch(entry.baseBranch, "base branch"),
  }));
  const seen = new Set<string>();
  for (const entry of repos) {
    if (seen.has(entry.repo.toLowerCase())) throw new Error(`${entry.repo} is listed twice.`);
    seen.add(entry.repo.toLowerCase());
  }
  const protocolPath = clean(parsed.protocolPath);
  if (protocolPath !== null && (protocolPath.startsWith("/") || protocolPath.split("/").includes(".."))) {
    throw new Error("The protocol file must be a relative path inside the main repo, like docs/agents/orchestrator.md.");
  }
  const environment = clean(parsed.environment);
  if (environment !== null && !/^[A-Za-z0-9._-]+$/.test(environment)) {
    throw new Error(`"${environment}" is not a boat environment name.`);
  }
  let protectedList = existing?.protectedBranches ?? [];
  if (parsed.protectedBranches !== undefined) {
    const text = Array.isArray(parsed.protectedBranches) ? parsed.protectedBranches.join(",") : parsed.protectedBranches;
    const invalid = invalidBranchNames(text);
    if (invalid.length > 0) {
      throw new Error(`${invalid.map((name) => `"${name}"`).join(", ")} ${invalid.length === 1 ? "isn't a branch name" : "aren't branch names"}. Use branch names separated by commas, like release, develop.`);
    }
    protectedList = parseBranchList(text);
  }
  const now = new Date().toISOString();
  return {
    localBbProjectId: parsed.localBbProjectId !== undefined ? parsed.localBbProjectId : (existing?.localBbProjectId ?? null),
    id: existing?.id ?? (clean(parsed.id) ? slugify(parsed.id!) : slugify(parsed.name)),
    name: parsed.name,
    repos,
    environment,
    snapshot: clean(parsed.snapshot),
    protocolPath,
    workerMode: parsed.workerMode ?? existing?.workerMode ?? "chat",
    delivery: parsed.delivery ?? existing?.delivery ?? "pr",
    protectedBranches: protectedList,
    instructions: parsed.instructions !== undefined ? parsed.instructions.trim() : (existing?.instructions ?? ""),
    machineType: parsed.machineType !== undefined ? parsed.machineType : (existing?.machineType ?? null),
    reviewer: parsed.reviewer !== undefined ? parsed.reviewer : (existing?.reviewer ?? null),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export { DEFAULT_PROTECTED_BRANCHES };

/** Branches protected in every sandbox: main, master and the "Extra protected branches" setting. */
export function alwaysProtectedBranches(extra: readonly string[] = []): string[] {
  return [...new Set([...DEFAULT_PROTECTED_BRANCHES, ...extra])];
}

/**
 * Branches that must never receive a task's push for this project: the
 * always-protected ones (`always`), its base branches, its own protected
 * branches and `extra`.
 */
export function protectedBranches(
  project: (Pick<BoatProject, "repos"> & { protectedBranches?: readonly string[] }) | null,
  extra: (string | null)[] = [],
  always: readonly string[] = DEFAULT_PROTECTED_BRANCHES,
): string[] {
  const set = new Set<string>(always);
  for (const entry of project?.repos ?? []) set.add(entry.baseBranch);
  for (const branch of project?.protectedBranches ?? []) set.add(branch);
  for (const branch of extra) if (branch) set.add(branch);
  return [...set];
}

type Row = Record<string, unknown>;

/** Projects saved before a field existed get its default. */
function withDefaults(project: BoatProject): BoatProject {
  return {
    ...project,
    localBbProjectId: typeof project.localBbProjectId === "string" && project.localBbProjectId.length <= 200 ? project.localBbProjectId : null,
    workerMode: project.workerMode === "boat" ? "boat" : "chat",
    delivery: project.delivery === "push" ? "push" : "pr",
    protectedBranches: Array.isArray(project.protectedBranches) ? project.protectedBranches.filter((name) => typeof name === "string") : [],
    instructions: typeof project.instructions === "string" ? project.instructions : "",
    machineType: (MACHINE_TYPES as readonly unknown[]).includes(project.machineType) ? project.machineType : null,
    reviewer: ["codex", "claude", "none"].includes(project.reviewer ?? "") ? project.reviewer : null,
  };
}

export class ProjectStore {
  private readonly db: () => Database.Database;

  constructor(db: () => Database.Database) {
    this.db = db;
  }

  list(): BoatProject[] {
    // Insertion order (edits keep their place).
    return (this.db().prepare(`SELECT data FROM projects ORDER BY rowid`).all() as Row[]).map((row) => withDefaults(JSON.parse(String(row.data))));
  }

  get(id: string): BoatProject | null {
    const row = this.db().prepare(`SELECT data FROM projects WHERE id = ?`).get(id) as Row | undefined;
    return row === undefined ? null : withDefaults(JSON.parse(String(row.data)));
  }

  /** Find by id or (case-insensitive) name. */
  find(ref: string): BoatProject | null {
    const byId = this.get(ref.trim());
    if (byId !== null) return byId;
    const lower = ref.trim().toLowerCase();
    return this.list().find((project) => project.name.toLowerCase() === lower || project.id === slugify(ref)) ?? null;
  }

  /** The project whose main repo is this repo, if any. */
  forRepo(repo: string): BoatProject | null {
    const lower = repo.toLowerCase();
    return this.list().find((project) => project.repos[0]?.repo.toLowerCase() === lower) ?? null;
  }

  save(input: ProjectInput): BoatProject {
    const existing = input.id ? this.get(input.id) : null;
    let project = normalizeProject(input, existing);
    if (existing === null) {
      // New project: keep its id unique.
      let id = project.id;
      for (let n = 2; this.get(id) !== null; n += 1) id = `${project.id}-${n}`;
      project = { ...project, id };
    }
    this.db()
      .prepare(
        `INSERT INTO projects (id, data, created_at, updated_at) VALUES (@id, @data, @created, @updated)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run({ id: project.id, data: JSON.stringify(project), created: project.createdAt, updated: project.updatedAt });
    return project;
  }

  delete(id: string): boolean {
    const result = this.db().prepare(`DELETE FROM projects WHERE id = ?`).run(id) as { changes: number | bigint };
    return Number(result.changes) > 0;
  }
}

/**
 * The project an orchestrator works on, as stored in its thread metadata:
 * a configured project, or a local bb project resolved to its GitHub repo.
 */
export interface OrchestratorProject {
  reviewer?: "codex" | "claude" | "none" | null;
  id: string;
  name: string;
  repos: ProjectRepo[];
  environment: string | null;
  snapshot: string | null;
  protocolPath: string | null;
  workerMode: "chat" | "boat";
  delivery: "pr" | "push";
  protectedBranches: string[];
  instructions: string;
  source: "boat" | "local";
  /** For local projects: the bb project it came from. */
  bbProjectId: string | null;
}

export function toOrchestratorProject(project: BoatProject): OrchestratorProject {
  return {
    id: project.id,
    name: project.name,
    repos: project.repos,
    environment: project.environment,
    snapshot: project.snapshot,
    protocolPath: project.protocolPath,
    workerMode: project.workerMode,
    delivery: project.delivery,
    protectedBranches: project.protectedBranches,
    instructions: project.instructions,
    reviewer: project.reviewer ?? null,
    source: "boat",
    bbProjectId: project.localBbProjectId ?? null,
  };
}

const orchestratorProjectSchema = z.object({
  reviewer: z.enum(["codex", "claude", "none"]).nullable().optional(),
  id: z.string().min(1),
  name: z.string().min(1),
  repos: z.array(projectRepoSchema).min(1),
  environment: z.string().nullable(),
  snapshot: z.string().nullable(),
  protocolPath: z.string().nullable(),
  // Older orchestrator metadata has no workerMode: its projects were trusted.
  workerMode: z.enum(["chat", "boat"]).default("chat"),
  delivery: z.enum(["pr", "push"]).default("pr"),
  // Older orchestrator metadata has neither.
  protectedBranches: z.array(z.string()).max(50).default([]),
  instructions: z.string().max(MAX_PROJECT_INSTRUCTIONS).default(""),
  source: z.enum(["boat", "local"]),
  bbProjectId: z.string().nullable(),
});

/** Read a project from untrusted thread metadata (any agent can write it). */
export function parseOrchestratorProject(value: unknown): OrchestratorProject | null {
  const parsed = orchestratorProjectSchema.safeParse(value);
  if (!parsed.success) return null;
  try {
    return {
      ...parsed.data,
      repos: parsed.data.repos.map((entry) => ({
        repo: normalizeRepo(entry.repo),
        baseBranch: assertBranch(entry.baseBranch, "base branch"),
      })),
      protectedBranches: parseBranchList(parsed.data.protectedBranches.join(",")),
    };
  } catch {
    return null;
  }
}
