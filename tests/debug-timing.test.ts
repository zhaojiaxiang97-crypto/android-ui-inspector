import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createDebugTiming, debugCommandCategory, getDebugTimings, measureDebugCommand, measureDebugPhase,
  runWithDebugTiming, withDebugObservationReason } from "../electron/automation/debug-timing";
import { DEBUG_TIMING_SPAN_LIMIT, debugTimingCoveredMs, debugTimingSpanSchema, debugTimingsSchema, type DebugTimingSpan, type DebugTimings } from "../shared/debug-timing";
import { helperEvidence } from "./fixtures/helper-protocol";
import { withCommandSignal } from "../electron/device/command-context";
import { runCommand } from "../electron/device/runtime";
import { DebugReportStepTimings } from "../src/features/reports/DebugReportStepTimings";

function clock() {
  let now = 0;
  return { advance: (ms: number) => { now += ms; }, now: () => now, date: () => "2026-10-15T12:00:00.000Z" };
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

test("parallel phases retain intervals and parent IDs without summing overlapping work", async () => {
  const time = clock(), timing = createDebugTiming(time), treeDone = deferred(), screenDone = deferred();
  await runWithDebugTiming(timing, () => withDebugObservationReason("after_action", () => measureDebugPhase("observation", async () => {
    const tree = measureDebugPhase("hierarchy", async () => { await treeDone.promise; });
    const screen = measureDebugPhase("screenshot", async () => { await screenDone.promise; });
    time.advance(40); treeDone.resolve(); await tree;
    time.advance(20); screenDone.resolve(); await screen;
  }, { backend: "uiautomator" })));
  const result = timing.finish("success");
  assert.equal(debugTimingsSchema.safeParse(result).success, true);
  assert.equal(result.durationMs, 60); assert.equal(debugTimingCoveredMs(result), 60);
  assert.equal(result.spans.reduce((sum, span) => sum + span.durationMs, 0), 160);
  assert.deepEqual(result.spans.map(span => span.parentId), [null, 1, 1]);
  assert.deepEqual(result.observationCounts, { after_action: 1 });
});

test("timing retains failed and cancelled phases while cleanup can finish independently", async () => {
  for (const cancel of [false, true]) {
    const time = clock(), timing = createDebugTiming(time), controller = new AbortController();
    await assert.rejects(runWithDebugTiming(timing, () => withCommandSignal(controller.signal, () => measureDebugPhase("observation", async () => {
      try { await measureDebugPhase("hierarchy", () => {
        time.advance(7); if (cancel) controller.abort(new Error("private cancellation reason"));
        throw new Error("private error reply");
      }); } finally { await measureDebugPhase("cleanup", () => { time.advance(3); }); }
    }))));
    const result = timing.finish(cancel ? "cancelled" : "failed");
    assert.equal(debugTimingsSchema.safeParse(result).success, true);
    assert.deepEqual(result.spans.map(span => span.status), [cancel ? "cancelled" : "failed", cancel ? "cancelled" : "failed", "success"]);
    assert.equal(result.durationMs, 10); assert.doesNotMatch(JSON.stringify(result), /private/);
  }
});

test("timing contexts are isolated and snapshots cannot mutate the recorder", async () => {
  const first = createDebugTiming(), second = createDebugTiming();
  await Promise.all([first, second].map((timing, index) => runWithDebugTiming(timing, () => measureDebugPhase("save", async () => {
    await Promise.resolve(); const current = getDebugTimings()!;
    assert.equal(current.correlationId, timing.correlationId); current.spans[0].durationMs = 999999;
    if (index === 1) await measureDebugPhase("serialization", () => undefined);
  }))));
  assert.equal(first.finish("success").spans.length, 1); assert.equal(second.finish("success").spans.length, 2);
  assert.equal(getDebugTimings(), undefined); assert.ok(first.peek().durationMs < 999999);
});

test("Helper device metadata owns its input and every running or finished timing copy", async () => {
  const time = clock(), timing = createDebugTiming(time), device = helperEvidence().timing;
  Object.assign(device, { postProcessing: { windowValidationStartedAtMs: 104, windowValidationCompletedAtMs: 104,
    pngEncodingStartedAtMs: 104, pngEncodingCompletedAtMs: 104, base64EncodingStartedAtMs: 104, base64EncodingCompletedAtMs: 104 } });
  const expected = structuredClone(device);
  await runWithDebugTiming(timing, () => measureDebugPhase("helper_tree", () => {
    device.startedAtMs = 999_999;
    const live = timing.peek(); live.spans[0].helperDeviceTiming!.postProcessing!.pngEncodingCompletedAtMs = 999_999;
    assert.deepEqual(timing.peek().spans[0].helperDeviceTiming, expected); time.advance(5);
  }, { helperDeviceTiming: device, helperReportedComplete: false }));
  const first = timing.finish("failed"); assert.equal(debugTimingsSchema.safeParse(first).success, true);
  assert.deepEqual(first.spans[0].helperDeviceTiming, expected);
  first.spans[0].helperDeviceTiming!.postProcessing!.base64EncodingCompletedAtMs = 999_999;
  assert.deepEqual(timing.finish("success").spans[0].helperDeviceTiming, expected);
  assert.equal(timing.peek().status, "failed");
  await runWithDebugTiming(timing, () => measureDebugPhase("helper_tree", () => undefined,
    { helperDeviceTiming: helperEvidence().timing, helperReportedComplete: true }));
  assert.equal(timing.peek().spans.length, 1, "a finished recorder cannot reopen or accept new metadata");
});

test("Helper profiling fields are paired, strict, phase-bound and optional for older reports", async () => {
  const span: DebugTimingSpan = { id: 1, parentId: null, phase: "helper_tree", startOffsetMs: 0, durationMs: 2,
    status: "failed", helperDeviceTiming: helperEvidence().timing, helperReportedComplete: false };
  assert.equal(debugTimingSpanSchema.safeParse(span).success, true);
  for (const phase of ["helper_request", "helper_request_headers", "helper_response_read", "helper_json_parse"] as const)
    for (const helperEndpoint of ["capabilities", "snapshot"] as const)
      assert.equal(debugTimingSpanSchema.safeParse({ ...span, phase, helperEndpoint,
        helperDeviceTiming: undefined, helperReportedComplete: undefined }).success, true);
  for (const invalid of [
    { ...span, helperDeviceTiming: undefined }, { ...span, helperReportedComplete: undefined },
    { ...span, helperReportedComplete: null }, { ...span, helperEndpoint: "snapshot" },
    { ...span, phase: "observation" }, { ...span, phase: "hierarchy" },
    { ...span, helperDeviceTiming: { ...span.helperDeviceTiming, completedAtMs: 99 } },
    { ...span, helperDeviceTiming: { ...span.helperDeviceTiming, secret: "private" } },
    { ...span, phase: "helper_request", helperEndpoint: "http://private.invalid/token", helperDeviceTiming: undefined, helperReportedComplete: undefined },
    { ...span, helperDeviceTiming: undefined, helperReportedComplete: undefined, helperEndpoint: "wait" },
  ]) assert.equal(debugTimingSpanSchema.safeParse(invalid).success, false);
  const time = clock(), timing = createDebugTiming(time);
  await runWithDebugTiming(timing, () => measureDebugPhase("observation", async () => {
    await measureDebugPhase("helper_tree", () => { time.advance(2); }, {
      helperDeviceTiming: helperEvidence().timing, helperReportedComplete: true,
    });
  }, { backend: "accessibility-helper" }));
  const result = timing.finish("success"); assert.equal(debugTimingsSchema.safeParse(result).success, true);
  const legacy = structuredClone(result); delete legacy.spans[1].helperDeviceTiming; delete legacy.spans[1].helperReportedComplete;
  assert.equal(debugTimingsSchema.safeParse(legacy).success, true);
  for (const change of [(value: DebugTimings) => { value.spans[1].parentId = 999; },
    (value: DebugTimings) => { value.spans[1].durationMs = 3; },
    (value: DebugTimings) => { value.spans[0].helperDeviceTiming = value.spans[1].helperDeviceTiming;
      value.spans[0].helperReportedComplete = true; }]) {
    const invalid = structuredClone(result); change(invalid); assert.equal(debugTimingsSchema.safeParse(invalid).success, false);
  }
});

test("bounded spans retain total command and observation counts", async () => {
  const timing = createDebugTiming();
  await runWithDebugTiming(timing, async () => {
    for (let index = 0; index < DEBUG_TIMING_SPAN_LIMIT + 3; index++) await measureDebugCommand("target", async () => undefined);
    await measureDebugPhase("observation", () => undefined);
  });
  const result = timing.finish("success");
  assert.equal(result.spans.length, DEBUG_TIMING_SPAN_LIMIT); assert.equal(result.droppedSpans, 4);
  assert.equal(result.commandCount, DEBUG_TIMING_SPAN_LIMIT + 3); assert.equal(result.observationCount, 1);
  assert.equal(debugTimingsSchema.safeParse(result).success, true);
});

test("command measurements count nonzero exits and cancellation without retaining arguments", async () => {
  const timing = createDebugTiming();
  await runWithDebugTiming(timing, async () => {
    const result = await runCommand(process.execPath, ["-e", "process.exit(7)", "sensitive-token-fixture"]);
    assert.equal(result.code, 7);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(withCommandSignal(controller.signal, () => runCommand(process.execPath, ["-e", "process.exit(0)"])));
  });
  const result = timing.finish("failed");
  assert.equal(result.commandCount, 1); assert.equal(result.spans[0].status, "failed");
  assert.doesNotMatch(JSON.stringify(result), /sensitive|process\.exit/);
  assert.equal(debugCommandCategory("/fixture/adb", ["-s", "private-serial", "shell", "input", "text", "private-text"]), "input");
  assert.equal(debugCommandCategory("adb", ["exec-out", "screencap", "-p"]), "screenshot");
  assert.equal(debugCommandCategory("adb", ["shell", "dumpsys", "window", "windows"]), "target");
});

test("timing validation rejects corrupt ranges, counts and secret-bearing extra fields", async () => {
  const time = clock(), timing = createDebugTiming(time);
  await runWithDebugTiming(timing, () => measureDebugPhase("save", () => { time.advance(2); }));
  const result = timing.finish("success");
  for (const change of [(v: DebugTimings) => { v.spans[0].durationMs = 5; }, (v: DebugTimings) => { v.commandCount = 1; },
    (v: DebugTimings) => { v.spans[0].parentId = 1; }, (v: DebugTimings) => { Object.assign(v.spans[0], { commandArgs: ["secret"] }); }]) {
    const invalid = structuredClone(result); change(invalid); assert.equal(debugTimingsSchema.safeParse(invalid).success, false);
  }
});

test("legacy report timing stays unrecorded and measured totals show overlapping intervals", async () => {
  assert.match(renderToStaticMarkup(createElement(DebugReportStepTimings, {})), /未记录/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(DebugReportStepTimings, {})), /0 ms/);
  const timing = createDebugTiming();
  await runWithDebugTiming(timing, () => measureDebugPhase("hierarchy", () => undefined));
  const html = renderToStaticMarkup(createElement(DebugReportStepTimings, { timings: timing.finish("success") }));
  assert.match(html, /总经过/); assert.match(html, /不是各行耗时相加/); assert.match(html, /读取控件树/);
});

test("actual observation flow records successful, failed and cancelled phases offline", () => {
  for (const scenario of ["success", "ordered", "empty-tree", "cancel"]) {
    const output = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("./fixtures/debug-observation-timing.mjs", import.meta.url)), scenario],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), timeout: 5000, encoding: "utf8" }));
    const result = debugTimingsSchema.parse(output.timings);
    assert.equal(output.inputCalls, 0); assert.equal(output.cleaned, 1); assert.equal(output.screenFinished, true);
    assert.equal(result.observationCount, 1); assert.deepEqual(result.observationCounts, { explicit: 1 });
    assert.equal(result.commandCount, scenario === "success" || scenario === "ordered" ? 6 : 5);
    const tree = result.spans.find(span => span.phase === "hierarchy")!, screen = result.spans.find(span => span.phase === "screenshot")!;
    if (scenario === "ordered") assert.ok(screen.startOffsetMs >= tree.startOffsetMs + tree.durationMs - 0.01);
    else assert.ok(screen.startOffsetMs < tree.startOffsetMs + tree.durationMs);
    assert.ok(result.spans.some(span => span.phase === "cleanup"));
    if (scenario === "success") for (const phase of ["target_before", "parse", "geometry", "target_after"]) assert.ok(result.spans.some(span => span.phase === phase));
    assert.equal(result.spans[0].status, scenario === "cancel" ? "cancelled" : scenario === "empty-tree" ? "failed" : "success");
  }
});
