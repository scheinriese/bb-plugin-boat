// Canonical fictional cast and ask timeline from docs/team/EXAMPLE-DAY.md.
import { TeamEngine } from "../../src/team/engine.ts";
import {
  assignmentInputSchema,
  type Ask,
  type Member,
} from "../../contract-team.ts";
export function replayDay(
  engine: TeamEngine,
  clock: (at: string) => void,
  until = "18:00",
) {
  const date = "2026-11-26T";
  clock(date + "08:00:00Z");
  let chief = engine.home(engine.enable(), "home-nora");
  const members: Record<string, Member> = { Nora: chief };
  for (const name of [
    "Iris",
    "Developer",
    "Writer",
    "Olive",
    "Scout",
    "Web app lead",
    "Docs lead",
  ]) {
    let m = engine.syncLead({
      threadId: "home-" + name.toLowerCase().replaceAll(" ", "-"),
      projectId: name.includes("Docs")
        ? "docs"
        : name.includes("Web")
          ? "web"
          : null,
      bbProjectId: name.includes("Docs")
        ? "proj_docs"
        : name.includes("Web")
          ? "proj_web"
          : "proj_personal",
      projectName: name,
    });
    m = engine.saveMember(m, {
      name,
      kind: name.endsWith("lead") ? "project-lead" : "specialist",
      role: name.endsWith("lead") ? "Project lead" : name,
    });
    members[name] = m;
  }
  const assignments: Record<string, string> = {};
  const titles = [
    "Fix the checkout total rounding",
    "Pricing page",
    "Car service next week",
    "Docs 2.4 release notes",
    "Fix the docs search index",
    "Is checkout.spec flaky?",
  ];
  const owners = [
    "Web app lead",
    "Iris",
    "Olive",
    "Writer",
    "Docs lead",
    "Developer",
  ];
  [0, 1, 3, 4].forEach((i) => {
    const a = engine.assign(
      assignmentInputSchema.parse({
        assignee: members[owners[i]].id,
        title: titles[i],
        brief: titles[i],
        doneWhen:
          i === 0
            ? "PR against main, tests passing, checked on staging"
            : "Deliver the work with evidence",
        mode: "work",
        wallHours: 48,
      }),
      chief.id,
      "home-nora",
    );
    engine.start(a.id, a.assignee);
    assignments[String(i + 1)] = a.id;
  });
  const specs: [
    string,
    string,
    string,
    string,
    string,
    string,
    string | null,
  ][] = [
    [
      "K1",
      "Restart the staging API",
      "Approve",
      "Web app lead",
      "09:30",
      "Checking the checkout fix on staging",
      "1",
    ],
    [
      "K2",
      "Pick a pricing page layout",
      "Decide",
      "Iris",
      "12:00",
      "Building the pricing page",
      "2",
    ],
    [
      "K3",
      "Book the car service for Thu 3 Dec, 08:30",
      "Approve",
      "Olive",
      "17:00",
      "Booking the service and telling the garage",
      "3",
    ],
    [
      "K4",
      "Review and merge the checkout fix",
      "Review",
      "Web app lead",
      "16:00",
      "Shipping the checkout fix",
      "1",
    ],
    [
      "K5",
      "Review the Docs 2.4 release notes",
      "Review",
      "Writer",
      "17:00",
      "Publishing the notes with Docs 2.4",
      "4",
    ],
    [
      "K6",
      "Continue the pricing page build?",
      "Decide",
      "Nora",
      "14:00",
      "Finishing the pricing page",
      "2",
    ],
    [
      "K7",
      "Enter the new jobs database key",
      "Do",
      "Scout",
      "18:00",
      "Scout's job search",
      null,
    ],
    [
      "K8",
      "The build Mac is offline: where should the Safari check run?",
      "Decide",
      "Nora",
      "16:00",
      "Finishing the pricing page screenshots",
      "2",
    ],
    [
      "K9",
      "Review and merge the docs search fix",
      "Review",
      "Docs lead",
      "12:00",
      "Shipping the docs search fix",
      "5",
    ],
    [
      "K10",
      "Review and merge the pricing page",
      "Review",
      "Iris",
      "12:00",
      "Shipping the pricing page",
      "2",
    ],
    [
      "K11",
      "Apply to the Frontend engineer role at Example Corp",
      "Approve",
      "Scout",
      "12:00",
      "Sending your application",
      null,
    ],
  ];
  const asks: Record<string, Ask> = {};
  const add = (key: string) => {
    const [_, title, verb, owner, due, unblocks, assignment] = specs.find(
      (s) => s[0] === key,
    )!;
    const locked = ["K3", "K4", "K9", "K10", "K11"].includes(key);
    const label =
      key === "K2"
        ? "B · Three cards"
        : key === "K6"
          ? "Continue"
          : key === "K8"
            ? "Run it with WebKit in Iris's sandbox"
            : verb === "Review"
              ? locked
                ? "Merge"
                : "Accept"
              : verb === "Do"
                ? "Enter key…"
                : "Approve";
    const effect =
      key === "K11"
        ? "Send your CV (cv.pdf) and this cover note to Example Corp's careers form from your account? It can't be unsent.\n\nDear Example Corp,\nI'd like to apply for the Frontend engineer role. My experience building accessible interfaces and reliable tests fits this position.\n\nPlease find my CV attached."
        : key === "K3"
          ? "Send this message to the garage from your account and book Thu 3 Dec, 08:30? It can't be unsent."
          : locked
            ? `Merge the pull request into main. It can't be undone.`
            : unblocks;
    asks[key] = engine.createAsk({
      memberId: members[owner].id,
      assignmentId: assignment ? assignments[assignment] : null,
      threadId: assignment
        ? engine.store.get("assignment", assignments[assignment]).threadId
        : null,
      title,
      verb,
      unblocks,
      due:
        (key === "K9" || key === "K10" || key === "K11"
          ? "2026-11-27T"
          : date) +
        due +
        ":00Z",
      context: effect,
      confirmLabel:
        key === "K11"
          ? "Send the application"
          : key === "K3"
            ? "Send and book Thu 3 Dec, 08:30"
            : "Merge the pull request",
      secondary:
        verb === "Approve"
          ? "Deny"
          : verb === "Review"
            ? "Send back"
            : "Not now",
      options: [
        {
          id: "primary",
          label,
          effect,
          tier: locked ? "confirm" : "contained",
          recommended: ["K2", "K6", "K8"].includes(key),
          action: "answer",
        },
      ],
    });
  };
  const answer = (key: string) => {
    let a = asks[key];
    a = engine.answer({
      askId: a.id,
      revision: a.revision,
      option: "primary",
      text: "",
      surface: "tray",
    }).ask;
    if (a.state === "confirming") {
      const t = engine.openConfirm(a.id, a.revision);
      a = engine.confirm(a.id, a.revision, t.confirmToken);
    }
    asks[key] = a;
  };
  const resume = (key: string) => {
    const a = engine.store.get("assignment", assignments[key]);
    if (["delivered", "queued"].includes(a.status))
      engine.start(a.id, a.assignee);
  };
  const finish = (key: string, summary: string) => {
    resume(key);
    const a = engine.store.get("assignment", assignments[key]);
    engine.report(a.id, a.assignee, {
      status: "done",
      summary,
      delivered: "Completed work",
      evidence: "Checked the result",
      files: [],
      openQuestions: "none",
    });
  };
  const events: [string, () => void][] = [
    ["08:40", () => add("K2")],
    ["08:52", () => add("K1")],
    ["09:05", () => answer("K1")],
    [
      "09:06",
      () => {
        engine.effectRan(
          asks.K1.id,
          members["Web app lead"].id,
          "Staging health probe passed",
        );
        resume("1");
      },
    ],
    [
      "09:20",
      () => {
        const a = engine.assign(
          assignmentInputSchema.parse({
            assignee: members.Developer.id,
            title: titles[5],
            brief: "Is checkout.spec flaky?",
            mode: "consult",
          }),
          chief.id,
          "home",
        );
        engine.start(a.id, a.assignee);
        assignments["7"] = a.id;
      },
    ],
    [
      "09:35",
      () =>
        finish(
          "7",
          "Flaky since the time-zone change, fixed in the same PR; advice, not proof",
        ),
    ],
    [
      "09:45",
      () => {
        const a = engine.assign(
          assignmentInputSchema.parse({
            assignee: members.Olive.id,
            title: titles[2],
            brief: "Find a weekday morning before 11:00",
            doneWhen: "Slot booked and confirmation in mail",
            mode: "work",
          }),
          chief.id,
          "home",
        );
        engine.start(a.id, a.assignee);
        assignments["3"] = a.id;
      },
    ],
    ["10:15", () => add("K3")],
    ["10:30", () => add("K4")],
    [
      "11:15",
      () => {
        answer("K2");
        resume("2");
      },
    ],
    [
      "11:20",
      () => engine.incident("Docs search task stalled", assignments["5"]),
    ],
    [
      "11:30",
      () => {
        const i = engine.store.list("incident")[0];
        engine.store.put("incident", { ...i, resolvedAt: engine.at() }, 0);
      },
    ],
    ["11:40", () => add("K5")],
    [
      "12:50",
      () => {
        const a = engine.store.get("assignment", assignments["2"]);
        engine.updateAssignment(
          a,
          { status: "paused", lastProgress: "CI was still running" },
          "stopped-early",
          "team",
        );
        engine.incident("Iris stopped early twice", a.id);
        add("K6");
      },
    ],
    [
      "13:00",
      () => {
        answer("K6");
        resume("2");
      },
    ],
    [
      "13:05",
      () => {
        const i = engine.store
          .list("incident")
          .find((i) => i.title === "Iris stopped early twice")!;
        engine.store.put("incident", { ...i, resolvedAt: engine.at() }, 0);
      },
    ],
    ["13:10", () => answer("K3")],
    [
      "13:11",
      () =>
        engine.effectRan(
          asks.K3.id,
          members.Olive.id,
          "Garage confirmed booking",
        ),
    ],
    [
      "13:12",
      () => finish("3", "Booked Thu 3 Dec, 08:30; confirmation in mail"),
    ],
    [
      "13:40",
      () => {
        add("K7");
        engine.incident("Jobs database connector dropped", null);
      },
    ],
    [
      "14:00",
      () => {
        const a = engine.store.get("assignment", assignments["2"]);
        engine.updateAssignment(
          a,
          {
            status: "waiting",
            lastProgress: "waiting for the build Mac · offline since 14:00",
          },
          "waiting",
          "team",
        );
      },
    ],
    [
      "14:10",
      () => engine.incident("Build Mac offline since 14:00", assignments["2"]),
    ],
    ["15:00", () => add("K8")],
    [
      "15:05",
      () => {
        answer("K8");
        resume("2");
      },
    ],
    ["15:30", () => add("K9")],
    ["15:40", () => add("K10")],
    [
      "15:50",
      () => {
        answer("K5");
        finish("4", "Release notes accepted");
      },
    ],
    ["15:52", () => answer("K4")],
    [
      "15:53",
      () => {
        engine.effectRan(asks.K4.id, members["Web app lead"].id, "PR merged");
        finish("1", "Checkout fix merged");
      },
    ],
    ["17:05", () => answer("K7")],
    [
      "17:06",
      () => {
        engine.effectRan(asks.K7.id, members.Scout.id, "Key probe passed");
        const i = engine.store
          .list("incident")
          .find((i) => i.title === "Jobs database connector dropped")!;
        engine.store.put("incident", { ...i, resolvedAt: engine.at() }, 0);
      },
    ],
    ["17:20", () => add("K11")],
    [
      "17:30",
      () => {
        const i = engine.store
          .list("incident")
          .find((i) => i.title.startsWith("Build Mac"))!;
        engine.store.put("incident", { ...i, resolvedAt: engine.at() }, 0);
      },
    ],
  ];
  for (const [at, event] of events) {
    if (at > until) break;
    clock(date + at + ":00Z");
    event();
  }
  clock(date + until + ":00Z");
  engine.store.saveSetting(
    "chiefPreview",
    until < "12:00"
      ? "Nothing failed overnight. Waiting on your answers."
      : until < "18:00"
        ? "The checkout fix is ready for your review."
        : "The checkout fix was merged; the release notes were accepted.",
  );
  return { state: engine.state(), asks, assignments };
}
