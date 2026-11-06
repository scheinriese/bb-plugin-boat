// The orchestrator protocol editor (Settings → Orchestrators (optional)) and
// the model presets table (Settings → Models).
//
// The protocol is a Markdown file in the plugin's data folder; while none
// exists the built-in text applies. Edits stay local until saved. Without
// edits the editor follows the file, so changes made elsewhere show up here.
// Its {{…}} template fields are marked in the editor and explained under it.
import { useRef, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from "react";
import { toast } from "sonner";
import { experimental_useRpcMutation } from "@get-bb/plugin-sdk/app";
import {
  EFFORT_VALUES,
  PROVIDER_VALUES,
  TIER_VALUES,
  rpcContract,
  tierMapSchema,
  type TierMapDto,
} from "../contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { COARSE_POINTER_TEXT_BASE_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { cn, formatHomePathForDisplay } from "@/lib/utils";
import { ConfirmDialog, submitOnModEnter } from "./dialogs";
import { PROVIDER_SHORT, capitalize, relativeTime, type Provider } from "./format";
import { useCopy, useModelTiers, useNow, useProtocol } from "./hooks";
import { PROTOCOL_PLACEHOLDERS, splitPlaceholders } from "./logic";
import { EmptyBox, IconButton, InlineAlert, Kbd, showError } from "./ui";

type Tier = (typeof TIER_VALUES)[number];
type Effort = (typeof EFFORT_VALUES)[number];
type TierChoice = TierMapDto[Tier][Provider];

const TIER_HINT: Record<Tier, string> = {
  light: "Mechanical or exactly specified work",
  review: "Reviews, audits, small known fixes",
  build: "Normal implementation and debugging",
  deep: "Parallel exploration and independent checks",
  frontier: "Only after Deep fell short; max and above need your OK",
};

const EFFORT_LABEL: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultracode: "Ultracode",
  ultra: "Ultra",
};

/** The levels each agent takes: Ultracode is Claude's top level, Ultra is Codex's. */
const PROVIDER_EFFORTS: Record<Provider, readonly Effort[]> = {
  claude: ["low", "medium", "high", "xhigh", "max", "ultracode"],
  codex: ["low", "medium", "high", "xhigh", "max", "ultra"],
};

const NO_ERRORS: Record<string, string> = {};

function Code({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <code title={title} className={cn("rounded bg-secondary px-1 py-0.5 font-mono text-[11px]", className)}>
      {children}
    </code>
  );
}

// ------------------------------------------------------------------ protocol

/** Unsaved edits, and the file text they started from. */
interface ProtocolDraft {
  text: string;
  base: string;
}

/** The shared protocol every orchestrator loads, with its template fields marked. */
export function ProtocolEditor() {
  const { data, error } = useProtocol();
  const now = useNow();
  const copy = useCopy();
  const save = experimental_useRpcMutation({
    contract: rpcContract,
    method: "saveProtocol",
    optimistic: (input, cache) =>
      cache.update("protocol", null, (current) => ({ ...current, text: input.text, custom: true })),
  });
  const reset = experimental_useRpcMutation({
    contract: rpcContract,
    method: "resetProtocol",
    optimistic: (_input, cache) =>
      cache.update("protocol", null, (current) => ({
        ...current,
        text: current.defaultText,
        custom: false,
        updatedAt: null,
      })),
  });
  const [draft, setDraft] = useState<ProtocolDraft | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);

  if (data === undefined) {
    return error ? <InlineAlert>{error.message}</InlineAlert> : <EmptyBox>Loading the protocol…</EmptyBox>;
  }

  const saved = data.text;
  const text = draft?.text ?? saved;
  const dirty = draft !== null && draft.text !== saved;
  // The file changed (in an editor, say) after these edits started.
  const changedElsewhere = draft !== null && dirty && draft.base !== saved;
  const empty = text.trim() === "";
  const over = text.length - data.maxChars;
  const canSave = dirty && !empty && over <= 0 && !save.isPending;
  const savedAgo = relativeTime(data.updatedAt, now);
  const status = !data.custom ? "Built-in protocol" : savedAgo ? `Customized · saved ${savedAgo}` : "Customized";

  // Typing back to the saved text drops the draft, so the editor follows the file again.
  const edit = (value: string) =>
    setDraft((current) => (value === saved ? null : { text: value, base: current?.base ?? saved }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave) return;
    const sent = text;
    try {
      await save.mutate({ text: sent });
      // Keep anything typed while saving; the file now holds `sent`.
      setDraft((current) => (current === null || current.text === sent ? null : { ...current, base: sent }));
      toast.success("Saved the protocol");
    } catch (failure) {
      showError(failure);
    }
  };

  const runReset = async () => {
    try {
      await reset.mutate(null);
      setDraft(null);
      setConfirmingReset(false);
      toast.success("Restored the built-in protocol");
    } catch (failure) {
      showError(failure);
    }
  };

  return (
    <>
      <form onSubmit={submit} className="space-y-3">
        <div className="flex min-h-8 items-center gap-2">
          <p className="text-xs tabular-nums text-muted-foreground">
            {status}
            {dirty ? " · unsaved changes" : null}
          </p>
          {data.custom ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto h-7 px-2 text-muted-foreground"
              onClick={() => setConfirmingReset(true)}
            >
              Reset to built-in
            </Button>
          ) : null}
        </div>
        {error ? <InlineAlert>{error.message}</InlineAlert> : null}
        {changedElsewhere ? (
          <InlineAlert tone="warning">
            The file changed while you were editing. Saving replaces it with your version; discard your changes to
            load the new one.
          </InlineAlert>
        ) : null}
        <MarkedTextarea value={text} onChange={edit} />
        <div id="ca-protocol-hint" className="space-y-2 text-xs text-muted-foreground">
          <TemplateFields text={text} />
          <p>
            <Kbd>⌘</Kbd> <Kbd>Enter</Kbd> to save.
          </p>
          <div className="flex min-w-0 items-start gap-1">
            <p className="min-w-0 py-1">
              {data.custom ? "Stored in " : "Saving creates "}
              <Code className="select-all break-all" title={data.path}>
                {formatHomePathForDisplay(data.path)}
              </Code>
              {data.custom ? ". You can also edit that file directly." : ". You can also write that file yourself."}
            </p>
            <IconButton
              type="button"
              label="Copy path"
              icon="Copy"
              className="size-6 shrink-0"
              onClick={() => void copy(data.path, "Path copied")}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <p
            className={cn(
              "mr-auto text-xs tabular-nums",
              empty || over > 0 ? "text-destructive-text" : "text-muted-foreground",
            )}
          >
            {over > 0
              ? `${over.toLocaleString()} characters over the limit`
              : empty
                ? "The protocol can't be empty"
                : `${text.length.toLocaleString()} / ${data.maxChars.toLocaleString()} characters`}
          </p>
          {dirty ? (
            <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => setDraft(null)}>
              Discard changes
            </Button>
          ) : null}
          <Button type="submit" size="sm" className="h-7" disabled={!canSave}>
            {save.isPending ? <Icon name="Loading" className="animate-spin" /> : null}
            Save protocol
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirmingReset}
        onOpenChange={setConfirmingReset}
        title="Reset to the built-in protocol?"
        description={
          dirty
            ? "Your protocol file and unsaved changes are deleted. Orchestrators get the built-in protocol the next time they load it."
            : "Your protocol file is deleted. Orchestrators get the built-in protocol the next time they load it."
        }
        confirmLabel="Reset protocol"
        destructive
        pending={reset.isPending}
        onConfirm={() => void runReset()}
      />
    </>
  );
}

// ------------------------------------------------------------ template fields

/** The look of a {{field}} in the editor and in its legend. */
const FIELD_MARK = "rounded-[3px] bg-primary/12 text-transparent ring-1 ring-primary/35";
const UNKNOWN_MARK = "rounded-[3px] bg-warning/15 text-transparent outline-1 outline-dashed outline-warning/70";

/**
 * A textarea whose {{fields}} show as chips: a copy of the text sits behind
 * it (same box, font and wrapping) with only the fields painted, and follows
 * its scrolling. The text itself stays plain and editable.
 */
function MarkedTextarea({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const backdrop = useRef<HTMLDivElement>(null);
  const box = "font-mono text-xs leading-relaxed [scrollbar-gutter:stable]";
  return (
    <div className="relative">
      <div
        ref={backdrop}
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words rounded-md border border-transparent px-3 py-2 text-transparent",
          COARSE_POINTER_TEXT_BASE_CLASS,
          box,
        )}
      >
        {splitPlaceholders(value).map((segment, index) =>
          segment.kind === "field" ? (
            <mark key={index} className={segment.known ? FIELD_MARK : UNKNOWN_MARK}>
              {segment.text}
            </mark>
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )}
        {"\n"}
      </div>
      <Textarea
        id="ca-protocol-text"
        aria-label="Orchestrator protocol"
        aria-describedby="ca-protocol-hint"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={submitOnModEnter}
        onScroll={(event) => {
          if (backdrop.current) backdrop.current.scrollTop = event.currentTarget.scrollTop;
        }}
        rows={18}
        spellCheck={false}
        className={cn("relative min-h-64 resize-y", box)}
      />
    </div>
  );
}

/** What each {{field}} becomes, as chips matching the editor's marks; unknown fields get a note. */
function TemplateFields({ text }: { text: string }) {
  const used = new Set(splitPlaceholders(text).flatMap((segment) => (segment.kind === "field" ? [segment.text] : [])));
  const unknown = [...used].filter((token) => !PROTOCOL_PLACEHOLDERS.some((entry) => entry.token === token));
  return (
    <div className="space-y-1">
      <p>Template fields: the plugin fills them in when an orchestrator loads the protocol. Edit around them, or move them.</p>
      <ul aria-label="Template fields" className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        {PROTOCOL_PLACEHOLDERS.map((entry) => (
          <li key={entry.token} className={cn("flex min-w-0 items-baseline gap-1.5", !used.has(entry.token) && "opacity-60")}>
            <code className="shrink-0 rounded-[3px] bg-primary/12 px-1 py-0.5 font-mono text-[11px] text-foreground ring-1 ring-primary/35">
              {entry.token}
            </code>
            <span className="min-w-0">
              {entry.meaning}
              {used.has(entry.token) ? null : " (not used)"}
            </span>
          </li>
        ))}
      </ul>
      {unknown.length > 0 ? (
        <p className="text-warning-text">
          {unknown.join(", ")} {unknown.length === 1 ? "isn't a field" : "aren't fields"} the plugin fills in, so {unknown.length === 1 ? "it stays" : "they stay"} as typed.
        </p>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------- model presets

/** The model presets (Light, Review, Build, Deep, Frontier): model and effort per agent. */
export function ModelPresetsEditor() {
  const { data, error } = useModelTiers();
  const reset = experimental_useRpcMutation({
    contract: rpcContract,
    method: "resetModelTiers",
    optimistic: (_input, cache) =>
      cache.update("modelTiers", null, (current) => ({ ...current, tiers: current.defaults, custom: false })),
  });
  const [draft, setDraft] = useState<TierMapDto | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const runReset = async () => {
    try {
      await reset.mutate(null);
      setDraft(null);
      setConfirmingReset(false);
      toast.success("Restored the default presets");
    } catch (failure) {
      showError(failure);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex min-h-8 items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-pretty text-muted-foreground">
          Model presets apply to every task started with one (orchestrators always pick one): the task runs that preset's model and effort on its agent.
        </p>
        {data?.custom ? (
          <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-muted-foreground" onClick={() => setConfirmingReset(true)}>
            Reset to defaults
          </Button>
        ) : null}
      </div>
      {error ? <InlineAlert>{error.message}</InlineAlert> : null}
      {data ? (
        <TiersForm saved={data.tiers} draft={draft} onDraftChange={setDraft} />
      ) : error ? null : (
        <EmptyBox>Loading model presets…</EmptyBox>
      )}
      <ConfirmDialog
        open={confirmingReset}
        onOpenChange={setConfirmingReset}
        title="Reset model presets?"
        description="Every preset goes back to its default model and effort. Tasks already running keep theirs."
        confirmLabel="Reset presets"
        destructive
        pending={reset.isPending}
        onConfirm={() => void runReset()}
      />
    </div>
  );
}

function TiersForm({
  saved,
  draft,
  onDraftChange,
}: {
  saved: TierMapDto;
  draft: TierMapDto | null;
  onDraftChange: Dispatch<SetStateAction<TierMapDto | null>>;
}) {
  const save = experimental_useRpcMutation({
    contract: rpcContract,
    method: "saveModelTiers",
    optimistic: (input, cache) =>
      cache.update("modelTiers", null, (current) => ({ ...current, tiers: input.tiers, custom: true })),
  });
  const tiers = draft ?? saved;
  const dirty = draft !== null && !sameTiers(draft, saved);
  const parsed = tierMapSchema.safeParse(tiers);
  const errors = parsed.success ? NO_ERRORS : fieldErrors(parsed.error.issues);
  const canSave = dirty && parsed.success && !save.isPending;

  // Matching the saved table again drops the draft, so the form follows the server.
  const update = (tier: Tier, provider: Provider, patch: Partial<TierChoice>) =>
    onDraftChange((current) => {
      const base = current ?? saved;
      const next: TierMapDto = {
        ...base,
        [tier]: { ...base[tier], [provider]: { ...base[tier][provider], ...patch } },
      };
      return sameTiers(next, saved) ? null : next;
    });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave || !parsed.success) return;
    const sent = draft;
    try {
      await save.mutate({ tiers: parsed.data });
      // Keep anything changed while saving.
      onDraftChange((current) => (current === sent ? null : current));
      toast.success("Saved the model presets");
    } catch (failure) {
      showError(failure);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <ul aria-label="Model presets" className="@container divide-y divide-border rounded-lg border border-border bg-card">
        {TIER_VALUES.map((tier) => (
          <li key={tier} className="space-y-2 px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-sm font-medium text-foreground">{capitalize(tier)}</span>
              <span className="text-xs text-muted-foreground">{TIER_HINT[tier]}</span>
            </div>
            {/* Claude and Codex side by side once the panel has room, stacked otherwise. */}
            <div className="grid gap-2 @2xl:grid-cols-2 @2xl:gap-4">
              {PROVIDER_VALUES.map((provider) => (
                <TierChoiceFields
                  key={provider}
                  tier={tier}
                  provider={provider}
                  value={tiers[tier][provider]}
                  modelError={errors[`${tier}.${provider}.model`]}
                  effortError={errors[`${tier}.${provider}.effort`]}
                  onChange={(patch) => update(tier, provider, patch)}
                />
              ))}
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-xs text-muted-foreground">
          Ultracode and Ultra only work in task chats; tasks headless in boat stop at Max.
        </p>
        {dirty ? (
          <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => onDraftChange(null)}>
            Discard changes
          </Button>
        ) : null}
        <Button type="submit" size="sm" className="h-7" disabled={!canSave}>
          {save.isPending ? <Icon name="Loading" className="animate-spin" /> : null}
          Save presets
        </Button>
      </div>
    </form>
  );
}

function TierChoiceFields({
  tier,
  provider,
  value,
  modelError,
  effortError,
  onChange,
}: {
  tier: Tier;
  provider: Provider;
  value: TierChoice;
  modelError: string | undefined;
  effortError: string | undefined;
  onChange: (patch: Partial<TierChoice>) => void;
}) {
  const id = `ca-tier-${tier}-${provider}`;
  const name = `${capitalize(tier)} preset, ${PROVIDER_SHORT[provider]}`;
  const error = modelError ?? effortError;
  // Keep a saved level the agent doesn't take visible, so its error makes sense.
  const levels = PROVIDER_EFFORTS[provider];
  const efforts = levels.includes(value.effort) ? levels : [...levels, value.effort];
  return (
    <div className="grid grid-cols-[2.75rem_minmax(0,1fr)_7rem] items-center gap-x-1.5 gap-y-1">
      <span aria-hidden className="text-xs text-muted-foreground">
        {PROVIDER_SHORT[provider]}
      </span>
      <Input
        id={`${id}-model`}
        aria-label={`${name} model`}
        aria-invalid={modelError ? true : undefined}
        aria-describedby={modelError ? `${id}-error` : undefined}
        value={value.model}
        onChange={(event) => onChange({ model: event.target.value })}
        spellCheck={false}
        maxLength={120}
        className={cn("font-mono text-xs", modelError && "border-destructive")}
      />
      <Select value={value.effort} onValueChange={(next) => onChange({ effort: next as Effort })}>
        <SelectTrigger
          id={`${id}-effort`}
          aria-label={`${name} effort`}
          aria-invalid={effortError ? true : undefined}
          aria-describedby={effortError && !modelError ? `${id}-error` : undefined}
          className={cn("text-xs", effortError && "border-destructive")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {efforts.map((effort) => (
            <SelectItem key={effort} value={effort}>
              {EFFORT_LABEL[effort]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? (
        <p id={`${id}-error`} className="col-span-2 col-start-2 text-xs text-destructive-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function sameTiers(a: TierMapDto, b: TierMapDto): boolean {
  return TIER_VALUES.every((tier) =>
    PROVIDER_VALUES.every(
      (provider) =>
        a[tier][provider].model === b[tier][provider].model && a[tier][provider].effort === b[tier][provider].effort,
    ),
  );
}

/** The first message per field, keyed like the issue path ("build.claude.model"). */
function fieldErrors(issues: readonly { path: readonly PropertyKey[]; message: string }[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join(".");
    errors[key] ??= issue.message;
  }
  return errors;
}
