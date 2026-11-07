import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  experimental_useRpcMutation,
  experimental_useRpcQuery,
  experimental_useSidebarThreads,
  UrlLink,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { rpcContract, type ProjectDto } from "../contract";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../components/ui/dialog";
import { Icon } from "../components/ui/icon";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import { AgentLogo, Disclosure, InlineAlert, ThreadName, Switch } from "./ui";
import {
  useOrchestrators,
  useOverview,
  useProjects,
  useSandboxSizes,
  useSettingRows,
  useTask,
} from "./hooks";
import { ConfirmDialog, SaveSnapshotDialog } from "./dialogs";
import "./projects.css";

import {
  readProjectEditorSession,
  retainProjectEditorDraft,
  type EditorDraft,
  type ProjectEditing,
} from "./project-editor-session";
export type { ProjectEditing } from "./project-editor-session";
export interface ProjectSurfaceProps {
  editing: ProjectEditing;
  onEditingChange(value: ProjectEditing): void;
  editorTarget: HTMLElement | null;
  docked: boolean;
}
const ACTION =
  "h-[26px] rounded-md border-[color:var(--boat-action-border)] px-2.5 py-1 text-xs leading-4 dark:text-[#D0D0D0]";
const FIELD =
  "h-8 rounded-md border-[color:var(--project-input-border)] bg-[color:var(--project-input)] px-2.5 text-base leading-[18px] text-[color:var(--boat-content)] shadow-none sm:text-[13px]";
export function snapshotUpdated(
  at: string | null | undefined,
  now = Date.now(),
): string | null {
  if (!at || !Number.isFinite(Date.parse(at))) return null;
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  const days = Math.max(
    0,
    Math.round((day.getTime() - date.getTime()) / 86400000),
  );
  return days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}
function repositoryUpdated(at: string): string | null {
  const label = snapshotUpdated(at);
  const match = label?.match(/^(\d+) days ago$/);
  return match && Number(match[1]) >= 7 && Number(match[1]) < 14
    ? "last week"
    : label;
}
function useSnapshots() {
  return experimental_useRpcQuery({
    contract: rpcContract,
    method: "snapshots",
    input: null,
  });
}
function useProjectDefaults() {
  const overview = useOverview();
  const rows = useSettingRows();
  const reviewer =
    rows.data?.settings.find((row) => row.key === "reviewProvider")?.value ===
    "claude"
      ? "claude"
      : "codex";
  const automatic =
    rows.data?.settings.find((row) => row.key === "autoReview")?.value !==
    false;
  return {
    size: overview.data?.defaults.machineType ?? "default",
    reviewer: automatic ? reviewer : "none",
  } as const;
}
export function ProjectsSurface({
  editing,
  onEditingChange,
  editorTarget,
  docked,
}: ProjectSurfaceProps) {
  const projects = useProjects();
  const snapshots = useSnapshots();
  const orchestrators = useOrchestrators();
  const { threads } = experimental_useSidebarThreads();
  const defaults = useProjectDefaults();
  const navigate = useBbNavigate();
  // The editor may move between our dock and the native responsive Dialog.
  // Keep its committed draft outside either mount so resizing cannot discard it.
  const editorDraft = useRef<{ key: string; value: EditorDraft } | null>(null);
  const editorKey = editing === "new" ? "new" : (editing?.id ?? "");
  const closeEditor = () => {
    editorDraft.current = null;
    onEditingChange(null);
  };
  const editor =
    editing === null ? null : (
      <ProjectEditor
        key={editing === "new" ? "new" : editing.id}
        project={
          editing === "new"
            ? null
            : (projects.data?.projects.find((item) => item.id === editing.id) ??
              editing)
        }
        onDone={closeEditor}
        initialState={
          editorDraft.current?.key === editorKey
            ? editorDraft.current.value
            : readProjectEditorSession().draft?.key === editorKey
              ? readProjectEditorSession().draft?.value
              : undefined
        }
        onDraftChange={(value) => {
          editorDraft.current = { key: editorKey, value };
          retainProjectEditorDraft(editorKey, value);
        }}
        docked={docked}
      />
    );
  return (
    <div className="boat-projects space-y-[14px] pb-10">
      {projects.error && <InlineAlert>{projects.error.message}</InlineAlert>}
      {projects.data?.projects.length === 0 ? (
        <div className="mt-1 rounded-xl border border-dashed border-[color:var(--project-input-border)] px-7 py-7">
          <h2 className="text-[15px] font-semibold leading-[22px] text-[color:var(--boat-heading)]">
            No projects yet
          </h2>
          <p className="mt-[14px] max-w-[560px] text-[13px] leading-5 text-[color:var(--project-secondary)]">
            A project is a repo with its rules. It gets a section in the sidebar
            and can have one orchestrator that plans the work and gets each
            change reviewed.
          </p>
          <div className="mt-[14px] flex flex-wrap items-center gap-2">
            <Button
              type="button"
              className={cn(
                ACTION,
                "px-3 bg-primary text-primary-foreground dark:text-primary-foreground",
              )}
              onClick={() => onEditingChange("new")}
            >
              Add project
            </Button>
            <span className="text-xs leading-4 text-muted-foreground">
              One-off tasks work without a project: ask any chat to use a cloud
              agent.
            </span>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center">
            <p className="min-w-0 flex-1 text-[13px] leading-5 text-muted-foreground">
              {projects.data
                ? `${projects.data.projects.length} ${projects.data.projects.length === 1 ? "project" : "projects"}. `
                : ""}
              A project is a repo with its rules; each one gets a section in the
              sidebar and one orchestrator.
            </p>
            <Button
              type="button"
              variant="outline"
              className={cn(ACTION, "shrink-0")}
              onClick={() => onEditingChange("new")}
            >
              New project
            </Button>
          </div>
          {projects.data?.projects.map((project) => {
            const orchestrator = orchestrators.data?.orchestrators.find(
              (item) => item.projectId === project.id && !item.archived,
            );
            const providerId = threads.find(
              (thread) => thread.id === orchestrator?.threadId,
            )?.providerId;
            const provider = providerId?.includes("codex")
              ? "codex"
              : providerId?.includes("claude")
                ? "claude"
                : null;
            const snapshot = snapshots.data?.snapshots.find(
              (item) => item.name === project.snapshot,
            );
            const updated = snapshotUpdated(snapshot?.createdAt);
            const reviewer = project.reviewer ?? defaults.reviewer;
            return (
              <article
                key={project.id}
                className={cn(
                  "rounded-[10px] border border-border bg-card px-[18px] py-4",
                  editing !== "new" &&
                    editing?.id === project.id &&
                    "border-[color:var(--project-selected-border)]",
                )}
              >
                <div className="mb-3 flex min-h-[26px] items-center gap-2.5">
                  <h2 className="text-[15px] font-semibold leading-[22px] text-[color:var(--boat-heading)]">
                    {project.name}
                  </h2>
                  {orchestrator && (
                    <button
                      type="button"
                      onClick={() => navigate.toThread(orchestrator.threadId)}
                      className="inline-flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground hover:underline"
                    >
                      {provider && (
                        <AgentLogo provider={provider} className="size-3" />
                      )}
                      <span className="truncate">
                        <ThreadName
                          threadId={orchestrator.threadId}
                          fallback={orchestrator.title}
                        />
                      </span>
                    </button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    className={cn(ACTION, "ml-auto")}
                    onClick={() => onEditingChange(project)}
                  >
                    {editing !== "new" && editing?.id === project.id
                      ? "Editing"
                      : "Edit"}
                  </Button>
                </div>
                <dl className="grid grid-cols-[130px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px] leading-5 text-[color:var(--project-text)] max-sm:grid-cols-[94px_minmax(0,1fr)]">
                  <CardLabel>Repos</CardLabel>
                  <dd>
                    {project.repos.map((repo, i) => (
                      <span key={repo.repo}>
                        {i > 0 && " · "}
                        {repo.repo}{" "}
                        <span className="text-[color:var(--boat-faint)]">
                          · base {repo.baseBranch}
                        </span>
                      </span>
                    ))}
                  </dd>
                  <CardLabel>Work lands</CardLabel>
                  <dd>
                    {project.delivery === "push"
                      ? `Ships to ${project.repos[0]?.baseBranch ?? "main"} after your OK`
                      : "Pull requests"}
                  </dd>
                  <CardLabel>Sandbox</CardLabel>
                  <dd>
                    {sizeLabel(project.machineType ?? defaults.size)} size ·{" "}
                    {reviewer === "none"
                      ? "No review"
                      : `${reviewer === "claude" ? "Claude" : "Codex"} reviews`}
                  </dd>
                  <CardLabel>Snapshot</CardLabel>
                  <dd>
                    {project.snapshot && snapshot ? (
                      <>
                        <span
                          className={
                            snapshot.status === "ready"
                              ? "text-[color:var(--project-success)]"
                              : undefined
                          }
                        >
                          {snapshot.status === "ready"
                            ? "Ready"
                            : snapshot.status
                              ? `Snapshot ${snapshot.status}`
                              : project.snapshot}
                        </span>
                        {updated && (
                          <span className="text-[color:var(--boat-faint)]">
                            {" "}
                            · updated {updated}
                          </span>
                        )}
                      </>
                    ) : project.snapshot ? (
                      <span>
                        {snapshots.error || snapshots.data?.error
                          ? "Couldn't check snapshot"
                          : snapshots.data
                            ? "Snapshot not found"
                            : "Checking snapshot…"}
                      </span>
                    ) : (
                      <>
                        None yet ·{" "}
                        <button
                          type="button"
                          className="text-[color:var(--project-link)] hover:underline"
                          onClick={() => onEditingChange(project)}
                        >
                          make one
                        </button>{" "}
                        <span className="text-[color:var(--boat-faint)]">
                          (sandboxes start in ~20 s instead of ~3 min)
                        </span>
                      </>
                    )}
                  </dd>
                  <CardLabel>Orchestrator rules</CardLabel>
                  <dd>
                    {project.protocolPath ? (
                      <UrlLink
                        className="break-all text-[color:var(--project-link)] hover:underline"
                        href={`https://github.com/${project.repos[0]!.repo}/blob/${encodeURIComponent(project.repos[0]!.baseBranch)}/${project.protocolPath.split("/").map(encodeURIComponent).join("/")}`}
                      >
                        {project.protocolPath}
                      </UrlLink>
                    ) : (
                      <span className="text-[color:var(--boat-faint)]">—</span>
                    )}
                  </dd>
                </dl>
              </article>
            );
          })}
        </>
      )}
      {docked ? (
        editorTarget && editor && createPortal(editor, editorTarget)
      ) : (
        <Dialog
          open={editing !== null}
          onOpenChange={(open) => {
            if (!open) closeEditor();
          }}
        >
          <DialogContent
            hideCloseButton
            className="boat-projects max-h-[92dvh] overflow-hidden w-full p-0 md:max-w-[440px]"
          >
            {editor}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
function CardLabel({ children }: { children: ReactNode }) {
  return (
    <dt className="text-xs leading-5 text-[color:var(--boat-faint)]">
      {children}
    </dt>
  );
}
function sizeLabel(size: string) {
  return size[0]!.toUpperCase() + size.slice(1);
}
function FieldGroup({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <fieldset className="min-w-0 space-y-1.5">
      <legend className="mb-1.5 text-[13px] font-medium leading-[18px] text-[color:var(--boat-content)]">
        {label}
      </legend>
      {children}
      {hint && (
        <p className="text-xs leading-4 text-[color:var(--boat-faint)]">
          {hint}
        </p>
      )}
    </fieldset>
  );
}
function Segments<T extends string>({
  name,
  value,
  onChange,
  options,
  roomy = false,
}: {
  name: string;
  value: T;
  onChange(value: T): void;
  roomy?: boolean;
  options: {
    value: T;
    label: string;
    hint?: string;
    orange?: boolean;
    disabled?: boolean;
    reason?: string | null;
  }[];
}) {
  return (
    <div
      className={cn(
        "flex gap-0.5 rounded-lg border border-[color:var(--project-input-border)] bg-[color:var(--project-input)] p-0.5",
        roomy && "border-[color:var(--boat-setting-border)] p-[3px]",
      )}
    >
      {options.map((option) => (
        <label
          key={option.value}
          className={cn(
            "relative flex min-w-0 flex-1 flex-col gap-px rounded-md px-2.5 py-1.5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
            roomy && "py-[7px]",
            value === option.value && "bg-[color:var(--project-selected)]",
            option.disabled && "opacity-50",
          )}
          title={option.reason ?? undefined}
        >
          <input
            className="sr-only"
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={option.disabled}
            onChange={() => onChange(option.value)}
            onClick={() => onChange(option.value)}
          />
          <span
            className={cn(
              "text-[13px] leading-[18px] text-[color:var(--project-secondary)]",
              value === option.value && "text-[color:var(--boat-heading)]",
            )}
          >
            {option.label}
          </span>
          {option.hint && (
            <span
              className={cn(
                "text-[11px] leading-[14px] text-muted-foreground",
                option.orange && "text-[color:var(--project-cost)]",
              )}
            >
              {option.hint}
            </span>
          )}
        </label>
      ))}
    </div>
  );
}
function projectName(repo: string) {
  return (
    repo
      .split("/")
      .at(-1)
      ?.replace(
        /(^|-)(\w)/g,
        (_, p, c) => `${p ? " " : ""}${c.toUpperCase()}`,
      ) ?? ""
  );
}
export function ProjectEditor({
  project,
  onDone,
  docked = false,
  draft,
  onSaved,
  initialState,
  onDraftChange,
}: {
  project: ProjectDto | null;
  initialState?: EditorDraft;
  onDraftChange?(value: EditorDraft): void;
  onDone(): void;
  docked?: boolean;
  draft?: { repo: string; baseBranch: string };
  onSaved?(project: ProjectDto): void;
}) {
  const defaults = useProjectDefaults();
  const sizes = useSandboxSizes();
  const save = experimental_useRpcMutation({
    contract: rpcContract,
    method: "saveProject",
  });
  const catalog = experimental_useRpcQuery({
    contract: rpcContract,
    method: "projectCatalog",
    input: null,
    enabled: !project,
  });
  const [name, setName] = useState(
    initialState?.name ?? project?.name ?? projectName(draft?.repo ?? ""),
  );
  const [selectedRepo, setSelectedRepo] = useState(
    initialState?.selectedRepo ?? draft?.repo ?? "",
  );
  const [query, setQuery] = useState(initialState?.query ?? "");
  const [base, setBase] = useState(
    initialState?.base ?? (draft?.baseBranch || "main"),
  );
  const [useLocal, setUseLocal] = useState(initialState?.useLocal ?? true);
  const [repoLines, setRepoLines] = useState(
    initialState?.repoLines ??
      project?.repos.map((repo) => `${repo.repo} · base ${repo.baseBranch}`) ??
      [],
  );
  const [delivery, setDelivery] = useState(
    initialState?.delivery ?? project?.delivery ?? "pr",
  );
  const [size, setSize] = useState(
    initialState ? initialState.size : (project?.machineType ?? null),
  );
  const [reviewer, setReviewer] = useState(
    initialState ? initialState.reviewer : (project?.reviewer ?? null),
  );
  const [protectedText, setProtected] = useState(
    initialState?.protectedText ?? project?.protectedBranches.join(", ") ?? "",
  );
  const [rules, setRules] = useState(
    initialState?.rules ?? project?.protocolPath ?? "",
  );
  const [instructions, setInstructions] = useState(
    initialState?.instructions ?? project?.instructions ?? "",
  );
  const [environment, setEnvironment] = useState(
    initialState?.environment ?? project?.environment ?? "",
  );
  const [workerMode, setWorkerMode] = useState(
    initialState?.workerMode ?? project?.workerMode ?? "chat",
  );
  const [snapshot, setSnapshot] = useState(
    initialState?.snapshot ?? project?.snapshot ?? "",
  );
  const [failure, setFailure] = useState<string | null>(null);
  useLayoutEffect(() => {
    onDraftChange?.({
      name,
      selectedRepo,
      query,
      base,
      useLocal,
      repoLines,
      delivery,
      size,
      reviewer,
      protectedText,
      rules,
      instructions,
      environment,
      workerMode,
      snapshot,
    });
  });
  const local = catalog.data?.local.find(
    (item) => item.repo.toLowerCase() === selectedRepo.toLowerCase(),
  );
  function choose(repo: string, branch: string | null) {
    setSelectedRepo(repo);
    setBase(
      catalog.data?.local.find(
        (item) => item.repo.toLowerCase() === repo.toLowerCase(),
      )?.branch ||
        branch ||
        "main",
    );
    setName(projectName(repo));
    setUseLocal(true);
  }
  useEffect(() => {
    if (!project && !selectedRepo && catalog.data?.repos[0])
      choose(catalog.data.repos[0].repo, catalog.data.repos[0].baseBranch);
  }, [catalog.data, project, selectedRepo]);
  const parseLine = (line: string) => {
    const match = line.match(/^(.*?)\s+·\s+base\s+(.*)$/);
    return {
      repo: (match?.[1] ?? line).trim(),
      baseBranch: (match?.[2] ?? "main").trim(),
    };
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    setFailure(null);
    const repos = project
      ? repoLines.map(parseLine)
      : [{ repo: selectedRepo, baseBranch: base }];
    if (!name.trim() || repos.some((repo) => !repo.repo || !repo.baseBranch)) {
      setFailure(
        "Choose a repository and base branch, and give the project a name.",
      );
      return;
    }
    try {
      const result = await save.mutate({
        ...(project ? { id: project.id } : {}),
        name: name.trim(),
        repos,
        delivery,
        machineType: size,
        reviewer,
        protectedBranches: protectedText,
        instructions: instructions.trim(),
        protocolPath: rules.trim() || null,
        environment: environment.trim() || null,
        workerMode,
        snapshot: snapshot.trim() || null,
        localBbProjectId: project
          ? (project.localBbProjectId ?? null)
          : useLocal
            ? (local?.id ?? null)
            : null,
      });
      toast.success(
        project
          ? `Saved ${result.project.name}`
          : `Added ${result.project.name}`,
      );
      onSaved?.(result.project);
      onDone();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  }
  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="boat-ui boat-projects flex max-h-[92dvh] min-h-0 flex-col bg-[color:var(--project-editor)] text-[13px] docked-project-form"
      data-docked={docked}
      data-new={!project}
    >
      <header className="flex shrink-0 items-center gap-2.5 border-b border-[color:var(--boat-setting-border)] px-5 py-4">
        {docked ? (
          <h2 className="flex-1 text-[15px] font-semibold leading-[22px] text-[color:var(--boat-heading)]">
            {project ? `Edit ${project.name}` : "Add project"}
          </h2>
        ) : (
          <>
            <DialogTitle className="flex-1 text-[15px] leading-[22px]">
              {project ? `Edit ${project.name}` : "Add project"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Choose the repos, sandbox and rules for this project.
            </DialogDescription>
          </>
        )}
        <button
          type="button"
          aria-label="Close project editor"
          onClick={onDone}
          className="relative flex h-[22px] w-3 shrink-0 items-center justify-center rounded text-muted-foreground after:absolute after:-inset-2 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
        >
          <span aria-hidden className="text-[14px] leading-[18px]">
            ✕
          </span>
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-5 py-[18px]">
        {project ? (
          <FieldGroup
            label="Repos"
            hint="The first repo is the main one; others are cloned next to it."
          >
            <div className="space-y-1.5">
              {repoLines.map((line, i) => (
                <div key={i} className="flex gap-1.5">
                  <Input
                    aria-label={`Repository ${i + 1} and base branch`}
                    value={line}
                    onChange={(event) =>
                      setRepoLines((lines) =>
                        lines.map((old, index) =>
                          index === i ? event.target.value : old,
                        ),
                      )
                    }
                    className={FIELD}
                  />
                  {repoLines.length > 1 && (
                    <button
                      type="button"
                      aria-label={`Remove repository ${i + 1}`}
                      onClick={() =>
                        setRepoLines((lines) =>
                          lines.filter((_, index) => index !== i),
                        )
                      }
                    >
                      <Icon name="X" className="size-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              disabled={repoLines.length >= 8}
              className="block text-xs leading-4 text-[color:var(--project-link)] hover:underline disabled:opacity-50"
              onClick={() => setRepoLines((lines) => [...lines, ""])}
            >
              + Add a repo
            </button>
          </FieldGroup>
        ) : (
          <>
            <FieldGroup label="Repo">
              <div className="relative">
                <Icon
                  name="Search"
                  className="pointer-events-none absolute left-2.5 top-3 size-[13px] text-muted-foreground"
                />
                <Input
                  aria-label="Search your GitHub repos"
                  placeholder="Search your GitHub repos"
                  className={cn(FIELD, "h-9 rounded-lg pl-[31px]")}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <div
                className="space-y-2"
                role="radiogroup"
                aria-label="Repository"
              >
                {catalog.data?.repos
                  .filter((repo) =>
                    repo.repo.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((repo) => (
                    <label
                      key={repo.repo}
                      className={cn(
                        "relative flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-[color:var(--boat-setting-border)] px-3 py-[9px] text-left",
                        repo.repo === selectedRepo &&
                          "border-[color:var(--project-choice-border)] bg-[color:var(--project-choice-bg)]",
                      )}
                    >
                      <input
                        type="radio"
                        name="project-repo"
                        className="sr-only peer"
                        value={repo.repo}
                        checked={repo.repo === selectedRepo}
                        onChange={() => choose(repo.repo, repo.baseBranch)}
                      />
                      <span
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] border-[color:var(--project-radio-border)] peer-focus-visible:ring-2 peer-focus-visible:ring-ring",
                          repo.repo === selectedRepo &&
                            "border-[color:var(--project-check-bg)] bg-[color:var(--project-check-bg)]",
                        )}
                      >
                        {repo.repo === selectedRepo && (
                          <Icon
                            name="Check"
                            className="size-2.5 text-[color:var(--project-check-text)]"
                          />
                        )}
                      </span>
                      <span className="flex flex-col gap-px">
                        <span className="block text-[13px] leading-[18px] text-[color:var(--boat-heading)]">
                          {repo.repo}
                        </span>
                        <span className="block text-[11px] leading-[14px] text-muted-foreground">
                          {[
                            repo.baseBranch,
                            repo.language,
                            repo.updatedAt &&
                              `updated ${repositoryUpdated(repo.updatedAt)}`,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                        {catalog.data?.local.some(
                          (item) => item.repo === repo.repo,
                        ) && (
                          <span className="block text-[11px] leading-[14px] text-[color:var(--project-success)]">
                            also a local bb project
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
              </div>
              {query.includes("/") &&
                !catalog.data?.repos.some(
                  (repo) => repo.repo === query.trim(),
                ) && (
                  <button
                    type="button"
                    className="text-xs text-[color:var(--project-link)]"
                    onClick={() => choose(query.trim(), null)}
                  >
                    Use {query.trim()}
                  </button>
                )}
              <p className="text-xs leading-[17px] text-muted-foreground">
                Repos configured on Boat are listed.{" "}
                <UrlLink
                  href="https://boat.dev/dashboard?tab=environment"
                  className="text-[color:var(--project-link)] hover:underline"
                >
                  Give boat access to more
                </UrlLink>
              </p>
            </FieldGroup>
            {local && (
              <label className="flex items-center gap-2 rounded-lg border border-[color:var(--project-local-border)] bg-[color:var(--project-local-bg)] px-3 py-[9px] text-xs leading-[17px] text-[color:var(--project-local-text)]">
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full bg-[color:var(--project-success)]"
                />
                <span className="flex-1">
                  Also use my local bb project “{local.name}” (same repo
                  {local.branch ? `, branch ${local.branch}` : ""})
                </span>
                <Switch
                  aria-label="Also use my local bb project"
                  className="data-[state=checked]:bg-[color:var(--project-success)] [&>span[data-state=checked]]:translate-x-[13px] [&>span[data-state=checked]]:bg-[color:var(--project-check-text)]"
                  checked={useLocal}
                  onCheckedChange={(checked) => {
                    setUseLocal(checked);
                    if (checked && local?.branch) setBase(local.branch);
                  }}
                />
              </label>
            )}
            <FieldGroup label="Base branch">
              <div className="relative">
                <Input
                  aria-label="Base branch"
                  className={cn(FIELD, "h-9 rounded-lg pr-8")}
                  value={base}
                  onChange={(event) => setBase(event.target.value)}
                  list="boat-project-base-options"
                />
                <Icon
                  name="ChevronDown"
                  className="pointer-events-none absolute right-3 top-3 size-3 text-muted-foreground"
                />
                <datalist id="boat-project-base-options">
                  {[
                    ...new Set(
                      [
                        catalog.data?.repos.find(
                          (item) => item.repo === selectedRepo,
                        )?.baseBranch,
                        local?.branch,
                      ].filter(Boolean),
                    ),
                  ].map((branch) => (
                    <option key={branch} value={branch!} />
                  ))}
                </datalist>
              </div>
            </FieldGroup>
          </>
        )}
        <FieldGroup label="How work lands">
          <Segments<"pr" | "push">
            name="project-delivery"
            value={delivery}
            onChange={setDelivery}
            roomy={!project}
            options={[
              {
                value: "pr",
                label: "Pull request",
                hint: "review and merge on GitHub",
              },
              {
                value: "push",
                label: `Ship to ${project?.repos[0]?.baseBranch ?? base}`,
                hint: "after your OK in the chat",
              },
            ]}
          />
        </FieldGroup>
        {project && (
          <FieldGroup label="Protected branches" hint="Tasks never push here.">
            <Input
              aria-label="Protected branches"
              className={FIELD}
              value={protectedText}
              onChange={(event) => setProtected(event.target.value)}
              maxLength={2000}
            />
          </FieldGroup>
        )}
        <FieldGroup label="Default sandbox size">
          <Segments<NonNullable<ProjectDto["machineType"]>>
            name="project-size"
            value={size ?? defaults.size}
            onChange={setSize}
            roomy={!project}
            options={[
              { value: "small", label: "Small", hint: "half the cost" },
              { value: "default", label: "Default", hint: "most work" },
              {
                value: "large",
                label: "Large",
                hint: "2× per hour",
                orange: true,
              },
              ...((size ?? defaults.size) === "xlarge"
                ? [
                    {
                      value: "xlarge",
                      label: "XLarge",
                      hint:
                        sizes.data?.sizes.find(
                          (option) => option.type === "xlarge",
                        )?.detail ?? "",
                    },
                  ]
                : []),
            ].map((option) => ({
              ...option,
              value: option.value as "small" | "default" | "large" | "xlarge",
              disabled:
                sizes.data?.sizes.find((size) => size.type === option.value)
                  ?.available === false,
              reason: sizes.data?.sizes.find(
                (size) => size.type === option.value,
              )?.reason,
            }))}
          />
        </FieldGroup>
        <FieldGroup label="Who reviews">
          <Segments<"codex" | "claude" | "none">
            name="project-reviewer"
            value={reviewer ?? defaults.reviewer}
            onChange={setReviewer}
            roomy={!project}
            options={[
              { value: "codex", label: "Codex", hint: "the other agent" },
              { value: "claude", label: "Claude", hint: "fresh context" },
              { value: "none", label: "No review" },
            ]}
          />
        </FieldGroup>
        {project && (
          <>
            <FieldGroup label="Snapshot">
              <ProjectSnapshotControl
                project={project}
                onSnapshotSaved={setSnapshot}
              />
            </FieldGroup>
            <FieldGroup
              label="Orchestrator rules file"
              hint="Read from the main repo; added after the shared protocol."
            >
              <Input
                aria-label="Orchestrator rules file"
                className={FIELD}
                value={rules}
                onChange={(event) => setRules(event.target.value)}
                maxLength={300}
              />
            </FieldGroup>
            <FieldGroup label="Instructions for every task">
              <Textarea
                aria-label="Instructions for every task"
                className={cn(FIELD, "h-auto min-h-[58px] resize-none py-2")}
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                maxLength={10000}
              />
            </FieldGroup>
          </>
        )}
        <Disclosure label="Advanced">
          <div className="grid gap-3">
            <FieldGroup label="Project name">
              <Input
                aria-label="Project name"
                className={FIELD}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
              />
            </FieldGroup>
            <FieldGroup label="Environment">
              <Input
                aria-label="Boat environment"
                className={FIELD}
                value={environment}
                onChange={(event) => setEnvironment(event.target.value)}
                maxLength={80}
              />
            </FieldGroup>
            <label className="flex items-center justify-between gap-3">
              Run tasks as chats
              <Switch
                checked={workerMode === "chat"}
                onCheckedChange={(checked) =>
                  setWorkerMode(checked ? "chat" : "boat")
                }
              />
            </label>
            <FieldGroup label="Saved snapshot name">
              <Input
                aria-label="Saved snapshot name"
                className={FIELD}
                value={snapshot}
                onChange={(event) => setSnapshot(event.target.value)}
                maxLength={120}
              />
            </FieldGroup>
            <button
              type="button"
              className="text-left text-xs text-[color:var(--project-link)]"
              onClick={() => {
                setSize(null);
                setReviewer(null);
              }}
            >
              Use global size and reviewer defaults
            </button>
          </div>
        </Disclosure>
        {failure && <InlineAlert>{failure}</InlineAlert>}
        {catalog.data?.error && !project && (
          <InlineAlert>{catalog.data.error}</InlineAlert>
        )}
        {catalog.error && !project && (
          <InlineAlert>{catalog.error.message}</InlineAlert>
        )}
      </div>
      <footer className="flex shrink-0 items-center gap-2 border-t border-[color:var(--boat-setting-border)] px-5 py-[14px]">
        {!project && (
          <span className="mr-auto text-xs leading-4 text-muted-foreground">
            You can change all of this later.
          </span>
        )}
        <Button
          type="button"
          variant="outline"
          className={cn(ACTION, !project && "h-7 px-3", project && "ml-auto")}
          onClick={onDone}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={save.isPending}
          className={cn(
            ACTION,
            !project && "px-3",
            project && "items-start",
            "bg-primary text-primary-foreground dark:text-primary-foreground",
          )}
        >
          {save.isPending
            ? "Saving…"
            : project
              ? "Save"
              : `Add ${name || "project"}`}
        </Button>
      </footer>
    </form>
  );
}
function ProjectSnapshotControl({
  project,
  onSnapshotSaved,
}: {
  project: ProjectDto;
  onSnapshotSaved(name: string): void;
}) {
  const snapshots = useSnapshots();
  const navigate = useBbNavigate();
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const check = experimental_useRpcQuery({
    contract: rpcContract,
    method: "projectSnapshotCheck",
    input: { projectId: project.id },
  });
  const start = experimental_useRpcMutation({
    contract: rpcContract,
    method: "startProjectSnapshot",
  });
  const task = useTask(check.data?.taskId ?? null);
  const snapshot = snapshots.data?.snapshots.find(
    (item) => item.name === project.snapshot,
  );
  const updated = snapshotUpdated(snapshot?.createdAt);
  const checking = check.data?.stage === "checking";
  const ready = check.data?.stage === "ready";
  async function rebuild() {
    try {
      setFailure(null);
      await start.mutate({ projectId: project.id });
      setConfirm(false);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  }
  return (
    <>
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            ready || (!checking && snapshot?.status === "ready")
              ? "bg-[color:var(--project-success)]"
              : "bg-muted-foreground",
          )}
        />
        <span className="flex-1 text-[13px] leading-[18px] text-[color:var(--project-text)]">
          {checking
            ? "Checking repo…"
            : ready
              ? "Repo check passed · save the snapshot"
              : snapshot
                ? `${snapshot.status === "ready" ? "Ready" : snapshot.status ? `Snapshot ${snapshot.status}` : snapshot.name}${updated ? ` · updated ${updated}` : ""}`
                : project.snapshot
                  ? snapshots.error || snapshots.data?.error
                    ? "Couldn't check snapshot"
                    : !snapshots.data
                      ? "Checking snapshot…"
                      : "Snapshot not found"
                  : "None yet"}
        </span>
        {ready && task.data?.task ? (
          <Button
            type="button"
            variant="outline"
            className={ACTION}
            onClick={() => setSaving(true)}
          >
            Save snapshot
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            className={ACTION}
            disabled={checking || start.isPending}
            onClick={() => setConfirm(true)}
          >
            {checking ? "Checking…" : project.snapshot ? "Rebuild" : "Make one"}
          </Button>
        )}
      </div>
      {check.data && check.data.stage !== "saved" && (
        <button
          type="button"
          onClick={() =>
            navigate.toPluginPanel("cloud-agents", {
              subPath: `task/${check.data!.taskId}`,
            })
          }
          className="text-xs text-[color:var(--project-link)] hover:underline"
        >
          Open repo check
        </button>
      )}
      {check.data?.stage === "failed" && (
        <p className="text-xs text-[color:var(--project-danger)]">
          {check.data.error}
        </p>
      )}
      {failure && <InlineAlert>{failure}</InlineAlert>}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`${project.snapshot ? "Rebuild" : "Make"} ${project.name} snapshot?`}
        description="Start a fresh headless sandbox, install dependencies and check the repo. This uses sandbox hours. When the check passes, save the snapshot explicitly; your current snapshot stays in place until you confirm replacement."
        confirmLabel="Start repo check"
        pending={start.isPending}
        onConfirm={() => void rebuild()}
      />
      {task.data?.task && (
        <SaveSnapshotDialog
          task={task.data.task}
          boatProjectId={project.id}
          open={saving}
          onOpenChange={setSaving}
          onSaved={(saved) => {
            if (saved.projectId === project.id) onSnapshotSaved(saved.name);
          }}
        />
      )}
    </>
  );
}
export function NewProjectSurfaceDialog({
  open,
  onOpenChange,
  draft,
  onSaved,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  draft?: { repo: string; baseBranch: string };
  onSaved?(project: ProjectDto): void;
}) {
  const editorDraft = useRef<EditorDraft | null>(null);
  const changeOpen = (value: boolean) => {
    if (!value) editorDraft.current = null;
    onOpenChange(value);
  };
  useEffect(() => {
    if (!open) editorDraft.current = null;
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        hideCloseButton
        className="boat-projects max-h-[92dvh] overflow-hidden w-full p-0 md:max-w-[440px]"
      >
        {open && (
          <ProjectEditor
            project={null}
            draft={draft}
            initialState={editorDraft.current ?? undefined}
            onDraftChange={(value) => {
              editorDraft.current = value;
            }}
            onSaved={onSaved}
            onDone={() => changeOpen(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
