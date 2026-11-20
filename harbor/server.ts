import type { BbPluginApi, PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import { request } from "node:http";

/** Use bb's CLI endpoint, including its keepalives and output/error limits.
 * The SDK's callRpc has a 75-second deadline; task wait can run for 30 minutes.
 * Node's HTTP client has no default request deadline and does not follow redirects.
 */
async function forward(baseUrl: string, argv: string[], ctx: PluginCliContext): Promise<PluginCliResult> {
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const req = request(new URL("/api/v1/plugins/boat/cli", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctx.signal,
    }, resolve);
    req.on("error", reject);
    req.end(JSON.stringify({ argv, cwd: ctx.cwd, threadId: ctx.threadId, projectId: ctx.projectId }));
  });
  response.setEncoding("utf8");
  const chunks: string[] = [];
  for await (const chunk of response) chunks.push(chunk);
  if (response.statusCode !== 200) throw new Error(`CLI endpoint returned HTTP ${response.statusCode}`);
  const result: unknown = JSON.parse(chunks.join(""));
  if (
    result === null || typeof result !== "object" ||
    !("exitCode" in result) || !Number.isInteger(result.exitCode) ||
    !("stdout" in result) || typeof result.stdout !== "string" ||
    !("stderr" in result) || typeof result.stderr !== "string"
  ) throw new Error("Invalid CLI response");
  return { exitCode: result.exitCode as number, stdout: result.stdout, stderr: result.stderr };
}

/** Only CLI display text changes namespace; command output and JSON are data. */
function display(argv: string[], result: PluginCliResult): PluginCliResult {
  const terminator = argv.indexOf("--");
  const scanned = terminator === -1 ? argv : argv.slice(0, terminator);
  const help = argv[0] === "help" || scanned.some(arg => arg === "--help" || arg === "-h") ||
    argv.length === 0 || argv[0]?.startsWith("-");
  const cliProse = (text: string) => text.replace(/(^[ \t]*|[`(])bb boat(?=\s|`|$)/gm, "$1bb harbor");
  const helpText = (text: string) => help && /^bb boat(?:[ \w-]*) — /.test(text) ? cliProse(text) : text;
  let stderr = helpText(result.stderr ?? "");
  if (result.exitCode !== 0 && terminator === -1) {
    // Parser usage/list blocks and formatted hints, never quoted error values.
    stderr = stderr.replace(/(^|\n\n)((?:Usage|Commands):\n)((?: {2}bb boat[^\n]*\n?)+)/g,
      (_match, before: string, heading: string, commands: string) => before + heading + cliProse(commands));
    stderr = stderr.replace(/(\((?:Or run|Run) `)bb boat(?=\s|`)/g, "$1bb harbor");
  }
  return { ...result, stdout: helpText(result.stdout ?? ""), stderr };
}

export default function harbor(bb: BbPluginApi): void {
  bb.cli.register({
    name: "harbor",
    summary: "Harbormaster: the bb boat command under its new name; run bb harbor --help",
    // All help, parsing and execution belong to boat, using its existing runtime.
    rendersHelp: true,
    async run(argv, ctx) {
      try {
        return display(argv, await forward(bb.server.loopbackBaseUrl, argv, ctx));
      } catch {
        const cancelled = ctx.signal?.aborted === true;
        const message = cancelled ? "Cancelled." : "Could not reach the Harbormaster CLI. Check that the boat plugin is installed and enabled.";
        return {
          exitCode: 1,
          stdout: argv.includes("--json") ? `${JSON.stringify({ ok: false, error: { code: cancelled ? "cancelled" : "harbor_unavailable", message } })}\n` : "",
          stderr: `${message}\n`,
        };
      }
    },
  });
}
