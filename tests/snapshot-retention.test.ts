import assert from "node:assert/strict";
import { test } from "node:test";
import type { StoredSnapshot } from "../shared/types";
import { boundSnapshotHistory, MAX_SNAPSHOT_LIBRARY_BYTES } from "../electron/desktop/snapshot-retention";
import { makeNode } from "../benchmarks/fixtures";

function entry(index: number, contents = ""): StoredSnapshot {
  return { id: String(index), capturedAt: new Date(0).toISOString(), savedAt: new Date(0).toISOString(),
    snapshot: { serial: "test-device", root: makeNode("0"), nodeCount: 1,
      xmlSize: 0, rawXml: null, screenshotDataUrl: contents, warning: null, error: null } };
}

test("snapshot history preserves 30 newest records and exact UTF-8 storage budget", () => {
  const many = Array.from({ length: 36 }, (_, index) => entry(index));
  const full = boundSnapshotHistory(many);
  assert.deepEqual(full.snapshots.map(x => x.id), many.slice(-30).map(x => x.id));
  assert.equal(JSON.parse(full.serialized).length, 30);
  assert.ok(Buffer.byteLength(full.serialized) <= MAX_SNAPSHOT_LIBRARY_BYTES);
  const existing = [entry(0, "A".repeat(500)), entry(1, "汉字".repeat(170))];
  const unchanged = structuredClone(existing);
  assert.throws(() => boundSnapshotHistory([...existing, entry(2, "B".repeat(500))], 1600),
    /本次保存未写入，原有历史不变/);
  assert.deepEqual(existing, unchanged, "capacity failure must not mutate the original history");
  const fitting = boundSnapshotHistory([entry(0, "short"), entry(1, "汉字")], 1600);
  assert.ok(Buffer.byteLength(fitting.serialized, "utf8") <= 1600);
  assert.deepEqual(JSON.parse(fitting.serialized), fitting.snapshots);
});

test("overbudget newest snapshot fails without returning or truncating an invalid replacement", () => {
  assert.throws(() => boundSnapshotHistory([entry(0, "A".repeat(100))], 5), /容量上限/);
  assert.deepEqual(boundSnapshotHistory([], 5).snapshots, []);
});
