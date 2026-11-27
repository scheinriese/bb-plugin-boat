import type { PullRequestFacts } from "../contract-merge";
import { teamAvatars } from "./team-avatars";
import { useEffect, useState, type ReactNode } from "react";
import {
  experimental_useRpcQuery,
  experimental_useRpcMutation,
  useBbNavigate,
  type ExperimentalBadge,
} from "@get-bb/plugin-sdk/app";
import {
  teamRpcContract,
  type Ask,
  type TeamState,
  type Assignment,
} from "../contract-team";
import { PANEL_PATH } from "./format";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { showError } from "./ui";
import "./team.css";
export const useTeam = () =>
  experimental_useRpcQuery({
    contract: teamRpcContract,
    method: "teamState",
    input: null,
  });
export const openAsks = (asks: Ask[]) =>
  asks
    .filter((a) => ["open", "confirming", "verifying"].includes(a.state))
    .sort(
      (a, b) =>
        Number(!!a.deferredUntil && Date.parse(a.deferredUntil) > Date.now()) -
          Number(
            !!b.deferredUntil && Date.parse(b.deferredUntil) > Date.now(),
          ) ||
        (a.due ?? "9999").localeCompare(b.due ?? "9999") ||
        Number(b.tier === "confirm") - Number(a.tier === "confirm") ||
        a.createdAt.localeCompare(b.createdAt),
    );
const time = (at: string) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const due = (at: string) =>
  new Date(at).toLocaleString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
export function useTeamBadge(): ExperimentalBadge | null {
  const { data } = useTeam();
  const count =
    data?.enabled && !data.workbench ? openAsks(data.asks).length : 0;
  return count
    ? { count, tone: "warning", label: `Team: ${count} need you` }
    : null;
}
export function TeamAvatar({ name }: { name: string }) {
  const key = (Object.keys(teamAvatars).find((k) =>
    name.toLowerCase().includes(k),
  ) ?? "nora") as keyof typeof teamAvatars;
  return (
    <span className="team-avatar" aria-hidden="true">
      <img className="hidden dark:block" src={teamAvatars[key].dark} alt="" />
      <img className="dark:hidden" src={teamAvatars[key].light} alt="" />
    </span>
  );
}
export function AskView({
  ask,
  state,
  surface = "today",
  full = false,
}: {
  ask: Ask;
  state: TeamState;
  surface?: "today" | "tray" | "strip" | "board" | "confirm-view";
  full?: boolean;
}) {
  const answer = experimental_useRpcMutation({
    contract: teamRpcContract,
    method: "answerAsk",
  });
  const revoke = experimental_useRpcMutation({
    contract: teamRpcContract,
    method: "revokeAsk",
  });
  const cancel = experimental_useRpcMutation({
    contract: teamRpcContract,
    method: "cancelAskConfirm",
  });
  const open = experimental_useRpcMutation({
    contract: teamRpcContract,
    method: "openAskConfirm",
  });
  const confirm = experimental_useRpcMutation({
    contract: teamRpcContract,
    method: "confirmAsk",
  });
  const [token, setToken] = useState<{
    confirmToken: string;
    expiresAt: string;
    revision: number;
  } | null>(null);
  const [facts, setFacts] = useState<PullRequestFacts | null>(null);
  const [notice, setNotice] = useState("");
  const navigate = useBbNavigate();
  const member = state.members.find((m) => m.id === ask.memberId);
  useEffect(() => {
    setToken(null);
    let current = true;
    if (ask.state === "confirming")
      void open
        .mutate({ askId: ask.id, revision: ask.revision })
        .then((result) => {
          if (current) {
            setToken({ ...result, revision: ask.revision });
            setFacts(result.facts ?? null);
          }
        })
        .catch((error) => {
          if (current)
            setNotice(
              error instanceof Error ? error.message : "Review this ask again",
            );
        });
    return () => {
      current = false;
    };
  }, [ask.id, ask.revision, ask.state]);
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      setNotice(
        e instanceof Error ? e.message : "This ask changed; check it again",
      );
    }
  };
  async function choose(option: string) {
    await run(async () => {
      const result = await answer.mutate({
        askId: ask.id,
        revision: ask.revision,
        option,
        text: "",
        surface,
      });
      setNotice(result.message);
      const picked = ask.options.find((o) => o.id === option);
      if (
        result.ask.state === "confirming" &&
        result.ask.taskId &&
        result.ask.threadId &&
        surface !== "strip"
      ) {
        navigate.toThread(result.ask.threadId);
        return;
      }
      if (
        result.ask.state === "confirming" &&
        (picked?.effect.split("\n").length ?? 0) > 3 &&
        !full
      )
        navigate.toPluginPanel(PANEL_PATH, { subPath: `ask/${ask.id}` });
    });
  }
  const answered = ask.state === "answered";
  return (
    <article className="team-ask" aria-label={ask.title}>
      <div className="team-ask-heading">
        <TeamAvatar name={member?.name ?? "Team"} />
        <div className="min-w-0 flex-1">
          <h3>
            {ask.title}
            {ask.due && !answered && (
              <span className="team-due"> · due {time(ask.due)}</span>
            )}
          </h3>
          <p className={answered ? "hidden" : ""}>
            {member?.name ?? "Team"}
            {` · unblocks ${ask.unblocks}`}
          </p>
        </div>
        {ask.tier === "confirm" && !answered && (
          <Icon name="Lock" className="size-3.5 text-muted-foreground" />
        )}
      </div>

      {full && ask.context && ask.state !== "confirming" && (
        <div className="team-scope whitespace-pre-wrap">{ask.context}</div>
      )}
      {ask.state === "confirming" ? (
        <div className="team-confirm">
          <p className="whitespace-pre-wrap">
            {ask.options.find((o) => o.id === ask.answer?.option)?.effect}
          </p>
          {ask.scope && (
            <p className="text-xs text-muted-foreground">
              For {ask.scope.targets.join(", ")} · {ask.scope.uses} use
              {ask.scope.uses === 1 ? "" : "s"} · until{" "}
              {due(ask.scope.expiresAt)}
            </p>
          )}
          {facts && (
            <div className="team-merge-checks">
              <p>
                PR #{facts.number} · {facts.title}
              </p>
              <p>
                Exact commit: <code>{facts.head.slice(0, 12)}</code>
              </p>
              {facts.checks.map((c) => (
                <p key={c.name}>✓ {c.name}</p>
              ))}
              <p>✓ Merges cleanly into {facts.baseBranch}</p>
            </div>
          )}
          <div className="team-actions">
            <Button
              size="sm"
              disabled={!token || open.isPending || confirm.isPending}
              onClick={() =>
                void run(async () => {
                  if (!token) return;
                  if (Date.parse(token.expiresAt) <= Date.now()) {
                    setToken(null);
                    setNotice("This confirmation timed out. Review it again");
                    return;
                  }
                  await confirm.mutate({
                    askId: ask.id,
                    revision: ask.revision,
                    confirmToken: token.confirmToken,
                  });
                  setToken(null);
                })
              }
            >
              {facts
                ? `Merge PR #${facts.number} into ${facts.baseBranch}`
                : ask.confirmLabel}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void run(() =>
                  cancel.mutate({ askId: ask.id, revision: ask.revision }),
                )
              }
            >
              Cancel
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            A tap is recorded as unverified.
          </p>
        </div>
      ) : ask.state === "verifying" ? (
        <p className="team-receipt">Checking the effect…</p>
      ) : answered ? (
        <div className="team-receipt">
          <p>
            {(
              {
                Approve: "Approved",
                Accept: "Accepted",
                Continue: "Continued",
                Merge: "Approved",
              } as Record<string, string>
            )[
              ask.options.find((o) => o.id === ask.answer?.option)?.label ?? ""
            ] ??
              ask.options.find((o) => o.id === ask.answer?.option)?.label ??
              "Answered"}{" "}
            {ask.answer ? time(ask.answer.at) : ""} ·{" "}
            {ask.after.ranAt
              ? `ran ${time(ask.after.ranAt)} (reported by ${member?.name ?? "the member"})`
              : ask.after.heldUntil &&
                  Date.parse(ask.after.heldUntil) > Date.now()
                ? `held until ${time(ask.after.heldUntil)}`
                : "waiting to run"}
          </p>
          <p>
            {ask.answer?.provenance} · {ask.answer?.surface}
          </p>
          {ask.after.revocable && (
            <button
              className="team-link"
              onClick={() => void run(() => revoke.mutate({ askId: ask.id }))}
            >
              Wasn't me? Pause and revoke
            </button>
          )}
        </div>
      ) : ask.state === "open" ? (
        <div className="team-actions">
          {ask.options.map((option) => (
            <Button
              key={option.id}
              size="sm"
              variant={option.recommended ? "default" : "outline"}
              disabled={answer.isPending}
              onClick={() => void choose(option.id)}
            >
              {option.tier === "confirm" && (
                <Icon name="Lock" className="size-3" />
              )}
              {option.label}
              {option.tier === "confirm" && !option.label.endsWith("…")
                ? "…"
                : ""}
              {option.recommended ? " ★" : ""}
            </Button>
          ))}
          {!ask.options.some((o) => o.label === ask.secondary) && (
            <Button
              size="sm"
              variant="ghost"
              disabled={answer.isPending}
              onClick={() => void choose("defer")}
            >
              Not now
            </Button>
          )}
        </div>
      ) : (
        <p className="team-receipt">This ask is {ask.state}.</p>
      )}
      {notice && (
        <p role="status" className="team-notice">
          {notice}
        </p>
      )}
    </article>
  );
}
export function TeamToday({ state }: { state: TeamState }) {
  const asks = openAsks(state.asks);
  const today = new Date(state.now).toDateString();
  const answered = state.asks
    .filter(
      (a) =>
        a.state === "answered" &&
        a.answer &&
        new Date(a.answer.at).toDateString() === today,
    )
    .sort((a, b) => b.answer!.at.localeCompare(a.answer!.at));
  return (
    <div className="team-today">
      <div className="team-today-main">
        <section>
          <h2>Your move</h2>
          <p className="team-description">
            A few things need your answer so the team can move forward.
          </p>
          {asks.length ? (
            asks.map((ask) => <AskView key={ask.id} ask={ask} state={state} />)
          ) : (
            <p className="team-empty">You're all caught up.</p>
          )}
        </section>
        <section>
          <h2>Answered today</h2>
          {answered.length ? (
            answered.map((ask) => (
              <AskView key={ask.id} ask={ask} state={state} />
            ))
          ) : (
            <p className="team-empty">
              Your answers and their receipts will appear here.
            </p>
          )}
        </section>
        <section>
          <h2>Problems</h2>
          {state.incidents.filter((i) => !i.resolvedAt).length ? (
            state.incidents
              .filter((i) => !i.resolvedAt)
              .map((i) => (
                <div className="team-problem" key={i.id}>
                  <Icon name="TriangleAlert" className="size-4" />
                  <div>
                    {i.title}
                    <p>Since {time(i.createdAt)}</p>
                  </div>
                </div>
              ))
          ) : (
            <p className="team-empty">No open problems.</p>
          )}
        </section>
      </div>
      <aside className="team-today-rail">
        <h2>
          In progress <small>nothing needed from you</small>
        </h2>
        {state.assignments
          .filter((a) => ["running", "waiting", "delivered"].includes(a.status))
          .map((a) => (
            <div className="team-progress-row" key={a.id}>
              <strong>{a.title}</strong>
              <p>
                {state.members.find((m) => m.id === a.assignee)?.name} ·{" "}
                {a.status === "waiting" ? "waiting" : "working"}
              </p>
              {a.lastProgress && (
                <p>
                  {state.members.find((m) => m.id === a.assignee)?.name}'s plan:{" "}
                  {a.lastProgress}
                </p>
              )}
            </div>
          ))}
        <h2>Done today</h2>
        {state.assignments
          .filter(
            (a) =>
              a.outcome === "done" &&
              new Date(a.updatedAt).toDateString() === today,
          )
          .map((a) => (
            <div className="team-progress-row" key={a.id}>
              <strong>{a.title}</strong>
              <p>
                {state.members.find((m) => m.id === a.assignee)?.name} ·{" "}
                {a.result?.summary ?? "Done"}
              </p>
            </div>
          ))}
      </aside>
    </div>
  );
}
const flow = (a: Assignment, asks: Ask[]) =>
  asks.some(
    (k) =>
      k.assignmentId === a.id &&
      ["open", "confirming", "verifying"].includes(k.state),
  )
    ? "Needs you"
    : a.status === "closed"
      ? a.outcome === "done"
        ? "Done today"
        : a.outcome === "cancelled"
          ? "Cancelled"
          : "Stopped"
      : a.status === "paused"
        ? "Paused · stopped early"
        : a.status === "waiting"
          ? "Waiting"
          : a.status === "queued"
            ? "Queued"
            : "Running";
export function TeamBoard({
  state,
  initialSelected = null,
}: {
  state: TeamState;
  initialSelected?: string | null;
}) {
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const active = state.assignments.find((a) => a.id === selected);
  const groups = [
    "Needs you",
    "Running",
    "Waiting",
    "Paused · stopped early",
    "Queued",
    "Done today",
    "Stopped",
    "Cancelled",
  ];
  return (
    <div className="team-board-layout">
      <div className="team-board">
        <div className="team-board-label">By flow</div>
        {groups.map((group) => {
          const rows = state.assignments.filter(
            (a) =>
              flow(a, state.asks) === group &&
              (a.status !== "closed" ||
                new Date(a.updatedAt).toDateString() ===
                  new Date(state.now).toDateString()),
          );
          return rows.length ? (
            <section key={group}>
              <h2>{group}</h2>
              {rows.map((a) => (
                <button
                  className="team-board-row"
                  key={a.id}
                  onClick={() => setSelected(a.id)}
                >
                  <span>
                    <strong>{a.title}</strong>
                    <small>
                      {state.members.find((m) => m.id === a.assignee)?.name} ·{" "}
                      {a.mode}
                    </small>
                  </span>
                  <span>
                    {a.lastProgress ?? `${a.turns} of ${a.maxTurns} turns`}
                  </span>
                  <Icon name="ChevronRight" className="size-4" />
                </button>
              ))}
            </section>
          ) : null;
        })}
        {!state.assignments.length && (
          <p className="team-empty">
            Ask your chief to assign the first piece of work.
          </p>
        )}
      </div>
      {active && (
        <aside className="team-detail">
          <button className="team-link" onClick={() => setSelected(null)}>
            Close details
          </button>
          <h2>{active.title}</h2>
          <p>
            {state.members.find((m) => m.id === active.assignee)?.name} ·{" "}
            {flow(active, state.asks)}
          </p>
          {state.asks
            .filter((a) => a.assignmentId === active.id && ["open","confirming","verifying"].includes(a.state))
            .map((a) => (
              <AskView key={a.id} ask={a} state={state} surface="board" full />
            ))}
          <h3>Brief</h3>
          <p className="whitespace-pre-wrap">{active.brief}</p>
          <h3>Done when</h3>
          <p>{active.doneWhen || "An answer"}</p>
          <h3>Progress</h3>
          <p>
            {active.lastProgress
              ? `${state.members.find((m) => m.id === active.assignee)?.name}'s plan: ${active.lastProgress}`
              : "No progress reported"}
          </p>
          <p>
            {active.turns} of {active.maxTurns} turns · due{" "}
            {due(active.deadline)}
          </p>
          {active.result && (
            <>
              <h3>Result reported by the member</h3>
              <p>{active.result.summary}</p>
              <p>{active.result.evidence}</p>
            </>
          )}
          <h3>Delivery receipts</h3>
          {state.receipts
            .filter((r) => r.assignmentId === active.id)
            .map((r) => (
              <p key={r.id}>
                {r.kind} · {r.state} · {time(r.updatedAt)}
              </p>
            ))}
        </aside>
      )}
    </div>
  );
}
export function TeamPage({
  state,
  section,
  children,
  initialSelected,
}: {
  state: TeamState;
  section: string;
  initialSelected?: string;
  children?: ReactNode;
}) {
  const navigate = useBbNavigate();
  const chief = state.members.find((m) => m.kind === "lead");
  const askId = section.startsWith("ask/") ? section.slice(4) : null;
  const ask = state.asks.find((a) => a.id === askId);
  return (
    <div className="boat-ui team-page h-full overflow-y-auto">
      <header className="team-page-heading">
        <div>
          <h1>Team</h1>
          <p>Work moving forward, with you in the loop.</p>
        </div>
        {chief?.homeThreadId && (
          <Button
            variant="outline"
            onClick={() => navigate.toThread(chief.homeThreadId!)}
          >
            <TeamAvatar name={chief.name} />
            Talk to {chief.name}
          </Button>
        )}
      </header>
      <nav className="team-tabs" aria-label="Team pages">
        {["today", "board", "sandboxes", "usage", "projects"].map((tab) => (
          <button
            key={tab}
            aria-current={
              section === tab || (!section && tab === "today")
                ? "page"
                : undefined
            }
            onClick={() =>
              navigate.toPluginPanel(PANEL_PATH, {
                subPath: tab === "today" ? "" : tab,
              })
            }
          >
            {tab[0].toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </nav>
      {askId ? (
        <main className="team-confirm-page">
          <button
            className="team-link"
            onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "" })}
          >
            Back to Today
          </button>
          {ask ? (
            <AskView ask={ask} state={state} surface="confirm-view" full />
          ) : (
            <p>This ask is no longer available.</p>
          )}
        </main>
      ) : section === "board" ? (
        <TeamBoard state={state} initialSelected={initialSelected} />
      ) : section === "today" || !section ? (
        <>
          <TeamToday state={state} />
          {children}
        </>
      ) : (
        children
      )}
    </div>
  );
}
export function TeamChatAsks({ threadId }: { threadId: string }) {
  const { data } = useTeam();
  if (!data?.enabled) return null;
  const chief = data.members.find((m) => m.kind === "lead");
  const tray = chief?.homeThreadId === threadId;
  const visible = data.asks.filter(
    (a) =>
      ["open", "confirming", "verifying"].includes(a.state) ||
      (a.answer && Date.now() - Date.parse(a.answer.at) < 10000) ||
      (a.after.heldUntil && Date.parse(a.after.heldUntil) > Date.now()),
  );
  const asks = visible.filter((a) => tray || a.threadId === threadId);
  if (!asks.length) return null;
  return (
    <div
      className={
        "boat-ui team-chat-asks " + (tray ? "team-tray" : "team-strip")
      }
    >
      <h2>{tray ? `${chief.name}'s ask tray` : "Waiting on your answer"}</h2>
      {asks.map((ask) => (
        <AskView
          key={ask.id}
          ask={ask}
          state={data}
          surface={tray ? "tray" : "strip"}
        />
      ))}
      {asks[0] && (
        <p className="team-next">
          Next: {asks[0].title}
          {asks.length > 1 ? " · then 1 more" : ""}
        </p>
      )}
    </div>
  );
}
export function useTeamAsksVisible({ threadId }: { threadId: string }) {
  const { data } = useTeam();
  return (
    !!data?.enabled &&
    data.asks
      .filter(
        (a) =>
          ["open", "confirming", "verifying"].includes(a.state) ||
          (a.answer && Date.now() - Date.parse(a.answer.at) < 10000) ||
          (a.after.heldUntil && Date.parse(a.after.heldUntil) > Date.now()),
      )
      .some(
        (a) =>
          a.threadId === threadId ||
          data.members.some(
            (m) => m.kind === "lead" && m.homeThreadId === threadId,
          ),
      )
  );
}
export function TeamAskSummary({ threadId }: { threadId: string }) {
  const { data } = useTeam();
  if (!data?.enabled) return null;
  const asks = openAsks(data.asks).filter(
    (a) =>
      a.threadId === threadId ||
      data.members.some(
        (m) => m.kind === "lead" && m.homeThreadId === threadId,
      ),
  );
  return (
    <span className="text-sm">
      <span className="team-ask-dot inline-block mr-2" />
      {asks[0]?.title ?? "Your move"}
    </span>
  );
}
export function TeamSettings() {
  const { data } = useTeam();
  const save = experimental_useRpcMutation({
    contract: teamRpcContract,
    method: "teamSave",
  });
  const resume = experimental_useRpcMutation({
    contract: teamRpcContract,
    method: "resumeTeamMember",
  });
  const [name, setName] = useState("");
  const [rules, setRules] = useState("");
  const [standing, setStanding] = useState("");
  const chief = data?.members.find((m) => m.kind === "lead");
  useEffect(() => {
    setName(chief?.name ?? "Nora");
    setRules(data?.rules ?? "");
    setStanding(
      chief?.standingInstructions ??
        "## Always include\nRoute work and follow up on evidence.",
    );
  }, [chief?.revision, data?.rules]);
  if (!data) return null;
  return (
    <section className="team-settings">
      <h3>Team</h3>
      {data.members
        .filter((m) => m.status === "paused")
        .map((m) => (
          <p key={m.id}>
            {m.name} is paused.{" "}
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void resume.mutate({ memberId: m.id }).catch(showError)
              }
            >
              Resume
            </Button>
          </p>
        ))}
      <label className="flex gap-2 items-center">
        <input
          type="checkbox"
          checked={data.enabled}
          disabled={save.isPending}
          onChange={(e) =>
            void save.mutate({ enabled: e.target.checked }).catch(showError)
          }
        />
        Enable Team
      </label>
      <p className="text-sm text-muted-foreground">
        A chief of staff and your existing project leads, with tracked work and
        asks.
      </p>
      {data.enabled && (
        <>
          <label>
            Chief's name
            <input
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Standing instructions
            <textarea
              rows={6}
              value={standing}
              onChange={(e) => setStanding(e.target.value)}
            />
          </label>
          <label>
            Team rules
            <textarea
              rows={5}
              placeholder="## Always include"
              value={rules}
              onChange={(e) => setRules(e.target.value)}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Use a ## Always include section: up to 900 characters for standing
            instructions, 350 for shared rules.
          </p>
          <Button
            size="sm"
            disabled={save.isPending}
            onClick={() =>
              void save
                .mutate({
                  enabled: true,
                  name,
                  standingInstructions: standing,
                  rules,
                })
                .catch(showError)
            }
          >
            Save Team
          </Button>
        </>
      )}
    </section>
  );
}
