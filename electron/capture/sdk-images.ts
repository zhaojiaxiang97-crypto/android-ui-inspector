import { type ProviderTreeReadyEvent } from "../sdk/provider-session-request";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import type { UiNode } from "../../shared/types";
import { matchesViewRoot, parseCapturedViewLayers, parseCapturedViewLayerPrefix, type CapturedViewLayer } from "./view-protocol";
import { parseSdkStaleTree } from "../sdk/sdk-stale-tree";
import { SdkPreviewPrefix } from "../sdk/sdk-preview-prefix";
import { requestSdkTree, sdkTreePhase } from "../sdk/sdk-tree-read";
import { windowAcceleration, assertSafeSoftwareSdkCapture, checkSdkMergedTreeOutcome, SdkMergedTreeFailure, settleSdkMergedTree, parsePureViewRefs, parseSdkTaskDiagnostics, parseSdkCaptureFailure, parseSdkCapturePhases } from "../sdk/capture-protocol";
import type { ProviderClient } from "../sdk/provider-session";
import { type CaptureGeometryEvidence, parseCaptureGeometryFile, matchSdkVisibleLayers, canonicalizeSdkWindowRoot, summarizeSdkGeometry, type FallbackLayerImage, parseCaptureGeometryEvidence } from "./layer-images";
import { withCommandSignal, withoutCommandSignal } from "../device/command-context";
import type { CaptureRunContext } from "./run-context";
import { runDeviceAdb, COMMAND_TIMEOUT_MS } from "../device/runtime";
import { type CheckedSdkTreeIdentity } from "./types";
import { checkedDebugTarget, singleAppPid } from "../device/target";

/** Merged `capture-visible` support per device+package; older SDKs ignore the extra and use the classic fetch. */
export const mergedTreeSupport = new Map<string, boolean>();

export function bitmapTarget(provider: ProviderClient, adbPath: string, serial: string, packageName: string, root: UiNode, rootRef: string, windowName: string) {
  const attributes = root.attributes ?? {};
  const accelerated = windowAcceleration(root);
  const instance = attributes["sdk-process-instance"];
  const wakeUi = attributes["sdk-ui-wake-version"] === "1" && instance ? async () => {
    const nonce = randomBytes(8).toString("hex");
    const reply = await provider.call(adbPath, serial, packageName, "wake-ui", nonce, { processInstance: instance }, 3000);
    const field = (name: string) => new RegExp(`\\b${name}=([^,}]+)`).exec(reply.stdout.toString("utf8"))?.[1]?.trim();
    if (reply.code !== 0 || field("result") !== "ok" || field("nonce") !== nonce
        || field("processInstance") !== instance || field("pid") !== attributes["debug-process-id"])
      throw new Error("SDK 安全唤醒身份校验失败，请重新采集");
  } : undefined;
  return { rootRef, windowName, wakeUi, hardwareAccelerated: accelerated === "true" ? true : accelerated === "false" ? false : undefined };
}

async function readGeometryFile(adbPath: string, serial: string, packageName: string, nonce: string, instance: string, rootRef: string, layers: readonly CapturedViewLayer[], field: (name: string) => string | undefined) {
  const size = field("geometryBytes"), hash = field("geometrySha256");
  if (size === undefined && hash === undefined) return new Map<string, CaptureGeometryEvidence>();
  if (!size || !Number.isSafeInteger(Number(size)) || Number(size) < 1 || Number(size) > 4_000_000 || !hash || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("SDK 几何文件响应无效");
  const file = await runDeviceAdb(adbPath, serial, ["exec-out", "run-as", packageName, "head", "-c", "4000001", `no_backup/inspector-geometry-${nonce}.json`]);
  if (file.code !== 0 || file.stdout.length !== Number(size) || createHash("sha256").update(file.stdout).digest("hex") !== hash) throw new Error("SDK 几何文件校验失败");
  return parseCaptureGeometryFile(file.stdout, nonce, instance, rootRef, layers);
}

export type SdkMergedTreeAcceptance = {
  value: unknown;
  adbPath: string;
  serial: string;
  packageName: string;
  processId: string;
  before: { component: string; windowId: string };
  root: UiNode;
  notice: () => { event?: Pick<ProviderTreeReadyEvent, "processInstance">; receivedMs?: number; consumed: boolean };
  withTree: { onTree: (value: unknown, identity: CheckedSdkTreeIdentity) => Promise<void>; timings?: Record<string, number> };
  callStarted: number;
};

// The adopted tree carries proof only after this call checks the live window/PID.
export async function acceptSdkMergedTree(input: SdkMergedTreeAcceptance, context: CaptureRunContext, ports = {
  checkedTarget: checkedDebugTarget, pid: singleAppPid, now: () => performance.now(),
}): Promise<void> {
  const { value, adbPath, serial, packageName, processId, before, root, withTree, callStarted } = input;
  return withCommandSignal(context.signal, async () => {
    const treeEvent = input.notice().event;
    if (treeEvent && (!value || typeof value !== "object" || !("processInstance" in value)
        || value.processInstance !== treeEvent.processInstance)) throw new SdkMergedTreeFailure("SDK 树就绪通知与实际控件树实例不一致");
    const identityStarted = ports.now();
    const current = await ports.checkedTarget(adbPath, serial, packageName);
    if (current.component !== before.component || current.windowId !== before.windowId
        || String(await ports.pid(adbPath, serial, packageName, current)) !== processId) throw new Error("SDK 读树期间窗口或进程已变化");
    context.signal?.throwIfAborted();
    if (withTree?.timings) withTree.timings["SDK 合并树身份核对"] = Math.round(ports.now() - identityStarted);
    // This fresh check already pins the merged tree to the capture-start window/PID.
    // Pass it only within this call; do not query the same identity again in adoption.
    const adoptStarted = ports.now();
    await withTree.onTree(value, { serial, packageName, pid: Number(processId), component: current.component, windowId: current.windowId });
    const notice = input.notice();
    if (withTree?.timings) {
      withTree.timings["SDK 合并树采用回调"] = Math.round(ports.now() - adoptStarted);
      withTree.timings["SDK 合并树采用完成（调用内）"] = Math.round(ports.now() - callStarted);
      if (notice.receivedMs !== undefined) withTree.timings["SDK 树通知收到（调用内）"] = Math.round(notice.receivedMs);
    }
    if (notice.event) root.attributes = { ...root.attributes, "sdk-tree-ready-event": "true",
      "sdk-tree-ready-received-ms": String(Math.round(notice.receivedMs ?? 0)), "sdk-tree-ready-wake": String(notice.consumed) };
  });
}

export async function captureSdkVisibleLayers(provider: ProviderClient, adbPath: string, serial: string, packageName: string, root: UiNode, onPartial: ((layers: CapturedViewLayer[]) => void | Promise<void>) | undefined, withTree: { onTree: (value: unknown, identity: CheckedSdkTreeIdentity) => Promise<void>; onMissing: () => void; treeReady?: Promise<void>; timings?: Record<string, number> } | undefined, context: CaptureRunContext) {
  return withCommandSignal(context.signal, async () => {
    const visibleStarted = performance.now();
    // Internal profiling switch: keep tree/screen previews and final verification
    // identical, changing only optional growing-image-file polling. Default stays on.
    if (context.options.layerPreviewPolling === false) onPartial = undefined;
    assertSafeSoftwareSdkCapture(root);
    const before = await checkedDebugTarget(adbPath, serial, packageName);
    const processId = root.attributes?.["debug-process-id"];
    const rootRef = root.children[0]?.attributes?.["view-ref"];
    if (!processId || !rootRef || String(await singleAppPid(adbPath, serial, packageName)) !== processId) throw new Error("SDK 进程或根控件已变化");
    if (withTree?.timings) withTree.timings["SDK 可见调用前核对"] = Math.round(performance.now() - visibleStarted);
    const fileName = "no_backup/inspector-visible-layers.bin";
    const nonce = randomUUID().replace(/-/g, "").slice(0, 16);
    const treeFileName = `no_backup/inspector-tree-${nonce}.json`;
    const mergedTree = Boolean(withTree);
    const treeReady = withTree?.treeReady;
    const previewPrefix = new SdkPreviewPrefix();
    try {
      const callStarted = performance.now();
      if (withTree?.timings) console.log(`[sdk-visible-tree] request=${nonce} pid=${processId}`);
      const priorityViewRef = context.options.priorityViewRef;
      const extras: Record<string, string | boolean> = { geometryFile: true };
      if (process.env.INSPECTOR_SHORT_PARENT_DIAGNOSTICS === "1") extras.shortParentDiagnostics = true;
      if (withTree) { extras.withTree = true; extras.treeReadyEvents = true; }
      if (priorityViewRef) extras.priorityViewRef = priorityViewRef;
      let treeEvent: ProviderTreeReadyEvent | undefined;
      let treeNoticeMs: number | undefined;
      let notifyTree!: (value: "tree-ready") => void;
      const treeNotice = new Promise<"tree-ready">(resolve => { notifyTree = resolve; });
      let noticeConsumed = false;
      const request = provider.call(adbPath, serial, packageName, "capture-visible", nonce, Object.keys(extras).length ? extras : null, 65_000, false, context.signal,
        withTree ? event => {
          if (context.signal?.aborted || String(event.pid) !== processId) return;
          treeEvent = event; treeNoticeMs = performance.now() - callStarted; notifyTree("tree-ready");
        } : undefined, withTree?.timings ? { startedAt: callStarted, timings: withTree.timings } : undefined)
        .then((reply) => ({ reply, error: null as unknown }), (error: unknown) => ({ reply: null, error }));
      const checkOutcome = (outcome: Awaited<typeof request>) => {
        context.signal?.throwIfAborted();
        checkSdkMergedTreeOutcome(outcome, nonce, root.attributes?.["sdk-process-instance"]);
      };
      // ponytail: partial previews poll the growing files while the call runs; retune the cadence from device samples.
      let partialCount = 0, previews = 0, polls = 0, failures = 0;
      let treeLanded = false;
      const acceptMergedTree = (value: unknown) => acceptSdkMergedTree({ value, adbPath, serial, packageName, processId,
        before, root, withTree: withTree!, callStarted, notice: () => ({ event: treeEvent, receivedMs: treeNoticeMs, consumed: noticeConsumed }) }, context);
      const readMergedTree = async (): Promise<unknown | undefined> => {
        context.signal?.throwIfAborted();
        const readStarted = performance.now();
        const chunk = await runDeviceAdb(adbPath, serial, ["exec-out", "run-as", packageName, "head", "-c", "4000001", treeFileName], 5_000);
        if (withTree?.timings) withTree.timings["SDK 合并树文件读取累计"] = (withTree.timings["SDK 合并树文件读取累计"] ?? 0) + Math.round(performance.now() - readStarted);
        if (chunk.code !== 0 || chunk.stdout[0] !== 0x7b || chunk.stdout.length > 4_000_000) return undefined;
        try { return JSON.parse(chunk.stdout.toString("utf8")) as unknown; } catch { return undefined; }
      };
      const partialEnabled = Boolean(onPartial);
      while ((withTree && !treeLanded || onPartial && previews < 3) && polls++ < 16) {
        const result = await Promise.race([request, wait(600, undefined, { signal: context.signal }).then(() => null),
          ...(!noticeConsumed && withTree ? [treeNotice] : [])]);
        if (result === "tree-ready") noticeConsumed = true;
        else if (result) break;
        if (withTree && !treeLanded) {
          // The tree file carries the call nonce, so a present file is this call's fresh write.
          const treeValue = await readMergedTree();
          if (treeValue === undefined) continue;
          treeLanded = true;
          console.log("[visible] merged tree landed");
          try {
            await acceptMergedTree(treeValue);
          } catch (error) {
            // Identity rejection must abort before waiting on the caller's tree-ready latch.
            console.log(`[visible] merged tree rejected: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
          }
        }
        // The tree phase must settle before matching: both the mid-call adopt and the classic fallback rewrite refs.
        if (withTree && !treeLanded) continue;
        if (!onPartial) continue;
        try {
          if (previewPrefix.capped) { previewPrefix.shouldRead(); onPartial = undefined; continue; }
          const readStarted = performance.now();
          const chunk = await runDeviceAdb(adbPath, serial, ["exec-out", "run-as", packageName, "head", "-c", String(SdkPreviewPrefix.limit), `${fileName}.tmp`], 5_000);
          previewPrefix.metrics.reads++;
          previewPrefix.metrics.bytes += chunk.stdout.length;
          previewPrefix.metrics.readMs += Math.round(performance.now() - readStarted);
          if (chunk.code !== 0) continue;
          const parseStarted = performance.now();
          const layers = parseCapturedViewLayerPrefix(chunk.stdout, nonce);
          previewPrefix.accept(chunk.stdout, nonce, () => layers);
          previewPrefix.metrics.parseMs += Math.round(performance.now() - parseStarted);
          if (layers.length < (partialCount ? partialCount + 120 : 24)) continue;
          const { matched } = matchSdkVisibleLayers(root, layers);
          const current = await checkedDebugTarget(adbPath, serial, packageName);
          if (current.component !== before.component || current.windowId !== before.windowId
              || String(await singleAppPid(adbPath, serial, packageName)) !== processId) throw new Error("SDK 分段采集期间窗口或进程已变化");
          context.signal?.throwIfAborted();
          await onPartial(matched);
          partialCount = layers.length;
          previews++;
          failures = 0;
        } catch (error) {
          context.signal?.throwIfAborted();
          // A partial file is optional. The complete SHA-256-checked path remains authoritative,
          // so a transient read keeps retrying instead of disabling the previews for good.
          failures++;
          if (failures <= 3) console.log(`[visible] partial ${failures} failed: ${error instanceof Error ? error.message : String(error)}`);
          if (failures >= 3) onPartial = undefined;
        }
      }
      if (partialEnabled) console.log(`[visible] partial previews=${previews} polls=${polls} failures=${failures} records=${partialCount}`);
      // A late tree may arrive after the polling budget or with the final reply. Do not
      // queue classic capture while capture-visible still owns the provider/UI thread.
      const outcome = withTree && !treeLanded
        ? await settleSdkMergedTree(request, readMergedTree, acceptMergedTree, () => {
          console.log("[visible] merged request settled; tree missing, classic fetch");
          withTree!.onMissing();
        }, checkOutcome)
        : await request;
      checkOutcome(outcome);
      if (treeReady) {
        // Validate and match against the final refs: the caller adopts the tree after settling the phase.
        await treeReady;
        context.signal?.throwIfAborted();
      }
      if (outcome.error) throw outcome.error;
      const reply = outcome.reply!;
      const callMs = Math.round(performance.now() - callStarted);
      const output = reply.stdout.toString("utf8");
      const field = (name: string) => new RegExp(`\\b${name}=([^,}\\]]+)`).exec(output)?.[1];
      const instance = field("processInstance"), sha256 = field("sha256"), count = Number(field("count")), selected = Number(field("selected")), empty = Number(field("empty")), bytes = Number(field("bytes"));
      const renderMs = Number(field("renderMs")), encodeMs = Number(field("encodeMs")), durationMs = Number(field("durationMs"));
      const specialValue = field("specialRefs");
      const specialEntries = specialValue === "-" ? [] : specialValue?.split(";") ?? [];
      const specialRefs = new Set(specialEntries.map((entry) => entry.slice(2)));
      const pureRefs = parsePureViewRefs(field("pureRefs"));
      const responseRoot = field("rootRef") ?? "";
      const staleTree = reply.code === 0 ? parseSdkStaleTree(field, nonce, root.children[0]?.attributes?.["view-ref"] ?? "", root.attributes?.["sdk-process-instance"]) : null;
      if (staleTree) {
        root.attributes = { ...root.attributes, ...staleTree, ...parseSdkTaskDiagnostics(field) };
        throw new Error(`SDK 已发布控件树在绘制期间变化：${staleTree["sdk-visible-failure-target"]}，请重新读取控件树`);
      }
      const rootMatches = matchesViewRoot(root.children[0]?.attributes?.["view-ref"] ?? "", responseRoot);
      // Read the ref from the live tree: the caller may have rebuilt it from the SDK hierarchy while this call ran.
      if (reply.code !== 0 || field("result") !== "ok" || !rootMatches || (field("nonce") && field("nonce") !== nonce)
          || root.attributes?.["sdk-process-instance"] !== undefined && root.attributes["sdk-process-instance"] !== instance
          || !instance || !/^[0-9a-f-]{36}$/i.test(instance) || !sha256 || !/^[a-f0-9]{64}$/.test(sha256)
          || !Number.isSafeInteger(count) || count < 1 || count > 5000 || !Number.isSafeInteger(selected) || selected < count || selected > 5000
          || !Number.isSafeInteger(empty) || empty < 0 || selected !== count + empty || !Number.isSafeInteger(bytes) || bytes < 9 || bytes > 64_000_000
          || ![renderMs, encodeMs, durationMs].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 65_000)
          || !specialValue || specialEntries.length > 32 || specialRefs.size !== specialEntries.length
          || !specialEntries.every((entry) => /^[ST]:[\w.$]+@[0-9a-f]{1,8}$/i.test(entry))) {
        const failureDiagnostic = parseSdkCaptureFailure(field, nonce, root.children[0]?.attributes?.["view-ref"] ?? "", root.attributes?.["sdk-process-instance"]);
        if (failureDiagnostic) root.attributes = { ...root.attributes, ...failureDiagnostic };
        if (failureDiagnostic) root.attributes = { ...root.attributes, ...parseSdkTaskDiagnostics(field) };
        throw new Error(`SDK 可见层抓取失败：${field("error") ?? "响应无效"}；${JSON.stringify({
          failureDiagnostic,
          code: reply.code, result: field("result"), rootMatches,
          expectedRoot: root.children[0]?.attributes?.["view-ref"]?.slice(0, 256), actualRoot: field("rootRef")?.slice(0, 256),
          nonceMatches: !field("nonce") || field("nonce") === nonce, instanceValid: Boolean(instance && /^[0-9a-f-]{36}$/i.test(instance)),
          hashValid: Boolean(sha256 && /^[a-f0-9]{64}$/.test(sha256)), count, selected, empty, bytes,
          renderMs, encodeMs, durationMs, specialValuePresent: Boolean(specialValue), specialCount: specialEntries.length,
          specialUnique: specialRefs.size === specialEntries.length, specialValid: specialEntries.every((entry) => /^[ST]:[\w.$]+@[0-9a-f]{1,8}$/i.test(entry)),
        })}`);
      }
      const readStarted = performance.now();
      const file = await runDeviceAdb(adbPath, serial, ["exec-out", "run-as", packageName, "head", "-c", "64000001", fileName]);
      const readMs = Math.round(performance.now() - readStarted);
      if (file.code !== 0 || file.stdout.length !== bytes || createHash("sha256").update(file.stdout).digest("hex") !== sha256) throw new Error("SDK 可见层文件校验失败");
      const layers = parseCapturedViewLayers(file.stdout);
      if (layers.length !== count || !layers.every((layer) => layer.visible && layer.imageDataUrl && layer.name.includes("@"))) throw new Error("SDK 可见层记录不完整");
      const geometry = await readGeometryFile(adbPath, serial, packageName, nonce, instance, responseRoot, layers, field);
      for (const layer of layers) layer.geometry = geometry.get(layer.name);
      // Activity.dump abbreviates DecorView. Canonicalize only this verified alias so
      // the root bitmap and layout hints use the SDK's full identity too.
      canonicalizeSdkWindowRoot(root, responseRoot);
      const after = await checkedDebugTarget(adbPath, serial, packageName);
      if (before.component !== after.component || before.windowId !== after.windowId || String(await singleAppPid(adbPath, serial, packageName)) !== processId) throw new Error("SDK 采集期间窗口或进程已变化");
      // Preserve identity-checked telemetry even if pixel/tree geometry matching below rejects
      // the batch. This does not authorize the rejected images or retain their pixels.
      if (!root.attributes?.["sdk-process-instance"] || root.attributes["sdk-process-instance"] === instance) {
        root.attributes = { ...root.attributes, ...parseSdkTaskDiagnostics(field),
          "sdk-geometry-summary": summarizeSdkGeometry(root, layers) };
        try { root.attributes["sdk-geometry-phases"] = JSON.stringify(parseSdkCapturePhases(field)); }
        catch { /* Optional diagnostic: the normal success path still validates these counters. */ }
      }
      const { matched, moved, unmatched, refs } = matchSdkVisibleLayers(root, layers);
      if ([...specialRefs].some((ref) => !refs.has(ref))) throw new Error("SDK 特殊画面控件与当前控件树不一致");
      if ([...pureRefs].some((ref) => !refs.has(ref) || specialRefs.has(ref))) throw new Error("SDK 纯布局控件与当前控件树不一致");
      root.attributes = { ...root.attributes, ...parseSdkTaskDiagnostics(field), "sdk-visible-process-instance": instance, "sdk-visible-images": String(matched.length), "sdk-visible-empty": String(empty), "sdk-visible-moved": String(moved), "sdk-visible-unmatched": String(unmatched), "sdk-pure-refs": String(pureRefs.size) };
      const treeField = field("tree");
      return { layers: matched, specialRefs, pureRefs, timing: { callMs, readMs, renderMs, encodeMs, durationMs }, phases: parseSdkCapturePhases(field), tree: mergedTree ? { status: treeField === "ok" ? "ok" as const : treeField === undefined ? "unsupported" as const : "failed" as const } : null };
    } finally {
      root.attributes = { ...root.attributes, "sdk-preview-io": JSON.stringify(previewPrefix.metrics) };
      await withoutCommandSignal(() => runDeviceAdb(adbPath, serial, ["shell", "run-as", packageName, "rm", "-f", fileName, `no_backup/inspector-geometry-${nonce}.json`, ...(mergedTree ? [treeFileName] : [])])).catch(() => undefined);
    }
  });
}

/** Batch-capture one pre-selected View set through the SDK; replaces the per-node JDWP walk. */
export async function captureSdkRefLayers(provider: ProviderClient, adbPath: string, serial: string, packageName: string, root: UiNode, refs: string[], debugCanvas = false) {
  assertSafeSoftwareSdkCapture(root);
  if (debugCanvas && (refs.length !== 1 || root.attributes?.["sdk-ref-debug-canvas-version"] !== "1"))
    throw new Error("SDK 不支持文字硬件快照");
  const processInstance = root.attributes?.["sdk-visible-process-instance"] ?? root.attributes?.["sdk-process-instance"];
  if (root.attributes?.["sdk-process-instance"] && root.attributes["sdk-process-instance"] !== processInstance)
    throw new Error("SDK 补齐进程身份不一致");
  const rootRef = root.children[0]?.attributes?.["view-ref"];
  if (!processInstance || !rootRef) throw new Error("SDK 补齐缺少进程或根控件身份");
  const fileName = "no_backup/inspector-ref-layers.bin";
  const nonce = randomUUID().replace(/-/g, "").slice(0, 16);
  try {
    const callStarted = performance.now();
    // ponytail: single quotes survive the device shell so $-class names reach content call intact; the session path sends the raw arg.
    const reply = await provider.call(adbPath, serial, packageName, "capture-refs", refs.join(";"), { nonce, ...(debugCanvas ? { debugCanvas: true } : {}), ...(refs.length <= 8 ? { geometryEvidence: true } : { geometryFile: true }) }, 30_000, true);
    const callMs = Math.round(performance.now() - callStarted);
    const output = reply.stdout.toString("utf8");
    const field = (name: string) => new RegExp(`\\b${name}=([^,}\\]]+)`).exec(output)?.[1];
    const instance = field("processInstance"), sha256 = field("sha256"), count = Number(field("count")), requested = Number(field("requested")), bytes = Number(field("bytes"));
    const renderMs = Number(field("renderMs")), encodeMs = Number(field("encodeMs")), durationMs = Number(field("durationMs"));
    const specialValue = field("special"), failuresValue = field("failures"), emptyValue = field("empty");
    if (reply.code !== 0 || field("result") !== "ok" || field("nonce") !== nonce || field("rootRef") !== rootRef
        || debugCanvas && field("debugCanvas") !== "true"
        || instance !== processInstance || !sha256 || !/^[a-f0-9]{64}$/.test(sha256)
        || !Number.isSafeInteger(count) || count < 0 || count > refs.length || requested !== refs.length
        || !Number.isSafeInteger(bytes) || bytes < 9 || bytes > 64_000_000
        || ![renderMs, encodeMs, durationMs].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 30_000)
        || (specialValue !== undefined && specialValue !== "-" && specialValue.length > 6_000)
        || (failuresValue !== undefined && failuresValue !== "-" && failuresValue.length > 16_000)
        || (emptyValue !== undefined && emptyValue !== "-" && emptyValue.length > 16_000)) {
      throw new Error(`SDK 补齐抓取失败：${field("error") ?? "响应无效"}`);
    }
    const wanted = new Set(refs);
    const specialEntries = specialValue === undefined ? null : specialValue === "-" ? [] : specialValue.split(";");
    if (!specialEntries || specialEntries.length > refs.length || !specialEntries.every((entry) => /^[ST]:[\w.$]+@[0-9a-f]{1,8}$/i.test(entry) && wanted.has(entry.slice(2)))) {
      throw new Error("SDK 补齐特殊画面清单无效");
    }
    const kinds = new Map<string, "own" | "texture" | "surface">(specialEntries.map((entry) => [entry.slice(2), entry[0] === "S" ? "surface" as const : "texture" as const]));
    const pure = [...parsePureViewRefs(field("pure"))];
    if (pure.some((ref) => !wanted.has(ref) || kinds.has(ref))) throw new Error("SDK 补齐纯布局清单无效");
    const failures = new Map<string, string>();
    for (const entry of failuresValue === undefined || failuresValue === "-" ? [] : failuresValue.split(";")) {
      const at = entry.indexOf(":");
      const ref = at < 0 ? "" : entry.slice(0, at), reason = at < 0 ? "" : entry.slice(at + 1);
      if (!wanted.has(ref) || !reason || reason.length > 200 || failures.has(ref)) throw new Error("SDK 补齐失败清单无效");
      failures.set(ref, reason);
    }
    const emptyRefs = emptyValue === undefined || emptyValue === "-" ? [] : emptyValue.split(";");
    if (emptyRefs.some((ref) => !wanted.has(ref))) throw new Error("SDK 补齐空白清单无效");
    const readStarted = performance.now();
    const file = await runDeviceAdb(adbPath, serial, ["exec-out", "run-as", packageName, "head", "-c", "64000001", fileName]);
    const readMs = Math.round(performance.now() - readStarted);
    if (file.code !== 0 || file.stdout.length !== bytes || createHash("sha256").update(file.stdout).digest("hex") !== sha256) throw new Error("SDK 补齐文件校验失败");
    const layers = parseCapturedViewLayers(file.stdout);
    if (layers.length !== count || !layers.every((layer) => layer.visible && layer.imageDataUrl && layer.name.includes("@") && wanted.has(layer.name))) throw new Error("SDK 补齐记录不完整");
    const empty = new Set(emptyRefs);
    const images = new Map<string, FallbackLayerImage>();
    const geometry = refs.length <= 8 ? parseCaptureGeometryEvidence(field("geometryEvidence"), refs, rootRef)
      : await readGeometryFile(adbPath, serial, packageName, nonce, instance!, rootRef, layers, field);
    const seen = new Set<string>();
    for (const layer of layers) {
      if (seen.has(layer.name)) throw new Error("SDK 补齐对象重复");
      seen.add(layer.name);
      const evidence = geometry.get(layer.name);
      if (evidence && (evidence.chain[0][2] !== layer.x || evidence.chain[0][3] !== layer.y || evidence.chain[0][4] !== layer.width || evidence.chain[0][5] !== layer.height)) throw new Error("SDK 绘制证据与图片几何不一致");
      images.set(layer.name, { width: layer.width, height: layer.height, x: layer.x, y: layer.y, imageDataUrl: layer.imageDataUrl!, kind: kinds.get(layer.name) ?? "own", empty: empty.has(layer.name), ...(evidence ? { geometry: evidence } : {}) });
    }
    if ([...geometry.keys()].some(ref => !images.has(ref))) throw new Error("SDK 绘制证据没有对应图片");
    for (const ref of pure) seen.add(ref);
    for (const ref of failures.keys()) seen.add(ref);
    if (seen.size !== refs.length || refs.some((ref) => !seen.has(ref))) throw new Error("SDK 补齐结果缺少控件");
    return { images, failures, kinds, skipDraw: new Set(pure), timing: { requested: refs.length, callMs, readMs, renderMs, encodeMs, durationMs } };
  } finally {
    await withoutCommandSignal(() => runDeviceAdb(adbPath, serial, ["shell", "run-as", packageName, "rm", "-f", fileName, `no_backup/inspector-geometry-${nonce}.json`])).catch(() => undefined);
  }
}

/** Explicit geometry-only read; not an automatic recovery or full-tree fallback. */
export async function readSdkBranchGeometry(provider: ProviderClient, adbPath: string, serial: string, binding: import("../sdk/branch-geometry").BranchBinding, path: readonly string[]) {
  const { parseBranchGeometry } = await import("../sdk/branch-geometry");
  const nonce = randomBytes(8).toString("hex");
  // Validate the request before touching the device, including identity/path budgets.
  if (path.length < 2 || path.length > 33 || new Set(path).size !== path.length
      || path.some(ref => ref.length > 256 || !/^[\w.$]+@[0-9a-f]{1,8}$/.test(ref))
      || path[0] !== binding.rootRef || path.at(-1) !== binding.branchRef) throw new Error("SDK 小分支路径无效");
  const reply = await provider.call(adbPath, serial, binding.packageName, "read-branch-geometry", path.join(";"), { nonce }, 5_000, true);
  const output = reply.stdout.toString("utf8");
  const data = /\bdata=([A-Za-z0-9+/=]+)/.exec(output)?.[1];
  if (reply.code !== 0 || !/\bresult=ok\b/.test(output) || !data)
    throw new Error(`SDK 小分支读取失败：${/\berror=([^,}\]]+)/.exec(output)?.[1] ?? "响应无效"}`);
  return parseBranchGeometry(data, nonce, binding, path);
}

export async function readSdkCapture(provider: ProviderClient, adbPath: string, serial: string, packageName: string, context: CaptureRunContext): Promise<unknown> {
  return withCommandSignal(context.signal, async () => {
    const reply = await requestSdkTree(
      request => provider.call(adbPath, serial, packageName, "capture", request, null, COMMAND_TIMEOUT_MS, false, context.signal),
      context.options.singleAttempt === true, context.signal,
    );
    if (reply.code !== 0 || reply.stdout.toString("utf8").trim() !== "Result: Bundle[{result=ok}]") {
      const status = reply.stdout.toString("utf8").trim().slice(0, 160) || `code=${reply.code} stdout 空`;
      throw new Error(`目标 App 的 Debug SDK 控件树读取失败（${status}）`);
    }
    // The SDK caps its private file at 4 MB; head adds a host-side read cap.
    const file = await sdkTreePhase("file-read", () => runDeviceAdb(adbPath, serial, ["exec-out", "run-as", packageName, "head", "-c", "4000001", "no_backup/inspector-hierarchy.json"]));
    if (file.code !== 0 || !file.stdout.length || file.stdout.length > 4_000_000) throw new Error("SDK 控件树文件无效或超过 4 MB");
    return JSON.parse(file.stdout.toString("utf8")) as unknown;
  });
}
