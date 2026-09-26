import type { UiNode, UiSnapshot } from "./types";
import { isCaptureGeometry } from "./screen-coordinates";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStringMap(value: unknown) {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === "string");
}

function isUiBounds(value: unknown) {
  return isRecord(value)
    && [value.left, value.top, value.right, value.bottom].every(entry => typeof entry === "number" && Number.isFinite(entry))
    && typeof value.raw === "string";
}

function isUiNode(value: unknown, depth = 0, budget = { count: 0 }): value is UiNode {
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
    && (value.layerImageDataUrl === undefined || typeof value.layerImageDataUrl === "string")
    && (value.layerImageEmpty === undefined || typeof value.layerImageEmpty === "boolean")
    && (value.layerImageStatus === undefined || ["captured", "style", "unavailable", "ambiguous", "hidden", "failed"].includes(value.layerImageStatus as string))
    && (value.layerImageSize === undefined || (isRecord(value.layerImageSize) && [value.layerImageSize.width, value.layerImageSize.height].every(entry => typeof entry === "number" && Number.isFinite(entry) && entry > 0)))
    && (value.attributes === undefined || isStringMap(value.attributes))
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
    && (value.inspectionSource === undefined || ["uiautomator", "debug-view", "debug-qml"].includes(value.inspectionSource as string))
    && (value.hierarchyDumpMode === undefined || ["full", "compressed"].includes(value.hierarchyDumpMode as string))
    && (value.captureDurationMs === undefined || (typeof value.captureDurationMs === "number" && Number.isFinite(value.captureDurationMs) && value.captureDurationMs >= 0))
    && (value.captureTimings === undefined || (isRecord(value.captureTimings) && Object.values(value.captureTimings).every(duration => typeof duration === "number" && Number.isFinite(duration) && duration >= 0)))
    && (value.captureGeometry === undefined || isCaptureGeometry(value.captureGeometry));
}
