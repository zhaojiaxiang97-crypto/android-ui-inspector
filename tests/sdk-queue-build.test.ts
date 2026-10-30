import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseSdkBuildMarker, parseRuntimeSdkBuild, readRuntimeSdkBuild, verifyLocalQueueBuild } from "../scripts/diagnostics/sdk/sdk-queue-build";
const sourceSha256 = "a".repeat(64), processInstance = "22222222-2222-2222-2222-222222222222";
const expected = { sourceSha256, pid: 42, processInstance };
const marker = JSON.stringify({ protocol: "sdk-source-v1", sourceSha256 });
const reply = `Result: Bundle[{processInstance=${processInstance}, sourceSha256=${sourceSha256}, protocol=sdk-source-v1, pid=42, result=ok}]`;
test("strict source marker and unordered runtime Bundle preserve source identity, not binary version", () => {
  assert.equal(parseSdkBuildMarker(marker).sourceSha256, sourceSha256);
  assert.equal(parseRuntimeSdkBuild(reply, expected).sdkVersion, `sdk-source-v1:${sourceSha256}`);
  for (const text of ["{}", marker.replace("sdk-source-v1", "tree-queue-v1"), marker.replace(sourceSha256, "unknown"),
    marker.replace("}", ',"extra":true}'), "x".repeat(1025)]) assert.throws(() => parseSdkBuildMarker(text));
  for (const text of [reply.replace("pid=42", "pid=99"), reply.replace(sourceSha256, "b".repeat(64)),
    reply.replace(processInstance, "33333333-3333-3333-3333-333333333333"), reply.replace("result=ok", "error=denied"),
    reply.replace("pid=42", "pid=42, pid=42"), reply + "\n" + reply, "x".repeat(4097)])
    assert.throws(() => parseRuntimeSdkBuild(text, expected));
});
test("local artifact bytes are hashed and marker identity must match APK/AAR", async () => {
  const dir = mkdtempSync(join(tmpdir(), "queue-build-"));
  try {
    const apk = join(dir, "fixture.apk"), aar = join(dir, "fixture.aar");
    writeFileSync(apk, "apk-fixture"); writeFileSync(aar, "aar-fixture");
    let reads = 0;
    const result = await verifyLocalQueueBuild(apk, aar, new AbortController().signal, async (command, args) => {
      reads++; assert.equal(command, "unzip"); assert.equal(args[2], "assets/inspector-sdk-build.json"); return marker;
    });
    assert.equal(reads, 2);
    assert.equal(result.apkSha256, createHash("sha256").update("apk-fixture").digest("hex"));
    assert.equal(result.aarSha256, createHash("sha256").update("aar-fixture").digest("hex"));
    await assert.rejects(verifyLocalQueueBuild(apk, aar, new AbortController().signal, async (_, args) =>
      args[1] === aar ? marker.replace(sourceSha256, "b".repeat(64)) : marker), /mismatch/);
    await assert.rejects(verifyLocalQueueBuild(apk, aar, new AbortController().signal, async (_, args) => {
      if (args[1] === aar) writeFileSync(apk, "changed"); return marker;
    }), /changed/);
  } finally { rmSync(dir, { recursive: true }); }
});
test("explicit runtime read issues only shell build query and refuses late cancelled reply", async () => {
  const target = { serial: "fixture", packageName: "example.app", ...expected };
  let calls = 0;
  const result = await readRuntimeSdkBuild(target, new AbortController().signal, async (command, args) => {
    calls++; assert.equal(command, "adb");
    assert.deepEqual(args, ["-s", "fixture", "shell", "content", "call", "--uri", "content://example.app.inspector",
      "--method", "read-sdk-build", "--extra", `processInstance:s:${processInstance}`]); return reply;
  });
  assert.equal(result.pid, 42);
  const controller = new AbortController();
  await assert.rejects(readRuntimeSdkBuild(target, controller.signal, async () => {
    calls++; controller.abort(Error("cancelled")); return reply;
  }), /cancelled/);
  await assert.rejects(readRuntimeSdkBuild({ ...target, sourceSha256: "unknown" }, new AbortController().signal,
    async () => { calls++; return reply; }), /mismatch/);
  assert.equal(calls, 2);
});
