import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("production Android input keeps once-only queue gates and uniquely refreshed semantic click/scroll targets without fallback", { timeout: 45000 }, context => {
  const java = (name: string) => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", name) : name;
  const compiler = spawnSync(java("javac"), ["-version"], { encoding: "utf8", timeout: 5000 });
  if (!process.env.JAVA_HOME && ((compiler.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    || /Unable to locate a Java Runtime|No Java runtime present/i.test(compiler.stderr ?? ""))) {
    context.skip("JDK unavailable; install JDK 17 for Android input control-flow checks."); return;
  }
  assert.equal(compiler.status, 0, compiler.stderr || compiler.error?.message);
  const observation = readFileSync(new URL("../scripts/helper-templates/InspectorObservation.java", import.meta.url), "utf8");
  const part = (start: string, end: string) => {
    const first = observation.indexOf(start), last = observation.indexOf(end, first);
    assert.ok(first > 0 && last > first); return observation.slice(first, last);
  };
  const methods = [observation.match(/private static final ReentrantLock READS =[^;]*;/)?.[0],
    observation.match(/private static InputCapture inputCapture;/)?.[0],
    observation.match(/private static final int CHILD_PREFETCH_FLAGS =[\s\S]*?;/)?.[0],
    part("    private static final class WaitFailure", "    private static final class Capture {"),
    part("    private static final class Capture {", "    private static final class Screenshot {"),
    observation.slice(observation.indexOf("    private static Rect intersection("), observation.lastIndexOf("}"))].join("\n");
  const parent = readFileSync(new URL("./fixtures/InspectorObservationDiagnosticsCheck.java", import.meta.url), "utf8")
    .replace("/* PRODUCTION_METHODS */", methods);
  const input = readFileSync(new URL("../scripts/helper-templates/InspectorInput.java", import.meta.url), "utf8");
  const body = input.slice(input.indexOf("public final class InspectorInput")).replace("public final class InspectorInput", "static final class InspectorInput");
  const fixture = readFileSync(new URL("./fixtures/InspectorInputCheck.java", import.meta.url), "utf8").replace("/* PRODUCTION_INPUT */", body);
  const directory = mkdtempSync(join(tmpdir(), "helper-input-android-"));
  try {
    const files = [join(directory, "InspectorObservationDiagnosticsCheck.java"), join(directory, "InspectorInputCheck.java")];
    writeFileSync(files[0], parent); writeFileSync(files[1], fixture);
    const compiled = spawnSync(java("javac"), ["--release", "8", "-d", directory, ...files], { encoding: "utf8", timeout: 10000 });
    assert.equal(compiled.status, 0, compiled.stderr);
    const run = spawnSync(java("java"), ["-cp", directory, "InspectorInputCheck"], { encoding: "utf8", timeout: 30000 });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Guarded input: tap\/swipe\/back, strict identity, once-only captures, bounded ledger, queue race, false, callbacks and late timeouts checked/);
    assert.match(run.stdout, /semantic targets and directional scroll actions uniquely refreshed without fallback/);
    assert.match(run.stdout, /Description-only taps: exact empty resource ID, nonblank unmodified description\/class\/bounds, unique refreshed tuple and once-only unknown outcomes checked/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
