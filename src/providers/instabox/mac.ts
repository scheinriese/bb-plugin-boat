import { num, rec, str, type InstaboxCli } from "./cli.ts";
import { toCapacity } from "./parse.ts";
import type { MacModel } from "../types.ts";

/** Live templates plus the key's workspace tier. Unknown/old servers fail closed. */
export async function macModels(cli: InstaboxCli, signal?: AbortSignal): Promise<MacModel[]> {
  const [usage, raw] = await Promise.all([cli.json(["usage", "--json"], { signal }), cli.json(["templates", "--json"], { signal })]);
  if (!["pro", "builder", "team", "enterprise"].includes(toCapacity(usage).tier ?? "")) return [];
  const templates = Array.isArray(raw.templates) ? raw.templates.map(rec) : [];
  const template = templates.find(t => t?.id === "macos" && t.os === "macos" && t.creatable === true && t.hidden !== true && t.staged !== true && t.latest !== false);
  if (!template || !Array.isArray(template.models)) return [];
  return template.models.flatMap(value => {
    const model = rec(value), spec = rec(model?.defaultSpec), lease = rec(model?.minimumLease);
    const hours = num(lease?.hours), hourPrice = num(lease?.hourUSD);
    const id = str(model?.name), price = num(lease?.minimumUSD), cpus = num(spec?.vcpus), memoryMiB = num(spec?.memMiB);
    if (!id || !/^[a-z0-9]+$/.test(id) || !cpus || !memoryMiB || price === null || price < 0 || hours !== 24 || hourPrice === null || hourPrice < 0) return [];
    return [{ id, label: str(model?.label) ?? id.toUpperCase(), cpus, memoryMiB, minimumCost: price, minimumHours: hours, hourPrice, currency: "USD" }];
  });
}
