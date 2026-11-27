import { readTeamThread } from "./thread.ts";
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
    [...projects.entries()].map(async ([projectId, candidates]) => {
      for (const row of candidates) {
        try {
          const thread = await readTeamThread(runtime.bb, row.threadId);
          if (!thread.available) continue;
          return {
            projectId,
            lead: { ...row, bbProjectId: thread.projectId! },
            unknown: false,
          };
        } catch (error) {
          problem("project lead", row.threadId, error);
          // Preserve pause and membership on unknown state; never promote an older chat.
          return { projectId, lead: null, unknown: true };
        }
      }
      return { projectId, lead: null, unknown: false };
    }),
  );
  const current = new Map<string, Member>();
  const unknown = new Set(
    selected.filter((p) => p.unknown).map((p) => p.projectId),
  );
  for (const { lead: row } of selected) {
    if (!row) continue;
    try {
      let member = engine.syncLead(row, members);
      const status =
        member.pauseRequested || member.status === "paused"
          ? "paused"
          : "active";
      if (
        member.projectId !== row.bbProjectId ||
        member.orchestratorProjectId !== row.projectId ||
        member.status !== status ||
        member.availability !== "available" ||
        (status === "paused" && !member.pauseRequested)
      )
        member = engine.saveMember(member, {
          projectId: row.bbProjectId,
          orchestratorProjectId: row.projectId,
          status,
          availability: "available",
        });
      current.set(row.projectId!, member);
    } catch (error) {
      problem("project lead", row.threadId, error);
    }
  }
  // Keep audit records, but remove duplicates from directory, sidebar and agent configuration.
  const currentIds = new Set([...current.values()].map((m) => m.id));
  for (const member of members) {
    if (member.kind !== "project-lead" || currentIds.has(member.id)) continue;
    const availability = unknown.has(member.orchestratorProjectId ?? "")
      ? "unknown"
      : "unavailable";
    const status = availability === "unknown" ? member.status : "archived";
    if (
      member.status === status &&
      member.availability === availability &&
      !(member.status === "paused" && !member.pauseRequested)
    )
      continue;
    try {
      engine.saveMember(member, { status, availability });
    } catch (error) {
      problem("project lead", member.id, error);
    }
  }
  return { current, registrations };
}
