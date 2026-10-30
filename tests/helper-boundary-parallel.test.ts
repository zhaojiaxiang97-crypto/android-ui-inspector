import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const scenarios = ["success", "before-target-slow-frame", "before-both-fail", "before-cancel",
  "after-target-slow-frame", "after-frame-failure", "after-cancel"];
for (const mode of ["wait", "observe"]) for (const scenario of scenarios) {
  test(`Helper ${mode} boundary joins target and geometry: ${scenario}`, () => {
    const result = JSON.parse(execFileSync(process.execPath,
      [fileURLToPath(new URL("./fixtures/helper-boundary-parallel.mjs", import.meta.url)), mode, scenario],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), timeout: 5000, encoding: "utf8" }));
    assert.equal(result.inputs, 0);
    assert.equal(result.success, scenario === "success");
    assert.equal(result.targets, scenario.startsWith("before-") ? 1 : 2);
    assert.equal(result.frames, result.targets);
  });
}
