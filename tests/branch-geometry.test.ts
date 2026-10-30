import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { parseBranchGeometry, verifyBranchGeometryRefresh, type BranchGeometryRead, type BranchGeometryRow, type BranchRefreshDiagnostics } from "../electron/sdk/branch-geometry";

const binding = { packageName: "com.example", pid: 42, processInstance: "12345678-1234-1234-1234-123456789abc", rootRef: "example.Root@1", branchRef: "example.Parent@2" };
const path = [binding.rootRef, binding.branchRef], nonce = "1234567890abcdef";
const row = (ref: string, parent: string, children: string[] = []): BranchGeometryRow => ({ ref, parent, x: 10, y: 20, width: 30, height: 40,
  visible: true, childCount: children.length, children, childRefsHash: createHash("sha256").update(children.join(";")).digest("hex") });
function fixture(): BranchGeometryRead {
  return { ...binding, version: 1, nonce, started: 100, ended: 101,
    ancestors: [{ ...row(binding.rootRef, ""), childCount: 1 }],
    nodes: [row(binding.branchRef, binding.rootRef, ["example.Child@3"]), row("example.Child@3", binding.branchRef)] };
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
const parse = (value: unknown) => parseBranchGeometry(encode(value), nonce, binding, path);
const images = (state: BranchGeometryRead) => new Map(state.nodes.map(row => [row.ref, { x: row.x, y: row.y, width: row.width, height: row.height }]));

test("bounded SDK branch geometry validates binding, linked BFS rows and strips unrelated payload", () => {
  const value = fixture();
  assert.deepEqual(parse(value), value);
  assert.deepEqual(parse({ ...value, pixels: "not-carried", nodes: value.nodes.map(n => ({ ...n, imageDataUrl: "not-carried" })) }), value);
  for (const mutate of [
    (v: BranchGeometryRead) => { v.pid++; }, (v: BranchGeometryRead) => { v.nonce = "0000000000000000"; },
    (v: BranchGeometryRead) => { v.processInstance = "87654321-1234-1234-1234-123456789abc"; },
    (v: BranchGeometryRead) => { v.rootRef = "example.Root@9"; }, (v: BranchGeometryRead) => { v.branchRef = "example.Parent@9"; },
    (v: BranchGeometryRead) => { v.nodes[1].parent = v.rootRef; }, (v: BranchGeometryRead) => { v.nodes[1].ref = v.nodes[0].ref; },
    (v: BranchGeometryRead) => { v.nodes[0].children = [v.rootRef]; }, (v: BranchGeometryRead) => { v.nodes.pop(); },
    (v: BranchGeometryRead) => { v.nodes[0].childCount = 3; }, (v: BranchGeometryRead) => { v.ancestors[0].children = [v.branchRef]; },
    (v: BranchGeometryRead) => { v.nodes[1].x = Infinity; }, (v: BranchGeometryRead) => { v.nodes[1].width = -1; },
    (v: BranchGeometryRead) => { v.ended = v.started + 251; }, (v: BranchGeometryRead) => { v.nodes[0].width = 100_000; },
  ]) { const invalid = fixture(); mutate(invalid); assert.throws(() => parse(invalid)); }
  assert.throws(() => parseBranchGeometry("A".repeat(64_004), nonce, binding, path));
  assert.throws(() => parseBranchGeometry(encode(fixture()), nonce, binding, [binding.rootRef, binding.rootRef, binding.branchRef]));
});

test("stable moved parent and child produce an atomic candidate without mutating the old snapshot", async () => {
  const original = parse(fixture()), copy = structuredClone(original), latest = fixture();
  latest.nodes.forEach(n => { n.x += 3; n.y -= 2; });
  let reads = 0, captures = 0;
  const result = await verifyBranchGeometryRefresh(original, async () => {
    reads++; return parse({ ...latest, started: reads * 200, ended: reads * 200 + 1 });
  }, async refs => { captures++; assert.deepEqual(refs, latest.nodes.map(n => n.ref)); return images(latest); });
  assert.equal(reads, 2); assert.equal(captures, 1); assert.equal(result.geometry.nodes[0].x, 13);
  assert.deepEqual(original, copy);
});

test("moving during capture, ancestor movement and object replacement reject without partial publication", async () => {
  for (const kind of ["moving", "ancestor", "replacement", "session", "visibility", "reorder", "clock", "ancestor-children"] as const) {
    const original = parse(fixture()), copy = structuredClone(original); let reads = 0, captures = 0;
    await assert.rejects(verifyBranchGeometryRefresh(original, async () => {
      const value = fixture(); reads++; value.started = reads * 200; value.ended = value.started + 1;
      if (kind === "moving" && reads === 2) value.nodes[1].x += 2;
      if (kind === "ancestor") value.ancestors[0].x++;
      if (kind === "ancestor-children") value.ancestors[0].childRefsHash = "a".repeat(64);
      if (kind === "replacement") { value.nodes[1].ref = "example.Child@4"; value.nodes[0].children = ["example.Child@4"]; }
      if (kind === "visibility") value.nodes[1].visible = false;
      if (kind === "reorder") { value.nodes.reverse(); }
      if (kind === "clock" && reads === 2) { value.started = 199; value.ended = 200; }
      // Device session change is rejected by the decoder before the transaction can publish it.
      if (kind === "session") value.processInstance = "87654321-1234-1234-1234-123456789abc";
      return parse(value);
    }, async () => { captures++; return images(original); }));
    assert.deepEqual(original, copy);
    if (["ancestor", "replacement", "session", "visibility", "reorder", "ancestor-children"].includes(kind)) assert.equal(captures, 0);
  }
});

test("rejection diagnostics distinguish read phase and changed field without exposing identities", async () => {
  for (const kind of ["ancestor-children", "visibility", "after-position"] as const) {
    const original = parse(fixture()); let reads = 0, captures = 0;
    await assert.rejects(verifyBranchGeometryRefresh(original, async () => {
      const value = fixture(); value.started = ++reads * 200; value.ended = value.started + 1;
      if (kind === "ancestor-children") value.ancestors[0].childRefsHash = "a".repeat(64);
      if (kind === "visibility") value.nodes[1].visible = false;
      if (kind === "after-position" && reads === 2) value.nodes[1].x++;
      return parse(value);
    }, async () => { captures++; return images(original); }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, kind === "after-position" ? /补图后复读.*分支节点 #1 的位置/ :
        kind === "visibility" ? /首次复读.*分支节点 #1 的可见状态/ : /首次复读.*祖先 #0 的子项身份或顺序/);
      assert.doesNotMatch(error.message, /example\.|@/);
      return true;
    });
    assert.equal(captures, kind === "after-position" ? 1 : 0);
  }
});

test("missing, extra, stale, resized or invalid-position images reject; tolerance remains one pixel", async () => {
  for (const kind of ["missing", "extra", "stale", "resized", "invalid"] as const) {
    let reads = 0; const original = parse(fixture());
    await assert.rejects(verifyBranchGeometryRefresh(original, async () => parse({ ...fixture(), started: ++reads * 200, ended: reads * 200 + 1 }), async () => {
      const result = images(original), first = result.get(binding.branchRef)!;
      if (kind === "missing") result.delete(binding.branchRef);
      if (kind === "extra") result.set("example.Other@9", first);
      if (kind === "stale") first.x += 2;
      if (kind === "resized") first.width++;
      if (kind === "invalid") first.y = NaN;
      return result;
    }), /画面缺失或几何失配/);
  }
});

test("root child additions/removals stop before images; later movement discards captured candidate with bounded stage evidence", async () => {
  for (const kind of ["root-add", "root-remove", "moving-again"] as const) {
    const original = fixture(); original.ancestors[0].childCount = 2;
    const copy = structuredClone(original); let reads = 0, captures = 0;
    const diagnostics: BranchRefreshDiagnostics[] = [];
    await assert.rejects(verifyBranchGeometryRefresh(original, async () => {
      const value = structuredClone(original); value.started = ++reads * 200; value.ended = value.started + 1;
      if (kind !== "moving-again") value.ancestors[0].childCount += kind === "root-add" ? 1 : -1;
      if (kind === "moving-again" && reads === 2) value.nodes[1].x += 3;
      return parse(value);
    }, async () => { captures++; return images(original); }, undefined, d => diagnostics.push(d)),
      kind === "moving-again" ? /补图后复读.*分支节点 #1 的位置/ : /首次复读.*祖先 #0 的子项数量/);
    assert.deepEqual(original, copy); assert.equal(diagnostics.length, 1);
    const d = diagnostics[0]; assert.ok(Object.isFrozen(d));
    assert.equal(captures, kind === "moving-again" ? 1 : 0);
    assert.equal(d.phase, kind === "moving-again" ? "final-check" : "first-check");
    assert.equal(d.captureMs === undefined, kind !== "moving-again");
    assert.equal(d.verifyReadMs === undefined, kind !== "moving-again");
    for (const value of [d.firstReadMs, d.captureMs, d.verifyReadMs, d.elapsedMs]) if (value !== undefined) {
      assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= d.elapsedMs);
    }
    assert.doesNotMatch(JSON.stringify(d), /example\.|@|pixels/);
  }
});

test("diagnostic observer failures cannot replace success, cancellation or transport failure", async () => {
  const original = fixture(); let reads = 0;
  const result = await verifyBranchGeometryRefresh(original, async () => {
    const value = structuredClone(original); value.started = ++reads * 200; value.ended = value.started + 1; return value;
  }, async () => images(original), undefined, () => { throw new Error("observer"); });
  assert.equal(result.images.size, 2);
  const controller = new AbortController(); controller.abort(new Error("Canceled"));
  await assert.rejects(verifyBranchGeometryRefresh(original, async () => assert.fail("no read"), async () => assert.fail("no capture"),
    controller.signal, () => { throw new Error("observer"); }), /Canceled/);
  let observed: BranchRefreshDiagnostics | undefined;
  await assert.rejects(verifyBranchGeometryRefresh(original, async () => { throw new Error("transport"); }, async () => assert.fail("no capture"),
    undefined, d => { observed = d; throw new Error("observer"); }), /transport/);
  assert.equal(observed?.phase, "first-read"); assert.ok(observed?.firstReadMs !== undefined);
});

test("branch node, pixel and path budgets reject before capture; cancellation prevents further work", async () => {
  const tooLarge = fixture(); tooLarge.nodes = Array.from({ length: 65 }, () => row("example.Child@3", binding.branchRef));
  assert.throws(() => parse(tooLarge));
  const controller = new AbortController(), original = parse(fixture()); let reads = 0;
  await assert.rejects(verifyBranchGeometryRefresh(original, async () => { reads++; controller.abort(new Error("Canceled")); return original; },
    async () => { assert.fail("no capture after cancellation"); }, controller.signal), /Canceled/);
  assert.equal(reads, 1);
});
