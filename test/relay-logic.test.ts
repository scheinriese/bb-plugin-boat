import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {HistoryEventDto} from '../contract-fidelity.ts';
import {selectHandoffEvent} from '../web/relay-logic.ts';
const event=(seq:number,at:string)=>({seq,at,kind:'provider-changed'} as HistoryEventDto);
test('pinned historical handoff keeps its recorded switch when a later one arrives',()=>{
 const events=[event(8,'2026-11-07T20:00:00Z'),event(3,'2026-11-07T19:42:00Z')];
 assert.equal(selectHandoffEvent(events,'3')?.seq,3);
 assert.equal(selectHandoffEvent(events,undefined,'2026-11-07T19:42:00Z')?.seq,3);
 for(const seq of ['0','-1','NaN','2.5','9007199254740992'])assert.equal(selectHandoffEvent(events,seq),undefined);
 assert.equal(selectHandoffEvent(events,undefined,'invalid'),undefined);
 assert.equal(selectHandoffEvent(events,'7'),undefined);
});
