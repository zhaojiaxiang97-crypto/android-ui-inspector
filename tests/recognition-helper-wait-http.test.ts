import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { patchRecognitionHelper } from "../scripts/prepare-recognition-helper";

test("generated wait HTTP body reader preserves Chinese bytes and rejects truncated or invalid UTF-8", { timeout: 20000 }, context => {
  const java = (name: string) => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", name) : name;
  const compiler = spawnSync(java("javac"), ["-version"], { encoding: "utf8", timeout: 5000 });
  if (!process.env.JAVA_HOME && ((compiler.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    || /Unable to locate a Java Runtime|No Java runtime present/i.test(compiler.stderr ?? ""))) {
    context.skip("JDK unavailable; install JDK 17 to execute the Helper HTTP body regression.");
    return;
  }
  assert.equal(compiler.status, 0, compiler.stderr || compiler.error?.message);
  const source = '            if (contentLength < 0 || contentLength > MAX_BODY) {\n}\n' +
    '                body = new String(readExactly(in, contentLength), StandardCharsets.UTF_8);\n' +
    '            // Route endpoints\n            if (path.equals("/snapshot")) {';
  const patched = patchRecognitionHelper("app/src/main/java/com/artemis/helper/CommandServer.java", source);
  const start = patched.indexOf("                byte[] bodyBytes ="), endMarker = "} else body = new String(bodyBytes, StandardCharsets.UTF_8);";
  const end = patched.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start);
  const body = patched.slice(start, end + endMarker.length);
  const fixture = readFileSync(new URL("./fixtures/InspectorWaitHttpBodyCheck.java", import.meta.url), "utf8");
  const directory = mkdtempSync(join(tmpdir(), "helper-wait-http-"));
  try {
    const file = join(directory, "InspectorWaitHttpBodyCheck.java");
    writeFileSync(file, fixture.replace("/* PRODUCTION_BODY */", body));
    const compiled = spawnSync(java("javac"), ["--release", "8", "-d", directory, file], { encoding: "utf8", timeout: 10000 });
    assert.equal(compiled.status, 0, compiled.stderr);
    const run = spawnSync(java("java"), ["-cp", directory, "InspectorWaitHttpBodyCheck"], { encoding: "utf8", timeout: 5000 });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Chinese UTF-8 body preserved; short and malformed wait bodies rejected; upstream decoding unchanged/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
