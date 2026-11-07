// The board: Needs you (decisions), Ready to review, Running and Recently
// done, one compact row each. One orchestrator's (or chat's) work on its page
// and side-panel tab (Board), or everything as separate sections on the
// Cloud agents page (BoardSection).
import { useEffect, useRef, useId, useMemo, useState, type ReactNode } from "react";
import { experimental_useRpcMutation, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { rpcContract, type DecisionDto, type TaskDto } from "../contract";
import { DecisionCard } from "./cards";
import { shipRpcContract } from "../contract-ship";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { reviewLabel } from "./format";
import { useBoard, useCloudAgentsNavigation, useNow } from "./hooks";
import {
  CountPill,
  EmptyBox,
  InlineAlert,
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
  const request = experimental_useRpcMutation({ contract: shipRpcContract, method: "requestShip" });
  const navigate = useBbNavigate();
  const run = async () => {
    try { const result = await request.mutate({ id: task.id, from: "page" }); navigate.toThread(result.threadId); }
    catch (error) { showError(error); }
  };
  return <Button variant="outline" size="sm" className={cn("relative z-10 h-7", className)} disabled={request.isPending} onClick={() => void run()}>
    {request.isPending ? "Opening…" : `Ship to ${task.baseBranch ?? "main"}`}
  </Button>;
}

/** Compatibility for older entry points: opens the same in-thread approval. */
export function ShipDialog({ task, open, onOpenChange, from = "page" }: { task: TaskDto; open: boolean; onOpenChange: (open: boolean) => void; from?: "page" | "chat" }) {
  const request = experimental_useRpcMutation({ contract: shipRpcContract, method: "requestShip" });
  const navigate = useBbNavigate();
  const started = useRef(false);
  useEffect(() => {
    if (!open) { started.current = false; return; }
    if (started.current) return;
    started.current = true;
    void request.mutate({ id: task.id, from }).then(result => { onOpenChange(false); navigate.toThread(result.threadId); }).catch(error => { onOpenChange(false); showError(error); });
  }, [open, task.id, from, request.mutate, navigate, onOpenChange]);
  return null;
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
  return <li className="px-3"><DecisionCard decision={decision} threadId={decision.orchestratorThreadId ?? ""} /></li>;
}
