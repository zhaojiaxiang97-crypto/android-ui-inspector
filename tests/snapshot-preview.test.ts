import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createSnapshotPreview } from "../electron/capture/snapshot-preview";
import { commandSignal } from "../electron/device/command-context";
import type { UiSnapshot } from "../shared/types";
import { makeNode } from "../benchmarks/fixtures";

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const frame = { width: 100, height: 200, rotation: 0 as const };
const screen = { screenshotDataUrl: "checked-preview", captureGeometry: {
  hierarchyRotation: 0 as const, beforeScreenshot: frame, afterScreenshot: frame, screenshotSize: frame,
} };
type Options = Parameters<typeof createSnapshotPreview>[0];
function fixture(overrides: Partial<Options> = {}) {
  const controller = new AbortController(), events: { phase: string; snapshot: UiSnapshot }[] = [];
  const root = makeNode("root");
  const timings: Record<string, number> = {};
  const owner = createSnapshotPreview({ signal: controller.signal, progressive: true, screenTimeoutMs: 1000,
    readScreen: async () => screen, verifyForeground: async () => true,
    snapshot: value => ({ serial: "fixture", root, nodeCount: 1, xmlSize: 0, rawXml: null,
      screenshotDataUrl: value?.screenshotDataUrl ?? null, captureGeometry: value?.captureGeometry, error: null, warning: null }),
    publish: (phase, snapshot) => { events.push({ phase, snapshot }); }, timings,
    beforeBlockingScreen: () => assert.fail("standard preview must not start a blocking screen stage"), ...overrides,
  });
  return { ...owner, controller, events, root, timings };
}

test("slow screenshot does not block tree or layers, then arrives as a screen-only preview", async () => {
  const pending = deferred<typeof screen>(); let reads = 0;
  const h = fixture({ readScreen: () => { reads++; return pending.promise; } });
  void h.preview.beginTreeScreen!();
  await h.preview("tree"); await h.preview("layers");
  assert.deepEqual(h.events.map(e => e.phase), ["tree", "layers"]);
  assert.equal(h.events[0].snapshot.screenshotDataUrl, null);
  pending.resolve(screen); await setImmediate();
  assert.deepEqual(h.events.map(e => e.phase), ["tree", "layers", "screen"]);
  assert.equal(h.events[2].snapshot.screenshotDataUrl, screen.screenshotDataUrl);
  assert.equal(reads, 1); assert.equal(h.events[2].snapshot.root, h.root);
  await h.close();
});

test("early screenshot is carried by the first tree without a duplicate screen event", async () => {
  let checks = 0;
  const h = fixture({ verifyForeground: async () => { checks++; return true; } });
  await h.preview.beginTreeScreen!();
  assert.equal(h.events.length, 0);
  await h.preview("tree"); await setImmediate();
  assert.deepEqual(h.events.map(e => e.phase), ["tree"]);
  assert.equal(h.events[0].snapshot.screenshotDataUrl, screen.screenshotDataUrl);
  assert.equal(checks, 1); await h.close();
});

for (const geometry of [undefined, { ...screen.captureGeometry, afterScreenshot: { ...frame, rotation: 1 as const } }]) {
  test(`unverified or rotated screenshot never becomes a preview: ${Boolean(geometry)}`, async () => {
    const pending = deferred<Pick<UiSnapshot, "screenshotDataUrl" | "captureGeometry">>();
    const h = fixture({ readScreen: () => pending.promise });
    await h.preview("tree"); pending.resolve({ ...screen, captureGeometry: geometry }); await setImmediate();
    assert.deepEqual(h.events.map(e => e.phase), ["tree"]);
    assert.equal(h.events[0].snapshot.screenshotDataUrl, null); await h.close();
  });
}

test("foreground change while screenshot is pending suppresses the late pixels", async () => {
  const pending = deferred<typeof screen>(); let same = true;
  const h = fixture({ readScreen: () => pending.promise, verifyForeground: async () => same });
  await h.preview("tree"); same = false; pending.resolve(screen); await setImmediate();
  assert.deepEqual(h.events.map(e => e.phase), ["tree"]); await h.close();
});

test("cancellation stops and drains the pending screenshot, preserving the caller's reason", async () => {
  let child: AbortSignal | undefined, settled = false;
  const h = fixture({ readScreen: () => new Promise((_, reject) => {
    child = commandSignal(); assert.ok(child);
    child.addEventListener("abort", () => { settled = true; reject(child!.reason); }, { once: true });
  }) });
  await h.preview("tree");
  const reason = new Error("user cancelled"); h.controller.abort(reason);
  await h.close(); assert.equal(settled, true); assert.equal(child!.reason, reason);
  await assert.rejects(Promise.resolve(h.preview("layers")), error => error === reason);
  assert.deepEqual(h.events.map(e => e.phase), ["tree"]);
});

test("closing an attempt drains a late foreground check without publishing after the final result", async () => {
  const pending = deferred<typeof screen>(), entered = deferred(), release = deferred<boolean>(); let checks = 0;
  const h = fixture({ readScreen: () => pending.promise, verifyForeground: async () => {
    if (++checks === 1) return true;
    entered.resolve(); return release.promise;
  } });
  await h.preview("tree"); pending.resolve(screen); await entered.promise;
  let closed = false; const closing = h.close().then(() => { closed = true; });
  await setImmediate(); assert.equal(closed, false);
  release.resolve(true); await closing;
  await h.preview("layers"); assert.deepEqual(h.events.map(e => e.phase), ["tree"]);
});

test("optional screenshot failure keeps tree and image delivery usable", async () => {
  const h = fixture({ readScreen: async () => { throw new Error("screen timeout"); } });
  await h.preview("tree"); await h.preview("layers"); await h.close();
  assert.deepEqual(h.events.map(e => e.phase), ["tree", "layers"]);
  assert.ok(Number.isFinite(h.timings["首屏截图"]));
});

test("enhanced capture retains its existing screenshot-before-tree handoff", async () => {
  const pending = deferred<typeof screen>(); let blocking = 0;
  const h = fixture({ progressive: false, readScreen: () => pending.promise, beforeBlockingScreen: () => { blocking++; } });
  const tree = h.preview("tree"); await setImmediate(); assert.equal(h.events.length, 0);
  pending.resolve(screen); await tree; await h.close();
  assert.equal(blocking, 1); assert.deepEqual(h.events.map(e => e.phase), ["tree"]);
  assert.equal(h.events[0].snapshot.screenshotDataUrl, screen.screenshotDataUrl);
});
