import { useState, type ReactNode } from "react";
import {
  UrlLink, useComposers, useBbNavigate, experimental_useRpcMutation, experimental_useRpcQuery,
  type PluginAppBuilder, type PluginMessageDirectiveProps,
} from "@get-bb/plugin-sdk/app";
import { rpcContract, type DecisionDto, type TaskDetailDto, type TaskDto } from "../contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useBoard, useCloudAgentsNavigation, useTask, useThreadTasks } from "./hooks";
import { AgentBadge, OpenChatButton, PrLink, showError } from "./ui";
import { ShipButton } from "./board";
import { ResizeDialog } from "./sandbox-size";
import { CARD_TONES, cardStatus, contextCounts, markerId, queueDelivery } from "./cards-logic";

function Frame({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn("my-3 w-full max-w-[720px] overflow-hidden rounded-[10px] border border-border bg-card text-[13px] leading-5", className)}>{children}</section>;
}
function Notice({ children }: { children: ReactNode }) {
  return <div role="status" className="my-2 rounded-lg border border-dashed border-border px-3.5 py-2.5 text-xs text-muted-foreground">{children}</div>;
}
export function CardTaskState({ task }: { task: TaskDto }) {
  const state = cardStatus(task);
  return <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-xs", CARD_TONES[state.tone])}><span aria-hidden className={cn("size-1.5 rounded-full bg-current", state.moving && "motion-safe:animate-pulse")} />{state.label}</span>;
}

export function LiveTaskRow({ task }: { task: TaskDto }) {
  const { openTask } = useCloudAgentsNavigation();
  return <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3.5 py-2">
    <span className="min-w-0 flex-1"><button className="block w-full truncate rounded-sm text-left hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => openTask(task.id)}>{task.title}</button></span>
    <span className="hidden text-xs text-muted-foreground sm:inline">{task.tier}</span>
    <CardTaskState task={task} />{task.prUrl && <PrLink url={task.prUrl} />}<OpenChatButton task={task} className="size-6" />
  </li>;
}
export function TasksDirective(props: PluginMessageDirectiveProps) {
  const id = markerId(props.attributes.thread) ?? props.message.threadId;
  const tasks = useThreadTasks(id);
  return <Frame><header className="px-3.5 py-2.5 font-medium">{tasks.length} {tasks.length === 1 ? "task" : "tasks"}<span className="ml-2 font-normal text-muted-foreground">Live work</span></header><ul aria-label="Tasks">{tasks.map(task => <LiveTaskRow key={task.id} task={task} />)}</ul>{tasks.length === 0 && <p className="border-t border-border px-3.5 py-2 text-muted-foreground">No tasks in this chat yet.</p>}</Frame>;
}

function TaskCard({ props, kind }: { props: PluginMessageDirectiveProps; kind: "task" | "chip" | "review" | "ready" | "problem" }) {
  const id = markerId(props.attributes.id);
  const { data, error } = useTask(id);
  if (!id) return <code>{props.source}</code>;
  if (!data?.task) return <Notice>{error?.message ?? (data ? "This task is no longer available." : "Loading task…")}</Notice>;
  const task = data.task;
  if (kind === "chip") return <TaskChip task={task} />;
  if (kind === "review") return <ReviewCard task={task} />;
  if (kind === "ready") return <ReadyCard task={task} />;
  if (kind === "problem") return <ProblemCard task={task} />;
  return <Frame><ul><LiveTaskRow task={task} /></ul>{task.excerpt && <p className="border-t border-border px-3.5 py-2 text-xs text-muted-foreground">{task.excerpt}</p>}</Frame>;
}
export function TaskDirective(props: PluginMessageDirectiveProps) { return <TaskCard props={props} kind="task" />; }
function TaskChip({ task }: { task: TaskDto }) {
  const { openTask } = useCloudAgentsNavigation();
  return <button onClick={() => openTask(task.id)} className="mx-1 inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-secondary px-2 py-0.5 align-middle text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"><span className="truncate">{task.title}</span><CardTaskState task={task} /></button>;
}
function ReviewCard({ task }: { task: TaskDetailDto }) {
  const { openTask } = useCloudAgentsNavigation();
  const verdict = task.verdict;
  const approved = verdict === "approve" || verdict === "approved";
  const changes = verdict === "changes-requested";
  const heading = approved ? "Review approved" : changes ? "Changes requested" : task.status === "running" || task.status === "starting" ? "Reviewing…" : "The review couldn’t run";
  return <Frame className={approved ? "border-[#5BD08A]/20 bg-[#5BD08A]/[0.04]" : undefined}><div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5"><Icon name="Eye" className="size-3.5 text-muted-foreground" /><span className={cn("font-medium", approved ? "text-[#5BD08A]" : changes ? "text-[#F0B135]" : "text-foreground")}>{heading}</span><AgentBadge provider={task.provider} model={task.model} /><button className="ml-auto text-xs text-[#7AA7FF] hover:underline" onClick={() => openTask(task.id)}>Full review</button></div>{(task.excerpt || task.error) && <p className="whitespace-pre-wrap px-3.5 pb-3 text-xs text-muted-foreground">{task.excerpt || task.error}</p>}</Frame>;
}

/** Uses the pane's composer; never sends an own-words answer automatically. */
function useFillComposer(threadId: string) {
  const composers = useComposers();
  const composer = composers.find(item => item.scope.kind === "thread" && item.scope.threadId === threadId);
  return composer ? (text: string) => { composer.replace({ text, mentions: [] }); composer.focus(); } : null;
}
function ReadyCard({ task }: { task: TaskDetailDto }) {
  const state = cardStatus(task);
  const { openTask } = useCloudAgentsNavigation();
  const fill = useFillComposer(task.threadId ?? "");
  const shipped = state.status === "shipped";
  return <Frame><div className="flex flex-wrap items-center gap-2 px-3.5 pt-3"><span className={cn("font-medium", shipped || state.status === "ready" ? "text-[#5BD08A]" : "text-muted-foreground")}>{shipped ? "Shipped" : state.label}: {task.title}</span>{task.prUrl && <PrLink url={task.prUrl} />}</div>{(task.readyNote || task.excerpt) && <p className="px-3.5 pt-2 text-xs text-muted-foreground">{task.readyNote || task.excerpt}</p>}<div className="flex flex-wrap gap-2 px-3.5 py-3">{!shipped && task.canShip && <ShipButton task={task} className="my-0" />}{task.prUrl && <UrlLink href={task.prUrl} className="rounded-md border border-border px-2.5 py-1 text-xs text-[#7AA7FF]">Open PR</UrlLink>}{task.previewUrl && <UrlLink href={task.previewUrl} className="rounded-md border border-border px-2.5 py-1 text-xs text-[#7AA7FF]">Open preview</UrlLink>}<Button size="sm" variant="outline" onClick={() => openTask(task.id)}>See the changes</Button>{!shipped && fill && <Button size="sm" variant="ghost" onClick={() => fill(`For ${task.title}, I’d like these changes:\n`)}>Ask for changes…</Button>}</div></Frame>;
}

export function ProblemCard({ task }: { task: TaskDetailDto }) {
  const state = cardStatus(task);
  const [resizing, setResizing] = useState(false);
  const resume = experimental_useRpcMutation({ contract: rpcContract, method: "sandboxAction" });
  const { openTask } = useCloudAgentsNavigation();
  const oom = task.memory?.oom?.cause === true && !task.memory.oom.movedTo;
  const stopped = state.status === "stopped";
  const waiting = state.status === "waiting-reset";
  const broken = oom || state.status === "broken";
  const run = async () => { if (!task.sandboxId) return; try { await resume.mutate({ id: task.sandboxId, action: "resume" }); } catch (error) { showError(error); } };
  return <Frame className={broken ? "border-[#E06C6C]/30" : undefined}><div className="flex flex-wrap items-center gap-3 px-3.5 py-3"><Icon name={broken ? "CircleAlert" : "Pause"} className={cn("size-3.5 shrink-0", broken ? "text-[#E06C6C]" : "text-muted-foreground")} /><div className="min-w-0 flex-1"><p className="font-medium">{oom ? "The task ran out of memory" : stopped ? "The sandbox is stopped" : waiting ? "Waiting for the usage limit to reset" : broken ? "The task couldn’t continue" : state.label}</p><p className="break-words text-xs text-muted-foreground">{state.reason || task.error || (stopped ? "Resume to continue working." : "Open the task for details.")}</p>{oom && <p className="text-xs text-[#FC8C45]">A larger sandbox may cost more. Review the size and cost before continuing.</p>}</div>{oom && task.memory?.canResize ? <Button size="sm" variant="outline" onClick={() => setResizing(true)}>Continue on a larger sandbox</Button> : stopped && task.sandboxId ? <Button size="sm" variant="outline" disabled={resume.isPending} onClick={() => void run()}>{resume.isPending ? "Resuming…" : "Resume"}</Button> : <Button size="sm" variant="outline" onClick={() => openTask(task.id)}>Open task</Button>}</div><ResizeDialog task={task} mode="oom" open={resizing} onOpenChange={setResizing} /></Frame>;
}

export function DecisionCard({ decision, threadId }: { decision: DecisionDto; threadId: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [queued, setQueued] = useState<null | { cancel: () => boolean; answer: string }>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const send = experimental_useRpcMutation({ contract: rpcContract, method: "answerDecision" });
  const fill = useFillComposer(threadId);
  const options = [...new Set(decision.options.length ? decision.options : [decision.recommendation])].filter(Boolean);
  const choice = selected ?? (options.includes(decision.recommendation) ? decision.recommendation : options[0]) ?? decision.recommendation;
  const busy = queued !== null || send.isPending;
  const choose = (answer: string) => {
    if (busy) return;
    const cancel = queueDelivery(async () => {
      setQueued(null);
      try { const result = await send.mutate({ id: decision.id, accept: answer === decision.recommendation, answer: answer === decision.recommendation ? null : answer }); setOutcome(result.delivered ? `You chose ${answer}` : "Answer saved. The chat is no longer available for delivery."); } catch (error) { showError(error); }
    });
    setQueued({ cancel, answer });
  };
  const closed = decision.status !== "open" || outcome !== null;
  if (closed && !expanded) return <Frame><div className="flex items-center gap-2 px-3.5 py-2 text-xs text-muted-foreground"><Icon name="Check" className="size-3.5" /><span className="min-w-0 flex-1 break-words">{outcome ?? (decision.status === "answered" ? `You chose ${decision.answer ?? "the recommendation"}` : "Decision withdrawn")}</span><button className="shrink-0 hover:text-foreground" onClick={() => setExpanded(true)}>Show options</button></div></Frame>;
  return <Frame className="border-[#F0B135]/25"><header className="border-b border-border px-3.5 py-2 text-xs text-[#F0B135]">{closed ? "Decision answered" : "Needs you"}</header><div className="space-y-3 p-3.5"><p className="font-medium">{decision.question}</p><fieldset disabled={busy || closed} className="space-y-1.5"><legend className="sr-only">Options</legend>{options.map((option, index) => <label key={option} className={cn("flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2", choice === option ? "border-foreground/30 bg-secondary" : "border-border")}><input type="radio" name={`boat-${decision.id}`} checked={choice === option} onChange={() => setSelected(option)} className="mt-1 accent-current" /><span className="min-w-0 flex-1 break-words">{option}</span>{(option === decision.recommendation || (index === 0 && !options.includes(decision.recommendation))) && <span className="shrink-0 text-[11px] text-[#7AA7FF]">Recommended</span>}</label>)}</fieldset>{decision.recommendation && !options.includes(decision.recommendation) && <p className="text-xs text-muted-foreground"><span className="text-[#7AA7FF]">Recommended:</span> {decision.recommendation}</p>}{queued ? <div role="status" className="flex items-center gap-3 text-xs"><span className="min-w-0 flex-1">Queued: {queued.answer}</span><Button size="sm" variant="outline" onClick={() => { if (queued.cancel()) setQueued(null); }}>Undo</Button></div> : !closed && <div className="flex flex-col gap-2 sm:flex-row sm:items-center"><Button size="sm" disabled={send.isPending || !choice} onClick={() => choose(choice)} className="h-auto min-h-7 whitespace-normal break-words">{send.isPending ? "Sending…" : `Go with ${choice}`}</Button>{fill && <button className="py-1 text-left text-xs text-muted-foreground hover:text-foreground sm:ml-auto" disabled={send.isPending} onClick={() => fill(`${decision.question}\n\n${choice}\n\n`)}>Answer in your own words</button>}</div>}</div></Frame>;
}
export function DecisionDirective(props: PluginMessageDirectiveProps) {
  const id = markerId(props.attributes.id);
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "decision", input: { id: id ?? "" }, enabled: id !== null });
  if (!id) return <code>{props.source}</code>;
  if (!query.data?.decision) return <Notice>{query.error?.message ?? (query.data ? "This decision is no longer available." : "Loading decision…")}</Notice>;
  return <DecisionCard decision={query.data.decision} threadId={props.message.threadId} />;
}
export function DigestDirective(props: PluginMessageDirectiveProps) {
  const threadId = markerId(props.attributes.thread) ?? props.message.threadId;
  const board = useBoard(threadId).data;
  if (!board) return null;
  const tasks = [...board.ready, ...board.running, ...board.done];
  if (!tasks.length && !board.needsYou.length) return null;
  return <Frame><header className="px-3.5 py-2.5 font-medium">Work update<span className="ml-2 text-xs font-normal text-muted-foreground">{contextCounts(tasks, board.needsYou.length)}</span></header>{board.needsYou.map(decision => <DecisionCard key={decision.id} decision={decision} threadId={threadId} />)}<ul>{tasks.map(task => <LiveTaskRow key={task.id} task={task} />)}</ul></Frame>;
}
/** There is no persisted thread handoff note in the current contract. */
export function HandoffDirective(_props: PluginMessageDirectiveProps) { return null; }

export function registerChatCards(app: PluginAppBuilder): void {
  app.slots.messageDirective({ id: "boat-task", component: TaskDirective });
  app.slots.messageDirective({ id: "boat-tasks", component: TasksDirective });
  app.slots.messageDirective({ id: "boat-chip", component: props => <TaskCard props={props} kind="chip" /> });
  app.slots.messageDirective({ id: "boat-review", component: props => <TaskCard props={props} kind="review" /> });
  app.slots.messageDirective({ id: "boat-ready", component: props => <TaskCard props={props} kind="ready" /> });
  app.slots.messageDirective({ id: "boat-decision", component: DecisionDirective });
  app.slots.messageDirective({ id: "boat-problem", component: props => <TaskCard props={props} kind="problem" /> });
  app.slots.messageDirective({ id: "boat-digest", component: DigestDirective });
  app.slots.messageDirective({ id: "boat-handoff", component: HandoffDirective });
}
