import { useMemo } from "react";
import { type ExperimentalSidebarFooterDisclosureProps, type PluginAppBuilder, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import { canResumeSandbox, isSandboxActive, PANEL_PATH } from "./format";
import { useOverview, useSandboxes, useSetup } from "./hooks";
import { SandboxActionButton, sandboxFailure, useSandboxTasks } from "./sandboxes-table";
import { SailIcon } from "./ui";

export function registerBoatFooter(app: PluginAppBuilder): void {
  app.experimental_icons.register({ name: "boat-footer", component: BoatFooterIcon });
  app.experimental_sidebarFooter.register({ kind: "disclosure", id: "cloud-sandboxes", label: "Cloud sandboxes", icon: "boat-footer", component: BoatFooter });
}

/** A registered SDK icon can carry the exception dot without editing host DOM. */
function BoatFooterIcon({ className }: { className?: string }) {
  const sandboxes = useSandboxes();
  const tasks = useSandboxTasks();
  const broken = sandboxes.data?.sandboxes.some((sandbox) => sandboxFailure(sandbox, tasks.data?.tasks ?? []));
  return <span className="relative inline-flex"><SailIcon className={className} />{broken && <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-[#E06C6C]" />}</span>;
}

export function BoatFooter({ dismiss }: ExperimentalSidebarFooterDisclosureProps) {
  const overview = useOverview();
  const sandboxes = useSandboxes();
  const setup = useSetup();
  const tasks = useSandboxTasks();
  const navigate = useBbNavigate();
  const exceptions = useMemo(() => (sandboxes.data?.sandboxes ?? []).flatMap((sandbox) => {
    const failure = sandboxFailure(sandbox, tasks.data?.tasks ?? []);
    return failure ? [{ sandbox, ...failure }] : [];
  }), [sandboxes.data, tasks.data]);
  const count = overview.data && !overview.data.boatError ? overview.data.activeSandboxes : null;
  const cap = overview.data?.cap ?? null;
  const planHours = setup.data?.plan?.vmHoursRemaining;
  const working = sandboxes.data?.sandboxes.filter((sandbox) => ["running", "starting", "provisioned", "cloning"].includes(sandbox.state)).length;
  const idle = sandboxes.data?.sandboxes.filter((sandbox) => isSandboxActive(sandbox.state) && !["running", "starting", "provisioned", "cloning"].includes(sandbox.state)).length;
  function allSandboxes() { navigate.toPluginPanel(PANEL_PATH, { subPath: "sandboxes" }); dismiss(); }
  return <section className="w-[298px] max-w-[calc(100vw-24px)] space-y-3 p-3.5 text-xs" aria-label="Cloud sandboxes">
    <h2 className="text-[13px] font-semibold text-foreground">Cloud sandboxes</h2>
    <Meter label="Sandboxes on" value={count === null ? "Unavailable" : `${count}${cap === null ? "" : ` of ${cap}`}`} fraction={count !== null && cap !== null && cap > 0 ? count / cap : null}
      detail={typeof working === "number" && typeof idle === "number" ? `${working} working · ${idle} idle` : null} />
    <Meter label="Plan hours left" value={typeof planHours === "number" ? `${planHours.toLocaleString(undefined, { maximumFractionDigits: 1 })} h` : "Unavailable"}
      fraction={null} detail={typeof planHours === "number" ? "Plan total and reset date unavailable" : null} />
    <Meter label="Today's cost" value="Unavailable" fraction={null} />
    {exceptions.length > 0 && <div className="space-y-2 border-t border-border pt-3">
      <h3 className="text-[11px] text-muted-foreground">Stopped with an error</h3>
      <ul className="max-h-52 space-y-3 overflow-y-auto">{exceptions.map(({ sandbox, task, reason }) => <li key={sandbox.id} className="flex items-start gap-2">
        <Icon name="CircleAlert" className="mt-0.5 size-3.5 shrink-0 text-[#E06C6C]" aria-hidden />
        <div className="min-w-0 flex-1"><p className="line-clamp-1 text-[13px] text-foreground">{task?.title || sandbox.name || "Sandbox"}</p><p className="line-clamp-2 text-[11px] text-[#E06C6C]">{reason}</p></div>
        {canResumeSandbox(sandbox.state) && <SandboxActionButton sandbox={sandbox} action="resume" compact />}
      </li>)}</ul>
    </div>}
    {(overview.error || overview.data?.boatError || sandboxes.error || sandboxes.data?.error) && <p role="status" className="text-[11px] text-[#E06C6C]">Some sandbox information is unavailable. Open all sandboxes to try again.</p>}
    <div className="flex justify-end"><Button size="sm" variant="ghost" className="h-7 px-0 text-xs text-[#7AA7FF]" onClick={allSandboxes}>All sandboxes →</Button></div>
  </section>;
}

function Meter({ label, value, detail, fraction }: { label: string; value: string; detail?: string | null; fraction: number | null }) {
  return <div className="space-y-1.5">
    <div className="flex items-baseline justify-between gap-3"><span className="text-muted-foreground">{label}</span><span className="text-[13px] font-medium tabular-nums text-foreground">{value}</span></div>
    <div className="h-1 overflow-hidden rounded-sm bg-muted" aria-hidden="true">{fraction !== null && <div className="h-full rounded-sm bg-foreground/75" style={{ width: `${Math.max(0, Math.min(1, fraction)) * 100}%` }} />}</div>
    {detail && <p className="text-[11px] text-muted-foreground">{detail}</p>}
  </div>;
}
