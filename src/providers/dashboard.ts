import { dashboardUrl } from "./boat/api.ts";

/** Instabox documents no stable machine page. Keep the other providers' links unchanged. */
export function sandboxDashboardUrl(sandboxId: string, provider = "boat"): string | null {
  return provider === "instabox" ? null : dashboardUrl(sandboxId);
}
