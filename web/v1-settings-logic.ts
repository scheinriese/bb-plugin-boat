import type { SettingDto, SetupStatusDto, TaskDto } from "../contract";

export function setupTestPassed(task: Pick<TaskDto, "status" | "error" | "reportStatus"> | undefined): boolean {
  return task !== undefined && (task.status === "idle" || task.status === "done") && task.error === null && task.reportStatus === "done";
}

/** Setup's permissive launch policy also allows unknown API facts; the checklist keeps checking those. */
export function setupNeedsWork(status: SetupStatusDto): boolean {
  return status.checks.some((check) => check.required && check.state !== "ok" && check.state !== "optional" || check.state === "warning");
}

export const SETTINGS_GROUPS = [
  { title: "Agents", keys: ["agents", "relayPreferred"] },
  { title: "Sandboxes & cost", keys: ["machineType", "maxActiveSandboxes", "stopIdleAfterMinutes", "avoidExtraUsage"] },
  { title: "Orchestrators", keys: ["tasksBeforeAsking"] },
  { title: "Notifications", keys: ["notifyNeedsYou", "notifyReady", "notifyProgress"] },
] as const;

export function groupedSettings(rows: readonly SettingDto[]) {
  const used = new Set<string>(SETTINGS_GROUPS.flatMap((group) => [...group.keys]));
  return { groups: SETTINGS_GROUPS.map((group) => ({ title: group.title, rows: group.keys.flatMap((key) => rows.filter((row) => row.key === key)) })), advanced: rows.filter((row) => !used.has(row.key)) };
}

export const EVERYDAY_SETTING_COPY: Record<string, { label?: string; description: string }> = {
  agents: { description: "Follows what's connected in boat.dev." },
  relayPreferred: { description: "Tasks pick per job; reviews use the other agent." },
  machineType: { label: "Default size", description: "Projects and tasks can pick another." },
  maxActiveSandboxes: { description: "The most running at the same time." },
  stopIdleAfterMinutes: { label: "Stop idle sandboxes after", description: "Work in progress keeps a sandbox on." },
  avoidExtraUsage: { description: "New tasks wait for the usage reset instead." },
  tasksBeforeAsking: { description: "Above this, the orchestrator asks you first." },
};

/** Keep a migrated opt-out off until the owner enables a category explicitly. */
export function notificationSettingPatch(master: boolean, key: "notifyNeedsYou" | "notifyReady" | "notifyProgress", checked: boolean) {
  return { pushNotifications: true, ...(!master ? { notifyNeedsYou: false, notifyReady: false, notifyProgress: false } : {}), [key]: checked };
}

export function checkedAgo(iso: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(iso));
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** Optional checks count as not needed; unknown and warning never claim success. */
export function setupProgress(status: SetupStatusDto) {
  const keys = ["cli", "signed-in", "plan", "agents", "github"];
  const checks = keys.flatMap((id) => status.checks.filter((check) => check.id === id));
  const complete = checks.filter((check) => check.state === "ok" || check.state === "optional");
  const blocking = status.checks.find((check) => check.required && check.state !== "ok" && check.state !== "optional");
  return { checks, complete, blocking, current: blocking ?? checks.find((check) => check.state !== "ok" && check.state !== "optional") };
}
