import type { BoatService } from "./service.ts";

/** The picker and Sandboxes share this bounded, public projection. A failed
 * provider is unknown, even if other providers successfully returned no rows. */
export async function readSavedSnapshots(service: Pick<BoatService, "snapshots">, now = Date.now) {
  try {
    const result = await service.snapshots(AbortSignal.timeout(15_000));
    const snapshots = result.snapshots.slice(0, 1000).map(({ name, sizeBytes, createdAt, type, status, provider }) => ({
      name, sizeBytes, createdAt, type, status, ...(provider === "boat" ? {} : { provider }),
    }));
    const truncated = result.snapshots.length > snapshots.length;
    const complete = result.failed.length === 0 && !truncated;
    return {
      snapshots, included: result.included, used: result.used,
      observedAt: new Date(now()).toISOString(), complete,
      failedProviders: result.failed.map(({ provider }) => provider),
      error: complete ? null : truncated ? "Saved snapshot list is incomplete." : "Some saved snapshots could not be checked.",
    };
  } catch {
    // Raw provider errors can contain customer identifiers and credentials.
    return { snapshots: [], included: null, used: null, observedAt: null,
      complete: false, failedProviders: [], error: "Saved snapshots unavailable. Try again." };
  }
}
