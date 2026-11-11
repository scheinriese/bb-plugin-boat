import { useState } from "react";
import { toast } from "sonner";
import {
  experimental_useRpcMutation,
  experimental_useSidebarThreads,
  useBbNavigate,
  useComposer,
  type PluginHomepageSectionProps,
} from "@get-bb/plugin-sdk/app";
import { rpcContract, type DecisionDto, type TaskDto } from "../contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cardStatus, queueDelivery, recommendedOption } from "./cards-logic";
import { useBoard, useCloudAgentsNavigation, useOrchestrators, useOverview, useProjects, useRelay, useTask } from "./hooks";
import { NewProjectDialog } from "./projects-settings";
import { ResizeDialog } from "./sandbox-size";
import { AgentLogo } from "./ui";
import { CancelQueuedStartButton, useQueuedStarts } from "./start-queue";

const ROW = "flex min-h-11 items-center gap-2.5 border-b border-[color:var(--boat-divider)] px-[14px] py-2 last:border-b-0 sm:py-1.5";
const ACTION = "h-[26px] max-w-[45%] shrink-0 rounded-md px-2.5 text-xs font-normal leading-4";

/** A quiet live summary beside the native new-thread composer. */
export function HomepageCard(_props: PluginHomepageSectionProps) {
  const composer = useComposer();
  const navigate = useBbNavigate();
  const [adding, setAdding] = useState(false);
  const board = useBoard(null).data;
  const orchestratorData = useOrchestrators().data;
  const projects = useProjects().data?.projects ?? [];
  const overview = useOverview().data;
  const queued=useQueuedStarts().data?.requests??[];
  const relay = useRelay().data;
  const { threads } = experimental_useSidebarThreads();
  const orchestrators = (orchestratorData?.orchestrators ?? []).filter(entry => !entry.archived);
  const tasks = board ? [...board.running, ...board.ready] : [];
  const decisions = board?.needsYou ?? [];
  const linked = new Set(decisions.flatMap(item => item.taskIds));
  const problems = tasks.filter(task => cardStatus(task).needsYou && !linked.has(task.id));
  const firstRun = board !== undefined && orchestratorData !== undefined && !orchestrators.length && !decisions.length && !tasks.length && !board.done.length && !queued.length;
  const projectName = (task?: TaskDto) => task ? (projects.find(project => project.id === task.projectId) ?? projects.find(project => project.repos[0]?.repo === task.repo) ?? projects.find(project => project.repos.some(repo => repo.repo === task.repo)))?.name ?? "" : "";
  const fill = (text: string) => { composer.insert(text, {at:"end", block:true}); composer.focus(); };
  const meta = [
    overview?.cap != null ? `${overview.activeSandboxes} of ${overview.cap} sandboxes` : null,
    ...(relay?.agents ?? []).flatMap(agent => agent.usedPercent === null ? [] : [`${agent.provider === "codex" ? "Codex" : "Claude"} ${Math.round(agent.usedPercent)}%`]),
  ].filter(Boolean).join(" · ");
  return <section className="boat-ui relative" aria-label="Cloud agents">
    <span className="mb-2 block text-xs leading-4 text-[color:var(--boat-faint)] sm:absolute sm:-top-8 sm:right-0 sm:mb-0 sm:text-right">{firstRun ? "All set · nothing running" : meta}</span>
    {firstRun ? <div className="grid gap-[10px] sm:grid-cols-3">
      {[
        {icon:"Cloud", title:"Try a one-off task", detail:"Fills the box above with a small task; runs in its own sandbox.", action:"Try it", act:()=>fill("Check this repository runs: install dependencies, build it, and run the tests. Report what works and what needs fixing; don't change any code.")},
        {icon:"Folder", title:"Add a project", detail:"A repo with its rules. It gets a section in the sidebar.", action:"Add project", act:()=>setAdding(true)},
        {icon:"Workflow", title:"Start an orchestrator", detail:"Plans the work, starts tasks, gets each change reviewed.", action:"Pick a project first", act:()=>{fill("Help me plan and coordinate work for this project. ");toast("Pick a project, then choose Start as orchestrator in the send menu");}},
      ].map(item=><div key={item.title} className="flex flex-col gap-2 rounded-[10px] border border-border bg-card p-[14px] text-left"><div className="flex items-center gap-2"><Icon name={item.icon} className="size-3.5 text-muted-foreground"/><span className="text-[13px] font-medium leading-5 text-[color:var(--boat-heading)]">{item.title}</span></div><p className="text-xs leading-[17px] text-muted-foreground">{item.detail}</p><button type="button" onClick={item.act} className="self-start text-xs leading-4 text-[#7AA7FF] hover:underline focus-visible:ring-1 focus-visible:ring-ring">{item.action}</button></div>)}
    </div> : <div className="overflow-hidden rounded-[10px] border border-border bg-card">
      {decisions.map(decision => {
        const task = tasks.find(task => task.id === (decision.askedByTaskId ?? decision.taskIds[0]));
        return <HomeDecision key={decision.id} decision={decision} subline={[task?.title, projectName(task)].filter(Boolean).join(" · ")}/>;
      })}
      {problems.map(task=><HomeProblem key={task.id} task={task} project={projectName(task)}/>)}
      {queued.map(request=><div key={request.id} className={ROW}><span className="size-1.5 shrink-0 rounded-full bg-muted-foreground"/><span title={request.title} className="min-w-0 flex-1 truncate text-[13px] leading-4">{request.title}</span><span className="shrink-0 text-xs text-muted-foreground">{request.state==='dispatching'?'Starting':'Waiting for reset'}</span>{request.threadId?<Button size="sm" variant="outline" className={ACTION} onClick={()=>navigate.toThread(request.threadId!)}>Open</Button>:<CancelQueuedStartButton request={request} className={ACTION}/>}</div>)}
      {orchestrators.map(entry => {
        const owned = tasks.filter(task => task.orchestratorThreadId === entry.threadId && task.role !== "review");
        const ready = owned.filter(task => cardStatus(task).status === "ready").length;
        const stopped = owned.filter(task => cardStatus(task).status === "broken").length;
        const working = owned.filter(task => ["working","review"].includes(cardStatus(task).status)).length;
        const needs = decisions.filter(decision=>decision.orchestratorThreadId===entry.threadId).length + owned.filter(task=>cardStatus(task).status==="needs-you"&&!linked.has(task.id)).length;
        const provider = relay?.orchestrators.find(item=>item.threadId===entry.threadId)?.provider ?? (threads.find(thread=>thread.id===entry.threadId)?.providerId === "codex" ? "codex" : "claude");
        return <div key={entry.threadId} className={`${ROW} sm:min-h-10`}>
          <AgentLogo provider={provider} className="size-3"/>
          <button type="button" title={[entry.title, entry.projectName].filter(Boolean).join(" · ")} className="flex min-w-0 flex-1 items-baseline gap-x-2 text-left hover:underline focus-visible:ring-1 focus-visible:ring-ring" onClick={()=>navigate.toThread(entry.threadId)}><span className="min-w-0 truncate text-[13px] leading-4">{entry.title ?? entry.projectName ?? "Orchestrator"}</span><span className="min-w-0 max-w-[40%] truncate text-xs leading-4 text-[color:var(--boat-faint)]">{entry.projectName}</span></button>
          <span className="flex max-w-[45%] shrink-0 flex-wrap justify-end gap-x-3.5 gap-y-1 text-xs leading-4 text-muted-foreground">
            {needs>0 && <Count color="#F0B135">{needs} {needs===1?"needs":"need"} you</Count>}
            {stopped>0 && <Count color="#E06C6C">{stopped} stopped</Count>}
            {ready>0 && <Count color="#5BD08A">{ready} ready</Count>}
            {working>0 && <Count color="#8A8A8A">{working} working</Count>}
          </span>
        </div>;
      })}
      {!decisions.length && !problems.length && !orchestrators.length && !queued.length && <p className="px-3.5 py-3 text-xs text-muted-foreground">{board ? "Nothing needs you right now." : "Loading cloud work…"}</p>}
    </div>}
    <NewProjectDialog open={adding} onOpenChange={setAdding} repo="" baseBranch=""/>
  </section>;
}

function Count({color,children}:{color:string;children:React.ReactNode}) {
  return <span className="inline-flex items-center gap-[5px]"><span className="size-1.5 rounded-full" style={{background:color}}/>{children}</span>;
}

function HomeDecision({decision,subline}:{decision:DecisionDto;subline:string}) {
  const navigate = useBbNavigate();
  const send = experimental_useRpcMutation({contract:rpcContract,method:"answerDecision"});
  const [pending,setPending] = useState(false);
  const option = decision.optionDetails?.find(option=>option.recommended)?.label ?? recommendedOption(decision.options,decision.recommendation);
  const label = decision.shortLabel?.trim() || decision.question;
  const open=()=>decision.orchestratorThreadId && navigate.toThread(decision.orchestratorThreadId);
  const choose=()=>{
    if(!option){open();return;}
    if(pending)return;
    setPending(true);
    const cancel=queueDelivery(async()=>{
      try {await send.mutate({id:decision.id,accept:true,answer:null});}
      catch(error){toast.error(error instanceof Error?error.message:String(error));}
      finally {setPending(false);}
    });
    toast("Answer queued",{duration:4000,description:option,action:{label:"Undo",onClick:()=>{if(cancel())setPending(false);}}});
  };
  return <div className={ROW}>
    <span className="size-1.5 shrink-0 rounded-full bg-[#F0B135]"/>
    <button type="button" onClick={open} title={decision.question} aria-label={[decision.question, subline].filter(Boolean).join(" · ")} className="min-w-0 flex-1 text-left hover:underline focus-visible:ring-1 focus-visible:ring-ring">
      <span className="block truncate text-[13px] leading-4 text-[color:var(--boat-label)]">{label}</span>
      {subline && <span title={subline} className="block truncate text-xs leading-4 text-[color:var(--boat-faint)]">{subline}</span>}
    </button>
    <Button size="sm" variant="outline" className={ACTION} disabled={pending} onClick={choose}><span title={option ? `Go with ${option}` : undefined} className="truncate">{pending?"Queued…":option?`Go with ${option}`:"Open"}</span></Button>
  </div>;
}

function HomeProblem({task,project}:{task:TaskDto;project:string}) {
  const detail = useTask(task.id).data?.task;
  const [open,setOpen]=useState(false);
  const navigate=useBbNavigate();
  const {openTask}=useCloudAgentsNavigation();
  const next=detail?.memory?.canResize?detail.memory.next?.label:null;
  const action=()=>next?setOpen(true):task.threadId?navigate.toThread(task.threadId):openTask(task.id);
  const context = [project, "work is saved"].filter(Boolean).join(" · ");
  return <div className={ROW}><span className="size-1.5 shrink-0 rounded-full bg-[#E06C6C]"/><div className="min-w-0 flex-1 text-[13px] leading-4"><span title={`${task.title} stopped`} className="block truncate">{task.title} stopped</span><span title={context} className="block truncate text-xs text-[color:var(--boat-faint)]">{context}</span></div><Button size="sm" variant="outline" className={ACTION} onClick={action}><span className="truncate">{next?`Continue on ${next}`:"Open"}</span></Button>{detail&&<ResizeDialog task={detail} mode="oom" open={open} onOpenChange={setOpen}/>}</div>;
}
