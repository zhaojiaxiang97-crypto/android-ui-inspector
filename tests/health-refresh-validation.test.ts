import assert from "node:assert/strict";
import { test } from "node:test";
import { canContinueHealthSeries, canRefreshHealthCapture, shouldRetryHealthCapture, validateHealthRefresh } from "../scripts/health-refresh-validation";
const target = { id: "node", ref: "TextView@abc", className: "TextView", bounds: { left: 1, top: 2, right: 10, bottom: 20 } };
const fixture = () => ({ ...target, bounds: { ...target.bounds }, failures: [], status: "captured", hasImage: true });
test("continuous captures stop on failure, retry, identity or coverage changes", () => {
  const baseline = { duration: 10000, value: { debugProcessId: "6884", processInstance: "instance", rootRef: "root@abc",
    nodeCount: 90, inspectionSource: "debug-view", coverage: { captured: 71, visible: 74, failed: 0 }, captureRequestDiagnostics: { totalAttempts: 1 } } };
  assert.equal(canContinueHealthSeries(baseline, baseline, 15000), true);
  for (const patch of [{error:"timeout"}, {debugProcessId:"8934"}, {processInstance:"changed"}, {processInstance:null},
    {rootRef:"other"}, {nodeCount:91}, {coverage:{captured:70,visible:74,failed:0}},
    {coverage:{captured:71,visible:73,failed:0}}, {captureRequestDiagnostics:{totalAttempts:2}}]) {
    assert.equal(canContinueHealthSeries({duration:10000,value:{...baseline.value,...patch}}, baseline, 15000), false);
  }
  assert.equal(canContinueHealthSeries({...baseline,duration:15000},baseline,15000),false);
});
test("strict business probes never auto-retry or refresh after unhealthy/retried captures", () => {
  for (const error of ["冷启动", "等待页面稳定", "尚未就绪", "请等待页面就绪"]) {
    assert.equal(shouldRetryHealthCapture(error, false), true);
    assert.equal(shouldRetryHealthCapture(error, true), false);
  }
  for (const error of [undefined, null, "other failure"]) assert.equal(shouldRetryHealthCapture(error, false), false);
  const healthy = { inspectionSource: "debug-hybrid", coverage: { captured: 1, failed: 0 }, captureRequestDiagnostics: { totalAttempts: 1 } };
  assert.equal(canRefreshHealthCapture(healthy, 14000, 15000, true), true);
  for (const value of [undefined, { ...healthy, error: "failed" }, { ...healthy, diagnostics: { "sdk-visible-interrupted": "true" } },
    { ...healthy, coverage: { captured: 0, failed: 0 } }, { ...healthy, coverage: { captured: 1, failed: 1 } },
    { ...healthy, inspectionSource: "fast" }, { ...healthy, captureRequestDiagnostics: undefined },
    { ...healthy, captureRequestDiagnostics: { totalAttempts: 0 } },
    { ...healthy, captureRequestDiagnostics: { totalAttempts: "1" } },
    { ...healthy, captureRequestDiagnostics: { totalAttempts: 1.5 } },
    { ...healthy, captureRequestDiagnostics: { totalAttempts: 2 } }]) {
    assert.equal(canRefreshHealthCapture(value, 14000, 15000, true), false);
  }
  for (const duration of [15000, 20000, NaN]) assert.equal(canRefreshHealthCapture(healthy, duration, 15000, true), false);
  assert.equal(canRefreshHealthCapture(undefined, 20000, 15000, false), true);
});
test("refresh requires exact node identity, class and a captured image", () => {
  assert.deepEqual(validateHealthRefresh(target, fixture()), { accepted: true, boundsMatchBaseline: true });
  for (const key of ["id", "ref", "className", "status", "hasImage"]) {
    const value: any = fixture(); value[key] = key === "hasImage" ? false : "wrong";
    assert.equal(validateHealthRefresh(target, value).accepted, false);
  }
  assert.equal(validateHealthRefresh(target, fixture(), "rejected").accepted, false);
});
test("geometry changes are explicit, but not automatically refresh failures", () => {
  const value = fixture(); value.bounds.left++;
  assert.deepEqual(validateHealthRefresh(target, value), { accepted: true, boundsMatchBaseline: false });
});
test("missing or invalid bounds and reported failures cannot pass", () => {
  for (const bounds of [undefined, { ...target.bounds, left: NaN }, { ...target.bounds, right: 1 }]) {
    assert.equal(validateHealthRefresh(target, { ...fixture(), bounds }).accepted, false);
  }
  assert.equal(validateHealthRefresh(target, { ...fixture(), failures: [{ message: "failed" }] }).accepted, false);
  assert.equal(validateHealthRefresh(target, undefined).accepted, false);
});
test("optional pixel oracle rejects changed, missing or incorrectly sized pixel data", () => {
  const sha = "a".repeat(64);
  const value = { ...fixture(), pixels: { width: 9, height: 18, sha256: sha } };
  assert.equal(validateHealthRefresh(target, value, undefined, sha).accepted, true);
  assert.equal(validateHealthRefresh(target, value, undefined, "b".repeat(64)).accepted, false);
  assert.equal(validateHealthRefresh(target, fixture(), undefined, sha).accepted, false);
  assert.equal(validateHealthRefresh(target, { ...value, pixels: { ...value.pixels, width: 10 } }, undefined, sha).accepted, false);
});
