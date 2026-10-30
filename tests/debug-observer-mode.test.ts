import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

function observe(scenario: string) {
  return JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("./fixtures/debug-observer-mode.mjs", import.meta.url)), scenario],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), timeout: 10_000, encoding: "utf8" }));
}

test("deep automation defaults to standard and only inherits explicit trusted enhancement", () => {
  for (const scenario of ["default", "standard", "enhanced"]) {
    const result = observe(scenario);
    assert.equal(result.error, undefined); assert.equal(result.captureMode, "deep");
    assert.deepEqual(result.calls, [{ inspectionMode: scenario === "enhanced" ? "sdk-enhanced" : "standard" }]);
    assert.equal(result.targets, 2, "changing backend policy must retain before/after target checks");
  }
});

test("deep policy forwarding preserves capture failure, cancellation and window-change rejection", () => {
  for (const scenario of ["thrown-error", "reported-error", "cancelled", "window-changed"]) {
    const result = observe(scenario);
    assert.equal(result.captureMode, undefined);
    assert.match(result.error, scenario === "window-changed" ? /窗口发生变化/ : /capture fixture failure/);
    assert.deepEqual(result.calls, [{ inspectionMode: "standard" }]);
    if (scenario === "thrown-error" || scenario === "cancelled") assert.equal(result.sourceErrorPreserved, true);
  }
});
