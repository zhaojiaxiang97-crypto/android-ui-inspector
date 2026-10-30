import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("Helper diagnoses actual window, traversal and snapshot failures without exposing private data", { timeout: 30000 }, context => {
  const java = (name: string) => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", name) : name;
  const compiler = spawnSync(java("javac"), ["-version"], { encoding: "utf8", timeout: 5000 });
  if (!process.env.JAVA_HOME && ((compiler.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    || /Unable to locate a Java Runtime|No Java runtime present/i.test(compiler.stderr ?? ""))) {
    context.skip("JDK unavailable; install JDK 17 to execute the Helper diagnostic regression.");
    return;
  }
  assert.equal(compiler.status, 0, compiler.stderr || compiler.error?.message);
  const source = readFileSync(new URL("../scripts/helper-templates/InspectorObservation.java", import.meta.url), "utf8");
  const part = (start: string, end: string) => {
    const first = source.indexOf(start), last = source.indexOf(end, first);
    assert.ok(first > 0 && last > first, `Missing template section: ${start}`);
    return source.slice(first, last);
  };
  // Execute the production methods against fault-injectable platform adapters.
  // This checks classifications/control flow, not Android's Binder behavior.
  const methods = [
    source.match(/private static final int CHILD_PREFETCH_FLAGS =[\s\S]*?;/)?.[0],
    part("    private static final class Capture {", "    private static final class Screenshot {"),
    source.slice(source.indexOf("    private static Rect intersection("), source.lastIndexOf("}")),
  ].join("\n");
  const fixture = readFileSync(new URL("./fixtures/InspectorObservationDiagnosticsCheck.java", import.meta.url), "utf8");
  assert.equal(fixture.split("/* PRODUCTION_METHODS */").length, 2);
  const directory = mkdtempSync(join(tmpdir(), "helper-diagnostics-"));
  try {
    const file = join(directory, "InspectorObservationDiagnosticsCheck.java");
    writeFileSync(file, fixture.replace("/* PRODUCTION_METHODS */", methods));
    const compiled = spawnSync(java("javac"), ["--release", "8", "-d", directory, file], { encoding: "utf8", timeout: 10000 });
    assert.equal(compiled.status, 0, compiled.stderr);
    const run = spawnSync(java("java"), ["-cp", directory, "InspectorObservationDiagnosticsCheck"], { encoding: "utf8", timeout: 15000 });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /19 diagnostic codes checked; complete trees preserved; private errors excluded/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
