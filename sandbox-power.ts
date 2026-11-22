import type { MachinePower } from "./contract-sandboxes.ts";

/**
 * Running guests, not active tasks or held leases. boat's ready/idle/running
 * are its Running group: https://docs.boat.dev/concepts (checked 2026-11-22).
 * Starting and stopping states do not prove a ready guest. An error also
 * cannot establish power state across providers. Keep capacity rules separate.
 */
export function machinePower(state: string): MachinePower {
  if (["ready", "idle", "running"].includes(state)) return "on";
  if (["stopped", "archived", "deleted", "cancelled"].includes(state)) return "off";
  return "unknown";
}
