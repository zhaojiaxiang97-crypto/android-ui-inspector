import assert from "node:assert/strict";
import { test } from "node:test";
import { startFinalScreenAfterPreview } from "../electron/capture/debug-image-handoff";
import { commandSignal } from "../electron/device/command-context";

test("preview cancellation preserves reason and does not dispatch a final screenshot", async () => {
  const controller = new AbortController(), reason = new Error("preview cancelled");
  let calls = 0;
  await assert.rejects(startFinalScreenAfterPreview(async () => controller.abort(reason), controller.signal,
    async () => { calls++; }, 1000), error => error === reason);
  assert.equal(calls, 0);
});

test("parallel final screenshot observes failure immediately without swallowing awaited cancellation", async () => {
  const controller = new AbortController(), reason = new Error("later cancelled");
  let reject!: (error: Error) => void;
  const screenshot = new Promise((_, fail) => { reject = fail; });
  const { finalScreen } = await startFinalScreenAfterPreview(async () => {}, controller.signal, () => screenshot, 1000);
  const checked = assert.rejects(finalScreen, error => error === reason);
  controller.abort(reason); reject(reason);
  await checked;
});

test("final-screen child deadline keeps caller cancellation and ordinary screenshot failure stays optional", async () => {
  const controller = new AbortController(), reason = new Error("cancel during screenshot");
  let child: AbortSignal | undefined;
  const { finalScreen } = await startFinalScreenAfterPreview(undefined, controller.signal, async () => {
    child = commandSignal(); assert.ok(child); assert.notEqual(child, controller.signal);
    throw new Error("optional screenshot failed");
  }, 1000);
  assert.equal(await finalScreen, null);
  controller.abort(reason); assert.equal(child!.reason, reason);
  assert.equal(commandSignal(), undefined);
});
