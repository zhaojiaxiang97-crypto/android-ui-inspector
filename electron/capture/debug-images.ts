import type { ProviderClient } from "../sdk/provider-session";
import type { UiNode } from "../../shared/types";
import { captureViewLayers, probeWindowName } from "./view-debug";
import { captureViewBitmaps } from "./view-bitmaps";
import { type CapturedViewLayer } from "./view-protocol";
import { verifyAppProcessName } from "../device/app-process";
import { type InspectionPreview } from "./types";
import { captureScreen } from "../device/screen";
import { singleAppPid, checkedDebugTarget } from "../device/target";
import { runDeviceAdb, inspectionContext, captureSignal } from "../device/runtime";
import { countNodes, applyViewProperties } from "./native-tree";
import { captureSdkVisibleLayers, mergedTreeSupport, bitmapTarget, captureSdkRefLayers, readSdkBranchGeometry } from "./sdk-images";
import { attachViewLayerImages, ordinaryViewClasses, hasSdkOrdinaryViewType, needsViewBitmapFallback, applyFallbackLayerImage, annotateFallbackGeometry, recoverSdkGeometryBranch, layerCaptureFailureWarning, retryFallbackGeometry } from "./layer-images";
import { isSdkVisibleCaptureInterruption, isStaleCaptureTreeError, markInterruptedSdkImages, captureSdkRefOrFallback, markFailedSupplementImages } from "../sdk/capture-protocol";

export const PREVIEW_SCREEN_TIMEOUT_MS = 8_000;
export const FINAL_SCREEN_TIMEOUT_MS = 15_000;
export const STARTUP_IMAGE_TIMEOUT_MS = 55_000;
export const IMAGE_TIMEOUT_MS = 90_000;

export async function captureDebugViewImages(provider: ProviderClient, adbPath: string, serial: string, packageName: string, root: UiNode, stage: (name: string) => void, preview?: InspectionPreview, timings?: Record<string, number>): Promise<{ imageCount: number; finalScreen: Promise<Awaited<ReturnType<typeof captureScreen>> | null> | null }> {
  const processStarted = performance.now();
  const processId = String(await singleAppPid(adbPath, serial, packageName));
  const processName = await runDeviceAdb(adbPath, serial, ["exec-out", "cat", `/proc/${processId}/cmdline`]);
  verifyAppProcessName(processName.code, processName.stdout, packageName);
  if (String(await singleAppPid(adbPath, serial, packageName)) !== processId) throw new Error("建立调试连接前 App 进程已变化，请重新采集");
  if (timings) timings["Debug 进程准备"] = Math.round(performance.now() - processStarted);
  root.attributes = { ...root.attributes, "debug-process-id": processId };
  // Let registration return its allocated port even if cancellation arrives;
  // killing the client midway could leave an unknown ADB server-side forward.
  const forwardStarted = performance.now();
  const forwarded = await inspectionContext.exit(() => runDeviceAdb(adbPath, serial, ["forward", "tcp:0", `jdwp:${processId}`]));
  if (timings) timings["Debug 调试转发准备"] = Math.round(performance.now() - forwardStarted);
  const port = forwarded.stdout.toString("utf8").trim();
  if (forwarded.code !== 0 || !/^\d+$/.test(port)) return { imageCount: 0, finalScreen: null };
  try {
    let windowName = "";
    const useVisibleSdk = () => inspectionContext.getStore()?.preferVisibleSdk === true;
    const batchTiming = ({ waitMs, readMs, parseMs, bytes, layers: layerCount, images }: { waitMs: number; readMs: number; parseMs: number; bytes: number; layers: number; images: number }) => {
      if (timings) {
        timings["DDMS 等待首包"] = Math.round(waitMs);
        timings["DDMS 接收包体"] = Math.round(readMs);
        timings["DDMS 解析图片"] = Math.round(parseMs);
      }
      root.attributes = { ...root.attributes, "ddms-batch-bytes": String(bytes), "ddms-batch-layers": String(layerCount), "ddms-batch-images": String(images) };
    };
    const rootRefs = () => root.children.map((node) => node.attributes?.["view-ref"]).filter((value): value is string => Boolean(value));
    let layers: CapturedViewLayer[] = [];
    // C: on SDK pages, adopt the SDK hierarchy first; the DDMS property export stays the compatibility path.
    const store = inspectionContext.getStore();
    const sdkFirstCandidate = Boolean(store?.onViewTreeReady)
      && (store?.preferVisibleSdk === true || store?.preferVisibleSdk === undefined && countNodes(root) >= 200);
    let sdkFirst = false;
    let mergedVisible: Promise<Awaited<ReturnType<typeof captureSdkVisibleLayers>>> | null = null;
    if (sdkFirstCandidate) {
      try {
        const probeStarted = performance.now();
        windowName = await probeWindowName(Number(port), rootRefs(), store?.signal);
        if (timings) timings["SDK 调试窗口识别"] = Math.round(performance.now() - probeStarted);
        root.attributes = { ...root.attributes, "debug-window-name": windowName };
        // The preview screenshot and the SDK tree fetch are independent, so run them together:
        // the preview then carries the adopted tree without paying both waits back to back.
        const pendingPreviewScreen = preview?.beginTreeScreen?.();
        stage("核对 SDK 控件树");
        if (mergedTreeSupport.get(`${serial}|${packageName}`) === false) {
          await store!.onViewTreeReady!(packageName, root, "adopt");
        } else {
          // D: one content call publishes the SDK tree first and then renders the layers; the tree
          // is adopted mid-call so the partial previews still match against the final hierarchy.
          let settleTree!: (state: "landed" | "missing" | { error: unknown }) => void;
          const treePhase = new Promise<"landed" | "missing" | { error: unknown }>((resolve) => { settleTree = resolve; });
          // The merged call validates its reply against the adopted tree; resolve once the tree is final.
          let settleTreeReady!: () => void;
          const treeReady = new Promise<void>((resolve) => { settleTreeReady = resolve; });
          const treeFallback = (error: unknown) => {
            store?.signal?.throwIfAborted();
            if (error instanceof Error && /^(App 正在初始化|SDK 控件树(?:连续)?超时)/.test(error.message)) throw error;
            // ponytail: adoption failures fall back to the unchanged DDMS export, which re-runs its own checks.
            root.attributes = { ...root.attributes, "sdk-first-fallback": error instanceof Error ? error.message : "采集失败" };
          };
          const mergedStarted = performance.now();
          mergedVisible = captureSdkVisibleLayers(provider, adbPath, serial, packageName, root, preview ? async (partial) => {
            attachViewLayerImages(root, partial, { x: 0, y: 0 }, "sdk");
            await preview("layers");
          } : undefined, {
            treeReady,
            timings,
            onTree: async (value, checkedIdentity) => {
              try {
                await store!.onViewTreeReady!(packageName, root, "adopt", value, checkedIdentity);
              } catch (error) {
                treeFallback(error);
              } finally {
                settleTree("landed");
                settleTreeReady();
              }
            },
            onMissing: () => settleTree("missing"),
          }).finally(() => {
            if (timings) timings["SDK 合并调用（含失败）"] = Math.round(performance.now() - mergedStarted);
          });
          // The layer phase below re-awaits the same promise; a failed call must still unblock the tree phase.
          mergedVisible.catch(error => settleTree({ error }));
          const treeState = await treePhase;
          if (typeof treeState === "object") { settleTreeReady(); throw treeState.error; }
          if (treeState === "missing") {
            // The provider ignored withTree (older SDK) or failed to publish it: classic fetch.
            try {
              await store!.onViewTreeReady!(packageName, root, "adopt");
            } catch (error) {
              treeFallback(error);
            } finally {
              settleTreeReady();
            }
          }
        }
        sdkFirst = useVisibleSdk();
        const screenWaitStarted = performance.now();
        await pendingPreviewScreen;
        if (timings) timings["SDK 树采用后等待预览截图"] = Math.round(performance.now() - screenWaitStarted);
        await preview?.("tree");
      } catch (error) {
        store?.signal?.throwIfAborted();
        sdkFirst = false;
        // A window mismatch invalidates the starting tree, not SDK support. The outer
        // startup retry reads a fresh tree; exporting images against this tree wastes time.
        if (isSdkVisibleCaptureInterruption(error) || isStaleCaptureTreeError(error) || error instanceof Error && /^(App 正在初始化|SDK 控件树(?:连续)?超时)/.test(error.message)) throw error;
        // ponytail: probe or adoption failures fall back to the unchanged DDMS export, which re-runs its own checks.
        root.attributes = { ...root.attributes, "sdk-first-fallback": error instanceof Error ? error.message : "采集失败" };
      }
    }
    if (sdkFirst) {
      stage("SDK 抓取独立画面");
    } else {
      // The merged call owns the provider while it renders; settle it before the DDMS export.
      if (mergedVisible) await mergedVisible.catch(error => {
        if (isSdkVisibleCaptureInterruption(error)) {
          markInterruptedSdkImages(root, error);
          throw error;
        }
      });
      layers = await captureViewLayers(Number(port), {
        rootRefs: rootRefs(),
        onHierarchyTiming: info => {
          if (timings) for (const [name, value] of [["属性协议：连接", info.connectMs], ["属性协议：窗口列表", info.windowsMs],
            ["属性协议：身份探测", info.probeMs], ["属性协议：V2读取", info.exportMs], ["属性协议：主机解码", info.decodeMs],
            ["属性协议：合计", info.totalMs]] as const) timings[name] = Math.round(value);
          root.attributes = { ...root.attributes, "view-property-probe-requests": String(info.probeRequests),
            "view-property-export-requests": String(info.exportRequests), "view-property-success": String(info.success),
            "view-property-phase": info.phase };
        },
        onHierarchy: async (dump, name) => { applyViewProperties(root, dump, true); windowName = name; root.attributes = { ...root.attributes, "debug-window-name": name }; await preview?.("tree"); stage("核对 SDK 控件树"); await inspectionContext.getStore()?.onViewTreeReady?.(packageName, root); stage(useVisibleSdk() ? "SDK 抓取独立画面" : "DDMS 批量抓图"); },
        onBatchTiming: batchTiming,
        skipImages: useVisibleSdk,
        signal: inspectionContext.getStore()?.signal,
      });
    }
    let sdkVisible = false;
    let specialRefs = new Set<string>();
    let pureRefs = new Set<string>();
    if (useVisibleSdk()) {
      try {
        const started = performance.now();
        const streamVersion = root.attributes?.["sdk-visible-stream"] ?? "";
        if (!mergedVisible && preview && !["1", "2"].includes(streamVersion)) console.log(`[visible] partial previews disabled (stream=${streamVersion || "missing"})`);
        const visible = mergedVisible ? await mergedVisible : await captureSdkVisibleLayers(provider, adbPath, serial, packageName, root, preview && ["1", "2"].includes(streamVersion) ? async (partial) => {
          attachViewLayerImages(root, partial, { x: 0, y: 0 }, "sdk");
          await preview("layers");
        } : undefined);
        if (visible.tree?.status === "unsupported") mergedTreeSupport.set(`${serial}|${packageName}`, false);
        layers = visible.layers;
        specialRefs = visible.specialRefs;
        pureRefs = visible.pureRefs;
        if (timings) Object.assign(timings, {
          ...visible.phases,
          "SDK 可见层图": Math.round(performance.now() - started),
          "SDK 设备绘制": visible.timing.renderMs,
          "SDK 图像编码": visible.timing.encodeMs,
          "SDK 设备总耗时": visible.timing.durationMs,
          "SDK 调用往返": visible.timing.callMs,
          "SDK 文件读取": visible.timing.readMs,
        });
        sdkVisible = true;
      } catch (error) {
        inspectionContext.getStore()?.signal?.throwIfAborted();
        // A transient capture failure says nothing about protocol support. Only an explicit
        // unsupported tree reply above disables merging for subsequent captures.
        if (isStaleCaptureTreeError(error)) throw error;
        if (isSdkVisibleCaptureInterruption(error)) {
          // Partial records already passed their identity/geometry/CRC checks. Keep them;
          // the outer handler marks only missing images and rechecks the foreground window.
          markInterruptedSdkImages(root, error);
          stage("SDK 采集中断，保留已到达预览");
          throw error;
        }
        attachViewLayerImages(root, []);
        root.attributes = { ...root.attributes, "sdk-visible-fallback": error instanceof Error ? error.message : "采集失败" };
        stage("DDMS 回退抓图");
        layers = await captureViewLayers(Number(port), {
          rootRefs: root.children.map((node) => node.attributes?.["view-ref"]).filter((value): value is string => Boolean(value)),
          onHierarchy: () => undefined, onBatchTiming: batchTiming, signal: inspectionContext.getStore()?.signal,
        });
      }
    }
    // DDMS images use window coordinates; the restored tree uses screen coordinates.
    const windowBounds = root.children[0].bounds;
    const matchStarted = performance.now();
    let count = attachViewLayerImages(root, layers, sdkVisible ? { x: 0, y: 0 } : { x: windowBounds?.left ?? 0, y: windowBounds?.top ?? 0 }, sdkVisible ? "sdk" : "ddms");
    if (timings) timings["DDMS 匹配控件"] = Math.round(performance.now() - matchStarted);
    await preview?.("layers");
    // A preview callback may cancel this capture. Do not start more work afterward.
    inspectionContext.getStore()?.signal?.throwIfAborted();
    // The missing-bitmap fallback and the final screenshot are independent: capture the screen
    // while the fallback call runs instead of paying both waits back to back.
    const finalScreen: Promise<Awaited<ReturnType<typeof captureScreen>> | null> = (async () => {
      try {
        const signal = captureSignal(inspectionContext.getStore()?.signal, FINAL_SCREEN_TIMEOUT_MS);
        return await inspectionContext.run({ ...(inspectionContext.getStore() ?? {}), signal }, () => captureScreen(adbPath, serial));
      } catch {
        inspectionContext.getStore()?.signal?.throwIfAborted();
        return null;
      }
    })();
    // Fallback work may fail before returning this promise to its awaiting caller.
    // Observe rejection immediately while preserving it for the eventual await.
    void finalScreen.catch(() => undefined);
    const fallback: UiNode[] = [];
    let sdkTypeOnlyAvoided = 0;
    const pending = [root];
    while (pending.length) {
      const node = pending.pop()!;
      if (!node.visibleToUser) continue;
      if (node.attributes?.["view-ref"] && pureRefs.has(node.attributes["view-ref"]) && node.layerImageStatus !== "captured") {
        node.attributes["skip-draw"] = "true";
        node.layerImageStatus = "unavailable";
      }
      const bounds = node.bounds;
      if (node.layerImageStatus === "captured" && node.attributes?.["skip-draw"] !== "true"
          && !pureRefs.has(node.attributes?.["view-ref"] ?? "")
          && !(sdkVisible && !specialRefs.has(node.attributes?.["view-ref"] ?? ""))
          && !ordinaryViewClasses.has(node.className ?? "") && hasSdkOrdinaryViewType(node)
          && bounds && bounds.right > bounds.left && bounds.bottom > bounds.top && bounds.right > 0 && bounds.bottom > 0
          && bounds.left < (root.bounds?.right ?? Infinity) && bounds.top < (root.bounds?.bottom ?? Infinity)
          && (bounds.right - bounds.left) * (bounds.bottom - bounds.top) <= 4_000_000) sdkTypeOnlyAvoided++;
      if (node.attributes?.["view-ref"] && needsViewBitmapFallback(node, sdkVisible && !specialRefs.has(node.attributes["view-ref"]), pureRefs.has(node.attributes["view-ref"])) && bounds && bounds.right > bounds.left && bounds.bottom > bounds.top && bounds.right > 0 && bounds.bottom > 0 && bounds.left < (root.bounds?.right ?? Infinity) && bounds.top < (root.bounds?.bottom ?? Infinity)) {
        if ((bounds.right - bounds.left) * (bounds.bottom - bounds.top) > 4_000_000) {
          if (!node.layerImageDataUrl) {
            node.layerImageStatus = "failed";
            node.attributes["image-capture-error"] = "控件位图尺寸超过 400 万像素上限";
          }
        } else fallback.push(node);
      }
      pending.push(...node.children);
    }
    root.attributes = { ...root.attributes, "jdwp-fallback-sdk-type-avoided": String(sdkTypeOnlyAvoided) };
    if (fallback.length) {
      stage("补齐独立背景与视频画面");
      try {
        fallback.sort((a, b) => Number(b.layerImageStatus === "ambiguous") - Number(a.layerImageStatus === "ambiguous"));
        const requested = fallback.map((node) => node.attributes!["view-ref"]);
        type SupplementOutcome = {
          images: Map<string, { width: number; height: number; x?: number; y?: number; imageDataUrl: string; kind: "own" | "texture" | "surface"; empty: boolean }>;
          failures: Map<string, string>;
          kinds: Map<string, "own" | "texture" | "surface">;
          skipDraw: Set<string>;
          requested: number;
          skipped: number;
          source: "sdk" | "jdwp";
        };
        let outcome: SupplementOutcome | null = null;
        const jdwpFallback = async () => {
          const jdwp = await captureViewBitmaps(Number(port), bitmapTarget(provider, adbPath, serial, packageName, root, root.children[0].attributes!["view-ref"], windowName), fallback.map((node) => ({ ref: node.attributes!["view-ref"], captureOwn: node.layerImageStatus !== "captured" })), inspectionContext.getStore()?.signal);
          root.attributes = { ...root.attributes, "jdwp-fallback-field-requests": String(jdwp.timing.fieldReadRequests), "jdwp-fallback-field-batches": String(jdwp.timing.batchedFieldReads) };
          root.attributes = { ...root.attributes, "jdwp-setup-requests": String(jdwp.timing.setupRequests), "jdwp-thread-name-requests": String(jdwp.timing.threadNameRequests) };
          if (timings) for (const [name, value] of [["JDWP 初始化：连接握手", jdwp.timing.connectMs], ["JDWP 初始化：ID协议", jdwp.timing.idsMs],
            ["JDWP 初始化：找主线程", jdwp.timing.threadLookupMs], ["JDWP 初始化：安全消息边界", jdwp.timing.boundaryMs],
            ["JDWP 初始化：类与方法", jdwp.timing.metadataMs], ["JDWP 初始化：窗口身份", jdwp.timing.rootVerifyMs]] as const) timings[name] = Math.round(value);
          if (timings) Object.assign(timings, { "JDWP 初始化": jdwp.timing.setupMs, "JDWP 定位与识别": jdwp.timing.lookupMs, "JDWP 补图": jdwp.timing.captureMs, "JDWP 生成位图": jdwp.timing.snapshotMs, "JDWP 传输像素": jdwp.timing.pixelsMs, "JDWP 压缩图片": jdwp.timing.compressMs });
          return { images: jdwp.images, failures: jdwp.failures, kinds: jdwp.kinds, skipDraw: jdwp.skipDraw, requested: jdwp.timing.requested, skipped: jdwp.timing.skipped, source: "jdwp" as const };
        };
        if (sdkVisible && requested.length <= 80 && requested.join(";").length <= 11_000) {
          outcome = await captureSdkRefOrFallback<SupplementOutcome>(async () => {
            const sdk = await captureSdkRefLayers(provider, adbPath, serial, packageName, root, requested);
            if (timings) Object.assign(timings, { "SDK 补齐": sdk.timing.durationMs, "SDK 补齐调用": sdk.timing.callMs, "SDK 补齐读取": sdk.timing.readMs, "SDK 补齐绘制": sdk.timing.renderMs, "SDK 补齐编码": sdk.timing.encodeMs });
            return { images: sdk.images, failures: sdk.failures, kinds: sdk.kinds, skipDraw: sdk.skipDraw, requested: sdk.timing.requested, skipped: 0, source: "sdk" };
          }, jdwpFallback, error => {
            root.attributes = { ...root.attributes, "sdk-ref-fallback": error instanceof Error ? error.message : "采集失败" };
          }, inspectionContext.getStore()?.signal);
        }
        if (!outcome) outcome = await jdwpFallback();
        const { images, failures, kinds, skipDraw } = outcome;
        root.attributes = { ...root.attributes, "fallback-source": outcome.source, "jdwp-fallback-candidates": String(fallback.length), "jdwp-fallback-requested": String(outcome.requested), "jdwp-fallback-skipped": String(outcome.skipped) };
        if (failures.size) root.attributes = { ...root.attributes, "texture-capture-warning": `${failures.size} 个控件未完成独立画面补采，原因可在属性栏查看；已保留其余采集结果。` };
        for (const node of fallback) {
          const ref = node.attributes!["view-ref"];
          if (skipDraw.has(ref)) { node.attributes!["skip-draw"] = "true"; node.layerImageStatus = "unavailable"; }
          const kind = kinds.get(ref);
          // A DDMS placeholder is not the Surface/Texture buffer, even when it
          // happens to contain opaque pixels. Never report it as captured video.
          if (outcome.source === "jdwp" && (kind === "surface" || kind === "texture")) {
            if (node.layerImageStatus === "captured") count--;
            delete node.layerImageDataUrl; delete node.layerImageSize; delete node.layerImageEmpty; delete node.layerCapturePlacement;
            node.layerImageStatus = "failed";
            node.attributes!["image-source"] = kind === "surface" ? "SurfaceView / OpenGL 独立缓冲层" : "TextureView 自身缓冲区";
          }
          const failure = failures.get(ref);
          if (failure) { node.attributes!["image-capture-error"] = failure; if (!node.layerImageDataUrl) node.layerImageStatus = "failed"; }
          const image = images.get(ref);
          if (!image) continue;
          const wasCaptured = node.layerImageStatus === "captured";
          if (applyFallbackLayerImage(node, image)) {
            node.attributes!["image-capture-source"] = outcome.source;
            node.attributes!["image-source"] = `${outcome.source === "sdk" ? "SDK" : "JDWP"} 补图：${node.attributes!["image-source"]}`;
            if (!wasCaptured) count++;
          }
        }
        annotateFallbackGeometry(root, images);
        if (outcome.source === "sdk") {
          const retryStarted = performance.now();
          try {
            const branchRecovery = root.attributes?.["sdk-branch-geometry-version"] === "1" && root.attributes?.["sdk-tree-source"] === "merged";
            const retry = branchRecovery ? await (async () => {
              const signal = captureSignal(inspectionContext.getStore()?.signal, 5_000);
              return await inspectionContext.run({ ...(inspectionContext.getStore() ?? {}), signal }, async () => {
                let before: Awaited<ReturnType<typeof checkedDebugTarget>> | undefined;
                const confirm = async () => {
                  const current = await checkedDebugTarget(adbPath, serial, packageName);
                  if (before && (current.component !== before.component || current.windowId !== before.windowId)
                    || await singleAppPid(adbPath, serial, packageName, current) !== Number(processId))
                    throw new Error("小分支恢复时 App、进程或窗口已变化");
                  before ??= current;
                };
                const recovered = await recoverSdkGeometryBranch(root, fallback,
                  (path, branchRef) => readSdkBranchGeometry(provider, adbPath, serial, { packageName, pid: Number(processId),
                    processInstance: root.attributes!["sdk-visible-process-instance"], rootRef: root.children[0].attributes!["view-ref"], branchRef }, path),
                  async refs => {
                    root.attributes = { ...root.attributes, "geometry-retry-requested": String(refs.length), "geometry-retry-recovered": "0" };
                    stage("恢复移动分支的几何和独立画面");
                    return captureSdkRefLayers(provider, adbPath, serial, packageName, root, refs);
                  }, confirm, signal, (selection, candidates) => {
                    root.attributes = { ...root.attributes, "geometry-retry-candidates": String(candidates),
                      "geometry-retry-selected": String(selection.failed.length), "geometry-retry-selection": selection.reason };
                  }, diagnostics => {
                    root.attributes = { ...root.attributes, "geometry-retry-recovery-phase": diagnostics.phase,
                      "geometry-retry-total-ms": String(diagnostics.totalMs) };
                    if (diagnostics.geometry) root.attributes = { ...root.attributes,
                      "geometry-retry-phase": diagnostics.geometry.phase,
                      "geometry-retry-elapsed-ms": String(diagnostics.geometry.elapsedMs) };
                    for (const [key, value] of [["first-read", diagnostics.geometry?.firstReadMs], ["capture", diagnostics.geometry?.captureMs],
                      ["verify-read", diagnostics.geometry?.verifyReadMs], ["selection", diagnostics.selectionMs],
                      ["window-before", diagnostics.windowBeforeMs], ["geometry", diagnostics.geometryMs],
                      ["window-after", diagnostics.windowAfterMs], ["stage", diagnostics.stageMs], ["commit", diagnostics.commitMs]] as const) {
                      if (value !== undefined) root.attributes[`geometry-retry-${key}-ms`] = String(value);
                    }
                  });
                if (recovered.requested) {
                  const publishAt = performance.now();
                  try {
                  count += recovered.countDelta;
                  root.attributes = { ...root.attributes, "geometry-retry-mode": "atomic-sdk-branch" };
                  delete root.attributes["texture-capture-warning"];
                  const warning = layerCaptureFailureWarning(root);
                  if (warning) root.attributes["texture-capture-warning"] = warning;
                  await preview?.("layers");
                  } finally { root.attributes = { ...root.attributes,
                    "geometry-retry-publish-ms": String(Math.max(0, Math.round(performance.now() - publishAt))) }; }
                }
                return { ...recovered, branchRecovery: true };
              });
            })() : await retryFallbackGeometry(fallback, async refs => {
              root.attributes = { ...root.attributes, "geometry-retry-requested": String(refs.length), "geometry-retry-recovered": "0" };
              stage("重试少量移动控件的独立画面");
              const signal = captureSignal(inspectionContext.getStore()?.signal, 5_000);
              return await inspectionContext.run({ ...(inspectionContext.getStore() ?? {}), signal }, async () =>
                (await captureSdkRefLayers(provider, adbPath, serial, packageName, root, refs)).images);
            }, root);
            if (!("branchRecovery" in retry)) count += retry.recovered;
            if (retry.requested) {
              root.attributes = { ...root.attributes, "geometry-retry-requested": String(retry.requested), "geometry-retry-recovered": String(retry.recovered) };
              if (timings) timings["几何失配局部重试"] = Math.round(performance.now() - retryStarted);
            }
          } catch (error) {
            inspectionContext.getStore()?.signal?.throwIfAborted();
            root.attributes = { ...root.attributes, "geometry-retry-error": error instanceof Error ? error.message : "局部补采失败" };
            if (timings) timings["几何失配局部重试"] = Math.round(performance.now() - retryStarted);
            // Keep the original per-layer reason and all previously verified images; no DDMS retry.
          }
        }
      } catch (error) {
        inspectionContext.getStore()?.signal?.throwIfAborted();
        markFailedSupplementImages(root, fallback, error);
      }
    }
    return { imageCount: count, finalScreen };
  } finally {
    await inspectionContext.exit(() => runDeviceAdb(adbPath, serial, ["forward", "--remove", `tcp:${port}`])).catch(() => undefined);
  }
}
