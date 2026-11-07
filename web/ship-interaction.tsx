import { DiffStats } from "./diff-stats";
import { useEffect, useId, useRef, useState } from "react";
import { experimental_useQuestionFormHost, type PluginAppBuilder, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { SHIP_RENDERER_ID, shipFormSchema } from "../contract-ship";
import { Button } from "../components/ui/button";
import "./ship-interaction.css";

export function registerShipInteraction(app: PluginAppBuilder): void {
  app.slots.pendingInteraction({ id: SHIP_RENDERER_ID, component: ShipInteraction });
}

/** Keyboard shortcuts follow bb's bindings; picking an option never submits. */
export function ShipInteraction({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const parsed = shipFormSchema.safeParse(interaction.payload);
  return parsed.success ? <ShipFormView key={interaction.id} form={parsed.data} submit={submit} cancel={cancel} /> : (
    <section className="boat-ui boat-ship-form" aria-label="Shipping confirmation unavailable">
      <p role="alert">This shipping confirmation is unavailable. Cancel it and request shipping again.</p>
      <Button variant="outline" size="sm" onClick={() => void cancel()}>Cancel confirmation</Button>
    </section>
  );
}

export function ShipFormView({ form, submit, cancel, merge }: Pick<PluginPendingInteractionProps, "submit" | "cancel"> & { form: import("../contract-ship").ShipForm; merge?: { number: number; head: string } }) {
  const host = experimental_useQuestionFormHost();
  const id = useId();
  const [choice, setChoice] = useState<"ship" | "not-yet">("ship");
  const [note, setNote] = useState("");
  const [showChanges, setShowChanges] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const mode = merge ? "merge" : "ship";
  const label = merge ? `Merge PR #${merge.number}` : `Ship to ${form.baseBranch}`;
  async function act(action: "submit" | "cancel") {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      if (action === "cancel") await cancel();
      else await submit({ requestId: form.requestId, choice, note });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn't send your choice. Try again.");
      busy.current = false;
      setPending(false);
    }
  }
  useEffect(() => host.registerChoiceHandler((index) => {
    if (index !== 0 && index !== 1) return false;
    if (!busy.current) setChoice(index === 0 ? "ship" : "not-yet");
    return true;
  }), [host]);
  useEffect(() => host.registerActionHandler((action) => {
    if (action !== "submit" && action !== "cancel") return false;
    void act(action);
    return true;
  }), [host, choice, note, submit, cancel]);
  const first = host.shortcuts.get("0");
  const second = host.shortcuts.get("1");
  const confirmShortcut = host.actionShortcuts.get("submit");
  const cancelShortcut = host.actionShortcuts.get("cancel");
  const hints = [first && second ? `${first.label}–${second.label} to pick` : null,
    confirmShortcut ? `${confirmShortcut.label} confirm` : null,
    cancelShortcut ? `${cancelShortcut.label} not now` : null].filter(Boolean).join(" · ");
  return (
    <form className="boat-ui boat-ship-form" data-question-form aria-labelledby={`${id}-title`} aria-busy={pending}
      onSubmit={(event) => { event.preventDefault(); void act("submit"); }}>
      <div className="boat-ship-body">
      <div className="boat-ship-heading">
        <span className="boat-ship-dot" aria-hidden="true" />
        <h3 id={`${id}-title`}>{mode === "merge" ? `${label} into ${form.baseBranch}?` : `Ship "${form.title}" to ${form.baseBranch}?`}</h3>
        <span className="boat-ship-muted">{mode === "merge" ? "Merges after your OK" : `${form.projectName ? `${form.projectName} ships` : "Ships"} after your OK`}</span>
      </div>
      <ul className="boat-ship-checks" aria-label={merge ? "Merge checks" : "Shipping checks"}>
        {form.checks.map((check, index) => <li key={index} data-tone={check.tone}>
          {check.tone === "ready" ? <span aria-hidden="true">✓ </span> : null}{check.text}
        </li>)}
      </ul>
      <div className="boat-ship-summary">{form.commits} commit{form.commits === 1 ? "" : "s"}
        {form.additions !== undefined && form.deletions !== undefined ? <> · <DiffStats additions={form.additions} deletions={form.deletions} /></> : null}
        {merge ? <> · commit <code>{merge.head.slice(0, 7)}</code></> : null}
        {mode === "ship" && form.repositories > 1 ? ` · ${form.repositories} repositories` : ""}
        {form.changes ? <> · <button type="button" className="boat-ship-link" onClick={() => setShowChanges(!showChanges)}>see the changes</button></>
          : form.changesUrl ? <> · <a className="boat-ship-link" href={form.changesUrl} target="_blank" rel="noreferrer">see the changes</a></> : null}
      </div>
      {merge ? <p className="boat-ship-consequence">This changes {form.baseBranch}. You can’t undo this from bb.</p> : null}
      {showChanges && form.changes ? <pre className="boat-ship-diff">{form.changes}</pre> : null}
      {form.changedSinceApproval !== null ? <details className="boat-ship-changes">
        <summary>What changed since you approved</summary><pre>{form.changedSinceApproval}</pre>
      </details> : null}
      <fieldset disabled={pending} className="boat-ship-options">
        <legend className="sr-only">{merge ? "Merge choice" : "Shipping choice"}</legend>
        {(["ship", "not-yet"] as const).map((value, index) => {
          const shortcut = index === 0 ? first : second;
          return <label key={value} className="boat-ship-option" data-selected={choice === value}>
            <input type="radio" name={`${id}-choice`} value={value} checked={choice === value} onChange={() => setChoice(value)}
              aria-keyshortcuts={shortcut?.ariaKeyshortcuts} />
            <kbd aria-hidden="true">{shortcut?.label ?? index + 1}</kbd>
            <span className="boat-ship-option-label">{value === "ship" ? label : "Not yet"}</span>
            <span className="boat-ship-muted">{value === "not-yet" ? "keep the sandbox and preview; tell the agent what to change"
              : mode === "merge" ? `merge the approved commits into ${form.baseBranch}; keep the sandbox`
              : form.keepOpen ? `push the ${form.commits} commits and keep the task open`
              : form.closesSandbox ? `push the ${form.commits} commits, then delete the sandbox if unused`
              : `push the ${form.commits} commits, then close the task`}</span>
          </label>;
        })}
      </fieldset>
      <label className="boat-ship-note" htmlFor={`${id}-note`}><span className="sr-only">A note (optional)</span>
        <textarea id={`${id}-note`} name="note" rows={1} maxLength={4_000} value={note} disabled={pending}
          onChange={(event) => setNote(event.target.value)} placeholder="A note (optional)…" />
      </label>
      {error ? <p role="alert" className="boat-ship-error">{error}</p> : null}
      </div>
      <div className="boat-ship-footer">
        <span className="boat-ship-muted">{hints}</span>
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => void act("cancel")}
          aria-keyshortcuts={cancelShortcut?.ariaKeyshortcuts}>Not now</Button>
        <Button type="submit" size="sm" disabled={pending} aria-keyshortcuts={confirmShortcut?.ariaKeyshortcuts}>
          {choice === "ship" ? label : "Not yet"}
        </Button>
      </div>
    </form>
  );
}
