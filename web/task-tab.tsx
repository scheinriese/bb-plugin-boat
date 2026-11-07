// Task-owned side panel; source chats keep the separate Cloud agents list.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Markdown, ThreadChat, UrlLink, experimental_useFixedTabTarget, experimental_useRpcMutation, experimental_useRpcQuery, useSdk,
  type ExperimentalThreadTabProps, type PluginAppBuilder,
} from "@get-bb/plugin-sdk/app";
import { mergeRpcContract, type PullRequestFacts } from "../contract-merge";
import type { HistoryEventDto } from "../contract-fidelity";
import { rpcContract, type TaskDetailDto, type TaskDto } from "../contract";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import { cn } from "../lib/utils";
import { ConfirmDialog } from "./dialogs";
import { PROVIDER_LABEL, clockTime, isRunning, modelName } from "./format";
import { useCloudAgentsNavigation, useInterval, useSandboxes, useTask, useThreadTask } from "./hooks";
import { ShipButton } from "./board";
import { cardStatus } from "./cards-logic";
import "./task-tab.css";
import { DiffStats } from "./diff-stats";
import { usePreviews } from "./previews";
import { ResizeDialog } from "./sandbox-size";
import { AgentLogo, EmptyBox, InlineAlert, showError } from "./ui";
import { transcriptPreview, groupTaskTranscript, transcriptMatches } from "./task-tab-logic";
import { nativeMilestones, nativeWorkCounts, nativeEvidence, nativeActivityTitles, type NativeMilestone, type NativeRow, type NativeTurn } from "./native-transcript";

import { TASK_SECTIONS, TASK_TAB, TASK_TARGET } from "./task-navigation";
export { useOpenTaskSection, type TaskSection } from "./task-navigation";

export function useHasTask({ threadId }: { threadId: string }): boolean {
  return useThreadTask(threadId) !== null;
}

export function registerTaskTab(app: PluginAppBuilder): void {
  app.slots.experimental_tab({
    context: { kind: "thread" }, availability: "fixed", id: "task", title: "Task", icon: "ComputerCloud",
    tooltip: "This task's brief, reviews, transcript and sandbox", experimental_target: TASK_TARGET, layout: "flush", component: TaskTab, useVisible: useHasTask,
  });
}

export function TaskTab({ threadId }: ExperimentalThreadTabProps) {
  const owner = useThreadTask(threadId);
  const { data, error } = useTask(owner?.id ?? null);
  if (error) return <div className="boat-ui p-4"><InlineAlert>{error.message}</InlineAlert></div>;
  if (!owner) return <div className="boat-ui p-4"><EmptyBox>No cloud task is linked to this chat.</EmptyBox></div>;
  if (!data) return <div className="boat-ui p-4"><EmptyBox>Loading task…</EmptyBox></div>;
  if (!data.task) return <div className="boat-ui p-4"><EmptyBox>This task is no longer available.</EmptyBox></div>;
  return <TaskPanel key={data.task.id} task={data.task} />;
}

const TABS = TASK_SECTIONS;
type TaskTabName = typeof TABS[number];

function TaskPanel({ task }: { task: TaskDetailDto }) {
  const target = experimental_useFixedTabTarget(TASK_TAB);
  const [tab, setTab] = useState<TaskTabName>("Overview");
  useEffect(() => { if (target?.target.threadId === task.threadId) setTab(target.target.section); }, [target?.sequence, task.threadId]);
  const id = useId();
  const { data: facts } = experimental_useRpcQuery({ contract: mergeRpcContract, method: "pullRequestFacts", input: { id: task.id }, enabled: !!task.prUrl });
  const { data: history } = experimental_useRpcQuery({ contract: rpcContract, method: "history", input: { taskId: task.id, limit: 200 } });
  const state = cardStatus(task);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function move(event: KeyboardEvent, index: number) {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index + TABS.length - 1) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    else return;
    event.preventDefault(); target?.clear(); setTab(TABS[next]); refs.current[next]?.focus();
  }
  return <div className="boat-ui boat-task-panel">
    <header className="boat-task-heading">
      <div className="boat-task-title"><AgentLogo provider={task.provider} className="boat-task-logo" /><h2>{task.title}</h2></div>
      <div className="boat-task-status" data-tone={state.tone}><i aria-hidden="true" /> <span>{state.label}</span>
        {task.prUrl && <UrlLink href={task.prUrl} className="boat-task-muted">PR #{/\/pull\/(\d+)/.exec(task.prUrl)?.[1]}{facts ? <> · <DiffStats additions={facts.additions} deletions={facts.deletions} /></> : null}</UrlLink>}
        {task.previewUrl && <UrlLink href={task.previewUrl}>Preview ↗</UrlLink>}
      </div>
    </header>
    <div role="tablist" aria-label="Task details" className="boat-task-tabs">
      {TABS.map((name, index) => <button key={name} ref={(el) => { refs.current[index] = el; }} type="button" role="tab"
        id={`${id}-tab-${name}`} aria-selected={tab === name} aria-controls={`${id}-panel-${name}`} tabIndex={tab === name ? 0 : -1}
        onKeyDown={(event) => move(event, index)} onClick={() => { target?.clear(); setTab(name); }}
        className="boat-task-tab">
        {name}
      </button>)}
    </div>
    <div role="tabpanel" id={`${id}-panel-${tab}`} aria-labelledby={`${id}-tab-${tab}`} tabIndex={0} className="boat-task-content">
      {tab === "Overview" ? <Overview task={task} facts={facts ?? null} history={[...(history?.events ?? [])].sort((a,b) => a.at.localeCompare(b.at) || a.seq-b.seq)} /> : tab === "Reviews" ? <Reviews task={task} history={[...(history?.events ?? [])].sort((a,b) => a.at.localeCompare(b.at) || a.seq-b.seq)} /> : tab === "Transcript" ? <Transcript task={task} /> : <Sandbox task={task} />}
    </div>
  </div>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="boat-task-section"><h3>{title}</h3>{children}</section>;
}
const BOX = "boat-task-box";
function MergeAction({ task }: { task: TaskDto }) {
  const action = experimental_useRpcMutation({ contract: mergeRpcContract, method: "requestMerge" });
  return <Button size="sm" disabled={action.isPending} onClick={() => void action.mutate({ id: task.id, from: "chat" }).catch(showError)}>Merge PR #{task.prUrl?.match(/\/pull\/(\d+)/)?.[1]}</Button>;
}
function Overview({ task, facts, history }: { task: TaskDetailDto; facts: PullRequestFacts | null; history: HistoryEventDto[] }) {
  const state = cardStatus(task);
  const sdk = useSdk();
  const reviewer = history.filter((event) => event.review).at(-1)?.review;
  const approved = state.status === "ready" && reviewer?.verdict === "approve" ? reviewer : null;
  return <>
    {task.error && <InlineAlert>{task.error}</InlineAlert>}
    <Section title="Status"><div className={cn(BOX, "boat-task-status-box")}>
      <div className="boat-task-line"><span className="boat-task-status" data-tone={state.tone}><i aria-hidden="true" /><strong>{state.label}</strong></span>
        {approved && <span className="boat-task-muted">approved by {PROVIDER_LABEL[approved.provider]} · review {approved.round}</span>}</div>
      <div className="boat-task-actions">{state.status === "ready" && task.delivery === "pr" && task.prUrl ? <MergeAction task={task} /> : task.canShip ? <ShipButton task={task} /> : null}
        {task.previewUrl && <UrlLink href={task.previewUrl} className="boat-task-outline-link">Preview ↗</UrlLink>}</div>
    </div></Section>
    <Section title="Brief"><div className={BOX}>
      {task.source.threadId && <p className="boat-task-origin"><AgentLogo provider={task.provider} className="size-[11px]" /> <button type="button" onClick={() => void sdk.threads.open({ threadId: task.source.threadId!, file: null })}>From {task.source.title || "source chat"}</button></p>}
      <Markdown content={task.brief || "No brief recorded."} className="boat-task-brief" />
    </div></Section>
    <Section title="Change"><div className={cn(BOX, "boat-task-change")}>
      <div className="boat-task-line"><strong>{task.prUrl ? `PR #${task.prUrl.match(/\/pull\/(\d+)/)?.[1]}` : task.repo ?? "Committed change"}</strong>
        {facts && <span className="boat-task-muted"><DiffStats additions={facts.additions} deletions={facts.deletions} />{facts.fileCount !== undefined ? ` · ${facts.fileCount} files` : ""}</span>}
        {task.prUrl && <UrlLink href={task.prUrl} className="boat-task-trailing">GitHub ↗</UrlLink>}</div>
      {facts?.files?.map((file) => <div className="boat-task-file" key={file.path}><code>{file.path}</code><DiffStats additions={file.additions} deletions={file.deletions} className="gap-2" /></div>)}
      {facts?.filesTruncated && <p className="boat-task-muted">Showing the first 50 files. See the rest on GitHub.</p>}
      {task.branch && <p className="boat-task-muted">branch <code>{task.branch}</code></p>}
    </div></Section>
    <Section title="Who"><div className={cn(BOX, "boat-task-who")}>
      <div className="boat-task-line"><AgentLogo provider={task.provider} className="size-3" /><span>{PROVIDER_LABEL[task.provider]}{task.model ? ` · ${modelName(task.model)}` : ""}</span>{task.tier && <span className="boat-task-trailing boat-task-muted">{task.tier[0].toUpperCase() + task.tier.slice(1)} preset</span>}</div>
      <div className="boat-task-line"><span className="boat-task-muted">Started</span><span className="boat-task-trailing">{taskClock(task.createdAt)}{task.source.title ? ` by ${task.source.title}` : ""}</span></div>
      {reviewer && <div className="boat-task-line"><AgentLogo provider={reviewer.provider} className="size-3" /><span>Reviewer: {PROVIDER_LABEL[reviewer.provider]}{reviewer.model ? ` · ${modelName(reviewer.model)}` : ""}</span></div>}
    </div></Section>
  </>;
}

function Reviews({ task, history }: { task: TaskDetailDto; history: HistoryEventDto[] }) {
  const { openTask } = useCloudAgentsNavigation();
  const entries = history.filter((event) => event.kind === "review-verdict" || event.kind === "sent-back" || (event.kind === "finished" && history.some((prior) => prior.kind === "sent-back" && prior.seq < event.seq)));
  const latest = entries.filter((event) => event.review).at(-1)?.review;
  const sdk = useSdk();
  const [requested, setRequested] = useState<string | null>(null);
  const { data: detail } = useTask(requested ?? latest?.reviewTaskId ?? null);
  useEffect(() => {
    if (!requested || detail?.task?.id !== requested) return;
    if (detail.task.threadId) void sdk.threads.open({ threadId: detail.task.threadId, file: null }).catch(showError);
    else openTask(requested);
    setRequested(null);
  }, [requested, detail, sdk, openTask]);
  return <>
    {entries.length === 0 ? <EmptyBox>No reviews recorded for this task yet.</EmptyBox> : <ol className="boat-task-history" aria-label="Review history">
      {entries.map((event) => { const review = event.review; const provider = review?.provider ?? event.provider ?? task.provider;
        const label = review ? `Review ${review.round} · ${review.verdict === "approve" ? "approved" : review.verdict === "changes-requested" ? `${PROVIDER_LABEL[provider]} asked for ${review.findings.length || ""} changes`.replace("for  changes", "for changes") : "review finished"}`
          : event.kind === "sent-back" ? `Sent back to ${PROVIDER_LABEL[provider].replace(" Code", "")}` : event.text;
        return <li className="boat-task-event" key={event.seq}>
          <time dateTime={event.at}>{taskClock(event.at)}</time><div className="boat-task-event-track"><AgentLogo provider={provider} /><i aria-hidden="true" /></div>
          <div className="boat-task-event-body"><p className={cn("boat-task-event-title", review?.verdict === "approve" ? "boat-task-added" : review?.verdict === "changes-requested" ? "boat-task-caution" : "")}>
            {review ? <button type="button" onClick={() => setRequested(review.reviewTaskId)}>{label}</button> : label}</p>
            {review?.findings.map((finding, index) => <div className="boat-task-finding" key={index}><span className={finding.severity === "must-fix" ? "boat-task-caution" : "boat-task-muted"}>{finding.label ?? (finding.severity === "must-fix" ? "Must fix" : "Should")}</span><span>{finding.text}</span></div>)}
            {event.kind === "sent-back" && event.detail && <p className="boat-task-event-detail">{event.detail}</p>}
          </div>
        </li>;
      })}
    </ol>}
    <p className="boat-task-advice">Each review runs in a fresh context on the {latest?.provider === task.provider ? "review" : "other"} agent. {latest ? <button type="button" onClick={() => setRequested(latest.reviewTaskId)}>Open the full review{detail?.task?.threadId ? " as a chat" : ""} ↗</button> : null}</p>
  </>;
}

function Transcript({ task }: { task: TaskDetailDto }) {
  return task.runner === "chat" && task.threadId ? <ChatTranscript task={task} /> : <BoatTranscript task={task} />;
}
function ChatTranscript({ task }: { task: TaskDetailDto }) {
  const sdk = useSdk();
  const [rows, setRows] = useState<NativeRow[] | null>(null);
  const [titles, setTitles] = useState<Map<number, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [full, setFull] = useState(false);
  const id = useId();
  useEffect(() => {
    const abort = new AbortController();
    void sdk.threads.timeline({ threadId: task.threadId!, includeNestedRows: "true", summaryOnly: "false", segmentLimit: "100", signal: abort.signal })
      .then((timeline) => { if (!abort.signal.aborted) { setRows(timeline.rows); setError(null); } })
      .catch((reason: unknown) => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "Couldn't load the conversation."); });
    // Optional authored labels must never delay the actual timeline.
    void sdk.threads.events.list({ threadId: task.threadId!, types: ["item/completed"], order: "desc", limit: "100", signal: abort.signal })
      .then((events) => { if (!abort.signal.aborted) setTitles(nativeActivityTitles(events)); })
      .catch(() => { if (!abort.signal.aborted) setTitles(new Map()); });
    return () => abort.abort();
  }, [sdk, task.threadId, task.updatedAt]);
  const turns = rows?.filter((row): row is NativeTurn => row.kind === "turn");
  const messages = rows?.filter((row) => row.kind === "conversation" && row.role === "assistant");
  return <>
    <Search id={id} query={query} onChange={setQuery} />
    {error && <InlineAlert>{error}</InlineAlert>}
    {rows === null && !error ? <EmptyBox>Loading conversation…</EmptyBox> : turns?.length ? <ol className="boat-task-transcript">
      {turns.map((turn, index) => <NativeTranscriptTurn key={turn.id} task={task} turn={turn} query={query} initialOpen={index === 0} messages={rows?.filter((row) => row.kind !== "turn") ?? []} titles={titles} />)}
    </ol> : <ol className="boat-task-transcript">{messages?.map((row) => row.kind === "conversation" && row.role === "assistant" && transcriptPreview(row.text).toLowerCase().includes(query.toLowerCase()) ? <li key={row.id} className="boat-task-turn"><time>{taskClock(row.startedAt)}</time><AgentLogo provider={task.provider} /><p>{transcriptPreview(row.text)}</p></li> : null)}</ol>}
    <button type="button" className="boat-task-text-link" onClick={() => setFull((value) => !value)}>{full ? "Hide full log" : "Open full log ↗"}</button>
    {full && <div className="min-h-64"><ThreadChat threadId={task.threadId!} variant="timeline" layout="document" /></div>}
  </>;
}
function NativeTranscriptTurn({ task, turn, query, initialOpen, messages, titles }: { task: TaskDetailDto; turn: NativeTurn; query: string; initialOpen: boolean; messages: NativeRow[]; titles: Map<number, string> }) {
  const sdk = useSdk();
  const [load, setLoad] = useState(false);
  const [rows, setRows] = useState<NativeRow[] | null>(turn.children);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setRows(turn.children); }, [turn]);
  useEffect(() => {
    if (!load || rows !== null) return;
    const abort = new AbortController();
    void sdk.threads.timelineTurnSummaryDetails({ threadId: task.threadId!, turnId: turn.turnId, sourceSeqStart: String(turn.sourceSeqStart), sourceSeqEnd: String(turn.sourceSeqEnd), signal: abort.signal })
      .then((data) => { if (!abort.signal.aborted) setRows(data.rows); }).catch((reason: unknown) => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "Couldn't load the turn."); });
    return () => abort.abort();
  }, [sdk, task.threadId, turn.turnId, turn.sourceSeqStart, turn.sourceSeqEnd, load, rows]);
  const milestones = nativeMilestones(turn, rows ?? [], messages);
  return <>{milestones.map((milestone, index) => <NativeTranscriptMilestone key={milestone.id} task={task} milestone={milestone} query={query} initialOpen={initialOpen && index === 1} loading={rows === null} error={error} onExpand={() => setLoad(true)} title={milestone.message ? titles.get(milestone.message.sourceSeqEnd) : undefined} />)}</>;
}
function NativeTranscriptMilestone({ task, milestone, query, initialOpen, loading, error, onExpand, title: authoredTitle }: { task: TaskDetailDto; milestone: NativeMilestone; query: string; initialOpen: boolean; loading: boolean; error: string | null; onExpand(): void; title?: string }) {
  const [expanded, setExpanded] = useState(initialOpen);
  useEffect(() => { if (expanded && loading) onExpand(); }, [expanded, loading]);
  const title = authoredTitle ?? (milestone.message ? transcriptPreview(milestone.message.text).split("\n")[0] : "Agent activity");
  if (query && !JSON.stringify(milestone.work).toLowerCase().includes(query.toLowerCase()) && !title.toLowerCase().includes(query.toLowerCase())) return null;
  return <li><details className="boat-task-native-turn" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}><summary>
    <time>{taskClock(milestone.at)}</time><AgentLogo provider={task.provider} /><span>{title}<small>{nativeWorkCounts(milestone)}</small></span><span className="boat-task-chevron">{expanded ? "⌄" : "›"}</span>
  </summary>{expanded && <div className="boat-task-turn-detail" aria-label="Selected recorded evidence; the full log contains all activity">{error ? <InlineAlert>{error}</InlineAlert> : loading ? <p>Loading turn…</p> : nativeEvidence(milestone).map((row) => {
    return row.workKind === "command" ? <div key={row.id}><pre>$ {row.command}</pre>{row.output && <pre className={row.exitCode === 0 ? "boat-task-added" : row.exitCode !== null ? "boat-task-removed" : ""}>{row.output.split("\n").slice(0, 3).join("\n").slice(0, 600)}</pre>}</div>
      : row.workKind === "file-change" ? <p className="boat-task-code" key={row.id}>edit {row.change.path} <DiffStats additions={row.change.diffStats.added} deletions={row.change.diffStats.removed} /></p>
      : row.workKind === "tool" ? <pre key={row.id}>{row.toolName}{typeof row.toolArgs?.command === "string" ? ` ${row.toolArgs.command}` : ""}{row.output ? `\n${row.output.slice(0, 8_000)}` : ""}</pre>
      : row.workKind === "file-read" ? <p className="boat-task-code" key={row.id}>read {row.path}</p>
      : <p key={row.id}>{("presentation" in row ? row.presentation?.label.completed : null) ?? row.workKind}</p>;
  })}</div>}</details></li>;
}
function taskClock(value: string | number | null) {
  if (value === null) return "";
  return new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
}

function Search({ id, query, onChange }: { id: string; query: string; onChange(value: string): void }) {
  return <label htmlFor={id} className="boat-task-search"><Icon name="Search" className="size-3.5" aria-hidden /><span className="sr-only">Search transcript</span><input id={id} type="search" value={query} onChange={(event) => onChange(event.target.value)} placeholder="Search transcript" /></label>;
}

function BoatTranscript({ task }: { task: TaskDetailDto }) {
  const { data, error, refetch, isFetching } = experimental_useRpcQuery({ contract: rpcContract, method: "transcript", input: { id: task.id, limit: 500 } });
  const [query, setQuery] = useState("");
  const id = useId();
  useInterval(() => void refetch(), isRunning(task.status) ? 5_000 : null);
  const turns = useMemo(() => groupTaskTranscript(data?.events ?? []), [data]);
  const visible = turns.filter((turn) => transcriptMatches(turn, query));
  return <>
    <Search id={id} query={query} onChange={setQuery} />
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
  const [deleting, setDeleting] = useState(false);
  const action = experimental_useRpcMutation({ contract: rpcContract, method: "sandboxAction" });
  const previewAction = experimental_useRpcMutation({ contract: rpcContract, method: "previewAction" });
  const { data: previews } = usePreviews(null, task.id);
  const { data: usage } = experimental_useRpcQuery({ contract: rpcContract, method: "fidelityUsage", input: { taskId: task.id } });
  const { data: settings } = experimental_useRpcQuery({ contract: rpcContract, method: "settings", input: null });
  const idle = settings?.settings.find((setting) => setting.key === "stopIdleAfterMinutes")?.value;
  const stopped = sandbox?.state === "stopped" || sandbox?.state === "archived";
  const points = memory?.series ?? [];
  async function run(kind: "stop" | "resume" | "delete") {
    if (!task.sandboxId) return;
    try { await action.mutate({ id: task.sandboxId, action: kind }); setDeleting(false); } catch (reason) { showError(reason); }
  }
  return <>
    {(sandboxes.error || sandboxes.data?.error) && <InlineAlert>{sandboxes.error?.message ?? sandboxes.data?.error}</InlineAlert>}
    <div className={cn(BOX, "boat-task-sandbox-state")}>
      <div className="boat-task-line"><span className="boat-task-status" data-tone={!sandbox || stopped ? "neutral" : "positive"}><i aria-hidden="true" /><strong>{sandbox ? stopped ? "Stopped" : "On" : "Sandbox"}</strong></span>
        {memory?.size && <span className="boat-task-muted">{memory.size.label} · {memory.size.summary.replace(", ", " · ")}</span>}</div>
      {typeof idle === "number" && <p className="boat-task-muted">{idle > 0 ? `Stops after ${idle >= 60 && idle % 60 === 0 ? `${idle / 60} h` : `${idle} min`} idle · your next message resumes it` : "Stays on while this task is open"}</p>}
    </div>
    {(memory?.peak || points.length > 0 || memory?.oom) && <Section title="Memory"><div className={cn(BOX, "boat-task-memory")}>
      <div className="boat-task-line"><span>This run</span>{memory?.peak && <span className="boat-task-trailing boat-task-muted">peak {memory.peak.usedGb.toFixed(1)} of {memory.peak.totalGb} GB</span>}</div>
      {points.length > 0 && <MemoryChart points={points} />}
      {memory?.peak?.shared && <p className="boat-task-muted">Shared with other tasks on this sandbox</p>}
      {memory?.oom && <p className="boat-task-removed">{memory.oom.message}</p>}
    </div></Section>}
    {(previews?.previews.length ?? 0) > 0 && <Section title="Preview">{previews!.previews.map((preview) => <div className={cn(BOX, "boat-task-preview")} key={preview.id}>
      <span className="boat-task-status" data-tone={preview.state === "live" ? "positive" : "neutral"}><i aria-hidden="true" /><span>{preview.state === "live" ? "Live" : preview.state === "sleeping" ? "Sleeping" : "Expired"}</span></span>
      <UrlLink href={preview.link} className="boat-task-preview-link">{previewHost(preview.link)}</UrlLink>
      <div className="boat-task-actions"><Button size="sm" variant="outline" className="boat-task-outline-action" disabled={previewAction.isPending} onClick={() => void previewAction.mutate({ id: preview.id, action: "wake" }).catch(showError)}>Wake</Button>
      <Button size="sm" variant="outline" className="boat-task-outline-action" disabled={previewAction.isPending} onClick={() => void previewAction.mutate({ id: preview.id, action: "extend", hours: 2 }).catch(showError)}>Extend</Button></div>
    </div>)}</Section>}
    <Section title="Actions"><div className={cn(BOX, "boat-task-sandbox-actions")}>
      <div className="boat-task-actions">{sandbox && <Button variant="outline" size="sm" className="boat-task-outline-action" disabled={action.isPending} onClick={() => void run(stopped ? "resume" : "stop")}>{stopped ? "Resume" : "Stop"}</Button>}
        {memory?.canResize && <Button variant="outline" size="sm" className="boat-task-outline-action" onClick={() => setResizing(true)}>Continue on a larger sandbox</Button>}</div>
      {memory?.next && <p className="boat-task-caution">{memory.next.label} {memory.next.detail.includes("double rate") ? "costs 2× per hour" : memory.next.detail.includes("half rate") ? "costs half per hour" : memory.next.detail}</p>}
      {task.ownsSandbox && sandbox && <div className="boat-task-delete-row"><span className="boat-task-muted">Delete removes the sandbox and its files</span><Button size="sm" variant="outline" className="boat-task-outline-action boat-task-removed" disabled={action.isPending} onClick={() => setDeleting(true)}>Delete</Button></div>}
    </div></Section>
    {usage?.task && (usage.task.hours !== null || usage.task.dollars !== null) && <Section title="Cost"><div className={cn(BOX, "boat-task-line boat-task-cost")}>
      <span className="boat-task-muted" title="Sandbox usage during this task's recorded window">This task</span><span className="boat-task-trailing">{usage.task.hours !== null ? `${usage.task.hours.toFixed(1)} sandbox hours` : ""}{usage.task.dollars !== null ? `${usage.task.hours !== null ? " · " : ""}about $${usage.task.dollars.toFixed(2)}` : ""}</span>
    </div></Section>}
    <ConfirmDialog open={deleting} onOpenChange={setDeleting} title="Delete this sandbox?" description="The sandbox and its disk are removed. Unpushed work is lost." confirmLabel="Delete sandbox" destructive pending={action.isPending} onConfirm={() => void run("delete")} />
    <ResizeDialog task={task} mode={memory?.oom ? "oom" : "general"} open={resizing} onOpenChange={setResizing} />
  </>;
}
function MemoryChart({ points }: { points: NonNullable<TaskDetailDto["memory"]>["series"] & {} }) {
  const first = points[0]; const last = points.at(-1)!;
  const start = Date.parse(first.at); const span = Math.max(1, Date.parse(last.at) - start);
  const width = Math.min(32, 414 / points.length - 3);
  const peak = Math.max(...points.map((point) => point.usedGb));
  return <div className="boat-task-memory-chart"><svg viewBox="0 0 414 52" preserveAspectRatio="none" role="img" aria-label={`Measured memory from ${taskClock(first.at)} to ${taskClock(last.at)}`}>
    <line x1="0" y1="0.5" x2="414" y2="0.5" className="boat-task-memory-rule" />
    {points.map((point, index) => <rect key={point.at} x={(Date.parse(point.at)-start)/span*(414-Math.max(1,width))} y={52-Math.max(1,point.usedGb/Math.max(peak,0.01)*46)} width={Math.max(1,width)} height={Math.max(1,point.usedGb/Math.max(peak,0.01)*46)} rx="2" className={point.usedGb === peak ? "boat-task-memory-peak" : "boat-task-memory-bar"}><title>{taskClock(point.at)}: {point.usedGb} of {point.totalGb} GB</title></rect>)}
  </svg><div className="boat-task-line boat-task-memory-window"><span>Observed {taskClock(first.at)}</span><span className="boat-task-trailing">{taskClock(last.at)}</span></div>
    <span className="sr-only">Observed window only. Missing measurements are not interpolated.</span></div>;
}

function previewHost(value: string): string { try { return new URL(value).hostname; } catch { return "Open preview"; } }
