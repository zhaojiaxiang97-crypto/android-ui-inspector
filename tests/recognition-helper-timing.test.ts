import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { patchRecognitionHelper } from "../scripts/prepare-recognition-helper";
import { commandTimingSource } from "./fixtures/helper-command-timing-source";

const source = readFileSync(new URL("../scripts/helper-templates/InspectorObservation.java", import.meta.url), "utf8");
const slice = (text: string, first: string, last: string) => {
  const start = text.indexOf(first), end = text.indexOf(last, start);
  assert.ok(start >= 0 && end > start, `missing production seam ${first}`); return text.slice(start, end);
};
const commandSource = commandTimingSource + '            if (contentLength < 0 || contentLength > MAX_BODY) {\n}\n' +
  '                body = new String(readExactly(in, contentLength), StandardCharsets.UTF_8);\n' +
  '            // Route endpoints\n            if (path.equals("/snapshot")) {';
const commandPath = "app/src/main/java/com/artemis/helper/CommandServer.java";

test("every pinned worker/header patch seam must occur once", () => {
  for (const seam of ['                clientExecutor.execute(new Runnable() {', '                        handleClient(socket);',
    '    private void handleClient(Socket socket) {', '                handleHttp(ascii, in, output);',
    '    private void handleHttp(String requestLine, InputStream in, OutputStream output) {',
    '    private static void send(OutputStream output, int status, String contentType, byte[] bytes) {',
    '                    "Connection: close\\r\\n\\r\\n";']) {
    assert.throws(() => patchRecognitionHelper(commandPath, commandSource.replace(seam, "changed upstream seam")), /补丁目标缺失或重复/);
    assert.throws(() => patchRecognitionHelper(commandPath, commandSource + seam), /补丁目标缺失或重复/);
  }
});

test("production snapshot and HTTP timing preserve behavior and never double-count recursion or serialization", { timeout: 30000 }, context => {
  const java = (name: string) => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", name) : name;
  const compiler = spawnSync(java("javac"), ["-version"], { encoding: "utf8", timeout: 5000 });
  if (!process.env.JAVA_HOME && (compiler.error || /Unable to locate a Java Runtime|No Java runtime present/.test(compiler.stderr))) {
    context.skip("JDK unavailable; use JDK 17 for actual production timing checks."); return;
  }
  assert.equal(compiler.status, 0, compiler.stderr);
  const directory = mkdtempSync(join(tmpdir(), "helper-snapshot-timing-"));
  try {
    const fixture = readFileSync(new URL("./fixtures/InspectorObservationDiagnosticsCheck.java", import.meta.url), "utf8");
    const methods = [source.match(/private static final ReentrantLock READS =[^;]*;/)?.[0], source.match(/private static InputCapture inputCapture;/)?.[0],
      source.match(/private static final int CHILD_PREFETCH_FLAGS =[\s\S]*?;/)?.[0],
      slice(source, "    private static final class WaitFailure", "    private static final class Capture {"),
      slice(source, "    private static final class Capture {", "    private static final class Screenshot {"),
      source.slice(source.indexOf("    private static Rect intersection("), source.lastIndexOf("}"))].join("\n");
    let checks = fixture.replace("/* PRODUCTION_METHODS */", methods).replace("public static void main(String[] args)", "public static void legacyChecks(String[] args)");
    checks = checks.replace('        void getBoundsInScreen(Rect rect) {\n            SystemClock.offsetMs',
      '        void getBoundsInScreen(Rect rect) {\n            advanceTiming(localCost);\n            SystemClock.offsetMs')
      .replace('AccessibilityNodeInfo getChild(int index) { if (childFailure)', 'AccessibilityNodeInfo getChild(int index) { advanceTiming(childCost); if (childFailure)')
      .replace('boolean clearCache() { scenario.cacheCalls++;', 'boolean clearCache() { advanceTiming(2000000); scenario.cacheCalls++;')
      .replace('void getRealMetrics(DisplayMetrics metrics) {', 'void getRealMetrics(DisplayMetrics metrics) { advanceTiming(3000000);')
      .replace('AccessibilityNodeInfo getRoot() { return root; }', 'AccessibilityNodeInfo getRoot() { advanceTiming(4000000); return root; }')
      .replace('AccessibilityNodeInfo getRoot(int flags) { return root; }', 'AccessibilityNodeInfo getRoot(int flags) { advanceTiming(4000000); return root; }')
      .replace('if (node != null) scenario.recycled++;', 'if (node != null) { advanceTiming(recycleCost); scenario.recycled++; }');
    const extra = readFileSync(new URL("./fixtures/InspectorSnapshotTimingChecks.java", import.meta.url), "utf8");
    checks = checks.slice(0, checks.lastIndexOf("}")) + extra + "\n}";
    writeFileSync(join(directory, "InspectorObservationDiagnosticsCheck.java"), checks);
    const patched = patchRecognitionHelper(commandPath, commandSource);
    const http = readFileSync(new URL("./fixtures/InspectorSnapshotHttpTimingCheck.java", import.meta.url), "utf8")
      .replace("/* SNAPSHOT_JSON */", readFileSync(new URL("../scripts/helper-templates/InspectorSnapshotJson.java", import.meta.url), "utf8")
        .replace(/^package .*;\n/m, "").replace(/^import .*;\n/gm, "")
        .replace("public final class InspectorSnapshotJson", "static final class InspectorSnapshotJson"))
      .replace("/* SNAPSHOT_TIMINGS */", slice(source, "    public static final class SnapshotTimings {", "    /** Serializes concurrent clients."))
      .replace("/* WORKER */", slice(patched, "    void submit(", "    private void handleClient("))
      .replace("/* ROUTES */", slice(patched, "            // Inspector routes", "            // Route endpoints"))
      .replace("/* SEND */", slice(patched, "    private static void send(", "            if (contentLength"));
    writeFileSync(join(directory, "InspectorSnapshotHttpTimingCheck.java"), http);
    const compiled = spawnSync(java("javac"), ["--release", "8", "-d", directory,
      join(directory, "InspectorObservationDiagnosticsCheck.java"), join(directory, "InspectorSnapshotHttpTimingCheck.java")], { encoding: "utf8", timeout: 15000 });
    assert.equal(compiled.status, 0, compiled.stderr);
    for (const main of ["InspectorObservationDiagnosticsCheck", "InspectorSnapshotHttpTimingCheck"]) {
      const run = spawnSync(java("java"), ["-cp", directory, main], { encoding: "utf8", timeout: 10000 });
      assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /checked/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
