// Surfaces outside the Cloud agents page: the context row segment above a
// thread's composer, the Info tab section, the context card section, the
// thread side-panel tab, the `::boat-task{id=…}` message card, and the
// homepage card. All of them mount once per visible thread, so state lives
// in components only.
import { useState } from "react";
import {
  experimental_InfoList as InfoList,
  experimental_InfoListRow as InfoListRow,
  experimental_InfoSection as InfoSection,
  experimental_ThreadContextCardRow as ThreadContextCardRow,
  useBbNavigate,
  experimental_useAppPanel,
  experimental_useThreadContextKind,
  type ExperimentalThreadContextCardProps,
  type ExperimentalThreadContextSegmentInput,
  type ExperimentalThreadContextSegmentProps,
  type ExperimentalThreadInfoProps,
  type ExperimentalThreadTabProps,
  type PluginHomepageSectionProps,
} from "@get-bb/plugin-sdk/app";
import type { DecisionDto, TaskDto } from "../contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { Board } from "./board";
import { NewProjectDialog } from "./projects-settings";
import { DecisionCard } from "./cards";
import { useComposer } from "@get-bb/plugin-sdk/app";
import {
  PHASE_DOT,
  ROLE_ICON,
  agentWords,
  plural,
  prLabel,
  shortRepo,
  summarizeBoard,
  workerChatId,
} from "./format";
import { useBoard, useCloudAgentsNavigation, useOrchestrators, useOverview, useThreadTask, useThreadTasks } from "./hooks";
import { taskPhaseLabel } from "./logic";
import { cardStatus, contextCounts } from "./cards-logic";
import { CardTaskState, TaskContextAction } from "./cards";
export { TaskDirective, registerChatCards } from "./cards";
import {
  IconButton,
  ThreadName,
  OpenChatButton,
  PrLink,
  ReportChip,
  RoleIcon,
  StatusDot,
} from "./ui";

/** This plugin's thread side-panel tab (registered in app.tsx). */
const AGENTS_TAB = { id: "cloud-agents", context: { kind: "thread" }, availability: "fixed" } as const;

// ------------------------------------------------------------ context segment

/** Whether a thread has board content: tasks it dispatched, or open decisions. */
function useThreadHasBoard(threadId: string): boolean {
  const tasks = useThreadTasks(threadId);
  const { data } = useBoard(threadId);
  const own = useThreadTask(threadId);
  return own !== null || tasks.length > 0 || (data?.needsYou.length ?? 0) > 0;
}

/** Banner mode only (the context card shows the same tasks in card mode). */
export function useSegmentVisible({ threadId }: ExperimentalThreadContextSegmentInput): boolean {
  const kind = experimental_useThreadContextKind();
  const visible = useThreadHasBoard(threadId);
  return kind === "banner" && visible;
}

export function useThreadHasTasks({ threadId }: { threadId: string }): boolean {
  return useThreadHasBoard(threadId);
}

export function ThreadSegmentSummary({ threadId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const { data } = useBoard(threadId);
  const needsYou = (data?.needsYou.length ?? 0) > 0;
  const own = useThreadTask(threadId);
  const tasks = own ? [own] : data ? [...data.ready, ...data.running, ...data.done] : [];
  const anyRunning = tasks.some(task => cardStatus(task).moving);
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Icon name="ComputerCloud" className="size-3.5 shrink-0" aria-hidden />
      {needsYou ? (
        <StatusDot className="bg-warning" />
      ) : anyRunning ? (
        <StatusDot className="bg-muted-foreground motion-safe:animate-pulse" />
      ) : null}
      <span className="truncate">
        <span className="sr-only">Cloud agents: </span>
        {data || own ? contextCounts(tasks, data?.needsYou.length ?? 0, data?.needsYou.flatMap(item => item.taskIds)) : "…"}
      </span>
      <Icon
        name="ChevronDown"
        className={cn("size-3 shrink-0 transition-transform duration-150", isExpanded && "rotate-180")}
        aria-hidden
      />
    </button>
  );
}

export function ThreadSegmentDetails({ threadId, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const { data } = useBoard(threadId);
  const own = useThreadTask(threadId);
  if (!isExpanded || data === undefined) return null;
  const tasks = own ? [own] : [...data.ready, ...data.running, ...data.done];
  if (data.needsYou.length === 0 && tasks.length === 0) return null;
  return (
    <ul aria-label="Cloud agents" className="max-h-64 space-y-px overflow-y-auto py-1">
      {data.needsYou.map((decision) => (
        <CompactDecisionRow key={decision.id} decision={decision} threadId={threadId} />
      ))}
      {tasks.map((task) => (
        <CompactTaskRow key={task.id} task={task} />
      ))}
    </ul>
  );
}

/** Decisions are answered in the Cloud agents tab, else on the orchestrator's page. */
function useOpenDecisions(threadId: string): () => void {
  const panel = experimental_useAppPanel();
  const { openOrchestrator } = useCloudAgentsNavigation();
  return () => {
    if (!panel.openTab({ tab: AGENTS_TAB })) openOrchestrator(threadId);
  };
}

function CompactDecisionRow({ decision, threadId }: { decision: DecisionDto; threadId: string }) {
  const open = useOpenDecisions(threadId);
  return (
    <li className="relative flex min-w-0 items-center gap-2 rounded-md px-2 py-1 hover:bg-state-hover">
      <StatusDot className="bg-warning" />
      <button
        type="button"
        onClick={open}
        className="min-w-0 flex-1 truncate text-left text-sm text-foreground after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:ring-1 focus-visible:after:ring-ring"
      >
        {decision.question}
      </button>
      <span className="shrink-0 text-xs text-warning-text">Needs you</span>
    </li>
  );
}

function CompactTaskRow({ task }: { task: TaskDto }) {
  const { openTask } = useCloudAgentsNavigation();
  return (
    <li className="relative flex min-w-0 items-center gap-2 rounded-md px-2 py-1 hover:bg-state-hover">
      <StatusDot className={PHASE_DOT[task.phase]} label={taskPhaseLabel(task)} />
      <RoleIcon role={task.role} className="size-3.5" />
      <button
        type="button"
        onClick={() => openTask(task.id)}
        className="min-w-0 flex-1 truncate text-left text-sm text-foreground after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:ring-1 focus-visible:after:ring-ring"
      >
        {task.title}
      </button>
      <ReportChip task={task} />
      {task.prUrl ? <PrLink url={task.prUrl} /> : null}
      <span className="shrink-0 text-xs text-muted-foreground">{taskPhaseLabel(task)}</span>
      <OpenChatButton task={task} className="-my-0.5 size-6" />
    </li>
  );
}

// ------------------------------------------------------------------ info tab

export function ThreadInfoSection({ threadId }: ExperimentalThreadInfoProps) {
  const tasks = useThreadTasks(threadId);
  const { openTask } = useCloudAgentsNavigation();
  if (tasks.length === 0) return null;
  return (
    <InfoSection label="Cloud agents" count={tasks.length}>
      <InfoList
        items={tasks}
        getKey={(task) => task.id}
        renderItem={(task) => (
          <InfoListRow
            leading={<StatusDot className={PHASE_DOT[task.phase]} />}
            leadingLabel={taskPhaseLabel(task)}
            name={task.title}
            title={`${task.title} · ${taskPhaseLabel(task)}`}
            context={task.repo ? shortRepo(task.repo) : undefined}
            trailing={
              <span className="text-xs tabular-nums text-muted-foreground">
                {task.prUrl ? prLabel(task.prUrl) : taskPhaseLabel(task)}
              </span>
            }
            onSelect={() => openTask(task.id)}
          />
        )}
      />
    </InfoSection>
  );
}

// -------------------------------------------------------------- context card

export function ThreadCardSection({ threadId }: ExperimentalThreadContextCardProps) {
  const children = useThreadTasks(threadId);
  const own = useThreadTask(threadId);
  const tasks = own ? [own] : children;
  const board = useBoard(threadId).data;
  const decisions = board?.needsYou.length ?? 0;
  const { openTask } = useCloudAgentsNavigation();
  const openDecisions = useOpenDecisions(threadId);
  if (tasks.length === 0 && decisions === 0) return null;
  const decisionsLabel = `${plural(decisions, "decision")} ${decisions === 1 ? "needs" : "need"} you`;
  return (
    <>
      <ThreadContextCardRow icon="ComputerCloud" label={contextCounts(tasks, decisions, board?.needsYou.flatMap(item => item.taskIds))} action={tasks.find(task => ["ready", "stopped"].includes(cardStatus(task).status)) ? <TaskContextAction task={tasks.find(task => ["ready", "stopped"].includes(cardStatus(task).status))!} /> : undefined} onClick={openDecisions} />
      {decisions > 0 ? (
        <ThreadContextCardRow
          icon="ComputerCloud"
          label={decisionsLabel}
          title={decisionsLabel}
          trailing={<StatusDot className="bg-warning" />}
          onClick={openDecisions}
        />
      ) : null}
      {tasks.map((task) => (
        <ThreadContextCardRow
          key={task.id}
          icon={ROLE_ICON[task.role]}
          label={task.title}
          title={`${task.title} · ${taskPhaseLabel(task)}`}
          trailing={<CardTaskState task={task} />}
          action={workerChatId(task) ? <OpenChatButton task={task} className="size-6" /> : undefined}
          onClick={() => openTask(task.id)}
        />
      ))}
    </>
  );
}

// ---------------------------------------------------------- side-panel tab

/** The orchestrator's board: decisions, work to review, running and done. */
export function ThreadAgentsTab({ threadId }: ExperimentalThreadTabProps) {
  const { data } = useBoard(threadId);
  const { openOrchestrator } = useCloudAgentsNavigation();
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon name="boat-sail" fallback="ComputerCloud" className="size-3.5" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{data ? summarizeBoard(data) : "…"} · via boat.dev</span>
        <IconButton
          label="Open in Cloud agents"
          icon="ArrowUpRight"
          className="-my-1"
          onClick={() => openOrchestrator(threadId)}
        />
      </div>
      <Board threadId={threadId} />
    </div>
  );
}

// ------------------------------------------------------------ message card

// ------------------------------------------------------------ homepage card

/**
 * "Hand a task to a cloud agent" with New task, and a way into orchestrators.
 * Once you have orchestrators, the ones that need you are listed with Open.
 */
export function HomepageCard({ projectId }: PluginHomepageSectionProps) {
  const composer = useComposer();
  const [adding, setAdding] = useState(false);
  const { openOverview, openOrchestrator } = useCloudAgentsNavigation();
  const orchestratorData = useOrchestrators().data;
  const orchestrators = (orchestratorData?.orchestrators ?? []).filter(entry => !entry.archived);
  const board = useBoard(null).data;
  const decisions = board?.needsYou ?? [];
  const firstRun = board !== undefined && orchestratorData !== undefined && orchestrators.length === 0 && decisions.length === 0 && (board?.ready.length ?? 0) + (board?.running.length ?? 0) + (board?.done.length ?? 0) === 0;
  const fill = (text: string) => { composer.insert(text, { at: "end", block: true }); composer.focus(); };
  return <section className="overflow-hidden rounded-lg border border-border bg-card">
    <header className="flex items-center gap-2 px-4 py-3"><Icon name="ComputerCloud" className="size-4 text-muted-foreground" /><span className="flex-1 text-xs text-muted-foreground">Your cloud work</span><Button variant="ghost" size="sm" onClick={openOverview}>Open</Button></header>
    {decisions.length > 0 && <div className="border-t border-border px-3">{decisions.map(decision => <DecisionCard key={decision.id} decision={decision} threadId={decision.orchestratorThreadId ?? ""} />)}</div>}
    {orchestrators.length > 0 && <ul aria-label="Orchestrators" className="divide-y divide-border border-t border-border">{orchestrators.map(entry => <li key={entry.threadId} className="flex items-center gap-2 px-4 py-2.5"><Icon name="Workflow" className="size-3.5 text-muted-foreground" /><button className="min-w-0 flex-1 truncate rounded-sm text-left text-sm hover:underline focus-visible:ring-1 focus-visible:ring-ring" onClick={() => openOrchestrator(entry.threadId)}>{entry.projectName ?? entry.title ?? "Orchestrator"}</button><span className={cn("text-xs", entry.needsAttention ? "text-[#F0B135]" : "text-muted-foreground")}>{entry.needsAttention ? `${entry.needsAttention} ${entry.needsAttention === 1 ? "needs" : "need"} you` : entry.runningTasks ? `${entry.runningTasks} working` : `${entry.openTasks} open`}</span></li>)}</ul>}
    {firstRun ? <div className="space-y-2 border-t border-border p-4"><p className="text-sm">Start with one task, or coordinate a project.</p><div className="flex flex-col gap-2 sm:flex-row"><Button size="sm" variant="outline" onClick={() => fill("Help me work on one task in this repository. ")}>Start a task</Button><Button size="sm" variant="outline" onClick={() => setAdding(true)}>Add a project</Button><Button size="sm" variant="outline" onClick={() => fill("Help me plan and coordinate work for this project. ")}>Start an orchestrator</Button></div><p className="text-xs text-muted-foreground">Choose your project and Boat sandbox below. Use Start as orchestrator in the send menu to coordinate.</p></div> : decisions.length === 0 && <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{board === undefined ? "Loading cloud work…" : "Nothing needs you right now."}</p>}
    <NewProjectDialog open={adding} onOpenChange={setAdding} repo="" baseBranch="" />
  </section>;
}
