import { randomUUID } from "node:crypto";
import { parseUiHierarchy } from "../../electron/capture/xml-tree";
import type { UiSnapshot } from "../../shared/types";
import type { HelperObservationEvidence } from "../../shared/helper-observation";

export const helperFixtureServiceId = "10000000-0000-4000-8000-000000000001";
export function helperEvidenceSnapshot(options: { startedAt?: number; packageName?: string; serial?: string;
  text?: string; width?: number; height?: number } = {}): UiSnapshot {
  const { startedAt = 100, packageName = "com.example.helper", serial = "helper-fixture", text = "完成", width = 100, height = 200 } = options;
  const frame = { width, height, rotation: 0 as const };
  const bounds = `[0,0][${width},${height}]`;
  const xml = `<hierarchy rotation="0"><node index="0" class="android.widget.TextView" package="${packageName}" text="${text}"
    resource-id="${packageName}:id/result" content-desc="" bounds="${bounds}" bounds-screen="${bounds}" visible-bounds="${bounds}"
    window-id="7" visible-to-user="true" enabled="true" clickable="true" focusable="true" focused="false" scrollable="false" selected="false"/></hierarchy>`;
  const windows: HelperObservationEvidence["windowsBefore"] = [{ id: "7", type: "application", layer: 1, active: true,
    focused: true, bounds: { x: 0, y: 0, width, height }, packageName, rootAvailable: true }];
  return { serial, root: parseUiHierarchy(xml).root, rawXml: xml, xmlSize: Buffer.byteLength(xml), nodeCount: 1,
    screenshotDataUrl: null, error: null, warning: null, inspectionSource: "accessibility-helper", captureMode: "fast",
    captureGeometry: { screenshotSize: frame, beforeScreenshot: frame, afterScreenshot: frame, hierarchyRotation: 0 },
    helperObservation: { protocolVersion: 1, serviceInstanceId: helperFixtureServiceId, captureId: randomUUID(), windowId: "7", packageName,
      timing: { startedAtMs: startedAt, hierarchyStartedAtMs: startedAt + 1, hierarchyCompletedAtMs: startedAt + 2,
        screenshotStartedAtMs: startedAt + 3, screenshotCompletedAtMs: startedAt + 4, completedAtMs: startedAt + 5 },
      screenshotTiming: "after-hierarchy", lossless: true, complete: true, visibility: "explicit-clipped",
      displayBefore: frame, displayAfter: frame, windowsBefore: windows, windowsAfter: structuredClone(windows) } };
}

