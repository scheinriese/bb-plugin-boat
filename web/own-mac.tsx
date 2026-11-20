import type { SandboxProviderDto, OwnMacDto } from "../contract-providers";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import { Switch } from "./ui";

/** The common awake/asleep row follows round 1 §3. Other states deliberately
 * stay as plain status lines until their designs arrive. */
export function OwnMacRow({
  provider,
  onSave,
  busy = false,
  icon,
}: {
  provider: SandboxProviderDto;
  onSave?: (value: OwnMacDto) => void;
  busy?: boolean;
  icon: ReactNode;
}) {
  const value = provider.ownMac!;
  const awake = provider.status === "Available";
  const asleep = provider.status === "Asleep or unreachable";
  const designed =
    awake || asleep || (!value.ownMacEnabled && Boolean(value.ownMacAlias));
  return (
    <div className="flex items-start gap-3 px-3.5 py-3">
      <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[13px] leading-[18px] text-[var(--boat-label)]">
            Your Mac
          </span>
          {value.ownMacAlias && (
            <span className="text-xs leading-4 text-[color:var(--boat-faint)]">
              {value.ownMacAlias} · SSH
            </span>
          )}
          <span className="ml-1 inline-flex items-center gap-1.5 text-xs leading-4 text-[color:var(--boat-secondary)]">
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                awake ? "bg-[#5BD08A]" : "bg-[#6E6E6E]",
              )}
            />
            {awake ? "Awake · on power" : provider.status}
          </span>
        </div>
        {provider.releaseNotice && (
          <p
            role="status"
            className="mt-1 text-xs leading-[17px] text-muted-foreground"
          >
            {provider.releaseNotice}
          </p>
        )}
        {designed && (
          <>
            <p className="mt-0.5 text-xs leading-[17px] text-muted-foreground">
              {awake
                ? "$0. Needs to be awake and on power."
                : "Mac tasks use the next approved route until it wakes. Turn on Keep Awake to stop this."}
            </p>
            <div className="mt-2 flex items-center justify-between gap-6 text-[13px] leading-[18px] text-[color:var(--boat-content)]">
              <span>Use for Mac tasks</span>
              <Switch
                aria-label="Use for Mac tasks"
                checked={value.ownMacEnabled}
                disabled={busy || !onSave}
                onCheckedChange={(enabled) =>
                  onSave?.({ ...value, ownMacEnabled: enabled })
                }
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[13px] leading-[18px] text-[color:var(--boat-content)]">
                  Runs in
                </p>
                <p className="mt-0.5 text-xs leading-[17px] text-muted-foreground">
                  Agents never run in your own login.
                </p>
              </div>
              <div
                role="radiogroup"
                aria-label="Runs in"
                className="flex flex-wrap gap-0.5 rounded-md border border-[#2E2E2E] bg-[#151515] p-0.5"
              >
                {(
                  [
                    ["vm", "macOS VM (recommended)"],
                    ["user", "Separate macOS user"],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={(value.ownMacIsolation ?? "vm") === mode}
                    disabled={busy || !onSave}
                    onClick={() =>
                      onSave?.({ ...value, ownMacIsolation: mode })
                    }
                    className={cn(
                      "rounded px-2.5 py-[3px] text-xs leading-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      (value.ownMacIsolation ?? "vm") === mode
                        ? "bg-[#2A2A2A] text-[#EDEDED]"
                        : "text-[#8A8A8A]",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
