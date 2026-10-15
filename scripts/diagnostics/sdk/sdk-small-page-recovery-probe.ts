// Stable business settings only: baseline, cancel at first image preview, one recovery.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProviderSessionPool } from "../../../electron/sdk/provider-session";
import { inspectPreferredDevice } from "../../../electron/capture/inspection";
import { businessSettingsPid } from "../../business-process";
import { parseProcessLoad } from "./sdk-device-load";
import { smallPageRouteSummary } from "../../small-page-route-summary";
import type { UiSnapshot } from "../../../shared/types";
import { createRequire } from "node:module";
import { readMainSuspendCount } from "../../jdwp-main-suspend-count";
import { recoveryRouteFlags, recoveryRouteOptions, assertDefaultSdkResult, assertDefaultSdkStages } from "../../small-recovery-route";
const { createJdwpClient } = createRequire(import.meta.url)("../../lib/startup-stack-observer.cjs");

const serial = process.argv[2];
const { defaultRoute, requireTreeReady } = recoveryRouteFlags(process.argv.slice(3));
assert.ok(serial && /^[\w.:-]+$/.test(serial),
  "Usage: bun scripts/diagnostics/sdk/sdk-small-page-recovery-probe.ts SERIAL [--default-route|--require-tree-ready]");
const pkg = "com.smile.gifmaker";
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8", timeout: 15000, maxBuffer: 2_000_000 });
const base = join(import.meta.dirname, "../../../.benchmarks"); mkdirSync(base, { recursive: true });
const output = mkdtempSync(join(base, "sdk-small-recovery-"));
const rows: unknown[] = [];
const save = (extra: object) => writeFileSync(join(output, "report.json"), JSON.stringify({ rows,
  requireTreeReady, requestedRoute: defaultRoute ? "default-omitted-preference" : "explicit-sdk",
  scope: "stable settings page, SDK first-preview cancellation and same-process recovery; not cold-start, UI or stable performance acceptance", ...extra }, null, 2));
console.log(`SDK recovery probe: ${output}`);
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
  const checkMain = async (phase: string) => {
    check();
    const port = adb("forward", "tcp:0", `jdwp:${pid}`).trim(); assert.match(port, /^\d+$/);
    const client = createJdwpClient(Number(port));
    try {
      await client.ready;
      const result = await readMainSuspendCount((set, operation, data) => client.request(set, operation, data));
      rows.push({ phase, mainThread: result }); save({ passed: false, pid, ticks });
      assert.equal(result.suspendCount, 0, "main thread remained suspended");
    } finally { client.close(); adb("forward", "--remove", `tcp:${port}`); }
  };
  let instance: string | undefined, rootRef: string | undefined, baselineSignature: string | undefined;
  const healthy = async (name: string) => {
    check(); const started = performance.now();
    const stages: string[] = [];
    const previews: { phase: string; receivedMs: number; images: number }[] = [];
    const snapshot = await inspectPreferredDevice(provider, serial, { inspectionMode: "sdk-enhanced", expectedPackage: pkg, ...recoveryRouteOptions(defaultRoute), onProgress: stage => stages.push(stage),
      singleAttempt: true, startupRetry: false, allowAppRestart: false, signal: AbortSignal.timeout(30000), onPreview: (phase, preview) => {
        let images = 0; const pending = preview.root ? [preview.root] : [];
        while (pending.length) { const node = pending.pop()!; if (node.layerImageDataUrl) images++; pending.push(...node.children); }
        previews.push({ phase, receivedMs: Math.round(performance.now() - started), images });
      } });
    const durationMs = Math.round(performance.now() - started), summary = smallPageRouteSummary(snapshot);
    rows.push({ name, durationMs, previews, stages, summary });
    writeFileSync(join(output, `${name}-snapshot.json`), JSON.stringify(snapshot)); save({ passed: false, pid, ticks });
    assert.equal(snapshot.error, null, snapshot.error ?? "capture failed");
    assert.equal(snapshot.warning ?? null, null);
    assert.equal(snapshot.captureRequestDiagnostics?.totalAttempts, 1);
    assert.ok(durationMs < 15000, "unhealthy capture, stop");
    assert.ok(!summary.nodes.some(node => node.status === "failed"));
    assert.equal(summary.attributes?.["debug-process-id"], pid);
    if (defaultRoute) assertDefaultSdkResult(summary, stages);
    if (requireTreeReady) assert.equal(summary.attributes?.["sdk-tree-ready-event"], "true", "updated SDK must deliver a verified tree-ready event");
    for (const key of ["sdk-first-fallback", "sdk-visible-fallback", "sdk-ref-fallback"])
      assert.ok(!summary.attributes?.[key], `SDK fallback ${key}`);
    const currentInstance = summary.attributes?.["sdk-process-instance"], currentRoot = snapshot.root?.children[0]?.attributes?.["view-ref"];
    assert.ok(currentInstance && currentRoot); instance ??= currentInstance; rootRef ??= currentRoot;
    assert.equal(currentInstance, instance); assert.equal(currentRoot, rootRef);
    const signature = JSON.stringify(summary.nodes.map(node => [node.ref, node.className, node.bounds, node.visible, node.status, node.empty, node.encodedSha]));
    baselineSignature ??= signature; assert.equal(signature, baselineSignature, "recovery object/geometry/status/encoded image changed");
    const candidates = [];
    const pending = snapshot.root ? [snapshot.root] : [];
    while (pending.length) { const node = pending.pop()!;
      if (node.className === "com.yxcorp.gifshow.widget.SwipeLayout" && node.layerImageDataUrl
        && (node.layerImageSize?.width ?? 0) * (node.layerImageSize?.height ?? 0) > 1_000_000) candidates.push(node);
      pending.push(...node.children); }
    assert.equal(candidates.length, 1, "one large SwipeLayout required");
    const node = candidates[0]; assert.equal(node.layerImageEmpty, true, "updated SDK must mark large transparent parent empty");
    const match = /^data:image\/(png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(node.layerImageDataUrl!); assert.ok(match);
    const rgba = execFileSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
      { input: Buffer.from(match[2], "base64"), timeout: 5000, maxBuffer: 16_000_000 });
    assert.equal(rgba.length, node.layerImageSize!.width * node.layerImageSize!.height * 4);
    for (let i = 3; i < rgba.length; i += 4) assert.equal(rgba[i], 0, "empty flag must match actual alpha");
    // Successful captures deliberately retain their provider session for reuse.
    // Test cleanup after explicit disposal, not while that session is still alive.
    await provider.releaseAll();
    check(); assert.equal(adb("forward", "--list").trim(), forwardsBefore, "capture forward leaked after disposal");
    console.log(JSON.stringify({ name, durationMs, previews, nodes: snapshot.nodeCount, images: summary.nodes.filter(node => node.encodedSha).length, largeParentEmpty: node.layerImageEmpty,
      treeReadyEvent: summary.attributes?.["sdk-tree-ready-event"] ?? null,
      treeReadyWake: summary.attributes?.["sdk-tree-ready-wake"] ?? null,
      treeNoticeMs: summary.attributes?.["sdk-tree-ready-received-ms"] ?? null }));
  };
  await checkMain("before-baseline");
  await healthy("baseline");
  check(); const controller = new AbortController(); let previewAt: number | null = null, abortedAt: number | null = null, postCancelPreviews = 0;
  const started = performance.now();
  const cancelStages: string[] = [];
  await assert.rejects(inspectPreferredDevice(provider, serial, { inspectionMode: "sdk-enhanced", expectedPackage: pkg, ...recoveryRouteOptions(defaultRoute), onProgress: stage => cancelStages.push(stage),
    singleAttempt: true, startupRetry: false, allowAppRestart: false, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
    onPreview: (phase, preview: UiSnapshot) => {
      if (controller.signal.aborted) { postCancelPreviews++; return; }
      if (phase !== "layers") return;
      const pending = preview.root ? [preview.root] : [];
      while (pending.length) { const node = pending.pop()!;
        if (node.layerImageDataUrl) { previewAt = performance.now() - started; abortedAt = performance.now(); controller.abort(new Error("small-page-preview-cancel")); return; }
        pending.push(...node.children); }
    } }), /small-page-preview-cancel/);
  assert.ok(previewAt !== null && abortedAt !== null, "must cancel at real image preview, not a guessed timer");
  rows.push({ name: "cancel", phase: "first-image-preview", previewAtMs: previewAt,
    returnedMsAfterAbort: Math.round(performance.now() - abortedAt!), postCancelPreviews, stages: cancelStages }); save({ passed: false, pid, ticks });
  if (defaultRoute) assertDefaultSdkStages(cancelStages);
  assert.equal(postCancelPreviews, 0);
  await provider.releaseAll(); check();
  assert.equal(adb("forward", "--list").trim(), forwardsBefore, "cancel forward leaked");
  await checkMain("after-cancel");
  await healthy("recovery");
  await provider.releaseAll(); check();
  await checkMain("after-recovery");
  assert.equal(adb("forward", "--list").trim(), forwardsBefore);
  save({ passed: true, pid, ticks, instance, rootRef });
} catch (error) { save({ passed: false, error: String(error) }); throw error; }
finally { await provider.dispose(); }
