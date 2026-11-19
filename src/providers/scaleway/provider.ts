import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { unavailableProvider } from "../registry.ts";
import { isNotFound, type SandboxProvider, type SandboxInfo, type MacModel, type MachineSpec } from "../types.ts";
import type { MacLeaseLedger } from "../../mac-leases.ts";
import { LEASE_DAY_MS } from "../../mac-leases.ts";
import { SIZE_SPECS } from "../../memory.ts";
import { shellQuote } from "../shell.ts";
import { ScalewayApi, serverSchema, typeSchema, productSchema, quotaSchema, fail, type Server } from "./api.ts";
import { ScalewayKeys, sshExec, type SshExec, type SshRequest } from "./ssh.ts";
/** Task reservations exposed through the provider interface. Hardware models
 * and prices remain live; aliases follow Boat's existing task size choices. */
export const SCALEWAY_TASK_SIZES = Object.entries(SIZE_SPECS).map(([id, spec]) => ({ id: id as "small" | "default" | "large" | "xlarge", label: spec.label, cpus: spec.cpus, memoryGb: spec.memoryGb }));
export const SCALEWAY_ID_PATTERN = /^scw_(fr-par-[13])_([0-9a-f-]{36})$/;
const TAG = "bb-boat-key:";
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
  const caps: SandboxProvider["caps"] = { os: "macos", systems: [], shell: "bash", homeDir: posix.join("/", "Users", "m1"), execMaxSeconds: 3600, stopKeepsDisk: true, retentionAfterStopSeconds: null, environments: false, autoStop: null, agentBusyState: false, previews: "token-link", bbEnrollment: true, concurrencyUnit: "kept-sandboxes" };
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
  async function run(server: Server, request: SshRequest) {
    const token = server.tags.find(t => t.startsWith(TAG))?.slice(TAG.length);
    if (!token) throw fail("This Scaleway Mac has no Boat SSH key.", "key_missing");
    await keys.load(token);
    return ssh({ ip: server.ip, user: server.ssh_username, key: keys.path(token) }, { ...request, command: ["bash", "-lc", request.command.map(shellQuote).join(" ")] });
  }
  async function view(server: Server, signal?: AbortSignal): Promise<SandboxInfo> {
    const id = `scw_${server.zone}_${server.id}`;
    const token = server.tags.find(t => t.startsWith(TAG))?.slice(TAG.length);
    if (token) {
      const record = await keys.load(token);
      if (!record.serverId) await keys.save({ ...record, serverId: server.id, zone: server.zone, projectId: server.project_id });
    }
    let lease = ledger.held(id)[0];
    if (!lease && server.tags.some(t => t.startsWith(TAG))) {
      const model = (await models(signal)).find(m => m.id === server.type);
      if (!model) throw fail("Scaleway Mac pricing could not be confirmed.", "lease_unknown");
      lease = ledger.record({ id: `scaleway:${server.id}`, provider: "scaleway", machineId: id, size: model.id, startedAt: server.created_at, paidUntil: server.deletable_at, minimumCost: model.minimumCost, hourPrice: model.hourPrice, billingIncrementSeconds: 3600, currency: "EUR", cpus: model.cpus, memoryMiB: model.memoryMiB });
    }
    return { id, name: server.name, system: "macos", scheduledReleaseAt: server.deletion_scheduled ? server.deletable_at : null, state: server.status === "ready" && server.delivered ? "idle" : server.status === "error" || server.status === "locked" ? "error" : "starting", health: null, url: null, desktopUrl: null, environment: null, createdAt: server.created_at, archiveAfter: null, stoppedAt: null, setupStatus: null, error: null };
  }
  const provider: SandboxProvider = {
    ...unavailableProvider("scaleway"), id: "scaleway", displayName: "Scaleway", caps, idPattern: SCALEWAY_ID_PATTERN, machine,
    sizes: SCALEWAY_TASK_SIZES,
    macModels: signal => models(signal),
    async pricing(signal) { const list = await models(signal); return list.map(m => `${m.label} EUR ${(m.hourPrice).toFixed(2)}/h · EUR ${m.minimumCost.toFixed(2)} minimum (24 h)`).join("; ") || null; },
    async capacity(signal) {
      const { servers, choices } = await available(signal);
      const canStart = choices.some(c => c.ready);
      return { tier: "Apple silicon · hourly", summary: "24 h minimum, then hourly; billed until deleted", activeSandboxes: servers.length, maxActiveSandboxes: choices.some(c => c.max === null) ? null : servers.length + choices.reduce((n,c) => n+Math.max(0,(c.max ?? 0)-c.used),0), startsLeftToday: null, startsLeftThisHour: null, canStart, blockedReason: canStart ? null : "Scaleway Mac stock or quota is unavailable.", checkoutRequired: false, autoStopCapHours: null };
    },
    usagePlan: async () => null, usage: async () => ({ seconds: null, hours: null, dollars: null, since: null, until: null, running: null }),
    async list({ signal } = {}) { const listed = await servers(signal);
      for (const record of await keys.records()) if (record.serverId && record.zone && !listed.servers.some(s => s.id === record.serverId)) {
        try { listed.servers.push(await raw(`scw_${record.zone}_${record.serverId}`, signal)); continue; }
        catch (error) { if (!isNotFound(error)) throw error; }
        await api.request("DELETE", `/iam/v1alpha1/ssh-keys/${record.sshKeyId}`, undefined, signal).catch(error => { if (!isNotFound(error)) throw error; });
        await keys.remove(record.token);
      }
      return Promise.all(listed.servers.filter(s => s.tags.some(t => t.startsWith(TAG))).map(s => view(s,signal))); },
    async info(id, signal) { return view(await raw(id,signal),signal); },
    async findInfo(id, signal) { try { return await provider.info(id,signal); } catch (error) { if (isNotFound(error)) return null; throw error; } },
    async create(input) {
      if (input.system !== "macos" || input.snapshot) throw fail("Scaleway supports new Mac task leases only.", "unsupported");
      const { choices } = await available(input.signal);
      const need = SCALEWAY_TASK_SIZES.find(size => size.id === (input.type ?? "default"))!;
      const choice = choices.find(c => c.ready && c.model.cpus >= need.cpus && c.model.memoryMiB >= need.memoryGb*1024);
      if (!choice) throw fail("Scaleway has no Mac with enough stock, quota and room.", "at_capacity");
      if ((await keys.records()).some(record => !record.serverId)) throw fail("A previous Scaleway create is unresolved. Check its console before retrying.", "creation_unknown");
      const generated = await keys.generate();
      let sshKeyId: string | null = null, created: Server | null = null;
      try {
        const { projectId, zone } = await api.config();
        const key = await api.parse(z.object({ id: z.string().uuid() }), "POST", "/iam/v1alpha1/ssh-keys", { name: `bb-boat-${generated.token}`, project_id: projectId, public_key: generated.publicKey }, input.signal);
        sshKeyId = key.id;
        await keys.save({ token: generated.token, sshKeyId });
        const types = await api.parse(z.object({ server_types: z.array(typeSchema) }), "GET", `${await api.base()}/server-types`, undefined, input.signal);
        const os = types.server_types.find(t => t.name === choice.model.id)!.default_os.id;
        created = await api.parse(serverSchema, "POST", `${await api.base()}/servers`, { project_id: projectId, name: input.name, type: choice.model.id, os_id: os, commitment_type: "none", enable_vpc: false, tags: [`${TAG}${generated.token}`] }, input.signal);
        await keys.save({ token: generated.token, sshKeyId, serverId: created.id, zone, projectId });
        // Record the charge immediately, before readiness/bootstrap can fail.
        const id = `scw_${zone}_${created.id}`;
        ledger.record({ id: `scaleway:${created.id}`, provider: "scaleway", machineId: id, size: choice.model.id, startedAt: created.created_at, paidUntil: created.deletable_at, minimumCost: choice.model.minimumCost, hourPrice: choice.model.hourPrice, billingIncrementSeconds: 3600, currency: "EUR", cpus: choice.model.cpus, memoryMiB: choice.model.memoryMiB });
        const deadline = Date.now() + (options.readyTimeoutMs ?? 30*60_000);
        while (Date.now() < deadline) {
          input.signal?.throwIfAborted();
          created = await raw(id,input.signal);
          if (["error", "locked"].includes(created.status)) throw fail("Scaleway Mac provisioning failed.");
          if (created.status === "ready" && created.delivered && created.ip) {
            try {
              const probe = await run(created, { command: ["bash", "-lc", "true"], timeoutMs: 20_000, signal: input.signal });
              if (probe.exitCode === 0) {
                const setup = await run(created, { command: ["bash", "-s"], stdin: BOOTSTRAP, timeoutMs: 15*60_000, signal: input.signal });
                if (setup.exitCode !== 0) throw fail("Scaleway Mac tooling installation failed.", "bootstrap_failed");
                return view(created,input.signal);
              }
            } catch (error) { if ((error as { code?: string }).code !== "host_unavailable") throw error; }
          }
          await delay(options.pollMs ?? 10_000, undefined, { signal: input.signal });
        }
        throw fail("Scaleway Mac did not become SSH-ready in time.");
      } catch (error) {
        if (created) {
          // The minimum cannot be cancelled; schedule deletion to prevent an
          // orphan failed bootstrap from continuing to bill after it.
          await api.request("PATCH", `/apple-silicon/v1alpha1/zones/${created.zone}/servers/${created.id}`, { deletion_scheduled: true }).catch(() => undefined);
          throw fail("Scaleway allocated a Mac but setup failed. Its lease is recorded; check scheduled deletion in the console.", "creation_allocated");
        }
        if ((error as { code?: string }).code !== "creation_unknown") {
          if (sshKeyId) await api.request("DELETE", `/iam/v1alpha1/ssh-keys/${sshKeyId}`).catch(() => undefined);
          await keys.remove(generated.token);
        }
        throw error;
      }
    },
    async delete(id, signal, endOptions) {
      let server: Server;
      try { server = await raw(id,signal); } catch (error) { if (!isNotFound(error)) throw error; return; }
      if (Date.now() < Date.parse(server.deletable_at)) throw fail("Scaleway cannot release this Mac before its 24 h minimum ends.", "minimum_lease");
      await api.request("DELETE", `/apple-silicon/v1alpha1/zones/${server.zone}/servers/${server.id}`, undefined, signal);
      const token = server.tags.find(t => t.startsWith(TAG))?.slice(TAG.length);
      if (token) { const record = await keys.load(token); await api.request("DELETE", `/iam/v1alpha1/ssh-keys/${record.sshKeyId}`, undefined, signal).catch(error => { if (!isNotFound(error)) throw error; }); await keys.remove(token); }
      for (const lease of ledger.held(id)) ledger.end(lease.id,endOptions?.leaseEndReason ?? "deleted",endOptions?.leaseEndAt);
    },
    async scheduleLeaseRelease(id, at, signal) {
      const server = await raw(id,signal);
      if (Date.parse(at) !== Date.parse(server.deletable_at)) throw fail("Scaleway only schedules deletion at its minimum boundary.", "minimum_lease");
      await api.request("PATCH", `/apple-silicon/v1alpha1/zones/${server.zone}/servers/${server.id}`, { deletion_scheduled: true }, signal);
    },
    async cancelLeaseRelease(id, signal) {
      const server = await raw(id,signal);
      await api.request("PATCH", `/apple-silicon/v1alpha1/zones/${server.zone}/servers/${server.id}`, { deletion_scheduled: false }, signal);
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
