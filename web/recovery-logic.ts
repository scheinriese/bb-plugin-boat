import type { TaskDto } from "../contract.ts";
import { cardStatus } from "./cards-logic.ts";

export type SandboxPower = "checking" | "on" | "off" | "starting" | "stopping" | "removed" | "unavailable";

/** Agent execution and VM power are separate facts. Unknown is never “on”. */
export function sandboxPower(host: { status: string; lifecycle: { phase: string } } | null): SandboxPower {
  switch (host?.lifecycle.phase) {
    case "suspended": return "off";
    case "suspending": return "stopping";
    case "creating":
    case "resuming": return "starting";
    case "removing":
    case "destroyed": return "removed";
    case "active": return host.status === "connected" ? "on" : "unavailable";
    default: return "unavailable";
  }
}

export const SANDBOX_POWER_LABEL: Record<SandboxPower, string> = {
  checking: "Checking sandbox…",
  on: "Sandbox on",
  off: "Sandbox stopped",
  starting: "Sandbox starting",
  stopping: "Sandbox stopping",
  removed: "Sandbox removed",
  unavailable: "Sandbox status unavailable",
};

export const SANDBOX_POWER_SHORT: Record<SandboxPower, string> = {
  checking: "checking…", on: "on", off: "stopped", starting: "starting",
  stopping: "stopping", removed: "removed", unavailable: "unavailable",
};

/** These actions never equate resuming a VM with repairing an agent. */
export function taskRecovery(task: TaskDto, power: SandboxPower, oom: boolean, canResize: boolean) {
  const state = cardStatus(task);
  if (state.moving || !["stopped", "broken", "waiting-reset"].includes(state.status)) return null;
  // Native bb owns the power controls for paused or transitioning machines.
  if (["off", "starting", "stopping", "removed"].includes(power)) return null;
  if (state.status === "waiting-reset") return {
    message: "Waiting for a reset · work is saved",
    action: "follow-up" as const,
    icon: "Clock" as const,
  };
  if (oom) return {
    message: "Agent stopped · out of memory · work is saved",
    action: canResize ? "resize" as const : "follow-up" as const,
    icon: "Cpu" as const,
  };
  return {
    message: power === "on" ? "Agent stopped · sandbox is still on" : "Agent stopped · check the error above",
    action: "follow-up" as const,
    icon: state.status === "broken" ? "AlertCircle" as const : "Pause" as const,
  };
}
