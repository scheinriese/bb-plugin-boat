// The plugin's own settings sections (Settings → Plugins → Boat Cloud
// Agents, below bb's list): Setup, Usage limits, Models, Orchestrators
// (optional) and Advanced. Projects and Back up and restore have their own
// files. Rows look and behave like bb's own settings list: switches and
// selects save at once, text and numbers when you leave the field.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { experimental_useRpcMutation, experimental_useRpcQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { rpcContract, rpcErrorInfo, type SandboxSizeDto, type SettingDto } from "../contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { cn } from "@/lib/utils";
import { PANEL_PATH, PROVIDER_LABEL } from "./format";
import { useOrchestratorCardHidden, useOrchestrators, useSandboxSizes, useSettingRows, useProjects, useBoard, useSetup } from "./hooks";
import { EVIDENCE_VARIABLES, ORCHESTRATOR_CARD_RULE, cardShownToast, evidenceMode, type EvidenceMode } from "./logic";
import { ModelPresetsEditor, ProtocolEditor } from "./protocol-settings";
import { SetupChecklist } from "./setup";
import { BackupSettings } from "./backup-settings";
import { EVERYDAY_SETTING_COPY, groupedSettings, notificationSettingPatch, setupNeedsWork, setupTestPassed } from "./v1-settings-logic";
import { useSettingsFrameTweak } from "./workarounds/settings-frame";
import { Disclosure, EmptyBox, InlineAlert, RichText, SETTING_INPUT, SETTING_SELECT, SettingField, SettingsCard, Switch, focusNeighbour, showError } from "./ui";

type SettingValue = string | number | boolean;

/** What an empty text setting means, shown in its field. */
const PLACEHOLDER: Record<string, string> = {
  implementModel: "The Build preset's model",
  reviewModel: "The Review preset's model",
  boatPath: "Found on its own",
};

// ------------------------------------------------------------------ saving

/** Saves one setting at a time, shows it at once, and keeps each row's last error. */
function useSaveSetting() {
  const save = experimental_useRpcMutation({
    contract: rpcContract,
    method: "saveSettings",
    optimistic: (input, cache) =>
      cache.update("settings", null, (current) => ({
        ...current,
        settings: current.settings.map((row) => {
          if (!(row.key in input.values)) return row;
          const value = input.values[row.key] ?? row.default;
          return { ...row, value, isDefault: value === row.default };
        }),
      })),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const runValues = async (values: Record<string, SettingValue | null>) => {
    const keys = Object.keys(values);
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !keys.includes(key))));
    try { await save.mutate({ values }); }
    catch (error) { setErrors((current) => ({ ...current, ...Object.fromEntries(keys.map((key) => [key, rpcErrorInfo(error).message])) })); }
  };
  const run = async (key: string, value: SettingValue | null) => {
    await runValues({ [key]: value });
  };
  return { run, runValues, errors };
}

type Saver = ReturnType<typeof useSaveSetting>;

/** The plugin's rows of one section, in the server's order. */
function useSectionRows(section: SettingDto["section"]) {
  const query = useSettingRows();
  const rows = useMemo(() => (query.data?.settings ?? []).filter((row) => row.where === "plugin" && row.section === section), [query.data, section]);
  return { ...query, rows };
}

// ------------------------------------------------------------------ one row

function SettingRow({
  row,
  saver,
  sizes,
  describe,
}: {
  row: SettingDto;
  saver: Saver;
  /** Size settings: grey out what the plan can't use. */
  sizes?: readonly SandboxSizeDto[];
  /** Extra words under the description (a plan's cap, …). */
  describe?: ReactNode;
}) {
  const id = `ca-setting-${row.key}`;
  const error = saver.errors[row.key];
  const disabled = row.disabledReason !== null;
  const description = (
    <>
      <RichText text={row.description} />
      {describe ? <> {describe}</> : null}
    </>
  );
  const footer = error ? (
    <p id={`${id}-error`} role="alert" className="text-xs text-destructive-text">
      {error}
    </p>
  ) : null;
  const describedBy = error ? `${id}-error` : undefined;

  if (row.type === "boolean") {
    return (
      <SettingField
        label={row.label}
        description={description}
        placement="trailing"
        footer={footer}
        disabled={disabled}
        control={
          <Switch
            id={id}
            checked={row.value === true}
            disabled={disabled}
            aria-label={row.label}
            aria-describedby={describedBy}
            onCheckedChange={(checked) => void saver.run(row.key, checked)}
          />
        }
      />
    );
  }
  if (row.type === "select") {
    const options = row.options ?? [];
    return (
      <SettingField
        label={row.label}
        description={description}
        footer={footer}
        disabled={disabled}
        control={
          <Select value={String(row.value)} disabled={disabled} onValueChange={(next) => void saver.run(row.key, next)}>
            <SelectTrigger id={id} aria-label={row.label} aria-describedby={describedBy} className={SETTING_SELECT}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {options.map((option) => {
                const size = sizes?.find((entry) => entry.type === option.value);
                const locked = size !== undefined && !size.available && option.value !== row.value;
                return (
                  <SelectItem key={option.value} value={option.value} disabled={locked} textValue={option.label}>
                    {option.label}
                    {locked && size?.reason ? <span className="block text-xs text-muted-foreground">{size.reason}</span> : null}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        }
      />
    );
  }
  return <TextSettingRow row={row} saver={saver} id={id} description={description} footer={footer} disabled={disabled} describedBy={describedBy} />;
}

/** Text and number rows keep a draft while you type and save when you leave the field (or press Enter). */
function TextSettingRow({
  row,
  saver,
  id,
  description,
  footer,
  disabled,
  describedBy,
}: {
  row: SettingDto;
  saver: Saver;
  id: string;
  description: ReactNode;
  footer: ReactNode;
  disabled: boolean;
  describedBy: string | undefined;
}) {
  const saved = String(row.value);
  const [draft, setDraft] = useState<string | null>(null);
  // A save elsewhere (CLI, another window) shows up unless you're typing.
  useEffect(() => {
    if (draft === saved) setDraft(null);
  }, [draft, saved]);
  const value = draft ?? saved;
  const commit = () => {
    if (draft === null || draft === saved) {
      setDraft(null);
      return;
    }
    if (row.type === "number") {
      const trimmed = draft.trim();
      const number = Number(trimmed);
      void saver.run(row.key, trimmed === "" ? null : Number.isFinite(number) ? number : trimmed);
    } else {
      void saver.run(row.key, draft);
    }
  };
  const multiline = row.type === "string" && row.multiline;
  const control = multiline ? (
    <Textarea
      id={id}
      aria-label={row.label}
      aria-describedby={describedBy}
      value={value}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      spellCheck={false}
      className="max-h-96 min-h-24 w-full resize-y font-mono text-xs"
    />
  ) : (
    <Input
      id={id}
      type={row.type === "number" ? "number" : "text"}
      inputMode={row.type === "number" ? "decimal" : undefined}
      step={row.type === "number" ? (row.integer ? 1 : "any") : undefined}
      min={row.min ?? undefined}
      max={row.max ?? undefined}
      aria-label={row.label}
      aria-describedby={describedBy}
      aria-invalid={footer ? true : undefined}
      value={value}
      disabled={disabled}
      placeholder={row.type === "string" && row.default === "" ? (PLACEHOLDER[row.key] ?? "Empty") : undefined}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") setDraft(null);
      }}
      spellCheck={false}
      className={SETTING_INPUT}
    />
  );
  return (
    <SettingField
      label={row.label}
      description={description}
      placement={multiline ? "below" : "inline"}
      footer={footer}
      control={control}
      labelFor={id}
      disabled={disabled}
    />
  );
}

function Rows({ rows, saver, extra }: { rows: readonly SettingDto[]; saver: Saver; extra?: (row: SettingDto) => { sizes?: readonly SandboxSizeDto[]; describe?: ReactNode } }) {
  return (
    <>
      {rows.map((row) => (
        <SettingRow key={row.key} row={row} saver={saver} {...(extra?.(row) ?? {})} />
      ))}
    </>
  );
}

function Loading({ error, rows }: { error: { message: string } | null; rows: number }) {
  if (error) return <InlineAlert>{error.message}</InlineAlert>;
  return rows === 0 ? <EmptyBox>Loading settings…</EmptyBox> : null;
}

function SubHeading({ children, description }: { children: ReactNode; description?: ReactNode }) {
  return (
    <div className="space-y-0.5 pt-2">
      <h4 className="text-sm font-medium text-foreground">{children}</h4>
      {description ? <p className="text-xs text-pretty text-muted-foreground">{description}</p> : null}
    </div>
  );
}

// ------------------------------------------------------------------ Setup

/** The setup checklist, where screenshots and recordings go, and the boat CLI location when it wasn't found. */
export function SetupSettings() {
  const { rows, data, error } = useSectionRows("setup");
  const saver = useSaveSetting();
  const evidence = rows.find((row) => row.key === "evidenceUploader");
  const cliPath = data?.settings.find((row) => row.key === "boatPath");
  return (
    <div className="space-y-4">
      <SetupChecklist />
      <Loading error={error} rows={rows.length} />
      {evidence || (data?.cliFound === false && cliPath) ? (
        <SettingsCard>
          {evidence ? <EvidenceRow row={evidence} saver={saver} /> : null}
          {data?.cliFound === false && cliPath ? <SettingRow row={cliPath} saver={saver} describe="The plugin couldn't find the boat CLI; reload the plugin after setting it." /> : null}
        </SettingsCard>
      ) : null}
    </div>
  );
}

const EVIDENCE_OPTIONS: { value: EvidenceMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "builtin", label: "Built-in uploader" },
  { value: "script", label: "Your own script" },
];

/** Screenshots and recordings: Off, the built-in uploader (an S3-compatible bucket), or your own script. */
function EvidenceRow({ row, saver }: { row: SettingDto; saver: Saver }) {
  const saved = String(row.value);
  const savedMode = evidenceMode(saved);
  // "Your own script" stays chosen while its field is still empty.
  const [mode, setMode] = useState<EvidenceMode>(savedMode);
  const [draft, setDraft] = useState(savedMode === "script" ? saved : "");
  useEffect(() => {
    setMode((current) => (current === "script" && savedMode === "off" ? current : savedMode));
    if (savedMode === "script") setDraft(saved);
  }, [saved, savedMode]);
  const error = saver.errors[row.key];

  const choose = (next: EvidenceMode) => {
    setMode(next);
    if (next === "off") void saver.run(row.key, "");
    else if (next === "builtin") void saver.run(row.key, "builtin");
    else if (draft.trim() !== "") void saver.run(row.key, draft.trim());
  };
  const commitScript = () => {
    if (draft.trim() !== saved) void saver.run(row.key, draft.trim());
  };

  return (
    <SettingField
      label={row.label}
      labelFor="ca-setting-evidence"
      description="Agents upload screenshots and recordings of their work before the sandbox is deleted, and link them in their report."
      control={
        <Select value={mode} onValueChange={(next) => choose(next as EvidenceMode)}>
          <SelectTrigger id="ca-setting-evidence" aria-label={row.label} className={SETTING_SELECT}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {EVIDENCE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
      footer={
        <div className="space-y-2 pt-1">
          {mode === "builtin" ? (
            <div className="rounded-md border border-border bg-card px-3 py-2.5 text-xs text-muted-foreground">
              <p className="text-pretty">
                Uploads to any S3-compatible bucket (Cloudflare R2, AWS S3, MinIO) and links each file for up to 7 days. Set these in your boat environment
                (boat.dev → Environment), never here:
              </p>
              <ul className="mt-1.5 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
                {EVIDENCE_VARIABLES.map((variable) => (
                  <li key={variable.name} className="min-w-0">
                    <code className="font-mono text-[11px] text-foreground">{variable.name}</code> <span>{variable.note}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {mode === "script" ? (
            <div className="space-y-1">
              <Input
                aria-label="Your uploader script"
                value={draft}
                placeholder="owner/repo:path/to/upload.mjs@<commit>"
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitScript}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitScript();
                }}
                spellCheck={false}
                className="h-7 w-full font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">Fetched from GitHub with this computer's gh login. Pin a commit, so the script can't change under you.</p>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive-text">
              {error}
            </p>
          ) : null}
        </div>
      }
    />
  );
}

// ------------------------------------------------------------------ Usage limits

export function UsageLimitsSettings() {
  const { rows, data, error } = useSectionRows("usage-limits");
  const saver = useSaveSetting();
  const plain = rows.filter((row) => row.group === null);
  const switching = rows.filter((row) => row.group === "switching" && row.fold === null);
  const fineTune = rows.filter((row) => row.group === "switching" && row.fold !== null);
  const only = data?.onlyAgent ?? null;
  return (
    <div className="space-y-3">
      <Loading error={error} rows={rows.length} />
      {only !== null ? (
        <p className="text-xs text-muted-foreground">
          Switching agents needs both Claude and Codex; right now Coding agents uses only {only === "claude" ? "Claude" : "Codex"}.
        </p>
      ) : null}
      {rows.length > 0 ? (
        <SettingsCard>
          <Rows rows={plain} saver={saver} />
          {switching.length > 0 ? (
            <div className="space-y-4 border-t border-border pt-4">
              <Rows rows={switching} saver={saver} />
              {fineTune.length > 0 ? (
                <Disclosure label={fineTune[0]!.fold}>
                  <div className="space-y-4">
                    <Rows rows={fineTune} saver={saver} />
                  </div>
                </Disclosure>
              ) : null}
            </div>
          ) : null}
        </SettingsCard>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ Models

export function ModelsSettings() {
  const { rows, error } = useSectionRows("models");
  const saver = useSaveSetting();
  return (
    <div className="space-y-3">
      <ModelPresetsEditor />
      <SubHeading description="Tasks you start without a preset (from the page, a chat or the CLI) use these instead.">Overrides for tasks without a preset</SubHeading>
      <Loading error={error} rows={rows.length} />
      {rows.length > 0 ? (
        <SettingsCard>
          <Rows rows={rows} saver={saver} />
        </SettingsCard>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ Orchestrators (optional)

const SIZE_KEYS = new Set(["orchestratorMachineType"]);

export function OrchestratorsSettings() {
  const { rows, data, error } = useSectionRows("orchestrators");
  const saver = useSaveSetting();
  const sizes = useSandboxSizes().data?.sizes;
  const only = data?.onlyAgent ?? null;
  const extra = (row: SettingDto) => {
    if (SIZE_KEYS.has(row.key)) return { sizes };
    // Greyed out with one agent: say which one runs them.
    if (row.key === "relayPreferred" && only !== null) return { describe: `Coding agents uses only ${PROVIDER_LABEL[only]} now, so it runs every orchestrator.` };
    return {};
  };
  return (
    <div className="space-y-3">
      <Loading error={error} rows={rows.length} />
      {rows.length > 0 ? (
        <SettingsCard>
          <Rows rows={rows} saver={saver} extra={extra} />
          <OrchestratorCardRow />
        </SettingsCard>
      ) : null}
      <SubHeading description="The shared rules every orchestrator loads. A project's own rules file is read after it.">Protocol</SubHeading>
      <ProtocolEditor />
    </div>
  );
}

/** Only while the Cloud agents page's orchestrator card is hidden (its ×): brings it back, on every device. */
function OrchestratorCardRow() {
  const [hidden, setHidden] = useOrchestratorCardHidden();
  const orchestrators = useOrchestrators(hidden === true);
  if (hidden !== true) return null;
  // Not known yet: say nothing the page might not show.
  const hasOrchestrator = orchestrators.data?.orchestrators.some((entry) => !entry.archived) ?? true;
  return (
    <SettingField
      label="Orchestrator card"
      description={`Hidden. ${ORCHESTRATOR_CARD_RULE}`}
      control={
        <Button
          variant="outline"
          size="sm"
          className="h-7"
          onClick={(event) => {
            // The row goes at once: keep keyboard focus nearby.
            focusNeighbour(event.currentTarget);
            setHidden(false).then(() => {
              const { title, description } = cardShownToast(hasOrchestrator);
              toast.success(title, description ? { description } : undefined);
            }, showError);
          }}
        >
          Show the orchestrator card again
        </Button>
      }
    />
  );
}

// ------------------------------------------------------------------ Advanced

export function AdvancedSettings() {
  const { rows, error } = useSectionRows("advanced");
  const saver = useSaveSetting();
  const sizes = useSandboxSizes().data;
  const capHours = sizes?.autoStopCapHours ?? null;
  return (
    <Disclosure label="Show advanced settings" openLabel="Hide advanced settings">
      <div className="space-y-3">
        <Loading error={error} rows={rows.length} />
        {rows.length > 0 ? (
          <SettingsCard>
            <Rows
              rows={rows}
              saver={saver}
              extra={(row) =>
                row.key === "sandboxTtlHours" && capHours !== null
                  ? { describe: <span className={cn("text-warning-text")}>Your {sizes?.plan ?? "boat"} plan stops them after {capHours} {capHours === 1 ? "hour" : "hours"} at most.</span> }
                  : {}
              }
            />
          </SettingsCard>
        ) : null}
      </div>
    </Disclosure>
  );
}

/** One SDK settings section owns ordering; no host DOM or duplicate toggles. */
export function BoatSettings() {
  const compact = useIsCompactViewport();
  const query = useSettingRows();
  const frameRef = useSettingsFrameTweak(query.data?.settings.find((row) => row.key === "experimentalUiTweaks")?.value === true);
  return <div ref={frameRef} className="boat-ui">{compact ? <MobileBoatSettings /> : <DesktopBoatSettings />}</div>;
}

function DesktopBoatSettings() {
  const query = useSettingRows();
  const setup = useSetup().data;
  const savedTest = experimental_useRpcQuery({contract:rpcContract,method:"setupTestTask",input:null}).data?.task;
  const dimmed = setup !== undefined && setupNeedsWork(setup) && !setupTestPassed(savedTest ?? undefined);
  const saver = useSaveSetting();
  const sizes = useSandboxSizes().data?.sizes;
  const projects = useProjects().data?.projects ?? [];
  const navigate = useBbNavigate();
  const grouped = groupedSettings(query.data?.settings ?? []);
  const master = query.data?.settings.find((row) => row.key === "pushNotifications")?.value === true;
  return <div className="boat-settings space-y-[22px] text-[13px] leading-[18px]">
    <SetupChecklist />
    <Loading error={query.error} rows={query.data?.settings.length ?? 0} />
    {grouped.groups.map((group) => <section key={group.title} aria-label={group.title} className={cn("space-y-2", dimmed && "opacity-35")}>
      <h3 className="text-[13px] font-medium leading-[18px] text-[color:var(--boat-group-heading)]">{group.title}</h3>
      <div className="divide-y divide-[color:var(--boat-divider)] overflow-hidden rounded-[10px] border border-[var(--boat-setting-border)] bg-card">
        {group.rows.map((row) => <EverydaySettingRow key={row.key} row={row} saver={saver} sizes={sizes} master={master} />)}

      </div>
    </section>)}
    <div className={cn("space-y-2", dimmed && "opacity-35")}>
    <div className="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-[var(--boat-setting-border)] bg-card px-3.5 py-3">
      <div className="min-w-0 flex-1"><p className="text-[var(--boat-label)]">Projects</p><p className="mt-0.5 text-xs leading-[17px] text-muted-foreground">{projects.length ? `${projects.map((project) => project.name).join(", ")} · repos, how work lands, sizes, reviewers` : "Repos, how work lands, sizes, reviewers"}</p></div>
      <button type="button" className="text-xs leading-4 text-[#7AA7FF] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "projects" })}>Open the Projects page →</button>
    </div>
    <details className="rounded-[10px] border border-[var(--boat-setting-border)] bg-card px-3.5 py-3">
      <summary className="cursor-pointer text-[13px] text-[var(--boat-label)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Advanced<span className="mt-0.5 block text-xs leading-[17px] text-muted-foreground">Orchestrator protocol, Claude ↔ Codex switching, instructions for every task, backup and restore</span></summary>
      <div className="mt-5 space-y-5"><Rows rows={grouped.advanced} saver={saver} extra={() => ({ sizes })} /><ModelPresetsEditor /><ProtocolEditor /><BackupSettings /></div>
    </details>
    </div>
  </div>;
}

/** Artboard-sized rows, with the existing validated settings writes. */
function EverydaySettingRow({ row, saver, sizes, master }: { row: SettingDto; saver: Saver; sizes?: SandboxSizeDto[]; master: boolean }) {
  const copy = EVERYDAY_SETTING_COPY[row.key];
  const label = copy?.label ?? row.label;
  const description = copy?.description ?? row.description;
  const id = `boat-everyday-${row.key}`;
  const [draft, setDraft] = useState<string | null>(null);
  const category = row.key === "notifyNeedsYou" || row.key === "notifyReady" || row.key === "notifyProgress" ? row.key : null;
  const error = saver.errors[row.key];
  const disabled = row.disabledReason !== null;
  const selectClass = "h-[30px] w-44 rounded-md border-border bg-background px-2.5 text-[13px] text-[var(--boat-label)] shadow-none";
  let control: ReactNode;
  if (row.type === "boolean") control = <Switch id={id} aria-label={label} checked={row.value === true && (category === null || master)} disabled={disabled} onCheckedChange={(checked) => void (category ? saver.runValues(notificationSettingPatch(master, category, checked)) : saver.run(row.key, checked))} />;
  else if (row.type === "select" || row.key === "stopIdleAfterMinutes") {
    const options = row.key === "stopIdleAfterMinutes"
      ? [...new Map([[15,"15 minutes"],[30,"30 minutes"],[60,"1 hour"],[120,"2 hours"],[240,"4 hours"],[0,"Never"],[Number(row.value), Number(row.value) >= 60 && Number(row.value) % 60 === 0 ? `${Number(row.value)/60} ${Number(row.value) === 60 ? "hour" : "hours"}` : `${row.value} minutes`]].map(([value,label]) => [String(value), {value:String(value),label:String(label)}])).values()]
      : (row.options ?? []).map((option) => ({...option, label: row.key === "machineType" ? option.label.split(" (")[0]! : option.label}));
    control = <Select value={String(row.value)} disabled={disabled} onValueChange={(value) => void saver.run(row.key, row.key === "stopIdleAfterMinutes" ? Number(value) : value)}><SelectTrigger id={id} aria-label={label} className={selectClass}><SelectValue /></SelectTrigger><SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value} disabled={row.key === "machineType" && sizes?.some((size) => size.type === option.value && !size.available) && option.value !== row.value}>{option.label}</SelectItem>)}</SelectContent></Select>;
  } else control = <Input id={id} aria-label={label} type="number" min={row.min ?? undefined} max={row.max ?? undefined} value={draft ?? String(row.value)} disabled={disabled} className={selectClass} onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft !== null && Number(draft) !== row.value) void saver.run(row.key, draft.trim() === "" ? null : Number(draft)); setDraft(null); }} />;
  return <div className="flex items-start gap-6 px-3.5 py-3"><div className="min-w-0 flex-1"><label htmlFor={id} className="block text-[13px] font-normal leading-[18px] text-[var(--boat-label)]">{label}</label><p className="mt-0.5 text-xs leading-[17px] text-muted-foreground">{description}</p>{error ? <p role="alert" className="mt-1 text-xs text-[#E06C6C]">{error}</p> : null}</div><div className="shrink-0">{control}</div></div>;
}

/** Mobile settings use the same actual settings, with one notification switch. */
export function MobileBoatSettings() {
  const query = useSettingRows();
  const setup = useSetup().data;
  const usage = experimental_useRpcQuery({contract: rpcContract, method:"fidelityUsage", input:{timezoneOffsetMinutes: new Date().getTimezoneOffset()}}).data;
  const saver = useSaveSetting();
  const navigate = useBbNavigate();
  const rows = query.data?.settings ?? [];
  const master = rows.find((row) => row.key === "pushNotifications")?.value === true;
  return <div className="space-y-3.5 text-sm">
    <div className="flex items-center gap-2 rounded-[12px] border border-border bg-[var(--boat-mobile-card)] px-3.5 py-3 text-[14px] leading-[19px]"><span aria-hidden className={cn("size-[7px] shrink-0 rounded-full",setup?.ok ? "bg-[#5BD08A]" : "bg-[#F0B135]")} /><span>{setup === undefined ? "Checking cloud agents…" : setup.ok ? ["All set",setup.plan?.maxActiveSandboxes ? `${setup.plan.activeSandboxes} of ${setup.plan.maxActiveSandboxes} sandboxes on` : null,usage?.plan?.hoursRemaining !== null && usage?.plan?.hoursRemaining !== undefined ? `${usage.plan.hoursRemaining.toLocaleString()} h left` : null].filter(Boolean).join(" · ") : "Cloud agents need setup"}</span></div>
    <div className="divide-y divide-border overflow-hidden rounded-[12px] border border-border bg-[var(--boat-mobile-card)]">
      {rows.filter((row) => ["notifyNeedsYou","notifyReady","avoidExtraUsage"].includes(row.key)).sort((a,b)=>["notifyNeedsYou","notifyReady","avoidExtraUsage"].indexOf(a.key)-["notifyNeedsYou","notifyReady","avoidExtraUsage"].indexOf(b.key)).map((row) => <div key={row.key} className="flex items-center gap-3 px-3.5 py-3"><div className="min-w-0 flex-1"><p className="text-[15px] leading-5 text-[color:var(--boat-heading)]">{row.key === "avoidExtraUsage" ? "Don’t start on paid extra usage" : row.label}</p><p className="mt-0.5 text-[13px] leading-[18px] text-muted-foreground">{row.key === "notifyNeedsYou" ? "A decision or an OK waits on you" : row.key === "notifyReady" ? "A change is reviewed and can ship" : "New tasks wait for the reset"}</p>{saver.errors[row.key] ? <p role="alert" className="text-xs text-[#E06C6C]">{saver.errors[row.key]}</p> : null}</div><Switch aria-label={row.label} className="h-[26px] w-[44px] border-0 p-[3px] data-[state=checked]:bg-primary [&>span]:size-5 [&>span]:data-[state=checked]:translate-x-[18px] [&>span]:data-[state=checked]:bg-[var(--boat-mobile-card)] [&>span]:data-[state=unchecked]:translate-x-0" checked={row.value===true&&(row.key==="avoidExtraUsage"||master)} onCheckedChange={(checked)=>void(row.key==="notifyNeedsYou"||row.key==="notifyReady" ? saver.runValues(notificationSettingPatch(master,row.key,checked)) : saver.run(row.key,checked))}/></div>)}
    </div>
    <p className="text-[13px] leading-[18px] text-[var(--boat-faint)]">Everything else is in Settings on your computer.</p>
  </div>;
}
