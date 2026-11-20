import type { ReactNode } from "react";

/** Task-owned rows keep the existing hover Delete beside Resume. Sandboxes
 * without a task have no resume path, so Delete stays visible on its own. */
export function StoppedSandboxActions({ unowned, deleteButton, resumeButton }: { unowned: boolean; deleteButton: ReactNode; resumeButton: ReactNode }) {
  return <>
    <span className={unowned ? undefined : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 max-md:opacity-100"}>{deleteButton}</span>
    {!unowned && resumeButton}
  </>;
}
