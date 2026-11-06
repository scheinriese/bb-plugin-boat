// Ways into cloud agents from bb itself, outside the Cloud agents page:
// - the composer's send menu: "Send to a cloud agent" (a chat) and "Start as a
//   cloud task" (the New thread screen, with a small form),
// - "Start a cloud task" in the New thread screen's side panel,
// - the size chip next to "Boat sandbox" when a chat starts on one,
// - header buttons: Ship and Request review on task chats, Open board on
//   orchestrators,
// - "Coordinate from this chat" (and "Stop coordinating") in the thread menu.
// Every slot here is experimental in SDK 0.6.104, so each one registers on its
// own: a slot the host doesn't have skips that entry point, nothing else.
// Thread actions can't render, so their dialogs live in one app overlay.
import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import { toast } from "sonner";
import {
  experimental_useRpcKeyedQuery,
  experimental_useRpcMutation,
  useComposer,
  type PluginAppBuilder,
  type PluginComposerApi,
  type PluginMachineProviderInputsProps,
  type PluginNewThreadPanelProps,
  type PluginThreadActionDataInput,
} from "@get-bb/plugin-sdk/app";
import { rpcContract, type TaskDto, type ThreadRoleDto } from "../contract";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ShipDialog } from "./board";
import { ConfirmDialog, NewTaskDialog, NewTaskForm, ReviewDialog, SubmitButton } from "./dialogs";
import {
  CLOUD_AGENT_PREFIX,
  coordinateAction,
  coordinateProject,
  prefixDraft,
  reviewFromChat,
  shipFromChat,
  sizeChipState,
  unprefixDraft,
} from "./entry-logic";
import { MACHINE_TYPE_VALUES as MACHINE_TYPES } from "../contract";
import { MACHINE_LABEL, PANEL_PATH, PROVIDER_LABEL, agentWords, isClosed, orchestratorSubPath, plural, reposLabel, shortRepo, type Provider } from "./format";
import {
  useBbProjectRepo,
  useCloudAgentsNavigation,
  useOrchestrators,
  useOverview,
  useProjects,
  useRelay,
  useSandboxSizes,
  useThreadTasks,
} from "./hooks";
import { repoFromText, titleFromBrief } from "./logic";
import { NewProjectDialog } from "./projects-settings";
import { Field, InlineAlert, Kbd, RichText, showError } from "./ui";

const CLOUD_TASK_POPUP = "cloud-task";
/** Header and menu entries sort in their own group. */
const ACTION_GROUP = "3_cloud-agents";

export function registerEntryPoints(app: PluginAppBuilder): void {
  // Dialogs that thread actions open (Ship, Request review, Coordinate).
  const overlay = attempt("dialogs overlay", () => app.slots.experimental_appOverlay({ id: "entry-dialogs", component: EntryDialogs }));

  // ---------------------------------------------------------------- composer
  attempt("composer: Send to a cloud agent", () =>
    app.composer.customize({
      id: "send-to-cloud-agent",
      scopes: ["thread"],
      sendMenu: [
        {
          id: "send-to-cloud-agent",
          label: "Send to a cloud agent",
          icon: "ComputerCloud",
          description: "This chat hands the message to a cloud agent in a boat.dev sandbox.",
          run: ({ composer }) => sendToCloudAgent(composer),
        },
      ],
    }),
  );
  // The popup on its own, so a host without composer popups keeps the menu row (it then opens the New task dialog).
  attempt("composer: cloud task form", () =>
    app.composer.customize({
      id: "cloud-task-form",
      scopes: ["new-thread"],
      experimental_popups: [{ id: CLOUD_TASK_POPUP, label: "Start as a cloud task", component: CloudTaskPopup }],
    }),
  );
  attempt("composer: Start as a cloud task", () =>
    app.composer.customize({
      id: "start-cloud-task",
      scopes: ["new-thread"],
      sendMenu: [
        {
          id: "start-cloud-task",
          label: "Start as a cloud task",
          icon: "ComputerCloud",
          description: "A cloud agent works on this in a boat.dev sandbox instead of a chat here.",
          run: ({ composer }) => startCloudTask(composer, overlay),
        },
      ],
    }),
  );

  // ------------------------------------------------------- New thread screen
  attempt("new thread panel: Start a cloud task", () =>
    app.slots.experimental_newThreadPanelAction({
      id: "cloud-task",
      title: "Start a cloud task",
      icon: "ComputerCloud",
      layout: "padded",
      component: NewTaskPanel,
    }),
  );
  attempt("Boat sandbox size chip", () =>
    app.slots.experimental_machineProviderInputs({ machineProviderId: "boat-sandbox", component: BoatSizeChip }),
  );

  // ---------------------------------------------------------- thread header
  attempt("header: Open board", () =>
    app.slots.experimental_threadAction<Roles>({
      id: "open-board",
      title: "Open board",
      icon: "Workflow",
      group: ACTION_GROUP,
      order: 10,
      placement: "header",
      useData: useThreadRoles,
      item: ({ thread, data, navigate }) =>
        data?.[thread.id]?.kind === "orchestrator"
          ? {
              label: "Open board",
              icon: "Workflow",
              run: () => navigate.toPluginPanel(PANEL_PATH, { subPath: orchestratorSubPath(thread.id) }),
            }
          : null,
    }),
  );
  if (!overlay) return;
  attempt("header: Ship", () =>
    app.slots.experimental_threadAction<Roles>({
      id: "ship",
      title: "Ship",
      icon: "ArrowUpRight",
      group: ACTION_GROUP,
      order: 10,
      placement: "header",
      useData: useThreadRoles,
      item: ({ thread, data }) => {
        const task = shipFromChat(data?.[thread.id]);
        return task === null ? null : { label: "Ship", icon: "ArrowUpRight", run: () => openDialog({ kind: "ship", task }) };
      },
    }),
  );
  attempt("header: Request review", () =>
    app.slots.experimental_threadAction<Roles>({
      id: "request-review",
      title: "Request review",
      icon: "Eye",
      group: ACTION_GROUP,
      order: 20,
      placement: "header",
      useData: useThreadRoles,
      item: ({ thread, data }) => {
        const review = reviewFromChat(data?.[thread.id]);
        if (review === null) return null;
        return { label: "Request review", icon: "Eye", disabled: review.disabled, run: () => openDialog({ kind: "review", task: review.task }) };
      },
    }),
  );

  // ------------------------------------------------------------ thread menu
  attempt("menu: Coordinate from this chat", () =>
    app.slots.experimental_threadAction<Roles>({
      id: "coordinate",
      title: "Coordinate from this chat",
      icon: "Workflow",
      group: ACTION_GROUP,
      useData: useThreadRoles,
      item: ({ thread, data }) => {
        const action = coordinateAction(data?.[thread.id], thread.archivedAt !== null);
        if (action === "coordinate") {
          return {
            label: "Coordinate from this chat…",
            icon: "Workflow",
            run: () => openDialog({ kind: "coordinate", threadId: thread.id, bbProjectId: thread.projectId }),
          };
        }
        if (action === "stop") {
          return { label: "Stop coordinating…", icon: "Workflow", run: () => openDialog({ kind: "stop-coordinating", threadId: thread.id }) };
        }
        return null;
      },
    }),
  );
}

/** Register one entry point; a slot this bb doesn't have (or rejects) skips only that one. */
function attempt(what: string, register: () => void): boolean {
  try {
    register();
    return true;
  } catch (error) {
    console.warn(`[boat] ${what}: not available in this bb (${error instanceof Error ? error.message : String(error)})`);
    return false;
  }
}

// ------------------------------------------------------------------ roles

type Roles = Readonly<Record<string, ThreadRoleDto>> | undefined;

/** What each chat on screen is (task chat, orchestrator, plain chat): one keyed batch for every thread action. */
function useThreadRoles({ threadIds }: PluginThreadActionDataInput): Roles {
  const { data } = experimental_useRpcKeyedQuery({ contract: rpcContract, method: "threadRoles", keys: threadIds, enabled: threadIds.length > 0 });
  return data;
}

// --------------------------------------------------------------- dialogs

type EntryDialog =
  | { kind: "ship"; task: TaskDto }
  | { kind: "review"; task: TaskDto }
  | { kind: "coordinate"; threadId: string; bbProjectId: string }
  | { kind: "stop-coordinating"; threadId: string }
  | { kind: "new-task"; brief: string; bbProjectId: string | null; composer: PluginComposerApi | null };

/** The open dialog; kept (closed) after closing so it can animate out. */
let dialogState: { dialog: EntryDialog | null; open: boolean } = { dialog: null, open: false };
const dialogListeners = new Set<() => void>();
function setDialogState(next: typeof dialogState) {
  dialogState = next;
  for (const listener of dialogListeners) listener();
}
function openDialog(dialog: EntryDialog) {
  setDialogState({ dialog, open: true });
}
function subscribeDialogs(listener: () => void) {
  dialogListeners.add(listener);
  return () => dialogListeners.delete(listener);
}

/** The app overlay: renders whichever dialog a thread action or the composer opened. */
function EntryDialogs() {
  const { dialog, open } = useSyncExternalStore(subscribeDialogs, () => dialogState);
  if (dialog === null) return null;
  const onOpenChange = (next: boolean) => setDialogState({ dialog, open: next });
  switch (dialog.kind) {
    case "ship":
      return <ShipDialog task={dialog.task} open={open} onOpenChange={onOpenChange} from="chat" />;
    case "review":
      return <ReviewDialog task={dialog.task} open={open} onOpenChange={onOpenChange} />;
    case "coordinate":
      return <CoordinateDialog threadId={dialog.threadId} bbProjectId={dialog.bbProjectId} open={open} onOpenChange={onOpenChange} />;
    case "stop-coordinating":
      return <StopCoordinatingDialog threadId={dialog.threadId} open={open} onOpenChange={onOpenChange} />;
    case "new-task": {
      const composer = dialog.composer;
      return (
        <NewTaskDialog
          open={open}
          onOpenChange={onOpenChange}
          initialBrief={dialog.brief}
          bbProjectId={dialog.bbProjectId}
          onStarted={composer ? () => clearDraft(composer) : undefined}
        />
      );
    }
  }
}

// ---------------------------------------------------------------- composer

/** Prefix the draft with "Use a cloud agent for this …" and send it: the chat's agent starts the task (boat skill). */
async function sendToCloudAgent(composer: PluginComposerApi) {
  if (composer.isSubmittingBlocked) {
    toast.error(composer.submittingBlockedReason ?? "This message can't be sent right now.");
    return;
  }
  composer.replace((current) => prefixDraft(current, CLOUD_AGENT_PREFIX));
  try {
    await composer.submit();
  } catch {
    // bb already said why (its toast); take the prefix off again.
    composer.replace((current) => unprefixDraft(current, CLOUD_AGENT_PREFIX) ?? current);
  }
}

function newThreadProject(composer: PluginComposerApi): string | null {
  return composer.scope.kind === "new-thread" ? composer.scope.projectId : null;
}

/** The small form; without composer popups (or the overlay), the New task dialog or the page. */
function startCloudTask(composer: PluginComposerApi, overlay: boolean) {
  const opened = typeof composer.experimental_openPopup === "function" && composer.experimental_openPopup(CLOUD_TASK_POPUP);
  if (opened) return;
  if (overlay) openDialog({ kind: "new-task", brief: composer.text, bbProjectId: newThreadProject(composer), composer });
  else toast.error("Start it from the Cloud agents page: New task.");
}

/** The task has the text now; attachments stay in the draft (a task gets only text). */
function clearDraft(composer: PluginComposerApi) {
  try {
    composer.replace({ text: "", mentions: [] });
  } catch {
    // The composer is gone (the screen changed): nothing to clear.
  }
}

/**
 * "Start as a cloud task" from the New thread screen: the draft becomes the
 * task's brief, the repo comes from the composer's project. More options opens
 * the full New task form.
 */
function CloudTaskPopup() {
  const composer = useComposer();
  const bbProjectId = newThreadProject(composer);
  const opener = useBbProjectRepo(bbProjectId);
  const overview = useOverview();
  const projects = useProjects();
  const start = experimental_useRpcMutation({ contract: rpcContract, method: "startTask" });
  const { openTask } = useCloudAgentsNavigation();
  const [typedRepo, setTypedRepo] = useState<string | null>(null);
  const [provider, setProvider] = useState<Provider | null>(null);

  const brief = composer.text.trim();
  const title = titleFromBrief(brief);
  // The composer's project, else a repo the draft names (a GitHub link or one of your projects').
  const named = useMemo(
    () => repoFromText(brief, (projects.data?.projects ?? []).flatMap((entry) => entry.repos.map((each) => shortRepo(each.repo)))),
    [brief, projects.data],
  );
  const repo = (typedRepo ?? opener.data?.repo ?? named ?? "").trim();
  const wanted = shortRepo(repo).toLowerCase();
  const project =
    wanted === "" ? null : ((projects.data?.projects ?? []).find((entry) => entry.repos.some((each) => shortRepo(each.repo).toLowerCase() === wanted)) ?? null);
  const defaults = overview.data?.defaults;
  const onlyAgent = defaults?.onlyAgent ?? null;
  const agent: Provider = onlyAgent ?? provider ?? defaults?.implementProvider ?? "claude";
  const canSubmit = brief !== "" && !start.isPending;

  const close = () => composer.experimental_closePopup();
  const moreOptions = () => {
    close();
    openDialog({ kind: "new-task", brief: composer.text, bbProjectId, composer });
  };
  const submit = async () => {
    if (!canSubmit) return;
    try {
      const { task, pending } = await start.mutate({
        title,
        brief,
        role: "implement",
        repo: repo || null,
        branch: null,
        baseBranch: null,
        provider: onlyAgent === null ? provider : null,
        model: null,
        sandbox: null,
        machineType: null,
        notifyThreadId: null,
        projectId: project?.id ?? null,
      });
      toast.success(pending ? `${task.title}: starting` : `${task.title}: started`);
      clearDraft(composer);
      close();
      openTask(task.id);
    } catch (error) {
      showError(error);
    }
  };

  // Not a <form>: the popup renders inside the composer's own form, so a submit would be the composer's.
  return (
    <div role="group" aria-label="Start as a cloud task" className="grid w-full gap-3 p-3 text-sm">
      <div className="space-y-0.5">
        <p className="font-medium text-foreground">Start as a cloud task</p>
        <p className="text-xs text-pretty text-muted-foreground">
          {agentWords(onlyAgent)} works on this message in its own boat.dev sandbox and opens a draft PR. Follow it on the Cloud agents page.
        </p>
      </div>
      {overview.data?.boatError ? (
        <InlineAlert>
          <RichText text={overview.data.boatError} />
        </InlineAlert>
      ) : null}
      <p className="truncate text-xs text-muted-foreground">
        Task: <span className="text-foreground">{title || "Write what to do first"}</span>
      </p>
      <Field
        label="Repository"
        htmlFor="ca-popup-repo"
        hint={project !== null ? `${project.name} project` : repo === "" ? "No repo: the agent starts in an empty sandbox." : undefined}
      >
        <Input
          id="ca-popup-repo"
          value={typedRepo ?? opener.data?.repo ?? named ?? ""}
          onChange={(event) => setTypedRepo(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.stopPropagation();
            void submit();
          }}
          placeholder="owner/name or a GitHub URL"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          className="h-8"
        />
      </Field>
      {onlyAgent === null ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Agent</p>
          <div role="group" aria-label="Agent" className="flex flex-wrap gap-1.5">
            {(Object.keys(PROVIDER_LABEL) as Provider[]).map((value) => (
              <Button
                key={value}
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={agent === value}
                className={cn("h-7 text-xs", agent === value && "border-foreground/40 bg-secondary")}
                onClick={() => setProvider(value)}
              >
                {PROVIDER_LABEL[value]}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      {composer.attachmentCount > 0 ? (
        <p className="text-xs text-muted-foreground">Attachments stay here: the task gets the text only.</p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" className="-ml-2 h-7 text-xs" onClick={moreOptions}>
          More options…
        </Button>
        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-muted-foreground sm:inline">
            <Kbd>Enter</Kbd> to start
          </span>
          <Button type="button" variant="outline" size="sm" className="h-7" onClick={close}>
            Cancel
          </Button>
          <Button type="button" size="sm" className="h-7" disabled={!canSubmit} onClick={() => void submit()}>
            {start.isPending ? <Icon name="Loading" className="animate-spin" /> : <Icon name="Play" />}
            Start task
          </Button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------- New thread screen

/** "Start a cloud task" in the New thread screen's side panel: the New task form, with the composer's project. */
function NewTaskPanel({ projectId }: PluginNewThreadPanelProps) {
  return <NewTaskForm layout="panel" bbProjectId={projectId} onDone={() => undefined} />;
}

const CHIP =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-state-hover data-[state=open]:text-foreground";

/**
 * The sandbox size for a chat that starts on a new Boat sandbox. Unpicked, the
 * machine gets Size for chats on a Boat sandbox; sizes the plan can't use are
 * greyed out with boat's reason, and a picked one that the plan lost blocks
 * the send until another is picked.
 */
function BoatSizeChip({ value, onChange }: PluginMachineProviderInputsProps) {
  const { data } = useSandboxSizes();
  const sizes = data?.sizes ?? null;
  const state = sizeChipState(value, data?.known === false ? null : sizes, data?.chatDefault ?? "small");
  // Report what this chat's machine will get (a ready default on mount), or why it can't start.
  // `report` stands for state.change (onChange may be a new function every render).
  const report = JSON.stringify(state.change);
  useEffect(() => {
    if (report !== JSON.stringify(value === null ? null : { status: "ready", value })) onChange(state.change);
  }, [report]);
  if (state.adopted) return null;

  const entries =
    sizes ??
    MACHINE_TYPES.map((type) => ({ type, label: MACHINE_LABEL[type].split(" · ")[0]!, detail: MACHINE_LABEL[type].split(" · ")[1] ?? "", available: true, reason: null }));
  const current = entries.find((entry) => entry.type === state.type);
  const defaultLabel = entries.find((entry) => entry.type === (data?.chatDefault ?? "small"))?.label ?? "Small";
  const label = data === undefined ? "Size" : (current?.label ?? state.type);
  const blocked = state.change.status === "blocked" ? state.change.reason : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(CHIP, blocked !== null && "text-warning-text hover:text-warning-text")}
          aria-label={`Boat sandbox size: ${label}${blocked !== null ? `. ${blocked}` : ""}`}
          title={blocked ?? (current?.detail ? `${label} · ${current.detail}` : undefined)}
        >
          <Icon name={blocked !== null ? "AlertTriangle" : "SlidersHorizontal"} fallback="ComputerCloud" className="size-3.5" aria-hidden />
          <span>{label}</span>
          <Icon name="ChevronDown" className="size-3 opacity-60" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" mobileTitle="Boat sandbox size" className="w-72">
        <DropdownMenuLabel>Boat sandbox size</DropdownMenuLabel>
        {entries.map((entry) => {
          const selected = entry.type === state.type;
          return (
            <DropdownMenuItem
              key={entry.type}
              disabled={!entry.available}
              aria-checked={selected}
              role="menuitemradio"
              onSelect={() => onChange({ status: "ready", value: { type: entry.type } })}
              className="items-start gap-2"
            >
              <Icon name="Check" className={cn("mt-0.5 size-3.5 shrink-0", !selected && "invisible")} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-foreground">{entry.label}</span>
                {entry.detail ? <span className="block text-muted-foreground">{entry.detail}</span> : null}
                {entry.available ? null : <span className="block text-muted-foreground">{entry.reason ?? "Not on your boat plan"}</span>}
              </span>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-xs text-pretty text-muted-foreground">
          Default: {defaultLabel} (Settings → Size for chats on a Boat sandbox).
          {data?.autoStopCapHours ? ` Your ${data.plan ?? "boat"} plan stops sandboxes after ${data.autoStopCapHours} h.` : ""}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ------------------------------------------------------------ coordinate

/** "Coordinate from this chat": the chat becomes an orchestrator for a project, after saying what changes. */
function CoordinateDialog({
  threadId,
  bbProjectId,
  open,
  onOpenChange,
}: {
  threadId: string;
  bbProjectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        {open ? <CoordinateForm threadId={threadId} bbProjectId={bbProjectId} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function CoordinateForm({ threadId, bbProjectId, onDone }: { threadId: string; bbProjectId: string; onDone: () => void }) {
  const projects = useProjects();
  const orchestrators = useOrchestrators();
  const opener = useBbProjectRepo(bbProjectId);
  const relay = useRelay();
  const started = useThreadTasks(threadId);
  const set = experimental_useRpcMutation({ contract: rpcContract, method: "setOrchestrator" });
  const [picked, setPicked] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const list = projects.data?.projects ?? [];
  // `||`: Radix's form-bound select can report "" once; that isn't a pick.
  const chosen =
    picked ||
    coordinateProject({ matchId: opener.data?.projectId ?? null, projects: list, orchestrators: orchestrators.data?.orchestrators ?? [] });
  const project = list.find((entry) => entry.id === chosen) ?? null;
  const openTasks = started.filter((task) => !isClosed(task.status)).length;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (project === null) return;
    try {
      await set.mutate({ threadId, on: true, project: { kind: "boat", id: project.id } });
      toast.success(`This chat coordinates ${project.name} now`);
      onDone();
    } catch (error) {
      showError(error);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Coordinate from this chat?</DialogTitle>
        <DialogDescription>It becomes an orchestrator: a chat that plans and coordinates tasks for one project.</DialogDescription>
      </DialogHeader>
      {projects.data !== undefined && list.length === 0 ? (
        <div className="flex flex-col gap-3 rounded-lg border border-dashed border-border px-4 py-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-medium text-foreground">Add a project first</p>
            <p className="text-xs text-pretty text-muted-foreground">An orchestrator works on one project: its repos, environment and rules.</p>
          </div>
          <Button type="button" size="sm" className="h-7 shrink-0 self-start sm:self-auto" onClick={() => setAdding(true)}>
            <Icon name="Plus" /> Add project
          </Button>
        </div>
      ) : (
        <Field
          label="Project"
          htmlFor="ca-coordinate-project"
          hint={
            <span className="flex flex-wrap items-start justify-between gap-x-3 gap-y-0.5">
              <span className="min-w-0 break-words">{project ? reposLabel(project.repos) : "Which project it works on."}</span>
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="inline-flex shrink-0 items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Icon name="Plus" className="size-3.5" aria-hidden /> Add project
              </button>
            </span>
          }
        >
          <Select value={chosen ?? ""} onValueChange={setPicked}>
            <SelectTrigger id="ca-coordinate-project">
              <SelectValue placeholder={projects.data === undefined ? "Loading projects…" : "Choose a project"} />
            </SelectTrigger>
            <SelectContent>
              {list.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">What changes</p>
        <ul className="list-disc space-y-1 pl-4 text-sm text-pretty text-muted-foreground marker:text-muted-foreground/60">
          <li>
            Tasks it starts come back to it to review before they reach you
            {openTasks > 0 ? `, including its ${plural(openTasks, "open task")}` : ""}.
          </li>
          <li>Its agent gets the orchestrator instructions and the boat tools the next time the chat starts a new session.</li>
          <li>It shows under Orchestrators on the Cloud agents page.</li>
          {relay.data?.enabled ? <li>Claude ↔ Codex switching can hand it to the other agent near a usage limit.</li> : null}
          <li>To undo it, pick Stop coordinating in this chat's menu.</li>
        </ul>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <SubmitButton pending={set.isPending} disabled={project === null} icon="Workflow">
          Coordinate
        </SubmitButton>
      </DialogFooter>
      {/* Portaled; its form stops its submit event, so it never reaches this one. */}
      <NewProjectDialog
        open={adding}
        onOpenChange={setAdding}
        repo={opener.data?.repo ?? ""}
        baseBranch=""
        onSaved={(saved) => {
          setPicked(saved.id);
          void projects.refetch();
        }}
      />
    </form>
  );
}

function StopCoordinatingDialog({ threadId, open, onOpenChange }: { threadId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const set = experimental_useRpcMutation({ contract: rpcContract, method: "setOrchestrator" });
  const run = async () => {
    try {
      await set.mutate({ threadId, on: false });
      toast.success("This chat no longer coordinates tasks");
      onOpenChange(false);
    } catch (error) {
      showError(error);
    }
  };
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Stop coordinating?"
      description="The chat stays as it is, but it's no longer an orchestrator. Tasks it started come to you when they finish, and its agent loses the orchestrator instructions and boat tools from its next session."
      confirmLabel="Stop coordinating"
      pending={set.isPending}
      onConfirm={() => void run()}
    />
  );
}
