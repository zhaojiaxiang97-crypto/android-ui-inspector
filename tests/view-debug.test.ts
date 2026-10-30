import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:net";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { applyViewProperties, debugViewTree, hasActivityHierarchy, isTransientTreeReadError, nativeViewBranchContextMatches, nativeViewBranchMatches, nativeViewNodeMatches } from "../electron/capture/native-tree";
import { attachViewLayerImages, matchSdkVisibleLayers, needsViewBitmapFallback } from "../electron/capture/layer-images";
import { captureSignal } from "../electron/device/runtime";
import { isSdkVisibleCaptureInterruption, markInterruptedSdkImages, parsePureViewRefs, parseViewStyleReply } from "../electron/sdk/capture-protocol";
import { partitionViewItems } from "../electron/capture/refresh";
import { shouldReclaimSession } from "../electron/sdk/provider-session";
import { captureViewBitmaps } from "../electron/capture/view-bitmaps";
import { captureViewLayers } from "../electron/capture/view-debug";
import { matchesViewRoot, parseCapturedViewLayers, parseCapturedViewLayerPrefix } from "../electron/capture/view-protocol";
import type { ViewHierarchyTiming } from "../electron/capture/view-debug";
import { inspectQmlHierarchy } from "../electron/capture/qml-debug";
import { makeNode } from "../benchmarks/fixtures";
import { decodeViewHierarchy } from "../electron/capture/view-hierarchy";
import type { UiNode } from "../shared/types";
import { applyVerifiedSdkViewTypes, parseCaptureGeometryFile, summarizeSdkGeometry } from "../electron/capture/layer-images";
import { captureSdkRefOrFallback, checkSdkMergedTreeOutcome, markFailedSupplementImages, parseSdkCaptureFailure, parseSdkTaskDiagnostics, parseSdkCapturePhases, settleSdkMergedTree } from "../electron/sdk/capture-protocol";

test("SDK supplementary UI timeouts never dispatch JDWP; unsupported replies keep compatibility", async () => {
  for (const message of ["SDK 补齐抓取失败：java.lang.IllegalStateException: View selection timed out",
    "SDK 补齐抓取失败：View capture timed out", "SDK 补齐抓取失败：View capture could not reach UI thread",
    "SDK 补齐抓取失败：Visible capture time budget exceeded", "SDK 补齐抓取失败：java.lang.InterruptedException",
    "会话调用超时：capture-refs"]) {
    const failure = new Error(message); let reported: unknown; let jdwp = 0;
    await assert.rejects(captureSdkRefOrFallback(async () => { throw failure; }, async () => { jdwp++; return "jdwp"; },
      error => { reported = error; }), error => error === failure);
    assert.equal(jdwp, 0); assert.equal(reported, failure);
  }
  for (const message of ["SDK 补齐抓取失败：Unauthorized or unsupported request", "SDK 补齐抓取失败：响应无效",
    "会话通道已关闭", "会话调用超时：capture", "View selection timed out"]) {
    let jdwp = 0;
    assert.equal(await captureSdkRefOrFallback(async () => { throw new Error(message); }, async () => { jdwp++; return "jdwp"; }, () => {}), "jdwp");
    assert.equal(jdwp, 1);
  }
  assert.equal(await captureSdkRefOrFallback(async () => "sdk", async () => { assert.fail("no fallback after success"); }, () => { assert.fail("no error"); }), "sdk");
});

test("supplementary cancellation never dispatches compatibility capture or converts cancellation into failure", async () => {
  const controller = new AbortController(), canceled = new Error("Canceled");
  await assert.rejects(captureSdkRefOrFallback(async () => { controller.abort(canceled); throw new Error("unsupported"); },
    async () => { assert.fail("no fallback"); }, () => { assert.fail("do not report SDK failure"); }, controller.signal), error => error === canceled);
  await assert.rejects(captureSdkRefOrFallback(async () => { assert.fail("no capture"); }, async () => { assert.fail("no fallback"); },
    () => {}, controller.signal), error => error === canceled);
});

test("supplementary interruption only marks pending candidates and preserves verified images and earlier reasons", () => {
  const root = makeNode("root"), image = makeNode("image"), pending = makeNode("pending"), stale = makeNode("stale"), other = makeNode("other");
  root.children = [image, pending, stale, other];
  image.layerImageStatus = "captured"; image.layerImageDataUrl = "data:image/png;base64,AA==";
  image.layerImageSize = { width: 10, height: 20 }; image.attributes = { "image-source": "sdk" };
  stale.attributes = { "image-capture-error": "geometry mismatch" };
  other.layerImageStatus = "style";
  const before = structuredClone(image), bounds = structuredClone(pending.bounds);
  markFailedSupplementImages(root, [image, pending, stale], new Error("SDK 补齐抓取失败：View selection timed out"));
  assert.deepEqual(image, before); assert.deepEqual(pending.bounds, bounds);
  assert.equal(pending.layerImageStatus, "failed"); assert.match(pending.attributes!["image-capture-error"], /View selection timed out/);
  assert.equal(stale.attributes!["image-capture-error"], "geometry mismatch"); assert.equal(other.layerImageStatus, "style");
  assert.match(root.attributes!["texture-capture-warning"], /保留此前采集结果/);
});

test("SDK rejected geometry summary is bounded and never retains pixels or changes matching", () => {
  const root = makeNode("0"), parent = makeNode("0/0"), node = makeNode("0/0/0");
  parent.attributes = { "view-ref": "example.Parent@1" };
  node.attributes = { "view-ref": "example.Child@2" };
  parent.children = [node]; root.children = [parent];
  const layer = { name: "example.Child@2", x: node.bounds!.left + 50, y: node.bounds!.top,
    width: node.bounds!.right - node.bounds!.left, height: node.bounds!.bottom - node.bounds!.top,
    visible: true, imageDataUrl: "private-pixels", geometry: { ref: "example.Child@2", rootRef: "example.Parent@1",
      started: 10, ended: 20, rootReached: true, chain: [["example.Child@2", "example.Parent@1", 50, 0, 10, 10],
        ["example.Parent@1", "", 50, 0, 10, 10]] } };
  const summary = JSON.parse(summarizeSdkGeometry(root, [layer]));
  assert.equal(summary.counts.position, 1);
  assert.deepEqual(summary.deltas, [["50,0", 1]]);
  assert.equal(summary.samples[0].treeParent, "example.Parent@1");
  assert.equal(summary.samples[0].evidence.chain.length, 2);
  assert.equal(JSON.stringify(summary).includes("private-pixels"), false);
  assert.throws(() => matchSdkVisibleLayers(root, [layer]), /重新读取控件树/);
  const many = Array.from({ length: 40 }, (_, i) => ({ ...layer, name: `example.Other@${i}` }));
  const bounded = JSON.parse(summarizeSdkGeometry(root, many));
  assert.equal(bounded.counts.missing, 40);
  assert.equal(bounded.samples.length, 8);
  const noEvidence = JSON.parse(summarizeSdkGeometry(root, [{ ...layer, geometry: undefined }]));
  assert.equal(noEvidence.samples[0].evidence, null);
});

test("SDK queue diagnostics are bounded, optional and separate from pixel validation", () => {
  const fields = {uiQueueBuckets:"1;2;3;4;5",uiQueueMaxMs:"400",uiSlowTasks:"example.View@12|20|400|60"};
  const parse = (v: Record<string,string>) => parseSdkTaskDiagnostics(k=>v[k]);
  assert.equal(parse(fields)["sdk-task-queue-max-ms"],"400");
  assert.deepEqual(parse({}),{});
  assert.equal(parse({...fields,uiSlowTasks:"-"})["sdk-task-slow"],"-");
  for (const [key,value] of Object.entries({uiQueueBuckets:"5001;0;0;0;0",uiQueueMaxMs:"-1",uiSlowTasks:"bad|0|0|50"}))
    assert.deepEqual(parse({...fields,[key]:value}),{});
  for (const value of ["example.View@12|0|401|60","example.View@12|0|0|49","example.View@12|65001|0|50",
    Array(9).fill(fields.uiSlowTasks).join(";"),"x".repeat(3001)]) assert.deepEqual(parse({...fields,uiSlowTasks:value}),{});
  assert.deepEqual(parse({...fields,uiQueueBuckets:"1000;1000;1000;1000;1001"}),{});
});

test("SDK timeout diagnostics are optional, bounded and bound to the failed request", () => {
  const fields: Record<string,string> = {error:"View capture timed out", nonce:"abc", rootRef:"example.Root@12", processInstance:"12345678-1234-1234-1234-123456789012", failurePhase:"draw", failureTarget:"example.View@34", failureWaitMs:"3000", failureCompleted:"0"};
  const parse = (values: Record<string,string>) => parseSdkCaptureFailure(k=>values[k], "abc", "example.Root@12", fields.processInstance);
  assert.equal(parse(fields)?.["sdk-visible-failure-phase"], "draw");
  assert.equal(parseSdkCaptureFailure(()=>undefined,"abc","example.Root@12"),null);
  for (const [key,value] of Object.entries({nonce:"other",rootRef:"example.Root@99",processInstance:"00000000-0000-0000-0000-000000000000",failurePhase:"unknown",failureTarget:"bad ref",failureWaitMs:"65001",failureCompleted:"5001",result:"ok",error:"Unsupported"}))
    assert.equal(parse({...fields,[key]:value}),null,key);
  for (const value of ["-1","NaN","1.5",""]) assert.equal(parse({...fields,failureWaitMs:value}),null);
  assert.equal(parse({...fields,failurePhase:"ui-queue"})?.["sdk-visible-failure-completed"],"0");
  assert.equal(parseSdkCaptureFailure(k=>fields[k],"abc","example.Root@12" )?.["sdk-visible-failure-phase"],"draw");
  for (const phase of ["draw-prepare", "draw-snapshot"]) {
    const newer = {...fields,failurePhase:phase,failurePhaseStartedMs:"100",failurePhaseWaitMs:"2900"};
    assert.equal(parse(newer)?.["sdk-visible-failure-phase"],phase);
    assert.equal(parse(newer)?.["sdk-visible-failure-phase-wait-ms"],"2900");
    for (const [key,value] of Object.entries({failurePhaseStartedMs:"3001",failurePhaseWaitMs:"3001"}))
      assert.equal(parse({...newer,[key]:value}),null);
    for (const value of ["-1","NaN","1.5","", "2800"]) assert.equal(parse({...newer,failurePhaseWaitMs:value}),null);
    assert.equal(parse({...fields,failurePhaseStartedMs:"100"}),null);
    assert.equal(parse({...newer,failurePhaseStartedMs:"99"})?.["sdk-visible-failure-phase"],phase);
  }
});

test("SDK failure timeline separates queue, snapshot entry and return without authorizing results", () => {
  const fields: Record<string,string> = {error:"View capture timed out", nonce:"abc", rootRef:"example.Root@12",
    processInstance:"12345678-1234-1234-1234-123456789012", failurePhase:"draw-snapshot", failureTarget:"example.View@34",
    failureWaitMs:"3000", failureCompleted:"10"};
  const timeline = {version:1, observedMs:3000, enteredMs:250, snapshotStartedMs:300,
    queueMs:400, geometryMs:12, drawMs:150, verifyMs:4, snapshotPrepareMs:5, snapshotInvokeMs:100};
  const parse = (value: unknown, extra: Record<string,string> = {}) => parseSdkCaptureFailure(
    k=>({...fields, ...extra, failureTiming:JSON.stringify(value)})[k], "abc", "example.Root@12", fields.processInstance);
  assert.deepEqual(JSON.parse(parse(timeline)!["sdk-visible-failure-timing"]), timeline);
  assert.equal(JSON.parse(parse({...timeline,snapshotReturnedMs:2999})!["sdk-visible-failure-timing"]).snapshotReturnedMs,2999);
  for (const change of [{version:2}, {observedMs:2999}, {enteredMs:-1}, {enteredMs:301}, {snapshotStartedMs:3001},
    {snapshotReturnedMs:299}, {snapshotReturnedMs:3001}, {drawMs:65001}, {queueMs:1.5}, {target:"private"}]) {
    const result = parse({...timeline,...change});
    assert.equal(result?.["sdk-visible-failure-phase"], "draw-snapshot");
    assert.equal(result?.["sdk-visible-failure-timing"], undefined);
  }
  const {enteredMs, snapshotStartedMs, ...queued} = timeline;
  assert.ok(parse(queued,{failurePhase:"ui-queue"})?.["sdk-visible-failure-timing"]);
  assert.equal(parse(timeline,{failurePhase:"ui-queue"})?.["sdk-visible-failure-timing"],undefined);
  assert.equal(parse(timeline,{failurePhase:"draw-prepare"})?.["sdk-visible-failure-timing"],undefined);
  assert.equal(parse(queued)?.["sdk-visible-failure-timing"],undefined);
  assert.equal(parse(timeline,{nonce:"stale"}),null);
  assert.equal(parse(timeline,{result:"ok"}),null);
});

test("late merged trees are adopted only after the provider request settles, without classic capture", async () => {
  let resolve!: (value: string) => void;
  const request = new Promise<string>(r => { resolve = r; });
  const events: string[] = [];
  const tree = { nonce: "current-request" };
  const settled = settleSdkMergedTree(request, async () => { events.push("read"); return tree; }, async value => {
    assert.equal(value, tree); events.push("adopt");
  }, () => { events.push("classic"); });
  await Promise.resolve(); assert.deepEqual(events, []);
  resolve("reply");
  assert.equal(await settled, "reply"); assert.deepEqual(events, ["read", "adopt"]);
});

test("missing merged trees start legacy capture only after provider completion", async () => {
  const events: string[] = [];
  const outcome = { error: new Error("capture timed out") };
  const result = await settleSdkMergedTree(Promise.resolve().then(() => { events.push("provider-ended"); return outcome; }),
    async () => { events.push("read"); return undefined; }, async () => { assert.fail("no tree"); }, () => { events.push("classic"); });
  assert.equal(result, outcome); assert.deepEqual(events, ["provider-ended", "read", "classic"]);
});

test("merged UI failure is checked before missing-file fallback queues another tree", async () => {
  const events: string[] = [];
  const failure = new Error("会话调用超时：capture-visible");
  await assert.rejects(settleSdkMergedTree(Promise.resolve({ error: failure }),
    async () => { events.push("read"); return undefined; }, async () => { events.push("adopt"); },
    () => { events.push("classic"); }, outcome => { if (outcome.error) throw outcome.error; }), e => e === failure);
  assert.deepEqual(events, []);
});

test("merged SDK reply guard rejects known UI failures before any classic tree or file read", async () => {
  const nonce = "1234567890abcdef", instance = "a-current-process";
  for (const fields of ["tree=failed, treeFailure=ui-timeout", "tree=failed, treeFailure=ui-unavailable",
    "tree=failed, treeFailure=interrupted", "error=java.lang.IllegalStateException: View capture timed out",
    "error=View selection timed out", "error=java.lang.InterruptedException"]) {
    let fileReads = 0, classic = 0;
    const outcome = { reply: { code: 0, stdout: Buffer.from(`Bundle[{${fields}, nonce=${nonce}, processInstance=${instance}}]`) }, error: null };
    await assert.rejects(settleSdkMergedTree(Promise.resolve(outcome), async () => { fileReads++; return undefined; },
      async () => assert.fail("no adoption"), () => { classic++; }, r => checkSdkMergedTreeOutcome(r, nonce, instance)),
      e => isSdkVisibleCaptureInterruption(e));
    assert.equal(fileReads, 0); assert.equal(classic, 0);
  }
  const timeout = new Error("会话调用超时：capture-visible");
  assert.throws(() => checkSdkMergedTreeOutcome({ reply: null, error: timeout }, nonce), e => e === timeout);
  const aborted = new DOMException("user canceled", "AbortError");
  assert.throws(() => checkSdkMergedTreeOutcome({ reply: null, error: aborted }, nonce), e => e === aborted);
});

test("old SDK without merged support retains classic compatibility; malformed failure never authorizes work", async () => {
  const nonce = "1234567890abcdef", instance = "current";
  for (const fields of ["result=ok", "tree=failed", "error=Unauthorized or unsupported request"]) {
    let classic = 0;
    const outcome = { reply: { code: 0, stdout: Buffer.from(`Bundle[{${fields}}]`) }, error: null };
    await settleSdkMergedTree(Promise.resolve(outcome), async () => undefined, async () => assert.fail("no adoption"),
      () => { classic++; }, r => checkSdkMergedTreeOutcome(r, nonce, instance));
    assert.equal(classic, 1);
  }
  for (const [fields, code] of [["tree=failed, treeFailure=unknown", 0], ["tree=ok, treeFailure=ui-timeout", 0],
    ["tree=failed, treeFailure=ui-timeout, nonce=wrong", 0], ["tree=failed, treeFailure=ui-timeout, processInstance=wrong", 0],
    ["tree=failed, treeFailure=ui-timeout", 1]] as const) {
    const out = `Bundle[{nonce=${nonce}, processInstance=${instance}, ${fields}}]`;
    // For identity cases, replace the original field rather than insert an ambiguous duplicate.
    const text = fields.includes("nonce=wrong") ? out.replace(`nonce=${nonce}, `, "")
      : fields.includes("processInstance=wrong") ? out.replace(`processInstance=${instance}, `, "") : out;
    assert.throws(() => checkSdkMergedTreeOutcome({ reply: { code, stdout: Buffer.from(text) }, error: null }, nonce, instance), /失败响应无效/);
  }
});

test("merged tree adoption rejects invalid identity; aborted file reads do not start legacy capture", async () => {
  let classic = 0;
  await assert.rejects(settleSdkMergedTree(Promise.resolve("reply"), async () => ({ nonce: "wrong" }),
    async () => { throw new Error("SDK 进程或根控件已变化"); }, () => { classic++; }), /根控件已变化/);
  await assert.rejects(settleSdkMergedTree(Promise.resolve("reply"), async () => { throw new DOMException("Canceled", "AbortError"); },
    async () => { assert.fail("no tree"); }, () => { classic++; }), { name: "AbortError" });
  assert.equal(classic, 0);
});

test("SDK UI interruption stops bulk fallback without disabling unsupported-SDK compatibility", () => {
  for (const reason of ["java.lang.IllegalStateException: View capture timed out", "View selection timed out",
    "View capture could not reach UI thread", "Visible capture time budget exceeded", "java.lang.InterruptedException"]) {
    assert.equal(isSdkVisibleCaptureInterruption(new Error(`SDK 可见层抓取失败：${reason}；{\"rootMatches\":false}`)), true);
  }
  assert.equal(isSdkVisibleCaptureInterruption(new Error("会话调用超时：capture-visible")), true);
  for (const message of ["会话调用超时：capture", "会话通道已关闭", "SDK 可见层抓取失败：响应无效",
    "SDK 可见层抓取失败：Unauthorized or unsupported request", "SDK 可见层文件校验失败",
    "SDK 可见层中 180 个移动、27 个尺寸或状态变化，需要重新读取控件树", "View capture timed out"]) {
    assert.equal(isSdkVisibleCaptureInterruption(new Error(message)), false, message);
  }
  assert.equal(isSdkVisibleCaptureInterruption("SDK 可见层抓取失败：View capture timed out"), false);
});

test("interrupted SDK capture keeps own pixels and marks unresolved Views without erasing proven empty/style/hidden states", () => {
  const root = makeNode("root"), image = makeNode("image"), missing = makeNode("missing"), empty = makeNode("empty"), style = makeNode("style"), hidden = makeNode("hidden");
  root.children = [image, missing, empty, style, hidden];
  for (const n of root.children) { n.visibleToUser = true; n.attributes = { "view-ref": `example.View@${n.id}` }; }
  image.layerImageDataUrl = "data:image/png;base64,AA=="; image.layerImageStatus = "captured";
  missing.layerImageStatus = "ambiguous"; missing.bounds = { left: 10, top: 20, right: 30, bottom: 40, raw: "[10,20][30,40]" };
  empty.layerImageEmpty = true; empty.layerImageStatus = "unavailable";
  style.layerImageStatus = "style"; hidden.visibleToUser = false; hidden.layerImageStatus = "hidden";
  markInterruptedSdkImages(root, new Error("SDK 可见层抓取失败：View capture timed out"));
  assert.equal(image.layerImageDataUrl,"data:image/png;base64,AA=="); assert.equal(image.layerImageStatus,"captured");
  assert.equal(missing.layerImageStatus,"failed"); assert.match(missing.attributes!["image-capture-error"],/尚无独立画面证据/);
  assert.deepEqual(missing.bounds,{ left: 10, top: 20, right: 30, bottom: 40, raw: "[10,20][30,40]" });
  assert.equal(empty.layerImageStatus,"unavailable"); assert.equal(style.layerImageStatus,"style"); assert.equal(hidden.layerImageStatus,"hidden");
  assert.ok(root.attributes!["sdk-visible-interrupted"]); assert.equal(root.layerImageStatus,undefined);
});

test("SDK phase timings accept legacy absence and reject partial or invalid telemetry", () => {
  assert.deepEqual(parseSdkCapturePhases(() => undefined), {});
  const fields: Record<string, string> = { uiQueueMs: "12", geometryMs: "3", drawMs: "50", verifyMs: "4" };
  assert.deepEqual(parseSdkCapturePhases(key => fields[key]), { "SDK 主线程排队": 12, "SDK 几何读取": 3, "SDK 独立图绘制": 50, "SDK 绘制后校验": 4 });
  for (const value of [undefined, "NaN", "-1", "1.5", "65001"]) assert.throws(() => parseSdkCapturePhases(key => key === "drawMs" ? value : fields[key]));
  assert.equal(parseSdkCapturePhases(key => key === "geometryWriteMs" ? "7" : fields[key])["SDK 几何文件构建"], 7);
  assert.throws(() => parseSdkCapturePhases(key => key === "geometryWriteMs" ? "7" : undefined));
  assert.throws(() => parseSdkCapturePhases(key => key === "geometryWriteMs" ? "-1" : fields[key]));
  assert.equal(parseSdkCapturePhases(key => key === "geometryWriteMs" ? "130000" : fields[key])["SDK 几何文件构建"], 130000);
  assert.throws(() => parseSdkCapturePhases(key => key === "geometryWriteMs" ? "130001" : fields[key]));
  for (const [key, label] of [["snapshotPrepareMs", "SDK 截图接口准备"], ["snapshotInvokeMs", "SDK 截图调用"], ["uiTaskMaxMs", "SDK 最长主线程任务"], ["snapshotInvokeMaxMs", "SDK 最长截图调用"]]) {
    assert.equal(parseSdkCapturePhases(name => name === key ? "7" : fields[name])[label], 7);
    for (const value of ["NaN", "-1", "1.5", "65001"]) assert.throws(() => parseSdkCapturePhases(name => name === key ? value : fields[name]));
    assert.throws(() => parseSdkCapturePhases(name => name === key ? "7" : undefined));
  }
});

test("SDK optional thread CPU counters preserve legacy absence and bound worker accumulation", () => {
  const base: Record<string, string> = { uiQueueMs: "12", geometryMs: "3", drawMs: "50", verifyMs: "4" };
  for (const [key, label, limit] of [
    ["geometryCpuMs", "SDK 几何读取 CPU", 65_000], ["drawCpuMs", "SDK 独立图绘制 CPU", 65_000],
    ["verifyCpuMs", "SDK 绘制后校验 CPU", 65_000], ["encodeCpuMs", "SDK 编码 CPU", 130_000],
    ["geometryWriteCpuMs", "SDK 几何文件构建 CPU", 130_000],
  ] as const) {
    assert.equal(parseSdkCapturePhases(name => name === key ? "7" : base[name])[label], 7);
    assert.equal(parseSdkCapturePhases(name => name === key ? String(limit) : base[name])[label], limit);
    assert.equal(parseSdkCapturePhases(name => base[name])[label], undefined);
    for (const value of ["NaN", "-1", "1.5", String(limit + 1)]) assert.throws(() => parseSdkCapturePhases(name => name === key ? value : base[name]));
    assert.throws(() => parseSdkCapturePhases(name => name === key ? "7" : undefined));
  }
});

test("SDK geometry serialization counters are optional and bounded", () => {
  const base: Record<string, string> = { uiQueueMs: "12", geometryMs: "3", drawMs: "50", verifyMs: "4" };
  for (const [key, label] of Object.entries({ geometryJsonMs: "SDK 几何 JSON 序列化", geometryUtf8Ms: "SDK 几何 UTF-8 转换", geometryDiskMs: "SDK 几何文件写入", geometryJsonCpuMs: "SDK 几何 JSON 序列化 CPU", geometryUtf8CpuMs: "SDK 几何 UTF-8 转换 CPU", geometryDiskCpuMs: "SDK 几何文件写入 CPU" })) {
    const limit = key.startsWith("geometryDisk") ? 65_000 : 130_000;
    assert.equal(parseSdkCapturePhases(name => name === key ? "7" : base[name])[label], 7);
    assert.equal(parseSdkCapturePhases(name => name === key ? String(limit) : base[name])[label], limit);
    assert.equal(parseSdkCapturePhases(name => base[name])[label], undefined);
    for (const value of ["NaN", "-1", "1.5", String(limit + 1)]) assert.throws(() => parseSdkCapturePhases(name => name === key ? value : base[name]));
    assert.throws(() => parseSdkCapturePhases(name => name === key ? "7" : undefined));
  }
});

test("full geometry sidecar binds every batch to nonce, process, root and exact image geometry", () => {
  const rootRef = "android.view.View@ff", nonce = "0123456789abcdef", instance = "sample-process";
  const layers = Array.from({ length: 12 }, (_, i) => ({ name: `android.view.View@${(i + 1).toString(16)}`, visible: true, x: 10, y: 20, width: 30, height: 40, imageDataUrl: "data:image/png;base64,AA==" }));
  const row = (ref: string, parent: string) => [ref, parent, 10, 20, 30, 40, 0, 0, 1, 0, [1, 0, 0, 0, 1, 0, 0, 0, 1], false, false, false];
  const records = layers.map(layer => ({ ref: layer.name, rootRef, started: 10, ended: 20, rootReached: true, chain: [row(layer.name, rootRef), row(rootRef, "")] }));
  const envelope = { version: 1, nonce, processInstance: instance, rootRef, records };
  const parse = (value: unknown) => parseCaptureGeometryFile(Buffer.from(JSON.stringify(value)), nonce, instance, rootRef, layers);
  assert.equal(parse(envelope).size, 12);
  const diagnostic = { ...records[0], diagnosticOnly: true };
  assert.equal(parse({ ...envelope, records: [diagnostic] }).get(diagnostic.ref)?.diagnosticOnly, true);
  assert.throws(() => parse({ ...envelope, records: [{ ...diagnostic, diagnosticOnly: "yes" }] }));
  assert.throws(() => parse({ ...envelope, records: [{ ...diagnostic, bitmapSpace: "view-local" }] }));
  assert.equal(parse({ ...envelope, records: [] }).size, 0);
  for (const changed of [{ nonce: "stale" }, { processInstance: "stale" }, { rootRef: "stale" }, { version: 2 }]) assert.throws(() => parse({ ...envelope, ...changed }));
  assert.throws(() => parse({ ...envelope, records: [...records.slice(0, 11), records[0]] }));
  assert.throws(() => parse({ ...envelope, records: [{ ...records[0], chain: [row(layers[0].name, rootRef).map((v, i) => i === 2 ? 11 : v), row(rootRef, "")] }] }));
  assert.throws(() => parse({ ...envelope, records: [{ ...records[0], ref: "android.view.View@eee" }] }));
});
import { annotateFallbackGeometry, applyFallbackLayerImage, canonicalizeSdkWindowRoot, layerCaptureFailureWarning, parseCaptureGeometryEvidence, retryFallbackGeometry } from "../electron/capture/layer-images";
import { isStaleCaptureTreeError } from "../electron/sdk/capture-protocol";

test("same-task parent evidence is bounded, linked, rooted and optional for old SDKs", () => {
  const row = (ref: string, parent: string) => [ref, parent, 10, 20, 10, 20, 0, 0, 1, 0, [1, 0, 0, 0, 1, 0, 0, 0, 1], false, false, false];
  const evidence = { ref: "android.view.View@abc", rootRef: "android.view.View@def", started: 100, ended: 120, rootReached: true,
    chain: [row("android.view.View@abc", "android.view.View@def"), row("android.view.View@def", "")] };
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
  assert.equal(parseCaptureGeometryEvidence(undefined, [evidence.ref], evidence.rootRef).size, 0);
  assert.deepEqual(parseCaptureGeometryEvidence(encode([evidence]), [evidence.ref], evidence.rootRef).get(evidence.ref), evidence);
  const transformed = { ...evidence, bitmapSpace: "view-local", localToScreen: [0.9, 0, 10.25, 0, 0.9, 20.5, 0, 0, 1] };
  assert.deepEqual(parseCaptureGeometryEvidence(encode([transformed]), [evidence.ref], evidence.rootRef).get(evidence.ref), transformed);
  const clipped = { ...transformed, clipContext: evidence.chain.map(row => ({ ref: row[0],
    clipBounds: [0, 0, 5, 5], padding: [1, 2, 3, 4], localToScreen: transformed.localToScreen })) };
  assert.deepEqual(parseCaptureGeometryEvidence(encode([clipped]), [evidence.ref], evidence.rootRef).get(evidence.ref), clipped);
  for (const clipContext of [[], [{ ...clipped.clipContext[0], ref: "wrong" }, clipped.clipContext[1]],
    [{ ...clipped.clipContext[0], padding: [-1, 0, 0, 0] }, clipped.clipContext[1]],
    [{ ...clipped.clipContext[0], clipBounds: [5, 0, 0, 5] }, clipped.clipContext[1]],
    [{ ...clipped.clipContext[0], localToScreen: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, clipped.clipContext[1]]])
    assert.throws(() => parseCaptureGeometryEvidence(encode([{ ...clipped, clipContext }]), [evidence.ref], evidence.rootRef), /证据无效/);
  for (const altered of [{ ...transformed, bitmapSpace: "screen" }, { ...transformed, localToScreen: [1] },
    { ...transformed, localToScreen: [1, 0, 99, 0, 1, 20, 0, 0, 1] }])
    assert.throws(() => parseCaptureGeometryEvidence(encode([altered]), [evidence.ref], evidence.rootRef), /证据无效/);
  for (const altered of [
    { ...evidence, rootRef: "android.view.View@fff" }, { ...evidence, ended: 99 }, { ...evidence, ended: 4000 },
    { ...evidence, rootReached: false }, { ...evidence, chain: [row(evidence.ref, ""), row(evidence.rootRef, "")] },
    { ...evidence, chain: Array.from({ length: 10 }, () => row(evidence.ref, evidence.rootRef)) },
    { ...evidence, chain: [[...row(evidence.ref, evidence.rootRef).slice(0, 10), [1], false, false, false]] },
  ]) assert.throws(() => parseCaptureGeometryEvidence(encode([altered]), [evidence.ref], evidence.rootRef), /证据无效/);
  assert.throws(() => parseCaptureGeometryEvidence(encode([evidence, evidence]), [evidence.ref, "android.view.View@fff"], evidence.rootRef), /证据无效/);
  assert.throws(() => parseCaptureGeometryEvidence(encode([evidence]), ["android.view.View@fff"], evidence.rootRef), /证据无效/);
  assert.throws(() => parseCaptureGeometryEvidence("bad!", [evidence.ref], evidence.rootRef), /证据无效/);
  const partial = { ...evidence, rootReached: false, chain: [row(evidence.ref, evidence.rootRef)] };
  assert.equal(parseCaptureGeometryEvidence(encode([partial]), [evidence.ref], evidence.rootRef).size, 1, "bounded partial chains must not pretend to reach the root");
});

test("fallback geometry diagnostics compare only sampled ancestors without moving tree bounds", () => {
  const parent = movingLayer("0"), child = movingLayer("0/0");
  parent.children = [child];
  const original = { ...child.bounds! };
  const image = { x: 13, y: 22, width: 10, height: 20, imageDataUrl: "data:image/png;base64,AA==", kind: "own" as const, empty: false };
  applyFallbackLayerImage(child, image);
  annotateFallbackGeometry(parent, new Map([[parent.attributes!["view-ref"], image], [child.attributes!["view-ref"], image]]));
  assert.equal(child.attributes!["image-capture-geometry-kind"], "position-mismatch");
  assert.equal(child.attributes!["image-capture-position-delta"], "3,2");
  assert.match(child.attributes!["image-capture-ancestor-evidence"], /3,2.*非同帧/);
  assert.deepEqual(child.bounds, original);
  annotateFallbackGeometry(parent, new Map([[child.attributes!["view-ref"], image]]), "retry");
  assert.match(child.attributes!["image-capture-ancestor-evidence"], /来源未知/);
  assert.equal(child.attributes!["image-capture-evidence-phase"], "retry");
  assert.equal(applyFallbackLayerImage(child, { ...image, x: 10, y: 20 }), true);
  for (const key of ["geometry-kind", "position-delta", "ancestor-evidence", "evidence-phase", "initial-geometry"]) {
    assert.equal(child.attributes![`image-capture-${key}`], undefined);
  }
});

test("same-draw parent context supersedes cross-batch hints but never authorizes a bounds update", () => {
  const parent = movingLayer("0"), child = movingLayer("0/0");
  parent.children = [child];
  const row = (ref: string, parentRef: string, x: number) => [ref, parentRef, x, 20, 10, 20, 0, 0, 1, 0, [1, 0, 0, 0, 1, 0, 0, 0, 1], false, false, false];
  const geometry = { ref: child.attributes!["view-ref"], rootRef: parent.attributes!["view-ref"], started: 100, ended: 120, rootReached: true,
    chain: [row(child.attributes!["view-ref"], parent.attributes!["view-ref"], 13), row(parent.attributes!["view-ref"], "", 13)] };
  const image = { x: 13, y: 20, width: 10, height: 20, imageDataUrl: "data:image/png;base64,AA==", kind: "own" as const, empty: false, geometry };
  applyFallbackLayerImage(child, image);
  annotateFallbackGeometry(parent, new Map([[child.attributes!["view-ref"], image]]));
  assert.match(child.attributes!["image-capture-ancestor-evidence"], /3,0.*同绘制任务父链/);
  assert.equal(child.bounds!.left, 10);
  assert.equal(JSON.parse(child.attributes!["image-capture-parent-context"]).chain.length, 2);
  const reparented = { ...image, geometry: { ...geometry, chain: [row(geometry.ref, "android.view.View@ffff", 13)] } };
  applyFallbackLayerImage(child, reparented);
  annotateFallbackGeometry(parent, new Map([[child.attributes!["view-ref"], reparented]]));
  assert.match(child.attributes!["image-capture-ancestor-evidence"], /直接父对象与树不一致/);
  assert.equal(child.bounds!.left, 10);
});

test("geometry retry retains original evidence on failure but clears it after recovery", async () => {
  for (const x of [13, 10]) {
    const node = movingLayer();
    const image = { x: 12, y: 20, width: 10, height: 20, imageDataUrl: "data:image/png;base64,AA==", kind: "own" as const, empty: false };
    applyFallbackLayerImage(node, image);
    annotateFallbackGeometry(node, new Map([[node.attributes!["view-ref"], image]]));
    const original = node.attributes!["image-capture-initial-geometry"];
    await retryFallbackGeometry([node], async refs => new Map([[refs[0], { ...image, x }]]), node);
    if (x === 13) {
      assert.equal(node.attributes!["image-capture-initial-geometry"], original);
      assert.equal(node.attributes!["image-capture-position-delta"], "3,0");
      assert.equal(node.attributes!["image-capture-evidence-phase"], "retry");
    } else assert.equal(node.attributes!["image-capture-initial-geometry"], undefined);
  }
});

test("fallback rejects nonfinite or partial positions and classifies size changes separately", () => {
  const node = movingLayer();
  const image = { x: 10, y: 20, width: 10, height: 20, imageDataUrl: "data:image/png;base64,AA==", kind: "own" as const, empty: false };
  for (const value of [NaN, Infinity, undefined]) {
    assert.equal(applyFallbackLayerImage(node, { ...image, x: value }), false);
    assert.equal(node.attributes!["image-capture-geometry-kind"], "invalid-image-position");
  }
  assert.equal(applyFallbackLayerImage(node, { ...image, width: 9 }), false);
  assert.equal(node.attributes!["image-capture-geometry-kind"], "size-mismatch");
  assert.equal(applyFallbackLayerImage(node, { ...image, x: undefined, y: undefined }), true, "legacy records with no position retain their existing compatibility");
});

function movingLayer(id = "0/0") {
  const node = makeNode(id);
  node.bounds = { left: 10, top: 20, right: 20, bottom: 40, raw: "[10,20][20,40]" };
  node.layerImageStatus = "failed";
  node.attributes = { "view-ref": `android.view.View@${id.replace(/\//g, "")}`, "image-capture-error": "采集期间控件位置变化，请重新采集" };
  return node;
}

test("small geometry retry recovers only checked images in one batch without changing bounds", async () => {
  const node = movingLayer(), original = { ...node.bounds! };
  let calls = 0;
  const result = await retryFallbackGeometry([node], async refs => {
    calls++;
    assert.deepEqual(refs, [node.attributes!["view-ref"]]);
    return new Map([[refs[0], { x: 10, y: 20, width: 10, height: 20, imageDataUrl: "data:image/png;base64,AA==", kind: "own", empty: false }]]);
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { requested: 1, recovered: 1 });
  assert.deepEqual(node.bounds, original);
  assert.equal(node.layerImageStatus, "captured");
  assert.equal(node.attributes!["image-capture-error"], undefined);
  await retryFallbackGeometry([node], async () => assert.fail("a valid image must not be retried"));
});

test("geometry retry rejects continued motion, changed size, and missing coordinates without looping", async () => {
  for (const geometry of [{ x: 12, y: 20, width: 10, height: 20 }, { x: 10, y: 20, width: 10, height: 19 }, { width: 10, height: 20 }]) {
    const node = movingLayer();
    let calls = 0;
    const result = await retryFallbackGeometry([node], async refs => {
      calls++;
      return new Map([[refs[0], { ...geometry, imageDataUrl: "data:image/png;base64,AA==", kind: "own", empty: false }]]);
    });
    assert.equal(calls, 1);
    assert.deepEqual(result, { requested: 1, recovered: 0 });
    assert.equal(node.layerImageStatus, "failed");
    assert.equal(node.layerImageDataUrl, undefined);
  }
});

test("geometry retry skips large batches, pixel-heavy layers, pure containers and unrelated failures", async () => {
  const tooMany = Array.from({ length: 9 }, (_, i) => movingLayer(`0/${i}`));
  const large = movingLayer(); large.bounds = { left: 0, top: 0, right: 2001, bottom: 2000, raw: "" };
  const unrelated = movingLayer(); unrelated.attributes!["image-capture-error"] = "缓冲层读取失败";
  const pure = movingLayer(); pure.layerImageStatus = "unavailable";
  for (const nodes of [tooMany, [large], [unrelated, pure]]) {
    assert.deepEqual(await retryFallbackGeometry(nodes, async () => assert.fail("retry exceeded its scope")), { requested: 0, recovered: 0 });
  }
});

test("geometry retry propagates cancellation and preserves the initial failure", async () => {
  const node = movingLayer();
  const error = new Error("cancelled");
  await assert.rejects(retryFallbackGeometry([node], async () => { throw error; }), error);
  assert.equal(node.attributes!["image-capture-error"], "采集期间控件位置变化，请重新采集");
  assert.equal(node.layerImageStatus, "failed");
});

test("fallback size mismatch records geometry, reports failure, and clears after a valid image", () => {
  const root = makeNode("0"), node = makeNode("0/0");
  root.children = [node];
  node.bounds = { left: 0, top: 0, right: 10, bottom: 20, raw: "[0,0][10,20]" };
  const image = { width: 9, height: 20, imageDataUrl: "data:image/png;base64,AA==", kind: "own" as const, empty: false };
  assert.equal(applyFallbackLayerImage(node, image), false);
  assert.equal(node.layerImageStatus, "failed");
  assert.equal(node.attributes!["image-capture-expected-size"], "10x20");
  assert.equal(node.attributes!["image-capture-actual-size"], "9x20");
  assert.equal(node.layerImageDataUrl, undefined);
  assert.match(layerCaptureFailureWarning(root)!, /^1 个控件/);
  assert.equal(applyFallbackLayerImage(node, { ...image, width: 10 }), true);
  assert.equal(node.layerImageStatus, "captured");
  assert.equal(node.attributes!["image-capture-error"], undefined);
  assert.equal(node.attributes!["image-capture-actual-size"], undefined);
  assert.equal(layerCaptureFailureWarning(root), null);
  assert.equal(applyFallbackLayerImage(node, image), false);
  assert.equal(node.layerImageStatus, "captured", "a rejected retry must not discard a valid existing own image");
  assert.deepEqual(node.layerImageSize, { width: 10, height: 20 });
});

test("verified rectangular own images carry placement without changing measured bounds, and replacements clear it", () => {
  const node = makeNode("placed");
  node.bounds = { left: 80, top: 20, right: 180, bottom: 60, raw: "[80,20][180,60]" };
  const matrix = [0.8,0,80,0,0.8,20,0,0,1], identity = [1,0,0,0,1,0,0,0,1];
  const geometry = { ref: "android.view.View@1", rootRef: "android.widget.FrameLayout@2", started: 100, ended: 110, rootReached: true,
    bitmapSpace: "view-local" as const, localToScreen: matrix,
    chain: [
      ["android.view.View@1", "android.widget.FrameLayout@2", 80,20,100,40,0,0,0.5,0,identity,false,false,false],
      ["android.widget.FrameLayout@2", "", 0,0,120,100,0,0,0.5,0,identity,true,true,false],
    ], clipContext: [
      { ref: "android.view.View@1", clipBounds: null, padding: [0,0,0,0], localToScreen: matrix },
      { ref: "android.widget.FrameLayout@2", clipBounds: null, padding: [0,0,10,0], localToScreen: identity },
    ] };
  const image = { width: 100, height: 40, x: 80, y: 20, imageDataUrl: "data:image/png;base64,AA==", kind: "own" as const, empty: false };
  const bounds = structuredClone(node.bounds);
  assert.equal(applyFallbackLayerImage(node, { ...image, geometry }), true);
  assert.deepEqual(node.bounds, bounds);
  assert.deepEqual(node.layerCapturePlacement?.screen, { left: 80, top: 20, width: 30, height: 32 });
  assert.equal(node.layerCapturePlacement?.opacity, 0.25);
  assert.equal(applyFallbackLayerImage(node, { ...image, x: 90, geometry }), false);
  assert.equal(node.layerCapturePlacement?.opacity, 0.25, "rejected new pixels retain the old image's placement");
  assert.equal(applyFallbackLayerImage(node, { ...image, geometry: { ...geometry, rootReached: false } }), true);
  assert.equal(node.layerCapturePlacement, undefined);
  assert.equal(node.attributes!["image-capture-placement"], "unsupported-context-legacy-fallback");
  assert.equal(applyFallbackLayerImage(node, image), true);
  assert.equal(node.attributes!["image-capture-placement"], undefined);
});

test("final layer warnings include local size failures and clear on successful recapture", () => {
  const root = makeNode("0"), node = makeNode("0/0");
  root.children = [node];
  assert.equal(layerCaptureFailureWarning(root), null);
  node.layerImageStatus = "failed";
  node.attributes = { "image-capture-error": "采集期间控件尺寸变化，请重新采集" };
  assert.match(layerCaptureFailureWarning(root)!, /^1 个控件/);
  const pure = makeNode("0/1");
  pure.layerImageStatus = "unavailable";
  root.children.push(pure);
  assert.match(layerCaptureFailureWarning(root)!, /^1 个控件/);
  node.layerImageStatus = "captured";
  assert.equal(layerCaptureFailureWarning(root), null);
});

test("SDK supplementary images keep their coordinates and reject moved or incomplete geometry", () => {
  const node = makeNode("0/0");
  node.bounds = { left: 75, top: 336, right: 1155, bottom: 1776, raw: "[75,336][1155,1776]" };
  const image = { x: -1058, y: 336, width: 1080, height: 1440, imageDataUrl: "data:image/png;base64,AA==", kind: "own" as const, empty: false };
  assert.equal(applyFallbackLayerImage(node, image), false);
  assert.equal(node.layerImageStatus, "failed");
  assert.match(node.attributes!["image-capture-error"], /位置变化/);
  assert.equal(node.attributes!["image-capture-expected-position"], "75,336");
  assert.equal(node.attributes!["image-capture-actual-position"], "-1058,336");
  assert.equal(applyFallbackLayerImage(node, { ...image, x: 77 }), false);
  assert.equal(applyFallbackLayerImage(node, { ...image, x: 75, y: undefined }), false);
  assert.equal(applyFallbackLayerImage(node, { ...image, x: 76 }), true, "same one-pixel tolerance as the visible SDK batch");
  assert.equal(node.attributes!["image-capture-error"], undefined);
  assert.equal(node.attributes!["image-capture-actual-position"], undefined);
});

test("stale starting windows require fresh trees, ordinary capture failures retain fallback", () => {
  assert.equal(isStaleCaptureTreeError(new Error("Debug 窗口与当前控件树不一致，请重新采集。")), true);
  assert.equal(isStaleCaptureTreeError(new Error("Debug 窗口身份已变化，请重新采集。")), true);
  assert.equal(isStaleCaptureTreeError(new Error("SDK 特殊画面控件与当前控件树不一致")), true);
  assert.equal(isStaleCaptureTreeError(new Error("SDK 纯布局控件与当前控件树不一致")), true);
  assert.equal(isStaleCaptureTreeError(new Error("SDK 可见层中 180 个移动、27 个尺寸或状态变化，需要重新读取控件树")), true);
  assert.equal(isStaleCaptureTreeError(new Error("SDK 可见层抓取失败：View selection timed out")), false);
  assert.equal(isStaleCaptureTreeError(new Error("Debug View 连接提前关闭")), false);
  assert.equal(isStaleCaptureTreeError("Debug 窗口身份已变化"), false);
});

const activityTarget = { packageName: "example.app", activityName: "example.app.MainActivity", component: "example.app/example.app.MainActivity" };
const activityHierarchy = `mAppBounds=Rect(0, 104 - 1080, 2355)
    View Hierarchy:
      DecorView@9c5dabe[MainActivity]
        android.widget.LinearLayout{65440cf V.E...... ........ 0,0-1080,2355}
          android.widget.TextView{abc V.ED..... ........ 10,20-110,60 #7f001 app:id/title}
    Looper (main)
`;

test("selected style requires the same View, process and geometry", () => {
  const bounds = { left: 10, top: 20, right: 110, bottom: 60, raw: "[10,20][110,60]" };
  const reply = "Result: Bundle[{result=ok, ref=example.TextView@a, rootRef=example.Decor@b, processInstance=11111111-1111-1111-1111-111111111111, x=10, y=20, width=100, height=40, backgroundType=android.graphics.drawable.ColorDrawable, backgroundColor=#FF123456, textColor=#FFFF0000, textSizePx=22.5, capturedAtMillis=1780000000000}]";
  const read = (value: string) => parseViewStyleReply(value, "example.TextView@a", "example.Decor@b", "11111111-1111-1111-1111-111111111111", bounds);
  assert.equal(read(reply).backgroundColor, "#FF123456");
  assert.equal(read(reply).textSizePx, 22.5);
  assert.equal(read(reply.replace("x=10", "x=18")).backgroundColor, "#FF123456", "SDK and screenshot origins may drift by up to 8px");
  assert.throws(() => read(reply.replace("y=20", "y=29")), /位置或尺寸/);
  assert.throws(() => read(reply.replace("width=100", "width=101")), /尺寸/);
  assert.throws(() => read(reply.replace("example.TextView@a", "example.TextView@c")), /身份/);
  assert.throws(() => read(reply.replace("textColor=#FFFF0000", "textColor=red")), /样式数据/);
  assert.throws(() => read("Result: Bundle[{error=Unauthorized or unsupported request}]"), /SDK/);
});

test("SDK pure layout hints are bounded and older SDKs keep the fallback", () => {
  assert.equal(parsePureViewRefs(undefined).size, 0);
  assert.equal(parsePureViewRefs("-").size, 0);
  assert.deepEqual([...parsePureViewRefs("android.widget.FrameLayout@a;example.Custom$View@b")],
    ["android.widget.FrameLayout@a", "example.Custom$View@b"]);
  assert.throws(() => parsePureViewRefs("example.View@a;example.View@a"), /身份无效/);
  assert.throws(() => parsePureViewRefs("example.View@a,evil"), /身份无效/);
  assert.throws(() => parsePureViewRefs("x".repeat(16_001)), /身份无效/);
});

test("branch refresh accepts changes inside the target but rejects a changed outside path", () => {
  const root = makeNode("0"), parent = makeNode("0/0"), target = makeNode("0/0/0"), sibling = makeNode("0/0/1");
  for (const node of [root, parent, target, sibling]) node.attributes = { "view-ref": `example.View@${node.id.replace(/\//g, "")}` };
  target.children = [makeNode("0/0/0/0")];
  target.children[0].attributes = { "view-ref": "example.View@old" };
  parent.children = [target, sibling]; root.children = [parent];
  const changed = structuredClone(root);
  changed.children[0].children[0].children = [makeNode("0/0/0/0"), makeNode("0/0/0/1")];
  changed.children[0].children[0].children[0].attributes = { "view-ref": "example.View@new" };
  changed.children[0].children[0].children[1].attributes = { "view-ref": "example.View@old" };
  changed.children[0].children[0].bounds = { ...target.bounds!, right: target.bounds!.right + 10, raw: "[0,0][370,48]" };
  assert.equal(nativeViewBranchContextMatches(root, changed, target.id), true);
  changed.children[0].children[1].attributes!["view-ref"] = "example.View@replaced";
  assert.equal(nativeViewBranchContextMatches(root, changed, target.id), false);
  changed.children[0].children[1].attributes!["view-ref"] = sibling.attributes!["view-ref"];
  changed.children[0].attributes!["view-ref"] = "example.View@parent-rebuilt";
  assert.equal(nativeViewBranchContextMatches(root, changed, target.id), false);
  changed.children[0].attributes!["view-ref"] = parent.attributes!["view-ref"];
  changed.children[0].children[1].bounds = { ...sibling.bounds!, left: sibling.bounds!.left + 1, raw: "[1,0][360,48]" };
  assert.equal(nativeViewBranchContextMatches(root, changed, target.id), true, "an unrelated sibling may move during a scoped refresh");
  changed.children[0].children[1].bounds = sibling.bounds;
  changed.children[0].children[1].visibleToUser = false;
  assert.equal(nativeViewBranchContextMatches(root, changed, target.id), false, "an outside visibility change needs a full refresh");
  changed.children[0].children[1].visibleToUser = sibling.visibleToUser;
  changed.children[0].bounds = { ...parent.bounds!, top: parent.bounds!.top + 1, raw: "[0,1][360,49]" };
  assert.equal(nativeViewBranchContextMatches(root, changed, target.id), false, "a moved ancestor invalidates the target placement");
});

test("capture deadline respects both timeout and caller cancellation", async () => {
  const timed = captureSignal(undefined, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(timed.aborted, true);
  const caller = new AbortController();
  const combined = captureSignal(caller.signal, 1_000);
  caller.abort();
  assert.equal(combined.aborted, true);
});

test("startup waits for a non-empty Activity hierarchy", () => {
  assert.equal(hasActivityHierarchy("", activityTarget), false);
  assert.equal(hasActivityHierarchy("ACTIVITY example.app/.MainActivity\n", activityTarget), false);
  assert.equal(hasActivityHierarchy("View Hierarchy:\n    Looper (main)", activityTarget), false);
  assert.equal(hasActivityHierarchy("View Hierarchy:\n    null\n    Looper (main)", activityTarget), false);
  assert.equal(hasActivityHierarchy(activityHierarchy, activityTarget), true);
  assert.equal(hasActivityHierarchy("org.qtproject.qt.android.QtActivity", activityTarget), true);
});

type EncodedProperties = { [key: string]: string | number | boolean | EncodedProperties };
function encodedHierarchy(root: EncodedProperties, complete = true) {
  const names = new Map<string, number>();
  const short = (value: number) => { const b = Buffer.alloc(3); b[0] = 83; b.writeUInt16BE(value, 1); return b; };
  const key = (name: string) => { if (!names.has(name)) names.set(name, names.size + 1); return short(names.get(name)!); };
  const value = (item: EncodedProperties[string]): Buffer => {
    if (typeof item === "boolean") return Buffer.from([90, Number(item)]);
    if (typeof item === "number") { const b = Buffer.alloc(5); b[0] = Number.isInteger(item) ? 73 : 70; if (b[0] === 73) b.writeInt32BE(item, 1); else b.writeFloatBE(item, 1); return b; }
    if (typeof item === "string") { const bytes = Buffer.from(item), header = Buffer.alloc(3); header[0] = 82; header.writeUInt16BE(bytes.length, 1); return Buffer.concat([header, bytes]); }
    return Buffer.concat([Buffer.from("M"), ...Object.entries(item).flatMap(([name, data]) => [key(name), value(data)]), short(0)]);
  };
  const body = Buffer.concat([key("window:left"), value(7), key("window:top"), value(104), value(root)]);
  const marker = [Buffer.from("M"), key("__name__"), value("propertyIndex")];
  return complete ? Buffer.concat([body, ...marker, ...[...names].flatMap(([name, id]) => [short(id), value(name)]), short(0)]) : body;
}
function encodedView(hash: number, extra: EncodedProperties = {}): EncodedProperties {
  return { "meta:__name__": "android.view.View", "meta:__hash__": hash, "layout:left": 0, "layout:top": 0, "layout:width": 100, "layout:height": 40, "misc:visibility": 0, ...extra };
}

test("V2 decoding preserves identity, text, scroll, transforms and rejects incomplete hierarchies", () => {
  const root = debugViewTree(activityHierarchy, activityTarget);
  const child = encodedView(-1, { "layout:left": 10, "layout:top": 20, "drawing:translationX": 3, "text:text": "背景 = 😀", "id": "id/title", "drawing:alpha": 0.5, "padding:paddingLeft": 2, "drawing:hardwareAccelerated": false });
  const properties = encodedView(0x9c5dabe, { "meta:__name__": "com.android.internal.policy.DecorView", "drawing:scaleX": 2, "drawing:scaleY": 2, "drawing:pivotX": 0, "drawing:pivotY": 0, "scrolling:scrollX": 4, "scrolling:scrollY": 5, "meta:__childCount__": 1, "meta:__child__0": child });
  const bytes = encodedHierarchy(properties);
  applyViewProperties(root, decodeViewHierarchy(bytes), true);
  const node = root.children[0].children[0];
  assert.equal(node.attributes?.["view-ref"], "android.view.View@ffffffff");
  assert.equal(node.bounds?.raw, "[25,134][125,174]");
  assert.equal(node.text, "背景 = 😀");
  assert.equal(node.attributes?.["effective-alpha"], "0.5");
  assert.equal(node.attributes?.["padding-left"], "2");
  assert.equal(node.attributes?.["hardware-accelerated"], "false", "native software evidence survives V2 decoding without an SDK");
  assert.equal(node.attributes?.["skip-draw"], undefined, "willNotDraw must not be mistaken for PFLAG_SKIP_DRAW");
  const current = structuredClone(root);
  assert.equal(nativeViewNodeMatches(root, current, node.id), true);
  const nested = makeNode(`${node.id}/0`);
  nested.attributes = { "view-ref": "android.view.View@nested" };
  node.children.push(nested);
  current.children[0].children[0].children.push(structuredClone(nested));
  assert.equal(nativeViewBranchMatches(root, current, node.id), true);
  current.children[0].children[0].children[0].attributes!["view-ref"] = "android.view.View@replaced";
  assert.equal(nativeViewBranchMatches(root, current, node.id), false, "a replaced descendant must invalidate a branch refresh");
  current.children[0].children[0].children[0].attributes!["view-ref"] = "android.view.View@nested";
  current.children[0].children[0].bounds!.left++;
  assert.equal(nativeViewNodeMatches(root, current, node.id), true, "the same View may move between initial capture and refresh");
  current.children[0].children[0].bounds!.left--;
  current.children[0].children[0].attributes!["view-ref"] = "android.view.View@other";
  assert.equal(nativeViewNodeMatches(root, current, node.id), false, "replaced views cannot receive a stale bitmap");
  assert.equal(nativeViewNodeMatches(root, structuredClone(root), "0/99"), false);
  for (const data of [bytes.subarray(0, 12), bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from([0])]), encodedHierarchy(properties, false), encodedHierarchy({ ...properties, "meta:__childCount__": 2 }), encodedHierarchy({ ...properties, "meta:__child__0": properties }), encodedHierarchy({ ...properties, "layout:width": NaN })]) assert.throws(() => decodeViewHierarchy(data), /Debug V2/);
  const rotated = decodeViewHierarchy(encodedHierarchy(encodedView(1, { "drawing:rotation": 90, "drawing:pivotX": 0, "drawing:pivotY": 0, "meta:__childCount__": 1, "meta:__child__0": child })));
  assert.match(rotated, /layout:getLocationOnScreen_x\(\)=3,-13 layout:getLocationOnScreen_y\(\)=3,117/);
  const perspective = decodeViewHierarchy(encodedHierarchy(encodedView(1, { "drawing:rotationY": 30, "meta:__childCount__": 1, "meta:__child__0": child })));
  assert.equal(perspective.includes("getLocationOnScreen"), false, "do not guess unavailable camera/perspective geometry");
});

test("Activity hierarchy retains shorthand DecorView and fills its measured geometry from DDMS", () => {
  const root = debugViewTree(activityHierarchy, activityTarget);
  const decor = root.children[0];
  assert.equal(root.children.length, 1);
  assert.equal(decor.className, "DecorView");
  assert.equal(decor.attributes?.["view-ref"], "DecorView@9c5dabe");
  assert.equal(decor.bounds, null);
  assert.equal(decor.visibleToUser, true);
  assert.equal(decor.children[0].className, "android.widget.LinearLayout");
  assert.equal(decor.children[0].children[0].bounds?.raw, "[10,20][110,60]");
  const ref = "com.android.internal.policy.DecorView@9c5dabe";
  applyViewProperties(root, `${ref} layout:getLocationOnScreen_x()=1,0 layout:getLocationOnScreen_y()=1,0 layout:getWidth()=4,1080 layout:getHeight()=4,2355 \n`);
  assert.equal(decor.className, "com.android.internal.policy.DecorView");
  assert.equal(decor.attributes?.["view-ref"], ref);
  assert.deepEqual(decor.bounds, { left: 0, top: 0, right: 1080, bottom: 2355, raw: "[0,0][1080,2355]" });
  assert.equal(attachViewLayerImages(root, [{ name: "DecorView", x: 0, y: 0, width: 1080, height: 2355, visible: true, imageDataUrl: "data:image/png;base64,AA==" }]), 1);
  assert.equal(decor.layerImageStatus, "captured");

  const ordinary = debugViewTree(activityHierarchy.replace("DecorView@9c5dabe[MainActivity]", "com.android.internal.policy.DecorView{9c5dabe V.E...... ........ 0,0-1080,2355}"), activityTarget);
  assert.equal(ordinary.children[0].attributes?.["view-ref"], ref);
  assert.equal(ordinary.children[0].children[0].className, "android.widget.LinearLayout");
});

test("captured framework views skip duplicate JDWP lookup, custom and surface views do not", () => {
  const node = makeNode("view");
  node.layerImageStatus = "captured";
  for (const className of ["android.view.View", "android.widget.TextView", "android.widget.FrameLayout"]) {
    node.className = className;
    assert.equal(needsViewBitmapFallback(node), false);
  }
  for (const className of ["android.view.SurfaceView", "android.view.TextureView", "com.example.CustomSurface", "android.widget.VideoView"]) {
    node.className = className;
    assert.equal(needsViewBitmapFallback(node), true);
  }
  node.className = "android.widget.TextView";
  node.layerImageStatus = "unavailable";
  assert.equal(needsViewBitmapFallback(node), true);
  node.className = "com.example.CustomView";
  node.layerImageStatus = "captured";
  assert.equal(needsViewBitmapFallback(node), true);
  assert.equal(needsViewBitmapFallback(node, true), false, "a verified SDK own image needs no second JDWP capture");
  node.layerImageStatus = "unavailable";
  assert.equal(needsViewBitmapFallback(node, true), true, "a missing SDK bitmap still needs targeted fallback");
  node.layerImageStatus = "captured";
  node.attributes = { "skip-draw": "true" };
  assert.equal(needsViewBitmapFallback(node, true), true);
  node.layerImageStatus = "unavailable";
  assert.equal(needsViewBitmapFallback(node, true, true), false, "SDK-confirmed pure layouts need no JDWP lookup");
});

test("adopted SDK inheritance skips only captured ordinary type-only candidates", () => {
  const node = makeNode("custom");
  node.className = "com.example.CustomText";
  node.layerImageStatus = "captured";
  const attrs = { "tree-source": "debug-sdk", "sdk-process-instance": "current-instance",
    "view-ref": "com.example.CustomText@abc", "sdk-class-hierarchy": "com.example.CustomText → android.widget.TextView → android.view.View" };
  node.attributes = { ...attrs };
  assert.equal(needsViewBitmapFallback(node), false);
  for (const status of ["unavailable", "ambiguous", "failed"] as const) {
    node.layerImageStatus = status;
    assert.equal(needsViewBitmapFallback(node), true, `missing ${status} image still captured`);
  }
  node.layerImageStatus = "captured";
  const invalidAttributes: Record<string, string>[] = [
    { "skip-draw": "true" }, { "tree-source": "debug-view" }, { "sdk-process-instance": "" },
    { "view-ref": "com.example.Other@abc" }, { "view-ref": "com.example.CustomText@invalid" },
    { "sdk-class-hierarchy": "com.example.CustomText → android.widget.TextView" },
    { "sdk-class-hierarchy": "com.example.Other → android.view.View" },
    { "sdk-class-hierarchy": "com.example.CustomText → android.view.SurfaceView → android.view.View" },
    { "sdk-class-hierarchy": "com.example.CustomText → android.view.TextureView → android.view.View" },
    { "sdk-class-hierarchy": "com.example.CustomText → android.widget.VideoView → android.view.SurfaceView → android.view.View" },
    { "sdk-class-hierarchy": "com.example.CustomText → android.view.View → android.view.View" },
    { "sdk-class-hierarchy": "com.example.CustomText → invalid/class → android.view.View" },
  ];
  for (const changes of invalidAttributes) {
    node.attributes = { ...attrs, ...changes };
    assert.equal(needsViewBitmapFallback(node), true, JSON.stringify(changes));
  }
  node.attributes = {};
  assert.equal(needsViewBitmapFallback(node), true, "old SDK has no class proof");
});

test("checked SDK types arrive before fallback without replacing tree, flags or pixels", () => {
  const root = makeNode("root"), node = makeNode("custom"), unrelated = makeNode("other");
  root.children = [node, unrelated];
  node.className = unrelated.className = "com.example.CustomText";
  node.attributes = { "view-ref": "com.example.CustomText@abc", "tree-source": "debug-view", "skip-draw": "false" };
  unrelated.attributes = { "view-ref": "com.example.CustomText@def" };
  node.layerImageStatus = "captured";
  node.layerImageDataUrl = "original-image";
  const verified = makeNode("sdk-root"), donor = makeNode("sdk-child");
  donor.className = node.className;
  donor.attributes = { "view-ref": node.attributes["view-ref"], "tree-source": "debug-sdk", "sdk-process-instance": "current",
    "sdk-class-hierarchy": "com.example.CustomText → android.widget.TextView → android.view.View", "skip-draw": "true" };
  donor.layerImageDataUrl = "different-image";
  verified.children = [donor];
  applyVerifiedSdkViewTypes(root, verified);
  assert.equal(root.children[0], node);
  assert.equal(node.attributes["tree-source"], "debug-view");
  assert.equal(node.attributes["skip-draw"], "false");
  assert.equal(node.layerImageDataUrl, "original-image");
  assert.equal(node.layerImageStatus, "captured");
  assert.equal(needsViewBitmapFallback(node), false);
  assert.equal(unrelated.attributes["sdk-class-hierarchy"], undefined);
  const wrongClass = makeNode("wrong");
  wrongClass.className = "com.example.Other";
  wrongClass.attributes = { "view-ref": donor.attributes["view-ref"] };
  const wrongRoot = makeNode("wrong-root"); wrongRoot.children = [wrongClass];
  applyVerifiedSdkViewTypes(wrongRoot, verified);
  assert.equal(wrongClass.attributes["sdk-class-hierarchy"], undefined);
  donor.attributes["sdk-class-hierarchy"] = "com.example.CustomText → android.view.SurfaceView → android.view.View";
  applyVerifiedSdkViewTypes(root, verified);
  assert.equal(needsViewBitmapFallback(node), true, "video ancestry must keep live fallback");
});

test("SDK visible images keep only stable View identities and bound stale images", () => {
  const root = makeNode("0"), node = makeNode("0/0");
  node.attributes = { "view-ref": "example.CustomView@1" };
  node.bounds = { left: 2, top: 3, right: 12, bottom: 13, raw: "[2,3][12,13]" };
  root.children = [node];
  const layer = { name: "example.CustomView@1", x: 2, y: 3, width: 10, height: 10, visible: true, imageDataUrl: "data:image/png;base64,AA==" };
  assert.deepEqual(matchSdkVisibleLayers(root, [layer]).matched, [layer]);
  assert.throws(() => matchSdkVisibleLayers(root, [{ ...layer, x: 4 }]), /重新读取控件树/);
  assert.throws(() => matchSdkVisibleLayers(root, [{ ...layer, width: 9 }]), /重新读取控件树/);
  assert.throws(() => matchSdkVisibleLayers(root, [{ ...layer, name: "example.CustomView@2" }]), /重新读取控件树/);
  assert.throws(() => matchSdkVisibleLayers(root, [layer, layer]), /对象重复/);
  assert.throws(() => matchSdkVisibleLayers(root, Array.from({ length: 9 }, (_, index) => ({ ...layer, name: `example.CustomView@${index + 2}` }))), /重新读取控件树/);
  root.children = Array.from({ length: 12 }, (_, index) => ({ ...node, id: `0/${index}`, attributes: { "view-ref": `example.CustomView@${index + 10}` } }));
  const changing = root.children.map((child, index) => ({ ...layer, name: child.attributes!["view-ref"], width: index < 9 ? 10 : 11 }));
  const partial = matchSdkVisibleLayers(root, changing);
  assert.equal(partial.matched.length, 9, "matching own images survive unrelated changes");
  assert.equal(partial.unmatched, 3, "changed images are left for per-View fallback");
});

test("only DecorView shorthand is accepted as an alias of a qualified root identity", () => {
  assert.equal(matchesViewRoot("DecorView@7dd128d", "com.android.internal.policy.DecorView@7dd128d"), true, "business SDK root aliases refer to the same instance");
  assert.equal(matchesViewRoot("DecorView@7dd128d", "com.android.internal.policy.DecorView@7dd128e"), false, "different instances still invalidate capture");
  assert.equal(matchesViewRoot("DecorView@abc", "com.android.internal.policy.DecorView@abc"), true);
  assert.equal(matchesViewRoot("DecorView@abc", "com.android.internal.policy.impl.PhoneWindow$DecorView@abc"), true);
  assert.equal(matchesViewRoot("DecorView@abc", "com.android.internal.policy.DecorView@def"), false);
  assert.equal(matchesViewRoot("DecorView@abc", "com.example.NotDecorView@abc"), false);
  assert.equal(matchesViewRoot("LinearLayout@abc", "android.widget.LinearLayout@abc"), false);
  assert.equal(matchesViewRoot("one.DecorView@abc", "two.DecorView@abc"), false);
});

test("verified SDK root aliases retain root own images and reject different objects", () => {
  const root = makeNode("0"), window = makeNode("0/0");
  window.className = "DecorView";
  window.attributes = { "view-ref": "DecorView@7dd128d" };
  window.bounds = { left: 0, top: 0, right: 10, bottom: 10, raw: "[0,0][10,10]" };
  root.children = [window];
  assert.throws(() => canonicalizeSdkWindowRoot(root, "com.android.internal.policy.DecorView@7dd128e"), /根控件已变化/);
  assert.equal(window.attributes["view-ref"], "DecorView@7dd128d");
  const ref = "com.android.internal.policy.DecorView@7dd128d";
  canonicalizeSdkWindowRoot(root, ref);
  assert.equal(window.className, "com.android.internal.policy.DecorView");
  const layer = { name: ref, x: 0, y: 0, width: 10, height: 10, visible: true, imageDataUrl: "data:image/png;base64,AA==" };
  assert.deepEqual(matchSdkVisibleLayers(root, [layer]).matched, [layer]);
  assert.equal(matchSdkVisibleLayers(root, [layer]).refs.has(ref), true);
});

test("DDMS restores omitted custom parents and images, preserving identity and native properties", () => {
  const root = debugViewTree(activityHierarchy, activityTarget);
  const row = (ref: string, values: Record<string, string>) => `${ref} ${Object.entries(values).map(([key, value]) => `${key}=${value.length},${value}`).join(" ")} \n`;
  const geometry = { "layout:getLocationOnScreen_x()": "10", "layout:getLocationOnScreen_y()": "124", "layout:getWidth()": "100", "layout:getHeight()": "40" };
  const dump = row("com.android.internal.policy.DecorView@9c5dabe", { "getVisibility()": "VISIBLE" })
    + row(" example.CustomContainer@123", { ...geometry, mPrivateFlags: "0x1000080" })
    + row("  android.widget.TextView@abc", { ...geometry, "text:mText": "Text = 😀", "isClickable()": "true" })
    + row("  example.CustomImage@456", { ...geometry, mID: "id/avatar", "isEnabled()": "false" })
    + row(" example.CustomImage@789", { ...geometry, "getVisibility()": "GONE" }) + "DONE.\n";
  applyViewProperties(root, dump, true);
  const decor = root.children[0], container = decor.children[0];
  assert.equal(decor.children.length, 2);
  assert.equal(container.className, "example.CustomContainer");
  assert.equal(container.attributes?.["skip-draw"], "true");
  assert.equal(container.children[0].id, "0/0/0/0");
  assert.equal(container.children[0].text, "Text = 😀");
  assert.equal(container.children[0].resourceId, "app:id/title");
  assert.equal(container.children[0].clickable, true);
  const image = container.children[1];
  assert.equal(image.resourceId, "id/avatar");
  assert.equal(image.enabled, false);
  assert.equal(image.bounds?.raw, "[10,124][110,164]");
  assert.equal(decor.children[1].visibleToUser, false);
  assert.equal(attachViewLayerImages(root, [{ name: "id/avatar", visible: true, x: 10, y: 20, width: 100, height: 40, imageDataUrl: "own-image" }], { x: 0, y: 104 }), 1);
  assert.equal(image.layerImageDataUrl, "own-image");
  const children = root.children;
  for (const invalid of [dump.replace("example.CustomImage@789", "example.CustomImage@456"), dump.replace("id/avatar", "id/a"), dump.replace(" example.CustomImage@789", "unparsed"), dump.replace("example.CustomImage@789", "other.Window@1").replace(" other.Window@1", "other.Window@1")]) {
    assert.throws(() => applyViewProperties(root, invalid, true), /Debug/);
    assert.equal(root.children, children, "invalid data must not replace the existing hierarchy");
  }
});

test("fallback preserves own pixels, handles cold startup and bounds capture work", async () => {
  const int = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
  const string = (s: string) => Buffer.concat([int(Buffer.byteLength(s)), Buffer.from(s)]);
  const tagged = (tag: string, value: number) => Buffer.concat([Buffer.from(tag), int(value)]);
  const result = (tag: string, value = 0, exception = 0) => Buffer.concat([tag === "V" ? Buffer.from("V") : tagged(tag, value), tagged("L", exception)]);
  const methods = [
    [1, "hashCode", "()I"], [2, "findView", "(Landroid/view/View;Ljava/lang/String;)Landroid/view/View;"],
    [3, "getWidth", "()I"], [4, "getHeight", "()I"], [5, "getPixels", "([IIIIIII)V"],
    [6, "<init>", "()V"], [7, "createSnapshot", "(Landroid/view/ViewDebug$CanvasProvider;Z)Landroid/graphics/Bitmap;"],
    [8, "valueOf", "(Ljava/lang/String;)Landroid/graphics/Bitmap$Config;"], [9, "copy", "(Landroid/graphics/Bitmap$Config;Z)Landroid/graphics/Bitmap;"],
    [10, "recycle", "()V"], [11, "getBitmap", "()Landroid/graphics/Bitmap;"],
    [12, "next", "()Landroid/os/Message;"],
    [13, "getInstance", "()Landroid/view/WindowManagerGlobal;"], [14, "getRootView", "(Ljava/lang/String;)Landroid/view/View;"],
    [15, "forName", "(Ljava/lang/String;)Ljava/lang/Class;"],
  ] as const;
  const strings = new Map<number, string>(), classes = new Map<string, number>(), arrays = new Map<number, number>();
  const pins: number[] = [], released: number[] = [], recycled: number[] = [], drawn: number[] = [];
  let next = 1000, disposed = false, suspendCount = 0, resumes = 0, brokenPixels = false, emptyTexture = false, skipOwn = false, disconnect = false;
  let customDraw = false, overlayOwn = false, legacyWakes = 0;
  const methodQueries: number[] = [], classQueries: string[] = [];
  let rootChecks = 0, disposeCount = 0;
  let cancelTypeLookup: { controller: AbortController; reason: Error; closed: () => void } | undefined;
  let missingOverlay = false, badFields = "", badDrawMethodsOnce = false;
  const fieldReads: number[][] = [];
  const refs = ["example.Image@aaa", "example.Image@bbb", "example.Image@ccc", "android.view.TextureView@ddd"];
  const args = (data: Buffer, start: number, count: number) => {
    const values: number[] = [];
    for (let i = 0; i < count; i++) {
      const tag = data[start++];
      values.push(tag === 90 ? data[start] : data.readInt32BE(start)); start += tag === 90 ? 1 : 4;
    }
    return values;
  };
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0), handshaken = false;
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (!handshaken) {
        if (buffer.length < 14) return;
        socket.write(buffer.subarray(0, 14)); buffer = buffer.subarray(14); handshaken = true;
      }
      while (buffer.length >= 11 && buffer.length >= buffer.readUInt32BE()) {
        const packet = buffer.subarray(0, buffer.readUInt32BE()); buffer = buffer.subarray(packet.length);
        const body = packet.subarray(11), command = `${packet[9]}/${packet[10]}`;
        let payload = Buffer.alloc(0), event = false;
        switch (command) {
          case "1/7": payload = Buffer.concat(Array.from({ length: 5 }, () => int(4))); break;
          case "1/4": payload = Buffer.concat([int(1), int(3)]); break;
          case "11/1": payload = string("main"); break;
          case "11/2": suspendCount++; break;
          case "11/3": resumes++; break;
          case "15/1":
            assert.deepEqual([...body.subarray(0, 2)], [2, 1]);
            assert.equal(body.readInt32BE(2), 2);
            assert.equal(body[6], 3); assert.equal(body.readInt32BE(7), 3);
            assert.equal(body.readInt32BE(13), classes.get("Landroid/os/MessageQueue;"));
            assert.equal(body.readInt32BE(17), 12);
            assert.equal(body.readBigInt64BE(21), 0n);
            payload = int(7); event = true; break;
          case "15/2": break;
          case "199/1": legacyWakes++; assert.equal(body.subarray(0, 4).toString(), "VUOP"); assert.equal(body.readInt32BE(8), 2); break;
          case "1/2": {
            const name = body.subarray(4).toString();
            classQueries.push(name);
            assert.notEqual(name, "Landroid/view/ViewDebug$HardwareCanvasProvider;", "load the snapshot provider on cold startup");
            if (!classes.has(name)) classes.set(name, classes.size + 1);
            payload = name === "Ljava/lang/Class;"
              ? Buffer.concat([int(2), Buffer.from([1]), int(9999), int(7), Buffer.from([1]), int(classes.get(name)!), int(7)])
              : Buffer.concat([int(1), Buffer.from([1]), int(classes.get(name)!), int(7)]);
            break;
          }
          case "2/2":
            assert.ok([9999, classes.get("Ljava/lang/Class;")].includes(body.readInt32BE()));
            payload = int(body.readInt32BE() === 9999 ? 777 : 0); break;
          case "3/1":
            if (customDraw && body.readInt32BE() === classes.get("Lexample/Image;")) {
              if (!classes.has("Lexample/DecoratedLayout;")) classes.set("Lexample/DecoratedLayout;", classes.size + 1);
              payload = int(classes.get("Lexample/DecoratedLayout;")!); break;
            }
            if (!classes.has("Landroid/view/View;")) classes.set("Landroid/view/View;", classes.size + 1);
            payload = int(classes.get("Landroid/view/View;")!); break;
          case "2/1": payload = string([...classes].find(([, id]) => id === body.readInt32BE())![0]); break;
          case "9/1": {
            if (cancelTypeLookup) {
              const cancellation = cancelTypeLookup; cancelTypeLookup = undefined;
              socket.once("close", cancellation.closed);
              cancellation.controller.abort(cancellation.reason);
              return;
            }
            const name = body.readInt32BE() === 504 ? "Landroid/view/TextureView;" : "Lexample/Image;";
            if (!classes.has(name)) classes.set(name, classes.size + 1);
            payload = Buffer.concat([Buffer.from([1]), int(classes.get(name)!)]); break;
          }
          case "2/5": {
            methodQueries.push(body.readInt32BE());
            if (badDrawMethodsOnce && body.readInt32BE() === classes.get("Lexample/Image;")) {
              badDrawMethodsOnce = false; payload = int(-1); break;
            }
            const extra = customDraw && body.readInt32BE() === classes.get("Lexample/DecoratedLayout;")
              ? [int(16), string("dispatchDraw"), string("(Landroid/graphics/Canvas;)V"), int(0)] : [];
            payload = Buffer.concat([int(methods.length + Number(extra.length > 0)), ...methods.flatMap(([id, name, sig]) => [int(id), string(name), string(sig), int(0)]), ...extra]); break;
          }
          case "2/4": payload = Buffer.concat([int(missingOverlay ? 1 : 2), int(99), string("mPrivateFlags"), string("I"), int(0), ...(missingOverlay ? [] : [int(100), string("mOverlay"), string("Landroid/view/ViewOverlay;"), int(0)])]); break;
          case "9/2": {
            const count = body.readInt32BE(4);
            assert.equal(body.length, 8 + 4 * count);
            const fields = Array.from({ length: count }, (_, i) => body.readInt32BE(8 + i * 4));
            fieldReads.push(fields);
            payload = Buffer.concat([int(count), ...fields.map(field => {
              assert.ok(field === 99 || field === 100);
              return field === 99 ? tagged("I", skipOwn ? 0x80 : 0) : tagged("L", overlayOwn ? 900 : 0);
            })]);
            if (badFields === "count") payload.writeInt32BE(count + 1);
            if (badFields === "tag") payload[4] = 76;
            if (badFields === "short") payload = payload.subarray(0, payload.length - 1);
            if (badFields === "trailing") payload = Buffer.concat([payload, Buffer.from([0])]);
            break;
          }
          case "9/7": pins.push(body.readInt32BE()); break;
          case "9/8": released.push(body.readInt32BE()); break;
          case "17/1": payload = Buffer.concat([Buffer.from([1]), int(body.readInt32BE() - 4000)]); break;
          case "1/11": strings.set(++next, body.subarray(4).toString()); payload = int(next); break;
          case "3/4": payload = result("L", 200); break;
          case "3/3": {
            const method = body.readInt32BE(8), values = args(body, 16, body.readInt32BE(12));
            if (method === 2) {
              assert.equal(values[0], 100, "only search within the identified window");
              const index = refs.indexOf(strings.get(values[1])!);
              if (strings.get(values[1]) === "example.DecorView@abc") rootChecks++;
              payload = result("L", strings.get(values[1]) === "example.DecorView@abc" ? 100 : index < 0 ? 0 : 501 + index);
            } else if (method === 13) payload = result("L", 400);
            else if (method === 15) {
              assert.equal(body.readInt32BE(), classes.get("Ljava/lang/Class;"), "use the bootstrap Class, not the duplicate loader");
              const signature = `L${strings.get(values[0])!.replace(/\./g, "/")};`;
              if (!classes.has(signature)) classes.set(signature, classes.size + 1);
              payload = result("L", 4000 + classes.get(signature)!);
            }
            else { assert.equal(method, 8); payload = result("L", 300); }
            break;
          }
          case "9/6": {
            const object = body.readInt32BE(), method = body.readInt32BE(12), values = args(body, 20, body.readInt32BE(16));
            switch (method) {
              case 1: payload = result("I", 0xabc); break;
              case 3: case 4: payload = result("I", 1); break;
              case 7:
                if (disconnect) { socket.destroy(); return; }
                assert.deepEqual(values, [200, 1], "snapshot must skip children"); drawn.push(object);
                payload = object === 502 ? result("L", 0, 999) : result("L", object + 100); break;
              case 9: assert.deepEqual(values, [300, 0]); payload = result("L", object + 100); break;
              case 11: payload = result("L", object + 200); break;
              case 14: assert.equal(strings.get(values[0]), "activity-window"); payload = result("L", 100); break;
              case 5: arrays.set(values[0], object); payload = result("V"); break;
              case 10: recycled.push(object); payload = result("V"); break;
              default: assert.fail(`unknown method ${method}`);
            }
            break;
          }
          case "4/1": payload = tagged("[", ++next); break;
          case "13/2": payload = Buffer.concat([Buffer.from("I"), int(1), Buffer.from([emptyTexture && arrays.get(body.readInt32BE()) === 704 ? 0 : 1, arrays.get(body.readInt32BE())! - 700, 0, 0]).subarray(0, brokenPixels ? 3 : 4)]); break;
          case "1/6": disposed = true; disposeCount++; break;
          default: assert.fail(`unexpected command ${command}`);
        }
        const header = Buffer.alloc(11); header.writeUInt32BE(11 + payload.length); packet.copy(header, 4, 4, 8); header[8] = 0x80;
        socket.write(Buffer.concat([header, payload]));
        if (event) {
          const eventData = Buffer.concat([Buffer.from([1]), int(1), Buffer.from([2]), int(7), int(3)]);
          const header = Buffer.alloc(11); header.writeUInt32BE(11 + eventData.length); header[9] = 64; header[10] = 100;
          socket.write(Buffer.concat([header, eventData]));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const bitmapQueriesSince = (classStart: number, methodStart: number) => ({
      classes: classQueries.slice(classStart).filter(name => name === "Landroid/graphics/Bitmap;" || name === "[I"),
      methods: methodQueries.slice(methodStart).filter(id => id === classes.get("Landroid/graphics/Bitmap;")),
    });
    for (const metadataBatch of [false, true]) {
      for (const scenario of ["type-only", "skip-draw", "lookup-failure"] as const) {
        const classStart = classQueries.length, methodStart = methodQueries.length;
        const pinsStart = pins.length, releasedStart = released.length, drawsStart = drawn.length;
        const rootsBefore = rootChecks, disposedBefore = disposeCount;
        skipOwn = scenario === "skip-draw";
        const ref = scenario === "lookup-failure" ? "example.Missing@999" : refs[0];
        const inspected = await captureViewBitmaps(address.port,
          { rootRef: "example.DecorView@abc", windowName: "activity-window", metadataBatch },
          [{ ref, captureOwn: scenario === "skip-draw" }], AbortSignal.timeout(5000));
        assert.deepEqual(bitmapQueriesSince(classStart, methodStart), { classes: [], methods: [] },
          `${scenario}, batch=${metadataBatch}: classification-only work must not prepare bitmap metadata`);
        assert.equal(inspected.images.size, 0);
        assert.equal(inspected.timing.requested, 0);
        assert.equal(inspected.timing.bitmapSetupRequests, 0);
        assert.equal(inspected.timing.bitmapSetupMs, 0);
        for (const key of ["lookupRefMs", "lookupTypeMs", "lookupDrawMs", "lookupReleaseMs"] as const)
          assert.ok(Number.isFinite(inspected.timing[key]) && inspected.timing[key] >= 0, key);
        assert.equal(inspected.skipDraw.has(ref), scenario === "skip-draw");
        assert.equal(inspected.failures.size, Number(scenario === "lookup-failure"));
        if (scenario === "lookup-failure") assert.match(inspected.failures.get(ref)!, /控件已不在当前窗口/);
        else assert.equal(inspected.kinds.get(ref), "own");
        assert.equal(rootChecks, rootsBefore + 1, "no bitmap work still verifies the exact window root");
        assert.equal(disposeCount, disposedBefore + 1, "classification-only completion disposes the debugger");
        assert.deepEqual(released.slice(releasedStart).sort(), pins.slice(pinsStart).sort(), "release every pinned object on the no-bitmap path");
        assert.equal(drawn.length, drawsStart);
      }
    }
    skipOwn = false;
    const captured = await captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window", metadataBatch: true }, refs.map((ref) => ({ ref, captureOwn: true })), AbortSignal.timeout(5000));
    assert.deepEqual(drawn, [501, 502, 503]);
    assert.deepEqual([...captured.images.keys()], [refs[3], refs[0], refs[2]], "prioritize video buffers before the bounded own-view fallback");
    assert.match(captured.failures.get(refs[1])!, /exception/);
    for (const [ref, image] of captured.images) {
      const png = Buffer.from(image.imageDataUrl.split(",")[1], "base64");
      const pixels = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)));
      assert.deepEqual([...pixels], [0, refs.indexOf(ref) + 1, 0, 0, 1], "pixels and faint alpha stay with their object, even for same-name views");
    }
    assert.equal(suspendCount, 0, "never forcibly interrupt a draw/layout operation");
    assert.equal(disposed, true);
    for (const key of ["connectMs", "idsMs", "threadLookupMs", "boundaryMs", "metadataMs", "rootVerifyMs", "bitmapSetupMs", "lookupRefMs", "lookupTypeMs", "lookupDrawMs", "lookupReleaseMs"] as const)
      assert.ok(Number.isFinite(captured.timing[key]) && captured.timing[key] >= 0);
    assert.ok(captured.timing.setupRequests > 0);
    assert.ok(captured.timing.bitmapSetupRequests > 0);
    assert.ok(captured.timing.threadNameRequests > 0);
    assert.deepEqual(released.sort(), pins.sort());
    assert.deepEqual(recycled.sort(), [601, 701, 603, 703, 704].sort());
    const serialMetadata = await captureViewBitmaps(address.port,
      { rootRef: "example.DecorView@abc", windowName: "activity-window", metadataBatch: false },
      refs.map(ref => ({ ref, captureOwn: true })), AbortSignal.timeout(5000));
    assert.deepEqual([...serialMetadata.images], [...captured.images], "batching changes transport, not pixels");
    assert.deepEqual([...serialMetadata.failures], [...captured.failures]);
    assert.equal(serialMetadata.timing.setupRequests, captured.timing.setupRequests, "same read-only requests in both modes");
    assert.equal(serialMetadata.timing.bitmapSetupRequests, captured.timing.bitmapSetupRequests, "lazy bitmap preparation has the same request count in both modes");
    const wakeCount = legacyWakes;
    await assert.rejects(captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window", hardwareAccelerated: false }, [{ ref: refs[0], captureOwn: true }]), /软件窗口需要新版 SDK/);
    assert.equal(legacyWakes, wakeCount, "known software window never calls the HWUI wake");
    let safeWakes = 0;
    const software = await captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window", hardwareAccelerated: false,
      wakeUi: async () => { safeWakes++; } }, [{ ref: refs[0], captureOwn: true }]);
    assert.equal(safeWakes, 1); assert.equal(legacyWakes, wakeCount);
    assert.equal(software.images.size, 1);
    assert.ok(classes.has("Landroid/view/ViewDebug$SoftwareCanvasProvider;"));
    await assert.rejects(captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window",
      wakeUi: async () => { throw new Error("wake identity rejected"); } }, [{ ref: refs[0], captureOwn: true }]), /wake identity rejected/);
    assert.equal(legacyWakes, wakeCount, "safe wake failure must not fall back to unsafe HWUI");
    const wakeCancellation = new AbortController();
    await assert.rejects(captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window",
      wakeUi: async () => { wakeCancellation.abort(); wakeCancellation.signal.throwIfAborted(); } }, [{ ref: refs[0], captureOwn: true }], wakeCancellation.signal), /abort/i);
    await assert.rejects(captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window",
      wakeUi: async () => { throw new Error("SDK wake timeout"); } }, [{ ref: refs[0], captureOwn: true }]), /SDK wake timeout/);
    const recoveredWake = await captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window", hardwareAccelerated: false,
      wakeUi: async () => {} }, [{ ref: refs[0], captureOwn: true }]);
    assert.equal(recoveredWake.images.size, 1, "the next capture recovers after wake rejection, cancellation and timeout");
    assert.equal(legacyWakes, wakeCount); assert.equal(disposed, true);
    assert.equal(suspendCount, 0);
    const extraRefs = Array.from({ length: 70 }, (_, i) => `example.Image@${(0x1000 + i).toString(16)}`);
    refs.push(...extraRefs);
    const batch = await captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window" }, extraRefs.map(ref => ({ ref, captureOwn: true })), AbortSignal.timeout(5000));
    assert.equal(batch.images.size, 64);
    assert.equal(batch.failures.size, 6, "the bounded fallback explicitly reports every omitted image");
    assert.equal(resumes, 0, "dispose releases the single safe pause");
    brokenPixels = true;
    const broken = await captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window" }, [{ ref: refs[0], captureOwn: true }], AbortSignal.timeout(5000));
    assert.equal(broken.images.size, 0);
    assert.match(broken.failures.get(refs[0])!, /像素不完整/);
    assert.deepEqual(released.sort(), pins.sort());
    const capturedObjects = [...drawn];
    disposed = false;
    const staleClassStart = classQueries.length, staleMethodStart = methodQueries.length;
    await assert.rejects(captureViewBitmaps(address.port, { rootRef: "example.DecorView@stale", windowName: "activity-window" }, [], AbortSignal.timeout(5000)), /窗口身份已变化/);
    assert.deepEqual(bitmapQueriesSince(staleClassStart, staleMethodStart), { classes: [], methods: [] }, "identity rejection precedes bitmap initialization");
    assert.equal(disposed, true);
    assert.deepEqual(drawn, capturedObjects, "a stale window never captures another view's pixels");
    assert.deepEqual(released.sort(), pins.sort());
    brokenPixels = false; emptyTexture = true; skipOwn = true;
    const emptyFieldReads = fieldReads.length;
    const empty = await captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window" }, [{ ref: refs[0], captureOwn: true }, { ref: refs[3], captureOwn: false }]);
    assert.equal(empty.images.size, 0, "a transparent video buffer is not a successful capture");
    assert.match(empty.failures.get(refs[3])!, /未确认取得视频画面/);
    assert.equal(empty.kinds.get(refs[3]), "texture", "probe video buffers even when DDMS already supplied a bitmap");
    assert.equal(empty.skipDraw.has(refs[0]), true);
    assert.deepEqual(fieldReads.at(-1), [99, 100], "flags and overlay use one object-local read");
    assert.equal(fieldReads.length - emptyFieldReads, 1, "skip-draw decision needs one round trip instead of two");
    assert.equal(empty.timing.fieldReadRequests, 1);
    assert.equal(empty.timing.batchedFieldReads, 1);
    assert.deepEqual(drawn, capturedObjects, "skip-draw containers should not consume the capture budget");
    customDraw = true;
    const beforeClassification = methodQueries.length;
    const classified = await captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window" }, [{ ref: refs[0], captureOwn: false }]);
    assert.equal(classified.kinds.get(refs[0]), "own");
    assert.equal(classified.images.size, 0, "an existing ordinary bitmap is not captured again");
    assert.equal(methodQueries.slice(beforeClassification).filter(id => [classes.get("Lexample/Image;"), classes.get("Lexample/DecoratedLayout;")].includes(id)).length, 0,
      "buffer classification needs superclass identities, not custom dispatchDraw method lists");
    const mixed = await captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window" }, [{ ref: refs[0], captureOwn: false }, { ref: refs[2], captureOwn: true }]);
    assert.deepEqual([...mixed.images.keys()], [refs[2]], "kind-only caching must not hide inherited drawing when the same class needs a bitmap later");
    assert.equal(mixed.skipDraw.size, 0);
    badDrawMethodsOnce = true;
    const recoveredMethods = await captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window" }, [refs[0], refs[2]].map(ref => ({ ref, captureOwn: true })));
    assert.match(recoveredMethods.failures.get(refs[0])!, /Invalid JDWP member list/);
    assert.equal(recoveredMethods.images.has(refs[2]), true, "a failed method query must not cache false and hide later inherited drawing");
    assert.equal(recoveredMethods.skipDraw.size, 0);
    const decorated = await captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window" }, [refs[0], refs[2]].map(ref => ({ ref, captureOwn: true })));
    assert.deepEqual([...decorated.images.keys()], [refs[0], refs[2]], "inherited dispatchDraw pixels survive SKIP_DRAW, including cached types");
    assert.equal(decorated.skipDraw.size, 0);
    customDraw = false; overlayOwn = true;
    const overlay = await captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window" }, [{ ref: refs[0], captureOwn: true }]);
    assert.equal(overlay.images.has(refs[0]), true, "an overlay must be captured even without an own background");
    assert.equal(overlay.skipDraw.size, 0);
    overlayOwn = false;
    for (const malformed of ["count", "tag", "short", "trailing"]) {
      badFields = malformed;
      const beforeDraw = drawn.length, beforeRead = fieldReads.length;
      const rejected = await captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window" }, [{ ref: refs[0], captureOwn: true }]);
      assert.equal(rejected.images.size, 0);
      assert.equal(rejected.skipDraw.size, 0, "bad fields must never imply transparency");
      assert.match(rejected.failures.get(refs[0])!, /Invalid JDWP field value/);
      assert.equal(drawn.length, beforeDraw);
      assert.equal(fieldReads.length - beforeRead, 1, "no retry after malformed batched reply");
      assert.deepEqual(released.sort(), pins.sort());
    }
    badFields = ""; missingOverlay = true; skipOwn = false;
    const legacy = await captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window" }, [{ ref: refs[0], captureOwn: true }]);
    assert.equal(legacy.images.size, 1, "missing overlay field does not block non-skip drawing");
    assert.equal(legacy.images.get(refs[0])!.imageDataUrl, captured.images.get(refs[0])!.imageDataUrl, "single-field compatibility and batched path retain identical pixels");
    assert.deepEqual(fieldReads.at(-1), [99]);
    assert.equal(legacy.timing.fieldReadRequests, 1);
    assert.equal(legacy.timing.batchedFieldReads, 0, "counters are local to this connection, not prior captures");
    skipOwn = true;
    const missing = await captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window" }, [{ ref: refs[0], captureOwn: true }]);
    assert.equal(missing.images.size, 0); assert.equal(missing.skipDraw.size, 0);
    assert.match(missing.failures.get(refs[0])!, /field unavailable: mOverlay/);
    missingOverlay = false;
    for (const metadataBatch of [false, true]) {
      const controller = new AbortController(), reason = new Error("cancel classification without bitmap work");
      let closed!: () => void;
      const socketClosed = new Promise<void>(resolve => { closed = resolve; });
      cancelTypeLookup = { controller, reason, closed };
      const classStart = classQueries.length, methodStart = methodQueries.length, disposedBefore = disposeCount;
      await assert.rejects(captureViewBitmaps(address.port,
        { rootRef: "example.DecorView@abc", windowName: "activity-window", metadataBatch },
        [{ ref: refs[0], captureOwn: false }], controller.signal), error => error === reason);
      await socketClosed;
      assert.deepEqual(bitmapQueriesSince(classStart, methodStart), { classes: [], methods: [] });
      assert.equal(disposeCount, disposedBefore, "closed sockets release debugger ownership without sending more commands");
      const pinsStart = pins.length, releasedStart = released.length;
      const recovered = await captureViewBitmaps(address.port,
        { rootRef: "example.DecorView@abc", windowName: "activity-window", metadataBatch },
        [{ ref: refs[0], captureOwn: false }], AbortSignal.timeout(5000));
      assert.equal(recovered.images.size, 0); assert.equal(recovered.failures.size, 0);
      assert.equal(recovered.kinds.get(refs[0]), "own");
      assert.equal(recovered.timing.bitmapSetupRequests, 0);
      assert.equal(disposeCount, disposedBefore + 1, "the next no-bitmap request completes and disposes normally");
      assert.deepEqual(released.slice(releasedStart).sort(), pins.slice(pinsStart).sort());
    }
    emptyTexture = false; skipOwn = false; disconnect = true;
    const partial = await captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window" }, [{ ref: refs[0], captureOwn: true }, { ref: refs[3], captureOwn: false }]);
    assert.deepEqual([...partial.images.keys()], [refs[3]], "disconnect must preserve already captured video pixels");
    assert.match(partial.failures.get(refs[0])!, /提前关闭/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

for (const legacy of [false, true]) for (const metadataBatch of [false, true]) test(`Surface capture isolates the actual buffer and respects protection (${legacy ? "PixelCopy backend" : "Android 14 backend"}, metadata batch=${metadataBatch})`, async () => {
  const int = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
  const string = (s: string) => Buffer.concat([int(Buffer.byteLength(s)), Buffer.from(s)]);
  const tagged = (tag: string, n: number) => {
    const value = tag === "Z" ? Buffer.from([n]) : tag === "J" ? Buffer.alloc(8) : int(n);
    if (tag === "J") value.writeBigInt64BE(BigInt(n));
    return Buffer.concat([Buffer.from(tag), value]);
  };
  const result = (tag: string, n = 0) => Buffer.concat([tag === "V" ? Buffer.from(tag) : tagged(tag, n), tagged("L", 0)]);
  const definitions = [
    ["next", "()Landroid/os/Message;"], ["findView", "(Landroid/view/View;Ljava/lang/String;)Landroid/view/View;"],
    ["getWidth", "()I"], ["getHeight", "()I"], ["getPixels", "([IIIIIII)V"], ["recycle", "()V"],
    ["getInstance", "()Landroid/view/WindowManagerGlobal;"], ["getRootView", "(Ljava/lang/String;)Landroid/view/View;"],
    ["valueOf", "(Ljava/lang/String;)Landroid/graphics/Bitmap$Config;"], ["copy", "(Landroid/graphics/Bitmap$Config;Z)Landroid/graphics/Bitmap;"],
    ["getLayoutParams", "()Landroid/view/ViewGroup$LayoutParams;"], ["isValid", "()Z"],
    ["forName", "(Ljava/lang/String;)Ljava/lang/Class;"], ["createBitmap", "(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;"],
    ["<init>", "(Landroid/view/SurfaceControl;)V"], ["<init>", "(IIII)V"], ["myUid", "()I"],
    ["setUid", "(J)Landroid/window/ScreenCapture$CaptureArgs$Builder;"],
    ["setCaptureSecureLayers", "(Z)Landroid/window/ScreenCapture$CaptureArgs$Builder;"],
    ["setAllowProtected", "(Z)Landroid/window/ScreenCapture$CaptureArgs$Builder;"],
    ["setChildrenOnly", "(Z)Landroid/window/ScreenCapture$LayerCaptureArgs$Builder;"],
    ["setSourceCrop", "(Landroid/graphics/Rect;)Landroid/window/ScreenCapture$CaptureArgs$Builder;"],
    ["setFrameScale", "(FF)Landroid/window/ScreenCapture$CaptureArgs$Builder;"],
    ["build", "()Landroid/window/ScreenCapture$LayerCaptureArgs;"],
    ["captureLayers", "(Landroid/window/ScreenCapture$LayerCaptureArgs;)Landroid/window/ScreenCapture$ScreenshotHardwareBuffer;"],
    ["getHardwareBuffer", "()Landroid/hardware/HardwareBuffer;"], ["containsSecureLayers", "()Z"],
    ["asBitmap", "()Landroid/graphics/Bitmap;"], ["close", "()V"], ["getBitmap", "()Landroid/graphics/Bitmap;"],
    ...(legacy ? [["copySurfaceInto", "(Landroid/view/Surface;Landroid/graphics/Rect;Landroid/graphics/Bitmap;)I"]] : []),
  ];
  const fields = [["mSurfaceFlags", "I"], ["flags", "I"], ["mSurface", "Landroid/view/Surface;"], ["mSurfacePackage", "Landroid/view/SurfaceControlViewHost$SurfacePackage;"], ["mBlastSurfaceControl", "Landroid/view/SurfaceControl;"], ["mSurfaceWidth", "I"], ["mSurfaceHeight", "I"]];
  const refs = ["example.Video@a", "example.Video@b", "example.Video@c", "example.Video@d", "example.Video@e", "example.LivePlayTextureView@f", "example.CanvasHost@g"];
  const classes = new Map<string, number>(), strings = new Map<number, string>(), objects = new Map<number, number>();
  const pins: number[] = [], released: number[] = [], recycled: number[] = [], closed: number[] = [], copied: number[] = [];
  const classId = (name: string) => { if (!classes.has(name)) classes.set(name, classes.size + 1); return classes.get(name)!; };
  const className = (id: number) => [...classes].find(([, value]) => value === id)![0];
  let next = 10000, secureWindow = false, disposed = 0;
  const args = (data: Buffer, start: number, count: number) => {
    const values: number[] = [];
    for (let i = 0; i < count; i++) {
      const tag = data[start++];
      values.push(tag === 90 ? data[start] : tag === 74 ? Number(data.readBigInt64BE(start)) : tag === 70 ? data.readFloatBE(start) : data.readInt32BE(start));
      start += tag === 90 ? 1 : tag === 74 ? 8 : 4;
    }
    return values;
  };
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0), handshaken = false;
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (!handshaken) {
        if (buffer.length < 14) return;
        socket.write(buffer.subarray(0, 14)); buffer = buffer.subarray(14); handshaken = true;
      }
      while (buffer.length >= 11 && buffer.length >= buffer.readUInt32BE()) {
        const packet = buffer.subarray(0, buffer.readUInt32BE()); buffer = buffer.subarray(packet.length);
        const body = packet.subarray(11), command = `${packet[9]}/${packet[10]}`;
        let payload = Buffer.alloc(0), event = false;
        switch (command) {
          case "1/7": payload = Buffer.concat(Array.from({ length: 5 }, () => int(4))); break;
          case "1/2": payload = Buffer.concat([int(1), Buffer.from([1]), int(classId(body.subarray(4).toString())), int(7)]); break;
          case "3/1": {
            const name = className(body.readInt32BE());
            payload = int(classId(name === "Lexample/Video;" ? "Landroid/opengl/GLSurfaceView;" : name === "Landroid/opengl/GLSurfaceView;" ? "Landroid/view/SurfaceView;" : name === "Lexample/CanvasHost;" ? "Landroid/view/TextureView;" : "Landroid/view/View;")); break;
          }
          case "2/1": payload = string(className(body.readInt32BE())); break;
          case "9/1": payload = Buffer.concat([Buffer.from([1]), int(classId(body.readInt32BE() === 506 ? "Lexample/LivePlayTextureView;" : body.readInt32BE() === 507 ? "Lexample/CanvasHost;" : "Lexample/Video;"))]); break;
          case "2/4": case "2/5": {
            const entries = command === "2/4" ? fields : definitions;
            payload = Buffer.concat([int(entries.length), ...entries.flatMap(([name, sig], i) => [int(i + 1), string(name), string(sig), int(0)])]); break;
          }
          case "1/4": payload = Buffer.concat([int(1), int(3)]); break;
          case "11/1": payload = string("main"); break;
          case "15/1": payload = int(7); break;
          case "15/2": break;
          case "199/1":
            assert.equal(body.subarray(0, 4).toString(), "VUOP");
            assert.equal(body.readInt32BE(8), 2, "wake idle UI with a non-blocking read, not invoke or layout mutation");
            event = true; break;
          case "1/11": strings.set(++next, body.subarray(4).toString()); payload = int(next); break;
          case "9/7": pins.push(body.readInt32BE()); break;
          case "9/8": released.push(body.readInt32BE()); break;
          case "17/1": payload = Buffer.concat([Buffer.from([1]), int(body.readInt32BE() - 9000)]); break;
          case "9/2": {
            const object = body.readInt32BE(), [name, signature] = fields[body.readInt32BE(8) - 1];
            const value = name === "mSurfaceFlags" ? (object === 504 ? 0x80 : 0) : name === "flags" ? (secureWindow ? 0x2000 : 0) : name === "mSurface" ? object + 2000 : name === "mBlastSurfaceControl" ? object + 1000 : name === "mSurfacePackage" ? 0 : 2;
            payload = Buffer.concat([int(1), tagged(signature[0], value)]); break;
          }
          case "3/3": case "3/4": case "9/6": {
            const instance = command === "9/6", object = instance ? body.readInt32BE() : 0;
            const [name, signature] = definitions[body.readInt32BE(instance ? 12 : 8) - 1];
            const values = args(body, instance ? 20 : 16, body.readInt32BE(instance ? 16 : 12));
            let value = 0, tag = "L";
            switch (name) {
              case "findView": assert.equal(values[0], 100); value = strings.get(values[1]) === "example.Root@1" ? 100 : 501 + refs.indexOf(strings.get(values[1])!); break;
              case "getInstance": value = 101; break;
              case "getRootView": assert.equal(strings.get(values[0]), "window"); value = 100; break;
              case "valueOf": value = 300; break;
              case "getLayoutParams": assert.equal(object, 100); value = 102; break;
              case "isValid": tag = "Z"; value = object === 2503 ? 0 : 1; break;
              case "getWidth": case "getHeight": tag = "I"; value = 1; break;
              case "forName": value = 9000 + classId(`L${strings.get(values[0])!.replace(/\./g, "/")};`); break;
              case "<init>":
                value = ++next;
                if (signature.includes("SurfaceControl")) { assert.ok([1501, 1502, 1505].includes(values[0])); objects.set(value, values[0] - 1000); }
                else assert.deepEqual(values, [0, 0, 2, 2]);
                break;
              case "myUid": tag = "I"; value = 10329; break;
              case "setUid": assert.deepEqual(values, [10329]); value = object; break;
              case "setCaptureSecureLayers": case "setAllowProtected": case "setChildrenOnly": assert.deepEqual(values, [0]); value = object; break;
              case "setFrameScale": assert.ok(values.every((value) => Math.abs(value - 0.505) < 0.0001)); value = object; break;
              case "setSourceCrop": value = object; break;
              case "build": value = object; break;
              case "captureLayers": { const owner = objects.get(values[0])!; copied.push(owner); value = owner === 505 || owner === 502 ? 0 : owner + 3000; break; }
              case "getHardwareBuffer": value = object + 1000; break;
              case "containsSecureLayers": tag = "Z"; break;
              case "asBitmap": value = object + 2000; break;
              case "copy": assert.deepEqual(values, [300, 0]); value = object + 1000; break;
              case "createBitmap": assert.deepEqual(values, [1, 1, 300]); value = ++next; break;
              case "copySurfaceInto":
                assert.equal(values[1], 0, "copy the source Surface, never a window crop");
                objects.set(values[2], values[0] - 2000); copied.push(values[0] - 2000);
                tag = "I"; value = values[0] === 2505 ? 4 : values[0] === 2502 ? 3 : 0; break;
              case "getBitmap": value = object + 6000; break;
              case "getPixels": objects.set(values[0], legacy && objects.has(object) ? objects.get(object)! : object - 6000); tag = "V"; break;
              case "recycle": recycled.push(object); tag = "V"; break;
              case "close": closed.push(object); tag = "V"; break;
              default: assert.fail(`Unexpected method ${name}`);
            }
            payload = result(tag, value); break;
          }
          case "4/1": payload = tagged("[", ++next); break;
          case "13/2": payload = Buffer.concat([Buffer.from("I"), int(1), Buffer.from([255, objects.get(body.readInt32BE())! - 500, 23, 42])]); break;
          case "1/6": disposed++; break;
          default: assert.fail(`Unexpected command ${command}`);
        }
        const header = Buffer.alloc(11); header.writeUInt32BE(11 + payload.length); packet.copy(header, 4, 4, 8); header[8] = 0x80;
        socket.write(Buffer.concat([header, payload]));
        if (event) {
          const payload = Buffer.concat([Buffer.from([1]), int(1), Buffer.from([2]), int(7), int(3)]);
          const header = Buffer.alloc(11); header.writeUInt32BE(11 + payload.length); header[9] = 64; header[10] = 100;
          socket.write(Buffer.concat([header, payload]));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const capture = (refs: string[]) => captureViewBitmaps(address.port, { rootRef: "example.Root@1", windowName: "window", metadataBatch }, refs.map((ref) => ({ ref, captureOwn: false })), AbortSignal.timeout(5000));
    const captured = await capture(refs);
    assert.ok(captured.timing.bitmapSetupRequests > 0, "surface and texture capture prepare bitmap metadata on demand");
    for (const key of ["bitmapSetupMs", "lookupRefMs", "lookupTypeMs", "lookupDrawMs", "lookupReleaseMs"] as const)
      assert.ok(Number.isFinite(captured.timing[key]) && captured.timing[key] >= 0, key);
    assert.deepEqual([...captured.images.keys()], [refs[0], refs[6]]);
    assert.equal(captured.kinds.get(refs[0]), "surface", "custom GLSurfaceView subclass is recognized");
    assert.equal(captured.kinds.get(refs[5]), "own", "a name containing TextureView is not a TextureView");
    assert.equal(captured.kinds.get(refs[6]), "texture", "custom TextureView subclass is recognized");
    assert.match(captured.failures.get(refs[1])!, legacy ? /尚未提交/ : /无画面/);
    assert.match(captured.failures.get(refs[2])!, /已经销毁/);
    assert.match(captured.failures.get(refs[3])!, /保护/);
    assert.match(captured.failures.get(refs[4])!, /保护/);
    for (const [ref, image] of captured.images) {
      const png = Buffer.from(image.imageDataUrl.split(",")[1], "base64");
      assert.deepEqual([...inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)))], [0, refs.indexOf(ref) + 1, 23, 42, 255]);
    }
    assert.deepEqual(copied, [501, 502, 505], "invalid/secure surfaces never reach the copy API; frame availability is checked by the copy backend");
    assert.deepEqual(closed, legacy ? [] : [4501]);
    assert.equal(recycled.length, legacy ? 4 : 3);
    assert.deepEqual(released.sort(), pins.sort());
    secureWindow = true;
    const blocked = await capture([refs[0]]);
    assert.equal(blocked.images.size, 0);
    assert.match(blocked.failures.get(refs[0])!, /FLAG_SECURE/);
    assert.deepEqual(copied, [501, 502, 505]);
    assert.equal(disposed, 2);
    assert.deepEqual(released.sort(), pins.sort());
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("failed video capture disposes the debugger session", async () => {
  const commands: number[][] = [];
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0), handshake = false;
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (!handshake) {
        if (buffer.length < 14) return;
        socket.write(buffer.subarray(0, 14)); buffer = buffer.subarray(14); handshake = true;
      }
      while (buffer.length >= 11 && buffer.length >= buffer.readUInt32BE()) {
        const packet = buffer.subarray(0, buffer.readUInt32BE()); buffer = buffer.subarray(packet.length);
        commands.push([packet[9], packet[10]]);
        const reply = Buffer.alloc(11);
        reply.writeUInt32BE(11); packet.copy(reply, 4, 4, 8); reply[8] = 0x80;
        if (packet[10] === 7) reply.writeUInt16BE(99, 9);
        socket.write(reply);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await assert.rejects(captureViewBitmaps(address.port, { rootRef: "DecorView@a", windowName: "activity-window" }, [{ ref: "TextureView@123", captureOwn: true }]), /JDWP 1\/7/);
    assert.deepEqual(commands, [[1, 7], [1, 6]]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Debug View layer parser keeps transparent PNGs and tolerates null captures", () => {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(32, 16);
  png.writeUInt32BE(16, 20);
  const name = Buffer.from("TextView");
  const imageRecord = Buffer.alloc(1 + 2 + name.length + 1 + 8 + 4 + png.length);
  let offset = 0;
  imageRecord[offset++] = 1;
  imageRecord.writeUInt16BE(name.length, offset);
  offset += 2;
  name.copy(imageRecord, offset);
  offset += name.length;
  imageRecord[offset++] = 1;
  imageRecord.writeInt32BE(10, offset);
  imageRecord.writeInt32BE(20, offset + 4);
  offset += 8;
  imageRecord.writeUInt32BE(png.length, offset);
  png.copy(imageRecord, offset + 4);
  const nullName = Buffer.from("View");
  const nullRecord = Buffer.alloc(1 + 2 + nullName.length + 1 + 8);
  offset = 0;
  nullRecord[offset++] = 1;
  nullRecord.writeUInt16BE(nullName.length, offset);
  offset += 2;
  nullName.copy(nullRecord, offset);
  offset += nullName.length;
  nullRecord[offset++] = 1;
  const header = Buffer.alloc(8);
  header.writeUInt32BE(1080, 0);
  header.writeUInt32BE(2400, 4);

  const layers = parseCapturedViewLayers(Buffer.concat([header, imageRecord, nullRecord, Buffer.from([2])]));

  assert.deepEqual(layers.map(({ name, width, height }) => ({ name, width, height })), [
    { name: "TextView", width: 32, height: 16 },
    { name: "View", width: 0, height: 0 },
  ]);
  assert.match(layers[0].imageDataUrl ?? "", /^data:image\/png;base64,/);
  assert.equal(layers[1].imageDataUrl, null);
});

test("SDK partial parser publishes only complete, CRC-checked PNG records", () => {
  const chunk = (name: string, body: Buffer) => {
    const type = Buffer.from(name);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([type, body])));
    return Buffer.concat([header, type, body, checksum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from([0, 1, 2, 3, 255]))), chunk("IEND", Buffer.alloc(0))]);
  const name = Buffer.from("View@a");
  const record = Buffer.alloc(1 + 2 + name.length + 1 + 8 + 4 + png.length);
  let at = 0;
  record[at++] = 1;
  record.writeUInt16BE(name.length, at); at += 2;
  name.copy(record, at); at += name.length;
  record[at++] = 1;
  record.writeUInt32BE(png.length, at + 8);
  png.copy(record, at + 12);
  const prefix = Buffer.concat([Buffer.alloc(8), record]);
  assert.equal(parseCapturedViewLayerPrefix(prefix.subarray(0, prefix.length - 1)).length, 0);
  assert.equal(parseCapturedViewLayerPrefix(Buffer.concat([prefix, record.subarray(0, 10)])).length, 1);
  assert.equal(parseCapturedViewLayerPrefix(prefix)[0].name, "View@a");
  const identified = Buffer.from(prefix);
  Buffer.from("0123456789abcdef", "hex").copy(identified);
  assert.equal(parseCapturedViewLayerPrefix(identified, "0123456789abcdef").length, 1);
  assert.equal(parseCapturedViewLayerPrefix(identified, "fedcba9876543210").length, 0);
  const damaged = Buffer.from(prefix);
  damaged[damaged.length - 1] ^= 1;
  assert.throws(() => parseCapturedViewLayerPrefix(damaged), /图片校验失败/);
});

test("SDK parser publishes complete lossless WebP records only after their checksum arrives", () => {
  const webp = Buffer.alloc(26);
  webp.write("RIFF", 0);
  webp.writeUInt32LE(webp.length - 8, 4);
  webp.write("WEBP", 8);
  webp.write("VP8L", 12);
  webp.writeUInt32LE(5, 16);
  webp[20] = 0x2f;
  const name = Buffer.from("View@a");
  const record = Buffer.alloc(1 + 2 + name.length + 1 + 8 + 4 + webp.length + 4);
  let at = 0;
  record[at++] = 1;
  record.writeUInt16BE(name.length, at); at += 2;
  name.copy(record, at); at += name.length;
  record[at++] = 1;
  record.writeInt32BE(12, at); record.writeInt32BE(34, at + 4); at += 8;
  record.writeUInt32BE(webp.length, at); at += 4;
  webp.copy(record, at); at += webp.length;
  record.writeUInt32BE(crc32(webp), at);
  const prefix = Buffer.concat([Buffer.alloc(8), record]);
  assert.equal(parseCapturedViewLayerPrefix(prefix.subarray(0, prefix.length - 1)).length, 0);
  const layer = parseCapturedViewLayerPrefix(prefix)[0];
  assert.deepEqual({ name: layer.name, width: layer.width, height: layer.height }, { name: "View@a", width: 1, height: 1 });
  assert.match(layer.imageDataUrl ?? "", /^data:image\/webp;base64,/);
  const damaged = Buffer.from(prefix);
  damaged[damaged.length - 1] ^= 1;
  assert.throws(() => parseCapturedViewLayerPrefix(damaged), /WebP 校验失败/);
});

test("Debug View bitmaps prefer exact matches and tolerate only unique one-pixel drift", () => {
  const node = (id: string, left: number): UiNode => ({
    id, index: 0, className: "android.widget.TextView", package: "app", text: null, resourceId: null, contentDesc: null,
    bounds: { left, top: 20, right: left + 32, bottom: 36, raw: `[${left},20][${left + 32},36]` },
    clickable: false, enabled: true, focusable: false, focused: false, scrollable: false, selected: false, visibleToUser: true,
    attributes: { "inspection-source": "debug-view" }, children: [],
  });
  const exact = node("0/0", 10);
  const nearby = node("0/1", 11);
  const root = { ...node("0", 0), className: "Activity", children: [nearby, exact] };
  const imageDataUrl = "data:image/png;base64,AA==";

  assert.equal(attachViewLayerImages(root, [{ name: "TextView", visible: true, x: 10, y: 20, width: 32, height: 16, imageDataUrl }]), 1);
  assert.equal(exact.layerImageDataUrl, imageDataUrl);
  assert.equal(nearby.layerImageDataUrl, undefined);
  assert.equal(attachViewLayerImages(root, [{ name: "TextView", visible: true, x: 12, y: 20, width: 32, height: 16, imageDataUrl }]), 1);
  assert.equal(nearby.layerImageDataUrl, imageDataUrl);
  assert.equal(exact.layerImageDataUrl, undefined);
  assert.equal(attachViewLayerImages(root, [{ name: "TextView", visible: true, x: 13, y: 20, width: 32, height: 16, imageDataUrl }]), 0);
  assert.equal(attachViewLayerImages(root, [{ name: "TextView", visible: true, x: 9, y: 20, width: 32, height: 16, imageDataUrl }, { name: "TextView", visible: true, x: 10, y: 21, width: 32, height: 16, imageDataUrl }]), 0);
});

test("real alpha hides transparent overlays and descendants; screen coordinates include translation", () => {
  const node = (id: string): UiNode => ({
    id, index: 0, className: "View", package: "app", text: null, resourceId: null, contentDesc: null, bounds: null,
    clickable: false, enabled: true, focusable: false, focused: false, scrollable: false, selected: false, visibleToUser: true,
    attributes: { "view-ref": `View@${id}` }, children: [],
  });
  const root = node("a"), shadow = node("b"), child = node("c");
  root.children = [shadow]; shadow.children = [child];
  applyViewProperties(root, "View@a drawing:getAlpha()=3,0.5 layout:getLocationOnScreen_x()=2,10 layout:getLocationOnScreen_y()=2,20 layout:getWidth()=3,100 layout:getHeight()=3,200 \n View@b drawing:getAlpha()=3,0.0 \n  View@c drawing:getAlpha()=3,1.0 ");
  assert.equal(root.attributes?.["effective-alpha"], "0.5");
  assert.equal(root.bounds?.raw, "[10,20][110,220]");
  assert.equal(shadow.visibleToUser, false);
  assert.equal(child.visibleToUser, false);
});

test("same-name/same-bounds layers are ambiguous, but an explicit view identity is unique", () => {
  const a = { ...makeNode("0/0"), resourceId: null, attributes: { "view-ref": "ViewGroup@a" } };
  const b = { ...makeNode("0/1"), resourceId: null, attributes: { "view-ref": "ViewGroup@b" } };
  const root = { ...makeNode("0"), children: [a, b] };
  const layer = { name: "ViewGroup", visible: true, x: 0, y: 0, width: 360, height: 48, imageDataUrl: "data:image/png;base64,AA==" };
  assert.equal(attachViewLayerImages(root, [layer]), 0);
  assert.equal(root.children[0].layerImageStatus, "ambiguous");
  assert.equal(root.children[1].layerImageDataUrl, undefined);
  assert.equal(attachViewLayerImages(root, [{ ...layer, viewRef: "ViewGroup@b" }]), 1);
  assert.equal(root.children[1].layerImageStatus, "captured");
  assert.equal(root.children[0].layerImageStatus, "unavailable");
});

test("duplicate bitmap records do not silently attach the first image", () => {
  const child: UiNode = { ...makeNode("0/0"), resourceId: null };
  const root = { ...makeNode("0"), children: [child] };
  const layer = { name: "ViewGroup", visible: true, x: 0, y: 0, width: 360, height: 48, imageDataUrl: "data:image/png;base64,AA==" };
  assert.equal(attachViewLayerImages(root, [layer, { ...layer, imageDataUrl: "other" }]), 0);
  assert.equal(child.layerImageStatus, "ambiguous");
  assert.equal(child.layerImageDataUrl, undefined);
});

test("skip-draw containers do not compete with anonymous drawable images, but retain explicit identity", () => {
  const child: UiNode = { ...makeNode("0/0/0"), resourceId: null, attributes: { "view-ref": "ViewGroup@b", "skip-draw": "false" } };
  const parent: UiNode = { ...makeNode("0/0"), resourceId: null, attributes: { "view-ref": "ViewGroup@a", "skip-draw": "true" }, children: [child], layerImageEmpty: true };
  const root = { ...makeNode("0"), children: [parent] };
  const layer = { name: "ViewGroup", visible: true, x: 0, y: 0, width: 360, height: 48, imageDataUrl: "child-own-image" };
  assert.equal(attachViewLayerImages(root, [layer]), 1);
  assert.equal(parent.layerImageStatus, "unavailable");
  assert.equal(parent.layerImageDataUrl, undefined);
  assert.equal(parent.layerImageEmpty, undefined, "new capture clears stale transparency");
  assert.equal(child.layerImageDataUrl, "child-own-image");
  assert.equal(attachViewLayerImages(root, [{ ...layer, viewRef: "ViewGroup@a" }]), 1);
  assert.equal(parent.layerImageStatus, "captured");
  delete parent.attributes!["skip-draw"];
  assert.equal(attachViewLayerImages(root, [layer]), 0, "an unknown draw flag must not hide genuine ambiguity");
  assert.equal(child.layerImageStatus, "ambiguous");
});

test("exported native z, clipping and padding are preserved without inventing missing values", () => {
  const root: UiNode = { ...makeNode("root"), attributes: { "view-ref": "View@a" } };
  const values = { "drawing:getZ()": "7.5", "drawing:getElevation()": "5", "drawing:getClipChildren()": "true", "drawing:getClipToPadding()": "false", "padding:mPaddingLeft": "12", "drawing:isHardwareAccelerated()": "false" };
  applyViewProperties(root, `View@a ${Object.entries(values).map(([k, v]) => `${k}=${v.length},${v}`).join(" ")} `);
  assert.equal(root.attributes?.["z"], "7.5");
  assert.equal(root.attributes?.["clip-children"], "true");
  assert.equal(root.attributes?.["padding-left"], "12");
  assert.equal(root.attributes?.["padding-right"], undefined);
  assert.equal(root.attributes?.["hardware-accelerated"], "false");
});

test("Debug capture chooses the window whose root identity matches, not the first window", async () => {
  const captured: string[] = [];
  let layerRequests = 0;
  let duplicateRoot = false, changedRoot = false, truncate = false, incomplete = false, incompleteOnce = false;
  const padding = "hello world ".repeat(1024);
  const int = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const utf16 = (s: string) => Buffer.from(s, "utf16le").swap16();
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0), handshaken = false;
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (!handshaken) {
        if (buffer.length < 14) return;
        socket.write(buffer.subarray(0, 14)); buffer = buffer.subarray(14); handshaken = true;
      }
      while (buffer.length >= 11 && buffer.length >= buffer.readUInt32BE()) {
        const packet = buffer.subarray(0, buffer.readUInt32BE()); buffer = buffer.subarray(packet.length);
        const type = packet.subarray(11, 15).toString();
        let data: Buffer;
        if (type === "VULW") data = Buffer.concat([int(2), ...["dialog", "activity"].flatMap((name) => [int(name.length), utf16(name)])]);
        else {
          const operation = packet.readUInt32BE(19), length = packet.readUInt32BE(23);
          const name = Buffer.from(packet.subarray(27, 27 + length * 2)).swap16().toString("utf16le");
          if (operation === 2) {
            layerRequests++;
            assert.equal(name, "activity", "capture only the matching window");
            data = Buffer.concat([Buffer.alloc(8), Buffer.from([2])]);
          } else {
          assert.equal(operation, 1);
          const flags = packet.subarray(27 + length * 2);
          if (flags.readUInt32BE(0) === 0) {
            assert.equal(flags.readUInt32BE(4), 1);
            assert.equal(flags.readUInt32BE(8), 1, "never use reflection for full properties after JDWP attach");
            captured.push(name);
          } else assert.equal(flags.readUInt32BE(4), 0, "identity probes need no properties");
          const full = flags.readUInt32BE(0) === 0;
          const hash = name === "activity" || duplicateRoot ? full && changedRoot ? -559038737 : 0x9c5dabe : 0x1b9116c;
          data = full ? encodedHierarchy(encodedView(hash, { "meta:__name__": "com.android.internal.policy.DecorView", "text:text": padding }), !incomplete && !incompleteOnce) : Buffer.from(`com.android.internal.policy.DecorView@${(hash >>> 0).toString(16)} properties\n\nDONE.\n`);
          if (full) incompleteOnce = false;
          }
        }
        const payload = Buffer.concat([Buffer.from(type), int(data.length), data]);
        const reply = Buffer.alloc(11); reply.writeUInt32BE(11 + payload.length); packet.copy(reply, 4, 4, 8); reply[8] = 0x80;
        const response = Buffer.concat([reply, payload]);
        // Split headers and large payloads; include an empty unsolicited packet
        // to exercise zero-length reads and buffered leftovers between packets.
        const event = Buffer.alloc(11); event.writeUInt32BE(11);
        socket.write(event);
        socket.write(response.subarray(0, 3));
        let offset = 3;
        const send = () => {
          if (socket.destroyed) return;
          if (truncate && response.length > 1000) { socket.end(response.subarray(offset, offset + 16)); return; }
          if (offset >= response.length) return;
          socket.write(response.subarray(offset, offset + 16_384)); offset += 16_384;
          setImmediate(send);
        };
        send();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    let dump = "";
    const root = debugViewTree(activityHierarchy, activityTarget);
    const rootRefs = root.children.map((node) => node.attributes!["view-ref"]);
    let batchTiming: { waitMs: number; readMs: number; parseMs: number; bytes: number; layers: number } | undefined;
    const hierarchyTimings: ViewHierarchyTiming[] = [];
    const recordHierarchy = (info: ViewHierarchyTiming) => { hierarchyTimings.push(info); };
    assert.deepEqual(await captureViewLayers(address.port, { rootRefs, onHierarchy: (value) => {
      assert.equal(hierarchyTimings.length, 1, "timing must finish before preview/SDK callbacks"); dump = value;
    }, onHierarchyTiming: info => { recordHierarchy(info); throw new Error("diagnostic sink failure"); }, onBatchTiming: (timing) => { batchTiming = timing; } }), []);
    const firstTiming = hierarchyTimings[0];
    assert.equal(firstTiming.success, true); assert.equal(firstTiming.phase, "complete");
    assert.equal(firstTiming.probeRequests, 2); assert.equal(firstTiming.exportRequests, 1);
    const parts = [firstTiming.connectMs, firstTiming.windowsMs, firstTiming.probeMs, firstTiming.exportMs, firstTiming.decodeMs];
    assert.ok(parts.every(ms => Number.isFinite(ms) && ms >= 0));
    assert.ok(parts.reduce((sum, ms) => sum + ms, 0) <= firstTiming.totalMs, "nonoverlapping protocol parts fit within total");
    assert.equal(batchTiming?.bytes, 9);
    assert.equal(batchTiming?.layers, 0);
    assert.ok(batchTiming && batchTiming.waitMs >= 0 && batchTiming.readMs >= 0 && batchTiming.parseMs >= 0);
    assert.deepEqual(captured, ["activity"]);
    assert.match(dump, /^com\.android\.internal\.policy\.DecorView@9c5dabe/);
    assert.ok(dump.includes(`text:mText=${padding.length},${padding}`), "fragmented replies must retain all properties");
    assert.deepEqual(await captureViewLayers(address.port, { rootRefs, onHierarchy: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(layerRequests, 1, "bulk capture started before the early preview finished");
    } }), []);
    assert.equal(layerRequests, 2);
    assert.deepEqual(await captureViewLayers(address.port, { rootRefs, skipImages: true, onHierarchy: () => undefined }), []);
    assert.equal(layerRequests, 2, "single-view refresh must not launch the bulk DDMS image capture");
    let skipAfterHierarchy = false;
    assert.deepEqual(await captureViewLayers(address.port, { rootRefs, skipImages: () => skipAfterHierarchy, onHierarchy: () => { skipAfterHierarchy = true; } }), []);
    assert.equal(layerRequests, 2, "a successfully detected SDK should skip the bulk capture");
    incompleteOnce = true;
    assert.deepEqual(await captureViewLayers(address.port, { rootRefs, skipImages: true, onHierarchyTiming: recordHierarchy, onHierarchy: () => undefined }), [], "a transient malformed V2 tree should be retried once");
    assert.equal(hierarchyTimings.at(-1)?.exportRequests, 2); assert.equal(hierarchyTimings.at(-1)?.success, true);
    await assert.rejects(captureViewLayers(address.port, { rootRefs: ["stale"], onHierarchyTiming: recordHierarchy, onHierarchy: () => assert.fail("wrong window properties") }), /窗口与当前控件树不一致/);
    assert.equal(hierarchyTimings.at(-1)?.phase, "probe"); assert.equal(hierarchyTimings.at(-1)?.success, false);
    assert.equal(hierarchyTimings.at(-1)?.exportRequests, 0);
    assert.deepEqual(captured, Array(6).fill("activity"));
    duplicateRoot = false;
    changedRoot = true;
    await assert.rejects(captureViewLayers(address.port, { rootRefs, onHierarchy: () => assert.fail("stale full hierarchy") }), /身份已变化/);
    changedRoot = false;
    truncate = true;
    await assert.rejects(captureViewLayers(address.port, { rootRefs, onHierarchy: () => assert.fail("truncated hierarchy") }), /提前关闭/);
    truncate = false;
    incomplete = true;
    await assert.rejects(captureViewLayers(address.port, { rootRefs, onHierarchyTiming: recordHierarchy, onHierarchy: () => assert.fail("unfinished Android export") }), /Debug V2/);
    assert.equal(hierarchyTimings.at(-1)?.phase, "decode"); assert.equal(hierarchyTimings.at(-1)?.success, false);
    assert.equal(hierarchyTimings.at(-1)?.exportRequests, 2);
    duplicateRoot = true;
    await assert.rejects(captureViewLayers(address.port, { rootRefs, onHierarchy: () => assert.fail("ambiguous window properties") }), /多个 Debug 窗口匹配/);
    assert.deepEqual(captured, Array(10).fill("activity"));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("hierarchy diagnostics retain pre-cancelled connection without device commands", async () => {
  const records: ViewHierarchyTiming[] = [];
  await assert.rejects(captureViewLayers(1, { rootRefs: [], signal: AbortSignal.abort(),
    onHierarchy: () => assert.fail("cancelled hierarchy"), onHierarchyTiming: info => records.push(info) }), { name: "AbortError" });
  assert.equal(records.length, 1); assert.equal(records[0].phase, "connect"); assert.equal(records[0].success, false);
  assert.equal(records[0].probeRequests, 0); assert.equal(records[0].exportRequests, 0);
});

test("cancel closes stalled native and QML connections promptly", async () => {
  for (const capture of [
    (port: number, signal: AbortSignal) => captureViewLayers(port, { rootRefs: ["DecorView@a"], onHierarchy: () => undefined, signal }),
    (port: number, signal: AbortSignal) => captureViewBitmaps(port, { rootRef: "DecorView@a", windowName: "activity-window" }, [], signal),
    (port: number, signal: AbortSignal) => inspectQmlHierarchy(port, signal),
  ]) {
    const controller = new AbortController();
    const server = createServer((socket) => { socket.on("data", () => controller.abort()); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const timeout = setTimeout(() => controller.abort(), 1000);
    try {
      const address = server.address(); assert.ok(address && typeof address !== "string");
      await assert.rejects(capture(address.port, controller.signal));
    } finally { clearTimeout(timeout); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
});

test("next debugger handshake survives an earlier canceled layer capture", { timeout: 10_000 }, async () => {
  const server = createServer((socket) => {
    socket.once("data", (handshake) => {
      setTimeout(() => {
        if (socket.destroyed) return;
        socket.write(handshake);
        socket.once("data", (request) => {
          const payload = Buffer.from([86, 85, 76, 87, 0, 0, 0, 4, 0, 0, 0, 0]);
          const reply = Buffer.alloc(11);
          reply.writeUInt32BE(11 + payload.length);
          request.copy(reply, 4, 4, 8);
          reply[8] = 0x80;
          socket.end(Buffer.concat([reply, payload]));
        });
      }, 5_200);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    await assert.rejects(captureViewLayers(address.port, { rootRefs: ["DecorView@a"], onHierarchy: () => undefined, signal: AbortSignal.timeout(8_000) }), /窗口与当前控件树不一致/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("分支刷新的瞬态读树失败可判定为可重试，身份变化类不重试", () => {
  assert.equal(isTransientTreeReadError("Debug V2 控件属性不完整或格式无效。"), true);
  assert.equal(isTransientTreeReadError("Debug View 返回内容为空。"), true);
  assert.equal(isTransientTreeReadError("Debug View 返回了无效数据。"), true);
  assert.equal(isTransientTreeReadError("无法从 Debug App 读取 View Hierarchy。"), true);
  assert.equal(isTransientTreeReadError("控件身份、位置或层级已变化，请重新采集整页。"), false, "身份漂移绝不能靠重读掩盖");
  assert.equal(isTransientTreeReadError("分支在刷新期间变化，请重试。"), false);
  assert.equal(isTransientTreeReadError("目标 App、进程或窗口已变化，请重新采集整页。"), false);
  assert.equal(isTransientTreeReadError(""), false);
});

test("可见项分批：以条目为单位装箱、单批不超上限、单条超限进 oversized", () => {
  const a = partitionViewItems([10, 20, 30, 40], 64);
  assert.deepEqual(a.batches, [[0, 1, 2], [3]]);
  assert.deepEqual(a.oversized, []);
  const b = partitionViewItems([5, 70, 5], 64);
  assert.deepEqual(b.batches, [[0], [2]]);
  assert.deepEqual(b.oversized, [1]);
  const c = partitionViewItems([64, 1], 64);
  assert.deepEqual(c.batches, [[0], [1]]);
  const d = partitionViewItems([], 64);
  assert.deepEqual(d.batches, []);
  assert.deepEqual(d.oversized, []);
  const e = partitionViewItems([1, 2, 3], 1);
  assert.deepEqual(e.batches, [[0]]);
  assert.deepEqual(e.oversized, [1, 2]); // 超过上限的条目跳过并记录，不单条成批
  assert.throws(() => partitionViewItems([1], 0), /分批上限无效/);
  assert.throws(() => partitionViewItems([-1], 64), /条目可见控件数无效/);
});

test("会话空闲回收判定：在飞请求不回收、达到阈值即回收、禁用不回收", () => {
  assert.equal(shouldReclaimSession({ idleMs: 300_000, now: 10_000, lastUsedAt: 0, pendingCount: 1 }), false, "在飞请求保护");
  assert.equal(shouldReclaimSession({ idleMs: 300_000, now: 299_999, lastUsedAt: 0, pendingCount: 0 }), false, "未到阈值");
  assert.equal(shouldReclaimSession({ idleMs: 300_000, now: 300_000, lastUsedAt: 0, pendingCount: 0 }), true, "达到阈值（含边界）");
  assert.equal(shouldReclaimSession({ idleMs: 300_000, now: 300_100, lastUsedAt: 100, pendingCount: 0 }), true, "按最近一次使用计时");
  assert.equal(shouldReclaimSession({ idleMs: 0, now: 10_000_000, lastUsedAt: 0, pendingCount: 0 }), false, "禁用");
  assert.equal(shouldReclaimSession({ idleMs: -5, now: 10_000_000, lastUsedAt: 0, pendingCount: 0 }), false, "非法值按禁用处理");
});
