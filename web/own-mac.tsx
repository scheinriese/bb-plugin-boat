import { useState, type ReactNode } from "react";
import type { SandboxProviderDto, OwnMacDto } from "../contract-providers";
import {
  OWN_MAC_MIN_FREE_GB,
  OWN_MAC_GUIDE,
  OWN_MAC_VM_POWER_HELP,
  type OwnMacFacts,
} from "../contract-ownmac";
import { cn } from "@/lib/utils";
import { Switch } from "./ui";
import { OwnMacCleanupCard } from "./own-mac-cards";

export const ownMacPrimary =
  "rounded-md bg-[#E6E6E6] px-2.5 py-1 text-xs leading-4 font-medium text-[#141414] disabled:opacity-50";
export const ownMacSecondary =
  "rounded-md border border-[#333333] px-2.5 py-1 text-xs leading-4 text-[#D0D0D0] disabled:opacity-50";
const link = "text-[#7AA7FF] hover:underline";
export function OwnMacDot({ code }: { code?: OwnMacFacts["code"] }) {
  return code === "off" ? null : (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        code === "cleanup"
          ? "bg-[#E06C6C]"
          : code === "personal" || code === "admin" || code === "target"
            ? "bg-[#F0B135]"
            : code === "setup"
              ? "bg-[#7AA7FF]"
              : ["battery", "memory", "session"].includes(code ?? "")
                ? "bg-[#FC8C45]"
                : ["available", "busy"].includes(code ?? "")
                  ? "bg-[#5BD08A]"
                  : "bg-[#6E6E6E]",
      )}
    />
  );
}
export function ownMacRowStatus(f: OwnMacFacts) {
  if (f.code === "personal") return "Can't use · your own login";
  if (f.code === "admin") return "Can't use · admin user";
  if (f.code === "busy") return `Busy · ${f.running} of ${f.max}`;
  if (f.code === "memory")
    return `Low memory · ${Math.floor((f.freeMiB ?? 0) / 1024)} GB free`;
  if (f.code === "session") return "Not logged in";
  if (f.code === "unreachable" && f.since)
    return `Asleep or unreachable · since ${new Date(f.since).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
  return f.status;
}
export function ownMacDescription(f: OwnMacFacts) {
  switch (f.code) {
    case "available":
      return `Awake and on power. Mac tasks run here first, ${f.max} at a time.`;
    case "busy":
      return `${f.runningTitles?.[0] ? `Running “${f.runningTitles[0]}”. ` : ""}New Mac tasks go to the next Mac in line until it's free.`;
    case "paused":
      return "Paused by you. Mac tasks go to the next Mac in line until you resume.";
    case "unreachable":
      return "Mac tasks go to a rented Mac until it's back. A new rental always asks you first.";
    case "battery":
      return "Agents only start on power. Mac tasks go to the next Mac in line until it's plugged in.";
    case "memory":
      return `A task needs ${OWN_MAC_MIN_FREE_GB} GB free. Mac tasks go to the next Mac in line until memory frees up.`;
    case "session":
      return `The agents account must stay logged in. Log it in ${f.vm ? "on the VM" : "on your Mac"}; Mac tasks go elsewhere meanwhile.`;
    case "personal":
      return `${f.alias} signs in as you on this Mac. Agents never run in your own login: they could read your files, keychain and browser. Mac tasks go to the next Mac in line until this is fixed.`;
    case "admin":
      return `${f.alias} signs in as ${f.account ?? "an account"}, which is an admin on your physical Mac. An admin agent could change settings or install software for everyone on this Mac. Mac tasks go to the next Mac in line until this is fixed.`;
    case "target":
      return "Your Mac target changed; Test connection again before tasks run there. Mac tasks go to the next Mac in line until this is checked.";
    case "cleanup":
      return "Login cleanup couldn't be verified. Your Mac is automatically paused for new tasks until Check again passes. Running tasks are not moved or stopped.";
    case "off":
      return "$0 rent. Turn on Use for Mac tasks when you're ready.";
    default:
      return "$0 rent. Agents run in a VM or a separate user on this Mac, never in your own login.";
  }
}
function Isolation({
  value,
  onSave,
  busy,
}: {
  value: OwnMacDto;
  onSave?: (value: OwnMacDto) => void;
  busy: boolean;
}) {
  const detected = value.facts?.vm;
  if (detected !== null && detected !== undefined)
    return (
      <span className="text-xs text-[#D6D6D6]">
        {detected ? "macOS VM" : "Separate macOS user"}{" "}
        <span className="text-[#6E6E6E]">· detected</span>
      </span>
    );
  return (
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
          onClick={() => onSave?.({ ...value, ownMacIsolation: mode })}
          className={cn(
            "rounded px-2.5 py-[3px] text-xs leading-4 focus-visible:ring-2 focus-visible:ring-ring",
            (value.ownMacIsolation ?? "vm") === mode
              ? "bg-[#2A2A2A] text-[#EDEDED]"
              : "text-[#8A8A8A]",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
function Setting({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
      <div>
        <p className="text-[13px] leading-[18px] text-[#D6D6D6]">{label}</p>
        {help && (
          <p className="mt-0.5 text-xs leading-[17px] text-[#8A8A8A]">{help}</p>
        )}
      </div>
      {children}
    </div>
  );
}
function AliasField({
  value,
  onSave,
  busy,
}: {
  value: OwnMacDto;
  onSave?: (value: OwnMacDto) => void;
  busy: boolean;
}) {
  const [alias, setAlias] = useState(value.ownMacAlias);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave?.({ ...value, ownMacAlias: alias });
      }}
    >
      <input
        aria-label="SSH alias"
        value={alias}
        onChange={(e) => setAlias(e.target.value)}
        onBlur={() => {
          if (alias !== value.ownMacAlias)
            onSave?.({ ...value, ownMacAlias: alias });
        }}
        pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
        disabled={busy}
        placeholder="fake-mac-agents"
        className="w-44 rounded-md border border-[#2E2E2E] bg-[#151515] px-2.5 py-[5px] font-mono text-xs leading-[18px] text-[#D6D6D6]"
      />
    </form>
  );
}
function Setup({
  value,
  onSave,
  onTest,
  onStep,
  busy,
}: {
  value: OwnMacDto;
  onSave?: (v: OwnMacDto) => void;
  onTest?: () => void;
  onStep?: (step: number) => void;
  busy: boolean;
}) {
  const [changing, setChanging] = useState<number | null>(null);
  const f = value.facts!,
    complete = f.tested ? 5 : (f.setupSteps ?? 0),
    next = f.tested
      ? f.loggedIn && f.onPower
        ? 7
        : 6
      : Math.min(complete + 1, 7),
    vm = f.vm ?? value.ownMacIsolation !== "user";
  const labels = [
    "Chose where agents run",
    vm ? "Created the VM" : "Created the user",
    "Remote Login on",
    "SSH alias added",
    "Test connection",
    "Logged in and on power",
    "Turned on",
  ];
  return (
    <ol
      className="ml-0 mt-3 space-y-1 text-[13px] leading-[18px]"
      aria-label="Your Mac setup steps"
    >
      {labels.map((label, index) => {
        const step = index + 1,
          done =
            step <= complete ||
            (step === 6 && f.tested && f.loggedIn && f.onPower) ||
            (step === 7 && value.ownMacEnabled);
        const active =
          step === next ||
          (step === 6 && complete >= 5 && !(f.loggedIn && f.onPower));
        return (
          <li
            key={label}
            className={
              active
                ? "-ml-[13px] space-y-2.5 rounded-lg border border-[#2A3A55] bg-[#1A2230] px-3 py-2.5"
                : "flex min-h-8 flex-wrap items-center gap-x-2.5 gap-y-1"
            }
          >
            <div
              className={cn(
                "flex items-center gap-2.5",
                !active && "w-[220px]",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "inline-flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px]",
                  done
                    ? "border-[#5BD08A] bg-[#1B2A21] text-[#5BD08A]"
                    : active
                      ? "border-[#7AA7FF] text-[#7AA7FF]"
                      : "border-[#444444] text-[#6E6E6E]",
                )}
              >
                {done ? "✓" : step}
              </span>
              <span
                className={done || active ? "text-[#D6D6D6]" : "text-[#8A8A8A]"}
              >
                {label}
              </span>
              {active && (
                <span className="rounded bg-[#1E2A3D] px-1.5 py-px text-[11px] text-[#7AA7FF]">
                  Next
                </span>
              )}
            </div>
            {step === 1 &&
              (active ? (
                <div className="ml-6 space-y-2">
                  <Isolation value={value} onSave={onSave} busy={busy} />
                  <button
                    className={ownMacPrimary}
                    disabled={busy}
                    onClick={() => onStep?.(1)}
                  >
                    Continue
                  </button>
                </div>
              ) : (
                <div className="text-xs text-[#6E6E6E]">
                  {vm ? "macOS VM (recommended)" : "Separate macOS user"} ·{" "}
                  <button
                    className={link}
                    onClick={() => setChanging(changing === 1 ? null : 1)}
                  >
                    Change
                  </button>
                  {changing === 1 && (
                    <div className="mt-2 space-y-2">
                      <Isolation value={value} onSave={onSave} busy={busy} />
                      <button className={link} onClick={() => setChanging(4)}>
                        Change SSH alias
                      </button>
                    </div>
                  )}
                </div>
              ))}
            {step === 2 && (
              <div className="text-xs text-[#6E6E6E]">
                {vm ? "with a" : "a"} standard user, e.g. “agents” ·{" "}
                <a
                  href={OWN_MAC_GUIDE}
                  target="_blank"
                  rel="noreferrer"
                  className={link}
                >
                  Setup guide ↗
                </a>
                {active && (
                  <button
                    className={cn(ownMacSecondary, "ml-2")}
                    onClick={() => onStep?.(2)}
                  >
                    I've created it
                  </button>
                )}
              </div>
            )}
            {step === 3 && (
              <span className="text-xs text-[#6E6E6E]">
                for the agents account only{" "}
                {active && (
                  <button
                    className={cn(ownMacSecondary, "ml-2")}
                    onClick={() => onStep?.(3)}
                  >
                    It's on
                  </button>
                )}
              </span>
            )}
            {step === 4 &&
              (active || changing === 4 ? (
                <div className="ml-6 space-y-2">
                  <AliasField value={value} onSave={onSave} busy={busy} />
                  <button
                    className={ownMacSecondary}
                    disabled={!value.ownMacAlias || busy}
                    onClick={() => {
                      if (active) onStep?.(4);
                      setChanging(null);
                    }}
                  >
                    Continue
                  </button>
                </div>
              ) : (
                <span className="text-xs text-[#6E6E6E]">
                  <span className="font-mono text-[#D6D6D6]">
                    {value.ownMacAlias || "Not set"}
                  </span>{" "}
                  · from ~/.ssh/config ·{" "}
                  <button className={link} onClick={() => setChanging(4)}>
                    Change
                  </button>
                </span>
              ))}
            {step === 5 &&
              (active ? (
                <div className="ml-6 space-y-2.5">
                  <p className="text-xs leading-[17px] text-[#A8A8A8]">
                    Harbormaster connects as{" "}
                    <span className="font-mono">{value.ownMacAlias}</span> and
                    only reads: which user it is, whether that user is an admin,
                    free memory, power and login. It changes nothing.
                  </p>
                  {f.testResult && (
                    <div className="flex items-start gap-2.5 rounded-lg border border-[#262626] bg-[#151515] px-3 py-2.5">
                      <span
                        aria-hidden
                        className={cn(
                          "mt-px inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border text-[10px] leading-none",
                          f.testResult.ok
                            ? "border-[#5BD08A] text-[#5BD08A]"
                            : "border-[#F0B135] text-[#F0B135]",
                        )}
                      >
                        {f.testResult.ok ? "✓" : "!"}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium leading-4 text-[#EDEDED]">
                          {f.testResult.title}
                        </p>
                        <p className="mt-1 text-xs leading-[17px] text-[#8A8A8A]">
                          {f.testResult.detail}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs leading-4 text-[#6E6E6E]">
                        just now
                      </span>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button
                      className={ownMacPrimary}
                      disabled={busy}
                      onClick={onTest}
                    >
                      {f.testResult ? "Test again" : "Test connection"}
                    </button>
                    <a
                      className={ownMacSecondary}
                      href={OWN_MAC_GUIDE}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Setup guide ↗
                    </a>
                  </div>
                </div>
              ) : (
                <span className="text-xs text-[#6E6E6E]">
                  {f.testResult?.ok
                    ? `${f.testResult.title.toLowerCase()} · just now`
                    : "checked after the alias is added"}
                </span>
              ))}
            {step === 6 && (
              <span className="text-xs leading-[17px] text-[#6E6E6E]">
                {complete < 5
                  ? "checked after step 5 · your settings, Harbormaster never changes them"
                  : !f.loggedIn
                    ? "Not logged in. You can still turn it on; new tasks use the next Mac until you log in."
                    : !f.onPower
                      ? "On battery. You can still turn it on; new tasks use the next Mac until it's plugged in."
                      : "logged in and on power · your settings, Harbormaster never changes them"}
              </span>
            )}
            {step === 7 && (
              <>
                <span className="flex-1 text-xs text-[#6E6E6E]">
                  Mac tasks then run here first, {value.ownMacMaxTasks} at a
                  time
                </span>
                <Switch
                  aria-label="Turned on"
                  checked={value.ownMacEnabled}
                  disabled={!f.tested || busy}
                  onCheckedChange={(enabled) =>
                    onSave?.({ ...value, ownMacEnabled: enabled })
                  }
                />
              </>
            )}
          </li>
        );
      })}
    </ol>
  );
}
export function OwnMacRow({
  provider,
  onSave,
  onTest,
  onSetupStep,
  onCleanup,
  busy = false,
  icon,
}: {
  provider: SandboxProviderDto;
  onSave?: (value: OwnMacDto) => void;
  onTest?: () => void;
  onSetupStep?: (step: number) => void;
  onCleanup?: () => void;
  busy?: boolean;
  icon: ReactNode;
}) {
  const value = provider.ownMac!,
    f = value.facts ?? {
      status: provider.status ?? "Not set up",
      running: value.running,
      max: value.max,
      code: "setup" as const,
      alias: value.ownMacAlias,
    };
  const [expanded, setExpanded] = useState(f.code === "available"),
    [showCleanup, setShowCleanup] = useState(false);
  const refusal =
      f.code === "personal" || f.code === "admin" || f.code === "target",
    setup =
      (!f.tested || (!value.ownMacEnabled && (f.setupSteps ?? 0) < 7)) &&
      !refusal &&
      f.code !== "cleanup";
  const status = setup
    ? `Setting up · ${f.tested ? 5 + Number(Boolean(f.onPower && f.loggedIn)) : Math.min(f.setupSteps ?? 0, 4)} of 7`
    : ownMacRowStatus(f);
  const enriched = { ...value, facts: f };
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
            <span className="text-xs text-[#6E6E6E]">
              {value.ownMacAlias} · SSH
            </span>
          )}
          <span className="ml-auto inline-flex items-center gap-1.5 text-xs leading-4 text-[#A8A8A8]">
            <OwnMacDot code={setup ? "setup" : f.code} />
            {status}
          </span>
        </div>
        <p className="mt-0.5 text-xs leading-[17px] text-[#8A8A8A]">
          {setup
            ? "$0 rent. Agents run in a VM or a separate user on this Mac, never in your own login."
            : expanded && f.code === "available"
              ? "$0 rent. Awake and on power · Mac tasks run here first."
              : ownMacDescription(f)}{" "}
          {f.code === "paused" && (
            <button
              className={link}
              disabled={busy}
              onClick={() => onSave?.({ ...value, ownMacPaused: false })}
            >
              Resume
            </button>
          )}
        </p>
        {setup ? (
          <Setup
            value={enriched}
            onSave={onSave}
            onTest={onTest}
            onStep={onSetupStep}
            busy={busy}
          />
        ) : refusal ? (
          <>
            <dl className="mt-2 grid grid-cols-1 gap-x-2 gap-y-1.5 rounded-lg border border-[#262626] bg-[#151515] px-3 py-2.5 text-xs leading-4 sm:grid-cols-[72px_1fr]">
              <dt className="text-[#6E6E6E]">
                {f.code === "target" ? "Check" : "Signs in as"}
              </dt>
              <dd className="text-[#D6D6D6]">
                {f.code === "target"
                  ? "The SSH alias or tested Mac account changed."
                  : f.code === "personal"
                    ? "you (the user running bb)"
                    : `${f.account ?? "The account"} · Administrator`}
              </dd>
              <dt className="text-[#6E6E6E]">Fix</dt>
              <dd className="text-[#D6D6D6]">
                {f.code === "target"
                  ? "Test connection again to review and accept this Mac account."
                  : f.code === "personal"
                    ? `Create a macOS VM or a separate standard user, then point ${value.ownMacAlias} at it.`
                    : `Make ${f.account ?? "the account"} a standard user: System Settings › Users & Groups, turn off “Allow this user to administer this computer”. Or use a VM.`}
              </dd>
            </dl>
            <div className="mt-2 flex gap-2">
              <a
                className={ownMacPrimary}
                href={OWN_MAC_GUIDE}
                target="_blank"
                rel="noreferrer"
              >
                Setup guide ↗
              </a>
              <button
                className={ownMacSecondary}
                disabled={busy}
                onClick={onTest}
              >
                Test again
              </button>
            </div>
          </>
        ) : f.code === "cleanup" ? (
          <>
            <div className="mt-1 flex gap-2 text-xs">
              <button
                className={link}
                onClick={() => setShowCleanup(!showCleanup)}
              >
                Show steps
              </button>
              <span>·</span>
              <button className={link} disabled={busy} onClick={onCleanup}>
                Check again
              </button>
            </div>
            {showCleanup && f.cleanup && (
              <OwnMacCleanupCard
                cleanup={f.cleanup}
                title="Your Mac task"
                onCheck={onCleanup}
                busy={busy}
              />
            )}
          </>
        ) : (
          <>
            <button
              className={cn(link, "mt-2 text-xs")}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Hide settings" : "Show settings"}
            </button>
            {expanded && (
              <div className="mt-3 space-y-3">
                <Setting label="Use for Mac tasks">
                  <Switch
                    aria-label="Use for Mac tasks"
                    checked={value.ownMacEnabled}
                    disabled={busy || !onSave}
                    onCheckedChange={(enabled) =>
                      onSave?.({ ...value, ownMacEnabled: enabled })
                    }
                  />
                </Setting>
                <Setting
                  label="SSH alias"
                  help="A Host name from your ~/.ssh/config. Keys stay with SSH."
                >
                  <AliasField value={value} onSave={onSave} busy={busy} />
                </Setting>
                <Setting
                  label="Runs in"
                  help="Agents never run in your own login."
                >
                  <Isolation value={enriched} onSave={onSave} busy={busy} />
                </Setting>
                <p className="text-xs leading-[17px] text-[#8A8A8A]">
                  {OWN_MAC_VM_POWER_HELP}
                </p>
                <Setting
                  label="Tasks at once"
                  help="More tasks than this go to the next Mac in line."
                >
                  <select
                    aria-label="Tasks at once"
                    value={value.ownMacMaxTasks}
                    onChange={(e) =>
                      onSave?.({
                        ...value,
                        ownMacMaxTasks: Number(e.target.value),
                      })
                    }
                    className="w-44 rounded-md border border-[#2E2E2E] bg-[#151515] px-2.5 py-[5px] text-[13px] text-[#D6D6D6]"
                  >
                    {[1, 2, 3, 4].map((n) => (
                      <option key={n} value={n}>
                        {n} at a time
                      </option>
                    ))}
                  </select>
                </Setting>
                <Setting
                  label="Pause"
                  help="Running tasks finish; new ones go elsewhere until you resume."
                >
                  <Switch
                    aria-label="Pause"
                    checked={value.ownMacPaused}
                    disabled={busy}
                    onCheckedChange={(paused) =>
                      onSave?.({ ...value, ownMacPaused: paused })
                    }
                  />
                </Setting>
              </div>
            )}
          </>
        )}
        {setup && (
          <p className="mt-3 text-xs leading-[17px] text-[#8A8A8A]">
            Harbormaster checks each step when this page opens and before every
            Mac task. It connects with your SSH alias and only reads; it never
            sees your keys and never changes sleep, power or login settings.
          </p>
        )}
      </div>
    </div>
  );
}
