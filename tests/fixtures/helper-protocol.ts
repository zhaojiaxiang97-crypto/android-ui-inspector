import { randomUUID } from "node:crypto";
import type { HelperObservationEvidence } from "../../shared/helper-observation";

export const helperPackage = "com.example.helper", helperSerial = "helper-protocol-fixture", helperToken = "test_session_token_never_device";
export const helperFrame = { width: 10, height: 20, rotation: 0 as const };
export const helperServiceId = "9f44917d-5448-46f4-a12d-ed5cf7be7de9";
export const helperCapabilities = { success: true, protocolVersion: 1, serviceInstanceId: helperServiceId,
  capabilities: { tree: true, screenshot: true, losslessScreenshot: true, completeFields: true, windowIdentity: true,
    visibleBounds: true, includeInvisible: true, orderedObservation: true }, screenshotFormat: "png", visibility: "explicit-clipped" };
export function helperEvidence(start = 100): HelperObservationEvidence {
  const window = { id: "7", type: "application" as const, layer: 1, active: true, focused: true,
    bounds: { x: 0, y: 0, width: 10, height: 20 }, packageName: helperPackage, rootAvailable: true };
  return { protocolVersion: 1, serviceInstanceId: helperServiceId, captureId: randomUUID(), windowId: "7", packageName: helperPackage,
    timing: { startedAtMs: start, hierarchyStartedAtMs: start + 1, hierarchyCompletedAtMs: start + 2,
      screenshotStartedAtMs: start + 3, screenshotCompletedAtMs: start + 4, completedAtMs: start + 5 },
    screenshotTiming: "after-hierarchy", lossless: true, complete: true, visibility: "explicit-clipped",
    displayBefore: { ...helperFrame }, displayAfter: { ...helperFrame }, windowsBefore: [structuredClone(window)], windowsAfter: [structuredClone(window)] };
}
export function helperXml(hidden = false) {
  const attrs = `index="0" class="android.view.View" package="${helperPackage}" text="" resource-id="" content-desc="" bounds="[0,0][10,20]" bounds-screen="[0,0][10,20]" visible-bounds="[0,0][10,20]" window-id="7" enabled="true" clickable="false" focusable="false" focused="false" scrollable="false" selected="false"`;
  return `<hierarchy rotation="0"><node ${attrs} window-focused="true" window-type="application" visible-to-user="true"><node ${attrs} visible-to-user="${!hidden}"/></node></hierarchy>`;
}
export function helperPayload(png: string, start = 100) {
  return { success: true, xml: helperXml(), ...helperFrame, window_count: 1, node_count: 2, truncated: false, has_screenshot: true,
    screenshot_format: "png", screenshot_base64: png, helperObservation: helperEvidence(start) };
}
