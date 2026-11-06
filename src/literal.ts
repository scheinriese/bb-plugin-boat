// Repository text (file names, commit subjects, git output) shown as literal
// text in Markdown: in the [boat] notice, tool results, the CLI and the task
// page. Control characters and line breaks go, long names are clipped, and
// code spans and fences are longer than any backtick run inside, so the text
// can't turn into links, headings or HTML, or end the block it sits in.

/** Terminal colour and cursor sequences. */
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
/** C0 and C1 controls (tab and line feed are handled apart), DEL, and bidi and line-separator format characters. */
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;
/** Backtick runs longer than this are shortened in code spans, so a span stays short whatever the name holds. */
const MAX_TICKS = 3;

/** At most `max` characters (code points), ending in … when clipped. */
export function clipChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join("")}…` : text;
}

/** One line of repository text: no control characters or line breaks, at most `max` characters. */
export function plainLine(text: string, max: number): string {
  return clipChars(text.replace(ANSI, "").replace(/[\t\n\r\u2028\u2029]+/g, " ").replace(CONTROLS, ""), max);
}

/** The longest run of backticks in `text` (0: none). */
function longestTicks(text: string): number {
  return Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
}

/**
 * Inline code that shows `text` literally (a file name, a commit subject):
 * one line, at most `max` characters, delimited by more backticks than any
 * run inside it.
 */
export function codeSpan(text: string, max = 120): string {
  const content = plainLine(text, max).replace(/`{4,}/g, "`".repeat(MAX_TICKS)) || " ";
  const ticks = "`".repeat(longestTicks(content) + 1);
  // CommonMark drops one space on each side; it keeps a backtick at an edge from joining the delimiter.
  const pad = /^[` ]|[` ]$/.test(content) && content.trim() !== "" ? " " : "";
  return `${ticks}${pad}${content}${pad}${ticks}`;
}

/** Lines of repository output (git range-diff): control characters go, tabs and line breaks stay. */
export function plainBlock(text: string): string {
  return text.replace(ANSI, "").replace(/\r\n?/g, "\n").replace(/[\u2028\u2029]/g, "\n").replace(CONTROLS, "");
}

/** A fenced code block that shows `text` literally: its fence is longer than any backtick run inside, so no line can close it. */
export function codeBlock(text: string, info = "text"): string {
  const body = plainBlock(text);
  const fence = "`".repeat(Math.max(3, longestTicks(body) + 1));
  return `${fence}${info}\n${body}\n${fence}`;
}
