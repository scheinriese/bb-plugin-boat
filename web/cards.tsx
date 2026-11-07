import { useEffect, useState, type ReactNode } from "react";
import {
  UrlLink,
  useComposer,
  useSdk,
  useComposers,
  useBbNavigate,
  experimental_useRpcMutation,
  experimental_useRpcQuery,
  type PluginAppBuilder,
  type PluginMessageDirectiveProps,
  type ExperimentalMessageMetadataProps,
} from "@get-bb/plugin-sdk/app";
import { useOpenTaskSection } from "./task-navigation";
import { mergeRpcContract } from "../contract-merge";
import { modelName, prLabel, clockTime } from "./format";
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
  useProjects,
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
        "boat-ui my-3 -ml-2 w-[calc(100%+16px)] sm:ml-0 sm:w-[calc(100%+8px)] max-w-[720px] overflow-hidden rounded-[12px] sm:rounded-[10px] border border-border bg-card text-[13px] leading-5",
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

export function LiveTaskRow({ task,waiting=false,reviewer }: { task: TaskDto;waiting?:boolean;reviewer?:string }) {
  const { openTask } = useCloudAgentsNavigation();
  const state=cardStatus(task);
  return (
    <li className="flex items-center gap-[10px] border-t border-[#242424] px-[12px] py-[10px]">
      <span className="relative flex size-5 shrink-0 items-center justify-center">{state.moving&&<span aria-hidden className="absolute inset-0 rounded-full border border-[#2C2C2C] border-t-muted-foreground motion-safe:animate-spin"/>}<AgentLogo provider={task.provider} className="size-[13px]"/></span>
      <span className="min-w-0 flex-1">
        <button
          className="block w-full truncate rounded-sm text-left text-[14px] leading-5 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => openTask(task.id)}
        >
          {task.title}
        </button>
      </span>
      <span className={cn('shrink-0 text-[13px] leading-[18px]',waiting?'text-[#F0B135]':state.status==='ready'?'text-[#5BD08A]':'text-muted-foreground')}>{waiting?'● Needs you':state.status==='review'?`${reviewer?reviewer+' ':''}reviewing`:state.status==='ready'?`${task.prUrl?'PR '+prLabel(task.prUrl)+' · ':''}Ready`:state.label}</span>
    </li>
  );
}
export function TasksDirective(props: PluginMessageDirectiveProps) {
  const id = markerId(props.attributes.thread) ?? props.message.threadId;
  const tasks = useThreadTasks(id).filter(task=>task.role!=='review'&&!['done','cancelled'].includes(task.status)).sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt));
  const board=useBoard(id).data;
  const projects=useProjects().data?.projects??[];
  const project=projects.find(project=>project.repos[0]?.repo===tasks[0]?.repo)??projects.find(project=>project.repos.some(repo=>repo.repo===tasks[0]?.repo));
  const events=experimental_useRpcQuery({contract:rpcContract,method:'history',input:{orchestratorThreadId:id,limit:100}}).data?.events??[];
  return (
    <Frame className="border-[#2A2A2A] bg-[#181818]">
      <header className="px-[12px] py-[10px] text-[14px] font-medium leading-5">
        {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
        <span className="ml-2 text-[13px] font-normal text-muted-foreground">
          {project?.name}
        </span>
      </header>
      <ul aria-label="Tasks">
        {tasks.map((task) => (
          <LiveTaskRow key={task.id} task={task} waiting={board?.needsYou.some(decision=>decision.taskIds.includes(task.id))} reviewer={events.find(event=>event.taskId===task.id&&event.kind==='review-started')?.review?.provider==='codex'?'Codex':events.find(event=>event.taskId===task.id&&event.kind==='review-started')?.review?.provider==='claude'?'Claude':undefined}/>
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
  if (kind === "problem") return <ProblemCard task={task} stage={typeof props.attributes.stage==='string'?props.attributes.stage.slice(0,120):undefined} />;
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
      <span className="hidden truncate sm:inline">{task.title}</span><span className="truncate sm:hidden">{task.compactTitle??task.title}</span>
      <CardTaskState task={task} />
    </button>
  );
}
function ReviewCard({ task, round }: { task: TaskDetailDto; round?: number }) {
  const { openTask } = useCloudAgentsNavigation();
  const openSection=useOpenTaskSection();
  const history = experimental_useRpcQuery({contract:rpcContract,method:"history",input:{taskId:task.id,limit:100}}).data?.events;
  if(!history)return <Frame><p className="px-3.5 py-3 text-[12px] text-muted-foreground">Loading review…</p></Frame>;
  const entry=history?.find(event=>event.review && (!round || event.review.round===round) && event.kind==='review-verdict');
  const review=entry?.review;
  const detail=entry?.detail;
  const verdict=review?.verdict ?? (round?null:task.verdict);
  const approved=verdict==='approve'||verdict==='approved';
  const changes=verdict==='changes-requested';
  const provider=review?.provider??task.provider;
  const name=provider==='codex'?'Codex':'Claude';
  const findings=review?.findings??[];
  const heading=approved?`${name} approved`:changes?`${name} asked for ${findings.length || 'some'} changes`:cardStatus(task).moving?`${name} reviewing…`:round&&!entry?`Review ${round} is no longer available`:task.error?'The review couldn’t run':'Review details are unavailable';
  return <Frame className={approved?'border-[#23362A] bg-[#16201A]':'border-[#2A2A2A] bg-[#181818]'}>
    <div className="flex flex-wrap items-center gap-x-[8px] gap-y-[4px] px-[14px] py-[12px] sm:py-[10px]">
      <AgentLogo provider={provider}/><span className={cn('order-1 text-[15px] leading-5 sm:text-[13px]',approved?'font-medium text-[#BFEFD0]':'font-medium text-foreground')}>{heading}</span>
      <span className={cn("order-3 basis-full pl-[22px] text-[13px] leading-[18px] sm:order-2 sm:basis-auto sm:pl-0 sm:text-[12px] sm:leading-[16px]",approved?"text-[#7FA88C]":"text-muted-foreground")}>{detail??(review?`Review ${review.round}${review.model?' · '+review.model:''}${review.freshContext?' · fresh context':''}`:task.model)}</span>
      <button className={cn("order-2 ml-auto text-[13px] leading-[18px] hover:underline sm:order-3 sm:text-[12px] sm:leading-4",approved?"text-[#7FA88C]":"text-muted-foreground")} onClick={()=>{if(!task.threadId||!openSection(task.threadId,"Reviews"))openTask(task.id)}}>Full review</button>
    </div>
    {!approved && findings.length>0 && <ul className="space-y-[6px] pl-[36px] pr-[14px] pb-3">{findings.map((finding,index)=><li key={index} className="flex gap-[8px] text-[13px] leading-5"><span className={cn('w-[52px] shrink-0 whitespace-nowrap text-[12px]',finding.severity==='must-fix'?'text-[#FC8C45]':'text-muted-foreground')}>{finding.label??(finding.severity==='must-fix'?'Must fix':'Should')}</span><span className="text-muted-foreground">{finding.text}</span></li>)}</ul>}
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
export function TaskContextAction({ task,compact=false,className }: { task: TaskDto;compact?:boolean;className?:string }) {
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
    return <Button size="sm" className={cn("h-[30px] bg-primary px-3 text-primary-foreground",className)} disabled={merge.isPending} onClick={()=>void merge.mutate({id:task.id,from:"chat"}).catch(showError)}>{compact?'Merge':`Merge PR ${prLabel(task.prUrl)}`}</Button>;
  return null;
}

function ReadyCard({ task }: { task: TaskDetailDto }) {
  const state=cardStatus(task);const shipped=state.status==='shipped';
  return <p className="boat-ui my-4 -ml-2 flex w-[calc(100%+16px)] items-center gap-2 py-[2px] text-[13px] leading-[18px] text-muted-foreground sm:ml-0 sm:w-auto sm:items-start sm:text-[12px] sm:leading-4"><span className="size-1.5 shrink-0 rounded-full bg-[#5BD08A] sm:mt-[5px]" aria-hidden/><span>{shipped?'Shipped':'Ready for you'}<span className="hidden sm:inline">{task.source.title?` · ${task.source.title} was told`:''}{!shipped&&task.previewUrl?' · sandbox stays on so the preview keeps working':''}</span><span className="sm:hidden">{!shipped&&task.previewUrl?' · the sandbox stays on so the preview keeps working':''}</span></span></p>;
}

export function ProblemCard({ task,stage }: { task: TaskDetailDto;stage?:string }) {
  const state = cardStatus(task);
  const [resizing, setResizing] = useState(false);
  const resume = experimental_useRpcMutation({
    contract: rpcContract,
    method: "sandboxAction",
  });
  const { openTask } = useCloudAgentsNavigation();
  const openSection=useOpenTaskSection();
  const events=experimental_useRpcQuery({contract:rpcContract,method:'history',input:{taskId:task.id,limit:100}}).data?.events??[];
  const stop=events.find(event=>event.kind==='stopped' && /memory/i.test(event.cause??event.text));
  const idleStop=events.find(event=>event.kind==='stopped'&&event.cause==='idle-timeout');
  const nextMemory=task.memory?.next?.detail.match(/([\d.]+) GB/)?.[1];
  const nextCost=task.memory?.next?.detail.includes('double rate')?`${task.memory.next.label} costs 2× per hour`:task.memory?.next?.detail;
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
  return <><Frame className={cn('space-y-[10px] px-[14px] py-[12px]',broken&&'border-[#3D3420] bg-[#181818]')}>
    <header className="flex flex-wrap items-center gap-2"><Icon name={oom?'Cpu':'Pause'} className="size-3.5 text-[#FC8C45]"/><span>{oom?'Out of memory':waiting?'Waiting for a reset':stopped?'Sandbox stopped':state.label}</span>{task.memory?.size&&<span className="text-[12px] text-muted-foreground">{task.memory.size.label} sandbox{task.memory.peak?' · '+task.memory.peak.totalGb+' GB':''}{stage?' · '+stage:''}{stop?' · '+new Date(stop.at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}).toLowerCase():''}</span>}</header>
    <div className="space-y-[10px] pl-[22px]"><p className="text-[13px] leading-5 text-[#C1C1C1]">{stop?.detail??(oom?'The sandbox ran out of memory. Continue on a larger sandbox to pick up where it stopped.':state.reason??task.error??'Your next message resumes the sandbox.')}</p>
    {task.memory?.peak&&<div className="flex flex-wrap items-center gap-[10px]"><div className="h-1.5 w-[260px] max-w-full rounded-full bg-secondary"><div className="h-full rounded-full bg-[#E06C6C]" style={{width:Math.min(100,task.memory.peak.percent)+'%'}}/></div><span className="text-[12px] leading-4 text-muted-foreground">Peak {task.memory.peak.usedGb.toFixed(1)} of {task.memory.peak.totalGb} GB{task.memory.next?' · '+task.memory.next.label+(nextMemory?' has '+nextMemory+' GB':''):''}</span></div>}
    <div className="flex flex-wrap items-center gap-2 pt-[2px]">{oom&&task.memory?.canResize?<Button size="sm" className="h-[26px] px-3 text-[12px] leading-4" onClick={()=>setResizing(true)}>Continue on a larger sandbox</Button>:stopped&&task.sandboxId?<Button size="sm" variant="outline" disabled={resume.isPending} onClick={()=>void run()}>Resume</Button>:null}<Button size="sm" variant="outline" className="h-7 px-3 text-[12px] font-normal leading-4" onClick={()=>{if(!task.threadId||!openSection(task.threadId,"Transcript"))openTask(task.id)}}>Open transcript</Button>{oom&&nextCost&&<span className="text-[12px] text-muted-foreground">{nextCost}</span>}</div></div>
    <ResizeDialog task={task} mode="oom" open={resizing} onOpenChange={setResizing}/>
  </Frame>{idleStop&&<p className="boat-ui my-3 flex gap-2 text-[12px] leading-4 text-muted-foreground"><span aria-hidden>•</span>{clockTime(idleStop.at).replace(/^0/,'').toLowerCase()} · {idleStop.text}{idleStop.detail?' · '+idleStop.detail:''}</p>}</>;
}

export function DecisionCard({
  decision,
  threadId,
  compact=false,
}: {
  decision: DecisionDto;
  threadId: string;
  compact?:boolean;
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
  if(compact)return <section className="border-t border-border bg-[#F0B135]/[0.03] px-3.5 py-3">
    <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px] leading-4"><span className="inline-flex items-center gap-1.5 text-[#F0B135]"><span className="size-1.5 rounded-full bg-current"/>Needs you</span><span className="text-muted-foreground">{asked?.title??''} · asked {clockTime(decision.createdAt).replace(/^0/,'').toLowerCase()}</span></div>
    <p className="ml-3.5 text-[13px] leading-5">{decision.question}{decision.context?' '+decision.context:''}</p>
    <div className="ml-3.5 mt-2 flex flex-wrap items-center gap-2">{closed?<span className="text-[12px] text-muted-foreground">{outcome??decision.answer}</span>:queued?<><span className="text-[12px]">Queued: {queued.answer}</span><Button size="sm" variant="outline" onClick={()=>{if(queued.cancel())setQueued(null)}}>Undo</Button></>:options.map(option=><Button key={option} size="sm" variant={option===recommended?'default':'outline'} disabled={busy} className={cn("h-7 px-3 text-[12px] leading-4",option===recommended?"font-medium":"font-normal")} onClick={()=>choose(option)}>Go with {option}</Button>)}{recommended&&!closed&&<span className="text-[12px] text-muted-foreground">Recommended: {recommended}</span>}</div>
  </section>;
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
    <Frame className="border-[#3D3420] bg-[#181818] p-[12px] sm:p-0">
      <header className="flex flex-wrap items-center gap-x-[7px] gap-y-1 border-[#242424] text-[13px] leading-[18px] sm:border-b sm:px-3.5 sm:py-[10px] sm:text-[12px] sm:leading-[16px]">
        <span className="inline-flex items-center gap-1.5 text-[#F0B135]"><span className="size-1.5 rounded-full bg-current" />{closed ? "Decision answered" : "Needs you"}</span>
        <span className="text-muted-foreground"><span className="hidden sm:inline">{asked ? `asked by ${asked.title} · ` : ""}</span><span className="sm:hidden">{asked ? `${asked.compactTitle??asked.title} · ` : ""}</span>{ageMinutes < 1 ? "just now" : `${ageMinutes} min ago`}</span>
      </header>
      <div className="space-y-[10px] pt-[10px] sm:space-y-3 sm:p-3.5">
        <div>
          <p className="text-[16px] font-medium leading-[22px] sm:font-normal sm:leading-6">{decision.question}</p>
          {richer.context && <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{richer.context}</p>}
        </div>
        <div className="hidden sm:block">
          <table className="w-full table-fixed text-left text-[13px] leading-5">
            <thead className="text-[12px] font-normal text-muted-foreground"><tr className="h-7 border-b border-[#262626]"><th className="font-normal">Option</th>{columns.map(column=><th key={column} className="w-[110px] font-normal">{column}</th>)}{details.some(option=>option.verdict) && <th className="w-[190px] font-normal">{details.find(option=>option.verdict?.label)?.verdict?.label ?? "Fit"}</th>}</tr></thead>
            <tbody>{details.map(option=><tr key={option.label} className="h-[38px] border-b border-[#262626] last:border-0"><td><span>{option.label}</span>{option.label===recommended && <span className="ml-2 rounded-sm bg-[#20314E] px-1.5 py-0.5 text-[10px] text-[#7AA7FF]">Recommended</span>}{option.summary && <span className="block text-[12px] text-muted-foreground">{option.summary}</span>}</td>{columns.map(column=><td key={column} className="text-muted-foreground">{String(option.facts?.[column] ?? "—")}</td>)}{details.some(item=>item.verdict) && <td className={option.verdict?.tone==='good'?'text-[#5BD08A]':option.verdict?.tone==='caution'?'text-[#FC8C45]':'text-[#E06C6C]'}>{option.verdict?.text}</td>}</tr>)}</tbody>
          </table>
        </div>
        <div className="space-y-[10px] sm:hidden">{details.map(option=><div key={option.label} className={cn("flex flex-col gap-[8px] rounded-[10px] border p-[12px]",option.label===recommended?"border-[#2A3A55] bg-[#1A2230]":"border-[#262626]")}><p className="flex flex-wrap items-center gap-[8px] text-[15px] font-medium leading-5">{option.label}{option.label===recommended && <span className="rounded-[4px] bg-[#1E2A3D] px-[6px] py-px text-[12px] font-normal leading-4 text-[#7AA7FF]">Recommended</span>}</p>{option.summary&&<p className="text-[14px] leading-5 text-[#A8A8A8]">{option.summary}</p>}{columns.map(column=><p key={column} className="text-[13px] leading-5 text-muted-foreground">{column}: {String(option.facts?.[column]??"—")}</p>)}{option.verdict && <p className={option.verdict.tone==='good'?'text-[#5BD08A]':option.verdict.tone==='caution'?'text-[#FC8C45]':'text-[#E06C6C]'}>{option.verdict.text}</p>}<Button size="sm" variant={option.label===recommended?'default':'outline'} className={cn("h-[40px] w-full rounded-[8px] text-[14px] leading-5",option.label===recommended?"bg-[#E6E6E6] font-medium text-[#141414]":"border-[#333333] font-normal text-[#D0D0D0]")} disabled={busy||closed} onClick={()=>choose(option.label)}>Go with {option.label}</Button></div>)}</div>
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
              <div className="hidden flex-wrap gap-2 sm:flex">{options.map(option=><Button key={option} size="sm" variant={option===recommended?'default':'outline'} disabled={busy} onClick={()=>choose(option)} className={cn("h-[30px] px-3 text-[12px] font-normal",option===recommended&&"bg-[#E6E6E6] text-[#181818]")}>Go with {option}</Button>)}</div>
              {fill && (
                <button
                  className="w-full pt-[2px] text-center text-[14px] leading-5 text-muted-foreground hover:text-foreground sm:ml-auto sm:w-auto sm:py-1 sm:text-left sm:text-[12px]"
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
  return <>
    <DecisionCard
      decision={query.data.decision}
      threadId={props.message.threadId}
    />
    <SuggestedFollowups threadId={props.message.threadId} attributes={props.attributes}/>
  </>;
}
/** Suggestions are authored with the message, never generated from task titles. */
function SuggestedFollowups({threadId,attributes}:{threadId:string;attributes:PluginMessageDirectiveProps['attributes']}) {
  const fill=useFillComposer(threadId);
  const suggestions=['followup1','followup2','followup3'].flatMap(key=>{
    const value=attributes[key];return typeof value==='string'&&value.trim()&&value.length<=200?[value.trim()]:[];
  });
  if(!fill||!suggestions.length)return null;
  return <div className="boat-ui my-4 w-full max-w-[720px] sm:w-[calc(100%+8px)]" aria-label="Suggested follow-ups">{suggestions.map(text=><button key={text} type="button" onClick={()=>fill(text)} className="flex w-full items-center justify-between gap-3 border-b border-border py-[10px] text-left text-[13px] leading-5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"><span>{text}</span><Icon name="ArrowRight" className="size-3.5 shrink-0"/></button>)}</div>;
}
export function DigestDirective(props: PluginMessageDirectiveProps) {
  const threadId=markerId(props.attributes.thread)??props.message.threadId;
  const since=typeof props.attributes.since==='string'&&Number.isFinite(Date.parse(props.attributes.since))?new Date(props.attributes.since).toISOString():undefined;
  const board=useBoard(threadId).data;
  const history=experimental_useRpcQuery({contract:rpcContract,method:'history',input:{orchestratorThreadId:threadId,since,limit:100}}).data?.events??[];
  if(!board)return null;
  const ready=board.ready.filter(task=>task.role!=='review').sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt));
  const decisions=board.needsYou;
  const terminal=history.filter(event=>['merged','shipped'].includes(event.kind)).slice(0,3);
  const linked=new Set(decisions.flatMap(decision=>decision.taskIds));
  const active=board.running.filter(task=>task.role!=='review'&&!linked.has(task.id)&&cardStatus(task).moving);
  return <Frame className="border-[#2A2A2A] bg-[#181818]">
    <header className="flex flex-wrap items-center gap-2 px-3.5 py-3 text-[13px] font-medium">While you were away{since&&<span className="text-[12px] text-muted-foreground">since {clockTime(since).replace(/^0/,'').toLowerCase()} · {Math.floor((Date.now()-Date.parse(since))/3600000)} h</span>}<span className="ml-auto text-[12px] text-[#5BD08A]">{ready.length} ready</span>{decisions.length>0&&<span className="text-[12px] text-[#F0B135]">{decisions.length} needs you</span>}</header>
    {decisions.map(decision=><DecisionCard key={decision.id} decision={decision} threadId={threadId} compact/>)}
    <ul className="border-y border-[#242424] px-3.5 py-1">{ready.map(task=><li key={task.id} className="flex min-h-11 flex-wrap items-center gap-[10px] border-b border-[#222222] last:border-0"><span className="size-1.5 rounded-full bg-[#5BD08A]"/><div className="min-w-0 flex-1"><p className="text-[13px] leading-[18px]">{task.title}</p><p className="text-[12px] leading-4 text-muted-foreground">{task.prUrl?`PR ${prLabel(task.prUrl)}${task.readyNote?' · '+task.readyNote:''}`:task.readyNote}</p></div>{task.previewUrl&&<UrlLink href={task.previewUrl} className="rounded-md border border-border px-2.5 py-1 text-[12px] text-muted-foreground">Preview</UrlLink>}<TaskContextAction task={task} compact className="h-6 px-[10px] text-[12px] leading-4"/></li>)}</ul>
    {(terminal.length>0||active.length>0)&&<ul className="space-y-[6px] px-3.5 pb-3 pt-[10px] text-[12px] leading-4 text-muted-foreground">{terminal.map(event=><li key={event.seq} className="flex gap-2"><Icon name="Check" className="size-3.5"/>{event.text}{event.detail?' · '+event.detail:''}</li>)}{active.map(task=><li key={task.id} className="flex items-center gap-2"><AgentLogo provider={task.provider}/>{task.title} · {cardStatus(task).status==='review'?(history.find(event=>event.taskId===task.id&&event.kind==='review-started')?.review?.provider==='claude'?'Claude is reviewing it now':history.find(event=>event.taskId===task.id&&event.kind==='review-started')?.review?.provider==='codex'?'Codex is reviewing it now':'reviewing now'):'working'}</li>)}</ul>}
  </Frame>;
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

/** bb already supplies its machine banner for a suspended native host. */
export function useNativePaused(threadId:string){
  const sdk=useSdk();const [paused,setPaused]=useState(false);
  useEffect(()=>{let active=true;setPaused(false);if(!threadId)return()=>{active=false};
    void sdk.threads.get({threadId}).then(thread=>thread.environmentId?sdk.environments.get({environmentId:thread.environmentId}):null).then(environment=>environment?sdk.hosts.get({hostId:environment.hostId}):null).then(host=>{if(active)setPaused(host?.lifecycle.phase==='suspended'||host?.lifecycle.phase==='suspending')}).catch(()=>{});
    return()=>{active=false};
  },[sdk,threadId]);return paused;
}
function StoppedComposerBanner() {
  const composer = useComposer();
  const threadId =
    composer.scope.kind === "thread" ? composer.scope.threadId : "";
  const task = useThreadTask(threadId);
  const nativePaused=useNativePaused(threadId);
  const detail = useTask(task?.id ?? null).data?.task;
  if (
    !task || nativePaused ||
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
  const lastStop=experimental_useRpcQuery({contract:rpcContract,method:'history',input:{taskId:task.id,limit:50}}).data?.events.find(event=>event.kind==='stopped');
  const idleStop=lastStop?.cause==='idle-timeout';
  const oom=Boolean(task.memory?.oom?.cause && !task.memory.oom.movedTo);
  return <div className="boat-ui flex flex-wrap items-center gap-2 rounded-lg border border-border bg-secondary px-3 py-2 text-[12px] text-muted-foreground">
    <Icon name="Pause" className="size-3.5" />
    <span className="min-w-0 flex-1">{state.status==='waiting-reset'?'Waiting for a reset · work is saved':idleStop?'Sandbox stopped after 1 h idle · nothing is lost; your next message resumes it too':oom?'Sandbox stopped · out of memory · work is saved':'Sandbox stopped · nothing lost'}</span>
    <Button size="sm" variant="outline" disabled={resume.isPending} onClick={()=>{if(oom&&!idleStop)setResizing(true);else if(task.sandboxId)void resume.mutate({id:task.sandboxId,action:'resume'}).catch(showError)}}>{oom&&!idleStop?'Continue on Large':'Resume'}</Button>
    <ResizeDialog task={task} mode="oom" open={resizing} onOpenChange={setResizing}/>
  </div>;

}

/** Agent-dispatched briefs retain provenance using bb's above-message slot. */
function BriefMetadata({message}:ExperimentalMessageMetadataProps){
  const task=useThreadTask(message.threadId);
  if(message.role!=="user" || message.initiator!=="agent" || !task?.source.title)return null;
  return <span className="boat-ui inline-flex items-center gap-1.5 text-[12px] text-muted-foreground"><AgentLogo provider={task.provider}/>Brief from {task.source.title}<span className="hidden sm:inline">{task.tier?' · '+task.tier[0].toUpperCase()+task.tier.slice(1):''}{task.model?' · '+modelName(task.model):''}</span></span>;
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
