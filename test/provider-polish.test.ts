import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  hours,
  money,
  resetDate,
  leaseTime,
  leaseState,
} from "../web/provider-format.ts";
import { providerFailureCard } from "../provider-failure.ts";
import { runsOnDetail, runsOnNote } from "../web/providers-logic.ts";
const temporary = mkdtempSync(join(process.cwd(), ".provider-polish-"));
after(() => rmSync(temporary, { recursive: true, force: true }));
await build({
  entryPoints: ["test/fixtures/provider-polish-render.tsx"],
  outfile: join(temporary, "render.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  logLevel: "silent",
});
const { renderScene } = (await import(
  pathToFileURL(join(temporary, "render.mjs")).href
)) as { renderScene(name: string): string };

test("Harbormaster copy keeps provider names and existing settings links", () => {
  const settings = renderScene("settings");
  assert.match(settings, /Harbormaster only checks that it exists/);
  for (const provider of ["boat.dev", "Instabox", "Scaleway"]) {
    assert.ok(settings.includes(provider), provider);
  }
  const notice = renderScene("fresh");
  assert.match(notice, /Harbormaster needs a GitHub token/);
  assert.match(notice, /Scaleway needs task credentials/);
  assert.match(notice, /href="\/settings\/plugins\/boat"/);
  assert.doesNotMatch(notice + settings, /\bBoat\b/);
});

test("product numbers and dates use English US independently of the host locale", () => {
  assert.equal(hours(2777.78), "2,778");
  assert.equal(hours(2643.77), "2,644");
  assert.equal(hours(1.6), "1.6");
  assert.equal(money(0.45), "$0.45");
  assert.equal(money(5.28, "EUR"), "€5.28");
  assert.equal(resetDate("2026-12-01T00:00:00Z"), "Dec 1");
  assert.equal(leaseTime("2026-11-19T14:00:00Z", "UTC"), "Thu 14:00");
});
test("usage rows show independent provider periods and separate Mac accounting", () => {
  const html = renderScene("usage");
  for (const value of [
    "Each provider on its own billing period",
    "2,778 h",
    "resets Dec 19",
    "resets Dec 1",
    "$6.40 of $20 credit",
    "14 lease-days · $151.20",
    "Bills per second after 24 h",
  ])
    assert.ok(html.includes(value), value);
  assert.ok(html.indexOf("boat.dev") < html.indexOf("Instabox"));
  assert.doesNotMatch(html, /This month|2\.777|2,643\.77/);
  const eur = renderScene("scaleway");
  assert.match(eur, /Mac · Scaleway/);
  assert.match(eur, /€41\.20/);
  assert.doesNotMatch(eur, /\$41|Break-even/);
});
for (const [name, values] of Object.entries({
  unused: ["$0.00 of $20 credit", "No sandboxes yet this period"],
  over: ["$3.10 over credit", "#FC8C45"],
  off: ["Instabox and Scaleway are off", "Sandbox providers"],
  unknown: ["$6.40 so far", "period unavailable"],
  unavailable: ["Usage unavailable", "Check provider setup"],
  kept: ["Kept · hand-back off", "$0.45 / h while kept"],
  scheduled: ["Release scheduled", "nothing waiting"],
  elapsed: ["Bills per second", "$0.45 / h since"],
  "no-lease": ["No lease now"],
}))
  test(`rendered usage state: ${name}`, () => {
    const html = renderScene(name);
    for (const value of values) assert.ok(html.includes(value), value);
  });
test("footer variants omit off providers and unheld Macs; Today never converts EUR", () => {
  const all = renderScene("footer"),
    boat = renderScene("boat-footer");
  for (const value of [
    "6 on",
    "Instabox · Linux",
    "Paid until",
    "$0.92 · €1.10",
    "1.6 sandbox hours · Mac lease not included",
    "reset Dec 19",
    "resets Dec 1",
  ])
    assert.ok(all.includes(value), value);
  assert.doesNotMatch(boat, /Instabox|Mac ·|€|Sandboxes on/);
  assert.match(boat, /3 on of 300/);
  assert.doesNotMatch(
    renderScene("no-mac-footer"),
    /Mac · Instabox|Paid until/,
  );
});
for (let step = 0; step < 5; step++)
  test(`setup highlights exactly the first incomplete step ${step + 1}`, () => {
    const html = renderScene(`step-${step}`);
    assert.equal((html.match(/>Next<\/span>/g) ?? []).length, 1);
    assert.match(html, new RegExp(`${step + 1}<\/span>`));
    assert.doesNotMatch(html, /value="ibk_|test-only/);
  });
test("setup regression, waiting owner, complete collapse, and actionable Scaleway credentials", () => {
  assert.match(renderScene("waiting"), /1 task waiting/);
  assert.match(renderScene("waiting"), /#3D3420/);
  assert.match(renderScene("regressed"), /Instabox rejected the key/);
  assert.doesNotMatch(renderScene("complete"), />Next<|setup steps/);
  const html = renderScene("settings");
  assert.match(html, /GitHub token stored/);
  assert.match(html, /Agent route available/);
  assert.doesNotMatch(html, /Held Macs only/);
  assert.match(html, /Logins on fresh Macs/);
  assert.doesNotMatch(html, /border-dashed/);
  assert.match(html, /target="_blank"/);
});
for (const name of ["github", "key", "capacity", "fresh", "failed", "released"])
  test(`blocked/error card: ${name}`, () => {
    const html = renderScene(name);
    assert.ok(
      html.includes(
        name === "github" || name === "key"
          ? "border-[#3D3420]"
          : name === "capacity" || name === "fresh"
            ? "border-[#2A2A2A]"
            : "border-[#3A2424]",
      ),
    );
    if (name === "github") {
      assert.match(html, /GH_TOKEN/);
      assert.match(html, /github.com, api.github.com/);
      assert.match(html, /never in chat/);
    }
    if (name === "capacity") {
      assert.match(html, /does not retry automatically/);
      assert.match(html, /Try now/);
      assert.doesNotMatch(html, /Stop trying|10 minutes|2 hours/);
    }
    if (name === "failed") {
      assert.match(html, /paid lease may still be held/);
      assert.doesNotMatch(html, /Harbormaster released it|>Retry</);
    }
    if (name === "released") assert.match(html, /Harbormaster released it/);
  });
test("per-second task lines, sharers, and hourly Scaleway state", () => {
  const html = renderScene("lines");
  assert.match(html, /Instabox · Linux · per second/);
  assert.match(html, /same Mac, paid until/);
  assert.match(html, /Scaleway · Mac mini M2 · held Mac, paid until/);
  assert.doesNotMatch(html, /lease ends|a day/);
  const runsOn = {
    provider: "scaleway",
    label: "Scaleway",
    machine: "Mac mini M2",
    os: "macos" as const,
    note: null,
    detail: null,
    lease: {
      paidUntil: "2026-11-19T14:00:00Z",
      endedAt: null,
      shared: false,
      kept: false,
      releaseAt: null,
      hourPrice: 0.22,
      currency: "EUR",
      billingIncrementSeconds: 3600,
    },
  };
  assert.equal(
    runsOnNote(runsOn, Date.parse("2026-11-20T00:00:00Z")),
    "bills hourly",
  );
  assert.match(
    runsOnDetail(runsOn, Date.parse("2026-11-20T00:00:00Z"))!,
    /€0.22 \/ h since/,
  );
  const unknown = providerFailureCard({
    code: "creation_unknown",
    provider: "instabox",
    mac: true,
    released: false,
    canRetry: false,
  })!;
  assert.doesNotMatch(unknown.body, /released it/);
});

test("owned stopped rows retain hover Delete beside Resume; unowned rows only show Delete",()=>{
 const html=renderScene("sandbox-actions");
 const owned=html.split('data-owner="task"')[1]!.split('data-owner="unowned"')[0]!;
 const unowned=html.split('data-owner="unowned"')[1]!;
 assert.match(owned,/>Delete</);assert.match(owned,/>Resume</);assert.match(owned,/group-hover:opacity-100/);
 assert.match(unowned,/>Delete</);assert.doesNotMatch(unowned,/>Resume<|group-hover:opacity-100/);
});
test("footer groups held Macs by provider; fallback hours and failed mobile headers are explicit",()=>{
 const html=renderScene("multi-lease-footer");assert.equal((html.match(/2 on ·/g) ?? []).length,2);assert.equal((html.match(/Mac · Instabox/g) ?? []).length,1);assert.doesNotMatch(html,/1 held/);
 assert.match(renderScene("running-only"),/running machines only/);
 const failed=renderScene("failed");assert.match(failed,/Mac start/);assert.doesNotMatch(failed,/Instabox setup/);
 assert.doesNotMatch(renderScene("settings"),/\$20.00 monthly/);
});

test("monthly guidance uses the blue shared decision frame, responsive options, dated currency-safe copy",()=>{
 const html=renderScene("monthly-chat");
 for(const value of ["Suggestion","from Harbormaster","Recommended","Rent a monthly Mac ↗","Keep day leases","Use my own Mac","Prices as of 2026-11-20","€149.00","No cross-currency savings estimate","Own-Mac setup guidance is coming","sm:hidden","hidden sm:block","border-[#2A3A55]"])assert.ok(html.includes(value),value);
 assert.doesNotMatch(html,/Needs you|never.*Boat/);
 assert.match(renderScene("monthly-today"),/2 need you/);
 assert.match(renderScene("monthly-receipt"),/You chose Keep day leases.*snoozed for 2 weeks/);
 assert.match(renderScene("monthly-own"),/setup guidance is coming/);
 assert.match(renderScene("monthly-cancel"),/Review cancellation ↗/);
 assert.doesNotMatch(renderScene("monthly-receipt"),/Recommended/);
});
test("Mac usage adds the actionable monthly link and a marker below break-even and a link only above it",()=>{
 const html=renderScene("monthly-usage");
 assert.match(html,/Monthly M4: \$119.99 \/ mo/);assert.match(html,/Break-even ≈ 11 days/);
 assert.match(html,/bg-\[#FC8C45\]/);
 const below=renderScene("monthly-below");assert.doesNotMatch(below,/Monthly M4/);assert.match(below,/Break-even ≈ 11 days/);
 assert.match(renderScene("meter-over"),/width:100%/);
 assert.doesNotMatch(renderScene("meter-outside"),/Break-even|h-3.5/);
});

test("Today has no empty action box when guidance is the only Start here item",()=>{
 assert.equal(renderScene("today-actions-empty"),"");
 assert.match(renderScene("today-actions"),/border-border bg-card/);
 const html=renderScene("monthly-today-alone");assert.match(html,/0 need you/);assert.doesNotMatch(html,/divide-y divide-border/);
 const card=renderScene("monthly-chat");assert.match(card,/Mac costs · today/);assert.match(card,/>0<\/span>/);assert.doesNotMatch(card,/\$0\.00/);
});

test("zero rolling use retains the matching price target and Today names the project",()=>{
 const zero=renderScene("monthly-zero");assert.match(zero,/Break-even ≈ 11 days/);assert.doesNotMatch(zero,/Monthly M4:/);
 assert.match(renderScene("monthly-today-alone"),/Mac costs · iOS app · today/);
});

test("Settings exposes the pooled quota risk and a working documentation anchor even when steps collapse", () => {
  const html=renderScene("credential-settings-ready");
  assert.match(html,/Any process on the Mac can use your pooled AI quota until bb removes the machine/);
  assert.match(html,/href="https:\/\/github.com\/scheinriese\/bb-plugin-boat\/blob\/main\/docs\/settings.md#rented-machine-credential-risks"/);
});
test("cleanup failure explains manual console recovery without a plugin bypass",()=>{
  const html=renderScene("credential-cleanup");
  assert.match(html,/keeps billing/);assert.match(html,/retry cleanup once SSH works/);
  assert.match(html,/Scaleway console/);assert.match(html,/Revoke or rotate/);
  assert.doesNotMatch(html,/Delete without verified cleanup|Owner approval|type="checkbox"/);
});

test("post-deletion token reminder shows expiry without a dismissal action",()=>{
  const html=renderScene("credential-revocation");
  assert.match(html,/GitHub token action required/);assert.match(html,/returned hardware/);
  assert.match(html,/recorded token expiry/);assert.match(html,/2030-04-01/);
  assert.doesNotMatch(html,/Dismiss|Delete without|Owner approval/);
});

for (const [scene,status] of [["ownmac-paused","Paused"],["ownmac-battery","On battery"],["ownmac-memory","Low memory · 3 GB free"],["ownmac-logged-out","Not logged in"],["ownmac-refused-personal-login","Can't use · your own login"],["ownmac-refused-admin","Can't use · admin user"],["ownmac-cleanup","Logins left behind"]]) test(`Your Mac state: ${scene}`,()=>{
  const html=renderScene(scene!);assert.ok(html.includes(status!.replaceAll("'","&#x27;")));assert.match(html,/Your Mac/);assert.match(html,/fake-mac-agents · SSH/);
});
test("Your Mac available row follows the completed design and detects isolation",()=>{
  const html=renderScene("ownmac-available");for(const text of ["fake-mac-agents · SSH","Available","$0 rent. Awake and on power","Use for Mac tasks","SSH alias","Runs in","Agents never run in your own login.","macOS VM","detected","Tasks at once","Pause"])assert.ok(html.includes(text),text);
  assert.match(html,/role="switch"[^>]*aria-checked="true"/);assert.doesNotMatch(html,/role="radiogroup"/);
});
test("first setup has seven steps and a read-only connection result",()=>{
  const html=renderScene("ownmac-setup-test-failed");for(const text of ["Setting up · 4 of 7","Chose where agents run","Created the VM","Remote Login on","SSH alias added","Test connection","Logged in and on power","Turned on","Couldn&#x27;t sign in as fake-mac-agents","Test again","It changes nothing"])assert.ok(html.includes(text),text);
  const first=renderScene("ownmac-not-set-up");assert.match(first,/role="radiogroup"/);assert.match(first,/macOS VM \(recommended\)/);
});
test("low-memory copy comes from the shared 6 GB policy",()=>{assert.match(renderScene("ownmac-memory"),/A task needs 6 GB free/);assert.doesNotMatch(renderScene("ownmac-memory"),/8 GB free/);});
test("cleanup uses the generic failed-check card and exact command family",()=>{
  const html=renderScene("ownmac-cleanup-card");for(const text of ["Login cleanup couldn&#x27;t be verified","automatically paused","Check again","Copy steps","gh auth logout","claude auth logout","codex logout"])assert.ok(html.includes(text),text);
  assert.doesNotMatch(html,/still there|2 logins|type.*\/logout|>Remove</);
});
test("refusal, fallback and consent cards use the supplied style and real quote fields",()=>{
  const refusal=renderScene("ownmac-refusals");assert.match(refusal,/your own login/);assert.match(refusal,/physical Mac/);assert.match(refusal,/at no extra cost/);
  const card=renderScene("ownmac-fallback");for(const text of ["Needs you","Nothing is rented until you confirm","Rent Instabox Mac · $10.80 USD","then $0.45 / h","Wait for your Mac","no new cost"])assert.ok(card.includes(text),text);
});
test("footer and usage include task counts, no meter and zero rent",()=>{
  const html=renderScene("ownmac-footer");for(const text of ["7 on","Running 1 of 1","$0 · fake-mac-agents · on power","9 tasks this month","$0 rent","Your Mac · VM"])assert.ok(html.includes(text),text);
});

test("a changed Your Mac target uses the existing amber refusal style",()=>{
  const html=renderScene("ownmac-target-changed");assert.match(html,/Test connection again/);assert.match(html,/bg-\[#F0B135\]/);assert.doesNotMatch(html,/Setting up|Administrator/);
});
test("Your Mac UI explains guest power cannot prove the host is on mains",()=>{
  const html=renderScene("ownmac-available");assert.match(html,/power is read from the guest/);assert.match(html,/host battery use may not be detected/);
});
test("an explicit rental choice does not offer automatic Your Mac waiting",()=>{
  const html=renderScene("ownmac-explicit-rental");assert.match(html,/Your choice applies to this task only/);assert.match(html,/Choose Your Mac in Runs on/);assert.doesNotMatch(html,/Wait for your Mac/);assert.match(html,/Rent Instabox Mac · \$10.80/);
});

test("separate-user setup explains how the owner makes the personal home private",()=>{
  const html=renderScene("ownmac-setup-user");for(const text of ["Created the user","In your personal account","chmod 700 ~","Get Info","personal home folder is unreadable"])assert.ok(html.includes(text),text);
  assert.doesNotMatch(renderScene("ownmac-setup-test-failed"),/chmod 700/);
});
test("unknown power has the orange status and routes new starts elsewhere",()=>{
  const html=renderScene("ownmac-power-unknown");assert.match(html,/Power state unknown/);assert.match(html,/bg-\[#FC8C45\]/);assert.match(html,/next Mac in line/);assert.doesNotMatch(html,/Asleep or unreachable/);
});


test("Mac rental choices use responsive controls and bind visible consent to one provider", () => {
  const html = renderScene("ownmac-rental-choices");
  assert.doesNotMatch(html, /min-w-\[560px\]|<table|overflow-x-auto|Runs now/);
  assert.equal((html.match(/type="radio"/g) ?? []).length, 2);
  assert.equal((html.match(/>Rent (?:Scaleway|Instabox) Mac · /g) ?? []).length, 1, "one visible approve action");
  for (const text of ["$10.80", "USD total for the first 24 h", "€5.28", "EUR total for the first 24 h", "24 h, paid even if handed back sooner", "then €0.22 / h", "Recommended", "Project preference: Scaleway", "No exchange rate is assumed", "Approve one Scaleway Mac mini M4 rental for this task", "paid Claude usage", "Unavailable choices", "No compatible model", "Refresh offers"]) assert.ok(html.includes(text), text);
  assert.match(html, /Rent Scaleway Mac · €5.28 EUR/);
  const remoteNotice = html.indexOf("Remote computer use is not confirmed by these quotes.");
  assert.ok(remoteNotice >= 0 && remoteNotice < html.indexOf("Rent Scaleway Mac ·"), "remote-use uncertainty is visible before spending consent");
  const beforeNotice = html.slice(0, remoteNotice);
  assert.ok(beforeNotice.lastIndexOf("<details") <= beforeNotice.lastIndexOf("</details>"), "remote-use notice is outside collapsed details");
  assert.match(html, /type="radio"[^>]*checked=""[^>]*\/>/);
});

test("Mac rental expiry, starting, failure and unavailable states stay actionable", () => {
  const expired = renderScene("ownmac-rental-expired");
  assert.match(expired, /This quote expired/);
  assert.match(expired, /<button[^>]*disabled=""[^>]*><span[^>]*>Rent Scaleway Mac/);
  assert.match(expired, /Refresh offers/);
  const starting = renderScene("ownmac-rental-starting");
  assert.match(starting, /aria-busy="true"/);
  assert.match(starting, /Starting rental…/);
  assert.match(starting, /<fieldset[^>]*disabled=""/);
  assert.match(renderScene("ownmac-rental-error"), /role="alert"[^>]*>The selected model is no longer available/);
  const unavailable = renderScene("ownmac-rental-unavailable");
  assert.match(unavailable, /No rental offer is available/);
  assert.match(unavailable, /Refresh offers/);
  assert.doesNotMatch(unavailable, />Rent (?:Scaleway|Instabox) Mac · /);
  assert.match(renderScene("ownmac-explicit-rental"), /Rent Instabox Mac · \$10.80 USD/, "legacy single offer remains readable");
});

test("an ambiguous rental start offers inspection without another approval", () => {
  const html = renderScene("ownmac-rental-unknown");
  assert.match(html, /a rental may already exist/);
  assert.match(html, /Inspect the task/);
  assert.doesNotMatch(html, /nothing is rented|>Rent (?:Scaleway|Instabox) Mac · |Refresh offers/);
});


test("designer handoff keeps native radio accessibility and expanded selected machine facts", () => {
  const html = renderScene("ownmac-rental-choices");
  assert.match(html, /role="radiogroup" aria-label="Mac rental providers"/);
  for (const token of ["border-[#5C82C9]", "bg-[#1A1F27]", "border-[1.5px]", "accent-[#7AA7FF]", "text-[#FC8C45]", "min-h-[52px]", "min-h-11", "10 cores · 16 GB memory", "fr-par-1", "One rental, for this task.", "Runs on", "Selected quote checked"]) assert.ok(html.includes(token), token);
  assert.ok(html.indexOf("Scaleway · Mac mini M4") < html.indexOf("Instabox · Mac M2"), "recommended choice leads the comparison");
  assert.match(html, /No exchange rate is assumed/);
  const queued = renderScene("ownmac-rental-queued");
  assert.match(queued, /Kept queued/);
  assert.match(queued, /Nothing was rented/);
  assert.match(queued, /Rent Scaleway Mac/);
});


test("empty rental offers keep Your Mac waiting and queue actions available without spending consent", () => {
  for (const scene of ["ownmac-rental-empty-wait", "ownmac-rental-empty-waiting", "ownmac-rental-empty-queued"]) {
    const html = renderScene(scene);
    assert.match(html, /No rental offer is available/);
    assert.doesNotMatch(html, /type="radio"|>Rent (?:Scaleway|Instabox) Mac · /);
    for (const label of ["Wait for your Mac", scene.endsWith("queued") ? "Kept queued" : "Keep it queued", "Refresh offers"]) {
      const button = html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0];
      assert.ok(button, `${scene}: ${label} is present`);
      assert.doesNotMatch(button, /\sdisabled(?:=|\s|>)/, `${scene}: ${label} remains enabled`);
    }
    if (scene.endsWith("waiting")) assert.match(html, /Waiting for your Mac/);
    if (scene.endsWith("queued")) assert.match(html, /Kept queued. Nothing was rented/);
  }
  const busy = renderScene("ownmac-rental-empty-busy");
  assert.match(busy, /aria-busy="true"/);
  assert.match(busy, /<button[^>]*disabled=""[^>]*>Wait for your Mac<\/button>/);
  assert.match(busy, /<button[^>]*disabled=""[^>]*>Keep it queued<\/button>/);
});
