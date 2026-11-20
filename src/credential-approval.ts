import type { BbPluginApi } from "@get-bb/plugin-sdk";

export type CredentialOwnerAction = "delete-without-cleanup" | "dismiss-token-reminder";
export interface CredentialApprovalRequest {
  kind: "credential";
  action: CredentialOwnerAction;
  leaseId: string;
  machineId: string;
  since: number;
  threadIds: string[];
  sentence: string;
}
export type OwnerApproval = { ok: boolean; reason: string };

export function credentialApprovalSentence(action: CredentialOwnerAction, machineId: string, leaseId: string): string {
  return action === "delete-without-cleanup"
    ? `I approve deleting ${machineId} without verified cleanup for lease ${leaseId}. I will revoke or rotate the GitHub token.`
    : `I have revoked or rotated the GitHub token for ${machineId}, lease ${leaseId}. Dismiss its token reminder.`;
}

/** Like ship/discard chat approval, but require an exact, recent owner message
 * for this action and lease. Read core event provenance, never RPC booleans,
 * caller-supplied text, conversation previews or agent/plugin notices. */
export async function credentialChatApproval(bb: Pick<BbPluginApi, "sdk">, threadId: string | null | undefined, request: CredentialApprovalRequest, now = Date.now()): Promise<OwnerApproval> {
  if (!threadId || !request.threadIds.includes(threadId)) return { ok: false, reason: "approval must be in this lease's orchestrator chat" };
  try {
    const result = await bb.sdk.threads.events.list({ threadId, types: ["client/turn/requested"], order: "desc", limit: "100" });
    for (const event of result) {
      const data = event.data as Record<string, unknown>;
      if (event.type !== "client/turn/requested") continue;
      if (data.initiator !== "user" || data.senderThreadId !== null || data.originPluginId != null || data.retryOfRequestId != null) continue;
      // Only the latest owner message can authorize this action; a later
      // correction or withdrawal must not leave an older approval usable.
      if (!Number.isFinite(event.createdAt) || !Number.isFinite(request.since) || event.createdAt < request.since || event.createdAt < now - 30 * 60_000 || event.createdAt > now) break;
      const input = data.input;
      if (!Array.isArray(input) || input.length !== 1) break;
      const part = input[0];
      if (part?.type === "text" && part.visibility !== "agent-only" && part.text?.trim() === request.sentence) return { ok: true, reason: "" };
      break;
    }
  } catch {
    return { ok: false, reason: "could not verify the owner's message in bb's event history" };
  }
  return { ok: false, reason: "the owner must type the exact approval sentence in the orchestrator chat within the last 30 minutes" };
}
