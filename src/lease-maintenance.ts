/** Lease billing failures must never skip the activity lease that keeps
 * Instabox Linux chats awake. Kept separate so both failure paths are tested. */
export async function maintainLeasesAndKeepAwake(deps: {
  hasMacLeases(): boolean; mac(): Promise<void>; keepAwake(): Promise<void>; warn(message: string): void;
}): Promise<void> {
  try {
    if (deps.hasMacLeases()) await deps.mac();
  } catch (error) {
    deps.warn(`Mac lease maintenance failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await deps.keepAwake();
  } catch (error) {
    deps.warn(`instabox keeper failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
