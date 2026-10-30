import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { helperConditionWaitHint, helperConditionWaitRequest } from "../shared/helper-condition-wait";

const request = () => ({ version: 1, sessionId: randomUUID(), requestId: randomUUID(), serviceInstanceId: randomUUID(),
  packageName: "com.example.fixture", selector: { resourceId: "com.example.fixture:id/ready" }, state: "visible",
  display: { width: 1080, height: 2400, rotation: 0 }, timeoutMs: 750 });
const hint = () => { const input = request(); return { success: true, protocolVersion: 1, sessionId: input.sessionId,
  requestId: input.requestId, serviceInstanceId: input.serviceInstanceId, packageName: input.packageName,
  windowId: "12", display: input.display, status: "ready", matchCount: 1, attempts: 2, startedAtMs: 100, finishedAtMs: 200 }; };

test("device wait accepts exact selectors and only the four bounded read states", () => {
  for (const state of ["visible", "absent", "enabled", "disabled"]) {
    assert.equal(helperConditionWaitRequest.safeParse({ ...request(), state }).success, true);
  }
  const selector = { resourceId: "com.example.fixture:id/ready", text: "就绪", contentDesc: "ready", className: "android.widget.TextView" };
  assert.deepEqual(helperConditionWaitRequest.parse({ ...request(), selector }).selector, selector);
  for (const value of [{ selector: {} }, { selector: { text: "" } }, { selector: { text: "x".repeat(513) } },
    { selector: { resourceId: "ready", regex: true } }, { state: "clickable" }]) {
    assert.equal(helperConditionWaitRequest.safeParse({ ...request(), ...value }).success, false);
  }
});

test("device wait cannot carry scripts, inputs, unlimited waits or ambiguous ownership", () => {
  for (const value of [{ code: "run()" }, { action: { kind: "tap" } }, { x: 20 }, { retry: 100 },
    { timeoutMs: 49 }, { timeoutMs: 1001 }, { timeoutMs: Number.POSITIVE_INFINITY }, { timeoutMs: 100.5 },
    { version: 2 }, { sessionId: "other" }, { requestId: "other" }, { serviceInstanceId: "other" },
    { packageName: "com.example/other" }, { packageName: "" }, { display: { width: 0, height: 2400, rotation: 0 } },
    { display: { width: 1080, height: 2400, rotation: 4 } }]) {
    assert.equal(helperConditionWaitRequest.safeParse({ ...request(), ...value }).success, false);
  }
});

test("device wait budget measures UTF-8 bytes including escaped selector strings", () => {
  const valid = { ...request(), selector: { text: "中".repeat(512) } };
  assert.equal(helperConditionWaitRequest.safeParse(valid).success, true);
  for (const text of ["中".repeat(512), "\u0000".repeat(512)]) {
    const input = { ...request(), selector: { resourceId: text, text, contentDesc: text, className: text } };
    assert.ok(new TextEncoder().encode(JSON.stringify(input)).length > 4096);
    assert.equal(helperConditionWaitRequest.safeParse(input).success, false);
  }
});

test("wait hints are small strict scheduling results without observation or input evidence", () => {
  assert.equal(helperConditionWaitHint.safeParse(hint()).success, true);
  assert.equal(helperConditionWaitHint.safeParse({ ...hint(), status: "pending", matchCount: 0 }).success, true);
  for (const value of [{ snapshot: {} }, { xml: "<node/>" }, { screenshot: "data:image/png;base64," },
    { helperObservation: {} }, { inputTicket: randomUUID() }, { success: false }, { protocolVersion: 2 },
    { attempts: 0 }, { attempts: 9 }, { matchCount: -1 }, { matchCount: 5001 }, { finishedAtMs: 99 },
    { startedAtMs: -1 }, { windowId: "" }]) {
    assert.equal(helperConditionWaitHint.safeParse({ ...hint(), ...value }).success, false);
  }
});
