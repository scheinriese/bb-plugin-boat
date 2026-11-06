// Small presentational building blocks shared by the page and thread surfaces.
import { forwardRef, useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  ThreadTitle,
  UrlLink,
  experimental_ProviderIcon as ProviderIcon,
  experimental_useProviders,
  experimental_useSidebarThreads,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { rpcErrorInfo, type TaskDto } from "../contract";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { richText, taskPhaseLabel } from "./logic";
import {
  BB_PROVIDER_ID,
  PROVIDER_LABEL,
  PROVIDER_SHORT,
  ROLE_ICON,
  ROLE_LABEL,
  STATUS_DOT,
  STATUS_LABEL,
  TONE_CHIP,
  effortLabel,
  modelChipLabel,
  modelName,
  phaseDot,
  phaseText,
  prLabel,
  reportTone,
  workerChatId,
  type Provider,
  type Role,
  type Status,
  type Tone,
} from "./format";

/** The boat.dev sail glyph, registered as the `boat-sail` app icon. */
export function SailIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M12 3v14" />
      <path d="M12 4.5 18.5 15H12" />
      <path d="M12 7.5 6.5 15H12" />
      <path d="M3.5 18.5c2.8 1.6 5.7 1.6 8.5 0s5.7-1.6 8.5 0" />
    </svg>
  );
}

export function StatusDot({ className, label }: { className: string; label?: string }) {
  return (
    <span
      aria-hidden={label === undefined}
      aria-label={label}
      role={label === undefined ? undefined : "img"}
      className={cn("inline-block size-1.5 shrink-0 rounded-full", className)}
    />
  );
}

export function StatusPill({ status, className }: { status: Status; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border border-border px-2 text-xs",
        status === "running" || status === "starting" ? "text-foreground" : "text-muted-foreground",
        className,
      )}
    >
      <StatusDot className={STATUS_DOT[status]} />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Where a task stands for the user (TaskDto.phase), as a pill. */
export function PhasePill({
  task,
  className,
}: {
  task: Pick<TaskDto, "phase" | "orchestratorThreadId" | "source">;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-2 text-xs",
        phaseText(task),
        className,
      )}
    >
      <StatusDot className={phaseDot(task)} />
      {taskPhaseLabel(task)}
    </span>
  );
}

/** "Build · Opus 5.5 · Extra high" with the agent's logo; the hover shows the raw ids. */
export function ModelChip({
  task,
  className,
}: {
  task: Pick<TaskDto, "provider" | "model" | "tier" | "reasoningEffort" | "reason">;
  className?: string;
}) {
  const details = [
    PROVIDER_LABEL[task.provider],
    task.model,
    task.reasoningEffort ? `${effortLabel(task.reasoningEffort)} effort` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <TooltipProvider delayDuration={400}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "relative z-10 inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded-md border border-border px-1.5 text-xs text-muted-foreground",
              className,
            )}
          >
            <AgentLogo provider={task.provider} className="size-3" />
            <span className="truncate">{modelChipLabel(task)}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <div>{details}</div>
          {task.reason ? <div className="opacity-80">{task.reason}</div> : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** The repo isn't one of the user's projects, so the worker had no access to bb. */
export function UntrustedRepoBadge() {
  const explanation = "This repo isn't one of your projects, so its task ran headless in boat, with no access to your bb.";
  return (
    <TooltipProvider delayDuration={400}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="relative z-10 inline-flex h-5 shrink-0 items-center gap-1 rounded-md border border-warning/30 bg-warning/10 px-1.5 text-xs text-warning-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Icon name="AlertTriangle" className="size-3" aria-hidden />
            Untrusted repo
            <span className="sr-only">: {explanation}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>{explanation}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ToneChip({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-md border px-1.5 text-xs font-medium",
        TONE_CHIP[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A review verdict, else the worker's report status, as a toned chip. */
export function ReportChip({ task }: { task: Pick<TaskDto, "verdict" | "reportStatus"> }) {
  const value = task.verdict ?? task.reportStatus;
  if (!value) return null;
  return (
    <ToneChip tone={reportTone(value)}>
      <span className="sr-only">{task.verdict ? "Verdict: " : "Report: "}</span>
      {value}
    </ToneChip>
  );
}

export function RoleIcon({ role, className }: { role: Role; className?: string }) {
  return (
    <Icon
      name={ROLE_ICON[role]}
      aria-label={ROLE_LABEL[role]}
      className={cn("size-4 shrink-0 text-muted-foreground", className)}
    />
  );
}

/** bb's own Claude Code / Codex logo, or the agent's name when bb lacks it. */
export function AgentLogo({ provider, className }: { provider: Provider; className?: string }) {
  const { providers } = experimental_useProviders();
  const match = providers.find((entry) => entry.id === BB_PROVIDER_ID[provider]);
  if (match === undefined) {
    return <span className="text-xs text-muted-foreground">{PROVIDER_SHORT[provider]}</span>;
  }
  return (
    <ProviderIcon
      providerKind="agent"
      provider={match}
      fallback="Bot"
      aria-label={PROVIDER_LABEL[provider]}
      className={cn("size-3.5 shrink-0", className)}
    />
  );
}

/** Logo plus model (or the agent's name when no model is pinned). */
export function AgentBadge({ provider, model }: { provider: Provider; model: string | null }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1" title={PROVIDER_LABEL[provider]}>
      <AgentLogo provider={provider} />
      <span className="truncate">{model ? modelName(model) : PROVIDER_SHORT[provider]}</span>
    </span>
  );
}

const INLINE_LINK =
  "relative z-10 inline-flex shrink-0 items-center gap-1 rounded-sm text-xs text-muted-foreground tabular-nums underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** "#123" with a pull request icon; `prefixed` reads "PR #123". */
export function PrLink({ url, prefixed = false, className }: { url: string; prefixed?: boolean; className?: string }) {
  const label = prLabel(url);
  return (
    <UrlLink href={url} className={cn(INLINE_LINK, className)} aria-label={`Pull request ${label}`}>
      <Icon name="GitPullRequest" className="size-3.5" aria-hidden />
      {prefixed && label !== "PR" ? `PR ${label}` : label}
    </UrlLink>
  );
}

export function PreviewLink({ url, className }: { url: string; className?: string }) {
  return (
    <UrlLink href={url} className={cn(INLINE_LINK, className)}>
      <Icon name="Globe" fallback="ExternalLink" className="size-3.5" aria-hidden />
      Preview
    </UrlLink>
  );
}

/**
 * A thread's live title; for threads outside the sidebar's live view, the
 * title the server looked up (`fallback`), else "Archived thread".
 */
export function ThreadName({ threadId, fallback }: { threadId: string; fallback?: string | null }) {
  const { threads, status } = experimental_useSidebarThreads();
  if (threads.some((thread) => thread.id === threadId)) return <ThreadTitle threadId={threadId} />;
  if (fallback) return <>{fallback}</>;
  return <>{status === "loading" ? "…" : "Archived thread"}</>;
}

/** A thread's live title (an orchestrator's by default); opens the thread. */
export function ThreadLink({
  threadId,
  label = "Open chat",
  className,
}: {
  threadId: string;
  label?: string;
  className?: string;
}) {
  const navigate = useBbNavigate();
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        navigate.toThread(threadId);
      }}
      className={cn(
        "relative z-10 inline-flex min-w-0 max-w-full items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      aria-label={label}
    >
      <Icon name="MessageSquare" className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">
        <ThreadName threadId={threadId} />
      </span>
    </button>
  );
}

/** Opens a task's worker chat; renders nothing for boat conversations. */
export function OpenChatButton({
  task,
  className,
}: {
  task: Pick<TaskDto, "runner" | "threadId">;
  className?: string;
}) {
  const navigate = useBbNavigate();
  const chatId = workerChatId(task);
  if (chatId === null) return null;
  return (
    <IconButton
      label="Open chat"
      icon="MessageSquare"
      className={cn("relative z-10 shrink-0", className)}
      onClick={(event) => {
        event.stopPropagation();
        navigate.toThread(chatId);
      }}
    />
  );
}

interface IconButtonProps extends Omit<ButtonProps, "children" | "size"> {
  label: string;
  icon: string;
  busy?: boolean;
}

/** Ghost icon button with a tooltip; the label is also its accessible name. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, busy = false, className, variant = "ghost", disabled, ...props },
  ref,
) {
  return (
    <TooltipProvider delayDuration={400}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={ref}
            variant={variant}
            size="icon"
            aria-label={label}
            disabled={disabled || busy}
            className={cn("size-7 text-muted-foreground hover:text-foreground", className)}
            {...props}
          >
            <Icon name={busy ? "Loading" : icon} className={cn("size-4", busy && "animate-spin")} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

export function Section({
  title,
  count,
  action,
  children,
  id,
}: {
  title: ReactNode;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  const generated = useId();
  const headingId = id ?? generated;
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div className="flex min-h-8 items-center gap-2">
        <h2 id={headingId} className="text-sm font-medium text-foreground">
          {title}
        </h2>
        {count === undefined ? null : <CountPill count={count} />}
        <div className="ml-auto flex items-center gap-1">{action}</div>
      </div>
      {children}
    </section>
  );
}

export function CountPill({ count }: { count: number }) {
  return (
    <span className="rounded-full bg-secondary px-1.5 text-xs text-secondary-foreground tabular-nums">{count}</span>
  );
}

export function ListPanel({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ul aria-label={label} className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
      {children}
    </ul>
  );
}

export function EmptyBox({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      role="status"
      className={cn(
        "rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function InlineAlert({
  children,
  tone = "destructive",
  className,
}: {
  children: ReactNode;
  tone?: "destructive" | "warning";
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
        tone === "destructive"
          ? "border-surface-destructive-border bg-surface-destructive text-destructive-text"
          : "border-warning/30 bg-warning/10 text-warning-text",
        className,
      )}
    >
      <Icon name="AlertTriangle" className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-secondary px-1 font-sans text-[11px] text-muted-foreground">
      {children}
    </kbd>
  );
}

/** Inputs with suggestions (a datalist): no browser ▼ (bb styles it, hence important); the suggestions show as you type. */
export const SUGGEST_INPUT = "[&::-webkit-calendar-picker-indicator]:hidden!";

// ------------------------------------------------------------------ hints and errors

/** Text with `commands` as code and https links as links (hints from the server). */
export function RichText({ text, className }: { text: string; className?: string }) {
  return (
    <span className={className}>
      {richText(text).map((part, index) =>
        part.kind === "code" ? (
          <code key={index} className="rounded bg-secondary px-1 py-0.5 font-mono text-[11px]">
            {part.text}
          </code>
        ) : part.kind === "url" ? (
          <UrlLink key={index} href={part.text} className="underline underline-offset-2 hover:text-foreground break-all">
            {part.text.replace(/^https:\/\//, "")}
          </UrlLink>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Before a control with focus disappears (a card hidden, a row that goes
 * away): move focus to the closest focusable element before `gone` (else
 * after it), where Shift+Tab would have gone, so keyboard and screen-reader
 * users keep their place instead of starting over from the top.
 */
export function focusNeighbour(gone: Element | null): void {
  if (gone === null || !gone.contains(document.activeElement)) return;
  const others = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) => !gone.contains(node) && node.getClientRects().length > 0);
  const before = others.filter((node) => node.compareDocumentPosition(gone) & Node.DOCUMENT_POSITION_FOLLOWING);
  const target = before.at(-1) ?? others.find((node) => node.compareDocumentPosition(gone) & Node.DOCUMENT_POSITION_PRECEDING);
  target?.focus();
}

/** A failed action as a toast: the plugin's message, and what to do under it (with links). */
export function showError(error: unknown) {
  const info = rpcErrorInfo(error);
  toast.error(info.message, info.hint ? { description: <RichText text={info.hint} /> } : undefined);
}

// ------------------------------------------------------------------ disclosure

/** A small "▸ More options" toggle; the content shows below it while open. */
export function Disclosure({
  label,
  openLabel,
  defaultOpen = false,
  className,
  children,
}: {
  label: ReactNode;
  openLabel?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  return (
    <div className={cn("space-y-3", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1.5 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Icon name="ChevronRight" className={cn("size-3.5 transition-transform duration-150", open && "rotate-90")} aria-hidden />
        {open ? (openLabel ?? label) : label}
      </button>
      {open ? <div id={panelId}>{children}</div> : null}
    </div>
  );
}

// ------------------------------------------------------------------ settings rows (bb's own style)

/** bb's Switch: the same look as the toggles in bb's settings list. */
export const Switch = forwardRef<
  HTMLButtonElement,
  { checked: boolean; onCheckedChange: (checked: boolean) => void; disabled?: boolean; className?: string; "aria-label"?: string; "aria-describedby"?: string; id?: string }
>(function Switch({ checked, onCheckedChange, disabled, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      data-state={checked ? "checked" : "unchecked"}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "peer inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border border-transparent shadow-xs transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-foreground data-[state=unchecked]:border-input data-[state=unchecked]:bg-muted",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        data-state={checked ? "checked" : "unchecked"}
        className="pointer-events-none block size-3 rounded-full bg-background ring-0 transition-transform data-[state=checked]:translate-x-3 data-[state=unchecked]:translate-x-0 data-[state=unchecked]:bg-foreground"
      />
    </button>
  );
});

/** The card bb puts its settings list in; rows go inside, spaced like bb's. */
export function SettingsCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("@container/settings space-y-4 overflow-hidden rounded-md border border-border bg-surface-recessed/70 px-3 py-3", className)}>
      {children}
    </div>
  );
}

/**
 * One row, laid out like bb's own settings: label and description on the
 * left; a switch at the end ("trailing"), a select or short field beside it
 * on wide cards ("inline"), or a long field under it ("below").
 */
export function SettingField({
  label,
  description,
  placement = "inline",
  control,
  footer,
  labelFor,
  disabled = false,
}: {
  label: ReactNode;
  description?: ReactNode;
  placement?: "inline" | "trailing" | "below";
  control: ReactNode;
  /** Under the whole row: an error, a note. */
  footer?: ReactNode;
  labelFor?: string;
  /** Doesn't apply right now: the row is dimmed (its control should be disabled too). */
  disabled?: boolean;
}) {
  const trailing = placement === "trailing";
  const inline = placement === "inline";
  return (
    <div className={cn("@container/settings w-full min-w-0 space-y-1", disabled && "opacity-60")}>
      <div
        data-control-placement={placement}
        className={cn(
          trailing ? "flex flex-row justify-between gap-5" : "flex flex-col gap-2.5",
          trailing && (description ? "items-start" : "items-center"),
          inline && "@min-[36rem]/settings:flex-row @min-[36rem]/settings:justify-between @min-[36rem]/settings:gap-5",
          inline && (description ? "@min-[36rem]/settings:items-start" : "@min-[36rem]/settings:items-center"),
        )}
      >
        <div className="min-w-0 flex-1">
          {labelFor ? (
            <label htmlFor={labelFor} className="block min-w-0 text-sm font-normal text-foreground">
              {label}
            </label>
          ) : (
            <p className="min-w-0 text-sm font-normal text-foreground">{label}</p>
          )}
          {description ? <div className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">{description}</div> : null}
        </div>
        <div
          className={cn(
            trailing ? "flex shrink-0 justify-end" : inline ? "shrink-0 @min-[36rem]/settings:flex @min-[36rem]/settings:justify-end" : "w-full min-w-0",
          )}
        >
          {control}
        </div>
      </div>
      {footer}
    </div>
  );
}

/** Width and size of bb's own selects and fields in its settings list. */
export const SETTING_SELECT = "h-7 w-full justify-between border-border/60 bg-card px-2 text-xs @min-[36rem]/settings:w-44";
export const SETTING_INPUT = "h-7 w-full text-xs @min-[36rem]/settings:w-64";
