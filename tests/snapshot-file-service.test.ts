import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import type { UiSnapshot } from "../shared/types";
import { parseSnapshotFile } from "../shared/snapshot-file";
import { snapshotExportRequest } from "../src/features/history/snapshot-file-service";

const snapshot: UiSnapshot = { serial: "fixture", root: makeNode("0"), nodeCount: 1, xmlSize: 0, rawXml: null, screenshotDataUrl: null, error: null, warning: null };
test("full exports use storage-ready pixels and preserve the versioned snapshot contract", () => {
  const stored = { ...snapshot, warning: "saved group provenance" }, before = JSON.stringify(snapshot), now = new Date("2026-10-14T01:02:03Z");
  const output = snapshotExportRequest(snapshot, "snapshot", stored, now)!;
  assert.equal(output.format, "snapshot");
  assert.equal(output.defaultFileName, "android-ui-inspector-snapshot-2026-10-14T01-02-03-000Z.json");
  const parsed = parseSnapshotFile(JSON.parse(output.data));
  assert.deepEqual(parsed.snapshot, stored); assert.equal(parsed.exportedAt, now.toISOString());
  assert.equal(JSON.stringify(snapshot), before);
});
test("legacy JSON shape and unavailable XML/PNG remain distinct from complete files", () => {
  const legacy = snapshotExportRequest(snapshot, "json", null)!;
  assert.deepEqual(Object.keys(JSON.parse(legacy.data)), ["serial", "nodeCount", "xmlSize", "root"]);
  assert.equal(snapshotExportRequest(snapshot, "xml", null), null);
  assert.equal(snapshotExportRequest(snapshot, "png", null), null);
  assert.equal(snapshotExportRequest({ ...snapshot, rawXml: "<hierarchy/>" }, "xml", null)?.data, "<hierarchy/>");
});
