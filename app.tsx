// bb-plugin-boat — frontend entry ("Cloud agents", via boat.dev).
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never
// bundled). The UI lives under web/; this file only registers it. All data
// comes from the shared RPC contract in contract.ts.
import {
  definePluginApp,
  experimental_THREAD_INFO_SECTION_GROUPS as SECTION_GROUPS,
} from "@get-bb/plugin-sdk/app";
import { PANEL_PATH } from "./web/format";
import { useAttentionBadge } from "./web/hooks";
import {
  CloudAgentsHeader,
  CloudAgentsPage,
  useCloudAgentsPageTitle,
} from "./web/page";
import { BoatSettings, MobileBoatSettings } from "./web/plugin-settings";
import { registerMergeInteraction } from "./web/merge-interaction";
import { registerOrchestratorWelcome } from "./web/orchestrator-welcome";
import "./web/boat-ui.css";
import {
  HomepageCard,
  ThreadAgentsTab,
  ThreadCardSection,
  ThreadInfoSection,
  ThreadSegmentDetails,
  ThreadSegmentSummary,
  ThreadSegmentAction,
  useSegmentVisible,
  useThreadHasTasks,
} from "./web/thread-surfaces";
import { registerBoatFooter } from "./web/footer";
import { registerTaskTab, useHasTask } from "./web/task-tab";
import { registerRowSignals } from "./web/row-signals";
import { registerShipInteraction } from "./web/ship-interaction";
import { registerChatCards } from "./web/cards";
import { registerEntryPoints } from "./web/entry-points";
import { SailIcon } from "./web/ui";
import {
  WorkspaceStrip,
  useWorkspaceStripVisible,
} from "./web/workspace-strip";

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: "boat-sail", component: SailIcon });

  // The Cloud agents page: overview at "", task detail at "task/<id>".
  app.slots.navPanel({
    id: "cloud-agents",
    title: "Cloud agents",
    icon: "ComputerCloud",
    path: PANEL_PATH,
    component: CloudAgentsPage,
    headerContent: CloudAgentsHeader,
    experimental_useBadge: useAttentionBadge,
    experimental_usePageTitle: useCloudAgentsPageTitle,
  });

  // Threads that dispatched tasks: the row above the composer (banner mode),
  // the context card (card mode), the Info tab, and a side-panel tab.
  app.slots.experimental_threadContextSegment({
    id: "cloud-agents",
    title: "Cloud agents",
    group: "2_cloudAgents",
    summary: ThreadSegmentSummary,
    action: ThreadSegmentAction,
    details: ThreadSegmentDetails,
    useVisible: useSegmentVisible,
  });
  // Worker chats: every chat in the same workspace (sandbox and checkout) as
  // tabs, plus New chat. Header buttons are single labels, so the tabs live in
  // the context row, right after bb's Parent thread segment ("1_thread").
  // Nothing in the context card duplicates it, so it shows in card mode too.
  app.slots.experimental_threadContextSegment({
    id: "workspace",
    title: "Workspace chats",
    group: "1_workspace",
    summary: WorkspaceStrip,
    useVisible: useWorkspaceStripVisible,
  });
  app.slots.experimental_threadContextCardSection({
    id: "cloud-agents",
    title: "Cloud agents",
    group: SECTION_GROUPS.related,
    order: 40,
    component: ThreadCardSection,
  });
  app.slots.experimental_threadInfoSection({
    id: "cloud-agents",
    group: SECTION_GROUPS.related,
    order: 40,
    component: ThreadInfoSection,
  });
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "fixed",
    id: "cloud-agents",
    title: "Cloud agents",
    icon: "ComputerCloud",
    tooltip: "Cloud agent tasks from this chat",
    layout: "padded",
    component: ThreadAgentsTab,
    useVisible: useSourceHasTasks,
  });

  // `::boat-task{id="t_…"}` in assistant messages → a live task card.
  registerChatCards(app);
  registerRowSignals(app);
  registerTaskTab(app);
  registerBoatFooter(app);
  registerShipInteraction(app);
  registerMergeInteraction(app);
  registerOrchestratorWelcome(app);

  app.slots.homepageSection({
    id: "cloud-agents",
    title: "Cloud agents",
    component: HomepageCard,
  });

  app.slots.settingsSection({ id: "cloud-agents", component: BoatSettings });
  app.slots.settingsSection({ id: "cloud-agents-mobile", title: "Cloud agents", experimental_page: "mobile", component: MobileBoatSettings });

  // Ways in from bb itself: composer send menu, New thread panel, Boat
  // sandbox size chip, thread header and menu (each skipped if this bb lacks it).
  registerEntryPoints(app);
});

function useSourceHasTasks(props: { threadId: string }): boolean {
  const hasTasks = useThreadHasTasks(props);
  const isTask = useHasTask(props);
  return hasTasks && !isTask;
}
