import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const sdk = (name: string) => readFileSync(new URL(`../android/inspector-sdk/src/main/java/com/androiduiinspector/sdk/${name}.java`, import.meta.url), "utf8");

test("SDK Provider owns lifecycle, authorization and dispatch; tree/capture do not own transport", () => {
  const provider = sdk("HierarchyProvider"), capture = sdk("HierarchyCapture"), tree = sdk("HierarchyTree"), session = sdk("HierarchySession");
  assert.match(provider, /private synchronized Bundle dispatch\(/);
  assert.match(provider, /synchronized \(this\)/);
  assert.match(provider, /Binder\.getCallingUid\(\) != 2000/);
  assert.match(provider, /FLAG_DEBUGGABLE/);
  assert.match(provider, /processInstance, \(\) -> resumed\.get\(\), treeQueueTask, this::notifyTreeReady/);
  assert.match(provider, /try \{ answer = dispatch\(method, arg, extras\); \}\s*finally \{ treeReadyOutput\.remove\(\); \}/);
  assert.doesNotMatch(provider, /import android\.graphics\.|import android\.net\.Local|class CaptureTiming|JSONObject captureTree\(/);
  assert.doesNotMatch(capture, /\bHierarchyProvider\b|\bBinder\b|\bContentProvider\b|\bLocalSocket\b|\bLocalServerSocket\b/);
  assert.match(capture, /java\.util\.concurrent\.Callable<Activity> resumed/);
  assert.match(capture, /TreeQueueDiagnostics\.Sink notifyTreeReady/);
  assert.doesNotMatch(capture, /(?:private final |import )java\.util\.function\./);
  assert.doesNotMatch(tree, /\bHierarchyProvider\b|\bHierarchyCapture\b|\bHandler\b|\bLooper\b|\bBitmap\b|\bLocalSocket\b/);
  assert.match(tree, /static JSONObject captureTree\(Application app, View root, String processInstance\)/);
  assert.match(session, /clients\.size\(\) >= 2/);
  assert.match(session, /uid != 2000 && uid != 0/);
  assert.match(session, /provider\.dispatchSession\(request\.method, request\.arg, request\.extras, uid, output\)/);
  assert.doesNotMatch(session, /\bHandler\b|\bView\b|isDataMethod|isDiagnosticMethod|treeReadyOutput/);
  for (const name of ["HierarchyCapture", "HierarchySession", "HierarchyTree", "CaptureFrame", "CaptureOutput", "CapturePipeline", "RefCaptureSelection"])
    assert.doesNotMatch(sdk(name), /public (?:final )?class/, `${name}: implementation is package-private`);
});

test("sample reflection follows capture/tree owners without leaving old Provider method references", () => {
  const sample = (name: string) => readFileSync(new URL(`../android/sample-app/src/debug/java/com/androiduiinspector/sample/${name}.java`, import.meta.url), "utf8");
  for (const name of ["ProbeRunner", "SnapshotEncodingProbe", "CaptureFailureProbe", "MergedTreeFailureProbe", "GeometrySerializationProbe", "GeometryPipelineProbe", "SnapshotPipeline", "HardwarePipelineCapture"])
    assert.doesNotMatch(sample(name), /HierarchyProvider\$|HierarchyProvider"\)\.getDeclaredMethod/, name);
  assert.match(sample("BranchRecoveryText"), /HierarchyTree"\)\s*&& frame\.getMethodName\(\)\.equals\("captureTree"\)/);
  assert.match(sample("BranchRecoveryText"), /CaptureFrame"\)\s*&& frame\.getMethodName\(\)\.equals\("captureFrameOnUiThread"\)/);
  const isolated = sdk("IsolatedCapture");
  assert.match(isolated, /AtomicReference<CaptureFrame\.CapturePhase>/);
  assert.doesNotMatch(isolated, /HierarchyProvider/);
});

test("SDK frame verification and output encoding have one-way ownership, without compatibility shells", () => {
  const capture = sdk("HierarchyCapture"), frame = sdk("CaptureFrame"), output = sdk("CaptureOutput");
  assert.match(capture, /new CaptureOutput\(processInstance\)/);
  assert.match(capture, /this\.output\.writeGeometryFile\(app, nonce, ref\(selectedRoot\.get\(\)\)/);
  assert.doesNotMatch(capture, /class CapturedFrame|class CaptureTiming|class VisibleRecord|class GeometryRecords|\bbitmap\.compress\(|\bprivate static CapturedFrame captureFrame/);
  assert.doesNotMatch(frame, /\bCaptureOutput\b|\bHierarchyCapture\b|\bHierarchyProvider\b|FileOutputStream|MessageDigest|ExecutorService/);
  assert.match(frame, /Capture must run on UI thread/);
  assert.match(frame, /if \(!accepted\) bitmap\.recycle\(\)/);
  assert.match(frame, /abandoned\[0\] = true;[\s\S]*late\.bitmap\.recycle\(\)/);
  assert.doesNotMatch(output, /\bView\b(?=\s+\w+\s*[,;)])|import android\.view\.|import android\.os\.(?:Handler|Looper)|\bHierarchyCapture\b|\bHierarchyProvider\b/);
  assert.match(output, /void writeGeometryFile\(Application app, String nonce, String rootRef/);
  assert.match(output, /bitmap\.recycle\(\)/);
  assert.match(output, /static String writePng\(Application app, String fileName, Bitmap bitmap, int byteLimit\)/);
  const pipeline = sdk("CapturePipeline"), selection = sdk("RefCaptureSelection");
  assert.match(capture, /new CapturePipeline\(/, "capture orchestration uses the common queue");
  assert.match(capture, /new RefCaptureSelection\(/, "ref preparation has a scoped owner");
  assert.doesNotMatch(capture, /ExecutorService|Executors\.|ArrayDeque<Future</, "queue scheduling belongs to the common pipeline");
  for (const [name, source] of [["CapturePipeline", pipeline], ["RefCaptureSelection", selection]]) {
    assert.doesNotMatch(source, /import android\.(?:view|app)\.|import android\.os\.(?:Handler|Looper)|\bHierarchy(?:Provider|Session|Capture|Tree)\b/, `${name}: no live View or transport ownership`);
  }
  assert.doesNotMatch(selection, /ExecutorService|CapturePipeline|CaptureOutput|java\.io\./, "selection only owns prepared input lifetimes");
});

test("SDK capture probes live only in debug source sets and production does not depend on samples", () => {
  const main = new URL("../android/inspector-sdk/src/main/java/com/androiduiinspector/sdk/", import.meta.url);
  const probe = readFileSync(new URL("../android/inspector-sdk/src/debug/java/com/androiduiinspector/sdk/DebugCaptureProbe.java", import.meta.url), "utf8");
  assert.match(probe, /public (?:final )?class DebugCaptureProbe/);
  for (const file of readdirSync(main).filter(name => name.endsWith(".java"))) {
    assert.doesNotMatch(readFileSync(new URL(file, main), "utf8"), /\bDebugCaptureProbe\b|com\.androiduiinspector\.sample/, `${file}: production cannot depend on a debug probe or sample`);
  }
  const geometry = readFileSync(new URL("../android/sample-app/src/debug/java/com/androiduiinspector/sample/GeometryPipelineProbe.java", import.meta.url), "utf8");
  assert.match(geometry, /DebugCaptureProbe/, "sample exercises the stable debug contract");
  assert.doesNotMatch(geometry, /com\.androiduiinspector\.sdk\.(?:HierarchyCapture|CaptureFrame|CaptureOutput|CapturePipeline)(?:\$|")/, "sample must not discover private capture implementation classes");
});
