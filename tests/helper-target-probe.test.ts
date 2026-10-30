import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { readHelperTargetProbe } from "../electron/capture/helper-target-probe";
import { helperTargetProbeReply, helperTargetProbeRequest, type HelperTargetProbeRequest } from "../shared/helper-target-probe";
import { helperToken, helperPackage, helperFrame, helperServiceId } from "./fixtures/helper-protocol";
import { parseUiHierarchy } from "../electron/capture/xml-tree";
import { probeTargetFromNode } from "../scripts/helper-target-probe";

const request = (): HelperTargetProbeRequest => ({ version: 1, sessionId: randomUUID(), requestId: randomUUID(),
  serviceInstanceId: helperServiceId, captureId: randomUUID(), packageName: helperPackage, windowId: "7", display: helperFrame,
  target: { resourceId: helperPackage + ":id/start", className: "android.widget.Button", bounds: { left: 0, top: 0, right: 10, bottom: 20 } } });
const reply = (input: HelperTargetProbeRequest) => {
  const { target: _, ...identity } = input;
  return { ...identity, readOnly: true, dispatchState: "not_sent", status: "completed", startedAtMs: 100, mainStartedAtMs: 101,
    finishedAtMs: 120, preflightStage: "final_checks", preflightStageStartedAtMs: 119,
    scanDiagnostics: { version: 1, operation: "node", scanStartedAtMs: 102, operationStartedAtMs: 110,
      nodesVisited: 5, childReadsStarted: 4, childReadsCompleted: 4, childReadTotalMs: 8, childReadMaxMs: 3 } };
};
test("probe accepts bounded completed and timeout diagnostics; rejects actions and dispatch claims", async () => {
  const input = request(), valid = reply(input);
  assert.equal(helperTargetProbeReply.safeParse(valid).success, true);
  assert.equal(helperTargetProbeReply.safeParse({ ...valid, status: "timeout", errorCode: "timeout",
    preflightStage: "target_scan", preflightStageStartedAtMs: 102 }).success, true);
  for (const patch of [{ action: { kind: "back" } }, { target: input.target }, { dispatchState: "sent" }, { readOnly: false },
    { requestId: "bad" }, { errorCode: "timeout" }, { mainStartedAtMs: 99 }, { preflightStageStartedAtMs: 121 },
    { scanDiagnostics: { ...valid.scanDiagnostics, childReadsStarted: 5 } },
    { scanDiagnostics: { ...valid.scanDiagnostics, childReadTotalMs: 100 } }, { scanDiagnostics: undefined },
    { preflightStage: "precheck" }, { preflightStage: undefined, preflightStageStartedAtMs: undefined }])
    assert.equal(helperTargetProbeReply.safeParse({ ...valid, ...patch }).success, false);
  assert.equal(helperTargetProbeRequest.safeParse({ ...input, action: { kind: "tap", x: 1, y: 1 } }).success, false);
  assert.equal(helperTargetProbeReply.safeParse({ ...valid, status: "timeout", errorCode: "timeout",
    preflightStage: "target_scan", preflightStageStartedAtMs: 103 }).success, false);
  assert.equal(helperTargetProbeRequest.safeParse({ ...input, target: { ...input.target, bounds: { ...input.target.bounds, right: 11 } } }).success, false);
});
test("probe transport posts once to read-only endpoint, binds identity and never falls back", async () => {
  const input = request(); let calls = 0;
  const read = (value: unknown, status = 200) => readHelperTargetProbe(12345, helperToken, input, new AbortController().signal,
    (async (url, options) => {
      calls++; assert.match(String(url), /\/inspector\/target-probe$/); assert.equal(options!.method, "POST");
      assert.equal("action" in JSON.parse(String(options!.body)), false);
      return new Response(typeof value === "string" ? value : JSON.stringify(value), { status });
    }) as typeof fetch);
  assert.deepEqual(await read(reply(input)), reply(input));
  for (const patch of [{ captureId: randomUUID() }, { sessionId: randomUUID() }, { serviceInstanceId: randomUUID() },
    { requestId: randomUUID() }, { packageName: "other.app" }, { display: { ...helperFrame, rotation: 1 } }])
    await assert.rejects(read({ ...reply(input), ...patch }));
  const before = calls;
  await assert.rejects(read({}, 404)); assert.equal(calls, before + 1);
  await assert.rejects(read(" ".repeat(4097)));
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(readHelperTargetProbe(12345, helperToken, input, aborted.signal, (async () => {
    throw new Error("aborted request reached network");
  }) as typeof fetch));
});

test("probe script converts parsed Android bounds into the strict read-only request", async () => {
  const node = parseUiHierarchy(`<hierarchy rotation="0"><node index="0" text="" resource-id=""
    class="android.widget.Button" package="${helperPackage}" content-desc="Open"
    clickable="true" enabled="true" visible-to-user="true" bounds="[0,0][10,20]" /></hierarchy>`).root;
  assert.equal(node.bounds?.raw, "[0,0][10,20]");
  const target = probeTargetFromNode(node);
  const input = { ...request(), target };
  assert.equal(helperTargetProbeRequest.safeParse({ ...input, target: { ...target, bounds: node.bounds } }).success, false);
  assert.equal(helperTargetProbeRequest.safeParse(input).success, true);
  let calls = 0;
  await readHelperTargetProbe(12345, helperToken, input, new AbortController().signal, (async (url, options) => {
    calls++;
    assert.match(String(url), /\/inspector\/target-probe$/);
    const body = JSON.parse(String(options!.body));
    assert.equal("action" in body, false);
    assert.deepEqual(body.target.bounds, { left: 0, top: 0, right: 10, bottom: 20 });
    assert.equal(body.target.contentDesc, "Open");
    return new Response(JSON.stringify(reply(input)));
  }) as typeof fetch);
  assert.equal(calls, 1);
  assert.throws(() => probeTargetFromNode({ ...node, enabled: false }), /预检目标/);
});
