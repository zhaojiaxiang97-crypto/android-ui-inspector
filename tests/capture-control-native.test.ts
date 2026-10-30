import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createNativeCaptureControl, controlCompetingWork } from "../scripts/capture-control-native";
import { helperCapabilities } from "./fixtures/helper-protocol";
import { entryFixture } from "./fixtures/capture-control-entry";
import { matrixLimits } from "../scripts/capture-control-protocol";
import type { CommandResult } from "../electron/device/runtime";

const viewport = "Viewport INTERNAL: displayId=0, orientation=0, logicalFrame=[0, 0, 1080, 2400], isActive=[1]";
function nativeFixture() {
  const h = entryFixture(); mkdirSync(h.config.runDirectory);
  let helperPid = 100, now = 1_000_000, paired = true, authorization = true, disconnected = false, competing = false;
  let certificate = "a".repeat(64), helperHash = h.config.helper.sha256, rotation = 0;
  const calls: { command: string; args: string[] }[] = [], forwarding = new Map<string, string>();
  const result = (stdout = "", code = 0): CommandResult => ({ code, stdout: Buffer.from(stdout), stderr: "" });
  const platform = createNativeCaptureControl(h.config, { findAdb: () => h.config.adbPath, now: () => now,
    authorize: async (_chunk, signal) => { signal.throwIfAborted(); h.events.push("authorize"); return authorization; },
    fetch: (async () => paired ? Response.json(helperCapabilities) : new Response("", { status: 401 })) as typeof fetch,
    execute: async (command, input, _timeout, signal) => {
      signal.throwIfAborted(); calls.push({ command, args: [...input] }); now += 10;
      if (disconnected) throw Error("offline transport injection");
      if (command === "/bin/ps") return result(competing ? "999999 bun test tests/private.test.ts" : "");
      if (command === h.config.apksignerPath) return result("Signer #1 certificate SHA-256 digest: " + certificate);
      assert.equal(command, h.config.adbPath);
      assert.deepEqual(input.slice(0, 2), ["-s", h.config.serial]); const args = input.slice(2), text = args.join(" ");
      if (text === "forward --list") return result([h.baseline.forwards, ...[...forwarding].map(([port, remote]) => `${h.config.serial} ${port} ${remote}`)].join("\n"));
      if (args[0] === "forward") {
        if (args[1] === "--remove") forwarding.delete(args[2]);
        else if (args[1] === "--no-rebind") { assert(!forwarding.has(args[2])); forwarding.set(args[2], args[3]); }
        else forwarding.set(args[1], args[2]); return result();
      }
      if (text.startsWith("shell pm path ")) return result("package:/data/app/fixture/" + (text.endsWith(h.config.packageName) ? "sample.apk" : "helper.apk"));
      if (text.startsWith("shell sha256sum ")) return result((text.endsWith("sample.apk") ? h.config.sample.sha256 : helperHash) + " path");
      if (text.startsWith("shell dumpsys package ")) return result("flags=[ DEBUGGABLE ]");
      if (text === "shell dumpsys input") return result(viewport.replace("orientation=0", "orientation=" + rotation));
      if (text === "shell dumpsys accessibility") return result("A11yWindow[AccessibilityWindowInfo[id=7, displayId=0, type=TYPE_APPLICATION, layer=1, focused=true, active=true, hasParent=false, transitionTime=100, bounds=Rect(0, 0 - 1080, 2400)]]");
      if (text === "shell dumpsys window") return result(`mCurrentFocus=Window{abc u0 ${h.config.packageName}/.Main}`);
      if (text === "shell cat /proc/sys/kernel/random/boot_id") return result(h.baseline.bootId);
      if (text.startsWith("shell settings get ")) return result(h.baseline.settings[args[3] + "/" + args[4]]);
      if (text === "shell perfetto --query") return result("Tracing sessions: 0 (started: 0)");
      if (text === "shell pidof simpleperf") return result("", 1);
      if (text.startsWith("shell pidof ")) return result(String(helperPid));
      if (text.startsWith("install -r ")) { helperPid++; helperHash = h.config.helper.sha256; paired = false; return result("Success"); }
      if (text.startsWith("shell am start ")) return result("Status: ok");
      throw Error("Unexpected offline command: " + text);
    } });
  return { ...h, platform, calls, forwarding, now: () => now,
    set: (v: { paired?: boolean; authorization?: boolean; disconnected?: boolean; competing?: boolean; certificate?: string; helperHash?: string; rotation?: number }) => {
      if (v.paired !== undefined) paired = v.paired; if (v.authorization !== undefined) authorization = v.authorization;
      if (v.disconnected !== undefined) disconnected = v.disconnected; if (v.competing !== undefined) competing = v.competing;
      if (v.certificate !== undefined) certificate = v.certificate; if (v.helperHash !== undefined) helperHash = v.helperHash;
      if (v.rotation !== undefined) rotation = v.rotation;
    },
    async close() { await platform.closeSessions(AbortSignal.timeout(1000)).catch(() => {}); await platform.dispose(); h.dispose(); } };
}

test("concrete preflight verifies frozen hashes/signatures/device state using only injected transport", async () => {
  const h = nativeFixture(); try {
    const baseline = await h.platform.preflight(AbortSignal.timeout(3000)); assert.deepEqual(baseline, h.baseline);
    assert(h.calls.some(c => c.args[0] === "verify"));
    assert(!h.calls.some(c => c.args.includes("install"))); assert(!h.calls.some(c => c.args[2] === "shell" && c.args[3] === "input"));
  } finally { await h.close(); }
});
test("bad frozen source or signing certificate is rejected before device commands", async () => {
  const h = nativeFixture(); try {
    h.set({ certificate: "b".repeat(64) }); await assert.rejects(h.platform.preflight(AbortSignal.timeout(3000)), /certificate/);
    assert(!h.calls.some(c => c.command === h.config.adbPath));
    h.calls.length = 0; writeFileSync(h.config.sources[0].path, "changed");
    await assert.rejects(h.platform.preflight(AbortSignal.timeout(3000)), /source/); assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});
test("new PID returns immediately, then missing pairing waits without constructing/granting a session", async () => {
  const h = nativeFixture(); try {
    const prepared = await h.platform.ports.prepare("Q1", AbortSignal.timeout(3000));
    assert.equal(prepared.helperPid, 101); assert.equal(prepared.processReadyMs, h.now()); assert.equal(prepared.identity, undefined);
    assert.deepEqual(h.calls.at(-1)!.args.slice(2), ["shell", "pidof", "com.androiduiinspector.a11yhelper"]);
    const chunk = { id: "Q1-initial", directory: join(h.config.runDirectory, "recordings"), limits: matrixLimits };
    assert.equal(await h.platform.ports.session(chunk, AbortSignal.timeout(3000)), null); assert.deepEqual(h.events, []);
    h.set({ paired: true }); const session = await h.platform.ports.session(chunk, AbortSignal.timeout(3000)); assert(session);
    assert.equal(session.state.packageName, h.config.packageName); assert.equal(session.state.androidLogsEnabled, false);
    const identity = await h.platform.ports.identity(AbortSignal.timeout(3000)); assert.equal(identity.helperPid, prepared.helperPid);
    assert.equal(identity.serviceId, helperCapabilities.serviceInstanceId); assert.equal(identity.nodeCounts.large, 758);
    assert.equal(h.forwarding.size, 0);
  } finally { await h.close(); }
});
test("denied authorization never creates a debug session or sends input", async () => {
  const h = nativeFixture(); try {
    await h.platform.ports.prepare("Q1", AbortSignal.timeout(3000)); h.set({ paired: true, authorization: false });
    await assert.rejects(h.platform.ports.session({ id: "Q1", directory: join(h.config.runDirectory, "records"), limits: matrixLimits }, AbortSignal.timeout(3000)), /grant_denied/);
    assert.equal(h.events.filter(e => e === "authorize").length, 1); assert.equal(h.forwarding.size, 0);
  } finally { await h.close(); }
});
test("transport disconnection remains a fixed failure and is not converted into a pairing retry", async () => {
  const h = nativeFixture(); try {
    h.set({ disconnected: true });
    await assert.rejects(h.platform.ports.session({ id: "Q1", directory: h.config.runDirectory, limits: matrixLimits }, AbortSignal.timeout(3000)), /transport_disconnected/);
    assert.deepEqual(h.events, []);
  } finally { await h.close(); }
});
test("same original packages restore by verification; a changed Helper uses only the frozen APK", async () => {
  const h = nativeFixture(); try {
    await h.platform.restorePackages(h.baseline, AbortSignal.timeout(3000)); assert(!h.calls.some(c => c.args.includes("install")));
    h.set({ helperHash: "b".repeat(64) }); await h.platform.restorePackages(h.baseline, AbortSignal.timeout(3000));
    const installs = h.calls.filter(c => c.args.includes("install")); assert.equal(installs.length, 1); assert.equal(installs[0].args.at(-1), h.config.helper.path);
    await assert.rejects(h.platform.restorePairing(h.baseline, AbortSignal.timeout(3000)), /原包配对未确认/);
    h.set({ paired: true }); await h.platform.restorePairing(h.baseline, AbortSignal.timeout(3000)); assert.equal(h.forwarding.size, 0);
  } finally { await h.close(); }
});
test("changed restore file cannot be installed; foreign forwards are retained and never removed-all", async () => {
  const h = nativeFixture(); try {
    writeFileSync(h.config.helper.path, "foreign apk");
    await assert.rejects(h.platform.restorePackages(h.baseline, AbortSignal.timeout(3000)), /restore artifact/);
    h.forwarding.set("tcp:19999", "tcp:8888");
    await assert.rejects(h.platform.verifyForwards(h.baseline, AbortSignal.timeout(3000)), /unverified/);
    assert.equal(h.forwarding.get("tcp:19999"), "tcp:8888"); assert(!h.calls.some(c => c.args.includes("--remove-all")));
    const logs = readFileSync(join(h.config.runDirectory, readdirSync(h.config.runDirectory).find(f => f.startsWith("commands-"))!), "utf8");
    assert(!logs.includes("offline_token_not_a_device_123456"));
  } finally { await h.close(); }
});
test("fixture page readiness retains the existing complete system-window checks and bounds", async () => {
  const h = nativeFixture(); try {
    await h.platform.ports.ready("large", AbortSignal.timeout(3000));
    const command = h.calls.find(c => c.args.includes("/.TraversalDiagnosticsActivity") || c.args.some(a => a.endsWith("/.TraversalDiagnosticsActivity")));
    assert(command?.args.includes("virtual750")); assert(command?.args.includes("false"));
    assert(h.calls.filter(c => c.args.includes("accessibility")).length >= 2);
  } finally { await h.close(); }
});
test("quiet checks reject competing builds and keep all input/settings-write commands absent", async () => {
  const h = nativeFixture(); try {
    for (const text of ["bun test tests/x.ts", "npm run build", "/path/gradlew assembleDebug", "node /x/tsc --noEmit"]) assert(controlCompetingWork(text));
    assert(!controlCompetingWork("node capture-control-launch.cjs --execute-isolated"));
    h.set({ competing: true }); await assert.rejects(h.platform.ports.quiet(AbortSignal.timeout(3000)), /competing_work/);
    assert(!h.calls.some(c => c.args[2] === "shell" && c.args[3] === "input" || c.args.includes("put")));
  } finally { await h.close(); }
});
