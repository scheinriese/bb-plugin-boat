// The Cloud agents page, by state (logic.ts pageState):
// A. setup needed: only the "Set up cloud agents" checklist;
// B. ready, never used: status line, "Start your first task", step-up card;
// C. tasks, no orchestrator: status line, Ready to review, Running, Previews,
//    Sandboxes, Recently done, step-up card;
// D. an orchestrator: status line, Needs you, Orchestrators, Ready to review,
//    Running, Previews, Sandboxes, Recently done.
// Also one orchestrator's page ("orchestrator/<threadId>").
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { experimental_useRpcMutation, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { rpcContract, type SandboxDto } from "../contract";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { Board, BoardSection } from "./board";
import { PreviewsSection } from "./previews";
import { ConfirmDialog, NewOrchestratorDialog, NewTaskDialog } from "./dialogs";
import {
  PANEL_PATH,
  TONE_DOT,
  agentWords,
  canResumeSandbox,
  canStopSandbox,
  isSandboxActive,
  plural,
  sandboxTone,
  stopsIn,
  summarizeBoardCounts,
  type BoardCounts,
} from "./format";
import {
  useBoard,
  useCloudAgentsNavigation,
  useCopy,
  useNow,
  useOrchestratorCardHidden,
  useOrchestrators,
  useOverview,
  useRelay,
  useSandboxes,
  useSetup,
} from "./hooks";
import { cardHiddenToast, pageState, sandboxUseLabel, statusLine, usageSummary, type PageState } from "./logic";
import { SetupCard, SetupWarnings } from "./setup";
import { Disclosure, EmptyBox, IconButton, InlineAlert, ListPanel, RichText, Section, StatusDot, ThreadName, focusNeighbour, showError } from "./ui";

const COLUMN = "mx-auto box-border w-full max-w-4xl px-4 pb-10 pt-3 md:px-5 md:pt-4";

export function Overview({ autoSignIn = false }: { autoSignIn?: boolean }) {
  const navigate = useBbNavigate();
  const setup = useSetup();
  const board = useBoard(null);
  const orchestrators = useOrchestrators();
  // Sign in… from Settings when there's nothing to sign in to any more: back to the plain page.
  const signedIn = setup.data?.ok === true;
  useEffect(() => {
    if (autoSignIn && signedIn) navigate.toPluginPanel(PANEL_PATH, { subPath: "", replace: true });
  }, [autoSignIn, signedIn, navigate]);
  const live = (orchestrators.data?.orchestrators ?? []).filter((entry) => !entry.archived);
  const loading = (board.data === undefined && !board.error) || (orchestrators.data === undefined && !orchestrators.error);
  if (loading) {
    return (
      <div className={COLUMN}>
        <EmptyBox>Loading…</EmptyBox>
      </div>
    );
  }
  const data = board.data;
  const hasTasks = data ? data.needsYou.length + data.ready.length + data.running.length + data.done.length > 0 : false;
  // A setup check that couldn't run (setup error) never blocks the page.
  const setupOk = setup.data ? setup.data.ok : null;
  const state = pageState({ setupOk, hasTasks, orchestrators: live.length });

  if (state === "setup") {
    return (
      <div className={cn(COLUMN, "space-y-6")}>
        <SetupCard autoSignIn={autoSignIn} />
      </div>
    );
  }
  return (
    <div className={cn(COLUMN, "space-y-8")}>
      <div className="space-y-3">
        <StatusLine state={state} />
        {setupOk === false ? <SetupCard autoSignIn={autoSignIn} /> : <SetupWarnings />}
      </div>
      {state === "first" ? (
        <>
          <FirstTaskCard />
          <SandboxesSection hideWhenEmpty />
          <StepUpCard />
        </>
      ) : (
        <>
          {board.error ? <InlineAlert>{board.error.message}</InlineAlert> : null}
          {state === "orchestrators" ? (
            <>
              <BoardSection group="needsYou" />
              <OrchestratorsSection />
            </>
          ) : null}
          <BoardSection group="ready" />
          <BoardSection group="running" empty={<NothingRunning />} />
          <PreviewsSection threadId={null} liveOnly />
          <SandboxesSection />
          <BoardSection group="done" />
          {state === "regular" ? <StepUpCard /> : null}
        </>
      )}
    </div>
  );
}

function NothingRunning() {
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-dashed border-border px-4 py-3 sm:flex-row sm:items-center">
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">Nothing running. Start a task here, or ask any chat to use a cloud agent.</p>
      <Button variant="outline" size="sm" className="h-7 shrink-0 self-start sm:self-auto" onClick={() => setCreating(true)}>
        <Icon name="Plus" /> New task
      </Button>
      <NewTaskDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

// -------------------------------------------------------- orchestrator page

/** "orchestrator/<threadId>": one orchestrator's board. */
export function OrchestratorOverview({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  const { openOverview } = useCloudAgentsNavigation();
  const { data } = useOrchestrators();
  const entry = data?.orchestrators.find((orchestrator) => orchestrator.threadId === threadId);
  return (
    <div className={cn(COLUMN, "space-y-5")}>
      <button
        type="button"
        onClick={openOverview}
        className="-ml-1 inline-flex items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Icon name="ArrowLeft" className="size-3.5" aria-hidden />
        Cloud agents
      </button>
      <header className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-card">
          <Icon name="Workflow" className="size-4 text-muted-foreground" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold leading-snug text-pretty text-foreground">
            <ThreadName threadId={threadId} fallback={entry?.title ?? "Orchestrator"} />
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{entry ? "Orchestrator" : "Chat"}</span>
            {entry?.projectName ? (
              <span>
                <span className="sr-only">Project: </span>
                {entry.projectName}
              </span>
            ) : null}
          </div>
        </div>
        <Button variant="outline" size="sm" className="h-7 shrink-0" onClick={() => navigate.toThread(threadId)}>
          <Icon name="MessageSquare" /> Open chat
        </Button>
      </header>
      {/* Same order as the main page: previews, then Recently done. */}
      <Board threadId={threadId} beforeDone={<PreviewsSection threadId={threadId} />} />
    </div>
  );
}

// ------------------------------------------------------------- status line

const AGENT_LABEL = { claude: "Claude", codex: "Codex" } as const;

/**
 * "boat.dev · Standard plan · 1 of 3 sandboxes · 550 sandbox hours
 * left", a bar only near the cap, then "Claude 29% · Codex 0% of weekly
 * limits" (and the switch point, with orchestrators and switching on).
 */
function StatusLine({ state }: { state: PageState }) {
  const overview = useOverview();
  const setup = useSetup().data;
  const plan = setup?.plan ?? null;
  // The setup card below says the same thing, with the fix.
  const setupShown = setup?.ok === false;
  const { data: relay } = useRelay();
  const data = overview.data;
  if (data === undefined) {
    return overview.error ? <InlineAlert>{overview.error.message}</InlineAlert> : <Line parts={["checking boat.dev…"]} />;
  }
  const cap = data.cap ?? data.limits?.maxActiveSandboxes ?? null;
  const line = statusLine({ plan, cap, active: data.activeSandboxes });
  const usage = relay ? usageSummary(relay.agents) : null;
  const switching = state === "orchestrators" && relay?.enabled === true && relay.onlyAgent === null;
  const resets = (relay?.agents ?? [])
    .filter((agent) => agent.resetsAt)
    .map((agent) => `${AGENT_LABEL[agent.provider]} resets ${new Date(agent.resetsAt!).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`)
    .join(" · ");
  return (
    <div className="space-y-2">
      <Line
        parts={line.parts.map((part, index) =>
          index === (plan?.name ? 1 : 0) && line.full ? (
            <span key="cap" className="text-warning-text">
              {part}
            </span>
          ) : (
            part
          ),
        )}
      />
      {line.barPercent !== null && cap !== null ? (
        <div
          role="progressbar"
          aria-label="Sandboxes in use"
          aria-valuemin={0}
          aria-valuemax={cap}
          aria-valuenow={data.activeSandboxes}
          className="h-1 overflow-hidden rounded-full bg-secondary"
        >
          <div
            className={cn("h-full rounded-full transition-[width] duration-300", line.full ? "bg-warning" : "bg-foreground/50")}
            style={{ width: `${line.barPercent}%` }}
          />
        </div>
      ) : null}
      {data.boatError && !setupShown ? (
        <InlineAlert>
          <RichText text={data.boatError} />
        </InlineAlert>
      ) : null}
      {usage ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-muted-foreground">
          <Icon name="Gauge" fallback="Activity" className="size-3.5" aria-hidden />
          <span title={resets || undefined}>{usage}</span>
          {switching && relay ? (
            <>
              <span aria-hidden>·</span>
              <span title={`They move back to ${AGENT_LABEL[relay.preferred]} once it has room`}>Orchestrators switch agents at {relay.switchAtPercent}%</span>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Line({ parts }: { parts: readonly ReactNode[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <Icon name="boat-sail" fallback="ComputerCloud" className="size-3.5" aria-hidden />
        boat.dev
      </span>
      {parts.map((part, index) => (
        <Fragment key={index}>
          <span aria-hidden>·</span>
          <span>{part}</span>
        </Fragment>
      ))}
    </div>
  );
}

// ------------------------------------------------------- start your first task

function FirstTaskCard() {
  const navigate = useBbNavigate();
  const only = useOverview().data?.defaults.onlyAgent ?? null;
  const { openTask } = useCloudAgentsNavigation();
  const [creating, setCreating] = useState(false);
  const testTask = experimental_useRpcMutation({ contract: rpcContract, method: "startTestTask" });
  const runTest = async () => {
    try {
      const { task } = await testTask.mutate({ notifyThreadId: null, provider: null });
      toast.success("Test task starting");
      openTask(task.id);
    } catch (error) {
      showError(error);
    }
  };
  return (
    <section aria-labelledby="ca-first-task" className="overflow-hidden rounded-lg border border-border bg-card">
      <header className="space-y-0.5 px-4 pb-3 pt-4">
        <h2 id="ca-first-task" className="text-sm font-medium text-foreground">
          Start your first task
        </h2>
        <p className="text-xs text-pretty text-muted-foreground">
          {only === null ? "A Claude Code or Codex agent" : `A ${agentWords(only)} agent`} works in its own sandbox, pushes a branch and opens a draft PR. You
          review it here.
        </p>
      </header>
      <ul aria-label="Ways to start" className="divide-y divide-border border-t border-border">
        <WayRow
          icon="MessageSquare"
          title="From any chat"
          text={<>Ask, for example, “Use a cloud agent to fix the flaky login test in acme/web.” The chat hears back when it's done.</>}
          actions={
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => navigate.toCompose({ initialPrompt: "Use a cloud agent to ", focusPrompt: true })}
            >
              Try in a new chat
            </Button>
          }
        />
        <WayRow
          icon="ComputerCloud"
          title="From here"
          text="Pick a repo and say what to do. Not sure everything works yet? A test task checks your setup without a repo."
          actions={
            <>
              <Button size="sm" className="h-7" onClick={() => setCreating(true)}>
                <Icon name="Plus" /> New task
              </Button>
              <Button variant="outline" size="sm" className="h-7" disabled={testTask.isPending} onClick={() => void runTest()}>
                {testTask.isPending ? <Icon name="Loading" className="animate-spin" /> : null}
                Run a test task
              </Button>
            </>
          }
        />
        <WayRow
          icon="Cloud"
          title="A whole chat in the cloud"
          text={
            <>
              In a new chat, pick <span className="font-medium text-foreground">Boat sandbox</span> in the environment menu. The chat runs there
              and keeps going while this computer sleeps. Needs bb Connect.
            </>
          }
          actions={
            <Button variant="outline" size="sm" className="h-7" onClick={() => openBoatChat(navigate)}>
              New chat
            </Button>
          }
        />
      </ul>
      <NewTaskDialog open={creating} onOpenChange={setCreating} />
    </section>
  );
}

/** bb's new chat screen; the environment menu there has Boat sandbox. */
export function openBoatChat(navigate: ReturnType<typeof useBbNavigate>) {
  navigate.toCompose({ focusPrompt: true });
  toast("Pick Boat sandbox in the environment menu", { description: "Under the message box, next to the project." });
}

function WayRow({ icon, title, text, actions }: { icon: string; title: string; text: ReactNode; actions: ReactNode }) {
  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Icon name={icon} fallback="Circle" className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="text-xs text-pretty text-muted-foreground">{text}</p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 pl-7 sm:pl-0">{actions}</div>
    </li>
  );
}

// ------------------------------------------------------------- step-up card

/**
 * Until someone has an orchestrator: what one is, How it works (a
 * disclosure), Set up an orchestrator, and × to hide it (for the account;
 * Settings → Orchestrators brings it back).
 */
function StepUpCard() {
  const [hidden, setHidden] = useOrchestratorCardHidden();
  const only = useOverview().data?.defaults.onlyAgent ?? null;
  const [creating, setCreating] = useState(false);
  // Not while the flag loads: a hidden card mustn't flash.
  if (hidden !== false) return null;
  return (
    <section aria-labelledby="ca-step-up" className="flex flex-col gap-3 rounded-lg border border-dashed border-border px-4 py-4 sm:flex-row sm:items-start">
      <Icon name="Workflow" className="mt-0.5 hidden size-4 shrink-0 text-muted-foreground sm:block" aria-hidden />
      <div className="min-w-0 flex-1 space-y-3">
        <div className="space-y-1">
          <div className="flex items-start justify-between gap-2">
            <h2 id="ca-step-up" className="text-sm font-medium text-pretty text-foreground">
              Coordinate a project with an orchestrator
            </h2>
            <IconButton
              label="Hide this card"
              icon="X"
              className="-mr-2 -mt-1.5"
              onClick={(event) => {
                // The card goes at once: keep keyboard focus nearby.
                focusNeighbour(event.currentTarget.closest("section"));
                setHidden(true).then(() => {
                  const { title, description } = cardHiddenToast();
                  toast(title, { description });
                }, showError);
              }}
            />
          </div>
          <p className="text-xs text-pretty text-muted-foreground">
            An orchestrator is a chat that plans the work, starts tasks in their own sandboxes, has every change reviewed, and brings you only
            decisions and finished results.
          </p>
        </div>
        <Disclosure label="How it works" className="space-y-2">
          <ol className="list-decimal space-y-1 pl-4 text-xs text-pretty text-muted-foreground">
            <li>Pick a project and say what to get done, like “fix the three open checkout bugs”.</li>
            <li>It splits the work into tasks and starts them (it asks before running more at once than Tasks at once before asking allows).</li>
            <li>{only === null ? "The other agent" : "A second session"} reviews each change before it reaches you.</li>
            <li>Questions show up here under Needs you; finished work under Ready to review.</li>
          </ol>
        </Disclosure>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" className="h-7" onClick={() => setCreating(true)}>
            <Icon name="Workflow" /> Set up an orchestrator
          </Button>
        </div>
      </div>
      <NewOrchestratorDialog open={creating} onOpenChange={setCreating} />
    </section>
  );
}

// ----------------------------------------------------------------- sandboxes

export function SandboxesSection({ hideWhenEmpty = false }: { hideWhenEmpty?: boolean }) {
  const { data, error } = useSandboxes();
  const now = useNow();
  const sandboxes = useMemo(
    () =>
      [...(data?.sandboxes ?? [])].sort((a, b) => {
        const active = Number(isSandboxActive(b.state)) - Number(isSandboxActive(a.state));
        if (active !== 0) return active;
        return Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? "") || 0;
      }),
    [data],
  );
  const failure = error?.message ?? data?.error ?? null;
  if (hideWhenEmpty && sandboxes.length === 0) return null;

  return (
    <Section title="Sandboxes" count={data ? sandboxes.length : undefined}>
      {failure ? (
        <InlineAlert>
          <RichText text={failure} />
        </InlineAlert>
      ) : null}
      {data === undefined && !failure ? (
        <EmptyBox>Loading sandboxes…</EmptyBox>
      ) : sandboxes.length === 0 && !failure ? (
        <EmptyBox>No sandboxes running. Each task starts its own and stops it when it goes idle.</EmptyBox>
      ) : sandboxes.length > 0 ? (
        <ListPanel label="Sandboxes">
          {sandboxes.map((sandbox) => (
            <SandboxRow key={sandbox.id} sandbox={sandbox} now={now} />
          ))}
        </ListPanel>
      ) : null}
    </Section>
  );
}

const USE_ICON = { task: "ComputerCloud", chat: "MessageSquare", orchestrator: "Workflow" } as const;

/** What a sandbox is for: its open tasks and the chats on it; "Not in use" when nothing is. */
function SandboxUses({ sandbox }: { sandbox: SandboxDto }) {
  const navigate = useBbNavigate();
  const { openTask, openOrchestrator } = useCloudAgentsNavigation();
  const open = sandbox.uses.filter((use) => use.open);
  if (open.length === 0) {
    const kept = sandbox.uses.find((use) => use.kind === "task");
    return (
      <span>
        Not in use
        {kept ? (
          <>
            {" · kept from "}
            <button
              type="button"
              onClick={() => openTask(kept.id)}
              className="rounded-sm hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {kept.title ?? kept.id}
            </button>
          </>
        ) : null}
      </span>
    );
  }
  const shown = open.slice(0, 2);
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-1">
      {shown.map((use) => (
        <button
          key={`${use.kind}:${use.id}`}
          type="button"
          onClick={() => (use.kind === "task" ? openTask(use.id) : use.kind === "orchestrator" ? openOrchestrator(use.id) : navigate.toThread(use.id))}
          className="inline-flex min-w-0 max-w-72 items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon name={USE_ICON[use.kind]} className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{sandboxUseLabel(use)}</span>
        </button>
      ))}
      {open.length > shown.length ? <span>+{open.length - shown.length} more</span> : null}
    </span>
  );
}

function SandboxRow({ sandbox, now }: { sandbox: SandboxDto; now: number }) {
  const navigate = useBbNavigate();
  const copy = useCopy();
  const action = experimental_useRpcMutation({ contract: rpcContract, method: "sandboxAction" });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pendingAction = action.pendingInputs[0]?.action ?? null;
  const label = sandbox.name ?? sandbox.id;
  const countdown = sandbox.state === "stopped" ? null : stopsIn(sandbox.archiveAfter, now);
  const openTasks = sandbox.uses.filter((use) => use.open && use.kind === "task").length;
  const chats = sandbox.uses.filter((use) => use.open && use.kind !== "task");

  const run = async (kind: "stop" | "resume" | "delete") => {
    try {
      await action.mutate({ id: sandbox.id, action: kind });
      toast.success(kind === "stop" ? `Stopping ${label}` : kind === "resume" ? `Resuming ${label}` : `Deleted ${label}`);
      if (kind === "delete") setConfirmDelete(false);
    } catch (error) {
      showError(error);
    }
  };

  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <StatusDot className={TONE_DOT[sandboxTone(sandbox.state)]} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium text-foreground">{label}</span>
          {sandbox.name ? <span className="shrink-0 font-mono text-xs text-muted-foreground">{sandbox.id}</span> : null}
          <span className="shrink-0 text-xs text-muted-foreground">{sandbox.state}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <SandboxUses sandbox={sandbox} />
          {countdown ? (
            <span className="inline-flex items-center gap-1 tabular-nums">
              <Icon name="Clock" className="size-3.5" aria-hidden />
              {countdown}
            </span>
          ) : null}
          {sandbox.health && sandbox.health !== "ok" ? <span className="text-warning-text">health: {sandbox.health}</span> : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton label="Open in boat" icon="ExternalLink" onClick={() => navigate.openUrl(sandbox.dashboardUrl)} />
        {canStopSandbox(sandbox.state) ? (
          <IconButton label="Stop" icon="Square" busy={pendingAction === "stop"} onClick={() => void run("stop")} />
        ) : canResumeSandbox(sandbox.state) ? (
          <IconButton label="Resume" icon="Play" busy={pendingAction === "resume"} onClick={() => void run("resume")} />
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-foreground" aria-label={`More actions for ${label}`}>
              <Icon name="MoreHorizontal" className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" mobileTitle={label}>
            <DropdownMenuItem onSelect={() => void copy(sandbox.sshCommand, "SSH command copied")}>
              <Icon name="Terminal" /> Copy SSH command
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void copy(sandbox.id, "Sandbox id copied")}>
              <Icon name="Copy" /> Copy id
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
              <Icon name="Trash2" /> Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${label}?`}
        description={
          chats.length > 0
            ? `The sandbox and its disk are removed from boat.dev. ${chats.length === 1 ? "A chat runs" : `${chats.length} chats run`} on it (${chats.map((use) => use.title ?? "untitled").join(", ")}) and ${chats.length === 1 ? "loses its machine" : "lose their machine"}. Unpushed work is lost.`
            : openTasks > 0
              ? `The sandbox and its disk are removed from boat.dev, and ${plural(openTasks, "open task")} lose their workspace. Unpushed work is lost.`
              : "The sandbox and its disk are removed from boat.dev. Unpushed work is lost."
        }
        confirmLabel="Delete sandbox"
        destructive
        pending={pendingAction === "delete"}
        onConfirm={() => void run("delete")}
      />
    </li>
  );
}

// ------------------------------------------------------------- orchestrators

/** Each orchestrator's open work, counted from the shared board (done isn't counted). */
function useOrchestratorCounts(): ReadonlyMap<string, BoardCounts> | null {
  const { data } = useBoard(null);
  return useMemo(() => {
    if (data === undefined) return null;
    const counts = new Map<string, BoardCounts>();
    const bump = (threadId: string | null, key: "needsYou" | "ready" | "running") => {
      if (threadId === null) return;
      const entry = counts.get(threadId) ?? { needsYou: 0, ready: 0, running: 0, done: 0 };
      entry[key] += 1;
      counts.set(threadId, entry);
    };
    for (const decision of data.needsYou) bump(decision.orchestratorThreadId, "needsYou");
    for (const task of data.ready) bump(task.orchestratorThreadId, "ready");
    for (const task of data.running) bump(task.orchestratorThreadId, "running");
    return counts;
  }, [data]);
}

function OrchestratorsSection() {
  const { data, error } = useOrchestrators();
  const counts = useOrchestratorCounts();
  const { data: relay } = useRelay();
  const agents = useMemo(() => new Map((relay?.orchestrators ?? []).map((row) => [row.threadId, row])), [relay]);
  const { navigate, openOrchestrator } = useCloudAgentsNavigation();
  const [creating, setCreating] = useState(false);
  // Archived ones (replaced by the relay, closed by hand) stay out of the list.
  const orchestrators = (data?.orchestrators ?? []).filter((entry) => !entry.archived);

  return (
    <Section
      title="Orchestrators"
      count={data ? orchestrators.length : undefined}
      action={
        <Button variant="outline" size="sm" className="h-7" onClick={() => setCreating(true)}>
          <Icon name="Workflow" /> New orchestrator
        </Button>
      }
    >
      <p className="-mt-1 text-xs text-muted-foreground">Chats that plan and coordinate tasks, one project each.</p>
      {error ? <InlineAlert>{error.message}</InlineAlert> : null}
      {orchestrators.length > 0 ? (
        <ListPanel label="Orchestrators">
          {orchestrators.map((entry) => {
            const open = counts?.get(entry.threadId);
            const summary = open ? summarizeBoardCounts(open) : counts === null && entry.openTasks > 0 ? `${entry.openTasks} open` : "idle";
            const agent = agents.get(entry.threadId);
            return (
              <li key={entry.threadId} className="relative flex items-center gap-3 px-4 py-2.5 transition-none hover:bg-state-hover">
                <Icon name="Workflow" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="flex min-w-0 flex-1 items-baseline gap-2">
                  <button
                    type="button"
                    onClick={() => openOrchestrator(entry.threadId)}
                    className="min-w-0 truncate text-left text-sm text-foreground after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-1 focus-visible:after:ring-inset focus-visible:after:ring-ring"
                  >
                    <ThreadName threadId={entry.threadId} fallback={entry.title} />
                  </button>
                  {entry.projectName ? (
                    <span className="min-w-0 max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">
                      <span className="sr-only">Project: </span>
                      {entry.projectName}
                    </span>
                  ) : null}
                </span>
                {agent?.provider ? (
                  <span className="shrink-0 text-xs text-muted-foreground" title={agent.note ?? undefined}>
                    <span className="sr-only">Agent: </span>
                    {AGENT_LABEL[agent.provider]}
                    {agent.note ? <span className={cn(agent.waiting && "text-warning-text")}> · {agent.note}</span> : null}
                  </span>
                ) : null}
                <span className={cn("shrink-0 text-xs tabular-nums", (open?.needsYou ?? 0) > 0 ? "text-warning-text" : "text-muted-foreground")}>{summary}</span>
                <IconButton label="Open chat" icon="MessageSquare" className="relative z-10 -my-1 shrink-0" onClick={() => navigate.toThread(entry.threadId)} />
                <Icon name="ChevronRight" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </li>
            );
          })}
        </ListPanel>
      ) : null}
      <NewOrchestratorDialog open={creating} onOpenChange={setCreating} />
    </Section>
  );
}
