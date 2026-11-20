import type { ReactNode } from "react";
import { CLEANUP_NOTICE_PREFIX } from "../credential-warnings";
import { DismissTokenRevocationButton, EmergencyMacDeleteButton } from "./mac-cleanup-actions";
import type { MacUsageDto } from "../contract-providers";

type Notice = NonNullable<MacUsageDto["notices"]>[number];
/** Shared presentation also used by the static preview. */
export function MacLeaseNotice({ notice, action }: { notice: Notice; action?: ReactNode }) {
  return <div className="rounded-[10px] border border-border bg-card px-3.5 py-3 text-[13px] leading-5">
    <p className="font-medium text-foreground">{notice.tokenRevocation ? "GitHub token action required" : "Mac lease costs"} · {notice.label}</p>
    <p className="mt-1 text-muted-foreground">{notice.text.replace(/^\[boat\] /,"")}</p>
    <p className="mt-1 text-xs text-muted-foreground">{notice.machineId}{notice.tokenRevocation ? " · Owner action required in GitHub settings" : " · Manage this lease in Sandboxes"}</p>
    {action}
  </div>;
}
/** Compute notices end with the lease. Revocation reminders require owner dismissal. */
export function MacLeaseNotices({ notices }: { notices: MacUsageDto["notices"] }) {
  if (!notices?.length) return null;
  return <section aria-label="Mac lease and credential notices" className="mb-4 space-y-2" role="status">
    {notices.map(notice=><MacLeaseNotice key={notice.id} notice={notice} action={notice.tokenRevocation ? <DismissTokenRevocationButton noticeId={notice.id}/> : notice.provider === "scaleway" && notice.text.startsWith(CLEANUP_NOTICE_PREFIX) ? <EmergencyMacDeleteButton machineId={notice.machineId}/> : null}/>)}
  </section>;
}
