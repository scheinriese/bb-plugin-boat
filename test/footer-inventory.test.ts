import assert from "node:assert/strict";
import { test } from "node:test";
import { footerMachineCount } from "../web/footer-machine-count.ts";
import type { SandboxInventoryDto } from "../contract-sandboxes.ts";

const now = Date.parse("2030-03-15T12:00:00Z");
const provider = (id: string, poweredOn: number | null, patch: Partial<SandboxInventoryDto["providers"][number]> = {}): SandboxInventoryDto["providers"][number] => ({ id, status: "fresh", observedAt: new Date(now).toISOString(), poweredOn, unknown: 0, truncated: false, ...patch });
const count = (providers: SandboxInventoryDto["providers"], id?: string) => footerMachineCount({providers, truncated: providers.some(provider => provider.truncated)}, false, id, now);

test("footer counts powered cloud guests and keeps local task environments separate", () => {
  assert.equal(count([provider("boat", 2), provider("instabox", 1), provider("ownmac", 7), provider("monthly-mac", 4)]), 3);
  assert.equal(count([provider("boat", 0), provider("ownmac", 7)]), 0);
  assert.equal(count([provider("ownmac", 7)]), null);
});

test("footer inventory failure, unknown power and truncation never show an exact zero", () => {
  assert.equal(footerMachineCount(undefined), null);
  assert.equal(footerMachineCount({providers: [provider("boat", 0)], truncated: false}, true), null);
  assert.equal(count([provider("boat", 0), provider("instabox", null, {status: "unavailable", observedAt: null})]), null);
  assert.equal(count([provider("boat", null, {unknown: 1})]), null);
  assert.equal(count([provider("boat", 0, {unknown: 1})]), null);
  assert.equal(count([provider("boat", 0, {truncated: true})]), null);
  assert.equal(count([provider("boat", 0, {observedAt: new Date(now - 11 * 60_000).toISOString()})]), null);
});

test("a successful provider retains its own exact count when another inventory is unavailable", () => {
  const providers = [provider("boat", 2), provider("instabox", null, {status: "unavailable", observedAt: null})];
  assert.equal(count(providers, "boat"), 2);
  assert.equal(count(providers, "instabox"), null);
  assert.equal(count(providers, "scaleway"), null);
});
