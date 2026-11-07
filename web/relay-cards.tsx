import {useState} from 'react';
import {experimental_useRpcQuery,useBbNavigate,type PluginMessageDirectiveProps} from '@get-bb/plugin-sdk/app';
import {rpcContract} from '../contract';
import {Icon} from '@/components/ui/icon';
import {AgentLogo} from './ui';
import {useTask,useThreadTask} from './hooks';
import {markerId} from './cards-logic';
import {clockTime} from './format';
import {selectHandoffEvent,providerName} from './relay-logic';

/** Render only recorded handoffs. A marker may pin seq/at for older messages. */
export function HandoffDirective(props:PluginMessageDirectiveProps){
 const threadId=markerId(props.attributes.thread)??props.message.threadId;
 const own=useThreadTask(threadId);
 const navigate=useBbNavigate();
 const detail=useTask(own?.id??null).data?.task;
 const history=experimental_useRpcQuery({contract:rpcContract,method:'history',input:{...(own?{taskId:own.id}:{orchestratorThreadId:threadId}),limit:100}}).data?.events??[];
 const [expanded,setExpanded]=useState(true);
 const event=selectHandoffEvent(history,props.attributes.seq,props.attributes.at);
 if(props.attributes.seq!==undefined&&!event)return null;
 const oldEvent=detail?.events.filter(item=>['failover','followup-switch','moved-to-chat'].includes(item.kind)&&(!props.attributes.at||item.at===props.attributes.at)).at(-1);
 const previous=detail?.events.find(item=>['chat','chat-extra'].includes(item.kind)&&item.text!==threadId&&markerId(item.text))?.text;
 if(!event){
  if(!oldEvent)return null;
  return <aside className="boat-ui my-3 flex items-center gap-2 text-[12px] leading-4 text-muted-foreground"><Icon name="ArrowRight" className="size-3 shrink-0"/>{clockTime(oldEvent.at).replace(/^0/,'').toLowerCase()} · {oldEvent.text}</aside>;
 }
 const from=event.from==='claude'||event.from==='codex'?event.from:null;
 const to=event.to==='claude'||event.to==='codex'?event.to:null;
 if(own)return <aside className="boat-ui my-3 flex flex-wrap items-center gap-2 text-[12px] leading-4 text-muted-foreground">{from&&<AgentLogo provider={from} className="size-3"/>}<Icon name="ArrowRight" className="size-3 shrink-0"/>{to&&<AgentLogo provider={to} className="size-3"/>}{clockTime(event.at).replace(/^0/,'').toLowerCase()} · {event.cause??event.text}{previous&&<button type="button" onClick={()=>navigate.toThread(previous)} className="hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">Previous chat</button>}</aside>;
 return <div className="boat-ui my-4 -ml-2 w-[calc(100%+16px)] max-w-[720px] sm:ml-0 sm:w-[calc(100%+8px)]">
  <div className="mb-4 flex items-center gap-[10px]"><span className="h-px flex-1 bg-[#2A2A2A]"/><span className="inline-flex items-center gap-[6px] rounded-full border border-[#2E2E2E] px-[10px] py-[3px] text-[12px] leading-4 text-[#A8A8A8]">{to&&<AgentLogo provider={to} className="size-[11px]"/>}Continued on {providerName(event.to)} · {clockTime(event.at).replace(/^0/,'').toLowerCase()}{event.cause?' · '+event.cause:''}</span><span className="h-px flex-1 bg-[#2A2A2A]"/></div>
  {event.detail&&<section className="space-y-[10px] rounded-[10px] border border-[#2A2A2A] bg-[#181818] px-[14px] py-3">
   <header className="flex items-center gap-2 text-[13px] font-medium leading-5 dark:text-[#EDEDED]">{from&&<AgentLogo provider={from} className="size-3"/>}<Icon name="ArrowRight" className="size-3 text-muted-foreground"/>{to&&<AgentLogo provider={to} className="size-3"/>}Handoff note{from?' from '+providerName(from):''}<button type="button" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)} className="ml-auto text-[12px] font-normal leading-4 text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">{expanded?'Hide':'Show'}</button></header>
   {expanded&&<div className="space-y-1 pl-[2px] text-[13px] leading-5 text-[#A8A8A8]">{event.detail.split('\n').filter(line=>line.trim()).map((line,index)=>/^[·*-] /.test(line)?<p key={index} className="flex gap-2"><span aria-hidden className="text-muted-foreground">·</span><span className="whitespace-pre-wrap">{line.slice(2)}</span></p>:<p key={index} className="whitespace-pre-wrap">{line}</p>)}</div>}
  </section>}
 </div>;
}
