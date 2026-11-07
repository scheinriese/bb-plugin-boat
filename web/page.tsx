// The Cloud agents nav panel: router over `subPath`, header actions (New
// task, and a ⋯ menu with the rest) and the page title.
import { useState } from "react";
import {
  experimental_usePluginId,
  experimental_useRpcMutation,
  useBbNavigate,
  type ExperimentalPageTitle,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../contract";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { NewOrchestratorDialog, NewSandboxDialog, NewTaskDialog } from "./dialogs";
import { PANEL_PATH, parseSubPath } from "./format";
import { useCloudAgentsNavigation, useTask, useThreadDisplayTitle } from "./hooks";
import { OrchestratorOverview, Overview, SandboxesSection, openBoatChat } from "./overview";
import { Today } from "./today";
import { ProjectsSettings } from "./projects-settings";
import { TaskDetail } from "./task-detail";
import { EmptyBox, IconButton, showError } from "./ui";

export function CloudAgentsPage({ subPath }: PluginNavPanelProps) {
  const route = parseSubPath(subPath);
  const section = subPath.replace(/^\/+|\/+$/g, "");
  if (["", "today", "sandboxes", "projects"].includes(section)) return <CloudPageTabs section={section || "today"} />;
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      {route.kind === "task" ? (
        <TaskDetail key={route.id} id={route.id} />
      ) : route.kind === "orchestrator" ? (
        <OrchestratorOverview key={route.threadId} threadId={route.threadId} />
      ) : route.kind === "overview" ? (
        // The same element for "" and "sign-in", so the page keeps its state when sign-in drops the sub-path.
        <Overview autoSignIn={route.signIn === true} />
      ) : (
        <UnknownRoute />
      )}
    </div>
  );
}


function CloudPageTabs({section}:{section:string}) {
  const navigate = useBbNavigate();
  return <div className="h-full min-h-0 flex-1 overflow-y-auto"><div className="mx-auto w-full max-w-[1140px] px-4 pt-4 md:px-6">
    <nav aria-label="Cloud agents pages" className="flex gap-7 border-b border-border">{["today","sandboxes","projects"].map(tab => <button key={tab} type="button" aria-current={section===tab?"page":undefined} onClick={()=>navigate.toPluginPanel(PANEL_PATH,{subPath:tab==="today"?"":tab})} className={"border-b-2 pb-2 text-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " + (section===tab?"border-foreground font-medium text-foreground":"border-transparent text-muted-foreground hover:text-foreground")}>{tab[0]!.toUpperCase()+tab.slice(1)}</button>)}</nav>
    {section==="today"?<Today/>:section==="sandboxes"?<div className="py-6"><SandboxesSection/></div>:<div className="py-6"><ProjectsSettings/></div>}
  </div></div>;
}

function UnknownRoute() {
  const { openOverview } = useCloudAgentsNavigation();
  return (
    <div className="mx-auto box-border w-full max-w-4xl px-4 pb-10 pt-3 md:px-5 md:pt-4">
      <EmptyBox>
        This page doesn't exist.{" "}
        <button type="button" onClick={openOverview} className="underline underline-offset-4 hover:text-foreground">
          Back to Cloud agents
        </button>
      </EmptyBox>
    </div>
  );
}

/** Refresh · New task · ⋯ (New sandbox, New chat in a Boat sandbox, New orchestrator…). */
export function CloudAgentsHeader(_props: PluginNavPanelProps) {
  const refresh = experimental_useRpcMutation({ contract: rpcContract, method: "refresh" });
  const navigate = useBbNavigate();
  const [dialog, setDialog] = useState<"task" | "sandbox" | "orchestrator" | null>(null);
  const control = (name: "task" | "sandbox" | "orchestrator") => ({
    open: dialog === name,
    onOpenChange: (open: boolean) => setDialog(open ? name : null),
  });

  const runRefresh = async () => {
    try {
      await refresh.mutate(null);
    } catch (error) {
      showError(error);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <IconButton label="Refresh from boat.dev" icon="ArrowReloadHorizontal" busy={refresh.isPending} onClick={() => void runRefresh()} />
      {/* Icon only on phones, so the page title in bb's header isn't cut to one letter. */}
      <Button size="sm" className="h-7 px-2 sm:px-2.5" aria-label="Start" onClick={() => openBoatChat(navigate)}>
        <Icon name="Plus" />
        <span className="hidden sm:inline">Start</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-foreground" aria-label="More actions">
            <Icon name="MoreHorizontal" className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" mobileTitle="Cloud agents">
          <DropdownMenuItem onSelect={() => setDialog("sandbox")}>
            <Icon name="Plus" /> New sandbox
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openBoatChat(navigate)}>
            <Icon name="MessageSquare" /> New chat in a Boat sandbox
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setDialog("orchestrator")}>
            <Icon name="Workflow" /> New orchestrator…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <NewSandboxDialog {...control("sandbox")} />
      <NewOrchestratorDialog {...control("orchestrator")} />
    </div>
  );
}

/** Breadcrumbs: Cloud agents › <task title>, or › <orchestrator title>. */
export function useCloudAgentsPageTitle({ subPath }: PluginNavPanelProps): ExperimentalPageTitle | null {
  const pluginId = experimental_usePluginId();
  const route = parseSubPath(subPath);
  const id = route.kind === "task" ? route.id : null;
  const orchestratorId = route.kind === "orchestrator" ? route.threadId : null;
  const { data } = useTask(id);
  const orchestratorTitle = useThreadDisplayTitle(orchestratorId);
  if (orchestratorId !== null) {
    const title = orchestratorTitle ?? "Orchestrator";
    return { title, windowTitle: `${title} · Cloud agents` };
  }
  if (id === null) return null;
  const title = data?.task?.title ?? id;
  // The host already shows "Cloud agents" before the page title.
  void pluginId;
  return { title, windowTitle: `${title} · Cloud agents` };
}
