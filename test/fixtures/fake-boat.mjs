#!/usr/bin/env node
// A scripted stand-in for the boat CLI. State lives in $FAKE_BOAT_STATE.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const statePath = process.env.FAKE_BOAT_STATE;
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : { sandboxes: {}, convos: {}, calls: [], next: 1 };
const save = () => {
  writeFileSync(`${statePath}.${process.pid}`, JSON.stringify(state));
  renameSync(`${statePath}.${process.pid}`, statePath);
};
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const fail = (code, error, status) => {
  print({ event: "error", code, error, status });
  save();
  process.exit(1);
};

const args = process.argv.slice(2);
state.calls.push(args);
const command = args[0];
if (args[1] !== "--json") fail("test", `expected --json right after the subcommand: ${args.join(" ")}`);
const rest = args.slice(2);
const flag = (name) => {
  const index = rest.indexOf(name);
  return index === -1 ? null : rest[index + 1];
};

// Setup facts (test/fixtures/boat-json has the real shapes): signed in, a
// trial, both agents connected, unless the state says otherwise.
const signedOut = state.signedOut === true;
if (signedOut && ["limits", "env", "ai", "list", "new"].includes(command)) {
  fail("unauthorized", "not signed in, or your session expired. run `boat onboard`", 401);
}

switch (command) {
  case "--version":
    process.stdout.write("boat 1.0.89\n");
    break;
  case "status":
    print({
      account: signedOut
        ? { identifier: null, loginState: "signed out", plan: null, signedIn: false, status: "signed out", suspension: null }
        : { identifier: "you@example.com", loginState: "active", plan: null, signedIn: true, status: "active", suspension: null },
      api: { error: null, healthy: true, status: "healthy", url: "https://boat.dev" },
    });
    break;
  case "ai":
    // `boat ai proxy` without on or off only shows the account's proxy.
    if (rest[0] === "proxy" && (rest[1] === undefined || rest[1].startsWith("-"))) {
      // The real shape (test/fixtures/boat-json/ai-proxy.json); the proxy is a paid add-on.
      print({ enabled: state.aiProxy !== false, enabledAt: null, org: false, pricing: { dailyDollars: 1, dollarsPer1000Requests: 1 }, proxyUrl: "https://ai-proxy.example.com", success: true });
      break;
    }
    if (rest[0] !== "profiles") fail("unknown", `fake boat ai ${rest[0]}`);
    if (state.profilesFail) fail("boat_timeout", "boat.dev didn't answer");
    print({
      profiles: [
        {
          id: "prof_default",
          isDefault: true,
          name: "default",
          owner: { kind: "personal", id: "user_1", name: "you@example.com" },
          connected: state.connected ?? ["claude-subscription", "chatgpt-subscription"],
        },
      ],
    });
    break;
  case "limits":
    if (state.limitsFail) fail("boat_timeout", "boat.dev didn't answer");
    print({ accessTier: state.accessTier ?? "trial", trialLine: "trialLine" in state ? state.trialLine : "2 boxes, 75 new/day, 25h of 25h compute left, auto-stop max 2h, no large or xlarge types", activeSandboxes: Object.values(state.sandboxes).filter((s) => s.state !== "stopped").length, maxActiveSandboxes: state.maxActive ?? 2, currentLimits: { activeSandboxes: state.maxActive ?? 2 }, canStart: state.checkoutRequired !== true, checkoutRequired: state.checkoutRequired === true, starts: { day: { remaining: 70, limit: 75 }, hour: { remaining: 20 } }, machineTypes: state.machineTypes ?? [{ type: "small", available: true, reason: null }, { type: "default", available: true, reason: null }, { type: "large", available: false, reason: "needs a paid plan" }, { type: "xlarge", available: false, reason: "needs the $100/month plan or higher" }] });
    break;
  case "list": {
    const all = rest.includes("--all");
    print({ pageInfo: {}, sandboxes: Object.values(state.sandboxes).filter((s) => all || s.state !== "stopped") });
    break;
  }
  case "info": {
    const sandbox = state.sandboxes[rest[0]];
    if (!sandbox) fail("not_found", "not found (404)", 404);
    print({ sandbox });
    break;
  }
  case "new": {
    const from = flag("--from");
    if (from && !from.startsWith("bsh_") && !(state.snapshots ?? []).some((snapshot) => snapshot.name === from)) {
      fail("snapshot_not_found", `No saved snapshot "${from}". Run boat snapshots to list yours and your org's.`, 404);
    }
    if (state.autoStopCapSeconds && Number(flag("--ttl")) > state.autoStopCapSeconds) {
      fail("trial_auto_stop_required", `Free-trial auto-stop is ${state.autoStopCapSeconds / 3600} hours maximum. Set a TTL of ${state.autoStopCapSeconds / 3600} hours or less, or end the trial (first payment) to lift it.`, 400);
    }
    const id = `bx_test${state.next++}`;
    state.sandboxes[id] = { id, name: flag("--name"), state: "idle", health: "ok", createdAt: new Date().toISOString(), ttlSeconds: Number(flag("--ttl")), from, type: flag("--type") ?? "default" };
    print({ event: "created", id });
    print({ event: "state", id, state: "ready" });
    print({ event: "ready", id, state: "ready", url: `https://${id}.on.boat.dev` });
    break;
  }
  case "exec": {
    const script = rest[rest.length - 1];
    if (rest.includes("--detach")) {
      (state.detached ??= []).push({ id: rest[0], command: script });
      print({ success: true, pid: 4242, processId: 4242, command: script });
      break;
    }
    if (script.includes("BOAT_MEM_PROBE")) {
      // The memory probe (src/memory.ts): the size of the sandbox's type, and state.probe's facts.
      const specs = { small: [2, 4065972], default: [4, 8131944], large: [8, 16263888], xlarge: [16, 32527776] };
      const [cpus, memTotal] = specs[state.sandboxes[rest[0]]?.type ?? "default"] ?? specs.default;
      const probe = { oomKills: 0, kernel: [], ...(state.probe ?? {}) };
      const lines = ["BOAT_MEM_PROBE 1", `NOW ${Math.floor(Date.now() / 1000)}`, "BOOT 0f3c1d2e-aaaa-bbbb-cccc-123456789abc 1700000000", `CPUS ${cpus}`, `MEM ${memTotal} ${Math.round(memTotal * 0.7)} 2097148 2097148`, `OOM ${probe.oomKills}`];
      if (script.includes("/tmp/boat-memory/")) lines.push(`PEAK ${probe.peak ?? "-"}`);
      if (script.includes("journalctl")) {
        lines.push("KLOG journal");
        for (const line of probe.kernel) lines.push(`K ${line}`);
      }
      lines.push("END");
      print({ exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" });
      break;
    }
    if (script.includes("BOAT_SHIP_DONE")) {
      (state.ships ??= []).push({ id: rest[0], script });
      // shipOutput: what the ship script printed (a conflict's detail, say).
      print({ exitCode: 0, stdout: state.shipOutput ?? (state.shipFail ? `BOAT_SHIP_ERROR 0 ${state.shipFail}\n` : "BOAT_SHIPPED 0 abcdef1234567890 2\nBOAT_SHIP_DONE\n"), stderr: "" });
      break;
    }
    if (script.includes("BOAT_SINCE")) {
      // "What changed since you approved" (src/ship-approval.ts).
      (state.compared ??= []).push({ id: rest[0], script });
      print({ exitCode: 0, stdout: state.since ?? "BOAT_SINCE none 0\n", stderr: "" });
      break;
    }
    if (script.includes("BOAT_LOGIN")) {
      print({ exitCode: 0, stdout: state.loginExpired ? "BOAT_LOGIN expired\n" : "BOAT_LOGIN ok\nBOAT_GH_EXPIRES 2099-01-01 00:00:00 UTC\n", stderr: "" });
      break;
    }
    const repo = /REPO='([^']+)'/.exec(script)?.[1] ?? "x/y";
    const branch = /BRANCH='([^']+)'/.exec(script)?.[1] ?? "main";
    // Access, as the prepare script's gh check would report it.
    const access = (state.access ?? {})[repo] ?? "ok true";
    const expires = state.ghExpires ?? "2099-01-01 00:00:00 UTC";
    if (access === "none" || access === "expired") {
      print({ exitCode: 4, stdout: `BOAT_ACCESS ${access}\nBOAT_GH_EXPIRES ${expires}\n`, stderr: "" });
      break;
    }
    print({ exitCode: 0, stdout: `BOAT_ACCESS ok push=${access.split(" ")[1]}\nBOAT_GH_EXPIRES ${expires}\nBOAT_SETUP path=/home/user/work/${repo.split("/")[1]} branch=${branch} base=main\n`, stderr: "" });
    break;
  }
  case "prompt": {
    const sandboxId = rest[0];
    const convo = flag("--resume");
    const promptId = `p${state.next++}`;
    state.convos[convo] = { sandboxId, running: true, promptId, provider: flag("--provider"), reply: null };
    state.sandboxes[sandboxId].state = "running";
    save();
    // Like boat: echo the requested model (the dashboard default otherwise).
    print({ event: "queued", data: { conversationId: convo, promptId, model: flag("--model") ?? "sonnet", provider: "claude-code" } });
    // Keep streaming like the real CLI; the plugin must not wait for this.
    setTimeout(() => process.exit(0), 30_000);
    break;
  }
  case "conversations":
    for (const [id, convo] of Object.entries(state.convos)) {
      if (convo.sandboxId === rest[0]) print({ event: "conversation", data: { id, running: convo.running, lastHarness: convo.provider, prompts: 1 } });
    }
    break;
  case "events": {
    const convo = state.convos[flag("--convo")];
    if (convo) {
      print({ event: "chat", data: { type: "prompt", taskId: convo.promptId, timestamp: 1, data: { status: convo.running ? "running" : "finished" } } });
      if (convo.reply) print({ event: "chat", data: { type: "response", taskId: convo.promptId, timestamp: 2, data: { content: convo.reply } } });
    }
    break;
  }
  case "delete":
    delete state.sandboxes[rest[0]];
    print({ operation: { status: "pending" } });
    break;
  case "stop":
    state.sandboxes[rest[0]].state = "stopped";
    print({ id: rest[0] });
    break;
  case "resume":
    state.sandboxes[rest[0]].state = "idle";
    // Like boat: --type moves it to another size; without it, it keeps its size.
    if (flag("--type")) state.sandboxes[rest[0]].type = flag("--type");
    print({ event: "ready", id: rest[0] });
    break;
  case "host": {
    const [id, port] = rest;
    (state.hosts ??= []).push({ id, port: Number(port), title: flag("--title") });
    print({ access: "private", isProtected: true, localhost: false, port: Number(port), sandboxId: id, title: flag("--title"), url: `https://${id}-${port}.on.boat.dev?_token=tok_${id}` });
    break;
  }
  case "extend": {
    const ttl = flag("--ttl") ?? (flag("--hours") === null ? null : String(Number(flag("--hours")) * 3600));
    if (state.autoStopCapSeconds && Number(ttl) > state.autoStopCapSeconds) {
      fail("trial_auto_stop_required", `Free-trial auto-stop is ${state.autoStopCapSeconds / 3600} hours maximum. Set a TTL of ${state.autoStopCapSeconds / 3600} hours or less, or end the trial (first payment) to lift it.`, 400);
    }
    (state.extended ??= []).push({ id: rest[0], ttl });
    print({ sandbox: { ...state.sandboxes[rest[0]], archiveAfter: new Date(Date.now() + Number(ttl ?? 3600) * 1000).toISOString() } });
    break;
  }
  case "snapshot": {
    if (state.snapshotsDisabled) fail("plan_required", "Saved snapshots are not available on the trial plan. Upgrade to save snapshots.", 402);
    const [id, name] = rest;
    (state.snapshots ??= []).push({ name, sizeBytes: 6414336, createdAt: new Date().toISOString(), sourceSandboxId: id, status: "ready", type: "small" });
    print({ event: "saving", name, sandboxId: id });
    print({ event: "saved", name, sizeBytes: 6414336 });
    break;
  }
  case "snapshots":
    if (state.snapshotsDisabled) fail("plan_required", "Saved snapshots are not available on the trial plan.", 402);
    print({ named: state.snapshots ?? [], namedAllowance: { included: 10, used: (state.snapshots ?? []).length } });
    break;
  case "env":
    if (rest[0] === "info") {
      print({
        environment: {
          name: rest[1],
          // Values the plugin must never show.
          envContents: "EXAMPLE_ACCOUNT_ID=fake_value_123\nexport EXAMPLE_SECRET_KEY=fake_value_456\n# a comment\n",
          secretFiles: [{ path: ".env.local" }],
          selectedRepositories: [{ fullName: "acme/storefront", permissions: "write", baseBranch: "master" }],
          passGithub: true,
          passSecrets: true,
          passAgentsCredentials: true,
          ...(state.boatCredentials === "unreported" ? {} : { passSandboxCredentials: state.boatCredentials === true }),
          proxyAiCredentials: false,
        },
      });
      break;
    }
    if (rest[0] !== "list") fail("unknown", `fake boat env ${rest[0]}`);
    print({
      environments: ["base", "storefront", "storefront-api", "docs"].map((name) => {
        const safe = name === "base" && state.safe === true;
        // boat passes its credentials by default; the fake starts with them off unless the state says so.
        const effective = { passAgentsCredentials: !safe, passGithub: !safe, passSecrets: !safe, passSandboxCredentials: !safe && state.boatCredentials === true };
        // "unreported": a boat that doesn't say.
        if (state.boatCredentials === "unreported") delete effective.passSandboxCredentials;
        return { name, isDefault: name === "base", credentialProfileId: null, safeForThirdParties: safe, effective, passGithub: true, passAgentsCredentials: true, envContents: "EXAMPLE_TOKEN=fake_value_123\n" };
      }),
    });
    break;
  case "interrupt":
  case "steer":
    print({ status: "ok" });
    break;
  default:
    fail("unknown", `fake boat does not know ${command}`);
}
if (command !== "prompt") save();
