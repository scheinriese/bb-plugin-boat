// The sandbox providers' keys, as bb keeps them: secret settings (bb's
// secure entry on its settings page for the plugin; a 0600 file, never the
// database, a backup, the page or a log). Only the server reads them, and
// only to hand them to the provider's CLI or API (Instabox: the
// INSTABOX_API_KEY variable of its CLI, the X-API-Key header of its API).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { SECRET_SETTINGS } from "./settings.ts";

export interface ProviderSecrets {
  /** The Instabox API key (null: none stored), read fresh. */
  instaboxKey(): Promise<string | null>;
  /** A key is stored, as last read (for the registry, which can't wait). */
  instaboxKeyPresent(): boolean;
  /** After the owner stores, changes or removes a key. */
  onChange(listener: () => void): void;
}

export async function defineProviderSecrets(bb: Pick<BbPluginApi, "settings">): Promise<ProviderSecrets> {
  const handle = bb.settings.define(SECRET_SETTINGS);
  let present = false;
  const listeners: (() => void)[] = [];
  const read = async (): Promise<string | null> => {
    const values = await handle.get();
    const key = typeof values.instaboxApiKey === "string" ? values.instaboxApiKey.trim() : "";
    present = key !== "";
    return present ? key : null;
  };
  await read().catch(() => null);
  handle.onChange(() => {
    void read()
      .catch(() => null)
      .then(() => {
        for (const listener of listeners) listener();
      });
  });
  return {
    instaboxKey: read,
    instaboxKeyPresent: () => present,
    onChange: (listener) => void listeners.push(listener),
  };
}
