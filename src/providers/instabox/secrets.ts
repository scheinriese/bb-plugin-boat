// Metadata only: never ask the CLI for Secret values or print its response.
import { PLUGIN_SETTINGS } from "../../settings.ts";
import { InstaboxError, rec, type InstaboxCli } from "./cli.ts";
import { GITHUB_LOGIN_HINT } from "./words.ts";

export function createInstaboxSecrets(cli: InstaboxCli, selection: () => Promise<string>, now = Date.now) {
  let cached: { at: number; value: Promise<{ present: boolean; proxy: boolean; hosts: boolean }> } | null = null;
  async function selected() {
    const value = (await selection()).trim();
    if (!PLUGIN_SETTINGS.instaboxSecrets.experimental_schema.safeParse(value).success) {
      throw new InstaboxError("Use all, none, or comma-separated Secret names for Instabox Secrets.", { code: "setup_required" });
    }
    return value;
  }
  async function metadata(signal?: AbortSignal) {
    if (cached && now() - cached.at < 60_000) return cached.value;
    const value = (async () => {
      const result = await cli.run(["secrets", "ls", "--json"], { signal, timeoutMs: 30_000 });
      const raw = Array.isArray(result.value) ? result.value : rec(result.value)?.items ?? rec(result.value)?.secrets;
      if (!Array.isArray(raw)) throw new InstaboxError("Instabox returned unreadable Secret metadata. Update the instabox CLI and try again.", { code: "instabox_bad_output" });
      const token = raw.map(rec).find(secret => secret?.name === "GH_TOKEN");
      const hosts = token?.hosts;
      return { present: Boolean(token), proxy: token?.delivery === "proxy", hosts: Array.isArray(hosts) && hosts.includes("github.com") && hosts.includes("api.github.com") && !hosts.includes("*") };
    })();
    cached = { at: now(), value };
    value.catch(() => { if (cached?.value === value) cached = null; });
    return value;
  }
  return {
    selected,
    async check(signal?: AbortSignal, onWarning?: (message: string) => void) {
      const choice = await selected();
      if (choice !== "all" && !choice.split(",").includes("GH_TOKEN")) {
        throw new InstaboxError(`${GITHUB_LOGIN_HINT} Include GH_TOKEN in Instabox Secrets (instaboxSecrets).`, { code: "setup_required" });
      }
      let token;
      try { token = await metadata(signal); }
      catch (error) {
        signal?.throwIfAborted();
        if (error instanceof InstaboxError && (error.retryable || error.code === "instabox_timeout" || error.status === 429 || error.status === 404 || (error.status === null && ["cli_error", "instabox_failed"].includes(error.code) && error.exitCode === 1) || (error.status !== null && error.status >= 500))) {
          onWarning?.("Instabox GitHub Secret metadata could not be checked temporarily; continuing with the machine's GitHub login check.");
          return;
        }
        // Do not include CLI output: even a misbehaving CLI must not leak credentials here.
        throw new InstaboxError("Instabox GitHub Secret metadata could not be checked. Check the API key's machines:read permission and update the instabox CLI, then try again.", { code: "setup_required" });
      }
      if (!token.present) throw new InstaboxError(GITHUB_LOGIN_HINT, { code: "setup_required" });
      if (!token.proxy || !token.hosts) throw new InstaboxError(`${GITHUB_LOGIN_HINT} GH_TOKEN must be a proxy Secret with both github.com and api.github.com as exact hosts; wildcard (*) hosts are not accepted.`, { code: "setup_required" });
    },
    async apply(machineId: string, signal?: AbortSignal) {
      const choice = await selected();
      await cli.run(["secrets", "select", machineId, "--secrets", choice, "--json"], { signal });
      await cli.run(["secrets", "push", machineId, "--json"], { signal });
    },
  };
}
