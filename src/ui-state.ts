// Account-level UI state: choices about the plugin's pages that hold on every
// device (they live in the plugin's kv, like its own settings). Today: the
// orchestrator card on the Cloud agents page is hidden.
//
// Not a setting: `bb boat config` doesn't list it, and backups
// (src/config.ts) leave it out, like the notes a device remembers as read.
import type { BbPluginApi, PluginKvStorage } from "@get-bb/plugin-sdk";
import { UI_TAG, uiStateSchema, type UiStateDto } from "../contract-ui.ts";

/** kv key of the UI state (only values that were changed). */
export const UI_STATE_KEY = "uiState";

const DEFAULTS: UiStateDto = { hideOrchestratorCard: false };

/** The stored state over the defaults; values this version doesn't accept are ignored. */
export async function readUiState(kv: Pick<PluginKvStorage, "get">): Promise<UiStateDto> {
  const raw = await kv.get<unknown>(UI_STATE_KEY).catch(() => undefined);
  const record = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const state: UiStateDto = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof UiStateDto)[]) {
    const value = uiStateSchema.shape[key].safeParse(record[key]);
    if (value.success) state[key] = value.data;
  }
  return state;
}

/** Change some values; returns the whole state. */
export async function saveUiState(kv: Pick<PluginKvStorage, "get" | "set">, patch: Partial<UiStateDto>): Promise<UiStateDto> {
  const next = { ...(await readUiState(kv)), ...uiStateSchema.partial().parse(patch) };
  await kv.set(UI_STATE_KEY, next);
  return next;
}

/** The RPC handlers (contract-ui.ts); a change refreshes every open page. */
export function uiStateHandlers(bb: Pick<BbPluginApi, "storage" | "rpc">) {
  return {
    uiState: () => readUiState(bb.storage.kv),
    saveUiState: async (patch: Partial<UiStateDto>) => {
      const next = await saveUiState(bb.storage.kv, patch);
      bb.rpc.experimental_invalidate([UI_TAG]);
      return next;
    },
  };
}
