import type {HistoryEventDto} from '../contract-fidelity';

export function providerName(value:string|null|undefined):string{
 return value==='claude'?'Claude':value==='codex'?'Codex':'the other agent';
}
/** A historical marker must not silently move to a later provider switch. */
export function selectHandoffEvent(events:readonly HistoryEventDto[],seq?:string,at?:string):HistoryEventDto|undefined{
 if(seq!==undefined&&(!/^\d+$/.test(seq)||!Number.isSafeInteger(Number(seq))||Number(seq)<1))return undefined;
 if(at!==undefined&&!Number.isFinite(Date.parse(at)))return undefined;
 return events.find(event=>event.kind==='provider-changed'&&(seq===undefined||event.seq===Number(seq))&&(at===undefined||Date.parse(event.at)===Date.parse(at)));
}

export interface ClaudeExtraUsageView {status:'allowed'|'rejected'|'disabled'|'unknown';observedAt:number|null;pool:'on'|'off'|'not-routing'}
/** "14:02", or "Nov 16 14:02" when it's older than most of a day. */
export function checkedAt(at:number,now:number):string{
 const time=new Date(at).toLocaleTimeString("en-US",{hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 return now-at>=20*3600_000?`${new Date(at).toLocaleDateString("en-US",{month:'short',day:'numeric'})} ${time}`:time;
}
/**
 * The real state of Claude extra usage, never "permitted when available":
 * blocked, available, or unknown, with when the Account Pooler last checked.
 * Boat sees allowed/blocked only; never a balance or a spending cap.
 */
export function claudeExtraUsageLine(value:ClaudeExtraUsageView|undefined,available:boolean,now=Date.now()):string{
 if(available)return 'Claude extra usage: available';
 if(!value||value.pool==='off')return 'Claude extra usage: unknown (Account Pooler off)';
 if(value.pool==='not-routing')return 'Claude extra usage: unknown (Account Pooler isn’t routing Claude)';
 const by=value.observedAt===null?'':` · last checked ${checkedAt(value.observedAt,now)} by the Account Pooler`;
 if(value.status==='rejected')return `Claude extra usage: blocked${by}`;
 if(value.status==='disabled')return `Claude extra usage: off for this account${by}`;
 if(value.status==='allowed')return `Claude extra usage: available at the last check${by} · Harbormaster waits for a newer check`;
 return value.observedAt===null?'Claude extra usage: unknown (no Account Pooler reading yet)':`Claude extra usage: unknown${by}`;
}
