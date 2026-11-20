import { toast } from "sonner";
import { useState } from "react";
import { experimental_useRpcMutation } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../contract";
import { UNSAFE_DELETE_WARNING } from "../credential-warnings";
import { Button } from "../components/ui/button";
import { ConfirmDialog } from "./dialogs";

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
      description={<><EmergencyDeleteWarning acknowledged={acknowledged} onChange={setAcknowledged}/>{failure && <span role="alert" className="mt-2 block text-destructive">{failure}</span>}</>} />
  </>;
}
