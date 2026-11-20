// Lifecycle fixtures explicitly grant each displayed fake quote, without
// replaying the task. Gate/consent policy tests do not use this helper.
import assert from "node:assert/strict";
import type { BoatService } from "../src/service.ts";
import type { Task } from "../src/store.ts";
import {
  macRentalQuoteSchema,
  type MacRentalQuote,
} from "../contract-ownmac.ts";
import type {
  MachineType,
  SandboxInfo as Sandbox,
} from "../src/providers/types.ts";
export function withFakeMacRentalConsent(service: BoatService) {
  const seam = service as unknown as {
    createMacFor(
      task: Task,
      type: MachineType,
      signal: AbortSignal,
      unlisted?: Set<string>,
      approval?: MacRentalQuote,
    ): Promise<Sandbox>;
  };
  const create = seam.createMacFor.bind(service);
  seam.createMacFor = async (task, type, signal, unlisted, approval) => {
    for (let attempts = 0; attempts < 4; attempts++) {
      try {
        return await create(task, type, signal, unlisted, approval);
      } catch (error) {
        if (
          (error as { code?: string }).code !==
          "mac_rental_confirmation_required"
        )
          throw error;
        const quote = macRentalQuoteSchema.parse(
          service.store.ownMacEventData(task.id, "ownmac-rental-offer"),
        );
        assert.notEqual(
          quote.id,
          approval?.id,
          "fake owner approval must be for a fresh displayed quote",
        );
        approval = quote;
      }
    }
    throw new Error("Too many fake rental quotes");
  };
}
