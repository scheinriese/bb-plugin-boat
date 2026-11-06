// One task: header, metadata, actions, Report / Transcript / Brief / History
// tabs, and a sticky follow-up box.
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { Markdown, experimental_useRpcMutation, experimental_useRpcQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { rpcContract, type ChatEventDto, type TaskDetailDto } from "../contract";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { CloseTaskDialog, NewTaskDialog, ReviewDialog, SaveSnapshotDialog, submitOnModEnter } from "./dialogs";
import { canRequestReview, historyText, isCheckRepoTask, isTestTask, sandboxLink } from "./logic";
import { ShipButton } from "./board";
import { PreviewsSection } from "./previews";
import { SandboxSizeLabel, SandboxSizePanel } from "./sandbox-size";
import {
  PROVIDER_LABEL,
  ROLE_LABEL,
  STATUS_LABEL,
  clockTime,
  dateTime,
  isClosed,
  isRunning,
  plural,
  relativeTime,
  shortRepo,
  taskReference,
  workerChatId,
  type Provider,
} from "./format";
import { useCloudAgentsNavigation, useCopy, useInterval, useNow, useOverview, useSandboxes, useTask } from "./hooks";
import {
  AgentBadge,
  EmptyBox,
  InlineAlert,
  Kbd,
  PrLink,
  ReportChip,
  PhasePill,
  RoleIcon,
  ThreadLink,
  showError,
} from "./ui";

const COLUMN = "mx-auto box-border w-full max-w-4xl px-4 md:px-5";

export function TaskDetail({ id }: { id: string }) {
  const { data, error } = useTask(id);
  if (data === undefined || data.task === null) {
    return (
      <div className={cn(COLUMN, "space-y-4 pb-10 pt-3 md:pt-4")}>
        <BackLink />
        {data?.task === null ? (
          <EmptyBox>
            No task <span className="font-mono">{id}</span>. It may have been removed.
          </EmptyBox>
        ) : error ? (
          <InlineAlert>{error.message}</InlineAlert>
        ) : (
          <EmptyBox>Loading task…</EmptyBox>
        )}
      </div>
    );
  }
  return <TaskView task={data.task} />;
}

function BackLink() {
  const { openOverview } = useCloudAgentsNavigation();
  return (
    <button
      type="button"
      onClick={openOverview}
      className="-ml-1 inline-flex items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Icon name="ArrowLeft" className="size-3.5" aria-hidden />
      Cloud agents
    </button>
  );
}

type TabId = "report" | "transcript" | "brief" | "history";
const TABS: readonly { id: TabId; label: string }[] = [
  { id: "report", label: "Report" },
  { id: "transcript", label: "Transcript" },
  { id: "brief", label: "Brief" },
  { id: "history", label: "History" },
];

/** "live": the sandbox link leads somewhere; a closed task's only while boat still lists its sandbox. */
type SandboxLinkState = ReturnType<typeof sandboxLink>;

function useSandboxLink(task: TaskDetailDto): SandboxLinkState {
  const { data } = useSandboxes(task.sandboxId !== null && isClosed(task.status));
  return sandboxLink(task, data !== undefined && data.error === null ? data.sandboxes : null);
}

function TaskView({ task }: { task: TaskDetailDto }) {
  const now = useNow();
  const [tab, setTab] = useState<TabId>(task.result ? "report" : "transcript");
  const baseId = useId();
  const link = useSandboxLink(task);

  return (
    <div className="flex min-h-full flex-col">
      <div className={cn(COLUMN, "flex-1 space-y-5 pb-6 pt-3 md:pt-4")}>
        <BackLink />
        <TaskHeader task={task} now={now} />
        <TaskActions task={task} link={link} />
        <TaskMeta task={task} link={link} />
        <SandboxSizePanel task={task} />
        <SnapshotOffer task={task} />
        <TestTaskNext task={task} />
        <PreviewsSection threadId={null} taskId={task.id} showTask={false} />
        <div className="space-y-4">
          <TabBar value={tab} onChange={setTab} baseId={baseId} historyCount={task.events.length} />
          <div role="tabpanel" id={`${baseId}-panel-${tab}`} aria-labelledby={`${baseId}-tab-${tab}`}>
            {tab === "report" ? (
              <ReportPanel task={task} />
            ) : tab === "transcript" ? (
              task.runner === "chat" ? (
                <ChatTranscriptNote task={task} />
              ) : (
                <TranscriptPanel task={task} />
              )
            ) : tab === "brief" ? (
              <Markdown content={task.brief} className="text-sm" />
            ) : (
              <HistoryPanel task={task} />
            )}
          </div>
        </div>
      </div>
      <ReplyBox task={task} />
    </div>
  );
}

// -------------------------------------------------------------------- header

function TaskHeader({ task, now }: { task: TaskDetailDto; now: number }) {
  return (
    <header className="flex items-start gap-3">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-card">
        <RoleIcon role={task.role} />
      </div>
      <div className="min-w-0 flex-1">
        <h1 className="text-lg font-semibold leading-snug text-pretty text-foreground">{task.title}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{ROLE_LABEL[task.role]}</span>
          <AgentBadge provider={task.provider} model={task.model} />
          <span className="tabular-nums">{plural(task.turns, "turn")}</span>
          <span className="font-mono">{task.id}</span>
          <span className="tabular-nums">updated {relativeTime(task.updatedAt, now)}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {/* A report that says "done" repeats Finished: one pill is enough. */}
        {task.verdict !== null || (task.reportStatus !== null && task.reportStatus !== "done") ? <ReportChip task={task} /> : null}
        <PhasePill task={task} />
      </div>
    </header>
  );
}

function MetaRow({ label, icon, children }: { label: string; icon: string; children: ReactNode }) {
  return (
    <>
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon name={icon} className="size-3.5" aria-hidden />
        {label}
      </dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-foreground">{children}</dd>
    </>
  );
}

function TaskMeta({ task, link }: { task: TaskDetailDto; link: SandboxLinkState }) {
  const navigate = useBbNavigate();
  const { openTask, openOrchestrator } = useCloudAgentsNavigation();
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-6 gap-y-2 rounded-lg border border-border bg-card px-4 py-3">
        <MetaRow label="Repository" icon="FolderGit">
          {task.repo ? <span className="truncate">{shortRepo(task.repo)}</span> : <Muted>none</Muted>}
          {task.branch ? (
            <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <Icon name="GitBranch" className="size-3.5 shrink-0" aria-label="branch" />
              <span className="truncate font-mono">{task.branch}</span>
              {task.baseBranch ? (
                <span className="truncate">
                  into <span className="font-mono">{task.baseBranch}</span>
                </span>
              ) : null}
            </span>
          ) : null}
        </MetaRow>
        <MetaRow label="Pull request" icon="GitPullRequest">
          {task.prUrl ? (
            <>
              <PrLink url={task.prUrl} className="text-sm text-foreground" />
              <span className="truncate text-xs text-muted-foreground">{task.prUrl.replace(/^https?:\/\//, "")}</span>
            </>
          ) : (
            <Muted>{isRunning(task.status) ? "not yet" : "none"}</Muted>
          )}
        </MetaRow>
        <MetaRow label="Sandbox" icon="ComputerCloud">
          {task.sandboxId ? (
            <>
              <span className="font-mono text-xs">{task.sandboxId}</span>
              {!task.ownsSandbox ? <Muted>shared</Muted> : null}
              {link === "gone" ? <Muted>deleted</Muted> : null}
              {link !== "gone" ? <SandboxSizeLabel task={task} /> : null}
              {task.dashboardUrl && link === "live" ? (
                <button
                  type="button"
                  onClick={() => task.dashboardUrl && navigate.openUrl(task.dashboardUrl)}
                  className="inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  Open in boat <Icon name="ExternalLink" className="size-3" aria-hidden />
                </button>
              ) : null}
            </>
          ) : (
            <Muted>{task.status === "starting" ? "starting…" : "none"}</Muted>
          )}
        </MetaRow>
        {task.runner === "chat" ? (
          <MetaRow label="Chat" icon="Bot">
            {task.threadId ? (
              <ThreadLink threadId={task.threadId} label="Open task chat" className="text-sm" />
            ) : (
              <Muted>{task.status === "starting" ? "starting…" : "none"}</Muted>
            )}
          </MetaRow>
        ) : null}
        <MetaRow label="Started by" icon={task.source.kind === "orchestrator" ? "Workflow" : task.source.kind === "chat" ? "MessageSquare" : "ComputerCloud"}>
          {task.source.threadId ? (
            <>
              <ThreadLink threadId={task.source.threadId} label={task.source.kind === "orchestrator" ? "Open orchestrator chat" : "Open chat"} className="text-sm" />
              {task.source.kind === "orchestrator" ? (
                <button
                  type="button"
                  onClick={() => task.source.threadId && openOrchestrator(task.source.threadId)}
                  className="inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <Icon name="Workflow" className="size-3.5" aria-hidden />
                  Orchestrator board
                </button>
              ) : null}
            </>
          ) : (
            <Muted>you</Muted>
          )}
        </MetaRow>
        {task.parentTaskId ? (
          <MetaRow label="Parent task" icon="ChildThread">
            <button
              type="button"
              onClick={() => task.parentTaskId && openTask(task.parentTaskId)}
              className="rounded-sm font-mono text-xs text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {task.parentTaskId}
            </button>
          </MetaRow>
        ) : null}
        <MetaRow label="Started" icon="Clock">
          <span className="text-xs tabular-nums text-muted-foreground">
            {dateTime(task.createdAt)}
            {task.finishedAt ? ` · finished ${dateTime(task.finishedAt)}` : ""}
          </span>
        </MetaRow>
      </dl>
      {/* Out of memory: the size panel below says it, with what to do. */}
      {task.error && !task.memory?.oom ? <InlineAlert>{task.error}</InlineAlert> : null}
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-xs text-muted-foreground">{children}</span>;
}

/** After a test task that worked: the next step. */
function TestTaskNext({ task }: { task: TaskDetailDto }) {
  const [creating, setCreating] = useState(false);
  if (!isTestTask(task) || task.status !== "idle" || task.turns === 0 || task.reportStatus !== "done") return null;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-3 sm:flex-row sm:items-center">
      <Icon name="CircleCheck" className="hidden size-4 shrink-0 text-success sm:block" aria-hidden />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-medium text-foreground">Your setup works</p>
        <p className="text-xs text-pretty text-muted-foreground">Next: start a task on one of your repos. Close this one when you've read its report.</p>
      </div>
      <Button size="sm" className="h-7 shrink-0 self-start sm:self-auto" onClick={() => setCreating(true)}>
        <Icon name="Plus" /> New task
      </Button>
      <NewTaskDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

/** After "Check this repo runs in a sandbox": keep the set-up sandbox as a snapshot. */
function SnapshotOffer({ task }: { task: TaskDetailDto }) {
  const [saving, setSaving] = useState(false);
  if (!isCheckRepoTask(task.title) || task.sandboxId === null || !task.ownsSandbox || task.status !== "idle" || task.turns === 0) return null;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-3 sm:flex-row sm:items-center">
      <Icon name="Download" className="hidden size-4 shrink-0 text-muted-foreground sm:block" aria-hidden />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-medium text-foreground">Save this sandbox as a snapshot?</p>
        <p className="text-xs text-pretty text-muted-foreground">
          It has the repo and its dependencies installed. New tasks can start from it instead of setting everything up again.
        </p>
      </div>
      <Button size="sm" className="h-7 shrink-0 self-start sm:self-auto" onClick={() => setSaving(true)}>
        Save as snapshot…
      </Button>
      <SaveSnapshotDialog task={task} open={saving} onOpenChange={setSaving} />
    </div>
  );
}

// ------------------------------------------------------------------- actions

function TaskActions({ task, link }: { task: TaskDetailDto; link: SandboxLinkState }) {
  const navigate = useBbNavigate();
  const copy = useCopy();
  const interrupt = experimental_useRpcMutation({ contract: rpcContract, method: "interrupt" });
  const [reviewing, setReviewing] = useState(false);
  const [closing, setClosing] = useState(false);
  const running = isRunning(task.status);
  const closed = isClosed(task.status);
  const chatId = workerChatId(task);

  const sendInterrupt = async () => {
    try {
      await interrupt.mutate({ id: task.id });
      toast.success("Interrupt sent");
    } catch (error) {
      showError(error);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {chatId ? (
        <Button size="sm" onClick={() => navigate.toThread(chatId)}>
          <Icon name="MessageSquare" /> Open chat
        </Button>
      ) : null}
      {task.canShip ? <ShipButton task={task} className="my-0" /> : null}
      {canRequestReview(task) ? (
        <Button variant="outline" size="sm" disabled={running} onClick={() => setReviewing(true)}>
          <Icon name="Eye" /> Request review
        </Button>
      ) : null}
      {task.status === "running" ? (
        <Button variant="outline" size="sm" disabled={interrupt.isPending} onClick={() => void sendInterrupt()}>
          <Icon name={interrupt.isPending ? "Loading" : "Pause"} className={cn(interrupt.isPending && "animate-spin")} />
          Interrupt
        </Button>
      ) : null}
      {!closed ? (
        <Button variant="outline" size="sm" onClick={() => setClosing(true)}>
          <Icon name={running ? "Square" : "CircleCheck"} />
          {running ? "Cancel" : "Close"}
        </Button>
      ) : null}
      <Button variant="ghost" size="sm" onClick={() => void copy(taskReference(task), "Reference copied")}>
        <Icon name="Copy" /> Copy reference
      </Button>
      {task.dashboardUrl && link === "live" ? (
        <Button variant="ghost" size="sm" onClick={() => task.dashboardUrl && navigate.openUrl(task.dashboardUrl)}>
          <Icon name="ExternalLink" /> Open in boat
        </Button>
      ) : null}
      <ReviewDialog task={task} open={reviewing} onOpenChange={setReviewing} />
      <CloseTaskDialog task={task} open={closing} onOpenChange={setClosing} />
    </div>
  );
}

// ---------------------------------------------------------------------- tabs

function TabBar({
  value,
  onChange,
  baseId,
  historyCount,
}: {
  value: TabId;
  onChange: (tab: TabId) => void;
  baseId: string;
  historyCount: number;
}) {
  const refs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((tab) => tab.id === value);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    else return;
    event.preventDefault();
    const tab = TABS[next]!.id;
    onChange(tab);
    refs.current[tab]?.focus();
  };
  return (
    <div role="tablist" aria-label="Task details" onKeyDown={onKeyDown} className="flex gap-1 border-b border-border">
      {TABS.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(element) => {
              refs.current[tab.id] = element;
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`${baseId}-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={cn(
              "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
              selected
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
            {tab.id === "history" && historyCount > 0 ? (
              <span className="text-xs tabular-nums text-muted-foreground">{historyCount}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** Split a worker reply into its prose and the `=== REPORT/REVIEW ===` fields. */
function splitReport(text: string): { body: string; fields: { key: string; value: string }[] } {
  const match = text.match(/^=== (REPORT|REVIEW) ===\s*$([\s\S]*?)(?:^=== END (?:REPORT|REVIEW) ===\s*$|$(?![\s\S]))/m);
  if (!match || match.index === undefined) return { body: text, fields: [] };
  const fields: { key: string; value: string }[] = [];
  for (const line of (match[2] ?? "").split("\n")) {
    const field = line.match(/^([A-Z][A-Z -]{1,30}):\s*(.*)$/);
    if (field) fields.push({ key: field[1]!, value: field[2] ?? "" });
    else if (fields.length > 0 && line.trim() !== "") fields[fields.length - 1]!.value += `\n${line}`;
  }
  const body = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
  return { body, fields };
}

const FIELD_LABELS: Record<string, string> = { PR: "Pull request", "BLOCKING ISSUES": "Blocking issues", "NON-BLOCKING": "Non-blocking" };

function sentenceCase(key: string): string {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  const lower = key.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function ReportPanel({ task }: { task: TaskDetailDto }) {
  if (task.result) {
    const { body, fields } = splitReport(task.result);
    return (
      <div className="space-y-4">
        {fields.length > 0 ? (
          <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-4 py-3 text-sm">
            {fields.map((field) => (
              <div key={field.key} className="contents">
                <dt className="text-muted-foreground">{sentenceCase(field.key)}</dt>
                <dd className="min-w-0 break-words">
                  <Markdown content={field.value.trim() || "—"} className="text-sm" />
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {body ? <Markdown content={body} className="text-sm" /> : null}
      </div>
    );
  }
  return (
    <EmptyBox>
      {isRunning(task.status)
        ? "The agent is still working. Its report appears here when the turn ends."
        : "No report. The agent's last reply had no report block."}
    </EmptyBox>
  );
}

function HistoryPanel({ task }: { task: TaskDetailDto }) {
  if (task.events.length === 0) return <EmptyBox>No events yet.</EmptyBox>;
  return (
    <ol className="divide-y divide-border rounded-lg border border-border bg-card">
      {task.events.map((event, index) => (
        <li key={`${event.at}-${index}`} className="flex flex-col gap-1 px-4 py-2 sm:flex-row sm:gap-3">
          <time dateTime={event.at} className="w-32 shrink-0 text-xs tabular-nums text-muted-foreground">
            {dateTime(event.at)}
          </time>
          <span className="w-28 shrink-0 text-xs font-medium text-foreground">{event.kind}</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {historyText(event, dateTime)}
          </span>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------- transcript

type TranscriptEntry =
  | { key: string; kind: "prompt"; status: string | null; content: string | null; at: number | null }
  | { key: string; kind: "tools"; tools: string[] }
  | { key: string; kind: "reply"; content: string; at: number | null }
  | { key: string; kind: "error"; text: string }
  | { key: string; kind: "other"; type: string; content: string };

/** Fold boat's chat events into readable entries. */
function buildTranscript(events: readonly ChatEventDto[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  // boat re-emits a prompt event as its status changes (queued → running →
  // finished); events of one prompt run share a timestamp.
  const promptByTime = new Map<number, number>();
  events.forEach((event, index) => {
    const key = `${index}`;
    if (event.type === "prompt") {
      const existing = event.timestamp === null ? undefined : promptByTime.get(event.timestamp);
      if (existing !== undefined) {
        const entry = entries[existing];
        if (entry?.kind === "prompt") {
          entries[existing] = { ...entry, status: event.status ?? entry.status, content: entry.content ?? event.content };
        }
      } else {
        if (event.timestamp !== null) promptByTime.set(event.timestamp, entries.length);
        entries.push({ key, kind: "prompt", status: event.status, content: event.content, at: event.timestamp });
      }
    } else if (event.type === "response") {
      if (event.tools.length > 0) entries.push({ key: `${key}-tools`, kind: "tools", tools: event.tools });
      if (event.content && event.content.trim() !== "") {
        entries.push({ key, kind: "reply", content: event.content, at: event.timestamp });
      }
    } else if (event.type === "usage_limit") {
      entries.push({ key, kind: "error", text: `Usage limit reached${event.error ? `: ${event.error}` : ""}` });
      return;
    } else if (event.content && event.content.trim() !== "") {
      entries.push({ key, kind: "other", type: event.type, content: event.content });
    }
    if (event.error) entries.push({ key: `${key}-error`, kind: "error", text: event.error });
  });
  // A queued prompt immediately followed by another prompt event is noise.
  return entries.filter(
    (entry, index) => !(entry.kind === "prompt" && entry.status === "queued" && entries[index + 1]?.kind === "prompt"),
  );
}

/** Chat workers have no boat transcript: their steps live in the bb chat. */
function ChatTranscriptNote({ task }: { task: TaskDetailDto }) {
  const navigate = useBbNavigate();
  const chatId = workerChatId(task);
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-6 text-center">
      <p className="text-sm text-pretty text-muted-foreground">
        {chatId
          ? "This task runs as a bb chat. Its steps, tool calls and messages are there."
          : task.status === "starting"
            ? "This task runs as a bb chat. You can open it once the task starts."
            : "This task never reached its chat."}
      </p>
      {chatId ? (
        <Button variant="outline" size="sm" onClick={() => navigate.toThread(chatId)}>
          <Icon name="MessageSquare" /> Open chat
        </Button>
      ) : null}
    </div>
  );
}

function TranscriptPanel({ task }: { task: TaskDetailDto }) {
  const input = useMemo(() => ({ id: task.id, limit: 200 }), [task.id]);
  const transcript = experimental_useRpcQuery({ contract: rpcContract, method: "transcript", input });
  const running = isRunning(task.status);
  const { refetch } = transcript;
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

  // The transcript is fetched live from boat and has no invalidation tags:
  // poll while the agent works, and refetch when the task itself changes.
  useInterval(() => void refetch(), running ? 5_000 : null);
  const firstUpdate = useRef(true);
  useEffect(() => {
    if (firstUpdate.current) {
      firstUpdate.current = false;
      return;
    }
    void refetchRef.current();
  }, [task.updatedAt]);

  const entries = useMemo(() => buildTranscript(transcript.data?.events ?? []), [transcript.data]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {running ? (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-success" />
            Live · refreshes every 5 s
          </span>
        ) : (
          <span>{entries.length > 0 ? `Last ${plural(transcript.data?.events.length ?? 0, "event")}` : null}</span>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 text-muted-foreground"
          disabled={transcript.isFetching}
          onClick={() => void transcript.refetch()}
        >
          <Icon
            name="ArrowReloadHorizontal"
            className={cn("size-3.5", transcript.isFetching && "animate-spin")}
            aria-hidden
          />
          Refresh
        </Button>
      </div>
      {transcript.error ? <InlineAlert>{transcript.error.message}</InlineAlert> : null}
      {transcript.data?.error ? <InlineAlert>{transcript.data.error}</InlineAlert> : null}
      {transcript.data === undefined && !transcript.error ? (
        <EmptyBox>Loading transcript from boat…</EmptyBox>
      ) : entries.length === 0 && !transcript.data?.error ? (
        <EmptyBox>
          {task.conversationId === null ? "The agent hasn't started yet." : "No messages in this conversation yet."}
        </EmptyBox>
      ) : (
        <ol className="space-y-4">
          {entries.map((entry) => (
            <li key={entry.key}>
              <TranscriptItem entry={entry} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function TranscriptItem({ entry }: { entry: TranscriptEntry }) {
  switch (entry.kind) {
    case "prompt":
      return (
        <div className="flex gap-2.5">
          <span aria-hidden className="mt-px w-4 shrink-0 text-center text-xs text-muted-foreground">
            ▶
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="text-xs text-muted-foreground">
              Prompt{entry.status ? ` · ${entry.status}` : ""}
              {entry.at ? ` · ${clockTime(entry.at)}` : ""}
            </div>
            {entry.content ? (
              <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-secondary px-3 py-2 text-sm text-secondary-foreground">
                {entry.content}
              </p>
            ) : null}
          </div>
        </div>
      );
    case "tools":
      return (
        <div className="flex gap-2.5 text-xs text-muted-foreground">
          <span aria-hidden className="w-4 shrink-0 text-center">
            ⚙
          </span>
          <span className="min-w-0 flex-1 break-words font-mono">{entry.tools.join(", ")}</span>
        </div>
      );
    case "reply":
      return (
        <div className="flex gap-2.5">
          <Icon name="Bot" className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Agent" />
          <Markdown content={entry.content} className="min-w-0 flex-1 text-sm" />
        </div>
      );
    case "error":
      return <InlineAlert>{entry.text}</InlineAlert>;
    case "other":
      return (
        <div className="flex gap-2.5 text-xs text-muted-foreground">
          <span className="w-4 shrink-0" />
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
            <span className="font-medium">{entry.type}</span> {entry.content}
          </span>
        </div>
      );
  }
}

// ----------------------------------------------------------------- reply box

/**
 * The line under the reply box's controls: the situation's hint, or where the
 * message goes. The keyboard shortcut only shows on wider screens (phones
 * have no ⌘ key).
 */
function ReplyHint({ hint, chat, room, provider }: { hint: string | null; chat: boolean; room: boolean; provider: Provider }) {
  if (hint !== null) return <p className="text-xs text-pretty text-muted-foreground">{hint}</p>;
  const other = provider === "claude" ? "codex" : "claude";
  const parts = [
    chat ? "Sent into the task chat" : null,
    room ? `${PROVIDER_LABEL[other]} takes over if ${PROVIDER_LABEL[provider]} is near its limit` : null,
  ].filter((part): part is string => part !== null);
  return (
    <p className={cn("text-xs text-pretty text-muted-foreground", parts.length === 0 && "hidden sm:block")}>
      {parts.join(" · ")}
      <span className="hidden sm:inline">
        {parts.length > 0 ? " · " : null}
        <Kbd>⌘</Kbd> <Kbd>Enter</Kbd> to send
      </span>
    </p>
  );
}

/** room: the task's agent, or the other one when it's near its limit; keep: always the task's agent. */
type AgentChoice = "room" | "keep" | Provider;

function ReplyBox({ task }: { task: TaskDetailDto }) {
  const followup = experimental_useRpcMutation({ contract: rpcContract, method: "followup" });
  const [message, setMessage] = useState("");
  const [picked, setAgent] = useState<AgentChoice>("room");
  const [steer, setSteer] = useState(false);
  const steerId = useId();
  // With one agent (Coding agents), there's no other one to hand over to.
  const defaults = useOverview().data?.defaults;
  const onlyAgent = defaults?.onlyAgent ?? null;
  const withRoom = defaults?.autoFailover === true;
  const agent: AgentChoice = picked === "room" && !withRoom ? "keep" : picked;

  const running = task.status === "running";
  const chat = task.runner === "chat";
  const switching = agent !== "keep" && agent !== "room" && agent !== task.provider;
  const steering = running && steer;
  const blocked = isClosed(task.status)
    ? `This task is ${STATUS_LABEL[task.status].toLowerCase()}. Start a new task to continue the work.`
    : task.memory?.resize?.state === "running"
      ? task.memory.resize.withMessage
        ? `The sandbox is moving to ${task.memory.resize.toSummary}. Your follow-up goes out when it's up.`
        : `The sandbox is moving to ${task.memory.resize.toSummary}. You can send a follow-up when it's up.`
      : task.status === "starting"
      ? "The agent is starting. You can follow up once its first turn is running."
      : chat && task.threadId === null
        ? "This task never reached its chat, so there's nothing to continue."
        : !chat && task.conversationId === null
          ? "This task never reached its agent, so there's no conversation to continue."
          : null;
  const canSend = blocked === null && message.trim() !== "" && (!running || steer) && !followup.isPending;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSend) return;
    try {
      const sent = await followup.mutate({
        id: task.id,
        message: message.trim(),
        steer: steering,
        provider: steering || agent === "room" ? null : agent === "keep" ? task.provider : agent,
        model: null,
      });
      const moved = !steering && !switching && sent.task.provider !== task.provider;
      toast.success(
        steering
          ? "Steering the running turn"
          : switching
            ? `Handed over to ${PROVIDER_LABEL[agent as Provider]}`
            : moved
              ? `${PROVIDER_LABEL[task.provider]} is near its usage limit, so ${PROVIDER_LABEL[sent.task.provider]} continues`
              : "Follow-up sent",
      );
      setMessage("");
      setSteer(false);
      setAgent("room");
    } catch (error) {
      showError(error);
    }
  };

  const hint = steering
    ? "Your message redirects the turn that's running now."
    : running
      ? "The agent is mid-turn. Tick Steer to redirect it now, or wait for the turn to end."
      : switching
        ? chat
          ? `Opens a ${PROVIDER_LABEL[agent as Provider]} chat in the same workspace and hands the task over.`
          : `Hands the conversation, transcript included, over to ${PROVIDER_LABEL[agent as Provider]}.`
        : null;

  return (
    <div className="sticky bottom-0 z-10 border-t border-border bg-background">
      {blocked ? (
        <p className={cn(COLUMN, "py-3 text-xs text-muted-foreground")}>{blocked}</p>
      ) : (
        <form onSubmit={submit} className={cn(COLUMN, "space-y-2 py-3")}>
          <Textarea
            aria-label="Follow-up message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={submitOnModEnter}
            rows={2}
            placeholder="Send a follow-up…"
            className="max-h-60 min-h-16 resize-y"
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Select value={agent} onValueChange={(next) => setAgent(next as AgentChoice)} disabled={steering}>
              <SelectTrigger aria-label="Agent for the follow-up" className="h-8 w-auto min-w-44 gap-2 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {withRoom ? <SelectItem value="room">Agent with room</SelectItem> : null}
                <SelectItem value="keep">Keep {PROVIDER_LABEL[task.provider]}</SelectItem>
                {(["claude", "codex"] as const)
                  .filter((provider) => provider !== task.provider && (onlyAgent === null || provider === onlyAgent))
                  .map((provider) => (
                    <SelectItem key={provider} value={provider}>
                      Hand over to {PROVIDER_LABEL[provider]}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {running ? (
              <label htmlFor={steerId} className="inline-flex items-center gap-2 text-xs text-foreground">
                <Checkbox id={steerId} checked={steer} onCheckedChange={(checked) => setSteer(checked === true)} />
                Steer this turn
              </label>
            ) : null}
            <Button type="submit" size="sm" className="ml-auto" disabled={!canSend}>
              <Icon
                name={followup.isPending ? "Loading" : "Sent"}
                className={cn(followup.isPending && "animate-spin")}
              />
              {steering ? "Steer" : "Send"}
            </Button>
          </div>
          {/* Its own line under the controls: inline, a narrow screen squeezed it to one word per line. */}
          <ReplyHint hint={hint} chat={chat} room={agent === "room"} provider={task.provider} />
        </form>
      )}
    </div>
  );
}
