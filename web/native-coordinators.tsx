import {
  experimental_ProviderIcon as ProviderIcon,
  experimental_useProviders,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { nativeActivity, type CoordinationThread, type NativeCoordinator } from "./coordinators-logic";

const labels = { "needs-you": "needs you", working: "working", waiting: "waiting", error: "error", idle: "idle" };
const tones = { "needs-you": "text-[#D99413] dark:text-[#F0B135]", working: "text-foreground", waiting: "text-muted-foreground", error: "text-[#C44747] dark:text-[#E06C6C]", idle: "text-muted-foreground" };

function NativeLogo({ thread }: { thread: CoordinationThread }) {
  const { providers } = experimental_useProviders();
  const provider = providers.find(item => item.id === thread.providerId);
  return provider ? <ProviderIcon providerKind="agent" provider={provider} fallback="Bot" className="size-3.5 shrink-0" aria-label={provider.displayName} /> : <Icon name="Bot" className="size-3.5 shrink-0" />;
}

export function NativeCounts({ group }: { group: NativeCoordinator }) {
  return <span className="flex max-w-full flex-wrap justify-end gap-x-3 gap-y-1 text-xs leading-4 text-muted-foreground">
    <span>{group.children.length} bb {group.children.length === 1 ? "chat" : "chats"}</span>
    {(["needs-you", "error", "working", "waiting"] as const).filter(state => group.counts[state] > 0).map(state =>
      <span key={state} className={tones[state]}>{group.counts[state]} {state === "needs-you" ? group.counts[state] === 1 ? "needs you" : "need you" : labels[state]}</span>)}
  </span>;
}

/** Navigation only: these chats keep their native instructions and lifecycle. */
export function NativeCoordinatorRow({ group, projectName }: { group: NativeCoordinator; projectName?: string }) {
  const navigate = useBbNavigate();
  return <div data-native-coordinator={group.thread.id} className="flex min-h-11 items-center gap-2.5 border-b border-[color:var(--boat-divider)] px-[14px] py-2 last:border-b-0 sm:min-h-10 sm:py-1.5">
    <NativeLogo thread={group.thread} />
    <button type="button" title={[group.thread.displayTitle, projectName].filter(Boolean).join(" · ")} className="min-w-0 flex-1 text-left hover:underline focus-visible:ring-1 focus-visible:ring-ring" onClick={() => navigate.toThread(group.thread.id)}>
      <span className="block truncate text-[13px] leading-4 text-[color:var(--boat-label)]">{group.thread.displayTitle}</span>
      {projectName && <span className="block truncate text-xs leading-4 text-[color:var(--boat-faint)]">{projectName}</span>}
    </button>
    <span className="max-w-[45%] shrink-0"><NativeCounts group={group} /></span>
  </div>;
}

export function NativeCoordinatorCard({ group, projectName, childrenOnly = false }: { group: NativeCoordinator; projectName?: string; childrenOnly?: boolean }) {
  const navigate = useBbNavigate();
  // Bound the rendered list, while every descendant still contributes to counts.
  const priority = { "needs-you": 0, error: 1, working: 2, waiting: 3, idle: 4 };
  const children = [...group.children].sort((a, b) => priority[nativeActivity(a)] - priority[nativeActivity(b)] || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return <div data-native-coordinator={group.thread.id} className={childrenOnly ? "space-y-2" : "space-y-2 px-3 py-3 sm:space-y-[10px] sm:px-[14px]"}>
    <div className="flex flex-wrap items-center gap-2 text-[15px] leading-5 sm:text-[13px]">
      {!childrenOnly && <>
        <NativeLogo thread={group.thread} />
        <button type="button" title={group.thread.displayTitle} className="min-w-0 max-w-full truncate text-left text-[color:var(--boat-heading)] hover:underline focus-visible:ring-1 focus-visible:ring-ring sm:font-medium" onClick={() => navigate.toThread(group.thread.id)}>{group.thread.displayTitle}</button>
        {projectName && <span className="min-w-0 truncate text-xs text-[color:var(--boat-faint)]">{projectName}</span>}
      </>}
      <span className={childrenOnly ? "" : "ml-auto"}><NativeCounts group={group} /></span>
    </div>
    <div className={cn("flex flex-wrap gap-1.5", !childrenOnly && "sm:pl-5")}>
      {children.slice(0, 8).map(child => {
        const state = nativeActivity(child);
        return <button type="button" key={child.id} data-native-child={child.id} title={`${child.displayTitle} · ${labels[state]}`} onClick={() => navigate.toThread(child.id)} className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-border/70 bg-[color:var(--boat-chip)] px-2 py-[5px] text-[13px] leading-[18px] hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring sm:text-xs sm:leading-4">
          <NativeLogo thread={child} />
          <span className="truncate text-[color:var(--boat-content)]">{child.displayTitle}</span>
          <span className={cn("shrink-0", tones[state])}>{labels[state]}</span>
        </button>;
      })}
      {children.length > 8 && <button type="button" className="px-2 py-1 text-xs text-muted-foreground hover:underline focus-visible:ring-1 focus-visible:ring-ring" onClick={() => navigate.toThread(group.thread.id)}>+{children.length - 8} more in chat</button>}
    </div>
  </div>;
}
