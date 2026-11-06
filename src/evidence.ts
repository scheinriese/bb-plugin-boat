// Workers' screenshots and recordings outlive their sandbox: every task
// sandbox gets the `evidence-upload` command, which puts files in a private
// bucket and prints presigned links for the report. The uploader is the one
// bundled with the plugin (assets/evidence-upload.mjs, for any S3-compatible
// bucket) or a script of the user's own from GitHub (fetched on the bb
// server's machine with its `gh` login). Its keys live in the boat
// environment and never pass through the plugin.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoFileReader } from "./github.ts";

export const EVIDENCE_LIB = "/usr/local/lib/evidence-upload.mjs";
export const EVIDENCE_BIN = "/usr/local/bin/evidence-upload";
/** Off until the user picks an uploader. */
export const DEFAULT_EVIDENCE_UPLOADER = "";
/** The setting value for the uploader that ships with the plugin. */
export const BUILTIN_UPLOADER = "builtin";
/** Where the bundled uploader sits, relative to the plugin's folder. */
export const BUNDLED_UPLOADER_PATH = "assets/evidence-upload.mjs";

/**
 * The bundled uploader's settings, by name (the install check reports which
 * are set; values never leave the sandbox).
 */
export const BUILTIN_CONFIG_NAMES = [
  "EVIDENCE_BUCKET",
  "EVIDENCE_ACCESS_KEY_ID",
  "EVIDENCE_SECRET_ACCESS_KEY",
  "EVIDENCE_R2_ACCESS_KEY_ID",
  "EVIDENCE_R2_SECRET_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "EVIDENCE_ENDPOINT",
  "CLOUDFLARE_ACCOUNT_ID",
  "EVIDENCE_REGION",
  "EVIDENCE_LINK_DAYS",
] as const;
/** Key pairs in the uploader's order: the first pair with either name set is used. */
const KEY_PAIRS = [
  ["EVIDENCE_ACCESS_KEY_ID", "EVIDENCE_SECRET_ACCESS_KEY"],
  ["EVIDENCE_R2_ACCESS_KEY_ID", "EVIDENCE_R2_SECRET_ACCESS_KEY"],
  ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
] as const;

/** The variables the bundled uploader still needs, given the names that are set (same rules as the uploader). */
export function missingBuiltinConfig(present: readonly string[]): string[] {
  const set = new Set(present);
  const pair = KEY_PAIRS.find(([id, secret]) => set.has(id) || set.has(secret)) ?? KEY_PAIRS[0];
  return ["EVIDENCE_BUCKET", ...pair].filter((name) => !set.has(name));
}

const MAX_SCRIPT_BYTES = 256 * 1024;
const CACHE_MS = 10 * 60_000;

export type EvidenceSourceRef =
  | { kind: "builtin" }
  /** A script on GitHub; ref null: the repo's default branch. */
  | { kind: "github"; repo: string; path: string; ref: string | null };

/** "builtin", or "owner/repo:path/to/file.mjs[@ref]"; empty turns the uploader off. */
export function parseEvidenceSource(text: string): EvidenceSourceRef | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (trimmed.toLowerCase() === BUILTIN_UPLOADER) return { kind: "builtin" };
  const match = trimmed.match(/^([\w.-]+\/[\w.-]+):([^@\s]+)(?:@(\S+))?$/);
  if (match === null) throw new Error(`"${trimmed}" isn't builtin or owner/repo:path/to/file.mjs (optionally @commit)`);
  return { kind: "github", repo: match[1]!, path: match[2]!, ref: match[3] ?? null };
}

/** Why the setting's value can't be used (null: it can). */
export function evidenceSourceProblem(text: string): string | null {
  try {
    parseEvidenceSource(text);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** "the built-in uploader" or "acme/tools:scripts/up.mjs@abc123", for the task history. */
export function describeEvidenceSource(source: EvidenceSourceRef): string {
  return source.kind === "builtin" ? "the built-in uploader" : `${source.repo}:${source.path}${source.ref ? `@${source.ref}` : ""}`;
}

/**
 * The bundled uploader's file. Path installs run the plugin's TypeScript
 * (this file is src/evidence.ts) and git installs run dist/server.js: both
 * sit one folder below the plugin's, where assets/ is. Looks a few levels up
 * to be safe.
 */
export function bundledUploaderPath(from: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(from));
  for (let level = 0; level < 4; level += 1) {
    const candidate = join(dir, BUNDLED_UPLOADER_PATH);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`the built-in uploader (${BUNDLED_UPLOADER_PATH}) is missing from the plugin's folder`);
}

export function readBundledUploader(): string {
  return readFileSync(bundledUploaderPath(), "utf8");
}

export interface EvidenceSource {
  /** The uploader's source; GitHub scripts are cached, with the last good copy if GitHub can't be reached. */
  script(source: EvidenceSourceRef, signal?: AbortSignal): Promise<string>;
}

export function createEvidenceSource(
  read: RepoFileReader,
  cacheMs = CACHE_MS,
  /** Told when GitHub can't be reached and an older copy is installed instead. */
  onStale?: (error: unknown, fetchedAt: number) => void,
  /** The bundled uploader's text (tests replace the file read). */
  readBuiltin: () => string = readBundledUploader,
): EvidenceSource {
  const cache = new Map<string, { at: number; text: string }>();
  return {
    async script(source, signal) {
      if (source.kind === "builtin") {
        const text = readBuiltin();
        assertUploader(text);
        return text;
      }
      const key = `${source.repo}:${source.path}@${source.ref ?? ""}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < cacheMs) return hit.text;
      try {
        const text = await read(source.repo, source.path, source.ref, signal);
        assertUploader(text);
        cache.set(key, { at: Date.now(), text });
        return text;
      } catch (error) {
        if (hit) {
          onStale?.(error, hit.at);
          return hit.text;
        }
        throw error;
      }
    },
  };
}

function assertUploader(text: string): void {
  if (text.trim() === "") throw new Error("the uploader file is empty");
  if (Buffer.byteLength(text) > MAX_SCRIPT_BYTES) throw new Error(`the uploader is larger than ${MAX_SCRIPT_BYTES / 1024} KiB`);
  if (text.includes("\u0000")) throw new Error("the uploader isn't a text file");
}

/**
 * Install the uploader (sudo works in boat sandboxes) and report, by name
 * only, which of `checkNames` the sandbox has. Never prints a value.
 * Custom scripts are checked for nothing: their variables are their own.
 */
export function evidenceInstallScript(script: string, checkNames: readonly string[] = []): string {
  const encoded = Buffer.from(script, "utf8").toString("base64").replace(/.{76}/g, "$&\n");
  const names = checkNames.filter((name) => /^[A-Z_][A-Z0-9_]*$/.test(name));
  return `set -euo pipefail
TMP=$(mktemp)
trap 'rm -f "$TMP" "$TMP.wrapper"' EXIT
base64 -d > "$TMP" <<'BOAT_EVIDENCE_EOF'
${encoded}
BOAT_EVIDENCE_EOF
printf '%s\\n' '#!/bin/sh' 'exec node ${EVIDENCE_LIB} "$@"' > "$TMP.wrapper"
sudo mkdir -p /usr/local/lib /usr/local/bin
sudo install -m 0644 "$TMP" ${EVIDENCE_LIB}
sudo install -m 0755 "$TMP.wrapper" ${EVIDENCE_BIN}
PRESENT=""
for NAME in ${names.join(" ")}; do
  if [ -n "\${!NAME:-}" ]; then PRESENT="$PRESENT $NAME"; fi
done
echo "BOAT_EVIDENCE node=$(node -v 2>/dev/null || echo none) present=\${PRESENT# }"
`;
}

export interface EvidenceInstall {
  /** Node's version in the sandbox ("v22.11.0"), or null without node. */
  node: string | null;
  /** Names of the checked variables this sandbox has. */
  present: string[];
}

export function parseInstallResult(stdout: string, checkNames: readonly string[] = BUILTIN_CONFIG_NAMES): EvidenceInstall | null {
  const match = stdout.match(/BOAT_EVIDENCE node=(\S+) present=([^\n]*)/);
  if (match === null) return null;
  const known = new Set<string>(checkNames);
  return {
    node: match[1] === "none" ? null : (match[1] ?? null),
    present: (match[2] ?? "").split(/\s+/).filter((name) => known.has(name)),
  };
}

/** One line for the task history (names only). */
export function installSummary(result: EvidenceInstall, source: EvidenceSourceRef = { kind: "builtin" }): string {
  const major = Number(result.node?.match(/^v(\d+)/)?.[1] ?? 0);
  const missing = source.kind === "builtin" ? missingBuiltinConfig(result.present) : [];
  const problems = [
    result.node === null ? "node isn't installed" : major < 20 ? `node is ${result.node} (needs 20+)` : null,
    missing.length > 0 ? `missing ${missing.join(", ")} in this sandbox's environment` : null,
  ].filter(Boolean);
  if (problems.length > 0) return `Installed evidence-upload, but ${problems.join(" and ")}: uploads will fail`;
  if (source.kind === "github") return `Installed evidence-upload from ${describeEvidenceSource(source)} (its settings aren't checked)`;
  const endpoint = result.present.includes("EVIDENCE_ENDPOINT") || result.present.includes("CLOUDFLARE_ACCOUNT_ID") ? "" : "; no EVIDENCE_ENDPOINT or CLOUDFLARE_ACCOUNT_ID, so AWS S3";
  return `Installed evidence-upload (keys present: ${result.present.join(", ")}${endpoint})`;
}

// ---------------------------------------------------------------- reports

/** Any https URL (stops at whitespace, quotes, brackets and markdown's closing parenthesis). */
const URL_PATTERN = /https:\/\/[^\s<>"'`)\]]+/g;
/** A presigned S3-style link, as uploaders print (R2, AWS S3, MinIO, …). */
const PRESIGNED = /[?&]X-Amz-(?:Signature|Credential)=/i;
/** The report block's evidence line; group 1 is its value. */
const EVIDENCE_LINE = /^[ \t]*EVIDENCE:[ \t]*([^\n]*)$/gim;
/** A report that talks about visual evidence. */
const MENTIONS_EVIDENCE =
  /screen ?shots?|screen[- ]?recordings?|screencasts?|\b(?:videos?|recordings?) (?:of|showing)\b|\.(?:png|jpe?g|webp|gif|mp4|mov|webm)\b/i;

const NONE_VALUE = /^(?:none|n\/a|na|no|nothing)\b|^-+$/i;
const FAILED_VALUE = /fail|missing|error|not found|couldn'?t|could not|unavailable|no keys?|denied/i;

const trimValue = (value: string) => value.replace(/^["'`<]+|["'`>.]+$/g, "").trim();

/**
 * What an EVIDENCE: line says in words, its own links left out ("upload
 * failed: PUT https://… returned 403", "none (the PR is https://…)").
 * A line with a presigned link says links, so null.
 */
function lineSays(value: string): { kind: "failed"; detail: string } | { kind: "none" } | null {
  if ([...value.matchAll(URL_PATTERN)].some((match) => PRESIGNED.test(match[0]))) return null;
  const words = trimValue(value.replace(URL_PATTERN, " "));
  if (FAILED_VALUE.test(words)) return { kind: "failed", detail: trimValue(value).slice(0, 200) };
  if (NONE_VALUE.test(words)) return { kind: "none" };
  return null;
}

/**
 * Links to uploaded evidence, in order: presigned links anywhere in the text,
 * and any https link on the report's EVIDENCE: line. None when that line says
 * there's no evidence; a line that says the upload failed adds no links.
 */
export function evidenceLinks(text: string | null): string[] {
  const source = text ?? "";
  const lines = [...source.matchAll(EVIDENCE_LINE)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    says: lineSays(match[1] ?? ""),
  }));
  if (lines[0]?.says?.kind === "none") return [];
  const links: string[] = [];
  for (const match of source.matchAll(URL_PATTERN)) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    const line = lines.find(({ start, end }) => match.index >= start && match.index < end);
    if (PRESIGNED.test(url) || (line !== undefined && line.says === null)) links.push(url);
  }
  return [...new Set(links)];
}

export type EvidenceStatus =
  | { kind: "links"; links: string[] }
  /** The worker says it made nothing visual. */
  | { kind: "none" }
  /** The worker says the upload failed (or the keys were missing). */
  | { kind: "failed"; detail: string }
  /** The report talks about screenshots or recordings but has no links. */
  | { kind: "missing" }
  | { kind: "unspecified" };

/** What a worker's message says about its visual evidence. The EVIDENCE: line's words come first. */
export function evidenceStatus(text: string | null): EvidenceStatus {
  if (text === null || text.trim() === "") return { kind: "unspecified" };
  const line = [...text.matchAll(EVIDENCE_LINE)][0]?.[1]?.trim() ?? "";
  const says = line === "" ? null : lineSays(line);
  if (says !== null) return says;
  const links = evidenceLinks(text);
  if (links.length > 0) return { kind: "links", links };
  return MENTIONS_EVIDENCE.test(text) ? { kind: "missing" } : { kind: "unspecified" };
}

/** The report mentions screenshots or recordings but carries no upload links. */
export function evidenceWithoutLinks(text: string | null): boolean {
  return evidenceStatus(text).kind === "missing";
}

/** Whether a task's install event says uploads can work in its sandbox. */
export function uploaderWorks(installEvent: string | null): boolean {
  return installEvent !== null && /^Installed evidence-upload\b/.test(installEvent) && !/uploads will fail/.test(installEvent);
}
