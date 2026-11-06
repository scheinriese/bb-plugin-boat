// The plugin's own settings sections (Settings → Plugins → Boat Cloud
// Agents, below bb's list): Setup, Usage limits, Models, Orchestrators
// (optional) and Advanced. Projects and Back up and restore have their own
// files. Rows look and behave like bb's own settings list: switches and
// selects save at once, text and numbers when you leave the field.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { experimental_useRpcMutation } from "@get-bb/plugin-sdk/app";
import { rpcContract, rpcErrorInfo, type SandboxSizeDto, type SettingDto } from "../contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { PROVIDER_LABEL } from "./format";
import { useOrchestratorCardHidden, useOrchestrators, useSandboxSizes, useSettingRows } from "./hooks";
import { EVIDENCE_VARIABLES, ORCHESTRATOR_CARD_RULE, cardShownToast, evidenceMode, type EvidenceMode } from "./logic";
import { ModelPresetsEditor, ProtocolEditor } from "./protocol-settings";
import { SetupChecklist } from "./setup";
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
  const run = async (key: string, value: SettingValue | null) => {
    setErrors(({ [key]: _dropped, ...rest }) => rest);
    try {
      await save.mutate({ values: { [key]: value } });
    } catch (error) {
      setErrors((current) => ({ ...current, [key]: rpcErrorInfo(error).message }));
    }
  };
  return { run, errors };
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
