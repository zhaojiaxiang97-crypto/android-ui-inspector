import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CaptureControlConfig, CaptureControlPlatform, RecoveryBaseline } from "../../scripts/capture-control-entry";
import type { runCaptureControlStudy } from "../../scripts/capture-control-driver";
import { writePrivateJson } from "../../electron/automation/mcp-snapshot";
import { CONTROL } from "../../scripts/capture-control-protocol";

export const entrySha = (s: Buffer | string) => createHash("sha256").update(s).digest("hex");
export function entryFixture() {
  const evidence = process.env.INSPECTOR_ENTRY_OFFLINE_EVIDENCE;
  if (evidence) mkdirSync(evidence, { recursive: true });
  const directory = realpathSync(mkdtempSync(join(evidence ?? tmpdir(), "capture-entry-offline-")));
  const file = (name: string, content: string) => { const path = join(directory, name); writeFileSync(path, content, { flag: "wx", mode: 0o600 }); return path; };
  const helperPath = file("helper.apk", "offline-original-helper"), samplePath = file("sample.apk", "offline-original-sample");
  const config: CaptureControlConfig = { version: 1, runDirectory: join(directory, "run"), serial: "DEVICE_SERIAL", packageName: "com.androiduiinspector.sdkfree",
    adbPath: file("adb", "offline-only"), apksignerPath: file("apksigner", "offline-only"), tokenFile: file("pairing.token", "offline_token_not_a_device_123456"),
    desktopSnapshotPath: join(directory, "untouched-desktop.json"),
    helper: { path: helperPath, sha256: entrySha("offline-original-helper"), certificateSha256: "a".repeat(64) },
    sample: { path: samplePath, sha256: entrySha("offline-original-sample"), certificateSha256: "a".repeat(64) },
    sources: Array.from({ length: 6 }, (_, i) => ({ path: file(`source-${i}.ts`, "offline-source-" + i), sha256: entrySha("offline-source-" + i) })) };
  const baseline: RecoveryBaseline = { helperSha256: config.helper.sha256, sampleSha256: config.sample.sha256, bootId: randomUUID(),
    settings: { "system/accelerometer_rotation": "0", "system/user_rotation": "0", "global/window_animation_scale": "1.0", "global/transition_animation_scale": "1.0", "global/animator_duration_scale": "1.0" },
    forwards: "OTHER tcp:10000 tcp:9999", desktopFiles: [config.desktopSnapshotPath, config.desktopSnapshotPath + ".live"].map(path => ({ path, sha256: null })) };
  const events: string[] = [], faults = new Map<string, Error>();
  const action = async (name: string) => { events.push(name); if (faults.has(name)) throw faults.get(name)!; };
  const platform: CaptureControlPlatform = {
    ports: { prepare: async () => { throw Error("No device in offline fixture"); }, identity: async () => { throw Error("No device"); },
      quiet: async () => {}, ready: async () => {}, session: async () => null },
    preflight: async () => { await action("preflight"); return structuredClone(baseline); },
    closeSessions: () => action("sessions"), restorePackages: () => action("packages"), restorePairing: () => action("pairing"),
    verifySettings: () => action("settings"), verifyForwards: () => action("forwards"), dispose: () => action("dispose"),
  };
  const syntheticStudy: typeof runCaptureControlStudy = async options => {
    await action("study"); mkdirSync(options.directory, { mode: 0o700 });
    const result = { runId: randomUUID(), scope: options.qualificationOnly ? "qualification-only" : "full-control",
      status: "passed", failure: null, failureCode: null, offlineOnly: true, actualDeviceSamples: 0,
      startedMs: 0, finishedMs: 0, constants: CONTROL, plannedFrames: options.qualificationOnly ? 48 : 288,
      referenceGapMatched: null, overheadPassed: null, stages: [] };
    writePrivateJson(join(options.directory, "study.json"), result);
    return { ...result, manifestPath: join(options.directory, "study.json") };
  };
  return { directory, config, baseline, platform, events, faults, syntheticStudy,
    dispose() { if (!evidence) rmSync(directory, { recursive: true, force: true }); } };
}
