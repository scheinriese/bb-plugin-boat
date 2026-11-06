// The plugin's account-level UI state (src/ui-state.ts), part of the RPC
// contract (contract.ts spreads uiRpcMethods into it). Kept in the plugin's
// storage, so every device sees the same: a card hidden on the phone stays
// hidden on the desktop.
import { z } from "zod";

/** Tag of the UI state read (saveUiState invalidates it). */
export const UI_TAG = "boat:ui";

export const uiStateSchema = z.object({
  /** The "Coordinate a project with an orchestrator" card on the Cloud agents page is hidden. */
  hideOrchestratorCard: z.boolean(),
});
export type UiStateDto = z.infer<typeof uiStateSchema>;

export const uiRpcMethods = {
  /** The account's UI state (defaults until something was changed). */
  uiState: {
    input: z.null(),
    output: uiStateSchema,
    tags: () => [UI_TAG],
  },
  /** Change some of it; returns all of it. Open pages refresh. */
  saveUiState: {
    input: uiStateSchema.partial(),
    output: uiStateSchema,
  },
};
