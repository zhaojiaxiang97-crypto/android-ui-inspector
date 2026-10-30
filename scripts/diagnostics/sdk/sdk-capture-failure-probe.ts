// Debug sample only: real UI-queue/draw timeouts and subsequent recovery. No business App changes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { parseSdkCaptureFailure, parseSdkTaskDiagnostics } from "../../../electron/sdk/capture-protocol";
import { parseCaptureGeometryEvidence } from "../../../electron/capture/layer-images";
import { rectangularCapturePlacement } from "../../../shared/capture-transform";

const serial = process.argv[2];
assert.ok(serial && /^[\w.:-]+$/.test(serial), "Usage: bun scripts/diagnostics/sdk/sdk-capture-failure-probe.ts SERIAL");
const app = "com.androiduiinspector.sample", file = "files/capture-failure-probe.json";
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], {timeout:15000, maxBuffer:1000000});
const output = join(fileURLToPath(new URL("../../../",import.meta.url)), ".benchmarks", "capture-failure", new Date().toISOString().replace(/[:.]/g,"-"));
mkdirSync(output, {recursive:true});
// Preserve any earlier failing report before replacing this one generated sample file.
try { writeFileSync(join(output,"previous.json"),adb("exec-out","run-as",app,"cat",file)); } catch { }
adb("shell","am","force-stop",app);
adb("shell","run-as",app,"rm","-f",file);
adb("shell","am","start","-n",`${app}/.MainActivity`,"--es","mode","failure-diagnostic");
let report: any;
for(let i=0;i<40;i++) {
  await wait(500);
  try { report=JSON.parse(adb("exec-out","run-as",app,"cat",file).toString()); break; } catch { }
}
assert.ok(report,"No fresh sample report");
writeFileSync(join(output,"result.json"),JSON.stringify(report,null,2));
assert.equal(report.passed,true,report.error);
const short = report.shortParentDiagnostic;
const decoded = parseCaptureGeometryEvidence(Buffer.from(JSON.stringify([short])).toString("base64"), [short.ref], short.rootRef).get(short.ref)!;
assert.equal(decoded.diagnosticOnly, true);
assert.equal(report.shortParentPixelsUnchanged, true);
assert.equal(rectangularCapturePlacement(decoded, short.chain[0][4], short.chain[0][5]), null);
const tasks = parseSdkTaskDiagnostics(k=>report.taskFixture[k]);
assert.equal(tasks["sdk-task-queue-buckets"],"1;2;2;2;5");
assert.equal(tasks["sdk-task-slow"].split(";").length,8);
assert.equal(report.windowVerificationOnUi,true);
assert.equal(report.changedRootRejected,true);
assert.equal(report.missingActivityRejected,true);
assert.equal(report.queue.phase,"ui-queue"); assert.ok(report.queue.waitMs>=3000 && report.queue.waitMs<=65000);
assert.equal(report.prepare.phase,"draw-prepare"); assert.equal(report.prepareRecovery,true);
for (const item of [report.queue,report.prepare,report.draw]) {
  assert.ok(item.phaseStartedMs>=0 && item.phaseWaitMs>=0 && item.phaseWaitMs<=item.waitMs);
  assert.ok(Math.abs(item.phaseStartedMs+item.phaseWaitMs-item.waitMs)<=1);
  assert.equal(item.timing.version,1); assert.equal(item.timing.observedMs,item.waitMs);
  for (const key of ["queueMs","geometryMs","drawMs","verifyMs","snapshotPrepareMs","snapshotInvokeMs"])
    assert.ok(Number.isSafeInteger(item.timing[key]) && item.timing[key]>=0);
}
assert.equal(report.queue.timing.enteredMs,undefined);
assert.ok(report.prepare.timing.enteredMs>=0);
assert.equal(report.prepare.timing.snapshotStartedMs,undefined);
assert.ok(report.draw.timing.enteredMs<=report.draw.timing.snapshotStartedMs);
assert.ok(report.draw.timing.snapshotStartedMs<=report.draw.waitMs);
assert.equal(report.draw.timing.snapshotReturnedMs,undefined);
assert.equal(report.queueRecovery,true); assert.equal(report.drawRecovery,true);
const fields={...report.draw,error:"View capture timed out",failurePhase:report.draw.phase,failureTarget:report.draw.target,
  failureWaitMs:String(report.draw.waitMs),failureCompleted:String(report.draw.completed),
  failurePhaseStartedMs:String(report.draw.phaseStartedMs),failurePhaseWaitMs:String(report.draw.phaseWaitMs),
  failureTiming:JSON.stringify(report.draw.timing)};
const diagnostics=parseSdkCaptureFailure(k=>(fields as Record<string,string>)[k],"1234567890abcdef",report.draw.rootRef,report.draw.processInstance);
assert.equal(diagnostics?.["sdk-visible-failure-phase"],"draw-snapshot");
assert.equal(diagnostics?.["sdk-visible-failure-phase-wait-ms"],String(report.draw.phaseWaitMs));
assert.equal(diagnostics?.["sdk-visible-failure-completed"],"0");
assert.deepEqual(JSON.parse(diagnostics!["sdk-visible-failure-timing"]),report.draw.timing);
console.log(JSON.stringify({passed:true,queue:report.queue,prepare:report.prepare,draw:report.draw,diagnostics,output}));
