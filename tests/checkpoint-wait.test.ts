import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import sharp from "sharp";
import {DebugSession} from "../electron/automation/debug-session";
import {debugToolSchemas} from "../shared/debug-protocol";
import {loadTestReport} from "../electron/desktop/test-report";
import {helperEvidenceSnapshot} from "./fixtures/helper-evidence";
const packageName="com.example.helper", serial="helper-fixture";
const condition={selector:{resourceId:`${packageName}:id/result`},state:"visible",visibility:"partial"};
const image=sharp({create:{width:100,height:200,channels:3,background:"blue"}}).png().toBuffer();
function harness(change:(snapshot:ReturnType<typeof helperEvidenceSnapshot>,read:number,signal:AbortSignal)=>void|Promise<void>=()=>{}){
 const directory=mkdtempSync(join(tmpdir(),"checkpoint-wait-"));let reads=0,inputs=0;
 const session=new DebugSession({serial,packageName,directory,snapshotPath:join(directory,"current.json"),onEvent(){},
  observe:async(_s,_p,mode,signal,backend)=>{
   assert(signal);assert.equal(mode,"fast");assert.equal(backend,"accessibility-helper");
   const snapshot=helperEvidenceSnapshot({startedAt:++reads*100});await change(snapshot,reads,signal);
   snapshot.screenshotDataUrl=`data:image/png;base64,${(await image).toString("base64")}`;signal.throwIfAborted();
   return{snapshot,target:{packageName,activityName:".Main",component:`${packageName}/.Main`,windowId:"window",activityRecordId:"activity"}};
  },input:async()=>{inputs++;throw Error("unexpected input");}});
 return{session,counts:()=>({reads,inputs}),wait:(explicit=true,timeoutMs=2000)=>session.request({name:"wait_for_ui",
  input:{sessionId:session.state.id,...condition,...explicit?{backend:"accessibility-helper"}:{},timeoutMs}}),
  capture:()=>session.request({name:"capture_ui",input:{sessionId:session.state.id,mode:"fast",backend:"accessibility-helper"}}),
  dispose:async()=>{session.stop();await session.settled();rmSync(directory,{recursive:true,force:true});}};
}
test("omitted wait backend has no default and retains source inference",()=>{
 const input=debugToolSchemas.wait_for_ui.parse({sessionId:randomUUID(),...condition});assert.equal(input.backend,undefined);
 assert.equal(debugToolSchemas.wait_for_ui.safeParse({...input,backend:"other"}).success,false);
});
for(const previous of [false,true])test(`explicit wait verifies two frames from this step with ${previous?"an older capture":"no previous capture"}`,async()=>{
 const h=harness();try{
  const old=previous?await h.capture():undefined;const result=await h.wait();assert.equal(result.verified,true);
  assert.deepEqual(h.counts(),{reads:previous?3:2,inputs:0});
  const report=await loadTestReport(h.session.state.reportPath!);const entry=report.debug!.steps.at(-1)!;
  const proof=entry.step.assertionConfirmation!;assert(proof);assert.notEqual(proof.first.snapshotId,proof.second.snapshotId);
  assert.notEqual(proof.first.snapshotId,old?.snapshotId);assert(Date.parse(proof.first.capturedAt)>=Date.parse(entry.step.time));
  for(const ref of [proof.first,proof.second]){const snapshot=report.debug!.snapshots.find(s=>s.evidence.snapshotId===ref.snapshotId)!;
   assert(snapshot.snapshot?.helperObservation&&!snapshot.treeError);assert(snapshot.evidence.screenshot);
   assert(report.images.some(image=>image.dataUrl&&!image.error));}
 }finally{await h.dispose();}
});
test("legacy wait still infers the Helper and takes two new frames",async()=>{
 const h=harness();try{await h.capture();assert.equal((await h.wait(false)).verified,true);assert.deepEqual(h.counts(),{reads:3,inputs:0});}finally{await h.dispose();}
});
test("an explicit backend change revokes the old snapshot even when the new source fails",async()=>{
 const h=harness();try{
  await h.capture();assert((await h.session.request({name:"get_debug_session",input:{}})).snapshotId);
  const result=await h.session.request({name:"wait_for_ui",input:{sessionId:h.session.state.id,
   selector:condition.selector,state:"visible",backend:"uiautomator",timeoutMs:1000}});
  assert.equal(result.isError,true);assert.equal((await h.session.request({name:"get_debug_session",input:{}})).snapshotId,null);assert.equal(h.counts().inputs,0);
 }finally{await h.dispose();}
});
test("partial assertions reject an explicit UIAutomator backend before any capture",async()=>{
 const h=harness();try{
  assert.equal((await h.session.request({name:"wait_for_ui",input:{sessionId:h.session.state.id,
   ...condition,backend:"uiautomator",timeoutMs:1000}})).isError,true);assert.deepEqual(h.counts(),{reads:0,inputs:0});
 }finally{await h.dispose();}
});
for(const kind of ["service","window","ambiguous","replayed-capture"] as const)test(`direct wait rejects ${kind} in its second frame`,async()=>{
 let captureId="";const h=harness((snapshot,read)=>{
  if(read===1){captureId=snapshot.helperObservation!.captureId;return;}
  if(kind==="service")snapshot.helperObservation!.serviceInstanceId=randomUUID();
  if(kind==="window"){snapshot.helperObservation!.windowId="8";for(const windows of [snapshot.helperObservation!.windowsBefore,snapshot.helperObservation!.windowsAfter])windows[0].id="8";snapshot.root!.attributes!["window-id"]="8";}
  if(kind==="ambiguous"){snapshot.root!.children=[{...structuredClone(snapshot.root!),id:"duplicate",children:[]}];snapshot.nodeCount++;}
  if(kind==="replayed-capture")snapshot.helperObservation!.captureId=captureId;
 });try{assert.equal((await h.wait()).isError,true);assert.deepEqual(h.counts(),{reads:2,inputs:0});assert.equal(h.session.state.steps.at(-1)!.assertionConfirmation,undefined);}finally{await h.dispose();}
});
test("explicit first read cannot replace the service already bound by a prior Helper capture",async()=>{
 const h=harness((snapshot,read)=>{if(read===2)snapshot.helperObservation!.serviceInstanceId=randomUUID();});
 try{await h.capture();assert.equal((await h.wait()).isError,true);assert.deepEqual(h.counts(),{reads:2,inputs:0});}finally{await h.dispose();}
});
test("identity restart still discards both original frames and needs a fresh stable pair",async()=>{
 const h=harness((snapshot,read)=>{snapshot.root!.id=read===1?"0/0":"0/1";});
 try{assert.equal((await h.wait()).verified,true);assert.deepEqual(h.counts(),{reads:4,inputs:0});}finally{await h.dispose();}
});
for(const cancel of [false,true])test(`direct wait keeps ${cancel?"cancellation":"the original deadline"}`,async()=>{
 const h=harness(async(_snapshot,read,signal)=>{if(read!==2)return;if(cancel)h.session.stop();await new Promise<void>((_r,reject)=>{
  signal.addEventListener("abort",()=>reject(signal.reason),{once:true});if(signal.aborted)reject(signal.reason);
 });});
 try{assert.equal((await h.wait(true,1000)).isError,true);assert.deepEqual(h.counts(),{reads:2,inputs:0});assert.equal(h.session.state.steps.at(-1)!.assertionConfirmation,undefined);}finally{await h.dispose();}
});
