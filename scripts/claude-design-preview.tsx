// Interactive local fixture of the actual plugin controls. The only persistence
// is this browser's localStorage; nothing connects to bb or a provider.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ClaudeDesignSetting, DesignPurposeField, ClaudeDesignStatus, ClaudePaidStatus } from "../web/claude-design";
import { PaidStartInteraction } from "../web/start-queue";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";

type Fixture = { prefer:boolean; purpose:"design"|null; preferred:boolean; paid:boolean; customPaid:boolean; customRevoked:boolean };
const KEY = "boat-claude-design-preview-v1";
const initial:Fixture = {prefer:true,purpose:"design",preferred:true,paid:false,customPaid:true,customRevoked:false};
function App() {
  const [state,setState]=useState<Fixture>(()=>{try{return JSON.parse(localStorage.getItem(KEY)??"null")??initial;}catch{return initial;}});
  const [confirm,setConfirm]=useState(false);
  const [receipt,setReceipt]=useState("");
  function save(patch:Partial<Fixture>){setState(current=>{const next={...current,...patch};localStorage.setItem(KEY,JSON.stringify(next));return next;});}
  return <main className="boat-ui">
    <header><span className="eyebrow">Harbormaster · component preview</span><h1>Claude for design</h1><p>Fake sample task · local browser fixture only · no account changes, provider calls or rentals</p></header>
    <section aria-label="Design preference settings"><h2>Settings · Agents</h2><div className="fixture-panel"><ClaudeDesignSetting checked={state.prefer} onChange={prefer=>save({prefer})}/></div></section>
    <section aria-label="New task purpose"><h2>New task · Cart drawer design</h2><div className="fixture-panel"><DesignPurposeField id="fixture-purpose" value={state.purpose} onChange={purpose=>save({purpose})} preferClaude={state.prefer}/></div></section>
    <section aria-label="In-chat task controls"><h2>Task chat · Cart drawer design</h2><div className="fixture-chat"><div className="fixture-task-title">Cart drawer design <span>Claude · Deep · Running</span></div><p className="fixture-brief">Design the cart drawer and quantity controls. Keep the existing visual language.</p><ClaudeDesignStatus preferred={state.preferred} paidApproved={state.paid} onClear={()=>{save({preferred:false,paid:false});setReceipt("Normal routing restored in this fake task.");}}/><div className="fixture-actions"><button type="button" onClick={()=>setConfirm(true)}>Request Claude continuation confirmation</button><button type="button" onClick={()=>{save(initial);setReceipt("");setConfirm(false);}}>Reset fixture</button></div></div></section>
    <section aria-label="Original custom task controls"><h2>Task chat · Earlier custom design request</h2><div className="fixture-chat"><div className="fixture-task-title">Checkout design exploration <span>Claude · Custom task</span></div><p className="fixture-brief">This earlier request has no Design purpose metadata. Its explicit paid permission remains visible and can be revoked.</p><ClaudePaidStatus approved={state.customPaid} revoked={state.customRevoked} onRevoke={()=>{save({customPaid:false,customRevoked:true});setReceipt("Claude paid continuation revoked in this fake custom task.");}}/></div></section>
    {confirm&&<section aria-label="Native payment confirmation"><h2>Owner confirmation · actual paid-start form</h2><PaidStartInteraction interaction={{id:"pint_fake_design",payload:{requestId:"fake_request",queueId:"qs_fake_design",title:"Cart drawer design",provider:"claude",claudeContinuationOffered:true,quotas:[{provider:"claude",usedPercent:95,resetsAt:null,window:"Weekly limit"},{provider:"codex",usedPercent:97,resetsAt:null,window:"Weekly limit"}],quotedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString()}} as PluginPendingInteractionProps["interaction"]} submit={async value=>{const result=value as {choice:string};if(result.choice==="start-claude-continuation"){save({preferred:true,paid:true});setReceipt("Native fixture confirmation recorded: Claude continuation approved for this task only.");}else setReceipt(result.choice==="wait"?"Kept waiting in this fixture.":"This start only was approved; no ongoing permission added.");setConfirm(false);}} cancel={async()=>setConfirm(false)}/></section>}
    {receipt&&<p role="status" className="fixture-receipt">{receipt}</p>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<App/>);
