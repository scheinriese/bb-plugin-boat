import { toast } from "sonner";
import { useState } from "react";
import { experimental_useRpcMutation, experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../contract";
import { UNSAFE_DELETE_WARNING } from "../credential-warnings";
import { Button } from "../components/ui/button";
import { ConfirmDialog } from "./dialogs";

export function CredentialApprovalInstructions({ sentence, threadIds }: { sentence: string; threadIds: string[] }) {
  return <span className="block space-y-2">
    <span className="block">Owner approval in chat is required. Type this exact sentence in {threadIds.length ? `the orchestrator chat (${threadIds.join(", ")})` : "an orchestrator chat after starting one"}, then retry here within 30 minutes:</span>
    <code className="block select-text break-words rounded border border-border p-2 text-xs">{sentence}</code>
    <span className="block">Page confirmations and agent messages do not supply owner approval.</span>
  </span>;
}

function CredentialApproval({ action, id }: { action: "delete-without-cleanup" | "dismiss-token-reminder"; id: string }) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "credentialOwnerApproval", input: { action, id } });
  return query.data ? <CredentialApprovalInstructions {...query.data}/> : <span className="block">{query.error ? "Could not load owner approval instructions. Close this dialog and retry." : "Loading owner approval instructions…"}</span>;
}

export function EmergencyDeleteWarning({ acknowledged, onChange }: { acknowledged: boolean; onChange(value: boolean): void }) {
  return <span className="block space-y-3">
    <span className="block">{UNSAFE_DELETE_WARNING}</span>
    <label className="flex items-start gap-2"><input type="checkbox" checked={acknowledged} onChange={event=>onChange(event.target.checked)} />I understand that I must revoke or rotate the GitHub token after deletion.</label>
  </span>;
}

export function EmergencyMacDeleteButton({ machineId }: { machineId: string }) {
  const [open, setOpen] = useState(false), [acknowledged, setAcknowledged] = useState(false), [failure, setFailure] = useState<string | null>(null);
  const mutation = experimental_useRpcMutation({ contract: rpcContract, method: "sandboxAction" });
  async function run() {
    if (!acknowledged) return;
    setFailure(null);
    try {
      await mutation.mutate({ id: machineId, action: "delete", withoutVerifiedCleanup: true, confirmRevokeGithubToken: true });
      setOpen(false);
      toast.warning("Mac deleted without verified cleanup. Revoke or rotate the GitHub token now.");
    } catch (error) { setFailure(error instanceof Error ? error.message : "Deletion failed. The token still needs revocation."); }
  }
  return <>
    <Button type="button" size="sm" variant="outline" className="mt-2 text-destructive" onClick={()=>{setAcknowledged(false);setFailure(null);setOpen(true);}}>Delete without verified cleanup</Button>
    <ConfirmDialog open={open} onOpenChange={setOpen} title={`Delete ${machineId} without cleanup?`} confirmLabel="Delete without cleanup" destructive confirmDisabled={!acknowledged} pending={mutation.isPending} onConfirm={()=>void run()}
      description={<><CredentialApproval action="delete-without-cleanup" id={machineId}/><EmergencyDeleteWarning acknowledged={acknowledged} onChange={setAcknowledged}/>{failure && <span role="alert" className="mt-2 block text-destructive">{failure}</span>}</>} />
  </>;
}


export function TokenRevocationDismissWarning() {
  return <span>This only dismisses the reminder. Revoke or rotate the GitHub token in GitHub settings first; deletion did not revoke it and a copy may still be on the returned Mac.</span>;
}

export function DismissTokenRevocationButton({ noticeId }: { noticeId: string }) {
  const [open, setOpen] = useState(false), [failure, setFailure] = useState<string | null>(null);
  const mutation = experimental_useRpcMutation({ contract: rpcContract, method: "dismissCredentialNotice" });
  async function dismiss() {
    setFailure(null);
    try { await mutation.mutate({ id: noticeId, confirmedTokenAction: true }); setOpen(false); }
    catch (error) { setFailure(error instanceof Error ? error.message : "Could not dismiss this reminder."); }
  }
  return <>
    <Button type="button" size="sm" variant="outline" className="mt-2" onClick={()=>{setFailure(null);setOpen(true);}}>Dismiss token reminder</Button>
    <ConfirmDialog open={open} onOpenChange={setOpen} title="Have you revoked or rotated the GitHub token?" confirmLabel="I have taken action — dismiss reminder" pending={mutation.isPending} onConfirm={()=>void dismiss()}
      description={<><TokenRevocationDismissWarning/><CredentialApproval action="dismiss-token-reminder" id={noticeId}/>{failure && <span role="alert" className="mt-2 block text-destructive">{failure}</span>}</>}/>
  </>;
}
