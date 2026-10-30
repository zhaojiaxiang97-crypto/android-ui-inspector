import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { isDebugMetadata, debugFieldCopyValue, debugFieldDisplayValue, debugFieldSearchValues, MAX_DEBUG_METADATA_CAPTURE_BYTES,
  type DebugMetadata, type DebugTreeNode } from "../shared/debug-metadata";
import { isUiSnapshot } from "../shared/snapshot-validation";
import { parseSnapshotFile, serializeSnapshotFile } from "../shared/snapshot-file";
import { joinSdkTreeAndDebugImages } from "../electron/sdk/sdk-hybrid";
import { DebugEvidenceWriter } from "../electron/automation/debug-evidence";
import { loadTestReport } from "../electron/desktop/test-report";
import { addSnapshotDiffs } from "../src/features/history/model";
import { makeNode } from "../benchmarks/fixtures";
import type { DebugSessionState, UiSnapshot } from "../shared/types";
import type { DebugReportStep } from "../shared/debug-report";
import { structuredMetadataFixture, debugTreeDepth } from "./fixtures/structured-values";
import { businessMetadataFixture } from "./fixtures/debug-metadata";

function values(nodes: DebugTreeNode[]): DebugMetadata {
  return { version: 2, source: "debug-sdk-explicit", status: "captured", groups: [{ key: "state", label: "State", fields: [{ key: "detail", label: "Detail", type: "tree", value: nodes }] }] };
}
const snapshot = (metadata = structuredMetadataFixture): UiSnapshot => ({ serial: "structured-values-fixture", root: {
  ...makeNode("0"), debugMetadata: structuredClone(metadata), children: [{ ...makeNode("0/0"), debugMetadata: structuredClone(businessMetadataFixture) }],
}, nodeCount: 2, xmlSize: 0, rawXml: null, screenshotDataUrl: null, error: null, warning: null, inspectionSource: "debug-hybrid", captureMode: "deep" });

test("v2 explicit trees and nullable scalars preserve exact types and real paths while v1 is unchanged", () => {
  assert.equal(isDebugMetadata(structuredMetadataFixture), true);
  assert.equal(isDebugMetadata(businessMetadataFixture), true);
  const tree = structuredMetadataFixture.groups[0].fields[1];
  assert.equal(tree.type, "tree");
  if (tree.type !== "tree") throw new Error("fixture is not a tree");
  assert.deepEqual(tree.value[0].children.map(item => item.value).slice(0, 3), [false, 0, ""]);
  assert.equal(debugFieldCopyValue(structuredMetadataFixture.groups[0].fields[0]), "null");
  assert.deepEqual(JSON.parse(debugFieldCopyValue(tree)), tree.value);
  const terms = debugFieldSearchValues(tree, "state");
  for (const term of ["state/detail/request/loading", "state/detail/cache/loading", "state/detail/request/payload", "布尔值", "空字符串 empty ∅"])
    assert.ok(terms.includes(term), term);
  assert.ok(!terms.join(" ").includes("[object Object]"));
  assert.equal(debugFieldDisplayValue(tree), "分层信息 · 7 项");
  assert.equal(debugFieldCopyValue(tree.value[0].children[2]), "");
  assert.equal(debugFieldCopyValue(tree.value[0].children[3]), tree.value[0].children[3].value);
  assert.equal(isDebugMetadata({ ...structuredMetadataFixture, version: 1 }), false);
  assert.equal(isDebugMetadata({ ...structuredMetadataFixture, version: 3 }), false);
});

test("tree validation rejects cycles, duplicate siblings, unsupported children and coercion without mutating budget", () => {
  const invalid = (nodes: unknown) => {
    const budget = { bytes: 17 }, metadata = values(nodes as DebugTreeNode[]);
    assert.equal(isDebugMetadata(metadata, budget), false);
    assert.equal(budget.bytes, 17);
  };
  invalid([]);
  const node: DebugTreeNode = { key: "a", label: "A", type: "null", value: null, children: [] };
  invalid([node, structuredClone(node)]);
  invalid([{ ...node, children: [{ ...node }, { ...node }] }]);
  const cycle = { ...node }; cycle.children = [cycle]; invalid([cycle]);
  for (const bad of [null, [], { ...node, extra: "bad" }, { ...node, children: null }, { ...node, type: "null", value: "null" },
    { ...node, type: "boolean", value: "false" }, { ...node, type: "tree", value: [] }, { ...node, type: "number", value: NaN },
    { ...node, type: "number", value: Infinity }, { ...node, type: "number", value: Number.MAX_SAFE_INTEGER + 1 },
    { ...node, type: "string", value: "\ud800" }, { ...node, type: "string", value: "x".repeat(513) }, { ...node, label: "\udc00" },
    { ...node, key: "a/b" }, { ...node, label: " trailing " }, { ...node, label: "控制\n字符" }]) invalid([bad]);
  const twoPaths = [{ ...node, key: "left", children: [node] }, { ...node, key: "right", children: [node] }];
  assert.equal(isDebugMetadata(values(twoPaths)), true, "same sibling key at distinct paths is allowed");
  assert.equal(isDebugMetadata(values([{ ...node, key: "with.dot" }])), true, "dots are literal keys, not path separators");
});

test("tree depth and node boundaries are exact and preserve both metadata byte budgets", () => {
  assert.equal(isDebugMetadata(values(debugTreeDepth(8))), true);
  assert.equal(isDebugMetadata(values(debugTreeDepth(9))), false);
  const flat = Array.from({ length: 128 }, (_, i): DebugTreeNode => ({ key: `n${i}`, label: "Node", type: "null", value: null, children: [] }));
  const metadata = values(flat);
  assert.equal(isDebugMetadata(metadata), true);
  assert.equal(isDebugMetadata(values([...flat, { ...flat[0], key: "overflow" }])), false);
  assert.equal(isDebugMetadata(values([{ ...flat[0], children: flat }])), false);
  assert.equal(isDebugMetadata(values(flat.map(item => ({ ...item, type: "string", value: "中".repeat(512) })))), false);
  const budget = { bytes: 0 }; let accepted = 0;
  while (isDebugMetadata(metadata, budget)) accepted++;
  assert.ok(accepted > 1 && budget.bytes <= MAX_DEBUG_METADATA_CAPTURE_BYTES);
  const before = budget.bytes;
  assert.equal(isDebugMetadata({ version: 2, source: "debug-sdk-explicit", status: "omitted-budget", groups: [] }, budget), true);
  assert.equal(budget.bytes, before, "omission marker must not consume the remaining business-value budget");
});

test("file v2 preserves mixed node protocols, reads old v1 and prevents downgrading new values", () => {
  const current = snapshot();
  assert.equal(isUiSnapshot(current), true);
  const document = JSON.parse(serializeSnapshotFile(current, "2026-10-11T01:00:00.000Z"));
  assert.equal(document.version, 2);
  assert.deepEqual(parseSnapshotFile(document).snapshot, current);
  assert.throws(() => parseSnapshotFile({ ...document, version: 1 }), /v1.*v2/);
  assert.throws(() => parseSnapshotFile({ ...document, version: 3 }), /版本/);
  const old = snapshot(businessMetadataFixture), oldFile = JSON.parse(serializeSnapshotFile(old));
  assert.equal(oldFile.version, 1);
  assert.deepEqual(parseSnapshotFile(oldFile).snapshot, old);
  assert.deepEqual(parseSnapshotFile({ ...oldFile, version: 2 }).snapshot, old);
  const invalid = structuredClone(document); invalid.snapshot.root.debugMetadata.groups[0].fields[1].value[0].children.push(invalid.snapshot.root.debugMetadata.groups[0].fields[1].value[0].children[0]);
  assert.throws(() => parseSnapshotFile(invalid), /格式/);
});

test("SDK v2 capability accepts mixed values, copies input and refuses v2 data under v1", () => {
  const props = { visible: true, clickable: false, enabled: true, focusable: false, focused: false, selected: false, scrollable: false,
    alpha: 1, elevation: 0, paddingLeft: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, screenX: 0, screenY: 0, width: 10, height: 10 };
  const sdk = { version: 1, debugMetadataVersion: 2, packageName: "sample.app", pid: 42, processInstance: "11111111-1111-1111-1111-111111111111", capturedAtMillis: 1, nodeCount: 2,
    root: { ...props, ref: "android.view.ViewGroup@1", className: "android.view.ViewGroup", debugMetadata: structuredClone(businessMetadataFixture), children: [{ ...props,
      ref: "android.view.View@2", className: "android.view.View", debugMetadata: structuredClone(structuredMetadataFixture), children: [] }] } };
  const bounds = { left: 0, top: 0, right: 10, bottom: 10, raw: "[0,0][10,10]" };
  const current: UiSnapshot = { ...snapshot(), inspectionSource: "debug-view", nodeCount: 3, root: { ...makeNode("0"), children: [{ ...makeNode("0/0"), className: sdk.root.className, text: null, bounds,
    attributes: { "view-ref": sdk.root.ref }, children: [{ ...makeNode("0/0/0"), className: sdk.root.children[0].className, text: null, bounds,
      attributes: { "view-ref": sdk.root.children[0].ref } }] }] } };
  const result = joinSdkTreeAndDebugImages(current, sdk, "sample.app", 42);
  assert.equal(result.root?.attributes?.["sdk-debug-metadata-version"], "2");
  assert.deepEqual(result.root!.children[0].debugMetadata, businessMetadataFixture);
  assert.deepEqual(result.root!.children[0].children[0].debugMetadata, structuredMetadataFixture);
  assert.throws(() => joinSdkTreeAndDebugImages(current, { ...sdk, debugMetadataVersion: 1 }, "sample.app", 42), /业务信息/);
  sdk.root.children[0].debugMetadata.groups.length = 0;
  assert.deepEqual(result.root!.children[0].children[0].debugMetadata, structuredMetadataFixture);
});

test("history and actual debug evidence report roundtrip retain complete typed trees", async () => {
  const current = snapshot();
  const time = new Date().toISOString();
  const history = addSnapshotDiffs([{ id: "one", savedAt: time, capturedAt: time, snapshot: current },
    { id: "two", savedAt: time, capturedAt: time, snapshot: structuredClone(current) }]);
  assert.deepEqual(history[1].snapshot.root!.debugMetadata, structuredMetadataFixture);
  const directory = mkdtempSync(join(tmpdir(), "inspector-structured-evidence-"));
  try {
    const session: DebugSessionState = { id: randomUUID(), serial: current.serial, packageName: current.root!.package!, active: true, busy: false,
      expiresAt: new Date(Date.now() + 60000).toISOString(), steps: [], evidencePath: null, stopReason: null };
    const writer = new DebugEvidenceWriter(directory, session);
    const step: DebugReportStep = { step: { id: 1, time, action: "capture_ui", input: { sessionId: session.id, mode: "deep", backend: "uiautomator" }, status: "done", message: "fixture" },
      finishedAt: time, durationMs: 1, verified: null, before: { snapshotId: null, freshness: "missing", reason: null }, after: { snapshotId: null, freshness: "missing", reason: null } };
    const entry = { id: randomUUID(), sharedAt: time, ownerPid: process.pid, selectedNodeId: "0", snapshot: current };
    assert.deepEqual(writer.record(session, 1, step, { entry: null, freshness: "missing", reason: null }, { entry, freshness: "current", reason: null }), []);
    const raw = JSON.parse(readFileSync(writer.path, "utf8"));
    const saved = JSON.parse(readFileSync(join(directory, raw.snapshots[0].tree.path), "utf8"));
    assert.deepEqual(saved.snapshot.root.debugMetadata, structuredMetadataFixture);
    const imported = await loadTestReport(writer.path);
    assert.deepEqual(imported.debug?.snapshots[0].snapshot?.root?.debugMetadata, structuredMetadataFixture);
    assert.deepEqual(current.root!.debugMetadata, structuredMetadataFixture);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
