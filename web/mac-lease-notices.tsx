import type { MacUsageDto } from "../contract-providers";

/** Persistent cost notices also reach work started from the page, which has
 * no orchestrator thread. They remain visible until the lease is released. */
export function MacLeaseNotices({ notices }: { notices: MacUsageDto["notices"] }) {
  if (!notices?.length) return null;
  return <section aria-label="Mac lease cost notices" className="mb-4 space-y-2" role="status">
    {notices.map(notice=><div key={notice.id} className="rounded-[10px] border border-border bg-card px-3.5 py-3 text-[13px] leading-5">
      <p className="font-medium text-foreground">Mac lease costs · {notice.label}</p>
      <p className="mt-1 text-muted-foreground">{notice.text.replace(/^\[boat\] /,"")}</p>
      <p className="mt-1 text-xs text-muted-foreground">{notice.machineId} · Manage this lease in Sandboxes</p>
    </div>)}
  </section>;
}
