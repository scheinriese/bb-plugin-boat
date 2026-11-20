// Instabox's setup checks (`bb boat doctor`, the provider's state on the
// page, its bb machines' availability): turned on, the CLI, a key stored,
// the account (signed in by the key, activated), and room for a machine.
// Read-only and cached a minute; nothing here creates a machine, and the key
// is never shown, only whether one is stored.
import type { CheckState, SetupFix } from "../boat/setup.ts";
import { ProviderError } from "../types.ts";
import { TaskError } from "../../service.ts";
import type { InstaboxCli } from "./cli.ts";
import { toCapacity } from "./parse.ts";
import { ENABLE_HINT, INSTALL_COMMAND, KEY_HINT } from "./words.ts";

export type InstaboxCheckId = "enabled" | "cli" | "key" | "account" | "capacity";

export interface InstaboxCheck {
  id: InstaboxCheckId;
  label: string;
  state: CheckState;
  required: boolean;
  detail: string;
  fix?: SetupFix;
}

export interface InstaboxSetupStatus {
  /** Turned on in the settings. */
  turnedOn: boolean;
  /** Every required check passes. */
  ok: boolean;
  checkedAt: string;
  summary: string;
  checks: InstaboxCheck[];
}

export interface InstaboxSetupDeps {
  cli: Pick<InstaboxCli, "binary" | "json">;
  turnedOn(): Promise<boolean>;
  keyPresent(): boolean;
  now?: () => number;
}

const CACHE_MS = 60_000;

function explained(error: unknown): { message: string; hint: string | null; code: string } {
  if (error instanceof ProviderError) {
    const { message, hint, code } = error.explain();
    return { message, hint, code };
  }
  return { message: error instanceof Error ? error.message : String(error), hint: null, code: "failed" };
}

export function createInstaboxSetup(deps: InstaboxSetupDeps) {
  const now = deps.now ?? Date.now;
  let cached: { at: number; status: Promise<InstaboxSetupStatus> } | null = null;

  async function read(signal?: AbortSignal): Promise<InstaboxSetupStatus> {
    const checks: InstaboxCheck[] = [];
    const turnedOn = await deps.turnedOn();
    checks.push({
      id: "enabled",
      label: "Instabox",
      state: turnedOn ? "ok" : "optional",
      required: false,
      detail: turnedOn ? "turned on: projects can run on Instabox" : "off: every project runs on boat.dev",
      ...(turnedOn ? {} : { fix: { text: ENABLE_HINT, command: "bb boat config set instaboxEnabled true" } }),
    });
    if (!turnedOn) return finish(false, checks);
    let cliFound = false;
    try {
      const binary = await deps.cli.binary();
      cliFound = true;
      checks.push({ id: "cli", label: "instabox CLI", state: "ok", required: true, detail: binary });
    } catch (error) {
      checks.push({ id: "cli", label: "instabox CLI", state: "missing", required: true, detail: "not found", fix: { text: explained(error).hint ?? "Install the instabox CLI.", command: INSTALL_COMMAND } });
    }
    const keyPresent = deps.keyPresent();
    checks.push({
      id: "key",
      label: "Instabox API key",
      state: keyPresent ? "ok" : "missing",
      required: true,
      detail: keyPresent ? "stored in bb's secret settings" : "none stored",
      ...(keyPresent ? {} : { fix: { text: KEY_HINT } }),
    });
    if (!cliFound || !keyPresent) return finish(true, checks);
    try {
      const me = await deps.cli.json(["whoami", "--json"], { signal, timeoutMs: 30_000 });
      const org = (me.org ?? null) as Record<string, unknown> | null;
      const plan = typeof org?.tier === "string" ? org.tier : typeof me.plan === "string" ? me.plan : null;
      const name = typeof org?.name === "string" ? org.name : null;
      checks.push({ id: "account", label: "Instabox account", state: "ok", required: true, detail: [name, plan ? `${plan} plan` : null].filter(Boolean).join(", ") || "the key works" });
    } catch (error) {
      const { message, hint, code } = explained(error);
      const down = code === "host_unavailable" || code === "instabox_timeout";
      checks.push({ id: "account", label: "Instabox account", state: down ? "unknown" : "missing", required: true, detail: message, ...(hint ? { fix: { text: hint } } : {}) });
      return finish(true, checks);
    }
    try {
      const capacity = toCapacity(await deps.cli.json(["usage", "--json"], { signal, timeoutMs: 30_000 }));
      checks.push({
        id: "capacity",
        label: "Room for a machine",
        state: capacity.canStart ? "ok" : "warning",
        required: false,
        detail: capacity.canStart ? `${capacity.activeSandboxes} machine${capacity.activeSandboxes === 1 ? "" : "s"}, ${capacity.summary ?? "within the plan"}` : (capacity.blockedReason ?? "the plan's machine limit is reached"),
      });
    } catch (error) {
      checks.push({ id: "capacity", label: "Room for a machine", state: "unknown", required: false, detail: explained(error).message });
    }
    return finish(true, checks);
  }

  function finish(turnedOn: boolean, checks: InstaboxCheck[]): InstaboxSetupStatus {
    const failing = checks.filter((check) => check.required && check.state !== "ok");
    const ok = turnedOn && failing.length === 0;
    return {
      turnedOn,
      ok,
      checkedAt: new Date(now()).toISOString(),
      summary: !turnedOn ? "Instabox: off." : ok ? "Instabox: ready." : `Instabox: ${failing.map((check) => `${check.label.toLowerCase()} ${check.state === "unknown" ? "can't be checked" : "missing"}`).join(", ")}.`,
      checks,
    };
  }

  return {
    /** The checks (cached a minute; force: read now). */
    status(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<InstaboxSetupStatus> {
      if (!options.force && cached !== null && now() - cached.at < CACHE_MS) return cached.status;
      const status = read(options.signal);
      cached = { at: now(), status };
      status.catch(() => {
        if (cached?.status === status) cached = null;
      });
      return status;
    },
    /** The newest reading without waiting (null: none yet). */
    peek(): Promise<InstaboxSetupStatus> | null {
      return cached?.status ?? null;
    },
  };
}

export type InstaboxSetup = ReturnType<typeof createInstaboxSetup>;

/** The checks in `bb boat doctor`'s words. */
export function instaboxDoctorText(status: InstaboxSetupStatus): string {
  const icon: Record<CheckState, string> = { ok: "✓", missing: "✗", warning: "!", unknown: "?", optional: "–" };
  const lines = [status.summary];
  for (const check of status.checks) {
    lines.push(`${icon[check.state]} ${check.label}: ${check.detail}`);
    if (check.fix && check.state !== "ok") lines.push(`    ${check.fix.text}${check.fix.command ? `\n    $ ${check.fix.command}` : ""}`);
  }
  return lines.join("\n");
}

/**
 * Before work starts on Instabox: a setup_required TaskError with the fix
 * when a required check fails (the CLI, the key, the account). An account
 * that can't be checked right now (Instabox down) doesn't block: the start
 * itself says what happened, and nothing is marked failed for it.
 */
export async function instaboxPreflight(setup: Pick<InstaboxSetup, "status">, signal?: AbortSignal): Promise<void> {
  let status = await setup.status({ signal });
  const blocking = (reading: InstaboxSetupStatus) => reading.checks.find((check) => check.required && check.state === "missing") ?? null;
  // Read again before refusing: the owner may have just fixed it.
  if (blocking(status) !== null) status = await setup.status({ force: true, signal });
  const problem = !status.turnedOn ? { label: "Instabox", detail: "is off", fix: { text: ENABLE_HINT } } : blocking(status);
  if (problem === null) return;
  throw new TaskError(`Instabox isn't ready: ${problem.label} ${problem.detail}.`, "setup_required", `${problem.fix?.text ?? ""} Run \`bb boat doctor\` to see every check.`.trim());
}
