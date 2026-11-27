import type { Member } from "../../contract-team.ts";
import type { Runtime } from "../runtime.ts";
import type { TeamEngine } from "./engine.ts";

/** Same selection as Projects: the newest registered, live orchestrator per project. */
export async function syncProjectLeads(
  runtime: Runtime,
  engine: TeamEngine,
  members: Member[],
  problem: (kind: string, key: string, error: unknown) => void,
) {
  const registrations = runtime.service.store.orchestrators();
  const projects = new Map<string, typeof registrations>();
  for (const row of registrations) {
    // Unscoped operator chats are ordinary chats, not project leads.
    if (!row.projectId) continue;
    const group = projects.get(row.projectId) ?? [];
    group.push(row);
    projects.set(row.projectId, group);
  }
  const selected = await Promise.all(
    [...projects.values()].map(async (candidates) => {
      for (const row of candidates) {
        try {
          const response = await runtime.bb.sdk.threads.get({
            threadId: row.threadId,
          });
          const thread = (
            "thread" in response ? response.thread : response
          ) as {
            projectId?: string;
            archivedAt?: unknown;
            deletedAt?: unknown;
          };
          if (thread.archivedAt || thread.deletedAt) continue;
          if (!thread.projectId || thread.projectId === "personal")
            throw new Error("The orchestrator has no canonical bb project");
          return { ...row, bbProjectId: thread.projectId };
        } catch (error) {
          problem("project lead", row.threadId, error);
          // A transient lookup failure must not promote a stale, older chat.
          return null;
        }
      }
      return null;
    }),
  );
  const current = new Map<string, Member>();
  for (const row of selected) {
    if (!row) continue;
    try {
      let member = engine.syncLead(row, members);
      const status = member.status === "archived" ? "active" : member.status;
      if (
        member.projectId !== row.bbProjectId ||
        member.orchestratorProjectId !== row.projectId ||
        member.status !== status
      )
        member = engine.saveMember(member, {
          projectId: row.bbProjectId,
          orchestratorProjectId: row.projectId,
          status,
        });
      current.set(row.projectId!, member);
    } catch (error) {
      problem("project lead", row.threadId, error);
    }
  }
  // Keep audit records, but remove duplicates from directory, sidebar and agent configuration.
  const currentIds = new Set([...current.values()].map((m) => m.id));
  for (const member of members) {
    if (member.kind !== "project-lead" || member.status === "archived")
      continue;
    if (currentIds.has(member.id)) continue;
    try {
      engine.saveMember(member, { status: "archived" });
    } catch (error) {
      problem("project lead", member.id, error);
    }
  }
  return { current, registrations };
}
