import { useEffect, useId, useRef, useState } from "react";
import { experimental_useQuestionFormHost, experimental_useRpcMutation, experimental_useRpcQuery, type PluginAppBuilder, type PluginMessageDirectiveProps, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { PAID_START_RENDERER_ID, paidStartFormSchema, startQueueRpcContract, type PaidStartForm, type QueuedStartDto } from "../contract-start-queue";
import { Button } from "../components/ui/button";
import { AgentLogo } from "./ui";
import { useCloudAgentsNavigation, useInterval, useRelay } from "./hooks";
import "./ship-interaction.css";

export function registerStartQueueUi(app: PluginAppBuilder): void {
  app.slots.pendingInteraction({id: PAID_START_RENDERER_ID, component: PaidStartInteraction});
  app.slots.messageDirective({id: "boat-start-queue", component: QueuedStartCard});
}

export function useQueuedStarts(threadId?:string) {
  const query=experimental_useRpcQuery({contract:startQueueRpcContract,method:"queuedStarts",input:threadId?{threadId}:{}});
  useInterval(()=>{if(document.visibilityState==="visible"&&!query.isFetching)void query.refetch();},query.data?.requests.some(item=>item.state==="waiting"||item.state==="dispatching")?5000:null);
  return query;
}

export function PaidStartInteraction({interaction, submit, cancel}: PluginPendingInteractionProps) {
  const parsed = paidStartFormSchema.safeParse(interaction.payload);
  if (!parsed.success) return <section className="boat-ui boat-ship-form"><p role="alert">This start request is unavailable. Cancel it and ask again.</p><Button variant="outline" size="sm" onClick={()=>void cancel()}>Cancel confirmation</Button></section>;
  return <PaidStartView key={interaction.id} form={parsed.data} submit={submit} cancel={cancel}/>;
}

function PaidStartView({form, submit, cancel}: {form: PaidStartForm} & Pick<PluginPendingInteractionProps,"submit"|"cancel">) {
  const id=useId();
  const host=experimental_useQuestionFormHost();
  const [choice,setChoice]=useState<"start"|"wait">("wait");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const locked=useRef(false);
  async function act(action:"submit"|"cancel") {
    if(locked.current)return;
    locked.current=true;setBusy(true);setError(null);
    try { if(action==="cancel")await cancel();else await submit({requestId:form.requestId,choice}); }
    catch(reason){setError(reason instanceof Error?reason.message:"Couldn't send your choice. Try again.");locked.current=false;setBusy(false);}
  }
  useEffect(()=>host.registerChoiceHandler(index=>{
    if(index!==0&&index!==1)return false;
    if(!locked.current)setChoice(index===0?"wait":"start");
    return true;
  }),[host]);
  useEffect(()=>host.registerActionHandler(action=>{
    if(action!=="submit"&&action!=="cancel")return false;
    void act(action);return true;
  }),[host,choice,submit,cancel]);
  const provider=form.provider==="codex"?"Codex":"Claude";
  const hints=[host.actionShortcuts.get("submit")?.label,host.actionShortcuts.get("cancel")?.label];
  return <form className="boat-ui boat-ship-form" data-question-form aria-labelledby={`${id}-title`} aria-busy={busy} onSubmit={event=>{event.preventDefault();void act("submit");}}>
    <div className="boat-ship-body">
      <div className="boat-ship-heading"><span className="boat-ship-dot" aria-hidden="true"/><h3 id={`${id}-title`}>Start “{form.title}” before the reset?</h3></div>
      <p className="boat-ship-consequence">Starting with {provider} may use paid extra usage. The provider’s billing settings and limits still apply. No price estimate is available.</p>
      <ul className="boat-ship-checks" aria-label="Current subscription usage">{form.quotas.map(quota=><li key={quota.provider}><AgentLogo provider={quota.provider} className="mr-1 inline-flex size-3"/>{quota.provider==="codex"?"Codex":"Claude"} · {Math.round(quota.usedPercent)}% used · {quota.window}{quota.resetsAt?` · resets ${new Date(quota.resetsAt).toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}`:" · reset time unavailable"}</li>)}</ul>
      <fieldset disabled={busy} className="boat-ship-options"><legend className="sr-only">Start choice</legend>{(["wait","start"] as const).map((value,index)=>{
        const shortcut=host.shortcuts.get(String(index));
        return <label key={value} className="boat-ship-option" data-selected={choice===value}><input type="radio" name={`${id}-choice`} value={value} checked={choice===value} onChange={()=>setChoice(value)} aria-keyshortcuts={shortcut?.ariaKeyshortcuts}/><kbd aria-hidden="true">{shortcut?.label??index+1}</kbd><span className="boat-ship-option-label">{value==="wait"?"Wait for the reset":`Start with ${provider}`}</span><span className="boat-ship-muted">{value==="wait"?"keep this request queued; no sandbox starts now":"approve potential extra usage for this task only"}</span></label>;
      })}</fieldset>
      {error&&<p role="alert" className="boat-ship-error">{error}</p>}
    </div>
    <div className="boat-ship-footer"><span className="boat-ship-muted">{hints[0]?`${hints[0]} confirm`:""}{hints[1]?` · ${hints[1]} not now`:""}</span><Button type="button" variant="outline" size="sm" disabled={busy} onClick={()=>void act("cancel")}>Not now</Button><Button type="submit" size="sm" disabled={busy}>{choice==="wait"?"Keep waiting":`Start with ${provider}`}</Button></div>
  </form>;
}

function QueuedStartCard(props:PluginMessageDirectiveProps) {
  const id=props.attributes.id??"";
  const query=experimental_useRpcQuery({contract:startQueueRpcContract,method:"queuedStart",input:{id},enabled:!!id});
  useInterval(()=>{if(document.visibilityState==="visible"&&!query.isFetching)void query.refetch();},query.data?.state==="waiting"||query.data?.state==="dispatching"?5000:null);
  if(!id)return null;
  if(query.data?.state==="waiting"&&query.data.threadId)return <QueuedStartGroup initial={query.data}/>;
  return <QueuedStartReceipt request={query.data} loading={!query.data&&!query.error}/>;
}

function QueuedStartGroup({initial}:{initial:QueuedStartDto}) {
  const query=experimental_useRpcQuery({contract:startQueueRpcContract,method:"queuedStarts",input:{threadId:initial.threadId!}});
  const relay=useRelay().data;
  const paid=experimental_useRpcMutation({contract:startQueueRpcContract,method:"requestPaidStart"});
  const cancel=experimental_useRpcMutation({contract:startQueueRpcContract,method:"cancelQueuedStart"});
  const requests=(query.data?.requests??[initial]).filter(item=>item.state==="waiting");
  const [selected,setSelected]=useState(initial.id);
  const request=requests.find(item=>item.id===selected)??requests[0];
  const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
  useInterval(()=>{if(document.visibilityState==="visible"&&!query.isFetching)void query.refetch();},5000);
  async function act(item:QueuedStartDto,action:"paid"|"cancel") {
    if(busy)return;setBusy(true);setError(null);
    try {if(action==="cancel")await cancel.mutate({id:item.id,revision:item.revision});else await paid.mutate({id:item.id,revision:item.revision,provider:item.requestedProvider??"claude"});await query.refetch();}
    catch(reason){setError(reason instanceof Error?reason.message:String(reason));}
    finally{setBusy(false);}
  }
  if(!requests.length)return <p className="boat-ui my-2 text-xs text-muted-foreground">No tasks are waiting for a reset.</p>;
  return <section className="boat-ui my-2 flex max-w-[720px] flex-col gap-2.5 rounded-[10px] border border-border bg-card px-3.5 py-3 text-[13px] leading-5" aria-label="Waiting for a reset">
    <header className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium text-[color:var(--boat-heading)]">Waiting for a reset</h3><span className="text-xs leading-4 text-[#FC8C45]">{relay?.agents.filter(item=>item.usedPercent!==null).map(item=>`${item.provider==="codex"?"Codex":"Claude"} ${Math.round(item.usedPercent!)}%`).join(" · ")}</span></header>
    {requests.map(item=><div key={item.id} className="group flex items-center gap-2.5 border-t border-border py-1.5"><AgentLogo provider={item.requestedProvider??"claude"} className="size-3"/><span className="min-w-0 flex-1 text-[color:var(--boat-label)]">{item.title}</span><span className="text-xs leading-4 text-muted-foreground">{item.resetsAt?`starts ${new Date(item.resetsAt).toLocaleTimeString([], {hour:"numeric",minute:"2-digit"})} · reset`:"waiting for usage to reset"}</span><button type="button" aria-label={`Cancel ${item.title}`} title="Cancel request" disabled={busy} onClick={()=>void act(item,"cancel")} className="text-xs text-muted-foreground opacity-0 hover:underline focus:opacity-100 group-hover:opacity-100">Cancel</button></div>)}
    <footer className="flex flex-wrap items-center gap-2">{requests.length>1&&<><label className="sr-only" htmlFor={`queued-choice-${initial.id}`}>Task to start before reset</label><select id={`queued-choice-${initial.id}`} value={request?.id} onChange={event=>setSelected(event.target.value)} disabled={busy} className="h-7 max-w-[220px] rounded-md border border-border bg-background px-2 text-xs">{requests.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></>}<Button variant="outline" size="sm" disabled={busy||!request} onClick={()=>request&&void act(request,"paid")} className="text-[#FC8C45]">Start now on paid usage…</Button></footer>
    {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}
  </section>;
}

export function QueuedStartReceipt({request,loading=false}:{request:QueuedStartDto|null|undefined;loading?:boolean}) {
  const cancel=experimental_useRpcMutation({contract:startQueueRpcContract,method:"cancelQueuedStart"});
  const paid=experimental_useRpcMutation({contract:startQueueRpcContract,method:"requestPaidStart"});
  const [provider,setProvider]=useState<"claude"|"codex">(request?.requestedProvider??"claude");
  const {openTask}=useCloudAgentsNavigation();
  useEffect(()=>setProvider(request?.requestedProvider??"claude"),[request?.id,request?.requestedProvider]);
  const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
  async function act(action:"cancel"|"paid") {
    if(!request||busy)return;setBusy(true);setError(null);
    try {if(action==="cancel")await cancel.mutate({id:request.id,revision:request.revision});else await paid.mutate({id:request.id,revision:request.revision,provider});}
    catch(reason){setError(reason instanceof Error?reason.message:String(reason));}
    finally{setBusy(false);}
  }
  if(!request)return <p className="boat-ui my-2 text-xs text-muted-foreground">{loading?"Checking the queued request…":"This queued request is no longer available."}</p>;
  const waiting=request.state==="waiting";
  return <section className="boat-ui my-2 max-w-[720px] rounded-[10px] border border-border bg-card p-3.5 text-[13px] leading-5" aria-label="Queued cloud task">
    <p className="font-medium">{request.title}</p><p className="text-muted-foreground" role="status">{request.message}</p>
    {waiting&&<><p className="mt-1 text-xs text-muted-foreground">No sandbox has started.{request.resetsAt?` Next reset ${new Date(request.resetsAt).toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}.`:""}</p>{request.threadId===null&&<p className="mt-1 text-xs text-muted-foreground">Starting before the reset needs a request made from a chat, where you can confirm potential extra usage.</p>}<div className="mt-3 flex flex-wrap items-center gap-2"><label className="sr-only" htmlFor={`paid-provider-${request.id}`}>Provider for a potential paid start</label><select id={`paid-provider-${request.id}`} value={provider} onChange={event=>setProvider(event.target.value as "claude"|"codex")} disabled={busy||request.threadId===null} className="h-7 rounded-md border border-border bg-background px-2 text-xs"><option value="claude">Claude</option><option value="codex">Codex</option></select><Button type="button" size="sm" variant="outline" disabled={busy||request.threadId===null} onClick={()=>void act("paid")}>Start before reset…</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={()=>void act("cancel")}>Cancel request</Button></div></>}
    {request.state==="started"&&request.taskId&&<Button size="sm" variant="outline" className="mt-2" onClick={()=>openTask(request.taskId!)}>Open task</Button>}
    {error&&<p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
  </section>;
}
