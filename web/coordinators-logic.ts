import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

export type CoordinationThread = Pick<PluginSidebarThread,
  "id" | "parentThreadId" | "displayTitle" | "projectId" | "providerId" |
  "status" | "runtimeStatus" | "queuedWork" | "hasPendingInteraction" |
  "activity" | "isHidden" | "isArchived" | "createdAt"
>;

export type NativeActivity = "needs-you" | "working" | "waiting" | "error" | "idle";
export type NativeCoordinator = {
  thread: CoordinationThread;
  children: CoordinationThread[];
  counts: Record<NativeActivity, number>;
};

/** Native idle is not a review verdict, and unread is not a request for input. */
export function nativeActivity(thread: CoordinationThread): NativeActivity {
  if (thread.hasPendingInteraction) return "needs-you";
  const status = ["active", "starting", "stopping", "provisioning", "pending", "waiting-for-host", "error", "idle"].includes(thread.runtimeStatus) ? thread.runtimeStatus : thread.status;
  if (status === "error" || thread.queuedWork === "failed") return "error";
  if (["pending", "waiting-for-host"].includes(status)) return "waiting";
  if (["active", "starting", "stopping", "provisioning"].includes(status) ||
    thread.activity.workflows > 0 || thread.activity.backgroundAgents > 0 ||
    thread.activity.backgroundCommands > 0) return "working";
  if (thread.queuedWork === "waiting") return "waiting";
  return "idle";
}

/**
 * Discover coordination from the public hierarchy, never titles or transcript
 * content. Nested native delegations belong to one visible coordinator. Boat
 * workers (including their native subchats) stay in Boat's existing task view.
 * A registered orchestrator is a boundary, so mixed work can share its group.
 */
export function nativeCoordinators(
  threads: readonly CoordinationThread[],
  managedThreadIds: ReadonlySet<string>,
  orchestratorIds: ReadonlySet<string>,
): NativeCoordinator[] {
  const visible = new Map(threads.filter(t => !t.isArchived && !t.isHidden).map(t => [t.id, t]));
  const groups = new Map<string, NativeCoordinator>();
  for (const child of visible.values()) {
    if (managedThreadIds.has(child.id) || orchestratorIds.has(child.id)) continue;
    let root = child;
    const visited = new Set([child.id]);
    let blocked = false;
    while (root.parentThreadId && visible.has(root.parentThreadId)) {
      const parent = visible.get(root.parentThreadId)!;
      if (visited.has(parent.id) || managedThreadIds.has(parent.id)) { blocked = true; break; }
      visited.add(parent.id);
      root = parent;
      if (orchestratorIds.has(root.id)) break;
    }
    if (blocked || root.id === child.id) continue;
    let group = groups.get(root.id);
    if (!group) {
      group = { thread: root, children: [], counts: { "needs-you": 0, working: 0, waiting: 0, error: 0, idle: 0 } };
      groups.set(root.id, group);
    }
    group.children.push(child);
    group.counts[nativeActivity(child)]++;
  }
  return [...groups.values()].sort((a, b) => b.thread.createdAt - a.thread.createdAt || a.thread.id.localeCompare(b.thread.id));
}
