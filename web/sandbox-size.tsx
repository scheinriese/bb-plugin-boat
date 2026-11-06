// Sandbox sizes and memory on the task page and in project settings: the
// out-of-memory alert with "Continue on a larger sandbox", a move in
// progress or one that failed, a measured turn's peak memory, the size in
// the Sandbox row with Change size…, the dialog that moves a sandbox, and a
// project's Sandbox size field.
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { experimental_useRpcMutation, experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { MACHINE_TYPE_VALUES, rpcContract, type TaskDetailDto } from "../contract";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { OptionLabel, SubmitButton, submitOnModEnter } from "./dialogs";
import { MACHINE_LABEL, plural, type MachineType } from "./format";
import { useOverview, useSandboxSizes } from "./hooks";
import { costHint, isSmaller, peakSentence, resizeMessage, sizeName, suggestedSize } from "./logic";
import { Disclosure, Field, InlineAlert, showError } from "./ui";

type Memory = NonNullable<TaskDetailDto["memory"]>;
const LABEL: Record<MachineType, string> = { small: "Small", default: "Default", large: "Large", xlarge: "XLarge" };

/**
 * "Use Large for Web app": saves the project's size, says what the plan
 * thinks of it. XLarge for every task of a project asks first (it costs the
 * most); `confirm` is the dialog for that.
 */
function useProjectSize() {
  const set = experimental_useRpcMutation({ contract: rpcContract, method: "setProjectSize" });
  const [asking, setAsking] = useState<{ projectId: string; name: string } | null>(null);
  const save = async (projectId: string, type: MachineType) => {
    try {
      const saved = await set.mutate({ projectId, machineType: type });
      if (saved.allowed) toast.success(`${saved.name} now uses ${LABEL[type]} sandboxes`);
      else toast.warning(`${saved.name} now uses ${LABEL[type]} sandboxes`, { description: `Your boat plan doesn't include it yet: ${saved.reason ?? "not on your plan"}.` });
    } catch (error) {
      showError(error);
    }
  };
  const apply = (project: { id: string; name: string }, type: MachineType) => {
    if (type === "xlarge") setAsking({ projectId: project.id, name: project.name });
    else void save(project.id, type);
  };
  const confirm = (
    <Dialog open={asking !== null} onOpenChange={(open) => (open ? undefined : setAsking(null))}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Use XLarge for {asking?.name}?</DialogTitle>
          <DialogDescription className="text-pretty">
            Every new task of {asking?.name} and its reviews then starts on {sizeName("xlarge")}. {costHint("xlarge", "large")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setAsking(null)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={set.isPending}
            onClick={() => {
              const target = asking;
              setAsking(null);
              if (target !== null) void save(target.projectId, "xlarge");
            }}
          >
            Use XLarge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { apply, pending: set.isPending, confirm };
}

/** After a move starts, focus goes to its status card (the button that opened the dialog is gone), else to the sandbox's size. */
function focusAfterMove(pending: boolean): void {
  const until = Date.now() + (pending ? 2_000 : 0);
  const tick = () => {
    const status = document.getElementById("ca-resize-status");
    if (status !== null) return status.focus();
    if (Date.now() < until) return void requestAnimationFrame(tick);
    document.getElementById("ca-sandbox-size")?.focus();
  };
  tick();
}

/** A button whose label wraps on a narrow screen instead of overflowing it. */
const WRAPPING = "h-auto min-h-7 whitespace-normal py-1 text-left";

// ------------------------------------------------------------------ the panel

/** Under the task's facts: a move in progress or failed, an out-of-memory alert, and a measured turn's peak. */
export function SandboxSizePanel({ task }: { task: TaskDetailDto }) {
  const memory = task.memory;
  const [resizing, setResizing] = useState<"oom" | "general" | null>(null);
  const project = useProjectSize();
  if (memory === null) return null;
  const moving = memory.resize?.state === "running";
  const body: ReactNode[] = [];

  if (memory.resize?.state === "running") {
    const step = {
      stopping: "Stopping the sandbox",
      starting: `Starting it on ${LABEL[memory.resize.to]}`,
      reconnecting: "Waiting for bb to reconnect",
      sending: "Sending your message",
    }[memory.resize.step ?? "stopping"];
    body.push(
      <div
        key="moving"
        id="ca-resize-status"
        role="status"
        tabIndex={-1}
        className="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Icon name="Loading" className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium text-pretty text-foreground">Moving the sandbox to {memory.resize.toSummary}…</p>
          <p className="text-xs text-pretty text-muted-foreground">
            {step}. This takes a few minutes. Its files stay; running processes stop.
          </p>
        </div>
      </div>,
    );
  } else if (memory.resize?.state === "failed") {
    body.push(
      <InlineAlert key="failed">
        <p>{memory.resize.error}</p>
        {/* After the size changed only the message is left: the reply box below sends it. */}
        {memory.canResize && !memory.resize.moved ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="h-7" onClick={() => setResizing("general")}>
              Try again…
            </Button>
          </div>
        ) : null}
      </InlineAlert>,
    );
  }

  if (memory.oom !== null && !moving) {
    const next = memory.next;
    // Moved since: nothing to continue onto.
    const canContinue = memory.canResize && memory.oom.movedTo === null;
    // Only ever a larger size for the project, never a smaller one.
    const offerProject = memory.project !== null && next !== null && next.available && isSmaller(memory.project.effective, next.type);
    body.push(
      <InlineAlert key="oom">
        <p className="whitespace-pre-wrap">{memory.oom.message}</p>
        {memory.oom.original ? (
          <Disclosure label="Original error" className="mt-2">
            <p className="whitespace-pre-wrap break-words text-xs">{memory.oom.original}</p>
          </Disclosure>
        ) : null}
        {next !== null && !next.available && memory.oom.movedTo === null ? (
          <p className="mt-2 text-xs text-pretty">
            Your boat plan doesn't include {next.label}: {next.reason?.replace(/[.\s]+$/, "") ?? "not on your plan"}.
          </p>
        ) : next !== null && (canContinue || offerProject) ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {canContinue ? (
              <Button size="sm" className={WRAPPING} onClick={() => setResizing("oom")}>
                Continue on a larger sandbox…
              </Button>
            ) : null}
            {offerProject ? (
              <Button variant="outline" size="sm" className={WRAPPING} disabled={project.pending} onClick={() => project.apply(memory.project!, next.type)}>
                Use {next.label} for {memory.project!.name} from now on
              </Button>
            ) : null}
          </div>
        ) : null}
      </InlineAlert>,
    );
  }

  if (memory.peak !== null && memory.recommendation !== null) {
    const rec = memory.recommendation;
    const offerProject = memory.project !== null && rec.allowed && rec.reason !== "largest" && memory.project.effective !== rec.type && !memory.peak.shared;
    body.push(
      <div key="peak" className="flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-3 sm:flex-row sm:items-center">
        <Icon name="Gauge" className="hidden size-4 shrink-0 text-muted-foreground sm:block" aria-hidden />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium text-foreground">
            Peak memory: <span className="tabular-nums">{memory.peak.usedGb.toFixed(1)}</span> of {memory.peak.totalGb} GB
            {memory.peak.swapGb !== null ? <span className="font-normal text-muted-foreground"> ({memory.peak.swapGb.toFixed(1)} GB in swap)</span> : null}
          </p>
          <p className="text-xs text-pretty text-muted-foreground">{peakSentence(memory)}</p>
        </div>
        {offerProject ? (
          <Button size="sm" className={cn("shrink-0 self-start sm:self-auto", WRAPPING)} disabled={project.pending} onClick={() => project.apply(memory.project!, rec.type)}>
            Use {rec.label} for {memory.project!.name}
          </Button>
        ) : null}
      </div>,
    );
  }

  if (body.length === 0 && resizing === null) return project.confirm;
  return (
    <>
      {body}
      <ResizeDialog task={task} mode={resizing ?? "general"} open={resizing !== null} onOpenChange={(open) => setResizing(open ? (resizing ?? "general") : null)} />
      {project.confirm}
    </>
  );
}

// ------------------------------------------------------------------ the Sandbox row

/** "Default · 4 vCPU, 8 GB" and Change size… in the task's Sandbox row. */
export function SandboxSizeLabel({ task }: { task: TaskDetailDto }) {
  const [open, setOpen] = useState(false);
  const memory = task.memory;
  if (memory === null || (memory.size === null && !memory.canResize)) return null;
  return (
    <>
      {memory.size !== null ? (
        <span id="ca-sandbox-size" tabIndex={-1} className="rounded-sm text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          {memory.size.label} · {memory.size.summary}
        </span>
      ) : null}
      {memory.canResize ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          Change size…
        </button>
      ) : null}
      <ResizeDialog task={task} mode="general" open={open} onOpenChange={setOpen} />
    </>
  );
}

// ------------------------------------------------------------------ the dialog

export function ResizeDialog({ task, mode, open, onOpenChange }: { task: TaskDetailDto; mode: "oom" | "general"; open: boolean; onOpenChange: (open: boolean) => void }) {
  // A move started: the button that opened the dialog goes away, so focus goes to what replaces it.
  const started = useRef<boolean | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        onAfterCloseAutoFocus={() => {
          if (started.current === null) return;
          const pending = started.current;
          started.current = null;
          focusAfterMove(pending);
        }}
      >
        {open ? (
          <ResizeForm
            task={task}
            mode={mode}
            onDone={(pending) => {
              started.current = pending ?? null;
              onOpenChange(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ResizeForm({ task, mode, onDone }: { task: TaskDetailDto; mode: "oom" | "general"; onDone: (started?: boolean) => void }) {
  const info = experimental_useRpcQuery({ contract: rpcContract, method: "sandboxResizeInfo", input: { id: task.id } });
  const sizes = useSandboxSizes().data?.sizes ?? null;
  const resize = experimental_useRpcMutation({ contract: rpcContract, method: "resizeSandbox" });
  const oom = mode === "oom" || info.data?.oom === true;
  const current = info.data?.current?.type ?? task.memory?.size?.type ?? null;
  const options = (sizes ?? MACHINE_TYPE_VALUES.map((type) => ({ type, label: LABEL[type], detail: MACHINE_LABEL[type].split(" · ")[1] ?? "", available: true, reason: null }))).map((size) => ({
    ...size,
    now: size.type === current,
  }));
  // Only after running out of memory, and only a larger size: otherwise the user picks.
  const preselected = info.data ? suggestedSize(current, options, info.data.suggested, oom) : null;
  const [picked, setPicked] = useState<MachineType | null>(null);
  const type = picked ?? preselected;
  // The words follow the size picked: a smaller one is a plain change of size.
  const larger = oom && (type === null || current === null || isSmaller(current, type));
  const [message, setMessage] = useState<string | null>(null);
  const text = message ?? (type ? resizeMessage(type, larger) : "");
  const blocker = info.data?.blocker ?? null;
  const others = info.data?.others ?? [];
  const previews = info.data?.previews ?? 0;
  const startsLeft = info.data?.startsLeft ?? null;
  const nextUp = task.memory?.next ?? null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (type === null || blocker !== null) return;
    try {
      const result = await resize.mutate({ id: task.id, type, message: text.trim() || null });
      if (result.pending) toast.success(`Moving the sandbox to ${LABEL[type]}…`);
      else toast.success(result.sent ? `Sandbox is now ${LABEL[type]}. Follow-up sent` : `Sandbox is now ${LABEL[type]}`);
      onDone(result.pending);
    } catch (error) {
      showError(error);
    }
  };

  const warnings = [
    others.length === 1 ? `Task “${others[0]!.title}” uses this sandbox too. It moves with it.` : null,
    others.length > 1 ? `${others.length} other tasks use this sandbox: ${others.map((other) => `“${other.title}”`).join(", ")}. They move with it.` : null,
    previews > 0 ? `${previews === 1 ? "1 preview stops. Wake starts it again." : `${previews} previews stop. Wake starts them again.`}` : null,
    info.data?.chat ? "bb reconnects to the sandbox after it starts (about a minute)." : null,
  ].filter((line): line is string => line !== null);

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{larger ? "Continue on a larger sandbox" : "Change sandbox size"}</DialogTitle>
        <DialogDescription className="text-pretty">
          {current !== null ? `“${task.title}” runs on ${sizeName(current)}. ` : `“${task.title}”'s sandbox `}
          {current !== null ? "The sandbox stops and starts again on the size you pick." : "stops and starts again on the size you pick."} Its files stay;
          running processes stop.
        </DialogDescription>
      </DialogHeader>
      {blocker !== null ? (
        <InlineAlert>
          {blocker.message}
          {blocker.hint ? ` ${blocker.hint}` : ""}
        </InlineAlert>
      ) : null}
      <Field
        label="Size"
        htmlFor="ca-resize-size"
        hint={
          type === null ? null : (
            <>
              {costHint(type, current)}
              {isSmaller(type, current) ? ` boat refuses to shrink a sandbox whose data doesn't fit; it then stays on ${LABEL[current!]}.` : ""}
              {startsLeft !== null && startsLeft <= 5 ? ` This uses one of your ${plural(startsLeft, "boat start")} left.` : ""}
            </>
          )
        }
      >
        <Select value={type ?? ""} onValueChange={(next) => next && setPicked(next as MachineType)}>
          <SelectTrigger id="ca-resize-size">
            <SelectValue placeholder={info.data ? "Pick a size" : "Loading…"} />
          </SelectTrigger>
          <SelectContent>
            {options.map((size) => (
              <SelectItem key={size.type} value={size.type} disabled={size.now || !size.available} textValue={size.label}>
                <OptionLabel name={size.detail ? `${size.label} · ${size.detail}` : size.label} detail={size.now ? "Now" : size.available ? null : (size.reason ?? "Not on your boat plan")} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {oom && info.data && info.data.suggested === null && nextUp !== null && !nextUp.available ? (
        <p className="text-xs text-pretty text-muted-foreground">
          Your boat plan doesn't include a larger size: {nextUp.reason?.replace(/[.\s]+$/, "") ?? "not on your plan"}.
        </p>
      ) : null}
      {warnings.length > 0 ? (
        <InlineAlert tone="warning">
          {warnings.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </InlineAlert>
      ) : null}
      <Field label="Message" htmlFor="ca-resize-message" hint="Sent to the agent once the sandbox is up. Leave it empty to only change the size.">
        <Textarea id="ca-resize-message" rows={3} value={text} onChange={(event) => setMessage(event.target.value)} onKeyDown={submitOnModEnter} className="resize-y" />
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onDone()}>
          Cancel
        </Button>
        <SubmitButton pending={resize.isPending} disabled={type === null || blocker !== null || info.data === undefined} icon="ComputerCloud">
          {text.trim() ? "Move and continue" : "Change size"}
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}

// ------------------------------------------------------------------ projects

const SETTING = "__setting";

/** A project's Sandbox size: the setting, or a size (sizes the plan lacks greyed, except the one it has). */
export function ProjectSizeField({ value, onChange }: { value: MachineType | null; onChange: (value: MachineType | null) => void }) {
  const sizes = useSandboxSizes().data;
  const setting = useOverview().data?.defaults.machineType ?? sizes?.taskDefault ?? "default";
  const options = sizes?.sizes ?? MACHINE_TYPE_VALUES.map((type) => ({ type, label: LABEL[type], detail: MACHINE_LABEL[type].split(" · ")[1] ?? "", available: true, reason: null }));
  const chosen = value === null ? null : (options.find((size) => size.type === value) ?? null);
  return (
    <Field
      label="Sandbox size"
      htmlFor="ca-project-size"
      hint={
        <>
          For this project's new task sandboxes and their reviews. A size you pick for a task wins.
          {chosen !== null && !chosen.available ? (
            <span className="mt-1 block text-warning-text">
              Your boat plan doesn't include {chosen.label} right now ({chosen.reason?.replace(/[.\s]+$/, "") ?? "not on your plan"}). Until it does, its tasks start on {LABEL[setting]}.
            </span>
          ) : null}
        </>
      }
    >
      <Select value={value ?? SETTING} onValueChange={(next) => next && onChange(next === SETTING ? null : (next as MachineType))}>
        <SelectTrigger id="ca-project-size" className="sm:max-w-[calc(50%-0.375rem)]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={SETTING} textValue={`Same as the setting (${LABEL[setting]})`}>
            <OptionLabel name={`Same as the setting (${LABEL[setting]})`} detail={null} />
          </SelectItem>
          {options.map((size) => (
            <SelectItem key={size.type} value={size.type} disabled={!size.available && size.type !== value} textValue={size.label}>
              <OptionLabel name={size.detail ? `${size.label} · ${size.detail}` : size.label} detail={size.available ? null : (size.reason ?? "Not on your boat plan")} />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
