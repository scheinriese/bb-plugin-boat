import { useEffect, useState } from "react";
import { experimental_useSidebarThreads, useSdk } from "@get-bb/plugin-sdk/app";
import { sandboxPower, type SandboxPower } from "./recovery-logic";

/** Read only: a disconnected or unreadable machine is never presumed powered on. */
export function useSandboxPower(threadId: string): SandboxPower {
  const sdk = useSdk();
  const { threads } = experimental_useSidebarThreads();
  const thread = threads.find(row => row.id === threadId);
  const [observed, setObserved] = useState<{ threadId: string; power: SandboxPower } | null>(null);
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | null = null;
    setObserved(null);
    if (!threadId) return;
    const refresh = async () => {
      if (disposed || inFlight) return;
      clearTimeout(timer);
      inFlight = true;
      const request = new AbortController();
      controller = request;
      const deadline = setTimeout(() => request.abort(), 4_000);
      let power: SandboxPower = "unavailable";
      try {
        let hostId = thread?.host?.id;
        if (!hostId) {
          const current = await sdk.threads.get({ threadId, signal: request.signal });
          const environment = current.environmentId ? await sdk.environments.get({ environmentId: current.environmentId, signal: request.signal }) : null;
          hostId = environment?.hostId;
        }
        const host = hostId ? await sdk.hosts.get({ hostId, signal: request.signal }) : null;
        if (!request.signal.aborted) power = sandboxPower(host);
      } catch { /* Unknown stays unknown. A follow-up still uses native bb recovery. */ }
      finally {
        clearTimeout(deadline);
        inFlight = false;
        if (!disposed) {
          setObserved({ threadId, power });
          timer = setTimeout(refresh, document.hidden ? 30_000 : 5_000);
        }
      }
    };
    const visible = () => { if (!document.hidden) void refresh(); };
    void refresh();
    document.addEventListener("visibilitychange", visible);
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); document.removeEventListener("visibilitychange", visible); };
  }, [sdk, threadId, thread?.runtimeStatus, thread?.environment?.id, thread?.host?.id]);
  return observed?.threadId === threadId ? observed.power : "checking";
}
