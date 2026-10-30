import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { captureSignal } from "../electron/device/runtime";
import { recoverSdkGeometryBranch, type FallbackLayerImage, type BranchRecoveryDiagnostics } from "../electron/capture/layer-images";
import { planBranchRecovery, selectBranchRecovery } from "../electron/sdk/branch-recovery";
import type { BranchGeometryRead } from "../electron/sdk/branch-geometry";

function fixture() {
  const root = makeNode("0"), window = makeNode("0/0"), branch = makeNode("0/0/0"), child = makeNode("0/0/0/0"), sibling = makeNode("0/0/1");
  root.children = [window]; window.children = [branch, sibling]; branch.children = [child];
  for (const [i, n] of [window, branch, child, sibling].entries()) {
    n.attributes = { "view-ref": `example.View@${i + 1}` };
    n.bounds = { left: 10, top: 20, right: 40, bottom: 60, raw: "[10,20][40,60]" };
  }
  root.attributes = { "debug-process-id": "42", "sdk-visible-process-instance": "12345678-1234-1234-1234-123456789abc" };
  child.layerImageStatus = "failed"; child.attributes!["image-capture-error"] = "采集期间控件位置变化，请重新采集";
  branch.layerImageDataUrl = "old-parent-pixels"; branch.layerImageStatus = "captured";
  sibling.layerImageDataUrl = "keep-sibling"; sibling.layerImageStatus = "captured";
  const plan = planBranchRecovery(root, [child], { packageName: root.package!, pid: 42,
    processInstance: root.attributes["sdk-visible-process-instance"], rootRef: window.attributes!["view-ref"] })!;
  assert.ok(plan);
  return { root, window, branch, child, sibling, plan };
}
function readers(original: BranchGeometryRead) {
  let count = 0;
  return async () => {
    const value = structuredClone(original); value.started = ++count * 200; value.ended = value.started + 1;
    value.nodes.forEach(n => { n.x += 3; n.y -= 2; });
    return value;
  };
}
function images(original: BranchGeometryRead, refs: string[]) {
  return new Map(refs.map(ref => {
    const row = original.nodes.find(n => n.ref === ref)!;
    return [ref, { x: row.x + 3, y: row.y - 2, width: row.width, height: row.height,
      imageDataUrl: `new-${ref}`, kind: "own", empty: false } satisfies FallbackLayerImage] as const;
  }));
}

test("SDK branch recovery atomically replaces moved geometry and all pixels, retaining sibling identity", async () => {
  const { root, branch, child, sibling, plan } = fixture(); let captures = 0, confirmations = 0;
  const result = await recoverSdkGeometryBranch(root, [child], readers(plan.original), async refs => {
    captures++; return { images: images(plan.original, refs), skipDraw: new Set(), failures: new Map() };
  }, async () => { confirmations++; });
  const updated = root.children[0].children[0];
  assert.notEqual(updated, branch); assert.equal(updated.bounds!.left, 13); assert.equal(updated.children[0].bounds!.top, 18);
  assert.equal(updated.children[0].layerImageStatus, "captured"); assert.equal(updated.layerImageDataUrl, "new-example.View@2");
  assert.equal(updated.children[0].attributes!["image-capture-error"], undefined);
  assert.equal(root.children[0].children[1], sibling); assert.equal(sibling.layerImageDataUrl, "keep-sibling");
  assert.equal(branch.layerImageDataUrl, "old-parent-pixels"); assert.equal(child.layerImageStatus, "failed");
  assert.deepEqual(result, { requested: 2, recovered: 1, countDelta: 1 }); assert.equal(captures, 1); assert.equal(confirmations, 2);
});

test("failed parent and child recover their own complete branch, not unrelated siblings", async () => {
  const { root, branch, child, sibling, plan } = fixture();
  delete branch.layerImageDataUrl; branch.layerImageStatus = "failed";
  branch.attributes!["image-capture-error"] = "采集期间控件位置变化，请重新采集";
  let requested: string[] = [];
  const result = await recoverSdkGeometryBranch(root, [branch, child], readers(plan.original), async refs => {
    requested = refs;
    return { images: images(plan.original, refs), skipDraw: new Set(), failures: new Map() };
  }, async () => {});
  assert.deepEqual(requested, plan.original.nodes.map(n => n.ref));
  assert.equal(result.recovered, 2); assert.equal(root.children[0].children[1], sibling);
});

test("outer recovery timings separate both window checks from geometry and commit without changing acceptance", async () => {
  const { root, child, plan } = fixture(); let confirms = 0;
  const records: BranchRecoveryDiagnostics[] = [];
  await recoverSdkGeometryBranch(root, [child], readers(plan.original), async refs => ({
    images: images(plan.original, refs), skipDraw: new Set(), failures: new Map(),
  }), async () => { await new Promise(resolve => setTimeout(resolve, ++confirms === 1 ? 25 : 40)); },
  undefined, undefined, d => records.push(d));
  assert.equal(confirms, 2); assert.equal(records.length, 1);
  const d = records[0]; assert.ok(Object.isFrozen(d)); assert.equal(d.phase, "committed");
  assert.equal(d.geometry?.phase, "complete");
  assert.ok(d.windowBeforeMs! >= 20); assert.ok(d.windowAfterMs! >= 35);
  for (const value of [d.selectionMs, d.windowBeforeMs, d.geometryMs, d.windowAfterMs, d.stageMs, d.commitMs]) {
    assert.ok(Number.isSafeInteger(value) && value! >= 0 && value! <= d.totalMs);
  }
  assert.doesNotMatch(JSON.stringify(d), /example\.|new-|pixels|@/);
});

test("late window rejection and skipped branches report only executed stages and never publish pixels", async () => {
  const { root, child, plan } = fixture(), original = structuredClone(root);
  let confirms = 0, observed: BranchRecoveryDiagnostics | undefined;
  await assert.rejects(recoverSdkGeometryBranch(root, [child], readers(plan.original), async refs => ({
    images: images(plan.original, refs), skipDraw: new Set(), failures: new Map(),
  }), async () => { if (++confirms === 2) throw new Error("window changed"); }, undefined, undefined,
  d => { observed = d; throw new Error("diagnostic observer"); }), /window changed/);
  assert.deepEqual(root, original); assert.equal(observed?.phase, "window-after");
  assert.equal(observed?.geometry?.phase, "complete");
  assert.ok(observed?.windowAfterMs !== undefined); assert.equal(observed?.commitMs, undefined);
  await recoverSdkGeometryBranch(root, [], async () => assert.fail("no read"), async () => assert.fail("no capture"),
    async () => assert.fail("no window check"), undefined, undefined, d => { observed = d; });
  assert.equal(observed?.phase, "skipped"); assert.equal(observed?.geometry, undefined);
  assert.equal(observed?.windowBeforeMs, undefined);
});

test("one bounded cluster recovers while a distant moved sibling and missing node remain untouched", async () => {
  const { root, branch, child, sibling } = fixture();
  delete branch.layerImageDataUrl; branch.layerImageStatus = "failed";
  branch.attributes!["image-capture-error"] = "采集期间控件位置变化，请重新采集";
  delete sibling.layerImageDataUrl; sibling.layerImageStatus = "failed";
  sibling.attributes!["image-capture-error"] = child.attributes!["image-capture-error"];
  const missing = { ...makeNode("0/0/2"), attributes: { "view-ref": "example.View@aa", "image-capture-error": "控件缺失或不可见" }, layerImageStatus: "failed" as const };
  root.children[0].children.push(missing);
  // Rebuild the expected ancestor digest after adding the unrelated node.
  const selected = selectBranchRecovery(root, [branch, child, sibling], { packageName: root.package!, pid: 42,
    processInstance: root.attributes!["sdk-visible-process-instance"], rootRef: root.children[0].attributes!["view-ref"] });
  assert.equal(selected.reason, "bounded-cluster"); assert.equal(selected.failed.length, 2);
  assert.equal(selected.plan!.branch, branch);
  let captures = 0;
  const result = await recoverSdkGeometryBranch(root, [branch, child, sibling, missing], readers(selected.plan!.original), async refs => {
    captures++; return { images: images(selected.plan!.original, refs), skipDraw: new Set(), failures: new Map() };
  }, async () => {});
  assert.equal(result.recovered, 2); assert.equal(captures, 1);
  assert.equal(root.children[0].children[1], sibling); assert.equal(sibling.layerImageStatus, "failed");
  assert.equal(root.children[0].children[2], missing); assert.equal(missing.layerImageStatus, "failed");
});

test("cluster selection never bypasses total failure, node or pixel caps", () => {
  const { root, branch, child, sibling } = fixture();
  const binding = { packageName: root.package!, pid: 42, processInstance: root.attributes!["sdk-visible-process-instance"], rootRef: root.children[0].attributes!["view-ref"] };
  assert.equal(selectBranchRecovery(root, Array(9).fill(child), binding).reason, "too-many-candidates");
  assert.equal(selectBranchRecovery(root, [child, sibling], binding).plan, null, "do not chase isolated leaves across the window");
  branch.bounds = { left: 0, top: 0, right: 3000, bottom: 2000, raw: "" };
  assert.equal(selectBranchRecovery(root, [branch, child, sibling], binding).plan, null);
  branch.bounds = child.bounds;
  for(let i = 0; i < 64; i++) branch.children.push({ ...makeNode(`extra${i}`), attributes: { "view-ref": `example.View@${(100+i).toString(16)}` } });
  assert.equal(selectBranchRecovery(root, [branch, child, sibling], binding).plan, null);
});

test("real five-second recovery deadline rejects late pixels and leaves geometry untouched", { timeout: 10000 }, async () => {
  const { root, child, plan } = fixture(), original = structuredClone(root);
  const started = performance.now(); let captures = 0;
  await assert.rejects(recoverSdkGeometryBranch(root, [child], readers(plan.original), async refs => {
    captures++;
    await new Promise(resolve => setTimeout(resolve, 5100));
    return { images: images(plan.original, refs), skipDraw: new Set(), failures: new Map() };
  }, async () => {}, captureSignal(undefined, 5000)), /timeout|aborted/i);
  assert.equal(captures, 1);
  assert.deepEqual(root, original);
  assert.ok(performance.now() - started >= 5000);
});

test("fresh pure-container result removes stale parent pixels without inventing a transparent bitmap", async () => {
  const { root, child, plan } = fixture();
  const result = await recoverSdkGeometryBranch(root, [child], readers(plan.original), async refs => {
    const captured = images(plan.original, refs); captured.delete(plan.original.branchRef);
    return { images: captured, skipDraw: new Set([plan.original.branchRef]), failures: new Map() };
  }, async () => {});
  const updated = root.children[0].children[0];
  assert.equal(updated.layerImageDataUrl, undefined); assert.equal(updated.layerImageEmpty, undefined);
  assert.equal(updated.layerImageStatus, "unavailable"); assert.equal(updated.attributes!["skip-draw"], "true");
  assert.equal(updated.children[0].layerImageStatus, "captured"); assert.equal(result.countDelta, 0);
});

test("partial images, ongoing movement, window change, cancellation and timeout never alter the original branch", async () => {
  for (const kind of ["partial", "moving", "window", "cancel", "timeout", "structure-conflict"] as const) {
    const { root, child, plan } = fixture(), original = structuredClone(root), controller = new AbortController();
    let reads = 0, captures = 0, confirms = 0;
    await assert.rejects(recoverSdkGeometryBranch(root, [child], async () => {
      const value = await readers(plan.original)(); value.started = ++reads * 200; value.ended = value.started + 1;
      if (kind === "moving" && reads === 2) value.nodes[0].y++;
      return value;
    }, async refs => {
      captures++;
      if (kind === "timeout") throw new Error("View selection timed out");
      if (kind === "cancel") controller.abort(new Error("Canceled"));
      return { images: images(plan.original, refs), skipDraw: new Set(kind === "structure-conflict" ? [refs[0]] : []),
        failures: new Map(kind === "partial" ? [[refs[0], "missing"]] : []) };
    }, async () => { if (++confirms === 2 && kind === "window") throw new Error("window changed"); }, controller.signal));
    assert.deepEqual(root, original); assert.equal(captures, 1);
  }
});

test("oversized or root-wide branches and non-geometry failures do not dispatch recovery", async () => {
  for (const kind of ["root", "pixels", "nodes", "reason"] as const) {
    const { root, branch, child, sibling } = fixture();
    let failed = [child];
    if (kind === "root") { delete sibling.layerImageDataUrl; sibling.layerImageStatus = "failed"; sibling.attributes!["image-capture-error"] = child.attributes!["image-capture-error"]; failed = [child, sibling]; }
    if (kind === "pixels") branch.bounds = { left: 0, top: 0, right: 3000, bottom: 2000, raw: "" };
    if (kind === "nodes") for (let i = 0; i < 64; i++) { const n = makeNode(`0/0/0/${i + 1}`); n.attributes = { "view-ref": `example.Extra@${(i + 100).toString(16)}` }; branch.children.push(n); }
    if (kind === "reason") child.attributes!["image-capture-error"] = "控件缺失或不可见";
    const result = await recoverSdkGeometryBranch(root, failed, async () => assert.fail(`no read: ${kind}`), async () => assert.fail(`no capture: ${kind}`), async () => assert.fail(`no window probe: ${kind}`));
    assert.deepEqual(result, { requested: 0, recovered: 0, countDelta: 0 });
  }
});
