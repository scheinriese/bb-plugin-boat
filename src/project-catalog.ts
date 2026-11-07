// Picker facts only. Never fetches Git refs, modifies a checkout, or returns paths/secrets.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ProjectCatalogDto } from "../contract-projects.ts";
import type { BoatApi } from "./boat-api.ts";
import { normalizeRepo } from "./boat-api.ts";

interface NativeProject { id: string; name: string; gitRemoteUrl?: string | null; sources?: { hostId: string; path: string; isDefault?: boolean; type?: string }[] }
export async function nativeProjectRows(bb: Pick<BbPluginApi, "sdk">): Promise<NativeProject[]> {
  const raw: unknown = await bb.sdk.projects.list();
  const rows = Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? (raw as { projects?: unknown }).projects : []);
  return (Array.isArray(rows) ? rows : []).filter((row): row is NativeProject => !!row && typeof row === "object" && typeof row.id === "string" && typeof row.name === "string").slice(0, 200);
}
function repoOf(value: string | null | undefined): string | null { try { return value ? normalizeRepo(value) : null; } catch { return null; } }
export async function validateLocalProjectLink(bb: Pick<BbPluginApi, "sdk">, id: string | null | undefined, repo: string): Promise<void> {
  if (!id) return;
  const row = (await nativeProjectRows(bb)).find(row => row.id === id);
  if (!row || repoOf(row.gitRemoteUrl)?.toLowerCase() !== normalizeRepo(repo).toLowerCase()) throw new Error("The local bb project no longer matches this project's main repository. Choose the matching project again or turn off the local project link.");
}
function run(file: string, args: string[], options: { cwd?: string; signal: AbortSignal; timeout?: number }): Promise<string> {
  return new Promise((resolve, reject) => execFile(file, args, { cwd: options.cwd, signal: options.signal, timeout: options.timeout ?? 4000, maxBuffer: 96 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
}
function ghBinary(): string { return process.env.BOAT_PLUGIN_GH || ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"].find(existsSync) || "gh"; }
export async function repoMetadata(repo: string, signal: AbortSignal): Promise<{ language: string | null; updatedAt: string | null; baseBranch: string | null }> {
  const raw: unknown = JSON.parse(await run(ghBinary(), ["api", `repos/${normalizeRepo(repo)}`], { signal }));
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return { language: typeof record.language === "string" ? record.language.slice(0, 60) : null, updatedAt: typeof record.updated_at === "string" && Number.isFinite(Date.parse(record.updated_at)) ? record.updated_at : null, baseBranch: typeof record.default_branch === "string" ? record.default_branch.slice(0, 200) : null };
}
export async function readProjectCatalog(bb: Pick<BbPluginApi, "sdk">, boat: Pick<BoatApi, "defaultEnvironment" | "environments" | "environmentInfo">, metadata = repoMetadata): Promise<ProjectCatalogDto> {
  const signal = AbortSignal.timeout(15_000);
  const [rows, config, names] = await Promise.all([nativeProjectRows(bb).catch(() => []), bb.sdk.system.config().catch(() => null), boat.environments(signal).catch(() => [])]);
  const repos = new Map<string, ProjectCatalogDto["repos"][number]>(); let cursor = 0; let failed = false;
  await Promise.all(Array.from({ length: 2 }, async () => { while (cursor < Math.min(names.length, 8)) { const name = names[cursor++]!; try { const env = await boat.environmentInfo(name, signal); for (const entry of env.repos.slice(0, 200)) { const repo = repoOf(entry.repo); if (repo && !repos.has(repo.toLowerCase()) && repos.size < 200) repos.set(repo.toLowerCase(), { repo, baseBranch: entry.baseBranch, language: null, updatedAt: null }); } } catch { failed = true; } } }));
  const entries = [...repos.values()]; cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => { while (cursor < Math.min(entries.length, 40)) { const entry = entries[cursor++]!; const extra = await metadata(entry.repo, signal).catch(() => null); if (extra) Object.assign(entry, extra, { baseBranch: entry.baseBranch ?? extra.baseBranch }); } }));
  const hostId = config && "primaryHostId" in config ? config.primaryHostId : null;
  const local: ProjectCatalogDto["local"] = [];
  for (const row of rows.slice(0, 100)) {
    const repo = repoOf(row.gitRemoteUrl); if (!repo) continue;
    const source = row.sources?.find(source => source.hostId === hostId && source.type !== "remote" && source.isDefault) ?? row.sources?.find(source => source.hostId === hostId && source.type !== "remote");
    const branch = source?.path ? await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: source.path, signal, timeout: 1000 }).catch(() => null) : null;
    local.push({ id: row.id, name: row.name, repo, branch: branch?.slice(0, 200) ?? null });
  }
  return { repos: entries, local, scope: "configured-boat-repos", truncated: names.length > 8 || repos.size >= 200 || rows.length > 100 || entries.length > 40, error: failed || names.length === 0 ? "Some configured Boat repositories could not be read. You can enter a repository by name." : null };
}
