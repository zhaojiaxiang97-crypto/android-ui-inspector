import type { ProviderClient } from "../sdk/provider-session";
import type { InspectionOptions } from "../capture/types";
import type { captureListViewItems, captureViewGroupImage, captureViewNodes, captureViewStyle } from "../capture/refresh";
import type { captureQmlGroupImage } from "../capture/qt";
import type { DebugSession } from "../automation/debug-session";
import type { WindowOperationScope } from "./window-operation-scope";
import { changedLayerImages, layerImageBaseline, layerImageUpdates } from "../../shared/tree-utils";
import { commitViewRefresh } from "../capture/view-refresh-commit";
import type { LayerImageUpdate, QmlGroupImage, UiSnapshot, ViewRefreshResult } from "../../shared/types";

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
}
export interface InspectionServiceDependencies {
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
  captureViewStyle: BoundProviderFunction<typeof captureViewStyle>;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

export function createInspectionService(dependencies: InspectionServiceDependencies) {
  const inspections = new Map<number, { requestId: string; controller: AbortController; done: Promise<UiSnapshot> }>();
  const liveSessions = new Map<number, { requestId: string; snapshot: UiSnapshot }>();
  const groupCaptures = new Map<number, { controller: AbortController; done: Promise<QmlGroupImage | null> }>();
  const viewRefreshes = new Map<number, { controller: AbortController; done: Promise<ViewRefreshResult> }>();
  async function inspect(sender: CaptureClient, { serial, requestId, priorityViewRef, captureSingleAttempt, readOnlyScope }: InspectionRequest) {
    dependencies.operations.assertAvailable(sender.id);
    if (readOnlyScope && (inspections.has(sender.id) || groupCaptures.has(sender.id)
        || viewRefreshes.has(sender.id) || dependencies.debugStarting() || dependencies.debugSession()?.state.active)) {
      throw new Error("已有采集或自动调试正在运行，请结束后再做只读诊断。");
    }
    dependencies.stopSharing("开始手动采集，停止自动调试");
    const ownerId = sender.id;
    const previous = inspections.get(ownerId);
    const previousGroup = groupCaptures.get(ownerId);
    const previousView = viewRefreshes.get(ownerId);
    previousGroup?.controller.abort();
    previousView?.controller.abort();
    liveSessions.delete(ownerId);
    previous?.controller.abort();
    const controller = new AbortController();
    const deadline = readOnlyScope ? dependencies.setTimeout(() => controller.abort(new Error("只读诊断超过30秒，已停止；不会自动重试。")), 30_000) : null;
    let previewImages: Map<string, LayerImageUpdate> | null = null;
    const onDestroyed = () => controller.abort();
    const unsubscribe = sender.onDestroyed(onDestroyed);
    const done = (async () => {
      // Release the previous debugger/port before starting another capture.
      await previous?.done.catch(() => undefined);
      await previousGroup?.done.catch(() => undefined);
      await previousView?.done.catch(() => undefined);
      await dependencies.yieldPreview(ownerId);
      await dependencies.debugSession()?.settled();
      controller.signal.throwIfAborted();
      const captureOptions = {
        signal: controller.signal,
        singleAttempt: captureSingleAttempt,
        ...(readOnlyScope ? { expectedPackage: readOnlyScope.expectedPackage, allowAppRestart: false } : {}),
        priorityViewRef: typeof priorityViewRef === "string" ? priorityViewRef : undefined,
        onProgress: (stage: string, elapsedMs: number) => {
          if (!sender.isDestroyed() && !controller.signal.aborted) sender.send("inspection-progress", { requestId, stage, elapsedMs });
        },
        onPreview: (phase: "tree" | "layers", snapshot: UiSnapshot) => {
          if (sender.isDestroyed() || controller.signal.aborted || !snapshot.root) return;
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
      const snapshot = await dependencies.inspect(serial, captureOptions, requestId);
      await dependencies.measureLayerImages(snapshot.root, controller.signal);
      controller.signal.throwIfAborted();
      if ((snapshot.inspectionSource === "debug-qml" && snapshot.root?.attributes?.["qml-process-id"] && snapshot.root.attributes["qml-window-id"])
        || ((snapshot.inspectionSource === "debug-view" || snapshot.inspectionSource === "debug-hybrid") && snapshot.root?.attributes?.["debug-process-id"] && snapshot.root.attributes["debug-window-name"])) {
        liveSessions.set(ownerId, { requestId, snapshot });
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
    }
  }

  async function captureGroup(ownerId: number, requestId: string, nodeId: string) {
    dependencies.operations.assertAvailable(ownerId);
    const session = liveSessions.get(ownerId);
    const source = session?.snapshot.inspectionSource;
    if (!session || (source !== "debug-qml" && source !== "debug-hybrid") || session.requestId !== requestId
        || inspections.has(ownerId) || viewRefreshes.has(ownerId) || dependencies.debugSession()?.state.busy) return null;
    const previous = groupCaptures.get(ownerId);
    previous?.controller.abort();
    const controller = new AbortController();
    const done = (async () => {
      await previous?.done.catch(() => undefined);
      controller.signal.throwIfAborted();
      return dependencies.withPreviewHeld(ownerId, () => source === "debug-qml"
        ? dependencies.captureQmlGroupImage(session.snapshot.serial, session.snapshot, nodeId, controller.signal)
        : dependencies.captureViewGroupImage(session.snapshot.serial, session.snapshot, nodeId, controller.signal));
    })();
    groupCaptures.set(ownerId, { controller, done });
    dependencies.operations.track(ownerId, done, () => controller.abort());
    try { return await done; }
    catch { return null; }
    finally { if (groupCaptures.get(ownerId)?.controller === controller) groupCaptures.delete(ownerId); }
  }

  async function refreshView(ownerId: number, requestId: string, nodeId: string, scope: "node" | "branch" | "list") {
    dependencies.operations.assertAvailable(ownerId);
    const session = liveSessions.get(ownerId);
    if (!session || (session.snapshot.inspectionSource !== "debug-view" && session.snapshot.inspectionSource !== "debug-hybrid")
        || session.requestId !== requestId || inspections.has(ownerId) || dependencies.debugSession()?.state.active)
      throw new Error("当前快照已失效，请重新采集页面。");
    const previous = viewRefreshes.get(ownerId);
    previous?.controller.abort();
    groupCaptures.get(ownerId)?.controller.abort();
    const controller = new AbortController();
    const done = (async () => {
      await previous?.done.catch(() => undefined);
      await dependencies.yieldPreview(ownerId);
      controller.signal.throwIfAborted();
      const result = scope === "list"
        ? await dependencies.captureListViewItems(session.snapshot.serial, session.snapshot, nodeId, controller.signal)
        : await dependencies.captureViewNodes(session.snapshot.serial, session.snapshot, nodeId, scope === "branch", controller.signal);
      controller.signal.throwIfAborted();
      commitViewRefresh(session, liveSessions.get(ownerId), nodeId, result, controller.signal);
      return result;
    })();
    viewRefreshes.set(ownerId, { controller, done });
    dependencies.operations.track(ownerId, done, () => controller.abort());
    try { return await done; }
    finally { if (viewRefreshes.get(ownerId)?.controller === controller) viewRefreshes.delete(ownerId); }
  }

  async function readStyle(ownerId: number, requestId: string, nodeId: string) {
    dependencies.operations.assertAvailable(ownerId);
    const session = liveSessions.get(ownerId);
    if (!session || session.requestId !== requestId || session.snapshot.inspectionSource !== "debug-hybrid"
        || inspections.has(ownerId) || viewRefreshes.has(ownerId) || dependencies.debugSession()?.state.active)
      throw new Error("当前快照已失效或正在刷新，请稍后重试。");
    const source = session.snapshot;
    // Style reads do not expose cancellation; shutdown still awaits their completion.
    const style = await dependencies.operations.track(ownerId,
      dependencies.withPreviewHeld(ownerId, () => dependencies.captureViewStyle(source.serial, source, nodeId)), () => {});
    if (liveSessions.get(ownerId) !== session || session.snapshot !== source) throw new Error("读取期间快照已更新，请重新读取样式。");
    return style;
  }

  function cancel(ownerId: number, requestId: unknown) {
    const active = inspections.get(ownerId);
    if (typeof requestId === "string" && active?.requestId === requestId) active.controller.abort();
    const live = liveSessions.get(ownerId);
    if (typeof requestId === "string" && live?.requestId === requestId) {
      viewRefreshes.get(ownerId)?.controller.abort();
      groupCaptures.get(ownerId)?.controller.abort();
      liveSessions.delete(ownerId);
    }
  }
  return { inspect, captureGroup, refreshView, readStyle, cancel,
    invalidate: (owner: number) => { liveSessions.delete(owner); },
    hasInspections: (owner?: number) => owner === undefined ? inspections.size > 0 : inspections.has(owner),
    hasGroupCaptures: () => groupCaptures.size > 0,
    hasViewRefreshes: () => viewRefreshes.size > 0,
    hasSession: (owner: number, snapshot?: UiSnapshot) => {
      const session = liveSessions.get(owner);
      return Boolean(session && (snapshot === undefined || session.snapshot === snapshot));
    },
  };
}
export type InspectionService = ReturnType<typeof createInspectionService>;
