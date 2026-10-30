import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { DebugSession } from "../electron/automation/debug-session";
import type { DebugObserver } from "../electron/automation/device-actions";
import type { HelperConditionWaitHint } from "../shared/helper-condition-wait";
import { helperEvidenceSnapshot, helperFixtureServiceId } from "./fixtures/helper-evidence";

const serial = "helper-fixture", packageName = "com.example.helper";
const target = { packageName, activityName: ".Main", component: `${packageName}/.Main`, windowId: "adb-window", activityRecordId: "activity-1" };
const image = sharp({ create: { width: 100, height: 200, channels: 4, background: "black" } }).png().toBuffer()
  .then(bytes => `data:image/png;base64,${bytes.toString("base64")}`);

function harness(options: { readyInitially?: boolean; uia?: boolean; gate?: "unsupported" | "failure" | "pending" | "cancel"; ambiguous?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "helper-wait-execution-"));
  let ready = !!options.readyInitially, reads = 0, gates = 0, inputs = 0;
  const order: string[] = [];
  const observer: DebugObserver = Object.assign(async () => {
    order.push(`observe:${ready ? "END" : "START"}`);
    const snapshot = helperEvidenceSnapshot({ text: ready ? "END" : "START", startedAt: ++reads * 100 });
    snapshot.screenshotDataUrl = await image;
    if (ready && options.ambiguous) { snapshot.root!.children = [{ ...structuredClone(snapshot.root!), id: "duplicate", children: [] }]; snapshot.nodeCount = 2; }
    if (options.uia) { snapshot.inspectionSource = "uiautomator"; snapshot.helperObservation = undefined; snapshot.hierarchyDumpMode = "full"; }
    return { snapshot, target };
  }, { waitForCondition: async (_serial: string, _package: string, _condition: unknown, signal: AbortSignal): Promise<HelperConditionWaitHint | null> => {
    gates++; order.push("gate");
    if (options.gate === "unsupported") { ready = true; return null; }
    if (options.gate === "failure") throw Error("helper gate malformed");
    if (options.gate === "cancel") session.stop();
    if (options.gate === "pending" || options.gate === "cancel") {
      await new Promise<void>((_resolve, reject) => { const abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) { signal.removeEventListener("abort", abort); abort(); } });
    }
    ready = gates >= 2;
    return { success: true, protocolVersion: 1, sessionId: session.state.id, requestId: randomUUID(), serviceInstanceId: helperFixtureServiceId,
      packageName, windowId: "7", display: { width: 100, height: 200, rotation: 0 }, status: ready ? "ready" : "pending",
      matchCount: ready ? 1 : 0, attempts: 1, startedAtMs: 250, finishedAtMs: 251 };
  } });
  const session = new DebugSession({ serial, packageName, directory, snapshotPath: join(directory, "current.json"), onEvent() {},
    observe: observer, input: async () => { inputs++; } });
  return { session, order, counts: () => ({ reads, gates, inputs }), async run(timeoutMs = 2000) {
    await session.request({ name: "capture_ui", input: { sessionId: session.state.id, mode: "fast", backend: options.uia ? "uiautomator" : "accessibility-helper" } });
    return session.request({ name: "wait_for_ui", input: { sessionId: session.state.id, selector: { text: "END" }, state: "visible", timeoutMs } });
  }, async dispose() { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); } };
}

test("unmet Helper condition uses short hints then two new complete observations", async () => {
  const h = harness();
  try {
    assert.equal((await h.run()).verified, true);
    assert.deepEqual(h.counts(), { reads: 4, gates: 2, inputs: 0 });
    assert.deepEqual(h.order, ["observe:START", "observe:START", "gate", "gate", "observe:END", "observe:END"]);
  } finally { await h.dispose(); }
});

test("already-met Helper and UIAutomator waits incur no device gate", async () => {
  for (const uia of [false, true]) {
    const h = harness({ readyInitially: true, uia });
    try { assert.equal((await h.run()).verified, true); assert.deepEqual(h.counts(), { reads: 3, gates: 0, inputs: 0 }); }
    finally { await h.dispose(); }
  }
});

test("unsupported Helper wait keeps complete polling while malformed hints stop", async () => {
  const legacy = harness({ gate: "unsupported" });
  try { assert.equal((await legacy.run()).verified, true); assert.deepEqual(legacy.counts(), { reads: 4, gates: 1, inputs: 0 }); }
  finally { await legacy.dispose(); }
  const failed = harness({ gate: "failure" });
  try { assert.equal((await failed.run()).isError, true); assert.deepEqual(failed.counts(), { reads: 2, gates: 1, inputs: 0 }); }
  finally { await failed.dispose(); }
});

test("device readiness does not bypass strict unique final conditions", async () => {
  const h = harness({ ambiguous: true });
  try { assert.equal((await h.run()).isError, true); assert.deepEqual(h.counts(), { reads: 4, gates: 2, inputs: 0 }); }
  finally { await h.dispose(); }
});

test("pending and cancelled gates end with the existing step deadline and never dispatch input", async () => {
  for (const gate of ["pending", "cancel"] as const) {
    const h = harness({ gate });
    try { assert.equal((await h.run(1000)).isError, true); assert.deepEqual(h.counts(), { reads: 2, gates: 1, inputs: 0 }); }
    finally { await h.dispose(); }
  }
});
