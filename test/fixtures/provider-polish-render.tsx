import { TodayStartHereActions } from "../../web/today-start-here";
import { MonthlyMacCard } from "../../web/monthly-mac";
import { LeaseDayMeter } from "../../web/mac-usage";
import { MONTHLY_MAC_PRICES } from "../../src/monthly-macs";
import type { MonthlyMacSuggestion } from "../../contract-monthly-macs";
import { MacLeaseNotice } from "../../web/mac-lease-notices";
import { CREDENTIAL_RISKS_URL, CLEANUP_NOTICE_PREFIX, TOKEN_REVOCATION_NOTICE_PREFIX } from "../../credential-warnings";
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
  status: "Connected",
  waitingTasks: 1,
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
      id: "rented-github", required: false, label: "GitHub token stored", done: false, possible: true,
      detail: "Only repository tasks need GitHub token for rented machines in bb secret settings: selected repos; Contents, Pull requests and Workflows read and write; 90-day expiry",
    },
    {
      id: "agent-route", label: "Agent route available", done: true, possible: true, docsUrl: CREDENTIAL_RISKS_URL,
      detail: "Account Pooler via bb Connect: Codex. Any process on the Mac can use your pooled AI quota until bb removes the machine. Held local Keychain logins need separate verification.",
    },
    {
      id: "logins",
      label: "Logins on fresh Macs",
      done: true,
      possible: true,
      detail: "Agent route ready; repository tasks also need GitHub",
    },
    { id: "enabled", label: "On", done: true, possible: true, detail: "Credentials are checked for the chosen agent and repositories before rental" },
  ],
};
export const monthlySuggestion: MonthlyMacSuggestion = {
  id:"sample-monthly", group:"instabox:USD",kind:"rent",createdAt:"2026-11-20T00:00:00Z",
  candidate:MONTHLY_MAC_PRICES[1]!,alternatives:[MONTHLY_MAC_PRICES[5]!],dayProvider:"instabox",chip:"M2",ramGB:16,currency:"USD",days:16,cost:172.8,dayRate:10.8,breakEven:119.99/10.8,forecast:{low:15,base:18,high:22},savings:74.41,answer:null,answeredAt:null,
};
export function scene(name: string) {
  if(name==="monthly-zero")return <ThisMonthUsage plan={plan} mac={{...mac,byProvider:undefined,month:{leaseDays:1,costs:{USD:10.8}},rolling30:{leaseDays:0,costs:{}},monthlyComparisons:[{dayProvider:"instabox",currency:"USD",candidate:monthlySuggestion.candidate,breakEven:monthlySuggestion.breakEven}],monthlySuggestions:[]}}/>;

  if(name==="monthly-today-alone")return <div className="max-w-[720px]"><p className="mb-6 text-[13px] text-[#A8A8A8]">0 need you · 1 in progress</p><h3 className="text-sm font-medium">Start here</h3><MonthlyMacCard suggestion={monthlySuggestion} project="iOS app"/><TodayStartHereActions>{[]}{[]}</TodayStartHereActions></div>;
  if(name==="today-actions")return <TodayStartHereActions><p>Choose a sign-in flow</p></TodayStartHereActions>;
  if(name==="today-actions-empty")return <TodayStartHereActions>{[]}{null}{false}</TodayStartHereActions>;

  if(name==="monthly-chat")return <div className="max-w-[720px]"><p className="mb-4 text-[13px] text-[#A8A8A8]">The UI tests are running on an Instabox Mac. Your Mac leases have added up; one cost suggestion:</p><MonthlyMacCard suggestion={monthlySuggestion} onAnswer={()=>{}}/><p className="mt-4 rounded-lg border border-[#2A2A2A] p-3 text-xs text-[#A8A8A8]">● 1 working · The UI tests go on; nothing waits on this</p></div>;
  if(name==="monthly-today")return <div className="max-w-[720px]"><p className="mb-6 text-[13px] text-[#A8A8A8]"><span className="text-[#F0B135]">● 2 need you</span> · 1 ready · 1 in progress</p><h3 className="text-sm font-medium">Start here</h3><MonthlyMacCard suggestion={monthlySuggestion}/><div className="divide-y divide-[#262626] rounded-lg border border-[#262626] text-[13px]"><p className="p-3.5">Which sign-in flow should the app use?</p><p className="p-3.5">Review the new onboarding screens</p></div></div>;
  if(name==="monthly-usage")return <ThisMonthUsage plan={plan} instabox={linux} mac={{...mac,byProvider:undefined,month:{leaseDays:16,costs:{USD:172.8}},rolling30:{leaseDays:16,costs:{USD:172.8}},monthlyComparisons:[{dayProvider:"instabox",currency:"USD",candidate:monthlySuggestion.candidate,breakEven:monthlySuggestion.breakEven}],monthlySuggestions:[monthlySuggestion]}} active={3} cap={300} idleMinutes={60}/>;
  if(name==="monthly-below")return <ThisMonthUsage plan={plan} mac={{...mac,byProvider:undefined,month:{leaseDays:5,costs:{USD:54}},rolling30:{leaseDays:5,costs:{USD:54}},monthlyComparisons:[{dayProvider:"instabox",currency:"USD",candidate:monthlySuggestion.candidate,breakEven:monthlySuggestion.breakEven}],monthlySuggestions:[]}}/>;
  if(name==="monthly-receipt")return <MonthlyMacCard suggestion={{...monthlySuggestion,answer:"keep",answeredAt:"2026-11-20T00:01:00Z"}}/>;
  if(name==="monthly-own")return <MonthlyMacCard suggestion={{...monthlySuggestion,answer:"own",answeredAt:"2026-11-20T00:01:00Z"}}/>;
  if(name==="monthly-cancel")return <MonthlyMacCard suggestion={{...monthlySuggestion,kind:"cancel",days:3,forecast:{low:2,base:3,high:4},savings:-87.59}}/>;
  if(name==="meter-over")return <LeaseDayMeter days={45} breakEven={12} showCount/>;
  if(name==="meter-outside")return <LeaseDayMeter days={5} breakEven={35}/>;
  if(name === "credential-revocation") {
    const text = `${TOKEN_REVOCATION_NOTICE_PREFIX} Revoke or rotate the GitHub token in GitHub settings; it may still be on returned hardware (example-mac). This reminder stays until the recorded token expiry passes.`;
    return <div className="space-y-4"><ProviderRow provider={{...scaleway,waitingTasks:0,releaseNotice:text,status:"Credential action required"}}/><MacLeaseNotice notice={{id:"token-revocation:example-lease",provider:"scaleway",label:"Scaleway",machineId:"example-mac",at:"2030-01-01T00:00:00Z",text,tokenRevocation:true,expiresAt:"2030-04-01T00:00:00Z"}}/></div>;
  }

  if(name === "credential-settings-ready") return <ProviderRow provider={{...scaleway,waitingTasks:0}}/>;
  if(name === "credential-cleanup") return <ProviderRow provider={{...scaleway,releaseNotice:`${CLEANUP_NOTICE_PREFIX} Scaleway Mac example-mac keeps billing. The plugin will retry cleanup once SSH works. The owner must open the Scaleway console → Apple silicon → select the Mac → Delete after its minimum. Revoke or rotate the GitHub token because it may still be on the Mac. No cleanup bypass is available in the plugin.`}}/>;

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
