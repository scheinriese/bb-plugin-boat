import { resultSchema } from "../../contract-team.ts";
/** Only a framed structured result is a result. Progress and private end text stay private. */
export function parseTeamResult(text: string) {
  const block = text.match(
    /(?:^|\n)=== RESULT ===\s*\n([\s\S]*?)\n=== END RESULT ===/,
  );
  if (!block) return null;
  const field = (name: string) =>
    block[1].match(new RegExp(`^${name}:\\s*(.*)$`, "m"))?.[1]?.trim() ?? "";
  const assignmentId = field("ASSIGNMENT");
  if (!/^a_[a-z0-9]+$/.test(assignmentId)) return null;
  const result = resultSchema.safeParse({
    status: field("STATUS"),
    summary: field("SUMMARY"),
    delivered: field("DELIVERED"),
    evidence: field("EVIDENCE"),
    files:
      field("FILES") === "none"
        ? []
        : field("FILES")
            .split(/\s*,\s*/)
            .filter(Boolean),
    openQuestions: field("OPEN QUESTIONS"),
  });
  return result.success ? { assignmentId, result: result.data } : null;
}
