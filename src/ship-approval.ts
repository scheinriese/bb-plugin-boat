// After a ship stopped on a conflict: what the user approved. The user's
// earlier OK never covers the commits of a later turn; these texts say why a
// second approval is needed.
import { fileList } from "./boat-api.ts";
import type { ShipApproval, Task } from "./store.ts";

/** "package.json", or "the rebase onto main" when the files aren't known. */
function conflictPlace(approval: Pick<ShipApproval, "files" | "moreFiles" | "baseBranch">): string {
  return fileList(approval.files, approval.moreFiles) || `the rebase onto ${approval.baseBranch}`;
}

/** The ship was approved, then the task had a newer turn (the conflict's follow-up). */
export function changedSinceApproval(task: Pick<Task, "turns" | "shipApproval">): boolean {
  return task.shipApproval !== null && task.turns > task.shipApproval.turns;
}

/** chatApproval's reason after a conflict's follow-up: the earlier OK doesn't cover the new commits. */
export function changedApprovalReason(approval: Pick<ShipApproval, "files" | "moreFiles" | "baseBranch">): string {
  return `the work changed after the user approved it (a follow-up resolved a conflict in ${conflictPlace(approval)}); show the user what changed and ask them to approve again`;
}
