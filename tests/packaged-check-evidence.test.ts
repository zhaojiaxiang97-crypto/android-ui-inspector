import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { createPackage } from "@electron/asar";

const evidence = createRequire(import.meta.url)("../scripts/lib/packaged-check-evidence.cjs");
const directory = mkdtempSync(join(tmpdir(), "packaged-evidence-tests-"));
test("packaged checks require explicit resources/candidate and reject unknown or duplicate arguments", () => {
  const args = [directory, "--candidate=local-test"];
  assert.deepEqual(evidence.parseArgs(args), { resources: directory, candidate: "local-test" });
  assert.deepEqual(evidence.parseArgs([`--app-resources=${directory}`, args[1]]), evidence.parseArgs(args));
  for (const values of [[], [directory], ["--candidate=test"], [...args, "--candidate=other"], [...args, "--extra"],
    [...args, directory], [directory, "--candidate=../private"], ["--app-resources=", "--candidate=test"]])
    assert.throws(() => evidence.parseArgs(values));
});
test("unique evidence preserves prior reports and refuses to replace a result", () => {
  const old = join(directory, "result.json"); writeFileSync(old, "prior-report");
  const a = evidence.createEvidence(directory, { candidate: "same" }), b = evidence.createEvidence(directory, { candidate: "same" });
  assert.notEqual(a, b);
  evidence.writeResult(a, { passed: false, error: "synthetic failure" });
  evidence.writeResult(b, { passed: true });
  assert.throws(() => evidence.writeResult(a, { passed: true }), /EEXIST/);
  assert.equal(readFileSync(old, "utf8"), "prior-report");
  assert.equal(JSON.parse(readFileSync(join(a, "result.json"), "utf8")).passed, false);
  assert.equal(JSON.parse(readFileSync(join(b, "result.json"), "utf8")).passed, true);
});
test("candidate identities include actual assets, external tools/native modules and detect changed bytes", async () => {
  const base = mkdtempSync(join(directory, "package-")), resources = join(base, "resources"), source = join(base, "source");
  mkdirSync(resources);
  const files: Record<string, string> = { "package.json": '{"version":"1"}', "dist/index.html": "<html/>",
    "dist/assets/app.js": "production renderer", "dist/assets/app.css": "production styles",
    "dist-electron/main.cjs": "main", "dist-electron/preload.cjs": "preload", "dist-electron/webp-alpha-worker.cjs": "worker" };
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(source, name, ".."), { recursive: true }); writeFileSync(join(source, name), content);
  }
  await createPackage(source, join(resources, "app.asar"));
  for (const [name, content] of Object.entries({ "cli/android-ui.cjs": "cli", "mcp/server.cjs": "mcp",
    "app.asar.unpacked/node_modules/sharp/lib/sharp.node": "native" })) {
    mkdirSync(join(resources, name, ".."), { recursive: true }); writeFileSync(join(resources, name), content);
  }
  writeFileSync(join(source, "dist-electron/cli.cjs"), "cli"); writeFileSync(join(source, "dist-electron/mcp.cjs"), "mcp");
  const identity = evidence.resourceIdentity(resources);
  assert.equal(identity.version, "1"); assert.equal(Object.keys(identity.files).length, 10);
  assert.equal(evidence.verifyBuildMatches(identity, source).length, 8);
  assert.deepEqual(evidence.verifyUnchanged(identity, resources), identity);
  writeFileSync(join(resources, "cli/android-ui.cjs"), "changed");
  assert.throws(() => evidence.verifyUnchanged(identity, resources), /changed during/);
  assert.throws(() => evidence.verifyBuildMatches(evidence.resourceIdentity(resources), source), /frozen build/);
});
test("a missing candidate fails with a fresh failure report instead of overwriting old evidence", () => {
  try {
    execFileSync("bun", ["scripts/packaged-readonly-check.ts", join(directory, "does-not-exist"), "--candidate=missing-test"],
      { timeout: 10000, encoding: "utf8" });
    assert.fail("Missing candidate must fail");
  } catch (error) {
    const output = JSON.parse((error as { stdout: string }).stdout);
    assert.equal(output.passed, false); assert.equal(output.phoneOperations, 0); assert.ok(output.error);
    assert.equal(existsSync(join(output.output, "started.json")), true);
    assert.equal(JSON.parse(readFileSync(join(output.output, "result.json"), "utf8")).passed, false);
  }
});
test("candidate handoff uses package HTML with test-only bridge, not another App bundle or relaxed product gate", () => {
  const main = readFileSync(new URL("../scripts/packaged-handoff-checks.cjs", import.meta.url), "utf8");
  const entry = readFileSync(new URL("../benchmarks/diagnosis-handoff-packaged-entry.ts", import.meta.url), "utf8");
  const entryChecks = readFileSync(new URL("../benchmarks/workbench-entry-verification.ts", import.meta.url), "utf8");
  const preload = readFileSync(new URL("../scripts/packaged-handoff-preload.cjs", import.meta.url), "utf8");
  assert.match(main, /window\.loadFile\(join\(candidateDist, "index.html"\)\)/);
  assert.match(main, /sandbox: true, contextIsolation: true, nodeIntegration: false/);
  assert.match(main, /callback\(\{ cancel: !allowed \}\)/);
  assert.doesNotMatch(main + entry + entryChecks + preload, /import App|react-dom|require\(.*main\.cjs|child_process.*adb/);
  assert.doesNotMatch(preload, /readFile|spawn|require\("\.\./);
});
test("report error selection is scoped to the report alert, independent of the live diagnosis section", () => {
  const harness = readFileSync(new URL("../scripts/test-report-checks.cjs", import.meta.url), "utf8");
  assert.match(harness, /\.test-report-dialog > \.test-report-error\[role=alert\]/);
  assert.doesNotMatch(harness, /\.test-report-header \+ \[role=alert\]/);
});
