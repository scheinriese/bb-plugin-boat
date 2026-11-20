// Instabox's REST API (https://api.instabox.sh/v1/openapi.json), for the
// things its CLI doesn't offer:
// - exec with `noHistory` and stdin, streamed (bb's setup: its enrollment
//   secret goes on stdin and its output names bb's server, so neither may
//   land in the machine's exec history, which keeps 64 KiB of each command);
// - activity leases, which keep a machine awake while a bb chat works there
//   (Instabox's idle check doesn't see bb's connection);
// - a machine's running time over a window (the usage view).
// - process-list provenance and completeness (CLI ps --json prints rows only).
// The key goes in the X-API-Key header only, never in a URL, a log or an error.
import { InstaboxError, num, rec, redactKeys, str, type JsonRecord } from "./cli.ts";
import type { ExecResult } from "../types.ts";

export const DEFAULT_API_URL = "https://api.instabox.sh";
/** The longest one exec may run (the API's cap). */
export const EXEC_MAX_SECONDS = 600;

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

export interface InstaboxRestOptions {
  /** The API key from bb's secret setting (null: none stored). */
  key: () => Promise<string | null>;
  /** Default: INSTABOX_API_URL (or INSTABOX_SERVER), else https://api.instabox.sh. */
  baseUrl?: () => string;
  /** Tests. */
  fetch?: FetchLike;
}

export function apiUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.INSTABOX_API_URL || env.INSTABOX_SERVER || DEFAULT_API_URL).replace(/\/+$/, "");
}

/** An answer's `{error: {code, message, status}}`, as an InstaboxError. */
export function errorFromBody(status: number, body: unknown): InstaboxError {
  const error = rec(rec(body)?.error) ?? rec(body) ?? {};
  return new InstaboxError(redactKeys(str(error.message) ?? `Instabox answered HTTP ${status}`), {
    code: str(error.code) ?? (status === 401 ? "unauthenticated" : status === 404 ? "not_found" : status >= 500 ? "host_unavailable" : "instabox_failed"),
    status: num(rec(body)?.status) ?? status,
    retryable: error.retryable === true || status >= 500 || status === 429,
  });
}

export class InstaboxRest {
  private readonly options: InstaboxRestOptions;

  constructor(options: InstaboxRestOptions) {
    this.options = options;
  }

  private async send(method: string, path: string, init: { body?: unknown; signal?: AbortSignal; accept?: string } = {}): Promise<Response> {
    const key = (await this.options.key())?.trim() ?? "";
    if (key === "") throw new InstaboxError("No Instabox API key is stored.", { code: "key_missing" });
    const base = this.options.baseUrl?.() ?? apiUrl();
    const doFetch: FetchLike = this.options.fetch ?? ((url, request) => fetch(url, request));
    const headers: Record<string, string> = { "X-API-Key": key, Accept: init.accept ?? "application/json" };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, { method, headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }), ...(init.signal ? { signal: init.signal } : {}) });
    } catch (error) {
      if (init.signal?.aborted) throw new InstaboxError("instabox call aborted", { code: "aborted" });
      // Down, or not reachable from here: say so, never "gone".
      throw new InstaboxError(`couldn't reach Instabox (${redactKeys(error instanceof Error ? error.message : String(error))})`, { code: "host_unavailable", retryable: true });
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: { message: text.trim().slice(0, 300) || `HTTP ${response.status}` } };
      }
      throw errorFromBody(response.status, body);
    }
    return response;
  }

  private async json(method: string, path: string, init: { body?: unknown; signal?: AbortSignal } = {}): Promise<JsonRecord> {
    const response = await this.send(method, path, init);
    const text = await response.text();
    if (text.trim() === "") return {};
    try {
      const value: unknown = JSON.parse(text);
      // A keepalive body is newlines, then the JSON: JSON.parse skips them; an error after the 200 is `{error, status}`.
      const record = rec(value) ?? {};
      if (rec(record.error) !== null && typeof record.status === "number") throw errorFromBody(record.status, record);
      return record;
    } catch (error) {
      if (error instanceof InstaboxError) throw error;
      throw new InstaboxError(`Instabox answered ${path} with something that isn't JSON`, { code: "instabox_bad_output" });
    }
  }

  /** Keep the ProcessList envelope: CLI ps drops live/capturedAt/truncated. */
  async processes(machineId: string, signal?: AbortSignal): Promise<JsonRecord> {
    return this.json("GET", `/v1/machines/${encodeURIComponent(machineId)}/processes`, { signal });
  }

  /**
   * Run a command over the exec API with `noHistory`: stdin in, output
   * streamed to onOutput as it comes (server-sent events), the result at the
   * end. Closing the stream (signal) kills the command. timeoutSeconds is
   * capped at the API's 600.
   */
  async execStream(
    machineId: string,
    request: { cmd: string; stdin?: string; timeoutSeconds: number; envs?: Record<string, string> },
    onOutput: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<ExecResult & { timedOut: boolean }> {
    const body = {
      cmd: request.cmd,
      ...(request.stdin ? { stdin: request.stdin } : {}),
      ...(request.envs ? { envs: request.envs } : {}),
      timeoutSeconds: Math.max(1, Math.min(EXEC_MAX_SECONDS, Math.round(request.timeoutSeconds))),
      noHistory: true,
    };
    const response = await this.send("POST", `/v1/machines/${encodeURIComponent(machineId)}/exec`, { body, signal, accept: "text/event-stream" });
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("text/event-stream")) {
      // A server that answered without streaming: one result.
      const text = await response.text();
      const result = rec(JSON.parse(text.trim() || "{}")) ?? {};
      const stdout = str(result.stdout) ?? "";
      const stderr = str(result.stderr) ?? "";
      if (stdout) onOutput(stdout);
      if (stderr) onOutput(stderr);
      return { exitCode: num(result.exitCode) ?? 1, stdout, stderr, timedOut: result.timedOut === true };
    }
    let stdout = "";
    let stderr = "";
    const reader = response.body?.getReader();
    if (reader === undefined) throw new InstaboxError("Instabox's exec stream had no body", { code: "instabox_bad_output" });
    const decoder = new TextDecoder();
    let buffer = "";
    const handle = (event: string, data: string): (ExecResult & { timedOut: boolean }) | null => {
      let payload: JsonRecord = {};
      try {
        payload = rec(JSON.parse(data)) ?? {};
      } catch {
        return null;
      }
      if (event === "stdout" || event === "stderr") {
        const chunk = str(payload.data) ?? "";
        if (event === "stdout") stdout += chunk;
        else stderr += chunk;
        if (chunk) onOutput(chunk);
        return null;
      }
      if (event === "exit") return { exitCode: num(payload.exitCode) ?? 1, stdout, stderr, timedOut: payload.timedOut === true };
      if (event === "error") throw errorFromBody(num(payload.status) ?? 503, payload);
      return null;
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.search(/\r?\n\r?\n/);
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
          let event = "message";
          const data: string[] = [];
          for (const line of block.split(/\r?\n/)) {
            if (line.startsWith(":")) continue; // a ping
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          }
          const result = data.length > 0 ? handle(event, data.join("\n")) : null;
          if (result !== null) return result;
          boundary = buffer.search(/\r?\n\r?\n/);
        }
        if (done) break;
      }
    } catch (error) {
      if (signal?.aborted) throw new InstaboxError("instabox call aborted", { code: "aborted" });
      if (error instanceof InstaboxError) throw error;
      throw new InstaboxError(`the connection to Instabox broke during the command (${error instanceof Error ? error.message : String(error)})`, { code: "host_unavailable" });
    } finally {
      reader.releaseLock();
    }
    throw new InstaboxError("Instabox's exec stream ended without a result", { code: "host_unavailable" });
  }

  /** Take or renew a task's activity lease (30–3600 s): the machine doesn't pause while it holds. */
  async lease(machineId: string, leaseId: string, ttlSeconds: number, signal?: AbortSignal): Promise<{ expiresAt: string | null }> {
    const ttl = Math.max(30, Math.min(3600, Math.round(ttlSeconds)));
    const record = await this.json("PUT", `/v1/machines/${encodeURIComponent(machineId)}/activity-leases/${encodeURIComponent(leaseId)}`, { body: { ttlSeconds: ttl }, signal });
    return { expiresAt: str(record.expiresAt) };
  }

  /** Release a lease (never wakes the machine); one that's gone already is fine. */
  async release(machineId: string, leaseId: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.send("DELETE", `/v1/machines/${encodeURIComponent(machineId)}/activity-leases/${encodeURIComponent(leaseId)}`, { signal });
    } catch (error) {
      if (error instanceof InstaboxError && (error.code === "not_found" || error.status === 404)) return;
      throw error;
    }
  }

  /** Use the provider's complete period when its OS data is sufficient;
   * otherwise report only the currently running Linux machines explicitly. */
  async linuxHours(knownLinux:ReadonlySet<string>, knownMac:ReadonlySet<string>, signal?:AbortSignal, runningLinux=knownLinux):Promise<{hours:number;scope:"period"|"running-machines"}|null> {
    let total=0,running=0,complete=true;
    for(let offset=0;offset<1000;offset+=100){
      const record=await this.json("GET",`/v1/usage/machines?limit=100&offset=${offset}`,{signal});
      if(!Array.isArray(record.machines) || num(record.total)===null)return null;
      for(const value of record.machines){
        const row=rec(value),id=str(row?.id),seconds=num(row?.runningSeconds);
        if(id && (knownMac.has(id) || row?.os==="macos" || row?.system==="macos"))continue;
        if(!id || seconds===null)return null;
        if(runningLinux.has(id))running+=seconds/3600;
        if(knownLinux.has(id) || row?.os==="linux" || row?.system==="linux")total+=seconds/3600;
        else complete=false;
      }
      if(offset+record.machines.length>=num(record.total)!)return {hours:complete ? total : running,scope:complete ? "period" : "running-machines"};
      if(record.machines.length===0)return null;
    }
    return null;
  }
  /** List-price compute for one machine, in a provider-rated window. */
  async computeCost(machineId: string, window: {since?:string;until?:string}, signal?: AbortSignal): Promise<number | null> {
    const query=new URLSearchParams({q:machineId,limit:"100"});
    if(window.since)query.set("from",window.since);
    if(window.until)query.set("to",window.until);
    const record=await this.json("GET",`/v1/usage/machines?${query}`,{signal});
    const rows=Array.isArray(record.machines) ? record.machines : [];
    return num(rec(rows.find(row=>rec(row)?.id===machineId))?.computeUSD);
  }
  /** A machine's running seconds over a window (default: this month). */
  async machineUsage(machineId: string, window: { since?: string; until?: string } = {}, signal?: AbortSignal): Promise<{ runningSeconds: number | null; from: string | null; to: string | null }> {
    const query = new URLSearchParams();
    if (window.since) query.set("from", window.since);
    if (window.until) query.set("to", window.until);
    const record = await this.json("GET", `/v1/machines/${encodeURIComponent(machineId)}/usage${query.size > 0 ? `?${query}` : ""}`, { signal });
    return { runningSeconds: num(record.runningSeconds), from: str(record.from), to: str(record.to) };
  }
}
