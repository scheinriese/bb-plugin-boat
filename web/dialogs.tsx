// Dialogs: new task / sandbox / orchestrator, review, close task, and a
// generic confirm. Each dialog mounts its form only while open, so every
// opening starts from a clean form and fetches only what it needs.
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { toast } from "sonner";
import { experimental_useRpcMutation, useBbContext, useBbNavigate, useSettings } from "@get-bb/plugin-sdk/app";
import {
  MACHINE_TYPE_VALUES,
  ORCHESTRATOR_EFFORT_VALUES,
  rpcContract,
  rpcErrorInfo,
  type LocalProjectDto,
  type OrchestratorChoicesDto,
  type OrchestratorEffortDto,
  type ProjectDto,
  type ProjectRefDto,
  type TaskDto,
} from "../contract";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  MACHINE_LABEL,
  PROVIDER_LABEL,
  PROVIDER_SHORT,
  ROLE_LABEL,
  capitalize,
  effortLabel,
  environmentLabel,
  isSandboxActive,
  modelName,
  plural,
  reposLabel,
  shortRepo,
  type MachineType,
  type Provider,
  type Role,
} from "./format";
import {
  useBbProjectRepo,
  useCloudAgentsNavigation,
  useHosts,
  useOrchestratorChoices,
  useOrchestratorProjects,
  useOrchestrators,
  useOverview,
  useProjects,
  useSandboxSizes,
  useSandboxes,
  useSettingRows,
  useStoredFlag,
} from "./hooks";
import { STARTERS, chatChoice, chatControl, closeToast, projectSizeOnPlan, snapshotNameFor, titleFromBrief, type StarterId } from "./logic";
import { NewProjectDialog } from "./projects-settings";
import { Disclosure, Field, IconButton, InlineAlert, Kbd, RichText, SUGGEST_INPUT, ThreadName, showError } from "./ui";

interface DialogControl {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const NEW_SANDBOX = "__new";
const NO_PROJECT = "__none";
const CLOUD_ORCHESTRATOR = "__cloud";

const isOfflineHost = (status: string) => /offline|disconnected|unreachable|error/i.test(status);

export function SubmitButton({
  pending,
  disabled,
  icon,
  children,
  variant,
}: {
  pending: boolean;
  disabled?: boolean;
  icon?: string;
  children: ReactNode;
  variant?: "default" | "destructive";
}) {
  return (
    <Button type="submit" variant={variant} disabled={pending || disabled}>
      {pending ? <Icon name="Loading" className="animate-spin" /> : icon ? <Icon name={icon} /> : null}
      {children}
    </Button>
  );
}

/** Submit the surrounding form on ⌘/Ctrl+Enter from a textarea. */
export function submitOnModEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
}

/** Sandbox sizes, plan-aware: sizes the plan can't use are shown greyed out with boat's reason. */
function MachineSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: MachineType;
  onChange: (value: MachineType) => void;
}) {
  const sizes = useSandboxSizes().data?.sizes ?? MACHINE_TYPE_VALUES.map((type) => ({ type, label: MACHINE_LABEL[type], detail: "", available: true, reason: null }));
  const current = sizes.find((size) => size.type === value) ?? null;
  return (
    <Select value={value} onValueChange={(next) => onChange(next as MachineType)}>
      <SelectTrigger id={id}>
        {/* Only the name: a size the plan lacks would bring its reason into the trigger. */}
        <SelectValue>{current ? (current.detail ? `${current.label} · ${current.detail}` : current.label) : null}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {sizes.map((size) => (
          <SelectItem key={size.type} value={size.type} disabled={!size.available && size.type !== value} textValue={size.label}>
            <OptionLabel
              name={size.detail ? `${size.label} · ${size.detail}` : size.label}
              detail={size.available ? null : (size.reason ?? "Not on your boat plan")}
            />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ------------------------------------------------------------------ new task

export function NewTaskDialog({
  open,
  onOpenChange,
  initialBrief,
  bbProjectId,
  onStarted,
}: DialogControl & { initialBrief?: string; bbProjectId?: string | null; onStarted?: () => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {open ? (
          <NewTaskForm initialBrief={initialBrief} bbProjectId={bbProjectId} onStarted={onStarted} onDone={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * comparables.md #9: what a task can reach, shown until the user has read it
 * once. One line (the rest under More) so Start task stays in view.
 */
function ReachNote() {
  const [read, setRead] = useStoredFlag("read-task-reach-note");
  const [more, setMore] = useState(false);
  if (read) return null;
  const link = "rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
  return (
    <div className="flex items-start gap-1.5 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs text-pretty text-muted-foreground">
      <Icon name="SecurityCheck" fallback="Info" className="mt-px size-3.5 shrink-0 text-foreground" aria-hidden />
      <p className="min-w-0 flex-1">
        <span className="font-medium text-foreground">What a task can reach:</span> what your boat environment gives it (push access to its repos,
        your Claude or ChatGPT login, its secrets).
        {more
          ? " The agent runs every command without asking, inside its sandbox. A hostile README or issue could try to talk it into sending those somewhere, so keep secrets out of environments you use for repos you don't trust."
          : null}{" "}
        <button type="button" className={link} aria-expanded={more} onClick={() => setMore((value) => !value)}>
          {more ? "Less" : "More"}
        </button>
        {" · "}
        <button type="button" className={link} onClick={() => setRead(true)}>
          Got it
        </button>
      </p>
    </div>
  );
}

/**
 * The New task form: in a dialog, or (layout "panel") in the New thread
 * screen's side panel. `bbProjectId`: the bb project it was opened from; its
 * GitHub repo fills Repository (and so picks the project that has it).
 */
export function NewTaskForm({
  onDone,
  initialBrief = "",
  bbProjectId = null,
  layout = "dialog",
  onStarted,
}: {
  onDone: () => void;
  initialBrief?: string;
  bbProjectId?: string | null;
  layout?: "dialog" | "panel";
  /** After the task started, before the page opens it (the composer clears its draft). */
  onStarted?: () => void;
}) {
  // Per instance: the form can be on screen twice (the New thread panel and a dialog).
  const uid = `ca-task${useId().replace(/:/g, "")}`;
  const overview = useOverview();
  const sandboxes = useSandboxes();
  const projects = useProjects();
  const start = experimental_useRpcMutation({ contract: rpcContract, method: "startTask" });
  const testTask = experimental_useRpcMutation({ contract: rpcContract, method: "startTestTask" });
  const { openTask } = useCloudAgentsNavigation();

  const [starter, setStarter] = useState<StarterId | null>(null);
  const [chosenProject, setChosenProject] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [role, setRole] = useState<Role>("implement");
  const [provider, setProvider] = useState<Provider | null>(null);
  const [model, setModel] = useState("");
  const [sandbox, setSandbox] = useState(NEW_SANDBOX);
  const [machineType, setMachineType] = useState<MachineType | null>(null);
  const [brief, setBrief] = useState(initialBrief);
  const [addingProject, setAddingProject] = useState(false);
  // Run as a chat: follows the rules until the user ticks or clears it (null).
  const [chatTouched, setChatTouched] = useState<boolean | null>(null);
  const briefRef = useRef<HTMLTextAreaElement>(null);
  const settingsState = useSettings();
  const workers = settingsState.values?.workers;
  // Repository follows the bb project (the New thread screen's picker) until you edit it.
  const opener = useBbProjectRepo(bbProjectId);
  // null: no project picked (or opened from the page), so no repo; undefined: still loading.
  const openerRepo = bbProjectId === null ? "" : opener.data === undefined ? undefined : (opener.data.repo ?? "");
  const lastOpenerRepo = useRef("");
  useEffect(() => {
    if (openerRepo === undefined) return;
    const previous = lastOpenerRepo.current;
    lastOpenerRepo.current = openerRepo;
    setRepo((current) => (current === previous ? openerRepo : current));
  }, [openerRepo]);

  const defaults = overview.data?.defaults;
  // With one agent (Coding agents), it's the only choice.
  const onlyAgent = defaults?.onlyAgent ?? null;
  const roleDefault = role === "review" ? defaults?.reviewProvider : defaults?.implementProvider;
  const effectiveProvider: Provider = provider ?? roleDefault ?? "claude";
  const activeSandboxes = (sandboxes.data?.sandboxes ?? []).filter(
    (entry) => isSandboxActive(entry.state) && !entry.uses.some((use) => use.open && use.kind !== "task"),
  );
  const projectList = projects.data?.projects ?? [];
  const typedRepo = shortRepo(repo.trim()).toLowerCase();
  // The project: picked under More options, else the one whose repos include the typed repo.
  const repoOwner =
    typedRepo === "" ? null : (projectList.find((entry) => entry.repos.some((each) => shortRepo(each.repo).toLowerCase() === typedRepo)) ?? null);
  const project = (chosenProject === null ? repoOwner : projectList.find((entry) => entry.id === chosenProject)) ?? null;
  // A project's size, else the setting; the server applies it unless a size is picked here
  // (a project size the plan lacks falls back, as on the server, and says so).
  const planSizes = useSandboxSizes().data?.sizes ?? null;
  const projectSize = projectSizeOnPlan(project?.machineType ?? null, defaults?.machineType ?? "default", planSizes);
  const effectiveMachine: MachineType = machineType ?? (starter === "test" ? "small" : projectSize.type);
  const blockedSize = machineType === null && starter !== "test" && project !== null ? projectSize.blocked : null;
  const sizeName = (type: MachineType) => MACHINE_LABEL[type].split(" · ")[0];
  // With a project, an empty repo means its main repo, and a project repo gets its own base branch.
  const projectRepo =
    project === null
      ? null
      : typedRepo === ""
        ? (project.repos[0] ?? null)
        : (project.repos.find((entry) => shortRepo(entry.repo).toLowerCase() === typedRepo) ?? null);
  const testing = starter === "test";
  const effectiveTitle = title.trim() || titleFromBrief(brief);
  // The task's repos as the server sees them: the typed one (or the project's main repo), then the project's others.
  const mainRepo = typedRepo !== "" ? typedRepo : project?.repos[0] ? shortRepo(project.repos[0].repo).toLowerCase() : null;
  const otherRepos =
    project !== null && projectRepo !== null ? project.repos.filter((entry) => entry !== projectRepo).map((entry) => shortRepo(entry.repo).toLowerCase()) : [];
  const taskRepos = mainRepo === null ? [] : [mainRepo, ...otherRepos];
  const repoComplete = typedRepo === "" || REPO_PATTERN.test(typedRepo);
  const existingSandbox = sandbox !== NEW_SANDBOX;
  const chatInput = {
    workers: typeof workers === "string" ? workers : undefined,
    repos: taskRepos,
    repoComplete,
    projects: projects.data?.projects,
    taskChats: overview.data?.taskChats,
    connect: overview.data?.connect,
    existingSandbox,
    loading: settingsState.isLoading || (projects.data === undefined && !projects.error) || (overview.data === undefined && !overview.error),
  };
  const chatRules = chatControl(chatInput);
  const chat = chatChoice(chatRules, chatTouched, { ...chatInput, inProject: project !== null });
  // The repo the warning names, as typed.
  const warnedRepo = chatRules.untrustedRepos[0] === mainRepo && typedRepo !== "" ? shortRepo(repo.trim()) : (chatRules.untrustedRepos[0] ?? null);

  // The repo a starter's text names: the typed one, else the project's main repo.
  const starterRepo = repo.trim() ? shortRepo(repo.trim()) : project?.repos[0] ? shortRepo(project.repos[0].repo) : "";
  const starterEntry = starter === null ? null : (STARTERS.find((each) => each.id === starter) ?? null);
  // Until you edit them, a starter's title and text follow the repo you type.
  const lastStarterRepo = useRef(starterRepo);
  useEffect(() => {
    const previous = lastStarterRepo.current;
    lastStarterRepo.current = starterRepo;
    if (starterEntry === null || starterEntry.id === "test" || previous === starterRepo) return;
    setTitle((current) => (current === starterEntry.title(previous) ? starterEntry.title(starterRepo) : current));
    setBrief((current) => (current === starterEntry.brief(previous) ? starterEntry.brief(starterRepo) : current));
  }, [starterRepo, starterEntry]);
  const needsRepo = starterEntry?.needsRepo === true && starterRepo === "";

  // Start waits for what decides Run as a chat, so it sends what the checkbox shows.
  const canSubmit = testing || (brief.trim() !== "" && effectiveTitle !== "" && !needsRepo && !chatRules.loading);

  const applyStarter = (id: StarterId) => {
    const entry = STARTERS.find((each) => each.id === id)!;
    setStarter(id);
    if (id === "test") return;
    setRole(entry.role);
    lastStarterRepo.current = starterRepo;
    setTitle(entry.title(starterRepo));
    setBrief(entry.brief(starterRepo));
    setTimeout(() => {
      const field = briefRef.current;
      if (!field) return;
      field.focus();
      // Fill-in starters: the cursor goes to the first blank.
      const blank = field.value.indexOf(": \n");
      const at = blank === -1 ? field.value.indexOf(": ") : blank;
      if (id !== "check-repo" && at !== -1) field.setSelectionRange(at + 2, at + 2);
    }, 0);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    try {
      if (testing) {
        const { task } = await testTask.mutate({ notifyThreadId: null, provider: onlyAgent ?? provider });
        toast.success("Test task starting");
        onDone();
        openTask(task.id);
        return;
      }
      const { task, pending } = await start.mutate({
        title: effectiveTitle,
        brief: brief.trim(),
        role,
        repo: repo.trim() || null,
        branch: branch.trim() || null,
        baseBranch: baseBranch.trim() || null,
        provider,
        model: model.trim() || null,
        // A starter's preset, unless you typed a model.
        tier: model.trim() ? null : (starterEntry?.tier ?? null),
        sandbox: sandbox === NEW_SANDBOX ? null : sandbox,
        machineType: sandbox === NEW_SANDBOX ? machineType : null,
        notifyThreadId: null,
        projectId: project?.id ?? null,
        runner: chat.runner,
        confirmUntrustedChat: chat.confirmUntrustedChat,
        // The repo check measures its peak memory and recommends a size.
        measureMemory: starter === "check-repo",
      });
      toast.success(pending ? `${task.title}: starting` : `${task.title}: started`);
      onStarted?.();
      onDone();
      openTask(task.id);
    } catch (error) {
      showError(error);
    }
  };

  return (
    <form onSubmit={submit} className="@container grid gap-4">
      {layout === "dialog" ? (
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>{NEW_TASK_DESCRIPTION}</DialogDescription>
        </DialogHeader>
      ) : (
        <div className="space-y-1.5">
          <h2 className="text-base font-semibold leading-none tracking-tight text-foreground">New task</h2>
          <p className="text-sm text-pretty text-muted-foreground">{NEW_TASK_DESCRIPTION}</p>
        </div>
      )}
      {overview.data?.boatError ? (
        <InlineAlert>
          <RichText text={overview.data.boatError} />
        </InlineAlert>
      ) : null}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">Start from</p>
        <div role="group" aria-label="Start from" className="flex flex-wrap gap-1.5">
          {STARTERS.map((entry) => (
            <Button
              key={entry.id}
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={starter === entry.id}
              className={cn("h-7 text-xs", starter === entry.id && "border-foreground/40 bg-secondary")}
              onClick={() => (starter === entry.id && entry.id === "test" ? setStarter(null) : applyStarter(entry.id))}
            >
              <Icon name={STARTER_ICON[entry.id]} fallback="Circle" />
              {entry.label}
            </Button>
          ))}
        </div>
      </div>
      {testing ? (
        <div className="space-y-1 rounded-lg border border-border bg-card px-3 py-2.5">
          <p className="text-sm font-medium text-foreground">Test task</p>
          <p className="text-xs text-pretty text-muted-foreground">
            <RichText text={STARTERS.find((entry) => entry.id === "test")!.brief("")} />
          </p>
          <p className="text-xs text-muted-foreground">No repo, headless in boat, on a Small sandbox. One start and about a minute of sandbox time.</p>
        </div>
      ) : (
        <>
          <Field
            label="Repository"
            htmlFor={`${uid}-repo`}
            hint={
              needsRepo
                ? `${starterEntry!.label} needs a repo.`
                : project !== null
                  ? `${project.name} project · ${environmentLabel(project.environment)}${typedRepo === "" ? ` · empty: ${shortRepo(project.repos[0]?.repo ?? "")}` : ""}`
                  : typedRepo === ""
                    ? "Empty: a sandbox without a repo."
                    : undefined
            }
          >
            <Input
              id={`${uid}-repo`}
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
              placeholder={project?.repos[0] ? shortRepo(project.repos[0].repo) : "owner/name or a GitHub URL"}
              list={`${uid}-repos`}
              className={SUGGEST_INPUT}
              autoComplete="off"
              spellCheck={false}
              autoFocus={layout === "dialog"}
            />
            <datalist id={`${uid}-repos`}>
              {projectList.flatMap((entry) => entry.repos.map((each) => <option key={`${entry.id}:${each.repo}`} value={shortRepo(each.repo)} label={entry.name} />))}
            </datalist>
          </Field>
          <label htmlFor={`${uid}-chat`} className="flex items-start gap-2 text-sm">
            <Checkbox
              id={`${uid}-chat`}
              className="mt-0.5"
              checked={chat.checked}
              disabled={!chatRules.possible}
              onCheckedChange={(checked) => setChatTouched(checked === true)}
            />
            <span className="min-w-0">
              <span className={cn("text-foreground", !chatRules.possible && "text-muted-foreground")}>Run as a chat</span>
              <span className="block text-xs text-pretty text-muted-foreground">
                <RichText text={chatRules.hint} />
              </span>
            </span>
          </label>
          {chat.note === "untrusted-chat" ? (
            chatRules.workersBoat ? (
              <RepoTrustAlert>
                How tasks run is set to In boat. A task chat's sandbox can reach your bb, so run chats only for repos you trust.
              </RepoTrustAlert>
            ) : chatRules.headlessProject !== null ? (
              <RepoTrustAlert>
                <code className="font-mono text-xs">{warnedRepo}</code> is in the {chatRules.headlessProject} project, which runs its tasks headless. A
                task chat's sandbox can reach your bb, so run chats only for repos you trust.
              </RepoTrustAlert>
            ) : (
              <RepoTrustAlert action="Add as project" icon="Plus" onAction={() => setAddingProject(true)}>
                <code className="font-mono text-xs">{warnedRepo}</code> isn't one of your projects. A task chat's sandbox can reach your bb, so run chats
                only for repos you trust.
              </RepoTrustAlert>
            )
          ) : chat.note === "untrusted" ? (
            <RepoTrustAlert action="Add as project" icon="Plus" onAction={() => setAddingProject(true)}>
              <code className="font-mono text-xs">{shortRepo(repo.trim())}</code> isn't one of your projects, so its task runs headless in boat, with
              no access to your bb. Add it as a project if you trust it.
            </RepoTrustAlert>
          ) : chat.note === "headless-other" ? (
            <RepoTrustAlert>
              <code className="font-mono text-xs">{chatRules.untrustedRepos[0]}</code>
              {chatRules.headlessProject !== null
                ? ` is also in the ${chatRules.headlessProject} project, which runs its tasks headless`
                : " isn't one of your projects"}
              , so this task runs headless in boat, with no access to your bb.
            </RepoTrustAlert>
          ) : null}
          <Field
            label="What to do"
            htmlFor={`${uid}-brief`}
            hint={
              <>
                The agent sees only this and the repo. <Kbd>⌘</Kbd> <Kbd>Enter</Kbd> to start.
              </>
            }
          >
            <Textarea
              ref={briefRef}
              id={`${uid}-brief`}
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              onKeyDown={submitOnModEnter}
              rows={6}
              required
              className="min-h-28 resize-y"
              placeholder={"What should change, and why. Relevant files, links and constraints. How to tell it's done (tests, behaviour)."}
            />
          </Field>
        </>
      )}
      <Field label="Agent" htmlFor={`${uid}-agent`} className="@md:max-w-[50%]">
        <Select value={onlyAgent ?? effectiveProvider} onValueChange={(next) => setProvider(next as Provider)}>
          <SelectTrigger id={`${uid}-agent`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(PROVIDER_LABEL) as Provider[])
              .filter((value) => onlyAgent === null || value === onlyAgent)
              .map((value) => (
                <SelectItem key={value} value={value}>
                  {PROVIDER_LABEL[value]}
                  {provider === null && value === roleDefault ? " (default)" : ""}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </Field>
      {testing ? null : (
        <Disclosure label="More options">
          <div className="grid gap-3">
            <div className="grid gap-3 @md:grid-cols-2">
              <Field label="Title" htmlFor={`${uid}-title`} hint={title.trim() === "" && effectiveTitle ? `Empty: “${effectiveTitle}”` : "Empty: the first line of What to do."}>
                <Input id={`${uid}-title`} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="optional" maxLength={200} />
              </Field>
              <Field
                label="Project"
                htmlFor={`${uid}-project`}
                hint={projects.data !== undefined && projectList.length === 0 ? "No projects yet: Settings → Plugins → Boat Cloud Agents → Projects." : undefined}
              >
                <Select value={chosenProject ?? AUTO_PROJECT} onValueChange={(next) => setChosenProject(next === AUTO_PROJECT ? null : next)}>
                  <SelectTrigger id={`${uid}-project`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTO_PROJECT}>{repoOwner ? `From the repo (${repoOwner.name})` : "From the repo (none)"}</SelectItem>
                    <SelectItem value={NO_PROJECT}>None</SelectItem>
                    {projectList.map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        {entry.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Branch" htmlFor={`${uid}-branch`}>
                <Input id={`${uid}-branch`} value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="Empty: boat/<id>-<title>" />
              </Field>
              <Field label="Base branch" htmlFor={`${uid}-base`}>
                <Input id={`${uid}-base`} value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} placeholder={`Empty: ${projectRepo?.baseBranch ?? "the repo's default"}`} />
              </Field>
              <Field label="Role" htmlFor={`${uid}-role`}>
                <Select value={role} onValueChange={(next) => setRole(next as Role)}>
                  <SelectTrigger id={`${uid}-role`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(ROLE_LABEL) as Role[]).map((value) => (
                      <SelectItem key={value} value={value}>
                        {ROLE_LABEL[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Model" htmlFor={`${uid}-model`}>
                <Input
                  id={`${uid}-model`}
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder={starterEntry?.tier ? `Empty: the ${capitalize(starterEntry.tier)} preset` : "Empty: the model preset"}
                  spellCheck={false}
                />
              </Field>
              <Field label="Sandbox" htmlFor={`${uid}-sandbox`}>
                <Select value={sandbox} onValueChange={setSandbox}>
                  <SelectTrigger id={`${uid}-sandbox`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NEW_SANDBOX}>New sandbox</SelectItem>
                    {activeSandboxes.map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        {entry.name ? `${entry.name} · ${entry.id}` : entry.id} ({entry.state})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {sandbox === NEW_SANDBOX ? (
                <Field
                  label="Size"
                  htmlFor={`${uid}-machine`}
                  hint={
                    blockedSize !== null && project !== null ? (
                      <span className="text-warning-text">
                        {project.name} uses {sizeName(blockedSize.type)} sandboxes, but your boat plan doesn't include {sizeName(blockedSize.type)}
                        {blockedSize.reason ? ` (${blockedSize.reason.replace(/[.\s]+$/, "")})` : ""}. This task starts on {sizeName(effectiveMachine)}.
                      </span>
                    ) : null
                  }
                >
                  <MachineSelect id={`${uid}-machine`} value={effectiveMachine} onChange={setMachineType} />
                </Field>
              ) : null}
            </div>
          </div>
        </Disclosure>
      )}
      <ReachNote />
      <DialogFooter>
        {layout === "dialog" ? (
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
        ) : null}
        <SubmitButton pending={start.isPending || testTask.isPending} disabled={!canSubmit} icon="Play">
          {testing ? "Run test task" : "Start task"}
        </SubmitButton>
      </DialogFooter>
      {/* Portaled; its form stops its submit event, so it never reaches this one. */}
      <NewProjectDialog
        open={addingProject}
        onOpenChange={setAddingProject}
        repo={repo.trim()}
        baseBranch={baseBranch.trim()}
        onSaved={(saved) => {
          setChosenProject(saved.id);
          void projects.refetch();
        }}
      />
    </form>
  );
}

const AUTO_PROJECT = "__auto";
const NEW_TASK_DESCRIPTION = "A coding agent works on it in its own boat.dev sandbox. A task on a repo pushes a branch and opens a draft PR.";

const STARTER_ICON: Record<StarterId, string> = {
  "check-repo": "SecurityCheck",
  "fix-bug": "Bug",
  explore: "Explore",
  test: "Beaker",
};

/** "owner/name" once typed in full; the trust note waits for it. */
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/**
 * A note on the typed repo's trust (why its task runs headless, or a warning
 * before a chat), with the one-click fix when there is one. Stacked: the text
 * gets the full width, the button its own line (a phone squeezed it beside).
 */
function RepoTrustAlert({
  children,
  action,
  icon,
  onAction,
}: {
  children: ReactNode;
  action?: string;
  icon?: string;
  onAction?: () => void;
}) {
  return (
    <InlineAlert tone="warning">
      <div className="flex flex-col items-start gap-2">
        <p className="text-pretty">{children}</p>
        {action && onAction ? (
          <Button type="button" variant="outline" size="sm" className="h-7 max-w-full" onClick={onAction}>
            {icon ? <Icon name={icon} /> : null}
            <span className="truncate">{action}</span>
          </Button>
        ) : null}
      </div>
    </InlineAlert>
  );
}

// --------------------------------------------------------------- new sandbox

export function NewSandboxDialog({ open, onOpenChange }: DialogControl) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {open ? <NewSandboxForm onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function NewSandboxForm({ onDone }: { onDone: () => void }) {
  const overview = useOverview();
  const create = experimental_useRpcMutation({ contract: rpcContract, method: "createSandbox" });
  const [name, setName] = useState("");
  const [machineType, setMachineType] = useState<MachineType | null>(null);
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const effectiveMachine: MachineType = machineType ?? overview.data?.defaults.machineType ?? "default";
  const limits = overview.data?.limits;
  const cap = overview.data?.cap ?? limits?.maxActiveSandboxes ?? null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const { sandbox } = await create.mutate({
        name: name.trim() || null,
        machineType: effectiveMachine,
        repo: repo.trim() || null,
        branch: branch.trim() || null,
      });
      toast.success(`Sandbox ${sandbox.name ?? sandbox.id} is starting`);
      onDone();
    } catch (error) {
      showError(error);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>New sandbox</DialogTitle>
        <DialogDescription>
          A boat.dev machine you can reuse for tasks or open over SSH
          {overview.data && cap !== null ? ` (${overview.data.activeSandboxes} of ${cap} running now)` : ""}.
        </DialogDescription>
      </DialogHeader>
      {limits && !limits.canStart ? (
        <InlineAlert tone="warning">boat won't start another sandbox right now. Stop or delete one first.</InlineAlert>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="ca-sandbox-name">
          <Input
            id="ca-sandbox-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="optional"
            maxLength={120}
            autoFocus
          />
        </Field>
        <Field label="Size" htmlFor="ca-sandbox-machine">
          <MachineSelect id="ca-sandbox-machine" value={effectiveMachine} onChange={setMachineType} />
        </Field>
        <Field label="Repository" htmlFor="ca-sandbox-repo">
          <Input
            id="ca-sandbox-repo"
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            placeholder="owner/name (optional)"
          />
        </Field>
        <Field label="Branch" htmlFor="ca-sandbox-branch">
          <Input
            id="ca-sandbox-branch"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            placeholder="optional"
          />
        </Field>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <SubmitButton pending={create.isPending} icon="Plus">
          Create sandbox
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}

// ------------------------------------------------------------ save snapshot

/**
 * Save a checked sandbox as a snapshot ("Check this repo runs in a
 * sandbox"), and optionally start the project's tasks from it.
 */
export function SaveSnapshotDialog({ task, open, onOpenChange }: DialogControl & { task: TaskDto }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">{open ? <SaveSnapshotForm task={task} onDone={() => onOpenChange(false)} /> : null}</DialogContent>
    </Dialog>
  );
}

function SaveSnapshotForm({ task, onDone }: { task: TaskDto; onDone: () => void }) {
  const save = experimental_useRpcMutation({ contract: rpcContract, method: "saveSnapshot" });
  const saveProject = experimental_useRpcMutation({ contract: rpcContract, method: "saveProject" });
  const projects = useProjects();
  const project = projects.data?.projects.find((entry) => entry.id === task.projectId) ?? null;
  const [name, setName] = useState(() => snapshotNameFor(task.repo));
  const [useForProject, setUseForProject] = useState(true);
  const valid = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name.trim());

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!valid || task.sandboxId === null) return;
    try {
      const saved = await save.mutate({ sandboxId: task.sandboxId, name: name.trim() });
      if (project !== null && useForProject) {
        await saveProject.mutate({
          id: project.id,
          name: project.name,
          repos: project.repos,
          environment: project.environment,
          snapshot: saved.name,
          protocolPath: project.protocolPath,
          workerMode: project.workerMode,
          delivery: project.delivery,
        });
        toast.success(`Saved ${saved.name}; ${project.name}'s tasks start from it`);
      } else {
        toast.success(`Saved ${saved.name}`, { description: "A project can start its tasks from it (Settings → Projects → Snapshot)." });
      }
      onDone();
    } catch (error) {
      showError(error);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Save as snapshot</DialogTitle>
        <DialogDescription>
          Saves this sandbox as it is now, dependencies included. New tasks can start from it instead of installing everything again.
        </DialogDescription>
      </DialogHeader>
      <Field label="Name" htmlFor="ca-snapshot-name" hint={valid ? "Saving under an existing name replaces it." : "Letters, digits, dots, dashes and underscores."}>
        <Input id="ca-snapshot-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus spellCheck={false} />
      </Field>
      {project !== null ? (
        <label htmlFor="ca-snapshot-project" className="flex items-center gap-2 text-sm">
          <Checkbox id="ca-snapshot-project" checked={useForProject} onCheckedChange={(checked) => setUseForProject(checked === true)} />
          Start {project.name}'s tasks from it
        </label>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <SubmitButton pending={save.isPending || saveProject.isPending} disabled={!valid} icon="Download">
          Save snapshot
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}

// ---------------------------------------------------------- new orchestrator

/** Handoff files go into the kickoff prompt (the contract caps it at 200,000 chars). */
const MAX_HANDOFF_BYTES = 200_000;
const NO_THREAD = "__none";

type ProjectOption =
  | { kind: "boat"; value: string; name: string; project: ProjectDto }
  | { kind: "local"; value: string; name: string; local: LocalProjectDto; match: ProjectDto | null };

interface HandoffFile {
  name: string;
  text: string;
  size: number;
}

/** The "Take over from" section's values; null while it's collapsed (nothing is sent). */
interface TakeOver {
  threadId: string | null;
  file: HandoffFile | null;
}

/** What the orchestrator would work on: a local project reuses its configured twin's settings. */
function optionSettings(option: ProjectOption) {
  if (option.kind === "boat") return option.project;
  const { local, match } = option;
  const branch = local.branch ?? "?";
  return {
    repos: match
      ? match.repos.map((entry, index) => (index === 0 ? { repo: local.repo, baseBranch: branch } : entry))
      : [{ repo: local.repo, baseBranch: branch }],
    environment: match?.environment ?? null,
    snapshot: match?.snapshot ?? null,
  };
}

function optionSummary(option: ProjectOption): string {
  const settings = optionSettings(option);
  const parts = [reposLabel(settings.repos), environmentLabel(settings.environment)];
  if (settings.snapshot) parts.push(`snapshot ${settings.snapshot}`);
  return parts.join(" · ");
}

type LocalBlocker = "problem" | "missing" | "unpushed";

/** Why a local project can't start an orchestrator yet, if anything. */
function localBlocker(local: LocalProjectDto): LocalBlocker | null {
  if (local.problem !== null || local.branch === null) return "problem";
  if (local.branchMissingRemotely) return "missing";
  if ((local.unpushed ?? 0) > 0) return "unpushed";
  return null;
}

export function NewOrchestratorDialog({
  open,
  onOpenChange,
  projectId = null,
}: DialogControl & { projectId?: string | null }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        {open ? <NewOrchestratorForm projectId={projectId} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function NewOrchestratorForm({ projectId, onDone }: { projectId: string | null; onDone: () => void }) {
  const context = useBbContext();
  const navigate = useBbNavigate();
  const hosts = useHosts();
  const overview = useOverview();
  const projects = useOrchestratorProjects();
  const orchestrators = useOrchestrators();
  const settingRows = useSettingRows();
  const start = experimental_useRpcMutation({ contract: rpcContract, method: "startOrchestrator" });
  const push = experimental_useRpcMutation({ contract: rpcContract, method: "pushLocalBranch" });
  const projectTrigger = useRef<HTMLButtonElement>(null);
  const [projectValue, setProjectValue] = useState("");
  const [pushing, setPushing] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [where, setWhere] = useState<string | null>(null);
  const [takeOver, setTakeOver] = useState<TakeOver | null>(null);
  const [addingProject, setAddingProject] = useState(false);
  // Agent and effort: the settings' (Settings → Orchestrators) until picked here.
  const choices = useOrchestratorChoices();
  const [agentPick, setAgentPick] = useState<Provider | null>(null);
  const [effortPick, setEffortPick] = useState<OrchestratorEffortDto | null>(null);
  const agent = agentPick ?? choices.data?.provider ?? null;
  const effort = effortPick ?? choices.data?.effort ?? null;

  const hostList = hosts.data?.hosts ?? [];
  const primary = hostList.find((host) => host.primary) ?? hostList[0];
  // A cloud orchestrator runs bb in a boat sandbox, which needs bb Connect.
  const connect = overview.data?.connect ?? null;
  // A host id or CLOUD_ORCHESTRATOR. Cloud by default when bb Connect is set up
  // (it keeps going while this computer sleeps); otherwise this computer.
  const effectiveWhere = where ?? (connect?.state === "ready" ? CLOUD_ORCHESTRATOR : (primary?.id ?? null));
  const cloud = effectiveWhere === CLOUD_ORCHESTRATOR;

  // The bb project the dialog was opened from comes first among the local ones.
  const currentBbProject = projectId ?? context.projectId;
  const options = useMemo(() => {
    const configured = projects.data?.projects ?? [];
    const boat = configured.map(
      (project): ProjectOption => ({ kind: "boat", value: `boat:${project.id}`, name: project.name, project }),
    );
    const local = [...(projects.data?.local ?? [])]
      .sort((a, b) => Number(b.bbProjectId === currentBbProject) - Number(a.bbProjectId === currentBbProject))
      .map(
        (entry): ProjectOption => ({
          kind: "local",
          value: `local:${entry.bbProjectId}`,
          name: entry.name,
          local: entry,
          match: configured.find((project) => project.id === entry.matchesProjectId) ?? null,
        }),
      );
    return { boat, local };
  }, [projects.data, currentBbProject]);

  // Preselected: the project of the bb project this opened from, the only one, else the last one used.
  const preselected = useMemo(() => {
    const configured = options.boat.flatMap((option) => (option.kind === "boat" ? [{ value: option.value, project: option.project }] : []));
    const fromContext = projects.data?.local.find((entry) => entry.bbProjectId === currentBbProject)?.matchesProjectId ?? null;
    if (fromContext !== null && configured.some((option) => option.project.id === fromContext)) return `boat:${fromContext}`;
    if (configured.length === 1) return configured[0]!.value;
    const last = [...(orchestrators.data?.orchestrators ?? [])]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .find((entry) => configured.some((option) => option.project.id === entry.projectId));
    return last?.projectId ? `boat:${last.projectId}` : "";
  }, [options.boat, projects.data, currentBbProject, orchestrators.data]);
  const chosenValue = projectValue || preselected;
  const selected = [...options.boat, ...options.local].find((option) => option.value === chosenValue) ?? null;
  const fullAccess = settingRows.data?.settings.find((row) => row.key === "cloudOrchestratorFullAccess")?.value !== false;
  const blocker = selected?.kind === "local" ? localBlocker(selected.local) : null;
  const canSubmit = selected !== null && blocker === null && !pushing && prompt.trim() !== "";
  const noProjects =
    projects.data !== undefined && projects.data.projects.length === 0 && projects.data.local.length === 0;
  // One-line summary of the pick (repos, environment, snapshot) plus notes, under the select.
  const projectNotes: string[] = [];
  if (selected !== null && blocker !== "problem") projectNotes.push(optionSummary(selected));
  if (selected?.kind === "local" && selected.match !== null) {
    projectNotes.push(`Uses the ${selected.match.name} project's environment`);
  }
  if (projects.data?.localError) projectNotes.push(`Local bb projects unavailable: ${projects.data.localError}`);

  const pushBranch = async (local: LocalProjectDto) => {
    setPushing(true);
    try {
      const result = await push.mutate({ bbProjectId: local.bbProjectId, branch: local.branch ?? "" });
      await projects.refetch();
      toast.success(`Pushed ${result.local.branch ?? local.branch ?? "the branch"} to GitHub`);
    } catch (error) {
      showError(error);
    } finally {
      setPushing(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selected === null) {
      projectTrigger.current?.focus();
      return;
    }
    if (!canSubmit) return;
    const project: ProjectRefDto =
      selected.kind === "boat"
        ? { kind: "boat", id: selected.project.id }
        : { kind: "local", bbProjectId: selected.local.bbProjectId };
    try {
      const { threadId, movedTaskIds } = await start.mutate({
        project,
        prompt: prompt.trim(),
        title: title.trim() || null,
        hostId: cloud ? null : effectiveWhere,
        cloud,
        takeOverThreadId: takeOver?.threadId ?? null,
        takeOverText: takeOver?.file?.text ?? null,
        takeOverFileName: takeOver?.file?.name ?? null,
        // What the line above Take over shows (null until it's known: then the server's same defaults).
        provider: agent,
        effort,
      });
      toast.success(cloud ? "Cloud orchestrator starting" : "Orchestrator started");
      if (movedTaskIds.length > 0) toast.success(`Moved ${plural(movedTaskIds.length, "task")}`);
      onDone();
      navigate.toThread(threadId);
    } catch (error) {
      showError(error);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>New orchestrator</DialogTitle>
        <DialogDescription>
          A chat that plans and coordinates tasks for one project: it starts cloud agents to build and review the work, and reports back with
          PRs. It doesn't edit code itself.
        </DialogDescription>
      </DialogHeader>
      {projects.error ? <InlineAlert>{projects.error.message}</InlineAlert> : null}
      {noProjects ? (
        <div className="flex flex-col gap-3 rounded-lg border border-dashed border-border px-4 py-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-medium text-foreground">Add a project first</p>
            <p className="text-xs text-pretty text-muted-foreground">
              An orchestrator works on one project: its repos, environment and rules.
              {projects.data?.localError ? ` Local bb projects: ${projects.data.localError}` : ""}
            </p>
          </div>
          <Button type="button" size="sm" className="h-7 shrink-0 self-start sm:self-auto" onClick={() => setAddingProject(true)}>
            <Icon name="Plus" /> Add project
          </Button>
        </div>
      ) : (
        <Field
          label="Project"
          htmlFor="ca-orch-project"
          hint={
            <span className="flex flex-wrap items-start gap-x-3 gap-y-0.5">
              {projectNotes.length > 0 ? (
                <span id="ca-orch-project-summary" className="block min-w-0 flex-1 space-y-0.5">
                  {projectNotes.map((note) => (
                    <span key={note} className="block break-words">
                      {note}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="flex-1" />
              )}
              <button
                type="button"
                onClick={() => setAddingProject(true)}
                className="inline-flex shrink-0 items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Icon name="Plus" className="size-3.5" aria-hidden /> Add project
              </button>
            </span>
          }
        >
          <Select value={chosenValue} onValueChange={setProjectValue}>
            <SelectTrigger
              ref={projectTrigger}
              id="ca-orch-project"
              aria-required
              aria-describedby={projectNotes.length > 0 ? "ca-orch-project-summary" : undefined}
            >
              <SelectValue
                placeholder={projects.data === undefined && !projects.error ? "Loading projects…" : "Choose a project"}
              >
                {selected?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="max-w-[var(--radix-select-trigger-width)]">
              {options.boat.length > 0 ? (
                <SelectGroup>
                  <SelectLabel className="text-xs font-medium text-muted-foreground">Projects</SelectLabel>
                  {options.boat.map((option) => (
                    <SelectItem key={option.value} value={option.value} textValue={option.name}>
                      <OptionLabel name={option.name} detail={optionSummary(option)} />
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
              {options.boat.length > 0 && options.local.length > 0 ? <SelectSeparator /> : null}
              {options.local.length > 0 ? (
                <SelectGroup>
                  <SelectLabel className="text-xs font-medium text-muted-foreground">Local bb projects</SelectLabel>
                  {options.local.map((option) => (
                    <SelectItem key={option.value} value={option.value} textValue={option.name}>
                      <OptionLabel
                        name={option.name}
                        detail={
                          option.kind === "local"
                            ? `${shortRepo(option.local.repo)} @ ${option.local.branch ?? "unknown branch"}`
                            : null
                        }
                      />
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
            </SelectContent>
          </Select>
        </Field>
      )}
      {selected?.kind === "local" && blocker !== null ? (
        <LocalBranchWarning
          local={selected.local}
          blocker={blocker}
          pushing={pushing}
          onPush={() => void pushBranch(selected.local)}
        />
      ) : null}
      <Field label="What should it coordinate?" htmlFor="ca-orch-prompt">
        <Textarea
          id="ca-orch-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={submitOnModEnter}
          rows={6}
          required
          autoFocus
          className="min-h-32 resize-y"
          placeholder="e.g. Fix the three open bugs labelled 'checkout' in acme/shop, one PR each."
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Where" htmlFor="ca-orch-where">
          <Select value={effectiveWhere ?? undefined} onValueChange={setWhere}>
            <SelectTrigger id="ca-orch-where">
              <SelectValue placeholder={hosts.isLoading ? "Loading…" : "This computer"} />
            </SelectTrigger>
            <SelectContent>
              {hostList.map((host) => (
                <SelectItem key={host.id} value={host.id} disabled={!host.primary && isOfflineHost(host.status)}>
                  {host.id === primary?.id ? "This computer" : `${host.name} · ${host.status}`}
                </SelectItem>
              ))}
              {hostList.length > 0 ? <SelectSeparator /> : null}
              {/* The note under the select says Boat sandbox and bb Connect. */}
              <SelectItem value={CLOUD_ORCHESTRATOR}>In the cloud</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Title" htmlFor="ca-orch-title">
          <Input
            id="ca-orch-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="optional"
            maxLength={200}
          />
        </Field>
        {cloud ? <CloudOrchestratorNote overview={overview.data} fullAccess={fullAccess} /> : null}
        {cloud && connect !== null && connect.state !== "ready" ? (
          <InlineAlert tone="warning" className="sm:col-span-2">
            Cloud orchestrator needs bb Connect.{" "}
            {connect.state === "off" ? (
              <RichText text={connect.fix ?? "Set up remote access in Settings → Plugins → bb connect."} />
            ) : (
              "Couldn't check whether it's set up; without it, the orchestrator won't start."
            )}
          </InlineAlert>
        ) : null}
      </div>
      {choices.data !== undefined && agent !== null && effort !== null ? (
        <AgentSection choices={choices.data} agent={agent} effort={effort} onAgent={setAgentPick} onEffort={setEffortPick} />
      ) : null}
      <TakeOverSection value={takeOver} onChange={setTakeOver} />
      {/* Portaled; its form stops its submit event, so it never reaches this one. */}
      <NewProjectDialog
        open={addingProject}
        onOpenChange={setAddingProject}
        repo=""
        baseBranch=""
        onSaved={(saved) => {
          setProjectValue(`boat:${saved.id}`);
          void projects.refetch();
        }}
      />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <SubmitButton pending={start.isPending} disabled={!canSubmit} icon={cloud ? "ComputerCloud" : "Workflow"}>
          {cloud ? "Start in the cloud" : "Start orchestrator"}
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}

type OverviewData = NonNullable<ReturnType<typeof useOverview>["data"]>;

/** What a cloud orchestrator uses: one sandbox (it stops after the plan's auto-stop cap, if boat reports one), and full access. */
function CloudOrchestratorNote({ overview, fullAccess }: { overview: OverviewData | undefined; fullAccess: boolean }) {
  const sizes = useSandboxSizes().data;
  if (overview === undefined) return null;
  const machine = sizes?.sizes.find((size) => size.type === overview.defaults.orchestratorMachineType)?.label ?? overview.defaults.orchestratorMachineType;
  const { cap, freeSlots } = overview;
  const capHours = sizes?.autoStopCapHours ?? null;
  const uses = cap === null ? "Uses 1 sandbox" : `Uses 1 of your ${plural(cap, "sandbox", "sandboxes")} (${freeSlots ?? 0} free now)`;
  return (
    <div className="grid gap-2 sm:col-span-2">
      <p className="text-xs text-pretty text-muted-foreground">
        Runs in a Boat sandbox. {uses}, {machine} size. Setup takes about 1–2 min.
        {capHours !== null ? ` Your ${sizes?.plan ?? "boat"} plan stops it after ${capHours} h; your next message wakes it.` : null}
      </p>
      {fullAccess ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Icon name="Info" className="mt-px size-3.5 shrink-0" aria-hidden />
          Runs with full access in its sandbox (change in Settings → Orchestrators).
        </p>
      ) : null}
      {freeSlots === 0 ? (
        <InlineAlert tone="warning">
          {overview.defaults.freeSlotsWhenFull
            ? "Every sandbox is in use. Starting it stops an idle task's sandbox, if there is one (the task picks up again later)."
            : "Every sandbox is in use. Stop one first, or run it on this computer."}
        </InlineAlert>
      ) : null}
    </div>
  );
}

/** A select option with a muted second line (the trigger shows only the name). */
export function OptionLabel({ name, detail }: { name: ReactNode; detail: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col py-0.5">
      <span className="break-words">{name}</span>
      {detail ? <span className="break-words text-xs text-muted-foreground">{detail}</span> : null}
    </span>
  );
}

function LocalBranchWarning({
  local,
  blocker,
  pushing,
  onPush,
}: {
  local: LocalProjectDto;
  blocker: LocalBlocker;
  pushing: boolean;
  onPush: () => void;
}) {
  if (blocker === "problem") {
    return <InlineAlert tone="warning">{local.problem ?? "Couldn't read the local branch."}</InlineAlert>;
  }
  const branch = <code className="font-mono text-xs">{local.branch}</code>;
  const count = local.unpushed ?? 0;
  return (
    <InlineAlert tone="warning">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1">
          {blocker === "missing" ? (
            <>{branch} isn't on GitHub yet: tasks clone from GitHub and won't see it.</>
          ) : (
            <>
              {branch} has {plural(count, "commit")} that {count === 1 ? "isn't" : "aren't"} on GitHub: tasks clone from GitHub
              and won't see {count === 1 ? "it" : "them"}.
            </>
          )}
        </p>
        <Button type="button" variant="outline" size="sm" className="h-7 shrink-0" disabled={pushing} onClick={onPush}>
          <Icon name={pushing ? "Loading" : "ArrowUp"} className={pushing ? "animate-spin" : undefined} />
          {pushing ? "Pushing…" : "Push branch first"}
        </Button>
      </div>
    </InlineAlert>
  );
}

const DISCLOSURE_BUTTON =
  "inline-flex items-center gap-1.5 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/**
 * What the orchestrator starts with, as one line ("Claude Code · Opus 5.5 ·
 * High effort") that unfolds into an agent and an effort pick for this one.
 * The model is the agent's Build preset model; agents it can't start on
 * are greyed out with the reason.
 */
function AgentSection({
  choices,
  agent,
  effort,
  onAgent,
  onEffort,
}: {
  choices: OrchestratorChoicesDto;
  agent: Provider;
  effort: OrchestratorEffortDto;
  onAgent: (agent: Provider) => void;
  onEffort: (effort: OrchestratorEffortDto) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const model = choices.agents.find((entry) => entry.provider === agent)?.model ?? null;
  const summary = [PROVIDER_LABEL[agent], model ? modelName(model) : null, `${effortLabel(effort)} effort`].filter(Boolean).join(" · ");
  const main = choices.mainAgent;
  return (
    <div className="space-y-2">
      <button type="button" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen((value) => !value)} className={DISCLOSURE_BUTTON}>
        <Icon name="ChevronRight" className={cn("size-3.5 transition-transform duration-150", open && "rotate-90")} aria-hidden />
        <span className="sr-only">Agent, model and effort: </span>
        {summary}
      </button>
      {open ? (
        <div id={panelId} className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
          <Field label="Agent" htmlFor="ca-orch-agent">
            <Select value={agent} onValueChange={(next) => onAgent(next as Provider)}>
              <SelectTrigger id="ca-orch-agent">
                <SelectValue>{PROVIDER_LABEL[agent]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {choices.agents.map((entry) => (
                  <SelectItem
                    key={entry.provider}
                    value={entry.provider}
                    disabled={!entry.available && entry.provider !== agent}
                    textValue={PROVIDER_LABEL[entry.provider]}
                  >
                    <OptionLabel
                      name={`${PROVIDER_LABEL[entry.provider]}${entry.provider === choices.provider ? " (default)" : ""}`}
                      detail={entry.available ? modelName(entry.model) : entry.reason}
                    />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Effort" htmlFor="ca-orch-effort">
            <Select value={effort} onValueChange={(next) => onEffort(next as OrchestratorEffortDto)}>
              <SelectTrigger id="ca-orch-effort">
                <SelectValue>{effortLabel(effort)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {ORCHESTRATOR_EFFORT_VALUES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {effortLabel(value)}
                    {value === choices.effort ? " (default)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <p className="text-xs text-pretty text-muted-foreground sm:col-span-2">
            The model is the agent's Build preset model, as for Build tasks (Settings → Models). Higher effort uses your limits faster: an
            orchestrator wakes after every task turn. Default agent and effort: Settings → Orchestrators.
            {choices.switching && agent !== main
              ? ` Claude ↔ Codex switching moves it to ${PROVIDER_LABEL[main]} once ${PROVIDER_SHORT[main]} has room.`
              : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** Optional: inherit a previous orchestrator's open tasks and/or a handoff file. */
function TakeOverSection({
  value,
  onChange,
}: {
  value: TakeOver | null;
  onChange: Dispatch<SetStateAction<TakeOver | null>>;
}) {
  const orchestrators = useOrchestrators();
  const fileInput = useRef<HTMLInputElement>(null);
  const chooseButton = useRef<HTMLButtonElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const panelId = useId();
  const threads = useMemo(
    () => [...(orchestrators.data?.orchestrators ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [orchestrators.data],
  );
  const expanded = value !== null;

  const toggle = (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={expanded ? panelId : undefined}
      onClick={() => {
        setFileError(null);
        onChange(expanded ? null : { threadId: null, file: null });
      }}
      className={DISCLOSURE_BUTTON}
    >
      <Icon
        name="ChevronRight"
        className={cn("size-3.5 transition-transform duration-150", expanded && "rotate-90")}
        aria-hidden
      />
      {expanded ? "Take over from" : "Take over from a previous orchestrator…"}
    </button>
  );
  if (value === null) return <div>{toggle}</div>;

  const readFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset so picking the same file again still fires a change.
    event.target.value = "";
    if (file === undefined) return;
    if (file.size > MAX_HANDOFF_BYTES) {
      setFileError(`${file.name} is over 200 KB.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      if (text.trim() === "") {
        setFileError(`${file.name} is empty.`);
        return;
      }
      setFileError(null);
      const handoff = { name: file.name.slice(0, 300), text: text.slice(0, MAX_HANDOFF_BYTES), size: file.size };
      // Reading is async: apply to the latest values, and not at all if the section was closed meanwhile.
      onChange((current) => (current === null ? null : { ...current, file: handoff }));
    };
    reader.onerror = () => setFileError(`Couldn't read ${file.name}.`);
    reader.readAsText(file);
  };

  return (
    <div className="space-y-2">
      {toggle}
      <div id={panelId} className="grid gap-3 rounded-lg border border-border p-3">
        <Field
          label="Previous orchestrator"
          htmlFor="ca-orch-takeover"
          hint="Its open tasks move to the new orchestrator and its last message goes into the kickoff."
        >
          <Select
            value={value.threadId ?? NO_THREAD}
            onValueChange={(next) =>
              onChange((current) => current && { ...current, threadId: next === NO_THREAD ? null : next })
            }
          >
            <SelectTrigger id="ca-orch-takeover">
              <SelectValue>{value.threadId ? <ThreadName threadId={value.threadId} fallback={threads.find((entry) => entry.threadId === value.threadId)?.title} /> : "None"}</SelectValue>
            </SelectTrigger>
            <SelectContent className="max-w-[var(--radix-select-trigger-width)]">
              <SelectItem value={NO_THREAD}>None</SelectItem>
              {threads.map((entry) => (
                <SelectItem key={entry.threadId} value={entry.threadId} textValue={entry.title ?? entry.projectName ?? undefined}>
                  <OptionLabel
                    name={<ThreadName threadId={entry.threadId} fallback={entry.title} />}
                    detail={[
                      entry.projectName,
                      entry.openTasks > 0 ? plural(entry.openTasks, "open task") : "no open tasks",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          label="Handoff file"
          htmlFor="ca-orch-handoff"
          hint="Goes into the kickoff as notes. Markdown or text, up to 200 KB."
        >
          <input
            ref={fileInput}
            id="ca-orch-handoff"
            type="file"
            accept=".md,.txt,text/*"
            tabIndex={-1}
            className="sr-only"
            onChange={readFile}
          />
          {value.file ? (
            <div className="flex min-w-0 items-center gap-2 rounded-md border border-border py-0.5 pl-2.5 pr-0.5 text-sm">
              <Icon name="FileText" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{value.file.name}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {Math.max(1, Math.round(value.file.size / 1024))} KB
              </span>
              <IconButton
                label={`Remove ${value.file.name}`}
                icon="X"
                onClick={() => {
                  onChange((current) => current && { ...current, file: null });
                  // The remove button goes away; keep focus in the section.
                  setTimeout(() => chooseButton.current?.focus(), 0);
                }}
              />
            </div>
          ) : (
            <div>
              <Button
                ref={chooseButton}
                type="button"
                variant="outline"
                size="sm"
                className="h-7"
                aria-label="Choose a handoff file"
                onClick={() => fileInput.current?.click()}
              >
                <Icon name="Paperclip" /> Choose file…
              </Button>
            </div>
          )}
          {fileError ? (
            <p role="alert" className="text-xs text-destructive-text">
              {fileError}
            </p>
          ) : null}
        </Field>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ request review

type ReviewSandbox = "auto" | "new" | "same";

export function ReviewDialog({ task, open, onOpenChange }: DialogControl & { task: TaskDto }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {open ? <ReviewForm task={task} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ReviewForm({ task, onDone }: { task: TaskDto; onDone: () => void }) {
  const review = experimental_useRpcMutation({ contract: rpcContract, method: "review" });
  const { openTask } = useCloudAgentsNavigation();
  const [agent, setAgent] = useState<Provider | "auto">("auto");
  // Work that ships after approval exists only in the task's own sandbox.
  const pushWork = task.delivery === "push";
  const [sandbox, setSandbox] = useState<ReviewSandbox>(pushWork ? "same" : "auto");
  const [brief, setBrief] = useState("");
  // With one agent (Coding agents), it reviews too.
  const onlyAgent = useOverview().data?.defaults.onlyAgent ?? null;
  const other: Provider = onlyAgent ?? (task.provider === "claude" ? "codex" : "claude");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const result = await review.mutate({
        id: task.id,
        provider: agent === "auto" ? null : agent,
        sandbox,
        brief: brief.trim() || null,
      });
      toast.success(
        result.pending ? `Review ${result.task.id} starting` : `Review ${result.task.id} started`,
      );
      onDone();
      openTask(result.task.id);
    } catch (error) {
      showError(error);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Request review</DialogTitle>
        <DialogDescription>
          An independent agent reviews “{task.title}”{task.prUrl ? " and comments on the PR" : ""}, then returns a
          verdict.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Reviewer" htmlFor="ca-review-agent">
          <Select value={agent} onValueChange={(next) => setAgent(next as Provider | "auto")}>
            <SelectTrigger id="ca-review-agent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">
                Auto ({onlyAgent ? `${PROVIDER_LABEL[onlyAgent]}, your only agent` : `usually ${PROVIDER_LABEL[other]}`})
              </SelectItem>
              {(["claude", "codex"] as const)
                .filter((value) => onlyAgent === null || value === onlyAgent)
                .map((value) => (
                  <SelectItem key={value} value={value}>
                    {PROVIDER_LABEL[value]}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Sandbox" htmlFor="ca-review-sandbox">
          <Select value={sandbox} onValueChange={(next) => setSandbox(next as ReviewSandbox)}>
            <SelectTrigger id="ca-review-sandbox">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto" disabled={pushWork}>
                New one if there's room
              </SelectItem>
              <SelectItem value="new" disabled={pushWork}>
                New sandbox
              </SelectItem>
              <SelectItem value="same" disabled={task.sandboxId === null}>
                The task's sandbox
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field label="Brief" htmlFor="ca-review-brief" hint="Leave empty for the default: correctness, regressions, tests, and whether it does what the task asked.">
        <Textarea
          id="ca-review-brief"
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          onKeyDown={submitOnModEnter}
          rows={3}
          placeholder="optional"
        />
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <SubmitButton pending={review.isPending} icon="Eye">
          Request review
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}

// ---------------------------------------------------------------- close task

export function CloseTaskDialog({ task, open, onOpenChange }: DialogControl & { task: TaskDto }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open ? <CloseTaskForm task={task} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function CloseTaskForm({ task, onDone }: { task: TaskDto; onDone: () => void }) {
  const close = experimental_useRpcMutation({ contract: rpcContract, method: "closeTask" });
  const [keepSandbox, setKeepSandbox] = useState(false);
  const cancel = task.status === "running" || task.status === "starting";
  const ownsSandbox = task.sandboxId !== null && task.ownsSandbox;
  // Work that ships after approval lives only in its sandbox until it's shipped.
  // The server checks again on close: work it finds there turns this into a discard.
  const [found, setFound] = useState(false);
  const unshipped = task.unshipped || found;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const result = await close.mutate({ id: task.id, cancel, keepSandbox, discard: unshipped && !keepSandbox });
      const { title, description } = closeToast({ taskId: task.id, cancelled: cancel, sandbox: result.sandbox, keptBecause: result.keptBecause });
      toast.success(title, description ? { description } : undefined);
      onDone();
    } catch (error) {
      if (!unshipped && rpcErrorInfo(error).code === "unshipped_work") {
        setFound(true);
        toast.error("This task has work that hasn't shipped", { description: "Ship it to keep it, or discard it to close." });
        return;
      }
      showError(error);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{cancel ? "Cancel this task?" : "Close this task?"}</DialogTitle>
        <DialogDescription>
          {cancel
            ? `The running turn is interrupted and the task is marked cancelled.${unshipped ? " Work that hasn't shipped is thrown away with the sandbox." : ""}`
            : unshipped
              ? "If this work hasn't shipped, closing throws it away: its commits exist only in the sandbox. To keep it, use Ship instead."
              : `The task is marked done. Its ${task.prUrl ? "PR and report stay" : "report stays"} available here.`}
          {ownsSandbox ? " Its sandbox is deleted unless you keep it or another open task still uses it." : ""}
        </DialogDescription>
      </DialogHeader>
      {ownsSandbox ? (
        <label htmlFor="ca-close-keep" className="flex items-center gap-2 text-sm">
          <Checkbox
            id="ca-close-keep"
            checked={keepSandbox}
            onCheckedChange={(checked) => setKeepSandbox(checked === true)}
          />
          Keep sandbox <span className="font-mono text-xs text-muted-foreground">{task.sandboxId}</span>
        </label>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Keep open
        </Button>
        <SubmitButton pending={close.isPending} variant={cancel || (unshipped && !keepSandbox) ? "destructive" : "default"}>
          {cancel ? "Cancel task" : unshipped && !keepSandbox ? "Discard and close" : "Close task"}
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}

// ---------------------------------------------------------- continue as a chat

type MoveStatus = {
  blocked: { code: string; message: string; hint: string | null } | null;
  untrusted: boolean;
  untrustedRepos: string[];
  otherRepos: string[];
  workersBoat: boolean;
  hasMachine: boolean;
  sandboxStopped: boolean;
  lastFailure: string | null;
};

/** Continue as a chat: what happens, the warning for repos no rule runs as chats, and the confirm. */
export function ContinueAsChatDialog({ task, status, open, onOpenChange }: DialogControl & { task: TaskDto; status: MoveStatus }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open ? <ContinueAsChatForm task={task} status={status} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ContinueAsChatForm({ task, status, onDone }: { task: TaskDto; status: MoveStatus; onDone: () => void }) {
  const navigate = useBbNavigate();
  const mutation = experimental_useRpcMutation({ contract: rpcContract, method: "continueAsChat" });
  const [trusted, setTrusted] = useState(false);
  const agent = PROVIDER_LABEL[task.provider];
  const repos = status.untrustedRepos;
  const ownRepos = repos.filter((repo) => !status.otherRepos.includes(repo));
  const canSubmit = status.blocked === null && (!status.untrusted || trusted);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    try {
      const { task: moved, pending } = await mutation.mutate({ id: task.id, confirmUntrusted: status.untrusted ? repos : null });
      if (pending || moved.threadId === null) {
        toast.success("Moving to a chat", {
          description: status.hasMachine ? "The chat opens in a moment. This page updates when it's open." : "bb is being installed on the sandbox. This page updates when the chat is open.",
        });
      } else {
        const threadId = moved.threadId;
        toast.success("Moved to a chat", { action: { label: "Open chat", onClick: () => navigate.toThread(threadId) } });
      }
      onDone();
    } catch (error) {
      showError(error);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Continue as a chat?</DialogTitle>
        <DialogDescription>
          {agent} keeps working on this task in a bb chat you can open and type into. There's no way back to headless.
        </DialogDescription>
      </DialogHeader>
      <ul className="list-disc space-y-1 pl-4 text-sm text-pretty text-muted-foreground">
        <li>
          {status.hasMachine ? "bb already runs on the task's sandbox." : "bb is installed on the task's sandbox (about a minute)."}
          {status.sandboxStopped ? " The sandbox starts again first." : ""}
        </li>
        <li>
          A {agent} chat opens in the same sandbox, working in the task's checkout, with the brief, the latest report and the messages so far (and which
          tools it used).
        </li>
        <li>
          The headless conversation stops. Follow-ups from this page{task.source.threadId ? " and from the chat that started the task" : ""} go into the
          chat.
        </li>
        <li>
          {task.source.kind === "orchestrator"
            ? "Its first turn reads up and sums up where the task stands. The orchestrator hears that you moved it."
            : "Its first turn reads up and sums up where the task stands; then it's yours."}
        </li>
      </ul>
      {status.blocked ? (
        <InlineAlert tone="warning">
          <RichText text={`${status.blocked.message}${status.blocked.hint ? ` ${status.blocked.hint}` : ""}`} />
        </InlineAlert>
      ) : null}
      {status.blocked === null && status.lastFailure ? (
        <InlineAlert tone="warning">
          <RichText text={`The last try failed: ${status.lastFailure.replace(/^Couldn't continue as a chat: /, "")}`} />
        </InlineAlert>
      ) : null}
      {status.untrusted ? (
        <div className="grid gap-3">
          <InlineAlert tone="warning">
            {status.workersBoat ? (
              <>How tasks run is set to In boat. </>
            ) : ownRepos.length > 0 ? (
              <>
                Your projects don't run tasks on <RepoList repos={ownRepos} /> as chats.{" "}
              </>
            ) : null}
            {status.otherRepos.length > 0 ? (
              <>
                Other tasks ran <RepoList repos={status.otherRepos} /> in this sandbox before
                {status.workersBoat ? "" : `, and your projects don't run tasks on ${status.otherRepos.length === 1 ? "it" : "them"} as chats`}.{" "}
              </>
            ) : null}
            The chat's sandbox can reach your bb, so continue only if you trust{" "}
            {repos.length === 0 ? "this task" : status.workersBoat ? <RepoList repos={repos} /> : repos.length === 1 ? "it" : "them"}.
          </InlineAlert>
          <label htmlFor="ca-move-trust" className="flex items-start gap-2 text-sm">
            <Checkbox id="ca-move-trust" className="mt-0.5" checked={trusted} onCheckedChange={(checked) => setTrusted(checked === true)} />
            <span className="min-w-0 text-pretty">
              {repos.length === 0 ? (
                "I trust this task"
              ) : (
                <>
                  I trust <RepoList repos={repos} />
                </>
              )}
            </span>
          </label>
        </div>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <SubmitButton pending={mutation.isPending} disabled={!canSubmit} icon="MessageSquare">
          Continue as a chat
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}

/** Repos as code, joined with commas and "and". */
function RepoList({ repos }: { repos: readonly string[] }) {
  return (
    <>
      {repos.map((repo, index) => (
        <span key={repo}>
          {index > 0 ? (index === repos.length - 1 ? " and " : ", ") : ""}
          <code className="font-mono text-xs break-words">{repo}</code>
        </span>
      ))}
    </>
  );
}

// ------------------------------------------------------------------- confirm

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pending = false,
  destructive = false,
  onConfirm,
}: DialogControl & {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  pending?: boolean;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? <Icon name="Loading" className="animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
