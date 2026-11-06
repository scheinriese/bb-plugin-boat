// Data hooks over the plugin's RPC contract plus a few small UI hooks.
//
// Live reads refresh when the server invalidates their tags (TAGS in
// contract.ts); they never poll on their own.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  experimental_copyToClipboard,
  experimental_usePluginId,
  experimental_useRpcKeyedQuery,
  experimental_useRpcQuery,
  experimental_useSidebarThreads,
  useBbNavigate,
  type ExperimentalBadge,
} from "@get-bb/plugin-sdk/app";
import { rpcContract, type TaskDto } from "../contract";
import { PANEL_PATH, orchestratorSubPath, plural, taskSubPath } from "./format";

const EMPTY_TASKS: readonly TaskDto[] = [];
const ALL_SANDBOXES = { all: true } as const;
const CACHED_SETUP = { force: false } as const;

/** The setup checklist (boat sign-in, plan, agents, …); cached about a minute on the server. */
export function useSetup() {
  return experimental_useRpcQuery({ contract: rpcContract, method: "setup", input: CACHED_SETUP });
}

/** Every setting with its value, wherever it lives (bb's list or the plugin's own sections). */
export function useSettingRows() {
  return experimental_useRpcQuery({ contract: rpcContract, method: "settings", input: null });
}

/** Sandbox sizes with what the plan allows. */
export function useSandboxSizes(enabled = true) {
  return experimental_useRpcQuery({ contract: rpcContract, method: "sandboxSizes", input: null, enabled });
}

export function useOverview() {
  return experimental_useRpcQuery({ contract: rpcContract, method: "overview", input: null });
}

export function useSandboxes(enabled = true) {
  return experimental_useRpcQuery({ contract: rpcContract, method: "sandboxes", input: ALL_SANDBOXES, enabled });
}

/** Claude and Codex usage, and which agent runs each orchestrator. */
export function useRelay() {
  return experimental_useRpcQuery({ contract: rpcContract, method: "relay", input: null });
}

export function useOrchestrators(enabled = true) {
  return experimental_useRpcQuery({ contract: rpcContract, method: "orchestrators", input: null, enabled });
}

/** The overview board: one orchestrator's (threadId) or everything (null). */
export function useBoard(threadId: string | null) {
  const input = useMemo(() => ({ threadId }), [threadId]);
  return experimental_useRpcQuery({ contract: rpcContract, method: "board", input });
}

/**
 * A thread's title as plain text: the sidebar's live title, else the one the
 * server looked up for orchestrators; null while unknown.
 */
export function useThreadDisplayTitle(threadId: string | null): string | null {
  const { threads } = experimental_useSidebarThreads();
  const live = threadId === null ? undefined : threads.find((thread) => thread.id === threadId);
  const { data } = useOrchestrators(threadId !== null && live === undefined);
  if (threadId === null) return null;
  if (live) return live.displayTitle;
  return data?.orchestrators.find((entry) => entry.threadId === threadId)?.title ?? null;
}

export function useHosts(enabled = true) {
  return experimental_useRpcQuery({ contract: rpcContract, method: "hosts", input: null, enabled });
}

/** Configured projects (Settings → Plugins → Boat Cloud Agents → Projects). */
export function useProjects() {
  return experimental_useRpcQuery({ contract: rpcContract, method: "projects", input: null });
}

/** The shared orchestrator protocol (Settings → Plugins → Boat Cloud Agents → Orchestrator protocol). */
export function useProtocol() {
  return experimental_useRpcQuery({ contract: rpcContract, method: "protocol", input: null });
}

/** Model and effort per tier and agent, plus the built-in defaults. */
export function useModelTiers() {
  return experimental_useRpcQuery({ contract: rpcContract, method: "modelTiers", input: null });
}

/** Configured projects plus local bb projects, for the New orchestrator dialog. */
export function useOrchestratorProjects() {
  return experimental_useRpcQuery({ contract: rpcContract, method: "orchestratorProjects", input: null });
}

/** A bb project's GitHub repo and the configured project with that repo (both null for the personal project). */
export function useBbProjectRepo(bbProjectId: string | null) {
  const input = useMemo(() => ({ bbProjectId: bbProjectId ?? "" }), [bbProjectId]);
  return experimental_useRpcQuery({ contract: rpcContract, method: "bbProjectRepo", input, enabled: bbProjectId !== null });
}

export function useTask(id: string | null) {
  const input = useMemo(() => ({ id: id ?? "" }), [id]);
  return experimental_useRpcQuery({ contract: rpcContract, method: "task", input, enabled: id !== null });
}

/** Tasks a thread dispatched, open ones first. One keyed batch per screen. */
export function useThreadTasks(threadId: string): readonly TaskDto[] {
  const keys = useMemo(() => [threadId], [threadId]);
  const { data } = experimental_useRpcKeyedQuery({ contract: rpcContract, method: "tasksByThread", keys });
  return data?.[threadId] ?? EMPTY_TASKS;
}

/** Nav badge: what the board asks of the user, decisions and work ready to review. */
export function useAttentionBadge(): ExperimentalBadge | null {
  const { data } = useBoard(null);
  const decisions = data?.needsYou.length ?? 0;
  const ready = data?.ready.length ?? 0;
  const count = decisions + ready;
  if (count === 0) return null;
  const parts: string[] = [];
  if (decisions > 0) parts.push(plural(decisions, "decision"));
  if (ready > 0) parts.push(`${ready} ready to review`);
  return { count, tone: "warning", label: `Cloud agents: ${parts.join(", ")}` };
}

/** Current time, re-read every `intervalMs` so relative times stay fresh. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Run `callback` every `intervalMs` while `intervalMs` is not null. */
export function useInterval(callback: () => void, intervalMs: number | null): void {
  const saved = useRef(callback);
  useEffect(() => {
    saved.current = callback;
  }, [callback]);
  useEffect(() => {
    if (intervalMs === null) return;
    const timer = setInterval(() => saved.current(), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
}

export function useCloudAgentsNavigation() {
  const navigate = useBbNavigate();
  return useMemo(
    () => ({
      navigate,
      openTask: (id: string) => navigate.toPluginPanel(PANEL_PATH, { subPath: taskSubPath(id) }),
      /** An orchestrator's board ("orchestrator/<threadId>"). */
      openOrchestrator: (threadId: string) =>
        navigate.toPluginPanel(PANEL_PATH, { subPath: orchestratorSubPath(threadId) }),
      openOverview: () => navigate.toPluginPanel(PANEL_PATH, { subPath: "" }),
    }),
    [navigate],
  );
}

export function useCopy() {
  return useCallback(async (text: string, success: string) => {
    const ok = await experimental_copyToClipboard({ text });
    if (ok) toast.success(success);
    else toast.error("Couldn't copy to the clipboard");
  }, []);
}

/**
 * A yes/no the user chose on this device (a hidden card, a note they've
 * read), kept in localStorage under the plugin's id.
 */
export function useStoredFlag(name: string): [boolean, (value: boolean) => void] {
  const pluginId = experimental_usePluginId();
  const key = `${pluginId}:${name}`;
  const read = () => {
    try {
      return globalThis.localStorage?.getItem(key) === "1";
    } catch {
      return false;
    }
  };
  const [value, setValue] = useState(read);
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        if (next) globalThis.localStorage?.setItem(key, "1");
        else globalThis.localStorage?.removeItem(key);
      } catch {
        // Private mode or storage off: it holds for this visit.
      }
    },
    [key],
  );
  return [value, set];
}
