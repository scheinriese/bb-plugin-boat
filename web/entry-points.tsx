// Native composer starts, Boat size input, one task header action, and
// project coordination. Core owns the draft and selected environment.
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { toast } from "sonner";
import {
  experimental_useRpcKeyedQuery,
  experimental_useRpcMutation,
  useComposer,
  useBbNavigate,
  useBbContext,
  type PluginAppBuilder,
  type PluginComposerApi,
  type PluginMachineProviderInputsProps,
  type PluginThreadActionDataInput,
} from "@get-bb/plugin-sdk/app";
import { rpcContract, type TaskDto, type ThreadRoleDto } from "../contract";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ShipDialog } from "./board";
import { shipRpcContract } from "../contract-ship";
import { cardStatus } from "./cards-logic";
import { ConfirmDialog, ReviewDialog, SubmitButton } from "./dialogs";
import {
  CLOUD_AGENT_PREFIX,
  NATIVE_STARTERS,
  submitNativeStart,
  coordinateAction,
  coordinateProject,
  prefixDraft,
  reviewFromChat,
  sizeChipState,
  unprefixDraft,
} from "./entry-logic";
import { MACHINE_TYPE_VALUES as MACHINE_TYPES } from "../contract";
import {
  MACHINE_LABEL,
  PANEL_PATH,
  isClosed,
  orchestratorSubPath,
  plural,
  reposLabel,
} from "./format";
import {
  useBoard,
  useBbProjectRepo,
  useCloudAgentsNavigation,
  useOrchestrators,
  useProjects,
  useRelay,
  useSandboxSizes,
  useThreadTasks,
  useThreadTask,
} from "./hooks";
import { NewProjectDialog } from "./projects-settings";
import { Field, showError } from "./ui";

/** Header and menu entries sort in their own group. */
const ACTION_GROUP = "3_cloud-agents";

export function registerEntryPoints(app: PluginAppBuilder): void {
  // Dialogs that thread actions open (Ship, Request review, Coordinate).
  const overlay = attempt("dialogs overlay", () =>
    app.slots.experimental_appOverlay({
      id: "entry-dialogs",
      component: EntryDialogs,
    }),
  );
  for (const command of [
    { id: "new-orchestrator", title: "Boat: New orchestrator" },
    { id: "resume-sandbox", title: "Boat: Resume sandbox" },
    { id: "go-needs-me", title: "Boat: Go to what needs me" },
  ] as const)
    attempt(command.title, () =>
      app.commands.register({
        ...command,
        isAvailable: (context) =>
          command.id !== "resume-sandbox" || context.threadId !== null,
        run: (context) =>
          openDialog({
            kind: "command",
            command: command.id,
            threadId: context.threadId,
            projectId: context.projectId,
          }),
      }),
    );

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
          description:
            "This chat hands the message to a cloud agent in a boat.dev sandbox.",
          run: ({ composer }) => sendToCloudAgent(composer),
        },
      ],
    }),
  );
  attempt("native start menu", () =>
    app.composer.customize({
      id: "native-start",
      scopes: ["new-thread"],
      sendMenu: [
        {
          id: "start",
          label: "Start",
          icon: "Play",
          run: ({ composer }) =>
            submitNativeStart(composer, "task").catch(showError),
        },
        {
          id: "start-orchestrator",
          label: "Start as orchestrator",
          icon: "Workflow",
          run: ({ composer }) =>
            submitNativeStart(composer, "orchestrator").catch(showError),
        },
      ],
      plusMenu: NATIVE_STARTERS.map((starter) => ({
        id: starter.id,
        label: starter.label,
        icon: starter.icon,
        run: ({ composer }) => {
          composer.insert(starter.prompt, { at: "end", block: true });
          composer.focus();
        },
      })),
    }),
  );
  attempt("coordinate offer", () =>
    app.composer.customize({
      id: "coordinate-offer",
      scopes: ["thread"],
      banners: [
        { id: "coordinate-offer", chrome: "bare", component: CoordinateOffer },
      ],
    }),
  );

  attempt("Boat sandbox size chip", () =>
    app.slots.experimental_machineProviderInputs({
      machineProviderId: "boat-sandbox",
      component: BoatSizeChip,
    }),
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
              run: () =>
                navigate.toPluginPanel(PANEL_PATH, {
                  subPath: orchestratorSubPath(thread.id),
                }),
            }
          : null,
    }),
  );
  if (!overlay) return;
  attempt("header: Task action", () =>
    app.slots.experimental_threadAction<ReturnType<typeof useHeaderData>>({
      id: "task-action",
      title: "Task action",
      icon: "ComputerCloud",
      group: ACTION_GROUP,
      order: 10,
      placement: "header",
      useData: useHeaderData,
      item: ({ thread, data, navigate }) => {
        const role = data.roles?.[thread.id];
        if (role?.kind !== "task") return null;
        const task = role.task,
          state = cardStatus(task);
        if (state.status === "stopped" && task.sandboxId)
          return {
            label: "Resume",
            icon: "Play",
            disabled: data.busy,
            run: () => data.resume(task.sandboxId!),
          };
        if (task.canShip)
          return {
            label: `Ship to ${task.baseBranch ?? "main"}`,
            icon: "ArrowUpRight",
            disabled: data.busy,
            run: async () => {
              try {
                const result = await data.ship(task.id);
                navigate.toThread(result.threadId);
              } catch (error) {
                showError(error);
              }
            },
          };
        if (state.status === "ready" && task.prUrl)
          return {
            label: "Open PR",
            icon: "ArrowUpRight",
            run: () => {
              navigate.openUrl(task.prUrl!);
            },
          };
        const review = reviewFromChat(role);
        return review
          ? {
              label: "Request review",
              icon: "Eye",
              disabled: review.disabled,
              run: () => openDialog({ kind: "review", task }),
            }
          : null;
      },
    }),
  );
  attempt("menu: Request review", () =>
    app.slots.experimental_threadAction<Roles>({
      id: "request-review",
      title: "Request review",
      icon: "Eye",
      group: ACTION_GROUP,
      order: 20,
      useData: useThreadRoles,
      item: ({ thread, data }) => {
        const review = reviewFromChat(data?.[thread.id]);
        return review
          ? {
              label: "Request review",
              icon: "Eye",
              disabled: review.disabled,
              run: () => openDialog({ kind: "review", task: review.task }),
            }
          : null;
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
        const action = coordinateAction(
          data?.[thread.id],
          thread.archivedAt !== null,
        );
        if (action === "coordinate") {
          return {
            label: "Coordinate from this chat…",
            icon: "Workflow",
            run: () =>
              openDialog({
                kind: "coordinate",
                threadId: thread.id,
                bbProjectId: thread.projectId,
              }),
          };
        }
        if (action === "stop") {
          return {
            label: "Stop coordinating…",
            icon: "Workflow",
            run: () =>
              openDialog({ kind: "stop-coordinating", threadId: thread.id }),
          };
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
    console.warn(
      `[boat] ${what}: not available in this bb (${error instanceof Error ? error.message : String(error)})`,
    );
    return false;
  }
}

// ------------------------------------------------------------------ roles

type Roles = Readonly<Record<string, ThreadRoleDto>> | undefined;

/** What each chat on screen is (task chat, orchestrator, plain chat): one keyed batch for every thread action. */
function useThreadRoles({ threadIds }: PluginThreadActionDataInput): Roles {
  const { data } = experimental_useRpcKeyedQuery({
    contract: rpcContract,
    method: "threadRoles",
    keys: threadIds,
    enabled: threadIds.length > 0,
  });
  return data;
}

function useHeaderData(input: PluginThreadActionDataInput) {
  const roles = useThreadRoles(input);
  const ship = experimental_useRpcMutation({
    contract: shipRpcContract,
    method: "requestShip",
  });
  const resume = experimental_useRpcMutation({
    contract: rpcContract,
    method: "sandboxAction",
  });
  return {
    roles,
    busy: ship.isPending || resume.isPending,
    ship: (id: string) => ship.mutate({ id, from: "chat" }),
    resume: async (id: string) => {
      try {
        await resume.mutate({ id, action: "resume" });
      } catch (error) {
        showError(error);
      }
    },
  };
}

function CoordinateOffer() {
  const composer = useComposer();
  const threadId =
    composer.scope.kind === "thread" ? composer.scope.threadId : "";
  const projectId = useBbContext().projectId;
  const tasks = useThreadTasks(threadId);
  const roles = useThreadRoles({ threadIds: [threadId] });
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || tasks.length < 2 || roles?.[threadId]?.kind !== "chat")
    return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs">
      <span className="min-w-0 flex-1 text-muted-foreground">
        This chat has started {tasks.length} tasks. Coordinate their work from
        here?
      </span>
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          openDialog({
            kind: "coordinate",
            threadId,
            bbProjectId: projectId ?? "",
          })
        }
      >
        Coordinate from here
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
        Just this task
      </Button>
    </div>
  );
}

// --------------------------------------------------------------- dialogs

type EntryDialog =
  | {
      kind: "command";
      command: "new-orchestrator" | "resume-sandbox" | "go-needs-me";
      threadId: string | null;
      projectId: string | null;
    }
  | { kind: "ship"; task: TaskDto }
  | { kind: "review"; task: TaskDto }
  | { kind: "coordinate"; threadId: string; bbProjectId: string }
  | { kind: "stop-coordinating"; threadId: string };

/** The open dialog; kept (closed) after closing so it can animate out. */
let dialogState: { dialog: EntryDialog | null; open: boolean } = {
  dialog: null,
  open: false,
};
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
  const { dialog, open } = useSyncExternalStore(
    subscribeDialogs,
    () => dialogState,
  );
  if (dialog === null) return null;
  const onOpenChange = (next: boolean) =>
    setDialogState({ dialog, open: next });
  switch (dialog.kind) {
    case "command":
      return open ? (
        <EntryCommand
          key={`${dialog.command}:${dialog.threadId}`}
          command={dialog.command}
          threadId={dialog.threadId}
          projectId={dialog.projectId}
          onDone={() => onOpenChange(false)}
        />
      ) : null;
    case "ship":
      return (
        <ShipDialog
          task={dialog.task}
          open={open}
          onOpenChange={onOpenChange}
          from="chat"
        />
      );
    case "review":
      return (
        <ReviewDialog
          task={dialog.task}
          open={open}
          onOpenChange={onOpenChange}
        />
      );
    case "coordinate":
      return (
        <CoordinateDialog
          threadId={dialog.threadId}
          bbProjectId={dialog.bbProjectId}
          open={open}
          onOpenChange={onOpenChange}
        />
      );
    case "stop-coordinating":
      return (
        <StopCoordinatingDialog
          threadId={dialog.threadId}
          open={open}
          onOpenChange={onOpenChange}
        />
      );
  }
}

function EntryCommand({
  command,
  threadId,
  projectId,
  onDone,
}: {
  command: "new-orchestrator" | "resume-sandbox" | "go-needs-me";
  threadId: string | null;
  projectId: string | null;
  onDone: () => void;
}) {
  const navigate = useBbNavigate();
  const board = useBoard(null);
  const task = useThreadTask(threadId ?? "");
  const resume = experimental_useRpcMutation({
    contract: rpcContract,
    method: "sandboxAction",
  });
  const roles = useThreadRoles({ threadIds: threadId ? [threadId] : [] });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    if (command === "go-needs-me" && !board.data && !board.error) return;
    if (command === "resume-sandbox" && !roles) return;
    started.current = true;
    if (command === "new-orchestrator") {
      navigate.toCompose({
        projectId: projectId ?? undefined,
        initialPrompt: "Help me plan and coordinate work for this project.",
        focusPrompt: true,
      });
      toast("Choose Start as orchestrator in the send menu");
      onDone();
    } else if (command === "go-needs-me") {
      const decisionThread = board.data?.needsYou.find(
        (item) => item.orchestratorThreadId,
      )?.orchestratorThreadId;
      const readyThread = board.data?.ready.find(
        (item) => item.threadId,
      )?.threadId;
      if (decisionThread ?? readyThread)
        navigate.toThread((decisionThread ?? readyThread)!);
      else navigate.toPluginPanel(PANEL_PATH);
      onDone();
    } else if (task?.sandboxId && cardStatus(task).status === "stopped") {
      void resume
        .mutate({ id: task.sandboxId, action: "resume" })
        .catch(showError)
        .finally(onDone);
    } else {
      toast("This chat has no stopped Boat sandbox");
      onDone();
    }
  }, [
    command,
    projectId,
    task,
    roles,
    board.data,
    board.error,
    resume.mutate,
    navigate,
    onDone,
  ]);
  return null;
}

// ---------------------------------------------------------------- composer

/** Prefix the draft with "Use a cloud agent for this …" and send it: the chat's agent starts the task (boat skill). */
async function sendToCloudAgent(composer: PluginComposerApi) {
  if (composer.isSubmittingBlocked) {
    toast.error(
      composer.submittingBlockedReason ??
        "This message can't be sent right now.",
    );
    return;
  }
  composer.replace((current) => prefixDraft(current, CLOUD_AGENT_PREFIX));
  try {
    await composer.submit();
  } catch {
    // bb already said why (its toast); take the prefix off again.
    composer.replace(
      (current) => unprefixDraft(current, CLOUD_AGENT_PREFIX) ?? current,
    );
  }
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
  const state = sizeChipState(
    value,
    data?.known === false ? null : sizes,
    data?.chatDefault ?? "small",
  );
  // Report what this chat's machine will get (a ready default on mount), or why it can't start.
  // `report` stands for state.change (onChange may be a new function every render).
  const report = JSON.stringify(state.change);
  useEffect(() => {
    if (
      report !==
      JSON.stringify(value === null ? null : { status: "ready", value })
    )
      onChange(state.change);
  }, [report]);
  if (state.adopted) return null;

  const entries =
    sizes ??
    MACHINE_TYPES.map((type) => ({
      type,
      label: MACHINE_LABEL[type].split(" · ")[0]!,
      detail: MACHINE_LABEL[type].split(" · ")[1] ?? "",
      available: true,
      reason: null,
    }));
  const current = entries.find((entry) => entry.type === state.type);
  const defaultLabel =
    entries.find((entry) => entry.type === (data?.chatDefault ?? "small"))
      ?.label ?? "Small";
  const label = data === undefined ? "Size" : (current?.label ?? state.type);
  const blocked =
    state.change.status === "blocked" ? state.change.reason : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            CHIP,
            blocked !== null && "text-warning-text hover:text-warning-text",
          )}
          aria-label={`Boat sandbox size: ${label}${blocked !== null ? `. ${blocked}` : ""}`}
          title={
            blocked ??
            (current?.detail ? `${label} · ${current.detail}` : undefined)
          }
        >
          <Icon
            name={blocked !== null ? "AlertTriangle" : "SlidersHorizontal"}
            fallback="ComputerCloud"
            className="size-3.5"
            aria-hidden
          />
          <span>Boat · {label}</span>
          <Icon name="ChevronDown" className="size-3 opacity-60" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        mobileTitle="Boat sandbox size"
        className="w-72"
      >
        <DropdownMenuLabel>Boat sandbox size</DropdownMenuLabel>
        {entries.map((entry) => {
          const selected = entry.type === state.type;
          return (
            <DropdownMenuItem
              key={entry.type}
              disabled={!entry.available}
              aria-checked={selected}
              role="menuitemradio"
              onSelect={() =>
                onChange({ status: "ready", value: { type: entry.type } })
              }
              className="items-start gap-2"
            >
              <Icon
                name="Check"
                className={cn(
                  "mt-0.5 size-3.5 shrink-0",
                  !selected && "invisible",
                )}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="block text-foreground">{entry.label}</span>
                {entry.detail ? (
                  <span className="block text-muted-foreground">
                    {entry.detail}
                  </span>
                ) : null}
                {entry.available ? null : (
                  <span className="block text-muted-foreground">
                    {entry.reason ?? "Not on your boat plan"}
                  </span>
                )}
              </span>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-xs text-pretty text-muted-foreground">
          Default: {defaultLabel} (Settings → Size for chats on a Boat sandbox).
          {data?.autoStopCapHours
            ? ` Your ${data.plan ?? "boat"} plan stops sandboxes after ${data.autoStopCapHours} h.`
            : ""}
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
        {open ? (
          <CoordinateForm
            threadId={threadId}
            bbProjectId={bbProjectId}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CoordinateForm({
  threadId,
  bbProjectId,
  onDone,
}: {
  threadId: string;
  bbProjectId: string;
  onDone: () => void;
}) {
  const projects = useProjects();
  const orchestrators = useOrchestrators();
  const opener = useBbProjectRepo(bbProjectId);
  const relay = useRelay();
  const started = useThreadTasks(threadId);
  const set = experimental_useRpcMutation({
    contract: rpcContract,
    method: "setOrchestrator",
  });
  const [picked, setPicked] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const list = projects.data?.projects ?? [];
  // `||`: Radix's form-bound select can report "" once; that isn't a pick.
  const chosen =
    picked ||
    coordinateProject({
      matchId: opener.data?.projectId ?? null,
      projects: list,
      orchestrators: orchestrators.data?.orchestrators ?? [],
    });
  const project = list.find((entry) => entry.id === chosen) ?? null;
  const openTasks = started.filter((task) => !isClosed(task.status)).length;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (project === null) return;
    try {
      await set.mutate({
        threadId,
        on: true,
        project: { kind: "boat", id: project.id },
      });
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
        <DialogDescription>
          It becomes an orchestrator: a chat that plans and coordinates tasks
          for one project.
        </DialogDescription>
      </DialogHeader>
      {projects.data !== undefined && list.length === 0 ? (
        <div className="flex flex-col gap-3 rounded-lg border border-dashed border-border px-4 py-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-medium text-foreground">
              Add a project first
            </p>
            <p className="text-xs text-pretty text-muted-foreground">
              An orchestrator works on one project: its repos, environment and
              rules.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            className="h-7 shrink-0 self-start sm:self-auto"
            onClick={() => setAdding(true)}
          >
            <Icon name="Plus" /> Add project
          </Button>
        </div>
      ) : (
        <Field
          label="Project"
          htmlFor="ca-coordinate-project"
          hint={
            <span className="flex flex-wrap items-start justify-between gap-x-3 gap-y-0.5">
              <span className="min-w-0 break-words">
                {project
                  ? reposLabel(project.repos)
                  : "Which project it works on."}
              </span>
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="inline-flex shrink-0 items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Icon name="Plus" className="size-3.5" aria-hidden /> Add
                project
              </button>
            </span>
          }
        >
          <Select value={chosen ?? ""} onValueChange={setPicked}>
            <SelectTrigger id="ca-coordinate-project">
              <SelectValue
                placeholder={
                  projects.data === undefined
                    ? "Loading projects…"
                    : "Choose a project"
                }
              />
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
        <p className="text-xs font-medium text-muted-foreground">
          What changes
        </p>
        <ul className="list-disc space-y-1 pl-4 text-sm text-pretty text-muted-foreground marker:text-muted-foreground/60">
          <li>
            Tasks it starts come back to it to review before they reach you
            {openTasks > 0
              ? `, including its ${plural(openTasks, "open task")}`
              : ""}
            .
          </li>
          <li>
            Its agent gets the orchestrator instructions and the boat tools the
            next time the chat starts a new session.
          </li>
          <li>It shows under Orchestrators on the Cloud agents page.</li>
          {relay.data?.enabled ? (
            <li>
              Claude ↔ Codex switching can hand it to the other agent near a
              usage limit.
            </li>
          ) : null}
          <li>To undo it, pick Stop coordinating in this chat's menu.</li>
        </ul>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <SubmitButton
          pending={set.isPending}
          disabled={project === null}
          icon="Workflow"
        >
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

function StopCoordinatingDialog({
  threadId,
  open,
  onOpenChange,
}: {
  threadId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const set = experimental_useRpcMutation({
    contract: rpcContract,
    method: "setOrchestrator",
  });
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
