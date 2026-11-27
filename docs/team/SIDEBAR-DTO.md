# sidebarState.team v1

`sidebarState({version: 1})` remains backward compatible. Team off omits
`team`. Team on adds the following DTO; its runtime schema is exported as
`teamSidebarSchema` in `contract-team.ts` and included in the existing sidebar
RPC output. The top-level sidebar revision includes this entire block.

```ts
type TeamSidebar = {
  enabled: true;
  yourMove: { count: number; overdue: number; confirm: number };
  projects: Array<{
    bbProjectId: string;
    icon: string; // bb glyph name, currently Folder
    leadThreadId: string;
  }>;
  lead: TeamMember | null; // null only before a real home exists
  members: TeamMember[]; // specialists and project leads; excludes chief
  hideFromSections: string[]; // chief/specialist home thread IDs
  revision: string;
  truncated: boolean;
};
type TeamMember = {
  memberId: string;
  threadId: string; // an existing home, never a synthetic assignment ID
  name: string;
  kind: "lead" | "specialist" | "project-lead";
  avatar: { initials: string; color: string };
  status: "active" | "paused" | "archived";
  preview: {
    kind: "needs-you" | "activity" | "counts" | "last-message";
    text: string;
    tone: "neutral" | "attention" | "danger" | "success";
  };
  unread: { messages: number; cards: number };
  order: number;
  backgroundThreadIds: string[];
};
```

`yourMove` counts open, confirming and verifying asks, including adopted
Harbormaster decisions and PR review asks. It belongs only on the chief tile.
When Workbench is the selected thread-list provider, the native navigation
badge is suppressed. No custom thread list is registered by Harbormaster.

The chief preview is **her latest line**, saved from `thread.idle`, with a
neutral “Ready to help” fallback. **Next** belongs in the tray, never on the
tile. Non-chief rows use current work or ask text. The avatar DTO intentionally
stays small: H3/H2 face selection and motion belong to the sidebar renderer;
source assets are in `docs/team/design/avatars/`.

`unread.messages` is zero until native read-state integration is implemented;
`unread.cards` counts the member's open asks, not unread messages. A task's
ask marker belongs on the blocked task row, with a neutral member preview
when the task is under a project. Do not draw a second marker from cards alone.
