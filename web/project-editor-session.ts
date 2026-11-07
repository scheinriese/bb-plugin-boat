import type { ProjectDto } from "../contract";
export type ProjectEditing = ProjectDto | "new" | null;
export interface EditorDraft {
  name: string;
  selectedRepo: string;
  query: string;
  base: string;
  useLocal: boolean;
  repoLines: string[];
  delivery: ProjectDto["delivery"];
  size: NonNullable<ProjectDto["machineType"]> | null;
  reviewer: NonNullable<ProjectDto["reviewer"]> | null;
  protectedText: string;
  rules: string;
  instructions: string;
  environment: string;
  workerMode: NonNullable<ProjectDto["workerMode"]>;
  snapshot: string;
}

// Own UI draft memory only. BB can remount a nav panel at its compact breakpoint.
// No disk/settings writes and no host DOM access; Save/Cancel clears the session.
let session: {
  editing: ProjectEditing;
  draft: { key: string; value: EditorDraft } | null;
} = { editing: null, draft: null };
export function readProjectEditorSession() {
  return session;
}
export function setProjectEditorSession(editing: ProjectEditing) {
  const key = editing === "new" ? "new" : editing?.id;
  const previous = session.editing === "new" ? "new" : session.editing?.id;
  session = {
    editing,
    draft: editing && key === previous ? session.draft : null,
  };
}
export function retainProjectEditorDraft(key: string, value: EditorDraft) {
  const current = session.editing === "new" ? "new" : session.editing?.id;
  if (current === key) session = { ...session, draft: { key, value } };
}
