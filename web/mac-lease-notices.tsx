import type { MacUsageDto } from "../contract-providers";

type Notice = NonNullable<MacUsageDto["notices"]>[number];
/** Shared presentation also used by the static preview. */
export function MacLeaseNotice({ notice }: { notice: Notice }) {
  return <div className="rounded-[10px] border border-border bg-card px-3.5 py-3 text-[13px] leading-5">
    <p className="font-medium text-foreground">{notice.tokenRevocation ? "GitHub token action required" : "Mac lease costs"} · {notice.label}</p>
    <p className="mt-1 text-muted-foreground">{notice.text.replace(/^\[boat\] /,"")}</p>
    <p className="mt-1 text-xs text-muted-foreground">{notice.machineId}{notice.tokenRevocation ? " · Owner action required in GitHub settings" : " · Manage this lease in Sandboxes"}</p>
    {notice.tokenRevocation && <p className="mt-1 text-xs text-muted-foreground">{notice.expiresAt ? `Reminder clears after the recorded token expiry: ${notice.expiresAt}.` : "Recorded token expiry is unknown; this reminder cannot clear automatically."}</p>}
  </div>;
}
/** Compute notices end with the lease; token reminders last until recorded expiry. */
export function MacLeaseNotices({ notices }: { notices: MacUsageDto["notices"] }) {
  if (!notices?.length) return null;
  return <section aria-label="Mac lease and credential notices" className="mb-4 space-y-2" role="status">
    {notices.map(notice=><MacLeaseNotice key={notice.id} notice={notice}/>)}
  </section>;
}
