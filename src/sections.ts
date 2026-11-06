// Sidebar sections: one per project ("Web app", "Docs site"), holding
// its orchestrators with their worker chats nested under them.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const SIDEBAR_LAYOUTS = ["sections", "pinned", "plain"] as const;
export type SidebarLayout = (typeof SIDEBAR_LAYOUTS)[number];

/** The section named after the project, created when missing; null if bb refuses (spawning goes on). */
export async function ensureProjectSection(bb: BbPluginApi, name: string, log?: (line: string) => void): Promise<string | null> {
  const wanted = name.trim().slice(0, 80);
  if (wanted === "") return null;
  try {
    const sections = (await bb.sdk.threadSections.list()) as unknown as { id: string; name: string }[];
    const found = sections.find((section) => section.name.trim().toLowerCase() === wanted.toLowerCase());
    if (found) return found.id;
    const created = (await bb.sdk.threadSections.create({ name: wanted })) as unknown as { id?: string; section?: { id?: string } };
    return created.id ?? created.section?.id ?? null;
  } catch (error) {
    log?.(`section "${wanted}": ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** A thread's section (workers join their orchestrator's). */
export async function threadSection(bb: BbPluginApi, threadId: string): Promise<string | null> {
  try {
    const raw = (await bb.sdk.threads.get({ threadId })) as unknown as { sectionId?: string | null; thread?: { sectionId?: string | null } };
    return raw.thread?.sectionId ?? raw.sectionId ?? null;
  } catch {
    return null;
  }
}
