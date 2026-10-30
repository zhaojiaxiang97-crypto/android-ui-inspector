import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSdkStaleTree, parseTreeDifference } from "../electron/sdk/sdk-stale-tree";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStaleCaptureTreeError } from "../electron/sdk/capture-protocol";
test("early stale-tree rejection requires exact request, instance, root and bounded diagnostics", () => {
  const instance="12345678-1234-1234-1234-123456789abc";
  const reply:Record<string,string>={failureKind:"stale-tree",nonce:"1234567890abcdef",processInstance:instance,
    rootRef:"android.view.View@abc",failureTarget:"android.widget.TextView@def",failureCompleted:"0"};
  const parse=(value:Record<string,string>, expected:string|undefined=instance)=>parseSdkStaleTree(k=>value[k],reply.nonce,reply.rootRef,expected);
  assert.equal(parse(reply)?.["sdk-visible-failure-phase"],"tree-guard");
  for(const patch of ([{result:"ok"},{failureKind:"other"},{nonce:"wrong"},{processInstance:"other"},{rootRef:"android.view.View@fff"},
    {failureTarget:"bad"},{failureCompleted:"5001"},{failureCompleted:"-1"}] as Record<string,string>[])) assert.equal(parse({...reply,...patch}),null);
  assert.equal(parseSdkStaleTree(k=>reply[k],reply.nonce,reply.rootRef),null);
  assert.ok(isStaleCaptureTreeError(new Error("SDK 已发布控件树在绘制前变化：TextView@def")));
  assert.ok(isStaleCaptureTreeError(new Error("SDK 已发布控件树在绘制期间变化：TextView@def")));
});
test("geometry telemetry is bounded, consistent and optional for old SDK rejections", () => {
  const wire = "1;after;position;50;10;20;30;40;12;20;30;40;1;1;1;1";
  const value = JSON.parse(parseTreeDifference(wire)!);
  assert.deepEqual(value.delta, [2, 0, 0, 0]); assert.equal(value.phase, "after");
  for (const invalid of [undefined, wire + ";1", wire.replace("position", "size"), wire.replace(";50;", ";120001;"),
    wire.replace(";12;", ";11;"), wire.replace(";12;", ";Infinity;"), wire.replace(";30;40;12", ";-1;40;12"),
    "1;before;missing;0;-;0;-;-;0;0;1;1;1;1;1;1", "x".repeat(513)]) assert.equal(parseTreeDifference(invalid), undefined);
  const instance = "12345678-1234-1234-1234-123456789abc";
  const reply: Record<string, string> = { failureKind: "stale-tree", nonce: "abcd", processInstance: instance,
    rootRef: "android.view.View@abc", failureTarget: "android.widget.TextView@def", failureCompleted: "28", failureGeometry: wire };
  const parse = () => parseSdkStaleTree(k => reply[k], "abcd", reply.rootRef, instance);
  assert.equal(parse()?.["sdk-visible-failure-geometry"], parseTreeDifference(wire));
  reply.failureGeometry = "invalid";
  assert.equal(parse()?.["sdk-visible-failure-phase"], "tree-guard", "invalid optional telemetry must not disable a bound rejection");
  assert.equal(parse()?.["sdk-visible-failure-geometry"], undefined);
  reply.nonce = "other"; reply.failureGeometry = wire;
  assert.equal(parse(), null, "geometry cannot bypass request identity");
});
test("actual Java guard keeps tolerance and reports immutable before/after state", { timeout: 15000,
  skip: spawnSync("javac", ["-version"]).status !== 0 ? "JDK unavailable" : false }, () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-tree-difference-"));
  try {
    const project = join(import.meta.dirname, "..");
    const compile = spawnSync("javac", ["-d", directory,
      join(project, "android/inspector-sdk/src/main/java/com/androiduiinspector/sdk/PublishedTreeDifference.java"),
      join(project, "tests/fixtures/PublishedTreeDifferenceCheck.java")], { encoding: "utf8", timeout: 10000 });
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync("java", ["-cp", directory, "com.androiduiinspector.sdk.PublishedTreeDifferenceCheck"], { encoding: "utf8", timeout: 3000 });
    assert.equal(run.status, 0, run.stderr);
    const records = run.stdout.trim().split(/\r?\n/).map(wire => JSON.parse(parseTreeDifference(wire)!));
    assert.deepEqual(records.map(v => v.reason), ["position", "position", "size", "missing", "root", "detached", "owner", "hidden"]);
    assert.equal(records[1].phase, "after"); assert.equal(records[0].actual[0], 12);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
