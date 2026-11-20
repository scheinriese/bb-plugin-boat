// Official Apple silicon, IAM and public Product Catalog APIs. Secret settings
// are read fresh, sent only to api.scaleway.com, and never included in errors.
import { z } from "zod";
import { ProviderError } from "../types.ts";
export const fail = (message: string, code = "scaleway_failed", status: number | null = null) => new ProviderError(message, { code, status });
export const serverSchema = z.object({
  zone: z.enum(["fr-par-1", "fr-par-3"]), id: z.string().uuid(), name: z.string(), type: z.string(), project_id: z.string(),
  status: z.string(), delivered: z.boolean(), ip: z.string().default(""), ssh_username: z.string().min(1),
  created_at: z.string().datetime(), deletable_at: z.string().datetime(), deletion_scheduled: z.boolean().default(false),
});
export type Server = z.infer<typeof serverSchema>;
export const typeSchema = z.object({ name: z.string(), stock: z.string(), cpu: z.object({ core_count: z.number().positive() }), memory: z.object({ capacity: z.coerce.number().positive() }), default_os: z.object({ id: z.string(), name: z.string(), is_beta: z.boolean().optional() }) });
export const productSchema = z.object({ locality: z.object({ zone: z.string().optional() }), status: z.string(), properties: z.object({ apple_silicon: z.object({ server_type: z.string().optional() }).optional() }), unit_of_measure: z.object({ unit: z.string(), size: z.number() }), price: z.object({ retail_price: z.object({ currency_code: z.string(), units: z.coerce.number(), nanos: z.number() }) }) });
export const quotaSchema = z.object({ name: z.string(), limit: z.coerce.number().optional(), unlimited: z.boolean().optional(), limits: z.array(z.object({ zone: z.string().optional(), region: z.string().optional(), global: z.boolean().optional(), limit: z.coerce.number().optional(), unlimited: z.boolean().optional() })).default([]) });
export interface ScalewayConfig { projectId: string; zone: string }
export class ScalewayApi {
  private readonly options: { key(): Promise<string | null>; config(): Promise<ScalewayConfig>; fetch?: typeof fetch };
  constructor(options: { key(): Promise<string | null>; config(): Promise<ScalewayConfig>; fetch?: typeof fetch }) { this.options = options; }
  async config() {
    const value = await this.options.config();
    if (!z.string().uuid().safeParse(value.projectId).success || !["fr-par-1", "fr-par-3"].includes(value.zone)) throw fail("Set a valid Scaleway project ID and Paris zone in Boat settings.", "provider_unavailable");
    return value;
  }
  async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const key = await this.options.key().catch(() => { throw fail("Could not read the Scaleway secret setting.", "key_missing"); });
    if (!key) throw fail("Add the Scaleway secret key in bb secrets.", "key_missing");
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`https://api.scaleway.com${path}`, { method, headers: { "X-Auth-Token": key, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
    } catch {
      // A create with an unknown outcome must never trigger another rental.
      throw fail(method === "POST" && path.endsWith("/servers") ? "Scaleway create outcome is unknown. Check its console before retrying." : "Could not reach Scaleway.", method === "POST" && path.endsWith("/servers") ? "creation_unknown" : "host_unavailable");
    }
    if (!response.ok) throw fail(`Scaleway refused the request (HTTP ${response.status}).`, method === "POST" && path.endsWith("/servers") && (response.status >= 500 || response.status === 408) ? "creation_unknown" : method === "POST" && path.endsWith("/servers") ? "creation_rejected" : response.status === 404 ? "not_found" : response.status === 401 || response.status === 403 ? "unauthorized" : "scaleway_failed", response.status);
    if (response.status === 204) return {};
    try { return await response.json(); } catch { throw fail("Scaleway returned an invalid response.", method === "POST" && path.endsWith("/servers") ? "creation_unknown" : "bad_response"); }
  }
  async parse<T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const parsed = schema.safeParse(await this.request(method, path, body, signal));
    if (!parsed.success) throw fail("Scaleway returned an unsupported response.", method === "POST" && path.endsWith("/servers") ? "creation_unknown" : "bad_response");
    return parsed.data;
  }
  async pages<T>(path: string, field: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; page <= 1000; page++) {
      const body = await this.parse(z.object({ total_count: z.coerce.number().optional() }).catchall(z.unknown()), "GET", `${path}${path.includes("?") ? "&" : "?"}page_size=100&page=${page}`, undefined, signal);
      const parsed = z.array(schema).safeParse(body[field]);
      if (!parsed.success) throw fail("Scaleway returned an unsupported list.", "bad_response");
      result.push(...parsed.data);
      if (body.total_count !== undefined ? result.length >= body.total_count : parsed.data.length < 100) return result;
      if (!parsed.data.length) break;
    }
    throw fail("Scaleway list was incomplete.", "bad_response");
  }
  async base() { const { zone } = await this.config(); return `/apple-silicon/v1alpha1/zones/${zone}`; }
  async server(id: string, signal?: AbortSignal) { return this.parse(serverSchema, "GET", `${await this.base()}/servers/${encodeURIComponent(id)}`, undefined, signal); }
}
