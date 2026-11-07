// The workspace strip: on a task chat, every chat that shares its sandbox
// and checkout, as a row of tabs in the context row above the composer (bb's
// header buttons can't hold tabs), plus "New chat" to add another agent there.
// It mounts once per visible thread, so state lives in components only.
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { toast } from "sonner";
import {
  experimental_NewThreadComposer as NewThreadComposer,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_useRpcMutation,
  experimental_useRpcQuery,
  experimental_useSidebarThreads,
  useBbNavigate,
  type ExperimentalThreadContextSegmentInput,
  type ExperimentalThreadContextSegmentProps,
  type NewThreadRequest,
} from "@get-bb/plugin-sdk/app";
import { rpcContract, type WorkspaceChatDto } from "../contract";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { BB_PROVIDER_ID, PROVIDER_LABEL, PROVIDER_SHORT, effortLabel, modelName, type Provider } from "./format";
import { useCloudAgentsNavigation, useOverview } from "./hooks";
import { AgentLogo, ThreadName, showError } from "./ui";

/** The same small text button as the Cloud agents segment's summary. */
const ROW_BUTTON =
  "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function useWorkspace(threadId: string) {
  // Stable input identity across renders for the same thread.
  const input = useMemo(() => ({ threadId }), [threadId]);
  return experimental_useRpcQuery({ contract: rpcContract, method: "workspaceChats", input });
}

/** Only on worker chats: the server returns no workspace for any other thread. */
export function useWorkspaceStripVisible({ threadId }: ExperimentalThreadContextSegmentInput): boolean {
  const workspace=useWorkspace(threadId).data?.workspace;
  return Boolean(workspace && workspace.chats.filter(chat=>!chat.archived).length>1);
}

/** "Opus 5.5", else the agent ("Claude") when the chat's model isn't known. */
function chatLabel(chat: WorkspaceChatDto): string {
  if (chat.model) return modelName(chat.model);
  return chat.provider ? PROVIDER_SHORT[chat.provider] : "Chat";
}

function chatDetails(chat: WorkspaceChatDto): string {
  const parts: string[] = [];
  if (chat.provider) parts.push(PROVIDER_LABEL[chat.provider]);
  if (chat.model) parts.push(modelName(chat.model));
  if (chat.effort) parts.push(`${effortLabel(chat.effort)} effort`);
  if (chat.current) parts.push("runs the task");
  if (chat.archived) parts.push("archived");
  return parts.join(" · ");
}

export function WorkspaceStrip({ threadId, projectId, environment }: ExperimentalThreadContextSegmentProps) {
  const workspace = useWorkspace(threadId).data?.workspace ?? null;
  const navigate = useBbNavigate();
  const { openTask } = useCloudAgentsNavigation();
  const { threads } = experimental_useSidebarThreads();
  const [adding, setAdding] = useState(false);
  if (workspace === null) return null;

  const viewed = workspace.chats.find((chat) => chat.threadId === threadId) ?? null;
  const open = (chat: WorkspaceChatDto, event: MouseEvent) => {
    if (chat.threadId === threadId) return;
    // ⌘/Ctrl-click opens it beside this one.
    navigate.toThread(chat.threadId, { split: event.metaKey || event.ctrlKey });
  };

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex min-w-0 max-w-full items-center gap-0.5">
        {workspace.source.threadId !== null && workspace.source.kind !== "page" ? (
          <SourceButton kind={workspace.source.kind} threadId={workspace.source.threadId} title={workspace.source.title} />
        ) : null}
        <button
          type="button"
          title={workspace.taskTitle}
          onClick={() => openTask(workspace.taskId)}
          className={cn(ROW_BUTTON, "min-w-0 max-w-48 shrink gap-1")}
        >
          <span className="shrink-0">Task:</span>
          <span className="truncate">{workspace.taskTitle}</span>
        </button>
        <span aria-hidden className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />
        <nav
          aria-label="Chats in this workspace"
          className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
        >
          {workspace.chats.map((chat) => {
            const isViewed = chat.threadId === threadId;
            const indicator = threads.find((thread) => thread.id === chat.threadId)?.indicator ?? "none";
            return (
              <Tooltip key={chat.threadId}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-current={isViewed ? "page" : undefined}
                    onClick={(event) => open(chat, event)}
                    className={cn(
                      ROW_BUTTON,
                      // The scrolling rail would clip an outside ring.
                      "focus-visible:ring-inset",
                      isViewed && "bg-secondary text-foreground hover:bg-secondary",
                      chat.archived && !isViewed && "opacity-60",
                    )}
                  >
                    {chat.archived || indicator !== "none" ? (
                      <ThreadStatusGlyph indicator={indicator} archived={chat.archived} size="compact" />
                    ) : null}
                    {chat.provider ? (
                      <AgentLogo provider={chat.provider} />
                    ) : (
                      <Icon name="MessageSquare" className="size-3.5 shrink-0" aria-hidden />
                    )}
                    <span className="whitespace-nowrap">{chatLabel(chat)}</span>
                    {chat.current ? (
                      <>
                        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
                        <span className="sr-only">, runs the task</span>
                      </>
                    ) : null}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <span className="block font-medium">
                    <ThreadName threadId={chat.threadId} fallback={chat.title} />
                  </span>
                  <span className="block text-primary-foreground/70">{chatDetails(chat)}</span>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </nav>
        {/* A closed task's workspace may be gone: no new chats there. */}
        {workspace.open ? (
          <button type="button" onClick={() => setAdding(true)} className={cn(ROW_BUTTON, "gap-1")}>
            <Icon name="Plus" className="size-3.5" aria-hidden />
            New chat
          </button>
        ) : null}
      </div>
      {workspace.open ? (
        <NewChatDialog
          threadId={threadId}
          taskId={workspace.taskId}
          projectId={projectId}
          environmentId={workspace.environmentId ?? environment?.id ?? null}
          viewedProvider={viewed?.provider ?? null}
          open={adding}
          onOpenChange={setAdding}
        />
      ) : null}
    </TooltipProvider>
  );
}

/** "Open orchestrator" for a real one; "Open <chat>" for the chat that started the task. */
function SourceButton({ kind, threadId, title }: { kind: "orchestrator" | "chat"; threadId: string; title: string | null }) {
  const navigate = useBbNavigate();
  const orchestrator = kind === "orchestrator";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={orchestrator ? "Open orchestrator" : `Open ${title ?? "the chat that started this task"}`}
          className={cn(ROW_BUTTON, "px-1")}
          onClick={() => navigate.toThread(threadId)}
        >
          <Icon name={orchestrator ? "Workflow" : "MessageSquare"} className="size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {orchestrator ? "Orchestrator: " : "Open "}
        <ThreadName threadId={threadId} fallback={title} />
      </TooltipContent>
    </Tooltip>
  );
}

// ------------------------------------------------------------------ new chat

interface NewChatProps {
  /** Any chat in the workspace; the server finds the task from it. */
  threadId: string;
  /** Keys the draft, so each workspace keeps its own. */
  taskId: string;
  /** The bb project of the chat on screen, which the workspace belongs to. */
  projectId: string;
  /** The workspace's bb environment; null while it isn't known yet. */
  environmentId: string | null;
  /** The agent of the chat on screen, if known. */
  viewedProvider: Provider | null;
}

/** bb's own new-chat composer; the server opens the chat in this workspace whatever its pickers say. */
function NewChatDialog({
  open,
  onOpenChange,
  ...props
}: NewChatProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New chat in this workspace</DialogTitle>
          <DialogDescription>Opens in this workspace (same sandbox and checkout).</DialogDescription>
        </DialogHeader>
        {open ? <NewChatComposer {...props} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/** bb's provider id → the agent it runs, for the success toast. */
const agentOf = (providerId: string): Provider | null =>
  (Object.keys(BB_PROVIDER_ID) as Provider[]).find((provider) => BB_PROVIDER_ID[provider] === providerId) ?? null;

function NewChatComposer({
  threadId,
  taskId,
  projectId,
  environmentId,
  viewedProvider,
  onDone,
}: NewChatProps & { onDone: () => void }) {
  const create = experimental_useRpcMutation({ contract: rpcContract, method: "newWorkspaceChat" });
  const navigate = useBbNavigate();
  const submitting = useRef(false);
  const [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => setFocusRequest((value) => value + 1), []);

  // Seeds are compared by value on every render, and a changed one re-seeds
  // every picker, so they stay stable while the dialog is open.
  const defaultEnvironment = useMemo(
    () => (environmentId === null ? undefined : { type: "reuse" as const, environmentId }),
    [environmentId],
  );
  // Usually the other agent: a takeover after a usage limit, or a second
  // opinion. With one agent set up (Agents you have), that one.
  const onlyAgent = useOverview().data?.defaults.onlyAgent ?? null;
  const defaultProviderId =
    onlyAgent !== null
      ? BB_PROVIDER_ID[onlyAgent]
      : viewedProvider === null
        ? undefined
        : BB_PROVIDER_ID[viewedProvider === "claude" ? "codex" : "claude"];

  const submit = async (request: NewThreadRequest) => {
    // Once only (the dialog closes after a create). Throwing keeps the draft.
    if (submitting.current) throw new Error("Already starting this chat.");
    submitting.current = true;
    try {
      const { providerId, model, reasoningLevel, permissionMode, serviceTier, sessionOptions, executionInputSources, input } =
        request;
      // No environment or project: the server always opens it in this workspace.
      // bb's RPC carries JSON only: drop fields the composer left undefined.
      const result = await create.mutate({
        threadId,
        request: {
          providerId,
          model,
          reasoningLevel,
          permissionMode,
          input,
          ...(serviceTier !== undefined ? { serviceTier } : {}),
          ...(sessionOptions !== undefined ? { sessionOptions } : {}),
          ...(executionInputSources !== undefined ? { executionInputSources } : {}),
        },
      });
      const agent = agentOf(providerId);
      toast.success(agent ? `${PROVIDER_SHORT[agent]} chat started` : "Chat started");
      // Once this resolves and the composer has cleared its draft.
      setTimeout(() => {
        onDone();
        navigate.toThread(result.threadId);
      }, 0);
    } catch (error) {
      submitting.current = false;
      showError(error);
      throw error;
    }
  };

  return (
    <NewThreadComposer
      layout="document"
      draftKey={`boat:workspace-chat:${taskId}`}
      defaultProjectId={projectId}
      defaultEnvironment={defaultEnvironment}
      defaultProviderId={defaultProviderId}
      focusRequest={focusRequest}
      placeholder="Review the diff on this branch, or pick up where the other chat stopped."
      onSubmit={submit}
    />
  );
}
