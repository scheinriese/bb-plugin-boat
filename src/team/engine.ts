import { teamTime, answerSurface } from "../../lib/team-copy.ts";
import { createHash, randomBytes } from "node:crypto";
import {
  TEAM_SIDEBAR_LIMITS,
  assignmentInputSchema,
  askInputSchema,
  resultSchema,
  type Assignment,
  type AssignmentInput,
  type Ask,
  type AnswerInput,
  type Member,
  type Receipt,
  type TeamState,
  type TeamSidebar,
} from "../../contract-team.ts";
import { TeamStore } from "./store.ts";
import { core, CONSENT } from "./instructions.ts";
const id = (prefix: string) => prefix + randomBytes(8).toString("hex");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const waitingAsks = (asks: Ask[], now = new Date().toISOString()) =>
  asks
    .filter((a) => ["open", "confirming", "verifying"].includes(a.state))
    .sort(
      (a, b) =>
        Number(!!a.deferredUntil && a.deferredUntil > now) -
          Number(!!b.deferredUntil && b.deferredUntil > now) ||
        (a.due ?? "9999").localeCompare(b.due ?? "9999") ||
        Number(b.tier === "confirm") - Number(a.tier === "confirm") ||
        a.createdAt.localeCompare(b.createdAt),
    );
const safe = (text: string) =>
  JSON.stringify(text).replace(/\[/g, "\\u005b").replace(/\]/g, "\\u005d");
export class TeamEngine {
  readonly store: TeamStore;
  readonly changed: () => void;
  readonly now: () => Date;
  constructor(
    store: TeamStore,
    changed: () => void,
    now: () => Date = () => new Date(),
  ) {
    this.store = store;
    this.changed = changed;
    this.now = now;
  }
  at() {
    return this.now().toISOString();
  }
  enabled() {
    return this.store.setting("enabled", false);
  }
  requireEnabled() {
    if (!this.enabled())
      throw new Error("Turn on Team in Harbormaster settings first");
  }
  memberForThread(threadId: string) {
    return this.enabled()
      ? this.store
          .list("member")
          .find(
            (m) =>
              m.homeThreadId === threadId ||
              this.store
                .list("assignment")
                .some(
                  (a) =>
                    a.assignee === m.id &&
                    a.threadId === threadId &&
                    a.status !== "closed",
                ),
          )
      : undefined;
  }
  chief() {
    return this.store.list("member").find((m) => m.kind === "lead");
  }
  enable(name = "Nora", enabled = true) {
    return this.store.transaction(() => {
      let member = this.chief();
      const at = this.at();
      if (!member)
        member = this.store.put("member", {
          id: id("m_"),
          name,
          role: "Chief of staff",
          kind: "lead",
          homeThreadId: null,
          previousHomeThreadIds: [],
          projectId: "personal",
          orchestratorProjectId: null,
          standingInstructions:
            "## Always include\nRoute work, follow up, and report evidence. Say assigned until a result arrives.",
          placement: "mac",
          status: "active",
          avatar: { initials: name.slice(0, 1), color: "violet" },
          revision: 0,
          createdAt: at,
          updatedAt: at,
        });
      this.store.saveSetting("enabled", enabled);
      return member;
    });
  }
  saveMember(member: Member, patch: Partial<Member>) {
    return this.store.put(
      "member",
      {
        ...member,
        ...patch,
        id: member.id,
        revision: member.revision + 1,
        updatedAt: this.at(),
      },
      member.revision,
    );
  }
  saveRules(rules: string) {
    core(rules, 350);
    this.store.saveSetting("rules", rules);
    this.changed();
  }
  saveStanding(member: Member, document: string) {
    if (document.length > 20000)
      throw new Error("Standing instructions must fit 20,000 characters");
    core(document, 900);
    return this.saveMember(member, { standingInstructions: document });
  }
  home(member: Member, threadId: string) {
    if (member.homeThreadId === threadId) return member;
    this.store.event(member.id, "home-moved", "user", this.at(), {
      from: member.homeThreadId,
      to: threadId,
    });
    return this.saveMember(member, {
      homeThreadId: threadId,
      previousHomeThreadIds: member.homeThreadId
        ? [...member.previousHomeThreadIds, member.homeThreadId]
        : member.previousHomeThreadIds,
    });
  }
  syncLead(
    input: {
      threadId: string;
      projectId: string | null;
      projectName: string | null;
    },
    members = this.store.list("member"),
  ) {
    const found = members.find(
      (m) => m.kind === "project-lead" && m.homeThreadId === input.threadId,
    );
    if (found) return found;
    const at = this.at();
    return this.store.put("member", {
      id: id("m_"),
      name: (input.projectName
        ? `${input.projectName} lead`
        : "Project lead"
      ).slice(0, 40),
      role: "Project lead",
      kind: "project-lead",
      homeThreadId: input.threadId,
      previousHomeThreadIds: [],
      projectId: input.projectId ?? "personal",
      orchestratorProjectId: input.projectId,
      standingInstructions: "",
      placement: "either",
      status: "active",
      avatar: { initials: "P", color: "blue" },
      revision: 0,
      createdAt: at,
      updatedAt: at,
    });
  }
  state(workbench = false): TeamState {
    this.expireConfirmations();
    return {
      enabled: this.enabled(),
      now: this.at(),
      rules: this.store.setting("rules", ""),
      members: this.store.list("member"),
      assignments: this.store.list("assignment"),
      asks: this.store.list("ask"),
      incidents: this.store.list("incident"),
      receipts: this.store.list("receipt"),
      grants: this.store.list("grant"),
      legacyDecisionIds: this.store
        .list("ask")
        .flatMap((a) => (a.legacyDecisionId ? [a.legacyDecisionId] : [])),
      workbench,
    };
  }
  sidebar(): TeamSidebar | undefined {
    if (!this.enabled()) return undefined;
    const allMembers = this.store
      .list("member")
      .filter((m) => m.homeThreadId && m.status !== "archived");
    const members = allMembers.filter(
      (m) =>
        m.id.length <= 200 &&
        m.homeThreadId!.length <= 200 &&
        m.projectId.length <= 200,
    );
    const open = waitingAsks(this.store.list("ask"), this.at());
    const asksByMember = new Map<string, Ask[]>();
    for (const ask of open) {
      const group = asksByMember.get(ask.memberId) ?? [];
      group.push(ask);
      asksByMember.set(ask.memberId, group);
    }
    const workByMember = new Map<string, Assignment[]>();
    for (const a of this.store.list("assignment"))
      if (a.status !== "closed") {
        const group = workByMember.get(a.assignee) ?? [];
        group.push(a);
        workByMember.set(a.assignee, group);
      }
    let truncated = members.length !== allMembers.length;
    const chief = members.find((m) => m.kind === "lead");
    const nonChief = members.filter((m) => m.kind !== "lead");
    if (nonChief.length > TEAM_SIDEBAR_LIMITS.members) truncated = true;
    const selected = [
      ...(chief ? [chief] : []),
      ...nonChief.slice(0, TEAM_SIDEBAR_LIMITS.members),
    ];
    const preview = this.store.setting("chiefPreview", "Ready to help");
    const rows = selected.map((m, index) => {
      const asks = asksByMember.get(m.id) ?? [],
        work = workByMember.get(m.id) ?? [],
        assignment = work[0];
      const background = [
        ...new Set(
          work.flatMap((a) =>
            a.threadId && a.threadId !== m.homeThreadId ? [a.threadId] : [],
          ),
        ),
      ];
      if (
        background.length > TEAM_SIDEBAR_LIMITS.backgroundThreads ||
        background.some((id) => id.length > 200)
      )
        truncated = true;
      return {
        memberId: m.id,
        threadId: m.homeThreadId!,
        name: m.name,
        kind: m.kind,
        avatar: {
          initials: m.avatar.initials.slice(0, 8),
          color: m.avatar.color.slice(0, 32),
        },
        status: m.status,
        preview: {
          kind:
            m.kind === "lead"
              ? ("last-message" as const)
              : asks.length
                ? ("needs-you" as const)
                : assignment
                  ? ("activity" as const)
                  : ("last-message" as const),
          text: (m.kind === "lead"
            ? preview
            : (asks[0]?.title ??
              assignment?.lastProgress ??
              assignment?.title ??
              "Ready")
          ).slice(0, 160),
          tone: asks.some((a) => !a.threadId)
            ? ("attention" as const)
            : ("neutral" as const),
        },
        unread: { messages: 0, cards: asks.length },
        order: index,
        backgroundThreadIds: background
          .filter((id) => id.length <= 200)
          .slice(0, TEAM_SIDEBAR_LIMITS.backgroundThreads),
      };
    });
    const leads = members.filter((m) => m.kind === "project-lead");
    const hidden = members
      .filter((m) => m.kind !== "project-lead")
      .map((m) => m.homeThreadId!);
    if (
      leads.length > TEAM_SIDEBAR_LIMITS.projects ||
      hidden.length > TEAM_SIDEBAR_LIMITS.hidden
    )
      truncated = true;
    const body = {
      version: 1 as const,
      enabled: true as const,
      yourMove: {
        count: open.length,
        overdue: open.filter((a) => a.due && a.due < this.at()).length,
        confirm: open.filter((a) => a.tier === "confirm").length,
      },
      projects: leads
        .slice(0, TEAM_SIDEBAR_LIMITS.projects)
        .map((m) => ({
          bbProjectId: m.projectId,
          icon: "Folder",
          leadThreadId: m.homeThreadId!,
        })),
      lead: rows.find((m) => m.kind === "lead") ?? null,
      members: rows.filter((m) => m.kind !== "lead"),
      hideFromSections: hidden.slice(0, TEAM_SIDEBAR_LIMITS.hidden),
      truncated,
    };
    return { ...body, revision: hash(JSON.stringify(body)).slice(0, 24) };
  }
  updateAssignment(
    a: Assignment,
    patch: Partial<Assignment>,
    kind: string,
    actor: string,
  ) {
    const next = this.store.put(
      "assignment",
      { ...a, ...patch, revision: a.revision + 1, updatedAt: this.at() },
      a.revision,
    );
    this.store.event(a.id, kind, actor, this.at(), patch);
    return next;
  }
  assign(input: AssignmentInput, requester: string, source: string) {
    this.requireEnabled();
    input = assignmentInputSchema.parse(input);
    return this.store.transaction(() => {
      const member = this.store.get("member", input.assignee);
      if (member.status !== "active" || !member.homeThreadId)
        throw new Error("The member is not available");
      if (input.mode === "work" && !input.doneWhen.trim())
        throw new Error("no-done-when: work needs a checkable done when");
      const parent = input.parentId
        ? this.store.get("assignment", input.parentId)
        : null;
      if (parent && parent.assignee !== requester)
        throw new Error("Only the assignee can delegate this assignment");
      if (parent?.status === "closed")
        throw new Error("The parent assignment is closed");
      const depth = parent ? parent.depth + 1 : 0;
      if (depth > 4) throw new Error("hop-limit");
      let ancestor = parent;
      while (ancestor) {
        if (
          ancestor.assignee === input.assignee ||
          ancestor.requester === input.assignee
        )
          throw new Error("cycle");
        ancestor = ancestor.parentId
          ? this.store.get("assignment", ancestor.parentId)
          : null;
      }
      const open = this.store
        .list("assignment")
        .filter((a) => a.status !== "closed");
      const duplicate = open.find(
        (a) =>
          a.assignee === input.assignee &&
          a.mode === input.mode &&
          ((input.dedupeKey && a.dedupeKey === input.dedupeKey) ||
            (a.requester === requester &&
              a.parentId === input.parentId &&
              hash(a.brief.trim().replace(/\s+/g, " ")) ===
                hash(input.brief.trim().replace(/\s+/g, " ")))),
      );
      if (duplicate) {
        if (
          duplicate.requester !== requester &&
          !duplicate.watchers.includes(requester)
        )
          return this.updateAssignment(
            duplicate,
            { watchers: [...duplicate.watchers, requester] },
            "watcher",
            requester,
          );
        return duplicate;
      }
      if (open.filter((a) => a.requester === requester).length >= 16)
        throw new Error("policy: too many open assignments");
      const at = this.at(),
        assignmentId = id("a_");
      const a = this.store.put("assignment", {
        ...input,
        id: assignmentId,
        rootId: parent?.rootId ?? assignmentId,
        depth,
        requester,
        origin: parent?.origin ?? {
          kind: requester === "user" ? "user" : "member",
          id: requester,
          source,
        },
        watchers: [],
        status: "queued",
        outcome: null,
        result: null,
        lastProgress: null,
        threadId: member.homeThreadId,
        taskIds: [],
        decisionIds: [],
        waitUntil: null,
        treeTurnLimit: 120,
        continues: 0,
        turns: 0,
        maxTurns: input.mode === "consult" ? 4 : 20,
        deadline: new Date(
          this.now().getTime() + input.wallHours * 3600000,
        ).toISOString(),
        revision: 0,
        createdAt: at,
        updatedAt: at,
      });
      this.store.event(a.id, "created", requester, at, input);
      this.store.event(a.id, "budget-set", requester, at, {
        turns: a.maxTurns,
        wallHours: input.wallHours,
      });
      this.enqueue(
        a,
        "assignment",
        member.homeThreadId,
        `Mode: ${a.mode}. Title: ${safe(a.title)}\nBrief (data): ${safe(a.brief)}\nDone when: ${safe(a.doneWhen)}\nCheck ${a.id} in team_board before acting. Use team_start once, then team_report; notify needs no reply.`,
      );
      return a;
    });
  }
  queueDecisionAnswer(ask: Ask, threadId: string) {
    const receiptId = `r_decision_${ask.id}`;
    const existing = this.store
      .db()
      .prepare("SELECT 1 FROM team_records WHERE kind='receipt' AND id=?")
      .get(receiptId);
    if (existing) return;
    const nonce = id("n_"),
      at = this.at();
    const answer =
      ask.answer?.text.trim() ||
      ask.options.find((o) => o.id === ask.answer?.option)?.label ||
      "Answered";
    this.store.put("receipt", {
      id: receiptId,
      assignmentId: null,
      threadId,
      nonce,
      kind: "answer",
      text: `[team · decision answer · ${ask.id} · ${nonce}]\n${CONSENT}. This is a labelled answer relay, not an independent user request.\nQuestion: ${safe(ask.title)}\nAnswer: ${safe(answer)}\nProvenance: ${ask.answer?.provenance ?? "unverified tap"}.\n[/team]`,
      state: "pending",
      delivery: null,
      createdAt: at,
      updatedAt: at,
    });
  }
  enqueue(
    a: Assignment,
    kind: Receipt["kind"],
    threadId: string,
    text: string,
  ) {
    if (
      this.store
        .list("receipt")
        .some(
          (r) =>
            r.assignmentId === a.id &&
            r.kind === kind &&
            r.threadId === threadId &&
            kind !== "continue" &&
            kind !== "answer",
        )
    )
      return;
    const nonce = id("n_");
    const at = this.at();
    this.store.put("receipt", {
      id: id("r_"),
      assignmentId: a.id,
      threadId,
      nonce,
      kind,
      text: `[team · ${kind} · ${a.id} · ${nonce}]\n${CONSENT}. The following is a labelled member relay, not a user request.\n${text}\n[/team]`,
      state: "pending",
      delivery: null,
      createdAt: at,
      updatedAt: at,
    });
  }
  start(assignmentId: string, actor: string) {
    this.sweep();
    return this.store.transaction(() => {
      const a = this.owned(assignmentId, actor);
      if (a.status === "running") return a;
      if (!["delivered", "queued"].includes(a.status))
        throw new Error("This work cannot start in its current state");
      const root = this.store.get("assignment", a.rootId);
      if (
        this.store
          .list("assignment")
          .filter((w) => w.rootId === a.rootId)
          .reduce((n, w) => n + w.turns, 0) >= root.treeTurnLimit
      )
        throw new Error("The work tree needs a budget extension");
      if (a.mode === "notify")
        throw new Error("Notifications do not start work");
      return this.updateAssignment(
        a,
        { status: "running", turns: a.turns + 1 },
        "started",
        actor,
      );
    });
  }
  owned(assignmentId: string, actor: string) {
    this.requireEnabled();
    const a = this.store.get("assignment", assignmentId);
    if (a.assignee !== actor)
      throw new Error("This assignment belongs to another member");
    return a;
  }
  progress(assignmentId: string, actor: string, text: string) {
    const a = this.owned(assignmentId, actor);
    if (a.status !== "running")
      throw new Error("Start this assignment before reporting progress");
    return this.updateAssignment(
      a,
      { lastProgress: text.slice(0, 400) },
      "progress",
      actor,
    );
  }
  wait(assignmentId: string, actor: string, reason: string, until: string) {
    const a = this.owned(assignmentId, actor);
    if (a.status !== "running") throw new Error("This work is not running");
    return this.updateAssignment(
      a,
      { status: "waiting", lastProgress: reason, waitUntil: until },
      "waiting",
      actor,
    );
  }
  report(assignmentId: string, actor: string, result: unknown) {
    return this.store.transaction(() => {
      const a = this.owned(assignmentId, actor);
      if (a.status === "closed") return a;
      if (a.status !== "running")
        throw new Error("Only running work can report a result");
      if (
        this.store
          .list("ask")
          .some(
            (k) =>
              k.assignmentId === a.id &&
              ["open", "confirming", "verifying"].includes(k.state),
          )
      )
        throw new Error("Answer the open ask before closing this work");
      const parsed = resultSchema.parse(result);
      if (
        a.mode === "work" &&
        parsed.status === "done" &&
        (!parsed.evidence.trim() || parsed.evidence.toLowerCase() === "none")
      )
        parsed.status = "partial";
      const next = this.updateAssignment(
        a,
        { status: "closed", outcome: parsed.status, result: parsed },
        "result",
        actor,
      );
      if (a.parentId) {
        const parent = this.store.get("assignment", a.parentId);
        if (parent.status === "waiting")
          this.updateAssignment(
            parent,
            { status: "delivered", waitUntil: null },
            "continued",
            "team",
          );
      }
      for (const requester of new Set([a.requester, ...a.watchers])) {
        const recipient =
          requester === "user"
            ? this.chief()
            : this.store.get("member", requester);
        if (recipient?.homeThreadId)
          this.enqueue(
            a,
            "result",
            recipient.homeThreadId,
            `${safe(this.store.get("member", actor).name)} reports (not independently verified):\n${safe(JSON.stringify(parsed))}\nResume the parent work from team_board; do not poll.`,
          );
      }
      return next;
    });
  }
  incident(title: string, assignmentId: string | null) {
    const existing = this.store
      .list("incident")
      .find(
        (i) =>
          i.title === title && i.assignmentId === assignmentId && !i.resolvedAt,
      );
    if (existing) return existing;
    return this.store.put("incident", {
      id: id("i_"),
      title,
      assignmentId,
      resolvedAt: null,
      createdAt: this.at(),
    });
  }
  idle(threadId: string) {
    if (!this.enabled()) return;
    this.store.transaction(() => {
      for (const a of this.store
        .list("assignment")
        .filter(
          (a) =>
            a.threadId === threadId &&
            a.status === "running" &&
            !a.id.startsWith("a_native"),
        )) {
        if (!a.continues) {
          this.updateAssignment(a, { continues: 1 }, "continued", "team");
          this.enqueue(
            a,
            "continue",
            threadId,
            "Your turn ended without a structured result. Continue until done when holds, or team_report partial or blocked. If waiting, use team_wait.",
          );
        } else {
          this.updateAssignment(
            a,
            { status: "paused" },
            "stopped-early",
            "team",
          );
          this.incident(
            `${this.store.get("member", a.assignee).name} stopped early twice`,
            a.id,
          );
          this.createAsk({
            memberId: this.chief()!.id,
            assignmentId: a.id,
            threadId,
            verb: "Decide",
            title: `Continue ${a.title.slice(0, 50)}?`,
            unblocks: "Resuming the paused work",
            options: [
              {
                id: "continue",
                label: "Continue",
                effect: "Resume the same work",
                tier: "contained",
                recommended: true,
                action: "continue",
              },
              {
                id: "cancel",
                label: "Cancel",
                effect: "Cancel the work",
                tier: "contained",
                recommended: false,
                action: "cancel",
              },
            ],
            secondary: "Not now",
          });
        }
      }
    });
    this.changed();
  }
  createAsk(input: unknown): Ask {
    this.requireEnabled();
    const value = askInputSchema.parse(input);
    this.store.get("member", value.memberId);
    if (
      value.options.filter((o) => o.recommended).length > 1 ||
      new Set(value.options.map((o) => o.id)).size !== value.options.length
    )
      throw new Error("Use distinct options and at most one recommendation");
    const risky = new Set([
      "external-send",
      "spend",
      "ship",
      "destroy",
      "submit-personal",
      "local-full-access",
    ]);
    if (value.scope) {
      if (!value.scope.members.includes(value.memberId))
        throw new Error("Scope must name the asking member");
      const ttl = Date.parse(value.scope.expiresAt) - this.now().getTime();
      if (ttl <= 0 || ttl > 7 * 86400000)
        throw new Error("Grant expiry must be within seven days");
      if (
        risky.has(value.scope.actionClass) &&
        value.options.some((o) => o.action === "answer" && o.tier !== "confirm")
      )
        throw new Error("This action requires confirmation");
    }
    if (
      !value.options.some((o) => o.label === value.secondary) &&
      ["Deny", "Send back"].includes(value.secondary)
    )
      value.options.push({
        id: "secondary",
        label: value.secondary,
        effect: value.secondary,
        tier: "contained",
        recommended: false,
        action: "deny",
      });
    const at = this.at();
    return this.store.transaction(() => {
      const ask = this.store.put("ask", {
        ...value,
        id: id("k_"),
        tier: value.options.some((o) => o.tier === "confirm")
          ? "confirm"
          : "contained",
        state: "open",
        answer: null,
        after: {
          ranAt: null,
          revocable: false,
          heldUntil: null,
          undoUntil: null,
        },
        deferredUntil: null,
        revision: 0,
        createdAt: at,
        updatedAt: at,
      });
      if (value.assignmentId) {
        const a = this.store.get("assignment", value.assignmentId);
        if (a.status !== "closed" && a.status !== "paused")
          this.updateAssignment(
            a,
            { status: "needs-user" },
            "needs-user",
            value.memberId,
          );
      }
      this.changed();
      return ask;
    });
  }
  putAsk(ask: Ask, patch: Partial<Ask>) {
    const next = this.store.put(
      "ask",
      { ...ask, ...patch, revision: ask.revision + 1, updatedAt: this.at() },
      ask.revision,
    );
    this.store
      .db()
      .prepare("DELETE FROM team_confirm_tokens WHERE ask_id=?")
      .run(ask.id);
    this.changed();
    return next;
  }
  stale(a: Ask, revision: number) {
    if (a.revision !== revision || a.state !== "open")
      return a.answer && a.state === "answered"
        ? `Already answered ${teamTime(a.answer.at)} in ${answerSurface(a.answer.surface)}: ${a.options.find((o) => o.id === a.answer!.option)?.label ?? "Answered"}`
        : "This ask changed; check it again";
    return null;
  }
  answer(
    input: AnswerInput,
    provenance: "typed reply" | "unverified tap" = "unverified tap",
  ) {
    this.requireEnabled();
    this.expireConfirmations();
    return this.store.transaction(() => {
      const a = this.store.get("ask", input.askId);
      const stale = this.stale(a, input.revision);
      if (stale) return { ask: a, message: stale };
      if (input.option === "defer")
        return {
          ask: this.putAsk(a, {
            deferredUntil: new Date(
              this.now().getTime() + 86400000,
            ).toISOString(),
          }),
          message: "Not now",
        };
      const option = a.options.find((o) => o.id === input.option);
      if (!option) throw new Error("Choose one of this ask's options");
      if (option.id === "free-text" && !input.text.trim())
        throw new Error("Write an answer first");
      if (option.action === "defer")
        return {
          ask: this.putAsk(a, {
            deferredUntil: new Date(
              this.now().getTime() + 86400000,
            ).toISOString(),
          }),
          message: "Not now",
        };
      const answer = {
        option: option.id,
        text: input.text,
        at: this.at(),
        surface: input.surface,
        provenance,
      };
      if (option.tier === "confirm")
        return {
          ask: this.putAsk(a, { state: "confirming", answer }),
          message: "Waiting for the user's confirm",
        };
      return {
        ask: this.apply(a, answer),
        message: a.verb === "Do" ? "Checking the effect" : "Answered",
      };
    });
  }
  openConfirm(askId: string, revision: number) {
    this.requireEnabled();
    this.expireConfirmations();
    return this.store.transaction(() => {
      const ask = this.store.get("ask", askId);
      if (ask.state !== "confirming" || ask.revision !== revision)
        throw new Error("This ask changed; review it again");
      const token = id("ct_"),
        expiresAt = new Date(Date.parse(ask.updatedAt) + 120000).toISOString();
      this.store
        .db()
        .prepare("INSERT INTO team_confirm_tokens VALUES(?,?,?,?)")
        .run(askId, revision, hash(token), expiresAt);
      return { ask, confirmToken: token, expiresAt };
    });
  }
  confirm(askId: string, revision: number, token: string) {
    this.requireEnabled();
    return this.store.transaction(() => {
      const a = this.store.get("ask", askId);
      const row = this.store
        .db()
        .prepare("SELECT * FROM team_confirm_tokens WHERE ask_id=? AND hash=?")
        .get(askId, hash(token)) as
        | { hash: string; revision: number; expires_at: string }
        | undefined;
      if (
        !row ||
        row.hash !== hash(token) ||
        row.revision !== revision ||
        a.revision !== revision ||
        a.state !== "confirming" ||
        row.expires_at <= this.at()
      )
        throw new Error(
          "This confirmation timed out or changed. Review it again",
        );
      // Consume and apply in the same transaction. No tool exposes this token.
      this.store
        .db()
        .prepare("DELETE FROM team_confirm_tokens WHERE ask_id=?")
        .run(askId);
      return this.apply(a, { ...a.answer!, at: this.at() });
    });
  }
  cancelConfirm(askId: string, revision: number) {
    this.requireEnabled();
    const a = this.store.get("ask", askId);
    if (a.revision !== revision || a.state !== "confirming")
      throw new Error("This ask changed; check it again");
    return this.putAsk(a, { state: "open", answer: null });
  }
  expireConfirmations() {
    if (!this.enabled()) return;
    for (const a of this.store
      .list("ask")
      .filter((a) => a.state === "confirming")) {
      const row = this.store
        .db()
        .prepare("SELECT expires_at FROM team_confirm_tokens WHERE ask_id=?")
        .get(a.id) as { expires_at: string } | undefined;
      if (
        (row?.expires_at ??
          new Date(Date.parse(a.updatedAt) + 120000).toISOString()) <= this.at()
      )
        this.putAsk(a, { state: "open", answer: null });
    }
  }
  private apply(a: Ask, answer: NonNullable<Ask["answer"]>): Ask {
    const option = a.options.find((o) => o.id === answer.option)!;
    const allowed = option.action === "answer";
    if (a.scope && allowed) {
      if (a.scope.expiresAt <= this.at())
        throw new Error(
          "This approval scope expired. Ask again with a fresh scope",
        );
      const at = this.at();
      const held = ["external-send", "submit-personal"].includes(
        a.scope.actionClass,
      )
        ? new Date(this.now().getTime() + 30000).toISOString()
        : null;
      this.store.put("grant", {
        ...a.scope,
        id: id("g_"),
        askId: a.id,
        status: "active",
        usesLeft: a.scope.uses,
        notBefore: held ?? at,
        revision: 0,
        createdAt: at,
        updatedAt: at,
      });
      a = { ...a, after: { ...a.after, revocable: true, heldUntil: held } };
    }
    if (option.action === "extend-budget" && a.assignmentId) {
      const root = this.store.get("assignment", a.assignmentId);
      this.updateAssignment(
        root,
        { treeTurnLimit: root.treeTurnLimit + 120 },
        "budget-set",
        "user",
      );
      for (const work of this.store
        .list("assignment")
        .filter((w) => w.rootId === root.id && w.status === "paused"))
        this.updateAssignment(
          work,
          { status: "delivered" },
          "continued",
          "user",
        );
    }
    const next = this.putAsk(a, {
      state: a.verb === "Do" && allowed ? "verifying" : "answered",
      answer,
    });
    if (a.assignmentId && next.state === "answered") {
      const work = this.store.get("assignment", a.assignmentId);
      if (work.status !== "closed") {
        const cancel = option.action === "cancel";
        const otherAsks = waitingAsks(this.store.list("ask")).some(
          (k) => k.assignmentId === work.id,
        );
        const resumed = this.updateAssignment(
          work,
          {
            status: cancel ? "closed" : otherAsks ? "needs-user" : "delivered",
            outcome: cancel ? "cancelled" : null,
          },
          cancel ? "cancelled" : "answer",
          "user",
        );
        if (!cancel && !otherAsks && work.threadId)
          this.enqueue(
            resumed,
            "answer",
            work.threadId,
            `Answer to ${safe(a.title)}: ${safe(option.label)}. Provenance: ${answer.provenance}. Check team_board; risky actions still require team_grant_use.`,
          );
      }
    }
    return next;
  }
  useGrant(
    grantId: string,
    memberId: string,
    actionClass: string,
    target: string,
  ) {
    this.requireEnabled();
    return this.store.transaction(() => {
      const g = this.store.get("grant", grantId);
      if (
        g.status !== "active" ||
        !g.usesLeft ||
        g.expiresAt <= this.at() ||
        g.notBefore > this.at() ||
        !g.members.includes(memberId) ||
        g.actionClass !== actionClass ||
        !g.targets.includes(target) ||
        this.store.get("member", memberId).status !== "active"
      )
        throw new Error("No active grant covers this action");
      const next = this.store.put(
        "grant",
        {
          ...g,
          usesLeft: g.usesLeft - 1,
          status: g.usesLeft === 1 ? "used" : "active",
          revision: g.revision + 1,
          updatedAt: this.at(),
        },
        g.revision,
      );
      this.store.event(g.askId, "grant-used", memberId, this.at(), {
        target,
        actionClass,
      });
      this.changed();
      return next;
    });
  }
  effectRan(askId: string, memberId: string, evidence: string) {
    this.requireEnabled();
    return this.store.transaction(() => {
      const a = this.store.get("ask", askId);
      if (a.memberId !== memberId || !evidence.trim())
        throw new Error("Effect evidence and the asking member are required");
      if (
        a.scope &&
        !this.store
          .list("grant")
          .some((g) => g.askId === a.id && g.usesLeft < g.uses)
      )
        throw new Error("Consume the scoped grant before reporting an effect");
      if (!["answered", "verifying"].includes(a.state))
        throw new Error("This ask has no applied answer");
      this.store.event(a.id, "effect-reported", memberId, this.at(), {
        evidence,
      });
      return this.putAsk(a, {
        state: "answered",
        after: { ...a.after, ranAt: this.at() },
      });
    });
  }
  revoke(askId: string) {
    this.requireEnabled();
    this.store.transaction(() => {
      const a = this.store.get("ask", askId),
        at = this.at();
      for (const g of this.store
        .list("grant")
        .filter((g) => g.askId === a.id && g.status === "active"))
        this.store.put(
          "grant",
          {
            ...g,
            status: "revoked",
            usesLeft: 0,
            revision: g.revision + 1,
            updatedAt: at,
          },
          g.revision,
        );
      const root = a.assignmentId
        ? this.store.get("assignment", a.assignmentId).rootId
        : null;
      for (const work of this.store
        .list("assignment")
        .filter(
          (w) =>
            w.status !== "closed" &&
            w.assignee === a.memberId &&
            (!root || w.rootId === root),
        ))
        this.updateAssignment(work, { status: "waiting" }, "disputed", "user");
      this.saveMember(this.store.get("member", a.memberId), {
        status: "paused",
      });
      this.incident(`Disputed answer: ${a.title}`, a.assignmentId);
      this.putAsk(a, {
        after: { ...a.after, revocable: false, heldUntil: null },
      });
    });
    this.changed();
  }
  sweep() {
    if (!this.enabled()) return;
    this.store.transaction(() => {
      for (const a of this.store
        .list("assignment")
        .filter((a) => a.status !== "closed" && !a.id.startsWith("a_native"))) {
        if (a.deadline <= this.at() || a.turns > a.maxTurns) {
          this.updateAssignment(
            a,
            { status: "closed", outcome: "expired" },
            "expired",
            "team",
          );
          this.incident("Work reached its budget or deadline", a.id);
          const recipient =
            a.requester === "user"
              ? this.chief()
              : this.store.get("member", a.requester);
          if (recipient?.homeThreadId)
            this.enqueue(
              a,
              "result",
              recipient.homeThreadId,
              `${safe(a.title)} expired without a result. Check team_board and decide what to do next.`,
            );
        } else if (
          a.status === "waiting" &&
          a.waitUntil &&
          a.waitUntil <= this.at()
        ) {
          const next = this.updateAssignment(
            a,
            { status: "delivered", waitUntil: null },
            "continued",
            "team",
          );
          if (a.threadId)
            this.enqueue(
              next,
              "continue",
              a.threadId,
              "Your declared wait ended. Check the event and continue, or report blocked with evidence.",
            );
        }
      }
      const all = this.store.list("assignment");
      for (const root of all.filter(
        (a) =>
          a.id === a.rootId &&
          a.status !== "closed" &&
          !a.id.startsWith("a_native"),
      )) {
        const tree = all.filter((a) => a.rootId === root.id);
        if (tree.reduce((n, a) => n + a.turns, 0) < root.treeTurnLimit)
          continue;
        if (
          this.store
            .list("ask")
            .some(
              (k) =>
                k.assignmentId === root.id &&
                k.options.some((o) => o.action === "extend-budget") &&
                ["open", "confirming"].includes(k.state),
            )
        )
          continue;
        for (const work of tree.filter((a) => a.status !== "closed"))
          this.updateAssignment(
            work,
            { status: "paused" },
            "budget-paused",
            "team",
          );
        this.createAsk({
          memberId: this.chief()!.id,
          assignmentId: root.id,
          verb: "Decide",
          title: "Keep going?",
          unblocks: "Continuing this tree of work",
          context: `The team used ${root.treeTurnLimit} turns on ${root.title}.`,
          options: [
            {
              id: "extend",
              label: "Continue",
              effect: "Add another 120 turns to this work tree",
              tier: "contained",
              action: "extend-budget",
              recommended: false,
            },
            {
              id: "cancel",
              label: "Cancel",
              effect: "Cancel the root assignment",
              tier: "contained",
              action: "cancel",
              recommended: false,
            },
          ],
          secondary: "Not now",
        });
      }
    });
  }
}
