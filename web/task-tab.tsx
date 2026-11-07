// Task-owned side panel; source chats keep the separate Cloud agents list.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Markdown, ThreadChat, UrlLink, experimental_useRpcMutation, experimental_useRpcQuery, useSdk,
  type ExperimentalThreadTabProps, type PluginAppBuilder, type PluginBrowserBbSdk,
} from "@get-bb/plugin-sdk/app";
import { rpcContract, type TaskDetailDto, type TaskDto } from "../contract";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import { cn } from "../lib/utils";
import { CardTaskState, TaskContextAction } from "./cards";
import { ReviewDialog } from "./dialogs";
import { PROVIDER_LABEL, clockTime, dateTime, isRunning, relativeTime } from "./format";
import { useCloudAgentsNavigation, useInterval, useNow, useSandboxes, useTask, useThreadTask } from "./hooks";
import { PreviewsSection } from "./previews";
import { ResizeDialog } from "./sandbox-size";
import { AgentBadge, EmptyBox, InlineAlert, ThreadLink, showError } from "./ui";
import { groupTaskTranscript, taskReviews, transcriptMatches } from "./task-tab-logic";

export function useHasTask({ threadId }: { threadId: string }): boolean {
  return useThreadTask(threadId) !== null;
}

export function registerTaskTab(app: PluginAppBuilder): void {
  app.slots.experimental_tab({
    context: { kind: "thread" }, availability: "fixed", id: "task", title: "Task", icon: "ComputerCloud",
    tooltip: "This task's brief, reviews, transcript and sandbox", layout: "flush", component: TaskTab, useVisible: useHasTask,
  });
}

export function TaskTab({ threadId }: ExperimentalThreadTabProps) {
  const owner = useThreadTask(threadId);
  const { data, error } = useTask(owner?.id ?? null);
  if (error) return <div className="p-4"><InlineAlert>{error.message}</InlineAlert></div>;
  if (!owner) return <div className="p-4"><EmptyBox>No cloud task is linked to this chat.</EmptyBox></div>;
  if (!data) return <div className="p-4"><EmptyBox>Loading task…</EmptyBox></div>;
  if (!data.task) return <div className="p-4"><EmptyBox>This task is no longer available.</EmptyBox></div>;
  return <TaskPanel key={data.task.id} task={data.task} />;
}

const TABS = ["Overview", "Reviews", "Transcript", "Sandbox"] as const;
type TaskTabName = typeof TABS[number];

function TaskPanel({ task }: { task: TaskDetailDto }) {
  const [tab, setTab] = useState<TaskTabName>("Overview");
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function move(event: KeyboardEvent, index: number) {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index + TABS.length - 1) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    else return;
    event.preventDefault(); setTab(TABS[next]); refs.current[next]?.focus();
  }
  return <div className="flex min-h-full min-w-0 flex-col gap-5 p-4 text-[13px] text-foreground">
    <header className="space-y-2">
      <div className="flex items-start gap-2">
        <Icon name="ComputerCloud" className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h2 className="min-w-0 flex-1 text-sm font-semibold break-words">{task.title}</h2>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs"><CardTaskState task={task} />
        {task.prUrl && <UrlLink href={task.prUrl} className="text-[#7AA7FF]">Pull request</UrlLink>}
        {task.previewUrl && <UrlLink href={task.previewUrl} className="text-[#7AA7FF]">Preview ↗</UrlLink>}
        <span className="ml-auto"><TaskContextAction task={task} /></span>
      </div>
    </header>
    <div role="tablist" aria-label="Task details" className="grid grid-cols-4 gap-0.5 rounded-lg border border-border bg-secondary p-[3px]">
      {TABS.map((name, index) => <button key={name} ref={(el) => { refs.current[index] = el; }} type="button" role="tab"
        id={`${id}-tab-${name}`} aria-selected={tab === name} aria-controls={`${id}-panel-${name}`} tabIndex={tab === name ? 0 : -1}
        onKeyDown={(event) => move(event, index)} onClick={() => setTab(name)}
        className={cn("min-h-8 rounded-md px-1 py-1 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", tab === name ? "bg-state-active text-foreground" : "text-muted-foreground hover:text-foreground")}>
        {name}
      </button>)}
    </div>
    <div role="tabpanel" id={`${id}-panel-${tab}`} aria-labelledby={`${id}-tab-${tab}`} tabIndex={0} className="min-w-0 flex-1 space-y-5 focus-visible:outline-2 focus-visible:outline-ring">
      {tab === "Overview" ? <Overview task={task} /> : tab === "Reviews" ? <Reviews task={task} /> : tab === "Transcript" ? <Transcript task={task} /> : <Sandbox task={task} />}
    </div>
  </div>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="space-y-2"><h3 className="text-xs font-medium text-muted-foreground">{title}</h3>{children}</section>;
}
const BOX = "rounded-lg border border-border bg-card p-3";

function Overview({ task }: { task: TaskDetailDto }) {
  const [reviewing, setReviewing] = useState(false);
  const canReview = task.role !== "review" && task.status !== "done" && task.status !== "cancelled";
  return <>
    {task.error && <InlineAlert>{task.error}</InlineAlert>}
    {task.readyNote && <p className="text-xs text-muted-foreground">{task.readyNote}</p>}
    <Section title="Brief"><div className={BOX}><Markdown content={task.brief || "No brief recorded."} className="text-xs" /></div></Section>
    <Section title="Change"><div className={cn(BOX, "space-y-2 text-xs")}>
      {task.repo && <p className="break-all">{task.repo}</p>}
      {task.branch && <p className="flex items-start gap-2 text-muted-foreground"><Icon name="GitBranch" className="size-3.5 shrink-0" aria-hidden /><span className="break-all">{task.branch}{task.baseBranch ? ` → ${task.baseBranch}` : ""}</span></p>}
      <p className="text-muted-foreground">{task.delivery === "push" ? `Ships to ${task.baseBranch ?? "the base branch"} after your approval` : "Lands through a pull request"}</p>
      {task.prUrl ? <UrlLink href={task.prUrl} className="inline-block text-[#7AA7FF]">Open pull request ↗</UrlLink> : <p className="text-muted-foreground">No pull request recorded</p>}
    </div></Section>
    <Section title="Who"><div className={cn(BOX, "space-y-3 text-xs")}>
      <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground">Working on it</span><AgentBadge provider={task.provider} model={task.model} /></div>
      {task.source.threadId && <div className="flex flex-wrap justify-between gap-2"><span className="text-muted-foreground">Started from</span><ThreadLink threadId={task.source.threadId} label={task.source.title || (task.source.kind === "orchestrator" ? "Orchestrator chat" : "Source chat")} /></div>}
      <p className="text-muted-foreground">Started {dateTime(task.createdAt)}</p>
    </div></Section>
    {task.result && <Section title="Latest report"><details className={BOX}><summary className="cursor-pointer text-xs">Read the report</summary><Markdown content={task.result} className="mt-3 text-xs" /></details></Section>}
    {canReview && <Button size="sm" variant="outline" disabled={isRunning(task.status)} onClick={() => setReviewing(true)}>Request review…</Button>}
    <ReviewDialog task={task} open={reviewing} onOpenChange={setReviewing} />
  </>;
}

function Reviews({ task }: { task: TaskDetailDto }) {
  const [reviewing, setReviewing] = useState(false);
  const { data, error } = experimental_useRpcQuery({ contract: rpcContract, method: "tasks", input: { statuses: null, threadId: null, limit: 500 } });
  const reviews = useMemo(() => taskReviews(task.id, data?.tasks ?? []), [task.id, data]);
  const now = useNow();
  return <>
    {error && <InlineAlert>{error.message}</InlineAlert>}
    {!data && !error ? <EmptyBox>Loading reviews…</EmptyBox> : reviews.length === 0 ? <EmptyBox>No reviews recorded for this task yet.</EmptyBox> : <ol className="space-y-4" aria-label="Review history">
      {reviews.map((review, index) => <li key={review.id} className="relative border-l border-border pl-4">
        <p className="mb-1 text-[11px] text-muted-foreground">{relativeTime(review.finishedAt ?? review.createdAt, now)}</p>
        <ReviewEntry review={review} number={index + 1} />
      </li>)}
    </ol>}
    <p className="text-xs text-muted-foreground">Recent recorded reviews. Each review uses its own context.</p>
    {task.role !== "review" && task.status !== "done" && task.status !== "cancelled" && <Button size="sm" variant="outline" disabled={isRunning(task.status)} onClick={() => setReviewing(true)}>Request another review…</Button>}
    <ReviewDialog task={task} open={reviewing} onOpenChange={setReviewing} />
  </>;
}

function ReviewEntry({ review, number }: { review: TaskDto; number: number }) {
  const [expanded, setExpanded] = useState(false);
  const { data, error } = useTask(expanded ? review.id : null);
  const { openTask } = useCloudAgentsNavigation();
  const label = review.verdict === "approve" ? "Approved" : review.verdict === "changes-requested" ? "Changes requested" : isRunning(review.status) ? "Reviewing…" : review.status === "failed" ? "Couldn't run" : "Review finished";
  return <div className="space-y-2">
    <p className={cn("text-[13px] font-medium", review.verdict === "approve" ? "text-[#5BD08A]" : review.verdict === "changes-requested" ? "text-[#FC8C45]" : review.status === "failed" ? "text-[#E06C6C]" : "text-foreground")}>Review {number} · {PROVIDER_LABEL[review.provider]} · {label.toLowerCase()}</p>
    {review.excerpt && <p className="text-xs whitespace-pre-wrap text-muted-foreground">{review.excerpt}</p>}
    <details onToggle={(event) => setExpanded(event.currentTarget.open)} className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">Full review report</summary>
      {error ? <InlineAlert>{error.message}</InlineAlert> : !data ? <p className="mt-2 text-muted-foreground">Loading report…</p> : <Markdown content={data.task?.result || "No report was recorded."} className="mt-3 text-xs" />}
    </details>
    {review.threadId ? <ThreadLink threadId={review.threadId} label="Open full review as a chat ↗" className="text-xs text-[#7AA7FF]" /> : <button type="button" className="text-xs text-[#7AA7FF] underline-offset-4 hover:underline" onClick={() => openTask(review.id)}>Open full review ↗</button>}
  </div>;
}

function Transcript({ task }: { task: TaskDetailDto }) {
  return task.runner === "chat" && task.threadId ? <ChatTranscript task={task} /> : <BoatTranscript task={task} />;
}
type OutlineItem = Awaited<ReturnType<PluginBrowserBbSdk["threads"]["conversationOutline"]>>["items"][number];

function ChatTranscript({ task }: { task: TaskDetailDto }) {
  const sdk = useSdk();
  const [items, setItems] = useState<OutlineItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [revision, refresh] = useState(0);
  const [full, setFull] = useState(false);
  const id = useId();
  useEffect(() => {
    const abort = new AbortController();
    setError(null);
    void sdk.threads.conversationOutline({ threadId: task.threadId!, signal: abort.signal }).then((result) => {
      if (!abort.signal.aborted) setItems(result.items);
    }).catch((reason: unknown) => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "Couldn't load the conversation."); });
    return () => abort.abort();
  }, [sdk, task.threadId, task.updatedAt, revision]);
  const filtered = items?.filter((item) => item.preview.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <>
    <div className="flex items-end gap-2"><Search id={id} query={query} onChange={setQuery} /><Button variant="outline" size="sm" onClick={() => refresh((n) => n + 1)}>Refresh</Button></div>
    {error && <InlineAlert>{error}</InlineAlert>}
    {items === null && !error ? <EmptyBox>Loading conversation…</EmptyBox> : filtered?.length === 0 ? <EmptyBox>{query ? "No matching messages." : "No messages recorded yet."}</EmptyBox> : <ol className="divide-y divide-border">
      {filtered?.map((item) => <li key={item.id} className="py-2.5"><details>
        <summary className="cursor-pointer truncate text-xs"><span className="mr-2 text-muted-foreground">{item.role === "user" ? "You" : PROVIDER_LABEL[task.provider]}</span>{item.preview || "Message"}</summary>
        <p className="mt-2 text-xs whitespace-pre-wrap text-muted-foreground">{item.preview}</p>
        {item.attachmentSummary && <p className="mt-1 text-xs text-muted-foreground">{item.attachmentSummary.fileCount} files · {item.attachmentSummary.imageCount} images</p>}
      </details></li>)}
    </ol>}
    <p className="text-xs text-muted-foreground">Search covers message previews. The full log includes tool output and attachments.</p>
    <Button size="sm" variant="outline" onClick={() => setFull((value) => !value)}>{full ? "Hide full log" : "Open full log"}</Button>
    {full && <div className="min-h-64 rounded-lg border border-border"><ThreadChat threadId={task.threadId!} variant="timeline" layout="document" /></div>}
  </>;
}

function Search({ id, query, onChange }: { id: string; query: string; onChange(value: string): void }) {
  return <label htmlFor={id} className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">Search transcript<input id={id} type="search" value={query} onChange={(event) => onChange(event.target.value)} placeholder="Find a message or tool…" className="min-h-8 w-full rounded-md border border-input bg-background px-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:text-xs" /></label>;
}

function BoatTranscript({ task }: { task: TaskDetailDto }) {
  const { data, error, refetch, isFetching } = experimental_useRpcQuery({ contract: rpcContract, method: "transcript", input: { id: task.id, limit: 500 } });
  const [query, setQuery] = useState("");
  const id = useId();
  useInterval(() => void refetch(), isRunning(task.status) ? 5_000 : null);
  const turns = useMemo(() => groupTaskTranscript(data?.events ?? []), [data]);
  const visible = turns.filter((turn) => transcriptMatches(turn, query));
  return <>
    <div className="flex items-end gap-2"><Search id={id} query={query} onChange={setQuery} /><Button size="sm" variant="outline" disabled={isFetching} onClick={() => void refetch()}>Refresh</Button></div>
    {(error || data?.error) && <InlineAlert>{error?.message ?? data?.error}</InlineAlert>}
    {!data && !error ? <EmptyBox>Loading transcript…</EmptyBox> : visible.length === 0 ? <EmptyBox>{query ? "No matching turns." : "No conversation recorded yet."}</EmptyBox> : <ol className="divide-y divide-border">
      {visible.map((turn) => <li key={turn.key} className="py-2.5"><details>
        <summary className="cursor-pointer text-xs"><span className="mr-2 text-muted-foreground">{turn.at === null ? "Turn" : clockTime(turn.at)}</span>{turn.prompt?.split("\n")[0] || turn.content[0]?.split("\n")[0] || "Agent activity"}<span className="ml-2 text-muted-foreground">· {turn.tools.length} tool entries</span></summary>
        <div className="mt-3 space-y-3 text-xs">{turn.prompt && <p className="whitespace-pre-wrap">{turn.prompt}</p>}
          {turn.tools.length > 0 && <p className="break-words font-mono text-muted-foreground">{turn.tools.join(" · ")}</p>}
          {turn.content.map((content, index) => <Markdown key={index} content={content} className="text-xs" />)}
          {turn.errors.map((message, index) => <InlineAlert key={index}>{message}</InlineAlert>)}
        </div>
      </details></li>)}
    </ol>}
    <p className="text-xs text-muted-foreground">Latest 500 events. Boat reports tool names, without their output.</p>
  </>;
}

function Sandbox({ task }: { task: TaskDetailDto }) {
  const sandboxes = useSandboxes();
  const sandbox = sandboxes.data?.sandboxes.find((item) => item.id === task.sandboxId);
  const memory = task.memory;
  const [resizing, setResizing] = useState(false);
  const action = experimental_useRpcMutation({ contract: rpcContract, method: "sandboxAction" });
  const { openTask } = useCloudAgentsNavigation();
  const stopped = sandbox?.state === "stopped" || sandbox?.state === "archived";
  async function run() {
    if (!task.sandboxId) return;
    try { await action.mutate({ id: task.sandboxId, action: stopped ? "resume" : "stop" }); } catch (reason) { showError(reason); }
  }
  return <>
    <div className={cn(BOX, "space-y-2 text-xs")}>
      <p>{sandbox ? `Sandbox ${stopped ? "stopped" : sandbox.state}` : task.sandboxId ? "Sandbox state unavailable" : "No sandbox attached"}</p>
      {memory?.size && <p className="text-muted-foreground">{memory.size.label} · {memory.size.summary}</p>}
      {sandboxes.error && <p className="text-[#E06C6C]">{sandboxes.error.message}</p>}
      {sandboxes.data?.error && <p className="text-[#E06C6C]">{sandboxes.data.error}</p>}
    </div>
    <Section title="Memory"><div className={cn(BOX, "space-y-2 text-xs")}>
      {memory?.peak ? <>
        <div className="flex flex-wrap justify-between gap-2"><span>This run</span><span className="text-muted-foreground">Peak {memory.peak.usedGb.toFixed(1)} of {memory.peak.totalGb.toFixed(1)} GB</span></div>
        <meter className="h-3 w-full accent-[#5BD08A]" min={0} max={100} value={Math.max(0, Math.min(100, memory.peak.percent))} aria-label="Peak memory use" />
        {memory.peak.shared && <p className="text-muted-foreground">Shared with other tasks on this sandbox</p>}
        <p className="text-muted-foreground">Measured {dateTime(memory.peak.at)}</p>
      </> : <p className="text-muted-foreground">No memory measurement for this run</p>}
      {memory?.oom && <p className="text-[#E06C6C]">{memory.oom.message}</p>}
    </div></Section>
    <PreviewsSection threadId={null} taskId={task.id} showTask={false} />
    <Section title="Actions"><div className={cn(BOX, "space-y-3 text-xs")}>
      <div className="flex flex-wrap gap-2">
        {sandbox && <Button variant="outline" size="sm" disabled={action.isPending} onClick={() => void run()}>{stopped ? "Resume" : "Stop"}</Button>}
        {memory?.canResize && <Button variant="outline" size="sm" onClick={() => setResizing(true)}>Change sandbox size…</Button>}
      </div>
      {memory?.next && <p className="text-[#FC8C45]">{memory.next.label} · {memory.next.detail}</p>}
      <p className="text-muted-foreground">Changing size stops running processes. Review the cost before continuing.</p>
      <div className="border-t border-border pt-3"><Button size="sm" variant="ghost" onClick={() => openTask(task.id)}>Open task actions…</Button><p className="mt-1 text-muted-foreground">Close or delete with the task's existing safeguards.</p></div>
    </div></Section>
    <Section title="Cost"><div className={cn(BOX, "text-xs text-muted-foreground")}>Task cost is unavailable.</div></Section>
    <ResizeDialog task={task} mode={memory?.oom ? "oom" : "general"} open={resizing} onOpenChange={setResizing} />
  </>;
}
