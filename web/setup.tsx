// The "Set up cloud agents" checklist: one component for the Cloud agents
// page (state A, and on top of the page while a required check fails) and
// the Setup section in the plugin's settings. Every row says what's wrong
// and how to fix it: a command to copy, a boat.dev page, or a button.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { experimental_useRpcMutation, experimental_useRpcQuery, useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import { rpcContract, type SetupCheckDto, type SetupStatusDto } from "../contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { PANEL_PATH, SIGN_IN_SUBPATH } from "./format";
import { setupSummaryText, withBoatPath } from "./logic";
import { NewProjectDialog } from "./projects-settings";
import { useCopy, useHosts, useInterval, useOverview, useProjects, useSettingRows, useSetup, useTask } from "./hooks";
import { checkedAgo, setupNeedsWork, setupProgress, setupTestPassed } from "./v1-settings-logic";
import { setupEvidence, setupDuration } from "./setup-evidence";
import { EmptyBox, InlineAlert, RichText, showError } from "./ui";

/** U7: what a task costs, in one plain paragraph (rates from `boat new --help`). */
export const COSTS_TEXT =
  "Each task uses sandbox time on your boat.dev plan (Small runs at half rate, Large at double; a stopped sandbox uses none) and agent usage on your Claude or ChatGPT subscription. The plugin never turns on boat's paid extra starts.";

const STATE_ICON: Record<SetupCheckDto["state"], { icon: string; className: string; label: string }> = {
  ok: { icon: "CircleCheck", className: "text-success", label: "Done" },
  missing: { icon: "CircleX", className: "text-destructive-text", label: "To do" },
  warning: { icon: "AlertTriangle", className: "text-warning-text", label: "Check this" },
  unknown: { icon: "CircleQuestion", className: "text-muted-foreground", label: "Couldn't check" },
  optional: { icon: "Circle", className: "text-muted-foreground/60", label: "Optional" },
};

/** Rows that only matter later (the page folds them away while setup is open). */
const LATER_IDS = new Set<SetupCheckDto["id"]>(["boat-credentials", "github", "connect", "gh"]);

// ------------------------------------------------------------------ sign in

/**
 * [Sign in…] and [Run in terminal]: types a fix's command into a new shell in
 * bb's terminal panel (plugin pages have one), then checks again every few
 * seconds until that check passes. Where no terminal can open (Settings), it
 * copies the command instead.
 */
function useSignIn() {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const copy = useCopy();
  const hosts = useHosts();
  const settingRows = useSettingRows();
  const cliPath = settingRows.data?.cliPath ?? null;
  const check = experimental_useRpcMutation({ contract: rpcContract, method: "applySetupFix" });
  const [waiting, setWaiting] = useState<{ since: number; checkId: SetupCheckDto["id"] } | null>(null);
  const [opening, setOpening] = useState<SetupCheckDto["id"] | null>(null);
  const waitingSince = waiting?.since ?? null;

  useInterval(
    () => {
      if (waiting === null) return;
      if (Date.now() - waiting.since > 10 * 60_000) {
        setWaiting(null);
        return;
      }
      void check
        .mutate({ action: "check-again" })
        .then((status) => {
          const done = status.checks.find((entry) => entry.id === waiting.checkId);
          if (done?.state === "ok") {
            setWaiting(null);
            toast.success(waiting.checkId === "signed-in" ? "Signed in to boat.dev" : `${done.label}: done`);
          }
        })
        .catch(() => undefined);
    },
    waitingSince === null ? null : 5_000,
  );

  const start = useCallback(
    async (command: string, checkId: SetupCheckDto["id"] = "signed-in") => {
      const list = hosts.data?.hosts ?? [];
      const host = list.find((entry) => entry.primary) ?? list[0];
      setOpening(checkId);
      try {
        if (host === undefined) throw new Error("no machine");
        // A shell that types the command, so its output (and any error) stays on screen afterwards.
        const terminal = await sdk.terminals.create({
          cols: 100,
          rows: 30,
          scope: { kind: "host_path", hostId: host.id, cwd: null },
          start: { mode: "shell" },
          title: checkId === "signed-in" ? "Sign in to boat.dev" : "Boat Cloud Agents setup",
        });
        const shown = await navigate.experimental_openTerminal({ terminalId: terminal.id });
        if (!shown) {
          await sdk.terminals.close({ terminalId: terminal.id, mode: "force" }).catch(() => undefined);
          throw new Error("no terminal panel here");
        }
        // Where the plugin found boat, in case this shell's PATH doesn't have it.
        const typed = withBoatPath(command, cliPath);
        await sdk.terminals.input({ terminalId: terminal.id, dataBase64: btoa(unescape(encodeURIComponent(`${typed}\r`))) });
        setWaiting({ since: Date.now(), checkId });
      } catch {
        await copy(command, "Copied: run it in a terminal on this computer");
        setWaiting({ since: Date.now(), checkId });
      } finally {
        setOpening(null);
      }
    },
    [cliPath, copy, hosts.data, navigate, sdk],
  );

  // Ready once it knows this bb's machine and where boat is (an automatic start waits for both).
  const ready = (hosts.data !== undefined || hosts.error !== null) && (settingRows.data !== undefined || settingRows.error !== null);
  return { start, opening, waitingFor: waiting?.checkId ?? null, ready };
}

// ------------------------------------------------------------------ rows

/** Where a checklist is: the Cloud agents page has a terminal panel, Settings doesn't. */
type Where = "page" | "settings";

function CheckRow({
  check,
  onAction,
  pendingAction,
  signIn,
  where,
  autoSignIn,
}: {
  check: SetupCheckDto;
  onAction: (action: "check-again" | "use-detected-agents") => void;
  pendingAction: string | null;
  signIn: ReturnType<typeof useSignIn>;
  where: Where;
  /** Opened from Settings' Sign in…: start it right away (once). */
  autoSignIn: boolean;
}) {
  const navigate = useBbNavigate();
  const copy = useCopy();
  const look = STATE_ICON[check.state];
  const fix = check.state === "ok" ? undefined : check.fix;
  const started = useRef(false);
  const signInCommand = fix?.action === "sign-in" ? (fix.command ?? null) : null;
  useEffect(() => {
    if (!autoSignIn || started.current || !signIn.ready) return;
    started.current = true;
    // The page keeps its state when the sub-path goes, so the wait for sign-in carries on.
    if (signInCommand !== null) void signIn.start(signInCommand).finally(() => navigate.toPluginPanel(PANEL_PATH, { subPath: "", replace: true }));
    else navigate.toPluginPanel(PANEL_PATH, { subPath: "", replace: true });
  }, [autoSignIn, signInCommand, signIn, navigate]);
  const startSignIn = (command: string) => {
    if (where === "settings") navigate.toPluginPanel(PANEL_PATH, { subPath: SIGN_IN_SUBPATH });
    else void signIn.start(command);
  };
  const buttons: ReactNode[] = [];
  const opening = signIn.opening === check.id;
  if (fix?.action === "sign-in" && fix.command) {
    buttons.push(
      <Button key="sign-in" size="sm" className="h-7" disabled={opening} onClick={() => startSignIn(fix.command!)}>
        <Icon name={opening ? "Loading" : "Terminal"} className={cn(opening && "animate-spin")} />
        Sign in…
      </Button>,
    );
  }
  // Any other command: run it in a terminal here (the page has one), like Sign in….
  if (fix?.command && fix.action !== "sign-in" && where === "page") {
    buttons.push(
      <Button key="run" size="sm" variant="outline" className="h-7" disabled={opening} onClick={() => void signIn.start(fix.command!, check.id)}>
        <Icon name={opening ? "Loading" : "Terminal"} className={cn(opening && "animate-spin")} />
        Run in terminal
      </Button>,
    );
  }
  if (fix?.action === "use-detected-agents") {
    buttons.push(
      <Button
        key="agents"
        size="sm"
        variant="outline"
        className="h-7"
        disabled={pendingAction !== null}
        onClick={() => onAction("use-detected-agents")}
      >
        {pendingAction === "use-detected-agents" ? <Icon name="Loading" className="animate-spin" /> : null}
        {fix.text}
      </Button>,
    );
  }
  if (fix?.url) {
    buttons.push(
      <Button key="url" size="sm" variant="outline" className="h-7" onClick={() => navigate.openUrl(fix.url!)}>
        <Icon name="ExternalLink" /> {urlLabel(fix.url)}
      </Button>,
    );
  }
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <Icon name={look.icon} fallback="Circle" aria-label={look.label} className={cn("mt-0.5 size-4 shrink-0", look.className)} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-foreground">{check.label}</p>
          {check.detail ? <p className="text-xs text-pretty text-muted-foreground">{check.detail}</p> : null}
        </div>
        {fix ? (
          <>
            <p className="text-xs text-pretty text-foreground/90">
              {fix.action === "use-detected-agents" ? null : fix.action === "sign-in" ? (
                <>
                  Sign in opens {where === "settings" ? "Cloud agents with a terminal that" : "a terminal here and"} runs <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[11px]">{fix.command}</code>: it
                  signs you in and sets up only what your account still needs. Asked who the sandboxes are for? Answer just me, or agents get no
                  logins.
                </>
              ) : (
                <RichText text={fix.text} />
              )}
            </p>
            {fix.command && fix.action !== "sign-in" ? <CommandLine command={fix.command} onCopy={() => void copy(fix.command!, "Command copied")} /> : null}
            {buttons.length > 0 ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-0.5">
                {buttons}
                {signIn.waitingFor === check.id ? (
                  <span role="status" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Icon name="Loading" className="size-3.5 animate-spin" aria-hidden />
                    {fix.action === "sign-in" ? "Waiting for you to sign in…" : "Checking again until it's done…"}
                  </span>
                ) : null}
              </div>
            ) : null}
            {fix.action === "sign-in" && fix.command ? (
              <p className="text-xs text-muted-foreground">
                Or copy <CommandLine inline command={fix.command} onCopy={() => void copy(fix.command!, "Command copied")} /> and run it in a terminal on
                this computer.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </li>
  );
}

/** "boat.dev → Agents" for the dashboard's tabs, else the host. */
function urlLabel(url: string): string {
  const tab = /[?&]tab=([a-z]+)/.exec(url)?.[1];
  if (tab) return `Open boat.dev → ${tab.charAt(0).toUpperCase()}${tab.slice(1)}`;
  if (/boat\.dev/.test(url)) return "Open boat.dev";
  return "Open link";
}

function CommandLine({ command, onCopy, inline = false }: { command: string; onCopy: () => void; inline?: boolean }) {
  if (inline) {
    return (
      <button
        type="button"
        onClick={onCopy}
        title="Copy"
        className="rounded bg-secondary px-1 py-0.5 font-mono text-[11px] text-foreground hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {command}
      </button>
    );
  }
  return (
    <div className="flex max-w-full items-center gap-1 rounded-md border border-border bg-secondary/50 py-0.5 pl-2.5 pr-0.5">
      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground" title={command}>
        {command}
      </code>
      <Button type="button" variant="ghost" size="sm" className="h-6 shrink-0 px-2 text-xs" onClick={onCopy}>
        <Icon name="Copy" className="size-3.5" /> Copy
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ the checklist

/** Runs a fix's action and shows the fresh checklist. */
function useSetupActions() {
  // The server refreshes the checklist's tag, so every list shows the new reading.
  const apply = experimental_useRpcMutation({ contract: rpcContract, method: "applySetupFix" });
  const pending = apply.pendingInputs[0]?.action ?? null;
  const run = useCallback(
    async (action: "check-again" | "use-detected-agents") => {
      try {
        const status = await apply.mutate({ action });
        if (action === "use-detected-agents") toast.success("Coding agents now follow boat.dev");
        else if (status.ok && !status.checks.some((check) => check.state === "warning")) toast.success("Setup: ready");
        else toast.warning(setupSummaryText(status.summary));
      } catch (error) {
        showError(error);
      }
    },
    [apply],
  );
  return { run, pending };
}

function CheckList({
  checks,
  label,
  where = "page",
  autoSignIn = false,
}: {
  checks: readonly SetupCheckDto[];
  label: string;
  where?: Where;
  autoSignIn?: boolean;
}) {
  const { run, pending } = useSetupActions();
  const signIn = useSignIn();
  if (checks.length === 0) return null;
  return (
    <ul aria-label={label} className="divide-y divide-border">
      {checks.map((check) => (
        <CheckRow
          key={check.id}
          check={check}
          onAction={(action) => void run(action)}
          pendingAction={pending}
          signIn={signIn}
          where={where}
          autoSignIn={autoSignIn && check.id === "signed-in"}
        />
      ))}
    </ul>
  );
}

function CheckAgainButton({ variant = "outline", quiet = false }: { variant?: "outline" | "ghost"; quiet?: boolean }) {
  const { run, pending } = useSetupActions();
  if (quiet) return <button type="button" disabled={pending !== null} onClick={() => void run("check-again")} className="text-xs leading-4 text-[#7AA7FF] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">{pending === null ? "check again" : "checking…"}</button>;
  return (
    <Button variant={variant} size="sm" className="h-7 shrink-0" disabled={pending !== null} onClick={() => void run("check-again")}>
      <Icon name={pending === "check-again" ? "Loading" : "ArrowReloadHorizontal"} className={cn(pending === "check-again" && "animate-spin")} />
      Check again
    </Button>
  );
}

/** Rows to fix now: required ones first, in the server's order. */
function splitChecks(status: SetupStatusDto) {
  const now = status.checks.filter((check) => !LATER_IDS.has(check.id) || (check.required && check.state === "missing"));
  const later = status.checks.filter((check) => !now.includes(check));
  return { now, later };
}

/**
 * The page's setup card (state A, or on top of the page while a required
 * check fails): what to fix now, a fold with what can wait, and the costs.
 */
export function SetupCard({ autoSignIn = false }: { autoSignIn?: boolean }) {
  const { data, error } = useSetup();
  if (data === undefined) {
    return error ? <InlineAlert>{error.message}</InlineAlert> : <EmptyBox>Checking your boat.dev setup…</EmptyBox>;
  }
  const { now, later } = splitChecks(data);
  return (
    <section aria-labelledby="ca-setup-title" className="overflow-hidden rounded-lg border border-border bg-card">
      <header className="flex items-start gap-3 px-4 pb-3 pt-4">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background">
          <Icon name="boat-sail" fallback="ComputerCloud" className="size-4 text-muted-foreground" aria-hidden />
        </div>
        <div className="min-w-0 flex-1 space-y-0.5">
          <h2 id="ca-setup-title" className="text-sm font-medium text-foreground">
            Set up cloud agents
          </h2>
          <p className="text-xs text-pretty text-muted-foreground">
            Agents run in boat.dev sandboxes on your own boat plan and Claude or ChatGPT subscriptions.
          </p>
        </div>
        <CheckAgainButton />
      </header>
      <div className="border-t border-border">
        <CheckList checks={now} label="Setup checks" autoSignIn={autoSignIn} />
      </div>
      <LaterFold checks={later} />
      <footer className="border-t border-border bg-secondary/30 px-4 py-3">
        <p className="text-xs text-pretty text-muted-foreground">
          <span className="font-medium text-foreground">Costs.</span> {COSTS_TEXT}
        </p>
      </footer>
    </section>
  );
}

/** "Later, if you need them": bb Connect, GitHub, gh, and a first project. */
function LaterFold({ checks }: { checks: readonly SetupCheckDto[] }) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const projects = useProjects();
  const connect = useOverview().data?.connect ?? null;
  const noProjects = projects.data !== undefined && projects.data.projects.length === 0;
  return (
    <div className="border-t border-border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 px-4 py-2.5 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Icon name="ChevronRight" className={cn("size-3.5 transition-transform duration-150", open && "rotate-90")} aria-hidden />
        Later, if you need them
      </button>
      {open ? (
        <ul aria-label="Later" className="divide-y divide-border border-t border-border">
          {checks.some((check) => check.id === "connect") ? null : (
            <LaterRow
              icon="Plug02"
              title="bb Connect"
              text={
                connect?.state === "ready"
                  ? "Ready. Task chats, chats on a Boat sandbox and cloud orchestrators can reach this bb."
                  : "Only for tasks you can open as bb chats, chats on a Boat sandbox and cloud orchestrators. Set it up in Settings → Plugins → bb connect."
              }
            />
          )}
          {checks.length > 0 ? (
            <li className="py-0">
              <CheckList checks={checks} label="Later checks" />
            </li>
          ) : null}
          <LaterRow
            icon="FolderGit"
            title="Add a project"
            text="Repos you trust. Tasks on them get the project's environment and rules, can run as chats, and orchestrators work on one project each."
            action={
              <Button variant="outline" size="sm" className="h-7" onClick={() => setAdding(true)}>
                <Icon name="Plus" /> {noProjects ? "Add project" : "Add another"}
              </Button>
            }
          />
        </ul>
      ) : null}
      <NewProjectDialog open={adding} onOpenChange={setAdding} repo="" baseBranch="" />
    </div>
  );
}

function LaterRow({ icon, title, text, action }: { icon: string; title: string; text: string; action?: ReactNode }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <Icon name={icon} fallback="Circle" className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-pretty text-muted-foreground">{text}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </li>
  );
}

/** On a page that works: one line for warnings (setup still runs), nothing when all is well. */
export function SetupWarnings() {
  const { data } = useSetup();
  const [open, setOpen] = useState(false);
  const { run, pending } = useSetupActions();
  if (data === undefined || !data.ok) return null;
  const warnings = data.checks.filter((check) => check.state === "warning");
  if (warnings.length === 0) return null;
  const only = warnings.length === 1 ? warnings[0]! : null;
  // A one-click fix needs no fold: the sentence and its button on one line.
  if (only?.fix?.action === "use-detected-agents") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning-text">
        <Icon name="AlertTriangle" className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 text-pretty">{only.detail}</span>
        <Button size="sm" variant="outline" className="h-7 shrink-0" disabled={pending !== null} onClick={() => void run("use-detected-agents")}>
          {pending === "use-detected-agents" ? <Icon name="Loading" className="animate-spin" /> : null}
          {only.fix.text}
        </Button>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-warning/30 bg-warning/10">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-warning-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Icon name="AlertTriangle" className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">
          {/* The row below says what's wrong: the header only names it. */}
          {only ? `${only.label} needs a look` : `${warnings.length} setup checks need a look`}
        </span>
        <Icon name="ChevronDown" className={cn("size-3.5 shrink-0 transition-transform duration-150", open && "rotate-180")} aria-hidden />
      </button>
      {open ? (
        <div className="border-t border-warning/30 bg-card">
          <CheckList checks={warnings} label="Setup warnings" />
        </div>
      ) : null}
    </div>
  );
}

/** Settings → Setup: the same checklist, every row, plus Check again. */
export function SetupChecklist() {
  const { data, error } = useSetup();
  const savedTest = experimental_useRpcQuery({ contract: rpcContract, method: "setupTestTask", input: null }).data?.task;
  const start = experimental_useRpcMutation({ contract: rpcContract, method: "startTestTask" });
  const [startedId, setStartedId] = useState<string | null>(null);
  const [addingProject, setAddingProject] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const detailedTest = useTask(startedId ?? savedTest?.id ?? null).data?.task;
  const test = detailedTest ?? savedTest ?? undefined;
  useInterval(() => setClock(Date.now()), test?.status === "running" || test?.status === "starting" ? 1000 : 60_000);
  const navigate = useBbNavigate();
  const actions = useSetupActions();
  const refresh = experimental_useRpcMutation({contract: rpcContract,method:"applySetupFix"});
  useInterval(() => { if (data && setupNeedsWork(data) && refresh.pendingInputs.length === 0) void refresh.mutate({action:"check-again"}).catch(() => undefined); }, data && setupNeedsWork(data) ? 5_000 : null);
  const signIn = useSignIn();
  const copy = useCopy();
  const transcript = experimental_useRpcQuery({contract:rpcContract,method:"transcript",input:{id:test?.id??"",limit:80},enabled:!!test && (test.status==="running"||test.status==="starting")});
  useInterval(()=>{void transcript.refetch();},test?.status==="running"||test?.status==="starting"?5000:null);
  const evidence = setupEvidence([...(transcript.data?.events.filter(event=>event.type==="response").map(event=>event.content)??[]),detailedTest?.result]);
  const elapsed = test ? setupDuration(test.createdAt,test.finishedAt,clock) : null;
  const testUsage = experimental_useRpcQuery({contract:rpcContract,method:"fidelityUsage",input:{taskId:test?.id??"",timezoneOffsetMinutes:new Date().getTimezoneOffset()},enabled:startedId!==null&&!!test&&test.status!=="starting"&&test.status!=="running"}).data?.task;
  const receipt = [evidence.node?`Node ${evidence.node}`:null,evidence.git?`git ${evidence.git}`:null,evidence.github=== "ok"?"GitHub access ok":null,elapsed?`${elapsed} on a Small sandbox`:null,testUsage?.dollars!=null?`about ${testUsage.dollars.toLocaleString("en-US",{style:"currency",currency:"USD"})}`:null].filter(Boolean).join(" · ");
  const runTest = async () => {
    try { const result = await start.mutate({ notifyThreadId: null, provider: null }); setStartedId(result.task.id); }
    catch (error) { showError(error); }
  };
  if (data === undefined) {
    return error ? <InlineAlert>{error.message}</InlineAlert> : <EmptyBox>Checking your boat.dev setup…</EmptyBox>;
  }
  const { checks, complete, current } = setupProgress(data);
  const testPassed = setupTestPassed(test) && evidence.github !== "failed";
  const testBusy = test?.status === "starting" || test?.status === "running";
  const warning = data.checks.find((check) => check.state === "warning" && check.fix);
  if (testPassed && (!data.ok || warning)) {
    const problem = current ?? warning;
    const signInProblem = problem?.id === "signed-in";
    return <div className="space-y-[22px]">
      <div role="alert" className="flex items-start gap-2.5 rounded-[10px] border border-[#53312F] bg-[#261918] px-3.5 py-3"><Icon name="AlertTriangle" className="mt-0.5 size-4 shrink-0 text-[#E06C6C]" aria-hidden /><div className="min-w-0 flex-1"><p className="text-[13px] leading-5 text-[color:var(--boat-heading)]">{signInProblem ? "boat sign-in expired · new tasks wait" : `${problem?.label ?? "Cloud agents"} needs a fix`}</p><p className="mt-0.5 text-xs leading-[17px] text-[#A89A99]">{signInProblem ? "Running sandboxes keep going and nothing is lost. New tasks and reviews start again after you sign in." : `Your saved tasks and changes are still here. ${problem?.detail ?? "Check the setup to continue."}`}</p></div><Button size="sm" className="h-7 shrink-0 bg-primary px-2.5 text-xs text-primary-foreground" onClick={() => {const fix=problem?.fix;if(fix?.command)void signIn.start(fix.command,problem!.id);else if(fix?.url)navigate.openUrl(fix.url);else void actions.run("check-again");}}>{signInProblem ? "Sign in again" : problem?.fix?.url ? "Open boat.dev" : "Check again"}</Button></div>
      <div className="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-border bg-card px-3.5 py-2.5"><span className="size-1.5 rounded-full bg-[#E06C6C]" aria-hidden /><span className="text-[13px] font-medium leading-5 text-[color:var(--boat-heading)]">{data.checks.filter((check)=>check.required&&(check.state==="missing"||check.state==="warning")).length || 1} problem</span><span className="flex flex-1 flex-wrap gap-2 text-xs leading-4">{checks.map((check)=><span key={check.id} className={check.state==="ok"?"text-[#7CA38A]":check.state==="missing"||check.state==="warning"?"text-[#E06C6C]":"text-[var(--boat-faint)]"}>{check.state==="ok"?"✓":check.state==="missing"||check.state==="warning"?"×":"·"} {({cli:"boat CLI","signed-in":"sign-in",plan:"plan",agents:"agents",github:"GitHub"} as Record<string,string>)[check.id]??check.label}</span>)}</span><span className="text-xs leading-4 text-[var(--boat-faint)]">checked {checkedAgo(data.checkedAt,clock)}</span></div>
    </div>;
  }
  if (data.ok && testPassed && startedId !== null) return <div className="rounded-[10px] border border-success/25 bg-success/10 p-4 dark:border-[#23362A] dark:bg-[#16201A]"><div className="flex items-start gap-3"><Icon name="CircleCheck" className="mt-0.5 size-[30px] shrink-0 text-[#5BD08A]" aria-hidden /><div className="min-w-0 flex-1"><p className="text-[15px] font-semibold leading-5 text-success dark:text-[#BFEFD0]">All set. Your first cloud task passed.</p><p className="mt-0.5 text-xs leading-[17px] text-muted-foreground dark:text-[#7FA88C]">{receipt || "The sandbox and agent checks passed on a Small sandbox."}</p><div className="mt-3.5 flex flex-wrap items-center gap-2"><Button size="sm" className="h-[26px] bg-primary px-[11px] text-xs text-primary-foreground" onClick={()=>setAddingProject(true)}>Add your first project</Button><Button size="sm" variant="outline" className="h-[26px] px-[11px] text-xs" onClick={()=>{navigate.toCompose({initialPrompt:"Help me plan and coordinate work for this project.",focusPrompt:true});toast("Choose Start as orchestrator in the send menu");}}>Start an orchestrator</Button><span className="text-xs text-muted-foreground dark:text-[#7FA88C]">or ask any chat to use a cloud agent</span></div></div></div><NewProjectDialog open={addingProject} onOpenChange={setAddingProject} repo="" baseBranch="" /></div>;
  if (data.ok && testPassed) return <div className="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-border bg-card px-3.5 py-2.5">
    <span className="size-1.5 shrink-0 rounded-full bg-[#5BD08A]" aria-hidden /><span className="text-[13px] font-medium leading-5 text-[color:var(--boat-heading)]">All set</span><span className="min-w-0 flex-1 text-xs leading-4 text-muted-foreground">{[data.plan?.name ? `${data.plan.name} plan` : null, data.plan?.vmHoursRemaining !== null && data.plan?.vmHoursRemaining !== undefined ? `${data.plan.vmHoursRemaining.toLocaleString()} h left` : null, data.agents.effective === "both" ? "Claude and Codex" : data.agents.effective === "claude" ? "Claude" : "Codex", data.checks.some((check) => check.id === "github" && check.state === "ok") ? "GitHub" : null].filter(Boolean).join(" · ")}</span><span className="text-xs leading-4 text-[var(--boat-faint)]">checked {checkedAgo(data.checkedAt, clock)} · <CheckAgainButton quiet /></span>
  </div>;
  const first = complete.length === 0;
  const active = current?.id ?? "test";
  const steps = [
    { id: "cli", title: "Install the boat CLI", description: "boat runs your sandboxes. One line in a terminal; it signs you in and starts a plan.", button: "Run in terminal" },
    { id: "signed-in", title: "Sign in to boat", description: "So bb can start sandboxes as you.", button: "Sign in…" },
    { id: "plan", title: "A boat plan", description: "Sandbox hours come from it. 7-day trial, card required.", button: "Open boat.dev" },
    { id: "agents", title: "Connect an agent", description: "Claude (Pro or Max) or ChatGPT (Plus, Pro or Team), or an API key.", button: "Open Agents" },
    { id: "github", title: "Connect GitHub", description: "Tasks clone and push with it. Give boat access to your repos.", button: "Connect GitHub" },
  ];
  const passed = complete.filter((check) => check.id !== "github" || check.state === "ok");
  const fixStep = async (check: SetupCheckDto | undefined) => {
    if (!check?.fix) return;
    if (check.fix.action === "use-detected-agents") await actions.run("use-detected-agents");
    else if (check.fix.command) await signIn.start(check.fix.command, check.id);
    else if (check.fix.url) navigate.openUrl(check.fix.url);
    else await actions.run("check-again");
  };
  const completedRow = (check: SetupCheckDto) => {
    const label = check.id === "signed-in" ? "Signed in to boat" : check.id === "plan" && data.plan ? `${data.plan.name ?? "Boat"} plan${data.plan.vmHoursRemaining === null ? "" : ` · ${data.plan.vmHoursRemaining} h left`}` : check.id === "agents" ? `${data.agents.effective === "both" ? "Claude and ChatGPT" : data.agents.effective === "claude" ? "Claude" : "ChatGPT"} connected` : check.id === "github" ? (/\b\d+ repos?\b/.exec(check.detail)?.[0] ? `GitHub access to ${/\b\d+ repos?\b/.exec(check.detail)![0]}` : "GitHub access checked") : check.detail || check.label;
    return <details key={check.id} className="border-t border-[var(--boat-setting-border)]"><summary className="flex cursor-pointer list-none items-center gap-3 px-3.5 py-2.5 text-xs leading-[17px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Icon name="CircleCheck" className="size-[18px] shrink-0 text-[#5BD08A]" aria-hidden /><span>{label}</span></summary><p className="px-[44px] pb-2 text-xs leading-[17px] text-[var(--boat-faint)]">{check.detail}</p></details>;
  };
  return <div className="space-y-[22px]">
    {testPassed && !data.ok ? <div role="alert" className="flex items-start gap-2.5 rounded-[10px] border border-[#53312F] bg-[#261918] px-3.5 py-3"><Icon name="AlertTriangle" className="mt-0.5 size-4 shrink-0 text-[#E06C6C]" aria-hidden /><div className="min-w-0 flex-1"><p className="text-[13px] font-medium leading-5 text-[color:var(--boat-heading)]">Cloud agents need a fix</p><p className="mt-0.5 text-xs leading-[17px] text-[#B68C89]">Your saved tasks and changes are still here. {current?.detail}</p></div><CheckAgainButton quiet /></div> : setupNeedsWork(data) ? <div className="flex items-start gap-2.5 rounded-[10px] border border-[#3D3420] bg-[#1E1A12] px-3.5 py-3"><Icon name="AlertTriangle" className="mt-0.5 size-4 shrink-0 text-[#F0B135]" aria-hidden /><div><p className="text-[13px] font-medium leading-5 text-[color:var(--boat-heading)]">Boat Cloud Agents needs setup</p><p className="mt-0.5 text-xs leading-[17px] text-[#A8A090]">{first ? "Shown by bb until the steps below pass. Nothing runs and nothing costs until then." : "One step needs you; one is still checking."}</p></div></div> : null}
    <div className="overflow-hidden rounded-[10px] border border-border bg-card">
      <header className="space-y-2.5 px-3.5 pb-3 pt-3.5"><div className="flex items-baseline gap-2.5"><h3 className="min-w-0 flex-1 text-[15px] font-semibold leading-5 text-[color:var(--boat-heading)]">Set up cloud agents</h3><span className="text-xs leading-4 text-muted-foreground">{passed.length + (testPassed ? 1 : 0)} of 6</span></div><p className="text-[13px] leading-[19px] text-[var(--boat-secondary)]">{testBusy ? "Last step: a real sandbox, end to end." : first ? "About 5 minutes. Each step checks itself; you can leave and come back." : "Steps that pass fold to one line. Fix the red one; the rest checks itself."}</p><div className="flex gap-1" aria-hidden>{Array.from({length:6},(_,index)=><span key={index} className={cn("h-1 flex-1 rounded-sm", index < passed.length ? "bg-[#5BD08A]" : "bg-[#2E2E2E]")} />)}</div></header>
      {steps.map((step) => {
        const check = checks.find((check) => check.id === step.id);
        if (check && passed.some((done) => done.id === check.id)) return completedRow(check);
        const failed = !first && (check?.state === "missing" || check?.state === "warning");
        const isCurrent = active === step.id || failed;
        const checking = isCurrent && check?.state === "unknown" && refresh.pendingInputs.length > 0;
        const command = isCurrent ? check?.fix?.command : undefined;
        const githubRepo = step.id === "github" ? /(?:Last check on |check on )([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/.exec(check?.detail ?? "")?.[1] : null;
        const button = check?.fix?.action === "check-again" && !command && !check.fix.url ? "Check again" : failed && step.id === "github" ? "Give boat access" : step.button;
        return <div key={step.id} className={cn("flex items-start gap-3 border-t border-[var(--boat-setting-border)] px-3.5 py-[13px]", failed ? "bg-[#241817]" : isCurrent ? "bg-[var(--boat-active)]" : "opacity-35")}>
          {isCurrent ? <Icon name={failed ? "CircleX" : checking ? "Loading" : "Circle"} className={cn("mt-px size-[18px] shrink-0", checking && "animate-spin", failed ? "text-[#E06C6C]" : "text-muted-foreground")} aria-hidden /> : <svg width="18" height="18" viewBox="0 0 18 18" className="mt-px shrink-0" aria-hidden="true"><circle cx="9" cy="9" r="7.5" fill="none" stroke="#6E6E6E" strokeWidth="1.4" strokeDasharray="2 2" /></svg>}
          <div className="min-w-0 flex-1"><p className={cn("text-[13px] leading-5 text-[color:var(--boat-heading)]", isCurrent ? "font-medium" : "font-normal")}>{checking && step.id === "plan" ? "Checking your plan…" : failed && step.id === "github" ? githubRepo ? `GitHub can't see ${githubRepo}` : "GitHub access needs a fix" : step.title}</p><p className={cn("mt-0.5 text-xs leading-[17px]", failed ? "text-[#B68C89]" : "text-[var(--boat-secondary)]")}>{checking && step.id === "plan" ? "Asking boat.dev which plan and how many sandbox hours you have." : failed && step.id === "github" && githubRepo ? `${check.detail.replace(/^Last check on [^:]+:\s*/, "")} Then this checks again by itself.` : failed || (isCurrent && check?.state === "unknown" && check.fix) ? check.detail : step.description}</p>{command ? <button type="button" title="Copy command" className="mt-2 block w-full overflow-x-auto whitespace-nowrap rounded-md border border-[var(--boat-setting-border)] bg-background px-2 py-1.5 text-left font-mono text-[11.5px] leading-4 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => void copy(command,"Command copied")}>{command}</button> : null}</div>
          {!checking ? <Button size="sm" variant={(isCurrent && first) || failed ? "default" : "outline"} className={cn("h-7 shrink-0 px-2.5 text-xs", ((isCurrent && first)||failed)&&"bg-primary text-primary-foreground hover:bg-primary/90")} disabled={!isCurrent || actions.pending !== null || signIn.opening !== null} onClick={() => void fixStep(check)}>{button}</Button> : null}
        </div>;
      })}
      {current && !steps.some((step) => step.id === current.id) ? <CheckList checks={[current]} label="Current setup step" where="settings" /> : null}
      <div className={cn("flex items-start gap-3 border-t border-[var(--boat-setting-border)] px-3.5 py-[13px]", active === "test" ? "bg-[var(--boat-active)]" : "opacity-35")}><Icon name={testBusy ? "Loading" : "Circle"} className={cn("mt-px size-[18px] shrink-0 text-muted-foreground", testBusy && "animate-spin")} aria-hidden /><div className="min-w-0 flex-1"><p className="text-[13px] font-medium leading-5 text-[color:var(--boat-heading)]">{testBusy ? "Running the test task" : "Run a test task"}</p><p className="mt-0.5 text-xs leading-[17px] text-[var(--boat-secondary)]">{testBusy ? "One Small sandbox, nothing changes. About a minute." : !first && active !== "test" ? "Waits for the steps above." : "Starts one Small sandbox, changes nothing, takes about a minute."}</p>{test ? <div className="mt-2 w-full max-w-[555px] rounded-[8px] border border-[var(--boat-setting-border)] bg-background px-3 py-2.5 text-xs leading-4"><p className="flex items-center gap-2 text-[13px] font-medium leading-[18px] text-[var(--boat-heading)]">{testBusy ? <Icon name="Loading" className="size-[18px] animate-spin" aria-hidden /> : null}{test.title}<span className="text-xs font-normal leading-4 text-[var(--boat-faint)]">Small sandbox{elapsed?` · ${elapsed}`:""}</span></p><p className="mt-2 flex items-center gap-2 pl-[26px] text-muted-foreground"><Icon name={test.sandboxId?"CircleCheck":"Loading"} className={cn("size-3.5",test.sandboxId?"text-[#5BD08A]":"animate-spin")} aria-hidden/>{test.sandboxId?`Sandbox started${evidence.os?` · ${evidence.os}`:""}`:"Starting the sandbox…"}</p><p className="mt-2 flex items-center gap-2 pl-[26px] text-muted-foreground"><Icon name={evidence.node&&evidence.git?"CircleCheck":"Loading"} className={cn("size-3.5",evidence.node&&evidence.git?"text-[#5BD08A]":"animate-spin")} aria-hidden/>{evidence.node&&evidence.git?`Node ${evidence.node} · git ${evidence.git}`:"Checking sandbox tools…"}</p><p className="mt-2 flex items-center gap-2 pl-[26px] text-muted-foreground"><Icon name={evidence.github=== "ok"?"CircleCheck":evidence.github==="failed"?"CircleX":"Loading"} className={cn("size-3.5",evidence.github=== "ok"?"text-[#5BD08A]":evidence.github==="failed"?"text-[#E06C6C]":"animate-spin")} aria-hidden/>{evidence.github=== "ok"?"GitHub access ok":evidence.github==="failed"?"GitHub access needs a fix":"Checking GitHub access…"}</p>{test.error ? <p className="mt-1 text-[#E06C6C]">{test.error}</p> : null}</div> : null}</div><Button size="sm" variant="outline" className="h-7 shrink-0 px-2.5 text-xs" disabled={testBusy ? !test : !data.ok || checks.some((check)=>check.required&&check.state!=="ok"&&check.state!=="optional") || start.pendingInputs.length > 0} onClick={() => testBusy && test ? (test.threadId ? navigate.toThread(test.threadId) : navigate.toPluginPanel(PANEL_PATH, {subPath:`task/${test.id}`})) : void runTest()}>{testBusy ? (test?.threadId ? "Open its chat" : "Open task") : "Run test task"}</Button></div>
    </div>
    {setupNeedsWork(data) && !testPassed ? <p className="flex items-center gap-2 text-xs leading-[17px] text-[var(--boat-faint)]"><Icon name="Lock" className="size-3.5" aria-hidden />The settings below work once setup is done. You can already look around.</p> : null}
  </div>;
}
