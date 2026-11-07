// Back up and restore: every setting (bb's list and the plugin's own), the
// projects, the model tiers and the custom orchestrator protocol in one JSON
// file (`bb boat config export|import`, Settings → Back up and restore).
// Never runtime state (tasks, threads, sandboxes, relay) and never secrets.
//
// Version 2 writes every setting by its current key. Version 1 files still
// import: workerMode + adhocWorkerMode become workers, pollIntervalSeconds is
// ignored, and settings that moved to the plugin's own storage go there.
import type { PluginSettingDescriptor, PluginSettingValue } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { normalizeProject, projectInputSchema, slugify, type BoatProject, type ProjectInput, type ProjectStore } from "./projects.ts";
import { MAX_PROTOCOL_CHARS, type ProtocolFile } from "./protocol.ts";
import {
  LEGACY_WORKER_SETTINGS,
  RELAY_GAP,
  REMOVED_SETTINGS,
  crossFieldProblems,
  runnersFor,
  settingProblem,
  workersFromLegacy,
  type PluginValues,
} from "./settings.ts";
import { tierMapSchema, type TierMap } from "./tiers.ts";

export { settingProblem };

export const CONFIG_FORMAT = "bb-plugin-boat-config";
export const CONFIG_VERSION = 2;
/** Versions this plugin reads. */
export const CONFIG_VERSIONS: readonly number[] = [1, 2];
/** Far above a real file (the protocol alone stops at 100,000 characters). */
export const MAX_CONFIG_CHARS = 500_000;

export interface BoatConfigFile {
  format: typeof CONFIG_FORMAT;
  version: typeof CONFIG_VERSION;
  exportedAt: string;
  /** Every setting, by key: bb's list, then the plugin's own. */
  settings: Record<string, PluginSettingValue>;
  /** Projects as stored (every field). */
  projects: BoatProject[];
  /** null: the built-in tiers. */
  modelTiers: TierMap | null;
  /** null: the built-in protocol. */
  protocol: { text: string } | null;
}

/** Every setting, wherever it lives (src/settings-store.ts). */
export interface SettingsAccess {
  descriptors: Record<string, PluginSettingDescriptor>;
  get(): Promise<Record<string, PluginSettingValue | undefined>>;
  /** Validates every value, then writes them all (or none). */
  set(values: Record<string, PluginSettingValue>): Promise<unknown>;
}

export interface ConfigDeps {
  settings: SettingsAccess;
  projects: Pick<ProjectStore, "list" | "get" | "save" | "delete">;
  protocol: { read(): ProtocolFile; save(text: string): unknown; reset(): unknown };
  modelTiers(): Promise<{ tiers: TierMap; custom: boolean }>;
  saveModelTiers(tiers: TierMap | null): Promise<void>;
  /** Why a project can't be removed now (open tasks, a live orchestrator); null: it can. */
  removalBlocker(projectId: string): Promise<string | null>;
}

/** A file that can't be imported; `problems` says why, one line each. */
export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.length === 1 ? problems[0]! : `This file can't be imported:\n${problems.map((line) => `- ${line}`).join("\n")}`);
    this.problems = problems;
  }
}

export async function exportConfig(deps: ConfigDeps, now = new Date()): Promise<BoatConfigFile> {
  const values = await deps.settings.get();
  const settings: Record<string, PluginSettingValue> = {};
  for (const [key, descriptor] of Object.entries(deps.settings.descriptors)) {
    if (descriptor.type === "string" && descriptor.secret) continue;
    const value = values[key];
    if (value !== undefined) settings[key] = value;
  }
  const tiers = await deps.modelTiers();
  const protocol = deps.protocol.read();
  return {
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    exportedAt: now.toISOString(),
    settings,
    projects: deps.projects.list(),
    modelTiers: tiers.custom ? tiers.tiers : null,
    protocol: protocol.custom ? { text: protocol.text } : null,
  };
}

/** "boat-config-2026-11-06.json" */
export function exportFileName(now = new Date()): string {
  return `boat-config-${now.toISOString().slice(0, 10)}.json`;
}

// ------------------------------------------------------------------ reading

const importedProjectSchema = projectInputSchema.extend({
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  // Checked per project (normalizeProject), so a size this version doesn't know is that project's problem, not the file's.
  machineType: z.unknown().optional(),
});
type ImportedProject = z.infer<typeof importedProjectSchema>;

const fileSchema = z.object({
  format: z.string(),
  version: z.number(),
  exportedAt: z.string().optional(),
  // Checked key by key against the settings this version has.
  settings: z.record(z.string(), z.unknown()).optional(),
  projects: z.array(importedProjectSchema).max(200).optional(),
  modelTiers: tierMapSchema.nullable().optional(),
  protocol: z
    .object({ text: z.string().max(MAX_PROTOCOL_CHARS, `The protocol is longer than ${MAX_PROTOCOL_CHARS.toLocaleString("en-US")} characters.`) })
    .nullable()
    .optional(),
});
type ParsedFile = z.infer<typeof fileSchema>;

function issueLines(error: z.ZodError): string[] {
  return error.issues.slice(0, 10).map((issue) => {
    const path = issue.path.map((part) => (typeof part === "number" ? `[${part}]` : `.${String(part)}`)).join("").replace(/^\./, "");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

/** Parse and check the file's shape; throws ConfigError with plain reasons. */
export function parseConfigText(text: string): ParsedFile {
  if (text.length > MAX_CONFIG_CHARS) throw new ConfigError([`The file is larger than ${MAX_CONFIG_CHARS.toLocaleString("en-US")} characters.`]);
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new ConfigError([`The file isn't valid JSON (${error instanceof Error ? error.message : String(error)}).`]);
  }
  const head = raw as { format?: unknown; version?: unknown } | null;
  if (head === null || typeof head !== "object" || Array.isArray(head) || head.format !== CONFIG_FORMAT) {
    throw new ConfigError([`This isn't a Boat backup: its "format" should be "${CONFIG_FORMAT}" (make one with \`bb boat config export\`).`]);
  }
  if (typeof head.version === "number" && head.version > CONFIG_VERSION) {
    throw new ConfigError([`This backup has format version ${head.version}, and this plugin reads versions up to ${CONFIG_VERSION}. Update the plugin first.`]);
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(issueLines(parsed.error));
  if (!CONFIG_VERSIONS.includes(parsed.data.version)) throw new ConfigError([`Unknown format version ${parsed.data.version}.`]);
  return parsed.data;
}

// ------------------------------------------------------------------ planning

export interface SettingChange {
  key: string;
  from: PluginSettingValue | null;
  to: PluginSettingValue;
}

export interface ProjectChange {
  id: string;
  name: string;
  /** Changed fields (updates only). */
  fields: string[];
}

export interface ImportPlan {
  /** Reasons the file can't be applied; nothing is written while there are any. */
  problems: string[];
  settings: {
    changed: SettingChange[];
    unchanged: number;
    /** Keys this version doesn't have: skipped. */
    unknown: string[];
    /** Settings the file doesn't mention: they keep their current values. */
    notInFile: { key: string; value: PluginSettingValue | null }[];
    /** What gets written (every known key in the file). */
    writes: Record<string, PluginSettingValue>;
    /** Older settings turned into today's ("workers from workerMode chat and adhocWorkerMode boat"). */
    mapped: string[];
    /** Settings that no longer exist: ignored. */
    ignored: string[];
  };
  projects: {
    /** In the file's order. */
    save: { input: ProjectInput & { id: string }; change: "added" | "updated" | "unchanged"; fields: string[] }[];
    removed: ProjectChange[];
    /** --replace-projects couldn't remove these. */
    blocked: (ProjectChange & { reason: string })[];
    /** Merging: projects the file doesn't have stay (only when the file has projects). */
    kept: ProjectChange[];
    inFile: boolean;
  };
  /** absent: the file has no tiers (they stay). */
  tiers: { change: "unchanged" | "custom" | "builtin" | "absent"; value: TierMap | null };
  protocol: { change: "unchanged" | "custom" | "builtin" | "absent"; text: string | null };
  replaceProjects: boolean;
}

const PROJECT_FIELDS = ["name", "repos", "environment", "snapshot", "protocolPath", "workerMode", "delivery", "protectedBranches", "instructions", "machineType", "reviewer"] as const;

/**
 * A file's settings by today's keys. Older files: workerMode and
 * adhocWorkerMode become workers (one missing: its current meaning is
 * used), and settings that no longer exist are ignored.
 */
export function currentSettingKeys(
  settings: Record<string, unknown>,
  current: Record<string, PluginSettingValue | undefined>,
): { settings: Record<string, unknown>; mapped: string[]; ignored: string[]; problems: string[] } {
  const result: Record<string, unknown> = { ...settings };
  const mapped: string[] = [];
  const ignored: string[] = [];
  const problems: string[] = [];
  for (const key of REMOVED_SETTINGS) {
    if (!Object.hasOwn(result, key)) continue;
    delete result[key];
    ignored.push(key);
  }
  const legacy = LEGACY_WORKER_SETTINGS.filter((key) => Object.hasOwn(result, key));
  if (legacy.length > 0) {
    const values = Object.fromEntries(legacy.map((key) => [key, result[key]])) as Record<string, unknown>;
    for (const key of legacy) delete result[key];
    if (Object.hasOwn(result, "workers")) {
      // A file with both: workers wins.
      ignored.push(...legacy);
    } else {
      const now = runnersFor(String(current.workers ?? "boat"));
      const bad = legacy.filter((key) => values[key] !== "chat" && values[key] !== "boat");
      for (const key of bad) problems.push(`Setting ${key} must be one of boat, chat.`);
      if (bad.length === 0) {
        const workerMode = (values.workerMode ?? now.workerMode) as "chat" | "boat";
        const adhocWorkerMode = (values.adhocWorkerMode ?? now.adhocWorkerMode) as "chat" | "boat";
        result.workers = workersFromLegacy(workerMode, adhocWorkerMode);
        mapped.push(`workers from workerMode ${JSON.stringify(workerMode)} and adhocWorkerMode ${JSON.stringify(adhocWorkerMode)}: ${JSON.stringify(result.workers)}`);
      }
    }
  }
  return { settings: result, mapped, ignored, problems };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The protocol text as ProtocolStore saves it. */
function storedProtocolText(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

/** What importing `text` would change. Reads only. */
export async function planImport(deps: ConfigDeps, text: string, options: { replaceProjects?: boolean } = {}): Promise<ImportPlan> {
  const file = parseConfigText(text);
  const problems: string[] = [];

  // Settings: known keys are checked and written; unknown ones are skipped.
  const current = await deps.settings.get();
  const descriptors = deps.settings.descriptors;
  const { settings: fileSettings, mapped, ignored, problems: mapProblems } = currentSettingKeys(file.settings ?? {}, current);
  problems.push(...mapProblems);
  const changed: SettingChange[] = [];
  const unknown: string[] = [];
  const writes: Record<string, PluginSettingValue> = {};
  let unchanged = 0;
  for (const [key, value] of Object.entries(fileSettings)) {
    const descriptor = Object.hasOwn(descriptors, key) ? descriptors[key] : undefined;
    if (descriptor === undefined || (descriptor.type === "string" && descriptor.secret)) {
      unknown.push(key);
      continue;
    }
    const problem = settingProblem(key, descriptor, value);
    if (problem !== null) {
      problems.push(`Setting ${problem}${problem.endsWith(".") ? "" : "."}`);
      continue;
    }
    const next = value as PluginSettingValue;
    writes[key] = next;
    if (sameValue(current[key], next)) unchanged += 1;
    else changed.push({ key, from: current[key] ?? null, to: next });
  }
  // Rules across settings, on the values as they would be after the import.
  // Version 1 had no such rule (the plugin lowered Switch back below quietly): do that here, and say so.
  if (problems.length === 0) {
    const after = { ...current, ...writes } as unknown as PluginValues;
    if (file.version === 1 && crossFieldProblems(after).length > 0) {
      const lowered = Math.max(0, after.relaySwitchAt - RELAY_GAP);
      mapped.push(`relaySwitchBackBelow lowered from ${after.relaySwitchBackBelow} to ${lowered}: it must be at least ${RELAY_GAP} below relaySwitchAt (${after.relaySwitchAt})`);
      const counted = Object.hasOwn(writes, "relaySwitchBackBelow");
      writes.relaySwitchBackBelow = lowered;
      const entry = changed.find((change) => change.key === "relaySwitchBackBelow");
      if (entry) entry.to = lowered;
      else if (!sameValue(current.relaySwitchBackBelow, lowered)) {
        changed.push({ key: "relaySwitchBackBelow", from: current.relaySwitchBackBelow ?? null, to: lowered });
        if (counted) unchanged -= 1;
      }
    }
    problems.push(...crossFieldProblems({ ...current, ...writes } as unknown as PluginValues).map((problem) => `Setting ${problem}`));
  }
  // In the settings' own order.
  const order = Object.keys(descriptors);
  changed.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  const notInFile = Object.entries(descriptors)
    .filter(([key, descriptor]) => !Object.hasOwn(fileSettings, key) && !Object.hasOwn(writes, key) && !(descriptor.type === "string" && descriptor.secret))
    .map(([key]) => ({ key, value: current[key] ?? null }));

  // Projects: added or updated by id; with --replace-projects, the rest go.
  const existing = deps.projects.list();
  const save: ImportPlan["projects"]["save"] = [];
  const seen = new Set<string>();
  for (const [index, entry] of (file.projects ?? []).entries()) {
    const id = slugify(entry.id?.trim() ? entry.id : entry.name);
    const label = `Project ${entry.name ? `"${entry.name}"` : `#${index + 1}`}`;
    if (seen.has(id)) {
      problems.push(`${label}: the file has two projects with the id "${id}".`);
      continue;
    }
    seen.add(id);
    const before = deps.projects.get(id);
    let normalized: BoatProject;
    try {
      normalized = normalizeProject({ ...entry, id } as ProjectInput, before);
    } catch (error) {
      const reason = error instanceof z.ZodError ? issueLines(error).join("; ") : error instanceof Error ? error.message : String(error);
      problems.push(`${label}: ${reason}`);
      continue;
    }
    const fields = before === null ? [] : PROJECT_FIELDS.filter((field) => !sameValue(before[field], normalized[field]));
    save.push({ input: { ...entry, id } as ProjectInput & { id: string }, change: before === null ? "added" : fields.length > 0 ? "updated" : "unchanged", fields });
  }
  const removed: ProjectChange[] = [];
  const blocked: (ProjectChange & { reason: string })[] = [];
  const kept: ProjectChange[] = [];
  const inFile = file.projects !== undefined;
  for (const project of inFile ? existing : []) {
    if (seen.has(project.id)) continue;
    const entry = { id: project.id, name: project.name, fields: [] };
    if (!options.replaceProjects) {
      kept.push(entry);
      continue;
    }
    const reason = await deps.removalBlocker(project.id);
    if (reason === null) removed.push(entry);
    else blocked.push({ ...entry, reason });
  }

  // Tiers: null means the built-in ones.
  const tiersNow = await deps.modelTiers();
  let tiers: ImportPlan["tiers"];
  if (file.modelTiers === undefined) tiers = { change: "absent", value: null };
  else if (file.modelTiers === null) tiers = { change: tiersNow.custom ? "builtin" : "unchanged", value: null };
  else tiers = { change: tiersNow.custom && sameValue(tiersNow.tiers, file.modelTiers) ? "unchanged" : "custom", value: file.modelTiers };

  // Protocol: null (or empty text) means the built-in one.
  const protocolNow = deps.protocol.read();
  let protocol: ImportPlan["protocol"];
  if (file.protocol === undefined) protocol = { change: "absent", text: null };
  else if (file.protocol === null || file.protocol.text.trim() === "") protocol = { change: protocolNow.custom ? "builtin" : "unchanged", text: null };
  else {
    const next = storedProtocolText(file.protocol.text);
    protocol = { change: protocolNow.custom && protocolNow.text === next ? "unchanged" : "custom", text: next };
  }

  return {
    problems,
    settings: { changed, unchanged, unknown, notInFile, writes, mapped, ignored },
    projects: { save, removed, blocked, kept, inFile },
    tiers,
    protocol,
    replaceProjects: options.replaceProjects === true,
  };
}

/** How many things the import changes. */
export function changeCount(plan: ImportPlan): number {
  return (
    plan.settings.changed.length +
    plan.projects.save.filter((entry) => entry.change !== "unchanged").length +
    plan.projects.removed.length +
    (plan.tiers.change === "custom" || plan.tiers.change === "builtin" ? 1 : 0) +
    (plan.protocol.change === "custom" || plan.protocol.change === "builtin" ? 1 : 0)
  );
}

/** Write a plan made by planImport. Settings first: if they're refused, nothing else changes. */
export async function applyImport(deps: ConfigDeps, plan: ImportPlan): Promise<void> {
  if (plan.problems.length > 0) throw new ConfigError(plan.problems);
  if (Object.keys(plan.settings.writes).length > 0) await deps.settings.set(plan.settings.writes);
  for (const entry of plan.projects.save) {
    if (entry.change !== "unchanged") deps.projects.save(entry.input);
  }
  for (const project of plan.projects.removed) deps.projects.delete(project.id);
  if (plan.tiers.change === "custom") await deps.saveModelTiers(plan.tiers.value);
  if (plan.tiers.change === "builtin") await deps.saveModelTiers(null);
  if (plan.protocol.change === "custom") deps.protocol.save(plan.protocol.text!);
  if (plan.protocol.change === "builtin") deps.protocol.reset();
}

// ------------------------------------------------------------------ summary

export interface SummarySection {
  title: string;
  lines: string[];
}

function show(value: PluginSettingValue | null): string {
  if (value === null) return "(not set)";
  if (typeof value !== "string") return String(value);
  if (value === "") return "(empty)";
  const lines = value.split("\n");
  const first = lines[0]!.length > 60 ? `${lines[0]!.slice(0, 59)}…` : lines[0]!;
  return lines.length > 1 ? `${JSON.stringify(`${first}…`)} (${lines.length} lines)` : JSON.stringify(first);
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Most settings a summary names one by one; a file with only a few leaves out many. */
const NAMED_NOT_IN_FILE = 8;

/** "Not in the file, stays as it is: cloudOrchestratorFullAccess = true" */
function notInFileLine(entries: ImportPlan["settings"]["notInFile"]): string {
  const named = entries.slice(0, NAMED_NOT_IN_FILE).map((entry) => `${entry.key} = ${show(entry.value)}`);
  const rest = entries.length - named.length;
  return `Not in the file, ${entries.length === 1 ? "stays as it is" : "stay as they are"}: ${named.join(", ")}${rest > 0 ? ` and ${count(rest, "more setting")}` : ""}`;
}

/** What the import changes (or changed), in plain words. */
export function summarize(plan: ImportPlan): SummarySection[] {
  const { settings, projects } = plan;
  const settingLines = [
    ...settings.changed.map((change) => `${change.key}: ${show(change.from)} → ${show(change.to)}`),
    ...settings.mapped.map((line) => `From an older backup: ${line}`),
    ...(settings.ignored.length > 0 ? [`Ignored, no longer settings: ${settings.ignored.join(", ")}`] : []),
    ...(settings.unknown.length > 0 ? [`Skipped, not settings of this version: ${settings.unknown.join(", ")}`] : []),
    ...(settings.notInFile.length > 0 ? [notInFileLine(settings.notInFile)] : []),
  ];
  const projectCounts = [
    ["added", projects.save.filter((entry) => entry.change === "added").length],
    ["updated", projects.save.filter((entry) => entry.change === "updated").length],
    ["unchanged", projects.save.filter((entry) => entry.change === "unchanged").length],
    ["removed", projects.removed.length],
  ] as const;
  const projectLines = [
    ...projects.save.map((entry) =>
      entry.change === "added"
        ? `Add ${entry.input.id} (${entry.input.name}): ${entry.input.repos.map((repo) => `${repo.repo}@${repo.baseBranch}`).join(" + ")}`
        : entry.change === "updated"
          ? `Update ${entry.input.id} (${entry.input.name}): ${entry.fields.join(", ")}`
          : `Unchanged: ${entry.input.id}`,
    ),
    ...projects.removed.map((project) => `Remove ${project.id} (${project.name})`),
    ...projects.blocked.map((project) => `Keep ${project.id} (${project.name}): ${project.reason}, so it can't be removed`),
    ...(projects.kept.length > 0
      ? [
          `Not in the file, kept: ${projects.kept.map((project) => project.id).join(", ")} (replacing the projects removes them)`,
        ]
      : []),
  ];
  const tiers = {
    unchanged: "Unchanged",
    custom: "Use the model presets from the file",
    builtin: "Back to the built-in model presets (the file has none)",
    absent: "Not in the file: unchanged",
  }[plan.tiers.change];
  const protocol = {
    unchanged: "Unchanged",
    custom: `Use the protocol from the file (${(plan.protocol.text ?? "").length.toLocaleString("en-US")} characters)`,
    builtin: "Back to the built-in protocol (the file has none)",
    absent: "Not in the file: unchanged",
  }[plan.protocol.change];
  return [
    { title: `Settings: ${count(settings.changed.length, "change")}, ${settings.unchanged} unchanged`, lines: settingLines },
    {
      title: `Projects: ${projects.inFile ? projectCounts.map(([label, n]) => `${n} ${label}`).join(", ") : "not in the file"}`,
      lines: projectLines,
    },
    { title: `Model presets: ${tiers}`, lines: [] },
    { title: `Protocol: ${protocol}`, lines: [] },
  ];
}

/** The summary as text (CLI). */
export function summaryText(sections: SummarySection[]): string {
  return sections.map((section) => [section.title, ...section.lines.map((line) => `  ${line}`)].join("\n")).join("\n");
}
