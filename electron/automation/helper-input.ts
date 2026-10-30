import type { DebugInputEvidence } from "../../shared/types";
import type { AccessibilityHelperSession } from "../capture/helper-session";
import { HelperInputError } from "../capture/helper-input";
import { DebugInputError } from "../device/debug-input";
import { automationAdb, checkedDebugTarget, sameActivityInstance } from "../device/target";
import { readDisplayFrame } from "../device/screen";
import { withCommandSignal } from "../device/command-context";
import { debugInputArgs, type DebugObserver } from "./device-actions";
import { measureDebugPhase } from "./debug-timing";
import { resolveAccessibilityScroll } from "./debug-target-resolution";

/** Select this path before input. A failed gesture never falls back to shell input. */
export function createHelperDebugInput(helper?: AccessibilityHelperSession): NonNullable<DebugObserver["helperInput"]> {
  return (serial, target, action, frame, source, signal, onEvidence, targetNode) => withCommandSignal(signal, async () => {
    const started = performance.now();
    let invoked = false;
    const evidence = (classification: DebugInputEvidence["classification"], dispatchState: "not_sent" | "unknown" | "sent",
      requestId?: string, receipt?: NonNullable<DebugInputEvidence["helperInput"]>["receipt"]): DebugInputEvidence => ({
      transport: "accessibility-helper", helperInput: { dispatchState, ...(requestId ? { requestId } : {}), ...(receipt ? { receipt } : {}) },
      classification, spawned: false, closed: false, exitCode: null, signal: null,
      durationMs: Math.round(performance.now() - started), stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
    });
    let result: DebugInputEvidence;
    let explanation = "Helper 未确认操作完成，请查看输入回执和当前页面。";
    try {
      signal.throwIfAborted();
      if (!helper?.input || !source) throw new Error("Helper 输入缺少当前授权观察。");
      if (action.kind === "scroll") {
        if (!targetNode) throw new Error("无障碍滚动缺少精确容器。");
        resolveAccessibilityScroll(targetNode, action.direction);
      } else debugInputArgs(action);
      const adbPath = automationAdb(serial);
      const fresh = await measureDebugPhase("target_before", () => checkedDebugTarget(adbPath, serial, target.packageName));
      if (fresh.windowId !== target.windowId || !sameActivityInstance(target, fresh)) throw new Error("操作前窗口已变化。");
      const display = await measureDebugPhase("geometry", () => readDisplayFrame(adbPath, serial));
      if (!display || display.width !== frame.width || display.height !== frame.height || display.rotation !== frame.rotation)
        throw new Error("操作前屏幕方向或尺寸已变化。");
      const points = action.kind === "back" || action.kind === "scroll" ? [] : action.kind === "tap" ? [[action.x, action.y]]
        : [[action.fromX, action.fromY], [action.toX, action.toY]];
      if (points.some(([x, y]) => x >= display.width || y >= display.height)) throw new Error("操作坐标不在屏幕内。");
      signal.throwIfAborted();
      const bounds = targetNode?.bounds;
      const selectsDescriptor = action.kind === "tap" || action.kind === "scroll";
      const resourceId = targetNode?.resourceId, desc = targetNode?.contentDesc;
      const validId = typeof resourceId === "string" && resourceId.trim().length > 0 && resourceId.length <= 512;
      if (selectsDescriptor && resourceId !== null && resourceId !== undefined && !validId) throw new Error("控件 ID 无效，未改用描述或手势执行。");
      // Absence must be explicit. An invalid or oversized existing ID never becomes a description-only target.
      const descriptionCandidate = action.kind === "tap" && resourceId == null && typeof desc === "string" && desc.trim().length > 0;
      const descriptionOnly = descriptionCandidate && resourceId === null && targetNode?.attributes?.["resource-id"] === "" && desc.length <= 512;
      const nodeTarget = selectsDescriptor && (validId || descriptionOnly) && targetNode?.className
        && targetNode.className.trim().length > 0 && targetNode.className.length <= 512 && bounds
        && [bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isSafeInteger)
        && bounds.left >= 0 && bounds.top >= 0 && bounds.right <= display.width && bounds.bottom <= display.height
        && bounds.left < bounds.right && bounds.top < bounds.bottom
        ? { ...(validId ? { resourceId } : {}), className: targetNode.className,
          ...(typeof targetNode.text === "string" && targetNode.text.length <= 512 ? { text: targetNode.text } : {}),
          ...(typeof targetNode.contentDesc === "string" && targetNode.contentDesc.length <= 512 ? { contentDesc: targetNode.contentDesc } : {}),
          bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom } } : undefined;
      if (selectsDescriptor && (action.kind === "scroll" || validId || descriptionCandidate) && !nodeTarget)
        throw new Error("控件操作缺少屏幕内的精确目标描述，未改用手势执行。");
      invoked = true;
      const reply = await helper.input(adbPath, target.packageName, frame, source, action, signal, nodeTarget);
      result = evidence(reply.status === "completed" ? "accepted" : reply.status === "timeout" ? "timeout" : "command-failed",
        reply.dispatchState, reply.requestId, reply);
    } catch (error) {
      const known = error instanceof HelperInputError ? error : undefined;
      if (known) explanation = known.message;
      result = evidence(signal.aborted ? "cancelled" : "command-failed", known?.dispatchState ?? (invoked ? "unknown" : "not_sent"),
        known?.requestId, known?.reply);
    }
    onEvidence(result);
    if (result.classification !== "accepted") throw new DebugInputError(result,
      signal.aborted ? "Helper 输入已取消。" : explanation);
  });
}
