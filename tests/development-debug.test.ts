import assert from "node:assert/strict";
import { test } from "node:test";
import { developmentDebugTarget, developmentTargetMatches } from "../electron/automation/development-debug";

const env = { ANDROID_UI_INSPECTOR_DEV_AUTO_DEBUG: "1", ANDROID_UI_INSPECTOR_DEV_SERIAL: "fixture-device",
  ANDROID_UI_INSPECTOR_DEV_PACKAGE: "com.androiduiinspector.sdkfree" };

test("development auto debug is opt-in, unpackaged only and pins one serial/package pair", () => {
  assert.deepEqual(developmentDebugTarget(env, false), { serial: "fixture-device", packageName: "com.androiduiinspector.sdkfree" });
  assert.equal(developmentDebugTarget(env, true), null);
  assert.equal(developmentDebugTarget({ ...env, ANDROID_UI_INSPECTOR_DEV_AUTO_DEBUG: "true" }, false), null);
  assert.equal(developmentDebugTarget({ ...env, ANDROID_UI_INSPECTOR_DEV_AUTO_DEBUG: undefined }, false), null);
  assert.equal(developmentTargetMatches(developmentDebugTarget(env, false), "fixture-device", "com.androiduiinspector.sdkfree"), true);
  assert.equal(developmentTargetMatches(developmentDebugTarget(env, false), "other-device", "com.androiduiinspector.sdkfree"), false);
  assert.equal(developmentTargetMatches(developmentDebugTarget(env, false), "fixture-device", "com.example.other"), false);
});

test("development auto debug refuses missing or malformed scope", () => {
  for (const serial of ["", "../tmp", "a b", "x".repeat(257)]) {
    assert.throws(() => developmentDebugTarget({ ...env, ANDROID_UI_INSPECTOR_DEV_SERIAL: serial }, false), /DEV_SERIAL/);
  }
  for (const packageName of ["", "android", "com.example/Injected", "com.example;id", "com..example"]) {
    assert.throws(() => developmentDebugTarget({ ...env, ANDROID_UI_INSPECTOR_DEV_PACKAGE: packageName }, false), /DEV_PACKAGE/);
  }
  assert.equal(developmentDebugTarget({ ...env, ANDROID_UI_INSPECTOR_DEV_PACKAGE: "invalid" }, true), null);
});
