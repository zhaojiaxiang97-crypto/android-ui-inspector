// Bounded whole-page production captures. No navigation, restart or installation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProviderSessionPool } from "../electron/sdk/provider-session";
import { inspectPreferredDevice } from "../electron/capture/inspection";
import { businessSettingsPid } from "./business-process";
import { parseProcessLoad } from "./diagnostics/sdk/sdk-device-load";
import { compareSmallPageRoutes, smallPageRouteSummary } from "./small-page-route-summary";

const serial = process.argv[2];
const mode = process.argv[3] ?? "--order=ddms-first";
assert.ok(serial && /^[\w.:-]+$/.test(serial) && process.argv.length <= 4
  && ["--order=ddms-first", "--order=sdk-first", "--order=abba"].includes(mode),
  "Usage: bun scripts/small-page-route-probe.ts SERIAL [--order=ddms-first|sdk-first|abba]");
const order = mode === "--order=abba" ? [false, true, true, false] : mode === "--order=sdk-first" ? [true, false] : [false, true];
const pkg = "com.smile.gifmaker";
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8", timeout: 15000, maxBuffer: 2000000 });
const base = join(import.meta.dirname, "../.benchmarks"); mkdirSync(base, { recursive: true });
const output = mkdtempSync(join(base, "small-page-routes-"));
const rows: { round: number; route: string; durationMs: number; previews: { phase: string; receivedMs: number; images: number }[];
  result: ReturnType<typeof smallPageRouteSummary> }[] = [];
const save = (extra: object) => writeFileSync(join(output, "report.json"), JSON.stringify({ rows,
  order: mode, scope: "bounded sequential settings-page captures; not same-frame pixel or stable performance acceptance", ...extra }, null, 2));
console.log(`Route comparison: ${output}`);
const provider = createProviderSessionPool();
try {
  const pid = businessSettingsPid(adb, pkg);
  const ticks = parseProcessLoad(adb("exec-out", "run-as", pkg, "cat", `/proc/${pid}/stat`), pid).startTicks;
  const forwardsBefore = adb("forward", "--list").trim();
  const check = () => {
    assert.match(adb("shell", "dumpsys", "window"), /mCurrentFocus=.*com\.smile\.gifmaker\/com\.yxcorp\.plugin\.setting\.activity\.SettingsActivity/);
    assert.equal(businessSettingsPid(adb, pkg), pid);
    assert.equal(parseProcessLoad(adb("exec-out", "run-as", pkg, "cat", `/proc/${pid}/stat`), pid).startTicks, ticks);
  };
  let instance: string | undefined, rootRef: string | undefined;
  for (const [index, preferVisibleSdk] of order.entries()) {
    check();
    const previews: typeof rows[number]["previews"] = [];
    const started = performance.now();
    const snapshot = await inspectPreferredDevice(provider, serial, { expectedPackage: pkg, preferVisibleSdk,
      singleAttempt: true, startupRetry: false, allowAppRestart: false, signal: AbortSignal.timeout(30000),
      onPreview: (phase, preview) => {
        let images = 0; const pending = preview.root ? [preview.root] : [];
        while (pending.length) { const node = pending.pop()!; if (node.layerImageDataUrl) images++; pending.push(...node.children); }
        previews.push({ phase, receivedMs: Math.round(performance.now() - started), images });
      } });
    const row = { round: index + 1, route: preferVisibleSdk ? "sdk-visible" : "ddms", durationMs: Math.round(performance.now() - started), previews,
      result: smallPageRouteSummary(snapshot) };
    rows.push(row);
    // Preserve every round, including a failed one; never overwrite the first capture.
    writeFileSync(join(output, `round-${row.round}-${row.route}-snapshot.json`), JSON.stringify(snapshot));
    if (order.length === 2) writeFileSync(join(output, `${row.route}-snapshot.json`), JSON.stringify(snapshot));
    save({ passed: false, phase: "captured", pid, ticks });
    console.log(JSON.stringify({ round: row.round, route: row.route, durationMs: row.durationMs, error: snapshot.error,
      images: row.result.nodes.filter(node => node.encodedSha).length, previews }));
    assert.equal(snapshot.error, null, snapshot.error ?? "capture failed");
    assert.equal(snapshot.warning ?? null, null, "capture warning; stop");
    assert.equal(snapshot.captureRequestDiagnostics?.totalAttempts, 1, "must not retry");
    assert.ok(row.durationMs < 15000, "unhealthy capture; stop without pressure retries");
    assert.ok(!row.result.nodes.some(node => node.status === "failed"), "missing image failure; stop");
    assert.equal(row.result.attributes?.["debug-process-id"], pid);
    const currentInstance = row.result.attributes?.["sdk-process-instance"];
    const currentRoot = snapshot.root?.children[0].attributes?.["view-ref"];
    assert.ok(currentInstance && currentRoot);
    instance ??= currentInstance; rootRef ??= currentRoot;
    assert.equal(currentInstance, instance); assert.equal(currentRoot, rootRef);
    check();
    if (preferVisibleSdk) for (const key of ["sdk-first-fallback", "sdk-visible-fallback", "sdk-ref-fallback"])
      assert.ok(!row.result.attributes?.[key], `SDK route fell back: ${key}`);
    if (!preferVisibleSdk) assert.ok(Number(row.result.attributes?.["ddms-batch-layers"]) > 0,
      "DDMS route must have actual batch evidence");
    const comparison = compareSmallPageRoutes(rows[0].result, row.result);
    assert.deepEqual(comparison.differences.filter(item => item.kind !== "encoded-image"), [], "object/geometry/coverage changed; stop");
    // Both routes begin each round without our persistent provider connection.
    await provider.releaseAll(); check();
    assert.equal(adb("forward", "--list").trim(), forwardsBefore, "capture forward leaked after disposal");
  }
  const comparisons = rows.slice(1).map(row => ({ round: row.round, ...compareSmallPageRoutes(rows[0].result, row.result) }));
  if (order.length === 4) {
    // Reuse the offline decoder for both pairs, without another phone capture.
    for (const [pair, indices] of [[0, 1], [3, 2]].entries()) {
      const directory = join(output, `pair-${pair + 1}`); mkdirSync(directory);
      for (const index of indices) {
        const row = rows[index];
        const data = readFileSync(join(output, `round-${row.round}-${row.route}-snapshot.json`));
        writeFileSync(join(directory, `${row.route}-snapshot.json`), data);
      }
    }
  }
  save({ passed: true, phase: "coverage-compared", pixelAcceptance: "pending offline decoding", pid, ticks, instance, rootRef, comparisons });
  console.log(JSON.stringify({ coveragePassed: true, rounds: rows.length, pixelAcceptance: "pending offline decoding" }));
} catch (error) { save({ passed: false, error: String(error) }); throw error; }
finally { await provider.dispose(); }
