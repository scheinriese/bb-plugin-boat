// Settings → Plugins → Boat Cloud Agents → Projects: repos you trust, with
// the environment their tasks start in, how work lands, protected branches
// and instructions; orchestrators work on one project each.
//
// bb renders this below the plugin's settings form, outside the Cloud agents
// page, so it only relies on the RPC hooks and its own dialogs.
import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { experimental_useRpcMutation, experimental_useRpcQuery, useSettings } from "@get-bb/plugin-sdk/app";
import { rpcContract, type ProjectDto } from "../contract";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "./dialogs";
import { environmentLabel, errorMessage, plural, repoAtBase, shortRepo } from "./format";
import { useProjects } from "./hooks";
import { Disclosure, EmptyBox, Field, IconButton, InlineAlert, ListPanel, SUGGEST_INPUT, showError } from "./ui";

/** The contract allows up to 8 repos per project. */
const MAX_REPOS = 8;

/** "new" opens an empty editor; a project opens it filled in. */
type Editing = ProjectDto | "new" | null;

type WorkerMode = ProjectDto["workerMode"];

type Delivery = ProjectDto["delivery"];

const DELIVERY_LABEL: Record<Delivery, string> = {
  pr: "Draft pull requests",
  push: "Ship to the base branch after I approve",
};

/** A repo to start a new project from, e.g. one typed in the New task dialog. */
interface ProjectDraft {
  repo: string;
  baseBranch: string;
}

export function ProjectsSettings() {
  const { data, error } = useProjects();
  const [editing, setEditing] = useState<Editing>(null);
  const projects = data?.projects ?? [];

  return (
    <div className="space-y-3">
      <div className="flex min-h-8 items-center gap-2">
        <p className="text-xs tabular-nums text-muted-foreground">
          {data ? plural(projects.length, "project") : null}
        </p>
        <Button variant="outline" size="sm" className="ml-auto h-7" onClick={() => setEditing("new")}>
          <Icon name="Plus" /> Add project
        </Button>
      </div>
      {error ? <InlineAlert>{error.message}</InlineAlert> : null}
      {data === undefined && !error ? (
        <EmptyBox>Loading projects…</EmptyBox>
      ) : projects.length === 0 && !error ? (
        <EmptyBox>
          <span className="block font-medium text-foreground">Add your first project</span>
          <span className="mt-1 block text-xs">
            Repos you trust: tasks on them get the project's environment and rules. Use Add project, or run{" "}
            <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[11px]">
              bb boat project add --name "Web app" --repo acme/web@main
            </code>
            .
          </span>
        </EmptyBox>
      ) : projects.length > 0 ? (
        <ListPanel label="Projects">
          {projects.map((project) => (
            <ProjectRow key={project.id} project={project} onEdit={() => setEditing(project)} />
          ))}
        </ListPanel>
      ) : null}
      <ProjectDialog
        editing={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      />
    </div>
  );
}

function ProjectRow({ project, onEdit }: { project: ProjectDto; onEdit: () => void }) {
  const remove = experimental_useRpcMutation({ contract: rpcContract, method: "deleteProject" });
  const [confirming, setConfirming] = useState(false);

  const runDelete = async () => {
    try {
      await remove.mutate({ id: project.id });
      toast.success(`Deleted ${project.name}`);
      setConfirming(false);
    } catch (error) {
      showError(error);
    }
  };

  return (
    <li className="flex items-start gap-3 px-4 py-2.5">
      <Icon name="FolderGit" className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium text-foreground">{project.name}</span>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{project.id}</span>
        </div>
        <ul
          aria-label="Repos"
          className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-xs text-muted-foreground"
        >
          {project.repos.map((entry, index) => (
            <li key={entry.repo} className="min-w-0 break-all">
              {repoAtBase(entry)}
              {index === 0 && project.repos.length > 1 ? (
                <span className="ml-1 font-sans">(main)</span>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{environmentLabel(project.environment)}</span>
          {project.snapshot ? (
            <span>
              snapshot <span className="font-mono">{project.snapshot}</span>
            </span>
          ) : null}
          {project.protocolPath ? (
            <span className="inline-flex min-w-0 max-w-full items-center gap-1">
              <Icon name="FileText" className="size-3.5 shrink-0" aria-label="Protocol file" />
              <span className="truncate font-mono">{project.protocolPath}</span>
            </span>
          ) : null}
          {project.workerMode === "boat" ? <span title="Its tasks always run headless in boat, with no access to your bb">tasks in boat only</span> : null}
          {project.delivery === "push" ? (
            <span title="No pull requests: tasks commit, and you ship approved work to the base branch">ships after approval</span>
          ) : null}
          {project.protectedBranches.length > 0 ? (
            <span title="No task may push to these, on top of the base branches">
              protects <span className="font-mono">{project.protectedBranches.join(", ")}</span>
            </span>
          ) : null}
          {project.instructions.trim() !== "" ? <span title={project.instructions}>has instructions</span> : null}
        </div>
        <ProjectAccessLine projectId={project.id} />
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton label={`Edit ${project.name}`} icon="Edit" onClick={onEdit} />
        <IconButton label={`Delete ${project.name}`} icon="Trash2" onClick={() => setConfirming(true)} />
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${project.name}?`}
        description="New tasks and orchestrators can't pick it any more. Orchestrators already working on it keep their settings, and no repo or sandbox is touched."
        confirmLabel="Delete project"
        destructive
        pending={remove.isPending}
        onConfirm={() => void runDelete()}
      />
    </li>
  );
}

// -------------------------------------------------------------------- editor

function ProjectDialog({ editing, onOpenChange }: { editing: Editing; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={editing !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        {editing !== null ? (
          <ProjectForm project={editing === "new" ? null : editing} onDone={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** The new-project editor on its own, started from a repo (the New task dialog's "Add as project"). */
export function NewProjectDialog({
  open,
  onOpenChange,
  onSaved,
  ...draft
}: ProjectDraft & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (project: ProjectDto) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        {open ? (
          <ProjectForm project={null} draft={draft} onSaved={onSaved} onDone={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

interface RepoRow {
  /** Stable React key; rows can be removed from the middle. */
  key: number;
  repo: string;
  baseBranch: string;
}

function ProjectForm({
  project,
  draft,
  onSaved,
  onDone,
}: {
  project: ProjectDto | null;
  draft?: ProjectDraft;
  onSaved?: (project: ProjectDto) => void;
  onDone: () => void;
}) {
  const save = experimental_useRpcMutation({ contract: rpcContract, method: "saveProject" });
  const nextKey = useRef(0);
  // A new repo starts on main (a real value, not a placeholder): edit it for another base.
  const makeRow = (repo = "", baseBranch = ""): RepoRow => ({ key: nextKey.current++, repo, baseBranch: baseBranch || "main" });

  const [name, setName] = useState(project?.name ?? (draft ? (shortRepo(draft.repo).split("/").pop() ?? "") : ""));
  const [repos, setRepos] = useState<RepoRow[]>(() =>
    project && project.repos.length > 0
      ? project.repos.map((entry) => makeRow(entry.repo, entry.baseBranch))
      : [makeRow(draft?.repo, draft?.baseBranch)],
  );
  const [environment, setEnvironment] = useState(project?.environment ?? "");
  const [snapshot, setSnapshot] = useState(project?.snapshot ?? "");
  const [protocolPath, setProtocolPath] = useState(project?.protocolPath ?? "");
  const [workerMode, setWorkerMode] = useState<WorkerMode>(project?.workerMode ?? "chat");
  const [delivery, setDelivery] = useState<Delivery>(project?.delivery ?? "pr");
  const [protectedText, setProtectedText] = useState((project?.protectedBranches ?? []).join(", "));
  const [instructions, setInstructions] = useState(project?.instructions ?? "");
  const workers = useSettings().values?.workers;
  const snapshots = experimental_useRpcQuery({ contract: rpcContract, method: "snapshots", input: null });
  const [failure, setFailure] = useState<string | null>(null);

  // What's still empty, said next to the disabled button.
  const missing = [
    name.trim() === "" ? "a name" : null,
    repos.some((row) => row.repo.trim() === "") ? "a repo" : null,
    repos.some((row) => row.baseBranch.trim() === "") ? "a base branch" : null,
  ].filter((part): part is string => part !== null);
  const canSubmit = missing.length === 0;

  const updateRow = (key: number, patch: Partial<Omit<RepoRow, "key">>) =>
    setRepos((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  // Rows mount and unmount under the pointer: move focus to the row that's left to edit.
  const focusRow = (key: number | undefined) => {
    if (key !== undefined) setTimeout(() => document.getElementById(`ca-project-repo-${key}`)?.focus(), 0);
  };
  const addRow = () => {
    const row = makeRow();
    setRepos((rows) => [...rows, row]);
    focusRow(row.key);
  };
  const removeRow = (index: number) => {
    const remaining = repos.filter((_, position) => position !== index);
    setRepos(remaining);
    focusRow(remaining[Math.max(0, index - 1)]?.key);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Opened from another dialog's form (the New task dialog), React still bubbles
    // this portaled form's submit up to that form.
    event.stopPropagation();
    if (!canSubmit) return;
    setFailure(null);
    try {
      const { project: saved } = await save.mutate({
        ...(project ? { id: project.id } : {}),
        name: name.trim(),
        repos: repos.map((row) => ({ repo: row.repo.trim(), baseBranch: row.baseBranch.trim() })),
        environment: environment.trim() || null,
        snapshot: snapshot.trim() || null,
        protocolPath: protocolPath.trim() || null,
        workerMode,
        delivery,
        protectedBranches: protectedText,
        instructions: instructions.trim(),
      });
      toast.success(project ? `Saved ${saved.name}` : `Added ${saved.name}`);
      onSaved?.(saved);
      onDone();
    } catch (error) {
      setFailure(errorMessage(error));
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{project ? `Edit ${project.name}` : "New project"}</DialogTitle>
        <DialogDescription>
          Tasks on this project clone these repos from GitHub, so push local changes first.
        </DialogDescription>
      </DialogHeader>
      <Field label="Name" htmlFor="ca-project-name">
        <Input
          id="ca-project-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Web app"
          maxLength={80}
          required
          autoFocus
        />
      </Field>
      <fieldset className="grid gap-3">
        <legend className="sr-only">Repos</legend>
        {repos.map((row, index) => {
          const label = index === 0 ? "Main repo" : `Repo ${index + 1}`;
          return (
            <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,9rem)_auto] items-end gap-2">
              <Field label={label} htmlFor={`ca-project-repo-${row.key}`}>
                <Input
                  id={`ca-project-repo-${row.key}`}
                  value={row.repo}
                  onChange={(event) => updateRow(row.key, { repo: event.target.value })}
                  placeholder="owner/name or GitHub URL"
                  required
                />
              </Field>
              <Field label="Base branch" htmlFor={`ca-project-base-${row.key}`}>
                <Input
                  id={`ca-project-base-${row.key}`}
                  value={row.baseBranch}
                  onChange={(event) => updateRow(row.key, { baseBranch: event.target.value })}
                  aria-label={`${label} base branch`}
                  required
                />
              </Field>
              <IconButton
                label={`Remove ${label.toLowerCase()}`}
                icon="X"
                className="size-9"
                disabled={repos.length === 1}
                onClick={() => removeRow(index)}
              />
            </div>
          );
        })}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-muted-foreground"
            disabled={repos.length >= MAX_REPOS}
            onClick={addRow}
          >
            <Icon name="Plus" /> Add repo
          </Button>
          <p className="text-xs text-muted-foreground">
            Branches, PRs and the protocol file live in the main repo; the others are cloned next to it.
          </p>
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Environment"
          htmlFor="ca-project-environment"
          hint={
            <>
              The boat environment its tasks start in (
              <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[11px]">boat new --environment</code>
              ).
            </>
          }
        >
          <Input
            id="ca-project-environment"
            value={environment}
            onChange={(event) => setEnvironment(event.target.value)}
            placeholder="Empty: boat's default"
            maxLength={80}
          />
        </Field>
        <Field
          label="Snapshot"
          htmlFor="ca-project-snapshot"
          hint={
            snapshots.data?.error
              ? "A saved boat snapshot its tasks start from. Couldn't list yours."
              : (
                  <>
                    A saved boat snapshot its tasks start from (Save as snapshot on a finished repo check, or{" "}
                    <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[11px]">bb boat sandbox snapshot</code>); not on the trial.
                  </>
                )
          }
        >
          <Input
            id="ca-project-snapshot"
            value={snapshot}
            onChange={(event) => setSnapshot(event.target.value)}
            placeholder="optional"
            maxLength={120}
            list="ca-project-snapshot-names"
            className={SUGGEST_INPUT}
            autoComplete="off"
          />
          <datalist id="ca-project-snapshot-names">
            {(snapshots.data?.snapshots ?? []).map((entry) => (
              <option key={entry.name} value={entry.name} />
            ))}
          </datalist>
        </Field>
      </div>
      <label htmlFor="ca-project-chats" className="flex items-start gap-2 text-sm">
        <Checkbox
          id="ca-project-chats"
          className="mt-0.5"
          checked={workerMode === "chat"}
          onCheckedChange={(checked) => setWorkerMode(checked === true ? "chat" : "boat")}
        />
        <span className="min-w-0">
          Run tasks as chats
          <span className="block text-xs text-pretty text-muted-foreground">
            {workers === "projects" || workers === "all"
              ? "Each task is a bb chat you can open and type into (needs bb Connect). Its sandbox can reach your bb, so keep this for repos you trust. Off: tasks run headless in boat."
              : "Only matters when How tasks run is set to As chats for projects or As chats everywhere; now every task runs headless in boat."}
          </span>
        </span>
      </label>
      <Field
        label="How work lands"
        htmlFor="ca-project-delivery"
        hint={
          delivery === "push"
            ? "Tasks only commit; you look at their preview and ship it with one click (or tell the orchestrator). Nothing reaches the base branch without you."
            : "Each task pushes its own branch and opens a draft pull request."
        }
      >
        <Select value={delivery} onValueChange={(next) => setDelivery(next as Delivery)}>
          <SelectTrigger id="ca-project-delivery">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(DELIVERY_LABEL) as Delivery[]).map((value) => (
              <SelectItem key={value} value={value}>
                {DELIVERY_LABEL[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Disclosure label="Protected branches, instructions and rules file" defaultOpen={protectedText !== "" || instructions !== "" || protocolPath !== ""}>
        <div className="grid gap-4">
          <Field
            label="Protected branches"
            htmlFor="ca-project-protected"
            hint="Comma-separated, e.g. release, develop. No task may push to them, on top of main, master and the base branches above."
          >
            <Input
              id="ca-project-protected"
              value={protectedText}
              onChange={(event) => setProtectedText(event.target.value)}
              maxLength={2000}
              spellCheck={false}
            />
          </Field>
          <Field
            label="Instructions for its tasks"
            htmlFor="ca-project-instructions"
            hint="Added to every task's brief on this project, after Instructions for every task. For example: how to run the tests, house rules."
          >
            <Textarea
              id="ca-project-instructions"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              rows={4}
              maxLength={10_000}
              className="min-h-20 resize-y text-sm"
            />
          </Field>
          <Field
            label="Orchestrator rules file"
            htmlFor="ca-project-protocol"
            hint="Repo-specific rules an orchestrator reads after the shared protocol, in the main repo, e.g. docs/agents/orchestrator.md."
          >
            <Input
              id="ca-project-protocol"
              value={protocolPath}
              onChange={(event) => setProtocolPath(event.target.value)}
              placeholder="optional"
              maxLength={300}
            />
          </Field>
        </div>
      </Disclosure>
      {failure ? <InlineAlert>{failure}</InlineAlert> : null}
      <DialogFooter>
        {missing.length > 0 ? (
          <p className="self-center text-xs text-muted-foreground sm:mr-auto">
            Needs {missing.length > 1 ? `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}` : missing[0]}.
          </p>
        ) : null}
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending || !canSubmit}>
          {save.isPending ? <Icon name="Loading" className="animate-spin" /> : null}
          {project ? "Save project" : "Add project"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * What the project's tasks can reach: boat's GitHub access per repo and the
 * environment's secret NAMES (the plugin never reads values into the UI).
 */
function ProjectAccessLine({ projectId }: { projectId: string }) {
  const { data, error } = experimental_useRpcQuery({ contract: rpcContract, method: "projectAccess", input: { projectId } });
  if (error) return <p className="text-xs text-warning-text">{error.message}</p>;
  if (data === undefined) return null;
  const secrets = data.secretNames;
  return (
    <div className="space-y-0.5 text-xs text-muted-foreground">
      {data.error ? (
        <p className="text-warning-text">Couldn't read the environment: {data.error}</p>
      ) : (
        <p className="text-pretty">
          <span className="sr-only">Environment secrets: </span>
          {secrets.length === 0 ? "No secrets" : `${secrets.length} secret${secrets.length === 1 ? "" : "s"}: `}
          {secrets.length > 0 ? <span className="font-mono">{secrets.join(", ")}</span> : null}
          {data.secretFiles.length > 0 ? <span> · files <span className="font-mono">{data.secretFiles.join(", ")}</span></span> : null}
          {data.passSecrets === false ? <span className="text-warning-text"> · secrets aren't passed in</span> : null}
          {data.passGithub === false ? <span className="text-warning-text"> · GitHub access isn't passed in</span> : null}
        </p>
      )}
      <ul aria-label="GitHub access" className="flex flex-wrap gap-x-3 gap-y-0.5">
        {data.repos.map((repo) => {
          const check = repo.lastCheck?.access ?? null;
          const tone = check === "none" || check === "expired" || check === "read" ? "text-warning-text" : undefined;
          const label =
            check === "write"
              ? "can push"
              : check === "read"
                ? "read only"
                : check === "none"
                  ? "no access: connect GitHub on boat.dev → Environment and give boat access to it"
                  : check === "expired"
                    ? "GitHub login expired last time"
                    : repo.environmentPermission
                      ? `${repo.environmentPermission} (not checked in a sandbox yet)`
                      : "not checked yet";
          return (
            <li key={repo.repo} className={tone} title={repo.lastCheck?.detail ?? undefined}>
              <span className="font-mono">{repo.repo}</span>: {label}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
