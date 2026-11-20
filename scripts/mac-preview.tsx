// Component-only preview: no plugin installation, provider calls or credentials.
// npm exec --yes --package=esbuild -- esbuild scripts/mac-preview.tsx --bundle --platform=node --format=esm --packages=external --outfile=scripts/.mac-preview.mjs
// node scripts/.mac-preview.mjs > /tmp/mac-preview/index.html
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ThisMonthUsage } from "../web/mac-usage";
import { MacLeaseNotices } from "../web/mac-lease-notices";
import { runsOnLine } from "../web/providers-logic.ts";
import type { RunsOnDto } from "../contract-providers.ts";
const paidUntil = new Date(Date.now()+6*3600000).toISOString();
const first: RunsOnDto = { provider: "instabox", label: "Instabox", os: "macos", machine: "Mac M2", note: null, detail: null, lease: { paidUntil, endedAt:null, shared:false, kept:false, releaseAt:null } };
const shared = {...first,lease:{...first.lease!,shared:true}};
const held = {machineId:"m_1",size:"M2",minimumCost:10.8,hourPrice:0.45,kept:false,releaseAt:null,currency:"USD",paidUntil};
const usage = {month:{leaseDays:14.25,costs:{USD:153.9}},rolling30:{leaseDays:14.25,costs:{USD:153.9}},held:[held],providers:[{id:"instabox",label:"Instabox"}]};
const orchard = {...usage,providers:[{id:"orchard",label:"Orchard"}]};
const notices = [{id:"orchard:1",provider:"orchard",label:"Orchard",machineId:"mac_1",at:new Date().toISOString(),text:"[boat] Mac lease is kept; compute cost $21.60 so far; $0.45/h billed per second after the minimum. Automatic hand-back is off; delete it manually when its work is safe."}];
const plan = {name:"Standard",hoursRemaining:475,hoursTotal:555};
// Exercise the real component's error, singular and kept states while rendering.
const sample = renderToStaticMarkup(<ThisMonthUsage plan={plan} active={3} cap={6} idleMinutes={60} boatError mac={{month:{leaseDays:1,costs:{USD:10.8}},rolling30:{leaseDays:1,costs:{USD:10.8}},held:[{...held,kept:true}]}}/>);
assert.ok(sample.includes("1 lease-day ·"));assert.ok(!sample.includes("1 lease-days"));
assert.ok(sample.includes("stop after 1 h"));assert.ok(!sample.includes("sandboxes on"));assert.ok(sample.includes("Kept · hand-back off"));
const providerSample=renderToStaticMarkup(<ThisMonthUsage mac={orchard}/>);
assert.ok(providerSample.includes("Mac · Orchard"));assert.ok(!providerSample.includes("Instabox"));
const noticeSample=renderToStaticMarkup(<MacLeaseNotices notices={notices}/>);
assert.ok(noticeSample.includes("Mac lease costs · Orchard"));assert.ok(noticeSample.includes("$21.60"));assert.ok(!noticeSample.includes("[boat]"));
assert.equal(renderToStaticMarkup(<MacLeaseNotices notices={[]}/>),"");
const icon = <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"><path d="M3 3h10v7H3zM1 13h14"/></svg>;
const html = renderToStaticMarkup(<html lang="en" className="dark"><head><meta charSet="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Mac lease component preview</title><link rel="stylesheet" href="/app.css"/><style>{`body{margin:0;background:#161616;color:#EDEDED;font-family:Inter,system-ui,sans-serif;--boat-faint:#6E6E6E;--border:#262626;--muted-foreground:#A8A8A8;--foreground:#EDEDED}main{max-width:1100px;margin:64px auto;padding:24px}h1{font-size:18px;margin-bottom:36px}.provider{font-size:12px;line-height:16px;color:#6E6E6E;display:flex;align-items:center;gap:6px}.task{padding:12px 14px;border-top:1px solid #222222}.card{border:1px solid #2A2A2A;border-radius:10px;background:#181818;overflow:hidden}.chip{display:inline-flex;align-items:center;gap:6px;padding:1px 8px 1px 6px;background:#222;border:1px solid #2E2E2E;border-radius:6px;font-size:12px}.caption{font-size:12px;color:#6E6E6E;margin:32px 0 12px}`}</style></head><body><main><h1>Cloud agents · Sandboxes</h1>
<ThisMonthUsage plan={plan} active={3} cap={6} idleMinutes={60} mac={usage}/>
<p className="caption">Task-started card · rendered provider text</p><div className="card"><div style={{padding:"10px 14px",fontSize:13}}>2 tasks · iOS app</div>{[first,shared].map((line,index)=><div className="task" key={index}><p style={{fontSize:13,margin:"0 0 3px"}}>{index?"Run the UI tests on iOS":"Redesign the onboarding screens"}</p><div className="provider">{icon}{runsOnLine(line)}</div></div>)}</div>
<p className="caption">Task chip and tooltip content</p><span className="chip">Run the UI tests on iOS {icon}<span style={{color:"#8A8A8A"}}>Instabox</span><span style={{color:"#5BD08A"}}>●</span></span><div className="card" style={{width:"fit-content",padding:"8px 10px",marginTop:12,fontSize:12}}>{runsOnLine(first)}<p style={{color:"#8A8A8A",margin:0}}>Shares the Mac with Redesign the onboarding screens</p></div>
<p className="caption">Task chat sandbox line</p><div className="card" style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",fontSize:12}}>{icon}<span>{runsOnLine(first)}</span><span style={{marginLeft:"auto",color:"#6E6E6E"}}>$0.45 / h after 24 h minimum · shared with 1 task</span></div>
<p className="caption">Scheduled release at the minimum</p><ThisMonthUsage plan={plan} active={3} cap={6} mac={{...usage,held:[{...held,releaseAt:paidUntil}]}}/>
<p className="caption">Kept Mac · 1 lease-day · boat.dev count hidden during error</p><ThisMonthUsage plan={plan} active={3} cap={6} boatError idleMinutes={60} mac={{month:{leaseDays:1,costs:{USD:10.8}},rolling30:{leaseDays:1,costs:{USD:10.8}},held:[{...held,kept:true}]}}/>
<p className="caption">No current lease</p><ThisMonthUsage plan={{name:"Standard",hoursRemaining:475,hoursTotal:555}} active={3} cap={6} mac={{month:{leaseDays:14,costs:{USD:151.2}},rolling30:{leaseDays:14,costs:{USD:151.2}},held:[]}}/>
<p className="caption">Another provider uses its display name</p><ThisMonthUsage plan={plan} active={3} cap={6} mac={orchard}/>
<p className="caption">Today / Overview · page-started lease without an orchestrator thread</p><MacLeaseNotices notices={notices}/>
</main></body></html>);
process.stdout.write("<!doctype html>"+html);
