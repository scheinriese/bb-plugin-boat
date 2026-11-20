import { Button } from "../components/ui/button";
import { Switch } from "./ui";

/** Pure controls shared with the local fake-data preview. No provider calls. */
export function ClaudeDesignSetting({ checked, onChange, disabled = false }: { checked: boolean; onChange(value: boolean): void; disabled?: boolean }) {
  return <div className="flex items-start gap-6 px-3.5 py-3"><div className="min-w-0 flex-1"><label htmlFor="boat-prefer-claude-design" className="block text-[13px] leading-[18px] text-[var(--boat-label)]">Prefer Claude for design</label><p className="mt-0.5 text-xs leading-[17px] text-muted-foreground">For tasks explicitly marked Design. Keeps Claude selected through usage pressure; paid usage needs separate approval. Other tasks use normal routing.</p></div><Switch id="boat-prefer-claude-design" aria-label="Prefer Claude for design" checked={checked} disabled={disabled} onCheckedChange={onChange}/></div>;
}

export function DesignPurposeField({ id, value, onChange, preferClaude }: { id: string; value: "design" | null; onChange(value: "design" | null): void; preferClaude: boolean }) {
  return <div className="space-y-1.5"><label htmlFor={id} className="text-sm font-medium">Task purpose</label><select id={id} value={value ?? "general"} onChange={event=>onChange(event.target.value === "design" ? "design" : null)} className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="general">General work</option><option value="design">Design</option></select><p className="text-xs text-muted-foreground">{value === "design" && preferClaude ? "Claude is preferred for this design task. An explicit agent/model choice wins. Paid usage still needs separate approval." : "Purpose is explicit; task titles and briefs do not change provider or payment permission."}</p></div>;
}

export function ClaudeDesignStatus({ preferred, paidApproved, closed = false, onClear, busy = false }: { preferred: boolean; paidApproved: boolean; closed?: boolean; onClear(): void; busy?: boolean }) {
  return <section className="rounded-lg border border-border bg-card px-4 py-3 text-sm" aria-label="Design routing"><p className="font-medium">{preferred ? "Claude preferred for this design task" : "Design task · normal routing"}</p><p className="mt-1 text-xs text-muted-foreground">{paidApproved ? "Paid Claude continuation is separately approved for this task." : "Design preference grants no paid permission. At a limit, this task waits unless a separate paid policy applies."}</p>{preferred && !closed && <Button variant="outline" size="sm" className="mt-2" disabled={busy} onClick={onClear}>Return to normal routing</Button>}{preferred && !closed && <p className="mt-1 text-xs text-muted-foreground">Clears this task’s design preference and revokes its scoped paid continuation.</p>}</section>;
}

export function ClaudePaidStatus({ approved, revoked = false, closed = false, onRevoke, busy = false }: { approved: boolean; revoked?: boolean; closed?: boolean; onRevoke(): void; busy?: boolean }) {
  const active = approved && !revoked && !closed;
  return <section className="rounded-lg border border-border bg-card px-4 py-3 text-sm" aria-label="Claude paid continuation"><p className="font-medium">{active ? "Claude paid continuation approved for this task" : revoked ? "Claude paid continuation revoked" : "Claude paid continuation closed"}</p><p className="mt-1 text-xs text-muted-foreground">{active ? "Future turns and bounded limit recovery stay on Claude and may use paid usage after included allowance. Provider billing controls still apply. This permission covers no other task or review." : "This task’s approval permits no future automatic paid resumes, including global stopped-chat recovery. Already running turns follow the provider’s billing controls."}</p>{active && <Button variant="outline" size="sm" className="mt-2" disabled={busy} onClick={onRevoke}>Revoke Claude paid continuation</Button>}</section>;
}
