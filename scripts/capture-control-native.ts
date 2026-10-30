import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { DebugSession } from "../electron/automation/debug-session";
import { observeDebugApp, waitDebugAppCondition, type DebugObserver } from "../electron/automation/device-actions";
import { createAccessibilityHelperSession } from "../electron/capture/helper-session";
import { readHelperToken } from "../electron/capture/accessibility-helper";
import { readHelperCapabilities } from "../electron/capture/helper-observation";
import { openOwnedDebugForward } from "../electron/platform/owned-debug-forward";
import { findAdbPath, runCommand, type CommandResult } from "../electron/device/runtime";
import { withCommandSignal } from "../electron/device/command-context";
import { parseInputDisplay } from "../electron/device/capture-display";
import { callLiveBridge } from "../electron/automation/mcp-live";
import type { ProviderClient } from "../electron/sdk/provider-session";
import { ControlEntryFault, type CaptureControlConfig, type CaptureControlPlatform } from "./capture-control-entry";
import type { ControlIdentity } from "./capture-control-driver";
import { CONTROL } from "./capture-control-protocol";
import { closeControlSession } from "./capture-control-session";
import { parseObservationReadiness, waitForObservationReadiness } from "./capture-control-readiness";

const helperPackage = "com.androiduiinspector.a11yhelper";
const settingKeys = ["system/accelerometer_rotation", "system/user_rotation", "global/window_animation_scale", "global/transition_animation_scale", "global/animator_duration_scale"];
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (path: string) => existsSync(path) ? sha(readFileSync(path)) : null;
export function controlCompetingWork(command: string) {
  return /(?:^|\/|\s)(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:test(?::[\w-]+)?|build(?::[\w-]+)?)\b/.test(command)
    || /(?:^|\/|\s)(?:tsc|vite|vitest|jest|gradlew)(?:\.js)?(?:\s|$)/.test(command);
}
export type NativeControlDependencies = {
  execute?: (command: string, args: string[], timeoutMs: number, signal: AbortSignal) => Promise<CommandResult>;
  authorize: (chunk: string, signal: AbortSignal) => Promise<boolean>;
  now?: () => number;
  findAdb?: () => string | null;
  fetch?: typeof fetch;
};

/** Concrete wiring, inert on import. Only the separately guarded Electron launcher calls it on a device. */
export function createNativeCaptureControl(config: CaptureControlConfig, dependencies: NativeControlDependencies): CaptureControlPlatform {
  const execute = dependencies.execute ?? ((command, args, timeout, signal) => withCommandSignal(signal, () => runCommand(command, args, timeout)));
  const now = dependencies.now ?? Date.now, sessions = new Set<DebugSession>(), closers = new Set<() => Promise<void>>();
  const stopped = new AbortController(), commandFile = join(config.runDirectory, `commands-${randomUUID()}.jsonl`);
  let timer: ReturnType<typeof setInterval> | undefined, quietPending: Promise<void> | undefined, due = 0, stageHasSession = false;
  const call = async (command: string, args: string[], signal: AbortSignal, timeout = 5000, allowFailure = false) => {
    signal.throwIfAborted(); const start = performance.now();
    let result: CommandResult;
    try { result = await execute(command, args, timeout, signal); }
    catch {
      if (signal.aborted) throw new ControlEntryFault("operation_cancelled_or_timed_out");
      throw new ControlEntryFault(command === config.adbPath ? "transport_disconnected" : "host_command_failed");
    }
    if (result.stdout.length > 2_000_000) throw new ControlEntryFault("device_reply_capacity");
    if (statSync(commandFile, { throwIfNoEntry: false })?.size! > 2 * 1024 * 1024) throw new ControlEntryFault("command_archive_capacity");
    appendFileSync(commandFile, JSON.stringify({ at: now(), command: command === config.adbPath ? "adb" : "host",
      argumentsSha256: sha(JSON.stringify(args)), code: result.code, wallMs: performance.now() - start }) + "\n", { mode: 0o600 });
    if (result.code !== 0 && !allowFailure) {
      const disconnected = /device (?:offline|not found)|no devices|closed|disconnected/i.test(result.stderr + result.stdout.toString());
      throw new ControlEntryFault(command !== config.adbPath ? "host_command_failed" : disconnected ? "transport_disconnected" : "device_command_failed");
    }
    return result;
  };
  const adb = async (args: string[], signal: AbortSignal, timeout?: number, allowFailure = false) =>
    (await call(config.adbPath, ["-s", config.serial, ...args], signal, timeout, allowFailure)).stdout.toString("utf8").trim();
  const pid = async (signal: AbortSignal) => {
    const value = await adb(["shell", "pidof", helperPackage], signal);
    if (!/^[1-9]\d*$/.test(value)) throw new ControlEntryFault("helper_pid_ambiguous"); return Number(value);
  };
  const frame = async (signal: AbortSignal) => parseInputDisplay(await adb(["shell", "dumpsys", "input"], signal));
  const installed = async (name: string, signal: AbortSignal) => {
    const path = await adb(["shell", "pm", "path", name], signal);
    assert(/^package:\/data\/app\/[\w/+=~.-]+\.apk$/.test(path), "Installed APK path is not unique");
    const hash = (await adb(["shell", "sha256sum", path.slice(8)], signal)).split(/\s+/)[0];
    assert(/^[a-f0-9]{64}$/.test(hash)); return hash;
  };
  const forwardList = async (signal: AbortSignal) => (await adb(["forward", "--list"], signal)).split("\n").filter(Boolean).sort().join("\n");
  const capabilities = async (signal: AbortSignal) => {
    const forward = await openOwnedDebugForward(config.serial, "tcp:18888", signal,
      async (args, timeout, s) => (await call(config.adbPath, args, s ?? AbortSignal.timeout(timeout), timeout)).stdout.toString());
    closers.add(forward.close);
    try { return await readHelperCapabilities(forward.port, readHelperToken(config.tokenFile), signal, dependencies.fetch); }
    finally { await forward.close(); closers.delete(forward.close); }
  };
  const settings = async (signal: AbortSignal) => {
    const rows: [string, string][] = [];
    for (const key of settingKeys) { const [group, name] = key.split("/"); rows.push([key, await adb(["shell", "settings", "get", group, name], signal)]); }
    return Object.fromEntries(rows);
  };
  const quietHost = async (signal: AbortSignal) => {
    const processes = (await call("/bin/ps", ["-axo", "pid=,command="], signal, 1500)).stdout.toString("utf8").split("\n");
    if (processes.some(line => { const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      return m && ![process.pid, process.ppid].includes(Number(m[1])) && controlCompetingWork(m[2]); })) throw new ControlEntryFault("competing_work");
  };
  const quiet = async (signal: AbortSignal) => {
    stopped.signal.throwIfAborted(); await quietHost(signal);
    const trace = await adb(["shell", "perfetto", "--query"], signal);
    assert(/Tracing sessions: 0 \(started: 0\)/.test(trace), "Existing trace prevents sampling");
    const sampler = await call(config.adbPath, ["-s", config.serial, "shell", "pidof", "simpleperf"], signal, 5000, true);
    assert(sampler.code === 1 && !sampler.stdout.toString().trim(), "Existing CPU sampler prevents sampling");
  };
  const provider: ProviderClient = { open: async () => { throw new ControlEntryFault("unexpected_sdk_backend"); },
    call: async () => { throw new ControlEntryFault("unexpected_sdk_backend"); } };
  const identity = async (signal: AbortSignal): Promise<ControlIdentity> => {
    const helperPid = await pid(signal), cap = await capabilities(signal);
    const display = await frame(signal); assert(display);
    const helperSha256 = await installed(helperPackage, signal), appSha256 = await installed(config.packageName, signal);
    assert.equal(helperSha256, config.helper.sha256); assert.equal(appSha256, config.sample.sha256);
    return { serial: config.serial, packageName: config.packageName, helperPid, serviceId: cap.serviceInstanceId,
      helperSha256, appSha256, bootId: await adb(["shell", "cat", "/proc/sys/kernel/random/boot_id"], signal),
      ...display, rotation: display.rotation as 0, nodeCounts: { small: 69, large: 758 }, selectors: {
        small: config.packageName + ":id/input_diagnostics_main_page", large: config.packageName + ":id/traversal_diagnostics_shape" } };
  };
  const platform: CaptureControlPlatform = {
    ports: {
      prepare: async (_stage, signal) => {
        await quiet(signal); const before = await pid(signal);
        await adb(["install", "-r", config.helper.path], signal, 60_000);
        await adb(["shell", "am", "start", "-W", "-n", helperPackage + "/com.artemis.helper.InspectorPairingActivity"], signal);
        const helperPid = await pid(signal), processReadyMs = now(); assert.notEqual(helperPid, before);
        due = processReadyMs + CONTROL.holdMs; stageHasSession = false;
        if (!timer) { timer = setInterval(() => {
          if (!quietPending) quietPending = quietHost(AbortSignal.timeout(2000)).catch(error => stopped.abort(error)).finally(() => { quietPending = undefined; });
        }, 2000); timer.unref(); }
        return { helperPid, processReadyMs };
      },
      identity, quiet,
      ready: async (page, signal) => {
        stopped.signal.throwIfAborted();
        await adb(["shell", "am", "start", "-W", "-S", "-n", config.packageName + (page === "small" ? "/.InputDiagnosticsActivity" : "/.TraversalDiagnosticsActivity"),
          ...(page === "large" ? ["--es", "shape", "virtual750", "--ez", "profileProvider", "false"] : []), "--ez", "parcelAudit", "false"], signal);
        const readiness = await waitForObservationReadiness({ signal, read: async remaining => {
          const start = performance.now();
          const a11y = await adb(["shell", "dumpsys", "accessibility"], signal, Math.min(1200, remaining));
          const window = await adb(["shell", "dumpsys", "window"], signal, Math.max(1, Math.min(1200, remaining - Math.ceil(performance.now() - start))));
          return parseObservationReadiness(a11y, window, config.packageName);
        } });
        if (!readiness.ready) throw new ControlEntryFault("fixture_not_ready");
      },
      session: async (chunk, signal) => {
        stopped.signal.throwIfAborted();
        try { await capabilities(signal); } catch (error) {
          if (error instanceof Error && /HTTP 401\b/.test(error.message)) return null;
          throw error;
        }
        const budget = !stageHasSession ? due - CONTROL.readyLeadMs - now() : 30_000;
        if (budget <= 0) throw new ControlEntryFault("grant_deadline_missed");
        const grantSignal = AbortSignal.any([signal, stopped.signal, AbortSignal.timeout(Math.ceil(budget))]);
        let authorized: boolean;
        try { authorized = await dependencies.authorize(chunk.id, grantSignal); }
        catch (error) { if (grantSignal.aborted && !signal.aborted) throw new ControlEntryFault("grant_deadline_missed"); throw error; }
        if (grantSignal.aborted && !signal.aborted) throw new ControlEntryFault("grant_deadline_missed");
        if (!authorized) throw new ControlEntryFault("grant_denied");
        grantSignal.throwIfAborted();
        let helper: ReturnType<typeof createAccessibilityHelperSession>;
        const observe: DebugObserver = (device, packageName, mode, s, backend, screenshotTiming) => {
          stopped.signal.throwIfAborted();
          assert(mode === "fast" && backend === "accessibility-helper");
          return observeDebugApp(provider, device, packageName, mode, AbortSignal.any([stopped.signal, ...(s ? [s] : [])]), backend, "standard", screenshotTiming, helper);
        };
        const session = new DebugSession({ serial: config.serial, packageName: config.packageName, directory: chunk.directory,
          snapshotPath: join(chunk.directory, "snapshot.json"), androidLogs: false, recordingLimits: chunk.limits,
          observe, input: async () => { throw new ControlEntryFault("diagnostic_input_forbidden"); }, onEvent: () => {},
          createObserver: (sessionId, lifetime) => {
            helper = createAccessibilityHelperSession({ sessionId, serial: config.serial, signal: lifetime }, { readToken: () => readHelperToken(config.tokenFile) });
            closers.add(helper.close);
            return Object.assign(observe, { waitForCondition: waitDebugAppCondition(helper), close: helper.close });
          } });
        sessions.add(session); stageHasSession = true; return session;
      },
    },
    preflight: async signal => {
      assert.equal(realpathSync(config.adbPath), realpathSync((dependencies.findAdb ?? findAdbPath)()!), "Observer ADB must match the frozen executable");
      for (const source of config.sources) assert.equal(fileHash(source.path), source.sha256, "Frozen source changed");
      for (const artifact of [config.helper, config.sample]) {
        assert.equal(fileHash(artifact.path), artifact.sha256, "Frozen APK changed");
        const cert = (await call(config.apksignerPath, ["verify", "--print-certs", artifact.path], signal)).stdout.toString();
        const certificates = [...cert.matchAll(/Signer #\d+ certificate SHA-256 digest:\s*([a-fA-F0-9]{64})/g)].map(m => m[1].toLowerCase());
        assert.deepEqual(certificates, [artifact.certificateSha256], "APK signing certificate changed");
      }
      const desktopFiles = [config.desktopSnapshotPath, config.desktopSnapshotPath + ".live"].map(path => ({ path, sha256: fileHash(path) }));
      if (desktopFiles[1].sha256) {
        const state = await callLiveBridge(config.desktopSnapshotPath, { name: "get_debug_session", input: {} }, signal);
        assert(state.active === false, "End the existing desktop grant first");
      }
      readHelperToken(config.tokenFile); await quiet(signal);
      const baseline = { helperSha256: await installed(helperPackage, signal), sampleSha256: await installed(config.packageName, signal),
        bootId: await adb(["shell", "cat", "/proc/sys/kernel/random/boot_id"], signal), settings: await settings(signal), forwards: await forwardList(signal), desktopFiles };
      assert.equal(baseline.helperSha256, config.helper.sha256); assert.equal(baseline.sampleSha256, config.sample.sha256);
      for (const name of [helperPackage, config.packageName]) assert(/flags=\[ [^\n]*DEBUGGABLE/.test(await adb(["shell", "dumpsys", "package", name], signal)), "Debug condition changed");
      assert.deepEqual(await frame(signal), { width: 1080, height: 2400, rotation: 0 });
      assert(settingKeys.filter(k => k.startsWith("global/")).every(k => baseline.settings[k] === "1.0"));
      return baseline;
    },
    closeSessions: async () => {
      if (timer) clearInterval(timer); timer = undefined; await quietPending;
      const results = await Promise.allSettled([...sessions].map(session => closeControlSession(session)));
      const forwarded = await Promise.allSettled([...closers].map(close => close()));
      if ([...results, ...forwarded].some(r => r.status === "rejected")) throw new ControlEntryFault("owned_cleanup_failed");
    },
    restorePackages: async (baseline, signal) => {
      for (const [name, artifact, expected] of [[helperPackage, config.helper, baseline.helperSha256], [config.packageName, config.sample, baseline.sampleSha256]] as const) {
        assert.equal(fileHash(artifact.path), expected, "Original restore artifact changed");
        if (await installed(name, signal) !== expected) await adb(["install", "-r", artifact.path], signal, 60_000);
        assert.equal(await installed(name, signal), expected, "Original APK restore unverified");
      }
    },
    restorePairing: async (_baseline, signal) => { try { await capabilities(signal); }
      catch {
        await adb(["shell", "am", "start", "-W", "-n", helperPackage + "/com.artemis.helper.InspectorPairingActivity"], signal);
        throw new ControlEntryFault("pairing_required", "原包配对未确认；请在已打开的配对页手动配对后仅重试恢复，不重跑采样。");
      } },
    verifySettings: async (baseline, signal) => {
      for (const source of config.sources) assert.equal(fileHash(source.path), source.sha256, "Frozen source changed during entry");
      assert.equal(await adb(["shell", "cat", "/proc/sys/kernel/random/boot_id"], signal), baseline.bootId);
      assert.deepEqual(await settings(signal), baseline.settings);
      assert.deepEqual(baseline.desktopFiles.map(s => ({ path: s.path, sha256: fileHash(s.path) })), baseline.desktopFiles);
    },
    verifyForwards: async (baseline, signal) => { assert.equal(await forwardList(signal), baseline.forwards, "Forward restore unverified; foreign forwards are never removed"); },
    dispose: async () => { if (timer) clearInterval(timer); await quietPending; },
  };
  return platform;
}
