import assert from "node:assert/strict";
import { test } from "node:test";
import { sandboxInventorySchema, sandboxMacLeaseSchema } from "../contract-sandboxes.ts";
import { machinePower } from "../sandbox-power.ts";
import { INVENTORY_LEASE_ROWS, INVENTORY_ROWS_PER_PROVIDER, inventoryRead, readSandboxInventory, sandboxMacLeases } from "../src/sandbox-inventory.ts";
import { toSandbox } from "../src/providers/instabox/parse.ts";
import { BoatApi } from "../src/providers/boat/api.ts";
import { createInstaboxProvider } from "../src/providers/instabox/provider.ts";
import type { InstaboxCli } from "../src/providers/instabox/cli.ts";
import type { InstaboxRest } from "../src/providers/instabox/api.ts";
import type { BoatCli } from "../src/providers/boat/cli.ts";
import type { SandboxInfo } from "../src/providers/types.ts";
import type { MacLease, MacLeaseSnapshot } from "../src/mac-leases.ts";
import { toSandboxDto } from "../src/rpc.ts";

const NOW = Date.parse("2030-03-15T12:00:00Z");
const row = (id: string, state: string): SandboxInfo => ({ id, state, name: null, health: null, url: null, desktopUrl: null, environment: null, createdAt: null, archiveAfter: null, stoppedAt: null, setupStatus: null, error: null });
const provider = (id: string, rows: SandboxInfo[]) => ({ id, list: async () => rows });
const lease = (patch: Partial<MacLease> = {}): MacLease => ({ id: "local-demo-lease", machineId: "m_demo", provider: "instabox", size: "m4", startedAt: "2030-03-01T00:00:00Z", paidUntil: "2030-03-02T00:00:00Z", minimumCost: 12, hourPrice: 0.5, currency: "USD", cpus: 4, memoryMiB: 8192, endedAt: null, endReason: null, noticeAt: null, noticeText: null, kept: false, releaseAt: null, ...patch });

test("guest power distinguishes an idle machine from stopped, transitional and unknown states", () => {
  assert.equal(machinePower(toSandbox({ id: "m_demo", state: "running" }).state), "on");
  for (const state of ["ready", "idle", "running"]) assert.equal(machinePower(state), "on");
  for (const state of ["stopped", "suspended", "deleted"]) assert.equal(machinePower(toSandbox({ id: "m_demo", state }).state), "off");
  for (const state of ["provisioned", "cloning", "starting", "stopping", "error", "unknown", "unexpected", "on"]) assert.equal(machinePower(state), "unknown");
});

test("complete inventory counts powered guests, not task activity or plan capacity", async () => {
  const reads = await readSandboxInventory([provider("boat", [row("bx_idle", "idle"), row("bx_prompt", "running"), row("bx_stopped", "stopped")])], { all: true }, () => NOW);
  assert.deepEqual(reads.inventory.providers, [{ id: "boat", status: "fresh", observedAt: new Date(NOW).toISOString(), poweredOn: 2, unknown: 0, truncated: false }]);
  assert.equal(sandboxInventorySchema.safeParse(reads.inventory).success, true);
});

test("failed partial inventory retains the other provider, with no raw errors or false zero", async () => {
  const failed = { id: "instabox", list: async () => { throw new Error("private provider response"); } };
  const reads = await readSandboxInventory([provider("boat", []), failed], { all: true }, () => NOW);
  assert.equal(reads.inventory.providers[0]!.poweredOn, 0);
  assert.deepEqual(reads.inventory.providers[1], { id: "instabox", status: "unavailable", observedAt: null, poweredOn: null, unknown: null, truncated: false });
  assert.equal(JSON.stringify(reads).includes("private provider response"), false);
  const allFailed = await readSandboxInventory([failed], { all: true });
  assert.equal(allFailed.inventory.providers[0]!.poweredOn, null);
});

test("an aborted inventory read remains unavailable even when an adapter ignores cancellation", async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  const pending = readSandboxInventory([{ id: "boat", list: async options => { received = options?.signal; return await new Promise<SandboxInfo[]>(() => {}); } }], { all: true, signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(received?.aborted, true);
  assert.equal(result.inventory.providers[0]!.poweredOn, null);
  assert.equal(result.inventory.providers[0]!.status, "unavailable");
  await assert.rejects(inventoryRead(Promise.resolve([]), controller.signal), /deadline/);
  await assert.rejects(inventoryRead(Promise.reject(new Error("private provider rejection")), controller.signal), /deadline/);
});

test("unknown states, malformed and truncated inventory cannot prove zero or an exact count", async () => {
  const unknown = await readSandboxInventory([provider("boat", [row("bx_demo", "starting")])], { all: true }, () => NOW);
  assert.equal(unknown.inventory.providers[0]!.poweredOn, null);
  assert.equal(unknown.inventory.providers[0]!.unknown, 1);
  const invalid = await readSandboxInventory([provider("boat", [row("", "idle")])], { all: true });
  assert.equal(invalid.inventory.providers[0]!.status, "unavailable");
  const duplicate = await readSandboxInventory([provider("boat", [row("bx_demo", "idle"), row("bx_demo", "idle")])], { all: true });
  assert.equal(duplicate.inventory.providers[0]!.poweredOn, null);
  const truncated = await readSandboxInventory([provider("boat", Array.from({ length: INVENTORY_ROWS_PER_PROVIDER + 1 }, (_, index) => row(`bx_${index}`, "idle")))], { all: true });
  assert.equal(truncated.sandboxes.length, INVENTORY_ROWS_PER_PROVIDER);
  assert.equal(truncated.inventory.truncated, true);
  assert.equal(truncated.inventory.providers[0]!.poweredOn, null);
});

test("boat inventory parser rejects a missing or malformed list instead of manufacturing empty success", async () => {
  for (const result of [{}, { sandboxes: {} }, { sandboxes: [null] }]) {
    const api = new BoatApi({ json: async () => result } as unknown as BoatCli);
    await assert.rejects(api.list({ all: true }), /invalid sandbox inventory/);
  }
  const api = new BoatApi({ json: async () => ({ sandboxes: [] }) } as unknown as BoatCli);
  assert.deepEqual(await api.list({ all: true }), []);
});

test("Instabox inventory parser rejects malformed envelopes and rows instead of manufacturing empty success", async () => {
  for (const value of [{}, { machines: {} }, [null]]) {
    const adapter = createInstaboxProvider({ run: async () => ({ value }) } as unknown as InstaboxCli, {} as InstaboxRest);
    await assert.rejects(adapter.list({ all: true }), /invalid machine inventory/);
  }
  const adapter = createInstaboxProvider({ run: async () => ({ value: [] }) } as unknown as InstaboxCli, {} as InstaboxRest);
  assert.deepEqual(await adapter.list({ all: true }), []);
});

test("held lease never proves a running guest; stopped guest never proves a returned lease", async () => {
  const snapshot: MacLeaseSnapshot = { leases: [lease()], tasks: [{ leaseId: "local-demo-lease", taskId: "t_demo", attachedAt: "2030-03-01T00:00:00Z", cpus: 4, memoryMiB: 8192, workOutcome: null, workTurns: null }] };
  const evidence = sandboxMacLeases(snapshot).macLeases[0]!;
  assert.equal(evidence.state, "held");
  assert.deepEqual(evidence.taskIds, ["t_demo"]);
  assert.equal(machinePower("stopped"), "off");
  assert.equal(evidence.state, "held");
  assert.equal(sandboxMacLeaseSchema.safeParse(evidence).success, true);
  assert.equal(Object.hasOwn(evidence, "id"), false);
  assert.equal(Object.hasOwn(evidence, "noticeText"), false);
});

test("a stopped Mac without current lease terms retains its provider-reported OS in the RPC", () => {
  const machine = toSandbox({ id: "m_demo", state: "stopped", template: { id: "macos" } });
  const dto = toSandboxDto({ ...machine, provider: "instabox" }, [], [], { provider: "instabox", label: "Instabox", os: "linux", machine: "Linux", note: null, detail: null });
  assert.equal(dto.power, "off");
  assert.equal(dto.runsOn?.os, "macos");
  assert.equal(dto.runsOn?.machine, "Mac");
  assert.equal(dto.runsOn?.lease, undefined);
});

test("only confirmed hand-back/deletion can label a historical Mac returned, with billing still unconfirmed", () => {
  const endedAt = "2030-03-02T00:00:00Z";
  const cases: [Partial<MacLease>, string][] = [
    [{ endedAt, endReason: "handed back", endEvidence: "confirmed" }, "returned"],
    [{ endedAt, endReason: "deleted", endEvidence: "confirmed" }, "returned"],
    [{ endedAt, endReason: "deleted", endEvidence: "inferred" }, "ended-unverified"],
    [{ endedAt, endReason: "deleted", endEvidence: "legacy" }, "ended-unverified"],
    [{ endedAt, endReason: "failed", endEvidence: "confirmed" }, "ended-unverified"],
  ];
  for (const [patch, state] of cases) {
    const evidence = sandboxMacLeases({ leases: [lease(patch)], tasks: [] }).macLeases[0]!;
    assert.equal(evidence.state, state);
    assert.equal(Object.hasOwn(evidence, "billingEndedAt"), false);
  }
});

test("lease evidence is bounded and preserves held leases before old history", () => {
  const endedAt = "2030-03-02T00:00:00Z";
  const leases = Array.from({ length: INVENTORY_LEASE_ROWS + 1 }, (_, index) => lease({ id: `demo-${index}`, endedAt, endReason: "deleted", endEvidence: "confirmed" }));
  leases.push(lease({ id: "held-demo" }));
  const evidence = sandboxMacLeases({ leases, tasks: [] });
  assert.equal(evidence.macLeases.length, INVENTORY_LEASE_ROWS);
  assert.equal(evidence.macLeases[0]!.state, "held");
  assert.equal(evidence.macLeasesTruncated, true);
});
