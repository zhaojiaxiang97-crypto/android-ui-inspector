import type { ExportFormat, ExportSnapshotRequest, UiSnapshot } from "../../../shared/types";
import { serializeSnapshotFile } from "../../../shared/snapshot-file";

export type SnapshotPort = Pick<Window["electronApi"], "exportSnapshot" | "importSnapshotFile" | "loadSnapshots" | "saveSnapshot" | "clearSnapshots">;

export function snapshotExportRequest(snapshot: UiSnapshot, format: ExportFormat, stored: UiSnapshot | null, now = new Date()): ExportSnapshotRequest | null {
  const data = format === "snapshot" ? serializeSnapshotFile(stored ?? snapshot, now.toISOString())
    : format === "json" ? JSON.stringify({ serial: snapshot.serial, nodeCount: snapshot.nodeCount, xmlSize: snapshot.xmlSize, root: snapshot.root }, null, 2)
    : format === "xml" ? snapshot.rawXml ?? "" : snapshot.screenshotDataUrl ?? "";
  if (!data) return null;
  const stamp = now.toISOString().replace(/[.:]/g, "-");
  return { format, data, defaultFileName: `android-ui-inspector-${format === "snapshot" ? "snapshot-" : ""}${stamp}.${format === "snapshot" ? "json" : format}` };
}
