import { isSandboxActive } from "./format.ts";
/** Avoid counting a task session twice: the local task count replaces the
 * sandbox count for Your Mac, including while its admission toggle is off. */
export function footerOnCount(
  sandboxes:
    readonly { state: string; runsOn?: { provider: string } }[] | undefined,
  ownRunning?: number,
): number | undefined {
  if (!sandboxes) return undefined;
  return (
    sandboxes.filter(
      (s) =>
        isSandboxActive(s.state) &&
        (ownRunning === undefined || s.runsOn?.provider !== "ownmac"),
    ).length + (ownRunning ?? 0)
  );
}
