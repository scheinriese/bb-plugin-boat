# sidebarState.team v1

`sidebarState({version: 1})` remains backward compatible. Team off omits
`team`. Team on adds the following DTO; its runtime schema is exported as
`teamSidebarSchema` in `contract-team.ts` and included in the existing sidebar
RPC output. The top-level sidebar revision includes this entire block.

```ts
type TeamSidebar = {
  version: 1;
  enabled: true;
  yourMove: { count: number; overdue: number; confirm: number };
  projects: Array<{ // max 200
    bbProjectId: string;
    icon: string; // bb glyph name, currently Folder
    leadThreadId: string;
  }>;
  lead: TeamMember | null; // null only before a real home exists
  members: TeamMember[]; // max 200; specialists and project leads; excludes chief
  hideFromSections: string[]; // max 201; chief/specialist home thread IDs
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
  backgroundThreadIds: string[]; // max 100 per member
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


The nested block has its own required `version: 1`. Runtime schemas cap
`members` and `projects` at 200 each, `hideFromSections` at 201, and each
`backgroundThreadIds` at 100. All ids are nonempty and at most 200 characters;
names are at most 40, preview text 160, avatar initials 8, avatar colour 32,
project glyph 64 and revision 64. Oversized arrays are sliced and
`truncated: true` reports omitted rows or background threads. The chief is
retained independently of the member cap. `yourMove` always counts **all**
open asks, including those whose member row was omitted.

Reading `sidebarState` only reads the bounded Team projection. It never
mirrors native tasks or performs setup. Workbench detection uses the selected
`sidebar.threadListProvider` plugin id (`workbench/<provider-id>`, with bare `workbench` and the earlier colon
representation also accepted), not unrelated preference text.
