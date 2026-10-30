import type { QmlGroupImage, UiNode, UiSnapshot } from "./types";
import { isCaptureGeometry } from "./screen-coordinates";
import { isLayerCapturePlacement } from "./capture-transform";
import { isCaptureRequestDiagnostics } from "./capture-attempts";
import { isCaptureReadiness } from "./capture-readiness";
import { isDebugMetadata } from "./debug-metadata";
import { isHelperObservationEvidence, hasActionableHelperEvidence } from "./helper-observation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStringMap(value: unknown) {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === "string");
}

export function isGroupImage(value: unknown): value is QmlGroupImage {
  return isRecord(value) && typeof value.dataUrl === "string"
    && isRecord(value.size) && [value.size.width, value.size.height].every(size => typeof size === "number" && Number.isSafeInteger(size) && size > 0)
    && typeof value.capturedAt === "string" && value.capturedAt.length <= 128 && Number.isFinite(Date.parse(value.capturedAt));
}

function isSnapshotGroups(value: unknown, root: unknown) {
  if (!Array.isArray(value) || value.length > 20_000) return false;
  const nodes = new Set<string>();
  const pending = root ? [root as UiNode] : [];
  while (pending.length) { const node = pending.pop()!; nodes.add(node.id); pending.push(...node.children); }
  const groups = new Set<string>();
  return value.every(entry => {
    if (!isRecord(entry) || typeof entry.nodeId !== "string" || !nodes.has(entry.nodeId) || groups.has(entry.nodeId) || !isGroupImage(entry.image)) return false;
    groups.add(entry.nodeId);
    return true;
  });
}

function isUiBounds(value: unknown) {
  return isRecord(value)
    && [value.left, value.top, value.right, value.bottom].every(entry => typeof entry === "number" && Number.isFinite(entry))
    && typeof value.raw === "string";
}

function isUiNode(value: unknown, depth = 0, budget = { count: 0, bytes: 0 }): value is UiNode {
  if (!isRecord(value) || depth > 200 || budget.count++ >= 20_000) return false;
  return typeof value.id === "string"
    && (value.index === null || typeof value.index === "number")
    && isNullableString(value.className)
    && isNullableString(value.package)
    && isNullableString(value.text)
    && isNullableString(value.resourceId)
    && isNullableString(value.contentDesc)
    && (value.bounds === null || isUiBounds(value.bounds))
    && [value.clickable, value.enabled, value.focusable, value.focused, value.scrollable, value.selected, value.visibleToUser].every(flag => typeof flag === "boolean")
    && (value.visibilityEvidence === undefined || ["visible", "hidden", "unknown"].includes(value.visibilityEvidence as string))
    && (value.layerImageDataUrl === undefined || typeof value.layerImageDataUrl === "string")
    && (value.layerCapturePlacement === undefined || isLayerCapturePlacement(value.layerCapturePlacement)
      && typeof value.layerImageDataUrl === "string" && isRecord(value.layerImageSize)
      && (value.layerCapturePlacement.hidden || value.layerCapturePlacement.source.left >= 0 && value.layerCapturePlacement.source.top >= 0
        && value.layerCapturePlacement.source.left + value.layerCapturePlacement.source.width <= Number(value.layerImageSize.width) + 0.001
        && value.layerCapturePlacement.source.top + value.layerCapturePlacement.source.height <= Number(value.layerImageSize.height) + 0.001))
    && (value.layerImageEmpty === undefined || typeof value.layerImageEmpty === "boolean")
    && (value.layerImageStatus === undefined || ["captured", "style", "unavailable", "ambiguous", "hidden", "failed", "deferred"].includes(value.layerImageStatus as string))
    && (value.layerImageSize === undefined || (isRecord(value.layerImageSize) && [value.layerImageSize.width, value.layerImageSize.height].every(entry => typeof entry === "number" && Number.isFinite(entry) && entry > 0)))
    && (value.attributes === undefined || isStringMap(value.attributes))
    && (value.debugMetadata === undefined || isDebugMetadata(value.debugMetadata, budget))
    && Array.isArray(value.children)
    && value.children.every(child => isUiNode(child, depth + 1, budget));
}

export function isUiSnapshot(value: unknown): value is UiSnapshot {
  if (!isRecord(value)) return false;
  return typeof value.serial === "string" && value.serial.length <= 512
    && (value.root === null || isUiNode(value.root))
    && typeof value.nodeCount === "number" && Number.isFinite(value.nodeCount)
    && typeof value.xmlSize === "number" && Number.isFinite(value.xmlSize)
    && isNullableString(value.rawXml)
    && isNullableString(value.screenshotDataUrl)
    && isNullableString(value.error)
    && isNullableString(value.warning)
    && (value.inspectionSource === undefined || ["uiautomator", "accessibility-helper", "debug-view", "debug-qml", "debug-hybrid"].includes(value.inspectionSource as string))
    && (value.captureMode === undefined || ["fast", "deep"].includes(value.captureMode as string))
    && (value.layerCapture === undefined || ["on-demand", "full"].includes(value.layerCapture as string))
    && (value.inspectionSource !== "accessibility-helper" || value.captureMode === "fast")
    && (value.helperObservation === undefined || isHelperObservationEvidence(value.helperObservation)
      && value.inspectionSource === "accessibility-helper" && hasActionableHelperEvidence(value as UiSnapshot))
    && (value.hierarchyDumpMode === undefined || ["full", "compressed"].includes(value.hierarchyDumpMode as string))
    && (value.captureDurationMs === undefined || (typeof value.captureDurationMs === "number" && Number.isFinite(value.captureDurationMs) && value.captureDurationMs >= 0))
    && (value.captureTimings === undefined || (isRecord(value.captureTimings) && Object.values(value.captureTimings).every(duration => typeof duration === "number" && Number.isFinite(duration) && duration >= 0)))
    && (value.captureRequestDiagnostics === undefined || isCaptureRequestDiagnostics(value.captureRequestDiagnostics))
    && (value.captureReadiness === undefined || isCaptureReadiness(value.captureReadiness)
      && (value.captureDurationMs === undefined || value.captureReadiness.elapsedMs <= Number(value.captureDurationMs) + 1))
    && (value.captureGeometry === undefined || isCaptureGeometry(value.captureGeometry))
    && (value.layerGroupImages === undefined || isSnapshotGroups(value.layerGroupImages, value.root));
}
