import { useEffect, useState } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { NATIVE_REVIEW_METADATA, nativeReviewStateSchema, type NativeReviewState } from "../contract-review";

/** Optional public metadata; legacy/missing data never blocks the Task panel. */
export function useNativeReviewPolicy(threadId: string | null, taskId: string, revision?: string): NativeReviewState | null {
  const sdk = useSdk();
  const [state, setState] = useState<NativeReviewState | null>(null);
  useEffect(() => {
    setState(null);
    if (!threadId) return;
    const abort = new AbortController(); let sequence = 0; let inFlight = false;
    async function refresh() {
      if (inFlight || abort.signal.aborted) return;
      inFlight = true;
      const request = ++sequence;
      try {
        const metadata = await sdk.threads.getPluginMetadata({ threadId: threadId!, signal: abort.signal });
        const parsed = nativeReviewStateSchema.safeParse(metadata[NATIVE_REVIEW_METADATA]);
        if (!abort.signal.aborted && request === sequence) setState(parsed.success && parsed.data.taskId === taskId ? parsed.data : null);
      } catch { /* Keep the last known policy through a transient read failure. */ }
      finally { inFlight = false; }
    }
    let unsubscribe = () => {};
    try { unsubscribe = sdk.subscribe({ event: "thread:changed", threadId, callback: () => void refresh() }); } catch { /* Metadata remains optional on older hosts. */ }
    // Public metadata writes currently emit no thread change event. Keep this
    // mounted surface current through the same read-only SDK route.
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 5_000);
    void refresh();
    return () => { abort.abort(); clearInterval(timer); unsubscribe(); };
  }, [sdk, threadId, taskId, revision]);
  return state;
}

export function NativeReviewPolicyLine({ policy }: { policy: NativeReviewState | null }) {
  if (!policy || policy.state === "reviewed") return null;
  const reviewer = policy.reviewer === "none" ? "No automatic review" : policy.reviewer === "codex" ? "Codex" : "Claude";
  return <p role="status" className="boat-native-review-policy" data-state={policy.state}><strong>Reviewer: {reviewer}</strong><span>{policy.message}</span></p>;
}
export function nativeReviewPending(policy: NativeReviewState | null): boolean {
  return !!policy && ["waiting", "starting", "reviewing", "failed", "outdated"].includes(policy.state);
}
