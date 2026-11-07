import { useState, type ReactNode } from "react";
import {
  UrlLink,
  useComposer,
  useComposers,
  useBbNavigate,
  experimental_useRpcMutation,
  experimental_useRpcQuery,
  type PluginAppBuilder,
  type PluginMessageDirectiveProps,
  type ExperimentalMessageMetadataProps,
} from "@get-bb/plugin-sdk/app";
import { mergeRpcContract } from "../contract-merge";
import { modelName, prLabel } from "./format";
import { toast } from "sonner";
import {
  rpcContract,
  type DecisionDto,
  type TaskDetailDto,
  type TaskDto,
  type DecisionOption,
} from "../contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  useBoard,
  useCloudAgentsNavigation,
  useTask,
  useThreadTask,
  useThreadTasks,
} from "./hooks";
import { AgentLogo, AgentBadge, OpenChatButton, PrLink, showError } from "./ui";
import { ShipButton } from "./board";
import { ResizeDialog } from "./sandbox-size";
import {
  CARD_TONES,
  cardStatus,
  contextCounts,
  markerId,
  queueDelivery,
  recommendedOption,
} from "./cards-logic";

function Frame({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "my-3 w-full max-w-[720px] overflow-hidden rounded-[10px] border border-border bg-card text-[13px] leading-5",
        className,
      )}
    >
      {children}
    </section>
  );
}
function Notice({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="my-2 rounded-lg border border-dashed border-border px-3.5 py-2.5 text-[12px] text-muted-foreground"
    >
      {children}
    </div>
  );
}
export function CardTaskState({ task }: { task: TaskDto }) {
  const state = cardStatus(task);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-[12px]",
        CARD_TONES[state.tone],
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full bg-current",
          state.moving && "motion-safe:animate-pulse",
        )}
      />
      {state.label}
    </span>
  );
}

export function LiveTaskRow({ task }: { task: TaskDto }) {
  const { openTask } = useCloudAgentsNavigation();
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3.5 py-2">
      <span className="min-w-0 flex-1">
        <button
          className="block w-full truncate rounded-sm text-left hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => openTask(task.id)}
        >
          {task.title}
        </button>
      </span>
      <span className="hidden text-[12px] text-muted-foreground sm:inline">
        {task.tier}
      </span>
      <CardTaskState task={task} />
      {task.prUrl && <PrLink url={task.prUrl} />}
      <OpenChatButton task={task} className="size-6" />
    </li>
  );
}
export function TasksDirective(props: PluginMessageDirectiveProps) {
  const id = markerId(props.attributes.thread) ?? props.message.threadId;
  const tasks = useThreadTasks(id);
  return (
    <Frame>
      <header className="px-3.5 py-2.5 font-medium">
        {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
        <span className="ml-2 font-normal text-muted-foreground">
          Live work
        </span>
      </header>
      <ul aria-label="Tasks">
        {tasks.map((task) => (
          <LiveTaskRow key={task.id} task={task} />
        ))}
      </ul>
      {tasks.length === 0 && (
        <p className="border-t border-border px-3.5 py-2 text-muted-foreground">
          No tasks in this chat yet.
        </p>
      )}
    </Frame>
  );
}

function TaskCard({
  props,
  kind,
}: {
  props: PluginMessageDirectiveProps;
  kind: "task" | "chip" | "review" | "ready" | "problem";
}) {
  const id = markerId(props.attributes.id);
  const { data, error } = useTask(id);
  if (!id) return <code>{props.source}</code>;
  if (!data?.task)
    return (
      <Notice>
        {error?.message ??
          (data ? "This task is no longer available." : "Loading task…")}
      </Notice>
    );
  const task = data.task;
  if (kind === "chip") return <TaskChip task={task} />;
  if (kind === "review") return <ReviewCard task={task} round={Number(props.attributes.round) || undefined} />;
  if (kind === "ready") return <ReadyCard task={task} />;
  if (kind === "problem") return <ProblemCard task={task} />;
  return (
    <Frame>
      <ul>
        <LiveTaskRow task={task} />
      </ul>
      {task.excerpt && (
        <p className="border-t border-border px-3.5 py-2 text-[12px] text-muted-foreground">
          {task.excerpt}
        </p>
      )}
    </Frame>
  );
}
export function TaskDirective(props: PluginMessageDirectiveProps) {
  return <TaskCard props={props} kind="task" />;
}
function TaskChip({ task }: { task: TaskDto }) {
  const { openTask } = useCloudAgentsNavigation();
  return (
    <button
      onClick={() => openTask(task.id)}
      className="mx-1 inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-secondary px-2 py-0.5 align-middle text-[12px] hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <AgentLogo provider={task.provider} />
      <span className="truncate">{task.title}</span>
      <CardTaskState task={task} />
    </button>
  );
}
function ReviewCard({ task, round }: { task: TaskDetailDto; round?: number }) {
  const { openTask } = useCloudAgentsNavigation();
  const history = experimental_useRpcQuery({contract:rpcContract,method:"history",input:{taskId:task.id,limit:100}}).data?.events;
  const entry=history?.find(event=>event.review && (!round || event.review.round===round) && event.kind==='review-verdict');
  const review=entry?.review;
  const detail=(entry as (typeof entry & {detail?:string|null}))?.detail;
  const verdict=review?.verdict ?? task.verdict;
  const approved=verdict==='approve'||verdict==='approved';
  const changes=verdict==='changes-requested';
  const provider=review?.provider??task.provider;
  const name=provider==='codex'?'Codex':'Claude';
  const findings=review?.findings??[];
  const heading=approved?`${name} approved`:changes?`${name} asked for ${findings.length || 'some'} changes`:cardStatus(task).moving?`${name} reviewing…`:'The review couldn’t run';
  return <Frame className={approved?'border-[#5BD08A]/15 bg-[#5BD08A]/[0.06]':'bg-[#191919]'}>
    <div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
      <AgentLogo provider={provider}/><span className={approved?'text-[#B8DEC6]':'text-foreground'}>{heading}</span>
      <span className="text-[12px] text-muted-foreground">{detail??(review?`Review ${review.round}${review.model?' · '+review.model:''}${review.freshContext?' · fresh context':''}`:task.model)}</span>
      <button className="ml-auto text-[12px] text-muted-foreground hover:underline" onClick={()=>openTask(review?.reviewTaskId??task.id)}>Full review</button>
    </div>
    {!approved && findings.length>0 && <ul className="space-y-1 px-[36px] pb-3">{findings.map((finding,index)=><li key={index} className="flex gap-4 text-[13px] leading-5"><span className={cn('w-[44px] shrink-0 whitespace-nowrap text-[12px]',finding.severity==='must-fix'?'text-[#FC8C45]':'text-muted-foreground')}>{finding.label??(finding.severity==='must-fix'?'Must fix':'Should')}</span><span className="text-muted-foreground">{finding.text}</span></li>)}</ul>}
    {!approved && !findings.length && task.error && <p className="px-3.5 pb-3 text-[12px] text-muted-foreground">{task.error}</p>}
  </Frame>;
}

/** Uses the pane's composer; never sends an own-words answer automatically. */
function useFillComposer(threadId: string) {
  const composers = useComposers();
  const composer = composers.find(
    (item) => item.scope.kind === "thread" && item.scope.threadId === threadId,
  );
  return composer
    ? (text: string) => {
        composer.replace((current) => ({
          text: current.text ? `${current.text}\n\n${text}` : text,
          mentions: current.mentions,
        }));
        composer.focus();
      }
    : null;
}
/** A single suitable action for context cards and the host header. */
export function TaskContextAction({ task }: { task: TaskDto }) {
  const merge=experimental_useRpcMutation({contract:mergeRpcContract,method:"requestMerge"});
  const state = cardStatus(task);
  const resume = experimental_useRpcMutation({
    contract: rpcContract,
    method: "sandboxAction",
  });
  const run = async () => {
    if (!task.sandboxId) return;
    try {
      await resume.mutate({ id: task.sandboxId, action: "resume" });
    } catch (error) {
      showError(error);
    }
  };
  if (state.status === "stopped" && task.sandboxId)
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={resume.isPending}
        onClick={() => void run()}
      >
        {resume.isPending ? "Resuming…" : "Resume"}
      </Button>
    );
  if (state.status === "ready" && task.canShip)
    return <ShipButton task={task} />;
  if (state.status === "ready" && task.prUrl)
    return <Button size="sm" disabled={merge.isPending} onClick={()=>void merge.mutate({id:task.id,from:"chat"}).catch(showError)}>Merge PR {prLabel(task.prUrl)}</Button>;
  return null;
}

function ReadyCard({ task }: { task: TaskDetailDto }) {
  const state = cardStatus(task);
  const shipped = state.status === "shipped";
  return <p className="my-4 flex flex-wrap items-center gap-2 text-[12px] leading-5 text-muted-foreground">
    <span className="size-1.5 rounded-full bg-[#5BD08A]" aria-hidden />
    <span>{shipped ? "Shipped" : "Ready for you"}{task.source.title ? ` · ${task.source.title} was told` : ""}{!shipped && task.previewUrl ? " · sandbox stays on so the preview keeps working" : ""}</span>
  </p>;
}

export function ProblemCard({ task }: { task: TaskDetailDto }) {
  const state = cardStatus(task);
  const [resizing, setResizing] = useState(false);
  const resume = experimental_useRpcMutation({
    contract: rpcContract,
    method: "sandboxAction",
  });
  const { openTask } = useCloudAgentsNavigation();
  const oom = task.memory?.oom?.cause === true && !task.memory.oom.movedTo;
  const stopped = state.status === "stopped";
  const waiting = state.status === "waiting-reset";
  const broken = oom || state.status === "broken";
  const run = async () => {
    if (!task.sandboxId) return;
    try {
      await resume.mutate({ id: task.sandboxId, action: "resume" });
    } catch (error) {
      showError(error);
    }
  };
  return (
    <Frame className={broken ? "border-[#E06C6C]/30" : undefined}>
      <div className="flex flex-wrap items-center gap-3 px-3.5 py-3">
        <Icon
          name={broken ? "CircleAlert" : "Pause"}
          className={cn(
            "size-3.5 shrink-0",
            broken ? "text-[#E06C6C]" : "text-muted-foreground",
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {oom
              ? "The task ran out of memory"
              : stopped
                ? "The sandbox is stopped"
                : waiting
                  ? "Waiting for the usage limit to reset"
                  : broken
                    ? "The task couldn’t continue"
                    : state.label}
          </p>
          <p className="break-words text-[12px] text-muted-foreground">
            {state.reason ||
              task.error ||
              (stopped
                ? "Resume to continue working."
                : "Open the task for details.")}
          </p>
          {oom && (
            <p className="text-[12px] text-[#FC8C45]">
              A larger sandbox may cost more. Review the size and cost before
              continuing.
            </p>
          )}
        </div>
        {oom && task.memory?.canResize ? (
          <Button size="sm" variant="outline" onClick={() => setResizing(true)}>
            Continue on a larger sandbox
          </Button>
        ) : stopped && task.sandboxId ? (
          <Button
            size="sm"
            variant="outline"
            disabled={resume.isPending}
            onClick={() => void run()}
          >
            {resume.isPending ? "Resuming…" : "Resume"}
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => openTask(task.id)}>
            Open task
          </Button>
        )}
      </div>
      <ResizeDialog
        task={task}
        mode="oom"
        open={resizing}
        onOpenChange={setResizing}
      />
    </Frame>
  );
}

export function DecisionCard({
  decision,
  threadId,
}: {
  decision: DecisionDto;
  threadId: string;
}) {
  const [queued, setQueued] = useState<null | {
    cancel: () => boolean;
    answer: string;
  }>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const send = experimental_useRpcMutation({
    contract: rpcContract,
    method: "answerDecision",
  });
  const fill = useFillComposer(threadId);
  const options = [
    ...new Set(
      decision.options.length ? decision.options : [decision.recommendation],
    ),
  ].filter(Boolean);
  const richer = decision;
  const details: DecisionOption[] = decision.optionDetails?.length ? decision.optionDetails : options.map(label => ({label}));
  const recommended = details.find(option => option.recommended)?.label ?? recommendedOption(options, decision.recommendation);
  const columns = [...new Set(details.flatMap(option => Object.keys(option.facts ?? {})))];
  const asked = useTask(richer.askedByTaskId ?? decision.taskIds[0] ?? null).data?.task;
  const ageMinutes = Math.max(0, Math.floor((Date.now() - Date.parse(decision.createdAt)) / 60000));
  const busy = queued !== null || send.isPending;
  const choose = (answer: string) => {
    if (busy) return;
    const cancel = queueDelivery(async () => {
      setQueued(null);
      try {
        const result = await send.mutate({
          id: decision.id,
          accept: answer === recommended,
          answer: answer === recommended ? null : answer,
        });
        setOutcome(
          result.delivered
            ? `You chose ${answer}`
            : "Answer saved. The chat is no longer available for delivery.",
        );
      } catch (error) {
        showError(error);
      }
    });
    setQueued({ cancel, answer });
    toast("Answer queued", {
      duration: 4000,
      description: answer,
      action: {
        label: "Undo",
        onClick: () => {
          if (cancel()) setQueued(null);
        },
      },
    });
  };
  const closed = decision.status !== "open" || outcome !== null;
  if (closed && !expanded)
    return (
      <Frame>
        <div className="flex items-center gap-2 px-3.5 py-2 text-[12px] text-muted-foreground">
          <Icon name="Check" className="size-3.5" />
          <span className="min-w-0 flex-1 break-words">
            {outcome ??
              (decision.status === "answered"
                ? `You chose ${decision.answer ?? "the recommendation"}`
                : "Decision withdrawn")}
          </span>
          <button
            className="shrink-0 hover:text-foreground"
            onClick={() => setExpanded(true)}
          >
            Show options
          </button>
        </div>
      </Frame>
    );
  return (
    <Frame className="border-[#F0B135]/20 bg-[#191919]">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3.5 py-2 text-[12px]">
        <span className="inline-flex items-center gap-1.5 text-[#F0B135]"><span className="size-1.5 rounded-full bg-current" />{closed ? "Decision answered" : "Needs you"}</span>
        <span className="text-muted-foreground">{asked ? `asked by ${asked.title} · ` : ""}{ageMinutes < 1 ? "just now" : `${ageMinutes} min ago`}</span>
      </header>
      <div className="space-y-3 p-3.5">
        <div>
          <p className="text-[16px] font-normal leading-6">{decision.question}</p>
          {richer.context && <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{richer.context}</p>}
        </div>
        <div className="hidden sm:block">
          <table className="w-full table-fixed text-left text-[13px] leading-5">
            <thead className="text-[12px] font-normal text-muted-foreground"><tr className="h-7 border-b border-border"><th className="font-normal">Option</th>{columns.map(column=><th key={column} className="w-[110px] font-normal">{column}</th>)}{details.some(option=>option.verdict) && <th className="w-[190px] font-normal">{details.find(option=>option.verdict?.label)?.verdict?.label ?? "Fit"}</th>}</tr></thead>
            <tbody>{details.map(option=><tr key={option.label} className="h-[38px] border-b border-border last:border-0"><td><span>{option.label}</span>{option.label===recommended && <span className="ml-2 rounded-sm bg-[#7AA7FF]/10 px-1.5 py-0.5 text-[10px] text-[#7AA7FF]">Recommended</span>}{option.summary && <span className="block text-[12px] text-muted-foreground">{option.summary}</span>}</td>{columns.map(column=><td key={column} className="text-muted-foreground">{String(option.facts?.[column] ?? "—")}</td>)}{details.some(item=>item.verdict) && <td className={option.verdict?.tone==='good'?'text-[#5BD08A]':option.verdict?.tone==='caution'?'text-[#FC8C45]':'text-[#E06C6C]'}>{option.verdict?.text}</td>}</tr>)}</tbody>
          </table>
        </div>
        <div className="space-y-3 sm:hidden">{details.map(option=><div key={option.label} className="border-t border-border pt-2"><p>{option.label}{option.label===recommended && <span className="ml-2 text-[10px] text-[#7AA7FF]">Recommended</span>}</p>{columns.map(column=><p key={column} className="text-[12px] text-muted-foreground">{column}: {String(option.facts?.[column]??"—")}</p>)}{option.verdict && <p className={option.verdict.tone==='good'?'text-[#5BD08A]':option.verdict.tone==='caution'?'text-[#FC8C45]':'text-[#E06C6C]'}>{option.verdict.text}</p>}<Button size="sm" variant={option.label===recommended?'default':'outline'} className="mt-2 w-full" disabled={busy||closed} onClick={()=>choose(option.label)}>Go with {option.label}</Button></div>)}</div>
        {queued ? (
          <div role="status" className="flex items-center gap-3 text-[12px]">
            <span className="min-w-0 flex-1">Queued: {queued.answer}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (queued.cancel()) setQueued(null);
              }}
            >
              Undo
            </Button>
          </div>
        ) : (
          !closed && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="hidden flex-wrap gap-2 sm:flex">{options.map(option=><Button key={option} size="sm" variant={option===recommended?'default':'outline'} disabled={busy} onClick={()=>choose(option)} className="h-[30px] px-3 text-[12px] font-normal">Go with {option}</Button>)}</div>
              {fill && (
                <button
                  className="py-1 text-left text-[12px] text-muted-foreground hover:text-foreground sm:ml-auto"
                  disabled={send.isPending}
                  onClick={() => fill(`${decision.question}\n\n`)}
                >
                  Answer in your own words
                </button>
              )}
            </div>
          )
        )}
      </div>
    </Frame>
  );
}
export function DecisionDirective(props: PluginMessageDirectiveProps) {
  const id = markerId(props.attributes.id);
  const query = experimental_useRpcQuery({
    contract: rpcContract,
    method: "decision",
    input: { id: id ?? "" },
    enabled: id !== null,
  });
  if (!id) return <code>{props.source}</code>;
  if (!query.data?.decision)
    return (
      <Notice>
        {query.error?.message ??
          (query.data
            ? "This decision is no longer available."
            : "Loading decision…")}
      </Notice>
    );
  return (
    <DecisionCard
      decision={query.data.decision}
      threadId={props.message.threadId}
    />
  );
}
export function DigestDirective(props: PluginMessageDirectiveProps) {
  const threadId = markerId(props.attributes.thread) ?? props.message.threadId;
  const board = useBoard(threadId).data;
  if (!board) return null;
  const tasks = [...board.ready, ...board.running, ...board.done];
  if (!tasks.length && !board.needsYou.length) return null;
  return (
    <Frame>
      <header className="px-3.5 py-2.5 font-medium">
        Work update
        <span className="ml-2 text-[12px] font-normal text-muted-foreground">
          {contextCounts(
            tasks,
            board.needsYou.length,
            board.needsYou.flatMap((item) => item.taskIds),
          )}
        </span>
      </header>
      {board.needsYou.map((decision) => (
        <DecisionCard
          key={decision.id}
          decision={decision}
          threadId={threadId}
        />
      ))}
      <ul>
        {tasks.map((task) => (
          <LiveTaskRow key={task.id} task={task} />
        ))}
      </ul>
    </Frame>
  );
}
/** Only actual recorded switches become a handoff note. */
export function HandoffDirective(props: PluginMessageDirectiveProps) {
  const threadId = markerId(props.attributes.thread) ?? props.message.threadId;
  const own = useThreadTask(threadId);
  const detail = useTask(own?.id ?? null).data?.task;
  const event = detail?.events
    .filter((item) =>
      ["failover", "followup-switch", "moved-to-chat"].includes(item.kind),
    )
    .at(-1);
  if (!event) return null;
  return (
    <aside className="my-3 flex items-start gap-2 border-t border-border py-2 text-[12px] text-muted-foreground">
      <Icon name="ArrowRight" className="mt-0.5 size-3 shrink-0" />
      <span>{event.text}</span>
    </aside>
  );
}

function StoppedComposerBanner() {
  const composer = useComposer();
  const threadId =
    composer.scope.kind === "thread" ? composer.scope.threadId : "";
  const task = useThreadTask(threadId);
  const detail = useTask(task?.id ?? null).data?.task;
  if (
    !task ||
    !["stopped", "broken", "waiting-reset"].includes(cardStatus(task).status)
  )
    return null;
  if (!detail) return null;
  return <StoppedBanner task={detail} />;
}
function StoppedBanner({task}:{task:TaskDetailDto}) {
  const [resizing,setResizing]=useState(false);
  const resume=experimental_useRpcMutation({contract:rpcContract,method:"sandboxAction"});
  const state=cardStatus(task);
  const oom=Boolean(task.memory?.oom?.cause && !task.memory.oom.movedTo);
  return <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-secondary px-3 py-2 text-[12px] text-muted-foreground">
    <Icon name="Pause" className="size-3.5" />
    <span className="min-w-0 flex-1">{state.status==='waiting-reset'?'Waiting for a reset · work is saved':oom?'Sandbox stopped · out of memory · work is saved':'Sandbox stopped · nothing lost'}</span>
    <Button size="sm" variant="outline" disabled={resume.isPending} onClick={()=>{if(oom)setResizing(true);else if(task.sandboxId)void resume.mutate({id:task.sandboxId,action:'resume'}).catch(showError)}}>{oom?'Continue on Large':'Resume'}</Button>
    <ResizeDialog task={task} mode="oom" open={resizing} onOpenChange={setResizing}/>
  </div>;

}

/** Agent-dispatched briefs retain provenance using bb's above-message slot. */
function BriefMetadata({message}:ExperimentalMessageMetadataProps){
  const task=useThreadTask(message.threadId);
  if(message.role!=="user" || message.initiator!=="agent" || !task?.source.title)return null;
  return <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground"><AgentLogo provider={task.provider}/>Brief from {task.source.title}{task.tier?' · '+task.tier[0].toUpperCase()+task.tier.slice(1):''}{task.model?' · '+modelName(task.model):''}</span>;
}

export function registerChatCards(app: PluginAppBuilder): void {
  app.slots.experimental_messageMetadata({id:"boat-brief",placement:"above",component:BriefMetadata});
  app.composer.customize({
    id: "boat-sandbox-status",
    scopes: ["thread"],
    banners: [
      {
        id: "sandbox-status",
        chrome: "bare",
        component: StoppedComposerBanner,
      },
    ],
  });
  app.slots.messageDirective({ id: "boat-task", component: TaskDirective });
  app.slots.messageDirective({ id: "boat-tasks", component: TasksDirective });
  app.slots.messageDirective({
    id: "boat-chip",
    component: (props) => <TaskCard props={props} kind="chip" />,
  });
  app.slots.messageDirective({
    id: "boat-review",
    component: (props) => <TaskCard props={props} kind="review" />,
  });
  app.slots.messageDirective({
    id: "boat-ready",
    component: (props) => <TaskCard props={props} kind="ready" />,
  });
  app.slots.messageDirective({
    id: "boat-decision",
    component: DecisionDirective,
  });
  app.slots.messageDirective({
    id: "boat-problem",
    component: (props) => <TaskCard props={props} kind="problem" />,
  });
  app.slots.messageDirective({ id: "boat-digest", component: DigestDirective });
  app.slots.messageDirective({
    id: "boat-handoff",
    component: HandoffDirective,
  });
}
