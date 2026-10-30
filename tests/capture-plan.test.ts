import assert from "node:assert/strict";
import { test } from "node:test";
import { CapturePlan } from "../electron/capture/capture-plan";
import { createCaptureRunContext, createCaptureAttemptContext, withCaptureSignal } from "../electron/capture/run-context";

const modernSmallPage = { nodeCount: 98, verified: true, visibleStream: "2", uiWake: "1", hardwareAccelerated: "true" };

test("small pages start with DDMS properties and upgrade only after current SDK evidence", () => {
  const plan = new CapturePlan(undefined, false, "sdk-enhanced");
  assert.equal(plan.imageRoute, "ddms"); assert.equal(plan.sdkFirstCandidate(98, true), false);
  for (const changed of [{ verified: false }, { visibleStream: "1" }, { visibleStream: undefined }, { uiWake: "2" }, { hardwareAccelerated: true }]) {
    assert.equal(plan.acceptVerifiedSdk({ ...modernSmallPage, ...changed }), false); assert.equal(plan.imageRoute, "ddms");
  }
  assert.equal(plan.acceptVerifiedSdk(modernSmallPage), true); assert.equal(plan.imageRoute, "sdk");
});

test("tri-state policy preserves explicit opt-out and the existing large page route", () => {
  for (const size of [1, 98, 199, 200, 5000]) {
    const disabled = new CapturePlan(false, false, "sdk-enhanced");
    assert.equal(disabled.sdkFirstCandidate(size, true), false);
    assert.equal(disabled.acceptVerifiedSdk({ ...modernSmallPage, nodeCount: size }), false); assert.equal(disabled.imageRoute, "ddms");
    assert.equal(new CapturePlan(undefined, false, "sdk-enhanced").sdkFirstCandidate(size, true), size >= 200);
    assert.equal(new CapturePlan(true, false, "sdk-enhanced").sdkFirstCandidate(size, true), true);
    assert.equal(new CapturePlan(true, false, "sdk-enhanced").sdkFirstCandidate(size, false), false);
  }
  const software = new CapturePlan(undefined, false, "sdk-enhanced"); assert.equal(software.acceptVerifiedSdk({ ...modernSmallPage, hardwareAccelerated: "false" }), true);
});

test("attempts share only the pinned request identity, while stage deadlines share the validated route", () => {
  const options = { inspectionMode: "sdk-enhanced" as const, preferVisibleSdk: undefined, pinFirstComponent: null };
  const request = createCaptureRunContext(options), attempt = createCaptureAttemptContext(request), other = createCaptureRunContext(options);
  attempt.request.pinFirstComponent = "sample.app/Main";
  attempt.plan.acceptVerifiedSdk(modernSmallPage);
  const stage = withCaptureSignal(attempt, AbortSignal.timeout(1000));
  assert.equal(stage.plan, attempt.plan); assert.equal(stage.plan.imageRoute, "sdk");
  const retry = createCaptureAttemptContext(request, { startupRetry: true });
  assert.equal(retry.request.pinFirstComponent, "sample.app/Main"); assert.equal(retry.plan.imageRoute, "ddms"); assert.equal(retry.plan.startupRetry, true);
  assert.equal(other.plan.imageRoute, "ddms"); assert.equal(other.request.pinFirstComponent, null); assert.equal(options.pinFirstComponent, null);
});
