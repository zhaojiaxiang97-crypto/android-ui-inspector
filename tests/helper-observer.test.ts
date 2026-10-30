import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

function observe(scenario: string) {
  return JSON.parse(execFileSync(process.execPath, [resolve("tests/fixtures/helper-observer-entry.ts")],
    { env: { ...process.env, HELPER_OBSERVER_CASE: scenario }, encoding: "utf8", timeout: 15_000 }));
}
test("production v1 observer uses ordered Helper PNG without ADB screenshot or repeated forward handshake", () => {
  const r = observe("success");
  assert.equal(r.error, undefined); assert.equal(r.source, "accessibility-helper"); assert.equal(r.captures, 2); assert.equal(r.newCapture, true);
  assert.deepEqual(r.requests, ["/inspector/capabilities", "/inspector/snapshot", "/inspector/snapshot"]);
  assert.equal(r.commands.filter((a: string[]) => a.includes("--no-rebind")).length, 1); assert.equal(r.mapping, null);
  assert.equal(r.commands.filter((a: string[]) => a.join(" ") === "shell dumpsys input").length, 4);
  assert.ok(!r.commands.some((a: string[]) => ["screencap", "uiautomator", "install", "broadcast"].some(command => a.includes(command)) || a[0] === "shell" && a[1] === "input"));
});
for (const scenario of ["geometry-changed", "activity-changed"]) test(`production v1 observer rejects ${scenario} and releases its forward`, () => {
  const r = observe(scenario);
  assert.match(r.error, /发生变化/); assert.equal(r.source, undefined); assert.equal(r.mapping, null);
  assert.equal(r.commands.filter((a: string[]) => a.includes("--remove")).length, 1);
});
