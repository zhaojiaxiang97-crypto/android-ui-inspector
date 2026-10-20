import { requireDesktopOwner, type DesktopInvokeEvent, type DesktopSender } from "./desktop-ipc";
import { inspectionLayerCapture, inspectionReadOnlyScope, inspectionSingleAttempt } from "../../shared/inspection-policy";
import type { CaptureClient, InspectionService } from "./inspection-service";

export function createCaptureHandlers(service: InspectionService, currentSender: () => DesktopSender | undefined) {
  function requireSender(event: DesktopInvokeEvent, message: string) {
    requireDesktopOwner(event, currentSender(), message);
  }
  function client(sender: DesktopSender): CaptureClient {
    return { id: sender.id, isDestroyed: () => sender.isDestroyed(), send: (channel, payload) => sender.send(channel, payload),
      onDestroyed: callback => { sender.once("destroyed", callback); return () => { sender.removeListener("destroyed", callback); }; } };
  }
  const validNode = (requestId: unknown, nodeId: unknown): boolean => typeof requestId === "string" && requestId.length <= 128
    && typeof nodeId === "string" && /^0(?:\/\d+)*$/.test(nodeId) && nodeId.length <= 600;
  return {
    "inspect-device": async (event: DesktopInvokeEvent, serial: unknown, requestId: unknown, priorityViewRef?: unknown, singleAttempt?: unknown, scope?: unknown, layers?: unknown) => {
      requireSender(event, "无效的采集来源。");
      if (typeof serial !== "string" || !serial.trim()) throw new Error("设备序列号不能为空。");
      if (typeof requestId !== "string" || !requestId || requestId.length > 128) throw new Error("采集请求标识无效。");
      if (priorityViewRef !== undefined && priorityViewRef !== null && (typeof priorityViewRef !== "string" || priorityViewRef.length > 256 || !/^[\w.$]+@[0-9a-f]{1,8}$/i.test(priorityViewRef)))
        throw new Error("优先采集控件标识无效。");
      const captureSingleAttempt = inspectionSingleAttempt(singleAttempt);
      const readOnlyScope = inspectionReadOnlyScope(scope, captureSingleAttempt);
      const layerCapture = inspectionLayerCapture(layers);
      return service.inspect(client(event.sender), { serial, requestId, priorityViewRef, captureSingleAttempt, readOnlyScope, layerCapture });
    },
    "capture-group": async (event: DesktopInvokeEvent, requestId: unknown, nodeId: unknown) => {
      requireSender(event, "无效的抓图来源。");
      if (!validNode(requestId, nodeId)) return null;
      return service.captureGroup(event.sender.id, requestId as string, nodeId as string);
    },
    "capture-layer-images": async (event: DesktopInvokeEvent, requestId: unknown, nodeIds: unknown) => {
      requireSender(event, "无效的抓图来源。");
      if (!Array.isArray(nodeIds) || nodeIds.length < 1 || nodeIds.length > 32 || new Set(nodeIds).size !== nodeIds.length
          || nodeIds.some(id => !validNode(requestId, id))) throw new Error("请一次读取 1 至 32 个有效图层。");
      return service.captureLayers(event.sender.id, requestId as string, nodeIds);
    },
    "cancel-layer-images": (event: DesktopInvokeEvent, requestId: unknown) => {
      requireSender(event, "无效的取消来源。");
      service.cancelLayers(event.sender.id, requestId);
    },
    "refresh-view-node": async (event: DesktopInvokeEvent, requestId: unknown, nodeId: unknown, scope: unknown = "node") => {
      requireSender(event, "无效的抓图来源。");
      if (!validNode(requestId, nodeId)) throw new Error("控件标识无效。");
      if (scope !== "node" && scope !== "branch" && scope !== "list") throw new Error("刷新范围无效。");
      return service.refreshView(event.sender.id, requestId as string, nodeId as string, scope);
    },
    "read-view-style": async (event: DesktopInvokeEvent, requestId: unknown, nodeId: unknown) => {
      requireSender(event, "无效的样式请求来源。");
      if (!validNode(requestId, nodeId)) throw new Error("控件标识无效。");
      return service.readStyle(event.sender.id, requestId as string, nodeId as string);
    },
    "read-view-font": async (event: DesktopInvokeEvent, requestId: unknown, nodeId: unknown) => {
      requireSender(event, "无效的字体请求来源。");
      if (!requestId || !validNode(requestId, nodeId)) throw new Error("控件标识无效。");
      return service.readFont(event.sender.id, requestId as string, nodeId as string);
    },
    "cancel-view-font": async (event: DesktopInvokeEvent, requestId: unknown) => {
      requireSender(event, "无效的字体取消来源。");
      if (typeof requestId !== "string" || !requestId || requestId.length > 128) throw new Error("字体请求标识无效。");
      await service.cancelFont(event.sender.id, requestId);
    },
    "cancel-inspection": (event: DesktopInvokeEvent, requestId: unknown) => {
      requireSender(event, "无效的取消来源。");
      service.cancel(event.sender.id, requestId);
    },
  };
}
