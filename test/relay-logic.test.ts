import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {HistoryEventDto} from '../contract-fidelity.ts';
import {claudeExtraUsageLine,selectHandoffEvent} from '../web/relay-logic.ts';
const event=(seq:number,at:string)=>({seq,at,kind:'provider-changed'} as HistoryEventDto);
test('pinned historical handoff keeps its recorded switch when a later one arrives',()=>{
 const events=[event(8,'2026-11-07T20:00:00Z'),event(3,'2026-11-07T19:42:00Z')];
 assert.equal(selectHandoffEvent(events,'3')?.seq,3);
 assert.equal(selectHandoffEvent(events,undefined,'2026-11-07T19:42:00Z')?.seq,3);
 for(const seq of ['0','-1','NaN','2.5','9007199254740992'])assert.equal(selectHandoffEvent(events,seq),undefined);
 assert.equal(selectHandoffEvent(events,undefined,'invalid'),undefined);
 assert.equal(selectHandoffEvent(events,'7'),undefined);
});
test('Claude extra usage line names the real state and when the Pooler checked',()=>{
 const now=Date.UTC(2026,10,17,23,0);const at=now-10*60_000;const time=new Date(at).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 assert.equal(claudeExtraUsageLine({status:'rejected',observedAt:at,pool:'on'},false,now),`Claude extra usage: blocked · last checked ${time} by the Account Pooler`);
 assert.equal(claudeExtraUsageLine(undefined,true,now),'Claude extra usage: available');
 assert.equal(claudeExtraUsageLine({status:'unknown',observedAt:null,pool:'off'},false,now),'Claude extra usage: unknown (Account Pooler off)');
 assert.equal(claudeExtraUsageLine(undefined,false,now),'Claude extra usage: unknown (Account Pooler off)');
 assert.match(claudeExtraUsageLine({status:'allowed',observedAt:at,pool:'on'},false,now),/available at the last check · last checked .* · Harbormaster waits for a newer check/);
 assert.equal(claudeExtraUsageLine({status:'unknown',observedAt:null,pool:'on'},false,now),'Claude extra usage: unknown (no Account Pooler reading yet)');
 assert.doesNotMatch(claudeExtraUsageLine({status:'rejected',observedAt:at,pool:'on'},false,now),/permitted/);
});
