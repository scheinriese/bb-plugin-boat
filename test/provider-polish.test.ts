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
