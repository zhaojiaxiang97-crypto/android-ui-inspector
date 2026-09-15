import assert from "node:assert/strict";
import test from "node:test";
import { resolveHomeState } from "../shared/device-state";
import type { AdbProbeResult, DeviceInfo } from "../shared/types";

function device(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    serial: "emulator-5554",
    state: "device",
    model: "Pixel 7",
    androidVersion: "15",
    product: "panther",
    transportId: "1",
    ...overrides,
  };
}

function probe(overrides: Partial<AdbProbeResult> = {}): AdbProbeResult {
  return {
    adbPath: "adb",
    adbVersion: "Android Debug Bridge version 1.0.41",
    devices: [],
    error: null,
    ...overrides,
  };
}

test("home state remains loading until the first probe resolves", () => {
  assert.equal(resolveHomeState({ loading: true, runtimeError: null, probe: null, selectedDevice: null }), "loading");
  assert.equal(resolveHomeState({ loading: true, runtimeError: null, probe: probe({ devices: [device()] }), selectedDevice: device() }), "loading");
});

test("home state distinguishes a missing adb runtime from an empty device list", () => {
  assert.equal(resolveHomeState({ loading: false, runtimeError: null, probe: probe({ adbPath: null }), selectedDevice: null }), "adb-missing");
  assert.equal(resolveHomeState({ loading: false, runtimeError: null, probe: probe(), selectedDevice: null }), "no-device");
});

test("home state surfaces renderer and adb probe failures", () => {
  assert.equal(resolveHomeState({ loading: false, runtimeError: "bridge unavailable", probe: null, selectedDevice: null }), "error");
  assert.equal(resolveHomeState({ loading: false, runtimeError: null, probe: probe({ error: "adb failed" }), selectedDevice: null }), "error");
});

test("home state exposes authorization as a separate actionable state", () => {
  const unauthorized = device({ state: "unauthorized" });
  assert.equal(resolveHomeState({ loading: false, runtimeError: null, probe: probe({ devices: [unauthorized] }), selectedDevice: unauthorized }), "unauthorized");
});

test("the selected device takes precedence over another ready device", () => {
  const unauthorized = device({ serial: "phone-pending", state: "unauthorized" });
  const ready = device({ serial: "phone-ready", state: "device" });
  assert.equal(resolveHomeState({ loading: false, runtimeError: null, probe: probe({ devices: [unauthorized, ready] }), selectedDevice: unauthorized }), "unauthorized");
  assert.equal(resolveHomeState({ loading: false, runtimeError: null, probe: probe({ devices: [unauthorized, ready] }), selectedDevice: ready }), "connected");
});

test("a ready device can be promoted to connected when no explicit selection exists", () => {
  const ready = device();
  assert.equal(resolveHomeState({ loading: false, runtimeError: null, probe: probe({ devices: [ready] }), selectedDevice: null }), "connected");
});
