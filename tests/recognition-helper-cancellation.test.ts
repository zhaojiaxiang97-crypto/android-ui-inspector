import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { patchRecognitionHelper } from "../scripts/prepare-recognition-helper";
import { commandTimingSource } from "./fixtures/helper-command-timing-source";

test("client disconnect preserves device read work: tree/PNG hold the lock; JSON/write do not", { timeout: 30000 }, context => {
  const java = (name: string) => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", name) : name;
  const compiler = spawnSync(java("javac"), ["-version"], { encoding: "utf8", timeout: 5000 });
  if (!process.env.JAVA_HOME && ((compiler.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    || /Unable to locate a Java Runtime|No Java runtime present/i.test(compiler.stderr ?? ""))) {
    context.skip("JDK unavailable; install JDK 17 to execute the cancellation regression."); return;
  }
  assert.equal(compiler.status, 0, compiler.stderr || compiler.error?.message);
  const source = readFileSync(new URL("../scripts/helper-templates/InspectorObservation.java", import.meta.url), "utf8");
  const slice = (text: string, first: string, last: string) => {
    const start = text.indexOf(first), end = text.indexOf(last, start);
    assert(start >= 0 && end > start, `missing production seam ${first}`); return text.slice(start, end);
  };
  const replace = (text: string, from: string, to: string) => {
    assert.equal(text.split(from).length, 2, `non-unique test adapter seam ${from}`); return text.replace(from, to);
  };
  const methods = [source.match(/private static final ReentrantLock READS =[^;]*;/)?.[0],
    source.match(/private static InputCapture inputCapture;/)?.[0],
    source.match(/private static final int CHILD_PREFETCH_FLAGS =[\s\S]*?;/)?.[0],
    slice(source, "    private static final class WaitFailure", "    private static final class Capture {"),
    slice(source, "    private static final class Capture {", "    private static final class Screenshot {"),
    source.slice(source.indexOf("    private static Rect intersection("), source.lastIndexOf("}"))].join("\n");
  let parent = readFileSync(new URL("./fixtures/InspectorObservationDiagnosticsCheck.java", import.meta.url), "utf8");
  parent = replace(parent, "/* PRODUCTION_METHODS */", "static Runnable treeHook, pngHook;\n" + methods);
  parent = replace(parent, "AccessibilityNodeInfo getChild(int index) { if (childFailure)",
    "AccessibilityNodeInfo getChild(int index) { if (treeHook != null) treeHook.run(); if (childFailure)");
  parent = replace(parent, "static byte[] encode(Bitmap bitmap) { if (scenario.encoderThrows)",
    "static byte[] encode(Bitmap bitmap) { if (pngHook != null) pngHook.run(); if (scenario.encoderThrows)");
  const command = commandTimingSource + '            if (contentLength < 0 || contentLength > MAX_BODY) {\n}\n' +
    '                body = new String(readExactly(in, contentLength), StandardCharsets.UTF_8);\n' +
    '            // Route endpoints\n            if (path.equals("/snapshot")) {';
  const patched = patchRecognitionHelper("app/src/main/java/com/artemis/helper/CommandServer.java", command);
  let route = slice(patched, "                    InspectorObservation.SnapshotTimings timings", "                }\n                return;");
  route = replace(route, "InspectorSnapshotJson::stringify", "jsonValue -> { checkpoint(\"json\"); return jsonValue.toString(); }");
  route = replace(route, "finally { timings.finishObservation(); }", "finally { timings.finishObservation(); }\n                    if (id == 1) snapshotReturnedNs = System.nanoTime();\n                    responses.put(id, json);");
  route = route.split("InspectorObservation.").join("InspectorObservationDiagnosticsCheck.");
  let fixture = readFileSync(new URL("./fixtures/InspectorSnapshotCancellationCheck.java", import.meta.url), "utf8");
  fixture = replace(fixture, "/* PRODUCTION_SNAPSHOT_ROUTE */", route);
  fixture = replace(fixture, "/* PRODUCTION_SEND */", slice(patched, "    private static void send(", "            if (contentLength"));
  const dir = mkdtempSync(join(tmpdir(), "helper-cancel-"));
  try {
    const files = [join(dir, "InspectorObservationDiagnosticsCheck.java"), join(dir, "InspectorSnapshotCancellationCheck.java")];
    writeFileSync(files[0], parent); writeFileSync(files[1], fixture);
    const built = spawnSync(java("javac"), ["--release", "8", "-d", dir, ...files], { encoding: "utf8", timeout: 12000 });
    assert.equal(built.status, 0, built.stderr);
    // Optional test artifacts let the same compiled fixture run on Android ART without changing the installed Helper.
    if (process.env.HELPER_CANCELLATION_ARTIFACT_DIR) cpSync(dir, process.env.HELPER_CANCELLATION_ARTIFACT_DIR, { recursive: true, errorOnExist: true, force: false });
    for (const phase of ["tree", "png", "json", "write"]) {
      const run = spawnSync(java("java"), ["-cp", dir, "InspectorSnapshotCancellationCheck", phase], { encoding: "utf8", timeout: 5000 });
      assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, new RegExp(`checked phase=${phase} .* inputs=0 freshRead=true`));
      console.log(run.stdout.trim());
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
