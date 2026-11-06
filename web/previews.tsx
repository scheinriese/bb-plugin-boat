// Previews: the servers tasks left running, as private links. One list for
// everything (live and sleeping only), an orchestrator's tasks, or one task.
import { useState } from "react";
import { toast } from "sonner";
import { experimental_useRpcMutation, experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { rpcContract, type PreviewDto } from "../contract";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { TONE_DOT, stopsIn, type Tone } from "./format";
import { useCloudAgentsNavigation, useNow } from "./hooks";
import { IconButton, InlineAlert, ListPanel, Section, StatusDot, showError } from "./ui";

const STATE: Record<PreviewDto["state"], { label: string; tone: Tone }> = {
  live: { label: "live", tone: "success" },
  sleeping: { label: "sleeping", tone: "warning" },
  expired: { label: "expired", tone: "muted" },
};

export function usePreviews(threadId: string | null, taskId: string | null = null) {
  return experimental_useRpcQuery({ contract: rpcContract, method: "previews", input: { threadId, taskId } });
}

/**
 * A Previews section; hidden while there are none (and while loading), so
 * projects without previews don't get an empty box. `liveOnly` (the Cloud
 * agents page) leaves out expired previews: they stay on their task's page.
 */
export function PreviewsSection({
  threadId,
  taskId = null,
  showTask = true,
  liveOnly = false,
}: {
  threadId: string | null;
  taskId?: string | null;
  showTask?: boolean;
  liveOnly?: boolean;
}) {
  const { data, error } = usePreviews(threadId, taskId);
  const now = useNow();
  const all = data?.previews ?? [];
  if (error) {
    return (
      <Section title="Previews">
        <InlineAlert>{error.message}</InlineAlert>
      </Section>
    );
  }
  const live = all.filter((preview) => preview.state !== "expired");
  const previews = liveOnly ? live : all;
  if (previews.length === 0) return null;
  return (
    <Section title="Previews" count={live.length > 0 ? live.length : undefined}>
      <ListPanel label="Previews">
        {previews.map((preview) => (
          <PreviewRow key={preview.id} preview={preview} now={now} showTask={showTask} />
        ))}
      </ListPanel>
    </Section>
  );
}

function PreviewRow({ preview, now, showTask }: { preview: PreviewDto; now: number; showTask: boolean }) {
  const { navigate, openTask } = useCloudAgentsNavigation();
  const action = experimental_useRpcMutation({ contract: rpcContract, method: "previewAction" });
  const [pending, setPending] = useState<"wake" | "extend" | "stop" | null>(null);
  const state = STATE[preview.state];
  const ttl = preview.state === "live" ? stopsIn(preview.stopsAt, now) : null;
  const run = async (kind: "wake" | "extend" | "stop") => {
    setPending(kind);
    try {
      const { preview: next } = await action.mutate({ id: preview.id, action: kind, ...(kind === "extend" ? { hours: 2 } : {}) });
      if (kind === "wake") {
        if (next.state === "live") {
          toast.success("The preview is live");
          navigate.openUrl(next.link);
        } else {
          toast.warning(`Woken, but ${next.reason ?? "the server isn't answering yet"}`);
        }
      } else {
        toast.success(kind === "extend" ? "Its sandbox stays on 2 more hours" : "Stopped its sandbox; Wake brings it back");
      }
    } catch (error) {
      showError(error);
    } finally {
      setPending(null);
    }
  };
  const expired = preview.state === "expired";
  return (
    <li className={cn("flex items-center gap-3 px-4 py-2.5", expired && "opacity-60")}>
      <StatusDot className={TONE_DOT[state.tone]} label={state.label} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium text-foreground">{preview.taskTitle}</span>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {preview.path === "/" ? `:${preview.port}` : `:${preview.port}${preview.path}`}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className={cn(preview.state === "sleeping" && "text-warning-text")}>
            {state.label}
            {preview.reason && !expired ? `: ${preview.reason}` : ""}
          </span>
          {ttl ? (
            <span className="inline-flex items-center gap-1 tabular-nums">
              <Icon name="Clock" className="size-3.5" aria-hidden />
              {ttl}
            </span>
          ) : null}
          {showTask ? (
            <button
              type="button"
              onClick={() => openTask(preview.taskId)}
              className="rounded-sm font-mono hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label={`Open task ${preview.taskId}`}
            >
              {preview.taskId}
            </button>
          ) : null}
        </div>
      </div>
      {expired ? null : (
        <div className="flex shrink-0 items-center gap-0.5">
          {preview.state === "live" ? (
            <IconButton label="Open preview" icon="ExternalLink" onClick={() => navigate.openUrl(preview.link)} />
          ) : (
            <IconButton label="Wake: resume and open" icon="Sunrise" busy={pending === "wake"} onClick={() => void run("wake")} />
          )}
          {preview.state === "live" ? (
            <>
              <IconButton label="Keep on 2 more hours" icon="TimerReset" busy={pending === "extend"} onClick={() => void run("extend")} />
              <IconButton label="Stop its sandbox" icon="Square" busy={pending === "stop"} onClick={() => void run("stop")} />
            </>
          ) : null}
        </div>
      )}
    </li>
  );
}
