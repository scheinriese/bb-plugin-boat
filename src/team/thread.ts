import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** A failed lookup is unknown; only a native archive/delete/404 is unavailable. */
export async function readTeamThread(bb: BbPluginApi, threadId: string) {
  let response;
  try {
    response = await bb.sdk.threads.get({ threadId });
  } catch (error) {
    const failure = error as {
      status?: number;
      code?: string;
      message?: string;
    };
    if (
      failure?.status === 404 ||
      failure?.code === "thread_not_found" ||
      /\b404\b|thread.not.found/i.test(failure?.message ?? "")
    )
      return { available: false, projectId: null };
    throw error;
  }
  const thread = ("thread" in response ? response.thread : response) as {
    id?: string;
    projectId?: string;
    archivedAt?: unknown;
    deletedAt?: unknown;
  };
  if (thread.id && thread.id !== threadId)
    throw new Error("bb returned a different home chat");
  if (thread.archivedAt != null || thread.deletedAt != null)
    return { available: false, projectId: null };
  if (
    !thread.projectId?.trim() ||
    thread.projectId === "personal" ||
    thread.projectId.length > 200
  )
    throw new Error("The home chat has no canonical bb project");
  return { available: true, projectId: thread.projectId };
}
