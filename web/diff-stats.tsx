import { cn } from "../lib/utils";

// Native bb Git/Diff uses these semantic tokens in both light and dark themes.
export const DIFF_ADDED_COLOR = "var(--diff-added, #5BD08A)";
export const DIFF_REMOVED_COLOR = "var(--diff-removed, #E06C6C)";

/** Keep each signed count colored as one unit; surrounding separators inherit gray. */
export function DiffStats({ additions, deletions, className }: { additions: number; deletions: number; className?: string }) {
  return <span className={cn("inline-flex items-baseline gap-1 whitespace-nowrap tabular-nums", className)}>
    <span style={{ color: DIFF_ADDED_COLOR }}>+{additions.toLocaleString("en-US")}</span>{" "}
    <span style={{ color: DIFF_REMOVED_COLOR }}>−{deletions.toLocaleString("en-US")}</span>
  </span>;
}
