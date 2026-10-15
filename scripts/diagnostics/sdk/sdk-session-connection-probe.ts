// Independent sample only: service cold connection, warm reconnect, same-socket reuse.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { createProviderSessionPool } from "../../../electron/sdk/provider-session";
import { getDebugTarget } from "../../../electron/device/target";
import { waitForSessionProbeRestoration } from "../../session-probe-restoration";
import type { ProviderSessionTiming } from "../../../electron/sdk/provider-session-timing";

const serial = process.argv[2];
const requestSessionTiming = process.argv[3] === "--session-timing";
assert.ok(serial && /^[\w.:-]+$/.test(serial) && (process.argv.length === 3 || process.argv.length === 4 && requestSessionTiming),
  "Usage: bun scripts/diagnostics/sdk/sdk-session-connection-probe.ts SERIAL [--session-timing]");
const pkg = "com.androiduiinspector.sample";
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args],
  { encoding: "utf8", timeout: 15000, maxBuffer: 4_000_001 });
const adbPath = "adb";
mkdirSync(".benchmarks", { recursive: true });
const output = mkdtempSync(".benchmarks/session-connection-");
const rows: object[] = [];
let previous: Awaited<ReturnType<typeof getDebugTarget>> | undefined;
let sampleOpened = false;
let forwardsBefore: string | undefined;
let verified = false;
let failure: unknown;
const save = (extra: object) => writeFileSync(`${output}/report.json`, JSON.stringify({
  scope: "independent sample service setup and tree requests; not business cold-start, pixels or full capture acceptance",
  rows, ...extra,
}, null, 2));
const provider = createProviderSessionPool();
try {
  previous = await getDebugTarget(serial);
  assert.ok(previous.packageName === pkg || previous.packageName === "com.smile.gifmaker",
    "keep unrelated foreground apps out of the sample test");
  forwardsBefore = adb("forward", "--list").trim();
  adb("shell", "run-as", pkg, "id");
  if (previous.packageName !== pkg) {
    adb("shell", "am", "start", "-n", `${pkg}/.MainActivity`, "--es", "mode", "session-connection");
    sampleOpened = true;
  }
  const deadline = performance.now() + 5000;
  let target;
  while (!target && performance.now() < deadline) {
    try { target = await getDebugTarget(serial, pkg, AbortSignal.timeout(2000)); }
    catch { await wait(100); }
  }
  assert.ok(target, "sample did not acquire authorized focus");
  const pid = adb("shell", "pidof", pkg).trim();
  assert.match(pid, /^\d+$/, "sample must have one process");
  // Raw content control closes only this sample service; never close the business service.
  const closed = adb("shell", "content", "call", "--uri", `content://${pkg}.inspector`, "--method", "close-session");
  assert.match(closed, /result=ok/);
  let instance: string | undefined, rootHash: string | undefined;
  for (const name of ["cold-service", "warm-reconnect", "same-connection"] as const) {
    if (name !== "same-connection") await provider.releaseAll();
    assert.equal(adb("shell", "pidof", pkg).trim(), pid);
    const current = await getDebugTarget(serial, pkg);
    assert.equal(current.component, target.component); assert.equal(current.windowId, target.windowId);
    const timings: Record<string, number> = {}, startedAt = performance.now();
    const diagnostic: { startedAt: number; timings: Record<string, number>; requestSessionTiming: boolean; sessionTiming?: ProviderSessionTiming } = { startedAt, timings, requestSessionTiming };
    const reply = await provider.call(adbPath, serial, pkg, "capture", randomUUID(), null, 5000, false,
      AbortSignal.timeout(15000), undefined, diagnostic);
    const durationMs = Math.round(performance.now() - startedAt);
    assert.equal(reply.code, 0); assert.match(reply.stdout.toString(), /result=ok/);
    const raw = adb("exec-out", "run-as", pkg, "head", "-c", "4000001", "no_backup/inspector-hierarchy.json");
    const tree = JSON.parse(raw);
    assert.equal(tree.packageName, pkg); assert.equal(String(tree.pid), pid);
    assert.ok(typeof tree.processInstance === "string" && tree.root);
    const hash = createHash("sha256").update(JSON.stringify(tree.root)).digest("hex");
    instance ??= tree.processInstance; rootHash ??= hash;
    const row = { name, durationMs, timings, pid, instance: tree.processInstance, rootHash: hash,
      ...(requestSessionTiming ? { sessionTiming: diagnostic.sessionTiming } : {}) };
    rows.push(row); save({ passed: false }); console.log(JSON.stringify(row));
    assert.equal(tree.processInstance, instance); assert.equal(hash, rootHash, "tree objects/geometry/properties changed");
    assert.ok(durationMs < 5000, "unhealthy connection; stop instead of retrying");
    assert.equal(timings["SDK 当前连接启动服务"], name === "cold-service" ? 1 : 0);
    if (requestSessionTiming) {
      const status = diagnostic.sessionTiming?.status;
      assert.ok(name === "cold-service" ? status === "available" || status === "unsupported" : status === "not-started",
        "startup timing missing or invalid; do not reinterpret it as zero");
    }
    // Historical connection phases, not additional work for every tree request.
    const phaseKeys = ["SDK 当前连接首次探测", "SDK 当前连接兼容启动", "SDK 当前连接启动后核验"];
    const phaseTotal = phaseKeys.reduce((total, key) => {
      assert.ok(Number.isFinite(timings[key]) && timings[key] >= 0, `missing or invalid phase: ${key}`);
      return total + timings[key];
    }, 0);
    assert.ok(Math.abs(phaseTotal - timings["SDK 当前连接建立耗时"]) <= 10,
      "phase sum differs from historical connection setup");
    if (name !== "cold-service") {
      assert.equal(timings["SDK 当前连接兼容启动"], 0);
      assert.equal(timings["SDK 当前连接启动后核验"], 0);
    }
    if (name === "same-connection") {
      const warm = rows[1] as { timings: Record<string, number> };
      for (const key of [...phaseKeys, "SDK 当前连接建立耗时"])
        assert.equal(timings[key], warm.timings[key], "same socket must retain historical setup timings");
    }
    if (name === "cold-service") {
      await provider.releaseAll();
      assert.equal(adb("forward", "--list").trim(), forwardsBefore);
    }
  }
  await provider.releaseAll();
  assert.equal(adb("forward", "--list").trim(), forwardsBefore);
  const after = await getDebugTarget(serial, pkg);
  assert.equal(after.windowId, target.windowId); assert.equal(adb("shell", "pidof", pkg).trim(), pid);
  verified = true;
} catch (error) {
  failure = error;
} finally {
  try {
    await provider.dispose();
    if (forwardsBefore !== undefined) assert.equal(adb("forward", "--list").trim(), forwardsBefore);
    if (sampleOpened && previous) {
      const original = previous;
      adb("shell", "am", "start", "--activity-reorder-to-front", "-n", original.component);
      const restored = await waitForSessionProbeRestoration(original,
        signal => getDebugTarget(serial, original.packageName, signal));
      assert.equal(restored.component, original.component); assert.equal(restored.windowId, original.windowId);
    }
  } catch (error) { failure ??= error; }
  console.log(`Session connection report: ${output}`);
}
save({ passed: verified && failure === undefined,
  ...(failure === undefined ? {} : { error: failure instanceof Error ? failure.message : String(failure) }) });
if (failure !== undefined) throw failure;
