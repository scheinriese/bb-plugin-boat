// bb project sources for task chats on boat sandboxes.
//
// A task chat opens in its checkout on the sandbox's machine, an "unmanaged"
// workspace. bb places that with its built-in "project-checkout" environment
// provider on the existing machine, and that provider requires a project
// checkout: outside Personal, bb refuses the chat with 409 "No project source
// configured for this host" unless the project has a local_path source for
// that machine. Personal chats get a personal workspace and need none.
//
// bb keeps at most one source per project and machine, so any source the
// project has on the machine will do. Before a task chat opens in another
// project, Boat reuses it, or adds one for the task's checkout, and removes
// the ones it added once nothing on that machine needs them. Only sources in
// Boat's own registry (plugin kv) are ever deleted: never a source Boat
// didn't add, and never a project's last source (bb refuses that).
import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** Registry rows: one per source Boat added (plugin kv). */
export const PROJECT_SOURCE_KEY_PREFIX = "projectSource:";

/** bb's answer to a chat in a checkout on a machine its project has no source for. */
export const NO_PROJECT_SOURCE = /no project source configured/i;

/** A source Boat added to a bb project, and the tasks whose chats opened with it. */
export interface OwnProjectSource {
  sourceId: string;
  projectId: string;
  hostId: string;
  path: string;
  /** Tasks that added or reused it (the task on the machine may not be recorded there yet). */
  taskIds: string[];
  /** Epoch ms. */
  createdAt: number;
}

export interface EnsuredProjectSource {
  sourceId: string;
  /** Boat added it just now. */
  created: boolean;
  /** Boat added it (now or for an earlier task): Boat removes it later. False: someone else's, never removed. */
  own: boolean;
  /** bb made it the project's default (it does for a project's first source). */
  isDefault: boolean;
}

/** removed: gone from bb and the registry; in-use: still needed; last-source: bb won't delete a project's last source (kept, tried again later); not-ours: not in Boat's registry, untouched. */
export type RemovedProjectSource = "removed" | "in-use" | "last-source" | "not-ours";

export interface ProjectSources {
  /** The project's local_path source for this machine: the one it has, else a new one for this path (never asked to be the default). */
  ensure(args: { taskId: string; projectId: string; hostId: string; path: string }): Promise<EnsuredProjectSource>;
  /** The sources Boat added and still tracks. */
  own(): Promise<OwnProjectSource[]>;
  /**
   * Delete a source Boat added and stop tracking it (one bb no longer lists
   * counts as removed). inUse is asked again just before, with the latest
   * registry row: true keeps it. Sources not in Boat's registry are never
   * touched.
   */
  remove(sourceId: string, inUse?: (row: OwnProjectSource) => boolean): Promise<RemovedProjectSource>;
}

interface BbSource {
  id: string;
  type?: string;
  hostId?: string;
  path?: string;
  isDefault?: boolean;
}

function keyFor(sourceId: string): string {
  return `${PROJECT_SOURCE_KEY_PREFIX}${sourceId}`;
}

function isNotFound(error: unknown): boolean {
  return /not[ _]found|404/i.test(error instanceof Error ? error.message : String(error));
}

function isOwnSource(value: unknown): value is OwnProjectSource {
  const row = value as Partial<OwnProjectSource> | null;
  return (
    row !== null &&
    typeof row === "object" &&
    typeof row.sourceId === "string" &&
    typeof row.projectId === "string" &&
    typeof row.hostId === "string" &&
    typeof row.path === "string" &&
    Array.isArray(row.taskIds)
  );
}

/** bb's project page (projects.get), with or without the { project } wrapper. */
async function listSources(bb: BbPluginApi, projectId: string): Promise<BbSource[]> {
  const raw = (await bb.sdk.projects.get({ projectId })) as unknown;
  const project = ((raw as { project?: unknown } | null)?.project ?? raw) as { sources?: unknown } | null;
  const sources = Array.isArray(project?.sources) ? project.sources : [];
  return sources.filter((entry): entry is BbSource => entry !== null && typeof entry === "object" && typeof (entry as BbSource).id === "string");
}

export function createProjectSources(bb: BbPluginApi): ProjectSources {
  // Read when used: bb binds storage before handlers run.
  const kv = () => bb.storage.kv;
  const read = async (sourceId: string): Promise<OwnProjectSource | null> => {
    const row = await kv().get<unknown>(keyFor(sourceId));
    return isOwnSource(row) ? row : null;
  };
  // One change to sources and the registry at a time: a reuse that adds a task
  // never races a removal that read the row before it.
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work);
    tail = run.catch(() => undefined);
    return run;
  };

  return {
    ensure: ({ taskId, projectId, hostId, path }) =>
      serial(async () => {
        const existing = (await listSources(bb, projectId)).find((source) => (source.type ?? "local_path") === "local_path" && source.hostId === hostId);
        if (existing !== undefined) {
          const own = await read(existing.id);
          if (own !== null && !own.taskIds.includes(taskId)) await kv().set(keyFor(own.sourceId), { ...own, taskIds: [...own.taskIds, taskId] });
          return { sourceId: existing.id, created: false, own: own !== null, isDefault: existing.isDefault === true };
        }
        // The request takes no default flag; bb makes only a project's first source its default.
        const added = (await bb.sdk.projects.sources.add({ projectId, type: "local_path", hostId, path })) as unknown;
        const source = ((added as { source?: unknown } | null)?.source ?? added) as { id?: unknown; path?: unknown; isDefault?: unknown } | null;
        if (typeof source?.id !== "string") throw new Error("bb did not return the new project source's id");
        const row: OwnProjectSource = {
          sourceId: source.id,
          projectId,
          hostId,
          path: typeof source.path === "string" ? source.path : path,
          taskIds: [taskId],
          createdAt: Date.now(),
        };
        try {
          await kv().set(keyFor(row.sourceId), row);
        } catch (error) {
          // Untracked, it would never go: take it back (best effort). When bb refuses (a project's only source), say so.
          const kept = await bb.sdk.projects.sources.delete({ projectId, sourceId: row.sourceId }).then(
            () => null,
            (deleteError: unknown) => (deleteError instanceof Error ? deleteError.message : String(deleteError)),
          );
          if (kept === null) throw error;
          throw new Error(`${error instanceof Error ? error.message : String(error)}; bb kept source ${row.sourceId}, which Boat couldn't record or remove (${kept})`);
        }
        return { sourceId: row.sourceId, created: true, own: true, isDefault: source.isDefault === true };
      }),

    own: () =>
      serial(async () => {
        const rows: OwnProjectSource[] = [];
        for (const key of await kv().list(PROJECT_SOURCE_KEY_PREFIX)) {
          const row = await kv().get<unknown>(key);
          if (isOwnSource(row)) rows.push(row);
        }
        return rows.sort((a, b) => a.createdAt - b.createdAt);
      }),

    remove: (sourceId, inUse) =>
      serial(async (): Promise<RemovedProjectSource> => {
        const own = await read(sourceId);
        if (own === null) return "not-ours";
        if (inUse?.(own)) return "in-use";
        let sources: BbSource[] = [];
        try {
          sources = await listSources(bb, own.projectId);
        } catch (error) {
          // The project is gone, and its sources with it.
          if (!isNotFound(error)) throw error;
        }
        const listed = sources.find((source) => source.id === sourceId);
        // Only the source Boat added for this machine: bb no longer lists it, or it isn't that one any more.
        if (listed !== undefined && listed.hostId === own.hostId) {
          if (sources.length <= 1) return "last-source";
          await bb.sdk.projects.sources.delete({ projectId: own.projectId, sourceId }).catch((error: unknown) => {
            if (!isNotFound(error)) throw error;
          });
        }
        await kv().delete(keyFor(sourceId));
        return "removed";
      }),
  };
}
