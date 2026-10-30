// Sample-only IPC check: stable success, moving tree early rejection, stable recovery.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseSdkStaleTree } from "../../../electron/sdk/sdk-stale-tree";
import { inspectPreferredDevice } from "../../../electron/capture/inspection";
import { createProviderSessionPool } from "../../../electron/sdk/provider-session";
const serial=process.argv[2]; assert.ok(serial && /^[\w.-]+$/.test(serial));
const app="com.androiduiinspector.sample";
const adb=(...args:string[])=>execFileSync("adb",["-s",serial,...args],{encoding:"utf8",timeout:15000,maxBuffer:5000000});
const directory=join(import.meta.dirname,"../../../.benchmarks/visible-tree-guard",new Date().toISOString().replace(/[:.]/g,"-"));
mkdirSync(directory,{recursive:true}); console.log(`Tree guard output: ${directory}`);
const previous=/(?:mResumedActivity:|topResumedActivity=).*?\s([\w.]+\/[\w.$]+)\s/.exec(adb("shell","dumpsys","activity","activities"))?.[1];
const records:any[]=[];
const provider = createProviderSessionPool();
try {
  for(const mode of ["default","capture-geometry","default"]) {
    adb("shell","am","force-stop",app);
    adb("shell","am","start","-n",`${app}/.MainActivity`,"--es","mode",mode);
    await delay(1000);
    const nonce=randomBytes(8).toString("hex"), started=performance.now();
    const reply=adb("shell","content","call","--uri",`content://${app}.inspector`,"--method","capture-visible",
      "--arg",nonce,"--extra","withTree:b:true","--extra","geometryFile:b:true");
    const durationMs=Math.round(performance.now()-started);
    const tree=JSON.parse(adb("exec-out","run-as",app,"cat",`no_backup/inspector-tree-${nonce}.json`));
    const field=(key:string)=>new RegExp(`\\b${key}=([^,}\\]]+)`).exec(reply)?.[1];
    records.push({mode,durationMs,reply});
    writeFileSync(join(directory,"attempts.json"),JSON.stringify(records,null,2));
    assert.equal(tree.visibleTreeGuardVersion,1);
    if(mode==="capture-geometry") {
      const rejection = parseSdkStaleTree(field,nonce,tree.root.ref,tree.processInstance);
      assert.ok(rejection,reply);
      const difference = JSON.parse(rejection["sdk-visible-failure-geometry"] ?? "null");
      assert.ok(difference && ["before", "after"].includes(difference.phase), "new SDK must report drawing boundary and geometry difference");
      assert.ok(["position", "size"].includes(difference.reason));
      assert.ok(difference.delta.some((value:number)=>value!==0));
      records[records.length-1].difference = difference;
      writeFileSync(join(directory,"attempts.json"),JSON.stringify(records,null,2));
      assert.ok(Number(field("failureCompleted"))<Number(field("failureSelected")));
      assert.ok(!/result=ok/.test(reply));
      assert.ok(durationMs<10000,"early guard exceeded sample budget");
      const probeStarted=performance.now();
      const rejected=await inspectPreferredDevice(provider, serial,{expectedPackage:app,preferVisibleSdk:true,onPreview:()=>{}});
      records[records.length-1].preferredCheck={durationMs:Math.round(performance.now()-probeStarted),error:rejected.error,
        root:rejected.root,nodeCount:rejected.nodeCount,diagnostics:rejected.captureRequestDiagnostics};
      writeFileSync(join(directory,"attempts.json"),JSON.stringify(records,null,2));
      assert.match(rejected.error??"",/^SDK 已发布控件树在绘制期间变化/);
      assert.equal(rejected.root,null); assert.equal(rejected.nodeCount,0);
      assert.equal(rejected.captureRequestDiagnostics?.totalAttempts,1,"guard must not retry or run compatibility drawing");
      assert.equal(rejected.captureRequestDiagnostics?.attempts[0].sdkFailure["sdk-visible-failure-phase"],"tree-guard");
      assert.ok(records[records.length-1].preferredCheck.durationMs<15000);
      await provider.releaseAll();
    } else assert.match(reply,/result=ok/);
    console.log(JSON.stringify({mode,durationMs,completed:field("failureCompleted"),selected:field("failureSelected"),guard:field("failureKind")}));
    adb("shell","run-as",app,"rm","-f",`no_backup/inspector-tree-${nonce}.json`,`no_backup/inspector-geometry-${nonce}.json`);
  }
  writeFileSync(join(directory,"summary.json"),JSON.stringify({passed:true,records,scope:"sample IPC guard and recovery; not business performance or pixel acceptance"},null,2));
} catch(error) {writeFileSync(join(directory,"summary.json"),JSON.stringify({passed:false,error:String(error),records},null,2));throw error;}
finally {await provider.dispose();if(previous&&!previous.startsWith(`${app}/`)) adb("shell","am","start","-n",previous);}
