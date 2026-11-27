/** Shared user-facing copy; persisted enum values never appear as labels. */
export const teamTime = (at: string) =>
  new Date(at).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
export const teamDue = (at: string) =>
  new Date(at).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
export function answerSurface(surface: string) {
  return (
    (
      {
        today: "Today",
        tray: "the ask tray",
        strip: "the task chat",
        board: "the board",
        "confirm-view": "the confirmation view",
        tool: "this chat",
        cli: "the command line",
      } as Record<string, string>
    )[surface] ?? "bb"
  );
}
export const receiptKind = {
  assignment: "Work handed off",
  result: "Result sent",
  continue: "Follow-up",
  answer: "Answer sent",
};
export const receiptState = {
  pending: "Waiting to send",
  sending: "Sending",
  uncertain: "Delivery needs checking",
  accepted: "Delivered to bb",
  failed: "Couldn't deliver",
};
export const closedAskCopy = {
  answered: "This ask was answered.",
  expired: "This ask expired.",
  withdrawn: "This ask was withdrawn.",
  superseded: "This ask was replaced.",
};
