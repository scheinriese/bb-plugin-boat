import { renderToStaticMarkup } from "react-dom/server";
import { TeamPage, TeamChatAsks, TeamBoard, TeamAvatar } from "../web/team";
import { memoryStore } from "../test/fakes";
import { TeamEngine } from "../src/team/engine";
import { replayDay } from "../test/fixtures/team-day";
import { setTeamFixture } from "../test/fixtures/team-preview-sdk";
export function renderScene(scene: string) {
  let now = new Date("2026-11-26T08:00:00Z");
  const engine = new TeamEngine(
    memoryStore().team,
    () => {},
    () => now,
  );
  const replay = replayDay(
    engine,
    (at) => {
      now = new Date(at);
    },
    scene === "confirm" ? "18:00" : scene === "strip" ? "09:00" : "14:30",
  );
  if (scene === "confirm") {
    const a = replay.asks.K11;
    engine.answer({
      askId: a.id,
      revision: a.revision,
      option: "primary",
      text: "",
      surface: "confirm-view",
    });
  }
  const state = engine.state();
  setTeamFixture(state);
  const chief = engine.chief()!;
  const count = engine.sidebar()!.yourMove.count;
  const content =
    scene === "tray" || scene === "strip" ? (
      <div className="preview-chat">
        <h1>{scene === "tray" ? "Nora" : "Fix the checkout total rounding"}</h1>
        <div className="preview-message">
          <TeamAvatar name="Nora" />
          <p>
            {scene === "tray"
              ? "The checkout fix is ready for your review. Waiting on you: Review and merge the checkout fix; Review the Docs 2.4 release notes; Enter the new jobs database key."
              : "The checkout fix needs the staging API restarted before I can check it on staging."}
          </p>
        </div>
        <div className="preview-composer">
          <TeamChatAsks
            threadId={
              scene === "tray" ? chief.homeThreadId! : "home-web-app-lead"
            }
          />
          <div className="preview-input">
            Message {scene === "tray" ? "Nora" : "Web app lead"}…
          </div>
        </div>
      </div>
    ) : scene === "board" ? (
      <TeamPage
        state={state}
        section="board"
        initialSelected={replay.assignments["1"]}
      />
    ) : (
      <TeamPage
        state={state}
        section={scene === "confirm" ? `ask/${replay.asks.K11.id}` : "today"}
      />
    );
  return renderToStaticMarkup(
    <div className="preview-shell">
      <aside className="preview-sidebar">
        <div className="preview-nora">
          <TeamAvatar name="Nora" />
          <span>
            <b>Nora</b> · chief of staff
            <small>{engine.store.setting("chiefPreview", "")}</small>
          </span>
          <strong>{count}</strong>
        </div>
        <p>＋ New thread</p>
        <p>◉ Plugins</p>
        <p>ϟ Skills</p>
        <p>◷ Automations</p>
        <p className="preview-active">▣ Team</p>
        <hr />
        <p>Team</p>
        {state.members
          .filter((m) => m.kind === "specialist")
          .map((m) => (
            <p key={m.id}>
              <TeamAvatar name={m.name} />
              {m.name}
            </p>
          ))}
        <hr />
        {state.members
          .filter((m) => m.kind === "project-lead")
          .map((m) => (
            <div key={m.id}>
              <p>
                <TeamAvatar name={m.name} />
                {m.name}
              </p>
              {state.assignments
                .filter((a) => a.assignee === m.id)
                .map((a) => (
                  <small key={a.id}>{a.title}</small>
                ))}
            </div>
          ))}
        <p className="preview-caption">
          Fictional example-day fixture
          <br />
          Rendered plugin components
        </p>
      </aside>
      <main>{content}</main>
    </div>,
  );
}
