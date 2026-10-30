import type { ProviderClient } from "../sdk/provider-session";
import type { InspectionOptions } from "../capture/types";
import type { captureListViewItems, captureViewGroupImage, captureViewNodes, captureViewStyle } from "../capture/refresh";
import type { captureViewLayerImages } from "../capture/layer-image-demand";
import type { captureQmlGroupImage } from "../capture/qt";
import type { DebugSession } from "../automation/debug-session";
import type { WindowOperationScope } from "./window-operation-scope";
import { changedLayerImages, flattenNodes, layerImageBaseline, layerImageUpdates, mergeLayerImages } from "../../shared/tree-utils";
import { commitViewRefresh } from "../capture/view-refresh-commit";
import type { LayerCaptureMode, LayerImageCaptureResult, LayerImageUpdate, QmlGroupImage, UiSnapshot, ViewRefreshResult } from "../../shared/types";
import type { InspectionMode } from "../../shared/inspection-mode";

type BoundProviderFunction<T> = T extends (provider: ProviderClient, ...args: infer Args) => infer Result
  ? (...args: Args) => Result : never;

export interface CaptureClient {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  onDestroyed(callback: () => void): () => void;
}
export interface InspectionRequest {
  serial: string;
  requestId: string;
  priorityViewRef?: string | null;
  captureSingleAttempt: boolean;
  readOnlyScope: { expectedPackage: string } | undefined;
  layerCapture?: LayerCaptureMode;
}
export interface InspectionServiceDependencies {
  capturePolicy?: () => { mode: InspectionMode; revision: number };
  onActivityChanged?: () => void;
  operations: WindowOperationScope;
  debugStarting(): boolean;
  debugSession(): Pick<DebugSession, "state" | "settled"> | null;
  stopSharing(reason: string): void;
  inspect(serial: string, options: InspectionOptions & Required<Pick<InspectionOptions, "signal" | "onProgress" | "onPreview">>, requestId: string): Promise<UiSnapshot>;
  measureLayerImages(root: UiSnapshot["root"], signal: AbortSignal): Promise<unknown>;
  yieldPreview(owner: number): Promise<unknown> | undefined;
  withPreviewHeld<T>(owner: number, action: () => Promise<T>): Promise<T>;
  captureQmlGroupImage: typeof captureQmlGroupImage;
  captureViewGroupImage: BoundProviderFunction<typeof captureViewGroupImage>;
  captureListViewItems: BoundProviderFunction<typeof captureListViewItems>;
  captureViewNodes: BoundProviderFunction<typeof captureViewNodes>;
  captureViewLayerImages?: BoundProviderFunction<typeof captureViewLayerImages>;
  captureViewStyle: BoundProviderFunction<typeof captureViewStyle>;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

export function createInspectionService(dependencies: InspectionServiceDependencies) {
  const inspections = new Map<number, { requestId: string; controller: AbortController; done: Promise<UiSnapshot> }>();
  type Policy = { mode: InspectionMode; revision: number };
  const policy = (): Policy => dependencies.capturePolicy?.() ?? { mode: "standard", revision: 0 };
  const liveSessions = new Map<number, { requestId: string; snapshot: UiSnapshot; policy: Policy }>();
  let activeRequests = 0;
  function beginActivity() {
    activeRequests++;
    dependencies.onActivityChanged?.();
    return () => { activeRequests--; dependencies.onActivityChanged?.(); };
  }
  function samePolicy(expected: Policy) {
    const current = policy();
    return current.mode === expected.mode && current.revision === expected.revision;
  }
  const groupCaptures = new Map<number, { controller: AbortController; done: Promise<QmlGroupImage | null> }>();
  const viewRefreshes = new Map<number, { controller: AbortController; done: Promise<ViewRefreshResult> }>();
  const layerCaptures = new Map<number, { requestId: string; controller: AbortController; done: Promise<LayerImageCaptureResult> }>();
  async function inspect(sender: CaptureClient, { serial, requestId, priorityViewRef, captureSingleAttempt, readOnlyScope, layerCapture }: InspectionRequest) {
    dependencies.operations.assertAvailable(sender.id);
    const capturePolicy = policy();
    if (readOnlyScope && (inspections.has(sender.id) || groupCaptures.has(sender.id)
        || viewRefreshes.has(sender.id) || layerCaptures.has(sender.id) || dependencies.debugStarting() || dependencies.debugSession()?.state.active)) {
      throw new Error("已有采集或自动调试正在运行，请结束后再做只读诊断。");
    }
    dependencies.stopSharing("开始手动采集，停止自动调试");
    const ownerId = sender.id;
    const previous = inspections.get(ownerId);
    const previousGroup = groupCaptures.get(ownerId);
    const previousView = viewRefreshes.get(ownerId);
    const previousLayers = layerCaptures.get(ownerId);
    previousLayers?.controller.abort();
    previousGroup?.controller.abort();
    previousView?.controller.abort();
    liveSessions.delete(ownerId);
    previous?.controller.abort();
    const controller = new AbortController();
    const deadline = readOnlyScope ? dependencies.setTimeout(() => controller.abort(new Error("只读诊断超过30秒，已停止；不会自动重试。")), 30_000) : null;
    let previewImages: Map<string, LayerImageUpdate> | null = null;
    let acceptingPreviews = true;
    const canPublish = () => acceptingPreviews && inspections.get(ownerId)?.controller === controller
      && !sender.isDestroyed() && !controller.signal.aborted && samePolicy(capturePolicy);
    const onDestroyed = () => controller.abort();
    const unsubscribe = sender.onDestroyed(onDestroyed);
    const finishActivity = beginActivity();
    const done = (async () => {
      // Release the previous debugger/port before starting another capture.
      await previous?.done.catch(() => undefined);
      await previousGroup?.done.catch(() => undefined);
      await previousView?.done.catch(() => undefined);
      await previousLayers?.done.catch(() => undefined);
      await dependencies.yieldPreview(ownerId);
      await dependencies.debugSession()?.settled();
      controller.signal.throwIfAborted();
      const captureOptions = {
        inspectionMode: capturePolicy.mode,
        layerCapture: capturePolicy.mode === "standard" ? layerCapture : "full",
        signal: controller.signal,
        singleAttempt: captureSingleAttempt,
        ...(readOnlyScope ? { expectedPackage: readOnlyScope.expectedPackage, allowAppRestart: false } : {}),
        priorityViewRef: typeof priorityViewRef === "string" ? priorityViewRef : undefined,
        onProgress: (stage: string, elapsedMs: number) => {
          if (canPublish()) sender.send("inspection-progress", { requestId, stage, elapsedMs });
        },
        onPreview: (phase: "tree" | "layers" | "screen", snapshot: UiSnapshot) => {
          if (!canPublish() || !snapshot.root) return;
          if (phase === "screen") {
            if (previewImages) sender.send("inspection-preview", { requestId, phase, screen: {
              screenshotDataUrl: snapshot.screenshotDataUrl, captureGeometry: snapshot.captureGeometry,
            } });
            return;
          }
          const updates = phase === "layers" && previewImages ? changedLayerImages(snapshot.root, previewImages) : null;
          if (updates) {
            if (updates.length) sender.send("inspection-preview", { requestId, phase: "layers", updates });
            return;
          }
          // The tree changed shape since the baseline was taken (fresh read or SDK adoption), so
          // there is nothing to diff. Re-anchor on the new tree and still forward every current
          // image: otherwise a partial batch would only repaint the tree and the images that
          // arrived with it would never flow into the layer pipeline.
          previewImages = layerImageBaseline(snapshot.root);
          sender.send("inspection-preview", { requestId, phase: "tree", snapshot });
          const images = layerImageUpdates(snapshot.root);
          if (images.length) sender.send("inspection-preview", { requestId, phase: "layers", updates: images });
        },
      };
      let snapshot: UiSnapshot;
      try { snapshot = await dependencies.inspect(serial, captureOptions, requestId); }
      finally { acceptingPreviews = false; }
      await dependencies.measureLayerImages(snapshot.root, controller.signal);
      controller.signal.throwIfAborted();
      if (!samePolicy(capturePolicy)) throw new Error("采集模式已变化，请重新采集页面。");
      if ((snapshot.inspectionSource === "debug-qml" && snapshot.root?.attributes?.["qml-process-id"] && snapshot.root.attributes["qml-window-id"])
        || ((snapshot.inspectionSource === "debug-view" || snapshot.inspectionSource === "debug-hybrid") && snapshot.root?.attributes?.["debug-process-id"] && snapshot.root.attributes["debug-window-name"])) {
        liveSessions.set(ownerId, { requestId, snapshot, policy: capturePolicy });
      }
      return snapshot;
    })();
    inspections.set(ownerId, { requestId, controller, done });
    dependencies.operations.track(ownerId, done, () => controller.abort());
    try { return await done; }
    catch (error) { controller.signal.throwIfAborted(); throw error; }
    finally {
      if (deadline) dependencies.clearTimeout(deadline);
      unsubscribe();
      if (inspections.get(ownerId)?.controller === controller) inspections.delete(ownerId);
      finishActivity();
    }
  }

  async function captureGroup(ownerId: number, requestId: string, nodeId: string) {
    dependencies.operations.assertAvailable(ownerId);
    const session = liveSessions.get(ownerId);
    const source = session?.snapshot.inspectionSource;
    if (!session || !samePolicy(session.policy) || (source !== "debug-qml" && (source !== "debug-hybrid" || session.policy.mode !== "sdk-enhanced")) || session.requestId !== requestId
        || inspections.has(ownerId) || viewRefreshes.has(ownerId) || layerCaptures.has(ownerId) || dependencies.debugSession()?.state.busy) return null;
    const previous = groupCaptures.get(ownerId);
    previous?.controller.abort();
    const controller = new AbortController();
    const finishActivity = beginActivity();
    const done = (async () => {
      await previous?.done.catch(() => undefined);
      controller.signal.throwIfAborted();
      const result = await dependencies.withPreviewHeld(ownerId, () => source === "debug-qml"
        ? dependencies.captureQmlGroupImage(session.snapshot.serial, session.snapshot, nodeId, controller.signal)
        : dependencies.captureViewGroupImage(session.snapshot.serial, session.snapshot, nodeId, controller.signal, session.policy.mode));
      return !controller.signal.aborted && liveSessions.get(ownerId) === session && samePolicy(session.policy) ? result : null;
    })();
    groupCaptures.set(ownerId, { controller, done });
    dependencies.operations.track(ownerId, done, () => controller.abort());
    try { return await done; }
    catch { return null; }
    finally { if (groupCaptures.get(ownerId)?.controller === controller) groupCaptures.delete(ownerId); finishActivity(); }
  }

  async function refreshView(ownerId: number, requestId: string, nodeId: string, scope: "node" | "branch" | "list") {
    dependencies.operations.assertAvailable(ownerId);
    const session = liveSessions.get(ownerId);
    if (!session || !samePolicy(session.policy) || (session.snapshot.inspectionSource !== "debug-view" && session.snapshot.inspectionSource !== "debug-hybrid")
        || session.requestId !== requestId || inspections.has(ownerId) || dependencies.debugSession()?.state.active)
      throw new Error("当前快照已失效，请重新采集页面。");
    const previous = viewRefreshes.get(ownerId);
    previous?.controller.abort();
    const previousLayers = layerCaptures.get(ownerId);
    previousLayers?.controller.abort();
    groupCaptures.get(ownerId)?.controller.abort();
    const controller = new AbortController();
    const finishActivity = beginActivity();
    const done = (async () => {
      await previous?.done.catch(() => undefined);
      await previousLayers?.done.catch(() => undefined);
      await dependencies.yieldPreview(ownerId);
      controller.signal.throwIfAborted();
      const result = scope === "list"
        ? await dependencies.captureListViewItems(session.snapshot.serial, session.snapshot, nodeId, controller.signal, session.policy.mode)
        : await dependencies.captureViewNodes(session.snapshot.serial, session.snapshot, nodeId, scope === "branch", controller.signal, session.policy.mode);
      controller.signal.throwIfAborted();
      if (!samePolicy(session.policy)) throw new Error("采集模式已变化，请重新采集页面。");
      commitViewRefresh(session, liveSessions.get(ownerId), nodeId, result, controller.signal);
      return result;
    })();
    viewRefreshes.set(ownerId, { controller, done });
    dependencies.operations.track(ownerId, done, () => controller.abort());
    try { return await done; }
    finally { if (viewRefreshes.get(ownerId)?.controller === controller) viewRefreshes.delete(ownerId); finishActivity(); }
  }

  async function readStyle(ownerId: number, requestId: string, nodeId: string) {
    dependencies.operations.assertAvailable(ownerId);
    const session = liveSessions.get(ownerId);
    if (!session || !samePolicy(session.policy) || session.requestId !== requestId || session.snapshot.inspectionSource !== "debug-hybrid"
        || inspections.has(ownerId) || viewRefreshes.has(ownerId) || layerCaptures.has(ownerId) || dependencies.debugSession()?.state.active)
      throw new Error("当前快照已失效或正在刷新，请稍后重试。");
    if (session.policy.mode !== "sdk-enhanced") throw new Error("实时样式需要启用 SDK 增强并重新采集。");
    const source = session.snapshot;
    const finishActivity = beginActivity();
    try {
    // Style reads do not expose cancellation; shutdown still awaits their completion.
    const style = await dependencies.operations.track(ownerId,
      dependencies.withPreviewHeld(ownerId, () => dependencies.captureViewStyle(source.serial, source, nodeId, session.policy.mode)), () => {});
    if (liveSessions.get(ownerId) !== session || session.snapshot !== source || !samePolicy(session.policy)) throw new Error("读取期间快照已更新，请重新读取样式。");
    return style;
    } finally { finishActivity(); }
  }

  async function captureLayers(ownerId: number, requestId: string, nodeIds: string[]): Promise<LayerImageCaptureResult> {
    dependencies.operations.assertAvailable(ownerId);
    const session = liveSessions.get(ownerId);
    if (!session || !samePolicy(session.policy) || session.requestId !== requestId || session.policy.mode !== "standard"
        || session.snapshot.inspectionSource !== "debug-view" || !session.snapshot.root || !dependencies.captureViewLayerImages
        || inspections.has(ownerId) || viewRefreshes.has(ownerId) || dependencies.debugStarting() || dependencies.debugSession()?.state.active)
      throw new Error("当前快照已失效或正在刷新，请重新采集页面。");
    if (!nodeIds.length || nodeIds.length > 32 || new Set(nodeIds).size !== nodeIds.length)
      throw new Error("请一次读取 1 至 32 个有效图层。");
    const source = session.snapshot;
    const nodes = flattenNodes(source.root!);
    if (nodeIds.some(id => !nodes.get(id)?.attributes?.["view-ref"])) throw new Error("图层已变化，请重新采集页面。");
    const previous = layerCaptures.get(ownerId);
    previous?.controller.abort();
    const group = groupCaptures.get(ownerId);
    group?.controller.abort();
    const controller = new AbortController();
    const deadline = dependencies.setTimeout(() => controller.abort(new Error("分支图层读取超时，请缩小范围重试。")), 30_000);
    const finishActivity = beginActivity();
    const done = (async () => {
      await previous?.done.catch(() => undefined);
      await group?.done.catch(() => undefined);
      controller.signal.throwIfAborted();
      const result = await dependencies.withPreviewHeld(ownerId, () => dependencies.captureViewLayerImages!(source.serial, source, nodeIds, controller.signal, session.policy.mode));
      controller.signal.throwIfAborted();
      if (liveSessions.get(ownerId) !== session || session.snapshot !== source || !samePolicy(session.policy))
        throw new Error("读取期间快照已更新，请重新选择分支。");
      const requested = new Set(nodeIds);
      if (result.updates.some(update => !requested.has(update.id)) || result.failures.some(failure => !requested.has(failure.id))
          || new Set(result.updates.map(update => update.id)).size !== result.updates.length)
        throw new Error("返回的图层范围无效。");
      session.snapshot = { ...source, root: mergeLayerImages(source.root!, result.updates), layerGroupImages: undefined };
      return result;
    })();
    layerCaptures.set(ownerId, { requestId, controller, done });
    dependencies.operations.track(ownerId, done, () => controller.abort());
    try { return await done; }
    finally {
      dependencies.clearTimeout(deadline);
      if (layerCaptures.get(ownerId)?.controller === controller) layerCaptures.delete(ownerId);
      finishActivity();
    }
  }

  function cancelLayers(ownerId: number, requestId: unknown) {
    const active = layerCaptures.get(ownerId);
    if (typeof requestId === "string" && active?.requestId === requestId) active.controller.abort();
  }
  function cancel(ownerId: number, requestId: unknown) {
    cancelLayers(ownerId, requestId);
    const active = inspections.get(ownerId);
    if (typeof requestId === "string" && active?.requestId === requestId) active.controller.abort();
    const live = liveSessions.get(ownerId);
    if (typeof requestId === "string" && live?.requestId === requestId) {
      viewRefreshes.get(ownerId)?.controller.abort();
      groupCaptures.get(ownerId)?.controller.abort();
      liveSessions.delete(ownerId);
    }
  }
  return { inspect, captureGroup, refreshView, readStyle, captureLayers, cancelLayers, cancel,
    invalidateAll: () => { liveSessions.clear(); },
    hasActivity: () => activeRequests > 0,
    invalidate: (owner: number) => { liveSessions.delete(owner); },
    hasInspections: (owner?: number) => owner === undefined ? inspections.size > 0 : inspections.has(owner),
    hasGroupCaptures: () => groupCaptures.size > 0,
    hasViewRefreshes: () => viewRefreshes.size > 0 || layerCaptures.size > 0,
    hasSession: (owner: number, snapshot?: UiSnapshot) => {
      const session = liveSessions.get(owner);
      return Boolean(session && (snapshot === undefined || session.snapshot === snapshot));
    },
  };
}
export type InspectionService = ReturnType<typeof createInspectionService>;
