import assert from "node:assert/strict";
import { test } from "node:test";
import { InstaboxRest } from "../src/providers/instabox/api.ts";
import { InstaboxCli } from "../src/providers/instabox/cli.ts";
import { toProcessSample } from "../src/providers/instabox/parse.ts";
import { createInstaboxProvider } from "../src/providers/instabox/provider.ts";

const at=Date.parse("2030-01-01T12:00:00Z");
const read={machineId:"m_example",requestedAt:at,receivedAt:at+100};
const sample=()=>({machineId:"m_example",state:"running",live:true,capturedAt:new Date(at).toISOString(),trigger:"request",truncated:false,
  processes:[{pid:1,ppid:0,user:"root",cpuPercent:0,memPercent:0.1,elapsedSeconds:60,command:"/sbin/launchd"}]});

test("only an authoritative request can establish live Instabox processes, including an empty complete list",()=>{
  const raw=sample();
  assert.equal(toProcessSample(raw).live,null,"an envelope alone does not establish when or for which machine it was read");
  assert.equal(toProcessSample(raw.processes,read).live,null,"CLI rows alone have no provenance");
  assert.equal(toProcessSample(raw,read).live,true);
  assert.equal(toProcessSample({...raw,processes:[]},read).live,true);
  assert.equal(toProcessSample({...raw,live:false,trigger:"stop"},read).live,false);
  assert.equal(toProcessSample(raw,read).sampledAt,raw.capturedAt,"retain the provider capture time");
});

test("process evidence expires and fails closed outside the bounded request window",()=>{
  for(const observation of [
    {...read,requestedAt:at+60_000,receivedAt:at+60_100},
    {...read,receivedAt:at+30_001},
    {...read,receivedAt:at-1},
    {...read,requestedAt:at-60_000,receivedAt:at-59_000},
    {...read,machineId:"m_other"},
  ])assert.equal(toProcessSample(sample(),observation).live,null);
  assert.equal(toProcessSample({...sample(),capturedAt:new Date(at-4000).toISOString()},read).live,true,"bounded clock skew is allowed");
});

test("invalid process numbers cannot disappear into a complete idle sample",()=>{
  for(const patch of [{pid:0},{pid:1.5},{ppid:-1},{cpuPercent:NaN},{cpuPercent:Infinity},{cpuPercent:-1},{memPercent:null},{elapsedSeconds:1.5},{user:""}]) {
    const raw=sample();Object.assign(raw.processes[0]!,patch);
    assert.equal(toProcessSample(raw,read).live,null,JSON.stringify(patch));
  }
});

test("the real process read propagates cancellation and rejects delayed evidence",async()=>{
  let now=at;
  const controller=new AbortController();
  const rest=new InstaboxRest({key:async()=>"ibk_fake_process_sample",baseUrl:()=>"http://instabox.test",fetch:async(url,init)=>{
    assert.equal(url,"http://instabox.test/v1/machines/m_example/processes");assert.equal(init.method,"GET");
    assert.ok(init.signal,"the request has a deadline");
    now+=30_001;
    return new Response(JSON.stringify(sample()));
  }});
  const provider=createInstaboxProvider(new InstaboxCli(async()=>null,async()=>null),rest,{now:()=>now});
  assert.equal((await provider.processes("m_example")).live,null);
  controller.abort();
  await assert.rejects(provider.processes("m_example",controller.signal));
});
