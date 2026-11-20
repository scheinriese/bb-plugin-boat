import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, chmod, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { shellQuote } from "../shell.ts";
import type { ExecResult } from "../types.ts";
import { fail } from "./api.ts";
import { z } from "zod";
export interface SshTarget { ip: string; user: string; key: string }
export interface SshRequest { command: string[]; stdin?: string; timeoutMs: number; signal?: AbortSignal; onOutput?: (chunk: string) => void }
export type SshExec = (target: SshTarget, request: SshRequest) => Promise<ExecResult>;
export const sshExec: SshExec = async (target, request) => {
  if (!/^[a-z_][a-z0-9_-]*$/i.test(target.user) || !/^[0-9a-f:.]+$/i.test(target.ip)) throw fail("Scaleway returned an invalid SSH address.");
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${target.key}.hosts`, "-i", target.key, "--", `${target.user}@${target.ip}`, request.command.map(shellQuote).join(" ")], { stdio: ["pipe", "pipe", "pipe"], signal: request.signal });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, request.timeoutMs);
    child.stdout.on("data", chunk => { const text = chunk.toString(); stdout = (stdout + text).slice(-1_048_576); request.onOutput?.(text); });
    child.stderr.on("data", chunk => { const text = chunk.toString(); stderr = (stderr + text).slice(-1_048_576); request.onOutput?.(text); });
    child.on("error", () => { clearTimeout(timer); reject(fail("Scaleway SSH could not start.", "host_unavailable")); });
    child.on("close", code => { clearTimeout(timer); resolve({ exitCode: code ?? 255, stdout, stderr }); });
    child.stdin.on("error", () => undefined);
    child.stdin.end(request.stdin ?? "");
  });
};
export interface KeyRecord { token: string; sshKeyId: string; serverId?: string; zone?: string; projectId?: string; prepared?: boolean }
/** Private keys and recovery metadata stay in the plugin data directory. */
export class ScalewayKeys {
  readonly dir: string;
  constructor(dir: string) { this.dir = dir; }
  path(token: string) { if (!/^[0-9a-f-]{36}$/.test(token)) throw fail("Invalid Scaleway key reference."); return join(this.dir, token); }
  async generate(): Promise<{ token: string; publicKey: string }> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 }); await chmod(this.dir, 0o700);
    const token = randomUUID(), path = this.path(token);
    await new Promise<void>((resolve, reject) => { const child = spawn("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "bb-boat", "-f", path], { stdio: "ignore" }); child.on("error", () => reject(fail("Could not generate the Scaleway SSH key."))); child.on("close", code => code === 0 ? resolve() : reject(fail("Could not generate the Scaleway SSH key."))); });
    await chmod(path, 0o600);
    return { token, publicKey: (await readFile(`${path}.pub`, "utf8")).trim() };
  }
  async save(record: KeyRecord) { await writeFile(`${this.path(record.token)}.json`, JSON.stringify(record), { mode: 0o600 }); }
  async load(token: string): Promise<KeyRecord> { try { return z.object({ token: z.string().uuid(), sshKeyId: z.string().uuid(), serverId: z.string().uuid().optional(), zone: z.enum(["fr-par-1", "fr-par-3"]).optional(), projectId: z.string().uuid().optional(), prepared: z.boolean().optional() }).parse(JSON.parse(await readFile(`${this.path(token)}.json`, "utf8"))); } catch { throw fail("The Scaleway machine's SSH key is missing from this plugin's data directory.", "key_missing"); } }
  async records(): Promise<KeyRecord[]> {
    const files = await readdir(this.dir).catch(() => [] as string[]);
    return Promise.all(files.filter(file => /^[0-9a-f-]{36}\.json$/.test(file)).map(file => this.load(file.slice(0,-5))));
  }
  async remove(token: string) { for (const suffix of ["", ".pub", ".json", ".hosts"]) await rm(`${this.path(token)}${suffix}`, { force: true }); }
}
