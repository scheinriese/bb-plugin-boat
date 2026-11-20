// A stand-in for Instabox's REST API, for tests: the routes the plugin
// calls (exec, processes, activity leases, a machine's usage),
// on 127.0.0.1, with state in the same JSON file as fake-instabox.mjs. It
// checks the X-API-Key header and never stores the key or the stdin it gets:
// only whether they were there, and the request's other fields.
import { createServer } from "node:http";
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * Start the server. `key`: the key requests must carry. Returns its base URL,
 * what it received, and close().
 */
export async function startFakeInstaboxApi({ statePath, key }) {
  const received = [];
  const read = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { machines: {} });
  // The fake CLI's lock: a read and its write happen together, never across a CLI command.
  const locked = (fn) => {
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
    try {
      return fn();
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        // Already gone.
      }
    }
  };
  const write = (change) =>
    locked(() => {
      const state = read();
      change(state);
      const temporary = `${statePath}.api.tmp`;
      writeFileSync(temporary, JSON.stringify(state, null, 2));
      renameSync(temporary, statePath);
    });
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const state = read();
      const json = (status, value) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      const url = new URL(request.url ?? "/", "http://fake");
      const parsed = body ? JSON.parse(body) : null;
      // What arrived: never the key or stdin, only whether they were sent.
      received.push({
        method: request.method,
        path: url.pathname,
        query: url.search,
        keyOk: request.headers["x-api-key"] === key,
        accept: request.headers.accept ?? null,
        body: parsed === null ? null : { ...parsed, ...(parsed.stdin !== undefined ? { stdin: `[${String(parsed.stdin).length} chars]` } : {}) },
      });
      if (request.headers["x-api-key"] !== key) return json(401, { error: { code: "invalid_key", message: "the API key is not valid" } });
      if (state.fail === "down") return json(503, { error: { code: "host_unavailable", message: "upstream unavailable", retryable: true } });
      if (state.fail === "invite") return json(403, { error: { code: "invite_required", message: "an invite is required" } });
      const processes = url.pathname.match(/^\/v1\/machines\/([^/]+)\/processes$/);
      if (processes && request.method === "GET") {
        const machine = state.machines?.[decodeURIComponent(processes[1])];
        if (!machine || machine.state === "deleted") return json(404, { error: { code: "not_found", message: "no such machine" } });
        if (state.processRaw !== undefined) {
          response.writeHead(200, { "content-type": "application/json" });
          return response.end(state.processRaw);
        }
        return json(state.processStatus ?? 200, Object.hasOwn(state, "processSample") ? state.processSample : {
          machineId: machine.id, state: machine.state, live: machine.state === "running",
          capturedAt: new Date().toISOString(), trigger: machine.state === "running" ? "request" : "stop", truncated: false,
          processes: [{ pid: 1, ppid: 0, user: "root", cpuPercent: 0, memPercent: 0.1, elapsedSeconds: 60, command: "/sbin/launchd" }],
        });
      }
      const exec = url.pathname.match(/^\/v1\/machines\/([^/]+)\/exec$/);
      if (exec && request.method === "POST") {
        const machine = state.machines?.[decodeURIComponent(exec[1])];
        if (!machine || machine.state === "deleted") return json(404, { error: { code: "not_found", message: "no such machine" } });
        if (machine.state !== "running") return json(409, { error: { code: "machine_not_running", message: `it is ${machine.state}` } });
        const cmd = parsed?.cmd ?? "";
        if (cmd.includes("gh auth login") && parsed.stdin) write(fresh => { fresh.machines[machine.id].githubFileAuth = true; });
        if (cmd.includes("gh auth logout")) write(fresh => { delete fresh.machines[machine.id].githubFileAuth; });
        const timedOut = state.execTimesOut === true;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": ping\n\n");
        response.write(`event: stdout\ndata: ${JSON.stringify({ data: "installing bb\n" })}\n\n`);
        response.write(`event: stderr\ndata: ${JSON.stringify({ data: "a warning\n" })}\n\n`);
        response.end(`event: exit\ndata: ${JSON.stringify({ stdout: "", stderr: "", exitCode: timedOut ? 124 : (state.execExitCode ?? 0), timedOut, truncated: false })}\n\n`);
        return;
      }
      const lease = url.pathname.match(/^\/v1\/machines\/([^/]+)\/activity-leases\/([^/]+)$/);
      if (lease) {
        state.leases ??= {};
        const id = `${decodeURIComponent(lease[1])}:${decodeURIComponent(lease[2])}`;
        if (request.method === "PUT") {
          write((fresh) => {
            fresh.leases ??= {};
            fresh.leases[id] = { ttlSeconds: parsed?.ttlSeconds ?? 300 };
          });
          return json(200, { id: lease[2], machineId: lease[1], expiresAt: new Date(Date.now() + (parsed?.ttlSeconds ?? 300) * 1000).toISOString() });
        }
        if (request.method === "DELETE") {
          if (!(id in state.leases)) return json(404, { error: { code: "not_found", message: "no such lease" } });
          write((fresh) => {
            delete fresh.leases?.[id];
          });
          response.writeHead(204).end();
          return;
        }
      }
      const usage = url.pathname.match(/^\/v1\/machines\/([^/]+)\/usage$/);
      if (usage && request.method === "GET") {
        return json(200, { from: url.searchParams.get("from") ?? "2026-11-01T00:00:00Z", to: url.searchParams.get("to") ?? new Date().toISOString(), runningSeconds: 5400, vcpuSeconds: 21600, memGiBSeconds: 43200, diskGiBSeconds: 0, egressBytes: 0 });
      }
      json(404, { error: { code: "not_found", message: `no route ${request.method} ${url.pathname}` } });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    received,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
