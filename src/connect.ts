// bb Connect: worker chats and cloud orchestrators run bb in a boat sandbox,
// and that bb reaches this one through bb Connect (getbb.app). Its status
// comes from the built-in connect plugin's `status` RPC.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export interface ConnectStatus {
  /** ready: signed in and remote access on; off: not set up; unknown: couldn't tell. */
  state: "ready" | "off" | "unknown";
  /** What to do when it's off. */
  fix: string | null;
}

export type ConnectCheck = () => Promise<ConnectStatus>;

const statusSchema = z.object({ paired: z.boolean().optional(), enabled: z.boolean().optional() }).passthrough();

const CACHE_MS = 30_000;

/** Read the connect plugin's status (cached briefly). Never throws. */
export function createConnectCheck(bb: BbPluginApi, options: { cacheMs?: number } = {}): ConnectCheck {
  const cacheMs = options.cacheMs ?? CACHE_MS;
  let cached: { at: number; status: ConnectStatus } | null = null;
  return async () => {
    if (cached !== null && Date.now() - cached.at < cacheMs) return cached.status;
    const status = await read(bb);
    cached = { at: Date.now(), status };
    return status;
  };
}

async function read(bb: BbPluginApi): Promise<ConnectStatus> {
  try {
    const result = await bb.sdk.plugins.callRpc({
      pluginId: "connect",
      method: "status",
      input: null,
      outputSchema: statusSchema,
      signal: AbortSignal.timeout(5_000),
    });
    return connectStatus(result);
  } catch (error) {
    const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
    // The connect plugin is missing or turned off: there's no remote access.
    if (/unknown plugin|not running|not loaded|not enabled|disabled/i.test(text)) {
      return { state: "off", fix: "Turn on the bb connect plugin (Settings → Plugins), sign in with `bb account login`, then run `bb connect on`." };
    }
    return { state: "unknown", fix: null };
  }
}

/** The connect plugin's status answer, as the plugin needs it. */
export function connectStatus(result: { paired?: boolean; enabled?: boolean }): ConnectStatus {
  if (result.paired === false) return { state: "off", fix: "Sign this bb in to getbb.app with `bb account login`, then run `bb connect on`." };
  if (result.enabled === false) return { state: "off", fix: "Turn remote access back on with `bb connect on`." };
  if (result.paired === true && result.enabled === true) return { state: "ready", fix: null };
  return { state: "unknown", fix: null };
}
