// SDK-only status cues. The host owns glyph rendering and metadata visibility.
import { useEffect, useSyncExternalStore } from "react";
import {
  experimental_useRpcKeyedQuery,
  experimental_useSidebarThreads,
  type PluginAppBuilder,
  type PluginContentScriptContext,
  type ExperimentalThreadRowMetadataDataInput,
  type ExperimentalThreadRowMetadataProps,
} from "@get-bb/plugin-sdk/app";
import { rpcContract, type ThreadRoleDto } from "../contract";
import { cardStatus, CARD_TONES } from "./cards-logic";
import { cn } from "@/lib/utils";
let rowContext: PluginContentScriptContext | null = null;
let revision = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => revision;
function changed() {
  revision++;
  for (const listener of listeners) listener();
}
type Roles = Record<string, ThreadRoleDto> | undefined;
function useRoles({ threads }: ExperimentalThreadRowMetadataDataInput): Roles {
  return experimental_useRpcKeyedQuery({
    contract: rpcContract,
    method: "threadRoles",
    keys: threads.map((t) => t.id),
    enabled: threads.length > 0,
  }).data;
}
function RowMetadata({
  thread,
  data,
}: ExperimentalThreadRowMetadataProps<Roles>) {
  const role = data?.[thread.id];
  if (role?.kind !== "task" || role.task.threadId !== thread.id) return null;
  const state = cardStatus(role.task);
  if (!["ready", "broken", "needs-you", "stopped"].includes(state.status))
    return null;
  return (
    <span
      className={cn("truncate text-xs", CARD_TONES[state.tone])}
      title={role.task.publicStatus?.reason ?? state.label}
    >
      {state.label}
      {role.task.publicStatus?.reason
        ? ` · ${role.task.publicStatus.reason}`
        : ""}
    </span>
  );
}
function RowSignalSync() {
  const { threads } = experimental_useSidebarThreads();
  const { data } = experimental_useRpcKeyedQuery({
    contract: rpcContract,
    method: "threadRoles",
    keys: threads.map((t) => t.id),
    enabled: threads.length > 0,
  });
  const generation = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    const set = rowContext?.experimental_setThreadRowStatus;
    if (!set || !data) return;
    const marked: string[] = [];
    for (const [id, role] of Object.entries(data)) {
      // Handover history still resolves to the task, but its live status belongs
      // only to the task's current chat.
      if (role.kind !== "task" || role.task.threadId !== id) continue;
      const state = cardStatus(role.task);
      if (!state.moving && ["working", "review"].includes(state.status)) continue;
      const reason = role.task.publicStatus?.reason;
      set(id, {
        icon:
          state.status === "broken"
            ? "AlertCircle"
            : state.status === "ready" || state.status === "shipped"
              ? "Check"
              : state.status === "needs-you"
                ? "MessageSquare"
                : state.status === "stopped" || state.status === "waiting-reset"
                  ? "Pause"
                  : state.status === "review"
                    ? "Eye"
                    : "Loading",
        label: reason ? `${state.label}: ${reason}` : state.label,
        tone: state.moving
          ? "running"
          : state.status === "broken"
            ? "error"
            : state.status === "ready" || state.status === "shipped"
              ? "success"
              : "default",
      });
      marked.push(id);
    }
    return () => {
      for (const id of marked) set(id, null);
    };
  }, [data, generation]);
  return null;
}
export function registerRowSignals(app: PluginAppBuilder) {
  app.contentScripts.register({
    id: "task-row-status",
    mount(context) {
      rowContext = context;
      changed();
      return () => {
        if (rowContext === context) {
          rowContext = null;
          changed();
        }
      };
    },
  });
  app.slots.experimental_appOverlay({
    id: "task-row-status-sync",
    component: RowSignalSync,
  });
  app.slots.experimental_threadRowMetadata<Roles>({
    id: "task-status",
    order: 20,
    useData: useRoles,
    component: RowMetadata,
  });
}
