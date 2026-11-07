import {useEffect,useState} from "react";
import {useComposers,useSdk,experimental_useSidebarThreads,type PluginAppBuilder,type PluginMessageDirectiveProps} from "@get-bb/plugin-sdk/app";
import {useOrchestrators,useOverview,useProjects,useSettingRows} from "./hooks";
import {AgentLogo} from "./ui";
import {modelName} from "./format";

export function registerOrchestratorWelcome(app:PluginAppBuilder) {
  app.slots.messageDirective({id:"boat-welcome",component:OrchestratorWelcome});
}

/** An authored first greeting, rendered from the project's current settings. */
function OrchestratorWelcome(props:PluginMessageDirectiveProps) {
  const threadId=props.message.threadId;
  const sdk=useSdk();
  const [model,setModel]=useState<string|null>(null);
  const {threads}=experimental_useSidebarThreads();
  const thread=threads.find(thread=>thread.id===threadId);
  const entry=useOrchestrators().data?.orchestrators.find(entry=>entry.threadId===threadId);
  const project=useProjects().data?.projects.find(project=>project.id===entry?.projectId);
  const defaults=useOverview().data?.defaults;
  const settings=useSettingRows().data?.settings;
  const composers=useComposers();
  const composer=composers.find(item=>item.scope.kind==="thread"&&item.scope.threadId===threadId);
  useEffect(()=>{let active=true;void sdk.threads.defaultExecutionOptions({threadId}).then(value=>{if(active)setModel(value?.model??null);}).catch(()=>undefined);return()=>{active=false;};},[sdk,threadId]);
  if(!entry||!project)return null;
  const provider=thread?.providerId==="codex"?"codex":"claude";
  const reviewer=project.reviewer??defaults?.reviewProvider??null;
  const size=project.machineType??defaults?.machineType;
  const before=settings?.find(row=>row.key==="tasksBeforeAsking")?.value;
  const titles=["Fix open bugs","Plan the next features","Review the test suite"].map((fallback,index)=>{
    const authored=props.attributes[`starter${index+1}`]?.trim();
    return authored&&authored.length<=120?authored:fallback;
  });
  return <section className="boat-ui my-2 flex w-full max-w-[720px] flex-col gap-3.5 text-[15px] leading-6 text-[color:var(--boat-content)]" aria-label="Meet your orchestrator">
    <header className="flex items-center gap-2 text-xs leading-4 text-[color:var(--boat-faint)]"><AgentLogo provider={provider} className="size-3.5"/><span>{project.name} orchestrator · {provider==="codex"?"Codex":"Claude Code"}{model?` · ${modelName(model)}`:""}{thread?.environment?.name?.toLowerCase().includes("boat")?" · runs in the cloud":""}</span></header>
    <p className="max-w-[640px]">Hi. I coordinate the work on <span className="font-medium text-[color:var(--boat-heading)]">{project.repos.map(repo=>repo.repo).join(", ")}</span>: I split a goal into tasks, start each one in its own sandbox{reviewer&&reviewer!=="none"?`, and get every change reviewed by ${reviewer==="codex"?"Codex":"Claude"} before it reaches you.`:". You can ask for a review when you need one."}</p>
    <p className="max-w-[640px]">I don't write code myself, and I only bother you with decisions and finished work. What should we get done?</p>
    <div className="flex flex-wrap gap-2">{titles.map(title=><button key={title} type="button" disabled={!composer} className="rounded-full border border-border bg-card px-3 py-1.5 text-[13px] leading-[18px] text-foreground hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50" onClick={()=>{composer?.insert(title,{at:"end",block:true});composer?.focus();}}>{title}</button>)}</div>
    <p className="text-xs leading-[17px] text-[color:var(--boat-faint)]">{project.delivery==="pr"?`Pull requests on ${project.repos[0]?.baseBranch??"the base branch"}`:"Ships after your OK"}{size?` · ${size==="default"?"Default":size==="small"?"Small":size==="large"?"Large":"Extra large"} sandboxes`:""}{typeof before==="number"&&before>0?` · up to ${before} tasks at once before I ask`:""}</p>
  </section>;
}
