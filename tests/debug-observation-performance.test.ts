import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

function observe(scenario: string) {
  const result = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("./fixtures/debug-observation-performance.mjs", import.meta.url)), scenario],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), timeout: 5000, encoding: "utf8" }));
  assert.equal(result.cleaned, 1); assert.equal(result.screenFinished, true); assert.equal(result.inputCalls, 0);
  return result;
}

test("fresh hierarchy and screenshot run concurrently and are joined before the final target check", () => {
  const result = observe("success");
  assert.equal(result.error, undefined); assert.equal(result.targets, 2); assert.equal(result.nodeCount, 1);
});

test("visual confirmation captures pixels after the hierarchy, bracketed by fresh window checks", () => {
  const result = observe("ordered");
  assert.equal(result.error, undefined); assert.equal(result.targets, 2); assert.equal(result.nodeCount, 1);
});

test("only missing hierarchy and changed windows receive recoverable error codes", () => {
  for (const scenario of ["empty-tree", "missing-tree", "window"]) {
    const result = observe(scenario);
    assert.equal(result.errorCode, scenario === "window" ? "window_changed" : "hierarchy_unavailable");
    assert.equal(result.nodeCount, undefined);
  }
});

test("hard screenshot and geometry errors take precedence over transient hierarchy or window errors", () => {
  for (const scenario of ["empty-screen-rejected", "empty-screen-null", "empty-screen-geometry", "geometry-window"]) {
    const result = observe(scenario);
    assert.ok(result.error); assert.equal(result.errorCode, undefined); assert.equal(result.nodeCount, undefined);
    assert.match(result.error, /截图|屏幕/);
  }
});

test("cancellation, offline, oversized and foreign observations remain hard failures", () => {
  for (const scenario of ["cancel", "offline", "oversized", "foreign-tree", "foreign-target"]) {
    const result = observe(scenario);
    assert.ok(result.error); assert.equal(result.errorCode, undefined); assert.equal(result.nodeCount, undefined);
  }
});
