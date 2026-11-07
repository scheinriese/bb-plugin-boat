import { useMemo, useState } from "react";
import {
  UrlLink,
  experimental_useRpcMutation,
  experimental_useRpcQuery,
  experimental_useSidebarThreads,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { rpcContract, type SandboxDto, type TaskDto } from "../contract";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import { cn } from "../lib/utils";
import { cardStatus } from "./cards-logic";
import { ConfirmDialog } from "./dialogs";
import {
  canResumeSandbox,
  canStopSandbox,
  isSandboxActive,
  PANEL_PATH,
  stopsIn,
} from "./format";
import {
  useCloudAgentsNavigation,
  useNow,
  useOverview,
  useSandboxes,
  useSetup,
  useSettingRows,
  useProjects,
  useTask,
} from "./hooks";
import { ResizeDialog } from "./sandbox-size";
import { AgentLogo, EmptyBox, InlineAlert, showError } from "./ui";
import { sandboxFailure, sandboxPrimaryTask } from "./sandboxes-logic";
export { sandboxFailure } from "./sandboxes-logic";

export type SandboxAction = "resume" | "stop" | "delete";

/** All table/footer mutations keep the service's sharing and unshipped-work checks. */
export function SandboxActionButton({
  sandbox,
  action,
  compact = false,
  onDialogOpenChange,
}: {
  sandbox: SandboxDto;
  action: SandboxAction;
  compact?: boolean;
  onDialogOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpenState] = useState(false);
  const setOpen = (value: boolean) => {
    setOpenState(value);
    onDialogOpenChange?.(value);
  };
  const mutation = experimental_useRpcMutation({
    contract: rpcContract,
    method: "sandboxAction",
  });
  const [failure, setFailure] = useState<string | null>(null);
  const label =
    sandbox.uses.find((use) => use.open)?.title || sandbox.name || "sandbox";
  const actionLabel = { resume: "Resume", stop: "Stop", delete: "Delete" }[
    action
  ];
  const users = sandbox.uses.filter((use) => use.open);
  const descriptions = {
    resume:
      "Start this sandbox again. Running time counts toward your plan and may incur additional usage charges.",
    stop: "Stop running processes in this sandbox. Its files stay; any chat or task using it loses its connection until it resumes.",
    delete:
      "Permanently delete this sandbox and its files. Unpushed work is lost. Every chat or task using it loses its workspace.",
  };
  async function run() {
    setFailure(null);
    try {
      await mutation.mutate({ id: sandbox.id, action });
      setOpen(false);
    } catch (reason) {
      setFailure(
        reason instanceof Error
          ? reason.message
          : "Couldn't complete this action. Try again.",
      );
      showError(reason);
    }
  }
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={cn(
          "h-[26px] border-[color:var(--boat-action-border,var(--border))] text-xs dark:text-[#D0D0D0]",
          compact && "px-2.5",
          action === "delete" &&
            "border-[#E06C6C]/25 text-[#E06C6C] dark:text-[#E06C6C]",
        )}
        aria-label={`${actionLabel} ${label}`}
        disabled={mutation.isPending}
        onClick={() => {
          setFailure(null);
          setOpen(true);
        }}
      >
        {actionLabel}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`${actionLabel} ${label}?`}
        confirmLabel={`${actionLabel} sandbox`}
        description={
          <>
            <span>{descriptions[action]}</span>
            {users.length > 0 && (
              <span className="mt-2 block">
                Used by{" "}
                {users
                  .map(
                    (use) =>
                      use.title || (use.kind === "task" ? "a task" : "a chat"),
                  )
                  .join(", ")}
                .
              </span>
            )}
            {failure && (
              <span className="mt-2 block text-[#E06C6C]" role="alert">
                {failure}
              </span>
            )}
          </>
        }
        destructive={action === "delete"}
        pending={mutation.isPending}
        onConfirm={() => void run()}
      />
    </>
  );
}

export function useSandboxTasks() {
  return experimental_useRpcQuery({
    contract: rpcContract,
    method: "tasks",
    input: { statuses: null, threadId: null, limit: 500 },
  });
}

export function SandboxTable() {
  const sandboxes = useSandboxes();
  const tasks = useSandboxTasks();
  const overview = useOverview();
  const setup = useSetup();
  const projects = useProjects();
  const settings = useSettingRows();
  const now = useNow();
  const usage = experimental_useRpcQuery({
    contract: rpcContract,
    method: "fidelityUsage",
    input: { timezoneOffsetMinutes: new Date().getTimezoneOffset() },
  });
  const sorted = useMemo(() => {
    const priority = (sandbox: SandboxDto) => {
      const task = sandboxPrimaryTask(sandbox, tasks.data?.tasks ?? []);
      const state = task ? cardStatus(task) : null;
      const stopped = canResumeSandbox(sandbox.state);
      if (!stopped && task?.role === "review") return 1;
      if (sandboxFailure(sandbox, tasks.data?.tasks ?? [])) return 2;
      if (!stopped && task?.previewUrl) return state?.moving ? 0 : 3;
      if (!stopped && sandbox.uses.some((use) => use.kind === "orchestrator"))
        return 4;
      if (!stopped && state?.status === "needs-you") return 5;
      if (!stopped) return 0;
      return sandbox.uses.some((use) => use.kind === "orchestrator") ? 7 : 6;
    };
    return [...(sandboxes.data?.sandboxes ?? [])].sort(
      (a, b) => priority(a) - priority(b),
    );
  }, [sandboxes.data, tasks.data]);
  const failure = sandboxes.error?.message || sandboxes.data?.error;
  const hours =
    usage.data?.plan?.hoursRemaining ?? setup.data?.plan?.vmHoursRemaining;
  const idleMinutes = settings.data?.settings.find(
    (setting) => setting.key === "stopIdleAfterMinutes",
  )?.value;
  return (
    <div className="pb-10 dark:[--muted-foreground:#A8A8A8]">
      <div className="mb-[27px] flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] leading-5 text-muted-foreground dark:text-[#C1C1C1]">
        <Icon
          name="boat-sail"
          fallback="ComputerCloud"
          className="size-3.5"
          aria-hidden
        />
        {setup.data?.plan?.name && (
          <>
            <span className="font-medium text-[color:var(--boat-heading)]">
              {setup.data.plan.name} plan
            </span>
            <span aria-hidden>·</span>
          </>
        )}
        {overview.data && !overview.data.boatError && (
          <>
            <span>
              {overview.data.activeSandboxes}
              {overview.data.cap === null
                ? ""
                : ` of ${overview.data.cap}`}{" "}
              sandboxes on
            </span>
            {typeof hours === "number" && <span aria-hidden>·</span>}
          </>
        )}
        {typeof hours === "number" && (
          <span>
            {hours.toLocaleString(undefined, { maximumFractionDigits: 1 })} h
            left this month
          </span>
        )}
        {typeof idleMinutes === "number" && (
          <span className="ml-auto text-xs text-[color:var(--boat-faint)]">
            {idleMinutes > 0
              ? `Idle sandboxes stop after ${idleMinutes % 60 === 0 ? `${idleMinutes / 60} h` : `${idleMinutes} min`}`
              : "Idle sandboxes stay on"}{" "}
            ·{" "}
            <a
              href="/settings/plugins/boat"
              className="text-[#7AA7FF] hover:underline"
            >
              change
            </a>
          </span>
        )}
      </div>
      {failure && <InlineAlert>{failure}</InlineAlert>}
      {tasks.error && <InlineAlert>{tasks.error.message}</InlineAlert>}
      {!sandboxes.data && !failure ? (
        <EmptyBox>Loading sandboxes…</EmptyBox>
      ) : sorted.length === 0 && !failure ? (
        <EmptyBox>No sandboxes yet. Start a task to create one.</EmptyBox>
      ) : (
        sorted.length > 0 && (
          <div
            className="mb-1 overflow-x-auto overscroll-x-contain focus-visible:outline-2 focus-visible:outline-ring"
            tabIndex={0}
            role="region"
            aria-label="Sandboxes table, scroll horizontally for all actions"
          >
            <table className="w-full min-w-[700px] border-collapse text-left text-[13px]">
              <caption className="sr-only">
                Cloud sandboxes and the chats that use them
              </caption>
              <thead className="border-b border-border text-xs font-normal leading-4 text-[color:var(--boat-faint)]">
                <tr className="h-8 [&>th]:py-0">
                  <th
                    scope="col"
                    className="w-[36.5%] px-[14px] pb-2 font-normal"
                  >
                    Chat
                  </th>
                  <th
                    scope="col"
                    className="w-[11%] px-[14px] pb-2 font-normal"
                  >
                    Size
                  </th>
                  <th
                    scope="col"
                    className="w-[23.5%] px-[14px] pb-2 font-normal"
                  >
                    State
                  </th>
                  <th scope="col" className="px-[14px] pb-2 font-normal">
                    This week
                  </th>
                  <th
                    scope="col"
                    className="pb-2 pr-[14px] text-right font-normal"
                  >
                    <span className="sr-only">Sandbox actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {sorted.map((sandbox) => (
                  <SandboxTableRow
                    key={sandbox.id}
                    projects={projects.data?.projects ?? []}
                    sandbox={sandbox}
                    tasks={tasks.data?.tasks ?? []}
                    now={now}
                    hours={
                      usage.data?.sandboxes?.find(
                        (row) => row.sandboxId === sandbox.id,
                      )?.hours
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
      <div className="flex flex-wrap justify-between gap-x-4 gap-y-2 text-xs leading-[18px] text-[color:var(--boat-faint)]">
        <p className="max-w-[620px]">
          Stopped sandboxes keep your work and cost nothing; the next message to
          the chat resumes them. Deleting one removes its files for good.
        </p>
        {usage.data?.week.hours != null && usage.data.week.dollars != null && (
          <p title="Size-weighted machine time and list-price cost of listed sandboxes">
            This week:{" "}
            <span className="text-foreground/75 dark:text-[#C1C1C1]">
              {usage.data.week.hours.toLocaleString(undefined, {
                maximumFractionDigits: 1,
              })}{" "}
              sandbox hours
            </span>
            {" · about "}
            <span className="text-foreground/75 dark:text-[#C1C1C1]">
              ${usage.data.week.dollars.toFixed(2)}
            </span>
          </p>
        )}
      </div>
      {overview.data?.boatError && (
        <InlineAlert>{overview.data.boatError}</InlineAlert>
      )}
    </div>
  );
}

function SandboxTableRow({
  sandbox,
  tasks,
  now,
  hours,
  projects,
}: {
  projects: { name: string; repos: { repo: string }[] }[];
  sandbox: SandboxDto;
  tasks: readonly TaskDto[];
  now: number;
  hours?: number | null;
}) {
  const task = sandboxPrimaryTask(sandbox, tasks);
  const { threads } = experimental_useSidebarThreads();
  const detail = useTask(task?.id ?? null);
  const { openTask } = useCloudAgentsNavigation();
  const navigate = useBbNavigate();
  const [resize, setResize] = useState(false);
  const use = sandbox.uses.find((item) => item.open) ?? sandbox.uses[0];
  const provider =
    task?.provider ??
    threads.find((thread) => thread.id === use?.id)?.providerId;
  const title = task?.title || use?.title || sandbox.name || "Sandbox";
  const state = task ? cardStatus(task) : null;
  const failure = sandboxFailure(sandbox, tasks);
  const stopped = canResumeSandbox(sandbox.state);
  const countdown = isSandboxActive(sandbox.state)
    ? stopsIn(sandbox.archiveAfter, now)
        ?.replace(/(\d+)m\b/g, "$1 min")
        .replace(/(\d+)h\b/g, "$1 h")
    : null;
  const memory = detail.data?.task?.memory;
  const active = !stopped && !failure && !!state?.moving;
  const label = failure
    ? `Stopped · ${failure.reason.toLowerCase()}`
    : stopped
      ? use?.kind === "orchestrator"
        ? "Stopped"
        : "Stopped · nothing lost"
      : task?.role === "review" && active
        ? "Reviewing"
        : active
          ? "Working"
          : state?.status === "needs-you"
            ? "Waiting for you · kept on"
            : `Idle${countdown ? ` · ${countdown}` : ""}`;
  const tone = failure
    ? "text-[#E06C6C]"
    : state?.status === "needs-you" && !stopped
      ? "text-[#F0B135]"
      : active
        ? "text-foreground dark:text-[#D2D2D2]"
        : stopped
          ? "text-muted-foreground dark:text-[#8A8A8A]"
          : "text-muted-foreground dark:text-[#C1C1C1]";
  const projectRepo =
    task?.repo ??
    tasks.find((entry) => entry.orchestratorThreadId === use?.id)?.repo;
  const project =
    projects.find((entry) => entry.repos[0]?.repo === projectRepo)?.name ??
    projects.find((entry) =>
      entry.repos.some((repo) => repo.repo === projectRepo),
    )?.name ??
    projectRepo?.split("/").at(-1) ??
    "";
  const size =
    (sandbox.machineType
      ? sandbox.machineType[0]!.toUpperCase() + sandbox.machineType.slice(1)
      : null) ?? memory?.size?.label;
  return (
    <tr className="group h-[52px] rounded-lg hover:bg-[color:var(--boat-chip)]">
      <th scope="row" className="px-[14px] py-2 text-left font-normal">
        <div className="flex items-center gap-2.5">
          {provider && (
            <AgentLogo
              provider={provider.includes("codex") ? "codex" : "claude"}
              className="size-3.5"
            />
          )}
          <div className="min-w-0">
            <div className="text-[13px] leading-[18px] text-[color:var(--boat-label)]">
              {task ? (
                <button
                  type="button"
                  className="line-clamp-1 text-left hover:underline"
                  onClick={() => openTask(task.id)}
                >
                  {task.role === "review"
                    ? `${task.provider === "codex" ? "Codex" : "Claude"} reviewing…`
                    : title}
                </button>
              ) : use && use.kind !== "task" ? (
                <button
                  type="button"
                  className="line-clamp-1 text-left hover:underline"
                  onClick={() => navigate.toThread(use.id)}
                >
                  {title}
                </button>
              ) : (
                <span>{title}</span>
              )}
            </div>
            <p className="line-clamp-1 text-xs leading-4 text-[color:var(--boat-faint)]">
              {project ? project[0]!.toUpperCase() + project.slice(1) : ""}
              {task?.role === "review"
                ? " · review"
                : use?.kind === "orchestrator"
                  ? " · orchestrator"
                  : ""}
            </p>
          </div>
        </div>
      </th>
      <td className="px-[14px] py-2 text-[13px] leading-5 text-muted-foreground">
        {size}
      </td>
      <td className="px-[14px] py-1">
        <div className={cn("flex items-start gap-1.5", tone)}>
          {active && task ? (
            <span className="relative mt-0.5 flex size-4 items-center justify-center">
              <svg
                aria-hidden
                viewBox="0 0 18 18"
                className="absolute size-4 motion-safe:animate-spin"
              >
                <circle
                  cx="9"
                  cy="9"
                  r="8"
                  fill="none"
                  stroke="#2C2C2C"
                  strokeWidth="1.4"
                />
                <path
                  d="M9 1a8 8 0 0 1 8 8"
                  fill="none"
                  stroke={task.provider === "claude" ? "#D97757" : "#BDBDBD"}
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
              <AgentLogo provider={task.provider} className="size-[9px]" />
            </span>
          ) : (
            <span
              aria-hidden
              className={cn(
                "mt-[7px] size-1.5 shrink-0 rounded-full bg-current",
                stopped && !failure && "dark:bg-[#5E5E5E]",
              )}
            />
          )}
          <div className="text-[13px] leading-5">
            <p>{label}</p>
            {task?.previewUrl && !stopped && (
              <UrlLink
                href={task.previewUrl}
                className="-ml-3 mt-1 flex h-4 w-fit rounded bg-[#7AA7FF]/15 px-1.5 py-px text-[11px] leading-[14px] text-[#7AA7FF] dark:bg-[#1E2A3D]"
              >
                Preview live
              </UrlLink>
            )}
          </div>
        </div>
      </td>
      <td className="px-[14px] py-2 text-[13px] leading-5 tabular-nums text-muted-foreground">
        {typeof hours === "number" ? `${hours.toFixed(1)} h` : null}
      </td>
      <td className="py-2 pr-[14px]">
        <div className="flex items-center justify-end gap-1.5">
          {failure && memory?.canResize && detail.data?.task ? (
            <Button
              size="sm"
              className="h-[26px] whitespace-nowrap rounded-md bg-primary px-2.5 text-xs text-primary-foreground hover:bg-primary/90"
              onClick={() => setResize(true)}
            >
              Resume on {memory.next?.label ?? "Large"}
            </Button>
          ) : stopped ? (
            <>
              <span className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 max-md:opacity-100">
                <SandboxActionButton
                  sandbox={sandbox}
                  action="delete"
                  compact
                />
              </span>
              <SandboxActionButton sandbox={sandbox} action="resume" compact />
            </>
          ) : canStopSandbox(sandbox.state) ? (
            <SandboxActionButton sandbox={sandbox} action="stop" compact />
          ) : null}
        </div>
        {detail.data?.task && (
          <ResizeDialog
            task={detail.data.task}
            mode={memory?.oom ? "oom" : "general"}
            open={resize}
            onOpenChange={setResize}
          />
        )}
      </td>
    </tr>
  );
}
