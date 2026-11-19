#!/usr/bin/env node
// A stand-in for the `instabox` CLI, for tests: the documented commands and
// JSON shapes (CLI reference, OpenAPI spec, `--help` of CLI 0.8.309), state in
// the JSON file FAKE_INSTABOX_STATE (fake-api.mjs serves the REST side from
// the same file). It never prints or stores the API key: it only checks that
// INSTABOX_API_KEY is set (and equals FAKE_INSTABOX_KEY when that is set).
//
// state.fail: "down" (every command: 503 host_unavailable, exit 75),
// "invite" (403 invite_required, exit 3), "no_capacity" (create only: exit 75).
// state.autoReply: a turn ends at once with this reply (null: it runs until
// the test ends it in the state file).
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

const statePath = process.env.FAKE_INSTABOX_STATE;
if (!statePath) {
  process.stderr.write("FAKE_INSTABOX_STATE is not set\n");
  process.exit(1);
}
// One command at a time on the state (the service runs some at once): a lock file for the whole run.
const lockPath = `${statePath}.lock`;
for (let tries = 0; ; tries += 1) {
  try {
    closeSync(openSync(lockPath, "wx"));
    break;
  } catch {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > 10_000) unlinkSync(lockPath);
    } catch {
      // Gone meanwhile.
    }
    if (tries > 2_000) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
process.on("exit", () => {
  try {
    unlinkSync(lockPath);
  } catch {
    // Already gone.
  }
});
const initial = () => ({ machines: {}, next: 1, ports: {}, snapshots: [], convos: {}, calls: [], jobs: 0, maxMachines: 5, tier: "pro", fail: null, autoReply: null, execs: [] });
const state = existsSync(statePath) ? { ...initial(), ...JSON.parse(readFileSync(statePath, "utf8")) } : initial();
// Whole-file writes (the service runs two commands at once): never a half-written file.
const save = () => {
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2));
  renameSync(temporary, statePath);
};
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const fail = (exitCode, error) => {
  print({ error });
  process.stderr.write(`instabox: error ${error.code}: ${error.message}\n`);
  save();
  process.exit(exitCode);
};

const args = process.argv.slice(2);
// What ran, without the prompt or any value after `--` (a script): the command words and flags.
const dash = args.indexOf("--");
state.calls.push((dash === -1 ? args : args.slice(0, dash)).join(" "));

const key = process.env.INSTABOX_API_KEY;
if (!key) fail(3, { code: "missing_key", message: "no credentials: set INSTABOX_API_KEY or run instabox login", status: 401 });
if (process.env.FAKE_INSTABOX_KEY && key !== process.env.FAKE_INSTABOX_KEY) fail(3, { code: "invalid_key", message: "the API key is not valid", status: 401 });
if (state.fail === "down") fail(75, { code: "host_unavailable", message: "upstream unavailable", status: 503, retryable: true });
if (state.fail === "invite") fail(3, { code: "invite_required", message: "an invite is required to use instabox", status: 403 });

const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const flags = (name) => args.flatMap((arg, index) => (arg === name ? [args[index + 1]] : []));
const has = (name) => args.includes(name);
/** Positionals after the command words (flags and their values left out). */
const VALUED = new Set(["--name", "--timeout", "--vcpus", "--mem-mib", "--snapshot", "--env", "--meta", "--ready-timeout", "--provider", "--model", "--resume", "--conversation", "--cwd"]);
const positionals = (skip) => {
  const out = [];
  const end = dash === -1 ? args.length : dash;
  for (let index = skip; index < end; index += 1) {
    if (VALUED.has(args[index])) index += 1;
    else if (!args[index].startsWith("--")) out.push(args[index]);
  }
  return out;
};
const now = () => new Date().toISOString();
const machine = (id) => {
  const found = state.machines[id] ?? Object.values(state.machines).find((entry) => entry.name === id);
  if (!found || found.state === "deleted") fail(4, { code: "not_found", message: `machine ${id} not found`, status: 404 });
  return found;
};
const running = (entry) => {
  if (entry.state !== "running") fail(1, { code: "machine_not_running", message: `${entry.name} is ${entry.state}`, status: 409 });
};

const [command, sub] = args;
switch (command) {
  case "whoami":
    print({ user: { login: "acme-dev" }, org: { id: "org_1", name: "acme", tier: state.tier, kind: "personal" } });
    break;
  case "usage": {
    const count = Object.values(state.machines).filter((entry) => entry.state !== "deleted").length;
    print({ machines: count, snapshots: state.snapshots.length, limits: { maxMachines: state.maxMachines, maxSnapshots: 0, unlimited: state.maxMachines === 0 ? ["maxMachines", "maxSnapshots"] : ["maxSnapshots"], ...(state.machineSpecs ? { machineSpecs: state.machineSpecs } : {}) }, org: { id: "org_1", name: "acme", tier: state.tier }, cost: { costUSD: 3.21, creditRemainingUSD: 16.79 } });
    break;
  }
  case "ls":
    print(Object.values(state.machines).filter((entry) => entry.state !== "deleted"));
    break;
  case "get":
    print(machine(positionals(1)[0]));
    break;
  case "create": {
    // Instabox's rule (OpenAPI CreateMachineRequest.name), as its API refuses other names.
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(flag("--name") ?? "")) fail(1, { code: "bad_request", message: `invalid name "${flag("--name")}": 1-63 lowercase letters, digits or -, starting with a letter or digit`, status: 400 });
    if (Object.values(state.machines).some((entry) => entry.state !== "deleted" && entry.name === flag("--name"))) fail(1, { code: "bad_request", message: `a sandbox named ${flag("--name")} exists`, status: 409 });
    if (state.fail === "no_capacity") fail(75, { code: "no_capacity", message: "no host has room for this size right now", status: 503, retryable: true, retryAfterSeconds: 60 });
    const count = Object.values(state.machines).filter((entry) => entry.state !== "deleted").length;
    if (count >= state.maxMachines && state.maxMachines > 0) fail(5, { code: "quota_exceeded", message: `your plan allows ${state.maxMachines} machines`, status: 402 });
    const id = `m_${String(state.next++).padStart(6, "0")}`;
    const vcpus = Number(flag("--vcpus") ?? 4);
    const memMiB = Number(flag("--mem-mib") ?? 8192);
    state.machines[id] = {
      id,
      name: flag("--name"),
      state: "running",
      createdAt: now(),
      updatedAt: now(),
      readyAt: now(),
      runtime: { ready: true },
      spec: { vcpus, memMiB, persistentDiskGiB: 20 },
      vcpus,
      memMiB,
      metadata: Object.fromEntries(flags("--meta").map((pair) => pair.split("="))),
      envNames: flags("--env").map((pair) => pair.split("=")[0]).sort(),
      snapshot: flag("--snapshot") ? { name: flag("--snapshot") } : null,
      autoSuspendAfterSeconds: 1800,
    };
    print(state.machines[id]);
    break;
  }
  case "stop":
  case "suspend": {
    const entry = machine(positionals(1)[0]);
    entry.state = command === "stop" ? "stopped" : "suspended";
    entry.updatedAt = now();
    print(entry);
    break;
  }
  case "start":
  case "resume": {
    const entry = machine(positionals(1)[0]);
    if (command === "resume" && entry.state !== "suspended") fail(1, { code: "operation_conflict", message: `${entry.name} is ${entry.state}, not paused`, status: 409 });
    if (command === "start" && entry.state !== "stopped") fail(1, { code: "operation_conflict", message: `${entry.name} is ${entry.state}, not stopped`, status: 409 });
    entry.state = "running";
    entry.updatedAt = now();
    print(entry);
    break;
  }
  case "resize": {
    const entry = machine(positionals(1)[0]);
    entry.spec = { ...entry.spec, vcpus: Number(flag("--vcpus")), memMiB: Number(flag("--mem-mib")) };
    entry.vcpus = entry.spec.vcpus;
    entry.memMiB = entry.spec.memMiB;
    print(entry);
    break;
  }
  case "rm": {
    const entry = machine(positionals(1)[0]);
    if (!has("--yes")) fail(2, { code: "usage", message: "rm needs --yes off a terminal" });
    entry.state = "deleted";
    print({ id: entry.id, name: entry.name, deleted: true });
    break;
  }
  case "fork": {
    const source = machine(positionals(1)[0]);
    const id = `m_${String(state.next++).padStart(6, "0")}`;
    state.machines[id] = { ...source, id, name: `${source.name}-fork`, createdAt: now() };
    print({ source: source.id, machines: [state.machines[id]], native: true });
    break;
  }
  case "exec": {
    if (has("--background")) {
      const entry = machine(positionals(1)[0]);
      running(entry);
      state.jobs += 1;
      print({ jobId: `job_${state.jobs}`, pid: 4000 + state.jobs });
      break;
    }
    const entry = machine(positionals(1)[0]);
    running(entry);
    const script = args.slice(dash + 1).join(" ");
    state.execs.push({ machine: entry.id, timeout: Number(flag("--timeout")), marker: (script.match(/BOAT_[A-Z_]+/) ?? ["plain"])[0] });
    let stdout = "";
    if (script.includes("BOAT_SETUP")) {
      const repo = /REPO='([^']+)'/.exec(script)?.[1] ?? "acme/web";
      const branch = /BRANCH='([^']+)'/.exec(script)?.[1] ?? "main";
      stdout = `BOAT_ACCESS ok push=true\nBOAT_GH_EXPIRES unknown\nBOAT_SETUP path=/data/home/work/${repo.split("/")[1]} branch=${branch} base=main\n`;
    } else if (script.includes("BOAT_IBX")) {
      stdout = "BOAT_IBX linger on\nBOAT_IBX ca none\nBOAT_IBX node v22.23.3\n";
    } else if (script.includes("BOAT_LOGIN")) {
      stdout = "BOAT_LOGIN ok\n";
    } else if (script.includes("BOAT_SHIP_DONE")) {
      stdout = "BOAT_SHIPPED 0 abcdef1234567890 1\nBOAT_SHIP_DONE\n";
    } else if (script.includes("BOAT_MEM_PROBE")) {
      stdout = "";
    }
    print({ stdout, stderr: "", exitCode: 0, timedOut: false, truncated: false, durationMs: 12 });
    break;
  }
  case "ps":
    machine(positionals(1)[0]);
    print([{ pid: 1, ppid: 0, user: "root", cpuPercent: 0, memPercent: 0.1, elapsedSeconds: 60, command: "/sbin/init" }]);
    break;
  case "port": {
    if (sub !== "publish") fail(2, { code: "usage", message: `unknown port command ${sub}` });
    const [id, port] = positionals(2);
    const entry = machine(id);
    const key = `${entry.id}:${port}`;
    const url = `https://${port}-${entry.id.slice(2)}.instabox.test`;
    const known = state.ports[key];
    const fresh = !known || has("--rotate-token");
    const token = fresh ? `ibp_fake${String(Object.keys(state.ports).length + 1)}${has("--rotate-token") ? "r" : ""}` : null;
    state.ports[key] = { access: "private", name: flag("--name") ?? `Port ${port}` };
    print({ id: `pp_${port}`, machineId: entry.id, port: Number(port), name: flag("--name") ?? `Port ${port}`, url, access: "private", protocol: "http", createdAt: now(), ...(token ? { token, tokenUrl: `${url}/?_token=${token}` } : {}) });
    break;
  }
  case "snapshot": {
    if (sub === "save") {
      const entry = machine(positionals(2)[0]);
      const snapshot = { id: `sn_${state.snapshots.length + 1}`, name: flag("--name"), status: "ready", createdAt: now(), sourceMachineId: entry.id, dataSizeBytes: 1024, rootSizeBytes: 2048 };
      state.snapshots.push(snapshot);
      print(snapshot);
    } else if (sub === "ls") {
      print(state.snapshots);
    } else fail(2, { code: "usage", message: `unknown snapshot command ${sub}` });
    break;
  }
  case "agent": {
    const id = positionals(2)[0];
    const entry = machine(id);
    const conversation = flag("--conversation") ?? flag("--resume");
    const startTurn = (convo, text) => {
      convo.turns += 1;
      state.jobs += 1;
      const turn = convo.turns;
      convo.status = "running";
      convo.events.push({ type: "instabox.turn", turn, jobId: `job_${state.jobs}`, prompt: text.slice(0, 200) });
      if (state.autoReply !== null) {
        convo.events.push({ type: "assistant", message: { content: [{ type: "text", text: "Working on it." }, { type: "tool_use", name: "Bash" }] } });
        convo.events.push({ type: "result", result: state.autoReply, is_error: false });
        convo.events.push({ type: "instabox.turn_end", exitCode: 0, interrupted: false });
        convo.status = "idle";
      }
      return { conversationId: convo.id, provider: convo.provider, turn, jobId: `job_${state.jobs}`, pid: 5000 + state.jobs };
    };
    if (sub === "prompt") {
      running(entry);
      const text = positionals(2).at(-1) === "-" ? readFileSync(0, "utf8") : positionals(2).slice(1).join(" ");
      let convo = conversation ? state.convos[conversation] : null;
      if (conversation && !convo) fail(4, { code: "not_found", message: `conversation ${conversation} not found` });
      if (convo?.status === "running") fail(1, { code: "operation_conflict", message: "the conversation is running a turn; use agent steer" });
      if (!convo) {
        const cid = `c${String(Object.keys(state.convos).length + 1).padStart(7, "0")}`;
        convo = state.convos[cid] = { id: cid, machine: entry.id, provider: flag("--provider") ?? "claude", model: flag("--model") ?? null, status: "idle", turns: 0, events: [], firstPrompt: text.slice(0, 80), promptBytes: [] };
      }
      convo.promptBytes.push(text.length);
      print(startTurn(convo, text));
    } else if (sub === "events") {
      const convo = state.convos[conversation] ?? fail(4, { code: "not_found", message: "no such conversation" });
      print({ conversationId: convo.id, jobId: `job_${state.jobs}`, status: convo.status, exitCode: convo.status === "idle" ? 0 : null, events: convo.events });
    } else if (sub === "ls") {
      const list = Object.values(state.convos).filter((convo) => convo.machine === entry.id);
      print({ conversations: list.map((convo) => ({ id: convo.id, provider: convo.provider, model: convo.model, status: convo.status, turns: convo.turns, firstPrompt: convo.firstPrompt })), total: list.length });
    } else if (sub === "steer") {
      const convo = state.convos[conversation] ?? fail(4, { code: "not_found", message: "no such conversation" });
      if (convo.status === "running") convo.events.push({ type: "instabox.turn_end", exitCode: 130, interrupted: true });
      convo.status = "idle";
      print(startTurn(convo, positionals(2).slice(1).join(" ")));
    } else if (sub === "interrupt") {
      const convo = state.convos[conversation] ?? Object.values(state.convos).find((entry2) => entry2.machine === entry.id);
      if (convo?.status === "running") {
        convo.events.push({ type: "instabox.turn_end", exitCode: 130, interrupted: true });
        convo.status = "interrupted";
      }
      print({ conversationId: convo?.id ?? null, status: convo?.status ?? null });
    } else fail(2, { code: "usage", message: `unknown agent command ${sub}` });
    break;
  }
  case "version":
    print({ version: "0.8.309", os: "linux", arch: "amd64" });
    break;
  default:
    fail(2, { code: "usage", message: `unknown command ${command}` });
}
save();
