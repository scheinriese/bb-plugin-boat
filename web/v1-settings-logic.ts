import type { SettingDto, SetupStatusDto } from "../contract";

export const SETTINGS_GROUPS = [
  { title: "Agents", keys: ["agents", "implementProvider", "reviewProvider"] },
  { title: "Sandboxes & cost", keys: ["machineType", "maxActiveSandboxes", "stopIdleAfterMinutes", "freeSlotsWhenFull"] },
  { title: "Orchestrators", keys: ["relayPreferred", "orchestratorEffort", "tasksBeforeAsking", "sidebarLayout", "orchestratorMachineType", "cloudOrchestratorFullAccess"] },
  { title: "Notifications", keys: ["pushNotifications"] },
] as const;

export function groupedSettings(rows: readonly SettingDto[]) {
  const used = new Set<string>(SETTINGS_GROUPS.flatMap((group) => [...group.keys]));
  return { groups: SETTINGS_GROUPS.map((group) => ({ title: group.title, rows: group.keys.flatMap((key) => rows.filter((row) => row.key === key)) })), advanced: rows.filter((row) => !used.has(row.key)) };
}

/** Optional checks count as not needed; unknown and warning never claim success. */
export function setupProgress(status: SetupStatusDto) {
  const keys = ["cli", "signed-in", "plan", "agents", "github"];
  const checks = keys.flatMap((id) => status.checks.filter((check) => check.id === id));
  const complete = checks.filter((check) => check.state === "ok" || check.state === "optional");
  const blocking = status.checks.find((check) => check.required && check.state !== "ok" && check.state !== "optional");
  return { checks, complete, blocking, current: blocking ?? checks.find((check) => check.state !== "ok" && check.state !== "optional") };
}
