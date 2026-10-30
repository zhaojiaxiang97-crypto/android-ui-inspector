import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { diagnoseConnection, diagnosticScreenState, type ConnectionDiagnosticOptions } from "../electron/automation/connection-diagnostics";
import { automationDiagnosticObservation, connectionDiagnosticRequest, matchesConnectionDiagnostic,
  type ConnectionDiagnosticRequest, type ConnectionDiagnosticReport } from "../shared/connection-diagnostics";
import type { AdbProbeResult } from "../shared/types";

const serial = "diagnostic-fixture", packageName = "com.example.diagnostics";
const request = (values: Partial<ConnectionDiagnosticRequest> = {}): ConnectionDiagnosticRequest => ({ requestId: randomUUID(), serial, packageName, ...values });
const row = (report: ConnectionDiagnosticReport, id: string) => report.checks.find(check => check.id === id)!;
function fixture(values: { deviceState?: string; lock?: string; app?: string; sdk?: string; helper?: string;
  transportChange?: boolean; activityChange?: boolean; focusChange?: boolean; debugError?: string; commandError?: string } = {}) {
  const commands: string[][] = [];
  let probes = 0, activities = 0, focuses = 0;
  const options: ConnectionDiagnosticOptions = {
    probe: async (): Promise<AdbProbeResult> => ({ adbPath: "/fixture/adb", adbVersion: "fixture", error: null,
      devices: [{ serial, state: values.deviceState ?? "device", model: "Fixture", product: null, androidVersion: "15",
        transportId: values.transportChange && ++probes > 1 ? "2" : "1" }] }),
    command: async (_path, selected, args) => {
      assert.equal(selected, serial); commands.push(args);
      const key = args.join(" ");
      if (values.commandError === key) throw new Error("mock command failure");
      const result = (text: string, code = 0) => ({ code, stdout: Buffer.from(text), stderr: "" });
      if (key === "shell dumpsys window policy") return result(values.lock ?? "mShowingLockscreen=false");
      if (key === "shell dumpsys activity activities") {
        const instance = values.activityChange && ++activities > 1 ? "def" : "abc";
        return result(`mResumedActivity: ActivityRecord{${instance} u0 ${values.app ?? packageName}/.Main t1}`);
      }
      if (key === `shell run-as ${packageName} id`) return values.debugError ? result(values.debugError, 1) : result("uid=10001");
      if (key === `shell dumpsys package ${packageName}`) return result(values.sdk ?? `Package [${packageName}]\n${packageName}/com.androiduiinspector.sdk.HierarchyProvider:`);
      if (key === "shell settings get secure enabled_accessibility_services") return result(values.helper ?? "null");
      throw new Error(`Unexpected fixture command: ${key}`);
    },
    focus: async () => ({ packageName, id: values.focusChange && ++focuses > 1 ? "222" : "111" }),
    helperConfig: () => {},
    automationConnection: () => automationDiagnosticObservation({ shared: false, session: { active: true, serial, packageName }, serial, packageName }),
  };
  return { options, commands };
}

test("connection diagnosis has bounded, validated input and preserves selected capture identity", () => {
  for (const invalid of [{ serial: "phone; rm -rf" }, { requestId: "bad" }, { packageName: "invalid/package" },
    { captureMode: "deep", backend: "accessibility-helper" }, { timeoutMs: 31_000 }, { timeoutMs: 999 },
    { inspectionMode: "sdk-enhanced" }, { sdkEnabled: true }])
    assert.equal(connectionDiagnosticRequest.safeParse({ ...request(), ...invalid }).success, false);
  const report = { requestId: "id", serial, expectedPackageName: packageName, captureMode: "fast", backend: "uiautomator" } as ConnectionDiagnosticReport;
  const matching = { ...request(), requestId: "id" };
  assert.equal(matchesConnectionDiagnostic(report, matching), true);
  for (const changed of [{ serial: "other" }, { packageName: "com.other.app" }, { captureMode: "deep" as const }, { requestId: "other" }, { backend: "accessibility-helper" as const }])
    assert.equal(matchesConnectionDiagnostic(report, { ...matching, ...changed }), false);
});

test("normal UIAutomator readiness does not require an optional Helper or SDK, and all device commands are read-only", async () => {
  const { options, commands } = fixture({ sdk: `Package [${packageName}]` });
  const report = await diagnoseConnection(request(), options);
  assert.equal(report.status, "completed"); assert.equal(report.outcome, "ready"); assert.equal(report.checks.length, 9);
  assert.equal(row(report, "helper").required, false); assert.equal(row(report, "helper").code, "helper-disabled");
  assert.equal(row(report, "sdk").required, false); assert.equal(row(report, "sdk").code, "sdk-enhancement-disabled");
  assert.equal(row(report, "sdk").checkedAt, null); assert.equal(row(report, "sdk").suggestion, null);
  assert.equal(report.identity.packageName, packageName); assert.equal(report.identity.windowId, "111");
  assert.ok(Number.isFinite(Date.parse(report.completedAt))); assert.ok(report.elapsedMs >= 0);
  for (const args of commands) assert.ok(["shell dumpsys window policy", "shell dumpsys activity activities", `shell run-as ${packageName} id`,
    "shell settings get secure enabled_accessibility_services"].includes(args.join(" ")));
  const deep = await diagnoseConnection(request({ captureMode: "deep" }), options);
  assert.equal(deep.outcome, "ready"); assert.equal(row(deep, "sdk").required, false);
});

test("standard and absent policy never probe the SDK even when installed, for desktop, CLI and MCP", async () => {
  for (const inspectionMode of [undefined, "standard"] as const) {
    for (const client of ["desktop", "cli", "mcp"] as const) {
      for (const captureMode of ["fast", "deep"] as const) {
        const sdkCommand = `shell dumpsys package ${packageName}`;
        const local = fixture({ commandError: sdkCommand });
        let focusChecks = 0;
        const originalFocus = local.options.focus!;
        local.options.focus = async (...args) => { focusChecks++; return originalFocus(...args); };
        const report = await diagnoseConnection(request({ client, captureMode }), { ...local.options, inspectionMode });
        assert.equal(report.outcome, "ready"); assert.equal(report.status, "completed");
        assert.equal(row(report, "sdk").code, "sdk-enhancement-disabled");
        assert.match(row(report, "sdk").detail, /增强未启用/);
        assert.ok(!local.commands.some(args => args.join(" ") === sdkCommand));
        assert.equal(local.commands.filter(args => args.join(" ") === "shell dumpsys activity activities").length, 2);
        assert.equal(local.commands.filter(args => args.join(" ") === `shell run-as ${packageName} id`).length, 1);
        assert.equal(focusChecks, 2, "standard mode retains before/after window confirmation");
      }
    }
  }
});

test("trusted SDK enhancement inspects declaration only, and missing or failing SDK remains optional", async () => {
  for (const values of [{ sdk: `Package [${packageName}]` }, { commandError: `shell dumpsys package ${packageName}` }]) {
    const local = fixture(values);
    const report = await diagnoseConnection(request({ captureMode: "deep" }), { ...local.options, inspectionMode: "sdk-enhanced" });
    assert.equal(report.outcome, "ready");
    assert.equal(row(report, "sdk").required, false);
    assert.equal(row(report, "sdk").code, values.commandError ? "sdk-unavailable" : "sdk-missing");
    assert.equal(local.commands.filter(args => args.join(" ") === `shell dumpsys package ${packageName}`).length, 1);
    assert.ok(!local.commands.some(args => args.includes("content") || args.includes("forward")));
  }
});

test("missing ADB, offline and unauthorized devices stop dependent checks and give specific suggestions", async () => {
  const absent = await diagnoseConnection(request(), { probe: async () => ({ adbPath: null, adbVersion: null, devices: [], error: "missing" }) });
  assert.equal(row(absent, "adb").code, "adb-missing"); assert.equal(absent.outcome, "blocked");
  for (const deviceState of ["unauthorized", "offline"]) {
    const { options, commands } = fixture({ deviceState });
    const report = await diagnoseConnection(request(), options);
    assert.equal(report.outcome, "blocked"); assert.equal(commands.length, 0);
    assert.equal(row(report, "screen").status, "unknown"); assert.equal(row(report, "sdk").checkedAt, null);
    assert.equal(row(report, deviceState === "unauthorized" ? "authorization" : "device").code, `device-${deviceState}`);
    assert.ok(row(report, deviceState === "unauthorized" ? "authorization" : "device").suggestion);
  }
});

test("lock, wrong foreground, non-debuggable App and unavailable checks stay distinct", async () => {
  for (const [values, id, code] of [
    [{ lock: "mShowingLockscreen=true" }, "screen", "screen-locked"],
    [{ app: "com.other.app" }, "foreground", "foreground-mismatch"],
    [{ debugError: "run-as: package not debuggable" }, "debuggable", "app-not-debuggable"],
    [{ commandError: "shell dumpsys window policy" }, "screen", "screen-unavailable"],
  ] as const) {
    const report = await diagnoseConnection(request(), fixture(values).options);
    assert.equal(row(report, id).code, code);
    assert.equal(report.outcome, code === "screen-unavailable" ? "unknown" : "blocked");
  }
  assert.equal(diagnosticScreenState("window showing=false").status, "unknown");
  assert.equal(diagnosticScreenState("mKeyguardDelegate\n  showing=false\n  inputRestricted=false").status, "pass");
  assert.equal(diagnosticScreenState("mShowingLockscreen=false\nmWakefulness=Asleep").code, "screen-locked");
});

test("selected Helper is required; unverified runtime, missing configuration and SDK declaration remain explicit", async () => {
  const selection = request({ backend: "accessibility-helper" });
  const missing = await diagnoseConnection(selection, fixture().options);
  assert.equal(row(missing, "helper").required, true); assert.equal(missing.outcome, "blocked");
  const enabled = fixture({ helper: "com.androiduiinspector.a11yhelper/com.artemis.helper.ArtemisAccessibilityService" });
  const configured = await diagnoseConnection(selection, enabled.options);
  assert.equal(row(configured, "helper").code, "helper-enabled"); assert.equal(row(configured, "helper").status, "unknown");
  assert.equal(configured.outcome, "unknown");
  enabled.options.helperConfig = () => { throw new Error("secret token must not appear"); };
  const unpaired = await diagnoseConnection(selection, enabled.options);
  assert.equal(row(unpaired, "helper").code, "helper-config"); assert.equal(unpaired.outcome, "blocked");
  assert.ok(!JSON.stringify(unpaired).includes("secret token"));
  const disabledSdk = await diagnoseConnection(request(), { ...fixture({ sdk: `${packageName}/com.androiduiinspector.sdk.HierarchyProvider:\n  disabledComponents:\n    com.androiduiinspector.sdk.HierarchyProvider\n  enabledComponents:\n    SomeProvider\n` }).options, inspectionMode: "sdk-enhanced" });
  assert.equal(row(disabledSdk, "sdk").code, "sdk-disabled");
  const declared = await diagnoseConnection(request(), { ...fixture().options, inspectionMode: "sdk-enhanced" });
  assert.equal(row(declared, "sdk").code, "sdk-declared"); assert.match(row(declared, "sdk").detail, /尚未验证/);
});

test("CLI/MCP live readiness checks actual connection and authorized identity", async () => {
  for (const client of ["cli", "mcp"] as const) {
    const local = fixture();
    local.options.automationConnection = () => automationDiagnosticObservation({ shared: true, session: null, serial, packageName });
    const report = await diagnoseConnection(request({ client }), local.options);
    assert.equal(row(report, "automation").required, true); assert.equal(row(report, "automation").code, "automation-inactive");
    assert.equal(report.outcome, "blocked");
    local.options.automationConnection = () => automationDiagnosticObservation({ shared: false, session: { active: true, serial: "other", packageName }, serial, packageName });
    assert.equal(row(await diagnoseConnection(request({ client }), local.options), "automation").code, "automation-identity");
  }
});

test("an implicit foreground target is still checked against the actual automation App, and stopped connections are rechecked", async () => {
  const implicit = fixture();
  implicit.options.automationConnection = (_signal, observedPackageName) => automationDiagnosticObservation({ shared: false,
    session: { active: true, serial, packageName: "com.other.app" }, serial, packageName: observedPackageName });
  const mismatch = await diagnoseConnection(request({ packageName: undefined, client: "cli" }), implicit.options);
  assert.equal(mismatch.outcome, "blocked"); assert.equal(row(mismatch, "automation").code, "automation-identity");
  const stopped = fixture(); let reads = 0;
  stopped.options.automationConnection = () => automationDiagnosticObservation({ shared: false,
    session: { active: ++reads === 1, serial, packageName }, serial, packageName });
  const report = await diagnoseConnection(request({ client: "mcp" }), stopped.options);
  assert.equal(report.outcome, "blocked"); assert.equal(row(report, "automation").code, "automation-inactive");
});

test("device transport, Activity instance and window changes invalidate completed readiness", async () => {
  for (const inspectionMode of ["standard", "sdk-enhanced"] as const) {
    for (const values of [{ transportChange: true }, { activityChange: true }, { focusChange: true }]) {
      const report = await diagnoseConnection(request(), { ...fixture(values).options, inspectionMode });
      assert.equal(report.status, "identity_changed"); assert.equal(report.outcome, "unknown");
      assert.ok(report.checks.some(check => check.code.endsWith("-changed")));
    }
  }
});

test("a failed final identity check remains unknown, without claiming that the device changed", async () => {
  const local = fixture(); let reads = 0;
  const initialProbe = local.options.probe!;
  local.options.probe = async () => {
    const value = await initialProbe();
    if (++reads > 1) value.error = "unable to read device list";
    return value;
  };
  const report = await diagnoseConnection(request(), local.options);
  assert.equal(report.status, "completed"); assert.equal(report.outcome, "unknown");
  assert.equal(row(report, "device").code, "device-confirmation-unavailable");
});

test("cancelled or timed-out diagnostics finish without letting a late, uncancellable probe change the report", async () => {
  let finish: (value: AdbProbeResult) => void = () => {};
  const pending = new Promise<AdbProbeResult>(resolve => { finish = resolve; });
  const controller = new AbortController();
  const cancelled = diagnoseConnection(request(), { probe: () => pending, signal: controller.signal });
  controller.abort();
  const report = await cancelled, before = JSON.stringify(report);
  assert.equal(report.status, "cancelled"); assert.equal(report.outcome, "unknown");
  finish(await fixture().options.probe!());
  await Promise.resolve(); await Promise.resolve();
  assert.equal(JSON.stringify(report), before);
  const timeout = await diagnoseConnection(request({ timeoutMs: 1000 }), { probe: () => new Promise(() => {}) });
  assert.equal(timeout.status, "timed_out"); assert.equal(timeout.outcome, "unknown");
  assert.equal(row(timeout, "adb").checkedAt, null);
});
