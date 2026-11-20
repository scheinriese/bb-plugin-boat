import { footerOnCount } from "./own-mac-count";
import { FooterUsage } from "./footer-usage";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  type ExperimentalSidebarFooterDisclosureProps,
  type PluginAppBuilder,
  experimental_useRpcQuery,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../contract";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import { canResumeSandbox, isSandboxActive, PANEL_PATH } from "./format";
import { useOverview, useSandboxes, useSandboxProviders } from "./hooks";
import {
  SandboxActionButton,
  sandboxFailure,
  useSandboxTasks,
} from "./sandboxes-table";
import { AgentLogo, SailIcon } from "./ui";

let footerOpen = false;
const footerListeners = new Set<() => void>();
const setFooterOpen = (open: boolean) => {
  footerOpen = open;
  for (const listener of footerListeners) listener();
};
const subscribeFooter = (listener: () => void) => {
  footerListeners.add(listener);
  return () => {
    footerListeners.delete(listener);
  };
};

export function registerBoatFooter(app: PluginAppBuilder): void {
  app.experimental_icons.register({
    name: "boat-footer",
    component: BoatFooterIcon,
  });
  if (typeof app.slots.experimental_appOverlay === "function") {
    app.experimental_sidebarFooter.register({
      kind: "action",
      id: "cloud-sandboxes",
      label: "Cloud sandboxes",
      icon: "boat-footer",
      onActivate: () => setFooterOpen(!footerOpen),
    });
    app.slots.experimental_appOverlay({
      id: "cloud-sandboxes-popover",
      component: BoatFooterOverlay,
    });
  } else {
    app.experimental_sidebarFooter.register({
      kind: "disclosure",
      id: "cloud-sandboxes",
      label: "Cloud sandboxes",
      icon: "boat-footer",
      component: BoatFooter,
    });
  }
}

/** Public SDK overlay; owns its frame and never reads or styles the host footer. */
function BoatFooterOverlay() {
  const open = useSyncExternalStore(subscribeFooter, () => footerOpen);
  const ref = useRef<HTMLDivElement>(null);
  const dialogOpen = useRef(false);
  const closingDialogTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!open) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    let armed = false;
    const armTimer = window.setTimeout(() => {
      armed = true;
    }, 0);
    const outside = (event: MouseEvent) => {
      if (
        armed &&
        footerOpen &&
        !dialogOpen.current &&
        event.target instanceof Node &&
        !ref.current?.contains(event.target)
      )
        setFooterOpen(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !dialogOpen.current) {
        event.preventDefault();
        event.stopPropagation();
        setFooterOpen(false);
        previous?.focus();
      }
    };
    const resize = () => setFooterOpen(false);
    // Bubble after the public footer action toggles its own state.
    document.addEventListener("click", outside);
    document.addEventListener("keydown", keyboard, true);
    window.addEventListener("resize", resize);
    return () => {
      window.clearTimeout(armTimer);
      if (closingDialogTimer.current !== null)
        window.clearTimeout(closingDialogTimer.current);
      closingDialogTimer.current = null;
      dialogOpen.current = false;
      document.removeEventListener("click", outside);
      document.removeEventListener("keydown", keyboard, true);
      window.removeEventListener("resize", resize);
    };
  }, [open]);
  if (!open) return null;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Cloud sandboxes"
      className="boat-ui pointer-events-auto fixed bottom-[calc(60px+env(safe-area-inset-bottom))] left-[10px] z-50 w-[298px] max-w-[calc(100vw-20px)] rounded-xl border border-border dark:border-[#303030] bg-[color:var(--boat-footer)] shadow-[0_12px_32px_#00000073]"
    >
      <BoatFooter
        dismiss={() => setFooterOpen(false)}
        onDialogOpenChange={(value) => {
          if (closingDialogTimer.current !== null)
            window.clearTimeout(closingDialogTimer.current);
          if (value) dialogOpen.current = true;
          else
            closingDialogTimer.current = window.setTimeout(() => {
              dialogOpen.current = false;
              closingDialogTimer.current = null;
            }, 0);
        }}
      />
    </div>
  );
}

/** A registered SDK icon can carry the exception dot without editing host DOM. */
function BoatFooterIcon({ className }: { className?: string }) {
  // Provider/icon renderers run outside a slot context; bind RPC explicitly.
  const sandboxes = experimental_useRpcQuery({
    pluginId: "boat",
    contract: rpcContract,
    method: "sandboxes",
    input: { all: true },
  });
  const tasks = experimental_useRpcQuery({
    pluginId: "boat",
    contract: rpcContract,
    method: "tasks",
    input: { statuses: null, threadId: null, limit: 500 },
  });
  const overview = experimental_useRpcQuery({
    pluginId: "boat",
    contract: rpcContract,
    method: "overview",
    input: null,
  });
  const own=experimental_useRpcQuery({pluginId:"boat",contract:rpcContract,method:"macUsage",input:{timezoneOffsetMinutes:new Date().getTimezoneOffset()}});
  const count = footerOnCount(sandboxes.data?.sandboxes,own.data?.ownMac?.running);
  const broken = sandboxes.data?.sandboxes.some((sandbox) =>
    sandboxFailure(sandbox, tasks.data?.tasks ?? []),
  );
  return (
    <span className="relative inline-flex">
      <SailIcon className={className} />
      {typeof count === "number" && count > 0 && (
        <span
          className={`absolute -right-1 -top-1 text-[9px] leading-[10px] tabular-nums ${broken ? "text-[#E06C6C]" : "text-foreground/80"}`}
        >
          {count}
        </span>
      )}
    </span>
  );
}

export function BoatFooter({
  dismiss,
  onDialogOpenChange,
}: ExperimentalSidebarFooterDisclosureProps & {
  onDialogOpenChange?: (open: boolean) => void;
}) {
  const overview = useOverview();
  const providerInfo = useSandboxProviders();
  const mac = experimental_useRpcQuery({contract:rpcContract,method:"macUsage",input:{timezoneOffsetMinutes:new Date().getTimezoneOffset()}});
  const sandboxes = useSandboxes();
  const usage = experimental_useRpcQuery({
    contract: rpcContract,
    method: "fidelityUsage",
    input: { timezoneOffsetMinutes: new Date().getTimezoneOffset() },
  });
  const tasks = useSandboxTasks();
  const navigate = useBbNavigate();
  const exceptions = useMemo(
    () =>
      (sandboxes.data?.sandboxes ?? []).flatMap((sandbox) => {
        const failure = sandboxFailure(sandbox, tasks.data?.tasks ?? []);
        return failure ? [{ sandbox, ...failure }] : [];
      }),
    [sandboxes.data, tasks.data],
  );
  const count = footerOnCount(sandboxes.data?.sandboxes,mac.data?.ownMac?.running) ?? null;
  const boatOn = sandboxes.data?.sandboxes.filter(s=>s.runsOn?.provider==="boat" && isSandboxActive(s.state)).length ?? null;
  const providers = providerInfo.data?.providers.map(p=>p.id==="instabox" && p.linuxUsage ? {...p,linuxUsage:{...p.linuxUsage,active:sandboxes.data?.sandboxes.filter(s=>s.runsOn?.provider==="instabox" && s.runsOn?.os!=="macos" && isSandboxActive(s.state)).length ?? null}} : p);
  function allSandboxes() {
    navigate.toPluginPanel(PANEL_PATH, { subPath: "sandboxes" });
    dismiss();
  }
  return (
    <section
      className="boat-ui w-full max-w-[calc(100vw-24px)] space-y-3 p-3.5 text-xs"
      aria-label="Cloud sandboxes"
    >
      <h2 className="flex items-center justify-between text-[13px] leading-[18px] font-semibold text-[color:var(--boat-heading)]">Cloud sandboxes <span className="text-xs font-normal text-[#A8A8A8]">{count===null ? "" : `${count} on`}</span></h2>
      <FooterUsage plan={usage.data?.plan} providers={providers} mac={mac.data} boatOn={boatOn} cap={overview.data?.cap ?? null} day={usage.data?.day}/>
      {exceptions.length > 0 && (
        <div className="flex flex-col border-t border-border pt-1">
          <h3 className="pt-1.5 text-[11px] leading-[14px] text-[color:var(--boat-faint)]">
            Stopped
          </h3>
          <ul className="max-h-52 overflow-y-auto">
            {exceptions.map(({ sandbox, task, reason }) => (
              <li
                key={sandbox.id}
                className="flex items-center gap-[9px] py-[7px]"
              >
                {task ? (
                  <AgentLogo provider={task.provider} className="size-3" />
                ) : (
                  <Icon
                    name="CircleAlert"
                    className="mt-1 size-3 shrink-0 text-[#E06C6C]"
                    aria-hidden
                  />
                )}
                <div className="min-w-0 flex-1 space-y-px">
                  <p className="line-clamp-1 text-[13px] leading-[17px] text-[color:var(--boat-label)]">
                    {task?.title || sandbox.name || "Sandbox"}
                  </p>
                  <p className="line-clamp-2 text-[11px] leading-[14px] text-[#E06C6C]">
                    {reason}
                  </p>
                </div>
                {sandbox.uses.length>0 && canResumeSandbox(sandbox.state) && (
                  <SandboxActionButton
                    sandbox={sandbox}
                    action="resume"
                    onDialogOpenChange={onDialogOpenChange}
                    compact
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(overview.error ||
        overview.data?.boatError ||
        sandboxes.error ||
        sandboxes.data?.error) && (
        <p role="status" className="text-[11px] text-[#E06C6C]">
          Some sandbox information is unavailable. Open all sandboxes to try
          again.
        </p>
      )}
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          className="h-4 px-0 text-xs text-[#7AA7FF]"
          onClick={allSandboxes}
        >
          All sandboxes →
        </Button>
      </div>
    </section>
  );
}
