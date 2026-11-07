import { useEffect, useId, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { experimental_useRpcQuery, useComposer, type PluginMachineProviderInputsProps } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";
import { rpcContract } from "../contract";
import { sizeChipState } from "./entry-logic";
import { useBbProjectRepo, useOverview, useProjects, useSandboxSizes } from "./hooks";
import { AgentLogo } from "./ui";

type Reviewer = "codex" | "claude" | "none";
const reviewerLabel = (reviewer: Reviewer) => reviewer === "none" ? "no review" : `review by ${reviewer === "codex" ? "Codex" : "Claude"}`;

/** Non-secret native machine inputs; core still owns project, draft and send. */
export function BoatSizeChip({value,onChange}:PluginMachineProviderInputsProps) {
  const composer = useComposer();
  const projectId = composer.selection?.projectId ?? null;
  const match = useBbProjectRepo(projectId).data;
  const projects = useProjects().data;
  const project = projects?.projects.find(project=>project.id===match?.projectId);
  const overview = useOverview().data;
  const {data} = useSandboxSizes();
  const [open,setOpen] = useState(false);
  const compact = useIsCompactViewport();
  const portal = usePortalScopeProps();
  const id = useId();
  const snapshots = experimental_useRpcQuery({contract:rpcContract,method:"snapshots",input:null,enabled:open});
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const defaultType = project?.machineType ?? overview?.defaults.machineType ?? "default";
  const state = sizeChipState(value,data?.known===false?null:data?.sizes??null,defaultType);
  const defaultReviewer = project?.reviewer ?? overview?.defaults.reviewProvider ?? "codex";
  const reviewer:Reviewer = input.reviewer === "claude" || input.reviewer === "codex" || input.reviewer === "none" ? input.reviewer : defaultReviewer;
  const snapshot = typeof input.snapshot === "string" ? input.snapshot : null;
  const empty = Object.keys(input).length===0;
  const next = state.change.status === "ready" ? {
    ...state.change.value,
    ...(state.adopted?{}:{type:state.type,reviewer,...(empty&&project?.snapshot?{snapshot:project.snapshot}:{})}),
  } : null;
  const report = JSON.stringify(next ? {status:"ready",value:next} : state.change);
  useEffect(()=>{
    if(!overview || (projectId && !match) || !projects)return;
    if(report!==JSON.stringify({status:"ready",value}))onChange(JSON.parse(report));
  },[report,overview,match,projects,projectId]);
  if(state.adopted)return null;
  const update=(patch:Record<string,string|boolean|undefined>)=>{
    const change:Record<string,string|boolean>={...(next??{}),...(snapshot?{snapshot}:{}),type:state.type,reviewer};
    for(const [key,value] of Object.entries(patch)){if(value===undefined)delete change[key];else change[key]=value;}
    onChange({status:"ready",value:change});
  };
  const blocked=state.change.status==="blocked"?state.change.reason:null;
  const label=data?.sizes.find(size=>size.type===state.type)?.label ?? ({small:"Small",default:"Default",large:"Large",xlarge:"Extra large"}[state.type]);
  const trigger=<button type="button" onClick={compact?()=>setOpen(true):undefined} className={cn("boat-ui inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2 text-xs font-normal leading-4 text-foreground hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring",blocked&&"text-warning-text")} aria-label={`Boat sandbox: ${label}, ${reviewerLabel(reviewer)}`} title={blocked??undefined}>
    <span>{label}</span><span className="text-muted-foreground">·</span>{reviewer!=="none"&&<AgentLogo provider={reviewer} className="size-3"/>}<span className="text-muted-foreground">{reviewerLabel(reviewer)}</span><Icon name="ChevronDown" className="size-3 text-muted-foreground"/>
  </button>;
  const content=<div className="boat-ui flex flex-col gap-[14px] text-[13px] leading-4">
    <fieldset className="min-w-0 space-y-2"><legend className="text-xs leading-4 text-muted-foreground">Sandbox size</legend>
      <div className="flex gap-1 rounded-[9px] border border-border bg-background p-[3px]">
        {(["small","default","large"] as const).map(type=>{
          const size=data?.sizes.find(size=>size.type===type); const available=size?.available!==false;
          return <label key={type} title={size?.reason??undefined} className={cn("relative min-w-0 flex-1 cursor-pointer rounded-[7px] border border-transparent px-2.5 py-2 has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring",state.type===type&&"border-border bg-muted dark:border-[#3A3A3A] dark:bg-[#2C2C2C]",!available&&"cursor-not-allowed opacity-40")}><input className="sr-only" type="radio" name={`${id}-size`} value={type} checked={state.type===type} disabled={!available} onChange={()=>update({type})}/><span className={cn("block",state.type===type&&"font-medium")}>{type==="small"?"Small":type==="large"?"Large":"Default"}</span><span className={cn("mt-0.5 block whitespace-nowrap text-[11px] leading-[14px]",type==="large"?"text-[#FC8C45]":"text-muted-foreground")}>{type==="small"?"half the cost":type==="large"?"2× per hour":"most work"}</span></label>;
        })}
      </div>
      {state.type==="xlarge"&&<p className="text-xs text-muted-foreground">Extra large is selected. Choose a size above to change it.</p>}
      {blocked&&<p className="text-xs text-warning-text">{blocked}</p>}
    </fieldset>
    <fieldset className="space-y-1"><legend className="mb-1 text-xs leading-4 text-muted-foreground">Who reviews the change</legend>
      {(["codex","claude","none"] as const).map(choice=><label key={choice} className={cn("relative flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-[7px] has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring",reviewer===choice&&"bg-muted dark:bg-[#2A2A2A]")}><input className="sr-only" type="radio" name={`${id}-reviewer`} value={choice} checked={reviewer===choice} onChange={()=>update({reviewer:choice})}/>{choice==="none"?<span className="size-3 rounded-full border border-muted-foreground"/>:<AgentLogo provider={choice} className="size-3"/>}<span>{choice==="none"?"No review":choice==="codex"?"Codex":"Claude"}</span><span className="min-w-0 flex-1 text-xs text-[color:var(--boat-faint)]">{choice==="none"?"":composer.selection?.providerId===(choice==="codex"?"codex":"claude-code")?"same agent, fresh context":"the other agent"}</span>{reviewer===choice?<Icon name="Check" className="size-3.5"/>:<span className="size-3.5"/>}</label>)}
    </fieldset>
    <div className="h-px bg-border"/>
    <div className="flex items-center gap-3 p-0.5"><div className="min-w-0 flex-1"><span id={`${id}-snapshot`} className="block">Start from the repo snapshot</span><span className="mt-0.5 block text-xs text-muted-foreground">{snapshot?`Uses ${snapshot}`:project?.snapshot?"A prepared checkout for this project":"No project snapshot yet"}</span></div><button type="button" role="switch" aria-labelledby={`${id}-snapshot`} aria-checked={snapshot!==null} disabled={!project?.snapshot&&!snapshot} onClick={()=>update({snapshot:snapshot?undefined:project?.snapshot??undefined})} className={cn("relative h-[18px] w-[30px] shrink-0 rounded-full bg-muted disabled:opacity-40 focus-visible:ring-1 focus-visible:ring-ring",snapshot&&"bg-[#5BD08A]")}><span className={cn("absolute top-0.5 size-3.5 rounded-full bg-white",snapshot?"left-[14px]":"left-0.5")}/></button></div>
    {snapshots.data && snapshot && !snapshots.data.snapshots.some(item=>item.name===snapshot)&&<p className="text-xs text-warning-text">This snapshot is no longer available. Turn it off to start fresh.</p>}
    <p className="text-xs leading-4 text-[color:var(--boat-faint)]">{project?`${project.name}'s defaults · change them in the project's settings`:"Your defaults · change them in Cloud agents settings"}</p>
  </div>;
  if(compact)return <><span>{trigger}</span><Dialog open={open} onOpenChange={setOpen}><DialogContent className="p-[14px]"><DialogTitle className="sr-only">Boat sandbox</DialogTitle>{content}</DialogContent></Dialog></>;
  return <Popover.Root open={open} onOpenChange={setOpen}><Popover.Trigger asChild>{trigger}</Popover.Trigger><Popover.Portal><Popover.Content {...portal} align="start" sideOffset={8} collisionPadding={12} aria-label="Boat sandbox" className="boat-ui z-50 w-[360px] rounded-[10px] border border-border bg-card dark:border-[#2E2E2E] dark:bg-[#1E1E1E] p-[14px] shadow-xl focus:outline-none">{content}</Popover.Content></Popover.Portal></Popover.Root>;
}
