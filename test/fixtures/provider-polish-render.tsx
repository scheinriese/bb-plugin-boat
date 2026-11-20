import { OwnMacRefusalCard, OwnMacRentalCard, OwnMacFallbackLine, OwnMacCleanupCard } from "../../web/own-mac-cards";
import { CREDENTIAL_CLEANUP_SCRIPT } from "../../src/credentials";
import type { OwnMacFacts, OwnMacNotice } from "../../contract-ownmac";
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
import { ProviderRow, RunsOnLine, ChipProvider } from "../../web/providers";
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
  if (name.startsWith("ownmac-")) {
    const codes:Record<string,NonNullable<OwnMacFacts["code"]>>={"ownmac-power-unknown":"power","ownmac-setup-user":"setup","ownmac-target-changed":"target","ownmac-available":"available","ownmac-user":"available","ownmac-busy":"busy","ownmac-asleep":"unreachable","ownmac-paused":"paused","ownmac-battery":"battery","ownmac-memory":"memory","ownmac-logged-out":"session","ownmac-refused-personal-login":"personal","ownmac-refused-admin":"admin","ownmac-cleanup":"cleanup","ownmac-not-set-up":"setup","ownmac-setup-test-failed":"setup","ownmac-setup-success":"off","ownmac-setup-battery":"battery","ownmac-off":"off","ownmac-footer":"busy"};
    const statuses:Record<string,string>={power:"Power state unknown",target:"Test connection again",available:"Available",busy:"At task limit",unreachable:"Asleep or unreachable",paused:"Paused",battery:"On battery",memory:"Not enough free memory",session:"No logged-in session",personal:"Can't use · your own login",admin:"Can't use · admin user",cleanup:"Logins left behind",setup:"Not set up",off:"Off"};
    const cleanup={failed:true,checkedAt:"2030-01-01T16:20:00Z",taskIds:["ownmac_fake_task"],steps:'# In the fake agents account\n(\nexport HOME="$HOME/.bb-ownmac/ownmac_fake_task"\nexport PATH="$HOME/.local/bin:$PATH"\n'+CREDENTIAL_CLEANUP_SCRIPT+')\n'};
    const make=(scene:string):SandboxProviderDto=>{
      const code=codes[scene] ?? "available",setup=scene.startsWith("ownmac-setup") || scene==="ownmac-not-set-up";
      const f:OwnMacFacts={code,status:statuses[code]!,alias:scene==="ownmac-not-set-up"?"":"fake-mac-agents",enabled:!setup && scene!=="ownmac-off",running:code==="busy"?1:0,max:1,vm:scene==="ownmac-user" || scene==="ownmac-setup-user" || code==="admin"?false:scene==="ownmac-not-set-up" || scene==="ownmac-setup-test-failed"?null:true,freeMiB:code==="memory"?3072:14336,account:code==="personal"?undefined:"fake-agents",onPower:code==="power"?null:code!=="battery",loggedIn:code!=="session",checkedAt:new Date(Date.now()-20000).toISOString(),since:code==="unreachable"?"2030-01-01T18:40:00Z":null,tested:!setup || ["ownmac-setup-success","ownmac-setup-battery"].includes(scene),setupSteps:scene==="ownmac-not-set-up"?0:scene==="ownmac-setup-user"?1:scene==="ownmac-setup-test-failed"?4:setup?5:7,tasksThisMonth:9,runningTitles:["Fix the fake share sheet crash"],...(code==="cleanup"?{cleanup}: {})};
      if(scene==="ownmac-setup-test-failed")f.testResult={ok:false,title:"Couldn't sign in as fake-mac-agents",detail:"The alias was found and the Mac answered, but the agents account didn't accept your SSH key. Add your public key to that account's ~/.ssh/authorized_keys, then test again.",checkedAt:new Date().toISOString()};
      if(scene==="ownmac-setup-success" || scene==="ownmac-setup-battery")f.testResult={ok:true,title:"Connected as fake-agents",detail:`Standard user, not you · macOS VM · 14 GB free · ${scene==="ownmac-setup-battery"?"on battery":"on power"}`,checkedAt:new Date().toISOString()};
      const ownMac={ownMacIsolation:scene==="ownmac-setup-user" || scene==="ownmac-user"?"user" as const:"vm" as const,ownMacAlias:f.alias!,ownMacEnabled:f.enabled!,ownMacPaused:code==="paused",ownMacMaxTasks:1,running:f.running,max:1,facts:f};
      return {id:"ownmac",label:"Your Mac",kind:"own-mac",isDefault:false,available:true,enabled:f.enabled!,connection:code==="available"?"connected":"not-connected",meta:`${f.alias} · SSH`,summary:"$0 rent",pricing:"$0 rent",systems:[],apiKey:null,status:f.status,ownMac};
    };
    const row=(provider:SandboxProviderDto)=><ProviderRow provider={provider} onOwnMacSave={()=>{}} onOwnMacTest={()=>{}} onOwnMacStep={()=>{}} onOwnMacCleanup={()=>{}}/>;
    const box=(children:React.ReactNode)=><div className="max-w-[760px] divide-y divide-[#222222] overflow-hidden rounded-[10px] border border-[#262626] bg-[#181818]">{children}</div>;
    const quote={id:"fake-quote",provider:"instabox",label:"Instabox",model:"fake-m2",modelLabel:"Mac M2",minimumCost:10.8,hourPrice:0.45,minimumHours:24,currency:"USD",expiresAt:"2030-01-01T00:00:00Z"};
    const notice:OwnMacNotice={taskId:"fake-task",title:"Fix the fake share sheet crash",alias:"fake-mac-agents",reason:"asleep or unreachable",offer:quote};
    if(name==="ownmac-states")return box(["ownmac-available","ownmac-busy","ownmac-paused","ownmac-asleep","ownmac-battery","ownmac-memory","ownmac-logged-out"].map(scene=><div key={scene}>{row(make(scene))}</div>));
    if(name==="ownmac-refusals")return <div className="space-y-6">{box(row(make("ownmac-refused-personal-login")))}{box(row(make("ownmac-refused-admin")))}<OwnMacRefusalCard notice={{...notice,reason:"can't be used",refusal:"personal"}} onTest={()=>{}} onRent={()=>{}}/><OwnMacRefusalCard notice={{...notice,offer:undefined,reason:"can't be used",refusal:"admin",account:"fake-agents",fallback:{provider:"fake-monthly",label:"Fake monthly",monthly:true,paidUntil:null}}} onTest={()=>{}}/></div>;
    if(name==="ownmac-mobile")return <div className="mx-auto max-w-[358px]"><OwnMacRefusalCard notice={{...notice,reason:"can't be used",refusal:"personal"}} onTest={()=>{}} onRent={()=>{}}/></div>;
    if(name==="ownmac-fallback")return <div className="space-y-6"><OwnMacFallbackLine notice={{...notice,offer:undefined,reason:"asleep",fallback:{provider:"fake-monthly",label:"Fake monthly",monthly:true,paidUntil:null}}}/><OwnMacFallbackLine notice={{...notice,title:"Add fake widget previews",offer:undefined,reason:"busy (1 of 1)",fallback:{provider:"instabox",label:"Instabox",monthly:false,paidUntil:"2030-01-01T14:00:00Z"}}}/><OwnMacRentalCard notice={notice} onAnswer={()=>{}} onOwnWords={()=>{}}/></div>;
    if(name==="ownmac-explicit-rental")return <OwnMacRentalCard notice={{...notice,canWaitForOwnMac:false}} onAnswer={()=>{}}/>;
    if(name==="ownmac-receipt")return <OwnMacRentalCard notice={{...notice,answer:"rent",replacementId:"fake-replacement"}}/>;
    if(name==="ownmac-waiting")return <OwnMacRentalCard notice={{...notice,answer:"wait"}}/>;
    if(name==="ownmac-cleanup-card")return <OwnMacCleanupCard cleanup={cleanup} title={notice.title} onCheck={()=>{}}/>;
    if(name==="ownmac-cleanup-removed")return <OwnMacCleanupCard cleanup={{...cleanup,failed:false,steps:"",taskIds:[]}} title={notice.title}/>;
    const provider=make(name),usage={...mac,ownMac:{...provider.ownMac!.facts!,rent:0 as const},held:[]};
    const taskRunsOn={provider:"ownmac",label:"Your Mac",os:"macos" as const,machine:"VM",note:"$0",detail:"$0 · keep it awake and on power"};
    if(name==="ownmac-footer")return <div className="space-y-6"><div className="max-w-[298px] space-y-3 rounded-xl border border-[#303030] bg-[#202020] p-3.5"><p className="flex justify-between text-[13px] font-semibold">Cloud sandboxes <span className="text-xs font-normal text-[#A8A8A8]">7 on</span></p><FooterUsage providers={[provider]} plan={plan} mac={usage} boatOn={3} cap={300} day={{hours:1.6,dollars:0.92}}/></div><ThisMonthUsage plan={plan} mac={usage} instabox={linux}/><div className="rounded-lg border border-[#262626] px-3.5 py-3 text-[13px] text-[#A8A8A8]">Fix the fake share sheet crash <span className="ml-6">Your Mac · VM</span><span className="ml-6">$0</span><span className="ml-6">Running · 12 min</span></div></div>;
    if(name!=="ownmac-available")return box(row(provider));
    return <div className="space-y-6">{box(row(provider))}<div className="max-w-[720px] divide-y divide-[#222222] rounded-[10px] border border-[#2A2A2A] bg-card text-[13px]"><p className="px-3.5 py-2.5">1 task · fake sample</p><div className="px-3.5 py-[9px]"><p className="mb-0.5 text-[#E2E2E2]">{notice.title}</p><RunsOnLine runsOn={taskRunsOn}/></div></div><span className="inline-flex items-center gap-1.5 rounded-md border border-[#2E2E2E] bg-[#222222] px-2 py-px text-xs">{notice.title} <ChipProvider runsOn={taskRunsOn}/><span className="size-1.5 rounded-full bg-[#6E6E6E]"/></span><div className="flex min-h-9 max-w-[720px] flex-wrap items-center justify-between gap-2 border-y border-[#262626] py-2"><RunsOnLine runsOn={{...taskRunsOn,note:null}}/><span className="text-xs text-[#6E6E6E]">{taskRunsOn.detail}</span></div></div>;
  }
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
