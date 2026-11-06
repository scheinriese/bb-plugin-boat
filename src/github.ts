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
