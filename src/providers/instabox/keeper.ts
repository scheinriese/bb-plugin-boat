// Keeps Instabox machines awake while a bb chat works there.
//
// Instabox pauses a machine once it looks idle for 30 minutes: no agent of
// its own, no terminal or SSH traffic, little CPU. bb's daemon connection
// doesn't count, so a task chat waiting on a model for a while (or a chat
// whose agent runs quietly) could be paused mid-turn. While a turn or
// background work runs on an Instabox machine, the keeper holds an activity
// lease there (renewed each pass, LEASE_SECONDS long) and releases it once the
// chat is done, so the idle pause works as usual afterwards. Like the boat
// keeper it never keeps a machine on more than KEEP_LIMIT_MS in a row, and a
// chat waiting on the user, or on a machine that isn't up, isn't working.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { KEEP_LIMIT_MS, hasWork, isOpen, rowWork, threadsOnMachine, type ThreadRow } from "../../activity.ts";
import type { InstaboxRest } from "./api.ts";
import { INSTABOX_MACHINE_PROVIDER_ID } from "./provider.ts";

/** The lease's name on each machine (one per machine: renewing it keeps one lease). */
export const LEASE_ID = "bb-boat-chat";
/** How long one lease lasts; each pass renews it well before (passes run every 15 to 60 seconds). */
export const LEASE_SECONDS = 15 * 60;

/** A chat working on its machine: a turn under way, or background work bb reports after one. */
export function chatWorking(row: ThreadRow): boolean {
  if (!isOpen(row)) return false;
  const display = row.runtime?.displayStatus ?? row.runtimeStatus;
  if (display === "waiting-for-host" || display === "provisioning") return false;
  if (hasWork(rowWork(row))) return true;
  if (row.hasPendingInteraction === true) return false;
  return row.status === "active" || row.status === "starting" || row.status === "stopping";
}

interface HostRow {
  id: string;
  machineProviderId?: string | null;
  lifecycle?: { phase?: string; suspendedAt?: number | string | null } | null;
}

export function createInstaboxKeeper(
  bb: BbPluginApi,
  deps: {
    rest: Pick<InstaboxRest, "lease" | "release">;
    signal?: AbortSignal;
    log?: (line: string) => void;
    now?: () => number;
  },
): () => Promise<void> {
  const now = deps.now ?? Date.now;
  /** Since when a chat has kept each machine working, and the machines the keeper holds a lease on. */
  const streak = new Map<string, number>();
  const leased = new Set<string>();
  const release = async (machineId: string) => {
    leased.delete(machineId);
    await deps.rest.release(machineId, LEASE_ID, deps.signal);
  };
  return async () => {
    const raw = (await bb.sdk.hosts.list()) as unknown;
    const hosts = ((Array.isArray(raw) ? raw : ((raw as { hosts?: unknown[] } | null)?.hosts ?? [])) as HostRow[]).filter(
      (host) => host.machineProviderId === INSTABOX_MACHINE_PROVIDER_ID && host.lifecycle?.phase === "active" && !host.lifecycle?.suspendedAt,
    );
    const seen = new Set<string>();
    for (const host of hosts) {
      deps.signal?.throwIfAborted();
      try {
        const resource = (await bb.experimental_machines.getResource(host.id).catch(() => null)) as { sandboxId?: unknown } | null;
        const machineId = typeof resource?.sandboxId === "string" ? resource.sandboxId : null;
        if (machineId === null) continue;
        seen.add(machineId);
        const working = (await threadsOnMachine(bb, host.id)).some(chatWorking);
        if (!working) {
          streak.delete(machineId);
          if (leased.has(machineId)) await release(machineId);
          continue;
        }
        const since = streak.get(machineId) ?? now();
        streak.set(machineId, since);
        if (now() - since < KEEP_LIMIT_MS) {
          await deps.rest.lease(machineId, LEASE_ID, LEASE_SECONDS, deps.signal);
          leased.add(machineId);
        } else if (leased.has(machineId)) {
          // Kept on this long in a row: likely stuck. Instabox's idle pause applies again.
          deps.log?.(`instabox keeper: ${machineId} has been kept awake ${Math.round(KEEP_LIMIT_MS / 3_600_000)} hours in a row; its lease is released`);
          await release(machineId);
        }
      } catch (error) {
        deps.log?.(`instabox keeper ${host.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Machines bb no longer has up (suspended, removed): their leases go.
    for (const machineId of [...streak.keys()]) if (!seen.has(machineId)) streak.delete(machineId);
    for (const machineId of [...leased]) {
      if (seen.has(machineId)) continue;
      await release(machineId).catch((error: unknown) => deps.log?.(`instabox keeper ${machineId}: ${error instanceof Error ? error.message : String(error)}`));
    }
  };
}
