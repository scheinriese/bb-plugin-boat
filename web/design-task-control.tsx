import { useState } from "react";
import { experimental_useRpcMutation } from "@get-bb/plugin-sdk/app";
import type { TaskDto } from "../contract";
import { startQueueRpcContract } from "../contract-start-queue";
import { ClaudeDesignStatus, ClaudePaidStatus } from "./claude-design";

/** The native chat and task page expose the same persisted policy and controls. */
export function TaskDesignControl({ task }: { task: TaskDto }) {
  const clear = experimental_useRpcMutation({ contract: startQueueRpcContract, method: "clearDesignClaudePreference" });
  const revoke = experimental_useRpcMutation({ contract: startQueueRpcContract, method: "revokeClaudePaidContinuation" });
  const [error, setError] = useState<string | null>(null);
  const design = task.purpose === "design";
  const paid = task.claudePaidContinuation === true || task.claudePaidContinuationRevoked === true;
  if (!design && !paid) return null;
  const closed = task.status === "done" || task.status === "cancelled";
  const failure = (reason: unknown) => setError(reason instanceof Error ? reason.message : "Couldn’t change this task’s policy.");
  return <div className="space-y-2">{design && <ClaudeDesignStatus preferred={task.designClaudePreference === true} paidApproved={task.claudePaidContinuation === true && task.claudePaidContinuationRevoked !== true} closed={closed} busy={clear.isPending} onClear={()=>{setError(null);void clear.mutate({id:task.id}).catch(failure);}}/>}{paid && <ClaudePaidStatus approved={task.claudePaidContinuation === true} revoked={task.claudePaidContinuationRevoked === true} closed={closed} busy={revoke.isPending} onRevoke={()=>{setError(null);void revoke.mutate({id:task.id}).catch(failure);}}/>}{error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}</div>;
}
