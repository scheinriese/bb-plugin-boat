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
import { CloudAgentsHeader, CloudAgentsPage, useCloudAgentsPageTitle } from "./web/page";
import { BackupSettings } from "./web/backup-settings";
import { AdvancedSettings, ModelsSettings, OrchestratorsSettings, SetupSettings, UsageLimitsSettings } from "./web/plugin-settings";
import { ProjectsSettings } from "./web/projects-settings";
import {
  HomepageCard,
  ThreadAgentsTab,
  ThreadCardSection,
  ThreadInfoSection,
  ThreadSegmentDetails,
  ThreadSegmentSummary,
  useSegmentVisible,
  useThreadHasTasks,
} from "./web/thread-surfaces";
import { registerRowSignals } from "./web/row-signals";
import { registerShipInteraction } from "./web/ship-interaction";
import { registerChatCards } from "./web/cards";
import { registerEntryPoints } from "./web/entry-points";
import { SailIcon } from "./web/ui";
import { WorkspaceStrip, useWorkspaceStripVisible } from "./web/workspace-strip";

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
    useVisible: useThreadHasTasks,
  });

  // `::boat-task{id="t_…"}` in assistant messages → a live task card.
  registerChatCards(app);
  registerRowSignals(app);
  registerShipInteraction(app);

  app.slots.homepageSection({ id: "cloud-agents", title: "Cloud agents", component: HomepageCard });

  // Settings → Plugins → Boat Cloud Agents, below bb's list, in this order.
  app.slots.settingsSection({
    id: "setup",
    title: "Setup",
    description: "What cloud agents need on boat.dev, checked without starting anything.",
    component: SetupSettings,
  });
  app.slots.settingsSection({
    id: "projects",
    title: "Projects",
    description:
      "Repos you trust. Each project sets the environment its tasks start in and how their work lands; orchestrators work on one project each.",
    component: ProjectsSettings,
  });
  app.slots.settingsSection({
    id: "usage-limits",
    title: "Usage limits",
    description: "What happens when Claude or Codex nears its usage limit.",
    component: UsageLimitsSettings,
  });
  app.slots.settingsSection({
    id: "models",
    title: "Models",
    description: "Which model and effort tasks run with.",
    component: ModelsSettings,
  });
  app.slots.settingsSection({
    id: "orchestrators",
    title: "Orchestrators (optional)",
    description: "An orchestrator is a chat that plans and coordinates tasks for one project. Skip this if you start tasks yourself.",
    component: OrchestratorsSettings,
  });
  app.slots.settingsSection({
    id: "advanced",
    title: "Advanced",
    description: "Sandbox lifetimes, reviews, protected branches and the boat CLI location.",
    component: AdvancedSettings,
  });
  // …and a backup of all of it (`bb boat config export|import`).
  app.slots.settingsSection({
    id: "backup",
    title: "Back up and restore",
    description: "Save your settings, projects, model presets and protocol to a file, or restore them from one.",
    component: BackupSettings,
  });

  // Ways in from bb itself: composer send menu, New thread panel, Boat
  // sandbox size chip, thread header and menu (each skipped if this bb lacks it).
  registerEntryPoints(app);
});
