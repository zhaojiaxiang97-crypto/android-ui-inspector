import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { DebugSession } from "../electron/automation/debug-session";
import { debugToolSchemas } from "../shared/debug-protocol";
import { helperEvidenceSnapshot } from "./fixtures/helper-evidence";
import { loadTestReport } from "../electron/desktop/test-report";
import { exportDebugReportEvidence } from "../electron/desktop/debug-report-export";
import type { UiSnapshot } from "../shared/types";

const packageName="com.example.helper",serial="helper-fixture";
const primary={selector:{resourceId:packageName+":id/result"},state:"visible" as const};
const extra=[{selector:{resourceId:packageName+":id/flag"},state:"enabled" as const},
  {selector:{resourceId:packageName+":id/gone"},state:"absent" as const}];
const image=sharp({create:{width:100,height:200,channels:4,background:"black"}}).png().toBuffer().then(b=>"data:image/png;base64,"+b.toString("base64"));
function harness(change?: (snapshot:UiSnapshot,read:number)=>void) {
  const directory=mkdtempSync(join(realpathSync(tmpdir()),"grouped-wait-"));let reads=0,inputs=0;
  const session=new DebugSession({serial,packageName,directory,snapshotPath:join(directory,"current.json"),onEvent(){},
    input:async()=>{inputs++;}, observe:async()=>{
      const snapshot=helperEvidenceSnapshot({startedAt:++reads*100});snapshot.screenshotDataUrl=await image;
      const child={...structuredClone(snapshot.root!),id:"0/0",text:"flag",resourceId:extra[0].selector.resourceId,children:[],
        bounds:{left:10,top:40,right:90,bottom:100,raw:"[10,40][90,100]"}};
      child.attributes={...child.attributes,text:"flag","resource-id":child.resourceId!,bounds:"[10,40][90,100]",
        "bounds-screen":"[10,40][90,100]","visible-bounds":"[10,40][90,100]"};
      snapshot.root!.children=[child];snapshot.nodeCount=2;change?.(snapshot,reads);
      return {snapshot,target:{packageName,activityName:".Main",component:packageName+"/.Main",windowId:"window",activityRecordId:"activity-1"}};
    }});
  return {directory,session,counts:()=>({reads,inputs}),run:(timeoutMs=3000)=>session.request({name:"wait_for_ui",input:{sessionId:session.state.id,
    backend:"accessibility-helper",...primary,additionalConditions:extra,timeoutMs}}),
    async dispose(){session.stop();await session.settled();rmSync(directory,{recursive:true,force:true});}};
}

test("grouped waits require explicit Helper, valid nonempty conditions and at most five total",()=>{
  const input={sessionId:randomUUID(),...primary,additionalConditions:extra};
  assert.equal(debugToolSchemas.wait_for_ui.safeParse(input).success,false);
  assert.equal(debugToolSchemas.wait_for_ui.safeParse({...input,backend:"uiautomator"}).success,false);
  assert.equal(debugToolSchemas.wait_for_ui.safeParse({...input,backend:"accessibility-helper"}).success,true);
  for(const additionalConditions of [[],Array(5).fill(extra[0]),[{...extra[1],visibility:"partial"}], [{selector:{},state:"visible"}]])
    assert.equal(debugToolSchemas.wait_for_ui.safeParse({...input,backend:"accessibility-helper",additionalConditions}).success,false);
});

test("three conditions share exactly two new complete frames and survive independent export/import",async()=>{
  const h=harness();try {
    const result=await h.run();assert.equal(result.verified,true,JSON.stringify(result));assert.deepEqual(h.counts(),{reads:2,inputs:0});
    assert.deepEqual((result.conditionResults as any[]).map(r=>[r.conditionId,r.status]),[["wait_0","passed"],["wait_1","passed"],["wait_2","passed"]]);
    const reportPath=h.session.state.reportPath!, loaded=await loadTestReport(reportPath),entry=loaded.debug!.steps.at(-1)!;
    assert.equal(entry.verified,true);assert(entry.step.assertionConfirmation);
    const saved=readFileSync(reportPath),hash=(await import("node:crypto")).createHash("sha256").update(saved).digest("hex");
    const exported=await exportDebugReportEvidence({filePath:reportPath,reportSha256:hash},{requestId:randomUUID(),sourceId:h.session.state.id,
      reportSha256:hash,stepIds:[entry.step.id],includeTrees:true,includeScreenshots:true,includeLogs:false},h.directory,{appVersion:"test"});
    assert.equal(exported.error,null);assert.equal((await loadTestReport(join(exported.directory!,"report.json"))).debug!.steps[0].verified,true);
    const tampered=JSON.parse(saved.toString());
    tampered.steps[0].step.input.additionalConditions[0].selector.resourceId=packageName+":id/miss";
    writeFileSync(reportPath,JSON.stringify(tampered));
    assert.notEqual((await loadTestReport(reportPath)).debug!.steps[0].verified,true,"import must recheck every additional condition");
    writeFileSync(reportPath,saved);
    // Removing either frame cannot retain a pass when the same pair proves all conditions.
    const proof=entry.step.assertionConfirmation!, tree=loaded.debug!.snapshots.find(s=>s.evidence.snapshotId===proof.first.snapshotId)!.evidence.tree!;
    rmSync(join(h.session.state.reportPath!.replace(/\/report.json$/,""),tree.path));
    assert.notEqual((await loadTestReport(reportPath)).debug!.steps.at(-1)!.verified,true);
  }finally{await h.dispose();}
});

test("a later-changing additional condition still needs two new matching frames",async()=>{
  const h=harness((s,read)=>{const child=s.root!.children[0];child.enabled=read>=3;child.attributes!.enabled=String(child.enabled);});try{
    const result=await h.run();assert.equal(result.verified,true,JSON.stringify(result));assert.deepEqual(h.counts(),{reads:4,inputs:0});
  }finally{await h.dispose();}
});

test("grouped evidence rejects ambiguity, incomplete trees, changed service and occlusion without input",async()=>{
  for(const change of [
    (s:UiSnapshot)=>{s.root!.children.push({...structuredClone(s.root!.children[0]),id:"0/1"});s.nodeCount++;},
    (s:UiSnapshot)=>{s.nodeCount++;},
    (s:UiSnapshot,r:number)=>{if(r===2)s.helperObservation!.serviceInstanceId=randomUUID();},
    (s:UiSnapshot)=>{const e=s.helperObservation!;e.windowsBefore.push({id:"8",type:"system",layer:2,active:false,focused:false,
      packageName:"com.android.systemui",rootAvailable:true,bounds:{x:0,y:30,width:100,height:90}});e.windowsAfter=structuredClone(e.windowsBefore);},
  ]) {const h=harness(change);try{assert.notEqual((await h.run()).verified,true);assert.equal(h.counts().inputs,0);}finally{await h.dispose();}}
});

test("an unmet additional condition expires under the original shared budget without input",async()=>{
  const h=harness(s=>{const n=s.root!.children[0];n.enabled=false;n.attributes!.enabled="false";});
  try {const result=await h.run(1000);assert.notEqual(result.verified,true);assert.equal(h.counts().inputs,0);
    assert(h.counts().reads<5);assert(!h.session.state.steps[0].assertionConfirmation);
  }finally{await h.dispose();}
});
