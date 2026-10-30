import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

// Execute the production preview/final-screen boundary with isolated dependencies.
const source = readFileSync(new URL("../electron/capture/debug-images.ts", import.meta.url), "utf8");
const start = source.indexOf('    await preview?.("layers");', source.indexOf('const matchStarted = performance.now();'));
const end = source.indexOf("    const fallback: UiNode[] = [];", start);
assert.ok(start > 0 && end > start);
const body = ts.transpileModule(`async function boundary() {${source.slice(start, end)} return finalScreen; }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const create = new Function("preview", "inspectionContext", "captureSignal", "FINAL_SCREEN_TIMEOUT_MS", "captureScreen", "adbPath", "serial",
  `${body}; return boundary;`);

test("preview cancellation preserves reason and does not dispatch a final screenshot", async () => {
  const controller = new AbortController(), reason = new Error("preview cancelled");
  let calls = 0;
  const context = { getStore: () => ({ signal: controller.signal }), run: (_: unknown, fn: () => unknown) => fn() };
  const boundary = create(async () => controller.abort(reason), context, (signal: AbortSignal) => signal, 1000,
    async () => { calls++; }, "adb", "fixture");
  await assert.rejects(boundary(), error => error === reason);
  assert.equal(calls, 0);
});

test("parallel final screenshot observes failure immediately without swallowing awaited cancellation", async () => {
  const controller = new AbortController(), reason = new Error("later cancelled");
  let reject!: (error: Error) => void;
  const screenshot = new Promise((_, fail) => { reject = fail; });
  const context = { getStore: () => ({ signal: controller.signal }), run: (_: unknown, fn: () => unknown) => fn() };
  const boundary = create(async () => {}, context, (signal: AbortSignal) => signal, 1000,
    () => screenshot, "adb", "fixture");
  const result = boundary();
  const checked = assert.rejects(result, error => error === reason);
  await Promise.resolve(); controller.abort(reason); reject(reason);
  await checked;
});
