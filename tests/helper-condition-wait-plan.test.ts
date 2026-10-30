import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { DebugSession } from "../electron/automation/debug-session";
import type { DebugObserver } from "../electron/automation/device-actions";
import type { DebugPlanRun } from "../shared/debug-plan";
import { helperEvidenceSnapshot, helperFixtureServiceId } from "./fixtures/helper-evidence";

const serial = "helper-fixture", packageName = "com.example.helper";
const target = { packageName, activityName: ".Main", component: `${packageName}/.Main`, windowId: "adb-window", activityRecordId: "activity-1" };
const image = sharp({ create: { width: 100, height: 200, channels: 4, background: "black" } }).png().toBuffer()
  .then(bytes => `data:image/png;base64,${bytes.toString("base64")}`);
const condition = (text: string) => ({ selector: { text }, state: "visible" });

function harness(failGate = false) {
  const directory = mkdtempSync(join(tmpdir(), "helper-wait-plan-"));
  let inputs = 0, gates = 0, reads = 0, ready = false;
  const order: string[] = [];
  const observer: DebugObserver = Object.assign(async () => {
    const text = ready ? "暂停" : inputs ? "加载中" : "播放";
    order.push(`observe:${text}`);
    const snapshot = helperEvidenceSnapshot({ text, startedAt: ++reads * 100 });
    snapshot.screenshotDataUrl = await image;
    return { snapshot, target };
  }, { waitForCondition: async () => {
    order.push("gate"); gates++;
    if (failGate) throw Error("Helper condition read failed");
    ready = gates >= 2;
    return { success: true as const, protocolVersion: 1 as const, sessionId: session.state.id, requestId: randomUUID(),
      serviceInstanceId: helperFixtureServiceId, packageName, windowId: "7", display: { width: 100, height: 200, rotation: 0 },
      status: ready ? "ready" as const : "pending" as const, matchCount: ready ? 1 : 0,
      attempts: 1, startedAtMs: reads * 100 + 6, finishedAtMs: reads * 100 + 7 };
  } });
  const session = new DebugSession({ serial, packageName, directory, snapshotPath: join(directory, "current.json"), onEvent() {},
    observe: observer, input: async (_s, _t, _a, _f, _signal, onEvidence) => {
      inputs++; order.push("input"); onEvidence?.({ classification: "accepted", spawned: true, closed: true, exitCode: 0,
        signal: null, durationMs: 1, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false });
    } });
  const runId = randomUUID();
  const tap = (id: string) => ({ id, kind: "step", input: { target: { selector: { resourceId: `${packageName}:id/result` } },
    action: { kind: "tap" }, expect: condition("暂停"), timeoutMs: 5000 } });
  return { session, order, counts: () => ({ inputs, gates }), async run() {
    await session.request({ name: "start_debug_plan", input: { sessionId: session.state.id, runId, definition: {
      version: 1, title: "Helper delayed page", backend: "accessibility-helper", timeoutMs: 20000,
      startConditions: [condition("播放")], finalConditions: [condition("暂停")],
      steps: failGate ? [tap("first"), tap("must-not-run")] : [tap("first")],
    } } });
    await session.settled();
    return (await session.request({ name: "get_debug_plan", input: { sessionId: session.state.id, runId } })).run as DebugPlanRun;
  }, async dispose() { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); } };
}

test("plan action waits on the phone after input and verifies two new complete frames before final checks", async () => {
  const h = harness();
  try {
    const run = await h.run();
    assert.equal(run.status, "passed", run.message);
    assert.deepEqual(h.counts(), { inputs: 1, gates: 2 });
    const afterInput = h.order.slice(h.order.indexOf("input"));
    assert.deepEqual(afterInput.slice(0, 6), ["input", "observe:加载中", "gate", "gate", "observe:暂停", "observe:暂停"]);
    assert.ok(h.session.state.steps.filter(step => step.action === "perform_ui_step").every(step => step.verified));
  } finally { await h.dispose(); }
});

test("a device wait failure after an accepted input stops the plan before the next input", async () => {
  const h = harness(true);
  try {
    const run = await h.run();
    assert.equal(run.status, "failed");
    assert.deepEqual(h.counts(), { inputs: 1, gates: 1 });
    assert.equal(run.steps[1].status, "pending");
    assert.equal(h.order.filter(item => item === "input").length, 1);
  } finally { await h.dispose(); }
});
