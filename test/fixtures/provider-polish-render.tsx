import { StoppedSandboxActions } from "../../web/sandbox-row-actions";
// Obviously fake provider/billing fixtures; never used by the installed plugin.
import { renderToStaticMarkup } from "react-dom/server";
import { ThisMonthUsage } from "../../web/mac-usage";
import { FooterUsage } from "../../web/footer-usage";
import { ProviderSetup } from "../../web/provider-setup";
import { ProviderFailureCard } from "../../web/provider-failure";
import { ProviderRow, RunsOnLine } from "../../web/providers";
import type {
  MacUsageDto,
  SandboxProviderDto,
} from "../../contract-providers.ts";
export const plan = {
  name: "Standard",
  hoursRemaining: 2643.77,
  hoursTotal: 2777.78,
  resetsAt: "2026-12-19T00:00:00Z",
};
export const linux = {
  plan: "Pro",
  used: 6.4,
  credit: 20,
  remaining: 13.6,
  resetsAt: "2026-12-01T00:00:00Z",
  hours: 41.5,
  active: 2,
  error: null,
};
export const steps = [
  {
    id: "cli",
    label: "Instabox CLI installed",
    done: true,
    possible: true,
    detail: "found on this host",
  },
  {
    id: "key",
    label: "API key stored",
    done: true,
    possible: true,
    detail: "in bb secrets",
  },
  {
    id: "plan",
    label: "Plan detected",
    done: true,
    possible: true,
    detail: "Pro · $20 monthly credit · resets Dec 1",
  },
  {
    id: "github",
    label: "GitHub Secret present",
    done: false,
    possible: true,
    detail: "GH_TOKEN · proxy Secret · github.com, api.github.com",
  },
  {
    id: "enabled",
    label: "Turned on",
    done: false,
    possible: true,
    detail: "after step 4 · Linux and Mac tasks can then run here",
  },
];
export const instabox: SandboxProviderDto = {
  id: "instabox",
  label: "Instabox",
  kind: "cloud",
  isDefault: false,
  available: true,
  enabled: true,
  connection: "connected",
  meta: null,
  summary:
    "Linux microVMs billed per second. Macs: 24 h minimum, then per second.",
  pricing: null,
  systems: [
    { os: "linux", label: "Linux", ready: true, note: null },
    { os: "macos", label: "Mac", ready: true, note: null },
  ],
  apiKey: { setting: "Instabox API key" },
  status: "Setting up · 3 of 5",
  steps,
  linuxUsage: linux,
};
export const held = {
  provider: "instabox",
  machineId: "fake_mac_1",
  size: "M2",
  minimumCost: 10.8,
  hourPrice: 0.45,
  kept: false,
  releaseAt: null,
  currency: "USD",
  paidUntil: "2099-11-19T14:00:00Z",
};
export const mac: MacUsageDto = {
  month: { leaseDays: 14, costs: { USD: 151.2 } },
  rolling30: { leaseDays: 14, costs: { USD: 151.2 } },
  held: [held],
  providers: [{ id: "instabox", label: "Instabox" }],
  byProvider: [
    {
      id: "instabox",
      label: "Instabox",
      month: { leaseDays: 14, costs: { USD: 151.2 } },
      rolling30: { leaseDays: 14, costs: { USD: 151.2 } },
    },
  ],
  today: { EUR: 1.1 },
};
export const scaleway: SandboxProviderDto = {
  ...instabox,
  id: "scaleway",
  label: "Scaleway",
  summary: "Whole Mac minis. 24 h minimum, then hourly. Prices in EUR.",
  status: "Held Macs only",
  systems: [{ os: "macos", label: "Mac", ready: true, note: null }],
  apiKey: { setting: "Scaleway secret key" },
  steps: [
    {
      id: "api",
      label: "API access",
      done: true,
      possible: true,
      detail: "Verified",
    },
    {
      id: "project",
      label: "Project found",
      done: true,
      possible: true,
      detail: "Paris Apple silicon",
    },
    {
      id: "enabled",
      label: "On",
      done: true,
      possible: true,
      detail: "Held Macs only",
    },
    {
      id: "logins",
      label: "Logins on fresh Macs",
      done: false,
      possible: false,
      detail: "not possible yet",
    },
  ],
};
export function scene(name: string) {
  if(name==="sandbox-actions")return <div className="space-y-3">{[false,true].map(unowned=><div key={String(unowned)} data-owner={unowned ? "unowned" : "task"} className="group flex items-center justify-between rounded-lg border border-[#262626] bg-[#181818] p-3.5 text-[13px]"><span>{unowned ? "Not from a task" : "Rewrite the quickstart guide"}<span className="ml-6 text-[#A8A8A8]">boat.dev · Small</span><span className="ml-6 text-[#8A8A8A]">{unowned ? "Stopped · not resumable" : "Stopped · nothing lost"}</span></span><div className="flex gap-2"><StoppedSandboxActions unowned={unowned} deleteButton={<button className="rounded-md border border-[#333333] px-2.5 py-1">Delete</button>} resumeButton={<button className="rounded-md border border-[#333333] px-2.5 py-1">Resume</button>}/></div></div>)}</div>;
  if(name==="running-only")return <ThisMonthUsage plan={plan} instabox={{...linux,hoursScope:"running-machines"}}/>;
  if(name==="multi-lease-footer")return <div className="w-[298px] space-y-3 rounded-xl border border-[#303030] bg-[#202020] p-3.5"><FooterUsage plan={plan} providers={[instabox]} mac={{...mac,held:[held,{...held,machineId:"fake_mac_2",size:"M4",minimumCost:18,hourPrice:0.75}]}} boatOn={3} cap={300} day={{dollars:0.92,hours:1.6}}/></div>;
  if (name === "usage")
    return (
      <ThisMonthUsage
        plan={plan}
        instabox={linux}
        mac={mac}
        active={3}
        cap={300}
        idleMinutes={60}
      />
    );
  if (name === "unused")
    return (
      <ThisMonthUsage
        instabox={{ ...linux, used: 0, remaining: 20, hours: 0, active: 0 }}
      />
    );
  if (name === "over")
    return (
      <ThisMonthUsage
        instabox={{ ...linux, used: 23.1, remaining: 0, hours: 146, active: 1 }}
      />
    );
  if (name === "off") return <ThisMonthUsage providersOff />;
  if (name === "unknown")
    return (
      <ThisMonthUsage
        instabox={{ ...linux, credit: null, remaining: null, resetsAt: null }}
      />
    );
  if (name === "unavailable")
    return <ThisMonthUsage instabox={{ ...linux, error: "unavailable" }} />;
  if (
    name === "kept" ||
    name === "scheduled" ||
    name === "elapsed" ||
    name === "no-lease"
  )
    return (
      <ThisMonthUsage
        mac={{
          ...mac,
          held:
            name === "no-lease"
              ? []
              : [
                  {
                    ...held,
                    kept: name === "kept",
                    releaseAt: name === "scheduled" ? held.paidUntil : null,
                    paidUntil:
                      name === "elapsed"
                        ? "2020-01-01T14:00:00Z"
                        : held.paidUntil,
                  },
                ],
        }}
      />
    );
  if (name === "scaleway")
    return (
      <ThisMonthUsage
        mac={{
          ...mac,
          byProvider: [
            {
              id: "scaleway",
              label: "Scaleway",
              month: { leaseDays: 6, costs: { EUR: 41.2 } },
              rolling30: { leaseDays: 6, costs: { EUR: 41.2 } },
            },
          ],
          held: [
            {
              ...held,
              provider: "scaleway",
              currency: "EUR",
              minimumCost: 5.28,
              hourPrice: 0.22,
              billingIncrementSeconds: 3600,
            },
          ],
        }}
      />
    );
  if (name === "footer" || name === "boat-footer" || name === "no-mac-footer")
    return (
      <div className="w-[298px] space-y-3 rounded-xl border border-[#303030] bg-[#202020] p-3.5 shadow-[0_12px_32px_#00000073]">
        <h2 className="flex justify-between text-[13px] font-semibold">
          Cloud sandboxes{" "}
          <span className="text-xs font-normal text-[#A8A8A8]">
            {name === "boat-footer" ? "3" : "6"} on
          </span>
        </h2>
        <FooterUsage
          plan={plan}
          providers={name === "boat-footer" ? [] : [instabox]}
          mac={
            name === "boat-footer" || name === "no-mac-footer" ? undefined : mac
          }
          boatOn={3}
          cap={300}
          day={{ dollars: 0.92, hours: 1.6 }}
        />
        <p className="text-right text-xs text-[#7AA7FF]">All sandboxes →</p>
      </div>
    );
  if (name.startsWith("step-")) {
    const next = Number(name.slice(5));
    return (
      <ProviderSetup
        provider={{
          ...instabox,
          steps: steps.map((s, i) => ({ ...s, done: i < next })),
        }}
      />
    );
  }
  if (name === "settings")
    return (
      <div className="divide-y divide-[#222222] rounded-[10px] border border-[#262626] bg-[#181818]">
        <ProviderRow
          provider={{
            ...instabox,
            steps: undefined,
            id: "boat",
            label: "boat.dev",
            isDefault: true,
            summary: "Linux · Standard plan · 2,644 h left · resets Dec 19",
            status: "Connected",
            apiKey: null,
            systems: [],
          }}
        />
        <ProviderRow provider={instabox} />
        <ProviderRow provider={scaleway} />
      </div>
    );
  if (name === "complete")
    return (
      <ProviderRow
        provider={{
          ...instabox,
          status: "Connected",
          steps: steps.map((s) => ({ ...s, done: true })),
        }}
      />
    );
  if (name === "waiting")
    return <ProviderSetup provider={{ ...instabox, waitingTasks: 1 }} />;
  if (name === "regressed")
    return (
      <ProviderSetup
        provider={{
          ...instabox,
          steps: steps.map((s) =>
            s.id === "key"
              ? { ...s, done: false, detail: "Instabox rejected the key" }
              : s,
          ),
        }}
      />
    );
  if (name === "lines")
    return (
      <div className="space-y-3 rounded-[10px] border border-[#2A2A2A] bg-[#181818] p-3.5">
        {[false, true].map((shared) => (
          <div key={String(shared)}>
            <p className="text-[13px] text-[#E2E2E2]">
              {shared
                ? "Run the UI tests on iOS"
                : "Redesign the onboarding screens"}
            </p>
            <RunsOnLine
              runsOn={{
                provider: "instabox",
                label: "Instabox",
                os: "macos",
                machine: "Mac M2",
                note: null,
                detail: "Shares the Mac with Redesign the onboarding screens",
                lease: {
                  paidUntil: held.paidUntil,
                  endedAt: null,
                  shared,
                  kept: false,
                  releaseAt: null,
                },
              }}
            />
          </div>
        ))}
        <RunsOnLine
          runsOn={{
            provider: "instabox",
            label: "Instabox",
            os: "linux",
            machine: "Linux",
            note: null,
            detail: null,
          }}
        />
        <RunsOnLine
          runsOn={{
            provider: "scaleway",
            label: "Scaleway",
            os: "macos",
            machine: "Mac mini M2",
            note: null,
            detail: null,
            lease: {
              paidUntil: held.paidUntil,
              endedAt: null,
              shared: false,
              kept: false,
              releaseAt: null,
            },
          }}
        />
      </div>
    );
  const failures: Record<
    string,
    { code: string; provider: string; mac: boolean; released: boolean }
  > = {
    github: {
      code: "github_secret_missing",
      provider: "instabox",
      mac: false,
      released: false,
    },
    key: {
      code: "invalid_key",
      provider: "instabox",
      mac: false,
      released: false,
    },
    capacity: {
      code: "no_capacity",
      provider: "instabox",
      mac: true,
      released: false,
    },
    fresh: {
      code: "task_credentials_missing",
      provider: "scaleway",
      mac: true,
      released: false,
    },
    failed: {
      code: "creation_unknown",
      provider: "instabox",
      mac: true,
      released: false,
    },
    released: {
      code: "host_unavailable",
      provider: "instabox",
      mac: true,
      released: true,
    },
  };
  if (failures[name])
    return (
      <ProviderFailureCard
        failure={{
          ...failures[name]!,
          canRetry: ["github", "key", "capacity"].includes(name),
        }}
        onCheck={() => {}}
        onRetry={() => {}}
        onLog={() => {}}
      />
    );
  throw Error(`Unknown scene ${name}`);
}
export const renderScene = (name: string) => renderToStaticMarkup(scene(name));
