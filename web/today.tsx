// Cloud agents Today: live work first, with a bounded, honest recent timeline.
import { useMemo, useState } from "react";
import {
  experimental_useRpcQuery,
  experimental_useRpcMutation,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { rpcContract, type DecisionDto, type TaskDto } from "../contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  CARD_TONES,
  cardStatus,
  recommendedOption,
  queueDelivery,
} from "./cards-logic";
import { NewOrchestratorDialog } from "./dialogs";
import { PANEL_PATH, PROVIDER_SHORT, relativeTime } from "./format";
import {
  useBoard,
  useCloudAgentsNavigation,
  useNow,
  useOrchestrators,
  useOverview,
  useProjects,
  useRelay,
  useSetup,
} from "./hooks";
import { openBoatChat } from "./overview";
import { SetupCard, SetupWarnings } from "./setup";
import { EmptyBox, InlineAlert, ThreadName } from "./ui";

const HISTORY = { statuses: null, threadId: null, limit: 500 } as const;
const weekStart = (now: number) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
};

export function Today() {
  const board = useBoard(null);
  const overview = useOverview();
  const setup = useSetup();
  const history = experimental_useRpcQuery({
    contract: rpcContract,
    method: "tasks",
    input: HISTORY,
  });
  const orchestrators = useOrchestrators();
  const projects = useProjects();
  const relay = useRelay();
  const navigate = useBbNavigate();
  const { openTask } = useCloudAgentsNavigation();
  const now = useNow();
  const [newOrchestrator, setNewOrchestrator] = useState(false);
  const [filter, setFilter] = useState<"all" | "ready" | "working">("all");
  const data = board.data;
  const open = data
    ? [...data.ready, ...data.running].filter((t) => t.role !== "review")
    : [];
  const grouped = useMemo(() => {
    const groups = new Map<string, TaskDto[]>();
    for (const task of open) {
      if (filter === "ready" && !data?.ready.some((t) => t.id === task.id))
        continue;
      if (
        filter === "working" &&
        !["running", "starting"].includes(task.status)
      )
        continue;
      const key = task.orchestratorThreadId ?? "one-off";
      groups.set(key, [...(groups.get(key) ?? []), task]);
    }
    return [...groups];
  }, [data, filter]);
  const recent = history.data?.tasks ?? [];
  const shipped = recent.filter(
    (t) =>
      t.role !== "review" &&
      t.status === "done" &&
      Date.parse(t.finishedAt ?? t.updatedAt) >= weekStart(now),
  );
  const broken =
    data?.running.filter((t) => cardStatus(t).status === "broken") ?? [];
  const needsCount =
    (data?.needsYou.length ?? 0) +
    broken.filter((t) => cardStatus(t).needsYou).length;
  const timeline = [...recent]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 16);
  const hasWork = recent.length > 0 || open.length > 0;
  const projectName = (id: string | null) =>
    projects.data?.projects.find((p) => p.id === id)?.name;
  const openChat = (task: TaskDto) =>
    task.threadId ? navigate.toThread(task.threadId) : openTask(task.id);

  if (!data)
    return (
      <div className="py-6">
        {board.error ? (
          <InlineAlert>{board.error.message}</InlineAlert>
        ) : (
          <EmptyBox>Loading work…</EmptyBox>
        )}
      </div>
    );
  if (setup.data?.ok === false && !hasWork)
    return (
      <div className="py-6">
        <SetupCard />
      </div>
    );
  return (
    <div className="space-y-7 pb-10 pt-4">
      <div
        className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground"
        aria-label="Work counts"
      >
        <span className="text-[#F0B135]">● {needsCount} need you</span>
        <span className="text-[#5BD08A]">● {data.ready.length} ready</span>
        <span>
          {
            data.running.filter((t) =>
              ["running", "starting"].includes(t.status),
            ).length
          }{" "}
          in progress
        </span>
        <span>
          {shipped.length}
          {recent.length === 500 ? "+" : ""} shipped this week
        </span>
      </div>
      <SetupWarnings />
      {!hasWork ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Start here</h2>
          <p className="text-sm text-muted-foreground">
            Give a cloud agent one task, or let an orchestrator coordinate a
            project.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Starter
              icon="ComputerCloud"
              title="Start a task"
              detail="One task in its own sandbox."
              onClick={() => openBoatChat(navigate)}
            />
            <Starter
              icon="FolderGit"
              title="Add a project"
              detail="Choose a repo and its rules."
              onClick={() =>
                navigate.toPluginPanel(PANEL_PATH, { subPath: "projects" })
              }
            />
            <Starter
              icon="Workflow"
              title="Start an orchestrator"
              detail="Plan and coordinate a project."
              onClick={() => setNewOrchestrator(true)}
            />
          </div>
        </section>
      ) : (
        <div className="grid items-start gap-9 xl:grid-cols-[minmax(0,1fr)_280px]">
          <div className="min-w-0 space-y-7">
            {needsCount > 0 || broken.length > 0 ? (
              <section className="space-y-3">
                <h2 className="text-sm font-medium">Start here</h2>
                <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                  {data.needsYou.map((decision) => (
                    <StartDecision key={decision.id} decision={decision} />
                  ))}
                </div>
                {broken.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => openChat(task)}
                    className="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left hover:bg-state-hover"
                  >
                    <span className="text-[#E06C6C]" aria-hidden>
                      ●
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm">{task.title}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {task.error ||
                          "The task stopped. Open the chat to continue."}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-[#7AA7FF]">
                      Open chat
                    </span>
                  </button>
                ))}
              </section>
            ) : null}
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-medium">Running now</h2>
                <span className="text-xs text-muted-foreground">
                  {overview.data?.activeSandboxes ?? "…"}
                  {overview.data?.cap ? ` of ${overview.data.cap}` : ""}{" "}
                  sandboxes on
                </span>
              </div>
              <div className="flex gap-1" role="group" aria-label="Filter work">
                {(
                  [
                    ["all", "All work"],
                    ["ready", "Ready"],
                    ["working", "Working"],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    size="sm"
                    variant="ghost"
                    aria-pressed={filter === value}
                    className={cn(
                      "h-7 text-xs",
                      filter === value && "bg-secondary",
                    )}
                    onClick={() => setFilter(value)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <div className="divide-y divide-border rounded-lg border border-border bg-card">
                {grouped.map(([threadId, tasks]) => {
                  const entry = orchestrators.data?.orchestrators.find(
                    (o) => o.threadId === threadId,
                  );
                  return (
                    <div key={threadId} className="space-y-3 px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        {threadId === "one-off" ? (
                          <span>Tasks</span>
                        ) : (
                          <ThreadName threadId={threadId} />
                        )}
                        {entry?.projectId ? (
                          <span className="text-xs text-muted-foreground">
                            {projectName(entry.projectId)}
                          </span>
                        ) : null}
                        <span className="ml-auto text-xs text-muted-foreground">
                          {tasks.length} open
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {tasks.map((task) => (
                          <button
                            key={task.id}
                            type="button"
                            onClick={() => openChat(task)}
                            className="inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-background/40 px-2 py-1 text-xs hover:bg-state-hover"
                          >
                            <Icon
                              name={task.role === "review" ? "Eye" : "Code"}
                              className="size-3 shrink-0 text-muted-foreground"
                            />
                            <span className="truncate">{task.title}</span>
                            <span
                              className={cn(
                                "shrink-0",
                                CARD_TONES[cardStatus(task).tone],
                              )}
                            >
                              {cardStatus(task).label.toLowerCase()}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {grouped.length === 0 ? (
                  <p className="px-4 py-5 text-sm text-muted-foreground">
                    No {filter === "all" ? "open" : filter} work. Start a task
                    from New thread.
                  </p>
                ) : null}
              </div>
            </section>
            <section className="space-y-3">
              <h2 className="text-sm font-medium">Timeline</h2>
              <p className="text-xs text-muted-foreground">
                Latest update from each recent task
              </p>
              <ol className="space-y-4">
                {timeline.map((task) => (
                  <li key={task.id} className="flex items-start gap-3 text-sm">
                    <span className="w-16 shrink-0 pt-0.5 text-right text-xs text-muted-foreground">
                      {relativeTime(task.updatedAt, now)}
                    </span>
                    <span
                      className={cn(
                        "pt-0.5",
                        task.status === "done"
                          ? "text-[#5BD08A]"
                          : task.status === "failed"
                            ? "text-[#E06C6C]"
                            : "text-muted-foreground",
                      )}
                      aria-hidden
                    >
                      ●
                    </span>
                    <button
                      type="button"
                      onClick={() => openChat(task)}
                      className="min-w-0 text-left hover:underline"
                    >
                      <span>
                        {task.status === "done"
                          ? task.role === "review"
                            ? "Review finished: "
                            : "Shipped: "
                          : task.status === "failed"
                            ? "Broken: "
                            : ""}
                        {task.title}
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {projectName(task.projectId) ??
                          task.repo ??
                          "One-off task"}{" "}
                        · {PROVIDER_SHORT[task.provider]}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          </div>
          <aside className="space-y-3">
            <h2 className="text-sm font-medium">This week</h2>
            <div className="space-y-5 rounded-lg border border-border bg-card p-4">
              <div>
                <span className="text-3xl font-medium text-[#5BD08A]">
                  {shipped.length}
                  {recent.length === 500 ? "+" : ""}
                </span>
                <span className="ml-2 text-xs text-muted-foreground">
                  shipped
                </span>
              </div>
              <div
                className="flex h-16 items-end gap-2"
                aria-label="Shipped tasks per day"
              >
                {Array.from({ length: 7 }, (_, i) => {
                  const start = weekStart(now) + i * 86400000;
                  const count = shipped.filter((t) => {
                    const at = Date.parse(t.finishedAt ?? t.updatedAt);
                    return at >= start && at < start + 86400000;
                  }).length;
                  return (
                    <div
                      key={i}
                      className="flex h-full flex-1 flex-col justify-end gap-2 text-center"
                    >
                      <div
                        className="min-h-1 rounded-sm bg-[#5BD08A]/50"
                        style={{
                          height: `${Math.max(3, (count / Math.max(1, shipped.length)) * 48)}px`,
                        }}
                        title={`${count} shipped`}
                      />
                      <span className="text-[11px] text-muted-foreground">
                        {["M", "T", "W", "T", "F", "S", "S"][i]}
                      </span>
                    </div>
                  );
                })}
              </div>
              <dl className="space-y-2 border-t border-border pt-3 text-xs text-muted-foreground">
                {relay.data?.agents.map((q) =>
                  q.usedPercent !== null ? (
                    <div
                      key={q.provider}
                      className="flex justify-between gap-2"
                    >
                      <dt>{PROVIDER_SHORT[q.provider]}</dt>
                      <dd>
                        {Math.round(q.usedPercent)}% ·{" "}
                        {q.window || "usage limit"}
                      </dd>
                    </div>
                  ) : null,
                )}
                <div className="flex justify-between">
                  <dt>Reviews</dt>
                  <dd>
                    {
                      recent.filter(
                        (t) =>
                          t.role === "review" &&
                          Date.parse(t.updatedAt) >= weekStart(now),
                      ).length
                    }{" "}
                    recent
                  </dd>
                </div>
              </dl>
              {recent.length === 500 ? (
                <p className="text-xs text-muted-foreground">
                  Counts cover the latest 500 tasks.
                </p>
              ) : null}
            </div>
          </aside>
        </div>
      )}
      <NewOrchestratorDialog
        open={newOrchestrator}
        onOpenChange={setNewOrchestrator}
      />
    </div>
  );
}
function Starter({
  icon,
  title,
  detail,
  onClick,
}: {
  icon: string;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="space-y-2 rounded-lg border border-border bg-card p-4 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon name={icon} className="size-4 text-muted-foreground" />
      <span className="block text-sm font-medium">{title}</span>
      <span className="block text-xs text-muted-foreground">{detail}</span>
    </button>
  );
}

function StartDecision({ decision }: { decision: DecisionDto }) {
  const send = experimental_useRpcMutation({
    contract: rpcContract,
    method: "answerDecision",
  });
  const navigate = useBbNavigate();
  const [pending, setPending] = useState(false);
  const option = recommendedOption(decision.options, decision.recommendation);
  const choose = () => {
    if (pending) return;
    setPending(true);
    const cancel = queueDelivery(async () => {
      try {
        await send.mutate({ id: decision.id, accept: true, answer: null });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setPending(false);
      }
    });
    toast("Answer queued", {
      duration: 4000,
      action: {
        label: "Undo",
        onClick: () => {
          if (cancel()) setPending(false);
        },
      },
    });
  };
  return (
    <div className="flex flex-col gap-2 px-3.5 py-3 sm:flex-row sm:items-center">
      <span
        className="hidden size-1.5 shrink-0 rounded-full bg-[#F0B135] sm:inline"
        aria-hidden
      />
      <button
        type="button"
        className="min-w-0 flex-1 text-left hover:underline"
        onClick={() =>
          decision.orchestratorThreadId &&
          navigate.toThread(decision.orchestratorThreadId)
        }
      >
        <span className="block text-[13px]">{decision.question}</span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {option ? `Recommended: ${option}` : decision.recommendation}
        </span>
      </button>
      <Button
        type="button"
        size="sm"
        className="h-auto min-h-7 max-w-full shrink-0 self-start whitespace-normal text-left text-xs sm:max-w-56"
        disabled={pending}
        onClick={choose}
      >
        {pending
          ? "Queued…"
          : option
            ? `Go with ${option}`
            : "Go with recommendation"}
      </Button>
    </div>
  );
}
