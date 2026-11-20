import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { unavailableProvider } from "../registry.ts";
import { isNotFound, type SandboxProvider, type SandboxInfo, type MacModel, type MachineSpec } from "../types.ts";
import type { MacLeaseLedger } from "../../mac-leases.ts";
import { SIZE_SPECS } from "../../memory.ts";
import { shellQuote } from "../shell.ts";
import { ScalewayApi, serverSchema, typeSchema, productSchema, quotaSchema, fail, type Server } from "./api.ts";
import { ScalewayKeys, sshExec, type SshExec, type SshRequest } from "./ssh.ts";
/** Task reservations exposed through the provider interface. Hardware models
 * and prices remain live; aliases follow Boat's existing task size choices. */
export const SCALEWAY_TASK_SIZES = Object.entries(SIZE_SPECS).map(([id, spec]) => ({ id: id as "small" | "default" | "large" | "xlarge", label: spec.label, cpus: spec.cpus, memoryGb: spec.memoryGb }));
export const SCALEWAY_ID_PATTERN = /^scw_(fr-par-[13])_([0-9a-f-]{36})$/;
const NAME_PREFIX = "bb-boat-";
const nameToken = (name: string) => /^bb-boat-([0-9a-f-]{36})$/.exec(name)?.[1] ?? null;
const uuid = (id: string) => { const match = SCALEWAY_ID_PATTERN.exec(id); if (!match) throw fail("Invalid Scaleway machine ID."); return match[2]!; };
const machine: MachineSpec = {
  id: "scaleway-sandbox", displayName: "Scaleway Mac", description: "A Paris Apple silicon Mac for bb task chats", icon: "ComputerCloud",
  // New rentals are dispatched tasks only; no general-purpose picker rental.
  environments: [], machineName: key => `bb-machine-${key.replace(/[^a-z0-9-]/gi, "").slice(0, 32)}`,
  machineLabel: id => `Scaleway ${id}`, words: {
    invalidInputs: "Choose a supported Scaleway Mac size.", usingPrepared: "Using the prepared Scaleway Mac", creating: "Creating the Scaleway Mac", resuming: "Reconnecting to the Scaleway Mac",
    created: id => `Scaleway Mac ${id}`, gone: id => `Scaleway Mac ${id} no longer exists`, stopSaid: reason => `Scaleway: ${reason}`, notStopped: why => `Scaleway Mac kept: ${why}`, stillRestoring: detail => `Scaleway Mac is starting${detail}`,
  },
};
/** Install in the user's home: no admin password, shell history or API key. bb's
 * own enrollment/bootstrap follows over the same stdin-capable SSH executor. */
export const BOOTSTRAP = `set -eu
export PATH="$HOME/.local/bin:$PATH"
mkdir -p "$HOME/.local/bin"
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  tmp=$(mktemp -d)
  curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$tmp/sums"
  file=$(awk '$2 ~ /darwin-arm64.tar.gz$/ {print $2; exit}' "$tmp/sums")
  test -n "$file"
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$file" -o "$tmp/$file"
  (cd "$tmp"; awk -v file="$file" '$2 == file' sums | shasum -a 256 -c -)
  tar -xzf "$tmp/$file" -C "$HOME/.local" --strip-components=1
  rm -rf "$tmp"
fi
if ! command -v claude >/dev/null 2>&1 || ! command -v codex >/dev/null 2>&1; then
  npm install --global --prefix "$HOME/.local" @anthropic-ai/claude-code @openai/codex
fi
if ! command -v gh >/dev/null 2>&1; then
  tmp=$(mktemp -d)
  curl -fsSL https://api.github.com/repos/cli/cli/releases/latest -o "$tmp/release.json"
  url=$(node -e 'const r=require(process.argv[1]); console.log(r.assets.find(a=>a.name.endsWith("macOS_arm64.zip")).browser_download_url)' "$tmp/release.json")
  curl -fsSL "$url" -o "$tmp/gh.zip"
  unzip -q "$tmp/gh.zip" -d "$tmp/gh"
  find "$tmp/gh" -type f -name gh -exec cp {} "$HOME/.local/bin/gh" \\;
  rm -rf "$tmp"
fi
case "$(cat "$HOME/.bash_profile" 2>/dev/null || true)" in *'.local/bin'*) ;; *) printf '\\nexport PATH="$HOME/.local/bin:$PATH"\\n' >> "$HOME/.bash_profile" ;; esac
mkdir -p "$HOME/.boat-hooks"
git config --global core.hooksPath "$HOME/.boat-hooks"
`;
export function createScalewayProvider(options: { api: ScalewayApi; keys: ScalewayKeys; ledger: MacLeaseLedger; ssh?: SshExec; pollMs?: number; readyTimeoutMs?: number }): SandboxProvider {
  const { api, keys, ledger } = options;
  const ssh = options.ssh ?? sshExec;
  // Only the short allocation phase owns this lock. Account-wide reads can
  // run outside Boat's placement lock, but cannot clear a pending POST's key.
  let allocationLock: Promise<unknown> = Promise.resolve();
  function withAllocationLock<T>(run: () => Promise<T>): Promise<T> {
    const next = allocationLock.then(run, run);
    allocationLock = next.catch(() => undefined);
    return next;
  }
  const caps: SandboxProvider["caps"] = { os: "macos", systems: [], shell: "bash", homeDir: "~", execMaxSeconds: 3600, stopKeepsDisk: true, retentionAfterStopSeconds: null, environments: false, autoStop: null, agentBusyState: false, previews: "token-link", bbEnrollment: true, headlessAgentRunner: false, concurrencyUnit: "kept-sandboxes" };
  const unsupported = async (): Promise<never> => { throw fail("Scaleway Macs run tasks as bb chats. This operation is not available.", "unsupported"); };
  async function models(signal?: AbortSignal, stockOnly = false): Promise<MacModel[]> {
    caps.systems = [];
    const { zone } = await api.config();
    const types = await api.parse(z.object({ server_types: z.array(typeSchema) }), "GET", `${await api.base()}/server-types`, undefined, signal);
    const products = await api.pages(`/product-catalog/v2alpha1/public-catalog/products?product_types=apple_silicon&zone=${zone}`, "products", productSchema, signal);
    const result = types.server_types.flatMap(type => {
      if (type.default_os.is_beta || /asahi|linux/i.test(type.name + type.default_os.name) || (stockOnly && !["low_stock", "high_stock"].includes(type.stock))) return [];
      const price = products.find(p => p.locality.zone === zone && ["general_availability", "public_beta"].includes(p.status) && p.properties.apple_silicon?.server_type === type.name && p.unit_of_measure.unit === "hour" && p.unit_of_measure.size === 1 && p.price.retail_price.currency_code === "EUR")?.price.retail_price;
      if (!price || price.units + price.nanos / 1e9 <= 0) return [];
      return [{ id: type.name, label: type.name, cpus: type.cpu.core_count, memoryMiB: type.memory.capacity / 1048576, minimumCost: (price.units + price.nanos / 1e9) * 24, minimumHours: 24, hourPrice: price.units + price.nanos / 1e9, currency: "EUR" }];
    }).sort((a,b) => a.minimumCost-b.minimumCost);
    if (result.length) caps.systems = ["macos"];
    return result;
  }
  async function servers(signal?: AbortSignal, organization = false) {
    const { projectId } = await api.config();
    const project = await api.parse(z.object({ organization_id: z.string() }), "GET", `/account/v3/projects/${projectId}`, undefined, signal);
    const query = organization ? `organization_id=${encodeURIComponent(project.organization_id)}` : `project_id=${projectId}`;
    return { project, servers: await api.pages(`${await api.base()}/servers?${query}`, "servers", serverSchema, signal) };
  }
  async function available(signal?: AbortSignal) {
    const { zone } = await api.config();
    const catalog = await models(signal, true);
    const listed = await servers(signal, true);
    const quota = await api.pages(`/iam/v1alpha1/quota?organization_id=${encodeURIComponent(listed.project.organization_id)}`, "quota", quotaSchema, signal);
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    return { ...listed, choices: catalog.map(model => {
      const q = quota.find(q => normalize(q.name).includes("applesilicon") && normalize(q.name).endsWith(normalize(model.id)));
      const limit = q?.limits.find(l => l.zone === zone) ?? q?.limits.find(l => l.global || l.region === "fr-par") ?? q;
      const max = limit?.unlimited ? null : limit?.limit;
      const used = listed.servers.filter(s => s.type === model.id).length;
      return { model, max, used, ready: max === null || (max !== undefined && used < max) };
    }) };
  }
  async function raw(id: string, signal?: AbortSignal) {
    const serverId = uuid(id);
    const zone = SCALEWAY_ID_PATTERN.exec(id)![1]!;
    return api.parse(serverSchema, "GET", `/apple-silicon/v1alpha1/zones/${zone}/servers/${serverId}`, undefined, signal);
  }
  async function keyFor(server: Server) {
    const records = await keys.records();
    const recorded = records.find(record => record.serverId === server.id);
    if (recorded) return recorded;
    const token = nameToken(server.name);
    if (!token) return null;
    const record = records.find(record => record.token === token && !record.serverId);
    if (!record) return null;
    const bound = { ...record, serverId: server.id, zone: server.zone, projectId: server.project_id };
    await keys.save(bound);
    return bound;
  }
  async function run(server: Server, request: SshRequest) {
    const record = await keyFor(server);
    if (!record) throw fail("This Scaleway Mac has no recorded Boat SSH key.", "key_missing");
    return ssh({ ip: server.ip, user: server.ssh_username, key: keys.path(record.token) }, { ...request, command: ["bash", "-lc", request.command.map(shellQuote).join(" ")] });
  }
  async function view(server: Server, signal?: AbortSignal): Promise<SandboxInfo> {
    const id = `scw_${server.zone}_${server.id}`;
    const record = await keyFor(server);
    let lease = ledger.held(id)[0];
    if (!record && !lease) throw fail("This Scaleway server has no local ownership record. It is an orphan and will not be managed automatically.", "unmanaged_server");
    if (!lease && record) {
      const model = (await models(signal)).find(m => m.id === server.type);
      if (!model) throw fail("Scaleway Mac pricing could not be confirmed.", "lease_unknown");
      lease = ledger.record({ id: `scaleway:${server.id}`, provider: "scaleway", machineId: id, size: model.id, startedAt: server.created_at, paidUntil: server.deletable_at, minimumCost: model.minimumCost, hourPrice: model.hourPrice, billingIncrementSeconds: 3600, currency: "EUR", cpus: model.cpus, memoryMiB: model.memoryMiB });
    }
    return { id, name: server.name, system: "macos", scheduledReleaseAt: server.deletion_scheduled ? server.deletable_at : null, state: server.status === "ready" && server.delivered ? "idle" : server.status === "error" || server.status === "locked" ? "error" : "starting", health: null, url: null, desktopUrl: null, environment: null, createdAt: server.created_at, archiveAfter: null, stoppedAt: null, setupStatus: null, error: null };
  }
  async function forgetKey(record: Awaited<ReturnType<ScalewayKeys["load"]>>, signal?: AbortSignal) {
    await api.request("DELETE", `/iam/v1alpha1/ssh-keys/${record.sshKeyId}`, undefined, signal).catch(error => { if (!isNotFound(error)) throw error; });
    await keys.remove(record.token);
  }
  async function managedServers(signal?: AbortSignal) {
    const config = await api.config();
    const records = await keys.records();
    const scopes = new Map<string,{zone:string;projectId:string}>();
    for (const scope of [config,...records.map(record => ({zone:record.zone ?? config.zone,projectId:record.projectId ?? config.projectId}))]) scopes.set(`${scope.zone}:${scope.projectId}`,scope);
    const all: Server[] = [];
    // Every page in the recorded project/zone must succeed before absence can
    // clear an unresolved POST. A failed list never deletes recovery records.
    for (const scope of scopes.values()) all.push(...await api.pages(`/apple-silicon/v1alpha1/zones/${scope.zone}/servers?project_id=${scope.projectId}`,"servers",serverSchema,signal));
    let recovered = 0, cleared = 0;
    for (const record of records) {
      let found = all.find(server => server.id === record.serverId || (!record.serverId && server.name === `${NAME_PREFIX}${record.token}`));
      if (!found && record.serverId && record.zone) {
        try { found = await raw(`scw_${record.zone}_${record.serverId}`,signal); all.push(found); }
        catch (error) { if (!isNotFound(error)) throw error; }
      }
      if (found) { if (!record.serverId) { await keyFor(found); recovered++; } }
      else { await forgetKey(record,signal); cleared++; }
    }
    const ids = new Set(records.map(record => record.serverId).filter(Boolean));
    const names = new Set(records.filter(record => !record.serverId).map(record => `${NAME_PREFIX}${record.token}`));
    const unique = [...new Map(all.map(server=>[server.id,server])).values()];
    const managed = unique.filter(server => ids.has(server.id) || names.has(server.name) || ledger.held(`scw_${server.zone}_${server.id}`).length);
    const managedIds = new Set(managed.map(server=>server.id));
    const orphans = unique.filter(server=>server.name.startsWith(NAME_PREFIX) && !managedIds.has(server.id))
      .map(server=>({id:`scw_${server.zone}_${server.id}`,name:server.name}));
    return { servers: managed, orphans, recovered, cleared };
  }
  async function prepare(id: string, signal?: AbortSignal): Promise<SandboxInfo> {
    let server: Server;
    const zone = SCALEWAY_ID_PATTERN.exec(id)?.[1];
    const serverId = uuid(id);
    const deadline = Date.now() + (options.readyTimeoutMs ?? 30*60_000);
    try {
      server = await raw(id,signal);
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        server = await raw(id,signal);
        if (["error", "locked"].includes(server.status)) throw fail("Scaleway Mac provisioning failed.");
        if (server.status === "ready" && server.delivered && server.ip) {
          try {
            const probe = await run(server, { command: ["bash", "-lc", "true"], timeoutMs: 20_000, signal });
            if (probe.exitCode === 0) {
              const setup = await run(server, { command: ["bash", "-s"], stdin: BOOTSTRAP, timeoutMs: 15*60_000, signal });
              if (setup.exitCode !== 0) throw fail("Scaleway Mac tooling installation failed.", "bootstrap_failed");
              const record = await keyFor(server);
              if (record) await keys.save({...record,prepared:true});
              return view(server,signal);
            }
          } catch (error) { if ((error as {code?:string}).code !== "host_unavailable") throw error; }
        }
        await delay(options.pollMs ?? 10_000, undefined, { signal });
      }
      throw fail("Scaleway Mac did not become SSH-ready in time.");
    } catch {
      if (ledger.held(id).some(lease=>lease.kept)) throw fail("Scaleway Mac setup was interrupted; this lease is explicitly kept and automatic deletion is off.","creation_allocated");
      try { await api.request("PATCH", `/apple-silicon/v1alpha1/zones/${zone}/servers/${serverId}`, { schedule_deletion: true }); }
      catch { throw fail("Scaleway allocated a Mac but setup failed, and automatic deletion could not be scheduled. The lease is tracked; delete it manually after its minimum.", "creation_allocated"); }
      throw fail("Scaleway allocated a Mac but setup failed. Deletion is scheduled after its minimum; its lease remains tracked.", "creation_allocated");
    }
  }
  const provider: SandboxProvider = {
    ...unavailableProvider("scaleway"), id: "scaleway", displayName: "Scaleway", caps, idPattern: SCALEWAY_ID_PATTERN, machine,
    classifiesCreateErrors: true,
    sizes: SCALEWAY_TASK_SIZES,
    macModels: signal => models(signal),
    async pricing(signal) { const list = await models(signal); return list.map(m => `${m.label} EUR ${(m.hourPrice).toFixed(2)}/h · EUR ${m.minimumCost.toFixed(2)} minimum (24 h)`).join("; ") || null; },
    async capacity(signal) {
      const { servers, choices } = await available(signal);
      const canStart = choices.some(c => c.ready);
      return { tier: "Apple silicon · hourly", summary: "24 h minimum, then hourly; billed until deleted", activeSandboxes: servers.length, maxActiveSandboxes: choices.some(c => c.max === null) ? null : servers.length + choices.reduce((n,c) => n+Math.max(0,(c.max ?? 0)-c.used),0), startsLeftToday: null, startsLeftThisHour: null, canStart, blockedReason: canStart ? null : "Scaleway Mac stock or quota is unavailable.", checkoutRequired: false, autoStopCapHours: null };
    },
    usagePlan: async () => null, usage: async () => ({ seconds: null, hours: null, dollars: null, since: null, until: null, running: null }),
    list: ({ signal } = {}) => withAllocationLock(async () => { const listed = await managedServers(signal); return Promise.all(listed.servers.map(server=>view(server,signal))); }),
    orphans: signal => withAllocationLock(async () => (await managedServers(signal)).orphans),
    recoverCreations: signal => withAllocationLock(async () => {
      const result = await managedServers(signal);
      for (const server of result.servers) await view(server,signal);
      return { recovered: result.recovered, cleared: result.cleared };
    }),
    async info(id, signal) { return view(await raw(id,signal),signal); },
    async findInfo(id, signal) { try { return await provider.info(id,signal); } catch (error) { if (isNotFound(error)) return null; throw error; } },
    async assertTaskReady({ agent, repos, sandboxId, signal }) {
      if (!sandboxId) throw fail("Scaleway task credentials are not configured. Boat will not rent a Mac without a supported agent login and GitHub authentication path. Use Instabox, or a held Mac with verified logins.", "task_credentials_missing");
      const command = agent === "claude" ? "claude auth status" : "codex login status";
      const server = await raw(sandboxId,signal);
      if ((await run(server,{command:["bash","-lc",`${command} >/dev/null 2>&1`],timeoutMs:30_000,signal})).exitCode !== 0) throw fail("The held Scaleway Mac has no verified agent login.","task_credentials_missing");
      if (repos.length && (await run(server,{command:["bash","-lc","gh auth status >/dev/null 2>&1"],timeoutMs:30_000,signal})).exitCode !== 0) throw fail("The held Scaleway Mac has no verified GitHub login for repository tasks.","task_credentials_missing");
    },
    allocate: input => withAllocationLock(async () => {
      if (input.system !== "macos" || input.snapshot) throw fail("Scaleway supports new Mac task leases only.", "unsupported");
      const recovery = await managedServers(input.signal);
      if (recovery.recovered) { for (const server of recovery.servers) await view(server,input.signal); throw fail("Recovered an earlier Scaleway allocation. Reuse its tracked lease before renting another Mac.","creation_allocated"); }
      const recorded = await keys.records();
      if (recovery.servers.some(server=>!recorded.find(record=>record.serverId===server.id)?.prepared)) throw fail("A Scaleway allocation is still awaiting setup. Reconcile or prepare its tracked lease before renting another Mac.","creation_allocated");
      const { choices } = await available(input.signal);
      const need = SCALEWAY_TASK_SIZES.find(size => size.id === (input.type ?? "default"))!;
      const choice = choices.find(c => c.ready && c.model.cpus >= need.cpus && c.model.memoryMiB >= need.memoryGb*1024);
      if (!choice) throw fail("Scaleway has no Mac with enough stock, quota and room.", "at_capacity");
      const generated = await keys.generate();
      let sshKeyId: string | null = null;
      let allocated = false;
      try {
        const { projectId, zone } = await api.config();
        const key = await api.parse(z.object({ id: z.string().uuid() }), "POST", "/iam/v1alpha1/ssh-keys", { name: `${NAME_PREFIX}${generated.token}`, project_id: projectId, public_key: generated.publicKey }, input.signal);
        sshKeyId = key.id;
        await keys.save({ token: generated.token, sshKeyId, zone, projectId });
        const types = await api.parse(z.object({ server_types: z.array(typeSchema) }), "GET", `${await api.base()}/server-types`, undefined, input.signal);
        const os = types.server_types.find(t => t.name === choice.model.id)!.default_os.id;
        const server = await api.parse(serverSchema, "POST", `${await api.base()}/servers`, { project_id: projectId, name: `${NAME_PREFIX}${generated.token}`, type: choice.model.id, os_id: os, commitment_type: "duration_24h", enable_vpc: false }, input.signal);
        allocated = true;
        await keys.save({ token: generated.token, sshKeyId, serverId: server.id, zone, projectId });
        const id = `scw_${zone}_${server.id}`;
        ledger.record({ id: `scaleway:${server.id}`, provider: "scaleway", machineId: id, size: choice.model.id, startedAt: server.created_at, paidUntil: server.deletable_at, minimumCost: choice.model.minimumCost, hourPrice: choice.model.hourPrice, billingIncrementSeconds: 3600, currency: "EUR", cpus: choice.model.cpus, memoryMiB: choice.model.memoryMiB });
        return view(server,input.signal);
      } catch (error) {
        if (allocated) throw fail("Scaleway allocated a Mac but local lease registration failed. Recovery files are preserved; reconcile before retrying.","creation_allocated");
        if ((error as { code?: string }).code !== "creation_unknown") {
          if (sshKeyId) await api.request("DELETE", `/iam/v1alpha1/ssh-keys/${sshKeyId}`).catch(() => undefined);
          await keys.remove(generated.token);
        }
        throw error;
      }
    }),
    waitReady: prepare,
    async create(input) { const server = await provider.allocate!(input); return prepare(server.id,input.signal); },
    async delete(id, signal, endOptions) {
      let server: Server;
      try { server = await raw(id,signal); } catch (error) { if (!isNotFound(error)) throw error; return; }
      await view(server,signal); // Require a local key/lease record before deleting.
      if (Date.now() < Date.parse(server.deletable_at)) throw fail("Scaleway cannot release this Mac before its 24 h minimum ends.", "minimum_lease");
      await api.request("DELETE", `/apple-silicon/v1alpha1/zones/${server.zone}/servers/${server.id}`, undefined, signal);
      const record = await keyFor(server);
      if (record) await forgetKey(record,signal);
      for (const lease of ledger.held(id)) ledger.end(lease.id,endOptions?.leaseEndReason ?? "deleted",endOptions?.leaseEndAt);
    },
    async scheduleLeaseRelease(id, at, signal) {
      const server = await raw(id,signal);
      await view(server,signal);
      if (Date.parse(at) !== Date.parse(server.deletable_at)) throw fail("Scaleway only schedules deletion at its minimum boundary.", "minimum_lease");
      await api.request("PATCH", `/apple-silicon/v1alpha1/zones/${server.zone}/servers/${server.id}`, { schedule_deletion: true }, signal);
    },
    async cancelLeaseRelease(id, signal) {
      const server = await raw(id,signal);
      await view(server,signal);
      await api.request("PATCH", `/apple-silicon/v1alpha1/zones/${server.zone}/servers/${server.id}`, { schedule_deletion: false }, signal);
    },
    // A suspend releases no money and must not shut down a shared Mac. Keep
    // it up for later task attachment; only the ledger's hand-back deletes it.
    async stop() { return { status: "completed", stopId: null, forced: false, error: null }; },
    stopStatus: async () => ({ status: "completed", stopId: null, forced: false, error: null }),
    resume: async (id, options) => { await provider.info(id,options?.signal); }, extend: unsupported,
    async exec(id, script, options) { return run(await raw(id,options?.signal), { command: ["bash", options?.login === false ? "-c" : "-lc", script], timeoutMs: options?.timeoutMs ?? 60_000, signal: options?.signal }); },
    async execDetached(id, script, signal) { const result = await provider.exec(id, `nohup bash -lc ${shellQuote(script)} </dev/null >/dev/null 2>&1 & echo $!`, { signal }); return { pid: Number(result.stdout.trim()) || null }; },
    machineHooks: () => ({ beforeBootstrap: async (id, signal) => {
      const result = await run(await raw(id,signal), { command: ["bash", "-s"], stdin: BOOTSTRAP, timeoutMs: 15*60_000, signal });
      if (result.exitCode !== 0) throw fail("Scaleway Mac tooling installation failed.", "bootstrap_failed");
    } }),
    executor: id => ({ async exec(request) { const result = await run(await raw(id,request.signal), request); return { exitCode: result.exitCode }; } }),
    processes: unsupported, host: unsupported, fork: unsupported, snapshot: unsupported, lastSnapshotAt: async () => null, snapshots: async () => ({ snapshots: [], included: null, used: null }), environments: async () => [], defaultEnvironment: async () => null, environmentInfo: unsupported, aiProxy: async () => ({ enabled: false, dailyDollars: null, dollarsPer1000Requests: null }), prompt: unsupported, events: unsupported, conversations: async () => [], steer: unsupported, interrupt: unsupported,
  };
  return provider;
}
