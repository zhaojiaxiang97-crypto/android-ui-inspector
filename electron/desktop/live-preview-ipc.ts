import { isLivePreviewSerial, isLivePreviewSessionId } from "../../shared/live-preview";
import type { AdbProbeResult } from "../../shared/types";
import type { LivePreviewController } from "../device/live-preview";
import type { DesktopInvokeEvent, DesktopSender } from "./desktop-ipc";
import type { WindowOperationScope } from "./window-operation-scope";

interface LivePreviewDependencies {
  requireSender(event: DesktopInvokeEvent): void;
  probe(): Promise<AdbProbeResult>;
  previewFor(sender: DesktopSender): Pick<LivePreviewController, "start" | "stop" | "pause" | "resume" | "getEvent">;
  operations: WindowOperationScope;
}

/** Validation and request identity for the preview controls; capture scheduling stays in the controller. */
export function createLivePreviewHandlers(dependencies: LivePreviewDependencies) {
  const starts = new Map<number, number>();
  let revision = 0;
  function control(operation: "pause" | "resume") {
    return (event: DesktopInvokeEvent, sessionId: unknown) => {
      dependencies.requireSender(event);
      if (!isLivePreviewSessionId(sessionId)) throw new Error("预览会话无效。");
      return dependencies.previewFor(event.sender)[operation](sessionId);
    };
  }
  const handlers = {
    "live-preview-start": async (event: DesktopInvokeEvent, serial: unknown) => {
      dependencies.requireSender(event);
      dependencies.operations.assertAvailable(event.sender.id);
      if (!isLivePreviewSerial(serial)) throw new Error("预览设备无效。");
      const current = ++revision;
      starts.set(event.sender.id, current);
      const done = (async () => {
        const probe = await dependencies.probe();
        if (starts.get(event.sender.id) !== current || event.sender.isDestroyed()) throw new Error("预览开启已取消。");
        if (probe.error || !probe.devices.some(device => device.serial === serial && device.state === "device"))
          throw new Error("设备未连接或未授权，无法开启预览。");
        return await dependencies.previewFor(event.sender).start(serial);
      })();
      dependencies.operations.track(event.sender.id, done, () => { if (starts.get(event.sender.id) === current) starts.delete(event.sender.id); });
      try { return await done; }
      finally { if (starts.get(event.sender.id) === current) starts.delete(event.sender.id); }
    },
    "live-preview-stop": (event: DesktopInvokeEvent, sessionId: unknown) => {
      dependencies.requireSender(event);
      if (sessionId !== undefined && !isLivePreviewSessionId(sessionId)) throw new Error("预览会话无效。");
      if (sessionId === undefined) starts.delete(event.sender.id);
      return dependencies.previewFor(event.sender).stop("closed", sessionId);
    },
    "live-preview-state": (event: DesktopInvokeEvent) => { dependencies.requireSender(event); return dependencies.previewFor(event.sender).getEvent(); },
    "live-preview-pause": control("pause"),
    "live-preview-resume": control("resume"),
  };
  return { handlers, invalidate: (owner: number) => { starts.delete(owner); } };
}
