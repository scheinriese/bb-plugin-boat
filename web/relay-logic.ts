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
