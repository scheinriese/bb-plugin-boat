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
import { setupProgress, setupTestPassed } from "./v1-settings-logic";
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

function CheckAgainButton({ variant = "outline" }: { variant?: "outline" | "ghost" }) {
  const { run, pending } = useSetupActions();
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
  const test = useTask(startedId).data?.task ?? savedTest ?? undefined;
  const navigate = useBbNavigate();
  const runTest = async () => {
    try { const result = await start.mutate({ notifyThreadId: null, provider: null }); setStartedId(result.task.id); }
    catch (error) { showError(error); }
  };
  if (data === undefined) {
    return error ? <InlineAlert>{error.message}</InlineAlert> : <EmptyBox>Checking your boat.dev setup…</EmptyBox>;
  }
  const { checks, complete, current } = setupProgress(data);
  const testPassed = setupTestPassed(test);
  const testBusy = test?.status === "starting" || test?.status === "running";
  if (data.ok && testPassed) return <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-border bg-card px-3.5 py-3">
    <Icon name="CircleCheck" className="size-4 text-[#5BD08A]" aria-hidden /><div className="min-w-0 flex-1"><p className="text-[13px] text-[#5BD08A]">All set</p><p className="text-xs text-muted-foreground">{data.plan?.name ?? "Boat plan"} · {data.agents.effective === "both" ? "Claude and Codex" : data.agents.effective === "claude" ? "Claude" : "Codex"} · test task passed</p></div><CheckAgainButton variant="ghost" />
  </div>;
  return <div className="overflow-hidden rounded-[10px] border border-border bg-card">
    <header className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-3"><h3 className="flex-1 text-[13px] font-medium">Set up cloud agents</h3><span className="text-xs tabular-nums text-muted-foreground">{complete.length + (testPassed ? 1 : 0)} of 6</span><CheckAgainButton variant="ghost" /></header>
    {testPassed && !data.ok ? <p role="alert" className="border-b border-border bg-destructive/10 px-3.5 py-3 text-xs text-[#E06C6C]">Cloud agents need a fix. Your saved tasks are still available.</p> : null}
    {complete.length ? <details className="border-b border-border px-3.5 py-2.5"><summary className="cursor-pointer text-xs text-[#5BD08A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{complete.length} checks passed or not needed</summary><CheckList checks={complete} label="Completed setup checks" where="settings" /></details> : null}
    {current ? <CheckList checks={[current]} label="Current setup step" where="settings" /> : null}
    {checks.filter((check) => !complete.includes(check) && check !== current).map((check) => <div key={check.id} className="flex items-center gap-3 border-t border-border px-3.5 py-3 text-xs text-muted-foreground"><Icon name="Circle" className="size-4" aria-hidden /><span>{check.label}</span></div>)}
    <div className="space-y-2 border-t border-border px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><p className="text-[13px]">Run a test task</p><p className="text-xs text-muted-foreground">Checks the sandbox and agent login. Uses a small sandbox and agent usage.</p></div>
      <Button size="sm" variant="outline" disabled={!data.ok || testBusy || start.pendingInputs.length > 0} onClick={() => void runTest()}>{testBusy ? "Test task working…" : "Run test task"}</Button></div>
      {test ? <button type="button" className={cn("w-full rounded-md border border-border px-3 py-2 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", test.error ? "text-[#E06C6C]" : testPassed ? "text-[#5BD08A]" : "text-muted-foreground")} onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: `task/${test.id}` })}>{test.error ?? (testPassed ? "Test task passed" : testBusy ? "Test task is working" : "Test task needs a look")} · Open task →</button> : null}
    </div>
  </div>;
}
