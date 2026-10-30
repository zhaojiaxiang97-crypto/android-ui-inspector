import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

for (const scenario of ["no-id", "id-priority", "no-desc", "invalid-id", "long-id", "missing-raw", "invalid-class",
  "bad-bounds", "long-desc", "no-id-scroll", "failed", "target-change", "display-change", "cancelled", "swipe-id", "swipe-desc", "swipe-invalid-id"]) {
  test(`real Helper input target selection: ${scenario}`, () => {
    const result = JSON.parse(execFileSync(process.execPath,
      [fileURLToPath(new URL("./fixtures/helper-input-target.mjs", import.meta.url)), scenario],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), timeout: 5000, encoding: "utf8" }));
    assert.equal(result.deviceCommands, 0);
    assert.equal(result.helperCalls, ["no-id", "id-priority", "no-desc", "failed", "swipe-id", "swipe-desc", "swipe-invalid-id"].includes(scenario) ? 1 : 0);
    assert.equal(result.dispatchState, scenario === "failed" ? "unknown"
      : ["no-id", "id-priority", "no-desc", "swipe-id", "swipe-desc", "swipe-invalid-id"].includes(scenario) ? "sent" : "not_sent");
  });
}
