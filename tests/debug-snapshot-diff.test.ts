import assert from "node:assert/strict";
import { test } from "node:test";
import { DIFF_PACKAGE, DIFF_SERIAL, makeDiffNode, makeDiffObservation, makeDiffSnapshot } from "../benchmarks/debug-step-diff-fixtures";
import { compareDebugSnapshots, debugDiffSnapshotIdentity, DEBUG_DIFF_LIMITS } from "../shared/debug-snapshot-diff";
import type { DebugDiffObservation } from "../shared/debug-snapshot-diff";

const compare = (before: DebugDiffObservation, after: DebugDiffObservation) => compareDebugSnapshots({ before, after, expectedSerial: DIFF_SERIAL, expectedPackageName: DIFF_PACKAGE });
function fixture() {
  return { before: makeDiffObservation(makeDiffSnapshot([makeDiffNode("0/0", "save", "保存")]), "before"),
    after: makeDiffObservation(makeDiffSnapshot([makeDiffNode("0/0", "save", "已保存")]), "after") };
}

test("unique resource controls survive list insertion and changing positional IDs without fabricated text changes", () => {
  const before = makeDiffObservation(makeDiffSnapshot([makeDiffNode("0/0", "first", "甲"), makeDiffNode("0/1", "second", "乙")]), "before");
  const after = makeDiffObservation(makeDiffSnapshot([makeDiffNode("0/0", "insert", "新"), makeDiffNode("0/1", "first", "甲"), makeDiffNode("0/2", "second", "乙")]), "after");
  const unchanged = JSON.stringify({ before, after }), diff = compare(before, after);
  assert.equal(diff.status, "compared"); assert.deepEqual(diff.counts, { added: 1, removed: 0, changed: 0, unchanged: 3, unmatchedBefore: 0, unmatchedAfter: 0 });
  assert.equal(diff.changes[0].after?.resourceId, `${DIFF_PACKAGE}:id/insert`);
  assert.equal(JSON.stringify({ before, after }), unchanged);
});

test("text, description, screen position, enabled and other states compare only within a stable unique control", () => {
  const { before, after } = fixture();
  Object.assign(after.snapshot!.root!.children[0], { contentDesc: "保存结果", enabled: false, visibleToUser: false, clickable: false, selected: true,
    bounds: { left: 22, top: 65, right: 202, bottom: 105, raw: "[22,65][202,105]" } });
  const diff = compare(before, after);
  assert.equal(diff.status, "compared"); assert.equal(diff.counts.changed, 1);
  assert.deepEqual(diff.changes[0].fields, ["text", "contentDesc", "enabled", "visibleToUser", "clickable", "selected", "bounds"]);
  assert.equal(diff.changes[0].before?.text, "保存"); assert.equal(diff.changes[0].after?.text, "已保存");
});

test("observed additions and removals never use equal positional IDs as identity", () => {
  const { before, after } = fixture();
  after.snapshot!.root!.children[0].resourceId = `${DIFF_PACKAGE}:id/other`;
  const diff = compare(before, after);
  assert.equal(diff.counts.added, 1); assert.equal(diff.counts.removed, 1); assert.equal(diff.counts.changed, 0);
});

test("duplicate resources remain unconfirmed after list insertion even when texts and positions happen to match", () => {
  const before = makeDiffObservation(makeDiffSnapshot([makeDiffNode("0/0", "row", "甲"), makeDiffNode("0/1", "row", "乙")]), "before");
  const after = makeDiffObservation(makeDiffSnapshot([makeDiffNode("0/0", "row", "新"), makeDiffNode("0/1", "row", "甲"), makeDiffNode("0/2", "row", "乙")]), "after");
  const diff = compare(before, after);
  assert.equal(diff.status, "partial"); assert.equal(diff.totalChanges, 0);
  assert.equal(diff.counts.unmatchedBefore, 2); assert.equal(diff.counts.unmatchedAfter, 3);
  assert.match(diff.warnings.join(" "), /重复资源 ID/);
});

test("a resource duplicated on only one side or across different classes is also ambiguous", () => {
  for (const differentClass of [false, true]) {
    const { before, after } = fixture();
    after.snapshot!.root!.children.push({ ...makeDiffNode("0/1", "save", "另一条"), className: differentClass ? "android.widget.TextView" : "android.widget.Button" });
    after.snapshot!.nodeCount++;
    const diff = compare(before, after);
    assert.equal(diff.totalChanges, 0); assert.equal(diff.counts.unmatchedBefore, 1); assert.equal(diff.counts.unmatchedAfter, 2);
  }
  const { before, after } = fixture();
  after.snapshot!.root!.children.push({ ...makeDiffNode("0/1", "save", "未知类型"), className: null });
  after.snapshot!.nodeCount++;
  assert.equal(compare(before, after).totalChanges, 0);
});

test("empty and absent text or description are the same observation value", () => {
  const { before, after } = fixture();
  before.snapshot!.root!.children[0].text = null; after.snapshot!.root!.children[0].text = "";
  after.snapshot!.root!.children[0].contentDesc = "";
  assert.equal(compare(before, after).totalChanges, 0);
});

test("missing resources, identical text and paths cannot identify anonymous controls; changed classes remain unconfirmed", () => {
  const { before, after } = fixture();
  before.snapshot!.root!.children[0].resourceId = after.snapshot!.root!.children[0].resourceId = null;
  let diff = compare(before, after);
  assert.equal(diff.totalChanges, 0); assert.equal(diff.status, "partial");
  before.snapshot!.root!.children[0].resourceId = after.snapshot!.root!.children[0].resourceId = `${DIFF_PACKAGE}:id/save`;
  after.snapshot!.root!.children[0].className = "android.widget.TextView";
  diff = compare(before, after); assert.equal(diff.totalChanges, 0); assert.equal(diff.counts.unmatchedAfter, 1);
});

test("different activities, windows, or Activity instances make matching unavailable even with identical resources", () => {
  for (const change of [{ component: `${DIFF_PACKAGE}/.Other` }, { windowId: "window-2" }, { activityRecordId: "activity-2" }]) {
    const { before, after } = fixture(); after.identity = { ...after.identity!, ...change };
    const diff = compare(before, after); assert.equal(diff.status, "unavailable"); assert.equal(diff.totalChanges, 0); assert.match(diff.reason!, /页面、窗口/);
  }
});

test("missing or empty Activity instance identities never establish the same page instance", () => {
  for (const activityRecordId of [null, ""]) {
    const { before, after } = fixture(); before.identity!.activityRecordId = after.identity!.activityRecordId = activityRecordId;
    assert.match(compare(before, after).reason!, /缺少 Activity 实例身份/);
  }
  const { before, after } = fixture(); after.identity = null;
  assert.match(compare(before, after).reason!, /缺少页面或窗口身份/);
  before.snapshot!.root!.attributes!["debug-observation-activity-record-id"] = "";
  assert.equal(debugDiffSnapshotIdentity(before.snapshot)?.activityRecordId, null);
});

test("explicit observation identity cannot hide conflicting scope recorded in the tree", () => {
  const { before, after } = fixture();
  after.snapshot!.root!.attributes!["debug-observation-window-id"] = "another-window";
  assert.match(compare(before, after).reason!, /与节点留证不一致/);
});

test("missing, previous, failed, reused and out-of-order observations cannot become a comparison", () => {
  const cases: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.after.freshness = "missing"; }, f => { f.before.freshness = "previous"; }, f => { f.after.snapshotId = f.before.snapshotId; },
    f => { f.after.snapshotId = null; }, f => { f.after.capturedAt = f.before.capturedAt; }, f => { f.after.capturedAt = "not-a-date"; },
    f => { f.after.capturedAt = "2026-10-11T00:00:00Z"; }, f => { f.after.treeError = "节点文件读取失败"; },
    f => { f.after.snapshot = null; }, f => { f.after.snapshot!.error = "采集失败"; }, f => { f.before.snapshot!.root = null; },
  ];
  for (const mutate of cases) { const f = fixture(); mutate(f); const diff = compare(f.before, f.after); assert.equal(diff.status, "unavailable"); assert.equal(diff.totalChanges, 0); }
  const f = fixture(); f.after.freshness = "previous"; assert.match(compare(f.before, f.after).reason!, /之前的观察/);
});

test("wrong device, App, capture source or scope never compares", () => {
  const cases: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.after.snapshot!.serial = "other-device"; }, f => { f.after.snapshot!.root!.package = "other.app"; },
    f => { f.after.snapshot!.inspectionSource = "accessibility-helper"; }, f => { f.after.snapshot!.inspectionSource = undefined; },
    f => { f.after.snapshot!.captureMode = "deep"; }, f => { f.after.snapshot!.captureMode = undefined; },
    f => { f.after.snapshot!.hierarchyDumpMode = "compressed"; }, f => { f.after.identity!.component = "other.app/.Main"; },
  ];
  for (const mutate of cases) { const f = fixture(); mutate(f); assert.equal(compare(f.before, f.after).status, "unavailable"); }
});

test("duplicate node IDs and inconsistent node counts reject the whole observation", () => {
  const { before, after } = fixture();
  after.snapshot!.root!.children[0].id = "0";
  assert.match(compare(before, after).reason!, /节点编号重复/);
  after.snapshot!.root!.children[0].id = "0/0"; after.snapshot!.nodeCount = 99;
  assert.equal(compare(before, after).status, "unavailable");
});

test("unchecked geometry skips only position changes; checked orientation or size changes block comparison", () => {
  const { before, after } = fixture();
  after.snapshot!.root!.children[0].bounds!.top += 5;
  after.snapshot!.captureGeometry = undefined;
  let diff = compare(before, after);
  assert.equal(diff.status, "partial"); assert.deepEqual(diff.changes[0].fields, ["text"]); assert.match(diff.warnings.join(" "), /位置变化未知/);
  after.snapshot!.captureGeometry = structuredClone(before.snapshot!.captureGeometry!);
  const geometry = after.snapshot!.captureGeometry!;
  geometry.hierarchyRotation = 1; geometry.beforeScreenshot!.rotation = geometry.afterScreenshot!.rotation = 1;
  assert.equal(compare(before, after).status, "unavailable");
  geometry.hierarchyRotation = 0; geometry.beforeScreenshot!.rotation = geometry.afterScreenshot!.rotation = 0;
  geometry.screenshotSize.width = geometry.beforeScreenshot!.width = geometry.afterScreenshot!.width = 400;
  assert.equal(compare(before, after).status, "unavailable");
  after.snapshot!.captureGeometry = structuredClone(before.snapshot!.captureGeometry!);
  after.snapshot!.root!.children[0].bounds = null;
  diff = compare(before, after); assert.deepEqual(diff.changes[0].fields, ["text"]); assert.match(diff.warnings.join(" "), /节点位置缺失/);
});

test("compressed evidence explicitly limits additions and removals to recorded controls", () => {
  const { before, after } = fixture(); before.snapshot!.hierarchyDumpMode = after.snapshot!.hierarchyDumpMode = "compressed";
  const diff = compare(before, after); assert.equal(diff.status, "partial"); assert.match(diff.warnings.join(" "), /不证明屏内出现或消失/);
});

test("diff output is bounded while total changes and unmatched counts retain complete totals", () => {
  const count = DEBUG_DIFF_LIMITS.rows + 10;
  const before = makeDiffObservation(makeDiffSnapshot(Array.from({ length: count }, (_, i) => makeDiffNode(`0/${i}`, `old${i}`))), "before");
  const after = makeDiffObservation(makeDiffSnapshot(Array.from({ length: count }, (_, i) => makeDiffNode(`0/${i}`, `new${i}`))), "after");
  const diff = compare(before, after);
  assert.equal(diff.changes.length, DEBUG_DIFF_LIMITS.rows); assert.equal(diff.totalChanges, count * 2);
  assert.equal(diff.counts.added, count); assert.equal(diff.counts.removed, count); assert.match(diff.warnings.join(" "), /最多展开前/);
  for (const observation of [before, after]) for (const node of observation.snapshot!.root!.children) node.resourceId = null;
  const ambiguous = compare(before, after);
  assert.equal(ambiguous.counts.unmatchedBefore, count); assert.equal(ambiguous.unmatched.before.length, DEBUG_DIFF_LIMITS.unmatchedRows);
});

test("repeated resources across a large tree have bounded output and never produce false changes", () => {
  const count = 5_000;
  const before = makeDiffObservation(makeDiffSnapshot(Array.from({ length: count }, (_, i) => makeDiffNode(`0/${i}`, "row", `甲${i}`))), "before");
  const after = makeDiffObservation(makeDiffSnapshot(Array.from({ length: count }, (_, i) => makeDiffNode(`0/${i}`, "row", `乙${i}`))), "after");
  const diff = compare(before, after);
  assert.equal(diff.totalChanges, 0); assert.equal(diff.counts.unmatchedBefore, count); assert.equal(diff.unmatched.after.length, DEBUG_DIFF_LIMITS.unmatchedRows);
});
