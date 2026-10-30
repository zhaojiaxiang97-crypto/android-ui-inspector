import { createHash } from "node:crypto";
import type { QmlGroupImage, UiNode, UiSnapshot, ViewRefreshResult, ViewStyleResult } from "../../shared/types";
import { pngSize } from "../device/capture-display";
import { captureViewLayers } from "./view-debug";
import { captureViewBitmaps } from "./view-bitmaps";
import { adoptSdkTree, canUseSdkSingleTextCapture, joinSdkRefreshEvidence, joinSdkTreeAndDebugImages, sdkGroupBranchMatches } from "../sdk/sdk-hybrid";
import { type ForegroundTarget, targetActivitySection, automationAdb, singleAppPid, checkedDebugTarget } from "../device/target";
import { debugViewTree, applyViewProperties, nodeById, nativeViewBranchContextMatches, nativeViewNodeMatches, describeBranchContextMismatch, isTransientTreeReadError, nativeViewBranchMatches, countNodes } from "./native-tree";
import { readSdkCapture, captureSdkRefLayers, bitmapTarget } from "./sdk-images";
import { withCommandSignal, withoutCommandSignal } from "../device/command-context";
import { createCaptureRunContext, type CaptureRunContext } from "./run-context";
import { runDeviceAdb, COMMAND_TIMEOUT_MS } from "../device/runtime";
import { type FallbackLayerImage, applyCapturePlacement } from "./layer-images";
import type { ProviderClient } from "../sdk/provider-session";
import { parseViewStyleReply } from "../sdk/capture-protocol";


// 单次控件刷新（分支或列表）的可见控件上限。
const MAX_VIEW_REFRESH_NODES = 64;

// 分支/列表刷新共用的活树读取器：dumpsys 段落 + JDWP 属性 + merged 快照 SDK 同源 adopt，
// 瞬态读树失败有界重试，身份/层级变化立即拒绝。返回 { 整树, 目标节点 }。
function buildReadCurrent(provider: ProviderClient, args: {
  adbPath: string; serial: string; packageName: string; snapshot: UiSnapshot; root: UiNode;
  section: string; before: ForegroundTarget; port: string; rootRef: string; windowName: string;
  processId: number; branch: boolean; nodeId: string; context: CaptureRunContext;
}): () => Promise<{ root: UiNode; node: UiNode }> {
  const { adbPath, serial, packageName, snapshot, root, section, before, port, rootRef, windowName, processId, branch, nodeId, context } = args;
  const signal = context.signal;
  return async () => {
    let currentSection = section;
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      if (attempt > 0) await new Promise<void>(resolve => setTimeout(resolve, attempt === 1 ? 600 : 1200)); // 编码竞态与 UI 变更相关：慢态设备间隔更长
      try {
        const dumped = debugViewTree(currentSection, before);
        let name = "";
        await captureViewLayers(Number(port), {
          rootRefs: [rootRef], skipImages: true, signal,
          onHierarchy: (dump, window) => { applyViewProperties(dumped, dump, true); name = window; },
        });
        if (name !== windowName) throw new Error("控件身份、位置或层级已变化，请重新采集整页。");
        let current = dumped;
        // D2/D3 合并快照的结构来自 SDK 树（adoptSdkTree 重建，容忍 dumpsys 丢弃无坐标包装层）；
        // dumpsys 活树缺这些层时路径错位、身份校验必然拒绝。merged 快照的读树先做同源 adopt 再对比。
        if (snapshot.inspectionSource === "debug-hybrid" && root.attributes?.["sdk-tree-source"] === "merged") {
          const sdk = await readSdkCapture(provider, adbPath, serial, packageName, context);
          adoptSdkTree(current, sdk, packageName, processId);
          current.attributes = { ...current.attributes, "sdk-tree-source": "merged" };
          console.log("[branch-refresh] 活树已按 SDK 结构同源重建（快照为 merged 采集）。");
        } else if (!branch && snapshot.inspectionSource === "debug-hybrid"
            && (["1", "2"].includes(root.attributes?.["sdk-debug-metadata-version"] ?? "")
              || process.env.INSPECTOR_ENABLE_SDK_TEXT_REFRESH === "1" && canUseSdkSingleTextCapture(root, nodeById(root, nodeId)!))) {
          // A DDMS-origin live tree has no SDK flags. Re-read and verify the whole SDK
          // binding before using fresh acceleration evidence or explicit business values.
          const sdk = await readSdkCapture(provider, adbPath, serial, packageName, context);
          current = joinSdkRefreshEvidence({ ...snapshot, root: current, inspectionSource: "debug-view" }, sdk, packageName, processId, root.attributes!["sdk-process-instance"]).root!;
        }
        if (!(branch ? nativeViewBranchContextMatches(root, current, nodeId) : nativeViewNodeMatches(root, current, nodeId))) {
          console.log(`[branch-refresh] 身份校验失败：${branch ? describeBranchContextMismatch(root, current, nodeId) : `单节点 ${nodeId}`}（快照来源=${snapshot.inspectionSource} 结构=${root.attributes?.["sdk-tree-source"] ?? "dump"}）`);
          throw new Error("控件身份、位置或层级已变化，请重新采集整页。");
        }
        return { root: current, node: nodeById(current, nodeId)! };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (attempt >= 2 || !isTransientTreeReadError(message)) throw error;
        // 瞬时读树失败：重取一次 dumpsys 段落后重读；身份变化类错误不重试。
        const retry = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", packageName]);
        if (retry.code === 0) {
          try { currentSection = targetActivitySection(retry.stdout.toString("utf8"), before); } catch { /* 保留原段落 */ }
        }
      }
    }
  };
}

// 可见项分批：以条目为最小单位，把各条目的可见控件数按顺序装箱，每批总数 ≤ cap；
// 单条超过 cap 的条目进 oversized（由调用方按 partial-failure 语义跳过并记录，不阻断整批）。
export function partitionViewItems(sizes: number[], cap: number): { batches: number[][]; oversized: number[] } {
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("分批上限无效。");
  const batches: number[][] = [], oversized: number[] = [];
  let current: number[] = [], used = 0;
  for (let index = 0; index < sizes.length; index++) {
    const size = sizes[index] ?? 0;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("条目可见控件数无效。");
    if (size > cap) {
      if (current.length) { batches.push(current); current = []; used = 0; }
      oversized.push(index);
      continue;
    }
    if (used + size > cap && current.length) { batches.push(current); current = []; used = 0; }
    current.push(index);
    used += size;
  }
  if (current.length) batches.push(current);
  return { batches, oversized };
}

export function captureViewNodes(provider: ProviderClient, serial: string, snapshot: UiSnapshot, nodeId: string, branch = false, signal?: AbortSignal): Promise<ViewRefreshResult> {
  const context = createCaptureRunContext({ signal, allowAppRestart: false });
  return withCommandSignal(signal, async () => {
    const started = performance.now();
    const timings: Record<string, number> = {};
    const measure = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
      const begin = performance.now();
      try { return await work(); }
      finally { timings[name] = Math.round(performance.now() - begin); }
    };
    const root = snapshot.root, packageName = root?.package;
    const target = root && nodeById(root, nodeId);
    const rootRef = root?.children[0]?.attributes?.["view-ref"];
    const processId = Number(root?.attributes?.["debug-process-id"]);
    const windowName = root?.attributes?.["debug-window-name"];
    const component = root?.attributes?.["debug-component"];
    if ((snapshot.inspectionSource !== "debug-view" && snapshot.inspectionSource !== "debug-hybrid") || snapshot.serial !== serial || !root || !packageName || !target?.bounds
      || !target.attributes?.["view-ref"] || !rootRef || !windowName || !component || !Number.isSafeInteger(processId) || processId < 1)
      throw new Error("这份快照不支持控件刷新，请重新采集当前页面。");
    const adbPath = automationAdb(serial);
    const sameProcess = async () => {
      return await singleAppPid(adbPath, serial, packageName) === processId;
    };
    // Independent read-only checks; all must finish before attaching or capturing.
    const [before, processMatches, activity] = await Promise.all([
      measure("检查前台", () => checkedDebugTarget(adbPath, serial, packageName)),
      measure("检查进程", sameProcess),
      measure("读取Activity", () => runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", packageName])),
    ]);
    if (before.component !== component || !processMatches)
      throw new Error("目标 App 或进程已变化，请重新采集整页。");
    if (activity.code !== 0) throw new Error("无法核对当前控件树，请重新采集整页。");
    const section = targetActivitySection(activity.stdout.toString("utf8"), before);
    const forwarded = await measure("建立转发", () => withoutCommandSignal(() => runDeviceAdb(adbPath, serial, ["forward", "tcp:0", `jdwp:${processId}`])));
    const port = forwarded.stdout.toString("utf8").trim();
    if (forwarded.code !== 0 || !/^\d+$/.test(port)) throw new Error("无法连接当前 Debug App。");
    try {
      const readCurrent = buildReadCurrent(provider, { adbPath, serial, packageName, snapshot, root, section, before, port, rootRef, windowName, processId, branch, nodeId, context });
      const first = await measure("抓图前读树与校验", readCurrent);
      const beforeCapture = first.node;
      const candidates = branch ? [beforeCapture] : [target];
      if (branch) for (let cursor = 0; cursor < candidates.length; cursor++) {
        candidates.push(...candidates[cursor].children);
      }
      const requested = candidates.filter(node => node.visibleToUser && node.attributes?.["view-ref"] && node.bounds
        && node.bounds.right > node.bounds.left && node.bounds.bottom > node.bounds.top);
      if (requested.length > MAX_VIEW_REFRESH_NODES) throw new Error(`此分支有 ${requested.length} 个可见控件，超过单次 ${MAX_VIEW_REFRESH_NODES} 个上限；请选择较小分支或改用可见项分批刷新。`);
      if (!requested.length) {
        console.log(`[branch-refresh] 分支无可刷新可见控件：id=${nodeId} cls=${beforeCapture.className ?? "-"} ref=${beforeCapture.attributes?.["view-ref"] ?? "-"} visible=${beforeCapture.visibleToUser} bounds=${beforeCapture.bounds?.raw ?? "-"} 分支子树=${candidates.length}（活树路径已通过身份校验）`);
        throw new Error("此分支没有可刷新的可见控件。");
      }
      const debugCanvas = !branch && process.env.INSPECTOR_ENABLE_SDK_TEXT_REFRESH === "1"
        && snapshot.inspectionSource === "debug-hybrid" && canUseSdkSingleTextCapture(root, beforeCapture);
      const sdkRefs = Boolean(root.attributes?.["sdk-visible-process-instance"] || debugCanvas);
      const capture = await measure("独立取图与传输", async () => sdkRefs
        ? await captureSdkRefLayers(provider, adbPath, serial, packageName, root, requested.map(node => node.attributes!["view-ref"]), debugCanvas)
        : await captureViewBitmaps(Number(port), bitmapTarget(provider, adbPath, serial, packageName, root, rootRef, windowName), requested.map(node => ({ ref: node.attributes!["view-ref"], captureOwn: true })), signal));
      const images: ReadonlyMap<string, FallbackLayerImage> = capture.images;
      const { failures, kinds, skipDraw } = capture;
      for (const [name, value] of Object.entries(capture.timing)) {
        if (name.endsWith("Ms")) timings[`取图明细.${name}`] = value;
      }
      const second = await measure("抓图后读树与校验", readCurrent);
      const current = second.node;
      const [after, processStillMatches] = await Promise.all([
        measure("复核前台", () => checkedDebugTarget(adbPath, serial, packageName)),
        measure("复核进程", sameProcess),
      ]);
      if (after.component !== before.component || after.windowId !== before.windowId || !processStillMatches)
        throw new Error("目标 App、进程或窗口已变化，请重新采集整页。");
      if (branch && !nativeViewBranchMatches(first.root, second.root, nodeId))
        throw new Error("分支在刷新期间变化，请重试。");
      if (branch) {
        for (const node of requested) if (node.bounds?.raw !== nodeById(second.root, node.id)?.bounds?.raw)
          throw new Error("分支在补图期间移动，请重试。");
        let latestRoot = second.root;
        if (snapshot.inspectionSource === "debug-hybrid") {
          const sdk = await readSdkCapture(provider, adbPath, serial, packageName, context);
          const merged = joinSdkTreeAndDebugImages({ ...snapshot, inspectionSource: "debug-view", root: second.root,
            nodeCount: countNodes(second.root) }, sdk, packageName, processId);
          if (merged.root?.attributes?.["sdk-process-instance"] !== root.attributes?.["sdk-process-instance"])
            throw new Error("SDK 进程实例已变化，请重新采集整页。");
          latestRoot = merged.root!;
          const confirmed = await checkedDebugTarget(adbPath, serial, packageName);
          if (confirmed.component !== before.component || confirmed.windowId !== before.windowId || !await sameProcess())
            throw new Error("SDK 补验时窗口已变化，请重新采集整页。");
        }
        const oldByRef = new Map<string, UiNode>();
        const oldPending = [target];
        for (let cursor = 0; cursor < oldPending.length; cursor++) {
          const old = oldPending[cursor], ref = old.attributes?.["view-ref"];
          if (!ref || oldByRef.has(ref)) throw new Error("原分支控件身份重复，请重新采集整页。");
          oldByRef.set(ref, old);
          oldPending.push(...old.children);
        }
        const latestBranch = nodeById(latestRoot, nodeId)!;
        const requestedRefs = new Set(requested.map(node => node.attributes!["view-ref"]));
        const allRefs = new Set<string>();
        const wholeTree = [latestRoot];
        for (let cursor = 0; cursor < wholeTree.length; cursor++) {
          const node = wholeTree[cursor], ref = node.attributes?.["view-ref"];
          if (ref && allRefs.has(ref)) throw new Error("刷新后的控件树包含重复对象身份。");
          if (ref) allRefs.add(ref);
          wholeTree.push(...node.children);
        }
        const seen = new Set<string>();
        const nodeFailures: ViewRefreshResult["failures"] = [];
        const refreshedAt = new Date().toISOString();
        let refreshed = 0;
        const pending = [latestBranch];
        for (let cursor = 0; cursor < pending.length; cursor++) {
          const node = pending[cursor], ref = node.attributes?.["view-ref"];
          if (!ref || seen.has(ref)) throw new Error("刷新后的分支控件身份重复。");
          seen.add(ref);
          pending.push(...node.children);
          if (!requestedRefs.has(ref)) { node.layerImageStatus = node.visibleToUser ? "unavailable" : "hidden"; continue; }
          const old = oldByRef.get(ref), image = images.get(ref), kind = kinds.get(ref);
          const sizeMatches = image && node.bounds && image.width === node.bounds.right - node.bounds.left && image.height === node.bounds.bottom - node.bounds.top
            && (image.x === undefined || Math.abs(image.x - node.bounds.left) <= 1) && (image.y === undefined || Math.abs(image.y - node.bounds.top) <= 1);
          const attributes = node.attributes = { ...node.attributes };
          delete attributes["image-capture-error"];
          delete attributes["image-refresh-error"];
          if (image && sizeMatches) {
            node.layerImageStatus = "captured";
            node.layerImageDataUrl = image.imageDataUrl;
            applyCapturePlacement(node, kind === "own" ? image.geometry : undefined, image.width, image.height);
            node.layerImageSize = { width: image.width, height: image.height };
            node.layerImageEmpty = image.empty;
            attributes["image-source"] = kind === "surface" ? "SurfaceView / OpenGL 独立缓冲层" : kind === "texture" ? "TextureView 自身缓冲区" : "按对象身份独立采集，不含子节点";
            attributes["image-refreshed-at"] = refreshedAt;
            refreshed++;
          } else if (!image && skipDraw.has(ref)) {
            node.layerImageStatus = "unavailable";
            attributes["skip-draw"] = "true";
            attributes["image-source"] = "结构容器，系统跳过自身绘制";
            attributes["image-refreshed-at"] = refreshedAt;
            refreshed++;
          } else {
            const reason = image ? "控件画面尺寸已变化，请重试。" : failures.get(ref) ?? "未取得控件独立画面。";
            nodeFailures.push({ id: node.id, message: reason });
            if (old?.layerImageStatus === "captured" && old.layerImageDataUrl && old.bounds?.raw === node.bounds?.raw && old.className === node.className) {
              node.layerImageStatus = old.layerImageStatus;
              node.layerImageDataUrl = old.layerImageDataUrl;
              delete node.layerCapturePlacement;
              node.layerImageSize = old.layerImageSize;
              node.layerImageEmpty = old.layerImageEmpty;
              attributes["image-source"] = old.attributes?.["image-source"] ?? "原快照独立画面";
              if (old.attributes?.["image-refreshed-at"]) attributes["image-refreshed-at"] = old.attributes["image-refreshed-at"];
              attributes["image-refresh-error"] = `${reason} 已保留旧画面。`;
            } else {
              node.layerImageStatus = "failed";
              attributes["image-capture-error"] = reason;
              delete attributes["image-source"];
            }
          }
        }
        if (!refreshed) throw new Error(`分支补图全部失败：${nodeFailures[0]?.message ?? "未取得独立画面"}；原快照已保留。`);
        signal?.throwIfAborted();
        return { nodes: [], failures: nodeFailures, branch: latestBranch, timings };
      }
      const beforeNodes = new Map<string, UiNode>(), currentNodes = new Map<string, UiNode>();
      for (const node of [beforeCapture, current]) {
        const map = node === beforeCapture ? beforeNodes : currentNodes;
        const pending = [node];
        for (let cursor = 0; cursor < pending.length; cursor++) { map.set(pending[cursor].id, pending[cursor]); pending.push(...pending[cursor].children); }
      }
      const nodes: UiNode[] = [], nodeFailures: ViewRefreshResult["failures"] = [];
      const refreshedAt = new Date().toISOString();
      for (const original of requested) {
        const ref = original.attributes!["view-ref"], latest = currentNodes.get(original.id)!;
        const image = images.get(ref);
        const reason = beforeNodes.get(original.id)?.bounds?.raw !== latest.bounds?.raw ? "控件在刷新期间移动了，请重试。"
          : image && latest.bounds && (image.width !== latest.bounds.right - latest.bounds.left || image.height !== latest.bounds.bottom - latest.bounds.top) ? "控件画面尺寸已变化，请重新采集整页。"
          : !image && !skipDraw.has(ref) ? failures.get(ref) ?? "未取得控件独立画面；原快照已保留。" : null;
        if (reason) { nodeFailures.push({ id: original.id, message: reason }); continue; }
        const kind = kinds.get(ref);
        const attributes: Record<string, string> = { ...original.attributes, ...latest.attributes,
          "image-source": image ? kind === "surface" ? "SurfaceView / OpenGL 独立缓冲层" : kind === "texture" ? "TextureView 自身缓冲区" : "按对象身份独立采集，不含子节点" : "结构容器，系统跳过自身绘制",
          "image-refreshed-at": refreshedAt,
          "image-refresh-route": debugCanvas ? "sdk-text-hardware" : sdkRefs ? "sdk-refs" : "jdwp",
        };
        delete attributes["image-capture-error"];
        delete attributes["image-refresh-error"];
        nodes.push({
          ...original, bounds: latest.bounds, text: latest.text, contentDesc: latest.contentDesc, clickable: latest.clickable,
          debugMetadata: latest.debugMetadata,
          enabled: latest.enabled, focusable: latest.focusable, focused: latest.focused,
          selected: latest.selected, scrollable: latest.scrollable, attributes,
          layerImageStatus: image ? "captured" : "unavailable", layerImageDataUrl: image?.imageDataUrl,
          layerImageSize: image ? { width: image.width, height: image.height } : undefined,
          layerImageEmpty: image?.empty, children: [], // The renderer keeps the original subtree.
        });
        if (debugCanvas && image) applyCapturePlacement(nodes[nodes.length - 1], image.geometry, image.width, image.height);
      }
      if (!nodes.length) throw new Error(nodeFailures.length === 1 ? nodeFailures[0].message : `${nodeFailures.length} 个控件均未刷新；原快照已保留。`);
      signal?.throwIfAborted();
      return { nodes, failures: nodeFailures, timings };
    } finally {
      await measure("移除转发", () => withoutCommandSignal(() => runDeviceAdb(adbPath, serial, ["forward", "--remove", `tcp:${port}`]))).catch(() => undefined);
      timings["总耗时"] = Math.round(performance.now() - started);
      console.log(`[node-refresh-timings] ${JSON.stringify({ scope: branch ? "branch" : "node", timings })}`);
    }
  });
}

// 可见项分批刷新（大列表）：刷新目标节点的直接子层——视口内条目按 ≤MAX_VIEW_REFRESH_NODES 的
// 批次补图、按对象身份合并；屏外条目保留旧画面并标注 out-of-viewport；刷新期间列表结构或条目
// 位置变化、条目身份漂移均安全拒绝并提示整页重采；单条超过上限的条目按 partial-failure 跳过。
export function captureListViewItems(provider: ProviderClient, serial: string, snapshot: UiSnapshot, nodeId: string, signal?: AbortSignal): Promise<ViewRefreshResult> {
  const context = createCaptureRunContext({ signal, allowAppRestart: false });
  return withCommandSignal(signal, async () => {
    const root = snapshot.root, packageName = root?.package;
    const target = root && nodeById(root, nodeId);
    const rootRef = root?.children[0]?.attributes?.["view-ref"];
    const processId = Number(root?.attributes?.["debug-process-id"]);
    const windowName = root?.attributes?.["debug-window-name"];
    const component = root?.attributes?.["debug-component"];
    if ((snapshot.inspectionSource !== "debug-view" && snapshot.inspectionSource !== "debug-hybrid") || snapshot.serial !== serial || !root || !packageName || !target?.bounds
        || !target.attributes?.["view-ref"] || !rootRef || !windowName || !component || !Number.isSafeInteger(processId) || processId < 1)
      throw new Error("这份快照不支持控件刷新，请重新采集当前页面。");
    const adbPath = automationAdb(serial);
    const sameProcess = async () => {
      return await singleAppPid(adbPath, serial, packageName) === processId;
    };
    const before = await checkedDebugTarget(adbPath, serial, packageName);
    if (before.component !== component || !await sameProcess())
      throw new Error("目标 App 或进程已变化，请重新采集整页。");
    const activity = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", packageName]);
    if (activity.code !== 0) throw new Error("无法核对当前控件树，请重新采集整页。");
    const section = targetActivitySection(activity.stdout.toString("utf8"), before);
    const forwarded = await withoutCommandSignal(() => runDeviceAdb(adbPath, serial, ["forward", "tcp:0", `jdwp:${processId}`]));
    const port = forwarded.stdout.toString("utf8").trim();
    if (forwarded.code !== 0 || !/^\d+$/.test(port)) throw new Error("无法连接当前 Debug App。");
    try {
      const readCurrent = buildReadCurrent(provider, { adbPath, serial, packageName, snapshot, root, section, before, port, rootRef, windowName, processId, branch: true, nodeId, context });
      const first = await readCurrent();
      const liveList = first.node;
      if (!liveList.children.length) throw new Error("此节点没有可刷新的子项。");
      const requestedNode = (node: UiNode) => node.visibleToUser && node.attributes?.["view-ref"] && node.bounds && node.bounds.right > node.bounds.left && node.bounds.bottom > node.bounds.top;
      const itemNodes = (item: UiNode) => {
        const nodes: UiNode[] = [];
        const pending = [item];
        for (let cursor = 0; cursor < pending.length; cursor++) { const node = pending[cursor]; if (requestedNode(node)) nodes.push(node); pending.push(...node.children); }
        return nodes;
      };
      const viewportItems = liveList.children.filter(requestedNode);
      if (!viewportItems.length) throw new Error("此列表当前没有可见条目，请滚动到目标区域后重试。");
      const { batches, oversized } = partitionViewItems(viewportItems.map(item => itemNodes(item).length), MAX_VIEW_REFRESH_NODES);
      const nodeFailures: ViewRefreshResult["failures"] = [];
      for (const index of oversized)
        nodeFailures.push({ id: viewportItems[index].id, message: `条目有 ${itemNodes(viewportItems[index]).length} 个可见控件，超过单次 ${MAX_VIEW_REFRESH_NODES} 个上限，已跳过该条目。` });
      // 每批需要补图的节点（条目子树内全部可见控件；列表容器自身并入首批，与分支刷新语义一致）。
      const batchNodes: UiNode[][] = batches.map(batch => batch.flatMap(index => itemNodes(viewportItems[index])));
      if (batchNodes.length) batchNodes[0] = [liveList, ...batchNodes[0]];
      const images = new Map<string, FallbackLayerImage>();
      const kinds = new Map<string, string>();
      const skipDraw = new Set<string>();
      const captureFailures = new Map<string, string>();
      for (const nodes of batchNodes) {
        const batch = root.attributes?.["sdk-visible-process-instance"]
          ? await captureSdkRefLayers(provider, adbPath, serial, packageName, root, nodes.map(node => node.attributes!["view-ref"]))
          : await captureViewBitmaps(Number(port), bitmapTarget(provider, adbPath, serial, packageName, root, rootRef, windowName), nodes.map(node => ({ ref: node.attributes!["view-ref"], captureOwn: true })), signal);
        for (const [ref, image] of batch.images) images.set(ref, image);
        for (const [ref, kind] of batch.kinds) kinds.set(ref, kind);
        for (const ref of batch.skipDraw) skipDraw.add(ref);
        for (const [ref, message] of batch.failures) if (!images.has(ref)) captureFailures.set(ref, message);
      }
      const allRequested = batchNodes.flat();
      const second = await readCurrent();
      const after = await checkedDebugTarget(adbPath, serial, packageName);
      if (after.component !== before.component || after.windowId !== before.windowId || !await sameProcess())
        throw new Error("目标 App、进程或窗口已变化，请重新采集整页。");
      if (!nativeViewBranchMatches(first.root, second.root, nodeId))
        throw new Error("列表在刷新期间变化，请重试。");
      for (const node of allRequested) if (node.bounds?.raw !== nodeById(second.root, node.id)?.bounds?.raw)
        throw new Error("条目在补图期间移动，请重试。");
      let latestRoot = second.root;
      if (snapshot.inspectionSource === "debug-hybrid") {
        const sdk = await readSdkCapture(provider, adbPath, serial, packageName, context);
        const merged = joinSdkTreeAndDebugImages({ ...snapshot, inspectionSource: "debug-view", root: second.root,
          nodeCount: countNodes(second.root) }, sdk, packageName, processId);
        if (merged.root?.attributes?.["sdk-process-instance"] !== root.attributes?.["sdk-process-instance"])
          throw new Error("SDK 进程实例已变化，请重新采集整页。");
        latestRoot = merged.root!;
        const confirmed = await checkedDebugTarget(adbPath, serial, packageName);
        if (confirmed.component !== before.component || confirmed.windowId !== before.windowId || !await sameProcess())
          throw new Error("SDK 补验时窗口已变化，请重新采集整页。");
      }
      const latestList = nodeById(latestRoot, nodeId)!;
      const oldByRef = new Map<string, UiNode>();
      const oldPending = [target];
      for (let cursor = 0; cursor < oldPending.length; cursor++) {
        const old = oldPending[cursor], ref = old.attributes?.["view-ref"];
        if (!ref || oldByRef.has(ref)) throw new Error("原分支控件身份重复，请重新采集整页。");
        oldByRef.set(ref, old);
        oldPending.push(...old.children);
      }
      const requestedRefs = new Set(allRequested.map(node => node.attributes!["view-ref"]));
      const allRefs = new Set<string>();
      const wholeTree = [latestRoot];
      for (let cursor = 0; cursor < wholeTree.length; cursor++) {
        const node = wholeTree[cursor], ref = node.attributes?.["view-ref"];
        if (ref && allRefs.has(ref)) throw new Error("刷新后的控件树包含重复对象身份。");
        if (ref) allRefs.add(ref);
        wholeTree.push(...node.children);
      }
      const oversizedIds = new Set(oversized.map(index => viewportItems[index].id));
      const refreshedAt = new Date().toISOString();
      let refreshed = 0, offViewport = 0;
      const pending: Array<{ node: UiNode; top: boolean }> = [{ node: latestList, top: true }];
      for (let cursor = 0; cursor < pending.length; cursor++) {
        const { node, top } = pending[cursor];
        for (const child of node.children) pending.push({ node: child, top: false });
        const ref = node.attributes?.["view-ref"];
        if (!ref) continue;
        if (requestedRefs.has(ref)) {
          const old = oldByRef.get(ref), image = images.get(ref), kind = kinds.get(ref);
          const sizeMatches = image && node.bounds && image.width === node.bounds.right - node.bounds.left && image.height === node.bounds.bottom - node.bounds.top
            && (image.x === undefined || Math.abs(image.x - node.bounds.left) <= 1) && (image.y === undefined || Math.abs(image.y - node.bounds.top) <= 1);
          const attributes = node.attributes = { ...node.attributes };
          delete attributes["image-capture-error"]; delete attributes["image-refresh-error"];
          if (image && sizeMatches) {
            node.layerImageStatus = "captured";
            node.layerImageDataUrl = image.imageDataUrl;
            applyCapturePlacement(node, kind === "own" ? image.geometry : undefined, image.width, image.height);
            node.layerImageSize = { width: image.width, height: image.height };
            node.layerImageEmpty = image.empty;
            attributes["image-source"] = kind === "surface" ? "SurfaceView / OpenGL 独立缓冲层" : kind === "texture" ? "TextureView 自身缓冲区" : "按对象身份独立采集，不含子节点";
            attributes["image-refreshed-at"] = refreshedAt;
            refreshed++;
          } else if (!image && skipDraw.has(ref)) {
            node.layerImageStatus = "unavailable";
            attributes["skip-draw"] = "true";
            attributes["image-source"] = "结构容器，系统跳过自身绘制";
            attributes["image-refreshed-at"] = refreshedAt;
            refreshed++;
          } else {
            const reason = image ? "控件画面尺寸已变化，请重试。" : captureFailures.get(ref) ?? "未取得控件独立画面。";
            nodeFailures.push({ id: node.id, message: reason });
            if (old?.layerImageStatus === "captured" && old.layerImageDataUrl && old.bounds?.raw === node.bounds?.raw && old.className === node.className) {
              node.layerImageStatus = old.layerImageStatus;
              node.layerImageDataUrl = old.layerImageDataUrl;
              delete node.layerCapturePlacement;
              node.layerImageSize = old.layerImageSize;
              node.layerImageEmpty = old.layerImageEmpty;
              attributes["image-source"] = old.attributes?.["image-source"] ?? "原快照独立画面";
              if (old.attributes?.["image-refreshed-at"]) attributes["image-refreshed-at"] = old.attributes["image-refreshed-at"];
              attributes["image-refresh-error"] = `${reason} 已保留旧画面。`;
            } else {
              node.layerImageStatus = "failed";
              attributes["image-capture-error"] = reason;
              delete attributes["image-source"];
            }
          }
          continue;
        }
        // 未分批的节点：屏外条目（及屏外条目子树）保留旧画面并标注；被跳过的超限条目单独标注。
        const old = oldByRef.get(ref);
        node.layerImageStatus = node.visibleToUser ? "unavailable" : "hidden";
        const attributes = node.attributes = { ...node.attributes };
        if (top && oversizedIds.has(node.id)) {
          attributes["list-item-skipped"] = "true";
          attributes["image-refreshed-at"] = refreshedAt;
        } else {
          attributes["out-of-viewport"] = "true";
          attributes["image-refreshed-at"] = refreshedAt;
          offViewport++;
        }
        if (old?.layerImageStatus === "captured" && old.layerImageDataUrl && old.className === node.className) {
          node.layerImageStatus = old.layerImageStatus;
          node.layerImageDataUrl = old.layerImageDataUrl;
          delete node.layerCapturePlacement;
          node.layerImageSize = old.layerImageSize;
          node.layerImageEmpty = old.layerImageEmpty;
          attributes["image-source"] = old.attributes?.["image-source"] ?? "原快照独立画面";
        }
      }
      if (!refreshed) throw new Error(`列表补图全部失败：${nodeFailures[0]?.message ?? "未取得独立画面"}；原快照已保留。`);
      signal?.throwIfAborted();
      console.log(`[list-refresh] 条目分批完成：视口 ${viewportItems.length} 项 / ${batches.length} 批（上限 ${MAX_VIEW_REFRESH_NODES}/批），屏外标注 ${offViewport} 节点，失败 ${nodeFailures.length} 项。`);
      return { nodes: [], failures: nodeFailures, branch: latestList };
    } finally {
      await withoutCommandSignal(() => runDeviceAdb(adbPath, serial, ["forward", "--remove", `tcp:${port}`])).catch(() => undefined);
    }
  });
}

export function captureViewStyle(provider: ProviderClient, serial: string, snapshot: UiSnapshot, nodeId: string): Promise<ViewStyleResult> {
  return withCommandSignal(undefined, async () => {
    const root = snapshot.root, target = root && nodeById(root, nodeId);
    const packageName = root?.package, ref = target?.attributes?.["view-ref"];
    const rootRef = root?.children[0]?.attributes?.["view-ref"];
    const instance = root?.attributes?.["sdk-process-instance"];
    const processId = Number(root?.attributes?.["debug-process-id"]);
    const component = root?.attributes?.["debug-component"];
    if (snapshot.inspectionSource !== "debug-hybrid" || root?.attributes?.["sdk-style-version"] !== "1"
        || snapshot.serial !== serial || !packageName || !ref || !rootRef
        || !instance || !component || !target?.bounds || !Number.isSafeInteger(processId) || processId < 1)
      throw new Error("当前快照不支持实时样式，请重新采集接入新版 SDK 的 Debug App。");
    const adbPath = automationAdb(serial);
    const before = await checkedDebugTarget(adbPath, serial, packageName);
    if (before.component !== component || await singleAppPid(adbPath, serial, packageName) !== processId)
      throw new Error("目标 App 或进程已变化，请重新采集整页。");
    const reply = await provider.call(adbPath, serial, packageName, "capture-style", ref, null, COMMAND_TIMEOUT_MS, true);
    if (reply.code !== 0) throw new Error("无法读取目标 App 的实时样式。");
    const style = parseViewStyleReply(reply.stdout.toString("utf8"), ref, rootRef, instance, target.bounds);
    const after = await checkedDebugTarget(adbPath, serial, packageName);
    if (after.component !== before.component || after.windowId !== before.windowId
        || await singleAppPid(adbPath, serial, packageName) !== processId)
      throw new Error("样式读取期间 App 或窗口已变化，请重新采集整页。");
    return style;
  });
}

export function captureViewGroupImage(provider: ProviderClient, serial: string, snapshot: UiSnapshot, nodeId: string, signal?: AbortSignal): Promise<QmlGroupImage | null> {
  const context = createCaptureRunContext({ signal, allowAppRestart: false });
  return withCommandSignal(signal, async () => {
    const root = snapshot.root, packageName = root?.package;
    const targetId = nodeId === "0" ? "0/0" : nodeId;
    const node = root && nodeById(root, targetId), bounds = node?.bounds;
    const sameBounds = (a: UiNode["bounds"] | undefined, b: UiNode["bounds"] | undefined) => Boolean(a && b && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom);
    const processId = Number(root?.attributes?.["debug-process-id"]);
    const instance = root?.attributes?.["sdk-process-instance"];
    const rootRef = root?.children[0]?.attributes?.["view-ref"];
    const ref = node?.attributes?.["view-ref"];
    const component = root?.attributes?.["debug-component"];
    const pixels = bounds ? (bounds.right - bounds.left) * (bounds.bottom - bounds.top) : 0;
    if (snapshot.inspectionSource !== "debug-hybrid" || snapshot.serial !== serial || !root || !packageName || !node?.children.length
        || (nodeId === "0" && !sameBounds(root.bounds, bounds))
        || !node.visibleToUser || !bounds || pixels < 1 || pixels > 4_000_000 || !ref || !rootRef || !instance || !component
        || !Number.isSafeInteger(processId) || processId < 1) return null;
    const adbPath = automationAdb(serial);
    const before = await checkedDebugTarget(adbPath, serial, packageName);
    if (before.component !== component || processId !== await singleAppPid(adbPath, serial, packageName)) return null;
    const firstTree = await readSdkCapture(provider, adbPath, serial, packageName, context);
    if (!sdkGroupBranchMatches(root, targetId, firstTree, packageName, processId, instance)) return null;
    try {
      const reply = await provider.call(adbPath, serial, packageName, "capture-group", ref, null, COMMAND_TIMEOUT_MS, true);
      const output = reply.stdout.toString("utf8");
      const field = (name: string) => new RegExp(`\\b${name}=([^,}\\]]+)`).exec(output)?.[1];
      if (reply.code !== 0 || field("result") !== "ok" || field("ref") !== ref || field("rootRef") !== rootRef
          || field("processInstance") !== instance || !/^[a-f0-9]{64}$/.test(field("sha256") ?? "")) return null;
      const file = await runDeviceAdb(adbPath, serial, ["exec-out", "run-as", packageName, "head", "-c", "20000001", "no_backup/inspector-group-image.png"]);
      const size = pngSize(file.stdout);
      if (file.code !== 0 || !size || file.stdout.length > 20_000_000 || size.width !== bounds.right - bounds.left
          || size.height !== bounds.bottom - bounds.top || createHash("sha256").update(file.stdout).digest("hex") !== field("sha256")) return null;
      const secondTree = await readSdkCapture(provider, adbPath, serial, packageName, context);
      const after = await checkedDebugTarget(adbPath, serial, packageName);
      signal?.throwIfAborted();
      if (!sdkGroupBranchMatches(root, targetId, secondTree, packageName, processId, instance)
          || before.windowId !== after.windowId || before.component !== after.component
          || processId !== await singleAppPid(adbPath, serial, packageName)) return null;
      return { dataUrl: `data:image/png;base64,${file.stdout.toString("base64")}`, size, capturedAt: new Date().toISOString() };
    } finally {
      await withoutCommandSignal(() => runDeviceAdb(adbPath, serial, ["shell", "run-as", packageName, "rm", "-f", "no_backup/inspector-group-image.png"])).catch(() => undefined);
    }
  });
}
