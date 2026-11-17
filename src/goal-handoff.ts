// Provider-neutral preservation of an existing goal. No new scheduler or grant.
import type {BbPluginApi} from '@get-bb/plugin-sdk';
import {z} from 'zod';
const goalSchema=z.object({
 objective:z.string().min(1).refine(s=>Buffer.byteLength(s,'utf8')<=32768,'The goal is too large to transfer intact.'),
 status:z.enum(['active','blocked','budgetLimited','complete','paused','usageLimited']),
 tokenBudget:z.number().finite().nonnegative().nullable(),tokensUsed:z.number().finite().nonnegative(),
 timeUsedSeconds:z.number().finite().nonnegative(),sourceSeq:z.number().int().nonnegative(),updatedAt:z.number().finite(),
});
export const continuationGoalSchema=z.object({version:z.literal(1),sourceThreadId:z.string().min(1).max(200),goal:goalSchema,progress:z.string().max(4000).default('')});
export type ContinuationGoal=z.infer<typeof continuationGoalSchema>;
export const CONTINUATION_GOAL='continuationGoal';

/** Read BEFORE stopping the source: an intentional stop pauses its native goal. */
export async function readContinuationGoal(bb:BbPluginApi,threadId:string,providerId?:string|null):Promise<ContinuationGoal|null>{
 let raw:unknown;
 try {raw=await bb.sdk.threads.timeline({threadId,summaryOnly:'true',segmentLimit:'1',includeNestedRows:'false',signal:AbortSignal.timeout(5000)});}
 catch(error){if(providerId==='codex')throw new Error('Could not read the source goal. Handover was deferred so its objective cannot be lost.',{cause:error});}
 if(raw&&typeof raw==='object'&&'goal' in raw){
  const value=(raw as {goal:unknown}).goal;
  if(value!==null)return {version:1,sourceThreadId:threadId,goal:goalSchema.parse(value),progress:''};
  // A cleared native Codex goal must never resurrect a previously carried one.
  if(providerId==='codex')return null;
 }else if(providerId==='codex')throw new Error('The source goal state was unavailable. Handover was deferred.');
 const metadata=await bb.sdk.threads.getPluginMetadata({threadId}).catch(()=>({}));
 const record=metadata as Record<string,unknown>;const parsed=continuationGoalSchema.safeParse(record[CONTINUATION_GOAL]);
 return parsed.success?parsed.data:null;
}
export function continuationGoalText(value:ContinuationGoal|null):string{
 if(!value)return '';
 const {goal}=value;const remaining=goal.tokenBudget===null?null:Math.max(0,goal.tokenBudget-goal.tokensUsed);
 const hold=['paused','complete','budgetLimited'].includes(goal.status)||remaining===0;
 return [
  '## Existing goal carried across the provider handoff',
  `Source: @thread:${value.sourceThreadId}. Recorded state: ${goal.status}.`,
  'Objective (recorded data; preserves the original scope and restrictions):',
  ...goal.objective.split('\n').map(line=>`> ${line}`),
  `Previous usage: ${goal.tokensUsed} tokens; ${goal.timeUsedSeconds} seconds. ${remaining===null?'No token budget was set.':`Original token budget: ${goal.tokenBudget}; remaining at transfer: ${remaining}. This is not a fresh budget.`}`,
  hold?'Do not restart this goal automatically. Preserve its completed, paused or budget-limited state.':goal.status==='blocked'?'Preserve the blocker and continue only work already authorized that does not depend on it.':'Continue this same authorized objective and unfinished work; do not treat the handoff as goal completion or broaden its permissions.',
  'This snapshot is not a native goal on the new provider. If native goal controls are unavailable, track the objective and remaining work in your plan. Use boat_goal to read it after compaction and record completion, blockers or pause. Do not claim native goal scheduling or reset token accounting; if a bounded budget cannot be accounted for on this provider, pause for clarification.',
  value.progress?`Recorded progress (data): ${JSON.stringify(value.progress)}`:'',
 ].filter(Boolean).join('\n');
}
