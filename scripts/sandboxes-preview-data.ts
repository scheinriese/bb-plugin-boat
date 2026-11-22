// Synthetic presentation fixtures only. The preview never reads bb or a provider.
import { pendingTaskSample } from "../test/fixtures/pending-task-data";

export const SCENES = ["returned", "active-stale", "loading", "unavailable", "partial", "mixed-currency", "stopped-held", "loaded-null-plan", "failed-refresh"] as const;
export type Scene = typeof SCENES[number];

export function fixture(scene: Scene) {
  const now = Date.now();
  const observedAt = new Date(now - (scene === "active-stale" ? 75 * 60_000 : 20_000)).toISOString();
  const start = new Date(now); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
  const periodStart = start.toISOString(), periodEnd = end.toISOString();
  const active = scene === "active-stale" || scene === "mixed-currency";
  const held = active || scene === "stopped-held";
  const provider = (id: string, label: string) => ({
    id, label, kind: "cloud", isDefault: id === "boat", available: true, enabled: true,
    connection: "connected", meta: null, summary: "Synthetic provider", pricing: null,
    systems: [{os: "linux", label: "Linux", ready: true, note: null}, ...(id === "boat" ? [] : [{os: "macos", label: "Mac", ready: true, note: null}])],
    apiKey: null, status: "Connected",
  });
  const tasks = [
    {...pendingTaskSample, id: "t_fa100001", title: "Test the synthetic desktop app", purpose: "Check the sample window", status: active ? "running" : "done", sandboxId: active ? "fake_mac" : null, macRentalPending: false, phase: active ? "working" : "done", publicStatus: {status: active ? "running" : "done", label: active ? "Working" : "Done", reason: null, needsYou: false, tone: "normal", moving: active}},
    {...pendingTaskSample, id: "t_fa100002", title: "Build the synthetic web preview", purpose: "Verify the sample page", status: "running", sandboxId: "fake_linux", macRentalPending: false, phase: "working", publicStatus: {status: "running", label: "Working", reason: null, needsYou: false, tone: "normal", moving: true}},
  ];
  const sandbox = (id: string, label: string, os: "linux" | "macos", taskIndex?: number, state = "idle") => ({
    id, name: "Synthetic machine", state, power: ["idle", "running"].includes(state) ? "on" : "off",
    health: "ok", url: null, createdAt: new Date(now - 45 * 60_000).toISOString(),
    archiveAfter: new Date(now + 30 * 60_000).toISOString(), dashboardUrl: null, sshCommand: "",
    machineType: "default", taskIds: taskIndex === undefined ? [] : [tasks[taskIndex]!.id],
    uses: taskIndex === undefined ? [] : [{kind: "task", id: tasks[taskIndex]!.id, title: tasks[taskIndex]!.title, open: true}],
    runsOn: {provider: id.startsWith("fake_boat") ? "boat" : "instabox", label, os, machine: os === "macos" ? "Mac M4" : "Default", note: null, detail: null},
  });
  const machines = [sandbox("fake_boat_1", "boat.dev", "linux"), sandbox("fake_boat_2", "boat.dev", "linux")];
  if (active) machines.push(sandbox("fake_linux", "Instabox", "linux", 1, "running"), sandbox("fake_mac", "Instabox", "macos", 0, "running"));
  if (scene === "stopped-held") machines.push(sandbox("fake_mac", "Instabox", "macos", 0, "stopped"));
  if (scene === "partial") machines.push(sandbox("fake_boat_stopped", "boat.dev", "linux", undefined, "stopped"));
  const lease = {
    provider: "instabox", machineId: "fake_mac", size: "M4", state: held ? "held" : "returned",
    startedAt: new Date(now - 24 * 60 * 60_000).toISOString(),
    endedAt: held ? null : new Date(now - 90 * 60_000).toISOString(), endEvidence: "confirmed", endReason: held ? null : "handed back",
    taskIds: [tasks[0]!.id],
    paidUntil: new Date(now + 8 * 60 * 60_000).toISOString(), minimumCost: 12,
    hourPrice: .5, currency: "USD", kept: false, releaseAt: null,
  };
  const usage = {
    plan: "Sample", used: 18.25, credit: 9, remaining: -9.25, resetsAt: periodEnd,
    hours: active ? 2.5 : 0, hoursScope: "running-machines", active: active ? 2 : 0,
    error: scene === "unavailable" ? "Provider usage unavailable" : null,
    accountCredit: true, scope: "account-total", includesMacs: true, currency: "USD",
    observedAt, periodStart, periodEnd,
  };
  if (scene === "unavailable") Object.assign(usage, {used: null, credit: null, remaining: null, hours: null, active: null, observedAt: null});
  const costs = {USD: 12};
  const window = {leaseDays: 1, costs};
  const read = (data: unknown, error?: string) => ({data, error: error ? new Error(error) : undefined, isFetching: false, isLoading: false, refetch: async () => {}});
  const periods = {since: periodStart, until: new Date(now).toISOString(), hours: 4, dollars: .2, complete: true, sandboxCount: 2};
  const providerStatus = (id: string) => {
    const failed = scene === "unavailable" || (scene === "partial" && id === "instabox");
    return {id, status: failed ? "unavailable" : "fresh", observedAt: failed ? null : observedAt,
      poweredOn: failed ? null : machines.filter(machine => machine.runsOn.provider === id && machine.power === "on").length,
      unknown: failed ? null : 0, truncated: false};
  };
  const values: Record<string, unknown> = {
    sandboxes: read({sandboxes: scene === "unavailable" ? [] : machines, error: scene === "partial" ? "Instabox inventory unavailable" : scene === "unavailable" ? "Machine inventory unavailable" : null, inventory: {providers: [providerStatus("boat"), providerStatus("instabox")], truncated: false}, macLeases: [lease], macLeasesTruncated: false}),
    tasks: read({tasks}), overview: read({activeSandboxes: machines.length, boatError: null, cap: 20}),
    setup: read({plan: {vmHoursRemaining: 480}}), projects: read({projects: []}),
    settings: read({settings: [{key: "stopIdleAfterMinutes", value: 60}]}),
    task: read({task: null}),
    fidelityUsage: read({plan: {name: "Sample", hoursRemaining: scene === "loaded-null-plan" ? null : 480, hoursTotal: scene === "loaded-null-plan" ? null : 500, resetsAt: periodEnd}, day: periods, week: periods, sandboxes: [], task: null, missing: [], checkedAt: observedAt}),
    sandboxProviders: read({providers: [provider("boat", "boat.dev"), {...provider("instabox", "Instabox"), linuxUsage: scene === "loaded-null-plan" ? undefined : usage}, ...(scene === "mixed-currency" ? [provider("scaleway", "Scaleway")] : [])], routing: "Synthetic provider routing", options: [], projects: []}),
    macUsage: read({month: window, rolling30: window, providers: [{id: "instabox", label: "Instabox"}], byProvider: [{id: "instabox", label: "Instabox", month: window, rolling30: window}, ...(scene === "mixed-currency" ? [{id: "scaleway", label: "Scaleway", month: {leaseDays: 1, costs: {EUR: 7}}, rolling30: {leaseDays: 1, costs: {EUR: 7}}}] : [])], held: held ? [lease] : [], calculatedAt: observedAt, monthPeriod: {since: periodStart, until: new Date(now).toISOString()}, periodStart, periodEnd, observedAt}, scene === "failed-refresh" ? "Synthetic estimate refresh unavailable" : undefined),
    snapshots: read({snapshots: [{name: "Synthetic saved snapshot", provider: "instabox", sizeBytes: 250_000, createdAt: observedAt, type: null, status: "ready"}], included: null, used: 1, error: scene === "partial" ? "Some snapshot providers unavailable" : null, complete: scene !== "partial", failedProviders: scene === "partial" ? ["boat"] : [], observedAt}),
  };
  return scene === "loading" ? new Proxy({}, {get: () => ({data: undefined, isLoading: true, isFetching: true, refetch: async () => {}})}) as typeof values : values;
}
