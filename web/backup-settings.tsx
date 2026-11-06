// Settings → Plugins → Boat Cloud Agents → Back up and restore: every plugin
// setting, the projects, model tiers and custom protocol as one JSON file
// (the same file as `bb boat config export|import`). Import shows what
// changes before anything is written.
import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { toast } from "sonner";
import { experimental_saveFile, experimental_useRpcMutation } from "@get-bb/plugin-sdk/app";
import { rpcContract, type ConfigImportResultDto } from "../contract";
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
import { errorMessage, plural } from "./format";
import { EmptyBox, InlineAlert, showError } from "./ui";

/** The server refuses larger files too. */
const MAX_FILE_CHARS = 500_000;

interface PickedFile {
  name: string;
  text: string;
}

export function BackupSettings() {
  const exportConfig = experimental_useRpcMutation({ contract: rpcContract, method: "exportConfig" });
  const fileInput = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<PickedFile | null>(null);

  const runExport = async () => {
    try {
      const { fileName, text } = await exportConfig.mutate(null);
      const outcome = await experimental_saveFile({ fileName, blob: new Blob([text], { type: "application/json" }) });
      if (outcome === "started") toast.success(`Exported ${fileName}`);
    } catch (failure) {
      showError(failure);
    }
  };

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Picking the same file again should open it again.
    event.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      if (text.length > MAX_FILE_CHARS) throw new Error(`${file.name} is too large for a Boat backup.`);
      setPicked({ name: file.name, text });
    } catch (failure) {
      showError(failure);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        One JSON file, the same as <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[11px]">bb boat config export</code>.
        It holds no tasks, chats, sandboxes or secrets, but it does hold your task instructions and project details:
        keep it private.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" className="h-7" disabled={exportConfig.isPending} onClick={() => void runExport()}>
          <Icon name={exportConfig.isPending ? "Loading" : "Download"} className={exportConfig.isPending ? "animate-spin" : undefined} />
          Export
        </Button>
        <Button variant="outline" size="sm" className="h-7" onClick={() => fileInput.current?.click()}>
          <Icon name="FileText" /> Import…
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          className="hidden"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => void pick(event)}
        />
      </div>
      <ImportDialog file={picked} onOpenChange={(open) => (open ? undefined : setPicked(null))} />
    </div>
  );
}

function ImportDialog({ file, onOpenChange }: { file: PickedFile | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={file !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        {/* Keyed by file, so a new file starts a fresh preview. */}
        {file ? <ImportPreview key={`${file.name}:${file.text.length}`} file={file} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ImportPreview({ file, onDone }: { file: PickedFile; onDone: () => void }) {
  const preview = experimental_useRpcMutation({ contract: rpcContract, method: "previewConfigImport" });
  const apply = experimental_useRpcMutation({ contract: rpcContract, method: "importConfig" });
  const [replaceProjects, setReplaceProjects] = useState(false);
  const [result, setResult] = useState<ConfigImportResultDto | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const replaceId = useId();

  // Only the latest preview counts (the checkbox can change while one runs).
  const latest = useRef(0);
  const load = async (replace: boolean) => {
    const request = ++latest.current;
    setFailure(null);
    try {
      const next = await preview.mutate({ text: file.text, replaceProjects: replace });
      if (request === latest.current) setResult(next);
    } catch (error) {
      if (request === latest.current) setFailure(errorMessage(error));
    }
  };
  // The first preview, as soon as the file is picked (this component is keyed by file).
  useEffect(() => {
    void load(false);
  }, []);

  const toggleReplace = (checked: boolean) => {
    setReplaceProjects(checked);
    void load(checked);
  };

  const runApply = async () => {
    try {
      const done = await apply.mutate({ text: file.text, replaceProjects });
      toast.success(done.changes === 0 ? "Nothing to change" : `Imported ${plural(done.changes, "change")}`);
      onDone();
    } catch (error) {
      showError(error);
    }
  };

  const problems = result?.problems ?? [];
  const canApply = result !== null && problems.length === 0 && result.changes > 0 && !preview.isPending && !apply.isPending;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Import {file.name}?</DialogTitle>
        <DialogDescription>Nothing changes until you apply. Settings and projects not in the file stay as they are.</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        {failure ? <InlineAlert>{failure}</InlineAlert> : null}
        {result === null && !failure ? <EmptyBox>Reading the file…</EmptyBox> : null}
        {problems.length > 0 ? (
          <InlineAlert>
            <p>This file can't be imported:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {problems.map((problem, index) => (
                <li key={index}>{problem}</li>
              ))}
            </ul>
          </InlineAlert>
        ) : null}
        {result !== null && problems.length === 0 ? (
          <>
            {result.changes === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing to change: this bb already matches the file.</p>
            ) : null}
            <div className="space-y-2 rounded-lg border border-border bg-card px-3 py-2.5" aria-live="polite">
              {result.sections.map((section) => (
                <div key={section.title} className="space-y-0.5">
                  <p className="text-sm font-medium text-foreground">{section.title}</p>
                  {section.lines.length > 0 ? (
                    <ul className="space-y-0.5 pl-3 font-mono text-xs break-words text-muted-foreground">
                      {section.lines.map((line, index) => (
                        <li key={index}>{line}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </div>
            <label htmlFor={replaceId} className="flex items-start gap-2 text-sm">
              <Checkbox
                id={replaceId}
                className="mt-0.5"
                checked={replaceProjects}
                disabled={preview.isPending}
                onCheckedChange={(checked) => toggleReplace(checked === true)}
              />
              <span>
                Also remove projects that aren't in the file
                <span className="block text-xs text-muted-foreground">
                  Never one with open tasks or an open orchestrator.
                </span>
              </span>
            </label>
          </>
        ) : null}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="button" disabled={!canApply} onClick={() => void runApply()}>
          {apply.isPending ? <Icon name="Loading" className="animate-spin" /> : null}
          Apply
        </Button>
      </DialogFooter>
    </>
  );
}
