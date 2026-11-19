// Sandbox providers in the UI (contract-providers.ts): Settings › Sandbox
// providers and Runs on, and where each task runs (the line under a task in
// the tasks-started card, the provider on a task chip off boat.dev, and the
// Runs on column in Cloud agents › Sandboxes, web/sandboxes-table.tsx).
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { experimental_useRpcMutation, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { rpcContract, rpcErrorInfo, type ProjectRunsOnDto, type RunsOnDto, type RunsOnOptionDto, type SandboxProviderDto } from "../contract";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { PANEL_PATH } from "./format";
import { useSandboxProviders } from "./hooks";
import { keyHint, keyLine, providerGlyph, providerStatus, runsOnGlyph, runsOnLine, type ProviderGlyph } from "./providers-logic";
import { EmptyBox, InlineAlert, SailIcon } from "./ui";

// ------------------------------------------------------------------ glyphs

/** A cloud provider's box (Instabox). */
function BoxIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z" />
      <path d="M4 7.5 12 12l8-4.5" />
      <path d="M12 12v9" />
    </svg>
  );
}

/** A Mac (dashed: a monthly Mac that isn't enrolled yet). */
function LaptopIcon({ className, dashed = false }: { className?: string; dashed?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={dashed ? "2 2" : undefined} className={className} aria-hidden>
      <rect x="4.5" y="5" width="15" height="10.5" rx="1.5" />
      <path d="M2.5 19h19" />
    </svg>
  );
}

/** The provider's icon in its colour: boat.dev's sail a little faded, a Mac's laptop grey. */
export function ProviderGlyphIcon({ glyph, className }: { glyph: ProviderGlyph; className?: string }) {
  if (glyph === "boat") return <SailIcon className={cn("opacity-[0.85]", className)} />;
  if (glyph === "box") return <BoxIcon className={cn("text-[#A8A8A8]", className)} />;
  return <LaptopIcon dashed={glyph === "laptop-dashed"} className={cn(glyph === "laptop-dashed" ? "text-[color:var(--boat-faint)]" : "text-[#A8A8A8]", className)} />;
}

// ------------------------------------------------------------------ where a task runs

/** The line under a task's title: "boat.dev · Default", "Instabox · Mac M2 · lease ends Thu 14:00". */
export function RunsOnLine({ runsOn, className }: { runsOn: RunsOnDto | undefined; className?: string }) {
  if (runsOn === undefined) return null;
  const glyph = runsOnGlyph(runsOn);
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-muted-foreground dark:text-[#6E6E6E]", className)}>
      <ProviderGlyphIcon glyph={glyph} className={cn("size-[11px] shrink-0", glyph === "boat" && "opacity-70", glyph === "laptop" && "text-[#8A8A8A]")} />
      <span className="truncate">{runsOnLine(runsOn)}</span>
    </span>
  );
}

/** A task chip's provider, off boat.dev only ("Instabox", "Your Mac"): the glyph and the name. */
export function ChipProvider({ runsOn }: { runsOn: RunsOnDto }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[12px] leading-[18px] text-muted-foreground dark:text-[#8A8A8A]">
      <ProviderGlyphIcon glyph={runsOnGlyph(runsOn)} className="size-[11px] text-current" />
      {runsOn.label}
    </span>
  );
}

/** On hover, where a chip's task runs and what it shares. Without one (boat.dev), the chip as it is. */
export function RunsOnTooltip({ runsOn, children }: { runsOn: RunsOnDto | null; children: ReactNode }) {
  if (runsOn === null) return <>{children}</>;
  return (
    <TooltipProvider delayDuration={400}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent className="boat-ui flex flex-col gap-0.5 rounded-lg border border-border bg-popover px-2.5 py-2 text-[12px] leading-4 text-popover-foreground shadow-[0_8px_24px_#00000059] dark:border-[#2E2E2E] dark:bg-[#222222]">
          <span className="dark:text-[#E2E2E2]">{runsOnLine(runsOn)}</span>
          {runsOn.detail ? <span className="text-muted-foreground dark:text-[#8A8A8A]">{runsOn.detail}</span> : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ------------------------------------------------------------------ Settings › Sandbox providers

function StatusText({ provider, className }: { provider: SandboxProviderDto; className?: string }) {
  const status = providerStatus(provider);
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-xs leading-4 text-[color:var(--boat-secondary)] dark:text-[#A8A8A8]", className)}>
      <span aria-hidden className={cn("size-1.5 rounded-full", status.ok ? "bg-[#5BD08A]" : "bg-[#6E6E6E]")} />
      {status.text}
    </span>
  );
}

function SystemChips({ provider }: { provider: SandboxProviderDto }) {
  if (provider.systems.length === 0) return null;
  return (
    <ul aria-label={`${provider.label} systems`} className="mt-2 flex flex-wrap gap-1.5">
      {provider.systems.map((system) => (
        <li
          key={system.os}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border px-2 py-[3px] text-xs leading-4",
            system.note !== null
              ? "border-dashed border-border text-[color:var(--boat-faint)] dark:border-[#2A2A2A]"
              : cn("border-border dark:border-[#2E2E2E]", system.ready ? "text-[color:var(--boat-content)]" : "text-muted-foreground"),
          )}
        >
          {system.ready ? <span aria-label="ready" className="text-[#5BD08A]">✓</span> : null}
          {system.label}
          {system.note !== null ? <span> · {system.note}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function KeyLine({ provider }: { provider: SandboxProviderDto }) {
  const line = keyLine(provider);
  if (line === null) return null;
  const showWhere = () => {
    const hint = keyHint(provider);
    toast(hint.title, { description: hint.description });
  };
  return (
    <p className="mt-2 text-xs leading-[17px] text-muted-foreground">
      API key{" "}
      <span className={line.set ? "text-[color:var(--boat-content)]" : undefined}>{line.set ? "set in bb secrets" : "not set"}</span>
      <span aria-hidden className="px-1.5 text-[color:var(--boat-faint)]">·</span>
      <button type="button" className="text-[#7AA7FF] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={showWhere}>
        {line.action}
      </button>
    </p>
  );
}

/** One provider: icon, name and what it is, and its status (on the right, or after a Mac's name). */
function ProviderRow({ provider }: { provider: SandboxProviderDto }) {
  const mac = provider.kind !== "cloud";
  return (
    <div className="flex items-start gap-3 px-3.5 py-3" aria-disabled={provider.available ? undefined : true}>
      <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
        <ProviderGlyphIcon glyph={providerGlyph(provider)} className={cn("size-3.5", !provider.available && "opacity-60")} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[13px] leading-[18px] text-[var(--boat-label)]">{provider.label}</span>
          {provider.isDefault ? <span className="rounded bg-muted px-1.5 py-px text-[11px] leading-[14px] text-[color:var(--boat-secondary)] dark:bg-[#222222] dark:text-[#A8A8A8]">Default</span> : null}
          {provider.meta ? <span className="text-xs leading-4 text-[color:var(--boat-faint)]">{provider.meta}</span> : null}
          {mac ? <StatusText provider={provider} className="ml-1" /> : null}
        </div>
        <p className="mt-0.5 text-xs leading-[17px] text-muted-foreground">{provider.pricing ? `${provider.summary} ${provider.pricing}` : provider.summary}</p>
        <SystemChips provider={provider} />
        <KeyLine provider={provider} />
      </div>
      {mac ? null : <StatusText provider={provider} />}
    </div>
  );
}

// ------------------------------------------------------------------ Settings › Runs on

const RUNS_ON_SELECT = "h-[30px] w-44 rounded-md border-border bg-background px-2.5 text-[13px] text-[var(--boat-label)] shadow-none";

function RunsOnRow({ project, options, onPick, error }: { project: ProjectRunsOnDto; options: readonly RunsOnOptionDto[]; onPick: (provider: string) => void; error: string | undefined }) {
  const id = `boat-runs-on-${project.projectId}`;
  return (
    <div className="flex items-start gap-6 px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="block text-[13px] leading-[18px] text-[var(--boat-label)]">
          {project.name}
        </label>
        <p className="mt-0.5 text-xs leading-[17px] text-muted-foreground">{project.detail}</p>
        {error ? (
          <p role="alert" className="mt-1 text-xs text-[#E06C6C]">
            {error}
          </p>
        ) : null}
      </div>
      <div className="shrink-0">
        <Select value={project.provider} onValueChange={onPick}>
          <SelectTrigger id={id} aria-label={`${project.name} runs on`} className={RUNS_ON_SELECT}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.provider} value={option.provider} disabled={option.disabledReason !== null && option.provider !== project.provider} textValue={option.label}>
                {option.label}
                {option.disabledReason !== null ? <span className="block text-xs text-muted-foreground">{option.disabledReason}</span> : null}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function Group({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn("space-y-2", className)}>
      <h3 className="text-[13px] font-medium leading-[18px] text-[color:var(--boat-group-heading)]">{title}</h3>
      {children}
    </section>
  );
}

const BOX = "divide-y divide-[color:var(--boat-divider)] overflow-hidden rounded-[10px] border border-[var(--boat-setting-border)] bg-card";

/** Settings › Sandbox providers, then Runs on: between Agents and Sandboxes & cost. */
export function SandboxProvidersSettings({ className }: { className?: string }) {
  const { data, error } = useSandboxProviders();
  const navigate = useBbNavigate();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const pick = experimental_useRpcMutation({
    contract: rpcContract,
    method: "setProjectRunsOn",
    optimistic: (input, cache) =>
      cache.update("sandboxProviders", null, (current) => ({
        ...current,
        projects: current.projects.map((project) => (project.projectId === input.projectId ? { ...project, provider: input.provider, chosen: true } : project)),
      })),
  });
  const choose = async (projectId: string, provider: string) => {
    setErrors(({ [projectId]: _cleared, ...rest }) => rest);
    try {
      await pick.mutate({ projectId, provider });
    } catch (reason) {
      setErrors((current) => ({ ...current, [projectId]: rpcErrorInfo(reason).message }));
    }
  };
  if (data === undefined) {
    return (
      <Group title="Sandbox providers" className={className}>
        {error ? <InlineAlert>{error.message}</InlineAlert> : <EmptyBox>Checking sandbox providers…</EmptyBox>}
      </Group>
    );
  }
  return (
    <>
      <Group title="Sandbox providers" className={className}>
        <div className={BOX}>
          {data.providers.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} />
          ))}
        </div>
        <p className="px-0.5 text-xs leading-[17px] text-muted-foreground">{data.routing}</p>
      </Group>
      <Group title="Runs on" className={className}>
        <div className={BOX}>
          {data.projects.length === 0 ? (
            <div className="flex flex-wrap items-center gap-2.5 px-3.5 py-3">
              <p className="min-w-0 flex-1 text-xs leading-[17px] text-muted-foreground">Add a project to pick where its work runs.</p>
              <button type="button" className="text-xs leading-4 text-[#7AA7FF] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "projects" })}>
                Open the Projects page →
              </button>
            </div>
          ) : (
            data.projects.map((project) => <RunsOnRow key={project.projectId} project={project} options={data.options} error={errors[project.projectId]} onPick={(provider) => void choose(project.projectId, provider)} />)
          )}
        </div>
      </Group>
    </>
  );
}
