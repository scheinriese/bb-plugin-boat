import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readContinuationGoal,continuationGoalText,continuationGoalSchema} from '../src/goal-handoff.ts';
const goal={objective:'Finish the approved change.\nDo not publish or broaden scope.',status:'active' as const,tokenBudget:1000,tokensUsed:250,timeUsedSeconds:42,sourceSeq:100,updatedAt:200};
function fixture(native:unknown,metadata:unknown={}){return {sdk:{threads:{timeline:async()=>({goal:native}),getPluginMetadata:async()=>metadata}}} as never;}
test('native goal transfers exactly, with remaining budget and restrictions rather than a fresh allocation',async()=>{
 const saved=await readContinuationGoal(fixture(goal),'thr_old','codex');assert.deepEqual(saved?.goal,goal);const text=continuationGoalText(saved);assert.match(text,/remaining at transfer: 750/);assert.match(text,/> Do not publish or broaden scope/);assert.match(text,/not a native goal/);assert.match(text,/boat_goal/);
});
test('a paused, completed or budget-limited goal is not automatically restarted',async()=>{
 for(const status of ['paused','complete','budgetLimited'] as const){const saved=await readContinuationGoal(fixture({...goal,status}),'thr_old','codex');assert.match(continuationGoalText(saved),/Do not restart this goal automatically/);}
 const spent=await readContinuationGoal(fixture({...goal,tokensUsed:1000}),'thr_old','codex');assert.match(continuationGoalText(spent),/Do not restart this goal automatically/);
});
test('Claude can carry the saved objective again, while an explicitly cleared native Codex goal stays cleared',async()=>{
 const saved={version:1,sourceThreadId:'thr_old',goal,progress:'Tests pass; review remains.'};const bb=fixture(null,{continuationGoal:saved});assert.deepEqual(await readContinuationGoal(bb,'thr_claude','claude-code'),saved);assert.equal(await readContinuationGoal(bb,'thr_codex','codex'),null);
});
test('unreadable or oversized native goals defer handover instead of silently dropping the objective',async()=>{
 const bb={sdk:{threads:{timeline:async()=>{throw Error('Offline');}}}} as never;await assert.rejects(readContinuationGoal(bb,'thr_old','codex'),/deferred/);await assert.rejects(readContinuationGoal(fixture({...goal,objective:'x'.repeat(32769)}),'thr_old','codex'));assert.equal(continuationGoalSchema.safeParse({version:1,sourceThreadId:'thr_old',goal:{...goal,tokenBudget:-1}}).success,false);
});
test('current provider-owned goal state is read from public events without losing budget; explicit clears and EOF stay empty',async()=>{
 const event={seq:99,createdAt:200,type:'thread/extensionState/updated',data:{kind:'provider-codex/goal',payload:goal}};
 const rows:unknown[]=[event];const bb={sdk:{threads:{timeline:async()=>({extensionStates:{}}),events:{list:async()=>rows}}}} as never;
 const saved=await readContinuationGoal(bb,'thr_old','codex');assert.equal(saved?.goal.objective,goal.objective);assert.equal(saved?.goal.tokensUsed,250);assert.equal(saved?.goal.sourceSeq,99);
 rows.splice(0,1,{...event,data:{kind:'provider-codex/goal',payload:null}});assert.equal(await readContinuationGoal(bb,'thr_old','codex'),null);
 rows.length=0;assert.equal(await readContinuationGoal(bb,'thr_old','codex'),null);
});
