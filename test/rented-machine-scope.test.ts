import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createRentedMachineScope, INSTABOX_GITHUB_SCOPE_KEY, RENTED_GITHUB_SCOPE_KEY } from "../src/rented-machine-scope.ts";
import { createCredentialSource } from "../src/credentials.ts";
import { defineProviderSecrets } from "../src/provider-settings.ts";
import { providerFailureCard } from "../provider-failure.ts";
import { InstaboxRest } from "../src/providers/instabox/api.ts";

const key = "fake_original_scaleway_key", project = "example_original_project", token = "fake_owner_github_token";

test("Instabox delivery pins its own API key without a Scaleway account and latches key changes", async t => {
  const {bb,harness}=createFakePluginHost({pluginId:"boat"});t.after(()=>harness.lifecycle.dispose());
  const secrets=await defineProviderSecrets(bb);
  const guard=createRentedMachineScope({provider:"instabox",kv:bb.storage.kv,read:async()=>({enabled:Boolean(await secrets.rentedMachineGithubToken()),key:await secrets.instaboxKey(),project:"https://api.instabox.sh"})});
  secrets.onInstaboxKeyChange(()=>void guard.configurationChanged("key").catch(()=>{}));
  secrets.onGithubTokenPresenceChange(enabled=>void guard.tokenPresenceChanged(enabled).catch(()=>{}));
  await harness.setSettings({instaboxApiKey:"fake_instabox_original_key",rentedMachineGithubToken:token});
  await guard.assertAllowed();
  assert.equal(await bb.storage.kv.get(RENTED_GITHUB_SCOPE_KEY),undefined);
  await harness.setSettings({scalewaySecretKey:key});await guard.assertAllowed();
  await harness.setSettings({instaboxApiKey:"fake_instabox_changed_key"});
  await assert.rejects(guard.assertAllowed(),/Instabox API key changed/);
  await harness.setSettings({instaboxApiKey:"fake_instabox_original_key"});
  const restarted=createRentedMachineScope({provider:"instabox",kv:bb.storage.kv,read:async()=>({enabled:true,key:await secrets.instaboxKey(),project:"https://api.instabox.sh"})});
  await assert.rejects(restarted.assertAllowed(),/Instabox API key changed/);
  const saved=JSON.stringify(await bb.storage.kv.get(INSTABOX_GITHUB_SCOPE_KEY));
  for(const value of [token,key,"fake_instabox_original_key","fake_instabox_changed_key"])assert.ok(!saved.includes(value));
  await harness.setSettings({rentedMachineGithubToken:null});await harness.setSettings({rentedMachineGithubToken:token});
  await guard.assertAllowed();assert.deepEqual(harness.logEntries,[]);
});

test("Instabox delivery refuses missing account identity and corrupted scope storage", async t => {
  const {bb,harness}=createFakePluginHost({pluginId:"boat"});t.after(()=>harness.lifecycle.dispose());
  const guard=createRentedMachineScope({provider:"instabox",kv:bb.storage.kv,read:async()=>({enabled:true,key:null,project:"https://api.instabox.sh"})});
  await assert.rejects(guard.assertAllowed(),/Configure the Instabox API key/);
  await bb.storage.kv.set(INSTABOX_GITHUB_SCOPE_KEY,{bad:"fake"});
  await assert.rejects(guard.assertAllowed(),/stored Instabox account fingerprint is invalid/);
});

test("Instabox endpoint changes block delivery even with the same key", async t => {
  const {bb,harness}=createFakePluginHost({pluginId:"boat"});t.after(()=>harness.lifecycle.dispose());
  let endpoint="https://api.instabox.sh";
  const guard=createRentedMachineScope({provider:"instabox",kv:bb.storage.kv,read:async()=>({enabled:true,key:"fake_instabox_key",project:endpoint})});
  await guard.assertAllowed();endpoint="https://example.invalid";
  await assert.rejects(guard.assertAllowed(),/Instabox API endpoint changed/);
  endpoint="https://api.instabox.sh";await assert.rejects(guard.assertAllowed(),/Instabox API endpoint changed/);
});

test("the exact REST credential transport snapshot must match its scope before any fetch", async t => {
  const {bb,harness}=createFakePluginHost({pluginId:"boat"});t.after(()=>harness.lifecycle.dispose());
  const current={enabled:true,key:"fake_pinned_instabox_key",project:"https://api.instabox.sh"};
  const guard=createRentedMachineScope({provider:"instabox",kv:bb.storage.kv,read:async()=>current});
  await guard.assertAllowed();let requests=0;
  // Simulate key resolution racing a restore to the original configuration:
  // an ordinary settings recheck sees the pin, but this request resolved another key.
  const rest=new InstaboxRest({key:async()=>"fake_raced_instabox_key",baseUrl:()=>current.project,fetch:async()=>{requests++;return new Response("{}");}});
  await assert.rejects(rest.execStream("m_example",{cmd:"true",stdin:"fake_private_stdin",timeoutSeconds:30,assertIdentity:guard.assertIdentity},()=>undefined),/credential transport changed/);
  assert.equal(requests,0);
  await assert.rejects(guard.assertAllowed(),/Instabox API key changed/);
});
for (const field of ["key", "project"] as const) test(`a changed Scaleway ${field} blocks private delivery, latches across restore/restart and stores only fingerprints`, async t => {
  const {bb,harness}=createFakePluginHost({pluginId:"boat"});t.after(()=>harness.lifecycle.dispose());
  let current={enabled:true,key,project};
  let guard=createRentedMachineScope({kv:bb.storage.kv,read:async()=>current});
  const spawns:{command:string[];stdin?:string}[]=[];const errors:string[]=[];
  const source=createCredentialSource({githubToken:async()=>token,assertDeliveryAllowed:()=>guard.assertAllowed(),agentAvailable:async()=>true,fetch:(async()=>new Response("{}",{headers:{"github-authentication-token-expiration":new Date(Date.now()+86400_000).toISOString()}})) as typeof fetch});
  const executor={exec:async(request:any)=>{spawns.push(request);return {exitCode:0};}};
  await source.ensureGithub("example-mac",executor);
  current={...current,[field]:`fake_changed_${field}`};
  await assert.rejects(source.ensureGithub("example-mac",executor),error=>{errors.push(String(error));const card=providerFailureCard({provider:"scaleway",code:(error as {code:string}).code,mac:true,released:true,canRetry:false},String(error));assert.match(card!.body,new RegExp(`Scaleway ${field==="key"?"secret key":"project"} changed`));assert.match(card!.body,/re-enable GitHub token for rented machines/);return true;});
  assert.equal(spawns.length,1,"even a cached login must re-check the account pin");
  current={enabled:true,key,project};
  guard=createRentedMachineScope({kv:bb.storage.kv,read:async()=>current});
  await assert.rejects(source.assertGithubAccess(["acme/web"]));
  await guard.tokenPresenceChanged(true).catch(error=>errors.push(String(error)));
  await assert.rejects(source.ensureGithub("example-mac",executor));
  const saved=JSON.stringify(await bb.storage.kv.get(RENTED_GITHUB_SCOPE_KEY));
  for(const value of [key,project,token,`fake_changed_${field}`])assert.ok(!saved.includes(value)&&!errors.join("\n").includes(value));
  for(const spawn of spawns)for(const value of [key,project,token])assert.ok(!JSON.stringify(spawn.command).includes(value));
  assert.deepEqual(harness.logEntries,[]);
  await guard.tokenPresenceChanged(false);await guard.tokenPresenceChanged(true);
  await source.ensureGithub("example-mac",executor,undefined,true);assert.equal(spawns.length,2);
});

test("observed settings changes remain blocked even when restored before the next use",async t=>{
  const {bb,harness}=createFakePluginHost({pluginId:"boat"});t.after(()=>harness.lifecycle.dispose());
  const current={enabled:true,key,project};
  const guard=createRentedMachineScope({kv:bb.storage.kv,read:async()=>current});await guard.assertAllowed();
  await guard.configurationChanged("project");await guard.configurationChanged("key");
  await assert.rejects(guard.assertAllowed(),/secret key and project changed|project and secret key changed/);
});

test("the actual secret-setting listener observes disable/re-enable and latches key changes",async t=>{
  const {bb,harness}=createFakePluginHost({pluginId:"boat"});t.after(()=>harness.lifecycle.dispose());
  const secrets=await defineProviderSecrets(bb);
  const guard=createRentedMachineScope({kv:bb.storage.kv,read:async()=>({enabled:Boolean(await secrets.rentedMachineGithubToken()),key:await secrets.scalewayKey(),project})});
  secrets.onScalewayKeyChange(()=>void guard.configurationChanged("key").catch(()=>{}));
  secrets.onGithubTokenPresenceChange(enabled=>void guard.tokenPresenceChanged(enabled).catch(()=>{}));
  await harness.setSettings({scalewaySecretKey:key,rentedMachineGithubToken:token});await guard.assertAllowed();
  await harness.setSettings({scalewaySecretKey:"fake_replacement_scaleway_key"});
  await assert.rejects(guard.assertAllowed(),/Scaleway secret key changed/);
  await harness.setSettings({scalewaySecretKey:key,rentedMachineGithubToken:"fake_rotated_token"});
  await assert.rejects(guard.assertAllowed(),/Scaleway secret key changed/);
  await harness.setSettings({rentedMachineGithubToken:null});
  await harness.setSettings({rentedMachineGithubToken:token});await guard.assertAllowed();
});

test("storage and snapshot errors refuse delivery without exposing their values",async t=>{
  const {bb,harness}=createFakePluginHost({pluginId:"boat"});t.after(()=>harness.lifecycle.dispose());
  const guard=createRentedMachineScope({kv:bb.storage.kv,read:async()=>{throw new Error(key);}});
  await assert.rejects(guard.assertAllowed(),error=>{assert.ok(!String(error).includes(key));assert.match(String(error),/could not be verified/);return true;});
  await assert.rejects(guard.assertAllowed(),/could not be saved/);
});

test("the plugin pins the configured account and observes ordinary project-setting changes",async t=>{
  const {createTestHost}=await import("./fakes.ts");const {default:plugin}=await import("../server.ts");
  const {mkdtemp,rm}=await import("node:fs/promises");const {tmpdir}=await import("node:os");const {join}=await import("node:path");
  const dir=await mkdtemp(join(tmpdir(),"scope-plugin-test-"));const previousState=process.env.FAKE_BOAT_STATE;
  process.env.FAKE_BOAT_STATE=join(dir,"state.json");
  const projectId="10000000-0000-4000-8000-000000000001",otherProject="10000000-0000-4000-8000-000000000002";
  const {bb,harness}=await createTestHost({pluginId:"boat",settings:{boatPath:(await import("node:url")).fileURLToPath(new URL("../src/providers/boat/fixtures/fake-boat.mjs",import.meta.url)),evidenceUploader:"",scalewaySecretKey:key,scalewayProjectId:projectId,rentedMachineGithubToken:token},agentSkillIds:["boat","boat-orchestrator"]});t.after(async()=>{await harness.lifecycle.dispose();if(previousState===undefined)delete process.env.FAKE_BOAT_STATE;else process.env.FAKE_BOAT_STATE=previousState;await rm(dir,{recursive:true,force:true});});
  harness.sdk.stub("system.config",async()=>({primaryHostId:"test_host"}));
  await plugin(bb);
  const initial=await bb.storage.kv.get<{key:string;project:string;blocked:string[]}>(RENTED_GITHUB_SCOPE_KEY);
  assert.match(initial!.key,/^[0-9a-f]{32}$/);assert.match(initial!.project,/^[0-9a-f]{32}$/);assert.deepEqual(initial!.blocked,[]);
  await harness.callRpc("saveSettings",{values:{scalewayProjectId:otherProject}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual((await bb.storage.kv.get<{blocked:string[]}>(RENTED_GITHUB_SCOPE_KEY))!.blocked,["project"]);
  await harness.callRpc("saveSettings",{values:{scalewayProjectId:projectId}});
  await new Promise(resolve=>setImmediate(resolve));
  const guard=createRentedMachineScope({kv:bb.storage.kv,read:async()=>({enabled:true,key,project:projectId})});
  await assert.rejects(guard.assertAllowed(),/Scaleway project changed/);
  await harness.setSettings({rentedMachineGithubToken:null});await harness.setSettings({rentedMachineGithubToken:token});
  await new Promise(resolve=>setImmediate(resolve));await guard.assertAllowed();
  const state=JSON.stringify(await bb.storage.kv.get(RENTED_GITHUB_SCOPE_KEY));const logs=JSON.stringify(harness.logEntries);
  for(const value of [key,token,projectId,otherProject])assert.ok(!state.includes(value)&&!logs.includes(value));
});
