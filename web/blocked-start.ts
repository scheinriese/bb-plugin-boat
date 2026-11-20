import { rpcErrorInfo } from "../contract.ts";

/** A form keeps one request lineage while its input is unchanged. All submit
 * paths share this, including Enter, the primary button and the error card. */
export function createBlockedStart() {
  let blocked: { key: string; taskId: string } | null = null;
  let pending: { key: string; promise: Promise<unknown> } | null = null;
  return function submit<Input, Result>(request: Input, start: (input: Input) => Promise<Result>, retry: (taskId: string) => Promise<Result>): Promise<Result> {
    const key = JSON.stringify(request);
    if (pending?.key === key) return pending.promise as Promise<Result>;
    const run = async () => {
      try {
        const result = await (blocked?.key === key ? retry(blocked.taskId) : start(request));
        blocked = null;
        return result;
      } catch (error) {
        const taskId = rpcErrorInfo(error).taskId;
        if (taskId) blocked = { key, taskId };
        throw error;
      }
    };
    const promise = run();
    pending = { key, promise };
    void promise.finally(() => { if (pending?.promise === promise) pending = null; }).catch(() => {});
    return promise;
  };
}
