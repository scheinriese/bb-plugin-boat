// The board: Needs you (decisions), Ready to review, Running and Recently
// done, one compact row each. One orchestrator's (or chat's) work on its page
// and side-panel tab (Board), or everything as separate sections on the
// Cloud agents page (BoardSection).
import { useId, useMemo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { experimental_useRpcMutation, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { rpcContract, type DecisionDto, type TaskDto } from "../contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ConfirmDialog, submitOnModEnter } from "./dialogs";
import { relativeTime, reviewLabel } from "./format";
import { useBoard, useCloudAgentsNavigation, useNow } from "./hooks";
import {
  CountPill,
  EmptyBox,
  InlineAlert,
  Kbd,
  ListPanel,
  ModelChip,
  OpenChatButton,
  PhasePill,
  PrLink,
  PreviewLink,
  StatusDot,
  ThreadName,
  UntrustedRepoBadge,
  showError,
} from "./ui";

type GroupId = "needsYou" | "ready" | "running" | "done";

const GROUP_TITLE: Record<GroupId, string> = {
  needsYou: "Needs you",
  ready: "Ready to review",
  running: "Running",
  done: "Recently done",
};

/** One chat's board (its page and side-panel tab): every group, small headings. */
export function Board({ threadId, beforeDone }: { threadId: string | null; /** Shown above Recently done (the page's order: previews first). */ beforeDone?: ReactNode }) {
  const { data, error } = useBoard(threadId);
  const now = useNow();
  // Everything listing shows each row's orchestrator; one orchestrator's board doesn't.
  const showOrchestrator = threadId === null;
  const tasksById = useMemo(
    () => new Map((data ? [...data.ready, ...data.running, ...data.done] : []).map((task) => [task.id, task])),
    [data],
  );

  if (data === undefined) {
    return error ? <InlineAlert>{error.message}</InlineAlert> : <EmptyBox>Loading tasks…</EmptyBox>;
  }
  const empty = data.needsYou.length + data.ready.length + data.running.length + data.done.length === 0;
  return (
    // Rows fit on one line when the board has room and wrap in narrow side panels.
    <div className="@container space-y-5">
      {error ? <InlineAlert>{error.message}</InlineAlert> : null}
      {empty ? <EmptyBox>No tasks yet. Tasks this chat starts show up here.</EmptyBox> : null}
      <BoardGroup title="Needs you" count={data.needsYou.length}>
        {data.needsYou.map((decision) => (
          <DecisionRow
            key={decision.id}
            decision={decision}
            tasksById={tasksById}
            showOrchestrator={showOrchestrator}
            now={now}
          />
        ))}
      </BoardGroup>
      <BoardGroup title="Ready to review" count={data.ready.length}>
        {data.ready.map((task) => (
          <BoardTaskRow key={task.id} task={task} showOrchestrator={showOrchestrator} />
        ))}
      </BoardGroup>
      <BoardGroup title="Running" count={data.running.length}>
        {data.running.map((task) => (
          <BoardTaskRow key={task.id} task={task} showOrchestrator={showOrchestrator} />
        ))}
      </BoardGroup>
      {beforeDone}
      <BoardGroup title="Recently done" count={data.done.length} collapsible>
        {data.done.map((task) => (
          <BoardTaskRow key={task.id} task={task} showOrchestrator={showOrchestrator} />
        ))}
      </BoardGroup>
    </div>
  );
}

/**
 * One group of everything's board as a page section (the Cloud agents page
 * puts orchestrators and previews between them). Hidden when empty, unless
 * `empty` says what to show instead.
 */
export function BoardSection({ group, empty }: { group: GroupId; empty?: ReactNode }) {
  const { data, error } = useBoard(null);
  const now = useNow();
  const tasksById = useMemo(
    () => new Map((data ? [...data.ready, ...data.running, ...data.done] : []).map((task) => [task.id, task])),
    [data],
  );
  if (data === undefined) {
    return group === "running" && error ? <InlineAlert>{error.message}</InlineAlert> : null;
  }
  const count = data[group].length;
  if (count === 0) {
    return empty ? (
      <section className="space-y-2">
        <h2 className="flex min-h-8 items-center text-sm font-medium text-foreground">{GROUP_TITLE[group]}</h2>
        {empty}
      </section>
    ) : null;
  }
  return (
    <div className="@container">
      <BoardGroup title={GROUP_TITLE[group]} count={count} collapsible={group === "done"} variant="section">
        {group === "needsYou"
          ? data.needsYou.map((decision) => (
              <DecisionRow key={decision.id} decision={decision} tasksById={tasksById} showOrchestrator now={now} />
            ))
          : data[group].map((task) => <BoardTaskRow key={task.id} task={task} showOrchestrator />)}
      </BoardGroup>
    </div>
  );
}

/** A titled list; hidden when empty. A collapsible group starts closed. */
function BoardGroup({
  title,
  count,
  collapsible = false,
  variant = "group",
  children,
}: {
  title: string;
  count: number;
  collapsible?: boolean;
  /** section: a page section's heading (the Cloud agents page); group: a small one. */
  variant?: "group" | "section";
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(!collapsible);
  const listId = useId();
  if (count === 0) return null;
  const heading = (
    <>
      <span>{title}</span>
      <CountPill count={count} />
    </>
  );
  const Heading = variant === "section" ? "h2" : "h3";
  return (
    <div className="space-y-2">
      <Heading
        className={cn(
          variant === "section" ? "flex min-h-8 items-center text-sm font-medium text-foreground" : "text-xs font-medium text-muted-foreground",
        )}
      >
        {collapsible ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded((value) => !value)}
            className="inline-flex items-center gap-1.5 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Icon
              name="ChevronRight"
              className={cn("size-3.5 transition-transform duration-150", expanded && "rotate-90")}
              aria-hidden
            />
            {heading}
          </button>
        ) : (
          <span className="inline-flex items-center gap-1.5">{heading}</span>
        )}
      </Heading>
      {expanded ? (
        <div id={listId}>
          <ListPanel label={title}>{children}</ListPanel>
        </div>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------------- tasks

/**
 * Wide (@2xl): title | model chip, review state, links | open chat, status
 * pill, on one line. Narrow (side panels): the title keeps the first line and
 * the pill leads the meta line under it. The title's overlay makes the whole
 * row open the task; links and buttons sit above it (z-10).
 */
function BoardTaskRow({ task, showOrchestrator }: { task: TaskDto; showOrchestrator: boolean }) {
  const { openTask } = useCloudAgentsNavigation();
  const review = reviewLabel(task.latestReview);
  const note = task.phase === "ready" ? task.readyNote : task.phase === "failed" ? task.error : null;
  return (
    <li className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-2 hover:bg-state-hover @2xl:grid-cols-[minmax(0,1fr)_auto_auto] @2xl:px-4">
      <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={() => openTask(task.id)}
          className="min-w-0 truncate text-left text-sm font-medium text-foreground after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-1 focus-visible:after:ring-inset focus-visible:after:ring-ring"
        >
          {task.title}
        </button>
        {task.untrustedRepo ? <UntrustedRepoBadge /> : null}
      </div>
      <div className="col-span-2 row-start-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground @2xl:col-[2] @2xl:row-start-1 @2xl:flex-nowrap">
        <PhasePill task={task} className="@2xl:hidden" />
        <ModelChip task={task} />
        {review ? (
          <span className={cn("shrink-0", review.tone === "warning" && "text-warning-text")}>{review.text}</span>
        ) : null}
        {task.prUrl ? <PrLink url={task.prUrl} prefixed /> : null}
        {task.previewUrl ? <PreviewLink url={task.previewUrl} /> : null}
        {showOrchestrator ? <SourceLink source={task.source} /> : null}
      </div>
      <div className="col-start-2 row-start-1 flex items-center justify-end gap-1 @2xl:col-start-3">
        {task.canShip && task.phase === "ready" ? <ShipButton task={task} /> : null}
        <OpenChatButton task={task} className="-my-1" />
        <PhasePill task={task} className="hidden @2xl:inline-flex" />
      </div>
      {note ? (
        <p
          className={cn(
            "col-span-full row-start-3 line-clamp-2 text-xs text-pretty @2xl:row-start-2",
            task.phase === "failed" ? "text-destructive-text" : "text-muted-foreground",
          )}
        >
          {note}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Ship (projects that land on their base branch after you approve): the
 * plugin pushes the worker's commits, updated to the latest base first, and
 * closes the task. Your click is the approval.
 */
export function ShipButton({ task, className }: { task: TaskDto; className?: string }) {
  const [confirming, setConfirming] = useState(false);
  const base = task.baseBranch ?? "the base branch";
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className={cn("relative z-10 -my-1 h-7", className)}
        onClick={() => setConfirming(true)}
        aria-label={`Ship ${task.title} to ${base}`}
      >
        <Icon name="Rocket" fallback="ArrowUpRight" /> Ship
      </Button>
      <ShipDialog task={task} open={confirming} onOpenChange={setConfirming} />
    </>
  );
}

/**
 * Ship's confirm, also opened by Ship in a task chat's header (`from: "chat"`,
 * for the task history). Confirming is the user's approval.
 */
export function ShipDialog({
  task,
  open,
  onOpenChange,
  from = "page",
}: {
  task: TaskDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  from?: "page" | "chat";
}) {
  const ship = experimental_useRpcMutation({ contract: rpcContract, method: "shipTask" });
  const base = task.baseBranch ?? "the base branch";
  const run = async () => {
    try {
      const result = await ship.mutate({ id: task.id, from });
      const where = result.shipped.map((entry) => `${entry.baseBranch} (${entry.sha.slice(0, 7)})`).join(", ");
      toast.success(`Shipped ${task.title} to ${where}`);
      onOpenChange(false);
    } catch (error) {
      showError(error);
    }
  };
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Ship to ${base}?`}
      description={
        <>
          The task's commits for <span className="font-medium text-foreground">{task.title}</span> are pushed onto{" "}
          <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[11px]">{base}</code>, after updating them to its
          latest version (nothing is forced). Then the task closes and its sandbox is deleted.
        </>
      }
      confirmLabel={`Ship to ${base}`}
      pending={ship.isPending}
      onConfirm={() => void run()}
    />
  );
}

/**
 * Who started a row's task: an orchestrator (opens its board) or a plain
 * chat ("From <chat>", opens the chat). Tasks from the page show nothing.
 */
function SourceLink({ source }: { source: TaskDto["source"] }) {
  const navigate = useBbNavigate();
  if (source.kind === "page" || source.threadId === null) return null;
  if (source.kind === "orchestrator") return <OrchestratorLink threadId={source.threadId} />;
  const threadId = source.threadId;
  return (
    <button
      type="button"
      onClick={() => navigate.toThread(threadId)}
      className="relative z-10 inline-flex min-w-0 max-w-56 items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Icon name="MessageSquare" className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">
        From <ThreadName threadId={threadId} fallback={source.title} />
      </span>
    </button>
  );
}

/** The orchestrator a row belongs to; opens its board. */
function OrchestratorLink({ threadId }: { threadId: string }) {
  const { openOrchestrator } = useCloudAgentsNavigation();
  return (
    <button
      type="button"
      onClick={() => openOrchestrator(threadId)}
      className="relative z-10 inline-flex min-w-0 max-w-48 items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Icon name="Workflow" className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">
        <span className="sr-only">Orchestrator: </span>
        <ThreadName threadId={threadId} />
      </span>
    </button>
  );
}

// ----------------------------------------------------------------- decisions

/** What became of a decision on this row; shown until the board refresh drops it. */
type Outcome = "sent" | "saved" | "dismissed";

const OUTCOME_NOTE: Record<Outcome, string> = {
  sent: "Sent to the orchestrator.",
  saved: "Saved your answer, but its orchestrator chat is gone.",
  dismissed: "Dismissed.",
};

function DecisionRow({
  decision,
  tasksById,
  showOrchestrator,
  now,
}: {
  decision: DecisionDto;
  tasksById: ReadonlyMap<string, TaskDto>;
  showOrchestrator: boolean;
  now: number;
}) {
  const answerDecision = experimental_useRpcMutation({ contract: rpcContract, method: "answerDecision" });
  const dismissDecision = experimental_useRpcMutation({ contract: rpcContract, method: "dismissDecision" });
  const [answering, setAnswering] = useState(false);
  const [answer, setAnswer] = useState("");
  // Hides the actions until the next board refresh drops the closed decision.
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const formId = useId();
  const busy = answerDecision.isPending || dismissDecision.isPending;
  const accepting = answerDecision.pendingInputs.some((input) => input.accept);
  const sending = answerDecision.isPending && !accepting;
  const canSend = answer.trim() !== "" && !busy;

  const send = async (accept: boolean) => {
    try {
      const { delivered } = await answerDecision.mutate({
        id: decision.id,
        accept,
        answer: accept ? null : answer.trim(),
      });
      // Not delivered: the orchestrator chat is gone, so the answer is only recorded.
      setOutcome(delivered ? "sent" : "saved");
      if (delivered) toast.success("Sent to the orchestrator");
      else toast.warning("Saved your answer, but its orchestrator chat is gone");
    } catch (error) {
      showError(error);
    }
  };

  const dismiss = async () => {
    try {
      await dismissDecision.mutate({ id: decision.id });
      setOutcome("dismissed");
      toast.success("Dismissed the decision");
    } catch (error) {
      showError(error);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (canSend) void send(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      setAnswering(false);
      return;
    }
    submitOnModEnter(event);
  };

  const linked = decision.taskIds;
  return (
    <li className="flex items-start gap-2.5 px-3 py-3 @2xl:px-4">
      <StatusDot className="mt-1.5 bg-warning" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="break-words text-sm font-medium text-pretty text-foreground">{decision.question}</p>
        <p className="break-words text-xs text-pretty text-muted-foreground">
          <span className="font-medium text-foreground">Recommended:</span> {decision.recommendation}
        </p>
        {decision.options.length > 0 ? (
          <ul aria-label="Options" className="flex flex-wrap gap-1">
            {decision.options.map((option, index) => (
              <li
                key={index}
                className="max-w-full break-words rounded-md border border-border bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground"
              >
                {option}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {linked.length > 0 ? (
            <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5">
              <span>{linked.length === 1 ? "Task:" : "Tasks:"}</span>
              {linked.map((taskId, index) => (
                <span key={taskId} className="inline-flex min-w-0 max-w-full items-center">
                  <LinkedTask taskId={taskId} task={tasksById.get(taskId)} />
                  {index < linked.length - 1 ? <span aria-hidden>,</span> : null}
                </span>
              ))}
            </span>
          ) : null}
          {showOrchestrator && decision.orchestratorThreadId ? (
            <OrchestratorLink threadId={decision.orchestratorThreadId} />
          ) : null}
          <span className="tabular-nums">asked {relativeTime(decision.createdAt, now)}</span>
        </div>
        {outcome ? (
          <p
            role="status"
            className={cn("pt-0.5 text-xs", outcome === "saved" ? "text-warning-text" : "text-muted-foreground")}
          >
            {OUTCOME_NOTE[outcome]}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              <Button size="sm" className="h-7" disabled={busy} onClick={() => void send(true)}>
                {accepting ? <Icon name="Loading" className="animate-spin" /> : null}
                Accept recommendation
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                aria-expanded={answering}
                aria-controls={formId}
                disabled={busy && !answering}
                onClick={() => setAnswering((value) => !value)}
              >
                Answer…
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-muted-foreground hover:text-foreground"
                disabled={busy}
                onClick={() => void dismiss()}
              >
                {dismissDecision.isPending ? <Icon name="Loading" className="animate-spin" /> : null}
                Dismiss
              </Button>
            </div>
            {answering ? (
              <form id={formId} onSubmit={submit} className="space-y-2 pt-1">
                <Textarea
                  aria-label={`Your answer: ${decision.question}`}
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  onKeyDown={onKeyDown}
                  rows={2}
                  maxLength={2000}
                  autoFocus
                  placeholder="Tell the orchestrator what to do…"
                  className="max-h-48 min-h-16 resize-y text-sm"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <p className="mr-auto text-xs text-muted-foreground">
                    <Kbd>⌘</Kbd> <Kbd>Enter</Kbd> to send
                  </p>
                  <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => setAnswering(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" className="h-7" disabled={!canSend}>
                    <Icon name={sending ? "Loading" : "Sent"} className={cn(sending && "animate-spin")} />
                    Send
                  </Button>
                </div>
              </form>
            ) : null}
          </>
        )}
      </div>
    </li>
  );
}

/** A task a decision is about: its title when the board has it, else its id. */
function LinkedTask({ taskId, task }: { taskId: string; task: TaskDto | undefined }) {
  const { openTask } = useCloudAgentsNavigation();
  return (
    <button
      type="button"
      onClick={() => openTask(taskId)}
      className={cn(
        "min-w-0 max-w-64 truncate rounded-sm text-left hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        task === undefined && "font-mono",
      )}
      aria-label={`Open task ${task?.title ?? taskId}`}
    >
      {task?.title ?? taskId}
    </button>
  );
}
