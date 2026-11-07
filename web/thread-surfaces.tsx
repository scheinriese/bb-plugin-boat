// Surfaces outside the Cloud agents page: the context row segment above a
// thread's composer, the Info tab section, the context card section, the
// thread side-panel tab, the `::boat-task{id=…}` message card, and the
// homepage card. All of them mount once per visible thread, so state lives
// in components only.
import {
  experimental_InfoList as InfoList,
  experimental_InfoListRow as InfoListRow,
  experimental_InfoSection as InfoSection,
  experimental_ThreadContextCardRow as ThreadContextCardRow,
  useBbNavigate,
  UrlLink,
  experimental_useAppPanel,
  experimental_useThreadContextKind,
  type ExperimentalThreadContextCardProps,
  type ExperimentalThreadContextSegmentInput,
  type ExperimentalThreadContextSegmentProps,
  type ExperimentalThreadInfoProps,
  type ExperimentalThreadTabProps,
} from "@get-bb/plugin-sdk/app";
import { DiffStats } from "./diff-stats";
import { mergeRpcContract } from "../contract-merge";
import { experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { rpcContract, type DecisionDto, type TaskDto } from "../contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { Board } from "./board";
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
import { useBoard, useCloudAgentsNavigation, useOverview, useTask, useThreadTask, useThreadTasks, useSetup, useRelay } from "./hooks";
import { taskPhaseLabel } from "./logic";
import { cardStatus, contextCounts } from "./cards-logic";
import { CardTaskState, TaskContextAction, useNativePaused } from "./cards";
import { useQueuedStarts } from "./start-queue";
export { TaskDirective, registerChatCards } from "./cards";
import {
  IconButton,
  AgentLogo,
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
  const queued=useQueuedStarts(threadId).data?.requests??[];
  return own !== null || tasks.length > 0 || (data?.needsYou.length ?? 0) > 0 || queued.length>0;
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
  const queued=useQueuedStarts(threadId).data?.requests??[];
  const facts=experimental_useRpcQuery({contract:mergeRpcContract,method:"pullRequestFacts",input:{id:own?.id??""},enabled:Boolean(own?.prUrl)}).data;
  const preview=experimental_useRpcQuery({contract:rpcContract,method:'previews',input:{taskId:own?.id??null,threadId:null},enabled:Boolean(own?.previewUrl)}).data?.previews.find(preview=>preview.link===own?.previewUrl);
  const tasks = own ? [own] : data ? [...data.ready, ...data.running, ...data.done] : [];
  const anyRunning = tasks.some(task => cardStatus(task).moving);
  const workSummary=tasks.length||(data?.needsYou.length??0)>0?contextCounts(tasks,data?.needsYou.length??0,data?.needsYou.flatMap(item=>item.taskIds)):null;
  const summary=[workSummary,queued.length?`${queued.length} waiting for reset`:null].filter(Boolean).join(' · ')||(data||own?'No active tasks':'…');
  if (own?.prUrl) return <span className="boat-ui inline-flex items-center gap-2 px-1.5 text-[12px]">{facts?.draft&&<span className="text-muted-foreground">Draft</span>}<PrLink url={own.prUrl} prefixed/>{facts&&<DiffStats additions={facts.additions} deletions={facts.deletions}/>}{own.previewUrl&&<UrlLink href={own.previewUrl} className={cn('inline-flex items-center gap-1',preview&&preview.state!=='live'?'text-muted-foreground':'text-[#7AA7FF]')}><Icon name="Globe" className="hidden size-3 sm:inline"/>{preview?.state==='sleeping'?'Preview asleep':preview?.state==='expired'?'Preview expired':'Preview'}</UrlLink>}</span>;
  return <button type="button" onClick={onToggle} aria-expanded={isExpanded} className={cn("boat-ui inline-flex h-6 max-w-full items-center gap-1.5 rounded-md px-1.5 text-xs hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring",needsYou?'text-[#F0B135]':'text-muted-foreground')}>
    <Icon name="ComputerCloud" className="size-3.5 shrink-0 text-muted-foreground sm:hidden"/>
    <span className="flex items-center gap-3 sm:gap-[14px]">{summary.split(' · ').map(part=><span key={part} className={cn('flex items-center gap-1.5 whitespace-nowrap',part.includes('need')?'order-0 text-[#F0B135]':part.includes('ready')?'order-1 text-foreground':'order-2 text-foreground','sm:order-none')}><span aria-hidden className={cn('size-1.5 shrink-0 rounded-full',part.includes('need')?'bg-[#F0B135]':part.includes('ready')?'bg-[#5BD08A]':anyRunning?'bg-muted-foreground motion-safe:animate-pulse':'bg-muted-foreground')}/>{part}</span>)}</span>
    <Icon name="ChevronDown" className="size-3 shrink-0 text-muted-foreground sm:hidden"/>
  </button>;
}
/** SDK action renders at the row end, after all native segments. */
export function ThreadSegmentAction({threadId}:ExperimentalThreadContextSegmentProps){
  const {data}=useBoard(threadId);const own=useThreadTask(threadId);
  const paused=useNativePaused(threadId);
  const setup=useSetup().data;
  const relay=useRelay().data;
  const queued=useQueuedStarts(threadId).data?.requests??[];
  const detail=useTask(own?.id??null).data?.task;
  const decisionTask=[...(data?.running??[]),...(data?.ready??[])].find(task=>data?.needsYou.some(item=>item.taskIds.includes(task.id)));
  const currentAgent=relay?.orchestrators.find(row=>row.threadId===threadId)?.provider;
  const usage=relay?.agents.find(agent=>agent.provider===currentAgent);
  if(queued.length){
    return <span className="boat-ui ml-auto hidden text-[12px] text-[#FC8C45] md:inline">{relay?.agents.filter(agent=>agent.usedPercent!==null).map(agent=>`${agent.provider==='claude'?'Claude':'Codex'} ${Math.round(agent.usedPercent!)}%`).join(' · ')||'Running work continues'}</span>;
  }
  if(!own&&relay?.enabled&&currentAgent){
    const preferredUsage=relay.agents.find(agent=>agent.provider===relay.preferred);
    if(currentAgent!==relay.preferred&&preferredUsage?.usedPercent!==null&&preferredUsage?.usedPercent!==undefined&&preferredUsage.usedPercent>=relay.switchAtPercent)
      return <span className="boat-ui ml-auto hidden items-center gap-1.5 text-[12px] text-muted-foreground md:inline-flex"><AgentLogo provider={currentAgent} className="size-3"/>On {currentAgent==='claude'?'Claude':'Codex'} · back to {relay.preferred==='claude'?'Claude':'Codex'} after its reset</span>;
    if(usage?.usedPercent!==null&&usage?.usedPercent!==undefined&&usage.usedPercent>=Math.max(0,relay.switchAtPercent-10))
      return <span className="boat-ui ml-auto hidden items-center gap-1.5 text-[12px] text-muted-foreground md:inline-flex"><AgentLogo provider={currentAgent} className="size-3"/>{currentAgent==='claude'?'Claude':'Codex'} <span className="text-[#FC8C45]">{Math.round(usage.usedPercent)}%</span> · switches to {currentAgent==='claude'?'Codex':'Claude'} at {relay.switchAtPercent}%</span>;
  }
  if(!own&&(data?.ready.length??0)>0&&setup?.plan)return <span className="boat-ui ml-auto hidden text-[12px] text-muted-foreground md:inline">{setup.plan.activeSandboxes}{setup.plan.maxActiveSandboxes!==null?' of '+setup.plan.maxActiveSandboxes:''} sandboxes{usage?.usedPercent!==null&&usage?.usedPercent!==undefined?` · ${usage.provider==='claude'?'Claude':'Codex'} ${Math.round(usage.usedPercent)}%`:''}</span>;
  if((data?.needsYou.length??0)>0)return <span className="boat-ui ml-auto hidden text-[12px] text-muted-foreground md:inline">{decisionTask?.provider==='claude'?'Claude':decisionTask?.provider==='codex'?'Codex':'The agent'} waits in its sandbox; nothing is lost</span>;
  if(own?.sandboxId)return <span className="boat-ui ml-auto inline-flex items-center gap-1.5 text-[12px] text-muted-foreground"><span className={cn("size-1.5 rounded-full",paused?'bg-muted-foreground':'bg-[#5BD08A]')}/><span className="sm:hidden">{paused?'stopped':'on'}</span><span className="hidden sm:inline">{paused?'Sandbox stopped':'Sandbox on'}{detail?.memory?.size?' · '+detail.memory.size.label:''}</span>{cardStatus(own).status==='ready'&&<span className="sm:hidden"><TaskContextAction task={own} compact/></span>}</span>;
  return null;
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

export { HomepageCard } from "./homepage";
