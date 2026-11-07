// Live events and measured usage; the demo seeds only the backend data.
import { useMemo, useState } from "react";
import {
  experimental_useRpcQuery,
  experimental_useRpcMutation,
  experimental_useSidebarThreads,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import {
  rpcContract,
  normalizeDecisionOptions,
  type DecisionDto,
  type TaskDto,
  type HistoryEventDto,
} from "../contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  attentionCount,
  CARD_TONES,
  cardStatus,
  recommendedOption,
  queueDelivery,
} from "./cards-logic";
import { NewOrchestratorDialog } from "./dialogs";
import { PANEL_PATH, PROVIDER_SHORT } from "./format";
import {
  useBoard,
  useCloudAgentsNavigation,
  useNow,
  useOrchestrators,
  useOverview,
  useProjects,
  useRelay,
  useSetup,
  useTask,
} from "./hooks";
import { openBoatChat } from "./overview";
import { SetupCard } from "./setup";
import { AgentLogo, EmptyBox, InlineAlert, ThreadName } from "./ui";
import { ResizeDialog } from "./sandbox-size";

const weekStart = (now: number) => {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return date.getTime();
};
const HEADING =
  "text-[14px] font-semibold leading-5 text-[color:var(--boat-heading)]";
const SURFACE = "overflow-hidden rounded-[10px] border border-border bg-card";
const countNumber = (n: number) =>
  n.toLocaleString(undefined, { maximumFractionDigits: 1 });
export function Today() {
  const board = useBoard(null);
  const overview = useOverview();
  const setup = useSetup();
  const records = experimental_useRpcQuery({
    contract: rpcContract,
    method: "tasks",
    input: { statuses: null, threadId: null, limit: 500 },
  });
  const events = experimental_useRpcQuery({
    contract: rpcContract,
    method: "history",
    input: { limit: 200 },
  });
  const usage = experimental_useRpcQuery({
    contract: rpcContract,
    method: "fidelityUsage",
    input: { timezoneOffsetMinutes: new Date().getTimezoneOffset() },
  });
  const orchestrators = useOrchestrators();
  const projects = useProjects();
  const relay = useRelay();
  const { threads } = experimental_useSidebarThreads();
  const navigate = useBbNavigate();
  const { openTask } = useCloudAgentsNavigation();
  const now = useNow();
  const [newOrchestrator, setNewOrchestrator] = useState(false);
  const data = board.data;
  const recent = (records.data?.tasks ?? []).filter(
    (task) => !(task.role === "custom" && task.title === "Test task"),
  );
  const byId = new Map(recent.map((task) => [task.id, task]));
  const isProductEvent = (event: HistoryEventDto) =>
    !event.taskId || byId.has(event.taskId);
  const weekEvents = (events.data?.events ?? []).filter(
    (event) =>
      Date.parse(event.at) >= weekStart(now) &&
      Date.parse(event.at) <= now &&
      isProductEvent(event),
  );
  const shippedEvents = weekEvents.filter(
    (event) => event.kind === "shipped" || event.kind === "merged",
  );
  const shipped = [
    ...new Map(
      shippedEvents.map((event) => [event.taskId ?? event.seq, event]),
    ).values(),
  ];
  const today = new Date(now).toDateString();
  const shippedToday = shipped.filter(
    (event) => new Date(event.at).toDateString() === today,
  ).length;
  const reviews = weekEvents.filter((event) => event.kind === "review-verdict");
  const changesRequested = reviews.filter(
    (event) => event.review?.verdict === "changes-requested",
  ).length;
  const open = data
    ? [...data.ready, ...data.running].filter(
        (task) =>
          task.role !== "review" &&
          !(task.role === "custom" && task.title === "Test task"),
      )
    : [];
  const grouped = useMemo(() => {
    const groups = new Map<string, TaskDto[]>();
    for (const task of open) {
      const key = task.orchestratorThreadId ?? "one-off";
      groups.set(key, [...(groups.get(key) ?? []), task]);
    }
    const ordered = [...groups];
    ordered.sort(
      (a, b) =>
        b[1].length - a[1].length ||
        Number(b[1].some((task) => cardStatus(task).status === "needs-you")) -
          Number(a[1].some((task) => cardStatus(task).status === "needs-you")),
    );
    return ordered;
  }, [data]);
  const broken = open.filter((task) => cardStatus(task).status === "broken");
  const needsCount = attentionCount(open, data?.needsYou ?? []);
  const progress = open.filter(
    (task) =>
      ["working", "review"].includes(cardStatus(task).status) &&
      (cardStatus(task).moving || task.status === "idle"),
  ).length;
  const projectName = (task: TaskDto | undefined) =>
    task
      ? ((
          projects.data?.projects.find(
            (project) => project.repos[0]?.repo === task.repo,
          ) ??
          projects.data?.projects.find((project) =>
            project.repos.some((repo) => repo.repo === task.repo),
          )
        )?.name ??
        task.source.title ??
        task.repo ??
        "")
      : "";
  const openChat = (task: TaskDto) =>
    task.threadId ? navigate.toThread(task.threadId) : openTask(task.id);
  const timeline = [...weekEvents]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.seq - a.seq)
    .slice(0, 7);
  const hasWork = recent.length > 0 || open.length > 0;
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
    <div className="pb-10 pt-[14px]">
      <div
        className="mb-[30px] flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] leading-[18px] text-muted-foreground"
        aria-label="Work counts"
      >
        <span className="inline-flex items-center gap-1.5 text-foreground">
          <Dot tone="attention" />
          {needsCount} need you
        </span>
        <span className="inline-flex items-center gap-1.5 text-foreground">
          <Dot tone="positive" />
          {data.ready.filter((task) => task.role !== "review").length} ready
        </span>
        <span>{progress} in progress</span>
        <span>{shipped.length} shipped this week</span>
      </div>
      {!hasWork ? (
        <section className="space-y-3">
          <h2 className={HEADING}>Start here</h2>
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
        <div className="grid items-start gap-10 min-[1100px]:grid-cols-[minmax(0,1fr)_330px]">
          <div className="min-w-0 space-y-[30px]">
            {needsCount > 0 && (
              <section className="space-y-[10px]">
                <h2 className={HEADING}>Start here</h2>
                <div className={cn(SURFACE, "divide-y divide-border/60")}>
                  {data.needsYou.map((decision) => (
                    <StartDecision
                      key={decision.id}
                      decision={decision}
                      subline={`${byId.get(decision.askedByTaskId ?? decision.taskIds[0] ?? "")?.title ?? ""}${projectName(byId.get(decision.askedByTaskId ?? decision.taskIds[0] ?? "")) ? ` · ${projectName(byId.get(decision.askedByTaskId ?? decision.taskIds[0] ?? ""))}` : ""}`}
                    />
                  ))}
                  {broken
                    .filter(
                      (task) =>
                        !data.needsYou.some((decision) =>
                          decision.taskIds.includes(task.id),
                        ),
                    )
                    .map((task) => (
                      <StoppedStart
                        key={task.id}
                        task={task}
                        project={projectName(task)}
                        onOpen={() => openChat(task)}
                      />
                    ))}
                </div>
              </section>
            )}
            <section className="space-y-[10px]">
              <div className="flex h-6 items-center justify-between gap-2">
                <h2 className={HEADING}>Running now</h2>
                <span className="text-xs leading-5 text-muted-foreground">
                  {overview.data?.activeSandboxes ?? "…"}
                  {overview.data?.cap ? ` of ${overview.data.cap}` : ""}{" "}
                  sandboxes on
                </span>
              </div>
              <div className={cn(SURFACE, "divide-y divide-border/60")}>
                {grouped.map(([threadId, tasks]) => {
                  const entry = orchestrators.data?.orchestrators.find(
                    (item) => item.threadId === threadId,
                  );
                  const provider =
                    threads.find((thread) => thread.id === threadId)
                      ?.providerId === "codex"
                      ? "codex"
                      : "claude";
                  const counts = {
                    stopped: tasks.filter(
                      (task) => cardStatus(task).status === "broken",
                    ).length,
                    ready: tasks.filter(
                      (task) => cardStatus(task).status === "ready",
                    ).length,
                    needs: tasks.filter(
                      (task) => cardStatus(task).status === "needs-you",
                    ).length,
                    working: tasks.filter(
                      (task) =>
                        cardStatus(task).status === "review" ||
                        cardStatus(task).moving,
                    ).length,
                  };
                  const sorted = [...tasks].sort((a, b) => {
                    const order = (task: TaskDto) =>
                      cardStatus(task).status === "review"
                        ? 0
                        : task.status === "idle" &&
                            cardStatus(task).status === "working"
                          ? 1
                          : cardStatus(task).status === "broken"
                            ? 2
                            : 3;
                    return order(a) - order(b);
                  });
                  return (
                    <div
                      key={threadId}
                      className="space-y-[10px] px-[14px] py-3"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-[13px] leading-5">
                        <AgentLogo provider={provider} className="size-3" />
                        {threadId === "one-off" ? (
                          <span>Tasks</span>
                        ) : (
                          <span className="font-medium text-[color:var(--boat-heading)]">
                            <ThreadName threadId={threadId} />
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {entry?.projectName ?? projectName(tasks[0])}
                        </span>
                        <div className="ml-auto flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                          {counts.stopped > 0 && (
                            <span>
                              <span className="text-[#E06C6C]">•</span>{" "}
                              {counts.stopped} stopped
                            </span>
                          )}
                          {counts.needs > 0 && (
                            <span>
                              <span className="text-[#F0B135]">•</span>{" "}
                              {counts.needs} needs you
                            </span>
                          )}
                          {counts.ready > 0 && (
                            <span>
                              <span className="text-[#5BD08A]">•</span>{" "}
                              {counts.ready} ready
                            </span>
                          )}
                          {counts.working > 0 && (
                            <span>• {counts.working} working</span>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5 pl-5">
                        {sorted.map((task) => {
                          const state = cardStatus(task);
                          const activeReview = recent.find(
                            (review) =>
                              review.parentTaskId === task.id &&
                              review.role === "review" &&
                              ["starting", "running"].includes(review.status),
                          );
                          const label =
                            state.status === "review"
                              ? `${PROVIDER_SHORT[activeReview?.provider ?? "codex"]} reviewing`
                              : state.status === "needs-you"
                                ? "waiting on you"
                                : state.status === "broken"
                                  ? "stopped"
                                  : state.status === "working" &&
                                      task.status === "idle"
                                    ? "just finished"
                                    : state.label.toLowerCase();
                          return (
                            <button
                              key={task.id}
                              type="button"
                              onClick={() => openChat(task)}
                              className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border/70 bg-[color:var(--boat-chip)] py-[5px] pl-[7px] pr-[10px] text-xs leading-4 hover:bg-state-hover"
                            >
                              <AgentActivity
                                provider={task.provider}
                                moving={state.moving}
                              />
                              <span className="truncate text-[color:var(--boat-content)]">
                                {task.title.replace(/ to checkout$/, "")}
                              </span>
                              <span
                                className={cn(
                                  "shrink-0",
                                  CARD_TONES[state.tone],
                                )}
                              >
                                {label}
                              </span>
                              {label === "just finished" && (
                                <span
                                  aria-hidden
                                  className="size-1.5 rounded-full bg-foreground"
                                />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
            <section className="space-y-[10px]">
              <h2 className={HEADING}>Timeline</h2>
              <ol>
                {timeline.map((event, index) => {
                  const task = event.taskId
                    ? byId.get(event.taskId)
                    : undefined;
                  const text =
                    event.kind === "review-started" && event.review
                      ? `${PROVIDER_SHORT[event.review.provider]} started ${event.review.round === 2 ? "a second look" : "a review"} at ${task?.title ?? event.taskTitle ?? "the change"}`
                      : event.kind === "review-verdict" && event.review
                        ? `${PROVIDER_SHORT[event.review.provider]} ${event.review.verdict === "approve" ? "approved" : "asked for changes to"} ${task?.title ?? event.taskTitle ?? "the change"}`
                        : event.text;
                  const eventThreadProvider = threads.find(
                    (thread) => thread.id === event.threadId,
                  )?.providerId;
                  const eventProvider =
                    event.provider ??
                    (eventThreadProvider === "claude-code"
                      ? "claude"
                      : eventThreadProvider === "codex"
                        ? "codex"
                        : null);
                  const tone =
                    event.kind === "stopped"
                      ? "danger"
                      : event.kind === "needs-you"
                        ? "attention"
                        : ["ready", "shipped", "merged"].includes(event.kind)
                          ? "positive"
                          : "neutral";
                  return (
                    <li
                      key={event.seq}
                      className="relative flex items-start gap-3 pb-4 text-[13px] leading-5"
                    >
                      <time
                        dateTime={event.at}
                        className="w-16 shrink-0 text-right text-xs leading-5 text-muted-foreground text-[color:var(--boat-faint)]"
                      >
                        {new Date(event.at)
                          .toLocaleTimeString("en-US", {
                            hour: "numeric",
                            minute: "2-digit",
                          })
                          .toLowerCase()}
                      </time>
                      {index < timeline.length - 1 && (
                        <span
                          aria-hidden
                          className="absolute bottom-[-8px] left-[83px] top-5 w-px bg-border"
                        />
                      )}
                      <span className="relative flex h-5 w-4 shrink-0 items-center justify-center">
                        {event.kind === "review-started" && event.provider ? (
                          <AgentLogo
                            provider={event.provider}
                            className="size-3.5"
                          />
                        ) : ["shipped", "merged"].includes(event.kind) ? (
                          <Icon
                            name="Check"
                            className="size-3.5 text-[#5BD08A]"
                          />
                        ) : event.kind === "started" && eventProvider ? (
                          <AgentLogo
                            provider={eventProvider}
                            className="size-3"
                          />
                        ) : (
                          <Dot tone={tone} />
                        )}
                      </span>
                      <button
                        type="button"
                        className="min-w-0 text-left hover:underline"
                        onClick={() =>
                          task
                            ? openChat(task)
                            : event.threadId &&
                              navigate.toThread(event.threadId)
                        }
                      >
                        <span className="text-foreground/90">{text}</span>
                        <span className="block text-xs leading-4 text-muted-foreground text-[color:var(--boat-faint)]">
                          {event.detail ??
                            `${projectName(task) || (orchestrators.data?.orchestrators.find((item) => item.threadId === event.orchestratorThreadId)?.projectName ?? "")}${event.kind === "stopped" ? " · sandbox stopped, work saved" : event.kind === "review-started" && event.review ? ` · Review ${event.review.round}` : event.kind === "needs-you" && task ? ` · ${task.title}` : event.kind === "ready" && task?.prUrl ? ` · PR #${task.prUrl.match(/\/pull\/(\d+)/)?.[1]}` : ""}`}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>
          </div>
          <aside className="space-y-3">
            <h2 className={HEADING}>This week</h2>
            <div className={cn(SURFACE, "space-y-[14px] p-4")}>
              <div className="flex items-baseline gap-2">
                <span className="text-[26px] font-semibold leading-[30px] text-[#5BD08A]">
                  {shipped.length}
                </span>
                <span className="text-xs text-muted-foreground">
                  shipped, {shippedToday} today
                </span>
              </div>
              <div className="flex gap-1" aria-label="Shipped tasks per day">
                {Array.from(
                  { length: ((new Date(now).getDay() + 6) % 7) + 1 },
                  (_, i) => {
                    const start = weekStart(now) + i * 86400000;
                    const count = shipped.filter(
                      (event) =>
                        Date.parse(event.at) >= start &&
                        Date.parse(event.at) < start + 86400000,
                    ).length;
                    const isToday = new Date(start).toDateString() === today;
                    return (
                      <div
                        key={i}
                        className="flex flex-1 flex-col items-center gap-1.5"
                      >
                        <div className="flex h-16 w-full items-end justify-center">
                          <div
                            className={cn(
                              "w-[22px] rounded-[5px]",
                              isToday ? "bg-[#5BD08A]" : "bg-[#2F4A3A]",
                            )}
                            style={{
                              height: `${Math.max(2, Math.min(count * 26, 64))}px`,
                            }}
                            title={`${count} shipped`}
                          />
                        </div>
                        <span
                          className={cn(
                            "text-[11px] leading-[14px]",
                            isToday
                              ? "text-foreground"
                              : "text-muted-foreground",
                          )}
                        >
                          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i]}
                        </span>
                      </div>
                    );
                  },
                )}
              </div>
              <dl className="space-y-1.5 border-t border-border/60 pt-1.5 text-xs leading-4 text-muted-foreground">
                {usage.data?.week.hours != null &&
                  usage.data.week.dollars != null && (
                    <div
                      className="flex justify-between gap-2"
                      title="Size-weighted machine time and list-price cost of listed sandboxes"
                    >
                      <dt>Sandbox time</dt>
                      <dd className="text-foreground/80">
                        {countNumber(usage.data.week.hours)} h · about $
                        {usage.data.week.dollars.toFixed(2)}
                      </dd>
                    </div>
                  )}
                {relay.data?.agents
                  .filter((agent) => agent.usedPercent !== null)
                  .map((agent) => (
                    <div
                      key={agent.provider}
                      className="flex justify-between gap-2"
                    >
                      <dt>{PROVIDER_SHORT[agent.provider]}</dt>
                      <dd className="text-foreground/80">
                        {Math.round(agent.usedPercent!)}% of{" "}
                        {agent.window?.toLowerCase().includes("week")
                          ? "weekly limit"
                          : (agent.window ?? "usage limit")}
                      </dd>
                    </div>
                  ))}
                <div className="flex justify-between gap-2">
                  <dt>Reviews</dt>
                  <dd className="text-foreground/80">
                    {reviews.length} · {changesRequested} asked for changes
                  </dd>
                </div>
              </dl>
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
function Dot({
  tone,
}: {
  tone: "attention" | "positive" | "danger" | "neutral";
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        {
          attention: "bg-[#F0B135]",
          positive: "bg-[#5BD08A]",
          danger: "bg-[#E06C6C]",
          neutral: "bg-foreground/75",
        }[tone],
      )}
    />
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
      className="space-y-2 rounded-lg border border-border bg-card p-4 text-left hover:bg-state-hover"
    >
      <Icon name={icon} className="size-4 text-muted-foreground" />
      <span className="block text-sm font-medium">{title}</span>
      <span className="block text-xs text-muted-foreground">{detail}</span>
    </button>
  );
}
function StartDecision({
  decision,
  subline,
}: {
  decision: DecisionDto;
  subline: string;
}) {
  const send = experimental_useRpcMutation({
    contract: rpcContract,
    method: "answerDecision",
  });
  const navigate = useBbNavigate();
  const [pending, setPending] = useState(false);
  const details =
    decision.optionDetails ?? normalizeDecisionOptions(decision.options);
  const option =
    details.find((entry) => entry.recommended)?.label ??
    recommendedOption(decision.options, decision.recommendation);
  const choose = () => {
    if (pending) return;
    setPending(true);
    const cancel = queueDelivery(async () => {
      try {
        await send.mutate({
          id: decision.id,
          accept: !option,
          answer: option ?? null,
        });
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
    <div className="flex flex-wrap items-center gap-3 px-[14px] py-[11px]">
      <Dot tone="attention" />
      <button
        type="button"
        className="min-w-0 flex-1 text-left hover:underline"
        onClick={() =>
          decision.orchestratorThreadId &&
          navigate.toThread(decision.orchestratorThreadId)
        }
      >
        <span className="block text-[13px] font-medium leading-5 text-[color:var(--boat-heading)]">
          {decision.question}
        </span>
        <span className="mt-0.5 block text-xs leading-4 text-muted-foreground text-[color:var(--boat-description)]">
          {subline}
        </span>
      </button>
      <Button
        type="button"
        size="sm"
        className="h-[26px] shrink-0 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-primary/90"
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
function StoppedStart({
  task,
  project,
  onOpen,
}: {
  task: TaskDto;
  project: string;
  onOpen: () => void;
}) {
  const detail = useTask(task.id);
  const [resize, setResize] = useState(false);
  const oom = /out.of.memory|oom/i.test(task.error ?? "");
  const canResize = detail.data?.task?.memory?.canResize;
  return (
    <div className="flex flex-wrap items-center gap-3 px-[14px] py-[11px]">
      <Dot tone="danger" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium leading-5 text-[color:var(--boat-heading)]">
          {oom
            ? `${task.title.replace(/^Add /, "").replace(/ to checkout$/, "")} ran out of memory. Continue on Large?`
            : (task.error ?? `${task.title} stopped`)}
        </p>
        <p className="mt-0.5 text-xs leading-4 text-muted-foreground text-[color:var(--boat-description)]">
          {task.title.replace(/ to checkout$/, "")} · {project} · work is saved
        </p>
      </div>
      <Button
        size="sm"
        className="h-[26px] shrink-0 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-primary/90"
        onClick={() => (canResize ? setResize(true) : onOpen())}
      >
        {canResize ? "Continue on Large" : "Continue in chat"}
      </Button>
      {detail.data?.task && (
        <ResizeDialog
          task={detail.data.task}
          mode={oom ? "oom" : "general"}
          open={resize}
          onOpenChange={setResize}
        />
      )}
    </div>
  );
}

function AgentActivity({
  provider,
  moving,
}: {
  provider: TaskDto["provider"];
  moving: boolean;
}) {
  if (!moving) return <AgentLogo provider={provider} className="size-3" />;
  return (
    <span className="relative flex size-[18px] shrink-0 items-center justify-center">
      <svg
        aria-hidden
        viewBox="0 0 18 18"
        className="absolute size-[18px] motion-safe:animate-spin"
      >
        <circle
          cx="9"
          cy="9"
          r="8"
          fill="none"
          stroke="#2C2C2C"
          strokeWidth="1.5"
        />
        <path
          d="M9 1a8 8 0 0 1 8 8"
          fill="none"
          stroke={provider === "claude" ? "#D97757" : "#BDBDBD"}
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
      <AgentLogo provider={provider} className="size-[10px]" />
    </span>
  );
}
