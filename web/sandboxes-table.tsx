import { useMemo, useState } from "react";
import { UrlLink, experimental_useRpcMutation, experimental_useRpcQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { rpcContract, type SandboxDto, type TaskDto } from "../contract";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import { cn } from "../lib/utils";
import { cardStatus, CARD_TONES } from "./cards-logic";
import { ConfirmDialog } from "./dialogs";
import { canResumeSandbox, canStopSandbox, isSandboxActive, PANEL_PATH, stopsIn } from "./format";
import { useCloudAgentsNavigation, useNow, useOverview, useSandboxes, useSetup, useTask } from "./hooks";
import { ResizeDialog } from "./sandbox-size";
import { EmptyBox, InlineAlert, ThreadLink, showError } from "./ui";
import { sandboxFailure, sandboxPrimaryTask } from "./sandboxes-logic";
export { sandboxFailure } from "./sandboxes-logic";

export type SandboxAction = "resume" | "stop" | "delete";

/** All table/footer mutations keep the service's sharing and unshipped-work checks. */
export function SandboxActionButton({ sandbox, action, compact = false }: { sandbox: SandboxDto; action: SandboxAction; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const mutation = experimental_useRpcMutation({ contract: rpcContract, method: "sandboxAction" });
  const [failure, setFailure] = useState<string | null>(null);
  const label = sandbox.name || sandbox.uses.find((use) => use.open)?.title || "sandbox";
  const actionLabel = { resume: "Resume", stop: "Stop", delete: "Delete" }[action];
  const users = sandbox.uses.filter((use) => use.open);
  const descriptions = {
    resume: "Start this sandbox again. Running time counts toward your plan and may incur additional usage charges.",
    stop: "Stop running processes in this sandbox. Its files stay; any chat or task using it loses its connection until it resumes.",
    delete: "Permanently delete this sandbox and its files. Unpushed work is lost. Every chat or task using it loses its workspace.",
  };
  async function run() {
    setFailure(null);
    try { await mutation.mutate({ id: sandbox.id, action }); setOpen(false); }
    catch (reason) { setFailure(reason instanceof Error ? reason.message : "Couldn't complete this action. Try again."); showError(reason); }
  }
  return <>
    <Button type="button" size="sm" variant="outline" className={cn("h-7 text-xs", compact && "px-2", action === "delete" && "border-[#E06C6C]/25 text-[#E06C6C]")}
      aria-label={`${actionLabel} ${label}`} disabled={mutation.isPending} onClick={() => { setFailure(null); setOpen(true); }}>{actionLabel}</Button>
    <ConfirmDialog open={open} onOpenChange={setOpen} title={`${actionLabel} ${label}?`} confirmLabel={`${actionLabel} sandbox`}
      description={<><span>{descriptions[action]}</span>{users.length > 0 && <span className="mt-2 block">Used by {users.map((use) => use.title || (use.kind === "task" ? "a task" : "a chat")).join(", ")}.</span>}{failure && <span className="mt-2 block text-[#E06C6C]" role="alert">{failure}</span>}</>}
      destructive={action === "delete"} pending={mutation.isPending} onConfirm={() => void run()} />
  </>;
}

export function useSandboxTasks() {
  return experimental_useRpcQuery({ contract: rpcContract, method: "tasks", input: { statuses: null, threadId: null, limit: 500 } });
}

export function SandboxTable() {
  const sandboxes = useSandboxes();
  const tasks = useSandboxTasks();
  const overview = useOverview();
  const setup = useSetup();
  const navigate = useBbNavigate();
  const now = useNow();
  const sorted = useMemo(() => [...(sandboxes.data?.sandboxes ?? [])].sort((a, b) => Number(isSandboxActive(b.state)) - Number(isSandboxActive(a.state)) || (a.name || a.id).localeCompare(b.name || b.id)), [sandboxes.data]);
  const failure = sandboxes.error?.message || sandboxes.data?.error;
  const hours = setup.data?.plan?.vmHoursRemaining;
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
      <Icon name="boat-sail" fallback="ComputerCloud" className="size-3.5" aria-hidden />
      {setup.data?.plan?.name && <span className="text-foreground">{setup.data.plan.name} plan</span>}
      <span>{overview.data && !overview.data.boatError ? `${overview.data.activeSandboxes}${overview.data.cap === null ? "" : ` of ${overview.data.cap}`} sandboxes on` : "Sandbox count unavailable"}</span>
      <span>{typeof hours === "number" ? `${hours.toLocaleString(undefined, { maximumFractionDigits: 1 })} h left on plan` : "Plan hours unavailable"}</span>
      <Button variant="ghost" size="sm" className="ml-auto h-7 text-xs text-[#7AA7FF]" onClick={() => void sandboxes.refetch()} disabled={sandboxes.isFetching}>Refresh</Button>
    </div>
    {failure && <InlineAlert>{failure}</InlineAlert>}
    {tasks.error && <InlineAlert>Task details are unavailable: {tasks.error.message}</InlineAlert>}
    {!sandboxes.data && !failure ? <EmptyBox>Loading sandboxes…</EmptyBox> : sorted.length === 0 && !failure ? <EmptyBox>No sandboxes yet. Start a task to create one.</EmptyBox> : sorted.length > 0 && <div className="overflow-x-auto overscroll-x-contain rounded-lg focus-visible:outline-2 focus-visible:outline-ring" tabIndex={0} role="region" aria-label="Sandboxes table, scroll horizontally for all actions">
      <table className="w-full min-w-[700px] border-collapse text-left text-[13px]">
        <caption className="sr-only">Cloud sandboxes and the chats that use them</caption>
        <thead className="border-b border-border text-xs font-normal text-muted-foreground"><tr>
          <th scope="col" className="w-[36%] px-3 pb-2 font-normal">Chat</th><th scope="col" className="px-3 pb-2 font-normal">Size</th><th scope="col" className="w-[27%] px-3 pb-2 font-normal">State</th><th scope="col" className="px-3 pb-2 font-normal">This week</th><th scope="col" className="pb-2 pr-3 text-right font-normal">Actions</th>
        </tr></thead>
        <tbody className="divide-y divide-border">{sorted.map((sandbox) => <SandboxTableRow key={sandbox.id} sandbox={sandbox} tasks={tasks.data?.tasks ?? []} now={now} />)}</tbody>
      </table>
    </div>}
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-2 text-xs text-muted-foreground">
      <p className="max-w-xl">Stopped sandboxes keep their files. Deleting a sandbox removes its files permanently.</p>
      <p>Weekly hours and cost unavailable</p>
    </div>
    {overview.data?.boatError && <InlineAlert>{overview.data.boatError}</InlineAlert>}
    <button type="button" className="text-xs text-[#7AA7FF] hover:underline" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "" })}>Back to today</button>
  </div>;
}

function SandboxTableRow({ sandbox, tasks, now }: { sandbox: SandboxDto; tasks: readonly TaskDto[]; now: number }) {
  const task = sandboxPrimaryTask(sandbox, tasks);
  const detail = useTask(task?.id ?? null);
  const { openTask } = useCloudAgentsNavigation();
  const [resize, setResize] = useState(false);
  const use = sandbox.uses.find((item) => item.open) ?? sandbox.uses[0];
  const title = task?.title || use?.title || sandbox.name || sandbox.id;
  const state = task ? cardStatus(task) : null;
  const failure = sandboxFailure(sandbox, tasks);
  const stopped = canResumeSandbox(sandbox.state);
  const countdown = isSandboxActive(sandbox.state) ? stopsIn(sandbox.archiveAfter, now) : null;
  const label = failure ? "Broken" : stopped ? "Stopped" : state?.label ?? (sandbox.state === "idle" || sandbox.state === "ready" ? "Idle" : sandbox.state);
  const tone = failure ? "text-[#E06C6C]" : stopped ? "text-muted-foreground" : state ? CARD_TONES[state.tone] : "text-muted-foreground";
  const memory = detail.data?.task?.memory;
  return <tr className="group hover:bg-state-hover">
    <th scope="row" className="px-3 py-3 text-left font-normal">
      <div className="space-y-0.5">
        {task ? <button type="button" className="line-clamp-1 text-left hover:underline" onClick={() => openTask(task.id)}>{title}</button> : use && use.kind !== "task" ? <ThreadLink threadId={use.id} label={title} className="line-clamp-1 text-[13px]" /> : <span>{title}</span>}
        <p className="line-clamp-1 text-xs text-muted-foreground">{task?.source.title || task?.repo || sandbox.name || "Sandbox"}</p>
        {sandbox.uses.filter((item) => item.open).length > 1 && <p className="text-[11px] text-muted-foreground">Shared by {sandbox.uses.filter((item) => item.open).length} chats and tasks</p>}
      </div>
    </th>
    <td className="px-3 py-3 text-xs text-muted-foreground">{memory?.size?.label || "Unavailable"}</td>
    <td className="px-3 py-3"><div className={cn("flex items-start gap-1.5", tone)}><span aria-hidden className={cn("mt-1.5 size-1.5 shrink-0 rounded-full bg-current", !stopped && state?.moving && "motion-safe:animate-pulse")} /><div className="space-y-1 text-xs">
      <p>{label}{!failure && countdown ? ` · ${countdown}` : ""}</p>
      {failure && <p className="line-clamp-2 max-w-64 text-[11px]">{failure.reason}</p>}
      {task?.previewUrl && <UrlLink href={task.previewUrl} className="text-[11px] text-[#7AA7FF]">Preview ↗</UrlLink>}
    </div></div></td>
    <td className="px-3 py-3 text-xs text-muted-foreground">Unavailable</td>
    <td className="py-3 pr-3"><div className="flex flex-wrap justify-end gap-1.5">
      {canStopSandbox(sandbox.state) && <SandboxActionButton sandbox={sandbox} action="stop" compact />}
      {stopped && <SandboxActionButton sandbox={sandbox} action="resume" compact />}
      {failure && memory?.canResize && detail.data?.task && <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setResize(true)}>Larger sandbox…</Button>}
      <SandboxActionButton sandbox={sandbox} action="delete" compact />
    </div>
      {detail.data?.task && <ResizeDialog task={detail.data.task} mode={memory?.oom ? "oom" : "general"} open={resize} onOpenChange={setResize} />}
    </td>
  </tr>;
}
