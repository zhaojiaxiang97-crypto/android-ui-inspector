import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { makeDebugDiffReportFixture } from "../benchmarks/debug-step-diff-fixtures";
import { DebugReportStepDetails, DebugTaskCheckEvidence } from "../src/features/reports/DebugReportStepDetails";
import { DebugReportStepDiff } from "../src/features/reports/DebugReportStepDiff";
import { debugStepSnapshotDiff, debugStepOutcomeLabel, debugTaskSnapshotDiff } from "../src/features/reports/debug-report-view";

test("step diff uses exactly the referenced loaded trees and does not mutate historical input", () => {
  const f = makeDebugDiffReportFixture();
  f.data.snapshots.unshift({ ...f.data.snapshots[0], evidence: { ...f.data.snapshots[0].evidence, snapshotId: "neighbor" } });
  const original = JSON.stringify(f), diff = debugStepSnapshotDiff(f.data, f.record);
  assert.equal(diff.status, "compared"); assert.deepEqual(diff.counts, { added: 1, removed: 1, changed: 1, unchanged: 1, unmatchedBefore: 0, unmatchedAfter: 0 });
  assert.equal(diff.changes.find(change => change.kind === "changed")?.after?.text, "保存完成");
  assert.equal(JSON.stringify(f), original);
});

test("duplicate snapshot references, unloaded trees, missing files and conflicting source are unavailable", () => {
  const cases: Array<(f: ReturnType<typeof makeDebugDiffReportFixture>) => void> = [
    f => { f.data.snapshots.push(structuredClone(f.data.snapshots[0])); },
    f => { f.data.snapshots[0].evidence.tree = null; }, f => { f.data.snapshots[0].treeError = "节点文件校验失败"; },
    f => { f.data.snapshots[0].snapshot = null; }, f => { f.data.snapshots = f.data.snapshots.slice(1); },
    f => { f.data.snapshots[0].evidence.source = "accessibility-helper"; },
  ];
  for (const mutate of cases) { const f = makeDebugDiffReportFixture(); mutate(f); assert.equal(debugStepSnapshotDiff(f.data, f.record).status, "unavailable"); }
  const f = makeDebugDiffReportFixture(); f.data.snapshots.push(structuredClone(f.data.snapshots[0]));
  assert.match(debugStepSnapshotDiff(f.data, f.record).reason!, /快照编号不唯一/);
  const failed = makeDebugDiffReportFixture("error");
  assert.match(debugStepSnapshotDiff(failed.data, failed.record).reason!, /节点文件校验失败/);
});

test("Checker diff resolves its two observations rather than unrelated ordinary step references", () => {
  const f = makeDebugDiffReportFixture("check");
  f.record.before = { snapshotId: null, freshness: "missing", reason: null };
  f.record.after = { snapshotId: "neighbor", freshness: "previous", reason: null };
  const diff = debugStepSnapshotDiff(f.data, f.record);
  assert.equal(diff.status, "compared"); assert.deepEqual(diff, debugTaskSnapshotDiff(f.data, f.check));
  assert.equal(debugStepOutcomeLabel(f.record, f.data), "最终验收失败");
  const html = renderToStaticMarkup(createElement(DebugReportStepDetails, f));
  assert.match(html, /两次验收观察差异/); assert.match(html, /第1次观察/); assert.match(html, /第2次观察/);
  assert.match(html, /data-task-status="failed"/); assert.doesNotMatch(html, /最终验收通过/);
});

test("Checker observation timestamps and stored page identity cannot be substituted", () => {
  const changes: Array<(f: ReturnType<typeof makeDebugDiffReportFixture>) => void> = [
    f => { f.check.observations.first!.capturedAt = f.check.observations.second!.capturedAt; },
    f => { f.check.observations.first!.windowId = "different-window"; },
    f => { f.check.observations.first!.component = "sample.app/.Different"; },
    f => { f.check.observations.first!.activityRecordId = "another-instance"; },
    f => { f.check.observations.first = null; },
  ];
  for (const mutate of changes) { const f = makeDebugDiffReportFixture("check"); mutate(f); assert.equal(debugTaskSnapshotDiff(f.data, f.check).status, "unavailable"); }
});

test("legacy Checker evidence can use saved check identities but never invent a missing Activity instance", () => {
  const f = makeDebugDiffReportFixture("check");
  for (const saved of f.data.snapshots) delete saved.snapshot!.root!.attributes;
  assert.equal(debugTaskSnapshotDiff(f.data, f.check).status, "compared");
  f.check.observations.first!.activityRecordId = f.check.observations.second!.activityRecordId = null;
  assert.match(debugTaskSnapshotDiff(f.data, f.check).reason!, /缺少 Activity 实例身份/);
  delete f.record.step.taskCheck;
  assert.equal(debugStepSnapshotDiff(f.data, f.record).status, "unavailable");
});

test("ordinary legacy snapshots without stored scope explain why comparison is unavailable", () => {
  const f = makeDebugDiffReportFixture();
  for (const saved of f.data.snapshots) delete saved.snapshot!.root!.attributes;
  const diff = debugStepSnapshotDiff(f.data, f.record);
  assert.equal(diff.status, "unavailable"); assert.match(diff.reason!, /缺少页面或窗口身份/);
  const html = renderToStaticMarkup(createElement(DebugReportStepDiff, { diff }));
  assert.match(html, /无法比较/); assert.doesNotMatch(html, /已匹配的节点未发现属性变化/);
});

test("aged-out Checker steps expose diff from retained evidence without upgrading verdict", () => {
  const f = makeDebugDiffReportFixture("check"); f.data.steps = [];
  const html = renderToStaticMarkup(createElement(DebugTaskCheckEvidence, { data: f.data, images: f.images, check: f.check }));
  assert.match(html, /已不在最近100步/); assert.match(html, /两次验收观察差异/); assert.match(html, /data-diff-status="compared"/);
  assert.match(html, /最终条件验收 · 失败/); assert.match(html, /不改变 Checker 验收结果/);
});

test("normal, empty, partial, previous and corrupt states remain explicit in the rendered step detail", () => {
  const expected = { normal: /新增记录/, empty: /已匹配的节点未发现属性变化/, partial: /未确认匹配/, missing: /包含之前的观察/, error: /节点文件校验失败/ };
  for (const [state, pattern] of Object.entries(expected)) {
    const f = makeDebugDiffReportFixture(state as keyof typeof expected);
    const html = renderToStaticMarkup(createElement(DebugReportStepDetails, f));
    assert.match(html, /步骤前后差异/); assert.match(html, pattern); assert.match(html, /手机当前状态/);
    assert.equal(debugStepOutcomeLabel(f.record, f.data), "操作完成 · 尚未验收");
  }
});

test("repeated list resource IDs remain unknown in UI with no claimed insert, removal or text change", () => {
  const f = makeDebugDiffReportFixture("partial");
  f.data.snapshots[0].snapshot!.root!.children = f.data.snapshots[0].snapshot!.root!.children.slice(2);
  f.data.snapshots[1].snapshot!.root!.children = f.data.snapshots[1].snapshot!.root!.children.slice(2);
  for (const saved of f.data.snapshots) saved.snapshot!.nodeCount = 3;
  const html = renderToStaticMarkup(createElement(DebugReportStepDiff, { diff: debugStepSnapshotDiff(f.data, f.record) }));
  assert.match(html, /data-diff-status="partial"/); assert.match(html, /未确认部分仍未知/); assert.match(html, /前 2 个 \/ 后 2 个/);
  assert.doesNotMatch(html, /data-diff-kind=/); assert.match(html, /不能用于跨树匹配/);
});

test("recorded strings are escaped and diff source cannot capture, send input or select the primary tree", () => {
  const f = makeDebugDiffReportFixture();
  f.data.snapshots[1].snapshot!.root!.children[1].text = "<script>执行</script>";
  const html = renderToStaticMarkup(createElement(DebugReportStepDiff, { diff: debugStepSnapshotDiff(f.data, f.record) }));
  assert.match(html, /&lt;script&gt;执行&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/);
  const source = ["src/features/reports/DebugReportStepDiff.tsx", "src/features/reports/debug-report-view.ts", "shared/debug-snapshot-diff.ts"].map(path => readFileSync(path, "utf8")).join("\n");
  assert.doesNotMatch(source, /electronApi|ipcRenderer|inspectDevice|captureUi|startDebugSession|fetch\(|setSelectedNode|dangerouslySetInnerHTML/);
});
