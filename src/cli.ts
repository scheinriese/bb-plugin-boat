import { compactTitleSchema, decisionOptionInputSchema } from "../contract-fidelity.ts";
// `bb boat …` — the agent- and human-facing command line.
import { PluginCliError, cliCommand, defineCli, type PluginCliContext } from "@get-bb/plugin-sdk";
import { MACHINE_TYPES, autoStopHours, dashboardUrl, type MachineType } from "./boat-api.ts";
import { BoatError } from "./boat.ts";
import { describeClose } from "./close-outcome.ts";
import {
  agentLine,
  decisionLines,
  limitsLine,
  taskNote,
  overviewLink,
  sandboxLine,
  taskDetail,
  taskTable,
  tasksAtOnceLine,
  queuedStartMarker,
} from "./format.ts";
import { ConfigError, applyImport, changeCount, exportConfig, planImport, summarize, summaryText } from "./config.ts";
import { listLocalProjects } from "./local-projects.ts";
import { alwaysProtectedBranches, protectedBranches, toOrchestratorProject, type BoatProject } from "./projects.ts";
import { parseProjectRef, type Runtime } from "./runtime.ts";
import { TaskError, type ProjectAccess } from "./service.ts";
import { renderSharedProtocol } from "./protocol.ts";
import { OPEN_STATUSES, PROVIDERS, TASK_ROLES, TASK_STATUSES, type Provider, type Task, type TaskStatus } from "./store.ts";
import { EFFORTS, TIERS, type Tier } from "./tiers.ts";
import { quotaLine } from "./quota.ts";
import { AGENT_NAME, effectiveRelay, onlyAgent, otherAgent, relayNote } from "./relay.ts";
import { SIZE_SPECS } from "./memory.ts";
import { resizeText } from "./sandbox-size.ts";
import { doctorText, explainBoatError, testTaskInput, type SetupStatus } from "./setup.ts";
import { ALL_SETTINGS, ORCHESTRATOR_EFFORTS, parseSettingText, type SettingKey } from "./settings.ts";
import { choiceSummary } from "./orchestrator-agent.ts";
import { SettingsError, settingRows, settingsText, type SettingRow } from "./settings-store.ts";

const json = { type: "boolean", description: "Print machine-readable JSON" } as const;
const agent = {
  type: "enum",
  values: PROVIDERS,
  aliases: ["provider", "harness"],
  description: "Agent: claude (Claude Code) or codex (OpenAI Codex)",
} as const;
const model = {
  type: "string",
  description: "Model id override (default: the model preset's model for the agent)",
} as const;
const tier = {
  type: "enum",
  values: TIERS,
  description: "Model preset: light, review, build (implement default), deep, frontier. Picks model and effort per agent",
} as const;
const reason = { type: "string", description: "One line: why this model preset (logged on the task)" } as const;
const effort = {
  type: "enum",
  values: EFFORTS,
  aliases: ["reasoning-effort"],
  description: "Effort override within the model preset (low, medium, high, xhigh, max)",
} as const;
const userApproved = {
  type: "boolean",
  description: "The user approved Frontier at max effort, or an XLarge sandbox (refused otherwise)",
} as const;

function out(value: unknown, asJson: boolean, text: () => string) {
  return { exitCode: 0, stdout: `${asJson ? JSON.stringify(value, null, 2) : text()}\n` };
}

/** Turn service/boat failures into CLI errors with codes and hints. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    if (error instanceof TaskError) throw new PluginCliError(error.message, { code: error.code, hint: error.hint });
    if (error instanceof BoatError) {
      const explained = explainBoatError(error);
      throw new PluginCliError(explained.message, { code: explained.code, ...(explained.hint ? { hint: explained.hint } : {}) });
    }
    throw error;
  }
}

async function textArg(
  runtime: Runtime,
  ctx: PluginCliContext,
  inline: string | undefined,
  file: string | undefined,
  label: string,
): Promise<string | undefined> {
  if (inline !== undefined && inline.trim() !== "") return inline;
  if (file !== undefined && file.trim() !== "") {
    try {
      return await runtime.readInvokerFile(ctx, file);
    } catch (error) {
      throw new PluginCliError(`Could not read ${label} file ${file}: ${error instanceof Error ? error.message : String(error)}`, {
        code: "file_unreadable",
      });
    }
  }
  return undefined;
}

function requireThread(ctx: PluginCliContext, explicit: string | undefined, flag = "--thread"): string {
  const threadId = explicit?.trim() || ctx.threadId;
  if (!threadId) {
    throw new PluginCliError("No thread given.", {
      code: "missing_thread",
      hint: `Run this inside a bb thread, or pass ${flag} <thread-id>.`,
    });
  }
  return threadId;
}

/** Save settings; refusals name every problem. */
async function saveSettings(runtime: Runtime, values: Record<string, string | number | boolean | null>): Promise<void> {
  try {
    await runtime.settings.set(values);
  } catch (error) {
    if (error instanceof SettingsError) throw new PluginCliError(error.problems.join("\n"), { code: "invalid_setting" });
    throw error;
  }
  runtime.changed();
}

/** One setting as a row (after a change). */
async function settingRow(runtime: Runtime, key: SettingKey): Promise<SettingRow> {
  const settings = await runtime.service.settings();
  return settingRows(await runtime.settings.get(), { onlyAgent: onlyAgent(settings.agents), declaredInPlugin: runtime.settings.declaredInPlugin }).find((row) => row.key === key)!;
}

/** The setup checklist (runtime.setup; absent only in tests that build a bare runtime). */
async function setupStatus(runtime: Runtime, force: boolean): Promise<SetupStatus> {
  if (runtime.setup === null) throw new PluginCliError("Setup checks aren't available here.", { code: "setup_unavailable" });
  return runtime.setup.status({ force });
}

function launchMessage(task: Task, pending: boolean): string {
  const lines = [
    pending
      ? `Task ${task.id} is starting (sandbox setup is still running). You will be notified if dispatch fails.`
      : `Task ${task.id} dispatched: ${task.role} with ${agentLine(task)}${task.reason ? ` — ${task.reason}` : ""}${task.runner === "chat" && task.threadId ? `, as the task chat @thread:${task.threadId}` : ""}.`,
    task.sandboxId ? `Sandbox: ${task.sandboxId}  ${dashboardUrl(task.sandboxId)}` : null,
    task.branch ? `Branch: ${task.branch}` : null,
    task.orchestratorThreadId
      ? "This thread gets a [boat] message when the turn finishes. End your turn instead of polling."
      : "No thread will be notified; check with `bb boat task show " + task.id + "`.",
  ];
  return lines.filter(Boolean).join("\n");
}

export function buildCli(runtime: Runtime) {
  const { service } = runtime;

  return defineCli({
    name: "boat",
    summary: "Run coding agents in boat.dev cloud sandboxes and orchestrate them from bb",
    description:
      "Tasks are coding agents (Claude Code or Codex) in boat.dev sandboxes: headless in boat by default, or task chats you can open in bb. The chat that started a task is told when a turn finishes. New here? Run `bb boat doctor`, then `bb boat task start --test`. See the boat and boat-orchestrator skills.",
    commands: {
      doctor: cliCommand({
        summary: "Check the setup: boat CLI, sign-in, plan, agent logins, environment, boat login in sandboxes, GitHub, bb Connect",
        description:
          "Read-only: never starts a sandbox. Exits 1 when something required is missing; each problem comes with its fix. Run it when a command fails with setup_required.",
        options: { json },
        async run({ options }) {
          return guard(async () => {
            const status = await setupStatus(runtime, true);
            return {
              exitCode: status.ok ? 0 : 1,
              stdout: `${options.json ? JSON.stringify({ ok: status.ok, checks: status.checks }, null, 2) : doctorText(status)}\n`,
            };
          });
        },
      }),
      status: cliCommand({
        summary: "Show the setup, boat plan limits, sandbox usage, and open tasks",
        options: { json },
        async run({ options }, ctx) {
          return guard(async () => {
            let setup = await setupStatus(runtime, false).catch(() => null);
            // Signed out or no CLI: the setup line says what to do; the rest waits for it.
            let capacity: Awaited<ReturnType<typeof service.capacity>> | null = null;
            let boatProblem: string | null = null;
            try {
              capacity = await service.capacity(ctx.signal);
            } catch (error) {
              if (!(error instanceof BoatError) || setup === null) throw error;
              boatProblem = explainBoatError(error).message;
              // boat just failed: the cached checks may be out of date.
              setup = await setupStatus(runtime, true).catch(() => setup);
            }
            const open = service.store.list({ statuses: OPEN_STATUSES });
            const orchestrator = ctx.threadId ? await runtime.isOrchestrator(ctx.threadId).catch(() => false) : false;
            const project = await runtime.projectForThread(ctx.threadId);
            const tasksBeforeAsking = (await service.settings()).tasksBeforeAsking;
            // Per project: can boat's GitHub login reach its repos, and which secrets its environment has.
            const projects = project ? [project] : runtime.projects.list().map((entry) => toOrchestratorProject(entry));
            const access = await Promise.all(projects.map(async (entry) => ({ project: entry, access: await service.projectAccess(entry, ctx.signal) })));
            const value = {
              setup: setup === null ? null : { ok: setup.ok, summary: setup.summary, checks: setup.checks },
              project,
              limits: capacity?.limits ?? null,
              activeSandboxes: capacity?.active.length ?? 0,
              cap: capacity?.cap ?? null,
              freeSlots: capacity?.free ?? null,
              tasksBeforeAsking,
              openTasks: open,
              thisThreadIsOrchestrator: orchestrator,
              access: access.map(({ project: entry, access: result }) => ({ project: entry.id, ...result })),
            };
            return out(value, options.json, () =>
              [
                setup?.summary ?? null,
                capacity ? `boat: ${limitsLine(capacity.limits, capacity.active.length, capacity.cap)}` : `boat: ${boatProblem ?? "not reachable"}`,
                capacity?.limits?.summary ? `plan: ${capacity.limits.summary}` : null,
                tasksAtOnceLine(tasksBeforeAsking),
                ctx.threadId ? `this thread: ${orchestrator ? "orchestrator" : "not an orchestrator"}` : null,
                project ? `project: ${project.name} (${project.repos.map((r) => `${r.repo}@${r.baseBranch}`).join(", ")}; environment ${project.environment ?? "default"})` : null,
                // Headings only with something under them.
                ...(access.length > 0 ? ["", "Access:", ...access.flatMap(({ project: entry, access: result }) => accessLines(entry.name, result))] : []),
                "",
                `Open tasks (${open.length}):`,
                taskTable(open, (task) => taskNote(task, service.store.latestEvent(task.id, "review")?.text ?? null)),
              ]
                .filter((line) => line !== null)
                .join("\n"),
            );
          });
        },
      }),

      // ---------------------------------------------------------------- sandboxes
      "sandbox list": cliCommand({
        summary: "List boat sandboxes (running by default)",
        options: { all: { type: "boolean", description: "Include stopped and failed sandboxes" }, json },
        async run({ options }, ctx) {
          return guard(async () => {
            const sandboxes = await service.boat.list({ all: options.all, signal: ctx.signal });
            return out(sandboxes, options.json, () =>
              sandboxes.length === 0
                ? "No sandboxes."
                : sandboxes
                    .map((sandbox) =>
                      sandboxLine(
                        sandbox,
                        service.store.liveSandboxTasks(sandbox.id).map((task) => task.id),
                      ),
                    )
                    .join("\n"),
            );
          });
        },
      }),
      "sandbox new": cliCommand({
        summary: "Create a sandbox, optionally with a repository checked out",
        options: {
          name: { type: "string", description: "Sandbox name (up to 120 characters)" },
          type: { type: "enum", values: MACHINE_TYPES, description: "Machine size (trial: small or default)" },
          repo: { type: "string", description: "GitHub repository to clone into ~/work (owner/name or URL)" },
          branch: { type: "string", description: "Branch to check out or create" },
          base: { type: "string", description: "Base branch for a new branch (default: the repo default)" },
          json,
        },
        async run({ options }, ctx) {
          return guard(async () => {
            const { normalizeRepo, assertBranch } = await import("./boat-api.ts");
            if ((options.branch || options.base) && !options.repo) {
              throw new PluginCliError("--branch and --base need --repo.", { code: "invalid_value" });
            }
            // Validate before spending a boat start on a sandbox.
            const repo = options.repo ? normalizeRepo(options.repo) : null;
            const branch = options.branch ? assertBranch(options.branch) : null;
            const base = options.base ? assertBranch(options.base, "base branch") : null;
            const sandbox = await service.createSandbox({
              name: options.name ?? `bb sandbox ${new Date().toISOString().slice(0, 16)}`,
              type: (options.type as MachineType | undefined) ?? null,
              signal: ctx.signal,
            });
            let checkout: { path: string; branch: string | null } | null = null;
            if (repo !== null) {
              const always = alwaysProtectedBranches((await service.settings()).extraProtectedBranches);
              try {
                checkout = await service.boat.prepareRepo(
                  sandbox.id,
                  repo,
                  branch ? { kind: "new-branch", branch, base } : { kind: "default-branch", base },
                  { signal: ctx.signal, protect: protectedBranches(null, [base, ...service.projectBaseBranches([repo])], always), alwaysProtect: always },
                );
              } catch (error) {
                await service.boat.delete(sandbox.id).catch(() => undefined);
                throw error;
              }
            }
            runtime.changed();
            return out({ sandbox, checkout }, options.json, () =>
              [
                `Created sandbox ${sandbox.id} (${sandbox.state}).`,
                checkout ? `Checked out ${checkout.branch ?? "default branch"} at ${checkout.path}` : null,
                `Shell:     boat ssh ${sandbox.id}`,
                `Dashboard: ${dashboardUrl(sandbox.id)}`,
                `Run an agent in it: bb boat task start --sandbox ${sandbox.id} --title "…" --brief "…"`,
              ]
                .filter(Boolean)
                .join("\n"),
            );
          });
        },
      }),
      "sandbox info": cliCommand({
        summary: "Show one sandbox and the tasks using it",
        positionals: [{ name: "id", description: "Sandbox id (bx_…)", required: true }],
        options: { json },
        async run({ positionals, options }, ctx) {
          return guard(async () => {
            const sandbox = await service.boat.info(positionals.id, ctx.signal);
            const tasks = service.store.list({ limit: 1000 }).filter((task) => task.sandboxId === sandbox.id);
            return out({ sandbox, tasks }, options.json, () =>
              [
                sandboxLine(sandbox),
                sandbox.url ? `URL: ${sandbox.url}` : null,
                sandbox.archiveAfter ? `Auto-stops at ${sandbox.archiveAfter}` : null,
                `Shell: boat ssh ${sandbox.id}`,
                "",
                taskTable(tasks, (task) => taskNote(task, service.store.latestEvent(task.id, "review")?.text ?? null)),
              ]
                .filter((line) => line !== null)
                .join("\n"),
            );
          });
        },
      }),
      "sandbox stop": cliCommand({
        summary: "Stop a sandbox (disk and agent conversations are kept; resumes on follow-up)",
        positionals: [{ name: "id", description: "Sandbox id", required: true }],
        options: { json },
        async run({ positionals, options }, ctx) {
          return guard(async () => {
            await service.sandboxAction(positionals.id, "stop", 0, ctx.signal);
            runtime.changed();
            return out({ ok: true }, options.json, () => `Stopping ${positionals.id}.`);
          });
        },
      }),
      "sandbox resume": cliCommand({
        summary: "Resume a stopped sandbox (counts as a boat start)",
        positionals: [{ name: "id", description: "Sandbox id", required: true }],
        options: { json },
        async run({ positionals, options }, ctx) {
          return guard(async () => {
            const settings = await service.settings();
            const { limits } = await service.capacity(ctx.signal);
            const ttl = Math.round(autoStopHours(settings.sandboxTtlHours, limits?.autoStopCapHours ?? null) * 3600);
            await service.sandboxAction(positionals.id, "resume", ttl, ctx.signal);
            runtime.changed();
            return out({ ok: true }, options.json, () => `Resumed ${positionals.id}.`);
          });
        },
      }),
      "sandbox resize": cliCommand({
        summary: "Move a task's sandbox to another size (it stops and starts again: files stay, running processes stop)",
        description:
          "Every open task on the sandbox moves with it, and its previews stop (Wake starts them again). It uses one boat start. boat refuses to shrink a sandbox whose data doesn't fit. To move and continue in one step, use `bb boat task followup <id> --type <size> --message …`.",
        positionals: [{ name: "id", description: "Sandbox id (bx_…)", required: true }],
        options: {
          type: { type: "enum", values: MACHINE_TYPES, required: true, description: "small, default, large or xlarge (xlarge needs --user-approved)" },
          "user-approved": { type: "boolean", description: "The user approved this move (XLarge always needs it; from an agent's chat, any move without an out-of-memory failure)" },
          json,
        },
        async run({ positionals, options }, ctx) {
          return guard(async () => {
            const open = service.store.liveSandboxTasks(positionals.id);
            if (open.length === 0) {
              throw new PluginCliError(`No open task uses sandbox ${positionals.id}.`, {
                code: "invalid_value",
                hint: `Resize it with boat: \`boat stop ${positionals.id}\`, then \`boat resume ${positionals.id} --type <size>\`.`,
              });
            }
            const result = await service.sizes.resize({
              taskId: open[0]!.id,
              type: options.type as MachineType,
              message: null,
              userApproved: options["user-approved"] === true,
              notifyThreadId: ctx.threadId ?? null,
              waitMs: runtime.launchWaitMs,
              // From an agent's chat: the same limits as boat_followup's sandbox_size.
              by: ctx.threadId ? "tool" : "cli",
            });
            runtime.changed();
            const label = SIZE_SPECS[result.to].label;
            return out({ sandboxId: positionals.id, pending: result.pending, from: result.from, to: result.to, moved: result.moved }, options.json, () =>
              result.pending
                ? `Moving sandbox ${positionals.id} to ${label} (a few minutes). Check with \`bb boat task show ${result.task.id}\`.`
                : `Moved sandbox ${positionals.id} to ${label} (${SIZE_SPECS[result.to].cpus} vCPU, ${SIZE_SPECS[result.to].memoryGb} GB). Tasks on it: ${result.moved.join(", ")}.`,
            );
          });
        },
      }),
      "sandbox delete": cliCommand({
        summary: "Delete a sandbox and all of its data",
        positionals: [{ name: "id", description: "Sandbox id", required: true }],
        options: {
          force: { type: "boolean", description: "Delete even if open tasks still use it (they are cancelled); only when the user asked" },
          discard: { type: "boolean", description: "Also when it holds work that hasn't shipped; only when the user said to throw it away" },
          json,
        },
        async run({ positionals, options }, ctx) {
          return guard(async () => {
            const live = service.store.liveSandboxTasks(positionals.id);
            if (live.length > 0 && !options.force) {
              throw new PluginCliError(`Open tasks use ${positionals.id}: ${live.map((task) => task.id).join(", ")}.`, {
                code: "sandbox_in_use",
                hint: "Close them with `bb boat task close <id>` first.",
              });
            }
            const unshipped = await service.unshippedTasks(positionals.id, ctx.signal);
            if (unshipped.length > 0) {
              const check = options.discard ? await runtime.chatApproval(ctx.threadId, unshipped[0]!, "discard") : { ok: false, reason: "" };
              if (!check.ok) {
                throw new PluginCliError(`${positionals.id} holds work that hasn't shipped (${unshipped.map((task) => task.id).join(", ")}).`, {
                  code: "unshipped_work",
                  hint: "Ship it after the user approves, or delete the sandbox only when the user says to throw the work away (they can also delete it on the overview).",
                });
              }
            }
            await service.sandboxAction(positionals.id, "delete", 0, ctx.signal);
            for (const task of live) {
              service.store.update(task.id, { status: "cancelled", finishedAt: new Date().toISOString() });
              service.store.addEvent(task.id, "cancelled", `Sandbox ${positionals.id} deleted`);
            }
            runtime.changed();
            return out({ ok: true }, options.json, () => `Deleted ${positionals.id}.`);
          });
        },
      }),
      "sandbox snapshot": cliCommand({
        summary: "Save a sandbox's state under a name; projects and --snapshot start new sandboxes from it",
        positionals: [
          { name: "id", description: "Sandbox id", required: true },
          { name: "name", description: "Snapshot name (reusing a name replaces it)", required: true },
        ],
        options: { json },
        async run({ positionals, options }, ctx) {
          return guard(async () => {
            const saved = await service.saveSnapshot(positionals.id, positionals.name, ctx.signal);
            return out(saved, options.json, () => `Saved ${saved.name}${saved.sizeBytes ? ` (${Math.round(saved.sizeBytes / 1e6)} MB)` : ""}. Start from it with --snapshot ${saved.name}, or set it on a project.`);
          });
        },
      }),
      "sandbox snapshots": cliCommand({
        summary: "Saved snapshots you can start sandboxes from",
        options: { json },
        async run({ options }, ctx) {
          return guard(async () => {
            const result = await service.snapshots(ctx.signal);
            return out(result, options.json, () =>
              [
                ...(result.snapshots.length === 0
                  ? ["No saved snapshots. Save one with `bb boat sandbox snapshot <sandbox id> <name>`."]
                  : result.snapshots.map((entry) => `${entry.name}  ${entry.type ?? ""}  ${entry.sizeBytes ? `${Math.round(entry.sizeBytes / 1e6)} MB` : ""}  ${entry.createdAt?.slice(0, 10) ?? ""}`.replace(/\s+$/, ""))),
                result.included !== null ? `${result.used ?? 0} of ${result.included} included snapshots used.` : "",
              ]
                .filter(Boolean)
                .join("\n"),
            );
          });
        },
      }),
      "sandbox exec": cliCommand({
        summary: "Run a shell command in a sandbox (bb boat sandbox exec <id> -- <command>)",
        positionals: [{ name: "id", description: "Sandbox id", required: true }],
        passthrough: true,
        options: {
          timeout: { type: "duration", defaultUnit: "s", min: 1000, max: 600_000, default: 120_000, description: "Time limit (max 10m)" },
          json,
        },
        async run({ positionals, options, passthrough }, ctx) {
          return guard(async () => {
            if (passthrough.length === 0) {
              throw new PluginCliError("No command given.", { code: "missing_command", hint: "Put the command after --." });
            }
            // One token is a script as typed; several are argv, quoted so bash keeps them intact.
            const command =
              passthrough.length === 1
                ? passthrough[0]!
                : passthrough.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(" ");
            const result = await service.boat.exec(positionals.id, command, {
              timeoutMs: options.timeout,
              signal: ctx.signal,
            });
            if (options.json) return out(result, true, () => "");
            return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
          });
        },
      }),

      // ---------------------------------------------------------------- tasks
      "task start": cliCommand({
        summary: "Start a coding agent on a task in a boat sandbox",
        description:
          "Creates (or reuses) a sandbox, checks out the repository, and sends the brief to the agent. Returns in under ~90 s; the invoking thread is messaged when the agent's turn finishes. `--test` starts a small task with no repo that only reports the sandbox's tools: it proves sign-in, plan and agent login (one sandbox start, a minute or two of a small sandbox).",
        options: {
          title: { type: "string", description: "Short task title (required unless --test)" },
          "compact-title": { type: "string", description: "Authored short subject for mobile task chips (at most 120 characters)" },
          test: { type: "boolean", description: "Start the test task: no repo, changes nothing, reports uname, node, git and GitHub access" },
          brief: { type: "string", description: "Self-contained task brief (goal, context, acceptance criteria)" },
          "brief-file": { type: "string", description: "Read the brief from this file (on the invoking machine)" },
          role: { type: "enum", values: TASK_ROLES, default: "implement", description: "implement (branch + PR), review, or custom" },
          project: {
            type: "string",
            description: "Project id (default: this orchestrator's project). Sets repo, base branch and environment defaults",
          },
          repo: { type: "string", description: "GitHub repository (owner/name or URL); default: the project's main repo" },
          branch: { type: "string", description: "Working branch (default: boat/<id>-<title>); never a base branch" },
          base: { type: "string", description: "Base branch (default: the project's, else the repository default)" },
          pr: { type: "string", description: "Pull request number or URL to check out (reviews)" },
          environment: { type: "string", description: "boat environment for a new sandbox (default: the project's)" },
          snapshot: { type: "string", description: "Saved snapshot to start the sandbox from (default: the project's; \"none\" for a fresh one)" },
          tier,
          reason,
          agent,
          effort,
          model,
          "user-approved": userApproved,
          sandbox: { type: "string", description: "new (default), or an existing sandbox id to run in" },
          type: { type: "enum", values: MACHINE_TYPES, description: "Machine size for a new sandbox (default: the project's, else the Default sandbox size setting); xlarge needs --user-approved" },
          chat: {
            type: "boolean",
            description:
              "Run as a task chat the user can open and type into (needs bb Connect). Only for repos in a project with Run tasks as chats on, or any repo with How tasks run set to As chats everywhere",
          },
          headless: { type: "boolean", description: "Run headless in boat, whatever How tasks run says" },
          "measure-memory": {
            type: "boolean",
            description: "Measure the first turn's peak memory and recommend a sandbox size (what Check this repo runs in a sandbox does)",
          },
          "context-from": {
            type: "string",
            repeatable: true,
            split: ",",
            description: "Include other tasks' briefs, branches, PRs and reports (task ids)",
          },
          "notify-thread": { type: "string", description: "Thread to notify instead of the invoking thread" },
          "no-notify": { type: "boolean", description: "Do not message any thread when the turn finishes" },
          json,
        },
        constraints: [
          { kind: "at-most-one", options: ["brief", "brief-file"] },
          { kind: "at-most-one", options: ["notify-thread", "no-notify"] },
          { kind: "at-most-one", options: ["chat", "headless"] },
        ],
        async run({ options }, ctx) {
          return guard(async () => {
            const notify = options["no-notify"] ? null : (options["notify-thread"] ?? ctx.threadId ?? null);
            if (options.test) {
              const others = [
                ...(["title", "compact-title", "brief", "brief-file", "repo", "branch", "base", "pr", "project", "sandbox", "context-from"] as const).filter((key) => {
                  const value = options[key];
                  return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== "";
                }),
                // The test task always runs headless.
                ...(options.chat === true ? (["chat"] as const) : []),
              ];
              if (others.length > 0) {
                throw new PluginCliError(`--test starts a fixed test task; drop ${others.map((key) => `--${key}`).join(", ")}.`, { code: "invalid_value" });
              }
              const { task, pending } = await service.launchTask(
                { ...testTaskInput(notify), provider: (options.agent as Provider | undefined) ?? null, signal: ctx.signal },
                runtime.launchWaitMs,
              );
              runtime.wake();
              return out({ task, pending }, options.json, () => launchMessage(task, pending));
            }
            if (!options.title?.trim()) throw new PluginCliError("A task needs --title.", { code: "invalid_value", hint: "Or run `bb boat task start --test` to check the setup." });
            if (options.brief === undefined && options["brief-file"] === undefined) {
              throw new PluginCliError("A task needs --brief or --brief-file.", { code: "invalid_value", hint: "Or run `bb boat task start --test` to check the setup." });
            }
            const brief = await textArg(runtime, ctx, options.brief, options["brief-file"], "brief");
            const context = service.contextBlock(options["context-from"]);
            const project = options.project
              ? await runtime.resolveProject(parseProjectRef(options.project))
              : await runtime.projectForThread(ctx.threadId);
            const result = await runtime.launchTask(
              {
                title: options.title,
                compactTitle: options["compact-title"] ? compactTitleSchema.parse(options["compact-title"]) : null,
                role: options.role,
                brief: `${brief ?? ""}${context}`,
                project,
                environment: options.environment ?? null,
                snapshot: options.snapshot ?? null,
                repo: options.repo ?? null,
                branch: options.branch ?? null,
                baseBranch: options.base ?? null,
                pr: options.pr ?? null,
                provider: (options.agent as Provider | undefined) ?? null,
                model: options.model ?? null,
                tier: (options.tier as Tier | undefined) ?? null,
                reason: options.reason ?? null,
                reasoningEffort: options.effort ?? null,
                userApproved: options["user-approved"] === true,
                sandbox: options.sandbox ?? null,
                machineType: (options.type as MachineType | undefined) ?? null,
                orchestratorThreadId: notify,
                projectId: ctx.projectId ?? null,
                // Never a confirm: a repo the rules don't trust needs the user (the page, or a project).
                runner: options.chat ? "chat" : options.headless ? "boat" : null,
                measureMemory: options["measure-memory"] === true,
                signal: ctx.signal,
              },
              runtime.launchWaitMs,
            );
            runtime.wake();
            return result.kind === "queued"
              ? out({ queued: result.request, pending: true }, options.json, () => `Request ${result.request.id}: waiting for a usage reset. No sandbox has been created. It will retry automatically when an agent has room.\n${queuedStartMarker(result.request.id)}`)
              : out({ task: result.task, pending: result.pending }, options.json, () => launchMessage(result.task, result.pending));
          });
        },
      }),
      "task review": cliCommand({
        summary: "Start an independent review of an implementation task (the other model by default, when both agents are set up)",
        positionals: [{ name: "id", description: "Implementation task id", required: true }],
        options: {
          brief: { type: "string", description: "What to focus on (default: correctness, regressions, tests, scope)" },
          "brief-file": { type: "string", description: "Read the review brief from this file" },
          tier: { ...tier, description: "Model preset (default: review)" },
          reason,
          agent,
          effort,
          model,
          "user-approved": userApproved,
          sandbox: { type: "string", description: "auto (default), new, same (the reviewed task's sandbox), or a sandbox id" },
          json,
        },
        constraints: [{ kind: "at-most-one", options: ["brief", "brief-file"] }],
        async run({ positionals, options }, ctx) {
          return guard(async () => {
            const brief = await textArg(runtime, ctx, options.brief, options["brief-file"], "brief");
            const input = await service.reviewInput(positionals.id, {
              brief: brief ?? null,
              provider: (options.agent as Provider | undefined) ?? null,
              model: options.model ?? null,
              tier: (options.tier as Tier | undefined) ?? null,
              effort: options.effort ?? null,
              reason: options.reason ?? null,
              userApproved: options["user-approved"] === true,
              sandbox: options.sandbox ?? null,
              orchestratorThreadId: ctx.threadId ?? null,
              projectId: ctx.projectId ?? null,
              signal: ctx.signal,
            });
            const { task, pending } = await service.launchTask(input, runtime.launchWaitMs);
            runtime.wake();
            return out({ task, pending }, options.json, () => launchMessage(task, pending));
          });
        },
      }),
      "task list": cliCommand({
        summary: "List tasks (open ones by default)",
        options: {
          all: { type: "boolean", description: "Include done and cancelled tasks" },
          status: { type: "enum", values: TASK_STATUSES, repeatable: true, split: ",", description: "Only these statuses" },
          mine: { type: "boolean", description: "Only tasks dispatched by this thread" },
          thread: { type: "string", description: "Only tasks dispatched by this thread id" },
          limit: { type: "integer", min: 1, max: 500, default: 50, description: "Maximum rows" },
          json,
        },
        async run({ options }, ctx) {
          return guard(async () => {
            const statuses: TaskStatus[] | undefined =
              options.status.length > 0 ? (options.status as TaskStatus[]) : options.all ? undefined : [...OPEN_STATUSES];
            const thread = options.thread ?? (options.mine ? requireThread(ctx, undefined) : undefined);
            const tasks = service.store.list({ statuses, orchestratorThreadId: thread, limit: options.limit });
            return out(tasks, options.json, () => taskTable(tasks, (task) => taskNote(task, service.store.latestEvent(task.id, "review")?.text ?? null)));
          });
        },
      }),
      "task show": cliCommand({
        summary: "Show a task: status, PR, the agent's last message, and history",
        positionals: [{ name: "id", description: "Task id (or unique prefix)", required: true }],
        options: {
          brief: { type: "boolean", description: "Include the original brief" },
          refresh: { type: "boolean", description: "Check boat for progress first" },
          json,
        },
        async run({ positionals, options }) {
          return guard(async () => {
            if (options.refresh) await service.sweep();
            const task = service.mustGet(positionals.id);
            const events = service.store.events(task.id);
            const evidence = service.evidenceLinks(task.id);
            const previews = await service.previews({ taskId: task.id, includeExpired: true });
            const memory = options.json ? await service.sizes.view(task) : null;
            return out({ task, events, evidence, previews: previews.map((view) => ({ ...view.preview, link: view.link, state: view.state })), memory }, options.json, () =>
              taskDetail(task, events, { brief: options.brief, evidence, previews, memory: service.sizes.lines(task) }),
            );
          });
        },
      }),
      "task transcript": cliCommand({
        summary: "Show the task's conversation so far (prompts, tool steps, replies)",
        positionals: [{ name: "id", description: "Task id", required: true }],
        options: {
          limit: { type: "integer", min: 1, max: 500, default: 60, description: "Most recent events to show" },
          json,
        },
        async run({ positionals, options }, ctx) {
          return guard(async () => {
            const task = service.mustGet(positionals.id);
            if (task.sandboxId === null || task.conversationId === null) {
              throw new PluginCliError(`Task ${task.id} has no conversation yet.`, { code: "task_not_dispatched" });
            }
            const events = (await service.boat.events(task.sandboxId, task.conversationId, ctx.signal)).slice(-options.limit);
            const moved =
              task.runner === "chat" && task.threadId !== null
                ? `Task ${task.id} now runs as the task chat @thread:${task.threadId}; below is its headless conversation from before the move.\n`
                : "";
            return out(events, options.json, () =>
              moved +
              events
                .map((event) => {
                  const time = event.timestamp ? new Date(event.timestamp).toISOString().slice(11, 19) : "--:--:--";
                  if (event.type === "prompt") return `${time}  ▶ prompt (${event.status ?? "?"})`;
                  if (event.tools.length > 0) return `${time}  ⚙ ${event.tools.join(", ")}`;
                  if (event.content) return `${time}  ◀ ${event.content.length > 600 ? `${event.content.slice(0, 600)}…` : event.content}`;
                  return `${time}  · ${event.type}`;
                })
                .join("\n") || "No events yet.",
            );
          });
        },
      }),
      "task followup": cliCommand({
        summary: "Send a follow-up to a task's agent (same conversation, same sandbox)",
        aliases: ["task tell", "task send"],
        positionals: [{ name: "id", description: "Task id", required: true }],
        options: {
          message: { type: "string", description: "What to do next (e.g. the review's blocking issues)" },
          "message-file": { type: "string", description: "Read the message from this file" },
          steer: { type: "boolean", description: "Redirect a running turn instead of waiting for it" },
          agent: { ...agent, description: "Switch the conversation to this agent (boat hands over the transcript); keeps the model preset" },
          tier: { ...tier, description: "Change the task's model preset for this and later turns" },
          reason,
          effort,
          model,
          "user-approved": userApproved,
          "evidence-only": {
            type: "boolean",
            description: "Only ask for screenshot/recording uploads (evidence-upload); keeps the review and ready state. The message is optional",
          },
          type: {
            type: "enum",
            values: MACHINE_TYPES,
            description:
              "Move the task's sandbox to this size first, e.g. large after it ran out of memory (it stops and starts again: files stay, running processes stop, other tasks on it move too; boat refuses to shrink one whose data doesn't fit); xlarge needs --user-approved",
          },
          json,
        },
        constraints: [
          { kind: "at-most-one", options: ["message", "message-file"] },
          // --evidence-only alone asks for the uploads in standard words.
          { kind: "at-least-one", options: ["message", "message-file", "evidence-only"] },
        ],
        async run({ positionals, options }, ctx) {
          return guard(async () => {
            const message =
              (await textArg(runtime, ctx, options.message, options["message-file"], "message")) ??
              (options["evidence-only"] ? "Upload the screenshots and screen recordings from your work on this task." : "");
            if (options.type !== undefined) {
              if (options.steer || options["evidence-only"]) {
                throw new PluginCliError(options.steer ? "A steer can't change the sandbox size." : "An evidence-only follow-up can't change the sandbox size.", {
                  code: "invalid_value",
                  hint: "Send it without --type, or wait for the turn to end and send a follow-up with --type.",
                });
              }
              const result = await service.sizes.resize({
                taskId: positionals.id,
                type: options.type as MachineType,
                message,
                followup: {
                  provider: (options.agent as Provider | undefined) ?? null,
                  model: options.model ?? null,
                  tier: (options.tier as Tier | undefined) ?? null,
                  effort: options.effort ?? null,
                  reason: options.reason ?? null,
                  userApproved: options["user-approved"] === true,
                },
                userApproved: options["user-approved"] === true,
                notifyThreadId: ctx.threadId ?? null,
                waitMs: runtime.launchWaitMs,
                // From an agent's chat: the same limits as boat_followup's sandbox_size.
                by: ctx.threadId ? "tool" : "cli",
              });
              runtime.wake();
              const now = service.store.get(result.task.id) ?? result.task;
              return out({ task: now, pending: result.pending, from: result.from, to: result.to, moved: result.moved, sent: result.sent }, options.json, () =>
                resizeText({ ...result, task: now }, "cli", agentLine(now)),
              );
            }
            const before = service.mustGet(positionals.id);
            const task = await service.followup(positionals.id, message, {
              steer: options.steer,
              provider: (options.agent as Provider | undefined) ?? null,
              model: options.model ?? null,
              tier: (options.tier as Tier | undefined) ?? null,
              effort: options.effort ?? null,
              reason: options.reason ?? null,
              userApproved: options["user-approved"] === true,
              evidenceOnly: options["evidence-only"] === true,
              signal: ctx.signal,
            });
            runtime.wake();
            return out(task, options.json, () =>
              options.steer && task.status === "running" && task.promptId === before.promptId
                ? `Steered the running turn of ${task.id}.`
                : `Follow-up sent to ${task.id} (${agentLine(task)}). You will be notified when the turn finishes.`,
            );
          });
        },
      }),
      "task continue-as-chat": cliCommand({
        summary: "Move a headless task into a task chat: bb on its sandbox, and a chat with the same agent in the same checkout that gets the conversation so far",
        description:
          "Needs bb Connect, a finished turn, and repos the rules trust (a project with Run tasks as chats on, or How tasks run set to As chats everywhere); for other repos the user decides, with Continue as a chat on the task's page. Takes about a minute; then follow-ups go into the chat, and its first turn sums up where the task stands.",
        positionals: [{ name: "id", description: "Task id", required: true }],
        options: { json },
        async run({ positionals, options }, ctx) {
          return guard(async () => {
            const { task, pending } = await service.continueAsChat(positionals.id, {
              // Never a confirm: an untrusted repo needs the user (the task's page, or a project).
              confirmUntrusted: null,
              via: "cli",
              waitMs: runtime.launchWaitMs,
              // Nobody waits any more: tell the chat that asked.
              onLateFailure: ctx.threadId
                ? (message) =>
                    void runtime
                      .tellOrchestrator(ctx.threadId!, `[boat] Task ${positionals.id} couldn't continue as a chat: ${message} It stays headless; \`bb boat task show ${positionals.id}\` has the details.`)
                      .catch(() => undefined)
                : undefined,
            });
            runtime.wake();
            return out({ task, pending }, options.json, () =>
              pending
                ? `Task ${task.id} is moving to a task chat (bb is being installed on its sandbox). \`bb boat task show ${task.id}\` says when it's open.`
                : `Task ${task.id} continues as the task chat @thread:${task.threadId}. Its headless conversation stopped; follow-ups go into the chat.`,
            );
          });
        },
      }),
      "task interrupt": cliCommand({
        summary: "Stop a task's running turn (the task stays open)",
        positionals: [{ name: "id", description: "Task id", required: true }],
        options: { json },
        async run({ positionals, options }, ctx) {
          return guard(async () => {
            const task = await service.interruptTask(positionals.id, ctx.signal);
            service.store.addEvent(task.id, "interrupted", "Interrupted from the CLI");
            runtime.wake();
            return out({ ok: true }, options.json, () => `Interrupted ${task.id}.`);
          });
        },
      }),
      "task close": cliCommand({
        summary: "Close a task (done, or --cancel) and delete its sandbox unless shared or kept",
        aliases: ["task done"],
        positionals: [{ name: "id", description: "Task id", required: true }],
        options: {
          cancel: { type: "boolean", description: "Mark cancelled instead of done (interrupts a running turn)" },
          "keep-sandbox": { type: "boolean", description: "Keep the sandbox" },
          discard: { type: "boolean", description: "Close work that hasn't shipped (projects that ship after approval); it's deleted with the sandbox" },
          json,
        },
        async run({ positionals, options }, ctx) {
          return guard(async () => {
            if (options.discard) {
              // Throwing work away needs the user's word in the orchestrator chat too.
              const check = await runtime.chatApproval(ctx.threadId, service.mustGet(positionals.id), "discard");
              if (!check.ok) {
                throw new PluginCliError(`Not discarded: ${check.reason}.`, {
                  code: "approval_required",
                  hint: "Discard only when the user tells you to in this chat; they can also close the task on the overview.",
                });
              }
            }
            const result = await service.closeTask(positionals.id, {
              status: options.cancel ? "cancelled" : "done",
              keepSandbox: options["keep-sandbox"] ? true : undefined,
              discard: options.discard === true,
              signal: ctx.signal,
            });
            const outcome = await describeClose(service, result, { asked: options["keep-sandbox"] === true });
            return out({ ...result, keptBecause: outcome.keptBecause }, options.json, () => outcome.text);
          });
        },
      }),
      "task ship": cliCommand({
        summary: "Ship a task's commits to its base branch (projects that ship after the user approves)",
        positionals: [{ name: "id", description: "Task id", required: true }],
        options: {
          "keep-open": { type: "boolean", description: "Keep the task and its sandbox open for more work" },
          json,
        },
        async run({ positionals, options }, ctx) {
          return guard(async () => {
            const task = service.mustGet(positionals.id);
            // Only from the task's orchestrator chat, after the user wrote there since the work was reported.
            const check = await runtime.chatApproval(ctx.threadId, task);
            if (!check.ok) {
              throw new PluginCliError(`Not shipped: ${check.reason}.`, {
                code: "approval_required",
                hint: "Ship only when the user tells you to in this chat, or ask them to click Ship on the overview.",
              });
            }
            const result = await service.shipTask(task.id, { keepOpen: options["keep-open"] === true, approval: "by the user in chat", signal: ctx.signal });
            runtime.changed();
            const outcome = await describeClose(service, result);
            return out({ ...result, keptBecause: outcome.keptBecause }, options.json, () =>
              [
                ...result.shipped.map((entry) => `Shipped ${entry.commits} commit${entry.commits === 1 ? "" : "s"} to ${entry.baseBranch} (${entry.sha.slice(0, 7)}).`),
                outcome.text,
              ].join("\n"),
            );
          });
        },
      }),
      "preview list": cliCommand({
        summary: "Previews of this chat's tasks (or a task's, or --all), with their state and link",
        options: {
          task: { type: "string", description: "Only this task's previews" },
          all: { type: "boolean", description: "Every orchestrator's" },
          json,
        },
        async run({ options }, ctx) {
          return guard(async () => {
            const views = await service.previews({
              ...(options.task ? { taskId: service.mustGet(options.task).id } : {}),
              orchestratorThreadId: options.all || options.task ? null : (ctx.threadId ?? null),
              includeExpired: true,
            });
            return out(
              views.map((view) => ({ ...view.preview, link: view.link, state: view.state, reason: view.reason, stopsAt: view.stopsAt })),
              options.json,
              () =>
                views.length === 0
                  ? "No previews."
                  : views
                      .map(
                        (view) =>
                          `${view.preview.id}  ${view.state}${view.reason ? ` (${view.reason})` : ""}  ${view.preview.taskId} "${view.preview.title}"  port ${view.preview.port}\n  ${view.link}`,
                      )
                      .join("\n"),
            );
          });
        },
      }),
      "preview wake": cliCommand({
        summary: "Bring a preview back: resume its sandbox, restart the server, and check the link",
        positionals: [{ name: "id", description: "Preview id (p_…)", required: true }],
        options: { json },
        async run({ positionals, options }, ctx) {
          return guard(async () => {
            const view = await service.wakePreview(positionals.id, ctx.signal);
            runtime.changed();
            return out({ ...view.preview, link: view.link, state: view.state }, options.json, () => `${view.state === "live" ? "Live" : `Not answering yet (${view.reason ?? view.state})`}: ${view.link}`);
          });
        },
      }),
      "preview extend": cliCommand({
        summary: "Keep a preview's sandbox on longer (within your plan's auto-stop cap)",
        positionals: [{ name: "id", description: "Preview id (p_…)", required: true }],
        options: { hours: { type: "integer", default: 2, min: 1, max: 24, description: "Hours from now (1–24)" }, json },
        async run({ positionals, options }, ctx) {
          return guard(async () => {
            const view = await service.extendPreview(positionals.id, options.hours, ctx.signal);
            runtime.changed();
            const capped = view.hours < options.hours ? " (your boat plan's auto-stop cap)" : "";
            return out({ ...view.preview, stopsAt: view.stopsAt, hours: view.hours }, options.json, () => `Preview ${view.preview.id}'s sandbox stays on for ${view.hours} more ${view.hours === 1 ? "hour" : "hours"}${capped}.`);
          });
        },
      }),
      "preview stop": cliCommand({
        summary: "Stop a preview's sandbox (Wake brings it back with the same link)",
        positionals: [{ name: "id", description: "Preview id (p_…)", required: true }],
        options: { json },
        async run({ positionals, options }, ctx) {
          return guard(async () => {
            const view = await service.stopPreview(positionals.id, ctx.signal);
            runtime.changed();
            return out({ ...view.preview, state: view.state }, options.json, () => `Stopped preview ${view.preview.id}'s sandbox.`);
          });
        },
      }),
      "task wait": cliCommand({
        summary: "Block until the given tasks stop running (prefer ending your turn; you get notified)",
        positionals: [{ name: "ids", description: "Task ids", required: true, variadic: true }],
        options: {
          timeout: { type: "duration", defaultUnit: "m", min: 1000, max: 30 * 60_000, default: 5 * 60_000, description: "Give up after (max 30m)" },
          json,
        },
        async run({ positionals, options }, ctx) {
          return guard(async () => {
            const ids = positionals.ids.map((id) => service.mustGet(id).id);
            const deadline = Date.now() + options.timeout;
            for (;;) {
              await service.sweep();
              const tasks = ids.map((id) => service.mustGet(id));
              const busy = tasks.filter((task) => task.status === "running" || task.status === "starting");
              if (busy.length === 0 || Date.now() >= deadline || ctx.signal?.aborted) {
                return out({ tasks, timedOut: busy.length > 0 }, options.json, () =>
                  `${busy.length > 0 ? `Still running after the timeout: ${busy.map((task) => task.id).join(", ")}\n\n` : ""}${taskTable(tasks, (task) => taskNote(task, service.store.latestEvent(task.id, "review")?.text ?? null))}`,
                );
              }
              await new Promise((resolve) => setTimeout(resolve, 10_000));
            }
          });
        },
      }),

      // ---------------------------------------------------------------- orchestrators
      "orchestrator on": cliCommand({
        summary: "Make a thread an orchestrator (tools and instructions apply from its next new session)",
        options: {
          thread: { type: "string", description: "Thread id (default: this thread)" },
          project: { type: "string", description: "Project it works on (id, or local:<bb project id>)" },
          json,
        },
        async run({ options }, ctx) {
          return guard(async () => {
            const threadId = requireThread(ctx, options.thread);
            const project = options.project ? await runtime.resolveProject(parseProjectRef(options.project)) : null;
            await runtime.setOrchestrator(threadId, true, project);
            return out({ threadId, orchestrator: true }, options.json, () =>
              `Thread ${threadId} is now a boat orchestrator. Its agent gets the boat tools and orchestrator instructions the next time the chat starts a new session.`,
            );
          });
        },
      }),
      "orchestrator off": cliCommand({
        summary: "Stop treating a thread as an orchestrator",
        options: { thread: { type: "string", description: "Thread id (default: this thread)" }, json },
        async run({ options }, ctx) {
          return guard(async () => {
            const threadId = requireThread(ctx, options.thread);
            await runtime.setOrchestrator(threadId, false);
            return out({ threadId, orchestrator: false }, options.json, () => `Thread ${threadId} is no longer an orchestrator.`);
          });
        },
      }),
      "orchestrator new": cliCommand({
        summary:
          "Start a new orchestrator chat for a project (in a new boat sandbox when bb Connect is set up, else on this machine; --cloud, --local or --machine to choose)",
        options: {
          project: {
            type: "string",
            required: true,
            description: "Project to work on: an id from `bb boat project list`, or local:<bb project id>",
          },
          prompt: { type: "string", description: "The work to coordinate" },
          "prompt-file": { type: "string", description: "Read the request from this file" },
          title: { type: "string", description: "Chat title" },
          machine: { type: "string", aliases: ["host"], description: "Run on this bb machine (host id) instead of a boat sandbox" },
          local: { type: "boolean", description: "Run on this server's machine instead of a boat sandbox" },
          cloud: { type: "boolean", description: "Run in a new boat sandbox (needs bb Connect; the default when it's set up)" },
          "take-over": { type: "string", description: "Previous orchestrator thread id: its last message and open tasks move here" },
          "take-over-file": { type: "string", description: "Handoff notes (e.g. a ledger) to put into the kickoff" },
          provider: {
            type: "string",
            description: "Agent: claude-code (or claude) or codex; default: Agent for orchestrators while it's connected. Another bb agent provider id works too",
          },
          model: { type: "string", description: "Model id (default: the Build preset's model for the agent)" },
          effort: {
            type: "enum",
            values: ORCHESTRATOR_EFFORTS,
            aliases: ["reasoning-effort"],
            description: "Effort: low, medium, high, xhigh (default: Effort for orchestrators, high)",
          },
          json,
        },
        constraints: [
          { kind: "exactly-one", options: ["prompt", "prompt-file"] },
          { kind: "at-most-one", options: ["machine", "local", "cloud"] },
        ],
        async run({ options }, ctx) {
          return guard(async () => {
            const prompt = (await textArg(runtime, ctx, options.prompt, options["prompt-file"], "prompt")) ?? "";
            const notes = options["take-over-file"]
              ? await textArg(runtime, ctx, undefined, options["take-over-file"], "take-over")
              : undefined;
            const { threadId, movedTaskIds, cloud, note, agent } = await runtime.startOrchestrator({
              project: parseProjectRef(options.project),
              hostId: options.machine ?? null,
              // Unset: in the cloud when bb Connect is set up (it keeps running while this computer sleeps).
              cloud: options.cloud ? true : options.local || options.machine ? false : undefined,
              providerId: options.provider ?? null,
              model: options.model ?? null,
              effort: options.effort ?? null,
              title: options.title ?? null,
              prompt,
              takeOver:
                options["take-over"] || notes
                  ? { threadId: options["take-over"] ?? null, text: notes ?? null, fileName: options["take-over-file"] ?? null }
                  : null,
            });
            return out({ threadId, movedTaskIds, cloud, note, agent }, options.json, () =>
              [
                `Started orchestrator @thread:${threadId}${cloud ? " in a new boat sandbox" : ""}`,
                note,
                `Agent: ${choiceSummary(agent)}`,
                movedTaskIds.length > 0 ? `Moved ${movedTaskIds.length} open task(s) to it: ${movedTaskIds.join(", ")}` : null,
              ]
                .filter(Boolean)
                .join("\n"),
            );
          });
        },
      }),
      "decision add": cliCommand({
        summary: "Put a decision only the user can make on their overview (Needs you), with your recommendation",
        options: {
          question: { type: "string", required: true, description: "The decision, in plain words" },
          recommendation: { type: "string", required: true, description: "What you recommend, and why in a few words" },
          option: { type: "string", repeatable: true, description: "A choice label or JSON object with label, summary, facts, verdict, recommended (repeat for each)" },
          context: { type: "string", description: "One context line under the question" },
          "short-label": { type: "string", description: "Concise sidebar action, e.g. Pick a rate limit" },
          "asked-by-task": { type: "string", description: "Task that asked the question" },
          task: { type: "string", repeatable: true, split: ",", description: "Task ids it's about" },
          thread: { type: "string", description: "Orchestrator thread (default: this one)" },
          json,
        },
        async run({ options }, ctx) {
          return guard(async () => {
            const threadId = options.thread ?? ctx.threadId ?? null;
            const decision = service.store.addDecision({
              orchestratorThreadId: threadId,
              question: options.question.trim(),
              recommendation: options.recommendation.trim(),
              options: (options.option ?? []).map((entry) => {
                const value = entry.trim();
                if (!value.startsWith("{")) return decisionOptionInputSchema.parse(value);
                try { return decisionOptionInputSchema.parse(JSON.parse(value)); }
                catch { throw new PluginCliError("Each JSON option needs a label and valid optional summary, facts, verdict and recommended fields.", { code: "invalid" }); }
              }),
              context: options.context,
              shortLabel: options["short-label"],
              askedByTaskId: options["asked-by-task"] ? service.mustGet(options["asked-by-task"]).id : null,
              taskIds: (options.task ?? []).map((id) => service.mustGet(id).id),
            });
            runtime.changed();
            return out(decision, options.json, () => `Decision ${decision.id} is on the overview under Needs you: ${overviewLink(threadId)}`);
          });
        },
      }),
      "decision list": cliCommand({
        summary: "Open decisions (this chat's, or --all)",
        options: { all: { type: "boolean", description: "Every orchestrator's" }, json },
        async run({ options }, ctx) {
          return guard(async () => {
            const decisions = service.store.decisions({ orchestratorThreadId: options.all ? null : (ctx.threadId ?? null), statuses: ["open"] });
            return out(decisions, options.json, () => (decisions.length === 0 ? "No open decisions." : decisionLines(decisions).join("\n")));
          });
        },
      }),
      "decision resolve": cliCommand({
        summary: "Close a decision once the user answered (or --withdrawn)",
        positionals: [{ name: "id", description: "Decision id (d_…)", required: true }],
        options: {
          answer: { type: "string", description: "The user's answer" },
          withdrawn: { type: "boolean", description: "No longer needed" },
          json,
        },
        async run({ positionals, options }) {
          return guard(async () => {
            const resolved = service.store.resolveDecision(positionals.id, options.withdrawn ? "withdrawn" : "answered", options.answer ?? null);
            if (resolved === null) throw new PluginCliError(`Decision ${positionals.id} is already closed or doesn't exist.`, { code: "decision_closed" });
            runtime.changed();
            return out(resolved, options.json, () => `Decision ${resolved.id} is ${resolved.status}.`);
          });
        },
      }),
      "task ready": cliCommand({
        summary: "Mark a task's work ready for the user to review (Ready to review on the overview)",
        positionals: [{ name: "id", description: "Task id", required: true }],
        options: { note: { type: "string", description: "One line: what the user should look at" }, json },
        async run({ positionals, options }) {
          return guard(async () => {
            const task = service.markReady(positionals.id, options.note ?? "");
            return out(task, options.json, () => `Task ${task.id} is under Ready to review: ${overviewLink(task.orchestratorThreadId)}`);
          });
        },
      }),
      "relay status": cliCommand({
        summary: "Claude and Codex usage, and which agent runs each orchestrator (Claude ↔ Codex switching moves them near limits)",
        options: { json },
        async run({ options }) {
          return guard(async () => {
            const settings = await service.settings();
            const { avoidExtraUsage } = settings;
            const relay = effectiveRelay(settings.relay, settings.agents);
            const only = onlyAgent(settings.agents);
            const status = await runtime.relayStatus();
            const quotas = Object.fromEntries(status.quotas);
            return out({ relay, agents: settings.agents, avoidExtraUsage, quotas, orchestrators: status.orchestrators }, options.json, () =>
              [
                ...(only === null
                  ? [quotaLine(status.quotas.get("claude"), "claude"), quotaLine(status.quotas.get("codex"), "codex")]
                  : [quotaLine(status.quotas.get(only), only)]),
                only !== null
                  ? `Claude ↔ Codex switching off: only ${AGENT_NAME[only]} is set up (Coding agents), so everything runs on it.`
                  : relay.enabled
                    ? `Claude ↔ Codex switching on: hands over at ${relay.switchAtPercent}%, back to ${AGENT_NAME[relay.preferred]} below ${relay.switchBackBelowPercent}% after ${relay.quietMinutes} quiet minutes.`
                    : "Claude ↔ Codex switching off: orchestrators stay on their agent.",
                avoidExtraUsage
                  ? `No paid extra usage: with ${only === null ? "both agents" : AGENT_NAME[only]} near ${only === null ? "their limits" : "its limit"}, new work waits.`
                  : "Paid extra usage allowed.",
                "",
                ...(status.orchestrators.length === 0
                  ? ["No orchestrators."]
                  : status.orchestrators.map(
                      (row) =>
                        `@thread:${row.threadId} ${row.title ?? ""} — ${row.provider ? AGENT_NAME[row.provider] : "other agent"}${note(relayNote(row.state, row.decision))}`,
                    )),
              ].join("\n"),
            );
          });
        },
      }),
      "relay check": cliCommand({
        summary: "Run Claude ↔ Codex switching once now (it also runs every minute while bb is open)",
        options: { json },
        async run({ options }) {
          return guard(async () => {
            const actions = await runtime.relayTick();
            runtime.changed();
            return out({ actions }, options.json, () =>
              actions.length === 0
                ? "Nothing to switch."
                : actions
                    .map((action) =>
                      action.kind === "took-over"
                        ? `@thread:${action.successor} took over @thread:${action.threadId} on ${AGENT_NAME[action.to]} (${action.reason}).`
                        : action.kind === "requested-handoff"
                          ? `Asked @thread:${action.threadId} for a handoff note for ${AGENT_NAME[action.to]} (${action.reason}).`
                          : action.kind === "both-out"
                            ? `@thread:${action.threadId} waits: ${action.reason}.`
                            : `@thread:${action.threadId}: skipped (${action.reason}).`,
                    )
                    .join("\n"),
            );
          });
        },
      }),
      "relay switch": cliCommand({
        summary: "Move an orchestrator to the other agent now (it writes a handoff note first unless --now)",
        positionals: [{ name: "thread", description: "Orchestrator thread id (default: this one)", required: false }],
        options: {
          to: { ...agent, aliases: [], description: "Agent to move to (default: the other one)" },
          now: { type: "boolean", description: "Don't wait for a handoff note" },
          json,
        },
        async run({ positionals, options }, ctx) {
          return guard(async () => {
            const threadId = positionals.thread ?? ctx.threadId;
            if (!threadId) throw new PluginCliError("Name the orchestrator thread.", { code: "invalid_value" });
            const status = await runtime.relayStatus();
            const row = status.orchestrators.find((entry) => entry.threadId === threadId);
            if (!row) throw new PluginCliError(`${threadId} isn't a running orchestrator.`, { code: "not_found" });
            const to = (options.to as Provider | undefined) ?? (row.provider ? otherAgent(row.provider) : "claude");
            const action = await runtime.relaySwitch(threadId, to, { immediate: options.now ?? false, reason: "switched by hand" });
            return out(action, options.json, () =>
              action.kind === "took-over"
                ? `@thread:${action.successor} took over on ${AGENT_NAME[to]}; the old chat is archived.`
                : `Asked @thread:${threadId} for a handoff note; a ${AGENT_NAME[to]} orchestrator takes over when it's written.`,
            );
          });
        },
      }),
      "protocol show": cliCommand({
        summary: "Print the orchestrator protocol: the shared rules, then the project's rules file",
        options: {
          project: { type: "string", description: "Project id or local:<bb project id> (default: this orchestrator's project)" },
          shared: { type: "boolean", description: "Only the shared protocol (no project rules)" },
          json,
        },
        async run({ options }, ctx) {
          return guard(async () => {
            const project = options.shared
              ? null
              : options.project
                ? await runtime.resolveProject(parseProjectRef(options.project))
                : await runtime.projectForThread(ctx.threadId);
            const text = options.shared
              ? renderSharedProtocol(runtime.protocol.read().text, (await runtime.modelTiers()).tiers, await service.settings())
              : await runtime.orchestratorProtocol(project, ctx.signal);
            return out({ project: project?.id ?? null, text }, options.json, () => text);
          });
        },
      }),
      "protocol path": cliCommand({
        summary: "Where the shared protocol file lives (edit it there or in Settings → Plugins → Boat Cloud Agents)",
        options: { json },
        async run({ options }) {
          return guard(async () => {
            const file = runtime.protocol.read();
            return out({ path: file.path, custom: file.custom }, options.json, () =>
              file.custom ? file.path : `${file.path}\n(not created yet: the built-in protocol applies until you save one)`,
            );
          });
        },
      }),
      "orchestrator list": cliCommand({
        summary: "List orchestrator threads and their open tasks",
        options: { json },
        async run({ options }) {
          return guard(async () => {
            const rows = service.store.orchestrators().map((row) => ({
              ...row,
              openTasks: service.store.list({ orchestratorThreadId: row.threadId, statuses: OPEN_STATUSES }).length,
            }));
            return out(rows, options.json, () =>
              rows.length === 0
                ? "No orchestrators yet. Start one with `bb boat orchestrator new --project <id> --prompt \"…\"`."
                : rows
                    .map(
                      (row) =>
                        `@thread:${row.threadId}  ${row.projectName ?? "no project"}  ${row.openTasks} open task(s)  since ${row.createdAt.slice(0, 16)}`,
                    )
                    .join("\n"),
            );
          });
        },
      }),

      // ---------------------------------------------------------------- projects
      "project list": cliCommand({
        summary: "List projects (and, with --local, local bb projects with their branch)",
        options: { local: { type: "boolean", description: "Also list local bb projects" }, json },
        async run({ options }) {
          return guard(async () => {
            const configured = runtime.projects.list();
            const local = options.local ? await listLocalProjects(runtime.bb, runtime.projects) : [];
            return out({ projects: configured, local }, options.json, () =>
              [
                configured.length === 0
                  ? 'No projects yet. Add your first one: `bb boat project add --name "Web app" --repo acme/web@main` (or in Settings → Plugins → Boat Cloud Agents → Projects).'
                  : configured.map(projectLine).join("\n"),
                ...(options.local
                  ? [
                      "",
                      "Local bb projects (use as local:<id>):",
                      ...local.map(
                        (entry) =>
                          `local:${entry.bbProjectId}  ${entry.name}  ${entry.repo}${entry.branch ? ` @ ${entry.branch}` : ""}${
                            entry.problem
                              ? `  (${entry.problem})`
                              : entry.branchMissingRemotely
                                ? "  (branch not on GitHub)"
                                : entry.unpushed
                                  ? `  (${entry.unpushed} unpushed)`
                                  : ""
                          }`,
                      ),
                    ]
                  : []),
              ].join("\n"),
            );
          });
        },
      }),
      "project add": cliCommand({
        summary: "Add or update a project (repos are owner/name@base)",
        options: {
          name: { type: "string", required: true, description: "Project name" },
          id: { type: "string", description: "Id to update (default: from the name)" },
          repo: {
            type: "string",
            required: true,
            repeatable: true,
            description: "Repository with its base branch, e.g. acme/web@main (repeat; first is the main repo)",
          },
          environment: { type: "string", description: "boat environment (boat new --environment)" },
          snapshot: { type: "string", description: "Saved boat snapshot its tasks start from" },
          protocol: { type: "string", description: "Repo-specific orchestrator rules file in the main repo" },
          workers: {
            type: "enum",
            values: ["chat", "boat"],
            description:
              "chat: run tasks as chats (you trust the repos; only matters when How tasks run is As chats for projects or everywhere; default); boat: always headless in boat, with no access to your bb",
          },
          delivery: {
            type: "enum",
            values: ["pr", "push"],
            description: "pr: draft pull requests (default); push: tasks only commit, and approved work ships to the base branch",
          },
          "protected-branches": {
            type: "string",
            description: "Comma-separated branches no task may push to, on top of the base branches, e.g. release, develop",
          },
          instructions: { type: "string", description: "Added to the brief of every task of this project" },
          "instructions-file": { type: "string", description: "Read the instructions from a file (on the machine you run this on)" },
          size: {
            type: "enum",
            values: MACHINE_TYPES,
            description: "Sandbox size for this project's new tasks and their reviews (small, default, large, xlarge); default: the Default sandbox size setting. xlarge from an agent's chat needs --user-approved",
          },
          "user-approved": { type: "boolean", description: "The user approved XLarge sandboxes for this project" },
          json,
        },
        async run({ options }, ctx) {
          return guard(async () => {
            assertProjectSizeAllowed(options.size, options["user-approved"] === true, ctx.threadId);
            const repos = options.repo.map((entry) => {
              const at = entry.lastIndexOf("@");
              if (at <= 0) {
                throw new PluginCliError(`"${entry}" needs a base branch, like owner/name@main.`, { code: "invalid_value" });
              }
              return { repo: entry.slice(0, at), baseBranch: entry.slice(at + 1) };
            });
            const instructions = await projectInstructionsArg(runtime, ctx, options.instructions, options["instructions-file"]);
            let project;
            try {
              project = runtime.projects.save({
                // Same name as an existing project: update it instead of adding "<id>-2".
                id: options.id ?? runtime.projects.find(options.name)?.id,
                name: options.name,
                repos,
                environment: options.environment ?? null,
                snapshot: options.snapshot ?? null,
                protocolPath: options.protocol ?? null,
                ...(options.workers ? { workerMode: options.workers as "chat" | "boat" } : {}),
                ...(options.delivery ? { delivery: options.delivery as "pr" | "push" } : {}),
                ...(options["protected-branches"] !== undefined ? { protectedBranches: options["protected-branches"] } : {}),
                ...(instructions !== undefined ? { instructions } : {}),
                // Leaving the flag out keeps the project's size.
                ...(options.size ? { machineType: options.size as MachineType } : {}),
              });
            } catch (error) {
              throw new PluginCliError(error instanceof Error ? error.message : String(error), { code: "invalid_value" });
            }
            runtime.changed();
            const sizeNote = await projectSizeNote(runtime, project);
            return out({ ...project, sizeNote }, options.json, () => `Saved project ${projectLine(project)}${sizeNote ? `\n${sizeNote}` : ""}`);
          });
        },
      }),
      "project set": cliCommand({
        summary: "Change one project's settings (how work lands, task chats, snapshot, environment, protected branches, instructions)",
        positionals: [{ name: "id", description: "Project id", required: true }],
        options: {
          delivery: { type: "enum", values: ["pr", "push"], description: "pr: draft pull requests; push: approved work ships to the base branch" },
          workers: { type: "enum", values: ["chat", "boat"], description: "chat: run tasks as chats (with How tasks run set to chats); boat: always headless in boat" },
          snapshot: { type: "string", description: 'Saved snapshot tasks start from ("none" clears it)' },
          environment: { type: "string", description: 'boat environment ("none" for your default)' },
          "protected-branches": { type: "string", description: 'Comma-separated branches no task may push to, on top of the base branches ("none" clears them)' },
          instructions: { type: "string", description: 'Added to the brief of every task of this project ("none" clears them)' },
          "instructions-file": { type: "string", description: "Read the instructions from a file (on the machine you run this on)" },
          size: {
            type: "enum",
            values: [...MACHINE_TYPES, "none"],
            description: 'Sandbox size for its new tasks and their reviews ("none": the Default sandbox size setting); xlarge from an agent\'s chat needs --user-approved',
          },
          "user-approved": { type: "boolean", description: "The user approved XLarge sandboxes for this project" },
          json,
        },
        async run({ positionals, options }, ctx) {
          return guard(async () => {
            assertProjectSizeAllowed(options.size, options["user-approved"] === true, ctx.threadId);
            const existing = runtime.projects.get(positionals.id);
            if (existing === null) throw new PluginCliError(`No project "${positionals.id}".`, { code: "project_not_found" });
            const value = (next: string | undefined, current: string | null) => (next === undefined ? current : next === "none" ? null : next);
            const instructions = await projectInstructionsArg(runtime, ctx, options.instructions, options["instructions-file"]);
            let project;
            try {
              project = runtime.projects.save({
                id: existing.id,
                name: existing.name,
                repos: existing.repos,
                environment: value(options.environment, existing.environment),
                snapshot: value(options.snapshot, existing.snapshot),
                protocolPath: existing.protocolPath,
                workerMode: (options.workers as "chat" | "boat" | undefined) ?? existing.workerMode,
                delivery: (options.delivery as "pr" | "push" | undefined) ?? existing.delivery,
                ...(options["protected-branches"] !== undefined
                  ? { protectedBranches: options["protected-branches"].trim() === "none" ? [] : options["protected-branches"] }
                  : {}),
                ...(instructions !== undefined ? { instructions: instructions.trim() === "none" ? "" : instructions } : {}),
                ...(options.size !== undefined ? { machineType: options.size === "none" ? null : (options.size as MachineType) } : {}),
              });
            } catch (error) {
              throw new PluginCliError(error instanceof Error ? error.message : String(error), { code: "invalid_value" });
            }
            runtime.changed();
            const sizeNote = await projectSizeNote(runtime, project);
            return out({ ...project, sizeNote }, options.json, () => `Saved project ${projectLine(project)}${sizeNote ? `\n${sizeNote}` : ""}`);
          });
        },
      }),
      "project remove": cliCommand({
        summary: "Remove a project (running orchestrators keep their copy)",
        positionals: [{ name: "id", description: "Project id", required: true }],
        options: { json },
        async run({ positionals, options }) {
          return guard(async () => {
            const removed = runtime.projects.delete(positionals.id);
            if (!removed) throw new PluginCliError(`No project "${positionals.id}".`, { code: "project_not_found" });
            runtime.changed();
            return out({ ok: true }, options.json, () => `Removed project ${positionals.id}.`);
          });
        },
      }),

      // ---------------------------------------------------------------- back up and restore
      "config export": cliCommand({
        summary: "Back up every plugin setting, the projects, model presets and custom protocol as JSON",
        description:
          "Prints the backup, or writes it with --output (on the machine you run this on). It holds no tasks, chats, sandboxes or secrets, but it does hold your standing instructions and project details: keep it private.",
        options: {
          output: { type: "string", description: "Write the backup to this file instead of printing it" },
          json,
        },
        async run({ options }, ctx) {
          return guard(async () => {
            const file = await exportConfig(runtime.config);
            const text = `${JSON.stringify(file, null, 2)}\n`;
            if (!options.output) return { exitCode: 0, stdout: text };
            let path: string;
            try {
              path = await runtime.writeInvokerFile(ctx, options.output, text);
            } catch (error) {
              throw new PluginCliError(`Could not write ${options.output}: ${error instanceof Error ? error.message : String(error)}`, { code: "file_unwritable" });
            }
            const parts = [
              `${Object.keys(file.settings).length} settings`,
              `${file.projects.length} project${file.projects.length === 1 ? "" : "s"}`,
              file.modelTiers ? "your model presets" : "the built-in model presets",
              file.protocol ? "your protocol" : "the built-in protocol",
            ];
            return out({ path, settings: Object.keys(file.settings).length, projects: file.projects.length, customTiers: file.modelTiers !== null, customProtocol: file.protocol !== null }, options.json, () =>
              `Saved ${path}: ${parts.join(", ")}. Keep it private. Restore it with \`bb boat config import ${options.output}\`.`,
            );
          });
        },
      }),
      "config get": cliCommand({
        summary: "Show every setting (bb's list and the plugin's own), or one",
        description:
          "Without a key: every setting with its value, by where it's shown (bb's settings list, then the plugin's own sections). With a key: just its value. Change one with `bb boat config set <key> <value>`.",
        positionals: [{ name: "key", description: "A setting's key, like relaySwitchAt", required: false }],
        options: { json },
        async run({ positionals, options }) {
          return guard(async () => {
            const settings = await service.settings();
            const rows = settingRows(await runtime.settings.get(), { onlyAgent: onlyAgent(settings.agents), declaredInPlugin: runtime.settings.declaredInPlugin });
            if (positionals.key === undefined) return out({ settings: rows }, options.json, () => settingsText(rows));
            const key = settingKey(positionals.key);
            const row = rows.find((entry) => entry.key === key)!;
            return out(row, options.json, () => (typeof row.value === "string" ? row.value : String(row.value)));
          });
        },
      }),
      "config set": cliCommand({
        summary: "Change one setting (bb's list or the plugin's own)",
        description:
          'Values: true/false for switches, numbers for numbers, one of the listed options for choices, and any text for text ("" for empty). `bb boat config get` lists every key.',
        positionals: [
          { name: "key", description: "The setting's key, like relaySwitchAt", required: true },
          { name: "value", description: "The new value", required: true },
        ],
        options: { json },
        async run({ positionals, options }) {
          return guard(async () => {
            const key = settingKey(positionals.key);
            const descriptor = ALL_SETTINGS[key];
            let value;
            try {
              value = parseSettingText(key, descriptor, positionals.value);
            } catch (error) {
              throw new PluginCliError(error instanceof Error ? error.message : String(error), { code: "invalid_setting" });
            }
            const before = (await runtime.settings.get())[key];
            await saveSettings(runtime, { [key]: value });
            const row = await settingRow(runtime, key);
            return out(row, options.json, () =>
              JSON.stringify(before) === JSON.stringify(row.value) ? `${rowLine(row)}  (unchanged)` : `Set ${rowLine(row)}`,
            );
          });
        },
      }),
      "config reset": cliCommand({
        summary: "Put one setting back to its default",
        positionals: [{ name: "key", description: "The setting's key, like relaySwitchAt", required: true }],
        options: { json },
        async run({ positionals, options }) {
          return guard(async () => {
            const key = settingKey(positionals.key);
            await saveSettings(runtime, { [key]: null });
            const row = await settingRow(runtime, key);
            return out(row, options.json, () => `Reset ${rowLine(row)}`);
          });
        },
      }),
      "config import": cliCommand({
        summary: "Restore a backup from config export, then show what changed (--dry-run: only show what would)",
        description:
          "Settings in the file are set (keys this version doesn't know are skipped); projects are added or updated, and others are kept unless --replace-projects; model presets and the protocol follow the file (null in the file: the built-in ones).",
        positionals: [{ name: "file", description: "The backup file (JSON from config export)", required: true }],
        options: {
          "dry-run": { type: "boolean", description: "Only show what would change" },
          "replace-projects": {
            type: "boolean",
            description: "Also remove projects that aren't in the file (never one with open tasks or an open orchestrator)",
          },
          json,
        },
        async run({ positionals, options }, ctx) {
          return guard(async () => {
            let text: string;
            try {
              text = await runtime.readInvokerFile(ctx, positionals.file);
            } catch (error) {
              throw new PluginCliError(`Could not read ${positionals.file}: ${error instanceof Error ? error.message : String(error)}`, { code: "file_unreadable" });
            }
            const dryRun = options["dry-run"] === true;
            let plan;
            try {
              plan = await planImport(runtime.config, text, { replaceProjects: options["replace-projects"] === true });
              // A dry run refuses the same files the import does.
              if (plan.problems.length > 0) throw new ConfigError(plan.problems);
              if (!dryRun) await applyImport(runtime.config, plan);
            } catch (error) {
              if (error instanceof ConfigError) throw new PluginCliError(error.message, { code: "invalid_backup" });
              throw new PluginCliError(`The import failed: ${error instanceof Error ? error.message : String(error)}`, { code: "import_failed" });
            }
            if (!dryRun) runtime.changed();
            const changes = changeCount(plan);
            const sections = summarize(plan);
            const head = dryRun
              ? changes === 0
                ? "Dry run: nothing would change; this bb already matches the file."
                : `Dry run: nothing was changed. Importing would make ${changes} change${changes === 1 ? "" : "s"}:`
              : changes === 0
                ? "Imported: nothing changed; this bb already matched the file."
                : `Imported ${changes} change${changes === 1 ? "" : "s"}:`;
            return out({ dryRun, changes, sections }, options.json, () => `${head}\n\n${summaryText(sections)}`);
          });
        },
      }),
    },
  });
}

function projectLine(project: BoatProject): string {
  const repos = project.repos.map((entry) => `${entry.repo}@${entry.baseBranch}`).join(" + ");
  return `${project.id}  ${project.name}  ${repos}  env ${project.environment ?? "default"}${project.snapshot ? `  snapshot ${project.snapshot}` : ""}${project.protocolPath ? `  protocol ${project.protocolPath}` : ""}  ${project.workerMode === "boat" ? "tasks in boat only" : "tasks as chats allowed"}  ${project.delivery === "push" ? "ships after approval" : "draft PRs"}${project.machineType ? `  ${SIZE_SPECS[project.machineType].label.toLowerCase()} sandboxes` : ""}${project.protectedBranches.length > 0 ? `  protects ${project.protectedBranches.join(", ")}` : ""}${project.instructions ? "  has instructions" : ""}`;
}

/**
 * XLarge for every new task of a project, set from an agent's chat, needs
 * the user's OK (like an XLarge task); the user's own terminal doesn't.
 */
function assertProjectSizeAllowed(size: string | undefined, userApproved: boolean, threadId: string | null | undefined): void {
  if (size !== "xlarge" || userApproved || !threadId) return;
  throw new PluginCliError("XLarge sandboxes for every task of a project need the user's OK.", {
    code: "size_needs_approval",
    hint: "Ask the user first, then pass --user-approved. Large needs no OK.",
  });
}

/** A project size the plan doesn't allow (yet): what happens until it does. */
async function projectSizeNote(runtime: Runtime, project: BoatProject): Promise<string | null> {
  if (project.machineType === null) return null;
  const verdict = await runtime.service.sizes.projectSizeVerdict(project.machineType);
  if (verdict.allowed) return null;
  const label = SIZE_SPECS[project.machineType].label;
  return `Note: your boat plan doesn't include ${label} right now (${(verdict.reason ?? "").replace(/[.\s]+$/, "")}). Until it does, this project's tasks start on the Default sandbox size setting.`;
}

/** --instructions or --instructions-file (at most one). */
async function projectInstructionsArg(runtime: Runtime, ctx: PluginCliContext, inline: string | undefined, file: string | undefined): Promise<string | undefined> {
  if (inline !== undefined && file !== undefined) {
    throw new PluginCliError("Pass --instructions or --instructions-file, not both.", { code: "invalid_value" });
  }
  if (inline !== undefined) return inline;
  return file === undefined ? undefined : textArg(runtime, ctx, undefined, file, "instructions");
}

/** One setting by key, or a refusal that lists the keys. */
function settingKey(key: string): SettingKey {
  if (Object.hasOwn(ALL_SETTINGS, key)) return key as SettingKey;
  throw new PluginCliError(`There's no setting "${key}".`, {
    code: "unknown_setting",
    hint: `Settings: ${Object.keys(ALL_SETTINGS).join(", ")}. \`bb boat config get\` lists them with their values.`,
  });
}

/** "relaySwitchAt = 85  (default 90)". */
function rowLine(row: SettingRow): string {
  return settingsText([row]).split("\n").slice(1).join("\n").trim();
}

const note = (text: string | null) => (text ? ` · ${text}` : "");

/** "Web app — environment web: 3 secrets (A, B, C); GitHub: acme/web can push (checked 2h ago)". */
function accessLines(name: string, access: ProjectAccess): string[] {
  const repoState = (repo: ProjectAccess["repos"][number]) => {
    const check = repo.lastCheck;
    if (check?.access === "none") return `no access (${check.detail ?? "connect GitHub on boat.dev → Environment and give boat access to it"})`;
    if (check?.access === "expired") return "the last sandbox's GitHub login had expired";
    if (check?.access === "read") return "read only: tasks can't push";
    if (check?.access === "write") return `can push (checked ${check.checkedAt.slice(0, 16).replace("T", " ")} UTC)`;
    return repo.environmentPermission ? `${repo.environmentPermission} in the environment (not checked in a sandbox yet)` : "not checked yet";
  };
  const secrets = access.error
    ? `couldn't read: ${access.error}`
    : `${access.secretNames.length} secret${access.secretNames.length === 1 ? "" : "s"}${access.secretNames.length ? ` (${access.secretNames.join(", ")})` : ""}${access.secretFiles.length ? `, files ${access.secretFiles.join(", ")}` : ""}${access.passSecrets === false ? "; secrets aren't passed in" : ""}${access.passGithub === false ? "; GitHub access isn't passed in" : ""}${access.passSandboxCredentials === true ? "; boat credentials are passed in: workers can start, stop and delete any of your sandboxes" : access.passSandboxCredentials === null ? "; couldn't tell whether boat credentials are passed in" : ""}${access.passAgentsCredentials === true && access.aiProxy === false ? `; real AI keys are passed in (\`boat ai proxy on\` passes placeholders: a paid add-on${access.aiProxyPrice ? `, ${access.aiProxyPrice}` : ""})` : ""}`;
  return [
    `- ${name}: environment ${access.environment ?? "default"}: ${secrets}`,
    ...access.repos.map((repo) => `    ${repo.repo}: ${repoState(repo)}`),
  ];
}
